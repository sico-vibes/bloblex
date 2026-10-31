# Brief: Phase 3, git and review

Owner request, 31 October 2026: "Start Phase 3". Source: `docs/plans/expansion-plan-v3.md`, Phase 3.

**Lanes.**
- **Sona:** sections 1 and 2 (diff, stage, revert, pull requests).
- **Gogo:** sections 3 to 6 (abandoned worktrees, worktree setup, clone and discover, search).
- **The Director:** all front end, against this contract, in the main checkout.

Keep the contract exactly. If something can't work as written, pick the smallest change and say so in your report.

**Rule:** "omitted" and explicit `null` are the same unless an item says otherwise.

**The client never supplies a folder for a git action.** Sections 1 to 3 and 6 name a conversation, a project or an opaque id, and the folder comes from the stored row. Only `project.clone.parent` and `project.discover.folder` are paths, and they come from the native folder picker.

**Every command** is an argument list with no shell, has a time limit, sets `GIT_TERMINAL_PROMPT=0`, uses git's and `gh`'s own sign-in and never reads, passes or prints a credential. Output is read to branch on it and to build a one-line reason (`scaffold::one_line`, `scaffold::run`). No file contents, message text or paths in logs.

**All new RPCs:** `tiers.json` class `never`, events `drop`. None go on the Bitbots MCP.

## What exists

`repository.rs` (`session.repository`: read-only changes against `HEAD`, per file, capped diffs), `worktree.rs` (`create`, `inspect`, `commit_all`, `merge`, `discard`, worktrees at `<repo>-bitbots/<slug>` on `bitbots/<slug>`), `workspace.rs`, `project_setup.rs` (setup script), `scaffold.rs` (`gh_status`, `run`, `GH_STUB`/`GH_TEST_LOCK` for tests). `file.revert` reverses one turn's saved diff and stays as it is.

## 1. Diff, stage, revert (Sona, new `git_ops.rs`)

**`session.repository` gains** on each file `staged: "none" | "partial" | "all"`, from the porcelain v2 `XY` field: `X` set and `Y` clear is `all`, both set is `partial`, otherwise `none`. An untracked file is `none`. Nothing else in that reply changes.

**`session.git.diff {sessionId, repositoryPath}`** gives one file's whole diff against `HEAD`: `{repositoryPath, previousPath, change, diff, truncated, binary, addedLines, removedLines, staged}`. Cap 2 MiB. An untracked file gets the same synthesised diff `session.repository` builds, with the larger cap. A path with no changes gives `diff: null`, not an error.

**`session.git.stage {sessionId, paths, staged}`:**
- `paths` is 1 to 200 repository paths, each exactly as `session.repository` listed it. Any other path is `invalid_argument` "That file has no changes.", and nothing is applied.
- `staged: true` runs `git add -- <paths>`. `false` runs `git restore --staged -- <paths>`, or `git rm --cached -- <paths>` in a repository with no commits.
- Reply `{files}`, the same list as `session.repository`.

**`session.git.revert {sessionId, repositoryPath, confirm}`** discards one file's changes:
- No `confirm: true`: `invalid_argument`.
- Any conversation working in this folder, this one included (reuse `workspace::shared_with`'s meaning of working): error code `conflict`, "A bot is working in this folder. Stop it or wait, then try again."
- The path must be exactly in the current status list. A submodule entry, a directory or a symlink leaf is refused: `invalid_argument`, in a plain sentence.
- **First, a safety copy.** If the file exists, copy it to `<data>/reverted/<undo id>/` with a `meta.json` holding `{sessionId, repositoryPath, createdAt}`. Over 20 MiB: refuse, "That file is too large to keep a copy of, so Bitbots won't discard it." A failed copy discards nothing.
- **Then discard:**
  - tracked and modified or deleted: `git restore --source=HEAD --staged --worktree -- <path>`;
  - renamed: the same for the previous path, and remove the new path from the index and disk;
  - added to the index but not in `HEAD`: `git rm --cached -- <path>`, then delete the file;
  - untracked: delete the file.
- Reply `{undoId, name, files}`. `undoId` is `null` when there was no file to copy.

**`session.git.revertUndo {sessionId, undoId}`** puts the copy back:
- The record must belong to this conversation, else `not_found`.
- If the path has changes again, refuse: `conflict`, "That file has changed since, so Bitbots won't overwrite it."
- Restores the working file only, not the staged state. Deletes the copy. Reply `{files}`.
- The daemon deletes copies older than 7 days at startup.

**Tests:** `staged_state_comes_from_the_status_codes`, `whole_diff_goes_past_the_summary_cap`, `stage_and_unstage_a_file`, `stage_refuses_a_path_with_no_changes`, `stage_works_before_the_first_commit`, `revert_needs_confirm`, `revert_refuses_while_a_bot_is_working_in_the_folder`, `revert_restores_a_modified_file_and_keeps_a_copy`, `revert_deletes_an_untracked_file_and_keeps_a_copy`, `revert_handles_a_rename`, `revert_refuses_a_symlink_and_a_submodule`, `a_failed_copy_discards_nothing`, `undo_puts_it_back`, `undo_refuses_when_the_file_changed_since`, `undo_refuses_another_conversations_record`, `old_copies_are_removed_at_startup`.

## 2. Pull requests (Sona, new `pull_request.rs`)

Use `GH_STUB`, `GH_TEST_LOCK` and a local bare repository as `origin` in tests. **Never create a real repository or pull request while testing.**

**`session.pr.draft {sessionId}`** → `{ready, reason, gh: {available, login}, repoRoot, branch, base, isWorktree, remote, commitsAhead, uncommitted, title, body, existingUrl}`.

`ready: false` gives the first that applies, as `reason`:
1. "This conversation isn't in a git repository."
2. "This conversation is on a detached commit."
3. "Pull requests need their own branch. This conversation is on `<branch>`." (when `branch` equals `base`)
4. "This repository has no `origin` remote."
5. "The GitHub CLI isn't installed."
6. "The GitHub CLI isn't signed in."
7. "There's nothing to propose yet." (no commits ahead and no uncommitted files)

- `base`: the link's `worktree.base`, else `refs/remotes/origin/HEAD`, else `null`.
- `commitsAhead` is against `base`; `uncommitted` is the status count.
- `remote` is the literal name `origin` or `null`. Never return its URL, which can hold a credential.
- `title`: the subject of a single commit ahead, else the conversation title, capped at 72 characters.
- `body`: "## Changes" with up to 20 commit subjects as bullets, then "## Files" with "N files, +a −r", then "Made with Bitbots." No message text from the conversation.
- `existingUrl`: from `gh pr view --json url,state`, when the state is `OPEN`, with a 10-second limit. Any failure gives `null`.

**`session.pr.create {sessionId, title, body, base, draft, commitMessage, confirm}`:**
- No `confirm: true`: `invalid_argument`. `title` 1 to 256 characters, `body` at most 60,000: else `invalid_argument`.
- Re-run the draft's checks. If not ready: `invalid_argument` with that reason.
- A conversation working in this folder: `conflict`, as in section 1.
- `commitMessage` non-empty means commit everything first. `null` means leave uncommitted files out of it.
- Steps, each `{id, status: "done"|"failed"|"skipped", detail}`, as `project.scaffold` does. A failed step stops the rest, and what already worked stays:
  1. `commit`: `worktree::commit_all`.
  2. `push`: `git push -u origin <branch>`. Never force, and never push `base`.
  3. `pr`: `gh pr create --head <branch> --title <title> --body-file - [--base <base>] [--draft]`, body on stdin.
- Reply `{steps, url}`. `url` must parse as `https://` from the command's output, else `null` with the step marked failed.
- On success, write one notice with `team::note`: "Opened a pull request: `<url>`", `meta {kind: "pull_request", url, title}`.

**Tests:** `draft_explains_each_reason_it_isnt_ready`, `draft_title_and_body_come_from_the_commits`, `draft_never_returns_the_remote_url`, `create_needs_confirm`, `create_commits_pushes_and_opens`, `create_leaves_uncommitted_files_out_without_a_message`, `create_never_force_pushes_and_never_pushes_the_base`, `create_stops_at_a_failed_push_and_keeps_the_commit`, `create_refuses_while_a_bot_is_working_in_the_folder`, `create_passes_the_body_on_stdin`, `created_pr_writes_a_notice_with_its_url`.

## 3. Abandoned worktrees (Gogo, new `worktree_cleanup.rs`)

Nothing here runs on a timer, and nothing is removed without a call from the owner.

**`worktree.abandoned {}`** → `{items: [{id, repo, path, branch, reason, dirtyFiles, commitsAhead, lastActivityAt}]}`.
- Repositories scanned: the repo roots of registered projects, and of every session's `link.worktree.repo`.
- For each, `git worktree list --porcelain`. Keep an entry only when its path is inside `<repo>-bitbots` and its branch starts `bitbots/`. Skip locked entries and the main worktree.
- Skip anything a non-archived conversation works in, and any registered project's own folder.
- `reason`: `conversation_deleted`, `conversation_archived` or `folder_missing`.
- `id` is a hash of the normalised path. `commitsAhead` is against the main worktree's `HEAD`. `lastActivityAt` is the worktree folder's modification time.

**`worktree.removeAbandoned {id, deleteBranch, force, confirm}`:**
- No `confirm: true`: `invalid_argument`. Recompute the list; an id not in it: `not_found`.
- Dirty files, or `deleteBranch` with commits ahead, need `force: true`, else `conflict` naming what would be lost, for example "2 uncommitted files and 3 commits would be lost."
- `folder_missing`: `git worktree prune`. Otherwise `git worktree remove [--force] <path>`.
- `deleteBranch: true`: `git branch -D <branch>`. Removes nothing else.
- Reply `{removed, branchDeleted, detail}`.

**Tests:** `a_live_conversations_worktree_is_never_listed`, `a_deleted_conversations_worktree_is_listed`, `an_archived_conversations_worktree_says_so`, `a_folder_outside_the_family_is_never_listed`, `a_locked_worktree_is_never_listed`, `remove_needs_confirm_and_a_listed_id`, `remove_refuses_dirty_or_ahead_without_force`, `remove_with_force_takes_the_worktree_and_branch`, `keeping_the_branch_keeps_its_commits`, `a_missing_folder_is_pruned`.

## 4. Worktree setup (Gogo, `project_setup.rs`)

Project `overrides` gain `copyFiles: string[]` and `initSubmodules: boolean`. A project with neither stored reads as `[]` and `false`.

- **Validate in `validate_project_overrides`:** at most 50 entries, each a relative path of at most 260 characters, with no `..`, drive, wildcard or leading slash. Same desktop-only outlets as `setupScript`: never in backups, never to devices.
- **When:** only for a conversation in its own worktree, in `before_first_turn`, in order: copy, submodules, script. `wanted` is true when any of the three is set.
- **Copy:** from the main repo root to the worktree. A source must be a regular file, not a symlink, at most 20 MiB. A missing source is skipped. **An existing target is never overwritten.**
- **Submodules:** `git submodule update --init --recursive`, with the setup script's time limit, and Stop works as it does for the script (`Setup::Cancelled`).
- **Notices:** keep `kind: "setup_script"`. Text like "Copied 2 files and set up submodules." with `meta.copied`, `meta.skipped`, and names only, no contents. A failure reports like a failed script and the turn continues the same way.

**Tests:** `overrides_validate_copy_files`, `old_projects_read_as_no_copy_and_no_submodules`, `copy_files_reach_the_worktree_only`, `an_existing_target_is_not_overwritten`, `a_missing_file_is_skipped_and_named`, `a_symlink_source_is_refused`, `submodules_are_initialised_in_the_worktree`, `stop_during_submodules_cancels`, `backups_do_not_carry_copy_files`.

## 5. Clone and discover (Gogo, new `project_clone.rs`)

**`project.clone {url, parent, name, confirm}`** → `{job}`, returned at once. Job: `{id, url, target, state: "running"|"done"|"failed"|"cancelled", detail, project}`. Event `project.clone.changed {job}`.
- No `confirm: true`: `invalid_argument`.
- `url` must start `https://`, `ssh://` or match `git@host:path`. Refuse a leading `-`, `ext::`, `file:`, `http://`, and any URL holding a password: "Put no password in the URL. Sign in with git or the GitHub CLI instead."
- `parent` must be an existing absolute folder. `name` defaults to the URL's last segment without `.git`, checked by `scaffold::valid_folder_name`. An existing target is refused.
- Run `git -c protocol.ext.allow=never clone --no-recurse-submodules -- <url> <target>` with a 30-minute limit.
- On success, register the project, reusing `project.create`'s path, and set `project`. On failure or cancel, remove the folder only if this job created it.

**`project.clone.cancel {id}`:** kills the tree (`taskkill /T /F`, as in `project_setup`). **`project.clone.list {}`** → `{jobs}`, in memory only, for a window that reopens.

**Setting `projects.folder`:** a string, an absolute path. Add it to `validation_key`, and refuse it in `exportable_setting`, since it's machine-specific.

**`project.discover {folder, depth}`** → `{folder, repos: [{path, name, branch, alreadyAdded}], truncated}`.
- `depth` default 3, maximum 5. Off the runtime, with a 10-second budget, at most 5,000 folders and 200 repositories (`truncated`).
- Never follow symlinks. Skip hidden folders, `node_modules`, `target`, `dist`, `vendor` and `*-bitbots`. Stop going down at a repository, so submodules aren't listed.
- `alreadyAdded` compares with `worktree::normalize`. A registered project's own folder is listed with `alreadyAdded: true`.

**Tests:** `clone_refuses_dangerous_urls`, `clone_refuses_a_password_in_the_url`, `clone_refuses_an_existing_target`, `clone_needs_confirm`, `clone_registers_the_project` (from a local bare repository, through a test-only allowance for its path; the rule stays for real calls), `a_failed_clone_removes_only_its_own_folder`, `cancel_stops_the_clone_and_cleans_up`, `discover_finds_repositories_within_depth`, `discover_stops_at_a_repository`, `discover_skips_hidden_and_build_folders`, `discover_marks_what_is_already_added`, `discover_caps_what_it_lists`.

## 6. File and content search (Gogo, new `project_search.rs`)

Both take `{sessionId}` or `{projectId}`. Neither, or a target with no folder: `{files: []}` or `{results: []}`, not an error.

**`project.files.search {sessionId, projectId, query, limit}`** → `{files: [{path, name, score, matches}], truncated, source: "git"|"walk"}`.
- `path` is relative with forward slashes. `matches` is the character indexes of the query in `path`.
- `limit` default 20, maximum 50. `query` at most 200 characters.
- Source: `git ls-files -co --exclude-standard` in a repository, else a walk that skips hidden, build and `*-bitbots` folders. At most 50,000 files. Cache per folder for 15 seconds.
- Fuzzy subsequence match, preferring matches in the file name, consecutive characters and segment starts. An empty query returns the shortest paths first.
- Files `names_a_secret` matches are left out (make it `pub(crate)` in `media.rs`).

**`project.content.search {sessionId, projectId, query, caseSensitive, regex, limit}`** → `{results: [{path, line, preview}], truncated, source, reason}`.
- `query` 1 to 200 characters, else `invalid_argument`. `limit` default 100, maximum 500. `preview` is the line trimmed to 200 characters.
- In a repository: `git grep -n -I --untracked --exclude-standard [-i] [-F|-E] -e <query> --`. `--no-color`, and run off the runtime with a 10-second limit, returning what it has with `truncated: true`.
- Otherwise a walk: same skips, text files of at most 1 MiB, at most 5,000 files.
- A bad regular expression: `{results: [], reason: "That isn't a valid search pattern."}`.
- Results from secret-named files are left out.

**Tests:** `files_rank_the_name_above_the_folder`, `files_rank_consecutive_above_scattered`, `files_report_where_the_query_matched`, `files_leave_out_secret_names`, `files_respect_gitignore`, `files_work_outside_a_repository`, `an_empty_query_gives_the_shortest_paths`, `content_finds_a_line_in_a_tracked_and_an_untracked_file`, `content_leaves_out_secret_files_and_binaries`, `content_treats_the_query_as_literal_unless_regex`, `a_bad_pattern_gets_a_reason`, `content_works_outside_a_repository`, `search_without_a_folder_is_empty`.

## Keeping the two lanes apart

- **Sona:** new files `git_ops.rs`, `pull_request.rs`, and `repository.rs`. **Gogo:** new files `worktree_cleanup.rs`, `project_clone.rs`, `project_search.rs`, and `project_setup.rs`.
- **`main.rs`:** Sona adds dispatch arms right after `"session.repository"`; Gogo right after `"project.scaffold"`. Keep the `mod` lines beside the others.
- **`tiers.json`:** Sona adds rows after `session.checkpoints`; Gogo after `project.scaffold`.
- **`docs/ipc-contract.md`:** each lane adds its own "Phase 3" subsection, Sona's titled "Phase 3: review", Gogo's "Phase 3: projects". I'll join them.

## Rules

- Never run `git commit`, `git push`, `git merge` or switch branches in your worktree. Change nothing outside it, apart from temporary test folders. Don't run `npm install`.
- Don't edit the skill files: put proposed text in your report.
- `crates/bloblex-storage/src/lib.rs` has one NUL byte: edit it only with your edit tool. No shell heredocs for anything with backslashes.
- Keep `every_daemon_log_call_site_is_a_fixed_message` true.

## Gates

From PowerShell in your worktree, with `BITBOTS_HOOK_BRIDGE` and `BITBOTS_REMOTE_WEB_DIR` removed for the session:
- `$env:RUST_MIN_STACK='33554432'; cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`

Send output to a log file and read the summary lines. Known flaky test: `a_crash_after_a_finished_turn_does_not_fail_that_session`.

## Report

Files changed; item by item; every contract change with its reason; new test names and any existing test you changed; the exact gate output tails; what you could not verify; proposed skill text.
