# Bitbots daemon IPC contract (v1)

> **What this is:** The daemon IPC contract (v1): methods, events, and the rules for the capability and the local listeners.
> **Status:** current
> **Last updated:** 2026-10-18

## Update commands

The desktop updater commands and events are defined in [docs/operations/updater.md](operations/updater.md). They run in the Tauri shell and persist preferences through the daemon settings store; they are separate from the daemon's v1 IPC methods below.

This is the integration contract between `bitbotsd.exe` and the desktop shell. The daemon is authoritative; UI state is reconstructed from `app.snapshot` and subsequent ordered events.

The desktop shell also exposes local Tauri commands for user-selected file flows. Native save/open dialogs retain their selected paths in process-local state and return only opaque single-use selection tokens to the webview. `write_selected_export_text` consumes a save token to write UTF-8 text, and `read_blob_import` consumes an open token to read UTF-8 JSON with a 64 KiB limit. A webview-supplied path is never accepted by these commands, and they do not access the daemon database.

This document includes intended contract requirements, not a statement that every guarantee is already implemented or independently tested. See [implementation status](operations/implementation-status.md) for open acceptance work. Snapshot/event atomicity, complete permission lifecycle, financial aggregation and process-tree cleanup remain under review.

## Transport and startup

The desktop shell owns the daemon child process and starts it for the signed-in Windows user. The daemon binds an ephemeral TCP port on `127.0.0.1` only. It must never bind `0.0.0.0`, a LAN interface, or IPv6 wildcard. On startup, the daemon writes one bootstrap JSON object to stdout before any logs:

```json
{"type":"bloblexd.ready","protocolVersion":1,"address":"127.0.0.1:49152","capability":"<random-256-bit-secret>"}
```

The capability exists only in daemon memory and the desktop shell's child-process channel; do not persist or log it. The shell keeps it in the native Tauri process and proxies renderer calls through Tauri commands. A connecting client must send it in `Authorization: Bearer <capability>`. Reject requests without a valid capability using a constant-time comparison. CORS is disabled. Only loopback peers are accepted. If another UI client is needed, it must receive the secret through the same authenticated native shell path.

**Remote mode (implemented in beta.30; Native added after it).** Remote adds one more listener and leaves the one above unchanged. While Remote is on, the daemon runs a second listener on `127.0.0.1:<remote.port>` (default 48620), published on the owner's tailnet with `tailscale serve --bg --https=443` (fallback 8443). It never binds a non-loopback address, never uses Tailscale Funnel and never runs `tailscale serve reset`. It calls `dispatch()` in-process and never reads, accepts or returns the capability. Its clients are paired devices authenticated by a cookie, not by the capability. The routes, pairing and policy are in [remote/PROTOCOL.md](remote/PROTOCOL.md). This exception needs the owner-approved AGENTS.md amendment ([remote/AGENTS_AMENDMENT_DRAFT.md](remote/AGENTS_AMENDMENT_DRAFT.md)). **Native (17 October 2026, owner amendment).** A second method, one at a time: while Native is on, the gateway's own listener binds the host's interfaces on `remote.nativePort` (default 48621) with TLS only, password sign-in plus the owner's approval per device, and abuse limits. It is the only non-loopback listener and never runs while Native is off; the daemon API below is unchanged. Details in [remote/PROTOCOL.md §13](remote/PROTOCOL.md).

HTTP transport uses WebSocket upgrade at `/v1/events` for push events and JSON over `POST /v1/rpc` for request/response. Immediately after upgrading, the shell sends `{"v":1,"afterSequence":<snapshot.sequence>}`. The daemon registers the live subscription before reading/replaying persisted events after that cursor; clients discard duplicate sequences. This closes the snapshot/subscribe race. On `replayAvailable:false`, fetch a fresh snapshot. Every response and event carries protocol version 1.

## Envelope

Requests:

```json
{"v":1,"id":"req_01","method":"app.snapshot","params":{}}
```

Responses:

```json
{"v":1,"id":"req_01","ok":true,"result":{"snapshotVersion":1,"sequence":0,"daemon":{"state":"ready"},"hosts":[],"runtimes":[],"agents":[],"sessions":[],"permissions":[],"usage":[],"budgets":[]}}
```

Errors:

```json
{"v":1,"id":"req_01","ok":false,"error":{"code":"invalid_argument","message":"The project path does not exist."}}
```

Events:

```json
{"v":1,"eventId":"evt_01","sequence":1,"timestamp":"2026-10-01T00:00:00Z","type":"runtime.changed","payload":{}}
```

`id` is an opaque string unique to the client request. Event `sequence` is daemon-global, monotonically increasing and persisted. Unknown fields and event types must be ignored by clients. No raw provider JSON appears in the UI contract.

## Methods

| Method | Params | Result / behavior |
|---|---|---|
| `app.snapshot` | `{}` | Complete authoritative state and latest global `sequence`. |
| `events.replay` | `{ "afterSequence": number }` | Ordered retained events after the cursor; returns `replayAvailable:false` if retention no longer covers the gap, then client refreshes snapshot. |
| `daemon.health` | `{}` | Daemon version, uptime, state and heartbeat timestamp. |
| `daemon.shutdown` | `{}` | Gracefully stops managed adapters and exits after replying; child-process termination is a fallback. |
| `runtime.list` | `{}` | Discovered runtimes, host, protocol, absolute executable, version, aggregate auth state, per-gateway `gatewayAuthStates`, `displayName`, and capabilities. Provider display names are `Claude Code`, `Codex`, and `OpenCode`. |
| `runtime.refresh` | `{}` | Rescan native Windows and configured WSL hosts; returns current runtime list. |
| `runtime.profile.list` | `{}` | Saved runtime profiles. |
| `runtime.profile.save` | `{ "profile": RuntimeProfile }` | Save a direct executable + parsed args profile after path validation. |
| `runtime.profile.delete` | `{ "profileId": string }` | Delete a saved profile. |
| `settings.get` | `{}` | Non-secret local preferences. |
| `settings.set` | `{ "key": string, "value": any }` | Persist a preference; credential fields are rejected. `exec_gate.*`, `notifications.enabled`, `experimental.autoRetry`, `experimental.memory`, and `memory.sharedAgentWrites` values must be JSON booleans; `retry.maxWaitSecs` must be an integer from 0 to 86400; `profile.about` must be a string of at most 1500 characters, is stored trimmed, and is rejected if it carries credential markers or injection-looking text. |
| `runtime.capabilities` | `{ "runtimeId": string, "agentId"?: string }` | `{runtimeId,settings,globalConcurrency,agentConcurrency,agentConcurrencies,hostDependent}`; reports static provider support separately from the persisted `exec_gate.*` switch. Unsupported settings are disabled. |
| `runtime.models` | `{ "runtimeId": string, "refresh"?: boolean }` | `{runtimeId,provider,displayName,models,fetchedAt,expiresAt,fallback,source,validated}`; `source` is `live_query`, `cli_list`, `config_options`, or `fallback`; `validated` is true only when the live source is authoritative for model-id validation. Other settings are checked only when their model row has supporting values, such as non-empty per-model `supportedThinking`. Model rows include `id`, `displayName`, optional `providerId`, supported/default thinking, service tiers/default, optional variants, `hostDependent`, and the additive presentation fields `isDefault`, `group`, and `availability`. Cached per runtime/profile for 60 seconds; `refresh:true` bypasses cache. Fallback and other unvalidated catalogs are suggestions and do not validate execution. |
| `exec.snapshot.get` | `{ "snapshotId": string }` | Snapshot object; `not_found` when the snapshot does not exist. |
| `exec.snapshot.list` | `{ "sessionId": string, "after"?: string, "limit"?: integer }` | `{snapshots,next}`; `after` is an exclusive snapshot ID cursor and limit defaults to 50 (maximum 200). |
| `exec.snapshot.latest` | `{ "sessionId": string }` | Snapshot object or `null` when the session has no turns. |
| `session.list` | `{ "includeArchived"?: boolean }` | Persisted sessions, excluding archived conversations by default. |
| `session.get` | `{ "sessionId": string }` | Session with ordered turns, messages, tool cards and file changes. |
| `session.rename` | `{ "sessionId": string, "title": string }` | Trim and persist a title of 1 to 120 characters; emits `session.changed`. |
| `session.archive` | `{ "sessionId": string, "archived": boolean }` | Hide or restore a conversation; emits `session.changed`. Archived conversations appear only with `includeArchived:true`. |
| `session.delete` | `{ "sessionId": string }` | Permanently removes Bitbots' session record and stored child data. Refuses sessions that are starting, working, cancelling, or waiting for approval. It does not modify the coding agent's own history; emits `session.deleted`. |
| `session.new` | `{ "agentId"?: string, "runtimeId"?: string, "projectPath": string, "title"?: string }` | Exactly one of `agentId` or `runtimeId` is required. Agent selection derives its runtime; legacy runtime-only creation leaves `agentId:null`. |
| `agent.list` | `{ "includeArchived"?: boolean, "runtimeId"?: string }` | `{ "agents": Agent[] }`; active agents by default, ordered by runtime and sort position. |
| `agent.get` | `{ "agentId": string }` | `{ "agent": Agent }`; returns active or archived agent. |
| `agent.create` | `{ "name": string, "runtimeId": string, "description"?: string, "instructions"?: string, "color"?: string, "outfit"?: Outfit, "model"?: string|null, "thinking"?: string|null, "serviceTier"?: string|null, "approvalMode"?: "ask"|"auto"|"bypass"|null, "customArgs"?: string[], "customEnv"?: object, "maxConcurrency"?: integer, "defaultProject"?: string|null }` | `{ "agent": Agent }`; appends an active agent for the runtime. Outfit is `auto`, `none`, `party-hat`, `beanie`, `crown`, `sunglasses`, `round-glasses`, `bow`, `scarf`, `witch-hat`, or `santa-hat`; omitted outfit defaults to `auto`. |
| `agent.update` | `{ "agentId": string, "name"?: string, "runtimeId"?: string, "description"?: string, "instructions"?: string, "color"?: string, "outfit"?: Outfit, "model"?: string|null, "thinking"?: string|null, "serviceTier"?: string|null, "approvalMode"?: "ask"|"auto"|"bypass"|null, "customArgs"?: string[], "customEnv"?: object, "maxConcurrency"?: integer, "defaultProject"?: string|null }` | `{ "agent": Agent }`; omitted fields remain unchanged, explicit nullable fields clear their values, and archived agents cannot be edited. |
| `permissions.policy.get` | `{}` | `{ "defaultMode": "ask"|"auto", "perAgent": [{"agentId": string, "mode": "ask"|"auto"|"bypass"|null, "effectiveMode": "ask"|"auto"|"bypass"}] }`. |
| `agent.purge` | `{ "agentId": string, "confirm": true }` | Permanently remove a non-Manager, unlocked bot and all owned or peer side-conversations in one transaction. Refuses active work without deleting anything. Removes its automations, private memory and associated history; preserves unrelated bots, project files and provider-owned history. Local-only; the remote gateway refuses it. |
| `agent.delete` | `{ "agentId": string }` | `{ "agent": Agent }`; soft archives the agent and compacts active order. |
| `agent.reorder` | `{ "runtimeId": string, "agentIds": string[] }` | `{ "agents": Agent[] }`; replaces the full active order for the runtime. |
| `session.resume` | `{ "sessionId": string }` | Resumes only when the adapter advertises support; otherwise returns `unsupported`. |
| `session.prompt` | `{ "sessionId": string, "text": string }` | Starts a turn after daemon/session concurrency admission (`create_reserved_turn`, `crates/bloblex-storage/src/lib.rs:2561`; `crates/bloblex-daemon/src/main.rs:2413`). Budget admission is retired (AGENTS.md, 12 October 2026 amendment). Prompt body is sent over authenticated IPC/protocol, never argv. |
| `session.queue.add` | `{ "sessionId": string, "text": string, "attachments"?: [{ "path": string, "name"?: string }], "conversationRefs"?: string[], "replyTo"?: object, "dueAt"?: string }` | Stores a prompt for later; `dueAt` (RFC3339, 5 seconds to 366 days out) makes it a scheduled item. Validates the body like `session.prompt`; capped at 20 queued items per session (`conflict`, "The queue is full."). Returns `{item}` and emits `queue.changed`. |
| `session.queue.list` | `{ "sessionId": string }` | `{items:[Item], paused:boolean}`; scheduled items order first by `dueAt`, then plain items by `position`. |
| `session.queue.update` | `{ "sessionId": string, "id": string, "text"?: string, "dueAt"?: string\|null }` | Edits a still-queued item; `dueAt:null` converts a scheduled item to a plain one. Non-queued items return `conflict`. |
| `session.queue.reorder` | `{ "sessionId": string, "ids": string[] }` | `ids` must be exactly the session's queued plain items, otherwise `invalid_argument`. |
| `session.queue.delete` | `{ "sessionId": string, "id": string }` | Removes a `queued` or `failed` item; otherwise `conflict`. |
| `session.queue.send_now` | `{ "sessionId": string, "id": string }` | On an idle session sends the item now; on a busy session moves it to the front and returns `{queued:true}` without steering or interrupting. |
| `session.queue.resume` | `{ "sessionId": string }` | Clears `paused` and, if idle, drains the next item. |
| `turn.retry.cancel` | `{ "sessionId": string }` | Removes the session's pending automatic-retry item and appends a "Automatic retry cancelled." notice; returns `not_found` when nothing is pending. |
| `automation.create` | `{ "agentId": string, "name": string, "prompt": string, "schedule": {"kind":"cron","cron":string,"timezone":string} \| {"kind":"once","at":string}, "sessionMode"?: "new"\|"reuse", "approvalMode"?: "plan"\|"auto", "maxRuntimeSecs"?: integer, "enabled"?: boolean }` | Creates a scheduled automation, disabled unless `enabled:true`. Name 1–80 chars; prompt 1–8000 bytes; timezone a valid IANA name; cron 5-field; `once` at least 60 s and at most 366 days ahead; `maxRuntimeSecs` 60–14400; `approvalMode` only `plan` or `auto` (`bypass` and `ask` are `invalid_argument`); at most 50 automations per daemon. Returns `{automation}` and emits `automation.changed`. |
| `automation.list` | `{ "agentId"?: string }` | `{automations: Automation[]}`. |
| `automation.get` | `{ "id": string }` | `{automation}`; `not_found` when missing. |
| `automation.update` | `{ "id": string, ...same fields as create }` | Updates the automation and recomputes `nextRunAt`. Returns `{automation}` and emits `automation.changed`. |
| `automation.pause` | `{ "id": string }` | Disables it with `pauseReason:"user"`; returns `{automation}` and emits `automation.changed`. |
| `automation.resume` | `{ "id": string }` | Clears `consecutiveFailures` and `pauseReason`, re-enables it and recomputes `nextRunAt`; returns `{automation}` and emits `automation.changed`. |
| `automation.delete` | `{ "id": string }` | Deletes the automation but keeps its run history and run sessions; emits `automation.deleted`. |
| `automation.run_now` | `{ "id": string }` | Starts a run immediately with `scheduledFor = now`; does not change `nextRunAt`; `conflict` if one is running or automations are globally paused. Returns `{run}`. |
| `automation.runs` | `{ "id": string, "limit"?: integer, "before"?: string }` | `{runs: Run[]}` newest first; limit defaults to 20 (maximum 100), `before` is an exclusive run-id cursor. |
| `automation.preview` | `{ "schedule": Schedule, "count"?: integer }` | `{utc: string[], local: string[]}` — the next occurrences (default 3, maximum 10) in UTC and in the schedule's zone. DST gaps are skipped and fall-back overlaps fire once. |
| `automation.changed` / `automation.deleted` / `automation.run.changed` / `automation.run.finished` | — | Events; see "Scheduled automations" below. |
| `permission.auto_denied` | — | Event emitted when an unattended automation-run permission is auto-denied; see below. |
| `memory.list` | `{ "scope"?: "blob"\|"project"\|"shared", "scopeId"?: string, "status"?: "all"\|"unreviewed", "query"?: string, "includeDeleted"?: boolean, "limit"?: integer }` | `{records: Memory[]}` newest-updated first with pinned first. `query` uses the FTS index; `status:"unreviewed"` shows agent records awaiting approval; `includeDeleted` also returns soft-deleted records. Limit defaults to 100 (maximum 200). |
| `memory.get` | `{ "id": string }` | `{record}`; returns the record even if soft-deleted or unreviewed (for review); `not_found` when missing. |
| `memory.create` | `{ "scope": "blob"\|"project"\|"shared", "scopeId"?: string, "kind": "fact"\|"preference"\|"decision"\|"procedure"\|"reference", "title": string, "body": string, "tags"?: string[], "importance"?: integer, "pinned"?: boolean }` | Creates a user record (`origin:"user"`, `reviewed:1`). Title 1–120 chars, body 1–2000 chars, at most 8 tags of at most 32 chars each, importance 0–100. `blob` requires an existing agent `scopeId`, `project` an existing project `scopeId`, `shared` no `scopeId`. Caps: 300 live records per scope id and 1000 overall. Returns `{record}` and emits `memory.changed`. |
| `memory.update` | `{ "id": string, "expectedVersion": integer, "title"?: string, "body"?: string, "kind"?: string, "tags"?: string[], "importance"?: integer, "pinned"?: boolean }` | Optimistic edit; every accepted update increments `version` and appends a version row (the ten newest are kept). Returns `{record}` and emits `memory.changed`; a version mismatch is `conflict` naming the current version. |
| `memory.approve` | `{ "id": string }` | Marks an agent-written record `reviewed:1` without changing its version; returns `{record}` and emits `memory.changed`. |
| `memory.delete` | `{ "id": string }` | Soft delete; the record leaves `memory.list` and the FTS index but its version history remains. Optional `expectedVersion` makes it optimistic. Emits `memory.deleted {id}`. |
| `memory.restore` | `{ "id": string }` | Clears `deletedAt`, re-indexes the record, and returns `{record}`; emits `memory.changed`. |
| `session.cancel` | `{ "sessionId": string, "turnId"?: string }` | Requests provider cancellation and reports whether the provider supports it. |
| `session.close` | `{ "sessionId": string }` | Closes managed adapter process; persisted session remains. |
| `permission.reply` | `{ "permissionId": string, "choice": string }` | Choice is an opaque provider-supported option ID from that request; the provider adapter must receive and acknowledge it before Bitbots marks it resolved. |
| `usage.summary` | `{ "from": string, "to": string, "scope"?: object }` | Raw token totals and separate known/unknown valuations; subscription fees are not API estimates. |
| `usage.analytics` | `{ "from": string, "to": string, "bucket": "day"|"week", "tz": string, "projectPath"?: string, "agentId"?: string }` | Returns `UsageAnalytics` as defined in `docs/reference/phase-5-analytics-contract.md`; invalid range, bucket, or timezone is `invalid_argument`, unknown agent is `not_found`. |
| `pricing.list` | `{ "provider"?: string }` | **Retired:** returns `unsupported` (`crates/bloblex-daemon/src/main.rs:1085`). The description below is historical. User overrides and exact-decimal official price-list rows (`inputPerMillion`, `outputPerMillion`, cache rates, currency, `sourceUrl`, `checkedAt`, optional tiers/notes), with source `user_override` or `official_price_list`; effective rows include `effectiveFields` with rate, currency, source and checked date for each rate field, so partial overrides retain lower-priority values and provenance. Legacy shipped database rates are omitted. Usage & limits separately combines current runtime catalogs as `opencode_catalog_estimate`. Models without an applicable override, official row, or catalog rate remain unpriced. |
| `pricing.override` | `{ "rule": PricingRule }` | Save user pricing with exact non-negative decimal strings per million tokens (up to twelve fractional digits) or `null` for unknown buckets. Blank buckets inherit the official or cached catalog rate when available. IDs, provider, model, currency and RFC3339 `effectiveFrom` are validated. `{ "rule": { "id": string, "remove": true } }` removes that override. |
| `subscription.list` | `{}` | **Retired:** returns `unsupported` (`crates/bloblex-daemon/src/main.rs:1085`); historical description follows. User-entered plan fees, separated from token estimates and quota (`unknown` unless measured). |
| `subscription.save` | `{ "plan": SubscriptionPlan }` | Save provider, currency, fixed monthly amount and renewal day. |
| `budget.list` | `{}` | **Retired:** `budget.list`, `budget.set` and `budget.delete` return `unsupported` (`crates/bloblex-daemon/src/main.rs:992`; AGENTS.md, 12 October 2026 amendment). The rows below are historical. `{ "policies": Budget[] }` with active reservations where available. `Budget.scopeType` supports `global`, `host`, `runtime`, `agent`, `blob`, `session`, and `project`; `blob` policies use a blob ID as `scopeId`. |
| `budget.set` | `{ "id": string, "scopeType": "global"|"host"|"runtime"|"agent"|"blob"|"session"|"project", "scopeId"?: string|null, "period": string, "metric": string, "hardLimit": number, ... }` | Persists a policy; most restrictive applicable hard cap wins. `blob` requires an active blob ID in `scopeId` and matches sessions whose `agentId` equals that ID. Existing `agent` scope retains its provider-ID behavior. Reusing an ID for a different scope, target, period, or metric clears its old reservations atomically. |
| `budget.delete` | `{ "policyId": string }` | Removes that policy and its reservations atomically. Blob-scoped policies are also removed atomically when their blob is archived/deleted with `agent.delete`. |
| `agent.lock.set` | `{ "agentId": string, "locked": boolean }` | `{ "agent": Agent }`. Locks or unlocks a bot (FIX39). The Manager cannot be locked. Which writes a lock refuses is listed under "FIX39 additions" below. Never remote. |
| `session.permissions.set` | `{ "sessionId": string, "approvalMode": "ask"\|"auto"\|"bypass"\|null }` | Session summary. Pins one conversation's permission mode from its next turn, also while a turn runs. `null` removes the pin so the conversation follows its bot again; with no pin it writes nothing. Refuses automation sessions and locked bots. Never remote. |
| `diagnostics.preview` | `{}` | `{ generatedAt, fileName, files: [{ name, sizeBytes }] }`: what the export zip holds. Never remote. |
| `diagnostics.export` | `{}` | `{ fileName, sizeBytes, uncompressedBytes, files, base64 }`: the zip, base64-encoded over loopback RPC. The shell writes it through the native save dialog with its own commands; no path from the webview is used. Never remote. |
| `skills.forAgent` | `{ "agentId": string }` | `{ "skills": [{ name, description, source }] }`: the shared skills switched on for one bot. Added in FIX37 (beta.32) and listed here for the first time. `invalid_argument` without `agentId`. |

### RPC methods dispatched but not in the table above

These names are dispatched in `crates/bloblex-daemon/src/main.rs` (dispatch match at lines 619-1090) and have no row in the table. This list was checked against the code on 14 October 2026. Parameters and behavior are not described here; read the handler before relying on them.

- Teams and projects: `project.list`, `project.create`, `project.update`, `project.delete`, `agent.team.update`, `agent.conversation` (handled by `crates/bloblex-daemon/src/team.rs`).
- Blob lifecycle: `agent.restore`.
- Sessions: `session.steer`, `session.handoff.draft`, `session.delete.schedule`, `session.delete.cancel`.
- Messages and files: `message.reaction.toggle`, `search.messages`, `file.revert`.
- Quota: `quota.list`, `quota.refresh`.
- Hooks: `hook.event`.

### Remote mode methods (design, not implemented)

The `remote.*` family is served on the daemon's own loopback API for the desktop shell only. Every `remote.*` method is `never` remote in `remote/tiers.json`, so a paired device cannot call it. Shapes follow `apps/desktop/src/remote/remoteContract.ts`; the backend spec (`docs/FIX29_REMOTE_TAILSCALE_SPEC.md`, to be written) is authoritative for exact fields.

| Method | Params | Result / behavior |
|---|---|---|
| `remote.status` | `{}` | `{enabled,link,url,port,servePort,tailscale,hostName,deviceCount,connectedCount,keepAwake,error}`. `tailscale` is `not_installed`, `logged_out`, `https_disabled`, `port_in_use`, `funnel_on` or `ready`. `link` is `off`, `starting`, `online` or `error`. Never includes the tailnet login or raw status JSON. |
| `remote.enable` | `{}` | Checks Tailscale, starts the loopback listener and adds Bitbots' `tailscale serve` handler on 443, or 8443 if 443 is served by something else. Returns the status. When Tailscale is not `ready` it changes nothing and returns `unsupported` with a safe message naming the fix. |
| `remote.disable` | `{}` | Closes every device socket, stops the listener and removes only Bitbots' serve handler. Paired devices are kept. |
| `remote.pair.begin` | `{}` | `{code,url,qrPayload,expiresAt,attemptsLeft}`. Eight characters, five minutes, five wrong attempts before it is burned. Starting a new offer cancels the previous one. `conflict` when Remote is off. |
| `remote.pair.cancel` | `{}` | Burns the live offer, if any. |
| `remote.pair.confirm` | `{ "pairingId": string, "approve": boolean, "tier"?: "viewer"\|"chat"\|"operator" }` | Approves (tier required) or rejects the device that locked the offer. Approval creates the device record and its token; rejection burns the offer. |
| `remote.devices.list` | `{}` | `{devices: RemoteDevice[]}`. Never includes the token or its hash. |
| `remote.devices.update` | `{ "deviceId": string, "name"?: string, "tier"?: string }` | Renames a device or changes its tier. |
| `remote.devices.revoke` | `{ "deviceId": string }` | Marks the device revoked, closes its socket at once and removes it from `remote.devices.list`. The token hash is kept only so later requests get `device_revoked`; it never authorises again. |
| `remote.security.get` | `{}` | `{approvalsFromRemote,idleExpiryDays,quietHours:{enabled,from,to}}`. |
| `remote.security.set` | same shape | Persists the options. Turning approvals from remote off leaves operator devices unable to approve until it is on again. |
| `remote.activity.list` | `{ "limit"?: integer }` | `{entries: RemoteActivityEntry[]}` newest first; the table keeps at most 500 rows. Summaries are one short sentence and never message content. |

Events, all local only (`never` in the remote event policy): `remote.changed {status}`, `remote.pairing.requested {pairingId,name,kind,platform,login,expiresAt}` (`login` is null when Tailscale sent no login header), `remote.pairing.completed {pairingId,outcome,deviceId?}` with `outcome` `approved`, `rejected`, `expired`, `cancelled` or `burned`, `remote.device.changed {action,device}`, and `remote.activity {entry}`.

Settings `remote.enabled`, `remote.port`, `remote.servePort` and `remote.security` change only through these methods; `settings.set` refuses every key with the `remote.` prefix. Storage adds the tables `remote_devices` and `remote_activity`.

Native adds `remote.method.set`, `remote.native.account.set`, `remote.native.port.set`, `remote.native.cert.regenerate`, `remote.native.upnp.set`, `remote.native.externalIp.set`, `remote.native.firewall.add` and `remote.native.firewall.remove`, all `never` remote; shapes in [remote/PROTOCOL.md §13](remote/PROTOCOL.md).

**Manager (FIX36).** One agent has `systemRole: "manager"`: it has no project, cannot be archived, deleted or demoted, and is created with `manager.ensure` (the `agent.create` fields; a no-op returning `created:false` when one exists; `manager.get` reads it). Its consequential actions are proposals: a `kind: "proposal"` permission card answered with `proposal.decide {id, decision: "approve"|"reject", edits?}`; nothing is created before approval. What it knows: `manager.profile.list`, `manager.profile.set {id?, category, key, value, locked}`, `manager.profile.delete {id}`, events `manager.profile.changed`. Its playbook: `manager.playbook.get`, `manager.playbook.history`, `manager.playbook.set {text}`, `manager.playbook.revert {version}`, events `manager.playbook.changed`. Reports: [FIX36_D1](history/fix-36/d1-report.md), [FIX36_D2](history/fix-36/d2-report.md), [FIX36_D3](history/fix-36/d3-report.md).

The browser simulator's `remote.direct.set` is dropped (there is no LAN listener). `remote.hosts.list` and `remote.hosts.select` are not daemon methods: the list of computers lives only on the device.

Appearance and companion preferences use `appearance.theme` (`system`, `dark`, or `light`), `appearance.textSize` (`small`, `default`, `large`, or `larger`), `companion.startPosition` (`launch` or `last`), `companion.hotkey` (boolean), and `companion.openAtStartup` (boolean).

### Durable prompt queue

`session.queue.*` stores prompts in Bitbots (never in the provider) and deletes each item once its prompt is accepted, so a sent item appears as an ordinary message. A queue item DTO is `{id,sessionId,text,attachments:[{name,path}],conversationRefs:[string],replyTo?:object,kind,dueAt:string|null,status,error:string|null,position:number,createdAt,lateBySecs?,meta?}`; `kind` is `user`, `send_later`, or the daemon-internal `retry`, and `status` is `queued`, `sending`, or `failed`. It holds only allowlisted prompt keys: `text`, `attachments`, `conversationRefs`, `replyTo`, plus the daemon-generated `meta` on `retry` items. Image attachments are re-validated at send time. A user RPC cannot set prompt `meta`; the daemon only accepts the `blob_message`/`blob_reply` team kinds and the `auto_retry` queue kind. Queue mutation RPCs return `not_found` for a missing or archived session and `read_only` for a side conversation.

After every finished turn the queue is drained once: a `turn.completed` on an idle session sends the next item (due scheduled items first, then plain items by position, then any pending team deliveries); a `turn.error` or `turn.cancelled` pauses the queue when items remain, so no prompt fires unexpectedly. Pause is in-memory and every session with queued plain items starts paused after a restart. Due `send_later` items are exempt from pause and fire from a one-second loop when their session is idle; a scheduled item that sends more than 60 seconds late appends an existing-style `notice` message, "Scheduled message sent N min late.", with meta `{"kind":"queue_late","lateBySecs":N*60}`. A send interrupted by a restart becomes `failed` with the message "Interrupted by a restart. Check the conversation before sending again." and is never auto-resent. Failed items stay until deleted or sent with `session.queue.send_now`.

### Automatic retry after overload and rate limits

> **Superseded in part by FIX39 (P8), see "FIX39 additions" below.** Overloaded retries are bounded at three attempts (`OVERLOADED_MAX_ATTEMPTS`, `crates/bloblex-daemon/src/retry.rs:16`), not five. Rate-limited failures now become the Limited state, with the reset time, and are not retried by this switch. The rest of this section still describes the beta.19 behaviour.

Opt-in via `experimental.autoRetry` (default false). With it off the daemon never schedules a retry and emits no retry notices or events. When on, a terminal turn error that carried an `overloaded` or `rateLimited` recovery hint and whose provider delivery was `acknowledged` may schedule one automatic retry: a `retry` queue item that sends the literal text `Please continue.` as a new turn in the same session, with the same locked model, effort and approval mode. A turn whose delivery is `unknown` always declines, because resending could charge a paid prompt twice. Overloaded backoff is `5s * 2^(attempt-1)` plus up to 100% jitter, up to 5 attempts. Rate-limited retries need a known reset: `max(reset of the provider's blocked quota windows) + 15s + 0..30s`, up to 2 attempts, and wait longer than `retry.maxWaitSecs` (default 21600, 0 to 86400; 0 means never wait for a window) declines. `authRequired` and hint-less failures stay silent. The decision is stored in `turns.data.retryDecision` as `{"decision":"retry"|"decline","reason":"<code>","at":"<rfc3339>"}`; reasons are `disabled`, `not_acknowledged`, `no_hint`, `auth_required`, `unknown_reset`, `too_long`, `max_attempts`, `superseded`, `pending_retry`, `session_unavailable`, or `cancelled`. Retry items bypass the queue pause and fire from the same due loop; a user prompt, a Stop, a model/effort change, or an archived/deleted session cancels any pending retry. After a restart a retry overdue by more than ten minutes is dropped with a notice "Automatic retry skipped because Bitbots was not running."

Schedule and decline notices use role `notice` with meta `{"kind":"auto_retry","status":"scheduled"|"declined"|"cancelled"|"skipped",...}`. Events: `turn.retry_scheduled` `{sessionId,turnId,itemId,retryKind:"overloaded"|"rate_limited",attempt,maxAttempts,runAt}`; `turn.retry_declined` `{sessionId,turnId?,reason}`. The eventual `auto_retry` user message carries `meta.kind == "auto_retry"` so the UI renders a notice instead of a bubble.

### Scheduled automations

Unattended work is fenced on every rail. A scheduler tick runs every 10 seconds (once at startup after restart recovery) and selects enabled automations whose `nextRunAt` is due, unless the global setting `automations.paused` (JSON boolean, default false) is true. `automations.maxConcurrent` (integer, default 1, 1–3) bounds simultaneous automation runs under the existing global cap of four turns. Missed occurrences coalesce into a single run: whatever the machine missed, at most one run starts and `nextRunAt` moves to the first occurrence strictly after now; a run starting more than 60 seconds late records `reason:"late:<secs>"`. An automation that already has a running run records a `skipped` run with `reason:"still_running"`. When the concurrency limit is reached or the blob already has a live user turn, the automation stays due for up to 15 minutes and is then recorded `skipped` with `reason:"busy"`.

An `Automation` is `{id,agentId,name,prompt,schedule:{kind,cron?,timezone,at?},sessionMode,approvalMode,maxRuntimeSecs,enabled,createdBy,nextRunAt,lastRunAt,consecutiveFailures,pauseReason,running,lastRun?}`. `scheduleKind` is `cron` or `once`; `sessionMode` is `new` or `reuse`; `approvalMode` is `plan` or `auto` only; `createdBy` is `user` or `agent`; `pauseReason` is `user`, `auto_failures`, `needs_approval`, or null. A `Run` is `{id,automationId,sessionId,status,reason,scheduledFor,startedAt,finishedAt}` where `status` is `running`, `completed`, `failed`, `skipped`, `cancelled`, `timeout`, or `interrupted`.

A run opens a normal blob session whose `link.kind` is `automation` (carrying `automationId`, `runId` and the clamped `approvalMode`), titled `Automation: <name>`, with the blob's model and effort pinned. The turn-end path maps outcomes onto the run: `turn.completed` -> `completed` and the failure counter resets; `turn.error` -> `failed`; `turn.cancelled` -> `cancelled`. After a failure the automation schedules one retry at 30 s then 60 s; on the third consecutive failure it is disabled with `pauseReason:"auto_failures"`. A run past its `maxRuntimeSecs` is cancelled through the provider and recorded `timeout`, counted as a failure. `once` automations disable themselves after their run. On startup, runs left `running` by an unclean exit become `interrupted` (not failures) and their sessions are untouched.

Safety rails: an automation session's effective approval mode is always `plan` or `auto`, regardless of the blob's `bypass` or the global default, and cannot be raised by `session.model.update`; a permission the classifier does not approve under `auto` is auto-denied with `permission.auto_denied {permissionId,sessionId,automationId,runId,category,summary}` and permission rows retain `resolvedBy:"policy:automation"`; structured questions are dismissed so the turn can finish. The MCP tool list for an automation session is empty, and `automation.*` write RPCs and scheduling tools reached through the MCP bridge return `forbidden`. A normal session's MCP tools add `schedule_task` (proposes a disabled automation with `pauseReason:"needs_approval"`, plan mode and `createdBy:"agent"`; it can never enable or run itself) and read-only `list_my_schedules`. Archiving or deleting a blob pauses (never deletes) its automations with `pauseReason:"user"`. Global pause stops new runs immediately and cancels nothing already running; cancelling one of its sessions through `session.cancel` sets its run `cancelled`.

Events: `automation.changed {automation}`, `automation.deleted {id}`, `automation.run.changed {run}`, `automation.run.finished {runId,automationId,agentId,sessionId,status,reason}`. Run `startedAt`, `scheduledFor` and `finishedAt` are RFC3339 UTC; `reason` is a short machine code (`late:<secs>`, `still_running`, `busy`, `error`, `timeout`, `session_error`, `cancelled`, `provider_error`) or safe sentence and never provider text.

### Memory and "about you"

Durable notes are stored in Bitbots (`memory_records` plus an FTS5 index over `title`, `body` and `tags`, and a `memory_versions` history kept to the ten newest versions per record). A `Memory` DTO is `{id,scope,scopeId,kind,title,body,tags,importance,pinned,origin,reviewed,sourceSessionId,version,createdAt,updatedAt,deletedAt}`. `scope` is `blob` (one agent's private notes), `project` (every blob in the project), or `shared` (everyone); `scopeId` is the agent id for `blob` and the project id for `project`, and null for `shared`. `kind` is `fact`, `preference`, `decision`, `procedure`, or `reference`. `origin` is `user` or `agent`.

The whole feature is off by default behind `experimental.memory` (JSON boolean). With it off no memory tools are listed and nothing is injected, but the `memory.*` RPCs still read for review and still accept user writes. `memory.sharedAgentWrites` (JSON boolean, default false) lets agents write `project` and `shared` notes; those stay `reviewed:0` and are never shown or injected until `memory.approve`. Agent-written `blob` notes are immediately `reviewed:1` but keep `origin:"agent"`. An automation-run session may only ever write `blob` scope.

Memory writes are untrusted input and share write rails: content carrying credential markers (`sk-`, `ghp_`, `AKIA`, `-----BEGIN`, `xox`, `Bearer `, long opaque runs, and the existing provider-error marker list) or injection-looking text (`<bloblex_` tags, "ignore … instructions", "disregard …", "you are now", "system prompt") is rejected with `invalid_argument`. Agent tool writes are capped at five per turn per session and bodies at 2000 characters.

While the feature is on, each turn may get a bounded summaries-only catalog appended to the **prompt text** (not the instructions), wrapped as `<bloblex_memory>…</bloblex_memory>`: reviewed, live records visible to the session (its own blob, its project, shared), pinned first then importance then `updatedAt`, each line `- [id8] <kind> · <title> — <first 100 chars of body>`, at most 3900 characters. It is re-sent only when its hash changes for that session or after a context change (compaction or a resume fallback). Because the block is part of the prompt and not the instructions, saving a memory never changes the instruction hash or forces a new provider thread, and the stored user message keeps the text exactly as typed. A session never sees another blob's private `blob` scope.

The MCP bridge adds `memory_search`, `memory_get`, `memory_write`, `memory_update`, and `memory_forget`, only while the feature is on and auto-allowed like the other `bloblex` tools. They return only reviewed records visible to the calling session. `memory_forget` soft-deletes and records `agent:<reason>` (at most 80 chars) in `memory_versions.changed_by`.

Persona: `profile.about` (string up to 1500 characters) is included in each blob's runtime instructions beside `profile.name` as `About the user (from their own notes): …`. Editing it is an explicit user change and does change the instruction hash (the per-blob persona remains the existing `instructions` field).

Events: `memory.changed {record}` and `memory.deleted {id}`.

### FIX39 additions (18 October 2026)

Names and shapes come from the package reports (`docs/FIX39_P<n>_REPORT.md`) and the code. No new event name was added in this wave; several existing payloads gained fields.

**Settings keys** (`settings.set` validates each; anything outside the allowlist is refused):

- `concurrency.botsAtOnce`: integer 1 to 16, default 4. The one limit on bots working at once. It replaces the per-bot cap, which is no longer enforced, although `agents.maxConcurrency` is still stored. `runtime.capabilities` reports it as `globalConcurrency.limit`.
- `experimental.resumeAfterUsageLimits`: JSON boolean, default on (an absent key means on). Resumes a Limited conversation when its window opens. With it off the conversation waits for you.
- `experimental.autoRetry`: unchanged, default off. It now covers transient failures only (overloaded, a dropped stream, a process that fails to start), with up to three attempts. Rate-limited failures become the Limited state below and are no longer retried by this switch.
- `diagnostics.logLevel`: `info` (default) or `debug`. Hidden in the UI. It takes effect at the next daemon start, and dependencies stay at `info`.
- `composer.busySendMode`: `steer` (default) or `queue`. What a send does while a bot works. Steer is used only where `runtime.capabilities` reports steering; otherwise the composer queues and says so.
- `exec_gate.codex.steer` is seeded open. A one-time migration opens an existing closed gate once. `session.steer` refuses only a provider whose adapter cannot steer; today that is every provider except Codex, and those answer `unsupported`.
- `experimental.sidebarModel` and `experimental.botLock` are the two new Experimental features, stored like the others under `experimental.<name>`.

**Remote status** (`remote.status`): `tailscale` also reports `starting` and `not_running`. `remote.enable` on a port that another Bitbots copy already serves is refused with `conflict`. A port held by another program moves the gateway to the next free loopback port (the configured port, then +1 to +9 skipping the Native port, then an OS-assigned port), and the chosen port is saved as `remote.port`.

**Limits and turn errors.**

- A session in a usage or rate limit has `state: "limited"` and `limitedUntil` (RFC 3339, or null when the provider gave no reset time). `limitedUntil` appears in `session.list`, `session.get` and `session.changed`. With no reset time the conversation stays limited and asks you; it never retries on an unknown window.
- `turn.error` carries `state` (for example `limited`) and `recoveryHandled: true` when a retry or continuation has already been scheduled for that turn. Clients hide those turn errors. The retry events are the ones from beta.19 (`turn.retry_scheduled`, `turn.retry_declined`).
- Notices: "Limited until <time>. I'll pick up when the window opens.", "Retrying (n of 3)…", and "Picking up where it left off" before a one-off `Continue where you left off.` prompt. A continuation follows a restart, a provider crash or a timeout, and at most three recoveries run per conversation.
- A lost session gets a summary. When a resume fails or a model changes, the next prompt carries one bounded `<bloblex_recap>` block: the last eight user and assistant messages (600 characters each), up to 12 changed file paths, 6000 characters in all. It is added to that one prompt, is never stored or logged, and the notice reads "Started a fresh session. The agent was given a summary of the conversation."

**Locks** (`agent.lock.set`). While a bot is locked these refuse with "This bot is locked. Unlock it to change its settings.": `agent.update`, `agent.delete`, `agent.restore`; `agent.team.update` when the project, role or leader would change (including to Unassigned); `project.delete` while a locked bot is in that project; `session.model.update` except `planMode`; `session.permissions.set`; the Manager's `update_blob`; approval of a Manager permission proposal; and the legacy model migration. Still allowed: unlocking, `agent.create`, hiding and sort order, `planMode`, and every read.

**Tags.** `project.update` and `agent.team.update` accept `tags`: an array of strings, trimmed and lower-cased, 1 to 24 characters each, at most 8, de-duplicated. `[]` clears them. The Manager's tag changes go through approval; a locked bot refuses a tag change.

**Merge proposals** (P10). A coding task that shares its repository with another working task runs in its own git worktree, beside the repository, on a `bitbots/<slug>` branch. A researcher-tagged or researcher-role bot never gets one. When the task completes, a proposal of kind `merge` offers the merge. `proposal.decide` with `approve` merges (fast-forward, else a merge commit; never forced) and removes the copy and branch. `reject` keeps the branch unless `discard: true` is sent, which removes the copy and branch. Merge and discard are refused while the task is still working, and a dirty main checkout refuses a merge with the proposal left pending. Remote devices with operator tier can send `discard` when approvals from remote are on (see [remote/THREAT_MODEL.md](remote/THREAT_MODEL.md) §14).

**Manager tool set** (P5, P7). These are tools on the local MCP bridge, not daemon RPC methods, and ordinary bots do not get them. Read tools need no approval: `list_blobs`, `read_blob`, `list_projects`, `read_project`, `project_status`, `list_conversations`, `read_conversation` and `get_conversation_permission`. Change tools create a proposal that waits for owner approval: `propose_bot`, `update_blob` (name, description, role, instructions, tags, look, model, effort and permission; never Full access), `propose_project`, `update_project`, `assign_task` (a brief, a done goal and a report-back are required), `message_blob`, `start_conversation`, `open_conversation` and `set_conversation_permission` (only `ask` or `auto`, and only for a side conversation the Manager started). `ask_user` is unchanged. Proposal kinds now stored are `bot`, `project`, `task`, `open`, `permission`, `merge`, plus the FIX36 `playbook` and `profile`. Decisions emit `proposal.changed {id,kind,sessionId,status,result,decidedAt}` with `status` `approved`, `rejected` or `expired`, and `permission.resolved`.

**Tool steps** (P2). A tool step may carry a short `label`, and a `pattern`, `url` or `path` where the provider gave one. Remote devices do not receive these fields by default (see [remote/PROTOCOL.md](remote/PROTOCOL.md) §7).

**Working bots** (P9) is a UI panel built from side sessions, queued notices and turn state. It adds no RPC.

## Desktop notifications

When enabled, only live transitions to completed, failed, or waiting for approval can create a Windows notification. The main window must be hidden or unfocused. Titles use the blob name; bodies use only the conversation title and transition label. Notification activation callbacks are not available on Windows through the current desktop notification integration, so the conversation remains unread until opened in the main window and can be found from its unread marker.

## Normalized core types

The following examples define the v1 UI DTO fields. Nullable fields may be absent or `null`; unknown fields must be tolerated.

```json
{
  "host": {"id":"host_windows_local","name":"DESKTOP","kind":"windows","status":"online"},
  "runtime": {"id":"rt_codex_abc","hostId":"host_windows_local","provider":"codex","displayName":"Codex","protocolFamily":"codex_app_server","executablePath":"C:\\Tools\\codex.exe","version":"0.159.3","authState":"unknown","gatewayAuthStates":{},"status":"online","capabilities":{"newSession":true,"resume":true,"cancel":true,"permissions":true,"usage":true,"files":true}},
  "session": {"id":"sess_bloblex","runtimeId":"rt_codex_abc","agentId":"agent_codex","provider":"codex","providerSessionId":"thread_opaque","projectPath":"C:\\repo","title":"Fix tests","state":"idle","resumable":true,"createdAt":"2026-10-01T12:00:00Z","updatedAt":"2026-10-01T12:01:00Z","turns":[{"id":"turn_1","state":"completed","createdAt":"2026-10-01T12:00:00Z","completedAt":"2026-10-01T12:01:00Z"}],"messages":[{"id":"msg_1","turnId":"turn_1","sequence":1,"role":"user","content":"Fix tests","createdAt":"2026-10-01T12:00:00Z"}],"tools":[],"files":[]},
  "permission": {"id":"perm_1","sessionId":"sess_bloblex","runtimeId":"rt_codex_abc","category":"shell","title":"Run tests","detail":"pnpm test","risk":"unknown","choices":["allow_once","deny"],"expiresAt":null,"status":"pending"},
  "messageDelta": {"sessionId":"sess_bloblex","turnId":"turn_1","messageId":"msg_2","role":"assistant","delta":"Checking the test setup…"},
  "tool": {"id":"tool_1","sessionId":"sess_bloblex","turnId":"turn_1","kind":"shell","title":"Run tests","state":"running","command":"pnpm test","exitCode":null,"startedAt":"2026-10-01T12:00:00Z","completedAt":null,"raw":{}},
  "file": {"id":"file_1","sessionId":"sess_bloblex","turnId":"turn_1","path":"src/main.ts","operation":"edit","addedLines":18,"removedLines":4,"diff":null},
  "usage": {"id":"use_1","runtimeId":"rt_codex_abc","sessionId":"sess_bloblex","turnId":"turn_1","provider":"codex","model":"gpt-x","timestamp":"2026-10-01T12:01:00Z","inputTokens":100,"outputTokens":50,"cacheReadTokens":20,"cacheWriteTokens":0,"reasoningTokens":null,"providerReportedCostMinor":null,"providerReportedCurrency":null,"source":"stream","raw":{},"valuation":{"basis":"unknown","amountMinor":null,"currency":null,"pricingRuleId":null,"status":"unavailable"}},
  "budget": {"id":"budget_1","scopeType":"global","scopeId":null,"period":"day","metric":"tokens","hardLimit":100000,"warningThresholds":[50,80,95],"enabled":true,"consumed":1200,"reserved":500,"remaining":98300},
  "profile": {"id":"profile_1","name":"Work Codex","provider":"codex","protocolFamily":"codex_app_server","executablePath":"C:\\Tools\\codex.exe","args":["--profile","work"],"hostId":"host_windows_local","workingDirectoryPolicy":"per_session"}
}
```

`app.snapshot` returns `{snapshotVersion,sequence,daemon,hosts,runtimes,agents,sessions,permissions,usageSummary,settings}`. The former `budgets` key is no longer returned: `crates/bloblex-storage/src/lib.rs:4143` asserts its absence (budgets are retired, AGENTS.md 12 October amendment). `agents` includes active and archived `Agent` rows; `sessions` excludes archived conversations. `budgets` is a `Budget[]`; `budget.list` wraps the same array in `{policies}`. A blob policy's `consumed` and `reserved` totals include only reservations from turns whose session has the matching `agentId`. Session turn/message/tool/file arrays are ordered and omit provider raw payloads. `session.get` returns the same nested session DTO. Long transcripts may be paged in later protocol versions.

Session turn objects add nullable `failureClass` and `failureMessage` fields. The message is a safe daemon-authored summary for the failure class; both fields are null for turns without a classified failure. This projection does not expose provider error text.

`Agent` fields are `{id,name,description,instructions,color,runtimeId,model,thinking,serviceTier,approvalMode,effectiveApprovalMode,customArgs,customEnv,maxConcurrency,defaultProject,sortOrder,archived,createdAt,updatedAt}`. Session DTOs include nullable `agentId` while `runtimeId` remains required. `agent.changed` events carry `{action,agentId,runtimeId,updatedAt,archived,sortOrder}`; the safe event projection excludes instructions, custom environment values and custom arguments. They are emitted only for explicit agent mutations and reordering. Runtime discovery never creates blobs and emits no `agent.changed` events. Events are persisted with the mutation and replayed by the global sequence cursor.

Approval policy adds `approvalMode` (nullable: `ask`, `auto`, `bypass`, or null to inherit) and `effectiveApprovalMode` to every Agent DTO and snapshot. `agent.create` and `agent.update` accept `approvalMode`; explicit null restores inheritance. The global setting `permissions.default_mode` accepts only `ask` or `auto`, defaults to `ask`, and produces `settings.changed` with `{key,mode}` on an actual change. `permissions.policy.get` returns `{defaultMode,perAgent:[{agentId,mode,effectiveMode}]}`. Changing an agent's override emits the existing safe `agent.changed` event.

`permission.auto_resolved` carries `{permissionId,sessionId,turnId?,agentId?,mode,decision,category,summary}`. `summary` contains only the normalized tool kind and a path or command head, is truncated, and excludes file contents, environment values, prompts, and instructions. Permission rows retain `resolvedBy` as `policy:auto` or `policy:bypass`. `permission.bypass_active` carries `{sessionId,agentId?,providerMode}` at provider session and turn start when bypass launch flags are active. Budget admission, pause, cancellation, and provider acknowledgment remain authoritative over policy decisions.

Execution snapshots are returned as `{id,sessionId,turnId,agentId,runtimeId,provider,createdAt,requested,applied,evidence,instructionSha256,adapterFlags,status}`. `requested` contains only setting values that are safe to retain, `instructionsPresent`, `maxConcurrency`, and custom environment key names; it never contains instruction text or environment values. Status is `applied`, `partial`, `rejected`, or `runtime_default`. Session baselines are `claudeInstructionSha256` (last Claude instruction hash proven applied), `codexThreadInstructionSha256` (instructions installed when the current Codex thread started), and `opencodeCostTotal` (exact cumulative USD cost as decimal text). Usage rows include nullable `execSnapshotId`, `providerUpdateId`, `usageStatus`, `contextUsed`, `contextSize`, and `reportedCostDecimal`; new usage rows store `{}` in the legacy raw field. `reportedCostDecimal` is the exact per-turn OpenCode USD delta, as decimal text.

Claude computes SHA-256 over the current non-empty instruction text at every turn. `claudeInstructionSha256` records the hash last proven applied by a successful turn; failed turns do not advance it. A changed hash causes Claude to resume with the new private instruction file and `--system-prompt-snapshot off`; an unchanged hash leaves Claude's default snapshot behavior intact. The daemon stores the hash in the turn snapshot, never the instruction text. Claude writes instruction files under its private temporary directory and pairs each `instruction-*.txt` with an `instruction-*.lock` containing the owner PID. On Windows it removes inherited ACLs and grants full control to the current domain user via the system `icacls.exe`; on Unix it uses directory mode `0700` and file mode `0600`. If Windows ACL setup fails, instruction text is not written and turn admission is rejected. Provider exit and spawn failure remove the pair; startup cleanup removes only old paired Bitbots files whose owner PID is no longer live.

Every prompt reloads the persisted agent options and validates non-null model, thinking, and service tier values against the runtime's current cached or fetched authoritative catalog. An authoritative catalog rejects unknown IDs or unsupported combinations as a turn-scoped `invalid_argument`; when discovery is unavailable or the catalog is marked `fallback`, non-empty custom IDs are accepted without validation. Gate or adapter preflight rejection records the user message, error turn, rejected snapshot, and `exec.options.rejected` event atomically and does not reserve concurrency or deliver the prompt.

Codex `serviceTier` is sent on thread start/resume only when it is a catalog tier ID. The special value `standard` means standard speed for one Codex turn and is sent as `serviceTierForTurn: "default"`; it is never sent as a `serviceTier` ID. The legacy value `fast` is invalid; use the catalog ID (for example, `priority`) returned by the runtime.

`runtime.capabilities.settings` has `model`, `thinking`, `serviceTier`, `instructions`, and `customEnv` entries, each `{supported,enabled,scope,evidence,reason?}`. The `customEnv` entry also returns an `allowedKeys` array containing `LANG`, `LC_ALL`, `TZ`, `NO_COLOR`, and `TERM`. `enabled` is `supported && exec_gate.<provider>.<setting>`; custom environment support uses the provider allowlist and has no execution gate. `globalConcurrency` is `{limit,active}` with a fixed limit of 4. With `agentId`, `agentConcurrency` is `{configuredMaxConcurrency,effectiveMaxConcurrency,active}`; effective is the lower of the configured cap and 4. Without `agentId`, `agentConcurrency` is null and `agentConcurrencies` lists the active agents for that runtime. All active counts in this foundation reflect current daemon turns; durable reservation enforcement is a later step.

Persisted events include `settings.changed` `{key,enabled}` for actual `exec_gate.*` changes; no-op gate writes produce no event. `exec.options.changed` is `{sessionId,turnId,agentId,runtimeId,requested,applied,snapshotId}`. `requested` contains typed values, `instructionsPresent`, concurrency and environment key names only. `exec.options.rejected` is `{sessionId,agentId,runtimeId,setting,code,reason,turnId?,snapshotId?}`; session-scoped errors omit the optional fields, turn-scoped preflight errors include them. Codex app-server JSON-RPC rejection of thread start/resume settings emits one session-scoped event for each requested option before returning `provider_error`; rejection of turn settings emits turn-scoped `ExecApplied` evidence and does not retry. Payloads never contain instruction text, environment values, arguments, file paths, or raw provider JSON. A closed gate or unsupported non-null option returns `unsupported` with the safe execution-check message; failed provider discovery returns `provider_unavailable`, malformed provider catalog returns `provider_error`.

`usageSummary` fields are `{from,to,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens,providerReportedCostMinor,providerReportedCurrency,apiEstimateMinor,apiEstimateCurrency,pricingStatus,subscriptionFixedMinor,subscriptionCurrency,quotaState}`; analytics cost objects also include `mayBeHigh` when a conservative pricing tier was selected because turn usage omitted its discriminator. Pricing rules use decimal strings per million in `{id,provider,canonicalModelId,aliases,inputPerMillion,outputPerMillion,cacheReadPerMillion,cacheWritePerMillion,currency,effectiveFrom,effectiveTo,sourceUrl,checkedAt,notes,tiers,source}`. Tiers encode long-context thresholds, UTC time windows and cache-write durations. Subscription plans are `{id,provider,billingMode:"subscription",currency,monthlyMinor,renewalDay,quotaState}`.

The versioned official price table is `crates/bloblex-usage/data/official-prices.json`. Estimates resolve user override, official price list, cached OpenCode catalog estimate, then unknown. Unknown rates remain unpriced/null; explicit zero rates are known Free prices. Currency minor-unit conversion rounds half up after summing the exact decimal bucket values.

### Current financial source checkpoint (1 October)

Read-only review of `crates/bloblex-storage/src/lib.rs` found these additional implemented fields and limits. The latest backend integration is compile-checked only; these are source facts, not validated financial acceptance:

- `usage.summary` additionally returns `valuations`, grouped as `{basis,currency,status,amountMinor,eventCount}`, and `subscriptions`, containing saved plan objects. Actual and API-estimate scalar totals remain separate and return null when a single known currency total cannot be formed.
- Subscription scalar amount/currency remain null in this checkpoint; plans carry monthly fees separately. They must not be presented as observed daily charges or added to API estimates.
- Omitted `from`/`to` default to `0000`/`9999`; snapshot usage summary is all-time. A UI label such as Today requires an explicit bounded request and accurate dates.
- The current storage implementation filters dates, but does **not** apply the optional `scope` parameter. Until implemented/tested, the UI must label this summary global rather than pretend it is filtered per selected runtime/session/model.
- Token sums are nullable SQL aggregates without an unknown-event coverage count. A known subtotal does not prove that every event reported that bucket. Valuation group statuses must be considered when displaying partial/unavailable pricing; the top-level `pricingStatus` alone is insufficient to prove full coverage.
- Complete per-runtime/session/model rollups, period semantics, partial coverage and valuation persistence still require independent integration fixtures and live evidence.

Runtime auth state is one of `authenticated`, `unauthenticated`, `needs_interaction`, or `unknown`. Presence of an executable does not imply auth. Runtime protocol family is `acp`, `codex_app_server`, or `claude_stream`.

Session state is `idle`, `starting`, `working`, `waiting_permission`, `waiting_user`, `cancelling`, `completed`, `cancelled`, `closed`, `error`, or `offline`. An unclean daemon restart marks volatile active sessions `offline`, fails their incomplete turns, expires pending approvals, retains partial history and provider-native IDs, and never resends prompts automatically. A session persists both Bitbots and provider-native IDs, provider, runtime, project path, resumability, and timestamps.

The normalized event vocabulary is `runtime.changed`, `agent.changed`, `session.changed`, `session.deleted`, `message.delta`, `message.completed`, `tool.changed`, `file.changed`, `command.changed`, `permission.requested`, `permission.resolved`, `permission.auto_denied`, `usage.updated`, `budget.warning`, `budget.blocked` (retired; no emitter found in `crates/bloblex-daemon/src` or `crates/bloblex-protocol/src`), `turn.completed`, `turn.cancelled`, `turn.error`, `turn.retry_scheduled`, `turn.retry_declined`, `queue.changed`, `automation.changed`, `automation.deleted`, `automation.run.changed`, `automation.run.finished`, `memory.changed`, `memory.deleted`, and `daemon.health`. `queue.changed` carries `{sessionId,items,paused}` with the full list for that session and is emitted after any queue mutation. Streamed and finalized messages carry the same stable `id`/`messageId`; `session.changed` carries compact session metadata (identity, ownership, title, archive/activity state, resumability, and timestamps), never transcript content. Existing clients retain hydrated message and activity arrays when applying it. `session.deleted` permanently removes that conversation and its persisted session-specific events. Unsupported semantics remain unsupported; never synthesize provider success, auth, usage or permission grants.

Usage token buckets are mutually exclusive: `inputTokens` excludes `cacheReadTokens` and `cacheWriteTokens`; output, reasoning and provider-reported cost are separately nullable. Valuation basis is `provider_reported_actual`, `api_rate_estimate`, `subscription_fixed`, `local_free`, or `unknown`. Unknown model price serializes as `null` with an explanatory status, never zero.

`usage.updated` may include `evidenceNote` when a provider reports incomplete or internally inconsistent token buckets. Codex usage is scoped to the current provider `turnId`; cached input and cache-write tokens are subtracted from `inputTokens` only when all buckets are present and the subtraction remains non-negative. Otherwise the reported input count is retained with an evidence note. Codex usage has no reported cost and its model comes from the thread start/resume echo. Failed Codex turns report `usageStatus: "unreported"` with nullable token and model fields.

Provider prompt delivery is recorded internally on the turn (`turns.data.delivery`): `acknowledged` when the provider accepted the prompt, `unknown` when a turn ended without that evidence. It is never emitted as a wire event and adds no client-facing field.

## Errors and compatibility

Stable error codes: `invalid_argument`, `not_found`, `unauthorized`, `unsupported`, `provider_unavailable`, `provider_error`, `budget_blocked` (retired; no emitter found), `conflict`, `replay_gap`, and `internal`. Error messages are safe for display and contain no credential material or prompt text. A client must compare `v`; an unsupported major version is a startup error. Adapter capability omissions mean unsupported.

The execution snapshot RPCs use `invalid_argument` for malformed IDs, cursors, or limits; `not_found` for a missing snapshot, session, or runtime. `runtime.capabilities` returns `not_found` for a missing runtime and `invalid_argument` when the supplied agent belongs to another runtime. Later option application uses `unsupported` for closed gates or unsupported settings and `provider_unavailable` when the provider cannot be reached.

## Security invariants

- Loopback-only listener and random per-process capability; no LAN exposure.
- Remote mode (design): the second listener also binds loopback only, is reachable from other machines only through `tailscale serve` on the owner's tailnet, never through Funnel, and never sees the capability.
- Capability is memory-only and passed to the desktop shell only through daemon stdout at startup.
- Renderer never receives the capability or connects directly to the daemon.
- Process launch is direct executable plus argument array. User input never becomes shell text.
- Logs redact secrets and exclude prompt bodies by default.
- SQLite and runtime records never receive provider login credentials.
- Claude hook bridge has a bounded request and timeout and fails open when daemon IPC is unavailable.
- Permission replies use a pending→resolved conditional update; duplicate replies return `conflict` and never reach the provider twice.
- Retired (AGENTS.md, 12 October 2026 amendment; `crates/bloblex-daemon/src/main.rs:2413` notes historical budget records are not enforced). The former rule: budget admission reads applicable usage and reservations, then inserts a reservation in one `BEGIN IMMEDIATE` transaction. The strictest applicable hard policy governs; simultaneous prompts cannot share the same remaining allowance.

## Runtime hardening additions

- `runtime.capabilities` adds `versionRecognized: boolean`, the runtime's version-format recognition result.
- `turn.error.failureClass` may be `context`; its safe message is `Context window is full. Start a new conversation.` and `canRetireSession` is true. The provider-session ID remains intact on context exhaustion.
- Mixed-currency analytics keep each currency's valuation separately. The scalar cost is null when currencies are mixed; `excludedCurrencies` lists currencies after the first sorted currency because the scalar shape cannot represent them. `lowerBound` is true for mixed currency totals.
- `session.resume_rejected` reports positive evidence that a stored provider session is missing or expired. The daemon clears that provider ID and starts a fresh session; generic resume errors do not clear it.
- `session.replaced` reports that the provider's conversation context changed. Its payload is `{"sessionId","reason","contextLost"}`, where `reason` is `compaction` or `fresh_session` and `contextLost` is true only when earlier context is gone. It is informational; the persisted `message.completed` notice carries the user-facing copy and `session.context.reset` still clears the context meter for a lost context.
- The daemon's startup/no-progress watchdog is 45 seconds; after the first semantic activity, its semantic-inactivity watchdog is 300 seconds. These are Bitbots product choices, not provider CLI facts. Expiry fails the turn with `failureClass: timeout` and closes the adapter session, which kills its owned process tree.
- Resume-time context overflow emits `session.context_exhausted` with the safe message and retirement offer; it does not clear the provider-session ID.
