# Recipes for recurring changes

Last reviewed: 2026-10-22. Each recipe lists every place that must change together; missing one is the usual cause of a broken gate or a feature that works only in the preview. Update a recipe when you find a step it lacks.

## Add a settings key

1. Daemon validation, both layers: `crates/bloblex-storage/src/lib.rs` `validate_setting_value` and `crates/bloblex-daemon/src/main.rs` `validate_setting` (enum or regex; add the key to the `validation_key` list in the `settings.set` handler so bad values return `invalid_argument`). Extend the appearance or settings test there. Never let a key that contains `token`, `secret` or `password` through.
2. Backup, if it should travel: `crates/bloblex-daemon/src/backup.rs` `SETTING_ALLOWLIST` (a fixed-size array: update the length).
3. Remote, if a paired phone may read it: `apps/desktop/src/remote/tiers.json` `settingsAllowlist`.
4. Window: `apps/desktop/src/ui/App.tsx` reads it on connect (the key list near `settings.get`) and live (`settings.changed` → `applyWindowSetting`). Cache it in localStorage (try/catch around every access) if the first paint needs it, and add it to `index.html`'s pre-paint script only if a flash would be visible.
5. UI: the control on its settings page (use `SettingsRow`, `SegmentedControl`, `Select`), written through `settings.set`. If step 4 gave the key a local cache (a safe presentation setting needed for first paint or an instant response), update that cache immediately rather than waiting for the `settings.changed` echo. Never cache sensitive values.
6. Search: an entry in `apps/desktop/src/ui/settingsIndex.ts`.
7. Preview: a query parameter in `apps/desktop/src/preview/fixtureBridge.ts` if reviewers need to see it.
8. Tests: TypeScript (store/attribute logic, the page) and Rust (validation). Run the gates.

## Add a look

The owner limited the product to Bitbots and Blobots on 20 October 2026, then chose **Haze** as the new primary look and the default for new installs on 24 October 2026. Add another look only when explicitly requested. Keep retired preferences normalized to Bitbots in the pre-paint cache, `blob/bitbots.ts`, storage startup and backup import.

1. `apps/desktop/src/ui/appearance.ts`: add the value to `ThemeStyle`, `THEME_STYLES`, `THEME_LOOKS` (label, family, one-line description).
2. Daemon validation of `appearance.style` (both layers, see "Add a settings key").
3. `apps/desktop/src/ui/themes/<look>.css`, scoped `:root[data-style="<look>"]:not(.companion-surface):not(.dictation-surface)` plus companion and dictation sections; override tokens first; follow `references/design-language.md`. Import it **statically** in `apps/desktop/src/main.tsx` (never a dynamic `import()`, see lesson FIX42).
4. Default bot art: `defaultArtForStyle` in `apps/desktop/src/blob/art/art.ts`. Default fonts: `FONT_DEFAULTS` in `apps/desktop/src/ui/fonts.ts`.
5. Look orb: `apps/desktop/src/ui/LookOrb.tsx` + `lookOrb.css` (orbs are theme-independent).
6. Launch greeting rules in `apps/desktop/src/ui/LaunchIntro.tsx` if the look needs special handling.
7. Tests: `ui/appearance.test.ts`, `ui/appearance.mounted.test.ts`, `blob/bitbots.test.ts`, `ui/SettingsSheet.appearance.mounted.test.tsx`, `ui/FirstRunOnboarding.mounted.test.tsx`, and the static-import guard `ui/themeBuild.test.ts` (add the new stylesheet to its list).
8. Check every screen in the preview in dark and light, and the production build (`npm run build`) or installed app.

## Add a bot art, or a hand-painted shape

- Art: add the value to `BotArt`, `BOT_ARTS`, `ART_LABELS` and the robot or blob group in `apps/desktop/src/blob/art/art.ts`; a renderer in `blob/art/` (SVG + CSS, `ArtFrame`, `useArtMood`, `artAria`, unique ids via `useId`, reduced-motion still pose); a case in `BlobCanvas`'s switch; the daemon's `valid_look` `ARTS` list (`crates/bloblex-storage/src/lib.rs`) and its test; the Manager tool schema description in `crates/bloblex-daemon/src/team.rs`; the `LookEditor` Style control picks it up from the groups; tests in `blob/art/*.test.ts(x)`; the character sheet `/preview.html?art=<value>`.
- Painted shape: add it to `PaintedShape`, `PAINTED_SHAPES`, `PAINTED_LABELS` (`art.ts`), a body/eye/light/badge entry in `PaintedBlob.tsx` `SHAPES`, the daemon `PAINTS` list in `valid_look` and its test. Check it at 16 to 22 px.
- Haze mark (`look.icon`): the value list is `ICONS` in `valid_look` (`crates/bloblex-storage/src/lib.rs`) — `logo`, `logo-tint`, `logo-mono`, then `px-*` pixel icons; `null` means no mark and any other value is invalid. A new value needs the list and its test here, plus the Manager descriptions in `crates/bloblex-daemon/src/team.rs` (tool schema) and `crates/bloblex-daemon/src/proposals.rs` (`propose_bot`).

## Add a daemon RPC or event

1. Handler in `crates/bloblex-daemon/src/main.rs` `dispatch()` (or its module), with tests.
2. A row in `apps/desktop/src/remote/tiers.json` (the parity tests `remoteTiers.parity.test.ts` fail without one); decide its tier (`never` for anything that changes settings, agents, files or the gateway).
3. The UI call in `apps/desktop/src/tauri.ts`, mirrored in `apps/desktop/src/preview/fixtureBridge.ts` (fixture behaviour) and `apps/desktop/src/remote/remoteTauri.ts` (a refusing stub if native-only); the parity tests check all three export the same names.
4. Document it in `docs/ipc-contract.md`.

## Add a task RPC or a board change (22 October 2026)

1. Storage first: the `task_*` function in `crates/bloblex-storage/src/lib.rs` (one `Immediate` transaction, a version check, the state rule the methods above it follow; append a `task_run_events` row for any run change). `ensure_tasks_schema` uses `CREATE TABLE IF NOT EXISTS`, so a new column on an existing table needs its own guarded `ALTER`.
2. Handler: the arm in `crates/bloblex-daemon/src/tasks.rs` `rpc()`; emit only the safe projection (`safe_task_event`, `run_event`). Route it from `dispatch()` in `main.rs` (the `"task.create" | ... | "task.runs"` arm), or the call is `not_found`.
3. Remote: a row in `apps/desktop/src/remote/tiers.json` (every `task.*` method is `never` today; the parity test fails without a row).
4. UI: the call in `apps/desktop/src/ui/useTasks.ts` through `apps/desktop/src/tauri.ts`; mirror it in `preview/fixtureBridge.ts` (or the preview board shows nothing) and in `remote/remoteTauri.ts` if the name is exported there.
5. Tests: the storage test next to the function, a daemon test in `main.rs` (the `task_*` tests), and the mounted or `taskModel` test for any view change.
6. Document: the table in `docs/ipc-contract.md` and the library pages `reference/task-board.md` and `guides/tasks.md`.

## Add a downloadable speech model (FIX43, Whistle)

1. Read each file's size and SHA-256 without downloading: `https://huggingface.co/api/models/<repo>?blobs=true` (the `lfs.sha256` of a file, and the repository's `sha`, the revision to pin). Pin every URL to that commit.
2. `crates/bloblex-speech/src/catalog.rs`: a manifest with its files (the download manager checks size and hash, and resumes), then add it to `build_catalog`. A model that needs a new recogniser also needs a `SpeechModelType` variant (`manifest.rs`) and a branch in `SpeechEngine::load` (`engine.rs`). Add a catalog test that the pins name a commit and a 64-character hash.
3. A model that is an executable: re-hash it before each load, run it with file paths only (never audio or text on the command line), delete any temporary audio at once, and log nothing it prints (`needle.rs`).
4. Live words from a model that only decodes finished clips: use `UtteranceTracker` (`utterance.rs`).
5. UI: the Settings page lists whatever `speech_models` returns, so only the preview list (`PREVIEW_SPEECH_MODELS` in `SettingsSheet.tsx`) and the mounted test need the new row. Add a line to `docs/legal/third-party-notices.md` and the model table in the companion and dictation guide.

## Add a native (Tauri) command

Register it in the `invoke_handler` in `apps/desktop/src-tauri/src/lib.rs`; use the selection-token pattern for file access (`remember_selected_path` / `take_selected_path`), cap sizes, check file signatures; wrap it in `apps/desktop/src/tauri.ts`; mirror it in `fixtureBridge.ts` and `remoteTauri.ts`; no new plugin or capability without the owner. Check it with `cargo test -p bloblex-desktop` from a short-path worktree.

## Add a settings page or section

Add the id to `SettingsPageId` and `PAGES` in `apps/desktop/src/ui/SettingsSheet.tsx`, the body (prefer its own component file), entries in `settingsIndex.ts`, and a mounted test. Use `SettingsGroup` / `SettingsRow`.

## Add a bundled font

`npm install -w apps/desktop @fontsource-variable/<name>` (or `@fontsource/<name>` with the weights used), a catalogue row and loader in `apps/desktop/src/ui/fonts.ts` (one arrow function per font, never a conditional `import()`), the daemon regex already accepts lowercase ids, a licence line in `docs/legal/third-party-notices.md`.

## Change the docs

Follow `docs/STYLE.md`. Keep protected paths in place (`docs/releases/`, `docs/remote/`, `docs/ipc-contract.md`, `docs/evidence/`, `docs/fixtures/`, `docs/qa-schema/`). Add new hand-written library pages under `docs/library/content/`, then `npm run docs:build` and `npm run docs:check`.
