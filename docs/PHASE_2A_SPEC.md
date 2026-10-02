# Phase 2a implementation spec: agent identity, storage and RPCs

This spec is the implementation contract for Phase 2a of [E2E_PLAN_V2.md](E2E_PLAN_V2.md). Phase 2a creates persisted agent identities, links new sessions to them, migrates existing rows, and exposes the normalized daemon contract. The execution-profile columns are persisted as data for the model in the plan, but they are inert in 2a: no adapter receives them and `session.new` accepts no execution options.

## Existing code and boundaries

The implementation must build on these current facts. Line citations are to the source state reviewed for this spec:

- Storage opens SQLite, enables foreign keys, uses WAL and `synchronous=FULL`, creates a `schema_migrations` ledger and current tables at [crates/bloblex-storage/src/lib.rs:25-62](../crates/bloblex-storage/src/lib.rs). Current `sessions` and `usage_events` schemas are at [crates/bloblex-storage/src/lib.rs:38-45](../crates/bloblex-storage/src/lib.rs). Existing migration compatibility checks use column inspection and conditional `ALTER TABLE` at [crates/bloblex-storage/src/lib.rs:63-83](../crates/bloblex-storage/src/lib.rs).
- Session persistence currently inserts `sessions` without an agent link, session listing reads its columns, and usage insertion writes provider usage in an immediate transaction at [crates/bloblex-storage/src/lib.rs:152-192](../crates/bloblex-storage/src/lib.rs).
- `app.snapshot` currently reads the global event sequence, runtimes, sessions, permissions, usage summary, budgets and settings at [crates/bloblex-storage/src/lib.rs:743-790](../crates/bloblex-storage/src/lib.rs). Persisted event sequence and timestamp are assigned in `push_event` at [crates/bloblex-storage/src/lib.rs:89-102](../crates/bloblex-storage/src/lib.rs).
- RPC request/response/error and event envelopes use camelCase JSON, with event `type` serialized explicitly, in [crates/bloblex-protocol/src/lib.rs:6-45](../crates/bloblex-protocol/src/lib.rs). Daemon dispatch is a method match and existing error mapping uses `invalid_argument`, `not_found`, `unsupported`, `provider_error` and `internal` at [crates/bloblex-daemon/src/main.rs:151-170](../crates/bloblex-daemon/src/main.rs) and [crates/bloblex-daemon/src/main.rs:215-224](../crates/bloblex-daemon/src/main.rs).
- `AppState::emit` persists an event before broadcasting its envelope at [crates/bloblex-daemon/src/main.rs:60-72](../crates/bloblex-daemon/src/main.rs). Snapshot/event replay uses the global sequence cursor; event payloads are delivered from persisted envelopes. The existing storage replay path is at [crates/bloblex-storage/src/lib.rs:103-150](../crates/bloblex-storage/src/lib.rs).
- `session.new` currently accepts `runtimeId`, validates an existing project directory and a discovered runtime, defaults a missing/blank title to `New chat`, persists the session before asking the adapter to start, and emits `session.changed` at [crates/bloblex-daemon/src/main.rs:451-542](../crates/bloblex-daemon/src/main.rs). The adapter request itself currently contains only `session_id` and `project_path` at [crates/bloblex-agent-core/src/lib.rs:50-55](../crates/bloblex-agent-core/src/lib.rs).
- The TypeScript mirror currently has `Snapshot` arrays for runtimes/sessions/etc. and a `Session` with required `id` and `runtimeId` at [apps/desktop/src/types.ts:3-15](../apps/desktop/src/types.ts) and [apps/desktop/src/types.ts:42-60](../apps/desktop/src/types.ts). Its event reducer applies sequence ordering and currently handles runtime/session changes at [apps/desktop/src/types.ts:100-129](../apps/desktop/src/types.ts).
- Tauri's `daemon_rpc` forwards method and params unchanged to the daemon and updates the event cursor only for `app.snapshot` at [apps/desktop/src-tauri/src/lib.rs:368-381](../apps/desktop/src-tauri/src/lib.rs). Phase 2a needs no special native command.
- The IPC contract defines protocol version 1 envelopes, capability-authenticated loopback transport, snapshot/replay behavior and current `session.new` request shape at [docs/ipc-contract.md:15-45](ipc-contract.md) and [docs/ipc-contract.md:47-70](ipc-contract.md). It specifies snapshot and session DTO fields at [docs/ipc-contract.md:82-100](ipc-contract.md), safe error codes and security rules at [docs/ipc-contract.md:121-135](ipc-contract.md).
- Current fallback provider colors are `#f38c6f` for Claude, `#82aaff` for Codex, `#bf9cff` for OpenCode and `#89d6b3` for other runtimes at [apps/desktop/src/types.ts:87-93](../apps/desktop/src/types.ts). The current source does not define a canonical 12-swatch identity palette; the existing character preview lists those four provider colors plus `#e6e9ee` at [apps/desktop/src/preview/main.tsx:10-17](../apps/desktop/src/preview/main.tsx).

## Data schema

### Migration version and backup

The current database records migration 1 in `schema_migrations`; it does not currently read or write `PRAGMA user_version` ([crates/bloblex-storage/src/lib.rs:32-38](../crates/bloblex-storage/src/lib.rs), [crates/bloblex-storage/src/lib.rs:55-62](../crates/bloblex-storage/src/lib.rs)). Implement this as migration **2**. Within the same successful migration transaction, insert `schema_migrations(version=2, applied_at=<UTC RFC3339>)` and set `PRAGMA user_version = 2`. Read both values on open: accept 0 as the legacy/uninitialized pragma on an existing v1 database; otherwise require the values to agree. Never downgrade automatically.

Before migration 2 modifies the database, make a verified SQLite online-backup copy while the connection is open. The normal database is `%LOCALAPPDATA%\Bloblex\bloblex.db`; when `LOCALAPPDATA` is unavailable, the daemon falls back to `%TEMP%\Bloblex\bloblex.db`. `BLOBLEX_DB_PATH` overrides either default ([crates/bloblex-daemon/src/main.rs:1064-1076](../crates/bloblex-daemon/src/main.rs)). Store the backup beside the database under `<database parent>\backups\bloblex-pre-agents-<UTC yyyyMMddTHHmmss.fffffffZ>.db`. Use SQLite's online backup API so WAL content is included; enable rusqlite's `backup` feature on the existing workspace dependency for this migration (it currently enables `bundled` and `chrono` only; [Cargo.toml:33](../Cargo.toml)). Do not copy a live `.db` file with filesystem copy and do not open, replace or delete a live sidecar.

Verify the completed backup before migration by opening the copy read-only, requiring `PRAGMA integrity_check` to return exactly `ok`, confirming migration version 1 and comparing row counts for every existing table with the source connection. Write a non-secret manifest to `<database parent>\backups\bloblex-pre-agents-<same UTC timestamp>.manifest.json` containing the source path, backup path, timestamp, schema version, integrity result and table row counts. If backup or verification fails, abort before schema changes. Retain backups and manifests without automatic pruning; an operator can remove them only after a later verified backup exists. This is a one-time safety artifact, not a test fixture.

### Exact schema additions

The `agents` columns below implement the target data model in E2E_PLAN_V2.md. Execution-related columns are stored now but have no runtime effect in Phase 2a. Add the table and indexes inside migration 2:

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
  name_key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 255),
  instructions TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'mint'
    CHECK (
      color IN ('coral','orange','amber','lemon','lime','mint','teal','cyan','sky','blue','violet','pink')
      OR color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'
    ),
  runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE RESTRICT,
  model TEXT,
  thinking TEXT,
  service_tier TEXT,
  custom_args TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(custom_args) AND json_type(custom_args) = 'array'),
  custom_env TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(custom_env) AND json_type(custom_env) = 'object'),
  max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrency BETWEEN 1 AND 50),
  default_project TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_agents_active_name ON agents(name_key) WHERE archived = 0;
CREATE UNIQUE INDEX idx_agents_active_runtime_order ON agents(runtime_id, sort_order) WHERE archived = 0;
CREATE INDEX idx_agents_runtime_archived_order ON agents(runtime_id, archived, sort_order, created_at, id);
```

Then add nullable agent links and indexes:

```sql
ALTER TABLE sessions
  ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE usage_events
  ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX idx_sessions_agent_updated ON sessions(agent_id, updated_at);
CREATE INDEX idx_usage_agent_time ON usage_events(agent_id, timestamp);
```

SQLite requires a nullable column with no non-NULL default when adding a REFERENCES column under foreign-key enforcement. Keep those columns nullable so legacy sessions whose runtime row is absent remain readable. `agent_id` is `NULL` for those rows and for unassociated legacy runtime-only session creation. Archive is a soft state; no archive operation deletes the agent or its sessions.

The color constraint defines the 12 stable swatch keys. Their rendered hex values are a Phase 3 design constant; `#RRGGBB` values are also accepted. The current code supplies provider fallback colors, not a full 12-swatch palette. Phase 3 must publish one name-to-hex map and use it consistently; do not infer the missing eight colors from this storage task.

`name_key` is the trimmed name converted with Rust Unicode `to_lowercase()` and is used only for uniqueness; the display `name` retains trimmed casing. IDs are lowercase UUID v4 strings, matching existing daemon-generated session IDs ([crates/bloblex-daemon/src/main.rs:478-483](../crates/bloblex-daemon/src/main.rs)). Timestamps are UTC RFC3339 with millisecond precision and `Z`, matching persisted event timestamps ([crates/bloblex-storage/src/lib.rs:93-100](../crates/bloblex-storage/src/lib.rs)); all create/update/archive operations use one timestamp per transaction. `updated_at` changes whenever a mutable agent field, sort position or archive state changes.

`sort_order` is a zero-based dense order among active agents for each runtime. Creation appends at `max(sort_order)+1` for that runtime. `agent.reorder` replaces the complete order for one runtime in a transaction; archived agents are excluded and retain their last position. Archive must therefore leave the archived row at its original `sort_order`: perform the two-phase shift only on the REMAINING active rows (exclude the target), then compact them. The archived row is outside the partial unique index, so its stored value may equal an active slot (Director amendment after QA finding F1). Reordering compacts active values to `0..n-1`. Moving an agent to a different runtime appends it there and compacts the old runtime. A uniqueness collision or incomplete reorder rolls back the whole transaction.

**Implementation trap (Director-verified on SQLite):** `idx_agents_active_runtime_order` is checked per row, not deferred to commit, so updating `sort_order` row by row to swap or shift positions fails mid-transaction with `UNIQUE constraint failed: agents.runtime_id, agents.sort_order` (a naive two-row swap was reproduced failing). Every operation that changes active positions (reorder, archive-compaction, runtime change, create-at-position) must therefore use a two-phase update inside its transaction: first move all affected active rows of that runtime to a disjoint high range in one statement (`UPDATE agents SET sort_order = sort_order + 1000000 WHERE runtime_id = ?1 AND archived = 0`; the `>= 0` CHECK is why the shift goes upward, not negative), then assign the final dense `0..n-1` values. Add a storage test that performs a swap, a rotate-by-one and an archive-compaction on three or more agents in one runtime and asserts the final order, so a naive implementation fails the test.

Do **not** create `exec_snapshots`, turn/session snapshot columns, provider model-catalog tables, concurrency reservation tables or adapter execution-option fields. Per-turn execution snapshots belong to 2b. The agent profile's `model`, `thinking`, `service_tier`, `custom_args`, `custom_env`, and `max_concurrency` columns are inert 2a configuration values only; 2a does not validate them against a provider or apply them.

### Migration and backfill procedure

1. Open the selected DB with foreign keys enabled. If migration 2 is pending, make and verify the timestamped backup described above **before any DDL or DML**.
2. Start `BEGIN IMMEDIATE`; re-read schema migration and pragma versions under the write lock. If version 2 is already complete, commit/no-op. If another unsupported version or mismatched nonzero version is present, abort with no changes.
3. Create `agents` and its indexes; add `sessions.agent_id` and `usage_events.agent_id`; add their indexes. These operations and all backfill writes are within the migration transaction.
4. For each row in `runtimes` ordered by `provider, id`, insert exactly one initial active agent if there is not already an agent with that runtime and the migration marker is absent. Use UUID v4 ID; name `Claude`, `Codex`, `OpenCode`, or title-cased provider name, adding ` (2)`, ` (3)` as needed to avoid an active-name collision. Use the provider fallback colors from `providerColor` for Claude, Codex, OpenCode and `other` runtimes, stored in the canonical **uppercase** form like every other hex value (`#F38C6F`, `#82AAFF`, `#BF9CFF`, `#89D6B3`; Director amendment 2 Oct 2026 after QA finding F5: create/update normalize to uppercase, so the migration must too). Set description to `Default agent for <provider display name>.`, empty instructions, null execution/model values, `max_concurrency=1`, null default project, `sort_order` to the next active slot for that runtime, `archived=0`, and equal UTC `created_at`/`updated_at` values. These hex colors satisfy the schema's custom-color format and are sourced at [apps/desktop/src/types.ts:87-93](../apps/desktop/src/types.ts).
5. If there is no `runtimes` row for a session's `runtime_id`, do not invent a runtime or agent. Leave that session's new `agent_id` null. For each session whose runtime does have an active agent, set `sessions.agent_id` to that runtime's first-created active default agent (`created_at`, then `id` as deterministic tie-break) only where `agent_id IS NULL`.
6. Backfill each `usage_events.agent_id` from its referenced session's `agent_id`, only where usage `agent_id IS NULL`. If the session row is absent or its `agent_id` is null, preserve null; never guess from a runtime or provider.
7. Run `PRAGMA foreign_key_check` and require zero rows. Check each non-null session/usage agent link resolves, and verify session and usage row counts are unchanged. Insert migration ledger version 2, set `PRAGMA user_version=2`, then commit. If any check fails, roll back.
8. Reopen the DB read-only and confirm both version markers are 2, integrity check passes, foreign keys pass, and backfilled rows are present. This final verification is additional to (not a replacement for) the pre-migration backup verification.

The migration must be idempotent: after version 2 commits, a second `Storage::open` must not create more agents, change the backfill mapping, rewrite timestamps, or advance schema markers.

**Director amendment (2 Oct 2026): default agent on first discovery.** After runtime discovery has upserted all discovered runtimes, ensure each runtime with no agent rows receives one default agent using the same naming, provider colour, description and dense sort-order rules as migration 2. Any existing row counts, including archived agents, so archiving every agent for a runtime does not recreate one. Persist one `agent.changed` event with action `created` per newly created agent in the same immediate transaction and broadcast the committed envelopes.

**Rollback:** stop the daemon cleanly so SQLite has no open writer; preserve the failed migrated DB and its logs under a timestamped `failed-migration` name for diagnosis; restore the verified pre-migration backup to the configured DB path using a temporary sibling followed by atomic replacement. Do not restore over an open DB or manipulate its live `-wal`/`-shm` sidecars. Reopen the restored file read-only and verify integrity, version 1, and row counts before restarting. Keep the backup. Tests must use isolated temporary databases and must never touch the live inspection app database or any locked sidecar.

## Agent RPC and event contracts

All methods use the existing v1 envelope: request `{ "v":1, "id":"req_...", "method":"agent.list", "params":{} }`, success `{ "v":1, "id":"req_...", "ok":true, "result":{...} }`, and failure `{ "v":1, "id":"req_...", "ok":false, "error":{"code":"invalid_argument","message":"..."} }`. The request id is echoed. These envelope fields match [docs/ipc-contract.md:21-45](ipc-contract.md) and [crates/bloblex-protocol/src/lib.rs:6-33](../crates/bloblex-protocol/src/lib.rs).

The shared `Agent` DTO is exactly:

```json
{
  "id":"uuid-v4",
  "name":"Codex",
  "description":"Default agent for Codex.",
  "instructions":"",
  "color":"mint",
  "runtimeId":"runtime-id",
  "model":null,
  "thinking":null,
  "serviceTier":null,
  "customArgs":[],
  "customEnv":{},
  "maxConcurrency":1,
  "defaultProject":null,
  "sortOrder":0,
  "archived":false,
  "createdAt":"2026-10-02T12:00:00.000Z",
  "updatedAt":"2026-10-02T12:00:00.000Z"
}
```

Common validation:

- `name` is trimmed, required, 1–60 Unicode scalar values, and unique among non-archived agents by `name_key` (Rust Unicode lowercase). Duplicate active names return `conflict`.
- `description` is at most 255 Unicode scalar values; empty is allowed. `instructions` may be empty or long text and must not contain NUL; neither it nor env values are logged or copied to events outside the returned Agent DTO. Avoid emitting instruction text in operational logs.
- `color` is one of the 12 lowercase swatch keys (`coral`, `orange`, `amber`, `lemon`, `lime`, `mint`, `teal`, `cyan`, `sky`, `blue`, `violet`, `pink`) or exact six-digit `#RRGGBB`; hex is normalized uppercase. `#RGB`, alpha, malformed hex and unknown swatch keys are invalid.
- `runtimeId` must identify a currently stored runtime row. Missing runtime gives `not_found`. A runtime row may be offline; that is still a valid persisted identity.
- `customArgs` must be a JSON array of strings; preserve values without shell parsing. `customEnv` must be a JSON object with environment-variable-shaped keys and string values; reject secret-looking key names and never log values. These fields are inert in 2a and do not establish the Phase 2b custom-argument or environment allowlists.
- Unknown fields are ignored for forward compatibility. Wrong JSON types, missing required fields, invalid bounds and malformed IDs give `invalid_argument`. A nonexistent ID gives `not_found`. Storage/serialization failures give `internal`. Messages are safe, concise, and contain no prompt or credential values.

### Methods

| Method | Exact params | Success result | Behavior |
|---|---|---|---|
| `agent.list` | `{ "includeArchived"?: boolean, "runtimeId"?: string }` | `{ "agents": Agent[] }` | Defaults to active agents only; optional runtime filter. Sort by `runtimeId`, `sortOrder`, `createdAt`, `id`. `includeArchived:true` includes archived rows in the same deterministic order. |
| `agent.get` | `{ "agentId": string }` | `{ "agent": Agent }` | Returns archived or active agent; missing ID gives `not_found`. |
| `agent.create` | `{ "name": string, "runtimeId": string, "description"?: string, "instructions"?: string, "color"?: string, "model"?: string|null, "thinking"?: string|null, "serviceTier"?: string|null, "customArgs"?: string[], "customEnv"?: object, "maxConcurrency"?: integer, "defaultProject"?: string|null }` | `{ "agent": Agent }` | Apply common validation, defaults from the DTO, generate ID/timestamps, append sort order for runtime. Execution-shaped values are stored without provider validation and are not applied in 2a. |
| `agent.update` | `{ "agentId": string, "name"?: string, "runtimeId"?: string, "description"?: string, "instructions"?: string, "color"?: string, "model"?: string|null, "thinking"?: string|null, "serviceTier"?: string|null, "customArgs"?: string[], "customEnv"?: object, "maxConcurrency"?: integer, "defaultProject"?: string|null }` | `{ "agent": Agent }` | Partial update; omitted fields retain their values, explicit nullable values clear nullable columns. Archived rows cannot be edited (`conflict`; use restore only if later specified). Runtime changes preserve historical sessions' old `runtimeId` and `agentId`; new sessions use the agent's new runtime. Recompact both runtime orders on runtime change. |
| `agent.delete` | `{ "agentId": string }` | `{ "agent": Agent }` | Soft archive: set `archived=true`, update timestamp, compact active order. Repeated archive is idempotent and returns the archived row. It never deletes sessions, turns, usage or the agent row. |
| `agent.reorder` | `{ "runtimeId": string, "agentIds": string[] }` | `{ "agents": Agent[] }` | The IDs must contain every active agent for that runtime exactly once and no archived, foreign-runtime or unknown ID. Assign dense zero-based positions in supplied order atomically. Invalid membership returns `invalid_argument`; runtime not found returns `not_found`. Empty list is valid only when no active agents remain. |

The active daemon capability remains the authorization boundary: these methods are available only through the same authenticated loopback RPC path as current methods. There are no per-agent capability tokens or new role checks. Missing/invalid bearer capability is rejected by existing transport authorization before dispatch; do not return agent data before auth. The IPC contract's capability handling and safe errors are at [docs/ipc-contract.md:11-17](ipc-contract.md) and [docs/ipc-contract.md:121-135](ipc-contract.md).

Use the existing stable codes: `invalid_argument` (HTTP 400), `not_found` (404), `conflict` (409), and `internal` (500). Do not turn FK errors or uniqueness failures into opaque `internal`: map known validation constraints to their stable public codes. No `agent.*` method starts an adapter.

### `agent.changed`

Every successful create, update, archive or reorder emits one persisted `agent.changed` event per changed agent after its transaction commits. Event envelope is the existing shape `{ "v":1, "eventId":"...", "sequence":N, "timestamp":"...Z", "type":"agent.changed", "payload":{...} }`. Payload is `{ "action":"created"|"updated"|"archived"|"reordered", "agentId": string, "runtimeId": string, "updatedAt": string, "archived": boolean, "sortOrder": integer }`. Reorder emits one event for each agent whose sort order actually changed, in final order. No event is emitted for a no-op update/reorder or repeated archive. The payload intentionally excludes instructions, custom environment values and custom arguments; clients fetch the full row through `agent.get` when needed. Do not put raw SQL, provider objects or credentials in the payload.

Persist the row changes and corresponding `app_events` entries in the same SQLite transaction; after commit, broadcast those already-sequenced envelopes. This closes the mutation/event gap while preserving the daemon-global monotonic sequence and replay contract. The current `push_event` assigns the sequence on persistence and `AppState::emit` then broadcasts ([crates/bloblex-storage/src/lib.rs:89-102](../crates/bloblex-storage/src/lib.rs), [crates/bloblex-daemon/src/main.rs:60-72](../crates/bloblex-daemon/src/main.rs)). A concurrent snapshot sees either the state and events before a mutation or the state after it with sequence at least the corresponding event; it must never expose new agent data with a cursor below its change event.

## `session.new` by `agentId`

Add optional `agentId` while retaining the existing request form. Exact 2a params are `{ "agentId"?: string, "runtimeId"?: string, "projectPath": string, "title"?: string }`; exactly one of `agentId` or `runtimeId` is required. Supplying both is `invalid_argument`.

- With `agentId`, load an active agent or return `not_found` if absent and `conflict` if archived. Derive `runtimeId` from that agent and validate the runtime remains in the daemon's discovered runtime set as current `session.new` does. Do not permit caller-supplied runtime override.
- With legacy `runtimeId`, retain current behavior: require a discovered runtime, and create the session with `agentId:null`. This avoids arbitrarily attaching an old client to one of potentially many agents on that runtime. Runtime-only sessions remain fully usable and can be distinguished from agent-owned sessions.
- In both forms, `projectPath` must be an existing directory; preserve the current `invalid_argument` result for a missing directory. Persist the supplied project path using the daemon's current `PathBuf` string conversion; do not canonicalize it. `title` absent or trim-empty becomes `New chat`; a nonempty title is persisted exactly as supplied (the current code tests `trim()` only to detect blank input). Do not add model, effort, service tier, instructions, args, environment, concurrency or snapshot params to `session.new` in this phase.
- Persist `sessions.agent_id` in the same session-create operation, before adapter startup, so later usage rows can join through the session. Return `agentId` as string or null in the session DTO and `session.changed` payload. The runtime/provider continue to identify the actual adapter session.
- If the agent is archived after creation, its existing sessions remain linked and resumable; only new sessions are blocked. Archival does not terminate active sessions.
- When inserting each later `usage_events` row, derive `agent_id` from the persisted `sessions.agent_id` using the event's `sessionId` inside the same immediate storage transaction. Ignore any caller-supplied agent ID. Null session link, missing session or legacy runtime-only session yields null. This keeps usage attribution aligned with the persisted session owner.

The legacy method and existing project/title behavior are documented in [docs/ipc-contract.md:62-66](ipc-contract.md) and visible in the current daemon implementation at [crates/bloblex-daemon/src/main.rs:451-498](../crates/bloblex-daemon/src/main.rs). Update the IPC contract's session request and DTO examples with optional `agentId` and nullable response `agentId` as part of 2a.

## Snapshot, events and desktop types

- Add `agents: Agent[]` to `app.snapshot`, including archived agents so the snapshot is complete and clients can represent archive changes without an extra list call. Keep existing snapshot fields and `snapshotVersion:1`; adding an optional field is backward compatible. The current snapshot builder's fields are at [crates/bloblex-storage/src/lib.rs:743-781](../crates/bloblex-storage/src/lib.rs), and the IPC contract's canonical snapshot fields are at [docs/ipc-contract.md:98-100](ipc-contract.md).
- Snapshot `sequence` remains the daemon-global highest persisted `app_events.sequence`. Build agents and sequence from one SQLite read transaction. On subscribe/replay, the existing `afterSequence` protocol remains unchanged: agent changes are replayed by sequence; on replay gap, clients fetch a new snapshot. The contract for sequence/replay is at [docs/ipc-contract.md:17-17](ipc-contract.md) and current Tauri cursor update is [apps/desktop/src-tauri/src/lib.rs:368-381](../apps/desktop/src-tauri/src/lib.rs).
- Add `agent.changed` handling to the desktop event reducer. Preserve the event sequence and update the matching row's safe projection (`runtimeId`, `updatedAt`, `archived`, `sortOrder`); then fetch `agent.get` to refresh its full row. For archived entries keep the row in snapshot state but let active roster selectors filter `archived`. Events arriving at or below the snapshot cursor are ignored as today.
- Add TypeScript interfaces: `Agent { id: string, name: string, description: string, instructions: string, color: string, runtimeId: string, model: string | null, thinking: string | null, serviceTier: string | null, customArgs: string[], customEnv: Record<string,string>, maxConcurrency: number, defaultProject: string | null, sortOrder: number, archived: boolean, createdAt: string, updatedAt: string }`; `Snapshot.agents?: Agent[]`; `Session.agentId?: string | null`. Keep current `Session.runtimeId` required for wire compatibility.
- Update `apps/desktop/src/preview/fixtureBridge.ts` with fixture agents and session `agentId`s. Current fixture sessions and snapshot are defined at [apps/desktop/src/preview/fixtureBridge.ts:1-43](../apps/desktop/src/preview/fixtureBridge.ts); this is fixture/type wiring only, no roster/editor UI in 2a.

## Test plan and required verification

All database tests use a fresh temp directory and a fixture database with the exact current schema (migration version 1 and existing tables/columns), populated with multiple runtimes, sessions, usage rows, one session whose runtime row is missing, and stable historical timestamps. Never point tests at `%LOCALAPPDATA%\Bloblex\bloblex.db`, `BLOBLEX_DB_PATH` for the live app, or any live `-wal`/`-shm` file. The running inspection app's database and locked sidecars are never touched by tests.

Concrete Rust tests:

1. `crates/bloblex-storage`: migration from the current v1 fixture adds exact columns/indexes/constraints; provider defaults are created once; sessions and usage rows backfill to the expected agent; missing runtime/session links remain null; old rows and timestamps remain intact.
2. Migration idempotency: opening the migrated fixture repeatedly preserves agent count, IDs, attribution, timestamps, `schema_migrations=2` and `user_version=2`.
3. Backup creation/verification: the migration path produces the timestamped backup, `integrity_check=ok`, matching v1 migration marker and matching pre-migration counts; failure to verify aborts before DDL.
4. Rollback procedure helper/integration test using only temp paths: restore verified backup after a simulated failed migration, then assert v1 schema and counts. Do not exercise rollback on the live app database.
5. Agent storage validation: active name uniqueness case-insensitively, archived-name reuse, description/name bounds, named swatch/hex validation, FK runtime existence, sort append/reorder/compaction and atomic rollback.
6. Daemon RPC tests for every `agent.*` method: exact params/result envelopes, invalid fields, not found, conflict, authorization through existing capability middleware, event payload and event sequence.
7. `session.new` by active `agentId` selects the agent runtime and persists/returns `agentId`; legacy `runtimeId` still works with null agent; both/neither inputs reject; project/title behavior is stable; archived agent creation is rejected while existing sessions remain.
8. Usage insertion derives agent attribution from the session and ignores a mismatched supplied `agentId`; missing and runtime-only sessions persist null. Assert `agent.changed` payloads contain no instructions, custom environment values or custom arguments.
9. Snapshot includes active and archived agents, nullable session links, and a sequence consistent with `agent.changed`; replay reproduces changes after a snapshot cursor.

Desktop updates: extend `apps/desktop/src/types.ts` and fixtures in `apps/desktop/src/preview/fixtureBridge.ts`; add a reducer fixture proving `agent.changed` upsert/archive handling and sequence dedupe. Do not build agent editor UI in this phase.

Required commands from repository root (run after implementation; this documentation task does not run them):

```powershell
cargo test -p bloblex-storage
cargo test -p bloblex-daemon
cargo test -p bloblex-protocol
npm run typecheck --prefix apps/desktop
npm run test --prefix apps/desktop
npm run build --prefix apps/desktop
```

The implementer records command exit codes and test counts. Do not claim independent QA or native behavior from these commands; QA reruns the relevant checks against the reviewed diff. Do not run tests against or restart the live inspection app.

## Risks and open questions

- **Palette gap:** current code has four provider fallback colors and a fifth preview color, not the canonical 12 named swatches. This spec chooses stable swatch keys and requires Phase 3 to provide the rendered 12-color map. The exact hex values for the other swatches remain a design decision, not a migration blocker.
- **Default naming collisions:** runtime discovery can expose multiple runtimes for one provider; use deterministic suffixes and keep case-insensitive active uniqueness. Runtime ids are opaque and are not names.
- **Backup placement under a custom DB path:** this spec puts backups in a sibling `backups` directory. Ensure the directory is writable before any migration; otherwise abort safely. Do not silently move the backup to a different volume.
- **Migration version marker:** the current implementation uses `schema_migrations` but not `PRAGMA user_version`; migration 2 is the first synchronized value. Existing DBs may have pragma value 0 even when ledger version is 1, which this spec explicitly accepts.
- **Wire compatibility:** existing desktop clients may send only `runtimeId`; preserve that request path and represent the new session field as nullable/optional.
- **Event atomicity:** current mutation persistence and `AppState::emit` are separate operations. Implement a storage transaction that returns persisted event envelopes, then broadcast them, so a crash cannot commit an agent row without its replay event.

Genuine questions for the Director: none block the storage/RPC implementation. The 12 swatch rendered hex values should be chosen with Phase 3 design. Any desire for old `runtimeId` session requests to auto-select an agent should be a future explicit API contract; this spec keeps them unowned to avoid guessing.

## Out of scope for Phase 2a

- Applying model, effort/thinking, service tier, instructions, custom args/env or concurrency to provider processes.
- `ExecOptions`, adapter mapping, model catalog discovery, provider-specific validation, concurrency enforcement/queueing, usage interpretation changes, and per-turn execution snapshots.
- Any `exec_snapshots` or first/latest execution snapshot columns or tables.
- Agent roster/editor UI, session tree UI, native UI/browser interaction or design changes beyond TypeScript types and fixture data/reducer coverage.
- Phase 3, 4, 2b, analytics, settings redesign, release hardening, and changes to phase order/scope.
