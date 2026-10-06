import type { AnalyticsTokens, UsageAnalytics } from '../analyticsTypes'

export type AnalyticsFixtureName = 'full' | 'partial' | 'empty' | 'unknown' | 'legacy' | 'dst'

const range = { from: '2026-09-25T23:00:00.000Z', to: '2026-10-02T23:00:00.000Z', bucket: 'day' as const, tz: 'Europe/London' }
const tokens = (total: number | null, input = total, output: number | null = 0, cacheRead: number | null = 0, cacheWrite: number | null = 0, reasoning: number | null = 0): AnalyticsTokens => ({ input, output, cacheRead, cacheWrite, reasoning, total })
const emptyTokens = () => tokens(null, null, null, null, null, null)
const gap = (bucketStart: string) => ({ bucketStart, tokens: emptyTokens(), tokensLowerBound: false, runTimeMs: 0, runs: 0, failedRuns: 0 })

export const analyticsFixtures: Record<AnalyticsFixtureName, UsageAnalytics> = {
  full: {
    range,
    totals: { tokens: tokens(1500, 1200, 300, 0, 0, 0), tokensLowerBound: false, runTimeMs: 123456, runs: 40, failedRuns: 2, activeRuns: 1, unreportedRuns: 0 },
    series: [
      { bucketStart: '2026-09-28T23:00:00.000Z', tokens: tokens(100, 100), runTimeMs: 1000, runs: 1, failedRuns: 0 },
      { bucketStart: '2026-09-29T23:00:00.000Z', tokens: tokens(400, 400), runTimeMs: 4000, runs: 4, failedRuns: 0 },
      gap('2026-09-30T23:00:00.000Z'),
      { bucketStart: '2026-10-01T23:00:00.000Z', tokens: tokens(200, 200), runTimeMs: 2000, runs: 2, failedRuns: 1 },
    ],
    leaderboard: [
      { agentId: 'agent-codex', agentName: 'Codex', runtimeId: 'runtime-codex', tokens: tokens(800), runTimeMs: 80000, runs: 20, failedRuns: 1, unreportedRuns: 0 },
      { agentId: 'agent-claude', agentName: 'Claude', runtimeId: 'runtime-claude', tokens: tokens(400), runTimeMs: 40000, runs: 10, failedRuns: 1, unreportedRuns: 0 },
    ],
    errors: [
      { turnId: 'turn-1', sessionId: 'session-codex', agentId: 'agent-codex', at: '2026-10-01T15:04:00.000Z', message: 'The turn stopped after a tool error.' },
      { turnId: 'turn-2', sessionId: 'session-claude', agentId: 'agent-claude', at: '2026-09-30T09:00:00.000Z', message: 'The runtime reported a failed turn.' },
    ],
  },
  partial: {
    range,
    totals: { tokens: tokens(100, 100, null, null, null, null), tokensLowerBound: true, runTimeMs: 90000, runs: 12, failedRuns: 1, activeRuns: 0, unreportedRuns: 7 },
    series: [{ bucketStart: '2026-09-29T23:00:00.000Z', tokens: tokens(40, 40, null, null, null, null), tokensLowerBound: true, runTimeMs: 30000, runs: 2, failedRuns: 0 }, gap('2026-09-30T23:00:00.000Z')],
    leaderboard: [{ agentId: 'agent-codex', agentName: 'Codex', runtimeId: 'runtime-codex', tokens: tokens(100, 100, null, null, null, null), tokensLowerBound: true, runTimeMs: 90000, runs: 12, failedRuns: 1, unreportedRuns: 7 }],
    errors: [{ turnId: 'turn-partial', sessionId: 'session-codex', agentId: 'agent-codex', at: '2026-10-01T15:04:00.000Z', message: 'safe short text' }],
  },
  empty: {
    range,
    totals: { tokens: emptyTokens(), tokensLowerBound: false, runTimeMs: 0, runs: 0, failedRuns: 0, activeRuns: 0, unreportedRuns: 0 },
    series: [gap('2026-09-30T23:00:00.000Z')], leaderboard: [], errors: [],
  },
  unknown: {
    range,
    totals: { tokens: tokens(60, 50, 10, null, null, null), tokensLowerBound: false, runTimeMs: 61000, runs: 3, failedRuns: 0, activeRuns: 0, unreportedRuns: 0 },
    series: [{ bucketStart: '2026-10-01T23:00:00.000Z', tokens: tokens(60, 50, 10, null, null, null), runTimeMs: 61000, runs: 3, failedRuns: 0 }],
    leaderboard: [{ agentId: 'agent-codex', agentName: 'Codex', runtimeId: 'runtime-codex', tokens: tokens(60, 50, 10, null, null, null), runTimeMs: 61000, runs: 3, failedRuns: 0, unreportedRuns: 0 }], errors: [],
  },
  legacy: {
    range,
    totals: { tokens: tokens(30), tokensLowerBound: false, runTimeMs: 30000, runs: 5, failedRuns: 0, activeRuns: 0, unreportedRuns: 0 },
    series: [{ bucketStart: '2026-10-01T23:00:00.000Z', tokens: tokens(30), runTimeMs: 30000, runs: 5, failedRuns: 0 }],
    leaderboard: [
      { agentId: null, agentName: null, runtimeId: 'runtime-codex', tokens: tokens(20), runTimeMs: 20000, runs: 4, failedRuns: 0, unreportedRuns: 0 },
      { agentId: 'agent-codex', agentName: 'Codex', runtimeId: 'runtime-codex', tokens: tokens(10), runTimeMs: 10000, runs: 1, failedRuns: 0, unreportedRuns: 0 },
    ], errors: [],
  },
  dst: {
    range: { from: '2026-03-23T00:00:00.000Z', to: '2026-04-05T23:00:00.000Z', bucket: 'week', tz: 'Europe/London' },
    totals: { tokens: tokens(16), tokensLowerBound: false, runTimeMs: 16000, runs: 2, failedRuns: 0, activeRuns: 0, unreportedRuns: 0 },
    series: [
      { bucketStart: '2026-03-23T00:00:00.000Z', tokens: tokens(6), runTimeMs: 6000, runs: 1, failedRuns: 0 },
      { bucketStart: '2026-03-29T23:00:00.000Z', tokens: tokens(10), runTimeMs: 10000, runs: 1, failedRuns: 0 },
    ],
    leaderboard: [{ agentId: 'agent-claude', agentName: 'Claude', runtimeId: 'runtime-claude', tokens: tokens(16), runTimeMs: 16000, runs: 2, failedRuns: 0, unreportedRuns: 0 }], errors: [],
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

/** Preview stand-in for token-only `usage.analytics`. */
export function answerUsageAnalytics(params: Record<string, unknown>, scenario: string | null): UsageAnalytics {
  if (scenario === 'error') throw new Error('internal: Usage analytics failed.')
  const from = typeof params.from === 'string' ? params.from : ''
  const to = typeof params.to === 'string' ? params.to : ''
  const bucket = params.bucket === 'week' ? 'week' : params.bucket === 'day' ? 'day' : ''
  const tz = typeof params.tz === 'string' ? params.tz.trim() : ''
  const fromMs = Date.parse(from)
  const toMs = Date.parse(to)
  if (!from || !to || !bucket || !tz || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs || toMs - fromMs > MAX_RANGE_MS) throw new Error('invalid_argument: analytics range, bucket, or timezone is invalid')
  if ((params.projectPath != null && typeof params.projectPath !== 'string') || (params.agentId != null && typeof params.agentId !== 'string')) throw new Error('invalid_argument: projectPath and agentId must be strings')
  if (params.agentId === 'missing-agent') throw new Error('not_found: agent not found')
  const fixture = structuredClone(analyticsFixtures[analyticsFixtureName(scenario)])
  if (scenario === 'dst') return fixture
  return { ...fixture, range: { from, to, bucket, tz } }
}

export const daemonAnalyticsWire = {
  range: { from: '2026-03-28T00:00:00.000Z', to: '2026-03-31T00:00:00.000Z', bucket: 'day', tz: 'Europe/London' },
  totals: { tokens: tokens(12, 12, null, null, null, null), tokensLowerBound: true, runTimeMs: 3600000, runs: 2, failedRuns: 1, cancelledRuns: 1, activeRuns: 0, unreportedRuns: 1 },
  series: [
    { bucketStart: '2026-03-28T00:00:00.000Z', tokens: emptyTokens(), tokensLowerBound: false, runTimeMs: 0, runs: 0, failedRuns: 0, cancelledRuns: 0 },
    { bucketStart: '2026-03-29T23:00:00.000Z', tokens: tokens(12, 12, null, null, null, null), tokensLowerBound: true, runTimeMs: 3600000, runs: 2, failedRuns: 1, cancelledRuns: 1 },
  ],
  leaderboard: [{ tokens: tokens(12, 12, null, null, null, null), tokensLowerBound: true, runTimeMs: 3600000, runs: 2, failedRuns: 1, cancelledRuns: 1, agentId: null, agentName: null, runtimeId: 'rt', unreportedRuns: 1 }],
  errors: [
    { turnId: 'analytics-turn', sessionId: 'analytics-session', agentId: null, at: '2026-03-29T01:10:00.000Z', message: 'Provider reported an error.', failureClass: 'provider', prompt: 'SECRET_PROMPT' },
    { turnId: 'analytics-context', sessionId: 'analytics-session', agentId: 'agent-1', at: '2026-03-29T02:10:00.000Z', message: 'Turn ended with an error.', failureClass: 'context' },
  ],
}
