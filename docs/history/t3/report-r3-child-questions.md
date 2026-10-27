# Lane Q report — a delegated (side-conversation) bot can ask the human, end to end

Worktree `D:\t5`, branch `t5/child-questions`. No tests were run, added, edited or
deleted. No git writes. Nothing outside `D:\t5` was touched.

## 1. Gate: when a side conversation may ask

Files and lines:
- `crates/bloblex-daemon/src/questions.rs:51-81` — new `pub(crate) fn may_ask(st, session) -> Result<(), &'static str>`.
  Refuses an archived session; refuses `automation` and unattended `task` links with
  the existing sentences ("ask_user is not available to scheduled runs."); for
  `side` requires `link.originSessionId` to name an existing, non-archived
  conversation and follows each origin's own `link.originSessionId` for at most four
  hops, refusing if any link in it is `is_unattended` with "This assignment was
  started by a scheduled run, so there is no one to ask."; every other kind passes,
  as today. Constants at `questions.rs:26-34`.
- `crates/bloblex-daemon/src/questions.rs:130-132` — `ask_user_tool` now calls
  `may_ask` and returns its sentence; the old `match session["link"]["kind"]`
  refusals are gone. Archived keeps "This conversation is archived.".
- `crates/bloblex-daemon/src/team.rs:447-451` — the `mcp_rpc` `ask_user` boolean is
  now `crate::questions::may_ask(st, row).is_ok()`, with the comment rewritten (tool
  list and call gate both read it). `team.rs:512` is the fallback refusal sentence for
  the remaining refusals ("ask_user is not available in this conversation.").
- `crates/bloblex-daemon/src/questions.rs:87` — the tool description now says a side
  conversation's Manager is told the bot is waiting, but only the user can answer.

Invariants relied on: `is_unattended` (main.rs:1487) is the one definition of a
scheduled/unattended link; a side conversation's origin is its `link.originSessionId`
(the same field `attention`, `relay_failure` and `after_turn` already use). A chain
deeper than four hops is refused rather than trusted.

## 2. A pending question holds the assignment open

Storage (`crates/bloblex-storage/src/lib.rs:2336-2351`):
- `pending_question_exists(session_id) -> Result<bool>`: a `permission_requests` row
  for that session with `status='pending'` and `json_extract(data,'$.kind')='question'`.
- `pending_questions_for_session(session_id) -> Result<Vec<String>>`: the same rows'
  ids, oldest first (`ORDER BY rowid`).

Daemon:
- `delegations.rs:200-206` — `TurnEnd::Waiting` added next to `Ungoverned`/`Owed`.
- `delegations.rs:230-238` — `after_turn`'s `turn.completed` arm returns `Waiting`
  when the side session has a pending question, after the existing adopt-a-new-turn-id
  step, so the row keeps its `sideTurnId`. Nothing is finished and no reply is claimed.
- `delegations.rs:92-98` — `started`'s read-back of an already-finished turn does not
  finish a `completed` turn whose question is still pending (bounded, idempotent).
- `team.rs:1010-1024` — `team::after_turn` skips the relay entirely for `Waiting`
  (the origin lookup itself is gated), and the `owed` match has an explicit
  `Waiting => None` arm, so no `[Reply from X]` is composed, claimed or sent.
- `delegations.rs:364-374` — `startup`: a running row whose turn already completed but
  whose question is still pending stays `running` (the answer's next turn ends it; an
  expiry or dismissal still prompts the child, so it cannot hang).
- `questions.rs:251-270` — `sweep`: unchanged for non-side sessions. For a side
  session with a running assignment it also prompts the child, via `deliver_answer`'s
  own mechanism, with "Your question expired without an answer. Continue without it,
  or say what is blocked."
- `delegations.rs:146-156` — `close_pending_questions`: for each pending question
  claims it (`begin_permission_reply(id,"dismiss")`), resolves it as `dismissed`,
  emits `permission.resolved` with `{"permissionId": id, "choice": "dismissed",
  "status": "cancelled"}`, and writes the resolution notice. No prompt is delivered.
  Called from `cancel_row` (`delegations.rs:518-525`, both queued and running path,
  before the branch) and from `finish` for every `cancelled`/`failed`/`interrupted`
  ending (`delegations.rs:122-133`), which is what covers the turn-end, `failed()`,
  `retry_dropped`, `startup`'s `interrupted` and cancel fallbacks.
- `delegations.rs:520-548` — a waiting assignment the owner cancels whose turn already
  ended is finished `cancelled`, not `completed`.
- `questions.rs:274-309` — `reply_mcp_question` now takes the session id from the
  question row itself (`data["sessionId"]`), never the caller's argument. When that
  session is a side one and `delegations::assignment_ended` (`delegations.rs:136-141`,
  newest row is `completed|failed|cancelled|interrupted`) says so, it resolves the
  card as `dismissed`, emits `permission.resolved`, writes the "closed because the
  assignment ended" notice, delivers nothing and returns
  `conflict` "This assignment has ended, so the question was closed.".

The answer's follow-up prompt still goes through `deliver_answer` unchanged (prompt
when idle, queue at the front otherwise; the drain handles the queued case).

## 3. Parent visibility without authority

- Wake: unchanged. `ask_user_tool` still spawns `delegations::attention`, which claims
  `wake_request` once per request id before delivering the title-only `[Update from X]`.
  It now actually fires because the question can be created.
- `delegations.rs:158-196` — new `pub(crate) async fn question_resolved(st,
  side_session_id, request_id, outcome)`: no-op unless the session is a side
  conversation with an existing origin; writes one `team::note` (non-waking) into the
  origin with content `NAME's question was answered.` / `... was dismissed.` /
  `... expired without an answer.` / `... was closed because the assignment ended.`
  and meta `{"kind":"question_resolved","fromAgentId","fromName","sideSessionId",
  "delegationId","requestId","outcome":"answered|dismissed|expired|closed"}`. No
  question, option or answer text. Its assignment id comes from the row owning the
  live turn, else the newest open row, else the newest row.
- Called from `reply_mcp_question` (answered/dismissed/closed), `sweep` (expired) and
  `close_pending_questions` (closed). No E0391 future cycle appeared on `cargo check`,
  so no synchronous spawner wrapper was needed; the calls are direct.

## 4. Instructions

`team.rs:361` — added to the side-conversation block: "If you need a decision or
information only the user can give, use the ask_user tool, then end your turn. Your
Manager is told you are waiting, but only the user can answer; their answer arrives as
your next message. Do not ask the Manager to answer for the user."

## main.rs — one line, unavoidable

`main.rs:3057-3061` (the side-conversation gate in `session_prompt_impl`): added
`PromptOrigin::QuestionAnswer` to the allowed origins. Without it, an answer to a
delegated question is refused `read_only`, gets queued by `deliver_answer`, and the
drain fails it (`queue::send_claimed` -> `session_prompt_for_question_answer`) and
pauses that session's queue: the child would never receive the answer. Nothing else in
`main.rs` changed. The prompt path's meta allowlist already restricts
`question_answer` to daemon-written `{"kind":"question_answer","questionId"}`, and
`queue::allowlisted_params` strips user meta, so no user-supplied prompt can use it.

## How a delegated question flows now

1. Manager `message_blob` -> `team::delegate` writes the ledger row (`queued`) and
   `deliver` prompts the side conversation; `delegations::started` marks the row
   `running` with the brief's turn id.
2. Child calls `ask_user`: `team::mcp_rpc` lists/allows it (`may_ask`), `ask_user_tool`
   re-checks `may_ask`, `insert_question` writes the pending card (kind question,
   expiry), `permission.requested` emits the card, `attention` wakes the Manager once
   (title only, no way to answer), and the tool returns "shown; end your turn".
3. The child ends its turn: `team::after_turn` -> `delegations::after_turn` finds the
   running row and `pending_question_exists` -> `TurnEnd::Waiting`. No relay, no claim,
   row still `running` on its own turn id.
4. The owner answers in the child's conversation: `permission.reply` ->
   `begin_permission_reply` -> `reply_mcp_question` (card's own session id) ->
   `resolve_question(answered|dismissed)` -> `deliver_answer` (prompt or queue) ->
   `permission.resolved` -> `question_resolved(answered|dismissed)`; the Manager gets
   one non-waking notice with no content.
5. The answer starts the child's next turn; on its end `after_turn` finds no row for
   the new turn, falls back to the newest open row, adopts the new turn id, finishes
   `completed` and returns `Owed(row)`; `team::after_turn` claims the reply once and
   sends the child's final text as `[Reply from X]`.
6. Expiry: `sweep` marks the card expired, emits `permission.resolved`, notes the
   child, prompts a side child whose assignment is running with the expiry text, and
   notes the Manager "expired without an answer".
7. Dismissal: as 4 with the existing DISMISSED prompt; the child continues and its next
   turn ends the assignment.
8. Cancel: `cancel_row` closes pending cards as dismissed with no prompt and the
   cancelled `permission.resolved`; the row ends `cancelled` (a waiting row whose turn
   already completed is reported `cancelled`, never `completed`).
9. Restart: `startup` gives each live row its turn's persisted outcome or
   `interrupted`; interrupted rows close their pending cards; a completed turn with a
   question still pending is left running for the answer.

Cases handled: answered (idle prompt), answered while the child is busy or the global
limit refuses (`deliver_answer`'s front-of-queue + existing drain), dismissed, expired,
cancelled by the owner (queued and running assignments, and the group cancel), failed
or interrupted turn, restart, and answering a question whose assignment already ended.

## Refusals kept

Automation runs and unattended task runs still refuse `ask_user` (same sentences), and
so does any side conversation whose origin chain contains one (new sentence above). No
RPC was added; the Manager still has no way to answer or approve; `apps/`, the tier
table, `checkpoints.rs`, `media.rs`, `workspace.rs`, `experiments.rs`, `docs/` and
`.claude/` were not touched. Logs and notes carry no question, option or answer text.

## Unverified / known limits

- No test, clippy, browser or app run: behaviour is verified only by reading and by the
  two `cargo check` runs.
- Race left as is: if the owner answers in the last moments of the child's own question
  turn, the answer is queued while the question resolves, so the turn completes the
  assignment before the answer prompt starts. The child still receives the answer and
  continues, but its follow-up turn is no longer relayed to the Manager (the row is
  already terminal). Closing it would need queue-state tracking, which the brief did
  not ask for.
- `close_pending_questions` closes *the side conversation's* pending cards, as the
  brief specifies. If one side conversation carries two assignments at once (a new
  brief queued behind a running one), cancelling one closes the other's card too; the
  owner's later answer then gets the "assignment has ended" conflict.
- The four-hop walk refuses a deeper chain rather than trusting it; no such chain is
  produced by the current team depth limits.

## Existing tests this makes stale (not edited)

- `crates/bloblex-daemon/src/main.rs:10122-10168`
  `ask_user_is_listed_for_every_providers_own_conversation`: it asserts `ask_user` is
  not listed and is rejected for the side session `side-run`, whose origin `open-main`
  exists and is not archived. With `may_ask`, the tool is now listed there and the
  call creates a card. The automation assertions in the same test still hold.
- No other test was found that depends on the changed behaviour: the `ask_user` tests
  at `main.rs:10171` and `10112/10214` use a main conversation; `questions::sweep`
  keeps its non-side behaviour; `team_p7_tests.rs:176` only checks that phrases are
  present; `main.rs:4995` checks that the side instruction still contains "This is a
  side conversation" (it does).

## Gate output (last 15 lines of each)

`cargo check -p bloblex-storage --message-format short` (RUST_MIN_STACK=33554432):

```
    Checking bloblex-storage v0.1.0-beta.38 (D:\t5\crates\bloblex-storage)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.84s
```

`cargo check -p bloblex-daemon --message-format short` (RUST_MIN_STACK=33554432):

```
    Checking bloblex-storage v0.1.0-beta.38 (D:\t5\crates\bloblex-storage)
    Checking bloblex-daemon v0.1.0-beta.38 (D:\t5\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.50s
```

Both finished with no warnings and no errors. Full logs are saved at
`target/lane/check-storage.log` and `target/lane/check-daemon.log`.

**I ran no tests of any kind.**

## Proposed `bitbots-development` skill note (not applied: `.claude/` is out of bounds for this lane)

- The `ask_user` bridge is now legal in side conversations (`questions::may_ask`); a
  delegated assignment that ends on a pending question is `TurnEnd::Waiting`, so it
  stays `running` and relays nothing. The answer/dismissal/expiry prompt reaches the
  child through `deliver_answer`, which needs `PromptOrigin::QuestionAnswer` in the
  side-conversation gate of `session_prompt_impl` — without that one line the queued
  answer is failed by the drain and that conversation's queue pauses.
- A side conversation's `question_resolved` notice is `team::note` (never a prompt), so
  the Manager learns the question is over without being able to answer it.

