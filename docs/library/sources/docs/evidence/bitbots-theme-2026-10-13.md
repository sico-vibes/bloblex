# Evidence: Bitbots pixel theme (CSS only) — 2026-10-13

> **What this is:** Evidence for the Bitbots pixel theme (CSS only), 13 October 2026.
> **Status:** evidence; immutable record
> **Last updated:** 2026-10-13

Lane: OpenCode (`opencode-go/deepseek-v4.1-flash`), CSS only. Branch `fix2-bitbots-css`.

## Deliverable

- `apps/desktop/src/ui/bitbots.css` — one new file, 903 lines, 373 `{` / 373 `}`.
- Activation attribute: `data-bitbots="on"` on `<html>`; every rule is prefixed
  `:root[data-bitbots="on"]` (the token block also pairs `[data-theme="light"]` and
  `.companion-surface` so the dark pixel palette wins in every case).
- No existing file, `.tsx`/`.ts`, `package.json` or lockfile was edited. No images
  or fonts were added.

## How it was verified (no browser)

- Read every stylesheet in `apps/desktop/src/ui/` (`theme.css`, `shell.css`,
  `composer.css`, `companion.css`, `settings.css`, `experiments.css`, `analytics.css`,
  `usage.css`, `memory.css`, `schedules.css`, `team.css`, `blobPage.css`,
  `providerBrand.css`, `styles.css`) and `BlobCanvas.tsx`.
- `grep`'d the repo for every class used, so selectors come from real CSS/TSX.
- Brace balance checked by counting `{`/`}` (373/373). No runtime or visual check
  was performed (no browser), so this is source-level evidence only.

## Notes for the Director

- Fonts are set through the existing tokens (`--font-ui`, `--font-mono` -> "DM Mono")
  and Doto is applied by selector groups; no `@font-face` was added.
- Font sizes were left at the theme scale to avoid reflow (a few companion labels use
  literal 9.5–10px; see the report's "skipped" list).
- The broad resets (`border-radius: 0`, `box-shadow: none`, stepped timing) are scoped
  to `:root[data-bitbots="on"]` and re-add hard shadows on the floating surfaces.
