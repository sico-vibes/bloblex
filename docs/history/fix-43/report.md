# FIX43 report

> **Status:** historical record
> **Last updated:** 2026-10-25

Implementer: one Claude Sonnet 5.5 agent at high effort, in `D:\fx71` (branch `fix43/sonnet`), from [the brief](brief.md). The agent's sandbox refused to write this file, so the Director recorded its report here, with the Director's review. Work log: [lane-log.md](lane-log.md).

## Items

1. **Select inside a dialog.** `.select-menu` was absolutely positioned under its trigger, so inside a scrolling dialog it grew the dialog. Inside `[role="dialog"]` the list now renders in a portal, `position: fixed`, placed from the trigger and flipped up when there is no room (`apps/desktop/src/ui/Select.tsx`). Test `Select.dialog.mounted.test.tsx`.
2. **`sqlite: no such table: tasks`.** `Storage::migrate` returned early per schema version and only the fresh-database path called `ensure_tasks_schema`; every daemon test uses an in-memory database, so none saw it. `migrate` now calls it on every path (`crates/bloblex-storage/src/lib.rs`). Test `an_existing_database_without_the_task_tables_gains_them_on_open` fails without the fix.
3. **Tasks.** Images (owner and the Manager's `create_task`), checked like chat attachments and copied under generated names into `<data>/task-images/`; `task.image` thumbnails (remote: `never`). Every editable field in `TaskForm.tsx`; **When** is Now, Once or Repeat through the automation parser, shared `ScheduleWhen.tsx`, next run times and the notice "Runs only while Bitbots is open and this computer is on and awake. A run that is missed by more than five minutes is skipped, not run late." A repeat is an unassigned template that starts a copy per occurrence; late, paused or overlapping occurrences are skipped and recorded. Scheduled runs use the unattended rails (`is_unattended`). The time limit is now enforced for every task run (`tasks::watchdog_at`). The automation editor's preview also read the wrong field and always said "No upcoming runs"; `schedulePreview.ts` fixes both editors.
4. **Message buttons.** The row inside `.message-action-shell` kept its group margin, so the buttons centred on row plus margin. `experiments.css` resets it. Test `messageActionsLayout.test.ts`.
5. **One companion layout.** Every look uses the shell (bot list, header, one pane); Frost and Stone keep their own bot art and status badges, the gradient stays Haze-only. The island overview, tab header, `CompanionPeers`, `FocusTicker` and `teamLine` are gone. The first-run drag hint is a strip under the header.
6. **Resizable companion.** Eight page-drawn handles drive `companion_resize_begin/step/end`; `set_companion_size_preset` (large, normal, default); saved in `companion-size.json`, default 640×420, minimum 520×340, large 960×720, clamped to the work area. The chat-height setting is removed. Always on top was already set.
7. **Bot without a conversation in the companion.** The main window's FIX38 H2 local draft was excluded in the companion; it now applies there, and the first message creates the conversation.
8. **Live dictation words.** Parakeet is an offline recognizer and only returned text when a 30 s chunk filled or on stop. `UtteranceTracker` (`crates/bloblex-speech/src/utterance.rs`) gives a partial about every 1.2 s while speaking and a final after 0.9 s of silence. Cloud dictation says "Words appear when you stop."
9. **Whistle.** `libneedle.a` is an llvm-mingw object needing libc++ and the Itanium unwinder, so it cannot link with MSVC; the owner-approved fallback runs Cactus's `needle.exe` as a subprocess (`needle.rs`). `whistle.cact` 16,919,407 bytes, SHA-256 `b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb` (`Cactus-Compute/whistle` @ `741118687e1f008f06d1351a402a731274789790`); `needle.exe` 1,570,816 bytes, SHA-256 `0d4bc1da8c51f5600f5c4f4bb4a92e0abe142fae7b69e695ccab93e6745c883d` (`Cactus-Compute/needle3` @ `d6c7d6a2e9655505e0f8e23339356dd1705900eb`), re-hashed before every load. Audio passes as a temporary WAV deleted after each run.
10. **Branch tree.** The line drawn inside the parent row is gone; the children start 3 px below the card (`conversationsPanel.css`).

## Director review (25 October 2026)

Read the needle runner, image adoption and the native resize commands: two file paths on the `needle.exe` command line, no console window, 25 s timeout, only the transcript read; images validated by `prompt_attachments` and stored under UUID names; resize commands registered and limited to the companion window. Checked in the preview: the companion layout in Frost and Stone, the task dialog's floating Project menu (dialog height unchanged), the Repeat notice and next run times, the companion header after the hint moved. Sent back and fixed: the `FIX37.updateBadge` test pinned `v0.1.0-beta.36` (broken by the beta.37 bump; it now reads `package.json`), the drag hint crowding the header, and the preview fixture's next-run times ignoring the chosen time.

## Gates

In `D:\fx71` and again on the merged `main`: `npm run typecheck` clean; Vitest 1,408 tests in 191 files; production web build; clippy clean excluding the desktop crate (the desktop crate has 8 older clippy findings in untouched committed code; it is not a project gate); Rust workspace tests excluding desktop all pass (daemon 471) with `RUST_MIN_STACK=16777216`; desktop library 70.

## Unverified

Native companion resize, always on top and DPI behaviour in the installed app; the downloaded `needle.exe` and its output format (parsed leniently as JSON with `text`); Parakeet partial decode speed on the owner's machine; a live provider receiving task images; a scheduled run firing in the real app; the migration on the owner's real database (tested on a file database).
