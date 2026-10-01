import { useEffect, useRef } from 'react'
import { moodWithFileReference, type FileReferenceStage } from './characterState'
import { BlobEngine, hexToRGB, type EngineState } from './blobEngine'
import { drawGreetingScene, GREETING_END_MS, GREETING_REFERENCE } from './greetingScene'
import { DizzyRecoveryDeadline, GreetingLifecycle } from './motion'
import { playCompanionCue, unlockCompanionAudioFromGesture } from './soundCues'

export type { BlobMood } from './characterState'
import type { BlobMood } from './characterState'

interface Props {
  color: string
  size?: number
  mood?: BlobMood
  className?: string
  label?: string
  dragRegion?: boolean
  fileStage?: FileReferenceStage
  greeting?: boolean
  /** Small peer avatars: flatter shading, larger eyes and a wandering gaze. */
  mini?: boolean
  /** Opt in only on the companion surface; main-window avatars stay silent. */
  soundCues?: boolean
  onGreetingComplete?: () => void
  onDizzy?: () => void
  onDizzyRecovery?: () => void
}

const STATE_FOR_MOOD: Record<BlobMood, EngineState> = {
  idle: 'idle',
  online: 'online',
  thinking: 'thinking',
  working: 'working',
  tool_activity: 'searching',
  file_activity: 'working',
  file_drop: 'upload',
  file_preparing: 'chewing',
  file_ready: 'fileReady',
  file_sending: 'fileSending',
  file_error: 'fileError',
  permission: 'approval',
  success: 'finished',
  error: 'error',
  offline: 'offline',
  listening: 'listening',
  rate_limited: 'ratelimit',
  budget_warning: 'budget',
  sleeping: 'sleeping',
}

export function engineStateFor(mood: BlobMood): EngineState { return STATE_FOR_MOOD[mood] ?? 'idle' }

/** Canvas size in CSS pixels; the greeting uses Coucou's 640×150 stage ratio. */
export function blobCanvasSize(size: number, greeting: boolean) {
  return greeting
    ? { width: size * GREETING_REFERENCE.width / 100, height: size * GREETING_REFERENCE.height / 100 }
    : { width: size, height: size }
}

const DIZZY_MS = 3300
const SLAP_WINDOW_MS = 1700
const LOVE_HOVER_MS = 1900
const LOVE_COOLDOWN_MS = 6000

/**
 * Bloblex character. The same engine renders the companion and every chat
 * avatar, so a blob keeps one face language everywhere. With `greeting`, the
 * canvas plays the companion welcome scene instead.
 */
export function BlobCanvas({ color, size = 52, mood = 'idle', className = '', label = 'Agent', dragRegion = false, fileStage, greeting = false, mini = false, soundCues = false, onGreetingComplete, onDizzy, onDizzyRecovery }: Props) {
  const effectiveMood = moodWithFileReference(mood, fileStage)
  const canvas = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<BlobEngine | null>(null)
  if (!engineRef.current) {
    const engine = new BlobEngine()
    engine.isMini = mini
    engine.bodyColor = hexToRGB(color)
    engine.setState(engineStateFor(effectiveMood), { force: true, silent: true })
    engineRef.current = engine
  }
  const moodRef = useRef(effectiveMood)
  const scheduleRef = useRef<(() => void) | null>(null)
  const greetingLife = useRef<GreetingLifecycle | null>(null)
  if (!greetingLife.current) greetingLife.current = new GreetingLifecycle()
  const dizzyRecoveryTimer = useRef<DizzyRecoveryDeadline | null>(null)
  if (!dizzyRecoveryTimer.current) dizzyRecoveryTimer.current = new DizzyRecoveryDeadline()
  const dizzyActive = useRef(false)
  const taps = useRef<number[]>([])
  const greetingEnabledRef = useRef(greeting)

  useEffect(() => {
    moodRef.current = effectiveMood
    if (!dizzyActive.current) engineRef.current!.setState(engineStateFor(effectiveMood))
    scheduleRef.current?.()
  }, [effectiveMood])

  useEffect(() => {
    engineRef.current!.bodyColor = hexToRGB(color)
    engineRef.current!.isMini = mini
    scheduleRef.current?.()
  }, [color, mini])

  useEffect(() => {
    const life = greetingLife.current!
    if (greeting) {
      // StrictMode replays effects without a new prop transition. Keep a
      // reduced-motion completion from being restarted and reported twice.
      if (!greetingEnabledRef.current || !life.hasRun) {
        life.begin(performance.now())
        if (soundCues) playCompanionCue('welcome')
      }
    } else {
      life.reset()
    }
    greetingEnabledRef.current = greeting
    scheduleRef.current?.()
  }, [greeting, soundCues])

  const completionRef = useRef(onGreetingComplete)
  useEffect(() => { completionRef.current = onGreetingComplete }, [onGreetingComplete])
  const dizzyRef = useRef({ start: onDizzy, recovery: onDizzyRecovery })
  useEffect(() => { dizzyRef.current = { start: onDizzy, recovery: onDizzyRecovery } }, [onDizzy, onDizzyRecovery])

  useEffect(() => {
    const element = canvas.current
    const ctx = element?.getContext('2d')
    if (!element || !ctx) return
    const engine = engineRef.current!
    const life = greetingLife.current!
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const { width, height } = blobCanvasSize(size, greeting)
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    element.width = Math.round(width * ratio)
    element.height = Math.round(height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    let frame = 0
    let timer = 0
    let loveTimer = 0
    let lastLove = -Infinity
    let lastFrame = performance.now()
    let disposed = false
    let visible = !document.hidden
    let intersecting = true
    let hovered = false

    const draw = (now: number) => {
      if (disposed || !visible || !intersecting) return
      const dt = Math.max(0, Math.min(0.05, (now - lastFrame) / 1000))
      lastFrame = now
      const motionAllowed = !reduced.matches
      engine.reducedMotion = !motionAllowed
      if (life.finishIfDue(now, !motionAllowed)) completionRef.current?.()

      ctx.clearRect(0, 0, width, height)
      if (greeting) {
        drawGreetingScene(ctx, width, height, life.active && motionAllowed ? life.age(now) : GREETING_END_MS, engine.bodyColor)
        if (life.active && motionAllowed) frame = requestAnimationFrame(draw)
        return
      }
      engine.update(dt)
      engine.draw(ctx, width, height)

      if (!motionAllowed) {
        if (dizzyActive.current || engine.eyeOverride) timer = window.setTimeout(() => draw(performance.now()), 110)
        return
      }
      if (engine.busy || hovered) frame = requestAnimationFrame(draw)
      else timer = window.setTimeout(() => draw(performance.now()), Math.max(16, Math.min(1000, engine.msUntilWake)))
    }

    const schedule = () => {
      if (disposed || !visible || !intersecting) return
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      if (reduced.matches) { draw(performance.now()); return }
      frame = requestAnimationFrame(draw)
    }
    scheduleRef.current = schedule

    // Coucou's gaze: tanh of the cursor's distance from the character.
    const onWindowPointerMove = (event: PointerEvent) => {
      if (greeting || engine.isMini) return
      const rect = element.getBoundingClientRect()
      if (!rect.width) return
      const lookX = Math.tanh((event.clientX - (rect.left + rect.width / 2)) / 260)
      const lookY = -Math.tanh((event.clientY - (rect.top + rect.height / 2)) / 200)
      if (Math.abs(lookX - engine.lookX) < 0.004 && Math.abs(lookY - engine.lookY) < 0.004) return
      engine.lookX = lookX
      engine.lookY = lookY
      schedule()
    }
    const onWindowPointerLeave = () => {
      engine.lookX = 0
      engine.lookY = 0
      schedule()
    }
    const onPointerEnter = () => {
      hovered = true
      if (greeting) return
      engine.blink()
      engine.tgEs = 1.08
      window.clearTimeout(loveTimer)
      loveTimer = window.setTimeout(() => {
        const now = performance.now()
        if (!hovered || dizzyActive.current || now - lastLove < LOVE_COOLDOWN_MS) return
        lastLove = now
        engine.triggerEmote('love')
        schedule()
      }, LOVE_HOVER_MS)
      schedule()
    }
    const onPointerLeave = () => {
      hovered = false
      engine.tgEs = 1
      window.clearTimeout(loveTimer)
      schedule()
    }
    const onPointerDown = () => {
      const now = performance.now()
      if (soundCues && !playCompanionCue('poke')) {
        // A persisted opt-in can arrive from another WebView before this one
        // has a user-gesture-unlocked AudioContext. Use this real pointer
        // gesture to unlock locally, then replay only the poke cue.
        void unlockCompanionAudioFromGesture().then((unlocked) => {
          if (unlocked) playCompanionCue('poke')
        })
      }
      if (life.interrupt(now)) completionRef.current?.()
      window.clearTimeout(loveTimer)
      if (dizzyActive.current) { schedule(); return }
      taps.current = taps.current.filter((time) => now - time < SLAP_WINDOW_MS)
      taps.current.push(now)
      if (taps.current.length >= 3) {
        taps.current = []
        dizzyActive.current = true
        engine.setState('dizzy')
        dizzyRef.current.start?.()
        dizzyRecoveryTimer.current?.restart(() => {
          if (!dizzyActive.current) return
          dizzyActive.current = false
          engine.setState(engineStateFor(moodRef.current))
          engine.triggerEmote('happy')
          dizzyRef.current.recovery?.()
          scheduleRef.current?.()
        }, DIZZY_MS)
      } else {
        engine.slap()
      }
      schedule()
    }
    window.addEventListener('pointermove', onWindowPointerMove)
    document.documentElement.addEventListener('pointerleave', onWindowPointerLeave)
    element.addEventListener('pointerenter', onPointerEnter)
    element.addEventListener('pointerleave', onPointerLeave)
    element.addEventListener('pointerdown', onPointerDown)
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting
      if (intersecting) schedule()
      else { cancelAnimationFrame(frame); window.clearTimeout(timer) }
    })
    observer.observe(element)
    const visibility = () => {
      visible = !document.hidden
      if (visible) schedule()
      else { cancelAnimationFrame(frame); window.clearTimeout(timer) }
    }
    const motionChange = () => schedule()
    document.addEventListener('visibilitychange', visibility)
    reduced.addEventListener('change', motionChange)
    schedule()

    return () => {
      disposed = true
      // Effect teardown also happens during React StrictMode's development
      // replay and on size changes. Only animation completion or a real
      // pointer interruption may notify the shell state machine.
      scheduleRef.current = null
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      window.clearTimeout(loveTimer)
      window.removeEventListener('pointermove', onWindowPointerMove)
      document.documentElement.removeEventListener('pointerleave', onWindowPointerLeave)
      element.removeEventListener('pointerenter', onPointerEnter)
      element.removeEventListener('pointerleave', onPointerLeave)
      element.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('visibilitychange', visibility)
      reduced.removeEventListener('change', motionChange)
      observer.disconnect()
    }
  }, [size, greeting, soundCues])

  const { width, height } = blobCanvasSize(size, greeting)
  return <canvas ref={canvas} className={`blob-canvas ${className}`} width={width} height={height} style={{ width, height }} role="img" aria-label={`${label} ${effectiveMood}`} data-tauri-drag-region={dragRegion ? '' : undefined} />
}
