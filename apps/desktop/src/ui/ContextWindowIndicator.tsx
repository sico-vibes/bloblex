import { useEffect, useId, useRef, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { quotaRows, quotaTone, resetIn } from './quotaModel'

export function ContextWindowIndicator({ used, size, quota, onOpenUsage }: {
  used?: number | null
  size?: number | null
  /** This conversation's provider quota snapshot, when the daemon has one. */
  quota?: Record<string, unknown> | null
  onOpenUsage?: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const hoverTimer = useRef<number | null>(null)
  const detailsId = useId()
  const open = pinned || hovered || (focused && !dismissed)
  const hasUsed = typeof used === 'number' && Number.isFinite(used) && used >= 0
  const hasSize = typeof size === 'number' && Number.isFinite(size) && size > 0
  const percentage = hasUsed && hasSize ? Math.round((used / size) * 100) : null
  const detail = hasUsed && hasSize
    ? `${contextTokenCount(used)} of ${contextTokenCount(size)} tokens used, ${percentage}% full`
    : hasUsed
      ? `${contextTokenCount(used)} tokens used · window capacity unavailable`
      : hasSize
        ? `${contextTokenCount(size)} token capacity · used tokens unavailable`
        : 'Context usage unavailable'
  const label = `Context window: ${detail}`
  const percentDetail = percentage === null ? 'Percentage unavailable' : `${percentage}% full`
  const compactDetail = hasUsed && hasSize
    ? `${contextCompactCount(used)} / ${contextCompactCount(size)} tokens used`
    : hasUsed
      ? `${contextCompactCount(used)} tokens used · capacity unavailable`
      : hasSize
        ? `${contextCompactCount(size)} capacity · usage unavailable`
        : 'Context usage unavailable'
  const provider = quota ? quotaRows([quota])[0] ?? null : null

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setPinned(false)
        setHovered(false)
        setDismissed(true)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setPinned(false)
        setHovered(false)
        setDismissed(true)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])
  useEffect(() => () => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current) }, [])

  const ring = 2 * Math.PI * 7
  const clampedPercent = percentage === null ? null : Math.max(0, Math.min(100, percentage))
  const tone = clampedPercent === null ? 'unknown' : quotaTone(clampedPercent)
  return <div ref={rootRef} className="context-window-wrap" onMouseEnter={() => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); hoverTimer.current = null; setHovered(true); setDismissed(false) }} onMouseLeave={() => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => { hoverTimer.current = null; setHovered(false) }, 160) }}>
    <button ref={buttonRef} type="button" className={`context-window-indicator tone-${tone}`} aria-label={label} aria-expanded={open} aria-controls={open ? detailsId : undefined} onClick={() => { setDismissed(false); setPinned((value) => !value) }} onFocus={() => { setFocused(true); setDismissed(false) }} onBlur={(event) => { if (!rootRef.current?.contains(event.relatedTarget as Node | null)) { setFocused(false); setPinned(false); setDismissed(false) } }}>
      <svg viewBox="0 0 18 18" aria-hidden="true" className="context-window-ring">
        <circle className="context-window-ring-track" cx="9" cy="9" r="7" />
        {clampedPercent !== null && clampedPercent > 0 && <circle className="context-window-ring-value" cx="9" cy="9" r="7" strokeDasharray={`${Math.max(1.2, ring * clampedPercent / 100)} ${ring}`} />}
      </svg>
      <span className="sr-only">{detail}</span>
      {percentage !== null && <span className="sr-only" role="progressbar" aria-label="Context window used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={clampedPercent!} aria-valuetext={percentDetail}>{percentDetail}</span>}
    </button>
    {open && <div id={detailsId} className="context-window-popover" role="status" aria-live="polite">
      <div className="context-popover-row"><strong>Context window</strong><span className="context-popover-value">{hasUsed && hasSize ? `${contextCompactCount(used)} / ${contextCompactCount(size)} (${percentage}%)` : compactDetail}</span></div>
      <span className="sr-only">{compactDetail}</span>
      <i className={`context-popover-bar tone-${tone}`} aria-hidden="true"><b style={{ width: `${clampedPercent ?? 0}%` }} /></i>
      {percentage === null ? <span className="context-popover-note">{percentDetail}</span> : <span className="sr-only">{percentDetail}</span>}
      {provider && provider.windows.length > 0 && <div className="context-popover-section">
        <span className="context-popover-section-title">Plan usage limits · {provider.name}{provider.stale && <em> · last reading</em>}</span>
        {provider.windows.slice(0, 3).map((window) => {
          const reset = resetIn(window.resetsAt)
          return <div className="context-popover-limit" key={window.key}>
            <div className="context-popover-row"><span>{window.label}</span><span className="context-popover-value">{reset && <small>Resets in {reset}</small>}{window.usedPercent}%</span></div>
            <i className={`context-popover-bar tone-${quotaTone(window.usedPercent)}`} aria-hidden="true"><b style={{ width: `${window.usedPercent}%` }} /></i>
          </div>
        })}
      </div>}
      {onOpenUsage && <button type="button" className="context-popover-link" onClick={() => { setPinned(false); setHovered(false); onOpenUsage() }}>See usage details<ArrowUpRight size={12} aria-hidden="true" /></button>}
    </div>}
  </div>
}

function contextTokenCount(value: number) {
  return Math.round(value).toLocaleString()
}

function contextCompactCount(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1))}M`
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(value >= 10_000 ? 0 : 1))}k`
  return Math.round(value).toString()
}
