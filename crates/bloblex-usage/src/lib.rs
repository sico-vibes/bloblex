use serde::{Deserialize, Serialize};

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
    pub aliases: Vec<String>,
    pub input_per_million: Option<i64>,
    pub output_per_million: Option<i64>,
    pub cache_read_per_million: Option<i64>,
    pub cache_write_per_million: Option<i64>,
    pub currency: String,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub source_url: Option<String>,
}
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
    let model = canonical_model_key(provider, model?);
    rules.iter().find(|r| {
        r.provider.eq_ignore_ascii_case(provider)
            && (canonical_model_key(provider, &r.canonical_model_id) == model
                || r.aliases.iter().any(|alias| canonical_model_key(provider, alias) == model))
    })
}
pub fn resolve_rule_at<'a>(
    provider: &str,
    model: Option<&str>,
    valuation_date: &str,
    rules: &'a [PriceRule],
) -> Option<&'a PriceRule> {
    let model = canonical_model_key(provider, model?);
    let date = valuation_date.get(..10)?;
    rules.iter().find(|r| {
        r.provider.eq_ignore_ascii_case(provider)
            && (canonical_model_key(provider, &r.canonical_model_id) == model
                || r.aliases.iter().any(|alias| canonical_model_key(provider, alias) == model))
            && r.effective_from.get(..10).is_some_and(|from| from <= date)
            && r.effective_to
                .as_deref()
                .is_none_or(|to| to.get(..10).is_some_and(|to| date < to))
    })
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
    let Some(rule) = rule else {
        return Valuation {
            basis: CostBasis::Unknown,
            amount_minor: None,
            currency: None,
            pricing_rule_id: None,
            status: "unavailable".into(),
        };
    };
    let buckets = [
        (record.input_tokens, rule.input_per_million),
        (record.output_tokens, rule.output_per_million),
        (record.cache_read_tokens, rule.cache_read_per_million),
        (record.cache_write_tokens, rule.cache_write_per_million),
    ];
    let mut total = 0i128;
    let mut missing = false;
    for (tokens, rate) in buckets {
        match (tokens, rate) {
            (Some(0), _) => {}
            (Some(tokens), Some(rate)) => total += i128::from(tokens) * i128::from(rate),
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
    let amount_minor = i64::try_from(total / 1_000_000).ok();
    Valuation {
        basis: CostBasis::ApiRateEstimate,
        amount_minor,
        currency: Some(rule.currency.clone()),
        pricing_rule_id: Some(rule.id.clone()),
        status: if missing || amount_minor.is_none() { "lower_bound".into() } else { "estimated".into() },
    }
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
            input_per_million: Some(10),
            output_per_million: Some(20),
            cache_read_per_million: None,
            cache_write_per_million: None,
            currency: "USD".into(),
            effective_from: "2026-01-01".into(),
            effective_to: None,
            source_url: None,
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
            input_per_million: Some(10),
            output_per_million: Some(20),
            cache_read_per_million: None,
            cache_write_per_million: None,
            currency: "USD".into(),
            effective_from: "2026-01-01".into(),
            effective_to: None,
            source_url: None,
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
            input_per_million: Some(10),
            output_per_million: Some(20),
            cache_read_per_million: None,
            cache_write_per_million: None,
            currency: "USD".into(),
            effective_from: "2026-01-01".into(),
            effective_to: None,
            source_url: None,
        };
        let u = UsageRecord {
            input_tokens: Some(1),
            output_tokens: Some(1),
            cache_read_tokens: Some(50),
            ..Default::default()
        };
        let value = estimate(&u, Some(&r));
        assert_eq!(value.amount_minor, Some(0));
        assert_eq!(value.status, "lower_bound");
    }
    #[test]
    fn pricing_effective_window_is_end_exclusive() {
        let r = PriceRule {
            id: "p".into(),
            provider: "x".into(),
            canonical_model_id: "m".into(),
            aliases: vec![],
            input_per_million: Some(10),
            output_per_million: Some(20),
            cache_read_per_million: None,
            cache_write_per_million: None,
            currency: "USD".into(),
            effective_from: "2026-09-01".into(),
            effective_to: Some("2026-10-01".into()),
            source_url: None,
        };
        assert!(resolve_rule_at("x", Some("m"), "2026-09-30T23:59:59Z", &[r.clone()]).is_some());
        assert!(resolve_rule_at("x", Some("m"), "2026-10-01T00:00:00Z", &[r]).is_none());
    }
}
