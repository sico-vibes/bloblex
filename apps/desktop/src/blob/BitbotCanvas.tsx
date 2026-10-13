import { useEffect, useMemo, useRef, useState } from 'react'
import { RobotHead } from '../vendor/robot-heads'
import type { BlobCanvasProps } from './BlobCanvas'
import { GREETING_REFERENCE } from './greetingScene'
import { moodWithFileReference } from './characterState'
import { robotStateFor } from './bitbots'
import { resolveBot } from './look/bot'


const DIZZY_MS = 3300
const SLAP_WINDOW_MS = 1700
/** The welcome is a short spin: a pause, then one hop with a full turn. */
const WELCOME_SPIN_AT_MS = 520
const WELCOME_END_MS = 2600

/** A stable 0-1 number for a seed string, so a row of robots does not blink in unison. */
function seedFraction(seed: string | null | undefined) {
  let hash = 2166136261
  for (let index = 0; index < (seed ?? '').length; index++) hash = Math.imul(hash ^ (seed as string).charCodeAt(index), 16777619)
  return ((hash >>> 0) % 1000) / 1000
}

/**
 * The Bitbots renderer: the same props as the classic blob canvas, drawn as a
 * pixel-LED robot head. State shows on the robot's own face, so there are no
 * corner glyphs. The antenna is always off and the speed always 1.
 */
export function BitbotCanvas({ color, size = 52, mood = 'idle', className = '', label = 'Agent', dragRegion = false, fileStage, greeting = false, mini = false, decorative = false, look = null, onGreetingComplete, onDizzy, onDizzyRecovery }: BlobCanvasProps) {
  const effectiveMood = moodWithFileReference(mood, fileStage)
  const bot = useMemo(() => resolveBot(look, color), [look, color])
  const [dizzy, setDizzy] = useState(false)
  const [visible, setVisible] = useState(true)
  const [hot, setHot] = useState(false)
  const taps = useRef<number[]>([])
  const frame = useRef<HTMLSpanElement>(null)
  const completion = useRef(onGreetingComplete)
  const dizzyCallbacks = useRef({ start: onDizzy, recovery: onDizzyRecovery })
  useEffect(() => { completion.current = onGreetingComplete }, [onGreetingComplete])
  useEffect(() => { dizzyCallbacks.current = { start: onDizzy, recovery: onDizzyRecovery } }, [onDizzy, onDizzyRecovery])

  // A robot that is scrolled out of view, or in a hidden window, does not draw.
  useEffect(() => {
    const element = frame.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // The welcome: the robot waits a beat, then hops with one full spin.
  useEffect(() => {
    if (!greeting) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let finished = false
    const finish = () => { if (finished) return; finished = true; completion.current?.() }
    if (reduced) { finish(); return }
    const spin = window.setTimeout(() => frame.current?.querySelector<HTMLElement>('[role="img"]')?.click(), WELCOME_SPIN_AT_MS)
    const end = window.setTimeout(finish, WELCOME_END_MS)
    const interrupt = () => finish()
    const element = frame.current
    element?.addEventListener('pointerdown', interrupt)
    return () => {
      window.clearTimeout(spin)
      window.clearTimeout(end)
      element?.removeEventListener('pointerdown', interrupt)
    }
  }, [greeting])

  // Three quick pokes make it dizzy for a moment, like the classic blob.
  useEffect(() => {
    if (!dizzy) return
    const timer = window.setTimeout(() => { setDizzy(false); dizzyCallbacks.current.recovery?.() }, DIZZY_MS)
    return () => window.clearTimeout(timer)
  }, [dizzy])
  const onPointerDown = () => {
    if (greeting || dizzy) return
    const now = performance.now()
    taps.current = taps.current.filter((time) => now - time < SLAP_WINDOW_MS)
    taps.current.push(now)
    if (taps.current.length >= 3) {
      taps.current = []
      setDizzy(true)
      dizzyCallbacks.current.start?.()
    }
  }

  const width = greeting ? size * GREETING_REFERENCE.width / 100 : size
  const height = greeting ? size * GREETING_REFERENCE.height / 100 : size
  const robotSize = greeting ? Math.round(height * 0.86) : size
  const state = dizzy ? 'error' : robotStateFor(effectiveMood)
  // Drawing a head costs real CPU, so only heads that have something to say
  // move: ones that are busy, asking, hovered, big (hero and editor), or in
  // the welcome. Idle and sleeping avatars hold their still pose, which the
  // library draws once.
  const lively = state !== 'idle' && state !== 'sleeping'
  const animate = visible && (greeting || dizzy || hot || lively || robotSize >= 96)
  return <span
    ref={frame}
    className={`blob-canvas-frame bitbot-frame ${className}`}
    style={{ width, height, position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', verticalAlign: 'top', overflow: 'visible' }}
    data-tauri-drag-region={dragRegion ? '' : undefined}
    data-bitbot-shape={bot.shape}
    onPointerDown={onPointerDown}
    onPointerEnter={() => setHot(true)}
    onPointerLeave={() => setHot(false)}
  >
    <RobotHead
      shape={bot.shape}
      state={state}
      size={robotSize}
      color={bot.shell}
      trimColor={bot.trim}
      screenColor={bot.screen}
      speed={1}
      paused={!animate}
      antenna={false}
      floorShadow={!mini}
      interactive={!greeting}
      seed={seedFraction(look?.seed)}
      // Spread conditionally: an explicit undefined would override the library's own role and label.
      {...(decorative ? { 'aria-hidden': true, role: 'presentation' } : { 'aria-label': `${label} ${effectiveMood}` })}
      style={{ pointerEvents: dragRegion ? 'none' : undefined }}
    />
  </span>
}
