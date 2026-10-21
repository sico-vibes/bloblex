# Expansion v2 status

> **What this is:** The status of each phase 1 slice of the expansion v2 plan, with the state of each and the evidence that backs it.
> **Status:** in progress; phase 1 started with slice 1A.
> **Last updated:** 2026-10-21

## States

Each row uses one of these states, and no other:

- `not-started`: no work has begun on the slice.
- `in-progress`: a lane is working on the slice.
- `implemented-unverified`: the code is written, and no test has been run against it.
- `targeted-tests-pass`: the slice's own tests pass.
- `integrated-E2E-pass`: the slice passes the end-to-end check in the installed app.

The evidence column names the run, the commit or the screen check that backs the state. It stays empty until there is evidence.

## Phase 1: Tasks and board

| Slice | Name | Owner lane | State | Evidence |
| --- | --- | --- | --- | --- |
| 1A backend | Durable task ledger and board RPCs (backend) | OpenCode DeepSeek | in-progress | Lane running in `D:\fx60` (branch `exp/tasks-backend`). Not reviewed. |
| 1A UI | Board UI (the UI half of 1A) | Director | implemented-unverified | UI branch `exp/board-ui` commit `fec61f4`: typecheck clean, 13 new tests pass (taskModel 5, taskViews 4, DelegateBoard mounted 4), `npm run build` passes, board, tree and timeline checked in the browser preview (Frost dark and Pop light only; Dot, Legacy, Blobots and light Frost not yet checked). Runs against fixture data only, not the daemon. |
| 1B | Supervision policies | OpenCode DeepSeek (backend) | not-started | |
| 1C | Task schedules | OpenCode DeepSeek (backend) | not-started | |
| 1D | Tree and timeline views | Director (UI) | implemented-unverified | UI branch `exp/board-ui` commit `fec61f4`: typecheck clean, 13 new tests pass (taskModel 5, taskViews 4, DelegateBoard mounted 4), `npm run build` passes, board, tree and timeline checked in the browser preview (Frost dark and Pop light only; Dot, Legacy, Blobots and light Frost not yet checked). Runs against fixture data only, not the daemon. |

Phase 1 has five slices in the approved plan. The fifth is not yet named in the brief, so it has no row here. It is added when it is named. Slice 1E in the earlier working notes is a phase 5 item (remote read-only list), not a phase 1 slice.

Slice 1A is split into two rows because its backend and UI are in different lanes and are at different states. Both rows stay open until the 1A backend is reviewed and the board is checked in the remaining looks.
