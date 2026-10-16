import { describe, expect, it } from 'vitest'
import { mostPressingWindow, rotatingReadings } from './SidebarUsage'
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

describe('rotatingReadings', () => {
  it('keeps one current reading per coding agent and skips stale or failed ones', () => {
    const rows = quotaRows([
      snapshot('claude', 31),
      { ...snapshot('codex', 82), lastError: 'timeout' },
      { provider: 'opencode', lastError: 'no_credentials', snapshot: null },
    ])
    expect(rotatingReadings(rows).map((reading) => reading.row.provider)).toEqual(['claude'])
    expect(rotatingReadings(quotaRows([snapshot('claude', 31), snapshot('codex', 82)])).map((reading) => reading.window.usedPercent)).toEqual([31, 82])
  })
})
