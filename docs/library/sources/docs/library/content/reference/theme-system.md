# Theme system

> **What this is:** the two supported app looks, their tokens, saved preferences and loading rules.
> **Status:** current; updated for the owner's two-theme decision
> **Last updated:** 2026-10-20

## Supported looks

Bitbots (Frost) and Blobots are the only app themes. Both support dark and light. Settings and onboarding offer two orbs, with names on hover and keyboard focus. Bot art is independent: removing an app theme does not remove saved robot or blob artwork.

The base tokens are in `apps/desktop/src/ui/theme.css`. Bitbots statically imports `ui/themes/frost.css` from `main.tsx`; Blobots uses the base styles. Pop, Dot and Legacy CSS and theme registrations are removed. Old cached, database and backup selections for those looks normalize to Bitbots. New settings writes accept only `bitbots` or `blobots`.

## Attributes and settings

`appearance.style` supplies `data-style`. `appearance.theme` selects system, dark or light; `data-theme` is the resolved theme. `data-wallpaper` and `data-glass` control Frost. The retired `data-bitbots` pixel marker is cleared. A small script in `index.html` applies safe presentation preferences before first paint; the daemon remains the source of truth.

Frost has Lake, Dusk, Bloom, Sand and a custom wallpaper. Glass is Solid (default), Balanced or Clear. Wallpaper bytes are stored in the native app's files, never settings. Large surfaces use glass; controls and nested surfaces use flat fills to avoid stacked blur. There is no glow, halo or decorative gradient.

## Type, colour and shape

Bitbots defaults to Inter; Blobots uses the system stack. The existing font catalogue remains available for explicit user choices. `ui/fonts.ts` lazily loads only chosen fonts and returns to the appropriate defaults when an override is cleared. User accent overrides the look default through shared tokens.

Controls use the existing rounded-rectangle system. The two theme orbs and their selection rings are circular exceptions. Readable foregrounds apply to every selected-row descendant, inline/fenced code, mentions and links. User-bubble links inherit the bubble's foreground.

## Overlay windows

Companion and dictation load the same bundle with a surface class. They keep `data-theme=dark` and use `data-surface-theme` for Frost's dark/light overlays. Blobots keeps its existing dark overlay palette. Main-window Frost rules exclude those surfaces explicitly. Reduced motion stops optional animation.

## Verification

Run typecheck, frontend tests and both production builds. Inspect Bitbots and Blobots in dark/light, including selected rows, settings, code, links and overlays. Wait for colour transitions to finish before sampling contrast. A Vite dev render is not proof that a production CSS chunk loads; retain the static-import build guard. See [development and testing](development-and-testing.md).
