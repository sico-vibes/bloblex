import type { PermissionRequest } from '../types'

export function isPendingPermissionLive(permission: PermissionRequest, now = Date.now()) {
  if (permission.status && permission.status !== 'pending') return false
  if (permission.expiresAt == null) return true
  if (typeof permission.expiresAt !== 'string') return false
  const expiry = Date.parse(permission.expiresAt)
  return Number.isFinite(expiry) && expiry > now
}

export function nextPermissionDeadline(permissions: PermissionRequest[], now = Date.now()) {
  const deadlines = permissions
    .filter((permission) => !permission.status || permission.status === 'pending')
    .map((permission) => typeof permission.expiresAt === 'string' ? Date.parse(permission.expiresAt) : Number.NaN)
    .filter((expiry) => Number.isFinite(expiry) && expiry > now)
  return deadlines.length ? Math.min(...deadlines) : null
}

/** One deterministic pending approval is surfaced in both windows. */
export function selectPendingPermission(permissions: PermissionRequest[], selectedSessionId?: string | null, activeSessionId?: string | null, now = Date.now()) {
  const pending = permissions.filter((permission) => isPendingPermissionLive(permission, now))
  return pending.sort((left, right) => {
    const priority = (item: PermissionRequest) => item.sessionId === selectedSessionId ? 0 : item.sessionId === activeSessionId ? 1 : 2
    const delta = priority(left) - priority(right)
    if (delta) return delta
    const leftExpiryValue = typeof left.expiresAt === 'string' ? Date.parse(left.expiresAt) : Number.POSITIVE_INFINITY
    const rightExpiryValue = typeof right.expiresAt === 'string' ? Date.parse(right.expiresAt) : Number.POSITIVE_INFINITY
    const leftExpiry = Number.isFinite(leftExpiryValue) ? leftExpiryValue : Number.POSITIVE_INFINITY
    const rightExpiry = Number.isFinite(rightExpiryValue) ? rightExpiryValue : Number.POSITIVE_INFINITY
    return leftExpiry - rightExpiry || left.id.localeCompare(right.id)
  })[0] ?? null
}
