# UI/UX polish wave (15 October 2026, unreleased)

Owner directive: implement the UI/UX recommendations, keep the role chip to the
right of a bot's name, and make the result feel premium. Not released; reviewed in
the browser preview first. Specs: FIX11 to FIX15.

## What changed

| Area | Change | Where |
|---|---|---|
| Identity | Installer, executables, bundle id, data migration | FIX11, `src-tauri/src/migrate.rs`, `installer-hooks.nsh` |
| Wording | bot in Bitbots, blob in Blobots, live | FIX12, `ui/vocabulary.ts` |
| Preferences | `appearance.density`, `hints.seen`, `onboarding.tour` | FIX13, `ui/uiPrefs.ts` |
| Tour | 5-step spotlight tour, invite for existing users, replay | `ui/tour/*`, profile menu, palette |
| Hints | One-time pointers (permission, plan, context, bot-to-bot), one at a time | `ui/tour/ContextualHints.tsx` |
| Settings | Appearance page with live preview, search, density | `SettingsSheet.tsx`, `settingsIndex.ts` |
| Sidebar | Usage meter (most pressing window), selected-row marker | `SidebarUsage.tsx`, `polish.css` |
| Approvals | Command block with copy, tool chip, live expiry | `ApprovalCard.tsx`, `approval.css` |
| Plan | Checklist with progress once steps are carried out | `TeamMessages.tsx`, `planProgress.ts` |
| Conversation | Message actions order, expandable delegation chips, retry | FIX15 |
| Roster | Pointer and keyboard reorder, move to project | FIX15 |
| Resilience | Plain-language errors, reconnect banner, scan recovery, uniform undo | FIX14 |
| Polish | Press feedback, eased popovers, composer focus, numerals, pixel details | `polish.css`, `bitbots.css` |
| Status | One status mark with shape plus label | `StatusDot.tsx` |

## Verified

Desktop typecheck, 689 tests. Daemon, storage and clippy gates were green after
FIX12 (no Rust changes since, except FIX11's migration tests, which pass:
`cargo test -p bloblex-desktop migrate::`). Browser preview: tour (all five stops,
dim and arrow), hints, Appearance page, accent, both looks, light mode.

## Not verified

- The installer, the pre-install hook and the migration on a real machine with a
  Bloblex install (see FIX11_REPORT.md for the checklist).
- Native windows (companion, tray, dictation).
- Pointer drag on the roster in WebView2 (tested with synthetic events only).
- Companion needs-you count badge: not built.
