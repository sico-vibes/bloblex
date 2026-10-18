import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import {
  BADGE_FAILED_LABEL, BADGE_RESTART_LABEL, BADGE_RESTART_SHORT_LABEL, IDLE_UPDATE_PHASE,
  describeUpdatePhase, type UpdatePhaseState,
} from '../updatesContract'

type BadgeBridge = {
  updatesPhase?: () => Promise<UpdatePhaseState | null>
  listenForUpdateState?: (handler: (state: UpdatePhaseState) => void) => Promise<() => void>
  updatesInstall?: () => Promise<void>
  updatesCheck?: () => Promise<unknown>
}

/** The bridge is loaded lazily so partial test mocks and the preview cannot crash the badge. */
async function bridge(): Promise<BadgeBridge> {
  try { return (await import('../tauri')) as BadgeBridge } catch { return {} }
}

/** The companion window never shows the update badge. */
function isCompanionWindow() {
  try { return new URLSearchParams(window.location.search).has('companion') } catch { return false }
}

export function useUpdatePhase(): UpdatePhaseState {
  const [state, setState] = useState<UpdatePhaseState>(IDLE_UPDATE_PHASE)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const api = await bridge()
      if (cancelled) return
      try {
        const initial = await api.updatesPhase?.()
        if (!cancelled && initial) setState(initial)
      } catch { /* the shell stays usable when the updater bridge is absent */ }
      try {
        if (typeof api.listenForUpdateState === 'function') {
          unlisten = await api.listenForUpdateState((next) => { if (!cancelled) setState(next) })
        }
      } catch { /* tests and preview can omit the listener */ }
    })()
    return () => { cancelled = true; unlisten?.() }
  }, [])

  return state
}

/**
 * FIX39 P5 follow-up: below this width the header title and the update badge
 * compete for the same line, so the badge shrinks to an icon and a short label.
 * The title also truncates first (team.css), so the badge can never cover it.
 */
export const COMPACT_BADGE_QUERY = '(max-width: 1180px)'

function useCompactUpdateBadge(): boolean {
  const [compact, setCompact] = useState(() => {
    try { return window.matchMedia(COMPACT_BADGE_QUERY).matches } catch { return false }
  })
  useEffect(() => {
    let media: MediaQueryList
    try { media = window.matchMedia(COMPACT_BADGE_QUERY) } catch { return }
    const onChange = () => setCompact(media.matches)
    onChange()
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [])
  return compact
}

export function UpdateBadge() {
  const state = useUpdatePhase()
  const compact = useCompactUpdateBadge()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const restart = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const api = await bridge()
      await api.updatesInstall?.()
    } catch { /* the phase event reports a failed install */ } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  const retry = useCallback(() => {
    void (async () => {
      const api = await bridge()
      try { await api.updatesCheck?.() } catch { /* stay in the error phase */ }
    })()
  }, [])

  if (isCompanionWindow()) return null

  const { label, percent } = describeUpdatePhase(state)
  const tooltip = state.version ? `Bitbots ${state.version}` : 'Bitbots update'

  if (state.phase === 'downloading') {
    // FIX39 P5 follow-up: at a narrow window the badge keeps only the ring and a
    // short label, so it can never reach the conversation title.
    const short = percent == null ? 'Updating…' : `${percent}%`
    return <span className={`update-badge is-downloading${compact ? ' is-compact' : ''}`} data-update-badge="downloading" role="status" aria-label={label} title={tooltip}>
      <ProgressRing percent={percent} />
      <span className="update-badge-label">{compact ? short : label}</span>
    </span>
  }

  if (state.phase === 'ready') {
    return <button type="button" className={`update-badge-button primary-button small${compact ? ' is-compact' : ''}`} data-update-badge="ready" title={compact ? `${BADGE_RESTART_LABEL} — ${tooltip}` : tooltip} aria-label={BADGE_RESTART_LABEL} disabled={busy} onClick={() => void restart()}>{compact && <RotateCw size={13} aria-hidden="true" />}{compact ? BADGE_RESTART_SHORT_LABEL : BADGE_RESTART_LABEL}</button>
  }

  if (state.phase === 'error') {
    return <button type="button" className="update-badge-button quiet" data-update-badge="error" title={tooltip} onClick={retry}>{BADGE_FAILED_LABEL}</button>
  }

  return null
}

export function ProgressRing({ percent }: { percent: number | null }) {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const shown = percent == null ? 0 : Math.min(100, Math.max(0, percent))
  return <svg className={`update-ring${percent == null ? ' is-indeterminate' : ''}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <circle className="update-ring-track" cx="8" cy="8" r={radius} />
    <circle
      className="update-ring-value"
      cx="8" cy="8" r={radius}
      strokeDasharray={circumference}
      strokeDashoffset={circumference * (1 - shown / 100)}
    />
  </svg>
}
