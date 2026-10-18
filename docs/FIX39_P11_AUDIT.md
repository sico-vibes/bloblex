# FIX39 P11 audit — reliability tests against the real CLIs

Auditor: Claude Sonnet 5.5. Worktree `C:\fx87`, branch `lane/fix39-p11`. Read: `AGENTS.md`, `docs/FIX39_DECISIONS.md` (P11), `docs/FIX39_P11_REPORT.md`, the diff and all new files. I did not re-run the gates; the report's results are plausible and nothing in it looked doubtful.

## Verdict: **FAIL** (goes back to Sol; the structure is sound, but three decision/rule breaches need fixes and a re-record)

The two-layer design (recorder → offline replay through the real adapters, plus a gated daemon-path suite) is what the decision asked for, and no production code changed. Three things break the decision's rules, though:

1. The Claude and Codex fixtures were recorded on the **expensive default models**, not the cheapest ones the decision names.
2. The Codex fixtures contain the **machine's hostname**, which the "no personal paths or secrets" rule forbids.
3. The "model report" scenario is **not asserted anywhere**, so the replay test cannot fail if model reporting breaks.

Findings are ordered by severity.

## Must fix

### 1. Claude and Codex adapter live runs use the default model, not the cheapest (decision breach, burns tokens)
- `crates/bloblex-adapter-claude/tests/live/mod.rs:217` and `:241` and `crates/bloblex-adapter-codex/tests/live/mod.rs:212` use `ExecOptions::default()`. Only the ACP suite pins a model (`bloblex-adapter-acp/tests/live/mod.rs:27,196-201`).
- The recorded fixtures prove the consequence: `claude-two-turn.ndjson` runs on `claude-opus-5-5` (lines 4, 5, 7, …) and `codex-two-turn.ndjson` on `gpt-6.1-sol` (line 8). The decision says `claude-haiku-5-5` at medium effort and `gpt-6-luna` at medium.
- **Fix:** put the model and thinking level in `ExecOptions` for the Claude and Codex `two_turn`, the permission tests and `live_runtime_with` (the same way the ACP suite builds `options()`), then re-record `claude-two-turn.ndjson` and `codex-two-turn.ndjson`. Check that the replay fixtures' `model` is `claude-haiku-5-5` / `gpt-6-luna` before handing back.
- The permission/steer live tests use `ExecOptions { approval_mode, ..default() }` (claude `:391,404`) and spend on the default model too. Give them the same cheap model.

### 2. Machine hostname committed in the Codex fixtures (rule breach: "fixtures contain no personal paths or secrets")
- `codex-two-turn.ndjson:4` and `codex-usage-limit.ndjson:4` carry `"serverName":"DESKTOP-PUF7IHB"` in a `remoteControl/status/changed` frame. The wire masking does not catch it.
- **Fix:** mask `serverName` (and any other host-identifying key) in the shared `wire_replay.rs` masking (all three copies, kept byte-identical), or drop that frame. Re-record or rewrite both Codex fixtures, then grep every fixture for the hostname, the Windows user name and `C:\Users`.
- Lower priority, same pass: the Claude fixture records the owner's connected MCP server (`claude.ai Claude Docs`, lines 5 and 21) and the Codex fixtures record `account/updated` with `planType` and live rate-limit usage (`codex-two-turn.ndjson:7,32,46`). These are not secrets, but they describe the owner's account and setup. Masking `mcp_servers[].name`, `planType` and `usedPercent` or `resetsAt` is cheap and safer for a repo that may go public.

### 3. The model-report scenario is not asserted (test proves less than claimed)
- `collect_turn` stores `turn.model` (claude `:270-279`, same in codex and acp), but `assert_two_turn` (claude `:294-311`, codex `:288`, acp `:291-308`) never reads it. The report says the suite asserts "the model the provider reports" (`FIX39_P11_REPORT.md:42-46`); it does not. If the adapter stopped emitting `UsageReport.model` / `ContextUpdated.model`, the replay gate would still pass.
- **Fix:** in `assert_two_turn`, require that at least one turn (preferably the first) has `model: Some(non-empty)`. If a provider genuinely reports no model on the wire, assert that fact explicitly for it, with a comment, rather than silently skipping.

### 4. The permission-mode and steer live tests assert nothing
- claude `:415-418`, acp `:411-414`, and the codex equivalent assert `turn.completed || turn.error.is_some()`. `collect_turn` only returns on `TurnCompleted` or `Error`, so this is always true. The steer result is only `eprintln!`-ed (claude `:428`).
- The decision asks for a permission-mode change and a steer or queue that "work or are cleanly reported". Make the test record the outcome and assert something that can fail: for example, assert that a second turn issued after the mode change either completes or returns an `Error` whose message is non-empty and not a panic/protocol failure, and assert that `steer` returns a typed result (`Accepted` / `Unsupported`) and not a transport error. Better: also change the mode **between** turns (the tests currently set Ask in `new_session` and Auto in the prompt, not a mid-session change).

### 5. Daemon-path suite records but does not guard; the Codex daemon row is empty
- `daemon-codex.json` shows `turn: "error:provider-error"` and everything after it `not-run` (queue, steer, permission, resume, second turn). The decision's Codex scenarios are therefore **unproven through the daemon**, and the report admits it (Finding 2). The adapter-level Codex run does not cover resume-after-restart, queue or permission change.
- `daemon_live_summaries_are_present_and_sanitised` (`live_cli.rs:497`) only checks that keys exist and that no forbidden key or path appears. It will pass on a summary that records every scenario as failed. It cannot catch a regression, so the daemon layer is documentation, not a guard.
- **Fix:** (a) re-record the Codex daemon row once the quota is back and keep the run honest: if it still reports a limit, the summary must say `limitOrUnavailable: "reported"` rather than `provider-error`. Today a plain `provider_error` is recorded as a quiet pass; treat an unclassified first-turn error as a failure of the live test, and only a recognised limit/unavailable class as a skip. (b) In the sanitised-summary test, assert that for each provider whose `start` is `true` and `limitOrUnavailable` is `"none"`, `turn` is `true` (or an explicitly accepted reported state), so a recorded regression fails the gate.

## Should fix (small)

6. **Skip classifier is too broad.** `is_reported_limit` (claude `:175-192`, identical in codex `:174`, acp, and daemon `live_cli.rs:113`) treats `unauthor`, `authentication`, `unavailable`, `overloaded`, `not signed in` and any `429` substring as a "reported skip". The decision names only a usage limit or an unavailable answer. A genuine auth regression in the adapter (for example the adapter dropping a credential it should pass) would be reported as a skip and never fail. Narrow it to usage limit, rate limit, quota, overloaded and `429`, and keep auth failures as failures (or report them separately). The four copies are also duplicated; keep them in sync if you edit.
7. **A failed re-record overwrites a good fixture.** The recorder truncates the target at start (`wire_replay.rs` `init_inner`), so a live run that fails for a non-limit reason leaves a bad `*-two-turn.ndjson` in place of the good one; a limited run renames over `<provider>-usage-limit.ndjson` (claude `:355-358`, acp `:352-354`). Record to a scratch name and promote to the final name only after `assert_two_turn` passes (and only move to the limit name on a recognised limit).
8. **Misleading panic text.** `next_event` says "within five minutes" while the timeout is 120 s (claude `:195-197`, same in codex `:193` and acp). Fix the text or the value.
9. **Limit-fixture coverage is lopsided.** Only Codex has a usage-limit fixture. The decision says a limit must turn into a clean reported state "per provider". At least note in the docs that Claude and OpenCode limit fixtures are unrecorded; the replay tests already skip them silently when absent, so a missing fixture is invisible in the gate output beyond one `eprintln!`.
10. **Gate coverage of new test code.** The report's clippy run is `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`, which does not lint test targets, so the new `tests/live*` files were not linted. Run `cargo clippy -p bloblex-adapter-claude -p bloblex-adapter-codex -p bloblex-adapter-acp --tests -- -D warnings` and fix what it reports in the new files (the `parent_watchdog.rs` warning in the daemon is pre-existing and can stay).

## Checked and fine

- **No production code changed.** The only edits to existing code are the additive `init_live` / `init_inner` in the three `wire_replay.rs` copies (byte-identical, `#[allow(dead_code)]`, `init` behaviour unchanged) and test-only `[[bin]]` entries with `test = false`, `bench = false`. `apps/desktop/src/remote/tiers.json` is untouched; no daemon method or event was added, so Remote tiers need no new rows.
- **Recorder** (`claude_cli_recorder.rs`): forwards lines unchanged both ways, never reads credentials, `stderr` is inherited, exit code is propagated. Non-JSON lines are forwarded but unrecorded, which is fine.
- **Bitbots data stays in temp folders.** Adapter tests use `std::env::temp_dir()` roots that are removed on drop. The daemon suite sets `BLOBLEX_DB_PATH` into a fresh temp folder, and `main.rs:4101-4112` derives the data dir from that path's parent, so it does not touch the owner's real Bitbots data. The daemon loopback token is never written to the summary.
- **Daemon summaries** hold only enums/booleans and the model id; no prompts, ids or paths. `daemon-claude.json` and `daemon-opencode.json` show the full scenario set passing, with the Claude permission-mode change honestly recorded as `error:config-unsupported`.
- **Windows:** `where.exe` resolution of the `.cmd` shims is correct and `live_cli.rs` is `#![cfg(windows)]`.
- **Gating:** live tests skip without `BITBOTS_LIVE_TESTS=1`; the offline replays always run. The abandoned daemon `mod.rs`/`*.ndjson` files the report mentions are gone from the worktree (`crates/bloblex-daemon/tests/live/` holds only `fixtures/`).
- **Security/visual rules:** no credentials, tokens, conversation text beyond the two fixed test prompts, or command text in fixtures or logs (apart from the hostname in finding 2); no UI touched.

## Scope notes for the Director

- `docs/FIX39_DECISIONS.md` and `docs/FIX39_AUDIT_IMPL_BRIEF.md` show as modified in this worktree but are not in the report's file list. The `DECISIONS.md` change (line 128) rewrites a P11 rule from "temporary data folders, never the owner's real `~/.claude`, `~/.codex`" to "normal installed sign-in, read-only". That reads as an owner/Director amendment to match what the tests need, not Sol's. Please confirm it is the owner's edit before merge; the implementation does follow the amended rule.
- Hot files (`App.tsx`, `TeamSidebar.tsx`, `main.rs`, `team.rs`, `storage/lib.rs`) are not touched.

## Needed from Sol before re-audit

1. Pin the cheap models in the Claude and Codex live tests; re-record both two-turn fixtures (finding 1).
2. Mask the hostname (and ideally account/MCP details); re-record or rewrite the Codex fixtures; grep all fixtures clean (finding 2).
3. Assert the model report in `assert_two_turn` in all three suites (finding 3).
4. Make the permission/steer tests assert something that can fail (finding 4).
5. Re-record the Codex daemon row; tighten the sanitised-summary test (finding 5).
6. Items 6-10 as time allows; items 6 and 7 are quick.


## Re-check (Sonnet), verbatim

The auditor re-checked the follow-up and replied:

PASS

All ten findings are closed. I re-read the code and fixtures and did not re-run the gates. I take the report's gate results as given.

- **1. Cheap models:** The Claude and Codex suites pin `claude-haiku-5-5`/medium and `gpt-6-luna`/medium through `options()`. ACP keeps `opencode/deepseek-v4.1-flash-free`. No Claude or Codex fixture names a default model any more. The opencode fixture mentions `claude-*` and `gpt-6.1-sol` only inside the provider's model catalogue listing (lines 6 and 9), which is public data.
- **2. Masking:** My greps for `DESKTOP-PUF7IHB`, `Sico`, `Vibes`, `C:\Users`, `C:/Users`, `AppData`, `USERPROFILE` and `Claude Docs` across `crates/*/tests/live/**` return nothing. `serverName`, `planType`, `cwd`, the MCP server `name` and `resetsAt` all read `<masked>` or `<masked-path>`. `mcpTools` is `[]`. All three `wire_replay.rs` copies have the same md5, `5fe1ebb019ef36caedd07c4baaa73eb5`.
- **3. Model report:** `assert_two_turn` now requires a non-empty model in all three suites (claude `:329`, codex `:323`, acp `:313`).
- **4. Permission and steer tests:** They now assert on the outcome. The mode is changed between turns, and an unsupported steer or rejected change must carry a non-empty message.
- **5. Daemon suite:** Codex is recorded as `limitOrUnavailable: "reported"`. An unclassified first-turn error panics (`live_cli.rs:388`). The sanitised-summary test requires `turn`, `modelReported` and `secondTurn` to be true for any started provider that did not report a limit (`:565-584`).
- **6. Skip classifier:** The auth terms are gone from the classifier (claude `:197-210`). The report says all four copies were narrowed; I read only the Claude one in full.
- **7. Scratch recording:** Each suite records to `*.recording.ndjson` first (claude `:101`, codex `:97`, acp `:96`).
- **8. Timeout text:** It now says "two minutes", matching the 120 s value.
- **9. Limit fixtures:** Only Codex has one, and the report says so.
- **10. Clippy:** The report says it is clean on the test targets.

**Not blocking:**
- The report states that `codex-two-turn.ndjson` is a rewrite of a real capture, not a fresh recording, because the account is out of quota. The merge notes should say so, and it should be re-recorded when quota returns.
- `docs/FIX39_DECISIONS.md` (line 128) and `docs/FIX39_AUDIT_IMPL_BRIEF.md` still show as modified in this worktree, and the report says the `DECISIONS.md` edit is not the implementer's. The Director should confirm they come from the owner before merging.
- The Claude fixture keeps rate-limit utilisation figures (0.82, 0.1) and `org_level_disabled`. They identify nobody, so I would leave them.

Must-fix items remaining: none.
