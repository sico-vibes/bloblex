// C8: snap a floating companion back to a work-area edge or corner after a drag
// ends. Pure geometry so it can be table-tested; the native window code owns the
// screen rectangle and the call itself.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** How close an axis must be to an edge to snap along it. */
export const SNAP_EDGE_THRESHOLD = 16
/** How close the window must be to a corner (on both axes) to snap to it. */
export const SNAP_CORNER_THRESHOLD = 40
/** The margin left between the window and the work-area edge it snaps to. */
export const SNAP_MARGIN = 8

/**
 * Snap `rect` to the nearest edge (within `threshold`) or corner (within
 * `cornerThreshold` on both axes) of `workArea`, leaving `margin` px of space.
 * An axis that is not near an edge keeps its position, so a window dropped in
 * open space is returned unchanged.
 */
export function snapPosition(
  rect: Rect,
  workArea: Rect,
  threshold = SNAP_EDGE_THRESHOLD,
  margin = SNAP_MARGIN,
  cornerThreshold = SNAP_CORNER_THRESHOLD,
): { x: number; y: number } {
  const left = workArea.x + margin
  const right = workArea.x + workArea.width - rect.width - margin
  const top = workArea.y + margin
  const bottom = workArea.y + workArea.height - rect.height - margin
  const dxLeft = Math.abs(rect.x - left)
  const dxRight = Math.abs(rect.x - right)
  const dyTop = Math.abs(rect.y - top)
  const dyBottom = Math.abs(rect.y - bottom)
  const xDist = Math.min(dxLeft, dxRight)
  const yDist = Math.min(dyTop, dyBottom)
  const xEdge = dxLeft <= dxRight ? left : right
  const yEdge = dyTop <= dyBottom ? top : bottom
  let x = rect.x
  let y = rect.y
  if (xDist <= cornerThreshold && yDist <= cornerThreshold) {
    // Near a corner: flush to it on both axes.
    x = xEdge
    y = yEdge
  } else {
    if (xDist <= threshold) x = xEdge
    if (yDist <= threshold) y = yEdge
  }
  return { x, y }
}
