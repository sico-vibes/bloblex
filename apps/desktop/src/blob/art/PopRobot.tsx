import { resolveBot } from '../look'
import { useId, type CSSProperties } from 'react'
import type { BlobCanvasProps } from '../BlobCanvas'
import { ArtFrame, artAria, artBox, prefersReducedMotion, useArtMood } from './shared'

const THINK_DOTS = [27, 32, 37]
const TYPE_PIXELS = [0, 1, 2, 3, 4]

/** The pop robot: ink outline, hard offset shadow, pastel shell and a cap. */
export function PopRobot({ color, size = 52, mood = 'idle', className = '', label = 'Agent', dragRegion = false, fileStage, greeting = false, mini = false, decorative = false, look = null, onGreetingComplete }: BlobCanvasProps) {
  const bot = resolveBot(look, color)
  const head = (className: string) => bot.shape === 'circle' ? <ellipse className={className} cx="32" cy="35" rx="26" ry="24" /> : bot.shape === 'hexagon' ? <path className={className} d="M19 12H45L59 34L45 57H19L5 34Z" /> : <rect className={className} x={bot.shape === 'square' ? 10 : 6} y="12" width={bot.shape === 'square' ? 44 : 52} height="45" rx={bot.shape === 'square' ? 8 : 14} />
  const uid = useId().replace(/:/g, '')
  const { artMood, effectiveMood } = useArtMood({ mood, fileStage, greeting, onGreetingComplete })
  const { width, height } = artBox(size, greeting)
  const renderSize = Math.round(greeting ? height * 0.86 : size)
  const still = prefersReducedMotion()
  const visorId = `pop-visor-${uid}`
  return <ArtFrame art="robot-pop" width={width} height={height} className={className} dragRegion={dragRegion} mini={mini}>
    <svg
      id={`pop-${uid}`}
      className={`art-svg art-mood-${artMood}${still ? ' art-still' : ''}`}
      viewBox="0 0 64 64"
      style={{ width: renderSize, height: renderSize, '--bot': bot.shell, '--pop-trim': bot.trim, '--pop-screen': bot.screen } as CSSProperties}
      {...artAria(decorative, label, effectiveMood)}
    >
      <defs>
        <clipPath id={visorId}><rect x="14" y="22" width="36" height="25" rx="8" /></clipPath>
      </defs>
      <g transform="translate(3 3)">{head('pop-shadow')}</g>
      <rect className="pop-ink" x="29" y="5" width="6" height="9" rx="2" />
      <rect className="pop-cap" x="25" y="2" width="14" height="7" rx="3.5" />
      <rect className="pop-ink" x="1" y="28" width="7" height="15" rx="3" />
      <rect className="pop-ink" x="56" y="28" width="7" height="15" rx="3" />
      {head('pop-head')}
      <rect className="pop-visor" x="14" y="22" width="36" height="25" rx="8" />
      <rect className="pop-shine" x="18" y="25" width="10" height="3" rx="1.5" />
      <g clipPath={`url(#${visorId})`}>
        <g className="art-eyes pop-eyes">{artMood === 'sleeping' || artMood === 'offline'
          ? <><rect className="pop-eye-line" x="20" y="34" width="9" height="3" rx="1.5" /><rect className="pop-eye-line" x="35" y="34" width="9" height="3" rx="1.5" /></>
          : artMood === 'happy'
            ? <><path className="pop-eye-line" d="M19.5 35 Q24.5 28 29.5 35" /><path className="pop-eye-line" d="M34.5 35 Q39.5 28 44.5 35" /></>
            : artMood === 'error'
              ? <><path className="pop-eye-line pop-eye-error" d="M21 28 L29 36 M29 28 L21 36" /><path className="pop-eye-line pop-eye-error" d="M35 28 L43 36 M43 28 L35 36" /></>
              : artMood === 'waiting'
                ? <><rect className="pop-eye pop-eye-waiting" x="20" y="25" width="8" height="14" rx="4" /><rect className="pop-eye pop-eye-waiting" x="36" y="25" width="8" height="14" rx="4" /></>
                : artMood === 'thinking'
                  ? <><rect className="pop-eye" x="22" y="27" width="5" height="9" rx="2.5" /><rect className="pop-eye" x="37" y="27" width="5" height="9" rx="2.5" /></>
                  : <><rect className="pop-eye" x="21" y="28" width="7" height="14" rx="3.5" /><rect className="pop-eye" x="36" y="28" width="7" height="14" rx="3.5" /></>}
        </g>
        <g className="art-think-dots pop-think-dots">
          {THINK_DOTS.map((x, index) => <circle key={x} cx={x} cy="42" r="1.4" style={{ '--i': index } as CSSProperties} />)}
        </g>
        <g className="art-type-pixels pop-type-pixels">
          {TYPE_PIXELS.map((index) => <rect key={index} x={18 + index * 6} y="42" width="3" height="3" rx=".7" style={{ '--i': index } as CSSProperties} />)}
        </g>
      </g>
    </svg>
  </ArtFrame>
}
