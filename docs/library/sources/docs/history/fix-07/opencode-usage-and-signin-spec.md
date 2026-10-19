# FIX7: OpenCode usage and sign-in status with OpenCode 1 and 2

> **What this is:** Spec for FIX7: OpenCode usage and sign-in status with OpenCode 1 and 2.
> **Status:** historical
> **Last updated:** 2026-10-15

Written 14 October 2026. Backend only (`crates/bloblex-daemon/src/quota_sources.rs`,
`crates/bloblex-runtime/src/lib.rs`, and their tests). Must keep OpenCode 1.x
working exactly as before.

## 1. Symptoms (owner, beta.26, OpenCode 2.0.28)

- The usage popover shows "OpenCode Go: Unavailable. Check the CLI sign-in, then
  refresh."
- The runtime card says "OpenCode 2.0.28 · Sign-in status unknown", although
  `opencode auth list` prints `OpenCode Console  Default  stored`.

## 2. Causes found

**Usage.** `quota_sources.rs` finds the Go key from `auth.json` (OpenCode 1:
`{"opencode-go":{...}}`) or from the credential table of OpenCode's SQLite
database, but only for `integration_id='opencode-go'`
(`key_from_credential_db`). On OpenCode 2 the owner has exactly one credential,
`integration_id='opencode'`, `active=1` (the "OpenCode Console" account, which is
the Zen/Go key); there is no `opencode-go` row and no `auth.json`. So
`resolve_opencode_saved_go_key` returns nothing and the source reports
`NoCredentials`. (Database columns: `id, integration_id, label, value,
connector_id, method_id, active, time_created, time_updated`.)

**Sign-in.** `crates/bloblex-runtime/src/lib.rs::auth_status` shells out to
`opencode auth list` with a 5-second timeout (`safe_status_output`). OpenCode 2
runs commands against a background service; on this machine a warm `auth list`
already takes about 1.8 s and a cold one (no service running yet, the normal case
right after Bitbots starts) is slower, so the call times out and the fallbacks
(`models --verbose` rejected, plain `models`) only yield a quiet "unknown".

## 3. Required behavior

### 3a. Sign-in status (runtime crate)

1. Add a fast, CLI-free presence check that runs **before** the CLI calls and is
   the source of truth for "is a credential stored":
   - OpenCode 1: `auth.json` in the OpenCode data dir has an entry for
     `opencode` and/or `opencode-go` (same data-dir rules as `opencode_data_dir`
     in `quota_sources.rs`: `OPENCODE_DB` for the db path; `XDG_DATA_HOME` or
     `~/.local/share` + `opencode`; and the Windows `USERPROFILE`/`HOME` handling
     already there).
   - OpenCode 2: the SQLite database (`opencode*.db` in the data dir, or
     `OPENCODE_DB`), opened **read-only** with `query_only`, table `credential`,
     rows with `active=1`. Select **only** `integration_id` (never the `value`
     column). Map `opencode` to the Zen gateway key `opencode`, `opencode-go` to
     `opencode-go`.
   - Result: `Authenticated` with a populated gateway map when at least one
     matching credential exists. If the files/tables do not exist or no rows
     match, this check says nothing (it must not claim `Unauthenticated`; fall
     through to the CLI result).
2. Keep the existing `auth list` parsing; raise its timeout for OpenCode from 5 s
   to 15 s (cold background service), keeping the other providers at 5 s. The CLI
   result and the presence check must agree on honesty: presence of a credential
   proves a credential is stored, not that it is valid; the label stays
   "signed in" as it is today for `stored`.
3. Never read, log, store or return a credential value or the database path in
   runtime state or errors. Fixed strings only, as today.
4. The 5 s to 15 s change must not slow discovery for Claude/Codex, and the
   overall discovery budget (31 s in `LAUNCH_TIMEOUTS`) must still hold; the
   three providers run concurrently already.

### 3b. Usage key (daemon crate)

1. In `resolve_opencode_saved_go_key` / `key_from_credential_db`, resolve in this
   order: `opencode-go` credential, then, when none, the `opencode` credential (the
   Console key). Keep `auth.json` handling as is for 1.x, and keep
   `OPENCODE_API_KEY` first.
2. `parsed_opencode_key(value, ["key","api"])` already extracts the key; verify
   against the stored JSON shape using only a **synthetic fixture** (a `value` of
   `{"type":"api","key":"x"}` is what the existing tests use). Do not open the
   user's real database in tests.
3. Honest failure: if the Console key is rejected by the Go usage endpoint
   (HTTP 401/403), keep the existing "Check the CLI sign-in" failure; do not mask
   it. Map the failure class exactly as today.
4. Zeroize the secret as the current code does; never log it.

## 4. Tests

- Runtime: a temp data dir with an `auth.json` containing `opencode-go` (v1):
  `Authenticated` with `{opencode-go: Authenticated}`; a temp SQLite db with the
  `credential` schema and one `opencode`, `active=1` row (v2): `Authenticated`
  with `{opencode: Authenticated}`; `active=0` or empty or missing table: no
  claim; the `value` column is never selected (assert via a view/trigger or by a
  db whose `value` column is unreadable, or by code inspection noted in the
  report). `auth list` timing out does not turn a stored credential into
  "unknown".
- Daemon: credential db with only an `opencode` row resolves the key; with both
  rows prefers `opencode-go`; `auth.json` still wins as before; the existing tests
  stay green.

## 5. Gates

```
cargo test -p bloblex-runtime
cargo test -p bloblex-daemon          # RUST_MIN_STACK=33554432 on this machine
cargo clippy -p bloblex-runtime -p bloblex-daemon --no-deps --all-targets -- -D warnings
```

The workspace is clippy-clean for `-D warnings`; keep it so.

## 6. Report

Files changed, exact test lines, and anything unsure. The Director verifies the
real usage call and the sign-in label on the owner's machine afterwards.
