# FIX29 WP6b — the remote gateway in `bitbotsd` over Tailscale

> **What this is:** Report on FIX29 WP6b: the remote gateway in the daemon over Tailscale.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash` (worktree `C:\fx49`, private
`CARGO_TARGET_DIR=C:/fxtarget`). A previous session wrote most of the package
and stopped; this session finished it, fixed the failing gates and wrote this
report. No `git commit` was run, and the real `tailscale` binary was never
executed.

## Files

New / changed in this package:

- `crates/bloblex-daemon/src/remote/mod.rs` — `RemoteState` in `AppState`, the
  `remote.*` dispatch, enable/disable lifecycle, start-at-boot.
- `crates/bloblex-daemon/src/remote/tailscale.rs` — `TailscaleCli` trait, the
  real `std::process::Command` implementation and the `FakeCli`, status/help
  parsing, the serve add/remove argv.
- `crates/bloblex-daemon/src/remote/pairing.rs` — offers, pending requests, the
  pair cookie, token creation and constant-time comparison.
- `crates/bloblex-daemon/src/remote/web.rs` — the axum router, the §4.1 request
  checks, the §4.5 pipeline and the §6 event sockets.
- `crates/bloblex-daemon/src/remote/tests.rs` — the integration tests (fake CLI,
  temp databases, ephemeral ports).
- `crates/bloblex-daemon/src/main.rs` — `remote` module, the `remote.*` arms,
  the `settings.set` refusal for `remote.` keys.
- `crates/bloblex-storage/src/lib.rs` — `ensure_remote_schema`, the
  `remote_device_*` and `remote_activity_*` methods.
- `apps/desktop/src/remote/tiers.json` — the 12 `remote.*` methods (`never`)
  and the 5 `remote.*` events (`drop`).
- `apps/desktop/src-tauri/src/lib.rs` — `BITBOTS_REMOTE_WEB_DIR` when a
  `remote-web` resource folder exists.
- `apps/desktop/src/remote/remoteTiers.parity.test.ts` — the dispatch extractor
  now joins rustfmt multi-line alternation arms (see "Fixes" below).

## Routes (`web.rs`)

Mounted under `/api`:

| Route | Methods | Notes |
| --- | --- | --- |
| `/api/pair` | `POST`, `GET` | Start/poll a pairing request; the only route that runs without a device cookie. |
| `/api/me` | `GET` | The signed-in device and host status. |
| `/api/rpc` | `POST` | The §4.5 pipeline. |
| `/api/events` | `GET` (WebSocket) | First frame `{"v":1,"afterSequence":n}`, then replay and live. |
| `/api/logout` | `POST` | Signs the device out, closes its socket, clears the cookie. |
| everything else | `GET` | Static files from the startup manifest; `/` falls back to the built-in "not installed" page. |

Security headers on every response: the exact CSP from the spec,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
`Cache-Control: no-store` on `/api/*`.

## RPCs (`remote.rpc` in `mod.rs`)

`remote.status`, `remote.enable`, `remote.disable`, `remote.pair.begin`,
`remote.pair.cancel`, `remote.pair.confirm`, `remote.devices.list`,
`remote.devices.update`, `remote.devices.revoke`, `remote.security.get`,
`remote.security.set`, `remote.activity.list`.

Events emitted: `remote.changed`, `remote.device.changed`,
`remote.pairing.requested`, `remote.pairing.completed`, `remote.activity` — all
classified `drop` in `tiers.json`.

`remote.status` never carries the login or raw Tailscale JSON.
`remote.pair.begin` returns `url` = serve origin + `/` and `qrPayload` = that URL
plus `#pair=<code>`.

## Exact `tailscale` argv

Only these three commands are ever issued (production); the two forbidden forms
are refused before they reach the CLI by `run_checked`/`is_forbidden_argv`.

| Action | argv |
| --- | --- |
| Read node state | `tailscale status --json` |
| Read serve state | `tailscale serve status --json` |
| Capability probe | `tailscale serve --help` |
| Turn Remote on (443 free) | `tailscale serve --bg --https=443 http://127.0.0.1:<remotePort>` |
| Fall back (443 taken) | `tailscale serve --bg --https=8443 http://127.0.0.1:<remotePort>` |
| Turn Remote off | `tailscale serve --https=<servePort> off` |

Never issued: `tailscale funnel …`, `tailscale serve reset`.

**CLI version.** No version string is hard-coded. The `off` form is not assumed:
`help_documents_off` runs `tailscale serve --help` and requires the `off` token
as its own word (`off`/`[off]`); if the installed CLI does not document it,
disabling Remote reports an error rather than silently leaving a handler behind.
The `--bg --https=<port> <target>` form is the documented `tailscale serve`
syntax. Because the real binary was never run here (hard rule), the installed
version and its help text were **not** observed — see "Not verified".

## Request checks and pipeline

In order: Origin equals the serve origin (403, also on the WS upgrade) → device
cookie → revocation / idle expiry → `Tailscale-User-Login` match when present →
body ≤ 256 KiB → per-device token bucket (20/s, burst 40). Then quiet hours →
`policy::authorize` (device tier + `approvalsFromRemote`) → `dispatch` →
`policy::redact_result` → a content-free activity line for writes, approvals and
denials.

## Fixes made this session

1. **Storage `remote_device_sign_out`** cleared `token_sha256`, so a signed-out
   cookie produced `unauthorized` instead of the `device_revoked` PROTOCOL §11
   requires. It now sets only `signed_out_at`, keeping the hash so the gateway
   can answer `device_revoked` (the hash still never authorises again).
2. **`web.rs authenticate`** — clippy `result_large_err` (a `Response` error is
   >100 bytes). The error is now `Box<Response>` via a small `deny` helper; the
   four call sites deref once.
3. **Test bugs**: the loopback test hard-coded port 48620 while the gateway
   deliberately binds an ephemeral port (0) for test isolation — it now expects
   the bound port; the header test compared `Content-Security-Policy` against
   hyper's lowercase wire form.
4. **`remoteTiers.parity.test.ts`** — the extractor only matched arms on one
   line, so the rustfmt-wrapped 12-method `remote.*` arm parsed as zero methods
   and every rule looked stale. It now joins a continuation line starting with
   `|` into the arm until `=>` appears.

## Tests

Remote-module tests (75): `remote::tests` (integration, fake CLI + temp DB),
`remote::tailscale::tests` (JSON parsing, serve argv, forbidden argv),
`remote::pairing::tests` (codes, attempts, expiry, token hashing),
`remote::policy::tests` (WP6a). Coverage against the spec's list:

- Tailscale parsing: running, logged out, HTTPS off, Funnel on, 443 taken → 8443,
  our own handler on 443 is not "taken", both ports taken → `port_in_use`, DNS
  trailing dot removed, cert domains from the self node.
- Forbidden argv: after enable, disable and a failed enable, plus direct
  `is_forbidden_argv`/`run_checked` assertions.
- Listener binds loopback IPv4 (port 0 in tests).
- Pairing: expiry, five wrong attempts burn, first correct code locks the offer
  (a later correct code is `pairing_invalid`), uniform `pairing_invalid`, reject
  burns, approve sets `HttpOnly; Secure; SameSite=Strict; Path=/` and stores only
  the hash, one live offer, cancel.
- Auth: missing/wrong Origin → 403 (HTTP and WS upgrade); no cookie → 401
  `unauthorized`; revoked → 401 `device_revoked`; signed out → 401
  `device_revoked`; login mismatch → 401 + activity line; idle expiry; body
  > 256 KiB → `payload_too_large`; rate limit → `rate_limited`.
- Pipeline: viewer cannot `session.prompt` (`tier_required`); quiet hours refuse
  chat but allow reads; `permission.reply` refused with approvals off;
  `runtime.models {refresh:true}` → `invalid_params`; attachments refused; a
  `never` method → `forbidden_remote`; results redacted (`customEnv` → `{}`); one
  content-free activity line per write.
- Capability: every `/api/rpc` response and every WS frame is serialized and
  asserted not to contain the capability string.
- Events: replay from a cursor then live; a `drop` event never sent; a second
  socket closes the first; revoke closes the socket; unpaired socket refused.
- Static: a manifest file is served, traversal (`/../…`, `%2e%2e`, absolute,
  backslash) is 404, absent manifest serves the built-in page.
- `settings.set` refuses every `remote.*` key; the activity table keeps ≤ 500
  rows; the tier table lists all 12 methods as `never`.

## Gates

| Gate | Result |
| --- | --- |
| `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast` | **pass** — every `test result: ok`, 0 failed (daemon bin 93, storage 291, etc.) |
| `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` | **pass** — clean |
| `cargo test -p bloblex-desktop --lib` | **blocked** — build script: `resource path binaries\bitbotsd-x86_64-pc-windows-msvc.exe doesn't exist` (the sidecar is not built in this worktree). The Director runs it after staging the sidecar. |
| `cd apps/desktop && npx tsc -b` | **pass** — no output |
| `cd apps/desktop && npx vitest run src/remote` | **pass** — 4 files, 125 tests |

`cargo build -p bloblex-daemon` succeeds.

## Hard rules

- `0.0.0.0` / `[::]` appear only in a comment saying they are never bound; the
  listener binds `("127.0.0.1", port)`.
- `funnel` / `serve reset` appear only in the `is_forbidden_argv` guard, the
  `run_checked` refusal and assertions/comments — never in issued argv.
- The gateway calls `dispatch()` in-process and never reads, accepts, logs or
  returns the daemon capability.
- `tailscale status --json` output is parsed, never logged; no cookies, tokens
  or token hashes are logged. Only `sha256(token)` is stored.

## Verified

- Compiles; the full non-desktop workspace test suite and clippy pass.
- The TypeScript build and the `src/remote` vitest suite pass.
- All gateway behaviour above is exercised through the `FakeCli` and temp
  databases, including the §4.1/§4.5 pipeline, the §6 sockets and redaction.

## Not verified

- **Live Tailscale.** No test or check ran the real binary, by rule. The
  installed CLI version, its `serve --help` text, real `status --json` shapes,
  SChannel/cert issuance and the actual 443→8443 fallback against a live tailnet
  are unverified here.
- **The desktop sidecar gate** (`cargo test -p bloblex-desktop --lib`) did not
  run in this worktree because the sidecar is missing; the Director runs it.
- The native `BITBOTS_REMOTE_WEB_DIR` hand-off is source-reviewed only (WP6c
  builds `remote-web`).
