# Bloblex daemon IPC contract (v1)

This is the integration contract between `bloblexd.exe` and the desktop shell. The daemon is authoritative; UI state is reconstructed from `app.snapshot` and subsequent ordered events.

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
| `settings.set` | `{ "key": string, "value": any }` | Persist a preference; credential fields are rejected. |
| `session.list` | `{}` | Persisted sessions. |
| `session.get` | `{ "sessionId": string }` | Session with ordered turns, messages, tool cards and file changes. |
| `session.new` | `{ "agentId"?: string, "runtimeId"?: string, "projectPath": string, "title"?: string }` | Exactly one of `agentId` or `runtimeId` is required. Agent selection derives its runtime; legacy runtime-only creation leaves `agentId:null`. |
| `agent.list` | `{ "includeArchived"?: boolean, "runtimeId"?: string }` | `{ "agents": Agent[] }`; active agents by default, ordered by runtime and sort position. |
| `agent.get` | `{ "agentId": string }` | `{ "agent": Agent }`; returns active or archived agent. |
| `agent.create` | `{ "name": string, "runtimeId": string, "description"?: string, "instructions"?: string, "color"?: string, "model"?: string|null, "thinking"?: string|null, "serviceTier"?: string|null, "customArgs"?: string[], "customEnv"?: object, "maxConcurrency"?: integer, "defaultProject"?: string|null }` | `{ "agent": Agent }`; appends an active agent for the runtime. |
| `agent.update` | `{ "agentId": string, "name"?: string, "runtimeId"?: string, "description"?: string, "instructions"?: string, "color"?: string, "model"?: string|null, "thinking"?: string|null, "serviceTier"?: string|null, "customArgs"?: string[], "customEnv"?: object, "maxConcurrency"?: integer, "defaultProject"?: string|null }` | `{ "agent": Agent }`; omitted fields remain unchanged, explicit nullable fields clear their values, and archived agents cannot be edited. |
| `agent.delete` | `{ "agentId": string }` | `{ "agent": Agent }`; soft archives the agent and compacts active order. |
| `agent.reorder` | `{ "runtimeId": string, "agentIds": string[] }` | `{ "agents": Agent[] }`; replaces the full active order for the runtime. |
| `session.resume` | `{ "sessionId": string }` | Resumes only when the adapter advertises support; otherwise returns `unsupported`. |
| `session.prompt` | `{ "sessionId": string, "text": string }` | Starts a turn after atomic budget admission. Prompt body is sent over authenticated IPC/protocol, never argv. |
| `session.cancel` | `{ "sessionId": string, "turnId"?: string }` | Requests provider cancellation and reports whether the provider supports it. |
| `session.close` | `{ "sessionId": string }` | Closes managed adapter process; persisted session remains. |
| `permission.reply` | `{ "permissionId": string, "choice": string }` | Choice is an opaque provider-supported option ID from that request; the provider adapter must receive and acknowledge it before Bloblex marks it resolved. |
| `usage.summary` | `{ "from": string, "to": string, "scope"?: object }` | Raw token totals and separate known/unknown valuations; subscription fees are not API estimates. |
| `pricing.list` | `{ "provider"?: string }` | Effective pricing rules including source and aliases. |
| `pricing.override` | `{ "rule": PricingRule }` | Save user-defined pricing, visibly marked as an override. |
| `subscription.list` | `{}` | User-entered plan fees, separated from token estimates and quota (`unknown` unless measured). |
| `subscription.save` | `{ "plan": SubscriptionPlan }` | Save provider, currency, fixed monthly amount and renewal day. |
| `budget.list` | `{}` | `{ "policies": Budget[] }` with active reservations where available. |
| `budget.set` | policy object | Persists a policy; most restrictive applicable hard cap wins. |
| `budget.delete` | `{ "policyId": string }` | Removes that policy. |

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

`app.snapshot` returns `{snapshotVersion,sequence,daemon,hosts,runtimes,agents,sessions,permissions,usageSummary,budgets,settings}`. `agents` includes active and archived `Agent` rows. `budgets` is a `Budget[]`; `budget.list` wraps the same array in `{policies}`. Session turn/message/tool/file arrays are ordered and omit provider raw payloads. `session.get` returns the same nested session DTO. Long transcripts may be paged in later protocol versions.

`Agent` fields are `{id,name,description,instructions,color,runtimeId,model,thinking,serviceTier,customArgs,customEnv,maxConcurrency,defaultProject,sortOrder,archived,createdAt,updatedAt}`. Session DTOs include nullable `agentId` while `runtimeId` remains required. `agent.changed` events carry `{action,agentId,runtimeId,updatedAt,archived,sortOrder}`; the safe event projection excludes instructions, custom environment values and custom arguments. In addition to agent RPC mutations, runtime discovery emits action `created` when it adds a default agent for a runtime with no agent rows; archived rows count and suppress recreation. Events are persisted with the mutation and replayed by the global sequence cursor.

`usageSummary` fields are `{from,to,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens,providerReportedCostMinor,providerReportedCurrency,apiEstimateMinor,apiEstimateCurrency,pricingStatus,subscriptionFixedMinor,subscriptionCurrency,quotaState}`. Pricing rules are `{id,provider,canonicalModelId,aliases,inputPerMillion,outputPerMillion,cacheReadPerMillion,cacheWritePerMillion,currency,effectiveFrom,effectiveTo,sourceUrl,isUserOverride}`. Subscription plans are `{id,provider,billingMode:"subscription",currency,monthlyMinor,renewalDay,quotaState}`.

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

The normalized event vocabulary is `runtime.changed`, `agent.changed`, `session.changed`, `message.delta`, `message.completed`, `tool.changed`, `file.changed`, `command.changed`, `permission.requested`, `permission.resolved`, `usage.updated`, `budget.warning`, `budget.blocked`, `turn.completed`, `turn.cancelled`, `turn.error`, and `daemon.health`. Streamed and finalized messages carry the same stable `id`/`messageId`; `session.changed` carries a full session DTO. Unsupported semantics remain unsupported; never synthesize provider success, auth, usage or permission grants.

Usage token buckets are mutually exclusive: `inputTokens` excludes `cacheReadTokens` and `cacheWriteTokens`; output, reasoning and provider-reported cost are separately nullable. Valuation basis is `provider_reported_actual`, `api_rate_estimate`, `subscription_fixed`, `local_free`, or `unknown`. Unknown model price serializes as `null` with an explanatory status, never zero.

## Errors and compatibility

Stable error codes: `invalid_argument`, `not_found`, `unauthorized`, `unsupported`, `provider_unavailable`, `provider_error`, `budget_blocked`, `conflict`, `replay_gap`, and `internal`. Error messages are safe for display and contain no credential material or prompt text. A client must compare `v`; an unsupported major version is a startup error. Adapter capability omissions mean unsupported.

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
