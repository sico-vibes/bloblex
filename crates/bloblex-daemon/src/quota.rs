use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, future::Future, time::{Duration, Instant}};
use tokio::sync::Mutex;

pub const QUOTA_POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);
pub const QUOTA_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub used_percent: u8,
    pub remaining_percent: u8,
    pub resets_at: Option<String>,
    pub window_duration_mins: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaLimit {
    pub label: String,
    pub primary: Option<QuotaWindow>,
    pub secondary: Option<QuotaWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuota {
    pub provider: String,
    pub runtime_id: String,
    pub fetched_at: String,
    pub ordinary_usage_allowed: Option<bool>,
    pub limits: Vec<QuotaLimit>,
}

fn normalize_window(value: &Value) -> Option<QuotaWindow> {
    let used = value["usedPercent"].as_u64()?;
    if used > 100 { return None; }
    let resets_at = value["resetsAt"].as_i64()
        .and_then(|seconds| DateTime::<Utc>::from_timestamp(seconds, 0))
        .map(|time| time.to_rfc3339());
    Some(QuotaWindow {
        used_percent: used as u8,
        remaining_percent: (100 - used) as u8,
        resets_at,
        window_duration_mins: value["windowDurationMins"].as_u64(),
    })
}

fn normalize_limit(label: String, value: &Value) -> Option<QuotaLimit> {
    let primary = normalize_window(&value["primary"]);
    let secondary = normalize_window(&value["secondary"]);
    (primary.is_some() || secondary.is_some()).then_some(QuotaLimit { label, primary, secondary })
}

pub fn normalize_codex_quota(runtime_id: &str, response: &Value, fetched_at: &str) -> Option<ProviderQuota> {
    let mut limits = Vec::new();
    if let Some(by_id) = response["rateLimitsByLimitId"].as_object().filter(|map| !map.is_empty()) {
        for (index, (id, limit)) in by_id.iter().enumerate() {
            let label = if id == "codex" { "Codex".to_owned() } else { format!("Quota {}", index + 1) };
            if let Some(limit) = normalize_limit(label, limit) { limits.push(limit); }
        }
    } else if let Some(limit) = normalize_limit("Codex".into(), &response["rateLimits"]) {
        limits.push(limit);
    }
    if limits.is_empty() { return None; }
    Some(ProviderQuota {
        provider: "codex".into(),
        runtime_id: runtime_id.into(),
        fetched_at: fetched_at.into(),
        ordinary_usage_allowed: response["ordinaryUsageAllowed"].as_bool(),
        limits,
    })
}

#[derive(Default)]
struct ProviderPollState {
    in_flight: bool,
    failures: u32,
    retry_at: Option<Instant>,
}

#[derive(Default)]
pub struct QuotaPollGate {
    providers: HashMap<String, ProviderPollState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PollFailure { Timeout, Unavailable, Protocol }

#[derive(Debug, PartialEq, Eq)]
pub enum PollOutcome<T> {
    Skipped,
    Updated(T),
    Failed { failure: PollFailure, failure_count: u32, backoff: Duration },
}

pub async fn poll_with_timeout<T, F, Fut>(
    gate: &Mutex<QuotaPollGate>,
    provider: &str,
    timeout: Duration,
    fetch: F,
) -> PollOutcome<T>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, PollFailure>>,
{
    if !gate.lock().await.begin(provider, Instant::now()) { return PollOutcome::Skipped; }
    let result = match tokio::time::timeout(timeout, fetch()).await {
        Ok(Ok(value)) => {
            gate.lock().await.succeed(provider);
            return PollOutcome::Updated(value);
        }
        Ok(Err(failure)) => failure,
        Err(_) => PollFailure::Timeout,
    };
    let (failure_count, backoff) = gate.lock().await.fail(provider, Instant::now());
    PollOutcome::Failed { failure: result, failure_count, backoff }
}

impl QuotaPollGate {
    pub fn begin(&mut self, provider: &str, now: Instant) -> bool {
        let state = self.providers.entry(provider.to_owned()).or_default();
        if state.in_flight || state.retry_at.is_some_and(|retry_at| now < retry_at) { return false; }
        state.in_flight = true;
        true
    }

    pub fn succeed(&mut self, provider: &str) {
        let state = self.providers.entry(provider.to_owned()).or_default();
        state.in_flight = false;
        state.failures = 0;
        state.retry_at = None;
    }

    pub fn fail(&mut self, provider: &str, now: Instant) -> (u32, Duration) {
        let state = self.providers.entry(provider.to_owned()).or_default();
        state.in_flight = false;
        state.failures = state.failures.saturating_add(1);
        let shift = state.failures.saturating_sub(1).min(5);
        let delay = Duration::from_secs((10u64.saturating_mul(1u64 << shift)).min(300));
        state.retry_at = Some(now + delay);
        (state.failures, delay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_quota_normalization_uses_structured_windows_and_keeps_unknowns_null() {
        let quota = normalize_codex_quota("rt-codex", &json!({
            "ordinaryUsageAllowed": true,
            "accountId": "must-not-be-copied",
            "rateLimitsByLimitId": {
                "codex": {
                    "primary": {"usedPercent": 76, "resetsAt": 1790000000, "windowDurationMins": 300},
                    "secondary": {"usedPercent": 18, "resetsAt": null, "windowDurationMins": null},
                    "credits": {"balance": "private-credit-value"}
                }
            },
            "rateLimitUpsell": {"accountId": "private"}
        }), "2026-10-05T00:00:00Z").unwrap();
        assert_eq!(quota.provider, "codex");
        assert_eq!(quota.runtime_id, "rt-codex");
        assert_eq!(quota.ordinary_usage_allowed, Some(true));
        assert_eq!(quota.limits[0].primary.as_ref().unwrap().remaining_percent, 24);
        assert_eq!(quota.limits[0].primary.as_ref().unwrap().window_duration_mins, Some(300));
        assert_eq!(quota.limits[0].secondary.as_ref().unwrap().resets_at, None);
        let normalized = serde_json::to_string(&quota).unwrap();
        assert!(!normalized.contains("accountId"));
        assert!(!normalized.contains("private-credit-value"));
    }

    #[test]
    fn quota_poll_gate_is_single_flight_and_backoffs_failures() {
        let mut gate = QuotaPollGate::default();
        let now = Instant::now();
        assert!(gate.begin("codex", now));
        assert!(!gate.begin("codex", now));
        assert!(gate.begin("claude", now), "provider gates are independent");
        let (failures, delay) = gate.fail("codex", now);
        assert_eq!(failures, 1);
        assert_eq!(delay, Duration::from_secs(10));
        assert!(!gate.begin("codex", now + Duration::from_secs(9)));
        assert!(gate.begin("codex", now + Duration::from_secs(10)));
        gate.succeed("codex");
        assert!(gate.begin("codex", now + Duration::from_secs(11)));
        let (failures, delay) = gate.fail("codex", now + Duration::from_secs(11));
        assert_eq!(failures, 1, "a success resets the failure backoff");
        assert_eq!(delay, Duration::from_secs(10));
    }

    #[tokio::test]
    async fn quota_poll_wrapper_times_out_and_skips_concurrent_fetches() {
        let gate = std::sync::Arc::new(Mutex::new(QuotaPollGate::default()));
        let first_gate = gate.clone();
        let first = tokio::spawn(async move {
            poll_with_timeout(&first_gate, "codex", Duration::from_millis(60), || async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                Ok::<_, PollFailure>("snapshot")
            }).await
        });
        tokio::time::sleep(Duration::from_millis(2)).await;
        let skipped = poll_with_timeout(&gate, "codex", Duration::from_millis(5), || async {
            Ok::<_, PollFailure>("duplicate")
        }).await;
        assert_eq!(skipped, PollOutcome::Skipped);
        assert_eq!(first.await.unwrap(), PollOutcome::Updated("snapshot"));

        let timed_out = poll_with_timeout(&gate, "codex", Duration::from_millis(5), || async {
            std::future::pending::<Result<(), PollFailure>>().await
        }).await;
        assert!(matches!(timed_out, PollOutcome::Failed { failure: PollFailure::Timeout, failure_count: 1, .. }));
    }
}
