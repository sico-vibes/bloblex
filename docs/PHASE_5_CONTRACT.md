# Phase 5 contract: cost and usage analytics (daemon RPC + UI)

Shared contract so the daemon lane and the UI lane can build in parallel. Original design: no third-party layout, text or assets. Builds on Phase 2a (`agent_id` on sessions and usage events) and Phase 2b-1 (migration 3 columns: `usage_events.exec_snapshot_id`, `provider_update_id`, `usage_status`, `context_used`, `context_size`, `sessions.cumulative_cost_micros`). Where Phase 2b usage capture is not implemented yet, rows simply carry `usage_status='unreported'` and null buckets; analytics must handle that honestly.

## Definitions

- **Run** = one turn (`turns` row). **Run time** = `completed_at - created_at` for completed or failed turns; turns still active are excluded from run time and counted in `activeRuns`. **Failed run** = a turn in state `error`.
- **Reported usage** = a `usage_events` row with `usage_status IN ('reported','partial')`. A run with no usage row, or only `unreported` rows, is an **unreported run**.
- **Tokens** are never invented: each bucket (input, output, cacheRead, cacheWrite, reasoning) is the sum of known (non-NULL) values; a bucket with no known value in the range is `null`, not 0. `total` is the sum of the non-null buckets and is `null` only when every bucket is null. OpenCode `context_used`/`context_size` are context-window figures and are never added to token buckets.
- **Cost** = provider-reported actual cost (`reported_cost_minor` with a known `reported_currency`; for OpenCode the per-turn delta of the cumulative session cost) PLUS an API-rate estimate from `pricing_rules` / `user_pricing_rules` for tokens that have no reported cost, using the existing valuation basis (`usage_valuations`: `actual`, `estimate`, `unknown`). **Unknown prices stay unknown, never zero.** The response says which part is actual and which is estimated. Subscription fees (`subscription_plans`) are reported separately and are NEVER mixed into usage cost.
- **Lower-bound rule**: when any run in scope is unreported or any model used in scope is unpriced, the cost and token totals are lower bounds: `lowerBound: true` and the UI prefixes the value with "≥" and shows "N runs did not report usage" and the list of unpriced models.
- Currency: amounts are integer minor units in the settings currency when conversion is configured; rows in another currency that cannot be converted are excluded from the amount, counted in `excludedCurrencies`, and force `lowerBound: true`.
- Bucketing uses the caller's IANA timezone (`tz`): a bucket starts at local midnight (day) or local Monday midnight (week). DST days are 23/25 hours: bucket boundaries are computed in local time, not by adding 24 h.

## RPC `usage.analytics`

Request: `{ "from": "<RFC3339 UTC>", "to": "<RFC3339 UTC>", "bucket": "day"|"week", "tz": "<IANA>", "projectPath"?: string, "agentId"?: string }`. `from`/`to` are inclusive/exclusive; the daemon rejects ranges over 400 days and `from >= to` with `invalid_argument`; an unknown `agentId` is `not_found`; `projectPath` is matched after the same Windows path normalisation the UI groups with (case-insensitive, `/` = `\`, trailing slashes ignored).

Response:

```json
{
  "range": { "from": "...", "to": "...", "bucket": "day", "tz": "Europe/London" },
  "totals": {
    "cost": { "amountMinor": 1234 | null, "currency": "USD", "actualMinor": 1000 | null, "estimatedMinor": 234 | null, "lowerBound": true },
    "tokens": { "input": 1 | null, "output": 1 | null, "cacheRead": 1 | null, "cacheWrite": 1 | null, "reasoning": 1 | null, "total": 1 | null },
    "runTimeMs": 123456,
    "runs": 40, "failedRuns": 2, "activeRuns": 0, "unreportedRuns": 7,
    "unpricedModels": ["provider/model"],
    "excludedCurrencies": []
  },
  "series": [ { "bucketStart": "<RFC3339 UTC of the local bucket start>", "cost": {...same shape...}, "tokens": {...}, "runTimeMs": 1, "runs": 1, "failedRuns": 0 } ],
  "leaderboard": [ { "agentId": "uuid" | null, "agentName": "Codex" | null, "runtimeId": "...", "tokens": {...}, "cost": {...}, "runTimeMs": 1, "runs": 1, "failedRuns": 0, "unreportedRuns": 0, "unpricedModels": [] } ],
  "errors": [ { "turnId": "...", "sessionId": "...", "agentId": "uuid" | null, "at": "<RFC3339>", "message": "safe short text" } ],
  "subscriptions": [ { "provider": "claude", "monthlyMinor": 2000, "currency": "USD", "quotaState": "unknown" } ]
}
```

- `series` contains every bucket in the range (empty buckets with zero runs and null cost/tokens), ordered ascending. `leaderboard` is ordered by cost descending (nulls last), then runs; sessions with `agent_id` NULL (legacy runtime-only sessions) appear as one row with `agentId: null`, `agentName: null`. `errors` lists failed turns, newest first, at most 50, with a SAFE message (never prompt text, env values or raw provider JSON). `subscriptions` is informational only.
- Errors: `invalid_argument` (bad range/bucket/tz), `not_found` (unknown agent), `internal`. The method is read-only and available through the same authenticated loopback path as the other RPCs.

## UI (apps/desktop)

- A full-width **Analytics view** opened from the sidebar "Usage" link (replaces the chat pane like the Blob page; Back returns). The SAME component is reused on the Blob page "Usage" tab with `agentId` fixed (replacing the "Not available yet" placeholder).
- Controls: range 7 / 30 / 90 days, project filter (derived from sessions' project paths, with the Phase 4 path-key rules), Daily / Weekly toggle. Four summary cards: **Cost**, **Tokens**, **Run time**, **Runs** (with failed count). A plain **SVG bar chart** (no chart dependency) with a Tokens / Cost / Time / Runs metric toggle, accessible (role="img" with a text summary, keyboard-focusable bars with a tooltip that reads the exact value and bucket). A **leaderboard** with proportional bars per blob and the "≥" notation. An **Errors** tab listing failed turns. A visible note when numbers are lower bounds ("≥", "N runs did not report usage", unpriced models) and an explicit "Unknown" (never 0) for unknown cost or tokens.
- Currency and number formatting through `Intl`. Subscription fees are shown in a separate card or section labelled "Subscriptions (not included in usage cost)".
- Fixtures: extend the preview fixture bridge with analytics responses covering: full data, partial data (lower bound), no data, unknown pricing, a legacy `agentId: null` row, a DST-week range.

## Additive backend notes

- The daemon records execution start in `turns.started_at`; completed, failed, and cancelled run time uses `completed_at - started_at`. `cancelledRuns` is included in totals and non-empty series/leaderboard rows.
- Failed and cancelled turns may include `failureClass` in an error row. Wire values are `provider`, `permission`, `cancelled`, `timeout`, `budget`, `config`, and `other`; message text is a fixed safe summary and never provider output.
- When no rate can be established from the supplied verified rate material or a user's override, `unpricedModels` lists the provider-qualified model and the amount stays null. No price is inferred from model names.

## Tests the owners must write

- Daemon: reconciliation of totals with the raw `usage_events` on a fixture, partial/unreported data labelled with `lowerBound`, unknown prices stay null (never 0), subscriptions excluded from cost, timezone bucketing incl. a DST transition week, week-start Monday, project and agent filters, null-agent row, failed-run list safety (no prompt text), range validation.
- UI: summary cards and "≥" rendering for lower bounds, "Unknown" rendering, chart bar values and metric/bucket toggles, filters sending the right request, accessibility roles/labels, the Blob Usage tab reuse with a fixed agent, empty state.

## Runtime hardening additions

`failureClass` may additionally be `context`. The daemon uses this only after positive provider evidence of context exhaustion. Its safe user-facing message is `Context window is full. Start a new conversation.` and the turn error carries `canRetireSession: true`. Context exhaustion alone does not clear the provider session ID.

`runtime.capabilities` additionally returns `versionRecognized: boolean`. This indicates that the discovered CLI version matches a version format the runtime knows; it does not imply that every capability has been verified. Runtime children receive only allowlisted `LANG`, `LC_ALL`, `TZ`, `NO_COLOR`, and `TERM` overrides. Environment values are never logged or emitted.

On positive evidence that a provider rejected its stored session ID as missing or expired, the daemon emits `session.resume_rejected`, clears that provider ID, and starts a fresh provider session. Generic resume failures retain the stored ID.

- Resume-time context overflow emits `session.context_exhausted` with the same safe message and retirement offer; it does not clear the provider-session ID.
