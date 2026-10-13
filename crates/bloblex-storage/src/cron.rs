//! Minimal 5-field cron parsing and DST-correct next-occurrence computation.
//!
//! Phase 4A could not use a cron crate offline, so this module implements the
//! supported subset directly: `*`, lists (`,`), ranges (`-`), steps (`/`) and
//! three-letter month/day names. It deliberately keeps Vixie-cron's day-of-month
//! / day-of-week OR rule and resolves local wall-clock candidates against an
//! IANA zone so that a spring-forward gap is skipped (the local time does not
//! exist) and a fall-back overlap fires exactly once (only the first instant is
//! returned). Everything here is pure and deterministic.

use crate::StorageError;
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::Value;
use std::collections::BTreeSet;
use std::str::FromStr;

/// How far ahead the search walks before giving up (four leap years plus slack).
const MAX_SEARCH_DAYS: i64 = 366 * 8;
/// A `once` schedule must be at least this far in the future.
const ONCE_MIN_SECS: i64 = 60;
/// A `once` schedule may be at most this far in the future.
const ONCE_MAX_SECS: i64 = 366 * 24 * 60 * 60;

const MONTH_NAMES: [(&str, u32); 12] = [
    ("jan", 1),
    ("feb", 2),
    ("mar", 3),
    ("apr", 4),
    ("may", 5),
    ("jun", 6),
    ("jul", 7),
    ("aug", 8),
    ("sep", 9),
    ("oct", 10),
    ("nov", 11),
    ("dec", 12),
];

const DOW_NAMES: [(&str, u32); 7] = [
    ("sun", 0),
    ("mon", 1),
    ("tue", 2),
    ("wed", 3),
    ("thu", 4),
    ("fri", 5),
    ("sat", 6),
];

/// A parsed 5-field cron expression.
#[derive(Debug, Clone)]
pub struct Cron {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days_of_month: Vec<u32>,
    months: Vec<u32>,
    days_of_week: Vec<u32>,
    dom_restricted: bool,
    dow_restricted: bool,
}

fn parse_value(raw: &str, names: &[(&str, u32)]) -> Result<u32, StorageError> {
    let lower = raw.trim().to_ascii_lowercase();
    if let Some((_, value)) = names.iter().find(|(name, _)| *name == lower) {
        return Ok(*value);
    }
    lower.parse::<u32>().map_err(|_| StorageError::InvalidAgent)
}

/// Parse one field into its sorted set of values. The second return value is
/// whether the field restricts its range (used for the dom/dow OR rule).
fn parse_field(field: &str, min: u32, max: u32, names: &[(&str, u32)]) -> Result<(Vec<u32>, bool), StorageError> {
    let field = field.trim();
    if field.is_empty() {
        return Err(StorageError::InvalidAgent);
    }
    let restricted = !field.starts_with('*');
    let mut values = BTreeSet::new();
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(StorageError::InvalidAgent);
        }
        let (range, step) = match part.split_once('/') {
            Some((range, raw_step)) => {
                let step: u32 = raw_step.trim().parse().map_err(|_| StorageError::InvalidAgent)?;
                if step == 0 {
                    return Err(StorageError::InvalidAgent);
                }
                (range.trim(), step)
            }
            None => (part, 1),
        };
        let (start, end) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (parse_value(a, names)?, parse_value(b, names)?)
        } else {
            let value = parse_value(range, names)?;
            (value, value)
        };
        if start > end || start < min || end > max {
            return Err(StorageError::InvalidAgent);
        }
        let mut value = start;
        while value <= end {
            values.insert(value);
            value += step;
        }
    }
    if values.is_empty() {
        return Err(StorageError::InvalidAgent);
    }
    Ok((values.into_iter().collect(), restricted))
}

impl Cron {
    /// Parse a 5-field expression (`minute hour day-of-month month day-of-week`).
    pub fn parse(expression: &str) -> Result<Self, StorageError> {
        let fields = expression.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 5 {
            return Err(StorageError::InvalidAgent);
        }
        let (minutes, _) = parse_field(fields[0], 0, 59, &[])?;
        let (hours, _) = parse_field(fields[1], 0, 23, &[])?;
        let (days_of_month, dom_restricted) = parse_field(fields[2], 1, 31, &[])?;
        let (months, _) = parse_field(fields[3], 1, 12, &MONTH_NAMES)?;
        let (raw_dow, dow_restricted) = parse_field(fields[4], 0, 7, &DOW_NAMES)?;
        // 7 and 0 both mean Sunday.
        let days_of_week = raw_dow
            .into_iter()
            .map(|value| if value == 7 { 0 } else { value })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        Ok(Self {
            minutes,
            hours,
            days_of_month,
            months,
            days_of_week,
            dom_restricted,
            dow_restricted,
        })
    }

    fn date_matches(&self, date: NaiveDate) -> bool {
        if !self.months.contains(&date.month()) {
            return false;
        }
        let dom_ok = self.days_of_month.contains(&date.day());
        let dow_ok = self.days_of_week.contains(&date.weekday().num_days_from_sunday());
        match (self.dom_restricted, self.dow_restricted) {
            (true, true) => dom_ok || dow_ok,
            _ => dom_ok && dow_ok,
        }
    }
}

/// Resolve a local wall-clock candidate against a zone. A non-existent time
/// (spring-forward gap) yields nothing; an ambiguous time yields its earliest
/// instant and only when that instant is strictly after `after`, so a repeated
/// local hour fires once.
fn resolve_local(tz: Tz, date: NaiveDate, hour: u32, minute: u32, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let naive = date.and_hms_opt(hour, minute, 0)?;
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(value) => {
            let instant = value.with_timezone(&Utc);
            (instant > after).then_some(instant)
        }
        LocalResult::Ambiguous(first, _second) => {
            let instant = first.with_timezone(&Utc);
            (instant > after).then_some(instant)
        }
        LocalResult::None => None,
    }
}

/// The first occurrence strictly after `after`, or `None` within the search
/// horizon (for example `0 0 30 2 *`, which never occurs).
pub fn next_occurrence(cron: &Cron, tz: Tz, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let start = after + Duration::minutes(1);
    let start_date = start.with_timezone(&tz).date_naive();
    for offset in 0..=MAX_SEARCH_DAYS {
        let date = start_date + Duration::days(offset);
        if !cron.date_matches(date) {
            continue;
        }
        for hour in &cron.hours {
            for minute in &cron.minutes {
                if let Some(instant) = resolve_local(tz, date, *hour, *minute, after) {
                    return Some(instant);
                }
            }
        }
    }
    None
}

/// Parse and validate an IANA time-zone name.
pub fn parse_timezone(name: &str) -> Result<Tz, StorageError> {
    Tz::from_str(name.trim()).map_err(|_| StorageError::InvalidAgent)
}

/// RFC3339 in UTC, fixed-width milliseconds so string ordering matches time.
pub fn format_utc(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Parse an RFC3339 timestamp as a UTC instant.
pub fn parse_rfc3339_utc(raw: &str) -> Result<DateTime<Utc>, StorageError> {
    DateTime::parse_from_rfc3339(raw.trim())
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| StorageError::InvalidAgent)
}

/// A schedule normalized for storage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSchedule {
    pub kind: String,
    pub cron: Option<String>,
    pub timezone: String,
    pub once_at: Option<String>,
}

/// Validate a schedule object. `now`, when present, enforces the `once` window
/// (at least 60 seconds and at most 366 days ahead).
pub fn parse_schedule(schedule: &Value, now: Option<DateTime<Utc>>) -> Result<ParsedSchedule, StorageError> {
    let kind = schedule
        .get("kind")
        .and_then(Value::as_str)
        .ok_or(StorageError::InvalidAgent)?;
    match kind {
        "cron" => {
            let cron = schedule
                .get("cron")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(StorageError::InvalidAgent)?;
            let timezone = schedule
                .get("timezone")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(StorageError::InvalidAgent)?;
            Cron::parse(cron)?;
            parse_timezone(timezone)?;
            Ok(ParsedSchedule {
                kind: kind.to_owned(),
                cron: Some(cron.to_owned()),
                timezone: timezone.to_owned(),
                once_at: None,
            })
        }
        "once" => {
            let once_at = schedule
                .get("at")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(StorageError::InvalidAgent)?;
            let at = parse_rfc3339_utc(once_at)?;
            let timezone = schedule
                .get("timezone")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("UTC")
                .to_owned();
            parse_timezone(&timezone)?;
            if let Some(now) = now {
                let delta = at.signed_duration_since(now).num_seconds();
                if !(ONCE_MIN_SECS..=ONCE_MAX_SECS).contains(&delta) {
                    return Err(StorageError::InvalidAgent);
                }
            }
            Ok(ParsedSchedule {
                kind: kind.to_owned(),
                cron: None,
                timezone,
                once_at: Some(format_utc(at)),
            })
        }
        _ => Err(StorageError::InvalidAgent),
    }
}

/// The next `next_run_at` for a schedule strictly after `after`. `None` means
/// there is no further occurrence (a past `once`, or a cron that never fires).
pub fn next_run_at(schedule: &ParsedSchedule, after: DateTime<Utc>) -> Result<Option<String>, StorageError> {
    if schedule.kind == "once" {
        let at = schedule.once_at.as_deref().ok_or(StorageError::InvalidAgent)?;
        let at = parse_rfc3339_utc(at)?;
        return Ok((at > after).then(|| format_utc(at)));
    }
    let cron = schedule.cron.as_deref().ok_or(StorageError::InvalidAgent)?;
    let tz = parse_timezone(&schedule.timezone)?;
    let cron = Cron::parse(cron)?;
    Ok(next_occurrence(&cron, tz, after).map(format_utc))
}

/// The next `count` occurrences as `(utc, local)` RFC3339 strings. `local`
/// carries the zone offset so it is unambiguous across DST boundaries.
pub fn preview(schedule: &ParsedSchedule, count: usize, after: DateTime<Utc>) -> Result<Vec<(String, String)>, StorageError> {
    let tz = parse_timezone(&schedule.timezone)?;
    let mut results = Vec::new();
    if schedule.kind == "once" {
        let at = schedule.once_at.as_deref().ok_or(StorageError::InvalidAgent)?;
        let at = parse_rfc3339_utc(at)?;
        if at > after {
            results.push((format_utc(at), at.with_timezone(&tz).to_rfc3339_opts(SecondsFormat::Millis, false)));
        }
        return Ok(results);
    }
    let cron_expr = schedule.cron.as_deref().ok_or(StorageError::InvalidAgent)?;
    let cron = Cron::parse(cron_expr)?;
    let mut cursor = after;
    for _ in 0..count {
        let Some(next) = next_occurrence(&cron, tz, cursor) else { break };
        results.push((format_utc(next), next.with_timezone(&tz).to_rfc3339_opts(SecondsFormat::Millis, false)));
        cursor = next;
    }
    Ok(results)
}

/// A human-readable local wall-clock string for a stored occurrence (used by
/// the daemon's run rows); falls back to UTC when the zone is unavailable.
pub fn local_label(schedule: &ParsedSchedule, instant: DateTime<Utc>) -> String {
    match parse_timezone(&schedule.timezone) {
        Ok(tz) => instant.with_timezone(&tz).to_rfc3339_opts(SecondsFormat::Millis, false),
        Err(_) => format_utc(instant),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
    }

    fn cron_next(expression: &str, zone: &str, after: &str) -> Option<String> {
        let cron = Cron::parse(expression).unwrap();
        let tz = parse_timezone(zone).unwrap();
        next_occurrence(&cron, tz, utc(after)).map(format_utc)
    }

    #[test]
    fn simple_cron_nexts_and_month_end_are_correct() {
        assert_eq!(
            cron_next("0 9 * * *", "UTC", "2026-01-01T08:59:00Z").as_deref(),
            Some("2026-01-01T09:00:00.000Z")
        );
        assert_eq!(
            cron_next("0 9 * * *", "UTC", "2026-01-01T09:00:00Z").as_deref(),
            Some("2026-01-02T09:00:00.000Z")
        );
        assert_eq!(
            cron_next("0 0 31 * *", "UTC", "2026-01-31T00:00:01Z").as_deref(),
            Some("2026-03-31T00:00:00.000Z"),
            "the 31st skips February"
        );
        assert_eq!(
            cron_next("*/15 0 * * *", "UTC", "2026-01-01T00:00:00Z").as_deref(),
            Some("2026-01-01T00:15:00.000Z")
        );
        assert_eq!(
            cron_next("0 0 29 2 *", "UTC", "2026-03-01T00:00:00Z").as_deref(),
            Some("2028-02-29T00:00:00.000Z"),
            "leap day is found years ahead"
        );
        assert_eq!(cron_next("0 0 30 2 *", "UTC", "2026-01-01T00:00:00Z"), None, "February 30 never happens");
        assert_eq!(
            cron_next("0 0 * * mon", "UTC", "2026-01-01T00:00:00Z").as_deref(),
            Some("2026-01-05T00:00:00.000Z"),
            "day names are supported"
        );
        assert!(Cron::parse("not a real cron").is_err());
        assert!(Cron::parse("0 0 32 * *").is_err());
        assert!(parse_timezone("Mars/Olympus").is_err());
    }

    #[test]
    fn spring_forward_gap_is_skipped() {
        // Europe/Berlin springs forward 2026-03-29 02:00 -> 03:00, so 02:30 does
        // not exist that day.
        assert_eq!(
            cron_next("30 2 * * *", "Europe/Berlin", "2026-03-29T00:00:00Z").as_deref(),
            Some("2026-03-30T00:30:00.000Z"),
            "the non-existent local time is skipped"
        );
    }

    #[test]
    fn fall_back_overlap_runs_once() {
        // Europe/Berlin falls back 2026-10-25 03:00 -> 02:00, so 02:30 happens
        // twice: 00:30Z (CEST) then 01:30Z (CET).
        assert_eq!(
            cron_next("30 2 * * *", "Europe/Berlin", "2026-10-25T00:00:00Z").as_deref(),
            Some("2026-10-25T00:30:00.000Z"),
            "the first ambiguous instant is used"
        );
        assert_eq!(
            cron_next("30 2 * * *", "Europe/Berlin", "2026-10-25T00:30:00Z").as_deref(),
            Some("2026-10-26T01:30:00.000Z"),
            "the repeated local time does not fire a second time"
        );
        // America/New_York falls back 2026-11-01 02:00 -> 01:00, so 01:30 repeats.
        assert_eq!(
            cron_next("30 1 * * *", "America/New_York", "2026-11-01T00:00:00Z").as_deref(),
            Some("2026-11-01T05:30:00.000Z")
        );
        assert_eq!(
            cron_next("30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z").as_deref(),
            Some("2026-11-02T06:30:00.000Z")
        );
    }

    #[test]
    fn schedule_validation_enforces_the_once_window() {
        use serde_json::json;
        let now = utc("2026-01-01T00:00:00Z");
        let good = json!({"kind":"once","at":"2026-01-01T01:00:00Z"});
        assert_eq!(parse_schedule(&good, Some(now)).unwrap().once_at.as_deref(), Some("2026-01-01T01:00:00.000Z"));
        assert!(parse_schedule(&json!({"kind":"once","at":"2026-01-01T00:00:30Z"}), Some(now)).is_err(), "too soon");
        assert!(parse_schedule(&json!({"kind":"once","at":"2028-01-01T00:00:00Z"}), Some(now)).is_err(), "too far");
        assert!(parse_schedule(&json!({"kind":"cron","cron":"0 0 * * *","timezone":"Nope/Nope"}), Some(now)).is_err());
        assert!(parse_schedule(&json!({"kind":"cron","cron":"0 0 * * *"}), Some(now)).is_err(), "timezone is required");
        assert!(parse_schedule(&json!({"kind":"weekly"}), Some(now)).is_err());
    }

    #[test]
    fn preview_lists_occurrences_in_both_zones() {
        use serde_json::json;
        let schedule = parse_schedule(&json!({"kind":"cron","cron":"0 9 * * *","timezone":"Europe/Berlin"}), None).unwrap();
        let items = preview(&schedule, 3, utc("2026-06-01T00:00:00Z")).unwrap();
        assert_eq!(items[0].0, "2026-06-01T07:00:00.000Z", "09:00 CEST is 07:00Z");
        assert!(items[0].1.starts_with("2026-06-01T09:00:00"), "local string keeps the wall clock: {}", items[0].1);
        assert_eq!(items.len(), 3);
    }
}
