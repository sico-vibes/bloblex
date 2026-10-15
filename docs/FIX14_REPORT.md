# FIX14 report: plain-language errors, connection resilience, first-scan recovery, undo

Lane: OpenCode `opencode-go/deepseek-v4.1-flash` (high effort). Worktree: this checkout only.
Not committed (the Director commits after review and gates).
Rust was not touched, so the clippy gate was not run.

Gates (from the repository root):

- `npm run typecheck` — pass
- `npm run test` — pass (100 files, 651 tests)

## Numbered sections

1. **Plain-language error copy — done.** New `apps/desktop/src/ui/errorCopy.ts` exports the
   `FriendlyError` interface exactly as specified and `friendlyError(raw)`, mapping the daemon
   and adapter codes and messages (`invalid_argument`, `provider_unavailable`, `unauthenticated` /
   `not_signed_in` / `unauthorized`, `rate_limited` / `overloaded`, `model_unavailable`,
   `timeout`, `process_exited`, `permission_denied`, `quota*`, `context*`, `not_found`, `conflict`,
   `internal`, `cancelled`, `provider_error`, `config_unsupported`, plus the adapter failure
   classes `provider`/`permission`/`budget`/`config`) and the safe runtime-probe sentences.
   Unknown input returns "Something went wrong. Try again." with a `retry`; raw provider text is
   never the title. Extra export `friendlyErrorText(raw)` joins title + detail for single-line
   callers. Table-driven tests in `errorCopy.test.ts`: 28 cases (25-row table + 3 behaviour tests).
2. **Offline and daemon-down banner — done (partly on one detail).** New
   `apps/desktop/src/ui/ConnectionBanner.tsx` renders one slim `role="status" aria-live="polite"`
   banner under the header from the existing `connection` state: "Reconnecting to Bitbots…" with a
   spinner and `Attempt N` once `attempts > 3`; "Bitbots could not be reached" with a **Retry now**
   button once a try has failed; a 1.5 s "Back online" confirmation on reconnect. `App.tsx` counts
   reconnection tries in the existing 3 s retry loop and marks a failure when tries ≥ 3 still left
   an error on a disconnected connection. The composer stays open for drafting; the textarea no
   longer uses the connection as its `disabled` reason, and Send is disabled with
   `title="Waiting for the connection"`. Four mounted tests cover the three states plus the
   back-online timeout. The one judgement call: "after a failure" is derived from
   `attempts ≥ 3 && error != null` because the daemon has no explicit "gave up" signal.
3. **First-scan recovery — done.** New `apps/desktop/src/ui/ScanRecovery.tsx` exports
   `CheckAgainButton` (remembers `Checked 12:41`, `aria-live` "Found {name}" / "Still not found")
   and the `ScanRecovery` block (per-provider install command, Copy, Check again). Used in
   `FirstRunOnboarding.tsx` step 1 (the Check again sits beside the existing install commands) and
   in Settings → Agents when a scan finds no agents. Scan errors pass through `friendlyError` in
   both places. Mounted test `ScanRecovery.mounted.test.tsx` covers a failed scan then a success,
   the Settings block, and the friendly error text.
4. **Uniform undo — done (with two documented choices).** New `apps/desktop/src/ui/undo.ts`
   provides `useUndoable(action, undo, label)` plus a small shared toast store
   (`useUndoToasts`, `removeUndoToast`, `pushUndoToast`, `resetUndoToasts`), built on the existing
   `.undo-toast` surface. `ExperimentalFeatures.UndoToasts` now makes each toast focusable,
   dismisses with Esc, and pauses its timer on hover and focus (resuming with the remaining time).
   Toast copy is the label plus the Undo button, e.g. `Archived 'Title'. Undo`. Used for: archive
   blob (`agent.delete` / `agent.restore`), delete conversation (existing
   `session.delete.schedule` / `session.delete.cancel`), rename blob (`agent.update` with the old
   name), move to project (`agent.team.update` with the previous `projectId`) and remove project
   (`project.delete`; Undo recreates the project via `project.create` and reassigns its blobs).
   `undo.mounted.test.tsx` has one test per action plus Esc and the focus/hover pauses.
   Two choices worth flagging: (a) the spec's "archive conversation" is implemented as the sidebar
   **Archive** action (the app has no conversation-archive control, and `TeamSidebar.tsx` is owned
   by another lane); (b) every undo toast still follows the existing `experiments.undo` switch,
   because the daemon's `session.delete.schedule` refuses unless `experimental.undo` is on and the
   existing App tests pin the archive dialog copy to that switch. With the switch on, all five
   actions now show the same toast.

## Call sites

- `errorCopy.ts` used by: `App.tsx` (`ActivityItem` failed-turn card, via `friendlyError`),
  `RuntimeProblemMarker.tsx` (tooltip title/detail; the raw probe sentence is behind a "Details"
  disclosure), `LaunchIntro.tsx` (`LaunchWarnings` summary), `ExperimentalFeatures.tsx`
  (`UndoToasts` error text via `friendlyErrorText`), `FirstRunOnboarding.tsx` (step 1 scan error),
  `ScanRecovery.tsx` (scan error).
- `ConnectionBanner` used by: `App.tsx` (under the chat header); `reconnect` attempts fed by the
  disconnected retry effect.
- `CheckAgainButton` used by: `FirstRunOnboarding.tsx` (each provider row, step 1),
  `ScanRecovery.tsx`; `ScanRecovery` used by `SettingsSheet.tsx` (Settings → Agents, empty scan).
- `useUndoable` used by: `App.tsx` — `archiveBlob`, `renameBlob`, `moveBlob`, `removeProject`,
  `deleteConversation`; `UndoToasts` rendered from the shared store in `App.tsx`.

## Files

New: `ui/errorCopy.ts`, `ui/errorCopy.test.ts`, `ui/ConnectionBanner.tsx`,
`ui/ConnectionBanner.mounted.test.tsx`, `ui/ScanRecovery.tsx`, `ui/ScanRecovery.mounted.test.tsx`,
`ui/undo.ts`, `ui/undo.mounted.test.tsx`.
Edited: `ui/App.tsx`, `ui/ExperimentalFeatures.tsx`, `ui/FirstRunOnboarding.tsx`,
`ui/LaunchIntro.tsx`, `ui/RuntimeProblemMarker.tsx`, `ui/SettingsSheet.tsx`, `ui/shell.css`,
`ui/settings.css`. No file owned by another lane was edited.
