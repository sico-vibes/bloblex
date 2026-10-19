# Recipes for recurring changes

Last reviewed: 2026-10-19. Each recipe lists every place that must change together; missing one is the usual cause of a broken gate or a feature that works only in the preview. Update a recipe when you find a step it lacks.

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

1. `apps/desktop/src/ui/appearance.ts`: add the value to `ThemeStyle`, `THEME_STYLES`, `THEME_LOOKS` (label, family, one-line description).
2. Daemon validation of `appearance.style` (both layers, see "Add a settings key").
3. `apps/desktop/src/ui/themes/<look>.css`, scoped `:root[data-style="<look>"]:not(.companion-surface):not(.dictation-surface)` plus companion and dictation sections; override tokens first; follow `references/design-language.md`. Import it **statically** in `apps/desktop/src/main.tsx` (never a dynamic `import()`, see lesson FIX42).
4. Default bot art: `defaultArtForStyle` in `apps/desktop/src/blob/art/art.ts`. Default fonts: `FONT_DEFAULTS` in `apps/desktop/src/ui/fonts.ts`.
5. Look orb: `apps/desktop/src/ui/LookOrb.tsx` + `lookOrb.css` (orbs are theme-independent).
6. Launch greeting rules in `apps/desktop/src/ui/LaunchIntro.tsx` if the look needs special handling.
7. Tests: `ui/appearance.test.ts`, `ui/appearance.mounted.test.ts`, `blob/bitbots.test.ts`, `ui/SettingsSheet.appearance.mounted.test.tsx`, `ui/FirstRunOnboarding.mounted.test.tsx`, and the static-import guard `ui/themeBuild.test.ts` (add the new stylesheet to its list).
8. Check every screen in the preview in dark and light, and the production build (`npm run build`) or installed app.

## Add a bot art, or a hand-painted shape

- Art: add the value to `BotArt`, `BOT_ARTS`, `ART_LABELS` and the robot or blob group in `apps/desktop/src/blob/art/art.ts`; a renderer in `blob/art/` (pure SVG + CSS, `ArtFrame`, `useArtMood`, `artAria`, unique ids via `useId`, reduced-motion still pose); a case in `BlobCanvas`'s switch; the daemon's `valid_look` `ARTS` list (`crates/bloblex-storage/src/lib.rs`) and its test; the Manager tool schema description in `crates/bloblex-daemon/src/team.rs`; the `LookEditor` Style control picks it up from the groups; tests in `blob/art/*.test.ts(x)`; the character sheet `/preview.html?art=<value>`.
- Painted shape: add it to `PaintedShape`, `PAINTED_SHAPES`, `PAINTED_LABELS` (`art.ts`), a body/eye/light/badge entry in `PaintedBlob.tsx` `SHAPES`, the daemon `PAINTS` list in `valid_look` and its test. Check it at 16 to 22 px.

## Add a daemon RPC or event

1. Handler in `crates/bloblex-daemon/src/main.rs` `dispatch()` (or its module), with tests.
2. A row in `apps/desktop/src/remote/tiers.json` (the parity tests `remoteTiers.parity.test.ts` fail without one); decide its tier (`never` for anything that changes settings, agents, files or the gateway).
3. The UI call in `apps/desktop/src/tauri.ts`, mirrored in `apps/desktop/src/preview/fixtureBridge.ts` (fixture behaviour) and `apps/desktop/src/remote/remoteTauri.ts` (a refusing stub if native-only); the parity tests check all three export the same names.
4. Document it in `docs/ipc-contract.md`.

## Add a native (Tauri) command

Register it in the `invoke_handler` in `apps/desktop/src-tauri/src/lib.rs`; use the selection-token pattern for file access (`remember_selected_path` / `take_selected_path`), cap sizes, check file signatures; wrap it in `apps/desktop/src/tauri.ts`; mirror it in `fixtureBridge.ts` and `remoteTauri.ts`; no new plugin or capability without the owner. Check it with `cargo test -p bloblex-desktop` from a short-path worktree.

## Add a settings page or section

Add the id to `SettingsPageId` and `PAGES` in `apps/desktop/src/ui/SettingsSheet.tsx`, the body (prefer its own component file), entries in `settingsIndex.ts`, and a mounted test. Use `SettingsGroup` / `SettingsRow`.

## Add a bundled font

`npm install -w apps/desktop @fontsource-variable/<name>` (or `@fontsource/<name>` with the weights used), a catalogue row and loader in `apps/desktop/src/ui/fonts.ts` (one arrow function per font, never a conditional `import()`), the daemon regex already accepts lowercase ids, a licence line in `docs/legal/third-party-notices.md`.

## Change the docs

Follow `docs/STYLE.md`. Keep protected paths in place (`docs/releases/`, `docs/remote/`, `docs/ipc-contract.md`, `docs/evidence/`, `docs/fixtures/`, `docs/qa-schema/`). Add new hand-written library pages under `docs/library/content/`, then `npm run docs:build` and `npm run docs:check`.
