# Wave 15 brief: Phase 1A, bots across projects (backend)

**Lane:** the Sonnet 5.5 (medium) bot in the owner's Bitbots app, assigned through the Bitbots MCP, in its own git worktree.

**Rules:**
- You never run `git commit`, `git push` or `git merge`, and never switch branches.
- You change nothing outside your worktree.
- The Director (Claude) builds the UI against the contract below and merges your diff.

**Plan:** `docs/plans/expansion-plan-v3.md`, Phase 1A (an owner decision of 29 October 2026).

**Read first:**
- `.claude/skills/bitbots-development/SKILL.md`;
- its `references/codebase-map.md` and `references/lessons.md`;
- `AGENTS.md` (the Remote rules and the 29 October amendment).

## The decision

A bot is no longer owned by a project. The owner builds a few good bots once, and they work in every project.

- **A bot stays a bot, with its own status.** It never becomes a list of threads.
- **Each conversation picks its project.** The bot knows which project a conversation is in.
- **Context and memory are split:** the bot's own part (identity, instructions, skills, what it knows about the owner) plus the project's part (that project's notes and rules).
- **An Always-allow rule** is either for one project or everywhere for that bot.

## What exists today (build on it)

- `agents.project_id` is the bot's one project; `team::workspace_for` (`team.rs` ~259) picks the folder from it.
- Conversations already carry their own project: `sessions.data.projectId`, stamped at creation (`new_sessions_carry_project_id` test, `main.rs` ~12170).
- `agent.conversations {agentId, projectId?}` already filters by project (`team.rs` ~1372).
- `agent.conversation.create {agentId, title?}` always uses `workspace_for(agent)` (`team.rs` ~1358).
- Memory has the scopes `blob | project | shared`. `memory_visible_to(row, agent_id, project_id)` (`bloblex-storage` ~1512) takes the project from its caller.
- `permission_rules(id, agent_id, kind, match_key, label, created_at)` has no project. `permission.reply {permissionId, choice, remember: bool}` (`main.rs` ~1238).

## Contract (the UI is built against exactly this)

### 1. A bot's default project

- `agents.project_id` keeps its column. It now means the bot's **default** project for new conversations. It may be null.
- The agent DTO keeps `projectId` and adds `lastProjectId` (the project of the bot's most recent conversation, or null).
- Nothing about a bot's folder is required any more. A bot with no project still gets its private workspace (`workspace_for`'s existing fallback).

### 2. New conversations pick a project

`agent.conversation.create {agentId, title?, projectId?}`:
- **`projectId` given:** the conversation opens in that project's folder. Refuse with `invalid_argument` ("That project has no folder on this computer.") when the project has no existing folder. Refuse with `not_found` when there is no such project.
- **Omitted:** `lastProjectId`, then `projectId`, then the private workspace, in that order.
- **The session is stamped** with the chosen `projectId`, as today.
- The same `projectId` parameter goes on `session.new` (when `agentId` is given), and on the MCP's `send_message` (see 7).

### 3. A bot's projects

**New RPC** `agent.projects {agentId}` returns:

```
{projects: [{id, name, path, isDefault, conversationCount, lastActivityAt, isGitRepo}]}
```

- **Which projects:** every project the bot has a non-archived conversation in, plus its default.
- **Order:** most recent activity first. The private workspace counts as `{id: null, name: "No project"}` when it has conversations.
- Each entry in `agent.conversations` keeps its fields and gains `projectId` and `projectName` (null for none).
- `session.get`, the snapshot's sessions and `session.changed` carry `projectId` and `projectName`.

### 4. Context: the bot's part and the project's part

- **Instructions:** when a conversation starts or resumes, the instructions Bitbots sends are the bot's own instructions plus a short **project section**:
  - the project's name;
  - its folder;
  - its description;
  - its notes or rules;
  - when the repo root has a `.bitbots.json`, its `instructions` string (at most 4,000 characters; ignore the file if it isn't valid JSON or has no string `instructions`).

  The project section comes from the **conversation's** project, never the bot's default.
- **Memory:** memory reads and writes use the conversation's project. `memory_visible_to` gets the conversation's `projectId`. A note saved with scope `project` from a conversation is tied to that conversation's project. A note tied to one project never appears in another.
- **Team instructions** (the teammates list and the Manager's playbook) are unchanged, apart from naming the conversation's project.

### 5. Always-allow rules: in this project, or everywhere

- **Storage:** `permission_rules` gains `project_id TEXT NULL` (null = everywhere for this bot). Migration is additive: existing rules become "everywhere", which is what they are today. Replace the unique index with `(agent_id, kind, match_key, COALESCE(project_id, ''))`.
- **Saving:** `permission.reply {permissionId, choice, remember: true, rememberScope?: "project" | "bot"}`.
  - Default `"bot"`, so older clients keep today's behaviour.
  - `"project"` stores the conversation's `projectId`. When the conversation has no project, store `null`.
- **Matching:** a rule applies when its `project_id` is null or equals the conversation's `projectId`.
- **Listing:** `permission.rules.list` rows gain `projectId` and `projectName` (null = everywhere).
- **New RPC:** `permission.rules.update {id, scope: "project" | "bot", projectId?}`. It moves a rule between "everywhere" and one project (`projectId` is required for `"project"`), broadcasting `permission.rules.changed`.
- **The card:** permission cards that are rememberable gain `projectId` and `projectName`, so the card can say "Always allow in Blolblex".

### 6. Manager and team

- **`message_blob` and `assign_task`** (the team MCP tools) take an optional `project` (an id or exact name).
  - **Given:** the side conversation opens in that project.
  - **Not given:** it opens in the **sender's conversation's** project, when the target bot is allowed to work there, which every bot now is.
- **Delegations and worktrees** use that project's folder, with the same worktree rule as today.
- **The Manager's `list_projects`** stays, and the Manager's instructions say that any bot can work in any project.
- **Bots may message each other across projects;** nothing refuses it.

### 7. The Bitbots MCP (`external.rs`)

- **`send_message`** with `newConversation` takes `projectId`, or `projectPath` matched to a registered project, and uses section 2.
- **`list_projects`** lists, per project, the bots that have conversations in it.
- **`list_conversations`** rows gain `projectId` and `projectName`, and the tool takes an optional `projectId` filter.

### 8. Remote tiers

Add rows to `apps/desktop/src/remote/tiers.json`:
- `agent.projects`: read, viewer;
- `permission.rules.update`: never, like the other rule writes.

Keep both parity tests green. Pass `projectId` and `projectName` through the remote redaction unchanged: they are not host paths. A project `path` stays dropped or tail-only, as today.

## Tests (daemon and storage; name them like these)

- `a_conversation_opens_in_the_project_it_picks`, plus a missing or folderless project refused.
- `a_new_conversation_defaults_to_the_bots_last_project`.
- `agent_projects_lists_every_project_a_bot_has_worked_in`.
- `the_project_section_comes_from_the_conversation_not_the_bot`, including `.bitbots.json` read, capped, and ignored when invalid.
- `project_memory_stays_in_its_project`.
- `an_always_rule_for_one_project_does_not_apply_in_another`.
- `an_everywhere_rule_applies_in_every_project`.
- `old_rules_migrate_to_everywhere`.
- `rules_move_between_scopes`.
- `message_blob_opens_the_side_conversation_in_the_senders_project`, and in an explicit project.
- MCP: `send_message` with `projectId`; `list_conversations` carries `projectName`.
- Remote parity in Rust and TS.

## Gates you run before reporting (from your worktree)

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`
- `npm run typecheck` and `npm test`. These need `node_modules`; if your worktree has none, say so, and the Director runs them after merging.
- **Do not run `npm install`.**

## Report (your final reply)

- Files changed, with one line each.
- Tests added and their results.
- Gate results, with any failure output.
- Any change to this contract, and why. Don't change it silently: the UI is being built against it.
- What you could not verify.
- A proposed update for the skill's `lessons.md` and `codebase-map.md`.
