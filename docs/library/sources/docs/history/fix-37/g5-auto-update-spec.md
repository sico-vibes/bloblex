# FIX37 G5: automatic updates with a "Downloading" / "Restart to update" badge

> **What this is:** Spec for FIX37 G5: automatic updates with a Downloading and Restart to update badge.
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: OpenCode `deepseek-v4.1-flash` (high), its own worktree. The owner has asked the lanes to do UI work in this wave. **Never run `git commit`.** Keep context small. Read the section headings of `AGENTS.md`, then `docs/operations/updater.md` and the "Updater key" and "Update manifest and channels" sections of `docs/operations/release-checklist.md`. Other lanes are changing `App.tsx`: put the badge in its own component and add only a one-line mount in `App.tsx`.

## What exists
`apps/desktop/src-tauri/src/updates.rs` already has channels (`beta` → `channel-beta/latest.json`, `stable` → `releases/latest`), preferences (`auto_check`, `last_checked_at`), `updates_check`, `updates_install` (download then install, with progress events) and Settings › Updates. Releases since beta.7 have been **manual-only** (no `latest.json`), so the feed still offers beta.6.

## What the owner wants
The app downloads newer versions (betas and pre-releases included on the beta channel) **by itself**, then shows a badge to restart into the update.

- **Background check:** at start (after 30 s) and every 4 hours while running, when `auto_check` is on (default **on**). Respect the channel.
- **Background download:** when a newer version is found, download it in the background without installing (keep the bytes, verified against the updater signature, in memory or a temp file under the app's data folder). Do not install without the user.
- **Badge:** the window uses the native title bar (`titleBarStyle: "Visible"`), so the badge cannot sit next to the minimise button. Put it at the **right end of the app's own top bar** (the main header row), before any existing header buttons:
  - "Downloading update · 42%" with a small progress ring while downloading (not clickable, tooltip with the version);
  - **"Restart to update"** (accent button, version in the tooltip) when ready: it installs and relaunches (`tauri-plugin-process` relaunch, or the NSIS passive install that restarts the app);
  - "Update failed" (quiet, click to retry) on error.
  - Nothing at all when there is no update. The companion window shows nothing.
- **Settings › Updates** shows the same state, keeps "Check now", and the auto-check toggle reads "Download updates automatically".
- **Events:** `updates.state { phase: idle|checking|downloading|ready|installing|error, version?, downloadedBytes?, totalBytes?, message? }` from native to the UI; the UI subscribes once.
- **Release pipeline:** from the next release on, releases must be **signed for the updater** (not Authenticode): build with `createUpdaterArtifacts: true` and the updater key in `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (or `%USERPROFILE%\.bloblex-release\updater.key` and `updater.pass`), run `scripts/make-update-manifest.mjs`, attach `latest.json` and the `.sig` to the release, and `gh release upload channel-beta latest.json --clobber`. Make `scripts/release-windows.ps1` (or a new `scripts/release-manual-signed.ps1`) do exactly that for an unsigned-Authenticode but updater-signed beta, with `-DryRun`. **Never print, log or commit key material.** The Director runs the release; you only make the script and check it with `-DryRun` against a fake bundle dir.

## Tests
- Rust (`updates.rs` tests): the scheduler only runs when `auto_check` is on; a newer version moves `checking → downloading → ready`; no install happens without the command; an error yields `error` with a safe message.
- `cargo test -p bloblex-desktop --lib` must pass.
- Mounted test for the badge component: each phase renders the right label; "Restart to update" calls the install command.

## Gates
- `cargo test -p bloblex-desktop --lib 2>&1 | grep "test result"` and `cargo clippy -p bloblex-desktop -- -D warnings` for the code you changed (pre-existing lints elsewhere in the crate may remain; list them).
- `cd apps/desktop && npx tsc -b && npx vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests |FAIL"` and `npm run build`

Write `docs/history/fix-37/g5-report.md`, including the exact release commands the Director should run.
