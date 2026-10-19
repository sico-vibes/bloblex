# FIX36 D2 — the Manager proposes, the owner approves (lane report)

> **What this is:** Lane report for FIX36 D2: the Manager proposes and the owner approves.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, worktree `C:\fx57`,
private `CARGO_TARGET_DIR=C:\fxt\d2`. No `git commit` was run.
`apps/desktop/src/ui/**` was not touched.

Spec: [docs/history/fix-36/d2-proposals-spec.md](d2-proposals-spec.md). Builds on
[FIX36 D1](d1-report.md).

Owner decision: every consequential action (creating a project, creating a bot,
assigning a task, and later the playbook) is written down as a proposal and
surfaced as an ordinary permission card. Nothing is created before the owner
approves it.

## 1. Storage (`crates/bloblex-storage/src/lib.rs`)

- **Schema (additive, no `user_version` bump).** New `ensure_proposal_schema`
  creates
  `proposals(id TEXT PK, session_id, agent_id, kind CHECK IN ('project','bot','task','playbook'), payload JSON, status CHECK IN ('pending','approved','rejected','expired'), result JSON NULL, created_at, decided_at)`
  plus `idx_proposals_status`. It is idempotent and runs on every open, after
  `ensure_remote_schema`, in every migration path (all five open branches).
- **`projects.description`** — additive `ALTER TABLE projects ADD COLUMN
  description TEXT NOT NULL DEFAULT ''` (and in the fresh `CREATE TABLE`), so a
  proposed project keeps its one-sentence purpose. `project_rows` now exposes
  `description`, and `project_update` accepts it (≤ 255 chars; `null` clears it).
  No other project query or backup path changes.
- **`insert_proposal(record, permission, created_at, expires_at)`** writes both
  rows in one `IMMEDIATE` transaction: the `proposals` record (`record` names
  `id`/`sessionId`/`agentId`/`kind`/`payload`) and the visible
  `permission_requests` card (`data.kind='proposal'`, `provider_request_id`
  `proposal:<id>`, `expires_at`). A missing session is `AgentNotFound`; an
  unknown kind is `InvalidAgent`.
- **`proposal_get(id)`** returns
  `{id, sessionId, agentId, kind, payload, status, result, createdAt, decidedAt}`
  (`result` is JSON `null` until decided).
- **`proposal_decide(id, status, result, decision, decided_at)`** claims a
  pending proposal (`UPDATE … WHERE status='pending'`; the loser gets `false`)
  and, in the same transaction, resolves its permission card
  (`status='resolved'`, `data.choice` = `approve`/`reject`).
- **`expire_due_proposals(cutoff, decided_at)`** marks every pending proposal
  whose `created_at <= cutoff` as `expired` (recording `decided_at`) and marks
  its permission card `expired`, returning one row (`id`, `sessionId`,
  `agentId`, `kind`, `payload`) per proposal so the daemon can announce it. The
  cutoff is passed in, so the daemon's clock is injectable.
- **Question sweep skip.** `expire_due_questions` now excludes
  `json_extract(data,'$.kind') IS NOT 'proposal'`, so a lapsed proposal is never
  reported (or noted) as a lapsed *question*; `proposals::sweep` owns it.
- **Snapshot.** `snapshot()['permissions']` now also extracts
  `$.proposal` from the card data, so the main window, companion and tray badge
  see the proposal without a new query.

## 2. Daemon

### New module `crates/bloblex-daemon/src/proposals.rs`

- **Tool schemas** for the Manager: `propose_project`, `propose_bot`,
  `assign_task`, `project_status`.
- **`propose_project`** validates `name` (1–80), `description` (≤ 255) and
  `folder` (`mode:"new"` with optional `parentHint`; `mode:"existing"` with a
  required `path`). On approve: `existing` requires the folder to exist; `new`
  requires `edits.folder.path` and creates the directory with
  `std::fs::create_dir_all` (no shell) before creating the project. The
  description is stored on the project.
- **`propose_bot`** reuses the old `create_blob` validation: name 1–40 and
  unique (non-archived), role ≤ 40, description ≤ 255, instructions ≤ 4000,
  `provider` ∈ claude/codex/opencode with an installed runtime, team cap 12. On
  approve it creates the bot through `agent_create_from_rpc` and then
  `agent_set_team` (role, and the project resolved by id or exact name — so a
  project approved earlier in the same plan resolves). The created bot inherits
  a safe mode (`auto` only when the Manager's effective mode is `auto`, else
  `ask`; never bypass). The project is resolved *before* the create, so a bad
  project leaves no half-made teammate.
- **`assign_task`** validates `bot`, optional `project` and `brief`. On approve
  it delivers through the same code path as `message_blob` (side conversation,
  depth caps, `link.spawnedFromSessionId` = the Manager's conversation), via a
  new shared `team::delegate` that `message_blob` now also wraps.
- **`project_status`** is read-only: a project's bots with each bot's latest
  conversation title, state and last activity.
- **`decide(st, {id, decision, edits?})`** merges the owner's `edits` into the
  stored payload (one nested level, so `{"folder":{"path":…}}` works),
  re-validates, then for `reject` claims and notes the refusal; for `approve`
  runs the action, records `result`, resolves the card, notes the outcome and
  emits `proposal.changed`. A validation failure (missing folder, unknown
  project) is `invalid_argument` and leaves the proposal **pending** so the
  owner can fix the card and retry. A second decision is `conflict`.
- **Notes** go into the Manager's conversation (`team::note`) as
  `"Approved: created project Yummy"` / `"Rejected: create project Nope"` /
  `"Expired: …"`, each with `meta.kind="proposal"`, so the Manager sees the
  outcome on its next turn.
- **`sweep` / `sweep_at(st, now)`** expire lapsed proposals (24 h) and emit
  `permission.resolved` (`status:"expired"`) and `proposal.changed`. `sweep_at`
  takes the clock, so expiry is testable without waiting.

### Wiring (`main.rs`, `team.rs`, `automations.rs`)

- `mod proposals;`.
- Dispatch: `"proposal.decide" => crate::proposals::decide(st, &p).await`.
- `permission.reply` refuses a `kind:"proposal"` card with
  `invalid_argument` (`"Decide a proposal with proposal.decide."`), so a
  proposal can never be answered through the provider path.
- The Manager's MCP tool list gains the four new tools; an ordinary bot is
  offered none of them and is refused with the existing Manager-named error.
- The periodic automation sweep now also runs `proposals::sweep`.
- The Manager's runtime paragraph gained one sentence naming the new tools:
  *"Consequential actions are proposed, not done: call `propose_project`,
  `propose_bot` or `assign_task`, which create nothing until the user approves
  the card, then end your turn. Use `project_status` to see a project's bots."*
  (This changes the instruction hash once more, as a feature release does.)

### `ask_user` for every provider (`questions.rs`, `team.rs`)

- The OpenCode-only gate is removed: `ask_user` is offered in **every** bot's
  own conversation (Claude, Codex, OpenCode), still never in side conversations
  or automation runs. The provider check inside `ask_user_tool` is gone and the
  refusal text is now *"ask_user is available in a bot's own conversation; not
  in side conversations or scheduled runs."*
- Bounds widened to the spec shape: 1–6 questions, each with an optional `id`
  (≤ 64, unique) and optional `header` (≤ 40), a required `question` (≤ 400),
  and 0–10 options (label ≤ 80, description ≤ 200); `multiSelect`/`allowOther`
  as before (`allowOther` defaults true). A question with no options must allow
  a free-text answer. Option arrays are always emitted (possibly empty), so the
  existing card UI is safe. It still travels over the existing
  `kind:"question"` permission and `questions.expirySecs`, and the answer still
  returns as the conversation's next user message.

## 3. Non-visual TypeScript

- `apps/desktop/src/types.ts`: `PermissionRequest.kind` may be `'proposal'`, and
  a new `ProposalCard { id, kind, payload? }` with `PermissionRequest.proposal`.
- `apps/desktop/src/remote/tiers.json`: `proposal.decide` (`approve`/operator)
  and the `proposal.changed` event (`allow`).
- `apps/desktop/src/remote/remoteTiers.parity.test.ts`: the reviewed allow list
  now includes `proposal.changed`.
- `apps/desktop/src/preview/fixtureBridge.ts`: a pending fixture proposal
  (`kind:"proposal"`, `proposal.kind:"bot"`) alongside the fixture question, and
  a `proposal.decide` handler that resolves it and raises `permission.resolved`
  + `proposal.changed`.

## Tests

Storage (`crates/bloblex-storage/src/lib.rs`, `memory_tests`):

- `proposals_are_cards_the_question_sweep_ignores_and_a_decision_resolves_them`
  — a proposal is a durable row and a `kind:"proposal"` card in the snapshot;
  the question sweep ignores an expired proposal card but still expires a real
  question; `expire_due_proposals` lapses the row, its card and returns it for
  announcement; only a pending proposal can be decided and a decision resolves
  the card and stores `result`.

Daemon (`crates/bloblex-daemon/src/main.rs`, `phase2a_tests`):

- `manager_proposals_wait_for_approval_and_create_nothing_first` — a non-manager
  is refused all three tools with the Manager-named error; the Manager is
  offered `propose_project`/`propose_bot`/`assign_task`/`project_status` and an
  ordinary bot is not; each `propose_*` writes a pending proposal and a
  `kind:"proposal"` card and creates nothing (no project, no bot, no side
  conversation); the card carries kind, payload, choices and `expiresAt`.
- `approving_a_project_proposal_with_edits_creates_it_and_rejecting_creates_nothing`
  — `mode:"new"` without a chosen folder → `invalid_argument` and the proposal
  stays pending; with `edits.folder.path` the directory is created and the
  project stored (name + description); the Manager gets
  `"Approved: created project Yummy"` and `proposal.changed` +
  `permission.resolved` are emitted; a reject creates nothing, notes
  `"Rejected: create project Nope"`, and a second decision is `conflict`; the
  card cannot be answered through `permission.reply`.
- `approving_a_bot_proposal_creates_the_edited_bot_and_assign_task_matches_message_blob`
  — approve-with-edits creates the bot with the edited name/role and never
  bypass; `assign_task` approve opens a side conversation whose link has
  `spawnedFromSessionId`/`originSessionId` = the Manager's conversation and
  delivers the brief; a rejected task opens no conversation.
- `lapsed_proposals_expire_after_a_day_and_cannot_be_decided` — an injected
  clock 25 h ahead lapses the proposal and its card, notes `"Expired: …"`, emits
  `permission.resolved` (`expired`) and `proposal.changed`, and a later decide
  is `conflict`; a proposal created at "now" survives a sweep run at "now".
- `ask_user_is_listed_for_every_providers_own_conversation` (rewritten from the
  OpenCode-only test) — `ask_user` is listed and succeeds for OpenCode, Codex
  and Claude conversations, shows as a `kind:"question"` card, and a
  non-OpenCode answer is delivered back as the conversation's next message; it
  stays hidden and refused in side conversations and automation runs.
- `ask_user_validates_bounds_persists_an_expiring_card_and_leaves_the_turn_idle`
  — updated to the new bounds (> 6 questions, > 10 options, a no-option
  question that forbids free text are refused; unknown fields, an over-long
  header and an over-long label are still refused).

TypeScript: `npx tsc -b` and `npx vitest run src/remote src/preview` (the tier
parity test fails the build if a dispatched method or an emitted event has no
`tiers.json` row).

## Gates

Run in this worktree with `CARGO_TARGET_DIR=C:\fxt\d2`, after the final edit:

- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` —
  **clean** (exit 0).
- `cd apps/desktop && npx tsc -b` — **clean** (exit 0).
- `cd apps/desktop && npx vitest run src/remote src/preview` — **13 files, 207
  tests passed**.
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — **all suites ok, 0 failed** (99 in `bloblex-storage`, 320 in
  `bloblex-daemon`, every other binary ok; no `FAILED`, no `panicked`, no build
  errors). The full gate was run and waited for **after** the last source edit.

## Unverified / notes

- **UI is not touched.** The `kind:"proposal"` card and `proposal.decide` call
  are wired through the permission plumbing but no screen renders the proposal
  card yet; the Director's UI does that. The type and fixture are in place.
- **`proposal.decide` has no params rule** in `tiers.json` (`params: null`);
  like the other approve methods it is gated by class/tier and the host's
  "approvals from remote" switch. A per-params check (id + decision) was not
  added, to avoid a fourth check that both `remoteTiers.ts` and `policy.rs`
  would have to implement in lockstep.
- **Partial-state edge.** An approve merges `edits`, re-validates and resolves
  the project before creating a bot, so a bad project cannot strand a bot. A
  project proposal that creates a folder and then fails `project_create` (a DB
  error) could leave the folder behind; that path is not covered by a test.
- **`leader` remains vestigial** (D1); nothing in D2 reads it.
- **Playbook proposals** are accepted by the schema (`kind='playbook'`) but
  `proposal.decide` refuses an approve for them with `invalid_argument`
  ("arrives in a later release"); D3 owns that tool.
- **`mode:"new"` accepts a manager-supplied `path` too.** The owner's
  `edits.folder.path` is the intended source, but a manager-provided path is not
  rejected (the owner still has to approve), so an automated test or a future
  tool could pre-fill it.
- **Instruction hash.** The Manager paragraph changed, so existing bots re-send
  their instructions on the next turn after this release.
