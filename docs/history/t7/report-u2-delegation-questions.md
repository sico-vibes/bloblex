# Lane U2 report — assignments stay on their own turn, questions cannot cross assignments

Worktree `D:\u2` (branch `lane/u2`), OpenCode lane. **No test of any kind was run** (no
`cargo test`, `cargo check --tests`, `cargo clippy --all-targets`, `npm test`, vitest, app,
browser, probe or screenshot). **No test file, `#[cfg(test)]` block or test module was added,
edited or deleted.** **No git write was made** (no commit, add, stash, reset, checkout,
rebase, push, branch); `git status` was only read. Nothing outside `D:\u2` was touched and no
running process was signalled. All log/notice/event text added carries ids, counts, names and
short titles only — never message, question, option or answer text.

Files changed: `crates/bloblex-daemon/src/delegations.rs` (untracked/new in this worktree —
see "Reading the diff"), `questions.rs`, `team.rs`, `proposals.rs`, the
`AgentEvent::QuestionRequested` branch and one `permission.reply` line in `main.rs`, and the
question/delegation/`permission_requests` helpers + `ensure_delegation_schema` in
`crates/bloblex-storage/src/lib.rs`. `queue.rs`, `retry.rs`, `tasks.rs`, `update_session_model`,
`session_prompt_impl`, adapters, `apps/` and `docs/` are untouched.

## Reading the diff

`crates/bloblex-daemon/src/delegations.rs` is **untracked** in this worktree (it exists with
the t6 patch but was never added), so `git diff` does not show it. Read it as a whole file.
`team.rs`, `questions.rs`, `proposals.rs`, `main.rs` and `bloblex-storage/src/lib.rs` show as
modified against `HEAD`, and those diffs contain the t6 patch as well as this lane's work.

---

## Item 1 — independent review of the t6 patch, then what I fixed

### 1.1 `after_turn`'s live-turn guard could swallow a failure — **found, fixed**

t6 returned `Waiting` at the top of `after_turn` whenever *any* other turn of the conversation
was live (`delegations.rs:242` before this lane). That is wider than the case it was written
for. Traced interleaving (all reads, no run):

1. Manager turn delegates **A** and **B** to one teammate, so both rows share one side
   conversation. A's turn `T_A` fails. `team::team::after_turn` spawns the hook
   (`team.rs:1003-1011`), so it runs as its own task.
2. `queue::after_turn` (same spawn, after the delegation hook) / the drain delivers B's brief
   within the hook's own startup latency; B's prompt is accepted, `T_B` becomes the
   conversation's live turn (`st.active_turns`).
3. A's hook now runs: `active_turn != Some(T_A)` → t6 returned `Waiting`, so A was neither
   finished nor relayed, and **nothing else ever ends A** — `T_B`'s end matches B's row
   exactly. The Manager never learns A failed. The row stays `running` until a restart.
4. With a retry the same shape appears: the retry turn `T2` is created by the queue item
   (`retry.rs:342-364` `schedule` → `queue_add(... "retry", due_at)`; it is not started by
   `after_failed_turn`), so between `T_A`'s end and `T2`'s start the guard can see an
   unrelated live turn and swallow the failure that `retry_dropped` would otherwise report.

Fix: the guard is now only the case it was written for — the live turn is the **answer to this
assignment's own question** (`delegations.rs:294-303`, `answer_continues_row` at
`delegations.rs:386-402`). It resolves the row that owns the *ending* turn, reads the live
turn's `question_answer` message, takes its `questionId`, and compares the card's stored
`delegationId` with that row (legacy card: single-open-assignment rule). Any other live turn
(B's brief, a retry) lets the ending be judged on its own turn: `owns`/`turn_is_newer` below still
return `Waiting` for a genuinely older ending, and the failure now finishes the row and relays.

Retry trace to the point where the retry turn is created: `retry::after_failed_turn`
(`retry.rs:216`) records `retryDecision` into the turn's data (`record_decision`, `retry.rs:318`)
and, on `Decision::Retry`, calls `schedule` (`retry.rs:307`), which adds a durable queue item
with `meta.kind = "auto_retry"` and a `due_at`. The turn itself starts later, when the queue
drains that item (`queue.rs:279-280` → `session_prompt_queued`). Until then **no turn is live**,
so the narrowed guard cannot fire on `T_A`; and if the item is cancelled,
`retry::cancel_pending` (`retry.rs:433`) calls `delegations::retry_dropped`, which now finds
the row (`delegations.rs:461-473`) and reports it failed **and relays the failure** (see
item 3/4.4). Verdict: not swallowed any more.

### 1.2 `answer_started` cannot cross assignments; the spawned adopt could move back — **confirmed, hardened**

* *Can it run for a card with a different `delegationId`?* No. The hook at `main.rs:3236-3244`
  reads `p["meta"]["questionId"]`, and the only producers of that meta are
  `questions::deliver_answer` (`questions.rs:377-384`), which is called from
  `reply_mcp_question` and `sweep`, and the queue item that `deliver_answer` writes. The meta
  survives only for `PromptOrigin::QuestionAnswer` (`sanitize_prompt_meta`, `main.rs:2967-2973`),
  and that origin is reachable only through `session_prompt_for_question_answer`
  (`main.rs:3013`), called from `deliver_answer` and `queue::send_claimed` (`queue.rs:280`).
  `session.queue.add` cannot inject it: `allowlisted_params` (`queue.rs:98-108`) never copies
  `meta`, and `add` refuses side conversations (`queue.rs:144`). The delegation id is then read
  from the card itself (`main.rs:3238`), never from the request.
* *Can the spawned `adopt` overwrite a newer `sideTurnId`?* **Yes, it could.** The storage guard
  is `WHERE id=?1 AND status IN ('queued','running')` (`bloblex-storage/src/lib.rs:3679-3692`),
  which compares nothing about the turn: a delayed `answer_started` task for `T_a1` could land
  after the answer `T_a2` was adopted and set `side_turn_id` back to `T_a1`. Consequence was
  benign (the `turn_is_newer` rule recovers at `T_a2`'s end) but the stored state lied.
  Hardened in `adopt` (`delegations.rs:111-121`): if the row already carries a different turn,
  the adoption is skipped unless the new turn is newer in the conversation's stored turn order
  (`turn_is_newer`, `delegations.rs:411-418`). Idempotent: same turn → no change, no emit.

### 1.3 `resolving` held a row for ever — **found, fixed**

`permission_requests` stores no resolving timestamp; `begin_permission_reply` only wrote
`status='resolving'` and a `choice` inside `data` (`bloblex-storage/src/lib.rs:5441-5451`).
Fix, all additive inside the card's JSON (no table migration):

* `begin_permission_reply` now also stamps `data.resolvingAt` (RFC3339 millis) in the same
  transaction (`bloblex-storage/src/lib.rs:5450-5453`).
* `question_holds_open` counts `resolving` only while `resolvingAt >= now - 2 min`, or when the
  field is absent (a card claimed by an older build, treated as old for the same reason)
  (`bloblex-storage/src/lib.rs:2455-2472`, constant `QUESTION_RESOLVING_HOLD` at 1093).
* `question_expire_stalled` (`bloblex-storage/src/lib.rs:2477-2494`) moves such cards to
  `expired` with `data.resolution = "answer_stalled"` and removes `choice`; `questions::sweep`
  (`questions.rs:260-267`) runs it next to `expire_due_questions` and then reuses the existing
  expiry path: `permission.resolved` (`status:"expired"`), the content-free notice, and — in a
  side conversation whose assignment is `running` — the `EXPIRED_PROMPT` follow-up turn with
  `answer_pending` set, so the assignment gets a turn that can end it.
* Bound chosen: **2 minutes**. The claim and the resolve are two statements in one reply path;
  anything older than two minutes is not a live reply but a lost one, and two minutes is far
  below the 30-minute answer hold so an owner can simply answer again in the same session.

### 1.4 Two assignments, two pending questions, cancel one and answer the other — **verified, no code change**

State can hold two `running` rows at once even with one live turn, because a row stays `running`
on its ended question turn while the other row runs a turn. Walked both orders through the code:

*Order "answer B, then cancel A":* `reply_mcp_question(B card)` → the card's own stored
`delegationId` is B; `question_row` returns B, `is_terminal(B)` false (`questions.rs:317-319`);
`resolve_question` then `question_mark_answer_pending(B_card, true)` (`questions.rs:344-346`);
`deliver_answer` prompts at once (idle) → `answer_started(st, B, T_a, B_card)` clears the flag and
adopts `T_a` on B (`delegations.rs:441-458`); `question_resolved(..., "answered")` names B
(`delegations.rs:248-255`). `T_a` ends → `after_turn` finds B by `T_a`, `owns`, no hold on B →
`finish(B, completed)` → reply claimed and relayed once (`team.rs:1027-1049`). A is untouched:
its card, its row and its `wake_request` are not in any id list of that path.
Then `cancel_row(A)`: `waiting` true (its own card), `close_pending_questions(A, side)` sees
`other_open == false` (B is terminal) and closes only `pending_questions_for_delegation(A)`
(`delegations.rs:156-174`), then A finishes `cancelled` and its reply is relayed once
(`delegations.rs:205-227`, `822-826`).

*Order "cancel A, then answer B":* `other_open` is true (B is `running`), so only A's linked
cards are closed — B's card is not in A's list and is left `pending`; A's reply goes out once.
The answer to B then takes exactly the path above. Each row ends once, each with its own reply,
and `question_holds_open` only ever sees its own delegation id
(`bloblex-storage/src/lib.rs:2463-2472`).

The dangerous middle case also closes: if A's question turn ends *after* B's answer turn
started, `answer_continues_row` compares B's card to A's row and returns false, so A's ending is
still evaluated — its own card is `pending` (`mcp:`), so it stays `Waiting` (1.1's fix does not
break 1.4).

### 1.5 "Answer pending" could be set with nothing that clears it — **found in two places, both closed**

1. **`deliver_answer` failing at both paths.** It marks the flag *before* delivering
   (`questions.rs:344-346` in `reply_mcp_question`, `questions.rs:280-281` in `sweep`). If the
   prompt is refused and `queue_add_front` also fails, nothing would ever start that turn.
   Fixed: the flag is cleared on that failure (`questions.rs:377-392`).
2. **The queue item deleted while the child is idle.** Nothing starts a turn, no turn end comes,
   and the 30-minute bound is only *evaluated* at a turn end or a restart — so the assignment
   could stay `running` for ever, and every later turn end of that conversation stayed silent
   while the flag was set. Fixed with a periodic reconciliation in the sweep:
   `question_pending_answers` (`bloblex-storage/src/lib.rs:2495-2505`) lists answer-pending cards
   older than 2 minutes, and `release_dropped_answers` (`questions.rs:295-309`) skips any card
   that still has a queued answer (`queue_has_question_answer`) or a live turn, and hands the
   rest to `delegations::dropped_answer` (`delegations.rs:508-521`), which clears the flag,
   re-checks the *other* cards of that assignment, and — when its own turn already has an
   outcome — finishes the assignment with that outcome and relays its reply once.

---

## Item 2 — native provider questions get the same assignment link

**Found and fixed** (`main.rs:4287-4308`). The `AgentEvent::QuestionRequested` branch now, after
`insert_question`:

1. resolves the owner with `delegations::question_owner_row` — the live turn's row, else the
   single `running` row — and writes `question_set_delegation`, exactly as `ask_user_tool`
   does (`questions.rs:144-148`); a storage failure leaves the card unlinked rather than
   failing the turn;
2. spawns `delegations::attention(..., "question", &title)` — **this wake did not exist at all**
   for native cards before, so a delegated Claude/Codex question never reached the Manager;
3. the card keeps its existing `permission.requested` payload, so the UI is unchanged.

`question_resolved` now reports for native cards too: the native answer path is
`permission.reply` → `active.adapter.answer_question(provider_id, ...)` (`main.rs:1235-1243`),
which **starts no new turn** — the provider continues the same turn. So no `answer_pending` and
no hold is created for a native answer, and consistency on the read side is enforced in
`question_holds_open`: a `pending` card holds only when it is an `ask_user` card
(`provider_request_id LIKE 'mcp:%'`); a pending *native* card cannot be answered once the turn it
was asked in has ended, so it no longer holds the assignment (`bloblex-storage/src/lib.rs:2455-2472`).
The one added line at `main.rs:1263` writes the same content-free `question_resolved` notice for a
native answer that `reply_mcp_question` writes for an `ask_user` one.

---

## Item 3 — `retry_dropped` and the assignment's turn list

**Found, fixed.** `delegations` rows now keep `turn_ids` (JSON array, additive column), appended
idempotently by `delegation_mark_running` alongside `side_turn_id`
(`bloblex-storage/src/lib.rs:3679-3692`). `delegation_open_rows_for_turn`
(`bloblex-storage/src/lib.rs:3725-3734`) returns the open rows whose *current* turn or any
earlier turn is the given one. `retry_dropped` (`delegations.rs:461-473`) acts only when there is
exactly one such row (`let [row] = rows.as_slice() else { return }`), never when two open rows
could own it, skips a row whose current turn is the live one, then finishes it `failed` and
relays that failure once (`relay_stopped`). Idempotent: `delegation_mark_terminal` only moves
`queued`/`running` rows.

---

## Item 4 — Manager assignment reliability (`team.rs`)

### 4.1 Duplicate tool calls — **found, fixed**

* Key: `sha256(originSessionId | originTurnId | fromAgentId | targetAgentId | message)`
  (`team.rs:621-638`). No key without an `originTurnId`, so a call outside a Manager turn is
  never deduped. Decision, different from the brief's tuple: the **side conversation id is not
  in the key**. A replay can arrive before the side conversation of the first call is
  discoverable (a topic makes `delegate` open a new conversation, so a replay would open a
  second one and then never match). The target and the message hash already pin the brief, and
  the extra strictness is what stops a duplicate conversation as well as a duplicate delivery.
* Storage: `dedupe_key TEXT` plus `CREATE UNIQUE INDEX ... ON delegations(dedupe_key) WHERE
  dedupe_key IS NOT NULL` (`bloblex-storage/src/lib.rs:1003-1023`). `delegation_create` returns
  `(row, created)`, looks the key up first, and inserts with `INSERT OR IGNORE`; a losing race
  reads the winner's row and returns `created = false` (`bloblex-storage/src/lib.rs:3608-3660`).
* `delegate` looks the key up *before* resolving or creating a conversation and returns the
  stored assignment through `already_sent` (`team.rs:660-670`, `team.rs:738-746`); a race that
  loses the insert returns it too (`team.rs:829-833`). Nothing is recorded, announced or
  delivered again. `message_blob` answers the replay with the row's real status and "was not
  sent again" (`team.rs:671-700`), `assign_task` says "had already sent this task to"
  (`proposals.rs:544-547`), and `Delegation` gained `duplicate`/`queue_reason`
  (`team.rs:610-625`).
* Decision: the dedupe has no time window, so a replay in the *same* Manager turn reports the
  earlier row (even a failed one) instead of resending; a later Manager turn is a new key and
  can send again.

### 4.2 Target availability — **found, fixed**

Before any conversation is created, `delegate` now refuses with a sentence that says what to do:
archived target (`team.rs:709-722`, resolved from the full list when the reachable list does not
have it), hidden target (`team.rs:727-729`), locked target via `crate::bot_is_locked`
(`team.rs:730-732`; `locked_bot_error`'s wording is about *settings*, so a work-specific sentence
is used), and a missing/unusable runtime using the same lookup `new_session` uses
(`st.runtimes` by the agent's `runtimeId` + `adapter_for`): `team.rs:641-658`.
Wording: "X is locked, so it cannot start new work. Ask the user to unlock X, or pick another
teammate."; "X has no installed runtime any more, so it cannot start work. Ask the user to
choose a runtime for X, or pick another teammate."; "X's runtime is not usable by Bitbots any
more, ... fix X's runtime ...". No approval rule changed and no bypass added; the deeper
executable preflight stays in `new_session`, whose message already names the target.
**Global delegation pause does not exist**: the only global pause flag is
`automations.paused` (`crates/bloblex-daemon/src/automations.rs:321,391`), which governs
scheduled runs, not delegations — so nothing was refused on that ground. A `botsAtOnce` of 0 is
reported honestly as the `slots` queue reason instead.

### 4.3 Visible queued state — **found, fixed**

`queue_reason` (additive column) is computed where `started` is
(`team.rs:801-808`: `busy` when the conversation is mid-turn, `slots` when every global slot is
taken), stored by `delegation_create`, exposed as `queueReason` in the DTO through
`DELEGATION_COLUMNS` (`bloblex-storage/src/lib.rs:1035`), and therefore present in
`delegation.list`, in `delegation.updated` (same DTO) and in the Manager's own `delegation`
notice. `delegation_mark_running` clears it, so a delivered row never keeps a stale reason
(`bloblex-storage/src/lib.rs:3679-3692`). The Manager's reply text now says which of the two it
is (`team.rs:690-701`).

### 4.4 Parent wake semantics — **verified; three gaps found, two fixed, one listed**

Read from the code:

| child event | how the Manager learns | durable? |
|---|---|---|
| turn completes | `[Reply from X]` via `team::after_turn` → `claim_reply` → `deliver_reply`; queued when the Manager is busy, `reply_state='pending'` | **yes**: `delegation_pending_replies` re-offers it each boot (`delegations.rs:700-735`) |
| turn fails | same path with `reply_text("failed", error)` | yes, same |
| owner cancels a *running* assignment | `cancel_session_turn` → `turn.cancelled` → same path | yes |
| owner cancels a *queued* assignment, or one whose turn already ended | **nothing did** (the RPC only returned the row), → now `relay_stopped` claims the reply and sends the cancelled reply once (`delegations.rs:205-227`, used at `delegations.rs:864-900`) | yes, through `reply_state` |
| restart cuts the work off | **nothing did** — `interrupted` is deliberately excluded from `delegation_pending_replies` → now one content-free notice per assignment at boot (`delegations.rs:185-204`, `delegations.rs:672-681`) | one shot at boot, and the row is terminal afterwards |
| child asks a question / needs approval | `delegations::attention` → `deliver_update` → a `[Update from X]` message, wake claimed once in `wake_request`; now also for native question cards | **no** — see gap 1 below |
| reply owed when the daemon stopped | rows finished by the live hook already have `reply_state`; rows finished *at* startup had none → now claimed in the running-row loop (`delegations.rs:674-683`) so the existing boot offer loop sends them | yes |

`delegation_queued_for_recovery` re-queues a brief that never went out (durable, `delivery_text`),
and a queued brief cancelled in the meantime is dropped silently by `stopped_delegation`
(`team.rs:947-968`).

Gap 1 (listed, not fixed): the **wake** (`wake_request`) is claimed in the ledger but delivered
through the in-memory team queue (`team.rs:1019-1037`). If the daemon stops between the claim and
the delivery, or the Manager stays busy across a restart, the wake is lost — the request itself
is still pending and visible, and the row still shows it, but the Manager is never told again.
Re-offering it needs a stored short title and a "was this request still pending" check at boot;
that is a new durable-notice mechanism, so it is left to the Director to schedule.

Gap 2 (listed): a wake that *is* delivered while the Manager is busy is not a prompt yet — it
sits in `st.team.queued`. Same restart exposure as gap 1, one step later.

Gap 3 (listed): an assignment finished at boot as `interrupted` produces a notice but no reply,
by design ("nothing was answered"). If the Director wants a `[Reply from X]` there instead, it
is a one-line change to `notice_interrupted`.

### 4.5 Scoped stop — **verified; already scoped, one residual window listed**

`cancel_row` (`delegations.rs:850-902`) only calls `cancel_session_turn` when the conversation's
live turn **is** the row's own `sideTurnId` (`active.as_deref() == Some(turn)`), and only from a
different conversation than the Manager's. Otherwise it ends its own row and cancels no turn.
`cancelGroup` goes through `cancel_row` per member and `group_member` matches the exact origin
session and origin turn or the named ids (`delegations.rs:833-841`), so it cannot reach another
assignment. Residual window (gap 4 below): the check and `cancel_session_turn` are not atomic, so
a turn change in between could cancel a different assignment's turn — microseconds, and closing
it needs a generation-checked cancel in `main.rs`.

---

## Item 5 — bounded reads

* `CREATE INDEX IF NOT EXISTS idx_permission_requests_delegation ON
  permission_requests(json_extract(data,'$.delegationId'))` in `ensure_delegation_schema`
  (`bloblex-storage/src/lib.rs:1015-1023`), which every open path runs
  (`bloblex-storage/src/lib.rs:1823`), so the `json_extract` lookups of
  `question_ids_for_delegation`, `pending_questions_for_delegation`, `question_holds_open` are
  index-assisted instead of table scans.
* `idx_delegations_side_turn ON delegations(side_session_id, side_turn_id)` — new, for
  `delegation_find_for_side_turn`, which runs on every turn end.
* `delegations(side_session_id, status)` already existed (`idx_delegations_side`,
  `bloblex-storage/src/lib.rs:999`), so `delegation_list_for_side` — called several times per
  turn end — was already an indexed query; nothing was added for it beyond the new `side_turn`
  index used by the same queries' predicates.
* `idx_delegations_dedupe` (unique, partial) makes the replay check a single index probe.

---

## New / changed contracts

* **Storage API (Rust only, additive except two signatures):**
  `Storage::delegation_create` now takes `dedupeKey` and `queueReason` in its input and returns
  `Result<(Value, bool)>` (row, created); `delegation_mark_running` also appends `turn_ids` and
  clears `queue_reason`; new: `delegation_find_by_dedupe`, `delegation_open_rows_for_turn`,
  `question_expire_stalled`, `question_pending_answers`.
* **`delegation.list` / `delegation.updated` DTO:** one new field `queueReason` —
  `"busy"` | `"slots"` | `null` (`null` once the assignment started). No field removed, no
  rename.
* **Question card `data`:** `delegationId` (now also on native provider questions),
  `resolvingAt` (new, RFC3339 millis, only while `resolving`), `answerPending` /
  `answerPendingAt` (unchanged shape), and `resolution: "answer_stalled"` on a card expired by
  the new sweep path.
* **Events:** no new event type. `delegation.updated` is emitted only for a newly created or
  changed row (a replayed brief emits nothing new). `permission.resolved`
  (`status:"expired"`) also covers a stalled question now.
* **Manager-visible text:** duplicate-replay reply, `busy`/`slots` queue reasons, archived /
  hidden / locked / unusable-runtime refusals, the interrupted notice
  (`meta.direction = "interrupted"`), and `question_resolved` notices for native answers.
* **Manager tool:** `message_blob`'s reply now also tells the truth about a queued duplicate; the
  tool's input schema is unchanged (`additionalProperties: false` untouched).

## Race analyses (interleavings)

1. **Replay of one `message_blob` call.** A and B both miss the dedupe lookup, both compute the
   same key; A's insert wins, B's `INSERT OR IGNORE` returns 0 and B reads A's row, therefore one
   row, one notice, one delivery.
2. **Late answer adoption.** `answer_started` spawns `adopt(T_a1)`; before it lands, `T_a2` starts
   and is adopted. A's task then sees `sideTurnId = T_a2` and `turn_is_newer(T_a1, T_a2) = false`,
   therefore it skips, and the row keeps the newer turn.
3. **Question turn end vs the answer's turn.** While the hook for the question turn `T_q` runs, `T_a`
   (the answer, same assignment) becomes live, therefore `answer_continues_row` is true and the
   ending is `Waiting`: no premature finish, no relay of the question text. If instead another
   assignment's `T_B` is live, `answer_continues_row` is false, therefore `T_q`'s own outcome is
   applied and its reply is relayed once — a failure can no longer disappear (1.1).
4. **Claim lost between `begin_permission_reply` and `resolve_question`.** The card is
   `resolving` with a young `resolvingAt`, therefore it holds; after two minutes the sweep expires
   it and (for a side conversation with a running row) prompts the child, therefore the assignment
   gets a turn that ends it instead of waiting for ever.
5. **The owner answers B while cancelling A.** A's cancel closes only A's card ids
   (`pending_questions_for_delegation(A)`); B's card was claimed by the owner's reply already
   (`begin_permission_reply` owns it), therefore B's answer completes and relays exactly once
   while A ends `cancelled` with its own reply.
6. **Answer never deliverable.** Both delivery paths fail → the flag is cleared immediately
   (`questions.rs:377-392`); if instead the item is deleted later, the sweep sees no queued
   answer and no live turn after two minutes, clears the flag and — when the assignment's own
   turn already ended — finishes it and relays that outcome once (claimed).
7. **Restart between turn end and reply.** The live hook claims `reply_state='pending'` before
   delivering, therefore the next boot's offer loop sends it; a row that ended *just before* the
   stop without a claim is now claimed by `delegations::startup`, therefore the same loop sends it
   exactly once (`delegation_reply_settle` on drain).

## Decisions not specified in the brief

* Dedupe key excludes `sideSessionId` and includes the target (reason in 4.1); dedupe has no time
  window (per origin turn).
* `QUESTION_RESOLVING_HOLD` = 2 minutes; the dropped-answer settle window is the same 2 minutes;
  `QUESTION_ANSWER_HOLD` stays at 30 minutes.
* A pending **native** question card no longer holds its assignment open; an unresolved native
  card left pending by a failed answer is left for a restart to expire (`recover_after_restart`
  expires every pending card, `bloblex-storage/src/lib.rs:4982`).
* `record()` returns `(row, created)` rather than an id; `proposals.rs` uses the new
  `Delegation.duplicate` for its verb.
* One line was added in `permission.reply` (`main.rs:1263`) to write the native
  `question_resolved` notice — the minimum needed for item 2's "and for `question_resolved`".
* `retry_dropped` and `cancel_row` now also relay the reply they cause, because no turn hook will
  do it; both go through `claim_reply`, so a later duplicate ending sends nothing.
* A replay of a brief that already failed in the same Manager turn reports the failure instead of
  resending; a new Manager turn can send again.

## Existing tests that reference what I changed (names only; none edited, none run)

* `bloblex-storage/src/lib.rs`:
  `automatic_permission_resolution_is_conditional_and_persists_policy_source`
  (`begin_permission_reply`), `team_projects_leader_side_sessions_and_questions_round_trip`
  (`insert_question`, `permission_get`, question card snapshot),
  `proposals_are_cards_the_question_sweep_ignores_and_a_decision_resolves_them`
  (`expire_due_questions`, `permission_get`), `queued_prompts_order_reorder_update_and_delete_follow_state_rules`
  (`queue_add` shape, untouched).
* `bloblex-daemon/src/main.rs`: `ask_user_is_listed_for_every_providers_own_conversation`,
  `ask_user_validates_bounds_persists_an_expiring_card_and_leaves_the_turn_idle`,
  `ask_user_answers_are_delivered_idle_or_queued_and_never_read_as_answered_after_expiry`
  (questions + sweep), `delegation_notice_splits_a_turn_and_reply_paths_read_one_row`
  (delegation notice shape), `row_message_blob_says_started_or_queued_honestly`,
  `row_a_task_runs_in_the_named_project`, `row_repeated_refused_drains_write_one_waiting_notice`
  (`team::delegate` / `message_blob` text). No other test body in this tree names the changed
  helpers (searched by symbol).
* `bloblex-daemon/src/team_p7_tests.rs`: `p7_manager_messages_a_teammate_immediately_with_no_proposal_or_task`,
  `p7_manager_messages_a_teammate_at_once_while_start_and_assign_stay_approved`,
  `p7_approved_parallel_tasks_carry_contract_and_follow_up_uses_same_conversation`,
  `p7_archived_manager_conversation_cannot_message_or_make_unapproved_writes` (all via
  `message_blob` → `delegate`).
* `bloblex-daemon/src/team_p10_tests.rs`: `p10_isolates_a_code_task_when_another_runs_in_the_repo`,
  `p10_never_isolates_for_a_plain_folder_a_research_bot_or_no_clash`,
  `p10_a_follow_up_after_a_merge_runs_in_an_existing_folder`,
  `p10_isolates_when_the_other_task_is_queued_or_has_not_started_a_turn`.
* Read-and-checked for compatibility (no test run): the fixtures of both modules register their
  runtime in `st.db` and `st.runtimes` and install a stub adapter, so the new availability checks
  pass; `row_message_blob_says_started_or_queued_honestly` only needs "queued" in the text;
  `team_p7_tests` only needs "Sent to <name>"; the depth refusal in the referenced-conversations
  test is still checked before the dedupe lookup.

## Gaps I could not close

1. A child's pending request **wake** (`wake_request`) is not re-offered after a restart or after
   the Manager stays busy through one: the claim is durable, the delivery is in memory
   (`team.rs:1019-1037`). Re-offering needs a durable notice record; not attempted here.
2. **Legacy question cards** (created before cards carried a delegation id) are still unlinked:
   in a conversation with two open assignments they neither hold a row nor get closed, and their
   answer's turn ends `Ungoverned` (t6 gap 2 unchanged — the deliberate trade against guessing).
3. A **native** question card whose answer failed stays `pending` in the UI until a restart expires
   it (no `expires_at` for provider questions); it no longer holds its assignment. Giving native
   cards an expiry would change main-conversation behaviour, so it is left alone.
4. `cancel_row`'s "live turn is mine" check and `cancel_session_turn` are not atomic; a turn change
   in that window could stop another assignment's turn. Closing it needs a generation-checked
   cancel in `main.rs`.
5. A `Waiting` ending still relays nothing (t6 design): an untracked turn that ends while the same
   assignment's answer is live is not forwarded.
6. `delegation.cancelGroup` was left exactly as it was (it already delegates to `cancel_row`).
7. Nothing about live timing was observed: every ordering claim above is read from the code, not
   from a run. The t6 patch and this lane's changes are uncompiled-against-tests; the Director's
   gate run is the authority.

## Checks (last lines, verbatim)

`$env:RUST_MIN_STACK='33554432'; cargo check -p bloblex-storage -p bloblex-daemon --message-format short`

```
    Checking bloblex-storage v0.1.0-beta.38 (D:\u2\crates\bloblex-storage)
    Checking bloblex-daemon v0.1.0-beta.38 (D:\u2\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.64s
```

No warning line appeared (a warning would print as `path:line: warning: ...` before `Finished`).
The build was repeated from a forced rebuild of both crate roots with the same result. No test
target was built, so anything the test modules use is unverified here.

## Proposed skill update (I may not edit `.claude/`)

`.claude/skills/bitbots-development/references/lessons.md`, new dated entry:

> **2026-10-27 — "another turn is live" is not the same as "this turn's ending is stale" (lane U2,
> `lane/u2`).** t6 silenced every turn end that arrived while any other turn of the same side
> conversation was live; with two assignments in one conversation (or an automatic retry) that
> swallowed a failed assignment, and nothing else could ever end its row. The rule that is safe is
> narrow: stay silent only when the live turn is the answer to *this* assignment's own question
> (read the answer turn's `questionId`, then the card's stored `delegationId`). Two more traps from
> the same lane: `delegation_mark_running` guards only `status`, so any spawned adoption must
> compare turns itself, and a question claim (`resolving`) needs its own timestamp or it holds an
> assignment for ever. When a `pending` question card belongs to a *native* provider question it
> can never be answered after its turn ends, so it must not hold the row.
