// Which cache strategy the remote service worker uses for a request. Pure and
// exported so Vitest can pin it down without a browser or a real cache.
//
// FIX29 WP6c, spec §4.

export type RemoteFetchStrategy =
  /** Pass straight through to the network; never read or write a cache. */
  | 'network-only'
  /** Try the network, fall back to the cached copy (navigations, the shell). */
  | 'network-first'
  /** Serve the cached copy first; hashed asset names never change content. */
  | 'cache-first'
  /** Plain network, no cache involvement, still intercepted. */
  | 'network'
  /** Do not intercept at all; the browser handles the request directly. */
  | 'bypass'

/** Vite's `name-<hash>.ext` asset names: the content behind them never changes. */
const HASHED_ASSET = /-[A-Za-z0-9_]{5,}\.[a-z0-9]+$/

function pathOf(url: string): string {
  try {
    const parsed = new URL(url, 'https://remote.invalid')
    return parsed.pathname || '/'
  } catch {
    return url.startsWith('/') ? url : `/${url}`
  }
}

/**
 * `url` may be absolute or a path; `method` may be any case. Everything under
 * `/api/` is never cached, and a non-GET `/api/` call is not intercepted at all.
 */
export function strategyFor(url: string, method: string): RemoteFetchStrategy {
  const path = pathOf(url)
  const verb = (method || 'GET').toUpperCase()
  if (path === '/api' || path.startsWith('/api/')) return verb === 'GET' ? 'network-only' : 'bypass'
  if (path === '/' || path === '/remote.html') return 'network-first'
  if (path.startsWith('/assets/') || HASHED_ASSET.test(path)) return 'cache-first'
  return 'network'
}
