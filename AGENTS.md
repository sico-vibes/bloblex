# Bitbots collaboration instructions

# Amendment (19 October 2026): FIX40 pipeline

Owner directive for the FIX40 wave (the owner's request to replace the primary look with Frost, add Pop and Dot, and give each bot an art style and each look an orb), until the owner says otherwise. It replaces the FIX39 four-model arrangement for this wave.

- **Mapping:** Claude Haiku 5.5 maps the codebase for the briefs.
- **Briefs and review:** the Director (Claude) writes one brief per lane, reviews every diff, checks every screen in the browser preview, sends work back until it is right, merges, runs the gates and commits.
- **Implementation:** Codex `gpt-6-luna` (high) and OpenCode `opencode-go/deepseek-v4.1-flash` (high) implement from the briefs, one git worktree per lane, each with its own Cargo target. Several lanes may run at once with files kept apart where possible.
- **Lanes never run `git commit`.** The Director commits after gates. The Director writes no code itself; it resolves merge conflicts as part of merging.
- **Documentation:** Claude Haiku 5.5 writes the documentation (report, design rules, handoff, status) from the briefs, the diffs and the gate results.
- **Working notes:**
  - Build the desktop crate from a short path without an apostrophe (for example a worktree under `D:\fxN`). The Windows resource compiler fails on the main checkout path `D:\Basem's\...`.
  - The Codex sandbox has no network access and cannot write Vite's temp files through a `node_modules` junction. The Director installs dependencies and runs the full gates itself.

# Amendment (18 October 2026, later): four-model pipeline for FIX39

Owner directive for the FIX39 wave (the beta.33 review and the friend's test feedback), until the owner says otherwise. It replaces the FIX37 arrangement below where they differ.

- **Research:** OpenCode `opencode-go/deepseek-v4.1-flash` (high) investigates every item and writes research reports with evidence (file:line), causes and proposed designs. It may ask Claude Haiku 5.5 for quick facts (`claude -p --model claude-haiku-5-5 --effort high "<question>"`). It changes no code.
- **Implementation:** GPT Sol 6.1 at high effort through the Codex CLI (`codex exec -m gpt-6.1-sol -c model_reasoning_effort=high`), one worktree and Cargo target per package, from the audited research. It never runs `git commit`.
- **Audit:** Claude Sonnet 5.5 (high) audits the research before implementation and every implementation diff before merge, and reports to the Director. Findings go back to Sol until the audit passes.
- **Documentation:** Claude Haiku 5.5 (high) writes the docs (handoff, status, index, release notes, protocol updates) from the reports.
- **Director (Claude):** only runs the lanes, checks they are working, relays the owner's decisions, merges, runs the gates, commits and releases. It writes no code, research, audits or docs itself.

# Amendment (18 October 2026): DeepSeek lanes write all code for FIX37

Owner directive, for the FIX37 wave (the beta.31 review) and until the owner says otherwise.

- **All code goes to OpenCode `opencode-go/deepseek-v4.1-flash` (high), UI included.** This amends the 16 October split, where the Director wrote UI. The Director writes the briefs, reviews every diff, verifies the result (gates on `main`, browser preview) and sends work back until it is right; it does not write production code or tests itself.
- **Several lanes may run at once**, one worktree and one Cargo target each, with briefs that keep their files apart where possible. Lanes never run `git commit`; the Director merges, gates, commits and releases.
- Everything else in the amendments below stands.

# Amendment (17 October 2026, later): Native Remote, without Tailscale

Owner directive (request of 17 October 2026, decisions made in planning). It amends the Remote amendment below where they differ; everything not changed here stands.

- **Two methods, one at a time.** Remote has a Tailscale method (unchanged) and a **Native** method. Only one is active (`remote.method`); switching needs Remote off.
- **Native may bind beyond loopback, only for the gateway.** While Native is on, the gateway's own listener binds the host's interfaces on `remote.nativePort` (default 48621). It is never on when Native is off. The daemon API listener stays on `127.0.0.1` with the capability, and the Tailscale listener stays loopback-only.
- **TLS is mandatory.** Native serves HTTPS only, with a certificate Bitbots generates and stores with user-only access (owner decision: built-in certificate; each device sees a one-time warning; the app shows the fingerprint to check). Plain HTTP is refused.
- **Sign-in is a password plus the owner's approval.** A username and password (Argon2id hash only, never logged or returned) and, for every new device, approval on the desktop with the tier, as for Tailscale pairing. Approvals from remote stay off by default.
- **Abuse limits are required.** Per-IP rate limits on every unauthenticated route, lockout after repeated failed sign-ins, a global pause on a burst, and a content-free activity line for each.
- **No third-party service.** Native contacts no IP-echo, relay or DNS service. UPnP port mapping happens only with the owner's consent and removes only its own mapping. A firewall rule is added only through an elevated prompt the owner accepts.
- **Release gate.** The threat-model review owed for Remote now covers Native too (`docs/remote/THREAT_MODEL.md`, public-internet section) before a non-beta release.

# Amendment (17 October 2026): Remote mode over Tailscale

Owner directive, accepted as drafted in [docs/remote/AGENTS_AMENDMENT_DRAFT.md](docs/remote/AGENTS_AMENDMENT_DRAFT.md) (16 October wording). Remote mode lets paired devices on the owner's tailnet reach a host's bots through a gateway inside the daemon. This amends the loopback and capability rules in `docs/ipc-contract.md` for this one path only.

- **The daemon API is unchanged.** Its HTTP and WebSocket listeners stay on `127.0.0.1`, protected by the capability, and the Tauri shell path is unchanged.
- **The gateway is the only remote entry.** It is off by default and compiled into the daemon: a second listener on `127.0.0.1:<remote.port>` (default 48620) and nothing else. It never reads, accepts or exposes the capability; it calls `dispatch()` in-process.
- **Tailscale is the only way in.** The gateway is published with `tailscale serve --bg --https=443` (or 8443). Never `tailscale funnel`, never `tailscale serve reset`, never a non-loopback bind. Turning Remote off removes only Bitbots' own serve handler. No Bitbots relay and no LAN listener.
- **Authorisation is per device.** Pairing needs a one-time code (5 minutes, 5 attempts) and the owner's approval on the desktop, where the owner picks the tier (`viewer`, `chat` or `operator`; Chat is preselected). The device gets a 256-bit token in an `HttpOnly; Secure; SameSite=Strict` cookie; only its SHA-256 is stored. Every request checks the cookie, revocation and `Origin`, and the Tailscale login when that header is present; a device without the header may still pair, with the cookie as its only proof. Approvals from remote are off by default.
- **One policy, two languages.** The tier table, event policy and settings allowlist live in `apps/desktop/src/remote/tiers.json`, read by the Rust gateway and the TypeScript client, and a parity test fails the build when a daemon method or event has no row.
- **Never remote:** `settings.set`, every `remote.*` method, agent create/update/delete, runtime profile changes, runtime refresh, file revert, automation writes, memory writes, daemon shutdown, attachments (in v1) and every native Tauri command.
- **Content stays private.** No message text appears in logs, push payloads or the activity list. Tailscale status JSON is never logged. No provider credentials, tokens or environment values leave the host; results and events are redacted and allowlisted before they leave.
- **Release gate, waived once by the owner.** The draft's gate (the checklists in `docs/remote/THREAT_MODEL.md` sections 8 and 11 and an independent review of the cookie, Origin and Tailscale handling) was **not** completed before `v0.1.0-beta.30`; the owner chose on 17 October 2026 to ship Remote in that beta anyway. Remote is unverified against a live tailnet and a real phone at that release. The checklist and review remain owed before a non-beta release.

# Amendment (16 October 2026): two lanes only

Owner directive; this amends the 12 October lanes below where they differ.

- **UI/UX** (components, styles, copy, motion, island/companion, settings screens, onboarding, UI tests) is done by the Director (Claude), following `DESIGN.md` and `PRODUCT.md`.
- **Everything backend that does not touch UI** (Rust daemon, adapters, storage, speech, `src-tauri` native code, schema, non-visual TypeScript, backend tests) is done by OpenCode `opencode-go/deepseek-v4.1-flash` at high effort, one git worktree per package, from a written spec. The lane never runs `git commit`.
- **No third lane.** The `impl-b` (Cursor) second opinion is not used: the Director's review of every backend diff plus the full gates, run on the merged result in the main checkout, stand in for it. Codex `impl` is not used unless the owner assigns it again.

# Amendment (12 October 2026): lanes, dictation exception, budgets

Owner directive; this amends the section below where they differ. The roadmap is [docs/IMPROVEMENT_PLAN.md](docs/IMPROVEMENT_PLAN.md).

- **Lanes.** Heavy non-UI coding (Rust daemon, adapters, storage, speech crate, `src-tauri` native code, schema, non-visual TypeScript, backend tests) goes to OpenCode `opencode-go/deepseek-v4.1-flash` at high effort. Anything that touches UI or UX (components, styles, copy, motion, island/companion, settings screens) is done by the Director (Claude), who follows `DESIGN.md` and `PRODUCT.md`. The Director therefore may write UI/UX production code; it still reviews every OpenCode diff and commits after gates. The OpenCode lane never runs `git commit` and does not grade its own work: backend diffs also get a read-only second opinion from a different lane (`impl-b` via `scripts/run-cursor-delegate.ps1`). Codex `impl` remains available when the owner assigns it.
- **Dictation exception (approved by the owner, 12 October 2026).** Cloud dictation may read the Codex CLI's `auth.json` read-only to call ChatGPT transcription. It is opt-in with explicit consent, the on-device engine stays the default and automatic fallback, the token, audio and transcripts are never persisted or logged, and the exception covers dictation only. All other "no copied provider authentication" rules stand.
- **Budgets are retired.** `budget.*` returns `unsupported` (`crates/bloblex-daemon/src/main.rs`); do not claim budget enforcement. Unattended work (automations) must bring its own caps: runtime limit, concurrency limit, global pause, and a permission mode that is never bypass.

# Amendment (14 October 2026): request-shape matching for cloud dictation

Owner directive. Amends the 12 October dictation exception and the "No bypass of bot protection" rule in [docs/FIX1_DICTATION_SPEC.md](docs/FIX1_DICTATION_SPEC.md).

- **Endpoint approved, by the owner's account of OpenAI's reply.** The owner states that OpenAI's answer to them names `chatgpt.com/backend-api/transcribe` and permits its use. This is recorded as **owner-attested**: no copy of the correspondence is in the repository, and no blob has independently verified it. If the endpoint or the terms change, this exception lapses.
- **Request-shape matching is allowed, for cloud dictation only.** The earlier prohibition on shaping requests past OpenAI's bot check is lifted for this one call path. Reason: the check is not an identity or permission gate — live probes returned HTTP 200 while identifying as Bloblex — so matching the accepted request shape is no longer "impersonation to defeat a check" in this case.
- **What stays forbidden.** Presenting another client's identity is still out. `originator` stays `bloblex` and the User-Agent stays ours; we do not send `originator: bb`, `bb-host-daemon`, a Codex or browser User-Agent, or any other app's name. Cookie replay, challenge-solving and retry loops remain out.
- **What does not change.** Cloud dictation stays opt-in with explicit consent; the on-device engine stays the default and the automatic fallback; the token, audio and transcripts are never persisted or logged; the exception covers dictation only.
- **Evidence.** [docs/evidence/cloud-dictation-client-shape-2026-10-14.md](docs/evidence/cloud-dictation-client-shape-2026-10-14.md) records the falsified claims and the client-shape finding. The accepted client shape is the TLS stack: the endpoint challenges SChannel and accepts rustls, with ALPN tested and ruled out — [docs/evidence/cloud-dictation-tls-backend-2026-10-14.md](docs/evidence/cloud-dictation-tls-backend-2026-10-14.md).
- **Commit and release authority, delegated once (14 October 2026).** The owner, acting as Director, directed the OpenCode lane to commit and publish the beta.22 dictation fix itself. This is a one-release exception to "the OpenCode lane never runs `git commit`" and to "implementers never run `git commit`"; the lane recorded it here rather than acting on a verbal instruction alone. It does not change the general rule, and the read-only second opinion on backend diffs still applies to later work.

# Amendment (14 October 2026): clean up build files after every release

Owner directive, to stop build leftovers filling the disk. A release is not finished until this is done.

- **When.** Once a release is published and its GitHub asset digests have been checked against the local files, and the release entry is in [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).
- **What is removed.** The short-path build worktree (`C:\b<N>`, or `D:\b<N>` where that drive exists) including its `target\desktop-release`, any lane worktree (`C:\fx<N>` and similar) whose result has been reviewed and merged or discarded, the temporary branches those lanes used, and throwaway probes or patches kept outside the repository. The installer needs no local copy: the published asset and the digest in the checklist are the record.
- **What is kept.** The main checkout's `node_modules` and its `target` (they make every later gate fast), and any worktree that still holds unreviewed or unmerged work. A lane worktree is never deleted before its diff has been reviewed.
- **How, in this order.**
  1. Remove the `node_modules` junction first, as a link only: `[System.IO.Directory]::Delete('<worktree>\node_modules')`. Never recurse through it; it points at the main checkout's real `node_modules`.
  2. `git worktree remove --force <worktree>`, then delete the directory if anything is left, then `git worktree prune`.
  3. `git branch -D` the temporary lane branches.
  4. Confirm with `git worktree list` and that the paths are gone.
- **Report.** The release summary says which paths were removed and how much space came back.

# Delegation pipeline (from 1 October 2026, evening)

This section supersedes the older **Resume** and **User's current working arrangement** sections below; their text remains as history. The Director is the orchestrating Claude session acting as CTO. The Director directs and reviews every diff and never writes production code. Implementer lane `impl` is Codex `gpt-6-luna` at high effort. Implementer lane `impl-b` is Cursor `grok-4.7-high`, invoked through the `cursor-delegate` skill for bake-offs. QA lane `qa` is OpenCode `opencode-go/deepseek-v4.1-flash` and reports to the Director only. Cursor runs MUST go through `scripts/run-cursor-delegate.ps1` from PowerShell; it isolates Cursor from third-party hooks in `~/.claude/settings.json` and strips the Store PowerShell from PATH. Never edit the user's hooks or settings. other tools and other third-party harnesses are not part of this pipeline. Backend work is RESUMED according to [docs/E2E_PLAN_V2.md](docs/E2E_PLAN_V2.md). Implementers never run `git commit`; the Director commits after review and gates. The invariants in **Scope and invariants** below remain in force.

## Resume — 1 October 2026, evening (superseded by Delegation pipeline above)

The user explicitly resumed work after the 20:37 stop. Finish the UI first: the main shell should follow a chat-style layout while keeping Bloblex's plan (agents, sessions, usage, permissions, companion). Companion blobs must match the island's animation and face language on a circle, and the same face is used in the chat. Backend expansion stays paused. The older "coordinator must not touch code" arrangement applied to the Luna lanes; this resume is direct UI work unless the user says otherwise.

Status at 22:30: the character engine, companion island and chat-style main shell are implemented and pass typecheck/tests/build; native-window verification and per-blob model/effort/speed (needs daemon support) remain. See the top section of `SESSION_HANDOFF.md`.

Read `SESSION_HANDOFF.md` and `docs/implementation-status.md` before resuming work. They describe an unfinished implementation; passing old checks is not current acceptance.

## User's current working arrangement (superseded by Delegation pipeline above)

- The coordinator/root is responsible for documentation and orchestration. The user explicitly instructed it to stop touching code, including small production fixes.
- Two Luna 6 agents at High effort implement the application; a third Luna 6 agent at High effort performs independent QA and reports directly to the implementers for corrections.
- Reuse existing live agents when available. Agent names/handles do not necessarily survive a new session. Do not create additional workers beyond the three authorized lanes.
- The current priority is UI behavior and polish. Backend work is paused at its recorded checkpoint; the full plan remains required after the UI checkpoint.
- Computer Use and browser UI interaction testing are deferred until the end. Source review, deterministic tests and builds may continue.
- Preserve the running inspection app and its data. Do not restart it, terminate processes or overwrite locked sidecars as a side effect of a check. Coordinate an explicit runnable checkpoint first.

## Ownership

- Desktop implementer: App/styles, shell FSM/layout, native Tauri windows and commands.
- Character implementer: BlobCanvas, motion helpers, original opt-in sound module and character/mounted lifecycle tests; backend implementation remains its later lane.
- At the 19:07 checkpoint, that implementer also owns a separate native file-inspection test module, coordinated with desktop. Desktop alone registers the module or edits native production source.
- QA (amended): reports to the Director; the Director routes production corrections to the `impl` lane.
- The 19:55 UI continuation permits DOM-mounted React unit tests while Computer Use/browser/native interaction remains deferred. QA coordinated a one-time test-only `happy-dom` dependency/lockfile addition and then released those files; coordinate any subsequent dependency edit with both implementers.
- Coordinator: handoff, status/checklist and documentation index. Avoid concurrent edits to an implementer's source-provenance document.

## Scope and invariants

- Preserve all requirements of the supplied plan; do not redefine v1 around whichever subset already passes.
- Companion: source-informed rounded corners, not a stadium-shaped outer pill; bottom-center default, free drag and retained placement; full welcome wave and stateful home/chat/activity/file-drop behavior.
- No copied provider authentication, primary terminal scraping, raw provider JSON in React, fabricated success/usage, or unknown prices presented as zero.
- Daemon owns sessions, permission decisions and budgets. Main and companion share its normalized state.
- Keep prompts in stdin/protocol, not shell command text or large argv strings. Never record capability secrets or provider credentials in docs or logs.
- Review tests for what they actually prove. Distinguish independent evidence, implementer reports, source-only implementation and unverified behavior.
