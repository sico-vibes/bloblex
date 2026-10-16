//! Model catalog cache.
//!
//! A catalog probe starts a provider CLI (Claude 2–8 s, Codex app-server 5 s,
//! OpenCode `models --verbose` up to 20 s), so the daemon caches the result and
//! never makes an execution path wait on one. This module owns the cache that
//! replaces the old 60-second `MODEL_CATALOG_CACHE` static:
//!
//! - entries are keyed by runtime plus the only two inputs that change a probe
//!   (the Claude workflows setting, and the model hint for Claude alone);
//! - concurrent misses on one key join a single probe;
//! - reads are fresh for 15 minutes, stale-but-served for up to 7 days, and a
//!   database hit counts as stale so a restart begins warm;
//! - a failed probe is remembered for 30 seconds so a broken CLI is not
//!   restarted on every call;
//! - `CachedOnly` reads never wait: they return what is cached (or nothing) and
//!   start one background refresh.

use crate::{
    adapter_for, claude_workflows_enabled, derr, model_presentation, provider_display_name,
    runtime_from, AppState, DispatchError,
};
use axum::http::StatusCode;
use bloblex_agent_core::AdapterError;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

/// A cached catalog is fresh for this long before a probe is preferred.
pub const FRESH_TTL: Duration = Duration::from_secs(15 * 60);
/// A persisted catalog may still be served for this long while it refreshes.
pub const STALE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// A fallback or unvalidated catalog is memory-only for this long, never persisted.
pub const FALLBACK_TTL: Duration = Duration::from_secs(60);
/// A failed probe is remembered for this long so a broken CLI is not restarted.
pub const FAILURE_TTL: Duration = Duration::from_secs(30);

/// How a caller wants the cache treated.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// Serve a fresh value, otherwise probe (joining one already in flight).
    Fresh,
    /// Always probe (joining one already in flight).
    Refresh,
    /// Never wait: return fresh or stale or `None`, and refresh in the background.
    CachedOnly,
}

/// A catalog served from the cache. `stale` marks a value past its fresh window
/// (served while a background refresh runs); `cached_at` is when the daemon
/// stored it.
pub struct Served {
    pub value: Value,
    pub stale: bool,
    pub cached_at: DateTime<Utc>,
}

#[derive(Clone)]
struct Entry {
    fetched: Instant,
    cached_at: DateTime<Utc>,
    value: Value,
    persisted: bool,
    /// Explicitly invalidated (or loaded from disk): serve as stale, never fresh.
    stale: bool,
}

#[derive(Clone)]
struct Failure {
    at: Instant,
    error: DispatchError,
}

/// The inputs that decide one probe and its cache key.
pub(crate) struct Probe {
    pub(crate) provider: String,
    pub(crate) workflows: bool,
    pub(crate) hint: Option<String>,
    pub(crate) key: String,
}

/// The daemon-wide catalog cache, held as `AppState.catalog`.
pub struct CatalogCache {
    fresh: Duration,
    stale: Duration,
    fallback: Duration,
    failure: Duration,
    entries: StdMutex<HashMap<String, Entry>>,
    failures: StdMutex<HashMap<String, Failure>>,
    inflight: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Default for CatalogCache {
    fn default() -> Self {
        Self::new(FRESH_TTL, STALE_TTL, FALLBACK_TTL, FAILURE_TTL)
    }
}

impl CatalogCache {
    /// Lifetimes are injectable so tests can exercise staleness without waiting.
    pub fn new(fresh: Duration, stale: Duration, fallback: Duration, failure: Duration) -> Self {
        Self {
            fresh,
            stale,
            fallback,
            failure,
            entries: StdMutex::new(HashMap::new()),
            failures: StdMutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
        }
    }

    fn read_entry(&self, key: &str) -> Option<Entry> {
        self.entries.lock().ok()?.get(key).cloned()
    }

    fn fresh_ttl(&self, persisted: bool) -> Duration {
        if persisted { self.fresh } else { self.fallback }
    }

    fn stale_ttl(&self, persisted: bool) -> Duration {
        if persisted { self.stale } else { self.fallback }
    }

    fn served(entry: &Entry, stale: bool) -> Served {
        Served { value: entry.value.clone(), stale, cached_at: entry.cached_at }
    }

    /// A value still inside its fresh window.
    fn fresh_value(&self, key: &str) -> Option<Served> {
        let entry = self.read_entry(key)?;
        if entry.stale { return None; }
        (entry.fetched.elapsed() < self.fresh_ttl(entry.persisted)).then(|| Self::served(&entry, false))
    }

    /// A value still usable, fresh or stale. Stale entries are bounded by the
    /// wall-clock cache time because they may have been loaded from disk.
    fn usable_value(&self, key: &str) -> Option<Served> {
        let entry = self.read_entry(key)?;
        if !entry.stale {
            let age = entry.fetched.elapsed();
            if age < self.fresh_ttl(entry.persisted) { return Some(Self::served(&entry, false)); }
            if age < self.stale_ttl(entry.persisted) { return Some(Self::served(&entry, true)); }
            return None;
        }
        let age = Utc::now().signed_duration_since(entry.cached_at).to_std().unwrap_or_default();
        (age < self.stale_ttl(entry.persisted)).then(|| Self::served(&entry, true))
    }

    fn failure(&self, key: &str) -> Option<DispatchError> {
        let failure = self.failures.lock().ok()?.get(key).cloned()?;
        (failure.at.elapsed() < self.failure).then_some(failure.error)
    }

    fn remember_failure(&self, key: &str, error: DispatchError) {
        if let Ok(mut failures) = self.failures.lock() {
            failures.insert(key.to_owned(), Failure { at: Instant::now(), error });
        }
    }

    fn clear_failure(&self, key: &str) {
        if let Ok(mut failures) = self.failures.lock() { failures.remove(key); }
    }

    fn insert(&self, key: &str, value: Value, stale: bool) -> DateTime<Utc> {
        let cached_at = Utc::now();
        let persisted = value["fallback"] != true && value["validated"] == true;
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(key.to_owned(), Entry { fetched: Instant::now(), cached_at, value, persisted, stale });
        }
        cached_at
    }

    /// Look in the SQLite mirror. A database hit counts as stale.
    fn load_persisted(&self, st: &AppState, key: &str) -> Option<Served> {
        let (fetched_at, value) = st.db.catalog_cache_get(key).ok().flatten()?;
        let cached_at = DateTime::parse_from_rfc3339(&fetched_at)
            .map(|parsed| parsed.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());
        let entry = Entry { fetched: Instant::now(), cached_at, value, persisted: true, stale: true };
        let served = self.usable_value_of(&entry)?;
        if let Ok(mut entries) = self.entries.lock() { entries.insert(key.to_owned(), entry); }
        Some(served)
    }

    fn usable_value_of(&self, entry: &Entry) -> Option<Served> {
        let age = Utc::now().signed_duration_since(entry.cached_at).to_std().unwrap_or_default();
        (age < self.stale_ttl(entry.persisted)).then(|| Self::served(entry, true))
    }

    /// Mark every entry stale (keeping its value) and drop the negative cache.
    pub fn invalidate_all(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            for entry in entries.values_mut() { entry.stale = true; }
        }
        if let Ok(mut failures) = self.failures.lock() { failures.clear(); }
    }
}

/// The cache key: runtime identity plus the Claude workflows setting, plus the
/// model hint for Claude alone (its `get_settings` output depends on the model).
fn cache_key(runtime: &Value, workflows: bool, hint: Option<&str>) -> String {
    let mut key = format!("{}|claude-workflows={workflows}", runtime_key(runtime));
    if runtime["provider"].as_str() == Some("claude") {
        key.push_str(&format!("|model={}", hint.unwrap_or("")));
    }
    key
}

fn runtime_key(runtime: &Value) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        runtime["id"].as_str().unwrap_or(""),
        runtime["executablePath"].as_str().unwrap_or(""),
        runtime["version"].as_str().unwrap_or(""),
        serde_json::to_string(&runtime["launchArgs"]).unwrap_or_default(),
        runtime["profileId"].as_str().unwrap_or("")
    )
}

/// Claude's catalog probe carries the model and the workflows opt-in; Codex and
/// OpenCode ignore both.
pub(crate) fn catalog_probe_args(provider: &str, workflows: bool, model_hint: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if provider == "claude" {
        let model = model_hint.or_else(|| workflows.then_some("sonnet"));
        if let Some(model) = model { args.extend(["--model".into(), model.into()]); }
        if workflows { args.extend(["--settings".into(), r#"{"enableWorkflows":true}"#.into()]); }
    }
    args
}

/// Resolve the workflows flag, the effective model hint and the cache key a
/// call to `get` will use. Shared with tests so they can address the same key.
pub(crate) fn resolve_probe(st: &AppState, runtime: &Value, workflow_override: Option<bool>, model_hint: Option<&str>) -> Probe {
    let provider = runtime["provider"].as_str().unwrap_or("").to_owned();
    let workflows = provider == "claude"
        && workflow_override.unwrap_or_else(|| st.db.settings().map(|settings| claude_workflows_enabled(&settings)).unwrap_or(true));
    let hint = model_hint.map(str::to_owned)
        .or_else(|| (provider == "claude" && workflows).then_some("sonnet".to_owned()));
    let key = cache_key(runtime, workflows, hint.as_deref());
    Probe { provider, workflows, hint, key }
}

/// Fetch a catalog. `Fresh` and `Refresh` always yield a value or an error;
/// `CachedOnly` yields `None` on a miss without waiting.
pub async fn get(
    st: &AppState,
    runtime: &Value,
    workflow_override: Option<bool>,
    model_hint: Option<&str>,
    mode: Mode,
) -> Result<Option<Served>, DispatchError> {
    let probe = resolve_probe(st, runtime, workflow_override, model_hint);
    match mode {
        Mode::Fresh => {
            if let Some(served) = st.catalog.fresh_value(&probe.key) { return Ok(Some(served)); }
            Ok(Some(fetch(st, runtime, &probe, false).await?))
        }
        Mode::Refresh => Ok(Some(fetch(st, runtime, &probe, true).await?)),
        Mode::CachedOnly => {
            let served = st.catalog.usable_value(&probe.key).or_else(|| st.catalog.load_persisted(st, &probe.key));
            // A stale or missing read starts one background refresh, unless a
            // recent probe already failed and is negative-cached.
            if served.as_ref().is_none_or(|value| value.stale) && st.catalog.failure(&probe.key).is_none() {
                spawn_refresh(st, runtime.clone(), probe);
            }
            Ok(served)
        }
    }
}

/// Run (or join) one probe for `probe.key`, then cache its outcome.
async fn fetch(st: &AppState, runtime: &Value, probe: &Probe, force: bool) -> Result<Served, DispatchError> {
    let requested = Instant::now();
    let key_lock = {
        let mut inflight = st.catalog.inflight.lock().await;
        inflight.entry(probe.key.clone()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    };
    let _guard = key_lock.lock().await;
    // Another caller may have filled the entry while we waited. A forced
    // refresh only accepts a result that was fetched after it arrived.
    let ready: Option<Served> = if force {
        st.catalog.read_entry(&probe.key).filter(|entry| !entry.stale && entry.fetched >= requested).map(|entry| CatalogCache::served(&entry, false))
    } else {
        st.catalog.fresh_value(&probe.key)
    };
    if let Some(served) = ready {
        st.catalog.inflight.lock().await.remove(&probe.key);
        return Ok(served);
    }
    if !force {
        if let Some(error) = st.catalog.failure(&probe.key) {
            st.catalog.inflight.lock().await.remove(&probe.key);
            return Err(error);
        }
    }
    let result = probe_runtime(st, runtime, probe).await;
    match result {
        Ok(value) => {
            let cached_at = st.catalog.insert(&probe.key, value.clone(), false);
            st.catalog.clear_failure(&probe.key);
            if value["fallback"] != true && value["validated"] == true {
                let fetched_at = cached_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let _ = st.db.catalog_cache_put(&probe.key, runtime["id"].as_str().unwrap_or(""), &probe.provider, &fetched_at, &value);
            }
            st.catalog.inflight.lock().await.remove(&probe.key);
            Ok(Served { value, stale: false, cached_at })
        }
        Err(error) => {
            st.catalog.remember_failure(&probe.key, error.clone());
            st.catalog.inflight.lock().await.remove(&probe.key);
            Err(error)
        }
    }
}

async fn probe_runtime(st: &AppState, runtime: &Value, probe: &Probe) -> Result<Value, DispatchError> {
    let mut spec = runtime_from(runtime);
    spec.args.extend(catalog_probe_args(&probe.provider, probe.workflows, probe.hint.as_deref()));
    let adapter = adapter_for(&st.adapters, &probe.provider).ok_or_else(|| {
        derr("unsupported", "model catalogs are unsupported for this runtime", StatusCode::BAD_REQUEST)
    })?;
    let mut catalog = adapter.model_catalog(&spec).await.map_err(|error| match error {
        AdapterError::Unsupported(_) => derr("unsupported", "model catalogs are unsupported for this runtime", StatusCode::BAD_REQUEST),
        AdapterError::Process(_) => derr("provider_unavailable", "runtime model catalog is unavailable", StatusCode::BAD_GATEWAY),
        _ => derr("provider_error", "runtime returned an invalid model catalog", StatusCode::BAD_GATEWAY),
    })?;
    model_presentation::apply(&mut catalog.models, catalog.validated, catalog.fallback);
    Ok(json!({
        "runtimeId": spec.runtime_id,
        "provider": probe.provider,
        "displayName": provider_display_name(&probe.provider),
        "models": catalog.models,
        "fetchedAt": catalog.fetched_at,
        "expiresAt": catalog.expires_at,
        "fallback": catalog.fallback,
        "source": catalog.source,
        "validated": catalog.validated,
    }))
}

fn spawn_refresh(st: &AppState, runtime: Value, probe: Probe) {
    let st = st.clone();
    tokio::spawn(async move {
        let _ = fetch(&st, &runtime, &probe, false).await;
    });
}

/// A status the UI would consider usable, matching `runtimeUsable`, and a
/// provider that is not signed out.
fn runtime_usable(runtime: &Value) -> bool {
    let status = runtime["status"].as_str().unwrap_or("").to_ascii_lowercase();
    let usable = ["online", "ready", "available", "connected"].contains(&status.as_str());
    let signed_out = runtime["authState"].as_str().unwrap_or("").eq_ignore_ascii_case("unauthenticated");
    usable && !signed_out
}

/// After discovery, warm every usable runtime two at a time. Each provider's
/// base key is warmed (Claude defaulting to `sonnet`); a warmed list that
/// differs from the previous one emits `runtime.models.changed`.
pub async fn prewarm_all(st: &AppState) {
    let usable = st.runtimes.read().await.iter().filter(|runtime| runtime_usable(runtime)).cloned().collect::<Vec<_>>();
    for pair in usable.chunks(2) {
        let mut tasks = Vec::new();
        for runtime in pair {
            let st = st.clone();
            let runtime = runtime.clone();
            tasks.push(tokio::spawn(async move { prewarm_one(&st, &runtime).await; }));
        }
        for task in tasks { let _ = task.await; }
    }
}

async fn prewarm_one(st: &AppState, runtime: &Value) {
    let probe = resolve_probe(st, runtime, None, None);
    let previous = st.catalog.read_entry(&probe.key).map(|entry| entry.value);
    if let Ok(Some(served)) = get(st, runtime, None, None, Mode::Fresh).await {
        if catalog_changed(previous.as_ref(), &served.value) {
            st.emit("runtime.models.changed", json!({"runtimeId": runtime["id"]})).await;
        }
    }
}

/// Compare two catalogs by the model ids and their effort/speed capabilities.
fn catalog_changed(previous: Option<&Value>, next: &Value) -> bool {
    let Some(previous) = previous else { return true; };
    model_signature(previous) != model_signature(next)
}

fn model_signature(value: &Value) -> Vec<(String, Vec<String>, Vec<String>)> {
    value["models"].as_array().map(|models| {
        models.iter().map(|model| {
            let thinking = model["supportedThinking"].as_array()
                .map(|levels| levels.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default();
            let tiers = model["serviceTiers"].as_array()
                .map(|tiers| tiers.iter().map(|tier| tier["id"].as_str().unwrap_or("").to_owned()).collect())
                .unwrap_or_default();
            (model["id"].as_str().unwrap_or("").to_owned(), thinking, tiers)
        }).collect()
    }).unwrap_or_default()
}
