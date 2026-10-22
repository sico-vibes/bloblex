# Team and Manager

> **What this is:** how bots are organised into projects, what the Manager can see and propose, and how to work with both.
> **Status:** current; written for v0.1.0-beta.36 and updated for `main` on 22 October 2026
> **Last updated:** 2026-10-22

## Before you start

Onboarding offers to create the Manager. If you skipped it, the empty sidebar shows a Manager setup card. There is exactly one Manager; you can rename it, change its look and model, but not delete, archive or demote it.

## The shape of the team

- **Bots** are the characters you chat with. Each has a role label (up to 40 characters), optional tags, a colour, an art style and a coding agent.
- **Projects** are named folders. A bot assigned to a project works there by default; a bot with no project is in Unassigned and can use any folder you pick per conversation.
- **Tags** on projects and bots are how the Manager routes work: a project says what kind of work it is for, and a bot says what it is good at. Tags are trimmed, lower-cased, 1–24 characters, at most 8 per item and de-duplicated.
- **A leader flag** is a display role. It grants no permissions; the Manager's authority comes from being the Manager.
- **Hidden** bots stay in the team but are out of the sidebar until you show them.

The sidebar shows the Manager first, then projects in your order, then Unassigned. Each bot row carries its name, role and one line: what it is doing now, else its latest conversation.

## Work with the Manager

The Manager works across every project. It can read the team and the projects and plan with you. Its change tools never write directly; each one creates a proposal that waits for your approval. The one exception is `create_task`, which files an unassigned draft on the Tasks board: a draft has no bot, does not run and cannot be scheduled, and you decide which bot takes it ([tasks](tasks.md)).

The proposals are:

| Proposal | What it would do |
| --- | --- |
| New bot | Create a bot, or update an existing one's name, description, role, instructions, tags, look, model, effort or permission. Never Full access. |
| Project | Create or update a project. |
| Assignment | Give a bot a brief, a done goal and a report-back requirement. |
| Open conversation | Start or open a conversation with a bot. |
| Permission change | Change a side conversation's permission to Ask first or Auto. Only for a side conversation the Manager started. |
| Merge | Merge a completed task's work back into its project. |
| Playbook | Change the Manager's own playbook. |
| Profile | Change a locked fact the Manager knows about you. |

Reading the team, projects and conversations needs no approval. Asking you a question appears in the conversation. The change proposals appear as cards in the conversation and in the approval queue. **Approve** applies one, **Reject** discards it, and an edit before approval is applied to that proposal only. Nothing is created before approval; rejecting a proposal does not undo work already done.

### What the Manager knows

The Manager page in Settings has three parts:

- **Manager:** its name, look, model and personality, set on its bot page. Changing the model starts a fresh conversation; the knowledge below survives.
- **What it knows about you:** facts with a category (identity, workflow, style, conventions, design or other), a name, a value up to 1,000 characters, and whether the fact was said, learned or corrected. A fact you lock is not changed directly: the Manager proposes the change and waits.
- **Playbook:** the Manager's standing brief, with a version history and a comparison for every version. Restoring an earlier version is reversible in the same way.

These notes are kept by Bitbots, not by the coding agent, so a new model starts with the Manager's knowledge rather than a blank slate.

### Talk to the team

A bot can message another bot. The message creates a side conversation with its own history and a link back to the one that started it. The Manager uses this to delegate: it can send a brief, open a conversation, or assign a task with a brief, a done goal and a report-back. A reply arrives as a team message in the origin conversation.

Side conversations are read-only to a remote device and are not the place to change a bot's settings.

## Merge proposals

A coding task that shares its project folder with another working task runs in its own copy of the repository. A researcher bot never gets one. When the task completes, a merge proposal offers the merge.

**Approve** merges the work (fast-forward if possible, otherwise a merge commit; never forced) and removes the extra copy. **Reject** keeps it; rejecting with **Discard** removes it. Merge and discard are refused while the task is still working, and a project with uncommitted changes refuses a merge and leaves the proposal pending. A remote device with approval permission may send Discard when approvals from remote are on.

## Check the result

- The Manager appears once, is not in a project, and cannot be archived from its menu.
- A new bot assigned to a project opens new conversations in that folder by default.
- A Manager proposal appears as a card, not as a completed change; the team is unchanged until you approve.
- A locked fact shows a lock, and a Manager edit to it arrives as a proposal.
- After changing the Manager's model, its facts and playbook are still there.

## If something fails

**There is no Manager.** Use the setup card at the top of the sidebar. Creating a second one is refused.

**A Manager proposal is stuck.** It may be waiting for a locked bot to be unlocked, uncommitted changes to be dealt with, or a running task to finish. The card names the blocker; resolve that, then approve again.

**The Manager cannot find the right bot.** Give projects and bots tags that describe the work and the specialism. Tags are the routing vocabulary; names alone are weaker evidence.

**A bot was removed from a project by the Manager.** A team change on a locked bot is refused, so unlock it first if the change is intended. Otherwise reject the proposal and keep the placement.

**A merge says the project has uncommitted changes.** Commit or discard the local changes in the main copy. The proposal stays pending; it is not lost.
