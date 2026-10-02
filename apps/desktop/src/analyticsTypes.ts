export type AnalyticsBucket = 'day' | 'week'
export type AnalyticsRangeDays = 7 | 30 | 90
export type AnalyticsMetric = 'tokens' | 'cost' | 'time' | 'runs'

export interface AnalyticsCost {
  amountMinor: number | null
  currency: string
  actualMinor: number | null
  estimatedMinor: number | null
  lowerBound: boolean
}

export interface AnalyticsTokens {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  reasoning: number | null
  total: number | null
}

export interface AnalyticsSeriesPoint {
  /** RFC3339 UTC with milliseconds and a Z suffix, for example `2026-03-28T00:00:00.000Z`. */
  bucketStart: string
  cost: AnalyticsCost
  tokens: AnalyticsTokens
  runTimeMs: number
  runs: number
  failedRuns: number
  /** Present only when the daemon counted cancelled turns. Absence is not zero. */
  cancelledRuns?: number
}

export interface AnalyticsLeaderboardRow {
  agentId: string | null
  agentName: string | null
  runtimeId: string
  tokens: AnalyticsTokens
  cost: AnalyticsCost
  runTimeMs: number
  runs: number
  failedRuns: number
  /** Present only when the daemon counted cancelled turns. Absence is not zero. */
  cancelledRuns?: number
  unreportedRuns: number
  unpricedModels: string[]
}

export interface AnalyticsErrorRow {
  turnId: string
  sessionId: string
  agentId: string | null
  at: string
  message: string
  /**
   * Coarse class when the daemon persisted one.
   * Wire values: provider, permission, cancelled, timeout, budget, config, context, other.
   * `context` is shown as "Context full". Any other string is displayed as Other.
   * Absence leaves the turn unclassified in the list and counted under Other in the mix.
   */
  failureClass?: string
}

export interface AnalyticsSubscription {
  provider: string
  monthlyMinor: number
  currency: string
  quotaState: string
}

export interface AnalyticsTotals {
  cost: AnalyticsCost
  tokens: AnalyticsTokens
  runTimeMs: number
  runs: number
  failedRuns: number
  /** Present only when the daemon counted cancelled turns. Absence is not zero. */
  cancelledRuns?: number
  activeRuns: number
  unreportedRuns: number
  unpricedModels: string[]
  excludedCurrencies: string[]
}

export interface AnalyticsRange {
  from: string
  to: string
  bucket: AnalyticsBucket
  tz: string
}

export interface UsageAnalytics {
  range: AnalyticsRange
  totals: AnalyticsTotals
  series: AnalyticsSeriesPoint[]
  leaderboard: AnalyticsLeaderboardRow[]
  errors: AnalyticsErrorRow[]
  subscriptions: AnalyticsSubscription[]
}

/** `from` is inclusive and `to` is exclusive. Both are UTC RFC3339. */
export interface UsageAnalyticsRequest {
  from: string
  to: string
  bucket: AnalyticsBucket
  tz: string
  projectPath?: string
  agentId?: string
}
