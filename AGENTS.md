# Bitbots collaboration instructions

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
