# FIX39 package P6 — orchestration: parallel conversations, context recovery, tags

> **What this is:** Report for FIX39 package P6: parallel conversations, context recovery and tags.
> **Status:** historical
> **Last updated:** 2026-10-18

Package P6 of `docs/history/fix-39/implement-brief.md`, as defined in
`docs/history/fix-39/research-audit.md` (§P6) and `docs/history/fix-39/decisions.md` (which
override). Worktree `C:\fx86`. Nothing was committed.

Items: **18** (parallel conversations, per owner decision 1), **20** (context
recovery), **21** (tags), **19.4** (a delegated task runs in the named project)
and **19.5** (the permission-denial notice text), which P5 could not reach.

Owner decision 1 is implemented literally: **the per-bot concurrency cap is
removed for every bot, new and existing**; the only limit left is a global
setting, *Bots working at once* (default 4, range 1–16), shown in
Settings › General.

---

## 1. What changed, item by item

### Item 18 — parallel conversations with one bot

- **No per-bot cap.** `crates/bloblex-storage/src/lib.rs:3498`
  (`create_reserved_turn`) lost its `agents.max_concurrency` check; it now takes
  the global limit as an argument and enforces only that and one turn per
  conversation. `crates/bloblex-daemon/src/main.rs:2995` reads the limit and
  `:3013` passes it.
- **The global limit is a setting.** New `concurrency.botsAtOnce`
  (default 4, Clamped 1–16): validator at `main.rs:1368`, allowlist at `:1294`,
  helper `global_concurrency_limit` at `:1448`. `runtime.capabilities` reports it
  as `globalConcurrency.limit` and a bot's `effectiveMaxConcurrency` now means
  the global limit (`main.rs:1895`, `:1898`).
  - Settings UI: *Bots working at once* — `apps/desktop/src/ui/SettingsSheet.tsx:566`
    (a 1–16 select), search entry `apps/desktop/src/ui/settingsIndex.ts:56`.
  - `apps/desktop/src/ui/BlobSettings.tsx:541` (`concurrencyText`) no longer says
    a per-bot "configured cap"; it names the global limit.
- **The drain is global.** `crates/bloblex-daemon/src/team.rs:677`
  (`drain_queued_deliveries`) is called from `after_turn` (`:729`): after *any*
  turn ends it tries every session with a queued delivery, not only the one that
  finished — the global limit can be what refused another bot's delivery.
- **The wait is visible.** `team.rs:656` (`queue_delivery`) writes one notice,
  "Waiting for <Bot> to finish another conversation."
  (`meta.state: "queued"`), when a delivery first queues, so an empty side
  conversation never renders the bot's "Ready when you are" screen. The UI side:
  `apps/desktop/src/ui/teamSelectors.ts:41` (`isWaitingDelegation`),
  `apps/desktop/src/ui/App.tsx:681` (derivation), `:2486` (empty state skipped),
  `:2524` (a waiting indicator).
- **The Manager is told the truth.** `team.rs:453` (`Delegation.started`) is set
  from the free slots (`team.rs:518`); `team.rs:456` (`message_blob`) says
  "working on it" or "queued"; `crates/bloblex-daemon/src/proposals.rs:449`
  (`apply_task`) returns `started` and a summary that says "started"/"queued".
- **Tests** (`fix39_p6_tests`): `row_one_bot_runs_many_conversations_at_once`
  (one bot, three conversations with `maxConcurrency` 1, all three run),
  `row_the_global_limit_setting_is_bounded_and_refuses`,
  `row_a_finished_turn_drains_another_conversations_queue`,
  `row_message_blob_says_started_or_queued_honestly` (also asserts the queued
  side conversation carries the waiting notice). Storage:
  `durable_reservations_enforce_the_global_cap` (renamed) and the new
  `one_bot_may_run_many_turns_and_only_the_global_cap_refuses`.

### Item 20 — context recovery

- **Armed on both fallback branches and after a model change.** The resume
  fallback (`main.rs:2363`, which already covered both `resume_or_start_fresh`
  and the `can_resume_saved_provider == false` branch) and the adapter-announced
  `ContextChanged::FreshSession` path (`main.rs:3922`) now call
  `knowledge::announce_context_loss`; a model change calls
  `knowledge::announce_model_change`, which for a non-Manager bot routes to the
  same recap instead of silence
  (`crates/bloblex-daemon/src/knowledge.rs:425`).
- **A persisted boolean, never the text.** `recapPending` in the session's `data`
  — `crates/bloblex-storage/src/lib.rs:2196` / `:2202` (`session_recap_pending`,
  `set_session_recap_pending`) plus `session_has_conversation_history` (`:2210`).
  The recap text is never written to the database (asserted).
- **Built from Bitbots' own record, bounded and inert.**
  `knowledge.rs:470` (`recap_for_prompt`) reads the last 8 user/assistant
  messages via `handoff_messages` (each clipped to 600 characters), adds the
  changed file paths (max 12) from the session's own `files`, caps the block at
  6 000 characters, and escapes `& < >` as inert JSON-safe data
  (`knowledge.rs:449`, `inert`). It is appended to that one prompt only
  (`main.rs:3239`) after the Manager handover, exactly like the reply snapshot.
  It is never persisted and never logged (no `tracing`/event payload carries it).
- **Notice copy.** "Started a fresh session. The agent was given a summary of the
  conversation." when a recap exists; the current text when there was nothing to
  summarise (a warm-up). `meta.kind` stays `context_reset`, so item 15's sidebar
  filter still works.
- **Tests** (`fix39_p6_tests`): `row_context_loss_arms_one_bounded_inert_recap`,
  `row_a_never_prompted_session_stays_silent`,
  `row_a_hostile_message_cannot_break_out_of_the_recap_block`,
  `row_the_recap_block_is_bounded`, and
  `row_a_model_change_arms_a_recap_for_a_non_manager_bot`. The existing
  `restart_send_is_accepted_then_resumes_and_prompts` now also asserts the recap
  block travels with the prompt and is absent from the stored conversation.

### Item 21 — tags

- **Storage.** `tags TEXT NOT NULL DEFAULT '[]'` on `projects` and `agents`,
  added idempotently on every open
  (`crates/bloblex-storage/src/lib.rs:423`, `:444`, `:455`); validated by
  `validate_entity_tags` (`:977`: array of strings, trimmed, lower-cased, each
  1–24 characters, ≤ 8, de-duplicated, `[]` clears). Exposed in the project and
  agent JSON (`project_rows`, `agent_list`, `agent_read`); written by
  `project_update` and `agent_set_team`.
- **Manager tools.** `list_projects`, `list_blobs` and `project_status` print
  each item's tags (`team.rs:340`, `:379`, `proposals.rs:281`);
  `update_blob` accepts `tags` (`team.rs:388`); a new Manager-only
  `update_project` sets a project's description and tags (`team.rs:424`, schema
  and dispatch `:225`, `:282`, non-Manager refusal `:292`). A locked bot refuses
  a tag change (`team.rs:834`).
  - **Deviation from the audit, deliberate (risk 5).** The audit suggested one
    added line in the Manager's *instructions*. I put the tags vocabulary in the
    tool descriptions instead and left `runtime_instructions` untouched, so
    editing tags can never change the instruction hash and force a new Codex
    thread (the item 20 bug).
- **Owner UI.** A project's and a bot's right-click menu gains **Tags…**,
  opening a small chip editor (`apps/desktop/src/ui/TeamSidebar.tsx:89`
  `TagEditor`, menu entries `:250`, `:265`). Project tags also render as chips on
  the project row (`:414`). A bot's tags save through `agent.team.update` (so a
  locked bot's are frozen); a project's through `project.update`.
  - `apps/desktop/src/types.ts:185,195` add `Agent.tags` / `Project.tags`.
- **Tests.** Storage: `tags_round_trip_and_validate_on_projects_and_bots` and
  `a_pre_fix39_database_gains_the_tags_columns` (an old database opens, gains
  both columns defaulted to `[]`, keeps tags across a reopen). Daemon:
  `row_tags_reach_the_manager_tools_and_are_owner_editable`,
  `row_an_ordinary_bot_cannot_use_update_project`,
  `row_a_locked_bot_refuses_a_tag_change`. UI:
  `apps/desktop/src/ui/TeamSidebar.tags.mounted.test.tsx` (new).

### Item 19.4 — a delegated task runs in the named project

- `team::delegate` accepts an optional `projectPath` and runs a newly created
  side conversation in it (`team.rs:503`). `proposals::apply_task`
  (`proposals.rs:449`) resolves the task's project and passes its folder.
- **The approval card shows the folder** (risk 7):
  `apps/desktop/src/ui/ProposalCard.tsx:127` — "Folder it runs in".
- Test: `row_a_task_runs_in_the_named_project` (the side session's `projectPath`
  equals the project folder).

### Item 19.5 — the permission-denial notice text

- `bloblex_agent_core::permission_summary` now takes the project and returns the
  classifier's category followed by the exact path or command it judged (for
  example `READ: src/main.rs`, `ASKED: C:\Outside\secrets.txt`,
  `SAFE_COMMANDS: git status`), so "denied" says *what* and *where*
  (`crates/bloblex-agent-core/src/lib.rs:118`). The daemon passes the session's
  project (`main.rs:3732`).
- Test: `permission_summary_names_the_category_and_the_target`.

---

## 2. Gate results (all run to completion, foreground)

- Rust tests: `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  → **all green**. The daemon suite alone: 384 passed, 0 failed (which includes
  the 13 new `fix39_p6_tests`); `bloblex-storage` 112 passed;
  `bloblex-agent-core` 11 passed.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` → **clean**.
- `npx tsc -b` → **clean**.
- `npx vitest run --maxWorkers=3` → **170 files, 1247 tests passed** (includes
  the new mounted tag test and the `teamSelectors` waiting-state test).
- `npm run build` → **built** (existing chunk-size warning only).
- **Not run:** `npm run build:remote` and `cargo test -p bloblex-desktop --lib`
  — neither the Remote app nor `src-tauri` was touched. The `tiers.json` parity
  test ran inside `vitest` and passed (no new daemon method or event was added).
- **`cargo fmt --check`** is **not clean at baseline** in these packages (574
  diffs in `bloblex-storage`, 68 in `bloblex-agent-core`, 1680 in
  `bloblex-daemon`, plus `src-tauri`); the repository deliberately uses a
  compact one-line style. My changes follow that style; I did not reformat
  existing code.

---

## 3. What I could not check

- **No visual check.** The tag chips/editor, the "waiting" indicator, the
  Settings › General "Bots working at once" row and the task card's folder line
  are CSS/JSX; I verified them by mounted tests and a build, not by eye, in both
  themes and both looks. The Director should look at the preview.
- **Live behaviour.** Parallel conversations and the queued-drain path are
  proven with fake adapters and a fake clock, not against a real Codex/Claude
  turn. The recap is proven from the daemon's own record; the friend's original
  resume-rejection reproduction (timeout, quit, reopen) is still owed by the
  Director.
- **Two daemons** (audit risk 4) may still exist on the owner's machine; that
  would contaminate a live manual test of items 18/20 and is P3's concern.

---

## 4. Files outside P6's listed set that I touched, and why

- `apps/desktop/src/ui/SettingsSheet.tsx` and `ui/settingsIndex.ts` — the owner
  decision says the global limit is "shown as a setting"; that row lives here.
- `apps/desktop/src/ui/BlobSettings.tsx` — the old read-only line showed a
  per-bot cap that no longer exists; it now names the global limit.
- `apps/desktop/src/ui/ProposalCard.tsx` — risk 7 requires the task approval
  card to show the folder. (P7 also lists this file for new proposal kinds.)
- `crates/bloblex-agent-core/src/lib.rs` — item 19.5, explicitly assigned to P6
  by the launch prompt; the brief lists it as P2's file but P5 could not reach it.
- Test files: the new `apps/desktop/src/ui/TeamSidebar.tags.mounted.test.tsx`,
  and edits to existing tests (`teamSelectors.test.ts`,
  `restart_send_is_accepted_then_resumes_and_prompts`) for the new behaviour.

`apps/desktop/src/remote/tiers.json` was **not** changed: P6 adds no daemon
method and no event (the recap is a transcript notice, an `agent.changed`
update and the existing `session.changed`), so the parity test stays green
without a new row.

---

## Follow-up (audit)

This section records the work done after `docs/history/fix-39/p6-audit.md` (verdict
**PASS WITH FIXES**). I took over the worktree (`lane/fix39-p6`) from the
previous implementer and kept their P6 changes; I applied every audit finding
and added the missing tests. Nothing was committed.

### 1. Refused retry no longer reorders the queue or stacks notices

`crates/bloblex-daemon/src/team.rs:650` (`deliver`) now takes a `retry` flag.
The drain (`:716`) retries with `retry = true`; a delegation and a relayed reply
start with `retry = false`.

- The conflict branch (`:659`) re-inserts a retried item at the **front** with
  `requeue_front` (`:700`) and writes no notice. A first arrival still queues at
  the back through `queue_delivery` (`:674`) and says it is waiting.
- The `session_busy` branch follows the same rule, so a race that makes the
  session busy again after the drain's check also keeps the item in front.
- Tests (fail on the pre-fix code):
  - `row_a_refused_drain_keeps_the_queue_order` (`main.rs:11009`): two items
    `[A, B]` with the only global slot held; after a refused drain the order is
    still `[A, B]` (it was `[B, A]`).
  - `row_repeated_refused_drains_write_one_waiting_notice` (`main.rs:11031`):
    after two refused drains the transcript holds exactly one `state: "queued"`
    notice (each retry used to add one).

### 2. A relayed reply queues silently

`queue_delivery` (`team.rs:678`) writes the "Waiting for…" notice only when
`meta.kind == "blob_message"`. A `blob_reply` delivered to a busy origin is
still queued, but adds no notice.

- Test: `row_a_reply_to_a_busy_origin_adds_no_waiting_notice` (`main.rs:11055`):
  the reply is queued (length 1) and the origin's transcript has zero queued
  notices.

### 3. A model change on a never-prompted non-Manager stays silent

`knowledge::announce_model_change` (`crates/bloblex-daemon/src/knowledge.rs:425`)
calls `announce_context_loss` only when `session_has_conversation_history` is
true (`:430`). A conversation with no messages is left untouched; nothing is
armed and no "no longer has earlier context" notice is written. The
Manager handover path is unchanged.

- Test: `row_a_model_change_on_a_never_prompted_bot_stays_silent`
  (`main.rs:11147`): no recap is armed and the transcript is still empty.

### 4. The task card resolves the project like the daemon

`apps/desktop/src/ui/ProposalCard.tsx:38` adds `projectForDraft`, matching by id
or by a trimmed, case-insensitive name (the same match as
`crates/bloblex-daemon/src/team.rs:430` and `proposals.rs:458`). The folder line
(`ProposalCard.tsx:145`) now shows the real path for an id, a differently cased
name or stray spaces, shows `Project not found` for an unknown name, and is
absent when no project is named.

- Tests in `ProposalCard.mounted.test.tsx`: a mounted assertion for exact name,
  `  kOrUs ` and id, unknown name and no project, plus a unit test of
  `projectForDraft`. On the pre-fix card the case/whitespace and id cases showed
  `—`.

### 5. Coverage and one stated gap

- **Retry-while-full:** covered by the two tests above; the old suite only
  proved a release when a slot was free.
- **UI:** `App.agent.mounted.test.tsx` now has
  `shows a waiting indicator for a queued side conversation`: it opens a side
  conversation whose last message is the queued notice, asserts
  `.working-indicator.waiting` names the bot, and asserts the
  `.session-first-state` ("Ready when you are") screen is absent.
  `SettingsSheet.appearance.mounted.test.tsx` now has
  `offers the global "Bots working at once" limit and saves it`: it reads the
  current value, checks the 1–16 options and asserts
  `settings.set { key: "concurrency.botsAtOnce", value: 2 }`.
- **Restart gap (not implemented, stated for the Director).** The in-memory
  `st.team.queued` still vanishes on a daemon restart, so a side conversation
  left showing a queued notice has no turn and will not restart until a new
  delivery is made. The research audit (item 18) suggested a `relay_failure`
  startup pass; P6 did not implement it. I have not added one in this follow-up:
  it needs a decision on the wording and on which sessions to sweep, and it is
  safe to leave for the Director/next package. No test claims it works.

### Extra change (not an audit finding)

- `apps/desktop/src/types.ts:222` adds `'waiting'` to `MessageMeta.direction`
  and `:224` adds `state?: 'queued'`. The daemon already emits both on the
  queued notice; without the type the new mounted App test does not typecheck.
  No runtime behaviour changes.

### Notes carried from the audit (no action taken)

- Agent **export and duplicate** do not carry `tags` (`insert_agent` ignores
  them). Acceptable for P6; the documentation lane should mention it.
- `TagEditor` calls `rpc` directly rather than going through the sidebar
  `actions` object. It works and is tested; left as-is to keep the diff small.
- `cargo fmt --check` is dirty at baseline (compact one-line style); the new
  code follows the surrounding style and no reformatting was done.

### Gate results (rerun after the follow-up, `TEMP=C:/fxt/c2/tmp`)

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  → all green. `bloblex-daemon` **388 passed** (includes the 17 `fix39_p6_tests`),
  `bloblex-storage` **112 passed**, `bloblex-agent-core` **11 passed**.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` → clean.
- `npx tsc -b` → clean.
- `npx vitest run --maxWorkers=3` → **170 files, 1251 tests passed**
  (1247 before the follow-up; +4 new tests).
- `npm run build` → built (existing chunk-size warning only).
- **Not run:** `npm run build:remote` and `cargo test -p bloblex-desktop --lib`
  — neither the Remote app nor `src-tauri` was touched.

### What I could not check

- The visual result of the tag editor, waiting indicator, settings row and task
  card folder line: verified by mounted tests and a build, not by eye in both
  themes/looks. The Director should look at the preview.
- Live behaviour of the queue (real Codex/Claude turns) and the restart gap
  above remain unverified by tests.

