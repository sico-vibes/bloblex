# Brief: the Bitbots MCP edits bots (`update_bot`) and may grant Full access

Owner request, 30 October 2026: "the MCP should allow editing everything, so we need to add that". Today an outside session can create a bot (`create_bot`, Operator level, approval mode `ask` or `auto` only) but cannot change one, so the Director could not move the backend bot Sona from Auto to Full access and the owner had to do it by hand.

Lane: backend (Claude Sonnet 5.5, medium), in its own worktree. The Director builds the Settings › Connections switch and copy against this contract at the same time. Never run `git commit`, `git push`, `git merge` or switch branches.

## Decision

- A new Operator tool, `update_bot`, edits a bot's settings: everything the bot editor in the app can change, except the items under "Stays with the owner".
- **Full access (`bypass`) is behind the owner's own switch.** A new setting, `mcp.external.allowFullAccess` (default `false`), set only from the desktop through a capability RPC. While it is off, `update_bot` and `create_bot` refuse `approvalMode: "bypass"`; while it is on, both accept it. Turning the MCP off (`external.disable`) turns the switch off too, so it never survives a reconnect the owner did not choose again.
- **Stays with the owner** (refused by `update_bot`): `customArgs`, `customEnv` (they run arbitrary flags and hold secrets), locking or unlocking (`locked`), `systemRole`/`leader`, deleting, archiving and purging. A locked bot refuses every change, as `agent.update` already does.

## Contract

### Capability RPC (desktop only, never remote, never on the `ext.*` route)

- `external.setFullAccess {allow: bool, confirm?: bool}`
  - `allow: true` needs `confirm: true`, else `invalid_argument` "Confirm letting outside sessions give bots Full access first."
  - Needs the MCP on, else `conflict` "Turn the Bitbots MCP on first." (as `external.setTier`).
  - Stores the setting, emits `external.changed`, returns the status.
- `external.status` (and the `external.changed` payload) gains `allowFullAccess: bool` (false when the MCP is off).
- `external.disable` also stores `allowFullAccess = false`.
- `apps/desktop/src/remote/tiers.json`: a `never` row for `external.setFullAccess`, worded like the other `external.*` rows. The parity test must pass.

### Tool `update_bot` (Operator)

Description: "Changes a bot's settings. Pass only what changes. Use list_runtimes for runtimes, models and efforts. A locked bot can't be changed." Input schema (`additionalProperties: false`), all optional except `botId`:

| Field | Type | Maps to |
|---|---|---|
| `botId` | string, required | the bot |
| `name` | string, up to 60 characters | `agent.update name` |
| `role` | string, up to 40 characters; `""` clears it | `agent.team.update role` |
| `description` | string | `agent.update description` |
| `instructions` | string, up to 20,000 characters | `agent.update instructions` |
| `color` | string | `agent.update color` (same validation as the app) |
| `runtimeId` | string | `agent.update runtimeId` |
| `model` | string | `agent.update model` |
| `effort` | string | `agent.update thinking` |
| `serviceTier` | string or null | `agent.update serviceTier` |
| `approvalMode` | `ask`, `auto`, and `bypass` only while the switch is on | `agent.update approvalMode` |
| `projectPath` | string folder, or null for no default project | `agent.team.update projectId` (find or create the project for that folder, exactly as `create_bot` does; refuse a folder that does not exist; the Manager's existing refusal stands) |
| `tags` | array of strings | `agent.team.update tags` (same limits as the app) |
| `hidden` | bool | `agent.team.update hidden` |
| `notificationLevel` | string or null | `agent.update notificationLevel` |

Rules:
- The schema the tool list shows offers `bypass` in the `approvalMode` enum only while the switch is on, and the description then says "bypass is Full access: the bot acts without asking." Do the same for `create_bot` (its enum today is `ask`, `auto`).
- Validate before writing anything: unknown keys (anything not in the table, including `customArgs`, `customEnv`, `locked`, `systemRole`, `leader`, `archived`) are refused with one message that names them, e.g. "update_bot can't change customEnv; that stays with the owner in Bitbots." A missing bot: "That bot was not found." Nothing to change: "Pass at least one setting to change."
- `bypass` while the switch is off: "Full access needs the owner's switch in Bitbots › Settings › Connections." Nothing is written.
- Run `agent.update` (through `dispatch`, so model/effort validation, catalog normalisation, the lock check and `agent.changed` all apply) first, then `agent.team.update` for the team fields. If the first call fails, nothing else is written.
- Returns the bot as `list_bots` shows it (`bot_view`).
- `call_tool` records it like the other tools (`record`).

## Tests (in `crates/bloblex-daemon/src/external_tests.rs`, plus a tiers parity pass)

- `update_bot_changes_name_model_effort_and_role`
- `update_bot_sets_and_clears_the_default_project_by_folder`
- `update_bot_refuses_bypass_until_the_owner_allows_full_access`, which covers refusal, writing nothing, then success after `external.setFullAccess`.
- `create_bot_accepts_bypass_only_while_full_access_is_allowed`
- `set_full_access_needs_confirm_and_the_mcp_on`
- `disabling_the_mcp_turns_full_access_off`
- `tool_list_offers_bypass_only_while_allowed` (both tools' enums)
- `update_bot_refuses_owner_only_fields_and_a_locked_bot`
- `update_bot_needs_the_operator_level`, which refuses viewer and chat and keeps the tool out of their lists.
- `status_reports_allow_full_access`

## Gates

From the worktree:

- `RUST_MIN_STACK=33554432 cargo test -p bloblex-daemon --no-fail-fast` (run from PowerShell; loopback HTTP from the Bash tool is reset on this machine);
- `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`.

The Director runs the full gates after merging.

## Report

- Files changed.
- The final tool schemas.
- Every test name and the gate output tails.
- Anything in this contract you had to change, and why.
