# FIX31 (WP5): back up and restore bots, memory, skills, automations and settings

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree, private `CARGO_TARGET_DIR`. Director reviews, runs the gates on the merged result and commits. **Do not run `git commit`.** Read `AGENTS.md` first.

Read before coding: `crates/bloblex-daemon/src/main.rs` (`settings.set` validation ~1044-1090, `agent_create_from_rpc`, dispatch), `crates/bloblex-daemon/src/skills.rs` (WP4, merged), `crates/bloblex-daemon/src/memory.rs` (`contains_secret_marker`), `crates/bloblex-daemon/src/automations.rs`, `crates/bloblex-storage/src/lib.rs` (agents, memory_records, automations, settings, skills tables; `verified_backup`), `apps/desktop/src-tauri/src/lib.rs` (`select_blob_export_path` / `select_blob_import_path` / `read_blob_import` and the single-use selection-token pattern ~729, `SelectedFilePurpose`), `apps/desktop/src/remote/remoteTiers.ts`.

## Owner decisions
- A backup holds **bots, memory, skills, automations and app settings**. **No projects** (restored bots land in Unassigned). **No conversations** (not yet).
- Sign-ins, tokens and cloud-dictation consent are never included.

## 1. Format: one `.bitbots-backup.json` file
```json
{ "format": "bitbots.backup", "version": 1, "createdAt": "...", "app": { "version": "..." },
  "contents": { "bots": [...], "memory": [...], "skills": [...], "automations": [...], "settings": { } },
  "checksum": { "alg": "sha256", "value": "<hex of sha256(serde_json::to_vec(&contents))>" } }
```
`serde_json` maps are sorted in this build (no `preserve_order`), so `to_vec(&contents)` is canonical; assert that in a test.

### Bots
Every field of the agent read **except**: `id` (exported as `exportId`), `runtimeId` (exported as `provider` plus `runtimeHint`), `projectId` / `defaultProject` (owner: no projects), `customArgs` (always empty), `sortOrder`, `archived` (archived bots are left out). `customEnv` **values are removed**: export only `customEnvKeys` so the preview can warn. Keep look, role, description, instructions, model, thinking, serviceTier, approvalMode, notificationLevel, leader, hidden, color.

### Memory
All scopes, `deleted_at IS NULL`. Bot-scope `scope_id` becomes the bot's `exportId`. Project-scope notes export `projectName`; on import they attach to a local project with the same id or name, else they are skipped and counted. Bodies with secret markers (`contains_secret_marker`) are skipped on export **and** import.

### Skills
`{ name, description, files: [{ path, sha256, base64 }] }` from the pool. Caps: 5 MB per file, 50 MB in total (refuse the export with a clear error past that).

### Automations
`agent_id` becomes `exportId`. Restored with `enabled = 0`, `pause_reason = 'restored'`, `next_run_at = NULL`, `reuse_session_id = NULL`, `created_by = 'user'`.

### Settings (allowlist only)
`appearance.style`, `appearance.accent`, `appearance.density`, `appearance.theme`, `appearance.textSize`, `companion.focusMode`, `companion.soundsEnabled`, `companion.soundVolume`, `companion.openAtStartup`, `companion.hotkey`, `companion.chatSize`, `companion.startPosition`, `companion.pinnedBlobs`, `notifications.enabled`, `permissions.default_mode`, `profile.name`, `profile.about`, `speech.enabled`, `speech.engine`, `speech.model`, `experimental.*` boolean flags that exist, `memory.sharedAgentWrites`, `retry.maxWaitSecs`, `questions.expirySecs`, `automations.maxConcurrent`, `claude.enableWorkflows`, `conversations.autoTitle`, `skills.enabled`. Only keys present in the source are exported.
**Never**: `exec_gate.*`, `internal.*`, `migration.*`, `remote.*`, `speech.cloud.consent*`, `companion.positions`, or any key containing `token`, `secret`, `password`, `auth`, `cookie`, `key` (case-insensitive; `hotkey` is allowed by name above).

## 2. RPCs (new module `crates/bloblex-daemon/src/backup.rs`)
- Refactor the `settings.set` validation into `fn validate_setting(key, &Value) -> Result<Value, DispatchError>` and use it from `settings.set` and from import.
- `backup.export { include?: { memory?, skills?, automations?, settings? } }` → `{ document, stats: { bots, memory, skills, automations, settings } }`. Bots are always included.
- `backup.preview { document }` → validates `format`, `version <= 1` (higher → `unsupported`), checksum (mismatch → `invalid_argument` "The backup file is damaged or was edited."). Maps each bot's `provider` to the first usable installed runtime of that provider. Stores the parsed document in `st.backup_previews` (at most 2, 10 minute TTL). Returns `{ previewId, counts, conflicts: { bots: [{ exportId, name, existingAgentId }], skills: [{ name, same }], memory: [{ id, identical }], settings: [{ key, current, incoming }] }, warnings: [...] }`. Warnings: a second leader (the incoming one loses leader), `bypass` approval restored as `ask`, no runtime for a provider (that bot is skipped), project notes skipped, environment keys dropped.
- `backup.import { previewId, resolutions: { bots: { [exportId]: 'rename' | 'replace' | 'skip' }, skills: { [name]: 'replace' | 'skip' }, default: 'rename' | 'skip' } }` → `{ imported: { bots, memory, skills, automations, settings }, skipped: {...}, renamed: [{ from, to }] }`.
  - One database transaction for bots, memory, automations and settings. Bots go through the same insert path as `agent.create` (`name_key` uniqueness; rename adds " (2)", " (3)"…). Replace updates the existing bot's fields in place and keeps its id, conversations and memory. Restored bots have `projectId = null`.
  - Skills are staged under `<data>/skills/.staging-<uuid>` and moved into place only after the transaction commits; staging is removed on failure.
  - Emit `agent.changed`, `settings.changed`, `skills.changed`, `automation.changed` (use the existing event names) and a new `backup.imported` with the counts.
- Remote tiers: all three `never`. Add the event `backup.imported` as `drop`.

## 3. Native file handling (`apps/desktop/src-tauri/src/lib.rs`)
- Add `SelectedFilePurpose::{BackupExport, BackupImport}` so a token chosen for one purpose cannot be used for another (add a test like `import_selection_cannot_be_used_as_an_export_path`).
- `select_backup_export_path` (save dialog, default name `bitbots-backup-YYYY-MM-DD.bitbots-backup.json`) and `select_backup_import_path` (open dialog filtered to `.json`).
- `backup_export_write(selection_token, include)`: calls `backup.export` on the daemon and writes the document via a temp file plus rename. Returns `{ path, stats }`.
- `backup_import_preview(selection_token)`: reads the file (cap 64 MB, UTF-8, JSON parse) and calls `backup.preview`; returns the preview. The file contents never pass through the renderer.
- Typed wrappers in `apps/desktop/src/tauri.ts`: `selectBackupExportPath`, `selectBackupImportPath`, `writeBackupExport(token, include)`, `previewBackupImport(token)`, and `rpc('backup.import', ...)` is called directly.

## Tests
- Round trip: export from one database, import into a fresh one: counts match; look, role, instructions and approval mode survive; `customEnv` is empty; automations are paused; bot memory is re-mapped to the new bot ids; skills files are byte-identical.
- Checksum tamper → refused. `version: 2` → `unsupported`.
- Rename / replace / skip for a name conflict; leader uniqueness kept.
- A settings key outside the allowlist is ignored; an invalid value for an allowed key is rejected by `validate_setting` and reported in `skipped`.
- Secret-marker memory skipped both ways.
- A provider with no installed runtime → that bot skipped with a warning.
- Preview TTL expiry → `not_found` on import.
- Size caps for skills.
- The native token-purpose test.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cargo test -p bloblex-desktop --lib` (if it cannot build in the worktree because the gitignored sidecar binary is missing, say so; the Director runs it on the merged result)
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote`

## Report
`docs/FIX31_BACKUP_REPORT.md`: changes, RPC shapes as implemented, the exact allowlist, tests, gate summaries, verified versus not verified.
