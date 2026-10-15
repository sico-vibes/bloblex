import { describe, expect, it } from 'vitest'
import { mostPressingWindow } from './SidebarUsage'
import { quotaRows } from './quotaModel'

const snapshot = (provider: string, used: number, label = '5-hour') => ({
  provider, fetchedAt: '2026-10-15T10:00:00Z', lastError: null,
  snapshot: { limits: [{ label, primary: { usedPercent: used, windowDurationMins: 300, resetsAt: '2026-10-15T13:00:00Z' } }] },
})

describe('mostPressingWindow', () => {
  it('returns the window closest to its limit across providers', () => {
    const rows = quotaRows([snapshot('claude', 31), snapshot('codex', 82), snapshot('opencode', 12)])
    const pressing = mostPressingWindow(rows)
    expect(pressing?.row.provider).toBe('codex')
    expect(pressing?.window.usedPercent).toBe(82)
  })

  it('is null when no provider reported a window', () => {
    expect(mostPressingWindow(quotaRows([]))).toBeNull()
    expect(mostPressingWindow(quotaRows([{ provider: 'claude', lastError: 'no_credentials', snapshot: { limits: [] } }]))).toBeNull()
  })
})
