import { useEffect, useId, useRef, useState } from 'react'

export function ContextWindowIndicator({ used, size }: { used?: number | null; size?: number | null }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
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

  const ring = 2 * Math.PI * 8
  const clampedPercent = percentage === null ? null : Math.max(0, Math.min(100, percentage))
  return <div ref={rootRef} className="context-window-wrap" onMouseEnter={() => { setHovered(true); setDismissed(false) }} onMouseLeave={() => setHovered(false)}>
    <button type="button" className={`context-window-indicator ${percentage === null ? 'unknown' : ''}`} aria-label={label} aria-expanded={open} aria-controls={open ? detailsId : undefined} onClick={() => { setDismissed(false); setPinned((value) => !value) }} onFocus={() => { setFocused(true); setDismissed(false) }} onBlur={(event) => { if (!rootRef.current?.contains(event.relatedTarget as Node | null)) { setFocused(false); setPinned(false); setDismissed(false) } }}>
      <svg viewBox="0 0 20 20" aria-hidden="true" className="context-window-ring">
        <circle className="context-window-ring-track" cx="10" cy="10" r="8" />
        {clampedPercent !== null && <circle className="context-window-ring-value" cx="10" cy="10" r="8" strokeDasharray={`${ring * clampedPercent / 100} ${ring * (1 - clampedPercent / 100)}`} />}
        {percentage === null && <circle className="context-window-ring-unknown" cx="10" cy="10" r="2" />}
      </svg>
      <span className="context-window-center" aria-hidden="true">{percentage === null ? '·' : `${percentage}%`}</span>
      <span className="sr-only">{detail}</span>
      {percentage !== null && <span className="sr-only" role="progressbar" aria-label="Context window used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={clampedPercent!} aria-valuetext={percentDetail}>{percentDetail}</span>}
    </button>
    {open && <div id={detailsId} className="context-window-popover" role="status" aria-live="polite">
      <strong>Context window</strong>
      <span>{compactDetail}</span>
      <span>{percentDetail}</span>
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
