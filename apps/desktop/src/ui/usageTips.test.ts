import { describe, expect, it } from 'vitest'
import { appendUsageTipDismissal, MAX_QUOTA_AGE_MS, parseUsageTipDismissals, selectUsageTip, usageTipCopy } from './usageTips'

const now = Date.parse('2026-10-11T12:00:00Z')
function row(provider: string, percent: number, resetsAt: string | null, fetchedAt = new Date(now).toISOString(), lastError?: string) {
  return { provider, fetchedAt, lastAttemptAt: fetchedAt, lastError: lastError ?? null, snapshot: { limits: [{ label: 'Weekly', primary: { usedPercent: percent, resetsAt, windowDurationMins: 10_080 } }] } }
}

describe('reported quota usage tips', () => {
  it('uses the selected provider, real percentage and known reset only', () => {
    const tip = selectUsageTip('claude', [row('codex', 99, '2026-10-12T12:00:00Z'), row('claude', 76, '2026-10-12T12:00:00Z')], [], now)
    expect(tip).toMatchObject({ provider: 'claude', usedPercent: 76, threshold: 75, windowLabel: 'Weekly' })
    expect(usageTipCopy(tip!, now)).toBe('You’re at 76% of your weekly usage limit. It resets in 1d 0h.')
    expect(usageTipCopy({ ...tip!, resetAt: null }, now)).toBe('You’re at 76% of your weekly usage limit.')
  })

  it('rejects a fresh quota whose reported period has already reset', () => {
    expect(selectUsageTip('codex', [row('codex', 92, '2026-10-11T11:59:59Z')], [], now)).toBeNull()
    expect(selectUsageTip('codex', [row('codex', 92, null)], [], now)).toMatchObject({ threshold: 90, resetAt: null })
  })

  it('keeps model qualifiers in copy for model-specific quota windows', () => {
    const tip = selectUsageTip('claude', [row('claude', 78, '2026-10-12T12:00:00Z')], [], now)!
    const qualified = { ...tip, windowLabel: 'Weekly · Opus' }
    expect(usageTipCopy(qualified, now)).toBe('You’re at 78% of your weekly Opus usage limit. It resets in 1d 0h.')
  })

  it('escalates at higher thresholds and stays dismissed through ordinary refreshes', () => {
    const initial = selectUsageTip('codex', [row('codex', 82, '2026-10-12T12:00:00Z')], [], now)!
    const dismissed = appendUsageTipDismissal([], initial.dismissal)
    expect(selectUsageTip('codex', [row('codex', 84, '2026-10-12T12:00:00Z', new Date(now + 60_000).toISOString())], dismissed, now + 60_000)).toBeNull()
    expect(selectUsageTip('codex', [row('codex', 91, '2026-10-12T12:00:00Z')], dismissed, now)).toMatchObject({ threshold: 90, usedPercent: 91 })
    expect(selectUsageTip('codex', [row('codex', 91, '2026-10-13T12:00:00Z')], dismissed, now)).toMatchObject({ threshold: 90 })
  })

  it('omits stale, failed, unknown, unsupported and old snapshots', () => {
    expect(selectUsageTip('codex', [row('codex', 99, '2026-10-12T12:00:00Z', new Date(now - MAX_QUOTA_AGE_MS - 1).toISOString())], [], now)).toBeNull()
    expect(selectUsageTip('codex', [row('codex', 99, '2026-10-12T12:00:00Z', undefined, 'timeout')], [], now)).toBeNull()
    expect(selectUsageTip('claude', [{ provider: 'claude', fetchedAt: new Date(now).toISOString(), snapshot: null, lastError: null }], [], now)).toBeNull()
    expect(selectUsageTip('custom', [row('codex', 99, '2026-10-12T12:00:00Z')], [], now)).toBeNull()
  })

  it('normalizes dismissal records and enforces a bounded local list', () => {
    expect(parseUsageTipDismissals([{ provider: 'codex', windowKey: 'Weekly-primary', resetAt: '2026-10-12T12:00:00Z', threshold: 75 }, { provider: 'custom', windowKey: 'x', resetAt: null, threshold: 75 }])).toEqual([{ provider: 'codex', windowKey: 'Weekly-primary', resetAt: '2026-10-12T12:00:00.000Z', threshold: 75 }])
    const many = Array.from({ length: 30 }, (_, index) => ({ provider: 'codex', windowKey: `w${index}`, resetAt: null, threshold: 75 as const }))
    expect(appendUsageTipDismissal(many, { provider: 'claude', windowKey: 'weekly-primary', resetAt: null, threshold: 90 })).toHaveLength(24)
  })
})
