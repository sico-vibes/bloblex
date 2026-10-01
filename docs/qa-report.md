# Bloblex independent QA report

Status: implementation in progress; acceptance is not yet established.

This report preserves historical checkpoints, including failed commands and earlier UI drafts. For the current independent 32-test UI/build checkpoint use [qa-ui-execution.md](qa-ui-execution.md); for the complete remaining checklist use [implementation-status.md](implementation-status.md). A subsequent desktop inert accessibility attribute was implementer-checked but is outside that independent result. Root now performs documentation/orchestration only; the third Luna QA lane owns independent retesting and routes corrections to implementers.

Latest user steering: both Luna agents are now focused on UI behavior and polish before further backend work. Seven supplied screenshots reject the pill-shaped shell, mouths and stripped Coucou behavior. The next checkpoint must use source-informed rounded corners, the separate launch-wave choreography, home/chat views and real file-drop preparation. `qa-ui-fidelity.md` records the criteria. The backend's latest metric-budget and valuation changes compile in an isolated target but have not had an independent test rerun.

User steering: Computer Use was stopped with Escape and is deferred until final verification. The first companion draft is rejected for insufficient Coucou fidelity. The desktop implementer is revising it against actual source, not treating the initial capsule preview as acceptance.

Date: 1 October 2026. Workspace: `C:\Users\jbmst\OneDrive\Documents\ChatGPT\Bloblex`.

## Verified baseline

- The starting repository contained only the supplied plan and concept image.
- `node --version`, `npm --version`, `cargo --version`, and `rustc --version` succeeded: Node 25.8.0, npm 11.11.0, Cargo/Rust 1.94.0.
- Visual Studio's `vswhere` reports a C++ toolchain in Visual Studio 2022 Community. Windows registry reports WebView2 154.0.4258.48.
- Native version probes succeeded: Claude Code 2.1.286, Codex CLI 0.159.3, OpenCode 1.18.34.
- Provider-owned status commands report Codex logged in through ChatGPT and Claude logged in through claude.ai. OpenCode reports three credential configurations. No credentials were extracted or copied. The basic live Codex conversation is independently verified below; the other provider paths are tracked separately.
- `wsl.exe --list --quiet` returns `docker-desktop`. Ordinary WSL development runtime testing remains unverified.

## Review findings sent to implementers

- Budget admission needs period boundaries, atomic admission across all applicable policies, reconciliation, and a genuinely concurrent reservation test.
- Daemon snapshots need persisted transcript, activity, permissions, usage, and budgets under a consistent sequence boundary.
- Frontend session updates must preserve existing content, handle delta semantics correctly, reject duplicate sequences, and resolve permissions independently of optional session IDs.
- Blob rendering must avoid duplicate animation loops, pause hidden/invisible canvases, lower idle frequency, and honor reduced motion.
- Main and companion must synchronize the relevant session instead of independently selecting a default.

These are findings on early drafts. They are not final failures or claims that the finished implementation contains them.

## QA tooling

The in-app browser bootstrap failed with `privileged native pipe bridge is not available; browser-client is not trusted`. Windows Computer Use initialized successfully and returned current local windows. Native UI verification will use the built app; browser preview is not evidence of native integration.

## Independent checks so far

- `npm test`: passed, five reducer tests. These cover frontend state handling, not native/provider behavior.
- After the Coucou source revision, independent `npm test` passed 13 tests across reducer, companion FSM, spring and character helpers. This verifies the covered motion/state logic; final native appearance and input behavior are deferred.
- Latest independent frontend rerun passed 15 tests, including revised message-contract and replay reconciliation fixtures. The app was rebuilt with current production assets and launched for the user's inspection; process checks confirmed the native window and daemon. No Computer Use was performed on this revised build.
- `npm run build`: passed after the readability and normal-currency input changes. Latest output is a production Vite bundle.
- Independent production build after the Coucou rewrite passed: Vite 6.4.3, 1587 modules, JavaScript 300.51 kB and CSS 30.31 kB. Source behavior mapping is in `companion-motion.md`. This build does not verify native hit testing, position persistence or visual fidelity.
- Isolated Edge/Playwright frontend preview loaded without page errors. Offline state is explicit and has no fabricated sessions. The companion preview is a rounded capsule. Native transparency, dragging, tray and placement remain unverified.
- Earlier backend runs exposed compilation errors, then an installed-provider smoke failure because OpenCode was missing from discovery. The runtime implementer reports a discovery fix; independent repeat is pending. No full backend pass is claimed.
- Subsequent independent `cargo test --workspace --exclude bloblex-desktop` passed on the 1 October checkpoint: 26 reported tests, including installed CLI discovery. The daemon live smoke returns immediately unless opted in, and some adapter tests have insufficient assertions; this result confirms compilation and the covered unit paths, not provider/IPC acceptance.
- Generated installed Codex 0.159.3 app-server schemas with its own `generate-json-schema` command under `docs/qa-schema/` for protocol review.
- Native Tauri binary built and launched. Windows Computer Use observed the main window and companion, actual daemon connection, and a real Codex app-server session. A harmless text-only prompt returned exactly `BLOBLEX_QA_OK`; the native turn reached Completed. This establishes the basic Codex conversation path only.
- Closing the main window hid it while `bloblex-desktop` and `bloblexd` remained alive and the companion stayed visible.
- Dragging the capsule background moved it and persisted physical coordinates. The grip's child hit targets did not move it on the first attempt. Source corrections are pending native re-verification.
- Native companion has an opaque outer rectangle. It also showed Claude for a Codex turn while correctly following completion state; incomplete creation-event metadata is under correction. These companion gates remain open.

An independent PowerShell daemon/RPC runner was rejected by execution policy before launch. That result is a tooling restriction, not an application failure. The same checks are being requested as fixed Cargo integration tests.

## Pending evidence

First independent backend run: `cargo test --workspace --exclude bloblex-desktop` failed during compilation with Rust E0597 in the Claude adapter's cancellation method. The runtime implementer received the exact diagnostic. No backend test pass is claimed from this run; a corrected build is required.

Native builds; daemon integration tests; live-provider sessions; permissions/cancel/resume; budget/usage integration; native companion/tray behavior; installer packaging; recovery and accessibility. Signing, clean Windows VM, alternate display scaling and multiple physical monitors need separate verification when those resources are available.

Acceptance gates and scenarios are defined in `qa-acceptance.md`.

## Current source review checkpoint

The desktop implementer has read Coucou commit `8e12bed56134d2ee7165e73f132646b143ce56e4` and added its four-state interaction model, spring primitives, gaze and poke reactions. This is not yet UI acceptance. Independent source review found clipped badge coordinates, third-poke squash timing, greeting interruption, reduced-motion settling, and an unchanged large status-toast layout. The badge and poke helper checks now pass, and state-driven compact/expanded capsule morphology is implemented. Native resize/morph synchronization, reduced-motion behavior, bottom-anchor recovery, and pinned approvals remain under review. Computer Use and browser interaction testing remain deferred until the implementation stage is complete.

The runtime implementer reports focused storage/daemon tests passing after correcting over-reservation. An opt-in Claude smoke reached the actual provider and received an account weekly-quota error; no repeated Claude retry is being used to bypass that limit. OpenCode-only live smoke accepted a session and prompt but timed out after 120 seconds without completion/error. The implementer reports cleanup left no owned daemon/OpenCode processes. This provider lifecycle gap is open. Agent-reported checks remain separate from independent checks.

Full budget metrics, persisted cost valuations, the Claude permission/hook bridge, lifecycle fixtures, packaging and recovery remain under review. Passing a focused unit suite does not close these acceptance gates.
