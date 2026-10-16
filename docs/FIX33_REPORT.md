# FIX33 (WP7) report — small backend items from the owner review

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort. Worktree `C:\fx40`, branch
`lane/fix33-wp7`. Spec: `docs/FIX33_SMALL_BACKEND_SPEC.md`. No `git commit`, no push, no UI
components or CSS touched, `AGENTS.md` untouched.

`CARGO_TARGET_DIR=C:/Users/Sico Vibes/Desktop/DevCN/bloblex/target` and
`RUST_MIN_STACK=33554432` were left as given.

---

## 1. `runtime.capabilities` tolerates a bot on another runtime

**Files.** `crates/bloblex-daemon/src/main.rs`

- `capability_selected_model` (around `main.rs:1535`): the agent's saved model is now used only
  when `agent["runtimeId"] == runtime_id`. A stale `agentId` no longer pulls another runtime's
  model into the effort-in-scope decision.
- `runtime_capabilities` (around `main.rs:1566`): a runtime mismatch is no longer an error. When
  the named bot's saved `runtimeId` differs from the `runtimeId` parameter, the handler reports
  `"agentConcurrency": null` and adds `"agentRuntimeMismatch": true` to the result. The bot is
  not listed in `agentConcurrencies` (that list only appears when no `agentId` is given).
  A missing bot still maps through `agent_error` to `not_found`; a non-string `agentId` still
  returns `invalid_argument`. `agentRuntimeMismatch` is only present when the mismatch is real,
  so the shape is unchanged for every other caller.

**Tests.** Added `phase2a_tests::runtime_capabilities_tolerates_agent_on_another_runtime`
(`main.rs:5185`):
- a bot saved on `rt-opencode` asked about through `rt-test` answers without an error,
  `agentConcurrency` is `null`, `agentRuntimeMismatch` is `true`;
- `capability_selected_model(..., "rt-test")` returns `None` for that bot (its saved model is
  ignored);
- on its own runtime the same bot still reports `configuredMaxConcurrency`;
- a valid-but-absent agent id is `not_found`, `agentId: 7` is `invalid_argument`.

No existing test asserted the old `agentId does not belong to runtimeId` error, so none needed
updating (grep confirms the string is gone from the daemon). Verified by test.

## 2. The model-facing noun is always "bot"

**Files.** `crates/bloblex-daemon/src/team.rs`, plus call sites in `automations.rs`, `memory.rs`,
`main.rs`.

- `team::entity_noun(plural: bool)` (`team.rs:83`) now always returns `bot` / `bots`; the
  `appearance.style` settings read is gone and the doc comment updated. The `st` parameter was
  removed, so the ~30 call sites were updated (`entity_noun(st, …)` → `entity_noun(…)`), and the
  test-only `team::mcp_tools_for_test` no longer takes an unused `st`.
- Test `team_prose_follows_the_appearance_style` was replaced by `team_prose_always_says_bot`
  (`main.rs:4142`). It sets `appearance.style = "blobots"`, then asserts `entity_noun(false) ==
  "bot"`, `entity_noun(true) == "bots"`, that the runtime instructions still say "a bot: one of
  the user's AI teammates", and that the instructions are byte-identical before and after the
  style change. Verified by test.

**Note for the report as requested:** the instruction text no longer changes with the look, so a
Blobots user's next turn re-sends instructions once (OpenCode respawns once). Expected.

## 3. New RPC `session.environment`

**Files.** `crates/bloblex-daemon/src/experiments.rs` (`git_command` made `pub(crate)`),
`crates/bloblex-daemon/src/main.rs` (dispatch arm + handler), `apps/desktop/src/remote/remoteTiers.ts`.

- Dispatch arm `"session.environment" => session_environment(st,&p).await` at `main.rs:868`
  (8-space indentation, so the remote parity parser sees it).
- `session_environment` (`main.rs:1642`): params `{ sessionId }`. `projectPath` comes from
  `st.db.session_detail(sessionId)["projectPath"]`; an unknown session maps to
  `not_found` ("session not found"); a missing/blank `sessionId` is `invalid_argument`.
- `git_rev_parse` (`main.rs:1659`) runs `git -C <path> <args>` **without a shell**, the path as a
  separate argument, via `tokio::process::Command::from(experiments::git_command())` with
  `kill_on_drop(true)`, stdin/stderr nulled, a piped stdout, and a 2 second
  `tokio::time::timeout`. A spawn failure, non-zero exit, timeout or empty output all yield
  `None`.
- `git_project_environment` (`main.rs:1671`): `git rev-parse --abbrev-ref HEAD`. Output `HEAD`
  means detached and then `git rev-parse --short HEAD` supplies the branch. Any non-answer
  (not a repo, no `git`, timeout, missing folder) becomes `gitRepo:false, branch:null,
  detached:false` — never an error.
- `environment_host` (`main.rs:1683`): `COMPUTERNAME`, else `HOSTNAME`, else `"This computer"`.
- Result `{ projectPath, gitRepo, branch, detached, host }`. Neither the path nor Git's output is
  logged.
- **Remote tier.** Added
  `{ method: 'session.environment', class: 'read', minTier: READ, why: 'Shows where a conversation works.' }`
  to `METHOD_RULES` in `remoteTiers.ts` (after `session.get`).

**Tests** (`main.rs`): `session_environment_reports_a_folder_that_is_not_a_repo`,
`session_environment_maps_an_unknown_session_and_missing_params`,
`session_environment_reports_a_git_branch` (uses a `git_is_available()` guard and returns early
when `git` is not on PATH). The git test covers: a temp dir after `git init` + one commit →
`gitRepo:true` with a non-empty branch name and `detached:false`; then a detached HEAD →
`detached:true` with the short hash as `branch`. Verified by test.

## 4. Cloud dictation warm-up (no request to the endpoint)

**Files.** `crates/bloblex-speech/src/cloud.rs`, `apps/desktop/src-tauri/src/speech.rs`,
`apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/tauri.ts`.

- `cloud.rs`: one shared `static CLIENT: OnceLock<reqwest::Client>` built once by
  `build_cloud_client()` (`cloud.rs:151`). The builder no longer takes or sets an overall
  timeout; `transcribe` sets the per-call budget with `RequestBuilder::timeout(self.timeout)`
  (`cloud.rs:915`), so the shared client has no fixed total budget but each request still keeps
  its 65 s default. Base-URL test injection is unchanged (tests build their own `CloudTranscriber`
  with `with_base_url`).
- `pub async fn warm() -> WarmReport` (`cloud.rs:1020`): builds/reuses the shared client (and its
  rustls config), calls `auth_status()` (reads the file, keeps no token) and resolves
  `chatgpt.com:443` with `tokio::net::lookup_host`. It returns
  `WarmReport { client_ready, auth, dns_ok }`. A client or DNS failure is reported, not raised.
  No request is sent to the endpoint.
- `speech.rs`: `transcribe_cloud` (`speech.rs:491`) now uses one long-lived
  `static CLOUD_RT: OnceLock<tokio::runtime::Runtime>` (multi-thread, 1 worker) through
  `cloud_runtime()`, replacing the per-call current-thread runtime, so keep-alive connections
  survive between dictations.
- `speech.rs`: new Tauri command
  `pub async fn dictation_cloud_warm() -> Result<Value, String>` (`speech.rs:511`) runs
  `cloud::warm()` on `CLOUD_RT` via `runtime.spawn(warm())` and returns
  `{ clientReady, signedIn, dnsOk }` through the pure `cloud_warm_payload` helper. It carries no
  token and no email. `signedIn` is true only for `AuthState::Ready | AuthState::ApiKey`.
- `lib.rs`: registered `speech::dictation_cloud_warm` next to the other dictation commands.
- `tauri.ts`: added
  `dictationCloudWarm(): Promise<{ clientReady: boolean; signedIn: boolean; dnsOk: boolean }>`
  following the existing wrappers (`false`/`false`/`false` outside the desktop).

**Tests.** `cloud.rs`: `cloud_client_is_a_shared_singleton` (`std::ptr::eq` on two `&'static`
calls), `warm_reports_status_without_contacting_the_endpoint` (asserts `client_ready`, reports
`Missing` when no auth file exists, never panics; bounded by a 20 s test-side timeout), and
`build_cloud_client_succeeds` updated to the no-argument builder. `speech.rs`:
`cloud_warm_payload_is_status_only` (a `Missing` auth maps to `signedIn:false`, a `Ready` auth to
`true`; the payload has no `token`/`email` key). The existing cloud tests, including
`slow_body_times_out_as_unavailable` (per-call timeout now on the request), still pass. Verified
by test for `cloud.rs`; `speech.rs` is **not** verified here (see the desktop gate gap below).

---

## Gates

All run from `C:\fx40`.

1. **`RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`**
   — exit 0. 43 test binaries, **530 passed, 0 failed**. Highlights: `bloblex-daemon` 161,
   `bloblex-storage` 92, `bloblex-speech` 58, adapter/acp suites 19/28/14/4, codex 13/33/5,
   claude 18/13/6, runtime 27, usage 19, agent-core 8, daemon_smoke 1.

2. **`cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`** — exit 0,
   `Finished`. **No warnings at all** (nothing pre-existing to report). Also ran
   `cargo clippy -p bloblex-daemon -p bloblex-speech --all-targets -- -D warnings` clean, so the
   new test code is warning-free too.

3. **`cargo test -p bloblex-desktop --lib`** — **cannot build from this worktree**, exit 101. The
   Tauri build script fails before compiling:
   `resource path 'binaries\bitbotsd-x86_64-pc-windows-msvc.exe' doesn't exist`
   (`tauri.conf.json` `externalBin` sidecar is a gitignored build artifact, not present here). Per
   the spec this was not worked around, so the `speech.rs` command and its unit test, and the
   `lib.rs` registration, are **not compiler-verified in this worktree**.

4. **`cd apps/desktop && npx tsc -b`** — exit 0, no output.

5. **`cd apps/desktop && npx vitest run src/remote`** — exit 0, 3 files, **47 passed, 0 failed**
   (includes `remoteTiers.parity.test.ts`, which now finds a tier row for `session.environment`).

An extra sanity check, `cargo check -p bloblex-daemon -p bloblex-speech --tests`, is clean.

## Not done / unsure

- **Desktop crate unverified.** `bloblex-desktop` cannot build in this worktree (missing sidecar),
  so `dictation_cloud_warm`, `cloud_warm_payload` and the command registration are only
  reasoned-through, not compiled. `cloud::warm` and the singleton do have passing tests in
  `bloblex-speech`.
- **Command name.** The plan (`robust-dazzling-taco.md` Part 3, line 110) calls it
  `speech_cloud_warm`; the FIX33 spec says `dictation_cloud_warm`. I followed the spec. The
  Director's boot call and `tauri.ts` wrapper must use `dictation_cloud_warm` /
  `dictationCloudWarm`.
- **`signedIn` semantics.** Treated `AuthState::Expired` as *not* signed in (only `Ready` and
  `ApiKey` are true). Flag if the UI wants expired-but-present to count.
- **`warm()` runs on `CLOUD_RT` via `runtime.spawn`, not `block_on`.** This keeps the async
  command from blocking Tauri's runtime while still running on the long-lived cloud runtime, as
  the spec asks. `transcribe_cloud` still uses `block_on` from its own worker thread.
- **`warm()` has no DNS timeout.** Only the tests bound it. A lookup failure is reported, not
  raised, but a hung resolver would delay the boot warm-up; the Director may want to call it
  off the critical path (it is opt-in and consent-gated anyway).
- **Docs left to the Director.** I did not edit `docs/ipc-contract.md` or
  `docs/remote/PROTOCOL.md`. `session.environment` and the new `agentRuntimeMismatch` field are
  not yet in the IPC contract; the remote tier table in `PROTOCOL.md` is generated and should be
  re-printed (`scripts/print-remote-tiers.mjs`).
- I reverted unrelated LF/CRLF churn in `apps/desktop/src-tauri/gen/schemas/*.json` produced as a
  side effect of running the Tauri build script; those generated files are back to their
  committed bytes.
