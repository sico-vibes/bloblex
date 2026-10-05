# Approval modes contract: ask, auto-approve and bypass

User request (2 Oct 2026): Bloblex must offer auto-approve and bypass modes. The invariant "the daemon owns permission decisions" stays true: the daemon is the component that decides to approve automatically, records every automatic decision, and keeps the budgets and the kill switch in force.

## Modes

| Mode | Behaviour | Default |
| --- | --- | --- |
| `ask` | Every permission request waits for the user (today's behaviour). | yes (global default) |
| `auto` | The daemon approves requests classified LOW-RISK (rules below) and asks for everything else. | no |
| `bypass` | The daemon approves everything without asking and, where the provider supports it, launches the provider so it does not ask at all. Intended for trusted, sandboxed or disposable work. | no |

## Scope and resolution

- Global default: settings key `permissions.default_mode`, values `ask` or `auto` ONLY (the global default can never be `bypass`, to limit the blast radius).
- Per-blob override: a new nullable `agents.approval_mode` column (`ask`/`auto`/`bypass`; NULL = inherit the global default), added by migration 4 with the usual verified backup before DDL, a `pragma_table_info` idempotency guard, ledger version 4 and `PRAGMA user_version=4`. `agent.create/update` accept and validate it; the Agent DTO and snapshot carry it as `approvalMode` (nullable) plus a computed `effectiveApprovalMode`.
- `bypass` is only settable per blob and only through the typed field (never through custom args). The UI requires an explicit confirmation (the user types the blob name) and shows the consequences in plain words.
- Effective mode = blob override, else the global default; legacy runtime-only sessions use the global default. The mode is re-evaluated on every permission request and every turn start, so changing it affects new requests immediately. Modes that change provider launch flags (see mapping) take effect at the next turn start, using the same restart/resume mechanism as the Phase 2b launch-scoped options.
- A daemon restart never raises a mode: persisted values are applied as stored; sessions that were running come back with the mode in force.

## Safety rails (non-negotiable)

1. Default is `ask`. Nothing but an explicit user action changes a mode (no migration, discovery, import or provider output may).
2. Everything is audited: each automatically resolved request is persisted as an event `permission.auto_resolved {permissionId, sessionId, turnId, agentId, mode, decision, category, summary}` (summary is a SAFE short description: tool kind and a path or command head, never file contents, env values or instruction text) and also stored with the permission row (`resolved_by = "policy:auto" | "policy:bypass"`). When a provider is launched in a no-prompt bypass mode and the daemon therefore cannot see individual actions, the daemon persists `permission.bypass_active {sessionId, agentId, providerMode}` at every session start and turn start.
3. Budgets still apply: hard limits stop turns; `Pause all agents`, cancel and the tray controls always work and always override the mode.
4. Visible everywhere: a shield badge on the blob row (neutral for `auto`, warning colour for `bypass`), a pill in the chat header, the companion island, and a line in the Blob page; a bypass blob is never shown as ordinary.
5. The mode and the effective provider launch mode are recorded in the Phase 2b execution snapshot (kind `request_shape` or `provider_echo` as available).
6. The classifier fails closed: anything it cannot classify is asked about in `auto`.

## `auto` classifier (daemon-side, conservative v1)

Auto-approve only these categories, evaluated from the normalised permission request (tool kind, normalised paths, command head):
- READ: read-only file tools (read, glob, grep, list, search, notebook read) on paths inside the session's project folder or its git worktree.
- EDIT: edit/write tools whose target path resolves (after normalisation, symlink and `..` resolution) inside the session's project folder, excluding `.git/`, secret-looking files (`.env*`, `*.pem`, `*.key`, credential/token filenames) and files outside the folder.
- SAFE COMMANDS: shell commands whose parsed command head is in a read-only allowlist (`git status|diff|log|show|branch|rev-parse`, `ls`, `dir`, `cat`/`type` of in-folder files, `rg`, `grep`, `find` without `-delete`/`-exec`, `pwd`, `echo`, `node --version` and similar version queries) with no shell operators that chain, redirect to files outside the folder, or pipe into an interpreter.
Everything else (network access, installs, deleting, `git push`/`reset --hard`/`clean`, writing outside the folder, running unknown commands or scripts, process control, MCP tools with side effects) is ASKED. The classifier is a pure function with exhaustive tests; its category names appear in the audit event.

## Provider mapping (the daemon decides; adapters map)

| Provider | `ask` | `auto` | `bypass` |
| --- | --- | --- | --- |
| Claude Code | `--permission-mode default`; daemon answers host `control_request` messages over stream-json | the daemon answers permission requests per the classifier | launch with the provider's no-prompt mode (`--permission-mode bypassPermissions`; if the installed CLI additionally requires `--allow-dangerously-skip-permissions`, add it) and record `permission.bypass_active`; verify the exact flags against `claude --help` of the installed version before relying on them and record the verification in docs/runtime-capabilities.md |
| Codex | `approvalPolicy:"on-request"` with `sandbox:"workspace-write"` (unchanged) | same launch; the daemon answers approval requests per the classifier | `thread/start` with `approvalPolicy:"never"` and `sandbox:"danger-full-access"` (the sandbox must widen or the agent is stuck inside it); record `permission.bypass_active` |
| OpenCode (ACP) | unchanged | the daemon answers `session/request_permission` per the classifier | the daemon answers every request with the allow option and audits each one (no provider flag needed) |

Adapters keep the typed-field rule: modes are never exposed as free-form arguments, and the custom-argument allowlists stay empty.

## RPC, events, UI

- `agent.create/update`: `approvalMode` (nullable). New RPC `permissions.policy.get` returns `{defaultMode, perAgent:[{agentId, mode, effectiveMode}]}`; `settings.set` of `permissions.default_mode` validates `ask|auto` and emits the existing settings audit event. Events: `permission.auto_resolved`, `permission.bypass_active`, plus `agent.changed` for mode changes.
- UI: Blob page Settings "Permissions" card (mode selector with plain-language descriptions, the typed confirmation for `bypass`), Settings > Permissions page (global default ask/auto; list of blobs not in `ask`; link to each), badges as above, and an "Auto-approved actions" list in the Activity/Errors surfaces (read-only, newest first, with the safe summaries and category).
- Tests: classifier (every category, every refusal, path traversal and symlink cases, shell operator cases), resolution order, bypass-only-per-blob validation, audit events for every automatic decision, fail-closed unknowns, mode change effect on the next request/turn, adapter mapping with fake peers (flags/JSON-RPC fields), UI confirmation flow and badges.
