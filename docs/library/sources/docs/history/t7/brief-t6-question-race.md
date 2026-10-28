# Lane R: tie delegated questions, their answers and their turns to the delegation, not the session

You are an implementation lane. You work ONLY in the git worktree `D:\t6` (branch `t6/question-delegation`). Self-contained brief.

## HARD RULES (override everything else in the repo)

1. **NO tests of any kind.** No `cargo test`, `cargo check --tests`, `cargo clippy --all-targets`, `npm test`, `vitest`, scratch probes. Do not add, edit or delete `#[test]`/`#[cfg(test)]` blocks, `*_tests.rs` or `tests/` (list any existing test your change makes stale; do not edit). No screenshots, browser, running the app.
2. **No git writes** (`commit`, `add`, `push`, `reset`, `stash`, `checkout`, `rebase`).
3. Touch nothing outside `D:\t6`. Do not start or kill processes you did not start. Never print secrets or question/answer text in logs.
4. Only edit the files under "You own". `main.rs` is 13,000 lines: search and offset reads only.
5. Work log: `D:\t6\target\lane\worklog.md`.

## Background (read first: `questions.rs`, `delegations.rs` entirely, `team.rs::after_turn`, `queue.rs` around line 279, `session_prompt_impl` in `main.rs`)

Round 3 let a delegated (side-conversation) bot call `ask_user`. The card is a `permission_requests` row of kind question. While it is pending, `delegations::after_turn` returns `TurnEnd::Waiting` instead of finishing the assignment; the owner's answer arrives as the child's next prompt (`deliver_answer`: direct via `session_prompt_for_question_answer`, or queued at the front of the user queue and sent by `queue::send_claimed`; both end in `session_prompt_impl` with `PromptOrigin::QuestionAnswer`, meta `{"kind":"question_answer","questionId"}`).

Two correctness gaps remain, both because the code keys on the **side session**, not on the **delegation row**:

**Gap 1 (answer near the end of the question turn).** If the owner answers while the child's question turn is still finishing, `deliver_answer` queues the answer (session busy). The question is already resolved, so when that turn ends `pending_question_exists(side)` is false and `after_turn` finishes the assignment `completed` and relays the child's question text as the reply. Later the queued answer starts a turn that no row owns, so its final reply is never relayed (or is attached to the wrong row).

**Gap 2 (two assignments, one side conversation).** `close_pending_questions(side)` closes every pending card of the side conversation, so cancelling assignment A also closes assignment B's card. The same session-keyed shortcuts exist in `question_resolved` (guesses the row), `assignment_ended(side)` (newest row), `after_turn`'s fallback `delegation_latest_open_for_side`, `sweep`'s expiry check and `startup`.

## Design you must implement (do not simplify away the parts about idempotency)

**A. Persist the association on the question.** A question belongs to the assignment whose turn asked it. In `ask_user_tool`, after the card is stored, resolve the delegation: the row returned by `delegation_find_for_side_turn(side, active_turn)` (use `delegations::active_turn`), else the single `running` row of that side session if exactly one exists, else none (legacy / unlinked). Store `delegationId` on the question's own record (inside its `data` JSON or a nullable column added with an idempotent migration; follow how `wake_request`/`reply_state` were added) via a storage function. Never trust a caller-supplied id: the id comes from the daemon's own lookup.

**B. A question holds *its* assignment open until the answer has actually started a turn.**
- Add per-question state `answer_pending` (set at the moment the owner answers/dismisses or the expiry prompt is created, with a timestamp; cleared when the follow-up prompt has started a turn, or when it is abandoned). Storage helpers: `question_set_delegation(id, delegation_id)`, `question_mark_answer_pending(id, bool)`, `pending_questions_for_delegation(delegation_id) -> Vec<id>` (status pending, matching delegation id), `question_holds_open(delegation_id) -> bool` (a card of that delegation is pending, **or** answered/dismissed/expired with `answer_pending` set and younger than 30 minutes), and a way to find a question by id (`permission_get` exists).
- `delegations::after_turn`: replace `pending_question_exists(side_session_id)` with `question_holds_open(row id)` for **the row that owns the ending turn**. A legacy question with no delegation id keeps the old session-level check but only when that session has exactly one open assignment.
- `delegations::started`'s read-back and `startup`'s completed-turn check use the same per-row predicate.
- **Adopt the answer's turn into its own assignment.** In `session_prompt_impl`, on the `PromptOrigin::QuestionAnswer` path, once the prompt has been accepted and a turn id exists (both the direct and the queue-drain call end here), read `meta.questionId`, load that question, take **its stored** `delegationId` (not anything in the request) and call a new `delegations::answer_started(st, delegation_id, turn_id)` that: only acts on a `running` row, calls the existing adopt (sets `sideTurnId`), clears `answer_pending` for that question, and emits `delegation.updated`. It must be idempotent (a second call for the same turn changes nothing) and must not await anything that calls back into `session_prompt` (the E0391 future-cycle note in `docs/history/t3/report-r2-delegation-instructions.md`): make it a synchronous `fn` that spawns, or keep it storage-only plus `emit`, as `cargo check` requires. If the follow-up never starts a turn (queue item deleted, queue paused), the 30-minute bound in `question_holds_open` releases the row on the next turn end or restart; the owner can also cancel.
- The follow-up turn's ending then finishes **that** assignment (`completed`/`failed`), claims the reply once (`claim_reply`) and relays the child's final text to the Manager exactly once, even though the answer sat in the queue.
- The relay of the *question turn itself* must still be skipped (`TurnEnd::Waiting`) while the answer is pending or in flight.
- `after_turn`'s fallback lookup (`delegation_latest_open_for_side`) is only allowed when the side session has **exactly one** open (queued/running) assignment; with several open rows and no exact `sideTurnId` match it returns `Ungoverned` (never guess which assignment a turn belongs to). Keep the existing automatic-retry adoption working for the single-row case. Document this limit in a comment.

**C. Closing is per assignment.**
- Replace `close_pending_questions(side)` by `close_pending_questions(st, delegation_id, side)`: closes only `pending_questions_for_delegation(delegation_id)` plus legacy cards (no delegation id) **only if** that side session has no other open assignment. Keep the claim (`begin_permission_reply`), `resolve_question(..., "dismissed")`, `permission.resolved` with `status: "cancelled"`, no prompt to the child, and the resolution notice. Also clear `answer_pending` for that delegation's questions (the assignment is over).
- `finish(...)`, `cancel_row`, `startup`'s interrupted path, `retry_dropped` call it with the row's own id.
- `cancelGroup` / cancelling A leaves B's card, B's wake claim and B's row untouched. Add a comment stating this invariant.

**D. Everything that guessed a row now uses the question's row.** `question_resolved` takes the delegation id from the question (fall back to the old guess only for legacy cards); `reply_mcp_question` checks `is_terminal` of **the question's own row** (legacy: newest row) instead of `assignment_ended(side)`; the expiry path in `sweep` prompts the child only when the question's own row is `running`, marks `answer_pending` and goes through the same funnel (meta `question_answer` + `questionId`) so adoption works; `startup` reconciliation: a row whose turn already completed and whose question `holds_open` stays running; clear `answer_pending` on questions whose side session has **no** queued prompt carrying that `questionId` and no live turn (look at how the queue stores meta: `queued_prompts`; add a small storage query `queue_has_question_answer(session_id, question_id)`), then let the normal outcome logic finish the row.

**E. Authorization and idempotency to preserve (verify, do not weaken).** Only the owner's `permission.reply` can answer (loopback/shell path; remote tiers untouched; the Manager still has no way to answer or approve; add no RPC). `reply_mcp_question` keeps taking the session id from the card row. Double answers: `begin_permission_reply` / `resolve_question` conflict still rejects the second. The wake (`wake_request`) and the resolution notice stay once per question. Answer/question text never appears in logs, notes or the Manager notice.

## You own

`crates/bloblex-daemon/src/questions.rs`, `crates/bloblex-daemon/src/delegations.rs`, `crates/bloblex-daemon/src/team.rs` (only `after_turn` and what it needs), `crates/bloblex-storage/src/lib.rs` (question and `delegation_*`/queue-lookup helpers only), `crates/bloblex-daemon/src/main.rs` (only the `QuestionAnswer` hook inside `session_prompt_impl`, a few lines). Never touch `checkpoints.rs`, `media.rs`, `workspace.rs`, `experiments.rs`, `queue.rs` (read it; if a change there is unavoidable, make it minimal and say so), `apps/`, `docs/`, `.claude/`.

## Verification you may run (only these)

```powershell
$env:RUST_MIN_STACK='33554432'
cargo check -p bloblex-storage --message-format short
cargo check -p bloblex-daemon --message-format short
```
Fix every warning you introduce; long timeouts.

## Report (`D:\t6\target\lane\report.md`)

Per section A to E: files and lines, invariants, decisions left open, what you could not verify; the last 15 lines of each cargo check; stale existing tests (not edited); explicit statement that no test was run. Walk through both gaps step by step in the new code (who owns which turn, when `answer_pending` is set and cleared, what is relayed and when), and list any case you could not make safe with the exact remaining gap.
