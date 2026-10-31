// Phase 3: the companion's "Changes ready" opens the review screen in the full app.
// Both windows share an origin, so a BroadcastChannel carries the request.
import { useEffect, useRef } from 'react'
import { showMainWindow } from '../tauri'

const CHANNEL = 'bitbots-open-changes'

export async function openChangesInMainWindow(sessionId: string): Promise<void> {
  await showMainWindow(sessionId)
  const channel = new BroadcastChannel(CHANNEL)
  channel.postMessage({ sessionId })
  channel.close()
}

/** Calls `onOpen` when the companion asks. The handler can change between renders. */
export function useOpenChangesRequests(enabled: boolean, onOpen: (sessionId: string) => void): void {
  const handler = useRef(onOpen)
  handler.current = onOpen
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (event: MessageEvent<{ sessionId?: unknown }>) => {
      if (typeof event.data?.sessionId === 'string') handler.current(event.data.sessionId)
    }
    return () => channel.close()
  }, [enabled])
}
