# FIX39 P13 report — fixes found by the real-CLI tests

Implementer: OpenCode `opencode-go/deepseek-v4.1-flash` (high), branch `lane/fix39-p13`,
worktree `C:\fx93`, Cargo target `C:/fxt/c2`.
Package defined by `docs/FIX39_DECISIONS.md` §"P13: fixes found by the real-CLI tests";
evidence in `docs/FIX39_P11_REPORT.md` (Findings 1 and 3) and the follow-up live results.

Two fixes, both proven by the P11 live suite and by offline tests that fail on the old code.

## Fix 1 — Claude: a conversation's permission change mid-session now works

### Root cause (found by probing the real CLI, `claude 2.1.302`)

The Claude adapter already relaunched the process and passed `--resume` when the launch
options changed (`bloblex-adapter-claude/src/lib.rs:1174`), but `start` blocked for up to
eight seconds waiting for `system/init` before writing anything to the resumed process
(`lib.rs:948-972`). Claude Code emits `system/init` **only once a turn's input arrives**, so a
valid resume is silent and the wait timed out; the adapter then wrapped the failure as
`Unsupported("Claude could not resume after changing approvalMode: …")`, which the daemon
classes as `config_unsupported`. The same silent wait also affected every daemon-restart
resume (`resume_session`), where it silently fell back to a fresh provider context.

Probed directly against the installed CLI:

- valid `--resume` with no input for 8 s → **no output at all**;
- valid `--resume`, one user message → `system/init` about 1.3 s later;
- missing session id → `result error_during_execution` ("No conversation found with session
  ID: …") about 1.1 s later, even before any prompt;
- valid `--resume`, a `get_context_usage` control request only → a `control_response`
  about 2.1 s later.

### What changed

- `crates/bloblex-adapter-claude/src/lib.rs:837-959` — on a resume, `start` now sends a
  single `get_context_usage` control request with a `bloblex-resume-<uuid>` id and treats
  its `control_response` (or a `system/init`) as proof the session is alive; the
  resume-rejected `result` is still returned as `ResumeRejected`; the eight-second bound
  stays as the timeout. The probe uses its own request-id prefix so it is not swallowed by
  the `bloblex-context-` interception (`lib.rs:851`).
- `crates/bloblex-daemon/src/main.rs:3191` — the daemon's in-turn relaunch (step 4 of
  `run_turn`) now covers **Claude as well as Codex**, and goes through the existing
  `resume_or_start_fresh` (`main.rs:2143`). When the resume fails, this starts a fresh
  provider session and, for a context that had delivered prompts, the daemon arms P6's
  one-off recap (`main.rs:3249`, `knowledge::announce_context_loss`) **before** the
  prompt is built (`main.rs:3289`), so the fallback prompt carries the recap instead of a
  `config_unsupported` error. A successful resume keeps the provider context and no recap.

### Tests that prove it (fail on today's code)

- `crates/bloblex-daemon/src/main.rs:5623` `p13_claude_permission_change_relaunches_and_resumes_the_same_session`
  — a live Claude session (process running, launched on `Ask`) gets a changed mode
  (`Auto`); asserts the adapter's `resume_session` is called once, `new_session` not at
  all, and the prompt is delivered without a recap.
- `crates/bloblex-daemon/src/main.rs:5640` `p13_claude_permission_change_falls_back_to_the_recap_when_resume_fails`
  — same setup with a rejected resume; asserts a fresh session starts, exactly one
  `context_reset` notice, and this prompt contains `<bloblex_recap>` with the last user
  message (never stored).
  Both tests were run against the **old** codex-only condition and fail there
  (`resume_calls == 0`), so they are genuine failing-first tests.
- `crates/bloblex-adapter-claude/tests/lifecycle.rs:637` `changed_mode_resumes_a_silent_session_without_waiting_for_init`
  — offline, through the real adapter using a new fake mode `--fake-lazy-resume-init`
  (`crates/bloblex-adapter-claude/src/bin/fake_claude.rs:63-71` and `:84`) that mimics the
  real CLI: a resumed process stays silent until woken but answers `get_context_usage`.
  Without the probe the test fails with exactly the recorded error
  (`Unsupported("Claude could not resume after changing approvalMode: …")`); with it the
  changed-mode turn completes and the audit shows `--resume`.

## Fix 2 — the steer gate is open per provider capability, routed by the P9 setting

### What changed

- `crates/bloblex-daemon/src/main.rs:1802` `gate_default` now returns true for `steer`
  wherever `provider_can_steer` (`main.rs:1815`) says the adapter can steer (Codex today).
  The stored `exec_gate.<provider>.steer` value stays the off-switch.
- `runtime_capabilities` reports `settings.steer` from the same predicate
  (`main.rs:1879-1882`), and `session_steer` (`main.rs:3339`) refuses only providers whose
  adapter cannot steer — no longer a hard-coded `codex` string.
- Routing by the P9 setting is unchanged and already correct: the composer uses
  `composer.busySendMode` (`apps/desktop/src/ui/busySend.ts`) and falls back to Queue with
  the honest line when `runtime.capabilities` reports steer unsupported.
- `crates/bloblex-storage/src/lib.rs:88` seeds `exec_gate.codex.steer = true`, and a new
  one-time, idempotent migration `ensure_steer_gate_open` (`lib.rs:580`, called from every
  existing-database migration path) opens a previously seeded `false` once — matching the
  `exec_gate.opencode.thinking` precedent — so the owner's existing database is fixed too.
- `apps/desktop/src/preview/fixtureBridge.ts:683,808` — the preview daemon now treats the
  Codex steer gate as open unless explicitly set false, matching the real daemon.

### Tests that prove it (fail on today's code)

- `crates/bloblex-daemon/src/main.rs` `runtime_capabilities_report_steer_evidence_none_and_follow_the_gate`
  — Codex steer is `enabled: true` by default, `false` after an explicit off, back to true.
- `crates/bloblex-daemon/src/main.rs` `steer_requires_the_gate_codex_and_an_active_turn`
  — the gate accepts only a JSON boolean, an idle turn is the only refusal at the default,
  and setting the gate false still yields "Steering is turned off for this runtime.".
- `steer_is_unsupported_for_other_runtimes_and_side_conversations` still proves Claude and
  OpenCode keep the honest Queue fallback.
- `crates/bloblex-storage/src/lib.rs:5672` `steer_gate_migration_opens_a_seeded_closed_gate_once`
  and `:5686` `a_new_database_seeds_the_steer_gate_open`.
- `crates/bloblex-daemon/tests/live_cli.rs:585-610` — the always-on summary check now
  requires a started, unlimited provider's `permissionChange == "completed"` and, for
  Codex, that `steer` is not `"unsupported"` (other providers must loop back to Queue).

## Live results (P11 suite, `--test-threads=1`)

| provider | adapter live | offline | daemon path |
|---|---|---|---|
| claude | pass; permission change **completed**, steer `Unsupported` (honest fallback) | 1 replayed transcript + new lifecycle test | start/turn/model/second turn/queue/**permission `completed`**/resume pass; model `claude-haiku-5-5` |
| codex | steer `Accepted`; two-turn a **reported usage-limit skip** (`usageLimitExceeded`, "try again at 11:55 PM") | 2 replayed transcripts | reported limit skip (`limitOrUnavailable: "reported"`) — quota still exhausted |
| opencode | pass; permission change between turns completed | 1 replayed transcript | all scenarios pass; `permissionChange: "completed"` |

Models used: `claude-haiku-5-5` medium, `gpt-6-luna` medium, `opencode/deepseek-v4.1-flash-free`.

Only one fixture changed: `daemon-claude.json` now records `permissionChange: "completed"`
(was `error:config-unsupported`). The live runs re-produced `daemon-codex.json` (still a
reported limit skip) and `daemon-opencode.json` byte-for-byte, so both were left as
committed; no adapter wire transcript was re-recorded. Masking is unchanged (no hostname,
user name or user paths).

## Gates (final tree)

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — **all targets ok, 0 failed** (48 `test result: ok` lines; live tests skip without
  `BITBOTS_LIVE_TESTS=1`).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — **clean**.
- UI: `npx tsc -b` clean; `npx vitest run --maxWorkers=3` — **174 files / 1288 tests, all
  passed**; `npm run build` succeeded. The remote app was not touched, so `build:remote`
  was not run.

## Cannot check

- Visual behaviour (no UI beyond the preview fixture).
- One clean live reproduction of the **fallback** branch (resume genuinely rejected against
  a real account) was not produced; it is covered offline by the two daemon tests and the
  fake-based lifecycle test. A Codex quota-limited account still blocks the Codex daemon
  row (reported skip), so the Codex daemon steer scenario is unproven live; the Codex
  adapter's own steer returned `Accepted` in the live adapter suite.

## Files outside the package list that were touched

- `crates/bloblex-storage/src/lib.rs` — the gate seed (`:88`) and the one-time
  `ensure_steer_gate_open` migration (`:580`). The package line for P13 names "the steer
  routing"; the seed and its migration are required for the gate default, and the codebase
  precedent for opening such a gate lives in this file.
- `apps/desktop/src/preview/fixtureBridge.ts` — keeps the preview daemon's steer capability
  in line with the real daemon. Not production.
- `crates/bloblex-adapter-claude/src/bin/fake_claude.rs` and `tests/lifecycle.rs`, and
  `crates/bloblex-daemon/tests/live_cli.rs` — test-only.
- `apps/desktop/src/remote/tiers.json` was **not** changed: P13 adds no daemon method or
  event, so the parity test is unaffected.
