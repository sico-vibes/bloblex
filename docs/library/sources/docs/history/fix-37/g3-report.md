# FIX37 G3 — selection after a delete or archive

> **What this is:** Report on FIX37 G3: selection after a delete or archive.
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: OpenCode `deepseek-v4.1-flash` (high), worktree `C:\fx63`. No commit was run.

## Symptom

After deleting a conversation or archiving a bot the main window "went crazy": the
selection bounced between bots and conversations on its own, and unread dots appeared
on rows the person had never left unread.

## What actually caused it

Two effects disagreed about what should be selected, and a deleted id was treated as a
valid choice.

1. **The active-session listener adopted ids that no longer existed.**
   `apps/desktop/src/ui/App.tsx:1118` (old) did
   `if (!session) { setSelectedSessionId(sessionId); return }`, and before that it set
   `activeSessionId` unconditionally. The companion window and the tray publish the
   active session; after this window deleted or archived the conversation it had already
   moved on, but the stale id arrived and was adopted. The derived `selectedSession`
   then fell back to another conversation (`App.tsx:529-535`), the publish effect below
   announced that fallback, the companion echoed a different fallback back, and the two
   windows ping-ponged.

2. **The publish effect re-announced whatever the derived selection was**, with no check
   that the conversation still existed or that its blob was archived (`App.tsx:1157`
   old). That is the other half of the loop: a window re-published a session it had just
   received, and published sessions of archived bots.

3. **Deleting the last conversation of a bot immediately auto-created a new one.**
   `scheduleConversationDelete` set `selectedSessionId` to `null` (`App.tsx:2092` old);
   the derived selection became `null`; the auto-create effect (`App.tsx:1172` old) ran
   `ensureConversation`, and the empty-removal effect (`App.tsx:1195` old) cleared
   `autoCreatedFor` when it deleted an empty conversation, so the pair could chain. The
   fresh empty conversation was also unread on arrival — that is where the "unread dots
   the person never earned" came from.

4. **The seen marker was pruned whenever a conversation left the list** (`App.tsx:583`
   old, keyed on `sessions`). A conversation archived by a delete, or restored by Undo,
   lost its read marker and popped a dot for the timestamp it gained while away.

The archive-bot path (`nextAgentAfterArchive`, `App.tsx:1229`) already chose one target;
the bounce came from the listener and the publish effect re-selecting around it.

## The fix

All in `apps/desktop/src/ui/App.tsx`.

- **One deterministic choice after a removal.** New helper
  `nextSelectionAfterRemoval` (`App.tsx:2794`): the same blob's next conversation, else
  the next visible blob's, else the first visible blob. A new reconcile effect
  (`App.tsx:1243`) runs when the selected id is no longer in the snapshot and applies
  that choice once. `scheduleConversationDelete` (`App.tsx:2116`) and
  `archiveConversation` (`App.tsx:1597`) no longer move the selection themselves, so
  only this effect decides.
- **The listener ignores ids it cannot show.** `App.tsx:1131-1161`: an id that is not in
  the current snapshot, is archived, or belongs to an archived blob is dropped instead
  of selected. A valid conversation also selects its blob, so the window converges on
  the published session rather than deriving a different one.
- **No re-publishing.** The publish effect (`App.tsx:1177-1188`) refuses to announce a
  conversation that is archived or whose blob is archived, so a window never echoes back
  an id it just received or a session that no longer exists.
- **No auto-create/empty-removal chain.** `suppressedAutoCreate`
  (`App.tsx:400`) marks a blob whose conversation was just deleted or archived; the
  auto-create effect skips it (`App.tsx:1200`) and also waits while the selection is
  mid-reconcile (`App.tsx:1202`). The empty-removal effect records the mark instead of
  clearing `autoCreatedFor` (`App.tsx:1222-1226`). A deliberate choice — `selectAgent`,
  `selectConversation`, `selectSession`, `createConversation` — clears the mark.
- **Unread only when it should be.** The prune now forgets a read marker only for
  permanently deleted ids (`App.tsx:586-597`), and a conversation that reappears (Undo,
  or an archive reverted elsewhere) keeps the read marker it already had
  (`App.tsx:600-618`). Selection moving never creates a dot.
- **Approvals do not pull focus to a deleted or archived conversation.** The
  `focusedPermission` effect (`App.tsx:897-905`) now bails out on an archived session or
  an archived owner.

## Tests

`apps/desktop/src/ui/App.selection.mounted.test.tsx` (new, mounted, happy-dom), written
first and failing against the old code:

- deleting the selected conversation picks the next bot once and stays there across
  several settles, with no `agent.conversation` call and no re-announced deleted id;
- archiving the selected bot picks one other bot once and stays;
- an active-session event naming a deleted session is ignored;
- an active-session event naming a conversation of an archived bot is ignored;
- no row gains an unread dot from deleting a conversation, or from archiving a bot;
- restoring a conversation settles instead of looping, and does not gain a dot;
- a window does not re-publish an active session it just received.

Existing tests stay green.

## Verify

`cd apps/desktop && npx tsc -b && npx vitest run --maxWorkers=3`
→ **155 test files, 1099 tests, all passing.**

## Unverified

- Not exercised against the real companion window and tray on a live daemon; the
  cross-window loop is covered with two mounted windows and a mocked native bridge, not
  with the real Tauri event channel.
- The dot rule is still timestamp-based (`isUnread`). A state-only `session.changed`
  (for example a warm/start transition, not a new assistant message or a turn ending)
  still advances `updatedAt` and can show a dot on a conversation that is off screen.
  The reported case is fixed because the bounce no longer warms conversations the person
  did not choose, but the broader rule in the brief is not fully enforced by data.
- The Undo window (eight seconds) was simulated with `session.changed` events, not by
  driving the real `session.delete.schedule` / `session.delete.cancel` RPCs end to end.
