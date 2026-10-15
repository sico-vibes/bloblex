# Remote mode: sequence diagrams

**Status: design.** Written 15 October 2026 as part of FIX24. These diagrams describe the
intended wire behaviour from [PROTOCOL.md](PROTOCOL.md); they do not claim the flows are
implemented. Section numbers below (for example `PROTOCOL §4.3`) refer to that document.
Participants are **Device**, **Relay**, **Gateway** and **Daemon**; **Owner** is the human on
the host making a local decision.

---

## (a) Pairing with a one-time code

Reference: PROTOCOL §4.3 (pairing), §2.1 (transport), §5 (relay framing).

The Owner enables Remote on the host and the Gateway mints a single-use code (eight characters,
five-minute life); the Owner shows that code to the Device by scanning the QR or typing it. The
Device opens a WebSocket to the Relay and addresses the host by `hostId`; the Relay forwards an
opaque `hello` frame without reading its contents. Device and Gateway then run a Noise `XX`
handshake whose prologue folds `H(code ‖ hostId ‖ deviceId ‖ relay)`, so the Relay cannot
substitute keys without breaking the handshake. On success the Gateway assigns a device id and
tier, spends the offer, stores the device record, and returns the pairing result; later
connections use Noise `IK` and no code.

```mermaid
sequenceDiagram
    participant Owner
    participant Device
    participant Relay
    participant Gateway
    participant Daemon

    Owner->>Gateway: enable Remote, request pairing (remote.pair.begin)
    Gateway->>Gateway: mint one-time code K7QM-4XPD, 5 min life
    Gateway-->>Owner: display code + QR {relay, hostId, hostPubKey, code}
    Owner->>Device: scan QR / type code
    Device->>Relay: WebSocket connect (wss)
    Device->>Relay: frame{deviceId, hostId, frameType=hello, len}
    Relay->>Gateway: forward frame(hostId, hello, len)
    Device->>Gateway: Noise XX handshake init
    Note over Device,Gateway: prologue = H(code ‖ hostId ‖ deviceId ‖ relay)
    Gateway->>Device: Noise XX response
    Device->>Gateway: Noise XX finish
    Gateway->>Gateway: verify code in prologue, within 5 min
    Gateway->>Daemon: store device record {deviceId, pubKey, tier=chat}
    Gateway-->>Device: {data} paired, tier=chat
    Gateway-->>Owner: "Pixel 8 connected"
    Note over Gateway,Daemon: offer cleared, code spent
```

---

## (b) First connect after pairing

Reference: PROTOCOL §4.1–§4.2 (Noise `IK`), §6 (resume/replay), §7 (snapshot filtering).

A known Device reconnects with Noise `IK`, proving identity from its stored non-extractable key
and authenticating the host by its static key; no one-time code is needed. After the secure
channel is up the Gateway sends a redacted `app.snapshot` (per §7) so the Device has a full state
and a starting `sequence`, then the Device subscribes to live events with `afterSequence` set to
that snapshot sequence. The subscription is registered before replay, so the Device may see
duplicate sequences and discards them.

```mermaid
sequenceDiagram
    participant Device
    participant Relay
    participant Gateway
    participant Daemon

    Device->>Relay: WebSocket connect, frame{hello, hostId, deviceId}
    Relay->>Gateway: forward hello
    Device->>Gateway: Noise IK handshake (static keys)
    Gateway->>Gateway: match deviceId to stored record, check revoked
    Gateway-->>Device: IK complete, secure channel up
    Device->>Gateway: req app.snapshot
    Gateway->>Daemon: dispatch app.snapshot (internal, no capability token)
    Daemon-->>Gateway: {snapshotVersion, sequence, ...}
    Gateway->>Gateway: redactSnapshotForRemote(snapshot)
    Gateway-->>Device: result redacted snapshot, sequence=S
    Device->>Gateway: subscribe events, afterSequence=S
    Gateway->>Daemon: subscribe live, replay_events(S, 1000)
    Daemon-->>Gateway: events S+1..S+n, replay.complete{throughSequence}
    Gateway-->>Device: live events (Device dedupes by sequence)
```

---

## (c) Reconnect with replay and a `replay.gap`

Reference: PROTOCOL §6 (resume and replay), §3 (`replay_gap`).

On reconnect the Device sends its per-host cursor (highest applied `sequence`). The Gateway asks
the Daemon to replay events after that cursor in batches of 1000. If retention still covers the
gap the Device receives the missing events and then live events, deduping by sequence. If the
cursor is older than retention the Daemon reports `replayAvailable:false` with an
`earliestSequence` (or the live socket emits `replay.gap` and closes when a slow client lags);
the Device then fetches a fresh redacted snapshot and resumes from that snapshot's sequence.

```mermaid
sequenceDiagram
    participant Device
    participant Gateway
    participant Daemon

    Device->>Gateway: hello + afterSequence=418
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
        Gateway-->>Device: replay.gap / replayAvailable=false
        Device->>Gateway: req app.snapshot
        Gateway->>Daemon: dispatch app.snapshot
        Daemon-->>Gateway: fresh snapshot, sequence=S
        Gateway->>Gateway: redactSnapshotForRemote(snapshot)
        Gateway-->>Device: redacted snapshot, resume from S
    end
```

---

## (d) A chat prompt through the gateway including tier check and audit write

Reference: PROTOCOL §8 (allowlist/tiers), §3 (frames), §9 (attachments), §11 (dispatch).

The Device sends `session.prompt` as an ordinary daemon request inside the secure channel. The
Gateway parses the envelope, looks the method up in the tier table, checks the Device holds at
least the `chat` tier (and any per-method conditions), rejects any attachment object carrying a
`path`, and only then calls internal daemon dispatch. After the Daemon acknowledges, the Gateway
appends one content-free audit entry and returns the result; the resulting turn events flow back
over the same channel with replay semantics.

```mermaid
sequenceDiagram
    participant Device
    participant Gateway
    participant Daemon

    Device->>Gateway: req session.prompt {sessionId, text, attachments:[{stagedId}]}
    Gateway->>Gateway: parse envelope, look up session.prompt in METHOD_RULES
    Gateway->>Gateway: check device tier >= chat, reject any {path} attachment
    Gateway->>Daemon: internal dispatch session.prompt
    Daemon-->>Gateway: ok, turn admitted
    Gateway->>Gateway: audit write: kind=prompt, device, one sentence (no content)
    Gateway-->>Device: result {turnId, ...}
    Daemon-->>Gateway: events message.delta / turn.completed
    Gateway-->>Device: live events
```

---

## (e) A denied call

Reference: PROTOCOL §11 (denied call), §8 (never-remote), §3 (gateway error codes).

The Gateway denies before the Daemon is ever asked to evaluate remote policy. A method with no
rule (or a `never` rule) returns `forbidden_remote`; a known method at a tier the Device does not
hold returns `tier_required`; an operator-only method while approvals from remote are off returns
`approvals_disabled`. Each denial is a normal daemon envelope with `ok:false` and a gateway code.

```mermaid
sequenceDiagram
    participant Device
    participant Gateway

    Device->>Gateway: req settings.set {id=req_9}
    Gateway->>Gateway: METHOD_RULES[settings.set] = never
    Gateway-->>Device: err forbidden_remote {id=req_9}

    Device->>Gateway: req permission.reply {tier=chat}
    Gateway->>Gateway: requires operator, device holds chat
    Gateway-->>Device: err tier_required

    Device->>Gateway: req permission.reply {tier=operator}
    Gateway->>Gateway: approvalsFromRemote is off
    Gateway-->>Device: err approvals_disabled
```

---

## (f) Host goes to sleep and the device shows asleep

Reference: PROTOCOL §10 (presence and notifications), ARCHITECTURE §4 (offline).

When the host computer sleeps, the Gateway's link to the Relay drops. The Relay holds no state
and queues nothing, so the Device sees its connection go quiet; the client moves that host to
`asleep` (distinct from `offline`) and shows a last-seen time rather than pretending state is
current. A `wake` frame is content-free and can only prompt a check-in; it cannot wake the
computer. On resume the Device reconnects and replays from its cursor.

```mermaid
sequenceDiagram
    participant Device
    participant Relay
    participant Gateway
    participant Owner

    Note over Gateway: host computer sleeps, link down
    Gateway--xRelay: connection drops
    Relay--xDevice: no frames forwarded (relay stores nothing)
    Device->>Device: mark host asleep, show last-seen
    Owner->>Gateway: (host wakes) gateway reconnects to relay
    Gateway->>Relay: fresh WebSocket, hello(hostId)
    Device->>Relay: retry connect (frame{hello})
    Relay->>Gateway: forward hello
    Device->>Gateway: afterSequence=cursor
    Gateway-->>Device: replay then live events
    Device->>Device: mark host online
```

---

## (g) Revoking a device

Reference: ARCHITECTURE §3 (revocation), PROTOCOL §3 (`device_revoked`), §10.

The Owner removes a paired device on the host. The Gateway deletes the device record, closes its
active session and tells the Relay to drop that device id, so its key is dead immediately; any
in-flight or later call from that device fails with `device_revoked`. The device must pair again
with a new one-time code to be restored.

```mermaid
sequenceDiagram
    participant Owner
    participant Gateway
    participant Device
    participant Relay

    Owner->>Gateway: remove device (remote.device.revoke)
    Gateway->>Gateway: delete device record, invalidate its key
    Gateway->>Relay: drop deviceId
    Gateway--xDevice: close active session
    Device->>Gateway: req session.list (stale key)
    Gateway-->>Device: err device_revoked
    Note over Device: must re-pair with a new code (flow a)
```
