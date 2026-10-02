import { describe, expect, it } from 'vitest'
import { analyticsFixtures, answerUsageAnalytics } from './analyticsFixtures'

const request = { from: '2026-09-25T23:00:00.000Z', to: '2026-10-02T23:00:00.000Z', bucket: 'day', tz: 'Europe/London' }

describe('analytics fixtures', () => {
  it('rejects an empty, reversed, or over-long range and an unknown blob', () => {
    expect(() => answerUsageAnalytics({ ...request, from: request.to, to: request.from }, null)).toThrow(/invalid_argument/)
    expect(() => answerUsageAnalytics({ ...request, bucket: 'month' }, null)).toThrow(/invalid_argument/)
    expect(() => answerUsageAnalytics({ from: '2020-01-01T00:00:00.000Z', to: '2022-01-01T00:00:00.000Z', bucket: 'day', tz: 'UTC' }, 'full')).toThrow(/invalid_argument/)
    expect(() => answerUsageAnalytics({ ...request, agentId: 'missing-agent' }, 'full')).toThrow(/not_found/)
  })

  it('covers full, lower-bound, empty, unknown, legacy, and DST-week responses', () => {
    const full = answerUsageAnalytics({ ...request, projectPath: 'C:/work/site', agentId: 'agent-claude' }, 'full')
    expect(full.range).toEqual({ from: request.from, to: request.to, bucket: 'day', tz: 'Europe/London' })
    expect(full.totals.cost.lowerBound).toBe(false)
    expect(full.totals.cost.amountMinor).toBe(1234)
    expect(full.subscriptions[0]?.monthlyMinor).not.toBe(full.totals.cost.amountMinor)

    const partial = answerUsageAnalytics(request, 'partial')
    expect(partial.totals.cost.lowerBound).toBe(true)
    expect(partial.totals.unreportedRuns).toBe(7)
    expect(partial.totals.tokens.output).toBeNull()
    expect(partial.totals.tokens.total).not.toBe(0)

    const empty = answerUsageAnalytics(request, 'nodata')
    expect(empty.totals.runs).toBe(0)
    expect(empty.totals.tokens.total).toBeNull()
    expect(empty.totals.cost.amountMinor).toBeNull()
    expect(empty.leaderboard).toEqual([])

    const unknown = answerUsageAnalytics(request, 'unknown')
    expect(unknown.totals.cost.amountMinor).toBeNull()
    expect(unknown.totals.cost.lowerBound).toBe(true)
    expect(unknown.totals.unpricedModels).toEqual(['openai/mystery'])
    expect(unknown.totals.tokens.total).toBe(60)

    const legacy = answerUsageAnalytics(request, 'legacy')
    expect(legacy.leaderboard[0]).toMatchObject({ agentId: null, agentName: null })

    const dst = answerUsageAnalytics({ ...request, bucket: 'week' }, 'dst')
    expect(dst.range.tz).toBe('Europe/London')
    expect(dst.range.bucket).toBe('week')
    expect(dst.series.map((point) => point.bucketStart)).toEqual(['2026-03-23T00:00:00.000Z', '2026-03-29T23:00:00.000Z'])
    expect(dst.series[1]?.bucketStart).not.toBe('2026-03-30T00:00:00.000Z')
    expect(analyticsFixtures.dst.series[1]?.bucketStart).toBe('2026-03-29T23:00:00.000Z')
  })
})
