# Phase 3A spec: safe automatic retry after overload and rate limits (backend)

Owner: OpenCode lane (backend only). Reviewer: Director. Parent plan: `docs/IMPROVEMENT_PLAN.md` Phase 3. Builds on Phase 1 (`turns.data.delivery`, `turns.data.hint`, `finish_turn_failed`) and Phase 2 (durable queue, due loop). The UI is built by the Director against this contract; do not touch `apps/`.
Scope: `crates/bloblex-daemon` (new `src/retry.rs`, `queue.rs`, `main.rs`, `team.rs`), `crates/bloblex-storage`, `docs/`. No new dependencies.

## Rules
- Work only in this worktree. **Never run `git commit`, `git push`, `git checkout`, `git stash`.** Leave changes uncommitted. Only attach/read files inside this worktree.
- Cargo: `CARGO_TARGET_DIR=D:/b-p1` and `RUST_MIN_STACK=33554432` (one daemon test overflows the default stack on the base commit; pre-existing).
- Match repo style. No `unwrap()` in non-test code you add. Never log or persist prompts, tokens or raw provider JSON.
- **A retry must never double-send a paid prompt.** If in doubt, decline and say why.
- Everything in this phase is **off by default** (`experimental.autoRetry`), and with it off the daemon behaves exactly as it does today (no notices, no events).

## Settings
- `experimental.autoRetry`: JSON boolean, default false. Validate as a boolean in `settings.set` like the other experimental/gate keys.
- `retry.maxWaitSecs`: JSON integer, default 21600 (6 hours), allowed 0..=86400. 0 means "never wait for a rate-limit window".

## Policy (pure function, table-tested)
`decide(input) -> Decision::Retry{at, kind, attempt} | Decision::Decline{reason}` where input has: hint kind and (always `None` today) `retry_after_secs`, `delivery`, attempt number so far for this chain, now, the latest known quota reset time for the failing provider (if any), `max_wait`, whether the feature is on.
- Decline reasons (machine codes): `disabled`, `not_acknowledged` (delivery is not `acknowledged`: `unknown` ALWAYS declines), `no_hint`, `auth_required`, `unknown_reset`, `too_long`, `max_attempts`, `superseded` (the user sent a newer prompt), `pending_retry` (one retry per original failure), `session_unavailable` (archived/deleted/side conversation), `cancelled`.
- **Overloaded:** retry at `5s * 2^(attempt-1)` plus random jitter in `[0, 100%]` of that base; up to 5 attempts in a chain.
- **RateLimited:** only when a reset time is known: `max(resets_at of the provider's blocked quota windows) + 15s + random 0..30s`, up to 2 attempts. A window is "blocked" when its used share is at or above 100% and its reset is in the future. Find the existing quota snapshot accessor in `quota.rs`/`main.rs` (cached poll state). If the snapshot is older than 10 minutes, refresh it once with a 5-second timeout. No known reset => `unknown_reset`. Wait longer than `retry.maxWaitSecs` => `too_long`.
- **AuthRequired:** always declines (`auth_required`); the existing sign-in notice already tells the user what to do.
- The decision and its reason are stored in `turns.data.retryDecision` (`{"decision":"retry"|"decline","reason":...,"at":...}`) for audit. Never store provider text.

## What a retry is
- It is a **new turn** that sends the literal text `Please continue.` into the same session, via the same entry point `session.prompt` uses, with the session's locked model/effort/approval mode unchanged. It never resends the original prompt (that is why `unknown` delivery declines).
- It goes through the Phase 2 queue so it shares the due loop, drain lock and `queue.changed` events: add queue kind `retry` (same table; extend the CHECK/validation, the DTO `kind`, and the due-loop selection `kind IN ('send_later','retry')`). Retry items **bypass pause** like scheduled items (the failed turn paused the queue). The stored params carry `meta` `{"kind":"auto_retry","retryOf":"<original turn id>","attempt":N}`; make the daemon's prompt path accept exactly that meta kind from the queue (allowlist; user-supplied RPCs still cannot set `meta`). The resulting user message must carry `meta.kind == "auto_retry"` so the UI can render it as a notice instead of a bubble.
- Chain: the retry turn records `{retryOf, attempt}` in `turns.data`; a failing retry is decided again with `attempt+1`.
- At most one pending retry item per session. A user-sent prompt, a Stop, a deleted/archived session, or a model/effort change cancels any pending retry (`superseded`/`cancelled`).
- After a daemon restart a pending retry that is overdue by more than 10 minutes is dropped with a transcript notice ("Automatic retry skipped because Bitbots was not running."); otherwise it fires when due.

## Notices and events (only when the feature is on)
- On schedule, append a transcript notice with the existing `team::note` helper: role `notice`, content `Provider is overloaded. Retrying automatically in about N min (attempt A of M).` (or `Rate limit reached. Retrying automatically at HH:MM (attempt A of M).`), meta `{"kind":"auto_retry","status":"scheduled","retryKind":"overloaded"|"rate_limited","attempt":A,"maxAttempts":M,"runAt":"<rfc3339>","itemId":"<queue id>"}`. Emit `turn.retry_scheduled` with `{sessionId, turnId, itemId, retryKind, attempt, maxAttempts, runAt}`.
- On decline for a **retryable-class failure** (a hint of overloaded/rateLimited existed) append a notice `Not retrying automatically: <short reason>.` meta `{"kind":"auto_retry","status":"declined","reason":"<code>"}` and emit `turn.retry_declined {sessionId, turnId, reason}`. For failures with no hint, or auth, stay silent (no notice, no event).
- When the retry actually sends, no extra notice (the `auto_retry` user message is the record).
- RPC `turn.retry.cancel {sessionId}`: removes the session's pending retry item, appends notice `Automatic retry cancelled.` meta `{"kind":"auto_retry","status":"cancelled"}`, emits `queue.changed` and `turn.retry_declined {reason:"cancelled"}`. `not_found` when nothing is pending.
- Add the method rows, events and meta kinds to `docs/ipc-contract.md`.

## Where it hooks in
Decide at the single turn-ending path (Phase 1A's `finish_turn_failed` and the event-loop `Error` arm), after `turns.data.hint` was merged and after the existing team/queue `after_turn` bookkeeping, so queued user prompts and the pause logic already ran. Do not change `failureClass`, the public error message, or the emitted `turn.error` payload.

## Tests (required; deterministic)
1. Policy table: every decline reason; overloaded backoff values with jitter bounds (inject the random source); rate limit with and without a known reset; `max_wait` boundary; attempts cap; `unknown` delivery always declines even for overloaded.
2. Daemon: feature off => no notice, no event, no queue item; on + acknowledged + overloaded hint => one queue `retry` item due after the backoff, notice and `turn.retry_scheduled`; the due item sends `Please continue.` exactly once as a new turn with `meta.kind == "auto_retry"`; a second failure schedules attempt 2; attempt cap declines with `max_attempts`.
3. A user prompt sent while a retry is pending cancels it (`superseded`); Stop/cancel never triggers a retry; `turn.retry.cancel` works and reports `not_found` when idle.
4. Retry items bypass the queue pause and do not disturb plain queued items (they still wait for the next completed turn).
5. Restart: overdue retry is dropped with the notice; not-yet-due retry stays queued.
6. Settings validation for the two keys.
7. All pre-existing tests pass unchanged.

## Gates (run and report real output)
```
CARGO_TARGET_DIR=D:/b-p1 RUST_MIN_STACK=33554432 cargo test -p bloblex-storage -p bloblex-daemon -p bloblex-agent-core -p bloblex-adapter-claude -p bloblex-adapter-codex -p bloblex-adapter-acp
```

## Final report (plain text, last message)
1. Files changed. 2. Per section: what you did and exact test names. 3. Gate summary per crate. 4. Anything unverified, spec/source mismatches, decisions where the spec was silent. Fake-peer verified only; no live-CLI claim.
