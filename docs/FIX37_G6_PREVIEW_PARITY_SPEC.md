# FIX37 G6: the browser preview breaks on the new update exports

Lane: OpenCode `deepseek-v4.1-flash` (high), its own worktree. **Never run `git commit`.** Keep context small.

## Bug
The browser preview (`apps/desktop/vite.preview.config.ts`) aliases every `../tauri` import to `apps/desktop/src/preview/fixtureBridge.ts`. G5 added `listenForUpdateState` and `updatesPhase` to `src/tauri.ts` and imports them in `App.tsx`, `SettingsSheet.tsx` and the update badge, but the fixture bridge does not export them, so the preview page is blank:

```
SyntaxError: The requested module '/src/preview/fixtureBridge.ts' does not provide an export named 'listenForUpdateState'
```

## Fix
1. Add preview stand-ins to `fixtureBridge.ts`: `updatesPhase()` returns `{ phase: "idle" }` and `listenForUpdateState(handler)` returns an unsubscribe function. Add a way to see the badge in the preview: a query parameter `?update=downloading|ready|error` makes `updatesPhase` and the first `listenForUpdateState` event report that phase (version `0.1.0-beta.99`, 42% for downloading).
2. Add a **parity test** (`src/preview/fixtureBridge.parity.test.ts`): collect every name imported from `'../tauri'` (or `'./tauri'` / `'../../tauri'`, whatever the alias pattern matches) across `apps/desktop/src/**/*.ts(x)` (excluding tests), and assert each one is exported by `fixtureBridge.ts`. It must fail on the current code (before your stand-ins) and pass after. If other names are missing, add stand-ins for them too.

## Verify
- `cd apps/desktop && npx tsc -b && npx vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests |FAIL"` and `npm run build`
- `npx vite build --config vite.preview.config.ts` (or the preview config's build, if it has one) must succeed.

Write `docs/FIX37_G6_REPORT.md`.
