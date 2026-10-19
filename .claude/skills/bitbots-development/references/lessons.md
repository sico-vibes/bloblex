# Lessons (living log)

Newest first. One entry per lesson: date, area, symptom, root cause with evidence, fix, how to avoid it. Before adding, search this file; if an entry covers the topic, update it. Remove entries that stop being true (the history stays in `docs/history/`).

## 2026-10-19 · Process · A piped gate hid a failure before a push
- **Symptom:** the Director ran `git merge ... && node scripts/docs-library.mjs check 2>&1 | tail -1 && ... && git push`; the check failed, but `main` was pushed anyway (`917f730`).
- **Root cause:** in a pipe, the exit status is the last command's (`tail`, which succeeds), so `&&` never saw the failure.
- **Avoid:** never pipe a gate through `tail`, `head` or `Select-Object` in a chain that ends in `git push`, a release or a merge. Run each gate on its own and check its exit code (`$LASTEXITCODE` in PowerShell, `$?` or `set -o pipefail` in bash) before the next step.

## 2026-10-19 · Docs · Library discovery must use tracked files only
- **Symptom:** the owner's local scratch file `output/task-a/REPORT.md` made `node scripts/docs-library.mjs check` fail with "Document inventory has changed; rebuild the library."
- **Root cause:** discovery ran `git ls-files --cached --others --exclude-standard`, so any untracked Markdown file anywhere in the checkout became a library document. The catalogue had been built without it.
- **Fix:** discovery now runs `git ls-files --cached -z` and still walks `docs/library/content/` separately for the hand-written pages. Untracked scratch files are ignored.
- **Avoid:** a documentation inventory is a tracked set plus explicit generated content, never `git ls-files --others`. When adding a source root, add it deliberately and test with an untracked Markdown file present.

## 2026-10-19 · Docs · Library hashes must ignore line endings
- **Symptom:** on a checkout with `core.autocrlf=true`, `node scripts/docs-library.mjs check` reported every text asset and snapshot stale: `scripts/docs-library.mjs`, `docs/library/assets/...`, `docs/library/content/...`.
- **Root cause:** `build` wrote hashes from the LF source files it read; `check` hashed the raw CRLF bytes produced by git checkout. Markdown snapshots had the same mismatch.
- **Fix:** `hashSource()` in `scripts/docs-library.mjs` normalises CRLF to LF for `.md`, `.css`, `.js`, `.mjs`, `.svg`, `.json` and `.html` before SHA-256; PNG stays byte-for-byte. Build, asset hashes and snapshot comparison all use it.
- **Avoid:** normalise before hashing, never hash raw working-tree bytes for text. Prove with a CRLF round-trip on one Markdown file, one CSS file and the script, then convert back to LF.

## 2026-10-19 · Docs · Library guides must stay user-facing
- **Symptom:** the first library build mixed developer material into the guides: `package.json`/`Cargo.toml` version notes, `settings.set`/`appearance.style` keys, `path:line` citations and "daemon"/"adapter"/"IPC" terms; the five-minute path also repeated a stale README version note.
- **Rule (owner review):** guides (`docs/library/content/guides/*.md`, plus `overview.md` and `glossary.md`) are for people using Bitbots. Remove code citations, file names, RPC/settings keys and internal terms unless the user must type or see them. Say the fact in user terms and link to the matching reference page for developer detail. Do not mention documentation discrepancies in guides.
- **Avoid:** when writing or reviewing a guide, grep for `path:line`, backticked identifiers, `daemon`, `RPC`, `adapter`, `IPC`, `settings.`, `appearance.` and `data-`; keep screenshots, captions, front blocks and working links.

## 2026-10-19 · Looks · Frost and Pop never applied in the installed app (FIX42)
- **Symptom:** beta.35 installed: Settings showed Bitbots and a wallpaper selected, the window stayed plain dark; the browser preview looked right.
- **Root cause:** `loadStyle` in `apps/desktop/src/blob/bitbots.ts` picked the look stylesheet with a nested ternary of three CSS-only `import()` calls. Vite's production build turned it into one `__vitePreload(..., __vite__mapDeps([7]))` whose dependency list was only the last branch (`dot.css`), so Frost and Pop loaded Dot's CSS. Proven over the WebView2 debugging port (loaded sheets: `index`, `inter`, `dot`) and in the built JS. The dev server does not rewrite preloads, so the preview hid it.
- **Fix:** all look stylesheets are static imports in `apps/desktop/src/main.tsx`; `src/ui/themeBuild.test.ts` forbids dynamic imports of look CSS (`098831e`, merged in `c119f93`, shipped in v0.1.0-beta.36).
- **Avoid:** never put several `import()` calls in one conditional expression; give each its own arrow function (as `ui/fonts.ts` does). Check bundling-sensitive changes in `npm run build` output or the installed app, not only the preview.

## 2026-10-19 · Process · A lane's root cause can be wrong while its fix works
FIX42's lane blamed "lazy CSS does not load in the WebView" (contradicted by Legacy's lazy CSS working for many betas). Always test the stated cause against evidence before recording it.

## 2026-10-19 · Toolchain · Rust 1.94 on the build machine
`AtomicU64::try_update` is unstable on 1.94 (fixed with `fetch_update`, `28da243`); clippy on 1.94 flags `!x.is_some_and(...)` patterns (use `is_none_or`), needless borrows and items after test modules (`7412a9c`). Earlier betas were built with a newer toolchain. Run clippy before every release.

## 2026-10-19 · Native build · Apostrophe in the checkout path
`cargo check/test/build -p bloblex-desktop` fails with `RC2135 file not found: D:\Basem\'s\...\bloblex.ico` from the main checkout. Build the desktop crate and releases from a short path (`D:\fxNN`, `D:\bNN`).

## 2026-10-19 · Lanes · OpenCode 2 flags
OpenCode 2.0 removed `--variant` and `--dir`; effort is `-m provider/model#high`, run from the worktree, add `--auto`. Old flags print help and exit 1. Upgrading OpenCode while a lane runs killed two runs (exit code 9).

## 2026-10-19 · Lanes · Codex sandbox limits
No network, no writes outside the workspace: npm installs fail, and Vite/Vitest cannot write their temp config through a `node_modules` junction (`EPERM`; use `--configLoader runner`). The Director installs packages and runs the full gates.

## 2026-10-19 · Tests · Load-induced failures
Full Vitest runs alongside cargo builds or lanes produced 57 and 100 false failures (timeouts). Re-run failing files alone before treating them as real.

## 2026-10-19 · Tests · Settings broadcast queue
A daemon test that sets many settings must assert the broadcast events it cares about before setting more keys: every `settings.set` queues a `settings.changed` event, and later `events.recv()` calls read the queued ones first (FIX40 `appearance_settings_validate_persist_and_broadcast`).

## 2026-10-19 · Design · Selected rows in filled looks
Dot (inverted) and Pop (butter) selections both shipped with unreadable descendants at first (white title on white; cream role chip and amber status on butter) because base rules for `.role-chip`, row times and `.bot-row-preview.waiting` are more specific. Scope the overrides under the selected element with enough specificity and check every descendant in dark and light.

## 2026-10-19 · Design · Frost glass level
At tint .84 the Lake wallpaper's bright band bled through all panels as a stripe; Solid is tint .93 / blur 24 px. The owner wants Solid as the default and no glow anywhere.

## 2026-10-19 · CSS · Mini avatars
`ArtFrame` marks small avatars with `data-mini`, not a class; style them with `.art-frame[data-mini] ...`.

## 2026-10-19 · Daemon · Look and settings keys are allowlisted
`valid_look` rejects unknown top-level look keys, and `normalizeLook`, `agentLook`, `lookKey` rebuild looks from known keys only: a new look field must be added in both TypeScript and `crates/bloblex-storage/src/lib.rs`, or it is silently dropped or rejected.

## 2026-10-19 · Links · Safe opener
Chat links are `<a href target="_blank">` routed through `openSafeLink`; middle-click and Ctrl/Cmd/Shift-click must also go through it (`onAuxClick`), and the desktop app must never fall back to `window.open` inside the webview.

## 2026-10-19 · Release · SHA256SUMS
`scripts/release-windows.ps1` does not create `SHA256SUMS.txt`; upload it separately (format `<sha256>  <installer>` and a newline) and verify its digest.
