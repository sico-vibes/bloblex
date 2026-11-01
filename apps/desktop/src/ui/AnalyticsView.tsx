import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { Agent, Session } from '../types'
import type { AnalyticsBucket, AnalyticsErrorRow, AnalyticsMetric, AnalyticsRangeDays, UsageAnalytics } from '../analyticsTypes'
import { agentColorHex } from './agentColor'
import { fetchUsageAnalytics, previewMode } from '../tauri'
import {
  type AnalyticsViewPrefs,
  type LeaderboardViewRow,
  analyticsAgentKey,
  analyticsErrorText,
  buildAnalyticsRequest,
  chartBars,
  chartRects,
  chartSummary,
  type ChartBarModel,
  failureClassLabel,
  normalizeFailureClass,
  failureMix,
  failureMixSummary,
  foldLeaderboard,
  formatBoundNumber,
  formatCancelledCount,
  formatExactNumber,
  formatInstant,
  formatRunTime,
  formatUpdatedClock,
  leaderboardFractions,
  offenderRateLabel,
  rankOffenders,
  readAnalyticsPrefs,
  unreportedRunsNote,
  writeAnalyticsPrefs,
  normalizeAnalytics,
} from './analyticsFormat'
import { analyticsProjectChoices } from './rosterSelectors'
import './analytics.css'
import { Select } from './Select'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { quotaProviderName, quotaRows, type QuotaProviderRow } from './quotaModel'
import { ProviderLimits } from './QuotaBar'
import { entityNoun, useEntityNoun } from './vocabulary'
import { themeStyle } from '../blob/bitbots'

const RANGES: AnalyticsRangeDays[] = [7, 30, 90]
const PANELS = ['overview', 'errors'] as const

export function AnalyticsView({ agentId = null, sessions, agents, quotas = [], connected, embedded = false, onBack, onRefreshQuota, onTurnOnUsage, now, timeZone }: {
  agentId?: string | null
  sessions: readonly Session[]
  agents: readonly Agent[]
  quotas?: Record<string, unknown>[]
  connected: boolean
  embedded?: boolean
  onBack?: () => void
  onRefreshQuota?: () => void
  /** Opens the setting that lets Bitbots read a provider's usage. */
  onTurnOnUsage?: () => void
  now?: Date
  timeZone?: string
}) {
  const [initial] = useState(() => {
    const prefs = readAnalyticsPrefs()
    return previewMode && new URLSearchParams(location.search).has('preview-usage') ? { ...prefs, panel:'overview' as const } : prefs
  })
  const [days, setDays] = useState<AnalyticsRangeDays>(initial.days)
  const [bucket, setBucket] = useState<AnalyticsBucket>(initial.bucket)
  const [projectChoice, setProjectChoice] = useState(initial.projectKey)
  const [metric, setMetric] = useState<AnalyticsMetric>(initial.metric)
  const [panel, setPanel] = useState<AnalyticsViewPrefs['panel']>(initial.panel)
  const [retry, setRetry] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [data, setData] = useState<UsageAnalytics | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const projects = useMemo(() => analyticsProjectChoices(sessions), [sessions])
  const projectPath = projects.find((option) => option.key === projectChoice)?.path ?? ''

  useEffect(() => {
    if (!projectChoice) return
    if (projects.some((option) => option.key === projectChoice)) return
    setProjectChoice('')
  }, [projects, projectChoice])

  useEffect(() => {
    writeAnalyticsPrefs({ days, bucket, metric, panel, projectKey: projectChoice })
  }, [days, bucket, metric, panel, projectChoice])

  useEffect(() => {
    if (!connected) return
    let active = true
    const request = buildAnalyticsRequest({ days, bucket, now, timeZone, projectPath, agentId })
    setPhase('loading')
    setLoadError(null)
    setData(null)
    fetchUsageAnalytics(request).then((raw) => {
      if (!active) return
      const parsed = normalizeAnalytics(raw)
      if (!parsed) {
        setData(null)
        setPhase('error')
        setLoadError('Usage analytics could not be loaded.')
        return
      }
      setData(parsed)
      setUpdatedAt(now ? new Date(now) : new Date())
      setPhase('ready')
    }).catch((reason: unknown) => {
      if (!active) return
      setData(null)
      setPhase('error')
      setLoadError(analyticsErrorText(reason))
    })
    return () => { active = false }
  }, [connected, days, bucket, projectPath, agentId, now, timeZone, retry])

  const clock = updatedAt && data ? formatUpdatedClock(updatedAt, data.range.tz) : null
  const refreshLabel = clock && data ? `Refresh. Updated ${clock}, times in ${data.range.tz}` : 'Refresh usage and provider quotas'
  const controls = connected && <div className="analytics-controls">
    <div className="analytics-switch" role="group" aria-label="Date range">
      {RANGES.map((value) => <button key={value} type="button" aria-pressed={days === value} onClick={() => setDays(value)}>{value} days</button>)}
    </div>
    <Select ariaLabel="Project" variant="muted" value={projectPath ? projectChoice : ''} onChange={setProjectChoice} options={[{ value: '', label: 'All projects' }, ...projects.map((option) => ({ value: option.key, label: option.label }))]} />
    {phase === 'ready' && <button type="button" className="analytics-icon-button" aria-label={refreshLabel} title={refreshLabel} onClick={() => { setRetry((value) => value + 1); onRefreshQuota?.() }}><RefreshCw size={14} /></button>}
  </div>
  return <Frame embedded={embedded} onBack={onBack} actions={controls}>
    {!connected ? <p className="blob-muted analytics-status" role="status">Connect to the local runtime to load usage.</p> : <>
      {phase === 'loading' && <AnalyticsSkeleton />}
      {phase === 'error' && <AnalyticsTabs panel={panel} onPanel={setPanel}>
        <div className="blob-card" role="alert" data-analytics-error={panel}>
          <h3>Usage analytics unavailable</h3>
          <p className="blob-muted">{loadError}</p>
          <button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>Try again</button>
        </div>
      </AnalyticsTabs>}
      {data && phase === 'ready' && <AnalyticsBody data={data} agents={agents} quotas={quotas} metric={metric} bucket={bucket} panel={panel} onMetric={setMetric} onBucket={setBucket} onPanel={setPanel} onTurnOnUsage={onTurnOnUsage} />}
    </>}
  </Frame>
}

function AnalyticsSkeleton() {
  return <div className="analytics-skeleton" data-analytics-skeleton="true" role="status" aria-busy="true" aria-label="Loading analytics">
    <span className="sr-only">Loading analytics…</span>
    <div className="analytics-skeleton-line" />
    <div className="analytics-cards" aria-hidden="true">
      <div className="analytics-skeleton-block" />
      <div className="analytics-skeleton-block" />
      <div className="analytics-skeleton-block" />
    </div>
    <div className="analytics-skeleton-chart" />
  </div>
}

const LIMIT_PROVIDERS = ['claude', 'codex', 'opencode']

/** Every provider's limits side by side: the same rows as the Usage panel. A provider that reported nothing still gets its place. */
function PlanLimits({ quotas, onTurnOn }: { quotas: Record<string, unknown>[]; onTurnOn?: () => void }) {
  const parsed = quotaRows(quotas)
  const rows = LIMIT_PROVIDERS.map((provider): QuotaProviderRow => parsed.find((row) => row.provider === provider) ?? { provider, name: quotaProviderName(provider), windows: [], status: 'Unavailable', stale: false, readOff: false, fetchedAt: null })
  return <section className="analytics-limits" aria-labelledby="analytics-limits-heading">
    <h3 id="analytics-limits-heading">Plan limits</h3>
    <div className="analytics-limits-grid">{rows.map((row) => <ProviderLimits key={row.provider} row={row} onTurnOn={onTurnOn} />)}</div>
  </section>
}

function Frame({ embedded, onBack, actions, children }: { embedded: boolean; onBack?: () => void; actions?: ReactNode; children: ReactNode }) {
  const backRef = useRef<HTMLButtonElement>(null)
  // Focus lands here for the keyboard without drawing a ring on arrival.
  useEffect(() => { if (!embedded) backRef.current?.focus({ focusVisible: false } as FocusOptions) }, [embedded])
  if (embedded) return <div className="analytics-embedded" data-analytics-root="embedded">{actions}{children}</div>
  return <div className="analytics-page" data-analytics-root="page">
    <header className="blob-page-header">
      <button ref={backRef} type="button" className="analytics-icon-button" aria-label="Back" title="Back" onClick={onBack}><ArrowLeft size={16} /></button>
      <strong className="blob-page-heading">Usage</strong>
      {actions}
    </header>
    <div className="analytics-scroll"><div className="analytics-column">{children}</div></div>
  </div>
}

function moveTab(event: KeyboardEvent<HTMLButtonElement>, current: AnalyticsViewPrefs['panel'], onPanel: (panel: AnalyticsViewPrefs['panel']) => void) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = PANELS.indexOf(current)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? PANELS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : PANELS.length - 1)) % PANELS.length
  const target = PANELS[next] ?? 'overview'
  onPanel(target)
  document.getElementById(`analytics-tab-${target}`)?.focus()
}

function AnalyticsTabs({ panel, onPanel, children }: { panel: AnalyticsViewPrefs['panel']; onPanel: (panel: AnalyticsViewPrefs['panel']) => void; children: ReactNode }) {
  const noun = useEntityNoun()
  return <>
    <div className="blob-tabs" role="tablist" aria-label="Analytics sections">
      <button type="button" id="analytics-tab-overview" role="tab" aria-selected={panel === 'overview'} aria-controls="analytics-panel-overview" tabIndex={panel === 'overview' ? 0 : -1} onClick={() => onPanel('overview')} onKeyDown={(event) => moveTab(event, panel, onPanel)}>{`By ${noun}`}</button>
      <button type="button" id="analytics-tab-errors" role="tab" aria-selected={panel === 'errors'} aria-controls="analytics-panel-errors" tabIndex={panel === 'errors' ? 0 : -1} onClick={() => onPanel('errors')} onKeyDown={(event) => moveTab(event, panel, onPanel)}>Failures</button>
    </div>
    <div id={panel === 'overview' ? 'analytics-panel-overview' : 'analytics-panel-errors'} role="tabpanel" aria-labelledby={panel === 'overview' ? 'analytics-tab-overview' : 'analytics-tab-errors'}>
      {children}
    </div>
  </>
}

/** The bars, with dates along the bottom, and the value of whichever bar the pointer is over. */
function UsageChart({ bars, summary }: { bars: readonly ChartBarModel[]; summary: string }) {
  const rects = chartRects(bars, CHART_WIDTH, CHART_HEIGHT)
  const [hover, setHover] = useState<number | null>(null)
  const peak = bars.reduce<ChartBarModel | null>((best, bar) => bar.value !== null && (!best || bar.value > (best.value ?? 0)) ? bar : best, null)
  const shown = hover === null ? null : rects[hover]
  const every = Math.max(1, Math.ceil(bars.length / 8))
  const pointAt = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width) setHover(Math.max(0, Math.min(rects.length - 1, Math.floor((event.clientX - box.left) / box.width * rects.length))))
  }
  return <div className="analytics-plot">
    {peak && (peak.value ?? 0) > 0 && <span className="analytics-peak">{peak.exact}</span>}
    <div className="analytics-plot-area" onMouseMove={pointAt} onMouseLeave={() => setHover(null)}>
      <svg className="analytics-chart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="group" aria-label={summary}>
        <line className="analytics-rule" x1="0" y1="0.5" x2={CHART_WIDTH} y2="0.5" />
        <line x1="0" y1={CHART_HEIGHT - 0.5} x2={CHART_WIDTH} y2={CHART_HEIGHT - 0.5} />
        {rects.map((rect, index) => <rect key={rect.bucketStart} x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="3" className={`${rect.gap ? 'analytics-gap' : rect.value === 0 ? 'analytics-zero' : 'analytics-bar'}${hover === index ? ' is-hover' : ''}`} tabIndex={0} focusable="true" role="img" aria-label={rect.name} data-value={rect.value === null ? 'null' : String(rect.value)} data-gap={rect.gap ? 'true' : 'false'} data-bucket-start={rect.bucketStart} onFocus={() => setHover(index)} onBlur={() => setHover(null)} />)}
      </svg>
      {shown && <div className="analytics-tip" role="status" style={{ left: `${(shown.x + shown.width / 2) / CHART_WIDTH * 100}%` }}><span>{shown.label}</span><b>{shown.gap ? 'No data' : shown.exact}</b></div>}
    </div>
    <div className="analytics-axis" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}>{bars.map((bar, index) => <span key={bar.bucketStart}>{index % every === 0 ? bar.label : ''}</span>)}</div>
  </div>
}

const CHART_WIDTH = 960
const CHART_HEIGHT = 180

function AnalyticsBody({ data, agents, quotas, metric, bucket, panel, onMetric, onBucket, onPanel, onTurnOnUsage }: {
  data: UsageAnalytics
  agents: readonly Agent[]
  quotas: Record<string, unknown>[]
  metric: AnalyticsMetric
  bucket: AnalyticsBucket
  panel: AnalyticsViewPrefs['panel']
  onMetric: (metric: AnalyticsMetric) => void
  onBucket: (bucket: AnalyticsBucket) => void
  onPanel: (panel: AnalyticsViewPrefs['panel']) => void
  onTurnOnUsage?: () => void
}) {
  const nouns = useEntityNoun({ plural: true })
  const bars = chartBars(data.series, metric, data.range.bucket, data.range.tz)
  const summary = chartSummary(bars, metric, data.range.bucket)
  const leaderboard = useMemo(() => foldLeaderboard(data.leaderboard, agents), [data.leaderboard, agents])
  const fractions = leaderboardFractions(leaderboard.map((row) => row.tokens.total))
  const tokenTotal = formatBoundNumber(data.totals.tokens.total, data.totals.unreportedRuns > 0)
  const runsDetail = [
    data.totals.failedRuns ? `${formatExactNumber(data.totals.failedRuns)} failed` : null,
    formatCancelledCount(data.totals.cancelledRuns),
    data.totals.activeRuns > 0 ? `${formatExactNumber(data.totals.activeRuns)} active` : null,
  ].filter((part): part is string => !!part).join(' · ')
  const metricNoun = metric === 'tokens' ? 'token' : metric === 'time' ? 'time' : 'run'
  const metricEmpty = bars.length > 0 && bars.every((bar) => bar.gap)
  const tile = (id: AnalyticsMetric, card: string, label: string, figure: string, detail?: string) => <button type="button" className="analytics-card" data-analytics-card={card} aria-pressed={metric === id} onClick={() => onMetric(id)}><span className="analytics-card-label">{label}</span><strong data-figure>{figure}</strong>{detail && <small>{detail}</small>}</button>
  const tokens = data.totals.tokens
  return <>
    <PlanLimits quotas={quotas} onTurnOn={onTurnOnUsage} />
    <section className="analytics-activity" aria-label="Activity">
      <div className="analytics-cards" role="group" aria-label="Chart metric">
        {tile('tokens', 'tokens', 'Tokens', tokenTotal)}
        {tile('time', 'runtime', 'Run time', formatRunTime(data.totals.runTimeMs))}
        {tile('runs', 'runs', 'Runs', formatExactNumber(data.totals.runs), runsDetail)}
      </div>
      <div className="analytics-chart-block">
        <div className="analytics-chart-head">
          {metric === 'tokens' && !metricEmpty
            ? <p className="analytics-breakdown" data-analytics-breakdown>Input {formatExactNumber(tokens.input)} · Output {formatExactNumber(tokens.output)} · Cache read {formatExactNumber(tokens.cacheRead)} · Cache write {formatExactNumber(tokens.cacheWrite)} · Reasoning {formatExactNumber(tokens.reasoning)}</p>
            : <span />}
          <div className="analytics-switch" role="group" aria-label="Bucket size">
            <button type="button" aria-pressed={bucket === 'day'} onClick={() => onBucket('day')}>Daily</button>
            <button type="button" aria-pressed={bucket === 'week'} onClick={() => onBucket('week')}>Weekly</button>
          </div>
        </div>
        <p role="img" className="sr-only">{summary}</p>
        {metricEmpty && <p className="blob-muted" role="status" data-analytics-empty="metric">No {metricNoun} data in this range.</p>}
        {bars.length === 0 ? <p className="blob-muted" role="status" data-analytics-empty="chart">No buckets in this range.</p> : !metricEmpty && <UsageChart bars={bars} summary={summary} />}
      </div>
    </section>
    <AnalyticsTabs panel={panel} onPanel={onPanel}>
      {panel === 'overview' ? <div className="analytics-leader">{leaderboard.length === 0 ? <p className="blob-muted" role="status" data-analytics-empty="leaderboard">No {nouns} reported usage in this range.</p> : leaderboard.map((row, index) => {
        const fraction = fractions[index] ?? null
        const agent = row.kind === 'agent' && row.agentId ? agents.find((item) => item.id === row.agentId) : undefined
        const color = agent ? agentColorHex(agent.color) : ''
        const tokenText = formatBoundNumber(row.tokens.total, row.tokensLowerBound)
        const detail = `${tokenText} tokens · ${formatExactNumber(row.runs)} runs · ${formatExactNumber(row.failedRuns)} failed`
        const missing = unreportedRunsNote(row.unreportedRuns)
        return <div className="analytics-leader-row" key={row.key} data-agent-id={row.agentId ?? (row.kind === 'other' ? 'other' : 'null')} data-leader-kind={row.kind} role="group" aria-label={`${row.name}. ${detail}${missing ? `. ${missing}` : ''}`}><span className="analytics-leader-identity">{agent && <BlobCanvas color={color} size={20} mood="idle" mini decorative label={agent.name} look={agentLook(agent)} />}<strong>{row.name}</strong></span><div className="analytics-leader-track" role="img" aria-label={`${row.name} bar, ${tokenText} tokens`} data-fraction={fraction === null ? 'null' : String(fraction)}>{fraction !== null && <div className="analytics-leader-fill" style={{ width: `${fraction * 100}%` }} />}</div><span className="analytics-leader-detail">{detail}</span>{missing && <p className="analytics-leader-note" role="note">{missing}</p>}</div>
      })}</div> : <ErrorsPanel data={data} agents={agents} leaderboard={leaderboard} />}
    </AnalyticsTabs>
  </>
}

function ErrorsPanel({ data, agents, leaderboard }: { data: UsageAnalytics; agents: readonly Agent[]; leaderboard: readonly LeaderboardViewRow[] }) {
  const mix = failureMix(data.errors)
  const summary = failureMixSummary(mix)
  const offenders = rankOffenders(data.errors, leaderboard, agents)
  const [offenderKey, setOffenderKey] = useState<string | null>(null)
  const turns = offenderKey === null ? data.errors : data.errors.filter((error) => analyticsAgentKey(error.agentId, agents) === offenderKey)
  const peak = offenders.reduce((max, offender) => Math.max(max, offender.count), 0)
  const total = mix.reduce((sum, segment) => sum + segment.count, 0)
  const noun = useEntityNoun()
  const Nouns = useEntityNoun({ plural: true, capital: true })
  if (data.errors.length === 0) return <p className="blob-muted" role="status" data-analytics-empty="errors">No failed runs in this range.</p>
  return <div className="analytics-errors-panel">
    <div className="analytics-mix-block">
      <h3>Failure classes</h3>
      <p className="sr-only">{summary}</p>
      <div className="analytics-mix" role="img" aria-label={summary} data-analytics-mix="true">
        {mix.filter((segment) => segment.count > 0).map((segment) => <span key={segment.id} data-class={segment.id} role="img" aria-label={`${segment.label} ${formatExactNumber(segment.count)}`} style={{ width: `${total > 0 ? (segment.count / total) * 100 : 0}%` }} />)}
      </div>
      <ul className="analytics-mix-legend">
        {mix.map((segment) => <li key={segment.id} data-class={segment.id}>{segment.label} {formatExactNumber(segment.count)}</li>)}
      </ul>
    </div>
    <div className="analytics-offenders">
      <h3>{Nouns} by failed runs</h3>
      <button type="button" aria-pressed={offenderKey === null} onClick={() => setOffenderKey(null)}>All failed turns</button>
      {offenders.map((offender) => {
        const rate = offenderRateLabel(offender)
        const width = peak > 0 ? (offender.count / peak) * 100 : 0
        return <button type="button" className="analytics-offender" key={offender.key} data-offender={offender.key} aria-pressed={offenderKey === offender.key} aria-label={`${offender.name}, ${formatExactNumber(offender.count)} failed, ${rate}`} onClick={() => setOffenderKey(offender.key)}>
          <span className="analytics-offender-top"><strong>{offender.name}</strong><span>{formatExactNumber(offender.count)} failed · {rate}</span></span>
          <span className="analytics-leader-track" role="img" aria-label={`${offender.name}, ${formatExactNumber(offender.count)} failed`}><span className="analytics-leader-fill" style={{ width: `${width}%` }} /></span>
        </button>
      })}
    </div>
    <div className="analytics-drill" data-analytics-turns="true">
      <h3>Failed turns</h3>
      {turns.length === 0 ? <p className="blob-muted" role="status">No failed turns for this {noun}.</p> : <ul className="analytics-errors">
        {turns.map((error) => <ErrorTurn key={error.turnId} error={error} agents={agents} timeZone={data.range.tz} />)}
      </ul>}
    </div>
  </div>
}

function errorAgentName(agentId: string | null, agents: readonly Agent[]): string {
  const key = analyticsAgentKey(agentId, agents)
  if (key === 'unassigned') return 'Unassigned sessions'
  if (key === 'other') return 'Other'
  return agents.find((agent) => agent.id === key)?.name?.trim() || entityNoun(themeStyle())
}

function ErrorTurn({ error, agents, timeZone }: { error: AnalyticsErrorRow; agents: readonly Agent[]; timeZone: string }) {
  const classLabel = error.failureClass ? failureClassLabel(error.failureClass) : null
  return <li>
    <time dateTime={error.at}>{formatInstant(error.at, timeZone)}</time>
    <small>{errorAgentName(error.agentId, agents)}</small>
    {classLabel && <small data-failure-class={normalizeFailureClass(error.failureClass)}>{classLabel}</small>}
    <p>{error.message}</p>
  </li>
}
