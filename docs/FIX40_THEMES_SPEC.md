# FIX40 Themes lane: Frost becomes Bitbots, new looks, fonts, wallpapers, Appearance page

Lane: Codex `gpt-6-luna`, high effort. Worktree `D:\fx40t` (branch `fix40-themes`, from `main` a032f43). Its own `node_modules` and its own Cargo target (`D:\fx40t\target`).
Reviewer: the Director (Claude), who reads every line of your diff, runs the gates and checks the result in the browser preview. Expect follow-up rounds.

You have no chat history. Everything you need is here, in the repository, and in `D:\fx40t\design-reference\` (a design study the owner approved: `redesignPreview.tsx`, `redesign.css`, `paintedBots.tsx`). The reference files are for reading only; do not import them and do not copy them into `src/`.

## Rules

- Never run `git commit`, `git push`, `git reset` or `git checkout` of other branches. Leave changes in the working tree.
- Work only inside `D:\fx40t`. Do not touch `D:\Basem's\Coding\Blolblex` or `D:\fx40c`.
- Another lane (Characters) is working in parallel on bot art. Do NOT edit these files, which belong to it: `apps/desktop/src/blob/**` except `blob/bitbots.ts` and `blob/bitbots.test.ts` (those two are yours), `ui/LookEditor.tsx`, `ui/BotEditor.tsx`, `ui/blobShare.ts`, `preview/main.tsx`, the `valid_look` function and its test in `crates/bloblex-storage/src/lib.rs`, `crates/bloblex-daemon/src/proposals.rs`, `crates/bloblex-daemon/src/team.rs`.
- In `crates/bloblex-storage/src/lib.rs` you may edit only `validate_setting_value` (around line 1268) and settings tests.
- Follow `DESIGN.md` and `PRODUCT.md` where they do not conflict with this brief; this brief wins where they do. Keep comments sparse and in the style of the surrounding code. British-neutral plain English in UI copy, sentence case, no exclamation marks.
- No new Tauri plugins, no new capabilities, no CSP changes, no runtime network fetches (fonts must be bundled).

## Background (facts from a code map)

- `ui/appearance.ts:5` `ThemeStyle = 'bitbots' | 'blobots'`; `THEME_STYLES` pinned by `ui/appearance.test.ts:107`.
- `blob/bitbots.ts` is the style store: localStorage `bitbots.style`, sets `<html data-style>` and, for bitbots, `data-bitbots="on"` plus a lazy import of `ui/bitbots.css` and the Doto / DM Mono fonts. Hooks `useThemeStyle`, `useBitbots`, `bitbotsEnabled`, `setBitbotsEnabled`, `setThemeStyle`.
- `ui/bitbots.css` (929 lines, selector prefix `:root[data-bitbots="on"]`) is today's pixel look; 17 other stylesheets also key on `[data-bitbots="on"]`, and `accent.css` / `polish.css` use `:not([data-bitbots="on"])`.
- The daemon setting `appearance.style` is validated in `crates/bloblex-storage/src/lib.rs:1280` and `crates/bloblex-daemon/src/main.rs:1351`; test `appearance_settings_validate_persist_and_broadcast` near `main.rs:8735`. Backup allowlist `crates/bloblex-daemon/src/backup.rs:45-71` is a fixed-size array. Remote read allowlist `apps/desktop/src/remote/tiers.json:910-919` (`settingsAllowlist`).
- Windows apply settings in `ui/App.tsx` `applyWindowSetting` (around lines 184-216), the key list read on connect (around line 495) and `settings.changed` (around 988). Command palette entry `change-look` around line 2357.
- Appearance page: `ui/SettingsSheet.tsx:625-647` (LookPreview, LookPicker, AccentPicker, Theme select, Text size select, DensityControl). Search index `ui/settingsIndex.ts:40-44`.
- Onboarding look step: `ui/FirstRunOnboarding.tsx:48-52, 107`.
- Pixel-only UI: `ui/LaunchIntro.tsx:34, 89, 92, 154` (BitbotWelcome, PixelScan), `ui/PixelClouds.tsx`, `ui/LookPreview.tsx:5-6` (static Doto/DM Mono imports).
- File pick pattern: `apps/desktop/src-tauri/src/lib.rs:720-735` (`select_blob_import_path` + token), `757-770` (read with cap), `1044-1078` (image signature check `attachment_extension`, 10 MB cap, `app_local_data_dir`), bytes out as `tauri::ipc::Response` (see how `clipboard_image` would; pattern also in `stage_prompt_attachment`). CSP already allows `blob:` in `img-src`.
- Browser preview: `npx vite --config vite.preview.config.ts` in `apps/desktop`; `preview/fixtureBridge.ts:368-380` maps `?style=`, `?accent=`, `?density=` to fixture settings.

## What the owner wants

The app is called Bitbots. Its looks become:

| Family | Style value | Name in UI | What it is |
|---|---|---|---|
| Primary | `bitbots` | Bitbots | NEW: "Frost". Translucent panels over a wallpaper. Default look. |
| Alternative | `blobots` | Blobots | Unchanged monochrome look. |
| More looks | `legacy` | Legacy | Today's pixel look (what `bitbots` was until now). |
| More looks | `pop` | Pop | Placeholder in this round (styling comes in round 2). |
| More looks | `dot` | Dot | Placeholder in this round (styling comes in round 2). |

Users already on `bitbots` simply get Frost (no migration of stored values). The legacy localStorage key `bloblex.bitbots` `'1'` still maps to `bitbots`.

## T1. Style model

1. `ui/appearance.ts`: `ThemeStyle = 'bitbots' | 'blobots' | 'legacy' | 'pop' | 'dot'`, `THEME_STYLES` in that order, `isThemeStyle` updated. Add `THEME_LOOKS`: label, family (`primary` | `alternative` | `more`) and a one-line description for each, used by the picker and onboarding:
   - Bitbots: "Frosted glass over a wallpaper you choose."
   - Blobots: "Soft, quiet and monochrome."
   - Legacy: "The original pixel look."
   - Pop: "Retro colour, outlined cards." 
   - Dot: "Monochrome widgets, dot-matrix numbers."
2. `blob/bitbots.ts`: always set `data-style` to the style. Set `data-bitbots="on"` ONLY for `legacy` (so `bitbots.css` and the 17 sheets keep styling Legacy, unchanged). Lazy-load per style: `legacy` → `ui/bitbots.css` + Doto/DM Mono (as today); `bitbots` → `ui/themes/frost.css`; `pop` → `ui/themes/pop.css`; `dot` → `ui/themes/dot.css`. Create `pop.css` and `dot.css` as placeholders that only contain a header comment ("Round 2"). Add `useLegacyPixel()` / `legacyPixelEnabled()` (true only for `legacy`). Keep `useBitbots` / `bitbotsEnabled` as deprecated aliases of the legacy functions so other code compiles, and move every caller you own (LaunchIntro, PixelClouds) to the new names. `setBitbotsEnabled(true)` keeps meaning `bitbots`. Do not change `useThemeStyle`'s signature (the Characters lane reads it).
3. `index.html` pre-paint script: also read `bitbots.style` (and `bitbots.glass`, see T2) from localStorage and set `data-style`, `data-bitbots` (legacy only) and `data-glass` before first paint. Keep it tiny and wrapped in try/catch like the existing code.
4. Daemon validation (storage `validate_setting_value` and daemon `validate_setting`): `appearance.style` accepts the five values (error text lists them). New keys:
   - `appearance.wallpaper`: `lake` | `dusk` | `bloom` | `sand` | `custom`
   - `appearance.glass`: `solid` | `balanced` | `clear`
   - `appearance.font` and `appearance.monoFont`: empty string or `^[a-z0-9-]{1,40}$`
   Update the appearance settings test with accept and reject cases for each. Add the four new keys to the backup allowlist (fix the array length) and to `tiers.json` `settingsAllowlist`.
5. `ui/App.tsx`: read and live-apply `appearance.wallpaper`, `appearance.glass`, `appearance.font`, `appearance.monoFont` exactly like `appearance.accent` (cache in localStorage so the companion and the first paint match). Command palette `change-look` subtitle: "Bitbots, Blobots and more looks, wallpaper, fonts" and search text that includes legacy pop dot frost wallpaper glass font.

## T2. Frost (style `bitbots`)

Target: the "Frost" direction in `design-reference/redesignPreview.tsx` + `redesign.css` (search for `data-rd="frost"` and the Frost details section). The owner's words: slick, smooth, premium; **no glow, no halo, no decorative gradients**; translucent panels with a low blur that let the wallpaper show through.

1. New `ui/themes/frost.css`, every rule scoped to `:root[data-style="bitbots"]`, and none of it may reach the companion or dictation windows (they carry `.companion-surface` / `.dictation-surface` on the root; exclude them with `:not(.companion-surface):not(.dictation-surface)` on the root selector or equivalent). Override the `theme.css` tokens rather than restyling components one by one, then add component rules only where tokens are not enough.
2. Wallpaper layer: a new `ui/AppWallpaper.tsx` rendered once by the main window behind the app shell (fixed, `inset: 0`, `z-index` below everything, `pointer-events: none`, `background-size: cover; background-position: center`). Only when the style is `bitbots`. Source: the chosen built-in wallpaper, or the custom image (T3). No wallpaper element in the companion or dictation windows.
3. Built-in wallpapers: create `apps/desktop/src/assets/wallpapers/lake.svg`, `dusk.svg`, `bloom.svg`, `sand.svg` by copying the four scenes from `Wallpaper()` in `design-reference/redesignPreview.tsx` (viewBox `0 0 1600 1000`, `preserveAspectRatio="xMidYMid slice"`, standalone SVG with `xmlns`). Import them as URLs. **Default wallpaper: `lake`.**
4. Glass: `<html data-glass="solid|balanced|clear">`, **default `solid`**. Dark mode panel colour `rgb(22 23 28 / tint)`, light mode `rgb(250 250 252 / tint + .08)`. Levels: solid tint .84 blur 18px; balanced .58 / 10px; clear .36 / 6px. Implement with custom properties (`--glass-tint`, `--glass-blur`) and `backdrop-filter: blur(var(--glass-blur)) saturate(125%)`.
5. Apply the glass to the big surfaces only: sidebar, conversations / session rail, the main conversation column, the details panel, the settings sheet, dialogs, menus and popovers. Inner elements (cards, rows, inputs, message bubbles) use subtle flat fills (dark `rgb(255 255 255 / .05)` and `.07`, light `rgb(255 255 255 / .6)` and `rgb(20 22 30 / .045)`) and never their own backdrop blur, so translucency does not stack into mud. Between panels a thin gap may show the wallpaper (the reference uses 10px gaps and 20px panel radius); if that needs layout changes, keep them inside frost.css and do not change layout for other looks.
6. Tokens (from the reference): dark ink `#f4f5f7`, ink-2 `rgb(236 238 243 / .70)`, ink-3 `rgb(236 238 243 / .46)`, line `rgb(255 255 255 / .10)`, soft line `.07`, selection `rgb(255 255 255 / .10)`, default accent `#8d86f6`, user bubble `rgb(141 134 246 / .30)` flat. Light ink `#15161c`, ink-2 `rgb(21 22 28 / .66)`, ink-3 `.46`, lines `rgb(21 22 28 / .10)` and `.07`, selection `rgb(255 255 255 / .85)`, accent `#6a5cf5`, user bubble solid accent with white text. Status colours as in the reference. A user accent (`--user-accent`, see `accent.css`) must still win over the default accent.
7. Shape: rounded rectangles like the logo. In Frost, no pill or circle UI: `--radius-sm 9px`, `--radius-md 12px`, `--radius-lg 16px`, and `--radius-pill` becomes 12px (buttons, chips, composer, toggles and their knobs, segmented controls, swatches, avatar frames). Bot artwork itself is not UI and is not affected.
8. Flat: no box-shadow except one soft shadow on floating menus/popovers/dialogs (`0 10px 30px rgb(0 0 0 / .22)` dark, `rgb(40 40 60 / .14)` light). No gradients, no glows, no text shimmer.
9. Default font for Frost: Inter (bundled, see T4) unless the user picked a font.
10. Readability: body text contrast must stay at or above 4.5:1 against the solid glass level over the Lake and Dusk wallpapers; check with the existing contrast helper in `appearance.ts` against the panel colour composited over the wallpaper's darkest and lightest areas, and note the numbers in your report.

## T3. Custom wallpaper ("Your image")

1. Rust (`apps/desktop/src-tauri/src/lib.rs`), copying existing patterns: `select_wallpaper_image` (native dialog, PNG / JPEG / WebP, returns a selection token like `select_blob_import_path`), `import_wallpaper(token)` (checks the file signature with the existing helper, caps at 15 MB, copies to `app_local_data_dir/wallpapers/custom.<ext>`, deleting any older `custom.*`), `read_wallpaper()` (returns the bytes as `tauri::ipc::Response`, or an empty body when none), `clear_wallpaper()`. Register them in the invoke handler. Unit-test the pure helpers (signature check, cap, file naming).
2. `apps/desktop/src/tauri.ts` wrappers; fixture equivalents in `preview/fixtureBridge.ts` (a browser `<input type=file>` path that keeps the image in memory as an object URL) so the preview can demo it. Note: the main checkout has uncommitted edits in `tauri.ts`, `fixtureBridge.ts` and `lib.rs`; keep your additions self-contained blocks so the Director can merge them.
3. Picking an image sets `appearance.wallpaper = 'custom'`. Never put image bytes or data URLs into settings. Removing the image falls back to `lake`. Show a short error line if the file is not a supported image or is too large.

## T4. Fonts

1. Add bundled fonts with npm (`npm install -w apps/desktop ...`), latin subset only, preferring `@fontsource-variable/*` packages where they exist, otherwise `@fontsource/*` with weights 400, 500, 600, 700. Catalogue (id → family):
   - Sans: `inter` Inter, `geist` Geist, `dm-sans` DM Sans, `manrope` Manrope, `plus-jakarta-sans` Plus Jakarta Sans, `ibm-plex-sans` IBM Plex Sans, `figtree` Figtree, `sora` Sora
   - Friendly / display: `outfit` Outfit, `nunito` Nunito, `space-grotesk` Space Grotesk, `bricolage-grotesque` Bricolage Grotesque
   - Mono: `jetbrains-mono` JetBrains Mono, `geist-mono` Geist Mono, `fira-code` Fira Code, `ibm-plex-mono` IBM Plex Mono, `dm-mono` DM Mono, `space-mono` Space Mono
   - Pixel: `doto` Doto, `silkscreen` Silkscreen, `pixelify-sans` Pixelify Sans, `vt323` VT323, `press-start-2p` Press Start 2P, `jersey-10` Jersey 10
   If one package does not exist on npm, drop it and say so in the report. Add each font's licence line to `THIRD_PARTY_NOTICES.md`.
2. New `ui/fonts.ts`: the catalogue (id, label, category, CSS family, lazy `load()` that dynamically imports only that font's CSS), `applyFonts(uiId, monoId)` that loads and then sets `--font-ui` / `--font-mono` inline on `<html>` (empty id = the look's default), and per-look defaults: `bitbots` Inter + system mono; `blobots` system (today's stack); `legacy` as today (DM Mono / Doto, already handled by bitbots.css); `pop` and `dot` system for now. Store `bitbots.font` / `bitbots.monoFont` in localStorage like the accent. Only the chosen fonts may be fetched; nothing else may be added to the main bundle (also move `LookPreview.tsx`'s static Doto / DM Mono imports to lazy loading).
3. Pixel fonts can be chosen for the UI font; keep the minimum rendered size at 11px.

## T5. Appearance page (rebuild)

Replace the body of the Appearance page with a new `ui/AppearancePage.tsx` (+ `ui/appearancePage.css`) that `SettingsSheet.tsx` renders. Sections, in order, using the existing `SettingsGroup` / `SettingsRow` parts:

1. **Look.** Two large cards, Bitbots and Blobots, each with a small live preview of that look, then a "More looks" row of three smaller cards: Legacy, Pop, Dot. Selecting writes `appearance.style` (then `setThemeStyle`), like `LookPicker` does today. Rework `LookPicker.tsx` / `LookPreview.tsx` as needed; previews must use each look's own colours (static palettes are fine) and must not depend on the document's current style.
2. **Look options** (only for the selected look). Bitbots: a wallpaper grid (Lake, Dusk, Bloom, Sand, "Your image" with Choose / Replace / Remove) and a Glass control (Solid, Balanced, Clear, with a one-line hint such as "How much of the wallpaper shows through"). Other looks: one quiet line, "This look has no extra options yet."
3. **Colour.** Theme (System, Dark, Light) and Accent (existing AccentPicker).
4. **Text.** Interface font and Code font pickers: a searchable list grouped by category, each name rendered in its own font (load on hover/focus or when the list opens, not before), with a "Default for this look" option at the top; then Text size and Density (existing controls).
5. Keep the existing focus/scroll behaviour of the settings sheet. Update `settingsIndex.ts` (Look, More looks, Wallpaper, Glass, Accent, Theme, Interface font, Code font, Text size, Density) with good keywords.

## T6. Onboarding and pixel-only pieces

1. `FirstRunOnboarding.tsx` "Choose your look": the two large cards (Bitbots tagged Primary, Blobots tagged Alternative) plus a "More looks" row (Legacy, Pop, Dot). Continue stays disabled until a choice is made. Choosing Bitbots leaves wallpaper and glass at their defaults (Lake, Solid).
2. `LaunchIntro.tsx`: the pixel welcome and PixelScan only for `legacy`; every other look uses the classic greeting. `PixelClouds.tsx` only for `legacy`.

## T7. Preview support

`preview/fixtureBridge.ts`: `?style=` accepts the five values and also writes localStorage `bitbots.style` so `/` (the main app in the browser preview) shows that look; add `?wallpaper=`, `?glass=`, `?font=`, `?monoFont=`. The Director will check every screen at `http://127.0.0.1:5174/?style=bitbots` and `/?style=bitbots&theme=light`, so make sure the fixture app renders fully in Frost.

## Tests and gates

Update the tests that pin the old two-look world (at least `ui/appearance.test.ts`, `blob/bitbots.test.ts`, `ui/SettingsSheet.appearance.mounted.test.tsx`, `ui/FirstRunOnboarding.mounted.test.tsx`, `ui/LaunchIntro.mounted.test.tsx`, `ui/settingsIndex.test.ts`) and add tests for: the style store (attributes per style, legacy-only `data-bitbots`, lazy CSS per style), `fonts.ts` (unique ids, valid ids for the daemon regex, `applyFonts` sets the variables, default per look), wallpaper/glass application (attributes, defaults Lake + Solid, custom fallback), the Appearance page (switching looks, options appear for Bitbots only, font pickers write settings), onboarding (five looks offered), Rust setting validation and the wallpaper helpers.

Run, from `D:\fx40t`, and paste the tail of each result in your report:

- `npm run typecheck`
- `npm test`
- `cd apps/desktop && npx vite build` (bundle builds; report the main chunk size before/after if you can)
- `$env:CARGO_TARGET_DIR='D:\fx40t\target'; cargo test -p bloblex-storage -p bloblex-daemon`
- `$env:CARGO_TARGET_DIR='D:\fx40t\target'; cargo check -p bloblex-desktop`

All must pass. Do not weaken or delete a test to make it pass; if a test pins old behaviour the owner changed, update it to the new behaviour and say so.

## Report (your final message)

1. What you did for T1 to T7, item by item, with file paths.
2. Files changed and created.
3. Gate results (tails).
4. Contrast numbers for Frost (T2.10).
5. Anything you could not do, anything you were unsure about, and every decision you made that this brief did not specify.
