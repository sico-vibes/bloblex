// Where a fixed-position tooltip bubble sits for its trigger.
//
// Every tooltip renders in a portal on document.body, so a panel or dialog that
// hides its own overflow can never cut one off. Position comes from the
// trigger's bounding rect; this helper keeps the bubble on screen: it prefers
// the requested side, flips when that side has no room, and shifts along the
// cross axis. One helper keeps them all behaving the same.

export type TipPlacement = 'top' | 'bottom'

/** The four edges of a trigger (a `DOMRect` fits). */
export interface TipAnchor { left: number; top: number; right: number; bottom: number; width: number; height: number }

export interface TipSize { width: number; height: number }

/** Clear space kept between a bubble and the viewport edge. */
export const TIP_MARGIN = 8
/** Clear space kept between a trigger and its bubble. */
export const TIP_GAP = 8

function viewport(): TipSize {
  if (typeof window === 'undefined') return { width: 1024, height: 768 }
  const width = window.innerWidth || document.documentElement?.clientWidth || 1024
  const height = window.innerHeight || document.documentElement?.clientHeight || 768
  return { width, height }
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min
  return Math.max(min, Math.min(max, value))
}

/**
 * The viewport-clamped fixed position for a tooltip bubble. `size` is the
 * bubble's measured box (falls back to the caller's estimate while it is
 * unmeasured), `placement` the side it prefers.
 */
export function placeTooltip(anchor: TipAnchor, size: TipSize, placement: TipPlacement = 'top', options: { gap?: number; margin?: number; viewport?: TipSize } = {}) {
  const gap = options.gap ?? TIP_GAP
  const margin = options.margin ?? TIP_MARGIN
  const view = options.viewport ?? viewport()
  const width = Math.min(Math.max(0, size.width), Math.max(0, view.width - margin * 2))
  const height = Math.min(Math.max(0, size.height), Math.max(0, view.height - margin * 2))
  const roomAbove = anchor.top - gap - height >= margin
  const roomBelow = anchor.bottom + gap + height <= view.height - margin
  let side = placement
  if (placement === 'top' && !roomAbove && roomBelow) side = 'bottom'
  else if (placement === 'bottom' && !roomBelow && roomAbove) side = 'top'
  const left = clamp(anchor.left + anchor.width / 2 - width / 2, margin, view.width - width - margin)
  const top = clamp(side === 'top' ? anchor.top - gap - height : anchor.bottom + gap, margin, view.height - height - margin)
  return { left, top, side, width, height }
}
