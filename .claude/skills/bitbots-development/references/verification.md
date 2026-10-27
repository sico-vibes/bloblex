# Verification

Last reviewed: 2026-10-22 (Rust 1.94.0 stable, Node 24, OpenCode 2.0.32, Codex CLI 0.163). Update this file when a gate, tool or environment fact changes.

## Gates (run all before calling work done)

From the repository root (or a worktree):

```powershell
npm run typecheck                         # tsc -b
npm test                                  # vitest, all files
cd apps/desktop; npm run build            # tsc -b && vite build (the production bundle)
cd apps/desktop; npm run build:remote         # the phone PWA, when remote code changed (script is in apps/desktop)
$env:RUST_MIN_STACK='33554432'            # some daemon tests overflow the default test stack
cargo test --workspace --exclude bloblex-desktop
cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings
# desktop crate: only from a short path (see below)
$env:TAURI_CONFIG='{"bundle":{"externalBin":[]}}'   # skip staged sidecars for a check
cargo test -p bloblex-desktop --lib
```

- Run vitest from `apps/desktop` (`cd apps/desktop; npx vitest run <file>`); from the root, `--root apps/desktop` fails for tests that mount `App` ("Denied ID ...docs/releases"). `FIX37.updateBadge` fails on `main` at `30c7b3d` (expects beta.36), and `cargo clippy --workspace` fails inside `bloblex-desktop` on Rust 1.94 in untouched code; use `--exclude bloblex-desktop` for a clean clippy run.
- Run the Vitest suite on a quiet machine. When lanes or cargo builds run at the same time, mounted tests time out in large numbers (57 and 100 false failures were seen); re-run the failing files alone, or use `npx vitest run --maxWorkers=4`, before believing a failure.
- When filtering output in PowerShell, `Select-String` is case-insensitive: a pattern for `FAILED` also matches test names containing "failed" and can push the summary line out of view. Use `-CaseSensitive`.
- The desktop crate cannot build from a path containing an apostrophe (the main checkout `D:\Basem's\...`): the Windows resource compiler mangles the icon path. Use a worktree or clone at `D:\fxNN`.
- In a fresh worktree or clone, run `npm run build` in `apps/desktop` before `cargo test -p bloblex-desktop`: `tauri::generate_context!()` fails with "The `frontendDist` configuration is set to `../dist` but this path doesn't exist". Afterwards revert the line-ending churn in `apps/desktop/src-tauri/gen/schemas/` (`git checkout --`), or the release script refuses the unclean checkout (beta.36).
- From the root, run `npm test` (or `npx vitest` inside `apps/desktop`), never a bare `npx vitest run` at the root: it collects the test files of every worktree under `.claude/worktrees` and reports thousands of false failures (beta.36: 4,079 failed files).
- The Codex sandbox cannot let Vite write its temp config through a `node_modules` junction (`EPERM`): add `--configLoader runner` to `vite build` and `vitest run` there, or run the gate yourself.
- `cargo test --workspace` stops at the first crate that fails, so later crates never run. Add `--no-fail-fast` when you need every failure (2026-10-27).
- A `../tauri` export missing from a test's `vi.mock` factory makes every App-mounting test in that file fail with the same "No "x" export is defined" error, which hides the real failures behind it. After adding the export, expect more failures to appear (2026-10-27: 121 hid 32).

## T3 wave verification (2026-10-26)

Owner rule: no tests and no screenshots in that wave. What was run instead: `npx tsc -p apps/desktop --noEmit`, `npm run build` and `npm run build:remote` in `apps/desktop`, and `cargo check -p bloblex-daemon -p bloblex-storage -p bloblex-desktop` (with `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'` and a stub `apps/desktop/dist/index.html`) from `D:\t3`. `team_p10_tests.rs` still compiles through a `#[cfg(test)]` shim of `prepare_worktree`.

## T7 wave verification (2026-10-27)

No tests were run in the wave itself: only production-only `tsc`, `vite build` and `cargo check`. Round 2 (same day) added the wake/cancel/pause lane (`D:/v1`) and the ambiguous-send/limited lane (`D:/v2`); the exact unverified cases are in `docs/history/t7/REPORT-round2.md`.

## T3 and T7 gates restored (2026-10-27, Claude, main checkout)

The full gates now pass on the uncommitted T3 and T7 work: `npm run typecheck`, `npm test` (1,481), `cargo test --workspace --exclude bloblex-desktop` (939), `cargo clippy --workspace --exclude bloblex-desktop --all-targets -D warnings`, `npm run build` and `npm run build:remote`. **Not run:** `cargo test -p bloblex-desktop` (needs a short path, see above). What the fixes were, and which tests changed because the behaviour changed on purpose, is in `lessons.md` under the same date.


## Live development without releases (2026-10-20)

Run `npm run desktop:dev` from a checkout without an apostrophe. The launcher builds/stages the daemon and hook, uses Vite on a free port from 1420–1435 and identifier `com.bitbots.desktop.dev`, and now defaults `BLOBLEX_DB_PATH` to `<CARGO_TARGET_DIR>/dev-data/bloblex.db`. An explicit override is retained. Development skips migration of the installed shared store and autostart entry. UI edits refresh through Vite; daemon edits still require rebuilding, restaging and restarting the development shell. No installer or release is required. Keep test projects separate too: a private database does not isolate project-file edits.

For rapid Haze UI review (26 October 2026), `D:/bitbots-review46/Run Bitbots Review.cmd` now runs Tauri dev with `review-hotreload.json`, Vite on 1420, and the existing isolated review database. React/CSS/SVG edits in the haze-avatar-review checkout refresh automatically; compiled review EXEs do not. Tauri dev runs `target/debug/bloblex-desktop.exe` (not the renamed packaged `BitbotsReview.exe`). Backend/native changes still require a build and restart. No UI sweep is implied by restarting this review app.

The fixture preview is not a live client. The remote PWA is a separate restricted interface. Full browser parity needs a trusted local bridge and separation of daemon connectivity from `inDesktop` guards; never expose the capability or enable broad CORS to achieve it. Keep production bundle checks: Vite dev can hide CSS chunking bugs.

When measuring theme contrast, wait for colour transitions to finish (250 ms in this review); sampling immediately after changing theme produced false failures. Check user-bubble links as well as selected rows, inline code and fenced code. Native clipboard verification used a generated PNG written with the browser clipboard API, the real native clipboard reader, then the composer's Ctrl+V handler; real Codex image delivery also passed.

## The browser preview

`npx vite --config apps/desktop/vite.preview.config.ts apps/desktop --port 5174 --strictPort --host 127.0.0.1` (the Claude desktop app has this as the `desktop-preview` launch config). It swaps `tauri.ts` for `preview/fixtureBridge.ts` (fixture bots and conversations, no daemon).

The task board is on `main` (phase 1, 22 October 2026). Its browser-preview data comes from `apps/desktop/src/preview/fixtureTasks.ts`, a preview-only ledger that mimics the task contract, so the board checks run without the daemon. Any local launch file (`.claude/launch.json`, git-ignored) and worktree from the earlier `exp/board-ui` lane are historical; check them before reuse.

Useful URLs: `/` (main window; add `?style=bitbots|blobots`, `&theme=light|dark`, `&wallpaper=`, `&glass=`, `&font=`, `&accent=%23rrggbb`, `&density=`), `/?preview-settings` (settings sheet), `/?companion&mode=home&view=chat|activity|settings`, `/preview.html` (bot art sheet, which shows all six arts, including Flat and Dot that the picker does not offer; `?art=robot|robot-flat|robot-pop|robot-dot|blob|painted`). Pass `?style=bitbots` or `?style=blobots` for the look; `pop`, `dot` and `legacy` were retired and are not offered, `/launch-preview.html?fixture=in-progress|onboarding-step-1`, `/dictation-preview.html`, `/gallery.html`.

The app plays a launch intro and fades the shell in; screenshots taken in the first seconds show a dimmed or empty window. Wait or check `getComputedStyle(document.querySelector('.app-shell')).opacity === '1'`. The real window is at least 1000 px wide; layout overlaps seen only below that width are not bugs.

**The preview is Vite's dev server, not the production bundle.** Anything that depends on bundling (dynamic imports, CSS chunking, asset URLs, preloads), on native APIs or on WebView2 must also be checked in `npm run build` output or in the installed app.

## Checking the installed app (read-only)

To see what the real window has (attributes, loaded stylesheets, console errors), restart Bitbots with the WebView2 debugging port. Restarting stops the daemon and interrupts any bot that is working, so first get the owner's explicit permission at a moment when nothing they care about is running; never restart it as a side effect of another check. Then:

```powershell
Get-Process -Name Bitbots | Stop-Process          # the daemon exits with it
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9229 --remote-allow-origins=http://127.0.0.1:9229'
Start-Process "$env:LOCALAPPDATA\Bitbots\Bitbots.exe"
Invoke-RestMethod http://127.0.0.1:9229/json      # pages: /, ?companion=1, ?dictation=1
```

Then connect to the page's `webSocketDebuggerUrl` with a small Node script (`new WebSocket(...)`, `Runtime.evaluate` with `returnByValue`) and read `document.documentElement.dataset`, `[...document.styleSheets].map(s => s.href)`, `performance.getEntriesByType('resource')`, computed styles, and console/log events. Read only; never print localStorage values that hold tokens. **Afterwards restart Bitbots normally without the variable** (the open port lets any local program control the app) and confirm the port is closed.

## UI review checklist

Both supported looks (Bitbots and Blobots), in dark and light; selected, hover, focus and disabled states; text contrast of 4.5:1 or more; no pill or circle controls in the new looks (the Manager and lock badges and the look orbs excepted); companion and dictation windows if styles changed; reduced motion; the production build when styles or assets load differently.
