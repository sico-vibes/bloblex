# FIX29 (WP6c): the remote PWA build, transport and service worker

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree. Director reviews, runs the gates on the merged result and commits. **Do not run `git commit`.** Read `AGENTS.md` first, then `docs/remote/PROTOCOL.md` §3, §4.3-4.4, §6, §11 and `docs/remote/ARCHITECTURE.md`.

This is the non-visual half of the phone client: how it is built, how it talks to the gateway, and how it caches. **Do not change how anything looks**: no edits to `RemoteApp.tsx` markup, `remote.css` or any `src/ui` component. The Director wires the screens afterwards. Runs in parallel with WP6b; the gateway's HTTP contract is PROTOCOL §4.4 (`/api/pair`, `/api/me`, `/api/rpc`, `/api/events`, `/api/logout`).

Read before coding: `apps/desktop/remote.html`, `remote.webmanifest`, `remote-sw.js` (an inert stub today), `src/remote/main.tsx`, `src/remote/useRemote.ts`, `src/remote/RemoteApp.tsx` (imports only), `src/remote/remoteContract.ts`, `src/tauri.ts` (its export list), `vite.config.ts`, `vite.preview.config.ts` (the alias pattern), `src-tauri/tauri.conf.json`, `package.json`.

## 1. Build: `apps/desktop/vite.remote.config.ts`
- Input `remote.html`, `outDir: 'dist-remote'`, `emptyOutDir: true`, `base: '/'`, hashed asset names.
- Aliases, like `vite.preview.config.ts`: `../tauri` → `src/remote/remoteTauri.ts`; `../desktopIntegrations` → a remote stub; `@tauri-apps/api/(event|window|core)` and `@tauri-apps/plugin-*` → a remote stub. Nothing from `@tauri-apps` may end up in the bundle (add a test or a build-time check that greps the output for `__TAURI`/`@tauri-apps` and fails).
- `publicDir: 'remote-public'`: move `remote.webmanifest` there (fix its icon paths) and add icons 192, 512 and a 512 maskable PNG, made by copying/scaling existing files from `src-tauri/icons/` (no new npm dependency; if scaling is impossible without one, copy the closest sizes and say so in the report). `remote.html` links `/remote.webmanifest` and a real apple-touch-icon from `remote-public`.
- `package.json` script `"build:remote": "vite build --config vite.remote.config.ts"`. Add `dist-remote/` to `.gitignore`.
- Tauri: `beforeBuildCommand` becomes `npm run build && npm run build:remote`; `bundle.resources` maps `../dist-remote` to `remote-web` (use the Tauri 2 object form `{ "../dist-remote/": "remote-web/" }`). WP6b passes that folder to the daemon as `BITBOTS_REMOTE_WEB_DIR`.
- The main `npm run build` and `vite.preview.config.ts` keep working unchanged.

## 2. `src/remote/remoteTransport.ts`
A small client for the gateway, same-origin only (`credentials: 'same-origin'`; the device cookie is `HttpOnly`, so JavaScript never sees it):
- `rpc<T>(method, params)`: `POST /api/rpc` with a daemon request envelope (`{v:1, id, method, params}`, PROTOCOL §3); returns `result` or throws `RemoteCallError { code, message, status }` for `ok:false` and for HTTP errors. Codes to keep distinct: `unauthorized`, `device_revoked`, `forbidden_remote`, `tier_required`, `approvals_disabled`, `quiet_hours`, `invalid_params`, `payload_too_large`, `rate_limited`, `network`.
- `me()`: `GET /api/me`. `pair({code, name, kind, platform})`: `POST /api/pair`. `pairStatus()`: `GET /api/pair` → `pending | approved | rejected | expired`. `logout()`: `POST /api/logout`.
- `events(handler, status)`: WebSocket to `wss://<same host>/api/events`; first message `{"v":1,"afterSequence":cursor}`; cursor = highest applied `sequence`, kept in memory and `localStorage` (`bitbots.remote.cursor`, read and write inside try/catch); duplicates (sequence ≤ cursor) are ignored; reconnect with exponential backoff 1 s → 30 s with jitter, reset after 30 s of a healthy socket; pause while `document.hidden` and reconnect on `visibilitychange`/`online`; on `replay.gap` or `replayAvailable:false` call a `onResync()` callback (the app refetches `app.snapshot`) and reset the cursor to the snapshot's sequence. `status` reports `connecting | online | reconnecting | offline | signed_out` (`signed_out` on `unauthorized`/`device_revoked`, which also stops reconnecting).
- Pure and injectable for tests: accept `fetch`, `WebSocket`, `storage` and a clock in an options object.

## 3. `src/remote/remoteTauri.ts`
Exports **every name `src/tauri.ts` exports** (so any component the phone app imports still links), backed by `remoteTransport`: `rpc`, `fetchSnapshot` (`rpc('app.snapshot')`), `listenForDaemonEvents`, `listenForDaemonConnection`, `inDesktop = false`, `previewMode = false`. Everything desktop-only (file dialogs, windows, tray, updates, backups, dictation natives…) throws `new Error('Not available on a remote device.')` or returns a harmless empty value where callers expect one (document which in a comment). Add a Vitest that compares the export names of `src/tauri.ts` and `remoteTauri.ts` and fails when one is missing, so a new desktop export cannot break the remote build silently.

## 4. Service worker
- Source in TypeScript (`src/remote/sw/remoteSw.ts`), built to `/remote-sw.js` at the output root (a second rollup input with a fixed file name, or a small plugin in `vite.remote.config.ts`). Delete the old stub `apps/desktop/remote-sw.js`.
- At build time inject the precache list (every emitted asset plus `/remote.html`, manifest and icons) and a version string (hash of that list).
- Strategy, as a **pure exported function** `strategyFor(url, method)` that the worker uses and Vitest tests: `/api/*` → network only, never cached, never intercepted for non-GET; navigations and `/remote.html` → network first, cached copy when offline; hashed assets → cache first; anything else → network.
- `install` precaches; `activate` deletes caches whose version differs and claims clients. No `skipWaiting` on its own: the page asks (`postMessage({type:'skip-waiting'})`) after the user accepts the update.
- `src/remote/main.tsx`: register `/remote-sw.js` (scope `/`) only on `https:` or `localhost`; expose an `onUpdateReady(callback)` helper (fires when a new worker is installed and waiting) and `applyUpdate()` (posts skip-waiting, reloads on `controllerchange`). The Director renders the "Update ready" prompt; you only provide the two functions.
- CSP compatible: no inline scripts in `remote.html` (move the theme snippet into `main.tsx` or a module), so WP6b's `script-src 'self'` holds.

## 5. Tests (Vitest, `src/remote/`)
- Transport: envelope shape; each error code mapping; `credentials: 'same-origin'`; pairing calls; logout.
- Events: first message carries the cursor; duplicates ignored; backoff grows and caps at 30 s; reconnect resets after a healthy period; `replay.gap` triggers `onResync`; `unauthorized` → `signed_out` and no reconnect; hidden page pauses.
- `strategyFor` for each URL class; `/api/*` never cached.
- Export parity between `tauri.ts` and `remoteTauri.ts`.
- Build check: `npm run build:remote` output contains `remote.html`, `remote-sw.js`, the manifest and icons, and no `@tauri-apps` code.

## Gates
- `cd apps/desktop && npx tsc -b && npx vitest run && npm run build && npm run build:remote`
- `cargo` gates are not needed unless you touch Rust (you should not).

## Report
`docs/FIX29_WP6C_REPORT.md`: files, the transport API as implemented, the cache strategy, how the precache list is built, bundle size of `dist-remote`, tests, gate summaries, verified versus not verified (installing the PWA on a phone and iOS behaviour are not verified here).
