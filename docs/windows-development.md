# Windows desktop development

These commands are the local development path. Do not point them at a live inspection database. Earlier notes in this file about a running executable lock are historical; the launcher stages a private daemon copy. A full native pass of the current tree is still Phase 7.

## Run locally

From the repository root:

```powershell
npm install
npm run desktop:dev
```

The development script builds both `bloblexd.exe` and `bloblex-hook.exe`, stages them as Tauri's target-triple-suffixed sidecars, then starts the native app with Vite. It defaults to the isolated `target/desktop-dev` Cargo folder, honoring an explicitly supplied `CARGO_TARGET_DIR`. The renderer never connects directly to the daemon process; Tauri holds its short-lived IPC capability and forwards authenticated calls.

Current launcher source selects a free loopback development port from 1420–1435 and passes that same port to Vite, Tauri and the development CSP. It writes a generated configuration under the selected Cargo target and uses the development identifier `com.bloblex.desktop.dev` to separate development app/WebView data. This does not itself isolate the daemon database: startup verification explicitly supplies a fresh `BLOBLEX_DB_PATH`. The verified startup/rebuild result is recorded below.

## Build an unsigned local installer

```powershell
npm run desktop:bundle
```

The script defaults to `target/desktop-release` unless a Cargo target is explicitly supplied. It builds both release sidecars, stages their target-triple-suffixed external binaries, then invokes Tauri's configured build. NSIS and MSI are configured bundle targets; an actual installer build/install/uninstall pass remains open. No trusted signed release is established. It still needs an approved Windows signing certificate or Store submission, updater signing keys, and release hosting configured in CI. No signing identity or updater key is checked into this repository.

The updater remains disabled until a signing key and signed update endpoint are configured. Provider CLIs keep their own update channels.

## Current local surfaces

- Main window defaults to 1360×860 and remembers its size and position.
- Revised companion source is an always-on-top rounded rectangular floating bill, with 14px compact / 22px expanded corners. It defaults bottom-center, retains monitor-relative placement and clamps to available display bounds. Transparency, latest morph/drag and display-change behavior still need native acceptance.
- Closing the main window hides it to the tray. Quit sends `daemon.shutdown` and stops the child as a fallback.
- Provider data stays empty or unknown until the daemon returns it; there are no seeded conversations, login claims, or pricing values.

## While the inspection app is open

The earlier `target/debug/bloblex-desktop.exe` embeds older production assets. Rebuilding a Vite bundle does not update an already running production process. At the 18:59 checkpoint that desktop process was absent, but its earlier daemon processes were still running. Revalidate processes before acting; do not overwrite the user's live database as a side effect of a check.

Use a separate Rust target for compile/test work:

```powershell
$env:CARGO_TARGET_DIR = 'target/qa-desktop'
cargo check -p bloblex-desktop --lib
```

Backend tests use their own target and a fresh `BLOBLEX_DB_PATH`; the default database is `%LOCALAPPDATA%\Bloblex\bloblex.db`. Coordinate shared sidecar staging with the desktop lane. The revised `scripts/stage-daemon.mjs` resolves Cargo's actual target directory through `cargo metadata`, including `CARGO_TARGET_DIR`, and checks that both binaries exist before copying either. `BLOBLEX_STAGE_DESTINATION` allows staging regression tests into a private directory; a real Tauri build must point at the staged files it will bundle.

The 1 October checkpoint below (55 frontend tests, one isolated `desktop:dev` launch, and the rebuild-while-live hash check) is historical. Current phase status, test commands, and the still-open native pass are in [SESSION_HANDOFF.md](../SESSION_HANDOFF.md) and [implementation-status.md](implementation-status.md).

## Running-executable lock repair, 1 October

The user reported `failed to remove target\debug\bloblexd.exe: Access is denied (os error 5)` from `npm run desktop:dev`. Root read-only process checks confirmed two earlier daemons executing that exact compiler output. Windows keeps running executables locked; the build attempted to replace one.

The desktop lane changed development/release targets and native startup: the shell now copies the staged daemon to a unique app-local `runtime-processes` executable before launching it, and retains that exact path for owned cleanup. This separates future daemon runtime handles from Cargo and staging outputs. Existing old daemon processes were preserved.

Independent staging regressions passed 3/3; independent native file-inspection tests passed 4/4 on Windows. The supported `npm run desktop:dev` command then successfully built and launched the app with an explicit isolated database. Root and QA independently observed one private daemon child; QA verified its loopback listener and binary hash against the build/staged source. The concurrent-start guard and dead-child executable-copy cleanup are present.

QA also forced an isolated daemon rebuild while that child remained live: package-specific clean under `target/desktop-dev`, successful daemon/hook rebuild in 32.05s, then staging into `target/qa-rebuild-staged`. The new build/staged hashes matched, while the private running copy retained its old hash and continued listening. The two earlier daemons and old `target/debug` executable were untouched. This verifies the reported rebuild-lock repair for one observed app/daemon instance; full process-tree lifecycle, concurrent-start stress and GUI interaction acceptance remain open.

The subsequent exact-owner smoke-process stop command was rejected before execution as `blocked by policy`; no alternate mechanism was attempted. The smoke app/daemon were left running with `target/desktop-dev/isolated-smoke.sqlite`. Recheck the process state before later work and do not present controlled cleanup or graceful Quit as verified.
