# IPC and events

> **What this is:** the daemon contract in one place: transport, envelopes, method families, the event vocabulary, error codes and the rules a client must follow.
> **Status:** current; a summary of `docs/ipc-contract.md` (updated 18 October 2026), checked on 19 October 2026, and the task rows added on 22 October 2026. That file remains the full contract.
> **Last updated:** 2026-10-22

## Purpose

The daemon is authoritative. A client does not infer state, merge provider JSON or invent success. It asks for a snapshot, applies ordered events, and refetches when it cannot prove continuity.

The full method table, including every parameter shape, is in [the IPC contract](../../../ipc-contract.md). This page is the working summary you need to read or write a client.

## Transport

| Item | Rule |
| --- | --- |
| Address | `127.0.0.1` on an ephemeral port chosen at startup. Never `0.0.0.0`, a LAN interface or an IPv6 wildcard. |
| Requests | `POST /v1/rpc`, JSON envelope. |
| Events | `GET /v1/events`, WebSocket upgrade, then `{v:1, afterSequence:n}`. |
| Auth | `Authorization: Bearer <capability>` on every request. Constant-time comparison. |
| CORS | Disabled. |
| Peers | Loopback only. |
| Version | Every request, response and event carries `v: 1`. An unsupported major version is a startup error. |

The capability arrives in the bootstrap line on stdout, before any log. It is held in daemon memory and the shell's child-process channel; never persisted, never logged, never sent to the renderer.

### Envelopes

```json
{"v":1,"id":"req_01","method":"app.snapshot","params":{}}
{"v":1,"id":"req_01","ok":true,"result":{"snapshotVersion":1,"sequence":0}}
{"v":1,"id":"req_01","ok":false,"error":{"code":"invalid_argument","message":"The project path does not exist."}}
{"v":1,"eventId":"evt_01","sequence":1,"timestamp":"2026-10-01T00:00:00Z","type":"runtime.changed","payload":{}}
```

`id` is opaque and unique per client request. `sequence` is daemon-global, monotonic and persisted. Unknown fields and unknown event types must be ignored. Duplicate sequences after a replay are discarded by the client.

### Snapshot and replay

1. Call `app.snapshot`. It returns the complete state and the latest `sequence`.
2. Open `/v1/events` and send `{v:1, afterSequence:<sequence>}`.
3. Apply events in order. If `events.replay` reports `replayAvailable:false`, or a gap appears, fetch a fresh snapshot.
4. `daemon.health` gives version, uptime, state and heartbeat for a connection check.

The daemon registers the live subscription before replaying persisted events, which closes the race between the snapshot and the stream.

## Method families

| Family | Methods |
| --- | --- |
| App and daemon | `app.snapshot`, `events.replay`, `daemon.health`, `daemon.shutdown` |
| Runtimes | `runtime.list`, `runtime.refresh`, `runtime.capabilities`, `runtime.models`, `runtime.profile.list/save/delete` |
| Bots | `agent.list/get/create/update/delete/restore/reorder/purge`, `agent.lock.set`, `agent.team.update`, `agent.conversation` |
| Tasks (22 October 2026) | `task.create/list/get/update/dispatch/unassign/reorder/cancel/stop/review/runs`; see [task board](task-board.md) |
| Sessions | `session.list/get/new/rename/archive/delete/resume/prompt/cancel/close`, `session.steer`, `session.handoff.draft`, `session.delete.schedule/cancel`, `session.model.update`, `session.permissions.set` |
| Queue and retry | `session.queue.add/list/update/reorder/delete/send_now/resume`, `turn.retry.cancel` |
| Permissions | `permission.reply`, `permissions.policy.get` |
| Execution evidence | `exec.snapshot.get/list/latest` |
| Usage and quota | `usage.summary`, `usage.analytics`, `quota.list`, `quota.refresh` |
| Projects and team | `project.list/create/update/delete`, `team` methods handled in `team.rs` |
| Automations | `automation.create/list/get/update/pause/resume/delete/run_now/runs/preview` |
| Memory | `memory.list/get/create/update/approve/delete/restore` |
| Skills | `skills.list/get/scan/import/delete/toggle/forAgent` |
| Manager | `manager.get`, `manager.ensure`, `manager.profile.*`, `manager.playbook.*`, `proposal.decide` |
| Files and search | `file.revert`, `message.reaction.toggle`, `search.messages` |
| Settings | `settings.get`, `settings.set` |
| Diagnostics | `diagnostics.preview`, `diagnostics.export` |
| Backup | `backup.export`, `backup.preview`, `backup.import` |
| Remote (desktop only) | `remote.status/enable/disable`, `remote.pair.*`, `remote.devices.*`, `remote.security.*`, `remote.activity.list`, `remote.native.*`, `remote.method.set` |
| Retired | `pricing.*`, `subscription.*`, `budget.*` return `unsupported` |

Every `remote.*` method is refused to a paired device at every tier. `settings.set` also refuses any key beginning `remote.`.

## Events

The normalized vocabulary is:

`runtime.changed`, `agent.changed`, `session.changed`, `session.deleted`, `message.delta`, `message.completed`, `tool.changed`, `file.changed`, `command.changed`, `permission.requested`, `permission.resolved`, `permission.auto_resolved`, `permission.auto_denied`, `permission.bypass_active`, `usage.updated`, `turn.completed`, `turn.cancelled`, `turn.error`, `turn.retry_scheduled`, `turn.retry_declined`, `queue.changed`, `automation.changed`, `automation.deleted`, `automation.run.changed`, `automation.run.finished`, `memory.changed`, `memory.deleted`, `task.changed`, `task.run.changed`, `task.run.finished`, `skills.changed`, `settings.changed`, `proposal.changed`, `manager.profile.changed`, `manager.playbook.changed`, `backup.imported`, `remote.changed`, `remote.pairing.requested`, `remote.pairing.completed`, `remote.device.changed`, `remote.activity`, `daemon.health`.

Rules:

- Streamed and finalized messages share the same stable id.
- `session.changed` carries compact metadata, never transcript text.
- `session.deleted` removes that conversation's persisted, session-specific events.
- `message.delta` is provisional. Only `message.completed` makes a message final.
- `turn.error` with `recoveryHandled:true` means a retry or continuation is already scheduled; the UI hides that error rather than showing both.
- Payloads never contain instruction text, environment values, launch arguments, file paths, raw provider JSON, credentials or the capability.

## Error codes

| Code | Meaning |
| --- | --- |
| `invalid_argument` | A parameter is malformed or outside its allowed range. |
| `not_found` | The session, bot, memory note, snapshot, runtime or automation does not exist. |
| `unauthorized` | The capability or a remote device credential is missing or wrong. |
| `unsupported` | The method is retired, the provider cannot do it, or a gate is closed. |
| `provider_unavailable` | The provider cannot be reached. |
| `provider_error` | The provider answered with an error or a malformed catalog. |
| `conflict` | The request clashes with current state (queue full, locked bot, running task). |
| `replay_gap` | Retention does not cover the requested cursor. |
| `internal` | A daemon fault. The message is safe but does not expose internals. |

Messages are safe for display. They never contain a token, an environment value or prompt text.

## Client rules

- Never synthesise success, usage, auth or a permission grant. Absent data is unknown.
- Compare `v`. Treat an unsupported major version as a startup error.
- Reconnect by refetching a snapshot, not by assuming the last view is current.
- Treat adapter capability omissions as unsupported, not as a reason to try a private path.
- Keep prompts in the request body, never in argv or shell text.
- A remote client receives a filtered snapshot and a reduced event policy; it cannot call a method outside its tier.

## Gotchas

- The contract document includes intended requirements as well as implemented ones (see its own preamble). Where it and the code disagree, the code wins; this library names the code location when a claim is checked.
- `budget.warning` and `budget.blocked` remain in the vocabulary but have no emitter; budgets are retired.
- `session.queue.*` is `read_only` on a side conversation and `not_found` for a missing or archived session.
- The `remote.*` rows described as design in older documents are implemented for the desktop path; the device path still cannot call them.
