import { useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { createPortal } from 'react-dom'
import type { Runtime } from '../types'
import { placeTooltip } from './tooltipPosition'
import { runtimeProbeDetail } from './runtimeDiscovery'
import { friendlyError } from './errorCopy'

/** A failed local CLI check affects only blobs attached to that runtime. */
export function runtimeProblem(runtime: Runtime | null | undefined) {
  if (!runtime) return null
  if (String(runtime.authState ?? '').toLowerCase() === 'sign_in_failed') return {
    label: `${runtime.provider} · Sign in again`,
    reason: 'Its sign-in expired, so messages to it fail.',
    recovery: 'Open Settings → Coding agents and choose Sign in.',
  }
  if (String(runtime.status ?? '').toLowerCase() !== 'error') return null
  const probe = runtimeProbeDetail(runtime)
  return {
    label: probe?.step ?? `${runtime.provider} · Runtime check`,
    reason: probe?.message ?? 'The coding agent could not be checked.',
    recovery: 'Open Settings → Coding agents. Update or repair this CLI, then choose Scan again.',
  }
}

export function RuntimeProblemMarker({ runtime, onOpenSettings, inline = false, idSuffix = '', showTooltip }: { runtime: Runtime | null | undefined; onOpenSettings?: () => void; inline?: boolean; idSuffix?: string; showTooltip?: boolean }) {
  const problem = runtimeProblem(runtime)
  const inlineAnchorRef = useRef<HTMLSpanElement>(null)
  const buttonAnchorRef = useRef<HTMLButtonElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const [localOpen, setLocalOpen] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const open = showTooltip ?? localOpen
  useLayoutEffect(() => {
    if (!open || !problem) return
    const update = () => {
      const anchor = (inlineAnchorRef.current ?? buttonAnchorRef.current)?.getBoundingClientRect()
      const tooltip = tooltipRef.current?.getBoundingClientRect()
      if (!anchor) return
      const next = placeTooltip(anchor, { width: tooltip?.width || Math.min(290, window.innerWidth - 32), height: tooltip?.height || 80 }, 'bottom')
      setPosition({ left: next.left, top: next.top })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open, problem?.label, problem?.reason, problem?.recovery])
  if (!problem) return null
  const friendly = friendlyError({ message: problem.reason, provider: runtime!.provider })
  const tooltipId = `runtime-problem-${runtime!.id}${idSuffix ? `-${idSuffix}` : ''}`
  return <span className="runtime-problem-anchor">
    {inline
      ? <span ref={inlineAnchorRef} className="runtime-problem-marker" aria-hidden="true"><AlertCircle size={14} /></span>
      : <button ref={buttonAnchorRef} type="button" className="runtime-problem-marker" aria-label={`${problem.label}: ${friendly.title} ${problem.recovery}`} aria-describedby={tooltipId} onPointerEnter={() => setLocalOpen(true)} onPointerLeave={() => setLocalOpen(false)} onFocus={() => setLocalOpen(true)} onBlur={() => setLocalOpen(false)} onClick={onOpenSettings}>
        <AlertCircle size={14} aria-hidden="true" />
      </button>}
    {open && createPortal(<span ref={tooltipRef} className="runtime-problem-tooltip" id={tooltipId} role="tooltip" style={position}>
      <strong>{problem.label}</strong><span>{friendly.title}{friendly.detail ? ` ${friendly.detail}` : ''}</span><span>{problem.recovery}</span>
      <details className="runtime-problem-details"><summary>Details</summary><span>{problem.reason}</span></details>
    </span>, document.body)}
  </span>
}
