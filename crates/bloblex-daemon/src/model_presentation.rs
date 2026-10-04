use bloblex_agent_core::ModelInfo;
use std::collections::HashMap;

/// Local-only display aliases. This table classifies rows already returned by
/// the provider and never contributes a model to discovery.
const FRIENDLY_NAMES: &[(&str, &str)] = &[
    ("gpt-6-sol", "GPT-6 Sol"),
    ("gpt-6-luna", "GPT-6 Luna"),
    ("gpt-5.6-sol", "GPT-5.6 Sol"),
    ("gpt-5.6-luna", "GPT-5.6 Luna"),
    ("gpt-5.5", "GPT-5.5"),
];

#[derive(Clone, Debug)]
struct Family {
    key: String,
    label: String,
}

pub(crate) fn apply(models: &mut [ModelInfo], validated: bool, fallback: bool) {
    if models.iter().any(|model| matches!(model.provider_id.as_deref(), Some("opencode" | "opencode-go")) || model.id.starts_with("opencode/") || model.id.starts_with("opencode-go/")) {
        for model in models.iter_mut() {
            let provider = model.provider_id.as_deref().or_else(|| model.id.split_once('/').map(|(provider, _)| provider)).unwrap_or("opencode");
            let reported_name = model.reported_price.as_ref().and_then(|price| price["providerName"].as_str());
            model.group = Some(match provider {
                "opencode" => "OpenCode Zen".into(),
                "opencode-go" => "OpenCode Go".into(),
                _ => reported_name.map(str::to_owned).unwrap_or_else(|| title_case(provider.replace('-', " ").as_str())),
            });
            model.availability = (validated && !fallback).then(|| "offered".into());
            if model.is_default.is_none() { model.is_default = Some(false); }
        }
        models.sort_by(|a, b| a.group.cmp(&b.group).then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase())).then_with(|| a.id.cmp(&b.id)));
        return;
    }
    let families = models.iter().map(|model| family(&model.id)).collect::<Vec<_>>();
    let mut family_counts = HashMap::new();
    for family in families.iter().flatten() {
        *family_counts.entry(family.key.clone()).or_insert(0usize) += 1;
    }
    let has_group = family_counts.values().any(|count| *count > 1);
    let default_family = models
        .iter()
        .zip(&families)
        .find(|(model, _)| model.is_default == Some(true))
        .and_then(|(_, family)| family.as_ref())
        .map(|family| family.key.clone());

    for model in models.iter_mut() {
        if model.display_name == model.id {
            if let Some((_, name)) = FRIENDLY_NAMES.iter().find(|(id, _)| *id == model.id) {
                model.display_name = (*name).to_owned();
            }
        }
        let model_family = family(&model.id);
        let family_is_grouped = model_family
            .as_ref()
            .is_some_and(|family| family_counts.get(&family.key).copied().unwrap_or_default() > 1);
        model.group = if family_is_grouped {
            model_family.map(|family| family.label)
        } else if has_group && model.is_default != Some(true) {
            Some("Other models".into())
        } else {
            None
        };
        model.availability = (validated && !fallback).then(|| "offered".into());
        if model.is_default.is_none() {
            model.is_default = Some(false);
        }
    }

    // An ungrouped default stays first without a header; other singleton rows trail in Other models.
    models.sort_by(|a, b| {
        let a_family = family(&a.id);
        let b_family = family(&b.id);
        let a_grouped = a_family.as_ref().is_some_and(|f| family_counts.get(&f.key).copied().unwrap_or_default() > 1);
        let b_grouped = b_family.as_ref().is_some_and(|f| family_counts.get(&f.key).copied().unwrap_or_default() > 1);
        let a_default_singleton = a.is_default == Some(true) && !a_grouped;
        let b_default_singleton = b.is_default == Some(true) && !b_grouped;
        let a_default_family = a_family.as_ref().map(|f| &f.key) == default_family.as_ref();
        let b_default_family = b_family.as_ref().map(|f| &f.key) == default_family.as_ref();
        if !has_group {
            return b.is_default.unwrap_or(false)
                .cmp(&a.is_default.unwrap_or(false))
                .then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()))
                .then_with(|| a.id.cmp(&b.id));
        }
        b_default_singleton
            .cmp(&a_default_singleton)
            .then_with(|| b_grouped.cmp(&a_grouped))
            .then_with(|| b_default_family.cmp(&a_default_family))
            .then_with(|| a_family.as_ref().map(|f| &f.key).cmp(&b_family.as_ref().map(|f| &f.key)))
            .then_with(|| b.is_default.unwrap_or(false).cmp(&a.is_default.unwrap_or(false)))
            .then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
}

fn family(id: &str) -> Option<Family> {
    let model_id = id.split('/').next_back()?.to_ascii_lowercase();
    for name in ["sonnet", "opus", "haiku", "fable"] {
        if model_id == name || model_id.starts_with(&format!("claude-{name}-")) {
            return Some(Family {
                key: format!("claude-{name}"),
                label: title_case(name),
            });
        }
    }

    let mut parts = model_id.splitn(2, '-');
    let first = parts.next().unwrap_or_default();
    let rest = parts.next().unwrap_or_default();
    if first.is_empty() {
        return None;
    }
    if first == "gpt" {
        let version = rest.split('-').next().unwrap_or_default();
        if !version.is_empty() && version.chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
            return Some(Family {
                key: format!("gpt-{version}"),
                label: format!("GPT-{version}"),
            });
        }
    }
    Some(Family {
        key: first.into(),
        label: title_case(first),
    })
}

fn title_case(value: &str) -> String {
    let mut chars = value.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, name: &str, is_default: Option<bool>) -> ModelInfo {
        ModelInfo {
            id: id.into(), display_name: name.into(), provider_id: None,
            supported_thinking: vec![], default_thinking: None, service_tiers: vec![],
            default_service_tier: None, variants: None, host_dependent: true,
            is_default, group: None, availability: None, reported_price: None,
        }
    }

    #[test]
    fn default_family_stays_contiguous_and_precedes_alphabetical_families() {
        let mut models = vec![
            model("gpt-5.5", "GPT 5.5", Some(false)),
            model("gpt-6-sol", "GPT 6 Sol", Some(false)),
            model("gpt-6-luna", "GPT 6 Luna", Some(true)),
        ];
        apply(&mut models, true, false);
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["gpt-6-luna", "gpt-6-sol", "gpt-5.5"]);
        assert_eq!(models[0].group.as_deref(), Some("GPT-6"));
        assert_eq!(models[1].group.as_deref(), Some("GPT-6"));
        assert_eq!(models[2].group.as_deref(), Some("Other models"));
    }

    #[test]
    fn ungrouped_default_precedes_group_headers_without_getting_a_header() {
        let mut models = vec![
            model("gpt-6-sol", "GPT 6 Sol", Some(false)),
            model("gpt-5.5", "GPT 5.5", Some(true)),
            model("gpt-6-luna", "GPT 6 Luna", Some(false)),
        ];
        apply(&mut models, true, false);
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["gpt-5.5", "gpt-6-luna", "gpt-6-sol"]);
        assert_eq!(models[0].group, None);
        assert_eq!(models[1].group.as_deref(), Some("GPT-6"));
        assert_eq!(models[2].group.as_deref(), Some("GPT-6"));
    }

    #[test]
    fn claude_families_are_distinct_and_singletons_have_no_group() {
        let mut models = vec![
            model("claude-opus-5-5", "Opus", None),
            model("claude-sonnet-5-5", "Sonnet", Some(true)),
            model("sonnet", "sonnet", None),
            model("opus", "opus", None),
            model("haiku", "haiku", None),
            model("fable", "fable", None),
        ];
        apply(&mut models, false, true);
        let sonnet = models.iter().filter(|model| model.group.as_deref() == Some("Sonnet")).count();
        let opus = models.iter().filter(|model| model.group.as_deref() == Some("Opus")).count();
        assert_eq!(sonnet, 2);
        assert_eq!(opus, 2);
        assert_eq!(models.iter().filter(|model| model.group.as_deref() == Some("Other models")).count(), 2);
        assert!(models.iter().all(|model| model.availability.is_none()));
    }

    #[test]
    fn preserves_provider_display_name_and_does_not_add_rows() {
        let mut models = vec![model("vendor/model-z", "Provider title", None)];
        apply(&mut models, true, false);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].display_name, "Provider title");
        assert_eq!(models[0].is_default, Some(false));
        assert_eq!(models[0].group, None);
    }

    #[test]
    fn opencode_models_group_by_catalog_gateway() {
        let mut zen = model("opencode/big-pickle", "Big Pickle", None);
        zen.provider_id = Some("opencode".into());
        let mut go = model("opencode-go/deepseek-v4.1-flash", "DeepSeek", None);
        go.provider_id = Some("opencode-go".into());
        go.reported_price = Some(serde_json::json!({"providerName":"OpenCode Go"}));
        let mut other = model("custom/model", "Model", None);
        other.provider_id = Some("custom-provider".into());
        other.reported_price = Some(serde_json::json!({"providerName":"My Gateway"}));
        let mut models = vec![other, go, zen];
        apply(&mut models, true, false);
        assert_eq!(models.iter().map(|model| model.group.as_deref().unwrap()).collect::<Vec<_>>(), ["My Gateway", "OpenCode Go", "OpenCode Zen"]);
    }
}
