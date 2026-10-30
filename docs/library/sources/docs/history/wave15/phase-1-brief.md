# Brief: Phase 1, approvals and settings

Owner request, 30 October 2026: "Start Phase 1", with two backend lanes in parallel. Source: `docs/plans/expansion-plan-v3.md`, Phase 1.

**Lanes.**
- **Lane A (Sona, Claude Sonnet 5.5, medium):** approval modes and per-project overrides.
- **Lane B (Gogo, OpenCode Go DeepSeek V4.1 Flash, high):** the usage-bar sign-in read, experiment defaults, the new shortcut settings, and settings compatibility shims.
- **Frontend:** the Director, building against this contract at the same time in the main checkout.

Each lane has its own worktree and does only its own items. Both will touch `crates/bloblex-daemon/src/main.rs` and `crates/bloblex-storage/src/lib.rs`, so keep edits small and local, and don't reformat or move code you aren't changing. The Director merges both.

**Rules for both lanes**
- Keep the contract exactly. If something can't work as written, pick the smallest change and say so in the report.
- "Omitted" and explicit `null` are the same unless an item says otherwise.
- Never run `git commit`, `git push`, `git merge` or switch branches. Change nothing outside your worktree. Don't run `npm install`.
- Never read, print or log a credential, token or capability, except that the existing read in `quota_sources.rs` stays as it is.
- No message or script text in logs. Keep `every_daemon_log_call_site_is_a_fixed_message` true.
- Every new RPC gets a `tiers.json` row, and every new setting key is either added to the validation in `main.rs` and `validate_setting_value` or is deliberately refused. The parity tests must pass.
- Don't edit the skill files. Put your proposed text for `codebase-map.md` and `lessons.md` in your report, and the Director merges it. Do update `docs/ipc-contract.md` for your own items, in your own paragraph.

## Lane A: approval modes

Today a mode is `ask`, `auto` or `bypass` (Full access), and `permissions.default_mode` accepts only `ask` and `auto`.

**New mode `accept_edits` (Auto-accept edits).** A valid value everywhere a mode is stored or set: `permissions.default_mode`, `agent.update approvalMode`, `agent.create`, the conversation pin (`modelLock.approvalMode`, the checks near `main.rs:3098` and `main.rs:3261`), and the MCP's `create_bot` and `update_bot`, which always accept it (it isn't behind the Full access switch).
- `ApprovalMode` gains `AcceptEdits`, with `as_str` `"accept_edits"`. Every adapter treats it as it treats `Ask` when launching. It must never take the launch path `Bypass` takes.
- **Decision, in the permission arm near `main.rs:4678`:** a request is approved without asking when its normalized kind is a file edit or a file read, and the classifier places it inside the conversation's project folder. Everything else asks, including every command. Use the existing classification. Record it as `policy:accept_edits`, like `policy:auto`. Saved "Always" rules still apply first, and plan mode and unattended work are unaffected.
- **Migration:** `agents.approval_mode` has `CHECK(approval_mode IS NULL OR approval_mode IN ('ask','auto','bypass'))`, and the check needs `accept_edits` added for existing databases as well as new ones. SQLite can't alter a check, so rebuild the table safely, following the pattern in `migrate_approval_modes` (the database backup first, foreign keys off during the rebuild, in one transaction, all rows, columns and indexes kept). Test it against a database in the old shape.

**`permissions.default_mode` also accepts `bypass`.**
- `settings.set` with `bypass` needs `confirm: true` in the params, else `invalid_argument` "Confirm making Full access the default first." `ask`, `auto` and `accept_edits` need no confirm. New installs stay on `ask`.
- **Unattended work never runs in bypass, including through the default.** A scheduled run and an unattended task keep today's forced safe mode. Add a test that a default of `bypass` doesn't reach an automation or an unattended task.
- **Backup import:** a `permissions.default_mode` of `bypass` in a backup becomes `ask` (the setting is in the list at `backup.rs:62`). Bots with `bypass` already import as `ask`. `accept_edits` is kept. A backup never grants Full access.
- The MCP can't set settings, and that doesn't change.

**Tests:** `accept_edits_approves_edits_and_reads_inside_the_project`, `accept_edits_asks_for_commands_and_outside_the_project`, `accept_edits_launches_like_ask`, `approval_mode_check_migrates_an_old_database`, `default_mode_bypass_needs_confirm`, `new_installs_default_to_ask`, `default_bypass_never_reaches_unattended_work`, `backup_import_never_restores_a_full_access_default`.

## Lane A: per-project overrides

**Storage.** `projects` gains `overrides_json` (additive). The project DTO always carries `overrides: {models: {}, approvalMode: null, setupScript: null}`.

**`project.update {projectId, overrides}`** replaces the whole object when `overrides` is present.
- `models`: a map of provider name to model id, each id 1 to 200 characters. An explicit empty map clears it.
- `approvalMode`: `ask`, `auto`, `accept_edits`, `bypass` or null. `bypass` needs `confirm: true` in the params, else `invalid_argument` "Confirm Full access for this project first."
- `setupScript`: up to 4,000 characters, or null. An empty or blank string is stored as null.
- Anything else in `overrides` is refused (`invalid_argument`).

**Where overrides are refused or hidden.** A setup script is code, and a mode can widen what a bot may do, so:
- Only the desktop may set them: the Manager's `update_project` tool, `propose_project`, the MCP and remote devices can't. Check `project.update`'s `tiers.json` row and params, and strip or refuse `overrides` on every other path.
- Remote devices never see `overrides`: strip it from project DTOs in redaction, with a test.
- **Backup import never brings `overrides` in**, and an export doesn't include `setupScript`.
- A repository's `.bitbots.json` can't set any of them.

**Model.** When a new conversation starts in a project (`new_session`, with an `agentId`, not unattended): if `overrides.models` has an entry for the bot's provider and that provider's catalog offers the model, the conversation's model is that one. If the catalog doesn't offer it, or the provider has no entry, it uses the bot's model, and that case is not an error. Existing conversations don't change. An explicit `model` in the call wins.

**Approval.** Order, read per turn in `exec_options_for_session`: conversation pin, then the project's `approvalMode`, then the bot's mode, then the default. Unattended work and automations keep their forced safe mode, and plan mode still wins. The session DTOs (detail, list, event summary) gain `projectApprovalMode` (string or null).

**Setup script.** Runs once, for a conversation with its own worktree (`link.worktree`) in a project with a `setupScript`:
- `new_session` marks `setupPending` in the session's data.
- At the start of the first `run_turn`, before `activate_session`, if it's pending: clear the flag first, so a crash can't run it twice; add a notice `Running this project's setup script…` with meta `{kind:"setup_script", status:"running"}`; run it with `cmd /d /s /c <script>` in the worktree, no stdin, a 5-minute timeout, kill on drop, no window; then add a notice with meta `{kind:"setup_script", status:"done"|"failed"|"timeout", detail}`. `detail` is the last non-empty output line, redacted and one line, up to 200 characters; null when done.
- A failed script doesn't stop the turn. The agent is told, by adding this before the turn's text, the same way for every provider: `The project's setup script failed in this worktree: <detail>`.
- Never in the main folder, never for a conversation without its own worktree, never logged.

**Tests:** `project_overrides_round_trip_and_refuse_unknown_keys`, `project_bypass_needs_confirm`, `overrides_are_desktop_only`, `remote_never_sees_project_overrides`, `backup_never_imports_project_overrides`, `project_model_applies_when_the_catalog_offers_it`, `project_model_is_ignored_when_it_does_not`, `approval_order_is_pin_project_bot_default`, `unattended_ignores_a_project_full_access`, `setup_script_runs_once_in_the_worktree_before_the_first_turn`, `setup_script_failure_does_not_stop_the_turn_and_tells_the_agent`, `setup_script_does_not_run_without_a_worktree`.

## Lane B: the usage-bar sign-in read becomes opt-in

Today `quota_sources.rs` reads Claude's and OpenCode's stored sign-ins to fetch usage bars. See the 30 October amendment in `AGENTS.md`.

- New setting `usage.readCliSignIns`, a boolean, default off (absent means off). Validated in `settings.set` and `validate_setting_value`. Not in backups, either way: consent doesn't travel.
- While it's off, nothing opens those files or the credential database, on any path: gate it in `poll_local_quota` so `refresh_provider_quota` and the retry policy are covered too. Codex's usage comes from its own app server, is not a credential read, and doesn't change.
- While it's off, the provider's quota reports a distinct reason, `read_off`, in the same place `NoCredentials` is reported today, and any cached snapshot from that source is cleared so no stale bar shows. Name the `PollFailure` variant accordingly.
- Turning it on polls soon after, without needing a restart. Turning it off clears the snapshots at once.
- The retry policy already copes with a missing reset time; check that it still behaves when the read is off.

**Tests:** `sign_in_read_is_off_by_default_and_reads_nothing`, `turning_the_read_on_polls_and_off_clears`, `refresh_provider_quota_respects_the_switch`, `backup_never_carries_the_sign_in_read`.

## Lane B: useful experiments on by default

New installs and installs that never touched a switch get these on. A switch the owner turned off stays off.

- Keys the daemon reads: `experimental.memory`, `experimental.autoTitles`, `experimental.autoRetry`, `experimental.undo`. Absent now means on; an explicit `false` means off. Use one helper, for example `experiments::on(&settings, "memory")`, at every read.
- `experimental.search`, `experimental.changeReview` and `experimental.messageActions` are read only by the UI. The Director changes those defaults.
- Update existing tests that assumed off, and say which ones in the report. Don't weaken what they check: set the switch explicitly when a test needs it off.

**Tests:** `a_fresh_install_has_the_useful_experiments_on`, `a_switch_turned_off_stays_off`, `memory_tools_follow_the_new_default`, `auto_retry_follows_the_new_default`.

## Lane B: shortcut settings

Validated settings only. The Director builds the behaviour.

- `composer.sendShortcut`: `"enter"`, `"ctrl+enter"` or `"shift+enter"`. Absent means `"enter"`.
- `shortcuts.bindings`: an object of action id to shortcut, at most 40 entries. An action id is 1 to 60 of `[a-zA-Z0-9.-]`. A shortcut is a string of up to 40 printable ASCII characters, or null for "no shortcut". Anything else is refused.

Both are included in backups, like other appearance settings. **Tests:** `send_shortcut_accepts_only_the_three_choices`, `shortcut_bindings_are_bounded_and_validated`.

## Lane B: settings compatibility shims

Old setting keys are read and moved, the way the look migration does.

- First find out which keys have been renamed: search `git log -S` and `git log -p` over `main.rs`, `crates/bloblex-storage/src/lib.rs` and the UI's `settings.set` calls, and list what you find, with the commit.
- Add one table in storage: old key, new key, and optionally a value mapping. At `Storage::open`, in one transaction: if the old key exists and the new one doesn't, write the new one with the mapped value; then delete the old key. If both exist, the new value wins and the old key goes. It runs every open and does nothing when there's nothing to move. Backup import runs through the same table.
- If you find no renamed key, the table starts empty. Say so, and test the mechanism with test-only entries. Don't invent renames.

**Tests:** `an_old_setting_moves_to_its_new_key`, `the_new_value_wins_when_both_exist`, `the_shim_is_idempotent`, `backup_import_uses_the_shims`.

## Gates

From PowerShell in your worktree, with `BITBOTS_HOOK_BRIDGE` and `BITBOTS_REMOTE_WEB_DIR` removed for the session (the running app sets them, and two tests then fail):

- `$env:RUST_MIN_STACK='33554432'; cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`

Known flaky test: `a_crash_after_a_finished_turn_does_not_fail_that_session`. There is no `node_modules` in a worktree, so the Director runs the npm gates after merging. Don't use shell heredocs for anything with backslashes. `crates/bloblex-storage/src/lib.rs` contains one NUL byte, so edit it with your edit tool.

## Report

- Files changed.
- Item by item: what's done, and anything not done.
- Every contract change, with its reason.
- New test names, any existing test you changed and why, and the exact gate output tails.
- Anything you could not verify.
- Your proposed text for the skill's `codebase-map.md` and `lessons.md`.
