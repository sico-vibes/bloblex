# Lane R report — delegated questions, their answers and their turns tied to the delegation row

Worktree `D:\t6`, branch `t6/question-delegation`. **No test of any kind was run**
(no `cargo test`, no `cargo check --tests`, no `cargo clippy --all-targets`, no
`npm test`/`vitest`, no scratch probe, no app, no browser, no screenshot). Only the
two sanctioned checks were run. **No git write was made** (no commit, add, rebase,
checkout, stash, reset, push).

Files touched (all of them under "You own"):

- `crates/bloblex-storage/src/lib.rs` (question + queue lookup helpers only)
- `crates/bloblex-daemon/src/delegations.rs`
- `crates/bloblex-daemon/src/questions.rs`
- `crates/bloblex-daemon/src/team.rs` — **not touched** (see "What I did not need")
- `crates/bloblex-daemon/src/main.rs` — only the `QuestionAnswer` hook (lines 3233-3244)

Nothing outside those paths was edited; `checkpoints.rs`, `media.rs`,
`workspace.rs`, `experiments.rs`, `queue.rs`, `apps/`, `docs/`, `.claude/` are
untouched.

---

## A. The association is persisted on the question, from the daemon's own lookup

**Storage** (`crates/bloblex-storage/src/lib.rs`)

- `question_set_delegation(id, delegation_id)` — 2360-2370. Writes
  `data.delegationId` into the card's own JSON (`json_set`), which is the same
  place `status`/`choice` already live, so no table migration is needed and an
  older database needs no change. Idempotent and first-writer-wins: the `UPDATE`
  only fires when the key is absent, so a repeated call, or one with a different
  id, can never rewrite the association the turn really had. Rejects an empty id
  (`InvalidAgent`). Only question cards are touched (`json_extract(data,'$.kind')='question'`).
  I chose the JSON field over a column because the brief allows either and the
  write is a single atomic statement with no schema version to keep in step
  (`wake_request`/`reply_state` were columns because they are queried by SQL with
  `IS NULL` semantics and never read through `permission_get`).

**Daemon** (`crates/bloblex-daemon/src/delegations.rs`, `questions.rs`)

- `delegations::question_owner_row(st, side)` — 387-398. Exactly the brief's rule:
  the row of `delegation_find_for_side_turn(side, active_turn(st, side))` (with
  `active_turn` now `pub(crate)`, 379-381), else the single `running` row of that
  conversation when exactly one exists, else `None`. It never looks at the tool
  arguments, so an agent cannot claim an assignment.
- `ask_user_tool` (`questions.rs` 140-148) calls it right after `insert_question`
  and stores the id. The card is inserted first so the association is a plain
  update on an existing row; a lookup failure (storage error) leaves the card
  unlinked rather than failing the tool.

Invariants kept: the tool's own input schema is unchanged (`additionalProperties:
false`), a question in a main conversation (`question_owner_row` returns `None`,
no rows for that session) is unlinked exactly as before, and the emitted
`permission.requested` payload is unchanged so the UI sees the same card.

Left open: **native provider question cards** (the `AgentEvent::QuestionAsked`
path at `main.rs:4277`) are still created without going through
`ask_user_tool`, so they stay unlinked. `main.rs` is limited to the
`QuestionAnswer` hook by the brief, so I did not touch it; those cards continue to
use the legacy session-level hold (see below). This is the one place where a
delegated bot can still ask a question whose card has no owner.

---

## B. A question holds *its* assignment open until the answer's turn has started

**Per-question state** (`crates/bloblex-storage/src/lib.rs`)

- `question_mark_answer_pending(id, pending)` — 2373-2387. `true` sets
  `data.answerPending = true` and `data.answerPendingAt = <rfc3339 millis>`; `false`
  sets the flag false and *removes* the timestamp (`json_remove`), so a released
  question cannot read as still holding. Guarded to question cards.
- `pending_questions_for_delegation(delegation_id)` — 2397-2407 (`status='pending'`).
- `question_ids_for_delegation(delegation_id)` — 2389-2395 (every status; used only
  to clear `answer_pending` when an assignment ends).
- `question_holds_open(delegation_id)` — 2409-2419, with `QUESTION_ANSWER_HOLD`
  (`Duration::minutes(30)`) at 1049-1052. True when a card of that delegation is
  `pending` (or `resolving`, see below), **or** it is `resolved`/`expired` with
  `answerPending` set and `answerPendingAt >= now-30min`. The cutoff is computed in
  Rust in the same fixed-width UTC format the write uses, so the string comparison
  in SQLite is chronological.
- `permission_get` already finds a question by id; no new lookup was needed.

**Turn-end predicate** (`delegations.rs` 444-450)

`question_holds_assignment_open(st, row)` = `question_holds_open(row.id)`, else —
only for legacy cards — `pending_question_exists(side) && open_for_side_count(side)
== 1`. The legacy branch keeps the old session-level check but cannot let one
assignment's card hold another assignment: with two open rows it is false.

Used by:
- `after_turn` (284) for `turn.completed` on the row that owns the ending turn;
- `started`'s read-back (96) instead of the old session-level check;
- `startup`'s completed-turn check (551);
- `cancel_row` (718), which needs to know a waiting assignment ends as
  `cancelled`, not `completed`.

**Adoption of the answer's turn** (`delegations.rs` 331-348, `main.rs` 3233-3244,
`questions.rs` 318-321)

- `reply_mcp_question` marks `answer_pending` immediately after the claim
  (`resolve_question` succeeded), before the answer is delivered, and `sweep` marks
  it before prompting an expired question's child. Both happen on the owner's
  answer path, so the flag exists before any turn can end.
- `session_prompt_impl`, on the accepted `PromptOrigin::QuestionAnswer` path (both
  the direct call from `deliver_answer` and the queue-drain call from
  `queue::send_claimed` end here), reads `meta.questionId`, loads **that question**
  and takes **its stored** `delegationId`; nothing from the request is trusted.
  It then calls `delegations::answer_started(st, delegation_id, turn_id, question_id)`.
- `answer_started` is a **sync `fn`** that spawns its `adopt` (which emits
  `delegation.updated`), so the prompt path never gains a future that reaches back
  into itself (the E0391 note). It (1) clears `answer_pending` for that question in
  every case; (2) returns without touching anything if the row is not `running`
  (terminal rows are never rewritten, queued ones are adopted by their own start);
  (3) returns before spawning, and so emits nothing, when the row already carries
  this turn — that is the idempotency: a second call for the same turn changes
  nothing; (4) otherwise adopts the turn through the same `adopt` the brief
  start uses (`delegation_mark_running` → `side_turn_id`, guarded by
  `status IN ('queued','running')`).
- The adopt is asynchronous, so a very fast answer turn can end before it lands.
  `after_turn` covers that with the "newer turn" rule below, and the row still
  finishes with the answer turn's own outcome.

**Never guess which assignment a turn belongs to** (`delegations.rs` 239-298)

- Fallback is now `single_open_for_side` (431-436): only when the conversation
  carries **exactly one** open (`queued`/`running`) row. With several open rows and
  no exact `sideTurnId` match the ending is `Ungoverned`. The limit is documented on
  the function and in `after_turn`'s doc comment.
- The existing automatic-retry adoption still works: when the row's stored turn has
  already ended and the ending turn is **newer** in the stored turn list
  (`turn_is_newer`, 303-308, which uses the creation order of `session.turns`), the
  ending turn is adopted, exactly as before. When the stored turn cannot be located,
  the fallback is "adopt only if the stored turn already has an outcome".
- New, and needed by the design: an ending that is **not** the row's current turn
  and is **older** is `TurnEnd::Waiting` — it owns neither the status nor the
  reply. This is what makes a question turn's late end harmless once its answer's
  turn is already live. Two cheaper guards back it up: a turn that ends while a
  *different* turn of the same conversation is live returns `Waiting` immediately
  (242-244), and an answer turn for which no assignment can be found at all is
  suppressed rather than relayed a second time (`turn_is_question_answer`,
  313-321, 248-253).
- `Waiting` is the right answer in all those cases because `team::after_turn`
  skips the relay for it (`team.rs:1015`, untouched) while still draining the queue,
  so the answer that was waiting at the front still goes out.

**Restart** (`startup`, 539-553 + `release_abandoned_answers`, 597-607)

- For each running row: clear `answer_pending` on its questions when the
  conversation holds no queued prompt carrying that `questionId`
  (`queue_has_question_answer`, `storage:3306`, `status IN ('queued','sending')`
  and `meta.kind='question_answer'` + `meta.questionId`), because nothing can start
  that turn any more (a `sending` item is rewritten to `failed` by the restart at
  `storage:4788`, before `delegations::startup` runs at `main.rs:4499`). No live
  turn exists at boot by definition, so no further check is needed.
- Then the normal outcome logic runs, with the row's own hold as the only reason a
  completed turn stays `running`. An answer still queued (the session is paused on
  boot) keeps the row running until the owner resumes or the 30-minute bound is
  passed at a later turn end or restart.

Decisions left open:
- `resolving` counts as a live hold in `question_holds_open`. The claim
  (`begin_permission_reply`) sets `resolving` in the dispatcher *before*
  `reply_mcp_question` runs, so this closes the only window in which a turn could
  end between the owner's claim and `answer_pending` being written (the runtime is
  multi-threaded, so a sync section is not a guarantee). Consequence: a card stuck
  in `resolving` (only reachable if `resolve_question` fails on a database error)
  would hold its row running until the owner cancels the assignment. A cancel still
  ends the row, because `cancel_row` finishes it regardless of its cards.
- `answer_pending` is set for main-conversation questions too (harmless: it is only
  ever read per delegation id, and no main-session question has one) and is never
  cleared there. I preferred one uniform write to a conditional one.
- I added `question_ids_for_delegation` (not in the brief's list) because clearing
  `answer_pending` when an assignment ends needs the answered/expired cards too,
  and `pending_questions_for_delegation` only returns pending ones. It is a
  question helper, inside the allowed surface.

What I could not verify: anything about live timing (no test run, no app). The
ordering claims above are read from the code paths, not observed.

---

## C. Closing is per assignment

`close_pending_questions(st, delegation_id, side_session_id)` — 146-170.

- Ids closed: `pending_questions_for_delegation(delegation_id)`, plus legacy cards
  (no stored `delegationId`) **only** when this conversation carries no other open
  assignment (`other_open`, 148-150). With another assignment still open, a legacy
  card may be that one's, so it is left alone together with its row and wake claim.
- Per card, unchanged shape: `begin_permission_reply(id,"dismiss")` is the claim
  (a card the owner is answering right now stays with that answer), then
  `resolve_question(id,"dismissed")`, then `permission.resolved` with
  `status:"cancelled"`, then `question_resolved(..., "closed")` for the
  non-waking Manager notice. No prompt is sent to the child.
- After the loop, `answer_pending` is cleared for every question of the
  delegation (167-169): the assignment is over, so nothing of its may hold anything
  open.
- Header comment states the invariant: only this assignment's cards are closed;
  another assignment's cards, row and wake claim are never touched.

Call sites, all with the row's own id: `finish` (131, which covers `cancel_row`'s
terminal path, `failed`, `retry_dropped` and `startup`'s interrupted path —
`delegation_mark_terminal` accepts `interrupted`, and `finish` closes for
`cancelled | failed | interrupted`), `cancel_row` (722, before the row is marked,
so its own row is excluded from `other_open` explicitly).

`cancelGroup` needed no change: it calls `cancel_row` per group member, so
cancelling A closes only A's cards and leaves B's row, B's card and B's
`wake_request` exactly as they were (the wake lives on B's row, and `attention`
claims it there).

---

## D. Everything that guessed a row now uses the question's row

- `question_resolved` (190-199): `data.delegationId` of the card → `delegation_get`;
  only a legacy card falls back to the old guess (live turn → open row → newest).
  The notice's `delegationId`/`fromAgentId` therefore name the right assignment.
- `reply_mcp_question` (291-300): closes the card and returns `conflict` when
  `is_terminal` of **the question's own row** (`is_terminal` is now `pub(crate)`,
  704-707); a legacy card uses the newest row of the conversation, which is exactly
  what the removed `assignment_ended` did, so legacy behaviour is unchanged. The
  session id still comes from the card (`data.sessionId`), never the request.
- `sweep` (269-280): prompts the child only when `question_row(...)` is `running`,
  sets `answer_pending`, and delivers through the same `deliver_answer`
  (`meta` = `question_answer` + `questionId`), so the follow-up turn is adopted the
  same way as a real answer. Cards whose row is not running get no prompt (and no
  hold is created).
- `startup`: described in B; the completed-turn check is the row's own hold and the
  abandoned-answer release uses the question id in the queued prompt.
- `attention` (489-502) additionally prefers the stored id, so a child's pending
  question wakes the Manager through its **own** row and claims `wake_request`
  there. This was not required verbatim but is the same shortcut as
  `question_resolved`, and it is what makes "cancel A leaves B's wake claim
  untouched" true rather than accidental.

---

## E. Authorization and idempotency (verified, not weakened)

- Only `permission.reply` answers: the dispatcher claims the card with
  `begin_permission_reply` and routes `mcp:` + `kind:"question"` to
  `reply_mcp_question` (`main.rs:1202-1216`, untouched). No RPC, no remote tier and
  no Manager path was added; the Manager still cannot answer or approve, and its
  only trace is the existing non-waking notice.
- The session id is taken from the card row (`questions.rs:290`), unchanged.
- Double answers: `begin_permission_reply` only claims `status='pending'` and
  `resolve_question` only resolves `status='resolving'`, so the second attempt is
  still `conflict` (the `AgentConflict` mapping in `reply_mcp_question` is
  unchanged).
- The wake stays once per question: `delegation_wake_claim(id, request_id)` is
  still the single atomic claim, and the claim now happens on the right row.
- The resolution notice stays once per question, and none of the new code puts
  question, option or answer text into it, into logs or into any event: the new
  fields are ids, booleans and timestamps only.

---

## Gap 1 walked through in the new code

Owner answers while the child's question turn is still finishing. `session_busy`
is true, so `deliver_answer` queues the answer at the front; before that,
`reply_mcp_question` already resolved the card and set `answer_pending`
(`questions.rs:321`, with `answerPendingAt`).

1. The question turn ends. `team::after_turn` calls `delegations::after_turn(turn =
   question turn)`. No other turn is live, so the staleness guard passes. The row is
   found by its `sideTurnId` (the question turn) and is `running`. Outcome is
   `turn.completed`; `question_holds_assignment_open(row)` is true because the card
   is `resolved` with `answer_pending` and younger than 30 minutes → `Waiting`.
   No finish, no reply (`team.rs:1015` skips the relay), the row stays `running` on
   the question turn. The child's question text is **not** relayed as the reply.
2. `queue::after_turn` (same spawn, after the delegation hook) drains the front
   item; `send_claimed` sees `meta.kind == "question_answer"` and calls
   `session_prompt_for_question_answer`. `session_prompt_impl` accepts the turn
   (session idle, side conversation allowed for this origin), inserts it into
   `active_turns`, and the new hook reads `meta.questionId`, loads the card, takes
   its **stored** `delegationId` and calls `answer_started`, which clears
   `answer_pending` and adopts the answer turn onto that row (spawned `adopt`).
3. The answer turn ends. `after_turn` finds the row by the answer turn, it is
   `running`, `owns` is true, the question no longer holds anything → `finish(completed)`
   → `TurnEnd::Owed(row)`. `team::after_turn` claims the reply once
   (`claim_reply`) and relays `turn_reply(side, answer turn)` — the child's final
   text — to the Manager exactly once. `settle_reply` records delivery.
4. If the adopt in step 2 had not landed before step 3, step 3's `after_turn` finds
   the row through the single-open fallback, sees the answer turn is **newer** than
   the stored question turn and adopts it there — same outcome, same single reply.
5. If the question turn's end hook is the delayed one (it runs only after the answer
   turn has started), the live-turn guard (242-244) returns `Waiting`: nothing is
   finished, nothing is relayed. If it runs after the answer turn already finished
   the row, the row is terminal and the hook returns `Owed(row)` whose claim is
   already taken, so nothing is sent.
6. If the queued answer never starts a turn (item deleted, queue paused), the hold
   expires after 30 minutes: the next turn end's `question_holds_open` is false and
   the row takes its question turn's own outcome; a restart does the same through
   `release_abandoned_answers`. The owner can also cancel, which dismisses the card
   and ends the row as `cancelled`.

## Gap 2 walked through in the new code

Two assignments A (running, card QA pending) and B (queued) share a side
conversation.

1. QA was created with `data.delegationId = A` (from `delegation_find_for_side_turn`
   on A's live turn). B has no card yet.
2. Cancel A: `cancel_row(A)` reads `waiting = question_holds_assignment_open(A)`
   (true, its own card), then `close_pending_questions(st, A, side)`. `other_open`
   is true (B is queued), so legacy cards are skipped; only QA is claimed,
   dismissed, announced and noticed (`question_resolved` reads QA's stored id, so
   the notice names A). A's row then finishes `cancelled`. B's row, B's card (if it
   asks later) and B's `wake_request` are untouched.
3. B's brief is then delivered, B runs, and if B asks a question, its card is
   associated with **B** by the same lookup; its wake is claimed on B's row.
4. Both assignments can be waiting at once: A `running` on its question turn and B
   `running` on its own turn. Each question's id points at its own row, so each
   answer adopts its own row and relays its own final text. `after_turn` never has
   to guess: the ending turn id matches a row, and the single-open fallback is not
   used (there are two open rows); with no exact match it would return
   `Ungoverned` rather than finish the wrong row.
5. `question_resolved` for either card now reports the right `delegationId`, so the
   Manager's board and notice cannot attribute B's answer to A.

## Cases I could not make fully safe (exact remaining gaps)

1. **Native provider question cards are unlinked** (`main.rs:4277`, the
   `AgentEvent::QuestionAsked` path, outside the files I may change beyond the
   `QuestionAnswer` hook). Such a card has no `delegationId`, so only the legacy
   branch holds its row open, and only while the conversation has exactly one open
   assignment. In a conversation with two open assignments, a delegated bot's
   native question would not hold its row: `after_turn` finishes that row
   `completed` and relays the question turn's text, and the native answer's turn is
   then unowned (its reply is relayed unclaimed, not attributed). Fixing it needs an
   association write on that path.
2. **A legacy card in a conversation with two open assignments** has no owner to
   compare and is deliberately neither closed (`close_pending_questions`) nor
   allowed to hold a row (`question_holds_assignment_open`), and an answer to it
   still starts a turn through `reply_mcp_question`; with two open rows and no turn
   match, that answer's turn ends `Ungoverned`, but `turn_is_question_answer`
   suppresses the relay, so **its final text reaches nobody**. This is the
   deliberate trade against guessing a row.
3. **A stuck `resolving` card** (only after a database error between the
   dispatcher's claim and `resolve_question`) holds its row `running` until the
   owner cancels: `question_holds_open` counts `resolving` to close the
   claim-before-`answer_pending` window, and nothing ages it out because
   `permission_requests` stores no resolving timestamp.
4. **`retry_dropped`** still looks the row up by the failed turn id. Now that an
   assignment's `sideTurnId` moves to each answer turn, a retry created for an
   *earlier* turn of the same assignment would not be found, and the row would stay
   running until some later turn end or a restart. (It is not worse than before for
   answer turns — the old code kept the first turn id forever — and it is better for
   a retry of an answer turn, which now matches.)
5. **A `Waiting` end always skips the relay.** That is what the design needs for
   the question turn, but it also means a genuinely untracked turn that happens to
   end while another turn of the same conversation is live is never relayed. I could
   not find a real path where that hides work (side conversations are only written
   by the daemon), but it is a narrowing of the old behaviour.

## Existing tests this makes stale

None found. I searched `crates/` for every symbol I changed or removed
(`assignment_ended`, `close_pending_questions`, `pending_question_exists`,
`question_resolved`, `delegation_latest_open_for_side`, `delegation.cancel`,
`cancelGroup`, `question_holds*`) and no `#[test]`/`#[cfg(test)]` block references
them or pins the behaviour that changed. The question tests in
`main.rs` (`ask_user_is_listed_for_every_providers_own_conversation`,
`ask_user_validates_bounds_...`, `ask_user_answers_are_delivered_idle_or_queued_...`)
exercise main-conversation questions only, whose delivery, queueing, dismissal and
expiry behaviour is unchanged; `team_p7_tests`/`team_p10_tests` and the
`fix39_*` modules do not create delegation rows around a question. Nothing was
edited or deleted in any test, and **no test was run**, so this is a reading, not a
result: the Director's gate run is the authority.

## Checks (last 15 lines of each, verbatim)

`$env:RUST_MIN_STACK='33554432'; cargo check -p bloblex-storage --message-format short`

```
    Checking bloblex-storage v0.1.0-beta.38 (D:\t6\crates\bloblex-storage)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.91s
```

`$env:RUST_MIN_STACK='33554432'; cargo check -p bloblex-daemon --message-format short`

```
    Checking bloblex-storage v0.1.0-beta.38 (D:\t6\crates\bloblex-storage)
    Checking bloblex-daemon v0.1.0-beta.38 (D:\t6\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.47s
```

No warnings were printed by either (a warning would appear as a `path:line: …`
line before `Finished`). The first full build of both crates after my edits also
finished clean (`bloblex-daemon` in 54.43s), so nothing was hidden by caching.

## What I did not need

`team.rs` is unchanged: `after_turn`'s `Waiting` arm already skips the relay and
still drains the queue, and the `Owed(row)` arm already claims exactly once. The
brief allowed changes there "and what it needs"; nothing was needed.

## Proposed skill update (I may not edit `.claude/`)

`.claude/skills/bitbots-development/references/lessons.md`, new dated entry:

> **2026-10-27 — a delegated question belonged to a conversation, not an assignment (lane R, `t6/question-delegation`).** Symptom: an answer typed while a side conversation's question turn was still finishing was queued, the turn then finished the assignment `completed` and relayed the question text as the reply, and the queued answer's turn was unowned. Cause: `delegations::after_turn` / `close_pending_questions` / `question_resolved` all keyed on the side session (`pending_question_exists(side)`, newest row), so two assignments in one conversation shared one answer. Fix: `ask_user` cards store their `delegationId` (`question_set_delegation`), `answer_pending` holds *that* row open until the answer's turn starts (`delegations::answer_started`, a sync `fn` that spawns its emit because the prompt path reaches back into the turn hook — E0391), and every row lookup is per assignment with a single-open-assignment fallback only. When adding anything that maps a turn to a delegation row, never key on the session alone, and remember the daemon is multi-threaded: only a database-atomic state (here `resolving`) closes a claim/answer race.
