# FIX39 P11 report — reliability tests against the real CLIs

Implementer: OpenCode `opencode-go/deepseek-v4.1-flash` (high), branch `lane/fix39-p11`,
worktree `C:\fx87`, Cargo target `C:/fxt/a5`.
Package defined by `docs/FIX39_DECISIONS.md` §"P11: reliability tests against the real CLIs".
P11 touches **no production code**: only test-only binaries, test crates and fixtures.

## What was built

Two layers, as the decision asks.

1. **Adapter layer** — a test-only recorder proxies a real CLI, records a sanitised
   wire transcript, and an offline test replays that transcript through the **real
   adapter** on every gate (`fake-* --replay`, the existing wire-fixture player).
2. **Daemon layer** — a gated suite starts the real `bitbotsd`, which discovers the
   installed CLIs, and drives the decided scenarios over the authenticated loopback
   RPC, recording a sanitised summary per provider.

### 1. The recorder helper (test-only)

`crates/bloblex-adapter-{claude,codex,acp}/src/bin/{claude,codex,acp}_cli_recorder.rs`
(identical copies, the established `wire_support` copy pattern; `[[bin]]` `test = false`
added to each `Cargo.toml`).

- `main` (`claude_cli_recorder.rs:68`) parses `--provider/--version/--real/--record/--scenario`
  and forwards everything after `--` to the real CLI. It spawns the CLI with piped
  stdin/stdout, forwards each line unchanged in both directions, and records it through
  the shared `wire_replay` module (adapter→CLI as `in`, CLI→adapter as `out`).
- Only Bitbots' own data moves to temporary folders; the CLI keeps its own sign-in and
  is never read, copied or printed.
- `wire_replay::init_live` (in all three `src/bin/wire_support/wire_replay.rs`, line 70)
  records a header with `"synthesised": false` instead of `true`, so a real capture is
  distinguishable from a fake-synthesised fixture (the format anticipated this in
  `docs/evidence/wire-fixtures.md:88-90`). `init` is unchanged for the existing fixtures;
  the masking rules (`docs/evidence/wire-fixtures.md`) are reused unchanged.

### 2. Adapter live + replay suites

`crates/bloblex-adapter-{claude,codex,acp}/tests/live_suite.rs` (`mod live;`) and
`tests/live/mod.rs`.

- `two_turn` (claude:203, codex:200, acp:203) is the scenario both layers assert:
  start, a first turn, the model the provider reports, and a second turn in the same
  session. Assistant text is collected from `AssistantDelta` and `AssistantMessage`;
  the model from `UsageReport.model` / `ContextUpdated.model`.
- `assert_two_turn` (claude:294, codex:288, acp:291) asserts both turns completed with
  non-empty assistant text.
- `detect_cli` (claude:71, codex:67, acp:70) resolves the installed CLI through
  `where.exe`, because npm installs `opencode.cmd`/`codex.cmd` and a bare name does not
  reach a `.cmd` from `CreateProcess`.
- **Live (gated by `BITBOTS_LIVE_TESTS=1`)** — `claude_live_records_a_two_turn_transcript`
  (342), `claude_live_permission_change_and_steer_are_reported` (372); codex equivalents
  at 335/360; acp equivalents at 338/365. A turn whose raw provider error names a usage
  limit, rate limit, quota or unavailable account is printed as a **reported skip with
  the reset time**, never a failure (`Outcome::reported_skip`). A limited run is kept as
  `<provider>-usage-limit.ndjson` and a partial two-turn fixture is never left behind.
- **Offline (always runs)** — `*_replays_recorded_live_transcripts` (claude:315, codex:308,
  acp:311) replays each recorded transcript through the real adapter via `fake-* --replay`
  and asserts the same `assert_two_turn` outcome; a recorded limit transcript must replay
  as a clean reported terminal state. Missing fixtures skip with a message naming the
  live command, so the gate is honest about what has not been recorded yet.

### 3. Daemon-path suite

`crates/bloblex-daemon/tests/live_cli.rs`.

- `Daemon` (55) starts/stops `bitbotsd` with `BLOBLEX_DB_PATH` in a fresh temp folder and
  speaks the authenticated loopback RPC (the `daemon_smoke.rs` pattern).
- `run_provider` (242) waits for background discovery, creates a session on a temporary
  project folder, selects the decision's cheapest model through `session.model.update`
  (`claude-haiku-5-5`/medium, `gpt-6-luna`/medium, `opencode/deepseek-v4.1-flash-free`),
  then runs: turn + model report, second turn, steer or queue while working, a
  permission-mode change (`session.permissions.set`) + turn, and resume after a daemon
  restart on the same database. `await_turn` (160) reads `turn.completed`/`turn.error`
  and carries the daemon's redacted `failureClass`.
- `live_daemon_reliability_suite_records_a_sanitised_summary` (468) writes
  `tests/live/fixtures/daemon-<provider>.json`; a limit/unavailable/clean error is a
  recorded outcome, never a test failure.
- `daemon_live_summaries_are_present_and_sanitised` (497) always runs and fails if any
  recorded summary is missing its provider/scenario keys or contains a path, token, id,
  prompt or message field.

## Fixtures recorded from the live run (`BITBOTS_LIVE_TESTS=1`)

| file | source CLI | header | proves |
|---|---|---|---|
| `bloblex-adapter-claude/tests/live/fixtures/claude-two-turn.ndjson` | claude 2.1.302 | `synthesised:false` | `claude_replays_recorded_live_transcripts` |
| `bloblex-adapter-codex/tests/live/fixtures/codex-two-turn.ndjson` | codex-cli 0.162.1 | `synthesised:false` | `codex_replays_recorded_live_transcripts` |
| `bloblex-adapter-codex/tests/live/fixtures/codex-usage-limit.ndjson` | codex-cli 0.162.1 | `synthesised:false` | limit replays as a clean reported state |
| `bloblex-adapter-acp/tests/live/fixtures/opencode-two-turn.ndjson` | opencode 2.0.28 | `synthesised:false` | `opencode_replays_recorded_live_transcripts` |
| `bloblex-daemon/tests/live/fixtures/daemon-{claude,codex,opencode}.json` | live daemon |—| sanitised summary integrity |

All transcripts are sanitised by the existing recorder masking (volatile keys, UUIDs and
absolute paths replaced; the two turns' prompt and answer text remain, which is test
content). No credential, token or personal path appears in any fixture or summary.

### Live results (one pass, `--test-threads=1`)

| provider | adapter live | offline replay | daemon path |
|---|---|---|---|
| claude | pass (permission/steer reported; steer `Unsupported`) | 1 transcript replayed | start/turn/model/second turn/queue/resume pass; permission change reported `config-unsupported` |
| codex | pass after the 18:53 reset; the earlier run was a reported usage-limit skip ("try again at 6:53 PM") | 2 transcripts replayed | a first-turn `provider_error` (redacted) is reported cleanly — see Findings |
| opencode | pass (permission change reported) | 1 transcript replayed | all scenarios pass |

The Codex adapter transcript was recorded **after** the reset, so Codex is covered by the
offline replay today; the earlier run is preserved as the usage-limit fixture.

## Findings for the Director (not fixed: P11 changes no production code)

1. **Claude: changing a conversation's permission mode mid-session fails cleanly.**
   After `session.permissions.set` to `auto`, the next turn ended with
   `failureClass: config_unsupported` ("Requested execution settings were unsupported."),
   i.e. the adapter could not relaunch/resume with the changed launch options. Codex and
   OpenCode both completed the same scenario. The suite records the clean reported state
   (`daemon-claude.json: permissionChange = "error:config-unsupported"`).
2. **Codex daemon turns intermittently report `provider_error`.** After several live
   runs, the daemon-path first turn for `gpt-6-luna` reported a redacted `provider_error`
   while the adapter-level two-turn run on the same account still completed. This is most
   likely remaining account quota; the suite records it cleanly rather than failing. The
   Codex daemon row must be re-recorded once the account's quota has recovered.
3. **Steer is off in the daemon, on in the Codex adapter.** `session.steer` returns
   `unsupported` for every provider (the `exec_gate.*.steer` default is closed) and the
   suite confirms the queue fallback (`session.queue.add` queues). The Codex adapter's own
   `steer` returned `Accepted`. This is expected from the current gate defaults, recorded
   here so the routing decision is explicit.

## Gates (final tree)

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — **all targets ok, 0 failed** (new tests included; live tests skip without the env var).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — **clean**.
  (`cargo clippy --tests` on the daemon also reports a pre-existing
  `clippy::zombie-processes` in `tests/parent_watchdog.rs:14`; that is outside P11 and
  outside the specified gate.)
- UI: `npx tsc -b` clean; `npx vitest run --maxWorkers=3` — the full parallel run shows
  load-related flakiness only (`App.agent.mounted` / `App.slash.mounted`), and both files
  pass in isolation (`62/62`, `3/3`); P11 changes no TypeScript. `npm run build` succeeds.
- No remote change: P11 adds no daemon method or event, so `apps/desktop/src/remote/tiers.json`
  is untouched and the parity test is unaffected.

## Cannot check

- Visuals and remote/phone behaviour (none touched).
- The live suites need the installed CLIs and their normal sign-in; they are skipped in
  the normal gates by design and were run once here on 18 October 2026.
- The daemon-path Codex row needs a re-record once quota recovers (Finding 2).

## Files outside the package list that were touched

- `crates/bloblex-adapter-{claude,codex,acp}/src/bin/wire_support/wire_replay.rs` — the
  shared **test-only** recorder/replayer gained the additive `init_live` (and `init`
  delegates to `init_inner`). It is never compiled into a production adapter; the three
  copies remain byte-identical.
- `crates/bloblex-daemon/tests/live/mod.rs` and three `*-daemon.ndjson` transcripts were
  already present in this worktree at 18:23–18:32 (they are not referenced by any test
  target and duplicate this package's daemon suite). They were **moved, not deleted**, to
  `C:/fxt/a5/tmp/opencode/p11-abandoned-daemon-live/` so this worktree has one coherent
  P11 implementation. They are not part of this diff.

## Follow-up (audit) — 18 October 2026

The previous implementer ran out of usage part-way and the P11 audit returned **FAIL** with
findings 1–10 (`docs/FIX39_P11_AUDIT.md`). I finished the package against those findings.
The base report above is kept as history; this section records the follow-up work.

### Findings closed

1. **Cheap models pinned (finding 1).** `claude/tests/live/mod.rs` and
   `codex/tests/live/mod.rs` gained `MODEL`/`THINKING` and an `options()` helper
   (`claude-haiku-5-5`/medium, `gpt-6-luna`/medium) used by `two_turn` (start and both
   prompts), `live_runtime_with`, the Claude permission/steer test and the Codex steer
   test. The ACP suite keeps `opencode/deepseek-v4.1-flash-free`.
   - The Claude two-turn fixture was **re-recorded live**; its reported model is now
     `claude-haiku-5-5`.
   - Codex hit its usage limit on the re-record (`codexErrorInfo: usageLimitExceeded`,
     "try again at 11:55 PM"). The limit run is preserved as `codex-usage-limit.ndjson`
     (re-recorded, pinned model) and `codex-two-turn.ndjson` was **rewritten**: every
     `gpt-6.1-sol` became `gpt-6-luna`, and the inbound `thread/start`/`turn/start`
     frames gained `model: gpt-6-luna` / `effort: medium` so the replay matches what the
     adapter now sends. This is the rewrite the audit allows; it is a rewrite of a real
     capture, not a new capture, and is flagged here for the auditor.
   - The OpenCode two-turn fixture was **re-recorded live** (free model).

2. **Host/account masking (finding 2).** All three `wire_replay.rs` copies (kept
   byte-identical, md5 `5fe1ebb019ef36caedd07c4baaa73eb5`) gained a `PRIVATE_KEYS` list
   masked in **both** directions (`serverName`, `hostname`/`hostName`,
   `machineName`/`machineId`, `installationId`, `planType`, `usedPercent`, `resetsAt`),
   MCP `name` masking (`mcp_servers`, `mcpTools`, or any object carrying `serverName`), and
   `mcp__…` tool-name masking. `resetsAt` stays in `VOLATILE_KEYS` for `in` comparison.
   - Every fixture was re-recorded or rewritten with the new masking. Grep across all
     fixtures proves none remain: the hostname `DESKTOP-PUF7IHB`, the user `Sico`/`Sico
     Vibes`, and `C:\Users`/`C:/Users` all return zero. `serverName`, `planType`,
     `usedPercent` and `resetsAt` now read `<masked>`; the owner's MCP integration name
     (`claude.ai Claude Docs`, `mcp__claude_ai_Claude_Docs__*`) is gone.

3. **Model report asserted (finding 3).** `assert_two_turn` in all three suites now
   requires the first turn's reported model (`UsageReport.model` / `ContextUpdated.model`)
   to be non-empty. The daemon summary's `modelReported` now reads the provider-reported
   `contextModel` only (the old check also accepted any assistant text, so it could not
   fail).

4. **Permission/steer tests can fail (finding 4).** Claude and OpenCode now start on
   `Ask`, complete a first turn, change the mode **between** turns to `Auto`, and require
   the next turn to complete or report a non-empty, non-protocol reason (a protocol
   failure panics). Claude's steer must return `Ok`/`Unsupported(non-empty)` and panics on
   any other error; Codex's steer must return `Accepted`/`Stale`/`Unsupported(non-empty)`
   and panics otherwise, and its steered turn must complete (or be a reported limit).

5. **Daemon row and sanitised test (finding 5).** Codex is still limited, so its daemon
   row was re-recorded honestly as `limitOrUnavailable: "reported"` (no longer a quiet
   `provider-error`). An unclassified first-turn error in the daemon suite now panics;
   only a recognised limit/unavailable class is a skip (classification inspects the
   daemon's sanitised `detail`, which is never recorded or printed).
   `daemon_live_summaries_are_present_and_sanitised` now requires, for every summary
   whose `start` is true and `limitOrUnavailable` is not `reported`, that `turn`,
   `modelReported` and `secondTurn` are all true.

6. **Skip classifier narrowed (finding 6).** All four copies (Claude, Codex, OpenCode live
   and daemon `live_cli.rs`) drop `not signed in`, `not logged in`, `unauthor` and
   `authentication`; they keep usage/rate limit, quota, `429`, too many requests,
   unavailable and overloaded. An auth regression now fails the suite instead of skipping.

7. **Scratch recording (finding 7).** Each adapter records to
   `<provider>-<scenario>.recording.ndjson` and promotes to the real fixture name only
   after `assert_two_turn` passes; a limited run is moved to
   `<provider>-usage-limit.ndjson` only on a recognised limit. A failed run no longer
   overwrites a good fixture.

8. **Timeout text (finding 8).** "within five minutes" → "within two minutes" (the value
   is 120 s) in all three adapter suites.

9. **Limit-fixture coverage (finding 9).** Only Codex has a `*-usage-limit.ndjson`. The
   Claude and OpenCode limit fixtures are unrecorded; their replay tests skip with a
   message when the file is absent. Noted here as the audit asked.

10. **Clippy on tests (finding 10).** `cargo clippy -p bloblex-adapter-claude
    -p bloblex-adapter-codex -p bloblex-adapter-acp --tests -- -D warnings` is clean. The
    daemon's pre-existing `parent_watchdog` / `main.rs` test warnings remain, outside P11.

### Live results (follow-up, `--test-threads=1`)

| provider | adapter live | offline replay | daemon path |
|---|---|---|---|
| claude | pass; permission change reported `Unsupported` ("could not resume after changing approvalMode"); steer `Unsupported` | 1 transcript replayed (model `claude-haiku-5-5`) | start/turn/model/second turn/queue/resume pass; permission `error:config-unsupported` |
| codex | reported usage-limit skip (`usageLimitExceeded`); steer `Accepted` before the limit | 2 transcripts replayed (model `gpt-6-luna`) | reported limit skip (`limitOrUnavailable: "reported"`) — quota still exhausted |
| opencode | pass; permission change between turns completed | 1 transcript replayed | all scenarios pass |

### Gates (follow-up)

- `cargo test --workspace --exclude bloblex-desktop --no-fail-fast` — **all targets ok,
  0 failed** (live tests skip without `BITBOTS_LIVE_TESTS=1`).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — **clean**.
- `cargo clippy -p bloblex-adapter-{claude,codex,acp} --tests -- -D warnings` — **clean**.
- UI: `npx tsc -b` clean; `npx vitest run --maxWorkers=3` — 169 files / 1242 tests, all
  passed; `npm run build` succeeded. P11 changes no TypeScript, so `build:remote` was not
  run.

### Cannot check (follow-up)

- The Codex two-turn fixture is a rewrite, not a fresh capture, because the account is
  limited; it should be re-recorded when quota returns.
- The Codex daemon row and both Codex adapter rows reflect a limited account.

### Scope note

- `docs/FIX39_DECISIONS.md` still shows the pre-existing P11 rule edit at line 128 (the
  "normal installed sign-in, read-only" wording). It was already modified in this worktree
  when I started and is **not** my edit; the implementation follows the amended rule. The
  audit asked the Director to confirm this is the owner's change.
- I touched no production code and no `docs/` file other than this report.
