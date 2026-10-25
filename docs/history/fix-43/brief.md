# FIX43 brief: tasks, companion, chat polish, dictation and Whistle

You are the implementer for this wave: Claude Sonnet 5.5 at high effort. The owner asked that this whole wave be done by you, in order, and not by the Director (owner, 24 October 2026). The Director reviews your diff, runs the final gates, merges and commits.

## Ground rules

- Work only in the git worktree `D:\fx71` (branch `fix43/sonnet`, cut from `main` at `30c7b3d`, which is the released `v0.1.0-beta.37`). Do not touch the main checkout at `D:\Basem's\Coding\Blolblex` except to read it.
- **Never run `git commit`, `git push`, `git reset`, `git stash`, or switch branches.** Leave every change uncommitted in `D:\fx71`.
- First read `D:\fx71\AGENTS.md` (the top amendments say how this project runs) and `D:\fx71\.claude\skills\bitbots-development\SKILL.md`, then the reference file for each area (`design-language.md`, `codebase-map.md`, `recipes.md`, `verification.md`, `lessons.md`). When something fails in a way you do not understand, search `lessons.md`, `docs/history/` and `git log -S` before guessing, as the skill says.
- The owner's reference screenshots are in `D:\fx71\design-reference\` (named per item below). Look at each one with your Read tool before starting the matching item.
- Keep a short work log in `D:\fx71\lane-log.md` (one line per step, what you did and what is left) so the work can resume if you stop.
- Match the surrounding code: dense one-line JSX and long lines are normal here; few comments; plain sentence-case, British-neutral copy with no exclamation marks. Never weaken or delete a test to make it pass; update a test only where the owner changed the behaviour it pins, and say so.
- Use separate build output: `CARGO_TARGET_DIR=D:\fx71\target` for every cargo command. Daemon tests need `RUST_MIN_STACK=16777216`. The desktop crate (`bloblex-desktop`) builds from `D:\fx71` because the path has no apostrophe; for a library test without staged sidecars use `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'` (see `verification.md`). Run `npm run build` in `apps/desktop` before a desktop-crate test in a fresh worktree, then revert line-ending churn in `apps/desktop/src-tauri/gen/schemas/` with `git checkout --`.
- Browser preview for this worktree: start the `fx71-preview` configuration with your preview tool (port 5175), not a shell command. Useful URLs: `http://localhost:5175/?style=haze`, `?style=bitbots`, `?style=blobots`, `?companion&style=haze&mode=home&view=chat`. Check UI changes in Haze, Frost (`bitbots`) and Stone (`blobots`), dark and light (`&theme=light`). Native window behaviour (resizing, always on top) cannot be seen in the preview; prove it with code and Rust tests and say it is unverified in the app.
- Security and privacy rules in `AGENTS.md` stand: never log message text, audio, transcripts, credentials or tokens; no new Tauri plugin or capability without saying why in the report; downloads are pinned by revision and SHA-256.

## Items, in this order

### 1. Task dialog: the Project menu opens inside the dialog (`01-task-project-dropdown-inside-dialog.png`, `03-new-task-dialog.png`)
In the New task (and edit task) dialog, opening the Project dropdown renders its list inside the dialog and the dialog grows. The list must float above the dialog (a portal or overlay positioned against the trigger, like the app's other menus), never change the dialog's size, flip upwards when there is no room below, and close on Escape and outside click. Check `apps/desktop/src/ui/Select.tsx` and how `TasksView.tsx` uses it; fix it for every Select inside a dialog, not only this one. Mounted test.

### 2. Tasks page shows `sqlite: no such table: tasks` (`02-tasks-sqlite-no-such-table.png`)
The owner sees this on the Tasks page in the installed `v0.1.0-beta.37`, with an existing database from earlier versions. Find the real root cause in the daemon/storage (for example `ensure_tasks_schema` in `crates/bloblex-storage/src/lib.rs` not running for an existing database, running on a different connection or database file, or running after the first query). Fix it so an existing database gets the task tables on startup, and add a storage test that opens a database created without the task tables (the shape an older version left) and then lists tasks successfully. Record the cause and fix in `lessons.md`.

### 3. Tasks: images, full editing and schedules
- **Images.** A task can carry image attachments. The owner can attach images when creating or editing a task (paste, drop or choose a file), see thumbnails, and remove them. When the owner gives the Manager images in a conversation and asks it to make tasks, the Manager's draft-task tool can attach those images to the drafts. The images travel to the bot when the task runs (follow how chat attachments already reach a provider: search `stagePromptAttachment` and the attachment code in the daemon and adapters). Store them the way chat attachments are stored; size and type limits like chat; never log their contents. Remote devices stay denied for every `task.*` method (`apps/desktop/src/remote/tiers.json`).
- **Everything editable.** The task dialog exposes every field the contract allows (title, brief, done goal, report back, project, assignee, supervision policy if more than `report_only` is allowed, time limit) with plain labels. Read `docs/history/expansion-v2/tasks-contract.md` and `docs/plans/expansion-plan-v2.md` (slice 1C, task schedules) first.
- **When it runs.** A "When" control: Now (when assigned), Once at a date and time, or Repeat (a schedule). Reuse the existing automation scheduler and its once/cron/timezone parser instead of writing a second one (search `automation_create`, `SchedulesView.tsx`, `cron.rs`). Show the next few run times. Unattended runs keep the project's caps: a runtime limit, the concurrency limit, the global pause, and a permission mode that is never bypass (AGENTS.md, budgets amendment). Whenever a task has a time or a schedule, show this disclaimer under the control: "Runs only while Bitbots is open and this computer is on and awake. A run that is missed is skipped, not run late." (adjust the second sentence if the scheduler behaves differently; say what it really does).
- Daemon tests for the new fields and RPCs, mounted tests for the dialog, and update `docs/ipc-contract.md` for any RPC change.

### 4. Chat: message actions not centred on the bubble (`04-message-actions-offset.png`)
The time, copy, reply and reaction buttons beside a sent message sit slightly above the bubble's vertical centre. Centre them on the bubble, in every look, for one-line and multi-line messages, with and without a reaction badge above the bubble. Look at `MessageActions.tsx` and the message row styles.

### 5. Companion: one layout for every look
The owner likes the rebuilt Haze companion (the `hazeShell` branch of `Companion` in `apps/desktop/src/ui/App.tsx` and the `.haze-companion` rules in `apps/desktop/src/ui/themes/haze.css`: the bot list on the left, the open bot's header and conversation on the right, approvals, activity and settings in the same pane, and the compact bar). Use this layout in Frost (`bitbots`) and Stone (`blobots`) too. Owner decision: each look keeps its own bot art (mascots) and its own status dots there; the status gradient stays Haze-only. Move the shared layout rules out of `haze.css` into the companion stylesheet with look tokens, keep Haze's gradient rules in Haze, and keep the drag-region behaviour (`stampCompanionDragRegions`). The old island layout (overview cards, tabs header) goes away; update the companion tests that pinned it (`App.companion.mounted.test.tsx`, `FIX20.companion.mounted.test.tsx`, `FIX21.companion.mounted.test.tsx`, `App.hazeCompanion.mounted.test.tsx`) because the owner changed this behaviour, keeping every behaviour those tests check (keyboard access, drag targets, approvals, drop zone, activity summary, settings) working in the new layout.

### 6. Companion: resizable, always on top (`05-companion-cramped.png`)
The expanded companion feels cramped and cuts text off. Let the owner resize it by dragging its edges and corners (width and height), with a sensible minimum (big enough that nothing is cut off) and a maximum of the work area, remember the size across restarts, and keep it always on top, so it works as a mini version of the app beside a game or another app. The compact bar keeps its fixed size. Native sizing lives in `set_companion_mode` in `apps/desktop/src-tauri/src/lib.rs` (fixed sizes today, `chat_height` from the Compact/Comfortable/Tall setting) and `apps/desktop/src/blob/companionLayout.ts`. The window is transparent and frameless, so check whether native resize works on it; if not, add your own resize handles that call the window's resize. Replace or fold in the chat-height setting so there is one clear way to size it. A maximise button in the companion header that grows it to a large size (and restores) is welcome. Rust tests for the clamping and persistence, and say what you could not verify without the installed app.

### 7. Companion: a bot without a conversation cannot be opened
In the companion, choosing a bot that has no conversation yet does not let the owner open it or talk to it. The main window had this same bug and it was fixed: find that fix (search `docs/history/` for it, `lessons.md`, and `git log -S` around the empty-conversation and bot-selection code, for example FIX38 `h2-empty-conversation-spec.md`) and apply the same behaviour in the companion, so a bot with no conversation shows a ready composer and the first message starts its conversation. Mounted test.

### 8. Dictation shows no words while speaking (`06-dictation-no-live-words.png`)
In the installed app, while dictating, the dictation island shows the timer and the waveform but no words as the owner speaks; the browser preview's demo does show words appearing. Find out why live text does not appear in the real app (for example the on-device engine sends only finals, partial events never reach the island, or the island ignores them for this engine) and make live words appear while speaking where the engine can produce them. If an engine cannot produce partials, say so in the island plainly instead of showing nothing. Search `docs/evidence/dictation-*.md` and `docs/history/fix-01/dictation-spec.md` first. Tests at the level the bug lives.

### 9. Whistle: a downloadable small dictation engine
Add Cactus Whistle as an on-device dictation engine the owner can download and choose in Settings › Speech, next to the current engines (Parakeet v3 is about 670 MB; Whistle is about 17 MB). Facts gathered on 24 October 2026:
- Model: `whistle.cact` in the Hugging Face repo `Cactus-Compute/whistle`, about 16.9 MB, Apache-2.0. Engine: the Needle engine, Hugging Face repo `Cactus-Compute/needle3`, platform folder `windows-x86_64` with `needle.exe`, `libneedle.a` and `needle.h`; source on GitHub `cactus-compute/needle` (Apache-2.0). C API: `needle_load`, `needle_transcribe`, `needle_embed`. It takes 16 kHz mono audio; 7 languages (English, German, French, Spanish, Italian, Dutch, Polish); punctuation and casing are not documented.
- Owner decision on integration: first try to link Cactus's C library into the speech engine (`crates/bloblex-speech`). If it will not link on Windows MSVC, fall back to downloading their prebuilt `needle.exe` on first use, pinned to a Hugging Face revision and SHA-256 like the model files (`crates/bloblex-speech/src/catalog.rs` pins files this way), and run it as a local subprocess with audio passed through a file or stdin, never through command-line text that holds transcripts. Record which route you took and why.
- Live words: if the engine can stream, feed partials to the island (item 8); if not, say so.
- Add the model to the catalogue with its real size and hashes (download the files once to read their SHA-256; record the revision you pinned), the download and progress UI the other models use, and a line in `docs/legal/third-party-notices.md`.
- The on-device default stays as it is, and the existing fallback rules for dictation stand.

### 10. Conversation list: branches start below the card (`07-branch-arrow.png`, `08-claude-code-branch-tree.png`)
In the conversation list, a conversation's side branches hang from the same arrow as the parent row. The owner wants the tree to start below the parent card and run down to each child, like Claude Code's branch tree in the reference. Find the rows and tree lines (search `tree-line`, the conversations panel, FIX38 `h3-tree-lines-spec.md`), redraw the connector from the bottom of the parent card, and check it in every look.

## Gates (run from `D:\fx71`, report the tail of each)

```
npm run typecheck
npm test
cd apps/desktop; npm run build
cargo clippy --workspace --all-targets -- -D warnings        (CARGO_TARGET_DIR=D:\fx71\target)
cargo test --workspace --exclude bloblex-desktop             (RUST_MIN_STACK=16777216)
cargo test -p bloblex-desktop --lib                          (TAURI_CONFIG as above)
```

## Before you finish

- Update the skill as `SKILL.md` "Keep this skill current" says (lessons for every non-obvious cause, codebase-map for new modules, recipes if a recurring change gained a step, design-language for changed visual rules).
- Write `D:\fx71\report.md`: per item, what you did, the root cause where there was a bug, files changed (`path:line`), tests added, what you checked in the preview (and in which looks), decisions the brief did not settle, and everything you could not verify. Then the gate tails.
