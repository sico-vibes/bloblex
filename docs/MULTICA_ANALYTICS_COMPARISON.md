# Multica vs Bloblex: usage / cost / dashboard / analytics comparison

**Scope.** Compares Multica's analytics stack end to end against Bloblex's, as they exist in the working tree on 2 October 2026. Multica is read from a read-only clone at `%TEMP%\claude\…\scratchpad\multica-ref` (never modified); Bloblex citations are repo-relative to the current on-disk tree, not to `HEAD`. This document is research only — it changes no code.

**Licence.** Multica is Apache-2.0 **plus extra conditions** that forbid embedding it in a distributed product and require Multica branding on derived UI (`THIRD_PARTY_NOTICES.md:37-39`; `docs/PHASE_5_CONTRACT.md:3`). Everything recommended here is therefore **clean-room re-implemented** in Rust/TS, not copied. Any Multica UI chrome must not be reproduced; see the branding note in Area 14 and backlog item A17.

**Method and limits.** Every claim cites a file and line read directly. Multica behaviours that exist only because Multica is a multi-user SaaS (workspaces, projects, role-based agent visibility, cloud telemetry, billing) are marked **[multi-user-only]** and excluded. No Multica behaviour was executed; all Multica evidence is source/test reading. Bloblex "verified shapes" are quoted from `docs/runtime-capabilities.md`, whose status is the Director's.

Paths: **M** = Multica clone-relative; **B** = Bloblex repo-relative.

**Headline finding.** Bloblex's committed Analytics UI (`apps/desktop/src/ui/AnalyticsView.tsx`) calls the RPC `usage.analytics` (`apps/desktop/src/tauri.ts:141-146`), but the daemon has **no such method** — its dispatch table implements only `usage.summary` (`crates/bloblex-daemon/src/main.rs:640`). The contract in `docs/PHASE_5_CONTRACT.md:15-40` is unimplemented on the daemon side, so today the view can only render fixtures. This is the single largest gap and drives P0 items below.

---

## Area 1 — Metric definitions (runs, failed runs, run time, tokens) and how each is computed

### 1. What Multica does
- Six read endpoints power the workspace dashboard, all accepting `?days=N` (default 30, cap 365) and optional `?project_id` (M `server/internal/handler/dashboard.go:15-39`).
- **Run time** is `SUM(EXTRACT(EPOCH FROM (completed_at - started_at)))` over terminal tasks, requiring **both `started_at` and `completed_at`** (M `server/pkg/db/queries/task_usage.sql:208-227`). Queued/running tasks have no finite duration and are excluded.
- **Runs / failed / cancelled**: `COUNT(*)`, `COUNT(*) FILTER (WHERE status='failed')`, `COUNT(*) FILTER (WHERE status='cancelled')`; `cancelled` is deliberately included because a stopped run burned real agent time and tokens (M `task_usage.sql:214-216`, comment `:196-204`).
- **Tokens** are per-(date, provider, model) sums of four mutually exclusive buckets: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` (M `task_usage.sql:130-149`; schema `server/migrations/032_task_usage.up.sql:6-9`).
- **Coverage**: a task is "metered" iff a `task_usage` row exists, regardless of whether token counters are zero — so a provider-reported zero stays distinct from a run that reported nothing (M `task_usage.sql:92-108`, `:238-239`).

### 2. What Bloblex does today
- Contract definitions: **Run** = one turn; **Run time** = `completed_at - created_at` for completed/failed turns, active turns excluded and counted in `activeRuns`; **Failed run** = a turn in state `error`; **Reported usage** = a `usage_events` row with `usage_status IN ('reported','partial')` (B `docs/PHASE_5_CONTRACT.md:7-8`).
- The `turns` table only carries `id, session_id, state, created_at, completed_at` — there is **no `started_at`** (insert at B `crates/bloblex-storage/src/lib.rs:1100`; read at `:1904`). So Bloblex run time is wall-clock including queue/prep, not execution time.
- Cancelled turns are set to state `cancelled` (B `crates/bloblex-daemon/src/main.rs:2028-2040`) but the contract's run time counts only completed/failed, so a cancelled long run contributes **zero** run time and no run count.
- Storage's existing `usage_summary_locked` sums the raw nullable columns with SQL `SUM` over the whole range and does no per-turn null classification (B `crates/bloblex-storage/src/lib.rs:1819-1842`).

### 3. Gap or risk
- **Concrete failure (P1):** a user stops a 40-minute run; Multica would show the 40 min and a cancelled count, Bloblex's contract shows neither, so the Runs KPI and Run-time KPI both under-report the work that actually happened.
- **Concrete failure:** Bloblex's "run time" is wall clock from turn creation, so provider queue/prep time is billed to the agent. Multica anchors on `started_at`. Two runs with identical execution time but different cold-start will look different.
- **Concrete failure:** because the daemon does not implement `usage.analytics`, none of these metrics are computed at all yet for real data.

### 4. Recommendation
**ADOPT** the metric vocabulary and the "metered vs unreported" distinction (already in the contract). **ADAPT** run time to execution time: add a nullable `turns.started_at` (or define `runTimeMs` explicitly as wall time in the UI copy) and include `cancelled` in runs/run time with a `cancelledRuns` field. **ADOPT** an explicit `cancelledRuns` count into `AnalyticsTotals`/series so a stopped run is visible, not silently dropped.

### 5. Priority / effort
P1 / M (schema column + migration + daemon RPC + UI field).

### 6. Invariant
No cost/token value is invented; cancelled time is real measured time, not a fabricated number.

---

## Area 2 — Cost model: provider-authoritative vs rate-table estimate

### 1. What Multica does
- Cost is computed **client-side** from a per-model rate table; the server intentionally keeps `provider` + `model` on the wire so the client can price (M `server/internal/handler/dashboard.go:37-39`, `task_usage.sql:28-33`).
- A row carries both halves: `cost_usd_ticks` (provider's own price, 1e-10 USD) and `uncosted_*_tokens` (tokens the provider did **not** price). The consumer reports `authoritative + estimate(uncosted)` (M `server/migrations/213_task_usage_authoritative_cost.up.sql:1-71`; `packages/views/runtimes/utils.ts:675-702`).
- Ticks are integers to keep sub-cent turn costs exact (M `213_task_usage_authoritative_cost.up.sql:12-16`; `utils.ts:636-638`).
- `estimateCost` returns `authoritative` alone when no rate table entry exists, and **0** when there is neither a rate nor an authoritative figure (M `utils.ts:689-702`) — mitigated by an "unmapped models" diagnostic (M `utils.ts:596-610`) but still a place where an unknown can render as `$0.00`.

### 2. What Bloblex does today
- Contract: **Cost** = provider-reported actual (`reported_cost_minor` with known currency, OpenCode per-turn delta of cumulative session cost) PLUS an API-rate estimate for tokens with no reported cost; valley basis recorded in `usage_valuations` as `actual` / `estimate` / `unknown` (B `docs/PHASE_5_CONTRACT.md:10`).
- `CostBasis` enum already has `ProviderReportedActual`, `ApiRateEstimate`, `SubscriptionFixed`, `LocalFree`, `Unknown` (B `crates/bloblex-usage/src/lib.rs:17-25`).
- The daemon builds the valuation when a usage event arrives: if `reported_cost_minor.is_some()` it records `ProviderReportedActual`, else it calls `estimate()` (B `crates/bloblex-daemon/src/main.rs:1968-1981`).
- `usage_summary_locked` reports `providerReportedCostMinor` and `apiEstimateMinor` as separate single-currency totals (`actual` split from `estimates`), and returns `null` when currencies are mixed via `single_currency_total` (B `crates/bloblex-storage/src/lib.rs:1826-1840`, `:2260-2279`).

### 3. Gap or risk
- **Concrete failure:** Bloblex already separates actual and estimated, which is stronger than Multica's single `estimateCost`. But the contract's `actualMinor`/`estimatedMinor` + `lowerBound` per bucket are not produced by any RPC; only the flat snapshot fields exist. The Analytics UI has no real data source.
- **Concrete failure:** if a partially-reported row is valued, Bloblex's `estimate()` refuses to value at all when input or output is null (`crates/bloblex-usage/src/lib.rs:116-128`), marking `incomplete_usage`; Multica prices whatever buckets exist. Bloblex is the safer choice but can leave cost Unknown for rows that had partially usable data.

### 4. Recommendation
**ADOPT** the authoritative + estimate split and integer minor units (already in Bloblex). **ADAPT** the per-bucket pricing tolerance: value the buckets that are present and mark the total `lowerBound` rather than refusing entirely, while keeping the missing buckets `null`. **SKIP** Multica's fallback of returning `0` when nothing is priced — that would violate "unknown is never zero".

### 5. Priority / effort
P1 / S–M (part of implementing `usage.analytics`).

### 6. Invariant
Unknown values stay `Unknown`/null and set `lowerBound`; never `0` (`docs/PHASE_5_CONTRACT.md:10-11`).

---

## Area 3 — Pricing sources: built-in per-model table, canonicalisation, user overrides

### 1. What Multica does
- Ships a maintained `MODEL_PRICING` table with `input/output/cacheRead/cacheWrite` in USD **per million** for Claude, OpenAI, DeepSeek, Kimi, GLM, Qwen, Grok and Cursor (M `packages/views/runtimes/utils.ts:213-405`).
- Resolution tolerances, in order: strip provider routing prefixes; Claude dot↔dash normalisation; strip trailing dated snapshots/`latest`; strip context tag `[1m]` (M `utils.ts:407-435`, `:521-578`). **No `startsWith` fallback** — every SKU needs its own row so `gpt-5.5-mini` can't inherit `gpt-5.5` (M `utils.ts:196-203`, `:429-430`).
- Provider-qualified keys for generic ids that collide across providers (e.g. `cursor/auto`), with a documented precedence: `provider/…` first, then bare (M `utils.ts:204-212`, `:465-474`).
- User overrides live in a persisted zustand store keyed by the same canonical key; the resolver tries the built-in table first, then the custom store (M `packages/core/runtimes/custom-pricing-store.ts:29-56`; `utils.ts:436-449`).
- Unmapped models are surfaced as a diagnostic only when they still need an estimate (a row that is fully provider-priced is not flagged) (M `utils.ts:587-610`).

### 2. What Bloblex does today
- Two tables exist: `pricing_rules` (a shipped-catalog shape) and `user_pricing_rules` (B `crates/bloblex-storage/src/lib.rs:601`, `:609`).
- **Only `user_pricing_rules` is read or written**: `pricing_list`/`save_pricing` query it (`B crates/bloblex-storage/src/lib.rs:1776-1795`). The `pricing_rules` table is created but never populated or queried anywhere in `crates/` — there is **no shipped rate table**.
- Resolution `resolve_rule_at` matches provider + `canonical_model_id`/`aliases` (case-insensitive) and an `effective_from`/`effective_to` window (end-exclusive) (B `crates/bloblex-usage/src/lib.rs:88-105`; tests `:224-242`). There is no date-snapshot stripping, no context-tag stripping, and no provider-qualification of generic ids.
- `estimate()` returns `Unknown`/`unavailable` when no rule matches, and never zero (B `crates/bloblex-usage/src/lib.rs:106-115`, `:178-181`).

### 3. Gap or risk
- **Concrete failure:** with no shipped table, every real model is unpriced until the user types rates by hand, so the Analytics view would show `Unknown`/`≥` everywhere. That is honest but useless as a first-run experience.
- **Concrete failure:** a Claude result reports `claude-haiku-4-5-20251001` (B `docs/runtime-capabilities.md:210`); without snapshot stripping, a rule registered for `claude-haiku-4-5` misses and cost stays Unknown.
- **Concrete failure:** model ids from OpenCode arrive provider-qualified (`opencode-go/deepseek-v4.1-flash`, B `docs/runtime-capabilities.md:233`), while a user override keyed as `deepseek-v4.1-flash` won't match.

### 4. Recommendation
**ADOPT** a shipped built-in rate table and the canonicalisation tolerances, re-implemented in Rust (which today has no equivalent), with attribution under the clean-room note. **ADAPT** Bloblex's effective-window model (keep it; Multica's static table can't express it) and keep user overrides as the fallback. **ADAPT** provider-qualified keys for generic ids.

### 5. Priority / effort
P1 / M–L (catalog data + resolver rules + tests).

### 6. Invariant
An unpriced model stays `Unknown`, never `0`; free SKUs (known $0 rate) are distinct from unknown ones.

---

## Area 4 — Cache-token pricing and input normalisation

### 1. What Multica does
- Header documents each provider's cache-write convention: Anthropic 5-minute cacheWrite = 1.25× input; DeepSeek/Kimi/GLM/xAI bill no separate cache write, so `cacheWrite` mirrors `input`; OpenAI GPT-5.6+ bills cache writes at 1.25× (M `utils.ts:186-195`).
- Cache read/write are part of the rate-table estimate (`utils.ts:694-701`) and the stacked cost breakdown (`utils.ts:717-737`).
- **Input normalisation** is done at capture time: `normalizeACPTokenUsage` subtracts `cacheReadTokens` from `inputTokens` **only when `totalTokens` proves cached reads are inside input** (`totalTokens == input + output`) (M `server/pkg/agent/acp_usage.go:242-259`). ACP usage snapshots keep field presence separate from values so a reported zero differs from an omitted bucket, and the accumulator takes per-bucket maxima to dedupe equivalent snapshots (M `acp_usage.go:20-110`).
- Provider cost is treated as a cumulative turn total and consolidated by max, so a late/richer report doesn't double-charge (M `acp_usage.go:79-84`, `:117-137`).

### 2. What Bloblex does today
- `normalize_codex` computes `input = total_input - cached_input` when both exist, and keeps `cache_read = cached`, `cache_write = None` (B `crates/bloblex-usage/src/lib.rs:51-75`; test `:170-176`).
- The verified Codex live event has `inputTokens`, `cachedInputTokens`, **and `cacheWriteInputTokens`** (B `docs/runtime-capabilities.md:54`, `:224`), but `normalize_codex` does not subtract `cacheWriteInputTokens`.
- `PHASE_2B_SPEC.md:184` says input = `inputTokens - cachedInputTokens - cacheWriteInputTokens` only when all exist and the subtraction is valid; the code does not yet implement the three-way subtraction.
- OpenCode: prompt-result usage has `inputTokens/outputTokens/thoughtTokens/cachedReadTokens`, cache-write NULL, and `usage_update.cost` is a **cumulative per-session USD total** requiring an exact-decimal per-turn delta keyed by provider update id (B `docs/runtime-capabilities.md:232-233`; `docs/PHASE_2B_SPEC.md:185`).
- `estimate()` refuses to value if a cache rate is missing while cache tokens are present (`crates/bloblex-usage/src/lib.rs:116-128`; test `:201-223`), and treats a zero cache token count as a zero rate (`:129-138`).

### 3. Gap or risk
- **Concrete failure (P1):** on a Codex turn whose event includes `cacheWriteInputTokens`, Bloblex adds those tokens to `input` **and** (if a cache-write rate exists) would price them again as cache-write, or overstates input. Multica's three-way subtraction is the corrected arithmetic.
- **Concrete failure:** if the OpenCode cumulative total is summed rather than delta'd, cost grows quadratically across a session; the spec forbids it (`PHASE_2B_SPEC.md:185`) but the adapter change is not in this tree.

### 4. Recommendation
**ADOPT** the three-way Codex input subtraction (`input = input - cached - cacheWrite` when all present and non-negative) and the "only subtract when the provider's own total proves the shape" guard from `normalizeACPTokenUsage`. **ADOPT** the per-bucket-max dedup idea for any adapter that sees repeated snapshots. **ADOPT** the OpenCode cumulative-cost delta already specified.

### 5. Priority / effort
P1 / S (Codex subtraction) + M (OpenCode delta, already specified).

### 6. Invariant
Buckets stay mutually exclusive so cache tokens are never charged twice; missing buckets stay null.

---

## Area 5 — Unknown/unreported display and the lower-bound rule

### 1. What Multica does
- The UI distinguishes "no rate" from "$0": `collectUnmappedModels` drives a pricing dialog for rows that need an estimate (M `utils.ts:587-610`); the per-model row keeps `cost_usd_ticks` and `uncosted_*` separate so a window mixing both kinds stays whole (M `server/internal/handler/dashboard.go:162-172`).
- There is no explicit "≥" prefix or `lowerBound` flag; the mitigation is the unmapped-models warning plus provider-authoritative cost.
- `uncostedTokens` treats an absent `uncosted_*` field (older backend) as "all tokens need estimating", unless the row already carries an authoritative cost (M `utils.ts:640-673`).

### 2. What Bloblex does today
- Contract's **lower-bound rule**: when any run in scope is unreported or any model is unpriced, cost and tokens are lower bounds, `lowerBound: true`, the UI prefixes `≥` and lists unpriced models / unreported-run count (B `docs/PHASE_5_CONTRACT.md:11`).
- UI implements this thoroughly: `formatBoundNumber`/`formatBoundMoney` return `Unknown` for null and `≥ ` for a bounded known value (B `apps/desktop/src/ui/analyticsFormat.ts:92-108`); `analyticsNotes` builds the note list (B `:168-178`); the view renders that note with `role="note"` (B `apps/desktop/src/ui/AnalyticsView.tsx:142`).
- Tests assert full/partial/empty/unknown rendering, including `≥` and `Unknown` (B `apps/desktop/src/ui/AnalyticsView.mounted.test.tsx:113-162`).

### 3. Gap or risk
- **Concrete risk:** Multica's `estimateCost` returning `0` for a completely unpriced, unreported row (M `utils.ts:689-702`) is exactly what Bloblex forbids. If a porter copies that function, an unknown model renders `$0.00` — a fabricated success.
- **Concrete risk:** the Bloblex lower-bound machinery is UI-only; the daemon must compute `lowerBound`, `unreportedRuns`, and `unpricedModels` or the UI silently shows exact-looking numbers.

### 4. Recommendation
**ADOPT** the `≥` + note UX and the explicit `unpricedModels` list (already built). **SKIP** `estimateCost`'s zero fallback. Make the daemon, not the UI, the source of `lowerBound` (`PHASE_5_CONTRACT.md:11`, invariant "daemon owns state").

### 5. Priority / effort
P0 / M (daemon must emit these fields).

### 6. Invariant
Unknown is never zero; lower bounds are labelled, never presented as exact.

---

## Area 6 — Bucketing and timezones (daily/weekly, DST)

### 1. What Multica does
- Rollups are materialised in **UTC hourly buckets**; the viewer's IANA tz is applied at query time with `DATE(bucket_hour AT TIME ZONE @tz)` so any viewer's day boundary is correct without losing precision (M `server/migrations/101_task_usage_hourly_schema.up.sql:1-55`; `task_usage.sql:112-149`).
- The `@since` cutoff is already the viewer's local start-of-day as a UTC instant (`parseSinceParamInTZ`) and is deliberately **not** re-truncated, because `DATE_TRUNC` would snap back to UTC midnight (M `task_usage.sql:120-126`).
- All four metrics (cost/tokens/time/tasks/errors) slice the same tz boundary so the tabs agree (M `task_usage.sql:187-207`, `:290-291`).
- Weekly folds build `ceil(days/7)` trailing calendar weeks anchored at today-in-tz with pre-zeroed buckets; DST is handled by the tz-aware date helpers (M `packages/views/dashboard/utils.ts:362-417`).

### 2. What Bloblex does today
- Contract: bucketing uses the caller's IANA tz; a bucket starts at local midnight (day) or local Monday midnight (week); DST days are 23/25 h and boundaries are computed in local time, not by adding 24 h (B `docs/PHASE_5_CONTRACT.md:13`).
- The UI computes the window in JS with an explicit two-pass offset correction so DST boundaries land on the local date (B `apps/desktop/src/ui/analyticsFormat.ts:41-72`); fixtures include a DST-week case (B `apps/desktop/src/ui/analyticsFixtures.ts:3`).
- SQLite has no `AT TIME ZONE`; timestamps are stored as RFC3339 strings (B `crates/bloblex-storage/src/lib.rs:599`).

### 3. Gap or risk
- **Concrete failure:** the contract says the **daemon** buckets into `series` (B `PHASE_5_CONTRACT.md:32,39`), but no daemon code exists; if the UI is left to bucket, the local-midnight maths is duplicated and the daemon's `bucketStart` semantics (UTC instant of local bucket start) are unenforced.
- **Concrete failure:** on a DST-transition week a naive per-day loop adding 24 h drifts one hour and can move a run into the wrong day, so daily and weekly charts disagree.

### 4. Recommendation
**ADOPT** the "materialise/bucket neutral, apply viewer tz at read" principle. For Bloblex, **ADAPT** it into a **Rust daemon-side bucketer using `chrono-tz`** (day = local midnight, week = Monday), emitting each bucket as the UTC instant of its local start, exactly as the contract already specifies. Keep the JS helpers only for labels/tooltips.

### 5. Priority / effort
P0 / M (inside the `usage.analytics` implementation).

### 6. Invariant
Bucket boundaries are computed in local time; no fabricated 24 h day.

---

## Area 7 — Hourly rollup tables, dirty queue, backfill jobs; do we need rollups?

### 1. What Multica does
- `task_usage_hourly` is a single UTC materialisation keyed on `(bucket_hour, workspace, runtime, agent, project, provider, model)` with a `UNIQUE NULLS NOT DISTINCT` constraint, plus a watermark state table and a **dirty-key queue** for deletes/re-attributions that the `updated_at` watermark cannot see (M `server/migrations/101_task_usage_hourly_schema.up.sql:37-133`).
- The rollup window function is **idempotent: it REPLACES each dirty bucket with the SUM of all source rows; it does not delta** — so cron + offline backfill can run concurrently safely (M `server/migrations/102_task_usage_hourly_pipeline.up.sql:1-40`; `213_…:77-223`).
- Backfills (`server/internal/taskusagebackfill/backfill.go`) walk monthly slices under a Postgres advisory lock (key 4246) and stamp the watermark from **DB `now() - 5 min`**, never the app clock (M `backfill.go:38-58`, `:131-282`). A migration-time hook runs it before a fail-closed guard (M `backfill.go:4-24`).
- Operators run `server/cmd/backfill_task_usage_hourly` and `server/cmd/backfill_codex_usage_cache`.

### 2. What Bloblex does today
- No rollup table; analytics reads would scan `usage_events` directly. Indexes: `usage_events` on `(runtime_id,timestamp)`, `(session_id,timestamp)`, and `(agent_id,timestamp)` (B `crates/bloblex-storage/src/lib.rs:613-614`, `:433-435`).
- `usage_valuations` is one row per event, joined to `usage_events` for summaries (B `crates/bloblex-storage/src/lib.rs:600`, `:1826`).

### 3. Gap or risk
- **Scale estimate for one desktop user:** assume 5 active sessions/day × 10 turns = 50 turns/day, 1–3 `usage_events` per turn → **50–150 rows/day, ~18k–55k rows/year**. A pathological 100× user (5,000 turns/day) is ~1.8M rows/year. SQLite with the existing `(agent_id,timestamp)` and `(timestamp)` coverage scans and groups that volume in milliseconds.
- **Concrete failure:** porting the hourly rollup machinery (triggers, dirty queue, advisory locks, watermark, pg_cron) would add a large correctness surface (the migration comments record invalidation bugs) for no measurable benefit at this scale.

### 4. Recommendation
**SKIP** the rollup tables, dirty queue, watermark and backfill jobs for Bloblex — the volume does not justify them. **ADOPT** the *idempotency principle* if a cache is ever added: recompute a bucket from source, never delta it. **SKIP** the pg_cron/advisory-lock orchestration entirely.

### 5. Priority / effort
P2 / S (documented decision; no code).

### 6. Invariant
Daemon owns the single SQLite state; no second source of truth.

---

## Area 8 — Filters and range controls

### 1. What Multica does
- Time range (1d/7d/30d/90d…) and project are page-scoped toolbar filters shared by both tabs (M `packages/views/dashboard/components/dashboard-page.tsx:516-524`).
- The picked project is **validated against the freshly fetched project list** so a stale UUID from a previous workspace/project doesn't silently filter everything to empty while the header claims "All projects" (M `dashboard-page.tsx:187-190`).
- The per-date queries over-fetch to cover the full leading week, then daily surfaces trim client-side with `dailyCutoffIso`; the per-agent queries use an exact N-day server cutoff so KPIs and leaderboard share one window (M `dashboard-page.tsx:192-232`, `:269-290`).
- The tab lives in the URL (`?tab=`) so the Errors view is linkable (M `dashboard-page.tsx:159-172`).
- A data-freshness cluster shows the tz + last-refresh time and a refresh button; React Query re-polls on the 5-minute rollup cadence and `keepPreviousData` preserves the layout across range changes (M `dashboard-page.tsx:88-129`, `:463-494`; `packages/core/dashboard/queries.ts:45-65`).

### 2. What Bloblex does today
- Range 7/30/90 and Daily/Weekly toggles; a project `<select>` derived from session project paths (B `apps/desktop/src/ui/AnalyticsView.tsx:27,87-99`; `analyticsProjectChoices` in `rosterSelectors`).
- The request builder sends `from`/`to`/`bucket`/`tz` and optional `projectPath`/`agentId` (B `apps/desktop/src/ui/analyticsFormat.ts:74-90`).
- Range/bucket/project are component state (not URL); loading/error/retry are per view (B `AnalyticsView.tsx:45-52`).

### 3. Gap or risk
- **Concrete failure:** a project saved in a session that no longer exists can be offered as a filter; Bloblex derives choices from live sessions so this is mostly handled, but the contract requires path normalisation (case-insensitive, `/`=`\`, trailing slashes ignored) on the daemon side (`PHASE_5_CONTRACT.md:17`), which is unimplemented — so two spellings of the same path split the leaderboard.
- **Concrete failure:** no tz/refresh affordance means a user cannot tell which timezone a "today" bucket used, and there is no manual refresh.

### 4. Recommendation
**ADOPT** the URL-persisted panel and the stale-filter validation pattern. **ADOPT** the tz + last-updated label and a refresh action. **ADAPT** project normalisation into the daemon RPC (path-key rules already specified in Phase 4).

### 5. Priority / effort
P1 / S (normalisation + label/refresh); URL panel P2/S.

### 6. Invariant
Filters are applied by the daemon so the UI cannot show a different population than the RPC returns.

---

## Area 9 — Leaderboard

### 1. What Multica does
- Per-(agent, provider, model) token rows are fetched, the client folds by `agent_id` and sums cost — the **model dimension is deliberately preserved on the wire** so cost stays computable (M `task_usage.sql:151-185`; `dashboard.go:259-263`; `utils.ts:181-200`).
- Per-agent task counts come from the run-time rollup (a true distinct count) rather than summed token-row counts, which double-count a task spanning models (M `utils.ts:216-279`).
- Hard-deleted agents are folded into one "Deleted agents" bucket rather than dropped, so `sum(rows) == KPI total`; agents the viewer may not see are folded server-side into `__restricted_agents__` (M `utils.ts:281-360`; `dashboard.go:54-130`, `:295-328`) **[multi-user-only for the restricted half]**.
- Ranking emphasises the active metric and bar length tracks it (M `utils.ts:742-784`).

### 2. What Bloblex does today
- Contract leaderboard rows are per-(agent, runtime) with `agentId` nullable for legacy runtime-only sessions, ordered by cost desc then runs (B `docs/PHASE_5_CONTRACT.md:33,39`).
- UI renders proportional bars (`leaderboardFractions`) using the blob's colour, names null agents `Unassigned sessions`, and prefixes `≥` on bounded cost/tokens (B `apps/desktop/src/ui/AnalyticsView.tsx:195-210`; `analyticsFormat.ts:265-278`). A fixture exercises an `agentId:null` row (B `analyticsFixtures.ts:153`).

### 3. Gap or risk
- **Concrete failure:** a blob that ran but has been archived/deleted may vanish, so the leaderboard stops summing to the totals — the exact bug Multica's deleted-agent bucket fixes (M `utils.ts:297-313`).
- **Concrete risk:** Bloblex has no per-agent "unreported runs" reconciliation shown next to cost, so a blob can look cheap simply because it didn't report.

### 4. Recommendation
**ADAPT** the deleted/unknown-agent bucket (fold, don't drop) and per-agent `unreportedRuns`/`unpricedModels` display. **SKIP** the restricted-agents privacy fold **[multi-user-only]**.

### 5. Priority / effort
P1 / S.

### 6. Invariant
Leaderboard rows reconcile with the totals; unknowns labelled, not zeroed.

---

## Area 10 — Trend charts

### 1. What Multica does
- One x-axis with a metric toggle (tokens/cost/time/tasks) and a daily/weekly dimension toggle; empty state is **per metric** so "tokens recorded but no terminal runs" shows Tokens normally while Time/Tasks fall through to empty (M `packages/views/dashboard/components/usage-trend-card.tsx:31-95`, `:113-167`).
- Charts get pre-zeroed weekly buckets so sparse weeks render as empty bars instead of collapsing the axis (M `utils.ts:384-468`).
- Duration is formatted compactly (`formatDuration`) with a "<1m" label (M `utils.ts:503-526`).
- The chart library is an internal component (`runtimes/components/charts`).

### 2. What Bloblex does today
- Plain dependency-free SVG bars with a metric toggle; `chartRects` renders null buckets as a distinct low `analytics-gap` rect, zero as a 2px `analytics-zero` rect (B `apps/desktop/src/ui/analyticsFormat.ts:240-263`; `AnalyticsView.tsx:171-194`).
- `chartSummary` produces a screen-reader summary ("Daily Tokens. Highest … on …; N buckets have no data.") (B `analyticsFormat.ts:229-238`).
- `formatRunTime` uses `Intl.DurationFormat` with a manual fallback (B `analyticsFormat.ts:110-135`).

### 3. Gap or risk
- **Concrete risk:** importing Multica's chart components would carry a charting dependency and Multica's package scopes; Bloblex deliberately has no chart dependency (`PHASE_5_CONTRACT.md:45`).
- **Concrete failure:** if the daemon does not emit every bucket in range (including empties), the gap rendering never appears and missing data is invisible.

### 4. Recommendation
**ADOPT** the per-metric empty state and the null-vs-zero visual distinction (Bloblex already has both) and the weekly pre-zeroing. **SKIP** the chart library; keep the SVG.

### 5. Priority / effort
P2 / S.

### 6. Invariant
Null buckets are visually distinct from zero; no invented zero.

---

## Area 11 — Errors tab and the failure-classification taxonomy

### 1. What Multica does
- **Two-layer taxonomy.** Backend: a canonical `failure_reason` of 26/27 refined values in `server/pkg/taskfailure` — platform-side (`queued_expired`, `runtime_offline`, `runtime_reconnect_timeout`, `runtime_recovery`, `timeout`, `iteration_limit`, `agent_blocked`, `api_invalid_request`, `skill_bundle_unavailable`, `runtime_cli_timeout`, `environment_prepare_failed`, `invalid_task_identity`, `runtime_access_denied`) and 14 `agent_error.*` values for auth/quota/capacity/server/network/process/empty-output/agent-timeout/context-overflow/missing-config/model-not-found/runtime-version/runtime-missing-executable/unknown (M `server/pkg/taskfailure/failure.go:41-314`).
- `Classify(rawError)` maps free-form error text to the 14 agent-side values via ordered case-insensitive substring/regex rules (M `server/pkg/taskfailure/classify.go:78-318`); `NormalizeDaemonReason` upgrades older daemons' coarse labels using a raw-error witness (M `classify.go:523-598`).
- UI: seven display classes in fixed render order `auth, rate_limit, timeout, provider, runtime, agent, other`, with an unknown reason falling through to `other` so class totals always reconcile (M `packages/core/dashboard/failure-class.ts:14-112`).
- Failure rollups ship **every terminal task**, with `failure_reason=''` marking the succeeded bucket, so an error *rate* has matching numerator/denominator; NULL/empty failures collapse to `unclassified`, not success (M `task_usage.sql:270-336`; `dashboard.go:512-528`).
- UI reads top-down: KPIs (failed, rate with denominator, affected agents) → trend by class → class mix (one 100%-stacked bar) with raw wire enums one click away → offenders ranked by count or rate, with a minimum-sample floor for rate (M `packages/views/dashboard/components/errors-tab.tsx:70-196`, `:234-468`; `utils.ts:611-784`).

### 2. What Bloblex does today
- **No failure taxonomy exists.** A failed turn is only `turns.state='error'` (B `crates/bloblex-daemon/src/main.rs:2042-2051`, `:1812-1822`); the human error text lives only in the ephemeral `turn.error` event payload (`{"sessionId","turnId","message"}`) and is not persisted with a reason code.
- The contract's `errors` list is `{turnId, sessionId, agentId, at, message}` — a safe short text, newest first, max 50 (B `docs/PHASE_5_CONTRACT.md:34,39`); no class, no reason.
- Crash recovery marks in-flight turns `error` with no message at all (B `crates/bloblex-storage/src/lib.rs:1488`).
- Budget outcomes are distinct: `BudgetError::Blocked` exists (B `crates/bloblex-budget/src/lib.rs:31-38`), but a blocked turn's reason is not recorded as a failure class.
- Cancellations are `turns.state='cancelled'` (B `main.rs:2028-2040`); permission denials flow through `permission.reply` (B `main.rs:577-616`), not a persisted failure reason.

### 3. Gap or risk
- **Concrete failure (P1):** the Errors tab can list failed runs but cannot answer "what kind of thing broke". A 20-failure spike of provider 401s and a 20-failure spike of local permission denials render identically, so no operator action follows.
- **Concrete failure:** because the error text is not persisted (only emitted), restarting the desktop app loses every failure message; the Errors list would be empty or generic after a relaunch.
- **Concrete risk:** copying `Classify`'s Go regex rules verbatim is both a licence-burdened over-copy and wrong for Bloblex's providers; the *categories*, not the rules, should be reused.

### 4. Recommendation
**ADAPT** the two-layer idea (fine persisted `failure_reason` + coarse display class), re-implemented in Rust with Bloblex's own reason set. Persist a nullable `turns.failure_reason` at turn error/cancel/budget-stop time. Recommended Bloblex classes and assignment from event data:
- `provider` — adapter surfaced a provider 4xx/5xx/network/rate/quota/auth error.
- `permission` — turn ended because a permission request was denied/expired.
- `cancelled` — user/daemon cancellation (`turn.cancelled`).
- `timeout` — adapter timeout / watchdog.
- `budget` — admission blocked by a budget policy.
- `config` — missing model/provider/instruction rejection (`exec.options.rejected`).
- `other` — anything unclassified; never rendered as success.

Map every persisted reason to one class; an unknown reason falls through to `other` (ADOPT the reconcile-not-drop rule). **ADOPT** the succeeded-denominator convention so the Errors rate has a matching denominator.

### 5. Priority / effort
P1 / M–L (persisted reason column + capture points + classifier + UI class aggregation).

### 6. Invariant
No raw provider JSON or prompt text in React; store and show only a safe short message + reason code.

---

## Area 12 — Usage double-counting and reconciliation rules

### 1. What Multica does
- **Cumulative vs delta:** ACP cost is a cumulative turn total consolidated by **max** so a duplicate/late report isn't charged twice; token buckets similarly take per-bucket maxima across equivalent snapshots (M `acp_usage.go:55-110`, `:117-137`).
- **Resume baselines:** Claude's resumed session can carry a cumulative cost-state file; the adapter **subtracts the baseline** so a resumed run reports only its own increment (M `server/pkg/agent/claude_usage_test.go:155-188`), and falls back to per-run usage when no cost state exists (`:190-216`).
- **Dedup by message id:** CodeBuddy/Claude assistant events with the same message id (streamed blocks) are counted once per execution — the seen-id set is per execution, not per backend (M `server/pkg/agent/codebuddy_usage_test.go:80-96`, `:121-140`).
- **Terminal usage overrides fallback:** on both success and failure, a `result` event with `modelUsage` replaces the accumulated assistant-message fallback (`codebuddy_usage_test.go:97-99`).
- **Input normalisation** only when `totalTokens` proves cached reads are inside input (M `acp_usage.go:250-259`).
- The persistence upsert **overwrites** token counters on conflict (correction, not accumulation) and bumps `updated_at` so the rollup recomputes (M `task_usage.sql:1-18`).

### 2. What Bloblex does today
- Verified live shapes (B `docs/runtime-capabilities.md`): OpenCode cost is **cumulative per session** with a per-turn delta required (`:233`); OpenCode prompt result has token buckets (`:232`); Claude success result has `usage`/`modelUsage`/`total_cost_usd` and error-result zeros are unreported, never zero (`:210-211`); Codex has per-turn `tokenUsage` with no cost or model (`:224`).
- Capture rules: dedupe by provider update id (`idx_usage_provider_update`), cumulative snapshots persist only the per-turn delta, zero valid only when a **successful** event explicitly reports it (B `docs/PHASE_2B_SPEC.md:185-187`; index `crates/bloblex-storage/src/lib.rs:164-165`).
- `normalize_codex` subtracts only cached input, not cache-write (B `crates/bloblex-usage/src/lib.rs:51-75`) — see Area 4.
- `insert_usage` upserts by id and `usage_valuations` by usage-event id (B `crates/bloblex-storage/src/lib.rs:1247-1254`).

### 3. Gap or risk
- **Concrete failure (P1):** Codex `cacheWriteInputTokens` not subtracted can double-count those tokens (Area 4).
- **Concrete failure:** if cumulative OpenCode cost is stored raw and later summed, a 10-turn session overstates spend super-linearly.
- **Concrete failure:** Claude resumed sessions: if Bloblex ever receives a cumulative `total_cost_usd`, it must subtract a stored baseline (Multica does) or it will re-bill the whole session on every resume.
- **Concrete risk:** Bloblex's `estimate()` refuses partial rows (`incomplete_usage`) rather than pricing present buckets, so more rows fall to Unknown than Multica's.

### 4. Recommendation
**ADOPT** the reconciliation invariants: cumulative→delta (OpenCode), baseline subtraction (Claude resume), dedup by provider update id (already present), per-execution seen-id scoping, and terminal-usage-overrides-fallback. **ADOPT** the "only subtract cached when the provider total proves the shape" guard. **ADAPT** partial-bucket pricing so a single missing bucket doesn't discard a whole row's cost.

### 5. Priority / effort
P1 / M (capture-path work; partly specified already).

### 6. Invariant
Never sum raw cumulative snapshots; never store raw provider payload as source; corrections overwrite rather than accumulate.

---

## Area 13 — UI patterns: states, accessibility, formatting

### 1. What Multica does
- Loading is a skeleton (`DashboardSkeleton`, M `dashboard-page.tsx:643-651`); empty is a dashed-border centred block with icon + copy (`DashboardEmpty`, `:653-663`); loading/empty are **per tab** so Usage doesn't wait on failure queries (`:292-308`).
- Accessibility: tablist/tab/tabpanel; `NumberFlow` KPIs carry `aria-label` with the raw number; the 100%-stacked mix bar has a text legend and each offender bar has `role="img"` + `aria-label` composition; reason codes are `<code>` raw enums; column headers label each number (M `errors-tab.tsx:347-465`, `:534-589`; `dashboard-page.tsx:577-582`).
- Formatting: `Intl` via `NumberFlow`/`CurrencyNumberFlow`; `formatRate`, `formatDuration`, `formatTokens`, `formatShortDate`; `tabular-nums`.
- Numbers get a locale and a `tzLabel` + `updatedLabel` from `Intl.DateTimeFormat` guarded by try/catch because a stored tz is unvalidated user input (M `dashboard-page.tsx:88-129`).

### 2. What Bloblex does today
- Loading `role="status"` text, error card `role="alert"` with a Try-again button, empty `role="status"`, lower-bound `role="note"`; tablist/tab/tabpanel with roving `tabIndex`; chart bars are focusable with `title` + `aria-label`; a `sr-only` summary paragraph (B `apps/desktop/src/ui/AnalyticsView.tsx:85-108`, `:142-176`).
- Formatting in `analyticsFormat.ts` via `Intl` with `Unknown`/`≥ ` semantics; `tabular-nums` in CSS (B `apps/desktop/src/ui/analytics.css:14`); DST-aware window helpers.
- A mounted test asserts `Unknown`, `≥`, gap names, metric toggles, tz-shifted bucket labels, and error text (B `apps/desktop/src/ui/AnalyticsView.mounted.test.tsx:113-267`).

### 3. Gap or risk
- **Concrete risk:** Bloblex's loading is a text line, not a skeleton; on slow loops the page reflows. Minor.
- **Concrete risk:** Bloblex has no tz/freshness label, so users can't tell which timezone a bucket used or when it was fetched.
- **Concrete failure:** if the daemon sends an unrecognised `quotaState`/`provider`, the UI must not crash; Bloblex `labelize`s and defaults, Multica try/catches its tz label — keep both defensive postures.

### 4. Recommendation
**ADOPT** a lightweight skeleton and the tz/last-updated + refresh cluster. **ADOPT** per-metric/per-panel empty states (Bloblex already has). **SKIP** `NumberFlow` and the component library; keep plain `Intl`. Keep Bloblex's `role=status`/`alert`/`note` and focusable bars.

### 5. Priority / effort
P2 / S.

### 6. Invariant
Stored timezones/labels are treated as untrusted input; formatting never throws the view.

---

## Area 14 — Multi-user / team / billing features that are out of scope, and branding

### 1. What Multica does (all [multi-user-only])
- Workspace membership gates every endpoint; per-agent visibility folds private/system agents into a sentinel id (`dashboard.go:41-45`, `:54-130`, `:115-130`).
- Projects scope rollups (`dashboard.go:132-148`); role-based access (`dashboard.go:118-130`).
- Client telemetry `client_usage_daily` records `install_id`, `client_type`, `os`, `online_count`/`offline_count`, runtime probes (`server/pkg/db/queries/client_usage.sql:1-47`).
- Billing/subscription pages exist under `apps/web/…/billing`.
- Backfill/sweeper jobs exist for fleet-wide data repair (`server/cmd/backfill_*`).

### 2. What Bloblex does today
- Single local user, daemon-owned SQLite; `subscription_plans` exist but are shown separately and never mixed into usage cost (B `docs/PHASE_5_CONTRACT.md:10,35`; `crates/bloblex-storage/src/lib.rs:1838-1840`).
- No workspace, membership, role, install-id or OS telemetry.

### 3. Gap or risk
- **Concrete failure:** porting workspace/role filtering or install-id telemetry would add multi-tenant complexity and privacy surface to a single-user desktop app with no counterpart.

### 4. Recommendation
**SKIP** membership/roles/project-access, restricted-agent folding, client telemetry, billing pages, and fleet backfills as features. **KEEP** subscription display as a separate "[not included in usage cost]" section (already built).

### 5. Priority / effort
P2 / S (documented decision).

### 6. Invariant
Daemon owns state; subscriptions never mixed into usage cost; no secret/telemetry leakage.

### Branding flag for implementers
- Multica dashboard/usage components import from `@multica/ui/*`, `@multica/core/*`, `@multica/views/*`, and the web route is a one-line re-export of `DashboardPage` (M `packages/views/dashboard/components/*.tsx` imports; `apps/web/app/[workspaceSlug]/(dashboard)/usage/page.tsx:1`). **Do not reproduce these package scopes, the i18n `usage` namespace strings, or the page shell/`CollectionPageHeader`.**
- No literal "Multica" product text appears inside the analytics components read for this document (grep of `packages/views/dashboard` and the usage route found only `@multica` import scopes); the wordmark/logo lives in the host shell. Multica's licence requires Multica branding on derived UI (`THIRD_PARTY_NOTICES.md:37-39`), which is precisely why Bloblex must re-implement clean-room and not ship a derived Multica UI.
- Bloblex already records the clean-room boundary (`THIRD_PARTY_NOTICES.md:37-39`); extend that note to list any adopted pricing vocabulary/reason classes.

---

## (a) Prioritised adoption backlog

| ID | Area | Action | Priority | Effort | Bloblex files to change | Multica files to read |
|---|---|---|---|---|---|---|
| A1 | Daemon RPC | Implement `usage.analytics` `{from,to,bucket,tz,projectPath?,agentId?}` → `{range,totals,series,leaderboard,errors,subscriptions}` per the contract, with range validation | P0 | L | `crates/bloblex-storage/src/lib.rs` (new analytics query), `crates/bloblex-daemon/src/main.rs:640` area, `apps/desktop/src/tauri.ts:141-146` | `server/internal/handler/dashboard.go`; `task_usage.sql`; `runtime_usage.sql` |
| A2 | Metrics | Emit per-bucket/per-total `cost{amountMinor,actualMinor,estimatedMinor,lowerBound,currency}`, token buckets, `runTimeMs`, `runs`, `failedRuns`, `cancelledRuns`, `activeRuns`, `unreportedRuns`, `unpricedModels` | P0 | M | `crates/bloblex-storage`, `crates/bloblex-usage`, `apps/desktop/src/analyticsTypes.ts` | `dashboard.go:150-363`; `task_usage.sql:72-268` |
| A3 | Unknown semantics | Compute `lowerBound` in the daemon from unreported runs + unpriced models; never emit 0 for unknown | P0 | S | `crates/bloblex-usage/src/lib.rs`; daemon RPC | `utils.ts:587-702` (as the anti-pattern to avoid) |
| A4 | Bucketing | Rust `chrono-tz` bucketer: local-midnight day, Monday week, UTC `bucketStart`, every bucket emitted | P0 | M | new helper in `crates/bloblex-usage` or `bloblex-daemon` | `101_task_usage_hourly_schema.up.sql:1-55`; `task_usage.sql:112-149` |
| A5 | Failure taxonomy | Persist `turns.failure_reason`; classify provider/permission/cancel/timeout/budget/config/other; succeed bucket for rate | P1 | L | `crates/bloblex-storage/src/lib.rs` (migration + capture), `crates/bloblex-daemon/src/main.rs:1812,2042-2051`, `apps/desktop/src/ui/AnalyticsView.tsx` | `taskfailure/failure.go`; `taskfailure/classify.go`; `failure-class.ts`; `dashboard.go:512-655` |
| A6 | Codex input | Subtract `cacheWriteInputTokens` and `cachedInputTokens` from `input` only when all present/non-negative | P1 | S | `crates/bloblex-usage/src/lib.rs:51-75` | `acp_usage.go:242-259` |
| A7 | Pricing table | Ship a built-in Rust rate table + canonicalisation (provider prefix, Claude dot/dash, dated snapshot, `[1m]`), user overrides as fallback | P1 | L | `crates/bloblex-usage/src/lib.rs`; read from `crates/bloblex-storage/src/lib.rs:601` | `utils.ts:180-578`; `custom-pricing-store.ts` |
| A8 | Cancelled runs | Add `cancelledRuns`; include cancelled in run time/counts (add `turns.started_at`) | P1 | M | storage migration, daemon, `docs/PHASE_5_CONTRACT.md`, `apps/desktop/src/analyticsTypes.ts` | `task_usage.sql:187-268` |
| A9 | Leaderboard | Fold archived/unknown agents into one bucket; show per-agent unreported/unpriced | P1 | S | `apps/desktop/src/ui/analyticsFormat.ts`, `AnalyticsView.tsx` | `utils.ts:281-360`, `:786-819` |
| A10 | Project filter | Daemon-side path normalisation (case-insensitive, `/`=`\`, trailing slash); validate selection | P1 | S | daemon RPC; `apps/desktop/src/ui/rosterSelectors` | `dashboard-page.tsx:187-190`; `dashboard.go:132-148` |
| A11 | Freshness UI | tz + last-updated label and refresh action | P2 | S | `apps/desktop/src/ui/AnalyticsView.tsx`, `analytics.css` | `dashboard-page.tsx:88-129`, `:463-494` |
| A12 | Partial pricing | Price present buckets; mark total lower-bound instead of `incomplete_usage` refusing | P1 | S | `crates/bloblex-usage/src/lib.rs:106-165` | `utils.ts:650-702` |
| A13 | Reconciliation | Cumulative→delta (OpenCode), Claude resume baseline, terminal-overrides-fallback, per-execution dedup | P1 | M | adapters (`crates/bloblex-adapter-*`), `crates/bloblex-usage` | `acp_usage.go`; `claude_usage_test.go:155-242`; `codebuddy_usage_test.go:60-140` |
| A14 | Loading/empty | Skeleton + per-panel empty states | P2 | S | `apps/desktop/src/ui/AnalyticsView.tsx`, `analytics.css` | `dashboard-page.tsx:292-308`, `:643-663`; `usage-trend-card.tsx:88-139` |
| A15 | Errors UI | Class mix bar + raw-reason drill-down + offender list ranked by count/rate with sample floor | P1 | M | `apps/desktop/src/ui/AnalyticsView.tsx`, `analyticsFormat.ts` | `errors-tab.tsx`; `utils.ts:611-784` |
| A16 | URL state | Persist the overview/errors panel in the URL | P2 | S | `apps/desktop/src/ui/AnalyticsView.tsx` | `dashboard-page.tsx:159-172` |
| A17 | Attribution | Extend `THIRD_PARTY_NOTICES.md` with adopted analytics vocabulary/reason classes; confirm no Multica UI chrome/strings copied | P1 | S | `THIRD_PARTY_NOTICES.md` | `apps/web/…/usage/page.tsx:1`; clean-room note reference |
| A18 | Tests | Daemon reconciliation fixture, null-never-zero, DST-week, week-Monday, lower-bound, unknown price | P0 | M | `crates/bloblex-storage`, `crates/bloblex-usage`, `crates/bloblex-daemon` tests | `task_usage.sql` rollups; `failure-class.test.ts` |

## (b) Multica behaviours that must NOT be adopted

1. **`estimateCost` returning `0` for an unpriced, unreported row** (M `utils.ts:689-702`) — violates "unknown is never zero". Bloblex must keep null/`Unknown`.
2. **Client-side cost computation from the wire model dimension** (M `dashboard.go:37-39`) — Bloblex's daemon owns state and pricing (`crates/bloblex-usage`); the UI must not become the ledger.
3. **Hourly rollup table + dirty queue + watermark + pg_cron/advisory-lock backfills** (M migrations 101/102/213; `server/internal/taskusagebackfill`) — unnecessary at single-desktop volume (Area 7) and a large correctness surface.
4. **Workspace/project role-based visibility and the `__restricted_agents__` fold** (M `dashboard.go:54-130`) — **[multi-user-only]**; no counterpart in a single-user app.
5. **Client telemetry `client_usage_daily` (install id, OS, online/offline probes)** (M `client_usage.sql:1-47`) — privacy surface with no single-user need.
6. **Billing/subscription SaaS pages** (M `apps/web/…/billing`) — out of scope; Bloblex only *displays* subscription fees separately and never mixes them into cost.
7. **Fleet backfill commands** (`server/cmd/backfill_*`) — no fleet.
8. **Copying Multica's exact `Classify` regex/substring rules** (M `classify.go:78-318`) — licence-burdened over-copy and wrong provider set; reuse categories, re-derive rules.
9. **Any Multica package scopes, i18n copy, layout, logo or product name** (`@multica/*`, `DashboardPage` shell) — clean-room requirement (`THIRD_PARTY_NOTICES.md:37-39`).
10. **Copying the chart component library** — Bloblex keeps a dependency-free SVG (`PHASE_5_CONTRACT.md:45`).
11. **Storing or forwarding raw provider usage payloads to React** — Bloblex invariant; `insert_usage` writes `raw` but the analytics RPC/`normalizeAnalytics` must copy contract fields only (`apps/desktop/src/ui/analyticsFormat.ts:332-333`).

## (c) SQL / algorithm notes worth porting (short)

- **Idempotent recompute, not delta.** For any future cache: recompute a key as `SUM` of all source rows, never `+=` a delta (M `102_task_usage_hourly_pipeline.up.sql:12-20`).
- **Succeeded bucket as denominator.** Ship `failure_reason=''` rows for successes so error rate = failed/total on identical filters; NULL/empty failure → `unclassified`, not success (M `task_usage.sql:270-309`).
- **Coverage by row existence.** "Metered" = a usage row exists, regardless of zero counters (M `task_usage.sql:92-108`).
- **Cumulative→delta.** `delta = current_cumulative - stored_prev_cumulative`; first event's delta is the total; key by provider update id; persist latest total in the same transaction (B `PHASE_2B_SPEC.md:185`).
- **Input normalisation guard.** Subtract cached (and cache-write) from input only when the provider's own `total == input + output` proves the containment (M `acp_usage.go:250-259`).
- **Dedupe by message id per execution**, not per backend; terminal result overrides the accumulated fallback (M `codebuddy_usage_test.go:80-99`, `:121-140`).
- **Local-day bucket.** day start = local midnight; week start = local Monday midnight; emit the bucket start as a UTC instant; never add 24 h across DST (B `PHASE_5_CONTRACT.md:13`; implement with `chrono-tz`).
- **Canonical pricing keys.** Try provider-qualified candidate first, then bare; strip routing prefix, Claude dot/dash, dated snapshot, `[1m]`; no `startsWith` fallback (M `utils.ts:465-578`).

## (d) UNVERIFIED items

- No Multica behaviour was executed. All Multica findings are source/test reading; runtime latency and exact wire payloads are inferred from Multica's comments and fixtures.
- Bloblex's `usage.analytics` is absent from the daemon dispatch table at the time of writing (`crates/bloblex-daemon/src/main.rs:342-741`); a concurrent lane may add it. The UI-to-RPC call is confirmed at `apps/desktop/src/tauri.ts:141-146`.
- Bloblex's `pricing_rules` (non-user) table is created (`crates/bloblex-storage/src/lib.rs:601`) but no read/write was found in `crates/`; whether a seed is planned elsewhere was not found.
- Whether Bloblex adapters actually emit `UsageReport` with the verified field sets is not proven by this document; `docs/PHASE_2B_SPEC.md` states the intended mapping, and `crates/bloblex-agent-core`/adapters are being edited by other lanes. Citations are to the working tree at write time.
- The `turns` table columns were verified from the insert/select statements (`crates/bloblex-storage/src/lib.rs:1100`, `:1904`); the full migration DDL was not read.
- Multica's exact failure taxonomy counts differ between comments (26 vs 27 reasons, 14 vs 21 sub-reasons); the canonical list in `failure.go:279-314` has 27 entries and is the one cited.
- Multica's chart components (`packages/views/runtimes/components/charts`) were referenced but not read line by line; only their consumer interfaces were inspected.
- Whether `Intl.DurationFormat` exists in the target webview is handled by a runtime feature check in `apps/desktop/src/ui/analyticsFormat.ts:122-128`; not exercised here.

===REPORT===
1. P0 findings (one line each): P0 — Bloblex's committed Analytics UI calls the RPC `usage.analytics` (`apps/desktop/src/tauri.ts:141-146`) but the daemon has no such method (only `usage.summary`, `crates/bloblex-daemon/src/main.rs:640`), so the view renders fixtures, not real data. P0 — the daemon must emit per-bucket `lowerBound`/`unreportedRuns`/`unpricedModels` and never a zero for an unknown (Multica's `estimateCost` fallback at `utils.ts:689-702` is the anti-pattern Bloblex forbids). P0 — bucketing must be implemented daemon-side in local time (day/week, DST-safe, every bucket emitted) because SQLite has no `AT TIME ZONE` and the contract assigns `series` to the daemon (`docs/PHASE_5_CONTRACT.md:32,39`). P1 findings (one line each): P1 — no failure taxonomy is persisted, so the Errors tab cannot classify provider/permission/cancel/timeout/budget failures (`crates/bloblex-daemon/src/main.rs:2042-2051`). P1 — Codex `cacheWriteInputTokens` is not subtracted from input (`crates/bloblex-usage/src/lib.rs:51-75`), risking double counting. P1 — cancelled runs contribute zero run time/count (`docs/PHASE_5_CONTRACT.md:7`), hiding real work. P1 — no shipped pricing table (`pricing_list` reads only `user_pricing_rules`, `crates/bloblex-storage/src/lib.rs:1776-1782`), so every model is Unknown until hand-priced. P1 — `estimate()` refuses partial rows (`crates/bloblex-usage/src/lib.rs:116-128`) instead of pricing present buckets. P1 — OpenCode cumulative cost and Claude resume baselines need the delta/subtraction reconciliation Multica implements (`acp_usage.go:79-84`, `claude_usage_test.go:155-188`).
2. Areas covered: 14.
3. Adoption backlog size: 18 items (A1–A18).
4. UNVERIFIED: no Multica behaviour executed (source/test reading only); Bloblex `usage.analytics` absent but may be added by another lane; `pricing_rules` seed location unknown; adapter `UsageReport` emission not proven (adapters under other lanes); `turns` full DDL not read (columns inferred from statements); Multica reason count differs across comments; Multica chart internals not read; `Intl.DurationFormat` availability not exercised.
===END REPORT===
