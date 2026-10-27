# Lane V1 brief: durable Manager wake, turn-checked cancel, optional delegation pause

Worktree `D:\v1` (branch `lane/v1`), cut from `main` with the owner's dirty baseline **including the T7 wave** (read `docs/history/t7/REPORT.md` first, especially "Open gaps" 1, 2 and 7, and `report-u2-delegation-questions.md`). You are an OpenCode lane. The Director (Claude) reviews your diff and merges it. Lane V2 runs in parallel in `D:\v2` (queue and prompt failure classification, limited sessions); keep to your files.

## Hard rules (owner, 27 October 2026; they override the repo gates)

- **No tests of any kind.** No `cargo test`, `cargo check --tests`, `cargo clippy --all-targets`, `npm test`, vitest, app, browser, probe or screenshot. Do not add, edit or delete any test or `#[cfg(test)]` code. Allowed check: `cargo check -p bloblex-daemon -p bloblex-storage` (production targets). List in the report the existing tests (names only) that reference anything you changed.
- **No git writes** (commit, add, stash, reset, checkout, rebase, push, branch). Touch no other worktree and no running process. Never print secrets or message content; events, logs and stored wake data carry ids, counts and short titles only.
- Work log `target/lane/worklog.md` (update as you go); final report `target/lane/report.md`. Keep tool output small. Use this worktree's own `target`. `$env:RUST_MIN_STACK='33554432'`.
- Daemon owns decisions; no fabricated success; no claim of exactly-once anywhere (say "at most once per id, durable, idempotent on replay" and only what the code proves). Approval rules unchanged: the Manager can never answer or approve. If a case is ambiguous and cannot be made safe, mark it **unknown** and do not duplicate.

## Files you own

`crates/bloblex-daemon/src/delegations.rs`, `questions.rs`, `team.rs`, `proposals.rs`; in `main.rs` only `cancel_session_turn` (and a new sibling), the `validate_setting` arm for the new setting, and nothing else; in `crates/bloblex-storage/src/lib.rs` only the delegation, question and `permission_requests` functions and schema, plus the setting validation entry; `crates/bloblex-daemon/src/backup.rs` only for `SETTING_ALLOWLIST` (a fixed-size array: change its length constant too). **Do not edit** `queue.rs`, `retry.rs`, `session_prompt_impl`, `update_session_model`, adapters, `apps/`, `docs/`, `.claude/`.

## Item 1 (first priority): the child-question wake to the Manager survives a restart

### Evidence

- `delegations::attention` (`delegations.rs:~605-647`) claims `wake_request` on the assignment row (`delegation_wake_claim`) and then `spawn_update` -> `team::deliver_update` (`team.rs:~1012`) -> `team::deliver`, which sends at once or, when the Manager is mid-turn, puts the text in the **in-memory** `st.team.queued` (`queue_delivery`, `team.rs:~1023`). The claim is durable, the delivery is not: a restart after the claim and before the Manager's prompt loses the wake (T7 REPORT gaps 1 and 2). The request card itself stays visible (Needs you), so this is a lost notice, not a lost request.
- The completed/failed **reply** already has the pattern you must copy: `reply_state` (`pending` before delivery, settled by `settle_reply` after a real send), `claim_reply`, `delegation_pending_replies`, and the boot offer loop in `delegations::startup`. Read them end to end first.
- Privacy: the wake text carries only the request's short title (160 chars, one line) and the bot's name. Nothing else may be stored for it.

### Build

1. **Persist before sending.** Extend the claim so the pending wake is stored durably in the same statement/transaction as the claim: the row gets `wake_state` (`pending` | `sent` | `dropped`, NULL when none), `wake_title` (the already-shortened title, max 160), `wake_kind` (`question` | `approval`), alongside the existing `wake_request`. Additive columns in `ensure_delegation_schema` following the existing pattern (check `pragma_table_info`, `ALTER TABLE ... ADD COLUMN`), not exposed in the DTO except what the UI may need (nothing required).
2. **Ack only after a real delivery.** `spawn_update`/`deliver_update` returns a `Delivery`; settle exactly like replies: `sent` only when the Manager's prompt was actually accepted or the item was durably handed to the same path replies use; a queued-in-memory result stays `pending` until the in-memory item is sent (find where `team.rs` drains the queue and settles replies, and settle wakes there with the same hook). `dropped` when it is no longer meaningful.
3. **Recovery re-offer at boot** (`delegations::startup`, after the reply offers): for each row with `wake_state='pending'`: re-offer only if (a) the assignment is still `running`, (b) the request card is still `pending` (use `permission_get`; for an `mcp:` question that is `status='pending'`), (c) the origin (Manager) session still exists and is not archived/deleted, else mark `dropped` (cancelled/deleted parent is safe, nothing is sent). Re-offer through the same `deliver_update` path, once, then settle. A wake whose delivery outcome is unknown (the process died between `deliver` accepting and the ack) is the one ambiguous case: decide from the Manager's stored messages whether a `blob_update` message with `meta.requestId == request` already exists in the origin session (a cheap bounded lookup, add an indexed or `LIMIT 1` query); if it exists mark `sent`, if the lookup cannot tell, mark `dropped` and write nothing (never duplicate).
4. **Idempotent claim/ack.** The claim stays one atomic conditional UPDATE keyed on `(row, request_id)`; settling is conditional on `wake_state='pending' AND wake_request=?`; a late ack for an older request never overwrites a newer wake. A second request on the same row after the first was `sent` must still be announceable: keep today's semantics for "one wake per request" (check what `delegation_wake_claim` allows today and preserve it; if a row can only hold one wake request at a time, document that and make sure a new request id replaces a `sent`/`dropped` one but never a `pending` one it would lose: in that case return false and the older pending wake is delivered first by the re-offer or the live path).
5. **Terminal assignment.** When the row finishes (completed, failed, cancelled, interrupted) while a wake is `pending`, mark it `dropped` in `finish` so a late re-offer cannot announce a request of finished work.
6. **Privacy.** No question text, option or answer anywhere; log lines and events carry ids only.

## Item 2: cancel is checked against the turn it means to stop

### Evidence

- `delegations::cancel_row` (`delegations.rs:~860-900`) decides "the live turn is this row's own `sideTurnId`" and then calls `crate::cancel_session_turn(st, side)` (`main.rs:2550`). Between the two, the conversation's live turn can change (another assignment's brief or a retry starts), and `cancel_session_turn` cancels **whatever is live** and also calls `retry::cancel_pending(st, id, ...)` for the whole session before it takes the session gate (line 2553).
- `cancel_session_turn` takes the per-session gate (`gate_for_session`) and reads `st.active_turns`, `st.sessions`, `st.starting_cancels` inside it.

### Build

1. Add `cancel_session_turn_if(st, session_id, expected_turn_id)` in `main.rs` (keep `cancel_session_turn` as a wrapper that passes no expectation, so `session.cancel` is unchanged). Inside the same gate section, compare `st.active_turns.get(id)` with `expected_turn_id`; on a mismatch (no live turn, or a different one) cancel **nothing**, change no state, cancel no retry, and return a typed result (for example `Ok(json!({"cancellationRequested":false,"reason":"turn_changed"}))`). The retry cancellation (`retry::cancel_pending`) must happen only for the matching turn and after the check, not before the gate.
2. `cancel_row` calls the checked version with the row's `sideTurnId`; on `turn_changed` it re-reads the row and the live turn once and either (a) the row's turn ended meanwhile: end the row with the turn's own outcome as the existing branch does, or (b) another turn is live and it is not this row's: end only the row as cancelled without touching the session, exactly as the "no live turn of its own" branch does. Never loop.
3. Report the remaining window precisely (the adapter `cancel` after the gate is released can still race the turn ending by itself, which is harmless; say why), and whether `starting_cancels` (keyed by turn id) is already turn-scoped.

## Item 3 (optional extra, only after items 1 and 2 are done): pause new delegation

A global setting `delegation.paused` (boolean, default false). While true, a **new** Manager assignment (`team::delegate`) is refused with a plain sentence the Manager can relay ("Delegation is paused. Ask the user to resume it in Manager settings, or do the work yourself."). It must **never** touch running assignments, queued briefs already recorded, approvals, questions, replies, wakes or cancels, and the setting must not be reachable remotely (see `docs/history/t7/REPORT.md` for how `settings.set` is already `never` for remote). Add the key to `validate_setting` (boolean), `validate_setting_value` in storage if keys are listed there, and `backup::SETTING_ALLOWLIST` (fixed-size array: adjust its length). Reading it in `delegate` must be one cheap settings read, not a scan. Replays of an already-recorded assignment (the T7 dedupe) are returned before the pause check, so a pause never turns a replay into a refusal. If any step looks like it could disrupt current work, skip the item and say why in the report.

## Acceptance and report

- `cargo check -p bloblex-daemon -p bloblex-storage` clean, no new warnings.
- `target/lane/report.md`: per item evidence (`path:line`), the exact new contract (columns, states, events, error texts), an interleaving analysis for every concurrency point ("A does X while B does Y, therefore ..."), every decision this brief left open, **a list of cases left unknown or unverifiable, stated exactly**, existing tests that reference changed code (names only), last 15 lines of each `cargo check`. State nothing you did not read in code.
