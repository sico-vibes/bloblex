# FIX40: look orbs instead of mini screenshots

> **What this is:** Spec for FIX40: look orbs instead of mini screenshots.
> **Status:** historical
> **Last updated:** 2026-10-19

Lane: Codex `gpt-6-luna`, high. Worktree `D:\fx40o` (branch `fix40-orbs`, from `main` f957529). `node_modules` is a junction: do not run `npm install`. Never run `git commit`. Reviewer: the Director, in the browser.

## What the owner wants

The look cards (Settings → Appearance "Choose a look" and the onboarding "Choose your look" step) currently show a miniature screenshot of each look (a fake window with avatars and chat bubbles). Replace that with **one orb per look**: a sphere-like swatch that conveys the look's material and feel at a glance. It is not a screenshot: no window chrome, no chat bubbles, no avatars, no text inside.

| Look | Orb |
|---|---|
| Bitbots (Frost) | A frosted-glass orb: the Lake wallpaper's colours inside (soft sky blue at the top through lavender to a pale peach horizon, with one or two calm hill silhouettes in the lower half), seen through a translucent white glass layer, with a thin light rim. Flat and quiet: **no glow, no halo, no outer shadow** (the owner dislikes glow). |
| Blobots | A matte monochrome orb: dark grey with soft, simple shading (lighter top left, darker lower right), like a quiet stone. |
| Legacy | A pixel orb: the circle drawn with stepped, pixel edges (a pixel-grid circle, e.g. via an SVG made of squares or a stepped `clip-path`), dark with the terracotta accent `#e17a56` and a dotted inner ring, crisp (`image-rendering: pixelated` where relevant). |
| Pop | A retro sticker orb: cream base `#fbf6ec` with diagonal pastel bands (butter `#f6cf5c`, mint `#8fdcb6`, coral `#f59a8c`), a 2px ink outline `#1d1b18` and a hard offset shadow (3px 3px 0 ink, no blur). |
| Dot | A black orb `#0e0e0e` with a dot-matrix pattern of small grey dots inside (unlit `#333`, a few lit `#f2f2f2`) and one red dot `#ff4b2b`; thin `#262626` rim. |

## How

1. New `apps/desktop/src/ui/LookOrb.tsx` (`<LookOrb look={ThemeStyle} size={number} />`, decorative, `aria-hidden`) and `apps/desktop/src/ui/lookOrb.css`. Pure SVG and/or CSS, static (no animation, no canvas, no BlobCanvas), cheap to render, crisp at 40 to 96px, looks the same whatever look the app itself is wearing (do not read app tokens for the orb's own colours), and works on dark and light card backgrounds.
2. Use it in both places:
   - `ui/AppearancePage.tsx`: the look cards (`lookCard`) show the orb instead of the mini window. Big cards (Bitbots, Blobots): orb about 72px; "More looks" cards (Legacy, Pop, Dot): about 52px. Layout: the orb on the left, name and one-line description on the right, vertically centred; keep the selected state (the current accent outline) and keyboard behaviour. Remove the mini-window markup and its CSS from `appearancePage.css` (and any helper that only it used).
   - `ui/LookPicker.tsx` (used by onboarding): show the orb instead of its avatar preview, same layout idea. Leave `LookPreview.tsx` and the onboarding's large preview as they are.
3. Update the mounted tests that assert the old card contents (search the tests for the mini-window class names, `LookAvatar`, or `BlobCanvas` inside look cards) and add a small test that each of the five looks renders an orb with `data-look="<id>"`.

## Gates

From `D:\fx40o`: `npm run typecheck`, then `npx vitest run` for the touched test files (in your sandbox add `--configLoader runner` if Vite cannot write its temp file). Paste the tails.

## Report

What you built per orb, files changed, gate tails.
