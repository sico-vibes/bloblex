# FIX39 P7 implementation report

> **What this is:** Implementation report for FIX39 package P7: the Bitbots tool set for the Manager.
> **Status:** historical
> **Last updated:** 2026-10-18

Status: implementation complete; all required gates green (see Gates, and the follow-up pass below). No production turn-path changes in main.rs.

A follow-up pass by a second implementer (DeepSeek V4.1 Flash, same worktree) reviewed the package against `docs/history/fix-39/decisions.md` (P7 section and decision 7), found and fixed one blocker, and ran every gate to completion. That pass is marked below; everything else is the first implementer's work.

## Scope and design

P7 uses the existing local, per-session-capability bloblex MCP bridge. There is no new listener, endpoint, daemon RPC or event. The existing `mcp.* = never` row in `apps/desktop/src/remote/tiers.json` covers every tool below, so no policy row was added or widened.

Existing `bot`, `project` and `task` proposal kinds carry an explicit `action` for updates/opening. This avoids a storage migration and keeps old create proposals working. Legacy pending task cards receive conservative completion/report defaults at approval; every new Manager delegation must supply the contract itself. All mutations remain owner-approved. Decisions are serialized so simultaneous approvals cannot execute a proposal twice.

## Deliverables and evidence

| Requirement / tools | Implementation | Tests |
|---|---|---|
| List/read bots and status: `list_blobs`, `read_blob` | `team.rs:216`, `team.rs:918`, `team.rs:954`: role, tag, project and free-bot filtering; ids and busy state; selected bot fields exclude custom environment and credentials. | `team_p7_tests.rs:80`, `team_p7_tests.rs:191`; existing Manager/non-Manager tool tests in main.rs. |
| List/read projects and status: `list_projects`, `read_project`, `project_status` | `team.rs:856`, `proposals.rs:318`: resolve exact ids or unique case-insensitive names. Ambiguous/unknown projects are refused with grounding guidance. | `team_p7_tests.rs:80`, `team_p7_tests.rs:191`; existing project-status/tag tests. |
| List/read conversations: `list_conversations`, `read_conversation` | `team.rs:918`, `team.rs:945`: Manager sees registered conversations/status, with bot/project filters. Reads return the latest 30 messages, at most 4000 characters each, without provider payloads. | `team_p7_tests.rs:80`, `team_p7_tests.rs:239`; ordinary-bot conversation/relay tests remain. |
| Bot creation: `propose_bot` | `proposals.rs:28`, `proposals.rs:150`, `proposals.rs:473`: tags, effort, look and safe permission; existing catalog-aware creation path. Full access refused. | `team_p7_tests.rs:167`: no creation before approval; ordinary-bot refusal; approved fields persisted; bypass refused. |
| Bot editing: `update_blob` | `proposals.rs:660`, `proposals.rs:693`, `proposals.rs:700`: proposal-gated name, description, role, instructions, tags, look, model, effort (`thinking`) and permission (`approvalMode`). Unknown fields refused; normal agent.update catalog normalization reused; locks rechecked at approval. | `team_p7_tests.rs:26`: each supported field, pending state, ordinary-bot refusal and lock before/after proposing. `team_p7_tests.rs:226`: edited bypass and concurrent approvals. |
| Projects/tags: `propose_project`, `update_project` | `proposals.rs:140`, `proposals.rs:660`, `proposals.rs:700`: validated tags, approved creation and approved description/tag edits. | `team_p7_tests.rs:50`, `team_p7_tests.rs:167`: no early write, approval result, ordinary-bot/unknown target/invalid tag refusal. |
| Start/message parallel side conversations: `assign_task`, `start_conversation`, Manager `message_blob` | `proposals.rs:182`, `proposals.rs:268`, `proposals.rs:508`, `proposals.rs:761`, `proposals.rs:786`: required Manager-filled brief, doneGoal and reportBack. New topics create parallel chats; conversation ids continue a chat. No implicit send before approval. Targets are stored as ids, with display names on the card. Wrong-project bots/conversations and projects without usable folders are refused. Existing started/queued outcomes preserved. | `team_p7_tests.rs:63`, `team_p7_tests.rs:137`: both proposal/refusal and approved delivery for all three tools; distinct parallel ids; contract in delivered messages; follow-up reuses its id. `team_p7_tests.rs:251` checks wrong-project and missing-folder refusal. Existing started/queued and relay tests updated to explicitly approve first. |
| Open a conversation: `open_conversation` | `proposals.rs:775`, `ProposalCard.tsx:94`: proposed target revalidated at approval; the desktop selects only the approved result, using its existing selection functions. | `team_p7_tests.rs:97`; mounted card tests verify no early selection, approved selection and no selection on rejection. |
| Read/change permission: `get_conversation_permission`, `set_conversation_permission` | `team.rs:918`, `proposals.rs:539`, `proposals.rs:729`: read bot/effective permission; approved change applies to the bot and existing non-automation conversation pins, next turn. Own-side-conversation and lock checks retained; bypass refused. | `team_p7_tests.rs:80`, `team_p7_tests.rs:207`; existing P5 permission proposal tests. |
| Stable tools, natural team-lead routing and proposing missing teammates/projects | `team.rs:148`, `team.rs:856`, `knowledge.rs:346`: stable documented tool names; list projects/bots first; resolve project before acting; ask_user with options when uncertain; free researcher for unscoped research, project researcher for project work; propose a bot/project when none fits. No user task form. | `team_p7_tests.rs:109`, `team_p7_tests.rs:191`; mounted task card shows the Manager-filled contract without inputs until optional Edit. Live model compliance is not claimed. |
| Ordinary bots and automation sessions | `team.rs:216`, `team.rs:269`: ordinary tools and schemas remain; new Manager tools are dispatch-gated; existing automation recursion guard remains. | Per-tool ordinary-bot refusals above and existing automation tool tests. |
| Approval cards | `ProposalCard.tsx:76`, `ProposalCard.tsx:116`, `ProposalCard.tsx:163`, `ProposalCard.tsx:177`: clear update/open actions, proposed fields, look preview, completion/report text and project folder. Permission scope is stated plainly. | `ProposalCard.mounted.test.tsx`: new update/project/task/open cases, approval selection and rejection; existing create/edit/folder/permission tests. |

All daemon file references above are under `crates/bloblex-daemon/src/`; UI references are under `apps/desktop/src/ui/`.

## Failing-first evidence

Before implementation, the P7 daemon tests reproduced direct project writes, missing bot fields, immediate Manager message delivery, missing read/open tools and missing researcher guidance. The first read test also exposed an invalid test fixture environment key; that fixture was corrected to a permitted LANG value before green runs. Mounted tests started with four failures for bot updates, project updates, task contracts and conversation opening.

## Gates

All gates were re-run to completion by the follow-up pass on the final source (worktree `lane/fix39-p7`, branch at `122ab81` + this diff). Every gate is green; every number below is from that run.

- **Workspace Rust gate:** `cargo test --workspace --exclude bloblex-desktop --no-fail-fast -- --skip session_environment_reports_a_git_branch` → **exit 0, 0 failed in every target.** The daemon `bitbotsd` binary target reported **401 passed, 0 failed, 0 ignored, 1 filtered out** (the skip below); this includes all 14 P7 tests in `team_p7_tests.rs`, the daemon smoke, parent-watchdog and process-tree integration tests. Log: `C:/fxt/d3/p7-workspace.log`.
- **Workspace clippy:** `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` → **exit 0, no warnings.**
- **UI typecheck:** `npx tsc -b` (apps/desktop) → **exit 0.**
- **UI unit tests:** `npx vitest run --maxWorkers=3` → **170 files passed, 1257 tests passed, 0 failed**, including the new P7 mounted cases in `ProposalCard.mounted.test.tsx`. Log: `C:/fxt/d3/p7-vitest.log`.
- **UI production build:** `npm run build` (apps/desktop) → **exit 0**, built in ~22 s. Log: `C:/fxt/d3/p7-build.log`.
- No `src-tauri` source and no remote-app source or policy changed, so the conditional native (`cargo test -p bloblex-desktop --lib`) and remote (`npm run build:remote`) gates were not required.

Reproduction settings: `CARGO_TARGET_DIR=C:/fxt/d3`, `TEMP=TMP=C:/fxt/d3/tmp`, `RUST_MIN_STACK=33554432`.

**One deliberately filtered test (explicit exception, not counted as a pass).** `session_environment_reports_a_git_branch` (`main.rs:6862`) runs `git commit` inside a throwaway temp repository. It is skipped on every run to respect the owner's no-`git commit` instruction. No commit was made in this worktree. An earlier unfiltered run also hit an unrelated watchdog integration timeout that passed once the workspace gate ran; P7 touches neither path.

### Follow-up pass fix (second implementer)

First run of the final workspace gate exposed one failing P7 test that the first implementer had left red:

`team::p7_tests::p7_archived_manager_cannot_fall_back_to_ordinary_message_routing` — **failed** before the fix.

- **Cause:** `mcp_rpc`'s `is_manager` check (`crates/bloblex-daemon/src/team.rs:288`) tested `row["archived"] != true` on the *session*. Archiving the Manager's conversation therefore made `is_manager` false, so `message_blob` fell through to the **ordinary** sender path and delivered immediately with no approval card — the exact downgrade the test guards against.
- **Fix:** dropped the session-level archived test from `is_manager`; Manager identity now follows the session's bot (`agentId` → `systemRole == "manager"` and the bot not archived), as it did before P7. Every Manager write still re-checks `manager_of_session` (`proposals.rs:211-218`), which refuses an archived conversation, so an archived Manager session is refused rather than downgraded. Comment added at `team.rs:285-289`.
- **Result:** the test now passes; all 14 P7 tests and the full workspace gate are green (numbers above). No other test or surface changed.

Earlier first-implementer verification (kept for history): workspace gate 798 passed / 0 failed with the archived test red; daemon unit 397–400 passed; watchdog passed on the rerun. Those counts are superseded by the run above.

## Limits and handoff

- No live model, installed Bitbots, personal database, phone, tailnet or native-window verification was performed. Daemon delegation tests use fake adapters, in-memory databases and temporary folders under C:/fxt/d3/tmp.
- The Director still needs visual checks of the cards in both themes and both looks, and a real Manager chat to judge routing, questions and tone. Mounted/source tests do not prove model compliance.
- The required Sonnet implementation audit is still the Director's lane; this report does not self-certify that audit.
- Worktree edits are limited to team.rs, proposals.rs, knowledge.rs, main.rs (tool tests only), ProposalCard.tsx, its mounted tests, the new team_p7_tests.rs and this report. No other production file was needed; tiers.json is unchanged because the existing never-remote MCP family already covers the tools.
- Cargo output and test temporaries use C:/fxt/d3 and C:/fxt/d3/tmp. No worktree commit, merge, release or installed-app/data operation was performed. No process outside the tests' own spawned children was ended.
- The follow-up pass changed only `crates/bloblex-daemon/src/team.rs` (the `is_manager` check and its comment) and this report. It added no file, touched nothing outside the package's file list, and left `tiers.json` unchanged.

## Follow-up (audit) — third implementer (DeepSeek V4.1 Flash)

This pass answers `docs/history/fix-39/p7-audit.md` (verdict FAIL, blocker B1). I read the bundle, the audit, the research items 16/19/21/22 and the P7 decisions, kept the first implementer's work, and fixed B1 first, then F1–F7. No file outside the package list was touched; `tiers.json` is still unchanged (no new RPC, listener or event — `open_conversation` and the read tools reuse the existing session-capability MCP bridge and the proposal events).

### B1 (blocker) — approved permission change no longer pins model/effort/mode
The bot's `approvalMode` is now the single source of truth; the approval writes only the bot.
- `sync_bot_permission` (`crates/bloblex-daemon/src/proposals.rs:753`) was rewritten. It no longer calls `conversation_lock_for`, so it never builds a lock and never writes a bot's current model/effort into a session. For each of the bot's non-automation sessions it does exactly one thing: if the session **already** has `modelLock.approvalMode`, it removes `approvalMode` and `approvalModeSource`, keeping the rest of the lock (model, effort, workflows, speed, plan mode) untouched, and writes it back. A session with no lock, or a lock with no `approvalMode`, is left alone. Errors are swallowed per session (best-effort), so one failing chat cannot undo the approved bot change or turn the approval into an error.
- Callers `apply_permission` (`proposals.rs:570`) and `apply_update` (`proposals.rs:742`) now call it without a mode and without `?`.
- Four failing-first daemon tests in `crates/bloblex-daemon/src/team_p7_tests.rs::p7_permission_change_releases_pins_and_bot_stays_the_source_of_truth`: (1) after approval a chat with no lock still has `modelLock == null`; (2) a later bot model change is picked up by `exec_options_for_session` for that chat; (3) a later bot permission change is picked up (this failed on the old code, which pinned `auto`); (4) a chat that had an `approvalMode`/`approvalModeSource` pin keeps its model and effort but follows the bot again. On the pre-fix `sync_bot_permission` all four fail at assertion 1 (the old code created a lock for every session).
- The two P5 tests that asserted the removed per-conversation pin (`main.rs:10802`, `main.rs:10825`) now assert the bot's mode and that no conversation lock is created. The P7 permission proposal is bot-wide (the audit accepted that) only with B1 fixed.

### F1 — stray `?` in the roster
`team.rs:371` now appends ` · id: {id}` (a real separator) after the tags suffix, so the line reads in one order and ordinary bots no longer see `? id:`. The existing roster assertions in `main.rs` still hold.

### F2 — the Manager's `list_conversations` keeps what its prompt relies on
`manager_conversations` (`team.rs:969`) now takes the session id and each row carries `startedByYou` (side conversation whose `link.peerAgentId` is the Manager), `topic`, `agentName` (the bot the conversation belongs to), `peerName`, and a `latestReply` clipped to 300 characters from the last assistant message. Newest-first comes from `session_list`'s `ORDER BY updated_at DESC`; rows are capped at 100. The loosened assertion in `main.rs:4724` is restored to strict checks against the new fields (`startedByYou`, `topic`, `agentName`, `title`). New daemon tests: `p7_manager_conversations_carry_origin_topic_peer_and_reply` and `p7_manager_conversations_are_newest_first_and_match_project_paths` (order preserved and cap at 100).

### F3 — approval notes name the target, not its id
`describe` (`proposals.rs:362`) prefers `targetName` (bot/project update), `botName` (task), and the conversation `title` for an open card, falling back to the id for legacy cards. Test `p7_describe_prefers_display_names_over_ids`.

### F4 — the Manager-role check is no longer a blanket gate; the sweep takes the decision lock
`apply` (`proposals.rs:391`) checks `manager_of_session` only on the new `update` and `open` branches (`apply_task` already re-checks). A Manager whose conversation was archived can again approve a `playbook`/`profile`/`permission`/create card. `sweep_at` (`proposals.rs:625`) now takes `st.team.proposal_decision`, the same mutex as `proposal.decide`, so an expiry and an approval of one card cannot race. No path calls the sweep from inside a decision, so there is no lock-order problem.

### F5 — refusal coverage
New table test `p7_every_manager_tool_is_refused_for_an_ordinary_bot` builds the names from `manager_tool_schemas()` plus `proposals::tool_schemas()` (14 names, asserted) and expects each to be refused with "Only the Manager"; it also confirms `list_blobs`/`list_conversations` stay available to an ordinary bot. New `p7_permission_proposal_refuses_bypass` covers `set_conversation_permission` with `mode: "bypass"`. `list_projects`/`project_status` refusals are covered by the table; `list_conversations` Manager-vs-ordinary is covered by `p7_manager_conversations_carry_origin_topic_peer_and_reply`.

### F6 — depth checked at creation
`team::depth_exceeded` / `team::depth_error` (`team.rs:106`) are used by `assign_task` (`proposals.rs:273`) before a card is created; `delegate` re-checks at delivery. `main.rs`'s old approval-time test now asserts the creation-time refusal, and `p7_depth_is_refused_before_a_card_is_shown` proves no proposal is left pending. The existing routing-prompt test (`team_p7_tests.rs:118`) is kept as a guard against silent text edits only; it is not counted as proof of routing.

### F7
- `manager_blobs` excludes the Manager itself from its own delegation results (so a tagged Manager is never offered), and the `freeOnly` property now says it means "not tied to a project (free bots), not merely idle".
- `manager_conversations`' project filter compares folders through `normalized_path` (`team.rs:965`: trimmed, backslashes to slashes, trailing slash dropped, lower-cased), tested with `c:\temp\caseproj\` against `C:/Temp/CaseProj`.
- `apply_update` (`proposals.rs:713`) documents that both halves are validated by `validate_update` before either write (role length and tag shape that `agent_set_team` enforces), so a second-step failure is a storage error, not an uncaught validation.
- `ProposalCard.tsx`: the **Edit** button is hidden on the *Open a conversation* card, and the create-bot and update cards both use "Ask first"/"Auto" through one `permissionLabel` helper. The mounted test that expected the raw `auto` now expects `Auto`.
- The duplicated tool names in `runtime_instructions` are gone; the line now refers to the exact tool names in the Manager's notes (`knowledge.rs` keeps the single short list), so the two cannot drift.
- Left for the Director still: the hard-coded look-preview colour `#a7f3d0`, and the visual check of the cards in both looks and both themes.

### Gates (rerun to completion by this pass)
All green on the final source (worktree `lane/fix39-p7`), every number from this run. Repro: `CARGO_TARGET_DIR=C:/fxt/d3`, `TEMP=TMP=C:/fxt/d3/tmp`, `RUST_MIN_STACK=33554432`.

- **Rust workspace:** `cargo test --workspace --exclude bloblex-desktop --no-fail-fast` → **exit 0**. The daemon `bitbotsd` binary target reported **409 passed, 0 failed**. `session_environment_reports_a_git_branch` was **run, not skipped** (the audit needs it; it commits only inside its own throwaway temp repo) and passed. Log: `C:/fxt/d3/p7c-workspace.log`. (One earlier parallel run had two flakes — the git-branch test and an unrelated `bloblex-speech` cloud challenge test — that both pass in isolation and in the clean rerun above.)
- **Workspace clippy:** `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` → **exit 0, no warnings.**
- **UI typecheck:** `npx tsc -b` (apps/desktop) → **exit 0.**
- **UI unit tests:** `npx vitest run --maxWorkers=3` → **170 files passed, 1257 tests passed, 0 failed**, including the updated P7 mounted cases. Log: `C:/fxt/d3/p7b-vitest.log`.
- **UI production build:** `npm run build` (apps/desktop) → **exit 0**, built in ~11 s.
- No `src-tauri` and no remote-app source or policy changed, so `cargo test -p bloblex-desktop --lib` and `npm run build:remote` were not required.
- 14 → 21 P7 daemon tests in `team_p7_tests.rs`; all pass.

### What I could not check
- No live model, installed Bitbots, personal database, phone, tailnet or native-window verification. The new tests use fake adapters, in-memory databases and temp folders under `C:/fxt/d3/tmp`.
- The dedicated failing-first demonstration was reasoned from the audit's B1 analysis plus the removed code (which created a lock for every session); I ran the tests after the fix, not against a checked-out pre-fix revision.
- Visual checks (both looks, both themes) and live Manager routing remain the Director's.

### Files touched by this pass
`crates/bloblex-daemon/src/proposals.rs`, `crates/bloblex-daemon/src/team.rs`, `crates/bloblex-daemon/src/team_p7_tests.rs`, `crates/bloblex-daemon/src/main.rs` (permission-proposal test expectations, `list_conversations` assertions, the depth test), `apps/desktop/src/ui/ProposalCard.tsx`, `apps/desktop/src/ui/ProposalCard.mounted.test.tsx`, and this report. `knowledge.rs` is unchanged from the previous pass. One stray, line-ending-only change to `docs/history/fix-39/audit-impl-brief.md` was already in the worktree; it is not part of this package and should not be merged. No `git commit` was run.

