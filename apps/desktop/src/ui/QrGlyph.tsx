import { useMemo } from 'react'

/** A small deterministic string hash (FNV-1a) used to draw a QR-looking matrix. */
function seedFrom(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return hash >>> 0
}

function mulberry32(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const GRID = 25

/** True inside one of the three finder squares (plus their quiet border). */
function inFinder(x: number, y: number): boolean {
  const near = (cx: number, cy: number) => x >= cx - 1 && x <= cx + 7 && y >= cy - 1 && y <= cy + 7
  return near(0, 0) || near(GRID - 7, 0) || near(0, GRID - 7)
}

/**
 * A QR-style matrix for the preview. It is NOT a scannable code: it only looks
 * like one so the pairing flow reads correctly. The label says so.
 */
export function QrGlyph({ value, size = 148 }: { value: string; size?: number }) {
  const cells = useMemo(() => {
    const random = mulberry32(seedFrom(value))
    const list: Array<[number, number]> = []
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (inFinder(x, y)) continue
        if (random() > 0.52) list.push([x, y])
      }
    }
    return list
  }, [value])
  const finder = (x: number, y: number) => <g key={`${x}-${y}`}>
    <rect x={x} y={y} width="7" height="7" fill="currentColor" />
    <rect x={x + 1} y={y + 1} width="5" height="5" fill="var(--qr-bg, #fff)" />
    <rect x={x + 2} y={y + 2} width="3" height="3" fill="currentColor" />
  </g>
  return <svg className="qr-glyph" role="img" aria-label="Pairing code as a QR pattern (preview, not scannable)" width={size} height={size} viewBox={`0 0 ${GRID} ${GRID}`} shapeRendering="crispEdges">
    <rect width={GRID} height={GRID} fill="var(--qr-bg, #fff)" />
    {cells.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" />)}
    {finder(0, 0)}{finder(GRID - 7, 0)}{finder(0, GRID - 7)}
  </svg>
}
