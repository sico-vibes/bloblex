//! Safe automatic retry after overload and rate limits (Phase 3A).
//!
//! A failed turn that carried a structured `overloaded`/`rateLimited` recovery
//! hint and an acknowledged prompt may schedule a single automatic retry. The
//! retry is a new turn that sends the literal text `Please continue.` through
//! the durable queue; it never resends the original prompt, so a turn whose
//! delivery is unknown always declines. Everything here is off by default
//! (`experimental.autoRetry`); with it off the daemon behaves exactly as before.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::collections::HashSet;

/// How many automatic retries one overload chain may schedule.
const OVERLOADED_MAX_ATTEMPTS: u32 = 5;
/// How many automatic retries one rate-limited chain may schedule.
const RATE_LIMITED_MAX_ATTEMPTS: u32 = 2;
/// First overload backoff; each attempt doubles it.
const OVERLOADED_BASE_SECS: i64 = 5;
/// Padding added after the quota reset time.
const RATE_LIMIT_PAD_SECS: i64 = 15;
/// Extra random delay after the quota reset time.
const RATE_LIMIT_JITTER_SECS: i64 = 30;
/// Default and maximum `retry.maxWaitSecs`.
pub const DEFAULT_MAX_WAIT_SECS: i64 = 21_600;
pub const MAX_MAX_WAIT_SECS: i64 = 86_400;
/// A retry overdue by more than this after a restart is dropped.
const RESTART_GRACE_SECS: i64 = 600;
/// A quota snapshot older than this is refreshed once before deciding.
const QUOTA_STALE_SECS: i64 = 600;
/// Timeout for the one-off quota refresh.
const QUOTA_REFRESH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HintKind {
    Overloaded,
    RateLimited,
    AuthRequired,
}

impl HintKind {
    fn from_raw(raw: &str) -> Option<Self> {
        match raw {
            "overloaded" => Some(Self::Overloaded),
            "rateLimited" => Some(Self::RateLimited),
            "authRequired" => Some(Self::AuthRequired),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryKind {
    Overloaded,
    RateLimited,
}

impl RetryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Overloaded => "overloaded",
            Self::RateLimited => "rate_limited",
        }
    }
    fn max_attempts(self) -> u32 {
        match self {
            Self::Overloaded => OVERLOADED_MAX_ATTEMPTS,
            Self::RateLimited => RATE_LIMITED_MAX_ATTEMPTS,
        }
    }
}

/// Machine-readable decline reasons. `as_str` is the stable code stored in
/// `turns.data.retryDecision` and emitted on `turn.retry_declined`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeclineReason {
    Disabled,
    NotAcknowledged,
    NoHint,
    AuthRequired,
    UnknownReset,
    TooLong,
    MaxAttempts,
    Superseded,
    PendingRetry,
    SessionUnavailable,
    Cancelled,
}

impl DeclineReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::NotAcknowledged => "not_acknowledged",
            Self::NoHint => "no_hint",
            Self::AuthRequired => "auth_required",
            Self::UnknownReset => "unknown_reset",
            Self::TooLong => "too_long",
            Self::MaxAttempts => "max_attempts",
            Self::Superseded => "superseded",
            Self::PendingRetry => "pending_retry",
            Self::SessionUnavailable => "session_unavailable",
            Self::Cancelled => "cancelled",
        }
    }
    /// A short human phrase for the transcript notice.
    fn short(self) -> &'static str {
        match self {
            Self::Disabled => "automatic retry is off",
            Self::NotAcknowledged => "the prompt may not have reached the provider",
            Self::NoHint => "there was no recovery signal",
            Self::AuthRequired => "sign-in is required",
            Self::UnknownReset => "the rate-limit reset time is unknown",
            Self::TooLong => "the wait is longer than the configured limit",
            Self::MaxAttempts => "the retry limit was reached",
            Self::Superseded => "a newer message was sent",
            Self::PendingRetry => "a retry is already waiting",
            Self::SessionUnavailable => "the conversation is unavailable",
            Self::Cancelled => "it was cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Retry { at: DateTime<Utc>, kind: RetryKind, attempt: u32 },
    Decline { reason: DeclineReason },
}

/// Pure inputs for one retry decision point.
pub struct RetryInput {
    pub enabled: bool,
    pub hint: Option<HintKind>,
    pub retry_after_secs: Option<i64>,
    pub acknowledged: bool,
    /// The 1-based number of the retry being decided.
    pub attempt: u32,
    pub now: DateTime<Utc>,
    /// Latest known reset of the failing provider's blocked quota windows.
    pub quota_reset: Option<DateTime<Utc>>,
    pub max_wait_secs: i64,
}

/// The retry policy. Jitter is injected so tests are deterministic.
pub fn decide(input: &RetryInput, mut jitter: impl FnMut() -> f64) -> Decision {
    if !input.enabled {
        return Decision::Decline { reason: DeclineReason::Disabled };
    }
    // A prompt that was never acknowledged might still have been delivered and
    // charged, so retrying could send a paid prompt twice.
    if !input.acknowledged {
        return Decision::Decline { reason: DeclineReason::NotAcknowledged };
    }
    let Some(hint) = input.hint else {
        return Decision::Decline { reason: DeclineReason::NoHint };
    };
    // Providers never supply `retry_after_secs` today; the policy derives waits
    // from the hint kind, so this is recorded input only.
    let _ = input.retry_after_secs;
    match hint {
        HintKind::AuthRequired => Decision::Decline { reason: DeclineReason::AuthRequired },
        HintKind::Overloaded => {
            if input.attempt == 0 || input.attempt > OVERLOADED_MAX_ATTEMPTS {
                return Decision::Decline { reason: DeclineReason::MaxAttempts };
            }
            let base = OVERLOADED_BASE_SECS.saturating_mul(1i64 << (input.attempt - 1));
            let extra = (base as f64 * unit(jitter())).floor() as i64;
            let wait = base.saturating_add(extra);
            if wait > input.max_wait_secs {
                return Decision::Decline { reason: DeclineReason::TooLong };
            }
            Decision::Retry {
                at: input.now + Duration::seconds(wait),
                kind: RetryKind::Overloaded,
                attempt: input.attempt,
            }
        }
        HintKind::RateLimited => {
            if input.attempt == 0 || input.attempt > RATE_LIMITED_MAX_ATTEMPTS {
                return Decision::Decline { reason: DeclineReason::MaxAttempts };
            }
            let Some(reset) = input.quota_reset else {
                return Decision::Decline { reason: DeclineReason::UnknownReset };
            };
            let extra = (unit(jitter()) * RATE_LIMIT_JITTER_SECS as f64).floor() as i64;
            let at = reset + Duration::seconds(RATE_LIMIT_PAD_SECS.saturating_add(extra));
            let wait = (at - input.now).num_seconds();
            if wait > input.max_wait_secs {
                return Decision::Decline { reason: DeclineReason::TooLong };
            }
            Decision::Retry { at, kind: RetryKind::RateLimited, attempt: input.attempt }
        }
    }
}

fn unit(value: f64) -> f64 {
    if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 }
}

/// A jitter fraction in `[0,1)` from the wall clock; no new dependency.
fn jitter_unit() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    let mut x = nanos ^ 0x9E37_79B9_7F4A_7C15;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    (x >> 11) as f64 / ((1u64 << 53) as f64)
}

fn now_millis() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn minutes_at_least_one(seconds: i64) -> i64 {
    ((seconds.max(0) + 30) / 60).max(1)
}

/// The single turn-ending hook. Called for every terminal turn error after the
/// team/queue bookkeeping so a paused queue is already recorded.
pub async fn after_failed_turn(st: &AppState, session_id: &str, turn_id: Option<&str>) {
    let Some(turn_id) = turn_id else { return; };
    let settings = st.db.settings().unwrap_or(Value::Null);
    if settings["experimental.autoRetry"] != true {
        return;
    }
    let max_wait_secs = settings["retry.maxWaitSecs"]
        .as_i64()
        .unwrap_or(DEFAULT_MAX_WAIT_SECS)
        .clamp(0, MAX_MAX_WAIT_SECS);
    let data = st.db.turn_data(turn_id).unwrap_or(Value::Null);
    if data["retryDecision"].is_object() {
        return; // Already decided for this turn.
    }
    let hint = HintKind::from_raw(data["hint"]["kind"].as_str().unwrap_or(""));
    let acknowledged = data["delivery"].as_str() == Some("acknowledged");
    let attempt = data["attempt"].as_u64().unwrap_or(0).saturating_add(1) as u32;
    let retry_of = data["retryOf"].as_str().map(str::to_owned).unwrap_or_else(|| turn_id.to_owned());
    let now = Utc::now();
    // A decline notice is only useful for a retryable-class failure.
    let retryable = matches!(hint, Some(HintKind::Overloaded) | Some(HintKind::RateLimited));

    let session = st.db.session_detail(session_id).ok();
    let session_available = session.as_ref().is_some_and(|row| {
        row["archived"] != true && row["link"]["kind"] != "side"
    });
    let provider = session.as_ref().and_then(|row| row["provider"].as_str().map(str::to_owned));

    let quota_reset = if hint == Some(HintKind::RateLimited) {
        match provider.as_deref() {
            Some(provider) => latest_blocked_reset(st, provider).await,
            None => None,
        }
    } else {
        None
    };

    let decision = if !session_available {
        Decision::Decline { reason: DeclineReason::SessionUnavailable }
    } else if st.db.queue_pending_retry(session_id).ok().flatten().is_some() {
        Decision::Decline { reason: DeclineReason::PendingRetry }
    } else {
        decide(
            &RetryInput {
                enabled: true,
                hint,
                retry_after_secs: data["hint"]["retryAfterSecs"].as_i64(),
                acknowledged,
                attempt,
                now,
                quota_reset,
                max_wait_secs,
            },
            jitter_unit,
        )
    };

    match decision {
        Decision::Decline { reason } => {
            record_decision(st, turn_id, "decline", reason.as_str(), &now_millis());
            if retryable {
                emit_decline(st, session_id, turn_id, reason).await;
            }
        }
        Decision::Retry { at, kind, attempt } => {
            if schedule(st, session_id, turn_id, &retry_of, kind, attempt, at).await.is_err() {
                let reason = DeclineReason::SessionUnavailable;
                record_decision(st, turn_id, "decline", reason.as_str(), &now_millis());
                if retryable {
                    emit_decline(st, session_id, turn_id, reason).await;
                }
            }
        }
    }
}

fn record_decision(st: &AppState, turn_id: &str, decision: &str, reason: &str, at: &str) {
    let _ = st.db.merge_turn_data(
        turn_id,
        &json!({"retryDecision":{"decision":decision,"reason":reason,"at":at}}),
    );
}

async fn emit_decline(st: &AppState, session_id: &str, turn_id: &str, reason: DeclineReason) {
    crate::team::note(
        st,
        session_id,
        &format!("Not retrying automatically: {}.", reason.short()),
        json!({"kind":"auto_retry","status":"declined","reason":reason.as_str()}),
    )
    .await;
    st.emit(
        "turn.retry_declined",
        json!({"sessionId":session_id,"turnId":turn_id,"reason":reason.as_str()}),
    )
    .await;
}

/// Add the queue retry item and announce it. The retry never resends the
/// original prompt; it sends a literal continuation into the same session.
async fn schedule(
    st: &AppState,
    session_id: &str,
    turn_id: &str,
    retry_of: &str,
    kind: RetryKind,
    attempt: u32,
    at: DateTime<Utc>,
) -> Result<String, ()> {
    let due_at = at.to_rfc3339_opts(SecondsFormat::Millis, true);
    let params = json!({
        "text":"Please continue.",
        "attachments":[],
        "meta":{"kind":"auto_retry","retryOf":retry_of,"attempt":attempt},
    });
    let item = st
        .db
        .queue_add(session_id, &params, "retry", Some(&due_at))
        .map_err(|_| ())?;
    let item_id = item["id"].as_str().unwrap_or("").to_owned();
    let max_attempts = kind.max_attempts();
    let wait = (at - Utc::now()).num_seconds();
    let content = match kind {
        RetryKind::Overloaded => format!(
            "Provider is overloaded. Retrying automatically in about {} min (attempt {} of {}).",
            minutes_at_least_one(wait),
            attempt,
            max_attempts
        ),
        RetryKind::RateLimited => format!(
            "Rate limit reached. Retrying automatically at {} (attempt {} of {}).",
            at.format("%H:%M"),
            attempt,
            max_attempts
        ),
    };
    crate::team::note(
        st,
        session_id,
        &content,
        json!({
            "kind":"auto_retry",
            "status":"scheduled",
            "retryKind":kind.as_str(),
            "attempt":attempt,
            "maxAttempts":max_attempts,
            "runAt":due_at,
            "itemId":item_id,
        }),
    )
    .await;
    st.emit(
        "turn.retry_scheduled",
        json!({
            "sessionId":session_id,
            "turnId":turn_id,
            "itemId":item_id,
            "retryKind":kind.as_str(),
            "attempt":attempt,
            "maxAttempts":max_attempts,
            "runAt":due_at,
        }),
    )
    .await;
    let _ = st.db.merge_turn_data(
        turn_id,
        &json!({"retryDecision":{"decision":"retry","reason":Value::Null,"at":due_at}}),
    );
    crate::queue::emit_changed(st, session_id).await;
    Ok(item_id)
}

/// Cancel every pending retry for a session. `notify` appends the user-facing
/// "Automatic retry cancelled." notice (only the explicit RPC does).
pub async fn cancel_pending(
    st: &AppState,
    session_id: &str,
    reason: DeclineReason,
    notify: bool,
) -> bool {
    let removed = st.db.queue_delete_retries(session_id).unwrap_or_default();
    if removed.is_empty() {
        return false;
    }
    for item in &removed {
        if let Some(retry_of) = item["retryOf"].as_str() {
            record_decision(st, retry_of, "decline", reason.as_str(), &now_millis());
        }
    }
    if notify {
        crate::team::note(
            st,
            session_id,
            "Automatic retry cancelled.",
            json!({"kind":"auto_retry","status":"cancelled"}),
        )
        .await;
    }
    crate::queue::emit_changed(st, session_id).await;
    st.emit(
        "turn.retry_declined",
        json!({"sessionId":session_id,"reason":reason.as_str()}),
    )
    .await;
    true
}

pub async fn cancel_rpc(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    if st.db.session_detail(session_id).is_err() {
        return Err(derr("not_found", "Conversation not found.", StatusCode::NOT_FOUND));
    }
    if !cancel_pending(st, session_id, DeclineReason::Cancelled, true).await {
        return Err(derr("not_found", "No automatic retry is pending.", StatusCode::NOT_FOUND));
    }
    Ok(json!({"cancelled":true}))
}

/// Drop retries that missed their window while the daemon was not running.
pub async fn reconcile_restart(st: &AppState) {
    let settings = st.db.settings().unwrap_or(Value::Null);
    if settings["experimental.autoRetry"] != true {
        // A retry created while the feature was on must not fire after it has
        // been turned off: the off state promises no notices and no events, so
        // drop it silently rather than waking the conversation.
        for session_id in st.db.queue_retry_sessions().unwrap_or_default() {
            let _ = st.db.queue_delete_retries(&session_id);
        }
        return;
    }
    let cutoff = (Utc::now() - Duration::seconds(RESTART_GRACE_SECS))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let stale = st.db.queue_stale_retries(&cutoff).unwrap_or_default();
    let mut touched: HashSet<String> = HashSet::new();
    for item in stale {
        let Some(id) = item["id"].as_str() else { continue; };
        let _ = st.db.queue_delete_by_id(id);
        let Some(session_id) = item["sessionId"].as_str() else { continue; };
        touched.insert(session_id.to_owned());
        crate::team::note(
            st,
            session_id,
            "Automatic retry skipped because Bloblex was not running.",
            json!({"kind":"auto_retry","status":"skipped","reason":"restart"}),
        )
        .await;
        if let Some(retry_of) = item["retryOf"].as_str() {
            record_decision(st, retry_of, "decline", DeclineReason::Cancelled.as_str(), &now_millis());
        }
    }
    for session_id in touched {
        crate::queue::emit_changed(st, &session_id).await;
    }
}

/// The latest reset time among a provider's blocked quota windows. Refreshes a
/// snapshot once when it is missing or older than ten minutes.
async fn latest_blocked_reset(st: &AppState, provider: &str) -> Option<DateTime<Utc>> {
    let now = Utc::now();
    let entry = st
        .db
        .quota_snapshots()
        .ok()
        .unwrap_or_default()
        .into_iter()
        .find(|entry| entry["provider"] == provider);
    if snapshot_is_stale(entry.as_ref(), now) {
        crate::refresh_provider_quota(st, provider, QUOTA_REFRESH_TIMEOUT).await;
        let entry = st
            .db
            .quota_snapshots()
            .ok()
            .unwrap_or_default()
            .into_iter()
            .find(|entry| entry["provider"] == provider);
        return blocked_reset(entry, now);
    }
    blocked_reset(entry, now)
}

fn snapshot_is_stale(entry: Option<&Value>, now: DateTime<Utc>) -> bool {
    let Some(fetched) = entry.and_then(|entry| entry["fetchedAt"].as_str()) else {
        return true;
    };
    DateTime::parse_from_rfc3339(fetched)
        .map(|fetched| now.signed_duration_since(fetched.with_timezone(&Utc)).num_seconds() > QUOTA_STALE_SECS)
        .unwrap_or(true)
}

fn blocked_reset(entry: Option<Value>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let snapshot = entry?;
    let snapshot = snapshot["snapshot"].clone();
    let mut best: Option<DateTime<Utc>> = None;
    for limit in snapshot["limits"].as_array()? {
        for window in [&limit["primary"], &limit["secondary"]] {
            let blocked = window["usedPercent"].as_u64().is_some_and(|used| used >= 100);
            if !blocked {
                continue;
            }
            let reset = window["resetsAt"]
                .as_str()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&Utc));
            if let Some(reset) = reset.filter(|reset| *reset > now) {
                if best.map_or(true, |current| reset > current) {
                    best = Some(reset);
                }
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn fixed(value: f64) -> impl FnMut() -> f64 {
        move || value
    }

    fn at(secs: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(1_800_000_000 + secs, 0).unwrap()
    }

    fn base(hint: Option<HintKind>) -> RetryInput {
        RetryInput {
            enabled: true,
            hint,
            retry_after_secs: None,
            acknowledged: true,
            attempt: 1,
            now: at(0),
            quota_reset: None,
            max_wait_secs: DEFAULT_MAX_WAIT_SECS,
        }
    }

    #[test]
    fn disabled_declines_first() {
        let input = RetryInput { enabled: false, ..base(Some(HintKind::Overloaded)) };
        assert_eq!(decide(&input, fixed(0.0)), Decision::Decline { reason: DeclineReason::Disabled });
    }

    #[test]
    fn unknown_delivery_always_declines_even_for_overload() {
        let input = RetryInput { acknowledged: false, ..base(Some(HintKind::Overloaded)) };
        assert_eq!(decide(&input, fixed(0.0)), Decision::Decline { reason: DeclineReason::NotAcknowledged });
    }

    #[test]
    fn missing_hint_and_auth_decline() {
        assert_eq!(decide(&base(None), fixed(0.0)), Decision::Decline { reason: DeclineReason::NoHint });
        assert_eq!(
            decide(&base(Some(HintKind::AuthRequired)), fixed(0.0)),
            Decision::Decline { reason: DeclineReason::AuthRequired }
        );
    }

    #[test]
    fn overloaded_backoff_doubles_and_respects_jitter_bounds() {
        for attempt in 1..=OVERLOADED_MAX_ATTEMPTS {
            let expected_base = OVERLOADED_BASE_SECS << (attempt - 1);
            let low = decide(&RetryInput { attempt, ..base(Some(HintKind::Overloaded)) }, fixed(0.0));
            let high = decide(&RetryInput { attempt, ..base(Some(HintKind::Overloaded)) }, fixed(1.0));
            match (low, high) {
                (Decision::Retry { at: low_at, .. }, Decision::Retry { at: high_at, .. }) => {
                    assert_eq!((low_at - at(0)).num_seconds(), expected_base);
                    assert_eq!((high_at - at(0)).num_seconds(), expected_base * 2);
                }
                other => panic!("expected retry at attempt {attempt}: {other:?}"),
            }
        }
        assert_eq!(
            decide(&RetryInput { attempt: OVERLOADED_MAX_ATTEMPTS + 1, ..base(Some(HintKind::Overloaded)) }, fixed(0.0)),
            Decision::Decline { reason: DeclineReason::MaxAttempts }
        );
    }

    #[test]
    fn rate_limited_requires_a_known_reset() {
        let mut input = base(Some(HintKind::RateLimited));
        assert_eq!(decide(&input, fixed(0.0)), Decision::Decline { reason: DeclineReason::UnknownReset });
        input.quota_reset = Some(at(3600));
        match decide(&input, fixed(0.0)) {
            Decision::Retry { at: run_at, kind, attempt } => {
                assert_eq!(kind, RetryKind::RateLimited);
                assert_eq!(attempt, 1);
                assert_eq!((run_at - at(3600)).num_seconds(), RATE_LIMIT_PAD_SECS);
            }
            other => panic!("expected rate-limited retry: {other:?}"),
        }
        let jittered = RetryInput { quota_reset: Some(at(3600)), ..base(Some(HintKind::RateLimited)) };
        match decide(&jittered, fixed(1.0)) {
            Decision::Retry { at: run_at, .. } => {
                assert_eq!((run_at - at(3600)).num_seconds(), RATE_LIMIT_PAD_SECS + RATE_LIMIT_JITTER_SECS);
            }
            other => panic!("expected jittered retry: {other:?}"),
        }
        assert_eq!(
            decide(&RetryInput { attempt: RATE_LIMITED_MAX_ATTEMPTS + 1, quota_reset: Some(at(3600)), ..base(Some(HintKind::RateLimited)) }, fixed(0.0)),
            Decision::Decline { reason: DeclineReason::MaxAttempts }
        );
    }

    #[test]
    fn max_wait_boundary_declines_too_long() {
        // A rate-limit reset just under the cap waits; just over it declines.
        let reset = at(1000);
        let ok = RetryInput { quota_reset: Some(reset), max_wait_secs: 1015 + 30, ..base(Some(HintKind::RateLimited)) };
        assert!(matches!(decide(&ok, fixed(1.0)), Decision::Retry { .. }));
        let too_long = RetryInput { quota_reset: Some(reset), max_wait_secs: 1014, ..base(Some(HintKind::RateLimited)) };
        assert_eq!(decide(&too_long, fixed(1.0)), Decision::Decline { reason: DeclineReason::TooLong });
        // Zero means never wait for a rate-limit window.
        let zero = RetryInput { quota_reset: Some(reset), max_wait_secs: 0, ..base(Some(HintKind::RateLimited)) };
        assert_eq!(decide(&zero, fixed(0.0)), Decision::Decline { reason: DeclineReason::TooLong });
    }

    #[test]
    fn blocked_reset_takes_the_latest_full_window_in_the_future() {
        let now = at(0);
        let snapshot = json!({
            "snapshot": {"limits":[
                {"primary":{"usedPercent":100,"resetsAt":at(100).to_rfc3339()},"secondary":null},
                {"primary":{"usedPercent":100,"resetsAt":at(500).to_rfc3339()},"secondary":{"usedPercent":100,"resetsAt":at(200).to_rfc3339()}},
                {"primary":{"usedPercent":99,"resetsAt":at(900).to_rfc3339()},"secondary":null},
                {"primary":{"usedPercent":100,"resetsAt":at(-50).to_rfc3339()},"secondary":null}
            ]}
        });
        assert_eq!(blocked_reset(Some(snapshot), now), Some(at(500)));
        assert_eq!(blocked_reset(None, now), None);
    }
}
