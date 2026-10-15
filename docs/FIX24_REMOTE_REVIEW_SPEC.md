# FIX24: independent review of the Remote design, and the sequence diagrams

Written 15 October 2026. Docs-only lane. You are a second pair of eyes: the Director wrote
`docs/remote/ARCHITECTURE.md` and `docs/remote/THREAT_MODEL.md`; a DeepSeek lane wrote
`docs/remote/PROTOCOL.md`. Do not edit those three files. Do not change any code.

Read: `docs/remote/*`, `docs/ipc-contract.md`, `AGENTS.md`, `apps/desktop/src/remote/*`,
`crates/bloblex-daemon/src/main.rs` (transport, auth, dispatch, event replay),
`apps/desktop/src-tauri/src/lib.rs` (`daemon_rpc`, attachment staging, native commands).

## Output 1: `docs/remote/REVIEW_NOTES.md`

A critical review with these sections. Cite file and line for every claim about the code.

1. **Contradictions** between the documents, or between a document and the code.
2. **Threats missing** from the threat model (think: pairing race, relay compromise, device
   clone, notification content, attachment path tricks, event payloads that carry secrets,
   `app.snapshot` fields not covered by redaction, `settings.get`, tool output containing
   secrets, WebSocket subprotocol/ticket for browsers, CSRF/clickjacking of the PWA, replay of
   a recorded pairing). For each, say severity (high/medium/low), why, and a concrete fix.
3. **Weak mitigations**: where a stated mitigation would not hold up, and why.
4. **Redaction gaps**: read the snapshot and event shapes in the daemon/storage code and list
   concrete fields that `redactSnapshotForRemote` (in `apps/desktop/src/remote/remoteTiers.ts`)
   does not handle, with the field path.
5. **Tier table review**: any method classified too loosely, or any dispatched method whose
   params make it unsafe at its tier even though the method name looks safe.
6. **Open questions** the owner must answer before P1.

Be specific and short. No praise paragraphs. If you find nothing in a section, say "none found"
and list what you checked.

## Output 2: sequence diagrams

Create `docs/remote/SEQUENCES.md` with Mermaid `sequenceDiagram` blocks (and a one-paragraph
plain-text description under each) for: (a) pairing with a one-time code, (b) first connect
after pairing, (c) reconnect with replay and a `replay.gap`, (d) a chat prompt through the
gateway including tier check and audit write, (e) a denied call, (f) host goes to sleep and the
device shows asleep, (g) revoking a device. Use the participant names Device, Relay, Gateway,
Daemon, Owner. Cross-reference PROTOCOL.md section numbers.

## Finish

Never commit. End with a five-line summary of the most serious findings.
