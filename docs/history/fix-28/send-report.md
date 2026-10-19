# FIX28 part 2 (WP2): sending never blocks, and conversations warm up early — implementation report

> **What this is:** Implementation report for FIX28 part 2 (WP2): sending and conversation warm-up.
> **Status:** historical
> **Last updated:** 2026-10-16

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, worktree `C:\fx42`, branch `lane/fix28-wp2`.
Spec: `docs/history/fix-28/send-spec.md`. Director reviews, runs the gates on the merged result and commits.
No `git commit`, no push, no `AGENTS.md` edits, no UI component/CSS changes.

Status: implemented, all listed gates green. The lane did **not** run `git commit`.

## What changed (file:function)

### `crates/bloblex-daemon/src/main.rs`

- **`AppState`** gains three fields: `activation_locks` (`Mutex<HashMap<String, Arc<Mutex<()>>>>`),
  `starting_cancels` (`Mutex<HashSet<String>>`) and `warm_lru` (`Mutex<Vec<String>>`). Both
  constructors (`run()` and the test `state()`) initialise them.
- **New `enum Owner { Rpc, Turn(String), Warm }`** — who is asking for an activation.
- **`session_prompt_impl`** is split into Phase A and a spawned `run_turn` driver:
  - **Phase A** (synchronous) keeps, in order: text/attachment validation, the archived and side
    read-only checks, `prepare_reply_snapshot`, `team::reference_context`, the attachment/provider
    check against `session_before["provider"]`, the `active_turns`/state conflict, the
    `exec_options_for_session` + `preflight_exec_options` (catalog `CachedOnly`) +
    `adapter_for(provider).preflight_exec_options(...)` rejection (which keeps the existing
    `reject_exec_turn` path and returns the error synchronously), then reserves: `create_reserved_turn`,
    the user message (with meta, references and the auto-title call in place), the exec snapshot and
    its event. It sets `working` when the session is already in `st.sessions`, else `starting`, inserts
    the turn into `active_turns`, emits `session.changed`, removes the session from the warm LRU and
    returns `{"turnId", "accepted": true, "state"}`.
  - **`run_turn(state, TurnDriver)`** (Phase B, `tokio::spawn`): `activate_session(st, sid,
    Owner::Turn(turn))`; cancel check; instruction-hash context; the Codex approval-mode relaunch
    (moved as is, minus the now-meaningless `state == previous_state` install condition); set
    `working` + emit `session.changed`; then `adapter.prompt(...)` with the memory suffix exactly as
    before. The per-turn arguments travel in a new private `TurnDriver` struct.
- **`resume_inner(st, sid, allow_states)`** is the old `resume_session` body. `allow_states` names
  states accepted in addition to the idle-like default (`["starting"]` for a turn). Its install check
  **dropped `state == previous_state`** and keeps: gate current, not deleted, not archived,
  `modelLock` unchanged, not already active. It writes `idle` only when the current state is
  idle-like (`idle|closed|offline|error|completed`), never overwriting `starting`/`working`.
- **`resume_session`** is now a thin wrapper: `activate_session(st, sid, Owner::Rpc)`, which keeps the
  RPC's conflict on an already-active session (the conflict is raised inside `activate_session` for
  the `Rpc` owner, so the TOCTOU window is closed).
- **`activate_session`** replaces the direct resume on the send/team/queue/warm paths. It returns at
  once if the session is already active; otherwise it checks the `Owner::Turn` reservation, refuses
  a busy `Owner::Warm`, takes the per-session `activation_lock_for(st, sid)`, re-checks and resumes.
- **Failure/cancel finalisers**: `finish_activation_failure` maps an activation error to a
  `failureClass` and runs `finish_turn_failed` + `team::after_turn(.., "turn.error", ..)` +
  `retry::after_failed_turn` exactly once; `finish_turn_cancelled` finalises a start-time cancel
  (`turn` outcome `cancelled`, state `idle`, `turn.cancelled`, `team::after_turn(.., "turn.cancelled", ..)`,
  delivery forgotten). `activation_failure_class` returns `context` for the context-exhausted
  message and `provider_unavailable` for everything else (missing runtime, `validate_spawn_target`,
  adapter resume failure, install race).
- **`failure_public_message`** adds `"provider_unavailable" => "The coding agent could not start."`.
- **`session.cancel`** arm: when `active_turns` holds the session's turn but `st.sessions` does not
  (still starting), it inserts the turn id into `starting_cancels`, sets state `cancelling`, emits and
  returns `{"cancellationRequested": true}`. The old behaviour is unchanged when a handle exists.
- **New RPC `session.warm`** (`session_warm` + a dispatch arm): returns `{"warming","active"}` at once;
  refuses (no error) archived, side, automation and busy sessions and an unusable runtime/adapter;
  returns `active: true` when already active; otherwise records the session in `warm_lru` (max 2,
  oldest evicted through the shared `close_session`) and spawns `activate_session(.., Owner::Warm)`.
  A turn removes the session from the LRU in Phase A.
- **`close_session`** is extracted from the `session.close` dispatch arm (so `session.warm` can reuse
  it without async recursion through `dispatch`); it also clears the warm LRU. `session.delete` clears
  the LRU too.
- **`ensure_session_active`** is deleted (only the old prompt path used it).

### `crates/bloblex-daemon/src/catalog.rs`

- `runtime_usable` is now `pub(crate)` so `session_warm` can reuse the same usability rule as the
  catalog prewarm (`online|ready|available|connected` and not signed out).

### `crates/bloblex-speech/src/cloud.rs`

- `warm()` wraps `lookup_host(("chatgpt.com", 443))` in a **3 second** `tokio::time::timeout`; a
  timeout reports `dns_ok: false` instead of holding the warm-up open. New test
  `warm_returns_within_five_seconds`.

### `apps/desktop/src/remote/remoteTiers.ts`

- New rule: `{ method: 'session.warm', class: 'chat', minTier: CHAT, why: 'Starts a conversation\'s
  coding agent ahead of a message.' }`. `class: 'chat'` is already denied during quiet hours by
  `authorizeRemoteCall` (it starts processes), and it is refused to an unpaired/low-tier device.

## The new state flow

```
idle/closed/error/completed
        │  session.prompt (Phase A, synchronous)
        ▼
   starting  ── user message stored, turn reserved, {accepted:true,state:"starting"} returned
        │  run_turn: activate_session(Owner::Turn)
        ├─ cancel was requested? ─────────────────► idle      (turn.cancelled)
        ├─ activation failed? ────────────────────► error     (turn.error / provider_unavailable)
        └─ activated
             ▼
          working  ── adapter.prompt(...) ──► completed | error | cancelled (existing event path)
```

A session that is already active at Phase A instead goes straight to `working` (unchanged
"live turn" behaviour). `session.warm` is the same activation without a turn: the conversation sits at
`idle` with an installed handle until a send reuses it.

## Tests added (daemon test module)

New fake `SendAdapter` (resume may block on a `Notify`; counts resumes/prompts; can fail resume) plus
helpers `install_send_adapter`, `online_rt_test`, `idle_send_session`, `wait_for_replayed`,
`wait_until`:

- `prompt_returns_accepted_before_resume_completes` — `session.prompt` returns `accepted` with state
  `starting`, the user message is saved, the resume has not returned, and after the release the
  session reaches `working` and `prompt` is called once.
- `resume_failure_becomes_turn_error` — resume fails → `turn.error` with
  `failureClass: "provider_unavailable"` and message "The coding agent could not start.", no prompt,
  state `error`, reservation released; a **side** session relays **exactly one** reply note to its
  origin and never a "could not start" note.
- `cancel_while_starting_skips_prompt` — cancel during `starting` → no `prompt`, `turn.cancelled`,
  state `idle`, handle kept installed.
- `concurrent_prompts_conflict_synchronously` — a second prompt while the first is starting conflicts.
- `delete_during_starting_conflicts` — a starting conversation cannot be deleted.
- `queue_send_claimed_requeues_on_conflict` — `queue::drain_next` requeues (not fails) while a turn is
  starting.
- `session_resume_rpc_still_conflicts_on_active_session`.
- `warm_then_prompt_resumes_once` — warm then an immediate send → one `resume_session`; the turn
  removes the session from the warm LRU.
- `warm_refuses_side_archived_busy_and_unusable`.
- `warm_lru_closes_the_oldest_idle` — warming a third closes the oldest idle warmed conversation and
  leaves two in the LRU.

## Existing tests changed (not deleted)

- `slow_adapter_preflight_does_not_block_another_sessions_event_stream` — Phase A now fetches the
  adapter by provider from `st.adapters`, so the blocking preflight adapter is installed there rather
  than only in `st.sessions`. The property it proves (a slow preflight does not block another
  conversation's event stream) is unchanged.
- `first_prompt_after_daemon_restart_lazily_resumes_before_recording_user_message` renamed to
  `restart_send_is_accepted_then_resumes_and_prompts`. **The change is the point of the fix**: the
  send is now accepted (state `starting`) and the user message is stored *before* the provider is
  resumed, so the old "resume failure leaves the composer text untouched" assertion no longer holds.
  `prepare` now also returns the event receiver; the resume-call/new-call assertions moved after the
  prompt is delivered, and the failed-resume sub-case now asserts an accepted send, one stored user
  message and a `turn.error` with `failureClass: "provider_unavailable"` instead of a rejected RPC.
- `lazy_resume_rejects_a_handle_if_a_legacy_session_lock_changes_mid_startup` — with the reservation
  made in Phase A, `session.model.update` now **conflicts** while the turn is starting (asserted), so
  the test simulates the concurrent writer with a direct `set_session_model_lock` write. The install
  guard still rejects the resumed handle (`modelLock` mismatch), which now surfaces as a
  `provider_unavailable` turn error; the message that was already stored stays, the handle is closed
  once, and the session is not left active.

## Gates (run from `C:\fx42` with the lane's `CARGO_TARGET_DIR=C:/fxtarget` and `RUST_MIN_STACK=33554432`)

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — **all green**: daemon `bitbotsd` **180 passed / 0 failed** (was 170 before this WP), `daemon_smoke`
  1, storage 92, speech 59, runtime 27, usage 19, agent-core 8, security 2, protocol 2, process 2, wsl 2,
  acp 19+28+14+4, claude 18+13+6, codex 13+33+5, opencode 0, budget 3, hook 0, doc-tests 0.
  No failures, no ignored.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — **Finished** with no warnings.
- `cd apps/desktop && npx tsc -b` — **clean** (no output).
- `cd apps/desktop && npx vitest run src/remote` — **3 files / 47 tests passed**, including
  `remoteTiers.parity.test.ts` (the new `session.warm` dispatch arm has a matching rule, and the
  method-parity, prefix-guard and stale-rule checks all still pass).

## Verified by tests vs not verified

Verified by tests (fake adapters, deterministic):

- The send returns before activation completes, the user message is saved first, and the turn then
  proceeds (`starting → working → prompt`) or fails as a turn error.
- `provider_unavailable` failure class and message; reservation release; state `error`; exactly one
  side-conversation relay note and no duplicate `relay_failure` note.
- Start-time cancel skipping the prompt and leaving the handle installed; synchronous conflicts for a
  second send and for a delete; the queue requeue-on-conflict; the `session.resume` RPC conflict.
- Warm: the refusal set, one resume shared between a warm-up and a send, the LRU (max 2, oldest idle
  closed), and the LRU drop on a turn.
- The speech `warm()` bound (returns within 5 s; the DNS step is timeout-bounded).

Not verified by tests:

- Real CLI resume timing (Claude seconds, Codex `thread/resume` up to ~30 s, OpenCode `session/load`
  up to ~20 s) and the actual "instant after a restart" feel — every test uses a fake adapter, so no
  real `claude`/`codex`/`opencode` process is started.
- The end-to-end UI benefit (composer released immediately) — that is the desktop lane's side.
- `elsewhere in the daemon:` the `run()` boot path (socket bind, discovery, prewarm) is unchanged and
  is exercised only by `daemon_smoke`.
- The `session.warm` LRU under true concurrency (a send racing an eviction) — the tests warm
  sequentially.

## Notes and deliberate choices

- **`provider_unavailable` and auto-retry.** `retry::after_failed_turn` decides from the turn's
  `hint.kind` (`overloaded`/`rateLimited`); a provider activation failure carries no hint, so it
  declines with `no_hint` and is never retried. No `retry.rs` change was needed; the class is left out
  by construction, and that is asserted indirectly by `resume_failure_becomes_turn_error`.
- **Failure detail.** `finish_activation_failure` stores `safe_provider_error_detail` of the dispatch
  message as `turn.error.detail` (first line, control chars stripped, secret markers replaced, capped
  at 240 chars) and the fixed public message as `message`. This mirrors the existing prompt-failure
  path rather than the old behaviour of returning the raw resume error to the RPC caller; no prompt
  text or provider payload is added.
- **`Owner::Rpc`.** `resume_session` is a wrapper over `activate_session(Owner::Rpc)`; the
  already-active conflict is raised inside `activate_session` for that owner so the RPC contract is
  preserved.
- **Docs table drift (not caused by this change).** `docs/remote/PROTOCOL.md`'s generated table is
  already stale against `renderTierTableMarkdown()` (it still says "blob" where the module says "bot",
  and it is missing `session.environment` and `quota.refresh`). I left `PROTOCOL.md` untouched;
  regenerating the whole table would sweep unrelated wording and belongs with the Director's docs
  pass. The module's own table (`apps/desktop/src/remote/remoteTiers.ts`) now includes
  `session.warm`.
