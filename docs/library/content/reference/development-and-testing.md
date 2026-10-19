# Development and testing

> **What this is:** how to build, run and check Bitbots on Windows, and the lane rules this repository uses.
> **Status:** current; from `README.md`, `docs/guides/windows-development.md` and the AGENTS.md amendments of 12–19 October 2026
> **Last updated:** 2026-10-19

## Purpose

This page is for someone changing the code, not for someone using the app. It covers the local development path, the browser preview, the test and type gates, the isolated database rule, worktrees and the short-path constraint.

## Requirements

- Windows with the MSVC C++ toolchain and WebView2.
- Rust and Cargo.
- Node and npm.
- At least one coding-agent CLI for a live turn; the unit tests and the preview do not need one.

Install dependencies in the checkout you are working in. Do not reuse another checkout's `node_modules`: the workspace links binaries and a stale link is hard to diagnose.

## Run the app

From the repository root:

```powershell
npm install
npm run desktop:dev
```

`desktop:dev` builds `bitbotsd.exe` and `bitbots-hook.exe`, stages them as Tauri's target-triple-suffixed sidecars, and starts the native app with Vite. It defaults to `target/desktop-dev` and honours an explicit `CARGO_TARGET_DIR`.

The launcher picks a free loopback port from 1420–1435 and passes it to Vite, Tauri and the development CSP. It uses the development identifier `com.bitbots.desktop.dev`, which separates development app data from the installed app. It does not isolate the daemon database by itself: startup supplies a fresh `BLOBLEX_DB_PATH`.

Never point development or tests at `%LOCALAPPDATA%\Bitbots`. That is the user's real store. A test that writes there is a bug.

## The browser preview

The preview runs the real React app with fixtures instead of the daemon:

```powershell
npx vite --config apps/desktop/vite.preview.config.ts apps/desktop --port 5190 --strictPort --host 127.0.0.1
```

Then open:

| URL | Surface |
| --- | --- |
| `http://127.0.0.1:5190/` | Main window. |
| `/?style=bitbots&theme=light` | A look and theme. |
| `/?preview-settings` | Settings sheet. |
| `/?companion&mode=home&view=chat` | Companion. |
| `/preview.html` | Art sheet, every art and mood. |
| `/launch-preview.html?fixture=onboarding-step-1` | Onboarding. |
| `/launch-preview.html?fixture=in-progress` | Launch screen. |
| `/dictation-preview.html` | Dictation island states. |

The preview replaces `../tauri`, `../desktopIntegrations` and the event/window APIs with fixture modules (`apps/desktop/vite.preview.config.ts`). The fixtures are visual data, not product data, and they never establish native behaviour, a provider turn or persistence.

Preview flags change state: `?style=`, `?theme=`, `?accent=`, `?wallpaper=`, `?glass=`, `?font=`, `?monoFont=`, `?density=`, `?seen-hints`, `?tour`, `?experiments`, `?remote=on|off|<state>`, `?devices=0|1|3`, `?activity`, `?usage-bar`, `?logos`. They are development-only.

## Gates

From the root:

```powershell
npm run typecheck
npm test
npm run build
```

Those do not launch the app or the daemon. The native build is separate:

```powershell
npm run desktop:bundle
```

It defaults to `target/desktop-release`, builds both release sidecars, stages them, and runs Tauri's NSIS build. A local unsigned installer is not a trusted signed release.

Backend tests need a private Cargo target and a fresh database:

```powershell
$env:CARGO_TARGET_DIR = 'target/qa-desktop'
cargo test --workspace --exclude bloblex-desktop
```

For a package-specific check:

```powershell
cargo check -p bloblex-desktop --lib
cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings
```

A default test pass does not mean a live provider path ran. A live smoke is opt-in and may consume provider quota; label its result as such.

## The documentation library

```powershell
node scripts/docs-library.mjs build
node scripts/docs-library.mjs check
node scripts/docs-library.mjs serve --port 5205
```

`build` writes `docs/DOCUMENTATION.html` and `docs/library/catalog.json`; `check` verifies hashes, the source inventory, links and self-containment; `serve` binds `127.0.0.1` only and serves the viewer at `/`. The HTML also opens directly from disk. See [the library README](../../README.md).

## Worktrees, lanes and the short path

This repository uses a lane workflow (AGENTS.md, 12–19 October 2026):

- The **Director** writes briefs, reviews every diff, checks screens, merges, runs the gates and commits.
- **Implementation lanes** work in their own git worktree, one Cargo target each, from a written brief. A lane never runs `git commit`.
- **Documentation** is written from the briefs, diffs and gate results; it is not invented alongside the code.
- Several lanes may run at once when their files are kept apart.

Two Windows constraints matter:

1. **Build the desktop crate from a short path without an apostrophe.** The resource compiler fails on the main checkout's path `D:\Basem's\...`; use a path such as `D:\fx50` or `C:\fx31`.
2. **Use a private Cargo target per lane.** A shared target serialises builds and can leave a running executable locked. Set `CARGO_TARGET_DIR` to a lane-specific folder.

A lane worktree gets its own `node_modules`. If you create a junction to the main checkout's modules, remove it as a link only — never recurse through it — and then remove the worktree with `git worktree remove --force`, delete the branch and run `git worktree prune`.

## What to test

The suite has three useful levels:

- **Pure unit tests** for classifiers, parsers, formatters and state machines. These are the strongest evidence: no DOM, no daemon, no provider.
- **Mounted tests** in a DOM for React behaviour: what renders, what a click calls, what a disabled control refuses. They do not prove native layout.
- **Rust tests** for storage, dispatch, adapters with a fake peer, retry, queue and Remote policy. A fake peer proves protocol shape, not provider behaviour.

A browser screenshot proves the React tree renders with fixtures. It does not prove the native window, the transparent companion, a real microphone, a real phone or a provider turn. Say which environment a result came from.

## Reading a failure

- **Typecheck:** start at the cited file and line; do not widen a type to silence it.
- **A unit test:** read the assertion name. A test that passes before and after a change is not a test of that change.
- **A mounted test:** check whether happy-dom can represent the behaviour at all. A layout assertion may need a real browser.
- **A Rust test:** the database is a scratch file. If it passed while pointing at the real store, the test is invalid.
- **The preview:** open the console. A fixture error often means a daemon method was called that the fixture bridge does not implement.

## Gotchas

- **Do not commit from a lane.** The Director commits after review and gates.
- **Do not reuse `node_modules` through a junction.** It breaks Vite's temp files and package resolution.
- **Do not let a test write the real database.** Set `BLOBLEX_DB_PATH`.
- **Do not treat a screenshot as acceptance.** Label it as a preview result.
- **A live provider check costs quota.** Ask before running one and record it separately.
- **The app may already be running.** Rebuilding does not update a running production process; a locked executable is the usual symptom.
