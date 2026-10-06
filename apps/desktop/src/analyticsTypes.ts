export type AnalyticsBucket = 'day' | 'week'
export type AnalyticsRangeDays = 7 | 30 | 90
export type AnalyticsMetric = 'tokens' | 'time' | 'runs'

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
  tokens: AnalyticsTokens
  tokensLowerBound?: boolean
  runTimeMs: number
  runs: number
  failedRuns: number
  cancelledRuns?: number
}

export interface AnalyticsLeaderboardRow {
  agentId: string | null
  agentName: string | null
  runtimeId: string
  tokens: AnalyticsTokens
  tokensLowerBound?: boolean
  runTimeMs: number
  runs: number
  failedRuns: number
  cancelledRuns?: number
  unreportedRuns: number
}

export interface AnalyticsErrorRow {
  turnId: string
  sessionId: string
  agentId: string | null
  at: string
  message: string
  failureClass?: string
}

export interface AnalyticsTotals {
  tokens: AnalyticsTokens
  tokensLowerBound?: boolean
  runTimeMs: number
  runs: number
  failedRuns: number
  cancelledRuns?: number
  activeRuns: number
  unreportedRuns: number
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
}

export interface UsageAnalyticsRequest {
  from: string
  to: string
  bucket: AnalyticsBucket
  tz: string
  projectPath?: string
  agentId?: string
}
