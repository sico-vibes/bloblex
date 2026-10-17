# FIX36 D1: the Manager — a permanent, global bot that replaces the team leader

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree, private `CARGO_TARGET_DIR`. **Do not run `git commit`.** Read `AGENTS.md` first. Keep your context small: grep and read only the ranges you need (`main.rs`, `team.rs`, storage `lib.rs` are large); pipe long output through `tail`/`grep`. Do not edit `apps/desktop/src/ui/**` (the Director builds the UI), but do update the non-visual TS listed below.

## Owner decisions
- A **new built-in Manager** is created for every user; any existing `leader = 1` agent becomes an ordinary bot.
- The Manager needs the owner's approval for every consequential action (D2 builds the proposals; D1 only moves the tools and rules).

## Today (from the Director's exploration)
- `agents.leader INTEGER` (`crates/bloblex-storage/src/lib.rs` `ensure_team_schema` ~399-421), one-leader rule only in `agent_set_team` (~1572), `leader_agent()` (~1582).
- Leader-gated MCP tools in `crates/bloblex-daemon/src/team.rs` `tools()` (~200-228): `list_projects`, `create_blob`, `update_blob`; `is_leader` (~256). `<bloblex_team>` leader paragraph in `runtime_instructions` (~152-159).
- `agent.delete` (`main.rs` ~716) archives with no leader check; import (`lib.rs` ~4156-4212) can carry the flag.

## Changes
1. **Schema (additive, `ensure_*`, no `user_version` bump).** `agents.system_role TEXT NULL` with a partial unique index `WHERE system_role = 'manager'`. A one-time marker migration (`migration.managerIntroduced` setting) sets `leader = 0` on every agent. Keep the `leader` column for compatibility; nothing reads it for permissions any more.
2. **`manager.ensure { name?, look?, runtimeId, model?, thinking? }`**: returns the existing Manager or creates one through the normal agent-create path with `system_role = 'manager'`, `project_id = NULL`, default name "Manager", role "Manager", description "Runs your team: knows every project and bot, plans the work and asks before it acts.", approval mode `ask`, default instructions = a short manager persona (keep under 1200 chars). Emits `agent.changed`. `manager.get` returns it or null.
3. **Rules.**
   - The Manager's `project_id` is always NULL: `agent.team.update` / `agent_set_team` with a project for the Manager → `conflict` ("The Manager works across every project").
   - The Manager cannot be archived or deleted (`agent.delete` → `conflict` "The Manager can't be removed; you can rename it or change its model"), cannot be demoted, and import never creates a second Manager (an imported manager row becomes an ordinary bot; backup import keeps the local Manager).
   - Its name, look, instructions, runtime, model and thinking can change through the normal update path.
4. **Tools.** Replace `is_leader` with `is_manager` (session's agent has `system_role = 'manager'`). `list_projects` and `update_blob` move to manager-only; `create_blob` is **removed from the bridge** (D2 replaces it with `propose_bot`). Non-managers asking for these get the existing friendly error reworded to "Ask the Manager (@<name>)".
5. **`<bloblex_team>` text.** The leader paragraph becomes a Manager paragraph: "You are <name>, the user's Manager. You work across all projects (list them with list_projects), know every bot (list_blobs), plan work, delegate with message_blob, and you ask the user before creating projects, bots or assigning tasks." Non-manager bots are told the Manager's name and to tag `@<name>` for new teammates or projects. This changes the instruction hash once (expected).
6. **DTOs / non-visual TS.** `Agent` DTO gains `systemRole: "manager" | null`; add `systemRole?: 'manager' | null` to `apps/desktop/src/types.ts` `Agent`. Add `manager.ensure` and `manager.get` to `apps/desktop/src/remote/tiers.json` (`manager.get` read/viewer; `manager.ensure` never) and to `apps/desktop/src/preview/fixtureBridge.ts` (a fixture Manager).
7. **Snapshot.** `app.snapshot` includes the Manager like any agent (with `systemRole`).

## Tests
- Migration demotes all leaders once; marker prevents re-running.
- `manager.ensure` creates exactly one; second call returns the same; partial unique index rejects a second manager row.
- Manager can't be archived/deleted/given a project/demoted; can be renamed and change model.
- Tools: manager sees `list_projects`, `update_blob`, not `create_blob`; a normal bot sees neither; the error text names the Manager.
- `<bloblex_team>` text for manager vs bot (snapshot-style assertions on key sentences).
- Backup/import: an incoming manager row becomes an ordinary bot; the local Manager stays.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote src/preview`

## Report
`docs/FIX36_D1_REPORT.md`: shapes, rules, migration, tests, gates, unverified.
