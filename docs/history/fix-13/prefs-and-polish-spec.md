# FIX13: UI preferences plumbing, then a batch of small polish items

> **What this is:** Spec for FIX13: UI preferences plumbing, then a batch of small polish items.
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026. Owner directive: implement the UI/UX recommendations.
Product is Bitbots; the characters are "bots" in Bitbots and "blobs" in Blobots
(`ui/vocabulary.ts`, `entityNoun`, `useEntityNoun`; another lane may still be
landing that wording, so use the helper for any new noun and never hard-code
"blob" or "bot").

Read `docs/design/design-system.md` first. Rules that matter here: say each thing once; monochrome
chrome (colour only for status that needs attention); only the tokens in
`theme.css`; type scale 11 to 22 px; the **role chip stays on the right of a bot's
name in the sidebar row, do not move or restyle it**.

Do part A first and write its final API into `docs/history/fix-13/report.md` as soon as it
is done (the Director codes against it). Then part B.

## Part A: preferences plumbing (logic, no visuals)

Three new daemon settings, validated in `crates/bloblex-storage/src/lib.rs` next to
`appearance.style`, broadcast like the other `appearance.*` / window-level
preferences, with Rust tests (valid, invalid, unset, broadcast):

| key | value | default |
|---|---|---|
| `appearance.density` | `"compact"`, `"default"` or `"roomy"` | unset = `"default"` |
| `hints.seen` | array of at most 64 strings, each `[a-z0-9._-]{1,48}` | unset = `[]` |
| `onboarding.tour` | object `{ version: integer 0..=999, done: boolean, step: integer 0..=20 }` | unset = `{version:0,done:false,step:0}` |

Add `apps/desktop/src/ui/uiPrefs.ts` mirroring the pattern of `blob/bitbots.ts`
(in-window mirror, localStorage first-paint cache under `bitbots.density`,
`bitbots.hints`, `bitbots.tour`, every storage access in try/catch):

```ts
export type Density = 'compact' | 'default' | 'roomy'
export function density(): Density
export function setDensity(next: Density): void      // sets <html data-density>, cache, listeners
export function useDensity(): Density

export function hintSeen(id: string): boolean
export function markHintSeen(id: string): void       // adds, caps at 64 (drops oldest), cache, listeners
export function useHintSeen(id: string): [seen: boolean, mark: () => void]
export function resetHints(): void

export interface TourState { version: number; done: boolean; step: number }
export const TOUR_VERSION: number                    // 1
export function tourState(): TourState
export function setTourState(next: Partial<TourState>): void
export function useTourState(): TourState
```

Persistence: a `persist*` helper per setting that calls `rpc('settings.set', ...)`
(import `rpc` from `../tauri`; swallow failures, the cache already holds the value).
Wire hydration from the daemon next to where `appearance.style` is applied in
`ui/App.tsx` (initial settings load and the `settings.changed` handler), and make
the companion window follow the same three keys. Invalid values from the daemon are
ignored. Add the keys to the fixture bridge (`preview/fixtureBridge.ts`).
Unit tests for every function (defaults, cache, invalid input, listener firing).

## Part B: polish items (small UI, follow docs/design/design-system.md)

Each item has an acceptance line; add or update a mounted test per item where one
fits. Do not restyle anything not listed.

1. **Disabled model and effort pills read as broken.** In
   `SessionExecutionControls.tsx` / `ComposerExecutionSwitch.tsx`, while no model is
   chosen show the label "Pick a model" (not "Choose a model") and give the pill a
   tooltip "Choose which model this conversation uses". The greyed effort pill reads
   "Effort" with the tooltip "Available after you pick a model". Accept: a test for
   both labels.
2. **Bitbots titles in light mode.** In `ui/bitbots.css`, headings and
   `.chat-title-text` below 16 px use weight 900 of Doto in light mode so they are
   not pale; verify contrast of `--text-1` on `--surface-app` is unchanged.
3. **Profile row.** `ProfileMenu.tsx`: when a name is set show initials and the name
   with "On this device"; when not set show "Set your name" as the second line and
   make the whole row open the name editor. Accept: tests for both.
4. **Starter chips.** In the empty conversation state (`.session-first-state` in
   `App.tsx`, "Ready when you are") show up to three ghost buttons that put text in
   the composer without sending: "Review this repository", "Find and fix a failing
   test", "Explain how this project is organised". Hidden once the draft is not
   empty. Accept: click fills the composer, focus moves to it, nothing is sent.
5. **Context ring label.** `ContextWindowIndicator.tsx`: the tooltip and
   `aria-label` read "NN% of the context window used"; at 75% or more the ring uses
   the warning status colour and the tooltip adds "Consider starting a new
   conversation". Accept: tests at 40, 75 and 95 percent.
6. **Plain-language effort.** Where effort levels are listed (`effortLabels.ts`,
   `SessionExecutionControls.tsx`) show one short line under each level:
   Low "Fast, light reasoning", Medium "Balanced", High "Slower, more thorough",
   Extra high / Max "Slowest, deepest", Ultracode keeps its own wording. Accept:
   lines render in the menu and are in `aria-description`.
7. **Companion first-run hint.** First time the companion window is shown, show a
   one-line hint inside it: "Drag me anywhere. Ctrl+Alt+B shows or hides me." with a
   Got it button. Uses `useHintSeen('companion.drag')`. Accept: hint appears once.
8. **Sound preview.** `SoundVolumeSlider.tsx`: after the slider is released play one
   short cue at the new volume through the existing preview path
   (`bloblex-sound-volume-changed` with `preview: true`); add a small "Play sample"
   ghost button in the row. Accept: button triggers the preview event.
9. **Accessible names with state.** Avatars announce the character's state: in
   `BlobCanvas`/`BitbotCanvas` the `aria-label` is "`<name>`, `<state>`" (for
   example "Atlas, working") wherever a name prop exists; decorative uses stay
   `aria-hidden`. Accept: test on the roster row.
10. **Reduced motion audit.** With `prefers-reduced-motion: reduce`: no looping CSS
    animation anywhere (grep `animation:` in `ui/*.css` and add a single guarded
    override per file), avatars hold a still pose, the preview window and tour
    (when it lands) do not slide. Accept: a mounted test that asserts the media
    query override exists for the three loops found.
11. **Transitions in Bitbots.** `bitbots.css` forces `steps(4)` on everything. Keep
    it for small things (hover, toggles, chips) but use `ease-out` for panels,
    dialogs, menus and the preview (`.settings-sheet`, `.blob-dialog`, `.menu-surface`,
    `.select-menu`, `.quick-switcher`, `.look-preview`, `.sp-window`). Accept: those
    selectors have an explicit eased `transition-timing-function`.

## Gates

`npm run typecheck`, `npm run test`, `cargo test -p bloblex-storage -p bloblex-daemon`,
`cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`.
Never commit. Leave the diff and write `docs/history/fix-13/report.md`: final API of part A
first, then one line per part B item (done / partly / not done and why).
