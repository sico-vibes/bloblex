// Bitbots Remote service worker (preview stub).
// It is intentionally inert: it takes control and passes every request to the
// network. Offline caching and push wake-ups are phase P3 in docs/remote/PHASES.md;
// until then the preview must never serve a stale app shell.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => { /* network only */ })
