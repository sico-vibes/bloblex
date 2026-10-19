# FIX20 report: companion keyboard access, offline banner, mood labels

> **What this is:** Report on FIX20: companion keyboard access, offline banner and mood labels.
> **Status:** historical
> **Last updated:** 2026-10-15

Implemented 15 October 2026 in worktree `C:\fx33e`. Spec: `docs/history/fix-20/companion-access-spec.md`.
No commit. Gates: `npm run typecheck` clean; `npm run test` 109 files / 697 tests pass.
Rust untouched (`git diff --name-only -- '*.rs'` empty), so no cargo/clippy gate.

## 1. Focus and keyboard (C5) — done

- `companion.css`: one `:focus-visible` block gives `.island-header .tab`, `.peer`,
  `.compact-bot`, `.compact-copy`, `.island-actions > button`, `.companion-collapse`, `.btn`,
  the pin toggles (`.team-picker-pin`) and the adjacent controls `outline: none;
  box-shadow: var(--focus-ring)` — the same ring as the rest of the app, never a bare
  `outline: none`.
- `App.tsx`: `.compact-copy` is now a real `<button type="button" aria-label="Open companion
  home">` with the same flat look (CSS keeps it unbuttoned).
- `App.tsx`: a `keydown` listener in the companion `Companion` component (its own window
  document, so it is live only while that window has focus) maps `Ctrl+1`..`Ctrl+4` to the
  first four `.peer-grid .peer` buttons and `N` to the next `state-waiting` peer, and does
  nothing while an `input`/`textarea`/contenteditable has focus.
- `CompanionTeam.tsx`: `aria-keyshortcuts` (`Control+1`, and ` N` for a waiting peer) on each
  peer button — a single attribute insertion, no layout change.
- Tests: `FIX20.companion.mounted.test.tsx` ("makes the compact name area a real button…",
  "gives every companion control the app focus ring…", "focuses the first four teammates…").
  Also updated `App.companion.mounted.test.tsx`: the name/status are interactive now, so they
  assert no drag region on `.compact-copy` instead of the old stamped drag region.

## 2. Offline and error banner with Retry (C6) — done

- `App.tsx`: the existing `ConnectionBanner` renders inside the expanded island under the
  header, with `attempts`/`failed` from the window and `onRetry` calling the main window's
  `retryConnection` (the same `setReconnectAttempts(0)` + `refresh()` path). `companion.css`
  scopes the banner to the island width. The compact window is only 62 px tall and keeps its
  one-line status, so the banner is an expanded-view element; the status line still shows the
  problem while collapsed.
- `App.tsx`: the shared error line (`fileError ?? dropError ?? appError`) is dismissible — an X
  button (`aria-label="Dismiss error"`) and Escape while the line is focused — and clears
  itself after 8 seconds while the daemon is reachable (a disconnected daemon stays). The
  compact status line uses the same dismissed-aware value, so one gesture clears both.
- Tests: `FIX20.companion.mounted.test.tsx` ("shows the daemon banner and offers the main
  window Retry…", "confirms Back online…", "dismisses the shared error line with the X or
  Escape and clears it after 8 seconds").

## 3. Mood labels and one sound source (C11) — done

- `companionStatus.ts`: new `COMPANION_COMPACT_MOOD_LABELS` (`sleeping` "Sleeping",
  `rate_limited` "Rate limited", `error` "Something failed", `offline` "Offline") and
  `compactMoodLabel(mood)`. The descriptive `deriveCompanionStatus` labels are unchanged.
- `App.tsx`: the compact status line shows the short mood word for those four moods, ahead of
  the activity text but behind a live error.
- New `soundPrefs.ts`: one store + one key pair (`companion.soundsEnabled`,
  `companion.soundVolume`) with `soundPrefsFromSettings`, `applySoundPrefs`,
  `subscribeSoundPrefs`, `saveSoundsEnabled`, `saveSoundVolume(volume, preview)` and
  `previewSoundVolume`. Both the companion settings view (`App.tsx`) and the main Settings
  sheet (`SettingsSheet.tsx`) read and write through it and subscribe to it, and it still
  broadcasts the same `bloblex-sounds-changed` / `bloblex-sound-volume-changed` events for the
  other window, so the two controls cannot disagree.
- Tests: `FIX20.companion.mounted.test.tsx` ("shows the short mood label…", "keeps the
  companion switch and the main Settings sheet on one value"). Existing
  `SettingsSheet.companionSound.mounted.test.tsx` and the companion sound tests still pass.

## Left / flagged for the Director

- `CompanionTeam.tsx` was in the do-not-touch list, but the spec also asked for
  `aria-keyshortcuts`; I made only that one-attribute insertion and did not change peer layout.
- The offline banner is in the expanded island only (the 62 px compact window cannot hold it);
  say the word if you want a compact-bar Retry affordance too.
- The shared error line now uses chat priority (`fileError` before `appError`) in the compact
  bar as well as the chat, so the two always read the same string.
