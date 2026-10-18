import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BADGE_FAILED_LABEL, BADGE_RESTART_LABEL, IDLE_UPDATE_PHASE,
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

export function UpdateBadge() {
  const state = useUpdatePhase()
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
    return <span className="update-badge is-downloading" data-update-badge="downloading" role="status" aria-label={label} title={tooltip}>
      <ProgressRing percent={percent} />
      <span className="update-badge-label">{label}</span>
    </span>
  }

  if (state.phase === 'ready') {
    return <button type="button" className="update-badge-button primary-button small" data-update-badge="ready" title={tooltip} disabled={busy} onClick={() => void restart()}>{BADGE_RESTART_LABEL}</button>
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
