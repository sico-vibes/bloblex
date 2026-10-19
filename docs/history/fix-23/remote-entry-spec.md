# FIX23: Remote entry points on the desktop (sidebar chip, profile menu, tour step)

> **What this is:** Spec for FIX23: Remote entry points on the desktop (sidebar chip, profile menu, tour step).
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026. Completes the Remote mock deliverables from the approved plan: the
sidebar chip, the profile-menu entry and a Remote pointer in the tour. Read `docs/design/design-system.md`,
`docs/remote/UX_FLOWS.md` (section 1.7) and `apps/desktop/src/remote/remoteContract.ts`.
Another lane edits the companion and another the bot editor; keep your edits inside the
files named here and small insertions in `ui/App.tsx`. Never commit; leave the diff and write
`docs/history/fix-23/report.md`.

## 1. Sidebar chip

- New `ui/RemoteChip.tsx`, rendered above the usage meter in the sidebar footer region
  (`<SidebarUsage .../>` in `App.tsx`): a quiet one-line button.
  - Off: "Remote off" with a hollow `StatusDot`; hidden entirely when the platform has no
    remote support (the `remote.status` RPC fails) so a real desktop build shows nothing.
  - On and online: "Remote on, 2 devices" (or "Remote on, no devices") with the working dot.
  - Connecting or reconnecting: "Remote connecting".
  - Click opens Settings on the Remote page (`setSettingsInitialPage('Remote')`).
- Data: `remote.status` once on mount and on `remote.*` daemon events (reuse the
  `useRemote` hook in `src/remote/useRemote.ts` or a lighter status-only hook there).
- Add `data-tour="remote"` to the chip.
- Tests: the four states and the hidden case.

## 2. Profile menu entry

In `ui/ProfileMenu.tsx` add a **Remote** item (icon `Smartphone`) after Automations that opens
Settings > Remote; hidden when remote is unavailable (same availability check). Update the
menu's tests.

## 3. Tour step

In `ui/tour/tourSteps.ts` add a sixth step `remote` (anchor `remote`, placement `right`):
title "Reach your bots from anywhere", body "Turn on Remote in Settings to chat with your
{plural} from a phone or another browser. You choose which devices, and what they may do.",
tip "Off by default. Nothing connects until you say so." The tour already skips a step whose
anchor is absent, so a build without remote simply has five steps. Update the tour tests (step
count with and without the anchor) and `TourHost`'s progress label if it hardcodes five.

## 4. Command palette and settings search

- Palette actions: "Remote devices" (opens Settings > Remote) next to "Change look".
- `ui/settingsIndex.ts` already has Remote entries; check they match the group titles
  ("Remote access", "Add a device", "Safety") and add "Devices" and "Recent activity".

## 5. Production build note

`apps/desktop/remote.html` and `src/remote/*` are preview-only. Confirm
`npm run build --workspace @bloblex/desktop` does not include `remote.html` (it is not in
`vite.config.ts` inputs) and say so in the report. Do not add it.

## Gates

`npm run typecheck`, `npm run test`.
