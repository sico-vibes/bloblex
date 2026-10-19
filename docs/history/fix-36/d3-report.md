# FIX36 D3 — what the Manager knows outlives its model (lane report)

> **What this is:** Lane report for FIX36 D3: what the Manager knows outlives its model.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, worktree `C:\fx58`
(branch `lane/fix36-d3`), private `CARGO_TARGET_DIR=C:\fxt\d3`. No `git commit`
was run. `apps/desktop/src/ui/**` was not touched.

Spec: [docs/history/fix-36/d3-knowledge-spec.md](d3-knowledge-spec.md). Builds on
[FIX36 D1](d1-report.md) and [FIX36 D2](d2-report.md).

Owner decision: the Manager is the same Manager across model changes. Its
structured notes about the user, its own playbook, and a handover of its
workspace and open work live outside any single provider session, so a new model
starts with the Manager's knowledge rather than a blank slate.

## 1. Profile — structured facts about the user

- **Schema (additive, no `user_version` bump).** New
  `ensure_manager_knowledge_schema` creates
  `manager_profile(id TEXT PK, category CHECK IN ('identity','workflow','style',
  'conventions','design','other'), key TEXT, value TEXT CHECK(length<=1000),
  source CHECK IN ('said','learned','corrected'), locked INTEGER DEFAULT 0,
  created_at, updated_at, UNIQUE(category, key))`. It is idempotent and runs on
  every open, after `ensure_proposal_schema`, in every migration path (all five
  open branches).
- **Storage accessors** `manager_profile_list` (locked first, then category and
  key), `manager_profile_get(category, key)`, `manager_profile_put(category,
  key, value, source, locked?)` (upsert on the unique pair; `locked` only changes
  when given), `manager_profile_delete(id)` and `manager_profile_delete_key`.
  Invalid category, source, empty/over-long key or value are `InvalidAgent`.
- **Manager-only tools.** `remember_about_user { category, key, value, source }`:
  a new key is saved (default source `learned`); an existing **unlocked** key is
  updated in place; an existing **locked** key becomes a `kind:"profile"`
  proposal and the stored value is untouched until approval.
  `forget_about_user { category, key }` removes an unlocked fact, and becomes a
  `kind:"profile"` proposal when the fact is locked. `recall_about_user
  { category? }` reads the profile back, grouped. Values that look like secrets
  are refused (`memory::contains_secret_marker`, reused via
  `bloblex_security::contains_secret_marker`).
- **User RPCs.** `manager.profile.list`, `manager.profile.set { id?, category,
  key, value, locked }` (a new key is `said`, an edit is `corrected`),
  `manager.profile.delete { id }`. Event `manager.profile.changed`.

## 2. Playbook — the Manager's own guide

- **Schema.** `manager_playbook(version INTEGER PK, text TEXT
  CHECK(length<=16000), author CHECK IN ('default','user','manager'),
  created_at)`; the latest version is current. Version 1 is seeded once with a
  default Markdown playbook (`DEFAULT_PLAYBOOK`, ~2.6k chars) covering the
  first-run interview (name, role, how they work, communication style, coding
  conventions, design taste, references), the project onboarding interview
  (goal, users, platform, stack, design, references, success), how to propose a
  team (one bot per responsibility, 2–6 bots, explain each role), always asking
  before creating projects/bots/tasks, never storing secrets, and keeping the
  user's locked preferences.
- **Storage accessors** `manager_playbook_current`, `manager_playbook_history`
  (newest first), `manager_playbook_get(version)`, and `manager_playbook_append
  (text, author)` (`max+1`, append-only, trims; `user`/`manager` only).
- **Tool.** `update_playbook { text, reason }` **always** writes a
  `kind:"playbook"` proposal carrying `{ text, reason, baseVersion }`; nothing
  changes until approval, when the text is appended as an `author:"manager"`
  version.
- **User RPCs.** `manager.playbook.get`, `manager.playbook.history`,
  `manager.playbook.set { text }` (author `user`), `manager.playbook.revert
  { version }` (appends the old text as a new `user` version). Event
  `manager.playbook.changed`.

## 3. Context for every Manager turn

- New module `crates/bloblex-daemon/src/knowledge.rs` owns the profile, the
  playbook and the prompt blocks.
- `knowledge::context_for_prompt` returns a per-turn `<bloblex_manager>` suffix
  **only** for a session whose agent is the Manager. It contains the profile
  grouped by category (locked first, ≤ 3000 chars, then "(call
  recall_about_user for more)"), the current playbook (≤ 6000 chars) and the
  workspace summary (projects with their bots, ≤ 1500 chars). It is re-sent only
  when its hash changes, and the hash is cleared on a context reset
  (`knowledge::forget_context`, wired into the resume-fallback path, the
  `ContextChanged` path and session deletion, beside `memory`/`skills`).
- The block is **not** part of `<bloblex_team>`, so profile and playbook edits
  never change the instruction hash (proved by a test).
- The Manager's runtime paragraph gained one sentence naming
  `remember_about_user` / `recall_about_user` / `update_playbook`, so the tools
  are discoverable. This changes the instruction hash once, as a feature release
  does.

## 4. Model change: same Manager

- When `session.model.update` reports `modelChanged` for a Manager session, the
  daemon arms a one-off handover (`session_manager_handover`, a
  `data.managerHandover` flag that survives a restart) and writes the transcript
  notice **"New model, same Manager. It has its notes and playbook."** with
  `meta.kind="context_reset"`, `reason="manager_handover"`, `contextLost:false`
  (`knowledge::announce_model_change`). Ordinary bots keep the plain "fresh
  session" behaviour.
- The first prompt of the new provider session carries a one-off
  `<bloblex_handover>` block (profile, playbook, active projects and bots, the
  pending proposals, and the last 10 approved/rejected decisions with dates).
  It is consumed once; the per-turn `<bloblex_manager>` hash is recorded at the
  same time so the knowledge is not repeated verbatim on that prompt.

## 5. Non-visual TypeScript

- `apps/desktop/src/remote/tiers.json`: `manager.profile.list`,
  `manager.playbook.get` and `manager.playbook.history` are `read`/`viewer`;
  `manager.profile.set`/`delete` and `manager.playbook.set`/`revert` are
  `never`; `manager.profile.changed` and `manager.playbook.changed` are `drop`.
- `apps/desktop/src/types.ts`: new `ManagerFact` and `PlaybookVersion`, and
  `ProposalCard.kind` may now be `'profile'`.
- `apps/desktop/src/preview/fixtureBridge.ts`: fixture profile facts and a
  seeded playbook, with handlers for all seven `manager.profile.*` /
  `manager.playbook.*` methods that emit `manager.profile.changed` /
  `manager.playbook.changed`.

## D2 hardening (Director's review)

In `crates/bloblex-daemon/src/proposals.rs` `apply_project`:

- Both `existing` and `new` require an **absolute** folder path; a relative path
  is refused with `invalid_argument` and the message **"Choose a full folder
  path."**, leaving the proposal pending.
- For `new`, a path that already exists as a **file** is refused with
  `invalid_argument` ("… is a file, not a folder.") instead of a raw OS error
  from `create_dir_all`.

## Tests

Storage (`crates/bloblex-storage/src/lib.rs`, `memory_tests`):

- `the_proposal_kind_check_widens_to_profile_and_keeps_old_rows` — rebuilding
  the D2 `proposals` table (no `profile`) widens the CHECK and copies every row,
  and a `profile` proposal then inserts.
- `manager_profile_is_unique_per_category_and_key_and_can_be_locked` — upsert on
  the unique pair, a lock survives a later unspecified write, ordering puts
  locked rows first, delete by id and by key, and bad shapes are refused.
- `manager_playbook_is_seeded_and_versions_append` — version 1 is the default,
  appended versions number up and history is newest first; a bad author or empty
  text is refused.
- `the_manager_handover_flag_round_trips_on_a_session`.

Daemon (`crates/bloblex-daemon/src/main.rs`, `phase2a_tests`):

- `manager_profile_tools_save_update_and_propose_locked_changes` — the four
  knowledge tools are Manager-only (hidden and refused otherwise); a new key is
  saved, an unlocked key updates in place, a secret is refused, `recall` reads
  it back; a locked key makes the Manager's change a `kind:"profile"` proposal
  that changes nothing until approval (and keeps the lock); a locked forget is a
  proposal too; the user RPCs set (`said`), list and delete.
- `playbook_is_seeded_and_every_manager_change_is_a_proposal` — the seed exists;
  `update_playbook` is always a proposal (nothing changes first) and approval
  appends a `manager` version; the user `set`/`revert` append `user` versions and
  history is complete.
- `manager_context_block_is_only_for_the_manager_and_resent_only_when_it_changes`
  — the `<bloblex_manager>` block is only for the Manager, is not re-sent
  unchanged, re-sends after a profile or playbook edit or a context reset,
  respects the caps, and an edit never changes the instruction hash.
- `a_manager_handover_is_delivered_once_and_announced` — the notice has
  `reason:"manager_handover"` and `contextLost:false`, only the Manager is
  armed, the next prompt carries `<bloblex_handover>` (profile, playbook, pending
  and decisions) exactly once, and it is never persisted.
- `project_proposals_require_a_full_folder_path_and_refuse_a_file` — a relative
  `existing` or `new` path is `invalid_argument` ("Choose a full folder path.")
  and stays pending; an existing file is refused for `new`; an absolute new path
  is created and stored.

TypeScript: `npx tsc -b` and `npx vitest run src/remote src/preview` (the tier
parity test fails the build if a dispatched method or an emitted event has no
`tiers.json` row).

## Gates

Run in this worktree with `CARGO_TARGET_DIR=C:\fxt\d3`, after the final edit:

- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` —
  **clean** (exit 0, `Finished`).
- `cd apps/desktop && npx tsc -b` — **clean** (exit 0).
- `cd apps/desktop && npx vitest run src/remote src/preview` — **13 files, 207
  tests passed**.
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop
  --no-fail-fast` — **exit 0, all suites ok, 0 failed** (325 in `bloblex-daemon`,
  103 in `bloblex-storage`, every other binary ok; no `FAILED`, no `panicked`,
  no build errors). The full gate was run and waited for **after** the last
  source edit.

An earlier full run caught two D3 test bugs (the seeded playbook kept a trailing
newline that a revert trims, and the new prompt blocks had no leading blank line
so the fake adapter's first-line echo contained the tag); both were fixed and
the full gate re-run to green.

## Unverified / notes

- **UI is not touched.** No screen renders the profile, the playbook, the
  `<bloblex_manager>` context or the `<bloblex_handover>` notice; the Director's
  UI does that. The types, the tier rows and the fixtures are in place.
- **`manager.profile.set` is keyed by `(category, key)`.** The optional `id`
  parameter is accepted but not required; the row is identified by its unique
  pair. A rename of the key through `id` is therefore not supported (it would
  insert a second fact).
- **Runtime change vs model change.** The handover is armed by
  `session.model.update` (the concrete "fresh provider session" path). A change
  to the Manager agent's `runtimeId` does not close a live session today, so
  there is no fresh-session moment to hang it on; the arming helper
  (`knowledge::announce_model_change`) is the single place to extend if that
  changes.
- **The Manager's side conversations** (where the Manager is the asking peer)
  also receive the `<bloblex_manager>` block, because their `agentId` is the
  Manager. This is intended ("for the Manager only") but is not exercised by a
  test.
- **`insert_proposal`'s kind allowlist** was widened to include `profile`
  alongside the schema CHECK; both move together.
- **Instruction hash.** The Manager paragraph changed, so existing bots re-send
  their instructions on the next turn after this release.
