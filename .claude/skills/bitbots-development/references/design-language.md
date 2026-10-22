# Design language

Last reviewed: 2026-10-20. Source of truth for rules: `docs/design/design-system.md` and `docs/library/content/reference/theme-system.md`. When the owner changes a visual rule, edit the rule here in place and in `docs/design/design-system.md`.

## Product feel

A calm chat app for developers moving between coding-agent sessions. The bots supply warmth; the chrome stays quiet. Say each thing once per screen (a bot's name, state and model appear in one place). Status colour only when something is happening. In Blobots chrome that means amber for working or approval, red for failure and green only for added lines (`docs/design/design-system.md`); Frost and the bot arts' status badges follow their own palettes. One animated bot per place.

## The two looks

`appearance.style` → `<html data-style>`. Settings and onboarding use one orb row, ordered **Bitbots, Blobots** (owner review, 20 October 2026). Names appear on hover/focus, with no card subtext or visible family grouping.

| Look (value) | Feel | Default bot art | Default fonts |
|---|---|---|---|
| Bitbots (`bitbots`) = Frost | Flat translucent panels over a wallpaper (Lake default; Dusk, Bloom, Sand, the user's image), 10 px gaps between floating panels, 20 px panel radius, hairline borders. Glass: Solid (tint .93, blur 24 px, default), Balanced (.58/10), Clear (.36/6). | 2D robot | Inter + system mono |
| Blobots (`blobots`) | Monochrome dark or light, flush panels | Glossy blob | Segoe UI stack |

Both support dark and light. Frost styles the companion and dictation windows; Blobots keeps its existing overlay palette. Pop, Dot and Legacy themes and stylesheets are removed (owner direction, 20 October 2026); old saved choices migrate to Bitbots.

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

Per bot, offer Automatic, 3D robot (`robot`), 2D robot (`robot-pop`), Glossy (`blob`) and Hand-painted (`painted`). Both robots use the four `look.bot.shape` outlines and shell/trim/screen controls. Saved `robot-flat` and `robot-dot` ids remain valid and resolve to 2D robot. Automatic uses 2D for Bitbots and Glossy for Blobots. Hand-painted has twelve `look.paint` shapes; its body stays still, its eyes blink and large avatars track the pointer (`useEyeTracking.ts`). Mini avatars have no pointer listener; listeners and animation frames are cleaned up, and reduced motion stays still. Corner status badges retain their meaning. Manager badge: white star on orange.

The update notice lives immediately above the profile in the left sidebar, including without a selected conversation. Settings use row-shaped skeletons while loading. Finished tasks use two lines, with status/time beside the name. Selected and hovered surfaces must pair every descendant with readable text; user-bubble links inherit the bubble foreground.

## Copy

Plain, short, sentence case, British-neutral, no exclamation marks, no marketing words. The entity is a "bot" in every look. Say what happens, not how clever it is.
