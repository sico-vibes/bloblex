# FIX10: theme style (Bitbots / Blobots) and user accent colour, logic layer

> **What this is:** Spec for FIX10: theme style (Bitbots and Blobots) and the user accent colour, logic layer.
> **Status:** superseded in part by [themes-spec.md](../fix-40/themes-spec.md)
> **Last updated:** 2026-10-15

Written 15 October 2026. Owner directive. The app is now **Bitbots**.

- **Bitbots** is the primary look (the pixel-robot theme that is today the
  experimental `experimental.bitbots` toggle) and the default.
- **Blobots** is the secondary look: the previous blob theme, renamed.
- The look is chosen during onboarding and in Settings.
- A new **accent colour** setting applies to both looks.

This spec is the non-visual layer. The Director writes all CSS, the onboarding
step, the preview window and the Settings rows against the contract in section 2.
Do not edit `*.css`, `FirstRunOnboarding.tsx`, `SettingsSheet.tsx`, `LaunchIntro.tsx`,
or any new `StyleStep*` files. Product-name copy is being renamed by another lane
(FIX9); do not do that here.

## 1. Settings

Two new daemon settings, validated in the `settings.set` handler
(`crates/bloblex-daemon/src/main.rs`), persisted like the other `appearance.*`
settings, and broadcast as `settings.changed` like the others:

| key | value | default |
|---|---|---|
| `appearance.style` | `"bitbots"` or `"blobots"` | unset = `"bitbots"` |
| `appearance.accent` | `""` (neutral default) or a `#rrggbb` hex string (lower-case) | unset = `""` |

- Any other value is `invalid_argument` (same pattern as the boolean settings).
- Migration: when `appearance.style` is unset and `experimental.bitbots === true`,
  the effective style is `bitbots`; unset with anything else is also `bitbots`.
  `experimental.bitbots` stays readable for this and is no longer shown in the
  Experiments list (remove it from `EXPERIMENTS`/the list if it is registered
  there; the Director removes the toggle UI).
- `settings.get`/`settings.list` expose both keys like other settings. Add Rust
  tests next to the existing settings tests (valid, invalid, unset, broadcast).

## 2. Front-end contract (the Director codes against exactly this)

In `apps/desktop/src/ui/appearance.ts`:

```ts
export type ThemeStyle = 'bitbots' | 'blobots'
export const THEME_STYLES: readonly ThemeStyle[] = ['bitbots', 'blobots']
export function isThemeStyle(value: unknown): value is ThemeStyle
export function normalizeAccent(value: unknown): string        // '' or '#rrggbb' lower-case; anything else ''
export function accentTokens(hex: string): {
  accent: string          // the hex itself
  pressed: string         // ~12% darker
  soft: string            // rgba(r,g,b,.14)
  ink: string             // '#0f0f10' or '#ffffff', whichever has WCAG contrast >= 4.5 on `accent`
}
export function contrastRatio(a: string, b: string): number    // WCAG 2.x, hex inputs
```

In `apps/desktop/src/blob/bitbots.ts` keep the existing exports
(`bitbotsEnabled`, `setBitbotsEnabled`, `useBitbots`, `robotStateFor`) working and
add:

```ts
export function themeStyle(): ThemeStyle
export function setThemeStyle(next: ThemeStyle): void   // updates cache, <html>, listeners
export function useThemeStyle(): ThemeStyle
export function accentColor(): string                    // '' = neutral default
export function setAccentColor(hex: string): void        // normalizes; '' clears
export function useAccentColor(): string
```

Semantics:

- `bitbotsEnabled()` is `themeStyle() === 'bitbots'`; `setBitbotsEnabled(b)` calls
  `setThemeStyle(b ? 'bitbots' : 'blobots')`. `useBitbots()` stays a boolean.
- **Default is `'bitbots'`** (changed from false). First paint cache in
  localStorage key `bitbots.style` (`'bitbots' | 'blobots'`); if absent, read the
  legacy key `bloblex.bitbots` (`'1'` bitbots, `'0'` blobots); else `'bitbots'`.
  Keep writing nothing to the legacy key.
- Document attributes on `<html>`: `data-style="bitbots|blobots"` always set;
  `data-bitbots="on"` set only for bitbots (existing CSS depends on it) and removed
  for blobots. The Bitbots stylesheet and fonts load lazily exactly as today and
  only for bitbots.
- Accent: when non-empty set inline custom properties on `<html>`:
  `--user-accent`, `--user-accent-pressed`, `--user-accent-soft`,
  `--user-accent-ink` (from `accentTokens`) and `data-accent="custom"`; when empty
  remove all four and the attribute. Cache in localStorage key `bitbots.accent`
  and apply it at module load so first paint matches.
- `ThemeChoice` (light/dark/system) is unchanged and independent of style.

## 3. Wiring

- `apps/desktop/src/ui/App.tsx`: where `experimental.bitbots` is applied from the
  daemon (`applyWindowSetting` ~line 167 and the list ~line 427) add
  `appearance.style` -> `setThemeStyle` (ignore invalid values) and
  `appearance.accent` -> `setAccentColor`. Keep `experimental.bitbots` as a
  fallback only when `appearance.style` has never been set.
- Companion window and every other surface must receive the same two settings
  (same code path as `appearance.theme`).
- `apps/desktop/src/preview/fixtureBridge.ts`: fixture settings accept
  `appearance.style` / `appearance.accent`; a URL flag `?style=blobots` and
  `?accent=%23rrggbb` seed them so the browser preview can show either look.
  Replace the old `bitbots` flag handling so `?flag=bitbots` is no longer needed.

## 4. Vocabulary helper

Add `apps/desktop/src/ui/vocabulary.ts`:

```ts
export function entityNoun(style: ThemeStyle, options?: { plural?: boolean; capital?: boolean }): string
// bitbots -> 'bot' / 'bots'; blobots -> 'blob' / 'blobs'
export function useEntityNoun(options?): string // reads useThemeStyle
```

No call sites other than tests; the Director adopts it in the UI.

## 5. Tests

- `appearance.test.ts`: `normalizeAccent`, `accentTokens` (ink contrast >= 4.5
  for white, black, #e17a56, #3b82f6, #facc15), `contrastRatio` known values.
- `bitbots.test.ts`: default bitbots, cache read, legacy key, `setThemeStyle`
  toggles `data-bitbots`, accent sets/removes the four properties.
- Update existing tests that assumed Bitbots is off by default.
- Rust settings tests (section 1).

## 6. Gates

`npm run typecheck`, `npm run test` (desktop), `cargo test -p bloblex-daemon`
(settings tests), `cargo clippy --workspace --exclude bloblex-desktop
--all-targets -- -D warnings`. Known flake:
`catalog_timeout_kills_the_child_and_failure_is_provider_unavailable`. Never commit.
Leave the diff in the working tree and write `docs/history/fix-10/report.md` with the
final API as built.
