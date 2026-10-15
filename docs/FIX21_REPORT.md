# FIX21 report: companion, second batch (peek, focus mode, snap, activity, chat, drop, presence)

Implemented 15 October 2026 in worktree `C:\fx34a`. Spec: `FIX21_COMPANION_B_SPEC.md`.
No commit. Gates: `npm run typecheck` clean; `npm run test` 125 files / 804 tests pass;
`cargo test -p bloblex-storage -p bloblex-daemon` pass (storage 92, daemon 157 + 1 smoke);
`cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings` clean.

Note: the full `npm run test` run is intermittently flaky in two unrelated mounted files
(`App.agent.mounted.test.tsx` "shows every create validation message…" and
`App.analytics.mounted.test.tsx` "samples long conversations…") under parallel load; both pass
in isolation and on a clean re-run, and neither touches the companion.

New pure modules (each with its own tests): `ui/companionPeek.ts`, `ui/companionPrefs.ts`,
`blob/companionSnap.ts`, `ui/companionPositions.ts`, `ui/chatScroll.ts`, `ui/companionDrop.ts`.
New view code: `ui/CompanionPanels.tsx`. New mounted tests: `FIX21.companion.mounted.test.tsx`
(13 tests). Rust: boolean/object validation for `companion.focusMode` and `companion.positions`.

## 1. Completion peek and Focus mode (C7) — done

- `ui/companionPeek.ts`: `detectFinished(prev, next, focusedId)` (busy `working`/`starting` →
  `idle`/`completed`; the focused bot and failed turns excluded), `nextPeek` (one peek per 10 s,
  later finishes fold in), `peekText` ("`Name` finished." / "3 bots finished."). Table tests.
- `App.tsx` (`Companion`): a banner replaces the compact status line for 4 s;
  **Open** selects the finished bot and expands the island. The existing soft cue
  `playCompanionCue('blip')` plays once per peek (and is a no-op while sounds are off).
- `ui/companionPrefs.ts`: one store for `companion.focusMode` (default `false`) with
  `focusModeFromSettings`, `applyFocusMode`, `subscribeFocusMode`, `saveFocusMode`, following
  `ui/soundPrefs.ts`. When on, peeks and the cue are suppressed; approvals and questions still
  show. A switch lives in the companion settings view and beside the companion sound row in the
  main Settings sheet, both reading/writing through the helper.
- Rust: `companion.focusMode` is accepted only as a JSON boolean in
  `crates/bloblex-storage/src/lib.rs` and `crates/bloblex-daemon/src/main.rs` (added to the
  daemon's `validation_key` list), with tests in both crates.
- `preview/fixtureBridge.ts`: `?focus` mirrors the flag (`companion.focusMode`).
- Tests: `companionPeek.test.ts`, `companionPrefs.test.ts`, and the FIX21 mounted C7 cases
  (peek + Open, focused/failed exclusion, coalescing, focus suppression while approvals show,
  the settings switch and its write).

## 2. Snap to edges and reset position (C8) — partly

- `blob/companionSnap.ts`: `snapPosition(rect, workArea, threshold, margin)` — flush to an edge
  within 16 px, to a corner within 40 px (both axes), 8 px margin; table tests.
- `companion.positions` setting: `ui/companionPositions.ts` (`normalizeCompanionPositions` —
  at most 8 display-name keys, numbers only; `rememberCompanionPosition`/`forgetCompanionPosition`
  as pure helpers; `load`/`save`/`clearCompanionPosition` over `rpc`) with tests. Rust validation
  mirrors the shape in storage and daemon (`valid_companion_positions`) with tests.
- **Reset position** button in the companion settings view (new "Placement" section) and in the
  main Settings companion group. It clears the remembered position for the current monitor
  (`clearCompanionPosition`) and, unless the person chose "Where I left it", reapplies the start
  position by reusing the existing `setCompanionMonitor(currentMonitor)` command (bottom centre).
- **Not wired (and stated here as the unexercised boundary):** the drag-end snap itself and the
  live writer of `companion.positions`. Tauri owns the native window drag; there is no JS
  event when a drag ends, and the native window already persists its own per-monitor position in
  `companion-position.json` (`persist_companion_position`). Wiring `snapPosition` into the native
  `WindowEvent::Moved` handler — or having it write `companion.positions` — needs the desktop
  crate, which is excluded from the given gates and has no native build here. `snapPosition` is
  implemented and tested but not yet called from native; `set_companion_mode`/anchor code and
  `ui/companionDrag.ts` were left untouched.

## 3. Activity tab without the experiment flag (C9) — done

- `App.tsx`: the Activity view no longer tells people to open Settings. `CompanionPanels.tsx`
  `CompanionActivitySummary` shows one row per working bot — avatar, name, the current step title
  from `sessionSteps` (`CompanionTeam.tsx`), a `StatusDot`, and elapsed time tracked by
  `useWorkingSince` — then up to three recent side conversations as before
  (`CompanionTeamActivity`, unchanged). The Agent activity flag still adds the fuller step list.
- Empty state: "Nothing is running." Tests in the FIX21 mounted file and the updated
  `App.companion.mounted.test.tsx` activity assertion.

## 4. Chat polish (C10) — done

- **Load earlier**: the chat shows the last 8 messages; `earlierWindow` in `ui/chatScroll.ts`
  drives an 8-at-a-time "Load earlier" button that hides at the top and keeps the first visible
  message in place (a `useLayoutEffect` restores `scrollTop` from the anchored message).
- **Copy on hover or focus** per message: `CompanionCopyButton` in `CompanionTeam.tsx`, reusing
  the `MessageActions` Copy pattern with the 1.2 s "Copied" state and a clipboard guard.
- **No auto-scroll while reading**: `isNearBottom`/`metricsOf` gate the auto-scroll; a small
  "New messages" pill scrolls down. Tests: `chatScroll.test.ts` (stub element) and the mounted
  cases for load-earlier, copy and the pill.

## 5. Drop zone (C12) — done

- `ui/companionDrop.ts`: `advanceDropZone` / `dropZoneActive` phase machine (`idle`/`over`/
  `pending`) with a 250 ms leave grace; `dropChips` splits name, upper-case extension and size.
  Tests.
- `App.tsx`: the drag handler opens the chat once on enter, keeps the card through a quick
  leave-and-return, and restores the previous view only after the drop is handled or the drag has
  been gone for 250 ms. The card shows the file name, type and size chips.
- `companion.css`: `.drop-card.over::before` gets a subtle animated dashed border, disabled under
  `prefers-reduced-motion`. Mounted tests cover enter/leave/re-enter/collapse and the chips.

## 6. Remote presence (C13) — done

- `ui/CompanionPanels.tsx` `CompanionRemoteRow`: reads `remote.status` through `rpc` and renders
  nothing on failure; otherwise "Off" or "On, N devices connected" with a `StatusDot` and a
  button that opens Settings → Remote.
- `onOpenSettings` now takes an optional page: `tauri.ts` `showMainSettings(sessionId, page)`
  and `listenForOpenSettings(handler(page))`, the App handler sets the sheet's initial page, and
  `preview/fixtureBridge.ts` mirrors both. The page rides on a second global
  `bloblex-open-settings` emit after the native `show_main_settings` command (the desktop crate
  was not modified). `settingsIndex.ts` gained `SETTINGS_PAGE_NAMES` + `settingsPageFromEvent`
  with tests.
- Tests: the FIX21 C13 cases with a stubbed `rpc` (Off, On with count + dot + button, unavailable).

## Left / flagged for the Director

- **C8 is partly done**: geometry, the `companion.positions` store/validation and the Reset
  button are in; the drag-end snap call and the `companion.positions` writer are not wired
  because they are native-window concerns with no testable build here (see §2).
- The spec said to register `companion.focusMode` "the same way `companion.soundsEnabled` is";
  in fact `companion.soundsEnabled` has no explicit Rust validation today (it falls into the
  generic `companion.*` branch). I added a stricter, explicit boolean check for
  `companion.focusMode` and a structured check for `companion.positions`, plus tests.
- The Settings → Remote page is delivered by an extra event rather than by changing the native
  `show_main_settings` command (which would need the excluded desktop crate).
- I edited `CompanionTeam.tsx` (the copy button and the exported `sessionSteps` reuse) and
  `SettingsSheet.tsx` (the Focus mode / Reset position rows) as the spec required; no unrelated
  JSX was moved.
