# Lessons (living log)

Newest first. One entry per lesson: date, area, symptom, root cause with evidence, fix, how to avoid it. Before adding, search this file; if an entry covers the topic, update it. Remove entries that stop being true (the history stays in `docs/history/`).

## 2026-10-25 · Storage · `sqlite: no such table: tasks` on an existing database (FIX43, beta.37)
- **Symptom:** the installed beta.37 showed `sqlite: no such table: tasks` on the Tasks page; a fresh database worked.
- **Root cause:** `Storage::migrate` returns early in a branch per schema version (`ledger==12`, `==11`, `==10`, ...), and each branch calls its own list of `ensure_*_schema`. `ensure_tasks_schema` was added only to the last, fresh-database path (`crates/bloblex-storage/src/lib.rs`), so every database an earlier version had created never got the task tables. The daemon tests all use `open_in_memory`, which takes the fresh path, so nothing caught it.
- **Fix:** `migrate` now wraps `migrate_versions` and calls `ensure_tasks_schema` once for every path. Test `an_existing_database_without_the_task_tables_gains_them_on_open` drops the task tables from a file database, reopens it and lists tasks (it fails without the fix).
- **Avoid:** a new additive `ensure_*_schema` goes in the shared wrapper, not in one version branch. Test an upgrade with a file database made by the previous shape, not only `open_in_memory`.

## 2026-10-25 · CSS · Message buttons sat above the bubble's middle (FIX43)
- **Symptom:** the time, copy, reply and reaction buttons beside a message were 7 px above the bubble's vertical centre (half of the 14 px row margin), more with a reaction badge.
- **Root cause:** `.message-action-shell` centres the buttons on its own box, but the `.message-row` inside it still had `margin-top: 14px` from `.message-row.user` / `.group-start` (`shell.css`) and 18 px from `:has(.message-reaction-badge)` (`experiments.css`). Those selectors tie with `.message-action-shell > .message-row { margin: 0 }`, and the later stylesheet wins.
- **Fix:** `.message-action-shell > .message-row:is(.user, .group-start, :has(.message-reaction-badge)) { margin: 0 }` (`experiments.css`); the shell owns the spacing. Measured 0 px in Haze, Frost, Stone and the companion; `messageActionsLayout.test.ts` pins the rule.
- **Avoid:** measure centring with `getBoundingClientRect` on the buttons and the bubble (`?experiments` turns the actions on in the preview); do not trust a screenshot.

## 2026-10-25 · UI · A `Select` inside a dialog grew the dialog (FIX43)
- **Symptom:** opening Project in the New task dialog drew the list inside the dialog and made it taller.
- **Root cause:** `.select-menu` is `position: absolute` under the trigger, so inside a scrolling, transformed dialog it extends the scroll area.
- **Fix:** `ui/Select.tsx` floats the list when its trigger sits inside `[role="dialog"]`: a portal into `document.body`, `position: fixed`, placed from the trigger's rect, flipped upwards when there is no room, re-placed on scroll and resize. Outside-click checks both the root and the floating list. Never use `visibility: hidden` for the first frame: it stops the list taking focus, so Escape would reach the dialog and close it.
- **Tests:** a Select in a dialog has its list outside the host. `ui/testSelect.ts` finds the list through the trigger's `aria-controls` (an older `trigger.parentElement.querySelector` fails for any Select in a dialog, as `MemoryPage.mounted.test.tsx` did).

## 2026-10-25 · Speech · Dictation showed no words while speaking (FIX43)
- **Symptom:** the island showed the timer and the waveform but no words; the preview showed words.
- **Root cause:** the default model (Parakeet) is an offline recognizer. `SpeechEngine::accept` only returned a `Final` when a 30-second chunk filled (`chunker.rs`) or on stop, so the native layer never emitted a `partial`. Only streaming models (Zipformer) produced partials. The preview fixture emits them for every engine.
- **Fix:** `crates/bloblex-speech/src/utterance.rs` (`UtteranceTracker`) cuts audio into utterances at pauses: a partial about every 1.2 s (the whole utterance so far, spaced out when a decode is slow), a final after 0.9 s of silence, a bound of 20 s. The engine decodes on those steps (`engine.rs`). The island says "Words appear when you stop." for the ChatGPT engine, which sends the whole recording at the end.
- **Avoid:** an engine that does not stream needs a segmenter to give live text; check what the real engine emits, not what the fixture emits.

## 2026-10-25 · Speech · Cactus's `libneedle.a` cannot be linked on MSVC; Whistle runs as a subprocess (FIX43)
- **Evidence:** `windows-x86_64/libneedle.a` (revision `d6c7d6a2e9655505e0f8e23339356dd1705900eb`) is one llvm-mingw COFF object (`needle.cpp.obj`) built against libc++ (`std::__1`) and the Itanium unwinder (`__gxx_personality_seh0`, `_Unwind_Resume`, `__cxa_*`), none of which the MSVC toolchain provides. The Python package loads a separate `libneedle.dll` instead.
- **Decision:** `needle.exe` from the same revision is downloaded with the model (both pinned by revision and SHA-256 in `catalog.rs`), re-hashed before every load, and run per utterance (`needle.rs`). Not verified: the engine's real output format (read leniently as JSON with `text`) and that it runs on the owner's machine; nobody executed the downloaded binary in the FIX43 lane.
- **Hash facts:** Hugging Face `?blobs=true` gives each LFS file's SHA-256 without a download; it matched a downloaded file.

## 2026-10-25 · Companion · The stick-to-bottom effect needs `mode` (FIX43)
`ui/App.tsx` follows new messages only while the log is at the bottom. Its reset branch (`chatSessionRef`) first ran when `view` changed, which used to mount the log; with the split layout the log mounts when the companion expands. Add `mode` to the effect's dependencies, or the first delivery after expanding resets the stick flag and the "New messages" pill never shows.

## 2026-10-25 · Process · Tool-call quoting, CRLF files and `vitest --root`
- Backslashes are halved in the commands the tools receive (`'\\'` arrived as `'\'`), and a long heredoc with apostrophes fails. Write a script file with the Write tool (use `chr(92)` for a backslash) and run it. Most `apps/desktop` and daemon files are CRLF in the working tree, `crates/bloblex-storage/src/lib.rs` is LF (git marks it binary); a Python text write turns LF into CRLF and rewrites the whole file. Read and write bytes and keep each file's endings (a small `sub(path, [(old, new, count)])` helper).
- Run vitest from `apps/desktop` (`npx vitest run <file>`). `--root apps/desktop` from the repository root fails with "Denied ID ...docs/releases/...?raw" for any test that mounts `App`.
- `FIX37.updateBadge.mounted.test.tsx` expects `v0.1.0-beta.36` and fails on `main` at `30c7b3d` too (the app is beta.37); the Director decides whether to fix it. `cargo clippy --workspace` also fails in the desktop crate on Rust 1.94 in code nobody touched (`speech.rs:79`, `run_worker`'s 8 arguments, `power.rs:222`, `lib.rs` argument counts); use `--exclude bloblex-desktop` for a clean run.

## 2026-10-24 · Gates · `cargo fmt --all -- --check` fails on `main` (3,766 diffs at f091ff7)
- **Symptom:** the fmt gate fails in files no lane touched (`bloblex-wsl`, `bloblex-speech`, `bloblex-process`, `cron.rs`, `tasks.rs`, `team.rs`).
- **Root cause:** the repository is not rustfmt-formatted; it uses deliberate dense, long lines. A `git archive HEAD` copy of `f091ff7` in a temp directory reports 3,766 `Diff in` blocks, so this is the baseline.
- **Avoid:** expect the fmt gate to fail; never run `cargo fmt` to "fix" it (it rewrites thousands of lines). Keep new lines under ~100 characters where the surrounding code allows, and report the baseline count rather than claiming the gate passed.

## 2026-10-24 · Daemon tests · Debug test threads overflow the stack
- **Symptom:** `cargo test -p bloblex-daemon` aborts with `STATUS_STACK_OVERFLOW` (0xc00000fd) in `fix39_p5_tests` (e.g. `row_manager_update_blob_refuses_a_locked_bot`), killing the whole binary so the rest never runs.
- **Root cause:** the default 2 MiB test-thread stack is too small for those tests' frames on this toolchain; the same tests overflow with HEAD sources restored, so it is not lane work.
- **Fix:** run daemon tests with `RUST_MIN_STACK=16777216` (`$env:RUST_MIN_STACK=16777216` in PowerShell); the suite then passes (465/465 on 2026-10-24).
- **Avoid:** if a single daemon test crashes the run without a failure line, run it alone with `--no-capture` and try `RUST_MIN_STACK` before suspecting the change.

## 2026-10-22 · Docs · Retiring a look leaves stale words in many documents
- **Symptom:** after Pop, Dot and Legacy were retired (AGENTS.md, 22 October 2026), about 40 current documents and the library still described five looks, the Flat and Dot robots as picker choices, and the pixel theme file that no longer exists.
- **Root cause:** nothing in the code gate checks prose, and the retirement changed code, tests and the handoff but not the reference pages.
- **Avoid:** when a look, art or setting is retired, sweep the current documents for its names (`grep -rniE "\bpop\b|\bdot\b|legacy|flat robot|dot robot|bitbots\.css" README.md AGENTS.md docs .claude/skills`), skipping the protected and dated paths (`docs/history`, `docs/releases`, `docs/evidence`, `docs/qa-schema`, `docs/design/archive`, generated library output). Dated records keep their wording and get a one-line update note instead. Retirement dates also differ between documents (20 and 21 October 2026); AGENTS.md is the record.

## 2026-10-21 · Daemon tests · A simulated turn end must release the slot
- **Symptom:** after calling `tasks::after_turn` directly, the next `task.dispatch` for the same bot came back `queued`/`bot_busy` and versions were one bump behind.
- **Root cause:** "the bot has a live turn" is read from `active_turns`. The event loop removes the entry when a turn really ends; a test that calls the after-turn hook itself never does.
- **Avoid:** in tests, call the hook and then `st.active_turns.lock().await.remove(session)` (see `end_turn` in `main.rs` `mod task_board_tests`), or let the fake adapter emit the turn-end event.

## 2026-10-21 · UI · A handed-off UI lane drifted from the owner's reference images
- **Symptom:** the Codex UI lane's screens passed fixture screenshots and mounted tests but did not look like the owner's references. The tree was an indented list, not a node graph; the timeline bars were unlabelled; the board's main action was a native select plus Assign; the connections page had a duplicated heading and text-only cards; onboarding showed fixture chips.
- **Root cause:** the briefs described features, not the reference composition, and passing mounted tests was taken as acceptance of the UI.
- **Avoid:** put the reference image beside each UI brief and name the composition to match it. The Director compares each screen with its reference in the preview before accepting it. Fixture screenshots are not native or live evidence. Check new pages for duplicated headings and raw native controls such as `<select>`.

## 2026-10-21 · UI · A new page's segmented control was not styled in the main window
- **Symptom:** the Tasks page used the shared `segmented` class (`ui/SegmentedControl.tsx`) and needed its own styling in the main window. The visible symptom was not recorded in detail.
- **Root cause (corrected the same day; the first version named the wrong cause):** `ui/companion.css` has an unscoped `.segmented` rule, and `main.tsx` loads that sheet in the main window too. The rule reads companion-only tokens (`--companion-alpha-07`, `--c-tab-on`, `--c-dim-2`), which are defined only under `.companion-surface` and `.companion-root` (`companion.css:4`). In the main window those tokens are undefined, so the background and colours fall back to their initial values. Pop, Dot and Legacy, now removed, had styled the control under their own scopes.
- **Fix:** the Tasks page's own stylesheet adds a scoped rule, `.tasks-page .segmented` (`ui/tasks.css`, on branch `exp/board-ui`).
- **Avoid:** before using a shared class in a new page, grep for its rules (`rg -n "\.segmented" apps/desktop/src`) and check which tokens each rule reads. A token defined only under the companion scope does not apply in the main window.

## 2026-10-21 · Process · The Bash tool rejects long heredocs with apostrophes
- **Symptom:** a `cat > file <<'EOF'` heredoc that contained apostrophes failed with "unexpected EOF while looking for matching quote".
- **Root cause:** the Bash tool's parser mis-reads quotes inside long heredoc bodies.
- **Avoid:** write such files with the Write tool, or write a script file and run it. Do not rely on a long heredoc with quotes in it.

## 2026-10-21 · Verification · Browser pane screenshots can show the previous state
- **Symptom:** a screenshot showed the page before the last change, and a viewport emulation larger than the pane rendered the page scaled into one corner.
- **Root cause:** the pane captures before the new render settles, and an emulated size larger than the pane is scaled down to fit.
- **Fix:** wait about a second and take the screenshot again. Reset the emulation with the `desktop` preset and check at the pane's own size.
- **Avoid:** never judge a layout from one screenshot taken straight after a change, and never judge it from an emulated size larger than the pane.

## 2026-10-21 · Startup reads during daemon replacement
The native window could keep a startup warning after an RPC used a stopped loopback listener while the current daemon was listening elsewhere. Independent catalog checks and a clone of the development store were healthy. `daemon_rpc` now retries once on a transport/not-running error for an explicit list of observational startup methods, reacquiring the current native-held connection after `start_daemon`. Never replay `session.prompt`, settings writes, deletion, shutdown, authorization errors or invalid arguments. Native tests pin this allowlist. `runLaunchChecks` preserves string rejections from Tauri; the notice names the failed step and strips transport URLs. A rebuilt native startup was verified without the warning.

## 2026-10-20 · Owner direction · Two app themes only
Only Bitbots and Blobots remain. Remove retired look CSS and registrations, normalize old cached/database/backup selections to Bitbots, and keep bot art independent. Do not delete saved bot-art ids as part of removing an app theme. Tests for removed themes are replaced by migration/rejection coverage. Service-worker tests must compare the precache against emitted files, not an arbitrary minimum count: deleting unused theme font chunks reduced the legitimate asset count.

## 2026-10-20 · Native links and settings events
- Calling the opener with only `opener:allow-open-url` left its URL scope empty: every valid link was rejected and the UI swallowed the error. `capabilities/main-links.json` now allows only `https://*` and `http://*`; unsafe schemes and credential-bearing URLs remain refused.
- `showMainSettings` used a renderer `emit` without emit permission. Pass the requested page through `show_main_settings` and emit it from Rust instead of broadening event permissions. Update its tray caller when changing the signature.

## 2026-10-20 · Selection, paste and development isolation
- Runtime-selection echoes must not choose a different bot. A newly selected bot may have only a local draft; preserve it and publish a session only once one exists. `App.emptyConversation.mounted.test.tsx` covers an old runtime echo and companion round trips.
- Some WebView2 image pastes have no DOM paste event. The composer also reads the native clipboard from Ctrl+V, invalidates duplicate reads when DOM image files arrive, and keeps ordinary text pastes intact. OpenCode images use advertised ACP image capability and base64 content blocks, rather than a blanket provider rejection.
- Live probes must copy the daemon executable into their own temp folder before spawning it; otherwise a concurrent Cargo build can hit Windows error 5. `live-composer.mjs` now follows the shell's private-copy pattern.

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
- **Churn after a build:** `npm run docs:build` rewrites every snapshot in `docs/library/sources/` with LF, so on a CRLF checkout `git status` lists ~290 modified files. Check `git diff --ignore-cr-at-eol --stat`; then `git checkout -- docs/library/sources`, which also undoes the real changes to snapshots of sources you edited; copy each edited source back over its snapshot (`docs/library/sources/<same path>`, a plain copy), and run `npm run docs:check` (it passes). Adding release notes needs a docs rebuild, or `docs:check` fails (beta.36).

## 2026-10-19 · Docs · Library guides must stay user-facing
- **Symptom:** the first library build mixed developer material into the guides: `package.json`/`Cargo.toml` version notes, `settings.set`/`appearance.style` keys, `path:line` citations and "daemon"/"adapter"/"IPC" terms; the five-minute path also repeated a stale README version note.
- **Rule (owner review):** guides (`docs/library/content/guides/*.md`, plus `overview.md` and `glossary.md`) are for people using Bitbots. Remove code citations, file names, RPC/settings keys and internal terms unless the user must type or see them. Say the fact in user terms and link to the matching reference page for developer detail. Do not mention documentation discrepancies in guides.
- **Avoid:** when writing or reviewing a guide, grep for `path:line`, backticked identifiers, `daemon`, `RPC`, `adapter`, `IPC`, `settings.`, `appearance.` and `data-`; keep screenshots, captions, front blocks and working links.

## 2026-10-19 · Looks · Frost and Pop never applied in the installed app (FIX42)
- **Symptom:** beta.35 installed: Settings showed Bitbots and a wallpaper selected, the window stayed plain dark; the browser preview looked right.
- **Root cause:** `loadStyle` in `apps/desktop/src/blob/bitbots.ts` picked the look stylesheet with a nested ternary of three CSS-only `import()` calls. Vite's production build turned it into one `__vitePreload(..., __vite__mapDeps([7]))` whose dependency list was only the last branch (`dot.css`), so Frost and Pop loaded Dot's CSS. Proven over the WebView2 debugging port (loaded sheets: `index`, `inter`, `dot`) and in the built JS. The dev server does not rewrite preloads, so the preview hid it.
- **Fix:** all look stylesheets are static imports in `apps/desktop/src/main.tsx`; `src/ui/themeBuild.test.ts` forbids dynamic imports of look CSS (`098831e`, merged in `c119f93`, shipped in v0.1.0-beta.36). Since 20 October 2026 the only look stylesheet is `ui/themes/frost.css`; the Dot and Pop sheets named above were removed in `5eb6879`.
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
Dot and Pop were removed on 20 October 2026, but the rule stands for any filled look. Dot (inverted) and Pop (butter) selections both shipped with unreadable descendants at first (white title on white; cream role chip and amber status on butter) because base rules for `.role-chip`, row times and `.bot-row-preview.waiting` are more specific. Scope the overrides under the selected element with enough specificity and check every descendant in dark and light.

## 2026-10-19 · Design · Frost glass level
At tint .84 the Lake wallpaper's bright band bled through all panels as a stripe; Solid is tint .93 / blur 24 px. The owner wants Solid as the default and no glow anywhere.

## 2026-10-19 · CSS · Mini avatars
`ArtFrame` marks small avatars with `data-mini`, not a class; style them with `.art-frame[data-mini] ...`.

## 2026-10-19 · Daemon · Look and settings keys are allowlisted
`valid_look` rejects unknown top-level look keys, and `normalizeLook`, `agentLook`, `lookKey` rebuild looks from known keys only: a new look field must be added in both TypeScript and `crates/bloblex-storage/src/lib.rs`, or it is silently dropped or rejected. Haze's `icon` key (null or one of `logo`, `logo-tint`, `logo-mono`, `px-robot` … `px-bolt`, `ICONS` in `valid_look`) is the latest example: it also needs the Manager descriptions in `team.rs` and `proposals.rs`.

## 2026-10-19 · Links · Safe opener
Chat links are `<a href target="_blank">` routed through `openSafeLink`; middle-click and Ctrl/Cmd/Shift-click must also go through it (`onAuxClick`), and the desktop app must never fall back to `window.open` inside the webview.

## 2026-10-19 · Release · SHA256SUMS
`scripts/release-windows.ps1` does not create `SHA256SUMS.txt`; upload it separately (format `<sha256>  <installer>` and a newline) and verify its digest.

## 2026-10-24 · Preview · Portals into a React-owned node
Portaling tooltips and drag ghosts into the page's root `.mini` element (rendered by React) threw `removeChild ... not a child of this node` on unmount. Portal into an empty host element that React renders but never fills (`<div id="mini-portal" />`) and keep it inside the themed root so its CSS variables still apply. A page that is both a Vite entry and edited live also re-runs `createRoot` on hot reload; keep the root on the container (`host.miniRoot ??= createRoot(host)`).

## 2026-10-24 · CSS · Lifting content above a background layer broke absolutely placed children
- **Symptom:** in Haze the side-conversation pill shrank to 23 px around one logo, and the companion focus card's avatar slid onto the name.
- **Root cause:** `.chat-header > :not(.haze-aura) { position: relative; z-index: 1 }` (and the same on `.island-card.focus`) made `.chat-title` the containing block of the absolutely centred `.side-header`, and overrode `.card-bot`'s `position: absolute`.
- **Fix:** keep the children as they are; give the parent `isolation: isolate` and the background layer `z-index: -1`.
- **Avoid:** never re-position a component's children from a theme to stack them; push the decoration down instead. Likewise, a theme token used as a page background (`--surface-panel`, `--surface-app`) is also used by popovers and ring cut-outs: making it transparent made the profile menu see-through and the usage rings pies (rings now cut their centre with a mask).

