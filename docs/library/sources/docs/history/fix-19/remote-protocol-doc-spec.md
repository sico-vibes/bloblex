# FIX19: write `docs/remote/PROTOCOL.md` (draft for the Director)

> **What this is:** Spec for FIX19: writing the remote protocol document (draft for the Director).
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026. Docs-only lane: do not change code. The Director writes the product
spec, architecture, threat model and UX flows; this lane writes the wire-level protocol so
it is grounded in how the daemon actually works today.

Read first: `docs/ipc-contract.md`, `crates/bloblex-daemon/src/main.rs` (transport at the
`/v1/rpc` and `/v1/events` routes, `events.replay`, WebSocket handshake with `afterSequence`,
`replay.gap`, broadcast capacity), `crates/bloblex-storage/src/lib.rs` (persisted event
sequence), `apps/desktop/src/remote/remoteContract.ts`.

## Target document

`docs/remote/PROTOCOL.md`, status "Design, not implemented". Sections:

1. **Scope and non-goals.** Remote protocol between a client device and a host's gateway,
   carried over a relay or a direct socket. The loopback daemon API is unchanged.
2. **Layers.** transport (WebSocket over TLS to the relay or a direct address) / secure
   channel (Noise, see 4) / application frames (the existing daemon envelope, filtered).
3. **Application frames.** Reuse the daemon envelope (`v`, `id`, `method`, `params` /
   `ok`, `result`/`error`; events with `eventId`, `sequence`, `type`, `payload`) exactly,
   plus gateway-added error codes: `forbidden_remote`, `tier_required`, `approvals_disabled`,
   `host_offline`, `rate_limited`, `payload_too_large`, `device_revoked`.
4. **Secure channel.** Noise `XX` for first contact (pairing) and `IK` for known devices,
   X25519, ChaCha20-Poly1305, BLAKE2s. State what each side stores (host: device public
   keys and tiers; device: its non-extractable key and the host public key). Rekey every
   1 GiB or 1 hour. Include a pairing sequence: one-time code (5 min) bound into the
   handshake prologue so the relay cannot swap keys. Mark choices as recommendations.
5. **Relay framing.** Opaque routing header: `deviceId`, `hostId`, `frameType`
   (`hello`, `data`, `ping`, `wake`), `len`; nothing else is visible. Relay behaviour:
   rate limits, max frame 256 KiB, no storage of data frames, wake pings carry no content.
6. **Resume and replay.** Per-host cursor on the client; on reconnect send
   `afterSequence`; the gateway replays through the existing mechanism; `replay.gap` leads
   to a fresh `app.snapshot`. Note the daemon facts: replay batches of 1000, broadcast
   capacity 1024 and slow clients get a gap and a closed socket; sequences are
   daemon-global.
7. **Snapshot filtering.** `app.snapshot` is redacted for remote (see
   `redactSnapshotForRemote` in FIX18): no env values, no instruction text, trimmed paths.
8. **Method allowlist.** Insert the placeholder line `<!-- TIER-TABLE -->`; the Director
   fills it from FIX18's generator. Describe the three tiers and "never remote".
9. **Attachments.** Chunked upload to a staging area through the gateway: size limits
   (10 MiB per image today), magic-byte check, returned `stagedId`; prompts reference
   `stagedId` only.
10. **Presence and notifications.** Host heartbeat, device `online` flag, `wake` pings,
    what a push payload may contain (nothing but "check in").
11. **Versioning and errors.** `protocolVersion` negotiation, unknown fields ignored,
    deprecation rule.
12. **Open questions.** A short numbered list (relay discovery, multi-host push, key backup,
    enterprise policy).

Include at least three ASCII sequence diagrams: pairing, reconnect with replay, a denied call.
Tone: precise, short sentences, no marketing. Cite the source file for every daemon fact.

## Gates

None (docs only). Never commit. Leave the file in the working tree and finish with a
five-line summary of what you were unsure about.
