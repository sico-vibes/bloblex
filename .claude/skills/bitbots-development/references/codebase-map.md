# Codebase map

Last reviewed: 2026-10-19. When you add or move something listed here, update this file.

## Repository root

- `AGENTS.md` (how the project is run; read the top amendments), `docs/design/design-system.md` (design rules), `docs/design/product.md`, `README.md`, `docs/operations/session-handoff.md` (latest state at the top), `docs/legal/third-party-notices.md` (add a line for every new bundled font or library).
- `apps/desktop/`: the desktop app (npm workspace `@bloblex/desktop`).
- `crates/`: Rust workspace (`Cargo.toml` `[workspace.package].version` is the app version, with `package.json`, `apps/desktop/package.json` and `apps/desktop/src-tauri/tauri.conf.json`).
- `scripts/`: `release-windows.ps1` (signed release), `bundle-windows.ps1` (`npm run desktop:bundle`), `stage-daemon.mjs`, `dev-windows.ps1`, `docs-library.mjs` (`npm run docs:build|docs:check|docs:serve`).
- `docs/`: see "Docs" below.
- `assets/icon/`: the logo and app icons.

## UI: `apps/desktop/src`

- Entry: `main.tsx` imports every stylesheet, including all look stylesheets (`ui/bitbots.css`, `ui/themes/frost.css`, `pop.css`, `dot.css`) as static imports; never load a look stylesheet with a dynamic `import()` (lesson FIX42; `ui/themeBuild.test.ts` enforces it). `blob/bitbots.ts` only lazy-loads Legacy's fonts. `index.html` has a tiny pre-paint script that sets `data-theme`, `data-style`, `data-glass` and friends from localStorage.
- `ui/App.tsx` (~3,900 lines): the main shell, window settings (`applyWindowSetting`), command palette, routing between pages, companion and dictation modes (`?companion=1`, `?dictation=1`).
- Settings: `ui/SettingsSheet.tsx` (pages list `PAGES`, page bodies), `ui/AppearancePage.tsx` (looks with `LookOrb`, wallpaper, glass, colour, fonts, text size, density), `ui/settingsIndex.ts` (settings search; add an entry for every new setting), `ui/SettingsParts.tsx` (`SettingsGroup`, `SettingsRow`, `HelpTip`), `ui/SegmentedControl.tsx` (radio-group segmented control; use it, do not hand-roll one).
- Looks: `ui/appearance.ts` (`ThemeStyle`, `THEME_STYLES`, `THEME_LOOKS`, accent helpers), `blob/bitbots.ts` (style store, `useThemeStyle`, sets `data-style`, `data-bitbots` only for Legacy), `ui/theme.css` (base tokens, dark and light), `ui/bitbots.css` (Legacy, scoped `[data-bitbots="on"]`), `ui/themes/{frost,pop,dot}.css` (scoped `:root[data-style="<look>"]`, with separate companion/dictation sections), `ui/accent.css`, `ui/density.css`, `ui/polish.css`, `ui/fonts.ts` (24-font catalogue, `applyFonts`, per-look defaults), `ui/AppWallpaper.tsx` (Frost wallpaper layer), `ui/LookOrb.tsx`, `ui/LookPicker.tsx` (onboarding cards), `ui/LookPreview.tsx`.
- Bots and art: `blob/BlobCanvas.tsx` (the one avatar component; dispatches on art), `blob/art/art.ts` (`BotArt`, `defaultArtForStyle`, `resolveArt`, `resolvePaint`, the 18→8 mood map), `blob/art/{FlatRobot,PopRobot,DotRobot,PaintedBlob}.tsx` + `art.css` (light SVG arts), `blob/BitbotCanvas.tsx` + `vendor/robot-heads/` (heavy 3D robot, canvas), `blob/blobEngine.ts` (glossy blob, canvas; also the status-badge model the painted art copies), `blob/look/` (`BlobLook`: `shape`, `seed`, `traits`, `bot`, `art`, `paint`; `normalizeLook`, `agentLook`, `shuffleLook`), `blob/characterState.ts` (the 18 `BlobMood`s), `ui/companionStatus.ts` (mood from session state), `ui/LookEditor.tsx` (bot editor: Style picker, shape grids, colour), `ui/BotEditor.tsx` (3D robot outline and colours), `ui/blobShare.ts` (bot import/export).
- Conversations and team: `ui/TeamSidebar.tsx` (bot rows), `ui/ComposerControls.tsx`, `ui/SafeMarkdown.tsx` + `ui/openSafeLink.ts` (links only through the safe opener), `ui/ApprovalCard.tsx`, `ui/ManagerPage.tsx`, `ui/WorkingBotsPanel.tsx`, `ui/CompanionTeam.tsx`, `ui/CompanionPanels.tsx`.
- Bridges: `tauri.ts` (every native and daemon call the UI makes), `desktopIntegrations.ts`, `transport/nativeBridge.ts`, `transport/platform.ts`.
- Remote PWA: `remote/` (`RemoteApp.tsx`, `remoteTauri.ts` must export every name `tauri.ts` exports, as refusing stubs for native-only functions; `remoteTiers.ts` + `tiers.json` policy).
- Preview harness: `preview/` (`fixtureBridge.ts` replaces `tauri.ts` in the browser preview and must mirror its exports; `main.tsx` = character sheet `/preview.html`; `gallery.tsx`, `launchPreview.tsx`, `dictationPreview.tsx`, `polishPreview.tsx`).
- Release notes in the app: `ui/WhatsNew.tsx` imports `docs/releases/*.md`.

## Native shell: `apps/desktop/src-tauri`

`src/lib.rs` (commands, windows, file-pick tokens, wallpaper import/read/clear, daemon launch), `src/clipboard.rs`, `src/harness_updates.rs` (CLI update notice: fixed updater commands only), `src/updates.rs`, `src/speech.rs`, `src/power.rs`, `src/migrate.rs`; `tauri.conf.json` (CSP, windows, updater public key, bundle); `capabilities/`; `binaries/` (staged sidecars, generated, not committed); `gen/schemas/` (generated; revert line-ending-only churn).

## Daemon and crates

- `crates/bloblex-daemon/src/`: `main.rs` (`dispatch()`, settings validation `validate_setting`, tests), `team.rs` (Manager tools and schemas), `proposals.rs`, `queue.rs`, `retry.rs` (watchdog/continuation), `automations.rs`, `tasks.rs` (durable board tasks: `task.*` RPCs, owner dispatch/queue, turn-end mapping), `memory.rs`, `skills.rs`, `backup.rs` (`SETTING_ALLOWLIST`, a fixed-size array), `diagnostics.rs`, `worktree.rs`, `quota*.rs`, `catalog.rs`, `remote/` (gateway, Tailscale, Native, pairing).
- `crates/bloblex-storage/src/lib.rs`: SQLite schema and migrations, `validate_setting_value`, `validate_agent_fields`, `valid_look`; the task ledger (`ensure_tasks_schema`, `task_*` reads and writes) with append-only `task_run_events`.
- Others: `bloblex-adapter-{claude,codex,acp,opencode}`, `bloblex-agent-core`, `bloblex-runtime`, `bloblex-process`, `bloblex-protocol`, `bloblex-usage`, `bloblex-budget` (retired; `budget.*` returns unsupported), `bloblex-security`, `bloblex-speech` (on-device and opt-in cloud dictation), `bloblex-wsl`.

## Docs

`docs/README.md` (index), `docs/STYLE.md` (doc style), `docs/reference/`, `docs/guides/`, `docs/design/`, `docs/plans/`, `docs/operations/` (release checklist, implementation status, updater), `docs/audits/`, `docs/history/fix-NN/` (every wave's briefs and reports), `docs/library/` (the library source: `content/` is hand-written; `catalog.json` and `sources/` are generated by `scripts/docs-library.mjs`) and `docs/DOCUMENTATION.html` (the generated viewer). Protected paths (code or tests depend on them): `docs/releases/`, `docs/remote/`, `docs/ipc-contract.md`, `docs/evidence/`, `docs/fixtures/`, `docs/qa-schema/`.
