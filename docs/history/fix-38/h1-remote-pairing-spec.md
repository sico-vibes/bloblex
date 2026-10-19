# FIX38 H1: Remote pairing never completes (Tailscale and Direct) — dig deep

> **What this is:** Spec for FIX38 H1: Remote pairing never completes over Tailscale or Direct.
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: OpenCode `deepseek-v4.1-flash` (high), its own worktree. All code in this wave is yours (AGENTS.md, 18 October amendment). **Never run `git commit`.** Keep context small: grep, then read only what you need. Read the section headings of `AGENTS.md`, then `docs/remote/PROTOCOL.md` §4 and §13.

We have gone back and forth on Remote for several releases. **Do not stop at the first plausible cause.** Reproduce each symptom end to end the way a real browser behaves, fix every cause you find, and prove the whole flow works with a test that behaves like a browser.

## What the owner sees (beta.32, installed)

1. **Direct (Native):** the phone signs in, the desktop asks for approval, the owner approves (the activity log records "Vexor was paired", twice), but the phone stays on "Approve on your computer" forever.
2. **Tailscale:** the phone shows the pairing screen; after entering the code and a device name and pressing Connect, the page "keeps refreshing" and never gets past it, sometimes showing "That code did not work. Check it, or show a new one on the computer." No `remote.pairing.requested` event was ever recorded for those attempts.
3. **Tailscale off:** turning Remote off left the serve handler in place with: "The installed Tailscale CLI does not document turning one serve handler off, so Bitbots left it alone."

## Evidence the Director collected on the owner's machine

Against the owner's live gateway (`https://desktop-puf7ihb.tail64dae5.ts.net`, Tailscale method):

```
GET  /                        → 200 text/html (fixed in beta.32)
GET  /api/me   (Origin set)   → 401 {"error":{"code":"unauthorized",...},"method":"tailscale"}
GET  /api/pair (no Origin)    → 403 "This request did not come from this computer's Bitbots Remote address."
GET  /api/pair (Origin set)   → 200 {"state":"expired"}
POST /api/pair (Origin set, bad code) → 400 pairing_invalid
```

**Browsers do not send an `Origin` header on same-origin `GET` (or `HEAD`) requests** (Fetch standard; only CORS requests and non-GET/HEAD same-origin requests carry it). So every same-origin `GET` the phone app makes — `GET /api/pair` (the approval poll), `GET /api/me`, possibly static fetches and the `/api/events` WebSocket handshake — is refused by `require_origin` in `crates/bloblex-daemon/src/remote/web.rs`. That alone explains symptom 1: the poll never sees `approved`. It probably also feeds symptom 2 (`me()` fails, the client falls back, the service worker or a reload re-submits a code that is already locked), but **verify, don't assume**.

## Work

1. **Origin policy, done right.** For safe methods (`GET`, `HEAD`): accept a missing `Origin`; if `Origin` is present it must match; if `Sec-Fetch-Site` is present it must be `same-origin` or `none`. For state-changing methods (`POST` etc.) keep requiring a matching `Origin` (and reject `Sec-Fetch-Site: cross-site`/`same-site`). The WebSocket upgrade (`/api/events`) must keep requiring a matching `Origin` (browsers always send it there). Apply this to both methods (Tailscale and Native), keeping the per-method origin sets.
2. **Trace the whole client flow** in `apps/desktop/src/remote/` (`remoteTransport.ts`, `deviceApi.ts`, `RemoteApp.tsx`, `serviceWorker.ts`, the service worker in `src/remote/sw/`): every request the phone makes, its method, headers (`credentials`), and what it does on each failure. Find why Tailscale pairing "keeps refreshing" (a reload loop from the service worker update path, `history.replaceState`, a re-submitted code after a reload, the `#code` hash being re-read, etc.) and fix it. A failed `me()` or `pairStatus()` must never send the user back to an earlier screen or re-submit a code.
3. **Cookies.** Check the device cookie and the pairing cookie attributes (`__Host-` prefix rules: `Secure`, `Path=/`, no `Domain`) and that the approval poll (`GET /api/pair`) sets the device cookie the browser will keep, for both methods (Tailscale serve terminates TLS and proxies plain HTTP to `127.0.0.1:48620`; the browser still sees HTTPS). Check `Native` login → pending → approval → `GET /api/pair` → cookie → `GET /api/me` 200.
4. **Error words on the phone.** "That code did not work" is shown for *any* failure today. Map codes properly: `pairing_invalid` → the code message; origin/forbidden → "This page must be opened from the address shown on the computer."; `rate_limited`, `network` and others with their own words.
5. **Turning Tailscale Remote off** must remove Bitbots' own serve handler. Read the installed CLI's real help (`tailscale serve --help`, `tailscale serve status --json`; Tailscale is installed on this machine) and use the documented way to remove one handler (for example `tailscale serve --https=443 off`, or `tailscale serve --bg --https=443 --set-path=/ off`, whichever this CLI version documents). Never `tailscale serve reset`, never Funnel. Keep the fake-CLI tests in step with the real syntax.

## Proof (required)

- **Browser-like end-to-end tests** in `crates/bloblex-daemon/src/remote/tests.rs` for both methods, using an HTTP client with a cookie jar that sends headers exactly as a browser would: **no `Origin` on GETs**, `Origin` on POSTs and the WebSocket upgrade, `Sec-Fetch-Site: same-origin`. Tailscale: pair begin → POST code (202 pending) → owner approves → `GET /api/pair` (no Origin) returns approved and sets the cookie → `GET /api/me` (no Origin) 200 → `POST /api/rpc` works → WebSocket opens. Native: login → pending → approve → poll → cookie → me → rpc. Plus: a cross-site POST (`Origin: https://evil.example`) and a `Sec-Fetch-Site: cross-site` GET are refused.
- **Client tests** (`RemoteApp.mounted.test.tsx`, `remoteTransport.test.ts`): after approval the app reaches the bots screen; a failed poll keeps the waiting screen without re-submitting; error words per code.
- Update `docs/remote/PROTOCOL.md` §4.1 and `docs/remote/THREAT_MODEL.md` (the Origin rule) to match.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"` (foreground; wait)
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cd apps/desktop && npx tsc -b && npx vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests |FAIL"`, `npm run build`, `npm run build:remote`

Write `docs/history/fix-38/h1-report.md`: every cause you found (with evidence), every fix (file:line), the tests, and what is still unverified on a real phone.
