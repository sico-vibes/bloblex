# Theme system

> **What this is:** how a look is stored, loaded and scoped, what tokens it overrides, how themes and fonts reach the overlay windows, and how to add a look.
> **Status:** current; checked against `appearance.ts`, `blob/bitbots.ts`, the look stylesheets and `docs/design/design-system.md` on 19 October 2026
> **Last updated:** 2026-10-19

## Purpose

A look is a stylesheet plus a set of document attributes. The base tokens live in `apps/desktop/src/ui/theme.css`. Each look overrides them in its own file, scoped to `:root[data-style="…"]`. No component should hard-code a colour; if it needs one, it uses a token the look can override.

The look also decides the default art for a bot that has not chosen one. Art itself is covered in [the bot art system](bot-art-system.md).

## The attributes

| Attribute | Values | Set by |
| --- | --- | --- |
| `data-style` | `bitbots`, `blobots`, `legacy`, `pop`, `dot` | `applyDocument()` in `apps/desktop/src/blob/bitbots.ts:69-78`. |
| `data-theme` | `dark`, `light` | The boot script and `applyAppearance` (`apps/desktop/src/ui/appearance.ts:69-73`). |
| `data-theme-choice` | `system`, `dark`, `light` | The overlay windows keep the user's choice separate from the resolved theme. |
| `data-surface-theme` | `dark`, `light` | Overlay windows only; the resolved theme for the look layer. |
| `data-wallpaper` | `lake`, `dusk`, `bloom`, `sand`, `custom` | `setWallpaper` / `applyDocument`. |
| `data-glass` | `solid`, `balanced`, `clear` | `setGlass` / `applyDocument`. |
| `data-text-size` | `small`, `default`, `large`, `larger` | `applyTextSize`. |
| `data-density` | `compact`, `default`, `roomy` | `uiPrefs`. |
| `data-bitbots` | `on` | Legacy only. It switches on the pixel components and the pixel font imports. |
| `data-accent` | `custom` | Set when the user accent is non-empty. |

The style is cached in `localStorage` (`bitbots.style`) so the first paint already matches; the daemon setting remains the source of truth. The cache is written after a successful save. The pre-style key `bloblex.bitbots` is read once for migration and never written.

## Loading

The look stylesheet loads on demand (`apps/desktop/src/blob/bitbots.ts:39-50`):

- Bitbots loads `ui/themes/frost.css`.
- Pop loads `ui/themes/pop.css`.
- Dot loads `ui/themes/dot.css`.
- Legacy loads `bitbots.css` plus the Doto and DM Mono stylesheets.
- Blobots loads no look stylesheet; it uses the base tokens and the existing component styles.

A load is cached by look, and a failed load removes itself from the cache so a later attempt can retry. Fonts are loaded separately, only for the chosen font or while the font list is open.

## What a look overrides

The Frost file is the reference for a complete layer (`apps/desktop/src/ui/themes/frost.css:1-64`):

- surfaces: app, sidebar, panel, raised, overlay, input, hover, selected;
- text: primary, secondary, tertiary;
- lines: normal and strong;
- radii: small, medium, large, pill;
- shadows: pop, card, panel (Frost sets card and panel to none);
- accent and status colours: working, success, danger, info, violet;
- glass: tint and blur;
- font: UI family.

Frost scopes its main-window rules to `:not(.companion-surface):not(.dictation-surface)` and adds separate layers for those windows. Pop and Dot do the same. A main-window rule must never leak into the companion by accident; the mounted look tests inject the CSS and assert the boundary.

### Shape rule

Bitbots, Pop and Dot use rounded rectangles, never pills or circles, for UI. Frost's radii are 9, 12 and 16 px, and the pill token is 12 px. The bot artwork is not UI and is not affected. Blobots and Legacy keep their original shapes.

### Glass

Frost has three levels, changed only by the tint and blur values:

| Level | Tint | Blur |
| --- | --- | --- |
| Solid | 0.93 | 24px |
| Balanced | 0.58 | 10px |
| Clear | 0.36 | 6px |

Glass covers the large surfaces only. Cards, rows, inputs and message bubbles use flat fills and never their own backdrop blur, so transparency does not stack. The overlay windows use a solid tint because the native window has no blur behind it.

### Type

The UI font is a token. The default per look is in `apps/desktop/src/ui/fonts.ts:25-27`; a chosen font overrides it through `--font-ui`, and a chosen code font through `--font-mono`. The smallest rendered size stays at 11 px, even with a pixel font. Text size scales tokens; it is not browser zoom.

### Accent

`accentTokens` (`apps/desktop/src/ui/appearance.ts:52-63`) derives four values from a `#rrggbb` colour:

- `--user-accent`: the colour;
- `--user-accent-pressed`: 88% of it;
- `--user-accent-soft`: 14% alpha;
- `--user-accent-ink`: near-black or white, whichever reaches at least 4.5:1.

A look's own accent is the fallback when no user accent is set. The accent is applied as inline custom properties on the document root, not by rewriting a stylesheet.

## The overlay windows

The companion and dictation windows load the same bundle with a surface class. They keep `data-theme="dark"` and set `data-surface-theme` to the user's resolved theme. Legacy and Blobots keep their fixed dark palette there; Frost, Pop and Dot have their own light layer.

Each overlay layer sets the companion's surface, text, line, accent and font tokens, then styles what tokens cannot reach: the capsule, the listening pill, island cards, tabs, buttons and the dictation island. Pop draws its 2 px outline and offset shadow with `box-shadow`, so no box grows. Dot uses dotted outlines. Bot-coloured text on light is mixed 15% toward ink to keep at least 4.5:1.

The companion follows a theme change immediately. The dictation window takes its theme when it is created; a later change reaches it on the next creation.

## Orbs

Each look has one static orb, drawn in `LookOrb.tsx` and its stylesheet. An orb has no window chrome, avatar, text or animation, and it does not read the app tokens, so it looks the same in every theme. It is used on the two large onboarding and Settings cards (about 72 px) and on the More looks cards (about 52 px). No orb has a glow or halo.

## Adding a look

1. Add the id to `ThemeStyle` and `THEME_STYLES` in `apps/desktop/src/ui/appearance.ts:4-5`.
2. Add a label, family and description to `THEME_LOOKS` (`:6-12`).
3. Create `apps/desktop/src/ui/themes/<id>.css`, scoped to `:root[data-style="<id>"]`. Override the token set, then the component-level exceptions.
4. Import it on demand in `loadStyle` (`apps/desktop/src/blob/bitbots.ts:39-50`).
5. Add the default art in `defaultArtForStyle` (`apps/desktop/src/blob/art/art.ts:106-115`).
6. Add the fonts to `FONT_DEFAULTS` if the look has its own.
7. Draw an orb.
8. Add the companion and dictation layer, or state why the look keeps the shared dark palette.
9. Add the id to the daemon and storage validators (`appearance.style`), the backup allowlist, the settings index and the preview flags.
10. Add a mounted test that injects the CSS and checks dark and light tokens, the overlay boundary and the contrast floor.
11. Add a screenshot to this library and update `docs/design/design-system.md`.

## Gotchas

- **`data-style` is on the document, not a component.** A portal or a native window without the attribute will not see the look.
- **Do not scope a main-window rule without the overlay guard.** It will reach the companion.
- **Blur is expensive and must not stack.** One backdrop filter on a large surface, flat children.
- **A user accent can break contrast.** Use `--user-accent-ink`; do not hard-code white on the accent.
- **Legacy is not just a palette.** It changes components and fonts, and uses `data-bitbots="on"`.
- **The boot cache is not the source of truth.** A failed save must not leave the cache claiming a look the daemon did not store.
