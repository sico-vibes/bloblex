# FIX23 report: Remote entry points on the desktop

Implemented 15 October 2026 in worktree `C:\fx34c`. Spec: `FIX23_REMOTE_ENTRY_SPEC.md`.
No commit. Gates: `npm run typecheck` clean; `npm run test` 119 files / 755 tests pass
(all green, no skips). This lane made no Rust change, so no cargo/clippy gate.

Files touched (all inside the spec's list plus its tests):

- new `apps/desktop/src/ui/RemoteChip.tsx`, `remoteChip.css`, `RemoteChip.mounted.test.tsx`
- `apps/desktop/src/remote/useRemote.ts` (new `useRemoteStatus` + `RemoteAvailability`)
- `apps/desktop/src/ui/ProfileMenu.tsx`, `ProfileMenu.mounted.test.tsx`
- `apps/desktop/src/ui/tour/tourSteps.ts`, `tour/GuidedTour.mounted.test.tsx`
- `apps/desktop/src/ui/settingsIndex.ts`, `settingsIndex.test.ts`
- `apps/desktop/src/ui/App.tsx` (two small insertions plus the palette item)

## 1. Sidebar chip — done

- `ui/RemoteChip.tsx` is a quiet one-line button rendered in `App.tsx` immediately above
  `<SidebarUsage/>` in the sidebar foot. It carries `data-tour="remote"` and opens
  Settings > Remote via `setSettingsInitialPage('Remote')`.
- Four states, exactly as specified:
  - **Off** (`enabled` false): "Remote off", hollow dot. The hollow mark is `StatusDot`
    with `status="waiting"` (the ring shape) recoloured to `--text-3` in `remoteChip.css`,
    so the shape says "nothing is happening" and the chrome stays monochrome.
  - **On and online**: "Remote on, 2 devices" (singular "1 device" handled) or
    "Remote on, no devices", working dot.
  - **Connecting or reconnecting**: "Remote connecting", working dot.
  - **Unavailable**: nothing is rendered at all.
- Data comes from a new `useRemoteStatus` hook in `src/remote/useRemote.ts`: it calls
  `remote.status` once on mount and re-reads it on any `remote.*` daemon event (40 ms
  debounce, same as `useRemote`), and it never asks for devices, security or activity. It
  reuses the same `available` contract as `useRemote` (`null` while loading, `false` when
  `remote.status` rejects). The listener call is wrapped so a build whose `tauri` mock has
  no `listenForDaemonEvents` (several existing tests) still loads its status.
- Tests: `RemoteChip.mounted.test.tsx` covers all four states, the hidden case, the
  `data-tour` attribute, the dot shape per state, and the event-driven re-read.

## 2. Profile menu entry — done

- `ui/ProfileMenu.tsx` renders a **Remote** item with the `Smartphone` icon directly after
  **Automations** and before **Settings**. It is gated on `available === true` from the same
  `useRemoteStatus` hook, so a real desktop build (where `remote.status` is `unsupported`)
  never shows it. App passes `onRemote` that opens Settings > Remote.
- Tests: `ProfileMenu.mounted.test.tsx` now asserts the item exists, sits after Automations,
  calls `onRemote` and closes the menu; and a second case proves it is absent when
  `remote.status` rejects.

## 3. Tour step — done

- `ui/tour/tourSteps.ts` gains a sixth step `remote` (`anchor: 'remote'`, `placement:
  'right'`) with the specified title, body (`{plural}` templated) and tip, appended after
  `companion`. The doc comment now says six stops.
- Tests updated in `GuidedTour.mounted.test.tsx`: the counts are now "1 of 6" and "6 of 6",
  the last step is index 5, and two new cases assert `steps` has six entries with `remote`
  last, and that the tour **ends** when the sixth (`remote`) anchor never appears — the
  existing skip behaviour, shown for this step.

**Honest note, for the Director.** The spec's claim "a build without remote simply has five
steps" holds for what the user *sees*, but not for the count label. `TourHost` renders no
progress label of its own and hardcodes no number; the label `N of M` lives in
`GuidedTour.tsx` and is `{index + 1} of {steps.length}`, and `steps` is the static six-entry
array, so the label reads "of 6" even in a build where the remote step is skipped at run
time. Nothing therefore needed changing under the spec's "if it hardcodes five" clause. Two
user-facing strings that *do* hardcode "Five quick stops" — the tour invite copy in
`GuidedTour.tsx` and the palette "Take the tour" subtitle in `App.tsx` — were left alone
because they are correct on a desktop build without remote and the spec's file list does not
include `GuidedTour.tsx`; flagging them here so the Director can decide whether to
availability-gate that copy.

## 4. Command palette and settings search — done

- `App.tsx` palette gains a **Remote devices** action next to **Change look**; choosing it
  opens Settings > Remote. (The palette entry is always present, like the other Settings
  shortcuts; the Settings page itself explains "Not in this build yet" on a build without
  remote.)
- `ui/settingsIndex.ts`: the three existing Remote entries already matched the group titles
  ("Remote access", "Add a device", "Safety"); added **Devices** (`Devices`, `Remote`) and
  **Recent activity** (`Recent activity`, `Remote`). Note the live heading is
  `Devices (N)`, so the index group string is "Devices" as specified and the search's
  exact-heading scroll simply falls back to the page top for that one entry.
- Tests: `settingsIndex.test.ts` gains a case proving `phone`/`mobile` find the Remote page
  and that the Devices and Recent activity entries exist alongside the three group titles.

## 5. Production build note — confirmed

`apps/desktop/vite.config.ts` declares no `build.rollupOptions.input`, so Vite builds the
default single entry, `index.html`. `remote.html` is only reachable through the preview
config (`vite.preview.config.ts`, a dev server) and is never referenced by the production
config. I built it to confirm rather than assert from the file alone:

```
npm run build --workspace @bloblex/desktop
ls apps/desktop/dist/*.html   ->  apps/desktop/dist/index.html   (only)
```

The `dist` output contains `index.html` and `assets/` and nothing else: no `remote.html`,
no remote chunk. `remote.html` was not added to the config. The build wrote only gitignored
`dist/`, so the diff is just the source changes above.

## Gate output

- `npm run typecheck` — clean (no output).
- `npm run test` — `Test Files 119 passed (119)`, `Tests 755 passed (755)`.
