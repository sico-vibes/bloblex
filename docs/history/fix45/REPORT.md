# FIX45 — session rail, drafts, delete hold, dictation, Manager and outcome fixes

Status (25 October 2026): **local, uncommitted** in the main checkout. The owner stopped browser, screenshot, full test suite and final screenshot checks. The web, remote PWA, native review and daemon debug builds succeeded (see Verification boundary). Nothing here claims a full suite passed. Evidence below separates what the lanes reported from what this record verified.

## What changed

1. **Session outcome.** A late process error with no active turn cannot overwrite a completed outcome; the newest completed turn repairs a stale `error` label. A genuine failure of an active turn stays failed. `ui/sessionOutcome.ts` (`presentedSessionState`) feeds the companion, the working panel (`WorkingBotsPanel.tsx`), `BlobSessions.tsx` and the notification transition in `App.tsx`. The unproven ACP success inference is removed (`provider_turn_end` was eliminated); genuine provider errors remain failures.
2. **Session rail reads the repository.** `session.repository` (`crates/bloblex-daemon/src/repository.rs`) reports the project's Git state: branch (or unborn or detached), working tree against HEAD including staged, unstaged and untracked files, line totals and per-file diffs, all bounded and shell-free, with no symlink traversal. It is read-only and **never remote**, because raw diffs can contain environment values (`remote/tiers.json`, class `never`). The rail shows Changes (the repository's state, labelled as such) and Outputs, with the conversation's own recorded files kept separately.
3. **Create PR** is a dialog that sends one ordinary message to the current coding agent after the user confirms it. It is not a Git mutation. The dialog says that the whole repository's uncommitted state is sent.
4. **Drafts** (`ui/draftStore.ts`): text per conversation and `draft:<agentId>`, versioned storage `bitbots.drafts.v1`, 2 h since last edit on the local clock, shared by the main window and the companion. A held send keeps its text until the daemon accepts it; a refusal restores it. Live text is never truncated on screen; only the restart backup is bounded.
5. **Archived bots** show three skeleton rows with a status label while they load.
6. **Hold to delete** keeps the same footprint in idle, holding, armed and pending. The armed label is `Release to <first word>`, and the button no longer scales.
7. **Dictation is recorder-only** (owner decision). Live words, the "Words appear when you stop" line and the cloud note are removed from the island, bubble, companion and composer. The final transcript reaches the box on stop. The speech crate still emits partials; the UI no longer consumes them.
8. **Manager messages** from Manager to a bot are sent directly again, with no task or proposal. Consequential writes stay approved. The approval gate was introduced in `fd738b2` (FIX39 P7). The archived-bot guard is unchanged.

## Source implementation (this record, read narrowly)

- UI: `ui/sessionOutcome.ts`, `ui/sessionRepository.ts`, `ui/SessionRail.tsx`, `ui/sessionRail.css`, `ui/PullRequestDialog.tsx`, `ui/draftStore.ts`, `ui/BlobPage.tsx` (the hold-to-delete button, `hold-confirm-button`), `ui/DictationIsland.tsx`, `ui/DictationBubble.tsx`, `ui/dictation.ts` (`useDictation`), `preview/fixtureBridge.ts`. Confirmed in `main` by grep: the draft store constants, the `session.repository` fixture and the absence of the live-word text outside tests.
- Backend: `crates/bloblex-daemon/src/repository.rs` was implemented in the backend lane's tree (`D:/fx72`). Backend integration is complete in `main`: 13 Rust files were copied after confirming the originals were unchanged. `remote/tiers.json` has the `session.repository` row in `main`.
- Commit `fd738b2`: the approval-gate introduction for ordinary Manager messages.

## Verification boundary

- **UI lane report** (`D:/bitbots-fix45-run/ui-report.md`): `npx tsc -b` reported clean; focused mounted and unit tests reported passing before the last edits. Not re-run after the last edits: `DictationIsland.mounted`, `App.pullRequest.mounted`, the full suite. No browser or screenshot checks were run after the first pass.
- **Backend lane**: backend integration is complete in `main` (13 Rust files copied; see Source implementation). No full suite or focused test result from the lane is recorded here.
- **Builds (succeeded)**, from the logs in `D:/bitbots-fix45-run/`:
  - Web production build (`web-build.log`): `vite build` completed ("built in 12.99s").
  - Remote PWA build (`remote-build.log`): `dist-remote` built ("built in 3.08s").
  - Native review executable (`review-exe-build.log`): `bloblex-desktop` 0.1.0-beta.38 built in the `dev` profile from `D:\fx72`; `BitbotsReview.exe` was produced in the main checkout's `target\debug`.
  - Daemon and hook debug build (`review-daemon-build.log`): `bitbotsd` built in the `dev` profile, with one `unused_mut` warning.
- **Local review copy**: `D:/bitbots-review45/Bitbots Review.exe` is a copy of the review build. The review app is launched: process 50240, native title `Bitbots Review`, rebuilt daemon child 61620. The root verified the process and window title only; no screenshots or UI sweep were taken. Relaunch with `D:/bitbots-review45/Run Bitbots Review.cmd`, which supplies its own `LOCALAPPDATA` and `BLOBLEX_DB_PATH`, separate from the original data. Its chats and bots were copied, and unattended work is paused. The original installed app is untouched.
- **Not run, at the owner's request**: the full test suites and the final screenshots. Browser and screenshot checks were stopped by the owner; this record claims no test pass.
- **This record** ran no tests or gates. The four builds above are the only results recorded.
- **Not verified:** the native window and the delete-hold footprint in a browser; the rail, skeleton and island in the final build; `remoteTiers.parity.test.ts` after the backend integration into `main`; whether it passes is unknown.

## Remaining risks

- Two held sends in one box are restored together, joined by a blank line, after a restart.
- Create PR sends the whole repository's uncommitted state; this is stated in the dialog, not enforced.
- The `recipes.md` UtteranceTracker entry is corrected: the UI ignores partials and shows the recorder only.

## Skill updates

- `references/lessons.md`: one dated FIX45 entry (stale Failed label, hold footprint, drafts, repository, Manager, recorder-only dictation); the FIX43 live-word entry marked as superseded; a note on the backslash quoting problem.
- `references/design-language.md`: a FIX45 section (recorder-only dictation, the Changes card, Create PR confirmation, hold footprint, archived skeleton, drafts) with FIX44 rules untouched.
- `references/codebase-map.md`: session rail, drafts, outcome and repository modules; `repository.rs`; the FIX45 history path.
