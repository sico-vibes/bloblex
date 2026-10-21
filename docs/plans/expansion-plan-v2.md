# Bitbots expansion plan v2: tasks, desktop wins, providers, trusted access and phone relay

> **What this is:** The approved plan for restarting Bitbots product expansion after the first Codex draft: the verdict on that draft, the features and their difficulty, the five phases with their gates, the 23 slices, and the rules every slice follows.
> **Status:** owner directive; approved 21 October 2026. Phase 1 in progress (slice 1A). Progress is recorded in [status.md](../history/expansion-v2/status.md).
> **Last updated:** 2026-10-21

## Context

Codex built a first expansion draft. The owner reviewed it and approved a restart. The verdict:

- **The backend is a draft.** Codex's backend work is kept as reference only. It sits in unmerged worktrees and is not merged into `main`.
- **The UI drifted from the owner's reference images.** The owner's reference images are the design brief. The drift:
  - The tree was an indented list, not a node graph.
  - The timeline bars were unlabelled.
  - The board used a dropdown, with Assign as the main path. The owner's board is drag-based.
  - The connector cards were text-only and had a duplicate heading.
  - Onboarding showed fixture chips, not the real setup.
- **The fix is to rebuild the UI from the references and ship in small slices.** Each slice is gated before the next one starts.

The working arrangement is three lanes, for this plan:

| Lane | Who | Does |
| --- | --- | --- |
| UI and UX | The Director (Claude) | All UI, UX and visual work, checked against the owner's reference image in every look the slice touches. |
| Backend and tests | OpenCode DeepSeek v4.1 flash, high effort | All Rust, daemon, storage, adapter and test work, from a written brief. |
| Documentation | Claude Haiku 5.5 | Reports, design rules, handoffs and status, written from the briefs, the diffs and the gate results. |

Lanes never run `git commit`. The Director commits after the gates pass.

## Goals

- Rebuild the Tasks, board, tree and timeline views from the owner's reference images, in all five looks.
- Add the desktop features the owner wants next: terminal dock, chat background effects, and a GitHub inbox.
- Add free setup and providers: Cursor and Grok, and a managed CLI download.
- Add trusted access: MCP connectors, then computer control, each behind owner approval.
- Add a phone relay last, behind a threat-model review.
- Keep every bot's work under a runtime cap, a concurrency cap and a global pause.

## Scope

### Features

Difficulty is as recorded in the approved plan. "Current state" is what the owner has recorded. Where the owner has not recorded it, the cell says so, and it is confirmed when the slice starts.

| Feature | Current state | Wanted | Difficulty | Slices |
| --- | --- | --- | --- | --- |
| Tasks, board, tree and timeline | Codex draft in unmerged worktrees. The board, tree and timeline drifted from the references (see Context). | Rebuilt from the references: a board with an Unassigned list on the left and a lane per bot on the right, a node-graph tree, and a labelled timeline. Drag a task onto a bot to start it or queue it. | Medium | 4 |
| Schedules on tasks | To confirm at slice start | A schedule on a task, run by the daemon under the unattended-work limits. | Medium | 1 |
| Terminal dock | To confirm at slice start | A terminal dock on the desktop. | Easy | 2 |
| Chat background, six effects | To confirm at slice start | Six background effects behind the chat. | Easy | 1 |
| Cursor and Grok | To confirm at slice start | Cursor and Grok as providers. | Medium | 1 |
| GitHub inbox | To confirm at slice start | A GitHub inbox on the desktop. | Easy | 1 |
| MCP connectors | Codex draft: connector cards were text-only, with a duplicate heading. | Connector cards rebuilt from the references. Every external connector action needs owner approval. | Hard | 4 |
| Free setup and managed CLI download | Codex draft: onboarding showed fixture chips. | Setup that works with free tools, and a managed download of the CLI. | Medium | 2 |
| Computer control | To confirm at slice start | Computer control for bots, off by default per bot and per window, with owner approval for each action. There is no phone viewer. | Hard | 3 |
| Encrypted relay and QR pairing | To confirm at slice start | An encrypted relay and QR pairing for phones. Local development only until the threat-model review passes. | Very hard | 4 |

The total is 23 slices.

### Phases

| Phase | Name | Slices | Gate |
| --- | --- | --- | --- |
| 1 | Tasks and board | 5 | Clean compile. The board matches the reference in all five looks. Supervisor tests pass. |
| 2 | Desktop wins: terminal, chat background, GitHub inbox | 4 | Native smoke test in the installed app. |
| 3 | Providers and setup | 3 | One real free tool call. One live Cursor or Grok session. |
| 4 | Trusted access: connectors, then computer control | 7 | Every external tool call needs owner approval. Stop and revoke are tested. |
| 5 | Phone relay | 4 | Threat-model review before any non-beta release. |

Phase 1 holds the Tasks, board, tree and timeline slices (4) and the schedules slice (1), which makes 5. The slices are listed under Work items.

## Decisions

### Runtime and spend

- **Unattended work has a runtime cap.** The default is 30 minutes.
- **Concurrency is 3 inside the global 4.** Unattended work runs at most 3 at a time, inside a global limit of 4.
- **There is a global pause.** One action stops all unattended work.
- **The permission mode is never bypass** for unattended work.
- **Money budgets are retired.** The retirement is recorded in [AGENTS.md](../../AGENTS.md) (12 October 2026 amendment). Do not show a budget or a spend limit as enforced.

### Unknown stays unknown

- A value the app does not know is shown as unknown. It is never shown as zero, and never guessed.
- A test result is shown as what was actually run. A test that was not run is "not verified".

### Secrets

- Secrets are stored only in Windows Credential Manager.
- SQLite holds references to secrets, never the secrets themselves.
- No secret, token or credential appears in logs, docs or the UI.

### Trusted access

- Every external connector action needs an allow-once approval. There is no standing approval.
- Reviewers are read-only. A reviewer bot cannot change files or run actions that change state.
- Computer control is off by default, per bot and per window.
- Remote methods stay denied until the shared tier table and its parity test cover them. The tier table is in [the Remote amendment in AGENTS.md](../../AGENTS.md) (17 October 2026).
- The phone relay is local-development only until the threat-model review passes.

### Licences

- Monocode is MIT. Its code may be reused with its notices kept.
- Codync is Apache 2.0. Its code may be reused with its notices kept.
- OpenBot is PolyForm Noncommercial. Its ideas may be rebuilt independently. Copy nothing from it.
- affectUI terms must be checked before any of its component code is copied. Layouts are rebuilt from the owner's screenshots, not copied from affectUI.

### Design

- The owner's reference images are the design source for every board, tree, timeline and connector screen.
- The Director checks each screen against its reference image in every look the slice touches.
- The five looks are Bitbots (the Frost look), Blobots, Legacy, Pop and Dot.
- In the board UI, a lane is one bot's column. The delivery term "lane" (see the names table in [the style guide](../STYLE.md)) is unchanged.

## Work items

### Phase 1: Tasks and board

| Slice | Name | Lane |
| --- | --- | --- |
| 1A | Durable task ledger and board RPCs | Backend (OpenCode), board UI (Director) |
| 1B | Supervision policies | Backend |
| 1C | Task schedules | Backend |
| 1D | Tree and timeline views | UI (Director) |

The phase has 5 slices. The fifth slice is not named in the owner's brief and is not yet listed here. It is added when it is named.

Slice 1A is the first slice. It holds a durable task ledger and the board RPCs. The board is a drag-based UI with an Unassigned list on the left and a lane per bot on the right. A task dragged onto a bot starts it or queues it.

### Phase 2: Desktop wins

Terminal dock (2 slices), chat background effects (1 slice), GitHub inbox (1 slice).

### Phase 3: Providers and setup

Cursor and Grok (1 slice), free setup and managed CLI download (2 slices).

### Phase 4: Trusted access

MCP connectors (4 slices), then computer control (3 slices).

### Phase 5: Phone relay

Encrypted relay and QR pairing (4 slices). The threat-model review is the gate before any non-beta release.

## Acceptance

- Each slice compiles cleanly and passes its targeted tests before the next slice starts.
- Each UI slice is checked against the owner's reference image in every look it touches, and the Director records what was seen.
- Each phase meets the gate in the phase table.
- Nothing is called implemented until its gate has run. Unverified work is marked as unverified.
- The earlier records are at `docs/operations/expansion-handoff-2026-10-21.md` and `docs/history/expansion/README.md` in the owner's main checkout. They are untracked there and are not in this worktree.
