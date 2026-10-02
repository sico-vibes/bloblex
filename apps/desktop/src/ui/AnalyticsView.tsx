import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Agent, Session } from '../types'
import type { AnalyticsBucket, AnalyticsErrorRow, AnalyticsMetric, AnalyticsRangeDays, UsageAnalytics } from '../analyticsTypes'
import { labelize } from '../types'
import { agentColorHex } from './agentColor'
import { fetchUsageAnalytics } from '../tauri'
import {
  type AnalyticsViewPrefs,
  type LeaderboardViewRow,
  analyticsAgentKey,
  analyticsErrorText,
  analyticsNotes,
  buildAnalyticsRequest,
  chartBars,
  chartRects,
  chartSummary,
  failureClassLabel,
  normalizeFailureClass,
  failureMix,
  failureMixSummary,
  foldLeaderboard,
  formatBoundMoney,
  formatBoundNumber,
  formatCancelledCount,
  formatExactNumber,
  formatInstant,
  formatRunTime,
  formatUpdatedClock,
  isEmptyAnalytics,
  leaderboardFractions,
  offenderRateLabel,
  rankOffenders,
  readAnalyticsPrefs,
  unpricedModelsNote,
  unreportedRunsNote,
  writeAnalyticsPrefs,
  normalizeAnalytics,
} from './analyticsFormat'
import { analyticsProjectChoices } from './rosterSelectors'
import './analytics.css'
import { Select } from './Select'

const RANGES: AnalyticsRangeDays[] = [7, 30, 90]
const PANELS = ['overview', 'errors'] as const
const METRICS: Array<{ id: AnalyticsMetric; label: string }> = [
  { id: 'tokens', label: 'Tokens' },
  { id: 'cost', label: 'Cost' },
  { id: 'time', label: 'Time' },
  { id: 'runs', label: 'Runs' },
]

export function AnalyticsView({ agentId = null, sessions, agents, connected, embedded = false, onBack, now, timeZone }: {
  agentId?: string | null
  sessions: readonly Session[]
  agents: readonly Agent[]
  connected: boolean
  embedded?: boolean
  onBack?: () => void
  now?: Date
  timeZone?: string
}) {
  const [initial] = useState(() => readAnalyticsPrefs())
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

  return <Frame embedded={embedded} onBack={onBack}>
    {!connected ? <p className="blob-muted analytics-status" role="status">Connect to the local runtime to load usage.</p> : <>
      <div className="analytics-controls">
        <div className="analytics-switch" role="group" aria-label="Date range">
          {RANGES.map((value) => <button key={value} type="button" aria-pressed={days === value} onClick={() => setDays(value)}>{value} days</button>)}
        </div>
        <div className="analytics-switch" role="group" aria-label="Bucket size">
          <button type="button" aria-pressed={bucket === 'day'} onClick={() => setBucket('day')}>Daily</button>
          <button type="button" aria-pressed={bucket === 'week'} onClick={() => setBucket('week')}>Weekly</button>
        </div>
        <Select ariaLabel="Project" variant="muted" value={projectPath ? projectChoice : ''} onChange={setProjectChoice} options={[{ value: '', label: 'All projects' }, ...projects.map((option) => ({ value: option.key, label: option.label }))]} />
      </div>
      {phase === 'loading' && <AnalyticsSkeleton />}
      {phase === 'error' && <AnalyticsTabs panel={panel} onPanel={setPanel}>
        <div className="blob-card" role="alert" data-analytics-error={panel}>
          <h3>Usage analytics unavailable</h3>
          <p className="blob-muted">{loadError}</p>
          <button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>Try again</button>
        </div>
      </AnalyticsTabs>}
      {data && phase === 'ready' && <AnalyticsBody data={data} agents={agents} metric={metric} panel={panel} updatedAt={updatedAt} onMetric={setMetric} onPanel={setPanel} onRefresh={() => setRetry((value) => value + 1)} />}
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
      <div className="analytics-skeleton-block" />
    </div>
    <div className="analytics-skeleton-chart" />
  </div>
}

function Frame({ embedded, onBack, children }: { embedded: boolean; onBack?: () => void; children: ReactNode }) {
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (!embedded) backRef.current?.focus() }, [embedded])
  if (embedded) return <div className="analytics-embedded" data-analytics-root="embedded">{children}</div>
  return <div className="analytics-page" data-analytics-root="page">
    <header className="blob-page-header">
      <button ref={backRef} type="button" className="secondary-button" onClick={onBack}>Back</button>
      <strong className="blob-page-heading">Usage</strong>
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
  return <>
    <div className="blob-tabs" role="tablist" aria-label="Analytics sections">
      <button type="button" id="analytics-tab-overview" role="tab" aria-selected={panel === 'overview'} aria-controls="analytics-panel-overview" tabIndex={panel === 'overview' ? 0 : -1} onClick={() => onPanel('overview')} onKeyDown={(event) => moveTab(event, panel, onPanel)}>Overview</button>
      <button type="button" id="analytics-tab-errors" role="tab" aria-selected={panel === 'errors'} aria-controls="analytics-panel-errors" tabIndex={panel === 'errors' ? 0 : -1} onClick={() => onPanel('errors')} onKeyDown={(event) => moveTab(event, panel, onPanel)}>Errors</button>
    </div>
    <div id={panel === 'overview' ? 'analytics-panel-overview' : 'analytics-panel-errors'} role="tabpanel" aria-labelledby={panel === 'overview' ? 'analytics-tab-overview' : 'analytics-tab-errors'}>
      {children}
    </div>
  </>
}

function AnalyticsBody({ data, agents, metric, panel, updatedAt, onMetric, onPanel, onRefresh }: {
  data: UsageAnalytics
  agents: readonly Agent[]
  metric: AnalyticsMetric
  panel: AnalyticsViewPrefs['panel']
  updatedAt: Date | null
  onMetric: (metric: AnalyticsMetric) => void
  onPanel: (panel: AnalyticsViewPrefs['panel']) => void
  onRefresh: () => void
}) {
  const notes = analyticsNotes(data.totals)
  const bars = chartBars(data.series, metric, data.range.bucket, data.range.tz)
  const rects = chartRects(bars)
  const summary = chartSummary(bars, metric, data.range.bucket)
  const leaderboard = useMemo(() => foldLeaderboard(data.leaderboard, agents), [data.leaderboard, agents])
  const fractions = leaderboardFractions(leaderboard.map((row) => row.cost.amountMinor))
  const empty = isEmptyAnalytics(data)
  const cost = data.totals.cost
  const tokenTotal = formatBoundNumber(data.totals.tokens.total, cost.lowerBound)
  const cancelled = formatCancelledCount(data.totals.cancelledRuns)
  const runsDetail = [
    `${formatExactNumber(data.totals.failedRuns)} failed`,
    cancelled,
    data.totals.activeRuns > 0 ? `${formatExactNumber(data.totals.activeRuns)} active` : null,
  ].filter((part): part is string => !!part).join(' · ')
  const metricNoun = metric === 'tokens' ? 'token' : metric === 'cost' ? 'cost' : metric === 'time' ? 'time' : 'run'
  const metricEmpty = bars.length > 0 && bars.every((bar) => bar.gap)
  const clock = updatedAt ? formatUpdatedClock(updatedAt, data.range.tz) : null
  return <>
    <p className="analytics-freshness" role="status">
      <span>Time zone {data.range.tz}</span>
      {clock && <span>Updated {clock}</span>}
      <button type="button" className="secondary-button" aria-label="Refresh analytics" onClick={onRefresh}>Refresh</button>
    </p>
    {notes.length > 0 && <div className="analytics-notes" role="note">{notes.map((note) => <p key={note}>{note}</p>)}</div>}
    {empty && <p className="blob-muted" role="status" data-analytics-empty="usage">No usage in this range.</p>}
    <div className="analytics-cards">
      <article className="analytics-card" data-analytics-card="cost" aria-label={`Cost ${formatBoundMoney(cost.amountMinor, cost.currency, cost.lowerBound)}`}>
        <h3>Cost</h3>
        <strong data-figure>{formatBoundMoney(cost.amountMinor, cost.currency, cost.lowerBound)}</strong>
        <small>Actual {formatBoundMoney(cost.actualMinor, cost.currency, false)} · Estimated {formatBoundMoney(cost.estimatedMinor, cost.currency, false)}</small>
      </article>
      <article className="analytics-card" data-analytics-card="tokens" aria-label={`Tokens ${tokenTotal}`}>
        <h3>Tokens</h3>
        <strong data-figure>{tokenTotal}</strong>
        <small className="analytics-buckets">Input {formatExactNumber(data.totals.tokens.input)} · Output {formatExactNumber(data.totals.tokens.output)} · Cache read {formatExactNumber(data.totals.tokens.cacheRead)} · Cache write {formatExactNumber(data.totals.tokens.cacheWrite)} · Reasoning {formatExactNumber(data.totals.tokens.reasoning)}</small>
      </article>
      <article className="analytics-card" data-analytics-card="runtime" aria-label={`Run time ${formatRunTime(data.totals.runTimeMs)}`}>
        <h3>Run time</h3>
        <strong data-figure>{formatRunTime(data.totals.runTimeMs)}</strong>
        <small>Completed and failed turns</small>
      </article>
      <article className="analytics-card" data-analytics-card="runs" aria-label={`Runs ${formatExactNumber(data.totals.runs)}, ${runsDetail}`}>
        <h3>Runs</h3>
        <strong data-figure>{formatExactNumber(data.totals.runs)}</strong>
        <small>{runsDetail}</small>
      </article>
    </div>
    <AnalyticsTabs panel={panel} onPanel={onPanel}>
      {panel === 'overview' ? <div className="analytics-chart-block">
        <div className="analytics-switch" role="group" aria-label="Chart metric">
          {METRICS.map((item) => <button key={item.id} type="button" aria-pressed={metric === item.id} onClick={() => onMetric(item.id)}>{item.label}</button>)}
        </div>
        <p role="img" className="sr-only">{summary}</p>
        {metricEmpty && <p className="blob-muted" role="status" data-analytics-empty="metric">No {metricNoun} data in this range.</p>}
        {rects.length === 0 ? <p className="blob-muted" role="status" data-analytics-empty="chart">No buckets in this range.</p> : <svg className="analytics-chart" viewBox="0 0 640 160" role="group" aria-label={summary}>
          <line x1="0" y1="159" x2="640" y2="159" />
          {rects.map((rect) => <rect
            key={rect.bucketStart}
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            rx="3"
            className={rect.gap ? 'analytics-gap' : rect.value === 0 ? 'analytics-zero' : 'analytics-bar'}
            tabIndex={0}
            focusable="true"
            role="img"
            aria-label={rect.name}
            data-value={rect.value === null ? 'null' : String(rect.value)}
            data-gap={rect.gap ? 'true' : 'false'}
            data-bucket-start={rect.bucketStart}
          ><title>{rect.name}</title></rect>)}
        </svg>}
        <div className="analytics-leader">
          <h3>Blobs</h3>
          {leaderboard.length === 0 ? <p className="blob-muted" role="status" data-analytics-empty="leaderboard">No blobs reported usage in this range.</p> : leaderboard.map((row, index) => {
            const fraction = fractions[index] ?? null
            const agent = row.kind === 'agent' && row.agentId ? agents.find((item) => item.id === row.agentId) : undefined
            const color = agent ? agentColorHex(agent.color) : ''
            const costText = formatBoundMoney(row.cost.amountMinor, row.cost.currency, row.cost.lowerBound)
            const tokenText = formatBoundNumber(row.tokens.total, row.tokensLowerBound)
            const rowCancelled = formatCancelledCount(row.cancelledRuns)
            const rowNotes = [unreportedRunsNote(row.unreportedRuns), unpricedModelsNote(row.unpricedModels)].filter((note): note is string => !!note)
            const detail = `${costText} · ${tokenText} tokens · ${formatExactNumber(row.runs)} runs · ${formatExactNumber(row.failedRuns)} failed${rowCancelled ? ` · ${rowCancelled}` : ''}`
            return <div className="analytics-leader-row" key={row.key} data-agent-id={row.agentId ?? (row.kind === 'other' ? 'other' : 'null')} data-leader-kind={row.kind} role="group" aria-label={`${row.name}. ${detail}${rowNotes.length ? `. ${rowNotes.join('. ')}` : ''}`}>
              <div className="analytics-leader-top"><strong>{row.name}</strong><span>{detail}</span></div>
              <div className="analytics-leader-track" role="img" aria-label={`${row.name} bar, ${costText}`} data-fraction={fraction === null ? 'null' : String(fraction)}>
                {fraction !== null && <div className={color ? 'analytics-leader-fill' : 'analytics-leader-fill is-unassigned'} style={{ width: `${fraction * 100}%`, background: color || undefined }} />}
              </div>
              {rowNotes.length > 0 && <p className="analytics-leader-note" role="note">{rowNotes.join(' ')}</p>}
            </div>
          })}
        </div>
      </div> : <ErrorsPanel data={data} agents={agents} leaderboard={leaderboard} />}
    </AnalyticsTabs>
    <section className="blob-card analytics-subscriptions" aria-label="Subscriptions (not included in usage cost)">
      <h3>Subscriptions (not included in usage cost)</h3>
      {data.subscriptions.length === 0 ? <p className="blob-muted">No subscription fees are configured.</p> : <div className="blob-facts">
        {data.subscriptions.map((plan) => <div className="blob-fact" key={`${plan.provider}-${plan.currency}`}><span>{labelize(plan.provider)}</span><strong>{formatBoundMoney(plan.monthlyMinor, plan.currency, false)} / month · quota {labelize(plan.quotaState)}</strong></div>)}
      </div>}
    </section>
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
      <h3>Blobs by failed runs</h3>
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
      {turns.length === 0 ? <p className="blob-muted" role="status">No failed turns for this blob.</p> : <ul className="analytics-errors">
        {turns.map((error) => <ErrorTurn key={error.turnId} error={error} agents={agents} timeZone={data.range.tz} />)}
      </ul>}
    </div>
  </div>
}

function errorAgentName(agentId: string | null, agents: readonly Agent[]): string {
  const key = analyticsAgentKey(agentId, agents)
  if (key === 'unassigned') return 'Unassigned sessions'
  if (key === 'other') return 'Other'
  return agents.find((agent) => agent.id === key)?.name?.trim() || 'Blob'
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
