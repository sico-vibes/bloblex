# FIX39 P10 report — worktrees for parallel code tasks

> **What this is:** Report for FIX39 package P10: worktrees for parallel code tasks.
> **Status:** historical
> **Last updated:** 2026-10-18

Package: P10, `docs/history/fix-39/decisions.md` decision 7, recommendation 13 in
`docs/history/fix-40/t3-research.md` (T3 evidence `ThreadLaunchService.ts:56-61`,
`orchestrator-mcp-server.md:338-352`).

What it does: when a code-writing delegation targets a git project where another
task is already working, the daemon runs it in its own linked git worktree (a
sibling folder `<repo>-bitbots/<slug>` on a new `bitbots/<slug>` branch). When the
task's turn finishes the Manager proposes merging it back with an approval card
showing the branch, the files and a diff summary. On approval the daemon merges
(fast-forward or merge commit, never forced) and removes the copy and branch; on
reject the owner can keep the branch or discard it. Nothing is visible to the user
except the card and one line in the sub-conversation.

## Changes, by item

### 1. New git helper — `crates/bloblex-daemon/src/worktree.rs` (new)
- `repo_root` (`:82`) — the repository root for a folder, or `None` if the folder
  is missing or is not a git repo. `normalize` (`:88`) is the case- and
  separator-insensitive key used to compare folders on Windows.
- `create` (`:126`) — `<repo>-bitbots/<slug>` on `bitbots/<slug>` from `HEAD`.
  `slug` (`:112`) lower-cases to `[a-z0-9-]`, at most 40 characters, never empty;
  the name is made unique (`-2`, `-3`, …) if a folder or branch already exists. A
  detached HEAD is refused (the merge-back would be ambiguous), so the caller
  falls back to the shared folder.
- `inspect` (`:149`) — tracked changes (committed or not) plus untracked files and
  an insertion/deletion count; `Summary::line` (`:54`) renders
  `"N files changed, +X −Y"`.
- `commit_all` (`:172`) — stages and commits the task copy under a fixed
  `Bitbots <bitbots@localhost>` identity, so a merge has something to carry. A
  clean copy is a no-op.
- `merge` (`:204`) — verifies the copy, refuses a dirty main checkout, refuses a
  main checkout not on the stored base branch, does `--ff-only`, falls back to
  `--no-ff --no-edit`, and on any failure runs `merge --abort` and returns an
  error with nothing changed. Never forced.
- `remove_after_merge` (`:227`) / `discard` (`:237`) — remove the linked worktree,
  `worktree prune`, and delete the branch (`-d` after a merge, `-D` for an
  explicit discard).
- `verify` (`:182`) bounds both merge and discard to a real linked worktree of the
  named repo, checked out on a `bitbots/*` branch, living inside that repo's own
  `<repo>-bitbots` family. A forged or edited proposal cannot name any other
  folder or branch.
- Every git call is a plain argument list (never a shell) via the existing
  `experiments::git_command`; output is read only to branch on it and never logged.

### 2. Decide and isolate in `crates/bloblex-daemon/src/team.rs`
- `is_research_agent` (`:162`) — there is no "writes code" field, so the signal is
  the routing tag/role the Manager already uses: a bot tagged or roled as a
  researcher/reader/viewer is treated as read-only and never gets a worktree.
- `repo_is_busy_elsewhere` (`:175`) — true when another conversation with an
  active turn works in the same repository (same `git rev-parse --show-toplevel`).
  A task already in its own worktree does not count as a clash, because its
  toplevel is the worktree. All git runs off the async runtime (`spawn_blocking`).
- `prepare_worktree` (`:191`) — returns the worktree record, or `None` for a
  non-git project, a research bot, no clash, or any git error (the delegation then
  runs in the shared folder exactly as before).
- `delegate` (`:500`) — only for a **new** side conversation (a continued one
  keeps its folder). When `prepare_worktree` returns a record, the record is
  stored on the session link as `worktree` (`:549`) and the new session's
  `projectPath` is the worktree. The one visible line is posted to the
  sub-conversation (`:558`): *"Working in a separate copy of `<repo>` (branch
  `bitbots/<slug>`) so
  other work there isn't disturbed; the changes will be offered for merge when the
  task is done."*
- `after_turn` (`:790`) — calls `proposals::after_task_turn` after every turn, so
  a finished worktree task is offered for merge and an empty one is cleaned up.

### 3. New `merge` proposal kind — `crates/bloblex-daemon/src/proposals.rs`
- `describe` (`:376`) — `"merge bitbots/<slug> into <base>"`, so the Manager's
  handover and the decision notes name it.
- `validate_merge` (`:578`) — re-checks every field before git runs, because a
  decision may carry owner edits; the branch must be `bitbots/*`, files are capped
  at 50.
- `apply_merge` (`:622`) — manager check, then commit the copy and merge it
  (off-runtime), remove the copy and branch, and clear the conversation's worktree
  record. A dirty or mis-branched main checkout, or a conflict, returns a conflict
  error and leaves the proposal **pending**, so the owner can fix it and approve
  again.
- `after_task_turn` (`:650`) — on `turn.completed`, for a side conversation with a
  worktree record: if nothing changed, the copy is removed quietly with a one-line
  note and no card; otherwise a `merge` proposal is created on the Manager's
  conversation with the branch, files and diff summary. One offer per copy (a
  second completed turn does not stack another card). A cancelled or failed turn
  leaves the worktree in place.
- `decide` reject path (`:723`) — a rejected merge keeps the copy by default; with
  `discard: true` the copy and branch are discarded and the record cleared.

### 4. Storage — `crates/bloblex-storage/src/lib.rs` (outside the package list)
The `proposals.kind` column has a SQL `CHECK`, so a new kind is not just a Rust
whitelist change. Minimal edits:
- whitelist `insert_proposal` (`:1992`) accepts `merge`;
- the `CREATE TABLE` CHECK (`:707`) and the rebuild-migration CHECK (`:730`) include
  `merge`;
- the migration condition (`:722`) also rebuilds a table that predates `merge`;
- the existing migration test (`:7189`) now also inserts a `merge` proposal after
  the rebuild (`:7233`), proving an older database gains the kind.

### 5. UI merge card — `apps/desktop/src/ui/ProposalCard.tsx`
- `KIND_LABEL.merge` = "Merge a task" with a `GitMerge` icon (`:24`).
- `merging` (`:83`) hides the Edit button; the body shows the task, bot, branch,
  base branch, the diff summary and the file list; a hint explains the copy and
  merge (`:228`).
- Footer (`:236`): **Discard** (reject + `discard: true`), **Keep branch**
  (reject), **Merge** (approve). `decide` (`:100`) now forwards an optional
  `discard`.

### 6. Remote policy — `apps/desktop/src/remote/tiers.json`
Unchanged, deliberately. P10 adds **no daemon method and no event**: the merge is
decided through the existing `proposal.decide` (already `approve`/operator, subject
to the host's "approvals from remote" setting) and the card is delivered through
the existing `permission.requested` / `proposal.changed` events. The parity test
(`remoteTiers.parity.test.ts`) requires a row for every dispatched method and
forbids stale rows, so adding a row without a method would fail it — the same
position P6, P7, P9 and P11 recorded.

## Tests

Rust, all in the throwaway temp repos/temp DB the brief allows:
- `worktree::tests::slug_is_branch_safe_and_never_empty` (`worktree.rs:275`).
- `worktree::tests::repo_root_is_none_for_a_plain_folder` (`:283`).
- `worktree::tests::worktree_round_trip_merges_then_cleans_up` (`:291`) — create,
  change, commit, inspect, fast-forward merge, remove copy and branch.
- `worktree::tests::merge_refuses_a_dirty_main_checkout` (`:313`) — dirty main
  checkout is refused, nothing merged, the copy survives (the "say why" rule).
- `worktree::tests::discard_removes_the_copy_and_branch` (`:328`).
- `worktree::tests::a_copy_outside_the_task_folder_is_refused` (`:340`) — a copy
  outside `<repo>-bitbots` is never merged or discarded.
- `worktree::tests::a_forged_branch_is_refused` (`:357`).
- `team::p10_tests::p10_isolates_a_code_task_when_another_runs_in_the_repo`
  (`team_p10_tests.rs:59`) — another live task in the repo makes the delegation
  run under `<repo>-bitbots/add-login` on `bitbots/add-login`, with the one-line
  note in the sub-conversation.
- `team::p10_tests::p10_never_isolates_for_a_plain_folder_a_research_bot_or_no_clash`
  (`:79`) — no clash, non-git folder, and a research bot all stay in the shared
  folder; a coding bot with a clash isolates.
- `team::p10_tests::p10_a_finished_task_offers_a_merge_and_approval_merges_it`
  (`:123`) — the card carries the branch, files and summary; approval merges the
  file into main, removes the copy and clears the record.
- `team::p10_tests::p10_a_rejected_merge_keeps_the_copy_unless_discarded` (`:141`).
- `team::p10_tests::p10_a_task_with_no_changes_cleans_up_without_a_card` (`:164`).
- `bloblex-storage` migration test `a_pre_fix39_proposals_table_gains_the_permission_kind`
  (`lib.rs:7189`) extended to require the rebuilt table to accept a `merge` kind.
- UI: `ProposalCard.mounted.test.tsx` "merge card (P10)" — shows the branch,
  files and summary with no edit control and sends approve; "Keep branch" sends
  reject; "Discard" sends reject with `discard: true`.

The tests that commit inside a throwaway temp repo (the `worktree::tests` and the
`team::p10_tests` repo builders) skip when git is not on PATH; on this machine git
is present, so they ran.

## Gates (run to completion)

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — no `FAILED`/`panicked` lines. (A first run showed
  `phase2a_tests::session_environment_reports_a_git_branch` failing under
  full-workspace parallel load; it is the pre-existing 2-second git timeout in
  `main.rs:1956`, it passes alone and on both later full runs.)
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.
- `src-tauri` was not changed, so `cargo test -p bloblex-desktop --lib` was not
  required.
- `npx tsc -b` — clean.
- `npx vitest run --maxWorkers=3` — 172 files, 1280 tests passed.
- `npm run build` — ok.
- `npm run build:remote` — ok (run for safety; the remote app does not render
  proposal cards and no remote/tier file changed).

## Not checked

- Visual appearance of the merge card in the running app; only the mounted DOM
  test covers it.
- Live behaviour with real CLIs: the tests use the stub coding agent, so
  "another task is working" is simulated by an active turn, not by two real
  provider sessions.
- Continuing a side conversation after its worktree has been merged or discarded
  still points the resumed session at the removed folder. The brief requires the
  copy's removal, so this is left as-is; it was not exercised live.
- A merge conflict inside a real repo (only the dirty-checkout path is tested);
  the code path runs `merge --abort` and refuses.
- Remote devices do not render a merge card, so the remote path is only covered by
  the tier parity tests.

## Files touched outside the package list

- `crates/bloblex-storage/src/lib.rs` — required: the `proposals.kind` CHECK and
  whitelist rejected the new `merge` kind. Changes are the two CHECK lists, the
  migration condition and the whitelist, plus an extension of an existing
  migration test.
- `crates/bloblex-daemon/src/main.rs` — `mod worktree;` (`:56`) and the test-only
  `TeamAdapter` made `pub(crate)` (`:4607`) so the P10 integration tests can open a
  delegated conversation without a real CLI. No production behaviour changed.
- New: `crates/bloblex-daemon/src/worktree.rs`,
  `crates/bloblex-daemon/src/team_p10_tests.rs` (registered in `team.rs:934`).
- `apps/desktop/src/ui/ProposalCard.mounted.test.tsx` — tests for the merge card.

## Follow-up (audit)

The previous implementer ran out of usage after this report. I (the follow-up
implementer) finished the package: findings 1–3 (MUST FIX) and 4–7 (the last two
are report-only). Everything the audit listed as "right" is untouched, and no
change above is reverted. Each MUST FIX finding got a failing-first test; I
confirmed all three fail on the pre-fix code (temporarily reverting only the fixed
logic) and pass after the fix.

### Finding 1 — a follow-up runs in an existing folder, never a deleted one
- `crates/bloblex-storage/src/lib.rs:1868` — new `set_session_project_path(id,
  path)`, a small setter for a conversation's folder.
- `crates/bloblex-daemon/src/proposals.rs:602` — `finish_worktree` replaces
  `clear_worktree_record`: it drops the `worktree` record from the link **and**
  points the conversation back at the repository root. It is called wherever the
  copy is gone: after a merge (`:657`), after a discard (`:763`), when the folder
  was already missing (`:682`) and by the empty-copy cleanup (`:694`).
- Test `team::p10_tests::p10_a_follow_up_after_a_merge_runs_in_an_existing_folder`
  (`team_p10_tests.rs:166`): merge a task, then `delegate` to the same bot with no
  topic; it reuses the same side conversation and asserts `projectPath` is an
  existing directory. Fails on the old code (the path was the deleted copy).

### Finding 2 — queued or not-yet-started tasks count as "working"
- `crates/bloblex-daemon/src/team.rs:179` — `repo_is_busy_elsewhere` no longer
  reads only `active_turns`. It walks the sessions and treats one as busy when
  `session_busy` is true (the DB states `starting`, `working`,
  `waiting_permission`, `cancelling`) **or** it still has a delivery waiting in the
  in-memory queue (`team.queued`). The repo comparison is unchanged.
- Test `team::p10_tests::p10_isolates_when_the_other_task_is_queued_or_has_not_started_a_turn`
  (`team_p10_tests.rs:194`): (a) a stored `working` state with no live turn forces
  isolation; (b) with one global slot taken, the first delegation is queued
  (`started == false`) and the second still runs in its own copy. Fails on the old
  code at both points.

### Finding 3 — refuse while running; surface cleanup failures
- `team.rs` — the busy signal is `team::session_busy` (already public to the
  daemon), reused here.
- `proposals.rs:639` (`apply_merge`) — refuses with "That task is still working.
  Approve again when it finishes." when the task conversation is busy, leaving the
  proposal pending as other failures do.
- `proposals.rs:743` (`decide`, reject path) — a discard request is refused the
  same way **before** the rejection is recorded, so the card stays pending; a plain
  reject (keep the branch) is always allowed.
- `crates/bloblex-daemon/src/worktree.rs:233` `remove_after_merge` and `:245`
  `discard` now return whether the copy is actually gone. When it is not, the
  record is kept (never forgotten) and the note/summary says the copy could not be
  removed (`proposals.rs:661`, `:766`, `:698`). The empty-copy cleanup uses the
  same rule.
- Test `team::p10_tests::p10_refuses_a_merge_or_discard_while_the_task_is_still_running`
  (`team_p10_tests.rs:233`): seed a live turn, approve and reject-with-discard, and
  assert both are refused, nothing merged, the copy survives and the card is still
  pending. Fails on the old code (the merge goes through).

### Finding 4 — the dirty-checkout advice no longer misleads
- `worktree.rs:211` — reworded to say another task may still be working in the
  project folder, that untracked files count as dirty, and to merge once that work
  is saved and the folder is clean. The existing test still passes (it asserts
  "uncommitted changes").

### Finding 5 — expiry and repeated offers (recorded, no code change)
The audit marked this "no code change required". Recorded for the record: a merge
card that lapses after 24 hours leaves the copy and record in place; the next
completed turn re-offers a card, and a plain reject keeps the record so every later
completed turn re-offers it — reasonable for "keep branch". A copy nobody touches
again stays in `<repo>-bitbots` until the owner acts. The Manager's handover does
not yet list "worktrees awaiting merge"; that would be a Manager/UI change, not
this package, and was deliberately left out.

### Finding 6 — Remote discard is destructive (recorded for the threat-model owner)
`proposal.decide` has `params: null` in `apps/desktop/src/remote/tiers.json`, so an
operator device, with "approvals from remote" on, can send `discard: true` and run
`git branch -D`, the same authority as approving a merge; `worktree::verify` bounds
it to this repo's own `<repo>-bitbots` copy and a `bitbots/*` branch. This was
accepted by the audit and is recorded here so the remote threat-model owner sees
it. `tiers.json` is unchanged (P10 adds no daemon method or event).

### Finding 7 — tests that now prove the behaviour
Added, all in `worktree.rs:341` onwards, in throwaway temp repos:
- `a_merge_conflict_is_refused_and_leaves_main_clean` — the same line changed on
  both sides; the merge is refused, no `MERGE_HEAD` is left, main keeps its edit
  and the copy survives.
- `a_diverged_history_merges_with_a_merge_commit` — non-conflicting commits on both
  sides return "merge commit" and both files are present.
- `an_already_merged_branch_is_reported_not_remerged` — a second approval returns
  "already merged" and `remove_after_merge` reports the copy gone.
- The `active_turns`-only weakness of `p10_isolates_a_code_task…` is covered by the
  new finding-2 test above.

Two pre-existing test/production issues had to be fixed to make the diverged and
round-trip tests deterministic on this machine:
- `worktree.rs:221` — the `--no-ff` merge commit now runs under the same fixed
  `Bitbots <bitbots@localhost>` identity as `commit_all`, so a machine with no
  global git identity can still merge. This was silently broken before (the
  conflict test never reached it).
- `worktree.rs:307` (test) — the round-trip assertion compares against git's own
  toplevel (`created.repo`) instead of `temp_dir()`, which on this machine is the
  8.3 short form (`SICOVI~1`) while git prints the long one.

### Gates (rerun after the audit fixes, `TEMP=C:/fxt/d3/tmp`)
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — no `FAILED`/`panicked` lines (428 daemon tests, all suites ok).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.
- `npx tsc -b` — clean.
- `npx vitest run --maxWorkers=3` — 172 files, 1280 tests passed.
- `npm run build` — ok.
- `npm run build:remote` — ok.
- Targeted: `team::p10_tests::` 8 passed, `worktree::tests::` 10 passed.

### Still not checked
- The remote discard path above is only reasoned about, not exercised on a device.
- Live behaviour with two real CLIs (the tests still use the stub agent), and the
  visual card, as in "Not checked" above.
- The stale "Not checked" bullet about resuming in a removed folder is now
  addressed by finding 1: `finish_worktree` repoints the conversation at the repo
  root, and the finding-1 test proves the follow-up runs in an existing folder.

### Files I touched outside the package list
- `crates/bloblex-storage/src/lib.rs` — added `set_session_project_path` (the
  previous implementer's CHECK/whitelist change stays).
- No UI, remote, schema or `src-tauri` file was touched by this follow-up; the
  package's own `worktree.rs`, `team.rs`, `proposals.rs` and `team_p10_tests.rs`
  were extended.
