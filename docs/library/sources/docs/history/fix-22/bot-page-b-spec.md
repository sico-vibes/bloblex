# FIX22: bot page, second batch (instructions, folders, permissions, memory, details, templates)

> **What this is:** Spec for FIX22: the bot page, second batch (instructions, folders, permissions, memory, details).
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026. Completes the bot-editor items of the approved polish plan
(B3, B7, B8, B9, B10, plus the data for B11). Read `docs/design/design-system.md`. Use
`entityNoun`/`useEntityNoun` (`ui/vocabulary.ts`). The editor is `ui/BlobPage.tsx`
(page chrome, rail and save bar already exist in `ui/BotPageChrome.tsx`) and
`ui/BlobSettings.tsx` (the field groups, each an `EditGroup` with an `id`). Draft model and
validation: `ui/agentForm.ts` (`changedFields`, `BotSection`). Reuse `ui/MemoryPage.tsx`,
`ui/Select.tsx`, `ui/Skeleton.tsx`, `ui/StatusDot.tsx`, `ui/undo.ts`.

**You own `BlobSettings.tsx`, `agentForm.ts`, `MemoryPage.tsx` and new files. Do not edit
`BlobPage.tsx`, `BotPageChrome.tsx` or `App.tsx` except the one insertion named in B3.**
Never commit; leave the diff and write `docs/history/fix-22/report.md` (one line per item).

## B3. Instructions editor

In the Model group, give instructions their own full-width sub-section:

- A taller textarea (10 rows, grows to 20, resizable), a live counter "`1,234` characters,
  about `300` tokens" (tokens = ceil(chars / 4), labelled "about"), no hard limit change.
- A **plain-language helper** that explains the three text fields once: Role is the label next
  to the name; Description is what teammates read to decide whom to ask; Instructions are the
  bot's standing brief. One short paragraph, collapsible after the first view
  (`useHintSeen('bot.instructions.help')`).
- **Preset chips** above the textarea (from `botTemplates.ts`, B11 data): clicking one asks
  nothing if the field is empty, otherwise offers "Replace" or "Add to the end" in a small
  inline choice. Never overwrite silently.
- **Versions**: keep the last 5 saved versions of the instructions per bot in `localStorage`
  (`bitbots.instructionHistory.<agentId>`, each `{ at, text }`, newest first, skip duplicates,
  cap each text at 20,000 characters). Export `recordInstructionVersion(agentId, text)` and
  `instructionVersions(agentId)`; a **History** popover lists them with time and a first-line
  preview and **Restore** (puts it in the draft, does not save). The one insertion in
  `App.tsx` is a call to `recordInstructionVersion` in the successful path of `saveBlob` when
  instructions changed. State plainly in the UI copy that history is kept on this device.
- Tests: counter, preset replace/append, history cap and restore.

## B7. Folder wording and recent folders

- Rename the two "project" concepts in labels and hints: the Team row becomes **Team project**
  ("Which project this bot belongs to on the team"), the Model-group field becomes **Working
  folder** ("Where this bot works when you start a conversation"). Update every string, hint,
  `aria-label` and test that uses the old words in this file.
- The working-folder field gets a **Recent** menu of the last 6 folders chosen in this app
  (`localStorage` `bitbots.recentFolders`, newest first, deduped, valid strings only), plus
  the existing Browse button. Export `rememberFolder(path)` and call it when a folder is
  chosen. Tests.

## B8. Permissions in plain language

- In the Permissions group replace the bare mode names with a three-row choice that states
  what each mode does in one sentence ("Ask first: nothing changes until you approve each
  action", "Auto-approve: safe actions go through, risky ones still ask", "Bypass: nothing
  asks; use only on a computer and project you trust"). Keep the existing values and the
  bypass typed-confirmation flow untouched. Only Bypass uses the warning colour.
- Under the choice show "Approved without asking recently: N actions" from the data already
  passed in (`autoApprovals`), linking to the existing list. Tests.

## B9. Memory and activity on the page (edit mode)

- A **Memory** group (id `memory`) listing this bot's memory notes (scope = this bot) using
  the existing memory RPCs (read `MemoryPage.tsx` for `memory.list` params), read-only with an
  "Open in Settings > Memory" link; empty state "No notes yet". Respect the `experimental.memory`
  switch (hide the group when memory is off).
- A one-line **Activity** row: conversations count and last active time computed from the
  `sessions` prop. Do not invent token figures; if the daemon has no per-bot usage, do not
  show any.
- The rail in `BotPageChrome.tsx` gets a `memory` entry; **export the group and tell the
  Director in the report**, who will add the rail entry (do not edit that file).

## B10. Technical details collapsed

- The Details group (concurrency, evidence, last snapshot) becomes a disclosure
  (`aria-expanded`), closed by default, titled "Technical details", with the same content.
  Remember open/closed in `uiPrefs`-style localStorage. Tests.

## B11 data: `ui/botTemplates.ts`

Export `BOT_TEMPLATES`: id, name, tagline (one line), `role` (at most 40 chars), `description`
(at most 255), `instructions` (a real, useful standing brief of 6 to 12 lines), a suggested
`color` swatch id and `look.shape` from the existing set. Templates: Code reviewer, Test
writer, Documentation writer, Refactoring helper, Bug hunter, Researcher, and Blank.
Pure data plus `applyTemplate(draft, template): AgentDraft` (keeps runtime, model and
approval mode). Table tests. The Director builds the create wizard on top of this and of one
prop you add: **`BlobSettings` accepts `sections?: BotSection[]`; when given it renders only
those groups** (default: all). Test it.

## Gates

`npm run typecheck`, `npm run test`. Update existing tests that assert changed strings.
