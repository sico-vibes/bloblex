# FIX13 report: UI preferences plumbing + polish batch

Lane: OpenCode `opencode-go/deepseek-v4.1-flash` (high effort). Worktree: this checkout only.
Not committed (the Director commits after review and gates).

Gates (all run from the repository root unless stated):

- `npm run typecheck` — pass
- `npm run test` — pass
- `cargo test -p bloblex-storage -p bloblex-daemon` — pass
- `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings` — pass

## Part A — preferences plumbing (final API)

Written first, before part B, so the Director can code against it.

### Daemon settings (`crates/bloblex-storage/src/lib.rs`)

Three new window-level settings, validated in `Storage::set_setting` and broadcast as
`settings.changed` through the existing `appearance.*` branch (now also matching
`hints.*` and `onboarding.*`).

| key | value | default when unset |
|---|---|---|
| `appearance.density` | `"compact"` \| `"default"` \| `"roomy"` (string) | `"default"` |
| `hints.seen` | array of at most 64 ids matching `[a-z0-9._-]{1,48}` | `[]` |
| `onboarding.tour` | object `{ version: 0..=999, done: boolean, step: 0..=20 }` (all fields required) | `{ version: 0, done: false, step: 0 }` |

Validation helpers: `valid_hints_seen`, `valid_hint_id`, `valid_tour_state`. An invalid
value returns `StorageError::InvalidAgent`. The daemon's `settings.set` `validation_key`
list in `crates/bloblex-daemon/src/main.rs` now includes the three keys so a storage
rejection is reported as `invalid_argument` rather than `internal`.

Rust test `ui_preference_settings_validate_default_and_announce_their_changes` covers
valid values, the unchanged-value case, unset (fresh DB stores nothing), the broadcast
payloads, and every invalid shape.

### `apps/desktop/src/ui/uiPrefs.ts` (new)

Mirrors `blob/bitbots.ts`: an in-window value, a localStorage first-paint cache, a
listener set, and `useSyncExternalStore` hooks. Every storage access is guarded.

First-paint cache keys: `bitbots.density`, `bitbots.hints`, `bitbots.tour`.

Exported API (exactly as specified, plus three daemon-hydration helpers):

```ts
export type Density = 'compact' | 'default' | 'roomy'

export function density(): Density
export function setDensity(next: Density): void       // sets <html data-density>, cache, listeners, persists
export function useDensity(): Density

export function hintSeen(id: string): boolean
export function markHintSeen(id: string): void        // adds, caps at 64 (drops oldest), cache, listeners, persists
export function useHintSeen(id: string): [seen: boolean, mark: () => void]
export function resetHints(): void

export interface TourState { version: number; done: boolean; step: number }
export const TOUR_VERSION: number                     // 1
export function tourState(): TourState
export function setTourState(next: Partial<TourState>): void
export function useTourState(): TourState

// Extra, for daemon hydration only (see below); ignore invalid values, never persist.
export function hydrateDensity(value: unknown): void
export function hydrateHints(value: unknown): void
export function hydrateTour(value: unknown): void
export function isDensity(value: unknown): value is Density
```

Behaviour notes:

- `setDensity` writes `<html data-density>`, the cache, then notifies and calls
  `rpc('settings.set', { key: 'appearance.density', value })` (failures swallowed).
  An invalid value, or the same value, is a no-op.
- `markHintSeen` ignores duplicate ids, appends, keeps the last 64 (oldest dropped), and
  persists the whole list. `resetHints` empties the list and persists `[]`.
- `setTourState` merges a partial into the current state, validates the merge, ignores an
  invalid or unchanged result, then persists `onboarding.tour`.
- The `hydrate*` helpers are what `App.tsx` calls for `settings.get` and
  `settings.changed`. They validate and drop invalid input, update the mirror and cache,
  and notify listeners **without** echoing a write back to the daemon. `hydrateHints([])`
  clears the mirror, so a daemon that has no hints resets the local list.
- Unit tests: `uiPrefs.mounted.test.tsx` (defaults, set/cache/attribute/persist, invalid
  input, listener re-render, 64-cap, reset) and `uiPrefsCache.mounted.test.ts` (cache read
  on a fresh module load, stale/invalid cache ignored).

### Wiring

- `apps/desktop/src/ui/App.tsx`: `applyWindowSetting` now handles `appearance.density`,
  `hints.seen` and `onboarding.tour` via the `hydrate*` helpers, and the initial
  `settings.get` key list includes all three. Because the companion window runs the same
  `App` code path, it follows the same three keys.
- `apps/desktop/src/preview/fixtureBridge.ts`: preview flags `?density=`, `?seen-hints`
  and `?tour` seed the three keys through `settings.get`.

## Part B — polish items

Each line: status, what changed, and the test that covers it.

1. **Disabled model and effort pills** — done.
2. **Bitbots titles in light mode** — done.
3. **Profile row** — done.
4. **Starter chips** — done.
5. **Context ring label** — done.
6. **Plain-language effort** — done.
7. **Companion first-run hint** — done.
8. **Sound preview** — done.
9. **Accessible names with state** — done.
10. **Reduced motion audit** — done.
11. **Transitions in Bitbots** — done.
