# Remote mode: architecture

**Status: design.** Written 15 October 2026; amended 16 October 2026 for the owner's choice of
Tailscale. Wire details are in [PROTOCOL.md](PROTOCOL.md), risks in
[THREAT_MODEL.md](THREAT_MODEL.md), phases in [PHASES.md](PHASES.md).

> **Superseded design.** The 15 October draft used Noise XX/IK sessions, X25519 device keys, a
> hosted relay and an optional direct LAN listener. On 16 October 2026 the owner chose Tailscale
> instead. Tailscale (WireGuard) now supplies encryption, node identity and HTTPS certificates,
> so those parts are removed. The old text is in git history; [REVIEW_NOTES.md](REVIEW_NOTES.md)
> records which review findings it answered.

## 1. Starting point (what exists today)

Facts from the code, each checked when this document was written:

- The daemon `bitbotsd` binds `127.0.0.1:0` only and serves `POST /v1/rpc` and a WebSocket at
  `/v1/events` (`crates/bloblex-daemon/src/main.rs`, transport near the router setup).
- One 256-bit capability token, created per daemon process and held in memory, authorises
  every call. It is passed as `Authorization: Bearer` and compared in constant time. The
  renderer never sees it; the Tauri shell proxies calls (`src-tauri/src/lib.rs`
  `daemon_rpc`, a pass-through with no method allowlist).
- State is a snapshot plus an ordered, persisted, daemon-global event sequence. Clients
  resume with `afterSequence`; a retention gap yields `replay.gap` and a fresh snapshot
  (`docs/ipc-contract.md`).
- The browser preview already runs the UI against a different transport by aliasing
  `../tauri` to `src/preview/fixtureBridge.ts`.
- The invariant in `AGENTS.md` and `docs/ipc-contract.md`: no LAN or wildcard binding; the
  capability never leaves the native shell. Remote needs a documented exception
  ([AGENTS_AMENDMENT_DRAFT.md](AGENTS_AMENDMENT_DRAFT.md)).
- There is no `remote` module in the daemon yet. `apps/desktop/remote.html`,
  `remote.webmanifest` and an inert `remote-sw.js` exist for the browser mock.

## 2. Components

```
 Device (phone / browser on the tailnet)                 Host (the user's computer)
 +-----------------------------------+                   +----------------------------------------------+
 | Bitbots Remote (PWA, same UI kit)  |                   | tailscaled                                   |
 |  - remoteTransport: fetch + WS     |   WireGuard       |  serve: https://<host>.<tailnet>.ts.net:443  |
 |  - session cookie (HttpOnly)       | <===============> |         -> http://127.0.0.1:48620            |
 |  - service worker (shell only)     |   HTTPS (tailnet  +----------------------+-----------------------+
 +-----------------------------------+    certificate)                           | loopback only
                                                         +----------------------v-----------------------+
                                                         | bitbotsd                                     |
                                                         |  +----------------------------------------+  |
                                                         |  | Remote gateway (listener 2, off by      |  |
                                                         |  | default): 127.0.0.1:<remote.port>       |  |
                                                         |  |  - static PWA files (manifest-listed)   |  |
                                                         |  |  - /api/pair, /api/rpc, /api/events     |  |
                                                         |  |  - cookie + Origin + login checks       |  |
                                                         |  |  - quiet hours, tiers, param rules      |  |
                                                         |  |  - redaction, event allowlist, audit    |  |
                                                         |  +-------------------+--------------------+  |
                                                         |                      | in-process dispatch() |
                                                         |  +-------------------v--------------------+  |
                                                         |  | existing daemon API (127.0.0.1:0,       |  |
                                                         |  | capability-protected, unchanged)        |  |
                                                         |  +----------------------------------------+  |
                                                         +----------------------------------------------+
```

### 2.1 Gateway (host)

A module inside `bitbotsd` (`crates/bloblex-daemon/src/remote/`, files `mod`, `policy`,
`tailscale`, `pairing` and `web`). It is compiled in but **inactive** until `remote.enable`.
While Remote is on it:

1. runs a **second axum listener on `127.0.0.1:<remote.port>`** (default `48620`). It never
   binds `0.0.0.0`, a LAN interface or an IPv6 wildcard;
2. asks Tailscale to publish that port on the tailnet with `tailscale serve` (section 2.2);
3. serves the PWA's static files, but only paths listed in a manifest built at startup;
4. authenticates each `/api/*` request by its device cookie, checks revocation and `Origin`,
   and checks the `Tailscale-User-Login` header when present (section 3);
5. runs each RPC through: auth → quiet hours → tier policy → parameter rules → `dispatch()` →
   redaction → audit;
6. streams events through the event allowlist and the scrubber;
7. writes an audit entry (kind, device, one short sentence; never content);
8. enforces rate limits and size limits.

The gateway calls `dispatch()` in-process. It never reads, accepts or forwards the daemon
capability. The existing listener, its loopback checks, its capability and the Tauri shell path
do not change.

### 2.2 Tailscale (`tailscale.rs`)

Tailscale is installed and signed in by the user. Bitbots does not bundle it and does not
create tailnets.

- Find `tailscale.exe` and parse `tailscale status --json` for the backend state, the node's
  DNS name, its certificate domains and the signed-in login.
- Publish with `tailscale serve --bg --https=443 http://127.0.0.1:<port>`. If port 443 is
  already served by something else, use `--https=8443` instead. The chosen port is stored as
  `remote.servePort`.
- Turning Remote off removes only the handler Bitbots added. It never runs
  `tailscale serve reset`, which would remove other people's handlers.
- It never runs `tailscale funnel`, and it checks that Funnel is off for our port. If Funnel is
  on, Remote refuses to start and says why.
- Errors the user can act on: Tailscale not installed, logged out, HTTPS certificates turned off
  in the tailnet's admin settings, or the port already in use.
- Status JSON is never logged, because it contains email addresses and device names.

### 2.3 Remote client (PWA)

The existing React UI kit, built separately (`vite.remote.config.ts`, input `remote.html`,
output `dist-remote`, public folder `remote-public/`). An alias swaps `../tauri` for
`src/remote/remoteTauri.ts`, which sits on `remoteTransport.ts`: `fetch` for RPC and a WebSocket
with a cursor, back-off and gap recovery for events. Native features are hidden through a
`platform()` capability object ([FIX16](../FIX16_TRANSPORT_SEAM_SPEC.md)). The phone shell in
`src/remote/` is a mobile layout over the same data (bot list, chat, approvals), not the desktop
window shrunk.

The build ships inside the desktop installer as a Tauri resource (`remote-web/`). The shell
passes its path to the daemon in `BITBOTS_REMOTE_WEB_DIR` from `start_daemon`
(`src-tauri/src/lib.rs`).

A real service worker replaces the inert `remote-sw.js`: a versioned precache of the hashed
shell, network-first for `remote.html`, `/api/*` never cached, an "update ready" prompt on
`controllerchange`, and a strict content security policy.

## 3. Identity and pairing

- **Network identity** comes from Tailscale. Only nodes on the owner's tailnet can reach the
  serve address, and traffic is WireGuard-encrypted end to end between the two nodes. HTTPS uses
  the tailnet's certificate for `<host>.<tailnet>.ts.net`.
- **Device identity** is a Bitbots session cookie, issued only after the owner approves the
  device. There are no device key pairs.
- **Pairing** (owner-confirmed):
  1. On the desktop, `remote.pair.begin` returns an 8-character code (two groups, for example
     `K7QM-4XPD`), valid for 5 minutes, plus the serve URL and a QR payload of that URL.
  2. The phone opens the URL and posts the code. Five wrong attempts burn the code.
  3. The desktop shows the device (name, platform and Tailscale login when known). The owner
     approves it with a tier, `viewer`, `chat` or `operator`, or rejects it.
  4. On approval the device gets a 256-bit random token in an
     `HttpOnly; Secure; SameSite=Strict` cookie. The host stores only `sha256(token)` with
     `{deviceId, name, kind, platform, tier, login, pairedAt, lastSeenAt}`.
- **Every `/api/*` request** checks the cookie hash, revocation and the `Origin` header. If the
  `Tailscale-User-Login` header is present, it must match the login recorded at pairing.
- **Revocation** marks the device record revoked, closes its event socket and makes its cookie
  useless at once; later requests get `device_revoked`. A removed device must pair again.

## 4. Sessions, resume, offline

- The client keeps its `afterSequence` cursor. On reconnect it opens `/api/events` with that
  cursor; the gateway replays through the existing mechanism. A gap leads to a fresh redacted
  snapshot.
- One live event socket per device. A second socket for the same device closes the first.
- If the host is asleep or Tailscale is down, the device cannot reach the address. The client
  shows an honest "asleep or offline" screen with the last-seen time. Nothing is queued.
- A host that sleeps cannot serve. The Remote page links to the keep-awake setting.

## 5. Multi-computer

Each computer serves its own PWA at its own tailnet address, so each has its own origin, its
own cookie and its own install. In v1 a phone installs one app per computer. A switcher that
lists other computers and opens their addresses is a later item; it needs no host-side method,
because host records live only on the device.

## 6. What changes in this repository

| Area | Change | Phase |
|---|---|---|
| `src/transport/` | `Transport` interface, `platform()` flags, no direct `@tauri-apps` imports outside the seam | P0 (done as FIX16 when merged) |
| `src/remote/remoteContract.ts` | Shapes for status, devices, offers, security | P0 (done); P1 drops relay and direct fields |
| `src/remote/remoteTiers.ts` | Tier table, `authorizeRemoteCall`, redactors, event policy, parity test | P0 (done); P1 moves the tables to `remote/tiers.json` |
| `src/preview/remoteFixture.ts` | Simulator for the web preview | P0 (done) |
| Settings > Remote, `remote.html` | Host and device UI, mock | P0 (done) |
| `crates/bloblex-daemon/src/remote/` | Second loopback listener, Tailscale control, pairing, cookie auth, policy, redaction, audit | P1 |
| `remote/tiers.json` | One tier table, event policy and settings allowlist read by Rust and TypeScript | P1 |
| `vite.remote.config.ts`, `remote-public/`, service worker | PWA build shipped as the `remote-web/` resource | P1 |
| Storage | Tables `remote_devices` and `remote_activity` (capped at 500 rows) | P1 |
| Push notifications | Content-free notifications | P3 |

## 7. Failure modes

| Failure | Behaviour |
|---|---|
| Tailscale not installed or logged out | Remote does not start; the page shows the fix-it step. |
| HTTPS certificates off in the tailnet | Remote does not start; the page links to the admin setting. |
| Port 443 served by something else | Use 8443; if that is taken too, refuse and say so. |
| Funnel on for our port | Remote refuses to start until it is off. |
| Device offline | Host marks it offline; sessions on the host are unaffected. |
| Daemon restarts | The gateway listens again and re-applies `tailscale serve`; devices reconnect and resume from their cursor. |
| Slow device | Existing broadcast behaviour: the daemon sends `replay.gap` and the gateway closes that socket; the device refetches a snapshot. |
| Clock skew | Pairing codes use a host-side expiry; the device never evaluates it. |
| Lost phone | Remove the device on the computer; its cookie is dead at once. Removing the node from the tailnet also cuts it off. |

## 8. Review corrections (15 October 2026, still in force)

Findings from [REVIEW_NOTES.md](REVIEW_NOTES.md) that still shape this design:

- **Enforcement is not built.** `daemon_rpc` in the Tauri shell is still a pass-through. The
  tier policy is an executable specification (`remoteTiers.ts`, moving to `tiers.json`); the
  gateway must apply it, and it must also apply the redactors to results and the event
  allowlist to pushes. Until then nothing is enforced and Remote must not ship.
- **Browser clients** need an `Origin` check and a PWA content security policy
  (`connect-src 'self'`, `frame-ancestors 'none'`); none exists yet.
- **Revocation** closes the device's socket on the host first. There is no third party to tell.
