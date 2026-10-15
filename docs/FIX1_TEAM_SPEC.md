# Fix 1C spec: leader-only blob creation over the Bitbots MCP bridge, workflows default on, one reaction per message

Owner: OpenCode lane (backend only). Reviewer: Director. **Do not touch `apps/desktop/src`** (Director builds the UI). Another lane edits `crates/bloblex-adapter-acp` and OpenCode catalog bits of `main.rs` in parallel: do not touch the adapter crates or `fetch_model_catalog`/`runtime_capabilities`.
Scope: `crates/bloblex-daemon/src/team.rs`, `crates/bloblex-daemon/src/main.rs` (only the places named below), `crates/bloblex-storage/src/lib.rs` (reaction function only, plus anything blob creation needs), tests, `docs/`.

## Rules
- Never run `git commit`, `git push`, `git checkout`, `git stash`. Leave changes uncommitted. Work only inside this worktree; never read or list paths outside it.
- Cargo: `CARGO_TARGET_DIR=D:/b-int`.
- Match repo style (dense one-line test style is fine). No `unwrap()` in non-test code you add. Prompts and capability tokens never go into logs.

## 1. Team leader creates blobs (owner request, in the owner's words)
"The application should be built around MCP: I ask the team leader to create bots, it understands what a blob is and how to create one, and sets name/description from what I describe. Only the leader may create blobs. A non-leader that is asked to create a bot must say it is not allowed and tag the leader so I can go back to the leader."

Add three tools to the app-owned bridge (`team.rs` `tools()` and `mcp_rpc`), **listed and callable only when the calling session's blob is the leader** (`agents.leader = 1`, see `agent_get`; side conversations of the leader are allowed, automation sessions are not):

- `list_projects`: id, name, path, description of each project (project rows via `project_list`), so the leader can attach blobs to the right one.
- `create_blob`: input `{ name (1-40 chars, unique case-insensitively among non-archived blobs), role? (<= 40, e.g. "CTO"), description? (<= 280, what it is for), instructions? (<= 4000, persona/working style; becomes the blob's own `instructions`), project? (id or exact name of an existing project; absent = casual blob), provider? ("claude"|"codex"|"opencode"; default = the leader's own runtime), model?, thinking? (only accepted if the catalog for that runtime validates it, same as `agent.create`) }`. Rules: never sets `approvalMode` (inherits the app default, which is never bypass for created blobs even if the default is bypass: force `ask` unless the leader's own mode is `auto`, in which case `auto`); never sets the `leader` flag; at most **5 created blobs per turn/call-batch** and at most **12 non-archived blobs in total** (return a clear error text when exceeded); unknown project -> error text listing available project names. Go through the same code path as the `agent.create` RPC (catalog normalisation/validation, `agent_create`, `broadcast_persisted`) so the sidebar gets the normal events. Return a short text: created blob name, role, project, runtime. Also record the creation: append a team note in the leader's conversation via the existing `note()` helper ("Created blob <name> (<role>) in <project>.") and set a `createdBy` leader id inside the blob's existing free-form settings/metadata if there is a column for it; if no column exists do not add a migration, skip it and say so.
- `update_blob`: input `{ blob (name or id), role?, description?, instructions? }`, leader only, cannot change leader flag, runtime, mode, project, archive or delete. Same size limits.
- No tool to delete or archive blobs is offered. 

Permissions: these tools are covered by the existing `mcp__bloblex__` allow (`is_team_tool_permission`); leave it. Add tests that a non-leader gets no such tools in `mcp.tools.list` and that calling them returns `isError` with the text in section 2.

## 2. Non-leaders know their limits and tag the leader
`runtime_instructions` (team.rs): 
- Leader gets one extra paragraph: how and when to use `create_blob` (when the user asks for a bot or a team; first `list_blobs` and `list_projects` to avoid duplicates; read the project folder/description yourself to decide which roles fit; create at most a handful; give each a distinct short name, a role such as CTO, one sentence of purpose, and instructions describing its working style; tell the user afterwards who was created and where).
- Non-leader gets: "You cannot create or change blobs; only the team leader can. If the user asks you to, say so briefly and tag the leader as `@<LeaderName>` (use the real name from `list_blobs`; if there is no leader say that the user needs to set one) so the user can ask them." (Substitute the actual leader name when a leader exists at prompt-build time, otherwise the no-leader sentence.) Test the exact substitution for: leader exists, no leader, the viewer being the leader.
- Tool call by a non-leader (should it somehow happen) returns `isError` text: "Only the team leader (<name>) can create blobs. Ask the user to tag @<name>."

## 3. Claude dynamic workflows (and therefore Ultracode) default ON, opt-out in Settings
Today `claude.enableWorkflows` is read as `settings["claude.enableWorkflows"] == true` in several places (grep `claude.enableWorkflows` in `main.rs`: ~L1162 session options, ~L1274, ~L1407) so an unset setting means off and Ultracode never appears in the effort selector. Owner decision: **on by default for new sessions; the owner can turn it off**. Implement one helper `fn claude_workflows_enabled(settings: &Value) -> bool { settings["claude.enableWorkflows"] != false }` (unset or non-boolean = on; explicit `false` = off) and use it at every site, including the catalog probe scope. Existing sessions keep their stored lock (unchanged). Automation sessions stay forced off. Update the existing tests that assumed the old default (~L5278-5334) and add: unset -> on, explicit false -> off, catalog for Claude offers `ultracode` when unset (fake probe).
(The UI default is changed by the Director; do not touch it.)

## 4. One reaction per message
`Storage::toggle_message_reaction` (`crates/bloblex-storage/src/lib.rs` ~L2704) currently allows several emoji per message. New semantics: **at most one reaction per message.** Toggling the emoji that is already set removes it; toggling a different emoji replaces the previous one (delete all existing rows for that message, insert the new one) in the same transaction. The returned/broadcast payload keeps `{sessionId,messageId,emoji,selected,reactions}` with `reactions` containing at most one entry. Existing messages that already have several reactions keep them until the next toggle (no data migration); toggling then collapses to the single chosen one. Update `message_reaction_rpc_persists_and_broadcasts_only_scoped_user_state` and storage tests; add one for replacement and one for removal of the sole reaction.

## Gates (run and report real output)
```
CARGO_TARGET_DIR=D:/b-int cargo test -p bloblex-daemon
CARGO_TARGET_DIR=D:/b-int cargo test -p bloblex-storage
CARGO_TARGET_DIR=D:/b-int cargo test --workspace --exclude bloblex-desktop
```

## Final report (plain text, last message)
1. Files changed. 2. Per section: what changed + exact test names. 3. Gate output. 4. Unverified items, decisions you made where the spec was silent, and anything declined. Fake-peer verified only; no live claim.
