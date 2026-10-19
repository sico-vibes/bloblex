# FIX29 (WP6c) report: the remote PWA build, transport and service worker

> **What this is:** Report on FIX29 (WP6c): the remote PWA build, transport and service worker.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, worktree `C:\fx47`, branch `lane/fix29-wp6c`.
Spec: `docs/history/fix-29/wp6c-pwa-spec.md`. Status: implemented, all gates green, **no commit made**
(the Director reviews and commits).

Nothing in this change touches UI or UX: `RemoteApp.tsx`, `remote.css` and every `src/ui`
component are untouched. The only edit to a rendered file is `remote.html`, where the two
`<head>` links were retargeted and the inline theme script was removed (spec §4, CSP note).

---

## 1. Files

### Added

| File | Lines | What it is |
|---|---|---|
| `apps/desktop/vite.remote.config.ts` | 134 | The `dist-remote` PWA build plus the two build plugins (precache injection, native-marker ban). |
| `apps/desktop/src/remote/remoteTransport.ts` | 566 | The gateway client: `rpc`, `me`, `pair`, `pairStatus`, `logout`, the events socket, cursor and backoff. |
| `apps/desktop/src/remote/remoteTauri.ts` | 292 | Drop-in for `src/tauri.ts` on a device; every desktop export, backed by the transport or a stub answer. |
| `apps/desktop/src/remote/serviceWorker.ts` | 76 | Registration (`https:`/localhost only) and the `onUpdateReady` / `applyUpdate` pair. |
| `apps/desktop/src/remote/sw/remoteSw.ts` | 125 | The worker: install / activate / message / fetch. |
| `apps/desktop/src/remote/sw/strategy.ts` | 41 | Pure `strategyFor(url, method)`. |
| `apps/desktop/src/remote/remoteTauriAppsStub.ts` | 58 | Alias target for every native Tauri npm module. |
| `apps/desktop/src/remote/remoteDesktopIntegrations.ts` | 17 | Alias target for `../desktopIntegrations`. |
| `apps/desktop/remote-public/remote.webmanifest` | — | Moved from `apps/desktop/remote.webmanifest`; icon paths now `/icons/*`. |
| `apps/desktop/remote-public/icons/{icon-192,icon-512,icon-512-maskable,apple-touch-icon-180}.png` | — | PWA icons. |
| `src/remote/remoteTransport.test.ts` | 382 | 25 tests. |
| `src/remote/remoteBuild.test.ts` | 103 | 7 tests; runs the real build. |
| `src/remote/remoteTauri.parity.test.ts` | 68 | 5 tests. |
| `src/remote/sw/strategy.test.ts` | 54 | 7 tests. |
| `src/remote/serviceWorker.test.ts` | 29 | 4 tests. |

### Changed

| File | Change |
|---|---|
| `apps/desktop/package.json` | `"build:remote": "vite build --config vite.remote.config.ts"`. |
| `apps/desktop/remote.html` | Manifest link kept; apple-touch-icon now `/icons/apple-touch-icon-180.png`; added a real `icon`; **inline theme script removed**. |
| `apps/desktop/src/remote/main.tsx` | Theme handshake moved here; registers the worker; re-exports `onUpdateReady` / `applyUpdate` / `updateIsReady`. |
| `apps/desktop/src-tauri/tauri.conf.json` | `beforeBuildCommand` → `npm run build && npm run build:remote`; `bundle.resources` → `{ "../dist-remote/": "remote-web/" }` (Tauri 2 object form, as specified for WP6b's `BITBOTS_REMOTE_WEB_DIR`). |
| `apps/desktop/tsconfig.json` | `vite.remote.config.ts` added to `include`, so `tsc -b` type-checks the new build config too. |
| `.gitignore` | `apps/desktop/dist-remote/`. |

### Deleted

- `apps/desktop/remote-sw.js` (the inert stub) — replaced by the built `/remote-sw.js`.
- `apps/desktop/remote.webmanifest` — moved into `remote-public/`.

### Icon sourcing (spec deviation, stated plainly)

The spec said to copy/scale from `src-tauri/icons/`. **That directory does not exist in this
repository**; the app icons live at `assets/icon/`. The four PNGs were made from
`assets/icon/bloblex-master.png` (1024×1024) with PowerShell `System.Drawing` — a real resize,
not a rename, and **no npm dependency was added**. `icon-512-maskable.png` draws the artwork at
80% inside a 512×512 `#0e0e0e` canvas (the maskable safe zone). The build test asserts the real
PNG header dimensions of all four files.

---

## 2. The transport API as implemented

`createRemoteTransport(options)` returns a `RemoteTransport`. Everything external is injected:
`fetch`, `socket` (the `WebSocket` seam — a `(url) => RemoteSocket` factory whose default is the
browser `WebSocket`), `storage`, `visibility`, `location`, `online`, `setTimer` / `clearTimer`
(the clock), `now`, `random` and `onResync`.

```ts
rpc<T>(method: string, params?: JsonRecord): Promise<T>   // POST /api/rpc
me(): Promise<RemoteMe>                                   // GET  /api/me
pair(input: RemotePairInput): Promise<{ state: RemotePairState }>  // POST /api/pair
pairStatus(): Promise<RemotePairState>                    // GET  /api/pair
logout(): Promise<void>                                   // POST /api/logout
events(handler, status): () => void                       // WS   /api/events
setCursor(sequence: number): void; getCursor(): number
connectionStatus(): RemoteConnectionStatus; signedOut(): boolean; dispose(): void
```

- **Envelope.** `{ v: 1, id: 'req_<base36>', method, params }`; each call gets a fresh id.
  Every request uses `credentials: 'same-origin'`; the `HttpOnly` device cookie is never read
  by JavaScript.
- **Errors.** `RemoteCallError { code, message, status }`, thrown for `ok:false` and for HTTP
  failures. Distinct codes: `unauthorized`, `device_revoked`, `forbidden_remote`,
  `tier_required`, `approvals_disabled`, `quiet_hours`, `invalid_params`, `payload_too_large`,
  `rate_limited`, `network`. A body with no envelope falls back to `codeForStatus`
  (401/403/413/429/other). A fetch that throws is `network`, status 0.
- **Sign-out.** A 401/`device_revoked` on any route except `/api/pair` flips the transport to
  `signed_out`, clears the cursor, closes the socket and stops reconnecting. `/api/pair` is
  explicitly excluded: it runs without the device cookie, so `pairing_invalid` must not be
  read as a sign-out.
- **Events.** `wss://<same host>/api/events` (`ws:` on an insecure origin). The first message is
  `{"v":1,"afterSequence":<cursor>}`. The cursor is the highest applied `sequence`, held in
  memory and in `localStorage['bitbots.remote.cursor']` (read and write inside `try/catch`).
  A frame whose `sequence` is ≤ the cursor is dropped (the daemon replays over a live
  subscription). Backoff is `min(30 s, 1 s × 2^attempt)` plus up to 250 ms of jitter, and the
  attempt counter resets after 30 s of a healthy socket. A hidden page closes the socket and
  goes `offline`; `visibilitychange` (visible) and `online` reopen it immediately. `replay.gap`
  and `replayAvailable:false` call `onResync()`; `setCursor()` is how the app applies the fresh
  snapshot's sequence.
- **Status.** `connecting | online | reconnecting | offline | signed_out` is reported through the
  `status` callback given to `events`.

### `remoteTauri.ts`

All **74** names `src/tauri.ts` exports are present (plus four remote-only ones:
`createRemoteTransport`, `RemoteTransport`, `RemoteConnectionStatus`, `UnlistenFn`). Backed by
the transport: `rpc`, `fetchSnapshot` (`rpc('app.snapshot')`, then `setCursor(snapshot.sequence)`),
`listenForDaemonEvents`, `listenForDaemonConnection`, `permissionsPolicyGet`, `runtimeCapabilities`,
`runtimeModels`, `execSnapshotLatest`, `fetchUsageAnalytics`; `inDesktop = false`,
`previewMode = false`. One shared socket fans out to all listeners.

Deliberate answers for the rest, each commented in the file:

- **throw `Not available on a remote device.`** — `stagePromptAttachment`, `writeMarkdownExport`,
  `readBlobImport`, `writeBlobExport`, `writeBackupExport`, `previewBackupImport`,
  `inspectLocalFile`, `openInEditor`, `revealInExplorer`, `resolveProjectFile`,
  `updatesSetPreferences`, `updatesInstall`, `downloadSpeechModel`, `startDictation`.
- **harmless empty value** — dialogs return `null` ("cancelled"); `companionMonitorOptions()`
  returns `[]`; `currentCompanionMonitor()` and `updatesGetState()` return `null`;
  `updatesCheck()` returns `{ status:'error', checkedAt:'', error:'unavailable' }`;
  `speechModels()` returns `[]`; `dictationModelStatus()` returns `ready:false`;
  `dictationCloudWarm()` returns all-false; every `listenFor*` returns a no-op unlisten;
  window/tray/companion/quit calls are no-ops; `stopDictation`/`cancelDictation` are no-ops.
- Session/runtime selection (`getActiveSession`, `setActiveRuntime`, …) is kept in memory only.

A `resync` on the shared transport refetches `app.snapshot` through the gateway and applies its
`sequence` as the new cursor, so a gap recovers without the UI having to act.

---

## 3. The cache strategy

`strategyFor(url, method)` is pure and returns one of five values; the worker uses it, and
`strategy.test.ts` pins every URL class.

| Request | Strategy | Meaning |
|---|---|---|
| `/api/*`, `GET` | `network-only` | Intercepted, straight to the network, never read from or written to a cache. |
| `/api/*`, non-`GET` | `bypass` | **Not intercepted at all**; the browser handles it. |
| `/` and `/remote.html` | `network-first` | Network, falling back to the cached copy when offline. |
| navigations (`request.mode === 'navigate'`) | `network-first` | Forced in the fetch handler, whatever the URL. |
| `/assets/*` or any `…-<hash>.ext` | `cache-first` | Cached copy first; hashed names never change content. |
| anything else | `network` | Plain network, no cache involvement. |

Cache name is `bitbots-remote-<version>`. `install` precaches the injected list; `activate`
deletes every `bitbots-remote-*` cache whose name differs and then calls `clients.claim()`.
The worker never calls `skipWaiting` by itself — the page posts `{type:'skip-waiting'}` from
`applyUpdate()` after the user accepts, and reloads on `controllerchange`.

`strategyFor('/api/…')` can never return a cache-using strategy; a test asserts that for GET,
POST, PUT and DELETE.

---

## 4. How the precache list is built

`vite.remote.config.ts` runs `bitbots:remote-sw-manifest` as a `post` `generateBundle` hook:

1. take every key of the rollup bundle minus `.map` files, minus `remote-sw.js` itself;
2. add every file in `publicDir` (`remote-public/`), read from disk — rollup never sees these,
   and they are where the manifest and icons live;
3. add `/remote.html`; de-duplicate; sort for a stable hash;
4. `version = sha256(list.join('\n')).slice(0,16)`;
5. rewrite the worker's two literals: `__SW_PRECACHE__` → the JSON array,
   `__SW_VERSION__` → the quoted hash. If either placeholder survives, the build fails.

The shipped list has **20 entries**: 14 hashed assets, 4 icons, `/remote.html` and
`/remote.webmanifest`. In the final build reported here, the version literal is
`"260cad62daec67e1"` (it changes whenever the list changes).

A second `post` hook, `bitbots:remote-forbid-native`, scans every emitted chunk/asset for
`@tauri-apps`, `__TAURI` and `__TAURI_INTERNALS__` and fails the build on a hit. **Verified to
fire**: a temporary `@tauri-apps/probe` side effect in `remoteTauri.ts` failed the build with
`remote build: "@tauri-apps" reached assets/remote-Ski5xsVG.js`; the probe was removed and
reverted (build green again).

Aliases: `../tauri` → `remoteTauri.ts`; `../desktopIntegrations` → `remoteDesktopIntegrations.ts`;
`@tauri-apps/api/(event|window|core|webviewWindow)` and `@tauri-apps/plugin-*` →
`remoteTauriAppsStub.ts`. The spec listed `(event|window|core)`; `webviewWindow` was added
because `src/transport/nativeBridge.ts` imports it, and covering it is strictly stronger.

---

## 5. Bundle size of `dist-remote`

21 files, 650 KB on disk.

| Output | Size | gzip |
|---|---|---|
| `assets/remote-<hash>.js` | 351.47 kB | 115.07 kB |
| `assets/remote-<hash>.css` | 43.77 kB | 8.58 kB |
| `assets/bitbots-<hash>.css` | 54.01 kB | 7.59 kB |
| `remote-sw.js` | 2.27 kB | 1.03 kB |
| `remote.html` | 1.15 kB | 0.57 kB |
| 4 icons | 76.6 kB | (PNG, already compressed) |
| 6 font files + 4 font CSS | 74.6 kB | — |
| `assets/bloblex-128-<hash>.png` | 5.28 kB | — |

A test fails if the whole directory exceeds 1.5 MB, so a desktop-only graph cannot drift in
unnoticed. `remote-sw.js` is a single self-contained classic script — the plugin fails the build
if that chunk ever gains a static or dynamic import.

---

## 6. Tests (48 added)

| File | Tests | Covers |
|---|---|---|
| `remoteTransport.test.ts` | 25 | envelope shape (v/id/method/params, unique ids), `credentials: 'same-origin'`, all ten error codes, bare-HTTP fallback via `codeForStatus`, network failure, pairing POST/GET bodies, `pairing_invalid` is not a sign-out, `/api/me`, logout + cursor reset, first frame carries the cursor, duplicate/out-of-order sequences ignored, malformed frames dropped, `setCursor`, backoff growth/cap/non-decreasing, first reconnect at 1 s then 2 s, reset after 30 s healthy, `replay.gap` and `replayAvailable:false` → `onResync`, `unauthorized` → `signed_out` with no reconnect, hidden-page pause and resume, unsubscribe closes the socket. |
| `strategy.test.ts` | 7 | every URL class; `/api/*` never cache-using for GET/POST/PUT/DELETE. |
| `remoteTauri.parity.test.ts` | 5 | 74 exported names parsed and all present; no native import; `inDesktop`/`previewMode` false; desktop-only calls throw or return an empty value. |
| `remoteBuild.test.ts` | 7 | runs `npm run build:remote`, then: required files exist; hashed names; no `@tauri-apps`/`__TAURI`; precache + version injected, no placeholders, no worker import; icon PNG dimensions and manifest icons exist; no inline `<script>` in `remote.html`; total size bound. |
| `serviceWorker.test.ts` | 4 | nothing waiting; `applyUpdate()` no-op; `onUpdateReady` returns an unsubscribe; registration is safe without the API. |

---

## 7. Gate summaries

Run from `apps/desktop`, after the final edit and on the final tree:

| Gate | Result |
|---|---|
| `npx tsc -b` | exit 0 |
| `npx vitest run` | **142 files / 948 tests passed**, 0 failed. The five new test files contribute 48 of those tests; the other three files under `src/remote/` (`RemoteApp.mounted`, `remoteTiers`, `remoteTiers.parity`) are unchanged and green. |
| `npm run build` | exit 0 (5.3 s), desktop `dist/` unchanged in shape |
| `npm run build:remote` | exit 0 (2.0 s), 1633 modules, artifacts above |

No cargo gate was run: no Rust file was touched.

---

## 8. Verified vs not verified

**Verified here (independent of my own claims):**

- All four gates pass on this tree; the whole 142-file suite is green.
- The built artifacts contain the shell, the worker, the manifest and the four icons; the icons'
  real PNG headers are 192×192, 512×512, 512×512 and 180×180; every manifest icon exists.
- The built `remote.html` has **no inline script** and points at `/remote.webmanifest` and
  `/icons/apple-touch-icon-180.png`.
- The built worker carries a 20-entry precache list and a 16-hex version, and no `__SW_`
  placeholder survives.
- No `@tauri-apps` or `__TAURI` string exists anywhere in `dist-remote`.
- The native-marker build guard genuinely fails a build (probe run and reverted).
- `src/tauri.ts` exports 74 names; `remoteTauri.ts` exports all 74.

**Not verified here:**

- **Installing the PWA on a phone, and iOS behaviour.** Untested — no device, no browser. iOS
  cookie persistence across installation, standalone-mode quirks, and whether the maskable icon
  looks right are open (PROTOCOL §12 lists the cookie question).
- **The service worker at runtime.** `install`, `activate`, the `fetch` handler and the
  `skip-waiting` message are only read and built here; the pure `strategyFor` decision is tested,
  the browser execution of the worker is not.
- **The update prompt.** `onUpdateReady`/`applyUpdate` are unit-tested for their no-op paths;
  a real waiting worker and `controllerchange` reload were not exercised.
- **A live gateway.** WP6b does not exist yet, so every transport test uses a fake `fetch` and a
  fake socket. No request has been made to a real host, and the pairing flow has not run
  end to end.
- **The Tauri resource mapping.** `bundle.resources` and `beforeBuildCommand` are config changes;
  no installer was built (that needs a cargo/Tauri build), so `remote-web/` inside a real
  installer was not inspected.
- **The theme handshake.** Its removal from `remote.html` is verified; whether moving it into
  `main.tsx` introduces a visible flash for a light-mode user on first paint is not measured.
- **The `this.error` path for a surviving `__SW_` placeholder.** The guard exists; only the
  native-marker guard was exercised negatively.
- **`.gitignore`.** `dist-remote/` is listed; nothing was committed, so it was not observed to be
  ignored by git.

**Judgement calls worth a reviewer's eye:**

1. `src/remote/sw/strategy.ts` and the worker are a classic script pair (the worker chunk must
   stay import-free, enforced at build time) rather than a module worker. This widens browser
   compatibility; the trade-off is the build guard.
2. The `webviewWindow` alias is beyond the spec's literal list (see §4).
3. The icons come from `assets/icon/` rather than the spec's `src-tauri/icons/`, which does not
   exist (see §1).
4. `remoteTauri.ts` performs the post-gap `app.snapshot` refetch and cursor reset itself, rather
   than only handing the app an `onResync` hook, so a gap recovers even if the UI does not react.
5. `tsconfig.json` now includes `vite.remote.config.ts`, so the new build config is inside the
   `tsc -b` gate.
