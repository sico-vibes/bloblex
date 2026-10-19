# FIX37 G2 — sidebar logos, clipped tooltips, clipped badge shadow

> **What this is:** Report on FIX37 G2: sidebar logos, clipped tooltips and clipped badge shadow.
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: OpenCode `opencode-go/deepseek-v4.1-flash` (high), worktree `C:\fx62`.
No `git commit` was run. Work is confined to `apps/desktop/src/ui/**` styles,
the tooltip components named in the brief, and their mounted tests.

Gate results (all on this worktree):

- `npx tsc -b` — clean.
- `npx vitest run --maxWorkers=3` — **156 files, 1102 tests, all passed**.
- `npm run build` — succeeded (`tsc -b && vite build`).

## 1. Sidebar bot rows: provider logo alignment and spacing

The runtime logo sat on the text baseline inside a wrapper with an inherited
line-height (so the strut pushed it off the name's centre), and the row gap
plus the wrapper's own `margin-right` gave a ~12 px gap to the name.

- `apps/desktop/src/ui/team.css:23` — `.team-row-name` gap `6px → 5px`.
- `apps/desktop/src/ui/team.css:26` — new `.team-row-name .runtime-mark-tip`
  rule: `display: inline-flex; align-items: center; align-self: center;
  margin-right: 0; line-height: 0`. The wrapper is now exactly the mark's
  height, so `align-items: center` on the row puts the mark's centre on the
  name's line-box centre, and the logo-to-name gap is the row gap alone (5 px).

Both looks share this rule: the Bitbots look only restyles `.team-row-name
strong` font size (`bitbots.css:862`) and does not override the row gap, so the
same 5 px and the same centring apply. The change is alignment-only, so the
row with a role chip (`flex: 0 1000 auto`), a long name (the `<strong>` keeps
`overflow: hidden; text-overflow: ellipsis; min-width: 0`) and the Manager row
(its badge is on the avatar, not the name line) are unaffected in structure.

## 2. Tooltips clipped by their container

Root cause: `Tip` and `HelpTip` bubbles were `position: absolute` descendants
of their trigger, so any scrolling or `overflow: hidden` ancestor clipped them
(the Settings sheet is `overflow: hidden`, `settings.css:5`, over a
`overflow-y: auto` content area, `settings.css:17`).

New shared pieces:

- `apps/desktop/src/ui/tooltipPosition.ts` — `placeTooltip(anchor, size,
  placement, { gap, margin, viewport })`. Prefers the requested side, flips
  when that side has no room, shifts along the cross axis, and clamps to the
  viewport with an 8 px margin (`TIP_MARGIN`/`TIP_GAP`). One helper, used by
  every tooltip below.
- `apps/desktop/src/ui/useTooltip.ts` — the anchor/bubble refs, the clamped
  `point`, the open state and the hover/focus/Escape handlers, so each tooltip
  component is a few lines.
- `apps/desktop/src/ui/tooltipPortal.css` — the portalled bubble resets the
  anchored styles (`position: fixed`, `left/top: 0`, `z-index: 10000`,
  `transform: none`) and toggles opacity/visibility from `data-open`. It keeps
  each bubble's surface, border, shadow and font, and caps the width to the
  window so it cannot overflow the small companion window.

Components:

- `apps/desktop/src/ui/Tip.tsx` — bubble now portals to `document.body`,
  positioned by the helper; opens on hover and focus, closes on Escape.
- `apps/desktop/src/ui/SettingsParts.tsx:21-29` — `HelpTip` does the same. The
  bubble keeps its `id` (caller `hintId` or a generated one) and the trigger
  now carries `aria-describedby` pointing at it, so `RowCopy`'s `hintId`
  contract and `aria-describedby` references still resolve. An optional
  `bubbleClassName` preserves the companion's narrower bubble.
- `apps/desktop/src/ui/providerBrand.tsx:47-53` — `RuntimeMarkTip` reuses the
  helper (it already portalled; the hand-rolled clamp is gone).
- `apps/desktop/src/ui/providerBrand.css:45` — dropped the `translateX(-50%)`
  the old centre-point maths needed.
- `apps/desktop/src/ui/RuntimeProblemMarker.tsx:33-41` — reuses the helper.
- `apps/desktop/src/ui/SessionExecutionControls.tsx` — uses `Tip`, so it is
  covered by the `Tip` change (its `lockedReason` tooltip).
- `apps/desktop/src/ui/CompanionPanels.tsx:19` + `companion.css:461` — the
  companion settings "?" keeps its 220 px bubble width via
  `bubbleClassName="cset-help-bubble"`, since the old `.cset-title
  .help-tip-bubble` selector can no longer reach the portalled bubble.

Checked, no change needed:

- `ScanRecovery.tsx` and `CompanionTeam.tsx` use the native `title` attribute
  only. The OS draws those, so no container can clip them.
- `QuotaBar.tsx` — `ProviderFlyout` is `position: absolute` inside
  `.usage-popover`, and that popover is a grid item of `.app-shell`
  (`App.tsx:2470`) with no clipping ancestor; its own code already clamps the
  flyout to the popover and the viewport on both axes.
- `ConversationOutline.tsx` — `.conversation-outline-preview` is inside
  `.conversation-outline { overflow: visible }` (`shell.css:502`) and
  `.conversation-frame` (no overflow), so it is not clipped by a container, and
  its vertical position is already clamped inside the frame. Left as-is rather
  than reworked into a portal, which would change its drag geometry.

Tests:

- New `apps/desktop/src/ui/tooltipPortal.mounted.test.tsx` (4 tests): a `Tip`
  near the right edge renders in `document.body` and **not** inside its
  `overflow: hidden` parent, with `left + width ≤ innerWidth − 8`; a `HelpTip`
  does the same and keeps its `id`/`role`; a top tooltip flips below when there
  is no room above; focus opens and Escape closes.
- New `apps/desktop/src/ui/fix37Ui.test.ts` covers the helper's clamping/flip
  directly, plus CSS-source guards for items 1 and 3 (happy-dom has no layout,
  so these are source assertions, not visual ones).
- Updated tests that assumed the bubble lived inside the host:
  `SettingsSheet.appearance.mounted.test.tsx`,
  `BlobSettings.execution.mounted.test.tsx`,
  `BlobSettings.botPageB.mounted.test.tsx`,
  `FirstRunOnboarding.mounted.test.tsx`, `approvalModes.mounted.test.tsx`,
  `updates.mounted.test.tsx`, `SessionExecutionControls.mounted.test.tsx`.
  `testSelect.ts` gained `helpTipBubble`, `helpTipText` and `viewText` helpers
  that reach the portalled bubbles.

## 3. The side-conversation badge's shadow is clipped at the top

`SideConversationHeader`'s pill floats in `.chat-header`. `.side-header` was
`z-index: 2` while `.conversation-frame::before` — the fade that the message
list scrolls under — is `z-index: 3` (`team.css:169`/`bitbots.css:346`). The
pill's shadow fell below the 64 px header into the top of the message area,
where the fade painted over it, so the shadow read as cut off.

- `apps/desktop/src/ui/team.css:86` — `.side-header` `z-index: 2 → 4`, above the
  fade. `.chat-header` keeps `position: relative` with `z-index: auto`, so it is
  not a stacking context and the badge can rise above the frame's fade.
- `apps/desktop/src/ui/team.css:87` — `.side-header-pill` box-shadow
  `0 6px 22px #0000004d → 0 10px 24px -6px #00000059`, a downward-offset shadow
  that stays under the badge. No ancestor on the path (`.chat-header`,
  `.conversation-pane`, `.app-shell`) clips it.

The Bitbots look keeps its own hard `4px 4px 0` shadow
(`bitbots.css:162`), which is already downward; the z-index fix applies to it
too.

## What I could not check visually

- No browser run in this worktree. Item 1's centring and gap, item 2's bubble
  placement at real sizes, and item 3's shadow are verified by CSS/helper
  source and mounted tests, not by looking at the app. The companion window's
  tooltips are clamped to its own viewport and capped to `100vw − 16px`, but I
  did not render the companion.
- The Manager row, a long-name ellipsis row and a role-chip row were reasoned
  through in CSS, not seen.
