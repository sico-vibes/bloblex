// A single slim banner under the header while the daemon is not connected. It
// names what is happening, counts the tries after the third, offers a manual
// retry once a try has failed, and confirms with a short "Back online".

import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { ConnectionState } from '../types'

export function ConnectionBanner({ state, attempts = 0, failed = false, onRetry }: {
  state: ConnectionState
  /** How many reconnection tries have run. */
  attempts?: number
  /** True once a reconnection try has failed outright. */
  failed?: boolean
  onRetry: () => void
}) {
  const [backOnline, setBackOnline] = useState(false)
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
  if (state === 'connected') {
    if (!backOnline) return null
    return <div className="connection-banner" role="status" aria-live="polite" data-state="back-online"><span className="connection-dot" aria-hidden="true" />Back online</div>
  }
  if (failed) {
    return <div className="connection-banner" role="status" aria-live="polite" data-state="failed"><span>Bitbots could not be reached</span><button type="button" className="ghost-button small" onClick={onRetry}>Retry now</button></div>
  }
  return <div className="connection-banner" role="status" aria-live="polite" data-state="reconnecting"><LoaderCircle size={13} className="spinning" aria-hidden="true" /><span>Reconnecting to Bitbots…{attempts > 3 ? ` Attempt ${attempts}` : ''}</span></div>
}
