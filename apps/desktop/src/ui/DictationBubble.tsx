import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { playDictationCue } from './dictationSound'
import { DictationIsland, type IslandPhase } from './DictationIsland'

type Phase = 'idle' | IslandPhase
type DictationEvent = { type: string; owner?: string; text?: string }

const HOLD_TO_DRAG_MS = 140
const TAP_MAX_MOVEMENT_PX = 6

/**
 * The floating dictation bubble, in its own always-on-top window, shown by the
 * backend while dictation runs and the companion is hidden. It shows the words
 * as they arrive and grows to fit them. Tap to open Bloblex; hold to move it.
 */
export function DictationBubble() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [level, setLevel] = useState(0)
  const [warming, setWarming] = useState(false)
  const [errorText, setErrorText] = useState('')
  const [finals, setFinals] = useState('')
  const [partial, setPartial] = useState('')
  const [since, setSince] = useState<number | null>(null)
  const [stoppedAt, setStoppedAt] = useState<number | null>(null)
  const responsible = useRef(false)
  const heard = useRef(false)
  const pressStart = useRef<{ x: number; y: number; time: number } | null>(null)
  const dragTimer = useRef<number | null>(null)

  useEffect(() => {
    let disposed = false
    const unsubs: UnlistenFn[] = []
    const add = (unlisten: UnlistenFn) => {
      if (disposed) unlisten()
      else unsubs.push(unlisten)
    }
    void (async () => {
      add(await listen<{ surface: string }>('bloblex-dictation-surface', (event) => {
        responsible.current = event.payload.surface === 'bubble'
      }))
      add(await listen<DictationEvent>('bloblex-dictation', (event) => {
        if (!responsible.current) return
        const { type, text } = event.payload
        if (type === 'ready') {
          heard.current = false
          setFinals(''); setPartial(''); setErrorText(''); setWarming(false)
          setSince(Date.now()); setStoppedAt(null)
          setPhase('listening')
          playDictationCue('record-start')
        } else if (type === 'loading') {
          setWarming(true)
        } else if (type === 'loaded') {
          setWarming(false)
        } else if (type === 'partial') {
          if (text) heard.current = true
          setPartial(text ?? '')
        } else if (type === 'final') {
          if (text) { heard.current = true; setFinals((current) => (current ? `${current} ${text}` : text)) }
          setPartial('')
        } else if (type === 'processing') {
          setStoppedAt(Date.now())
          setPhase('processing')
          playDictationCue('processing-start')
        } else if (type === 'stopped') {
          setWarming(false)
          setPartial('')
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
      add(await listen<{ level: number }>('bloblex-dictation-level', (event) => setLevel(event.payload.level)))
    })().catch(() => undefined)
    return () => {
      disposed = true
      unsubs.forEach((unlisten) => unlisten())
    }
  }, [])

  const text = `${finals}${finals && partial ? ' ' : ''}${partial}`
  const expanded = (phase === 'listening' || phase === 'processing') ? text.trim().length > 0 : phase === 'error'
  useEffect(() => {
    void invoke('set_dictation_bubble_size', { expanded }).catch(() => undefined)
  }, [expanded])

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

  return (
    <div className="dictation-bubble-root" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      {phase !== 'idle' && <DictationIsland phase={phase} level={level} since={since} stoppedAt={stoppedAt} text={text} warming={warming} errorText={errorText} />}
    </div>
  )
}
