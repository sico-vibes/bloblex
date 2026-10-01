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
pub fn resolve_rule<'a>(
    provider: &str,
    model: Option<&str>,
    rules: &'a [PriceRule],
) -> Option<&'a PriceRule> {
    let model = model?;
    rules.iter().find(|r| {
        r.provider.eq_ignore_ascii_case(provider)
            && (r.canonical_model_id.eq_ignore_ascii_case(model)
                || r.aliases.iter().any(|a| a.eq_ignore_ascii_case(model)))
    })
}
pub fn resolve_rule_at<'a>(
    provider: &str,
    model: Option<&str>,
    valuation_date: &str,
    rules: &'a [PriceRule],
) -> Option<&'a PriceRule> {
    let model = model?;
    let date = valuation_date.get(..10)?;
    rules.iter().find(|r| {
        r.provider.eq_ignore_ascii_case(provider)
            && (r.canonical_model_id.eq_ignore_ascii_case(model)
                || r.aliases.iter().any(|a| a.eq_ignore_ascii_case(model)))
            && r.effective_from.get(..10).is_some_and(|from| from <= date)
            && r.effective_to
                .as_deref()
                .is_none_or(|to| to.get(..10).is_some_and(|to| date < to))
    })
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
    if record.input_tokens.is_none()
        || record.output_tokens.is_none()
        || (record.cache_read_tokens.is_none() && rule.cache_read_per_million.is_some())
        || (record.cache_write_tokens.is_none() && rule.cache_write_per_million.is_some())
    {
        return Valuation {
            basis: CostBasis::Unknown,
            amount_minor: None,
            currency: None,
            pricing_rule_id: Some(rule.id.clone()),
            status: "incomplete_usage".into(),
        };
    }
    let cache_read_rate = if record.cache_read_tokens.unwrap_or(0) > 0 {
        rule.cache_read_per_million
    } else {
        Some(0)
    };
    let cache_write_rate = if record.cache_write_tokens.unwrap_or(0) > 0 {
        rule.cache_write_per_million
    } else {
        Some(0)
    };
    let (Some(input), Some(output), Some(cache_read), Some(cache_write)) = (
        rule.input_per_million,
        rule.output_per_million,
        cache_read_rate,
        cache_write_rate,
    ) else {
        return Valuation {
            basis: CostBasis::Unknown,
            amount_minor: None,
            currency: None,
            pricing_rule_id: Some(rule.id.clone()),
            status: "incomplete_pricing".into(),
        };
    };
    let total = (record.input_tokens.unwrap_or(0) as i128 * input as i128
        + record.output_tokens.unwrap_or(0) as i128 * output as i128
        + record.cache_read_tokens.unwrap_or(0) as i128 * cache_read as i128
        + record.cache_write_tokens.unwrap_or(0) as i128 * cache_write as i128)
        / 1_000_000;
    Valuation {
        basis: CostBasis::ApiRateEstimate,
        amount_minor: i64::try_from(total).ok(),
        currency: Some(rule.currency.clone()),
        pricing_rule_id: Some(rule.id.clone()),
        status: "estimated".into(),
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
        assert_eq!(estimate(&u, Some(&r)).amount_minor, None);
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
