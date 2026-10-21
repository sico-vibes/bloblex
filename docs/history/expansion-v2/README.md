# Expansion v2 records

> **What this is:** The index for the expansion v2 records: the approved plan, the slice briefs, the RPC shapes, the status table, and the working arrangement that applies to every slice.
> **Status:** in progress; phase 1 started with slice 1A, and the records below are added as each slice is written.
> **Last updated:** 2026-10-21

## Context

The owner approved the restart of product expansion on 21 October 2026. The plan is [expansion-plan-v2.md](../../plans/expansion-plan-v2.md). It replaces the Codex draft's UI, whose backend is kept as reference only.

## Records

| Record | Where | State |
| --- | --- | --- |
| Approved plan | [docs/plans/expansion-plan-v2.md](../../plans/expansion-plan-v2.md) | Written. |
| Slice 1A backend brief (task ledger and board RPCs) | `docs/history/expansion-v2/` | Not yet written. |
| RPC shapes | `docs/history/expansion-v2/` | Not yet written. Added with slice 1A. |
| Status | [status.md](status.md) | Written. One row per phase 1 slice. |

The earlier records are `docs/operations/expansion-handoff-2026-10-21.md` and `docs/history/expansion/README.md`. They are untracked in the owner's main checkout and are not in this worktree, so they are named here by path only.

## Working arrangement

Phase 1 and every slice after it follow this arrangement.

- **Three lanes.**
  - The Director (Claude) does all UI and UX work, from the owner's reference images and [the design system](../../design/design-system.md).
  - OpenCode DeepSeek v4.1 flash (high effort) does all backend and test work, from a written brief.
  - Claude Haiku 5.5 does the documentation, from the briefs, the diffs and the gate results.
- **Lanes never commit.** The Director reviews the diff, runs the gates, and commits.
- **The Director reviews every diff** and sends work back until it is right.
- **The Director checks every screen against the owner's reference image** in each look the slice touches: Bitbots (the Frost look), Blobots, Legacy, Pop and Dot.
- **Nothing is marked done** until its state in [status.md](status.md) is backed by evidence.

## Naming

In the board UI a lane is one bot's column. The delivery term "lane" keeps its meaning in the delivery process. See [the style guide](../../STYLE.md).
