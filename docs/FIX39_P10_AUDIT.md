# FIX39 P10 audit — worktrees for parallel code tasks

Auditor: Claude Sonnet 5.5. Read: `AGENTS.md`, `docs/FIX39_DECISIONS.md` (P10, line 113), `docs/FIX40_T3_RESEARCH.md` rec. 13, `docs/FIX39_P10_REPORT.md`, and the full diff plus the untracked `worktree.rs`, `team_p10_tests.rs`. I did not re-run the gates: the report's results are plausible and the one flaky test it names is pre-existing.

## Verdict: PASS WITH FIXES

The design is sound and the git handling is careful. Findings 1 to 3 must be fixed before merge. Each is small. Findings 4 to 7 are optional.

What is right, so Sol does not touch it:
- Every git call is an argument list through `experiments::git_command` (hidden window on Windows), and its output is never logged. The worktree record holds paths, a branch and a commit, with no conversation text.
- `verify` bounds merge and discard to a registered linked worktree of the named repo, inside `<repo>-bitbots`, on a `bitbots/*` branch. `discard` runs it too. The forged-branch and outside-folder tests are real behaviour tests.
- Merge refuses a dirty or wrong-branch main checkout, never forces, and aborts on conflict. A failed approve leaves the proposal pending. That matches the existing "fix the card and retry" rule in `decide`.
- Remote: no new method or event, so `tiers.json` is correctly unchanged. `permission.requested` is already path-reduced by `remote/policy.rs:649-652`. No credentials, recap text or command text in payloads or logs. The commit message is the fixed `Bitbots task <slug>`.
- Storage: both `CHECK` lists, the whitelist and the rebuild condition are updated. The extended migration test fails on the old code, because the rebuilt table would reject `merge`.
- UI: the merge card reuses the existing proposal classes. `.proposal-value.mono` exists (`proposalCard.css:19`). There are no star or sparkle icons (`GitMerge` only), and there is no new CSS to theme.
- Scope: `storage/lib.rs` is justified, and the `pub(crate) TeamAdapter` in `main.rs` is test-only. `docs/FIX39_AUDIT_IMPL_BRIEF.md` shows as modified, but it is not in the report and is not a Sol change, so leave it out of the merge.

## Findings

### 1. MUST FIX — a follow-up to a merged or discarded task runs in a folder that no longer exists
`crates/bloblex-daemon/src/proposals.rs:249-256` (`apply_merge` cleanup), `:723-724` (discard), `team.rs:517-531` (`delegate`, existing branch).

After merge or discard, the side session's `projectPath` is still `<repo>-bitbots/<slug>`, which has been deleted. `delegate` reuses the latest side conversation with the bot whenever no topic or id is given (`side_session_for`, `storage/lib.rs:1872`). A natural next step is the Manager saying "ask Builder to also fix X", and the Manager does that right after a merge. That follow-up resumes a session whose cwd is gone, so the CLI spawn fails. The report lists this under "Not checked" and says the brief requires removal. Removing the copy is required. Leaving the session pointing at it is not.

Fix, either one:
- (preferred) Add a small storage setter for the session's project path. On merge and on discard, set it back to the repo root. The record is already cleared by `clear_worktree_record`, so this finishes the job.
- Or, in the `Some(side)` branch of `delegate`, if the stored `projectPath` is not a directory, start a fresh conversation instead of resuming.

Add a test that merges, then delegates again to the same bot with no topic, and asserts the resulting session's `projectPath` is an existing directory. This fails on the current code.

### 2. MUST FIX — the "another task is working" check misses tasks that are queued or have not started a turn yet
`team.rs:174-185` (`repo_is_busy_elsewhere`), `team.rs:566` (queueing).

The check reads only `st.active_turns`. `session_busy` (`team.rs:404`) also counts DB states `starting`, `working`, `waiting_permission` and `cancelling`. Worse, `delegate` creates the side session, then spawns `deliver` and returns. When the global concurrency limit is full, the first task is queued with `started=false` and has no active turn. A second delegation to the same repo then sees no clash, and both later run in the shared folder. That is the exact failure P10 exists to prevent, and it appears at the moment of highest load.

Fix:
- Treat a session as busy if `session_busy` is true. This covers the DB states.
- Also treat it as busy if it has a queued or pending delivery. Use whatever the queue exposes: the durable queue, or a side session in the repo that was created by `delegate` and has not yet completed a turn.
- Compare against the repo toplevel as now.

Add a test where the first delegation is queued (`started == false`) and the second still isolates. The current test only seeds an `active_turns` entry, so it cannot catch this.

### 3. MUST FIX — merge or discard while the task is still running, and cleanup failures are swallowed
`proposals.rs:249-256`, `:723`, `worktree.rs:227-246`.

The card is offered at the first `turn.completed`. Delegations are multi-turn, because replies, steering and queued messages all continue in the same copy. If the owner approves while the side conversation is mid-turn:
- the final `git add -A` and commit race the bot's edits;
- on Windows `git worktree remove --force` fails on a folder the CLI holds open;
- `remove_after_merge` ignores that failure, then `branch -d` also fails because the branch is still checked out;
- the record is cleared anyway, leaving an orphan folder and branch that nothing tracks.

The discard path does the same and still posts "Rejected".

Fix:
- In `apply_merge` and the discard path, refuse with a clear message ("That task is still working. Approve again when it finishes.") when `team::session_busy(st, conversation)` is true. On approve this leaves the proposal pending, as other failures do.
- Have `remove_after_merge` and `discard` return whether the folder is gone. If it is not, keep the record and say the copy could not be removed.
- Cover the busy refusal with a test: seed an active turn for the conversation, approve, and assert that nothing merged and the proposal is still pending.

### 4. Optional — the dirty-checkout message can lead the owner to disturb the other task
`worktree.rs:207-209`.

The worktree exists because another task is editing the shared folder. So the main checkout is dirty exactly in the case P10 covers, and the merge is refused until that other task finishes. The advice "Commit or stash them" could make the owner stash a running bot's files. Reword to say that another task may still be working in the project folder, and to merge once it is done. Untracked files also count as dirty (`is_dirty`, `:100`), which is stricter than needed for most merges. That is acceptable, but note it in the message.

### 5. Optional — expiry and repeated offers
`proposals.rs:261-293`.

A merge card that lapses after 24 hours leaves the copy and record in place. The next completed turn re-offers a card, but a copy no one touches again stays forever. A plain reject also keeps the record, so every later completed turn re-offers. That is reasonable for "keep branch". Say so in the status notes, or add a "worktrees awaiting merge" line to the Manager's handover. No code change is required.

### 6. Optional — Remote discard is destructive
`proposal.decide` has `params: null` in `tiers.json:334-338`, so an operator device, when "approvals from remote" is on, can send `discard: true` and run `branch -D`. This is the same authority as approving a merge, and `verify` bounds it. Accept it, but record it in the report so the threat-model owner sees it.

### 7. Tests that do not yet prove behaviour
- No test covers a real merge conflict or the `--no-ff` fallback (`worktree.rs:216-221`). The report admits the conflict path is untested. Add one temp-repo test: change the same line on `main` and on the task branch, approve, and assert an error with `merge --abort` leaving main clean, plus a non-conflicting diverged case that returns "merge commit".
- No test covers the `already merged` shortcut (`:214`).
- `p10_isolates_a_code_task…` seeds `active_turns` by hand, so it proves the decision for one source of busyness only (see finding 2).

## Checked and fine
- Windows path handling: git prints forward slashes, `normalize` lower-cases and unifies separators, and `verify` compares normalized registered worktree paths. The family-folder comparison is lower-cased.
- The slug is ASCII-only, at most 40 characters and never empty, so it is safe as both a branch and a folder name.
- Hot files: `team.rs` and `proposals.rs` changes are additive and short. `storage/lib.rs` is limited to the CHECK lists. `App.tsx` and `TeamSidebar.tsx` are untouched.
- Both looks and themes: the card uses existing tokens and classes only.
