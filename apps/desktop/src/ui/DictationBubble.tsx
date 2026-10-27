import { useEffect, useRef, useState } from 'react'
import { currentWindow, invokeNative, listenNative } from '../transport/nativeBridge'
import { playDictationCue } from './dictationSound'
import { syncThemeStyleFromCache } from '../blob/bitbots'
import { DictationIsland, type IslandPhase } from './DictationIsland'

type Phase = 'idle' | IslandPhase
type Unlisten = () => void
type DictationEvent = { type: string; owner?: string; text?: string }

const HOLD_TO_DRAG_MS = 140
const TAP_MAX_MOVEMENT_PX = 6

/**
 * The floating dictation bubble, in its own always-on-top window, shown by the
 * backend while dictation runs and the companion is hidden. It is a recorder
 * only (timer, level bars, state): the words go to the message box, never here.
 * It grows only to explain an error. Tap to open Bitbots; hold to move it.
 */
export function DictationBubble() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [level, setLevel] = useState(0)
  const [warming, setWarming] = useState(false)
  const [errorText, setErrorText] = useState('')
  const [since, setSince] = useState<number | null>(null)
  const [stoppedAt, setStoppedAt] = useState<number | null>(null)
  const responsible = useRef(false)
  const heard = useRef(false)
  const pressStart = useRef<{ x: number; y: number; time: number } | null>(null)
  const dragTimer = useRef<number | null>(null)

  useEffect(() => {
    let disposed = false
    const unsubs: Unlisten[] = []
    const add = (unlisten: Unlisten) => {
      if (disposed) unlisten()
      else unsubs.push(unlisten)
    }
    void (async () => {
      add(await listenNative<{ surface: string }>('bloblex-dictation-surface', (payload) => {
        responsible.current = payload.surface === 'bubble'
      }))
      add(await listenNative<DictationEvent>('bloblex-dictation', (payload) => {
        if (!responsible.current) return
        const { type, text } = payload
        if (type === 'ready') {
          // This window may have been created under the other look; match the app before showing.
          syncThemeStyleFromCache()
          heard.current = false
          setErrorText(''); setWarming(false)
          setSince(Date.now()); setStoppedAt(null)
          setPhase('listening')
          playDictationCue('record-start')
        } else if (type === 'loading') {
          setWarming(true)
        } else if (type === 'loaded') {
          setWarming(false)
        } else if (type === 'partial') {
          if (text) heard.current = true
        } else if (type === 'final') {
          if (text) heard.current = true
        } else if (type === 'processing') {
          setStoppedAt(Date.now())
          setPhase('processing')
          playDictationCue('processing-start')
        } else if (type === 'stopped') {
          setWarming(false)
          setStoppedAt((current) => current ?? Date.now())
          setPhase(heard.current ? 'done' : 'silent')
          playDictationCue('processing-finish')
        } else if (type === 'error') {
          setWarming(false)
          setPhase('error')
          setErrorText(text || 'Dictation failed.')
          playDictationCue('error')
        }
      }))
      add(await listenNative<{ level: number }>('bloblex-dictation-level', (payload) => setLevel(payload.level)))
    })().catch(() => undefined)
    return () => {
      disposed = true
      unsubs.forEach((unlisten) => unlisten())
    }
  }, [])

  const expanded = phase === 'error'
  useEffect(() => {
    void invokeNative('set_dictation_bubble_size', { expanded }).catch(() => undefined)
  }, [expanded])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    pressStart.current = { x: event.clientX, y: event.clientY, time: Date.now() }
    if (dragTimer.current) window.clearTimeout(dragTimer.current)
    dragTimer.current = window.setTimeout(() => {
      void currentWindow().startDragging()
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
      void invokeNative('show_main_window', { sessionId: null }).catch(() => undefined)
    }
  }

  return (
    <div className="dictation-bubble-root" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      {phase !== 'idle' && <DictationIsland phase={phase} level={level} since={since} stoppedAt={stoppedAt} warming={warming} errorText={errorText} />}
    </div>
  )
}
