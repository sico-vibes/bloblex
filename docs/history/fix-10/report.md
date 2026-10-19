# FIX10 report: theme style (Bitbots / Blobots) and user accent, logic layer

> **What this is:** Report on FIX10: theme style (Bitbots and Blobots) and the user accent colour, logic layer.
> **Status:** historical
> **Last updated:** 2026-10-15

Spec: [docs/history/fix-10/theme-style-spec.md](theme-style-spec.md). Written 15 October 2026.
Status: implemented, gates green, diff left in the working tree. No commit was run.

This is the non-visual layer only. No CSS, `FirstRunOnboarding.tsx`, `SettingsSheet.tsx`,
`LaunchIntro.tsx` or `StyleStep*` file was touched, and no product-name copy was renamed.

## Final API as built

### `apps/desktop/src/ui/appearance.ts`

```ts
export type ThemeStyle = 'bitbots' | 'blobots'
export const THEME_STYLES: readonly ThemeStyle[] = ['bitbots', 'blobots']
export function isThemeStyle(value: unknown): value is ThemeStyle

// '' for anything that is not `#rrggbb`; otherwise the colour in lower case.
// Mixed case is accepted and normalised (`#E17A56` -> `#e17a56`).
export function normalizeAccent(value: unknown): string

// WCAG 2.x contrast ratio between two `#rrggbb` colours, 1..21.
export function contrastRatio(a: string, b: string): number

// accent: the normalised hex. pressed: each channel * 0.88. soft: `rgba(r,g,b,.14)`.
// ink: `#0f0f10` or `#ffffff`, whichever reaches 4.5 on the accent (higher of the
// two when neither reaches it). An invalid input yields all-empty strings and ink `#0f0f10`.
export function accentTokens(hex: string): { accent: string; pressed: string; soft: string; ink: string }
```

`ThemeChoice`, `TextSizeChoice`, `appearanceAttributes`, `applyAppearance`,
`applyTextSize` and `applySurfaceAppearance` are unchanged.

### `apps/desktop/src/blob/bitbots.ts`

Existing exports kept: `bitbotsEnabled`, `setBitbotsEnabled`, `useBitbots`, `robotStateFor`.

```ts
export type ThemeStyle = 'bitbots' | 'blobots'   // re-exported via ../ui/appearance
export function themeStyle(): ThemeStyle
export function setThemeStyle(next: ThemeStyle): void   // writes `bitbots.style`, <html>, notifies listeners
export function useThemeStyle(): ThemeStyle
export function accentColor(): string                    // '' = neutral default
export function setAccentColor(hex: string): void        // normalises; '' clears
export function useAccentColor(): string
```

Semantics as built:

- Default is `'bitbots'`. First paint reads `localStorage['bitbots.style']`; if absent
  it reads the legacy key `bloblex.bitbots` (`'1'` -> bitbots, `'0'` -> blobots);
  otherwise `'bitbots'`. The legacy key is never written.
- `<html>` always gets `data-style="bitbots|blobots"`. `data-bitbots="on"` is set only
  for bitbots and removed for blobots. The Doto/DM Mono fonts and `bitbots.css` load
  lazily and only for bitbots, exactly as before.
- A non-empty accent sets inline `--user-accent`, `--user-accent-pressed`,
  `--user-accent-soft`, `--user-accent-ink` on `<html>` plus `data-accent="custom"`;
  an empty accent removes all four and the attribute. The value is cached in
  `localStorage['bitbots.accent']` and applied at module load so first paint matches.
- `bitbotsEnabled()` is `themeStyle() === 'bitbots'`; `setBitbotsEnabled(b)` is
  `setThemeStyle(b ? 'bitbots' : 'blobots')`; `useBitbots()` stays a boolean.
- `setThemeStyle` / `setAccentColor` are idempotent-safe: they always refresh the
  cache, the document and the listeners.

### `apps/desktop/src/ui/vocabulary.ts` (new)

```ts
export interface EntityNounOptions { plural?: boolean; capital?: boolean }
export function entityNoun(style: ThemeStyle, options?: EntityNounOptions): string
export function useEntityNoun(options?: EntityNounOptions): string
```

`bitbots` -> `bot` / `bots`; `blobots` -> `blob` / `blobs`; `capital` upper-cases the
first letter. No production call site yet (the Director adopts it).

## Settings

`crates/bloblex-daemon/src/main.rs` (`settings.set`):

| key | accepted | default |
|---|---|---|
| `appearance.style` | `"bitbots"` or `"blobots"`, else `invalid_argument` | unset = bitbots (front-end) |
| `appearance.accent` | `""` or `#rrggbb` (case-insensitive, stored lower case), else `invalid_argument` | unset = `""` |

Both keys are added to `validation_key`. `settings.get` / `settings.list` expose them
like every other setting (absent until chosen). `experimental.bitbots` stays readable
and is not registered in the front-end `EXPERIMENTS` list (it was not registered there
before either, so nothing was removed).

Broadcast: `crates/bloblex-storage/src/lib.rs` now treats the `appearance.` prefix as a
window-level preference, so `settings.set` on `appearance.style` / `appearance.accent`
emits `settings.changed` with payload `{"key",...}` / `{"key","value"}` like the
`experimental.*`, `companion.*`, `speech.*`, `automations.*` and `memory.*` keys. The
storage layer also validates both keys, so a direct `set_setting` gets
`invalid_argument` too.

## Wiring

- `apps/desktop/src/ui/App.tsx`: `applyWindowSetting` now maps
  `appearance.style` -> `setThemeStyle` (invalid values ignored, and it retires the
  legacy switch) and `appearance.accent` -> `setAccentColor(normalizeAccent(v))`.
  `experimental.bitbots` remains a fallback that only applies while no valid
  `appearance.style` has arrived and only for an explicit boolean. Both keys were
  added to the initial `settings.get` key list (which runs in the companion window
  too, the same code path as `appearance.theme`), so any surface receives them.
- `apps/desktop/src/preview/fixtureBridge.ts`: fixture settings accept
  `appearance.style` / `appearance.accent`; `?style=blobots` and `?accent=%23rrggbb`
  seed them. The old `?bitbots` flag handling was removed.

### Legacy `experimental.bitbots` note

The spec's two statements about the legacy switch were not fully compatible: the cache
rule names `bloblex.bitbots = '0'` as blobots, while the migration paragraph says an
unset style is always bitbots. The implementation follows the explicit, tested cache
rule and the section 3 "fallback" wording: with the new `bitbots.style` key absent, an
explicit legacy `0` yields blobots and `1` yields bitbots; when the legacy key is
absent the default is bitbots. The fallback is skipped the moment a valid
`appearance.style` arrives, so it can never override the new setting.

## Tests

- `apps/desktop/src/ui/appearance.test.ts`: added `user accent colours` — `normalizeAccent`
  accept/reject cases, `isThemeStyle`, `THEME_STYLES`, `contrastRatio` known values
  (`#ffffff`/`#000000` = 21, `#ffffff`/`#ffffff` = 1, `#3b82f6`/`#ffffff` ≈ 3.68), ink
  contrast >= 4.5 for `#ffffff`, `#000000`, `#e17a56`, `#3b82f6`, `#facc15`, and exact
  tokens for `#3b82f6`.
- `apps/desktop/src/blob/bitbots.test.ts`: new `theme style switch` block — default
  bitbots, new cache key, legacy key fallback (and precedence), `setThemeStyle` toggling
  `data-bitbots`/`data-style` and never writing the legacy key, accent set/clear of the
  four properties plus `data-accent`, cached accent at module load, invalid accent
  ignored. Each case imports a fresh module so the module-load cache is exercised.
- Existing tests that assumed Bitbots was off by default now select Blobots explicitly:
  `blob/BlobCanvas.mounted.test.tsx`, `ui/LookEditor.mounted.test.tsx`,
  `ui/LaunchIntro.mounted.test.tsx`, `ui/App.agent.mounted.test.tsx`.
- `crates/bloblex-daemon/src/main.rs`: `appearance_settings_validate_persist_and_broadcast`
  — unset by default, invalid type/value `invalid_argument`, valid persistence,
  lower-case hex storage, `settings.changed` on change with the exact payload, clearing
  via `""`, and no re-broadcast for an unchanged value.

## Gates

| gate | result |
|---|---|
| `npm run typecheck` | pass |
| `npm run test` (desktop) | 89 files / 564 tests pass |
| `cargo test -p bloblex-daemon` | pass (155 lib tests + smoke) |
| `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings` | pass |

The known flake `catalog_timeout_kills_the_child_and_failure_is_provider_unavailable`
did not fire.

## Director's UI layer (15 October 2026)

Written by the Director on top of the lane's logic layer. Web preview only; no release yet.

- **Looks.** Bitbots is the primary look and the default; Blobots is the alternative
  (the previous blob look). Both cards carry a "Primary" / "Alternative" tag
  (`ui/LookPicker.tsx`).
- **Palette.** Bitbots no longer has its own warm/orange palette. `ui/bitbots.css` now
  reads the neutral monochrome tokens from `theme.css`, so Bitbots follows light/dark
  and matches Blobots; only shape, type and the accent are its own.
- **Onboarding.** A new first step, "Choose your look" (`FirstRunOnboarding.tsx`,
  step -1): two cards, then a self-contained preview window (`ui/LookPreview.tsx`)
  opens and cross-fades between the looks. Picking applies the look live and saves
  `appearance.style`. Passing `initialStep` skips the step (tests and fixtures).
- **Settings.** Appearance gains "Look" (compact cards) and "Accent colour"
  (`ui/AccentPicker.tsx`: neutral, eight colours, a custom colour). The experimental
  Bitbots toggle is removed.
- **Accent.** `ui/accent.css` applies `--user-accent*` to the Blobots look; Bitbots
  reads it through `--bb-accent`. Neutral (no accent) keeps both monochrome.
- **Logo.** `assets/icon/*` and `apps/desktop/src/assets/bloblex-128.png` were
  regenerated from `bitbots.png` (file names are kept; they are identifiers).
- **Product name.** FIX9 renamed user-visible text; `productName` is now "Bitbots".
  Crate, package, bundle-identifier, data-directory, env and storage-key names were
  deliberately kept (see docs/history/fix-09/rename-report.md).

Open decisions: the word "blob" is still used for the characters in every look
(`ui/vocabulary.ts` exists for a later "bot" pass); changing `productName` makes the
NSIS installer a new install location next to the old Bloblex until the bundle
identifier and install-dir migration is decided.
