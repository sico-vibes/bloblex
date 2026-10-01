# V1 coverage audit

Authority: the supplied plan, especially sections 3.1, 31, 35 and 37. The user's bottom-center, freely draggable bill overlay replaces top-edge notch placement. Coucou interaction fidelity is required. The concept image supplies direction, not acceptance evidence. Computer Use testing is deferred until the final implementation stage.

This is an in-progress audit, not a release verdict. A requirement closes only when its proof covers the entire behavior. Agent reports are not independent verification.

Current priority: UI behavior and polish. The user has rejected the running companion's stadium shell and simplified expressions; both Luna implementers are working on the UI. Backend development is temporarily deferred, with its open gates preserved. See `qa-ui-fidelity.md` for the new concrete UI checkpoint.

## Section 35 acceptance criteria

| Requirement | Authoritative proof needed | Current evidence and remaining gap |
| --- | --- | --- |
| One installer launches Windows app | Built installer, install/launch/uninstall on fresh Windows | Native debug app builds and launches; installer/clean install remain unverified |
| Main and companion simultaneously | Native windows and enable/hide controls | Earlier native observation showed both; revised companion needs final native check |
| Coucou procedural interactions | Pinned source mapping, motion/state tests, native input/visual check | Direct-source FSM/primitives and greeting port documented; latest independent UI checkpoint has 32 passing tests plus production build. Final later accessibility attribute is implementer-checked; revised native behavior unverified |
| Discover all three installed CLIs | Native executable resolution and version/protocol/auth probes | Installed discovery and wrapper fixtures pass; custom profiles and compatibility details remain open |
| CLI owns authentication | Source audit and real provider session using existing CLI login | No copied credentials found in reviewed paths; Codex basic turn verified; other provider paths incomplete |
| Separate resumable conversations | All three provider lifecycle contract tests and real supported resume | Separate session architecture exists; live resume/contract coverage incomplete |
| Switch using blobs | Native selection and cross-window state evidence | Source uses shared selection; current native synchronization needs verification |
| Approve/deny without TUI | Provider receives exact supported reply once from either surface | UI and bridge implementation in progress; actual provider approvals unverified |
| Normalized tool/file activity | Production parser/DTO fixtures and actual cards/file actions | DTO corrections in progress; conversation activity and file actions incomplete |
| Companion permission/completion/error alerts | Transition fixtures plus native visual/input proof | Source revisions exist; final native acceptance pending |
| Usage per runtime/session/model | Persistent fixtures, live provider output, restart summary | Usage storage exists; cumulative/delta/model attribution and aggregation remain open |
| Actual/API estimate/subscription distinct | Persisted valuations with basis/version, UI and currency tests | Pricing helpers pass; full persisted valuation and usable summary pipeline incomplete |
| Unknown pricing never looks free | Missing/partial rate fixtures and UI evidence | Pricing unit checks pass; current summary/UI still needs end-to-end proof |
| Global and agent/session budgets | Atomic admission, all metrics/scopes/periods, reconciliation/warnings/live stop | Token reservation checks pass; metric-specific integration incomplete |
| WSL supported without redesign | WSL discovery/transport/path fixtures and actual usable distro | Path helpers pass; launch/probe integration incomplete, ordinary target distro unavailable |
| Explicit Quit stops owned tree | Owned process tree before/after Quit, unrelated process preserved | Earlier forced cleanup is not Quit evidence; final explicit Quit check pending |
| Hooks fail open | Helper outage/timeout/oversize/config install/uninstall fixtures | Helper exists; complete bridge/config lifecycle incomplete |
| Signed/trusted Windows release | Signed artifacts and verified chain or trusted Store distribution | No signing identity/channel configured; cannot claim trusted release |

## Required implementation and hardening beyond the headline list

- Runtime profiles must be usable, validated and probed; a saved database row alone does not prove a launchable profile.
- Heartbeats, provider exit, daemon restart, replay gaps, sleep/resume, and persistence must restore state without resending prompts.
- All adapters need shared lifecycle fixtures: probe, session creation, prompt, stream, cancel, permissions, usage, supported resume, error and process exit. Tests must exercise production parsing/protocol handling.
- Financial records must preserve unknown counters, exclusive cache buckets, canonical model IDs, effective pricing versions and separate currencies. Warnings and reservations require a persistent ledger.
- Files need project-bound path resolution, a configured editor, Explorer reveal, copy path and diff actions. OS default execution is not an editor action.
- Settings must expose real supported controls, including agent defaults, permissions, usable profiles, budgets, diagnostics and update channel state.
- Diagnostics must be user-triggered and sanitized, excluding prompts/files by default and all provider credentials.
- Packaging must include the daemon, hook and third-party notices, with signing/updater configuration and cleanup behavior.
- Final UI checks must cover accessibility, reduced motion, display scaling, monitor changes, long histories, token batching and responsive layouts. Unit/build passes do not prove these behaviors.

Remote runtimes (phase 11) and an inference gateway are explicitly outside v1. The optional Magpie assessment does not alter the authorized plan.

For the current work-package checklist and safe resume instructions, read [implementation-status.md](implementation-status.md) and [SESSION_HANDOFF.md](../SESSION_HANDOFF.md). The three authorized Luna lanes have delivered their present UI/source-check checkpoint; final native and broader backend acceptance remains open.

## Current runnable snapshot

On 1 October 2026, root QA rebuilt the daemon, staged it, rebuilt the production frontend (301.34 kB JavaScript, 30.31 kB CSS), corrected three small native monitor-selection compile errors, built the native app successfully and launched it for user inspection. Process checks confirmed the Bloblex window and its daemon. This is a runnable inspection snapshot, not acceptance of the open requirements above.
