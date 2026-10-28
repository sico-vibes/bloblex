# Lane V2 report: explicit ambiguous sends, exhausted limited sessions

Branch `lane/v2`, worktree `D:\v2`. OpenCode lane. Owner rules obeyed: **no tests of any
kind were run, added, edited or deleted** (no `cargo test`, no `--tests`/`--all-targets`,
no `npm`, no app, no probe), **no git writes**, no other worktree or process touched, no
secrets or message content printed anywhere. The only check run was
`cargo check -p bloblex-daemon -p bloblex-storage`.

## What I could not read (stated, not guessed)

The brief points at `docs/history/t7/REPORT.md`, `report-u1-model-and-commands.md` and
`report-u3-restart-and-reads.md`. **None of them exists in this worktree**:
`docs/history/` has no `t7` directory, and a repo-wide search for both file names returns
nothing. Every claim below is therefore taken from the code in this worktree, with
`path:line`. I did not reconstruct T7 text from memory.

## Files changed (only the ones I own)

- `crates/bloblex-storage/src/lib.rs`: `watchdog_due_sessions`, `watchdog_reset`, new
  `watchdog_settle_exhausted`, new `queue_mark_failed_ambiguous`, `message_by_client_id`.
- `crates/bloblex-daemon/src/retry.rs`: `DeclineReason::DeliveryUnknown`, the auto-retry
  guard in `after_failed_turn`, the settle hook in the usage-limit branch, new
  `settle_exhausted`, `continue_on_activation`, `sweep`.
- `crates/bloblex-daemon/src/queue.rs`: `send_claimed` failure classification.
- `crates/bloblex-daemon/src/main.rs`: `DELIVERY_UNKNOWN_CODE` / `DELIVERY_UNKNOWN_MESSAGE` /
  `delivery_unknown()` / `message_delivery_unknown()` / `replay_reply()`, and the two replay
  checks inside `session_prompt_impl`.

Nothing in `delegations.rs`, `questions.rs`, `team.rs`, `proposals.rs`, `cancel_session_turn`,
`update_session_model`, `apps/`, `docs/`, `.claude/` was touched.

These four files already carried the owner's dirty baseline (the T7 wave) when the worktree was
cut, so `git status` shows them modified for both reasons; I made **no git writes** of any kind
and nothing else in `crates/`, `apps/` or `.claude/` has a write time from this session.

---

# Item 1: a failure after the prompt may have been written is explicitly ambiguous

## 1.1 Evidence: where a delivery failure can actually be seen

The prompt is **not** delivered by `session_prompt_impl`. That function is Phase A: it
validates, reserves the turn and spawns the driver (`main.rs:3444-3445`:
`tokio::spawn(async move { run_turn(state, driver).await; })`). The single adapter call is
`main.rs:3614` (`active.adapter.prompt(...)`) inside `run_turn`, and its error branch is
`3615-3638`. Therefore **no synchronous `return` of `session_prompt_impl` can happen after the
adapter's prompt was invoked**. The durable evidence the daemon keeps is on the turn:

- `delivery:"acknowledged"` — written by `AgentEvent::PromptAccepted` (`main.rs:4383-4387`),
  which also inserts the turn id into `accepted_turns` (`main.rs:89`).
- `delivery:"unknown"` — written by `finish_turn_delivery(turn_id, true)`
  (`main.rs:3894-3899`) when the turn ends and `accepted_turns` never held its id. It is called
  from `finish_turn_failed` (`main.rs:3861`), `TurnCompleted` (`4331`), `ContextExhausted`
  (`4365`), and **not** with inference from the cancelled paths (`finish_turn_cancelled`
  `2531-2540`, `TurnCancelled` `4345-4350`, which pass `false`).

### Every `return`/`?` from the reservation to the end of delivery, and its class

Phase A (`session_prompt_impl`, `main.rs:3212-3447`). All of these are **before** anything
could reach the provider, so they keep their current codes and are *definitive*:

| line | site | class |
|---|---|---|
| 3215 | `prompt_attachments(...)?` — image validation | definitive (`invalid_argument`) |
| 3217-3221 | empty/oversize text | definitive (`invalid_argument`) |
| 3226 | `client_message_id(...)?` | definitive (`invalid_argument`) |
| 3228 | `session_detail` fails | definitive (`not_found`) |
| 3229 | archived | definitive (`not_found`) |
| 3232 | side conversation, wrong origin | definitive (`read_only`) |
| 3235 | `commands::directive` | definitive (`invalid_argument`/…) |
| 3236 | `prepare_reply_snapshot` | definitive (`invalid_argument`/`not_found`) |
| 3242 | attachments unsupported for provider | definitive (`unsupported`) |
| 3250 | deleted / stale gate | definitive (`not_found`) |
| 3252 | `session_detail` fails | definitive (`not_found`) |
| 3257 | `message_by_client_id` fails | definitive (`internal`, `agent_error`) |
| 3263 | active turn | definitive (`conflict`) |
| 3266 | `limited` and not a user send | definitive (`conflict`) |
| 3269 | starting/working/cancelling/waiting_permission | definitive (`conflict`) |
| 3273 | `exec_options_for_session` | definitive |
| 3283 / 3286 | gate moved during preflight | definitive (`not_found`/`conflict`) |
| 3290-3292 | preflight rejection: `reject_exec_turn` then `Err(error)` | definitive (`unsupported`/`provider_error`) |
| 3297 / 3300 | gate moved | definitive |
| 3307 | second `message_by_client_id` | definitive |
| 3313 / 3316 | session changed while preparing | definitive (`conflict`) |
| 3321-3326 | global concurrency full | definitive (`conflict`) |
| 3327-3333 | `session_detail` | definitive (`internal`) |
| 3336-3342 | `create_reserved_turn` | definitive (`internal`) |
| 3344 | `!admitted` (daemon/agent concurrency) | definitive (`conflict`) |
| 3388-3395 | `append_message_with_data` fails (turn marked `error`; **no user message row**) | definitive (`internal`) |
| 3404 | `create_exec_snapshot` fails (turn marked `error`) | definitive (`internal`) |
| 3409-3416 | `update_session_state` fails (turn marked `error`) | definitive (`internal`) |
| 3446 | success reply `{turnId, accepted:true, state}` | — |

Phase B (`run_turn`, spawned) — the only place where delivery is at stake:

| line | site | class |
|---|---|---|
| 3469 | `activate_session` fails | pre-delivery, but recorded as `delivery:"unknown"` (see below) |
| 3475 | cancel while `starting` | pre-delivery, `finish_turn_cancelled`, no delivery key written |
| 3481 | handle missing after activation | pre-delivery, `unknown` |
| 3489 | instruction-hash read fails | pre-delivery, `unknown` |
| 3511-3557 | permission-mode relaunch path (not current/deleted/close/resume/install) | pre-delivery, `unknown`/cancelled |
| 3573 | `cancelling` before delivery | pre-delivery, no delivery key |
| 3577 | `update_session_state("working")` fails | pre-delivery, `unknown` |
| **3614** | **`adapter.prompt(...)` — the delivery point** | — |
| 3615-3616 | adapter says `TurnErrorReported` | **post-delivery**: the provider reported a turn error; the event stream owns the ending. Recorded `delivery:"unknown"` if no `PromptAccepted` arrived |
| 3636-3638 | adapter error/timeout/process death/no acceptance | **post-delivery-or-unknown**: `finish_turn_failed` → `delivery:"unknown"` unless `PromptAccepted` was seen |
| 3640 | `Ok` → `note_prompt_delivered` | delivered (`PromptAccepted` writes the positive marker) |

So the honest classification of the post-`adapter.prompt` window (`3614-3638`) is
"delivered-or-unknown", and the code's own record of it is `delivery:"unknown"`.

## 1.2 The contract I added

One error code, one sentence, 409 (same status as `confirmation_required`):

- code `delivery_unknown` (`main.rs:3167`), produced by `delivery_unknown()` (`3172-3174`)
  with `StatusCode::CONFLICT`.
- message, verbatim (`main.rs:3170`):
  `Bitbots could not confirm that the agent received this message. It may have reached the agent. Check the conversation before sending it again.`

Where it can come from: **the `clientMessageId` replay only** (`main.rs:3202`). It cannot be
returned by any Phase A failure site, because none of them is after `adapter.prompt`
(evidence above). This is the brief's own rule applied: the code cannot tell a pre-delivery
failure from a delivered prompt at that point, so it must not claim a definitive class.

### Replay rule (deterministic, both replay checks share it)

`replay_reply()` (`main.rs:3197-3210`) is used by both checks — before the active-turn
refusal (`3256-3261`) and inside the reservation gate (`3306-3312`) — so they cannot drift:

1. Same id, **different text** → `conflict`, unchanged.
2. Stored message's turn is **still running** (`starting`/`working`/`waiting_permission`/
   `cancelling`) or **completed**, or the turn row is missing → answer
   `{turnId, accepted:true, state, deduplicated:true}`, unchanged.
3. Otherwise (turn `error`, `cancelled`, any other terminal state) with `delivery` **not**
   `acknowledged` → `Err(delivery_unknown)` unless the request carries `confirmResend:true`.
4. With `confirmResend:true` → `Ok(None)`: the send proceeds as a **new turn**. The new
   message row carries the same key, and `message_by_client_id` now returns the **newest**
   row (`lib.rs:5213-5229`, `ORDER BY m.sequence DESC`), so a later replay finds the resend.

`confirmResend` is read as `p["confirmResend"].as_bool() == Some(true)` (`main.rs:3227`),
the same shape `queue::confirmed_resend` uses (`queue.rs:260-262`).

A definitive pre-delivery failure stores **no message row** (all Phase A returns are above
`append_message_with_data` at `main.rs:3387`), so a replay of such a send simply sends — that
is what the brief asked to verify and it holds for the synchronous path. It does **not** hold
for Phase B pre-delivery failures (activation), which happen after the row exists and are
written `delivery:"unknown"`; see "Ambiguous" below.

### Queue path: `queue::send_claimed`

`queue.rs:347-365`: the new code is checked **before** `conflict`, so a `delivery_unknown`
send is never requeued (a requeue is exactly the auto-replay that must not happen):

- `delivery_unknown` → `queue_mark_failed_ambiguous(id, QUEUE_AMBIGUOUS_ERROR)` and
  `mark_paused` — one storage statement writing `status='failed'`, `error=QUEUE_AMBIGUOUS_ERROR`
  and `params_json.ambiguous=true`, next to `queue_mark_failed`
  (`lib.rs:3660-3666`), reusing the constant (`lib.rs:1045-1046`) and the marker the boot
  rewrite writes (`lib.rs:5169`).
- `conflict` → `queue_requeue`, unchanged.
- everything else → `queue_mark_failed` + pause, unchanged.

Verified (read, not run):
- the drain claims only `queued`: `queue_claim_next` `WHERE ... AND status='queued'`
  (`lib.rs:3616-3628`), so a failed+ambiguous item is never auto-sent; the only other claim,
  `queue_claim`, is called only from `send_specific` (`queue.rs:302-310`) behind `send_now`;
  `queue_due_sessions` (`lib.rs:3675`) selects only `status='queued'` items;
- resending still needs `confirmResend`: `send_now` (`queue.rs:272-274`) and `update`
  (`queue.rs:206-209`) both return `confirmation_required` unless it is set; `queue_claim`
  clears the marker only then (`lib.rs:3637`);
- the item stays pausing the queue like any failure (`queue.rs:354`, `queue.rs:391-393`).

**Limit I must state exactly:** this branch is currently **unreachable in production**, since
`prompt_params` never forwards `clientMessageId` (`queue.rs:116-126`) and queue sends therefore
have no replay path and no other caller returns the code. The branch is the correct handling
should any path ever return it. The real ambiguity of a queued send is recorded on the turn,
and the queue item is already deleted by `queue_mark_sent` (`queue.rs:338`) when the turn
fails later; resurrecting it would need `run_turn`/`finish_turn_failed`, which this lane does
not own. Stated as a gap, not hidden.

## 1.3 Auto-retry never continues an ambiguous turn

`after_failed_turn` (`retry.rs:221-331`) today retries only classified hints
(`HintKind::Overloaded` / `RateLimited`, `retry.rs:30-46`), but it treated an *inferred*
overload (set for `process_error`/`timeout` by `note_failure`, `retry.rs:580-599`) as
acknowledged (`retry.rs:307`), so a crashed or timed-out turn that may
already have been delivered could still schedule `Please continue.`.

Change (`retry.rs:288-296`): if `turns.data.delivery == "unknown"` **and** the hint is a
retryable class, the decision is `DeclineReason::DeliveryUnknown` — nothing is scheduled,
no queue item is created, no provider is touched. New variant `retry.rs:86` with code
`delivery_unknown` (`retry.rs:103`) and the content-free note sentence
`the message may have reached the agent` (`retry.rs:120`); the notice is
`Not retrying automatically: the message may have reached the agent.` (`emit_decline`,
`retry.rs:345-358`), and the decision is recorded in `turns.data.retryDecision` as
`{decision:"decline", reason:"delivery_unknown"}`.

Why only retryable hints: a non-retryable class must keep its own reason, otherwise an
expired sign-in would be reported as an ambiguous send. Why the explicit marker and not
"no marker": every terminal turn the current daemon finalises gets the marker
(`finish_turn_delivery`), so absence means a legacy row or a synthetic turn, where the old
behaviour is the least surprising (and the existing retry tests seed exactly that).

Watchdog continuation: `continue_on_activation` and `sweep` queue the fixed prompt
`Continue where you left off.` that storage itself builds (`lib.rs:3428`), and the auto-retry
item carries `Please continue.` (`retry.rs:373`) — both are **new** prompts, never the original
text, so they cannot replay an ambiguous message. The transcript gets the notice
`Picking up where it left off` (`retry.rs:609`, `retry.rs:644`). I left that behaviour
unchanged and added no resend anywhere. `watchdog_enqueue` still inserts exactly one item and
never a copy of the original (`lib.rs:3429`).

## 1.4 What I left ambiguous (item 1)

- **Activation failures are classified as delivery-unknown.** `finish_activation_failure`
  (`main.rs:2518-2527`) runs before `adapter.prompt`, but `finish_turn_failed` writes
  `delivery:"unknown"` for it (`main.rs:3861` → `3894-3899`). The daemon cannot distinguish it
  from a delivered prompt **in the stored data**, and this lane may not touch `run_turn` /
  `finish_turn_failed`. Consequences, stated plainly: (a) a replay of such a message requires
  `confirmResend`; (b) an auto-retry after a provider crash at activation is now declined
  (the feature is `experimental.autoRetry`, off by default). I did not find a durable
  per-turn fact that proves "the prompt was never invoked": the session's `providerTurns`
  counter (`note_prompt_delivered`, `main.rs:3453-3459`) is per session and is only incremented
  on a successful `prompt` call, and `failure_class` for activation failures is stored as
  NULL because `provider_unavailable` is not in either whitelist (`lib.rs:5503-5507`).
- **Cancelled turns count as ambiguous on replay** (`finish_turn_cancelled` and
  `TurnCancelled` write no delivery marker), because a cancel can race a delivery and the
  code cannot tell the two apart. A resend of a cancelled message therefore needs
  `confirmResend`.
- **`TurnErrorReported`** (`main.rs:3615-3616`) is a provider-side turn error, which implies
  the prompt was received, but if `PromptAccepted` never arrived the record still says
  `unknown`; the conservative rule applies.
- The queue branch in 1.2 is unreachable today (see above).
- The boot rewrite (`lib.rs:5169`) is untouched, so a send interrupted by a daemon death
  keeps its existing marker and message text.

---

# Item 2: exhausted limited sessions stop hot re-polling and say so

## 2.1 The sweep no longer re-queries a session it can never enqueue

`watchdog_due_sessions` (`lib.rs:3381-3388`) now reads:

```
SELECT id FROM sessions
 WHERE state='limited' AND limited_until IS NOT NULL AND limited_until<=?1
   AND archived=0 AND recovery_count<3
   AND json_extract(data,'$.link.kind') IS NOT 'automation'
```

The two added conditions are exactly the ones `watchdog_enqueue` refuses on
(`lib.rs:3423`: `archived=0 AND recovery_count<3 AND json_extract(data,'$.link.kind') IS NOT
'automation' AND ...`). The cap is unchanged (`recovery_count<3`), manual resume is unchanged,
and the unattended/automation exclusion is the same expression as the enqueue's. `IS NOT`
is null-safe, so a session whose `data` has no `link` is still returned (the same semantics
the enqueue already relies on).

## 2.2 One settle, in one place, idempotent

Storage decides; the daemon only speaks.

`Storage::watchdog_settle_exhausted(id) -> bool` (`lib.rs:3401-3417`) is one conditional
UPDATE:

```
UPDATE sessions SET state='idle', limited_until=NULL, continuation_pending=0,
       data=json_set(COALESCE(NULLIF(data,''),'{}'),'$.autoContinueExhausted',json('true')),
       updated_at=?2
 WHERE id=?1 AND archived=0 AND recovery_count>=3
   AND json_extract(data,'$.link.kind') IS NOT 'automation'
   AND json_extract(data,'$.autoContinueExhausted') IS NOT 1
   AND (state='limited'
        OR (continuation_pending=1 AND state NOT IN
            ('starting','working','cancelling','waiting_permission')))
```

- `recovery_count>=3` is the mirror of the enqueue's `<3` refusal; `recovery_count` itself,
  the limits and the unattended rules are **not** changed.
- The `$autoContinueExhausted` flag is what makes a second call a no-op.
- `(state='limited' OR continuation_pending=1...)` is the brief's condition; the
  running-state guard is copied from `watchdog_enqueue` so a session with a live turn can
  never be flipped to `idle`.
- `watchdog_reset` (`lib.rs:3393-3400`) now also clears the flag with the counters, so the
  budget and the flag belong to the same episode: after a user prompt the cap applies again
  and a later exhaustion settles again.

`retry::settle_exhausted(st, sid)` (`retry.rs:618-635`) is the **only** place that acts on a
settle: it returns early when storage matched nothing, otherwise writes exactly one
content-free notice through `team::note` (`team.rs:943-949`) with the fixed sentence

`Automatic continuation stopped after 3 tries. Send a message to continue.`

and meta `{"kind":"auto_continue","status":"exhausted","tries":3}`, then emits
`session.changed` with the fresh `session_event_summary`.

Call sites (all of them):

1. **The usage-limit branch of `after_failed_turn`** (`retry.rs:244-250`): after
   `watchdog_limit` wrote `state='limited'` (and, past the cap, `limited_until=NULL` because of
   `lib.rs:3361`), the settle runs. When it settles, the branch returns **without** the
   `Limited until …` notice, so the transcript gets one notice, not two. This is the case that
   otherwise sits `limited` for ever with no date and no due row.
2. **`continue_on_activation`** (`retry.rs:604-616`): when `watchdog_enqueue(sid,false,…)`
   refuses — the silent no-op after the third restart continuation —
   `settle_exhausted` runs.
3. **`sweep`** (`retry.rs:637-653`): when `watchdog_enqueue(id,true,…)` refuses after the
   read (the cap reached between the query and the claim), the settle runs; otherwise it is a
   storage-level no-op. The sweep now does no work at all for exhausted sessions, because they
   no longer appear in `watchdog_due_sessions`.

## 2.3 Manual resume still works

- `session_prompt_impl` accepts a prompt for a settled session: the only state refusal for a
  user send is `state == "limited"` for non-user origins (`main.rs:3265`) plus the busy
  states (`3269`); the settle leaves `idle`.
- A user prompt resets the counters: `if origin == PromptOrigin::User { watchdog_reset(&sid) }`
  (`main.rs:3350`), which now also clears `autoContinueExhausted`.
- A completed turn resets them too (`main.rs:4327`, `TurnCompleted`), unchanged: the "3 tries"
  are three consecutive recovery continuations.

## 2.4 Interleaving with a concurrent user prompt

The settle is a single conditional UPDATE, so the interleaving is decided by that WHERE:

- User prompt **first** (it wins): the reservation also runs `watchdog_reset`, so
  `recovery_count=0`, `limited_until=NULL`, `continuation_pending=0` and the flag is gone.
  The settle's `recovery_count>=3` and `(state='limited' OR continuation_pending=1)` then
  match nothing → no settle, no notice, no state change. The prompt keeps the turn.
- Settle **first**: state becomes `idle`, `limited_until` and `continuation_pending` are
  cleared, one notice is written, `session.changed` is emitted; the user prompt is then
  accepted normally and resets the counters.
- Mid-turn: the running-state guard means a session whose turn is `starting`/`working`/
  `cancelling`/`waiting_permission` is never flipped to `idle` by a settle.
- Two settles at once (sweep + activation): the flag makes exactly one of them match.

## 2.5 Ambiguous / unverified in item 2

- **The brief's literal reproduction is not reachable through current code**: `watchdog_limit`
  only stores `limited_until` while `recovery_count<3` (`lib.rs:3361`), so a due row with
  `recovery_count>=3` cannot be written by this version. The filter and the settle are still
  the right defence (an older row, or a failed continuation write), and the realistic stuck
  state — the limit that arrives *after* the third recovery, leaving `limited` with no date —
  is now settled. Stated as not reproduced by running anything (no tests allowed).
- **A session that is exhausted and `offline` with `continuation_pending=1` is only settled
  when it is next activated** (`continue_on_activation`), or when another limit event arrives.
  I did not add a boot-time sweep for it, because the boot path (`main.rs:4656-4714`,
  `recover_restart_state`), is outside my files; before this change it was never settled at all.
- `data.autoContinueExhausted` is not exposed by `session_event_summary`
  (`lib.rs:6669-6682`), which lists fixed fields only; the flag is stored on the session and
  readable through `session_detail`'s session data. If the UI needs it in the summary, that is
  a separate, deliberate change.

---

# Existing tests that reference the code I changed (names only; none edited)

Storage (`crates/bloblex-storage/src/lib.rs`, `mod p8_watchdog_tests`):

- `p8_previous_database_migrates_and_recovery_is_claimed_once` (uses `watchdog_limit`,
  `watchdog_enqueue`)
- `p8_restart_arms_bounded_continuation_without_changing_saved_context` (uses
  `watchdog_enqueue`, `recover_after_restart`)
- `p8_sweep_only_sees_due_limited_sessions` (uses `watchdog_due_sessions`, `watchdog_limit`)

Daemon (`crates/bloblex-daemon/src/main.rs`):

- `p8_provider_limits_are_durable_with_the_right_reset` (usage-limit branch of
  `after_failed_turn`)
- `p8_sweep_resumes_once_and_honours_the_toggle_and_unknown_windows` (`retry::sweep`,
  `watchdog_limit`)
- `p8_permanent_refusals_win_over_a_transient_hint` (`seed_failed_turn`,
  `after_failed_turn`)
- `p8_provider_crash_drops_the_dead_handle_and_arms_activation_continuation`
  (`finish_turn_failed`, `continue_on_activation`)
- `p8_intermediate_side_recovery_does_not_relay_a_false_failure` (`after_failed_turn`)
- `p8_side_session_watchdog_item_is_sent` (`retry::sweep`)
- `p8_transient_failure_has_one_owner_and_a_three_retry_bound` (`after_failed_turn`)
- `p8_killed_turn_continues_on_activation_with_recap_after_resume_failure`
  (`continue_on_activation`)
- `disabled_automatic_retry_stays_silent` (`after_failed_turn`)
- `automatic_retry_schedules_then_sends_one_continuation` (`after_failed_turn`)
- `retry_attempt_chain_advances_and_caps` (`after_failed_turn`, `finish_turn_failed`)
- `retry_cancel_rpc_and_user_prompt_supersede_a_pending_retry` (`after_failed_turn`)
- `cancelled_turns_never_schedule_a_retry` (`after_failed_turn`)
- `a_failed_queue_item_can_be_retried_with_send_now` (`queue_mark_failed`, `send_now`)
- `retry_items_bypass_pause_and_leave_plain_items_waiting` (queue retry items)

Read-only note: I walked each of these against the new rules in the code (delivery marker they
seed, hint they send, state they expect). The two that could have been affected by the new
auto-retry guard seed `delivery:"acknowledged"` (`seed_failed_turn`, `main.rs:9121-9137`) or no
delivery fact at all, and the guard only fires on the explicit `delivery:"unknown"` marker for
retryable hints, so their expectations are unchanged. **I ran none of them**, per the owner's
rule.

The brief warned that "a storage test pins the boot error text `QUEUE_AMBIGUOUS_ERROR`". **No
such test exists in this worktree**: the only references to that constant are its definition
(`lib.rs:1045-1046`) and the boot rewrite (`lib.rs:5169`), and the only other uses of the text
are the daemon's two `confirmation_required` replies (`queue.rs:208`, `queue.rs:273`). The
constant is unchanged.

---

# Gates

`cargo check -p bloblex-daemon -p bloblex-storage`, `RUST_MIN_STACK=33554432`, from `D:\v2`.
No warnings in either run.

First run (fresh build of both crates):

```
    Checking bloblex-adapter-claude v0.1.0-beta.38 (D:\v2\crates\bloblex-adapter-claude)
    Checking bloblex-adapter-codex v0.1.0-beta.38 (D:\v2\crates\bloblex-adapter-codex)
    Checking bloblex-adapter-acp v0.1.0-beta.38 (D:\v2\crates\bloblex-adapter-acp)
    Checking sha2 v0.10.9
    Checking rustls-pemfile v2.2.0
    Checking url v2.5.8
    Checking hyper v1.11.1
    Checking tower-http v0.6.11
    Checking hyper-util v0.1.21
    Checking bloblex-storage v0.1.0-beta.38 (D:\v2\crates\bloblex-storage)
    Checking hyper-tls v0.6.0
    Checking igd-next v0.18.0
    Checking axum v0.8.9
    Checking reqwest v0.12.28
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 02s
```

Final run (both crates forced to re-check after the last edits):

```
    Checking bloblex-storage v0.1.0-beta.38 (D:\v2\crates\bloblex-storage)
    Checking bloblex-daemon v0.1.0-beta.38 (D:\v2\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 8.21s
```

(That run prints three lines; it is the whole output of the check — there were no warnings or
errors to fill the other twelve.)

---

# Decisions the brief left open, and how I resolved them

1. **`delivery_unknown` when `session_prompt_impl` cannot see the failure.** It never invokes
   the adapter, so the code is produced by the replay rule (the one place the daemon can know
   for certain), not by inventing a synchronous failure. The queue branch exists as specified
   but is currently unreachable; said so rather than faking a trigger.
2. **Same key vs superseded key on a confirmed resend.** Chose the "least invasive" option the
   brief offered: the new row keeps the same key and `message_by_client_id` returns the newest
   row. Deterministic: after the resend, a replay finds the resend; if that resend also ends
   ambiguous, another explicit `confirmResend` is needed for a third.
3. **Retry guard breadth.** Keys on the daemon's explicit `delivery:"unknown"` marker, only for
   retryable-class hints. Broader ("anything not acknowledged") would disable the transient
   retry for pre-delivery crashes and change the sign-in decline message; narrower (only
   post-delivery classes) is impossible from the stored data.
4. **One notice or two when an exhausted session hits a new limit.** One: the settle's fixed
   sentence replaces the `Limited until …` / `Limited. The provider gave no new reset time.`
   notice for the exhausted case, because there is no resume to promise.
5. **Where the settle runs.** In `retry::settle_exhausted`, called from the usage-limit branch,
   `continue_on_activation` and `sweep`; storage holds the single conditional decision. No boot
   sweep was added (outside my files).
6. **Meta kind for the settle notice.** `{"kind":"auto_continue","status":"exhausted","tries":3}`
   — the brief fixed the sentence and the session flag, not the meta.

# For the Director and the UI lane (nothing in `apps/` touched)

- `session.prompt` can now answer a *replayed* `clientMessageId` with
  `409 delivery_unknown` and the fixed sentence above; the composer would need to show that
  sentence and, if the owner then asks to send anyway, repeat the request with
  `confirmResend:true` (it is already the shape `session.queue.send_now` uses,
  `apps/desktop/src/ui/App.tsx:2115`). Read only: the composer currently mints a fresh
  `clientMessageId` per send (`apps/desktop/src/ui/App.tsx:1928`, `:2446`), so this reply is
  reachable today only when a request is retried with its original key.
- A settled exhausted session is `idle` with `data.autoContinueExhausted=true`; the flag is
  not in `session_event_summary`, so a banner would need it added deliberately (not done here).
- The queue's ambiguous item keeps its existing UI contract: `ambiguous:true` plus
  `error=QUEUE_AMBIGUOUS_ERROR`, and `confirmResend:true` to resend (`PromptQueue.tsx:18`,
  `:131`). Unchanged.

# Skill update proposal (`.claude/` is outside this lane's files)

For `references/lessons.md`, a dated entry: *"2026-10-27 — 'a send may have reached the agent'
is not visible in Phase A. `session_prompt_impl` (`main.rs`:3212) only reserves and spawns;
`adapter.prompt` is `main.rs`:3614 in `run_turn`. The durable record is `turns.data.delivery`
(`acknowledged` from `PromptAccepted`, `unknown` from `finish_turn_delivery`), and activation
failures also record `unknown` because they finalise through `finish_turn_failed`. Any
ambiguity rule must read the turn, not the RPC reply."*
For `references/codebase-map.md`, in the T7 paragraph: `delivery_unknown` (409,
`main.rs`:3167) plus the `message_by_client_id` turn join and newest-row rule, and
`watchdog_settle_exhausted` / `retry::settle_exhausted` as the single exhaustion settle.
