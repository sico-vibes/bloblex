# FIX39 P12 report — local diagnostics

Package: P12 (local diagnostics). Worktree `C:\fx88`, branch `lane/fix39-p12`.
Spec: `docs/FIX39_DECISIONS.md` § "P12: local diagnostics". No `git commit` was run.

## What changed

### 1. Rolling log files (daemon and shell), `logs/` in the app data folder

- **Daemon:** new `crates/bloblex-daemon/src/diagnostics.rs`.
  - `log_dir()` (line 51) puts every log under `<data dir>/logs`.
  - `init_logging()` (line 167) builds a `tracing_appender::rolling::RollingFileAppender` with
    `Rotation::DAILY`, prefix `daemon`, suffix `log`, `max_log_files(14)`, wraps it in
    `RedactingWriter` and a non-blocking writer, and installs the subscriber. Level is
    `info` unless the hidden setting `diagnostics.logLevel` is `debug` (a `RUST_LOG` value
    overrides both).
  - `prune_logs()` (line 228) deletes the oldest `daemon.*.log` / `desktop.*.log` files until
    the folder is back at or under `MAX_LOG_BYTES` (20 MB). The newest file is always kept.
- **Daemon wiring:** `crates/bloblex-daemon/src/main.rs`
  - `mod diagnostics;` (line 39).
  - the tracing subscriber moved out of `main()` and into `run()` (line 4118–4125) so the
    data folder and the saved setting are known; the `WorkerGuard` is held for the process
    lifetime. The old stderr-only `tracing_subscriber::fmt()` in `main()` is gone.
  - `"diagnostics.preview" | "diagnostics.export"` routed to `diagnostics::rpc` (line 823).
  - `validate_setting` accepts only `info`/`debug` for `diagnostics.logLevel` (line 1351).
- **Shell:** `apps/desktop/src-tauri/src/lib.rs`
  - `bitbots_data_dir()` (line 810) resolves the same folder as the daemon
    (`%LOCALAPPDATA%\Bitbots`, or `BLOBLEX_DB_PATH`'s parent), so the daemon's export picks up
    the shell's file too.
  - `log_shell()` (line 820) appends one daily file `desktop.<date>.log`, prunes the shell's
    own files to 20 MB, and passes every line through `redact_log_line()` (line 839).
  - the four existing `eprintln!` sites (companion resize/anchor, daemon startup, shortcut)
    now also call `log_shell`, and setup writes one `desktop started version …` line.

### 2. Redaction

- `diagnostics::redact()` (line 74) plus `RedactingWriter` (line 85) scrub secret-shaped
  material from every chunk that reaches the file: `Bearer …`, `sk-…`/`xai-…`/`api-…` keys,
  `$argon2id$…`/`$scrypt$…`/`$pbkdf2$…` blobs, `token|secret|password|credential|api_key|
  authorization|cookie = value`, and `bloblex*=…` cookies. Ids, error classes, provider
  names, versions, timings, exit codes and paths without credentials are untouched.
- `scrub_events()` (line 131) removes message/prompt/delta/thinking/content/command/output/
  diff/recap/summary/reason/record/automation/requested/applied/result/detail/failure text and
  every secret-shaped key from exported app events; `scrub_settings()` (line 137) removes
  secret-shaped keys and values from the settings document only.
- No daemon log call site passes user text, and a static test enforces it (below).

### 3. "Export diagnostics" zip

- `diagnostics::rpc()` (line 437):
  - `diagnostics.preview` → `{ generatedAt, fileName, files: [{name, sizeBytes}] }`.
  - `diagnostics.export` → `{ fileName, sizeBytes, uncompressedBytes, files, base64 }`, the zip
    base64-encoded over loopback RPC so no webview path is involved.
- `build_zip()` (line 401) writes, at `unix_permissions(0o600)`: `README.txt`, `environment.json`
  (app version, protocol version, OS/arch, OS version, coding agents with names and versions —
  no executable paths), `settings.json`, `events.json` (last 200 app events, scrubbed) and the
  recent `logs/*` files (each scrubbed once more on the way in).
- **Shell commands:** `select_diagnostics_export_path` (line 954) uses the native save dialog and
  the existing opaque-token pattern (`SelectedFilePurpose::DiagnosticsExport`, line 57);
  `diagnostics_export_write` (line 974) spends the token, calls `diagnostics.export` and writes
  the bytes through `write_bytes_file` (line 897, temp file + rename). Both are registered in
  `generate_handler!`.
- **Remote policy:** `apps/desktop/src/remote/tiers.json` now has `diagnostics.preview` and
  `diagnostics.export` as `class: "never"`.

### 4. UI

- New `apps/desktop/src/ui/DiagnosticsDialog.tsx`: reads `diagnostics.preview` on open, lists
  every part of the zip (friendly label, name and size) with a total, then "Save as…" calls the
  two native commands and reports the saved path. Escape and backdrop close it. It states that
  nothing is uploaded.
- `apps/desktop/src/ui/SettingsSheet.tsx`: a "Support" group in Settings › General with an
  "Export diagnostics" row that opens the dialog (line 573); the dialog renders at the sheet's
  end.
- `apps/desktop/src/ui/App.tsx`: a "Export diagnostics" item in the quick switcher's Help group
  (line ~2304) that opens the same dialog.
- `apps/desktop/src/tauri.ts`: `DiagnosticsPreview` type, `selectDiagnosticsExportPath()`,
  `writeDiagnosticsExport()`.
- `apps/desktop/src/ui/settingsIndex.ts`: a search entry for the new row.
- `apps/desktop/src/ui/settings.css`: styles for the dialog list.

## Tests that prove it

Daemon (`crates/bloblex-daemon/src/main.rs`, `mod fix39_p12_tests`, line 10477; pure units in
`diagnostics.rs`):

- `diagnostics_export_never_carries_text_tokens_or_credentials` — builds the zip from a temp data
  folder and asserts the exported zip contains **no** message text, delta text, nested message
  content, command text, command output, recap text, the Argon2 hash digest, the log token or the
  log password — while keeping the session id, provider and log error code. It writes log files
  with a token and a password into the temp `logs/` folder first, so it also proves the export
  re-redacts an old/foreign file.
- `diagnostics_preview_lists_the_same_contents_before_saving` — preview lists `README.txt`,
  `events.json`, etc. with sizes and a `bitbots-diagnostics-<date>.zip` name, and carries no
  private text.
- `the_hidden_log_level_setting_accepts_only_info_and_debug`.
- `every_log_call_site_is_a_fixed_message` — scans every `tracing::` and `log_shell("` call site in
  `crates/bloblex-daemon/src` and `apps/desktop/src-tauri/src` and fails if any of them logs a
  value named text/prompt/content/message/command/secret/token/cookie/password/credential.
- `redaction_removes_tokens_and_credentials_but_keeps_ids`, `the_redacting_writer_never_writes_a_secret_to_the_file`,
  `scrubbing_removes_message_command_and_recap_text`, `scrubbing_settings_keeps_preferences_and_removes_secrets`,
  `the_oldest_log_files_are_deleted_first`, `only_version_shaped_os_output_is_kept`.

Shell (`apps/desktop/src-tauri/src/lib.rs`, `mod markdown_export_tests`):

- `diagnostics_selection_purpose_is_separate_and_the_writer_is_atomic` — a backup-token cannot be
  spent for diagnostics and vice versa (single use), and bytes land atomically.
- `the_shell_log_line_drops_tokens_and_passwords`.

UI:

- `apps/desktop/src/ui/DiagnosticsDialog.mounted.test.tsx` — the preview lists every part, saving
  goes through the opaque token, and a failed preview shows the error and disables saving.
- `apps/desktop/src/remote/remoteTiers.parity.test.ts` and `remoteTauri.parity.test.ts` (existing)
  cover the two new `never` rows and the new `../tauri` exports.

All tests point at temporary folders (`std::env::temp_dir()`); no owner data is touched.

## Gate results

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast` — all
  crates ok, `bloblex-daemon` 380 passed / 0 failed (after the two diagnostics fixes; three
  unrelated timing tests — `catalog_cached_only_never_waits`,
  `session_environment_reports_a_git_branch`, `the_per_device_rate_limit_stops_a_flood` — failed
  once under parallel load and pass alone and in the final full run).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.
- `cargo test -p bloblex-desktop --lib` — 59 passed / 0 failed.
- `cd apps/desktop && npx tsc -b` — clean.
- `npx vitest run --maxWorkers=3` — 170 files, 1245 tests, all passed.
- `npm run build` and `npm run build:remote` — both built.
- Live smoke: started `bitbotsd.exe` with a temp `BLOBLEX_DB_PATH`; it created
  `<dir>/logs/daemon.2026-10-18.log` as expected.

## What I could not check

- The real native save dialog and the resulting on-disk zip (no webview/desktop session here); the
  dialog's contents list, the token flow and the atomic write are covered by tests instead.
- Multi-day rotation and the 20 MB cap over real time; both are exercised by unit tests and prune
  runs at daemon start and on each shell write.
- The `debug` level takes effect at the next daemon start (the subscriber is installed once);
  changing the hidden setting live does not re-create it. Noted, not a decision requirement.
- Visual layout of the new dialog in the app (only type-checked, unit-tested and built).

## Files touched outside P12's list

- `apps/desktop/src-tauri/Cargo.toml` — added `base64.workspace = true` so the shell can decode
  the zip the daemon returns; the workspace already depends on `base64`.
- `apps/desktop/src/preview/fixtureBridge.ts`, `apps/desktop/src/remote/remoteTauri.ts` — the two
  export-parity tests require every `../tauri` export to exist in both bridges.
- `apps/desktop/src/ui/settingsIndex.ts` — one search entry for the new row.
- `Cargo.lock` — `tracing-appender 0.2.5` and `zip 2` for `bloblex-daemon` (`zip 2.4.2` was already
  in the lock via `sherpa-onnx-sys`).
- Generated Tauri schema files under `apps/desktop/src-tauri/gen/schemas/` show as modified only
  because the build rewrote their line endings; `git diff` is empty for them.

---

# Follow-up (audit)

A second implementer finished P12 after the first ran out of usage. The first
implementer built the whole package (sections 1–4 above); the second applied the
auditor's findings `docs/FIX39_P12_AUDIT.md` F1–F9, failing-first, and re-ran the
gates. No `git commit` was run. Nothing above was reverted; only the fixes below
were added on top.

## Privacy findings (fixed first)

### F1 — `permission.requested` question text reached `events.json`

- `crates/bloblex-daemon/src/diagnostics.rs:184` `scrub_events` is now an
  **allowlist** (`EVENT_SAFE_KEYS`, line 126) rather than a denylist: an event key
  is copied only if it names an id, enum-ish state, error class, provider,
  version, timing, counter or flag. Every other key (the `questions` array and
  its `question`/`header`/`options`/`label`/`description`, and also `title`,
  `detail`, `input`, `arguments`, `content`, `patch`, paths, …) is dropped. A
  string under `payload` is never kept.
- `crates/bloblex-daemon/src/main.rs:10534` the export test now pushes a real
  `permission.requested` shape (`questions: [{question, header, options:[{label,
  description}]}]`), from the daemon's own branch at `main.rs:3975`, and asserts
  none of that text is in the zip while `perm-1`, `s-2` and `kind` survive.
- Unit test `a_question_event_loses_its_text` (`diagnostics.rs:664`).

### F2 — `profile.about` and `internal.*` reached `settings.json`

- `diagnostics.rs:157` `is_withheld_setting` and `diagnostics.rs:212`
  `scrub_settings` replace `profile.about`, `internal` and every `internal.*`
  key with `"[omitted]"`; all other preferences are kept.
- The export test sets `profile.about` and an `internal.delete.*` row
  (`main.rs:10551`) and forbids the text in the zip; the unit test
  `scrubbing_settings_keeps_preferences_and_removes_secrets` (`diagnostics.rs:640`)
  asserts `[omitted]`.
- **Conscious choice:** `remote.native.account.username` is kept (still pinned by
  the unit test). It is a label, not a secret, and it says which account is
  configured; the audit left this to us and did not require dropping it.

### F3 — the secret regex missed JSON-shaped values

- `diagnostics.rs:75` the key pattern now allows an optional closing quote
  between the key and the separator (`["']?`), so `{"token":"abc"}`,
  `"password": "x"` and `{"cookie":"y"}` are redacted.
- Test `redaction_removes_json_shaped_secrets` (`diagnostics.rs:558`).

### F4 — usage counters and commit hashes were redacted

- `diagnostics.rs:164` `is_secret_key` matches `token`, `*Token`/`*_token`
  (e.g. `accessToken`, `refresh_token`) and `tokenHash`, and the exact keys
  `hash`/`tokenhash`; `inputTokens`, `outputTokens`, `contextTokens`,
  `tokenCount`, `tokensUsed` and `commitHash` are no longer secrets. `secret`,
  `password`, `capability`, `credential`, `authorization`, `cookie`, `apiKey`
  stay redacted.
- Test `token_counters_and_commit_hashes_survive_redaction` (`diagnostics.rs:569`).

## Smaller findings

### F5 — the call-site test could pass while checking nothing

- `crates/bloblex-daemon/src/main.rs:10630` `every_log_call_site_is_a_fixed_message`
  now asserts each root has Rust sources and at least one call site and that at
  least one `tracing::` call was seen; it also matches bare
  `warn!/error!/info!/debug!/trace!(` and any `log_shell(`, and skips the `fn
  log_shell` definition line. It still extracts the call up to the next `);`
  (a long call can therefore be inspected past its arguments); the assertion now
  fails loudly if a folder moves instead of silently passing.

### F6 — `debug` turned on every dependency

- `diagnostics.rs:51` `log_directive` returns `info` for the default and
  `bloblex_daemon=debug,info` for the hidden `debug` level, so a dependency's
  (hyper, h2, rustls, reqwest, tungstenite) debug output never reaches the file
  or the zip. `init_logging` uses it (`diagnostics.rs:253`); `RUST_LOG` still
  overrides.
- Test `the_log_directive_does_not_enable_dependencies_debug` (`diagnostics.rs:587`).

### F7 — the shell redactor was weaker than the daemon's

- `apps/desktop/src-tauri/src/lib.rs:862` `redact_log_line` now redacts every
  `Bearer` (the old loop stopped after the first) and, for `token`, `password`,
  `secret`, `capability`, `credential`, `authorization`, `cookie`, `api_key` and
  `apikey`, handles `key=value`, `key: value` and the JSON form
  `"key":"value"` (quoted values up to their closing quote).
- Test `the_shell_log_line_drops_every_bearer_and_json_shaped_secret`
  (`lib.rs:2826`), which failed on the first version of the fix (a quoted value
  starts with the delimiter) and passes now.

### F8 — the shell pruned the folder on every line

- `lib.rs:820` `log_shell` prunes only when the day's file name changes, through
  `SHELL_LOG_DAY` (`lib.rs:850`) and `should_prune_shell_logs` (`lib.rs:853`).
  Bursts of companion-resize lines no longer `read_dir` and stat every file.
- Test `the_shell_prunes_the_log_folder_only_when_the_day_changes` (`lib.rs:2838`).

### F9 — dialog focus and Escape

- `apps/desktop/src/ui/DiagnosticsDialog.tsx:21` focuses the first button ("Not
  now"/"Close") when the dialog opens, like the other `blob-dialog` components.
- `DiagnosticsDialog.tsx:40` the Escape listener is a capture listener on
  `document` and calls `stopPropagation`, so opening from the Settings sheet
  closes only the dialog, not the sheet as well (the sheet itself has no Escape
  listener today; the test simulates the outer one to prove the dialog wins).
- Tests `moves focus into the dialog when it opens` and `closes only the dialog
  on Escape, not the sheet that opened it` in
  `apps/desktop/src/ui/DiagnosticsDialog.mounted.test.tsx`.

## Failing-first evidence

Before the fixes, the new tests were run against the old behaviour
(the fixes temporarily reverted) and failed: `a_question_event_loses_its_text`,
`redaction_removes_json_shaped_secrets`, `scrubbing_removes_message_command_and_recap_text`,
`scrubbing_settings_keeps_preferences_and_removes_secrets`,
`token_counters_and_commit_hashes_survive_redaction` and the zip test
`diagnostics_export_never_carries_text_tokens_or_credentials` — 6 failed, 8
passed. `the_shell_log_line_drops_every_bearer_and_json_shaped_secret` failed
while the F7 fix was incomplete. Restoring the fixes made all of them pass.

## Gate results (re-run after the fixes)

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  (`CARGO_TARGET_DIR=C:/fxt/a1`, `TEMP=C:/fxt/a1/tmp`) — all crates ok;
  `bloblex-daemon` 385 passed / 0 failed (was 380; +5 new diagnostics tests).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.
- `cargo test -p bloblex-desktop --lib` — 61 passed / 0 failed (was 59; +2 new
  shell tests).
- `cd apps/desktop && npx tsc -b` — clean.
- `npx vitest run --maxWorkers=3` — 170 files, 1247 tests, all passed (was 1245;
  +2 new dialog tests, including `DiagnosticsDialog.mounted.test.tsx` 5/5).
- `npm run build` — built. `npm run build:remote` — built.

## What this follow-up could not check

- The real native save dialog, a real on-disk zip, multi-day rotation and the
  20 MB cap over real time; the visual layout of the dialog in the app.
- The live effect of the `debug` directive (it applies at the next daemon start).
- Whether a real browser behaves like happy-dom for the capture-phase
  `stopPropagation` (the test proves it under happy-dom; the pattern is
  standard).

## Files touched by this follow-up

Only files already in P12's list: `crates/bloblex-daemon/src/diagnostics.rs`,
`crates/bloblex-daemon/src/main.rs`, `apps/desktop/src-tauri/src/lib.rs`,
`apps/desktop/src/ui/DiagnosticsDialog.tsx` and
`apps/desktop/src/ui/DiagnosticsDialog.mounted.test.tsx` (new in P12), plus this
report.

---

# F6 follow-up (re-check)

Sonnet's re-check of the follow-up failed F6: the daemon's crate/tracing target
is the Cargo `[[bin]]` name **`bitbotsd`** (`crates/bloblex-daemon/Cargo.toml`),
not the package name `bloblex_daemon`, so the directive
`bloblex_daemon=debug,info` matched no target and the hidden `debug` level
silently behaved like `info` for the daemon's own logs too.

## What changed (this third pass)

- `crates/bloblex-daemon/src/diagnostics.rs`:
  - new `LOG_TARGET: &str = "bitbotsd"` const (line 53) documenting that the
    target is the `[[bin]]` name, not the package name; `log_directive` now
    returns `bitbotsd=debug,info` (line 58–60).
  - doc comment above `log_directive` corrected (`bitbotsd=debug,info`).
  - `the_log_directive_does_not_enable_dependencies_debug` assertion updated to
    `bitbotsd=debug,info` (line 597).
  - new test `the_debug_directive_enables_the_daemon_target_but_no_dependency`
    (line 607): builds a real `EnvFilter` from `log_directive("debug")` and
    asks it about two static `Metadata` targets via
    `<EnvFilter as Layer<Registry>>::register_callsite` — `bitbotsd` at DEBUG
    must be `Interest::always`, `hyper` at DEBUG must be `Interest::never`, and
    `log_directive("info")` leaves `bitbotsd` DEBUG `Interest::never`.
- `docs/FIX39_P12_REPORT.md`: this note.

## Failing-first evidence

With the test metadata target temporarily set to the old wrong name
`bloblex_daemon`, the new test failed exactly as the bug predicts:
`the daemon's own debug logs must be enabled: Interest(Never)`. Restored to
`bitbotsd`, it passes. (`bloblex_daemon=debug,info` was matching nothing.)

## Gate results (re-run)

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop
  --no-fail-fast` (`CARGO_TARGET_DIR=C:/fxt/a1`, `TEMP=C:/fxt/a1/tmp`) — all
  crates ok; `bloblex-daemon` **386 passed / 0 failed** (was 385; +1 new test).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.
- No UI or `src-tauri` source changed this pass, so the UI and
  `bloblex-desktop` lib gates were not re-run (they passed unchanged in the
  previous pass).

## What this pass could not check

- The live effect of the `debug` directive against a running daemon (it applies
  at the next daemon start); the test proves the `EnvFilter` decision, which is
  what `init_logging` feeds into `with_env_filter`.
