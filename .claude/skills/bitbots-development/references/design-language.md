# Design language

Last reviewed: 2026-10-19. Source of truth for rules: `docs/design/design-system.md` and `docs/library/content/reference/theme-system.md`. When the owner changes a visual rule, edit the rule here in place and in `docs/design/design-system.md`.

## Product feel

A calm chat app for developers moving between coding-agent sessions. The bots supply warmth; the chrome stays quiet. Say each thing once per screen (a bot's name, state and model appear in one place). Status colour only when something is happening. In Blobots chrome that means amber for working or approval, red for failure and green only for added lines (`docs/design/design-system.md`); Frost, Pop, Dot and the bot arts' status badges follow their own look's palette. One animated bot per place.

## The five looks

`appearance.style` → `<html data-style>`. Families: **Bitbots** (primary) and **Blobots** (alternative), with **Legacy**, **Pop** and **Dot** under "More looks".

| Look (value) | Feel | Default bot art | Default fonts |
|---|---|---|---|
| Bitbots (`bitbots`) = Frost | Flat translucent panels over a wallpaper (Lake default; Dusk, Bloom, Sand, the user's image), 10 px gaps between floating panels, 20 px panel radius, hairline borders. Glass: Solid (tint .93, blur 24 px, default), Balanced (.58/10), Clear (.36/6). | Flat robot | Inter + system mono |
| Blobots (`blobots`) | Monochrome dark or light, flush panels | Glossy blob | Segoe UI stack |
| Legacy (`legacy`) | The original pixel look (`data-bitbots="on"`, `ui/bitbots.css`): square corners, dotted borders, hard shadows, Doto and DM Mono | 3D robot | DM Mono / Doto (from its stylesheet) |
| Pop (`pop`) | Retro colour, not pixel: cream paper with a dot grid, 2px ink outlines, hard offset shadows (4/3/2/5 px), pastel fills (butter, mint, lilac, coral, sky, peach), butter selection, coral accent with ink text | Pop robot | DM Sans + Bricolage Grotesque headings |
| Dot (`dot`) | Monochrome widgets, one red (`#ff4b2b`), dot-matrix meters and numbers (Doto for figures only), inverted selection, mono uppercase labels | Dot robot | Geist + Geist Mono |

All five support dark and light, and Frost, Pop and Dot also style the companion and dictation windows (Legacy and Blobots keep theirs).

## Rules that apply to every look added after Legacy

- **Shape:** rounded rectangles like the logo (`--radius-sm 9px`, `--radius-md 12px`, `--radius-lg 16px`, `--radius-pill 12px`, panels about 20 to 22 px). No pill or circle controls or surfaces: buttons, chips, composer, toggles and knobs, segmented controls, swatches and avatar frames are rounded rectangles. Exceptions: the circular Manager badge and locked-bot badge on avatars (`docs/design/design-system.md`), and the look orbs (the owner asked for orbs). Bot artwork is not UI and keeps its own shape.
- **Flat:** no glow, no halo, no decorative gradients, no text shimmer (the owner's words for Frost: "slick, smooth, premium; no glow"). Shadows only where the look's language has them (Pop's hard offsets) or one soft shadow on floating menus and dialogs.
- **Readable selection:** in looks that fill a selected row (Dot inverts, Pop uses butter), every descendant of the selected element takes the selected text colour (names, role chips, times, status lines, icons). This was missed twice (FIX40 Dot and Pop); test it in dark and light.
- **Contrast:** body text at least 4.5:1 against the surface it sits on, including over wallpapers at the default glass level.
- **Keep focus rings and selected states visible.** Never blanket-remove `box-shadow` (the focus ring is a box shadow).
- **User accent wins:** `--user-accent` (from `appearance.accent`) overrides each look's default accent.
- **Scope everything** to the look: `:root[data-style="<look>"]:not(.companion-surface):not(.dictation-surface)` for the main window, and separate `.companion-surface` / `.dictation-surface` sections for those windows.

## Tokens

All colours, sizes and radii come from `apps/desktop/src/ui/theme.css` tokens (`--surface-*`, `--text-1..3`, `--line*`, `--status-*`, `--radius-*`, `--shadow-pop`, `--focus-ring`, `--font-ui`, `--font-mono`, `--fs-*`, companion tokens). A look overrides tokens first and adds component rules only where tokens are not enough. Component stylesheets use tokens, not literals.

## Bot art

Per bot, in the bot editor's Style control (`look.art`; Automatic = follow the look): Robots: 3D robot (`robot`, canvas, heavy: use only when chosen), Flat robot (`robot-flat`), Pop robot (`robot-pop`), Dot robot (`robot-dot`, 7×5 dot screen with an antenna; typing = stepped eye patterns + a pixel wave); Blobs: Glossy blob (`blob`, canvas), Hand-painted (`painted`, twelve shapes via `look.paint`: classic, cube, star, flower, pear, peanut, ghost, bunny, kitty, ufo, boxbot, tile). The light arts are pure SVG + CSS (no canvas, no rAF, no listeners), stop animating under reduced motion, and change the eyes rather than moving the body. Hand-painted bots never move; status shows in a top-left corner badge (dots for thinking/typing, "!" for waiting, green/red dots, "z" sleeping; plain dot on mini avatars). Manager badge: white star on orange, the only star icon in the app.

## Copy

Plain, short, sentence case, British-neutral, no exclamation marks, no marketing words. The entity is a "bot" in every look. Say what happens, not how clever it is.
