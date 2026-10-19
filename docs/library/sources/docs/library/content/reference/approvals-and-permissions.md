# Approvals and permissions

> **What this is:** the three modes, who decides, exactly what auto approves, how each provider is launched, and what is recorded.
> **Status:** current; the approval-mode contract of 15 October 2026 and the daemon code, checked on 19 October 2026
> **Last updated:** 2026-10-19

## Purpose

The daemon owns permission decisions, but the default is that a person decides. Three modes change how often the daemon answers on the owner's behalf, and every automatic decision is recorded so it can be reviewed.

The mode never raises itself. A migration, discovery, an import or provider output cannot turn a bot to bypass. Only an explicit user action changes a mode, and the global default cannot be bypass.

## The modes

| Mode | Who decides | Where it can be set | Default |
| --- | --- | --- | --- |
| `ask` | The owner, for every request. | Global default, per bot, per conversation (pin). | Yes |
| `auto` | The daemon approves LOW-RISK actions; the owner answers the rest. | Global default, per bot, per conversation (pin). | No |
| `bypass` | The daemon approves everything, and the provider may be launched in its own no-prompt mode. | The bot editor with a typed confirmation, or an explicit conversation pin. The UI calls it **Full access**. The global default cannot be bypass. | No |

The global key is `permissions.default_mode` and accepts only `ask` or `auto` (`crates/bloblex-daemon/src/main.rs:1368`). A per-bot `approvalMode` is `ask`, `auto`, `bypass` or null (inherit). A conversation can pin `ask`, `auto`, `bypass` or null; null removes the pin (`set_session_permissions`, `crates/bloblex-daemon/src/main.rs:2720-2728`).

Effective mode = conversation pin, else bot override, else global default (`crates/bloblex-daemon/src/main.rs:1459-1466`). It is re-evaluated on every permission request and every turn start, so a change affects new requests immediately. A mode that changes provider launch flags takes effect at the next turn start, through the adapter's restart or resume path.

## Who may change what

| Action | Result |
| --- | --- |
| Change the global default | Settings › Agents; only ask or auto. Emits `settings.changed {key, mode}`. |
| Change a bot's mode | The bot editor; bypass needs the bot's typed name. |
| Pin a conversation | The composer's permission control; a locked bot refuses it. |
| A locked bot | Every permission write is refused. Unlock first. |
| An automation run | Always plan or auto, whatever the bot says. |
| A remote device | Operator tier may answer a request, only with approvals from remote on. It may not change a mode. |

The older approval-mode contract says bypass is "only settable per blob" (`docs/reference/approval-modes.md`, modes). The daemon's `set_session_permissions` accepts a conversation pin of `bypass` as well (`crates/bloblex-daemon/src/main.rs:2725-2729`); the code is authoritative here, and the interface still requires an explicit choice.

## The auto classifier

`auto` is conservative. It approves only:

- **READ:** read-only file tools (read, glob, grep, list, search, notebook read) on paths inside the session's project folder or its git worktree.
- **EDIT:** edit or write tools whose target resolves, after normalisation including symlinks and `..`, inside the project folder, excluding `.git/`, secret-looking files (`.env*`, `*.pem`, `*.key`, credential or token filenames) and anything outside the folder.
- **SAFE COMMANDS:** shell commands whose parsed command head is on a read-only allowlist (`git status|diff|log|show|branch|rev-parse`, `ls`, `dir`, reading an in-folder file, `rg`, `grep`, `find` without `-delete` or `-exec`, `pwd`, `echo`, version queries), with no chaining, no redirect outside the folder and no pipe into an interpreter.

Everything else asks: network access, installs, deletion, `git push`, `reset --hard`, `clean`, writes outside the folder, unknown commands or scripts, process control, and MCP tools with side effects.

The classifier is a pure function with exhaustive tests. It fails closed: anything it cannot classify is asked. Its category names appear in the audit event.

## Provider mapping

| Provider | `ask` | `auto` | `bypass` |
| --- | --- | --- | --- |
| Claude Code | `--permission-mode default`; the daemon answers host `control_request` messages. | Same launch; the daemon answers per the classifier. | `--permission-mode bypassPermissions` and, if the installed CLI requires it, `--allow-dangerously-skip-permissions`; record `permission.bypass_active`. |
| Codex | `approvalPolicy: "on-request"` with `sandbox: "workspace-write"`. | Same launch; the daemon answers approval requests per the classifier. | `approvalPolicy: "never"` with `sandbox: "danger-full-access"`; record `permission.bypass_active`. |
| OpenCode (ACP) | The provider's own prompt, answered through ACP. | The daemon answers `session/request_permission` per the classifier. | The daemon answers every request with the allow option and audits each one; no provider flag. |

The adapter keeps modes as typed fields. Free-form custom arguments are never a route to a mode; the custom-argument allowlists are empty.

A mode that requires a launch flag is applied on the next turn, using the adapter's restart or resume path. A daemon restart never raises a mode: the persisted value is applied as stored.

![The approval flow, from request to audit](../../assets/diagrams/approval-flow.svg)

*A permission request is normalised by the adapter, decided by the daemon's policy, answered to the provider and recorded.*

## What is recorded

- **Every resolved request:** the permission row keeps the decision and `resolved_by` (`policy:auto`, `policy:bypass`, or the user).
- **Every automatic decision:** `permission.auto_resolved {permissionId, sessionId, turnId, agentId, mode, decision, category, summary}`. The summary is safe: a tool kind and a command head or path, never file contents, environment values or instruction text.
- **Every bypass launch:** `permission.bypass_active {sessionId, agentId, providerMode}` at every session start and turn start where the provider runs without prompts. This is how an action the daemon could not see is still accounted for.
- **Automation denials:** `permission.auto_denied {permissionId, sessionId, automationId, runId, category, summary}` and `resolvedBy: "policy:automation"`.
- **Execution evidence:** the mode, and the provider launch mode where known, in the execution snapshot.

The tray controls, **Pause all agents**, cancel and daemon shutdown always override any mode.

## What the interface shows

- A shield badge on the bot row: neutral for auto, warning colour for bypass.
- A permission pill in the conversation header.
- A badge in the companion.
- A line on the bot page.
- A read-only "Auto-approved actions" list in the activity surfaces, newest first, with the safe summaries.

A bypass bot is never shown as ordinary.

## RPC and events

- `permissions.policy.get` returns `{defaultMode, perAgent:[{agentId, mode, effectiveMode}]}`.
- `permission.reply {permissionId, choice}` sends an opaque provider-supported choice. The adapter must acknowledge it before Bitbots marks the request resolved.
- `session.permissions.set` pins a conversation; `null` removes the pin and follows the bot again.
- `agent.create/update` accept `approvalMode`, with null meaning inherit.
- `settings.set` of `permissions.default_mode` validates ask or auto and emits `settings.changed` only on a real change.

## Gotchas

- **Auto is not "trust the model".** It is a small allowlist inside the project. Anything unknown asks.
- **Bypass is not a global switch.** The global default cannot be bypass. A bot or a conversation can choose it explicitly, and an automation can never use it.
- **A provider in its own no-prompt mode hides individual actions.** That is why `permission.bypass_active` is recorded at every start.
- **A locked bot is not a permission decision.** The lock refuses configuration writes; it does not change the mode.
- **An automation can never bypass.** Its mode is clamped to plan or auto; an unapproved request is denied.
