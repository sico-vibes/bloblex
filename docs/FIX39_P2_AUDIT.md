# FIX39 P2 audit (Claude Sonnet 5.5)

**Verdict: PASS WITH FIXES.** The feature works as specified and the tests prove it. One security finding (F1) must be fixed before merge. The rest are small.

Scope audited: `git diff` and `git status` in `C:/fx82`, the report `docs/FIX39_P2_REPORT.md`, `docs/FIX39_DECISIONS.md`, the P2 section of `docs/FIX39_RESEARCH_AUDIT.md`, and owner items 17 and 4 in `docs/FIX39_FEEDBACK.md`. I did not re-run the gates. The report's results look consistent with the diff.

## Items

| Item | Result |
|---|---|
| 17: readable titles for old and new turns | Done. `tool_activity` in agent-core feeds the Claude, Codex and ACP adapters. `activityTitle` and `activityInput` in the UI parse old stored JSON input. Clipped or unparseable JSON falls back to a stored path or a generic label (`ActivityDetails.tsx:47-60`, `conversation.ts:128`). |
| 17: grouped steps | Done. Commands, Files, Searches, Edits, Other, in that order, with empty groups omitted (`ActivityDetails.tsx:97-109`). The conversation and the companion share it. |
| 17: full command only on expand | Done. The row shows "Ran" plus the first line, capped at 80 characters. The full command appears in the step detail only. The test asserts this. |
| 17: Remote redaction parity with the new fields | Fields in `detail` are covered (see F1 for what is not). |
| 4 (Rust half): `valid_look` accepts `circle`, `pebble`, `squircle` and all ten old names | Done (`storage/lib.rs:5185`). The test covers all 13 names and rejects an unknown one. |

## Findings

### F1. Security: `tools[].title` now carries command, path, pattern and URL text into Remote by default (must fix)

- **Where:** `crates/bloblex-adapter-claude/src/lib.rs:570`, `crates/bloblex-adapter-acp/src/lib.rs:917` and `crates/bloblex-adapter-codex/src/lib.rs:932` set the event `title` to `tool_activity(...).label`. Storage keeps it as `tools[].title`. Remote only hides `tools[].detail` unless `includeToolOutput` is set: `remote/policy.rs:450` and `ToolDetail` at `:511`, with the TypeScript twin at `remoteTiers.ts:360-406`. The title is not hidden by default.
- **What is wrong:** the report says `label`, `pattern`, `url`, `path` and `command` "disappear by default", but only inside `detail`. The same text now sits in the title as "Ran <80 chars of command>", "Read C:/full/path", "Searched <pattern> in <path>" and "Fetched host".
  - Claude's title was a bare tool name such as `Bash`. It is now a command head or a full path, so this is a new exposure.
  - Codex's title was already the full command (a pre-existing leak, now capped at 80 characters).
- **Rule broken:** the AGENTS.md "Content stays private" rule, and brief check 5 ("no ... command text in ... Remote payloads").
- **Fix:**
  1. Treat `tools[].title` as hidden by default. Return only a generic title and restore it with `includeToolOutput`, or keep the title only when it is a bare category word. Make the same change in `policy.rs` and `remoteTiers.ts`.
  2. Add shared goldens in `policy-goldens.json` (`session.get` and snapshot) with a `title` of "Ran cargo test C:/private" that is hidden by default and restored with `includeToolOutput`.
  3. Check that the Remote client does not depend on `title` being present (`RemoteApp.tsx`, `useRemote.ts`).
  4. Update the report's claim.

### F2. Companion activity layout regressed (small)

- **Where:** `ActivityDetails.tsx:140-149` and `shell.css:538`.
- **What is wrong:** `ActivitySteps` used to render `<ol class="activity-steps flat">`. It now renders `GroupedSteps` with no `flat` class. The `.activity-steps.flat { padding: 0; border: 0 }` rule is now dead. The companion list gains the left border and 10px padding meant for nested steps, plus the `h4` headings, in a small window. The `bitbots.css:392` dotted border applies too.
- **Fix:** add a `flat` prop to `GroupedSteps` that puts `flat` on the inner `ol` for the companion. Remove the dead rule if you drop the prop. The Director still needs to look at it in both looks and both themes.

### F3. Long paths lose the filename (small)

- **Where:** `short()` in `ActivityDetails.tsx:33` and the Rust `short` in `agent-core/src/lib.rs:410`.
- **What is wrong:** `short` keeps the first 80 characters, so for "Read C:\Users\...\deep\path\file.ts" the filename is cut off. The owner asked for "which file".
- **Fix:** for path targets (Read, Edit, List, and the path in "pattern in path"), keep the tail with a leading `…`. Keep the head for commands. Add a test with a path over 80 characters.

### F4. A `command` argument forces the "command" category on any tool (low)

- **Where:** `conversation.ts:156` (`activityInput(item).command`) and `agent-core/src/lib.rs:387` (`command.is_some() ||`).
- **What is wrong:** an MCP or Claude tool that happens to take a `command` argument, or one whose provider kind is another tool, is labelled "Ran <command>" and grouped under Commands.
- **Fix:** let the tool or kind decide first. Use the argument only when the kind or tool is unknown or empty. Add one test with a non-shell tool that has a `command` argument.

### F5. Codex `fileChange` shows only the first file (low)

- **Where:** `agent-core` `path` (`raw["changes"][0]["path"]`) and `storage` `put("path", ...)`.
- **What is wrong:** a multi-file `fileChange` row reads "Edited <first path>", and the title hides the other files. The Codex title stays "Edited files", but the UI prefers the path (`ActivityDetails.tsx:47`).
- **Fix:** when `changes` has more than one entry, show "Edited N files" or "<first> and N more".

### F6. Cosmetic

- `#[cfg(test)] mod tests {` now has a test placed before `use super::*;` in the Claude, ACP and Codex adapters (`claude/lib.rs:1282`, `acp/lib.rs:1366`, `codex/lib.rs:1837`). It compiles, but move the `use` to the top of each module.
- The storage `label` for an empty command line is "Ran " (`storage/lib.rs:5496`). Skip the label when the line is empty.
- `NotebookRead` (no underscore) is not in `READ_KINDS` or the Rust `is(...)` list. Add it.

## Checks

- **Tests prove it:** the report's failing-first claims hold. The mounted tests, the Rust per-provider titles, the storage extraction test (including "targets survive input clipping") and the `valid_look` test would all fail on the old code. The `sessionActions` expectation was updated to the new behaviour, which is legitimate because the grouping and labels changed on purpose. There is no weakened assertion. Missing: a test for F1.
- **Scope:** every file is in the P2 list. The extras are justified: `ActivityDetails.css`, `policy-goldens.json` and the Codex `app_server.rs` expectation. `storage/lib.rs` is touched only in `valid_look` and `tool_detail` (and tests). The `team.rs`, `main.rs` and `App.tsx` hot files are untouched.
- **Remote rows:** no new method or event, so no new `tiers.json` row is needed. This is correct. Tool events are already `drop`.
- **Logs:** no new logging. Permission classification is unchanged (`tool_activity` is presentation only).
- **Visual rules:** no sparkle or star icons. The CSS uses semantic tokens (`--text-3`, `--fs-xs` exist in `theme.css`), so both themes are covered. The `h4` styling is plain, so both looks are handled. A visual check is still owed, as the report says.
- **Windows:** paths with `\` are only displayed, not parsed. Character counting is Unicode-safe in the Rust and TypeScript `short` functions and in storage `clip_text`.
