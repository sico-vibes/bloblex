use bloblex_agent_core::ModelInfo;
use std::{cmp::Ordering, collections::HashMap};

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

pub(crate) fn apply(models: &mut Vec<ModelInfo>, validated: bool, fallback: bool) {
    deduplicate_concrete_models(models);
    models.retain(|model| {
        let id = model.id.trim().to_ascii_lowercase();
        let label = model.display_name.trim().to_ascii_lowercase();
        !matches!(id.as_str(), "default" | "recommended" | "provider-default")
            && !label.starts_with("default (recommended)")
            && !label.eq("provider default")
    });
    for model in models.iter_mut() {
        if model.release_date.is_none() { model.release_date = official_claude_release(&model.id).map(str::to_owned); }
    }
    if models.iter().any(|model| matches!(model.provider_id.as_deref(), Some("opencode" | "opencode-go")) || model.id.starts_with("opencode/") || model.id.starts_with("opencode-go/")) {
        let newest_by_provider = models.iter().fold(HashMap::<String, ModelRecency>::new(), |mut newest, model| {
            let provider = model.provider_id.clone().or_else(|| model.id.split_once('/').map(|(provider, _)| provider.to_owned())).unwrap_or_else(|| "opencode".into());
            let recency = model_recency(model);
            let entry = newest.entry(provider).or_default();
            if compare_recency(&recency, entry).is_lt() { *entry = recency; }
            newest
        });
        for model in models.iter_mut() {
            let provider = model.provider_id.as_deref().or_else(|| model.id.split_once('/').map(|(provider, _)| provider)).unwrap_or("opencode");
            model.group = Some(match provider {
                "opencode" => "OpenCode Zen".into(),
                "opencode-go" => "OpenCode Go".into(),
                _ => title_case(provider.replace('-', " ").as_str()),
            });
            model.availability = (validated && !fallback).then(|| "offered".into());
            if model.is_default.is_none() { model.is_default = Some(false); }
        }
        models.sort_by(|a, b| {
            let a_provider = a.provider_id.as_deref().or_else(|| a.id.split_once('/').map(|(provider, _)| provider)).unwrap_or("opencode");
            let b_provider = b.provider_id.as_deref().or_else(|| b.id.split_once('/').map(|(provider, _)| provider)).unwrap_or("opencode");
            compare_recency(newest_by_provider.get(a_provider).unwrap_or(&ModelRecency::default()), newest_by_provider.get(b_provider).unwrap_or(&ModelRecency::default()))
                .then_with(|| compare_model_recency(a, b))
        });
        return;
    }
    let families = models.iter().map(|model| family(&model.id)).collect::<Vec<_>>();
    let mut family_counts = HashMap::new();
    for family in families.iter().flatten() {
        *family_counts.entry(family.key.clone()).or_insert(0usize) += 1;
    }
    let has_group = family_counts.values().any(|count| *count > 1);
    let is_claude_catalog = models.iter().any(|model| family(&model.id).is_some_and(|family| family.key.starts_with("claude-")));
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
        let is_gpt_family = model_family.as_ref().is_some_and(|family| family.key.starts_with("gpt-"));
        model.group = if is_claude_catalog {
            None
        } else if is_gpt_family || family_is_grouped {
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

    // Claude stays in one flat chronology: family headings must not pull an
    // old Haiku row ahead of newer Sonnet or Opus releases.
    if is_claude_catalog {
        models.sort_by(|a, b| {
            let a_claude = family(&a.id).is_some_and(|family| family.key.starts_with("claude-"));
            let b_claude = family(&b.id).is_some_and(|family| family.key.starts_with("claude-"));
            if a_claude != b_claude { return b_claude.cmp(&a_claude); }
            compare_model_recency(a, b).then_with(|| a.id.cmp(&b.id))
        });
        return;
    }

    // GPT versions use numeric generation. Catalog defaults remain metadata
    // and never reorder model versions or create menu aliases.
    models.sort_by(|a, b| {
        let a_family = family(&a.id);
        let b_family = family(&b.id);
        let a_gpt = a_family.as_ref().is_some_and(|family| family.key.starts_with("gpt-"));
        let b_gpt = b_family.as_ref().is_some_and(|family| family.key.starts_with("gpt-"));
        if a_gpt && b_gpt {
            return compare_families(&a_family.as_ref().unwrap().key, &b_family.as_ref().unwrap().key)
                .then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
        }
        if a_gpt != b_gpt { return b_gpt.cmp(&a_gpt); }
        compare_model_recency(a, b)
    });
}

pub(crate) fn preferred_initial_model<'a>(provider: &str, models: &'a [ModelInfo]) -> Option<&'a ModelInfo> {
    match provider {
        "claude" => models.iter().filter(|model| model.id.rsplit('/').next().unwrap_or(&model.id).to_ascii_lowercase().starts_with("claude-sonnet-")).min_by(|a, b| compare_model_recency(a, b)),
        "codex" => models.iter().filter(|model| {
            let id = model.id.rsplit('/').next().unwrap_or(&model.id).to_ascii_lowercase();
            id.starts_with("gpt-") && id.ends_with("-luna")
        }).min_by(|a, b| compare_model_recency(a, b)),
        "opencode" => models.iter().find(|model| model.id == "opencode/big-pickle"),
        _ => None,
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct ModelRecency { release_date: Option<String>, generation: Vec<u64> }

fn model_recency(model: &ModelInfo) -> ModelRecency {
    let generation = numeric_parts(&model.id);
    ModelRecency { release_date: model.release_date.clone(), generation: if generation.is_empty() { numeric_parts(&model.display_name) } else { generation } }
}

fn numeric_parts(value: &str) -> Vec<u64> {
    let mut parts = Vec::new();
    let mut digits = String::new();
    for ch in value.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit() { digits.push(ch); }
        else if !digits.is_empty() {
            if let Ok(value) = digits.parse() { parts.push(value); }
            digits.clear();
        }
    }
    parts
}

fn compare_recency(left: &ModelRecency, right: &ModelRecency) -> Ordering {
    match (&left.release_date, &right.release_date) {
        (Some(left), Some(right)) => right.cmp(left),
        _ => right.generation.cmp(&left.generation).then_with(|| match (&left.release_date, &right.release_date) {
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            _ => Ordering::Equal,
        }),
    }
}

fn compare_model_recency(left: &ModelInfo, right: &ModelInfo) -> Ordering {
    compare_recency(&model_recency(left), &model_recency(right))
}

fn deduplicate_concrete_models(models: &mut Vec<ModelInfo>) {
    let mut unique = Vec::<ModelInfo>::new();
    for candidate in models.drain(..) {
        if let Some(index) = unique.iter().position(|model| model.id == candidate.id) {
            let previous_default = unique[index].is_default == Some(true);
            let candidate_default = candidate.is_default == Some(true);
            let previous_score = concrete_model_score(&unique[index]);
            let candidate_score = concrete_model_score(&candidate);
            if candidate_score > previous_score {
                let mut selected = candidate;
                merge_model_metadata(&mut selected, &unique[index]);
                unique[index] = selected;
            } else { merge_model_metadata(&mut unique[index], &candidate); }
            if previous_default || candidate_default { unique[index].is_default = Some(true); }
        } else {
            unique.push(candidate);
        }
    }
    *models = unique;
}

fn concrete_model_score(model: &ModelInfo) -> (bool, usize, usize, bool) {
    let name = model.display_name.to_ascii_lowercase();
    (!name.contains("default") && !name.contains("recommended"), model.supported_thinking.len(), model.service_tiers.len(), model.context_window.is_some())
}

fn merge_model_metadata(target: &mut ModelInfo, source: &ModelInfo) {
    for effort in &source.supported_thinking { if !target.supported_thinking.contains(effort) { target.supported_thinking.push(effort.clone()); } }
    for tier in &source.service_tiers { if !target.service_tiers.iter().any(|known| known.id == tier.id) { target.service_tiers.push(tier.clone()); } }
    if target.default_thinking.is_none() { target.default_thinking = source.default_thinking.clone(); }
    if target.default_service_tier.is_none() { target.default_service_tier = source.default_service_tier.clone(); }
    if target.context_window.is_none() { target.context_window = source.context_window; }
    if target.release_date.is_none() { target.release_date = source.release_date.clone(); }
    if target.provider_id.is_none() { target.provider_id = source.provider_id.clone(); }
}

fn official_claude_release(id: &str) -> Option<&'static str> {
    match id {
        "claude-haiku-5-5" => Some("2026-10-07"), "claude-sonnet-5-5" => Some("2026-09-28"),
        "claude-opus-5-5" => Some("2026-09-22"), "claude-fable-5-1" => Some("2026-09-01"),
        "claude-opus-5" => Some("2026-07-24"), "claude-sonnet-5" => Some("2026-06-30"),
        "claude-fable-5" => Some("2026-06-09"), "claude-opus-4-8" => Some("2026-05-28"),
        "claude-opus-4-7" => Some("2026-04-16"), "claude-sonnet-4-6" => Some("2026-02-17"),
        "claude-opus-4-6" => Some("2026-02-05"), "claude-haiku-4-5" => Some("2025-10-15"),
        _ => None,
    }
}

fn compare_families(left: &str, right: &str) -> Ordering {
    fn gpt_version(key: &str) -> Option<Vec<u32>> {
        let parts = key.strip_prefix("gpt-")?.split('.').map(str::parse::<u32>).collect::<Result<Vec<_>, _>>().ok()?;
        (!parts.is_empty()).then_some(parts)
    }
    match (gpt_version(left), gpt_version(right)) {
        (Some(left), Some(right)) => right.cmp(&left),
        _ => left.cmp(right),
    }
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
            is_default, group: None, availability: None, release_date: None, context_window: None,
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
        assert_eq!(models[2].group.as_deref(), Some("GPT-5.5"));
    }

    #[test]
    fn gpt_version_groups_sort_numerically_newest_first_and_keep_default_marker() {
        let mut models = vec![
            model("gpt-5.6-sol", "GPT-5.6 Sol", Some(false)),
            model("gpt-6-sol", "GPT-6 Sol", Some(true)),
            model("gpt-6.1-sol", "GPT-6.1 Sol", Some(false)),
            model("gpt-5.6-terra", "GPT-5.6 Terra", Some(false)),
            model("gpt-6-astra", "GPT-6 Astra", Some(false)),
            model("gpt-6.1-astra", "GPT-6.1 Astra", Some(false)),
        ];
        apply(&mut models, true, false);
        assert_eq!(models.iter().map(|model| model.group.as_deref().unwrap_or_default()).collect::<Vec<_>>(), ["GPT-6.1", "GPT-6.1", "GPT-6", "GPT-6", "GPT-5.6", "GPT-5.6"]);
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["gpt-6.1-astra", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra"]);
        assert_eq!(models[3].is_default, Some(true));
    }

    #[test]
    fn reduced_gpt_singletons_sort_by_version_even_when_an_older_model_is_default() {
        let mut models = vec![
            model("gpt-5.6-sol", "GPT-5.6 Sol", Some(true)),
            model("gpt-6-sol", "GPT-6 Sol", Some(false)),
            model("gpt-6.1-sol", "GPT-6.1 Sol", Some(false)),
        ];
        apply(&mut models, true, false);
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"]);
        assert_eq!(models.iter().map(|model| model.group.as_deref()).collect::<Vec<_>>(), [Some("GPT-6.1"), Some("GPT-6"), Some("GPT-5.6")]);
        assert_eq!(models[2].is_default, Some(true));
    }

    #[test]
    fn newer_gpt_singleton_precedes_older_grouped_families_and_keeps_its_heading() {
        let mut models = vec![
            model("gpt-5.6-luna", "GPT-5.6 Luna", Some(true)),
            model("gpt-6-sol", "GPT-6 Sol", Some(false)),
            model("gpt-5.6-sol", "GPT-5.6 Sol", Some(false)),
            model("gpt-6.1-sol", "GPT-6.1 Sol", Some(false)),
            model("gpt-6-luna", "GPT-6 Luna", Some(true)),
        ];
        apply(&mut models, true, false);
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-sol", "gpt-5.6-luna", "gpt-5.6-sol"]);
        assert_eq!(models.iter().map(|model| model.group.as_deref().unwrap_or_default()).collect::<Vec<_>>(), ["GPT-6.1", "GPT-6", "GPT-6", "GPT-5.6", "GPT-5.6"]);
        assert_eq!(models[1].is_default, Some(true));
        assert_eq!(models[3].is_default, Some(true));
    }

    #[test]
    fn claude_menu_is_flat_and_release_chronological_across_families() {
        let mut models = vec![
            model("claude-opus-4-6", "Opus 4.6", Some(false)),
            model("claude-sonnet-5-5", "Sonnet 5.5", Some(true)),
            model("claude-opus-5-5", "Opus 5.5", Some(false)),
            model("claude-sonnet-4-6", "Sonnet 4.6", Some(false)),
        ];
        apply(&mut models, true, false);
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-4-6", "claude-opus-4-6"]);
        assert!(models.iter().all(|model| model.group.is_none()));
        assert_eq!(models[0].is_default, Some(true));
    }

    #[test]
    fn claude_catalog_rows_are_flat_instead_of_family_blocked() {
        let mut models = vec![
            model("claude-opus-5-5", "Opus", None),
            model("claude-sonnet-5-5", "Sonnet", Some(true)),
            model("sonnet", "sonnet", None),
            model("opus", "opus", None),
            model("haiku", "haiku", None),
            model("fable", "fable", None),
        ];
        apply(&mut models, false, true);
        assert!(models.iter().all(|model| model.group.is_none()));
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
        let mut other = model("custom/model", "Model", None);
        other.provider_id = Some("custom-provider".into());
        let mut models = vec![other, go, zen];
        apply(&mut models, true, false);
        assert_eq!(models.iter().map(|model| model.group.as_deref().unwrap()).collect::<Vec<_>>(), ["OpenCode Go", "Custom provider", "OpenCode Zen"]);
    }

    #[test]
    fn opencode_orders_structured_release_dates_then_numeric_generation_without_dates() {
        let mut old = model("opencode/zen-old", "Zeta", Some(true));
        old.provider_id = Some("opencode".into());
        old.release_date = Some("2025-10-17".into());
        let mut new = model("opencode/zen-new", "Alpha", Some(false));
        new.provider_id = Some("opencode".into());
        new.release_date = Some("2026-10-06".into());
        let mut models = vec![old, new];
        apply(&mut models, true, false);
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["opencode/zen-new", "opencode/zen-old"]);

        let mut models = vec![
            model("opencode/zen-3", "Model 3", None),
            model("opencode/zen-12", "Model 12", None),
        ];
        models.iter_mut().for_each(|model| model.provider_id = Some("opencode".into()));
        apply(&mut models, true, false);
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["opencode/zen-12", "opencode/zen-3"]);
    }

    #[test]
    fn opencode_places_newer_provider_group_first_while_preserving_gateway_names() {
        let mut zen = model("opencode/big-pickle", "Big Pickle", None);
        zen.provider_id = Some("opencode".into());
        zen.release_date = Some("2025-10-17".into());
        let mut go = model("opencode-go/exo-free", "Exo Free", None);
        go.provider_id = Some("opencode-go".into());
        go.release_date = Some("2026-10-06".into());
        let mut models = vec![zen, go];
        apply(&mut models, true, false);
        assert_eq!(models.iter().map(|model| model.group.as_deref().unwrap()).collect::<Vec<_>>(), ["OpenCode Go", "OpenCode Zen"]);
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["opencode-go/exo-free", "opencode/big-pickle"]);
    }

    #[test]
    fn product_initial_models_ignore_catalog_recommendation_markers() {
        let models = vec![
            model("claude-opus-5-5", "Opus 5.5", Some(true)),
            model("claude-sonnet-5-5", "Sonnet 5.5", Some(false)),
            model("claude-sonnet-6", "New Sonnet", Some(false)),
        ];
        assert_eq!(preferred_initial_model("claude", &models).unwrap().id, "claude-sonnet-6");
        let codex = vec![
            model("gpt-6-sol", "GPT-6 Sol", Some(true)),
            model("gpt-6-luna", "GPT-6 Luna", Some(false)),
            model("gpt-6.2-luna", "Future Luna", Some(false)),
        ];
        assert_eq!(preferred_initial_model("codex", &codex).unwrap().id, "gpt-6.2-luna");
        let open = vec![
            model("opencode/another", "Another", Some(true)),
            model("opencode/big-pickle", "Big Pickle", Some(false)),
        ];
        assert_eq!(preferred_initial_model("opencode", &open).unwrap().id, "opencode/big-pickle");
        assert!(preferred_initial_model("opencode", &open[..1]).is_none(), "do not invent a substitute when Big Pickle is absent");
    }

    #[test]
    fn duplicate_canonical_model_keeps_concrete_label_and_merges_real_capabilities_in_either_order() {
        let alias = || {
            let mut row = model("claude-opus-5-5", "Default (recommended)", Some(true));
            row.supported_thinking = vec!["low".into(), "high".into()];
            row
        };
        let concrete = || {
            let mut row = model("claude-opus-5-5", "Opus 5.5", Some(false));
            row.supported_thinking = vec!["low".into(), "medium".into(), "high".into(), "xhigh".into(), "max".into()];
            row.context_window = Some(1_000_000);
            row
        };
        for mut rows in [vec![alias(), concrete()], vec![concrete(), alias()]] {
            apply(&mut rows, true, false);
            let row = rows.iter().find(|row| row.id == "claude-opus-5-5").unwrap();
            assert_eq!(row.display_name, "Opus 5.5");
            assert_eq!(row.supported_thinking, ["low", "medium", "high", "xhigh", "max"]);
            assert_eq!(row.context_window, Some(1_000_000));
            assert_eq!(rows.iter().filter(|row| row.id == "claude-opus-5-5").count(), 1);
        }
    }

    #[test]
    fn claude_chronology_uses_official_release_dates_across_families() {
        let ids = ["claude-haiku-4-5", "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-fable-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
        let mut models = ids.iter().map(|id| model(id, id, Some(false))).collect::<Vec<_>>();
        apply(&mut models, true, false);
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"]);
        assert_eq!(models[0].release_date.as_deref(), Some("2026-10-07"));
        let mut future = vec![model("claude-sonnet-5-5", "Sonnet 5.5", Some(false)), model("claude-sonnet-6", "New Sonnet", Some(false))];
        apply(&mut future, true, false);
        assert_eq!(future[0].id, "claude-sonnet-6");
    }
}
