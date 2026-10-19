# Phase 4A spec: scheduled automations for blobs (backend)

> **What this is:** Spec for phase 4A: scheduled automations for blobs (backend).
> **Status:** historical
> **Last updated:** 2026-10-12

Owner: OpenCode lane (backend only). Reviewer: Director. Parent plan: `docs/plans/improvement-plan.md` Phase 4. Builds on Phases 1-3 (turn-end path, durable queue and due loop, retry). The desktop UI is built by the Director against this contract; do not touch `apps/`.
Scope: `crates/bloblex-storage`, `crates/bloblex-daemon` (new `src/automations.rs`; `main.rs`, `team.rs`, `queue.rs` as needed), `docs/`. One new dependency is allowed: a cron library with IANA time zone support (prefer `croner` with its chrono-tz support; `chrono-tz` is already a workspace dependency). If none builds offline, implement a minimal 5-field cron parser yourself (lists, ranges, steps, names optional) and say so.

## Rules
- Work only in this worktree. **Never run `git commit`, `git push`, `git checkout`, `git stash`.** Leave changes uncommitted. Attach/read only files inside this worktree.
- Cargo: `CARGO_TARGET_DIR=D:/b-p1` and `RUST_MIN_STACK=33554432` (one daemon test overflows the default stack on the base commit; pre-existing).
- Match repo style. No `unwrap()` in non-test code you add. Never log or persist prompts-as-secrets, tokens or raw provider JSON.
- **Unattended work is the riskiest thing this app does.** Every rail below is mandatory, not optional. When unsure, deny or skip, and record why.
- Existing behaviour not listed here must stay identical.

## Data (idempotent `ensure_automation_schema()`, same pattern as `ensure_queue_schema`)
```
automations(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
  schedule_kind TEXT NOT NULL,            -- 'cron' | 'once'
  cron TEXT, timezone TEXT NOT NULL,      -- IANA name, validated
  once_at TEXT,                           -- RFC3339 UTC for 'once'
  session_mode TEXT NOT NULL DEFAULT 'new',     -- 'new' | 'reuse'
  approval_mode TEXT NOT NULL DEFAULT 'auto',   -- 'plan' | 'auto' ONLY
  max_runtime_secs INTEGER NOT NULL DEFAULT 1800,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'user',      -- 'user' | 'agent'
  reuse_session_id TEXT,
  next_run_at TEXT, last_run_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,                      -- 'user' | 'auto_failures' | 'needs_approval' | null
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)
automation_runs(
  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, session_id TEXT,
  status TEXT NOT NULL,   -- 'running'|'completed'|'failed'|'skipped'|'cancelled'|'timeout'|'interrupted'
  reason TEXT,            -- short machine code or safe sentence, never provider text
  scheduled_for TEXT, started_at TEXT NOT NULL, finished_at TEXT)
```
Partial unique index: one `running` run per automation. Index `(enabled, next_run_at)`. At most 50 automations per daemon. Deleting a blob/agent or archiving it pauses (not deletes) its automations (`pause_reason='user'`); deleting an automation keeps its run history rows and sessions.

## RPCs (register under `automation.*`; objects in/out, camelCase DTOs)
- `automation.create {agentId, name, prompt, schedule, sessionMode?, approvalMode?, maxRuntimeSecs?, enabled?}`. `schedule` is `{kind:"cron", cron:"m h dom mon dow", timezone:"Area/City"}` or `{kind:"once", at:"<rfc3339>"}`. Validation: name 1..80 chars; prompt 1..8000 bytes; agent exists and is not archived; cron parses; timezone is a valid IANA name; `once` is at least 60 s and at most 366 days ahead; `approvalMode` must be `plan` or `auto` (anything else, **including `bypass` and `ask`, is `invalid_argument`**); `maxRuntimeSecs` 60..=14400. New automations default `enabled=false` unless the request sets `enabled:true`.
- `automation.list {agentId?}`, `automation.get {id}`, `automation.update {id, ...same fields}` (recompute `next_run_at`), `automation.pause {id}`, `automation.resume {id}` (clears `consecutive_failures` and `pause_reason`, recomputes `next_run_at`), `automation.delete {id}`.
- `automation.run_now {id}`: starts a run immediately with `scheduled_for = now`; `conflict` if one is running. It does not change `next_run_at`.
- `automation.runs {id, limit?:20 (max 100), before?}` newest first.
- `automation.preview {schedule, count?:3 (max 10)}` returns the next occurrences as RFC3339 UTC plus the same list in the schedule's zone as `local` strings; used for the UI preview. Must handle DST gaps/overlaps correctly (skip a non-existent local time; run once for an ambiguous one).
- Events: `automation.changed {automation}`, `automation.deleted {id}`, `automation.run.changed {run}`, `automation.run.finished {runId, automationId, agentId, sessionId, status, reason}`. Add all rows and the DTOs to `docs/ipc-contract.md`.
Automation DTO: `{id, agentId, name, prompt, schedule:{kind,cron?,timezone,at?}, sessionMode, approvalMode, maxRuntimeSecs, enabled, createdBy, nextRunAt, lastRunAt, consecutiveFailures, pauseReason, running:boolean, lastRun?:RunDTO}`.

## Scheduler (`automations.rs`, spawned in `run()` beside the queue due loop)
- Tick every 10 s (and once at startup after `recover_after_restart`). Select `enabled=1 AND next_run_at <= now` unless the global pause setting `automations.paused` (JSON bool, default false) is true. Validate `settings.set` for it like other boolean settings.
- **Missed runs coalesce:** whatever number of occurrences were missed (machine asleep/app closed), start at most ONE run and set `next_run_at` to the first occurrence strictly after now. Record `late_by` in the run row's `reason` as `late:<secs>` when the run starts more than 60 s after `scheduled_for`.
- **Single-flight:** if the automation already has a `running` run, record a `skipped` run (`reason:"still_running"`) and advance `next_run_at`.
- **Concurrency:** `automations.maxConcurrent` setting (integer, default 1, 1..=3). When the limit is reached, or the blob already has a live user turn, leave the automation due (do not advance) for up to 15 minutes, then record `skipped` (`reason:"busy"`) and advance. The existing global active-turn cap of 4 still applies.
- **Run:** create a session for the blob via the same function `session.new` uses (`new_session`), with `link = {"kind":"automation","automationId":..,"runId":..}` (`session_mode:"reuse"` re-prompts the automation's `reuse_session_id` when it still exists, else creates one), project = the blob's default project path as `session.new` already resolves, `modelLock` pinning the blob's model/effort as today and `approvalMode` pinned to the automation's mode (`plan` also sets plan mode). Title `Automation: <name>`. Send the prompt through the same entry point `session.prompt` uses (internal, allowlisted meta `{"kind":"automation","automationId":..,"runId":..}`).
- **Completion:** hook the single turn-end path (`team::after_turn` or the Phase 3 hook) for sessions whose link is `automation`: `turn.completed` -> run `completed`, reset `consecutive_failures`; `turn.error` -> run `failed`, increment failures; `turn.cancelled` -> `cancelled`. After a failure, schedule one retry run after 30 s then 60 s inside the same occurrence (reuse the failure counter), and after **3 consecutive failures** auto-pause (`pause_reason='auto_failures'`) and emit `automation.changed`.
- **Max runtime:** a run that exceeds `max_runtime_secs` is cancelled through `adapter.cancel`, recorded `timeout`, counted as a failure.
- **Startup:** `running` runs from a previous process become `interrupted` (not failures), their sessions are left as they are, and nothing is resent.
- `once` automations disable themselves after their run (success or failure) and clear `next_run_at`.

## Safety rails (all tested)
1. **Never bypass, never ask:** an automation session's effective approval mode is `plan` or `auto` regardless of the blob's or global default; a blob with `bypass` must not leak into an automation. Enforce at the point the session's options are built (search `exec_options_for_session` / `modelLock.approvalMode` handling) so it also holds after daemon restarts and `session.model.update`.
2. **Unattended permission requests:** for sessions linked `automation`, a permission request is auto-approved only when the existing classifier approves it under `auto`; every other request is **auto-denied** (use the provider's deny choice) and recorded with `permission.auto_resolved`-style audit event `permission.auto_denied {permissionId, sessionId, automationId, runId, category, summary}` (safe short summary only). Questions (`QuestionRequested`) are auto-dismissed so the turn can finish.
3. **Recursion guard:** a session linked `automation` must not be able to create or change automations or schedule anything. The MCP tool list for such sessions must omit `message_blob`, `list_conversations` writers and all scheduling tools, and `automation.*` write RPCs reached through the MCP bridge are rejected for them (`forbidden`).
4. **Agents may only propose:** add an MCP tool `schedule_task {name, prompt, when}` (where `when` is `{kind:"once", at}` or a 5-field cron plus timezone) available to normal (non-automation) sessions. It creates the automation **disabled**, `created_by='agent'`, `pause_reason='needs_approval'`, approval mode `plan`, and returns a message telling the agent the user must approve it. It never enables itself. `list_my_schedules` read-only is allowed.
5. **Audit:** every run start, skip, finish and auto-pause is persisted as a run row; auto-denied permissions are events as above.
6. Kill switch: `automations.paused=true` stops new runs immediately and cancels nothing already running; cancelling a run is `session.cancel` on its session and must set the run `cancelled`.

## Tests (required; deterministic, in-memory storage, injected clock where needed)
Storage CRUD and constraints; cron next-occurrence including DST spring-forward gap and fall-back overlap in two zones (e.g. `Europe/Berlin`, `America/New_York`) and month-end; `automation.preview`; every validation error (including `bypass` approval mode rejected); create default disabled; coalesce after a simulated long sleep produces exactly one run; single-flight skip; busy deferral then skip after 15 minutes; failure retry 30 s/60 s then auto-pause on the third failure; `once` self-disables; max-runtime timeout; startup interruption; global pause; run completion mapping; approval-mode clamp (blob with bypass -> automation session `auto`/`plan`); auto-deny of an unclassified permission with the audit event; recursion guard (tool list and RPC rejection); agent `schedule_task` creates a disabled needs_approval automation and never runs it; blob archive pauses its automations. All pre-existing tests pass unchanged.

## Gates (run and report real output)
```
CARGO_TARGET_DIR=D:/b-p1 RUST_MIN_STACK=33554432 cargo test -p bloblex-storage -p bloblex-daemon -p bloblex-agent-core -p bloblex-adapter-claude -p bloblex-adapter-codex -p bloblex-adapter-acp
```

## Final report (plain text, last message)
1. Files changed. 2. Per section: what you did and exact test names. 3. Gate summary per crate. 4. Dependencies added (and why). 5. Anything unverified, spec/source mismatches, decisions where the spec was silent. Fake-peer verified only; no live-CLI claim.
