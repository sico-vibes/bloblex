# FIX33 (WP7): small backend items from the owner review

> **What this is:** Spec for FIX33 (WP7): small backend items from the owner review.
> **Status:** historical
> **Last updated:** 2026-10-16

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort. Director reviews, runs the gates and commits. **Do not run `git commit`.** Work only in this worktree.

Read first: `AGENTS.md` (invariants, the 12 and 14 October amendments), then the files named below. Plan: `C:\Users\Sico Vibes\.claude\plans\robust-dazzling-taco.md` Part 2b and Part 3 (WP7).

## 1. `runtime.capabilities` no longer rejects a bot moving to another runtime

File: `crates/bloblex-daemon/src/main.rs`, `runtime_capabilities` (search `agentId does not belong to runtimeId`).

- When `agentId` names a bot whose saved `runtimeId` differs from the `runtimeId` parameter, do **not** return an error. Instead:
  - ignore the agent when choosing the model in scope (`capability_selected_model` must not use that agent's saved model),
  - return `"agentConcurrency": null` and add `"agentRuntimeMismatch": true` to the result.
- A missing agent still returns the existing `not_found` mapping; a non-string `agentId` is still `invalid_argument`.
- Update any test that asserted the old error. Add `runtime_capabilities_tolerates_agent_on_another_runtime`.

## 2. The model-facing noun is always "bot"

File: `crates/bloblex-daemon/src/team.rs`, `entity_noun`.

- Always return `bot` / `bots`. Delete the settings read and update the doc comment (owner review, 16 October 2026: the characters are bots in both looks).
- Update the test that sets `appearance.style = "blobots"` (search `blobots` in the daemon tests) to assert "bot".
- Note in the report: the instruction text changes once for Blobots users, so their next turn re-sends instructions (OpenCode respawns once). Expected.

## 3. New RPC `session.environment`

File: `crates/bloblex-daemon/src/main.rs` (dispatch arm + handler). Reuse `experiments::git_command()` (make it `pub(crate)`).

- Params `{ sessionId }`. Result `{ "projectPath": string|null, "gitRepo": bool, "branch": string|null, "detached": bool, "host": string }`.
- `projectPath` from `st.db.session_detail(sessionId)["projectPath"]`. Unknown session → existing `not_found` mapping.
- Run `git -C <projectPath> rev-parse --abbrev-ref HEAD` with **no shell**, the path as an argument, on `tokio::task::spawn_blocking` (or `tokio::process::Command` with `kill_on_drop`), with a **2 second timeout**.
  - Not a repo, git missing, timeout or a missing folder → `gitRepo: false`, `branch: null`. Never an error for these.
  - Output `HEAD` → `detached: true`, and `branch` = `git -C <path> rev-parse --short HEAD`.
- `host` = `COMPUTERNAME`, else `HOSTNAME`, else `"This computer"`.
- Never log the path or git output.
- **Remote tier:** add `session.environment` to `apps/desktop/src/remote/remoteTiers.ts` as `class: 'read', minTier: READ` with a short `why` ("Shows where a conversation works."). `npx vitest run src/remote` must stay green (the parity test fails if any dispatch method lacks a tier row).
- Tests: a temp dir that is not a repo → `gitRepo: false`; a temp dir after `git init` and one commit → `gitRepo: true` and a branch name (skip gracefully if `git` is not on PATH).

## 4. Cloud dictation warm-up (no request to the endpoint)

Files: `crates/bloblex-speech/src/cloud.rs`, `apps/desktop/src-tauri/src/speech.rs`, `apps/desktop/src-tauri/src/lib.rs` (command registration).

The 14 October exception covers the transcription call only. This change may **not** send any request to `chatgpt.com` ahead of time. Tokens, audio and transcripts are never persisted or logged.

- In `cloud.rs`, keep one shared `reqwest::Client` (`static CLIENT: OnceLock<reqwest::Client>`), built once by `build_cloud_client`. Move the per-call timeout to `RequestBuilder::timeout` so the shared client has no fixed overall timeout. Base-URL test injection must keep working (tests that build their own client still may).
- Add `pub async fn warm() -> WarmReport` that:
  1. builds (or reuses) the shared client and its rustls config,
  2. calls `auth_status()` (reads the file, keeps no token),
  3. resolves DNS for `chatgpt.com:443` with `tokio::net::lookup_host` (a failure is reported, not an error).
  It returns `{ client_ready: bool, auth: AuthStatus, dns_ok: bool }`.
- In `src-tauri/src/speech.rs`, replace the per-call current-thread runtime in `transcribe_cloud` with one long-lived runtime (`static CLOUD_RT: OnceLock<tokio::runtime::Runtime>`, multi-thread, 1 worker), so keep-alive connections survive between dictations.
- Add a Tauri command `dictation_cloud_warm` that runs `cloud::warm()` on that runtime and returns `{ clientReady, signedIn, dnsOk }` (no token, no email). Register it next to the other dictation commands.
- Tests: the client is a singleton (two calls return the same pointer, `std::ptr::eq` on the `&'static`); `warm()` with no auth file returns `signedIn: false` without panicking; existing cloud tests still pass.
- The UI call (at boot, only when the engine is cloud or automatic and consent is given) is the Director's; just add the command and a typed wrapper in `apps/desktop/src/tauri.ts` (`dictationCloudWarm(): Promise<{ clientReady: boolean; signedIn: boolean; dnsOk: boolean }>`), following the existing wrappers there.

## Gates (run them; paste the summaries into the report)

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` (report pre-existing warnings separately, do not fix unrelated code)
- Desktop crate: `cargo test -p bloblex-desktop --lib` (if it cannot build from this path, say so; do not work around it).
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote`

Set `CARGO_TARGET_DIR` to the path the brief gives you so dependencies are reused.

## Report

Write `docs/history/fix-33/report.md`: what changed per item (file:function), tests added, gate output summaries, anything not done and why, anything you were unsure of. Keep it factual; separate "verified by a test" from "not verified".
