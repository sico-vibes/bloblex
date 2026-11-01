// Plan limits in three places, one set of parts: the bottom status bar, the Usage
// panel it opens (also opened from the sidebar), and the Usage page. Values come
// only from daemon quota snapshots; unknown windows stay unknown.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { ProviderLogo } from './providerBrand'
import { usePopoverDismiss } from './ComposerControls'
import { mostPressingWindow, quotaRows, quotaTone, resetIn, updatedAgo, windowElapsedPercent, type QuotaProviderRow, type QuotaWindowRow } from './quotaModel'

/** A thin bar of how much is used. `pace` marks how much of the window's time has passed. */
export function LimitMeter({ percent, pace = null }: { percent: number; pace?: number | null }) {
  return <i className={`quota-meter tone-${quotaTone(percent)}`} aria-hidden="true"><b style={{ width: `${percent}%` }} />{pace !== null && <u style={{ left: `${pace}%` }} />}</i>
}

/** One limit on one line: name, meter, percent, time until it resets. */
export function LimitRow({ window, stale = false, now }: { window: QuotaWindowRow; stale?: boolean; now?: number }) {
  // A stale reading's reset has usually passed, so neither it nor the pace is shown.
  const reset = stale ? null : resetIn(window.resetsAt, now)
  const pace = stale ? null : windowElapsedPercent(window, now)
  return <div className="limit-row" title={pace === null ? undefined : `${pace}% of this window has passed`}>
    <span className="limit-name">{window.label}</span>
    <LimitMeter percent={window.usedPercent} pace={pace} />
    <b className={`limit-value tone-${quotaTone(window.usedPercent)}`}>{window.usedPercent}%</b>
    <span className="limit-reset">{reset ?? ''}</span>
  </div>
}

/** A provider's name and its limits. With no reading, the reason, and a way to turn reading on when that's the reason. */
export function ProviderLimits({ row, onTurnOn, now }: { row: QuotaProviderRow; onTurnOn?: () => void; now?: number }) {
  return <section className={`usage-provider ${row.windows.length ? '' : 'empty'}`} data-provider={row.provider}>
    <header>
      <ProviderLogo provider={row.provider} size={16} />
      <strong>{row.name}</strong>
      {row.readOff && onTurnOn
        ? <button type="button" className="usage-turn-on" onClick={onTurnOn}>Turn on</button>
        : (row.stale || !row.windows.length) && <span className="usage-provider-status" title={row.windows.length ? `${row.status}. Showing the last reading.` : 'Check the coding agent\'s sign-in, then refresh.'}>{row.windows.length ? 'Last reading' : row.status ?? 'Unavailable'}</span>}
    </header>
    {row.windows.map((window) => <LimitRow key={window.key} window={window} stale={row.stale} now={now} />)}
  </section>
}

function windowSummary(window: QuotaWindowRow) {
  const reset = resetIn(window.resetsAt)
  return `${window.label} ${window.usedPercent}% used${reset ? `, resets in ${reset}` : ''}`
}

function providerSummary(row: QuotaProviderRow) {
  if (!row.windows.length) return `${row.name}: ${row.status ?? 'Unavailable'}`
  return `${row.name}: ${row.windows.map(windowSummary).join('; ')}${row.stale ? `; ${row.status}, showing last reading` : ''}`
}

/** The newest check across the providers, for the panel's one "Updated" line. */
function newestUpdate(rows: readonly QuotaProviderRow[]) {
  const times = rows.flatMap((row) => row.fetchedAt ? [row.fetchedAt] : []).sort()
  return updatedAgo(times.at(-1) ?? null)
}

/** The quick look: every provider's limits at once, nothing hidden behind hover or a mode. */
export function UsagePanel({ rows, refreshing, onRefresh, onOpenDetails, onTurnOn, style }: { rows: QuotaProviderRow[]; refreshing: boolean; onRefresh: () => void; onOpenDetails: () => void; onTurnOn?: () => void; style?: CSSProperties }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { panel.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions) }, [])
  const updated = newestUpdate(rows)
  return <div ref={panel} className="usage-popover" role="dialog" aria-label="Plan usage" tabIndex={-1} style={style}>
    {rows.length === 0 && <p className="usage-rows-empty">Signed-in Codex, Claude Code and OpenCode Go accounts report their plan limits here.</p>}
    {rows.map((row) => <ProviderLimits key={row.provider} row={row} onTurnOn={onTurnOn} />)}
    <footer className="usage-popover-foot">
      <button type="button" className="usage-popover-refresh" aria-label="Refresh plan usage" title="Refresh" disabled={refreshing} onClick={onRefresh}><RefreshCw size={13} className={refreshing ? 'spinning' : ''} aria-hidden="true" /></button>
      <span>{updated ?? ''}</span>
      <button type="button" className="usage-popover-link" onClick={onOpenDetails}>All usage<ArrowRight size={13} aria-hidden="true" /></button>
    </footer>
  </div>
}

export function QuotaBar({ quotas, signedOut = [], refreshing, onRefresh, onOpenDetails, onTurnOn }: {
  quotas: Record<string, unknown>[]
  /** Providers whose CLI reports no sign-in. */
  signedOut?: readonly string[]
  refreshing: boolean
  onRefresh: () => void
  onOpenDetails: () => void
  /** Opens the setting that lets Bitbots read usage for this provider. */
  onTurnOn?: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rows = quotaRows(quotas, signedOut)
  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()) }
  usePopoverDismiss(open, rootRef, close)
  return <div ref={rootRef} className="quota-bar">
    <button ref={triggerRef} type="button" className="quota-bar-trigger" aria-haspopup="dialog" aria-expanded={open} aria-label={rows.length ? `Plan usage. ${rows.map(providerSummary).join('. ')}` : 'Plan usage: no supported account quota source available'} onClick={() => setOpen((value) => !value)}>
      {rows.length ? rows.map((row) => {
        const pressing = mostPressingWindow([row])
        return <span key={row.provider} className={`quota-chip ${row.windows.length ? '' : 'status-only'} ${row.stale ? 'stale' : ''}`} data-provider={row.provider} title={row.windows.length ? undefined : `${row.name}: ${row.status ?? 'Unavailable'}`}>
          <ProviderLogo provider={row.provider} size={14} />
          {pressing && <LimitMeter percent={pressing.window.usedPercent} />}
          {row.windows.slice(0, 2).map((window) => <span className={`quota-chip-window tone-${quotaTone(window.usedPercent)}`} key={window.key}>{window.short} <b>{window.usedPercent}%</b></span>)}
        </span>
      }) : <span className="quota-chip-empty">No plan usage available</span>}
    </button>
    {open && <UsagePanel rows={rows} refreshing={refreshing} onRefresh={onRefresh} onOpenDetails={() => { close(false); onOpenDetails() }} onTurnOn={onTurnOn ? () => { close(false); onTurnOn() } : undefined} />}
  </div>
}
