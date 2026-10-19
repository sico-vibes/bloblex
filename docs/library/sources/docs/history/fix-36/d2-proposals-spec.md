# FIX36 D2: the Manager proposes, the owner approves — projects, bots, tasks, and questions

> **What this is:** Spec for FIX36 D2: the Manager proposes and the owner approves (projects, bots, tasks and questions).
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree, private `CARGO_TARGET_DIR`. **Do not run `git commit`.** Builds on D1 (read `docs/history/fix-36/d1-report.md`). Read `AGENTS.md` first. Keep your context small: grep and read only the ranges you need; pipe long output through `tail`/`grep`. Do not edit `apps/desktop/src/ui/**`.

## Owner decision
Every consequential action needs the owner's approval: creating a project, creating a bot, assigning a task, and changing the Manager's playbook (D3). Nothing is created before approval.

## 1. Proposals (storage + daemon)
- Table `proposals(id TEXT PK, session_id, agent_id, kind CHECK IN ('project','bot','task','playbook'), payload JSON, status CHECK IN ('pending','approved','rejected','expired'), result JSON NULL, created_at, decided_at)`, additive `ensure_*`.
- Surface each pending proposal through the **existing permission-request plumbing** as `PermissionRequest { kind: "proposal", proposal: { id, kind, payload } }` so the main window, companion, tray badge and approval counts already include it (reuse how `ask_user` questions are surfaced). Expire after 24 h.
- `proposal.decide { id, decision: "approve" | "reject", edits? }`: `edits` is a partial payload the owner changed in the card (validated like the original). On approve, run the action, store `result`, resolve the permission, and post a short note into the Manager's conversation ("Approved: created project Yummy" / "Rejected: …") so the Manager sees the outcome on its next turn. Emit `proposal.changed`.
- Add `proposal.decide` (approve tier, operator) and `proposal.changed` (event, allow) to `apps/desktop/src/remote/tiers.json`.

## 2. Manager-only MCP tools (all return immediately with "Waiting for the user's approval (proposal <id>)")
- `propose_project { name, description, folder: { mode: "new", parentHint?: string } | { mode: "existing", path: string } }`. On approve: `mode:"existing"` validates the folder exists and creates the project; `mode:"new"` requires `edits.folder.path` (the owner picks the parent in the card; the UI sends the final path) and creates the directory (no shell) then the project.
- `propose_bot { name, role, description, instructions, provider, model?, project? }`. Validation as the old `create_blob` (name 1–40, role ≤40, description ≤255, instructions ≤4000, unique name, provider claude|codex|opencode with an installed runtime, team cap 12). On approve: create the bot through `agent_create_from_rpc` + `agent_set_team` (project by id or name; may be a project approved earlier in the same plan).
- `assign_task { bot, project?, brief }`. On approve: deliver exactly as `message_blob` does today (side conversation, depth caps), recording `link.spawnedFromSessionId` = the Manager's conversation.
- Keep `message_blob` for the Manager for questions to bots (not tasks). Keep `list_projects`, `list_blobs`, `list_conversations` read-only; add `project_status { project }` → bots in it, their latest conversation title, state and last activity.

## 3. `ask_user` for every provider
- A bridge tool `ask_user { questions: [{ id, header?, question, options?: [{ label, description? }], multiSelect?: boolean, allowOther?: boolean }] }` available to **every** bot (not only OpenCode), non-blocking, using the existing question permission (`kind: "question"`) and its expiry setting `questions.expirySecs`. The answer comes back as a user message into the same conversation (as today for OpenCode). Remove the OpenCode-only gate.
- Up to 6 questions per call, 10 options each; validation errors are tool errors.

## Tests (fake adapters, temp folders)
- Each propose_* creates a pending proposal and a permission request; nothing is created before approval.
- Approve with edits creates the edited project/bot; reject creates nothing; both post a note to the Manager's conversation and emit events.
- `mode:"new"` folder: approve without a path → `invalid_argument`; with a path creates the directory under it.
- assign_task approve → a side conversation exactly like message_blob; reject → none.
- Non-manager bots can't call propose_* / assign_task.
- ask_user available to Claude/Codex/OpenCode sessions; the question shows as `kind:"question"`; answering posts the answer.
- Proposal expiry after 24 h (injectable clock).

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote src/preview` (add `PermissionRequest.proposal` to `apps/desktop/src/types.ts` and a fixture proposal to `apps/desktop/src/preview/fixtureBridge.ts`)

## Report
`docs/history/fix-36/d2-report.md`.
