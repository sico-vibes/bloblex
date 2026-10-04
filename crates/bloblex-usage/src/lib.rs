use serde::{Deserialize, Serialize};
use chrono::{DateTime, Datelike, Timelike, Utc};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub model: Option<String>,
    pub reported_cost_minor: Option<i64>,
    pub currency: Option<String>,
    pub source: String,
    pub raw: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CostBasis {
    ProviderReportedActual,
    ApiRateEstimate,
    SubscriptionFixed,
    LocalFree,
    Unknown,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceRule {
    pub id: String,
    pub provider: String,
    pub canonical_model_id: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub input_per_million: Option<String>,
    pub output_per_million: Option<String>,
    pub cache_read_per_million: Option<String>,
    pub cache_write_per_million: Option<String>,
    pub currency: String,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub source_url: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub checked_at: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub tiers: Vec<PriceTier>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PriceTier {
    pub kind: String,
    #[serde(default)]
    pub threshold_input_tokens: Option<u64>,
    #[serde(default)]
    pub days_of_week_utc: Vec<u32>,
    #[serde(default)]
    pub windows_utc: Vec<PriceWindow>,
    #[serde(default)]
    pub duration_minutes: Option<u32>,
    #[serde(rename = "inputPerMTok")]
    pub input_per_million: Option<String>,
    #[serde(rename = "outputPerMTok")]
    pub output_per_million: Option<String>,
    #[serde(rename = "cacheReadPerMTok")]
    pub cache_read_per_million: Option<String>,
    #[serde(rename = "cacheWritePerMTok")]
    pub cache_write_per_million: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PriceWindow { pub start: String, pub end: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Valuation {
    pub basis: CostBasis,
    pub amount_minor: Option<i64>,
    pub currency: Option<String>,
    pub pricing_rule_id: Option<String>,
    pub status: String,
}
pub fn normalize_codex(
    total_input: Option<u64>,
    cached_input: Option<u64>,
    output: Option<u64>,
    raw: serde_json::Value,
) -> UsageRecord {
    let cache = cached_input;
    let input = match (total_input, cache) {
        (Some(t), Some(c)) => Some(t.saturating_sub(c)),
        (v, None) => v,
        (None, _) => None,
    };
    UsageRecord {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache,
        cache_write_tokens: None,
        reasoning_tokens: None,
        model: None,
        reported_cost_minor: None,
        currency: None,
        source: "stream".into(),
        raw,
    }
}

pub fn normalize_codex_with_cache_write(
    total_input: Option<u64>,
    cached_input: Option<u64>,
    cache_write_input: Option<u64>,
    output: Option<u64>,
    raw: serde_json::Value,
) -> UsageRecord {
    let input_tokens = match (total_input, cached_input, cache_write_input) {
        (Some(total), Some(cached), Some(written)) => total
            .checked_sub(cached)
            .and_then(|remaining| remaining.checked_sub(written)),
        (Some(total), Some(cached), None) => total.checked_sub(cached),
        (total, None, None) => total,
        _ => None,
    };
    UsageRecord {
        input_tokens,
        output_tokens: output,
        cache_read_tokens: cached_input,
        cache_write_tokens: cache_write_input,
        reasoning_tokens: None,
        model: None,
        reported_cost_minor: None,
        currency: None,
        source: "stream".into(),
        raw,
    }
}
pub fn resolve_rule<'a>(
    provider: &str,
    model: Option<&str>,
    rules: &'a [PriceRule],
) -> Option<&'a PriceRule> {
    let model = model?;
    rules.iter().find(|rule| rule_matches(provider, model, rule))
}
pub fn resolve_rule_at<'a>(
    provider: &str,
    model: Option<&str>,
    valuation_date: &str,
    rules: &'a [PriceRule],
) -> Option<&'a PriceRule> {
    let model = model?;
    let date = valuation_date.get(..10)?;
    rules.iter().find(|rule| rule_matches(provider, model, rule)
        && rule.effective_from.get(..10).is_some_and(|from| from <= date)
        && rule.effective_to.as_deref().is_none_or(|to| to.get(..10).is_some_and(|to| date < to)))
}

/// Fills blank override buckets from the next eligible source while retaining user-supplied decimal strings.
pub fn complete_user_override(provider: &str, override_rule: &PriceRule, lower_priority_rules: &[PriceRule]) -> PriceRule {
    let Some(base) = resolve_rule(provider, Some(&override_rule.canonical_model_id), lower_priority_rules) else { return override_rule.clone(); };
    let mut merged = override_rule.clone();
    merged.input_per_million = override_rule.input_per_million.clone().or_else(|| base.input_per_million.clone());
    merged.output_per_million = override_rule.output_per_million.clone().or_else(|| base.output_per_million.clone());
    merged.cache_read_per_million = override_rule.cache_read_per_million.clone().or_else(|| base.cache_read_per_million.clone());
    merged.cache_write_per_million = override_rule.cache_write_per_million.clone().or_else(|| base.cache_write_per_million.clone());
    if merged.source_url.is_none() { merged.source_url = base.source_url.clone(); }
    if merged.notes.is_none() { merged.notes = base.notes.clone(); }
    merged.tiers = base.tiers.clone();
    for tier in &mut merged.tiers {
        if let Some(rate) = &override_rule.input_per_million { tier.input_per_million = Some(rate.clone()); }
        if let Some(rate) = &override_rule.output_per_million { tier.output_per_million = Some(rate.clone()); }
        if let Some(rate) = &override_rule.cache_read_per_million { tier.cache_read_per_million = Some(rate.clone()); }
        if let Some(rate) = &override_rule.cache_write_per_million { tier.cache_write_per_million = Some(rate.clone()); }
    }
    for alias in &base.aliases { if !merged.aliases.contains(alias) { merged.aliases.push(alias.clone()); } }
    merged
}

fn rule_matches(provider: &str, model: &str, rule: &PriceRule) -> bool {
    let (route, suffix) = model.split_once('/').unwrap_or((provider, model));
    let normalized_provider = |value: &str| -> String { match value.to_ascii_lowercase().as_str() {
        "claude" | "anthropic" => "anthropic".into(),
        "codex" | "openai" => "openai".into(),
        "opencode" | "opencode-zen" | "opencode-go" => "opencode".into(),
        other => other.to_owned(),
    }};
    let same_provider = rule.provider.eq_ignore_ascii_case(provider)
        || normalized_provider(&rule.provider) == normalized_provider(provider)
            && (normalized_provider(provider) != "opencode"
                || match rule.provider.as_str() {
                    "opencode-zen" => route == "opencode",
                    "opencode-go" => route == "opencode-go",
                    _ => true,
                });
    if !same_provider { return false; }
    let candidates = [canonical_model_key(provider, model), canonical_model_key(route, suffix), model.trim().to_ascii_lowercase()];
    let matches_id = |id: &str| {
        let key = canonical_model_key(&rule.provider, id);
        candidates.iter().any(|candidate| candidate == &key)
    };
    matches_id(&rule.canonical_model_id) || rule.aliases.iter().any(|alias| matches_id(alias))
}

fn canonical_model_key(provider: &str, model: &str) -> String {
    let mut key = model.trim().to_ascii_lowercase();
    let routed_prefix = format!("{}/", provider.to_ascii_lowercase());
    if key.starts_with(&routed_prefix) {
        key.drain(..routed_prefix.len());
    }
    if key.ends_with("[1m]") {
        key.truncate(key.len() - 4);
    }
    if key.ends_with("-latest") {
        key.truncate(key.len() - 7);
    }
    if let Some((base, snapshot)) = key.rsplit_once('-') {
        if snapshot.len() == 8 && snapshot.bytes().all(|byte| byte.is_ascii_digit()) {
            key = base.to_owned();
        }
    }
    key
}
pub fn estimate(record: &UsageRecord, rule: Option<&PriceRule>) -> Valuation {
    estimate_at(record, rule, None)
}

pub fn estimate_at(record: &UsageRecord, rule: Option<&PriceRule>, turn_timestamp: Option<&str>) -> Valuation {
    let Some(rule) = rule else {
        return Valuation {
            basis: CostBasis::Unknown,
            amount_minor: None,
            currency: None,
            pricing_rule_id: None,
            status: "unavailable".into(),
        };
    };
    let (rates, may_be_high) = select_tier_rates(rule, record.input_tokens, turn_timestamp);
    let buckets = [
        (record.input_tokens, rates.input.as_deref()),
        (record.output_tokens, rates.output.as_deref()),
        (record.cache_read_tokens, rates.cache_read.as_deref()),
        (record.cache_write_tokens, rates.cache_write.as_deref()),
    ];
    let mut total = 0i128;
    let mut missing = false;
    for (tokens, rate) in buckets {
        match (tokens, rate) {
            (Some(0), _) => {}
            (Some(tokens), Some(rate)) => {
                if let Some(scaled_major) = decimal_scaled(rate) {
                    let amount = i128::from(tokens).checked_mul(scaled_major).and_then(|n| n.checked_mul(minor_units_per_major(&rule.currency)));
                    if let Some(amount) = amount.and_then(|n| total.checked_add(n)) { total = amount; } else { missing = true; }
                } else { missing = true; }
            }
            _ => missing = true,
        }
    }
    if !buckets.iter().any(|(tokens, _)| tokens.is_some()) {
        return Valuation {
            basis: CostBasis::Unknown,
            amount_minor: None,
            currency: None,
            pricing_rule_id: Some(rule.id.clone()),
            status: "incomplete_usage".into(),
        };
    }
    let amount_minor = round_half_up_ratio(total, 1_000_000_000_000_000_000i128);
    if missing && total == 0 {
        return Valuation { basis: CostBasis::Unknown, amount_minor: None, currency: None, pricing_rule_id: Some(rule.id.clone()), status: if may_be_high { "unavailable_may_be_high".into() } else { "unavailable".into() } };
    }
    Valuation {
        basis: CostBasis::ApiRateEstimate,
        amount_minor,
        currency: Some(rule.currency.clone()),
        pricing_rule_id: Some(rule.id.clone()),
        status: if missing || amount_minor.is_none() { if may_be_high { "lower_bound_may_be_high".into() } else { "lower_bound".into() } } else if may_be_high { "may_be_high".into() } else { "estimated".into() },
    }
}

#[derive(Default)]
struct SelectedRates { input: Option<String>, output: Option<String>, cache_read: Option<String>, cache_write: Option<String> }
impl From<&PriceRule> for SelectedRates {
    fn from(rule: &PriceRule) -> Self { Self { input: rule.input_per_million.clone(), output: rule.output_per_million.clone(), cache_read: rule.cache_read_per_million.clone(), cache_write: rule.cache_write_per_million.clone() } }
}
fn select_tier_rates(rule: &PriceRule, input_tokens: Option<u64>, timestamp: Option<&str>) -> (SelectedRates, bool) {
    let mut rates = SelectedRates::from(rule);
    let mut may_be_high = false;
    let long_tiers = rule.tiers.iter().filter(|tier| tier.kind == "long_context").collect::<Vec<_>>();
    let long_tier = match input_tokens {
        Some(tokens) => long_tiers.iter().copied().filter(|tier| tier.threshold_input_tokens.is_some_and(|limit| tokens > limit)).max_by_key(|tier| tier.threshold_input_tokens.unwrap_or(0)),
        None => { may_be_high |= !long_tiers.is_empty(); long_tiers.iter().copied().max_by_key(|tier| tier.threshold_input_tokens.unwrap_or(0)) },
    };
    if let Some(tier) = long_tier { apply_full_tier(&mut rates, tier); }

    let time_tiers = rule.tiers.iter().filter(|tier| tier.kind == "time_window").collect::<Vec<_>>();
    let time_tier = timestamp.and_then(parse_utc_minute).and_then(|(weekday, minute)| time_tiers.iter().copied().find(|tier| tier.days_of_week_utc.contains(&weekday) && tier.windows_utc.iter().any(|window| window_contains(window, minute))));
    if let Some(tier) = time_tier { apply_full_tier(&mut rates, tier); }
    else if !time_tiers.is_empty() && timestamp.and_then(parse_utc_minute).is_none() {
        if let Some(tier) = time_tiers.iter().copied().max_by_key(|tier| tier_score(tier)) { apply_full_tier(&mut rates, tier); may_be_high = true; }
    }

    let duration_tiers = rule.tiers.iter().filter(|tier| tier.kind == "cache_write_duration").collect::<Vec<_>>();
    if let Some(tier) = duration_tiers.iter().copied().max_by_key(|tier| tier.cache_write_per_million.as_deref().and_then(decimal_scaled).unwrap_or(0)) {
        let tier_rate = tier.cache_write_per_million.as_deref().and_then(decimal_scaled);
        let current_rate = rates.cache_write.as_deref().and_then(decimal_scaled);
        if tier_rate.is_some_and(|rate| current_rate.is_none_or(|current| rate > current)) {
            rates.cache_write = tier.cache_write_per_million.clone();
            may_be_high = true;
        }
    }
    (rates, may_be_high)
}
fn apply_full_tier(rates: &mut SelectedRates, tier: &PriceTier) {
    rates.input = tier.input_per_million.clone(); rates.output = tier.output_per_million.clone();
    rates.cache_read = tier.cache_read_per_million.clone(); rates.cache_write = tier.cache_write_per_million.clone();
}
fn tier_score(tier: &PriceTier) -> i128 {
    [&tier.input_per_million, &tier.output_per_million, &tier.cache_read_per_million, &tier.cache_write_per_million]
        .iter().filter_map(|rate| rate.as_deref().and_then(decimal_scaled)).sum()
}
fn parse_utc_minute(timestamp: &str) -> Option<(u32, u16)> {
    let utc = DateTime::parse_from_rfc3339(timestamp).ok()?.with_timezone(&Utc);
    Some((utc.weekday().number_from_monday(), (utc.hour() * 60 + utc.minute()) as u16))
}
fn window_contains(window: &PriceWindow, minute: u16) -> bool {
    let parse = |value: &str| { let (hour, minute) = value.split_once(':')?; Some((hour.parse::<u16>().ok()? * 60) + minute.parse::<u16>().ok()?) };
    parse(&window.start).zip(parse(&window.end)).is_some_and(|(start, end)| minute >= start && minute < end)
}

/// Converts an exact numerator/denominator to minor currency units, rounding non-negative halves up.
pub fn round_half_up_ratio(numerator: i128, denominator: i128) -> Option<i64> {
    if numerator < 0 || denominator <= 0 { return None; }
    i64::try_from(numerator.checked_add(denominator / 2)? / denominator).ok()
}

pub fn valid_rate_decimal(value: &str) -> bool {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    !whole.is_empty() && whole.len() <= 12 && whole.bytes().all(|byte| byte.is_ascii_digit())
        && fraction.len() <= 12 && fraction.bytes().all(|byte| byte.is_ascii_digit())
        && decimal_scaled(value).is_some()
}

pub fn minor_units_to_major_decimal(amount: i64, currency: &str) -> Option<String> {
    let factor = i64::try_from(minor_units_per_major(currency)).ok()?;
    let digits = match factor { 1 => 0, 100 => 2, 1000 => 3, _ => return None };
    let sign = if amount < 0 { "-" } else { "" };
    let absolute = amount.checked_abs()?;
    let whole = absolute / factor;
    if digits == 0 { return Some(format!("{sign}{whole}")); }
    let fraction = format!("{:0width$}", absolute % factor, width = digits);
    let fraction = fraction.trim_end_matches('0');
    if fraction.is_empty() { Some(format!("{sign}{whole}")) } else { Some(format!("{sign}{whole}.{fraction}")) }
}
fn minor_units_per_major(currency: &str) -> i128 {
    match currency.to_ascii_uppercase().as_str() {
        "BIF" | "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW" | "PYG" | "UGX" | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => 1,
        "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 1000,
        _ => 100,
    }
}

/// Versioned official data is shipped as exact decimal strings, in major currency units per million tokens.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficialPriceFile { schema_version: u32, entries: Vec<OfficialPriceEntry> }
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficialPriceEntry {
    provider: String, model_id: String, #[serde(default)] aliases: Vec<String>, currency: String,
    #[serde(rename = "inputPerMTok")] input_per_million: Option<String>,
    #[serde(rename = "outputPerMTok")] output_per_million: Option<String>,
    #[serde(rename = "cacheReadPerMTok")] cache_read_per_million: Option<String>,
    #[serde(rename = "cacheWritePerMTok")] cache_write_per_million: Option<String>,
    source_url: String, checked_at: String, #[serde(default)] notes: Option<String>,
    #[serde(default)] tiers: Vec<PriceTier>,
}
pub fn load_official_price_rules(text: &str) -> Result<Vec<PriceRule>, String> {
    let file: OfficialPriceFile = serde_json::from_str(text).map_err(|_| "official price data is invalid".to_owned())?;
    if file.schema_version != 1 { return Err("official price metadata is invalid".into()); }
    let mut ids = std::collections::HashSet::new();
    file.entries.into_iter().map(|entry| {
        if entry.provider.trim().is_empty() || entry.model_id.trim().is_empty() || entry.currency.len() != 3 || !entry.currency.bytes().all(|byte| byte.is_ascii_alphabetic()) || !entry.source_url.starts_with("https://") || !valid_date(&entry.checked_at) || !ids.insert((entry.provider.to_ascii_lowercase(), entry.model_id.to_ascii_lowercase())) { return Err("official price entry is invalid".into()); }
        for rate in [&entry.input_per_million, &entry.output_per_million, &entry.cache_read_per_million, &entry.cache_write_per_million].into_iter().flatten() {
            if !valid_rate_decimal(rate) { return Err("official price rate must be a non-negative decimal with at most twelve fractional places".into()); }
        }
        for tier in &entry.tiers {
            if !matches!(tier.kind.as_str(), "long_context" | "time_window" | "cache_write_duration") { return Err("official price tier kind is invalid".into()); }
            for rate in [&tier.input_per_million, &tier.output_per_million, &tier.cache_read_per_million, &tier.cache_write_per_million].into_iter().flatten() {
                if !valid_rate_decimal(rate) { return Err("official price tier rate is invalid".into()); }
            }
            match tier.kind.as_str() {
                "long_context" if tier.threshold_input_tokens.is_none_or(|limit| limit == 0) => return Err("long-context tier requires a positive input threshold".into()),
                "time_window" if tier.days_of_week_utc.is_empty() || tier.windows_utc.is_empty() || tier.days_of_week_utc.iter().any(|day| !(1..=7).contains(day)) || tier.windows_utc.iter().any(|window| !valid_time(&window.start) || !valid_time(&window.end) || time_minutes(&window.start) >= time_minutes(&window.end)) => return Err("time-window tier is invalid".into()),
                "cache_write_duration" if tier.duration_minutes.is_none_or(|duration| duration == 0) => return Err("cache-write duration tier requires a positive duration".into()),
                _ => {}
            }
        }
        Ok(PriceRule { id: format!("official:{}:{}", entry.provider, entry.model_id), provider: entry.provider, canonical_model_id: entry.model_id, aliases: entry.aliases, input_per_million: entry.input_per_million, output_per_million: entry.output_per_million, cache_read_per_million: entry.cache_read_per_million, cache_write_per_million: entry.cache_write_per_million, currency: entry.currency, effective_from: "0000-01-01".into(), effective_to: None, source_url: Some(entry.source_url), source: Some("official_price_list".into()), checked_at: Some(entry.checked_at), notes: entry.notes, tiers: entry.tiers })
    }).collect()
}
pub fn shipped_official_price_rules() -> Result<Vec<PriceRule>, String> {
    static RULES: std::sync::OnceLock<Result<Vec<PriceRule>, String>> = std::sync::OnceLock::new();
    RULES.get_or_init(|| load_official_price_rules(include_str!("../data/official-prices.json"))).clone()
}
fn valid_date(date: &str) -> bool { date.len() == 10 && date.as_bytes()[4] == b'-' && date.as_bytes()[7] == b'-' && date.bytes().enumerate().all(|(i,b)| i == 4 || i == 7 || b.is_ascii_digit()) }
fn valid_time(value: &str) -> bool { let Some((hour, minute)) = value.split_once(':') else { return false }; hour.parse::<u32>().is_ok_and(|n| n < 24) && minute.parse::<u32>().is_ok_and(|n| n < 60) }
fn time_minutes(value: &str) -> u32 { let (hour, minute) = value.split_once(':').unwrap_or(("0", "0")); hour.parse::<u32>().unwrap_or(0) * 60 + minute.parse::<u32>().unwrap_or(0) }
fn decimal_scaled(text: &str) -> Option<i128> {
    decimal_scaled_at(text, 12)
}
fn decimal_scaled_at(text: &str, scale_digits: u32) -> Option<i128> {
    let exponent_split = text.split_once('e').or_else(|| text.split_once('E'));
    let mantissa = exponent_split.map_or(text, |(mantissa, _)| mantissa);
    let exponent = exponent_split.map_or(Some(0), |(_, exponent)| exponent.parse::<i32>().ok())?;
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if whole.is_empty() || whole.len() > 12 || fraction.len() > 36 || !whole.bytes().all(|b| b.is_ascii_digit()) || !fraction.bytes().all(|b| b.is_ascii_digit()) { return None; }
    let digits = format!("{whole}{fraction}").parse::<i128>().ok()?;
    let power = exponent.checked_sub(i32::try_from(fraction.len()).ok()?)?.checked_add(scale_digits as i32)?;
    if power >= 0 {
        digits.checked_mul(10i128.checked_pow(power as u32)?)
    } else {
        let divisor = 10i128.checked_pow((-power) as u32)?;
        (digits % divisor == 0).then_some(digits / divisor)
    }
}
pub fn major_currency_decimal_to_minor(value: &str, currency: &str) -> Option<i64> {
    let scaled = decimal_scaled_at(value, 18)?;
    let numerator = scaled.checked_mul(minor_units_per_major(currency))?;
    round_half_up_ratio(numerator, 1_000_000_000_000_000_000i128)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cached_tokens_are_exclusive() {
        let n = normalize_codex(Some(100), Some(35), Some(10), serde_json::json!({}));
        assert_eq!(n.input_tokens, Some(65));
        assert_eq!(n.cache_read_tokens, Some(35));
        let unknown_total = normalize_codex(None, Some(35), Some(10), serde_json::json!({}));
        assert_eq!(unknown_total.input_tokens, None);
    }
    #[test]
    fn codex_subtracts_both_cache_buckets_only_when_the_subtraction_is_valid() {
        let usage = normalize_codex_with_cache_write(Some(100), Some(20), Some(15), Some(10), serde_json::json!({}));
        assert_eq!(usage.input_tokens, Some(65));
        assert_eq!(usage.cache_read_tokens, Some(20));
        assert_eq!(usage.cache_write_tokens, Some(15));
        let invalid = normalize_codex_with_cache_write(Some(30), Some(20), Some(15), Some(10), serde_json::json!({}));
        assert_eq!(invalid.input_tokens, None);
    }
    #[test]
    fn unknown_model_never_looks_free() {
        let u = UsageRecord::default();
        assert_eq!(estimate(&u, None).amount_minor, None);
    }
    #[test]
    fn aliases_are_explicit() {
        let r = PriceRule {
            id: "p".into(),
            provider: "x".into(),
            canonical_model_id: "model-v1".into(),
            aliases: vec!["latest".into()],
            input_per_million: Some("0.10".into()),
            output_per_million: Some("0.20".into()),
            cache_read_per_million: None,
            cache_write_per_million: None,
            currency: "USD".into(),
            effective_from: "2026-01-01".into(),
            effective_to: None,
            source_url: None,
            source: None, checked_at: None, notes: None, tiers: Vec::new(),
        };
        assert_eq!(resolve_rule("x", Some("LATEST"), &[r]).unwrap().id, "p");
    }
    #[test]
    fn model_keys_drop_routing_snapshot_and_context_suffixes() {
        let r = PriceRule {
            id: "p".into(),
            provider: "x".into(),
            canonical_model_id: "model-v1".into(),
            aliases: vec![],
            input_per_million: Some("0.10".into()),
            output_per_million: Some("0.20".into()),
            cache_read_per_million: None,
            cache_write_per_million: None,
            currency: "USD".into(),
            effective_from: "2026-01-01".into(),
            effective_to: None,
            source_url: None,
            source: None, checked_at: None, notes: None, tiers: Vec::new(),
        };
        assert_eq!(resolve_rule("x", Some("X/model-v1-20260930[1m]"), &[r]).unwrap().id, "p");
    }
    #[test]
    fn missing_cache_rate_is_not_valued_as_free() {
        let r = PriceRule {
            id: "p".into(),
            provider: "x".into(),
            canonical_model_id: "m".into(),
            aliases: vec![],
            input_per_million: Some("0.10".into()),
            output_per_million: Some("0.20".into()),
            cache_read_per_million: None,
            cache_write_per_million: None,
            currency: "USD".into(),
            effective_from: "2026-01-01".into(),
            effective_to: None,
            source_url: None,
            source: None, checked_at: None, notes: None, tiers: Vec::new(),
        };
        let u = UsageRecord {
            input_tokens: Some(1_000_000),
            output_tokens: Some(1),
            cache_read_tokens: Some(50),
            ..Default::default()
        };
        let value = estimate(&u, Some(&r));
        assert_eq!(value.amount_minor, Some(10));
        assert_eq!(value.status, "lower_bound");
    }

    #[test]
    fn unknown_positive_token_bucket_never_becomes_a_zero_cost() {
        let rule = PriceRule { id: "partial".into(), provider: "x".into(), canonical_model_id: "m".into(), aliases: vec![], input_per_million: None, output_per_million: None, cache_read_per_million: None, cache_write_per_million: None, currency: "USD".into(), effective_from: "2026-01-01".into(), effective_to: None, source_url: None, source: None, checked_at: None, notes: None, tiers: Vec::new() };
        let usage = UsageRecord { input_tokens: Some(10), ..Default::default() };
        let value = estimate(&usage, Some(&rule));
        assert_eq!(value.amount_minor, None);
        assert_eq!(value.status, "unavailable");
    }
    #[test]
    fn pricing_effective_window_is_end_exclusive() {
        let r = PriceRule {
            id: "p".into(),
            provider: "x".into(),
            canonical_model_id: "m".into(),
            aliases: vec![],
            input_per_million: Some("0.10".into()),
            output_per_million: Some("0.20".into()),
            cache_read_per_million: None,
            cache_write_per_million: None,
            currency: "USD".into(),
            effective_from: "2026-09-01".into(),
            effective_to: Some("2026-10-01".into()),
            source_url: None,
            source: None, checked_at: None, notes: None, tiers: Vec::new(),
        };
        assert!(resolve_rule_at("x", Some("m"), "2026-09-30T23:59:59Z", &[r.clone()]).is_some());
        assert!(resolve_rule_at("x", Some("m"), "2026-10-01T00:00:00Z", &[r]).is_none());
    }

    #[test]
    fn user_override_precedes_shipped_rate_for_the_estimate() {
        let shipped = PriceRule {
            id: "shipped".into(),
            provider: "codex".into(),
            canonical_model_id: "model-a".into(),
            aliases: vec![],
            input_per_million: Some("0.10".into()),
            output_per_million: Some("0".into()),
            cache_read_per_million: Some("0".into()),
            cache_write_per_million: Some("0".into()),
            currency: "USD".into(),
            effective_from: "2026-01-01".into(),
            effective_to: None,
            source_url: None,
            source: Some("official_price_list".into()), checked_at: None, notes: None, tiers: Vec::new(),
        };
        let override_rule = PriceRule {
            id: "user-override".into(),
            input_per_million: Some("0.25".into()),
            source: Some("user_override".into()),
            ..shipped.clone()
        };
        let rules = [override_rule, shipped];
        let selected = resolve_rule_at("codex", Some("model-a"), "2026-10-03T00:00:00Z", &rules).unwrap();
        assert_eq!(selected.id, "user-override");
        let record = UsageRecord {
            input_tokens: Some(1_000_000),
            output_tokens: Some(0),
            cache_read_tokens: Some(0),
            cache_write_tokens: Some(0),
            model: Some("model-a".into()),
            ..Default::default()
        };
        let value = estimate(&record, Some(selected));
        assert_eq!(value.amount_minor, Some(25));
        assert_eq!(value.pricing_rule_id.as_deref(), Some("user-override"));
    }

    #[test]
    fn official_file_is_versioned_validated_and_preserves_exact_decimal_rates() {
        let rules = load_official_price_rules(r#"{"schemaVersion":1,"entries":[{"provider":"sample","modelId":"m","aliases":["latest"],"currency":"USD","inputPerMTok":"0.00001","outputPerMTok":"0.25","cacheReadPerMTok":"0","cacheWritePerMTok":null,"sourceUrl":"https://example.invalid/prices","checkedAt":"2026-10-04"}]}"#).unwrap();
        assert_eq!(rules[0].input_per_million.as_deref(), Some("0.00001"));
        assert_eq!(rules[0].source.as_deref(), Some("official_price_list"));
        assert_eq!(rules[0].checked_at.as_deref(), Some("2026-10-04"));
        assert_eq!(decimal_scaled("0.000000000001"), Some(1));
        assert!(load_official_price_rules(r#"{"schemaVersion":1,"entries":[{"provider":"sample","modelId":"m","currency":"USD","inputPerMTok":"0.0000000000001","sourceUrl":"https://example.invalid/prices","checkedAt":"2026-10-04"}]}"#).is_err());
        assert!(!shipped_official_price_rules().unwrap().is_empty());
    }

    #[test]
    fn every_shipped_official_row_validates_and_known_models_resolve_by_provider_and_gateway() {
        let rules = shipped_official_price_rules().unwrap();
        let count = |provider: &str| rules.iter().filter(|rule| rule.provider == provider).count();
        assert_eq!(count("anthropic"), 13);
        assert_eq!(count("openai"), 23);
        assert_eq!(count("opencode-zen"), 84);
        assert_eq!(count("opencode-go"), 30);
        assert!(rules.iter().all(|rule| rule.checked_at.as_deref() == Some("2026-10-04")));
        let input_rate = |provider, model| resolve_rule_at(provider, Some(model), "2026-10-04T12:00:00Z", &rules).unwrap().input_per_million.clone().unwrap();
        assert_eq!(input_rate("claude", "claude-opus-5-5"), "4");
        assert_eq!(input_rate("codex", "gpt-6.1-sol"), "2");
        assert_eq!(input_rate("codex", "gpt-5.2-pro"), "21.00");
        assert_eq!(input_rate("opencode", "opencode/big-pickle"), "0");
        assert_eq!(input_rate("opencode", "opencode-go/deepseek-v4.1-flash"), "0.15");
        let historical = resolve_rule_at("codex", Some("gpt-6.1-sol"), "2026-10-03T12:00:00Z", &rules).unwrap();
        assert_eq!(historical.checked_at.as_deref(), Some("2026-10-04"));
        assert!(historical.effective_from.starts_with("0000-"));
        let deepseek = resolve_rule_at("opencode", Some("opencode-go/deepseek-v4.1-flash"), "2026-10-03T12:00:00Z", &rules).unwrap();
        assert!(deepseek.tiers.iter().any(|tier| tier.kind == "time_window" && tier.days_of_week_utc == [1, 2, 3, 4, 5]));
        let anthropic = resolve_rule("claude", Some("claude-fable-5-1"), &rules).unwrap();
        assert!(anthropic.tiers.iter().any(|tier| tier.kind == "cache_write_duration" && tier.duration_minutes == Some(60)));
        assert!(resolve_rule("claude", Some("sonnet"), &rules).is_none(), "unconfirmed CLI aliases must not be invented");
    }

    #[test]
    fn long_context_rate_notes_defer_to_structured_tier_rates() {
        let rules = shipped_official_price_rules().unwrap();
        for (provider, model_id, expected) in [
            ("opencode-go", "opencode-go/grok-4.6", ["4", "12", "1", ""]),
            ("opencode-zen", "opencode/grok-4.6", ["4", "12", "1", ""]),
            ("opencode-go", "opencode-go/qwen3.7-plus", ["1.20", "4.80", "0.12", "1.50"]),
        ] {
            let rule = rules.iter().find(|rule| rule.provider == provider && rule.canonical_model_id == model_id).unwrap();
            assert!(rule.notes.as_deref().is_none_or(|notes| !notes.contains('$')));
            let tier = rule.tiers.iter().find(|tier| tier.kind == "long_context").unwrap();
            assert_eq!(tier.input_per_million.as_deref().unwrap_or(""), expected[0]);
            assert_eq!(tier.output_per_million.as_deref().unwrap_or(""), expected[1]);
            assert_eq!(tier.cache_read_per_million.as_deref().unwrap_or(""), expected[2]);
            assert_eq!(tier.cache_write_per_million.as_deref().unwrap_or(""), expected[3]);
        }
    }

    #[test]
    fn official_gateway_rate_precedes_catalog_estimate_but_user_override_precedes_both() {
        let base = PriceRule { id: "catalog".into(), provider: "opencode-go".into(), canonical_model_id: "gpt-6-luna".into(), aliases: vec![], input_per_million: Some("0.01".into()), output_per_million: Some("0.02".into()), cache_read_per_million: Some("0.001".into()), cache_write_per_million: None, currency: "USD".into(), effective_from: "2026-10-04".into(), effective_to: None, source_url: None, source: Some("opencode_catalog_estimate".into()), checked_at: None, notes: None, tiers: Vec::new() };
        let official = PriceRule { id: "official".into(), input_per_million: Some("0.10".into()), source: Some("official_price_list".into()), ..base.clone() };
        let candidates = [official.clone(), base.clone()];
        let catalog = resolve_rule_at("opencode", Some("opencode-go/gpt-6-luna"), "2026-10-04T12:00:00Z", &candidates).unwrap();
        assert_eq!(catalog.id, "official");
        let user = PriceRule { id: "override".into(), provider: "opencode".into(), canonical_model_id: "opencode-go/gpt-6-luna".into(), input_per_million: Some("0.17".into()), source: Some("user_override".into()), ..base };
        let candidates = [user, official];
        let selected = resolve_rule_at("opencode", Some("opencode-go/gpt-6-luna"), "2026-10-04T12:00:00Z", &candidates).unwrap();
        assert_eq!(selected.id, "override");
    }

    #[test]
    fn partial_user_override_inherits_other_official_decimal_buckets_and_tiers() {
        let official = PriceRule { id: "official".into(), provider: "opencode-go".into(), canonical_model_id: "gpt-6-luna".into(), aliases: vec![], input_per_million: Some("0.10".into()), output_per_million: Some("0.50".into()), cache_read_per_million: Some("0.01".into()), cache_write_per_million: Some("0.125".into()), currency: "USD".into(), effective_from: "0000-01-01".into(), effective_to: None, source_url: Some("https://example.invalid/price".into()), source: Some("official_price_list".into()), checked_at: Some("2026-10-04".into()), notes: Some("notes".into()), tiers: vec![PriceTier { kind: "long_context".into(), threshold_input_tokens: Some(272_000), input_per_million: Some("0.20".into()), output_per_million: Some("0.75".into()), cache_read_per_million: Some("0.02".into()), cache_write_per_million: Some("0.25".into()), ..Default::default() }] };
        let user = PriceRule { id: "user".into(), provider: "opencode".into(), canonical_model_id: "opencode-go/gpt-6-luna".into(), aliases: vec![], input_per_million: Some("0.003".into()), output_per_million: None, cache_read_per_million: None, cache_write_per_million: None, currency: "USD".into(), effective_from: "2026-10-05".into(), effective_to: None, source_url: None, source: Some("user_override".into()), checked_at: None, notes: None, tiers: vec![] };
        let merged = complete_user_override("opencode", &user, &[official]);
        assert_eq!(merged.input_per_million.as_deref(), Some("0.003"));
        assert_eq!(merged.output_per_million.as_deref(), Some("0.50"));
        assert_eq!(merged.cache_read_per_million.as_deref(), Some("0.01"));
        assert_eq!(merged.cache_write_per_million.as_deref(), Some("0.125"));
        assert_eq!(merged.tiers[0].input_per_million.as_deref(), Some("0.003"));
        assert_eq!(merged.tiers[0].output_per_million.as_deref(), Some("0.75"));
    }

    #[test]
    fn fractional_cent_rates_are_kept_until_usage_is_valued() {
        let rule = load_official_price_rules(r#"{"schemaVersion":1,"entries":[{"provider":"sample","modelId":"m","currency":"USD","inputPerMTok":"0.004","sourceUrl":"https://example.invalid/prices","checkedAt":"2026-10-04"}]}"#).unwrap().remove(0);
        let usage = UsageRecord { input_tokens: Some(3_000_000), model: Some("m".into()), ..Default::default() };
        let value = estimate(&usage, Some(&rule));
        assert_eq!(value.amount_minor, Some(1));
        assert_eq!(value.currency.as_deref(), Some("USD"));
    }

    #[test]
    fn half_cent_and_one_and_a_half_cent_values_round_half_up() {
        let rounded = |rate: &str| {
            let rule = PriceRule { id: "r".into(), provider: "x".into(), canonical_model_id: "m".into(), aliases: vec![], input_per_million: Some(rate.into()), output_per_million: None, cache_read_per_million: None, cache_write_per_million: None, currency: "USD".into(), effective_from: "2026-01-01".into(), effective_to: None, source_url: None, source: None, checked_at: None, notes: None, tiers: vec![] };
            estimate(&UsageRecord { input_tokens: Some(1_000_000), ..Default::default() }, Some(&rule)).amount_minor
        };
        assert_eq!(rounded("0.005"), Some(1));
        assert_eq!(rounded("0.015"), Some(2));
        assert_eq!(minor_units_to_major_decimal(3, "USD").as_deref(), Some("0.03"));
        assert_eq!(minor_units_to_major_decimal(3, "KWD").as_deref(), Some("0.003"));
    }

    #[test]
    fn long_context_without_input_usage_uses_the_higher_tier_and_marks_may_be_high() {
        let rule = PriceRule { id: "long".into(), provider: "openai".into(), canonical_model_id: "m".into(), aliases: vec![], input_per_million: Some("2".into()), output_per_million: Some("10".into()), cache_read_per_million: Some("0.10".into()), cache_write_per_million: Some("2.5".into()), currency: "USD".into(), effective_from: "0000-01-01".into(), effective_to: None, source_url: None, source: Some("official_price_list".into()), checked_at: None, notes: None, tiers: vec![PriceTier { kind: "long_context".into(), threshold_input_tokens: Some(272_000), input_per_million: Some("4".into()), output_per_million: Some("15".into()), cache_read_per_million: Some("0.20".into()), cache_write_per_million: Some("5".into()), ..Default::default() }] };
        let high = estimate(&UsageRecord { input_tokens: None, output_tokens: Some(1_000_000), ..Default::default() }, Some(&rule));
        assert_eq!(high.amount_minor, Some(1500));
        assert_eq!(high.status, "lower_bound_may_be_high");
        let low = estimate(&UsageRecord { input_tokens: Some(100_000), output_tokens: Some(1_000_000), cache_read_tokens: Some(0), cache_write_tokens: Some(0), ..Default::default() }, Some(&rule));
        assert_eq!(low.amount_minor, Some(1020));
        assert_eq!(low.status, "estimated");
    }

    #[test]
    fn time_tiers_use_the_usage_timestamp_in_utc() {
        let rule = PriceRule { id: "deepseek".into(), provider: "opencode-go".into(), canonical_model_id: "deepseek-v4.1-flash".into(), aliases: vec![], input_per_million: Some("0.15".into()), output_per_million: Some("0.60".into()), cache_read_per_million: Some("0.003".into()), cache_write_per_million: None, currency: "USD".into(), effective_from: "0000-01-01".into(), effective_to: None, source_url: None, source: Some("official_price_list".into()), checked_at: None, notes: None, tiers: vec![PriceTier { kind: "time_window".into(), days_of_week_utc: vec![1, 2, 3, 4, 5], windows_utc: vec![PriceWindow { start: "01:00".into(), end: "04:00".into() }, PriceWindow { start: "06:00".into(), end: "10:00".into() }], input_per_million: Some("0.30".into()), output_per_million: Some("1.20".into()), cache_read_per_million: Some("0.006".into()), ..Default::default() }] };
        let usage = UsageRecord { input_tokens: Some(1_000_000), output_tokens: Some(0), cache_read_tokens: Some(0), cache_write_tokens: Some(0), ..Default::default() };
        assert_eq!(estimate_at(&usage, Some(&rule), Some("2026-10-05T09:00:00Z")).amount_minor, Some(30));
        assert_eq!(estimate_at(&usage, Some(&rule), Some("2026-10-05T10:00:00Z")).amount_minor, Some(15));
    }

    #[test]
    fn unknown_cache_write_duration_uses_the_higher_published_tier() {
        let rule = PriceRule { id: "cache".into(), provider: "anthropic".into(), canonical_model_id: "claude-fable-5-1".into(), aliases: vec![], input_per_million: Some("10".into()), output_per_million: Some("50".into()), cache_read_per_million: Some("0.25".into()), cache_write_per_million: Some("12.5".into()), currency: "USD".into(), effective_from: "0000-01-01".into(), effective_to: None, source_url: None, source: Some("official_price_list".into()), checked_at: None, notes: None, tiers: vec![PriceTier { kind: "cache_write_duration".into(), duration_minutes: Some(60), cache_write_per_million: Some("20".into()), ..Default::default() }] };
        let usage = UsageRecord { input_tokens: Some(0), output_tokens: Some(0), cache_read_tokens: Some(0), cache_write_tokens: Some(1_000_000), ..Default::default() };
        let valuation = estimate(&usage, Some(&rule));
        assert_eq!(valuation.amount_minor, Some(2000));
        assert_eq!(valuation.status, "may_be_high");
    }
}
