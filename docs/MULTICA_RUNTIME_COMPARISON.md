# Multica vs Bloblex: per-CLI runtime layer comparison

**Scope.** Compared Multica's per-CLI runtime adapters (`server/pkg/agent/` in a read-only clone; licence is Apache-2.0 plus extra conditions with personal/internal use allowed) against Bloblex's adapters (`crates/bloblex-adapter-*`, `crates/bloblex-runtime`, `crates/bloblex-daemon/src/main.rs`) as they exist in the working tree on 2 October 2026. Bloblex's `bloblex-adapter-claude` and `bloblex-adapter-codex` are being modified by other lanes in this working tree; all Bloblex `file:line` citations below are to the current on-disk tree, not to `HEAD`. This document is research only — it changes no code.

**Method and limits.** Every claim cites a file and line read directly. Multica behaviours that exist only because Multica is a multi-user server (teams, auth, cloud runtimes, issues, Slack/Lark delivery, workspace MCP brokering) are marked **[multi-user-only]** and excluded from recommendations. No Multica behaviour was executed against a live CLI; all Multica evidence is source and test text. Bloblex "verified facts" are quoted from `docs/runtime-capabilities.md`, whose status is the Director's.

Paths: **M** = `server/pkg/agent/…` under the clone; **B** = Bloblex repo-relative.

---

## Area 1 — Backend interface, session and event model

### 1. What Multica does
- One `Backend` interface with `Execute(ctx, prompt, opts) (*Session, error)` (M `agent.go:18-23`). A `Session` exposes `Messages <-chan Message`, a one-shot `Result`, plus optional liveness hooks: `Supplement` (inject instruction mid-turn), `ToolActivity`, `InterruptBackgroundTools`, and `TerminalObserved` (M `agent.go:152-197`). `TerminalObserved` must be published *before* the result is sent, which makes the daemon's read of it race-free by happens-before (M `agent.go:183-191`).
- `Result` carries a normalized status vocabulary `completed|failed|aborted|timeout|cancelled`, output, error, duration, session id, `map[model]TokenUsage`, and resume-rejection flags (M `agent.go:252-306`).
- `TokenUsage` documents the invariant that input excludes cache reads/writes and output includes reasoning, and notes that four zero counters do **not** prove a complete report (M `agent.go:225-245`).
- `runContext` imposes a hard wall-clock deadline only when `timeout > 0`; zero means no deadline and liveness is entirely the daemon watchdog's job (M `agent.go:144-149`).

### 2. What Bloblex does today
- A trait `AgentAdapter` with `probe`, `new_session`, `resume_session`, `prompt`, `cancel`, `reply_permission`, `close_session`, plus `model_catalog`, `set_instruction_hash_context`, `preflight_exec_options` (B `crates/bloblex-agent-core/src/lib.rs:337-381`).
- Events are a single `AgentEvent` enum streamed over `mpsc` (B `crates/bloblex-agent-core/src/lib.rs:270-333`); usage is normalized into `UsageReport` with every bucket nullable and `usage_status` ∈ `reported|partial|unreported` (B `…/lib.rs:111-131`).
- ExecOptions already has `model`, `thinking`, `service_tier`, `instructions`, `extra_args`, `env`, `max_concurrency` (B `…/lib.rs:50-73`).

### 3. Gap or risk
Bloblex's interface is at least as rich as Multica's for a single-user desktop app, and stricter about usage nullability. The real gaps are in the implementations, not the interface. One concrete risk: Bloblex has no equivalent of `TerminalObserved`, so a daemon that wants to distinguish "provider finished" from "cleanup still running" cannot; this matters for Area 4.

### 4. Recommendation
**SKIP** the interface shape (no change needed); **ADAPT** the `TerminalObserved` ordering idea if Bloblex later adds liveness watchdogs.
### 5. Priority / effort
P2 / S.
### 6. Invariant
None violated.

---

## Area 2 — Process lifecycle and process-tree ownership (the top correctness risk)

### 1. What Multica does
- Every runtime process is started through `startOwnedProcessTree`; on Windows the child is created **suspended** and assigned to a **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` before it executes an instruction (M `proc_windows.go:100-132`, `:137-175`). This is deliberate: npm `.cmd` shims spawn the real CLI as a *grandchild*, and a plain `Start` leaves a window in which the grandchild escapes the job (M `proc_windows.go:85-94`).
- `signalProcessGroup` terminates the whole Job Object on Windows, falling back to `Process.Kill()` only if no tree is owned (M `proc_windows.go:257-267`). `waitProcessGroupGone` polls the job's active-process count so callers can *confirm* cleanup, and returns `false` when nothing was owned (M `proc_windows.go:273-295`).
- On every platform the default `cmd.Cancel` is a process-group SIGKILL, not `os/exec`'s leader-only kill (M `launch.go:133-140`). The comment records the field failure: on Windows a cancelled agent "kept working for 40 minutes" because the leader was a `cmd.exe` shim (M `launch.go:121-132`). `TestOnlyOwnedProcessTreesAreStarted` enforces that no backend reaches `cmd.Start` directly (`launch.go:80-83`).
- `releaseProcessGroup` is called only after the process is reaped, because closing the Windows job handle kills anything still inside it (M `proc_windows.go:211-223`).

### 2. What Bloblex does today
- Adapters spawn with `tokio::process::Command` and rely on `.kill_on_drop(true)` plus `child.kill().await` (B `crates/bloblex-adapter-claude/src/lib.rs:659-663`, `:1106`; codex `crates/bloblex-adapter-codex/src/lib.rs:59-72`, `:927`; acp `crates/bloblex-adapter-acp/src/lib.rs:44-53`, `:531`).
- A repo-wide search finds only `child.kill()` / `start_kill()` and no Job Object, `taskkill`, process-group, or `creation_flags` handling (`grep` over `crates/**/*.rs`: claude `:674,681,884,1039,1106,1137`; codex `:615,897`; acp `:531`).
- The runtime discovery layer (`bloblex-runtime`) spawns probe processes with `kill_on_drop(true)` and a 6 s timeout (B `crates/bloblex-runtime/src/lib.rs:145-162`).

### 3. Gap or risk
**Concrete failure (P0).** On Windows, `claude`, `codex`, and `opencode` are typically started through npm `.cmd`/`.ps1` shims; `bloblex-runtime` already parses those shims and sometimes resolves to a native `.exe` or `node.exe` (B `crates/bloblex-runtime/src/lib.rs:63-114`), but not always. When the resolved executable is a shim (or the agent itself spawns MCP servers / shell tools), `child.kill()` kills only the direct child. The MCP server, shell, or real CLI is a grandchild and keeps running: it can keep writing to the project, keep consuming the provider session, and keep a pipe open. Bloblex then reports the turn cancelled while the provider session is still live. This is exactly Multica GH #5918 (Unix) and #7522 (Windows), and Multica's own comment records a 64-minute orphan and a 40-minute continued run (M `launch.go:123-131`, `claude_cancel_unix_test.go:14-20`).

Second concrete failure: Bloblex discovery uses `cmd.output()` (wait-for-EOF) under a 6 s timeout (B `crates/bloblex-runtime/src/lib.rs:145-162`). A shim whose descendant inherits stdout can hold the read open until the timeout; the version silently becomes `None` (`:177-185`) or the runtime is skipped, and the descendant is never reaped.

### 4. Recommendation
**ADAPT (highest-value adoption in this document).** Port the ownership model, not the Go code:
- On Windows, create the child suspended, assign it to a Job Object with `KILL_ON_JOB_CLOSE`, then resume; or use a battle-tested Rust crate (`windows` crate `CreateJobObjectW`/`AssignProcessToJobObject`). Terminate the job on cancel/timeout/close, and confirm emptiness before reporting cleanup.
- On Unix, put each child in its own process group and signal the group (SIGTERM → grace → SIGKILL).
- Route **all** child spawns (task launches and probes) through the owned-start helper so a new adapter cannot regress it.
- Keep Bloblex's existing native-shim resolution (`bloblex-runtime`) as the first line of defence, but do not rely on it alone.
### 5. Priority / effort
P0 / M–L (Windows job objects are the bulk; Unix is small).
### 6. Invariant
None violated; this protects the daemon's ownership of sessions and budgets by not leaking live provider work.

---

## Area 3 — stdin/stdout pipe deadlock and draining

### 1. What Multica does
- Claude's prompt write runs in its **own goroutine** so it cannot deadlock against the stdout reader; `TestClaudeExecuteDoesNotDeadlockOnStartupStdoutBurst` re-executes the test binary as a fake CLI that writes 256 KiB to stdout *before* reading stdin (M `claude.go:155-185`; `claude_deadlock_test.go:83-104,189-248`). The doc comment records the field symptom `write |1: The pipe has been ended.` at the per-task timeout (M `claude.go:160-162`).
- On scanner error the reader closes the stdout pipe **before** `Wait`, so a child blocked on a full pipe cannot deadlock (M `claude.go:329-335`). Multica also keeps stdin open after the first message because Claude emits `control_request` mid-run and expects a matching `control_response` on the same stream (M `claude.go:163-168`).
- OpenCode does the same independent-writer pattern and closes stdin to signal EOF (M `opencode.go:269-280`).
- Scanner overflow on Codex has a dedicated two-phase `drainAndWait` with a graceful window, a forced group kill, and `WaitDelay` as the final backstop (M `codex.go:1340-1483`).

### 2. What Bloblex does today
- Each adapter spawns a reader task before any write (claude `crates/bloblex-adapter-claude/src/lib.rs:704-707`; codex `crates/bloblex-adapter-codex/src/lib.rs:96-97`; acp `crates/bloblex-adapter-acp/src/lib.rs:96-97`), so the startup-burst deadlock is structurally avoided in the common case.
- Writes happen under a `Mutex<ChildStdin>` in the caller (`bloblex-adapter-claude/src/lib.rs:1062-1077`, `bloblex-adapter-codex/src/lib.rs:204-223`, `bloblex-adapter-acp/src/lib.rs:159-168`). Bloblex does **not** spawn the write in a separate task; it holds the stdin lock across the `await`.
- The Claude reader task treats the stream end as the end of the process, then removes the instruction file (B `…claude/src/lib.rs:827-840`).

### 3. Gap or risk
Bloblex's reader-first ordering removes the classic deadlock, but the write is still awaited on the same task as session setup. For very large prompts (Bloblex accepts up to 1,000,000 bytes, `bloblex-daemon/src/main.rs:1613-1619`), a child that stops reading stdin (e.g. still emitting a large startup banner and waiting) blocks the `prompt()` future until its own pipe buffer drains. The reader task is draining stdout, so it should unblock, but the write is not independently cancellable: if the reader hits a malformed line and returns, the write can stay parked. Multica's explicit "writer goroutine + buffered result channel" pattern is the safer shape. Bloblex also has no scanner-overflow handling (a single stdout line larger than the reader's buffer): `BufReader::lines()` will return an error and the task ends, the child may still be blocked writing, and `kill_on_drop` only fires when the `Conn` drops — which it does not until the session is removed.

### 4. Recommendation
**ADOPT the writer-goroutine/task pattern; ADAPT the Codex `drainAndWait` shape** for an explicit bounded cleanup (graceful stdin-close → grace → forced tree kill → wait backstop). Close the stdout read end only after the tree has been signalled, as Multica does (M `claude.go:222-244`, `opencode.go:292-320`).
### 5. Priority / effort
P1 / M.
### 6. Invariant
None violated.

---

## Area 4 — Cancellation latency, graceful shutdown, and cleanup confirmation

### 1. What Multica does
- Claude: on cancel, EOF stdin, group SIGTERM, wait a 5 s grace keyed on the **whole process group** (not the leader's exit), then group SIGKILL; only then close stdout (`claude.go:214-244`; `claudeTerminateGrace` at `:29-34`). `TestClaudeCancellationEscalatesWhenDescendantIgnoresTERM` specifically covers a SIGTERM-respecting leader plus a SIGTERM-ignoring detached grandchild (`claude_cancel_unix_test.go:41-95`).
- Codex: `interruptCodexTurn` first sends the provider's native `turn/interrupt`, waits a bounded `TurnInterruptTimeout` (default **2 s**) for `turn/completed`, and only then force-stops the tree; the bool return tells the caller whether cleanup is needed (M `codex.go:2625-2672`). The default is justified by a real probe: P99/max completion 15 ms over 20 interrupted generations (`codex.go:63-75`; `codex_interrupt_latency_integration_test.go:78-145`).
- OpenCode 2.x became a thin client over a resident service, so signalling its process group no longer stops the work; Multica sends a server-side session interrupt before the signals (M `opencode_v2.go:235-289`).

### 2. What Bloblex does today
- Claude cancel sets an `AtomicBool` and calls `child.kill()` (B `crates/bloblex-adapter-claude/src/lib.rs:1097-1108`). No graceful phase, no group.
- Codex cancel sends `turn/interrupt` via the generic `call()` whose timeout is the 30 s `RPC_TIMEOUT` (B `crates/bloblex-adapter-codex/src/lib.rs:20`, `:866-888`, `:204-223`). If the interrupt RPC fails, `cancel()` returns an error and does not fall back to killing the process.
- ACP cancel replies to pending permission requests and notifies `session/cancel` (B `crates/bloblex-adapter-acp/src/lib.rs:449-478`). It does not kill the process; the `session/prompt` request is allowed 30 minutes (`:169-172`), so a provider that ignores cancel can hold the turn (and the daemon's `active_turns` slot, `bloblex-daemon/src/main.rs:1688-1702`) for up to 30 minutes.
- Daemon `session.cancel` marks the session `cancelling` and returns immediately; the slot is only released on a later `TurnCancelled`/`TurnCompleted`/`Error` event (B `bloblex-daemon/src/main.rs:527-554`, `:2014-2052`).

### 3. Gap or risk
**Concrete failure (P0/P1).** A Codex or OpenCode turn that hangs on cancel leaves the session's `active_turns` entry occupied and the UI in `cancelling`; because Bloblex has no process-tree kill (Area 2), the provider work can continue. For Codex the interrupt is bounded at 30 s but then gives up rather than escalating. Multica's model — short bounded provider interrupt, then guaranteed tree teardown — is the correct shape and directly addresses this.
### 4. Recommendation
**ADOPT** a bounded `turn/interrupt` (default ~2 s, configurable) followed by forced process-tree termination; **ADAPT** for ACP: after `session/cancel` plus a bounded wait, kill the process tree so a wedged agent cannot hold a slot for 30 minutes.
### 5. Priority / effort
P1 / M (depends on Area 2 for the tree kill).
### 6. Invariant
Preserves the daemon's ownership of sessions and turn slots.

---

## Area 5 — Timeouts, inactivity watchdogs, and progress diagnostics

### 1. What Multica does
- Layered budgets: `HandshakeTimeout` (30 s), `ThreadHandshakeTimeout` (60 s, because `thread/start`/`resume` refresh catalogs and MCP), `TurnInterruptTimeout` (2 s), `SemanticInactivityTimeout` (10 min), `FirstTurnNoProgressTimeout` (60 s, answering "did the agent ever start producing?"), plus an idle watchdog and a tool watchdog (M `agent.go:42-75`, `codex.go:47-100`, `:2229-2245`).
- The first-turn no-progress ceiling was raised from 30 s to 60 s after field evidence of healthy first events at ~30–39 s (M `codex.go:50-61`).
- Structured timeout diagnostics distinguish handshake timeout, first-turn no-progress, and semantic inactivity, and can attach a scrubbed stderr tail (M `codex.go:179-189`, `:2247-2300`).

### 2. What Bloblex does today
- Fixed per-call timeouts: catalog 8 s (Claude, `bloblex-adapter-claude/src/lib.rs:880`), probe 6 s (`:908`), Codex RPC 30 s and catalog 12 s (`bloblex-adapter-codex/src/lib.rs:20-21`), ACP prompt 30 min / other 20 s (`bloblex-adapter-acp/src/lib.rs:169-173`).
- The daemon holds a global cap of 4 active turns and one per session (B `bloblex-daemon/src/main.rs:1699-1705`, `:51`). There is no inactivity watchdog and no per-turn wall clock beyond the ACP request future itself; a Claude or Codex turn with no terminal event can sit indefinitely.

### 3. Gap or risk
A provider that connects but never emits a terminal result holds a turn slot indefinitely (Claude/codex). Multica hit this and built the first-turn no-progress watchdog after measuring healthy 30–39 s gaps. Bloblex should not copy Multica's exact numbers, but the missing watchdog means a wedged turn is invisible until the user cancels.
### 4. Recommendation
**ADAPT** a separate semantic-inactivity watchdog from a startup/no-progress watchdog; do not copy the minute values. Record the chosen values in `docs/runtime-capabilities.md` as behaviour, not provider facts.
### 5. Priority / effort
P1 / M.
### 6. Invariant
Every watchdog value must be a Bloblex product choice, not presented as a CLI fact; diagnostics must never include instruction text (Area 15).

---

## Area 6 — Codex thread-id race, turn scoping, and notification filtering

### 1. What Multica does
- `threadID` is guarded by an `RWMutex` because the stdout goroutine reads it while the task goroutine publishes the `thread/start` result (M `codex.go:2531-2545`). `TestCodexThreadIDPublishedBeforeNotificationFilter` reproduces the race: the fake app-server emits a notification immediately after the `thread/start` response (M `codex_thread_id_race_test.go:9-33`).
- `isNotificationFromOtherThread` snapshots the current id once and filters other threads (M `codex.go:3565-3574`); it tolerates absent/null/non-string ids (`codex_thread_id_race_test.go:38-58`).
- A `codexTurnNotificationGate` rejects resume-time history replay before `turn/started` and scopes `item/*`, `turn/completed`, and `thread/status/changed` by turn id (M `codex.go:2448-2512`).
- Codex usage is scoped to the current turn id, and a `usageTurnID` retains attribution after the steering window closes (M `codex.go:2556-2567`).

### 2. What Bloblex does today
- Codex guards `turn.id` and `turn_id` with `Mutex`es (B `crates/bloblex-adapter-codex/src/lib.rs:28`, `:31`, `:817-823`) and scopes `thread/tokenUsage/updated` and `turn/completed` to the expected turn id (`:145-150`). The thread id is returned from `thread/start`/`resume` and stored in the handle, not in shared mutable state (`:708-712`, `:742-745`), so the specific id race is less likely.
- However, `map_notification` forwards `item/agentMessage/delta`, `item/started`, and `item/completed` with **no thread-id or turn-id filter** (B `…codex/src/lib.rs:288-334`, called at `:190-194`). On resume, Codex can replay prior history; a replayed assistant message will be appended to the new turn's transcript.

### 3. Gap or risk
**Concrete failure.** A resumed Codex thread replays an old `item/completed` agent message; Bloblex emits it as `AssistantMessage` for the new turn and persists it as the turn's assistant text (`bloblex-daemon/src/main.rs:1864-1873`). The user sees a stale answer. Multica's gate exists precisely because this was observed (M `codex.go:2448-2458`).
### 4. Recommendation
**ADOPT** thread-id and turn-id filtering for all item notifications, plus a resume-replay gate armed before `turn/start` and opened at `turn/started`.
### 5. Priority / effort
P1 / S–M.
### 6. Invariant
No raw provider JSON to React: filtering must happen in the adapter; the daemon still receives normalized events only.

---

## Area 7 — Compaction and context exhaustion

### 1. What Multica does
- Claude: reads the structured `terminal_reason` and treats `prompt_too_long` as a failure even when `is_error` is false, quoting the enum token so it classifies as context overflow and the saturated session is retired (M `claude.go:702-732`, `stream_json_result.go:101-127`). The ordering is deliberate: structured reason beats `is_error` so reworded/empty prose cannot degrade the classification (M `stream_json_result.go:101-120`).
- Codex: `CodexRetiredCompactionError` recognises the retired `/responses/compact` route by path (not status) and the daemon appends a constant remedy hint without retiring the session (M `codex.go:223-283`; daemon `internal/daemon/daemon.go:10436-10496`). `codex_compaction_test.go` pins false positives for the v2 route.
- `CodexResumeOverflowError` distinguishes an oversized `thread/resume` response (bufio `token too long`) from an ordinary rejection so the session pointer can be retired (M `codex.go:191-221`).

### 2. What Bloblex does today
- Claude's error branch emits an `Error` with the raw `result` text and an `unreported` usage report (B `crates/bloblex-adapter-claude/src/lib.rs:449-480`), but does **not** read `terminal_reason`. `docs/runtime-capabilities.md` records that on a real context-exhausted turn `is_error:true`, so Bloblex will at least fail the turn rather than claim success. There is no session-retirement, no classification, and no handling of the case where `is_error` is false.
- Codex: no compaction or context-overflow detection anywhere in the adapter or daemon (`grep` for `compact`, `context_overflow`, `terminal_reason` finds nothing in `crates/`).
- Codex `thread/resume` errors are mapped generically to `AdapterError::Protocol(v["error"].to_string())` (B `crates/bloblex-adapter-codex/src/lib.rs:104-105`); an oversized resume is not distinguished from a transient rejection.

### 3. Gap or risk
**Concrete failure.** A saturated Claude session returns `is_error:true, terminal_reason:"prompt_too_long"`. Bloblex fails the turn, but keeps the session pointer and never tells the user that the conversation needs to be retired; every later prompt retries the saturated session (the "stall" Multica's #6402 describes). A successful-looking `is_error:false` frame with `prompt_too_long` would be reported as a completed turn. Codex compaction failures similarly surface as opaque errors.
### 4. Recommendation
**ADOPT** for Claude: parse `terminal_reason`, treat `prompt_too_long` as a distinct context-exhausted failure, and expose a normalized reason so the daemon can retire the session. **ADAPT** for Codex: detect the retired-compaction path and the resume-overflow signature; do not retire on the compaction case (it is recoverable). Do not copy Multica's user-facing remedy text verbatim without checking it against Bloblex's own controls.
### 5. Priority / effort
P1 / S–M.
### 6. Invariant
The failure reason must be normalized (not raw provider JSON) before reaching React; do not fabricate success. Unknown usage stays unreported, never zero.

---

## Area 8 — Usage accounting and nullability

### 1. What Multica does
- Claude: sums per-assistant-message input/cache tokens keyed by message id (to handle several blocks with the same id and usage), while treating assistant `output_tokens` as a placeholder and preferring the terminal `modelUsage` map; a resume baseline is read from the session JSONL `cost-state` records and subtracted only when the baseline is fully contained (M `claude.go:462-528`, `:734-823`). This baseline subtraction is what makes a resumed Claude turn's per-turn usage correct.
- Codex: usage is scoped to the current turn id; `TokenUsage.last` (not cumulative `total`) is used (M `codex.go:2556-2567`; Bloblex already does this at `crates/bloblex-adapter-codex/src/lib.rs:145-149`).
- OpenCode ACP: an accumulator reconciles cumulative `usage_update` snapshots with the terminal prompt usage using per-bucket maxima, keeps field presence separate from values so a reported zero is distinct from an omission, and re-buckets `input` only when `totalTokens == input + output` proves cached reads are included (M `acp_usage.go:20-30`, `:44-110`, `:250-259`). Provider cost is a cumulative turn total consolidated by max (M `acp_usage.go:79-84`).
- Token counts are mutually exclusive and zero does not prove completeness (M `agent.go:225-245`).

### 2. What Bloblex does today
- Claude success path reads `usage.input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens`, model from a `modelUsage` key, and cost via `exact_usd_minor(total_cost_usd)` (B `crates/bloblex-adapter-claude/src/lib.rs:481-516`). Error results produce an explicit `unreported` report (`:449-480`). Bloblex does not implement resume baseline subtraction; `PHASE_2B_SPEC.md:183` describes it as required.
- Codex subtracts cache-read/write from input only when all three exist and the subtraction is valid, with an `evidence_note` otherwise (B `crates/bloblex-adapter-codex/src/lib.rs:415-468`).
- ACP advertises `usage: false` (B `crates/bloblex-adapter-acp/src/lib.rs:336`, `:377`, `:421`) and `emit_update` ignores `usage_update` (`:197-231`). This is behind `docs/runtime-capabilities.md:232-233`, which *confirmed* real token buckets and cumulative cost on the live profile.
- The daemon persists normalized `UsageReport` and never writes raw provider JSON for new rows (`bloblex-daemon/src/main.rs:2004-2013`).

### 3. Gap or risk
**Concrete failure (P1, budget correctness).** OpenCode ACP currently records **no** usage, so Bloblex's budget accounting treats every OpenCode turn as unknown; the spec's cumulative-cost delta (`PHASE_2B_SPEC.md:185`) is unimplemented. If instead someone naively sums `usage_update.cost.amount` snapshots, cost is double-counted because it is cumulative per session (confirmed live; `runtime-capabilities.md:233`). Multica's max-consolidation and field-presence tracking is the proven way to avoid both errors.
### 4. Recommendation
**ADOPT** the ACP usage accumulator design (field presence, per-bucket max, input re-bucketing only with `totalTokens` proof) for `bloblex-adapter-acp`. **ADAPT** Claude resume baseline subtraction. Keep Bloblex's stricter nullability rules.
### 5. Priority / effort
P1 / M.
### 6. Invariant
Unknown values are never shown as zero; raw provider JSON is not persisted for new rows; cost currency handling stays exact (Bloblex already converts USD exactly, `crates/bloblex-adapter-claude/src/lib.rs:311-336`).

---

## Area 9 — Thinking / effort mapping

### 1. What Multica does
- Does **not** flatten provider vocabularies (Claude `low|medium|high|xhigh|max`; Codex `none|minimal|…|ultra`; OpenCode variants) onto a shared enum — values round-trip verbatim (M `thinking.go:20-25`).
- Validation is catalog-driven and fail-closed only when the catalog is *verified*: an unverified/fallback catalog produces `errUnverifiedCatalog` and the saved value is passed to the CLI rather than silently dropped (M `thinking.go:693-765`). Codex (and omp) require an explicit model before an effort is accepted, because the effective model comes from local `config.toml` (M `thinking.go:767-788`).
- Claude per-model effort comes from the live `list_models` rows (`supportsEffort`, `supportedEffortLevels`), not a global superset; fallback scrapes `--help` (M `claude_models.go:426-456`, `thinking.go:91-119`).
- Codex effort is applied to `turn/start.effort`; service tier to top-level `serviceTier` (M `codex.go:2161-2185`). Bloblex already matches the field names (B `crates/bloblex-adapter-codex/src/lib.rs:808-814`).

### 2. What Bloblex does today
- `ModelInfo` carries per-model `supported_thinking` and `default_thinking` (B `crates/bloblex-agent-core/src/lib.rs:90-102`). Claude parses `supportedEffortLevels`/`defaultEffort` and treats them host-dependent (`crates/bloblex-adapter-claude/src/lib.rs:241-264`). Codex parses `supportedReasoningEfforts`/`defaultReasoningEffort` (`crates/bloblex-adapter-codex/src/lib.rs:481-507`).
- The daemon validates model/thinking/tier against a non-fallback catalog and fails closed off-catalog (`bloblex-daemon/src/main.rs:998-1039`).
- `PHASE_2B_SPEC.md` already codifies the provider facts (Claude five levels, Codex per-model including `ultra`, OpenCode variants, no tiers on OpenCode) and the gates.

### 3. Gap or risk
Bloblex's design is already close to Multica's. The remaining risks are edge cases: (a) Bloblex's catalog fallback returns a static list with **empty** `supported_thinking` (B `crates/bloblex-adapter-claude/src/lib.rs:272-287`), so a fallback catalog cannot validate any effort; (b) `validate_option_values_against_catalog` returns `Ok` when the catalog fetch fails (`bloblex-daemon/src/main.rs:987-990`), which can let an unvalidated effort reach the provider if preflight also passes; (c) Codex does not reject unlisted efforts server-side (`runtime-capabilities.md:223`), so Bloblex must validate locally — the spec says so, but the code must be checked.
### 4. Recommendation
**ADAPT** Multica's `Catalog.Verified` / `errUnverifiedCatalog` split: distinguish "catalog unknown → pass through to CLI" from "catalog known and value absent → reject". Keep Bloblex's per-model validation.
### 5. Priority / effort
P1 / S.
### 6. Invariant
Do not present a value as applied without provider evidence (`SettingOutcome`/`EvidenceKind` already encode this, B `crates/bloblex-agent-core/src/lib.rs:211-231`).

---

## Area 10 — Model catalogs and edge cases

### 1. What Multica does
- Claude discovery asks the CLI over stream-json `list_models`, with a 20 s timeout and a negative capability cache keyed by `(command, cliVersion)` so an old CLI is not re-probed every task (M `claude_models.go:82-133`, `:274-295`). Disabled rows are kept in a **separate** `UnavailableModel` list so no consumer can offer them (M `models.go:49-70`, `claude_models.go:345-408`). Rows are keyed by `resolvedModel` (the persisted `--model` value), with the context-window tag preserved (`claude_models.go:336-417`). A `default` row resolving to no other row is materialised so default-model effort validation still works (`claude_models.go:386-405`).
- Codex discovery uses `codex debug models` with `--bundled` fallback and a version gate (`thinking.go:305-395`); per-model efforts and tiers are projected from the CLI's own list (`thinking.go:400-495`).
- `Catalog.Verified()` is the single gate for whether a catalog may reject a value (M `models.go:139-149`).
- OpenCode ACP: `parseACPEffortOption` reads `configOptions` and matches id/category against `effort`/`thought_level`; `annotateACPThinkingForSessionModel` deliberately annotates **only** the session's current model because ACP option vocabularies can depend on the model (M `acp_effort.go:36-39`, `:109-190`).

### 2. What Bloblex does today
- Claude catalog via `control_request list_models` with an 8 s timeout; on any error returns a static `["sonnet","opus","fable","haiku"]` marked `fallback:true` (B `crates/bloblex-adapter-claude/src/lib.rs:846-899`, `:272-287`). It does not read `disabled`, `resolvedModel`, or a `default` row.
- Codex catalog paginates `model/list` with cursor/`nextCursor` and a repeated-cursor guard (B `crates/bloblex-adapter-codex/src/lib.rs:549-617`, `:621-643`).
- ACP implements **no** `model_catalog` (default trait returns `Unsupported`, B `crates/bloblex-agent-core/src/lib.rs:341-345`; no override in `crates/bloblex-adapter-acp/src/lib.rs`), so `runtime.models` for OpenCode is unsupported even though `runtime-capabilities.md` records 52 models from ACP `configOptions`.
- Cache key includes runtime id, executable path, version, launch args, and profile id (B `bloblex-daemon/src/main.rs:833-842`), with a 60 s TTL (`:851-858`).

### 3. Gap or risk
**Concrete failure.** A Claude account where a model is disabled (needs a newer CLI) is offered by Bloblex because `disabled` is ignored; the user picks it and every turn fails with the provider's 400. Multica materialised the `UnavailableModel` split precisely to stop this (`models.go:56-63`). Separately, `resolvedModel` being ignored means Bloblex may send a picker token (`default`) that does not equal the model the CLI resolves; `runtime-capabilities.md:210` confirms `modelUsage` carries the resolved id, so the persisted model can drift from what runs.
### 4. Recommendation
**ADOPT** `disabled`/unavailable handling and `resolvedModel` keying for Claude; **ADOPT** a negative/verified catalog concept; **ADOPT** ACP `configOptions` catalog discovery (already required by `PHASE_2B_SPEC.md:154`). Keep Bloblex's per-profile cache key (it is stricter than Multica's).
### 5. Priority / effort
P1 / M.
### 6. Invariant
Host-dependent catalogs must not be hard-coded as product facts (Bloblex already marks `host_dependent: true`, B `crates/bloblex-agent-core/src/lib.rs:101`).

---

## Area 11 — Resume-rejection detection and instruction lifecycle

### 1. What Multica does
- Stream-json backends match conservative phrases (`no conversation found`, account-binding 400 text) and treat "CLI answered with a different session than requested" as a rejected resume, reporting an empty session id so the daemon starts fresh (M `claude.go:1169-1239`). ACP backends use a regex that names a session-shaped noun next to an unusable verdict, deliberately excluding request-shaped and auth/infra complaints (M `acp_session.go:36-114`).
- Instructions: Multica writes the runtime brief to a per-task context file in the workdir (CLAUDE.md / AGENTS.md) and deliberately does not inline it (M `claude.go:1112-1115`, `opencode.go:129-134`). Claude resume pends `resumeRejected` so a fresh session may be used; `ResumeRejectedTransient` distinguishes a healthy session that cannot be resumed right now (M `agent.go:260-295`).

### 2. What Bloblex does today
- Claude builds a private instruction file and passes `--append-system-prompt-file`, with a SHA-256 baseline and `--system-prompt-snapshot off` only when the hash changed (B `crates/bloblex-adapter-claude/src/lib.rs:641-658`, `:288-310`, `:1015-1061`). `PHASE_2B_SPEC.md:65-67` documents the snapshot-off rule from live evidence. This is a richer, more privacy-preserving design than Multica's workdir file.
- There is **no** resume-rejection detection: a failed resume returns an error and the daemon marks the turn error (B `crates/bloblex-daemon/src/main.rs:1812-1823`); the stale provider session pointer is not cleared.

### 3. Gap or risk
A conversation pinned to a provider session that the CLI refuses ("no conversation found", account binding) will fail every subsequent prompt with the stored id. Multica added detection because this was observed in the field (M `acp_session.go:24-35`). Bloblex needs a user-initiated or automatic way to drop the pointer.
### 4. Recommendation
**ADAPT** resume-rejection detection: a conservative, positive-evidence predicate in each adapter that marks the provider session unusable, with the daemon starting a fresh session only on that evidence. Keep the existing instruction-file design.
### 5. Priority / effort
P2 / M.
### 6. Invariant
Never log instruction text or provider credentials while diagnosing resume failures; classify from normalized signals where possible.

---

## Area 12 — OpenCode: ACP surface vs `opencode run`, and ACP terminal

### 1. What Multica does
- Multica's **OpenCode backend uses `opencode run --format json`**, not ACP (M `opencode.go:43-51`, `:95`). It resolves npm shims to the native `opencode.exe` on Windows to avoid `%*` newline truncation and the 32,767-char `CreateProcess` cap (M `opencode.go:673-708`), and delivers the prompt on stdin never argv (M `opencode.go:142-152`).
- Other runtimes (Hermes, Kiro, Kimi, Qoder, Grok, Reasonix, Dim, …) use a shared ACP client; `acp_terminal.go` implements ACP's `terminal/*` methods by spawning each command through `startOwnedProcessTree` and bounding output as a UTF-8-safe tail (M `acp_terminal.go:22-114`, `:162-204`).
- ACP effort is applied with `session/set_config_option` after reading the option id from the session, and the result is read back but explicitly **not** treated as proof of application (M `acp_effort.go:226-305`).
- OpenCode 2.x became a thin client over a resident service, so cancellation requires a server-side session interrupt (M `opencode_v2.go:235-289`); MCP credentials cannot be delivered safely on 2.x, so those runs are refused rather than run without servers (M `opencode_v2.go:97-158`).

### 2. What Bloblex does today
- Bloblex uses `opencode acp --cwd <project>` (B `crates/bloblex-adapter-acp/src/lib.rs:44-53`), which `docs/runtime-capabilities.md:88` confirms. The adapter:
  - does the `initialize`/`initialized`/`session/new` handshake (`:350-367`);
  - sends `session/prompt` and maps `agent_message_chunk`/`agent_thought_chunk`/`tool_call`/`tool_call_update` (`:197-231`, `:426-448`);
  - does **not** set model, mode, or effort, does not read `configOptions`, does not consume `usage_update`, and does not build `OPENCODE_CONFIG_CONTENT` (`grep` in `crates/bloblex-adapter-acp/src/lib.rs` finds none of these).
- `crates/bloblex-adapter-opencode/src/lib.rs` is a 5-line re-export of the ACP adapter.

### 3. Gap or risk
**Concrete failure (P1).** `docs/runtime-capabilities.md:230-234` (live, Director-verified) says OpenCode ACP exposes `model`, `effort`, and `mode` as session config options, that the custom-agent instruction is only active once `mode` is set, and that per-turn usage/cost exist. The current adapter does none of it. Consequences: agents cannot select a model or effort; instructions in `OPENCODE_CONFIG_CONTENT` (if set) are inert until mode is selected (O4, `runtime-capabilities.md:85`); usage is invisible to budgets; cancelling an OpenCode 2.x-style resident service will not stop the work. Also, unlike Multica, Bloblex does not resolve the Windows npm shim for OpenCode before spawning; it relies on `bloblex-runtime` resolution, which currently can return a `.ps1` as the executable (B `crates/bloblex-runtime/src/lib.rs:37-56`) — a path `tokio::process::Command` cannot execute directly.
### 4. Recommendation
**ADAPT/ADOPT.** Implement the Phase 2b ACP contract already specified: read `configOptions`, set model then mode then effort with read-back evidence, consume `usage_update` via the accumulator from Area 8, and use an isolated `OPENCODE_CONFIG_CONTENT` (already specified at `PHASE_2B_SPEC.md:85`). Do **not** switch to `opencode run`; Bloblex's invariant is prompts over stdin/protocol and the ACP surface is already probed. **ADOPT** Multica's native-shim resolution as a hardening step for OpenCode on Windows.
### 5. Priority / effort
P1 / L (this is Phase 2b work already planned).
### 6. Invariant
`OPENCODE_CONFIG_CONTENT` is Bloblex-owned and must never be logged; prompts stay out of argv; unknown usage stays unknown.

---

## Area 13 — Probe / version / discovery subprocess handling

### 1. What Multica does
- Probes (`--version`, `--help`, `debug models`, `list_models`) run through owned process trees with `WaitDelay` so a lingering descendant cannot hold the call (M `launch.go:142-213`; `claude.go:1470-1533`). `extractVersionLine` skips shim noise (`chcp` output) and returns a recognised-version flag so a salvaged probe cannot mistake a wrapper banner for a version (M `claude.go:1572-1601`). `salvageProbeAnswer` only accepts the answer when the CLI actually answered and the error is `ErrWaitDelay` (`claude.go:1560-1570`).
- `collectDrainGrace` and an 8 MiB stdout cap exist because a CLI in a log loop retained megabytes of output in an earlier revision (M `run_collect.go:69-126`).

### 2. What Bloblex does today
- `bounded_output` runs a probe with `cmd.output()` and a 6 s timeout, concatenating stdout+stderr and truncating to 32 KiB (B `crates/bloblex-runtime/src/lib.rs:145-162`). Version is the first non-empty line (`:180-185`). No process-tree ownership; no distinction between a recognised version and wrapper noise; no negative capability cache (each `runtime.refresh` re-probes).
- Adapters have their own probe timeouts (Claude 6 s `crates/bloblex-adapter-claude/src/lib.rs:908`; Codex 6 s `crates/bloblex-adapter-codex/src/lib.rs:663`; ACP 5 s `crates/bloblex-adapter-acp/src/lib.rs:318`).

### 3. Gap or risk
On Windows, a shim-with-grandchild can hold the probe's stdout open until the 6 s timeout; Bloblex then reports `version: None` or skips the runtime, and never reaps the descendant. Multica's `WaitDelay` + owned tree is the fix.
### 4. Recommendation
**ADAPT** owned probes with a bounded pipe wait; **ADOPT** a negative capability cache for `list_models` unsupported, keyed by CLI version (M `claude_models.go:120-157`), so old CLIs are not re-probed on every task.
### 5. Priority / effort
P1 / S.
### 6. Invariant
Do not parse raw `codex debug models` instruction templates into logs or React (Bloblex uses `model/list`, which is correct; `PHASE_2B_SPEC.md:79` bans the raw output).

---

## Area 14 — Argument quoting, launch prefix, and extra args

### 1. What Multica does
- A custom runtime profile's `fixed_args` are spliced directly after the executable, before protocol args, and a single filter drops protocol-critical flags from the prefix while preserving positional tokens (M `launch.go:45-115`, `505-541`). This fixes a real bug where `--output-format text` in `fixed_args` broke the stream-json channel (M `launch.go:439-500`).
- User `custom_args` are filtered against a per-backend blocklist; shell quotes are stripped once (`unshellQuoteArg`) because the CLI is spawned without a shell (M `claude.go:1333-1424`). Logging redacts every value and keeps only plausible flag names (M `launch.go:394-433`).

### 2. What Bloblex does today
- The spec requires `customArgs` be **empty** for all adapters and rejects nonempty with `invalid_argument` (B `docs/PHASE_2B_SPEC.md:95`; daemon enforces at `bloblex-daemon/src/main.rs:942-951`). Typed fields are adapter-owned. This is stronger than Multica's filter approach for a single-user app.
- Bloblex resolves npm shims by parsing the `.cmd` text and extracting a native `.exe` or `node.exe <script>` (B `crates/bloblex-runtime/src/lib.rs:63-143`), avoiding `cmd.exe` argument forwarding on Windows.

### 3. Gap or risk
Bloblex's stricter allowlist is correct and should stay. Two residual risks: (a) `.ps1` is in the extension list and returned as an executable (B `crates/bloblex-runtime/src/lib.rs:38`, `:53-56`) which `Command::new` cannot launch directly; (b) `launch_args` from a stored runtime are passed verbatim to every adapter (B `crates/bloblex-daemon/src/main.rs:758-765`), so a malicious/corrupt runtime row is not re-filtered at launch.
### 4. Recommendation
**SKIP** Multica's custom-args feature (out of scope). **ADOPT** a small hardening: never return `.ps1` as an executable, and re-validate stored `launchArgs` before use.
### 5. Priority / effort
P2 / S.
### 6. Invariant
Prompts must never travel in argv (Bloblex already obeys: Claude stdin `crates/bloblex-adapter-claude/src/lib.rs:1062-1064`, Codex RPC text `crates/bloblex-adapter-codex/src/lib.rs:803`, ACP prompt `crates/bloblex-adapter-acp/src/lib.rs:438`).

---

## Area 15 — Permissions, environment, and secrets

### 1. What Multica does
- Claude auto-approves all tool uses in autonomous mode (`handleControlRequest`), and forces `run_in_background` tools to foreground (M `claude.go:556-606`); it disallows `AskUserQuestion` because there is no interactive surface (M `claude.go:1085-1092`). `filterCustomArgs` strips user attempts to override permission flags (M `claude.go:1063-1076`).
- Child env strips internal `CLAUDECODE*` markers and `MULTICA_*` namespace but preserves user-facing `CLAUDE_CODE_*` config (M `claude.go:1283-1331`). MCP temp config files are written `0o600` and cleaned up (M `claude.go:1426-1456`).

### 2. What Bloblex does today
- The daemon owns permissions: `PermissionRequested` events are persisted and answered via `permission.reply` (B `bloblex-daemon/src/main.rs:577-616`, `:1916-1937`). Claude uses `--permission-mode default --permission-prompt-tool stdio` (B `crates/bloblex-adapter-claude/src/lib.rs:627-640`) and maps `can_use_tool` requests to allow/deny (`:542-572`). Codex requests surface `allow_once`/`deny` (`crates/bloblex-adapter-codex/src/lib.rs:118-139`, `:889-925`).
- Instruction files are stored in an ACL-restricted `%LOCALAPPDATA%\Bloblex\private-tmp` directory (~0700/0600, current-user-only ACL) with a 24 h dead-pid cleanup (B `crates/bloblex-adapter-claude/src/lib.rs:28-229`).
- Custom env is restricted to `LANG, LC_ALL, TZ, NO_COLOR, TERM`, secret-looking keys rejected, values never logged (B `bloblex-daemon/src/main.rs:952-977`; `PHASE_2B_SPEC.md:97-102`). However, the adapters currently **never apply** `ExecOptions.env` to the child command (no `cmd.env(...)` in any adapter), so the allowlisted env is dropped silently.

### 3. Gap or risk
Bloblex's daemon-owned permission model is a deliberate improvement over Multica's auto-approve and should be kept. The env gap is a concrete bug: a user-configured `TZ`/`LANG` in the allowlist has no effect. Also, Bloblex surfaces the full tool `input` JSON as permission `detail` (`crates/bloblex-adapter-claude/src/lib.rs:566-568`) and persists `raw` provider JSON in permissions (B `bloblex-daemon/src/main.rs:1919-1927`) — that is raw provider data stored server-side, though it is not sent to React as raw JSON. This should be reviewed against the "no raw provider JSON" invariant.
### 4. Recommendation
**SKIP** auto-approve. **ADOPT** the `run_in_background → false` foreground rewrite idea if Bloblex wants to prevent detached background tools (multica `claude.go:600-606`). **Fix** (not adopt): apply the allowlisted env in each adapter; review persisted permission `raw`.
### 5. Priority / effort
P1 (env) / S; P2 (raw review) / S.
### 6. Invariant
Never log secrets or instruction text; custom env values are never logged; raw provider JSON must not reach React (it currently does not; storage of `raw` should be assessed).

---

## Area 16 — Test strategy for real-world CLI failure modes

### 1. What Multica does
- Re-executes the test binary as a fake CLI selected by env var, so fakes receive the real CLI's argv (M `claude_deadlock_test.go:15-81`). Tests target concrete field failures by name: deadlock on startup stdout burst, cancellation orphaning descendants, escalation when a descendant ignores SIGTERM, thread-id race, context exhaustion with empty/reworded prose, retired-compaction false positives, and interrupt latency (M `claude_deadlock_test.go`, `claude_cancel_unix_test.go`, `codex_thread_id_race_test.go`, `claude_context_exhausted_test.go`, `codex_compaction_test.go`, `codex_interrupt_latency_integration_test.go`).
- Verification is by captured fixtures (`testdata/claude-code-2.1.220-context-exhausted-resume.jsonl`) and by asserting classification, not just status.

### 2. What Bloblex does today
- Fake CLIs exist (`crates/bloblex-adapter-claude/src/bin/fake_claude.rs`, `fake_icacls.rs`; `crates/bloblex-adapter-codex/src/bin/fake_codex_server.rs`) and lifecycle tests (`crates/bloblex-adapter-claude/tests/lifecycle.rs`, `crates/bloblex-adapter-codex/tests/app_server.rs`, `crates/bloblex-adapter-acp/tests/acp_lifecycle.rs`). Unit tests assert argument order, catalog normalization, usage subtraction, and instruction-file ACL behaviour (e.g. `crates/bloblex-adapter-claude/src/lib.rs:1165-1255`).

### 3. Gap or risk
Bloblex's tests are good but do not yet cover the failure modes above (no deadlock-burst fixture, no cancellation-orphan assertion, no thread-replay fixture, no context-exhaustion fixture).
### 4. Recommendation
**ADOPT** the test shapes (not the Go code): a fake CLI that emits a large stdout burst before reading stdin; a cancellation fixture that spawns a detached grandchild and asserts it is dead; a resume-replay fixture for Codex; a captured Claude context-exhaustion fixture. These can be written as Rust integration tests under the existing `tests/` directories.
### 5. Priority / effort
P2 / M.
### 6. Invariant
Tests use fakes only — never the installed CLIs or network (matches `PHASE_2B_SPEC.md:205`).

---

## (a) Prioritised adoption backlog

| ID | Area | Action | Priority | Effort | Bloblex files to change | Multica files to read |
|---|---|---|---|---|---|---|
| A1 | Process tree | Owned process trees: Windows Job Object (suspended start + assign + resume), Unix process group; terminate tree on cancel/timeout/close | P0 | L | `crates/bloblex-adapter-claude/src/lib.rs`, `.../codex/src/lib.rs`, `.../acp/src/lib.rs`, `crates/bloblex-runtime/src/lib.rs`, new shared helper in `crates/bloblex-agent-core` | `proc_windows.go`, `launch.go`, `run_collect.go` |
| A2 | Cancellation | Bounded Codex `turn/interrupt` (~2 s) then forced tree kill; ACP bounded cancel then tree kill | P1 | M | `crates/bloblex-adapter-codex/src/lib.rs:866-888`, `crates/bloblex-adapter-acp/src/lib.rs:449-478` | `codex.go:2625-2672`, `codex_interrupt_latency_integration_test.go` |
| A3 | Pipes | Independent writer task; explicit bounded drain/wait (close stdin → grace → tree kill → WaitDelay) | P1 | M | all three adapters | `claude.go:155-244`, `opencode.go:269-320`, `codex.go:1340-1483` |
| A4 | Codex notifications | Filter `item/*` by thread id and turn id; arm a replay gate before `turn/start`, open at `turn/started` | P1 | S-M | `crates/bloblex-adapter-codex/src/lib.rs:288-334` | `codex.go:2448-2512`, `3565-3574`; `codex_thread_id_race_test.go` |
| A5 | Context/compaction | Claude `terminal_reason` handling + session retirement signal; Codex retired-compaction and resume-overflow detection | P1 | S-M | `crates/bloblex-adapter-claude/src/lib.rs:449-541`, `crates/bloblex-adapter-codex/src/lib.rs:104-105` | `claude.go:702-732`, `stream_json_result.go:89-162`, `codex.go:191-283` |
| A6 | ACP usage | Consume `usage_update` + prompt-result usage via field-presence/per-bucket-max accumulator; cumulative cost delta | P1 | M | `crates/bloblex-adapter-acp/src/lib.rs:197-231`, catalog/usage in `crates/bloblex-agent-core` | `acp_usage.go` |
| A7 | ACP config | Read `configOptions`; set model→mode→effort with read-back evidence; isolated `OPENCODE_CONFIG_CONTENT` | P1 | L | `crates/bloblex-adapter-acp/src/lib.rs`, `crates/bloblex-adapter-opencode/src/lib.rs` | `acp_effort.go`, `opencode.go:95-224` |
| A8 | Hardening: env | Apply the allowlisted `ExecOptions.env` to child commands; `.ps1` never returned as executable; re-validate stored `launchArgs` | P1 | S | all adapters, `crates/bloblex-runtime/src/lib.rs:37-56` | `claude.go:1283-1331` |
| A9 | Catalogs | Claude `disabled`/`resolvedModel`/`default` handling; `Catalog.Verified` concept; ACP `configOptions` catalog | P1 | M | `crates/bloblex-adapter-claude/src/lib.rs:231-287`, `crates/bloblex-adapter-acp/src/lib.rs`, `crates/bloblex-agent-core/src/lib.rs:75-102` | `claude_models.go`, `models.go:33-149`, `acp_effort.go:109-190` |
| A10 | Watchdogs | Separate startup/no-progress and semantic-inactivity watchdogs; record values as product choices | P1 | M | `crates/bloblex-daemon/src/main.rs`, adapters | `agent.go:26-136`, `codex.go:47-100`, `:2229-2245` |
| A11 | Probes | Owned probes with bounded pipe wait; negative capability cache keyed by CLI version; recognised-version flag | P1 | S | `crates/bloblex-runtime/src/lib.rs:145-162`, `crates/bloblex-adapter-claude/src/lib.rs:846-899` | `launch.go:142-213`, `claude.go:1470-1601`, `claude_models.go:82-133` |
| A12 | Resume rejection | Positive-evidence resume-rejection detection per adapter; clear/retire pointer only on that evidence | P2 | M | all adapters, `crates/bloblex-daemon/src/main.rs` | `claude.go:1169-1239`, `acp_session.go` |
| A13 | Tests | Deadlock-burst, orphan-cancel, replay, context-exhaustion fixtures | P2 | M | `crates/bloblex-adapter-*/tests/` | `claude_deadlock_test.go`, `claude_cancel_unix_test.go`, `codex_thread_id_race_test.go`, `claude_context_exhausted_test.go`, `codex_compaction_test.go` |
| A14 | Interface | `TerminalObserved`-style ordering hook if watchdogs are added | P2 | S | `crates/bloblex-agent-core/src/lib.rs:337-381` | `agent.go:183-191` |

## (b) Multica behaviours that conflict with Bloblex invariants — do NOT adopt

1. **Auto-approving every tool use** (`claude.go:556-598`): Bloblex's daemon owns permission decisions (`bloblex-daemon/src/main.rs:577-616`). Do not copy autonomous auto-approve.
2. **Scraping the provider session JSONL for usage baselines** (`claude.go:825-1025`, reading `~/.claude/projects/**`): Bloblex's invariant is that the daemon owns sessions and never scrapes a primary terminal/state store. Use provider-reported usage instead; if a baseline is needed, derive it from Bloblex's own persisted usage, not the CLI's private files.
3. **Reading `~/.codex/config.toml` to resolve the effective model** (implied by `thinking.go:645-657`): this is provider-config scraping. Bloblex should require an explicit model or fail the effort closed.
4. **MCP credentials/config delivered via workdir files** (the OpenCode 2.x case, `opencode_v2.go:109-140`): writing secrets into the agent's working tree violates the no-credentials-in-repo principle even though Multica refused the case — do not introduce a file channel that the agent can commit.
5. **Multica's custom-args/fixed-args feature** (`launch.go:439-541`): Bloblex's invariant is `customArgs` empty and typed adapter-owned fields (`PHASE_2B_SPEC.md:95`). Keep the empty allowlist.
6. **Multiple-account/team/workspace behaviours** — per-workspace MCP brokering, Claude account-binding resume detection tied to multi-tenant account switching (`claude.go:1187-1197`), team concurrency and issue/channel delivery: **[multi-user-only]**, out of scope for a single-user desktop daemon.
7. **Cloud/remote runtime routing** (OpenClaw gateway, `agent.go:120-131`; serve/host flags) — **[multi-user-only]**, not applicable.
8. **Storing the provider's raw stream/JSONL content in logs or state** (`claude.go:1000-1019` reads raw session lines): Bloblex must keep writing normalized rows with `raw: {}` for new usage events (`bloblex-daemon/src/main.rs:2007`). Do not port the JSONL reader.
9. **Interrupting an OpenCode background service over an HTTP API** (`opencode_v2.go:250-289`): Bloblex speaks ACP and should stop work through ACP plus the process tree, not by calling a provider service endpoint.
10. **Auto-substituting or clearing a configured model when the catalog changes** (`claude_models.go:32-41` explicitly declines to do this): consistent with Bloblex, but recorded so a porter does not "improve" it.

## (c) Implementation notes for porting Go → Rust

- **Process trees.** Use the `windows` crate: `CreateJobObjectW`, `SetInformationJobObject` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, create the child suspended (`CREATE_SUSPENDED`), `AssignProcessToJobObject`, then resume (M `proc_windows.go:100-209`). `tokio::process::Command` does not suspend or assign; a real port needs `std::process::Command` with `std::os::windows::process::CommandExt::creation_flags` plus `StartupInfo`, or `Command::spawn` followed by assignment only if the child is created suspended. On Unix use `CommandExt::process_group(0)` and signal the group; Rust's `pre_exec` or `nix::sys::signal::killpg` can do the group kill. Do **not** rely on `tokio`'s `kill_on_drop` for tree ownership.
- **Concurrency primitives.** Multica's Guarantees come from Go channels and `sync.Once`: a one-shot `Result` channel, a buffered write-result channel, and `sync.Once` around cleanup (`codex.go:1386-1483`). In Rust the equivalents are `tokio::sync::oneshot`, an `mpsc`/`Notify` for turn completion, and `tokio::sync::OnceCell` or an `AtomicBool` guard for exactly-once cleanup. The key port is structural: a **separate task for writing stdin** and a **bounded cleanup future** rather than inline awaits.
- **Pipe handling.** Rust's `BufReader::lines()` has no configurable maximum line length, so Multica's scanner-overflow protection (`codex.go:1349-1381`) must be re-created with an explicit length-limited reader (e.g. `tokio_util::codec::LinesCodec` with a max length, or `take`-style framing). Always keep reading a stream even after a cap (Multica `run_collect.go:149-155`), or a capped reader converts "too large" into a hung child.
- **Confirming cleanup.** Model Multica's `waitProcessGroupGone` (`proc_windows.go:273-295`) as a poll on job `ActiveProcesses` (Windows) or the process group (Unix), returning "could not confirm" rather than success when ownership was never taken. Never report a cancelled turn as fully stopped until the tree is confirmed empty.
- **Timeouts.** Multica uses `context.WithTimeout` for per-call budgets and a *separate* context for the interrupt that survives the run context (`codex.go:2653-2654`). In Rust, build the interrupt future on a fresh timeout, not on the cancelled run future, or the interrupt itself is immediately cancelled.
- **Usage.** Implement the accumulator as pure functions over parsed numbers so it is unit-testable without a process (M `acp_usage.go` is almost all pure helpers).

## (d) UNVERIFIED items

- No Multica behaviour was executed. All Multica findings are source/test reading; real-world latency and message shapes are inferred from Multica's own comments.
- Whether Bloblex's `bloblex-runtime` currently resolves the installed `claude`/`codex`/`opencode` shims to native binaries on this machine: `resolves_installed_clis_to_real_native_targets` (`crates/bloblex-runtime/src/lib.rs:360-376`) is environment-dependent and was not run.
- Whether the Bloblex Claude/Codex adapter files being edited by other lanes will add process-tree handling or ACP config before this document's recommendations are acted on; the citations are to the working tree at write time.
- Bloblex `ExecOptions.env` being ignored by adapters was established by reading the adapters, not by a live trace; a subsequent lane may have changed it.
- Whether Codex compaction/context-exhaustion handling is planned elsewhere (it is not in `docs/PHASE_2B_SPEC.md`, which was read in full).
- Multica's `mcode`/`dim`/other ACP backends were not read; only the files named in the task were examined.
- Whether Bloblex persists raw tool `input` as permission `detail`/`raw` in the current storage schema was read at `bloblex-daemon/src/main.rs:1916-1932`; the storage column semantics in `crates/bloblex-storage` were not reviewed.

===REPORT===
1. P0 findings (one line each): P0 — Bloblex spawns every provider/probe process through `tokio` `kill_on_drop`/`child.kill()` with no process-tree ownership, so on Windows (npm shim grandchild) and Unix (MCP/tool subprocesses) a cancelled/timed-out agent can keep running and keep a provider session alive (all three adapters; Multica `proc_windows.go:100-132`, `launch.go:133-140`). P1 findings (one line each): P1 — Codex `turn/interrupt` and ACP `session/cancel` have no bounded-then-force escalation, letting a wedged turn hold a daemon slot up to 30 min; P1 — Codex `item/*` notifications are unfiltered by thread/turn, so resume replay can surface a stale answer; P1 — Claude `terminal_reason: prompt_too_long` and Codex compaction/resume-overflow are not detected or classified; P1 — OpenCode ACP sets no model/mode/effort and consumes no `usage_update`, so budgets and settings are inert; P1 — allowlisted `ExecOptions.env` is never applied to child processes.
2. Areas covered: 16.
3. Adoption backlog size: 14 items (A1–A14).
4. UNVERIFIED: no Multica behaviour was executed (source/test reading only); environment-dependent shim-resolution test not run; Bloblex working-tree adapters may change under other lanes; `ExecOptions.env` being ignored was established by source reading, not a live trace; no context/compaction handling found in `PHASE_2B_SPEC.md`; non-named Multica ACP backends not read; Bloblex storage semantics for persisted permission `raw` not reviewed.
===END REPORT===
