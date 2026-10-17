# Bitbots remote protocol (v1)

**Status: Design, not implemented.** This document describes the wire contract between a
device (phone, tablet, browser) and a host's gateway. It is grounded in the daemon as it
exists today; every daemon fact cites its source file. Choices that are not yet forced by the
daemon are marked **(recommendation)** and may change before implementation.

**Amended 16 October 2026.** The owner chose Tailscale. The Noise secure channel, X25519 device
keys, relay framing, `wake` frames and the direct LAN listener of the 15 October draft are
superseded and removed from this document. Tailscale (WireGuard) supplies encryption, node
identity and HTTPS; Bitbots adds device pairing, cookies and tier policy on top.

Vocabulary: a **host** is a computer running Bitbots and its daemon; a **device** is a paired
phone, tablet, browser or computer on the same tailnet; the **gateway** is the host-side
listener that exposes the daemon to remote devices; the **serve address** is the HTTPS URL
`tailscale serve` publishes, for example `https://work-pc.example-tailnet.ts.net`. See
`apps/desktop/src/remote/remoteContract.ts` for the UI shapes this document assumes.

---

## 1. Scope and non-goals

**In scope.** Device-to-host request/response and events over the tailnet. The existing daemon
envelope, filtered for remote. Pairing, the device cookie, resume and replay, the method
allowlist, presence and versioning.

**Non-goals.**

- The loopback daemon API is unchanged. The daemon still binds `127.0.0.1` on an ephemeral
  port and serves `POST /v1/rpc` and `GET /v1/events`
  (`crates/bloblex-daemon/src/main.rs:3381-3384`). Remote never widens that listener.
- The daemon's capability token, its startup bootstrap and its Tauri proxy path are untouched
  (`docs/ipc-contract.md:15-23`).
- This document does not define product policy (who may pair, what a tier means to the user),
  the architecture or the threat model. Those are Director documents under `docs/remote/`.
- No listener on a non-loopback address, no cloud storage of transcripts, no server-side
  authority over sessions. The host daemon remains authoritative (`docs/ipc-contract.md:7`).
- Attachments from remote devices. v1 refuses them (§9).

---

## 2. Layers

| Layer | Carries | Defined in |
|---|---|---|
| Network | WireGuard between tailnet nodes, managed by Tailscale | Tailscale |
| HTTPS | `tailscale serve` terminates TLS with the tailnet certificate and forwards to the gateway on loopback | §2.1 |
| Gateway routes | Static PWA files, `/api/pair`, `/api/me`, `/api/rpc`, `/api/events`, `/api/logout` | §4 |
| Application frames | The existing daemon envelope, filtered | §3 |

### 2.1 Listener and serve

- The gateway is a second listener inside `bitbotsd` on `127.0.0.1:<remote.port>`, default
  `48620`. It runs only while Remote is on. It never binds `0.0.0.0`, a LAN interface or an
  IPv6 wildcard.
- The host publishes it with `tailscale serve --bg --https=443 http://127.0.0.1:<port>`. If
  443 is already served by another handler, it uses `--https=8443`. The chosen port is
  `remote.servePort`.
- Turning Remote off removes only that handler. The gateway never runs `tailscale serve reset`
  and never runs `tailscale funnel`. It checks that Funnel is off for its port and refuses to
  start otherwise.
- The **serve origin** is `https://<DNSName>` (or `https://<DNSName>:8443`), where `DNSName`
  comes from `tailscale status --json` with the trailing dot removed. It is the only accepted
  `Origin` (§4.1).
- Every request reaches the gateway from `127.0.0.1`, because `tailscaled` proxies it. The
  gateway therefore never trusts the peer address, and per-address rate limits are meaningless;
  limits are per device and per pairing offer.

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
| `forbidden_remote` | The method is not on the remote allowlist, or it is `never` remote. |
| `tier_required` | The call is allowed at a higher tier than the device holds. |
| `approvals_disabled` | Approvals from remote are switched off on the host. |
| `quiet_hours` | Quiet hours are on; the host allows reading only. |
| `invalid_params` | A parameter rule refused the call, for example an attachment or `refresh:true`. |
| `rate_limited` | The gateway is throttling this device or this pairing offer. |
| `payload_too_large` | A request body or a WebSocket message exceeds its limit. |
| `device_revoked` | The device's pairing was removed, expired, signed out, or its Tailscale login no longer matches; pair again to continue. |
| `pairing_invalid` | `/api/pair` only: the code is wrong, expired, burned or already used. One code for all four on purpose. |

The 15 October `host_offline` code is removed: with no relay, nothing can answer for an
unreachable host. The client infers it from a failed connection.

These codes sit beside the daemon's stable codes (`invalid_argument`, `not_found`,
`unauthorized`, `unsupported`, `provider_unavailable`, `provider_error`, `conflict`,
`replay_gap`, `internal`; `docs/ipc-contract.md:255`). An error message is safe to display and
carries no credential material or prompt text (`docs/ipc-contract.md:255`).

---

## 4. Gateway routes and authentication

Tailscale encrypts the link and proves which tailnet node is talking. Bitbots still decides
which **device** may act, and at which tier. Every rule in this section runs on the host.

### 4.1 Checks on every `/api/*` request

In this order:

1. **Origin.** The `Origin` header must be present and equal the serve origin (§2.1). A missing
   or different `Origin` is refused with HTTP 403 before anything else runs. This applies to the
   WebSocket upgrade too.
2. **Cookie.** The device cookie must be present. The gateway hashes it with SHA-256 and looks up
   `remote_devices.token_sha256`. No match: HTTP 401, `unauthorized`. A revoked or expired
   device: HTTP 401, `device_revoked`. (`/api/pair` is the only route that runs without it.)
3. **Tailscale login.** If the `Tailscale-User-Login` header is present, it must equal the login
   recorded at pairing. A mismatch is HTTP 401, `device_revoked`, and writes an activity line.
   The header is a second check, never a way in on its own: any local process can reach the
   loopback port and set it.
4. **Size and rate.** A request body over 256 KiB is `payload_too_large`. Calls above the
   per-device rate are `rate_limited`.

### 4.2 The device cookie

| Property | Value |
|---|---|
| Name | `__Host-bitbots_remote` **(recommendation)**; the `__Host-` prefix forces `Secure`, `Path=/` and no `Domain` |
| Value | 256 random bits, base64url, created by the host at approval |
| Attributes | `HttpOnly; Secure; SameSite=Strict; Path=/`, `Max-Age` equal to the idle expiry (no `Max-Age` when expiry is "never") |
| Stored on the host | `sha256(token)` only, never the token |
| Stored on the device | the cookie only; JavaScript cannot read it |

The host stores `{deviceId, name, kind, platform, tier, login, tokenSha256, pairedAt,
lastSeenAt, revokedAt}` in `remote_devices`. `RemoteDevice` already carries the fields the UI
needs (`apps/desktop/src/remote/remoteContract.ts:17-28`).

### 4.3 Pairing (owner-confirmed)

1. On the desktop, `remote.pair.begin` returns `{code, url, qrPayload, expiresAt}`. The code is
   eight characters from a 32-symbol alphabet in two groups (for example `K7QM-4XPD`) and lives
   five minutes (`apps/desktop/src/remote/remoteContract.ts:50-58,119`). One offer is live at a
   time; a new offer cancels the old one.
2. The phone opens the URL and posts `POST /api/pair {code, name, kind, platform}`.
   - A wrong code counts one attempt against the live offer. After five wrong attempts the code
     is burned and the owner must start a new one.
   - The first correct code **locks** the offer to that request. Any later submission, right or
     wrong, is refused. The response is `202 {state:"pending"}` and sets a short-lived
     `__Host-bitbots_pair` cookie (`HttpOnly; Secure; SameSite=Strict`, five minutes) that
     names this pending request.
   - Every failure returns the same `pairing_invalid` error, so a guesser cannot tell a wrong code
     from an expired or burned one.
3. The desktop raises `remote.pairing.requested` with a `pairingId` and the device's name,
   platform and `Tailscale-User-Login` (when the header is present). The owner chooses a tier
   (`viewer`, `chat` or `operator`) and approves with
   `remote.pair.confirm {pairingId, approve:true, tier}`, or rejects with
   `{pairingId, approve:false}`. Rejecting burns the offer. If nobody decides before the code's
   five minutes run out, the request expires. The `remote.*` methods are listed in
   `docs/ipc-contract.md`; none of them is callable from a device.
4. The phone polls `GET /api/pair` **(recommendation: every two seconds)**. It returns
   `pending`, `approved`, `rejected` or `expired`. On `approved` the response sets the device
   cookie (§4.2) and clears the pairing cookie.

```
phone (PWA)                           gateway (127.0.0.1:48620)          desktop (owner)
  |                                      |  <- remote.pair.begin            |
  |                                      |  code K7QM-4XPD, 5 min, 5 tries  |
  |                                      |  -> code + QR of serve URL ----->|
  |  POST /api/pair {code,name,...}      |                                  |
  |------------------------------------->|  offer locked to this request    |
  |  202 pending + pairing cookie        |                                  |
  |<-------------------------------------|  remote.pairing.requested ------>|
  |  GET /api/pair  (poll)               |                                  |
  |------------------------------------->|  <- remote.pair.confirm          |
  |                                      |     {approve:true, tier:"chat"}  |
  |  200 approved + device cookie        |  store sha256(token)             |
  |<-------------------------------------|  remote.pairing.completed ------>|
```

### 4.4 Routes

| Route | Purpose |
|---|---|
| `GET /` and static files | The PWA, served only from paths listed in a manifest built at startup from `BITBOTS_REMOTE_WEB_DIR`. Anything else is 404, which also rules out path traversal. |
| `POST /api/pair`, `GET /api/pair` | Pairing (§4.3). Runs without the device cookie. |
| `GET /api/me` **(recommendation)** | `{protocolVersion:1, device:{id,name,tier}, host:{name}, approvalsFromRemote, quietHoursActive}`, so the client can show what it may do. |
| `POST /api/rpc` | One daemon envelope in, one out (§4.5). |
| `GET /api/events` | WebSocket upgrade for events (§6). |
| `POST /api/logout` | Clears the device cookie and deletes its token hash. The device row stays, marked signed out, until the owner removes it or idle expiry does. |

### 4.5 `POST /api/rpc` pipeline

The body is a daemon request envelope (§3). The gateway runs, in order:

1. **auth**: the checks in §4.1;
2. **quiet hours**: while they are on, every method above `viewer` is refused with `quiet_hours`;
3. **tier policy**: the method's rule in `tiers.json`; unknown or `never` gives
   `forbidden_remote`, too low a tier gives `tier_required`, `permission.reply` without
   approvals from remote gives `approvals_disabled`;
4. **parameter rules**: per-method checks, for example no `refresh:true` on `runtime.models` and
   no attachments at all (§9); a failure is `invalid_params`;
5. **dispatch**: `dispatch()` in-process, with no capability token;
6. **redaction**: `redactResultForRemote` for the method;
7. **audit**: one content-free activity line for writes, approvals and denials.

The response is the daemon envelope. A refused call is `ok:false` with a gateway code (§3), and
the daemon is never asked.

---

## 5. Relay framing (removed)

Superseded on 16 October 2026. There is no relay. Tailscale carries the traffic, and the
gateway sees ordinary HTTPS requests forwarded by `tailscaled` on loopback (§2.1).

---

## 6. Resume and replay

The device keeps its cursor: the highest `sequence` it has applied. On reconnect it opens
`GET /api/events` (a WebSocket upgrade, checked as in §4.1) and sends that cursor; the gateway
replays through the daemon's existing mechanism (`db.replay_events`), then streams live events
through the event allowlist and the scrubber.

- **One live socket per device.** A new socket for the same device closes the older one and
  writes an activity line.
- A WebSocket message from the device other than the first cursor message is ignored. Requests
  go through `POST /api/rpc`, never the socket.

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

The first message on the remote socket is `{"v":1,"afterSequence":<cursor>}`, the same shape
the daemon's own socket takes (`crates/bloblex-daemon/src/main.rs:3264-3272`;
`docs/ipc-contract.md:23`).

```
device                              host gateway
  |  upgrade + afterSequence=418        |
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

- `customEnv` is replaced by `{}`: values and key names are both removed (the code and its test do exactly this).
- An `instructions` string of any length is replaced by `{ "hasInstructions": true }`.
- Absolute filesystem paths in `projectPath` fields are reduced to their last two segments.
- Any key whose name matches `/token|secret|password|credential|capability/i` is removed.

The daemon itself never sends raw provider login credentials (`docs/ipc-contract.md:266`), and
the capability token is memory-only and never leaves the native shell
(`docs/ipc-contract.md:21`). Redaction is the only layer between the host and a device for fields the daemon does keep,
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

<!-- Generated from apps/desktop/src/remote/remoteTiers.ts (renderTierTableMarkdown). The parity test keeps it equal to the daemon dispatch. -->

| Method | Class | Minimum tier | Why |
| --- | --- | --- | --- |
| `app.snapshot` | read | viewer | The authoritative state every remote view is built from; it is redacted before it leaves the host. |
| `events.replay` | read | viewer | Replays retained events after a cursor so a reconnecting device can catch up. |
| `daemon.health` | read | viewer | Daemon version, uptime and heartbeat; it carries no user data. |
| `session.list` | read | viewer | Lists conversations so the device can show what is running. |
| `session.get` | read | viewer | Reads one conversation and its history. |
| `runtime.list` | read | viewer | Lists the coding agents installed on the host. |
| `runtime.capabilities` | read | viewer | Describes which execution settings a runtime supports. |
| `runtime.models` | read | viewer | Lists the models a runtime offers so the device can show the choices. |
| `exec.snapshot.*` | read | viewer | Reads recorded execution snapshots, which already exclude instruction text and environment values. |
| `usage.*` | read | viewer | Reads token and cost summaries. |
| `quota.list` | read | viewer | Reads the provider quota windows the host has recorded. |
| `search.messages` | read | viewer | Searches conversation text on the host. |
| `memory.list` | read | viewer | Lists memory records the person can review. |
| `memory.get` | read | viewer | Reads a single memory record for review. |
| `automation.list` | read | viewer | Lists scheduled automations. |
| `automation.get` | read | viewer | Reads one scheduled automation. |
| `automation.runs` | read | viewer | Lists an automation run history. |
| `automation.preview` | read | viewer | Previews the next run times of a schedule; it changes nothing. |
| `agent.list` | read | viewer | Lists blobs so a device can pick one. |
| `agent.get` | read | viewer | Reads one blob's settings. |
| `project.list` | read | viewer | Lists known projects so a device can pick one. |
| `permissions.policy.get` | read | viewer | Reads the approval policy. |
| `settings.get` | read | viewer | Reads local preferences; the response is filtered before it leaves the host. |
| `runtime.profile.list` | read | viewer | Lists saved runtime profiles. |
| `agent.conversation` | read | viewer | Reads a blob's conversation for viewing. |
| `session.prompt` | chat | chat | Starts a turn in an existing conversation. |
| `session.steer` | chat | chat | Sends guidance into a running turn. |
| `session.cancel` | chat | chat | Stops a running turn. |
| `session.queue.*` | chat | chat | Manages the queued prompts of a conversation. |
| `session.rename` | chat | chat | Renames a conversation. |
| `session.archive` | chat | chat | Hides or restores a conversation. |
| `message.reaction.toggle` | chat | chat | Adds or removes an emoji reaction. |
| `turn.retry.cancel` | chat | chat | Cancels a pending automatic retry. |
| `session.resume` | chat | chat | Resumes a resumable conversation. |
| `session.close` | chat | chat | Closes a managed adapter process. |
| `permission.reply` | approve | operator | Answers a pending approval; only when the host allows approvals from remote. |
| `settings.set` | never | — | A remote device must not change the host's preferences. |
| `agent.create` | never | — | A remote device must not create blobs. |
| `agent.update` | never | — | A remote device must not edit blobs. |
| `agent.delete` | never | — | A remote device must not archive blobs. |
| `agent.restore` | never | — | A remote device must not restore blobs. |
| `agent.reorder` | never | — | A remote device must not reorder blobs. |
| `agent.team.update` | never | — | A remote device must not change blob teams. |
| `project.create` | never | — | A remote device must not create projects. |
| `project.update` | never | — | A remote device must not edit projects. |
| `project.delete` | never | — | A remote device must not delete projects. |
| `runtime.profile.save` | never | — | A remote device must not save runtime profiles. |
| `runtime.profile.delete` | never | — | A remote device must not delete runtime profiles. |
| `runtime.refresh` | never | — | A remote device must not trigger a coding agent scan on the host. |
| `session.new` | never | — | A remote client picks an existing blob and project through a higher-level call, not a session with an arbitrary path. |
| `session.delete` | never | — | A remote device must not permanently delete a conversation. |
| `session.delete.*` | never | — | A remote device must not schedule or cancel a conversation deletion. |
| `file.revert` | never | — | A remote device must not revert files in the host's project. |
| `automation.create` | never | — | A remote device must not create scheduled automations. |
| `automation.update` | never | — | A remote device must not edit scheduled automations. |
| `automation.pause` | never | — | A remote device must not pause a scheduled automation. |
| `automation.resume` | never | — | A remote device must not resume a scheduled automation. |
| `automation.delete` | never | — | A remote device must not delete a scheduled automation. |
| `automation.run_now` | never | — | A remote device must not start an unattended run on the host. |
| `memory.create` | never | — | A remote device must not write memory records. |
| `memory.update` | never | — | A remote device must not edit memory records. |
| `memory.approve` | never | — | A remote device must not approve agent-written memory. |
| `memory.delete` | never | — | A remote device must not delete memory records. |
| `memory.restore` | never | — | A remote device must not restore memory records. |
| `daemon.shutdown` | never | — | A remote device must not stop the host daemon. |
| `hook.event` | never | — | Hook events come from local coding agents, not from a paired device. |
| `mcp.*` | never | — | The MCP bridge is the local agent tool surface, not a remote device surface. |
| `session.handoff.draft` | never | — | A remote device must not draft a handoff between conversations. |
| `session.model.update` | never | — | A remote device must not change a conversation's model, effort or approval mode. |
| `pricing.*` | never | — | Monetary valuation controls are retired and never remote. |
| `subscription.*` | never | — | Subscription controls are retired and never remote. |
| `budget.*` | never | — | Budget controls are retired and never remote. |
| `quota.refresh` | never | — | A remote device must not trigger a provider quota poll on the host; it only needs to read quota.list. |

The Director fills the table above from FIX18's `renderTierTableMarkdown()`. Do not hand-edit
it; regenerate it so it cannot drift from `METHOD_RULES`.

---

## 9. Attachments

**Refused in v1.** `session.prompt` and `session.queue.add` from a remote device must carry no
`attachments`, or an empty list. Anything else is `invalid_params` ("attachments are not
supported from remote devices yet").

Reasons: the local path accepts an absolute host path
(`crates/bloblex-daemon/src/main.rs:2621-2623`), which a device must never send, and a staging
upload area would need its own design (random single-use ids bound to device and session, a time
to live, a per-device byte cap and image decoding limits). That design is deferred. When it
returns, it keeps the daemon's limits: 10 MiB per image (`MAX_ATTACHMENT_BYTES`,
`crates/bloblex-daemon/src/main.rs:2608,2626`), at most 8 per message
(`crates/bloblex-daemon/src/main.rs:2607,2619`), and the host derives the media type from magic
bytes, never from the caller (`crates/bloblex-daemon/src/main.rs:2610-2641`).

---

## 10. Presence and notifications

**Host heartbeat.** The daemon reports `state`, `version`, `uptimeSeconds` and `heartbeatAt`
through `daemon.health` (`crates/bloblex-daemon/src/main.rs:709-711`). The gateway derives
presence from the live event socket, not from a stored value.

**Device online flag.** `RemoteDevice.online` is true while the device has a live event socket
(`apps/desktop/src/remote/remoteContract.ts:26`). On the client, the host is `online`,
`reconnecting`, `asleep` or `offline` (`apps/desktop/src/remote/remoteContract.ts:81`). With
no relay there is no `host_offline` reply: an unreachable address is the signal, and the client
shows its last-seen time.

**Push (P3).** A push notification may contain nothing but a signal to check in. It never
carries message text, bot names, file paths or counts. The client fetches state over the
tailnet after the signal. The host-side activity log already follows this rule: an activity
summary is one short sentence and never message content
(`apps/desktop/src/remote/remoteContract.ts:70-78`).

---

## 11. Versioning and errors

- `protocolVersion` is read from `GET /api/me` at start. The daemon's startup bootstrap and
  every envelope carry protocol version 1 (`docs/ipc-contract.md:15-23,25-51`).
- The PWA is served by the host it talks to, so client and gateway ship together and normally
  match. A stale cached shell is the main mismatch; the service worker prompts for the update.
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

1. **iOS cookie behaviour.** Does an installed iOS PWA keep an `HttpOnly` cookie set in Safari,
   or must pairing happen inside the installed app? Unverified; test before P1 ships.
2. **Tailscale headers.** `Tailscale-User-Login` is absent for tagged nodes and may differ for
   nodes shared from another tailnet. Is pairing allowed when the header is absent? Proposed:
   yes, with the cookie as the only proof, and the desktop shows "no Tailscale login" at
   approval.
3. **Enterprise policy.** Tailnet ACLs already decide which nodes can reach the host. Should
   Bitbots also offer an allowlist of Tailscale logins? Deferred.
4. **Staging design.** When attachments return, how long does a staged upload live and what is
   the per-device cap? Deferred with §9.

Superseded on 16 October 2026 by the Tailscale choice: relay discovery from the QR payload
(the QR now holds the serve URL), multi-host push attribution (one origin per host), and key
backup (there are no device keys; a lost device pairs again).

## Review corrections (15 October 2026, amended 16 October 2026)

These rules supersede earlier wording in this document. They answer
[REVIEW_NOTES.md](REVIEW_NOTES.md) and are implemented as executable policy in
`apps/desktop/src/remote/remoteTiers.ts`, which moves to the shared `remote/tiers.json`; the
gateway that must apply it does not exist yet.

1. **Pairing race.** The first correct code locks the offer; later submissions are refused; the
   owner sees the device and its Tailscale login and must approve it with a tier before a record
   exists (§4.3). This replaces the 15 October handshake nonce.
2. **Browser authentication.** A same-origin `HttpOnly` cookie travels on `fetch` and on the
   WebSocket upgrade, so no ticket or subprotocol is needed. The gateway checks `Origin` on every
   `/api/*` request (§4.1). This replaces the 15 October ticket flow.
3. **Wire codes.** `forbidden_remote`, `tier_required`, `approvals_disabled`, `quiet_hours`
   and `invalid_params` are produced by `authorizeRemoteCall` (and its Rust port); the gateway
   returns them unchanged.
4. **Quiet hours** are a hard read-only override applied before dispatch: every `chat` and
   `approve` method is refused, including cancel, archive, rename, queue and resume.
5. **Events are allowlisted.** Only event types on the allowlist (`EVENT_POLICY`) leave the
   host, and each is scrubbed: no `raw` or provider payloads, no tool detail by default, paths
   reduced. A new daemon event type fails the build until classified.
6. **Reads are redacted, not just the snapshot.** `session.get`, `session.list`, `agent.get`,
   `agent.list`, `runtime.list`, `runtime.profile.list`, `search.messages` and `settings.get`
   (an allowlist of keys) pass through `redactResultForRemote`.
7. **Provider-touching reads.** `runtime.models` with `refresh: true` is refused remotely.
8. **Attachments** are refused in v1 (§9). The staged-upload rules wait for that design.
9. **Revocation** marks the device revoked and closes its event socket on the host; later
   requests get `device_revoked`. There is no relay to tell.
10. **One live event socket per device.** A second socket for the same device closes the first
    and writes an activity line, which also shows a copied cookie in use.

## 13. Native method (17 October 2026)

Native ("Direct" in the UI) is the second way in, with the same gateway router, policy, cookie,
pairing records and event stream as Tailscale. Only one method is active (`remote.method`,
`tailscale` or `native`); switching needs Remote off. Threats and limits are in
[THREAT_MODEL.md §12](THREAT_MODEL.md).

**Listener.** While Native is on, the gateway binds `0.0.0.0` and `[::]` (when available) on
`remote.nativePort` (default 48621) and speaks TLS only (rustls, certificate generated with
rcgen, SANs: the hostname, interface addresses, loopback and the known external address). The
fingerprint is in `remote.status.native.fingerprint`. Plain HTTP connections are dropped. The
Tailscale listener stays loopback-only and is not running at the same time.

**Checks.** As §4.1, except that `Origin` and `Host` must name one of the certificate's own
addresses on the Native port; an origin that belongs to the other method is refused.

**Routes added or changed:**

| Route | Purpose |
|---|---|
| `POST /api/login` | `{username, password, name, kind, platform}`. A wrong pair is `401 login_invalid` (same answer for an unknown username); a locked-out source or a global pause is `429 rate_limited`. A device that already holds a valid cookie gets `200 {state:"approved"}`. Otherwise it starts the owner's approval exactly like `POST /api/pair` (`202 {state:"pending"}`, `remote.pairing.requested` with `method:"native"`), then `GET /api/pair` reports the outcome and sets the cookie. |
| `GET /api/ping` | Unauthenticated self-test, outside the `Origin` check so it can be opened from an address bar. Answers `{"ok":true}` only; records `native.lastReachedAt` and `lastReachedFrom` (a public address, or "this network") and emits `remote.changed`. Rate-limited. |
| `GET /api/me` | Unchanged when signed in, plus `method`. A refusal (`unauthorized`, `device_revoked`) now also carries `"method"` so a signed-out client shows the matching screen: username and password for `native`, the pairing code for `tailscale`. |

**Desktop-only methods** (all `never` remote, on the loopback API): `remote.method.set
{method}`, `remote.native.account.set {username, password}` (stores an Argon2id hash only),
`remote.native.port.set {port}`, `remote.native.cert.regenerate`, `remote.native.upnp.set
{enabled}` (consent; maps or unmaps at once while on), `remote.native.externalIp.set {ip|null}`
(the owner's typed address), `remote.native.firewall.add` and `remote.native.firewall.remove`
(one elevated prompt each; `{result: added|removed|declined|failed|unsupported}`).

**Status.** `remote.status.native` carries `port, urls, fingerprint, accountSet, username,
listening, loginPaused, pausedUntil, lastReachedAt, lastReachedFrom, upnp {consent, state,
error?}, firewall (allowed|missing|unsupported|unknown), externalIp, externalIpSource
(upnp|manual), cgnat, cgnatReason (carrier_nat|private)`. Never the password hash or the key.
