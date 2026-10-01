# Implementation status and remaining checklist

Checkpoint: **1 October 2026, 20:37 BST — paused/stopped by the user**. Read [STOPPED_CHECKPOINT.md](STOPPED_CHECKPOINT.md), [SESSION_HANDOFF.md](../SESSION_HANDOFF.md) and [AGENTS.md](../AGENTS.md) first. All agents and identified Bloblex development processes were stopped. This checklist is an unfinished backlog, not permission to proceed. The supplied [plan](../Bloblex_E2E_Windows_Desktop_Plan.md) remains authoritative; no requirement was removed by the pause.

The user requires UI behavior and polish first. Backend expansion is paused. The coordinator now performs documentation and orchestration only; two Luna 6 High implementers own production changes, and a third Luna 6 High QA agent independently checks them and reports directly to them. Native Computer Use and browser interaction checks remain deferred until the final stage.

At 18:45 BST the coordinator reused all three completed agent handles for a broader UI continuation: QA audits complete plan UI coverage, desktop handles structured usage/settings and file-flow UI, character/runtime handles remaining Coucou state/drop interactions. Native proof and backend expansion remain deferred. Results from that continuation must be recorded before treating the new source as covered by the earlier 32-test checkpoint.

Continuation findings: the generic usage sheet has now been replaced in source, Agents/Permissions pages are present but mostly explicit unavailable/read-only states, and QA confirmed asynchronous listener cleanup plus StrictMode saved-selection hydration races. Implementers are fixing those and integrating distinct file-reference stages/native validation. Runtime reports 18 focused motion tests; an independent settled full frontend/native build remains pending. The seven supplied screenshots are now preserved as hash-verified documentation references in [ui-reference-images.md](ui-reference-images.md).

At 19:07 BST the character lane reported 27/27 focused fixtures and both file-stage Canvas sites wired, including a real native inspection-only `preparing` state and regression for stale success masking new user input/file activity. This is implementer evidence, not the forthcoming independent whole-frontend result. QA now maintains a complete plan UI source matrix. The same character agent is assisting desktop with a separate production-function native file-inspection test module; backend work and GUI verification remain deferred.

At 19:12 desktop reports current TypeScript passing. Native production-function fixtures are now present and registered in `file_inspection_tests.rs`; the isolated Cargo test job is compiling dependencies, so no native test pass is claimed yet. Full independent frontend checks and a current isolated native executable remain pending while desktop settles usage range/focus/menu work and development staging.

At 19:28 the user's actual dev-command executable-lock error has become the immediate priority. Source now isolates development/release Cargo targets, stages from Cargo metadata and runs a private daemon copy. Independent QA passed staging **3/3** and native metadata/access tests **4/4**; desktop reports the isolated daemon/hook build successful. QA found a concurrent two-window daemon-start ownership race; serialization and actual supported-command startup/rebuild proof remain pending. Old daemon processes/data were preserved; no Computer Use was resumed.

Latest independent settled frontend checkpoint: **55 tests across 12 files**, `npm run typecheck` and `npm run build` exit 0; Vite 6.4.3 processed 1601 modules, JS 379.56 kB / CSS 45.27 kB. This supersedes the earlier 32-test checkpoint below. The supported-command native build remains in progress; startup serialization and dead-child copy cleanup are now present in source, but their live verification remains open.

At 19:49 the supported native development command has successfully launched the current app with an isolated smoke database. Root and QA independently observed one private daemon child; QA verified its loopback listener and matching source/staged/run-copy hash. QA then forced an isolated package clean/rebuild and private staging while that daemon stayed live; new build/staged hashes matched and the old private run copy remained unchanged/listening. The original two daemon processes were untouched. This proves the reported executable-lock repair for one instance; native UI, concurrency stress and full lifecycle gates remain open.

At 19:55 all three existing lanes resumed UI work: deadline-driven approval expiry/pin cleanup, RuntimeExplainer, missing tray actions, useful persisted settings, original opt-in sound cues and mounted Canvas/lifecycle fixtures. These are assigned work, not completed requirements. QA owns independent review/checks and coordinates DOM-test dependency ownership. Backend expansion, live provider/registry/process-control side effects and native/browser interaction testing remain deferred. The 55-test/build result predates this new pass.

Character lane now reports 12 focused passes (seven real Canvas mounts, five sound-module fixtures), including a false-by-default companion-only cue gate. Independent integrated QA remains pending. Source review also found cross-WebView sound ownership/unlock and potentially simultaneous companion Canvas playback; desktop is integrating local speaker controls and shared preferences, and QA will test wiring rather than infer it from isolated module fixtures. The approval deadline/reply guard and RuntimeExplainer are present in source, with mounted App proof still pending.

Subsequent desktop checkpoint reports 69 tests/typecheck passing, including mounted approval buttons; actual App listener/selection/deadline/audio integration fixtures are now assigned to character/runtime. Tray entries, close-to-tray and monitor consumers are present in source; isolated native check `target/qa-desktop-ui` is running. These are source/implementer checkpoints, not current independent or native UI acceptance. At 20:18 root/desktop observed the prior smoke app/child absent without manual stop; old daemons remained, and no graceful Quit was established.

## How to read the checklist

- A checked item records a completed artifact or a specific proven check, with its limits. It does not close the whole work package.
- An unchecked item needs implementation, verification, or both. Existing source is described beside it so a new session does not unnecessarily rebuild it.
- Independent QA evidence, implementer reports and source presence are distinguished. Earlier checks apply to their earlier source checkpoint.
- Every work package still has open acceptance work. No section 35 product gate is signed off as complete.

## Completed artifacts and proven checkpoints

- [x] Rust workspace, React/TypeScript/Vite desktop, Tauri shell, separate daemon and hook-helper projects created in this folder.
- [x] Main window and companion launched together in an earlier native inspection build; basic close-to-tray and reopen-from-companion observed.
- [x] One actual native Codex text turn returned `BLOBLEX_QA_OK` and completed using its existing CLI login. Tool, approval, cancel, resume and recovery paths were not established by that turn.
- [x] Native version probes found Claude Code 2.1.286, Codex 0.159.3 and OpenCode 1.18.34. Authentication remains CLI-owned; OpenCode credential configuration presence alone is not an authentication pass.
- [x] Earlier independent backend suite passed 26 reported tests; the default opt-in live-smoke body did not run. Latest backend financial changes are outside that result.
- [x] Coucou source pinned to `8e12bed56134d2ee7165e73f132646b143ce56e4`; actual FSM and animation primitives vendored with notices, layout excerpt and greeting-equation port documented. See [source mapping](companion-motion.md) and [notices](../THIRD_PARTY_NOTICES.md).
- [x] Independent final frontend checkpoint: **32 tests across 7 files**, `npm test` exit 0. `npm run build` passed TypeScript plus Vite 6.4.3, 1596 modules, JS 350.85 kB / CSS 40.58 kB. See [QA log](qa-ui-execution.md).
- [x] Independent recheck after the subsequent desktop/character UI changes: **55 tests across 12 files**, typecheck and production build passed; JS 379.56 kB / CSS 45.27 kB. Helper/unit/build evidence does not close mounted/native interaction gates.
- [x] Desktop implementer reported isolated native compilation: `CARGO_TARGET_DIR=target/qa-desktop`, `cargo check -p bloblex-desktop --lib`, exit 0. This was a compile check, not a new launched native build or installer.
- [x] Root handoff, collaboration instructions, development guide and full remaining checklist created; original plan/concept hashes preserved in the handoff.

The earlier inspection executable embeds older assets. The latest 55-test frontend checkpoint has **not** been observed in a relaunched native window; the supported-command native startup check is in progress.

## Current UI checkpoint: implemented source versus open proof

Source now includes a rounded rectangular floating shell, compact/expanded 14px/22px corners, source FSM and spring/layout adapters, Home/Chat/New Session/Settings navigation, actual runtime peer chips, inline composer and local file-reference preparation. Character source has mouth-free original circular art, idle/online/typing/thinking/tool/file states, hover/gaze/blinks, click squash, three-tap dizzy state and source-timed welcome wave.

The 4.6-second greeting ports growth, dip/pop, happy eyes, gaze, timed blinks, floating low-left dot and higher tilted-right oval, wave/tuck, badge and settling. Original art remains separate from protected Mochi assets. This is not a claim that Coucou's entire renderer, every screen or every upload sequence was copied unchanged.

QA found and implementers corrected gaze direction/scale, premature greeting completion during React StrictMode cleanup, reduced-motion/unmount dizzy recovery, later file activity hidden by thinking, and horizontal greeting appendage bounds. Focused fixtures now cover those findings. Runtime reports its final motion suite 10/10; the independent full frontend result above is the broader proof.

- [ ] Arrange a current runnable native artifact after source settlement; document exactly which assets it embeds, without overwriting the open inspection app during a check.
- [ ] Observe rounded geometry, transparency and shell growth/morph alignment; confirm native hit regions track visible content.
- [ ] Observe full welcome choreography, pointer interruption, hover keep-open timing, explicit compact/hide, navigation and exactly-once completion.
- [ ] Observe idle, online, typing, thinking, tool/file activity, success/error, budget/rate-limit warnings and three-tap dizzy recovery, including reduced motion and visibility changes.
- [ ] Verify original character/no mouth, floating appendage placement, badge clearance and card/content clipping in the actual window.
- [ ] Compare Coucou's remaining interaction coverage, including upload/drop preparation and sound-toggle behavior. Protected sounds are not imported; sound cues are currently omitted, so do not describe this as full audiovisual parity.
- [ ] Verify inline chat Enter/Shift+Enter, empty/blocked submission, draft preservation on failure, session switching, cancellation and keyboard/focus accessibility.
- [ ] Verify real native file drop/picker, explicit local-reference submission and cancel/error behavior. The present path stores references; it does not prove an uploaded file or justify fabricated upload progress.
- [ ] Verify approvals pin the correct session across navigation/drag, only supported replies appear, reply/cancel errors remain visible and both windows agree.
- [ ] Verify shared selection/provider identity, no stale activity from previous turns, compact/expanded layout, long content and narrow/small-monitor fit.
- [ ] Verify the source replacement of the first-six-fields/JSON usage sheet with structured actual usage/cost/budget views; complete usable Settings coverage for Agents/Permissions/General and explicitly record unsupported backend/native capabilities. Root identified the initial presentation gap at the continuation checkpoint; desktop's source revisions still require independent checks.
- [ ] Verify async Tauri listener disposal and idempotent initial saved-selection hydration under StrictMode replay; QA confirmed both races in production source and sent corrections to desktop.
- [ ] Verify native canonical file-reference validation and metadata/error stages before the UI reports readiness, including directories, missing/unreadable paths, cancellation and session changes. Referencing a local path remains distinct from uploading file content.
- [x] Independently exercise production native file inspection on regular/missing/directory/space/non-ASCII/Windows locked-unreadable paths in an isolated target: QA passed four Windows fixtures. This does not establish the React file-drop/provider flow or all permission-denied filesystem cases.
- [x] Verify supported `npm run desktop:dev` isolated build/staging/native startup and forced daemon rebuild while a private run copy stays live; QA independently confirmed listener, parent ownership and hashes while preserving the two old daemons. Development serves current Vite source; the 55-test production frontend build is a separate artifact. Installer/full lifecycle/GUI acceptance remains open.
- [x] Independent staging regressions: custom Cargo target/destination, debug/release sidecar hashes and missing-hook failure before a partial copy, 3/3. Actual launcher startup/rebuild remains the preceding unchecked gate.
- [ ] Serialize shared daemon startup across both windows; verify one owned child/readiness under concurrent ensure calls and preserve ownership/cleanup on failure.
- [ ] Verify bottom-center first placement, freely draggable shell, persisted monitor-relative anchor, off-screen recovery and DPI/monitor changes.
- [ ] Implement and verify deadline-driven approval expiration and malformed-date handling, including stale-reply rejection and unpinning without unrelated renders.
- [ ] Implement the dismissible RuntimeExplainer and missing Active sessions/Pause all agents/Settings tray actions, with actual normalized state and visible errors.
- [ ] Add original opt-in audio and real sound/close-to-tray/monitor/default/currency consumers where supported; preserve protected-asset and honest currency/default application boundaries.
- [ ] Add meaningful mounted React Canvas/App lifecycle, greeting completion, file-state and accessibility tests; these complement rather than replace the final native checks.

## Work packages from plan section 36

### WP-01 — Repository and Tauri shell

Present: workspace/manifests, desktop build scripts, main/companion native windows, CSP, tray and sidecar wiring. Earlier debug native build and launch succeeded. README links the entry points.

- [ ] Establish a reproducible fresh install/build, including both daemon and hook sidecars, with required toolchain documented.
- [ ] Preserve and checkpoint all local work; Git has no commits at this checkpoint. No commit/push/release is claimed.
- [ ] Resolve final Bloblex license/distribution choice and audit notices/artifacts; review Multica's license before any code reuse.
- [ ] Complete first-run/runtime setup and empty/offline/compatibility states without invented connectivity.

### WP-02 — Procedural blob renderer

Present: Canvas renderer, imported spring primitives, source greeting pose port, gaze/poke/dizzy helpers, visibility-aware scheduling and reduced-motion logic; independent fixtures pass at the current frontend checkpoint.

- [ ] Complete the native visual/input checks above, including warning/error/success and all requested Coucou state transitions.
- [ ] Measure active smoothness near 60 FPS, idle CPU/cadence and hidden-window pause; inspect lifecycle cleanup and multiple visible characters under load.
- [ ] Confirm the emitted bundle contains original art only and no restricted media.

### WP-03 — Companion and tray

Present: direct upstream FSM wrapper, layout adapter, native resize/position controls, navigation, inline chat, shared selection, local file references and tray commands. Earlier tray/reopen behavior was observed before the latest UI rewrite.

- [ ] Complete current transparency, morph, drag, display/DPI, keyboard and approval-pinning acceptance.
- [ ] Verify enable/hide/show/main-close/companion-only flows and restored settings.
- [ ] Verify explicit Quit cleanly stops every owned child while preserving unrelated CLI processes. An earlier daemon remained orphaned after desktop exit; fallback direct-child termination is not full process-tree proof.

### WP-04 — Daemon and IPC

Present: separate Rust daemon, authenticated local RPC/WebSocket transport, native capability held outside React, runtime/session registry and event sequence. Plan section 7 permits loopback WebSocket; later roadmap/security text specifically names pipes.

- [ ] Document/verify equivalence of the chosen loopback transport against named-pipe-specific roadmap/security requirements; audit user isolation, capability lifecycle, origin and unauthorized-call rejection.
- [ ] Verify responsive prompt acceptance, per-session active-turn exclusion, global concurrency, provider cancellation during a pending prompt and supervised owned process trees.
- [ ] Verify heartbeat/probe refresh, adapter exit/EOF, sleep/resume and daemon restart recovery without prompt resend.
- [ ] Test replay gaps, multiple pages, reconnect and a **consistent snapshot sequence**. Mutating stored state and appending its event under separate locks can expose state paired with an older sequence; the atomicity review remains open.

### WP-05 — SQLite and migrations

Present: schema/storage, event retention, stable message IDs, partial history, permissions, usage, reservations, valuations and startup recovery helpers. Latest valuations/financial changes compile in the implementer's isolated backend target.

- [ ] Verify migrations/versioning and upgrade from real older databases; preserve user data during failed migrations.
- [ ] Prove atomic state/event persistence, replay reconciliation, message dedupe and stable final/delta/thinking merges after crash/restart.
- [ ] Verify recovery of volatile runtime/session/turn state and expired permissions, retention of native resume IDs and partial history.
- [ ] Test persisted cost valuations and reservations across restart, including unknown values, currencies and period boundaries.

### WP-06 — Runtime discovery

Present: native executable resolution/version probes, npm-wrapper fixtures and runtime/profile storage. Real installed versions were found locally.

- [ ] Apply saved profiles to actual discovery/launch/probes; verify custom executable, arguments, environment, host/distro and project defaults.
- [ ] Filter incompatible protocol overrides and handle paths with spaces/non-ASCII without unsafe shell interpolation.
- [ ] Show real capabilities/auth/probe/compatibility states; file existence and stored credentials are not online/auth proof.
- [ ] Re-probe on refresh/update and preserve distinct native/WSL runtime identities.

### WP-07 — OpenCode ACP

Present: ACP transport and OpenCode adapter; fixes for RPC request/response ID collisions, completion via prompt result, permission mapping and cancellation. Implementer reported four fake-child lifecycle fixtures passing. One real prompt timed out; a later reported pass used a weak assertion matching the user prompt, since corrected.

- [ ] Independently rerun exact **assistant-role** sentinel smoke on the corrected assertion, with deadline and cleanup.
- [ ] Shared adapter suite: probe/new/prompt/stream/cancel/permission/usage/supported-resume/error/EOF.
- [ ] Verify opaque permission option IDs separately from choice kind, correct provider option reply, session allowance scope, deny and stale/duplicate responses.
- [ ] Verify unsupported RPC error replies, initialization capability negotiation, session/prompt deadlines, process failure and no leaked children.

### WP-08 — Unified chat and event model

Present: normalized DTOs, snapshot-based reducer, delta/event dedupe, tools/files/permissions/usage/budgets, main chat and context surfaces. Current frontend unit tests cover selected reducer/selector/layout paths.

- [ ] Golden sanitized fixtures must exercise production parsing for all providers, with no raw protocol JSON leaking into ordinary React state.
- [ ] Verify code/markdown, normalized tool/command/file/plan cards, timeline ordering, scrolling, token batching and long-history responsiveness.
- [ ] Verify real Details/Runtime/Files/usage/settings actions, display-safe errors and restored cross-window state.
- [ ] Verify project-bound editor/reveal/copy-path/diff behavior; changed files must not be executed through default associations.

### WP-09 — Codex app-server

Present: installed-version schema archive, app-server adapter, thread/turn operations and normalized events. Basic native no-tools text turn independently passed.

- [ ] Verify actual initialized notification, provider IDs, interrupt, supported thread resume, usage attribution and compatibility capability reporting.
- [ ] Shared adapter suite and real tool/file/approval/cancel/resume paths, including EOF/error/crash/recovery.
- [ ] Verify existing CLI-owned subscription login remains in use throughout; no credentials copied.

### WP-10 — Claude adapter and hook bridge

Present: structured stream/control-request parsing, permission response/control cancellation, active-turn lifecycle fixes, resume IDs and bounded hook helper. Real smoke encountered weekly provider quota; a successful Claude turn has not been proven.

- [ ] Shared adapter suite plus actual session/tool/file/usage/permission/cancel/resume/error paths when provider account conditions permit.
- [ ] Verify second and subsequent turns, correct EOF/error/completion handling and exact permission request IDs.
- [ ] Complete hook install with backup, reviewable diff and uninstall/restore; verify correct bridge/auth/session binding.
- [ ] Test helper outage, malformed/oversized input and timeout fail-open behavior. Normal external Claude CLI use must remain usable.

### WP-11 — Permissions

Present: daemon records and actual adapter reply paths, supported UI choices, expiry and companion priority/pinning; UI error/cancel source revisions exist.

- [ ] Prove exact supported reply reaches the real provider once from either surface; persistence alone is insufficient.
- [ ] Verify denial, session-scoped allowance, stale/duplicate/expired replies, disconnect, cancellation while approval is pending and restart reconciliation.
- [ ] Verify both windows resolve/update, no stranded overlay and no false success after reply failure.

### WP-12 — Usage normalization

Present: raw usage persistence and normalization helpers with runtime/session/turn/model attribution. Unit coverage exists but does not cover every provider event shape.

- [ ] Prove cumulative versus delta handling, duplicate avoidance, unknown counters and cache-exclusive buckets using production fixtures/live outputs.
- [ ] Verify per-runtime/session/model/day/month aggregates and restart consistency; partial totals stay explicitly partial.
- [ ] Persist raw usage before valuation and preserve provenance/provider fields needed for revaluation.

### WP-13 — Pricing and subscriptions

Present: alias/rate helpers, subscription concepts and newly persisted valuation source; latest integration is compile-only.

- [ ] Verify aliases/canonical models, effective dates/catalog version, all used token buckets and user overrides.
- [ ] Verify missing rates yield unknown/partial, never misleading zero; currency-safe summaries must not add unlike currencies.
- [ ] Show provider-reported actual cost, API-equivalent estimate and fixed subscription charge distinctly in usable summary/detail views.
- [ ] Verify persisted basis/version/provenance, daily/monthly rollups and account-quota labeling without invented quota remaining.

### WP-14 — Budgets

Present: daemon admission, reservations/reconciliation helpers and metric-specific demand changes. Earlier token reservation tests passed; latest expanded integration has only a compile checkpoint.

- [ ] Implement/verify every required metric and global/provider/runtime/session/project scope, hierarchy and reset-period semantics.
- [ ] Real concurrent admission test proves atomic persistent reservations across all applicable policies; no bypass between overlapping policies.
- [ ] Verify warnings, hard block reason, release/reconciliation after error/cancel/EOF and restored ledger after restart.
- [ ] Verify reliable live cancellation where supported, explicit limits where unsupported and companion budget warning state.
- [ ] Independently rerun complete financial integration tests after backend work resumes; do not substitute character count for unrelated metric demand.

### WP-15 — WSL

Present: inventory/path helpers and host architecture. Only Docker's internal `docker-desktop` distro was available on this machine.

- [ ] Complete usable distro executable probes/transport and launch distinct WSL Claude/Codex/OpenCode runtimes.
- [ ] Verify project/path mapping, spaces/non-ASCII, permission/file actions and host/distro labels with a real development distro.
- [ ] Prove session/cancel/recovery/process cleanup across Windows/WSL. Do not repurpose Docker's internal distro for a synthetic pass.

### WP-16 — Updater, signing and distribution

Present: configured NSIS/MSI scripts and daemon/hook staging. Updater disabled pending real keys/endpoint; no trusted release established.

- [ ] Build actual installers containing both sidecars/notices; verify clean install, launch, repair/upgrade and uninstall/data policy.
- [ ] Implement reproducible signing/release pipeline with real certificate/trusted Store route, updater keys/endpoint and verified artifact chain.
- [ ] Verify signed update installation, rollback/error behavior and compatibility re-probe without losing sessions.
- [ ] Test Defender/SmartScreen and fresh Windows VM. External certificate/channel/VM availability is required evidence, not grounds to invent success.

### WP-17 — E2E hardening

Present: [full acceptance contract](qa-acceptance.md), [findings register](qa-findings.md), [historical QA report](qa-report.md), [UI criteria](qa-ui-fidelity.md) and [current independent UI log](qa-ui-execution.md).

- [ ] Finish all shared adapter contracts and sanitized golden fixtures, meaningful parser assertions, argument filtering/security tests and recovery integration.
- [ ] Final native Computer Use: current main/companion, all character states, approvals/cancel, actual file drop/actions, selection, tray and explicit Quit.
- [ ] Windows 11 x64 matrix: DPI 100/125/150/200%, single/dual monitor, native/WSL, daemon/provider crash, offline network, approval timeout, budget block and update.
- [ ] Accessibility, focus/keyboard, reduced motion, long history/token batching and measured idle/active performance.
- [ ] User-triggered sanitized diagnostics/logs: no credentials/capabilities and no full prompts/files by default.
- [ ] Close every finding and section 35 gate with independent current proof; no overall acceptance from a unit count alone.

## Product acceptance checklist — plan section 35

These remain unchecked because each describes the complete product behavior, rather than source presence or an older partial check. [Coverage audit](v1-coverage.md) maps the required proof and gaps.

- [ ] One installer launches the Windows desktop app.
- [ ] Main app and mini companion can be enabled simultaneously.
- [ ] Mini mode retains Coucou-like procedural animation and interactions.
- [ ] Installed Claude, Codex and OpenCode are auto-discovered correctly.
- [ ] Each CLI owns its authentication throughout supported flows.
- [ ] Each agent has a separate resumable conversation where supported.
- [ ] Clicking blobs switches the active conversation reliably.
- [ ] Approve/deny works without opening a provider TUI.
- [ ] Main chat shows normalized real tool/file activity.
- [ ] Companion alerts for permission/completion/error.
- [ ] Usage is correctly tracked per runtime/session/model.
- [ ] Actual cost, API estimate and subscription fixed cost stay distinct.
- [ ] Unknown pricing never appears free.
- [ ] Global and per-agent/session budgets work.
- [ ] WSL runtimes work within the existing architecture.
- [ ] Explicit Quit cleanly stops the owned process tree.
- [ ] Hook failures do not break ordinary CLI use.
- [ ] Release is signed or distributed through a trusted Windows channel.

## Phase gates and optional scope

| Plan phase | Current position |
| --- | --- |
| 0 — legal/technical spike | Code/source restrictions documented; native windows and basic Codex path proven; IPC compatibility and restart/all-provider spike proof remain open. |
| 1 — shell/animation parity | Current frontend fixtures/build pass; native Coucou behavior, scaling and monitor proof deferred. Current priority. |
| 2 — runtime foundation | Daemon/storage/discovery implemented; supervision, consistent replay and recovery hardening open. |
| 3 — OpenCode | Adapter/fake-child work exists; strong independent real lifecycle/approval/resume proof open. |
| 4 — Codex | Basic text path proven; full provider lifecycle/approval/recovery open. |
| 5 — Claude | Adapter/helper exists; quota-limited real evidence and full hook install/fail-open open. |
| 6 — unified permissions/activity | Source and UI fixtures exist; production/provider acceptance open. |
| 7 — usage/cost | Helpers/persistence exist; current integration and financial UI proof open. |
| 8 — budgets | Partial admission/reservation coverage; complete metrics/scopes/periods/live stop open. |
| 9 — WSL | Helpers present; actual usable distro launch/E2E open. |
| 10 — hardening/distribution | Installer pipeline configured; signing/update/clean VM/accessibility/performance gates open. |
| 11 — remote | Optional after local v1; not started and not current scope. |

[Magpie research](magpie-assessment.md) is documented as an optional later gateway connection. The user has not authorized implementation or expanded the plan for it. No Magpie installation, configuration or credentials were added.

## Resume prompt for a new session

> Continue Bloblex in this folder. Read AGENTS.md, SESSION_HANDOFF.md and docs/implementation-status.md before acting. Keep the coordinator documentation/orchestration only; use the two Luna 6 High implementation lanes and one independent Luna 6 High QA lane, reusing live agents if available. Finish the Coucou-source UI checkpoint before backend expansion. Preserve the running app and data. Computer Use stays deferred until final verification. Follow the full supplied plan, distinguish independent checks from source/agent reports, and update the handoff and checklist as work advances.
