# FIX39 P1 audit (Claude Sonnet 5.5)

> **What this is:** Audit of FIX39 package P1 by Claude Sonnet 5.5.
> **Status:** historical
> **Last updated:** 2026-10-18

**Verdict: PASS WITH FIXES.** All ten items (1, 2, 3, 5, 6, 7, 8, 9, 14, 15) are implemented as the owner and the decisions specify. No defect blocks the merge. The fixes below are small. F1 and F2 should be done; F3 to F5 are optional polish. Sol can take them in one pass, or the Director can merge as is and take them in a later wave.

I read the whole diff (18 modified files, 3 new tests) and the report. I did not re-run the gates: the report's results are plausible and consistent with the diff (the suite count, typecheck and build all fit a UI-only change). The Director runs the full gates after the merge, as the brief says.

## Item check

| Item | Result | Notes |
| --- | --- | --- |
| 1 Usage dialog | Done | The heading line is now `Plan usage limits` ¦ divider ¦ `Reported by each CLI account` ¦ info button (`App.tsx:2922`). The explanation moved into a `Tip`, which opens on hover and focus. The footer holds only Usage history. Tooltip z-index is 10000 against the backdrop's 40. The empty-quota copy is shorter. |
| 2 Effort picker | Done | Only the `session-effort-default-label` span was removed (`SessionExecutionControls.tsx:327`). `defaultThinking` and `labelizeEffort` are still used at lines 184, 189 and 317, so there is no dead code. The "Model default · …" label on the trigger when no explicit value is set is deliberately kept. |
| 3 One search | Done | Header icon and `search` state are gone. `TeamSidebar` has a native button that opens the existing QuickSwitcher, with a visible `Ctrl K` hint and `aria-keyshortcuts`. The dead query branches were removed. All three other tests that clicked the old icon were updated. |
| 5 Update banner | Done | `primary-button small` and `ghost-button small`. The undefined `pill-button` has no remaining users. |
| 6 Launch checklist | Done, as the audit adjusted | Fixed `min(320px, 100%)` block, centred. Rows are `justify-content: start` with a `minmax(0, 1fr)` second column. `small` is a grid item inside `.launch-check-copy`, so its ellipsis does work. |
| 7 Manager card | Done | The card shows whenever connected and there is no Manager, with or without bots or runtimes. There is no dismissal and no X, and `managerSetupDismissed` has no remaining users. The setup and Create controls are disabled with a note when no runtime is usable. The runtime selection derives a valid fallback. I checked the flicker risk: `setSnapshot` runs before `setConnection('connected')` (`App.tsx:836-838`, `1086-1088`), so an existing Manager cannot flash the card. |
| 8 Manager badge | Done | `Star size=10 fill="currentColor" strokeWidth=0` on the existing orange circle with `color: #fff` (`team.css:22`). The Bitbots-look override keeps the circle. `BriefcaseBusiness` stays elsewhere. No other star or sparkle is added. |
| 9 Settings dividers | Done | `.settings-group ~ .settings-group` with `--line` and 20 px padding (`settings.css:27`). This avoids a line under the page title. The wizard's `:first-child` margin reset (`botWizard.css:25`) is compatible. |
| 14 Usage N/A | Done | `Unknown` becomes `N/A`. Recorded zero stays `0`. An all-N/A period shows one "No usage yet today / this month." line. Loading and unavailable states are separate. The companion glance is untouched, as decided. |
| 15 Sidebar preview | Done | Every notice is skipped except `delegation` and `blob_created` (`teamSelectors.ts:46-49`). `blob_reply` is a `user`-role message in the fixtures and the existing test, so moving its check after the notice skip does not change real replies. The companion list shares the helper. |

## Scope, security and visual rules

- **Scope:** the production files are all in the package's list. The extra test files are justified: `SessionExecutionControls.mounted.test.tsx` holds the required Max regression, `TeamSidebar.keyboard.mounted.test.tsx` has the one prop change, and `ShellPolish.mounted.test.tsx` covers the CSS. The hot files `App.tsx` (18 lines) and `TeamSidebar.tsx` (23 lines) were touched minimally. `export function UsageSheet` is a test seam only.
- **Security:** no Rust, no `tiers.json`, no new RPC and no new event. Nothing new is logged or sent through Remote. Usage text and notices stay local to the UI. No approval path was touched.
- **Visual:** the only star is the Manager badge. There is no sparkle or wand. The CSS changes are token-based (`--line`, `--text-*`, `--surface-*`) and the badge has a Bitbots override. The CSS test runs all four theme and look combinations.

## Tests

The new behaviour tests would fail on the old code: the update banner classes, the effort popover at Max, the search button opening the switcher (focus lands in the input, then Escape and Ctrl+K), the Manager card with zero or existing bots after a stored Later, no close control, no-runtime recovery, empty and partial usage, the preview skipping notices, and the focus-open tooltip. `ShellPolish` asserts computed CSS rules in happy-dom, not geometry. The report says this itself, and the Director's screenshots must cover it. Weak spots are listed under F4.

## Findings

**F1 (should fix). The info button does not expose its explanation to assistive technology.**
`App.tsx:2922`: `Tip` renders the bubble with `role="tooltip"` and a generated `id` (`Tip.tsx:20`) but never links the trigger to it. The button only has `aria-label="About plan usage limits"`, so a screen-reader user cannot read the sentence that replaced the footer text. Without editing `Tip.tsx` (outside P1), add `aria-describedby` support in a way that does not change other `Tip` users. For example, give the button `aria-label="About plan usage limits: <the same sentence>"` from a shared const, or add an optional `describe` flag to `Tip` that clones the child with `aria-describedby={id}` and mention that in the report. Add one assertion in `UsageSheet.mounted.test.tsx` that the button's accessible name or description contains "account quota".

**F2 (should fix). The search button keeps a focus ring after a mouse click.**
`shell.css:19`: `.sidebar-search:focus-within` also matches a focused button itself, so after clicking Search and closing the switcher (which restores focus to the button), the ring stays until blur. The old input needed `:focus-within`; the button does not. Change it to `.sidebar-search:focus-visible`. Check the Bitbots rule at `bitbots.css:295` for a conflicting border on focus.

**F3 (optional). Long launch-row labels are not clipped.**
`shell.css:440`: only `small` has an ellipsis. In the fixed 320 px block, a long `strong` label (a long provider or custom runtime name) would overflow. Add `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap` to `.launch-checklist strong`.

**F4 (optional). Test hygiene.**
- `App.agent.mounted.test.tsx:857-864`: `sessionStorage.removeItem` runs at the end of the test, so a failed assertion leaves the stored Later value for later tests. Move the cleanup into `afterEach` (as `ManagerSetupCard.mounted.test.tsx` does with `sessionStorage.clear()`).
- `App.agent.mounted.test.tsx:786`: the badge test selects `svg.lucide-star`, which ties the test to the icon library's class name. `.leader-badge svg[fill="currentColor"]` states the behaviour (a filled glyph) without that dependency.
- `ShellPolish.mounted.test.tsx` uses synthetic markup, not the real `SettingsSheet` or `LaunchIntro` markup. It will not catch a real page wrapping groups so that they are no longer siblings. The Director's screenshots cover this; no code change is needed, but do not read the green test as proof of the layout.

**F5 (optional). Leftover parameter.**
`TeamSidebar.tsx` now calls `groupAgentsByProject(agents, projects, '', showHidden)`. The query argument is dead for this caller. Drop it only if `groupAgentsByProject` has no other users; otherwise leave it.

## For the Director

- The report says `apps/desktop/node_modules` in this worktree was swapped from a junction to a local directory, and `.cache/` was deleted. Neither shows in `git status` (ignored). Before cleanup, remove the local `apps/desktop/node_modules` as a directory in this worktree only. Never recurse through any junction into the main checkout, per AGENTS.md.
- Visual checks still owed (not claimed by anyone): the usage heading and tooltip in the preview, the update banner, launch checklist alignment, the Manager star at 10 px, and settings and wizard dividers, in classic and Bitbots looks, light and dark.
