# Lane U3 brief: restart truth, ambiguous sends, orphaned cards, bounded reads

Worktree `D:\u3` (branch `lane/u3`), cut from `main` with the owner's dirty baseline applied. You are an OpenCode lane. The Director (Claude) reviews your diff and merges it. Other lanes run in parallel: U1 (model switching, prompt idempotency: `update_session_model`, `session_prompt_impl` preamble, `queue.rs` add path) and U2 (delegations, questions, team, proposals, the `QuestionRequested` branch).

## Hard rules (owner, 27 October 2026; they override the repo gates)

- **No tests of any kind.** No `cargo test`, `cargo check --tests`, `cargo clippy --all-targets`, `npm test`, vitest, app, browser, probe or screenshot. Do not add, edit or delete any test or `#[cfg(test)]` code. Allowed check: `cargo check -p bloblex-daemon -p bloblex-storage` (production targets). List in the report the existing tests (names only) that reference what you changed.
- **No git writes** (commit, add, stash, reset, checkout, rebase, push, branch). Touch no other worktree and no running process. Never print secrets or message content; events and logs carry ids and counts only.
- Work log `target/lane/worklog.md`; final report `target/lane/report.md`. Keep tool output small. Own Cargo target. `$env:RUST_MIN_STACK='33554432'`.
- Preserve every cap and rate limit (queue max 20, retry caps `recovery_count<3`, automation limits, global concurrency). Never bypass a permission, never restart a provider while the user is acting, never silently abandon work, never auto-replay a send whose outcome is ambiguous.

## Files you own

`crates/bloblex-daemon/src/retry.rs`, `queue.rs` (everything except the `add` path, which U1 owns), the boot sequence and recovery code in `main.rs` between the `load_saved_runtimes` call and the `Router::new()` (around lines 4470-4500, plus the functions it calls that are only about boot), `automations.rs` (boot-only code), and in `crates/bloblex-storage/src/lib.rs` only the queue, boot-recovery and read-path functions you change. **Do not edit**: `update_session_model`, `session_prompt_impl`, `delegations.rs`, `questions.rs`, `team.rs`, `proposals.rs`, adapters, `apps/`, `docs/`.

## Item 1: an ambiguous queued send is never replayed by accident

Evidence: `queue.rs` module doc and `storage` `queue_*` functions (`UPDATE queued_prompts SET status='sending'` at the claim; the boot sequence rewrites `sending` items to `failed`, search `status='failed'` near the boot recovery in the storage crate). `queue_mark_failed`/`queue_resend` at `storage:~3336` lets a `failed` item go back to `sending`. A `sending` item whose process died may already have reached the provider.

Do: (a) make the error stored on an item rewritten at boot say plainly that Bitbots stopped while sending it and it may already have reached the agent, "Check the conversation before sending it again." (stable wording, no message text); (b) mark such an item with a field the UI can read (inside the item's JSON or a column, additive; for example `ambiguous: true` on the queue DTO) and make `session.queue.send_now` and `session.queue.update` that would resend an `ambiguous` item require `confirmResend: true` in the params, otherwise `derr("confirmation_required", ...)` with that sentence; (c) the DTO from `queue_list` carries `ambiguous`; (d) an item that failed with a definitive refusal (the provider/daemon rejected it before delivery) is unchanged. Report where each failure kind is written.

## Item 2: orphaned approval and question cards after a restart

Evidence to establish first (read, then write down): at boot, which rows of `permission_requests` can still be `pending`? A native provider approval or question card (Claude, Codex, ACP) is answered by calling the adapter with the provider request id; after a daemon restart that adapter process and request no longer exist, so an answer would go nowhere while the card still looks answerable. `ask_user` (MCP) questions are daemon-owned and expire through `questions::sweep`. Find out what the boot sequence does with pending native cards today (`rg "permission" crates/bloblex-daemon/src/main.rs` around the recovered-sessions code and `crates/bloblex-storage` functions that touch `permission_requests` at open).

Do: if native cards survive a restart as `pending`, close them at boot with a status the UI already understands (use the existing resolved/expired vocabulary; reuse `permission.resolved` with `status:"expired"` and a reason code `daemon_restarted`), skipping `mcp:` question cards (U2/`questions::sweep` own those) and cards of sessions whose provider handle is alive (none at boot). The transcript gets one content-free note via `team::note` ("Bitbots restarted, so this request is no longer waiting. Ask again if it still matters.") per affected session, once. If the code already does this, say so with `file:line` and change nothing.

## Item 3: the session state after a crash is true

Evidence to establish: after an unclean exit, what do sessions in `starting`, `working`, `cancelling`, `waiting_permission` become, and their open turns (`recovered_sessions`, `repaired_sessions` in `main.rs`; storage functions that produce them)? Check each is moved to a terminal truthful state with an `interrupted`-style turn outcome and emits `session.changed`, that no turn reservation (`active_turn_reservation_count`) leaks across restart (it must not count dead turns, or global concurrency slots are lost forever: verify where reservations live, memory or SQLite), and that a session left in `limited`/`continuation_pending` is handled by the existing recovery without exceeding `recovery_count<3`. Fix only proven gaps; report the rest.

## Item 4: bounded reads on hot paths

Find, by reading, the unbounded or repeated work on the paths the UI hits constantly: the snapshot/refresh RPC the desktop calls after every send (`rg '"app\.snapshot"\|"snapshot"' crates/bloblex-daemon/src/main.rs`), `session.list`, `session.get`, `session_event_summary`, and the per-turn-end hooks (`team::after_turn`, `queue::after_turn`, `delegations::after_turn`). For each, state what it reads and its complexity in sessions/messages. Fix clear wins that do not change a contract: missing indexes (additive `CREATE INDEX IF NOT EXISTS` in the migration path), a query that loads whole message bodies where only a count or id is used, an N+1 loop. Do not change any RPC result shape. Do not add caches that could serve stale data. Report what you left alone and why.

## Acceptance and report

- `cargo check -p bloblex-daemon -p bloblex-storage` clean, no new warnings.
- `target/lane/report.md`: per item: evidence (`path:line`), verdict, change, the interleaving analysis for any concurrency (who runs when, what the other side sees), new/changed contract (DTO fields, errors, events), decisions not specified, existing tests that reference changed code (names), gaps left, last 15 lines of each `cargo check`. State nothing you did not read in code.
