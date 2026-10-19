# FIX41 brief: the looks reach the companion and dictation windows

**Owner decision (19 October 2026):** yes. Frost (`bitbots`), Pop and Dot should style the companion and dictation windows, as Legacy already does. This brief is for a later lane. It was not implemented in the session that recorded the decision.

## Where things stand

- `src/ui/App.tsx:138` puts `companion-surface` on `<html>` in the companion window. The dictation window gets `dictation-surface`.
- `src/ui/theme.css:246` gives `:root.companion-surface` a fixed dark palette (`color-scheme: dark`, `--surface-*`, `--text-*`, `--line*`). `theme.css:323-324` makes both windows transparent.
- `src/ui/themes/frost.css`, `pop.css` and `dot.css` scope every rule with `:not(.companion-surface):not(.dictation-surface)` (71, 235 and 137 occurrences). So these looks never reach either window.
- Legacy (`data-bitbots="on"`) already styles the companion: `src/ui/bitbots.css:21` (tokens on `.companion-surface`) and section 14 from `bitbots.css:734` (capsule, listening, island cards, dictation on the companion). Use it as the model.
- Companion styles live in `src/ui/companion.css` and `src/ui/companionAttention.css`. The dictation island lives in `src/ui/shell.css` (`.dictation-island`, `.on-companion`) and `src/ui/DictationIsland.tsx` / `DictationBubble.tsx`.

## What to build

1. **One companion layer per look.** Add a companion section to each of `frost.css`, `pop.css` and `dot.css`, scoped `:root[data-style="<look>"].companion-surface` and `:root[data-style="<look>"].dictation-surface`. Leave the existing main-window rules and their `:not(...)` guards alone, so nothing in the main window changes.
2. **Tokens first.** Each look sets the companion's `--surface-*`, `--text-*`, `--line*`, accent and font tokens for its light and dark themes. Then add only the component rules the tokens cannot reach: `.companion-capsule`, `.companion-listening`, `.island-card`, chat bubbles, the approval card, tabs, and `.dictation-island` / `.dictation-island.on-companion`.
3. **Frost.** Frosted glass on the capsule and cards, using the look's `--glass-tint` / `--glass-blur`. The companion window is transparent and sits over other apps, so it shows no wallpaper. Blur what is behind the window only if Tauri's window effects allow it. Otherwise use a solid tint at the `solid` glass level. Find out which and say so in the report.
4. **Pop.** 2px ink borders, the offset card shadow and Pop's fonts, kept small enough for the compact bar.
5. **Dot.** Dotted lines and Dot's fonts.
6. **Light theme.** The companion has been dark-only. Each look must look right with `data-theme="light"`, with text contrast of at least 4.5:1 and give the figures. If a look cannot reach that over arbitrary desktop content, keep that look's companion dark and say so.
7. **Legacy and Blobots** do not change.
8. **The bot art** (per-bot art styles from FIX40) in the companion must keep working in every look.

## Rules

- No change to companion behaviour, layout, drag, placement or sizes. This is styling only.
- Respect `prefers-reduced-motion`. Add no new animation.
- Keep the compact bar's height and the dictation pill's size. Native window sizes are fixed in `src-tauri`.
- Lanes never run `git commit`.

## Tests and checks

- Mounted tests: for each of `bitbots`, `pop` and `dot`, render the companion with `companion-surface` and check that the look's companion tokens apply (computed custom properties) and that Legacy and Blobots are unchanged.
- Browser preview (Director): `/?companion&style=<look>`, plus `&mode=home`, `&view=chat`, `&view=activity` and `&view=settings` (see `src/preview/gallery.tsx:48-52`), in dark and light. Also the dictation preview (`src/preview/dictationPreview.tsx`).
- Not verifiable in the preview: the real transparent native window over other apps. Record that it is unverified unless it is checked in the desktop build (built from a short path without an apostrophe).
