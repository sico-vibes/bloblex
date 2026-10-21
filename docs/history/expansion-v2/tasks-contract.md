# Durable tasks contract

This is the daemon-owned contract for durable board tasks and their runs. An ordinary Manager delegation still uses the existing proposal and approval-card path unless the user explicitly selects board workflow. Desktop-owner task creation is allowed. Creating a task through a Manager MCP tool creates an unassigned draft only; it cannot dispatch, assign, or change the task's scope.

## Task and run records

`Task` is distinct from a conversation and has `id`, `title`, `brief`, `doneGoal`, `reportBack`, `projectId`, optional canonical GitHub issue/pull `sourceUrl`, immutable `originSessionId` and `parentTaskId`, derived `rootTaskId`, `assigneeAgentId`, `supervisionPolicy`, `supervisionSnapshot`, optional `scheduleId`, `estimateMinutes` (user estimate only), `maxRuntimeSecs` (default 1800), `state`, `queuePosition`, optimistic `version`, and observed lifecycle timestamps (`createdAt`, `updatedAt`, `assignedAt`, `startedAt`, `completedAt`). States are `unassigned`, `queued`, `running`, `needs_you`, `awaiting_review`, `done`, `failed`, and `cancelled`.

`TaskRun` identifies one attempt or scheduled occurrence. It has a distinct `id`, `taskId`, `attempt`, optional `sessionId`, immutable `assigneeAgentId` and `assigneeAgentName` snapshots, `state`, observed `startedAt` and `endedAt`, optional `scheduledFor`, cancellation state, correction count, and an optional persisted review decision. Run event history is append-only and timestamped; transitions carry safe `fromState`, `toState`, `fromAgentId`, and `toAgentId` fields when applicable. Session creation time is not used as a substitute for a missing run start; elapsed time is available only when both run timestamps were observed.

Task and run DTOs returned by authorized `task.get/list` calls expose user-authored task content, normalized identifiers, state, timestamps, and evidence references. Activity events are a separate content-free projection and never include brief, goal, report-back instructions, raw provider JSON, credentials, environment values, or message content. Remote event projection follows the remote allowlist and redaction policy.

## RPCs and event names

- `task.create` accepts `title`, `brief`, `doneGoal`, `reportBack`, `projectId`, `originSessionId`, `parentTaskId`, optional `supervisionPolicy`, and optional `scheduleId`. It always returns `unassigned` and has no assignment or dispatch fields.
- `task.list` accepts optional `state`, `projectId`, `assigneeAgentId`, and `parentTaskId`; `task.get` accepts `taskId`. Responses are `{tasks:[...]}` and `{task:...}`.
- `task.update` accepts only editable draft fields (`title`, `brief`, `doneGoal`, `reportBack`, `projectId`, `supervisionPolicy`, `scheduleId`) and `expectedVersion`. It cannot rewrite origin/parent or bypass a state transition.
- There is no owner `task.assign` RPC. One desktop Assign/drop action calls `task.dispatch` with `taskId`, `assigneeAgentId`, `expectedVersion`, and an idempotency key. It atomically assigns and claims dispatch before session spawn and returns `{task,run,disposition,queuePosition,reason,replayed}`. `disposition` is `started` or `queued`; queued reasons include `bot_busy`, `global_limit`, and `global_pause`. Replaying an idempotency key returns the same run. Manager MCP tools cannot assign or dispatch. `task.unassign` accepts `taskId` and `expectedVersion`, and is allowed only before a run starts. A running task must be stopped before reassignment.
- `task.reorder` accepts `taskId`, `beforeTaskId` (nullable), and `expectedVersion`; only queued work can be reordered. Mutations use optimistic versions and return `conflict` if stale.
- `task.stop` sets durable cancellation for a running run and requests cancellation of its active turn. `task.cancel` cancels an unstarted draft or queued task immediately and returns conflict for a running task, which must use `task.stop`.
- `task.review` accepts `taskId`, `runId`, `decision` (`done`, `needs_changes`, `not_done`), short `evidence`, and `expectedVersion`. It stores the reviewer, timestamp, correction round, decision, and evidence. Only valid evidence-backed review can mark a task done.
- `task.runs` accepts `taskId` and returns all attempts/occurrence runs with their append-only event history.
- Events are `task.changed`, `task.run.changed`, and `task.run.finished`. Event payloads carry normalized task/run DTOs and safe identifiers only.

The result decision shape is `{status,summary,evidence:[{source,id,at,summary}],at,reviewer,round}`. Evidence sources are `turn`, `message`, `tool`, or `review`; summaries are bounded and redacted. `turn.completed` is evidence that a provider turn ended, not proof that `doneGoal` was achieved.

## Supervision and schedules

Global defaults use `task.supervision.default` (`report_only`, `bounded`, `manager_completes`), `task.schedules.enabled` (false by default), `task.concurrency.max` (1 by default, maximum 3), and `task.globalPaused` (false). Each task snapshots its selected policy and `maxRuntimeSecs` at dispatch; an explicit per-task choice overrides the current global default. Bounded review permits at most two correction rounds in the same 1800-second default total runtime cap, then moves to `awaiting_review`. `manager_completes` can finish only on evidence; protected actions continue through normal approvals.

Schedules reuse the existing once/cron/timezone parser and scheduler. The task template is linked to the schedule, and each occurrence gets its own run. Manager schedule proposals remain disabled until the desktop owner enables schedules. The owner-facing preview returns concrete future occurrence times and local labels with explicit skipped, missed, paused, overlap, or concurrency outcomes; daylight-saving gaps/repeats follow the shared scheduler semantics. Defaults: 30-minute runtime, unattended permission mode never bypasses, maximum concurrency 3 within the existing global limit of 4, overlap is recorded as skipped, and a global pause blocks new claims. No monetary budget is enforced.

## Authority and restart behavior

Desktop users may create and edit unassigned drafts. The Manager's MCP draft-creation tool is Manager-only and cannot assign, dispatch or expand scope. Only the desktop owner may assign and dispatch, through the single `task.dispatch` action. Claim, idempotency key, task/run linkage, and queue position are committed before any provider session is spawned. A task run binds to its provider session before prompt delivery. Startup reconciliation resumes pending queued work once, keeps idempotency claims, and moves ambiguous claim/session states to `needs_you` for review rather than spawning a duplicate. Cancellation is persisted and applied once. Existing approved delegation links are added to the same ledger only when their origin, parent, and actual execution evidence are available; unsupported historical timestamps remain unknown.
