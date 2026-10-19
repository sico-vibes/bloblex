# FIX35 C1: Native Remote — a TLS listener on the public port with password sign-in

> **What this is:** Spec for FIX35 C1: Native Remote, a TLS listener on the public port with password sign-in.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree, private `CARGO_TARGET_DIR`. **Do not run `git commit`.** Read `AGENTS.md` first (the 17 October Remote amendment and the Native Remote amendment above it). Keep your context small: grep and read only the ranges you need (`main.rs` and `remote/*.rs` are large); pipe long output through `tail`/`grep`. Do not edit `apps/desktop/src/ui/**` (the Director builds the UI).

## Goal
A second Remote method, **Native**, that needs only Bitbots on the host and a browser on the device: the gateway listens on the host's own network interfaces with HTTPS from a built-in certificate, and devices sign in with a username and password **plus** the owner's approval of each new device on the desktop. Tailscale stays as the other method; **one method is active at a time** (`remote.method`, `"tailscale"` default or `"native"`).

## Reuse, don't fork
`crates/bloblex-daemon/src/remote/web.rs` (router, `authenticate`, static files, cookies, sockets, audit), `pairing.rs` (pending requests, device tokens, constant-time hash compare), `policy.rs`, storage tables `remote_devices` / `remote_activity`. New code goes in `remote/native.rs` plus small, clearly marked hooks in `mod.rs` / `web.rs`.

## 1. Listener and TLS (`native.rs`)
- Bind `0.0.0.0:<remote.nativePort>` (default **48621**) and, when the OS supports it, `[::]:<port>` — **only while Native is on**. Turning it off closes the listeners and every device socket. The Tailscale listener keeps binding `127.0.0.1` only.
- TLS with `tokio-rustls` (already in the lock tree; add as a direct dependency). Certificate: generate a self-signed ECDSA P-256 certificate with `rcgen` (new dependency) on first enable, valid 825 days, SANs = every non-loopback IPv4/IPv6 address of the host's interfaces + the external IP when known (C2 supplies it) + the machine's hostname + `localhost`. Store `remote-native-cert.pem` and `remote-native-key.pem` in the daemon's data folder; on Windows restrict the key file to the current user (use `icacls` via `std::process::Command` with `/inheritance:r /grant:r <user>:F`, no shell), elsewhere mode 0600.
- `fingerprint` = SHA-256 of the certificate DER, uppercase hex in colon pairs. Regenerate on `remote.native.cert.regenerate` (and when C2 reports a new external IP not in the SANs). Never log the key.
- Serve the existing `web::router` over the TLS acceptor (hyper-util / axum `serve` with a TLS-wrapping listener; no `axum-server` unless trivial). HTTP (non-TLS) connections are refused.

## 2. Origins
- Native accepted origins = `https://<addr>:<port>` for each SAN address/hostname. `require_origin` checks the request's `Origin` against the **active method's** set (Tailscale: the serve origin; Native: this set). Also check `Host` matches one of the same authorities on Native.

## 3. Account and sign-in
- Storage: setting `remote.native.account` = `{ "username": string, "hash": "<argon2id PHC string>" }`, written only by `remote.native.account.set { username, password }` (1–64 char username, password ≥ 12 chars and not equal to the username; `invalid_argument` otherwise). `settings.set` keeps refusing every `remote.` key. Use the `argon2` crate (new dependency), Argon2id with default params, random salt. Never log or return the password or hash; `remote.status` reports only `accountSet: boolean` and the username.
- `POST /api/login { username, password, name, kind, platform }` (Native only; 404 under Tailscale):
  - Wrong username or password → uniform `401 { code: "login_invalid" }` after a constant-time verify (verify against a dummy hash when the username is wrong).
  - Correct, **device cookie already valid** → `200 { state: "approved" }` (refresh `lastSeenAt`).
  - Correct, **new device** → create a pending request through the same path as pairing (`remote.pairing.requested` with `method: "native"`, `login: null`), set the `__Host-bitbots_pair` cookie, respond `202 { state: "pending" }`; the device polls `GET /api/pair` exactly as today and gets its device cookie when the owner approves (tier chosen on the desktop).
  - The password is required again for a device whose cookie has expired (idle expiry) or been revoked.
- `GET /api/me` adds `method: "tailscale" | "native"` (the client shows a sign-in screen for Native).
- Pairing codes (`remote.pair.begin`) stay Tailscale-only; under Native, `remote.pair.begin` returns `conflict` ("Native Remote signs in with a password").

## 4. Abuse limits (Native and Tailscale)
- Per-source-IP token bucket on **every unauthenticated route** (`/api/login`, `/api/pair`, static files): 30 requests/10 s burst 60. Under Tailscale the peer is always loopback, so key by `Tailscale-User-Login` when present, else one shared bucket.
- Login lockout: 5 failed logins per IP per 15 minutes → that IP gets `429 { code: "rate_limited" }` for 15 minutes; 30 failed logins across all IPs per hour → all logins paused for 30 minutes and `remote.changed` carries `loginPaused: true` with `pausedUntil`; each lockout writes one activity line (`kind: "denied"`, summary without the username or password).
- Body limit stays 256 KiB.

## 5. RPCs, status, events (desktop only)
- `remote.method.set { method }` (refuses while the other method is on: turn Remote off first), `remote.native.account.set`, `remote.native.cert.regenerate`, `remote.native.port.set { port }` (1024–65535, Remote off).
- `remote.enable` / `remote.disable` act on the active method. Native enable requires an account (`conflict` "Set a username and password first").
- `remote.status` gains: `method`, and `native: { port, urls: string[], fingerprint, accountSet, username, listening, loginPaused, pausedUntil, lastReachedAt, lastReachedFrom }` (C2 adds `upnp`, `firewall`, `externalIp`, `cgnat`). Keep existing fields.
- `tiers.json`: add the new methods as `never` (one-sentence `why`); no new event types beyond `remote.changed`.
- `apps/desktop/src/remote/remoteContract.ts`: extend `RemoteStatus` with `method` and the `native` block, `RemoteMe.method` in `remoteTransport.ts`, and `REMOTE_METHODS`. Update `apps/desktop/src/preview/remoteFixture.ts` so the simulator answers the new methods and a Native status (non-visual TS only).

## 6. Rules
- Tailscale listener tests that assert loopback-only stay; add a test that the Native listener binds only while Native is on and serves only TLS.
- Never expose the daemon API port; Native serves only `web::router`.
- No third-party service is contacted by C1.

## Tests (temp data dir, no real network beyond loopback)
- Cert generated once, fingerprint stable across restart, regenerate changes it; key file not world-readable (best effort on Windows: assert icacls was invoked via a command recorder).
- TLS handshake on loopback succeeds with the generated cert; plain HTTP is refused.
- Origin/Host checks on Native; Tailscale origin rejected under Native and vice versa.
- account.set validation; argon2 verify; uniform `login_invalid`; known device → approved; new device → pending → owner confirm → device cookie; revoked → password required again.
- Lockouts per IP and global pause, activity lines, `remote.changed` flags.
- `remote.pair.begin` under Native → conflict; `remote.method.set` while on → conflict.
- Parity: `npx vitest run src/remote` green with the new `tiers.json` rows.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote src/preview`

## Report
`docs/history/fix-35/c1-report.md`: files, RPC/route/status shapes as implemented, dependency versions added, tests, gates, and unverified items (real public network, phones, browsers' certificate warnings).
