# FIX28 part 2 (WP2): sending never blocks, and conversations warm up early

> **What this is:** Spec for FIX28 part 2 (WP2): sending never blocks, and conversations warm up early.
> **Status:** historical
> **Last updated:** 2026-10-16

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, in its own worktree. Director reviews, runs the gates on the merged result and commits. **Do not run `git commit`.** Read `AGENTS.md` first (the 16 October amendment: two lanes, the lane never commits).

Read before coding: `crates/bloblex-daemon/src/main.rs` `session_prompt_impl` (~2345), `ensure_session_active` (~2030), `resume_session` (~1854), the `session.cancel` dispatch arm (~897), `finish_turn_failed` (~2736), `new_session`, the test `state()` helper; `crates/bloblex-daemon/src/queue.rs` `send_claimed` (~270-300); `crates/bloblex-daemon/src/team.rs` `deliver` (~580), `after_turn`, `relay_failure`; `crates/bloblex-daemon/src/retry.rs`; `crates/bloblex-daemon/src/catalog.rs` (WP1, already merged: every send-path catalog read is `CachedOnly`).

## Why

`session.prompt` returns only after `ensure_session_active` has resumed the provider (Claude up to 8 s, Codex `thread/resume` up to 30 s, OpenCode `session/load` up to 20 s). The UI holds the composer until the RPC returns, so after a restart the first send "hangs". The owner wants a send to land instantly.

## 1. Split `session_prompt_impl` into two phases

### Phase A (synchronous, milliseconds, under the existing session gate)
Keep, in order, everything that can reject a send:
- text and attachment validation, archived and side read-only checks, reply snapshot, conversation references;
- the attachment/provider check, using `session_before["provider"]` rather than a live handle;
- **conflict** when `active_turns` already holds the session or its state is busy (the queue and team callers requeue on `conflict`: `queue::send_claimed`, `team::deliver`; these must stay synchronous);
- `exec_options_for_session`, then `preflight_exec_options` (cheap now: the catalog read is `CachedOnly`), then `adapter_for(provider).preflight_exec_options(...)`, fetched by provider (no live session needed);
- a rejection keeps today's `reject_exec_turn` path and returns the error synchronously.

Then reserve and record:
- `create_reserved_turn`, append the user message (and keep the existing auto-title call where it is), create the exec snapshot;
- state = `working` if the session is already in `st.sessions`, else `starting`; insert into `active_turns`; emit `session.changed`;
- return `{"turnId", "accepted": true, "state"}`.

### Phase B (the spawned turn driver, `tokio::spawn`)
1. `activate_session(st, sid, Owner::Turn(turn_id))` (below).
2. If a cancel was requested while starting (see 2), finish the turn as cancelled and stop.
3. Set the instruction-hash context.
4. The existing Codex approval-mode relaunch block, moved here as is.
5. Set state `working` and emit `session.changed`.
6. `adapter.prompt(...)` with the memory suffix, exactly as today.

Any failure in Phase B goes through `finish_turn_failed` (a `turn.error` with a `failureClass`), then `team::after_turn(.., "turn.error", ..)` and `retry::after_failed_turn`. `ContextExhausted` still emits `session.context_exhausted`. A missing runtime or a `validate_spawn_target` failure maps to a **new** failure class `provider_unavailable` with the message "The coding agent could not start." Leave `provider_unavailable` **out** of auto-retry (check the eligible classes in `retry.rs`). Make sure a resume failure does not produce a duplicate `relay_failure` note for a side session (`after_turn` already relays "The turn failed:").

### `activate_session(st, sid, owner)`
Replaces the direct `resume_session` calls on the prompt path.
- A per-session lock: `activation_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>` in `AppState`. If the session is already active (in `st.sessions`), return at once.
- Resume through today's body, refactored as `resume_inner(st, sid, allow_states)`. Its install check drops `state == previous_state` and keeps: not deleted, not archived, `modelLock` unchanged, not already active.
- It sets state `idle` only when the current state is idle-like (`idle`, `closed`, `offline`, `error`, `completed`). It never overwrites `starting` or `working`.
- The `session.resume` RPC keeps its behaviour (a wrapper with `Owner::Rpc`), including its conflict on an active session.

## 2. Cancel while starting
In the `session.cancel` arm: when `active_turns` has the session's turn but `st.sessions` does not (the turn is still starting), insert the turn id into a new `starting_cancels: Mutex<HashSet<String>>`, set state `cancelling`, emit, and return `{ "cancellationRequested": true }`. The driver checks the set after activation and before `prompt`: turn outcome `cancelled`, state `idle`, emit `turn.cancelled`, call `team::after_turn(.., "turn.cancelled", ..)`, release the reservation. Keep the activated handle installed (it is reusable).

## 3. New RPC `session.warm { sessionId }`
- Returns `{ "warming": bool, "active": bool }` at once.
- Refuses (returns `warming: false`, no error) for archived, side (`link.kind == "side"`), automation (`link.kind == "automation"`) and busy sessions, and when the runtime is not usable.
- Otherwise `tokio::spawn(activate_session(.., Owner::Warm))`.
- Keep at most **2** warmed sessions that have had no turn since warming (an LRU in `AppState`); warming a third closes the oldest idle warmed one using the existing `session.close` logic. A turn on a warmed session removes it from the LRU.
- Remote tier: add `session.warm` to `apps/desktop/src/remote/remoteTiers.ts` as `class: 'chat'`, `minTier: CHAT` (or the existing constant for chat), `why: 'Starts a conversation\'s coding agent ahead of a message.'`, and refuse it during quiet hours if the table supports a quiet-hours flag (it spawns processes). `npx vitest run src/remote` must stay green.

## 4. Follow-up from the WP7 review
`crates/bloblex-speech/src/cloud.rs` `warm()`: wrap the DNS lookup in a **3 second** `tokio::time::timeout` so a hung resolver cannot hold the warm-up; a timeout reports `dns_ok: false`. Add a test that `warm()` returns within 5 s (no network needed; it may report `dns_ok` either way).

## Tests (daemon test module; reuse the existing fake adapters, add a blocking one)
- `prompt_returns_accepted_before_resume_completes`: an adapter whose `resume_session` waits on a `tokio::sync::Notify`; `session.prompt` returns `accepted` with state `starting`, the user message is saved; after the notify, state becomes `working` and `prompt` is called once.
- `resume_failure_becomes_turn_error`: resume fails → `turn.error` with `failureClass: "provider_unavailable"` (or the adapter class), reservation released, state `error`, and for a side session exactly one relay note to the origin.
- `cancel_while_starting_skips_prompt`: cancel during `starting` → no `prompt` call, `turn.cancelled`, state `idle`.
- `warm_then_prompt_resumes_once`: `session.warm` then an immediate `session.prompt` → exactly one `resume_session` call.
- `concurrent_prompts_conflict_synchronously`: a second prompt while the first is starting → `conflict`.
- `delete_during_starting_conflicts` (existing rule).
- `queue_send_claimed_requeues_on_conflict` still holds.
- `session_resume_rpc_still_conflicts_on_active_session`.
- `warm_refuses_side_archived_busy`, and `warm_lru_closes_the_oldest_idle`.
- Update the existing slow-session test (search `slow-session`) to the new flow; explain the change in the report.

## Do not
- Change adapter code or timeouts.
- Change what a successful turn emits or stores.
- Log prompt text, paths or provider output beyond what is logged today.

## Gates (run them; paste summaries into the report)
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote`

Use the `CARGO_TARGET_DIR` the brief gives you (a separate one: do not share it with another worktree).

## Report
Write `docs/history/fix-28/send-report.md`: what changed (file:function), the new state flow (`starting` → `working`), tests added and changed, gate summaries, and what is verified by tests versus not verified (for example real CLI resume timing).
