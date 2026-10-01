# Bloblex stopped checkpoint

Frozen on **1 October 2026, 20:37 BST**, at the user's explicit request to stop all running tasks, document the work and proceed no further. This is the first document to read when returning to the project.

## Stop state

- The persistent build goal is **paused**, not complete.
- All three Luna 6 High agents (`desktop`, `runtime`, `qa`) were interrupted. None was restarted for this documentation pass.
- After the new explicit stop instruction, the coordinator stopped the identified Bloblex app, old/new daemons, development servers/watchers and their owned child processes. Read-only checks at 20:35 and 20:36 found no Bloblex app/daemon or Cargo/rustc process remaining.
- This was controlled forced task shutdown, **not** a passed test of Bloblex's own graceful Quit/process-tree lifecycle. Earlier cleanup rejection remains historical; it does not describe the final running state.
- No further implementation, tests, builds, provider calls or Computer Use were performed after the stop. Only documentation and the requested task shutdown continued.
- The root/coordinator has not edited application code. The original plan and concept remain authoritative. Work is local/uncommitted; preserve the entire folder, including source, lockfiles, assets and documents.
- Do not automatically resume agents, launch the app, execute this backlog or unpause the goal. A new explicit user instruction is required.

Documentation-only validation at **20:42 BST**: all local links in the updated checkpoint/index/handoff/status/development documents resolve; the original plan and concept SHA-256 hashes match the recorded originals; the final OS check reports **zero Bloblex app/daemon/development tasks**. No product test or build was run for this validation.

## What was borrowed

| Project | Actual use in Bloblex | What was not imported / important limit |
| --- | --- | --- |
| **Coucou** | Direct MIT code reuse of the Windows island FSM and core animation primitives at commit `8e12bed56134d2ee7165e73f132646b143ce56e4`; an excerpt of layout/corner constants; a source-equation port of the 4.6-second greeting. Bloblex adapters connect them to its shell and Canvas. | The complete Coucou app/UI was not copied. Its Mochi character artwork, name, icons, sounds and media are not included. Bloblex has original circular art, provider accents and synthesized sounds. Native visual parity is still unproven. |
| **Multica** | The supplied plan's clean-room runtime pattern: separate local daemon, host/runtime separation, CLI-owned authentication, provider-specific protocol adapters, normalized events, push/replay/reconciliation, runtime discovery, profile concepts, explicit concurrency and raw usage with derived summaries. The implementation is Bloblex's Rust/React/Tauri code. | No vendored Multica product source or Multica dependency was identified in the inspected product sources/manifests. This is architectural borrowing, not a Multica code port. Several capabilities remain incomplete. The plan's custom-license caution and final distribution/license audit remain open. |
| **Magpie** | Research and an optional future integration proposal, including telemetry-source attribution, request/session correlation, deduplication and separation of model routing from the CLI harness. | No Magpie source, binary, gateway, configuration, credentials or integration was installed/imported. The authoritative v1 plan was not expanded for Magpie. Its subscription/credential, approval and gateway-access behavior would require a separate design and acceptance pass. |

### Coucou source map

| Local artifact | Borrowing and adaptation |
| --- | --- |
| `apps/desktop/src/blob/coucou/island/fsm.ts` | Pinned source FSM. Root previously verified equality after newline normalization. |
| `apps/desktop/src/blob/coucou/core/anim.ts` | Pinned `Ease`, `Spring`, `Tracked` and close-curve primitives. Root previously verified source equality excluding whitespace/provenance header. |
| `apps/desktop/src/blob/coucou/core/layout.ts` | Source-derived compact/expanded geometry and 14px/22px corners; an excerpt, not the entire layout module. |
| `apps/desktop/src/blob/companionFsm.ts` | Wraps the source FSM; preserves hidden/compact/home/welcome transitions and timings. Extends approval pinning and disables the source's compact auto-hide for a freely placed desktop window. |
| `apps/desktop/src/blob/companionLayout.ts` | Adapts source layout to 344×62 compact, 640×196 greeting and 640×226 overview logical-pixel windows. |
| `apps/desktop/src/blob/motion.ts` | Greeting-equation adaptation: growth, happy eyes, dip/pop, gaze/blinks, low-left dot/high-right oval, wave/tuck, badge and settling. Uses Bloblex's circular renderer. |
| `apps/desktop/src/blob/BlobCanvas.tsx` | Original Canvas artwork and state rendering; source-informed interaction/motion rather than copied Mochi media. |
| `apps/desktop/src/blob/soundCues.ts` | New original opt-in sine-wave cues; no Coucou sound files. |

Full provenance/timings are in [companion-motion.md](companion-motion.md); the MIT notice is in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). The user requested a bottom-center, freely draggable rounded rectangular bill rather than a top-edge notch or stadium-shaped pill. This placement/visibility adaptation is deliberate.

Multica references are recorded in the [plan's architecture and source sections](../Bloblex_E2E_Windows_Desktop_Plan.md). Magpie's findings, proposed scope and unresolved gates are in [magpie-assessment.md](magpie-assessment.md). Those existing documents are research records, not newly verified upstream compatibility claims.

## Current UI state

“Present” below means source exists. It is not a statement that all interactions were observed in the native window.

| Area | Present at the stop | Evidence / remaining limit |
| --- | --- | --- |
| Main workspace | Three-column agent rail, selected conversation/composer, Details/Runtime/Files context; original provider-colored blobs; safe text/tool/file/diff cards and native file/editor actions. | Earlier independent frontend build passed. Current event-to-card/native action flows still need final interaction checks. Main composer attachment remains disabled. |
| Companion shell | Bottom-center floating rounded rectangle; source-informed 14px/22px corners, mode-dependent size, free drag and monitor-relative saved placement. Home/Chat/New/Activity/Settings, collapse/hide and real runtime peers. | Geometry/source/helper coverage exists; final transparency, native morph, hit regions, clipping, drag, DPI and monitor-change behavior remain unobserved. |
| Character and welcome | Mouth-free original circular body; 4.6-second growth/dip/pop/wave/blink/tuck/badge/settle; idle, online, composing, thinking, working, tool/file, success/error, permission, rate-limit, budget and sleep states. Hover/gaze, poke and three-poke recovery. | Helper and mounted Canvas fixtures exist; focused implementer tests passed. Final native appearance/timing remains open. |
| Local file preparation | Companion native picker/drop, canonical path/name/size/readability inspection, preparing/ready/sending/error cues, cancel/remove and explicit prompt-reference send. No fabricated upload percentage. | Four independent native metadata tests passed. Bloblex does not upload/read file contents; provider path access is conditional. Last source adds a no-session affordance/gates and selection-reset handling; those late fixes were not independently checked after interruption. |
| Permissions | Actual opaque provider choices, shared selection, approval pin, expiry/malformed-deadline filter, nearest-deadline rerender and stale-reply recheck. Mounted choice-button and actual-App lifecycle fixtures. | A mounted button interim pass is reported. Current App-level fixtures were reviewed but not independently executed at the final stopped checkpoint. Real provider replies, cross-window resolution and failure recovery remain open. |
| Runtime explanation | A dismissible, locally persisted explanation of installed CLI connection and CLI-owned authentication. | Source is present; not an independently accepted native interaction. |
| Runtime menu | New session, resume, runtime settings and stop actions, with keyboard/context-menu wiring. | Source/earlier unit/build checks; native keyboard/action acceptance remains open. |
| Tray | Open, show/hide companion, Active sessions submenu, Pause all agents entry, refresh, Settings and Quit. Source connects pause to a main-window confirmation flow. | Updated native library check passed per desktop agent. Real tray clicks/session selection/pause/error handling/owned shutdown were not tested. |
| General settings | Show companion, persisted sound preference, editor configuration; newly wired close-to-tray preference and connected-monitor selection/native consumers. | Source plus implementer native compile. Start with Windows remains unavailable; native persistence/move/close behavior needs acceptance. |
| Agents / Permissions settings | Detected runtime presentation, provider identity and explanations of supported choices. | Default project/model remain read-only; configurable blob appearance and global policy defaults are incomplete. Do not count stored-but-unconsumed settings as functioning features. |
| Usage / Budgets settings | Structured date-bounded tokens, actual cost, API estimate, fixed subscription fees and unknown states; editable budget/pricing/subscription forms. | Formatter/helper and earlier build evidence. User-wide currency selection, all budget metrics/scopes, persistence and real enforcement still need work/proof. No FX conversion is implemented. |
| Sounds | Original muted-by-default module, companion speaker toggle, companion-only cue routing, silent main avatars, cross-WebView preference event and subscribe-before-GET hydration guard. | Seven Canvas mounts/five audio fixtures passed in the implementer lane. Persisted/shared opt-in still lacks a non-toggle local gesture unlock path; the requested follow-up was interrupted. Event/GET race and full App cue routing need independent proof. |
| Accessibility / lifecycle | Focus-visible styles, inert hidden content, tab keyboard behavior, dialog focus/Escape/restore hook, runtime-menu keyboard handling, late-listener cleanup and saved-selection hydration fixes. Actual App lifecycle fixtures were added. | Mounted fixtures are not native screen-reader/keyboard/focus proof. Final integrated execution, listener/sound races and file/session-switch cases remain open. |

The UI is substantially implemented and locally runnable at a verified earlier checkpoint, but **UI acceptance is unfinished**. The latest source was interrupted mid-pass. Computer Use/browser/native interaction was intentionally deferred and was not resumed.

## Test and build ledger

| Checkpoint | Result | Scope |
| --- | --- | --- |
| Last settled independent frontend | **55 tests / 12 files**, typecheck and production build passed; Vite 6.4.3, 1601 modules, JS 379.56 kB / CSS 45.27 kB. | Predates the final paused UI changes. Do not apply it to the entire stopped tree. |
| Character/audio focused pass | **12 tests / 2 files**, implementer-reported: seven mounted Canvas tests, five mocked audio-module tests. | Real component lifecycle/draw-boundary tests; no native pixels or audible playback. |
| Interim integrated desktop pass | **69 tests and typecheck**, implementer-reported. | Before final audio/tray/file fixes and added actual-App fixtures. Not the final independent build. |
| Actual-App lifecycle fixtures | Six fixture cases present/reviewed: StrictMode late listener, stored selection, deadline/unpin, stale App callback, audio owner/modes and silent main Settings. | Do not claim a final independent pass; follow-up hydration/local-gesture/file races were interrupted. |
| Native file inspection | **4/4 independently passed** under `target/qa-file-inspection`. | Canonical metadata/content unchanged, Unicode/spaces, missing/directory and real Windows exclusive-share failure. Not provider file ingestion or full UI drop. |
| Sidecar staging | **3/3 independently passed**. | Custom target/destination, debug/release hashes and missing-hook failure before partial copy; inert fixtures. |
| Updated native library | `cargo check -p bloblex-desktop --lib` under `target/qa-desktop-ui` passed per desktop agent after fixes. | Compilation of latest tray/monitor/close changes; no native interaction proof. |
| Supported launch | `npm run desktop:dev` built/launched app plus one private daemon; independent OS parent/listener/hash evidence. | Isolated smoke database/dev identifier; actual React/provider interaction not established by the process check. |
| Forced live rebuild | Independent package clean and daemon/hook rebuild completed in 32.05s while private daemon stayed live; new target/private-stage hashes matched. | Verified the Windows compiler-output lock repair for one instance; no concurrent-start stress/full shutdown acceptance. |
| Older backend checkpoint | 26 reported independent tests passed; opt-in live-smoke body skipped by default. Actual basic Codex text turn succeeded once. | Later financial work and full provider tool/approval/cancel/resume/WSL paths remain outside that result. |

The Windows launch repair uses isolated Cargo targets, Cargo-metadata staging, free Vite port selection, a separate dev identifier, per-run daemon copies and serialized startup. Before the stop, the dev watcher naturally rebuilt/relaunched app `1348` and private child `34380`; the user then explicitly requested stopping all tasks and they were stopped. Old PIDs are historical, never identifiers to terminate blindly. The smoke database is `target/desktop-dev/isolated-smoke.sqlite`; the normal user database was not replaced/deleted. See [windows-development.md](windows-development.md).

## Other work already present

The folder contains the Rust workspace, daemon, SQLite storage/replay/recovery, ACP/OpenCode/Codex/Claude adapters, discovery and profile scaffolding, usage/pricing/subscription/valuation/budget helpers, WSL inventory/path helpers, bounded Claude hook helper, sidecar/installer scripts, icons/notices and UI. Presence is not full product acceptance.

The [implementation checklist](implementation-status.md) retains **all 17 work packages, phase gates and full v1 requirements**, including adapter contracts/live flows, atomic snapshot/event ordering, settings/profile consumers, budget reservations/reconciliation, hook installation/restore, usable WSL distro, owned process-tree recovery, installers/signing/updater/clean VM. Claude live testing hit provider quota; OpenCode's earlier live assertion needs stronger independent proof. WSL only exposed Docker's internal distro. Distribution resources and trusted signing are not configured. No push, PR, signed release or clean-install acceptance exists.

## Remaining UI checklist — recorded only, not scheduled

- [ ] Settle and independently run the stopped frontend/actual-App fixtures; build/typecheck the exact resulting tree.
- [ ] Complete persisted sound opt-in's first-local-gesture unlock, hydration-event ordering and stale/remount cue prevention.
- [ ] Verify no-session file controls, stale inspection cancellation, session/provider switching and draft preservation; enable a real main-composer local-reference flow.
- [ ] Complete usable startup/default project/default model/appearance/currency/global-policy controls and their actual consumers; preserve honest unavailable states until implemented.
- [ ] Independently verify tray/pause/settings/native close/monitor behavior and failures.
- [ ] Perform the deferred native comparison: shell corners/transparency/morph/drag/DPI, full welcome choreography and states, real file drop, approvals, shared selection, keyboard/focus/tray/lifecycle.
- [ ] Complete the broader plan after UI work when explicitly authorized to resume; none of its requirements were removed by this pause.

## Documents to keep together

- [SESSION_HANDOFF.md](../SESSION_HANDOFF.md): chronology, source/evidence limits, environment and resume context.
- [implementation-status.md](implementation-status.md): full plan checklist and remaining work.
- [qa-ui-execution.md](qa-ui-execution.md): independent QA matrix and exact earlier results.
- [qa-ui-fidelity.md](qa-ui-fidelity.md), [companion-motion.md](companion-motion.md): requested fidelity and borrowed-code/motion mapping.
- [magpie-assessment.md](magpie-assessment.md): research-only proposed integration and its gates.
- [ui-reference-images.md](ui-reference-images.md): eight preserved/hash-verified user screenshots, including the rejected pill and launch error.
- [qa-report.md](qa-report.md), [qa-findings.md](qa-findings.md), [qa-acceptance.md](qa-acceptance.md), [v1-coverage.md](v1-coverage.md): broader historical evidence/open acceptance.
- [ipc-contract.md](ipc-contract.md), [PRODUCT.md](../PRODUCT.md), [DESIGN.md](../DESIGN.md), [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

Do not resume from an old “in progress” sentence in those historical logs. This explicit stopped checkpoint takes precedence until the user asks to continue.
