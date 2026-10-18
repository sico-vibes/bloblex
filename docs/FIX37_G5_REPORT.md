# FIX37 G5 — automatic updates with a "Downloading" / "Restart to update" badge

Lane: OpenCode `deepseek-v4.1-flash` (high), worktree `C:\fx65` (branch `lane/fix37-g5`).
Written 18 October 2026. No `git commit` was run.

## What the app now does

- **Background check.** `updates::start_background_checker` first runs 30 s after start,
  then every 4 hours while the app is running, and only when `updates.autoCheck` is on
  (default on). The channel (`stable`/`beta`) is read from settings on every tick.
- **Background download.** When a newer version is found it is downloaded in the background
  and verified by the updater (minisign) signature, held in memory as staged bytes. It is
  **never installed** without the explicit command. Nothing is written to disk.
- **Phase feed.** Native pushes `updates-state` and the UI subscribes once. The badge and
  Settings › Updates both read it.
- **Badge.** `apps/desktop/src/ui/UpdateBadge.tsx`, mounted once in `App.tsx`'s main header
  row (inside `.header-actions`, before the existing header buttons). It shows
  "Downloading update · 42%" with a small progress ring (not clickable, tooltip with the
  version), an accent **"Restart to update"** button when ready, and a quiet
  **"Update failed"** button on error that retries. It renders nothing while idle/checking
  and nothing in the companion window.
- **Settings › Updates.** Keeps "Check now", mirrors the phase (downloading/ready/error),
  and the auto-check switch now reads **"Download updates automatically"**.
- **Release pipeline.** `createUpdaterArtifacts: true` is already set and
  `scripts/release-windows.ps1` already signs for the updater, writes `latest.json`, attaches
  it, and uploads it to `channel-beta --clobber`. A guard was added: the script now refuses
  (warns in `-DryRun`) if `bundle.createUpdaterArtifacts` is not `true`, so a release can no
  longer silently become a manual-only install.

## Files changed

- `apps/desktop/src-tauri/src/updates.rs` — phase state machine, `UpdateSource` trait,
  background cycle, staged install, scheduler, `updates_phase` command, tests.
- `apps/desktop/src-tauri/src/lib.rs` — register `updates::updates_phase` (one line).
- `apps/desktop/src/updatesContract.ts` — `UpdatePhase`, `UpdatePhaseState`,
  `parseUpdatePhaseState`, `knownUpdatePhase`, `describeUpdatePhase`, badge/label constants.
- `apps/desktop/src/tauri.ts` — `updatesPhase()`, `listenForUpdateState()`.
- `apps/desktop/src/remote/remoteTauri.ts` — the remote stand-ins (parity test requires them).
- `apps/desktop/src/ui/UpdateBadge.tsx` — new component.
- `apps/desktop/src/ui/App.tsx` — import + one mount line (`<UpdateBadge />`).
- `apps/desktop/src/ui/UpdatesPanel.tsx` — phase subscription, status mirror, new toggle label.
- `apps/desktop/src/ui/shell.css` — badge, ring and reduced-motion styles.
- `apps/desktop/src/ui/FIX37.updateBadge.mounted.test.tsx` — new mounted tests.
- `apps/desktop/src/updatesContract.test.ts` — phase parser/describer tests.
- `apps/desktop/src/ui/updates.mounted.test.tsx` — selector rename to the new toggle label.
- `scripts/release-windows.ps1` — `createUpdaterArtifacts` guard.
- `docs/FIX37_G5_REPORT.md` — this file.

## Contract, and one deliberate name change

Command `updates_phase` → `{ phase, version?, downloadedBytes?, totalBytes?, message? }`
and the phase event both use:

```
{ phase: "idle" | "checking" | "downloading" | "ready" | "installing" | "error",
  version?, downloadedBytes?, totalBytes?, message? }
```

**Deviation from the brief:** the event is named `updates-state`, not `updates.state`
(the brief's spelling). Tauri v2 rejects `.` in event names
(`tauri-2.12.1/src/event/event_name.rs`: "Event name must include only alphanumeric
characters, `-`, `/`, `:` and `_`"), so `updates.state` would panic at the first emit.
Everything else matches the brief. `message` is always one of the fixed sentences in
`install_message` — never raw error text.

The existing `bloblex-update-available` and `bloblex-update-progress` events are unchanged,
so the pre-existing "Update available / View / Later" banner and the Settings progress bar
keep working.

## Rust design (why it is testable)

- `UpdateSource` is a trait (`info` / `download` / `install`). Production wraps the plugin's
  `Update`; tests substitute a fake, so the whole cycle runs without a network.
- `run_background_cycle(check, sink, service)` publishes `checking` → `downloading` →
  `ready`/`error` and stages the bytes. It has no install path: installing only happens in
  `install_staged`, which the `updates_install` command (and only it) calls.
- `scheduler_tick(preferences, check)` runs the check only when preferences were read and
  `auto_check` is true.
- All UI text on failure goes through `install_message`, a fixed allow-list.

## Tests

Rust (`apps/desktop/src-tauri/src/updates.rs`):

- `a_newer_version_moves_checking_downloading_ready_without_installing`
- `installing_uses_the_staged_bytes_only_when_the_command_runs`
- `a_failed_download_reports_a_safe_error_and_stages_nothing`
- `the_scheduler_skips_checks_when_automatic_checks_are_off`
- `phase_events_serialise_with_camel_case_and_no_absent_fields`
- plus the existing channel/semver/error tests.

Frontend: `FIX37.updateBadge.mounted.test.tsx` (each phase's label, ring vs button,
"Restart to update" calls `updatesInstall`, error retries with `updatesCheck`, event
follow-through, nothing in the companion window) and the phase parser tests in
`updatesContract.test.ts`.

## Gates (run in this worktree)

```
cargo test -p bloblex-desktop --lib 2>&1 | grep "test result"
cargo clippy -p bloblex-desktop --all-targets -- -D warnings
cd apps/desktop && npx tsc -b && npx vitest run --maxWorkers=3
cd apps/desktop && npm run build
```

Results are recorded below.

### Results

- `cargo test -p bloblex-desktop --lib` → **test result: ok. 64 passed; 0 failed** (includes the
  5 new `updates::tests`).
- `cargo clippy -p bloblex-desktop -- -D warnings` (and `--all-targets`) → **no lint in the
  files this lane changed**. Eight lints remain, all pre-existing and outside this lane's work:
  - `clippy::too_many_arguments` (8/7) — `lib.rs:1377`; (10/7) — `lib.rs:1878`; (8/7) — `lib.rs:1895`.
  - `clippy::let_unit_value` — `lib.rs:2338`.
  - `clippy::too_many_arguments` (8/7) — `speech.rs:550`.
  - `clippy::iter_any_ascii` — `speech.rs:79`.
  - `clippy::never_loop` — `power.rs:222`.
  - `clippy::chunks_exact_to_as_chunks` — `lib.rs:457` (test code; `--all-targets` only).
- `cd apps/desktop && npx tsc -b` → clean.
- `npx vitest run --maxWorkers=3` → **Test Files 155 passed (155); Tests 1099 passed (1099)**.
- `npm run build` → succeeded (Vite bundle written to `apps/desktop/dist`).

Because `cargo test` needs `frontendDist` and the staged sidecars in a fresh worktree, the
build was primed first with `cargo build -p bloblex-daemon --bin bitbotsd -p bloblex-hook
--bin bitbots-hook`, `node scripts/stage-daemon.mjs`, and `npm run build`.


## Exact release commands for the Director

The updater private key must be outside the repo, at
`%USERPROFILE%\.bloblex-release\updater.key` and `updater.pass`, or in
`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never commit or print it.

From a clean `main` checkout, with the version bumped in all four places
(root `package.json`, `apps/desktop/package.json`, `tauri.conf.json`, Cargo workspace) and
notes in `docs/releases/<version>.md`:

```powershell
# 1. Rehearse (no gh calls, no tag).
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-windows.ps1 -Version 0.1.0-beta.32 -DryRun

# 2. Real release: builds with the updater key, writes latest.json, creates the
#    pre-release with the installer + its .sig + latest.json, and uploads latest.json
#    to the rolling channel-beta pre-release with --clobber.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-windows.ps1 -Version 0.1.0-beta.32
```

Both were checked here with `-DryRun -SkipBuild -BundleDir <fake>` against a fake bundle
directory (`Bitbots_0.1.0-beta.31_x64-setup.exe` + `.sig`). The dry run printed exactly the
`gh release create v…`, `gh release view channel-beta`, `gh release create channel-beta`,
and `gh release upload channel-beta latest.json --clobber` commands, then the release URL,
installer name and SHA-256 — and ran nothing and touched no key material.

## Known limitations / notes

- The badge lives in `.header-actions`, which is `hidden` when no blob is selected and no
  session is open. With an active blob (the normal case) it is visible; Settings › Updates
  remains the fallback. Widening that would need a change to `App.tsx` beyond the one-line
  mount the brief asked for.
- The staged download is kept in memory only, as the brief allows.
- The pre-existing "Update available / View / Later" banner is untouched and can appear
  alongside the badge; the brief did not ask to remove it.
- `docs/RELEASE_CHECKLIST.md` was not edited to avoid clashing with other lanes; the report
  above is the record.
