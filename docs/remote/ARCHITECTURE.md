# Remote mode: architecture

**Status: design.** Written 15 October 2026. Wire details are in [PROTOCOL.md](PROTOCOL.md),
risks in [THREAT_MODEL.md](THREAT_MODEL.md), phases in [PHASES.md](PHASES.md).

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

## 2. Components

```
 Device (phone / PWA / browser / 2nd computer)                       Host (the user's computer)
 +---------------------------------------+                           +------------------------------------------+
 | Remote client (React, same UI kit)     |                           | bitbotsd                                  |
 |  - transport: RemoteTransport          |      sealed frames        |  +------------------------------------+   |
 |  - device key (non-extractable)        | <=======================> |  | Remote gateway (module, off by     |   |
 |  - host list, per-host cursor          |   via relay or direct     |  | default)                           |   |
 +---------------------------------------+                           |  |  - Noise session per device         |   |
                  ^                                                   |  |  - tier + quiet-hours check         |   |
                  |                                                   |  |  - snapshot redaction               |   |
        +---------+----------+                                        |  |  - rate limit, audit log            |   |
        |  Relay (stateless)  |  routes opaque frames by id            |  +------------------+-----------------+   |
        |  no storage         |                                        |                     | internal dispatch   |
        +--------------------+                                        |  +------------------v-----------------+   |
                                                                      |  | existing daemon (loopback only)     |   |
                                                                      |  +------------------------------------+   |
                                                                      +------------------------------------------+
```

### 2.1 Gateway (host)

A module inside `bitbotsd`, compiled in but **inactive** until `remote.enable`. It:

1. keeps one outbound connection to the relay (and, if enabled, a direct listener);
2. terminates the Noise session per paired device and maps it to a device record;
3. parses each frame as the daemon envelope, looks the method up in the tier table, checks
   quiet hours and `approvalsFromRemote`, then calls **internal dispatch** (never the
   loopback HTTP route, so the capability token stays in-process);
4. redacts `app.snapshot` and event payloads;
5. writes an audit entry (kind, device, one short sentence; never content);
6. enforces rate limits and size limits.

The loopback listener, its capability and the Tauri shell path do not change.

### 2.2 Relay

A small stateless service. It accepts two kinds of outbound WebSocket (hosts and devices),
authenticates each by a signed hello that proves a registered public key, and forwards
opaque frames between a device id and a host id. It stores nothing, has no accounts and
cannot read content. It rate-limits and can drop a host or device id. It is replaceable: the
address is part of the pairing payload, so a user can point at their own relay.

### 2.3 Remote client

The existing React UI kit with a `RemoteTransport` behind the same `rpc` / event surface as
`src/tauri.ts`. Native features are hidden through a `platform()` capability object
([FIX16](../FIX16_TRANSPORT_SEAM_SPEC.md)). The phone shell in `src/remote/` is a purpose-built
mobile layout over the same data (bot list, chat, approvals), not the desktop window shrunk.

### 2.4 Direct address (advanced)

The same gateway, listening on the local network at a user-visible `host:port`, with the same
handshake and tiers. It exists for people who do not want a relay; it is off by default and
the UI warns about untrusted networks. A tunnel (Tailscale, Cloudflare) is just another way
to reach the same listener.

## 3. Identity and pairing

- **Host identity**: an X25519 static keypair created the first time Remote is enabled,
  stored with the other local secrets (user-only ACL), never exported.
- **Device identity**: an X25519 keypair created on the device. In a browser it is a
  non-extractable WebCrypto key in IndexedDB (or a wrapped key where that is unavailable).
- **Pairing**: the host mints a one-time secret and shows `K7QM-4XPD` plus a QR containing
  `relay`, `hostId`, the host public key and the secret. The device completes a Noise `XX`
  handshake whose prologue binds the one-time secret, so a relay cannot substitute keys. On
  success the host stores `{deviceId, publicKey, name, tier, pairedAt}` and the code is spent.
- **Known devices** reconnect with Noise `IK`.
- **Revocation**: removing a device deletes its record and closes its session; the relay is
  told to drop its id. A removed device must pair again.

## 4. Sessions, resume, offline

- Per host, the client keeps `afterSequence`. On reconnect it sends the cursor; the gateway
  replays through the existing mechanism. A gap leads to a fresh redacted snapshot.
- The relay has no memory: if the host is offline the device sees `host_offline` and a
  last-seen time, and shows an honest "asleep/offline" screen. Nothing is queued.
- A host that sleeps cannot serve. The Remote page links to the keep-awake setting. A future
  wake-on-push (a content-free ping through the relay) can bring a device's attention back,
  not the computer.

## 5. Multi-computer

The client stores `N` host records (name, id, public key, relay, tier, cursor). The UI shows
state per host: online, asleep, offline, reconnecting, with a count of bots waiting. Each
host has its own snapshot and its own cursor; switching hosts swaps both. Attention (the
"needs you" count) is shown per host in the switcher so a waiting bot on another computer is
not invisible.

## 6. What changes in this repository

| Area | Change | Phase |
|---|---|---|
| `src/transport/` | `Transport` interface, `platform()` flags, no direct `@tauri-apps` imports outside the seam | P0 (done as FIX16 when merged) |
| `src/remote/remoteContract.ts` | Shapes for status, devices, offers, hosts, security | P0 (done) |
| `src/remote/remoteTiers.ts` | Method tier table, `authorizeRemoteCall`, snapshot redaction, parity test | P0 (done) |
| `src/preview/remoteFixture.ts` | Simulator for the web preview | P0 (done) |
| Settings > Remote, `remote.html` | Host and device UI, mock | P0 (done) |
| Gateway module in `bitbotsd` | `remote.*` methods, tier enforcement, audit | P1 |
| Noise session, device keys | Pairing and reconnect | P1 |
| Relay service | Forwarding, rate limits | P2 |
| Push wake, PWA offline shell | Notifications | P3 |

## 7. Failure modes

| Failure | Behaviour |
|---|---|
| Relay unreachable | Host shows "Reconnecting"; devices see the host as offline; direct address, if on, still works. |
| Device offline | Host marks it offline; sessions on the host are unaffected. |
| Daemon restarts | Gateway re-registers with the relay; devices reconnect and resume from their cursor. |
| Slow device | Existing broadcast behaviour: the daemon sends `replay.gap` and the gateway closes that session; the device refetches a snapshot. |
| Clock skew | Pairing codes use a host-side expiry; the device never evaluates it. |
| Lost phone | Remove the device on the computer; its key is dead at once. |
| Stolen paired laptop | Same, and set tiers to View only until removed. |
