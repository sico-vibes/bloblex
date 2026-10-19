# FIX34 A5: expired CLI sign-in is detected, flagged and fixable from the app

> **What this is:** Spec for FIX34 A5: detecting and fixing an expired CLI sign-in from the app.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree, private `CARGO_TARGET_DIR`. **Do not run `git commit`.** Read `AGENTS.md` first. Keep your context small: grep and read only the ranges you need (`main.rs` and `src-tauri/src/lib.rs` are very large); pipe long output through `tail`/`grep`. Do not change UI files (`apps/desktop/src/ui/**`); the Director wires the UI.

## Problem (found by the Director)
When Claude Code's OAuth session expires, a send fails and the UI shows only "The coding agent reported a problem." `sign_in_hint` (`crates/bloblex-daemon/src/main.rs` ~201-211) recognises the failure and `failure_detail_and_sign_in` (~187-197) folds a hint into the detail, but both failure sites keep `failureClass: "provider_error"` (prompt failures ~2874-2875, turn errors ~3543-3553), and nothing marks the runtime. `claude auth status` still reports `loggedIn: true` with an expired refresh token, so startup discovery cannot see it.

## Part 1: daemon
- When the sign-in hint matches, emit `failureClass: "unauthenticated"` (both sites). Keep the readable detail.
- Mark the runtime: `authState = "sign_in_failed"` and `authFailedAt` (RFC 3339) on the stored runtime (`crates/bloblex-storage` runtimes table; add a column or data field additively, no `user_version` bump), then emit `runtime.changed`.
- Clear the flag (back to the discovered state) in two cases only: a turn on that runtime completes successfully, or the new RPC `runtime.auth.clear { runtimeId }` is called (the UI calls it after the user says they signed in); it clears the flag and re-runs discovery for that runtime. `runtime.refresh` alone keeps `sign_in_failed`.
- Discovery (`crates/bloblex-runtime/src/lib.rs` `auth_status`) must not overwrite `sign_in_failed` with `authenticated`.
- Add `runtime.auth.clear` to `apps/desktop/src/remote/tiers.json` as `never` (parity test).
- Tests: a turn failing with an auth message → `failureClass` `unauthenticated`, runtime `sign_in_failed`, `runtime.changed` emitted; a later successful turn clears it; `runtime.refresh` keeps it; `runtime.auth.clear` clears it.

## Part 2: native command (`apps/desktop/src-tauri/src/lib.rs`)
New Tauri command `runtime_terminal(provider: String, action: String)`:
- `provider` ∈ `claude | codex | opencode`, `action` ∈ `login | install`; anything else → error. **Never** take a command string from the renderer.
- Fixed command table (Windows):
  - login: claude → `claude` (the user types `/login`; print a one-line hint first with `echo`), codex → `codex login`, opencode → `opencode auth login`.
  - install: claude → PowerShell `irm https://claude.ai/install.ps1 | iex`; codex → PowerShell `irm https://chatgpt.com/codex/install.ps1 | iex`; opencode → `npm install -g opencode-ai` (only if `npm` is on PATH, else return an error naming the docs URL `https://opencode.ai/docs/`). After an install, chain the provider's login command in the same window.
- Launch: prefer `wt.exe new-tab --title "Bitbots: <Provider> sign-in" powershell -NoExit -Command <cmd>`; fall back to `cmd.exe /c start "Bitbots" powershell -NoExit -Command <cmd>`. Visible window (no `CREATE_NO_WINDOW`). Return `{ launched: true, terminal: "wt" | "powershell" }`.
- Register it in the invoke handler list and add a typed wrapper `runtimeTerminal(provider, action)` in `apps/desktop/src/tauri.ts`, plus a stub in `apps/desktop/src/preview/fixtureBridge.ts` and in `apps/desktop/src/remote/remoteTauri.ts` (throws "Not available on a remote device.").
- Unit-test the command table (allowlist, rejection of unknown values, the exact argv per provider/action) without launching anything.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cargo test -p bloblex-desktop --lib` (if the sidecar binaries are missing in the worktree, say so; the Director runs it)
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote`

## Report
`docs/history/fix-34/a5-report.md`: RPC and event shapes as implemented, the command table, tests, gates, unverified (real expired sign-in, real terminal launch).
