import type { AnalyticsCost, AnalyticsTokens, UsageAnalytics } from '../analyticsTypes'

export type AnalyticsFixtureName = 'full' | 'partial' | 'empty' | 'unknown' | 'legacy' | 'dst'

function cost(partial: Partial<AnalyticsCost> & Pick<AnalyticsCost, 'amountMinor' | 'lowerBound'>): AnalyticsCost {
  return {
    currency: 'USD',
    actualMinor: partial.amountMinor,
    estimatedMinor: partial.estimatedMinor ?? null,
    ...partial,
  }
}

function tokens(partial: Partial<AnalyticsTokens> & Pick<AnalyticsTokens, 'total'>): AnalyticsTokens {
  return {
    input: partial.total,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
    ...partial,
  }
}

const priced = (amountMinor: number, lowerBound = false, actualMinor = amountMinor, estimatedMinor: number | null = null): AnalyticsCost =>
  cost({ amountMinor, lowerBound, actualMinor, estimatedMinor, currency: 'USD' })

const knownTokens = (total: number, input = total): AnalyticsTokens =>
  tokens({ input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total })

const unknownTokens = (): AnalyticsTokens =>
  tokens({ input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null })

const gapPoint = (bucketStart: string) => ({
  bucketStart,
  cost: cost({ amountMinor: null, actualMinor: null, estimatedMinor: null, lowerBound: false, currency: 'USD' }),
  tokens: unknownTokens(),
  runTimeMs: 0,
  runs: 0,
  failedRuns: 0,
})

export const analyticsFixtures: Record<AnalyticsFixtureName, UsageAnalytics> = {
  full: {
    range: { from: '2026-09-25T23:00:00.000Z', to: '2026-10-02T23:00:00.000Z', bucket: 'day', tz: 'Europe/London' },
    totals: {
      cost: priced(1234, false, 1000, 234),
      tokens: knownTokens(1500, 1200),
      runTimeMs: 123456,
      runs: 40,
      failedRuns: 2,
      activeRuns: 1,
      unreportedRuns: 0,
      unpricedModels: [],
      excludedCurrencies: [],
    },
    series: [
      { bucketStart: '2026-09-28T23:00:00.000Z', cost: priced(100), tokens: knownTokens(100), runTimeMs: 1000, runs: 1, failedRuns: 0 },
      { bucketStart: '2026-09-29T23:00:00.000Z', cost: priced(400), tokens: knownTokens(400), runTimeMs: 4000, runs: 4, failedRuns: 0 },
      gapPoint('2026-09-30T23:00:00.000Z'),
      { bucketStart: '2026-10-01T23:00:00.000Z', cost: priced(250), tokens: knownTokens(200), runTimeMs: 2000, runs: 2, failedRuns: 1 },
    ],
    leaderboard: [
      { agentId: 'agent-codex', agentName: 'Codex', runtimeId: 'runtime-codex', tokens: knownTokens(800), cost: priced(800), runTimeMs: 80000, runs: 20, failedRuns: 1, unreportedRuns: 0, unpricedModels: [] },
      { agentId: 'agent-claude', agentName: 'Claude', runtimeId: 'runtime-claude', tokens: knownTokens(400), cost: priced(400), runTimeMs: 40000, runs: 10, failedRuns: 1, unreportedRuns: 0, unpricedModels: [] },
    ],
    errors: [
      { turnId: 'turn-1', sessionId: 'session-codex', agentId: 'agent-codex', at: '2026-10-01T15:04:00.000Z', message: 'The turn stopped after a tool error.' },
      { turnId: 'turn-2', sessionId: 'session-claude', agentId: 'agent-claude', at: '2026-09-30T09:00:00.000Z', message: 'The runtime reported a failed turn.' },
    ],
    subscriptions: [{ provider: 'claude', monthlyMinor: 5000, currency: 'USD', quotaState: 'unknown' }],
  },
  partial: {
    range: { from: '2026-09-25T23:00:00.000Z', to: '2026-10-02T23:00:00.000Z', bucket: 'day', tz: 'Europe/London' },
    totals: {
      cost: priced(1234, true, 1000, 234),
      tokens: tokens({ input: 100, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: 100 }),
      runTimeMs: 90000,
      runs: 12,
      failedRuns: 1,
      activeRuns: 0,
      unreportedRuns: 7,
      unpricedModels: ['provider/model'],
      excludedCurrencies: ['EUR'],
    },
    series: [
      { bucketStart: '2026-09-29T23:00:00.000Z', cost: priced(200, true, 200, null), tokens: tokens({ input: 40, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: 40 }), runTimeMs: 30000, runs: 2, failedRuns: 0 },
      { bucketStart: '2026-09-30T23:00:00.000Z', cost: cost({ amountMinor: null, actualMinor: null, estimatedMinor: null, lowerBound: true, currency: 'USD' }), tokens: unknownTokens(), runTimeMs: 0, runs: 1, failedRuns: 0 },
    ],
    leaderboard: [
      { agentId: 'agent-codex', agentName: 'Codex', runtimeId: 'runtime-codex', tokens: tokens({ input: 100, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: 100 }), cost: priced(1234, true, 1000, 234), runTimeMs: 90000, runs: 12, failedRuns: 1, unreportedRuns: 7, unpricedModels: ['provider/model'] },
    ],
    errors: [{ turnId: 'turn-partial', sessionId: 'session-codex', agentId: 'agent-codex', at: '2026-10-01T15:04:00.000Z', message: 'safe short text' }],
    subscriptions: [],
  },
  empty: {
    range: { from: '2026-09-25T23:00:00.000Z', to: '2026-10-02T23:00:00.000Z', bucket: 'day', tz: 'Europe/London' },
    totals: {
      cost: cost({ amountMinor: null, actualMinor: null, estimatedMinor: null, lowerBound: false, currency: 'USD' }),
      tokens: unknownTokens(),
      runTimeMs: 0,
      runs: 0,
      failedRuns: 0,
      activeRuns: 0,
      unreportedRuns: 0,
      unpricedModels: [],
      excludedCurrencies: [],
    },
    series: [gapPoint('2026-09-30T23:00:00.000Z')],
    leaderboard: [],
    errors: [],
    subscriptions: [],
  },
  unknown: {
    range: { from: '2026-09-25T23:00:00.000Z', to: '2026-10-02T23:00:00.000Z', bucket: 'day', tz: 'Europe/London' },
    totals: {
      cost: cost({ amountMinor: null, actualMinor: null, estimatedMinor: null, lowerBound: true, currency: 'USD' }),
      tokens: tokens({ input: 50, output: 10, cacheRead: null, cacheWrite: null, reasoning: null, total: 60 }),
      runTimeMs: 61000,
      runs: 3,
      failedRuns: 0,
      activeRuns: 0,
      unreportedRuns: 0,
      unpricedModels: ['openai/mystery'],
      excludedCurrencies: [],
    },
    series: [
      { bucketStart: '2026-10-01T23:00:00.000Z', cost: cost({ amountMinor: null, actualMinor: null, estimatedMinor: null, lowerBound: true, currency: 'USD' }), tokens: tokens({ input: 50, output: 10, cacheRead: null, cacheWrite: null, reasoning: null, total: 60 }), runTimeMs: 61000, runs: 3, failedRuns: 0 },
    ],
    leaderboard: [
      { agentId: 'agent-codex', agentName: 'Codex', runtimeId: 'runtime-codex', tokens: tokens({ input: 50, output: 10, cacheRead: null, cacheWrite: null, reasoning: null, total: 60 }), cost: cost({ amountMinor: null, actualMinor: null, estimatedMinor: null, lowerBound: true, currency: 'USD' }), runTimeMs: 61000, runs: 3, failedRuns: 0, unreportedRuns: 0, unpricedModels: ['openai/mystery'] },
    ],
    errors: [],
    subscriptions: [{ provider: 'codex', monthlyMinor: 2000, currency: 'USD', quotaState: 'unknown' }],
  },
  legacy: {
    range: { from: '2026-09-25T23:00:00.000Z', to: '2026-10-02T23:00:00.000Z', bucket: 'day', tz: 'Europe/London' },
    totals: {
      cost: priced(600, false, 600, null),
      tokens: knownTokens(30),
      runTimeMs: 30000,
      runs: 5,
      failedRuns: 0,
      activeRuns: 0,
      unreportedRuns: 0,
      unpricedModels: [],
      excludedCurrencies: [],
    },
    series: [
      { bucketStart: '2026-10-01T23:00:00.000Z', cost: priced(600), tokens: knownTokens(30), runTimeMs: 30000, runs: 5, failedRuns: 0 },
    ],
    leaderboard: [
      { agentId: null, agentName: null, runtimeId: 'runtime-codex', tokens: knownTokens(20), cost: priced(500), runTimeMs: 20000, runs: 4, failedRuns: 0, unreportedRuns: 0, unpricedModels: [] },
      { agentId: 'agent-codex', agentName: 'Codex', runtimeId: 'runtime-codex', tokens: knownTokens(10), cost: priced(100), runTimeMs: 10000, runs: 1, failedRuns: 0, unreportedRuns: 0, unpricedModels: [] },
    ],
    errors: [],
    subscriptions: [],
  },
  dst: {
    range: { from: '2026-03-23T00:00:00.000Z', to: '2026-04-05T23:00:00.000Z', bucket: 'week', tz: 'Europe/London' },
    totals: {
      cost: priced(80, false, 80, null),
      tokens: knownTokens(16),
      runTimeMs: 16000,
      runs: 2,
      failedRuns: 0,
      activeRuns: 0,
      unreportedRuns: 0,
      unpricedModels: [],
      excludedCurrencies: [],
    },
    series: [
      { bucketStart: '2026-03-23T00:00:00.000Z', cost: priced(30), tokens: knownTokens(6), runTimeMs: 6000, runs: 1, failedRuns: 0 },
      { bucketStart: '2026-03-29T23:00:00.000Z', cost: priced(50), tokens: knownTokens(10), runTimeMs: 10000, runs: 1, failedRuns: 0 },
    ],
    leaderboard: [
      { agentId: 'agent-claude', agentName: 'Claude', runtimeId: 'runtime-claude', tokens: knownTokens(16), cost: priced(80), runTimeMs: 16000, runs: 2, failedRuns: 0, unreportedRuns: 0, unpricedModels: [] },
    ],
    errors: [],
    subscriptions: [],
  },
}

const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000

export function analyticsFixtureName(value: string | null | undefined): AnalyticsFixtureName {
  if (value === 'partial' || value === 'lower-bound' || value === 'lower') return 'partial'
  if (value === 'empty' || value === 'nodata' || value === 'none') return 'empty'
  if (value === 'unknown' || value === 'unpriced') return 'unknown'
  if (value === 'legacy' || value === 'null-agent') return 'legacy'
  if (value === 'dst') return 'dst'
  return 'full'
}

/** Preview stand-in for `usage.analytics`. Rejects the same range cases the daemon rejects. */
export function answerUsageAnalytics(params: Record<string, unknown>, scenario: string | null): UsageAnalytics {
  if (scenario === 'error') throw new Error('internal: Usage analytics failed.')
  const from = typeof params.from === 'string' ? params.from : ''
  const to = typeof params.to === 'string' ? params.to : ''
  const bucket = params.bucket === 'week' ? 'week' : params.bucket === 'day' ? 'day' : ''
  const tz = typeof params.tz === 'string' ? params.tz.trim() : ''
  const fromMs = Date.parse(from)
  const toMs = Date.parse(to)
  if (!from || !to || !bucket || !tz || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new Error('invalid_argument: The analytics range is invalid.')
  }
  if (toMs - fromMs > MAX_RANGE_MS) throw new Error('invalid_argument: The analytics range is too long.')
  if (params.agentId === 'missing-agent') throw new Error('not_found: That blob is no longer available.')
  const name = analyticsFixtureName(scenario)
  const fixture = structuredClone(analyticsFixtures[name])
  if (name === 'dst') return fixture
  return { ...fixture, range: { from, to, bucket, tz } }
}
