# Task board

> **What this is:** how the task board works inside the daemon and the desktop: the RPCs, states, events, settings, storage tables, restart behaviour, the remote policy and the tests that pin them.
> **Status:** current for `main` at 22 October 2026; phase 1 only (report-only). The RPC shapes were read from the handlers and the storage functions in this pass; the tests named below were not re-run here.
> **Last updated:** 2026-10-22

## Purpose

The task board is a durable ledger of work the owner gives to bots. A task is a board record, not a conversation, so it survives restarts and can wait in a queue. Only the desktop owner may assign work. A Manager-created task is an unassigned draft that can never start, schedule or dispatch itself.

## How it works

1. **Draft.** `task.create` stores a task with no assignee (state `unassigned`). The Manager's `create_task` tool does the same and ignores any assignee or schedule field (`crates/bloblex-daemon/src/tasks.rs`, `manager_create`); it may attach images the owner sent in the same conversation with `images` (1-based numbers or `all`).

FIX43 added three things to a draft. **Images:** `task.create` and `task.update` take `attachments` (staged files to adopt, or `{id}` to keep one); the daemon checks each like a chat attachment, copies it into `<data>/task-images/`, lists it in `images`, serves a thumbnail through `task.image` and hands the files to the provider as image attachments when the task runs. **Schedules:** `schedule` (`once` or `cron`, parsed by the automation parser in `bloblex_storage::cron`) with `scheduleAgentId`; the 10-second sweep fires due tasks (`tasks::sweep`, `fire_schedule`): a one-time task starts itself, a repeating task starts a copy under it, an occurrence more than 300 seconds late or due while `task.globalPaused` is on is skipped, and one due while the previous copy is queued or running is skipped. Such a run is unattended (`link.unattended`, `is_unattended` in `main.rs`): permission mode `auto`, never bypass, unclassified permissions denied, questions dismissed, no `ask_user`. **Time limit:** every run is closed as `failed` with `timeout` after `maxRuntimeSecs` (`tasks::watchdog_at`).
2. **Dispatch.** `task.dispatch` claims the task, creates its attempt run and places it in the bot's queue in one storage transaction, before any provider session exists. If the bot is free and a slot is open, the run starts: a lazy session is created on the bot's workspace, bound to the run, and the task prompt is delivered. Otherwise the run stays `queued` with a reason.
3. **Queue.** The queue reasons are `global_pause`, `bot_busy` and `global_limit`. Queued work starts when the bot and a slot are free. The queue advances after each turn, on the shared scheduler tick (`tasks::sweep`, called from `crates/bloblex-daemon/src/automations.rs`), and at startup (`tasks::startup`).
4. **Turn end.** A provider turn that completes moves the run and task to `awaiting_review`, with evidence that the turn ended. A turn that is cancelled becomes `cancelled`. Any other end becomes `failed` with `provider_error`. A completed turn is never treated as done.
5. **Review.** Only the owner's `task.review` closes a task. `done` moves the task to `done`; `needs_changes` returns it to `awaiting_review` (the desktop does not send this decision); `not_done` moves it to `failed`. The evidence text is required and limited to 1,200 characters.
6. **Stop.** `task.stop` records a cancellation request on the running or needs-you run and asks the session to cancel. The cancellation is kept even if the turn is already gone.

Dispatch accepts a task in `unassigned`, `awaiting_review`, `needs_you` or `failed`. A replayed `idempotencyKey` returns the same run and does not start a second session. A stale `expectedVersion` returns `conflict`.

## States

Tasks: `unassigned`, `queued`, `running`, `needs_you`, `awaiting_review`, `done`, `failed`, `cancelled`. The storage check constraint enforces these names, and a task in `queued` must have an assignee and a queue position.

Runs: `claimed`, `queued`, `running`, `needs_you`, `awaiting_review`, `done`, `failed`, `cancelled`, `ambiguous`. A unique index allows at most one active run (`claimed`, `queued` or `running`) per task.

The ledger records run and task changes as append-only rows in `task_run_events` (`task_event_insert`).

## RPCs

The full table is in [ipc-contract.md](../../../ipc-contract.md#task-board-22-october-2026). In short: `task.create`, `task.list`, `task.get`, `task.update` (unassigned drafts only), `task.dispatch`, `task.unassign` (queued only), `task.reorder` (queued only), `task.cancel` (unassigned or queued), `task.stop` (running or needs-you), `task.review` (awaiting-review or needs-you), and `task.runs`. Routing is in `crates/bloblex-daemon/src/main.rs` (`dispatch`), and the handlers are in `crates/bloblex-daemon/src/tasks.rs`.

Supervision: `report_only` is accepted. `bounded` and `manager_completes` return `unsupported` at creation, update and dispatch.

## Events

- `task.changed` `{ task }`: the safe projection of a task (ids, state, queue position, version and timestamps).
- `task.run.changed` `{ taskId, run }`.
- `task.run.finished` `{ taskId, run }`, sent when a run reaches `awaiting_review`, `done`, `failed` or `cancelled`.

None of the events carries the title, brief, done goal, report-back text or evidence text. The projections are `safe_task_event` and `run_event` in `crates/bloblex-daemon/src/tasks.rs`.

The desktop listens for these events and refreshes the board (`apps/desktop/src/ui/useTasks.ts`).

## Settings

- `task.concurrency.max`: integer 1 to 3, default 1. The default is not stored. The daemon reads it clamped to 1 to 3 (`tasks.rs`) and `settings.set` checks it (`crates/bloblex-daemon/src/main.rs`).
- `task.globalPaused`: JSON boolean. While `true`, no queued task starts; dispatch records the reason `global_pause`.

The global concurrency limit `concurrency.botsAtOnce` also applies to tasks. Neither task setting has a control in the desktop Settings page as of this pass (`apps/desktop/src/ui` has no reference to them outside tests).

## Storage

Created by `ensure_tasks_schema` in `crates/bloblex-storage/src/lib.rs`:

- `tasks`: title, brief, done goal, report-back text, project, origin session, parent and root task, assignee, supervision policy and snapshot, estimate, max runtime (default 1,800 seconds), state, queue position, version, and the observed timestamps (`created_at`, `updated_at`, `assigned_at`, `started_at`, `completed_at`). Indexes on the queue, the assignee and the project.
- `task_runs`: one row per attempt, with session, assignee name, state, observed start and end, cancel request time, correction rounds (0 to 2), decision JSON and error code. A unique index allows one active run per task.
- `task_run_events`: append-only events for each run, with details JSON.
- `task_dispatch_keys`: idempotency keys mapped to their task and run.

Storage methods are the `task_*` functions on the database type (for example `task_dispatch_claim`, `task_review`, `task_recover_after_restart`).

## Restart

`task_recover_after_restart` runs at startup. A run left `claimed` or `running` becomes `ambiguous` with `restart_ambiguous`, and its task becomes `needs_you` with a version bump. Nothing is spawned again. Queued work then resumes once through `advance_queue`.

## Remote policy

Every `task.*` method and `agent.purge` is `never` for a paired device, at every tier (`apps/desktop/src/remote/tiers.json`). The three task events are `drop` for remote devices. See [remote-gateway.md](remote-gateway.md) and [docs/remote/PROTOCOL.md](../../../remote/PROTOCOL.md).

## Tests

Storage tests in `crates/bloblex-storage/src/lib.rs`: `task_draft_is_unassigned_editable_and_invents_no_timestamps`, `task_dispatch_is_idempotent_and_queues_in_order`, `task_unassign_cancel_and_stop_follow_the_state_rules`, `task_run_events_are_append_only`, `task_review_needs_evidence_and_only_done_closes_the_task`, `task_restart_recovery_marks_ambiguous_work_and_never_duplicates`.

Daemon tests in `crates/bloblex-daemon/src/main.rs`: `task_manager_tool_creates_unassigned_drafts_only`, `task_owner_dispatch_starts_replays_and_refuses_stale_versions`, `task_dispatch_queues_for_a_busy_bot_a_full_slot_or_a_global_pause`, `task_turn_end_needs_owner_review_and_review_stores_evidence`, `task_failed_turn_and_stop_both_end_the_run`, `task_restart_marks_ambiguous_work_needs_you_and_resumes_queued_work_once`, `task_settings_and_unknown_methods_are_guarded`.

Desktop tests: `apps/desktop/src/ui/taskModel.test.ts` and `taskViews.test.ts` (tree nesting and observed-interval timeline), and `apps/desktop/src/ui/DelegateBoard.mounted.test.tsx`.

These tests are what the code carries. Their results were not re-run for this document. Not verified: a live provider run, and a native run of dispatch, restart or stop.

## Key files

- `crates/bloblex-daemon/src/tasks.rs`: RPC handlers, dispatch, queue, turn-end and restart hooks, the event projections.
- `crates/bloblex-storage/src/lib.rs`: `ensure_tasks_schema` and the `task_*` functions.
- `crates/bloblex-daemon/src/team.rs`: the Manager's `create_task` tool.
- `apps/desktop/src/ui/TasksView.tsx`, `DelegateBoard.tsx`, `TaskTree.tsx`, `TaskTimeline.tsx`, `taskModel.ts`, `useTasks.ts`: the board.

## Gotchas

- The desktop never sends `needs_changes`, so the review step offers only Mark done and Not done.
- The dialog limits the brief to 8,000 characters; the daemon limit is 12,000.
- `task.update` changes unassigned drafts only. The desktop has no edit control for a draft yet.
- Nothing in the desktop sets a parent task, so the tree shows standalone tasks until a parent is set through the daemon.
