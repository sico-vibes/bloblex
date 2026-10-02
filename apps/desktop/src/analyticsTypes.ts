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
  bucketStart: string
  cost: AnalyticsCost
  tokens: AnalyticsTokens
  runTimeMs: number
  runs: number
  failedRuns: number
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
  unreportedRuns: number
  unpricedModels: string[]
}

export interface AnalyticsErrorRow {
  turnId: string
  sessionId: string
  agentId: string | null
  at: string
  message: string
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
