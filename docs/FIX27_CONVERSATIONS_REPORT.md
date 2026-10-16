# FIX27 (WP3) report: many conversations per bot, auto-titles, stable bot-to-bot tree

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, worktree `C:\fx43`, branch
`lane/fix27-wp3`. WP2 (two-phase send, `activate_session`, `session.warm`) was
already merged here and this change builds on it. No `git commit` was run.

## What changed, by file and function

### `crates/bloblex-storage/src/lib.rs`

- `ensure_session_project_backfill` (new, private `ensure_*`): one-off,
  idempotent backfill of `sessions.data.projectId` from the projects table by
  `project_path`, guarded by the settings marker
  `migration.sessionProjectBackfill` (same pattern as
  `ensure_opencode_effort_gate_open`). Called from all five migration entry
  points, after `ensure_team_schema` so the `projects` table exists.
- `side_session`: now delegates to `side_session_for(agent, peer, "")` so the
  old callers keep the newest-first behaviour.
- `side_session_for` (new): same lookup, but prefers a side conversation whose
  `link.spawnedFromSessionId` equals the origin session, then the newest.
- `agent_conversations(agent_id, project_id, include_archived)` (new): rows for
  (`agent_id = ?` and link kind not `automation`/`handoff`) **or** (link kind
  `side` and `link.peerAgentId = ?`), newest first. Each row carries
  `id, title, state, createdAt, updatedAt, archived, projectId,
  kind(main|side), agentId, peerAgentId, topic, spawnedFromSessionId,
  originSessionId, messageCount`. `projectId` is
  `COALESCE(data.projectId, inferred-by-path)`; the optional filter compares the
  same expression; archived rows only with `include_archived`.
- `session_auto_title(id, title) -> Option<summary>` (new): writes `title`
  (never `title_override`) only while `title_override IS NULL`, the title is
  still `'New chat'` or the agent's own name, the row is not a side
  conversation, and no user message exists. Returns the `session.changed`
  summary when a row changed.
- `merge_session_data(id, fields)` (new): RFC 7396 `json_patch` of top-level
  keys into a session's `data`.
- `session_lazy_start` / `clear_session_lazy_start` (new): read and clear
  `data.lazyStart`.
- `project_id_for_path` (new): the project id whose folder is exactly a path.
- `session_list`, `session_detail_locked`, `session_event_summary_locked`: add
  `workspaceLabel` = project name from `data.projectId`, else from
  `project_path`, else `"Casual"`.
- `set_setting`: validates `conversations.autoTitle` as a boolean and emits
  `settings.changed` for `conversations.*` window preferences.
- `memory_tests::session_project_backfill_is_idempotent` (new test).

### `crates/bloblex-daemon/src/team.rs`

- `workspace_for`: a pathless bot keeps an existing `<data>/workspaces/<agentId>`
  folder (never moves it, so provider resume keeps its working directory);
  otherwise the new folder is `<data>/workspaces/<slug>-<id8>`.
- `workspace_dir_name` (new): ASCII lower-case slug of the bot name (dashes, max
  32) plus the first eight characters of the agent id.
- `message_blob`: a newly created side conversation gets an immutable
  `link.spawnedFromSessionId` = the creating session; continuing it still
  updates `link.originSessionId` ("where the reply goes") only. The no-topic,
  no-id fallback now uses `side_session_for(target, from, session_id)`.
- `agent_conversation_create` (new): validates the bot (unknown → `not_found`,
  archived → `invalid_argument`), defaults the title to `"New chat"`, and asks
  `new_session` for a lazy conversation.
- `agent_conversations` (new): validates `agentId`, `includeArchived`,
  `projectId`, maps storage rows to the documented DTO (`kind`, `role` =
  `null`/`sender`/`receiver`, `parentId` from `spawnedFromSessionId` falling
  back to `originSessionId` and only when the id is in this bot's result set).
- `team_rpc`: adds `agent.conversation.create` and `agent.conversations`.
- `agent.team.update`: no longer archives the main conversation on a project
  move; the panel filters by project instead. `main_session`/`session_busy`
  imports are unchanged (both still used elsewhere).

### `crates/bloblex-daemon/src/main.rs`

- `new_session`: stamps `data.projectId` (the bot's project, else inferred from
  the project path) on every new session. A new `lazy: true` parameter persists
  the row as `idle`, `resumable = 0`, no provider id, `data.lazyStart = true`,
  emits `session.changed`, and returns **without** spawning the provider.
- `resume_inner`: computes `lazy_first_activation` (`!can_resume_saved_provider`
  + no provider id + `data.lazyStart`). On the fresh-context branch it suppresses
  the `session.context.reset` event, and after install it suppresses
  `memory::forget_catalog` + the `team::note(FreshSession)` notice, and clears
  the lazy marker.
- `session_prompt_impl`: auto-title runs before the user message is appended and
  now goes through `session_auto_title` (so it can never touch a renamed row).
- `auto_titles_enabled` (new): `conversations.autoTitle` wins when set; when it
  is absent, the legacy `experimental.autoTitles` is honoured and defaults to on.
- `dispatch`: the team arm covers `agent.conversation.create` and
  `agent.conversations`; `settings.set` validates `conversations.autoTitle`.
- Tests: `online_team_state` helper; `conversation_create_is_lazy`,
  `agent_conversations_tree`, `spawned_from_is_stable`,
  `side_fallback_prefers_current_spawn`, `new_sessions_carry_project_id`,
  `team_update_project_move_does_not_archive`, `workspace_label_and_slug_dir`;
  `auto_title_rules` replaces the old `experimental_titles_are_opt_in_...`;
  the assertion in `leader_delegates...` gains `spawnedFromSessionId`.

### `crates/bloblex-daemon/src/experiments.rs`

- `automatic_title`: accepts `"New chat"` as well as the bot's own name as the
  default title; otherwise unchanged gating (never side, never after a user
  message).
- `title_from_prompt` (new): first non-empty line, whitespace collapsed, at most
  48 characters, cut on a word boundary with `…`; a single over-long word is
  hard-cut at 47 + `…`. No model call.
- `is_default_title` (new) and the updated unit test.

### `apps/desktop/src/remote/remoteTiers.ts` (policy table only, no UI)

- `agent.conversations`: `read` / `viewer` — "Lists a bot's conversations so a
  device can pick one."
- `agent.conversation.create`: `chat` / `chat` — "Starts a new conversation with
  a bot."

## RPC shapes as implemented

- `agent.conversation.create { agentId, title? } -> { session }`
  - `session` is the full `session_detail` DTO (idle, `resumable: false`,
    `providerSessionId: null`, title `"New chat"` unless given).
  - Errors: `invalid_argument` (missing/empty agentId, title > 120, archived
    bot), `not_found` (unknown bot), provider errors from `new_session`.
- `agent.conversations { agentId, projectId?, includeArchived? } ->
  { conversations: [ { id, title, state, createdAt, updatedAt, archived,
  projectId, kind: "main"|"side", agentId, peerAgentId, topic, parentId,
  role: "sender"|"receiver"|null, messageCount } ] }`
  - `parentId` is `spawnedFromSessionId` (falling back to `originSessionId`)
    only when that id is in the returned set, else `null`.
  - Errors: `invalid_argument` (missing agentId, non-boolean `includeArchived`,
    non-string `projectId`), `not_found` (unknown bot).
- `agent.conversation` (unchanged) still returns the newest main conversation,
  creating one if none exists.
- New setting: `conversations.autoTitle` (boolean, default on).

## Tests added and changed

Added: `session_project_backfill_is_idempotent` (storage),
`conversation_create_is_lazy`, `agent_conversations_tree`,
`spawned_from_is_stable`, `side_fallback_prefers_current_spawn`,
`new_sessions_carry_project_id`, `team_update_project_move_does_not_archive`,
`workspace_label_and_slug_dir`, `auto_title_rules` (daemon).

Changed: `leader_delegates_to_a_teammate_and_is_woken_by_the_relayed_reply`
(side link now carries `spawnedFromSessionId`),
`title_changes_only_first_main_prompt_with_default_title` (new title rule),
the old `experimental_titles_are_opt_in_...` replaced by `auto_title_rules`.

`agent.conversation`'s own behaviour did not change, so its tests were left
as-is (`automation_sessions_never_replace_a_blobs_main_conversation`,
`leader_delegates...` uses it unchanged).

## Gates

All run in `C:\fx43` with the private `CARGO_TARGET_DIR=C:/fxtarget` and
`RUST_MIN_STACK=33554432`.

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — exit 0. Every suite `ok`; 558 tests passed in total (daemon bin 187,
  storage 93).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — exit 0.
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote` — exit 0;
  3 files, 47 tests passed (includes `remoteTiers.parity.test.ts`, which checks
  the two new dispatch methods have rules and that no rule is stale).

## Verified vs not verified

Verified:

- Compilation, clippy (deny warnings), the full Rust test suite and the remote
  tier policy tests.
- Lazy creation: no `new_session` on the adapter until the first prompt, exactly
  one afterwards, with no `session.context.reset` event and no transcript
  `context_reset` notice; the marker is cleared.
- Tree shape: `parentId`/`role` for a main conversation, a side conversation the
  bot started and one it received; archived rows hidden unless requested.
- `spawnedFromSessionId` stays fixed while `originSessionId` moves on continue;
  the no-topic fallback lands in the thread the sending conversation started.
- `data.projectId` is stamped on main and side sessions; the storage backfill is
  idempotent and marker-guarded.
- A project move keeps the bot's conversations.
- New workspace path shape `<slug>-<id8>` and reuse of a legacy `<agentId>`
  folder.

Not verified (out of this lane or not reproducible here):

- The end-to-end native flow with a real Claude/Codex/OpenCode binary. Tests use
  the scripted `TeamAdapter`; a live provider start and resume were not
  exercised.
- The UI conversation panel, rename/delete/new wiring and any CSS — Director
  lane.
- `docs/remote/PROTOCOL.md`'s generated tier table was not regenerated. It was
  already stale before this change (for example it omits `session.warm` and
  `session.environment`), and no test compares it to `METHOD_RULES`; the source
  of truth, `remoteTiers.ts`, is updated and covered by the parity test.
- The optional `projectId` filter across a real multi-project workspace was only
  covered by the `new_sessions_carry_project_id` test, not by a live run.
