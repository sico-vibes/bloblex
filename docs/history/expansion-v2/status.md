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
| 1A backend | Durable task ledger and board RPCs (backend) | OpenCode DeepSeek | targeted-tests-pass | Commit `67611fd`, merged to `main` at `26ec193`. Director reran storage (125) and daemon (464) tests and clippy on the merged tree. Fake-adapter tests only: no live provider run. `bounded` and `manager_completes` supervision return `unsupported`. |
| 1A UI | Board UI (the UI half of 1A) | Director | implemented-unverified | Commits `fec61f4` and `4107d5d`, merged to `main` at `26ec193`. Typecheck, 1,377 UI tests and both production builds pass on the merged tree. Checked in the browser preview against fixture data (Bitbots dark Board; Frost and Pop before the theme removal). The real app was launched once with an isolated database; no task was dispatched to a real bot. |
| 1B | Supervision policies | OpenCode DeepSeek (backend) | not-started | |
| 1C | Task schedules | OpenCode DeepSeek (backend) | not-started | |
| 1D | Tree and timeline views | Director (UI) | implemented-unverified | Same commits and gates as 1A UI. Preview only, fixture data; the Tree and Blobots looks were not re-checked after the merge. |

Phase 1 has five slices in the approved plan. The fifth is not yet named in the brief, so it has no row here. It is added when it is named. Slice 1E in the earlier working notes is a phase 5 item (remote read-only list), not a phase 1 slice.

Slice 1A is split into two rows because its backend and UI are in different lanes and are at different states. Both rows stay open until the 1A backend is reviewed and the board is checked in the remaining looks.
