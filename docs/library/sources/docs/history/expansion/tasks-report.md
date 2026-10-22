# Task and daemon lane paused report

> **Status:** historical record, superseded in part (see update).
> **Last updated:** 2026-10-22

**Update 22 October 2026.** The owner resumed the expansion on 21 October 2026. The task ledger, board and task backend are merged to `main` at `26ec193` (see [status.md](../expansion-v2/status.md)). This report describes the worktree at the pause; its test results were not rerun on `main`.

State at the owner pause on 2026-10-21 (Europe/London): **paused, unmerged, uncommitted**. The goal cannot resume until the owner explicitly resumes implementation. The lane worktree remains at baseline `64344a6866db0fa8e6618995a0e14edd4d6da7e7` (`v0.1.0-beta.36`). No release, live-provider execution, or integration into the main checkout occurred.

## Worktree contents

Uncommitted task lane changes are in `crates/bloblex-storage/src/lib.rs`, `crates/bloblex-daemon/{Cargo.toml,src/main.rs,src/team.rs,src/automations.rs,src/backup.rs,src/remote/web.rs}`, `crates/bloblex-adapter-acp/src/{catalog.rs,exec.rs,lib.rs}`, `Cargo.lock`, and new `crates/bloblex-daemon/src/{tasks.rs,platform/}`. Documentation in this worktree includes `tasks-contract.md` and this report. Read-only status at pause showed no other task-lane source paths. This is an incomplete source snapshot; later edits are not covered by earlier test results.

## Verified commands and limits

These are historical targeted results, not gates on the latest paused source:

| Command | Result | Evidence boundary |
|---|---|---|
| `cargo check -p bloblex-storage` | Passed | Before later origin-context and per-device grant edits. |
| `cargo test -p bloblex-storage task_ledger_tests -- --nocapture` | 5 passed | Covered task draft/dispatch, schedule occurrence idempotency, bounded correction cap and then-current project-grant semantics. Before latest origin/device edits. |
| `cargo test -p bloblex-storage runtime_preferences_tests -- --nocapture` | 1 passed | Runtime preference storage, before latest source changes. |
| `cargo test -p bloblex-daemon task_create_is_draft_only_and_dispatch_is_single_idempotent_owner_action -- --nocapture` (`RUST_MIN_STACK=33554432`) | 1 passed | Earlier task dispatch path only; not a full worker/review lifecycle. |
| `cargo test -p bloblex-daemon runtime_preferences_are_provider_scoped_and_change_only_future_conversations -- --nocapture` (`RUST_MIN_STACK=33554432`) | 1 passed | Provider catalog validation and future-only model preference behavior. |
| `cargo test -p bloblex-daemon platform:: -- --nocapture` | 12 passed, 1 failed | The frozen older connector snapshot expected one advertised transport; observed two. Platform later supplied a corrected snapshot, which was not rerun here. |

Subsequent task source edits added manager-review fake-adapter coverage, plan-only supervisor configuration, origin-context storage, and per-device grant checks. They were **not compiled or tested**. A prior daemon compile exposed connector-call-signature and environment-string errors; source was adjusted but no clean compile was observed after those edits. There is no authoritative current compile/test result. No live Cargo process was observed at the pause checkpoint; do not infer that earlier processes or logs represent latest source.

## Implemented in source, not yet verified as a complete product path

The storage and daemon source includes additive task/run/event/idempotency records; create/read/update/dispatch and schedule operations; Manager task-draft tools; lifecycle callbacks; supervisor/reviewer and scheduler logic; startup reconciliation; runtime preferences; task settings and event projections; task source URL validation; platform schema/API scaffolding; connector and OpenCode free-check modules copied from the platform lane; provider mapping for Cursor/Grok; and request-origin context propagation. `tasks-contract.md` records the intended wire shape, including the single atomic owner `task.dispatch` action and immutable per-run assignee snapshots.

## Outstanding acceptance work

- Exercise worker dispatch, claim/session-bind/restart ambiguity, failure, cancellation, timeout process stop and stale-slot cleanup against the latest source.
- Run real daemon Manager review tests for all three policies, valid and malformed decisions, missing evidence, review rejection, version races, correction rounds and the shared 30-minute cap. The later fake-adapter test was added but not run. Verify the Manager reviewer has effective plan-only/no-write access even when its ordinary bot profile is Full access.
- Verify scheduler once/cron/DST, pause, overlap, missed/restart handling, archived or busy bot handling, unattended approval non-bypass, and existing approved-delegation ledger linkage. These remain unproven.
- Verify append-only observed TaskRun intervals, immutable run agent identity, remote origin/tier/device propagation through delegation/review/correction, content-free event redaction, and source provenance.
- Compile and test the final platform connector/free snapshot, including allow-once action approval, denial/timeout/revoke races, automation behavior, OAuth edge cases and secret redaction. The last connector snapshot was not validated in this tree.
- Complete the per-device grant semantic tests (UTC-offset-equivalent expiry, malformed expiry fail-closed, project-bound connection, exact device, revoke/expiry) and resolve any compile issues before implementation resumes.
- Update the task-specific IPC docs and skill map/recipe after source review; run independent peer review and the full backend gates only after explicit resume.

## Safe continuation

Keep this worktree and the UI/platform worktrees intact. Do not cherry-pick or merge their files by broad copy: the three snapshots contain overlapping ACP, daemon manifest, and platform-module changes. After the owner resumes, reconcile contracts and snapshots file by file, run task-focused tests first with a lane-specific `CARGO_TARGET_DIR`, and use isolated `BLOBLEX_DB_PATH` plus a disposable project for integration. Use a short apostrophe-free path for Windows native builds. Preserve the main checkout's user changes and do not restart the installed app without the owner's direction.
