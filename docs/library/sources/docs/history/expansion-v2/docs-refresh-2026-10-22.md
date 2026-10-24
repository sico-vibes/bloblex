# Documentation refresh (22 October 2026)

> **What this is:** the record of the documentation pass of 22 October 2026: the documents changed, the code paths each fact was checked against, what was removed, what could not be verified and how it is marked, and what is still stale outside this pass.
> **Status:** historical record of the 22 October 2026 pass, on the worktree `D:\fx65` (branch `exp/docs-refresh`, from `main` at `f3f07e7`). Nothing is committed; the Director reviews and commits.
> **Last updated:** 2026-10-22

## Context

Phase 1 of the expansion (the task ledger, board, tree and timeline) and Codex's live-development fixes are on `main` at `26ec193`, unreleased. The latest release is `v0.1.0-beta.36`. Pop, Dot and Legacy were retired, leaving two looks. The documents were brought up to the code. Generated output was not touched: `docs/DOCUMENTATION.html`, `docs/library/catalog.json` and `docs/library/sources/**` need a rebuild by the Director. Dated records (`docs/history/**` except this file, `docs/releases/**`, `docs/evidence/**`, `docs/qa-schema/**`, `docs/design/archive/**`) were not rewritten.

## Files changed

Root and index:

- `AGENTS.md`: a new top amendment of 22 October 2026 (two looks, three expansion lanes, the release state); "(retired 21 October 2026)" at the first mention of Pop and Dot in the 19 October amendment.
- `README.md`: release figures set to v0.1.0-beta.36 and its release-notes link; the daemon budget line now cites `main.rs:1270`; the task board added to the daemon row.
- `docs/README.md`: status and date of the rows touched here; the tasks guide and reference added to "Start here"; a row for this record; the note on the documentation refresh.
- `docs/STYLE.md`: the names table (look, Blobots, task); date.

Design:

- `docs/design/design-system.md`: two looks only; Pop, Dot and Legacy rules removed or dated; the Settings page list corrected to the eleven pages; the Tasks entry; companion rules corrected to Blobots and Frost; robot outlines, the Flat and Dot renderers and the orbs checked; dated.
- `docs/design/bitbots-theme-spec.md`: front block kept; an "Update 22 October 2026" note (the pixel re-skin and `apps/desktop/src/ui/bitbots.css` are gone).
- `docs/design/ui-polish-wave.md`: a duplicate front block removed; an "Update 22 October 2026" note.
- `docs/design/product.md`: checked, no change needed.

Contracts and remote:

- `docs/ipc-contract.md`: a "Task board (22 October 2026)" section (RPCs, states, events, settings, restart, remote policy); task events added to the vocabulary; `appearance.style` values and the migration; the "Remote mode methods (design, not implemented)" heading retitled, and the reference to a spec file that does not exist removed; citations `main.rs:1270`, `:1339`, `:821`.
- `docs/remote/PROTOCOL.md`: rows for `task.*` and `agent.purge` added to the denied-methods table (nothing else changed, as instructed); date.
- `docs/remote/THREAT_MODEL.md`: section 15 added for the task board and bot deletion; date.

Operations, plans and legal:

- `docs/operations/operating-model.md`: a 22 October note that section 2 (lanes) is superseded; status and date.
- `docs/operations/implementation-status.md`: a "Documentation" paragraph in the 22 October section.
- `docs/operations/session-handoff.md`: a "Documentation (22 October 2026)" paragraph in the 22 October section.
- `docs/plans/expansion-plan-v2.md`: status (phase 1 on `main`, slices 1B and 1C and phases 2 to 5 not started); a 22 October note that the looks are two.
- `docs/plans/improvement-plan.md`: status changed to historical (a finished roadmap; phases 1 to 7 shipped in v0.1.0-beta.19).
- `docs/legal/third-party-notices.md`: the Legacy font paragraph rewritten (Doto and DM Mono are still bundled as selectable fonts, so the notice stays); the robot notice now names `BitbotCanvas.tsx`; date.
- `docs/guides/windows-development.md`: the "updater remains disabled" sentence reworded as past; date.

Library (sources only):

- `docs/library/content/overview.md`: two looks; the Manager's one exception (drafts); a Tasks paragraph; Settings page list; links to the tasks pages.
- `docs/library/content/glossary.md`: look and art entries; task and draft entries; Manager entry.
- `docs/library/content/guides/looks-and-appearance.md`: rewritten for two looks (Legacy, Pop and Dot sections and their screenshots removed from the text; fonts defaults and orbs corrected).
- `docs/library/content/guides/bots.md`: art table (picker's real options and outlines); default-art sentence; "Delete a bot permanently" section; archive text.
- `docs/library/content/guides/companion-and-dictation.md`: the companion theme sentence.
- `docs/library/content/guides/team-and-manager.md`: the `create_task` exception to the approval rule.
- `docs/library/content/guides/remote-access.md`: never-remote list includes archiving, deletion and the Tasks board.
- `docs/library/content/guides/five-minute-path.md`, `guides/automations-memory-and-skills.md`, `guides/backup-updates-and-troubleshooting.md`, `guides/conversations-and-approvals.md`: header status and date. The last three were not re-read in full: their status now says so.
- `docs/library/content/reference/theme-system.md`: the look model, the pre-paint script and the `data-bitbots` statement.
- `docs/library/content/reference/bot-art-system.md`: the art list and renderers; the pointer-following eyes of large Hand-painted avatars (the one listener); line citations.
- `docs/library/content/reference/settings.md`: `appearance.style` values; a Tasks settings section.
- `docs/library/content/reference/ipc-and-events.md`: `agent.purge`, the task family and the three task events.
- `docs/library/content/reference/daemon-and-storage.md`: database path citations; the task tables.
- `docs/library/content/reference/development-and-testing.md`: status, lane workflow of 22 October.
- `docs/library/content/reference/release-and-updates.md`: the example manifest names beta.36.
- `docs/library/content/reference/architecture.md`: status only.

Skill (`.claude/skills/bitbots-development/`):

- `references/codebase-map.md`: the Tasks entry (merged to `main`), review date.
- `references/verification.md`: the task board preview data and the retired look names in the preview URLs.
- `references/design-language.md`: Blobots default fonts.
- `references/pipeline.md`: the 21 and 22 October arrangement replaces the FIX40 roles as the current arrangement.
- `references/architecture.md`: review date; task board in the daemon row.
- `references/recipes.md`: new recipe "Add a task RPC or a board change".
- `references/lessons.md`: one dated lesson (2026-10-22) on sweeping documents after a look is retired.
- `SKILL.md`: unchanged (no retired statements found).

Status records:

- `docs/history/expansion-v2/status.md`: header status and date (the table itself is unchanged; its evidence column already names the merge).
- `docs/history/expansion-v2/README.md`: header status; the look list in the working arrangement; a link to this record.

New files:

- `docs/library/content/guides/tasks.md` (the Tasks page guide).
- `docs/library/content/reference/task-board.md` (RPCs, states, events, settings, storage, restart, remote policy, tests).
- `docs/history/expansion-v2/docs-refresh-2026-10-22.md` (this record).

## Facts checked against the code

- Looks: `apps/desktop/src/ui/appearance.ts` (`THEME_STYLES`, `THEME_LOOKS`: `bitbots`, `blobots`); `ui/LookPicker.tsx` (two orbs); `ui/LookOrb.tsx` (two orb drawings); `apps/desktop/src/ui/themes/` (only `frost.css`); no `ui/bitbots.css`, `pop.css`, `dot.css`; no `data-bitbots` set or read in the source (grep); `crates/bloblex-daemon/src/main.rs:1381` (`appearance.style` only `bitbots`/`blobots`); `crates/bloblex-storage/src/lib.rs` `normalize_removed_theme` (migrates `legacy`/`pop`/`dot`); `crates/bloblex-daemon/src/backup.rs:756` (restore migration); `apps/desktop/src/blob/bitbots.ts` `readStyle` (cache migration); `apps/desktop/index.html` (pre-paint script, no `data-bitbots`).
- Art: `apps/desktop/src/blob/art/art.ts` (`BOT_ARTS`, `ART_LABELS`: "Glossy", "2D robot", "3D robot", "Hand-painted"; `ROBOT_ARTS` = `robot`, `robot-pop`; `BLOB_ARTS` = `blob`, `painted`; `defaultArtForStyle`: bitbots to `robot-pop`, blobots to `blob`; `resolveArt` maps `robot-flat` and `robot-dot` to `robot-pop`; `PAINTED_SHAPES` has 12; `PAINT_FOR_SHAPE`); `ui/LookEditor.tsx` (picker: Automatic, Robots, Blobs); `blob/look/bot.ts` (`BOT_SHAPES` rectangle, square, circle, hexagon); `ui/BotEditor.tsx`; `blob/BlobCanvas.tsx` (switch); `blob/art/useEyeTracking.ts` (window `pointermove` listener, cleanup); `PaintedBlob.tsx` (`useEyeTracking` with `!mini && size >= 32`).
- Fonts: `apps/desktop/src/ui/fonts.ts` (`FONT_ROWS`: 24 entries; `FONT_DEFAULTS`: bitbots Inter, blobots base); `apps/desktop/package.json` (fontsource packages incl. `@fontsource/doto`, `@fontsource/dm-mono`).
- Wallpapers and glass: `blob/bitbots.ts` (`lake`, `dusk`, `bloom`, `sand`, `custom`); `ui/themes/frost.css` (`--radius-pill: 12px`; glass tint and blur; companion/dictation exclusions).
- Companion: `ui/theme.css` (`:root.companion-surface` fixed palette); `ui/themes/frost.css` (`companion-surface[data-surface-theme="light"]`).
- Settings pages: `ui/SettingsSheet.tsx` (`PAGES`: General, Appearance, Experimental, Remote, Agents, Manager, Memory, Skills, Speech, Backup, Updates).
- Sidebar and panel widths: `ui/shell.css` (`280px`, inspector `320px`).
- Tasks daemon: `crates/bloblex-daemon/src/tasks.rs` (`rpc()` method arms; `REPORT_ONLY`; `check_policy`; `queue_reason` returns `global_pause`, `bot_busy`, `global_limit`; `dispatch` accepts the claim; `after_turn` mapping; `advance_queue`; `startup`; `sweep`; `safe_task_event`, `run_event`; `manager_create` strips assignee fields; `task_cap` clamp 1 to 3, default 1; `emit_outcome` for finished states); `crates/bloblex-daemon/src/main.rs` (dispatch arm at line 825; `agent.purge` at 908; settings validation at 1404 and 1405; `budget.*` at 1270; `pricing.*` at 1339; `startup` call at 4340; test names in the 12100 to 12360 range); `crates/bloblex-daemon/src/team.rs` (`create_task` tool at 302, routed at 384 without an approval step); `crates/bloblex-daemon/src/automations.rs` (`tasks::sweep` at 368).
- Task storage: `crates/bloblex-storage/src/lib.rs` (`ensure_tasks_schema` at 878 with table definitions, check constraints and indexes; `TASK_STATES`; `task_create` input fields and limits; `task_update` (unassigned only); `task_dispatch_claim` (from `unassigned`, `awaiting_review`, `needs_you`, `failed`); `task_unassign` (queued); `task_reorder` (queued); `task_cancel_pending` (`unassigned`, `queued`); `task_request_stop` (`running`, `needs_you`); `task_review` (`done`, `needs_changes`, `not_done`; `done` to `done`, `needs_changes` to `awaiting_review`, `not_done` to `failed`); `task_recover_after_restart` (`ambiguous`, `restart_ambiguous`, task to `needs_you`); `normalize_removed_theme`).
- Remote policy: `apps/desktop/src/remote/tiers.json` (every `task.*` and `agent.purge` is `never`, `minTier` null; `task.changed`, `task.run.changed` and `task.run.finished` are `drop`).
- Desktop board: `ui/App.tsx` (Tasks icon button in `sidebar-top` > `sidebar-create-actions`, `tasksOpen`); `ui/TasksView.tsx` (views `board`, `tree`, `timeline`, default `board`; "New task" dialog; brief limit 8,000; title 1 to 120; Tree and Timeline; review buttons "Not done" and "Mark done"; Stop; Unassign; Discard; Try again with); `ui/DelegateBoard.tsx` (Unassigned list, Assign menu, drag); `ui/taskModel.ts` (`TASK_STATE_LABEL`); `ui/TaskTimeline.tsx` (observed timestamps only); `ui/TaskTree.tsx` (`parentTaskId`); `ui/useTasks.ts` (`needs_changes` in the type only; no UI path sends it); `preview/fixtureTasks.ts` (exists).
- Archive and delete: `ui/ProfileMenu.tsx` ("Archived bots" item); `ui/ArchivedBots.tsx` (Restore, "Permanently delete" button); `ui/App.tsx` (`purgeTarget`, `ConfirmDialog` with `holdToConfirm`, the confirmation wording); `crates/bloblex-daemon/src/main.rs` `agent.delete` (archives, pauses automations) and `agent.purge` (locked bots and the Manager refused; active sessions refused; cascade through `st.memory.forget` and related state).
- Storage paths: `crates/bloblex-daemon/src/main.rs:4272` (`BLOBLEX_DB_PATH`), `:4275` to `:4278` (`%LOCALAPPDATA%\Bitbots\bloblex.db`); `apps/desktop/src-tauri/src/lib.rs:909` to `:915` (data folder); `scripts/dev-windows.ps1` (`dev-data\bloblex.db`).
- Versions: `package.json` and `apps/desktop/package.json` and `apps/desktop/src-tauri/tauri.conf.json` (`0.1.0-beta.36`); `Cargo.toml` (`version = "0.1.0-beta.36"`); `git tag --sort=-v:refname` (latest `v0.1.0-beta.36`); `docs/releases/0.1.0-beta.36.md` exists; `git log v0.1.0-beta.36..f3f07e7` has 11 commits.
- Link check: every relative Markdown link in the changed and new files resolves (a Node script over the 47 changed Markdown files; the last run reported no missing links after the two library fixes).

## Removed

- Design rules and copy for Pop, Dot and Legacy (the Pop and Dot faces and their line rules, the Legacy pixel welcome, the "red on Dot" waiting eyes, the Pop palette, the Settings list that named three pages).
- Legacy, Pop and Dot sections of the looks guide, their font defaults, their orbs and the screenshot references to them in the text (the image files stay in `docs/library/assets/screens/`).
- Flat and Dot as picker choices in the bots guide and the glossary (kept as compatibility renderers, with that stated).
- The "Remote mode methods (design, not implemented)" heading wording and the reference to `docs/FIX29_REMOTE_TAILSCALE_SPEC.md`, which does not exist.
- A duplicate front block in `docs/design/ui-polish-wave.md`.
- The "Manager creates nothing without your approval" wording (it is not true for `create_task`).

## Not verified, and how each is marked

- Browser preview and native app: nothing was run in this pass. The tasks guide says the behaviours "are the ones the code and its tests describe" and that they were not re-run in the preview or the native app.
- Test results: no test was run. The task-board reference lists the test names from the code and says their results were not re-run.
- Contrast figures: the design system's text-contrast rule for overlay windows is marked "not verified against the 4.5:1 target in this pass".
- Settings page UI for `task.concurrency.max` and `task.globalPaused`: no control was found in `apps/desktop/src/ui` (grep); stated as "not shown in the Settings page as of this pass".
- Blobots companion palette: taken from `theme.css` and `frost.css` selectors, not seen on screen.
- Blobots and Bitbots default fonts: taken from `FONT_DEFAULTS`; the rendered result was not checked.
- `docs/library/content/guides/expansion-handoff.md` and the other dated 21 October records: left as written (historical), as instructed.
- Three library guides (automations, backup and troubleshooting, conversations and approvals) were not re-read in full. Their status line now says they are current for beta.35 content and not re-checked for `main`.
- Retirement date: AGENTS.md (22 October amendment) and this record use 21 October 2026. The design system's FIX40 section, `docs/library/content/reference/live-development-review-2026-10-20.md` and the 21 October handoff say 20 October. The documents keep their own wording; AGENTS.md is taken as the record.

## Still stale, outside this pass

- `docs/remote/PROTOCOL.md`: its status line still says "Design, not implemented" (the gateway exists). Only the denied-method rows were changed, as instructed.
- `docs/remote/PROTOCOL.md` and `docs/remote/THREAT_MODEL.md`: the tier table is described in the file as generated from `renderTierTableMarkdown()`; the new rows were added by hand. The generator should be checked.
- `docs/remote/REMOTE_MODE.md`, `docs/remote/ARCHITECTURE.md`, `docs/remote/UX_FLOWS.md`, `docs/remote/SEQUENCES.md`: not reviewed for the 22 October state.
- `docs/library/content/guides/expansion-handoff.md` and `docs/operations/expansion-handoff-2026-10-21.md`: historical; they still show five looks in their screenshot tables, with the 22 October update note at the top.
- `docs/library/assets/screens/main-pop.png`, `main-dot.png`, `main-legacy.png` and `docs/library/assets/expansion-2026-10-21/` images of retired looks: not deleted; the library may still show them in historical pages.
- `docs/operations/release-checklist.md`, `docs/operations/updater.md`, `docs/operations/native-smoke-results.md`, `docs/guides/live-checks.md`, `docs/reference/*`: not re-checked for the 22 October state (no retired-look statements found by grep).
- `docs/history/expansion-v2/status.md`: its evidence column still says "Frost and Pop before the theme removal" as a historical record.
- The library source and generated output: `docs/DOCUMENTATION.html` and `docs/library/catalog.json` must be rebuilt (`node scripts/docs-library.mjs build` and `check`), since `docs/library/content/` changed and two pages were added.
- `docs/STYLE.md`: the example version `v0.1.0-beta.35` in "Dates and versions" is an example, not a claim; left.
- `docs/guides/windows-development.md`: the rest of the file was not re-checked (its test counts, the lock-repair narrative and the local surfaces list are dated).
- `README.md` source map: the `apps/desktop/src/` row does not mention the Tasks board.
