// The Haze look's bot mark: the runtime's logo (own colours, the bot colour or
// one colour) or a pixel icon in the bot colour. It replaces every mascot while
// Haze is on; the status lives in the row's gradient, not in the mark.
import { useEffect, useId, useRef, type CSSProperties } from 'react'
import claudeSvg from '../../assets/providers/claude.svg?raw'
import { ProviderLogo } from '../../ui/providerBrand'
import type { BlobCanvasProps } from '../BlobCanvas'
import { PIXEL_ART, isHazeIcon, isPixelIcon, type HazeIcon, type PixelIcon } from './icons'
import { useLookProvider } from './runtimeRegistry'
import './haze.css'

const CLAUDE_PATH = /\sd="([^"]+)"/.exec(claudeSvg)?.[1] ?? ''

type LogoFamily = 'claude' | 'codex' | 'opencode'
function logoFamily(provider: string | null): LogoFamily | null {
  const key = (provider ?? '').toLowerCase()
  if (key === 'claude' || key === 'anthropic') return 'claude'
  if (key === 'codex' || key === 'openai') return 'codex'
  if (key.startsWith('opencode')) return 'opencode'
  return null
}

/** The icon a bot shows: its choice, else its runtime's logo, else a pixel robot. */
export function resolveHazeIcon(look: { icon?: unknown } | null | undefined, provider: string | null): HazeIcon {
  const chosen = isHazeIcon(look?.icon) ? look.icon : 'logo'
  if (!isPixelIcon(chosen) && !logoFamily(provider)) return 'px-robot'
  return chosen
}

const SLEEPY = new Set(['offline', 'sleeping', 'rate_limited'])

const GREETING_MS = 1200

export function HazeMark({ color, size = 24, mood = 'idle', look, label = 'Bot', decorative = false, className = '', dragRegion = false, greeting = false, onGreetingComplete }: BlobCanvasProps) {
  const provider = useLookProvider(look)
  // No wave to play: the launch greeting fades the mark in and finishes on time.
  const done = useRef(onGreetingComplete)
  done.current = onGreetingComplete
  useEffect(() => {
    if (!greeting) return
    const timer = window.setTimeout(() => done.current?.(), GREETING_MS)
    return () => window.clearTimeout(timer)
  }, [greeting])
  const icon = resolveHazeIcon(look, provider)
  const family = logoFamily(provider)
  const box = { width: size, height: size, '--haze-mark-size': `${size}px` } as CSSProperties
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': label }
  return <span className={`haze-mark${SLEEPY.has(mood) ? ' is-resting' : ''}${greeting ? ' is-greeting' : ''}${isPixelIcon(icon) ? ' is-pixel' : ' is-logo'} ${className}`} style={box} data-icon={icon} data-tauri-drag-region={dragRegion || undefined} {...a11y}>
    {isPixelIcon(icon) ? <PixelArt icon={icon} color={color} />
      : icon === 'logo' && provider ? <ProviderLogo provider={provider} size={Math.round(size * .8)} />
      : family ? <TintLogo family={family} fill={icon === 'logo-tint' ? color : 'currentColor'} />
      : null}
  </span>
}

/** A logo drawn in one colour, with its inner marks cut out rather than filled. */
function TintLogo({ family, fill }: { family: LogoFamily; fill: string }) {
  const mask = `haze-cut-${useId().replace(/:/g, '')}`
  if (family === 'claude') return <svg className="haze-logo" viewBox="0 0 94 94" aria-hidden="true"><path d={CLAUDE_PATH} fill={fill} /></svg>
  if (family === 'codex') return <svg className="haze-logo" viewBox="0 0 540 540" aria-hidden="true">
    <defs><mask id={mask}><rect width="540" height="540" fill="#fff" /><path d="M147 198L191 272L147 346M288 346H398" stroke="#000" strokeWidth="38" strokeLinecap="round" strokeLinejoin="round" fill="none" /></mask></defs>
    <path mask={`url(#${mask})`} fill={fill} d="M101 102C119 41 173 0 234 0C272 0 306 16 332 41C343 37 355 35 367 35C443 35 505 97 505 174C505 187 503 199 500 210C525 235 540 269 540 307C540 368 498 420 439 437C421 496 367 540 303 540C266 540 232 525 207 500C196 503 184 505 172 505C96 505 35 444 35 368C35 355 37 343 40 332C15 306 0 272 0 235C0 172 43 118 101 102Z" />
  </svg>
  return <svg className="haze-logo" viewBox="0 0 300 300" aria-hidden="true">
    <g transform="translate(30 0)" fill={fill}><path fillRule="evenodd" d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" /><path d="M180 240H60V120H180V240Z" opacity=".38" /></g>
  </svg>
}

function shade(hex: string, amount: number) {
  const raw = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '9aa3ad'
  const channels = [0, 2, 4].map((at) => Number.parseInt(raw.slice(at, at + 2), 16))
  const mixed = channels.map((value) => Math.round(amount < 0 ? value * (1 + amount) : value + (255 - value) * amount))
  return `rgb(${mixed.join(' ')})`
}

/** A 12×12 pixel icon; runs of one colour are drawn as one rectangle. */
function PixelArt({ icon, color }: { icon: PixelIcon; color: string }) {
  const palette: Record<string, string> = { B: color, D: shade(color, -.32), L: shade(color, .42), K: '#1b1a20', W: '#ffffff' }
  const cells: Array<{ x: number; y: number; w: number; fill: string }> = []
  PIXEL_ART[icon].forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const key = row[x]!, fill = palette[key]
      let end = x + 1
      while (end < row.length && row[end] === key) end++
      if (fill) cells.push({ x, y, w: end - x, fill })
      x = end
    }
  })
  return <svg className="haze-pixel" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">{cells.map((cell) => <rect key={`${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width={cell.w} height={1} fill={cell.fill} />)}</svg>
}
