# FIX15 report: conversation interactions, roster interactions, density, skeletons

Implemented 15 October 2026 in worktree `C:\fx32c`. Spec: `docs/FIX15_CONVERSATION_SPEC.md`.
No commit. Gates: `npm run typecheck` clean; `npm run test` 101 files / 635 tests pass.
Rust untouched (`git diff --name-only -- '*.rs'` empty), so the cargo/clippy gates were not run.

## 1. Message actions (`ui/MessageActions.tsx`) — done

One toolbar in one order — **Copy, Quote, Retry, React** — with `aria-label`s, a 32 px
target, a reserved 32 px retry slot (`onRetry` absent renders `.message-action-slot`, so
the row never shifts), and the 1.2 s "Copied" state (was 1.5 s).

- Call sites: `ui/MessageActions.tsx` (component, exports unchanged except `onRetry`);
  `ui/App.tsx` `MessageActions` call site (~line 2126) passes `onRetry` for assistant
  messages after the last user message (`lastUserIndex` now computed over
  `groupedConversationItems`, the array actually mapped — computing it over
  `conversationItems` misaligned indices and offered no Retry); new `retryLatestTurn`
  re-sends the latest user prompt via `session.prompt`; `ui/experiments.css`
  (`.message-action-button` 26→32 px, new `.message-action-slot`, mobile shrink removed,
  existing `:focus-within` reveal kept).
- Tests: `MessageActions.mounted.test.tsx` (order, reserved slot, keyboard reveal via the
  CSS rule, exact-text copy), `MessageActions.badge.mounted.test.tsx` (1.2 s),
  `App.agent.mounted.test.tsx` ("offers Retry on the latest turn only…", quote label).

## 2. Delegation chips expand (`ui/TeamMessages.tsx`) — done

`DelegationChip`/`ReplyChip` are now disclosure buttons (`aria-expanded`/`aria-controls`)
over a shared `TeamChatChip`: collapsed by default, local state, expanded shows the
message clamped to six lines with a **Show more/Show less** toggle (`chipNeedsShowMore`,
>6 line breaks or >240 chars) and a link **"Open X's conversation"** that selects that
bot's latest session.

- Call sites: `ui/TeamMessages.tsx`; `ui/App.tsx` `teamItem` (passes the notice text and a
  new `openBlobConversation(agentId)` that calls `selectAgent`); `ui/team.css`
  (`.team-chip-block`, `.team-chip-panel`, `.team-chip-text.clamped`, `.team-chip-more`,
  `.team-chip-link`, `.team-chip-caret`).
- Tests: `TeamMessages.chips.mounted.test.tsx` (expand/collapse, Show more, link target,
  disabled disclosure with no text). Two App tests that used the chip to open the side
  conversation now use the header's "Side conversations" menu: `App.agent.mounted.test.tsx`,
  `App.companion.mounted.test.tsx`.

## 3. Drag to organise (`ui/TeamSidebar.tsx`, `ui/rosterSelectors.ts`) — done

Pointer reordering with a drop indicator line, keyboard moves, and cross-project moves.
Ordering is **already persisted**: the daemon has `agent.reorder` (`crates/bloblex-daemon`
dispatch) and storage `agent_reorder`/`sort_order` with tests, so no daemon or storage
change and no new table was needed — the frontend simply calls the existing RPC.

- Selectors (`ui/rosterSelectors.ts`): `runtimeRosterIds`, `projectMemberIds`, `moveWithin`,
  `reorderAgentInProject` (one step inside a project), `placeAgentOrder` (before/after a
  target of the same runtime, covers cross-project). All return the full runtime id order
  for `agent.reorder`.
- Sidebar (`ui/TeamSidebar.tsx`): HTML5 drag removed; pointer capture drag with a 5 px
  threshold, `hintFromPoint` row-edge/project detection, `.drop-before`/`.drop-after`
  indicator lines (styles already in `shell.css`) and `.team-row.dragging` (`team.css`);
  keyboard `Alt+ArrowUp/Down` → `onReorder`, `Alt+Shift+ArrowRight` → new **Move to project**
  menu; an `aria-live` status region announces each move.
- App (`ui/App.tsx`): `reorderRoster` (`agent.reorder`), `reorderAgent`, `placeAgent`
  (`agent.team.update` `projectId` then `agent.reorder`), wired as `onReorder`/`onPlace`;
  `rosterAnnouncement` reused.
- Tests: `rosterSelectors.test.ts` (roster reordering selectors), `TeamSidebar.keyboard.mounted.test.tsx`
  (Alt+Arrow move, Move-to-project menu, plain Arrow stays on the focus path).

## 4. Density — done

CSS-only `ui/density.css` reading `data-density` on `<html>` (set by `uiPrefs`), imported in
`ui/main.tsx` right after `shell.css`. `compact`: sidebar rows 36 px, message gap 8 px,
tighter composer padding; `default`: untouched; `roomy`: rows 56 px, message gap 18 px.
Layout only; no contrast/colour changes to the density rules. New exported
`ui/DensityControl.tsx` (three-way segmented control over `useDensity`/`setDensity`) is
**not** placed anywhere — the Director places it.

- Note: the shipped default row is `.bot-row` 56 px / `.team-row` 58 px, so the spec's
  `roomy` 56 px matches the default height; `roomy` still grows the message gap (18 px) and
  group spacing. The segmented control's own appearance uses the standard control tokens
  (`--surface-raised`, `--text-*`), not layout properties.
- Tests: `DensityControl.mounted.test.tsx` (options, marks current, writes uiPrefs/html/daemon).

## 5. Skeletons instead of spinners — done

New `ui/Skeleton.tsx` (`lines`, `variant="text" | "row" | "pill"`) with `ui/skeleton.css`
(quiet opacity shimmer, still block under `prefers-reduced-motion`), imported in `main.tsx`.
Used for the model list while loading (a skeleton pill in `ui/SessionExecutionControls.tsx`
while the catalog is null and not unavailable; skeleton rows in the onboarding model step),
the usage panel (token summary in `App.tsx` `UsageSheet`), and the first agent scan list
(`ui/FirstRunOnboarding.tsx`). Existing text status is kept for screen readers via
`aria-busy` + `sr-only` text.

- Tests: `Skeleton.mounted.test.tsx`; `FirstRunOnboarding.mounted.test.tsx` (scan skeleton).

## 6. Plan card checklist model (`ui/planProgress.ts`) — done

`planSteps(planText)` returns numbered/bulleted list lines with the marker stripped;
`planProgress(steps, assistantMessages)` returns an index-aligned `0`/`1` array, a step
done when one later assistant message (tool activity included in its text) shares at least
`PLAN_STEP_MATCH_THRESHOLD = 0.6` of the step's content words (stopwords dropped,
deterministic). Pure; the Director renders it.

- Tests: `planProgress.test.ts` (table-driven).

## Left / flagged for the Director

- `ui/SessionExecutionControls.tsx` is listed as another lane's file; I made one additive
  change (the loading skeleton pill). If that lane is mid-edit, take mine or theirs, not both.
- Chips no longer open the side conversation directly; the header "Side conversations" menu
  is the remaining route. Flag if the chip link should also open the side view.
- `roomy` row height equals the current default (see §4); say the word if you want a taller
  roomy row instead of the spec's 56 px.
- Rust gates not run because no Rust file changed.
