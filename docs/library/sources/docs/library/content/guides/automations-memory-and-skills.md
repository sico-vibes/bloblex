# Automations, memory and skills

> **What this is:** scheduled work, durable notes and the shared skill pool: what each does, how to set it up, and the limits that keep unattended work safe.
> **Status:** current; written for v0.1.0-beta.35
> **Last updated:** 2026-10-19

## Before you start

Automations and skills are on by default. Memory is behind an experimental switch (Settings › Experimental, **Memory**) because it changes what a bot sees in a prompt. Skills need a folder with a `SKILL.md`, or a skill folder from a coding agent.

All three are stored by Bitbots on this computer. None of them needs an account beyond the bot's normal coding agent, and none of their writes are available to a remote device.

## Automations

### What an automation is

An automation is a saved prompt plus a schedule. At its due time Bitbots opens a normal bot conversation, sends the prompt and records the run. The automation uses the bot's model and effort and pins them for the run.

Create one from the automations view:

1. Choose an idea or **New automation**. The built-in ideas are Morning brief, Email check, Project check-in and Nightly tests.
2. Pick the bot, a name and the prompt.
3. Choose a schedule: every day, weekdays, weekly, every few hours, once, or a custom schedule with a time zone. The preview shows the next runs in UTC and local time.
4. Choose how each run starts: a new conversation, or reuse one conversation.
5. Choose an approval mode for the run: **plan** or **auto**. Full access and Ask first are not allowed for automations.
6. Set a maximum runtime in seconds (60 to 14,400) and whether it is enabled.

There is a global **Pause all automations** switch, and Bitbots runs at most 1 to 3 automations at once, under the overall limit of four turns.

### What happens on a run

Bitbots checks the schedule every 10 seconds. A missed occurrence becomes one run; it never tries to catch up with a burst. An automation that is already running records a skipped run, and one that cannot start because the overall limit or a user turn is busy stays due for up to 15 minutes, then records a skipped run.

A run's status is running, completed, failed, skipped, cancelled, timeout or interrupted. After an unclean exit, a run left running is marked interrupted and does not count as a failure. After a failure the automation retries at 30 seconds, then 60 seconds; after three consecutive failures it pauses itself.

### Safety rails

- The run's approval mode is always plan or auto, whatever the bot's own mode is.
- An action the automatic approval rules would not approve is refused and recorded with the automation and run.
- A question that would need an answer is dismissed so the run can finish.
- The run has no tools for changing schedules; a normal conversation can ask Bitbots to create an automation, but it arrives disabled and waiting for your approval.
- Archiving or deleting a bot pauses its automations; it never deletes them.

## Memory

### What memory is

Memory is a set of durable notes with a scope:

- **Bot** notes belong to one bot.
- **Project** notes belong to every bot in a project.
- **Shared** notes belong to everyone.

A note has a kind (fact, preference, decision, procedure or reference), a title, a body up to 2,000 characters, up to 8 tags, an importance from 0 to 100, and a pinned flag. There are limits of 300 live notes per scope and 1,000 overall.

Turn the feature on in Settings › Experimental. With it off, no memory tools are listed and nothing is added to prompts, but you can still read and write notes for review on the Memory page.

### Who writes what

- Your notes are usable immediately.
- A bot's note in its own scope is usable immediately but still marked as written by a bot.
- A bot's note for a project or everyone waits for your review. Even with the shared-writes switch on, it is not shown or used until you approve it.

Every write is checked for passwords, keys and instructions that look like attempts to change the bot's rules, and is refused if it matches. A bot can write at most five notes per turn and 2,000 characters per note. A note keeps its ten newest versions; every edit includes the version you saw, so two editors cannot silently overwrite each other.

### What a bot sees

While memory is on, a turn may receive a short list of reviewed notes the bot may see, pinned first and then by importance. The list is added to the prompt text, not to the bot's instructions, so saving a note does not force a new coding-agent thread. It is resent only when it changes or after the conversation moves to a new thread. A bot never sees another bot's private notes.

A bot can search, read, write, update and forget notes. It only sees reviewed notes it is allowed to see. Forgetting removes a note but keeps its history.

**About you:** the note in Settings › Manager, **What it knows about you**, appears beside your name in every bot's instructions. Unlike memory, editing it changes the bot's instructions, because it is part of the personality.

## Skills

### What a skill is

A skill is a folder with a `SKILL.md` at its root: a name (lower-case letters, digits and hyphens, up to 64 characters), a description up to 1,024 characters, a body, and any files the skill needs. Bitbots copies the body and files into its own folder; it never runs a skill automatically.

The pool is shared: one copy serves every bot. A global switch turns the pool on or off, and each bot can opt out of an individual skill. A skill that already exists in a coding agent's own skill folder is not offered twice.

### Import and use

1. Open Settings › Skills. **Scan** reads the standard skill folders without changing them.
2. Choose the skills to import. Nothing is imported automatically. A skill whose content already matches is marked the same; a changed one is marked changed.
3. Turn a skill on or off globally, or per bot.

A bot can list the skills it can see, load one, and read its files. Loading a skill gives the bot the folder, the description, the body and the file list, so a bot that can run commands can use the skill's scripts under its normal permissions.

Bitbots refuses linked folders, reserved device names, more than 200 files and more than 20 MB, and keeps a complete copy only after the import succeeds.

## Check the result

- A new automation shows its next run time; **Run now** starts one immediately and does not move the schedule.
- Pausing all automations stops new runs; it does not cancel one already running.
- A note you create appears immediately; a bot-written project note appears as unreviewed until you approve it.
- A bot's skill list matches the skills enabled for it.
- After a restart, the automations, notes and skills are still present.

## If something fails

**An automation did not run.** Check the global pause, the automation's own switch, its pause reason, the automation limit and whether the bot already had a user turn. The run history names the reason.

**An automation paused itself.** Three consecutive failures pause it with "Paused after three failed runs". Read the failed run, fix the prompt or the environment, then resume; resuming clears the failure counter.

**A memory note is missing from a prompt.** It is unreviewed, deleted, belongs to another bot's private scope, or the feature is off. Review it on the Memory page.

**A skill will not import.** It is too large, contains a linked folder, has an invalid name or description, or its folder has no `SKILL.md`. The import result names the skipped item.

**A skill loads but its script fails.** Bitbots copied the files but does not provide the runtime the script expects. The bot runs it with its normal permissions and reports the error; install the missing dependency in the environment the bot uses.

How it works: [conversation lifecycle](../reference/sessions-and-turns.md) keeps the queue and automation timing; [approvals and permissions](../reference/approvals-and-permissions.md) explains the automatic rules.
