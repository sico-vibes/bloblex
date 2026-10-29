# Wave 14 brief: the Bitbots MCP (backend)

Lane: Claude Sonnet 5.5, medium effort. Worktree `D:\wv14`, branch `wave14/mcp`, Cargo target `D:\wv14\target`. You never run `git commit`. The Director reviews your diff, builds the UI and commits. Plan: `docs/plans/expansion-plan-v3.md`, Phase 0.

Before you start, read:
- `.claude/skills/bitbots-development/SKILL.md`;
- its `references/codebase-map.md` and `references/lessons.md`;
- the Remote rules in `AGENTS.md`.

## Goal

A Claude Code session outside Bitbots connects with:

```
claude mcp add bitbots -- "<bridge exe>" mcp-server --endpoint "<endpoint file>"
```

It can then see and drive the owner's running app: list bots, projects and conversations; create a bot; start or continue a conversation (optionally in a new git worktree); steer or stop it; wait for the reply; answer approvals; read turn metrics.

## Model to follow

Everything here has a precedent in the code: copy those patterns, not new ones.

- **`outside.rs`** (Wave 13):
  - an off-by-default feature with a hook-only token (`bloblex_security::new_capability`);
  - an endpoint file `{address, token}` in `st.team.data_dir`;
  - `status|enable|disable` RPCs and a `*.changed` event.
- **`main_rpc`'s `outside.hook` route:** a method that bypasses the capability check but has its own bearer token and setting check.
- **`mcp_bridge.rs`:** the stdio JSON-RPC loop (`initialize`, `ping`, `tools/list`, `tools/call`) that forwards to the daemon. The new server is the same loop with a different token source and method prefix. Share the code rather than copy it.
- **`team::mcp_rpc`:** how tool lists and tool calls are shaped (`{content:[{type:"text",text}], isError}`).

## Contract (the Director builds the UI against exactly this)

### Settings (stored, but not settable through `settings.set`)

Reject both of these keys in `settings.set` with `invalid_argument` ("use external.enable"):
- `mcp.external.enabled`: boolean, default false.
- `mcp.external.tier`: `"viewer" | "chat" | "operator"`, default `"chat"`.

### Capability RPCs (UI only; add to `dispatch`)

- **`external.status`** returns:
  `{enabled, tier, endpointPath, bridgePath, command, lastCallAt, lastClient}`
  - `command` is the full `claude mcp add …` line, or null when `bridgePath` is unknown.
  - `lastClient` is the MCP client's `clientInfo.name` from `initialize` (for example `claude-code`), or null.
- **`external.enable {tier, confirm:true}`:**
  - refuses without `confirm` (`invalid_argument`);
  - makes a new token, writes the endpoint file, stores the settings and broadcasts.
- **`external.disable`:** clears the token in memory and deletes the endpoint file, then stores and broadcasts.
- **`external.setTier {tier}`:** valid only while enabled.
- **`external.rotate`:** a new token and a rewritten file. Old bridges stop working until they are restarted, which is fine.
- **Event `external.changed`:** its payload is the status object.

Never put the token in any result, event, log or error.

### Tool route (not in `dispatch`, like `outside.hook`)

- **Route:** in `main_rpc`, methods starting with `ext.` (`ext.tools.list`, `ext.tools.call`, `ext.hello`). They need `Authorization: Bearer <token>`, and `mcp.external.enabled == true`. Otherwise reply 401 `unauthorized`.
- **Comparing the token:** compare in constant time, or compare SHA-256 digests.
- **`ext.hello {clientName}`:** records `lastClient`.
- **Every call:**
  - updates `lastCallAt`, throttling the `external.changed` broadcast to one per 5 s;
  - writes a content-free activity line: the tool name and the bot's display name, never message text.

### Tools, by tier

A tool above the current tier is left out of `tools/list` and refused in `tools/call` (`isError`, "needs the Operator level in Bitbots › Settings › Connections").

| Tier | Tool | Arguments | Returns (JSON text) |
|---|---|---|---|
| viewer | `get_status` | — | app version, bot count, running turns `[{sessionId, bot, startedAt, doingNow}]`, pending approvals count |
| viewer | `list_bots` | — | `[{id, name, role, provider, model, effort, approvalMode, projectPath, status, isManager}]`; allowlisted fields only, never env/profile values |
| viewer | `list_runtimes` | — | `[{id, provider, label, models:[{id, efforts}]}]`, enough to call `create_bot` |
| viewer | `list_projects` | — | distinct project paths with bot ids and whether each is a git repo |
| viewer | `list_conversations` | `botId?`, `limit?` (default 20, max 100) | `[{sessionId, botId, title, state, updatedAt, worktree?}]` |
| viewer | `read_conversation` | `sessionId`, `afterMessageId?`, `limit?` (default 50, max 200) | messages `[{id, role, text, createdAt, kind}]`; tool steps reduced to one line each; images as `{path}` only |
| viewer | `wait_for_turn` | `sessionId`, `timeoutSecs?` (default 120, max 600) | `{done, state, reply?, approvalPending?, metrics?}`; returns early when an approval or question is waiting |
| viewer | `turn_metrics` | `sessionId`, `last?` (default 5) | per turn: `{startedAt, endedAt, durationMs, toolCalls, inputTokens?, outputTokens?, costUsd?, outcome}`; unknown values omitted, never 0 |
| viewer | `worktree_status` | `sessionId` | the `worktree::inspect` summary (branch, base, files changed, commits ahead) or null |
| viewer | `list_approvals` | — | pending approvals `[{id, sessionId, bot, tool, summary}]` |
| chat | `send_message` | `botId` or `sessionId`, `text` (max 100,000 chars), `newConversation?`, `projectPath?` | `{sessionId, turnStarted}`; existing session: same path as `session.prompt` (queue if busy); new: `session.new` then prompt |
| chat | `steer` | `sessionId`, `text` | like `session.steer` |
| chat | `stop_turn` | `sessionId` | like `session.cancel` |
| operator | `send_message` with `worktree: true` | as above, plus a new conversation in a git project | creates a linked worktree with `worktree::create` (the same one delegations use) and starts the session there; returns `worktree {path, branch}`; refuses (`isError`) when the project is not a git repo |
| operator | `create_bot` | `name`, `runtimeId`, `model`, `effort?`, `projectPath`, `role?`, `approvalMode?` (default `"ask"`) | the new bot (same shape as `list_bots`); goes through `agent_create_from_rpc` so catalog validation applies |
| operator | `answer_approval` | `approvalId`, `decision` (`allow` / `deny`) | like `permission.reply` |

### Marking what the MCP sends

- **Origin metadata:** user messages created through `send_message` or `steer` carry `origin: {kind: "mcp", client: <lastClient or "MCP">}` in the stored message (metadata or a column, whichever fits storage best).
- **Snapshot and session detail:** both carry it, so the UI can show "via Claude Code".
- **Remote policy:** pass the field through, or drop it, consistently in both ports (`remote/policy.rs`, `remoteTiers.ts`) and in `fixtures/policy-goldens.json` if needed.

### Bridge executable

- **The problem:** the installed daemon runs from a private copy that is deleted later, and a long-lived stdio process would lock the install folder's `bitbotsd.exe` and break updates.
- **The copy:** when the MCP is enabled, and at daemon start while it is enabled, the daemon copies its own executable to `<data_dir>\bitbots-mcp.exe`. If that file is locked (a client is running it), keep the old copy. The bridge is a thin forwarder, and the tools come from the daemon, so an old copy keeps working. `bridgePath` is that copy.
- **The subcommand:** `bitbotsd mcp-server --endpoint <file>` reads `{address, token}` from the file on start, and again when a call gets 401, so a rotated token is picked up without a restart. It sends `ext.hello` after `initialize`, with the client's `clientInfo.name`.
- **Long waits:** the forwarder's HTTP timeout must allow `wait_for_turn`'s maximum plus a margin.

### Remote and docs

- **`apps/desktop/src/remote/tiers.json`:** rows for `external.status|enable|disable|setTier|rotate` (`never`) and `external.changed` (`drop`). The `ext.*` methods are not in `dispatch`, so they need no row (like `outside.hook`).
- **`docs/ipc-contract.md`:** a "Wave 14: Bitbots MCP" section, and the same in the library copy if one exists. Check `npm run docs:check`.

## Tests (daemon; name them like these)

- `external_tools_need_the_token_and_the_switch`: no token, a wrong token, or the switch off gives 401; the right token with the switch on works.
- `external_enable_requires_confirm_and_rotates_the_token`.
- `external_settings_cannot_be_set_directly`.
- `external_tiers_filter_tools`: a viewer sees no `send_message`; a chat level sees no `create_bot`; a refused call gives `isError`.
- `external_send_message_marks_the_origin`: a fake adapter as in `team_p7_tests.rs`; the stored user message has `origin.kind == "mcp"`.
- `external_wait_for_turn_returns_reply_and_metrics`.
- `external_wait_for_turn_returns_early_on_approval`.
- `external_worktree_send_creates_a_linked_worktree`: a temporary git repo, as the existing worktree tests do.
- `external_results_never_contain_the_token_or_env_values`: a bot with a runtime profile env value; `list_bots` and `get_status` don't contain it.
- Bridge: the `mcp-server` loop answers `initialize`, then `tools/list` through a stub daemon.
- `remoteTiers.parity` (TS) and the Rust tiers parity test both pass.

## Gates you run before reporting

Run them from `D:\wv14`, with `CARGO_TARGET_DIR=D:\wv14\target`:

- `RUST_MIN_STACK=33554432 cargo test -p bloblex-daemon --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`
- `npm run typecheck`
- `npx vitest run apps/desktop/src/remote` (the parity test)

The Director runs the full gates after merging.

## Report

- Files changed, with one line each on why.
- The test names and that they pass.
- Anything in this contract you had to change, and why. Do not change it silently; the UI is built against it.
- What you could not verify.

Also give a proposed update for `.claude/skills/bitbots-development/references/lessons.md` and `codebase-map.md`. Write it in your report, not in the files.
