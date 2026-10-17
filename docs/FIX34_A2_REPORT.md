# FIX34 A2: fresh-session notice on existing conversations

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`. Worktree `C:\fx52`, private
`CARGO_TARGET_DIR=C:/fxt/a2`. No `git commit` was run. No real provider CLI was
executed; all daemon evidence below comes from the fake adapters and the temp DB
in the test suite.

## Problem

A conversation that had been warmed but never prompted still reported "Started a
fresh session. The agent no longer has earlier context." The daemon saved the
fallback's provider id as `resumable` and cleared `lazyStart` even though no
prompt had been sent. Claude never saves a session that received no prompt, so
the next activation was rejected (`ResumeRejected`) or took the start-fresh
branch, and each activation wrote another notice.

## Changes

### Session data flag `providerTurns`

`crates/bloblex-storage/src/lib.rs`

- `session_provider_turns` (2078): reads `data.providerTurns`, absent = 0.
- `increment_session_provider_turns` (2085): increments and returns the new
  value.
- `reset_session_provider_turns` (2096): writes 0.
- `set_session_resumable` (2101): writes only the `resumable` column.
- `clear_session_provider_id` (2949): now also resets `providerTurns` to 0,
  because discarding the handle starts a new provider context. Its three
  callers are the resume fallback, the start-fresh branch and a model change.
- `clear_session_context_quietly` (3485): persists a null
  `session.context.updated` measurement so the context meter is cleared without
  a visible `session.context.reset` event. Needed because the summary and replay
  derive counters from the latest context event.

### Daemon

`crates/bloblex-daemon/src/main.rs`

- `create_session` (1821): a brand-new provider context is stored with
  `resumable = false` and the create response reports `resumable: false`; the
  handle becomes resumable after its first prompt.
- `resume_or_start_fresh` (1863, new `previous_had_turns` argument):
  - `ResumeRejected` (1886): still clears the pointer and quietly clears the
    context counters, but emits `session.context.reset` and
    `session.resume_rejected` only when the replaced context had turns.
- `resume_inner` (1952, 2017, 2026, 2052, 2089):
  - reads `previous_had_turns` once, before any reset;
  - start-fresh branch emits `session.context.reset` only when
    `previous_had_turns`; otherwise it clears counters quietly;
  - install writes `resumable = capability.resume && provider_turns > 0`;
  - the previous `lazyStart` clear on install is removed;
  - the post-fallback transcript notice requires `resume_fallback &&
    previous_had_turns`. `outcomeNote` is unchanged for explicit resume RPCs.
- `note_prompt_delivered` (2772), called from `run_turn` only when
  `adapter.prompt()` returned `Ok` (2915): increments `providerTurns`; on the
  first prompt it clears `lazyStart` and, when the adapter supports resume,
  marks the handle resumable.
- `AgentEvent::SessionStarted` (3261): refreshes the provider id but keeps
  `resumable` false while `providerTurns == 0`.
- `AgentEvent::ContextChanged` (3556): on `FreshSession` it resets
  `providerTurns`; if the replaced context had no turns it also clears counters
  quietly and writes no notice, no `session.replaced` and no
  `session.context.reset`. Compaction leaves `providerTurns` alone.

### Design note

Prompt delivery is recorded from `adapter.prompt()` returning `Ok`, not from the
`PromptAccepted` event. The event is the stronger acceptance signal, but several
adapters (including the test doubles and possibly an ACP session that never
streams an acceptance) may return success without it, which would leave
`lazyStart` set forever. `prompt()` returning `Ok` is the point where the
prompt has reached the provider context, so it is the safe place to clear the
lazy marker and enable resume.

## Tests

New daemon tests (fake adapters, temp DB):

- `warming_a_never_prompted_conversation_repeatedly_announces_nothing` (5383):
  warms the same conversation three times with three-other-conversation
  evictions between rounds; asserts zero `context_reset` notices, zero
  `session.context.reset` events, `providerTurns == 0` and a clean `closed`
  state.
- `lazy_warm_then_prompt_starts_once_and_announces_nothing` (5413): warm leaves
  `lazyStart` set and starts one provider; the first prompt reuses it (one
  `new_session`, zero resumes), clears `lazyStart`, sets `providerTurns = 1` and
  `resumable = true`, with no notice or reset event.
- `resume_rejection_announces_once_after_a_delivered_turn` (5442): a session
  with one delivered turn whose resume is rejected gets exactly one notice, one
  `session.context.reset` and one `session.resume_rejected`; a later silent
  warm-up after the fallback adds none.
- `context_changed_stays_silent_until_a_prompt_has_been_delivered` (5891): a
  `FreshSession` `ContextChanged` on a never-prompted context writes nothing and
  resets the counter; the same event after a turn writes exactly one notice and
  one reset event.

Existing tests updated for the new rule:

- `daemon_resume_rejection_clears_pointer_starts_fresh_and_records_outcome`
  seeds `providerTurns = 1` and passes `previous_had_turns = true`.
- `daemon_generic_resume_error_preserves_saved_provider_pointer` passes the new
  argument.
- `context_changed_persists_one_notice_and_only_resets_when_context_is_lost`
  seeds one turn.
- `conversation_create_is_lazy` now waits for the lazy marker to clear after the
  first prompt and also asserts `providerTurns == 1`.

## Gates

Run in `C:\fx52` with `CARGO_TARGET_DIR=C:/fxt/a2`.

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`:
  all suites passed (daemon binary: 295 passed, 0 failed; no `FAILED` or
  `panicked` lines).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`: clean.
  `resume_or_start_fresh` gained one argument, so it carries
  `#[allow(clippy::too_many_arguments)]`.

## Unverified

- No real Claude, Codex or OpenCode CLI was run. In particular, the claim that
  Claude saves a session only after a prompt is taken from the report and is not
  re-verified here; the fix is conservative either way.
- Legacy rows written before this change have no `providerTurns` (read as 0) and
  may still carry `resumable = true`. They can still attempt `--resume`; if that
  is rejected the replacement is now silent, and the row becomes resumable again
  only after a prompt. No data migration/backfill was added.
- UI behaviour (the notice disappearing in the real app, context meter updates
  through the quiet null measurement) was not exercised; only daemon events and
  stored rows were checked.
- Warm-up timing in the real app (400 ms UI timer, real process latency) and
  eviction under load were not reproduced; the tests call the RPCs directly.

## Follow-up: legacy rows with no `providerTurns` key

The "Unverified" gap above was closed. Rows written before this change have no
`data.providerTurns`, so `session_provider_turns` read them as 0 and
`previous_had_turns` was false even for long conversations; after the upgrade a
real context loss would have been announced silently.

### Changes

- `crates/bloblex-storage/src/lib.rs`:
  - `session_had_provider_turns` (2090, new) returns whether the current provider
    context has had a delivered prompt. If the `providerTurns` key is present it
    uses `value > 0` (an explicit 0 still means no turns). If the key is **absent**
    it treats the context as having had turns only when the row already held a
    provider context (`provider_session_id` non-empty or `resumable`) **and** the
    `messages` table holds at least one `user` or `assistant` row.
- `crates/bloblex-daemon/src/main.rs`: the four reads of the counter now use the
  new method: `previous_had_turns` in `resume_inner` (1952) and the
  `ContextChanged` handler (3556); the resumable decision on install (2053-2054);
  and `AgentEvent::SessionStarted` (3261).

### Why the provider-context guard

The plain rule ("absent key + any stored message") would have mis-read a
brand-new *lazy* conversation: `agent.conversation.create` stores no
`providerTurns`, and `session.prompt` appends the user message (2715) *before*
`run_turn` activates the provider, so its first activation would have looked like
a reused context and emitted a spurious `session.context.reset` (existing test
`conversation_create_is_lazy`, 8690). Requiring a prior provider context keeps
that first activation silent while still covering legacy rows, which always
carry a `provider_session_id` once a provider has started.

### Test

`legacy_rows_without_provider_turns_keep_the_context_loss_notice` (5474): a
legacy row (no `providerTurns` key) with a saved handle and one stored user
message whose resume is rejected records exactly one notice and one
`session.context.reset`; a legacy row with no messages records none.

### Gates

Run in `C:\fx52` with `CARGO_TARGET_DIR=C:/fxt/a2`.

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop
  --no-fail-fast | grep -E "test result|FAILED|panicked"`: all suites passed
  (daemon binary: 296 passed, 0 failed; no `FAILED` or `panicked` lines).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`: clean.

### Still unverified

The message check reads the `messages` table, not turn outcomes; a legacy row
whose only stored message is a preflight-rejected user turn would now be treated
as having had turns. No real provider CLI was run; a legacy session was
reproduced only as a DB row in the fake-adapter tests.
