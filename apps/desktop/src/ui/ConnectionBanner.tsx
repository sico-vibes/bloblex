// A single slim banner under the header while the daemon is not connected. It
// names what is happening, counts the tries after the third, offers a manual
// retry once a try has failed, and confirms with a short "Back online". When the
// native supervisor sees the service itself stop, it says so first: restarting
// (with the attempt), or stopped for good after five crashes in two minutes.

import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { ConnectionState, DaemonSupervisor } from '../types'
import { daemonSupervisorState, listenForDaemonSupervisor, restartDaemonNow } from '../tauri'

/** The supervisor's latest reading in this window. */
function useDaemonSupervisor() {
  const [supervisor, setSupervisor] = useState<DaemonSupervisor | null>(null)
  useEffect(() => {
    let live = true
    let stop: (() => void) | undefined
    void daemonSupervisorState().then((state) => { if (live) setSupervisor(state) })
    void listenForDaemonSupervisor((state) => { if (live) setSupervisor(state) }).then((unlisten) => { if (live) stop = unlisten; else unlisten() })
    return () => { live = false; stop?.() }
  }, [])
  return supervisor
}

export function ConnectionBanner({ state, attempts = 0, failed = false, onRetry }: {
  state: ConnectionState
  /** How many reconnection tries have run. */
  attempts?: number
  /** True once a reconnection try has failed outright. */
  failed?: boolean
  onRetry: () => void
}) {
  const [backOnline, setBackOnline] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const supervisor = useDaemonSupervisor()
  const previous = useRef(state)
  useEffect(() => {
    const was = previous.current
    previous.current = state
    if (state !== 'connected') { setBackOnline(false); return }
    if (was === 'connected') return
    setBackOnline(true)
    const timer = window.setTimeout(() => setBackOnline(false), 1500)
    return () => window.clearTimeout(timer)
  }, [state])
  if (supervisor?.state === 'gave_up') {
    const tryAgain = async () => { setRestarting(true); try { await restartDaemonNow() } catch { /* the next reading says how it went */ } finally { setRestarting(false); onRetry() } }
    return <div className="connection-banner" role="alert" data-state="failed"><span>The Bitbots service keeps stopping, so it was not restarted again.</span><button type="button" className="ghost-button small" disabled={restarting} onClick={() => void tryAgain()}>{restarting ? 'Starting…' : 'Try again'}</button></div>
  }
  if (supervisor?.state === 'restarting') {
    return <div className="connection-banner" role="status" aria-live="polite" data-state="reconnecting"><LoaderCircle size={13} className="spinning" aria-hidden="true" /><span>The Bitbots service stopped. Restarting it…{supervisor.attempt > 1 ? ` Attempt ${supervisor.attempt}` : ''}</span></div>
  }
  if (state === 'connected') {
    if (!backOnline) return null
    return <div className="connection-banner" role="status" aria-live="polite" data-state="back-online"><span className="connection-dot" aria-hidden="true" />Back online</div>
  }
  if (failed) {
    return <div className="connection-banner" role="status" aria-live="polite" data-state="failed"><span>Bitbots could not be reached</span><button type="button" className="ghost-button small" onClick={onRetry}>Retry now</button></div>
  }
  return <div className="connection-banner" role="status" aria-live="polite" data-state="reconnecting"><LoaderCircle size={13} className="spinning" aria-hidden="true" /><span>Reconnecting to Bitbots…{attempts > 3 ? ` Attempt ${attempts}` : ''}</span></div>
}
