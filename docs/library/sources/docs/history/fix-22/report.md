# FIX22 report — bot page, second batch

> **What this is:** Report on FIX22: the bot page, second batch.
> **Status:** historical
> **Last updated:** 2026-10-15

Worktree `C:\fx34b`, `opencode-go/deepseek-v4.1-flash`. Gates run: `npm run typecheck`,
`npm run test` (both green). Never committed. One line per item; nothing is claimed as
verified beyond the gates below.

## What was done

- **B3 instructions editor — done.** In the Model group, `InstructionsSection` in `BlobSettings.tsx` gives instructions a full-width sub-section: a 10-row textarea that autosizes up to 20 rows and stays `resize: vertical`; a live counter (`1,234 characters, about 300 tokens`, tokens = `ceil(chars/4)`, word "about"); a one-paragraph helper explaining Role, Description and Instructions that collapses after first view via `useHintSeen('bot.instructions.help')`; preset chips from `botTemplates.ts` that fill an empty field directly and otherwise offer an inline **Replace** / **Add to the end** choice; and a **History** popover (time, first-line preview, **Restore**) backed by the on-device store, with copy saying history is kept on this device. No hard limit changed.
- **B3 versions store — done.** New `ui/instructionHistory.ts`: `recordInstructionVersion(agentId, text)` and `instructionVersions(agentId)`, key `bitbots.instructionHistory.<agentId>`, `{ at, text }`, newest first, duplicates skipped, text capped at 20,000, latest 5 kept.
- **B3 App.tsx insertion — done (one statement, two call sites).** `saveBlob` calls `recordInstructionVersion(agent.id, draft.instructions)` when `draft.instructions !== baseline.instructions`, in both successful branches (create and update); the create branch returns early, so the single statement appears once per branch. This is the only `App.tsx` change (plus its import).
- **B7 folder wording — done.** Team group row is now **Team project** ("Which project this bot belongs to on the team."); the Model-group field is now **Working folder** ("Where this bot works when you start a conversation."), including `aria-label`s and the empty option ("No team project (casual)"). `changedFields` labels the team field "Team project" (`agentForm.ts`).
- **B7 recent folders — done.** `ui/folderRecents.ts` exports `rememberFolder(path)` and `recentFolders()` (key `bitbots.recentFolders`, newest first, deduped, valid strings only, max 6). The working-folder field has a **Recent folders** `Select` and a **Browse…** button (`openProjectFolder()`); choosing either remembers the folder.
- **B8 permissions in plain language — done.** The bare approval `Select` was replaced by a three-row `radiogroup` (Ask first / Auto-approve / Bypass) with the exact sentences from the spec; values are unchanged and the bypass typed-confirmation flow is untouched; only Bypass uses the warning colour. A "Use the team default" button restores the null value. Under the choice: "Approved without asking recently: N actions" from `autoApprovals`, linking (scroll) to the existing `AutoApprovedList`.
- **B9 memory and activity — done.** New `ui/BotMemoryGroup.tsx` (exported, with `MEMORY_SECTION_ID`) renders a `memory` group in edit mode reading `memory.list` (`scope: 'blob'`, `scopeId: agentId`), read-only, with an "Open in Settings › Memory" link and an empty state "No notes yet". It is hidden unless `experimental.memory` is on: `BlobSettings` reads the switch itself via `settings.get`, or takes the `memoryEnabled` prop when given. A one-line Activity row ("N conversations · last active …") is computed only from the `sessions` prop, with no token figures invented.
- **B9 rail entry — director action.** `BotPageChrome.tsx` was not edited. Please add `{ id: 'memory', label: 'Memory' }` to `railSections` (the group already renders `id="bot-section-memory"`), or render `<BotMemoryGroup>` yourself; export is `MEMORY_SECTION_ID` / `BotMemoryGroup`.
- **B10 technical details — done.** The Details group is now a disclosure titled "Technical details" (`aria-expanded`/`aria-controls`), closed by default, with the same content kept in the DOM via `hidden`, its open state remembered by `ui/botPrefs.ts` under `bitbots.botPage.detailsOpen`.
- **B11 templates — done.** New `ui/botTemplates.ts` exports `BOT_TEMPLATES` (Code reviewer, Test writer, Documentation writer, Refactoring helper, Bug hunter, Researcher, Blank) with `id`, `name`, one-line `tagline`, `role` ≤ 40, `description` ≤ 255, a 6–12 line `instructions` brief, a swatch `color` and a `shape` from the existing set, plus `applyTemplate(draft, template)` (keeps runtime, model, thinking, speed and approval mode) and `instructionPresets()`. `BlobSettings` accepts `sections?: BotSection[]` and renders only those groups when given; `BotSection` now includes `details` and `memory`.
- **Tests — done.** New: `instructionHistory.test.ts`, `folderRecents.test.ts`, `botTemplates.test.ts` (table), `BlobSettings.botPageB.mounted.test.tsx` (counter, preset replace/append, history cap/restore, folder wording and recents/Browse, permissions choice + auto-approval count, memory on/off/empty/activity/link, details disclosure, `sections`). Updated existing: `approvalModes.mounted.test.tsx` (bypass flow now a radio row) and `App.agent.mounted.test.tsx` (Instructions located by `aria-label` after the label moved to the sub-section head).

## Wiring the Director still needs (files I was told not to edit)

- `BotPageChrome.tsx`: add the `memory` rail entry (see above).
- `BlobPage.tsx` → `BlobSettings`: pass `sessions={sessions}` for the Activity row, and `onOpenMemory={() => { setSettingsInitialPage('Memory'); setSettingsSheet(true) }}` for the Settings link. `memoryEnabled` is optional: without it the group follows the daemon's `experimental.memory` setting.
- `sections` is ready for the B11 create wizard; `applyTemplate` is the intended way to fill a draft from a template.

## Gates

- `npm run typecheck` — pass.
- `npm run test` — pass: 122 files, 775 tests.

## Not verified

- No native window, browser-preview or real-pointer run was done (source and mounted tests only).
- The current `BlobPage.tsx` does not yet pass `sessions`/`onOpenMemory`, so the Activity row and the Settings link are exercised only in the new mounted tests until the Director wires them.
