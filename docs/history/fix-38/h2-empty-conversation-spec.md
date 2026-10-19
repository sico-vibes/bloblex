# FIX38 H2: clicking a bot with no conversation flashes, jumps to another bot, and saves a conversation named after the bot — dig deep

> **What this is:** Spec for FIX38 H2: clicking a bot with no conversation flashes, jumps and saves a conversation.
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: OpenCode `deepseek-v4.1-flash` (high), its own worktree. All code in this wave is yours (AGENTS.md, 18 October amendment). **Never run `git commit`.** Keep context small. Read the section headings of `AGENTS.md`, then `docs/history/fix-37/g3-report.md` (the last selection fix) and the FIX34 A3/A4 notes in `SESSION_HANDOFF.md` (empty chats are not saved).

## What the owner sees (beta.32)

- With Coco selected (Coco has a conversation), clicking the **Manager** (no conversation yet) makes the window flash; the selection jumps to the **first bot in the list** (e.g. Lopsing) instead of the Manager. Clicking the Manager a second time then shows a conversation and the composer.
- A conversation appears in the Conversations column **titled with the bot's name** ("Manager") even though nothing was sent, and it is kept.

## What should happen

1. Clicking a bot with no conversation selects that bot **at once and stays on it**, and shows a ready composer.
2. Until the first message is sent, nothing is stored: no session in the daemon, no row in the Conversations column (or at most a local draft row titled **"New conversation"** that disappears when the user leaves without sending).
3. On the first send the conversation is created and titled from the first message (the existing auto-title), never with the bot's name.

## Where to look (find the real causes; there may be several)

- `apps/desktop/src/ui/App.tsx`: `selectAgent` calls `ensureConversation` when the bot has no main session; the auto-create effect (`autoCreatedFor`) does the same; G3's reconcile effect and `nextSelectionAfterRemoval` choose a new selection "when the selected id is no longer in the snapshot" — check whether a bot with **no** session (selectedSessionId null) or a just-created session not yet in the snapshot is misread as "removed" and sends the selection to the first bot. Also the active-session listener and `setActiveSession(null)` round-trip with the companion window, and the "empty conversation is not kept" effect (`session.delete.schedule`).
- The daemon's `agent.conversation` (`crates/bloblex-daemon/src/main.rs`, and the preview fixture `apps/desktop/src/preview/fixtureBridge.ts`) creates a session titled with the agent's name. Decide the clean design: preferably the UI holds a **local draft** (no RPC) until the first send, which then calls `agent.conversation.create` + `session.prompt`; if a daemon session must exist earlier, create it untitled ("New conversation" shown by the UI) and never persist it without a message.

## Proof (required)

Mounted tests in `apps/desktop/src/ui/App.*.mounted.test.tsx` that **fail on the current code first**:
- with bot A (has a conversation) selected, clicking bot B (none) selects B, stays on B across several settles, and shows B's composer; no other bot is ever selected in between (record every selection change);
- no `agent.conversation`/create call and no Conversations row titled with the bot's name before a message is sent; leaving B without sending leaves nothing behind;
- sending the first message creates exactly one conversation, titled from the message;
- the Manager behaves the same as any bot;
- G3's tests (delete/archive) still pass.

Daemon test if you change `agent.conversation`.

## Gates
- `cd apps/desktop && npx tsc -b && npx vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests |FAIL"` and `npm run build`
- If Rust changed: `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"` and clippy `-D warnings`.

Write `docs/history/fix-38/h2-report.md`: the actual causes (file:line), the fix, the tests, what is unverified.
