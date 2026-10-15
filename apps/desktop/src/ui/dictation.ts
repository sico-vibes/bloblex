import { useCallback, useEffect, useRef, useState } from 'react'
import { currentWebviewWindow, invokeNative, isNative, listenNative } from '../transport/nativeBridge'

export type DictationPhase = 'idle' | 'starting' | 'downloading' | 'listening'

type Unlisten = () => void

/**
 * What the owner chooses: on this device, or the cloud (ChatGPT, falling back to the device
 * model). The older 'cloud' value (no fallback) is kept readable and treated as 'automatic'.
 */
export type DictationEngineChoice = 'local' | 'automatic' | 'cloud'
/** Which engine produced (or will produce) the text, as reported by the native layer. Status only. */
export interface DictationEngineInfo { engine: 'on-device' | 'chatgpt'; fallback: boolean; reason?: string | null }
export interface CloudAuthStatus { authState: 'ready' | 'missing' | 'unreadable' | 'expired' | 'apiKey' | 'unsupported'; authMode?: string | null; expiresAt?: string | null }

let enginePrefs: { engine: DictationEngineChoice; consent: boolean } = { engine: 'local', consent: false }
/** The engine choice and consent the UI last read from settings; cloud is never used without both. */
export function setDictationEnginePrefs(next: Partial<typeof enginePrefs>) {
  enginePrefs = { ...enginePrefs, ...next }
  enginePrefs.engine = normalizeEngineChoice(enginePrefs.engine)
}
export function dictationEnginePrefs() { return enginePrefs }
export function normalizeEngineChoice(value: unknown): DictationEngineChoice {
  return value === 'automatic' || value === 'cloud' ? 'automatic' : 'local'
}

/** "140 MB", "1.2 GB"; the size shown before a speech model is downloaded. */
export function formatModelSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

export interface SpeechModelInfo { id: string; label: string; sizeBytes: number | null }

/** What the download prompt needs: the model's name and size, or just its id when the list is unavailable. */
export async function speechModelInfo(modelId: string): Promise<SpeechModelInfo> {
  try {
    const rows = await invokeNative<Array<{ id: string; label?: string; sizeBytes?: number }>>('speech_models')
    const row = rows.find((item) => item.id === modelId)
    if (row) return { id: row.id, label: row.label ?? row.id, sizeBytes: typeof row.sizeBytes === 'number' ? row.sizeBytes : null }
  } catch { /* the prompt still works without a size */ }
  return { id: modelId, label: 'Speech model', sizeBytes: null }
}

/** The native layer says this when ChatGPT failed and no on-device model is installed. */
function mentionsMissingLocalModel(text: string): boolean {
  return /no on-device model is installed|on-device speech model is not installed|not installed yet/i.test(text)
}

export function cloudAuthUsable(status: CloudAuthStatus | null | undefined): boolean {
  return status?.authState === 'ready' || status?.authState === 'apiKey' || status?.authState === 'expired'
}

export async function cloudDictationStatus(): Promise<CloudAuthStatus | null> {
  if (!isNative()) return null
  try { return await invokeNative<CloudAuthStatus>('speech_cloud_status') } catch { return null }
}

/** Plain words for the machine reason the native layer gives when it fell back or could not transcribe. */
export function engineReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case 'auth_missing': return 'Codex is not signed in'
    case 'auth_required': return 'the Codex sign-in needs refreshing'
    case 'rate_limited': return 'it is rate limited right now'
    case 'challenged': return 'the service asked for a browser check'
    case 'unavailable': return 'the service could not be reached'
    case 'too_large':
    case 'too_long': return 'the recording was too long'
    case 'too_short': return 'the recording was too short'
    case 'bad_response':
    case 'rejected': return 'the service refused the recording'
    case 'consent_required': return 'permission has not been given'
    case 'model_not_ready': return 'no on-device model is installed'
    default: return ''
  }
}

const CLOUD_REASON_COPY: Record<string, string> = {
  'verification required': "OpenAI's bot check blocked it",
  "blocked by openai's bot check": "OpenAI's bot check blocked it",
  'request rejected': 'ChatGPT refused the recording',
  'sign-in required': 'you are not signed in to Codex',
  'sign-in expired': 'your Codex sign-in expired (run `codex login` in a terminal)',
  'rate limited': 'ChatGPT is rate limiting you right now',
  unavailable: 'ChatGPT could not be reached',
  'recording too large': 'the recording was too long',
  'recording too short': 'the recording was too short',
  'unreadable response': 'ChatGPT sent back something unreadable',
  rejected: 'ChatGPT refused the recording',
}

/**
 * The native layer words a failed ChatGPT dictation tersely; this restates it
 * in plain language and says what to do next. Anything else passes through.
 */
export function friendlyDictationError(raw: string): string {
  const text = raw.trim()
  if (/^OpenAI blocks transcription from apps that are not its own clients/i.test(text)) {
    return "OpenAI's bot check blocks ChatGPT dictation from third-party apps, and the on-device speech model is not installed yet. Download it in Settings, Speech."
  }
  const none = /^ChatGPT transcription is unavailable \((.+?)\) and no on-device model is installed\.?$/i.exec(text)
  if (none) {
    const reason = CLOUD_REASON_COPY[none[1].toLowerCase()] ?? none[1]
    return `ChatGPT dictation did not work: ${reason}. Download the on-device speech model in Settings, Speech, to dictate offline.`
  }
  const both = /^ChatGPT transcription failed \((.+?)\), and the on-device model could not run\.?$/i.exec(text)
  if (both) {
    const reason = CLOUD_REASON_COPY[both[1].toLowerCase()] ?? both[1]
    return `ChatGPT dictation did not work: ${reason}. The on-device model could not start either; check Settings, Speech.`
  }
  return text
}

type DictationEvent = { type: string; owner?: string; text?: string }

export const DEFAULT_SPEECH_MODEL_ID = 'parakeet-tdt-0.6b-v3-int8'

/**
 * Turns dictation on or off for this run: registers Ctrl+E and preloads the
 * chosen model when on, frees both when off. Safe to call repeatedly; inert
 * outside the desktop app.
 */
export async function configureDictation(enabled: boolean, modelId: string): Promise<void> {
  if (!isNative()) return
  await invokeNative('set_dictation_shortcut', { enabled }).catch(() => undefined)
  if (enabled) await invokeNative('dictation_warm', { modelId }).catch(() => undefined)
  else await invokeNative('dictation_release').catch(() => undefined)
}

/**
 * Drives one dictation session for a composer. Uses the native bridge directly
 * so that component tests, which mock `../tauri`, never touch this path:
 * outside a Tauri host `isNative()` is false and the hook is inert.
 *
 * The microphone opens at once; while the model loads (`warming`) audio is
 * queued natively and transcribed as soon as it is ready. If the chosen model
 * is not downloaded, the first toggle downloads it (with progress) first.
 * Events from the other window's dictation are ignored.
 */
export function useDictation({
  owner = 'desktop',
  modelId,
  onFinal,
  onPartial,
}: {
  owner?: string
  modelId: string
  onFinal: (text: string) => void
  onPartial?: (text: string) => void
}) {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [warming, setWarming] = useState(false)
  const [partial, setPartial] = useState('')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  /** True while the owner is being asked to download (or is downloading) the on-device model. */
  const [modelPrompt, setModelPrompt] = useState(false)
  const onFinalRef = useRef(onFinal)
  const onPartialRef = useRef(onPartial)
  onFinalRef.current = onFinal
  onPartialRef.current = onPartial

  const supported = isNative()

  useEffect(() => {
    if (!supported) return
    let disposed = false
    let unlisten: Unlisten | undefined
    void listenNative<DictationEvent>('bloblex-dictation', (payload) => {
      if (payload.owner && payload.owner !== owner) return
      if (payload.type === 'ready') {
        setPhase('listening')
      } else if (payload.type === 'loading') {
        setWarming(true)
      } else if (payload.type === 'loaded') {
        setWarming(false)
      } else if (payload.type === 'partial') {
        const text = payload.text ?? ''
        setPartial(text)
        onPartialRef.current?.(text)
      } else if (payload.type === 'final') {
        setPartial('')
        onPartialRef.current?.('')
        if (payload.text) onFinalRef.current(payload.text)
      } else if (payload.type === 'stopped') {
        setPhase('idle')
        setWarming(false)
        setPartial('')
        onPartialRef.current?.('')
      } else if (payload.type === 'error') {
        setPhase('idle')
        setWarming(false)
        setPartial('')
        onPartialRef.current?.('')
        if (mentionsMissingLocalModel(payload.text ?? '')) { setModelPrompt(true); return }
        setError(payload.text ?? 'Dictation failed.')
      }
    })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [owner, supported])

  const begin = useCallback(async () => {
    await invokeNative('dictation_start', { modelId, owner, engine: enginePrefs.engine, cloudConsent: enginePrefs.consent })
  }, [modelId, owner])

  /** Downloads the on-device model, reporting progress; the caller starts dictation after. */
  const download = useCallback(async () => {
    setPhase('downloading')
    let unlisten: Unlisten | undefined
    try {
      unlisten = await listenNative<{ modelId: string; completed: number; total: number }>(
        'bloblex-speech-download',
        (payload) => {
          if (payload.modelId !== modelId) return
          setProgress(payload.total ? payload.completed / payload.total : 0)
        },
      )
      await invokeNative('speech_model_download', { modelId })
    } finally {
      unlisten?.()
      setProgress(0)
    }
  }, [modelId])

  const toggle = useCallback(async () => {
    if (!supported) return
    if (phase === 'idle') {
      setError(null)
      setPhase('starting')
      try {
        const status = await invokeNative<{ ready: boolean }>('speech_model_status', { modelId })
        const cloud = enginePrefs.engine !== 'local' && enginePrefs.consent
        // The cloud engine needs no download. Only on-device dictation does, and the owner
        // is asked first, with the size, instead of a download starting by itself.
        if (status && status.ready === false && !cloud) {
          setPhase('idle')
          setModelPrompt(true)
          return
        }
        await begin()
      } catch (reason) {
        setPhase('idle')
        const raw = String(reason)
        if (mentionsMissingLocalModel(raw)) { setModelPrompt(true); return }
        setError(engineReasonText(raw) ? `Cloud dictation is not available: ${engineReasonText(raw)}.` : raw)
      }
    } else if (phase !== 'downloading') {
      setPhase('idle')
      setWarming(false)
      try {
        await invokeNative('dictation_stop', { owner })
      } catch {
        // The session may already be winding down; the stopped event is authoritative.
      }
    }
  }, [begin, modelId, owner, phase, supported])

  /** The owner agreed to the download: fetch the model, then start dictating. */
  const acceptModelPrompt = useCallback(async () => {
    setError(null)
    try {
      await download()
      setModelPrompt(false)
      setPhase('starting')
      await begin()
    } catch (reason) {
      setPhase('idle')
      setModelPrompt(false)
      setError(String(reason))
    }
  }, [begin, download])

  const dismissModelPrompt = useCallback(() => { if (phase !== 'downloading') setModelPrompt(false) }, [phase])

  useEffect(() => {
    if (!supported) return
    let disposed = false
    let unlisten: Unlisten | undefined
    // Scoped to this window: Ctrl+E is sent to the companion while it is on
    // screen and to the main window otherwise, never to both.
    void currentWebviewWindow().listen('bloblex-dictation-toggle', () => {
      void toggle()
    })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [supported, toggle])

  return { phase, warming, partial, progress, error, toggle, modelPrompt, acceptModelPrompt, dismissModelPrompt, active: phase === 'starting' || phase === 'listening' }
}
