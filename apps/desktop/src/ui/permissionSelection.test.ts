import { describe, expect, it } from 'vitest'
import { isPendingPermissionLive, nextPermissionDeadline, selectPendingPermission } from './permissionSelection'

describe('pending permission selection', () => {
  const requests = [
    { id: 'later', sessionId: 'other', status: 'pending', expiresAt: '2026-10-02T13:00:00Z' },
    { id: 'active', sessionId: 'active', status: 'pending', expiresAt: '2026-10-02T13:00:00Z' },
    { id: 'selected', sessionId: 'selected', status: 'pending', expiresAt: '2026-10-02T13:30:00Z' },
    { id: 'resolved', sessionId: 'selected', status: 'resolved', expiresAt: '2026-10-01T12:00:00Z' },
  ]

  const now = Date.parse('2026-10-02T12:00:00Z')

  it('prioritizes a pending request for the selected session', () => {
    expect(selectPendingPermission(requests, 'selected', 'active', now)?.id).toBe('selected')
  })

  it('surfaces an approval from another session when none matches the current selection', () => {
    expect(selectPendingPermission(requests, 'missing', null, now)?.id).toBe('active')
  })

  it('uses expiry and stable IDs when no active session has a request', () => {
    expect(selectPendingPermission(requests.filter((item) => item.sessionId !== 'active'), 'missing', null, now)?.id).toBe('later')
  })

  it('excludes expired and malformed-deadline requests while allowing an absent deadline', () => {
    const result = selectPendingPermission([
      { id: 'expired', status: 'pending', expiresAt: '2026-01-01T00:00:00Z' },
      { id: 'malformed', status: 'pending', expiresAt: 'not-a-date' },
      { id: 'no-expiry', status: 'pending' },
    ], null, null, Date.parse('2026-10-01T12:00:00Z'))
    expect(result?.id).toBe('no-expiry')
  })

  it('schedules the nearest valid expiry and rejects stale replies against the injected clock', () => {
    const now = Date.parse('2026-10-01T12:00:00Z')
    const permission = { id: 'soon', status: 'pending', choices: ['allow_once'], expiresAt: '2026-10-01T12:00:05Z' }
    expect(nextPermissionDeadline([permission, { id: 'bad', status: 'pending', expiresAt: 'bad' }], now)).toBe(now + 5000)
    expect(isPendingPermissionLive(permission, now)).toBe(true)
    expect(isPendingPermissionLive(permission, now + 5000)).toBe(false)
    expect(isPendingPermissionLive({ id: 'bad', status: 'pending', expiresAt: 'bad' }, now)).toBe(false)
  })

  it('surfaces a global request when there is no selected session', () => {
    expect(selectPendingPermission([{ id: 'global', status: 'pending' }], null, null, 1)?.id).toBe('global')
  })
})
