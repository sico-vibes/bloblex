# FIX40 report: Bitbots looks, bot art and look orbs

> **What this is:** Report for FIX40: Bitbots looks, bot art and look orbs.
> **Status:** historical; a record as of 19 October 2026
> **Last updated:** 2026-10-19

Original status line, kept as written: landed on `main` at `e4cf5b3` (19 October 2026). Not tagged or released; the last release is still `v0.1.0-beta.34`. Evidence is unit and mounted tests, the Director's browser-preview checks and the gates listed below. No native-window check, live provider session or installer test is recorded for this wave.

Specs: [docs/history/fix-40/themes-spec.md](themes-spec.md) (round 1, looks and fonts), [docs/history/fix-40/characters-spec.md](characters-spec.md) (round 1, bot art), [docs/history/fix-40/round2-spec.md](round2-spec.md) (Pop and Dot), [docs/history/fix-40/orbs-spec.md](orbs-spec.md) (look orbs). Design rules: [DESIGN.md](../../../DESIGN.md#fix40-looks-and-bot-art-19-october-2026). Pipeline: [AGENTS.md](../../../AGENTS.md), 19 October amendment.

## What the owner asked for

- Replace the primary pixel look. Frost becomes the primary look, named Bitbots.
- Keep the old pixel look as Legacy.
- Add Pop and Dot as new looks. Blobots stays the alternative look.
- Onboarding offers Bitbots and Blobots, with Legacy, Pop and Dot under "More looks".
- Users already on `bitbots` get Frost automatically.
- Each bot chooses its own art style in its editor.
- Settings > Appearance shows one orb per look instead of a mini screenshot.
- Owner rules: no glow, no halo and no decorative gradients. New looks use rounded rectangles like the logo, never pill or circle UI (bot artwork excepted).

## What landed

### Looks

| Look | `appearance.style` | Family | Description in the app |
|---|---|---|---|
| Bitbots (Frost) | `bitbots` | Primary | Frosted glass over a wallpaper you choose. |
| Blobots | `blobots` | Alternative | Soft, quiet and monochrome. Unchanged. |
| Legacy | `legacy` | More looks | The original pixel look. |
| Pop | `pop` | More looks | Retro colour, outlined cards. |
| Dot | `dot` | More looks | Monochrome widgets, dot-matrix numbers. |

`data-bitbots="on"` now means Legacy only. Legacy still loads `ui/bitbots.css`, and the pixel welcome, PixelScan and PixelClouds show only for Legacy.

### Frost (Bitbots)

- Translucent flat panels over an in-app wallpaper. Glass covers the large surfaces: sidebar, conversation lists, conversation column, details panel, settings sheet, dialogs, menus and popovers. Cards, rows, inputs and bubbles use flat fills and no backdrop blur of their own.
- Wallpapers: Lake (default), Dusk, Bloom, Sand and "Your image". The four built-in wallpapers are SVG files in `apps/desktop/src/assets/wallpapers/`.
- Custom image: PNG, JPEG or WebP, checked by file signature, 15 MB cap. The file is stored as `custom.<ext>` in `app_local_data_dir/wallpapers`. Image bytes never go into settings or a data URL. Remove falls back to Lake. An unsupported or oversized file shows a short error.
- Glass levels: Solid (default), Balanced and Clear. As built in `ui/themes/frost.css`, Solid is tint .93 with a 24 px blur, Balanced .58 with 10 px and Clear .36 with 6 px. The Themes brief gave Solid as .84 and 18 px. The Director changed Solid to .93 and 24 px in review round 1 of the Themes lane: at .84 the bright band of the Lake wallpaper showed through all three panels as a light stripe, and the owner asked for a solid default.
- Radii 9, 12 and 16 px. The pill token becomes 12 px.
- Default interface font Inter. A font the user picks wins.
- Wallpaper and glass never reach the companion or dictation windows.

### Pop and Dot

- Pop: cream paper with a dot grid in light, ink and pastel fills, outlined panels and cards, hard offset shadows without blur, sticker-style chips. DM Sans for body text; Bricolage Grotesque for headings and the brand name.
- Dot: monochrome with one red accent. Selection inverts to an ink background. Geist and Geist Mono for text, Doto for large numbers. Meters and bars are drawn as dot matrices.
- Both use rounded rectangles only.

### Blobots and Legacy

- Blobots keeps its monochrome look.
- Legacy keeps the old pixel look and its stylesheet fonts (Doto and DM Mono, loaded only while Legacy is active).

### Onboarding and launch

- "Choose your look": Bitbots and Blobots as large cards tagged Primary and Alternative, then a "More looks" row with Legacy, Pop and Dot. Continue stays disabled until a choice is made. Choosing Bitbots leaves Lake and Solid at their defaults.
- Launch greeting: Legacy keeps the pixel welcome. The glossy blob keeps its classic greeting. Every other look shows the bot in the art it wears.

### Fonts

- 24 bundled fonts in four categories: sans, friendly and display, mono, and pixel. Latin subsets from `@fontsource` packages. Each font loads only when chosen or when the font list is on screen, and nothing enters the main bundle for an unchosen font.
- Per-look defaults: Bitbots Inter; Pop DM Sans; Dot Geist and Geist Mono. Blobots and Legacy keep their stylesheet fonts.
- Settings `appearance.font` (interface) and `appearance.monoFont` (code). The catalogue and defaults are in `apps/desktop/src/ui/fonts.ts`.

### Settings > Appearance

Rebuilt in `apps/desktop/src/ui/AppearancePage.tsx`, in this order:

1. Look: two large cards (Bitbots, Blobots) and a "More looks" row (Legacy, Pop, Dot), each with an orb.
2. Look options: Bitbots shows wallpaper and glass. Other looks show "This look has no extra options yet."
3. Colour: Theme and Accent.
4. Text: interface font, code font, text size and density.

The settings search index and the command palette `change-look` entry were updated.

### Settings and daemon

- `appearance.style` accepts `bitbots`, `blobots`, `legacy`, `pop` and `dot`.
- New keys, each validated by the daemon and listed in the backup allowlist and the remote read allowlist (`settingsAllowlist` in `apps/desktop/src/remote/tiers.json`): `appearance.wallpaper`, `appearance.glass`, `appearance.font`, `appearance.monoFont`.

### Bot art

| `art` value | Name in the editor | Renderer |
|---|---|---|
| `robot` | 3D robot | Existing `BitbotCanvas`, heavy, unchanged. |
| `robot-flat` | Flat robot | New inline SVG. |
| `robot-pop` | Pop robot | New inline SVG. |
| `robot-dot` | Dot robot | New inline SVG. Antenna above the head. |
| `blob` | Glossy blob | Existing `ClassicBlobCanvas`, unchanged. |
| `painted` | Hand-painted | New inline SVG with twelve shapes: Classic, Cube, Star, Flower, Pear, Peanut, Ghost, Bunny, Kitty, UFO, Box bot, Tile. The shape is `look.paint`. |

- A bot without an `art` follows the app look: Bitbots gives Flat robot, Blobots gives Glossy blob, Legacy gives 3D robot, Pop gives Pop robot, Dot gives Dot robot.
- Each bot picks its art in its editor (a Style control with "Automatic"). Existing bots get a `paint` derived from their blob shape (circle to classic, squircle to cube, droplet to pear, cloud to flower, pebble to ghost, capsule to peanut, triangle to star, hexagon to tile).
- The new arts are inline SVG and CSS keyframes only: no canvas, no `requestAnimationFrame`, no per-instance window listeners. Under `prefers-reduced-motion: reduce` the animations stop and a still pose shows. SVG ids are unique per instance.
- Robot arts share one eye vocabulary: idle pill eyes that blink; thinking with smaller eyes glancing to one side and three dots in the visor; typing with stepped eye shapes and a pixel row that types across the visor; waiting with raised amber eyes (red on Dot); happy as arcs; error as red X eyes; sleeping and offline as flat lines (offline dimmed).
- Dot robot's typing is a pixel wave across the bottom row of its 7 by 5 dot screen, not rolling eyes.
- Hand-painted bots do not move; only their eyes animate. Their status appears in a corner badge borrowed from the classic blob, with the classic blob's colours. Mini avatars show a plain dot.
- `valid_look` in `crates/bloblex-storage/src/lib.rs` accepts `art` and `paint` and rejects other values. The Manager tool description in `team.rs` lists them.
- The character sheet at `/preview.html` takes `?art=`, and shows every art in every mood at 22, 44 and 96 px.

### Look orbs

- One static, decorative orb per look in the Appearance cards and the onboarding picker, in place of the mini window: lake glass (Bitbots), matte stone (Blobots), pixel dither (Legacy), striped sticker (Pop) and dot matrix (Dot).
- Orbs have no window chrome, avatars, text or animation, and they do not read the app's tokens, so they look the same in every look. About 72 px for the two primary cards and 52 px for the More looks cards.
- Each orb carries `data-look` for tests.

### Other commits in the wave

- `0f3e421` carries the owner's in-progress work: a coding-agent CLI update notice, clipboard image paste and links in the companion. An OpenCode `opencode-go/deepseek-v4.1-flash` lane, working in a scratch worktree, added the refusing remote stubs to `remoteTauri.ts` and updated the SafeMarkdown test selector. The Director reviewed those two files, copied them into the main checkout and committed.
- `28da243` fixes a compile error on stable Rust (see environment findings).

## Pipeline and who did what

| Step | Who | Work |
|---|---|---|
| Codebase map | Claude Haiku 5.5 | Mapped the code for the briefs. |
| Briefs | Director (Claude) | Wrote the four specs and the round 2 brief. Reviewed every diff, checked every screen in the browser preview, sent fixes back, merged, ran the gates and committed. |
| Round 1, looks | Codex `gpt-6-luna` (high), worktree `D:\fx40t` | Style model, Frost, wallpapers, fonts, Appearance page, onboarding. |
| Round 1, bot art | OpenCode `opencode-go/deepseek-v4.1-flash` (high), worktree `D:\fx40c` | Bot art styles, editor Style control, character sheet, `art` and `paint` in the daemon. |
| Round 2, Dot | Codex `gpt-6-luna` (high), worktree `D:\fx40d` | Dot look, launch greeting in each bot's art, Pop and Dot fonts. |
| Round 2, Pop | OpenCode lane first; reassigned to Codex (`fix40-pop` merged) | The OpenCode Pop lane stopped twice during exploration (exit code 9). Pop was reassigned to Codex. |
| Round 2, orbs | Codex `gpt-6-luna` (high), worktree `D:\fx40o` | Look orbs on the Appearance cards and onboarding. |

Lanes never ran `git commit`. The Director merged each lane branch; round 1 went through the `fix40` integration branch, and the merges are on `main`.

## Review rounds in brief

- **Round 1.** The two lanes wrote their parts in separate worktrees, each with its own Cargo target. The Director reviewed each diff, checked the screens in the browser preview and sent back follow-ups. The lane branches were merged into `fix40` (`e653e05`, `378a7a7`), then into `main` (`f957529`). `9022623` changed a test that checked the new appearance keys after the broadcast assertions.
- **Owner's work.** `0f3e421` landed between the rounds. It carries the owner's in-progress changes together with the remote stubs and test selector described in the commits section, which an OpenCode lane wrote and the Director reviewed before committing.
- **Round 2.** Dot (`30b8db5`, merged `7e1ef43`), Pop (`173efc9`, merged `adaaf39`) and the orbs (`b9e47a8`, merged `e4cf5b3`). Each was checked by the Director in the browser preview before merging.

## Environment findings

- **Stable Rust.** `main` did not compile on stable Rust 1.94. Commit `e47412a` (clippy clean-up in the adapters) used `AtomicU64::try_update`, which is unstable. `28da243` replaces it with `fetch_update` in `bloblex-adapter-claude`.
- **Apostrophe in the path.** The Windows resource compiler cannot build the desktop crate from a path that contains an apostrophe, such as the main checkout `D:\Basem's\...`. Desktop crate checks and builds must run from a short-path worktree.
- **Codex sandbox.** The Codex Windows sandbox blocks network access, and Vite cannot write temp files through a `node_modules` junction. The Director installed dependencies and ran the full gates. The orbs brief also notes that Vitest may need `--configLoader runner` in a sandbox.

## Gates on `main` after FIX40 (`e4cf5b3`)

- `npm run typecheck`: clean.
- Vitest: 178 files, 1,341 tests passed.
- `vite build`: passed.
- `cargo test -p bloblex-daemon`: 456 passed.
- `cargo test -p bloblex-storage`: 119 passed.
- `cargo test -p bloblex-desktop` (library): 63 passed.

No other gate run is recorded for this wave.

## Follow-ups not done

1. Done. The Pop look's "This look has no extra options yet." line had no left padding. `p.appearance-quiet` in `apps/desktop/src/ui/appearancePage.css` now has margin 0 and padding 12px 16px, the same as `.settings-row`. Checked in the browser preview in Pop; the computed padding is the same in Blobots, Legacy, Dot and Pop.
2. Done. `SafeMarkdown.tsx` has one `SafeLink` component, used by `SafeMarkdown` and `SafeMarkdownInline`. Every click (with or without modifiers) and every `auxclick` has its default prevented. A primary click or a middle click calls the safe opener; a middle `mousedown` is prevented, and links are not draggable. `target="_blank"` is kept, because every activation is prevented. `openSafeLink.ts` no longer falls back to `window.open` when the native opener fails in the desktop app; `window.open` remains only for the browser preview (`isNative()` false). New mounted tests cover middle click, right `auxclick`, Ctrl+click and Cmd+click in both renderers, and a new `openSafeLink.test.ts` covers the removed fallback. Gates: typecheck clean; Vitest 179 files, 1,347 tests passed. Not checked in the native window.
3. Decided, then built in FIX41. On 19 October 2026 the owner decided that Frost, Pop and Dot should style the companion and dictation windows. The brief is `docs/history/fix-41/companion-looks-brief.md`. It was implemented in FIX41 on branch `claude/priceless-shamir-29e003`; see [docs/history/fix-41/companion-looks-report.md](../fix-41/companion-looks-report.md).
4. The remote web app still defaults to the robot art.
5. The FIX39 "eight bot shapes" rule now applies to the glossy blob only (noted in DESIGN.md).
6. The four FIX40 spec files (`docs/history/fix-40/themes-spec.md`, `docs/history/fix-40/characters-spec.md`, `docs/history/fix-40/round2-spec.md`, `docs/history/fix-40/orbs-spec.md`) are untracked in the working tree and need committing with this report.
7. The lane worktrees (`D:\fx40t`, `D:\fx40c`, `D:\fx40p`, `D:\fx40d`, `D:\fx40o`) and their branches should be removed after the next release, as AGENTS.md (14 October amendment) requires.

## Not verified

- Native windows: the wave has browser-preview and unit-test evidence only. Wallpaper import through the native file dialog, font loading in the native window and the companion's dark styling are not checked natively.
- Real provider sessions with the new bot arts, and the Manager with a live model.
- Frost contrast figures. The Themes brief asked for them (T2.10), and no record of them is in the wave's files.
- Installer, updater round trip and clean-machine install. Nothing has been released.

## Commits

From `git log` on `main`, newest first:

| Commit | Subject | Role |
|---|---|---|
| `e4cf5b3` | Merge fix40-orbs: FIX40 round 2 | Orbs merge |
| `adaaf39` | Merge fix40-pop: FIX40 round 2 | Pop merge |
| `b9e47a8` | feat: look orbs instead of mini screenshots on the look cards | Orbs |
| `7e1ef43` | Merge fix40-dot: FIX40 round 2 | Dot merge |
| `173efc9` | feat: FIX40 Pop look | Pop |
| `30b8db5` | feat: FIX40 Dot look, launch greeting in each bot's art, Pop and Dot fonts | Dot, greeting |
| `f957529` | Merge FIX40 round 1: Frost, more looks, wallpapers, fonts and bot art styles | Round 1 merge |
| `0f3e421` | feat: coding-agent CLI update notice, clipboard image paste, links in the companion | Owner's in-progress work, plus remote stubs and a test selector from an OpenCode lane |
| `e653e05` | Merge branch 'fix40-themes' into fix40 | Looks merge |
| `9022623` | test: check the new appearance keys after the broadcast assertions | Test fix |
| `378a7a7` | Merge branch 'fix40-chars' into fix40 | Bot art merge |
| `4da2bb7` | feat: FIX40 Frost becomes Bitbots, more looks, wallpapers and fonts | Looks, Frost, fonts |
| `84fa3af` | feat: FIX40 bot art styles (flat, pop and dot robots, hand-painted blobs) | Bot art |
| `28da243` | fix: use stable fetch_update for the Claude retry counter | Stable Rust fix |
