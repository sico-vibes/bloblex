# FIX27 (WP3): many conversations per bot, auto-titles, and a stable bot-to-bot tree

> **What this is:** Spec for FIX27 (WP3): many conversations per bot, auto-titles and a stable bot-to-bot tree.
> **Status:** historical
> **Last updated:** 2026-10-16

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree. Director reviews, runs the gates on the merged result and commits. **Do not run `git commit`.** Read `AGENTS.md` (16 October amendment) first.

Read before coding: `crates/bloblex-daemon/src/team.rs` (`workspace_for` ~97, `message_blob` ~423, `side_session` and the side-session fallback, `after_turn` ~599, `agent_conversation` ~639, `team_rpc` and its `agent.team.update` arm ~670); `crates/bloblex-daemon/src/main.rs` (`new_session`, the resume/activation path after WP2, `session_prompt_impl` Phase A, the dispatch arm at ~632); `crates/bloblex-daemon/src/experiments.rs` `automatic_title`; `crates/bloblex-storage/src/lib.rs` session queries and `ensure_*` functions; `apps/desktop/src/remote/remoteTiers.ts`.

## Why
The owner wants a conversation panel per bot: every conversation the user had with that bot in its project, auto-titled from the first prompt, with rename/delete/new, and bot-to-bot conversations nested under the conversation that started them. Today each bot has one "main" conversation (newest non-archived, non-side, non-automation session), a new one archives the old, side links lose where they started (`originSessionId` is overwritten on every continue, `team.rs:451`), and a project without a path makes the workspace `<data>/workspaces/<agent uuid>`, so the UI shows a UUID.

## 1. `agent.conversation.create { agentId, title? }` → `{ session }`
- Fails (`invalid_argument` / `not_found`, existing mappings) for an archived or unknown agent.
- Creates a session through `new_session` with `projectPath = workspace_for(agent)`, `title` default `"New chat"`, `data.projectId` = the agent's `projectId` (or null), and the same exec options `agent.conversation` uses.
- **Lazy:** persist the row (state `idle`, `resumable = 0`, no provider id, `data.lazyStart = true`), emit `session.changed`, and do **not** spawn the provider. The first prompt's activation (WP2 `activate_session`) takes the existing "fresh provider context" branch. On that first activation, when `data.lazyStart == true` and there is no provider id, suppress the `session.context.reset` event, the `team::note(FreshSession)` notice and `memory::forget_catalog`; clear the flag once installed.
- Remote tier: `class: 'chat'`, `why: 'Starts a new conversation with a bot.'`.

## 2. `agent.conversations { agentId, projectId?, includeArchived? }` → `{ conversations: [...] }`
One row per conversation, newest first:
`{ id, title, state, createdAt, updatedAt, archived, projectId, kind: 'main' | 'side', agentId, peerAgentId, topic, parentId, role: 'sender' | 'receiver' | null, messageCount }`
- Storage query `agent_conversations(agent_id)`: sessions where (`agent_id = ?` and link kind is not `automation` or `handoff`) **or** (link kind `side` and `link.peerAgentId = ?`).
- `role`: `null` for main conversations; `sender` when this bot asked (`link.peerAgentId == agentId`), `receiver` when it was asked (`agent_id == agentId` on a side session).
- `parentId` = `link.spawnedFromSessionId` (fall back to `originSessionId` for older rows) **if** that id is in this bot's result set, else `null`. A received side conversation whose origin is not in the set is a root (the UI labels it "from <peer>").
- `projectId` filter: compare `COALESCE(data.projectId, inferred)` where inferred matches `project_path` against the projects table. Omitted `projectId` returns all.
- Archived rows only with `includeArchived: true`.
- Remote tier: `class: 'read'`, `minTier: READ`, redacted like `session.list`.
- Keep `agent.conversation` (newest main conversation, creating one if none) unchanged for compatibility.

## 3. Stable tree link
- `message_blob` writes an immutable `link.spawnedFromSessionId` when it **creates** a side conversation, and never overwrites it. `originSessionId` keeps its meaning ("where the reply goes") and may still be updated on continue.
- The `side_session` fallback (no topic or id given) prefers a side conversation whose `spawnedFromSessionId` is the current session, then the newest. With many conversations a brief must not land in an unrelated thread.

## 4. Auto-title on by default
- The existing `experiments::automatic_title` call in `session_prompt_impl` (Phase A after WP2) becomes on by default through a new setting `conversations.autoTitle` (default true); keep honouring `experimental.autoTitles` (either one on turns it on; an explicit `conversations.autoTitle: false` turns it off).
- Storage `session_auto_title(id, title) -> Option<summary>`: `UPDATE sessions SET title = ?2 WHERE id = ?1 AND title_override IS NULL AND title IN ('New chat', <agent name>) AND NOT EXISTS (a user message)`; call it before the user message is appended (or count `<= 1`). It writes `title`, never `title_override`, so a user rename always wins. Never title side sessions.
- Title rule: first line of the prompt, whitespace collapsed, at most 48 characters cut on a word boundary with "…", no model call. Reuse `automatic_title` if it already does this; otherwise adjust it and its tests.
- Validate `conversations.autoTitle` as a boolean in `settings.set`.

## 5. Project stamping and moves
- Stamp `data.projectId` on every new session, side sessions included (the target bot's project).
- One-off idempotent backfill in a storage `ensure_*` function, guarded by a settings marker (pattern: `ensure_opencode_effort_gate_open`): `UPDATE sessions SET data = json_set(data, '$.projectId', p.id) FROM projects p WHERE sessions.project_path = p.path AND json_extract(data, '$.projectId') IS NULL`.
- `agent.team.update`: stop archiving the main conversation when a bot changes project (`team.rs` ~670). Conversations are filtered by `projectId` instead.

## 6. Readable workspace name
- Add `workspaceLabel` to every session summary/detail: the project name from `data.projectId` (or the inferred project), else `"Casual"`.
- New pathless workspaces become `<data>/workspaces/<slug>-<id8>` (slug from the bot name, ASCII, lower-case, dashes, max 32; `id8` = first 8 of the agent id). An existing `<data>/workspaces/<agentId>` folder keeps being used: **never move existing sessions** (Claude and Codex resume is bound to the working directory).

## Tests
- `conversation_create_is_lazy`: no adapter `new_session` until the first prompt; then exactly one, and no context-reset notice or event.
- `auto_title_rules`: titles only the first message while the title is default; never a side session; never after `session.rename`; off when `conversations.autoTitle` is false.
- `agent_conversations_tree`: main + sender side + receiver side; `parentId` correct for both; `role` correct; archived hidden unless asked.
- `spawned_from_is_stable`: continuing a side conversation from another session updates `originSessionId` but not `spawnedFromSessionId`.
- `side_fallback_prefers_current_spawn`.
- `project_backfill_is_idempotent` and new sessions carry `projectId`.
- `team_update_project_move_does_not_archive`.
- `workspace_label_and_slug_dir` (new pathless workspace path shape; an existing `<agentId>` dir is reused).
- Update the `agent.conversation` test only if its behaviour changes (it should not).

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote`
Use the private `CARGO_TARGET_DIR` the brief gives you.

## Report
`docs/history/fix-27/conversations-report.md`: changes by file and function, the RPC shapes as implemented, tests added and changed, gate summaries, verified versus not verified.
