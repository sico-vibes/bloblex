// The Haze look's bot mark: the runtime's logo (own colours, the bot colour or
// one colour) or a character portrait; without a known logo, the bot's initial. It replaces every mascot while
// Haze is on; the status lives in the row's gradient, not in the mark.
import { useEffect, useId, useRef, type CSSProperties } from 'react'
import claudeSvg from '../../assets/providers/claude.svg?raw'
import { ProviderLogo } from '../../ui/providerBrand'
import type { BlobCanvasProps } from '../BlobCanvas'
import { isHazeIcon, type HazeIcon } from './icons'
import { CHARACTER_ASSETS, isHazeCharacter } from './characters'
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

/** The icon a bot shows: its choice, else its runtime's logo. A retired pixel icon is the logo in the bot colour. */
export function resolveHazeIcon(look: { icon?: unknown } | null | undefined): HazeIcon {
  if (typeof look?.icon === 'string' && look.icon.startsWith('px-')) return 'logo-tint'
  return isHazeIcon(look?.icon) ? look.icon : 'logo'
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
  const icon = resolveHazeIcon(look)
  const family = logoFamily(provider)
  const markSize = isHazeCharacter(icon) ? Math.max(size, 26) : size
  const box = { width: markSize, height: markSize, '--haze-mark-size': `${markSize}px` } as CSSProperties
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': label }
  return <span className={`haze-mark${SLEEPY.has(mood) ? ' is-resting' : ''}${greeting ? ' is-greeting' : ''}${isHazeCharacter(icon) ? ' is-character' : family ? ' is-logo' : ' is-initial'} ${className}`} style={box} data-icon={icon} data-tauri-drag-region={dragRegion || undefined} {...a11y}>
    {isHazeCharacter(icon) ? <img className="haze-character-image" src={CHARACTER_ASSETS[icon][size > 32 ? 'animated' : 'static']} alt="" draggable={false} />
      : icon === 'logo' && provider ? <ProviderLogo provider={provider} size={Math.round(size * .8)} />
      : family ? <TintLogo family={family} fill={icon === 'logo-tint' ? color : 'currentColor'} />
      : <span className="haze-initial" style={{ background: color }}>{initialOf(label)}</span>}
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

/** The first letter or digit of the bot's name, for a bot whose runtime has no logo. */
function initialOf(label: string) {
  return /[\p{L}\p{N}]/u.exec(label)?.[0]?.toUpperCase() ?? '·'
}
