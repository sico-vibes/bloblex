# FIX28 part 1 (WP1): a model catalog cache that never makes the user wait

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort. Director reviews, runs the gates and commits. **Do not run `git commit`.** Work only in this worktree.

Read first: `AGENTS.md`, then `crates/bloblex-daemon/src/main.rs` around `MODEL_CATALOG_CACHE` (line ~50), `catalog_key`, `catalog_probe_args`, `fetch_model_catalog`, `fetch_model_catalog_for`, `runtime_models`, `validate_agent_catalog`, `validate_exec_catalog`, `opencode_thinking_support`, `resolve_session_model_lock`, `resume_session`, the `runtime.refresh` dispatch arm, and `run()`. Plan: `C:\Users\Sico Vibes\.claude\plans\robust-dazzling-taco.md`, Part 3 "WP1".

## Why

Today every cache miss starts a CLI (Claude 2-8 s, Codex app-server 5 s, OpenCode `opencode models --verbose` up to 20 s). The cache lives 60 s, its key includes the model hint for every provider (so Codex and OpenCode probe once per model although the probe is identical), concurrent misses each start a CLI, and the send, resume and preflight paths wait on probes. The owner wants model and effort switching, and sending, to feel instant after boot.

## Design

Move the catalog code into a new module `crates/bloblex-daemon/src/catalog.rs` and hold the cache in `AppState` (`st.catalog: Arc<CatalogCache>`), replacing the `MODEL_CATALOG_CACHE` static. Update the test `state()` helper accordingly.

### Key
`catalog_key(runtime)` + `|claude-workflows=<bool>` + **only for provider `claude`** `|model=<hint>`. Claude's `get_settings` reports `ultracodeAvailable` per model (`crates/bloblex-adapter-claude/src/lib.rs` ~974-1000), so Claude keeps the hint; Codex and OpenCode drop it.

### Entries and lifetimes
- `Entry { fetched: Instant, at: DateTime<Utc> (or the catalog's fetchedAt string), value: Value, persisted: bool }`.
- **Fresh** for 15 minutes. **Stale** values may be served for up to 7 days.
- A catalog with `fallback: true` or `validated: false` is kept in memory only, for 60 s, and **never** written to disk.
- **Failures:** remember for 30 s (negative cache) so a broken CLI is not restarted on every call; return the same error during that window.

### Single-flight
`inflight: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>`. A fetch locks the key's mutex, re-checks the cache, then probes. Two concurrent misses on one key run **one** adapter call.

### Modes
`catalog::get(st, runtime, workflow_override, model_hint, mode)` where `mode` is:
- `Fresh`: serve if fresh, else probe (single-flight). Used by `runtime.models` (no refresh) and `agent.create` / `validate_agent_catalog`.
- `Refresh`: always probe (joins one already in flight). Used by `runtime.models { refresh: true }`.
- `CachedOnly`: never waits. Returns fresh or stale or `None`; when stale or missing it spawns one background refresh (single-flight). Used by every send, resume or preflight path:
  - `validate_exec_catalog` (`None` keeps today's behaviour of skipping validation),
  - `resolve_session_model_lock`,
  - the legacy-lock migration inside `resume_session` (~line 1853),
  - `opencode_thinking_support`,
  - the `new_session` preflight.
  
  Keep the existing rule in `validate_exec_catalog` ("Choose a concrete model before sending a prompt.") working with a cached validated catalog.

### Persistence
Add `ensure_model_catalog_schema` in `crates/bloblex-storage/src/lib.rs`, called with the other `ensure_*` functions (no `user_version` bump):

```sql
CREATE TABLE IF NOT EXISTS model_catalog_cache(
  key TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK(json_valid(value_json))
);
```

Storage functions: `catalog_cache_get(key) -> Option<(fetched_at, Value)>`, `catalog_cache_put(key, runtime_id, provider, fetched_at, &Value)`, `catalog_cache_clear(runtime_id: Option<&str>)`. Do not use the `settings` table (it is returned whole to the UI, remote and backup).

On an in-memory miss, look in the database; a database hit counts as **stale** (serve it, refresh in the background).

### Boot
In `run()`:
1. Before discovery finishes, load `st.runtimes` from the saved `runtimes` rows so a send right after boot does not fail with "runtime is not installed". `validate_spawn_target` still guards a missing executable.
2. After `refresh_runtime_discovery` completes, run `catalog::prewarm_all(&st)` in the background: every runtime whose status is usable (check the exact status/auth strings in `bloblex-runtime` and the UI's `runtimeUsable`) and not signed out, **two at a time**, with each provider's base key (Claude: the workflows setting with hint `sonnet`, as today's default).
3. Emit `runtime.models.changed { runtimeId }` only when a refreshed list differs from the previous one (compare the model ids and their `supportedThinking`/`serviceTiers`).

### Invalidation
`runtime.refresh` marks every entry stale (keep values), clears the negative cache, then starts `prewarm_all` in the background.

### Response
`runtime.models` adds `"stale": bool` and `"cachedAt": <ISO string>` to its result. Keep `fetchedAt` unchanged.

### Remote tier
Add the event `runtime.models.changed` to the event policy in `apps/desktop/src/remote/remoteTiers.ts` as allowed (it carries only a runtime id). `npx vitest run src/remote` must stay green; the parity test reads every `.emit("…")` in the daemon sources.

## Tests (in the daemon test module, with a counting fake adapter)

- `catalog_single_flight`: two concurrent `get` on one key → one adapter `model_catalog` call.
- `catalog_key_ignores_model_hint_except_claude`.
- `catalog_cached_only_never_waits`: miss → `None` immediately, and exactly one background refresh starts.
- `catalog_serves_stale_then_refreshes`.
- `catalog_persists_across_restart`: new `CatalogCache`, same DB → served as stale.
- `catalog_refresh_rpc_invalidates`.
- `catalog_fallback_not_persisted`.
- `catalog_failure_negative_cached_30s` (use a controllable clock or a short duration constant you can override in tests).
- `boot_loads_saved_runtimes` (runtimes available before discovery).

Existing tests that relied on the 60 s cache or on per-model Codex/OpenCode keys must be updated, not deleted. Explain each change in the report.

## Do not
- Change any adapter's probe behaviour or timeouts.
- Touch `session_prompt_impl`'s structure (that is WP2, next). Only switch its catalog calls to `CachedOnly`.
- Log catalog contents beyond counts.

## Gates (run them; paste summaries into the report)
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` (report pre-existing warnings separately)
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote`

Set `CARGO_TARGET_DIR` to the path the brief gives you.

## Report
Write `docs/FIX28_CATALOG_REPORT.md`: files and functions changed, the call sites switched to `CachedOnly` (list them), tests added and changed, gate summaries, and what is verified by tests versus not verified (for example real CLI timings).
