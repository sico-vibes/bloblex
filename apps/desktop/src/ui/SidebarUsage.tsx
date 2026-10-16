import { useEffect, useMemo, useState } from 'react'
import { ProviderLogo } from './providerBrand'
import { quotaRows, quotaTone, resetIn, type QuotaProviderRow, type QuotaWindowRow } from './quotaModel'
import './sidebarUsage.css'

export interface PressingWindow { row: QuotaProviderRow; window: QuotaWindowRow }

/** How long each coding agent's reading stays before the next one. */
export const SIDEBAR_USAGE_ROTATE_MS = 6000

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
 * One reading per coding agent that reported a current, accurate value: its
 * window closest to the limit. Stale readings and failed checks are left out.
 */
export function rotatingReadings(rows: QuotaProviderRow[]): PressingWindow[] {
  return rows
    .filter((row) => !row.stale && !row.status && row.windows.length > 0)
    .map((row) => mostPressingWindow([row]))
    .filter((reading): reading is PressingWindow => reading !== null)
}

/**
 * A single quiet line at the foot of the sidebar: provider, a thin meter,
 * the percentage and when it resets. It takes turns between the coding agents
 * with an accurate reading, pausing while the pointer or focus is on it. With
 * no reading it renders nothing; the full breakdown stays one click away.
 */
export function SidebarUsage({ quotas, onOpen }: { quotas: Record<string, unknown>[]; onOpen: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const readings = useMemo(() => rotatingReadings(quotaRows(quotas)), [quotas])
  const count = readings.length
  useEffect(() => {
    if (count < 2 || paused) return
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % count), SIDEBAR_USAGE_ROTATE_MS)
    return () => window.clearInterval(timer)
  }, [count, paused])
  if (!count) return null
  const { row, window: reading } = readings[index % count]
  const reset = resetIn(reading.resetsAt, now)
  const tone = quotaTone(reading.usedPercent)
  const summary = `${row.name} ${reading.label}: ${reading.usedPercent}% used${reset ? `, resets in ${reset}` : ''}`
  return <button type="button" className={`sidebar-usage tone-${tone}`} onClick={onOpen} aria-label={`${summary}. Open usage`} title={summary} data-tour="usage"
    onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
    <span className="sidebar-usage-slide" key={row.provider}>
      <ProviderLogo provider={row.provider} size={14} />
      <span className="sidebar-usage-text">
        <span className="sidebar-usage-line"><b>{reading.usedPercent}%</b><span>{reading.short} used</span>{reset && <span className="sidebar-usage-reset">resets {reset}</span>}</span>
        <i className="sidebar-usage-meter" aria-hidden="true"><b style={{ width: `${reading.usedPercent}%` }} /></i>
      </span>
    </span>
    {count > 1 && <span className="sidebar-usage-dots" aria-hidden="true">{readings.map((item, dot) => <i key={item.row.provider} className={dot === index % count ? 'on' : ''} />)}</span>}
  </button>
}
