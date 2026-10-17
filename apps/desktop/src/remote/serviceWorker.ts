// Registers the remote service worker and exposes the two hooks the "Update
// ready" prompt needs. Kept out of `main.tsx` so the prompt component can import
// them without pulling in the file that renders the app.
//
// The worker never calls `skipWaiting` on its own: the page decides when to
// apply an update (`applyUpdate`), and reloads once the new worker controls the
// page.

/** The path the remote build emits the worker to (spec §4). */
export const REMOTE_SW_URL = '/remote-sw.js'

let waitingWorker: ServiceWorker | null = null
let reloadPending = false
const readyCallbacks = new Set<() => void>()

/** True when a new worker is installed and waiting for the page's go-ahead. */
export function updateIsReady(): boolean {
  return waitingWorker !== null
}

/**
 * Called when a new worker is installed and waiting. Fires immediately when one
 * is already waiting, so a late subscriber cannot miss the prompt. Returns an
 * unsubscribe function.
 */
export function onUpdateReady(callback: () => void): () => void {
  readyCallbacks.add(callback)
  if (waitingWorker) callback()
  return () => { readyCallbacks.delete(callback) }
}

/**
 * Applies a waiting update: asks the worker to skip waiting, then reloads on
 * `controllerchange`. A no-op when there is nothing waiting.
 */
export function applyUpdate(): void {
  if (!waitingWorker) return
  reloadPending = true
  waitingWorker.postMessage({ type: 'skip-waiting' })
}

function announce(worker: ServiceWorker): void {
  waitingWorker = worker
  for (const callback of [...readyCallbacks]) callback()
}

/**
 * Registers `/remote-sw.js` with scope `/`, on HTTPS or localhost only (a
 * service worker needs a secure context). The worker is a self-contained classic
 * script, so no `type: 'module'` is needed. Safe to call once at startup.
 */
export function registerRemoteServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  if (typeof location === 'undefined') return
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  if (!secure) return

  void navigator.serviceWorker.register(REMOTE_SW_URL, { scope: '/' }).then((registration) => {
    if (registration.waiting && navigator.serviceWorker.controller) announce(registration.waiting)
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        // `controller` is set only after the first load; an update is what
        // "waiting" means for an already-controlled page.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) announce(installing)
      })
    })
  }).catch(() => undefined)

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadPending) return
    reloadPending = false
    location.reload()
  })
}
