import { useId, type CSSProperties, type ReactNode } from 'react'
import type { BlobCanvasProps } from '../BlobCanvas'
import type { BlobMood } from '../characterState'
import { resolvePaint, type ArtMood, type PaintedShape } from './art'
import { ArtFrame, artAria, artBox, prefersReducedMotion, useArtMood } from './shared'

interface ShapeDef {
  eye: readonly [number, number, number]
  light: readonly [number, number, number, number, number]
  /** Top-left badge centre, in the 100-unit frame. */
  badge: readonly [number, number]
  body: ReactNode | ((mini: boolean) => ReactNode)
}

function starPoints(cx: number, cy: number, outer: number, inner: number) {
  const points: string[] = []
  for (let index = 0; index < 10; index += 1) {
    const radius = index % 2 ? inner : outer
    const angle = -Math.PI / 2 + index * Math.PI / 5
    points.push(`${(cx + radius * Math.cos(angle)).toFixed(1)},${(cy + radius * Math.sin(angle)).toFixed(1)}`)
  }
  return points.join(' ')
}

const round = { stroke: 'currentColor', strokeLinejoin: 'round', strokeLinecap: 'round' } as const

/** Bodies draw in currentColor so one definition serves the shade, the paint and the mask. */
const SHAPES: Record<PaintedShape, ShapeDef> = {
  classic: { eye: [55, 52, 1], light: [35, 33, 11, 6, -35], badge: [20, 30], body: <ellipse cx="50" cy="54" rx="37" ry="35" fill="currentColor" /> },
  cube: { eye: [55, 52, 1], light: [33, 32, 10, 5, -30], badge: [20, 29], body: <rect x="18" y="20" width="64" height="64" rx="21" fill="currentColor" transform="rotate(-5 50 52)" /> },
  star: {
    eye: [52, 57, 0.82], light: [40, 38, 6, 3.5, -40], badge: [20, 32],
    body: (mini) => <polygon points={starPoints(50, 56, 37, 18)} fill="currentColor" strokeWidth={mini ? 9 : 12} {...round} />,
  },
  flower: {
    eye: [53, 55, 0.85], light: [36, 32, 8, 4.5, -35], badge: [20, 31],
    body: <g fill="currentColor" transform="rotate(12 50 54)">{[0, 60, 120, 180, 240, 300].map((angle) => <circle key={angle} cx={50 + 21 * Math.cos(angle * Math.PI / 180)} cy={54 + 21 * Math.sin(angle * Math.PI / 180)} r="16.5" />)}<circle cx="50" cy="54" r="25" /></g>,
  },
  pear: { eye: [53, 58, 0.9], light: [40, 32, 6, 9, 20], badge: [20, 32], body: <path fill="currentColor" d="M50 13 C63 13 68 31 73 46 C80 66 77 89 50 89 C23 89 20 66 27 46 C32 31 37 13 50 13Z" /> },
  peanut: { eye: [54, 33, 0.82], light: [41, 23, 6, 3.5, -35], badge: [20, 32], body: <g fill="currentColor"><circle cx="50" cy="33" r="21" /><circle cx="50" cy="65" r="26" /><rect x="34" y="40" width="32" height="16" /></g> },
  ghost: { eye: [54, 46, 0.95], light: [35, 30, 9, 5, -30], badge: [22, 30], body: <path fill="currentColor" d="M21 52 C21 29 34 15 50 15 C66 15 79 29 79 52 L79 81 Q79 90 71 86 Q64 80 57 86 Q50 92 43 86 Q36 80 29 86 Q21 90 21 81 Z" /> },
  bunny: {
    eye: [54, 64, 0.9], light: [36, 50, 8, 4.5, -30], badge: [27, 45],
    body: (mini) => <g fill="currentColor"><ellipse cx="38" cy="27" rx="7.5" ry={mini ? 16 : 19} transform="rotate(-10 38 27)" /><ellipse cx="62" cy="27" rx="7.5" ry={mini ? 16 : 19} transform="rotate(10 62 27)" /><circle cx="50" cy="64" r="28" /></g>,
  },
  kitty: { eye: [54, 62, 0.95], light: [34, 46, 9, 5, -30], badge: [25, 43], body: <g fill="currentColor"><polygon points="21,52 25,19 46,38" strokeWidth="8" {...round} /><polygon points="54,38 75,19 79,52" strokeWidth="8" {...round} /><ellipse cx="50" cy="62" rx="33" ry="28" /></g> },
  ufo: { eye: [50, 45, 0.8], light: [36, 33, 6, 3, -30], badge: [19, 29], body: <g fill="currentColor"><ellipse cx="50" cy="64" rx="44" ry="13" /><path d="M31 62 C31 7.3 69 7.3 69 62 Z" /></g> },
  boxbot: { eye: [55, 60, 0.95], light: [32, 44, 8, 4, -25], badge: [24, 40], body: <g fill="currentColor"><rect x="19" y="36" width="63" height="48" rx="15" /><rect x="48" y="19" width="5" height="19" rx="2" /><circle cx="50.5" cy="18" r="7" /></g> },
  tile: { eye: [56, 55, 0.95], light: [28, 40, 9, 4.5, -38], badge: [19, 31], body: <rect x="13" y="28" width="76" height="54" rx="15" fill="currentColor" transform="rotate(-11 50 55)" /> },
}

interface BadgeSpec { kind: 'dots' | 'dot' | 'bang' | 'z'; color: string }

/** The classic engine's corner badge, in the painted palette. */
function badgeFor(artMood: ArtMood, mood: BlobMood): BadgeSpec | null {
  if (mood === 'rate_limited') return { kind: 'dot', color: '#fb923c' }
  switch (artMood) {
    case 'thinking': return { kind: 'dots', color: '#8b5cf6' }
    case 'typing': return { kind: 'dots', color: '#3b9eff' }
    case 'waiting': return { kind: 'bang', color: '#f5a524' }
    case 'happy': return { kind: 'dot', color: '#34d399' }
    case 'error': return { kind: 'dot', color: '#f45063' }
    case 'sleeping': return { kind: 'z', color: '#94a2b8' }
    default: return null
  }
}

/** A hand-painted bot: flat paint, a darker crescent and a soft highlight. */
export function PaintedBlob({ color, size = 52, mood = 'idle', className = '', label = 'Agent', dragRegion = false, fileStage, greeting = false, mini = false, decorative = false, look = null, onGreetingComplete }: BlobCanvasProps) {
  const uid = useId().replace(/:/g, '')
  const { artMood, effectiveMood } = useArtMood({ mood, fileStage, greeting, onGreetingComplete })
  const { width, height } = artBox(size, greeting)
  const renderSize = Math.round(greeting ? height * 0.86 : size)
  const still = prefersReducedMotion()
  const shape = SHAPES[resolvePaint(look)] ?? SHAPES.classic
  const body = typeof shape.body === 'function' ? shape.body(mini) : shape.body
  const [ex, ey, scale] = shape.eye
  const [lx, ly, lrx, lry, lrot] = shape.light
  const [bx, by] = shape.badge
  const badge = badgeFor(artMood, effectiveMood)
  const badgeRadius = mini ? 8 : 11
  const flat = artMood === 'sleeping' || artMood === 'offline' || artMood === 'error'
  const happy = artMood === 'happy'
  const eyeHeight = flat ? 3 * scale : happy ? 0 : artMood === 'typing' ? 8 * scale : artMood === 'thinking' ? 13 * scale : 15 * scale
  const eyeWidth = 7 * scale
  const eyeTop = (artMood === 'waiting' ? ey - eyeHeight / 2 - 3 * scale : ey - eyeHeight / 2)
  const leftX = ex - 9 * scale
  const rightX = ex + 2 * scale
  const leftCentre = leftX + eyeWidth / 2
  const rightCentre = rightX + eyeWidth / 2
  const arcY = ey + 1 * scale
  const maskId = `pm-${uid}`
  return <ArtFrame art="painted" width={width} height={height} className={`pb painted-frame ${className}`} dragRegion={dragRegion} mini={mini}>
    <svg
      id={`painted-${uid}`}
      className={`art-svg art-mood-${artMood}${still ? ' art-still' : ''}`}
      viewBox="4 4 92 92"
      style={{ width: renderSize, height: renderSize, '--pb': color } as CSSProperties}
      {...artAria(decorative, label, effectiveMood)}
    >
      <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120"><g color="#fff">{body}</g></mask></defs>
      <g className="pb-body">
        <g className="pb-shade">{body}</g>
        <g mask={`url(#${maskId})`}>
          <g className="pb-paint" transform="translate(-5 -6)">{body}</g>
          {!mini && <ellipse className="pb-light" cx={lx} cy={ly} rx={lrx} ry={lry} transform={`rotate(${lrot} ${lx} ${ly})`} />}
        </g>
        <g className="pb-eyes">
          {happy
            ? <>
              <path className="pb-eye-line" d={`M${leftCentre - 4.5 * scale} ${arcY} Q${leftCentre} ${arcY - 7 * scale} ${leftCentre + 4.5 * scale} ${arcY}`} />
              <path className="pb-eye-line" d={`M${rightCentre - 4.5 * scale} ${arcY} Q${rightCentre} ${arcY - 7 * scale} ${rightCentre + 4.5 * scale} ${arcY}`} />
            </>
            : flat
              ? <><rect className="pb-eye-line" x={leftX} y={ey} width={eyeWidth} height={3 * scale} rx={1.5 * scale} /><rect className="pb-eye-line" x={rightX} y={ey} width={eyeWidth} height={3 * scale} rx={1.5 * scale} /></>
              : <><rect className="pb-eye" x={leftX} y={eyeTop} width={eyeWidth} height={eyeHeight} rx={Math.min(eyeWidth, eyeHeight) / 2} /><rect className="pb-eye" x={rightX} y={eyeTop} width={eyeWidth} height={eyeHeight} rx={Math.min(eyeWidth, eyeHeight) / 2} /></>}
        </g>
        <g className={`pb-badge${badge ? ' on' : ''}`} style={{ '--badge': badge?.color ?? '#8b5cf6' } as CSSProperties} aria-hidden="true">
          <circle className="pb-badge-ring" cx={bx} cy={by} r={badgeRadius + 1.6} />
          <circle className="pb-badge-disc" cx={bx} cy={by} r={badgeRadius} />
          {badge && !mini && badge.kind === 'dots' && [0, 1, 2].map((index) => <circle key={index} className="pb-badge-dot" cx={bx + (index - 1) * badgeRadius * 0.5} cy={by} r={badgeRadius * 0.16} style={{ '--i': index } as CSSProperties} />)}
          {badge && !mini && badge.kind === 'bang' && <text className="pb-badge-text" x={bx} y={by} textAnchor="middle" dominantBaseline="central" style={{ fontSize: badgeRadius * 1.5 }}>!</text>}
          {badge && !mini && badge.kind === 'z' && <text className="pb-badge-text" x={bx} y={by} textAnchor="middle" dominantBaseline="central" style={{ fontSize: badgeRadius * 1.3 }}>z</text>}
        </g>
      </g>
    </svg>
  </ArtFrame>
}
