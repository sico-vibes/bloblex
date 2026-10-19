# FIX15: conversation interactions, roster interactions, density, skeletons

> **What this is:** Spec for FIX15: conversation interactions, roster interactions, density and skeletons.
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026. Owner directive: implement the UI/UX recommendations.
Read `DESIGN.md` first. Use `entityNoun`/`useEntityNoun` (`ui/vocabulary.ts`) for
"bot"/"blob". **The role chip stays on the right of a bot's name in the sidebar row;
do not move or restyle it.** Files owned by other lanes: `ui/errorCopy.ts`,
`ui/undo.ts`, `ui/ProfileMenu.tsx`, `ui/SessionExecutionControls.tsx`,
`ui/ContextWindowIndicator.tsx`, `ui/SoundVolumeSlider.tsx`, `ui/uiPrefs.ts` (the
FIX13 lane writes it; use its API: `useDensity()`, `setDensity()`, once it lands in
the main tree, otherwise code to the signatures in `docs/history/fix-13/prefs-and-polish-spec.md`).
The Director owns `ui/SettingsSheet.tsx`, `ui/QuickSwitcher.tsx`, `ui/ApprovalCard.tsx`
and `ui/approvalUi.tsx`, `ui/QuotaBar.tsx`, `ui/FirstRunOnboarding.tsx`.

## 1. Message actions (`MessageActions.tsx`)

Hover or keyboard focus on a message reveals one row of actions in one order
everywhere: Copy, Quote (puts "> text" in the composer), Retry (assistant messages
of the latest turn only), React (existing reactions). Visible to keyboard users
(`:focus-within`), 32 px targets, `aria-label`s, never shifts layout (reserve the
row). Copy shows a 1.2 s "Copied" state. Tests: order, keyboard reveal, copy.

## 2. Delegation chips expand (`TeamMessages.tsx`)

"Messaged X" and "Message from X" chips become disclosure buttons
(`aria-expanded`): expanded they show the message text (clamped to 6 lines with
"Show more") and a link "Open X's conversation" that selects that bot's latest
session. Collapsed by default; state is local. Tests: expand, link target.

## 3. Drag to organise (`TeamSidebar.tsx`, `rosterSelectors.ts`)

Pointer and keyboard reordering of bots inside a project and moving a bot to another
project. HTML5 drag-and-drop is not reliable in WebView2 for this; use pointer
events with a drop indicator line. Keyboard: focus a row, `Alt+ArrowUp/Down` moves,
`Alt+Shift+ArrowRight` opens "Move to project" menu. Reuse the existing move
RPC/selectors; if ordering is not persisted add a `sort_order` through the existing
agent update path (daemon + storage + tests) rather than a new table. Announce moves
with an `aria-live` region. Tests for selectors and the keyboard path.

## 4. Density

CSS-only consumption of `data-density` on `<html>` (set by `uiPrefs`): create
`ui/density.css` (import in `main.tsx` after `shell.css`). `compact`: sidebar row
min-height 36 px, message gap 8 px, composer padding tighter; `default`: unchanged;
`roomy`: sidebar rows 56 px, message gap 18 px. Only layout tokens; no colour.
Add a three-way segmented control to the Settings Appearance area **only as a small
exported component** `ui/DensityControl.tsx` (the Director places it); tests.

## 5. Skeletons instead of spinners

New `ui/Skeleton.tsx` (`<Skeleton lines|variant="row"|"pill" />`, a quiet shimmer
that is a still block under reduced motion) and use it for: the model list while
loading (selector menu, onboarding model step), the usage panel, the first agent
scan list. Keep the existing text status for screen readers (`aria-busy`). Tests.

## 6. Plan card checklist (`ui/approvalUi.tsx` is the Director's; do only the model)

Provide `ui/planProgress.ts`: `planSteps(planText): string[]` (numbered or bullet
lines) and `planProgress(steps, assistantMessages): number[]` marking steps as done
when the assistant's later messages or tool activity mention them (simple,
deterministic keyword overlap, 0.6 threshold, documented). Pure functions, table
tests. The Director renders it.

## Gates

`npm run typecheck`, `npm run test`; `cargo test -p bloblex-storage -p
bloblex-daemon` and clippy only if you touched Rust. Never commit. Leave the diff
and write `docs/history/fix-15/report.md` (one line per section, call sites, anything left).
