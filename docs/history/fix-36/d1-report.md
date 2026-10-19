# FIX36 D1 — the Manager (lane report)

> **What this is:** Lane report for FIX36 D1: the Manager.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, worktree `C:\fx55`,
private `CARGO_TARGET_DIR=C:\fxt\d1`. No `git commit` was run. `apps/desktop/src/ui/**`
was not touched.

Spec: [docs/history/fix-36/d1-manager-spec.md](d1-manager-spec.md).

## What changed

### Storage (`crates/bloblex-storage/src/lib.rs`)

- **Schema (additive, no `user_version` bump).** `ensure_team_schema` adds
  `agents.system_role TEXT` (idempotent column add) and a partial unique index
  `idx_agents_manager ON agents(system_role) WHERE system_role='manager'`, then runs
  the one-time migration.
- **One-time marker migration** `ensure_manager_introduced` (`migration.managerIntroduced`
  setting): with no marker it runs `UPDATE agents SET leader=0 WHERE leader<>0`, then
  writes the marker. It never runs twice, so a later operator choice survives. The
  `leader` column stays and `agent_set_team`/`leader_agent()` keep the old one-leader
  behaviour for compatibility; nothing reads `leader` for permissions any more.
- **DTOs.** `agent_read`, `agent_list` and the snapshot's `agent_rows_locked` all
  expose `systemRole` (SQL null → JSON null).
- **`insert_agent`** now writes `role` and `system_role` (`system_role` only ever
  `'manager'`, forced from a `systemRole == "manager"` input; anything else → NULL).
- **`validate_agent_fields`** accepts `role` (≤ 40 trimmed chars) and `systemRole`
  (only `"manager"` or null).
- **`agent_create`** refuses to create a second Manager (`SELECT EXISTS(... system_role='manager')`
  inside the `IMMEDIATE` transaction → `AgentConflict`), so two concurrent
  `manager.ensure` calls cannot both succeed, before the index is even reached.
- **`agent_set_team`** on the Manager: a non-null `projectId` → `AgentConflict`;
  any `leader` field (i.e. a demotion attempt) → `AgentConflict`. `role`, `hidden`,
  `sortOrder` still apply.
- **`agent_archive`** on the Manager → `AgentConflict`.
- **`manager_agent()`** returns the Manager (archived or not) or `None`, mirroring
  `leader_agent()`.
- **`backup_import`** strips `systemRole` from an incoming bot before insert (an
  imported manager row becomes an ordinary bot) and never touches the local Manager's
  `system_role` on a replace, so the local Manager stays the Manager.

### Daemon (`crates/bloblex-daemon/src/main.rs`, `team.rs`)

- **`manager.get`** → `{"manager": <agent>|null}`; **`manager.ensure { name?, look?, runtimeId, model?, thinking? }`**
  → `{"manager": <agent>, "created": true|false}`. `ensure` returns the existing
  Manager unchanged; otherwise it creates one through `agent_create_from_rpc` (the
  same path as `agent.create`, so catalog validation applies) with default name
  `"Manager"`, role `"Manager"`, `projectId` NULL, `approvalMode` forced to `ask`,
  default description from the spec and a 640-character manager persona, and
  `systemRole: "manager"`. It emits `agent.changed` (created) through the normal
  `agent_create` path. A caller-supplied `role`/`systemRole`/`agentId` is ignored.
- **`agent.delete`** refuses the Manager with `conflict` —
  `"The Manager can't be removed; you can rename it or change its model"`.
- **`agent.team.update`** refuses a project for the Manager with
  `"The Manager works across every project"` and any `leader` change with
  `"The Manager can't be removed; you can rename it or change its model"`.
- **Tools.** `is_leader` → `is_manager` (session's agent has `systemRole == "manager"`).
  `list_projects` and `update_blob` are manager-only; `create_blob` is **removed from
  the bridge** (its function, its tool schema, its per-turn creation counter and the
  `bloblex_create_blob` entries in the safe-tool allowlist are gone). A non-manager
  calling either remaining tool gets
  `"Only the Manager can list projects or change bots. Ask the Manager (@<name>)."`
  (`"…no Manager yet. Ask the user to set one up."` when there is none).
- **`<bloblex_team>`.** The leader paragraph became the Manager paragraph:
  `"You are <name>, the user's Manager. You work across all projects (list them with
  `list_projects`), know every bot (`list_blobs`), plan work, delegate with
  `message_blob`, and you ask the user before creating projects, bots or assigning
  tasks."` An ordinary bot is told it cannot create projects or bots, that the Manager
  does, and to tag `@<Manager>` (by real name) — or to tell the user to set up a
  Manager when none exists. `list_blobs` now marks the Manager `[manager]` instead of
  `[leader]`. This changes the instruction hash once, as the spec expects.

### Non-visual TypeScript

- `apps/desktop/src/types.ts`: `Agent.systemRole?: 'manager' | null`.
- `apps/desktop/src/remote/tiers.json`: `manager.get` (`read`/`viewer`),
  `manager.ensure` (`never`).
- `apps/desktop/src/preview/fixtureBridge.ts`: a fixture Manager
  (`agent-manager`, `systemRole: 'manager'`, `projectId: null`, `approvalMode: ask`),
  plus `manager.get` / `manager.ensure` handlers and the same Manager guards in
  `agent.delete` / `agent.team.update` so the preview matches the daemon.

## Tests

Storage (`crates/bloblex-storage/src/lib.rs`, `memory_tests` module):

- `manager_migration_demotes_every_leader_once_and_is_marked` — an open stamps the
  marker; with the marker cleared and a `leader=1` row, `ensure_team_schema` clears
  the flag and re-writes the marker; a later `leader=1` survives a re-run.
- `manager_ensure_is_singular_and_the_unique_index_holds` — one Manager row, role and
  `projectId` NULL, present in `agent_list` and `snapshot`, a second create →
  `AgentConflict`, and a raw second `system_role='manager'` insert fails on the partial
  unique index.
- `the_manager_cannot_be_removed_given_a_project_or_demoted` — project → conflict,
  `leader` → conflict, archive → conflict; a null project/role/hidden still apply;
  rename/model/instructions change and the row stays the Manager; an ordinary bot
  still archives.
- `backup_import_never_creates_a_second_manager` — an imported row with
  `systemRole: "manager"` lands as an ordinary bot; a replace that names the local
  Manager leaves it the Manager.

Daemon (`crates/bloblex-daemon/src/main.rs`, `phase2a_tests`):

- `manager_ensure_is_idempotent_and_manager_get_reports_it` — `manager.get` is null
  first, `ensure` creates one (`created: true`, name/role/description/`ask`/`systemRole`,
  `projectId` null, persona < 1200 chars), a second `ensure` returns the same bot
  (`created: false`) and leaves exactly one bot.
- `manager_delegates_to_a_teammate_and_is_woken_by_the_relayed_reply` — the Manager's
  conversation carries the Manager paragraph and the Manager roster tag, and the
  round trip still works.
- `manager_lists_projects_and_updates_blobs_while_ordinary_bots_are_refused` — an
  ordinary bot is offered neither `list_projects` nor `update_blob` and is refused with
  the Manager-named error (and `create_blob` is simply an unknown tool); the Manager
  sees both tools and not `create_blob`; `list_projects` and `update_blob` work; the
  Manager cannot be deleted, given a project or demoted, but can be renamed.
- `runtime_instructions_name_the_manager_and_reserve_projects_for_it` — no-Manager
  fallback text, the Manager paragraph, and the `@<name>` tag for another bot.
- The existing `team_prose_always_says_bot` now checks the `update_blob` description.

TypeScript: `npx tsc -b` and `npx vitest run src/remote src/preview` (the tier-parity
test in `src/remote` fails the build if a dispatch method has no `tiers.json` row).

## Follow-up fix: old-version databases must re-run the v9 rebuild (Director's failing tests)

The Director's full workspace run had four `bloblex-storage` tests failing, all with the
same panic: `no such column: system_role` in
`CREATE UNIQUE INDEX idx_agents_manager ON agents(system_role) WHERE system_role='manager'`.

- `pricing_override_removal_tests::v7_integer_minor_rate_overrides_migrate_losslessly_to_decimal_strings`
- `tests::outfit_migration_from_six_backs_up_and_defaults_existing_records`
- `tests::migration_3_to_4_preserves_rows_seeds_default_and_is_idempotent`
- `tests::migration_2_to_3_seeds_gates_preserves_operator_values_and_reopens_without_backup_or_sidecars`

**Root cause — index replay, not query order.** Each test builds a current database, then
drops its version marker to an old number and reopens it, so the whole migration chain
runs again. One step of that chain, `migrate_agent_outfit_ids` (v8→v9), rebuilds the
`agents` table into the fixed v9 shape (copy → `DROP TABLE agents` → rename) and then
**replays every index it found in `sqlite_master`** for that table. On a database that had
already carried D1's `idx_agents_manager`, that captured DDL was replayed against the v9
table, which has no `system_role` column: `DROP TABLE` had dropped the index, and the
rebuild tried to recreate it before `ensure_team_schema` had re-added the column. This was
not an `agents` query selecting `system_role` before the column existed, and not the
marker migration: no read path is reached here.

**Fix** (`crates/bloblex-storage/src/lib.rs`, `migrate_agent_outfit_ids`): the columns of
each index are captured with `pragma_index_info` while the old table still exists, and
after the rebuild an index is replayed only when every one of its columns survived into
the v9 table. `idx_agents_manager` sits on `system_role`, which the v9 rebuild does not
create, so it is skipped here and recreated by `ensure_team_schema` with `IF NOT EXISTS`
once the column exists, later in the same `open` — the manager therefore keeps exactly the
same single-Manager guarantee. The v9 indexes on retained columns are replayed unchanged.
This is a column-set guard rather than a hard-coded index name, so a future additive index
is handled the same way without touching the v9 migration again. No migration guard,
version marker or reader was changed, and nothing else was reordered: the column and index
are still created before any query uses them, and the marker migration still runs after the
`agents` columns exist. (Earlier in this lane the same failure was filtered with
`... AND name <> 'idx_agents_manager'`; it is now the general column check above.)

Verified: `cargo test -p bloblex-storage` — **98 passed, 0 failed**, including the four
tests above and the D1 manager tests (the partial unique index is still enforced).

## Gates

Run in this worktree with `CARGO_TARGET_DIR=C:\fxt\d1`:

- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — **clean** (exit 0).
- `cd apps/desktop && npx tsc -b` — **clean** (exit 0).
- `cd apps/desktop && npx vitest run src/remote src/preview` — **13 files, 207 tests passed**.
  (One earlier full-suite run failed `RemoteApp.mounted.test.tsx > pairs: …` on a
  timing flush while `remoteBuild.test.ts` was loading the machine; it passes alone
  with and without these changes and passes on re-run. It is a flaky timing test, not
  caused by D1.)
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — **all suites ok, 0 failed** (677 tests passed across the workspace; no `FAILED`,
  no `panicked`, no build errors). Re-run after the follow-up fix above, so this covers
  the four tests the Director's run failed.
- Both gates were re-run on the fixed tree and waited for completion:
  `cargo test -p bloblex-storage` (98 passed) and the full workspace command above
  (`test result: ok` from every binary), then the clippy command — **clean (exit 0)**.

## Unverified / notes

- **UI is not touched**: nothing calls `manager.ensure` yet (the Director's UI does),
  so the Manager is only created when that call is made.
- **Name clash**: `manager.ensure` defaults to the name `"Manager"`; if an ordinary bot
  already uses that name, the create fails with `conflict` (the caller can pass `name`).
- **`leader` is vestigial.** The column, `leader_agent()`, the one-leader rule in
  `agent_set_team` and backup's leader export/import all still work, so existing tests
  and old backups are unchanged; nothing reads it for permissions.
- **`create_blob` coverage moved to D2.** The team cap (12), duplicate names, provider
  and project resolution checks that lived in `create_blob` now belong to D2's
  `propose_bot`; D1 deletes them with the tool.
- **`agent.create` still accepts `systemRole: "manager"`** (local, capability-gated):
  `manager.ensure` uses the same create path. It cannot create a second Manager.
- **Remote**: a device can `manager.get` but never `manager.ensure`; the Manager has no
  new permissions on the remote surface.
- **Interpretation of "cannot be demoted"**: implemented as rejecting any `leader`
  change on the Manager (the only demotion-shaped mutation in the schema) and as
  `systemRole` never being updatable.
