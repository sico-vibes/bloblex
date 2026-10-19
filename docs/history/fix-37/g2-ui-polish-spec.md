# FIX37 G2: sidebar logos, clipped tooltips, clipped badge shadow

> **What this is:** Spec for FIX37 G2: sidebar logos, clipped tooltips and a clipped badge shadow.
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: OpenCode `deepseek-v4.1-flash` (high), its own worktree. The owner has asked the lanes to do UI work in this wave. **Never run `git commit`.** Keep context small: grep, then read only the ranges you need. Read the section headings of `AGENTS.md`, then `DESIGN.md`. Work only in `apps/desktop/src/ui/**` styles and the tooltip components named below; do not touch `App.tsx` beyond what item 3 strictly needs. Both looks (classic and Bitbots, `:root[data-bitbots="on"]`) and both themes must stay right.

## 1. Sidebar bot rows: provider logo alignment and spacing

In the sidebar bot rows (`TeamSidebar.tsx`, `team.css`), the small provider logo before the bot name (Claude, Codex, OpenCode marks; the "runtime logos" setting) sits lower than the name's text line, and the gap between the logo and the name is too wide.

- Centre the logo on the name's line box (the same vertical centre as the name text), in both looks.
- Reduce the gap to about 4–5 px (classic) and the equivalent in the Bitbots look.
- Check the row with and without a role chip, with a long name (ellipsis), and the Manager row.

## 2. Tooltips clipped by their container

Several tooltips are cut off by the edge of the panel or dialog that contains them (seen in Settings: the "?" help next to "Reset" under the companion position, clipped at the right edge of the Settings sheet). Tooltips are rendered inside scrolling/overflow-hidden containers.

- Make every tooltip render in a layer above everything (a portal to `document.body`, `position: fixed`, a high z-index), positioned from the trigger's bounding rect, and **clamped to the viewport** with an 8 px margin (flip above/below and shift left/right as needed).
- Components to cover (grep for more): `Tip.tsx`, `HelpTip` in `SettingsParts.tsx`, `providerBrand.tsx`, `QuotaBar.tsx`, `RuntimeProblemMarker.tsx`, `ScanRecovery.tsx`, `SessionExecutionControls.tsx`, `ConversationOutline.tsx`, `CompanionTeam.tsx`. Prefer one shared positioning helper used by all of them.
- Keep the existing accessibility (`aria-describedby`, focus and hover open, Escape closes) and the existing look of each tooltip. The companion window is small: tooltips there must stay inside it.
- Update or add mounted tests: a tooltip near the right edge stays inside the viewport; it is rendered outside its overflow-hidden parent.

## 3. The side-conversation badge's shadow is clipped at the top

When a bot-to-bot (side) conversation is open, the floating badge under the header ("Coco ⇆ Blob'si | Model Identification") has a shadow that is cut off at its top edge by the header/top bar's bounds. The shadow should fall below the badge (and not be clipped): give it a downward-offset shadow and make sure no ancestor clips it (overflow, or the header's stacking context). Find it by `ArrowLeftRight` in the main window (`TeamMessages.tsx` / `App.tsx` side-chat header and its CSS).

## Verify yourself
- `cd apps/desktop && npx tsc -b && npx vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests |FAIL"` and `npm run build`.

Write `docs/history/fix-37/g2-report.md`: what changed (file:line), tests, gate results, what you could not check visually.
