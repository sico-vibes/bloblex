# FIX35 C1 — Native Remote: a TLS listener on the public port with password sign-in

> **What this is:** Report on FIX35 C1: Native Remote.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, own worktree (`C:\fx54`), private
`CARGO_TARGET_DIR=C:/fxt/c1`. No `git commit` was run. `apps/desktop/src/ui/**` was
not edited.

## What was built

A second Remote method, **Native**. It binds the host's own interfaces with HTTPS
from a built-in self-signed certificate and lets a device sign in with a username
and password **plus** the owner's approval of the new device on the desktop. The
Tailscale method is unchanged, and `remote.method` selects one at a time
(`"tailscale"` default, `"native"`).

## Files

New:
- `crates/bloblex-daemon/src/remote/native.rs` — certificate, TLS listener, account,
  the `native` status block, and the `remote.native.*` RPCs.

Changed:
- `crates/bloblex-daemon/src/remote/mod.rs` — `native` module wiring, `remote.method`
  cache, abuse state (unauth bucket + login lockout), `remote.method.set`,
  method-aware `enable`/`disable`/`stop_serving`/`status_value`, new status fields.
- `crates/bloblex-daemon/src/remote/web.rs` — `POST /api/login`, the `abuse_limit`
  middleware, Native `Origin`/`Host` checks, `method` in `/api/me` and in
  `remote.pairing.requested`.
- `crates/bloblex-daemon/src/remote/pairing.rs` — `Pending.method`,
  `PairingState::begin_native`, `method` in `pending()`.
- `crates/bloblex-daemon/src/main.rs` — the four new methods in the `remote.*` dispatch.
- `crates/bloblex-daemon/src/remote/tests.rs` — 17 Native tests.
- `crates/bloblex-daemon/Cargo.toml`, `Cargo.toml`, `Cargo.lock` — new dependencies.
- `apps/desktop/src/remote/tiers.json` — four new `never` rows.
- `apps/desktop/src/remote/remoteContract.ts` — `RemoteMethodId`, `RemoteNativeStatus`,
  `RemoteStatus.method`/`native`, `PairingRequest.method`, `REMOTE_METHODS`.
- `apps/desktop/src/remote/remoteTransport.ts` — `RemoteMe.method`.
- `apps/desktop/src/remote/deviceApi.ts`, `RemoteApp.mounted.test.tsx`, `useRemote.test.tsx`
  — added `method` to fixtures/helpers (non-visual TS).
- `apps/desktop/src/preview/remoteFixture.ts` (+ its test) — the simulator answers the
  four new methods and reports a Native status and `method`.

## Dependencies added

| crate | version | why |
| --- | --- | --- |
| `argon2` | 0.5.3 | Argon2id password hashing/verification |
| `rcgen` | 0.14.10 | self-signed ECDSA P-256 certificate |
| `rustls` | 0.23.45 | TLS server config (ring provider, explicit) |
| `tokio-rustls` | 0.26.6 | async TLS acceptor |
| `rustls-pemfile` | 2.2.0 | read the stored certificate/key PEM |
| `if-addrs` | 0.15.0 | enumerate interface addresses for the SANs |

`ring` 0.17.14 is pulled by `rcgen` and used as the rustls provider. The rustls
provider is chosen explicitly (`builder_with_provider(ring)`), so it does not depend
on a process-wide default.

## RPCs, route and status shapes as implemented

Routes (only while Native is on; the Tailscale listener is unchanged):
- `POST /api/login` — Native only, `404` under Tailscale. Body
  `{ username, password, name?, kind?, platform? }`. Answers:
  - wrong username/password → `401 { error: { code: "login_invalid" } }` (uniform;
    a wrong username still runs one Argon2id verify against a fixed dummy hash);
  - correct and a valid device cookie → `200 { state: "approved" }` (lastSeenAt
    refreshed by the normal `authenticate`);
  - correct, new device → `202 { state: "pending" }` + `__Host-bitbots_pair` cookie,
    after `remote.pairing.requested` with `method: "native"`, `login: null`;
  - locked out or globally paused → `429 { error: { code: "rate_limited" } }`.
- `GET /api/pair` — the Native device polls this exactly as a paired phone does.
- `GET /api/me` — adds `method: "tailscale" | "native"`.

`remote.*` (desktop only):
- `remote.method.set { method }` → full status; `invalid_argument` unless
  `tailscale|native`; `conflict` while Remote is on and the method differs.
- `remote.native.account.set { username, password }` → `{ accountSet: true, username }`;
  `invalid_argument` unless username is 1–64 chars, password ≥ 12 chars and ≠ username.
- `remote.native.cert.regenerate` → the `native` block; restarts the listener when on.
- `remote.native.port.set { port }` → the `native` block; `conflict` while on,
  `invalid_argument` unless 1024–65535.
- `remote.pair.begin` → `conflict` ("Native Remote signs in with a password") under Native.
- `remote.enable`/`remote.disable` act on the active method; Native enable needs an
  account (`conflict` "Set a username and password first.").

`remote.status` keeps every existing field and adds:
- `method: "tailscale" | "native"`;
- `native: { port, urls, fingerprint, accountSet, username, listening, loginPaused,
  pausedUntil, lastReachedAt, lastReachedFrom }`.

Settings keys: `remote.method`, `remote.native.port` (48621 default),
`remote.native.account` (`{ username, hash }`, hash is an Argon2id PHC string and is
never logged or returned), and `remote.native.externalIp` (read-only seam for C2).
`settings.set` still refuses every `remote.` key.

Files in the daemon data folder: `remote-native-cert.pem`, `remote-native-key.pem`,
and a small sidecar `remote-native-cert.json` (`{ sans, fingerprint }`) used to decide
whether the certificate still covers the current SANs. On Windows the key file is
restricted with `icacls <key> /inheritance:r /grant:r <user>:F`; elsewhere mode 0600.

## Abuse limits (§4)

- Unauthenticated routes (`/api/login`, `/api/pair`, static files) share a per-source
  token bucket of 30 requests / 10 s, burst 60. The key is `Tailscale-User-Login` when
  present, else the peer IP, else one shared bucket.
- Login lockout: 5 failed sign-ins per source in 15 min → that source gets `429` for
  15 min. 30 failed sign-ins across all sources in 1 h → every sign-in is paused for
  30 min; `remote.changed` then carries `status.native.loginPaused: true` and
  `pausedUntil`. Each failed sign-in writes one content-free `denied` activity line.
- The request body cap stays 256 KiB.

## Tests

Rust (`crates/bloblex-daemon/src/remote/tests.rs`, all green):
- certificate generated once, fingerprint stable across a reload, regeneration changes
  it; the key file's permission command is recorded (`icacls` on Windows, `chmod`
  elsewhere);
- the Native listener serves TLS on loopback with the generated certificate and a
  plain-HTTP connection is dropped, never answered;
- the Native listener binds only while Native is on and stops answering when off;
- Origin and Host are checked against the certificate; the Tailscale origin is refused
  under Native and a Native origin is refused under Tailscale;
- `remote.native.account.set` validation and Argon2id verify; uniform `login_invalid`
  for a wrong username and a wrong password;
- a new device → pending → owner approval → device cookie; a valid cookie → approved;
  a revoked device must sign in again (new pending);
- per-source lockout (5 failures → 429) with a `denied` activity line, and the global
  pause (29 seeded + 1 live) with `remote.changed.native.loginPaused`;
- `remote.pair.begin` under Native → conflict; `remote.method.set` while on → conflict,
  allowed once off;
- `remote.native.port.set` validation/off-requirement; `remote.native.cert.regenerate`
  restarts and changes the fingerprint; the `native` status block fields.

TypeScript: `src/preview/remoteFixture.test.ts` exercises the four new methods and the
Native status; the tier-parity test covers the new `tiers.json` rows.

## Gates

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — all `test result: ok`; `bloblex-daemon` 312 passed, 0 failed (17 new Native tests).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote src/preview` — `tsc` clean;
  vitest 207 passed (13 files).

## Deviations and honest gaps

- **`RemoteStatus.method` and `RemoteStatus.native` are optional in TypeScript**, not
  required. `apps/desktop/src/ui/RemoteChip.mounted.test.tsx` builds a full
  `RemoteStatus` literal, and `apps/desktop/src/ui/**` is out of this lane; a required
  field would fail `tsc -b`. The daemon always sends both. When the Director adds the
  fields to that UI test, they can be made required.
- **`if-addrs` is an extra dependency** beyond the two the spec named, to enumerate the
  host's interface addresses for the SANs.
- **Loopback is included in the certificate SANs** in addition to the "non-loopback"
  wording, so `localhost`/`127.0.0.1` and the loopback TLS tests work.
- **`[::]` is best effort.** The IPv4 `0.0.0.0` listener is bound first; on a
  dual-stack system the IPv6 bind is refused and skipped, so IPv6-only clients may not
  reach the host. Setting `IPV6_V6ONLY` (a `socket2` dependency) would fix it.
- **The external-IP seam is `remote.native.externalIp`**; C2 supplies it. If C2 uses a
  different key, the SAN regeneration on a changed external IP will not trigger.
- **A `denied` activity line is written per failed sign-in**, which is a superset of
  "each lockout writes one activity line".
- **Under Native, `remote.status.tailscale` is not refreshed** (no `tailscale` CLI call
  is made), so it reports the last/initial Tailscale state; the UI should read `method`.

## Unverified

- No real public network was used: every test is loopback only. TLS over a real LAN or
  the internet, a real phone, and the one-time browser certificate warning were not
  exercised.
- The self-signed certificate is not in any trust store, so a real browser will show a
  warning (expected; the fingerprint is exposed for checking).
- C2 (UPnP, firewall rule, external IP, CGNAT) is not implemented here; the `native`
  block has no `upnp`, `firewall`, `externalIp` or `cgnat` fields yet.
- Tailscale on a live tailnet is untouched by this change but was not re-verified
  against a real tailnet.
- IPv6 (`[::]`) reachability is unverified on a dual-stack host.
