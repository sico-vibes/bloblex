# FIX29 (WP6b): the remote gateway in `bitbotsd` over Tailscale

> **What this is:** Spec for FIX29 (WP6b): the remote gateway in the daemon over Tailscale.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree, private `CARGO_TARGET_DIR`. Director reviews, runs the gates on the merged result and commits. **Do not run `git commit`.** Read `AGENTS.md` first.

**The contract is already written.** Implement exactly what these say; where this spec is silent, they decide:
- `docs/remote/PROTOCOL.md` §2.1 (listener and serve), §3 (frames), §4 (routes, checks, cookie, pairing, `/api/rpc` pipeline), §6 (resume and replay), §7 (snapshot filtering), §9 (attachments: refused in v1), §11 (errors).
- `docs/ipc-contract.md` lines ~140-165: the `remote.*` methods, their shapes, the events and the settings rule.
- `docs/remote/THREAT_MODEL.md` for why each check exists.

Builds on WP6a (`crates/bloblex-daemon/src/remote/policy.rs`, `apps/desktop/src/remote/tiers.json`). Use its `authorize`, `redact_result`, `redact_event`; never re-implement policy.

## Hard rules (a violation fails review)
- Bind `127.0.0.1` only. Never `0.0.0.0`, a LAN address or `[::]`.
- Never run `tailscale funnel` or `tailscale serve reset`. Turning Remote off removes only our handler (`tailscale serve --https=<servePort> off`, or the documented equivalent for the installed CLI version; check `tailscale serve --help` output parsing, do not guess silently). Refuse to start if Funnel is on for our port.
- The gateway calls `dispatch()` in-process and never reads, accepts, logs or returns the daemon capability.
- Never log `tailscale status --json` (it has email addresses), cookies, tokens or token hashes. Store only `sha256(token)`.
- The existing loopback listener, its capability check and its routes are untouched.
- **Tests never run the real `tailscale` binary.** All CLI access goes through a trait (`TailscaleCli`) with a real implementation (`std::process::Command`, no shell, 5 s timeout, `CREATE_NO_WINDOW` on Windows) and a fake for tests.

## Module layout: `crates/bloblex-daemon/src/remote/`
- `mod.rs`: `RemoteState` held in `AppState` (listener handle, live offer, device sockets, settings cache), `remote.*` dispatch, enable/disable lifecycle, start-at-boot when `remote.enabled` is true and Tailscale is ready (otherwise status `error` with the reason, never a crash).
- `tailscale.rs`: find `tailscale.exe` (PATH, then `%ProgramFiles%\Tailscale\tailscale.exe`); parse `status --json` into `{backendState, dnsName (trailing dot removed), certDomains, loginName, funnelOn}`; map to `not_installed | logged_out | https_disabled | port_in_use | funnel_on | ready`; `serve` add/remove with the 443 → 8443 fallback (443 is "taken" when `serve status --json` shows a handler on 443 that is not ours).
- `pairing.rs`: offers (8 chars from a 32-symbol alphabet without look-alikes, `XXXX-XXXX`, 5 minutes, 5 wrong attempts then burned, one live offer, lock on first correct code, uniform `pairing_invalid`), pending requests, `__Host-bitbots_pair` cookie, approve/reject/expire, device token creation (256 bits from `rand`/`getrandom`, base64url), constant-time hash comparison.
- `web.rs`: the axum router for §4.4: static files from a manifest built at startup from `BITBOTS_REMOTE_WEB_DIR` (absent or empty → `/` serves a tiny built-in HTML page saying the remote app is not installed; any other path 404), `/api/pair` (POST, GET), `/api/me`, `/api/rpc`, `/api/events` (WebSocket), `/api/logout`. Security headers on every response: `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on `/api/*`.

## Request checks (PROTOCOL §4.1), in order
Origin equals the serve origin (403 otherwise, also on the WebSocket upgrade) → device cookie → revocation and idle expiry → `Tailscale-User-Login` match when present → body ≤ 256 KiB → per-device rate limit (token bucket, e.g. 20 requests/s burst 40; tune in a const). Then the §4.5 pipeline: quiet hours → `policy::authorize` (with the device tier and `approvalsFromRemote`) → `dispatch` → `policy::redact_result` → activity line for writes, approvals and denials (content-free).

## Events (PROTOCOL §6)
First socket message `{"v":1,"afterSequence":n}`; replay with `db.replay_events(after, 1000)` in batches; register the live subscription before replaying; every event through `policy::redact_event` (drop `None`); one live socket per device (a new one closes the old); revoke closes the socket at once; a lagging client gets `replay.gap` and is closed.

## Storage (`crates/bloblex-storage/src/lib.rs`)
Additive `ensure_remote_schema` (no `user_version` bump), like `ensure_skills_schema`:
- `remote_devices(id PK, name, kind, platform, tier CHECK IN ('viewer','chat','operator'), login NULL, token_sha256 UNIQUE, paired_at, last_seen_at NULL, revoked_at NULL, signed_out_at NULL)`
- `remote_activity(id INTEGER PK AUTOINCREMENT, at, device_id NULL, kind, summary)`, trimmed to the newest 500 rows on insert.
- Settings `remote.enabled`, `remote.port` (default 48620), `remote.servePort`, `remote.security` (`{approvalsFromRemote:false, idleExpiryDays:30, quietHours:{enabled:false, from:"22:00", to:"07:00"}}`). `settings.set` refuses every `remote.` key with `invalid_argument` ("Remote settings change only through Settings › Remote.").

## RPCs and events
All `remote.*` methods and events exactly as `docs/ipc-contract.md` lists them. Add every one to `tiers.json`: methods `never` (with a one-sentence `why`), events `drop`. `remote.status` never includes the login or raw JSON. `remote.pair.begin` returns `url` = serve origin + `/` and `qrPayload` = that URL plus `#pair=<code>`.

## Native shell
In `apps/desktop/src-tauri/src/lib.rs` `start_daemon`: when the resource folder `remote-web` exists next to the app, pass its path as `BITBOTS_REMOTE_WEB_DIR`. No other native change. (The folder is produced by WP6c.)

## Tests (all with the fake `TailscaleCli` and temp databases)
- Tailscale JSON parsing: running, logged out, HTTPS off, Funnel on, 443 taken → 8443; DNS name trailing dot removed.
- Never issues `funnel` or `serve reset`: the fake records every argv; assert no forbidden argv after enable, disable, and a failed enable.
- Listener binds `127.0.0.1` (inspect the bound address).
- Pairing: expiry, 5 wrong attempts burn, lock on first correct code (a later correct code is refused), uniform `pairing_invalid`, reject burns, approve sets the device cookie with `HttpOnly; Secure; SameSite=Strict; Path=/` and stores only the hash.
- Auth: missing/wrong Origin → 403 (HTTP and WS upgrade); no cookie → 401 `unauthorized`; revoked → 401 `device_revoked`; login header mismatch → 401 and an activity line; body > 256 KiB → `payload_too_large`; rate limit → `rate_limited`.
- Pipeline: viewer cannot `session.prompt` (`tier_required`); quiet hours refuse chat but allow read; `permission.reply` refused while approvals from remote are off; `runtime.models {refresh:true}` → `invalid_params`; attachments refused; a `never` method → `forbidden_remote`; results are redacted (an agent's `customEnv` arrives as `{}`).
- The capability never appears: serialize every response and WS frame in the tests and assert the capability string is absent.
- Events: replay from a cursor then live; a `drop` event is never sent; a second socket closes the first; revoke closes the socket.
- Static server: a manifest file is served; `/../Cargo.toml`, `%2e%2e`, absolute and backslash paths → 404.
- `settings.set` refuses `remote.enabled`.
- Activity table keeps at most 500 rows.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cargo test -p bloblex-desktop --lib` (if the sidecar is missing in the worktree, say so; the Director runs it)
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote`

## Report
`docs/history/fix-29/wp6b-report.md`: files, the routes and RPCs as implemented, the exact `tailscale` argv used for each action and which CLI version's help text it was based on, tests, gate summaries, and an honest verified / not verified list (live Tailscale is not verified by tests).
