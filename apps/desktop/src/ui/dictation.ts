import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

export type DictationPhase = 'idle' | 'starting' | 'downloading' | 'listening'

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
  return value === 'automatic' || value === 'cloud' ? value : 'local'
}

export function cloudAuthUsable(status: CloudAuthStatus | null | undefined): boolean {
  return status?.authState === 'ready' || status?.authState === 'apiKey' || status?.authState === 'expired'
}

export async function cloudDictationStatus(): Promise<CloudAuthStatus | null> {
  if (!isTauri()) return null
  try { return await invoke<CloudAuthStatus>('speech_cloud_status') } catch { return null }
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

type DictationEvent = { type: string; owner?: string; text?: string }

export const DEFAULT_SPEECH_MODEL_ID = 'parakeet-tdt-0.6b-v3-int8'

/**
 * Turns dictation on or off for this run: registers Ctrl+E and preloads the
 * chosen model when on, frees both when off. Safe to call repeatedly; inert
 * outside the desktop app.
 */
export async function configureDictation(enabled: boolean, modelId: string): Promise<void> {
  if (!isTauri()) return
  await invoke('set_dictation_shortcut', { enabled }).catch(() => undefined)
  if (enabled) await invoke('dictation_warm', { modelId }).catch(() => undefined)
  else await invoke('dictation_release').catch(() => undefined)
}

/**
 * Drives one dictation session for a composer. Uses the Tauri API directly so
 * that component tests, which mock `../tauri`, never touch this path: outside a
 * Tauri host `isTauri()` is false and the hook is inert.
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
  const onFinalRef = useRef(onFinal)
  const onPartialRef = useRef(onPartial)
  onFinalRef.current = onFinal
  onPartialRef.current = onPartial

  const supported = isTauri()

  useEffect(() => {
    if (!supported) return
    let disposed = false
    let unlisten: UnlistenFn | undefined
    void listen<DictationEvent>('bloblex-dictation', (event) => {
      const payload = event.payload
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

  const toggle = useCallback(async () => {
    if (!supported) return
    if (phase === 'idle') {
      setError(null)
      setPhase('starting')
      try {
        const status = await invoke<{ ready: boolean }>('speech_model_status', { modelId })
        // When ChatGPT will serve this session there is nothing to download first.
        const cloudServes = enginePrefs.engine !== 'local' && enginePrefs.consent && cloudAuthUsable(await cloudDictationStatus())
        if (status && status.ready === false && !cloudServes) {
          setPhase('downloading')
          let unlisten: UnlistenFn | undefined
          try {
            unlisten = await listen<{ modelId: string; completed: number; total: number }>(
              'bloblex-speech-download',
              (event) => {
                if (event.payload.modelId !== modelId) return
                setProgress(event.payload.total ? event.payload.completed / event.payload.total : 0)
              },
            )
            await invoke('speech_model_download', { modelId })
          } finally {
            unlisten?.()
            setProgress(0)
          }
          setPhase('starting')
        }
        await invoke('dictation_start', { modelId, owner, engine: enginePrefs.engine, cloudConsent: enginePrefs.consent })
      } catch (reason) {
        setPhase('idle')
        const raw = String(reason)
        setError(engineReasonText(raw) ? `ChatGPT transcription is not available: ${engineReasonText(raw)}.` : raw)
      }
    } else if (phase !== 'downloading') {
      setPhase('idle')
      setWarming(false)
      try {
        await invoke('dictation_stop', { owner })
      } catch {
        // The session may already be winding down; the stopped event is authoritative.
      }
    }
  }, [modelId, owner, phase, supported])

  useEffect(() => {
    if (!supported) return
    let disposed = false
    let unlisten: UnlistenFn | undefined
    // Scoped to this window: Ctrl+E is sent to the companion while it is on
    // screen and to the main window otherwise, never to both.
    void getCurrentWebviewWindow().listen('bloblex-dictation-toggle', () => {
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

  return { phase, warming, partial, progress, error, toggle, active: phase === 'starting' || phase === 'listening' }
}
