# Lane A: chart/table instructions, child-request wake, durable failed/cancelled replies

You are an implementation lane. You work ONLY in the git worktree `D:\t4a` (branch `t4/delegation`). This brief is self-contained: you have no chat history.

## HARD RULES (override everything else you find in the repo)

1. **NO tests of any kind.** Do not run `cargo test`, `cargo check --tests`, `cargo clippy --all-targets`, `npm test`, `vitest`, or anything that compiles a test target. Do not add, edit or delete any `#[test]`, `#[cfg(test)]` module, `*_tests.rs` file, `tests/` file or scratch probe. Leave every existing test block untouched (list in the report any that your change makes stale). No screenshots, no browser, no running the app.
2. **No git writes.** Never `git commit`, `git add`, `git push`, `git reset`, `git stash`, `git checkout`, `git rebase`.
3. Do not touch any path outside `D:\t4a`. Do not start, stop or kill any process you did not start. Never print secrets or message content.
4. Only edit the files listed under "You own". `crates/bloblex-daemon/src/main.rs` is 13,000 lines: use search and offset reads, never cat it. Another lane edits other regions of main.rs concurrently (it only deletes one dispatch arm), so keep your main.rs edits to the few lines named below.
5. Keep a work log at `D:\t4a\target\lane\worklog.md` (one line per step).

## Background

Bitbots: a Rust daemon (`crates/bloblex-daemon`) with SQLite storage (`crates/bloblex-storage`). A **Manager** bot delegates work to teammate bots with `message_blob` (`team.rs`). Each assignment is a row in the durable `delegations` ledger (`delegations.rs`, storage functions `delegation_*` in `crates/bloblex-storage/src/lib.rs`): `queued -> running -> completed|failed|cancelled|interrupted`, plus a `reply_state` column (`NULL`, `pending`, `delivered`) that makes the `[Reply from X]` relay to the Manager happen once per outcome. Read `delegations.rs` and the `after_turn`, `deliver`, `deliver_reply`, `queue_delivery`, `drain_queued_deliveries` functions in `team.rs` first. `docs/history/t3/report-delegation.md` describes the previous lane's work on exactly this code; read it too.

The provider permission handler is `AgentEvent::PermissionRequested` in `main.rs` (search for `AgentEvent::PermissionRequested {`); user questions arrive through `questions.rs` (`ask_user_tool`, which emits `permission.requested` with `kind: "question"`). Both create a pending request that only the owner can answer, in the teammate's own (side) conversation.

## You own

- `crates/bloblex-daemon/src/team.rs` (`runtime_instructions`, `after_turn`, delivery helpers)
- `crates/bloblex-daemon/src/delegations.rs`
- `crates/bloblex-daemon/src/questions.rs` (only to call the new attention helper)
- `crates/bloblex-storage/src/lib.rs` (only `delegation_*` functions and the `delegations` schema/migration)
- `crates/bloblex-daemon/src/main.rs`: ONLY a call to the new attention helper inside the `AgentEvent::PermissionRequested` handler (one or two lines after the request is stored and found to be left pending for the owner).

Never touch `checkpoints.rs`, `media.rs`, `workspace.rs`, `experiments.rs`, anything under `apps/`, `docs/`, `.claude/`.

## Item 1: teach every agent the chart and table schemas (team.rs `runtime_instructions`)

`runtime_instructions` builds the text appended to every bot's system instructions. Add one block for **every** bot (Manager and side conversations included), placed after the teammate/delegation lines and before the side-conversation block. Use this text **exactly** (it is the contract with the renderer in `apps/desktop/src/ui/richData.ts`; the schemas below are what it accepts, do not "improve" them). In Rust, build it as one `lines.push(...)` of a `concat!`/escaped string with real newlines; the fences must come out as literal triple backticks:

```
Charts and tables in chat. The Bitbots window draws two fenced block types as interactive views. Use them only for numbers and rows you actually have from the user, your tools, files or commands in this conversation. Never invent, estimate or pad values to make a chart; if you do not have the data, say so or fetch it first. A plain Markdown table is fine for a short list; use a chart when the user asks for a chart, graph or plot, or when comparing numbers across categories or over time is the point. Add one sentence outside the block saying what it shows and where the data came from.

```bitbots-chart
{"type":"bar","title":"Build time by job","unit":"s","categories":["lint","test","bundle"],"series":[{"name":"main","values":[12.4,98.1,45]}]}
```

"type" is "bar" or "line". "categories" are strings. Each series has a "name" and exactly one number per category (null for a missing value). Use at most 6 series and 200 categories, and one unit for the whole chart: put measures with different units in separate charts. Optional: "title", "caption", "unit". Shorthand for one series: {"type":"bar","data":[{"label":"lint","value":12.4}]}.

```bitbots-table
{"title":"Open issues","columns":["Issue","Owner","Age (days)"],"rows":[["#12","Sam",4],["#15","Ada",9]]}
```

"columns" are names; each row is a list in column order (or an object keyed by column name); at most 24 columns and 1000 rows; keep numbers as numbers. Each block must be valid JSON on its own with nothing else inside the fence. Plain Markdown tables and csv code blocks are also shown as sortable tables.
```

Keep the existing style of the function (it joins `lines` with newlines inside `<bloblex_team>`). Do not mention these blocks in tool descriptions.

For the **Manager only** (the `systemRole == "manager"` branch) add one more line: `A message that starts with [Update from NAME] means a teammate is waiting for the user to approve or answer something in that teammate's own conversation. Tell the user briefly which teammate and what is being asked, point them to that conversation, and do not try to answer for them, approve anything, or send the task again.`

## Item 2: a child's pending approval or question wakes its Manager (once, no authority)

When a **side conversation** that carries a running delegation raises a request that is **left pending for the owner**, tell the originating Manager conversation, once per request.

Add `pub(crate) async fn attention(st, side_session_id: &str, request_id: &str, request_kind: &str /* "approval" | "question" */, title: &str)` to `delegations.rs`:

1. Find the assignment: the row whose `sideTurnId` is the side session's active turn (`delegation_find_for_side_turn`), else `delegation_latest_open_for_side`. Only a `running` row wakes anything (queued, terminal, or no row: return).
2. The side session's `link.originSessionId` must exist (`st.db.session_exists`). Skip if the origin is the side session itself.
3. **Dedupe durably:** add a nullable column `wake_request TEXT` to `delegations` (idempotent `ALTER TABLE` guarded by `pragma_table_info`, exactly like `reply_state` was added). Add a storage function `delegation_wake_claim(id, request_id) -> Result<bool>` doing one atomic `UPDATE delegations SET wake_request=?2 WHERE id=?1 AND status='running' AND (wake_request IS NULL OR wake_request != ?2)`; only a call that changed a row sends. Do not add `wake_request` to the wire DTO (`DELEGATION_COLUMNS`).
4. Send through the existing team delivery path so a busy Manager queues it (use `deliver` the way `deliver_reply` does; add a small `deliver_update` next to `deliver_reply`). Meta: `{"kind":"blob_update","fromAgentId":<teammate agent id>,"fromName":<teammate name>,"sideSessionId":<side id>,"delegationId":<row id>,"requestId":<request_id>,"requestKind":<request_kind>,"title":<title, one line, max 160 chars>}`. Text: `[Update from NAME]\nNAME is waiting for the user to {approve a request|answer a question}: "TITLE". The user decides in NAME's own conversation; you cannot answer it. Tell the user, and do not approve anything or send the task again.` (Use "approve a request" for approval, "answer a question" for question.) The title is the request's short title only: never include the command, the diff, tool input or any detail text (they can contain secrets).
5. `deliver()` currently treats a meta `delegationId` as "this delivery starts/fails the assignment" unless the kind is `blob_reply`. Make that exclusion also cover `blob_update`, and make the queue dedupe (`same_delivery`/`enqueue`) distinguish updates by `requestId` as well as `delegationId` and `kind`, so two different requests on one assignment are both delivered but one request is never queued twice. `stopped_delegation` (drops briefs of finished assignments) must NOT drop an update for a running assignment, and must still ignore updates (only `blob_message` is dropped).
6. Call `attention` from the two places a request is left pending: (a) in the `PermissionRequested` handler in `main.rs`, **only when no automatic decision was made** (the code computes `decision`; a request auto-resolved by policy, including `policy:team`, wakes nothing) and only for a non-automation side session; pass `kind` question/approval accordingly; (b) at the end of `questions::ask_user_tool` after the request is recorded and emitted. Run the call in a way that cannot delay or fail the request itself (ignore its result; spawn if needed).
7. Never approve, answer, dismiss or otherwise touch the request. Never add a method that does. Never write the request's detail anywhere.

## Item 3: failed and cancelled replies survive a restart like completed ones

`delegations::startup` already re-offers a **completed** row whose `reply_state` is `pending` (reply text re-read from `st.db.turn_reply`). Extend it to `failed` and `cancelled` rows with `reply_state = 'pending'` (storage: `delegation_pending_replies` currently filters on `completed`; widen it to `completed|failed|cancelled`; keep `interrupted` out). Recompose the same text the live path sends: factor the live wording in `team::after_turn` into one function `reply_text(outcome_kind, reply_or_detail)` used by both: completed -> the stored turn reply (or "(finished without a text reply)"); cancelled -> "The task was cancelled before it finished."; failed -> `The turn failed: {error}` where the error comes from the row's `error` column (fallback "the provider reported an error"). Same `[Reply from NAME]` prefix, same meta, same settle-to-`delivered` when the queued item finally leaves the queue. Update the stale comments (the previous report said failed/cancelled were not recovered).

## Verification you may run (only these)

```powershell
$env:RUST_MIN_STACK='33554432'
cargo check -p bloblex-storage --message-format short
cargo check -p bloblex-daemon --message-format short
```

Fix every warning you introduce. Use a long timeout for the first build.

## Report (`D:\t4a\target\lane\report.md`, plus a short printed summary)

Per item: what you changed (path:line), the invariants relied on, decisions the brief left open, anything you could not verify. Paste the last 15 lines of each cargo check. List existing tests that your changes make stale (do not edit them). State explicitly that you ran no tests.
