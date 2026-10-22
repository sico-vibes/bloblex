// Design study: "hand-painted" bots for the Blobots look. Each body is a flat
// colour with a darker crescent painted along its lower right edge and a soft
// highlight, plus two upright pill eyes. Preview only; the app still uses the
// glossy canvas renderer.
import { useId, type CSSProperties, type ReactNode } from 'react'

export type PaintedShape = 'classic' | 'cube' | 'star' | 'flower' | 'pear' | 'peanut' | 'ghost' | 'bunny' | 'cat' | 'saucer' | 'bot' | 'tile'
export type PaintedMood = 'idle' | 'working' | 'waiting' | 'sleeping'

interface ShapeDef { label: string; body: ReactNode; eye: [number, number, number]; light: [number, number, number, number, number] }

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
  classic: { label: 'Classic', eye: [55, 52, 1], light: [35, 33, 11, 6, -35], body: <ellipse cx="50" cy="54" rx="37" ry="35" fill="currentColor" /> },
  cube: { label: 'Cube', eye: [55, 52, 1], light: [33, 32, 10, 5, -30], body: <rect x="18" y="20" width="64" height="64" rx="21" fill="currentColor" transform="rotate(-5 50 52)" /> },
  star: { label: 'Star', eye: [52, 57, .82], light: [40, 38, 6, 3.5, -40], body: <polygon points={starPoints(50, 56, 37, 18)} fill="currentColor" strokeWidth="12" {...round} /> },
  flower: {
    label: 'Flower', eye: [53, 55, .85], light: [36, 32, 8, 4.5, -35],
    body: <g fill="currentColor" transform="rotate(12 50 54)">{[0, 60, 120, 180, 240, 300].map((angle) => <circle key={angle} cx={50 + 21 * Math.cos(angle * Math.PI / 180)} cy={54 + 21 * Math.sin(angle * Math.PI / 180)} r="16.5" />)}<circle cx="50" cy="54" r="25" /></g>,
  },
  pear: { label: 'Pear', eye: [53, 58, .9], light: [40, 32, 6, 9, 20], body: <path fill="currentColor" d="M50 13 C63 13 68 31 73 46 C80 66 77 89 50 89 C23 89 20 66 27 46 C32 31 37 13 50 13Z" /> },
  peanut: { label: 'Peanut', eye: [54, 33, .82], light: [41, 23, 6, 3.5, -35], body: <g fill="currentColor"><circle cx="50" cy="33" r="21" /><circle cx="50" cy="65" r="26" /><rect x="34" y="40" width="32" height="16" /></g> },
  ghost: { label: 'Ghost', eye: [54, 46, .95], light: [35, 30, 9, 5, -30], body: <path fill="currentColor" d="M21 52 C21 29 34 15 50 15 C66 15 79 29 79 52 L79 81 Q79 90 71 86 Q64 80 57 86 Q50 92 43 86 Q36 80 29 86 Q21 90 21 81 Z" /> },
  bunny: {
    label: 'Bunny', eye: [54, 64, .9], light: [36, 50, 8, 4.5, -30],
    body: <g fill="currentColor"><ellipse cx="38" cy="27" rx="7.5" ry="19" transform="rotate(-10 38 27)" /><ellipse cx="62" cy="27" rx="7.5" ry="19" transform="rotate(10 62 27)" /><circle cx="50" cy="64" r="28" /></g>,
  },
  cat: { label: 'Cat', eye: [54, 62, .95], light: [34, 46, 9, 5, -30], body: <g fill="currentColor"><polygon points="21,52 25,19 46,38" strokeWidth="8" {...round} /><polygon points="54,38 75,19 79,52" strokeWidth="8" {...round} /><ellipse cx="50" cy="62" rx="33" ry="28" /></g> },
  saucer: { label: 'Saucer', eye: [54, 56, .72], light: [40, 47, 6, 3, -30], body: <g fill="currentColor"><ellipse cx="50" cy="69" rx="44" ry="13" /><path d="M27 67 C27 39 73 39 73 67 Z" /></g> },
  bot: { label: 'Bot', eye: [55, 60, .95], light: [32, 44, 8, 4, -25], body: <g fill="currentColor"><rect x="19" y="36" width="63" height="48" rx="15" /><rect x="48" y="19" width="5" height="19" rx="2" /><circle cx="50.5" cy="18" r="7" /></g> },
  tile: { label: 'Tile', eye: [56, 55, .95], light: [28, 40, 9, 4.5, -38], body: <rect x="13" y="28" width="76" height="54" rx="15" fill="currentColor" transform="rotate(-11 50 55)" /> },
}

export const PAINTED_SHAPES = Object.keys(SHAPES) as PaintedShape[]
export const paintedLabel = (shape: PaintedShape) => SHAPES[shape].label

export function PaintedBot({ shape, color, size = 40, mood = 'idle', label }: { shape: PaintedShape; color: string; size?: number; mood?: PaintedMood; label?: string }) {
  const id = useId().replace(/:/g, '')
  const def = SHAPES[shape]
  const [ex, ey, scale] = def.eye
  const [lx, ly, lrx, lry, lrot] = def.light
  const eyeWidth = 7 * scale
  const eyeHeight = mood === 'sleeping' ? 3 * scale : 15 * scale
  const eyeTop = mood === 'sleeping' ? ey + 2 : ey - eyeHeight / 2
  const eyes = <>
    <rect x={ex - 9 * scale} y={eyeTop} width={eyeWidth} height={eyeHeight} rx={Math.min(eyeWidth, eyeHeight) / 2} />
    <rect x={ex + 2 * scale} y={eyeTop} width={eyeWidth} height={eyeHeight} rx={Math.min(eyeWidth, eyeHeight) / 2} />
  </>
  return <span className={`pb pb-${mood}`} style={{ width: size, height: size, '--pb': color } as CSSProperties} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <svg viewBox="4 4 92 92">
      <defs><mask id={`pm${id}`} maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120"><g color="#fff">{def.body}</g></mask></defs>
      <g className="pb-body">
        <g className="pb-shade">{def.body}</g>
        <g mask={`url(#pm${id})`}>
          <g className="pb-paint" transform="translate(-5 -6)">{def.body}</g>
          <ellipse className="pb-light" cx={lx} cy={ly} rx={lrx} ry={lry} transform={`rotate(${lrot} ${lx} ${ly})`} />
        </g>
        <g className="pb-eyes">{eyes}</g>
      </g>
    </svg>
  </span>
}
