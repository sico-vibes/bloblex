# FIX37 G3: the app jumps between bots by itself after a delete or archive

Lane: OpenCode `deepseek-v4.1-flash` (high), its own worktree. The owner has asked the lanes to do UI work in this wave. **Never run `git commit`.** Keep context small. Read the section headings of `AGENTS.md` first. Work in `apps/desktop/src/ui/App.tsx` (selection logic), its tests, and only what the fix needs.

## The bug

After **deleting a conversation** or **archiving a bot**, the main window sometimes "goes crazy": the selection keeps bouncing between different bots and conversations by itself, and unread dots appear next to the times of rows the user never left unread.

## Likely causes to check (find the real one; do not guess-fix)

In `App.tsx` several effects and listeners set the selection; any two that disagree can ping-pong:
- `listenForActiveSession` (the active session shared with the **companion window** and the tray; the companion also publishes it) and the effect that calls `setActiveSession(selectedSession.id)` when they differ. A deleted or archived session id can be published by one window after the other has moved on.
- The "pull focus once per approval" effect (`focusedPermission`), when the permission's session or owner was just deleted or archived.
- The auto-create effect (`autoCreatedFor`, `ensureConversation`) that opens a conversation for a bot without one, and the "a conversation left empty is not kept" effect (`session.delete.schedule` and local removal). Deleting the last conversation of a bot can make it auto-create a new one, which may be removed as empty when the selection moves, and so on.
- `listenForActiveRuntime` choosing `agentsForRuntime(...)[0]` when the runtime changes.
- Unread marking: rows marked unread when a session update arrives for a session that is not the selected one; the bouncing makes every visited session "not selected" at some point.

## Fix
- After a delete or archive, choose the next selection **once**, deterministically (the same bot's next conversation, else the next visible bot), and make every other effect leave it alone: no effect may select an archived or deleted session or agent, and the active-session listener must ignore ids that are not in the current snapshot (or are archived) instead of selecting them.
- Prevent publish loops between the main window and the companion: a window must not re-publish an active session it just received, and must not publish a session that no longer exists.
- The auto-create/empty-removal pair must not chain (an auto-created empty conversation is not removed while it is still the selected one, and a bot whose conversation was just deleted is not auto-given a new one unless the user selects it).
- Unread dots: a session becomes unread only on a new assistant message or a turn ending while it is not on screen, never because selection moved.

## Tests (mounted, `App.*.mounted.test.tsx`)
Reproduce first, then fix: deleting the selected conversation selects one target and stays there across several settles; archiving the selected bot selects one other bot and stays; an active-session event naming a deleted or archived session is ignored; no row gains an unread dot from these actions. Keep all existing tests green.

## Verify yourself
- `cd apps/desktop && npx tsc -b && npx vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests |FAIL"`

Write `docs/FIX37_G3_REPORT.md`: the actual cause you found (with file:line), the fix, the tests, and what is unverified.
