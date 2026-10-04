# Bloblex session handoff

Current as of 4 October 2026. The plan is [docs/E2E_PLAN_V2.md](docs/E2E_PLAN_V2.md). Phase status, later work and evidence commits are in [docs/implementation-status.md](docs/implementation-status.md).

Acceptance of the current tree is unit, mounted and fake-process tests. There is no live-provider session check and no native window pass of this tree. Public beta releases exist (latest published: `v0.1.0-beta.3`); work merged after it is not released yet.

## What exists

Bloblex is a Windows desktop app: a React/Tauri shell (`apps/desktop`) and a separate daemon (`bloblexd`) that owns sessions, permissions, budgets, and usage. The shell and the companion read the daemon's normalized state. Provider CLIs (Claude Code, Codex, OpenCode) keep their own login.

On main:

- Plan phases 1–6 and 2b: logo, capability record, persisted blobs and the editor, the project/session tree, execution options and adapters, usage analytics, settings with ask / auto / bypass approval modes.
- Auto-update from GitHub releases (stable and beta channels, signed NSIS updates) and the release script; see [docs/UPDATER.md](docs/UPDATER.md) and [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).
- The interface redesign: chat-style main window, one-page blob editor, custom dropdowns, blob moods that settle over time, favourites and pinned conversations/projects, companion launch with the full welcome.
- Conversation management: unread markers, Windows notifications, rename/archive/delete (migration 6), grouped tool activity, Start with Windows.
- Honest model lists: catalog source and update time, suggestions vs validated lists, display names, default marker and family groups.
- Settings > Usage & limits (token/turn/minute budgets, price overrides, subscription fees), Markdown export of a conversation, export/import of a blob setup.
- Batch B: Ctrl+K quick switcher, composer model and thinking switch, safe Markdown, unified diff view and approval shortcuts. The companion uses the same approval card.
- Batch B1: one shared Codex app-server or OpenCode ACP process per runtime key, per-session queues that coalesce streaming deltas only, idle shutdown, crash restart and resume, and bounded per-session cancel. Claude Code remains one process per session.
- Batch C: first-run setup on an empty install, companion start position and Ctrl+Alt+B hotkey, system/dark/light themes and text size, and reorderable favourites and pins. A contrast test checks the light theme against AA.

## Lanes

The Director (orchestrating Claude session) reviews diffs, runs the gates and commits. Implementers do not commit.

| Lane | Role |
| --- | --- |
| `impl` | Codex, production code including Rust |
| `impl-b` | Cursor Grok, used as the independent read-only reviewer of each branch |
| `qa` | OpenCode, research and QA; reports to the Director |

The implementer sandbox cannot spawn esbuild, so the Director runs Vitest and the Vite build. Cursor runs go through `scripts/run-cursor-delegate.ps1`; in read-only mode Cursor has no shell, so give it the diff as a file. Do not edit the user's hooks or settings.

## Build and test

From the repository root, with this checkout's own `node_modules` (`npm ci`; never link another checkout's modules):

```powershell
npm run typecheck
npm test
npm run build
cargo test --workspace
cargo check -p bloblex-desktop --lib
```

The Director's gate output is outside OneDrive at `C:\dev\bloblex-target` (`CARGO_TARGET_DIR`). Review lanes must also use a short `CARGO_TARGET_DIR`; long paths break the Windows linker. `cargo check -p bloblex-desktop` needs the gitignored sidecar binaries in `apps/desktop/src-tauri/binaries` (copy them into a new worktree). Before committing, run the naming check: no third-party product names anywhere in the repo.

Native development, only when a person is ready to launch the app, is `npm run desktop:dev` with an explicit isolated `BLOBLEX_DB_PATH`. See [docs/windows-development.md](docs/windows-development.md). Never point a test or a dev run at `%LOCALAPPDATA%\Bloblex`.

Releases: [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md). The update signing key lives outside the repo and must never be committed.

## What needs the user's native testing (Phase 7)

- Companion transparency, free drag, monitor clamping, DPI, resize timing, and the launch welcome.
- Real file drop, approvals in both windows, tray Pause all, keyboard focus, and reduced motion.
- Notifications, Start with Windows, and the export/import file dialogs.
- Quit and process-tree cleanup; a clean-machine install; code signing.

## Known gaps

- No live Claude, Codex, or OpenCode session has been accepted against the current tree.
- Codex blob instructions stay thread-level: the installed app-server schema has no per-turn context field.
- Cost budgets are not offered: turn admission cannot estimate cost yet. Existing cost policies are listed with a note.
- The daemon does not emit a `context` failure class; session turn JSON omits `failureClass`.
- WSL.
- Tracked `apps/desktop/tsconfig.tsbuildinfo` is rewritten by `tsc -b`; restore it before committing if it changes.
