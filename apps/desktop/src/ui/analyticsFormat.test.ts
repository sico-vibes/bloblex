import { describe, expect, it, vi } from 'vitest'
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
  ANALYTICS_STORAGE_KEY,
  DEFAULT_ANALYTICS_PREFS,
  OFFENDER_RATE_MIN_RUNS,
  failureMix,
  failureMixSummary,
  foldLeaderboard,
  formatCancelledCount,
  formatUpdatedClock,
  offenderRateLabel,
  readAnalyticsPrefs,
  unpricedModelsNote,
  unreportedRunsNote,
  writeAnalyticsPrefs,
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

  it('keeps a reported zero cancellation and omits a missing or null count', () => {
    expect(formatCancelledCount(undefined)).toBeNull()
    expect(formatCancelledCount(null)).toBeNull()
    expect(formatCancelledCount(0)).toBe('0 cancelled')
    expect(formatCancelledCount(4)).toBe('4 cancelled')
    const absent = normalizeAnalytics(analyticsFixtures.empty)
    expect(absent?.totals.cancelledRuns).toBeUndefined()
    expect(Object.hasOwn(absent?.totals ?? {}, 'cancelledRuns')).toBe(false)
    const zero = normalizeAnalytics({ ...analyticsFixtures.empty, totals: { ...analyticsFixtures.empty.totals, cancelledRuns: 0 } })
    expect(zero?.totals.cancelledRuns).toBe(0)
    const nulled = normalizeAnalytics({ ...analyticsFixtures.empty, totals: { ...analyticsFixtures.empty.totals, cancelledRuns: null } })
    expect(nulled?.totals.cancelledRuns).toBeUndefined()
    expect(Object.hasOwn(nulled?.totals ?? {}, 'cancelledRuns')).toBe(false)
  })

  it('labels the Europe/London DST week from the fixed fixture', () => {
    const zone = analyticsFixtures.dst.range.tz
    const labels = analyticsFixtures.dst.series.map((point) => formatBucketLabel(point.bucketStart, 'week', zone))
    const day = (iso: string) => new Intl.DateTimeFormat(undefined, { timeZone: zone, month: 'short', day: 'numeric' }).format(new Date(iso))
    expect(labels[0]).toBe(`Week of ${day('2026-03-23T00:00:00.000Z')}`)
    expect(labels[1]).toBe(`Week of ${day('2026-03-29T23:00:00.000Z')}`)
    expect(labels[0]).toContain('23')
    expect(labels[1]).toContain('30')
    expect(labels[1]).not.toContain('29')
    expect(formatBucketLabel('2026-03-29T23:00:00.000Z', 'week', 'UTC')).toContain('29')
    expect(formatBucketLabel('2026-03-29T23:00:00.000Z', 'week', 'UTC')).not.toContain('30')
    expect(formatUpdatedClock(new Date('2026-10-02T12:00:00.000Z'), london)).toBe('13:00')
    expect(formatUpdatedClock(new Date('2026-03-29T00:30:00.000Z'), london)).toBe('00:30')
    expect(formatUpdatedClock(new Date('2026-03-29T01:30:00.000Z'), london)).toBe('02:30')
  })

  it('folds archived and unknown blobs into one Other row and keeps lower bounds', () => {
    const codex = analyticsFixtures.full.leaderboard[0]
    const claude = analyticsFixtures.full.leaderboard[1]
    if (!codex || !claude) throw new Error('fixture rows missing')
    const folded = foldLeaderboard([
      { ...codex, cancelledRuns: 2, unreportedRuns: 2, unpricedModels: ['provider/model'] },
      { ...claude, agentId: 'archived-claude', agentName: 'Claude', runs: 4, failedRuns: 1, cancelledRuns: 1, unreportedRuns: 1, unpricedModels: ['other/model'], cost: { ...claude.cost, lowerBound: true } },
      { ...claude, agentId: 'missing', agentName: 'Ghost', runs: 1, failedRuns: 1, unreportedRuns: 0, unpricedModels: [], cost: { ...claude.cost, amountMinor: null, actualMinor: null, estimatedMinor: null, lowerBound: false } },
      { ...codex, agentId: null, agentName: null, runs: 3, failedRuns: 0, cost: { ...codex.cost, amountMinor: 10, actualMinor: 10, estimatedMinor: null } },
    ], [
      { id: 'agent-codex', name: 'Codex', archived: false },
      { id: 'archived-claude', name: 'Claude', archived: true },
    ])
    expect(folded.map((row) => row.name)).toEqual(['Codex', 'Other', 'Unassigned sessions'])
    expect(folded.filter((row) => row.kind === 'other')).toHaveLength(1)
    const other = folded.find((row) => row.kind === 'other')
    expect(other?.cancelledRuns).toBeUndefined()
    expect(other?.unreportedRuns).toBe(1)
    expect(unreportedRunsNote(other?.unreportedRuns ?? 0)).toBe('1 run did not report usage')
    expect(unpricedModelsNote(other?.unpricedModels ?? [])).toBe('Unpriced models: other/model')
    expect(formatBoundMoney(other?.cost.amountMinor ?? null, other?.cost.currency ?? 'USD', other?.cost.lowerBound ?? false).startsWith('≥ ')).toBe(true)
    expect(formatBoundMoney(null, 'USD', true)).toBe('Unknown')
    expect(folded.find((row) => row.name === 'Codex')?.cancelledRuns).toBe(2)
    expect(folded.some((row) => row.name === 'Ghost' || row.name === 'Claude')).toBe(false)
  })

  it('counts unknown failure classes as Other and withholds rates below the sample floor', () => {
    expect(unreportedRunsNote(1)).toBe('1 run did not report usage')
    expect(unreportedRunsNote(7)).toBe('7 runs did not report usage')
    const mix = failureMix([
      { failureClass: 'provider' },
      { failureClass: 'NOPE' },
      {},
      { failureClass: 'budget' },
    ])
    expect(mix.map((segment) => [segment.label, segment.count])).toEqual([
      ['Provider error', 1],
      ['Permission denied', 0],
      ['Cancelled', 0],
      ['Timeout', 0],
      ['Budget stop', 1],
      ['Config/unsupported', 0],
      ['Other', 2],
    ])
    const summary = failureMixSummary(mix)
    expect(summary).toContain('Provider error 1')
    expect(summary).toContain('Other 2')
    expect(summary).not.toContain('NOPE')
    expect(offenderRateLabel({ rate: null, runs: OFFENDER_RATE_MIN_RUNS - 1 })).toBe(`Rate needs at least ${OFFENDER_RATE_MIN_RUNS} runs`)
    expect(offenderRateLabel({ rate: 0.2, runs: OFFENDER_RATE_MIN_RUNS })).toBe(new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(0.2))
  })

  it('drops raw payloads and keeps a safe class string', () => {
    const parsed = normalizeAnalytics({
      ...analyticsFixtures.partial,
      errors: [{
        turnId: 'turn-json',
        sessionId: 'session-codex',
        at: '2026-10-01T15:04:00.000Z',
        message: '{"error":"SECRET_JSON"}',
        reason: 'The provider rejected the turn.',
        failureClass: { raw: true },
        prompt: 'SECRET_PROMPT',
      }],
    })
    expect(parsed?.errors[0]?.message).toBe('The provider rejected the turn.')
    expect(parsed?.errors[0]?.failureClass).toBeUndefined()
    expect(JSON.stringify(parsed)).not.toContain('SECRET_JSON')
    expect(JSON.stringify(parsed)).not.toContain('SECRET_PROMPT')
    const classed = normalizeAnalytics({
      ...analyticsFixtures.partial,
      errors: [{ ...analyticsFixtures.partial.errors[0], failureClass: 'timeout', prompt: 'SECRET_PROMPT' }],
    })
    expect(classed?.errors[0]?.failureClass).toBe('timeout')
    expect(JSON.stringify(classed)).not.toContain('SECRET_PROMPT')
  })

  it('reads defaults when analytics storage throws or is invalid', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => undefined,
      clear: () => undefined,
    })
    expect(readAnalyticsPrefs()).toEqual(DEFAULT_ANALYTICS_PREFS)
    expect(() => writeAnalyticsPrefs({ ...DEFAULT_ANALYTICS_PREFS, days: 90, panel: 'errors' })).not.toThrow()
    vi.unstubAllGlobals()
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
      clear: () => { store.clear() },
    })
    store.set(ANALYTICS_STORAGE_KEY, '{')
    expect(readAnalyticsPrefs()).toEqual(DEFAULT_ANALYTICS_PREFS)
    writeAnalyticsPrefs({ ...DEFAULT_ANALYTICS_PREFS, days: 90, bucket: 'week', metric: 'cost', panel: 'errors', projectKey: 'c:\\work' })
    expect(readAnalyticsPrefs()).toEqual({ days: 90, bucket: 'week', metric: 'cost', panel: 'errors', projectKey: 'c:\\work' })
    vi.unstubAllGlobals()
  })
})
