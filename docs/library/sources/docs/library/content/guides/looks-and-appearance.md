# Looks and appearance

> **What this is:** the two looks, what each changes, and how wallpapers, glass, fonts, accent and text size work.
> **Status:** current; updated for `main` on 22 October 2026, when Pop, Dot and Legacy were retired (the look list is two, not five).
> **Last updated:** 2026-10-22

## Before you start

Open **Settings › Appearance**. The page is ordered Look, Look options, Colour, Text. Bitbots saves your choice on this device and applies it straight away.

A **look** is not the same as a bot's **art**. The look styles the app; the art styles one bot. Leave a bot's art on Automatic and it follows the look. [Bots](bots.md) covers art.

## The two looks

Pop, Dot and Legacy were retired on 21 October 2026. If you had one of them selected, Bitbots now shows Bitbots instead, and your bots keep their art.

### Bitbots (Frost)

The default. Flat translucent panels over a wallpaper, with hairlines and rounded rectangles. The see-through effect is used on the large surfaces only: the sidebar, conversation lists, conversation column, details panel, settings sheet, dialogs, menus and popups. Cards, rows, inputs and message bubbles stay flat, so the transparency does not stack up.

There is no glow, halo, decorative gradient or text shimmer. Floating menus have one soft shadow. The interface font is Inter unless you choose another.

![The Bitbots look in dark](../../assets/screens/main-bitbots-dark.png)

*Bitbots (Frost), dark theme, Lake wallpaper. Fixture data.*

![The Bitbots look in light](../../assets/screens/main-bitbots-light.png)

*The same look in the light theme. The wallpaper shows through the solid glass tint. Fixture data.*

### Blobots

The quiet, monochrome alternative. Panels are opaque and the chrome is black, grey and white; colour is reserved for bots and for status that needs attention. It uses the base styles in `apps/desktop/src/ui/theme.css`. It does not use wallpapers or glass, and its companion keeps a fixed dark palette.

![The Blobots look](../../assets/screens/main-blobots.png)

*Blobots in the dark theme. The bot art follows the look: glossy blobs unless a bot chooses otherwise. Fixture data.*

## Look options: wallpaper and glass

Wallpaper and glass belong to Frost. Other looks show a quiet line in their place.

- **Wallpaper:** Lake (default), Dusk, Bloom, Sand, or your own image. A custom image must be PNG, JPEG or WebP and no larger than 15 MB. Bitbots copies the image into its own files and remembers which one you picked. **Remove** returns to Lake.
- **Glass:** Solid (default), Balanced or Clear. Solid shows the least wallpaper and Clear the most. Solid is also what the companion and dictation windows use, because those windows cannot blur what is behind them.

## Colour: theme and accent

**Theme** is System, Dark or Light. System follows Windows and updates when Windows changes.

**Accent** is an optional colour, entered as a hex value such as `#e17a56`. It replaces the look's default accent for primary buttons, selection and focus. Bitbots chooses black or white text on the accent so the label stays readable. Leave it unset to use the look's own accent.

## Text: fonts, size and density

There are 24 bundled fonts in four categories:

| Category | Fonts |
| --- | --- |
| Sans | Inter, Geist, DM Sans, Manrope, Plus Jakarta Sans, IBM Plex Sans, Figtree, Sora |
| Friendly / display | Outfit, Nunito, Space Grotesk, Bricolage Grotesque |
| Mono | JetBrains Mono, Geist Mono, Fira Code, IBM Plex Mono, DM Mono, Space Mono |
| Pixel | Doto, Silkscreen, Pixelify Sans, VT323, Press Start 2P, Jersey 10 |

The defaults are per look: Bitbots uses Inter, and Blobots uses its base fonts. **Default for this look** returns to those.

A font is loaded only when you choose it, so it does not slow down the rest of the app. A pixel font is allowed as the interface font; the smallest text stays readable at 11 px. **Text size** has four steps (Small, Default, Large, Larger) and **Density** three (Compact, Default, Roomy); both change spacing and type size, not the window zoom.

## Orbs, not screenshots

Each look in Settings and onboarding is one still orb: frosted glass for Bitbots and matte stone for Blobots. An orb has no window chrome, avatars, text or animation, and it looks the same in every theme. Names appear on hover and keyboard focus.

## Check the result

- The whole window changes at once, including menus and dialogs; no area keeps the previous look.
- With Frost, switching glass changes how much wallpaper shows through the large panels but not the flat cards.
- A chosen font appears in headings and body text, and the code font appears in code blocks and diffs.
- The companion follows the resolved theme in Frost. Blobots keeps its dark companion in both themes.
- A custom wallpaper survives a restart and returns to Lake after **Remove**.

## If something fails

**A custom image is refused.** It is over 15 MB or not PNG, JPEG or WebP. Resize it and try again.

**Text is clipped after choosing a pixel font.** Bitbots keeps an 11 px floor, but some pixel faces are wider. Choose a smaller text size or a different font; this is a property of the font, not a layout fault.

**The companion did not follow the theme.** The dictation window takes its theme only when it is created; close and reopen it. The companion follows a theme change immediately.

**A look looks wrong after an update.** Use **Default for this look** for fonts, then reselect the look. If the problem remains, export diagnostics and name the look and theme in the report.

How it works: [theme system](../reference/theme-system.md).
