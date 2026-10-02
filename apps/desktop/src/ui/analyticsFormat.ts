import type { AnalyticsBucket, AnalyticsCost, AnalyticsLeaderboardRow, AnalyticsMetric, AnalyticsRangeDays, AnalyticsSeriesPoint, AnalyticsTokens, UsageAnalytics, UsageAnalyticsRequest } from '../analyticsTypes'
import { moneyMinor } from './usagePresentation'

export function resolvedTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return typeof tz === 'string' && tz.trim() ? tz : 'UTC'
}

interface CivilDate { year: number; month: number; day: number }

function zoneParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '0'
  let hour = Number(read('hour'))
  if (hour === 24) hour = 0
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour,
    minute: Number(read('minute')),
    second: Number(read('second')),
  }
}

function civilInZone(instant: Date, timeZone: string): CivilDate {
  const parts = zoneParts(instant, timeZone)
  return { year: parts.year, month: parts.month, day: parts.day }
}

/** Wall-clock offset of `instant` in `timeZone`: local-as-UTC minus the instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zoneParts(instant, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - instant.getTime()
}

function shiftCivil(date: CivilDate, days: number): CivilDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
}

/** UTC instant of local midnight. A second offset pass keeps DST boundaries on the local date. */
export function zonedMidnightUtc(date: CivilDate, timeZone: string): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0)
  let utc = wall - zoneOffsetMs(new Date(wall), timeZone)
  utc = wall - zoneOffsetMs(new Date(utc), timeZone)
  return new Date(utc)
}

/**
 * Inclusive local start through exclusive next-day local midnight, covering `days` civil dates.
 * Boundaries are local midnights in `timeZone`, so a DST day is 23 or 25 hours.
 */
export function analyticsWindow(days: AnalyticsRangeDays, now: Date, timeZone: string): { from: string; to: string } {
  const today = civilInZone(now, timeZone)
  const start = shiftCivil(today, -(days - 1))
  const end = shiftCivil(today, 1)
  return {
    from: zonedMidnightUtc(start, timeZone).toISOString(),
    to: zonedMidnightUtc(end, timeZone).toISOString(),
  }
}

export function buildAnalyticsRequest(args: {
  days: AnalyticsRangeDays
  bucket: AnalyticsBucket
  now?: Date
  timeZone?: string
  projectPath?: string | null
  agentId?: string | null
}): UsageAnalyticsRequest {
  const timeZone = args.timeZone ?? resolvedTimeZone()
  const window = analyticsWindow(args.days, args.now ?? new Date(), timeZone)
  const request: UsageAnalyticsRequest = { from: window.from, to: window.to, bucket: args.bucket, tz: timeZone }
  const projectPath = args.projectPath?.trim()
  if (projectPath) request.projectPath = projectPath
  const agentId = args.agentId?.trim()
  if (agentId) request.agentId = agentId
  return request
}

export function formatExactNumber(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unknown'
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

/** Known numbers may carry a lower-bound prefix. Null stays "Unknown" and is never rendered as 0. */
export function formatBoundNumber(value: number | null, lowerBound: boolean): string {
  const text = formatExactNumber(value)
  if (text === 'Unknown') return 'Unknown'
  return lowerBound ? `≥ ${text}` : text
}

export function formatBoundMoney(amountMinor: number | null, currency: string, lowerBound: boolean): string {
  const text = moneyMinor(amountMinor, currency)
  if (text === 'Unknown') return 'Unknown'
  return lowerBound ? `≥ ${text}` : text
}

export function formatRunTime(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Unknown'
  const total = Math.round(value / 1000)
  const zero = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(0)
  if (total === 0) return `${zero}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const duration: Record<string, number> = {}
  if (hours) duration.hours = hours
  if (minutes) duration.minutes = minutes
  if (seconds) duration.seconds = seconds
  const Factory = (Intl as unknown as { DurationFormat?: new (locales?: Intl.LocalesArgument, options?: { style?: string }) => { format: (duration: Record<string, number>) => string } }).DurationFormat
  if (typeof Factory === 'function') {
    try {
      const formatted = new Factory(undefined, { style: 'narrow' }).format(duration)
      if (formatted.trim()) return formatted
    } catch { /* NumberFormat fallback below */ }
  }
  const n = (part: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(part)
  const parts: string[] = []
  if (hours) parts.push(`${n(hours)}h`)
  if (minutes) parts.push(`${n(minutes)}m`)
  if (seconds || parts.length === 0) parts.push(`${n(seconds)}s`)
  return parts.join(' ')
}

export function formatBucketLabel(iso: string, bucket: AnalyticsBucket, timeZone: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Unknown bucket'
  const day = new Intl.DateTimeFormat(undefined, { timeZone, month: 'short', day: 'numeric' }).format(date)
  return bucket === 'week' ? `Week of ${day}` : day
}

export function formatInstant(iso: string, timeZone: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function unreportedRunsNote(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(count)
  return count === 1 ? `${formatted} run did not report usage` : `${formatted} runs did not report usage`
}

export function unpricedModelsNote(models: readonly string[]): string | null {
  const list = models.filter((model) => model.trim())
  if (!list.length) return null
  return `Unpriced models: ${list.join(', ')}`
}

export function excludedCurrenciesNote(currencies: readonly string[]): string | null {
  const list = currencies.filter((currency) => currency.trim())
  if (!list.length) return null
  return `Excluded currencies: ${list.join(', ')}`
}

export function analyticsNotes(totals: UsageAnalytics['totals']): string[] {
  const notes: string[] = []
  if (totals.cost.lowerBound) notes.push('Totals are a lower bound.')
  const unreported = unreportedRunsNote(totals.unreportedRuns)
  if (unreported) notes.push(unreported)
  const unpriced = unpricedModelsNote(totals.unpricedModels)
  if (unpriced) notes.push(unpriced)
  const excluded = excludedCurrenciesNote(totals.excludedCurrencies)
  if (excluded) notes.push(excluded)
  return notes
}

export function seriesMetricValue(point: AnalyticsSeriesPoint, metric: AnalyticsMetric): number | null {
  if (metric === 'tokens') return finiteOrNull(point.tokens.total)
  if (metric === 'cost') return finiteOrNull(point.cost.amountMinor)
  if (metric === 'time') return finiteOrNull(point.runTimeMs)
  return finiteOrNull(point.runs)
}

export function seriesMetricExact(point: AnalyticsSeriesPoint, metric: AnalyticsMetric): string {
  if (metric === 'tokens') return formatBoundNumber(finiteOrNull(point.tokens.total), point.cost.lowerBound)
  if (metric === 'cost') return formatBoundMoney(finiteOrNull(point.cost.amountMinor), point.cost.currency, point.cost.lowerBound)
  if (metric === 'time') return formatRunTime(finiteOrNull(point.runTimeMs))
  return formatExactNumber(finiteOrNull(point.runs))
}

function finiteOrNull(value: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

export function barAccessibleName(label: string, value: number | null, exact: string): string {
  if (value === null) return `${label}, no data`
  return `${label}, ${exact}`
}

export interface ChartBarModel {
  bucketStart: string
  label: string
  value: number | null
  exact: string
  name: string
  gap: boolean
}

export function chartBars(series: readonly AnalyticsSeriesPoint[], metric: AnalyticsMetric, bucket: AnalyticsBucket, timeZone: string): ChartBarModel[] {
  return series.map((point) => {
    const value = seriesMetricValue(point, metric)
    const exact = seriesMetricExact(point, metric)
    const label = formatBucketLabel(point.bucketStart, bucket, timeZone)
    return {
      bucketStart: point.bucketStart,
      label,
      value,
      exact,
      gap: value === null,
      name: barAccessibleName(label, value, exact),
    }
  })
}

export function chartSummary(bars: readonly ChartBarModel[], metric: AnalyticsMetric, bucket: AnalyticsBucket): string {
  const metricLabel = metric === 'tokens' ? 'Tokens' : metric === 'cost' ? 'Cost' : metric === 'time' ? 'Time' : 'Runs'
  const cadence = bucket === 'week' ? 'Weekly' : 'Daily'
  const gaps = bars.filter((bar) => bar.gap).length
  const known = bars.filter((bar) => bar.value !== null)
  if (!known.length) return `${cadence} ${metricLabel}. No data in this range.`
  const top = known.reduce((best, bar) => (bar.value ?? -Infinity) > (best.value ?? -Infinity) ? bar : best)
  const gapText = gaps === 0 ? '' : gaps === 1 ? ' 1 bucket has no data.' : ` ${gaps} buckets have no data.`
  return `${cadence} ${metricLabel}. Highest ${top.exact} on ${top.label}.${gapText}`
}

export interface ChartRectModel extends ChartBarModel {
  x: number
  y: number
  width: number
  height: number
}

export function chartRects(bars: readonly ChartBarModel[], width = 640, height = 160): ChartRectModel[] {
  if (!bars.length) return []
  const slot = width / bars.length
  const barWidth = Math.max(2, slot * 0.62)
  const peak = bars.reduce((max, bar) => bar.value !== null && bar.value > max ? bar.value : max, 0)
  const plot = height - 8
  return bars.map((bar, index) => {
    const x = index * slot + (slot - barWidth) / 2
    if (bar.value === null) {
      const gapHeight = 8
      return { ...bar, x, y: height - gapHeight, width: barWidth, height: gapHeight }
    }
    const ratio = peak > 0 ? bar.value / peak : 0
    const barHeight = bar.value === 0 ? 2 : Math.max(2, ratio * plot)
    return { ...bar, x, y: height - barHeight, width: barWidth, height: barHeight }
  })
}

export function leaderboardName(row: { agentId: string | null; agentName: string | null }): string {
  if (row.agentId === null) return 'Unassigned sessions'
  const name = row.agentName?.trim()
  return name ? name : 'Blob'
}

export function leaderboardFractions(costs: readonly (number | null)[]): Array<number | null> {
  const peak = costs.reduce<number>((max, value) => value !== null && value > max ? value : max, 0)
  return costs.map((value) => {
    if (value === null) return null
    if (peak <= 0) return 0
    return value / peak
  })
}

/** Shown only when `cancelledRuns` was sent. A missing count is not rendered as 0. */
export function formatCancelledCount(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
  return `${formatted} cancelled`
}

export function formatUpdatedClock(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) return 'Unknown time'
  const format = (zone: string) => new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant)
  try {
    return format(timeZone)
  } catch {
    try { return format('UTC') } catch { return 'Unknown time' }
  }
}

export const ANALYTICS_STORAGE_KEY = 'bloblex.analytics.view'

export interface AnalyticsViewPrefs {
  days: AnalyticsRangeDays
  bucket: AnalyticsBucket
  metric: AnalyticsMetric
  panel: 'overview' | 'errors'
  projectKey: string
}

export const DEFAULT_ANALYTICS_PREFS: AnalyticsViewPrefs = {
  days: 7,
  bucket: 'day',
  metric: 'tokens',
  panel: 'overview',
  projectKey: '',
}

export function readAnalyticsPrefs(): AnalyticsViewPrefs {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_ANALYTICS_PREFS }
    const raw = localStorage.getItem(ANALYTICS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_ANALYTICS_PREFS }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_ANALYTICS_PREFS }
    const row = parsed as Record<string, unknown>
    const days: AnalyticsRangeDays = row.days === 30 || row.days === 90 || row.days === 7 ? row.days : 7
    const metric: AnalyticsMetric = row.metric === 'cost' || row.metric === 'time' || row.metric === 'runs' || row.metric === 'tokens' ? row.metric : 'tokens'
    return {
      days,
      bucket: row.bucket === 'week' ? 'week' : 'day',
      metric,
      panel: row.panel === 'errors' ? 'errors' : 'overview',
      projectKey: typeof row.projectKey === 'string' ? row.projectKey : '',
    }
  } catch {
    return { ...DEFAULT_ANALYTICS_PREFS }
  }
}

export function writeAnalyticsPrefs(prefs: AnalyticsViewPrefs): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify({
      days: prefs.days,
      bucket: prefs.bucket,
      metric: prefs.metric,
      panel: prefs.panel,
      projectKey: prefs.projectKey,
    }))
  } catch {
    /* storage can be disabled, full, or blocked */
  }
}

export const FAILURE_CLASS_ORDER = ['provider', 'permission', 'cancelled', 'timeout', 'budget', 'config', 'other'] as const
export type FailureClassId = (typeof FAILURE_CLASS_ORDER)[number]

const FAILURE_CLASS_LABEL: Record<FailureClassId, string> = {
  provider: 'Provider error',
  permission: 'Permission denied',
  cancelled: 'Cancelled',
  timeout: 'Timeout',
  budget: 'Budget stop',
  config: 'Config/unsupported',
  other: 'Other',
}

export function normalizeFailureClass(value: string | undefined): FailureClassId {
  const text = value?.trim().toLowerCase() ?? ''
  return (FAILURE_CLASS_ORDER as readonly string[]).includes(text) ? text as FailureClassId : 'other'
}

export function failureClassLabel(value: string | undefined): string {
  return FAILURE_CLASS_LABEL[normalizeFailureClass(value)]
}

export interface FailureMixSegment {
  id: FailureClassId
  label: string
  count: number
}

export function failureMix(errors: readonly { failureClass?: string }[]): FailureMixSegment[] {
  const counts = new Map<FailureClassId, number>(FAILURE_CLASS_ORDER.map((id) => [id, 0]))
  for (const error of errors) {
    const raw = error.failureClass?.trim() ?? ''
    const id = raw ? normalizeFailureClass(raw) : 'other'
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return FAILURE_CLASS_ORDER.map((id) => ({ id, label: FAILURE_CLASS_LABEL[id], count: counts.get(id) ?? 0 }))
}

export function failureMixSummary(segments: readonly FailureMixSegment[]): string {
  const parts = segments.map((segment) => `${segment.label} ${formatExactNumber(segment.count)}`)
  return `Failure classes. ${parts.join(', ')}.`
}

export interface AgentIdentity {
  id: string
  name?: string
  archived?: boolean
}

/** Null ids stay unassigned. Archived ids and ids missing from the roster fold to Other. */
export function analyticsAgentKey(agentId: string | null, agents: readonly AgentIdentity[]): string {
  if (!agentId) return 'unassigned'
  const agent = agents.find((item) => item.id === agentId)
  if (!agent || agent.archived) return 'other'
  return agentId
}

export interface LeaderboardViewRow {
  key: string
  name: string
  kind: 'agent' | 'unassigned' | 'other'
  agentId: string | null
  tokens: AnalyticsTokens
  tokensLowerBound: boolean
  cost: AnalyticsCost
  runTimeMs: number
  runs: number
  failedRuns: number
  cancelledRuns?: number
  unreportedRuns: number
  unpricedModels: string[]
}

function sumNullable(values: readonly (number | null)[]): { value: number | null; partial: boolean } {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (!known.length) return { value: null, partial: false }
  return { value: known.reduce((sum, value) => sum + value, 0), partial: known.length !== values.length }
}

function mergeTokens(rows: readonly AnalyticsTokens[]): { tokens: AnalyticsTokens; partial: boolean } {
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'] as const
  const tokens: AnalyticsTokens = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null }
  let partial = false
  for (const key of keys) {
    const summed = sumNullable(rows.map((row) => row[key]))
    tokens[key] = summed.value
    partial = partial || summed.partial
  }
  return { tokens, partial }
}

function mergeCost(rows: readonly AnalyticsCost[]): AnalyticsCost {
  const currencies = [...new Set(rows.map((row) => row.currency).filter((currency) => currency.trim()))]
  const mixed = currencies.length > 1
  const currency = currencies.length === 1 ? currencies[0] ?? '' : ''
  const amount = sumNullable(rows.map((row) => row.amountMinor))
  const actual = sumNullable(rows.map((row) => row.actualMinor))
  const estimated = sumNullable(rows.map((row) => row.estimatedMinor))
  const partial = !mixed && (amount.partial || actual.partial || estimated.partial)
  return {
    amountMinor: mixed ? null : amount.value,
    currency,
    actualMinor: mixed ? null : actual.value,
    estimatedMinor: mixed ? null : estimated.value,
    lowerBound: mixed || partial || rows.some((row) => row.lowerBound),
  }
}

function mergeCancelled(rows: readonly AnalyticsLeaderboardRow[]): number | undefined {
  if (rows.some((row) => typeof row.cancelledRuns !== 'number' || !Number.isFinite(row.cancelledRuns))) return undefined
  return rows.reduce((sum, row) => sum + (row.cancelledRuns ?? 0), 0)
}

function leaderboardIdentity(key: string, group: readonly AnalyticsLeaderboardRow[], agents: readonly AgentIdentity[]): { name: string; kind: LeaderboardViewRow['kind']; agentId: string | null } {
  if (key === 'other') return { name: 'Other', kind: 'other', agentId: null }
  if (key === 'unassigned') return { name: 'Unassigned sessions', kind: 'unassigned', agentId: null }
  const agent = agents.find((item) => item.id === key)
  const named = agent?.name?.trim() || group.find((row) => row.agentName?.trim())?.agentName?.trim() || 'Blob'
  return { name: named, kind: 'agent', agentId: key }
}

function mergeLeaderboardGroup(key: string, group: readonly AnalyticsLeaderboardRow[], agents: readonly AgentIdentity[]): LeaderboardViewRow {
  const identity = leaderboardIdentity(key, group, agents)
  if (group.length === 1 && key !== 'other') {
    const row = group[0]
    if (row) return {
      key,
      name: identity.name,
      kind: identity.kind,
      agentId: identity.agentId,
      tokens: row.tokens,
      tokensLowerBound: row.cost.lowerBound,
      cost: row.cost,
      runTimeMs: row.runTimeMs,
      runs: row.runs,
      failedRuns: row.failedRuns,
      ...(typeof row.cancelledRuns === 'number' ? { cancelledRuns: row.cancelledRuns } : {}),
      unreportedRuns: row.unreportedRuns,
      unpricedModels: [...row.unpricedModels],
    }
  }
  const tokens = mergeTokens(group.map((row) => row.tokens))
  const cost = mergeCost(group.map((row) => row.cost))
  const cancelledRuns = mergeCancelled(group)
  const unpricedModels = [...new Set(group.flatMap((row) => row.unpricedModels))]
  return {
    key,
    name: identity.name,
    kind: identity.kind,
    agentId: identity.agentId,
    tokens: tokens.tokens,
    tokensLowerBound: cost.lowerBound || tokens.partial,
    cost,
    runTimeMs: group.reduce((sum, row) => sum + row.runTimeMs, 0),
    runs: group.reduce((sum, row) => sum + row.runs, 0),
    failedRuns: group.reduce((sum, row) => sum + row.failedRuns, 0),
    ...(cancelledRuns === undefined ? {} : { cancelledRuns }),
    unreportedRuns: group.reduce((sum, row) => sum + row.unreportedRuns, 0),
    unpricedModels,
  }
}

function compareLeaderboard(left: LeaderboardViewRow, right: LeaderboardViewRow): number {
  const leftMissing = left.cost.amountMinor === null
  const rightMissing = right.cost.amountMinor === null
  if (leftMissing !== rightMissing) return leftMissing ? 1 : -1
  if (!leftMissing && !rightMissing && left.cost.amountMinor !== right.cost.amountMinor) {
    return (right.cost.amountMinor ?? 0) - (left.cost.amountMinor ?? 0)
  }
  return right.runs - left.runs || left.name.localeCompare(right.name)
}

export function foldLeaderboard(rows: readonly AnalyticsLeaderboardRow[], agents: readonly AgentIdentity[]): LeaderboardViewRow[] {
  const groups = new Map<string, AnalyticsLeaderboardRow[]>()
  for (const row of rows) {
    const key = analyticsAgentKey(row.agentId, agents)
    const existing = groups.get(key)
    if (existing) existing.push(row)
    else groups.set(key, [row])
  }
  return [...groups.entries()]
    .map(([key, group]) => mergeLeaderboardGroup(key, group, agents))
    .sort(compareLeaderboard)
}

export const OFFENDER_RATE_MIN_RUNS = 5

export interface OffenderModel {
  key: string
  name: string
  count: number
  runs: number | null
  rate: number | null
}

export function rankOffenders(
  errors: readonly { agentId: string | null }[],
  leaderboard: readonly LeaderboardViewRow[],
  agents: readonly AgentIdentity[],
): OffenderModel[] {
  const counts = new Map<string, number>()
  for (const error of errors) {
    const key = analyticsAgentKey(error.agentId, agents)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].map(([key, count]) => {
    const board = leaderboard.find((row) => row.key === key)
    const runs = board ? board.runs : null
    const rate = runs !== null && runs >= OFFENDER_RATE_MIN_RUNS ? count / runs : null
    const name = board?.name ?? (key === 'unassigned' ? 'Unassigned sessions' : key === 'other' ? 'Other' : 'Blob')
    return { key, name, count, runs, rate }
  }).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}

export function offenderRateLabel(offender: Pick<OffenderModel, 'rate' | 'runs'>): string {
  if (offender.rate === null || offender.runs === null || offender.runs < OFFENDER_RATE_MIN_RUNS) {
    return `Rate needs at least ${OFFENDER_RATE_MIN_RUNS} runs`
  }
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(offender.rate)
}

export function isEmptyAnalytics(data: UsageAnalytics): boolean {
  const cancelled = typeof data.totals.cancelledRuns === 'number' ? data.totals.cancelledRuns : 0
  return data.totals.runs === 0 && data.totals.activeRuns === 0 && data.totals.failedRuns === 0 && cancelled === 0 && data.leaderboard.length === 0 && data.errors.length === 0
}

export function analyticsErrorText(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  const code = text.includes(': ') ? text.slice(0, text.indexOf(': ')) : ''
  if (code === 'invalid_argument') return 'That date range cannot be loaded.'
  if (code === 'not_found') return 'That blob is no longer available.'
  if (code === 'internal') return 'Usage analytics could not be loaded.'
  if (text.trim()) return 'Usage analytics could not be loaded.'
  return 'Usage analytics could not be loaded.'
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function optionalCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function cancelledField(value: unknown): { cancelledRuns: number } | Record<string, never> {
  const cancelledRuns = optionalCount(value)
  return cancelledRuns === undefined ? {} : { cancelledRuns }
}

function safeReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.startsWith('{') || text.startsWith('[')) return null
  return text.slice(0, 240)
}

function readFailureClass(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.startsWith('{') || text.startsWith('[')) return undefined
  return text.slice(0, 64)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function readCost(value: unknown): AnalyticsCost | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const currency = typeof row.currency === 'string' ? row.currency : ''
  return {
    amountMinor: numberOrNull(row.amountMinor),
    currency,
    actualMinor: numberOrNull(row.actualMinor),
    estimatedMinor: numberOrNull(row.estimatedMinor),
    lowerBound: row.lowerBound === true,
  }
}

function readTokens(value: unknown): AnalyticsTokens | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  return {
    input: numberOrNull(row.input),
    output: numberOrNull(row.output),
    cacheRead: numberOrNull(row.cacheRead),
    cacheWrite: numberOrNull(row.cacheWrite),
    reasoning: numberOrNull(row.reasoning),
    total: numberOrNull(row.total),
  }
}

const EMPTY_TOKENS: AnalyticsTokens = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null }

/** Copies the contract fields only, so a daemon row cannot leak prompt text or raw provider JSON into the view. */
export function normalizeAnalytics(value: unknown): UsageAnalytics | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const range = row.range
  const totals = row.totals
  if (!range || typeof range !== 'object' || Array.isArray(range)) return null
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)) return null
  const rangeRow = range as Record<string, unknown>
  const totalsRow = totals as Record<string, unknown>
  const bucket = rangeRow.bucket === 'week' ? 'week' : rangeRow.bucket === 'day' ? 'day' : null
  if (!bucket || typeof rangeRow.from !== 'string' || typeof rangeRow.to !== 'string' || typeof rangeRow.tz !== 'string') return null
  const cost = readCost(totalsRow.cost)
  const tokens = readTokens(totalsRow.tokens)
  if (!cost || !tokens) return null
  const series = Array.isArray(row.series) ? row.series.flatMap((point) => {
    if (!point || typeof point !== 'object' || Array.isArray(point)) return []
    const item = point as Record<string, unknown>
    const pointCost = readCost(item.cost)
    const pointTokens = readTokens(item.tokens)
    if (typeof item.bucketStart !== 'string' || !pointCost || !pointTokens) return []
    return [{
      bucketStart: item.bucketStart,
      cost: pointCost,
      tokens: pointTokens,
      runTimeMs: numberOrNull(item.runTimeMs) ?? 0,
      runs: numberOrNull(item.runs) ?? 0,
      failedRuns: numberOrNull(item.failedRuns) ?? 0,
      ...cancelledField(item.cancelledRuns),
    }]
  }) : []
  const leaderboard = Array.isArray(row.leaderboard) ? row.leaderboard.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const item = entry as Record<string, unknown>
    const rowCost = readCost(item.cost)
    const rowTokens = readTokens(item.tokens) ?? EMPTY_TOKENS
    if (!rowCost || typeof item.runtimeId !== 'string') return []
    const agentId = typeof item.agentId === 'string' ? item.agentId : null
    const agentName = typeof item.agentName === 'string' ? item.agentName : null
    return [{
      agentId,
      agentName,
      runtimeId: item.runtimeId,
      tokens: rowTokens,
      cost: rowCost,
      runTimeMs: numberOrNull(item.runTimeMs) ?? 0,
      runs: numberOrNull(item.runs) ?? 0,
      failedRuns: numberOrNull(item.failedRuns) ?? 0,
      ...cancelledField(item.cancelledRuns),
      unreportedRuns: numberOrNull(item.unreportedRuns) ?? 0,
      unpricedModels: stringList(item.unpricedModels),
    }]
  }) : []
  const errors = Array.isArray(row.errors) ? row.errors.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const item = entry as Record<string, unknown>
    if (typeof item.turnId !== 'string' || typeof item.sessionId !== 'string' || typeof item.at !== 'string') return []
    const message = safeReason(item.message) ?? safeReason(item.reason) ?? 'The run failed.'
    const failureClass = readFailureClass(item.failureClass)
    return [{
      turnId: item.turnId,
      sessionId: item.sessionId,
      agentId: typeof item.agentId === 'string' ? item.agentId : null,
      at: item.at,
      message,
      ...(failureClass ? { failureClass } : {}),
    }]
  }).slice(0, 50) : []
  const subscriptions = Array.isArray(row.subscriptions) ? row.subscriptions.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const item = entry as Record<string, unknown>
    if (typeof item.provider !== 'string' || typeof item.currency !== 'string') return []
    const monthlyMinor = numberOrNull(item.monthlyMinor)
    if (monthlyMinor === null) return []
    return [{
      provider: item.provider,
      monthlyMinor,
      currency: item.currency,
      quotaState: typeof item.quotaState === 'string' ? item.quotaState : 'unknown',
    }]
  }) : []
  return {
    range: { from: rangeRow.from, to: rangeRow.to, bucket, tz: rangeRow.tz },
    totals: {
      cost,
      tokens,
      runTimeMs: numberOrNull(totalsRow.runTimeMs) ?? 0,
      runs: numberOrNull(totalsRow.runs) ?? 0,
      failedRuns: numberOrNull(totalsRow.failedRuns) ?? 0,
      ...cancelledField(totalsRow.cancelledRuns),
      activeRuns: numberOrNull(totalsRow.activeRuns) ?? 0,
      unreportedRuns: numberOrNull(totalsRow.unreportedRuns) ?? 0,
      unpricedModels: stringList(totalsRow.unpricedModels),
      excludedCurrencies: stringList(totalsRow.excludedCurrencies),
    },
    series,
    leaderboard,
    errors,
    subscriptions,
  }
}
