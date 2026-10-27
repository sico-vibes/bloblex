# Lane Q: let a delegated (side-conversation) bot ask the human a question, end to end

You are an implementation lane. You work ONLY in the git worktree `D:\t5` (branch `t5/child-questions`). This brief is self-contained.

## HARD RULES (override everything else in the repo)

1. **NO tests of any kind.** No `cargo test`, `cargo check --tests`, `cargo clippy --all-targets`, `npm test`, `vitest`, scratch probes. Do not add, edit or delete `#[test]`/`#[cfg(test)]` blocks, `*_tests.rs` or `tests/` (list any existing test your change makes stale in the report). No screenshots, browser or running the app.
2. **No git writes** (`commit`, `add`, `push`, `reset`, `stash`, `checkout`, `rebase`).
3. Touch nothing outside `D:\t5`. Do not start or kill processes you did not start. Never print secrets.
4. Only edit the files under "You own". `main.rs` is 13,000 lines: search and offset reads only.
5. Work log: `D:\t5\target\lane\worklog.md`.

## Background (read first: `questions.rs` completely, then `delegations.rs`, then `team.rs` `mcp_rpc`, `after_turn`, `runtime_instructions`)

The Manager delegates to teammate bots; each assignment is a row in the `delegations` ledger and runs in a **side conversation** (`link.kind == "side"`, `link.originSessionId` = the Manager's conversation). `ask_user` (`questions.rs::ask_user_tool`) is a non-blocking MCP tool: it stores a question card (a `permission_requests` row of `kind: "question"`), returns at once, the agent ends its turn, and the owner's answer comes back through `reply_mcp_question` -> `deliver_answer` as the session's **next prompt** (`session_prompt_for_question_answer`, meta `{"kind":"question_answer"}`). `delegations::attention(...)` (already written, already called at the end of `ask_user_tool`) wakes the Manager once per request with a `blob_update` message (title only). Today `ask_user` is refused in side conversations in two places, so none of this is reachable for a delegated bot. Make it work, safely.

Hard design facts you must respect:
- Only the **owner** answers a question. The Manager has no method to answer or approve; do not add one. The answer is delivered **only to the session that asked** (it already is: `reply_mcp_question` takes the question's own session id; keep it so, and verify the id used is the question row's `session_id`, not a caller-supplied one).
- A side conversation's turn that ended with a pending question is **not a finished assignment**. Today `delegations::after_turn` + `team::after_turn` would mark the assignment `completed` and relay the child's question text to the Manager as a "[Reply from X]". That must not happen.
- Unattended runs must never ask: automation and unattended-task sessions keep refusing `ask_user`; a side conversation whose **origin chain** is unattended (its origin conversation, or that one's origin, up to 4 hops, has `is_unattended(link)`) also refuses.
- Remote/permission tiers are unchanged: do not touch `apps/` or the tier table; do not add RPCs.

## You own

- `crates/bloblex-daemon/src/questions.rs`
- `crates/bloblex-daemon/src/team.rs` (`mcp_rpc` gating, `after_turn` guard, `runtime_instructions` side block)
- `crates/bloblex-daemon/src/delegations.rs`
- `crates/bloblex-storage/src/lib.rs` (only question/permission lookups and `delegation_*` helpers you need)
- `crates/bloblex-daemon/src/main.rs`: only if a one-line change is unavoidable; say so in the report.

Never touch `checkpoints.rs`, `media.rs`, `workspace.rs`, `experiments.rs`, `apps/`, `docs/`, `.claude/`.

## Work

### 1. Gate: when a side conversation may ask
Add `pub(crate) fn may_ask(st: &AppState, session: &Value) -> Result<(), &'static str>` to `questions.rs`: refuses archived sessions, automation links, unattended task links; for `link.kind == "side"` requires `link.originSessionId` to name an existing, non-archived conversation and walks the origin chain (max 4 hops, following each origin's `link.originSessionId`) refusing if any link in it `is_unattended`; every other kind as today. Use it in **both** places: `ask_user_tool` (replace the `match session["link"]["kind"]` refusals; keep the same refusal sentences for automation/task, and use "This assignment was started by a scheduled run, so there is no one to ask." for an unattended chain) and `team::mcp_rpc`'s `ask_user` boolean (the tool list and the call gate both read it; update the comment above it). The tool schema description may mention that the Manager is told.

### 2. A pending question holds the assignment open
- Storage: add `pending_question_exists(session_id) -> bool` (a `permission_requests` row for that session with kind question and status pending; follow how `insert_question`/`resolve_question` store them) and `pending_questions_for_session(session_id) -> Vec<id>`.
- `team::after_turn`/`delegations::after_turn`: when the ending turn is `turn.completed` **and** the side session has a pending question, the assignment stays `running` (do not finish it, do not claim or send the `[Reply from X]` relay; return a new `TurnEnd` variant, e.g. `Waiting`, and make the relay code skip it). Log nothing with content. The row must keep its `sideTurnId`; the answer's next turn is adopted by the existing "adopt a new turn id for a running row" logic in `after_turn` (read it; extend only if needed, bounded and idempotent). A cancelled or failed ending is unaffected.
- The answer's follow-up prompt must reach the child as before (`deliver_answer`): after it starts a turn, that turn's ending completes the assignment and relays the child's final reply to the Manager (the existing path). If `deliver_answer` queues instead of prompting (session busy / global limit), the existing drain handles it; do not change that.
- **Dismissal** (the owner dismisses) behaves the same as an answer: the child gets the existing DISMISSED prompt and continues; its next turn ends the assignment.
- **Expiry:** `questions::sweep` currently only writes a notice to the child session. For a **side** session with a running assignment, also deliver the child a prompt (same mechanism as dismissal, text: "Your question expired without an answer. Continue without it, or say what is blocked.") so the assignment can finish instead of staying `running` forever. For non-side sessions keep today's behaviour exactly.
- **Cancellation:** in `delegations::cancel_row` (both the queued and running paths) and wherever a running assignment is finished as `cancelled`/`failed`/`interrupted` for a side session, resolve that session's pending questions as `dismissed` **without** delivering any prompt, and emit `permission.resolved` with `{"permissionId": id, "choice": "dismissed", "status": "cancelled"}` so the card disappears. In `reply_mcp_question`, if the question's session is a side session whose newest assignment is terminal (`cancelled|failed|interrupted|completed`), resolve the question as dismissed, deliver nothing, and return a conflict "This assignment has ended, so the question was closed." (the owner learns why). Startup (`delegations::startup`) must also close pending questions of side sessions whose row it marks `interrupted`.

### 3. Parent visibility without authority
- Wake: already done by `attention`; keep it exactly once per question id (the existing `wake_request` claim). No change except that it now fires.
- Resolution notice: when a side session's question is answered, dismissed, expired or closed, write one **non-waking notice** into the originating Manager conversation with `team::note` (it must not start a Manager turn): content `NAME's question was answered.` / `...was dismissed.` / `...expired without an answer.` / `...was closed because the assignment ended.`; meta `{"kind":"question_resolved","fromAgentId","fromName","sideSessionId","delegationId","requestId","outcome":"answered|dismissed|expired|closed"}`. Never include the question text, the options or the answer text: the owner's answer stays between the owner and the child (the child's final reply reaches the Manager the normal way). Put this in `delegations.rs` as `pub(crate) async fn question_resolved(st, side_session_id, request_id, outcome)` (no-op without a side link/origin; once per `(requestId, outcome)` is enough because each question resolves once).
- Be careful with the future-type cycle documented in `docs/history/t3/report-r2-delegation-instructions.md` (E0391): `attention` is called through a synchronous spawner for that reason. Call `question_resolved` from `reply_mcp_question`/`sweep`/`cancel_row` through a similar synchronous `fn` that spawns, if `cargo check` reports a cycle.

### 4. Instructions
In `runtime_instructions`' side-conversation block add: `If you need a decision or information only the user can give, use the ask_user tool, then end your turn. Your Manager is told you are waiting, but only the user can answer; their answer arrives as your next message. Do not ask the Manager to answer for the user.`

## Verification you may run (only these)

```powershell
$env:RUST_MIN_STACK='33554432'
cargo check -p bloblex-storage --message-format short
cargo check -p bloblex-daemon --message-format short
```
Fix every warning you introduce. Use long timeouts.

## Report (`D:\t5\target\lane\report.md`)

Per item: files and lines changed, invariants relied on, decisions the brief left open, anything unverified; last 15 lines of each cargo check; existing tests your change makes stale (not edited); an explicit statement that you ran no tests. Say exactly how a delegated question flows: ask -> card -> wake -> answer -> child turn -> completion, and which cases (queued answer, expiry, dismissal, cancel, restart) you handled.
