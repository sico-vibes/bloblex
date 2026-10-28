# Lane B: remove the whole-turn undo; keep honest single-file checks

You are an implementation lane. You work ONLY in the git worktree `D:\t4b` (branch `t4/checkpoints`). This brief is self-contained.

## HARD RULES

1. **NO tests of any kind.** No `cargo test`, `cargo check --tests`, `cargo clippy --all-targets`, `npm test`, `vitest`, scratch probes. Leave every existing test block untouched (list stale ones in the report). No screenshots, no browser, no running the app.
2. **No git writes** (`commit`, `add`, `push`, `reset`, `stash`, `checkout`, `rebase`).
3. Touch nothing outside `D:\t4b`. Do not start or kill processes you did not start. Never print secrets.
4. Only edit the files under "You own". `main.rs` is 13,000 lines: search and offset reads only. Another lane edits other main.rs regions concurrently; keep your main.rs edit to the one arm named below.
5. Work log at `D:\t4b\target\lane\worklog.md`.

## Why

`session.checkpoints.revertTurn` (in `crates/bloblex-daemon/src/checkpoints.rs`) reverts several files of a turn in one call, newest first, stopping at the first failure. That can leave a turn half undone, the check and the apply are two separate git steps, and the daemon cannot rewind the provider's own conversation state (`providerStateRestore` is always false). The owner decided: do not offer a whole-turn restore. Keep the read-only per-file report and the existing single-file `file.revert`.

## You own

- `crates/bloblex-daemon/src/checkpoints.rs`
- `crates/bloblex-daemon/src/experiments.rs` (only if a helper becomes unused and would warn)
- `crates/bloblex-daemon/src/main.rs`: ONLY delete the dispatch arm `"session.checkpoints.revertTurn" => checkpoints::revert_turn(st, &p).await,` and keep `"session.checkpoints"`.

## Work

1. Delete `revert_turn`, its helpers (`refusal`, the NOT_ATTEMPTED/BUSY constants if unused) and the main.rs arm. No `git checkout/reset/stash/clean` anywhere.
2. In `session.checkpoints` keep the shape, with these changes so it cannot be read as a rollback feature:
   - `capability` becomes `{ "fileUndo": bool, "fileUndoReason": String|null, "providerStateRestore": false, "providerReason": String }` (rename `workspaceRestore` -> `fileUndo`, `workspaceReason` -> `fileUndoReason`; keep the same truth conditions: Git repository and Git usable). `providerReason` text: "Undoing a file does not change what the agent remembers of the conversation. Tell the agent if you want it to know."
   - Per file `state` stays `available|reverted|blocked`; rename nothing else. Blocked reasons stay plain sentences.
   - Add per file `"diffComplete": bool` (true when a complete saved diff exists: the same condition `reverse_file_check` uses to reject clipped/missing diffs; do not duplicate logic, derive it from the check's result being an error about the diff only if that is simple, else omit the field and say so).
3. In `experiments::reverse_file` (used by the existing `file.revert` arm), make the apply itself safer without changing its checks: run `git apply --reverse --check` immediately before `git apply --reverse` inside the same function call (it may already do so; verify and say so), and after a successful apply do nothing else. Do not change `file.revert`'s arm in main.rs.
4. Update the module doc comment of `checkpoints.rs` to say it is a read-only report and that undo is per file through `file.revert` only.

## Verification you may run (only these)

```powershell
$env:RUST_MIN_STACK='33554432'
cargo check -p bloblex-daemon --message-format short
```

## Report (`D:\t4b\target\lane\report.md`)

What changed (path:line), the new `capability` shape, what you verified in `reverse_file`, last 15 lines of the cargo check, stale tests (not edited), and an explicit statement that you ran no tests.
