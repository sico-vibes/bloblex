import { useEffect, useRef } from 'react'
import { BlobEngine, hexToRGB, type EngineState } from './blobEngine'
import { drawGreetingScene, GREETING_END_MS, GREETING_REFERENCE } from './greetingScene'
import { GreetingLifecycle } from './motion'
import type { BlobMood } from './types'

interface Props {
  color: string
  size?: number
  mood?: BlobMood
  className?: string
  label?: string
  greeting?: boolean
  mini?: boolean
  /** Pointer gaze, hover, and poke. Greeting playback ignores this. */
  interactive?: boolean
  onGreetingComplete?: () => void
}

const STATE_FOR_MOOD: Record<BlobMood, EngineState> = {
  idle: 'idle',
  online: 'online',
  thinking: 'thinking',
  working: 'working',
  permission: 'approval',
  success: 'finished',
  error: 'error',
  offline: 'offline',
  listening: 'listening',
  sleeping: 'sleeping',
  question: 'question',
}

const DIZZY_MS = 3300
const SLAP_WINDOW_MS = 1700
const LOVE_HOVER_MS = 1900
const LOVE_COOLDOWN_MS = 6000

function blobCanvasSize(size: number, greeting: boolean) {
  return greeting
    ? { width: (size * GREETING_REFERENCE.width) / 100, height: (size * GREETING_REFERENCE.height) / 100 }
    : { width: size, height: size }
}

/**
 * Marketing port of the desktop character. The same engine draws every blob,
 * and `greeting` plays the companion welcome wave.
 */
export function BlobCanvas({
  color,
  size = 52,
  mood = 'idle',
  className = '',
  label = 'Blob',
  greeting = false,
  mini = false,
  interactive = true,
  onGreetingComplete,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<BlobEngine | null>(null)
  if (!engineRef.current) {
    const engine = new BlobEngine()
    engine.isMini = mini
    engine.bodyColor = hexToRGB(color)
    engine.setState(STATE_FOR_MOOD[mood], { force: true, silent: true })
    engineRef.current = engine
  }
  const moodRef = useRef(mood)
  const scheduleRef = useRef<(() => void) | null>(null)
  const greetingLife = useRef<GreetingLifecycle | null>(null)
  if (!greetingLife.current) greetingLife.current = new GreetingLifecycle()
  const dizzyTimer = useRef<number | null>(null)
  const dizzyActive = useRef(false)
  const taps = useRef<number[]>([])

  useEffect(() => {
    moodRef.current = mood
    if (!dizzyActive.current) engineRef.current!.setState(STATE_FOR_MOOD[mood])
    scheduleRef.current?.()
  }, [mood])

  useEffect(() => {
    engineRef.current!.bodyColor = hexToRGB(color)
    engineRef.current!.isMini = mini
    scheduleRef.current?.()
  }, [color, mini])

  useEffect(() => {
    const life = greetingLife.current!
    if (greeting) life.begin(performance.now())
    else life.reset()
    scheduleRef.current?.()
  }, [greeting])

  const completionRef = useRef(onGreetingComplete)
  useEffect(() => {
    completionRef.current = onGreetingComplete
  }, [onGreetingComplete])

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
      if (reduced.matches) {
        draw(performance.now())
        return
      }
      frame = requestAnimationFrame(draw)
    }
    scheduleRef.current = schedule

    const onWindowPointerMove = (event: PointerEvent) => {
      if (!interactive || greeting || engine.isMini) return
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
    const onPointerLeave = () => {
      hovered = false
      engine.tgEs = 1
      window.clearTimeout(loveTimer)
      schedule()
    }
    const onPointerEnter = () => {
      hovered = true
      if (!interactive || greeting) return
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
    const poke = () => {
      const now = performance.now()
      if (life.active) life.finishIfDue(now, true)
      window.clearTimeout(loveTimer)
      if (dizzyActive.current) {
        schedule()
        return
      }
      taps.current = taps.current.filter((time) => now - time < SLAP_WINDOW_MS)
      taps.current.push(now)
      if (taps.current.length >= 3) {
        taps.current = []
        dizzyActive.current = true
        engine.setState('dizzy')
        if (dizzyTimer.current !== null) window.clearTimeout(dizzyTimer.current)
        dizzyTimer.current = window.setTimeout(() => {
          dizzyActive.current = false
          engine.setState(STATE_FOR_MOOD[moodRef.current])
          engine.triggerEmote('happy')
          scheduleRef.current?.()
        }, DIZZY_MS)
      } else {
        engine.slap()
      }
      schedule()
    }
    const onPointerDown = () => {
      if (!interactive || greeting) return
      poke()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!interactive || greeting) return
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      poke()
    }
    window.addEventListener('pointermove', onWindowPointerMove)
    document.documentElement.addEventListener('pointerleave', onWindowPointerLeave)
    element.addEventListener('pointerenter', onPointerEnter)
    element.addEventListener('pointerleave', onPointerLeave)
    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('keydown', onKeyDown)
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? false
      if (intersecting) schedule()
      else {
        cancelAnimationFrame(frame)
        window.clearTimeout(timer)
      }
    })
    observer.observe(element)
    const visibility = () => {
      visible = !document.hidden
      if (visible) schedule()
      else {
        cancelAnimationFrame(frame)
        window.clearTimeout(timer)
      }
    }
    const motionChange = () => schedule()
    document.addEventListener('visibilitychange', visibility)
    reduced.addEventListener('change', motionChange)
    schedule()

    return () => {
      disposed = true
      scheduleRef.current = null
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      window.clearTimeout(loveTimer)
      if (dizzyTimer.current !== null) window.clearTimeout(dizzyTimer.current)
      window.removeEventListener('pointermove', onWindowPointerMove)
      document.documentElement.removeEventListener('pointerleave', onWindowPointerLeave)
      element.removeEventListener('pointerenter', onPointerEnter)
      element.removeEventListener('pointerleave', onPointerLeave)
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('visibilitychange', visibility)
      reduced.removeEventListener('change', motionChange)
      observer.disconnect()
    }
  }, [size, greeting, interactive])

  const { width, height } = blobCanvasSize(size, greeting)
  return (
    <canvas
      ref={canvas}
      className={`blob-canvas ${className}`}
      width={width}
      height={height}
      style={{ width, height, maxWidth: '100%' }}
      role="img"
      aria-label={greeting ? `${label} waving hello` : `${label}, ${mood}`}
      tabIndex={interactive && !greeting ? 0 : undefined}
    />
  )
}
