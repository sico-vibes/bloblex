# FIX39 P1 implementation report

> **What this is:** Implementation report for FIX39 package P1 (usage dialog, effort picker, search, update banner and more).
> **Status:** historical
> **Last updated:** 2026-10-18

Package P1 implements items 1, 2, 3, 5, 6, 7, 8, 9, 14 and 15, following `docs/history/fix-39/decisions.md` and the research audit. No Rust or Remote application source changed. No commit was made, no installed Bitbots instance or data was accessed, and no pre-existing process was stopped.

> **Handoff note.** GPT Sol 6.1 wrote all P1 code and tests below but exhausted its run before running any gate. The second implementer took over in the same worktree, made no source change, reviewed the diff against the audit and the brief, and ran and recorded the gates. The only working-tree changes it made were removing the stray untracked `.cache/` build directory and completing this report. `docs/history/fix-39/p1-audit.md` does not exist.

## Changes and evidence

All abbreviated `ui/` paths below are under `apps/desktop/src/`.

| Item | Change | Evidence and tests |
| --- | --- | --- |
| 1: usage dialog | Inline heading, vertical divider, account note and labelled Info button. The explanation now lives in a focus/hover tooltip; the footer contains only Usage history. The quota-source empty copy is shorter. | `ui/App.tsx:2922`, `:2937`, `:2954`; inline layout in `ui/styles.css:76`. `ui/UsageSheet.mounted.test.tsx:18` checks the heading, divider, note, labelled button, focus-open portal tooltip and footer. Existing portal z-index is 10000 (`ui/tooltipPortal.css:14`), above the backdrop's 40; the shell CSS test also checks stacking in both themes and looks. |
| 2: effort picker | Removed only the extra model-default span from the effort popover heading. Existing default/recovery behavior is retained. | `ui/SessionExecutionControls.tsx:327`. `ui/SessionExecutionControls.mounted.test.tsx:56` opens Codex at Max and asserts that no Model default text appears. |
| 3: one search control | Removed the header icon and App roster-search state. Sidebar search is a native button opening the existing QuickSwitcher, with a visible Ctrl K hint and shortcut metadata. Removed query props and query-dependent Manager/group branches. | `ui/App.tsx:2381`, `:2398`; `ui/TeamSidebar.tsx:102`, `:299`; `ui/shell.css:18`. `ui/App.agent.mounted.test.tsx:834` checks the removed icon, click-to-open, focused search input, bot search, unchanged roster, Escape and Ctrl+K. Updated three additional tests that clicked the removed icon. Existing QuickSwitcher keyboard and shortcut suites exercise keyboard navigation, selection and focus restoration. |
| 5: update banner | View uses `primary-button small`; Later uses `ghost-button small`. | `ui/UpdateBanner.tsx:23`. Class assertions added to `ui/updates.mounted.test.tsx:333`; existing tests retain dismissal/version behavior coverage. |
| 6: launch checklist | Centred block with stable `min(320px, 100%)` width; all rows start at the same grid column and use a flexible second column. Long detail text truncates with ellipsis. | `ui/shell.css:421`, `:424`, `:441`. Existing `ui/LaunchIntro.mounted.test.tsx:26` checks checklist rows/structure. `ui/ShellPolish.mounted.test.tsx:44` checks authored width plus computed margins, row alignment, grid columns and truncation in all four theme/look combinations. Pixel alignment still needs the Director's preview. |
| 7: persistent Manager setup | App shows the card whenever connected without a Manager, including zero bots. Removed sessionStorage dismissal and the close control. With no usable runtime, the card stays visible with a note and disabled setup/creation. Runtime selection derives a valid fallback when discovery changes. Parent Manager state removes the card after successful creation. Onboarding logic was not changed. | `ui/App.tsx:2398`; `ui/ManagerSetupCard.tsx:19`, `:30`. `ui/App.agent.mounted.test.tsx:856` tests zero/existing bots with an earlier Later preference. `ui/ManagerSetupCard.mounted.test.tsx:23`, `:30` tests no dismissal, no runtimes, disabled controls, discovery recovery and valid creation parameters. |
| 8: Manager badge | Filled 10 px white Star in the existing orange badge. A Bitbots override preserves its circular shape over the global square reset. | `ui/TeamSidebar.tsx:285`; `ui/bitbots.css:296`. `ui/App.agent.mounted.test.tsx:786` checks the filled star on the Manager and the surrounding test excludes the former leader's badge. Shell CSS tests check the circle in both looks/themes. Source search finds no sparkle/wand icons and no other Star use in UI source. |
| 9: settings dividers | Added a token-based top border and padding only to subsequent sibling groups. A title/search before the first group cannot create an unwanted first divider. | `ui/settings.css:27`. `ui/ShellPolish.mounted.test.tsx` checks first/subsequent groups with a preceding title and in a wizard container, under all four theme/look combinations. Appearance still needs the Director's screenshots. |
| 14: empty usage | Absent/non-finite token values display N/A; recorded zero stays 0. An entirely empty period shows one No usage yet today/this month line. Loading and unavailable-summary states remain distinct. | `ui/usagePresentation.ts:4`; `ui/App.tsx:2943`, `:2951`. `ui/usagePresentation.test.ts:5`, `:15` cover buckets; `ui/UsageSheet.mounted.test.tsx:33`, `:39`, `:45` cover empty periods, partial/zero data and loading/unavailable states. Companion glance was not changed. |
| 15: sidebar previews | Skip every notice except the explicit delegation/created-bot previews. Real blob replies keep their existing preview. Shared helper also serves the companion list. | `ui/teamSelectors.ts:46`. `ui/teamSelectors.test.ts:51`, `:59` cover delegation, creation, replies, trailing context/model/bypass/future notices, notice-only conversations and notices without metadata. |

## Regression method

Behavioral regression tests were run before the corresponding fixes. They failed on the old extra effort label, duplicate search icon, unfilled Manager badge, dismissed/absent Manager card, unstyled update buttons, Unknown buckets, empty-period grid, missing usage divider and system-notice preview. The corrected parameterized zero/existing-bot Manager cases were rerun against the old behavior and both failed. A further red test demonstrated that setup was still enabled without a runtime before its disabled-state fix.

`UsageSheet` was exported as a focused mounted-test seam before changing its behavior. The stylesheet suite was also run against HEAD's baseline `shell.css`, `settings.css` and `bitbots.css`: 10 cases failed and 2 passed. Final styles were restored in a `finally` block; all 12 cases then passed. CSS tests check computed rules and DOM structure, not actual screen geometry or visual quality. Because happy-dom does not compute CSS `min()`, that one width assertion checks the authored declaration.

## Gates

Run in this worktree (`C:\fx81`, branch `lane/fix39-p1`), foreground, on 18 October 2026 by the second implementer after taking over. P1 changes no Rust and no Remote application source, so the Rust gates and `build:remote` were not required by the brief.

| Gate | Command | Result |
| --- | --- | --- |
| UI typecheck | `cd apps/desktop && npx tsc -b --pretty false` | Exit 0, no output. |
| UI tests | `cd apps/desktop && npx vitest run --maxWorkers=3` | Exit 0; **167 test files passed (167)**, **1181 tests passed (1181)**, 0 failed. |
| UI build | `cd apps/desktop && npm run build` | Exit 0; `tsc -b` plus `vite build`, `✓ built in 37.27s`. The only warning is the pre-existing "chunks are larger than 500 kB" notice. |

The full suite includes every P1 change: `UsageSheet.mounted.test.tsx`, `ManagerSetupCard.mounted.test.tsx`, `ShellPolish.mounted.test.tsx`, `updates.mounted.test.tsx`, `usagePresentation.test.ts`, `teamSelectors.test.ts`, `SessionExecutionControls.mounted.test.tsx` (Max has no "Model default") and `App.agent.mounted.test.tsx` (removed header icon, sidebar search button opens the quick switcher with Ctrl+K, star badge, persistent Manager card). Every item was re-checked against the audit's "Done" list and none is missing; no fix was needed.

The Rust gates were not run: `git status` shows no change under `crates/` or `apps/desktop/src-tauri/`, which P1 does not list.

### Gate environment

The previous implementer replaced `apps/desktop/node_modules` (a junction into the main checkout's `node_modules`, used only for caches) with a local directory containing only Vite's `.vite` cache, so a build in this worktree cannot write through the junction into the main checkout. Dependencies still resolve from the worktree root `node_modules`. Tests and build resolved all dependencies; nothing outside this worktree was written. This is the "restoration/cleanup" item noted under Scope.

## Scope and limitations

- Outside P1's explicit test-file list: `ui/SessionExecutionControls.mounted.test.tsx` adds the required Max regression; `ui/TeamSidebar.keyboard.mounted.test.tsx` changes its single caller to the new `onOpenSearch` prop; new `ui/ShellPolish.mounted.test.tsx` verifies the required CSS behavior in the four combinations. No other production file outside the package list was changed.
- Worktree-only gate setup uses local npm/Vite caches. The app's original node_modules junction contained caches only; it was temporarily replaced by a local directory so nested build commands cannot write through it into the main checkout. Dependencies still resolve from the existing root dependency link. Restoration/cleanup will be recorded with the final gate results.
- Required Director visual checks remain: usage heading/tooltip, update banner, launch alignment, Manager badge and settings/wizard dividers, in classic/Bitbots and dark/light. No browser/native-window screenshots or live-provider behavior are claimed.
- Sonnet's independent diff audit remains for the Director's pipeline. No release or merge was attempted.

## Follow-up (audit)

A third implementer took over the same worktree (`C:\fx81`, branch `lane/fix39-p1`) to apply the five findings in `docs/history/fix-39/p1-audit.md`. It changed no existing behaviour beyond the findings, kept all earlier P1 work, and did not commit. No Rust or `src-tauri` file changed, so only the UI gates were rerun.

| Finding | Change | Evidence and tests |
| --- | --- | --- |
| F1 info button not described | Added an optional `describe` prop to `Tip`: when set, it clones its trigger with `aria-describedby={id}` pointing at the bubble it already renders. Other `Tip` users are unchanged (default off). The usage info button now passes `describe`. | `ui/Tip.tsx:20`, `:23`; `ui/App.tsx:2922`. `ui/UsageSheet.mounted.test.tsx:27` follows the button's `aria-describedby` to the portal bubble and asserts it contains `account quota`. |
| F2 search button keeps a mouse-click ring | `.sidebar-search:focus-within` becomes `.sidebar-search:focus-visible`, so the ring follows keyboard focus; the old rule matched the clicked button itself and stayed until blur. The Bitbots rule (`bitbots.css:295`) only sets a border and does not conflict. | `ui/shell.css:19`. `ui/ShellPolish.mounted.test.tsx:59` asserts the authored `:focus-visible` rule with `box-shadow` and that no `:focus-within` rule remains, in all four theme/look combinations. |
| F3 long launch labels not clipped | Added `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap` to `.launch-checklist strong`. | `ui/shell.css:440`. `ui/ShellPolish.mounted.test.tsx:56` checks the `strong` ellipsis alongside the existing `small` check. |
| F4 test hygiene | `App.agent.mounted.test.tsx` now clears `sessionStorage` in `afterEach` instead of at the end of the Manager test, so a failed assertion cannot leak the stored Later value. The badge test selects `.leader-badge svg[fill="currentColor"]` instead of the icon library's `svg.lucide-star` class. The `ShellPolish` synthetic-markup caveat needs no code change; it stays a stylesheet check, not proof of the real layout. | `ui/App.agent.mounted.test.tsx:248`, `:787`. |
| F5 leftover parameter | Dropped the dead `query` parameter from `groupAgentsByProject` (no production caller filtered by it after item 3) and updated `TeamSidebar`'s call and the selector test. | `ui/teamSelectors.ts:90`; `ui/TeamSidebar.tsx:134`; `ui/teamSelectors.test.ts:46`. |

### Follow-up gates

Run in the same worktree, foreground, 18 October 2026.

| Gate | Command | Result |
| --- | --- | --- |
| UI typecheck | `cd apps/desktop && npx tsc -b --pretty false` | Exit 0, no output. |
| UI tests | `cd apps/desktop && npx vitest run --maxWorkers=3` | Exit 0; **167 test files passed (167)**, **1185 tests passed (1185)**, 0 failed (4 more than the pre-audit run: the new F2 check runs in each of the four theme/look combinations). |
| UI build | `cd apps/desktop && npm run build` | Exit 0; `tsc -b` plus `vite build`, `✓ built in 9.28s`. Only the pre-existing 500 kB chunk-size warning. |

Before the fixes, the new F1 and F2 assertions were run against the old code and failed as intended: `aria-describedby` was null (`expected null to be truthy`) and the stylesheet had `:focus-within` with no `:focus-visible`. The two source files were temporarily reverted for that check and then restored.

### Follow-up scope

- `ui/Tip.tsx` is outside P1's original file list. It was changed because the audit's preferred fix (a `describe` flag on `Tip`) lives there, and it is the smallest change that adds `aria-describedby` without altering any other `Tip` user. The audit brief names this file as acceptable.
- F4's third bullet (the `ShellPolish` markup caveat) is documentation only; the Director's screenshots remain the proof for layout.
- Still not claimed: any browser or native-window screenshot, live-provider behaviour, or the Director's visual checks (usage heading/tooltip, update banner, launch alignment, Manager star, settings and wizard dividers).
