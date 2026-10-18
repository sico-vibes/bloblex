//! Provider failure evidence shared by adapters and the daemon. Never logs input.
use crate::RecoveryHintKind;
use serde_json::Value;

/// Match documented error codes and specific failure phrases, never a generic
/// mention of quota. Call only on an error payload, not model output.
pub fn provider_recovery(value: &Value) -> Option<RecoveryHintKind> {
    let raw = value.to_string().to_ascii_lowercase();
    if status(value, 0) == Some(401)
        || ["unauthorized", "authentication_error", "sign-in expired"]
            .iter()
            .any(|s| raw.contains(s))
    {
        return Some(RecoveryHintKind::AuthRequired);
    }
    if status(value, 0) == Some(429)
        || [
            "ratelimitexceeded",
            "usagelimitexceeded",
            "usage_limit_reached",
            "rate_limit_error",
            "rate limit exceeded",
            "rate limited",
            "too many requests",
            "you've hit your limit",
            "usage limit reached",
            "usage limit exceeded",
            "rate_limit_exceeded",
            "usage_limit_exceeded",
            "rate limit reached",
            "quota exceeded",
            "quota_exceeded",
            "insufficient_quota",
            "you’re out of extra usage",
            "you're out of extra usage",
            "hit your usage limit",
        ]
        .iter()
        .any(|s| raw.contains(s))
    {
        return Some(RecoveryHintKind::RateLimited);
    }
    if status(value, 0).is_some_and(|n| (500..=599).contains(&n))
        || [
            "serveroverloaded",
            "overloaded_error",
            "stream disconnected",
            "stream closed unexpectedly",
            "process exited unexpectedly",
            "connection reset",
            "connection closed",
            "http 500",
            "internal_server_error",
            "internal server error",
            "service unavailable",
            "http 502",
            "http 503",
            "http 504",
        ]
        .iter()
        .any(|s| raw.contains(s))
    {
        return Some(RecoveryHintKind::Overloaded);
    }
    None
}

fn status(value: &Value, depth: usize) -> Option<i64> {
    if depth > 6 {
        return None;
    }
    let object = value.as_object()?;
    [
        "status",
        "statusCode",
        "httpStatusCode",
        "api_error_status",
        "code",
    ]
    .iter()
    .filter_map(|key| object.get(*key))
    .filter_map(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
    .find(|n| (100..=599).contains(n))
    .or_else(|| object.values().find_map(|child| status(child, depth + 1)))
}

fn field<'a>(value: &'a Value, names: &[&str], depth: usize) -> Option<&'a Value> {
    if depth > 6 {
        return None;
    }
    if let Some(array) = value.as_array() {
        return array.iter().find_map(|v| field(v, names, depth + 1));
    }
    let object = value.as_object()?;
    object
        .iter()
        .find_map(|(key, value)| {
            names
                .iter()
                .any(|name| key.eq_ignore_ascii_case(name))
                .then_some(value)
        })
        .or_else(|| {
            object
                .values()
                .find_map(|child| field(child, names, depth + 1))
        })
}

fn number(value: &Value, names: &[&str]) -> Option<i64> {
    let v = field(value, names, 0)?;
    v.as_i64().or_else(|| v.as_str()?.parse().ok())
}

/// Keep expired windows negative: callers must never turn them into an
/// immediate retry. Provider absolute reset times take precedence over waits.
pub fn provider_retry_after(value: &Value, now_epoch: i64) -> Option<i64> {
    if let Some(reset) = field(
        value,
        &["resetsAt", "resetAt", "resets_at", "reset_at", "reset_time"],
        0,
    ) {
        let epoch = reset.as_i64().or_else(|| {
            let raw = reset.as_str()?;
            raw.parse().ok().or_else(|| {
                chrono::DateTime::parse_from_rfc3339(raw)
                    .ok()
                    .map(|t| t.timestamp())
            })
        })?;
        let epoch = if epoch > 10_000_000_000 {
            epoch / 1000
        } else {
            epoch
        };
        return Some(epoch.saturating_sub(now_epoch));
    }
    number(
        value,
        &[
            "retry_after",
            "retryAfter",
            "retry_after_secs",
            "retryAfterSecs",
            "retryAfterSeconds",
            "retry-after",
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn p8_provider_usage_limits_preserve_reset_windows() {
        for value in [
            json!({"api_error_status":429,"retry_after":120}),
            json!({"codexErrorInfo":"usageLimitExceeded","resetsAt":1800000120}),
            json!({"code":429,"data":{"retryAfter":120}}),
        ] {
            assert_eq!(
                provider_recovery(&value),
                Some(crate::RecoveryHintKind::RateLimited)
            );
            assert_eq!(provider_retry_after(&value, 1800000000), Some(120));
        }
    }

    #[test]
    fn p8_nested_status_and_absolute_resets_are_preserved() {
        let error =
            json!({"code":-32000,"data":{"statusCode":429,"resetAt":"2027-01-15T08:02:00Z"}});
        assert_eq!(
            provider_recovery(&error),
            Some(RecoveryHintKind::RateLimited)
        );
        assert_eq!(provider_retry_after(&error, 1800000000), Some(120));
        assert_eq!(
            provider_retry_after(&json!({"headers":{"Retry-After":"120"}}), 1800000000),
            Some(120)
        );
        assert_eq!(
            provider_retry_after(&json!({"errors":[{"retryAfterSecs":120}]}), 1800000000),
            Some(120)
        );
    }

    #[test]
    fn p8_transient_and_permanent_evidence_are_distinct() {
        assert_eq!(
            provider_recovery(&json!({"status":503})),
            Some(crate::RecoveryHintKind::Overloaded)
        );
        assert_eq!(
            provider_recovery(&json!({"message":"stream disconnected before completion"})),
            Some(crate::RecoveryHintKind::Overloaded)
        );
        for message in [
            "invalid API key",
            "insufficient credits",
            "permission denied",
            "please review this quota document",
        ] {
            assert_eq!(provider_recovery(&json!({"message":message})), None);
        }
        assert_eq!(
            provider_retry_after(&json!({"resetsAt":1799999999}), 1800000000),
            Some(-1)
        );
    }
}
