# Bloblex session handoff

## Current carry-forward (1 October 2026, evening)

The implementation plan is [docs/E2E_PLAN_V2.md](docs/E2E_PLAN_V2.md). The current delegation pipeline is in [AGENTS.md](AGENTS.md): the Director directs and reviews, `impl` and `impl-b` implement, and `qa` reports to the Director. Current pointer: **Phase 3 implemented, awaiting merge** ([docs/PHASE_3_SPEC.md](docs/PHASE_3_SPEC.md), branch `task6-grok`). Native smoke (spec section 9) is still for the Director; no temp database path is recorded because that smoke was not run in this lane. Backend work follows the revised plan order.

`docs/E2E_PLAN_V2.md` is the current authoritative plan; [Bloblex_E2E_Windows_Desktop_Plan.md](Bloblex_E2E_Windows_Desktop_Plan.md) remains the original product plan and history. Both remain readable.

## Resume, 1 October 2026, 21:35–22:30 BST (direct UI work)

The user resumed UI work after a failed attempt by another assistant (Grok) at 21:19–21:27, which had edited `App.tsx`, `styles.css`, `BlobCanvas.tsx`, `main.tsx` and `characterMotion.test.ts` with no git history to diff. At that point 77/78 tests passed (companion sound toggle failing). This session replaced the affected surfaces:

- **Character**: `blob/blobEngine.ts` (port of Coucou `mochi/engine.ts` on a sphere with Grok Bot proportions) and `blob/greetingScene.ts` (port of `mochi/greeting.ts`). `BlobCanvas.tsx` keeps its props and lifecycle guarantees and now drives the engine. The old hand-written greeting/ambient approximation in `motion.ts` was removed; only `GreetingLifecycle` and `DizzyRecoveryDeadline` remain. Details: [companion-motion.md](docs/companion-motion.md).
- **Main window**: OpenMausBot-style shell (sidebar roster with search and live blob rows, slim header with conversation switcher and model pill, centred chat column with grouped bubbles and the blob face on agent groups, pill composer). Details/Runtime/Files is now a toggleable inspector (`bloblex.inspector.open` in localStorage). New `ui/shell.css`; obsolete rail/header/message/composer rules removed from `styles.css` (settings, usage, dialogs and inspector pane rules kept).
- **Companion**: Coucou island structure and CSS (`ui/companion.css`): compact floating bar with face, live status and peer minis; expanded tab header; overview focus card + agent pills; approval, confused, drop, chat, activity and settings views. Window sizes changed to compact 344×62, greeting/home 640×160, chat/activity 640×264 (`companionLayout.ts`, `tauri.ts`, `set_companion_mode` in `src-tauri/src/lib.rs`).
- **Preview harness (dev only)**: `vite.preview.config.ts` aliases the Tauri bridge to `src/preview/fixtureBridge.ts`; `preview.html` is a character sheet. Not part of the production build.

Evidence at 22:28: `tsc -b` clean; `vitest run` 78/78 across 17 files (4 tests for deleted approximation code removed; character tests rewritten for the engine; two mounted-test timing adjustments documented inline); `vite build` 402.72 kB JS / 50.40 kB CSS; `cargo check -p bloblex-desktop --lib` with `CARGO_TARGET_DIR=target/qa-desktop-ui` passed. Browser checks used the fixture preview only. **Not yet done:** a native `npm run desktop:dev` run of this build (transparency, drag, DPI, real resize timing, file drop), and per-blob model/effort/speed configuration, which needs daemon support (the daemon's `runtime.profile.*` are launcher profiles; `session.new` takes no model or effort). The header model pill shows the session's reported model or "CLI default" and opens Runtime settings; it does not change the model.

Checkpoint: **1 October 2026, 20:37 BST — STOPPED at the user's request**. The goal is paused; all three agents and identified Bloblex development processes were stopped. Only documentation was completed afterward. Read [STOPPED_CHECKPOINT.md](docs/STOPPED_CHECKPOINT.md) first for the consolidated UI/source-borrowing/evidence snapshot. Do not automatically resume. Earlier “in progress” statements below are chronology, not current running tasks.

Workspace: `C:\Users\jbmst\OneDrive\Documents\ChatGPT\Bloblex`. Windows PowerShell. Git branch `master` currently has **no commits**; the implementation files are local/untracked. There has been no push or release. Preserve the complete working folder, not just a Git ref.

## Read first

1. This handoff and `AGENTS.md` for current user instructions.
2. [Implementation status and open checklist](docs/implementation-status.md).
3. Current plan: [E2E_PLAN_V2.md](docs/E2E_PLAN_V2.md). Original product plan/history: [Bloblex_E2E_Windows_Desktop_Plan.md](Bloblex_E2E_Windows_Desktop_Plan.md), especially sections 31, 32, 35, 36 and 37.
4. [Current independent UI QA log](docs/qa-ui-execution.md), [UI fidelity criteria](docs/qa-ui-fidelity.md), [full QA report](docs/qa-report.md) and [findings register](docs/qa-findings.md).
5. [Coucou source mapping](docs/companion-motion.md), [IPC contract](docs/ipc-contract.md), `PRODUCT.md` and `DESIGN.md`.
6. [Preserved user screenshots](docs/ui-reference-images.md). Exact copies and hashes are retained in documentation, including the negative reference for the old pill; temporary clipboard paths are no longer required.

## Current user instructions

- Build the complete local Windows desktop app from the supplied plan, in this folder. The main concept image is design direction, not an exact acceptance screenshot.
- Keep Coucou's interaction behavior, adapted to a bottom-middle, freely draggable floating bill. The user rejected the first generic capsule/status row, mouths and missing welcome/idle/typing/online/file-upload behavior.
- Use Coucou's MIT interaction, layout and animation source directly where practical; do not merely approximate it from screenshots. Maintain original Bloblex art and the plan's protected-asset boundary.
- Finish UI behavior and polish before returning to backend expansion.
- Computer Use and browser interaction tests stay deferred until the final implementation stage.
- **The root/coordinator must not touch code anymore.** Its task is documentation and orchestration. A third Luna QA agent now tests independently and sends findings to the two implementers.
- Three authorized Luna 6 High lanes: desktop implementation, character/runtime implementation, independent QA. Do not add more agents. Existing handles below may be unavailable in a fresh session.

Current agents in this chat:

| Handle | Lane and ownership |
| --- | --- |
| `/root/desktop` | App/styles, companion FSM/layout and native shell; source mapping document |
| `/root/runtime` | Currently character/motion/helpers/tests and upstream animation primitives; backend lane paused |
| `/root/qa` | Independent tests/review, direct findings to implementers, `docs/qa-ui-execution.md` |
| `/root` | Documentation, handoff/checklist and coordination only |

## What exists now

The repository began with only the plan and concept. It now contains a Rust workspace with a separate daemon, normalized adapter contract, ACP/OpenCode/Codex/Claude adapters, SQLite persistence, discovery, usage/pricing and budget helpers, WSL helpers, hook helper and a React/Tauri desktop application. This describes implementation presence, not full acceptance.

The native shell starts `bloblexd.exe`, retains a per-process capability outside React, and proxies authenticated loopback RPC/WebSocket events. The daemon owns runtime/session state. SQLite supplies snapshots and retained event sequences. Renderer state is rebuilt from snapshot/replay, not just transient events. The loopback alternative is permitted by plan section 8's architecture options; later named-pipe-specific roadmap items still require an explicit compatibility review.

The main UI has an agent rail, conversation, Details/Runtime/Files context, composer, permission controls, usage and settings surfaces. Native commands support project selection, editor/reveal/path actions and window/tray controls. Several controls and recovery paths still need acceptance evidence.

The companion is being revised into a rounded rectangular floating shell with Home/Chat/New Session/Settings navigation, a selected-session glance and real runtime peers. The latest source includes inline chat and local file-reference preparation. These changes are not in the old running executable until it is rebuilt and relaunched.

Coucou source is pinned to `8e12bed56134d2ee7165e73f132646b143ce56e4`. Root verified the vendored FSM exactly after newline normalization and the animation primitives after excluding whitespace/provenance headers. `CompanionFsm` wraps the imported FSM; `DampedSpring` extends its imported `Spring`. The greeting is a source-equation port adapted to Bloblex's original circular rendering, with a 4.6s timeline, gaze/blinks, growth, dip/pop, floating hands, wave, tuck, badge and settling. Current provenance/layout work is still evolving; consult the mapping document and QA log.

## Evidence and chronology

| Checkpoint | Result and limit |
| --- | --- |
| Environment and discovery | Node 25.8.0, npm 11.11.0, Rust/Cargo 1.94.0, VS2022 Community C++ and WebView2 154.0.4258.48 verified. CLI probes: Claude 2.1.286, Codex 0.159.3, OpenCode 1.18.34. |
| CLI authentication | CLI-owned commands reported Codex ChatGPT login and Claude claude.ai login. OpenCode reported credential configurations; configuration presence is not proof of valid authentication. No credentials copied. |
| Earlier independent backend suite | `cargo test --workspace --exclude bloblex-desktop` passed 26 reported tests at an earlier checkpoint. Opt-in live smoke body was skipped by default; some early parser assertions were weak. This is not a current all-provider result. |
| Earlier native Codex check | Actual native Codex session returned exactly `BLOBLEX_QA_OK` to a harmless no-tools prompt and reached Completed. This proves the basic text path only. |
| Earlier native windows | Both surfaces observed; closing main hid it to tray; companion could reopen main. Background dragging persisted coordinates. Old grip interaction/transparency/provider label had defects. Revised behavior needs final checks. |
| Claude live smoke | Real provider returned a weekly quota error. Do not repeatedly retry without confirming an account reset. No billing/auth bypass. |
| OpenCode live smoke | First attempt accepted prompt but timed out after 120s. An implementer later reported completion, but the assertion also matched the user prompt. Corrected exact assistant-role assertion exists; independent rerun remains pending. |
| ACP fake child | Implementer reported 4 passing lifecycle fixtures for RPC ID collision, session-scoped permissions, cancel and pending-approval cancel. Remaining opaque option/EOF/error/resume coverage and independent rerun are open. |
| Independent frontend checkpoint | Earlier 15 tests passed. Later 7 focused greeting/motion tests passed before direct-source integration. These do not establish revised native fidelity. |
| Last native inspection build | Daemon and production frontend built; native build initially needed three small monitor-selection compile fixes, then succeeded. Assets: 301.34 kB JS / 30.31 kB CSS. Native app launched successfully. |
| UI reprioritization | User supplied seven Coucou/current-app screenshots and rejected the pill and stripped behavior. Both implementers moved to UI; direct source reuse replaced the handwritten FSM/spring approach. |
| Independent UI QA checkpoint | QA agent independently passed 32/32 tests across 7 files and TypeScript/Vite production build: 1596 modules, JS 350.85 kB / CSS 40.58 kB. Gaze, StrictMode cleanup, reduced-motion dizzy recovery, file-after-thinking and greeting bounds findings were corrected with fixtures. Native behavior remains unobserved. |
| Latest implementer source after independent checkpoint | Desktop subsequently added an inert accessibility guard, reporting typecheck, 32/32 tests and production build passing (JS 350.87 kB / CSS 40.58 kB). Independent rerun after that final attribute remains pending. Runtime reports final focused motion tests 10/10. |
| Isolated native compile | Desktop reports `CARGO_TARGET_DIR=target/qa-desktop; cargo check -p bloblex-desktop --lib` exit 0. No new executable was launched or inspected. |
| Latest backend source checkpoint | Storage/daemon compile passed in `target/qa-runtime` after metric-demand/valuation changes. Those latest budget changes have not had a full independent test rerun. Backend work is paused. |
| QA ownership and status | Third Luna 6 High QA reports directly to both implementers and owns `docs/qa-ui-execution.md`. Its source findings are closed at the fixture level; native shape/morph/clipping, input/focus, approvals, file drop and provider acceptance remain open. |

No current full E2E acceptance, installer/VM pass, signed release or trusted updater is established.

All three agents delivered their current UI/QA checkpoint reports. Backend remains paused; they are available for follow-up, but do not assume they are still actively editing. Root's latest actions were documentation only. Protected sounds were not imported, and sound cues remain omitted; full audiovisual parity is not established.

### Continuation at 18:45 BST

Root revalidated all three agent handles as completed, then dispatched follow-up work to those same agents; no additional workers were created. The completed documentation turn was concrete progress. Current next work is a broader UI source audit rather than closing fidelity based on helper tests:

- QA independently rechecks the final accessibility edit and audits plan sections 4/5/6/23/26/27/28 plus the Coucou fidelity matrix. Findings go directly to the owning implementers; native interaction stays deferred.
- Desktop replaces generic summary-field/JSON presentation with structured real usage/cost/budget UI and reviews usable settings, focus and local-file reference lifecycle.
- Character/runtime compares the remaining idle/online/typing/tool/file-receive/drop behavior to pinned Coucou source and coordinates honest file preparation states with desktop. Backend expansion remains paused.
- Root maintains documentation only. Open app PIDs `27896`, `21716`, `28828` were read-only revalidated at 18:45; no UI interaction or process action occurred.

Source review found the usage sheet still showing arbitrary first-six fields and JSON objects, and settings missing parts of the plan's Agents/Permissions/General controls. Those are UI implementation gaps, separate from deferred native proof. Missing backend capabilities must be documented honestly, not simulated by a working-looking control.

Further continuation evidence: desktop has replaced the generic usage presentation and added explicit Agents/Permissions sections in source, but many native/backend setting consumers still need implementation; section presence alone is not functional completeness. QA confirmed async Tauri listener teardown and StrictMode stored-selection hydration races and requested production-path fixes/fixtures. Runtime reports 18 focused tests passing after adding sampled thinking/activity motion, slow error blinking and a `fileStage` contract (`drop`, `ready`, `sending`, `error`). Desktop is integrating that contract and native file-reference validation. These changes are in flight and not covered by the earlier independent 32-test result. Preserve the deferred native/GUI gate.

### Continuation at 19:07 BST

- QA has written a full source-coverage matrix in its owned log against plan sections 4/5/6/23/26/27/28. It explicitly distinguishes helper fixtures, App/Canvas wiring and missing native/mounted evidence. General settings consumers, agent defaults, permission policy defaults, compact numeric usage/budget, tray entries, focus/accessibility and current development-build plumbing remain tracked; adding an unavailable page is not closing a feature.
- The character lane reports **27/27 focused tests** across motion/character/status. File stages now include `drop`, `preparing`, `ready`, `sending`, `error`, wired at both companion canvas sites. Preparing cues run during actual native inspection, with no content upload or invented percentage. Explicit file/input interactions now supersede stale completed-success cues while genuine offline/permission/budget/rate-limit/provider-error barriers retain priority.
- Native `inspect_local_file` source canonicalizes a readable regular file and returns path/name/size without reading contents. Preparation error/cancel/host access and Windows fixture proof remain open. A referenced path is not a copied/uploaded provider attachment.
- Desktop is still settling broader App/native UI changes. Whole frontend/current native acceptance is not proven by the earlier independent 32-test build or runtime's focused suite.
- Root reassigned the existing character implementer to a separate native file-inspection test module, coordinated with desktop's production ownership. QA will independently run it after settlement. No extra agents were created, and backend expansion remains paused.
- The desktop lane was asked to verify the supported `npm run desktop:dev` build/staging path with live sidecar locks, and produce an isolated native executable after settled frontend checks. No new artifact launch is claimed.
- At a read-only 18:59 process check, desktop PID `27896` was absent while daemons `21716` and `28828` remained present. The cause was not determined; root performed no stop/restart or UI action. Revalidate again before any lifecycle action.

Deterministic component/hook tests with mocked Tauri/DOM are allowed; only Computer Use/browser/native UI interaction is deferred. Existing frontend suites are mostly helper fixtures. A suitable DOM test dependency is not currently installed, so a mounted production test would need coordination rather than being claimed from source review.

At 19:12 desktop reports TypeScript passing after integrated permission selection, connection-aware moods, agent context-menu actions, file-reference validation and compact confused feedback. Structured usage/range selection and focus/menu polish are still being settled. The native test module `apps/desktop/src-tauri/src/file_inspection_tests.rs` exists and is registered; its isolated `target/qa-file-inspection` Cargo test job is compiling Tauri dependencies, with no result yet. Fixtures exercise canonical metadata and unchanged content, Unicode/spaces, missing/directory rejection and Windows exclusive-sharing failure. QA reviewed the actual production function (metadata/handle only, no content reads) and will independently execute the tests after settlement. Dev/staging target changes and the new isolated executable are still pending. Treat all current whole-UI results as in progress.

### User launch blocker and repair, 19:18–19:28 BST

The user tried `npm run desktop:dev` and supplied a screenshot of `failed to remove target\debug\bloblexd.exe: Access is denied (os error 5)`. Root read-only verified daemon PIDs `21716` and `28828` executing that exact file, with no desktop process present. The screenshot is preserved as [reference image 8](docs/ui-reference-images.md). This was a real running-executable lock, not a request to elevate or delete user files.

Desktop paused optional settings polish and changed:

- Development defaults to `target/desktop-dev`; release defaults to `target/desktop-release`. Explicit `CARGO_TARGET_DIR` is respected.
- Staging resolves Cargo metadata's target directory and validates both daemon/hook sources before copying. `BLOBLEX_STAGE_DESTINATION` enables private regression staging.
- The native shell copies the daemon into a unique app-local `runtime-processes` executable before spawn and keeps that exact path for cleanup, separating daemon runtime locks from compiler/staging outputs.

Evidence so far:

- Runtime added `scripts/stage-daemon.test.mjs`; QA independently passed **3/3** using temporary custom targets/destinations and inert fixture files. Debug/release hash preservation and missing-hook failure before partial staging were exercised.
- QA independently passed **4/4** native file-inspection tests under `target/qa-file-inspection`, including actual Windows exclusive-sharing open failure. This closes that narrow production-function test gate, not the file-drop/provider/native-rendering flow.
- Desktop reports daemon and hook successfully built in `target/desktop-dev` in 74s. The old locked `target/debug` executables/processes were preserved.
- QA source review confirmed another startup race: the original `start_daemon` released its slot mutex before spawn/handshake, allowing both windows to launch children and overwrite ownership. Serialization is being added before the supported-command startup check.
- Complete `npm run desktop:dev` native startup and safe repeat rebuild are **not yet proven at this checkpoint**. QA/desktop are coordinating the actual command with a temporary `BLOBLEX_DB_PATH` and separate WebView profile. The user's fix/run request authorizes this process launch; Computer Use/browser/native interaction remains deferred.

Root has not edited code, killed the old daemons or run GUI tests. Do not mark the launcher fixed solely from the source changes/limited tests; retain the actual-start gate.

At 19:35 the desktop lane reports retrying the supported command with `BLOBLEX_DB_PATH=target/desktop-dev/isolated-smoke.sqlite`. The launcher source now selects an available port (the reported retry selected 1421 while preserving the occupied 1420), passes it consistently to Vite/Tauri/CSP and uses `com.bloblex.desktop.dev` for development app data. The native `daemon_start_lock` guard is present. No successful app startup, single-child observation or rebuild-while-running result has yet been received; inspect the actual command output before advancing these gates. QA is checking generated-config path resolution and startup evidence.

QA subsequently independently passed the settled frontend: **55 tests across 12 files**, `npm run typecheck` and `npm run build` all exit 0. The Vite 6.4.3 production build processed 1601 modules and produced JS 379.56 kB / CSS 45.27 kB. This supersedes the earlier 32-test build checkpoint for frontend checks; it does not establish native rendering or interaction acceptance. Desktop's supported-command native build is still in progress. The startup guard and dead-child executable-copy cleanup are present in current source.

### Verified launch and forced rebuild, 19:45–19:49 BST

The supported `npm run desktop:dev` command successfully built and launched `target/desktop-dev/debug/bloblex-desktop.exe` with the explicit isolated smoke database. Desktop reported the successful Cargo run; root and QA independently observed app PID `18860` and one private daemon PID `19184`, parent `18860`. QA verified its loopback listener `127.0.0.1:52021`, app-local path under `%LOCALAPPDATA%/com.bloblex.desktop.dev/runtime-processes/`, and daemon hash matching the then-current staged/Cargo binaries (`AE98F195…EFC7F897`). Both original daemons remained running from `target/debug`.

QA then performed a **forced** isolated rebuild while this private daemon remained live: with desktop confirming Cargo idle, `CARGO_TARGET_DIR=target/desktop-dev cargo clean -p bloblex-daemon` removed only that package's isolated outputs, and the daemon/hook rebuild succeeded in 32.05s. QA staged into `target/qa-rebuild-staged`; rebuilt/staged hashes matched (`8A6F6AF0…4A4C60C2`) with a new 19:48:43 timestamp. The private running copy retained its earlier hash/timestamp and stayed listening on the same port. PIDs `21716`/`28828` and their old executable were preserved.

This closes the reported compiler-output lock regression for this observed instance and establishes a supported-command native startup checkpoint. It does **not** close full GUI/Coucou fidelity, cross-window IPC flows, concurrent-start stress, owned process-tree shutdown, installer or full product acceptance. Smoke-process cleanup is coordinated with desktop; re-check processes rather than assuming these historical PIDs still exist. Root only edited documentation and read processes/hashes.

Cleanup outcome: desktop's command to stop only smoke daemon `19184` and app `18860` was rejected before execution with `rejected: blocked by policy`. It was not retried through another mechanism. At the reported checkpoint those two smoke processes remain running, using `target/desktop-dev/isolated-smoke.sqlite`; the original daemons remain untouched. Treat this as a cleanup limitation, not graceful Quit/lifecycle proof. Revalidate ownership and respect the rejection before any later process-control action.

### UI continuation after the launch repair, 19:55 BST

Root reused all three existing Luna 6 High handles; no additional agent was spawned. Desktop owns approval expiry/deadline/pinning behavior, the dismissible RuntimeExplainer, missing Active sessions/Pause all/Settings tray actions and settings with actual consumers where existing APIs support them. Character/runtime owns mounted Canvas lifecycle/state tests and a separate original opt-in sound module, coordinated with desktop's preferences. QA coordinates the single writer for DOM-test dependencies and independently reviews production wiring and meaningful mounted fixtures. Root remains documentation-only.

Backend expansion and Computer Use/browser/native interaction remain deferred. DOM-based React unit tests are permitted and must be distinguished from native visual proof. No live provider actions, test-session cancellation, startup registry changes or process-control workaround are authorized as incidental QA. Currency preferences cannot relabel returned amounts or fabricate conversion; a saved default model is not applied unless its consumer actually uses it. The latest 55-test/build and native launch results remain a historical baseline until this new source settles and QA checks it again.

QA coordinated and installed the single test-only DOM dependency `happy-dom@20.14.5` (`^20.14.5` in the desktop manifest); root lockfile is updated and manifest ownership released. No mounted-test result is claimed from installing it. Read-only audit found two moderate findings in the pre-existing dev-only Vitest/mocker chain, with no `happy-dom` advisory path; production-only audit reported zero. No broad upgrades or `npm audit fix` were performed.

Character lane subsequently reports **12/12 focused tests**: seven real React-mounted `BlobCanvas` fixtures and five sound-module fixtures. They exercise StrictMode/visual reinitialization greeting completion, pointer interruption/no completion on teardown, reduced motion, poke recovery, visibility/observer teardown and file-stage rendering/barriers. `soundCues` is now an explicit Canvas opt-in prop, false by default; the mount fixtures distinguish silent main avatars from opted-in companion poke. This is implementer evidence pending independent/integrated QA, not native pixels/audio.

QA found that main Settings initially enabled/unlocked a main WebView context while shared main avatars could play poke cues. Desktop/runtime are integrating companion-only ownership, a local speaker/gesture unlock and shared preference synchronization. QA must check that only one currently active companion Canvas owns playback across compact/expanded/greeting modes, and stale completion/approval does not replay merely because a canvas remounts. Root has only reviewed source and documented these findings.

At the next source checkpoint desktop reports **69/69 tests and typecheck** (implementer result): mounted production approval-button fixtures reject an expired click and forward a live opaque choice. This does not yet prove the actual App clock/pin/lifecycle; character/runtime now owns a separate `App.lifecycle.mounted.test.tsx` against the real App with native/network/draw boundaries mocked. QA supplied fixture contracts and will independently review listener teardown, initial selection, deadlines and sound ownership.

By 20:18, tray Active sessions/Pause all/Settings, close-to-tray preference consumption and native monitor picker are present in source. Desktop is compiling them under isolated `target/qa-desktop-ui`; no pass is claimed yet. Main Settings now persists/broadcasts sound preference without unlocking its own audio context; companion subscribes before hydration and discards stale GET results after a newer preference event. Compact/greeting/home primary canvases are conditionally mounted, while peer avatars remain silent. Integrated tests and final native interaction remain open.

Process observation at **20:18:33 BST**: root and desktop independently found former smoke app `18860` and private daemon `19184` absent, with old daemons `21716`/`28828` unchanged. Neither agent manually stopped them. Native source was edited while the dev watcher existed; the actual old dev-session output must be checked before assigning an exit cause. Do not turn this observation into graceful Quit/cleanup acceptance or retry blocked process control. Historical successful launch/rebuild evidence remains valid for its prior checkpoint.

## Running app, data and build isolation

At the recent process checkpoint the old inspection app was desktop PID `27896`, daemon PID `21716`; an earlier owned daemon PID `28828` remained orphaned after its desktop exited. **PIDs are historical observations. Re-check before acting.** Do not terminate a PID merely because it is listed here.

The inspection executable is `target\debug\bloblex-desktop.exe`. It embeds production assets; the Vite server does not update this executable. The running app is an older UI checkpoint. Its database should be preserved.

- Default database: `%LOCALAPPDATA%\Bloblex\bloblex.db`.
- Isolated daemon tests: set `BLOBLEX_DB_PATH` to a fresh test path. Do not reuse the live database for destructive or replay/recovery tests.
- Native companion placement: Tauri app-config `companion-position.json`, with monitor-relative anchoring in revised source.
- Capability secrets are memory-only; never paste them into documentation.
- Backend isolated target: `target/qa-runtime`.
- Desktop isolated target: `target/qa-desktop`; the QA lane can use its own target and coordinate sidecar staging.
- Tauri's build script copies/removes sidecars in the target directory. A check against `target/debug` can fail with Access Denied while the live daemon executable is locked. Use an isolated target instead of stopping the app.
- `scripts/stage-daemon.mjs` requires **both** `bloblexd` and `bloblex-hook`, with a target-triple suffix. The revised script follows Cargo metadata's target directory, including `CARGO_TARGET_DIR`; it no longer hardcodes `target/debug`/`target/release`. Private staging destinations are supported for tests. Real Tauri builds must use the staged sidecars selected by their config.

## Safe resume sequence

- [ ] Read current instructions and logs; list live agents/jobs and verify any recorded process handles.
- [ ] Preserve all local files. Git currently has no commits; do not reset/clean the working tree.
- [ ] Continue the current UI checkpoint with implementers and QA. Do not resume backend expansion while this priority remains in force.
- [ ] Have QA independently review the production paths, run frontend checks/build and compile native code in an isolated target. Fix findings through the owning implementer.
- [ ] Confirm a runnable updated native artifact, source provenance and documented build version before arranging relaunch. Do not overwrite the user's running executable or database during a check.
- [ ] At the final verification stage, run native Computer Use against the delivered build, including welcome, rounded geometry, hover/poke/dizzy, typing/thinking, file drop, permissions, shared selection, free drag and reduced motion. Until then mark native behavior unverified.
- [ ] Return to the full backend and distribution checklist after the UI checkpoint, preserving all plan gates.
- [ ] Record exact commands/results and limits in QA logs, then update this handoff/status document. Only close requirements when proof covers their entire scope.

## External conditions and optional work

- WSL inventory was only `docker-desktop`; no ordinary development distro was available. Do not modify Docker's internal distro to manufacture a WSL acceptance pass.
- Signing identity, trusted distribution, updater keys/endpoint and a clean Windows VM are not configured/proven. Implement the pipeline, but do not invent successful signing or VM evidence.
- [Magpie assessment](docs/magpie-assessment.md) recommends an optional later gateway connection after native v1. The user asked for research, not implementation or a plan expansion. No Magpie code/configuration/credentials were installed.
- Remote runtimes are optional phase 11. Do not spend current v1 effort on them.
- Memory was searched for Bloblex context; no relevant saved project entry was found. These workspace documents are the durable handoff. Do not write global memories unless the user explicitly asks.

Original artifact integrity, independently rechecked at this checkpoint:

```text
Bloblex_E2E_Windows_Desktop_Plan.md
B49E27B0E61B39D88BDA22AE76D9D4707F41E5116B905DBE411B1418623C3679

Bloblex_UI_Concept.png
6DC7B02BEE87E00211BB0675A8754663EA2A3B01B442A2A9CF7ACF4DC0342C0C
```
