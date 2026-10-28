# Lane U1 report: honest model switching and idempotent session commands

Worktree `D:\u1`, branch `lane/u1`. No tests were run, compiled or edited; no git
writes were made. Production `cargo check` only.

## Item A: model switching uses what each provider can really do

### A1. Capability on the adapter trait

- `crates/bloblex-agent-core/src/lib.rs:1232-1244`: new `ModelSwitch` enum
  (`KeepsSession`, `NewSession`), serde `camelCase` (`keepsSession` /
  `newSession`), `as_str()`, `Default = NewSession`.
- `crates/bloblex-agent-core/src/lib.rs:1246-1251`: `AgentAdapter::model_switch()`
  default method returning `NewSession`. Doc comment says why: only a proven
  provider may claim it keeps the session.

Overrides, each with the proof in a comment:

| Adapter | Line | Value | Proof in the code |
|---|---|---|---|
| Codex | `crates/bloblex-adapter-codex/src/lib.rs:1359-1362` | `KeepsSession` | `prompt` (1542-1618) sends `p["model"]` and `p["effort"]` in every `turn/start` for the live `threadId` (1565-1568); a model change is just a different value for the same thread. |
| Claude | `crates/bloblex-adapter-claude/src/lib.rs:986-988` | `KeepsSession` | `prompt` (1155-1193) compares `launch_options` (including `model`, 1168) with the request, then kills the process and restarts with `provider_id` (`--resume`, 1177-1193) and the new options (`typed_args` emits `--model`, 203-205). The same provider session carries on. |
| ACP | `crates/bloblex-adapter-acp/src/lib.rs:1026-1028` | `KeepsSession` | `apply_options` selects the agent's `model` config option before each prompt when it differs from `c.applied.model` (836-850), and refuses with `ERR_MODEL_MISSING` / `ERR_MODEL_REJECTED` instead of prompting. |
| OpenCode | no edit | inherits ACP | `crates/bloblex-adapter-opencode/src/lib.rs:3` is `pub use bloblex_adapter_acp::AcpAdapter as OpenCodeAdapter;` — the same type, so the ACP override is the OpenCode answer. There is no separate impl to override. |

Everything else (test fakes, future adapters) keeps `NewSession`.

### A2. Read-only `session.model.plan`

- Dispatch arm: `crates/bloblex-daemon/src/main.rs:1178-1181`, next to
  `session.model.update`.
- Implementation: `crates/bloblex-daemon/src/main.rs:2870-2897`.
- Shared predicates: `session_model_facts` (2652-2670), `keeps_provider_session`
  (2682-2688), `model_switch_for` (2675-2677), `model_continuity_reason`
  (2690-2702). `update_session_model` calls the same three helpers
  (2751-2773, 2836-2840), so the preview and the write cannot disagree.
- No writes, no events, no gate, so it is allowed while a turn is live. It reads
  the session row, the agent lock flag, the prompt table and, when there is no
  lock, the effective blob options.

Contract (details in "Contracts" below).

### A3. `update_session_model` uses the capability

`crates/bloblex-daemon/src/main.rs:2703-2861`.

- `keeps_session = model_changed && providerSessionId present &&
  adapter.model_switch() == KeepsSession` (2772, helper at 2682).
- `context_at_risk` now excludes that case (2773), so a keep-session change never
  asks for `confirmModelChange`.
- On keep-session: the provider id is not cleared, the live handle stays in
  `st.sessions`, no `session.context.reset`, no `knowledge::announce_model_change`
  (the Manager handover stays new-session only, 2852-2855). Only the lock is
  written (2837-2843).
- On new-session: today's behaviour is unchanged (confirmation, atomic clear,
  reset event, handover/recap, handle close, retry cancel).
- The reply gains `contextKept` (2860): true only when a model change actually
  kept the provider session.

Failure honesty (what I found by reading, not by running):

- `session_prompt_impl` never retries a model refusal with another model. A
  preflight refusal is recorded as a rejected turn and returned
  (`main.rs:3227-3240`); an adapter refusal on delivery finalises that turn as an
  error (`main.rs:3552-3580`). `retry.rs` contains no model logic at all
  (`rg -n model crates/bloblex-daemon/src/retry.rs` → no match) and its retry
  item carries only `text`, so an automatic retry re-reads the same lock.
- ACP returns `ERR_MODEL_MISSING` / `ERR_MODEL_REJECTED` before prompting
  (`adapter-acp/src/lib.rs:836-850`). Claude returns
  `AdapterError::Unsupported("Claude could not resume/start ... after changing
  model: ...")` (1177-1193). Codex passes the model to `turn/start` and the
  provider's error surfaces through the normal turn error. No adapter, and no
  daemon path, silently falls back to a fresh session or a different model.
- The one relaunch path in `run_turn` (`main.rs:3293-3362`) triggers only when
  the *approval mode* differs; its resume keeps the same provider id. It is not
  a model fallback.

### A4. Atomic persistence

- `crates/bloblex-storage/src/lib.rs:2870-2897`: `session_apply_model_change(id,
  &lock, clear_provider)`. One `IMMEDIATE` transaction writes `model_lock_json`
  and, when `clear_provider` is true, also
  `provider_session_id=NULL, resumable=0, data.providerTurns=0` (the exact
  effects of `clear_session_provider_id`, 4739-4748). It returns the session
  summary read inside the transaction; a missing session is `AgentNotFound`.
- Used only by `update_session_model` (`main.rs:2840`). `set_session_model_lock`
  is untouched and still used by the other callers.

### A5. Stale updates

`main.rs:2759-2768`. Optional `expectedModel` (string or null):

- compared to `facts.previous_model`, the same value the update uses for
  `modelChanged` (the lock's model, or the effective model when there is no
  lock);
- mismatch → `conflict` / `This conversation's model changed elsewhere. Reload it and choose again.` / 409, **before** any write;
- absent → today's behaviour; null means "there must be no pinned model";
- anything else → `invalid_argument` / `expectedModel must be a model identifier or null`;
- the whole check runs under the per-session prompt gate taken at function entry
  (`main.rs:2706-2712`).

### A6. Idempotent repeats

- `lock_changed = lock != previous` (`main.rs:2836`). When the rebuilt lock
  equals the stored one nothing is written; the reply is built from
  `session_event_summary` (2837-2843).
- `modelChanged:false` replies therefore always carry the current session
  summary. No provider id is cleared, no reset is emitted and no handover is
  announced for a repeat (guards at 2844-2855).
- One deliberate side effect remains on a repeat: `retry::cancel_pending` at
  2859, exactly as before; it is not a context change.

### A7. Pending queued work

Verified by reading: queued items store only the prompt body
(`queue.rs:100-112, 114-125` `allowlisted_params` / `prompt_params`) and never an
`exec_options` snapshot. `send_claimed` (`queue.rs:295-329`) rebuilds a
`session.prompt` request, and `session_prompt_impl` computes
`exec_options_for_session` from the *current* row and `modelLock` at that moment
(`main.rs:3223`, `exec_options_for_session` 1491-1526). So every pending or
scheduled item runs on the model that is pinned when it is sent, including a
model changed after it was queued. No fix was needed.

## Item B: idempotent `session.prompt` and `session.queue.add`

### B1. Accepted key

`main.rs:3049-3054`: `client_message_id(&Value) -> Result<Option<String>, _>` —
absent/null → `None`; a string of 8 to 80 bytes of `[A-Za-z0-9_-]` → the key;
anything else → `invalid_argument` / `clientMessageId must be 8 to 80 characters of letters, digits, hyphens or underscores.`

Used by `session.prompt` (`main.rs:3176`) and `session.queue.add`
(`queue.rs:161`). Every other prompt origin (team, queue, automation, question
answer, task) has no key in its request, so nothing changes for them.

### B2. Durable storage

- Prompt: `meta.clientMessageId` on the user message (`main.rs:3317-3325`).
- Queue: `params_json.clientMessageId` on the queued item (`queue.rs:98-103`).
- Lookups: `message_by_client_id` (`storage/lib.rs:4850-4867`) and
  `queue_item_by_client_id` (`storage/lib.rs:3263-3271`).
- Indexes: expression indexes `idx_messages_client_id` and
  `idx_queued_prompts_client_id` (`storage/lib.rs:513-520`), created on every
  open by the additive, idempotent `ensure_client_message_id_indexes`, called
  from `migrate` (`storage/lib.rs:1827`). No `user_version` bump; no table
  change.

### B3. Replay rule

- Prompt: two checks under the same per-session gate — before the active-turn
  refusal (`main.rs:3202-3212`, so a resend while the original turn still runs
  is answered), and again inside the admission gate before the message is
  stored (`main.rs:3252-3262`, which closes the two-concurrent-sends race
  because the message row is written inside that same gate). Found and text
  equal → original `turnId` + `accepted:true` + current `state` +
  `deduplicated:true`; no second turn, no new message, no event. Different text
  under the same key → `conflict` / `This message id was already used for a different message.` / 409.
- Queue: lookup and insert share the per-session prompt gate
  (`queue.rs:163-184`). Found and text equal → `{"item": existing, "deduplicated": true}`;
  different text → the same `conflict`.

### B4. Logging

Nothing is logged on either path; the key is only stored in the message meta or
the queue params. It never appears with message text in a log line.

### B5. `session.steer`

Deliberately not idempotent: a steer is added to a live turn, so a replay could
append the same text twice to a running provider turn. No key is accepted there.

## Contracts

### `session.model.plan` (new, read-only)

Params:

- `sessionId` (string, required) → `invalid_argument` / `sessionId is required`
- `model` (string, required, non-empty; trimmed) → `invalid_argument` /
  `Choose a concrete model. Conversation model selections cannot be unset.`
  (same sentence the update uses for null)

Reply `200`:

```json
{"ok":true,"sessionId":"...","provider":"codex","currentModel":"gpt-6"|null,
 "nextModel":"gpt-6.1","modelChanged":true,
 "busy":false,"locked":false,"contextAtRisk":false,
 "continuity":"kept"|"recap"|"none","hasHistory":true,"reason":"..."}
```

- `busy` = a turn is in `active_turns`, or the stored state is not one of
  `idle|closed|error|completed`.
- `locked` = the locked-bot rule for a model touch (the bot is locked).
- `hasHistory` = a provider session id, context usage/model, provider turns or
  user messages exist.
- `contextAtRisk` = `modelChanged && hasHistory && !keeps_session` — exactly when
  `session.model.update` would demand `confirmModelChange`.
- `continuity`: `none` when the model is unchanged or there is no history;
  `kept` when the adapter proves `KeepsSession` and a provider session exists;
  `recap` otherwise.
- `reason` sentence per outcome:
  - Codex kept: `Codex keeps this thread and runs your next message on the new model.`
  - Claude kept: `Claude Code restarts and resumes this chat on the new model.`
  - OpenCode kept: `OpenCode switches this chat to the new model before your next message.`
  - other kept: `This chat carries on with the new model from your next message.`
  - recap: `This runtime cannot switch models inside a chat, so the new model starts a fresh session and is given a short summary of the conversation; it will not have the full working memory.`
  - unchanged: `This conversation already uses this model.`
  - no history: `There is no conversation context to lose, so the new model starts a fresh provider session.`

Errors: `invalid_argument` (above), `not_found` / `session not found` (deleted),
`not_found` / `Conversation not found.` (unknown id). No events, no writes.

### `session.model.update` (changed)

Params unchanged (`sessionId`, optional `model`, `thinking`, `serviceTier`,
`planMode`, `approvalMode`, `confirmModelChange`) plus:

- `expectedModel` (string or null, optional) — see A5.

Reply `200`: `{"session": <summary>, "modelChanged": bool, "contextKept": bool}`.
`contextKept` is new and is true only when the model changed and the provider
session was kept. New error code use: `conflict` /
`This conversation's model changed elsewhere. Reload it and choose again.` when
`expectedModel` mismatches; `invalid_argument` for a non-string/non-null
`expectedModel`. All other codes, messages and the confirmation sentence are
unchanged.

### `session.prompt` (changed)

New optional param `clientMessageId` (string, 8-80, `[A-Za-z0-9_-]`). Reply
unchanged when there is no key. On a replay the reply is
`{"turnId": <original turn id>, "accepted": true, "state": <current state>,
"deduplicated": true}`. Errors: `invalid_argument` (bad key), `conflict` /
`This message id was already used for a different message.` (same key, different
text). Message meta gains `meta.clientMessageId` on the stored user message.

### `session.queue.add` (changed)

New optional param `clientMessageId`, same validation. Reply
`{"item": <queued item DTO>}` as before, plus `"deduplicated": true` on a replay
(the existing item is returned even if it was already sent or failed). Same
`conflict` message for a different text under the same key.

## Decisions the brief did not specify

1. `clientMessageId` is scoped per conversation: the same key in another
   conversation is independent (lookups take `session_id`).
2. Only the text is compared on replay. Different attachments, conversation
   references, command or reply target under the same key are not treated as a
   conflict (the brief names text). Documented so the Director can tighten it.
3. A replayed prompt whose original turn later failed still returns
   `accepted:true` with the original turn id (it reports the first request's
   admission, which is what a command receipt does); `state` is the session's
   state now, so the UI can see it is no longer working.
4. The queue stores the key but does not forward it when the item is later sent
   as a prompt (`prompt_params`, `queue.rs:114-125`, is unchanged and the brief
   scopes `queue.rs` to `add`). Replaying the *add* is deduplicated; replaying
   the *send* of a queued item is not (queue claims already make sends
   once-only).
5. `session.model.plan` requires a concrete model; it does not treat null or a
   missing model as "current model", because the preview is about a choice.
6. The plan does not validate the model against the provider catalog: it is
   read-only and cheap, and the update's own preflight stays authoritative.
7. The plan's `locked` is the locked-bot rule for a model touch regardless of
   whether the model would actually change (the update also refuses then).
8. `contextKept` is true only when a model change happened and the provider
   session was kept; an effort-only or repeated update returns false.
9. `session.queue.add` now takes the per-session prompt gate around
   lookup + full-check + insert (previously it took no gate) to make two
   identical adds impossible. It can briefly wait behind prompt admission.
10. New indexes are SQLite expression indexes over the JSON paths, created in an
    additive `ensure_*` on every open.
11. A deduplicated prompt still goes through the dispatch-level
    `retry::cancel_pending` (`main.rs:1184-1188`) because that happens before
    the prompt function; a replayed send can therefore cancel a pending
    automatic retry. This is the pre-existing behaviour of any user send.

## Existing tests that reference what changed (names only; none were run)

Compiled-behaviour risk is low: every test fake adapter implements
`AgentAdapter` without `model_switch`, so it gets the `NewSession` default and
the old update behaviour. Tests that call the changed APIs:

`crates/bloblex-daemon/src/main.rs`
(`#[cfg(test)] mod tests`):

- `model_confirmation_is_asked_only_when_context_can_be_lost`
- `session_model_lock_requires_confirmation_and_survives_agent_default_changes`
- `session_lock_pins_speed_and_permission_mode_without_a_model_change`
- `model_effort_speed_updates_preserve_captured_claude_workflow_setting`
- `a_manager_handover_is_delivered_once_and_announced`
- `row_session_model_update_refuses_a_locked_bot`
- `row_locked_bot_keeps_plan_mode_but_refuses_a_settings_write`
- `row_setting_a_pin_keeps_the_rest_of_an_existing_lock`
- `row_composer_writes_the_bot_so_a_new_conversation_inherits_it`
- `lazy_resume_rejects_a_handle_if_a_legacy_session_lock_changes_mid_startup`
- `restart_send_is_accepted_then_resumes_and_prompts`

Plus the queue/prompt behaviour tests that call `session.queue.add` or
`session.prompt` without a key (unchanged path), including
`a_due_item_precedes_plain_items_at_the_next_completed_turn`,
`due_scheduled_items_bypass_pause_and_report_lateness`,
`restart_drops_only_overdue_retries`,
`restart_with_the_feature_off_drops_pending_retries_silently` and
`reply_prompt_is_session_scoped_data_and_persists_a_bounded_snapshot`.

`crates/bloblex-storage/src/lib.rs`:

- `provider_session_pointer_clears_only_when_explicitly_requested`
- `queued_prompts_order_reorder_update_and_delete_follow_state_rules`
- `session_delete_cascades_the_prompt_queue_and_restart_fails_interrupted_sends`
- `v10_model_lock_migration_preserves_sessions_and_accepts_session_lock_updates`
- `message_reactions_and_reply_sources_are_scoped_and_persisted`
- `a_delegation_notice_sits_above_the_text_its_turn_already_streamed`
- `non_delegation_notices_keep_a_single_assistant_row`

`crates/bloblex-daemon/src/queue.rs` has no test module. No test, fixture or
`#[cfg(test)]` code was added, edited or deleted.

## Could not make safe / unverified

1. **Remote tier parity (needs the Director).** `session.model.plan` is a new
   dispatch arm, and `apps/desktop/src/remote/tiers.json` (out of bounds for
   this lane) has no row for it. `apps/desktop/src/remote/remoteTiers.parity.test.ts`
   ("gives every dispatched method a rule", reads `main.rs` at test time) will
   fail until a row is added. At runtime the daemon's
   `policy::rule_for` denies a method with no rule, so remote cannot call it and
   there is no security hole; local calls are unaffected. Suggested row:
   `{"method":"session.model.plan","class":"read","minTier":"viewer","why":"Previews a model change without writing anything.","params":null}`
   — or `"class":"never"` if remote should not preview at all.
2. **Expression indexes are unrun.** Tests were banned, so nothing opened a
   database with the new `ensure_client_message_id_indexes`. It compiles, and
   SQLite supports expression indexes with the deterministic `json_extract`
   (3.9+), but if the bundled SQLite rejected it the daemon would fail at open.
   This is the one thing I could not execute.
3. **UI does not send the key yet.** `apps/` is out of bounds; `deliverPendingSend`
   and `sendWithDelivery` are unchanged. The daemon accepts the key and behaves
   exactly as today when it is absent, so the feature is dormant until the UI
   generates one.
4. **No behaviour was observed at runtime** (no app, no probe, no test). Every
   statement above is read from the code.
5. `session.prompt` dedupe compares text only, as decided in "Decisions" item 2.

## Gate

`cargo check` (production targets only; no `--tests`), packages
`bloblex-daemon bloblex-storage bloblex-agent-core bloblex-adapter-claude
bloblex-adapter-codex bloblex-adapter-acp bloblex-adapter-opencode`
(`RUST_MIN_STACK=33554432`), 0 warnings. Tail of the final run:

```
    Checking bloblex-agent-core v0.1.0 (D:\u1\crates\bloblex-agent-core)
    Checking bloblex-storage v0.1.0-beta.38 (D:\u1\crates\bloblex-storage)
    Checking bloblex-adapter-claude v0.1.0-beta.38 (D:\u1\crates\bloblex-adapter-claude)
    Checking bloblex-adapter-acp v0.1.0-beta.38 (D:\u1\crates\bloblex-adapter-acp)
    Checking bloblex-adapter-codex v0.1.0-beta.38 (D:\u1\crates\bloblex-adapter-codex)
    Checking bloblex-daemon v0.1.0-beta.38 (D:\u1\crates\bloblex-daemon)
    Checking bloblex-adapter-opencode v0.1.0-beta.38 (D:\u1\crates\bloblex-adapter-opencode)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.47s
```

`bloblex-adapter-opencode` was added to the brief's list because OpenCode is the
one provider whose answer had to be derived from another crate; it is a
production check, not a test. The full log is `target/lane/cargo-check.log`.

## Proposed skill update (not edited here: the brief limits the files this lane owns)

Add to `.claude/skills/bitbots-development/references/codebase-map.md` (daemon
RPC area), one short entry:

> **Model switch capability.** `AgentAdapter::model_switch()` in
> `crates/bloblex-agent-core/src/lib.rs` says whether a provider applies a new
> model inside the same provider session (`KeepsSession`: Codex, Claude, ACP and
> OpenCode) or needs a fresh one (default). `session.model.plan` previews the
> outcome (`kept` / `recap` / `none`) with the same predicates
> `session.model.update` acts on; a keep-session update writes only the lock and
> never resets context. Replay-safe sends take an optional `clientMessageId`
> (8-80 `[A-Za-z0-9_-]`), stored in `meta.clientMessageId` (messages) or
> `params_json.clientMessageId` (queue) and served by two expression indexes.

And a lesson entry (dated 2026-10-27, branch `lane/u1`):

> Adding a daemon dispatch arm also means a row in
> `apps/desktop/src/remote/tiers.json`; `remoteTiers.parity.test.ts` reads
> `main.rs` and fails without one. Remote denies an unknown method at runtime,
> so the failure is loud in CI, not silent in production.
