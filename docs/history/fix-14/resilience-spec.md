# FIX14: plain-language errors, connection resilience, first-scan recovery, undo

> **What this is:** Spec for FIX14: plain-language errors, connection resilience, first-scan recovery and undo.
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026. Owner directive: implement the UI/UX recommendations.
Read `DESIGN.md` first (quiet, monochrome, say each thing once; colour only for
status that needs attention). Use `entityNoun`/`useEntityNoun` (`ui/vocabulary.ts`)
for "bot"/"blob", never a literal. Do not move or restyle the role chip in the
sidebar row. Files owned by other lanes: `ui/SessionExecutionControls.tsx`,
`ui/ProfileMenu.tsx`, `ui/ContextWindowIndicator.tsx`, `ui/SoundVolumeSlider.tsx`,
`ui/uiPrefs.ts`, `ui/MessageActions.tsx`, `ui/TeamMessages.tsx`, `ui/TeamSidebar.tsx`.
Edit `App.tsx` only in the regions you need.

## 1. Plain-language error copy

New `apps/desktop/src/ui/errorCopy.ts`:

```ts
export interface FriendlyError {
  title: string                       // one short sentence, no provider jargon
  detail?: string                     // optional second sentence
  action?: { kind: 'sign-in' | 'rescan' | 'retry' | 'open-settings' | 'open-logs' | 'update-agent'; label: string }
  tone: 'attention' | 'failure' | 'info'
}
export function friendlyError(raw: { code?: string; message?: string; provider?: string } | string | null | undefined): FriendlyError
```

Map the cases the daemon and adapters already produce (grep `invalid_argument`,
`provider_unavailable`, `unauthenticated`, `rate_limited`, `model_unavailable`,
`not_signed_in`, `timeout`, `process_exited`, `permission denied`, quota and context
overflow wording in `crates/` and in `executionContract.ts`, `runtimeDiscovery.ts`,
`launchChecks.ts`). Unknown input returns a generic "Something went wrong. Try
again." with `retry`, **never** the raw provider text as the title (raw text stays
available behind a "Details" disclosure). Use it in: the session error/failed-turn
card, the runtime problem tooltip (`RuntimeProblemMarker.tsx`), the launch intro
warnings and the toast helper. Table-driven tests with at least 15 inputs.

## 2. Offline and daemon-down banner

A single slim banner under the header (`role="status"`, `aria-live="polite"`) when
the connection state is not `connected`: "Reconnecting to Bitbots..." with a
spinner glyph and attempt count after the third try, "Bitbots could not be
reached" plus a **Retry now** button after a failure. It disappears with a short
"Back online" confirmation (1.5 s). The composer stays usable for drafting but
Send is disabled with the tooltip "Waiting for the connection". Use the existing
connection state in `App.tsx`; no new daemon work. Tests for the three states.

## 3. First-scan recovery

In the onboarding agents step (`FirstRunOnboarding.tsx`, step 1) and in Settings >
Agents: when a scan finds nothing, show the per-agent install command with Copy
(already present) and a **Check again** button that remembers the time of the last
check ("Checked 12:41") and shows an inline `aria-live` result ("Found Codex" /
"Still not found"). A scan that errors uses `friendlyError`. Do not change the
step order or add steps. Test: failed scan then success.

## 4. Uniform undo

Today some destructive actions show an undo toast and some do not. Make a single
`useUndoable(action, undo, label)` helper (new `ui/undo.ts`, built on the existing
`.undo-toast`) and use it for: archive conversation, delete conversation (soft: the
daemon call is delayed 6 s unless undone, or use an existing restore RPC if one
exists; read the code and pick the safe option), rename, move to project, remove
project. Toast copy "Archived 'Title'. Undo". Esc dismisses, the toast is
focusable, the timer pauses on hover and focus. Tests per action.

## Gates

`npm run typecheck`, `npm run test`, `cargo clippy --workspace --exclude
bloblex-desktop --all-targets -- -D warnings` only if you touched Rust.
Never commit. Leave the diff and write `docs/history/fix-14/report.md` with one line per
numbered section (done / partly / not done and why) and the list of call sites.
