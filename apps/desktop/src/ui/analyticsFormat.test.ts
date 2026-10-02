import { describe, expect, it } from 'vitest'
import type { AnalyticsSeriesPoint } from '../analyticsTypes'
import { analyticsFixtures } from './analyticsFixtures'
import {
  analyticsNotes,
  analyticsWindow,
  barAccessibleName,
  buildAnalyticsRequest,
  chartBars,
  chartRects,
  chartSummary,
  formatBoundMoney,
  formatBoundNumber,
  formatBucketLabel,
  formatExactNumber,
  formatRunTime,
  leaderboardFractions,
  leaderboardName,
  normalizeAnalytics,
  resolvedTimeZone,
  seriesMetricValue,
  unpricedModelsNote,
  unreportedRunsNote,
} from './analyticsFormat'

const london = 'Europe/London'

describe('analytics formatting', () => {
  it('keeps null money and token totals unknown and never zero', () => {
    expect(formatBoundMoney(null, 'USD', false)).toBe('Unknown')
    expect(formatBoundMoney(null, 'USD', true)).toBe('Unknown')
    expect(formatBoundMoney(null, 'USD', true)).not.toContain('0')
    expect(formatBoundMoney(null, 'USD', true)).not.toContain('≥')
    expect(formatBoundNumber(null, true)).toBe('Unknown')
    expect(formatExactNumber(null)).toBe('Unknown')
    expect(formatRunTime(null)).toBe('Unknown')
    expect(formatBoundMoney(0, 'USD', false)).not.toBe('Unknown')
    expect(formatBoundNumber(0, false)).toBe('0')
    expect(formatRunTime(0)).toBe('0s')
  })

  it('prefixes a known lower bound and formats currency, counts, and duration with Intl', () => {
    const money = formatBoundMoney(1234, 'USD', true)
    expect(money.startsWith('≥ ')).toBe(true)
    expect(money).toContain('12.34')
    expect(formatBoundMoney(1234, 'USD', false)).not.toContain('≥')
    expect(formatBoundNumber(1500, true)).toBe('≥ 1,500')
    expect(formatBoundNumber(1500, false)).toBe('1,500')
    expect(formatRunTime(123456)).toBe('2m 3s')
    expect(formatRunTime(90000)).toBe('1m 30s')
    expect(formatRunTime(3661000)).toBe('1h 1m 1s')
  })

  it('builds inclusive local midnights, including a 23-hour and a 25-hour DST week', () => {
    const spring = analyticsWindow(7, new Date('2026-03-29T12:00:00.000Z'), london)
    expect(spring.from).toBe('2026-03-23T00:00:00.000Z')
    expect(spring.to).toBe('2026-03-29T23:00:00.000Z')
    expect(Date.parse(spring.to) - Date.parse(spring.from)).toBe((7 * 24 - 1) * 60 * 60 * 1000)

    const autumn = analyticsWindow(7, new Date('2026-10-25T12:00:00.000Z'), london)
    expect(autumn.from).toBe('2026-10-18T23:00:00.000Z')
    expect(autumn.to).toBe('2026-10-26T00:00:00.000Z')
    expect(Date.parse(autumn.to) - Date.parse(autumn.from)).toBe((7 * 24 + 1) * 60 * 60 * 1000)

    const october = analyticsWindow(7, new Date('2026-10-02T12:00:00.000Z'), london)
    expect(october.from).toBe('2026-09-25T23:00:00.000Z')
    expect(october.to).toBe('2026-10-02T23:00:00.000Z')

    const request = buildAnalyticsRequest({
      days: 30,
      bucket: 'week',
      now: new Date('2026-10-02T12:00:00.000Z'),
      timeZone: london,
      projectPath: '  ',
      agentId: '',
    })
    expect(request.tz).toBe(london)
    expect(request.bucket).toBe('week')
    expect(request.from).toBe(analyticsWindow(30, new Date('2026-10-02T12:00:00.000Z'), london).from)
    expect(request.projectPath).toBeUndefined()
    expect(request.agentId).toBeUndefined()
    expect(buildAnalyticsRequest({ days: 7, bucket: 'day', timeZone: london, projectPath: 'C:/work/site', agentId: 'agent-claude' }).projectPath).toBe('C:/work/site')
  })

  it('labels the post-transition Monday in the caller timezone', () => {
    const londonLabel = formatBucketLabel('2026-03-29T23:00:00.000Z', 'week', london)
    const utcLabel = formatBucketLabel('2026-03-29T23:00:00.000Z', 'week', 'UTC')
    expect(londonLabel).toContain('Week of')
    expect(londonLabel).toContain('30')
    expect(londonLabel).not.toContain('29')
    expect(utcLabel).toContain('29')
  })

  it('uses the resolved IANA zone when a request does not override it', () => {
    const request = buildAnalyticsRequest({ days: 7, bucket: 'day', now: new Date('2026-10-02T12:00:00.000Z') })
    expect(request.tz).toBe(resolvedTimeZone())
    expect(request.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it('names a null chart bucket as no data and a real zero as zero', () => {
    expect(barAccessibleName('Oct 1', null, '0')).toBe('Oct 1, no data')
    expect(barAccessibleName('Oct 1', null, '0')).not.toContain('0')
    expect(barAccessibleName('Oct 1', 0, '0')).toBe('Oct 1, 0')
    const gap = analyticsFixtures.full.series[2] as AnalyticsSeriesPoint
    expect(seriesMetricValue(gap, 'tokens')).toBeNull()
    expect(seriesMetricValue(gap, 'cost')).toBeNull()
    expect(seriesMetricValue(gap, 'runs')).toBe(0)
    const bars = chartBars(analyticsFixtures.full.series, 'tokens', 'day', london)
    const missing = bars.find((bar) => bar.value === null)
    expect(missing?.gap).toBe(true)
    expect(missing?.name).toMatch(/no data$/)
    const runs = chartBars(analyticsFixtures.full.series, 'runs', 'day', london)
    const zero = runs.find((bar) => bar.bucketStart === gap.bucketStart)
    expect(zero?.gap).toBe(false)
    expect(zero?.value).toBe(0)
    expect(zero?.name).not.toContain('no data')
    const rects = chartRects(bars)
    const tall = rects.find((rect) => rect.value === 400)
    const short = rects.find((rect) => rect.value === 100)
    const hole = rects.find((rect) => rect.value === null)
    expect(tall && short && hole).toBeTruthy()
    expect(tall!.height).toBeGreaterThan(short!.height)
    expect(hole!.height).not.toBe(0)
    expect(chartSummary(bars, 'tokens', 'day')).toContain('1 bucket has no data')
    expect(chartSummary(runs, 'runs', 'day')).not.toContain('no data')
  })

  it('writes the lower-bound notes and the unassigned leaderboard label', () => {
    expect(unreportedRunsNote(7)).toBe('7 runs did not report usage')
    expect(unreportedRunsNote(0)).toBeNull()
    expect(unpricedModelsNote(['provider/model'])).toBe('Unpriced models: provider/model')
    expect(analyticsNotes(analyticsFixtures.partial.totals)).toEqual([
      'Totals are a lower bound.',
      '7 runs did not report usage',
      'Unpriced models: provider/model',
      'Excluded currencies: EUR',
    ])
    expect(analyticsNotes(analyticsFixtures.empty.totals)).toEqual([])
    expect(leaderboardName({ agentId: null, agentName: null })).toBe('Unassigned sessions')
    expect(leaderboardName({ agentId: 'agent-codex', agentName: 'Codex' })).toBe('Codex')
    expect(leaderboardFractions([500, null, 100])).toEqual([1, null, 0.2])
    expect(leaderboardFractions([null, null])).toEqual([null, null])
  })

  it('drops fields outside the analytics contract', () => {
    const raw = {
      ...analyticsFixtures.partial,
      errors: [{ ...analyticsFixtures.partial.errors[0], prompt: 'SECRET_PROMPT', env: 'SECRET_ENV' }],
    }
    const parsed = normalizeAnalytics(raw)
    expect(JSON.stringify(parsed)).not.toContain('SECRET_PROMPT')
    expect(JSON.stringify(parsed)).not.toContain('SECRET_ENV')
    expect(parsed?.errors[0]?.message).toBe('safe short text')
    expect(parsed?.totals.cost.amountMinor).toBe(1234)
    expect(parsed?.totals.cost.lowerBound).toBe(true)
    expect(parsed?.totals.tokens.output).toBeNull()
  })
})
