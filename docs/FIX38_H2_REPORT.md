# FIX38 H2 — clicking a bot with no conversation

Lane: OpenCode `deepseek-v4.1-flash` (high), worktree `C:\fx72`. **No `git commit` was run.**

## Symptom

With Coco (has a conversation) selected, clicking a bot with no conversation (the
Manager) flashed the window, moved the selection to the first bot in the list
(Lopsing), and left a conversation row titled with the bot's name ("Manager"),
even though nothing was sent.

## What actually caused it

Several causes stacked; the "flash then jump" was the cross-window round-trip.

1. **A click created and persisted a conversation at once.**
   `selectAgent` (`apps/desktop/src/ui/App.tsx:2033`) called `ensureConversation`,
   which called the daemon's `agent.conversation` (`crates/bloblex-daemon/src/team.rs:629`).
   That creates a real session **titled with the bot's name**
   (`team.rs:636`, `new_session(...,"title":agent_name(&agent))`) before a single
   message. The preview fixture did the same (`apps/desktop/src/preview/fixtureBridge.ts:983`).
   The auto-create effect (old `App.tsx:1220-1232`) did the same thing again.

2. **`selectAgent` announced a null active session, which round-tripped.**
   `selectAgent` published `setActiveSession(main?.id ?? null)` — a **null** for a
   bot with no conversation. The native active-session bridge notifies every window;
   the companion window loses its session on the null, falls back to another
   conversation (the newest / its own default) and announces it back. The main
   window's `listenForActiveSession` (`App.tsx:1148`) then adopts that id and moves
   the selection. This is the deterministic jump to the first bot: it was
   reproduced in a mounted test that models the bridge (see below).

3. **A just-created session missing from a snapshot read as "removed".**
   The reconcile effect (`App.tsx:1253`) treats "selected id not in `sessions`" as a
   removal and runs `nextSelectionAfterRemoval` (`App.tsx:~2860`). A `refresh()`
   that lands before the daemon's new row is in its list (or a locally upserted row
   replaced by a stale snapshot) made it pick the first bot with a conversation.
   The brief flags exactly this: "a just-created session not yet in the snapshot is
   misread as 'removed'".

4. **The daemon/fixture titled the row with the bot's name**, which is what the
   Conversations column showed.

## The fix

The UI now holds a **local draft** until the first message; nothing is stored on a
click.

- **Draft helpers.** `draftSessionFor` / `isDraftSession` / `DRAFT_SESSION_PREFIX`
  (`apps/desktop/src/ui/teamSelectors.ts:302-322`). A draft is a synthetic `Session`
  with id `draft:<agentId>`, title "New conversation", no messages.
- **The selection falls back to a draft** when the selected bot has no main
  conversation, is connected and its runtime is usable
  (`App.tsx:547-549`). The composer is ready at once.
- **`selectAgent` does no RPC and never publishes a null** (`App.tsx:2033-2046`):
  it publishes the active session only when the bot actually has one. This is what
  stops the companion round-trip.
- **The publish effect ignores drafts** (`App.tsx:1204-1207`), so opening a draft
  cannot disturb the shared active session.
- **The auto-create effect is removed**; `ensureConversation` is removed. Nothing
  creates a conversation by itself.
- **The first message creates the conversation.** `sendPrompt`
  (`App.tsx:1794-1810`) creates it with `agent.conversation.create` (untitled,
  "New chat") and then calls `session.prompt`, so the daemon's existing auto-title
  names it from the message. `createConversation` (`App.tsx:1581`) now returns the
  session and is deduplicated with `ensuringConversation`.
- **`pendingSessionIds`** (`App.tsx:412`, guarded at `App.tsx:1255-1260`, set at
  `App.tsx:1589`) keeps a just-created conversation from being read as removed
  before a snapshot confirms it. A delete is still final and falls through.
- **Queue/model lookups skip drafts** (`App.tsx:735`, `App.tsx:1886`).
- **The preview fixture** now answers `agent.conversation.create`, stores an
  untitled "New chat" row and auto-titles it from the first message
  (`apps/desktop/src/preview/fixtureBridge.ts:983`, `:763`).

The daemon's `agent.conversation` was left unchanged: the UI no longer calls it,
and its name title is still an accepted auto-title default. No Rust changed.

## Tests

`apps/desktop/src/ui/App.emptyConversation.mounted.test.tsx` (new, mounted,
happy-dom), written first and failing on the old code:

- **`does not bounce to the first bot when the companion round-trips the active
  session`** — models the native bridge (every window receives what any publishes;
  a companion that loses the session announces a fallback). On the old code the
  recorded selection history was `["Lopsing"]`; now it is `["Manager"]`.
- selects a bot with no conversation at once and stays across four settles, with
  every selection change recorded;
- shows a ready composer with **no** `agent.conversation` / `agent.conversation.create`
  / `session.new` call;
- no Conversations row titled with the bot's name before a message;
- leaving the bot without sending leaves nothing behind (no RPC, no
  `session.delete.schedule`, no row);
- sending the first message creates **exactly one** conversation and prompts it,
  and the row is titled from the message, never with the bot's name;
- the Manager behaves like any other bot.

`apps/desktop/src/ui/App.agent.mounted.test.tsx`: the old
"opens a blob without a conversation through agent.conversation" test was rewritten
to the new behaviour (draft on open, stored on first message).

`apps/desktop/src/ui/App.selection.mounted.test.tsx` (FIX37 G3, delete/archive) is
unchanged and still green.

## Gates

- `cd apps/desktop && npx tsc -b` → clean.
- `npx vitest run --maxWorkers=3` → **163 files, 1143 tests, all passing.**
- `npm run build` → succeeds.
- Rust unchanged, so the Rust gates were not run.

## Unverified

- Not exercised against the real companion window, tray or a live daemon; the
  cross-window round-trip is modelled with a mocked native bridge (the same caveat
  as FIX37 G3), not the real Tauri event channel.
- The daemon's first-prompt auto-title is covered by the existing daemon test
  `auto_title_rules`; the UI test simulates it in the bridge mock, so the UI +
  daemon auto-title are not driven end-to-end.
- `agent.conversation` still titles a new conversation with the bot's name. No UI
  path calls it now; if a future caller opens it before a message, the row would be
  named after the bot until the auto-title replaces it.
- The draft has no row in the Conversations column. The brief allowed "at most" a
  draft row; none is shown.
