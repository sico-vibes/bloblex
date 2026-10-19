import { useId, type CSSProperties } from 'react'
import type { BlobCanvasProps } from '../BlobCanvas'
import { ArtFrame, artAria, artBox, prefersReducedMotion, useArtMood } from './shared'

const COLS = 7
const ROWS = 5
const dotX = (col: number) => 14 + col * 6
const dotY = (row: number) => 23 + row * 5.6

type Cell = readonly [number, number]

const EYE_COLS = [1, 2, 4, 5]
const GRID: Cell[] = Array.from({ length: ROWS * COLS }, (_, index) => [index % COLS, Math.floor(index / COLS)] as const)
const IDLE: Cell[] = EYE_COLS.flatMap((col) => [1, 2, 3].map((row) => [col, row] as const))
const THINKING: Cell[] = EYE_COLS.flatMap((col) => [0, 1].map((row) => [col, row] as const))
const WAITING: Cell[] = EYE_COLS.flatMap((col) => [0, 1, 2, 3].map((row) => [col, row] as const))
const SLEEPING: Cell[] = EYE_COLS.map((col) => [col, 3] as const)
const HAPPY: Cell[] = [[0, 2], [1, 1], [2, 2], [4, 2], [5, 1], [6, 2]] as const
const ERROR: Cell[] = [[0, 1], [0, 3], [1, 2], [2, 1], [2, 3], [4, 1], [4, 3], [5, 2], [6, 1], [6, 3]] as const
const TYPE_A: Cell[] = EYE_COLS.flatMap((col) => [1, 2, 3].map((row) => [col, row] as const))
const TYPE_B: Cell[] = EYE_COLS.flatMap((col) => [1, 2].map((row) => [col, row] as const))
const THINK_DOTS: Cell[] = [[2, 4], [3, 4], [4, 4]] as const
const WAVE: Cell[] = Array.from({ length: COLS }, (_, col) => [col, 4] as const)

function dots(cells: readonly Cell[], className = 'dot-lit') {
  return <g className={className}>{cells.map(([col, row]) => <circle key={`${col}-${row}`} cx={dotX(col)} cy={dotY(row)} r="2.6" />)}</g>
}

/** The dot robot: a dark shell, a 7×5 dot screen and an antenna above the head. */
export function DotRobot({ color, size = 52, mood = 'idle', className = '', label = 'Agent', dragRegion = false, fileStage, greeting = false, mini = false, decorative = false, onGreetingComplete }: BlobCanvasProps) {
  const uid = useId().replace(/:/g, '')
  const { artMood, effectiveMood } = useArtMood({ mood, fileStage, greeting, onGreetingComplete })
  const { width, height } = artBox(size, greeting)
  const renderSize = Math.round(greeting ? height * 0.86 : size)
  const still = prefersReducedMotion()
  const headId = `dot-head-${uid}`
  return <ArtFrame art="robot-dot" width={width} height={height} className={className} dragRegion={dragRegion} mini={mini}>
    <svg
      id={`dot-${uid}`}
      className={`art-svg art-mood-${artMood}${still ? ' art-still' : ''}`}
      viewBox="0 0 64 64"
      style={{ width: renderSize, height: renderSize, '--bot': color } as CSSProperties}
      {...artAria(decorative, label, effectiveMood)}
    >
      <defs>
        <clipPath id={headId}><rect x="6" y="10" width="52" height="48" rx="15" /></clipPath>
      </defs>
      <rect className="dot-stem" x="30.8" y="2" width="2.4" height="8" rx="1.2" />
      <circle className="dot-tip" cx="32" cy="2" r="3" />
      <rect className="dot-ear" x="1" y="28" width="6" height="14" rx="3" />
      <rect className="dot-ear" x="57" y="28" width="6" height="14" rx="3" />
      <rect className="dot-head" x="6" y="10" width="52" height="48" rx="15" />
      <g clipPath={`url(#${headId})`}>
        <g className="dot-grid">{GRID.map(([col, row]) => <circle key={`${col}-${row}`} cx={dotX(col)} cy={dotY(row)} r="1.5" />)}</g>
        {artMood === 'sleeping' || artMood === 'offline' ? dots(SLEEPING)
          : artMood === 'happy' ? dots(HAPPY, 'dot-lit dot-lit-happy')
            : artMood === 'error' ? dots(ERROR, 'dot-lit dot-lit-error')
              : artMood === 'waiting' ? dots(WAITING, 'dot-lit dot-lit-waiting')
                : artMood === 'thinking' ? <>{dots(THINKING)}<g className="dot-think-dots">{THINK_DOTS.map(([col, row], index) => <circle key={`${col}-${row}`} cx={dotX(col)} cy={dotY(row)} r="1.5" style={{ '--i': index } as CSSProperties} />)}</g></>
                  : artMood === 'typing' ? <>{dots(TYPE_A, 'dot-lit dot-type-a')}{dots(TYPE_B, 'dot-lit dot-type-b')}<g className="dot-wave">{WAVE.map(([col, row], index) => <circle key={`${col}-${row}`} cx={dotX(col)} cy={dotY(row)} r="1.9" style={{ '--i': index } as CSSProperties} />)}</g></>
                    : dots(IDLE)}
      </g>
    </svg>
  </ArtFrame>
}
