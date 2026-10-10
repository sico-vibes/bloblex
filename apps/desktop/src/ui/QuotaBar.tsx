// Bottom status bar with each provider's plan limits, and a Usage popover
// with per-provider detail flyouts. Values come only from daemon quota
// snapshots; unknown windows stay unknown.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight, RefreshCw } from 'lucide-react'
import { ProviderLogo } from './providerBrand'
import { usePopoverDismiss } from './ComposerControls'
import { quotaRows, quotaTone, resetIn, updatedAgo, type QuotaProviderRow, type QuotaWindowRow } from './quotaModel'

type Density = 'detailed' | 'compact'
const DENSITY_KEY = 'bloblex.usage.density'

function readDensity(): Density {
  try { return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'detailed' } catch { return 'detailed' }
}

function Meter({ percent, width }: { percent: number; width?: number }) {
  return <i className={`quota-meter tone-${quotaTone(percent)}`} style={width ? { width } : undefined} aria-hidden="true"><b style={{ width: `${percent}%` }} /></i>
}

function windowSummary(window: QuotaWindowRow) {
  const reset = resetIn(window.resetsAt)
  return `${window.label} ${window.usedPercent}% used${reset ? `, resets in ${reset}` : ''}`
}

function providerSummary(row: QuotaProviderRow) {
  if (!row.windows.length) return `${row.name}: ${row.status ?? 'Unavailable'}`
  return `${row.name}: ${row.windows.map(windowSummary).join('; ')}${row.stale ? `; ${row.status}, showing last reading` : ''}`
}

export function QuotaBar({ quotas, refreshing, onRefresh, onOpenDetails }: {
  quotas: Record<string, unknown>[]
  refreshing: boolean
  onRefresh: () => void
  onOpenDetails: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rows = quotaRows(quotas)
  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()) }
  usePopoverDismiss(open, rootRef, close)
  return <div ref={rootRef} className="quota-bar">
    <button ref={triggerRef} type="button" className="quota-bar-trigger" aria-haspopup="dialog" aria-expanded={open} aria-label={rows.length ? `Plan usage. ${rows.map(providerSummary).join('. ')}` : 'Plan usage: no supported account quota source available'} onClick={() => setOpen((value) => !value)}>
      {rows.length ? rows.map((row) => <span key={row.provider} className={`quota-chip ${row.windows.length ? '' : 'status-only'}`} data-provider={row.provider}>
        <ProviderLogo provider={row.provider} size={14} />
        {row.windows.length ? <>
          <Meter percent={row.windows[0].usedPercent} width={34} />
          {row.windows.slice(0, 2).map((window, index) => {
            const reset = resetIn(window.resetsAt)
            return <span className={`quota-chip-window ${index > 0 ? 'secondary' : ''}`} key={window.key}>{index > 0 && <span className="quota-chip-dot">·</span>}<b>{window.usedPercent}%</b> used{reset && <span className="quota-chip-reset"> {reset}</span>}</span>
          })}
          {row.stale && <AlertTriangle size={12} className="quota-chip-warning" aria-hidden="true" />}
        </> : <span className="quota-chip-status"><AlertTriangle size={12} aria-hidden="true" />{row.status}</span>}
      </span>) : <span className="quota-chip-empty">No plan usage available</span>}
    </button>
    <button type="button" className="quota-bar-refresh" aria-label={refreshing ? 'Checking plan usage' : 'Refresh plan usage'} title="Refresh plan usage" disabled={refreshing} onClick={onRefresh}><RefreshCw size={13} className={refreshing ? 'spinning' : ''} aria-hidden="true" /></button>
    {open && <UsagePopover rows={rows} refreshing={refreshing} onRefresh={onRefresh} onOpenDetails={() => { close(false); onOpenDetails() }} />}
  </div>
}

function UsagePopover({ rows, refreshing, onRefresh, onOpenDetails }: { rows: QuotaProviderRow[]; refreshing: boolean; onRefresh: () => void; onOpenDetails: () => void }) {
  const [density, setDensity] = useState<Density>(readDensity)
  const [active, setActive] = useState<string | null>(null)
  const [flyoutTop, setFlyoutTop] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<number | null>(null)
  useEffect(() => { try { localStorage.setItem(DENSITY_KEY, density) } catch { /* preference is optional */ } }, [density])
  useEffect(() => () => { if (hideTimer.current !== null) window.clearTimeout(hideTimer.current) }, [])
  useEffect(() => { requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('.usage-row')?.focus()) }, [])
  const show = (provider: string, row: HTMLElement) => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    hideTimer.current = null
    setActive(provider)
    setFlyoutTop(row.offsetTop)
  }
  const hideSoon = () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => { hideTimer.current = null; setActive(null) }, 140)
  }
  const activeRow = rows.find((row) => row.provider === active) ?? null
  return <div className="usage-popover" role="dialog" aria-label="Plan usage">
    <div className="usage-popover-head">
      <strong>Usage</strong>
      <span>all agents</span>
      <button type="button" className="usage-popover-refresh" aria-label="Refresh plan usage" disabled={refreshing} onClick={onRefresh}><RefreshCw size={13} className={refreshing ? 'spinning' : ''} aria-hidden="true" /></button>
    </div>
    <div className="usage-density" role="radiogroup" aria-label="Density">
      {(['detailed', 'compact'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={density === value} className={density === value ? 'active' : ''} onClick={() => setDensity(value)}>{value === 'detailed' ? 'Detailed' : 'Compact'}</button>)}
    </div>
    <div ref={listRef} className={`usage-rows ${density}`} onMouseLeave={hideSoon}>
      {rows.length === 0 && <p className="usage-rows-empty">Signed-in Codex, Claude Code and OpenCode Go accounts report their plan limits here.</p>}
      {rows.map((row) => {
        const primary = row.windows[0]
        const reset = primary ? resetIn(primary.resetsAt) : null
        return <button key={row.provider} type="button" className={`usage-row ${active === row.provider ? 'active' : ''}`} aria-describedby={active === row.provider ? 'usage-flyout' : undefined} aria-label={providerSummary(row)} onMouseEnter={(event) => show(row.provider, event.currentTarget)} onFocus={(event) => show(row.provider, event.currentTarget)} onBlur={hideSoon} onClick={(event) => show(row.provider, event.currentTarget)}>
          <span className="usage-row-head">
            <ProviderLogo provider={row.provider} size={18} />
            <strong>{row.name}</strong>
            {row.windows.length ? (reset && <span className="usage-row-meta">Resets in {reset}</span>) : <span className="usage-row-meta warn">{row.status}</span>}
            {row.stale && <span className="usage-row-meta warn">{row.status}</span>}
            <ChevronRight size={14} className="usage-row-chevron" aria-hidden="true" />
          </span>
          {row.windows.length > 0 && (density === 'detailed'
            ? <span className="usage-row-windows">{row.windows.slice(0, 3).map((window) => <span key={window.key} className="usage-row-window"><span>{window.short}</span><Meter percent={window.usedPercent} /><b>{window.usedPercent}%</b></span>)}</span>
            : <span className="usage-row-compact"><Meter percent={row.windows[0].usedPercent} />{row.windows.slice(0, 2).map((window) => `${window.usedPercent}%`).join(' · ')}</span>)}
        </button>
      })}
    </div>
    <button type="button" className="usage-popover-link" onClick={onOpenDetails}><span>Usage details &amp; history</span><ChevronRight size={14} aria-hidden="true" /></button>
    {activeRow && <ProviderFlyout row={activeRow} top={flyoutTop} onEnter={() => { if (hideTimer.current !== null) window.clearTimeout(hideTimer.current); hideTimer.current = null }} onLeave={hideSoon} />}
  </div>
}

function ProviderFlyout({ row, top, onEnter, onLeave }: { row: QuotaProviderRow; top: number; onEnter: () => void; onLeave: () => void }) {
  const updated = updatedAgo(row.fetchedAt)
  const ref = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(top)
  // Align with the hovered row, but keep the flyout inside the popover's height.
  useLayoutEffect(() => {
    const parent = ref.current?.offsetParent as HTMLElement | null
    const height = ref.current?.offsetHeight ?? 0
    setOffset(parent ? Math.max(0, Math.min(top, parent.clientHeight - height)) : top)
  }, [top, row])
  return <div ref={ref} id="usage-flyout" className="usage-flyout" role="tooltip" style={{ top: offset }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
    <div className="usage-flyout-head"><ProviderLogo provider={row.provider} size={18} /><span><strong>{row.name}</strong>{updated && <small>{updated}</small>}</span></div>
    {row.windows.length ? row.windows.map((window) => {
      const reset = resetIn(window.resetsAt)
      return <div key={window.key} className="usage-flyout-window">
        <strong>{window.label}</strong>
        <Meter percent={window.usedPercent} />
        <span className="usage-flyout-line"><span>{window.usedPercent}% used</span>{reset && <span>Resets in {reset}</span>}</span>
      </div>
    }) : <p className="usage-flyout-empty">{row.status ?? 'Unavailable'}. Check the CLI sign-in, then refresh.</p>}
    {row.stale && <p className="usage-flyout-empty">Latest check: {row.status}. Showing the last successful reading.</p>}
  </div>
}
