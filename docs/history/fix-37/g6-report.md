# FIX37 G6 report: browser preview parity with the update exports

> **What this is:** Report on FIX37 G6: browser preview parity with the update exports.
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: OpenCode `deepseek-v4.1-flash` (high), worktree `C:\fx66`. No commit was run.

## Bug

`vite.preview.config.ts` aliases every `../tauri` import to
`apps/desktop/src/preview/fixtureBridge.ts`. G5 added `listenForUpdateState` and
`updatesPhase` to `src/tauri.ts` and imported them from `UpdatesPanel.tsx`, but
the fixture bridge did not export them, so the preview page died at module load:

```
SyntaxError: The requested module '/src/preview/fixtureBridge.ts' does not provide an export named 'listenForUpdateState'
```

## Changes

`apps/desktop/src/preview/fixtureBridge.ts`

- `updatesPhase()` — returns `IDLE_UPDATE_PHASE` (`{ phase: "idle", version: null, downloadedBytes: null, totalBytes: null, message: null }`) by default.
- `listenForUpdateState(handler)` — registers the handler and returns an unsubscribe function.
- Preview flag `?update=downloading|ready|error` makes `updatesPhase()` and the first `listenForUpdateState` event report that phase for version `0.1.0-beta.99`; `downloading` reports 42% (`42 / 100`). Any other or absent value stays idle.
- Added the missing type stand-ins `BackupInclude` and `BackupStats` (imported by `BackupPage.tsx`), and typed `writeBackupExport`'s `include` argument with `BackupInclude`.

`apps/desktop/src/preview/fixtureBridge.parity.test.ts` (new)

- Statically walks `apps/desktop/src/**/*.ts(x)` (excluding tests, specs and `.d.ts`), collects every name imported from `../tauri` / `./tauri` / `../../tauri`, parses the exports of `fixtureBridge.ts`, and fails when any imported name has no fixture stand-in.
- Parsing is static, not an import, for the same reason as `remoteTauri.parity.test.ts`: importing the fixture graph needs a DOM and runs the whole preview.

## Pre-fix failure (proves the test bites)

Running the same collection against the pre-change `fixtureBridge.ts`
(`git show HEAD:...`) reports exactly four missing names:

```
src/ui/BackupPage.tsx: BackupInclude
src/ui/BackupPage.tsx: BackupStats
src/ui/UpdatesPanel.tsx: listenForUpdateState
src/ui/UpdatesPanel.tsx: updatesPhase
```

## Verification

- `npx tsc -b` — clean.
- `npx vitest run --maxWorkers=3` — `Test Files 162 passed (162)`, `Tests 1136 passed (1136)`, no FAIL.
- `npm run build` — `✓ built`.
- `npx vite build --config vite.preview.config.ts` — `✓ built` (previously this failed to resolve the missing export).

Manual preview check: open the preview dev server with `?update=downloading`,
`?update=ready` or `?update=error` to see the update badge.
