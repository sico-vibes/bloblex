# FIX39 P12 audit — local diagnostics

Auditor: Claude Sonnet 5.5. Scope read: `docs/FIX39_DECISIONS.md` § P12, `docs/FIX39_P12_REPORT.md`, the full diff and the new files (`diagnostics.rs`, `DiagnosticsDialog.tsx`, its test). Gates were not re-run; the report's numbers look plausible and the Director runs the full gates after the merge.

## Verdict: PASS WITH FIXES

Every item in the spec is built and wired: rolling daily logs, the 20 MB cap, the hidden `info`/`debug` setting, the shell's own log, redaction, the preview and the zip, the native save dialog with an opaque token, the Settings row and the Help-group item, and `never` rows in `tiers.json`. The architecture is sound. There are two real privacy leaks against the spec's "message text stripped / secrets removed" promise, and a few smaller gaps. Sol should fix F1 to F4 before the merge; F5 to F9 are small.

## Findings that must be fixed

### F1. `permission.requested` events leak the agent's question text into `events.json`
`crates/bloblex-daemon/src/diagnostics.rs:110-116` (`CONTENT_KEYS`) and `crates/bloblex-daemon/src/main.rs:3975`.
The question flow emits `permission.requested` with a `questions` array (the agent's question text, headers and option labels/descriptions). `questions` is not in `CONTENT_KEYS`, and the nested keys (`question`, `header`, `options`, `label`, `description`) are not either, so all of it goes into the zip in clear. That is conversation content, and the dialog tells the owner it is removed ("message and command text removed"). Other free-text keys also missing from the list: `input`, `toolInput`, `arguments`, `question`, `answer`, `answers`, `description`, `note`, `error`, `errorMessage`, `snippet`, `preview`, `patch`, `label`.
Fix: add those keys, and add a test event shaped like the real `permission.requested` question payload (`questions: [{question, header, options:[{label, description}]}]`) to `diagnostics_export_never_carries_text_tokens_or_credentials`. The denylist approach is fragile in general; the better design for `events.json` is an **allowlist** of safe keys (`sessionId`, `turnId`, `runtimeId`, `agentId`, `id`, `provider`, `state`, `status`, `code`, `failureClass`, `exitCode`, `risk`, `category`, `kind`, timestamps, numeric counters, `type`, `sequence`, `eventId`, `v`). If Sol keeps the denylist, say so in the report and add the keys above.

### F2. `profile.about` (and other free-text settings) go into `settings.json`
`diagnostics.rs:137-139` and `:347-350`.
`scrub_settings` keeps every non-secret value. `profile.about` is up to 1500 characters of the owner's own text (validated at `main.rs:1354`) and is injected into prompts; `internal.delete.*` rows and `companion.positions` are also there. This is personal prompt text in a file the owner is invited to send to someone. The spec says "settings with secrets removed", but the privacy rule in AGENTS.md ("content stays private", no conversation text) and the dialog's own promise both argue for dropping it.
Fix: drop `profile.about` and every `internal.*` key from the exported settings (replace with `"[omitted]"`), and add an assertion to the export test. Also decide whether `remote.native.account.username` should be kept; the unit test `scrubbing_settings_keeps_preferences_and_removes_secrets` pins it as kept, which is acceptable but should be a conscious choice. Mention it in the report.

### F3. The secret regex misses JSON-shaped values, so `{"token":"abc"}` survives
`diagnostics.rs:62`.
The key-value pattern requires `token`/`password`/… to be followed directly by `\s*[=:]`. In JSON text the closing quote of the key sits in between (`"token":"abc"`, `"password": "x"`), so it does not match. This applies to the log file (an error that formats a JSON body or a Debug struct) and to string values inside exported events and settings that contain embedded JSON. The tests only use `token=` and `password:` forms, so they do not catch it.
Fix: allow an optional closing quote after the key: `(…)["']?(\s*[=:]\s*)(…)`, and add `{"token":"abc","password": "hunter2","cookie":"x"}` cases to `redaction_removes_tokens_and_credentials_but_keeps_ids`.

### F4. `is_secret_key` redacts usage counters (`inputTokens`, `outputTokens`, `contextTokens`)
`diagnostics.rs:118-123`.
`lower.contains("token")` also matches every token-count field, so any usage or cost data in exported events becomes `[redacted]`, which defeats the purpose of diagnostics for the most common support question (limits and usage). The "hash" needle also eats commit hashes.
Fix: match whole words or known suffixes: exact `token`, `*Token` / `*_token` where the rest is not `s`/`count`/`usage`, `accessToken`, `refreshToken`, `idToken`, `authToken`, `bearerToken`, `tokenHash`; keep `secret`, `password`, `credential`, `authorization`, `cookie`, `apiKey`, `capability`. Add a test that `inputTokens: 120` and `outputTokens: 40` survive while `accessToken` and `token` do not.

## Smaller fixes

### F5. The "no user text in log call sites" test can pass while checking nothing
`crates/bloblex-daemon/src/main.rs` (`every_log_call_site_is_a_fixed_message`, about line 10593).
It reads `../../crates/bloblex-daemon/src` and `../../apps/desktop/src-tauri/src`; `source_files` returns an empty list when a path does not exist and the loop silently passes. Add `assert!(scanned > 0)` per root (and at least one `tracing::` call found). It also only matches the literal `tracing::` and `log_shell("`, so `use tracing::warn;` followed by a bare `warn!(...)`, and `log_shell(level, &format!(...))` with a variable first argument, are not covered. Either also match `\b(warn|info|error|debug|trace)!\(` and `log_shell(`, or state that limitation in a comment. Today's call sites (`main.rs:666,677,776,787,4199`, `experiments.rs:124`, `remote/connectivity.rs:423`, `remote/web.rs:955`, and the shell's `log_shell` lines) are all fixed messages, `{error}` from storage, or a folder path, so nothing is wrong now.

### F6. `debug` enables debug logging for every dependency
`diagnostics.rs:179-180`.
`EnvFilter::new("debug")` turns on hyper, h2, rustls, reqwest and tungstenite debug output. The redactor catches `bearer …` and `token=…`, but the log folder and the zip would then carry connection/URL detail from the Remote and dictation paths that nobody reviewed. Use a scoped directive: `info` by default and `bloblex=debug,info` (check the exact crate target names, for example `bloblex_daemon`) for the hidden `debug` level. Add a one-line test of the directive string.

### F7. Shell redaction is weaker than the daemon's
`apps/desktop/src-tauri/src/lib.rs:839-868`.
`redact_log_line` handles only the first `Bearer` (it `break`s) and does not cover `cookie`, `authorization`, `api_key`, `sk-…` or the JSON form. The shell logs only fixed messages plus OS error text today, so risk is low, but the two redactors will drift. Preferred fix: loop over all `Bearer` occurrences and add `cookie`/`authorization`/`api_key`; or accept the duplication and note it in the code comment.

### F8. `log_shell` prunes the folder on every line
`lib.rs:820-837`. `prune_shell_logs` does a `read_dir` plus metadata for every line (companion resize logs can come in bursts). Prune once per process (a `OnceLock`/`Once`) or only when the day's file name changes.

### F9. Dialog focus
`apps/desktop/src/ui/DiagnosticsDialog.tsx:15,70`. `first` is created and attached to the "Not now" button but never focused, so keyboard focus stays behind the modal. Focus it on open (the other `blob-dialog` components do), and check that Escape in the Settings sheet does not close the sheet and the dialog together (both listen on `document` keydown). The latter I did not run; please confirm in the mounted test.

## Checked and fine

- **Spec coverage:** daily rotation with 14-file and 20 MB caps (newest always kept); `info` default and `debug` through the validated hidden setting (documented as applying at the next start); shell file `desktop.<date>.log` in the same `logs/` folder, and the shell and daemon resolve the same data folder (`bitbots_data_dir` matches the daemon's `BLOBLEX_DB_PATH` / `%LOCALAPPDATA%\Bitbots` rule); the zip carries README, environment (no executable paths, version reduced to digits), settings, the last 200 events, and the logs re-redacted on the way in.
- **Save path:** the renderer never supplies a path. The new `SelectedFilePurpose::DiagnosticsExport` is single-use and not interchangeable with the backup purposes (tested); the write is a temp file plus rename. The zip travels as base64 over the loopback RPC and the renderer receives only a summary.
- **Remote:** `diagnostics.preview` and `diagnostics.export` are `class: "never"` in `tiers.json`; both new `../tauri` exports exist in `remoteTauri.ts` and `fixtureBridge.ts` for the parity tests. `settings.set` is already never-remote, so the log-level setting cannot be changed remotely.
- **Scope:** `main.rs` changes are limited to the module line, the RPC route, the setting validation, moving the tracing set-up into `run()` and the test module; `lib.rs` changes are the shell log, the two commands and the `write_bytes_file` refactor (the backup writer keeps its behaviour). The extra files (`base64` in the shell's `Cargo.toml`, the two bridges, `settingsIndex.ts`, `Cargo.lock`) are justified by the report. The generated Tauri schema files show only line-ending churn; make sure the Director does not commit them.
- **Visual rules:** icons are `FileArchive`, `Download`, `LoaderCircle`; no sparkle or star. The CSS uses the shared tokens (`--text-2`, `--line`, `--surface-raised`), so both looks and both themes follow the existing variables.
- **Tests that bite:** the export test would fail on the old code (no `diagnostics.*` route) and checks real absence of nine private strings in the actual zip; it seeds an old log file to prove re-redaction. The mounted test checks behaviour (token flow, error disables saving). The writer test and the prune test assert behaviour, not internals.
- **Not verified here:** the native save dialog and a real on-disk zip, multi-day rotation, and the dialog's layout in the app. The report says so honestly.

## What Sol should do

1. F1: add the missing content keys (or switch `events.json` to an allowlist) and extend the export test with a real question payload.
2. F2: omit `profile.about` and `internal.*` from `settings.json`, with a test.
3. F3: make the secret regex accept a quoted key (JSON), with tests.
4. F4: narrow `is_secret_key` so token counters and commit hashes survive, with a test.
5. F5 to F9 as described. Re-run the daemon diagnostics tests, `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`, the `bloblex-desktop` lib tests, and `DiagnosticsDialog.mounted.test.tsx`, then update `docs/FIX39_P12_REPORT.md`.
