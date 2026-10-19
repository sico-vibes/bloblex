# FIX39 P8 implementation audit (Claude Sonnet 5.5)

> **What this is:** Implementation audit of FIX39 package P8 by Claude Sonnet 5.5.
> **Status:** historical
> **Last updated:** 2026-10-18

**Verdict: PASS WITH FIXES.** Every item in the P8 decision is implemented and each has a daemon, storage or adapter test that would fail on the old code. There are two correctness fixes (F1, F2) and a few small ones. Nothing blocks the merge on security grounds. I read the full diff and the report and did not rerun the gates. The report's results look consistent with the diff.

## Item check against `docs/history/fix-39/decisions.md` (P8)

| Item | Status |
|---|---|
| Classify limits from Claude, Codex, OpenCode, with the reset time | Done. `recovery.rs` is shared. The three adapters emit `RecoveryHint { retry_after_secs }`. The daemon test `p8_provider_limits_are_durable_with_the_right_reset` covers all three. |
| "Limited until <time>" in transcript, sidebar, companion | Done. Transcript: daemon notice. Sidebar: `TeamSidebar.tsx:310`. Companion: `companionStatus.ts:42`. |
| Sweep resumes, on by default, Experimental toggle | Done. `retry::sweep_loop` runs once per second, and `resumeAfterUsageLimits` is validated in storage and defaults on in the UI. |
| Never loop on an expired or unknown window | Done. `lastLimitReset` is a watermark, `recovery_count < 3` bounds the chain, and a null reset leaves the session Limited with no due date. The sweep test covers the repeated old window and the unknown window. |
| Bounded transient retry, one owner, jittered backoff | Done, but only behind `experimental.autoRetry`, which is off by default (see N1). `watchdog_claim_turn` gives one owner per turn. The cap is 3. |
| Killed or crashed turn continues on next activation, with the P6 recap if resume failed | Done (`continue_on_activation`, `recover_after_restart`, test `p8_killed_turn_continues_on_activation_with_recap_after_resume_failure`). |
| One honest line, no pile of errors | Done. Turns marked `recoveryHandled` are hidden in `conversation.ts`, and a delegating bot is not told of a false failure. |
| Storage columns with a migration tested on a previous-version DB | Done. `ensure_queue_schema` adds the columns idempotently, and the test drops them and reopens. |
| `tiers.json` rows for new events | None needed. No new method or event was added, and `session.changed` and `turn.error` are already `allow`. The new fields (`limitedUntil`, `state`, `recoveryHandled`) carry no text. |

## Findings to fix

### F1. An `Error` event with no turn is now dropped silently (regression)

`crates/bloblex-daemon/src/main.rs:~3999-4008`, the `AgentEvent::Error` arm in `forward_events_with_timeouts`.

- **Problem.** The old arm always set the session state to `error` and emitted `turn.error`, whether or not a turn was watched. The new arm does its work only inside `if let Some(t) = turn.as_deref()` and then does `continue`. An adapter error that arrives while `turn` is `None` (for example between turns) now changes nothing and emits nothing. The user sees no failure, and the session state is left as it was.
- **Fix.** Add an `else` branch that keeps the old behaviour for the no-turn case: `update_session_state(&sid, "error")`, `session.changed` from `session_event_summary`, and `turn.error` with `turnId: null`, `failureClass`, `message` and `detail`. Add a test that sends `AgentEvent::Error` with no active turn and expects the `turn.error` event.

### F2. ACP can return `TurnErrorReported` without having emitted an `Error` event

`crates/bloblex-adapter-acp/src/lib.rs:~1218-1227`.

- **Problem.** `TurnErrorReported` is returned unconditionally, but the `AgentEvent::Error` is sent only `if had_active_turn`. When `had_active_turn` is false, `run_turn` (`main.rs:~3271`) returns early on `TurnErrorReported`, expecting the event stream to finish the turn, and no terminal event exists. The old code returned `Protocol` there, so the daemon finalized the turn. A turn can then be left in `working` with the session busy.
- **Fix.** Return `TurnErrorReported` only when the `Error` event was actually queued. Otherwise return `AdapterError::Protocol("OpenCode prompt failed")` as before. Add a test for the `!had_active_turn` path.

### F3. ACP sends a `RecoveryHint` before the cancellation check

`crates/bloblex-adapter-acp/src/lib.rs:~1208-1212`.

- **Problem.** The hint is sent first, and `was_cancelled` is checked afterwards. A cancelled turn leaves a stale `hint` in the turn data with no `Error` after it. It is harmless today, but it is a hidden coupling.
- **Fix.** Move the hint send after the `was_cancelled` early return, inside the `had_active_turn` branch and before the `Error`.

### F4. Settings label and aria-label disagree

`apps/desktop/src/ui/SettingsSheet.tsx:602-603`.

- **Problem.** The row was renamed "Longest retry delay" with a new hint, but the `Select` still has `ariaLabel="Longest wait for a rate limit"`. Screen readers and tests then hear a different name from the one shown.
- **Fix.** Make the aria-label match the visible label, and update any test that selects by the old text.

### F5. The sweep reads every session once per second

`crates/bloblex-daemon/src/retry.rs:~719-731`.

- **Problem.** `st.db.sessions()` runs the full session-list query, with project sub-selects and JSON extraction, every second just to find `state == 'limited'`.
- **Fix.** Add a small storage query, for example `watchdog_due_sessions(now)`, that selects `id` where `state='limited' AND limited_until IS NOT NULL AND limited_until<=?`. The sweep loop then iterates only those. `watchdog_enqueue` already re-checks the condition atomically, so correctness does not change.

### F6. Garbled doc comment

`crates/bloblex-daemon/src/retry.rs:~513-514` (`latest_blocked_reset`).

- **Problem.** There are two stacked, contradictory `///` lines ("snapshot once when it is missing or older…" followed by "Refresh an existing stale snapshot once; absence never launches a probe").
- **Fix.** Keep one accurate sentence.

### F7. Test coverage gaps (small)

- **Side and Queue-origin path.** `main.rs:2943` now lets `PromptOrigin::Queue` prompt a `side` conversation, and `retry.rs` now excludes `automation` instead of `side` from retry. Nothing tests a side session being retried or resumed through the queue. Add one test that a side session's watchdog item is sent, and one that a user cannot queue to it (`queue::add` still refuses `side`).
- **UI.** Nothing tests the sidebar "Limited" label (`sessionIsLimited`) or `applyEvent` taking `payload.state` from `turn.error`. `watchdog.test.ts` covers only the companion label, the toggle default and the hidden error row. Add a small test for each.
- **Weak assertion.** `experiments.test.ts` now filters out `resumeAfterUsageLimits` and checks the rest are false. That is fine, but it is still a test of the default table rather than behaviour. Keep it, but the mounted test is the behavioural check.

## Notes for the Director (decisions, not defects)

- **N1. Transient retry is off by default.** The bounded retry, the "Retrying (n of 3)…" line and the 3-attempt cap only apply when `experimental.autoRetry` is on, which stays off by default. With it off, a dropped stream or 5xx still surfaces as an ordinary error. The decision text can be read as wanting this always on. Please confirm with the owner. If so, the fix is a default-on setting plus the matching test and UI default.
- **N2. No quota probe when no snapshot exists.** `latest_blocked_reset` used to refresh a missing snapshot and now does not. Claude's result rarely carries a wait, so a first-ever limit with no stored snapshot lands as "Limited. The provider gave no new reset time" and asks the user. That matches "with no reset time, ask", but it is less helpful than before.
- **N3. Continuation is automatic on every non-turn activation.** After a restart, simply opening or warming a conversation that was working sends "Continue where you left off." with no extra toggle (bounded to 3). This matches the decision text, but it spends tokens without a click. It is worth a line in the release notes.
- **N4. Side conversations now retry.** Retry used to skip `side` links. It now skips only `automation`, and `Queue` origin may prompt a side conversation. This looks intended for delegated tasks, and the report does not call it out.
- **N5. The compact island label.** `rate_limited` was removed from `COMPANION_COMPACT_MOOD_LABELS`, so the island now shows the full "Limited until <local date and time>". The Director's visual pass should check that this fits in both looks and both themes.

## Scope, security, visual rules

- **Scope.** Files outside the package list (`agent-core` lib and Cargo, `adapter-acp` Cargo, `types.ts`, the mounted settings test, `App.tsx`) are justified in the report's section 4. The `App.tsx` change is one line, and `applyWindowSetting` now falls back to the experiment's default when the value is not a boolean. Stray scratch files were removed. `Cargo.lock` changes by two lines (the `chrono` additions). Hot files are touched only on the failure, turn-start and activation paths. `docs/history/fix-39/audit-impl-brief.md` shows as modified (line endings only), so do not commit that diff.
- **Security.** `retry.rs` and `recovery.rs` add no logging. Only turn ids, fixed continuation strings and a content-free hint are stored. The recap is never persisted, and the test asserts it. Approvals are untouched. The state `limited` blocks non-user prompts (`main.rs:2966`), and only a user prompt clears it. Remote: no new method or event, so the parity test is unaffected.
- **Visual.** The new strings use no star or sparkle icons. The changes are text only (label and mood). No new CSS was added, so both looks and themes are unaffected apart from N5.

## Windows

Nothing path-specific was added. The storage and daemon tests use `std::env::temp_dir()` and clean up. The report's note that `cargo fmt --check` fails across the whole repository is believable in this checkout, but the new daemon code (`retry.rs`, `main.rs`) is written as dense one-line statements that will fail rustfmt. Run `rustfmt` on the touched hunks only, if the Director wants them tidy.


## Re-check (Sonnet), verbatim

The auditor re-checked the follow-up and replied:

PASS

I read the follow-up against F1–F7 and the diff. I did not rerun the gates, so the report's results (all suites green, clippy clean, 1256 UI tests) are unchecked by me.

- **F1: fixed.** `main.rs:4008-4016` now has an `else` branch for the no-turn case. It sets the session to `error`, drops the active turn, emits `session.changed`, and emits `turn.error` with `turnId: null`. `provider_error_without_a_watched_turn_still_reports_once` (`main.rs:6295`) covers it, and the report says it failed with the `else` body disabled.
- **F2: fixed.** `failed_prompt_terminal(had_active_turn)` (`lib.rs:912`) returns `TurnErrorReported` only when the `Error` was queued (`lib.rs:1238`). With no active turn it returns `Protocol` (`lib.rs:1242`), so the daemon finalizes the turn. The test (`lib.rs:1413`) exercises that helper, not the live `prompt` transport. The helper is the only source of the error at both call sites, so I accept that.
- **F3: fixed.** The hint is sent after the `was_cancelled` return, inside the `had_active_turn` branch and before the `Error` (`lib.rs:1226-1233`).
- **F4: fixed.** The aria-label now reads "Longest retry delay" (`SettingsSheet.tsx:603`).
- **F5: fixed.** `watchdog_due_sessions` (`storage lib.rs:2712`) selects only due, unarchived limited sessions. `retry.rs:721` iterates only those ids, and the test is at `storage lib.rs:7972`.
- **F6: fixed.** `retry.rs:513-514` is now one sentence.
- **F7: fixed.** The side-session tests are at `main.rs:8308` and `main.rs:8325`. `teamSelectors.test.ts:154` covers the sidebar label and `types.test.ts:171` covers `turn.error` state and `recoveryHandled`.

No must-fix items remain.

Optional, small: the new `else` branch in F1 (`main.rs:4008-4016`) skips `team::after_turn`, which the old code reached with a `None` turn. The only visible difference is that a no-turn error no longer pauses a non-empty prompt queue (`queue::after_turn` marks it paused on `turn.error`). Add `team::after_turn(&st, &sid, None, "turn.error", ...)` there if you want strict parity. It doesn't block the merge.

The audit's decision notes (N1–N5) are unchanged and still need the owner's call.
