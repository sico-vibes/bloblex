import { useId, type CSSProperties } from 'react'
import type { BlobCanvasProps } from '../BlobCanvas'
import { ArtFrame, artAria, artBox, prefersReducedMotion, useArtMood } from './shared'

const THINK_DOTS = [26, 32, 38]
const TYPE_PIXELS = [0, 1, 2, 3, 4]

/** The flat robot: a plain shell, a thin rim and a solid visor. No gradients. */
export function FlatRobot({ color, size = 52, mood = 'idle', className = '', label = 'Agent', dragRegion = false, fileStage, greeting = false, mini = false, decorative = false, onGreetingComplete }: BlobCanvasProps) {
  const uid = useId().replace(/:/g, '')
  const { artMood, effectiveMood } = useArtMood({ mood, fileStage, greeting, onGreetingComplete })
  const { width, height } = artBox(size, greeting)
  const renderSize = Math.round(greeting ? height * 0.86 : size)
  const still = prefersReducedMotion()
  const visorId = `flat-visor-${uid}`
  return <ArtFrame art="robot-flat" width={width} height={height} className={className} dragRegion={dragRegion} mini={mini}>
    <svg
      id={`flat-${uid}`}
      className={`art-svg art-mood-${artMood}${still ? ' art-still' : ''}`}
      viewBox="0 0 64 64"
      style={{ width: renderSize, height: renderSize, '--bot': color } as CSSProperties}
      {...artAria(decorative, label, effectiveMood)}
    >
      <defs>
        <clipPath id={visorId}><rect x="13" y="22" width="38" height="26" rx="9" /></clipPath>
      </defs>
      <rect className="flat-ear" x="2" y="28" width="6" height="14" rx="3" />
      <rect className="flat-ear" x="56" y="28" width="6" height="14" rx="3" />
      <rect className="flat-head" x="6" y="11" width="52" height="47" rx="16" />
      <rect className="flat-rim" x="6.75" y="11.75" width="50.5" height="45.5" rx="15.25" />
      <rect className="flat-visor" x="13" y="22" width="38" height="26" rx="9" />
      <g clipPath={`url(#${visorId})`}>
        <g className="art-eyes flat-eyes">{artMood === 'sleeping' || artMood === 'offline'
          ? <><rect className="flat-eye-line" x="20" y="34" width="9" height="2.6" rx="1.3" /><rect className="flat-eye-line" x="35" y="34" width="9" height="2.6" rx="1.3" /></>
          : artMood === 'happy'
            ? <><path className="flat-eye-line" d="M19.5 35 Q24.5 28 29.5 35" /><path className="flat-eye-line" d="M34.5 35 Q39.5 28 44.5 35" /></>
            : artMood === 'error'
              ? <><path className="flat-eye-line flat-eye-error" d="M21 28 L29 36 M29 28 L21 36" /><path className="flat-eye-line flat-eye-error" d="M35 28 L43 36 M43 28 L35 36" /></>
              : artMood === 'waiting'
                ? <><rect className="flat-eye flat-eye-waiting" x="20" y="25" width="8" height="14" rx="4" /><rect className="flat-eye flat-eye-waiting" x="36" y="25" width="8" height="14" rx="4" /></>
                : artMood === 'thinking'
                  ? <><rect className="flat-eye" x="22" y="27" width="5" height="9" rx="2.5" /><rect className="flat-eye" x="37" y="27" width="5" height="9" rx="2.5" /></>
                  : <><rect className="flat-eye" x="21" y="28" width="7" height="14" rx="3.5" /><rect className="flat-eye" x="36" y="28" width="7" height="14" rx="3.5" /></>}
        </g>
        <g className="art-think-dots flat-think-dots">
          {THINK_DOTS.map((x, index) => <circle key={x} cx={x} cy="42" r="1.4" style={{ '--i': index } as CSSProperties} />)}
        </g>
        <g className="art-type-pixels flat-type-pixels">
          {TYPE_PIXELS.map((index) => <rect key={index} x={17 + index * 6} y="42" width="3" height="3" rx=".7" style={{ '--i': index } as CSSProperties} />)}
        </g>
      </g>
    </svg>
  </ArtFrame>
}
