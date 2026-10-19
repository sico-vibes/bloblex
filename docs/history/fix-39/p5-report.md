# FIX39 P5 — per-bot settings, permissions, lock, Experimental tab

> **What this is:** Report for FIX39 package P5: per-bot settings, permissions, lock and the Experimental tab.
> **Status:** historical
> **Last updated:** 2026-10-18

Package P5 of `docs/history/fix-39/implement-brief.md`, per `docs/history/fix-39/research-audit.md`
(§P5 plus items 11, 12, 13, 16, 19) and `docs/history/fix-39/decisions.md` (which
override). Branch `lane/fix39-p5`, worktree `C:\fx85`. Nothing was committed.

Items: **16** (composer writes the bot), **19** (permissions in a
sub-conversation; the project-path part is P6), **13** (lock a bot), **11**
(Experimental settings page), **12** (model and effort under the name).

---

## 1. What changed, item by item

### Item 16 — the composer always writes the bot

- `apps/desktop/src/ui/ComposerControls.tsx:85-99` — `PermissionModeControl.apply`
  now calls `agent.update { agentId, approvalMode }` (the bot) and, for a real
  conversation, additionally `session.permissions.set { approvalMode: null }` to
  drop the conversation's own pin so it follows the bot. The menu note is now
  "Applies to this bot from now on." (`:119`), and the full-access confirmation
  says the bot's setting applies to every conversation.
- `apps/desktop/src/ui/SessionExecutionControls.tsx:88-104` — `save` writes
  `agent.update { agentId, model, thinking }` first and returns early for a
  `draft:` session (`isDraftSession`); for a real conversation it then keeps
  today's `session.model.update` with its confirmation. `setFast` (`:130-142`)
  writes the bot the same way. New `locked` prop greys out both controls.
- `apps/desktop/src/ui/SessionExecutionControls.tsx:54-66` — a draft id is never
  sent to `runtime.models` / `runtime.capabilities`.
- `apps/desktop/src/ui/SessionExecutionControls.tsx:148,170` — a model choice on
  a draft skips the mid-conversation confirmation dialog (there is no provider
  context to lose yet).
- `apps/desktop/src/ui/App.tsx:2559,2562` — passes `onAgentUpdated` (merges the
  returned agent at once) and `locked={activeSelectedAgent.locked === true}`.
- Tests: `apps/desktop/src/ui/ComposerControls.mounted.test.tsx:36-102` (the bot
  is written and `session.model.update` is **not** called; a draft write always
  goes to the bot) and the existing
  `SessionExecutionControls.mounted.test.tsx` fast-mode/stale-save tests, updated
  to expect the bot write first.
- Daemon proof that a new conversation inherits the bot's mode:
  `fix39_p5_tests::row_composer_writes_the_bot_so_a_new_conversation_inherits_it`.

### Item 19 — permissions in a sub-conversation

- New RPC `session.permissions.set { sessionId, approvalMode|null }`:
  `crates/bloblex-daemon/src/main.rs:2632` (`set_session_permissions`),
  dispatch arm `:1118`. It edits only the conversation pin, is **allowed while a
  turn runs** (effective next turn), refuses an automation session, refuses a
  locked bot, and keeps the stored model/thinking the lock requires.
- UI: the side-conversation header carries the same permission pill, labelled
  "Applies from the next turn." — `apps/desktop/src/ui/App.tsx:2454` rendering
  `PermissionModeControl` with a new optional `note` prop
  (`ComposerControls.tsx:57,119`), slotted into
  `apps/desktop/src/ui/TeamMessages.tsx:113` (`permission?` prop).
- Manager tool: `set_conversation_permission { conversation, mode }` —
  `crates/bloblex-daemon/src/proposals.rs:56` (schema), `:164`
  (`validate_permission`), `:250` (`propose_permission`), dispatch
  `crates/bloblex-daemon/src/team.rs:279`. It accepts only `ask`/`auto`, only a
  side conversation the Manager itself started (`link.peerAgentId == manager`),
  and refuses a locked target. It is proposal-gated: the new `permission` kind is
  applied in `proposals.rs:335,460` (`apply_permission`, re-checking the lock).
- Storage: the `proposals.kind` CHECK and the table rebuild now include
  `'permission'` (`crates/bloblex-storage/src/lib.rs:701,715,723`, and
  `insert_proposal`'s allow-list `:1963`).
- Card: `apps/desktop/src/ui/ProposalCard.tsx` renders the conversation and the
  mode with Approve/Reject.
- Tests: `fix39_p5_tests::row_session_permissions_set_refuses_a_locked_bot_but_works_mid_turn`,
  `…refuses_an_automation_session`,
  `row_manager_permission_proposal_needs_approval_and_rejects_full_access`
  (includes the "full access is never offered" and "not a conversation I
  started" refusals), `row_proposal_apply_permission_refuses_a_bot_locked_after_the_card`.
- **Not done (outside P5's file list):** item 19's sub-point 5, richer denial
  text (`bloblex_agent_core::permission_summary`), touches
  `crates/bloblex-agent-core`, which is not a P5 file. Flagged for the Director.

### Item 13 — lock a bot

- Storage: an `agents.locked` column, added idempotently on every open
  (`crates/bloblex-storage/src/lib.rs:444`), exposed as `locked` in every agent
  JSON projection (the three `agent_list`/`agent_read`/manager rows), and set
  only by the new `Storage::agent_set_locked` (`:1803`), which refuses to lock
  the Manager and is a no-op for an unchanged value. `agent.update` can never
  write `locked` (it copies only its allow-list of fields, `:2168`).
- New RPC `agent.lock.set { agentId, locked }` —
  `crates/bloblex-daemon/src/main.rs:987`; `tiers.json:425` row is `never`.
- Daemon enforcement (`bot_is_locked`/`locked_bot_error`, `main.rs:438,444`; the
  one sentence "This bot is locked. Unlock it to change its settings."):
  - `agent.update` refuses (`main.rs:869`);
  - `agent.delete` refuses (`main.rs:893`);
  - `agent.restore` refuses (`main.rs:979`);
  - `agent.team.update` refuses project/role but keeps hidden and sort order
    (`team.rs:710`);
  - `session.model.update` refuses (`main.rs:2496`);
  - `session.permissions.set` refuses (`main.rs:2646`);
  - Manager `update_blob` refuses (`team.rs:384`);
  - a Manager permission proposal refuses (`proposals.rs`),
  - the legacy catalog migration skips a locked bot (`main.rs:1606`), so it never
    rewrites a locked bot's model.
- UI: lock badge on the avatar (`TeamSidebar.tsx:298`, `.lock-badge`
  `team.css:25`), a "Lock bot / Unlock bot" menu item (`TeamSidebar.tsx:181`;
  Lock only while the `botLock` experiment is on, Unlock always), Rename / Edit /
  Move to / Archive disabled when locked; `App.tsx:2412` wires `onToggleLock` to
  `agent.lock.set`. Composer permission and execution controls are disabled for a
  locked bot. The bot editor opens read-only behind a banner
  (`BlobPage.tsx:129,147,165`, `BlobSettings.tsx:235` wrapping the form in a
  `disabled` `fieldset`).
- Tests: `fix39_p5_tests` (see the writer table in §2) and
  `TeamSidebar.keyboard.mounted.test.tsx:57` (Lock offered only with the switch
  on; Unlock always offered; Rename/Edit/Archive/Move to disabled, Pin still on;
  the badge shows).

### Item 11 — Experimental settings page

- `apps/desktop/src/ui/SettingsSheet.tsx:44` (page id), `:49` (nav entry with
  `FlaskConical`), `:573` (the whole former General "Experimental" group moved
  into a `page === 'Experimental'` block, including "Longest wait for a rate
  limit" and the Steer toggle).
- `apps/desktop/src/ui/settingsIndex.ts:5,8` add the page; the two General
  entries and one new entry per `EXPERIMENTS` row now point at it
  (`:49-65`), so settings search finds every toggle.
- Tests: `SettingsSheet.appearance.mounted.test.tsx:116` (the toggles render on
  their own page and General no longer carries the group), the moved-page
  updates at `:54,71,89,104`, `approvalModes.mounted.test.tsx:148` (nav list),
  `settingsIndex.test.ts`.

### Item 12 — model and effort under the bot's name

- `apps/desktop/src/ui/teamSelectors.ts:64` — the pure `sidebarSubtitle(agent,
  provider, models)` helper: catalog display name (falling back to the saved id),
  `Model · Effort`, "Default model" with no model.
- `apps/desktop/src/ui/catalogCache.ts:79` — `readCachedCatalogModels(runtimeId)`
  reads the boot-warmed catalog synchronously; no extra request per row.
- `apps/desktop/src/ui/TeamSidebar.tsx:105,234` — `sidebarModel` prop (threaded
  from `experiments.sidebarModel` at `App.tsx:2398`); status wins while working or
  waiting, then model/effort, then the conversation preview.
- New experiments `sidebarModel` ("Model and effort under the name") and `botLock`
  ("Lock a bot") in `apps/desktop/src/ui/experiments.ts:15-16`; they render on the
  Experimental page automatically and are persisted under
  `experimental.<name>`.
- Tests: `teamSelectors.test.ts:99` (catalog / no catalog / no model / no effort),
  `TeamSidebar.keyboard.mounted.test.tsx` model-line mounted test.

---

## 2. Risk 1 — lock enforcement coverage

Every writer of an agent field or a session lock, whether the lock guards it, and
the daemon test that proves it. All tests are in
`#[cfg(test)] mod fix39_p5_tests` (`crates/bloblex-daemon/src/main.rs:10435`).

| Writer (input → storage call) | Guarded? | Daemon test (one per row) |
| --- | --- | --- |
| `agent.update` RPC → `Storage::agent_update` | Yes, conflict | `row_agent_update_and_agent_delete_refuse_a_locked_bot` |
| `agent.delete` RPC → `agent_archive` | Yes, conflict | `row_agent_update_and_agent_delete_refuse_a_locked_bot` |
| `agent.restore` RPC → `agent_restore` | Yes, conflict | `row_agent_restore_refuses_a_locked_bot` |
| `agent.team.update` (project / role) → `agent_set_team` | Yes, conflict | `row_agent_team_update_keeps_layout_writes_but_refuses_settings` |
| `agent.team.update` (hidden / sort order) → `agent_set_team` | No, deliberately exempt (layout) | same test (the write succeeds) |
| `session.model.update` (model / effort / speed / pin) | Yes, conflict | `row_session_model_update_refuses_a_locked_bot` |
| `session.permissions.set` (new) | Yes, conflict; allowed mid-turn once unlocked | `row_session_permissions_set_refuses_a_locked_bot_but_works_mid_turn` |
| Manager `update_blob` tool | Yes, refusal text | `row_manager_update_blob_refuses_a_locked_bot` |
| Manager `set_conversation_permission` (proposal created) | Yes, refusal text | `row_manager_permission_proposal_needs_approval_and_rejects_full_access` |
| Proposal apply (`permission`) → `set_session_model_lock` | Yes, conflict (re-checked when approved) | `row_proposal_apply_permission_refuses_a_bot_locked_after_the_card` |
| `agent.lock.set` (the unlock itself) | No, deliberately exempt | `row_agent_lock_set_unlocks_and_refuses_the_manager` |
| `migrate_legacy_agent_models` → `agent_update` (internal, on a runtime scan) | Yes, skipped | `row_legacy_model_migration_skips_a_locked_bot` |
| `agent.create` (no lock exists yet) | No, deliberately exempt | `exempt_writes_do_not_consult_the_lock` |
| reads: `agent.get`, `agent.list`, `app.snapshot` | No, deliberately exempt | `exempt_writes_do_not_consult_the_lock` |
| Manager on its own bot (`is_manager`) | The Manager can never be locked | `row_agent_lock_set_unlocks_and_refuses_the_manager` |

The audit's named checks are all present by hand: `update_blob` (`team.rs:384`),
proposal apply (`proposals.rs:460`), `agent.restore` (`main.rs:969`) and
`agent.team.update` (`team.rs:710`).

---

## 3. Migrations

Both schema changes target a live user database.

- `agents.locked` — added by `ensure_team_schema`, which runs on every open and
  only adds a missing column, so an old database opens untouched
  (`crates/bloblex-storage/src/lib.rs:433-444`).
- `proposals.kind` — a CHECK constraint cannot be altered in place, so the table
  is rebuilt (rows copied verbatim) when the stored DDL lacks `'profile'` or
  `'permission'` (`lib.rs:715-737`), the same pattern the FIX36 D3 migration
  uses.

Migration tests open a database **written by the previous version** (created,
its schema then rewound to the old definition, then reopened through
`Storage::open`):

- `tests::a_pre_fix39_database_gains_the_locked_column_and_keeps_a_lock`
  (`lib.rs:6997`) — drops `agents.locked`, reopens, checks `locked` is present
  and false, sets it, closes and reopens, and checks the lock survives.
- `tests::a_pre_fix39_proposals_table_gains_the_permission_kind` (`lib.rs:7049`)
  — rebuilds the table with the old CHECK, reopens, and checks an old `task` row
  survives and a new `permission` row is accepted.
- `tests::the_manager_can_never_be_locked` (`lib.rs:7036`).

---

## 4. Gates (all run to completion, foreground)

- Rust: `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — **all crates pass, 0 failed** (storage 109, daemon 365 incl. 13 new).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — **clean**.
- UI: `npx tsc -b` — clean; `npx vitest run --maxWorkers=3` — **168 files, 1220
  tests passed**; `npm run build` — ok; `npm run build:remote` — ok (tiers.json is
  shared policy data).
- Parity: `remoteTiers.parity.test.ts` green; `agent.lock.set` and
  `session.permissions.set` have `never` rows in `tiers.json` (`:425`, `:649`).
  No new event type was added: both methods emit the existing `agent.changed` /
  `session.changed`.

---

## 5. Not checked / not done

- **Visual items.** The lock badge, the read-only editor banner and the side
  header pill were not looked at in a browser; both looks and both themes need
  the Director's screenshots (docs/design/design-system.md visual rules).
- **The read-only editor is not airtight.** The `disabled` fieldset disables the
  native inputs, but `LookEditor`'s canvas-based controls are not native form
  controls and stay clickable; the daemon refuses the save either way. I did not
  edit `BotEditor.tsx`/`BotWizard.tsx` (listed for P5) because the fieldset
  covers their inputs and the wizard is a create-only flow, never locked.
- **No lock tooltip on disabled composer controls.** They are disabled (with the
  permission pill's existing title) but no dedicated "This bot is locked" tooltip
  is attached to the model/effort pills.
- **"set by the Manager" label** on the side-conversation pill (item 19 sub-point
  3's card copy) is not shown; the pill shows the effective mode only.
- **Item 19 sub-point 5** (classifier category/path in the denial notice) is
  outside P5's files (`crates/bloblex-agent-core`) — see §1.
- **Live behaviour:** no live daemon, no tailnet, no real bot run was exercised.

---

## 6. Files outside the package list (kept minimal)

- `crates/bloblex-storage/src/lib.rs` — the `proposals.kind` CHECK and rebuild
  (item 19 needs an accepted `permission` kind; the file was already the P5
  storage file for the `agents.locked` column).
- `apps/desktop/src/ui/TeamMessages.tsx` — one optional `permission?: ReactNode`
  prop on `SideConversationHeader` so the side header can render the pill.
- `apps/desktop/src/ui/ProposalCard.tsx` — one `KIND_LABEL` entry and one body
  block so the Manager's `permission` card shows the conversation and mode.
- `apps/desktop/src/ui/blobPage.css` — two rules for the `blob-settings-body`
  fieldset.
- `apps/desktop/src/ui/approvalModes.mounted.test.tsx`,
  `apps/desktop/src/ui/experiments.test.ts` — the tests that asserted the old
  Experimental location / the old nine-experiment count.

Nothing else outside the listed files changed. `git commit` was not run.

---

# Follow-up (audit)

Continuation of P5 after the audit (`docs/history/fix-39/p5-audit.md`, PASS WITH FIXES)
and the Director's failed check (`docs/history/fix-39/director-checks.md`). Still branch
`lane/fix39-p5`, worktree `C:\fx85`, build temp `C:/fxt/c2/tmp`. Nothing was
committed. The sections above describe the first pass; this section covers what
this follow-up changed. Where the two disagree, this section is current.

## F1. A locked bot can use plan mode again — `crates/bloblex-daemon/src/main.rs`

`update_session_model` no longer consults the lock for a request that carries
only `planMode` (`main.rs:2533`: `touches_locked_settings` over
`model`/`thinking`/`serviceTier`/`approvalMode`). The Plan pill and "Approve
plan" work on a locked bot again; a settings write on the same request is still
refused.

Test: `fix39_p5_tests::row_locked_bot_keeps_plan_mode_but_refuses_a_settings_write`
— on the first pass this failed (`planMode` returned the lock conflict). It
asserts `{planMode:true}` succeeds and is stored, `{planMode:false}` clears it,
and `{serviceTier:"fast"}` on the same locked bot still returns the lock
sentence.

## F2. The lock now covers the project, the role, the leader and project deletion

- `team.rs:723` (`agent.team.update`): the guard compares each present field
  with the stored value. `projectId: null` ("Unassigned"), a different project,
  a different role and any `leader` change are refused; repeating the stored
  project or role (a drop inside the same project) stays a layout write, as do
  `hidden` and `sortOrder`. This also fixed a hole the first pass left: a locked
  bot could be dragged onto Unassigned.
- `team.rs:703` (`project.delete`): refused with the lock sentence while any bot
  in the project is locked, because `UPDATE agents SET project_id=NULL` would
  otherwise change a locked bot's project. Decided explicitly rather than
  exempted; see the writer table below.
- `TeamSidebar.tsx:253`: a locked row does not start a drag at all (the pointer
  path returns early), so the refusal is not the only barrier.

Tests: `row_agent_team_update_keeps_layout_writes_but_refuses_settings`
(extended; the null-project and leader refusals failed on the first pass),
`row_project_delete_refuses_a_project_with_a_locked_bot` (new), and the mounted
`TeamSidebar.keyboard.mounted.test.tsx` "does not start a drag for a locked bot".

## F3. Pinning or clearing a permission no longer changes anything else

`main.rs:1487` adds one shared builder, `conversation_lock_for(st, row,
approval_mode, set_by)`, used by `set_session_permissions` (`main.rs:2668`,
with the no-lock guard at `:2686`) and `proposals.rs:463` (`apply_permission`):

- `approvalMode: null` on a conversation with no lock object writes nothing and
  returns the current summary (no lock is created, so today's model and effort
  are not frozen and Claude's dynamic-workflow record is not dropped).
- Otherwise the lock is built the way `update_session_model` builds one:
  `model`, `thinking`, `enableWorkflows` for Claude, and the effective
  `serviceTier` and `planMode`, so the conversation's effective options are
  identical before and after apart from `approvalMode`. An existing lock is kept
  as is.

Tests: `row_clearing_a_pin_on_an_unpinned_conversation_writes_nothing`,
`row_first_pin_on_a_claude_conversation_keeps_workflows` (asserts
`enableWorkflows:true` and that clearing keeps `model`), and
`row_setting_a_pin_keeps_the_rest_of_an_existing_lock` (plan mode, workflows and
speed survive). All three fail on the first-pass code.

## S1–S8

- **S1** `App.tsx:2559`: `sessionBusy` dropped from the permission pill's
  `disabled`. New App-level test "keeps the permission pill usable while a turn
  runs, unlike the model and effort controls" (the pill is enabled and opens its
  menu mid-turn; the model pill stays disabled).
- **S2** lock tooltip: `ComposerControls.tsx:44` exports `LOCKED_CONTROL_TOOLTIP`
  ("This bot is locked. Unlock it to change its settings."), applied by the
  permission pill (`ComposerControls.tsx:115`) and by the model and effort pills
  (`SessionExecutionControls.tsx:147,162,343,436`) whenever `locked` is set and
  no more specific reason applies. Tests: the two new `ComposerControls` /
  `SessionExecutionControls` locked cases.
- **S3** `blobPage.css:18-20`: the read-only fieldset is `display: grid` (the
  parent `.blob-page-column` gap is 0, so the groups keep their rhythm) and
  `fieldset.blob-settings-body + .settings-group` restores the divider the
  `.settings-group ~ .settings-group` rule can no longer reach on the first group
  after the fieldset (Conversations, Manage). This is CSS; see "still needs the
  Director" below.
- **S4** `App.tsx:2454`: the side header note is now
  "Applies to this bot, from the next turn." (entity noun from the vocabulary).
- **S5** `proposals.rs:463,472`: `apply_permission` takes the proposal's
  `agentId` and re-checks `link.peerAgentId` against it, exactly as
  `propose_permission` does. Test:
  `row_permission_proposal_edits_cannot_retarget_the_card` (an edited
  `conversation` at approval time is refused; the untouched card still applies).
- **S6** untouched (item 19 sub-point 5 lives in `crates/bloblex-agent-core`).
- **S7** `catalogCache.ts:130` exports `useCatalogVersion()`, and
  `TeamSidebar.tsx:133` subscribes to it, so the model line repaints when the
  catalog lands. Test: "names the catalog model once it arrives, and the raw id
  before that" (the second assertion fails without the subscription).
- **S8** both swallowed newlines are back (`proposals.rs:273`,
  `main.rs:10815`).

## The Director's failed check: the update badge over the title

`docs/history/fix-39/director-checks.md` row "Update badge": at a 1024 px window
"Restart to update" covered "Codex · CTO · Board / New chat". Two changes, so
the badge can never cover the title at any width:

- The title yields first. `team.css:191-196` lets the three text-bearing parts
  of `.chat-title` shrink (`flex: 0 1 auto` on `.conversation-crumb`,
  `.chat-title-button` and `.role-chip`) out of the `.chat-title > * { flex: 0 0
  auto }` blanket rule, so the existing truncation rules (`min-width: 0`,
  `overflow: hidden`, `text-overflow: ellipsis` in `shell.css`) actually apply
  and the title ellipsises instead of spilling under the action side.
- The badge also goes compact. `UpdateBadge.tsx:55-74` watches
  `(max-width: 1180px)`; below it the ready badge is an icon plus "Restart"
  (full sentence kept in `aria-label`, version in `title`) and the downloading
  badge shows the ring plus the percent (full text in `aria-label`). At or above
  it the badge is unchanged.

Tests: `FIX37.updateBadge.mounted.test.tsx` "shrinks to an icon and a short
label below the compact width" and "keeps the full label at a wide window" (the
file's `beforeEach` now stubs a wide window: happy-dom's default window is
1024 px, the very width the Director measured, so the compact badge is the
default there). A new CSS-contract test `fix39P5FollowUp.test.ts` pins the
shrink rules and the fieldset rules, since no unit test can measure layout.

## The gaps this report had listed under "Not checked / not done"

- **The read-only editor is now airtight.** `LookEditor.tsx` and `BotEditor.tsx`
  take a `locked` prop and set `disabled` on every control they own (moods,
  shuffle/surprise, shape grid, tabs, colour swatches, sliders, resets, the
  custom-colour input), passed from `BlobSettings.tsx:242`. Tests:
  `LookEditor.mounted.test.tsx` "makes every control inert while the bot is
  locked" and "cannot even open the fine-tune tab…", plus
  `BlobSettings.botPageB.mounted.test.tsx` "disables the whole settings body and
  the look controls" and its unlocked counterpart.
- **Lock tooltip on disabled composer controls** — S2 above.
- **"set by the Manager" on the side-conversation pill.** The approved proposal
  writes `modelLock.approvalModeSource = "manager"` (`conversation_lock_for`),
  any owner-set mode clears it, and `ComposerControls.tsx:113,118` renders
  "set by the Manager" in the pill (and in its `aria-label`) when it is present.
  Test: `ComposerControls.mounted.test.tsx` "marks a Manager-set conversation
  mode"; the daemon side is asserted in
  `row_manager_permission_proposal_needs_approval_and_rejects_full_access`
  (`approvalModeSource == "manager"`).
- **`exempt_writes_do_not_consult_the_lock`** now asserts the reorder result
  instead of `.ok()`, and the creation it already checked asserts `locked:false`.
- **`ProposalCard` permission card** — new mounted test "shows a conversation
  permission change without offering full access".

## Writer table updated (replaces the two rows in §2)

| Writer (input → storage call) | Guarded? | Daemon test |
| --- | --- | --- |
| `agent.team.update` (different project — including `null` — role or leader) → `agent_set_team` | Yes, conflict (compared with the stored value) | `row_agent_team_update_keeps_layout_writes_but_refuses_settings` |
| `agent.team.update` (same project/role, hidden, sort order) → `agent_set_team` | No, deliberately exempt (layout) | same test (the writes succeed) |
| `project.delete` → `project_delete` (which sets `project_id=NULL`) | Yes, conflict while the project holds a locked bot | `row_project_delete_refuses_a_project_with_a_locked_bot` |
| `session.model.update` (only `planMode`) | No, deliberately exempt (a work mode, not a setting) | `row_locked_bot_keeps_plan_mode_but_refuses_a_settings_write` |
| `session.permissions.set` / proposal apply (the pin itself) | Yes; the pin no longer creates or drops a lock | `row_clearing_a_pin_on_an_unpinned_conversation_writes_nothing`, `row_first_pin_on_a_claude_conversation_keeps_workflows`, `row_setting_a_pin_keeps_the_rest_of_an_existing_lock` |

## Files touched outside the package list in this follow-up

- `apps/desktop/src/ui/fix39P5FollowUp.test.ts` (new test file).
- `apps/desktop/src/ui/FIX37.updateBadge.mounted.test.tsx`,
  `ProposalCard.mounted.test.tsx`, `App.agent.mounted.test.tsx`,
  `TeamSidebar.keyboard.mounted.test.tsx` — tests for the follow-up.
- `apps/desktop/src/updatesContract.ts` — `BADGE_RESTART_SHORT_LABEL`.
- `apps/desktop/src/preview/fixtureBridge.ts` — stub handlers for
  `agent.lock.set` and `session.permissions.set`, as the audit asked, so the
  Director can lock a bot and change a side conversation's permission in the
  browser preview for the screenshots.
- `docs/history/fix-39/audit-impl-brief.md` — restored to HEAD (`git checkout --`); its
  only diff was line endings, as the audit noted.

## Gates (follow-up, all foreground, `TEMP=TMP=C:/fxt/c2/tmp`)

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop
  --no-fail-fast` — **0 failed** (daemon 371 tests, storage 109, every other
  crate green).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — **clean**.
- `npx tsc -b` — clean.
- `npx vitest run --maxWorkers=3` — **169 files, 1242 tests passed** (was 168 /
  1220: one new file, 22 new tests).
- `npm run build` — ok. `npm run build:remote` — ok (parity green; both methods
  keep their `never` rows in `tiers.json`).
- `src-tauri` was not touched, so `cargo test -p bloblex-desktop --lib` was not
  run.

## Still needs the Director

- **Screenshots** (both looks, both themes): the header at 1024 px and wider
  (badge compact vs full, title ellipsised, no overlap), the locked editor with
  the banner and the disabled look controls, the side header's permission pill
  with and without "set by the Manager". I ran no browser.
- **S6** remains unassigned (item 19 sub-point 5, `crates/bloblex-agent-core`).
- No live daemon, tailnet or real bot run was exercised; the preview stubs above
  are for the Director's screenshots, not a substitute for that.
