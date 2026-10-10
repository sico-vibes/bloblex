import { describe, expect, it } from 'vitest'
import { quotaRows, quotaTone, resetIn, updatedAgo } from './quotaModel'

const now = Date.parse('2026-10-10T12:00:00Z')

describe('quota display model', () => {
  it('names windows by duration and orders supported providers', () => {
    const rows = quotaRows([
      { provider:'opencode', snapshot:{ limits:[{ label:'5-hour', primary:{ usedPercent:3, windowDurationMins:300 } }, { label:'Monthly', primary:{ usedPercent:16, windowDurationMins:null } }] } },
      { provider:'generic', snapshot:{ limits:[{ label:'Other', primary:{ usedPercent:9 } }] } },
      { provider:'claude', snapshot:{ limits:[{ label:'Claude Code', primary:{ usedPercent:1, windowDurationMins:300 }, secondary:{ usedPercent:27, windowDurationMins:10080 } }, { label:'Claude Opus', primary:{ usedPercent:12, windowDurationMins:10080 } }] } },
      { provider:'codex', snapshot:{ limits:[{ label:'Codex', primary:{ usedPercent:140, windowDurationMins:300 } }] } },
    ])
    expect(rows.map((row) => row.provider)).toEqual(['claude', 'codex', 'opencode'])
    expect(rows[0].windows.map((window) => [window.label, window.short, window.usedPercent])).toEqual([['Session', '5h', 1], ['Weekly', 'wk', 27], ['Weekly · Opus', 'Opus', 12]])
    expect(rows[1].windows[0].usedPercent).toBe(100)
    expect(rows[2].windows.map((window) => window.short)).toEqual(['5h', '30d'])
  })

  it('keeps failures visible without inventing values', () => {
    const [missing, stale] = quotaRows([
      { provider:'claude', lastError:'unauthorized', snapshot:null },
      { provider:'codex', lastError:'timeout', snapshot:{ limits:[{ label:'Codex', primary:{ usedPercent:5, windowDurationMins:300 } }] } },
    ])
    expect(missing).toMatchObject({ windows:[], status:'Sign-in expired', stale:false })
    expect(stale).toMatchObject({ status:'Timed out', stale:true })
    expect(quotaRows([{ provider:'codex', snapshot:{ limits:[{ label:'Codex', primary:{ usedPercent:'50' } }] } }])[0]).toMatchObject({ windows:[], status:'Unavailable' })
  })

  it('formats reset countdowns, freshness and tone thresholds', () => {
    expect(resetIn('2026-10-10T16:59:00Z', now)).toBe('4h 59m')
    expect(resetIn('2026-10-14T15:00:00Z', now)).toBe('4d 3h')
    expect(resetIn('2026-10-10T12:00:20Z', now)).toBe('1m')
    expect(resetIn('2026-10-10T11:00:00Z', now)).toBe('now')
    expect(resetIn(null, now)).toBeNull()
    expect(resetIn('not a date', now)).toBeNull()
    expect(updatedAgo('2026-10-10T11:59:30Z', now)).toBe('Updated just now')
    expect(updatedAgo('2026-10-10T11:30:00Z', now)).toBe('Updated 30m ago')
    expect(updatedAgo('2026-10-10T09:00:00Z', now)).toBe('Updated 3h ago')
    expect([quotaTone(69), quotaTone(70), quotaTone(90)]).toEqual(['normal', 'warning', 'critical'])
  })
})
