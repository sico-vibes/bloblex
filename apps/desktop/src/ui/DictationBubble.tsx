import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LoaderCircle, Mic, ShieldAlert } from 'lucide-react'
import { playDictationCue } from './dictationSound'

type Phase = 'idle' | 'listening' | 'processing' | 'error'
type DictationEvent = { type: string; owner?: string; text?: string }

const HOLD_TO_DRAG_MS = 140
const TAP_MAX_MOVEMENT_PX = 6

/**
 * The floating dictation bubble. Rendered in its own always-on-top window and
 * only shown by the backend while dictation is active and the companion is
 * hidden. Adapted from the Waveora bubble without its logo.
 */
export function DictationBubble() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [level, setLevel] = useState(0)
  const [errorText, setErrorText] = useState('')
  const [frame, setFrame] = useState(0)
  const responsible = useRef(false)
  const pressStart = useRef<{ x: number; y: number; time: number } | null>(null)
  const dragTimer = useRef<number | null>(null)

  useEffect(() => {
    const interval = window.setInterval(() => setFrame((current) => current + 1), 66)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    let disposed = false
    const unsubs: UnlistenFn[] = []
    const add = (unlisten: UnlistenFn) => {
      if (disposed) unlisten()
      else unsubs.push(unlisten)
    }
    void (async () => {
      add(
        await listen<{ surface: string }>('bloblex-dictation-surface', (event) => {
          responsible.current = event.payload.surface === 'bubble'
        }),
      )
      add(
        await listen<DictationEvent>('bloblex-dictation', (event) => {
          if (!responsible.current) return
          const { type, text } = event.payload
          if (type === 'ready') {
            setPhase('listening')
            playDictationCue('record-start')
          } else if (type === 'processing') {
            setPhase('processing')
            playDictationCue('processing-start')
          } else if (type === 'stopped') {
            setPhase('idle')
            playDictationCue('processing-finish')
          } else if (type === 'error') {
            setPhase('error')
            setErrorText(text || 'Dictation failed.')
            playDictationCue('error')
          }
        }),
      )
      add(await listen<{ level: number }>('bloblex-dictation-level', (event) => setLevel(event.payload.level)))
    })().catch(() => undefined)
    return () => {
      disposed = true
      unsubs.forEach((unlisten) => unlisten())
    }
  }, [])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    pressStart.current = { x: event.clientX, y: event.clientY, time: Date.now() }
    if (dragTimer.current) window.clearTimeout(dragTimer.current)
    dragTimer.current = window.setTimeout(() => {
      void getCurrentWindow().startDragging()
    }, HOLD_TO_DRAG_MS)
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pressStart.current
    if (dragTimer.current) {
      window.clearTimeout(dragTimer.current)
      dragTimer.current = null
    }
    pressStart.current = null
    if (!start) return
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y)
    if (Date.now() - start.time < HOLD_TO_DRAG_MS && moved <= TAP_MAX_MOVEMENT_PX) {
      void invoke('show_main_window', { sessionId: null }).catch(() => undefined)
    }
  }

  const responsive = Math.min(1, Math.pow(Math.max(0, level), 0.58) * 2.1)
  const bars = Array.from({ length: 12 }, (_, index) => {
    const amplitude = Math.max(0.1, responsive) * (0.8 + Math.abs(Math.sin(frame * 0.4 + index * 0.37)))
    return { key: index, height: Math.max(4, 4 + amplitude * 22), opacity: 0.45 + amplitude * 0.5 }
  })

  return (
    <div className="dictation-bubble-root">
      <div
        className={`dictation-bubble ${phase}`}
        role="status"
        aria-live="polite"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        <div className="dictation-bubble-glyph">
          <Mic size={16} aria-hidden="true" />
        </div>
        <div className="dictation-bubble-body">
          {phase === 'listening' && (
            <div className="dictation-bubble-wave" aria-label="Listening">
              {bars.map((bar) => (
                <span key={bar.key} style={{ height: `${bar.height}px`, opacity: bar.opacity }} />
              ))}
            </div>
          )}
          {phase === 'processing' && (
            <div className="dictation-bubble-processing">
              <LoaderCircle size={14} className="spinning" aria-hidden="true" />
              <span>Processing</span>
            </div>
          )}
          {phase === 'error' && (
            <div className="dictation-bubble-error">
              <ShieldAlert size={13} aria-hidden="true" />
              <span>{errorText}</span>
            </div>
          )}
          {phase === 'idle' && <div className="dictation-bubble-idle">Dictation</div>}
        </div>
      </div>
    </div>
  )
}
