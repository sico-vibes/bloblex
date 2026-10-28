# Lane DELEGATION: harden the Manager delegation ledger, add stop RPCs and a workspace report

You are an implementation lane. You work ONLY in the git worktree `D:\t3d` (branch `t3/daemon`). This brief is self-contained: you have no chat history.

## HARD RULES (override everything else you find in the repo)

1. **NO tests of any kind.** Do not run `cargo test`, `cargo check --tests`, `cargo clippy --all-targets`, `npm test`, `vitest`, or anything that compiles a test target. Do not add, edit or delete any `#[test]`, `#[cfg(test)]` module, `*_tests.rs` file, `tests/` file, `*.test.ts(x)` or scratch probe/SQLite experiment. Leave every existing test block untouched, even if your change makes it stale (say so in the report instead). No screenshots, no browser.
2. **No git writes.** Never `git commit`, `git add`, `git push`, `git reset`, `git stash`, `git checkout`, `git rebase`. Leave changes in the working tree.
3. Do not touch any path outside `D:\t3d`. Do not start, stop or kill any process you did not start. Never print secrets or message content in logs.
4. Only edit the files listed under "You own". If another file must change, say so in the report.
5. Keep tool output small (pipe cargo through `--message-format short`; never cat whole big files: `crates/bloblex-daemon/src/main.rs` is 12,900 lines, so use search and `sed -n`/Read with offsets). Keep a work log at `D:\t3d\target\lane\worklog.md` (one line per step).

## Background you need

Bitbots is a Tauri desktop app; a Rust daemon (`crates/bloblex-daemon`, binary `bitbotsd`) owns sessions, turns, SQLite storage (`crates/bloblex-storage`). The daemon exposes JSON RPC methods through `dispatch()` in `crates/bloblex-daemon/src/main.rs` (look for `"delegation.list" => delegations::rpc(st, method, &p).await` near line 831; errors use `derr(code, message, StatusCode)`).

The **Manager** bot delegates work to teammate bots with a `message_blob` tool (`crates/bloblex-daemon/src/team.rs`, the function around line 560-625 records a row, then `deliver()` ~line 730 prompts the teammate's "side conversation" or queues the brief until the teammate is idle). Each assignment is one row in the durable `delegations` table (`crates/bloblex-daemon/src/delegations.rs` + `bloblex-storage/src/lib.rs` `delegation_*` methods near line 3417-3540): status `queued -> running -> completed|failed|cancelled|interrupted`. When the teammate's turn ends, `team::after_turn` (team.rs ~line 815) calls `delegations::after_turn`, then relays "[Reply from X] ..." back to the Manager's conversation (`deliver(origin, ...)`), which starts the Manager's next turn.

Read `delegations.rs` completely first (it is 195 lines), then the callers listed above.

## You own (and may edit)

- `crates/bloblex-daemon/src/delegations.rs`
- `crates/bloblex-daemon/src/team.rs` (delegation-related code only: `deliver`, `queue_delivery`, `restore_queued`, the drain, `after_turn`, and the queue struct; do not restructure unrelated Manager tools)
- `crates/bloblex-storage/src/lib.rs` (only `delegation_*` functions, the `delegations` schema/migration, and `StorageError` if needed)
- `crates/bloblex-daemon/src/workspace.rs` (NEW file, for item 4)
- `crates/bloblex-daemon/src/main.rs`: ONLY (a) the `mod workspace;` line next to the other `mod` lines, (b) new dispatch arms next to the existing `"delegation.list"` arm and next to `"session.repository"`. Do not change anything else in main.rs. Another lane edits other parts of main.rs at the same time; keep your main.rs edits to those few lines so they merge.

Never touch: `media.rs`, `checkpoints.rs`, `experiments.rs`, `repository.rs`, anything under `apps/`, `docs/`, `.claude/`.

## Work items

### 1. Fix the started/terminal race (correctness)

Race: `deliver()` calls `session_prompt_for_team(...)` and only afterwards calls `delegations::started(id, turn_id)`. A very fast turn can finish and call `delegations::after_turn` *before* `started` runs. At that moment the row is still `queued`, and `after_turn` ignores non-`running` rows (`if row["status"] != "running" { return; }`). Then `started()` flips the row to `running` and nothing ever ends it: the card says "working" forever.

Fix it in `delegations::started`: after marking the row running, re-read the side session's turn `turn_id`; if that turn is already in a terminal state, finish the row at once with the same outcome mapping that `stopped_outcome()` uses (completed / cancelled / failed with the failure message; a turn whose `watchdogInterrupted` flag is set counts as interrupted). Keep it bounded and idempotent (`delegation_mark_terminal` already never rewrites a terminal row). Also make `delegations::after_turn` safe when it finds a `queued` row whose delivery text was just accepted for this very turn: do not guess; rely on the `started` re-read. Document the invariant in a short comment.

### 2. Durability and duplicates

Audit these and fix real defects (report what you checked even if it was already fine):
- `startup()` re-queues `queued` rows via `restore_queued`: make sure one row can never be delivered twice (for example after `restore_queued` plus a row that is also still in the in-memory queue, or a retry that re-delivers the same `delegationId`). Add an idempotency guard keyed by `delegationId` in the team queue push path (`queue_delivery` / `restore_queued` / `requeue_front`): if an item with the same `delegationId` is already queued for that side session, do not add a second one.
- A delivery that the user cancelled (status `cancelled`) must never be delivered when it later reaches the front of the queue: when the drain pops an item whose `delegationId` row is already terminal, drop it silently.
- The reply relay (`[Reply from X]`) must be sent once per terminal outcome. If `after_turn` is invoked twice for the same turn, the second call must not re-send. (Look for an existing guard first.)
- Result durability: the reply to the Manager is queued in memory when the Manager is busy. After a daemon restart that queue is lost. Make the relay durable in the simplest honest way: when the assignment reaches a terminal state and the reply could not be delivered immediately (the Manager was busy and the item was queued), record on the row (`reply_state`: `pending` | `delivered`) and have `startup()` re-offer a `completed` row whose `reply_state` is `pending` exactly once. If this requires a new nullable column on `delegations`, add it with an idempotent migration in the same place the table is migrated (follow how other columns were added; grep `ensure_tasks_schema` and `ALTER TABLE`). Keep stored text bounded (the reply text is read from `st.db.turn_reply` again at recovery; do not store the reply in the row). If you decide this is too risky, do not do it, and explain why in the report.

### 3. Stop RPCs (individual and group)

Add to `delegations::rpc` and register the arms in `main.rs` next to `"delegation.list"`:

```
delegation.cancel       { "delegationId": String }
  -> { "delegation": <dto> }
delegation.cancelGroup  { "originSessionId": String, "originTurnId": String }   // originTurnId may be null/absent only if you also accept "delegationIds": [String]
  -> { "delegations": [<dto>] }          // the rows after the attempt, oldest first
```

Semantics:
- `queued` row: remove its item from the in-memory team queue (match `meta.delegationId`), clear the stored delivery text, mark `cancelled`, emit `delegation.updated`. The brief is never delivered.
- `running` row: cancel the side conversation's active turn **only if** that turn is the one this row owns (`sideTurnId` equals the side session's currently active turn). Use the same cancel path the `"session.cancel"` RPC arm uses (read that arm in main.rs, ~line 1183; call the shared helper it uses rather than duplicating it; if there is no helper, extract a small private `pub(crate) async fn cancel_session_turn(st, session_id)` in main.rs: this is the ONE extra main.rs change allowed). The row becomes `cancelled` through the normal `after_turn("turn.cancelled")` path; do not force-mark it before the turn actually ends, but if the side session has no active turn at all, mark it `cancelled` directly.
- Terminal rows: return them unchanged (not an error). Unknown id: `not_found`. Wrong shape: `invalid_argument`.
- The group call applies the same rule to every non-terminal row with that `originSessionId` and `originTurnId`. It must not touch rows of other origin turns or other Manager conversations.
- Cancelling a delegation must never cancel the Manager's own turn.

### 4. Workspace report (new file `workspace.rs`, new RPC `session.workspace`)

Contract (the UI is being written against exactly this; keep names and nullability):

```
session.workspace { "sessionId": String }
  -> {
       "sessionId": String,
       "mode": "shared" | "isolated" | "unknown",
       "projectPath": String,                 // the conversation's working folder as stored
       "isGit": bool,
       "repoRoot": String | null,
       "branch": String | null,               // current branch (git rev-parse --abbrev-ref HEAD); null when detached or unknown
       "head": String | null,                 // short commit
       "worktree": { "path": String, "branch": String, "base": String, "baseCommit": String, "repo": String } | null,   // from session link.worktree when mode == "isolated"
       "isolationFailure": String | null,     // a plain sentence when isolation was wanted but did not happen; null otherwise
       "sharedWith": [ { "sessionId": String, "agentId": String, "state": String } ]   // OTHER non-archived conversations whose projectPath canonicalizes to the same folder AND that are working (state starting/working/waiting_permission) — evidence only, may be empty
     }
```

Rules:
- `mode == "isolated"` only when the session's `link.worktree` object exists AND its `path` equals the session's `projectPath` (canonicalized, case-insensitive on Windows). Otherwise `"shared"` for any git or non-git folder that is simply the project folder, and `"unknown"` only if the session has no project path.
- `isolationFailure`: today `prepare_worktree()` in team.rs (~line 560) silently returns `None` when it cannot make a worktree and the delegation then runs in the shared folder. Make that failure visible: when `prepare_worktree` returns `None` *for a reason* (git missing, folder not a repo, dirty/unsupported state, `git worktree add` failed), store a short plain-English reason in the new side conversation's `link` as `"worktreeError"` (a string, one line, max 200 chars, no paths of the user's home directory, no command output beyond the first line), and surface it here. Look at `prepare_worktree` and `crate::worktree` to see which cases return None; distinguish "not applicable" (a non-git folder, or no other task is working there, which is NOT a failure and gets no `worktreeError`) from "tried and failed" (which does). If the function cannot tell the cases apart without a big refactor, record a failure only for the "git worktree add failed" and "git unavailable" branches and say so in the report.
- All git calls: plain argument lists via the project's existing helper for git commands (grep `fn git_command` in `crates/bloblex-daemon/src/` and reuse it), `current_dir` set to the project folder, no shell, run inside `tokio::task::spawn_blocking`, output read only to branch on it and never logged. Bound runtime (a stuck git must not hang the RPC: use the existing timeout pattern if the helper has one, otherwise cap with `tokio::time::timeout(Duration::from_secs(5), ...)`).
- Never write to the repository or the worktree. Read-only.
- Register `"session.workspace" => workspace::rpc(...)` (or a free async fn) in main.rs next to `"session.repository"`.

## Verification you may run (only these)

From `D:\t3d`:

```powershell
$env:RUST_MIN_STACK='33554432'
cargo check -p bloblex-daemon --message-format short
cargo check -p bloblex-storage --message-format short
```

`cargo check` without `--tests` is allowed. Fix every warning you introduce. The first build can take many minutes: use a long timeout. Do NOT run clippy with `--all-targets`.

## Report (write to `D:\t3d\target\lane\report.md`, print a short summary)

Per work item: what you found, what you changed (path:line), the invariants you rely on, decisions the brief did not specify, and what you could not verify (you cannot run the app). Include the last 15 lines of each `cargo check`. List every existing test or test-fixture that your change makes stale or that calls a function whose signature you changed (do not edit them). State explicitly that you ran no tests.
