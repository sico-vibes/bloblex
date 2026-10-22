# Bitbots theme spec: the pixel re-skin (CSS only)

> **What this is:** The pixel re-skin theme spec for the experimental Bitbots theme (CSS only), 13 October 2026.
> **Status:** historical; superseded in part by [themes-spec.md](../history/fix-40/themes-spec.md) (the Frost look became Bitbots)
> **Last updated:** 2026-10-22

Update 22 October 2026: the pixel re-skin described here was retired. `apps/desktop/src/ui/bitbots.css` no longer exists, and only the Bitbots (Frost) and Blobots looks remain. The current rules are in [design-system.md](design-system.md).

Owner: OpenCode lane, CSS only. Reviewer: Director (Claude), who audits every rule and finishes what you miss. The Director writes all TSX and wires the toggle; **you only create one new file: `apps/desktop/src/ui/bitbots.css`** (plus an evidence note). Do not edit any existing file, any `.tsx`/`.ts`, `package.json` or the lockfile. Do not add images or fonts: use CSS, inline SVG data URIs and `box-shadow`/gradient pixel tricks.

## What this is
"Bitbots" is an opt-in experimental theme (Settings, Experimental). When it is on, the app's blobs become pixel-LED robot heads (drawn by a library, not by you) and the whole UI takes a pixel look. It is applied by the attribute `data-bitbots="on"` on `<html>` (so selectors start `:root[data-bitbots="on"]`). Dark mode only: if `data-theme="light"` is also set, still apply the dark pixel palette (the theme replaces the light/dark choice while it is on).

## Fonts (already bundled and loaded by the Director, do not @font-face them)
- `"Doto"` (dot-matrix display font, weights 100-900): headings, buttons, tab labels, chips, names, numbers, timestamps, badges. Use weight 700-900. Never for paragraphs.
- `"DM Mono"` (400/500): body text, inputs, messages, code, tooltips, menus.
Fallback chain: `"Doto", "DM Mono", ui-monospace, Menlo, monospace` / `"DM Mono", ui-monospace, Menlo, monospace`. Set `--font-ui` and `--font-mono` if the app uses those tokens (check `theme.css`), and `font-smooth`/`-webkit-font-smoothing: none` where it helps the pixel read. Keep text readable: nothing under 11px; do not letter-space body text.

## Palette (taken from the reference site claudes.dev, which is the look to match)
- Background `#141414`; sidebar/panel `#171717`; raised surface `#1c1b1a`; overlay `#201f1d`; input `#191817`; hover `rgba(236,232,226,.06)`; selected `#262420`.
- Text `#ece8e2`; secondary `#8d8983`; tertiary `#6f6b65`.
- Accent (terracotta) `#e17a56`; accent pressed `#c9653f`; accent soft `rgba(225,122,86,.14)`.
- Lines: `#3a3733` (solid), dotted rules use the same colour. Strong line `#57524b`.
- Status (sparingly): success `#8bd17c`, warning `#f0b84a`, danger `#e5604d`, info `#6fb1e0`.
Override the tokens in `theme.css` (`--surface-*`, `--line*`, `--text-*`, `--status-*`, `--meter-*`, `--companion-*`, chart tokens, etc.; read that file first and override **every** token that has a colour so nothing keeps the old grey/blue) inside `:root[data-bitbots="on"]` and also inside `:root[data-bitbots="on"].companion-surface`.

## Shape language (the pixel rules)
1. **No rounded corners.** `border-radius: 0` everywhere, including pills, avatars' frames, toggles, inputs, menus, dialogs, tooltips, scrollbars. (Exception: a circle that must stay a circle is not needed; robots are drawn by the library.) Use `!important` only where an existing rule has inline specificity trouble.
2. **Borders.** Containers: `2px solid var(--bb-line)`. Emphasis (primary buttons, selected rows, focused fields, the experimental badge, key cards): `2px dotted var(--bb-accent)` like the reference. Dividers are `2px dotted var(--bb-line)`; replace hairline `1px solid` separators with dotted ones.
3. **Shadows are hard, not blurred.** Popovers, menus, dialogs, the island: `box-shadow: 4px 4px 0 #000`. Remove every soft blur shadow in the theme scope.
4. **Pixel dither.** App background gets a faint dot grid: `background-image: radial-gradient(rgba(236,232,226,.05) 1px, transparent 1.2px); background-size: 6px 6px`. Dialog backdrops: a 2px checkerboard of black at 55% (use `conic-gradient` / `repeating` tricks).
5. **Stepped motion.** Replace smooth easing with `steps(N)` (N 3 to 6) for hover, open/close and loading; transitions at most 160ms. Respect `prefers-reduced-motion` (no animation). Provide a reusable `@keyframes bb-blink` (caret/cursor), `@keyframes bb-pulse` (stepped opacity), `@keyframes bb-march` (marching dotted border) and use them for: the composer caret feel, "working" indicators, loading bars.
6. **Focus.** `outline: 2px dotted var(--bb-accent); outline-offset: 2px` on every focusable control; keep it very visible.
7. **Scrollbars** (`::-webkit-scrollbar`): 10px wide, square thumb `#57524b` with a 2px `#141414` border.
8. **Selection** `::selection { background: var(--bb-accent); color: #141414 }`.
9. **Images/avatars/icons.** Add `image-rendering: pixelated` to `img`/canvas that carry pixel art (the provider logos, attachments are exempt: do not pixelate user images/attachments; only `.provider-logo`, `.runtime-mark`).

## Surfaces to cover (find the class names by reading the existing CSS; do not guess)
App shell and sidebar (rows, groups, search, project headers, selected/hover/unread/approval states), conversation header (the title row, role chip, auto title, side-conversation pill, header buttons), message list (user and assistant bubbles: square, 2px border, DM Mono; code blocks; activity summary lines; plan card; approval/question cards; working indicator; reply strip; reaction badge; message action toolbar; queue banner), composer (box, textarea, pills, send/stop buttons, attachments, menus and popovers, effort meter popover, usage tip), buttons (`primary-button`, `secondary-button`, icon buttons, toggles/switches as square pixel switches), inputs/selects/textareas, tabs and segmented controls, chips/pills, tooltips and `Tip`, menus (`menu-surface`, `menu-item`), dialogs (`blob-dialog`, hold-to-confirm button), settings sheet and pages, Automations, Memory, Usage/analytics (cards, orbs frame, chart bars square, switch), quota bar and usage popover, first-run onboarding, launch intro, empty states, update banner, inline errors, the dictation island and bubble, and the **companion island** (`companion.css`: card, tabs, composer, team peers, activity; it uses `--companion-*` tokens and its own radii: flatten them).

## Hard exclusions
- **No corner badges on blob avatars that indicate typing, waiting or error**: the robots show state on their own faces. If any element positioned on an avatar's corner conveys status (typing dots, error/permission glyph, working pip), hide it with `display: none` in this theme and list its selector in your report. **Keep** the leader star (`.leader-badge`) but make it a square pixel star-ish chip (no circle).
- Do not hide the unread/approval dot in the row's text line (`.unread-dot`); restyle it as a 8px square.
- Never change layout metrics (widths, heights, paddings that affect layout) beyond what the border/shadow swap needs; this is a skin. If a rule would reflow things, skip it and report it.
- Do not use `display: none` on anything that carries information other than the avatar corner statuses above.

## Structure of the file
1. A header comment: what it is, activation attribute, palette table, font note.
2. `:root[data-bitbots="on"] { --bb-*: ...; <override every theme token> }` and the companion-surface variant.
3. Sections in the order of "Surfaces to cover", each prefixed `:root[data-bitbots="on"]`.
4. A final `@media (prefers-reduced-motion: reduce)` block that disables the theme's animations.
Keep the file under about 900 lines; prefer token overrides over per-component repetition.

## Reusable pieces the Director's TSX will rely on (define these exactly)
- `.bb-pixel-box`: dotted accent border box with a hard shadow (for the reference-style highlighted panels).
- `.bb-eyebrow`: tiny uppercase Doto label, `letter-spacing: .12em`, secondary colour.
- `.bb-loader`: a 120px x 12px pixel progress bar with stepped marching fill (`bb-march` / steps), accent colour.
- `.bb-cloud`: container for a pixel cloud decoration (`position:absolute; pointer-events:none; opacity:.5; image-rendering: pixelated`); the Director draws the cloud in a canvas inside it.
- `.bb-badge-flash`: not yours: the Director writes the "Experimental" badge animation in the main stylesheet; do not define it.

## Verification you can do without a browser
You cannot see the page. Instead: (a) every selector you use must exist in the repo's CSS or TSX (grep it; list any you could not find); (b) run `npx stylelint`-style sanity yourself by reading the file once for unbalanced braces; (c) run `cd apps/desktop && npx vite build` is not needed (the Director imports the file later).

## Report (plain text, last message)
1. Line count and sections. 2. The exact list of avatar-corner status selectors you hid. 3. Tokens you overrode. 4. Selectors you could not find or surfaces you skipped. 5. Anything that you think needs TSX markup hooks from the Director (class names or data attributes you wish existed), as a concrete list. Do not claim visual verification.
