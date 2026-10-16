# Remote mode: sequence diagrams

**Status: design.** Written 15 October 2026 as part of FIX24; rewritten 16 October 2026 for
the owner's choice of Tailscale. The 15 October diagrams (relay, Noise XX/IK handshakes) are
superseded and are in git history. These diagrams describe the intended behaviour from
[PROTOCOL.md](PROTOCOL.md); they do not claim the flows are implemented. Section numbers below
(for example `PROTOCOL §4.3`) refer to that document. Participants are **Device** (the PWA),
**Tailscale** (`tailscaled` on the host, which terminates HTTPS and forwards to loopback),
**Gateway** (the second listener in `bitbotsd`) and **Daemon** (in-process dispatch); **Owner**
is the human on the host making a local decision.

---

## (a) Pairing with a one-time code and owner approval

Reference: PROTOCOL §4.3 (pairing), §4.2 (cookie), §2.1 (listener and serve).

The Owner turns Remote on and asks for a code. The Gateway mints an 8-character code valid for
five minutes with five attempts. The Device opens the serve address from the QR and posts the
code. The first correct code locks the offer. The Owner sees the device and its Tailscale login
and approves it with a tier. The Device's next poll receives the cookie; the host stores only
its hash.

```mermaid
sequenceDiagram
    participant Owner
    participant Device
    participant Tailscale
    participant Gateway

    Owner->>Gateway: remote.pair.begin
    Gateway->>Gateway: mint code K7QM-4XPD, 5 min, 5 attempts
    Gateway-->>Owner: code + QR of https://work-pc.<tailnet>.ts.net
    Owner->>Device: scan QR / type code
    Device->>Tailscale: POST /api/pair {code, name, kind, platform} (HTTPS over WireGuard)
    Tailscale->>Gateway: forward to 127.0.0.1:48620 (+ Tailscale-User-Login)
    Gateway->>Gateway: check Origin, check code, lock offer
    Gateway-->>Device: 202 pending + pairing cookie
    Gateway-->>Owner: remote.pairing.requested {pairingId, name, login}
    Device->>Gateway: GET /api/pair (poll)
    Gateway-->>Device: pending
    Owner->>Gateway: remote.pair.confirm {pairingId, approve, tier=chat}
    Gateway->>Gateway: create device, store sha256(token), spend offer
    Device->>Gateway: GET /api/pair (poll)
    Gateway-->>Device: approved + Set-Cookie (HttpOnly, Secure, SameSite=Strict)
    Gateway-->>Owner: remote.pairing.completed, "iPhone is connected"
```

---

## (b) First connect after pairing

Reference: PROTOCOL §4.1 (checks), §6 (resume/replay), §7 (snapshot filtering).

The Device calls `/api/me` to learn its tier, then `app.snapshot` through `/api/rpc`. The
Gateway checks Origin, cookie and login, dispatches in-process with no capability, and redacts
the result. The Device then opens the event socket with the snapshot's sequence. The
subscription is registered before replay, so the Device may see duplicate sequences and
discards them.

```mermaid
sequenceDiagram
    participant Device
    participant Gateway
    participant Daemon

    Device->>Gateway: GET /api/me (cookie)
    Gateway->>Gateway: Origin, sha256(cookie) lookup, revoked?, login matches?
    Gateway-->>Device: {protocolVersion, device{tier}, host{name}}
    Device->>Gateway: POST /api/rpc app.snapshot
    Gateway->>Daemon: dispatch app.snapshot (in-process, no capability)
    Daemon-->>Gateway: {snapshotVersion, sequence, ...}
    Gateway->>Gateway: redactSnapshotForRemote(snapshot)
    Gateway-->>Device: redacted snapshot, sequence=S
    Device->>Gateway: GET /api/events (WebSocket upgrade), {"v":1,"afterSequence":S}
    Gateway->>Daemon: subscribe live, replay_events(S, 1000)
    Daemon-->>Gateway: events S+1..S+n, replay.complete{throughSequence}
    Gateway-->>Device: allowlisted, scrubbed events (Device dedupes by sequence)
```

---

## (c) Reconnect with replay and a `replay.gap`

Reference: PROTOCOL §6 (resume and replay), §3 (`replay_gap`).

On reconnect the Device sends its cursor. If retention still covers the gap the Device receives
the missing events and then live events. If the cursor is older than retention, or a slow client
lags, the Device fetches a fresh redacted snapshot and resumes from its sequence.

```mermaid
sequenceDiagram
    participant Device
    participant Gateway
    participant Daemon

    Device->>Gateway: GET /api/events, afterSequence=418
    Gateway->>Gateway: close any older socket of this device
    Gateway->>Daemon: subscribe live, replay_events(418, 1000)
    alt retention covers the gap
        Daemon-->>Gateway: events 419..1418
        Gateway-->>Device: events 419..1418
        Daemon-->>Gateway: events.replay.complete{throughSequence=1418}
        Gateway-->>Device: replay complete
        Daemon-->>Gateway: live events 1419...
        Gateway-->>Device: live events (dedupe by sequence)
    else cursor too old for retention
        Daemon-->>Gateway: replayAvailable=false, earliestSequence=E
        Gateway-->>Device: replay.gap, socket closed
        Device->>Gateway: POST /api/rpc app.snapshot
        Gateway->>Daemon: dispatch app.snapshot
        Daemon-->>Gateway: fresh snapshot, sequence=S
        Gateway->>Gateway: redactSnapshotForRemote(snapshot)
        Gateway-->>Device: redacted snapshot, resume from S
    end
```

---

## (d) A chat prompt through the gateway

Reference: PROTOCOL §4.5 (pipeline), §8 (allowlist/tiers), §9 (attachments).

The Device posts `session.prompt` to `/api/rpc`. The Gateway runs auth, quiet hours, the tier
policy and the parameter rules (no attachments in v1), then dispatches in-process, redacts the
result and writes one content-free activity line.

```mermaid
sequenceDiagram
    participant Device
    participant Gateway
    participant Daemon

    Device->>Gateway: POST /api/rpc session.prompt {sessionId, text}
    Gateway->>Gateway: auth (Origin, cookie, login)
    Gateway->>Gateway: quiet hours off?
    Gateway->>Gateway: tiers.json: session.prompt needs chat; device holds chat
    Gateway->>Gateway: param rules: no attachments
    Gateway->>Daemon: dispatch session.prompt (in-process)
    Daemon-->>Gateway: ok, turn admitted
    Gateway->>Gateway: redactResultForRemote, audit: kind=prompt, device (no content)
    Gateway-->>Device: result {turnId, ...}
    Daemon-->>Gateway: events message.delta / turn.completed
    Gateway-->>Device: allowlisted events on /api/events
```

---

## (e) Denied calls

Reference: PROTOCOL §4.1, §4.5, §11 (denied call), §3 (gateway error codes).

The Gateway denies before the Daemon is asked. A request from another origin is refused at
HTTP level. A `never` method returns `forbidden_remote`; a method above the device's tier returns
`tier_required`; `permission.reply` while approvals from remote are off returns
`approvals_disabled`; any write during quiet hours returns `quiet_hours`.

```mermaid
sequenceDiagram
    participant Device
    participant Gateway

    Device->>Gateway: POST /api/rpc (Origin: https://evil.example)
    Gateway-->>Device: HTTP 403

    Device->>Gateway: POST /api/rpc settings.set {id=req_9}
    Gateway->>Gateway: tiers.json[settings.set] = never
    Gateway-->>Device: err forbidden_remote {id=req_9}

    Device->>Gateway: POST /api/rpc permission.reply (device tier chat)
    Gateway->>Gateway: requires operator
    Gateway-->>Device: err tier_required

    Device->>Gateway: POST /api/rpc permission.reply (device tier operator)
    Gateway->>Gateway: approvalsFromRemote is off
    Gateway-->>Device: err approvals_disabled
```

---

## (f) Host goes to sleep and the device shows asleep

Reference: PROTOCOL §10 (presence), ARCHITECTURE §4 (offline).

When the host sleeps, its tailnet address stops answering and the Device's socket drops. Nothing
is queued anywhere. The client marks the host asleep or offline and shows the last-seen time.
When the host wakes, the daemon listens again and re-applies its serve handler; the Device
reconnects and replays from its cursor.

```mermaid
sequenceDiagram
    participant Device
    participant Tailscale
    participant Gateway

    Note over Tailscale,Gateway: host computer sleeps
    Gateway--xDevice: event socket drops
    Device->>Device: mark host asleep, show last-seen
    Device->>Tailscale: retry with back-off (no answer)
    Note over Tailscale,Gateway: host wakes
    Gateway->>Tailscale: listener up, serve handler re-applied
    Device->>Gateway: GET /api/events, afterSequence=cursor
    Gateway-->>Device: replay then live events
    Device->>Device: mark host online
```

---

## (g) Revoking a device

Reference: ARCHITECTURE §3 (revocation), PROTOCOL §3 (`device_revoked`).

The Owner removes a paired device on the host. The Gateway marks the record revoked (it keeps
the hash only so it can answer `device_revoked`) and closes the device's socket. Any later request fails with `device_revoked`. The device
must pair again with a new code. There is no third party to notify.

```mermaid
sequenceDiagram
    participant Owner
    participant Gateway
    participant Device

    Owner->>Gateway: remote.devices.revoke {deviceId}
    Gateway->>Gateway: set revokedAt on the record
    Gateway--xDevice: close event socket
    Device->>Gateway: POST /api/rpc session.list (old cookie)
    Gateway-->>Device: HTTP 401, err device_revoked
    Note over Device: must pair again with a new code (flow a)
```
