# Daemon and storage

> **What this is:** what the `bitbotsd` daemon owns, how it starts, and how the SQLite store is laid out and migrated.
> **Status:** current; checked against `crates/bloblex-daemon` and `crates/bloblex-storage` on 19 October 2026, and the task tables added on 22 October 2026
> **Last updated:** 2026-10-22

## Purpose

The daemon is the only component allowed to decide. It admits turns, applies approval policy, answers provider permission requests, records usage, persists sessions and serves the Remote gateway. The desktop shell can render a stale view for a moment; it cannot overrule the daemon's state.

This separation is what makes the companion, a remote phone and the main window agree: they all read the same snapshot and the same ordered events.

## How it works

### Startup

1. The desktop shell starts `bitbotsd.exe` as a child process.
2. The daemon opens the database, runs migrations, recovers interrupted runs and queue state, and starts the scheduler.
3. It binds `127.0.0.1` on an ephemeral port.
4. It writes one bootstrap JSON object to stdout before any log:
   `{"type":"bloblexd.ready","protocolVersion":1,"address":"127.0.0.1:49152","capability":"…"}`.
5. The shell reads the address and capability and starts proxying renderer calls.

The capability is random and 256-bit. It exists in daemon memory and the shell's child-process channel only. It is never persisted, logged or sent to the renderer.

### Request handling

`POST /v1/rpc` accepts `{v, id, method, params}`. The daemon checks the capability, routes through `dispatch()` (`crates/bloblex-daemon/src/main.rs:819`), and answers `{v, id, ok, result}` or `{v, id, ok:false, error:{code, message}}`.

`GET /v1/events` upgrades to a WebSocket. The client sends `{v:1, afterSequence:n}` immediately; the daemon registers the live subscription before replaying persisted events after the cursor, so the snapshot/subscribe race is closed. A client that gets `replayAvailable:false` must fetch a fresh snapshot.

### What the daemon owns

| Area | Examples |
| --- | --- |
| Sessions and turns | Creation, admission, the turn driver, cancellation, resume, handoff, deletion. |
| Permissions | The pending request, the policy decision, the auto classifier, resolution and audit. |
| Queue and retry | The durable prompt queue, scheduled sends, retry decisions and the usage-limit wait. |
| Usage | Provider-reported tokens and the separate valuation record. |
| Projects and teams | Projects, roles, tags, side conversations, merge proposals. |
| Manager | The Manager record, its profile, playbook and proposals. |
| Memory, skills, automations | Storage, validation, tool bridge and scheduling. |
| Remote | The gateway, device records, pairing, policy, activity and the Native listener. |
| Settings | Non-secret preferences and their validation. |

### What the daemon does not own

Window placement, tray menus, global shortcuts, file dialogs, notifications, microphone capture and the updater belong to the native shell. The daemon never opens a provider credential file. The one exception is cloud dictation, which is implemented in the shell and the speech crate, opt-in, and read-only.

## Storage

### Location

The database path is `BLOBLEX_DB_PATH` when set (`crates/bloblex-daemon/src/main.rs:4272`). Otherwise the daemon uses `%LOCALAPPDATA%\Bitbots\bloblex.db` (`crates/bloblex-daemon/src/main.rs:4275`), and the desktop's data folder is `%LOCALAPPDATA%\Bitbots` (`apps/desktop/src-tauri/src/lib.rs:909`). The development script points `BLOBLEX_DB_PATH` at `dev-data\bloblex.db` under its Cargo target (`scripts/dev-windows.ps1`). Tests and development point the variable at a scratch file. Never run a migration experiment against the real data folder.

### Schema

The store is SQLite. The core tables are created by the schema functions in `crates/bloblex-storage/src/lib.rs`:

- `hosts`, `runtimes`, `runtime_profiles`
- `sessions`, `turns`, `messages`, `tool_calls`, `file_changes`
- `permission_requests`
- `usage_events`, `usage_valuations`, `pricing_rules`, `user_pricing_rules`, `subscription_plans`
- `budget_policies`, `budget_reservations`, `budget_violations` (retained; the RPCs are retired)
- `settings`, `app_events`
- `projects`, `queued_prompts`, `automations`, `automation_runs`
- `memory_records`, `memory_versions`
- `model_catalog_cache`, `skills`, `skill_agent_settings`
- `remote_devices`, `remote_activity`
- `proposals`, `manager_profile`, `manager_playbook`
- `tasks`, `task_runs`, `task_run_events`, `task_dispatch_keys` (the task board, created by `ensure_tasks_schema`; see [task board](task-board.md))
- `exec_snapshots`, `active_turn_reservations`

Most records carry a JSON `data` column for additive fields, so a new field rarely needs a new column. Foreign keys are enabled for normal work and deliberately turned off for some table rebuilds inside a migration transaction.

### Migrations

Schema changes are versioned functions, each with an idempotency guard (a `pragma_table_info` check or an existence test), a ledger row in `schema_migrations`, and a `PRAGMA user_version` bump. Most migrations that change structure take a verified backup before the DDL (`verified_backup` at `crates/bloblex-storage/src/lib.rs:57` and `:129`). An additive column may skip it: `migrate_context_failure_class` (`:1218`) only adds `turns.failure_class_v2` and takes no backup.

A migration validates the schema after the DDL and again after commit where the function does so. A failed validation returns an error rather than leaving a half-open database.

### Backup and restore

`crates/bloblex-daemon/src/backup.rs` exports a JSON document with a checksum over the contents. It covers bots as a secret-free projection, live memory, skills as base64 files, automations and the allowlisted settings. Import validates the envelope and checksum, maps each provider to a local runtime, reports conflicts, and applies the result in one transaction. Skill files are staged on disk before they are committed.

The preview store keeps at most two parsed documents for ten minutes and is single-use on import. A newer format version is refused; a checksum mismatch is refused with "The backup file is damaged or was edited."

### Events and retention

Every persisted event has a globally increasing sequence. `app_events` is the durable log used for replay; the live WebSocket starts from a client cursor. Some events are deliberately not persisted or are dropped for remote clients by the event policy. Message text never appears in a log line, a push payload or the remote activity list.

## Key files

| Path | Responsibility |
| --- | --- |
| `crates/bloblex-daemon/src/main.rs` | Startup, capability, dispatch, turn driver, settings. |
| `crates/bloblex-daemon/src/queue.rs` | Durable prompts and send-later. |
| `crates/bloblex-daemon/src/retry.rs` | Usage-limit recovery and bounded retries. |
| `crates/bloblex-daemon/src/automations.rs` | Scheduler and runs. |
| `crates/bloblex-daemon/src/memory.rs`, `skills.rs` | Durable notes and the skill pool. |
| `crates/bloblex-daemon/src/backup.rs` | Export, preview, import. |
| `crates/bloblex-daemon/src/remote/` | Gateway and both methods. |
| `crates/bloblex-storage/src/lib.rs` | Schema, migrations, queries. |

## Gotchas

- **The database is the user's work.** Do not delete it to clear a bug. Export diagnostics or a backup first.
- **Migrations are one-way in practice.** Write them additively; a downgrade is not supported.
- **A JSON `data` column is not a schema excuse.** Validate what you write; an unvalidated field becomes a compatibility problem.
- **The verified backup is not the user's backup.** It protects a migration; it is not the Backup feature.
- **Retired families stay in the schema.** `budget.*`, `pricing.*` and `subscription.*` return `unsupported`; their tables are historical and their rows are not a promise of support.
