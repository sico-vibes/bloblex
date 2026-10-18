# FIX39 package P8 — watchdog (T3 recommendations 3 and 4)

Package P8 of `docs/FIX39_IMPLEMENT_BRIEF.md`, as defined in
`docs/FIX39_DECISIONS.md` (section **P8: watchdog**), with the T3 evidence in
`docs/FIX40_T3_RESEARCH.md` recommendations 3 and 4. Worktree `C:\fx90`, branch
`lane/fix39-p8`. The gates were run with `TEMP=C:/fxt/c2/tmp`. **Nothing was
committed.**

## 0. Takeover note

The previous implementer (GPT Sol 6.1) wrote the implementation and the tests
but ran out of usage before running the gates or writing a report: there was no
`docs/FIX39_P8_REPORT.md` and no `docs/FIX39_P8_AUDIT.md`. This report covers the
**whole** package. The parts I (DeepSeek) added on takeover are listed in §7; the
rest is Sol's work, which I verified line by line and by test rather than
rewriting. Two stray scratch files from Sol (`p8-diff.txt`, a stale UTF‑16 copy of
the diff, and `p8-gates.json`, a stale failing gate run) were removed; see §7.

## 1. Usage limits become a state, not an error (recommendation 3)

- **Classification from every provider.** `crates/bloblex-agent-core/src/recovery.rs`
  is new: `provider_recovery` (`:7`) matches documented codes and *specific*
  failure phrases only (401/`unauthorized` → `AuthRequired`; 429 or
  usage/rate-limit phrases → `RateLimited`; 5xx/overload/stream-drop phrases →
  `Overloaded`), from a nested payload up to depth 6 (`status`, `:68`). It never
  treats a generic mention of "quota" as a limit.
  `provider_retry_after` (`:117`) reads an absolute `resetsAt`/`resetAt` (ISO or
  epoch, ms or s) or a relative `retryAfter`, and keeps an already-expired window
  **negative** so a caller can never turn it into an immediate retry.
  - Claude: `crates/bloblex-adapter-claude/src/lib.rs:614` now emits
    `RecoveryHint { retry_after_secs }`; `recovery_hint_for_claude_result`
    (`:712`) delegates to `provider_recovery`.
  - Codex: `crates/bloblex-adapter-codex/src/lib.rs:501` emits the hint with the
    wait; `recovery_hint_for_codex_error` (`:843`) delegates to
    `provider_recovery` (so `usageLimitExceeded` and nested
    `httpConnectionFailed{500}` now classify instead of being ignored).
  - OpenCode/ACP: `crates/bloblex-adapter-acp/src/lib.rs:1205-1256` maps both the
    protocol-error path and the non-`end_turn` stop reason to a `RecoveryHint`,
    and returns the new `AdapterError::TurnErrorReported` after already queuing an
    ordered `Error`, so the event stream stays the single terminal owner.
- **A durable state with the reset time.** `crates/bloblex-daemon/src/retry.rs`
  `after_failed_turn` (`:216`) claims the turn once, derives the reset from the
  provider wait or the provider's own quota snapshot (`latest_blocked_reset`
  `:515`, `blocked_reset` `:531`), rows it in `sessions.limited_until`, appends one
  "Limited until <time>" notice and emits `session.changed`.
  `crates/bloblex-storage/src/lib.rs` adds `limited_until`, `continuation_pending`
  and `recovery_count` to `sessions` in `ensure_queue_schema` (`:482-495`) —
  additive and idempotent, so an already-versioned database is migrated too.
  `limitedUntil` is surfaced in `session_list` (`:2532`), `session_detail_locked`
  (`:4446`) and `session_event_summary_locked` (`:5021`).
- **Marked in all three surfaces.** Transcript: the daemon notice.
  Sidebar: `apps/desktop/src/ui/TeamSidebar.tsx:310` uses
  `sessionIsLimited` (`teamSelectors.ts:357`) to show the status label.
  Companion: `apps/desktop/src/ui/companionStatus.ts:42` returns a
  `rate_limited` mood with `usageLimitLabel` (`errorCopy.ts:303`).
- **Auto-resume sweep, on by default.** `retry::sweep` (`:719`) and
  `retry::sweep_loop` (`:734`, 1 s tick) run from `main.rs:4233`; they resume only
  sessions whose `limited_until` is known and due. Experimental setting
  `resumeAfterUsageLimits` (validator `storage lib.rs:1256`, UI toggle
  `experiments.ts:12`, default on at `:21`); absent in the daemon means on.
- **Never loop.** `watchdog_limit` (`storage :2694`) only stores a reset that is
  strictly newer than the last one and stops arming after three recoveries;
  `watchdog_enqueue` (`:2720`) is an atomic one-shot guarded by
  `recovery_count < 3`. With **no** reset time it stays `Limited` with a null
  due date and the daemon asks (`main.rs:2966` refuses non-user prompts while
  `limited`; a user prompt clears the state at `main.rs:3040`).
- **Tests.** `recovery.rs` unit tests (`:156+`); Claude `p8_recovery_tests`
  (`adapter-claude :1584+`); Codex/ACP recovery cases updated in place;
  daemon `p8_provider_limits_are_durable_with_the_right_reset` (`main.rs:8156`)
  proves a **Claude, Codex and OpenCode** 429 all become `limited` with a reset
  ~120 s out and the turn marked `recoveryHandled`;
  `p8_sweep_resumes_once_and_honours_the_toggle_and_unknown_windows`
  (`:8180`) proves resume-once, the toggle, an expired window not looping and an
  unknown window asking; `retry::tests::p8_expired_window_never_retries`
  (`retry.rs:581`).

## 2. Bounded retry and continuation (recommendation 4)

- **Bounded transient retry, one owner, jittered backoff.**
  `retry::decide` (`:141`) is pure: overloaded doubles 5 s with jitter, at most
  **three** attempts (`OVERLOADED_MAX_ATTEMPTS`, `:16`); rate-limit waits for the
  known reset with padding+jitter, at most two. `after_failed_turn` (`:216`)
  treats a rate-limited failure as the state above and returns before the retry
  logic; `watchdog_claim_turn` (`storage :2689`) elects exactly one decision
  owner per turn. Process-start failures, dropped streams and 5xx map to
  `Overloaded` via `recovery.rs` and `note_failure` (`retry.rs:685`), which also
  refuses to retry permanent classes (`permission_denied`, `unauthenticated`,
  `context`, `config_unsupported`).
- **Killed/crashed turn continues on the next activation.**
  `retry::continue_on_activation` (`:709`) consumes a persisted marker and
  enqueues exactly one "Continue where you left off." prompt; it is armed by
  `recover_after_restart` (`storage :3603`, `continuation_pending=1` on a
  restart), by a provider crash in `note_failure`, and by a timeout in
  `finish_turn_failed` (`main.rs:3429`). It is invoked from `activate_session`
  (`main.rs:2417`, `:2440`) for every non-`Turn` owner, under the session gate.
  The chain is bounded by `recovery_count < 3`; when the resume failed, P6's
  blind recap is armed with the same `set_session_recap_pending` used by item 20,
  so the continuation prompt carries `<bloblex_recap>`.
- **One honest line.** Each scheduled retry appends one notice
  ("Retrying (n of 3)…" / "Rate limit reached. Retrying automatically at …");
  the intermediate turn error is suppressed in the UI (`conversation.ts:97`
  filters `recoveryHandled` turns, `types.ts:584` carries the flag), and
  `after_provider_failure` (`main.rs:3460`) withholds a false failure from a
  delegating bot until recovery finally fails.
- **No conversation text is logged.** `retry.rs` emits no `tracing` and stores
  only the fixed continuation strings and turn ids; the recap text is P6's and is
  never persisted or logged here.
- **Tests.** `p8_transient_failure_has_one_owner_and_a_three_retry_bound`
  (`main.rs:8253`) schedules a jittered retry for attempts 0–2 and caps at 3,
  calling the hook twice to prove single ownership;
  `retry_attempt_chain_advances_and_caps` (updated) now ends with exactly one
  `turn.error`; `p8_permanent_refusals_win_over_a_transient_hint` (`:8207`);
  `p8_provider_crash_drops_the_dead_handle_and_arms_activation_continuation`
  (`:8221`); `p8_killed_turn_continues_on_activation_with_recap_after_resume_failure`
  (`:8279`) proves the continuation prompt starts with "Continue where you left
  off.", contains the recap and the unanswered user message, and that the recap
  is never stored; `p8_restart_arms_bounded_continuation_without_changing_saved_context`
  (`storage :7942`); `p8_intermediate_side_recovery_does_not_relay_a_false_failure`
  (`main.rs:8237`).

## 3. Scope, migration and Remote

- `main.rs` was touched only on the turn start, failure and continuation path
  (`activate_session`, `finish_activation_failure`, `session_prompt_impl`,
  `run_turn`, `finish_turn_failed`/`after_provider_failure`,
  `forward_events_with_timeouts`, `run`), leaving `team.rs`/`proposals.rs` tool
  routing to P7 as required.
- **Migration on a previous-version database.**
  `p8_previous_database_migrates_and_recovery_is_claimed_once` (`storage :7910`)
  drops the three new columns to simulate the prior schema, reopens the file and
  proves the columns are added, the saved data survives, the setting validator
  accepts the new key, the limit/claim paths behave, and a recovery queue item
  survives another restart.
- **Remote.** No new daemon method or event was added by P8: `turn.retry.cancel`,
  `turn.retry_declined` and `turn.retry_scheduled` already have `tiers.json`
  rows, so the parity test is untouched and the Remote policy tests stay green.
  The new turn fields (`recoveryHandled`, `state`, `limitedUntil`) ride existing
  payloads and add no command text or paths.
- **Quota files needed no change.** `quota.rs` already normalises and serialises
  `resetsAt`/`usedPercent` (`quota.rs:15-56`), and `refresh_provider_quota`
  (`main.rs:715`) is reused as-is by `latest_blocked_reset`; no edit to
  `quota.rs`/`quota_sources.rs` was necessary.

## 4. Files outside the package's list

- `crates/bloblex-agent-core/src/lib.rs` and `Cargo.toml`: the new
  `AdapterError::TurnErrorReported` variant (`lib.rs:793`) and `pub mod recovery`
  (`:1391`) plus the `chrono` dependency. The adapter-error surface and the
  shared recovery evidence are only reachable from here.
- `crates/bloblex-adapter-acp/Cargo.toml`: `chrono` for the timestamp.
- `apps/desktop/src/types.ts`: `applyEvent` carries `state`/`recoveryHandled`
  from `turn.error` so the UI can show the limited/retrying state.
- `apps/desktop/src/ui/SettingsSheet.appearance.mounted.test.tsx`: the
  parametrised "off by default" test now follows each experiment's real default
  (see §7).
- No other file was touched.

## 5. Gates (all run on this worktree, foreground)

- `cargo test --workspace --exclude bloblex-desktop --no-fail-fast`: **all pass**,
  including `bloblex-storage` 114, `bitbotsd` 396, `bloblex-agent-core`,
  `bloblex-adapter-{claude,codex,acp,opencode}` and the P8 tests above.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`: **clean**.
- `cd apps/desktop && npx tsc -b`: **clean**.
- `npx vitest run --maxWorkers=3`: **1254 passed / 171 files, 0 failed**
  (includes the new `ui/watchdog.test.ts` and the fixed mounted test).
- `npm run build`: **ok**.
- `src-tauri` and the remote app were not changed, so their extra gates were not
  run.

## 6. What I could not check

- Live behaviour: no real provider was driven, no daemon was started and no
  window or companion was looked at. The "Limited" copy, the sidebar/companion
  label and the Experimental toggle are proven by unit/mounted tests only; the
  Director still owes a visual pass in both themes and both looks.
- The provider reset times are proven against synthetic payloads; the exact
  phrasing each CLI emits for a limit is not verified against a live run (that
  is P11). The quota-snapshot fallback in `blocked_reset` is unit-tested but not
  exercised end to end with a stored snapshot.
- `cargo fmt --check` reports diffs across essentially the whole repository in
  this checkout (it rewrites untouched files too), so it is an environment
  artefact here, not a P8 finding.

## 7. Changes made on takeover

1. **Mangled copy fixed.** Six strings Sol wrote contained a literal `?` where a
   typographic character belonged:
   - `crates/bloblex-daemon/src/retry.rs:243` `I?ll` → `I'll`, `:244` `you?re` →
     `you're`, `:368` `(n of 3)?` → `(n of 3)…`;
   - `crates/bloblex-agent-core/src/recovery.rs:34` corrected to
     `you’re out of extra usage`;
   - `apps/desktop/src/ui/errorCopy.ts:305` `Limited ? try again later` →
     `Limited — try again later`;
   - `apps/desktop/src/ui/companionStatus.ts:43` `Retrying?` → `Retrying…`;
   - `apps/desktop/src/ui/experiments.ts:12` `provider?s` → `provider’s`.
2. **The failing mounted test fixed.**
   `SettingsSheet.appearance.mounted.test.tsx:49` parametrised over `EXPERIMENTS`
   and asserted every experiment starts `false`; the new default-on
   `resumeAfterUsageLimits` broke it. It now asserts each toggle against
   `DEFAULT_EXPERIMENTS[name]` and that clicking saves the inverse. This was
   Sol's one missing gate item (the UI suite failed 1/1254 before the fix).
3. **Stale scratch files removed.** `p8-diff.txt` (a UTF‑16 diff captured before
   Sol finished) and `p8-gates.json` (a run recording `rust exit 101`, no longer
   reproducible — the tree compiles and tests green) were deleted from the
   worktree root.

## Follow-up (audit)

The P8 implementation audit (`docs/FIX39_P8_AUDIT.md`) returned **PASS WITH
FIXES**. I (DeepSeek) applied every finding F1–F7, in order, on top of Sol's
implementation. Nothing in §1–§7 above was rewritten. All work was in this
worktree (`C:\fx90`) and `C:/fxt/c2`; **nothing was committed**. The gates in §5
were rerun with `TEMP=C:/fxt/c2/tmp` (results below).

### F1. An `Error` event with no turn is no longer dropped (correctness)

`crates/bloblex-daemon/src/main.rs:4004-4014`, the `AgentEvent::Error` arm in
`forward_events_with_timeouts`. The rewrite did its work only inside
`if let Some(t) = turn.as_deref()` and then `continue`d, so an adapter error
arriving with no watched turn changed nothing and emitted nothing. Added the
`else` branch that keeps the old behaviour: `update_session_state(&sid,"error")`,
drop the (absent) active turn, `session.changed` from `session_event_summary`,
and one `turn.error` with `turnId: null`, `failureClass`, `message` and `detail`.

- Test: `provider_error_without_a_watched_turn_still_reports_once`
  (`main.rs:6295`). **Verified failing-first**: with the `else` body disabled the
  test failed (`panicked … a no-turn error must still emit turn.error:
  Elapsed(())`, exit 101); with the fix it passes. The read is wrapped in a
  2 s timeout so a regression fails cleanly instead of hanging.

### F2. ACP no longer returns `TurnErrorReported` without queuing an `Error`

`crates/bloblex-adapter-acp/src/lib.rs:1216-1243`. `TurnErrorReported` was
returned unconditionally, but the `Error` event was sent only when
`had_active_turn`; with no active turn the daemon returned early expecting a
terminal event that never came, leaving the turn `working` and the session busy.
The decision is now one pure helper, `failed_prompt_terminal(had_active_turn)`
(`:912`): `TurnErrorReported` only when the `Error` was queued, otherwise
`AdapterError::Protocol("OpenCode prompt failed")` as before.

- Test: `a_failed_prompt_without_an_active_turn_is_a_protocol_error`
  (`lib.rs:1413`). **Verified failing-first**: with the helper forced to always
  return `TurnErrorReported` (the pre-fix behaviour) the test failed
  (`panicked … no Error event was queued, so the daemon finalizes the turn`,
  exit 101); with the fix it passes. The full `prompt` path needs a live ACP
  child, so the test exercises the extracted decision rather than the transport;
  the helper is the single place the two call sites (`:1238`, `:1242`) get the
  error from, so the wiring is one hop from the test.

### F3. ACP sends the `RecoveryHint` only after the cancellation check

`crates/bloblex-adapter-acp/src/lib.rs:1226-1233`. The hint was sent before
`was_cancelled` was checked, so a cancelled turn could leave a stale hint with no
`Error` after it. The hint send now sits after the `was_cancelled` early return,
inside the `had_active_turn` branch and before the `Error`, on the same ordered
stream (comment at `:1230`). No separate test: F2's helper and the reordered
block are the same edit, and the ordering is asserted by reading the branch.

### F4. Settings label and aria-label agree

`apps/desktop/src/ui/SettingsSheet.tsx:603`. The `Select` had
`ariaLabel="Longest wait for a rate limit"` while the visible row (and hint) read
"Longest retry delay". The aria-label is now "Longest retry delay". No test
selected by the old text (`grep` over `apps/desktop/src` found no test reference
to either string), so no test needed updating.

### F5. The sweep no longer reads every session each second

`crates/bloblex-storage/src/lib.rs:2712` adds `watchdog_due_sessions(now)`, a
small query (`id WHERE state='limited' AND limited_until IS NOT NULL AND
limited_until<=? AND archived=0`). `crates/bloblex-daemon/src/retry.rs:721`
(`sweep`) now iterates only those ids instead of `st.db.sessions()` with its
project sub-selects and JSON extraction. Correctness is unchanged:
`watchdog_enqueue` still re-checks the condition atomically.

- Test: `p8_sweep_only_sees_due_limited_sessions` (`storage lib.rs:7972`) proves
  only a due, unarchived limited session is returned, and a window that has not
  opened is not. Fails to compile on the old code (the query did not exist), and
  the behavioural assertions fail if the SQL is loosened.

### F6. Garbled doc comment

`crates/bloblex-daemon/src/retry.rs:513-514`. Two stacked, contradictory `///`
lines above `latest_blocked_reset` were replaced with one accurate sentence:
"The latest reset time among a provider's blocked quota windows. A stale snapshot
is refreshed once; absence never launches a probe."

### F7. Test coverage gaps

- **Side and Queue-origin path.**
  `p8_side_session_watchdog_item_is_sent` (`main.rs:8308`) proves a side
  session's usage-limit sweep queues its watchdog item and `due_tick` sends
  "Continue where you left off." through `PromptOrigin::Queue`.
  `p8_a_user_cannot_queue_to_a_side_session` (`main.rs:8325`) proves
  `queue::add` still refuses `side` and queues nothing.
- **UI.** `sessionIsLimited (FIX39 P8)`
  (`apps/desktop/src/ui/teamSelectors.test.ts:154`) covers the sidebar label
  predicate (`limited`/`rate_limited` true; `working`, `null`, `undefined`
  false). `takes the limited state and the recovery flag from a turn.error
  payload` (`apps/desktop/src/types.test.ts:171`) proves `applyEvent` takes
  `state: 'limited'` and `recoveryHandled` from the `turn.error` payload.
- **Weak assertion.** `experiments.test.ts` was left as the audit asked; the
  mounted test remains the behavioural check.

### Notes N1–N5

These are decisions for the Director, not defects, and I did not act on them.
N1 (transient retry off by default) and N2 (no quota probe with no snapshot) need
the owner's confirmation; N3–N5 are release-note and visual items.

### Gates (rerun, final state)

- `cargo test --workspace --exclude bloblex-desktop --no-fail-fast`: **all 44
  suites ok, 0 failed** (daemon `bloblex-daemon` 399, storage 115, adapter-acp
  21, and the rest), including all five new/changed tests listed above.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`: **clean**
  (exit 0, no output).
- `apps/desktop && npx tsc -b`: **clean** (exit 0).
- `apps/desktop && npx vitest run --maxWorkers=3`: **1256 passed / 171 files,
  0 failed** (two more than §5's 1254: the two new UI tests).
- `apps/desktop && npm run build`: **ok** (built in ~7.6 s).
- `src-tauri` and the remote app were not changed, so their extra gates were not
  run. No new daemon method or event was added, so `tiers.json` is untouched and
  the parity test stays green.

### What I could not check

- The F2 test exercises the extracted `failed_prompt_terminal` decision, not the
  live `prompt` transport (which needs a running ACP child); the two call sites
  are one hop away.
- As in §6: no live provider, daemon or window was driven. The "Limited" copy,
  the sidebar/companion label and the Experimental toggle remain unit/mounted
  evidence only; the Director still owes a visual pass in both themes and both
  looks (N5 in particular).
- `cargo fmt --check` remains an environment artefact in this checkout (§6).

### Files touched in this follow-up

`crates/bloblex-daemon/src/main.rs`, `crates/bloblex-daemon/src/retry.rs`,
`crates/bloblex-adapter-acp/src/lib.rs`, `crates/bloblex-storage/src/lib.rs`,
`apps/desktop/src/ui/SettingsSheet.tsx`, `apps/desktop/src/types.test.ts`,
`apps/desktop/src/ui/teamSelectors.test.ts`, and this report. All are within
P8's package list or the UI test files it already owns.
