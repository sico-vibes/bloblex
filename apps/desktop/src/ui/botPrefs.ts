// Editor preferences kept on this device (FIX22 B10): whether the Technical
// details disclosure is open. Follows the uiPrefs pattern: a module mirror, a
// guarded localStorage cache and a subscribe hook so every reader re-renders.

import { useCallback, useSyncExternalStore } from 'react'

const DETAILS_KEY = 'bitbots.botPage.detailsOpen'

function read(): boolean {
  try { return localStorage.getItem(DETAILS_KEY) === 'true' } catch { return false }
}

let detailsOpen = read()
const listeners = new Set<() => void>()
function notify() { for (const listener of listeners) listener() }

/** Whether Technical details is open. Closed on a fresh device. */
export function botDetailsOpen(): boolean { return detailsOpen }

export function setDetailsOpen(next: boolean) {
  if (next === detailsOpen) return
  detailsOpen = next
  try { localStorage.setItem(DETAILS_KEY, next ? 'true' : 'false') } catch { /* The cache only avoids a flash. */ }
  notify()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The details disclosure's open flag plus its setter. */
export function useDetailsOpen(): [open: boolean, setOpen: (next: boolean) => void] {
  const open = useSyncExternalStore(subscribe, botDetailsOpen, () => false)
  const set = useCallback((next: boolean) => setDetailsOpen(next), [])
  return [open, set]
}
