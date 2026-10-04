use bloblex_agent_core::{
    AdapterError, EvidenceKind, ExecOptions, ModelInfo, SettingOutcome, UsageReport,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use tokio::process::Command;

pub(crate) const AGENT_NAME: &str = "bloblex";
pub(crate) const SCHEMA: &str = "https://opencode.ai/config.json";
pub(crate) const ENV_ALLOWLIST: [&str; 5] = ["LANG", "LC_ALL", "TZ", "NO_COLOR", "TERM"];
const SECRET_MARKERS: [&str; 7] = ["TOKEN", "SECRET", "PASSWORD", "KEY", "AUTH", "CREDENTIAL", "COOKIE"];

pub(crate) const ERR_SERVICE_TIER: &str = "service tier is not supported for OpenCode";
pub(crate) const ERR_ENV: &str = "custom environment contains an unsupported key";
pub(crate) const ERR_ARGS: &str = "custom arguments are not supported for OpenCode";
pub(crate) const ERR_MODEL_MISSING: &str = "requested model is not offered";
pub(crate) const ERR_MODE_MISSING: &str = "requested mode is not offered";
pub(crate) const ERR_EFFORT_MISSING: &str = "requested effort is not offered";
pub(crate) const ERR_MODEL_REJECTED: &str = "OpenCode rejected the model setting";
pub(crate) const ERR_MODE_REJECTED: &str = "OpenCode rejected the mode setting";
pub(crate) const ERR_EFFORT_REJECTED: &str = "OpenCode rejected the effort setting";
pub(crate) const ERR_INSTRUCTIONS_FIXED: &str = "instructions are fixed for the running OpenCode process";
pub(crate) const ERR_CATALOG: &str = "OpenCode model catalog is unavailable";
pub(crate) const ERR_CATALOG_TIMEOUT: &str = "OpenCode model catalog timed out";

#[derive(Clone, Copy)]
pub(crate) struct PreflightReject {
    pub key: &'static str,
    pub reason: &'static str,
    pub include_requested_text: bool,
}

pub(crate) fn nonempty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|text| !text.is_empty())
}

pub(crate) fn normalize_instructions(value: &Option<String>) -> Option<String> {
    nonempty(value).map(str::to_owned)
}

pub(crate) fn preflight(options: &ExecOptions) -> Option<PreflightReject> {
    if nonempty(&options.service_tier).is_some() {
        return Some(PreflightReject {
            key: "serviceTier",
            reason: ERR_SERVICE_TIER,
            include_requested_text: true,
        });
    }
    if !options.extra_args.is_empty() {
        return Some(PreflightReject {
            key: "extraArgs",
            reason: ERR_ARGS,
            include_requested_text: false,
        });
    }
    if let Some(reason) = env_rejection(options) {
        return Some(PreflightReject {
            key: "env",
            reason,
            include_requested_text: false,
        });
    }
    None
}

pub(crate) fn preflight_error(reject: PreflightReject) -> AdapterError {
    if reject.reason == ERR_SERVICE_TIER || reject.reason == ERR_ENV || reject.reason == ERR_ARGS {
        AdapterError::Unsupported(reject.reason.into())
    } else {
        AdapterError::Protocol(reject.reason.into())
    }
}

fn env_rejection(options: &ExecOptions) -> Option<&'static str> {
    for (key, value) in &options.env {
        if value.contains('\0') || !env_key_allowed(key) {
            return Some(ERR_ENV);
        }
    }
    None
}

fn env_key_allowed(key: &str) -> bool {
    if !ENV_ALLOWLIST.contains(&key) {
        return false;
    }
    let upper = key.to_ascii_uppercase();
    !SECRET_MARKERS.iter().any(|marker| upper.contains(marker))
}

/// Bloblex-owned config document. The caller removes any inherited
/// `OPENCODE_CONFIG_CONTENT` before placing this value in the child environment.
pub(crate) fn config_content(options: &ExecOptions) -> String {
    let model = nonempty(&options.model);
    let instructions = normalize_instructions(&options.instructions);
    let mut body = serde_json::Map::new();
    body.insert("$schema".into(), json!(SCHEMA));
    if let Some(model) = model {
        body.insert("model".into(), json!(model));
    }
    if let Some(prompt) = instructions {
        let mut agent = serde_json::Map::new();
        agent.insert("mode".into(), json!("primary"));
        if let Some(model) = model {
            agent.insert("model".into(), json!(model));
        }
        agent.insert("prompt".into(), json!(prompt));
        let mut agents = serde_json::Map::new();
        agents.insert(AGENT_NAME.into(), Value::Object(agent));
        body.insert("agent".into(), Value::Object(agents));
    }
    Value::Object(body).to_string()
}

pub(crate) fn apply_child_env(cmd: &mut Command, options: &ExecOptions) {
    cmd.env_remove("OPENCODE_CONFIG_CONTENT");
    cmd.env("OPENCODE_CONFIG_CONTENT", config_content(options));
    for key in ENV_ALLOWLIST {
        if let Some(value) = options.env.get(key) {
            cmd.env(key, value);
        }
    }
}

#[cfg(test)]
pub(crate) fn scrub_stderr(line: &str, secret: Option<&str>) -> String {
    if let Some(secret) = secret {
        if !secret.is_empty() && line.contains(secret) {
            return "[redacted provider diagnostic]".into();
        }
    }
    safe_stderr(line)
}

#[cfg(test)]
pub(crate) fn safe_stderr(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if ["password", "secret", "credential", "authorization", "bearer", "api_key", "token="]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return "[redacted provider diagnostic]".into();
    }
    line.split_whitespace()
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            if lower.contains("sk-ant-") || lower.contains("sk-") || lower.contains("ghp_") {
                "[redacted]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(512)
        .collect()
}

pub(crate) fn rejected_outcome(requested: Value, reason: &str) -> SettingOutcome {
    SettingOutcome {
        requested: Some(requested),
        applied: Some(false),
        evidence_kind: EvidenceKind::None,
        evidence_value: None,
        reason: Some(reason.to_owned()),
    }
}

pub(crate) fn single_outcome(reject: PreflightReject, options: &ExecOptions) -> BTreeMap<String, SettingOutcome> {
    let requested = if reject.include_requested_text {
        match reject.key {
            "serviceTier" => json!(nonempty(&options.service_tier)),
            _ => json!(true),
        }
    } else {
        json!(true)
    };
    let mut outcomes = BTreeMap::new();
    outcomes.insert(reject.key.into(), rejected_outcome(requested, reject.reason));
    outcomes
}

pub(crate) fn options_from_result(result: &Value) -> Vec<Value> {
    result
        .get("configOptions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn config_option<'a>(options: &'a [Value], id: &str) -> Option<&'a Value> {
    options.iter().find(|option| option["id"].as_str() == Some(id))
}

pub(crate) fn option_values(option: &Value) -> BTreeSet<String> {
    option["options"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value["value"].as_str().or_else(|| value["id"].as_str()))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn config_option_catalog(options: &[Value]) -> Option<Vec<ModelInfo>> {
    let model_option = config_option(options, "model")?;
    let models = model_option["options"].as_array()?;
    let modes = config_option(options, "mode").map(option_values).unwrap_or_default();
    let selected_model = current_value(model_option);
    let mut catalog = Vec::new();
    for model in models {
        let id = model["value"].as_str().or_else(|| model["id"].as_str())?;
        catalog.push(ModelInfo {
            id: id.to_owned(),
            display_name: model["name"].as_str().unwrap_or(id).to_owned(),
            provider_id: None,
            supported_thinking: Vec::new(),
            default_thinking: None,
            service_tiers: Vec::new(),
            default_service_tier: None,
            variants: (!modes.is_empty()).then(|| modes.iter().cloned().collect()),
            host_dependent: true,
            is_default: Some(selected_model.as_deref() == Some(id)),
            group: None,
            availability: None,
        });
    }
    (!catalog.is_empty()).then_some(catalog)
}

pub(crate) fn default_provider_mode(options: &[Value]) -> Option<String> {
    let mode = config_option(options, "mode")?;
    if let Some(current) = current_value(mode).filter(|value| value != AGENT_NAME) {
        return Some(current);
    }
    let values = option_values(mode);
    if values.contains("build") {
        return Some("build".into());
    }
    None
}

pub(crate) fn apply_model_efforts(models: &mut [ModelInfo], verbose_models: &[ModelInfo]) {
    for model in models {
        if let Some(verbose) = verbose_models.iter().find(|candidate| candidate.id == model.id) {
            model.supported_thinking = verbose.supported_thinking.clone();
            model.default_thinking = verbose.default_thinking.clone();
        }
    }
}

pub(crate) fn current_value(option: &Value) -> Option<String> {
    match option.get("currentValue") {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        _ => None,
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Echoes {
    pub model: Option<String>,
    pub mode: Option<String>,
    pub effort: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct UsageSnap {
    pub context_used: Option<u64>,
    pub context_size: Option<u64>,
    pub cost_decimal: Option<String>,
    pub cost_currency: Option<String>,
}

pub(crate) fn record_usage_update(snap: &mut UsageSnap, update: &Value, raw_line: &str) {
    if let Some(used) = update.get("used").and_then(Value::as_u64) {
        snap.context_used = Some(used);
    }
    if let Some(size) = update.get("size").and_then(Value::as_u64) {
        snap.context_size = Some(size);
    }
    if let Some(cost) = update.get("cost") {
        if let Some(amount) = extract_json_number_after(raw_line, "amount") {
            snap.cost_decimal = Some(amount);
        }
        if let Some(currency) = cost.get("currency").and_then(Value::as_str) {
            snap.cost_currency = Some(currency.to_owned());
        }
    }
}

/// Lexical JSON number after a key. `serde_json` stores non-integers as f64,
/// which is not an exact decimal; the ACP line still has the provider's spelling.
pub(crate) fn extract_json_number_after(raw: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let mut rest = raw;
    while let Some(index) = rest.find(&needle) {
        let after = rest[index + needle.len()..].trim_start();
        if let Some(after) = after.strip_prefix(':') {
            let after = after.trim_start();
            let mut end = 0;
            for (offset, ch) in after.char_indices() {
                if ch.is_ascii_digit() || matches!(ch, '-' | '+' | '.' | 'e' | 'E') {
                    end = offset + ch.len_utf8();
                } else {
                    break;
                }
            }
            if end > 0 {
                return Some(after[..end].to_owned());
            }
        }
        rest = &rest[index + needle.len()..];
    }
    None
}

pub(crate) fn turn_outcomes(
    options: &ExecOptions,
    echoes: &Echoes,
    stop_reason: Option<&str>,
) -> BTreeMap<String, SettingOutcome> {
    let success = stop_reason == Some("end_turn");
    let mut outcomes = BTreeMap::new();
    if let Some(model) = nonempty(&options.model) {
        let matched = echoes.model.as_deref() == Some(model);
        outcomes.insert(
            "model".into(),
            SettingOutcome {
                requested: Some(json!(model)),
                applied: if success && matched { Some(true) } else { None },
                evidence_kind: if matched { EvidenceKind::ProviderEcho } else { EvidenceKind::None },
                evidence_value: echoes.model.clone().map(|value| json!(value)),
                reason: if success && matched {
                    None
                } else {
                    Some("model echo is not application proof without a successful turn".into())
                },
            },
        );
    }
    if let Some(thinking) = nonempty(&options.thinking) {
        let matched = echoes.effort.as_deref() == Some(thinking);
        outcomes.insert(
            "thinking".into(),
            SettingOutcome {
                requested: Some(json!(thinking)),
                // OpenCode effort has no behavioural proof. The echo is recorded
                // and applied stays unset even after end_turn.
                applied: None,
                evidence_kind: if matched { EvidenceKind::ProviderEcho } else { EvidenceKind::None },
                evidence_value: echoes.effort.clone().map(|value| json!(value)),
                reason: Some("effort echo is not behavioral proof".into()),
            },
        );
    }
    if normalize_instructions(&options.instructions).is_some() {
        let matched = echoes.mode.as_deref() == Some(AGENT_NAME);
        outcomes.insert(
            "mode".into(),
            SettingOutcome {
                requested: Some(json!(AGENT_NAME)),
                applied: if success && matched { Some(true) } else { None },
                evidence_kind: if matched { EvidenceKind::ProviderEcho } else { EvidenceKind::None },
                evidence_value: echoes.mode.clone().filter(|_| matched).map(|value| json!(value)),
                reason: if success && matched {
                    None
                } else {
                    Some("mode echo is not application proof without a successful turn".into())
                },
            },
        );
        outcomes.insert(
            "instructions".into(),
            SettingOutcome {
                requested: Some(json!(true)),
                applied: if success && matched { Some(true) } else { None },
                evidence_kind: if success && matched {
                    EvidenceKind::SuccessfulTurn
                } else {
                    EvidenceKind::None
                },
                evidence_value: if success && matched { Some(json!("end_turn")) } else { None },
                reason: if success && matched {
                    None
                } else {
                    Some("instruction proof requires end_turn".into())
                },
            },
        );
    }
    outcomes
}

pub(crate) fn usage_report(
    turn_failed: bool,
    result: &Value,
    snap: &UsageSnap,
    seq: u64,
) -> UsageReport {
    let update_id = Some(seq.to_string());
    if turn_failed {
        return UsageReport {
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            reasoning_tokens: None,
            usage_status: "unreported".into(),
            evidence_note: None,
            provider_update_id: update_id,
            context_used: None,
            context_size: None,
            model: None,
            cost_minor: None,
            cost_currency: None,
            reported_cost_decimal: None,
            cost_is_cumulative: false,
        };
    }
    let usage = result.get("usage").filter(|value| value.is_object());
    let has_update = snap.context_used.is_some() || snap.context_size.is_some() || snap.cost_decimal.is_some();
    if let Some(usage) = usage {
        UsageReport {
            input_tokens: usage["inputTokens"].as_u64(),
            output_tokens: usage["outputTokens"].as_u64(),
            cache_read_tokens: usage["cachedReadTokens"].as_u64(),
            cache_write_tokens: None,
            reasoning_tokens: usage["thoughtTokens"].as_u64(),
            usage_status: "reported".into(),
            evidence_note: None,
            provider_update_id: update_id,
            context_used: snap.context_used,
            context_size: snap.context_size,
            model: None,
            cost_minor: None,
            cost_currency: snap.cost_currency.clone(),
            reported_cost_decimal: snap.cost_decimal.clone(),
            cost_is_cumulative: snap.cost_decimal.is_some(),
        }
    } else if has_update {
        UsageReport {
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            reasoning_tokens: None,
            usage_status: "partial".into(),
            evidence_note: None,
            provider_update_id: update_id,
            context_used: snap.context_used,
            context_size: snap.context_size,
            model: None,
            cost_minor: None,
            cost_currency: snap.cost_currency.clone(),
            reported_cost_decimal: snap.cost_decimal.clone(),
            cost_is_cumulative: snap.cost_decimal.is_some(),
        }
    } else {
        UsageReport {
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            reasoning_tokens: None,
            usage_status: "unreported".into(),
            evidence_note: None,
            provider_update_id: update_id,
            context_used: None,
            context_size: None,
            model: None,
            cost_minor: None,
            cost_currency: None,
            reported_cost_decimal: None,
            cost_is_cumulative: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_omits_model_and_agent_when_unset_and_keeps_prompt_out_of_the_schema_key() {
        let bare = config_content(&ExecOptions::default());
        let value: Value = serde_json::from_str(&bare).unwrap();
        assert_eq!(value["$schema"], SCHEMA);
        assert!(value.get("model").is_none());
        assert!(value.get("agent").is_none());

        let mut options = ExecOptions::default();
        options.model = Some("opencode/ling".into());
        options.instructions = Some("  ".into());
        let model_only: Value = serde_json::from_str(&config_content(&options)).unwrap();
        assert_eq!(model_only["model"], "opencode/ling");
        assert!(model_only.get("agent").is_none());

        options.instructions = Some("SENTINEL_PROMPT".into());
        let full: Value = serde_json::from_str(&config_content(&options)).unwrap();
        assert_eq!(full["agent"][AGENT_NAME]["mode"], "primary");
        assert_eq!(full["agent"][AGENT_NAME]["model"], "opencode/ling");
        assert_eq!(full["agent"][AGENT_NAME]["prompt"], "SENTINEL_PROMPT");
        assert!(full["$schema"].as_str().unwrap().contains("opencode.ai"));
    }

    #[test]
    fn session_effort_option_is_not_assigned_to_every_model() {
        let options = options_from_result(&json!({"configOptions":[
            {"id":"model","currentValue":"opencode-go/deepseek-v4.1-flash","options":[
                {"value":"opencode/big-pickle","name":"Big Pickle"},
                {"value":"opencode-go/deepseek-v4.1-flash","name":"DeepSeek"}
            ]},
            {"id":"effort","currentValue":"low","options":[{"value":"low"},{"value":"high"}]}
        ]}));
        let mut models = config_option_catalog(&options).unwrap();
        assert!(models.iter().all(|model| model.supported_thinking.is_empty()));

        let verbose_models = vec![ModelInfo {
            id: "opencode-go/deepseek-v4.1-flash".into(),
            display_name: "DeepSeek".into(),
            provider_id: Some("opencode-go".into()),
            supported_thinking: vec!["low".into(), "high".into()],
            default_thinking: None,
            service_tiers: Vec::new(),
            default_service_tier: None,
            variants: Some(vec!["low".into(), "high".into()]),
            host_dependent: true,
            is_default: None,
            group: None,
            availability: None,
        }];
        apply_model_efforts(&mut models, &verbose_models);
        assert!(models.iter().find(|model| model.id == "opencode/big-pickle").unwrap().supported_thinking.is_empty());
        assert_eq!(
            models.iter().find(|model| model.id == "opencode-go/deepseek-v4.1-flash").unwrap().supported_thinking,
            ["low", "high"],
        );
    }

    #[test]
    fn default_provider_mode_preserves_current_mode_or_uses_build_after_custom_mode() {
        let modes = vec![json!({
            "id": "mode",
            "currentValue": "plan",
            "options": [{"value":"build"},{"value":"plan"},{"value":"bloblex"}]
        })];
        assert_eq!(default_provider_mode(&modes).as_deref(), Some("plan"));

        let loaded_custom_mode = vec![json!({
            "id": "mode",
            "currentValue": "bloblex",
            "options": [{"value":"build"},{"value":"plan"},{"value":"bloblex"}]
        })];
        assert_eq!(default_provider_mode(&loaded_custom_mode).as_deref(), Some("build"));
    }

    #[test]
    fn approval_modes_never_become_acp_args_or_config_fields(){
        for mode in [bloblex_agent_core::ApprovalMode::Ask,bloblex_agent_core::ApprovalMode::Auto,bloblex_agent_core::ApprovalMode::Bypass]{let options=ExecOptions{approval_mode:mode,..ExecOptions::default()};let config=config_content(&options);assert!(!config.contains("approval"));assert!(!config.contains("bypass"));assert!(options.extra_args.is_empty());}
    }

    #[test]
    fn disallowed_env_and_service_tier_and_args_fail_closed() {
        let mut options = ExecOptions::default();
        options.env.insert("OPENCODE_CONFIG_CONTENT".into(), "nope".into());
        assert_eq!(preflight(&options).unwrap().reason, ERR_ENV);
        options.env.clear();
        options.env.insert("LANG".into(), "en_US.UTF-8".into());
        assert!(preflight(&options).is_none());
        options.env.insert("LANG".into(), "bad\0value".into());
        assert_eq!(preflight(&options).unwrap().reason, ERR_ENV);
        options = ExecOptions::default();
        options.service_tier = Some("priority".into());
        assert_eq!(preflight(&options).unwrap().reason, ERR_SERVICE_TIER);
        options = ExecOptions::default();
        options.extra_args.push("--pure".into());
        assert_eq!(preflight(&options).unwrap().reason, ERR_ARGS);
        let outcome = single_outcome(preflight(&options).unwrap(), &options);
        assert_eq!(outcome["extraArgs"].applied, Some(false));
        assert!(!outcome["extraArgs"].requested.as_ref().unwrap().to_string().contains("--pure"));
    }

    #[test]
    fn stderr_scrub_removes_instruction_text() {
        let line = scrub_stderr("listening SENTINEL_PROMPT now", Some("SENTINEL_PROMPT"));
        assert_eq!(line, "[redacted provider diagnostic]");
        assert!(!line.contains("SENTINEL_PROMPT"));
    }

    #[test]
    fn decimal_amount_keeps_the_providers_spelling() {
        let raw = r#"{"cost":{"amount":0.0015894,"currency":"USD"}}"#;
        assert_eq!(extract_json_number_after(raw, "amount").as_deref(), Some("0.0015894"));
        let later = r#"{"cost":{"amount":0.001637988,"currency":"USD"}}"#;
        assert_eq!(extract_json_number_after(later, "amount").as_deref(), Some("0.001637988"));
    }

    #[test]
    fn effort_stays_an_echo_and_failed_zeros_are_not_usage() {
        let mut options = ExecOptions::default();
        options.model = Some("opencode/ling".into());
        options.thinking = Some("low".into());
        options.instructions = Some("be brief".into());
        let echoes = Echoes {
            model: Some("opencode/ling".into()),
            mode: Some(AGENT_NAME.into()),
            effort: Some("low".into()),
        };
        let outcomes = turn_outcomes(&options, &echoes, Some("end_turn"));
        assert_eq!(outcomes["model"].applied, Some(true));
        assert!(matches!(outcomes["model"].evidence_kind, EvidenceKind::ProviderEcho));
        assert_eq!(outcomes["thinking"].applied, None);
        assert!(matches!(outcomes["thinking"].evidence_kind, EvidenceKind::ProviderEcho));
        assert_eq!(outcomes["instructions"].applied, Some(true));
        assert!(matches!(outcomes["instructions"].evidence_kind, EvidenceKind::SuccessfulTurn));
        assert_eq!(outcomes["instructions"].requested, Some(json!(true)));
        let cancelled = turn_outcomes(&options, &echoes, Some("cancelled"));
        assert_eq!(cancelled["model"].applied, None);
        assert_eq!(cancelled["instructions"].applied, None);

        let snap = UsageSnap {
            context_used: Some(0),
            context_size: Some(200000),
            cost_decimal: Some("0".into()),
            cost_currency: Some("USD".into()),
        };
        let failed = usage_report(true, &json!({"usage":{"inputTokens":0,"outputTokens":0,"cachedReadTokens":0}}), &snap, 3);
        assert_eq!(failed.usage_status, "unreported");
        assert_eq!(failed.input_tokens, None);
        assert_eq!(failed.reported_cost_decimal, None);
        assert!(!failed.cost_is_cumulative);
        assert_eq!(failed.provider_update_id.as_deref(), Some("3"));

        let result = json!({"usage":{"inputTokens":30,"outputTokens":12,"totalTokens":80,"thoughtTokens":2,"cachedReadTokens":90}});
        let snap = UsageSnap {
            context_used: Some(4030),
            context_size: Some(200000),
            cost_decimal: Some("0.001637988".into()),
            cost_currency: Some("USD".into()),
        };
        let report = usage_report(false, &result, &snap, 2);
        assert_eq!(report.input_tokens, Some(30));
        assert_eq!(report.cache_read_tokens, Some(90));
        assert_eq!(report.cache_write_tokens, None);
        assert_eq!(report.reported_cost_decimal.as_deref(), Some("0.001637988"));
        assert!(report.cost_is_cumulative);
        assert_eq!(report.usage_status, "reported");
    }
}
