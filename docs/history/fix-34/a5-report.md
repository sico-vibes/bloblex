# FIX34 A5 — an expired CLI sign-in is detected, flagged and fixable from the app

> **What this is:** Report on FIX34 A5: an expired CLI sign-in is detected, flagged and fixable from the app.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, worktree `C:\fx53` (branch `lane/fix34-53`),
private `CARGO_TARGET_DIR=C:/fxt/a5`. No `git commit` was run. No file under
`apps/desktop/src/ui/**` was touched.

Status: implemented and gated. Two honest gaps are recorded under **Unverified**.

## Part 1 — daemon (`crates/bloblex-daemon/src/main.rs`)

### Failure classification

Both failure sites now switch the class to `unauthenticated` when `sign_in_hint`
matches, keeping the readable detail:

| Site | Change |
| --- | --- |
| `run_turn` prompt failure (~2995) | `let failure_class = if sign_in { "unauthenticated" } else { failure_class };` before `finish_turn_failed`; the public message stays "The coding agent's sign-in expired." |
| `forward_events_with_timeouts`, `AgentEvent::Error` (~3661) | `failure_detail_and_sign_in` is computed before `update_turn_outcome`, so the stored turn and the `turn.error` payload both carry `unauthenticated`. `denied_turns` is still consulted first for `permission_denied`. |

`failure_public_message` gained an `unauthenticated` arm so the shared helper cannot
drift from the two sites.

### The runtime marker

The failure is marked on the stored runtime as a **data field** (`data` JSON on the
`runtimes` row), so there is **no schema column, no migration and no `user_version`
bump**:

- `authState: "sign_in_failed"`
- `authFailedAt`: RFC 3339, seconds precision (`Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)`)

Then the whole roster is republished on `runtime.changed`:

```json
{ "runtimes": [ { "id": "...", "authState": "sign_in_failed", "authFailedAt": "2026-10-17T18:04:12Z", ... } ] }
```

`mark_runtime_sign_in_failed` is idempotent (it returns early when the runtime is
already flagged), and it runs **before** the `turn.error` event is emitted.

### Clearing the flag — exactly two paths

1. **A turn on that runtime completes.** `AgentEvent::TurnCompleted` calls
   `clear_runtime_sign_in_failed_after_success`, which sets `authState: "authenticated"`
   and removes `authFailedAt`. The completed turn is itself the proof, so no CLI probe is
   run on this path.
2. **`runtime.auth.clear { runtimeId }`.** New RPC in `dispatch`:

```json
// request  { "runtimeId": "rt-claude" }
// result   { "runtimes": [ ... the roster after clearing ... ] }
// errors   invalid_argument (missing/empty runtimeId), not_found (unknown runtime)
```

   It removes the marker (setting `authState` to `unknown`, dropping `authFailedAt`),
   publishes and only then re-runs `bloblex_runtime::discover()`; the discovered entry for
   that runtime (if any) is persisted and published. If discovery finds no entry for that
   runtime, the runtime stays `unknown` rather than the stale `sign_in_failed`.

`runtime.refresh` alone keeps the flag: every discovery path
(`publish_runtime_discovery`, `refresh_runtime_discovery`, startup, background, and the
clear above) goes through `persist_runtime_discovery`, which now inherits a stored
`sign_in_failed` (and its `authFailedAt`) into the freshly probed value. This is where the
spec's "discovery must not overwrite `sign_in_failed` with `authenticated`" is enforced —
`bloblex_runtime::auth_status` is a pure probe that only ever sees what the CLI claims
(`claude auth status` answers `loggedIn: true` with an expired refresh token), so it has no
stored state to protect and was left untouched.

### Storing the class

`turns.failure_class` has a `CHECK` constraint that predates this work, so
`bloblex-storage::update_turn_outcome` filters the class through the existing additive
column: `failure_class_v2` now accepts `unauthenticated` as well as `context`
(`crates/bloblex-storage/src/lib.rs`). `turn_failure_class`, `session_detail` and
analytics read `COALESCE(failure_class_v2, failure_class)`, so the stored turn keeps
`failureClass: "unauthenticated"`. `analytics_failure_class` still buckets it as `other`
(the analytics bucket set is unchanged and untouched).

### Remote policy

`apps/desktop/src/remote/tiers.json` gained one row:

```json
{ "method": "runtime.auth.clear", "class": "never", "minTier": null,
  "why": "Clearing a sign-in failure re-runs coding agent discovery on the host; a remote device must not do that.",
  "params": null }
```

`runtime.changed` was already classified `drop`, so nothing crosses to a device.

## Part 2 — native command (`apps/desktop/src-tauri/src/lib.rs`)

`runtime_terminal(provider, action)` — only these two strings come from the renderer; a
command string never does. Unknown values are rejected before anything is built.

| provider | `login` (PowerShell script) | `install` |
| --- | --- | --- |
| `claude` | `echo 'Bitbots: at the Claude Code prompt type /login, finish signing in, then retry here.'; claude` | `irm https://claude.ai/install.ps1 \| iex` then chained login |
| `codex` | `codex login` | `irm https://chatgpt.com/codex/install.ps1 \| iex` then chained login |
| `opencode` | `opencode auth login` | `npm install -g opencode-ai` then chained login; without `npm.cmd` on PATH → error naming `https://opencode.ai/docs/` |

Launch (visible window, no `CREATE_NO_WINDOW`), prefer:

```
wt.exe new-tab --title "Bitbots: <Provider> sign-in" powershell -NoExit -Command <script>
```

fall back when `wt.exe` is not on PATH:

```
cmd.exe /c start Bitbots powershell -NoExit -Command "<script>"
```

The `cmd` fallback quotes the script as one argument so cmd cannot act on the `|` in an
install command. Result: `{ "launched": true, "terminal": "wt" | "powershell" }`
(`TerminalLaunched`). Registered in `tauri::generate_handler!`.

TypeScript wrappers (non-visual only):

- `apps/desktop/src/tauri.ts`: `RuntimeTerminalProvider`, `RuntimeTerminalAction`,
  `RuntimeTerminalResult` and `runtimeTerminal(provider, action)`.
- `apps/desktop/src/remote/remoteTauri.ts`: the same exported names;
  `runtimeTerminal` throws `Not available on a remote device.`
- `apps/desktop/src/preview/fixtureBridge.ts`: a stub that opens nothing.
- `apps/desktop/src/types.ts`: `Runtime.authFailedAt?: string` (optional, additive).
- `runner`: `parseDispatch` in `remoteTiers.parity.test.ts` finds the new 8-space arm, and
  `remoteTauri.parity.test.ts` finds the new exports.

**The UI is not wired here** — `apps/desktop/src/ui/**` was not touched, as instructed.

## Tests

Daemon (`crates/bloblex-daemon/src/main.rs`, module `phase2a_tests`):

- `expired_sign_in_is_classified_and_a_completed_turn_clears_it` — an auth message through
  `forward_events` yields `runtime.changed` (flagged) **before** `turn.error`, then
  `failureClass: "unauthenticated"`, a detail containing `/login`, a stored runtime
  `authState: "sign_in_failed"` with an RFC 3339 `authFailedAt`, and a stored turn
  `failureClass: "unauthenticated"`; a later `TurnCompleted` on the same runtime emits
  `runtime.changed` with `authenticated` and the row loses `authFailedAt`.
- `runtime_refresh_keeps_a_sign_in_failure` — `refresh_runtime_discovery` fed a fake probe
  answering `authenticated` keeps `sign_in_failed` (and `authFailedAt`) in the returned
  roster, in `st.runtimes` and in the row.
- `runtime_auth_clear_reruns_discovery_for_that_runtime` — the clear publishes the
  discovered `authenticated` state and drops `authFailedAt`; an empty discovery leaves
  `unknown`; a missing runtime and an empty `runtimeId` are `not_found` / `invalid_argument`.

Storage (`crates/bloblex-storage/src/lib.rs`):
`unauthenticated_failure_class_round_trips_in_the_additive_column` — `turn_failure_class`
and the `session_detail` turn DTO both report `unauthenticated`.

Desktop unit tests (`runtime_terminal_tests`, 5 tests): provider/action allowlist
(`powershell`, `Claude`, `claude;calc`, `login;calc`, `--version` … rejected), the exact
argv per provider for `login` and `install`, the chained install login, the npm-less
OpenCode error naming the docs URL, and the quoted `cmd start` fallback argv. Nothing is
launched.

Remote TS: `remoteTiers.parity.test.ts` (dispatch ↔ tiers.json, both directions, plus the
event policy allow-list) and `remoteTauri.parity.test.ts` (export parity) pass.

## Gates

| Gate | Result |
| --- | --- |
| `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast` | **pass** — exit 0, 43 test binaries, **666 passed / 0 failed / 0 ignored**, no `FAILED`, no `panicked` |
| `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` | **pass** — clean, no warnings |
| `cd apps/desktop && npx tsc -b` | **pass** — exit 0 |
| `cd apps/desktop && npx vitest run src/remote` | **pass** — 11 files, **184 passed** |
| `cargo test -p bloblex-desktop --lib` | **ran once, then blocked** — see below |

### `cargo test -p bloblex-desktop --lib`

The worktree has no `apps/desktop/src-tauri/binaries/` and no `apps/desktop/dist/`, so the
gate fails in the build script exactly as expected in a worktree:

```
resource path `binaries\bitbotsd-x86_64-pc-windows-msvc.exe` doesn't exist
```

To prove the new native code compiles and its tests pass rather than reporting an
unverified file, I built `bitbotsd` and `bitbots-hook` into `C:/fxt/a5/debug`, staged copies
as `binaries/bitbotsd-x86_64-pc-windows-msvc.exe` / `binaries/bitbots-hook-x86_64-pc-windows-msvc.exe`,
added a one-line stub `apps/desktop/dist/index.html` (tauri's `generate_context!` requires
`frontendDist` to exist), ran:

```
cargo test -p bloblex-desktop --lib   →  running 58 tests; test result: ok. 58 passed; 0 failed
```

including all five `runtime_terminal_tests`. The staged sidecars and the stub `dist/` were
then **removed** (both are gitignored); `gen/schemas/*.json` was restored. The Director
still owes the gate in the main checkout with the real sidecars, which is the run that
counts.

## Unverified

- **A real expired sign-in, end to end.** No machine here has a Claude Code OAuth session
  whose refresh token is expired, so the dictionary in `sign_in_hint` was exercised only
  with the message shapes it already matched before this change
  (`"Failed to authenticate: OAuth session expired and could not be refreshed"`). The
  claim that a live expired session produces exactly such a message is the Director's
  finding, not re-verified here.
- **A real terminal launch.** `wt.exe` / `cmd.exe` are never spawned by the tests; only the
  exact argv and the PATH-based choice are covered. Whether `wt` accepts the quoted
  `-Command` script and whether `start` passes the quoted script through to PowerShell on
  every Windows build is unverified. The `npm`-less OpenCode branch was not exercised
  against a machine without npm.
- **The UI flow.** The toasts, the sheet that calls `runtimeTerminal` and the call to
  `runtime.auth.clear` are the Director's work and are not in this diff.
- `docs/remote/PROTOCOL.md`'s generated tier table was not regenerated; run
  `scripts/print-remote-tiers.mjs` to pick up the new `runtime.auth.clear` row.

## Notes for review

- `runtime.changed` is watched by the daemon's own event loop
  (`main.rs` ~648: `Ok(event) if event.event_type == "runtime.changed" => poll_provider_quotas`).
  Flagging or clearing a runtime therefore also triggers the existing quota poll. That is
  the consequence of the required event, not a new path; the poll is already gated and
  backed off.
- `runtime.auth.clear` runs a full `bloblex_runtime::discover()` (all providers) and keeps
  only the named runtime's entry. A per-provider probe does not exist in
  `bloblex-runtime`, so this reuses the existing scan rather than adding one.
- One full-suite `vitest run src/remote` run failed
  `RemoteApp.mounted.test.tsx > pairs: formats the code, waits for the owner…`
  (`.rm-waiting` undefined). It passed alone and passed on the next full run, and the test
  does not touch anything in this diff: recorded as a pre-existing order/timing flake.

## Follow-up — terminal launch quoting (review findings)

Two review findings on Part 2, fixed in `terminal_launch` / `runtime_terminal`
(`apps/desktop/src-tauri/src/lib.rs`). Nothing else in the diff changed.

### 1. Windows Terminal splits its arguments on an unescaped `;`

wt parses its own argument list before PowerShell sees the script, so a bare `;` is wt's
command separator: the Claude login hint (`echo …; claude`) and every chained install
(`<install>; <login>`) would have been split into two wt commands. The wt branch now runs
`script.replace(';', "\\;")` (wt's documented escape) — the only escape applied, since
`|` and quotes are PowerShell's business and wt does not interpret them:

```
echo 'Bitbots: …retry here.'\; claude
irm https://chatgpt.com/codex/install.ps1 | iex\; codex login
```

The PowerShell script text itself is unchanged; the daemon-side and TS-side tables are
untouched.

### 2. The `cmd.exe /c start … "<script>"` fallback is gone

Replaced by spawning PowerShell directly. **The Part 2 table's
`cmd.exe /c start Bitbots powershell -NoExit -Command "<script>"` line and the
"quoted `cmd start` fallback argv" test description above are superseded.**

| | before | now |
| --- | --- | --- |
| program | `cmd.exe` | `powershell.exe` |
| args | `/c start Bitbots powershell -NoExit -Command "<script>"` | `-NoExit -Command <script>` |
| quoting | hand-quoted (`format!("\"{script}\"")`) | none — one argv entry, quoted by `std::process::Command` |
| window | whatever `start` gave it | `creation_flags(0x00000010)` (`CREATE_NEW_CONSOLE`) |
| result `terminal` | `"powershell"` | `"powershell"` (unchanged) |

No `cmd.exe` is in the path any more, so nothing re-parses the `|` or `;` in the script.

`TerminalLaunch` gained `new_console: bool`; it is `false` for `wt.exe` (wt opens its own
window) and `true` only for the direct fallback. The spawn site applies
`creation_flags(0x00000010)` **only** when that field is set, and never
`CREATE_NO_WINDOW`:

```rust
let mut command = Command::new(&launch.program);
command.args(&launch.args);
#[cfg(windows)]
if launch.new_console {
    command.creation_flags(0x00000010); // CREATE_NEW_CONSOLE
}
command.spawn()…
```

### Tests

`runtime_terminal_tests` is now 6 tests; the exact argv assertions were updated for both
branches:

- `login_argv_per_provider_in_a_windows_terminal_tab` — Claude's wt argv is now
  `echo '…retry here.'\; claude`.
- `wt_escapes_every_semicolon_in_the_script` (new) — for all three providers and both
  actions, the number of `\;` in the argv script equals the number of `;`, no launch sets
  `new_console`, and the Claude login really does carry a separator to escape.
- `install_argv_chains_the_login_command` — `/install.ps1 | iex\; …` and
  `npm install -g opencode-ai\; opencode auth login`; `|` is deliberately left unescaped.
- `the_fallback_spawns_powershell_directly_with_a_new_console` (renamed from
  `the_fallback_quotes_the_script_for_cmd_start`) — program `powershell.exe`, `new_console`
  true, args exactly `["-NoExit", "-Command", "irm https://chatgpt.com/codex/install.ps1 | iex; codex login"]`.

Nothing is launched by any test.

### Gates (this follow-up)

| Gate | Result |
| --- | --- |
| `cargo test -p bloblex-desktop --lib` | **pass** (after staging, see below) — `test result: ok. 59 passed; 0 failed`, including all six `runtime_terminal_tests` |
| `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` | **pass** — clean; the excluded crates are unchanged by this follow-up, so it was served from cache (`Finished in 1.07s`) |

As before, the worktree has no `apps/desktop/src-tauri/binaries/` and no `apps/desktop/dist/`,
so the lib gate fails in the build script exactly as expected in a worktree:

```
resource path `binaries\bitbotsd-x86_64-pc-windows-msvc.exe` doesn't exist
```

To prove the new native code compiles and its tests pass, I staged the same throwaway copies
as last time (`C:/fxt/a5/debug/{bitbotsd,bitbots-hook}.exe` as the two
`binaries/*-x86_64-pc-windows-msvc.exe` sidecars, plus a one-line stub
`apps/desktop/dist/index.html`), ran the gate, then **removed** both staged directories
(both gitignored) and restored the `gen/schemas/*.json` the build rewrites. `git status` is
back to the same eight modified files plus the three untracked docs. The Director still owes
this gate in the main checkout with the real sidecars.

### Still unverified

- **wt's `\;` escape, and the flag, against a real terminal.** `wt.exe` / `powershell.exe`
  are still never spawned by the tests; only the exact argv, the escape and the
  `new_console` flag are covered. Whether wt accepts `\;` inside a quoted `-Command`
  argument on every wt build, and whether `CREATE_NEW_CONSOLE` plus a detached parent
  reliably yields a visible window, are unverified here.
- Everything already listed under **Unverified** above is unchanged: no live expired
  sign-in, no real launch, UI flow and `docs/remote/PROTOCOL.md` regeneration still owed.
