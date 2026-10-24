# Design language

Last reviewed: 2026-10-22. Source of truth for rules: `docs/design/design-system.md` and `docs/library/content/reference/theme-system.md`. When the owner changes a visual rule, edit the rule here in place and in `docs/design/design-system.md`.

## Product feel

A calm chat app for developers moving between coding-agent sessions. The bots supply warmth; the chrome stays quiet. Say each thing once per screen (a bot's name, state and model appear in one place). Status colour only when something is happening. In Blobots chrome that means amber for working or approval, red for failure and green only for added lines (`docs/design/design-system.md`); Frost and the bot arts' status badges follow their own palettes. One animated bot per place.

## The three looks

`appearance.style` → `<html data-style>`. Settings and onboarding use one orb row, ordered **Haze, Frost, Stone** (owner, 24 October 2026: Haze is the primary look and the default for a new install; the Bitbots look is shown as **Frost** and Blobots as **Stone**, while the stored ids stay `bitbots` and `blobots`, so no migration). The orbs are one family: a dark shaded sphere crossed by one horizontal ribbon (Haze a warm wave band, Frost a frosted icy pane, Stone a soft grey band). Names appear on hover/focus, with no card subtext or visible family grouping.

| Look (value) | Feel | Default bot art | Default fonts |
|---|---|---|---|
| Haze (`haze`) | Smoky glass over a misty backdrop, one cohesive shell (flush panels split by hairlines, no floating cards, no backdrop blur: the backdrop is static gradients with the glass tint baked in). One-line sidebar rows: mark + name + time. | No mascot: the runtime logo (`look.icon` `logo`, `logo-tint`, `logo-mono`) or a 12×12 pixel icon (`px-*`), drawn by `blob/haze/HazeMark.tsx` | Inter + system mono |
| Frost (`bitbots`, formerly shown as Bitbots) | Flat translucent panels over a wallpaper (Lake default; Dusk, Bloom, Sand, the user's image), 10 px gaps between floating panels, 20 px panel radius, hairline borders. Glass: Solid (tint .93, blur 24 px, default), Balanced (.58/10), Clear (.36/6). | 2D robot | Inter + system mono |
| Stone (`blobots`, formerly shown as Blobots) | Monochrome dark or light, flush panels | Glossy blob | Base fonts (`FONT_DEFAULTS` in `ui/fonts.ts`) |

Both support dark and light. Frost styles the companion and dictation windows; Blobots keeps its existing overlay palette. Pop, Dot and Legacy themes and stylesheets are removed (owner direction, 20 October 2026); old saved choices migrate to Bitbots.

## Haze: the status gradient (owner directive, 24 October 2026)

In Haze the status of a bot is a soft gradient rolling in from the right of its row (`blob/haze/HazeAura.tsx`), the owner's exception to "no decorative gradients". It shows only while the bot is doing something or is selected; the Manager keeps a still golden fade. Speed and colourfulness carry the state: selected-idle slow and muted, thinking two close hues, working fast with three hues, needs-you breathes amber, a failure falters in red, done sweeps green once. A change of state cross-fades (900 ms), never cuts. The same gradient marks the conversation header, the companion bar, focus card and teammate rows. Put it behind content with `z-index: -1` inside an `isolation: isolate` parent; never make the parent's children `position: relative` to lift them (see lessons, 2026-10-24). Tinted logos are inline SVG with their inner marks cut out (Codex's prompt glyph, OpenCode's inner block at 38%), not a CSS mask of the whole file.

## Rules that apply to every look

- **Shape:** rounded rectangles like the logo (`--radius-sm 9px`, `--radius-md 12px`, `--radius-lg 16px`, `--radius-pill 12px`, panels about 20 to 22 px). No pill or circle controls or surfaces: buttons, chips, composer, toggles and knobs, segmented controls, swatches and avatar frames are rounded rectangles. Exceptions: the circular Manager badge and locked-bot badge on avatars (`docs/design/design-system.md`), and the look orbs (the owner asked for orbs). Bot artwork is not UI and keeps its own shape.
- **Flat:** no glow, no halo, no decorative gradients, no text shimmer (the owner's words for Frost: "slick, smooth, premium; no glow"). Shadows only where a look's own language has them, or one soft shadow on floating menus and dialogs.
- **Readable selection:** in any look that fills a selected row, every descendant of the selected element takes the selected text colour (names, role chips, times, status lines, icons). Dot (inverted) and Pop (butter) were the two that needed it, and both were removed on 20 October 2026. This was missed twice (FIX40, Dot and Pop); test any filled selected row in dark and light.
- **Contrast:** body text at least 4.5:1 against the surface it sits on, including over wallpapers at the default glass level.
- **Keep focus rings and selected states visible.** Never blanket-remove `box-shadow` (the focus ring is a box shadow).
- **User accent wins:** `--user-accent` (from `appearance.accent`) overrides each look's default accent.
- **Scope everything** to the look: `:root[data-style="<look>"]:not(.companion-surface):not(.dictation-surface)` for the main window, and separate `.companion-surface` / `.dictation-surface` sections for those windows.

## Tokens

All colours, sizes and radii come from `apps/desktop/src/ui/theme.css` tokens (`--surface-*`, `--text-1..3`, `--line*`, `--status-*`, `--radius-*`, `--shadow-pop`, `--focus-ring`, `--font-ui`, `--font-mono`, `--fs-*`, companion tokens). A look overrides tokens first and adds component rules only where tokens are not enough. Component stylesheets use tokens, not literals.

## Bot art

Per bot, offer Automatic, 3D robot (`robot`), 2D robot (`robot-pop`), Glossy (`blob`) and Hand-painted (`painted`). Both robots use the four `look.bot.shape` outlines and shell/trim/screen controls. Saved `robot-flat` and `robot-dot` ids remain valid in the daemon (`valid_look`) and resolve to 2D robot in the app (`resolveArt`, `blob/art/art.ts`); the Flat and Dot renderers stay in the code and on the character sheet (`/preview.html`), but the picker does not offer them. Automatic uses 2D for Bitbots and Glossy for Blobots. Hand-painted has twelve `look.paint` shapes; its body stays still, its eyes blink and large avatars track the pointer (`useEyeTracking.ts`). Mini avatars have no pointer listener; listeners and animation frames are cleaned up, and reduced motion stays still. Corner status badges retain their meaning. Manager badge: white star on orange.

The update notice lives immediately above the profile in the left sidebar, including without a selected conversation. Settings use row-shaped skeletons while loading. Finished tasks use two lines, with status/time beside the name. Selected and hovered surfaces must pair every descendant with readable text; user-bubble links inherit the bubble foreground.

## Copy

Plain, short, sentence case, British-neutral, no exclamation marks, no marketing words. The entity is a "bot" in every look. Say what happens, not how clever it is.
