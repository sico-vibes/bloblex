# FIX12 report — the characters are "bots" in Bitbots and "blobs" in Blobots

Implemented 15 October 2026. Spec: [FIX12_VOCABULARY_SPEC.md](FIX12_VOCABULARY_SPEC.md).

## What the wording follows

The look decides the word, as the spec directs, through the existing helper:

- `entityNoun(style, { plural?, capital? })` and `useEntityNoun({ plural?, capital? })` in
  `apps/desktop/src/ui/vocabulary.ts`. Default look (Bitbots, and the value when
  `appearance.style` is unset) reads **bot**; Blobots reads **blob**.
- React components read the noun with `useEntityNoun()`. Event handlers, effects and
  non-React helpers read `entityNoun(themeStyle())` at the moment of use, never at
  module load, so a look change is picked up without a restart.
- Module-level copy constants that held the word became small functions:
  `CLIENT_MESSAGES` lost `nameTaken` in favour of `nameTakenMessage()`, and the
  `EXPERIMENTS` `hint`/`help` fields became getters (`hint()` / `help()`).
- The daemon reads the same setting through `team::entity_noun(&st, plural)`
  (`crates/bloblex-daemon/src/team.rs`), which reads `st.db.settings()["appearance.style"]`.
  It is `pub(crate)` so `main.rs`, `automations.rs` and `memory.rs` use it too.

## Counts

- 48 files changed, +439 / −267 (commit `9dc52b6`, produced from this lane's worktree).
- Roughly **190** user-visible copy sites follow the noun: 143 `${noun}` / `{nouns}` /
  `{Noun}` / `{Nouns}` interpolations plus 48 `entityNoun(...)` call sites.
- 27 modules import the vocabulary helper.
- User-visible copy now following the look includes the create/import dialogs, the blob
  ("bot") editor and its settings, the sidebar and its menus, the quick switcher,
  analytics, memory, schedules, the companion island and peer picker, onboarding,
  the permission-mode control, the bypass confirm dialog, export Markdown headers,
  blob-file import errors, daemon instructions and tool descriptions.
- `aria-label="Create blob"` was the only wording that code queried. The button now
  carries `data-testid="create-blob"` and the three `App.tsx` focus/query call sites use
  that stable selector, so future copy edits cannot break focus restoration.

## Identifiers and other text kept (not renamed)

Classified from `git grep -n -i "blob" apps/desktop/src`:

- Component, file and CSS names: `BlobCanvas`, `BlobPage`, `BlobSettings`, `BlobOverview`,
  `BlobSessions`, `blobShare`, `BlobLook`, `BlobMood`, `blob-canvas`, `blob-dialog`,
  `blob-muted`, `blob-page-*`, `hidden-blob`, `blob-group`, `blob-field`, etc.
- `data-*` attributes and state keys: `companion.pinnedBlobs`, `application/x-bloblex-agent`,
  `blob:` tree ids, `experimental.*`, `pinned/expanded` JSON `blobs` map.
- `localStorage` keys: `bloblex.*` (`firstRun.*`, `sidebar.pins`, `selectedAgentId`,
  `inspector.open`, `analytics.view`, `appearance`, `update.dismissedVersion`, …) and the
  `bitbots.style` / `bitbots.accent` cache keys (plus the legacy `bloblex.bitbots`).
- RPC methods, params and events: `list_blobs`, `message_blob`, `create_blob`, `update_blob`,
  `blob` tool argument, `blob_created` / `blob_reply` / `blob_message` event kinds,
  `bloblex-*` window events, `BLOB_SHARE_FORMAT = 'bloblex.blob.v1'`, the `blob` /
  `project` / `shared` memory scopes, and `appearance.style` values `bitbots` / `blobots`.
- The look names **Bitbots** and **Blobots**, and the look character labels
  `Bitbot` / `Blobot` in `LookPicker.tsx` and the "Preview of the … look" aria label
  (`LookPreview.tsx`). These name the looks, not the character.
- External products: the `blobatar` and `robot-heads` credits and the `bloblex` product/
  MCP server name (`SERVER_NAME`), and all `bloblex_*` / `mcp__bloblex__` tool prefixes.
- Code comments and doc comments (not read by users) were left alone.
- Non-React identifiers such as the local `blob` variable holding a `File`/`Blob` object
  in `ComposerControls.tsx` (the DOM `Blob` type) were left alone.

## Ambiguous, and the call made

- `LookPicker.tsx` blurb "Soft blobs, rounded corners and a calmer feel." describes the
  **Blobots** look specifically, so it keeps "blobs" even while Bitbots is active.
- `apps/desktop/src/preview/gallery.tsx` and `preview/main.tsx` are development-only
  gallery pages ("Import a blob", "Blob shapes"). They are not the product UI and were not
  part of the FIX12 commit; they still read "blob".
- `preview/fixtureBridge.ts` sample conversation content ("The user (Codex, a blob)…") is
  fixture data, not product copy. Its RPC *error* strings were converted to the noun so the
  preview matches the daemon.
- The daemon keeps `"blob is required."` because it names the `blob` tool parameter, and
  keeps the `blob`/`project`/`shared` scope literals.

## Tests

- Updated every test that asserted the old default word (agentForm, analyticsFormat,
  AnalyticsView, App.analytics, App.companion, App.lifecycle, approvalModes,
  CompanionTeam, ComposerControls, conversationMarkdown, FirstRunOnboarding, MemoryPage,
  SchedulesView, and the daemon's `team_*` tests).
- `App.agent.mounted.test.tsx` runs in the classic (**Blobots**) look on purpose
  (`setBitbotsEnabled(false)` in `beforeEach`), so its "blob" assertions still hold; the one
  onboarding flow that picks the Bitbots look now asserts "Create bot".
- Added `FirstRunOnboarding.mounted.test.tsx` "labels the character with the chosen look's
  word and follows a look change": "Create bot" in Bitbots, then "Create blob" after
  `setThemeStyle('blobots')`, without a remount.
- Added `SettingsSheet.appearance.mounted.test.tsx` "follows the look in its copy without a
  restart": a Settings switch's label flips between "Notify when a bot finishes…" and
  "Notify when a blob finishes…".
- Added the daemon test `team_prose_follows_the_appearance_style`: `entity_noun` returns
  bot/bots then blob/blobs, `runtime_instructions` carries the word, and `create_blob`'s tool
  description follows it.
- Tool names, JSON field names, ids and event names were not changed, so the instruction
  hash only changes because of the sentence text; that re-sends instructions once on the
  next turn, as the spec expects.

## Gates (at commit `9dc52b6`)

- `npm run typecheck` — pass.
- `npm run test` — pass (97 files, 615 tests). Note: on this shared machine the suite can
  time out under the default parallelism while another lane is compiling; a run with
  `--maxWorkers=2` and an idle machine both pass.
- `cargo test -p bloblex-daemon --bins` — pass (156 tests).
- `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings` — pass.

## Note on provenance

This report was written after commit `9dc52b6` ("feat: the characters are bots in Bitbots
and blobs in Blobots (FIX12)") had already been made from this lane's worktree by the
Director's session, and after the worktree itself had been removed and recreated at that
commit. The lane did not run `git commit`.
