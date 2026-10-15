# Bitbots remote protocol (v1)

**Status: Design, not implemented.** This document describes the wire contract between a
device (phone, tablet, browser) and a host's gateway. It is grounded in the daemon as it
exists today; every daemon fact cites its source file. Choices that are not yet forced by the
daemon are marked **(recommendation)** and may change before implementation.

Vocabulary: a **host** is a computer running Bitbots and its daemon; a **device** is a paired
phone, tablet, browser or computer; the **gateway** is the host-side component that exposes the
daemon to remote devices; the **relay** is the optional public broker. See
`apps/desktop/src/remote/remoteContract.ts` for the UI shapes this document assumes.

---

## 1. Scope and non-goals

**In scope.** Device-to-host request/response and events over a relay or a direct socket. The
existing daemon envelope, filtered for remote. Pairing, key storage, resume and replay, the
method allowlist, attachment staging, presence and versioning.

**Non-goals.**

- The loopback daemon API is unchanged. The daemon still binds `127.0.0.1` on an ephemeral
  port and serves `POST /v1/rpc` and `GET /v1/events`
  (`crates/bloblex-daemon/src/main.rs:3381-3384`). Remote never widens that listener.
- The daemon's capability token, its startup bootstrap and its Tauri proxy path are untouched
  (`docs/ipc-contract.md:15-23`).
- This document does not define product policy (who may pair, what a tier means to the user),
  the architecture or the threat model. Those are Director documents under `docs/remote/`.
- No remote listener on the daemon, no cloud storage of transcripts, no server-side authority
  over sessions. The host daemon remains authoritative (`docs/ipc-contract.md:7`).

---

## 2. Layers

Three layers, each independent of the one above it.

| Layer | Carries | Defined in |
|---|---|---|
| Transport | WebSocket over TLS to the relay, or a direct WebSocket to the host address | §2.1 |
| Secure channel | Noise handshake plus AEAD records | §4 |
| Application frames | The existing daemon envelope, filtered | §3 |

### 2.1 Transport **(recommendation)**

- Relay path: one WebSocket (`wss://`) per device and per host. The relay cannot read the
  secure-channel payload; it sees only the routing header in §5.
- Direct path: the host opens a WebSocket listener reachable on the local network, advertised
  as `RemoteStatus.directAddress` (`apps/desktop/src/remote/remoteContract.ts:42`). The secure
  channel is mandatory on direct too; a LAN socket is not trusted by position alone.
- The transport is a byte pipe for the lifetime of a connection. Either side may send `ping`
  frames (§5). No HTTP semantics above the floor.

---

## 3. Application frames

Remote reuses the daemon envelope exactly. Field names, shapes and meaning do not change.

Requests (`docs/ipc-contract.md:25-31`):

```json
{"v":1,"id":"req_01","method":"app.snapshot","params":{}}
```

Responses (`docs/ipc-contract.md:33-37`):

```json
{"v":1,"id":"req_01","ok":true,"result":{ }}
```

Errors (`docs/ipc-contract.md:39-43`):

```json
{"v":1,"id":"req_01","ok":false,"error":{"code":"not_found","message":"…"}}
```

Events (`docs/ipc-contract.md:45-51`):

```json
{"v":1,"eventId":"evt_01","sequence":1,"timestamp":"2026-10-01T00:00:00Z","type":"runtime.changed","payload":{}}
```

Rules carried over unchanged:

- `id` is an opaque, per-client request identifier; a response echoes it.
- Event `sequence` is daemon-global and monotonically increasing
  (`crates/bloblex-storage/src/lib.rs:1107`; `docs/ipc-contract.md:51`).
- Unknown fields and unknown event types are ignored (`docs/ipc-contract.md:51`).
- No raw provider JSON appears in the contract (`docs/ipc-contract.md:51`).

The gateway adds its own error codes, used only on the remote path:

| Code | Meaning |
|---|---|
| `forbidden_remote` | The method is not on the remote allowlist, or the device's tier is too low. |
| `tier_required` | The call is allowed at a higher tier than the device holds. |
| `approvals_disabled` | Approvals from remote are switched off on the host. |
| `host_offline` | The host daemon is not reachable. |
| `rate_limited` | The relay or the gateway is throttling this device. |
| `payload_too_large` | A frame or an upload exceeds its limit. |
| `device_revoked` | The device's pairing was removed; re-pair to continue. |

These codes sit beside the daemon's stable codes (`invalid_argument`, `not_found`,
`unauthorized`, `unsupported`, `provider_unavailable`, `provider_error`, `conflict`,
`replay_gap`, `internal`; `docs/ipc-contract.md:255`). An error message is safe to display and
carries no credential material or prompt text (`docs/ipc-contract.md:255`).

---

## 4. Secure channel

**(recommendation)** unless stated otherwise. The secure channel is end-to-end between device
and host gateway. The relay and the network are untrusted.

### 4.1 Primitives

| Purpose | Choice |
|---|---|
| Handshake | Noise `XX` for first contact (pairing); Noise `IK` for known devices |
| Key agreement | X25519 |
| Cipher | ChaCha20-Poly1305 |
| Hash | BLAKE2s |
| Rekey | every 1 GiB of traffic or 1 hour, whichever comes first |

`XX` authenticates both sides during pairing; `IK` lets a known device resume without a new
code, authenticating the host by its static key.

### 4.2 What each side stores

| Side | Stored |
|---|---|
| Host | device public keys, device id, device name, kind, tier, `pairedAt`, `lastSeenAt` |
| Device | its non-extractable private key, the host public key, host id, relay address |

`RemoteDevice` already carries the host-side fields (`apps/desktop/src/remote/remoteContract.ts:17-28`).
Device private keys are generated non-extractable and never leave the device **(recommendation)**.
The host never stores a device's private key.

### 4.3 Pairing

1. Host creates a one-time code via `remote.pair.begin`; the code is eight characters in two
   groups (for example `K7QM-4XPD`) and lives five minutes
   (`apps/desktop/src/remote/remoteContract.ts:50-58,119`).
2. The code is bound into the Noise handshake **prologue**: both sides fold
   `H(code ‖ hostId ‖ deviceId ‖ relay)` into the handshake hash. The relay therefore cannot
   swap keys between the two peers without changing the prologue and failing the handshake.
3. After the handshake completes, the host issues the device a device id and its tier. The
   offer is cleared and the device is added to the list.

Once a device is known, later connections use `IK` and no code.

```
device                         relay                        host gateway
  |                              |                              |
  |  hello(deviceId)             |                              |
  |----------------------------->|                              |
  |                              |  frame(hostId, hello, len)   |
  |                              |----------------------------->|
  |                              |                              | code K7QM-4XPD
  |                              |                              | valid < 5 min
  |<======== Noise XX ==========================================>|
  |   prologue = H(code ‖ hostId ‖ deviceId ‖ relay)             |
  |   X25519 · ChaCha20-Poly1305 · BLAKE2s                       |
  |                              |                              |
  |  {data} paired, tier=chat    |                              |
  |<------------------------------------------------------------>|
  |                              |                              | offer cleared
  |                              |                              | device stored
```

---

## 5. Relay framing

The relay routes frames. It sees a small, opaque header and the length; it does not see the
payload.

| Field | Meaning |
|---|---|
| `deviceId` | Routing: which device sent or receives the frame |
| `hostId` | Routing: which host the frame is for |
| `frameType` | `hello`, `data`, `ping` or `wake` |
| `len` | Length in bytes of the opaque payload that follows |

Nothing else is visible to the relay. `data` frames carry secure-channel records only.

Relay behaviour:

- **Rate limits.** The relay limits frames per device and per host and answers excess with
  `rate_limited` (§3).
- **Max frame 256 KiB.** A larger frame is rejected with `payload_too_large`.
- **No storage of data frames.** The relay forwards and forgets. It buffers only what a live
  connection needs; a disconnection cannot recover missed `data` frames through the relay.
- **Wake pings carry no content.** A `wake` frame is a signal to check in, nothing more (§10).
- `ping` frames keep the connection alive and carry no application state.

---

## 6. Resume and replay

The device keeps a per-host cursor: the highest `sequence` it has applied. On reconnect it
sends that cursor; the gateway replays through the daemon's existing mechanism.

Daemon facts this relies on:

- Replay is batched at 1000 events per call: `events.replay` passes limit 1000
  (`crates/bloblex-daemon/src/main.rs:698`) and the event socket calls `replay_events(after,1000)`
  (`crates/bloblex-daemon/src/main.rs:3274`).
- The daemon registers the live subscription before replaying, so a client may see duplicate
  sequences and must discard them (`docs/ipc-contract.md:23`; `crates/bloblex-daemon/src/main.rs:3264-3292`).
- If retention no longer covers the gap, replay returns `replayAvailable:false` with
  `earliestSequence` (`crates/bloblex-storage/src/lib.rs:1509-1513`); the client then fetches a
  fresh `app.snapshot` (`docs/ipc-contract.md:23`).
- The live broadcast channel has capacity 1024 (`crates/bloblex-daemon/src/main.rs:3343`). A
  slow client that lags is sent a `replay.gap` event and the socket is closed
  (`crates/bloblex-daemon/src/main.rs:3313`).
- Sequences are daemon-global, not per session (`docs/ipc-contract.md:51`).
- After replay the daemon emits `events.replay.complete` with `throughSequence`
  (`crates/bloblex-daemon/src/main.rs:3297-3304`).

The remote event socket upgrades with `{"v":1,"afterSequence":<cursor>}` on the daemon side
(`crates/bloblex-daemon/src/main.rs:3264-3272`; `docs/ipc-contract.md:23`); the gateway passes
the device's per-host cursor in the same shape.

```
device                              host gateway
  |  hello + afterSequence=418          |
  |------------------------------------>|
  |  event 419 … 1418 (batch of 1000)   |
  |<------------------------------------|
  |  events.replay.complete{1418}       |
  |<------------------------------------|
  |  live events (dedupe by sequence)   |
  |<------------------------------------|
  |                                     |
  |  -- OR, cursor too old --           |
  |                                     |
  |  replay.gap / replayAvailable=false |
  |<------------------------------------|
  |  app.snapshot  (fresh sequence)     |
  |------------------------------------>|
  |<------------------------------------|
```

A `replay.gap` always ends the affected stream. The device reconnects from a snapshot cursor
and resumes. No partial in-memory state is trusted across the gap.

---

## 7. Snapshot filtering

`app.snapshot` is redacted before it reaches a device. The host applies
`redactSnapshotForRemote(snapshot)` (`docs/FIX18_REMOTE_TIERS_SPEC.md:50-55`):

- `customEnv` values are removed (key names only).
- An `instructions` string of any length is replaced by `{ "hasInstructions": true }`.
- Absolute filesystem paths in `projectPath` fields are reduced to their last two segments.
- Any key whose name matches `/token|secret|password|credential|capability/i` is removed.

The daemon itself never sends raw provider login credentials (`docs/ipc-contract.md:266`), and
the capability token is memory-only and never leaves the native shell
(`docs/ipc-contract.md:21`). Redaction is defense in depth for fields the daemon does keep,
such as agent `customEnv` and `instructions` (`docs/ipc-contract.md:208`).

The gateway applies the same redaction to redacted fields inside other read results
(`settings.get`, `session.get` and `agent.get`) before returning them.

---

## 8. Method allowlist

A device may call only methods on the allowlist, and only at or above the tier a method needs.
`METHOD_RULES` in `apps/desktop/src/remote/remoteTiers.ts` is the source of truth
(`docs/FIX18_REMOTE_TIERS_SPEC.md:10-42`); the table below is generated from it. An unknown
method is denied with reason "not on the remote allowlist".

Three tiers, each including everything below it
(`apps/desktop/src/remote/remoteContract.ts:9-10`):

- **viewer** — read-only. State, transcripts, usage and status.
- **chat** — viewer plus sending prompts and controlling turns.
- **operator** — chat plus approving permission requests, and only while
  `approvalsFromRemote` is on (`apps/desktop/src/remote/remoteContract.ts:60-66`).

**never remote** — always denied, at every tier: settings writes, blob and project lifecycle,
runtime profile writes, session deletion, daemon shutdown, hooks, and the retired
`pricing.*`, `subscription.*` and `budget.*` families
(`docs/FIX18_REMOTE_TIERS_SPEC.md:33-39`).

<!-- TIER-TABLE -->

The Director fills the table above from FIX18's `renderTierTableMarkdown()`. Do not hand-edit
it; regenerate it so it cannot drift from `METHOD_RULES`.

---

## 9. Attachments

Attachments are uploaded in chunks to a staging area on the host, through the gateway, before
the prompt that references them.

- Each chunk carries an offset and a byte range; the gateway reassembles into staging.
- Size limit: 10 MiB per image, matching the daemon's `MAX_ATTACHMENT_BYTES`
  (`crates/bloblex-daemon/src/main.rs:2608,2626`). At most 8 attachments per message
  (`crates/bloblex-daemon/src/main.rs:2607,2619`).
- Magic-byte check: the host reads the file header and derives the media type itself, never
  from the caller (`crates/bloblex-daemon/src/main.rs:2610-2641`). Accepted signatures are PNG,
  JPEG, GIF and WebP.
- The staging area returns a `stagedId`. A prompt references only `stagedId`; a device never
  sends a raw file path.

This is stricter than the local daemon path, which today accepts an absolute local path
(`crates/bloblex-daemon/src/main.rs:2621-2623`). Remote does not: a device has no path into the
host filesystem. The params rule is stated in FIX18: `session.prompt` and `session.queue.add`
reject any attachment object that carries a `path`; only `{ stagedId }` is allowed
(`docs/FIX18_REMOTE_TIERS_SPEC.md:44-48`).

---

## 10. Presence and notifications

**Host heartbeat.** The daemon reports `state`, `version`, `uptimeSeconds` and `heartbeatAt`
through `daemon.health` (`crates/bloblex-daemon/src/main.rs:709-711`). The gateway derives host
presence from the live link, not from a stored value.

**Device online flag.** `RemoteDevice.online` is true while the device has a live session with
the host (`apps/desktop/src/remote/remoteContract.ts:26`). On the client side each host has a
state of `online`, `asleep`, `offline` or `reconnecting`
(`apps/desktop/src/remote/remoteContract.ts:81`).

**Wake pings.** A `wake` relay frame (§5) tells a sleeping host or device to check in. It
carries no content.

**Push payload.** A push notification may contain nothing but a signal to check in. It never
carries message text, blob names, file paths or counts. The client fetches state over the
secure channel after the signal. The host-side activity log already follows this rule: an
activity summary is one short sentence and never message content
(`apps/desktop/src/remote/remoteContract.ts:70-78`).

---

## 11. Versioning and errors

- `protocolVersion` is negotiated at connect. The daemon's startup bootstrap and every
  envelope carry protocol version 1 (`docs/ipc-contract.md:15-23,25-51`).
- A request whose `v` does not match is rejected with `unsupported` ("protocol version
  mismatch") (`crates/bloblex-daemon/src/main.rs:345-350`). Remote keeps a matching rule: an
  unsupported major version fails at startup, not per call.
- Unknown fields and unknown event types are ignored, never an error
  (`docs/ipc-contract.md:51`).
- **Deprecation (recommendation).** A field or method is deprecated in one protocol version and
  removed no earlier than the next major version. Gateways accept deprecated usage and reply
  with a warning field; nothing is removed without a version bump.

### Denied call

```
device                              host gateway            daemon
  |  req settings.set  (id=req_9)       |                     |
  |------------------------------------>|                     |
  |                                     | method not in       |
  |                                     | METHOD_RULES        |
  |  err forbidden_remote  (id=req_9)   |                     |
  |<------------------------------------|                     |
  |                                     |                     |
  |  req permission.reply               |                     |
  |  (tier=chat)                         |                     |
  |------------------------------------>|                     |
  |  err tier_required                   |                     |
  |<------------------------------------|                     |
  |                                     |                     |
  |  req permission.reply               |                     |
  |  (tier=operator, approvals off)     |                     |
  |------------------------------------>|                     |
  |  err approvals_disabled              |                     |
  |<------------------------------------|                     |
  |                                     |                     |
  |  req session.list                   |                     |
  |------------------------------------>|  permissions.policy |
  |                                     |-------------------->|
  |  result {sessions:[…]}              |  ok                 |
  |<------------------------------------|<--------------------|
```

Every denial returns the daemon envelope with `ok:false` and a gateway error code (§3). The
daemon is never asked to evaluate remote policy; the gateway denies before dispatch.

---

## 12. Open questions

1. **Relay discovery.** How does a device find a host's relay and host id from a QR payload
   (`qrPayload` is currently opaque; `apps/desktop/src/remote/remoteContract.ts:53`)? Is there a
   directory, or is everything in the QR?
2. **Multi-host push.** With several paired hosts, which host may send a `wake` push, and how
   does the client attribute it before it has fetched state?
3. **Key backup.** If a device's non-extractable key is lost, is the only path re-pairing? Is
   there any sealed backup, and who holds it?
4. **Enterprise policy.** Can an administrator pin a relay, forbid the direct path, or force
   approvals off and tiers down? Where is that enforced — host, relay, or device?
5. **Staging lifetime.** How long does a `stagedId` live, and when is staged data removed if a
   prompt never references it?
