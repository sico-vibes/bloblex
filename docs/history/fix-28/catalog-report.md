# FIX28 part 1 (WP1): model catalog cache — implementation report

> **What this is:** Implementation report for FIX28 part 1 (WP1): the model catalog cache.
> **Status:** historical
> **Last updated:** 2026-10-16

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, worktree `C:\fx41`, branch `lane/fix28-wp1`.
Spec: `docs/history/fix-28/catalog-spec.md`. Director reviews, runs the gates and commits.
No `git commit`, no push, no `AGENTS.md` edits, no UI component/CSS changes.

Status: implemented, all listed gates green. The lane did **not** run `git commit`.

## What changed

### New module `crates/bloblex-daemon/src/catalog.rs`

The whole catalog path moved out of `main.rs` into `catalog.rs`:

- `CatalogCache` (held as `AppState.catalog: Arc<CatalogCache>`) replaces the
  `MODEL_CATALOG_CACHE` static. It holds:
  - `entries: StdMutex<HashMap<String, Entry>>` — `Entry { fetched: Instant,
    cached_at: DateTime<Utc>, value, persisted, stale }`;
  - `failures: StdMutex<HashMap<String, Failure>>` — the negative cache;
  - `inflight: Mutex<HashMap<String, Arc<Mutex<()>>>>` — the single-flight locks.
  - Lifetimes are injectable (`CatalogCache::new(fresh, stale, fallback,
    failure)`) so tests can exercise staleness without real waits.
- `Mode { Fresh, Refresh, CachedOnly }`, `Served { value, stale, cached_at }`.
- `get(st, runtime, workflow_override, model_hint, mode) -> Result<Option<Served>,
  DispatchError>` is the single entry point; `resolve_probe` computes the
  provider/workflows/hint/key.`catalog_probe_args` moved here unchanged.
- `prewarm_all(st)` warms every usable runtime two at a time and emits
  `runtime.models.changed` when a warmed list differs from the previous one.
- `CatalogCache::invalidate_all()` marks every entry stale (keeping its value)
  and clears the negative cache.

Freed from `main.rs` (deleted): `MODEL_CATALOG_CACHE`, `catalog_key`,
`catalog_probe_args`, `fetch_model_catalog`, `fetch_model_catalog_for`.
`OnceLock` left the `std` import set; the test-only `StdMutex` import is now
`#[cfg(test)]` (it is used only by the daemon test module).

### Key

`catalog_key(runtime)` (`id|executablePath|version|launchArgs|profileId`) +
`|claude-workflows=<bool>` + `|model=<hint>` **only for provider `claude`**.
Codex and OpenCode drop the hint, so one probe serves every model. Claude keeps
it because its `get_settings` answer depends on the model.

### Entries and lifetimes

- Fresh 15 min (`FRESH_TTL`); stale-but-served up to 7 days (`STALE_TTL`).
- A catalog with `fallback: true` or `validated: false` is memory-only for 60 s
  (`FALLBACK_TTL`) and is **never** written to disk.
- A failed probe is remembered for 30 s (`FAILURE_TTL`, the negative cache) and
  the same error is returned during that window.
- A SQLite hit counts as stale: the value is served and a refresh runs.

### Single-flight

`fetch` takes the per-key `Arc<Mutex<()>>` (created under the `inflight` map
lock), re-checks the cache, then probes. Two concurrent misses on one key run
one adapter call. `Refresh` joins an already-in-flight probe, and also accepts a
result fetched after it arrived (same pattern as `refresh_runtime_discovery`).

### Persistence

New table via `ensure_model_catalog_schema` in `crates/bloblex-storage/src/lib.rs`,
called with the other `ensure_*` functions (all five open paths) and with **no**
`user_version` bump:

```sql
CREATE TABLE IF NOT EXISTS model_catalog_cache(
  key TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK(json_valid(value_json))
);
```

New `Storage` functions: `catalog_cache_get(key) -> Option<(fetched_at, Value)>`,
`catalog_cache_put(key, runtime_id, provider, fetched_at, &Value)`,
`catalog_cache_clear(runtime_id: Option<&str>)`. The `settings` table is not
used.

### Boot (`run()`)

1. `load_saved_runtimes(&st)` seeds `st.runtimes` from the saved `runtimes` rows
   before discovery, so a send right after boot resolves its runtime;
   `validate_spawn_target` still guards a missing executable.
2. After `refresh_runtime_discovery` completes, the discovery task calls
   `catalog::prewarm_all` (usable status in `online|ready|available|connected`
   and not `unauthenticated`, two at a time, each provider's base key — Claude
   defaults to `sonnet`).
3. `prewarm_one` emits `runtime.models.changed { runtimeId }` only when the model
   ids / `supportedThinking` / `serviceTiers` differ from the previous list.

### Invalidation

`runtime.refresh` now calls `st.catalog.invalidate_all()`, then refreshes
discovery, then spawns `catalog::prewarm_all` in the background.

### Response

`runtime.models` adds `"stale": bool` and `"cachedAt": <ISO string>`;
`fetchedAt` is unchanged.

### Remote tier

`runtime.models.changed` added to `EVENT_POLICY` in
`apps/desktop/src/remote/remoteTiers.ts` as `allow` (it carries only a runtime
id), and to the reviewed-allowlist expectation in
`apps/desktop/src/remote/remoteTiers.parity.test.ts`.

## Call sites switched to `CachedOnly`

| Site | Function | Path served |
| --- | --- | --- |
| Send / preflight | `validate_exec_catalog` | `validate_exec_catalog` returns no catalog on a miss, preserving today's "skip validation when the catalog is unavailable". The "Choose a concrete model before sending a prompt." rule still fires when a cached validated catalog is present. |
| New session / resume | `resolve_session_model_lock` | `new_session` and the no-lock branch of `resume_session`. |
| Resume migration | legacy-lock migration in `resume_session` | `normalize_legacy_session_model_lock` still runs when a cached validated catalog is present. |
| Effort capability | `opencode_thinking_support` | `runtime.capabilities` for OpenCode. |
| `new_session` preflight | `preflight_exec_options` → `validate_exec_catalog` | Same as the send path. |

`session_prompt_impl`'s structure was **not** changed (that is WP2); only its
preflight catalog read changed mode, through `validate_exec_catalog`.

Sites that kept waiting (`Fresh`) or force a probe (`Refresh`):

- `runtime.models` (no `refresh`) → `Fresh`; with `refresh: true` → `Refresh`.
- `agent.create` (`agent_create_from_rpc`), `agent.update`,
  `validate_agent_catalog` → `Fresh`.

## Tests added (daemon test module `phase2a_tests`)

A counting fake adapter `CatalogProbeAdapter` (counts `model_catalog`, optional
delay, optional failure, fallback mode) backs these:

- `catalog_single_flight` — two concurrent `Fresh` reads on one key → one probe.
- `catalog_key_ignores_model_hint_except_claude` — Codex keys are equal across
  hints; Claude keys differ.
- `catalog_cached_only_never_waits` — a miss returns `None` at once and starts
  exactly one background refresh; further reads join it; the refreshed value is
  then served.
- `catalog_serves_stale_then_refreshes` — a value past its fresh window is served
  stale and a background refresh replaces it.
- `catalog_persists_across_restart` — a fresh `CatalogCache` on the same database
  serves the persisted catalog as stale without a new probe.
- `catalog_refresh_rpc_invalidates` — `invalidate_all` (what `runtime.refresh`
  calls) makes the next `Fresh` read probe again.
- `catalog_fallback_not_persisted` — a `fallback: true` catalog is not written.
- `catalog_failure_negative_cached_30s` — a failure is returned for the whole
  window without restarting the CLI; after the window it is retried.
- `boot_loads_saved_runtimes` — `load_saved_runtimes` fills `st.runtimes` from
  the saved rows.

## Existing tests changed (not deleted)

- `state()` — the `AppState` helper now constructs
  `catalog: Arc::new(catalog::CatalogCache::default())`.
- `claude_catalog_probe_targets_bloblex_sonnet_default_and_keys_workflows_to_that_probe`
  — calls `catalog::catalog_probe_args` (the function moved module).
- `session_lock_pins_speed_and_permission_mode_without_a_model_change` — the
  catalog is now read `CachedOnly` and was not warmed, so the unknown speed
  `"warp"` would no longer be rejected. The test now warms it with one
  `runtime.models { refresh: true }` call first, so the cached validated catalog
  still rejects `"warp"` and accepts `"priority"`.
- `opencode_thinking_capability_follows_the_selected_models_catalog_levels` —
  `runtime.capabilities` reads `CachedOnly`, so the test now warms the cache with
  `runtime.models { refresh: true }` first (OpenCode's key ignores the model
  hint, so one warm serves both models).

No test relied on the literal 60-second window or on the per-model Codex/OpenCode
keys, so no other update was needed. The old tests that warmed via
`runtime.models { refresh: true }` (`existing_session_catalog_and_workflow_…`,
`model_effort_speed_updates_…`, `claude_catalog_offers_ultracode_…`,
`runtime_models_dispatch_applies_presentation_overlay_…`) still pass unchanged,
because `Refresh` always probes.

## Gates

Run from `C:\fx41` with the lane's `CARGO_TARGET_DIR` / `RUST_MIN_STACK`.

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — **all green**. Daemon `bitbotsd` 166 passed / 0 failed; storage 92 passed;
  runtime 33; adapter/agent/protocol/security/usage/speech suites all green; no
  failures, no ignored.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` —
  **`Finished` with no warnings** (none of my code and no pre-existing warnings
  surfaced). Nothing to report separately.
- `cd apps/desktop && npx tsc -b` — **clean** (no output).
- `cd apps/desktop && npx vitest run src/remote` — **3 files / 47 tests passed**,
  including `remoteTiers.parity.test.ts` (method parity + event policy parity).

Note on the shared `CARGO_TARGET_DIR`: it is shared with the other lane, and a
daemon build can pick up a stale `bloblex-storage` artifact produced from the
other worktree (fingerprint collision on the identical package version). Touching
`crates/bloblex-storage/src/lib.rs` (or building `-p bloblex-storage` in the same
invocation) forces the rebuild. This is an environment artefact, not a source
issue.

## Verified by tests vs not verified

Verified by tests (fakes):

- single-flight, keying (hint only for Claude), `CachedOnly` non-waiting, stale
  serving plus background refresh, negative caching, invalidation, memory-only
  fallback, persistence across a cache restart, boot roster loading.

Not verified by tests:

- Real CLI timings (Claude 2–8 s, Codex 5 s, OpenCode up to 20 s) and the actual
  end-to-end "instant after boot" feel — the tests use fake adapters, so no real
  `claude`/`codex`/`opencode` process was started.
- `prewarm_all` emitting `runtime.models.changed` only on a real change (it is
  exercised indirectly; no direct assertion that the event is emitted).
- The full `run()` boot ordering (socket bind, discovery, prewarm) and the
  `runtime.refresh` dispatch arm end to end: those call `bloblex_runtime::discover()`
  (real CLIs), so only the extracted `load_saved_runtimes` and
  `invalidate_all` helpers are unit-tested.
- The desktop UI's use of the new `stale`/`cachedAt` fields and the
  `runtime.models.changed` event (Director's catalog store, WP1 UI).
