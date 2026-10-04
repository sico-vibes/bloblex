export const BADGE_OFFSET = { x: -0.82, y: -0.66 } as const
export const BADGE_RADIUS = 0.34
export const BADGE_CLEARANCE = 0.035

export interface AccessoryBounds {
  x: number
  y: number
  halfWidth: number
  halfHeight: number
}

function distanceToBadge(bounds: AccessoryBounds, radius: number) {
  const badgeX = BADGE_OFFSET.x * radius
  const badgeY = BADGE_OFFSET.y * radius
  const closestX = Math.max(bounds.x - bounds.halfWidth, Math.min(badgeX, bounds.x + bounds.halfWidth))
  const closestY = Math.max(bounds.y - bounds.halfHeight, Math.min(badgeY, bounds.y + bounds.halfHeight))
  return Math.hypot(closestX - badgeX, closestY - badgeY)
}

export function badgeBoundsAreClear(bounds: AccessoryBounds, radius: number): boolean {
  return distanceToBadge(bounds, radius) >= (BADGE_RADIUS + BADGE_CLEARANCE) * radius
}

/** Move a colliding item right until its measured bounds clear the shared badge disk. */
export function clearAccessoryOfBadge(bounds: AccessoryBounds, radius: number): AccessoryBounds {
  if (badgeBoundsAreClear(bounds, radius)) return bounds
  return {
    ...bounds,
    x: Math.max(bounds.x, (BADGE_OFFSET.x + BADGE_RADIUS + BADGE_CLEARANCE) * radius + bounds.halfWidth),
  }
}
