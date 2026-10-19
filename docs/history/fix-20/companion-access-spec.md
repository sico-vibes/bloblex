# FIX20: companion keyboard access, offline banner, mood labels

> **What this is:** Spec for FIX20: companion keyboard access, offline banner and mood labels.
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026. Mechanical companion polish. Read `DESIGN.md`. Use
`entityNoun`/`useEntityNoun` (`ui/vocabulary.ts`) for "bot"/"blob". The companion component
is in `apps/desktop/src/ui/App.tsx` (search for `companion-root`), with
`ui/CompanionTeam.tsx`, `ui/companion.css`, `ui/companionStatus.ts`.

Another change (the Director's "needs you" badge, approval queue and roomier approval) is
being made at the same time in the same component. **Keep your edits in `companion.css`, new
files, and the smallest possible insertions in `App.tsx`; do not reformat or move existing
JSX.** Do not touch `ApprovalCard`, `CompanionTeam.tsx` peer layout, or any file under
`ui/tour`.

## 1. Focus and keyboard (C5)

- `:focus-visible` rules in `companion.css` for `.tab`, `.peer`, `.compact-bot`,
  `.island-actions button`, `.companion-collapse`, `.btn`, and the pin toggles: the same
  ring as the rest of the app (`var(--focus-ring)`), never `outline: none` without a
  replacement.
- The compact bar's name area (`.compact-copy`) is a `div` with a click handler: make it a
  real `button` (type="button") with the same look, `aria-label` "Open companion home".
- Companion shortcuts, registered only while the companion window has focus: `Ctrl+1`..`Ctrl+4`
  focus the first four teammates in the peer grid, `N` focuses the next teammate that is
  waiting for the person (skip when typing in an input). Add `aria-keyshortcuts` where it fits.
- Tests: mounted test for the button, the shortcuts and the focus ring rule being present.

## 2. Offline and error banner with Retry (C6)

- When the connection to the daemon is down, show the existing `ConnectionBanner` pattern
  (look at `ui/ConnectionBanner.tsx`) inside the companion, with a Retry button that calls the
  same reconnect path the main window uses. Keep the companion's own copy short.
- The shared error line (`appError`, `fileError`, `dropError`) becomes dismissible (an X
  button, Esc when focused) and clears itself after 8 seconds for non-blocking errors.
- Tests for banner states and dismissal.

## 3. Mood labels and one sound source (C11)

- In the compact bar show a short text label under the name for `sleeping` ("Sleeping"),
  `rate_limited` ("Rate limited"), `error` ("Something failed"), `offline` ("Offline") using
  the labels already in `ui/companionStatus.ts` if present, otherwise add them there.
- The sound toggle and volume exist in both the companion settings view and the main Settings
  sheet. Keep both controls but make them read and write the **same** persisted setting through
  one helper (`ui/soundPrefs.ts`, new) so they can never disagree; add a test that changing one
  is reflected by the other.

## Gates

`npm run typecheck`, `npm run test`. Never commit. Leave the diff and write
`docs/history/fix-20/report.md` (one line per numbered item: done / partly / not done and why).
