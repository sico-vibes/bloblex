# FIX39 P5 audit (Claude Sonnet 5.5)

Package P5: per-bot settings, permissions, lock, Experimental tab (items 16, 19, 13, 11, 12). Worktree `C:\fx85`, branch `lane/fix39-p5`. I read the brief, `FIX39_DECISIONS.md`, the P5 section and items 11, 12, 13, 16, 19 of `FIX39_RESEARCH_AUDIT.md`, `FIX39_P5_REPORT.md` and the whole diff. I did not re-run the gates. The report's results are plausible and the Director runs them after the merge.

## Verdict: PASS WITH FIXES

The design is right and most of it is solid:
- The lock lives in `agents.locked` and is enforced in the daemon.
- The Manager can never be locked.
- Migrations are tested on an old database.
- The Manager permission proposal never offers Full access.
- The `never` Remote rows are present.

Three items must be fixed before merge, because each one is a real regression or a hole in the lock. The rest are small.

### Must fix (3)

**F1. A locked bot can no longer enter or leave plan mode, so "Approve plan" breaks.**
`crates/bloblex-daemon/src/main.rs:2498`: the new lock check in `update_session_model` runs for every request, including `{ planMode }`. The Plan pill (`App.tsx:1621`, `setPlanMode`) and `approvePlan` (`App.tsx:1628`) both use `session.model.update { planMode }`, and the Plan pill is not disabled for a locked bot (`App.tsx:2558`).
- A locked bot's conversation shows the red lock error on every Plan click.
- `approvePlan` calls `setPlanMode(false)`, which fails and is swallowed. It then sends "Approved. Go ahead and implement the plan." while the session is still in plan mode. A locked bot can never leave plan mode.
- Plan mode is a per-conversation work mode, not one of the lock's listed settings: model, effort, speed, permission, rename, instructions, runtime, project, archive and the Manager's changes (`FIX39_RESEARCH_AUDIT.md` item 13, "Decided").

Fix: in `update_session_model`, apply the lock check only when the request carries `model`, `thinking`, `serviceTier` or `approvalMode`. A request with only `planMode` passes. Add a daemon test: a locked bot accepts `{ planMode: true }` and refuses `{ serviceTier: "fast" }`.

**F2. `agent.team.update` lets a locked bot be moved out of its project or have its leader flag changed.**
`crates/bloblex-daemon/src/team.rs:715`: `settings_change` is `projectId` non-null `||` `role` present.
- `projectId: null` (the "Unassigned" target) is not refused. Dragging a locked bot onto Unassigned works: `placeAgent` (`App.tsx:2086`) sends `projectId: null`, and the menu's "Move to" is disabled but drag-and-drop is not. The test `row_agent_team_update_keeps_layout_writes_but_refuses_settings` only tries a non-null project.
- `leader` is not guarded. It is a team-role setting, and setting it clears the old leader.
- `project.delete` (`crates/bloblex-storage/src/lib.rs:1747`, which runs `UPDATE agents SET project_id=NULL`) also changes a locked bot's project. It is missing from the report's writer table.

Fix:
- Refuse when `projectId` is present with a value different from the stored one (null included), or when `leader` or `role` is present with a value different from the stored one. Comparing with the stored value keeps drops inside the same project working as layout.
- Decide `project.delete` explicitly. Either refuse deleting a project that has a locked bot, with the lock sentence, or record it as deliberately exempt and add the row and a test.
- Add tests for `projectId: null` and `leader: true`.
- In the UI, also disable drag for a locked bot, or accept the error text.

**F3. Clearing or setting a conversation's permission pins the model and silently turns Claude workflows off.**
`main.rs:2652-2659` (`set_session_permissions`) and `proposals.rs:472-478` (`apply_permission`): when the session has no `modelLock` object, they create `{"model", "thinking"}` from the current options. `exec_options_for_session` (`main.rs:1448-1458`) treats the mere presence of a lock object as significant:
- The model and effort are frozen at today's bot values, so later bot-level changes no longer reach that conversation.
- `enableWorkflows` is absent, so it becomes `false` for a Claude conversation (the unlocked default is on). `update_session_model` explicitly preserves `enableWorkflows` for this reason (`main.rs:2575-2582`).

This is hit by the composer's "clear the pin" call (`ComposerControls.tsx:93`, `approvalMode: null`) on any conversation that has no lock yet. Examples are a new empty conversation, a legacy one, and a side conversation that has not run, which also covers the Manager-proposal path. A permission change on a Claude conversation then turns off its dynamic workflows (Ultracode).

Fix:
- For `approvalMode: null`, if the session has no lock object, return the current session summary and write nothing.
- When setting a mode without a lock, build the lock the way `update_session_model` does: include `enableWorkflows` (current `options.enable_workflows` for Claude) and keep the effective `serviceTier` and `planMode`.
- Put the lock-building in one shared helper used by `set_session_permissions` and `apply_permission`. They duplicate the same eight lines.
- Add a test: a Claude session with no lock, `session.permissions.set { null }`, and `modelLock` is still absent. A second test: set `auto`, and `modelLock.enableWorkflows` is not lost.

### Should fix (small)

**S1. The composer permission pill is disabled while a turn runs.**
`App.tsx:2559` still passes `sessionBusy`. The research decision for item 16 is that the conversation-level part "must not error mid-turn" and uses the next-turn RPC. Both `agent.update` and `session.permissions.set` are safe mid-turn, and the owner's request is "with or without a conversation open". Drop `sessionBusy` from the permission control's `disabled`. Keep `locked` and `connection`. The side-conversation header already does this correctly. The existing test "stays disabled while a turn is running" (`ComposerControls.mounted.test.tsx`) needs a matching update.

**S2. Lock tooltip missing on disabled composer controls.** The report admits this. The audit's UI spec says "disabled composer controls with a tooltip". Add `title="This bot is locked. Unlock it to change its settings."` to the model, effort and permission pills when `locked`. `SessionExecutionControls.tsx:83` / `:147` and `App.tsx:2559`.

**S3. `fieldset.blob-settings-body` may change the editor layout.**
`BlobSettings.tsx:235` now wraps everything in a `<fieldset>` for every bot, locked or not. `.blob-page-column` is `display: grid` (`blobPage.css:9`), so the EditGroups were direct grid items and are now children of one block-level fieldset. Spacing that came from the parent grid or from sibling selectors can change, and the `sections` slices (`renderSettings(only)`) render one fieldset each. Make the fieldset `display: grid` with the parent's gap (or verify in screenshots). The Director must screenshot the editor, locked and unlocked, both looks, both themes. The report says nothing was looked at in a browser.

**S4. Side-conversation pill wording.** `App.tsx:2454` passes `note="Applies from the next turn."`, which replaces "Applies to this bot from now on." (`ComposerControls.tsx:119`). In the side header the control writes the bot's mode (`agent.update`), so it also changes the bot's other conversations. The note should say both: "Applies to this bot, from the next turn." The Full-access dialog already says "every conversation is affected".

**S5. Harden `apply_permission`.** `proposals.rs:460`: at approval time it re-checks only `link.kind == "side"` and the lock. `proposal.decide` accepts `edits` merged into the payload (`proposals.rs:499`), so an edited `conversation` could point at any side conversation. Re-check that `link.peerAgentId` is the proposing Manager (the proposal's `agent_id`), as `propose_permission` does. Low risk because the owner approves, but the two checks should match.

**S6. Item 19 sub-point 5 has no owner.** The denial text (`bloblex_agent_core::permission_summary`) is outside P5's file list and the report flags it. The Director should assign it to P6 or Wave D, or the friend's "still denied" complaint stays half-fixed.

**S7. Sidebar model line is not reactive.** `TeamSidebar.tsx:234` reads `readCachedCatalogModels` synchronously. If the catalog arrives after the first render, rows keep the raw model id until something else re-renders them. Subscribe through the cache's `useSyncExternalStore` hook, or re-read when the catalog changes. Cosmetic.

**S8. Cosmetic Rust damage.** Two edits swallowed a newline:
- `proposals.rs:273`: `pub async fn project_status(...) -> Result<String, String> {    let wanted = ...`
- `main.rs:10641`: `async fn exempt_writes_do_not_consult_the_lock() {        // Reads and creation ...`

Put the first body line on its own line.

### Item-by-item check

| Item | Result |
| --- | --- |
| 16 composer writes the bot | Done. `agent.update` first, pin cleared for a real conversation, no `session.model.update` for a draft, draft id no longer sent to `runtime.models` / `runtime.capabilities`, wording changed. Gaps are S1 and F3. |
| 19 permissions in a sub-conversation | Done for the UI header, the RPC and the Manager proposal. The RPC works mid-turn, refuses an automation session and a locked bot. The proposal offers only `ask`/`auto`, is limited to a Manager-started side conversation, and is re-checked on apply. Not done: sub-point 5 (S6) and the "set by the Manager" label. F3 applies. |
| 13 lock a bot | Daemon column, RPC, badge, menu (Lock gated by the experiment, Unlock always), disabled menu entries and read-only editor are in place. The Manager is never lockable. Enforcement covers `agent.update/delete/restore`, `session.model.update`, `session.permissions.set`, `update_blob`, the proposal apply and the legacy migration. Holes: F1 (over-blocks plan mode) and F2 (under-blocks project and leader). |
| 11 Experimental tab | Done. Page, nav entry, whole group moved including "Longest wait for a rate limit" and Steer. Power and Notifications stay on General. Settings search has one entry per experiment. |
| 12 model under the name | Done. The pure `sidebarSubtitle` is unit-tested. Status wins while working or waiting. "Default model" with no model. It uses the bot-level setting. See S7. |

### Correctness notes

- Storage: `ensure_team_schema` adds `locked` idempotently, and all three agent projections include it. `agent_update` never copies `locked`, so only `agent.lock.set` can change it. `agent_set_locked` refuses the Manager, refuses an archived bot, and is a no-op without events when unchanged. Fine.
- Migration: the `proposals.kind` rebuild (`lib.rs:715-737`) keeps rows and is tested on a table written with the old CHECK. `a_pre_fix39_database_gains_the_locked_column_and_keeps_a_lock` drops the column, reopens, and checks persistence across a second reopen. Both tests would fail on the old code.
- Windows: nothing path- or process-related in this package.
- The lock error is one shared sentence (`locked_bot_error`). No message text, command text or recap text is logged or returned.

### Tests

Tests that fail on the old code and prove the behaviour:
- All `row_*` daemon tests except one noted below.
- The two storage migration tests.
- `ComposerControls`: the bot is written, the pin cleared, `session.model.update` not called, and a draft calls no `session.permissions.set`.
- `TeamSidebar`: the lock menu and badge.
- `sidebarSubtitle` unit tests.
- The Experimental-page mounted tests.

Gaps:
- `row_composer_writes_the_bot_so_a_new_conversation_inherits_it` passes on the old code, since `agent.update { approvalMode }` and inheritance already worked. It is a regression pin, not a fix proof. The `not_found` assertion on a draft id is old behaviour.
- `SessionExecutionControls` has no new test for item 16. Add mounted tests for: a draft model choice calls `agent.update`, not `session.model.update`, and shows no confirmation dialog; a draft sends no draft id to `runtime.models` / `runtime.capabilities`; `locked` disables the model, effort and fast controls.
- No mounted test for a locked bot's disabled composer pills, for the read-only editor banner and disabled fieldset, for the side-header permission pill, or for the `permission` card in `ProposalCard`.
- The sidebar model mounted test only asserts "Default model". Add one with a model, one with a working bot (status wins), and one with a missing catalog (raw id).
- `exempt_writes_do_not_consult_the_lock` ends with `.ok()` on `agent.reorder`, so it proves nothing about that call. Assert the result or drop the line.
- The F1, F2 and F3 tests listed above are missing.

### Scope

- Files outside the package list (`TeamMessages.tsx`, `ProposalCard.tsx`, `blobPage.css`, two existing tests, the storage CHECK): all justified, as the report says. `BotEditor.tsx` and `BotWizard.tsx` were not touched. The `fieldset` in `BlobSettings.tsx` covers the editor's native inputs. `LookEditor`'s canvas controls remain clickable, but the save bar is disabled (`canSubmit={!lockedBot}`) and the daemon refuses.
- Hot files: `main.rs` +304, `team.rs` +16, `storage/lib.rs` +149, `App.tsx` +9, `TeamSidebar.tsx` +29. All changes are local and match the package. No unrelated churn.
- `docs/FIX39_AUDIT_IMPL_BRIEF.md` shows as modified in `git status`, but the content diff is only line endings. It is outside the package: restore it (`git checkout -- docs/FIX39_AUDIT_IMPL_BRIEF.md`) before commit.
- `apps/desktop/src/preview/fixtureBridge.ts` has no `agent.lock.set` or `session.permissions.set` handlers. The browser preview will fail on Lock and on the permission pill. Add stub handlers if the Director will use the preview for screenshots.

### Security rules

- Remote: `agent.lock.set` and `session.permissions.set` have `never` rows in `tiers.json`. No new event type; `agent.changed` and `session.changed` are existing. The new `locked` field on the agent JSON is harmless.
- The new `set_conversation_permission` Manager tool is Manager-only (dispatch arm plus the non-manager refusal list), proposal-gated, and never offers Full access. Approvals are not bypassed.
- Logs and payloads: the proposal title and detail carry the bot name and a conversation id only, no message text.

### Visual rules

- No sparkle or star icons were added. The lock uses `Lock` / `LockOpen`, the tab uses `FlaskConical`, the card uses `ShieldCheck`. The Manager's star is untouched.
- Themes: the `.lock-badge` uses theme tokens plus light-theme and selected-row overrides. It has no `data-bitbots` override like `.leader-badge` at `bitbots.css:296`, but it is already circular. The Director's screenshots should confirm both looks and both themes, including S3.


## Re-check (Sonnet), verbatim

The auditor re-checked the follow-up and replied:

The Re-check section isn't in `docs/FIX39_P5_AUDIT.md`. My Bash append and my Edit were both denied, so I wrote nothing.

My verdict is PASS. I checked F1, F2, F3, S1–S5, S7, S8 and the update badge against the code, and each is fixed. I did not re-run the gates. S3's layout fix is only pinned by a CSS test, so the Director's screenshots, including the badge at 1024 px, are still owed. S6 is still unassigned: the denial text in `bloblex_agent_core` is outside P5's files.

If you grant write access to that file, I'll append the section.

**PASS**
