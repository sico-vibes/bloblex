import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type DictationPhase = 'idle' | 'starting' | 'downloading' | 'listening'

type DictationEvent = { type: string; owner?: string; text?: string }

/**
 * Drives one dictation session for a composer. Uses the Tauri API directly so
 * that component tests, which mock `../tauri`, never touch this path: outside a
 * Tauri host `isTauri()` is false and the hook is inert.
 *
 * If the chosen model is not cached, the first toggle downloads it (with
 * progress) and then starts listening.
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
      if (payload.type === 'ready') {
        setPhase('listening')
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
        setPartial('')
        onPartialRef.current?.('')
      } else if (payload.type === 'error') {
        setPhase('idle')
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
  }, [supported])

  const toggle = useCallback(async () => {
    if (!supported) return
    if (phase === 'idle') {
      setError(null)
      setPhase('starting')
      try {
        const status = await invoke<{ ready: boolean }>('speech_model_status', { modelId })
        if (status && status.ready === false) {
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
        }
        await invoke('dictation_start', { modelId, owner })
      } catch (reason) {
        setPhase('idle')
        setError(String(reason))
      }
    } else {
      setPhase('idle')
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
    void listen('bloblex-dictation-toggle', () => {
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

  return { phase, partial, progress, error, toggle, active: phase === 'starting' || phase === 'listening' }
}
