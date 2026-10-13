import { useEffect, useRef } from 'react'
import type { PointerEvent, KeyboardEvent, CSSProperties, RefObject } from 'react'
import { codexGradientAt, codexRgb } from './meterMotion'

export type EffortMeterStyle = 'claude' | 'magnetic' | 'neutral'
type State = { style: EffortMeterStyle; position: number; count: number; top: boolean; width: number }
type Particle = { x: number; y: number; r: number; phase: number; twinkle: number; flow: number }

/** Half the knob's width: the knob's centre never leaves the track. */
export function knobInset(style: EffortMeterStyle) { return style === 'magnetic' ? 16 : 12 }

/** Maps a pointer's x to a continuous stop position for a track rectangle. */
export function positionFromPointer(clientX: number, left: number, width: number, count: number, style: EffortMeterStyle) {
  const inset = knobInset(style)
  const travel = width - inset * 2
  if (!(travel > 0) || count < 2) return 0
  return Math.max(0, Math.min(1, (clientX - left - inset) / travel)) * (count - 1)
}

/**
 * The effort track. A plain element with the slider role: the parent drives it
 * with pointer capture, so the knob follows the pointer exactly while held and
 * nothing native fights the drag. Ticks are dots; the recommended level is a
 * short vertical line. Claude's style lights only the cells nearest the knob.
 */
export function SessionEffortMeter({ trackRef, style, count, position, recommendedIndex, top, dragging, settling, valueText, disabled, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture, onKeyDown, onKeyUp }: {
  trackRef?: RefObject<HTMLDivElement | null>
  style: EffortMeterStyle; count: number; position: number; recommendedIndex: number; top: boolean
  dragging: boolean; settling: boolean; valueText: string; disabled: boolean
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void; onPointerMove: (event: PointerEvent<HTMLDivElement>) => void; onPointerUp: (event: PointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void; onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void; onKeyUp: (event: KeyboardEvent<HTMLDivElement>) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const redrawRef = useRef<() => void>(() => undefined)
  const stateRef = useRef<State>({ style, position, count, top, width: 0 })
  stateRef.current = { ...stateRef.current, style, position, count, top }
  useEffect(() => {
    const canvas = canvasRef.current, host = canvas?.parentElement, ctx = canvas?.getContext('2d')
    if (!canvas || !host || !ctx) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let raf = 0, width = 0, height = 0, dpr = 1, last = 0
    let particles: Particle[] = []
    const seed = () => { particles = Array.from({ length: Math.max(6, Math.round(width / 24)) }, () => ({ x: Math.random() * width, y: 4 + Math.random() * Math.max(1, height - 8), r: .8 + Math.random() * .9, phase: Math.random() * Math.PI * 2, twinkle: 2.5 + Math.random() * 4.5, flow: 85 + Math.random() * 50 })) }
    const animated = () => !motion.matches && !document.hidden && (stateRef.current.style === 'magnetic' || stateRef.current.style === 'claude')
    const resize = () => {
      const rect = host.getBoundingClientRect(); if (!rect.width || !rect.height) return
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2)
      if (width === rect.width && height === rect.height && dpr === nextDpr) return
      width = rect.width; height = rect.height; dpr = nextDpr
      stateRef.current.width = width
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); canvas.style.width = `${width}px`; canvas.style.height = `${height}px`
      if (stateRef.current.style === 'magnetic') seed()
      refresh()
    }
    const knobX = (state: State) => { const inset = knobInset(state.style); return inset + (state.count < 2 ? 0 : state.position / (state.count - 1)) * Math.max(0, width - inset * 2) }
    const drawClaude = (time: number, state: State) => {
      // A dither that thickens towards the knob: only the edge nearest the
      // chosen level lights up, like Claude's own effort selector.
      // The dither is always moving; the top levels (Max, Ultracode) add
      // colour, a longer reach and a livelier shimmer.
      const end = knobX(state), cell = 3, gap = 1, rows = Math.floor(height / (cell + gap)), top0 = (height - rows * (cell + gap) + gap) / 2
      const reach = Math.max(36, Math.min(end, width * (state.top ? .82 : .62)))
      const twinkle = motion.matches ? 0 : (time / 1000) * (state.top ? 1.35 : .7)
      const boost = state.top ? 1.3 : 1
      for (let x = 2; x < end - 2; x += cell + gap) {
        const t = 1 - (end - x) / reach; if (t <= 0) continue
        const density = Math.min(1, Math.pow(t, 1.6) * boost)
        for (let row = 0; row < rows; row++) {
          const h = hash(x * 12.9898 + row * 78.233, 43758.5453)
          const flicker = twinkle ? .5 + .5 * Math.sin(twinkle * (2 + h * 3) + h * 40) : 1
          if (h > density * (.55 + .45 * flicker)) continue
          const alpha = Math.min(1, (.16 + .62 * t) * (.6 + .4 * hash(x * 3.1 + row * 7.7, 12731.13)) * (state.top ? 1.25 : 1))
          ctx.globalAlpha = alpha
          ctx.fillStyle = state.top ? (h < .22 ? '#a58bf0' : h < .45 ? '#c9b6f2' : '#e9e4f5') : '#e6e6ea'
          ctx.fillRect(x, top0 + row * (cell + gap), cell, cell)
        }
      }
      ctx.globalAlpha = 1
    }
    const drawCodex = (time: number, staticFrame: boolean) => {
      const dt = staticFrame ? 0 : Math.min(.032, Math.max(0, (time - (last || time)) / 1000)); last = time; const sec = time / 1000
      ctx.fillStyle = '#fff'
      for (const p of particles) { p.x -= p.flow * dt; if (p.x < -3) p.x += width + 6; const s = .5 + .5 * Math.sin(staticFrame ? p.phase * 3 : sec * p.twinkle + p.phase); ctx.globalAlpha = .06 + .74 * s * s; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill() }
      ctx.globalAlpha = 1
    }
    const paint = (time: number, staticFrame = false) => {
      const state = stateRef.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height)
      if (state.style === 'claude') drawClaude(time, state)
      if (state.style === 'magnetic') drawCodex(time, staticFrame)
      if (!staticFrame && animated()) raf = requestAnimationFrame((t) => paint(t))
    }
    const stop = () => { cancelAnimationFrame(raf); raf = 0 }
    const refresh = () => { if (animated()) { if (!raf) { last = 0; paint(performance.now()) } return } stop(); paint(performance.now(), true) }
    const visibility = () => { if (document.hidden) stop(); else refresh() }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    observer?.observe(host); if (!observer) window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', visibility); motion.addEventListener?.('change', refresh)
    resize(); refresh()
    redrawRef.current = refresh
    return () => { stop(); redrawRef.current = () => undefined; observer?.disconnect(); if (!observer) window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', visibility); motion.removeEventListener?.('change', refresh) }
  }, [style])
  useEffect(() => { redrawRef.current() }, [position, count, top])

  const inset = knobInset(style)
  const fraction = count < 2 ? 0 : Math.max(0, Math.min(1, position / (count - 1)))
  const at = (ratio: number) => `calc(${inset}px + (100% - ${inset * 2}px) * ${ratio})`
  const colors = codexGradientAt(Math.round(position), count)
  const rounded = Math.round(position)
  return <div
    ref={trackRef}
    className={`session-effort-track ${style} ${top ? 'top' : ''} ${dragging ? 'dragging' : ''} ${settling ? 'settling' : ''}`}
    role="slider" tabIndex={disabled ? -1 : 0}
    aria-label="Conversation effort" aria-valuemin={0} aria-valuemax={Math.max(0, count - 1)} aria-valuenow={rounded} aria-valuetext={valueText} aria-disabled={disabled || undefined}
    style={{ '--effort-knob': at(fraction), '--effort-fill': `calc(${inset * 2}px + (100% - ${inset * 2}px) * ${fraction})`, '--meter-codex-start': codexRgb(colors[0]), '--meter-codex-middle': codexRgb(colors[1]), '--meter-codex-end': codexRgb(colors[2]) } as CSSProperties}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onLostPointerCapture={onLostPointerCapture} onKeyDown={onKeyDown} onKeyUp={onKeyUp}
  >
    <span className="session-effort-fill" aria-hidden="true" />
    <canvas ref={canvasRef} className="session-effort-canvas" aria-hidden="true" />
    {Array.from({ length: count }, (_, index) => <i key={index} className={`session-effort-tick ${index === recommendedIndex ? 'recommended' : ''}`} style={{ left: at(count < 2 ? 0 : index / (count - 1)) }} aria-hidden="true" />)}
    <span className="session-effort-knob" aria-hidden="true" />
  </div>
}
function hash(value: number, scale: number) { return Math.abs(Math.sin(value) * scale) % 1 }
