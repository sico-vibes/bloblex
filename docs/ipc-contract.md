# Bloblex daemon IPC contract (v1)

## Update commands

The desktop updater commands and events are defined in [UPDATER.md](UPDATER.md). They run in the Tauri shell and persist preferences through the daemon settings store; they are separate from the daemon's v1 IPC methods below.

This is the integration contract between `bloblexd.exe` and the desktop shell. The daemon is authoritative; UI state is reconstructed from `app.snapshot` and subsequent ordered events.

The desktop shell also exposes local Tauri commands for user-selected file flows. Native save/open dialogs retain their selected paths in process-local state and return only opaque single-use selection tokens to the webview. `write_selected_export_text` consumes a save token to write UTF-8 text, and `read_blob_import` consumes an open token to read UTF-8 JSON with a 64 KiB limit. A webview-supplied path is never accepted by these commands, and they do not access the daemon database.

This document includes intended contract requirements, not a statement that every guarantee is already implemented or independently tested. See [implementation status](implementation-status.md) for open acceptance work. Snapshot/event atomicity, complete permission lifecycle, financial aggregation and process-tree cleanup remain under review.

## Transport and startup

The desktop shell owns the daemon child process and starts it for the signed-in Windows user. The daemon binds an ephemeral TCP port on `127.0.0.1` only. It must never bind `0.0.0.0`, a LAN interface, or IPv6 wildcard. On startup, the daemon writes one bootstrap JSON object to stdout before any logs:

```json
{"type":"bloblexd.ready","protocolVersion":1,"address":"127.0.0.1:49152","capability":"<random-256-bit-secret>"}
```

The capability exists only in daemon memory and the desktop shell's child-process channel; do not persist or log it. The shell keeps it in the native Tauri process and proxies renderer calls through Tauri commands. A connecting client must send it in `Authorization: Bearer <capability>`. Reject requests without a valid capability using a constant-time comparison. CORS is disabled. Only loopback peers are accepted. If another UI client is needed, it must receive the secret through the same authenticated native shell path.

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
| `runtime.list` | `{}` | Discovered runtimes, host, protocol, absolute executable, version, auth state and capabilities. |
| `runtime.refresh` | `{}` | Rescan native Windows and configured WSL hosts; returns current runtime list. |
| `runtime.profile.list` | `{}` | Saved runtime profiles. |
| `runtime.profile.save` | `{ "profile": RuntimeProfile }` | Save a direct executable + parsed args profile after path validation. |
| `runtime.profile.delete` | `{ "profileId": string }` | Delete a saved profile. |
| `settings.get` | `{}` | Non-secret local preferences. |
| `settings.set` | `{ "key": string, "value": any }` | Persist a preference; credential fields are rejected. `exec_gate.*` and `notifications.enabled` values must be JSON booleans. |
| `runtime.capabilities` | `{ "runtimeId": string, "agentId"?: string }` | `{runtimeId,settings,globalConcurrency,agentConcurrency,agentConcurrencies,hostDependent}`; reports static provider support separately from the persisted `exec_gate.*` switch. Unsupported settings are disabled. |
| `runtime.models` | `{ "runtimeId": string, "refresh"?: boolean }` | `{runtimeId,provider,models,fetchedAt,expiresAt,fallback,source,validated}`; `source` is `live_query`, `cli_list`, `config_options`, or `fallback`; `validated` is true only when the live source is authoritative for model-id validation. Other settings are checked only when their model row has supporting values, such as non-empty per-model `supportedThinking`. Model rows include `id`, `displayName`, optional `providerId`, supported/default thinking, service tiers/default, optional variants, `hostDependent`, and the additive presentation fields `isDefault`, `group`, and `availability`. Cached per runtime/profile for 60 seconds; `refresh:true` bypasses cache. Fallback and other unvalidated catalogs are suggestions and do not validate execution. |
| `exec.snapshot.get` | `{ "snapshotId": string }` | Snapshot object; `not_found` when the snapshot does not exist. |
| `exec.snapshot.list` | `{ "sessionId": string, "after"?: string, "limit"?: integer }` | `{snapshots,next}`; `after` is an exclusive snapshot ID cursor and limit defaults to 50 (maximum 200). |
| `exec.snapshot.latest` | `{ "sessionId": string }` | Snapshot object or `null` when the session has no turns. |
| `session.list` | `{ "includeArchived"?: boolean }` | Persisted sessions, excluding archived conversations by default. |
| `session.get` | `{ "sessionId": string }` | Session with ordered turns, messages, tool cards and file changes. |
| `session.rename` | `{ "sessionId": string, "title": string }` | Trim and persist a title of 1 to 120 characters; emits `session.changed`. |
| `session.archive` | `{ "sessionId": string, "archived": boolean }` | Hide or restore a conversation; emits `session.changed`. Archived conversations appear only with `includeArchived:true`. |
| `session.delete` | `{ "sessionId": string }` | Permanently removes Bloblex's session record and stored child data. Refuses sessions that are starting, working, cancelling, or waiting for approval. It does not modify the coding agent's own history; emits `session.deleted`. |
| `session.new` | `{ "agentId"?: string, "runtimeId"?: string, "projectPath": string, "title"?: string }` | Exactly one of `agentId` or `runtimeId` is required. Agent selection derives its runtime; legacy runtime-only creation leaves `agentId:null`. |
| `agent.list` | `{ "includeArchived"?: boolean, "runtimeId"?: string }` | `{ "agents": Agent[] }`; active agents by default, ordered by runtime and sort position. |
| `agent.get` | `{ "agentId": string }` | `{ "agent": Agent }`; returns active or archived agent. |
| `agent.create` | `{ "name": string, "runtimeId": string, "description"?: string, "instructions"?: string, "color"?: string, "outfit"?: Outfit, "model"?: string|null, "thinking"?: string|null, "serviceTier"?: string|null, "approvalMode"?: "ask"|"auto"|"bypass"|null, "customArgs"?: string[], "customEnv"?: object, "maxConcurrency"?: integer, "defaultProject"?: string|null }` | `{ "agent": Agent }`; appends an active agent for the runtime. Outfit is `auto`, `none`, `party-hat`, `beanie`, `crown`, `sunglasses`, `round-glasses`, `bow`, `scarf`, `witch-hat`, or `santa-hat`; omitted outfit defaults to `auto`. |
| `agent.update` | `{ "agentId": string, "name"?: string, "runtimeId"?: string, "description"?: string, "instructions"?: string, "color"?: string, "outfit"?: Outfit, "model"?: string|null, "thinking"?: string|null, "serviceTier"?: string|null, "approvalMode"?: "ask"|"auto"|"bypass"|null, "customArgs"?: string[], "customEnv"?: object, "maxConcurrency"?: integer, "defaultProject"?: string|null }` | `{ "agent": Agent }`; omitted fields remain unchanged, explicit nullable fields clear their values, and archived agents cannot be edited. |
| `permissions.policy.get` | `{}` | `{ "defaultMode": "ask"|"auto", "perAgent": [{"agentId": string, "mode": "ask"|"auto"|"bypass"|null, "effectiveMode": "ask"|"auto"|"bypass"}] }`. |
| `agent.delete` | `{ "agentId": string }` | `{ "agent": Agent }`; soft archives the agent and compacts active order. |
| `agent.reorder` | `{ "runtimeId": string, "agentIds": string[] }` | `{ "agents": Agent[] }`; replaces the full active order for the runtime. |
| `session.resume` | `{ "sessionId": string }` | Resumes only when the adapter advertises support; otherwise returns `unsupported`. |
| `session.prompt` | `{ "sessionId": string, "text": string }` | Starts a turn after atomic budget admission. Prompt body is sent over authenticated IPC/protocol, never argv. |
| `session.cancel` | `{ "sessionId": string, "turnId"?: string }` | Requests provider cancellation and reports whether the provider supports it. |
| `session.close` | `{ "sessionId": string }` | Closes managed adapter process; persisted session remains. |
| `permission.reply` | `{ "permissionId": string, "choice": string }` | Choice is an opaque provider-supported option ID from that request; the provider adapter must receive and acknowledge it before Bloblex marks it resolved. |
| `usage.summary` | `{ "from": string, "to": string, "scope"?: object }` | Raw token totals and separate known/unknown valuations; subscription fees are not API estimates. |
| `usage.analytics` | `{ "from": string, "to": string, "bucket": "day"|"week", "tz": string, "projectPath"?: string, "agentId"?: string }` | Returns `UsageAnalytics` as defined in `docs/PHASE_5_CONTRACT.md`; invalid range, bucket, or timezone is `invalid_argument`, unknown agent is `not_found`. |
| `pricing.list` | `{ "provider"?: string }` | User overrides and exact-decimal official price-list rows (`inputPerMillion`, `outputPerMillion`, cache rates, currency, `sourceUrl`, `checkedAt`, optional tiers/notes), with source `user_override` or `official_price_list`; effective rows include `effectiveFields` with rate, currency, source and checked date for each rate field, so partial overrides retain lower-priority values and provenance. Legacy shipped database rates are omitted. Usage & limits separately combines current runtime catalogs as `opencode_catalog_estimate`. Models without an applicable override, official row, or catalog rate remain unpriced. |
| `pricing.override` | `{ "rule": PricingRule }` | Save user pricing with exact non-negative decimal strings per million tokens (up to twelve fractional digits) or `null` for unknown buckets. Blank buckets inherit the official or cached catalog rate when available. IDs, provider, model, currency and RFC3339 `effectiveFrom` are validated. `{ "rule": { "id": string, "remove": true } }` removes that override. |
| `subscription.list` | `{}` | User-entered plan fees, separated from token estimates and quota (`unknown` unless measured). |
| `subscription.save` | `{ "plan": SubscriptionPlan }` | Save provider, currency, fixed monthly amount and renewal day. |
| `budget.list` | `{}` | `{ "policies": Budget[] }` with active reservations where available. |
| `budget.set` | policy object | Persists a policy; most restrictive applicable hard cap wins. |
| `budget.delete` | `{ "policyId": string }` | Removes that policy. |

Appearance and companion preferences use `appearance.theme` (`system`, `dark`, or `light`), `appearance.textSize` (`small`, `default`, `large`, or `larger`), `companion.startPosition` (`launch` or `last`), `companion.hotkey` (boolean), and `companion.openAtStartup` (boolean).

## Desktop notifications

When enabled, only live transitions to completed, failed, or waiting for approval can create a Windows notification. The main window must be hidden or unfocused. Titles use the blob name; bodies use only the conversation title and transition label. Notification activation callbacks are not available on Windows through the current desktop notification integration, so the conversation remains unread until opened in the main window and can be found from its unread marker.

## Normalized core types

The following examples define the v1 UI DTO fields. Nullable fields may be absent or `null`; unknown fields must be tolerated.

```json
{
  "host": {"id":"host_windows_local","name":"DESKTOP","kind":"windows","status":"online"},
  "runtime": {"id":"rt_codex_abc","hostId":"host_windows_local","provider":"codex","protocolFamily":"codex_app_server","executablePath":"C:\\Tools\\codex.exe","version":"0.159.3","authState":"unknown","status":"online","capabilities":{"newSession":true,"resume":true,"cancel":true,"permissions":true,"usage":true,"files":true}},
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

`app.snapshot` returns `{snapshotVersion,sequence,daemon,hosts,runtimes,agents,sessions,permissions,usageSummary,budgets,settings}`. `agents` includes active and archived `Agent` rows; `sessions` excludes archived conversations. `budgets` is a `Budget[]`; `budget.list` wraps the same array in `{policies}`. Session turn/message/tool/file arrays are ordered and omit provider raw payloads. `session.get` returns the same nested session DTO. Long transcripts may be paged in later protocol versions.

Session turn objects add nullable `failureClass` and `failureMessage` fields. The message is a safe daemon-authored summary for the failure class; both fields are null for turns without a classified failure. This projection does not expose provider error text.

`Agent` fields are `{id,name,description,instructions,color,runtimeId,model,thinking,serviceTier,approvalMode,effectiveApprovalMode,customArgs,customEnv,maxConcurrency,defaultProject,sortOrder,archived,createdAt,updatedAt}`. Session DTOs include nullable `agentId` while `runtimeId` remains required. `agent.changed` events carry `{action,agentId,runtimeId,updatedAt,archived,sortOrder}`; the safe event projection excludes instructions, custom environment values and custom arguments. In addition to agent RPC mutations, runtime discovery emits action `created` when it adds a default agent for a runtime with no agent rows; archived rows count and suppress recreation. Events are persisted with the mutation and replayed by the global sequence cursor.

Approval policy adds `approvalMode` (nullable: `ask`, `auto`, `bypass`, or null to inherit) and `effectiveApprovalMode` to every Agent DTO and snapshot. `agent.create` and `agent.update` accept `approvalMode`; explicit null restores inheritance. The global setting `permissions.default_mode` accepts only `ask` or `auto`, defaults to `ask`, and produces `settings.changed` with `{key,mode}` on an actual change. `permissions.policy.get` returns `{defaultMode,perAgent:[{agentId,mode,effectiveMode}]}`. Changing an agent's override emits the existing safe `agent.changed` event.

`permission.auto_resolved` carries `{permissionId,sessionId,turnId?,agentId?,mode,decision,category,summary}`. `summary` contains only the normalized tool kind and a path or command head, is truncated, and excludes file contents, environment values, prompts, and instructions. Permission rows retain `resolvedBy` as `policy:auto` or `policy:bypass`. `permission.bypass_active` carries `{sessionId,agentId?,providerMode}` at provider session and turn start when bypass launch flags are active. Budget admission, pause, cancellation, and provider acknowledgment remain authoritative over policy decisions.

Execution snapshots are returned as `{id,sessionId,turnId,agentId,runtimeId,provider,createdAt,requested,applied,evidence,instructionSha256,adapterFlags,status}`. `requested` contains only setting values that are safe to retain, `instructionsPresent`, `maxConcurrency`, and custom environment key names; it never contains instruction text or environment values. Status is `applied`, `partial`, `rejected`, or `runtime_default`. Session baselines are `claudeInstructionSha256` (last Claude instruction hash proven applied), `codexThreadInstructionSha256` (instructions installed when the current Codex thread started), and `opencodeCostTotal` (exact cumulative USD cost as decimal text). Usage rows include nullable `execSnapshotId`, `providerUpdateId`, `usageStatus`, `contextUsed`, `contextSize`, and `reportedCostDecimal`; new usage rows store `{}` in the legacy raw field. `reportedCostDecimal` is the exact per-turn OpenCode USD delta, as decimal text.

Claude computes SHA-256 over the current non-empty instruction text at every turn. `claudeInstructionSha256` records the hash last proven applied by a successful turn; failed turns do not advance it. A changed hash causes Claude to resume with the new private instruction file and `--system-prompt-snapshot off`; an unchanged hash leaves Claude's default snapshot behavior intact. The daemon stores the hash in the turn snapshot, never the instruction text. Claude writes instruction files under its private temporary directory and pairs each `instruction-*.txt` with an `instruction-*.lock` containing the owner PID. On Windows it removes inherited ACLs and grants full control to the current domain user via the system `icacls.exe`; on Unix it uses directory mode `0700` and file mode `0600`. If Windows ACL setup fails, instruction text is not written and turn admission is rejected. Provider exit and spawn failure remove the pair; startup cleanup removes only old paired Bloblex files whose owner PID is no longer live.

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

Session state is `idle`, `starting`, `working`, `waiting_permission`, `waiting_user`, `cancelling`, `completed`, `cancelled`, `closed`, `error`, or `offline`. An unclean daemon restart marks volatile active sessions `offline`, fails their incomplete turns, expires pending approvals, retains partial history and provider-native IDs, and never resends prompts automatically. A session persists both Bloblex and provider-native IDs, provider, runtime, project path, resumability, and timestamps.

The normalized event vocabulary is `runtime.changed`, `agent.changed`, `session.changed`, `session.deleted`, `message.delta`, `message.completed`, `tool.changed`, `file.changed`, `command.changed`, `permission.requested`, `permission.resolved`, `usage.updated`, `budget.warning`, `budget.blocked`, `turn.completed`, `turn.cancelled`, `turn.error`, and `daemon.health`. Streamed and finalized messages carry the same stable `id`/`messageId`; `session.changed` carries compact session metadata (identity, ownership, title, archive/activity state, resumability, and timestamps), never transcript content. Existing clients retain hydrated message and activity arrays when applying it. `session.deleted` permanently removes that conversation and its persisted session-specific events. Unsupported semantics remain unsupported; never synthesize provider success, auth, usage or permission grants.

Usage token buckets are mutually exclusive: `inputTokens` excludes `cacheReadTokens` and `cacheWriteTokens`; output, reasoning and provider-reported cost are separately nullable. Valuation basis is `provider_reported_actual`, `api_rate_estimate`, `subscription_fixed`, `local_free`, or `unknown`. Unknown model price serializes as `null` with an explanatory status, never zero.

`usage.updated` may include `evidenceNote` when a provider reports incomplete or internally inconsistent token buckets. Codex usage is scoped to the current provider `turnId`; cached input and cache-write tokens are subtracted from `inputTokens` only when all buckets are present and the subtraction remains non-negative. Otherwise the reported input count is retained with an evidence note. Codex usage has no reported cost and its model comes from the thread start/resume echo. Failed Codex turns report `usageStatus: "unreported"` with nullable token and model fields.

## Errors and compatibility

Stable error codes: `invalid_argument`, `not_found`, `unauthorized`, `unsupported`, `provider_unavailable`, `provider_error`, `budget_blocked`, `conflict`, `replay_gap`, and `internal`. Error messages are safe for display and contain no credential material or prompt text. A client must compare `v`; an unsupported major version is a startup error. Adapter capability omissions mean unsupported.

The execution snapshot RPCs use `invalid_argument` for malformed IDs, cursors, or limits; `not_found` for a missing snapshot, session, or runtime. `runtime.capabilities` returns `not_found` for a missing runtime and `invalid_argument` when the supplied agent belongs to another runtime. Later option application uses `unsupported` for closed gates or unsupported settings and `provider_unavailable` when the provider cannot be reached.

## Security invariants

- Loopback-only listener and random per-process capability; no LAN exposure.
- Capability is memory-only and passed to the desktop shell only through daemon stdout at startup.
- Renderer never receives the capability or connects directly to the daemon.
- Process launch is direct executable plus argument array. User input never becomes shell text.
- Logs redact secrets and exclude prompt bodies by default.
- SQLite and runtime records never receive provider login credentials.
- Claude hook bridge has a bounded request and timeout and fails open when daemon IPC is unavailable.
- Permission replies use a pending→resolved conditional update; duplicate replies return `conflict` and never reach the provider twice.
- Budget admission reads applicable usage and reservations, then inserts a reservation in one `BEGIN IMMEDIATE` transaction. The strictest applicable hard policy governs; simultaneous prompts cannot share the same remaining allowance.

## Runtime hardening additions

- `runtime.capabilities` adds `versionRecognized: boolean`, the runtime's version-format recognition result.
- `turn.error.failureClass` may be `context`; its safe message is `Context window is full. Start a new conversation.` and `canRetireSession` is true. The provider-session ID remains intact on context exhaustion.
- Mixed-currency analytics keep each currency's valuation separately. The scalar cost is null when currencies are mixed; `excludedCurrencies` lists currencies after the first sorted currency because the scalar shape cannot represent them. `lowerBound` is true for mixed currency totals.
- `session.resume_rejected` reports positive evidence that a stored provider session is missing or expired. The daemon clears that provider ID and starts a fresh session; generic resume errors do not clear it.
- The daemon's startup/no-progress watchdog is 45 seconds; after the first semantic activity, its semantic-inactivity watchdog is 300 seconds. These are Bloblex product choices, not provider CLI facts. Expiry fails the turn with `failureClass: timeout` and closes the adapter session, which kills its owned process tree.
- Resume-time context overflow emits `session.context_exhausted` with the safe message and retirement offer; it does not clear the provider-session ID.
