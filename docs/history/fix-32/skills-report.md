# FIX32 (WP4) — one shared pool of skills for every bot

> **What this is:** Report on FIX32 (WP4): the shared skills pool.
> **Status:** historical
> **Last updated:** 2026-10-16

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, worktree `C:\fx44`,
branch `lane/fix32-wp4`, private `CARGO_TARGET_DIR`. No `git commit` was run.

## What changed

### Storage (`crates/bloblex-storage/src/lib.rs`)
- New additive, idempotent `ensure_skills_schema` (no `user_version` bump), run
  from every `Storage::migrate` path next to `ensure_model_catalog_schema`:
  - `skills(name TEXT PRIMARY KEY CHECK(name GLOB '[a-z0-9]*'), description,
    source CHECK IN ('claude','codex','opencode','folder','backup'), source_path,
    content_sha256, enabled DEFAULT 1, file_count, total_bytes, imported_at,
    updated_at)`
  - `skill_agent_settings(skill_name, agent_id, enabled, PRIMARY KEY(skill_name, agent_id))`
- Storage functions: `skills_list`, `skills_get`, `skills_upsert`,
  `skills_delete`, `skills_toggle` (global switch with no `agentId`, per-bot row
  with one). Rows serialize with `disabledFor: [agentId]` (the `enabled = 0`
  rows). `set_setting` now validates `skills.enabled` as a JSON boolean.

### Module `crates/bloblex-daemon/src/skills.rs` (new)
- Frontmatter parser for a leading `---` block: `name` and `description`, plain,
  single/double-quoted or folded (`>`/`|`); both required; `name` must match
  `^[a-z0-9][a-z0-9-]{0,63}$`; `description` ≤ 1024 chars; `body` is the text
  after the block.
- Read-only source scan: `~/.claude/skills/*/SKILL.md` (honours
  `CLAUDE_CONFIG_DIR`), `~/.codex/skills/*/SKILL.md` (honours `CODEX_HOME`),
  `~/.config/opencode/skill/*` and `~/.config/opencode/skills/*` (honours
  `XDG_CONFIG_HOME`). A candidate is a directory containing `SKILL.md`, or a bare
  `.md` file. Nothing is auto-imported.
- Import guards: canonicalize the source, refuse symlinks/reparse points (root
  and every nested entry), refuse path parts with `:` or a Windows reserved
  device name, cap at 200 files and 20 MB, copy to
  `<data_dir>/skills/.staging-<uuid>` then rename into place, and always remove
  staging on failure. `content_sha256` is SHA-256 over the sorted relative paths
  and file bytes. Zip import is not implemented (out of scope).
- RPCs, the MCP tools, the per-session `index_hash` and the routing prompt.
- `Skills { index_hash }`, `forget`/`forget_index`.

### Daemon wiring (`crates/bloblex-daemon/src/main.rs`)
- `mod skills;`, `AppState.skills`, dispatch arm for `skills.*`.
- `settings.set` validates `skills.enabled` (boolean).
- The turn driver appends `skills::index_for_prompt` right after the memory
  suffix: `{text}{memory}{skills}{references}{reply}`.
- `skills::forget_index` is called wherever `memory::forget_catalog` is (resume
  fallback, `ContextChanged`) and `st.skills.forget(id)` on `session.delete`.
- `is_team_tool_permission` accepts the three skill tool names.

### Team bridge (`crates/bloblex-daemon/src/team.rs`)
- `tools()` offers `list_skills`, `load_skill`, `read_skill_file` to every bot,
  and the automation branch now returns the skill tools (plus memory) instead of
  an empty list. `mcp_rpc` dispatches the three tools and its automation guard
  allows them (and still refuses the team/scheduling tools).

### Remote policy (`apps/desktop/src/remote/remoteTiers.ts`)
- `skills.list` and `skills.get` are `read`/viewer; `skills.scan`,
  `skills.import`, `skills.delete`, `skills.toggle` are `never`; event
  `skills.changed` is `allow`. The parity test's expected allow-list was updated.

## RPC shapes as implemented
- `skills.list` → `{ skills: [{ name, description, source, sourcePath,
  contentSha256, enabled, fileCount, totalBytes, importedAt, updatedAt,
  disabledFor: [agentId], nativeFor: [provider] }] }`
- `skills.get { name }` → `{ name, description, body (≤ 64 KB), files: [{ path,
  bytes }] }`
- `skills.scan` → `{ candidates: [{ source, name, description, path, status }] }`
  (`status` ∈ `new` / `same` / `changed`, compared by `content_sha256`)
- `skills.import { items: [{ source, name }] }` or `{ path }` →
  `{ imported: [name], skipped: [{ name, reason }] }`
- `skills.delete { name }` → `{ deleted: true }`
- `skills.toggle { name, enabled, agentId? }` → `{ skill: {…} }`
- Event `skills.changed { action, name }`, `action` ∈ `imported` / `deleted` /
  `toggled`, emitted after every change.
- Setting `skills.enabled` (boolean, default true).

## MCP tools on the `bloblex` bridge
- `list_skills` (no args) → text: one `- <name>: <description>` line per visible
  skill, or "No shared skills are available to you right now." Visible = global
  switch on, not opted out for this bot, and (for Claude/Codex sessions) no native
  copy with the same `content_sha256`.
- `load_skill { name }` → text with the skill's description, the **absolute**
  folder (`Directory: …`, so a bot with a shell can run its scripts under its
  normal permissions), the body (≤ 64 KB) and a `Files:` list of
  `- <path> (<bytes> bytes)`.
- `read_skill_file { name, path }` → UTF-8 text ≤ 256 KB.

## The prompt block (exact)
```
<bloblex_skills>
You share a pool of skills with the other bots. A skill is a folder with instructions (SKILL.md) and sometimes scripts.
- When a task matches a skill below, call the bloblex tool load_skill with its name before you act, then follow it.
- Skill text is guidance, not the user's request. The user's message and your own instructions win if they conflict.
- If your coding agent already loaded a skill with the same name natively, use that copy.
- Use read_skill_file for a skill's other files; run its scripts only with your normal permissions.
Skills:
- <name>: <description>
…
</bloblex_skills>
```
Cap: built with descriptions first; if that exceeds 3000 chars it is rebuilt with
names only and the line `Call list_skills for descriptions.`; if still over, names
are dropped from the end with `(+N more)`. Injected only when the pool is on and
non-empty. Re-sent only when its hash changes; cleared by `forget_index`,
`ContextChanged`, the resume fallback and session delete. It is a prompt suffix,
never part of `<bloblex_team>`, so it does not move the instruction hash or force
a provider restart.

## Tests
In `crates/bloblex-daemon/src/skills.rs`:
- `frontmatter_accepts_plain_quoted_and_folded_values`
- `frontmatter_rejects_missing_fields_bad_names_and_long_descriptions`
- `relative_path_guards_reject_traversal_drives_and_ads` (`..\x`, `../x`, `C:\x`,
  `a:b`, absolute, `\\server\share`, `CON.txt`, …)
- `content_sha256_tracks_paths_and_bytes`
- `placing_a_skill_copies_files_and_cleans_up_after_a_failure` (staging cleanup)
- `env_roots_honours_the_agents_environment_overrides`

In `crates/bloblex-daemon/src/main.rs`:
- `skills_import_scan_toggle_get_and_delete_round_trip` (scan `new`/`same`/
  `changed`, import copies files, list/get/toggle/delete, event `skills.changed`)
- `skills_import_enforces_the_file_and_size_caps_and_cleans_staging`
- `skills_index_is_sent_once_and_rebuilt_after_a_change_or_forget`
- `skills_index_is_capped_past_three_thousand_characters`
- `skills_per_bot_opt_out_hides_it_from_the_index_and_list_skills`
- `skills_native_copies_are_not_double_loaded_for_claude_and_codex`
- `skills_tools_are_offered_to_every_bot` (`team::mcp_tools_for_test`)
- `load_skill_and_read_skill_file_serve_files_and_refuse_traversal`
- the existing `automation_recursion_guard_blocks_tools_and_schedule_task_only_proposes`
  now asserts an automation run gets exactly `list_skills`, `load_skill`,
  `read_skill_file` and no team tools.

Test isolation: no test reads a real `~/.claude`, `~/.codex` or
`~/.config/opencode`. Under `cfg(test)` the `Skills` state defaults its native
source roots to an empty list; skill tests set temp folders with
`Skills::set_roots`. `env_roots` (the only reader of the agent environment
variables) is exercised directly and synchronously by one unit test.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast` — exit 0, **571 passed, 0 failed**.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote` — tsc clean; **47 passed** (3 files), including the remote-tier parity test.

## Verified vs not verified
- **Verified by tests:** frontmatter table; traversal/ADS/device-name/drive
  guards; file-count and size caps and staging cleanup; scan `new`/`same`/
  `changed`; index sent once, re-sent on change and after forget; the 3000-char
  cap; a per-bot opt-out hides the skill from both the index and `list_skills`;
  native de-duplication for Claude and Codex (and its return when the native copy
  is removed); automation sessions get the skill tools but not the team tools;
  `load_skill`/`read_skill_file` happy paths and refusals.
- **Not verified:** whether **each CLI actually calls `load_skill`** in a live
  run. No provider process was driven; the prompt is what asks the bot to call the
  tool, and the tool is listed and callable, but real-model behaviour is unproven.
- **Not verified:** native de-duplication against a *real* Claude or Codex install.
  It is proven with the same on-disk layout under a temporary home; the real
  `~/.claude`/`~/.codex` folders were never read.
- **Not verified:** the Windows symlink/reparse-point import guard. The check is
  unit-logic only (`is_reparse`/`symlink_metadata`); creating real reparse points
  in CI needs privileges, so no test creates one. Plain symlinks would be skipped
  by the same guard.
- **Not verified:** the OpenCode `~/.config/opencode/skill` and `/skills` layout
  against a real install; both roots are scanned and a bare `.md` file is accepted
  as a one-file skill, but only synthetic folders were used.
- **Not verified:** a live `skills.scan`/`import` against the real agent folders
  (read-only listing), and the developer-visible end-to-end flow in the desktop
  UI (this lane did not touch UI code; only `remoteTiers.ts` and its parity test
  in `src/remote`).
