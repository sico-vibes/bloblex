# FIX21: companion, second batch (peek, focus mode, snap, activity, chat, drop, presence)

> **What this is:** Spec for FIX21: the companion, second batch (peek, focus mode, snap, activity, chat, drop, presence).
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026. Completes the companion items of the approved polish plan
(`C:\Users\Sico Vibes\.claude\plans\resilient-wobbling-cookie.md`, items C7 to C10, C12, C13).
Read `DESIGN.md`. Use `entityNoun`/`useEntityNoun` (`ui/vocabulary.ts`) for "bot"/"blob".
Reuse what exists: `ui/CompanionAttention.tsx` (badge, queue), `ui/StatusDot.tsx`,
`ui/uiPrefs.ts` (`useHintSeen`), `ui/soundPrefs.ts`, `ui/ConnectionBanner.tsx`, `ui/Skeleton.tsx`,
`blob/soundCues.ts` (`playCompanionCue`). The companion is the `Companion` function in
`ui/App.tsx` (search `companion-root`), styles in `ui/companion.css`, layout constants in
`blob/companionLayout.ts`, state machine in `blob/companionFsm.ts`.

Keep edits inside the companion component, `companion.css` and new files; do not reformat or
move unrelated JSX (other lanes edit `App.tsx` elsewhere). Never commit; leave the diff and
write `docs/history/fix-21/report.md` with one line per item (done / partly / not done and why).

## C7. Completion peek and Focus mode

- A **peek** is a short banner in the compact (petit) bar: "`<Name>` finished. Open" for 4 s,
  then it returns to the normal status line. Open selects that bot and expands the island.
- Trigger: a bot **other than the focused one** whose main session goes from busy
  (`working`, `starting`) to `idle` or `completed` while the companion is visible. Never for
  the focused bot (its mood already shows it), never for failed turns (those use the existing
  error mood), never more than one peek per 10 s (coalesce: "3 bots finished").
- Plays the existing soft cue (`playCompanionCue('blip')`) only when sounds are enabled.
- **Focus mode**: new boolean setting `companion.focusMode` (default false). When on, peeks
  and their cue are suppressed; approvals and questions still show (they need the person).
  Add a switch to the companion settings view and to the main Settings sheet beside the
  companion sound row, both reading and writing through one helper (follow the pattern of
  `ui/soundPrefs.ts`). Register the key in the daemon/storage validation the same way
  `companion.soundsEnabled` is (read `crates/bloblex-storage/src/lib.rs` and
  `crates/bloblex-daemon/src/main.rs` settings validation; boolean only) with Rust tests, and
  mirror it in `preview/fixtureBridge.ts`.
- Pure helper `ui/companionPeek.ts`: `detectFinished(prev, next, focusedId)` returning the
  finished agent ids, with table tests.

## C8. Snap to edges and reset position

- After a drag ends, if the window is within 16 px of a screen edge or within 40 px of a
  corner, snap flush (with an 8 px margin) to that edge or corner. Pure geometry in
  `blob/companionSnap.ts` (`snapPosition(rect, workArea, threshold, margin)`) with tests.
- Wire it where the native window position is read or written (look at
  `src-tauri/src/lib.rs` `set_companion_mode` and the anchor code, and
  `ui/companionDrag.ts`). Use an existing command if one exists; add a small Rust command only
  if none can do it, with a test of the pure part.
- Remember the position per monitor name (the app already knows the monitor): store under a
  new setting `companion.positions` (object of monitor name to `{x, y}`, at most 8 entries,
  numbers only) with validation and tests.
- A **Reset position** button in the companion settings view and the main Settings companion
  group applies the start position the user chose ("Centre, near the bottom" and so on) and
  clears the remembered position for the current monitor.
- If the window code cannot be changed safely without a native build to test it, implement
  and test everything up to the command boundary and say precisely which call is unexercised.

## C9. Activity tab without the experiment flag

- The Activity view currently shows a message sending people to Settings unless the
  experimental "activity details" flag is on. Replace the message with a compact live
  summary that needs no flag: for each bot that is working, one row with its avatar,
  name and the current step title (`sessionSteps` in `CompanionTeam.tsx`), a `StatusDot`, and
  elapsed time; then up to three recent side conversations as today. The flag keeps adding the
  fuller step list. Empty state: "Nothing is running." Tests.

## C10. Chat polish

- "Load earlier": the chat shows the last 8 messages; add a **Load earlier** button at the top
  that reveals 8 more at a time while keeping the scroll position (anchor the first visible
  message). Disabled and hidden when everything is shown.
- Copy on hover or focus for each message (reuse the Copy action pattern in
  `ui/MessageActions.tsx`, 1.2 s "Copied" state).
- Do not auto-scroll to the bottom when the person has scrolled up to read; show a small
  "New messages" pill that scrolls down. Tests for the scroll logic with a stub element.

## C12. Drop zone

- Remove the open/close flicker: when a file is dragged over the companion, open to chat once
  and stay until the drag ends; a drag that leaves and re-enters within 250 ms must not
  collapse and re-expand (debounce the leave). Restore the previous view only after the drop is
  handled or the drag has been gone for 250 ms.
- The drop card shows the file name, type (extension) and size as chips, with a subtle
  animated dashed border (none under reduced motion).
- Tests for the debounce logic as a pure helper.

## C13. Remote presence

- Read `remote.status` through `rpc` (it exists only in the preview and the future daemon; on
  failure show nothing). In the companion settings view add a row "Remote" showing
  "Off", or "On, 2 devices connected" with a `StatusDot`, and a button that opens Settings >
  Remote (`onOpenSettings` with page `Remote`; read how the companion opens Settings today and
  extend it to take a page). No new daemon work. Test with a stubbed rpc.

## Gates

`npm run typecheck`, `npm run test`; `cargo test -p bloblex-storage -p bloblex-daemon` and
`cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings` if you touch
Rust. Add or update tests for every item.
