# Lane V2 brief: ambiguous sends are explicit and never auto-replayed; exhausted limited sessions stop polling

Worktree `D:\v2` (branch `lane/v2`), cut from `main` with the owner's dirty baseline **including the T7 wave** (read `docs/history/t7/REPORT.md` first, especially "Open gaps" 4 and 5, and `report-u1-model-and-commands.md` and `report-u3-restart-and-reads.md`). You are an OpenCode lane. The Director (Claude) reviews your diff and merges it. Lane V1 runs in parallel in `D:\v1` (delegations, questions, team, cancel); keep to your files.

## Hard rules (owner, 27 October 2026; they override the repo gates)

- **No tests of any kind.** No `cargo test`, `cargo check --tests`, `cargo clippy --all-targets`, `npm test`, vitest, app, browser, probe or screenshot. Do not add, edit or delete any test or `#[cfg(test)]` code. Allowed check: `cargo check -p bloblex-daemon -p bloblex-storage` (production targets). List in the report the existing tests (names only) that reference anything you changed (a storage test pins the boot error text `QUEUE_AMBIGUOUS_ERROR`; leave it).
- **No git writes** (commit, add, stash, reset, checkout, rebase, push, branch). Touch no other worktree and no running process. Never print secrets or message content; events, logs and stored data carry ids, counts and fixed sentences only.
- Work log `target/lane/worklog.md`; final report `target/lane/report.md`. Keep tool output small. Own Cargo target. `$env:RUST_MIN_STACK='33554432'`.
- Preserve every cap and rate limit (queue max 20, `recovery_count<3`, automation limits, global concurrency, permission modes). Never bypass a permission, never restart a provider under an active user action, never silently abandon work, never auto-replay a send whose outcome is ambiguous. If a case cannot be resolved safely from the code, mark it **unknown/ambiguous** and do not resend.

## Files you own

`crates/bloblex-daemon/src/queue.rs`, `retry.rs`; in `main.rs` only `session_prompt_impl` (its failure-classification and replay paths), `session_prompt_queued` / `session_prompt_for_question_answer` wrappers if they need the new error, and the watchdog/continuation call sites; in `crates/bloblex-storage/src/lib.rs` only the queue functions, the watchdog functions (`watchdog_due_sessions`, `watchdog_enqueue`, `watchdog_reset`, `watchdog_retry_idle` and neighbours) and message-by-client-id lookups. **Do not edit** `delegations.rs`, `questions.rs`, `team.rs`, `proposals.rs`, `cancel_session_turn`, `update_session_model`, adapters, `apps/`, `docs/`, `.claude/`.

## Item 1: a failure after the prompt may have been written is explicitly ambiguous

### Evidence

- `queue::send_claimed` (`queue.rs:~295-340`) claims an item (`sending`), calls `session_prompt`, and on error: a conflict is `queue_requeue`d, anything else `queue_mark_failed` with the error text, no marker (T7 U3 report, item 1 "Gaps left"). Only a daemon death while `sending` marks `ambiguous:true` (boot rewrite).
- `session_prompt_impl` (`main.rs`) reserves a turn, stores the user message (with `meta.clientMessageId` when given), calls the adapter's `prompt`, and finalises the turn as an error when the adapter fails. Which `Err` returns happen **before** anything could have reached the provider (validation, archived, active-turn conflict, preflight/option rejection, runtime missing, reservation refused) and which happen **after** `adapter.prompt` was invoked (adapter error, timeout, process death, no `PromptAccepted`)? Establish this from the code with `file:line`, listing every `return Err` / `?` from the reservation to the end of the delivery. Look at `accepted_turns` and how the post-delivery failure is recorded on the turn.
- T7 added `clientMessageId` replay in `session_prompt_impl`: a replay returns `{turnId, accepted:true, deduplicated:true}` for an existing message row. **That is wrong when the first attempt failed after the message row was stored**: the replay claims acceptance for a turn that ended in an error and may never have reached the provider.

### Build

1. A typed marker for "delivery unknown": introduce one error code, `delivery_unknown` (HTTP 409 for consistency with `confirmation_required`), returned by `session_prompt_impl` **only** for failures that happen after the adapter's `prompt` was invoked and before `PromptAccepted` was seen (or equivalent evidence of acceptance in the code). Definitive pre-delivery failures keep their current codes. If the code cannot tell for a specific path, treat it as `delivery_unknown` (never as definitive). The message is one fixed sentence: "Bitbots could not confirm that the agent received this message. It may have reached the agent. Check the conversation before sending it again."
2. `queue::send_claimed`: on `delivery_unknown` write the item `failed` with `QUEUE_AMBIGUOUS_ERROR` text (reuse the constant and the `ambiguous:true` marker the boot rewrite uses; add a storage method that marks failed+ambiguous in one statement, next to `queue_mark_failed`). Such an item is never auto-sent (the drain only claims `queued`; verify), stays pausing the queue like any failure, and resending still needs `confirmResend:true` (already implemented in `send_now` / `update`; do not weaken).
3. Replay fix for `session.prompt` with `clientMessageId`: when the stored message's turn ended in a `delivery_unknown`-class failure, a replay with the same id returns `delivery_unknown` (not `accepted`) unless the request carries `confirmResend:true`; with `confirmResend:true` the daemon sends it again as a **new** message under a fresh stored key (store the old key with a `superseded` marker or simply allow the new row to carry the same key but make `message_by_client_id` return the newest row; choose the least invasive option and make the replay rule deterministic). A definitive pre-delivery failure never stored a message row (verify) so a replay simply sends. Document the exact rule.
4. Anything auto-retried (`retry.rs`, watchdog continuation) must not resend a `delivery_unknown` turn automatically: check what `retry::after_failed_turn` does for such a failure class (it retries only classified overload/rate-limit hints today; confirm and make a `delivery_unknown` failure explicitly non-retryable, with a content-free note in the transcript if one is not written already).
5. Report the list of failure sites and how each is classified, and any site you left as unknown.

## Item 2: exhausted limited sessions stop hot re-polling and say so

### Evidence (T7 U3 report, item 3 "Gaps left")

- `watchdog_due_sessions` keeps returning a `limited` session whose window has passed while `watchdog_enqueue` refuses it because `recovery_count>=3`; `retry::sweep` (a 1 s loop) therefore re-queries and does nothing, for ever, and the session keeps a stale `limitedUntil`. `continue_on_activation` is a silent no-op after the third recovery with `continuation_pending` left at 1.

### Build

1. `watchdog_due_sessions` must not return sessions that can never be enqueued (exhausted, or automation); do it in the SQL so the sweep stops re-querying them. Preserve the cap exactly (`recovery_count<3`), manual resume, and the unattended/automation exclusions.
2. When a session's automatic continuations are used up, settle it **once** into an accurate, actionable state: clear `continuation_pending` and `limited_until` consistently, set the session state to `idle` (a user prompt is still accepted; confirm `session_prompt_impl` accepts a prompt for it and that a user prompt resets the counters via `watchdog_reset`, so manual resume works and the cap applies again afterwards), record `data.autoContinueExhausted=true`, append one content-free transcript notice (use `team::note`, fixed sentence: "Automatic continuation stopped after 3 tries. Send a message to continue.") and emit `session.changed`. This must happen in exactly one place, idempotently (a second call finds the flag and does nothing), and the same for `continue_on_activation`. Never for automation sessions (their rules stay).
3. Do not change `recovery_count`, the limits, or the unattended rules. Report precisely where the settle runs and the interleaving with a concurrent user prompt (the user prompt wins; the settle is conditional on the state still being `limited` / `continuation_pending=1`).

## Acceptance and report

- `cargo check -p bloblex-daemon -p bloblex-storage` clean, no new warnings.
- `target/lane/report.md`: per item evidence (`path:line`), exact contracts (error codes, texts, fields, storage changes), interleavings, decisions the brief left open, **every case left ambiguous or unverifiable stated exactly**, existing tests referencing changed code (names only), last 15 lines of each `cargo check`. State nothing you did not read in code.
