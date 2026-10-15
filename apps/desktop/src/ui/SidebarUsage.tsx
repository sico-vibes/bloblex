import { useEffect, useMemo, useState } from 'react'
import { ProviderLogo } from './providerBrand'
import { quotaRows, quotaTone, resetIn, type QuotaProviderRow, type QuotaWindowRow } from './quotaModel'
import './sidebarUsage.css'

export interface PressingWindow { row: QuotaProviderRow; window: QuotaWindowRow }

/** The reading closest to its limit across every provider: the one worth glancing at. */
export function mostPressingWindow(rows: QuotaProviderRow[]): PressingWindow | null {
  let best: PressingWindow | null = null
  for (const row of rows) {
    for (const window of row.windows) {
      if (!best || window.usedPercent > best.window.usedPercent) best = { row, window }
    }
  }
  return best
}

/**
 * A single quiet line at the foot of the sidebar: provider, a thin meter,
 * the percentage and when it resets. It shows only what a provider reported;
 * with no reading it renders nothing, and the full breakdown stays one click away.
 */
export function SidebarUsage({ quotas, onOpen }: { quotas: Record<string, unknown>[]; onOpen: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const pressing = useMemo(() => mostPressingWindow(quotaRows(quotas)), [quotas])
  if (!pressing) return null
  const { row, window: reading } = pressing
  const reset = resetIn(reading.resetsAt, now)
  const tone = quotaTone(reading.usedPercent)
  const summary = `${row.name} ${reading.label}: ${reading.usedPercent}% used${reset ? `, resets in ${reset}` : ''}${row.stale ? ', showing the last reading' : ''}`
  return <button type="button" className={`sidebar-usage tone-${tone}`} onClick={onOpen} aria-label={`${summary}. Open usage`} title={summary} data-tour="usage">
    <ProviderLogo provider={row.provider} size={14} />
    <span className="sidebar-usage-text">
      <span className="sidebar-usage-line"><b>{reading.usedPercent}%</b><span>{reading.short} used</span>{reset && <span className="sidebar-usage-reset">resets {reset}</span>}</span>
      <i className="sidebar-usage-meter" aria-hidden="true"><b style={{ width: `${reading.usedPercent}%` }} /></i>
    </span>
  </button>
}
