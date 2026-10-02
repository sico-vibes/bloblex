import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Agent, Session } from '../types'
import type { AnalyticsBucket, AnalyticsMetric, AnalyticsRangeDays, UsageAnalytics } from '../analyticsTypes'
import { labelize } from '../types'
import { agentColorHex } from './agentColor'
import { fetchUsageAnalytics } from '../tauri'
import {
  analyticsErrorText,
  analyticsNotes,
  buildAnalyticsRequest,
  chartBars,
  chartRects,
  chartSummary,
  formatBoundMoney,
  formatBoundNumber,
  formatExactNumber,
  formatInstant,
  formatRunTime,
  isEmptyAnalytics,
  leaderboardFractions,
  leaderboardName,
  normalizeAnalytics,
} from './analyticsFormat'
import { analyticsProjectChoices } from './rosterSelectors'
import './analytics.css'

const RANGES: AnalyticsRangeDays[] = [7, 30, 90]
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
  const [days, setDays] = useState<AnalyticsRangeDays>(7)
  const [bucket, setBucket] = useState<AnalyticsBucket>('day')
  const [projectChoice, setProjectChoice] = useState('')
  const [metric, setMetric] = useState<AnalyticsMetric>('tokens')
  const [panel, setPanel] = useState<'overview' | 'errors'>('overview')
  const [retry, setRetry] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [data, setData] = useState<UsageAnalytics | null>(null)
  const projects = useMemo(() => analyticsProjectChoices(sessions), [sessions])
  const projectPath = projects.find((option) => option.key === projectChoice)?.path ?? ''

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
        <label className="analytics-field">Project
          <select aria-label="Project" value={projectPath ? projectChoice : ''} onChange={(event) => setProjectChoice(event.target.value)}>
            <option value="">All projects</option>
            {projects.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </label>
      </div>
      {phase === 'loading' && <p className="blob-muted analytics-status" role="status">Loading analytics…</p>}
      {phase === 'error' && <div className="blob-card" role="alert">
        <h3>Usage analytics unavailable</h3>
        <p className="blob-muted">{loadError}</p>
        <button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>Try again</button>
      </div>}
      {data && phase === 'ready' && <AnalyticsBody data={data} agents={agents} metric={metric} panel={panel} onMetric={setMetric} onPanel={setPanel} />}
    </>}
  </Frame>
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

function AnalyticsBody({ data, agents, metric, panel, onMetric, onPanel }: {
  data: UsageAnalytics
  agents: readonly Agent[]
  metric: AnalyticsMetric
  panel: 'overview' | 'errors'
  onMetric: (metric: AnalyticsMetric) => void
  onPanel: (panel: 'overview' | 'errors') => void
}) {
  const notes = analyticsNotes(data.totals)
  const bars = chartBars(data.series, metric, data.range.bucket, data.range.tz)
  const rects = chartRects(bars)
  const summary = chartSummary(bars, metric, data.range.bucket)
  const fractions = leaderboardFractions(data.leaderboard.map((row) => row.cost.amountMinor))
  const empty = isEmptyAnalytics(data)
  const cost = data.totals.cost
  const tokenTotal = formatBoundNumber(data.totals.tokens.total, cost.lowerBound)
  return <>
    {notes.length > 0 && <div className="analytics-notes" role="note">{notes.map((note) => <p key={note}>{note}</p>)}</div>}
    {empty && <p className="blob-muted" role="status">No usage in this range.</p>}
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
      <article className="analytics-card" data-analytics-card="runs" aria-label={`Runs ${formatExactNumber(data.totals.runs)}, ${formatExactNumber(data.totals.failedRuns)} failed`}>
        <h3>Runs</h3>
        <strong data-figure>{formatExactNumber(data.totals.runs)}</strong>
        <small>{formatExactNumber(data.totals.failedRuns)} failed{data.totals.activeRuns > 0 ? ` · ${formatExactNumber(data.totals.activeRuns)} active` : ''}</small>
      </article>
    </div>
    <div className="blob-tabs" role="tablist" aria-label="Analytics sections">
      <button type="button" id="analytics-tab-overview" role="tab" aria-selected={panel === 'overview'} aria-controls="analytics-panel-overview" tabIndex={panel === 'overview' ? 0 : -1} onClick={() => onPanel('overview')}>Overview</button>
      <button type="button" id="analytics-tab-errors" role="tab" aria-selected={panel === 'errors'} aria-controls="analytics-panel-errors" tabIndex={panel === 'errors' ? 0 : -1} onClick={() => onPanel('errors')}>Errors</button>
    </div>
    <div id={panel === 'overview' ? 'analytics-panel-overview' : 'analytics-panel-errors'} role="tabpanel" aria-labelledby={panel === 'overview' ? 'analytics-tab-overview' : 'analytics-tab-errors'}>
      {panel === 'overview' ? <div className="analytics-chart-block">
        <div className="analytics-switch" role="group" aria-label="Chart metric">
          {METRICS.map((item) => <button key={item.id} type="button" aria-pressed={metric === item.id} onClick={() => onMetric(item.id)}>{item.label}</button>)}
        </div>
        <p role="img" className="sr-only">{summary}</p>
        {rects.length === 0 ? <p className="blob-muted">No buckets in this range.</p> : <svg className="analytics-chart" viewBox="0 0 640 160" role="group" aria-label={summary}>
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
          {data.leaderboard.length === 0 ? <p className="blob-muted">No blobs reported usage in this range.</p> : data.leaderboard.map((row, index) => {
            const fraction = fractions[index] ?? null
            const agent = row.agentId ? agents.find((item) => item.id === row.agentId) : undefined
            const color = agent ? agentColorHex(agent.color) : ''
            const costText = formatBoundMoney(row.cost.amountMinor, row.cost.currency, row.cost.lowerBound)
            const tokenText = formatBoundNumber(row.tokens.total, row.cost.lowerBound)
            return <div className="analytics-leader-row" key={row.agentId ?? 'unassigned'} data-agent-id={row.agentId ?? 'null'}>
              <div className="analytics-leader-top"><strong>{leaderboardName(row)}</strong><span>{costText} · {tokenText} tokens · {formatExactNumber(row.runs)} runs</span></div>
              <div className="analytics-leader-track" data-fraction={fraction === null ? 'null' : String(fraction)}>
                {fraction !== null && <div className={color ? 'analytics-leader-fill' : 'analytics-leader-fill is-unassigned'} style={{ width: `${fraction * 100}%`, background: color || undefined }} />}
              </div>
            </div>
          })}
        </div>
      </div> : <div>
        {data.errors.length === 0 ? <p className="blob-muted">No failed runs in this range.</p> : <ul className="analytics-errors">
          {data.errors.map((error) => <li key={error.turnId}>
            <time dateTime={error.at}>{formatInstant(error.at, data.range.tz)}</time>
            <small>{error.agentId ? (agents.find((agent) => agent.id === error.agentId)?.name ?? 'Blob') : 'Unassigned sessions'}</small>
            <p>{error.message}</p>
          </li>)}
        </ul>}
      </div>}
    </div>
    <section className="blob-card analytics-subscriptions" aria-label="Subscriptions (not included in usage cost)">
      <h3>Subscriptions (not included in usage cost)</h3>
      {data.subscriptions.length === 0 ? <p className="blob-muted">No subscription fees are configured.</p> : <div className="blob-facts">
        {data.subscriptions.map((plan) => <div className="blob-fact" key={`${plan.provider}-${plan.currency}`}><span>{labelize(plan.provider)}</span><strong>{formatBoundMoney(plan.monthlyMinor, plan.currency, false)} / month · quota {labelize(plan.quotaState)}</strong></div>)}
      </div>}
    </section>
  </>
}
