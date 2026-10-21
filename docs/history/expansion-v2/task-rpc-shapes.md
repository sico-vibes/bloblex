# Task RPC shapes (slice 1A)

Written from the implementation in `crates/bloblex-daemon/src/tasks.rs` and `crates/bloblex-storage/src/lib.rs`
on 21 October 2026, for the board UI lane. Every RPC is registered in `dispatch()`
(`crates/bloblex-daemon/src/main.rs`) and every one is `never` for remote devices
(`apps/desktop/src/remote/tiers.json`).

Wire error codes are the daemon's existing ones: `invalid_argument` (the brief's
"invalid"), `conflict`, `unsupported`, `not_found`, `forbidden`, `internal`.
Unknown methods fall through to the global `unsupported` answer, not `not_found`.

Optimistic versions: every mutation takes `expectedVersion` and returns the new
`task.version`. A stale version is `conflict`.

## Task DTO

```json
{
  "id": "uuid", "title": "string", "brief": "string", "doneGoal": "string", "reportBack": "string",
  "projectId": "uuid|null", "originSessionId": "uuid|null", "parentTaskId": "uuid|null", "rootTaskId": "uuid",
  "assigneeAgentId": "uuid|null", "supervisionPolicy": "report_only",
  "supervisionSnapshot": {"policy": "report_only", "maxRuntimeSecs": 1800},
  "estimateMinutes": 30, "maxRuntimeSecs": 1800,
  "state": "unassigned|queued|running|needs_you|awaiting_review|done|failed|cancelled",
  "queuePosition": 0, "version": 1,
  "createdAt": "RFC3339 millis", "updatedAt": "...", "assignedAt": null, "startedAt": null, "completedAt": null
}
```

`assignedAt` is written when the drop commits, `startedAt` when the run is bound
to its session (the turn's real start), `completedAt` only for `done`, `failed`
and `cancelled`. Nothing is invented: unobserved times stay `null`.

## Run DTO

```json
{
  "id": "uuid", "taskId": "uuid", "attempt": 1, "sessionId": "uuid|null",
  "assigneeAgentId": "uuid|null", "assigneeAgentName": "Bot name",
  "state": "claimed|queued|running|needs_you|awaiting_review|done|failed|cancelled|ambiguous",
  "startedAt": null, "endedAt": null, "cancelRequestedAt": null,
  "correctionRounds": 0, "decision": null, "errorCode": null,
  "createdAt": "...", "updatedAt": "...",
  "events": [{"id": "uuid", "runId": "uuid", "type": "dispatch_claimed", "at": "...", "details": {}}]
}
```

Run events are append-only. Types: `dispatch_claimed`, `session_bound`,
`queue_started`, `reordered`, `stop_requested`, `state_changed`, `run_finished`,
`unassigned`, `review_decided`, `restart_ambiguous`.
`decision` for a finished turn is `{status,summary,evidence:[{source,id,at,summary}],at,reviewer,round}`
with `status` `awaiting_review` until the owner reviews. A review stores
`status` `accepted` | `needs_changes` | `rejected`, `reviewer: "owner"`, `round: 1`.

## `task.create`

| Request | Type |
|---|---|
| `title` | string, 1–120 chars, required |
| `brief` | string ≤ 12000, optional |
| `doneGoal` | string ≤ 4000, optional |
| `reportBack` | string ≤ 4000, optional |
| `projectId` | project id or null, optional (unknown → `not_found`) |
| `originSessionId` | session id or null, optional (unknown → `not_found`) |
| `parentTaskId` | task id or null, optional (unknown → `not_found`) |
| `supervisionPolicy` | `report_only` (default) |
| `estimateMinutes` | integer 1–10080, optional |
| `maxRuntimeSecs` | integer 60–86400, default 1800 |

No assignment, dispatch or schedule fields. Response `{task}` with
`state: "unassigned"`, `version: 1`. Errors: `invalid_argument`, `not_found`,
`unsupported` (any other supervision policy).

## `task.list`

| Request | Type |
|---|---|
| `state` | one task state, optional |
| `projectId`, `assigneeAgentId`, `parentTaskId` | ids, optional |

Response `{tasks: Task[]}`, queued work first by `queuePosition`, then by
`updatedAt` descending. Errors: `invalid_argument` (unknown state).

## `task.get`

Request `{taskId}`. Response `{task}`. Errors: `not_found`.

## `task.update`

Request `{taskId, expectedVersion, title?, brief?, doneGoal?, reportBack?, projectId?, supervisionPolicy?}`.
Only an `unassigned` draft may be edited; any other state is `conflict`. Response
`{task}` with a bumped version. Errors: `invalid_argument`, `conflict`,
`not_found`, `unsupported`.

## `task.dispatch`

| Request | Type |
|---|---|
| `taskId` | required |
| `assigneeAgentId` | bot id, required (unknown → `not_found`, archived → `conflict`) |
| `expectedVersion` | required |
| `idempotencyKey` | string 1–200, required; one key belongs to one task and bot |

```json
{"task": {...}, "run": {...}, "disposition": "started|queued", "queuePosition": 0,
 "reason": "bot_busy|global_limit|global_pause|null", "replayed": false}
```

Dispatch is allowed from `unassigned`, `awaiting_review`, `needs_you` and `failed`
(each dispatch creates a new attempt). A `running` or `queued` task is `conflict`.
A replay of the same key returns the same run with `replayed: true` and the reason
recorded at claim time. Errors: `invalid_argument`, `conflict`, `not_found`,
`unsupported`.

Capacity: a drop queues when `task.globalPaused` is true (`global_pause`), when the
bot has a live turn (`bot_busy`), or when `task.concurrency.max` (default 1, max 3)
task runs are already claimed/running or the daemon's global turn limit is reached
(`global_limit`).

## `task.unassign`

Request `{taskId, expectedVersion}`. Only a `queued` task whose run has not started;
the queued run becomes `cancelled` and the task returns to `unassigned` with no
bot. Response `{task}`. Errors: `conflict`, `not_found`.

## `task.reorder`

Request `{taskId, beforeTaskId, expectedVersion}` where `beforeTaskId` is a task id
or null (append). Only `queued` work, within the same bot. Positions are renumbered
from 0; every card whose slot changed gets a version bump, so re-read the queue.
The same is true after `task.unassign` or `task.cancel` of a queued card: the queue
is compacted and shifted cards get a version bump. Response `{task}` for the moved
card. Errors: `invalid_argument`, `conflict`, `not_found`.

## `task.cancel`

Request `{taskId, expectedVersion}`. Cancels an `unassigned` or `queued` task, or
its queued run. A `running` task is `conflict` (use `task.stop`). Response `{task}`
with `state: "cancelled"` and `completedAt`. Errors: `conflict`, `not_found`.

## `task.stop`

Request `{taskId, expectedVersion}`. Records durable cancellation on the live run
(`cancelRequestedAt`) and asks the daemon to cancel its turn; the task stays in
its current state until the turn's `turn.cancelled` closes it as `cancelled`. It
accepts a `running` task and a task waiting on an approval (`needs_you`).
Response `{task, stopRequested: true}`. Errors: `conflict`, `not_found`.

## `task.review`

| Request | Type |
|---|---|
| `taskId`, `runId` | required |
| `decision` | `done` \| `needs_changes` \| `not_done` |
| `evidence` | 1–1200 chars, required |
| `expectedVersion` | required |

Only from `awaiting_review` or `needs_you`, on that task's run. `done` closes the
task (`done`, `completedAt`), `not_done` closes it `failed`, `needs_changes` keeps
`awaiting_review` and stores the note so the owner can drop it on a bot again.
Response `{task, run}`; the run carries `decision`. Errors: `invalid_argument`
(missing/too long evidence, unknown decision), `conflict` (stale version, wrong
state, or a closed task), `not_found`.

## `task.runs`

Request `{taskId}`. Response `{runs: Run[]}` oldest attempt first, each with its
append-only events. Errors: `not_found`.

## Events

Content-free: no title, brief, done goal, report-back text, provider output,
credentials or message content.

- `task.changed` — `{"task": {id, projectId, parentTaskId, rootTaskId, assigneeAgentId, state, queuePosition, version, updatedAt, assignedAt, startedAt, completedAt}}`
- `task.run.changed` — `{"taskId": "...", "run": RunEvent}`
- `task.run.finished` — same shape as `task.run.changed`, sent when the run ends (`awaiting_review`, `done`, `failed`, `cancelled`)

`RunEvent` = `{id, taskId, attempt, sessionId, state, startedAt, endedAt, cancelRequestedAt, errorCode, decision}`.
