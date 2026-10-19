# Phase 1B spec: typed recovery hints and honest context-change notices

> **What this is:** Spec for phase 1B: typed recovery hints and honest context-change notices.
> **Status:** historical
> **Last updated:** 2026-10-12

Owner: OpenCode lane (backend only). Reviewer: Director. Parent plan: `docs/plans/improvement-plan.md` Phase 1. Builds on Phase 1A (already committed in this branch: `finish_turn_failed`, `PromptAccepted`, `turns.data.delivery`).
Scope: `crates/bloblex-agent-core`, `crates/bloblex-adapter-claude`, `crates/bloblex-adapter-codex`, `crates/bloblex-adapter-acp` (only if evidence exists), `crates/bloblex-daemon`, `crates/bloblex-storage` (only if needed). **Do not touch `apps/` (UI) or `Cargo.toml` dependencies.**

## Rules
- Work only in this worktree. **Never run `git commit`, `git push`, `git checkout`, `git stash`.** Leave changes uncommitted.
- Cargo: `CARGO_TARGET_DIR=D:/b-p1` and `RUST_MIN_STACK=33554432` (one daemon test overflows the default test stack on the base commit; that is pre-existing, do not fix it).
- Match repo style. No new dependencies. No `unwrap()` in non-test code you add. Never log or persist prompts, tokens or raw provider JSON; provider text goes through `safe_provider_error_detail`.
- **No guessing.** Every classification you add must cite its evidence: a field already parsed by the adapter, a fixture/test already in the repo, a documented fact in `docs/reference/runtime-capabilities.md`, or a JSON schema you generate from the installed CLI (see B0). If a provider gives no structured evidence, emit no hint. A missing hint is correct; a wrong hint is a bug (it will later decide whether a paid prompt is re-sent).
- Behaviour not listed here must remain unchanged, including existing event types and payloads.

## B0: evidence inventory (do this first, write it down)
Create `docs/evidence/recovery-hints-2026-10-12.md` containing a table with columns `provider | situation | structured field(s) | evidence (file:line or schema path) | mapped hint | status (verified-in-source / fixture-only / unknown)`.
Sources you may use, read-only:
- Existing adapter code and tests: Claude `result` events (`is_error`, `terminal_reason`, `errors[]`, `subtype`, `api_error_status`), `system/api_retry` events (see `record_api_retry`, `retry_event_has_http_status`), Codex `turn/completed` errors (`p["turn"]["error"]`), and the account rate-limit read (`account/rateLimits/read`).
- `docs/reference/runtime-capabilities.md` and `docs/evidence/`.
- Codex schema: `codex app-server generate-json-schema --out <dir under your OS temp dir>` (this writes only to that directory; run it once, inspect the `CodexErrorInfo`-like error variants and the turn error shape, and cite schema paths). Do not commit generated schemas.
If a situation is not evidenced, record it as `unknown` and implement nothing for it.

## B1: typed recovery hints (internal, no wire event)
In `bloblex-agent-core` add a small enum `RecoveryHintKind { AuthRequired, RateLimited, Overloaded }` (serde `camelCase`; add more variants only if B0 evidences them) and `AgentEvent::RecoveryHint { kind: RecoveryHintKind, retry_after_secs: Option<u64> }`.
- Adapters emit it immediately **before** the terminal `AgentEvent::Error` (or the error-ending `TurnCompleted` path) for the same failure, only for situations B0 marks `verified-in-source` or `fixture-only`.
- `retry_after_secs` is set only when the provider states a wait or reset explicitly; never derived from text parsing of free prose. When absent it is `None`.
- Daemon: on `RecoveryHint`, merge `{"hint":{"kind":"...","retryAfterSecs":N|null}}` into the active turn's `turns.data` via `merge_turn_data`; `continue` (no wire event, no UI change). If no turn is active, drop it.
- The existing error message, `failureClass` mapping and sign-in hint behaviour are untouched.

## B2: context-change notices
In `bloblex-agent-core` add `AgentEvent::ContextChanged { reason: ContextChangeReason, context_lost: bool }` where `ContextChangeReason` is `Compaction | FreshSession` (serde `snake_case`: `compaction`, `fresh_session`).
Emitters:
- Claude: at the existing `compact_boundary` site (where `AgentEvent::ContextReset` is sent today) keep sending `ContextReset` unchanged and send `ContextChanged { Compaction, context_lost: false }` right after it.
- Codex: in the resume path that falls back from a rejected `thread/resume` to a fresh `thread/start` (search `AdapterError::ResumeRejected` with `fresh = true`, around the `SessionStarted` enqueue), send `ContextChanged { FreshSession, context_lost: true }` immediately after the `SessionStarted` event. Today this fallback is silent.
- Daemon-level fallback: where `session.resume` falls back to a brand-new provider session (search `resume_fallback` and `outcomeNote`, ~L1721-1783 of `main.rs`), append the same notice directly (reason `fresh_session`, `contextLost: true`). Make sure the Codex adapter path and this path cannot both fire for one resume.
Daemon handling of `ContextChanged` (event loop in `forward_events_with_timeouts`):
1. Append a transcript notice using the existing `note()` helper in `team.rs` (make it `pub(crate)`; do not duplicate it): role `notice`, `meta = {"kind":"context_reset","reason":"compaction"|"fresh_session","contextLost":bool}`, content exactly:
   - compaction: `Conversation compacted. Earlier details may now be summarised.`
   - fresh_session: `Started a fresh session. The agent no longer has earlier context.`
2. Emit a new event `session.replaced` with payload `{"sessionId":...,"reason":...,"contextLost":bool}` (informational; nothing consumes it yet). Add a one-line entry to `docs/ipc-contract.md`.
3. For `contextLost: true` also emit the existing `session.context.reset` (the context meter must forget the old window). For compaction it is already emitted by the `ContextReset` event, so do not double-emit.
The notice must be persisted (so it survives reload) and use the same `message.completed` emission shape `note()` already uses, which the UI renders as a divider.

## Tests (required; deterministic, no real CLIs)
1. Mapping unit tests per adapter, using JSON fixtures that already exist in the repo or that you copy from the evidence table: each `verified-in-source`/`fixture-only` row has a test; a negative test shows free-text-only errors produce **no** hint.
2. Daemon: `RecoveryHint` then `Error` for a turn leaves `turns.data` with both `delivery` (from 1A) and `hint`, with existing keys preserved.
3. Daemon: `ContextChanged` produces exactly one persisted `notice` message with the specified meta/content, one `session.replaced`, and `session.context.reset` only when `contextLost`.
4. Codex fake server: rejected `thread/resume` yields `SessionStarted` then `ContextChanged{FreshSession,true}`; a successful resume yields no `ContextChanged` (reuse `crash-reject`/resume-reject modes of `fake_codex_server`; add a flag only if needed).
5. Claude fake: a `compact_boundary` line yields `ContextReset` then `ContextChanged{Compaction,false}` in that order.
6. All pre-existing tests still pass. If a strict-order pre-existing test must tolerate a new event, only skip that event type and say so in the report.

## Gates (run and report real output)
```
CARGO_TARGET_DIR=D:/b-p1 RUST_MIN_STACK=33554432 cargo test -p bloblex-agent-core -p bloblex-storage -p bloblex-adapter-claude -p bloblex-adapter-codex -p bloblex-adapter-acp -p bloblex-daemon
```
Clippy is already failing on the base commit; do not attempt to fix pre-existing findings, only avoid adding new ones.

## Final report (plain text, last message)
1. Files changed (one line each).
2. For B0-B2: what you did, exact test names, and the evidence table summary (counts of verified-in-source / fixture-only / unknown).
3. Gate output summary per crate.
4. Anything unverified, any place the spec did not match the source, and every classification you declined to add and why.
Do not claim live-CLI verification. Fake-peer verified only.
