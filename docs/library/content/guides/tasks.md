# Tasks

> **What this is:** the Tasks page: what a task is, how a draft becomes work on a bot, the states in plain words, the review step, the Tree and Timeline views, and what is not built yet.
> **Status:** current for `main` at 22 October 2026; not in a release yet. Checked against the code and the daemon tests; not run against a live provider CLI.
> **Last updated:** 2026-10-22

## Before you start

- Bitbots must be connected to its background service. New task, drag and Assign are disabled while it is not.
- You need at least one bot. A task runs on a bot.
- Remote devices cannot see or change tasks. Tasks are an owner-at-the-computer feature in this version.

## What a task is

A task is a record on the board: a title, a brief (what to do), a done goal (what must be true for it to count as done) and a report-back line (what to say when it finishes). A task is not a conversation. When you give a task to a bot, Bitbots starts a conversation for that run, and the conversation links back to the task.

A task with no bot is a **draft**. Drafts wait in the Unassigned list. The Manager can file drafts for you when you ask it to track work, but it cannot assign them or schedule them. You decide which bot takes a draft.

## Steps

1. Open **Tasks** with the Tasks button in the sidebar header. The board opens with the Board view.
2. Choose **New task**. Enter a title (required, up to 120 characters), a brief, a done goal, a report-back line and, if you want, a project. Choose **Add task**. The dialog holds the brief to 8,000 characters; the daemon accepts up to 12,000.
3. Give the draft to a bot in one of two ways: drag the draft onto the bot's lane, or open the draft's **Assign to** menu and choose the bot. Either action assigns the task and starts it, or queues it if the bot is busy or a limit is reached.
4. Watch the lane. A bot's lane lists work that needs you first, then work ready for review, then work in progress, then the queue in order.
5. To stop a running task, open it and choose **Stop**. Stop asks the run's conversation to cancel.
6. To review a task that is ready for review, open it and choose **Mark done** or **Not done**. Mark done closes the task as Done. Not done marks it Failed. The board records your decision as evidence.
7. To try a failed task again, open it and choose **Try again with** and a bot.
8. To remove work before it starts, choose **Discard** on a draft (the task is cancelled), or **Unassign** on a queued task (it returns to Draft).

## States in plain words

| State on the board | What it means |
| --- | --- |
| Draft | Not given to a bot yet. |
| Queued | Given to a bot and waiting for the bot or a slot to free up. |
| Working | A run is going on the bot. |
| Needs you | The run stopped for a reason only you can settle, for example an approval, or Bitbots restarted while the run was active. |
| Ready for review | The provider turn ended. Bitbots does not treat a finished turn as done; you decide. |
| Done | You marked it done. |
| Failed | The run failed, or you marked it not done. You can try it again. |
| Cancelled | You discarded it, or it was stopped. |

Bitbots also shows "Starting" for a run that is being set up, and "Needs a look" for a run that was active when Bitbots stopped. Those are run labels, not task states.

## Views

- **Board** (the default): the Unassigned list on the left, and one lane per bot.
- **Tree**: a task split from another task appears under its parent. The current New task dialog does not set a parent, so tasks show as standalone until something sets one.
- **Timeline**: one row per bot over time. Bars come only from timestamps Bitbots observed: a wait from the time of assignment to the observed start, and the work from the observed start to the end. A run without an observed start is not drawn.

## Check the result

- After you assign a task, it moves to Working, or to Queued if the bot was busy.
- The bot's conversation shows the task prompt built from the brief, the done goal and the report-back line.
- When the turn ends, the task shows Ready for review. Nothing is marked done until you review it.

These are the behaviours the code and its tests describe. They were not re-run in the browser preview or the native app for this page, and a native run with a live provider has not been done for tasks (see Limits).

## If something fails

- **Assign is disabled.** The board is not connected to Bitbots' background service, or the bot list is empty. Reconnect or add a bot.
- **The bot is archived.** An archived bot cannot take a task. Restore it from Archived bots in the profile menu first.
- **A queued task does not start.** The bot may be busy with another conversation, or a limit is reached. The concurrency limit and the global pause are set with `settings.set` (see [task board reference](../reference/task-board.md)). The Settings page does not show them yet.
- **A task stopped with "Needs a look" or "Needs you" after a restart.** Bitbots never runs a stopped run again by itself. Review the conversation, then decide whether to try again.

## Limits and what is not built

- Only report-only work is supported. Choosing a supervision policy other than report-only is refused with `unsupported`.
- The Manager review loop, schedules on tasks, GitHub source links, a remote task list, the terminal dock, the chat background, Cursor and Grok bots, connectors, computer control and the phone relay are not built. The plan is in [expansion-plan-v2](../../../plans/expansion-plan-v2.md).
- The board has no control for the concurrency limit or the global pause. The daemon enforces both.
