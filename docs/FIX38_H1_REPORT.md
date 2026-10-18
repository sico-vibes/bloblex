# FIX38 H1 — Remote pairing never completes (Tailscale and Direct)

Lane: OpenCode `opencode-go/deepseek-v4.1-flash` (high). No `git commit` was run.

The brief's hypothesis (browsers send no `Origin` on same-origin `GET`) was correct and was
the dominant cause. Digging past it exposed four more causes, two of them in the client state
machine. Every cause below has a reproduction.

## Causes found

### C1 — `require_origin` refused every `GET`, so the approval poll never ran (server)

`crates/bloblex-daemon/src/remote/web.rs` required an `Origin` header on **every** `/api/*`
request. Per the Fetch standard a browser sends **no** `Origin` on a same-origin `GET`/`HEAD`,
so the phone's `GET /api/pair` (the approval poll), `GET /api/me` and the `/api/events`
handshake-time fetches were all refused with 403 before any handler ran. This alone produces
the owner's symptom 1: after approval the poll keeps being refused, so `pairStatus()` never
returns `approved` and the phone stays on "Approve on your computer" forever.

Evidence: the Director's probes — `GET /api/pair (no Origin) → 403`; the new test
`tailscale_pairing_completes_for_a_browser` fails at `GET /api/me`/`GET /api/pair` on the old
code (403) and passes on the new.

### C2 — a failed `me()` latched the client into a permanent signed-out state (client)

`apps/desktop/src/remote/remoteTransport.ts` treated **any** `401 unauthorized` (other than the
cookie-free `/api/pair`, `/api/login`) as a sign-out and latched `isSignedOut = true`. Nothing
ever cleared it. On a fresh, never-paired phone the very first `me()` is a 401, so:

- the transport went to `signed_out` and the app showed "This device was signed out …";
- after pairing, the follow-up `me()` was refused **locally** with `device_revoked` without a
  request (`send()`'s early guard), so `check()` took the “removed on the computer” branch and
  the screen snapped back to the code screen;
- the offer was already locked/approved, so re-submitting the code returned `pairing_invalid`
  — the owner's "sometimes showing That code did not work".

This is the reload-like bounce in symptom 2.

### C3 — a failed `pairStatus()` demoted the screen (client)

`RemoteApp.check()` did `pairStatus().catch(() => 'expired')` and then
`setScreen(state === 'pending' ? 'waiting' : 'connect')`. Any transient failure (network,
offline, forbidden) was read as "expired" and pulled a waiting device back to the code screen.

### C4 — the `#pair=` code was re-read after a reload (client)

`connect()` cleared the hash with `history.replaceState` **after** `device.pair()` resolved. A
reload during the request (a service-worker update, a phone restart) re-read `#pair=` from the
address and re-submitted a code whose offer was already locked → `pairing_invalid`.

### C5 — Tailscale's one-handler removal was gated on help text the CLI no longer prints (server)

`remote::disable` only ran `tailscale serve --https=<port> off` when
`tailscale serve --help` contained the token `off`. The installed CLI (Tailscale **1.104.1**,
`C:\Program Files\Tailscale\tailscale.exe`) documents only `status`, `reset`, `drain`, `clear`,
`advertise`, `get-config`, `set-config` — **no** `off` token — yet still **accepts** the command:

```
$ tailscale serve --https=8443 off
error: failed to remove web serve: handler does not exist   (exit 1, inert port)
```

So Bitbots printed "The installed Tailscale CLI does not document turning one serve handler off,
so Bitbots left it alone." and left the handler in place (symptom 3). Note that
`tailscale serve status --json` on this machine shows the stale handler Bitbots added:
`desktop-puf7ihb.tail64dae5.ts.net:443 → / → http://127.0.0.1:48620`.

### C6 — the origin refusal was mis-coded as `unauthorized` (server/client)

`forbidden_origin()` returned `code: "unauthorized"`, so the client's `check()` treated a
wrong-address page as "not paired" (and C2's latch made it a sign-out). There was no way to show
the brief's "This page must be opened from the address shown on the computer." words.

## Fixes (file:line)

| # | Fix | Where |
|---|---|---|
| C1,C6 | Origin policy rewritten: a **safe** `GET`/`HEAD` may omit `Origin` (present ⇒ must match); `Sec-Fetch-Site` must be `same-origin`/`none`; **state-changing** methods and the **WebSocket upgrade** still require a matching `Origin`; cross-site/same-site refused; Native `Host` still checked. New code `forbidden_origin`. | `crates/bloblex-daemon/src/remote/web.rs:107-160` |
| C5 | Attempt `serve --https=<port> off` directly; treat "handler does not exist" as already-removed; warn only on a real failure. Help-text gate removed. | `crates/bloblex-daemon/src/remote/tailscale.rs:427-460`, `crates/bloblex-daemon/src/remote/mod.rs:834-848` |
| C2 | `/api/me` is exempt from the sign-out latch; a successful call clears the latch (`leaveSignedOut`). | `apps/desktop/src/remote/remoteTransport.ts:307-343`, `:376-385` |
| C3 | `check()` consults `pairStatus()` only on an explicit not-paired answer; only `pending`/`approved` move forward, and a failed probe never demotes a waiting screen. A `forbidden_origin` refusal shows the address words. | `apps/desktop/src/remote/RemoteApp.tsx:135-169` |
| C4 | Clear `#pair=` **before** the request and map the failure by code (`connectProblem`). | `apps/desktop/src/remote/RemoteApp.tsx:82-93`, `:212-226` |
| C6 | `forbidden_origin` added to the client error table with the host-address words, used by both `connectProblem` and `loginProblem`. | `apps/desktop/src/remote/remoteTransport.ts:24-36,191-204`, `RemoteApp.tsx:70-93` |

Docs updated to match: `docs/remote/PROTOCOL.md` §3 (error table), §4.1 (Origin rule), §13 (Native
checks); `docs/remote/THREAT_MODEL.md` T9, N6 and the §8 checklist line.

## Tests

**Browser-like end-to-end (Rust), `crates/bloblex-daemon/src/remote/tests.rs`.** A `Browser` +
`BrowserJar` send headers exactly as a browser does: a cookie jar that keeps what the host sets,
**no `Origin` on `GET`**, `Origin` on `POST` and the WebSocket handshake, `Sec-Fetch-Site:
same-origin`.

- `tailscale_pairing_completes_for_a_browser` (line 1960): 401 on the first `GET /api/me` (no
  Origin) → `GET /api/pair` no-Origin `expired` → `POST /api/pair` 202 pending (Origin) →
  `remote.pairing.requested` → owner approves → `GET /api/pair` no-Origin `approved` and the jar
  keeps the device cookie → `GET /api/me` no-Origin 200 tier chat → `POST /api/rpc` ok →
  WebSocket opens and streams a frame.
- `native_pairing_completes_for_a_browser` (line 2016): login → pending → approve → poll →
  cookie → `me` 200 `method: native` → rpc ok.
- `a_cross_site_request_is_refused_on_both_methods` (line 2045): cross-site `POST`
  (`forbidden_origin`), `Sec-Fetch-Site: cross-site`/`same-site` `GET`, a wrong `Origin` `GET`,
  the Tailscale origin under Native, and a cross-site Native `GET` — all 403.
- `a_websocket_upgrade_without_an_origin_is_refused` (line 2079): a handshake with no `Origin`
  is 403 (browsers always send it).
- `a_missing_handler_is_not_a_removal_failure` and
  `help_without_the_off_token_does_not_stop_removal` (tailscale.rs): the real 1.104.1 wording is
  treated as success, and removal is not gated on help text.

**Client.** `RemoteApp.mounted.test.tsx`: "keeps waiting and never re-submits when the approval
poll fails" (pair called once, stays on the waiting screen), "reloads straight into the waiting
screen without re-submitting the code", "explains an origin refusal instead of asking for a new
code", and "words a refused sign-in, code or poll by the gateway code".
`remoteTransport.test.ts`: "does not sign out on a not-paired `/api/me`, and recovers after
pairing", "never signs out on a `forbidden_origin` refusal", "recovers from a signed-out latch
once a cookie-free route succeeds again", and `forbidden_origin` added to the distinct-codes
loop.

## Gates (all green)

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast` — all
  suites `ok` (daemon: 346 passed, incl. all 73 `remote::tests`).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.
- `apps/desktop`: `npx tsc -b` clean; `npx vitest run --maxWorkers=3` — 162 files, 1143 tests
  passed; `npm run build` and `npm run build:remote` succeed.

## Still unverified

- **A real phone.** No iOS/Android device or live tailnet was available. Specifically unproven
  end to end: whether Safari/an installed PWA **keeps** the `__Host-` `Secure` device cookie
  (PROTOCOL §12 open question 1), and whether the "keeps refreshing" animation the owner saw was
  exactly the waiting/connect flip reproduced in tests or partly a phone-shell artefact.
- **Removing the live 443 handler.** The syntax was proven against the installed CLI's parser on
  an inert port; the owner's real 443 handler was **not** removed from this lane (doing so would
  change the owner's machine). The next Tailscale enable/disable on the real host exercises it.
- **Native over a public interface / TLS warning.** Only the loopback TLS listener is covered by
  tests; the certificate warning and cookie over a real public address are unverified, as before.
- The service worker was traced request-by-request (`sw/strategy.ts`, `sw/remoteSw.ts`,
  `serviceWorker.ts`): `/api/*` GETs are `network-only`, non-GET `/api/*` are `bypass`, and the
  only `location.reload()` is behind the explicit "Reload" button. No reload loop was found in
  the beta.32 build; the visible bouncing is C2/C3.
