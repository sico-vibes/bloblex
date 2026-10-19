# Recovery-hint evidence inventory (Phase 1B, 12 October 2026)

> **What this is:** Evidence inventory for recovery hints (Phase 1B), 12 October 2026.
> **Status:** evidence; immutable record
> **Last updated:** 2026-10-12

Read-only inventory that justifies every classification the Phase 1B recovery
hints add. A classification is only implemented when its row is
`verified-in-source` or `fixture-only`; otherwise it is `unknown` and no hint is
emitted. A missing hint is correct; a wrong hint is a bug (it will later decide
whether a paid prompt is re-sent).

Evidence sources used:

- Adapter source and tests in this worktree (line numbers below).
- The installed Codex CLI schema generated read-only with
  `codex app-server generate-json-schema --out <OS temp dir>` (codex-cli
  0.162.1). Schema paths are relative to that output. Nothing generated is
  committed.
- `docs/reference/runtime-capabilities.md` (checked-in CLI capability record).
- The installed Claude CLI's embedded result schema, read as a binary string
  from `claude.exe` (see the Claude note). Binary-string evidence is weaker
  than a generated schema; it is flagged where used.

## Table

| provider | situation | structured field(s) | evidence (file:line or schema path) | mapped hint | status |
|---|---|---|---|---|---|
| codex | turn failed: not signed in | `turn.error.codexErrorInfo == "unauthorized"` | generated schema `v2/TurnCompletedNotification.json` → `Turn.error` (`TurnError`) → `codexErrorInfo` (`CodexErrorInfo`); `codex_app_server_protocol.v2.schemas.json#/definitions/CodexErrorInfo`; adapter reads `p["turn"]["error"]` at `crates/bloblex-adapter-codex/src/lib.rs:459-464` | `AuthRequired` | verified-in-source |
| codex | turn failed: rate limit reached | `turn.error.codexErrorInfo == "rateLimitExceeded"` | same schema path; adapter `crates/bloblex-adapter-codex/src/lib.rs:459-464` | `RateLimited` | verified-in-source |
| codex | turn failed: provider overloaded | `turn.error.codexErrorInfo == "serverOverloaded"` | same schema path; adapter `crates/bloblex-adapter-codex/src/lib.rs:459-464` | `Overloaded` | verified-in-source |
| codex | turn failed: account usage cap | `turn.error.codexErrorInfo == "usageLimitExceeded"` | same schema path | (none) | unknown — account-cap exhaustion is not a transient rate limit with a stated wait; declined |
| codex | turn failed: context window full | `turn.error.codexErrorInfo == "contextWindowExceeded"` | same schema path | (none) | unknown — already routed to `AgentEvent::ContextExhausted`; no hint |
| codex | reset time for a rate limit | `rateLimits.primary.resetsAt` / `rateLimits.secondary.resetsAt` (unix seconds) | generated schema `v2/GetAccountRateLimitsResponse.json` → `RateLimitSnapshot` → `RateLimitWindow`; fake fixture `crates/bloblex-adapter-codex/src/bin/fake_codex_server.rs:186-198` | (would feed `retry_after_secs`) | fixture-only — declined: not tied to the failing turn; using it needs a separate process call, so `retry_after_secs` stays `None` |
| claude | result failed: not signed in | `result.api_error_status == 401` | installed `claude.exe` embedded result schema: `is_error`, `api_error_status` (int, nullable), `terminal_reason`; adapter result branch `crates/bloblex-adapter-claude/src/lib.rs:598-624` | `AuthRequired` | verified-in-source (embedded schema; weaker than a generated schema — no live capture) |
| claude | result failed: 403 | `result.api_error_status == 403` | same embedded schema; adapter result branch `crates/bloblex-adapter-claude/src/lib.rs:598-624` | (none) | unknown — a 403 is not evidenced as a sign-in failure (it can be a policy or permission denial); declined |
| claude | result failed: rate limit | `result.api_error_status == 429` | same embedded schema; adapter `crates/bloblex-adapter-claude/src/lib.rs:598-624` | `RateLimited` | verified-in-source (embedded schema; weaker — no live capture) |
| claude | result failed: overloaded | `result.api_error_status == 529` (proposed) | not evidenced in any checked source | (none) | unknown — 529 is not in the embedded result schema evidence; declined |
| claude | result failed, free text only | `result.errors[]`, stderr | adapter `crates/bloblex-adapter-claude/src/lib.rs:620`; fixture `crates/bloblex-adapter-claude/src/bin/fake_claude.rs:75`; existing test `crates/bloblex-adapter-claude/src/lib.rs:1444-1446` | (none) | unknown — negative case: free text produces no hint |
| claude | `system/api_retry` | `error` (free text), `attempt`, `max_attempts` | adapter `crates/bloblex-adapter-claude/src/lib.rs:465-499`; fixture `fake_claude.rs:63-67` | (none) | unknown — no structured status is emitted by the installed CLI or the fixture; `retry_event_has_http_status` is a heuristic scan, not provider evidence |
| claude | `result.terminal_reason` | `terminal_reason` values (`prompt_too_long`, `api_error`, …) | adapter `crates/bloblex-adapter-claude/src/lib.rs:599-607` | (none) | unknown — `prompt_too_long` already maps to `ContextExhausted`; no other value distinguishes auth/rate/overload |
| acp | turn failed | none (generic `"OpenCode turn failed"`) | adapter `crates/bloblex-adapter-acp/src/lib.rs:1146-1153` | (none) | unknown — ACP reports no structured error kind |

## Summary

- verified-in-source: 5 (3 Codex, 2 Claude)
- fixture-only: 1 (Codex rate-limit reset time; declined for `retry_after_secs`)
- unknown / declined: 7

`retry_after_secs` is `None` for every emitted hint: no provider states a wait or
reset inside the failing-turn event, and the one explicit reset (`account/
rateLimits/read`) is a separate snapshot that is not tied to the turn.
