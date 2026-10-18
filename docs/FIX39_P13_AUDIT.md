# FIX39 P13 audit (Claude Sonnet 5.5)

**Verdict: PASS.** Two optional nits at the end; neither blocks the merge.

Scope audited: the working-tree diff in `C:\fx93` (branch `lane/fix39-p13`) against `docs/FIX39_DECISIONS.md` §P13, `docs/FIX39_P13_REPORT.md` and the P11 findings. I read the diff and the surrounding code (`activate_session`, `resume_or_start_fresh`, `run_turn`, `session_steer`, `runtime_capabilities`, the Claude reader loop). I did not rerun the gates; the report's results are consistent with the code and with the fixture change, so I did not find them doubtful.

## 1. Items done as specified

**Claude mid-session permission change (decision 1): done.**
- Root cause is plausible and addressed at the right level. The adapter already relaunched with `--resume`, but waited up to 8 s for a `system/init` that a resumed Claude only emits once a turn's input arrives. `start` now sends a `get_context_usage` control request with a `bloblex-resume-<uuid>` id and accepts its `control_response` (or an `init`) as proof of life (`crates/bloblex-adapter-claude/src/lib.rs:842-851`, `:878-887`, `:949-960`).
- The probe id deliberately does not start with `bloblex-context-`, so the existing interception at `lib.rs:~862` does not swallow it. I checked the ordering: the interception `continue`s only for `bloblex-context-` ids, so the probe reaches the `check_resume` branch.
- A rejected resume still wins (`resume_rejected_result` is tested first), so `ResumeRejected` keeps its meaning, and the 8 s timeout still ends in `ResumeFailed`.
- A failed probe write kills the process tree and returns `ResumeFailed`; this matches the existing timeout handling.
- Decision text asks for "relaunch with the new mode and resume the same provider session, with P6's recap as the fallback". `main.rs:3191` extends the in-turn relaunch from Codex to `codex | claude` and now goes through `resume_or_start_fresh`. On a fallback it forgets the catalogs and calls `announce_context_loss` before the prompt is built (`main.rs:3249-3254`), exactly as `activate_session` does (`main.rs:2387-2393`). A successful resume keeps the context and adds no recap.
- Provider-session id after a fallback: the in-turn branch does not call `set_session_provider_id` (the Codex branch never did). The new id is persisted by the existing session-id event handler (`main.rs:3705`), and `resume_or_start_fresh` has already cleared the stale id. Not a regression.

**Steer gate per provider capability (decision 2): done.**
- `gate_default` is open for `steer` wherever `provider_can_steer` is true (Codex only). `runtime_capabilities` and `session_steer` read the same predicate; the hard-coded `"codex"` string is gone from the refusal.
- Claude and OpenCode keep the honest `unsupported` → Queue fallback; the existing `steer_is_unsupported_for_other_runtimes_and_side_conversations` test still covers it.
- The stored `exec_gate.<provider>.steer` value stays the off-switch, and the settings validator still requires a JSON boolean (`main.rs:1342`).
- New databases seed the gate open (`storage/lib.rs:88`). The one-time migration `ensure_steer_gate_open` (`storage/lib.rs:~580`) opens a previously seeded `false`. It follows the `migration.opencodeEffortGateOpened` marker precedent and is wired into all five open/migrate paths.
- Routing by P9's Steer/Queue setting is unchanged and already falls back to Queue when the capability reports unsupported. I did not find a UI change that was needed.

**Codex daemon `provider_error` (decision 3): correctly not changed.** The report records it as a quota skip; the fixture is untouched.

## 2. Correctness

No bugs found. Points I checked:
- The relaunch removes the old session from `st.sessions` under the gate, closes it, and re-installs the new handle under the new gate. This is the existing Codex sequence. The only change is `resume_or_start_fresh` replacing the hand-written resume call.
- Windows: the changes involve no paths, quoting or process-spawn changes beyond the existing `process_tree.terminate()` on probe failure.
- Behaviour change worth knowing (not a defect): a Codex in-turn relaunch whose resume fails used to end in `provider_error`. It now starts a fresh provider session and carries the recap. This is what the decision describes for the fallback, and the activation path already behaves this way.
- `bypass_active` is emitted at prompt admission (`main.rs:3125`), before the relaunch, so a change to Bypass is still announced.

## 3. Tests prove it

- `p13_claude_permission_change_relaunches_and_resumes_the_same_session` and `..._falls_back_to_the_recap_when_resume_fails` (`main.rs:~5623-5655`) assert behaviour: the resume is called once, `new_session` is called 0 or 1 times, the recap appears only on a fallback, the context-reset notice appears once, and the recap is never stored. Both fail on the old `== "codex"` condition (no resume call), as the report states.
- `changed_mode_resumes_a_silent_session_without_waiting_for_init` (`adapter-claude/tests/lifecycle.rs:~637`) uses a fake mode that mimics the real CLI (silent resume, answers `get_context_usage`) and asserts the changed-mode turn completes and that `--resume` was used. It fails on the old code with the recorded `Unsupported(...)` error.
- The steer tests assert the default and the off-switch (`enabled` true/false with the "execution entry gate is disabled" reason; idle `conflict` at default; the off-message after an explicit `false`). The storage tests cover the migration marker (a later operator `false` survives a second run) and the new-database seed.
- `live_cli.rs:~584-608` now requires `permissionChange == "completed"` and the Codex `steer != "unsupported"` / other providers `== "unsupported"`. The `daemon-claude.json` fixture changed from `error:config-unsupported` to `completed` with the live run behind it. Nothing was weakened; the assertions were tightened.
- One accepted limit, which the report states: the fallback branch has no live reproduction, and the Codex daemon steer scenario is unproven live because the account is out of quota. The offline tests cover the first; the Codex adapter's own live steer returned `Accepted`.

## 4. Scope

Files touched: `adapter-claude` (`lib.rs`, `fake_claude.rs`, `tests/lifecycle.rs`), `daemon/main.rs`, `daemon/tests/live_cli.rs` and the `daemon-claude.json` fixture, `storage/lib.rs`, and `preview/fixtureBridge.ts`.
- `main.rs` and `storage/lib.rs` are hot files; the changes are small and localised (one condition, one helper, one seed value, one migration), and the report justifies the storage edit.
- `fixtureBridge.ts` is the preview daemon only, kept in line with the real gate (`=== false` instead of `!== true`).
- `docs/FIX39_AUDIT_IMPL_BRIEF.md` shows as modified in the worktree. It is not part of the package and not in Sol's report. It should not be committed with P13 unless the Director changed it on purpose.

## 5. Security rules

- No new daemon method or event, so `apps/desktop/src/remote/tiers.json` needs no row; `session.steer` already has its row (`tiers.json:250`) and the capability change does not widen it.
- The probe sends no conversation content, and no new log lines were added. The recap is built per prompt and never stored (asserted in the fallback test).
- Approvals are not bypassed: the mode still comes from `exec_options.approval_mode`, and the relaunch only changes the launch mode to the one the owner already chose.

## 6. Visual rules

No UI beyond the preview fixture; no icons, CSS or themes touched.

## Optional nits (no change required)

1. `main.rs:1879-1882`: `provider_can_steer("claude")`, `("opencode")` and `("")` in the capability table are constants today. Fine, but a short comment in `provider_can_steer` that adding a provider there also needs the capability row would help the next editor.
2. `storage/lib.rs:~5672`: the migration test runs `ensure_steer_gate_open` on a hand-built table. A test that opens a real file database seeded with `exec_gate.codex.steer=false` through `Storage::open` would prove that the wiring in all five paths runs. The unit test plus the five identical call sites make this low risk.
