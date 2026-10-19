# Phase 1A spec: one turn-end path, honest timeouts, delivery facts

> **What this is:** Spec for the improvement plan's phase 1A: one turn-end path, honest timeouts and delivery facts.
> **Status:** historical
> **Last updated:** 2026-10-12

Owner: OpenCode lane (backend only). Reviewer: Director. Parent plan: `docs/plans/improvement-plan.md` Phase 1.
Scope is `crates/bloblex-daemon`, `crates/bloblex-agent-core`, `crates/bloblex-adapter-claude`, `crates/bloblex-adapter-codex`, `crates/bloblex-adapter-acp`. **Do not touch `apps/` (UI), docs other than a short note in `docs/ipc-contract.md`, or `Cargo.toml` dependencies.**

## Rules
- Work only in this worktree. **Never run `git commit`, `git push`, `git checkout`, or `git stash`.** Leave changes uncommitted.
- Run cargo with a private target dir: `CARGO_TARGET_DIR=D:/b-p1` (first build is slow; that is expected). Never use the repo's `target/`.
- Repo style: match the surrounding code (dense Rust, existing helper names, existing test style). No new dependencies. No `unwrap()` in non-test code paths you add.
- Never log or persist prompts, tokens, or raw provider JSON. Provider text goes through the existing `safe_provider_error_detail`.
- Behaviour that is not listed below must stay byte-for-byte the same, including event types, payload field names, ordering, and `turns.outcome` values.

## Background (verified in source at base commit `b1a8d9a`)
`crates/bloblex-daemon/src/main.rs` ends a failed turn in three places that each re-implement the same steps:
1. The spawned prompt task's `Err(e)` branch (search `let failure_class = adapter_failure_class(&e, permission_denied);`, ~L2200-2226). It updates the turn outcome, sets session state `error`, removes `active_turns`, emits `session.changed` then `turn.error`, and calls `team::after_turn(..., "turn.error", ...)`.
2. `forward_events_with_timeouts` timeout branch (search `update_turn_outcome(turn_id, "error", Some("timeout"))`, ~L2422). It emits `turn.error` with `failureClass:"timeout"` but **never calls `team::after_turn`**, so queued team deliveries and side-conversation replies stall forever after a timeout.
3. The `AgentEvent::Error` arm of the event match (search `AgentEvent::Error { message: provider_message }`, ~L2716). It builds `("turn.error", payload)` and the shared tail of the loop emits it and calls `after_turn`.
(`AgentEvent::ContextExhausted` is a fourth, differently-shaped site. Leave it unchanged.)

The watchdog in `forward_events_with_timeouts` uses `startup_no_progress_timeout` (45s) and `semantic_inactivity_timeout` (300s). `PermissionRequested` and `QuestionRequested` set the session state to `waiting_permission` (search `update_session_state(&sid, "waiting_permission")`) but the timer keeps running, so a user who takes more than 5 minutes to answer an approval gets a `timeout` failure and a torn-down provider session.

`turns` already has a `data TEXT` JSON column (`crates/bloblex-storage/src/lib.rs`, `CREATE TABLE IF NOT EXISTS turns(... data TEXT ...)`). No migration is needed or allowed in this task.

## Task A1: extract one failure-finalisation helper
Add a private helper in `main.rs` (name `finish_turn_failed` or similar) that performs, in this order, exactly what sites 1 and 2 do today: `update_turn_outcome`, `update_session_state`, removal from `active_turns`, `session.changed` summary emit, `turn.error` emit. It takes the session id, turn id, failure class, public message, optional detail, and the target session state (`error`, or `idle` when the timeout path successfully resumed). Sites 1 and 2 must use it. Site 3 (the event-loop arm) may keep building its tuple, but must share the same message/class mapping helpers rather than copy them.
Constraints:
- The emitted `turn.error` payload keeps its existing fields (`sessionId, turnId, message, failureClass, detail`). Do not add fields in A1.
- Site 1 still returns early when the session gate is stale or the session was deleted, before mutating anything (keep the gate checks exactly as they are).

## Task A2: timeouts must finish the team handshake
After the timeout path emits `turn.error`, it must call `team::after_turn(&st, &sid, Some(turn_id.clone()), "turn.error", <detail or public message>)` exactly like site 1 does. Use the same detail-fallback expression. Do not call it twice for one turn.

## Task A3: the watchdog must not fire while the user is being asked
While the session's persisted state is `waiting_permission`, neither timeout may fire and the provider session must not be torn down. When the state leaves `waiting_permission`, the inactivity window restarts from that moment (not from the old progress timestamp).
Implementation guidance:
- Find the existing cheap state lookup in `bloblex-storage` (`session_detail`/`session_event_summary` are heavier than needed; add a tiny `session_state(&str) -> Option<String>` only if none exists).
- Check it at the top of the loop iteration (reset `last_semantic_progress` to now when waiting) and again inside the `Err(_)` timeout branch before any teardown (`continue` instead of tearing down).
- A turn that is cancelled or deleted while waiting must still end normally via the existing paths.
- Keep the `startup_no_progress_timeout` semantics for turns that never produced progress and are not waiting.

## Task A4: record whether the provider accepted the prompt
Add `AgentEvent::PromptAccepted` to `bloblex-agent-core` (`#[derive]`s as the other variants, no payload). Semantics: emitted at most once per prompt, only after there is positive evidence the provider took the prompt.
- Claude (`crates/bloblex-adapter-claude`): the first stream-json event that follows the stdin write of that prompt and belongs to its turn (assistant/stream_event/tool/result). Not `system/init` of a long-lived process.
- Codex (`crates/bloblex-adapter-codex`): when the `turn/start` JSON-RPC call returns success (the response, not the request being written).
- ACP/OpenCode (`crates/bloblex-adapter-acp`): the first `session/update` notification after `session/prompt` was written for that prompt.
Daemon: on `PromptAccepted` for the active turn, merge `{"delivery":"acknowledged"}` into that turn's `turns.data` JSON (preserve existing keys; create the object if empty). When a turn ends in error without ever receiving `PromptAccepted`, merge `{"delivery":"unknown"}`. A successfully completed turn that never emitted `PromptAccepted` also gets `unknown` (never infer). Do **not** emit a new wire event to the UI for this, and do not add `not_sent` yet (reserved for Phase 3).
Add a storage helper for the JSON merge if none exists; it must be a single UPDATE or a read-modify-write inside the existing connection lock, and must not clobber concurrent keys.

## Tests (required; deterministic, no real CLIs)
Extend the existing `forward_events_with_timeouts` tests in `main.rs` (`timeout_event_includes_only_sanitized_claude_process_diagnostics` is a good template) and the adapters' fake-peer tests:
1. Timeout path now triggers `after_turn`: with a queued team prompt for the session, the queue drains after a timeout (assert the next delivery is attempted or the queue is empty).
2. `waiting_permission` pause: a turn with a pending permission outlives the semantic timeout (use tiny durations); after the permission is resolved and no progress follows, the timeout fires from the new baseline.
3. `PromptAccepted` sets `turns.data.delivery == "acknowledged"`; a failed turn without it sets `unknown`; existing keys in `turns.data` survive.
4. Each adapter emits `PromptAccepted` exactly once per prompt in its fake-peer happy path and not at all when the peer rejects the prompt (extend `fake_codex_server`, `fake_acp_peer`, and the Claude fixture the way existing tests do).
5. Regression: all pre-existing tests in the five crates still pass unchanged.

## Gates (run and report the real output)
```
CARGO_TARGET_DIR=D:/b-p1 cargo test -p bloblex-agent-core -p bloblex-storage -p bloblex-adapter-claude -p bloblex-adapter-codex -p bloblex-adapter-acp -p bloblex-daemon
CARGO_TARGET_DIR=D:/b-p1 cargo clippy -p bloblex-daemon -p bloblex-agent-core -- -D warnings   # only if clippy is already clean on the base commit; otherwise report the delta
```
If a gate fails for a reason unrelated to your change, say so with the output; do not "fix" unrelated code.

## Final report (print as your last message, plain text)
1. Files changed (path, one line each).
2. For each of A1-A4: what you did, and the exact test names covering it.
3. Gate output summary (counts of passed/failed/ignored per crate).
4. Anything you could not verify, any behaviour you were unsure about, and any place the spec did not match the source.
Do not claim live-CLI verification. This task is fake-peer verified only.
