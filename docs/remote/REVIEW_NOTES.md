# Remote mode: independent review (FIX24)

Reviewer: OpenCode lane, 15 October 2026. Docs-only; no code or existing design file was
edited. Claims about code cite `file:line`. Read: `docs/remote/*`, `docs/ipc-contract.md`,
`apps/desktop/src/remote/*`, `crates/bloblex-daemon/src/main.rs` (auth, dispatch, events,
attachments, startup), `apps/desktop/src-tauri/src/lib.rs` (`daemon_rpc`, `rpc_call`,
attachment staging, native commands). Sequence diagrams: [SEQUENCES.md](SEQUENCES.md).

## 1. Contradictions

- **The tier table is described as enforced when it is not.** `remoteTiers.ts:2-4` says
  `daemon_rpc` "consults this table (via `authorizeRemoteCall`) instead of passing calls
  through". `lib.rs:449-463` `daemon_rpc` is a pure pass-through: it forwards `method`/`params`
  and only stores the sequence for `app.snapshot`. It never calls `authorizeRemoteCall` and
  never imports `remoteTiers`. `ARCHITECTURE.md:15` correctly calls it "a pass-through with no
  method allowlist". The code comment asserts an enforcement that does not exist.
- **`customEnv` redaction contradicts itself.** `PROTOCOL.md:257` says `customEnv` values are
  removed and "key names only" are kept. `remoteTiers.ts:235-238` replaces `customEnv` with
  `{}` — key names are dropped — and `remoteTiers.test.ts:136` asserts `customEnv` equals `{}`.
  The doc and the code disagree; one must change.
- **Relay visibility contradicts itself.** `ARCHITECTURE.md:61-67` says the relay
  "authenticates each by a signed hello that proves a registered public key ... has no
  accounts". `PROTOCOL.md:177-187` says the relay sees only `deviceId`, `hostId`, `frameType`
  and `len`, and "Nothing else is visible to the relay". A signature the relay verifies must be
  visible to the relay. This is the linchpin of "the relay cannot read content" and the two
  documents must be reconciled.
- **Redaction of non-snapshot reads is claimed but has no implementation path.**
  `PROTOCOL.md:267-268` says the gateway applies the same redaction inside `settings.get`,
  `session.get` and `agent.get`. The only redactor is `redactSnapshotForRemote`
  (`remoteTiers.ts:260`); nothing calls it for those methods, and `session.get`
  (`main.rs:864-867`) and `agent.get` (`main.rs:651`) return their DTOs unwrapped.
- **"Paths are shortened" is broader than the code.** `REMOTE_MODE.md:81-82` and the
  `PROTOCOL.md:296` row say snapshots are redacted of paths. The redactor only rewrites keys
  named exactly `projectPath` (`remoteTiers.ts:243`). The snapshot also carries
  `runtimes[].executablePath` (`ipc-contract.md:61`; served raw at `main.rs:717`) and
  `agents[].defaultProject` (`lib.rs:3362`), which pass through unchanged. See §4.
- **"Server-side tier table" overstates what exists.** `THREAT_MODEL.md:51` (T5) and
  `AGENTS_AMENDMENT_DRAFT.md:28-30` describe the policy as "server-side" and "mirrored in the
  daemon", enforced by a parity test. There is no tier table in `main.rs`. The parity test
  (`remoteTiers.parity.test.ts:92-117`) compares the TypeScript table to the Rust dispatch
  *strings*, not to any Rust enforcement. The "mirror" is unbuilt and untested.
- **Gateway error codes have no producer.** `PROTOCOL.md:97-99` defines `forbidden_remote` and
  `tier_required`. `remoteTiers.ts:190-205` returns only prose reasons ("not on the remote
  allowlist", "a viewer device cannot call …") and never a code. The mapping from a policy
  denial to a wire code does not exist yet.
- **Attachment count/limit citation.** `PROTOCOL.md:382-383` cites `main.rs:2607,2619` for 8
  attachments and `2608,2626` for 10 MiB; both match the code (`MAX_PROMPT_ATTACHMENTS = 8`,
  `MAX_ATTACHMENT_BYTES = 10 MiB`). Consistent, listed as checked.

## 2. Threats missing from the threat model

Each item names a threat the table in `THREAT_MODEL.md:45-61` does not cover.

- **Pairing race on one code — high.** `PROTOCOL.md:146-151` binds `deviceId` into the
  handshake prologue, but for a new device the host does not yet know its id, so the device
  supplies it before the host has a record. Two devices that start `XX` with the same live code
  race for it, and nothing in the design says the spend is atomic or that the second handshake
  is rejected. Fix: spend the code atomically and bound to one handshake; reject a second
  handshake on the same offer; use a host-issued random pairing nonce, not a device-chosen id,
  in the prologue.
- **Relay correlation and traffic shape — medium.** T3 concedes timing/sizes only, but
  `PROTOCOL.md:180-185` sends stable `deviceId`/`hostId` on every frame, so the relay can build
  a long-term device↔host map and fingerprint message sizes (`len`). Fix: per-connection
  routing tokens issued by the relay, rotated each connection, and padding of small frames.
- **Device clone where non-extractable keys are unavailable — medium.** T8 assumes a
  non-extractable key; `ARCHITECTURE.md:88` allows "a wrapped key where that is unavailable".
  A wrapped key plus its unwrap secret on the same device is copyable, and the host cannot tell
  a clone from the original because it only sees the same `deviceId`. Fix: one live session per
  device id, an alert on a concurrent second session, and hardware-keystore binding where
  available.
- **Notification content and counts — low/medium.** `PROTOCOL.md:412-416` forbids text in push
  but is silent on counts; `ARCHITECTURE.md:111-113` and `remoteContract.ts:88-91` surface
  `waitingCount`/`botCount`. A "1 needs you" push leaks activity metadata. Fix: state whether
  counts are allowed in push; keep them on the secure channel only.
- **Attachment staging as an unbound object store — medium.** T7 covers `path`→`stagedId`, but
  `PROTOCOL.md:376-388` never says the `stagedId` is random, single-use, or bound to the
  uploading device or session. It also does not cap total staged bytes per device. A device can
  guess/iterate ids, reuse one upload across many prompts, or stage a decompression bomb that
  passes the magic-byte check (`main.rs:2636-2642` reads only the header). Fix: random
  single-use ids bound to `deviceId`+session with a TTL, and a per-device staged-bytes cap.
- **Event payloads that carry secrets — high.** `ARCHITECTURE.md:55` says the gateway "redacts
  event payloads", but no field policy exists and none of the emitter payloads are scrubbed:
  `message.completed` carries the full message body and `tool.changed` carries tool `detail`
  (`main.rs:3243-3256`, `lib.rs:3374-3378`). Tool output and pasted chat text routinely contain
  secrets. Fix: an explicit event allowlist; drop `raw`, provider text, env values and tool
  output by default.
- **`app.snapshot` fields outside the redactor — high.** See §4 for the concrete list
  (`executablePath`, `defaultProject`, `customArgs`, message `content`, tool `detail`, message
  `attachments[].path`).
- **`settings.get` returns the whole settings map — medium.** `main.rs:1037` returns
  `st.db.settings()`, i.e. every key (`lib.rs:3396-3405`), including `profile.about` free text
  and `appearance.*`. Write-time validation blocks credential markers, but remote needs an
  allowlist of readable keys, not the whole store.
- **Tool output containing secrets — medium.** T12 covers prompt injection but not that tool
  output (e.g. an `env` dump) is shown to the device. Fix: hide tool output on remote by
  default, or pass it through a redactor first.
- **WebSocket authentication for browsers — high.** `PROTOCOL.md:47-53` uses `wss://` for the
  browser client, but browsers cannot set arbitrary headers and cannot carry a Noise `IK` easily
  over a raw socket; a ticket in the URL or a subprotocol is unavoidable, and a ticket in a URL
  lands in logs and history. No mechanism is specified. Fix: a short-lived ticket (never a
  long-term key) plus a documented custom subprotocol, and an Origin check at the relay.
- **CSRF / clickjacking of the PWA — medium.** T9 leans on "no cookies carry authority" and a
  CSP, but WebSocket initiation is not covered by the same-origin policy, and none of the read
  files define a CSP (`main.tsx:10-12` only registers a service worker). Fix: Origin allowlist
  at the gateway/relay, `frame-ancestors` and `connect-src` in the PWA CSP, and no approval
  action from a cross-origin frame.
- **Replay of a recorded pairing — low/medium.** T10 says "none expected", which is right for
  the Noise transcript (fresh keys, single-use code), but a replayer who already holds the code
  within five minutes pairs as a fresh device and chooses the device name the owner sees
  ("Pixel 8 connected", `UX_FLOWS.md:36`). Fix: require the owner to confirm the presented key
  fingerprint before the record is committed.
- **Quiet hours bypass by indirect writes — medium.** `REMOTE_MODE.md:78-79` and the T1 control
  treat quiet hours as read-only, but a device can still change host state indirectly through
  `session.cancel`, `session.archive` and `session.queue.send_now` (`remoteTiers.ts:111-118`).
  Fix: define quiet hours as a hard read-only override applied on the host before dispatch.
- **Revocation when the relay is unreachable — medium.** `ARCHITECTURE.md:94-95` tells the relay
  to drop the device id, but a live direct connection (`PROTOCOL.md:49-51`) or an unreachable
  relay leaves the session up. Fix: the gateway closes the session first and treats the relay
  drop as best-effort; document the direct path explicitly.

## 3. Weak mitigations

- **T4 pairing code.** `THREAT_MODEL.md:50` cites "rate-limited attempts per host". The code is
  40 bits (32^8), which is fine against online guessing only if the host actually rate-limits;
  no limit value, window, or lockout is stated, and the check runs on the host, so a flood costs
  the host a handshake each time. The real exposure is shoulder-surfing the on-screen code, which
  the mitigation does not address beyond "QR shown only on the host screen".
- **T5 "server-side tier table; parity test fails the build".** The parity test
  (`remoteTiers.parity.test.ts`) proves the TypeScript list covers the Rust dispatch strings. It
  does not prove any runtime check, because there is no Rust check to make. A mirrored Rust table
  could be absent or wrong and the test stays green. It also only parses dispatch arms matching
  `^ {8}("..."(\s*\|\s*"...")*)\s*=>` (`remoteTiers.parity.test.ts:58`) and `starts_with`
  guards on `req.method|method|m|req_method` (`:66`); a method dispatched another way would be
  invisible.
- **T9 "CSP with `connect-src` limited to the relay and self".** No CSP exists in the files this
  review read; the PWA entry (`main.tsx`) only registers a service worker. CSP does cover
  WebSocket via `connect-src`, so the mitigation is good *if* written — but it is asserted, not
  present.
- **T10 "Noise nonces; sessions are per connection; none expected".** Correct for frame replay,
  but it silently assumes the one-time code cannot be replayed. Within the five-minute window a
  code can be used once (good), yet the model does not state that the pairing *offer* is consumed
  atomically, nor that a `wake` frame replay (harmless in content, per `PROTOCOL.md:196`) cannot
  be used to spam a device into notify-frequency behaviour.
- **T14 "one short templated sentence, covered by a unit test on every entry kind".** No such
  test exists in `apps/desktop/src/remote/*`; `RemoteActivityEntry.summary` (`remoteContract.ts:70-78`)
  has no template validator, and the generator will live in Rust where it is also untested today.
- **T3 prologue binding.** Binding `H(code ‖ hostId ‖ deviceId ‖ relay)` stops a relay swapping
  keys, which is the claim. It does not stop the relay from *dropping* one side's handshake and
  letting a device pair only with a host it chooses, nor from a denial-of-service on a known
  `hostId`. Those are availability, not confidentiality, but they are outside the stated
  mitigation and unmentioned.
- **Idle expiry as a control.** `THREAT_MODEL.md:68` relies on "idle devices expire in 30 days",
  but `remoteContract.ts:63-64` offers `0` ("never"). Choosing "never" removes the only
  automatic containment for a device the owner forgets about. The default is safe; the option
  should be flagged in the model.
- **`app.snapshot` redaction as defence in depth.** `PROTOCOL.md:264` calls redaction "defense in
  depth" behind the daemon never sending credentials. That holds for `customEnv` and
  `instructions`, but not for message bodies, tool output and `customArgs`, which the redactor
  does not touch and the daemon does send (§4). The "defence in depth" framing over-credits the
  one layer that exists.

## 4. Redaction gaps

`redactSnapshotForRemote` (`remoteTiers.ts:229-262`) recurses over the whole object and handles
only: any key matching `/token|secret|password|credential|capability/i`, `customEnv`, a
non-empty `instructions`, and a `projectPath`. Everything else passes through. Against the real
shapes (`lib.rs:3357` snapshot; `agent_rows_locked` `lib.rs:3362`; `session_detail_locked`
`lib.rs:3365-3380`) these fields are not handled:

| Field path | Why it matters | Severity |
|---|---|---|
| `runtimes[].executablePath` | Absolute host path, served raw (`main.rs:717`); docs promise shortening | high |
| `agents[].defaultProject` | Absolute project path under a key that is not `projectPath` | high |
| `agents[].customArgs` | Runtime args; can hold a path or a flag value (e.g. an API key) | medium |
| `sessions[].messages[].content` | User and agent text; pasted secrets are the known case (`THREAT_MODEL.md:18`) | high |
| `sessions[].messages[].attachments` | Stored attachment objects carry a host path (`{name,path}`, `ipc-contract.md:143`) | medium |
| `sessions[].tools[].detail` | Tool command/output; an `env` or file dump is a secret | high |
| `sessions[].files[].path` and `.detail` | Host project file paths and diff detail | medium |
| `sessions[].turns[].detail` | Provider turn-error text pulled from an event payload (`lib.rs:3374`) | medium |
| `sessions[].providerSessionId` | Cross-system provider thread id | low |
| `settings` (every key) | Whole map; `profile.about` is free text, future keys unbounded | medium |
| `hosts[].name` | Machine name (`lib.rs:3357`, `COMPUTERNAME`) | low |
| `projects[]` | Project rows likely carry an absolute path; not inspected here — verify | medium |
| any key named `apiKey`, `privateKey`, `authorization`, `bearer`, `cookie` | The `SENSITIVE_KEY` regex does not match these spellings | medium |

Notes: the same gaps apply to the non-snapshot reads that `PROTOCOL.md:267-268` says are
redacted (`session.get`, `agent.get`, `settings.get`) unless the gateway routes them through the
redactor too, which nothing currently does. `exec.snapshot.*` results are safe by construction
(`lib.rs:4044-4047` insert `Value::Null` for `instructions`/`customEnv`), but they are not routed
through the redactor either, so they rely on that invariant holding. The recursive handling of
nested `instructions`/`customEnv`/`projectPath` and the non-mutating contract are correct
(`remoteTiers.test.ts:149-155`).

## 5. Tier table review

Methods whose name looks safe but whose result or params make them unsafe at the tier listed:

- **`runtime.models` at viewer — refresh side effect.** `ipc-contract.md:69` documents
  `refresh:true` as bypassing the cache and re-querying the provider. A viewer device can force
  provider polls (network, rate, possibly cost) with a read-labelled method. Fix: a param rule
  that rejects `refresh:true` for remote, or move refresh to an operator-only method.
- **`runtime.profile.list` at viewer — config leak.** The profile DTO carries
  `executablePath` and `args` (`ipc-contract.md:200`), neither of which redaction touches.
  A viewer device reads host paths and launch arguments. Fix: redact or drop `executablePath`
  and `args` from the remote result.
- **`runtime.list` at viewer — config leak.** Same `executablePath` (`ipc-contract.md:61`,
  `main.rs:717`). See §4.
- **`settings.get` at viewer — whole map.** Returns every key (`main.rs:1037`,
  `lib.rs:3396-3405`). Should be an allowlist of readable keys.
- **`agent.get` at viewer — `customArgs`.** Returns the Agent DTO including `customArgs`
  (`lib.rs:3362`), which redaction does not strip.
- **`search.messages` at viewer.** Returns matching transcript text. Consistent with the read
  intent (the device is the owner's) but it is a second content surface beyond `session.get`,
  and it is not redacted.
- **`memory.list` / `memory.get` at viewer.** Returns note bodies, which the user may have
  pasted secrets into. Reading is intended, but note it is a content surface.
- **`automation.get` / `automation.runs` at viewer.** `automation.get` returns the stored
  `prompt` text (`ipc-contract.md:157`), i.e. text not present in any chat transcript.
- **`quota.list` at viewer.** Provider quota windows can reveal plan and account state. Low.
- **`session.resume` at chat.** Starts a provider process (and can cost money) with no prompt.
  Consistent with chat, but it is an action, not a message; worth an explicit note.

Not found too loose: the `never` set is complete against the dispatch (verified by the parity
test's coverage assertion, `remoteTiers.parity.test.ts:92-95`), and `permission.reply` correctly
requires both operator and host consent (`remoteTiers.ts:197-199`). The `stagedAttachmentRule`
correctly rejects any `path` and requires a `stagedId` (`remoteTiers.ts:46-57`); it is attached
to `session.prompt` and `session.queue.*`, though it is harmlessly also applied to queue methods
that take no attachments. `permission.reply`'s `choice` is only checked to be a non-empty string
(`remoteTiers.ts:66`); the daemon validates it against the provider request
(`ipc-contract.md:117`), so that is acceptable.

## 6. Open questions the owner must answer before P1

1. **Relay identity without accounts.** `ARCHITECTURE.md:63-67` says the relay authenticates a
   hello with "a registered public key" and "has no accounts", while `REMOTE_MODE.md:26-27`
   promises "no Bitbots-held list of a person's computers". How is a `hostId` registered, and
   who prevents a stranger from squatting a `hostId`? Is the relay operated by Bitbots at all,
   or is self-hosting the only P1 path (`PROTOCOL.md:12` open question 1)?
2. **Relay metadata.** Even if the relay is content-blind, it holds stable `deviceId`/`hostId`
   and IPs and sees frame sizes (`PROTOCOL.md:180-185`). Is that acceptable, and for how long is
   it retained? (Goal 4 says nothing is held; the framing contradicts the spirit of that.)
3. **Browser key storage.** `ARCHITECTURE.md:88` allows "a wrapped key where [non-extractable
   WebCrypto] is unavailable". Is a copyable wrapped key acceptable, or must Remote refuse to
   pair in browsers without a non-extractable X25519 key? This decides the clone risk in §2.
4. **Quiet hours semantics.** Does "read but not send" (`REMOTE_MODE.md:78-79`) also block
   `session.cancel`, `session.archive` and `session.queue.send_now`, which change host state
   without sending a prompt?
5. **Content on the device.** Is a remote device allowed to read full message bodies, tool
   output and file diffs verbatim, or must the host scrub pasted credentials? The threat model
   (`THREAT_MODEL.md:18`) acknowledges conversations may contain pasted secrets but nothing
   redacts them.
6. **`customEnv` promotion.** Should remote keep `customEnv` key names (as execution snapshots
   do, `ipc-contract.md:214`) or hide them entirely? The doc and code disagree today (§1).
7. **`runtime.models refresh` and quota polling.** May a viewer device trigger a provider poll
   at all (`ipc-contract.md:69`), or must every provider-touching call be operator-only?
8. **Staging lifetime and quota.** `PROTOCOL.md:479-480` asks how long a `stagedId` lives. Also
   needed: a per-device staged-bytes cap and single-use/binding rules (§2).
9. **Multi-host push attribution.** `PROTOCOL.md:473-474` — which host may send a `wake`, and how
   does the client attribute it before it has fetched state?
10. **Direct LAN address in P1.** `PHASES.md:9` schedules the direct listener in P1;
    `THREAT_MODEL.md:59,69` treats it as advanced and off by default, and the AGENTS amendment
    (`AGENTS_AMENDMENT_DRAFT.md:39-40`) needs owner sign-off for the non-loopback bind. Confirm
    whether P1 ships it or defers it.

---

## Summary (most serious findings)

1. The tier table is not enforced anywhere: `remoteTiers.ts` claims `daemon_rpc` consults it, but `lib.rs:449-463` is a pure pass-through, and the "mirror in the daemon" the amendment promises does not exist.
2. `redactSnapshotForRemote` leaves real secrets and host paths in the snapshot — message and tool output, `executablePath`, `defaultProject`, `customArgs`, message attachment paths — and event payloads are not redacted at all.
3. The relay's role is contradictory: one document has it verifying signed hellos, another has it seeing nothing but routing ids, and relay metadata correlation is unaddressed.
4. Browser authentication is unspecified: `wss://` cannot carry the Noise setup without a ticket or subprotocol that lands in URLs/logs, and no CSP or Origin check exists in the read files.
5. Pairing and revocation have race and reachability holes: a one-time code can be raced by two devices, and a revoked device on a direct or relay-unreachable path may keep its session.
