# Bloblex session handoff

Current as of 2 October 2026. The plan is [docs/E2E_PLAN_V2.md](docs/E2E_PLAN_V2.md). Phase status and evidence commits are in the table at the top of that file and in [docs/implementation-status.md](docs/implementation-status.md).

Acceptance of the current tree is unit tests and fake-process adapter tests. There is no live-provider session check and no native window pass of this tree. Phase 7 is the remaining native and release work.

## What exists

Bloblex is a Windows desktop app: a React/Tauri shell (`apps/desktop`) and a separate daemon (`bloblexd`) that owns sessions, permissions, budgets, and usage. The shell and the companion read the daemon's normalized state. Provider CLIs (Claude Code, Codex, OpenCode) keep their own login.

On main, through the commits listed in the plan status table:

- Phases 1, 1.5, 2a, and 3: logo/icons, the capability record, persisted blobs, and the roster editor.
- Phase 4: per-blob project and session tree.
- Phase 2b: execution options, snapshots, model catalogs, and the Claude, OpenCode, and Codex adapters (fake-process tests).
- Phase 5: `usage.analytics` and the analytics view (cost, tokens, run time, runs, errors).
- Phase 6: settings modal for General, Agents, Runtimes, and Permissions, including ask / auto / bypass approval modes.
- Companion island, chat-style main window, and character canvas are in the desktop app.

An isolated-database native smoke of the Phase 3 tree is recorded in [docs/NATIVE_SMOKE_RESULTS.md](docs/NATIVE_SMOKE_RESULTS.md) (`5138c8e`, revision `e770db8`). It does not cover Phases 4, 2b, 5, or 6.

## Lanes

The Director (orchestrating Claude session) reviews diffs and commits. Implementers do not commit.

| Lane | Role |
| --- | --- |
| `impl` | Codex, production code including Rust |
| `impl-b` | Cursor Grok, bake-off lane; this handoff's desktop contract work is TypeScript, CSS, and docs only |
| `qa` | OpenCode, reports to the Director |

Do not edit the user's hooks or settings. Desktop Cursor runs go through `scripts/run-cursor-delegate.ps1`.

## Build and test

From the repository root, with this worktree's own `node_modules` (`npm ci` here; do not link another checkout's modules):

```powershell
npm run typecheck
npm test
npm run build
```

Those three commands run the desktop workspace. They are the desktop gate: typecheck, Vitest, and the production bundle. They do not start the app, the daemon, or Tauri.

Backend tests, when a lane is allowed to run them, use a fresh database path and a private Cargo target. Never point a test or a dev run at `%LOCALAPPDATA%\Bloblex`.

Native development, only when a person is ready to launch the app, is `npm run desktop:dev` with an explicit isolated `BLOBLEX_DB_PATH`. See [docs/windows-development.md](docs/windows-development.md). Do not start it as part of a contract or docs pass.

## What needs the user's native testing (Phase 7)

- Companion transparency, free drag (including the face and the name), monitor clamping, DPI, and resize timing.
- Real file drop, approvals in both windows, tray Pause all, keyboard focus, and reduced motion.
- Quit and process-tree cleanup.
- Installer, signing, updater, and a clean-machine install.

The Phase 3 smoke recorded defects N1–N4 (face drag, expand clamp, companion totals labeled as daemon-wide, backup sidecar files). Later commits touch drag and clamp in source. Those fixes have not been re-checked in a native window.

## Known gaps

- No live Claude, Codex, or OpenCode session has been accepted against the current tree.
- The daemon does not persist or emit a `context` failure class. The UI will label that class "Context full" if it appears on an analytics error or a turn. See the implementer report for the Rust lines.
- Session turn JSON does not include `failureClass`, so the chat card cannot show it until the daemon adds the field.
- Settings Usage and Billing, language, and theme stay deferred.
- WSL, signing, and the updater are not done.
