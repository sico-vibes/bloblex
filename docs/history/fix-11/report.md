# FIX11 report: Bitbots installed identity (installer, executables, data directory)

> **What this is:** Report on FIX11: the installed Bitbots identity (installer, executables and data directory).
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026 by the OpenCode implementer lane for the Director.
Spec: `docs/history/fix-11/identity-spec.md`. No `git commit` was run; the diff is left in
the worktree.

## 1. What changed

| Item | Before | After |
|---|---|---|
| Bundle identifier (`apps/desktop/src-tauri/tauri.conf.json`) | `com.bloblex.desktop` | `com.bitbots.desktop` |
| Dev identifier (`scripts/dev-windows.ps1`) | `com.bloblex.desktop.dev` | `com.bitbots.desktop.dev` |
| Main executable | cargo package name (`bloblex-desktop.exe`) | `Bitbots.exe` via `"mainBinaryName": "Bitbots"` |
| Daemon sidecar | `bloblexd` | `bitbotsd` (`[[bin]]` in `crates/bloblex-daemon/Cargo.toml`, `externalBin`, scripts, `package.json`, `.gitignore`) |
| Hook sidecar | `bloblex-hook` | `bitbots-hook` (`tools/bloblex-hook/Cargo.toml` `[[bin]]`, `externalBin`, scripts, `.gitignore`) |
| Installer file | `Bloblex_<v>_x64-setup.exe` | `Bitbots_<v>_x64-setup.exe` (follows `productName`; sample URLs in `scripts/make-update-manifest.test.mjs` and the checklist template text updated) |
| Shortcut / uninstall / install dir | follow `productName` | read "Bitbots" (verified against the generated template, section 4) |
| Private temp folder | `%LOCALAPPDATA%\Bloblex\private-tmp` | `%LOCALAPPDATA%\Bitbots\private-tmp` (`crates/bloblex-adapter-claude/src/lib.rs`) |
| Shared data dir (daemon DB, private tmp) | `%LOCALAPPDATA%\Bloblex` | `%LOCALAPPDATA%\Bitbots` (`crates/bloblex-daemon/src/main.rs`), migrated |
| Speech-model ASCII fallback | `%ProgramData%\Bloblex\speech-models` | `%ProgramData%\Bitbots\speech-models` (`apps/desktop/src-tauri/src/speech.rs`) |

Files touched: `tauri.conf.json`, `.gitignore`, `package.json`, both bundling
scripts, `scripts/stage-daemon.mjs` (+ its test), `scripts/make-update-manifest.test.mjs`,
the three `scripts/live-checks/*.mjs` helpers and their README, `README.md`,
`docs/guides/windows-development.md`, `docs/ipc-contract.md`, `docs/operations/release-checklist.md`;
Rust: `apps/desktop/src-tauri/src/lib.rs`, `speech.rs`, new `migrate.rs`, new
`installer-hooks.nsh`; `crates/bloblex-daemon` (`Cargo.toml`, `main.rs`,
`mcp_bridge.rs`, `team.rs`, `tests/daemon_smoke.rs`); `crates/bloblex-adapter-claude/src/lib.rs`.

### Kept on purpose (as the spec requires)

- Crate and package names `bloblex-*` (including the `tools/bloblex-hook` directory
  and the `-p bloblex-hook` package argument) and npm names (`bloblex`,
  `@bloblex/desktop`).
- The `bloblexd.ready` protocol message type (the daemon bootstrap line is
  unchanged; `docs/ipc-contract.md` still shows it).
- JSON-RPC method names, setting keys, `BLOBLEX_*` environment variables,
  `bloblex.*` localStorage keys, `bloblex-*` Tauri event names.
- The GitHub repository slug `sico-vibes/bloblex` (release script default, updater
  endpoints, doc URLs).
- Icon file names (`assets/icon/bloblex.ico`, `bloblex-master.png`) — not part of
  this spec.

No `BITBOTS_*` variable was introduced: nothing needed one, and the spec says to
accept `BITBOTS_*` only where trivial. `BLOBLEX_DB_PATH`, `BLOBLEX_PRIVATE_TMP`,
`BLOBLEXD_EXE`, `BLOBLEX_STAGE_DESTINATION` etc. are unchanged.

### Files where no change was needed

`scripts/release-windows.ps1` and `scripts/make-update-manifest.mjs` never
hardcode the installer name: the release script globs `<bundle>\*-setup.exe` and
keeps the file whose name carries the release version, and the manifest script
builds the asset URL from the installer name it is given. Only the test fixtures
in `scripts/make-update-manifest.test.mjs` contained the old sample name; they now
use `Bitbots_...`.

## 2. Data migration (the important part)

New module `apps/desktop/src-tauri/src/migrate.rs`, pure functions over paths so
it is unit-testable with temp dirs. `crate::run()` calls
`migrate::migrate_before_start()` as its first statement, before
`tauri::Builder::default()` builds and before the WebView2 profile is created
under the new identifier.

Two directories are migrated by the same algorithm:

1. the Tauri `app_local_data_dir`: `%LOCALAPPDATA%\com.bloblex.desktop` →
   `%LOCALAPPDATA%\com.bitbots.desktop` (dev: `...\.dev`), chosen with
   `tauri::is_dev()`; and
2. the shared directory `%LOCALAPPDATA%\Bloblex` → `%LOCALAPPDATA%\Bitbots`
   (rule 8).

Behaviour (spec rules 1–7):

- `NotNeeded` when the legacy directory is absent, or when the target already
  holds a database file or a `migrated-from-bloblex.json` marker (idempotent).
- `Moved` when the target is absent: `fs::rename` (atomic on one volume), with a
  retry for up to ~5 s.
- `Copied { skipped }` when the rename cannot run: a recursive copy that skips
  files it cannot open and files that already exist in the target. The legacy
  directory is **never** deleted in that path.
- On success a `migrated-from-bloblex.json` marker is written into the target:
  `{ "from", "at" (RFC 3339), "method": "rename"|"copy", "skipped": [paths] }`.
- No file contents are read, parsed or logged — only paths and counts.
- `Failed(String)` logs one line (`eprintln!`) and the app still starts with a
  fresh profile; `migrate_before_start` never panics.

### Deviation from rule 3, and why (read this)

The spec says: "If `target` exists but is only an empty/fresh shell (no database,
no `migrated-from-bloblex.json`): remove the shell, then rename." That is applied
to the **identifier profile** only. It is **not** applied to the shared directory.

Reason: the per-user NSIS install directory is `$LOCALAPPDATA\${productName}`, so
`%LOCALAPPDATA%\Bitbots` is both the new install directory and the daemon's data
directory. The installer runs before the first launch, so the target already
exists and holds `Bitbots.exe`, `bitbotsd.exe`, `bitbots-hook.exe` and
`uninstall.exe`. It has no `.db` yet, so a literal rule 3 would delete the just
installed, currently running application and then move the legacy folder in its
place — and, if the delete failed on the locked executable, the app would start
with an empty database. To protect the install and the database, the shared
directory is **merged file by file and nothing is overwritten**: the database,
`private-tmp` and the legacy speech-model fallback are carried in, while the new
`uninstall.exe` (and any other existing file) is left untouched. This is recorded
in the marker as `method: "copy"` with the skipped paths. The spec's own premise
that the database lives under `app_local_data_dir` does not match the code (see
"Discrepancy" below), so this is where the safety matters.

Two related notes:

- The old app's install directory was `%LOCALAPPDATA%\Bloblex`; the daemon wrote
  `bloblex.db` and `private-tmp` into that same folder. The NSIS uninstaller
  removes only the known executables and then `RMDir "$INSTDIR"`, which fails on a
  non-empty folder, so the database survives the uninstall.
- A rename in the shared directory is only used when `%LOCALAPPDATA%\Bitbots`
  does not exist yet (e.g. a portable/dev launch that beats the installer).

### Discrepancy found in the spec

The spec states "everything lives under `%LOCALAPPDATA%\com.bloblex.desktop`
(Tauri `app_local_data_dir`, which also holds the WebView2 profile, the SQLite
database and downloaded speech models)". The database is **not** there. The
desktop shell spawns the daemon with no database override, and
`crates/bloblex-daemon/src/main.rs` defaults to
`%LOCALAPPDATA%\Bloblex\bloblex.db`. The migration therefore handles both
directories; the daemon default directory was changed to `%LOCALAPPDATA%\Bitbots`
(keeping the file name `bloblex.db` so the migrated data is found).

### Autostart (rule 9)

`migrate_before_start` also calls a Windows-only `migrate_autostart`. The old app
wrote `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Bloblex` while "Start
with Windows" was on, so its presence is treated as "the setting was enabled":
the stale value is deleted and, unless a `Bitbots` value already exists, a new
`Bitbots` value is written pointing at the current executable. No registry crate
is added — it shells out to `reg.exe` with a hidden window. It is best-effort;
failure logs one line and never aborts startup. When both values are absent,
nothing happens.

### Tests (temp dirs, `cargo test -p bloblex-desktop migrate::`)

`moves_everything_when_the_target_is_absent`,
`records_the_legacy_path_and_method_in_the_marker`,
`does_nothing_without_a_legacy_directory`,
`replaces_an_empty_shell_in_the_identifier_profile`,
`merges_into_an_existing_target_without_overwriting`,
`keeps_a_target_that_already_holds_a_database`, `a_second_call_is_a_no_op`, and
(on Windows) `copy_fallback_skips_a_locked_file_and_keeps_the_legacy_folder`
(a held handle with `share_mode(0)` blocks the rename and the read; the file is
reported in `skipped` and the legacy folder is kept). All 8 pass.

## 3. Installer behaviour

- **Pre-install hook.** `bundle.windows.nsis.installerHooks` now points at
  `apps/desktop/src-tauri/installer-hooks.nsh`. Its `NSIS_HOOK_PREINSTALL` macro
  (which the generated template inserts inside `Section Install`, before copying
  files) reads `HKCU\...\Uninstall\Bloblex`; when an `UninstallString` is present
  it stops `Bloblex.exe`, `bloblexd.exe` and `bloblex-hook.exe` with
  `taskkill`, then runs the old uninstaller silently (`/S`). Every step is
  best-effort: exit codes are consumed and never abort the install, and output is
  printed to the install log with `DetailPrint`. It is skipped while the
  installer is updating Bitbots in place (`$UpdateMode = 1`). A silent uninstall
  never ticks "Delete app data", so the WebView2 profile and the database are
  preserved for the migration.
- **Generated NSIS template.** `tauri-bundler` is not present in the local cargo
  registry (the `@tauri-apps/cli` 2.12.1 is a prebuilt npm binary), so the
  template was read from the matching tag:
  `crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi` at
  `tauri-cli-v2.12.1`. From it, with `productName = "Bitbots"` and
  `identifier = "com.bitbots.desktop"`:
  - `UNINSTKEY = Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}`
    → `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Bitbots`
    (`SetContext` = HKCU for `installMode: currentUser`).
  - Install directory (`currentUser`) = `$LOCALAPPDATA\${PRODUCTNAME}` →
    `%LOCALAPPDATA%\Bitbots`.
  - `MANUPRODUCTKEY = Software\${MANUFACTURER}\${PRODUCTNAME}`; `MANUFACTURER`
    defaults (no `bundle.publisher`) to the second identifier segment →
    `HKCU\Software\bitbots\Bitbots`.
  - Start-menu/desktop shortcuts are `${PRODUCTNAME}.lnk` → `Bitbots.lnk`.
  - The uninstaller's optional "delete app data" removes
    `$LOCALAPPDATA\${BUNDLEID}` → `%LOCALAPPDATA%\com.bitbots.desktop`, and it
    removes the autostart value `${PRODUCTNAME}` → `Bitbots`.
  - The packaged executable name is `MAINBINARYNAME` → `Bitbots`.

### What a human must check after a real build

The installer and the migration **cannot be exercised in this environment** — no
NSIS build or install was run, and running the real app would touch the owner's
live data, which this lane must not do. After a build, check:

1. The installer is `Bitbots_<version>_x64-setup.exe` and installs `Bitbots.exe`,
   `bitbotsd.exe` and `bitbots-hook.exe` into `%LOCALAPPDATA%\Bitbots`.
2. The start-menu/desktop shortcut and the Add/Remove-Programs entry read
   "Bitbots"; the uninstall key is `HKCU\...\Uninstall\Bitbots` and no
   `...\Uninstall\Bloblex` remains.
3. On a machine with the old Bloblex install: the pre-install hook stops
   `Bloblex.exe`/`bloblexd.exe`, the old uninstaller runs silently, its
   `%LOCALAPPDATA%\Bloblex` folder (with `bloblex.db`) is left behind, and the new
   install is unaffected.
4. First Bitbots launch moves `%LOCALAPPDATA%\com.bloblex.desktop` →
   `com.bitbots.desktop` and merges `%LOCALAPPDATA%\Bloblex` →
   `%LOCALAPPDATA%\Bitbots` (marker present, `bloblex.db` in place, conversations
   and settings intact, downloaded speech models found).
5. The HKCU `Run` value is renamed from `Bloblex` to `Bitbots` when autostart was
   on.
6. A genuine inspect of the generated `installer.nsi` inside the bundle confirms
   the install dir, shortcuts and uninstall key above.

## 4. Gates

All run from the worktree root; no `git commit`.

| Gate | Result |
|---|---|
| `cargo test --workspace --exclude bloblex-desktop` | pass (exit 0) |
| `cargo test -p bloblex-desktop` (migration tests) | pass — 42 tests, including the 8 migration tests |
| `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings` | pass (exit 0) |
| `npm run typecheck` | pass (exit 0) |
| `npm run test` | pass — 89 files, 565 tests |

Extra checks: `cargo clippy -p bloblex-desktop --all-targets -- -D warnings`
reports only pre-existing findings (`updates.rs`, `speech.rs`, `power.rs`,
`lib.rs`); there are none in `migrate.rs`. `npm run build` succeeds. The two Node
script suites I touched pass: `node --test scripts/stage-daemon.test.mjs
scripts/make-update-manifest.test.mjs` (11 tests). Staging worked end to end:
`node scripts/stage-daemon.mjs` produced `bitbotsd-x86_64-pc-windows-msvc.exe`
and `bitbots-hook-x86_64-pc-windows-msvc.exe`.

Note: the desktop crate only builds after the sidecars are staged
(`apps/desktop/src-tauri/binaries/`) and the frontend `dist/` exists; the spec's
"otherwise run the module's tests by path" fallback was not needed.
