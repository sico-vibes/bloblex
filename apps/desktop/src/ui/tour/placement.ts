// Pure geometry for the guided tour and the one-time hints: where a card sits
// next to a target element and where its arrow points. No DOM access here so it
// is cheap to test.

export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
export type Placement = 'top' | 'bottom' | 'left' | 'right'

export interface CardPlacement {
  x: number
  y: number
  placement: Placement
  /** Distance of the arrow tip from the card's leading edge along the cross axis. */
  arrowOffset: number
  /** True when no side had room and the card overlaps the target. */
  overlapping: boolean
}

const OPPOSITE: Record<Placement, Placement> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
const ARROW_INSET = 20

function candidate(target: Rect, card: Size, placement: Placement, gap: number): { x: number; y: number } {
  const centreX = target.x + target.width / 2
  const centreY = target.y + target.height / 2
  switch (placement) {
    case 'top': return { x: centreX - card.width / 2, y: target.y - card.height - gap }
    case 'bottom': return { x: centreX - card.width / 2, y: target.y + target.height + gap }
    case 'left': return { x: target.x - card.width - gap, y: centreY - card.height / 2 }
    case 'right': return { x: target.x + target.width + gap, y: centreY - card.height / 2 }
  }
}

function overflow(position: { x: number; y: number }, card: Size, viewport: Size, margin: number): number {
  const left = Math.max(0, margin - position.x)
  const top = Math.max(0, margin - position.y)
  const right = Math.max(0, position.x + card.width - (viewport.width - margin))
  const bottom = Math.max(0, position.y + card.height - (viewport.height - margin))
  return left + top + right + bottom
}

/**
 * Picks the side of `target` with the most room, starting from `preferred`,
 * clamps the card into the viewport and reports where the arrow should point.
 */
export function placeCard(target: Rect, card: Size, viewport: Size, preferred: Placement = 'bottom', gap = 14, margin = 12): CardPlacement {
  const order: Placement[] = [preferred, OPPOSITE[preferred], ...(['bottom', 'top', 'right', 'left'] as Placement[]).filter((side) => side !== preferred && side !== OPPOSITE[preferred])]
  let best: { placement: Placement; position: { x: number; y: number }; cost: number } | null = null
  for (const placement of order) {
    const position = candidate(target, card, placement, gap)
    // Cost is how far the card would stick out along the placement axis; sliding
    // along the cross axis is free because the card is clamped afterwards.
    const vertical = placement === 'top' || placement === 'bottom'
    const cost = vertical
      ? Math.max(0, margin - position.y) + Math.max(0, position.y + card.height - (viewport.height - margin))
      : Math.max(0, margin - position.x) + Math.max(0, position.x + card.width - (viewport.width - margin))
    if (!best || cost < best.cost) best = { placement, position, cost }
    if (cost === 0) break
  }
  const chosen = best!
  const x = Math.min(Math.max(chosen.position.x, margin), Math.max(margin, viewport.width - margin - card.width))
  const y = Math.min(Math.max(chosen.position.y, margin), Math.max(margin, viewport.height - margin - card.height))
  const vertical = chosen.placement === 'top' || chosen.placement === 'bottom'
  const targetCentre = vertical ? target.x + target.width / 2 : target.y + target.height / 2
  const span = vertical ? card.width : card.height
  const origin = vertical ? x : y
  const arrowOffset = Math.min(Math.max(targetCentre - origin, ARROW_INSET), Math.max(ARROW_INSET, span - ARROW_INSET))
  const overlapping = overflow({ x, y }, card, viewport, 0) === 0
    && x < target.x + target.width && x + card.width > target.x && y < target.y + target.height && y + card.height > target.y
  return { x, y, placement: chosen.placement, arrowOffset, overlapping }
}

/** Grows a rect by `pad` on every side (the spotlight breathes a little around its target). */
export function inflate(rect: Rect, pad: number): Rect {
  return { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
}

/**
 * Keep a spotlight inside the window, leaving `margin` for its border and
 * ring, so a target flush with the window edge (the sidebar) is not clipped.
 */
export function clampToViewport(rect: Rect, viewport: { width: number; height: number }, margin: number): Rect {
  const left = Math.max(margin, rect.x)
  const top = Math.max(margin, rect.y)
  const right = Math.min(viewport.width - margin, rect.x + rect.width)
  const bottom = Math.min(viewport.height - margin, rect.y + rect.height)
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

export function rectsEqual(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
}
