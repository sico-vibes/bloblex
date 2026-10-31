// The remote service worker. Built to `/remote-sw.js` at the output root as a
// second rollup input; the precache list and its version hash are injected by
// `vite.remote.config.ts` at build time, replacing the two string literals
// below (`__SW_PRECACHE__` and `__SW_VERSION__`). A unit test asserts the built
// file no longer contains either placeholder.
//
// It is a single self-contained classic script: it imports `strategyFor` in
// source, but rollup inlines that into the one worker chunk. The build fails if
// the worker chunk ever gains an import, so the page registers it without
// `type: 'module'` (which keeps the oldest installed browsers able to run it).
//
// Behaviour (FIX29 WP6c, spec §4):
//   - `install`  precaches the shell and waits (no `skipWaiting` of its own);
//   - `activate` drops caches from other versions and claims clients;
//   - `fetch`    routes through `strategyFor`, with navigations network-first;
//   - `message`  `{type:'skip-waiting'}` promotes the waiting worker after the
//                page asks (the "Update ready" prompt).

import { strategyFor, type RemoteFetchStrategy } from './strategy'

/** Node-only globals are absent in a worker; `self` is the worker global. */
const sw = self as unknown as {
  addEventListener(type: string, listener: (event: unknown) => void): void
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void> }
  location: { origin: string }
}

interface SwEvent {
  waitUntil(promise: Promise<unknown>): void
}

interface SwFetchEvent extends SwEvent {
  request: Request
  respondWith(response: Response | Promise<Response>): void
}

interface SwMessageEvent {
  data: unknown
}

const CACHE_PREFIX = 'bitbots-remote-'

// --- injected at build time -------------------------------------------------
// Both literals are rewritten by `vite.remote.config.ts` after the bundle is
// formed; the casts only exist so TypeScript sees the right shapes here.
const PRECACHE: string[] = '__SW_PRECACHE__' as unknown as string[]
const VERSION: string = '__SW_VERSION__'
// ---------------------------------------------------------------------------

const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) void cache.put(request, response.clone())
  return response
}

async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    if (response.ok) void cache.put(request, response.clone())
    return response
  } catch (reason) {
    const hit = (await cache.match(request)) ?? (await cache.match('/remote.html'))
    if (hit) return hit
    throw reason
  }
}

function respond(event: SwFetchEvent, strategy: RemoteFetchStrategy): void {
  if (strategy === 'bypass') return
  if (strategy === 'cache-first') {
    event.respondWith(cacheFirst(event.request))
    return
  }
  if (strategy === 'network-first') {
    event.respondWith(networkFirst(event.request))
    return
  }
  // `network-only` and `network`: straight to the network, no cache either way.
  event.respondWith(fetch(event.request))
}

sw.addEventListener('install', (raw) => {
  const event = raw as SwEvent
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await cache.addAll(PRECACHE)
  })())
})

sw.addEventListener('activate', (raw) => {
  const event = raw as SwEvent
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)))
    await sw.clients.claim()
  })())
})

// Phase 6: a notice from the computer. It holds a title and a conversation id, nothing else.
sw.addEventListener('push', (raw) => {
  const event = raw as SwEvent & { data?: { json(): { title?: unknown; sessionId?: unknown } } | null }
  let body: { title?: unknown; sessionId?: unknown } = {}
  try { body = event.data?.json() ?? {} } catch { /* a notice we can't read still says something */ }
  const title = typeof body.title === 'string' && body.title ? body.title : 'Bitbots'
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
  const worker = self as unknown as { registration: { showNotification(title: string, options: unknown): Promise<void> } }
  event.waitUntil(worker.registration.showNotification(title, { tag: sessionId ?? 'bitbots', icon: '/icons/icon-192.png', data: { sessionId } }))
})

sw.addEventListener('notificationclick', (raw) => {
  const event = raw as SwEvent & { notification: { close(): void; data?: { sessionId?: string | null } } }
  event.notification.close()
  const sessionId = event.notification.data?.sessionId
  const clients = (self as unknown as { clients: { matchAll(options: unknown): Promise<Array<{ focus(): Promise<unknown>; navigate(url: string): Promise<unknown> }>>; openWindow(url: string): Promise<unknown> } }).clients
  const target = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/'
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((open) => open[0] ? open[0].navigate(target).then(() => open[0].focus()) : clients.openWindow(target)))
})

sw.addEventListener('message', (raw) => {
  const data = (raw as SwMessageEvent).data as { type?: unknown } | null
  if (data && data.type === 'skip-waiting') void sw.skipWaiting()
})

sw.addEventListener('fetch', (raw) => {
  const event = raw as SwFetchEvent
  const request = event.request
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (url.origin !== sw.location.origin) return
  const strategy: RemoteFetchStrategy = request.mode === 'navigate'
    ? 'network-first'
    : strategyFor(request.url, request.method)
  respond(event, strategy)
})
