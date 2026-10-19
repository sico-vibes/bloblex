# FIX38 H3: broken branch lines in the Conversations column (classic look)

> **What this is:** Spec for FIX38 H3: broken branch lines in the Conversations column (classic look).
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: OpenCode `deepseek-v4.1-flash` (high), its own worktree. All code in this wave is yours. **Never run `git commit`.** Keep context small. Read `DESIGN.md` first.

## Bug
In the Conversations column, a bot-to-bot (side) conversation hangs under its parent with explorer-style tree lines (FIX34). In the **classic (primary) look** the line from the parent to the child is broken: the vertical guide and the elbow don't meet (gaps, a dashed-looking vertical, the elbow sitting apart from the child row's avatars). In the **Bitbots look** it looks right. Use the Bitbots look's geometry as the reference.

Files: `apps/desktop/src/ui/conversationsPanel.css` (`.convo-children` and the guide/elbow rules), `ConversationsPanel.tsx`; check `bitbots.css` for the Bitbots overrides that make it work there.

## Fix
- One continuous vertical guide from the parent row down to the last child's elbow, and an elbow that meets the child row's first visual element, at every depth, in both looks and both themes. Rows with different heights (a two-line child) must still connect.
- Respect hover/selected row backgrounds (the line stays visible and unbroken over them).
- Add a CSS-source test or a mounted geometry test if one is practical in happy-dom (it has no layout; prefer asserting the rules exist and use the same variables as the Bitbots look).

## Gates
- `cd apps/desktop && npx tsc -b && npx vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests |FAIL"` and `npm run build`

Write `docs/history/fix-38/h3-report.md`: what was wrong, the fix (file:line), and that the Director should check it in the browser preview.
