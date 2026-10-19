# FIX31 (WP5) — back up and restore bots, memory, skills, automations and settings

> **What this is:** Report on FIX31 (WP5): backup and restore.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, worktree `C:\fx45`,
branch `lane/fix31-wp5`, private `CARGO_TARGET_DIR` (`C:\fxtarget`) and
`RUST_MIN_STACK` kept. No `git commit` was run; nothing was pushed. `AGENTS.md`
was not touched. No UI component or CSS was touched; the only desktop files
changed are `apps/desktop/src-tauri/src/lib.rs` (typed native wrappers + tests)
and `apps/desktop/src/tauri.ts` (typed wrappers), plus `remoteTiers.ts` and its
parity-table entry.

## What changed

### New module `crates/bloblex-daemon/src/backup.rs`
- The document envelope (`format`/`version`/`createdAt`/`app`/`contents`/
  `checksum`) and the SHA-256 checksum over `serde_json::to_vec(&contents)`.
- `BackupPreviews`: the parsed-document store behind `backup.preview` (at most
  2 entries, 10-minute TTL, oldest evicted first, single-use on import).
- Export: bots (secret-free projection), live memory, installed skills as
  base64, automations and the allowlisted settings.
- Preview: envelope/checksum validation, provider → local-runtime mapping,
  conflict detection (bots by name, skills by name/content, memory by id/content,
  settings by changed value) and the warnings list.
- Import: resolution of bots/memory/automations/settings into one storage
  transaction, disk staging for skills, event emission and the returned counts.
- Unit tests for canonical serialisation, the allowlist, damaged/newer
  documents and preview eviction/TTL.

### `crates/bloblex-daemon/src/main.rs`
- `mod backup;`, `AppState.backup_previews`, dispatch arm
  `"backup.export" | "backup.preview" | "backup.import" => backup::rpc(...)`.
- Extracted `settings.set`'s validation into
  `fn validate_setting(key: &str, value: &Value) -> Result<Value, DispatchError>`,
  now used by `settings.set` and by backup import. Behaviour is unchanged
  (accent lower-casing and `profile.about` trimming included).
- 15 integration tests (below).

### `crates/bloblex-daemon/src/skills.rs`
- `pub(crate)` helpers for backups: `read_files`, `files_sha256`,
  `stage_files`, `commit_staged`, `discard_staged`, and `safe_relative` is now
  `pub(crate)`. The staging layout and cleanup match the existing importer.

### `crates/bloblex-storage/src/lib.rs`
- `set_setting` split into `validate_setting_value` + `write_setting(tx, …)` so
  an import can write settings inside its own transaction with the same
  validation and `settings.changed` events.
- `memory_all_live()` for the export (all non-deleted rows, not the review
  page).
- `backup_import(plan)`: one `IMMEDIATE` transaction that creates/updates bots,
  inserts memory, inserts paused automations and writes settings. Helpers
  `unique_agent_name` (name_key uniqueness, " (2)", " (3)"… up to 60 chars) and
  `memory_identical` (idempotent re-import).

### `crates/bloblex-daemon/Cargo.toml` + `Cargo.lock`
- Added `base64.workspace = true` (already in the workspace via
  `bloblex-speech`; the lockfile only gains `base64 0.22.1` in the daemon's
  dependency list).

### `apps/desktop/src-tauri/src/lib.rs`
- `SelectedFilePurpose::{BackupExport, BackupImport}` — a token chosen for one
  purpose cannot be spent for another.
- `select_backup_export_path` (save dialog, default
  `bitbots-backup-YYYY-MM-DD.bitbots-backup.json`, `.json` filter),
  `select_backup_import_path` (open dialog, `.json` filter),
  `backup_export_write(token, include)` (daemon `backup.export`, then a sibling
  temp file and rename; returns `{ path, stats }`) and
  `backup_import_preview(token)` (cap 64 MB, UTF-8, JSON parse, daemon
  `backup.preview`; the file text never reaches the renderer). All four are
  registered in `invoke_handler`.
- Tests: the export/import purpose test now covers the backup purposes, and a
  new `backup_writes_through_a_temp_file_and_rename`.

### `apps/desktop/src/tauri.ts`
- `selectBackupExportPath`, `selectBackupImportPath`,
  `writeBackupExport(token, include)` and `previewBackupImport(token)`, plus
  `BackupInclude`/`BackupStats` types. `backup.import` is called by the caller
  with `rpc('backup.import', { previewId, resolutions })`.

### `apps/desktop/src/remote/remoteTiers.ts`
- `backup.export`, `backup.preview`, `backup.import` are `never`;
  `backup.imported` is `drop` in `EVENT_POLICY`. The parity test passes with
  both halves.

## The document

```json
{ "format": "bitbots.backup", "version": 1, "createdAt": "…",
  "app": { "version": "0.1.0-beta.29" },
  "contents": { "bots": [...], "memory": [...], "skills": [...], "automations": [...], "settings": { } },
  "checksum": { "alg": "sha256", "value": "<hex of sha256(serde_json::to_vec(&contents))>" } }
```

- **Bots**: `exportId` (the source agent id), `provider`, `runtimeHint`
  (runtime version, informational), `name`, `description`, `instructions`,
  `color`, `outfit`, `look`, `role`, `model`, `thinking`, `serviceTier`,
  `approvalMode`, `notificationLevel`, `leader`, `hidden`, `maxConcurrency`,
  `customEnvKeys`. Never `id`, `runtimeId`, `projectId`/`defaultProject`,
  `customArgs`, `sortOrder`, `archived` (archived bots are excluded), and never
  `customEnv` values.
- **Memory**: `id`, `scope`, `kind`, `title`, `body`, `tags`, `importance`,
  `pinned`, `origin`, `reviewed`, `createdAt`, `updatedAt`; bot scope carries
  `scopeId` (the bot's `exportId`), project scope carries `projectId` and
  `projectName`, shared scope carries neither. Deleted rows and
  secret-marker bodies are excluded on export and on import.
- **Skills**: `{ name, description, files: [{ path, sha256, base64 }] }`, files
  sorted by relative path (the pool's own order).
- **Automations**: `agentId` (the bot's `exportId`), `name`, `prompt`,
  `schedule`, `sessionMode`, `approvalMode`, `maxRuntimeSecs`.
- **Settings**: only allowlisted keys present in the source.

## RPC shapes as implemented

- `backup.export { include?: { memory?, skills?, automations?, settings? } }`
  → `{ document, stats: { bots, memory, skills, automations, settings } }`.
  Bots are always included; an absent sub-flag means "include".
- `backup.preview { document }` →
  `{ previewId, counts, conflicts: { bots: [{exportId,name,existingAgentId}],
  skills: [{name,same}], memory: [{id,identical}], settings:
  [{key,current,incoming}] }, warnings: [string] }`.
  `unsupported` for `version > 1`; `invalid_argument` "The backup file is
  damaged or was edited." for a checksum mismatch or a missing `format`.
- `backup.import { previewId, resolutions: { bots: { [exportId]: "rename" |
  "replace" | "skip" }, skills: { [name]: "replace" | "skip" }, default:
  "rename" | "skip" } }` →
  `{ imported: { bots, memory, skills, automations, settings },
  skipped: { bots, memory, skills, automations, settings },
  renamed: [{ from, to }] }`.
  `not_found` when the preview is unknown or has expired.
- New event `backup.imported { imported, skipped }`. Existing events reused:
  `agent.changed` (storage), `settings.changed` (storage), `skills.changed`
  (one per placed skill), `automation.changed` (one per restored automation).

### Import behaviour decisions worth naming
- One database transaction covers bots, memory, automations and settings.
  Skills are staged on disk **before** the transaction and moved into place
  after it commits; staging is removed on any failure.
- `default` applies to bot name conflicts only; `replace` is only ever taken
  from an explicit per-bot resolution. A same-name skill with no explicit
  resolution is skipped (there is no skill rename).
- Restored bots have `projectId = null` (Unassigned). `bypass` approvals
  become `ask`. A bot that would be a second leader loses the flag.
- Memory ids are preserved when free, so re-importing the same backup into the
  same database does not duplicate identical notes; a same-id note with
  different content is inserted under a fresh id. Bot-scope `scopeId` is
  rewritten to the id of the bot this import created or replaced.
- Automations are restored `enabled = 0`, `pause_reason = 'restored'`,
  `next_run_at = NULL`, `reuse_session_id = NULL`, `created_by = 'user'`.
- Settings outside the allowlist are silently ignored; an allowlisted key with
  a value `validate_setting` rejects is counted in `skipped.settings`.

## The exact settings allowlist

Exported (and importable) only when present in the source:

```
appearance.style            appearance.accent          appearance.density
appearance.theme            appearance.textSize        companion.focusMode
companion.soundsEnabled     companion.soundVolume      companion.openAtStartup
companion.hotkey            companion.chatSize         companion.startPosition
companion.pinnedBlobs       notifications.enabled      permissions.default_mode
profile.name                profile.about              speech.enabled
speech.engine               speech.model               memory.sharedAgentWrites
retry.maxWaitSecs           questions.expirySecs       automations.maxConcurrent
claude.enableWorkflows      conversations.autoTitle    skills.enabled
```

Plus every `experimental.*` key whose stored value is a boolean.

Never exported: `exec_gate.*`, `internal.*`, `migration.*`, `remote.*`,
`speech.cloud.consent*`, `companion.positions`, and any key containing
`token`, `secret`, `password`, `auth`, `cookie` or `key` (case-insensitive) —
with `companion.hotkey` allowed by name.

## Tests

`crates/bloblex-daemon/src/backup.rs` (unit):
- `contents_serialisation_is_canonical` — `to_vec` ignores insertion order, so
  the checksum is canonical (the build has no `preserve_order`).
- `settings_allowlist_excludes_secrets_and_keeps_named_keys`.
- `damaged_and_newer_documents_are_refused`.
- `previews_expire_and_keep_at_most_two`.

`crates/bloblex-daemon/src/main.rs` (integration):
- `backup_round_trip_restores_bots_memory_skills_automations_and_settings` —
  export from one database, import into a fresh one: counts match; look, role,
  instructions and approval mode survive; `customEnv` is empty and its keys
  travelled; automations are paused and re-pointed; bot memory is re-mapped to
  the restored bot id; the shared note survives; skill files are byte-identical;
  exactly one leader remains.
- `backup_export_honours_include_flags`.
- `backup_preview_refuses_a_damaged_or_newer_document` — checksum tamper is
  `invalid_argument` with the exact message; `version: 2` is `unsupported`.
- `backup_import_rename_replace_and_skip_resolve_a_name_conflict` — the three
  resolutions; replace keeps the existing id and applies the incoming fields.
- `backup_import_keeps_a_single_leader` — the existing leader keeps the flag,
  the two incoming leaders do not; the warning is present.
- `backup_import_ignores_non_allowlisted_settings_and_reports_invalid_ones`.
- `backup_skips_secret_marked_memory_on_both_sides`.
- `backup_skips_a_bot_whose_provider_has_no_runtime` — warning names the
  provider; the bot is skipped.
- `backup_import_of_an_expired_preview_is_not_found`.
- `backup_enforces_the_skill_size_caps` — a >5 MB file refuses the export with a
  clear error, and an oversized incoming file skips the skill instead of
  failing the import; a same-name skill is skipped without a resolution.
- `backup_import_reports_project_memory_that_cannot_be_matched`.

`apps/desktop/src-tauri/src/lib.rs` (native):
- `backup_selection_purposes_are_distinct_and_single_use` — a backup-export
  token cannot be spent as a backup import and vice versa; tokens stay
  single-use.
- `backup_writes_through_a_temp_file_and_rename` — no temp file is left behind.

## Gates

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — exit 0, **587 passed, 0 failed**.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote` — `tsc` clean;
  **47 passed** (3 files), including the remote-tier parity test with the three
  new `never` rules and the `backup.imported` `drop` entry.
- `cargo test -p bloblex-desktop --lib` — **could not build as-is in this
  worktree**: the gitignored sidecar binaries
  (`apps/desktop/src-tauri/binaries/bitbotsd-*.exe`, `bitbots-hook-*.exe`) the
  `externalBin` config needs are absent, and `frontendDist` (`apps/desktop/dist`)
  does not exist. To verify the new native code I created throwaway 2-byte
  sidecars and an empty `dist/index.html`, ran the test (**53 passed, 0
  failed**, including the two new backup tests), then removed all of it; the
  worktree contains none of those artifacts. The Director should run this gate
  on the merged result where the sidecar exists.
- One pre-existing lint note (not from this change): `cargo clippy -p
  bloblex-daemon --all-targets -- -D warnings` reports five `needless_borrow`
  errors in the FIX32 skills tests (`main.rs:8115-8123`). The gated clippy
  command does not use `--all-targets` and is clean.

## Verified vs not verified

- **Verified by tests:** the round trip (bot fields, empty `customEnv`, memory
  re-mapping, byte-identical skill files, paused automations, allowlisted
  settings); canonical checksum and tamper refusal; `version: 2` → `unsupported`;
  rename/replace/skip with id preservation; a single leader; the allowlist
  (ignored vs reported-invalid); secret-marker memory skipped both ways; a
  provider with no runtime skipped with a warning; preview TTL → `not_found`;
  the per-file skill cap on export and import; the native purpose/single-use and
  temp-file-write behaviour.
- **Not verified:** the `total` skill cap (50 MB). It is implemented in the same
  function as the per-file cap and returns the same style of error, but no test
  builds a >50 MB payload. Exercising it needs either 11 files of ~5 MB or many
  small files, which the pool's own 20 MB import cap makes awkward; the check is
  verified by inspection only.
- **Not verified:** a real end-to-end save/load of the pretty-printed file. Both
  the daemon tests and the native test operate on in-memory values or the temp
  write; no test parses `to_vec_pretty` output back and re-checks the checksum.
  The re-serialisation is canonical by construction (sorted maps), but the disk
  round trip through a dialog-chosen path was not driven.
- **Not verified:** the desktop UI flow. This lane added native commands and
  typed wrappers only; no screen calls them yet, so the user-visible
  backup/restore journey is untested here.
- **Not verified:** native backups against a real daemon. `cargo test -p
  bloblex-desktop --lib` uses the dummy sidecar described above; no live daemon
  was contacted.
- **Left stale on purpose:** `docs/remote/PROTOCOL.md`'s generated table was
  already out of date before this change (it still says "blob" where
  `remoteTiers.ts` now says "bot"), and regenerating it would produce a large
  unrelated diff. The parity test reads `remoteTiers.ts`, which is current.
