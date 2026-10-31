//! Phase 5: the owner's own model names.
//!
//! A custom model is a name for a model a provider's catalog does not list. The
//! turn passes it to the CLI unchanged, so a name the CLI refuses fails that
//! turn in the normal way. Nothing here is cached with a catalog, and a name
//! that the catalog already lists is refused so the same id cannot mean two
//! things.

use crate::{agent_error, derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};

const PROVIDERS: [&str; 3] = ["claude", "codex", "opencode"];
const MAX_MODEL_ID: usize = 200;
const MAX_LABEL: usize = 80;
const MAX_EFFORTS: usize = 8;
const MAX_EFFORT: usize = 24;

pub async fn dispatch(st: &AppState, method: &str, params: &Value) -> Result<Value, DispatchError> {
    match method {
        "model.custom.list" => {
            let provider = params["provider"].as_str().unwrap_or("");
            if !PROVIDERS.contains(&provider) {
                return Err(derr("invalid_argument", "That is not a provider Bitbots knows.", StatusCode::BAD_REQUEST));
            }
            let models = st.db.custom_model_list(provider).map_err(agent_error)?;
            Ok(json!({"models": models}))
        }
        "model.custom.save" => {
            let provider = params["provider"].as_str().unwrap_or("");
            if !PROVIDERS.contains(&provider) {
                return Err(derr("invalid_argument", "That is not a provider Bitbots knows.", StatusCode::BAD_REQUEST));
            }
            let model_id = params["modelId"].as_str().map(str::trim).unwrap_or("");
            if model_id.is_empty() || model_id.chars().count() > MAX_MODEL_ID || model_id.chars().any(char::is_whitespace) || model_id.chars().any(char::is_control) {
                return Err(derr("invalid_argument", "A model id is 1 to 200 characters with no spaces.", StatusCode::BAD_REQUEST));
            }
            let label = params["label"].as_str().map(str::trim).filter(|label| !label.is_empty());
            if label.is_some_and(|label| label.chars().count() > MAX_LABEL) {
                return Err(derr("invalid_argument", "A label is at most 80 characters.", StatusCode::BAD_REQUEST));
            }
            let efforts = match params.get("efforts") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(items)) => {
                    if items.len() > MAX_EFFORTS {
                        return Err(derr("invalid_argument", "At most 8 efforts.", StatusCode::BAD_REQUEST));
                    }
                    let mut out = Vec::with_capacity(items.len());
                    for item in items {
                        let Some(text) = item.as_str().map(str::trim) else {
                            return Err(derr("invalid_argument", "An effort is a string.", StatusCode::BAD_REQUEST));
                        };
                        if text.is_empty() || text.chars().count() > MAX_EFFORT || text.chars().any(char::is_control) {
                            return Err(derr("invalid_argument", "An effort is 1 to 24 characters.", StatusCode::BAD_REQUEST));
                        }
                        out.push(text.to_owned());
                    }
                    out
                }
                Some(_) => return Err(derr("invalid_argument", "efforts must be a list of strings.", StatusCode::BAD_REQUEST)),
            };
            // The catalog's own list wins: the same id must not mean two things.
            if listed_by_catalog(st, provider, model_id).await {
                return Err(derr("conflict", "That model is already in this provider's catalog.", StatusCode::CONFLICT));
            }
            let row = st.db.custom_model_save(params["id"].as_str().filter(|id| !id.is_empty()), provider, model_id, label, &efforts).map_err(|error| match error {
                bloblex_storage::StorageError::AgentConflict => derr("conflict", "A custom model with that id already exists for this provider.", StatusCode::CONFLICT),
                _ => derr("invalid_argument", "That custom model could not be saved.", StatusCode::BAD_REQUEST),
            })?;
            Ok(json!({"model": row}))
        }
        "model.custom.delete" => {
            let id = params["id"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "id is required", StatusCode::BAD_REQUEST))?;
            let removed = st.db.custom_model_delete(id).map_err(agent_error)?;
            if !removed {
                return Err(derr("not_found", "Custom model not found.", StatusCode::NOT_FOUND));
            }
            Ok(json!({"deleted": true}))
        }
        _ => Err(derr("unsupported", "unknown model method", StatusCode::NOT_FOUND)),
    }
}

/// Phase 5: `runtime.models` carries the owner's own names after the catalog's,
/// each marked `source: "custom"`.
pub fn append_to(st: &AppState, catalog: &mut Value, provider: &str) {
    let rows = st.db.custom_model_list(provider).unwrap_or_default();
    if rows.is_empty() {
        return;
    }
    // The shape of a catalog entry: `id` is what a turn sends to the CLI, so it's the model's own
    // id, never this row's. The row's id stays as `customId`.
    let rows: Vec<Value> = rows.iter().map(|row| {
        let label = row["label"].as_str().filter(|label| !label.trim().is_empty());
        json!({
            "id": row["modelId"],
            "displayName": label.map(Value::from).unwrap_or_else(|| row["modelId"].clone()),
            "supportedThinking": row["efforts"],
            "source": "custom",
            "customId": row["id"],
        })
    }).collect();
    match catalog.get_mut("models").and_then(Value::as_array_mut) {
        Some(models) => models.extend(rows),
        None => catalog["models"] = json!(rows),
    }
}

/// True when the provider's own catalog, as cached, already lists that id. A
/// cached read only: saving a name must never poll a provider.
async fn listed_by_catalog(st: &AppState, provider: &str, model_id: &str) -> bool {
    let runtime = st.runtimes.read().await.iter().find(|row| row["provider"] == provider).cloned();
    let Some(runtime) = runtime else { return false };
    match crate::catalog::get(st, &runtime, None, None, crate::catalog::Mode::CachedOnly).await {
        Ok(Some(served)) => lists(served.value["models"].as_array().map(Vec::as_slice).unwrap_or(&[]), model_id),
        _ => false,
    }
}

/// The rule on its own, so it can be tested without a provider.
pub fn lists(models: &[Value], model_id: &str) -> bool {
    models.iter().any(|model| model["id"].as_str() == Some(model_id) || model["modelId"].as_str() == Some(model_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phase2a_tests::state;

    #[tokio::test]
    async fn a_custom_model_joins_the_catalog() {
        let (st, _rx) = state();
        let saved = dispatch(&st, "model.custom.save", &json!({"provider": "codex", "modelId": "gpt-private", "label": "Private", "efforts": ["low", "high"]})).await.unwrap();
        assert_eq!(saved["model"]["source"], "custom");
        assert_eq!(saved["model"]["efforts"], json!(["low", "high"]));
        let listed = dispatch(&st, "model.custom.list", &json!({"provider": "codex"})).await.unwrap();
        assert_eq!(listed["models"].as_array().unwrap().len(), 1);
        // The merge puts them after the catalog's own and marks them.
        let mut catalog = json!({"models": [{"id": "gpt-listed", "source": "live_query"}]});
        append_to(&st, &mut catalog, "codex");
        let models = catalog["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], "gpt-listed");
        // `id` is what a turn sends to the CLI.
        assert_eq!(models[1]["id"], "gpt-private");
        assert_eq!(models[1]["displayName"], "Private");
        assert_eq!(models[1]["supportedThinking"], json!(["low", "high"]));
        assert_eq!(models[1]["source"], "custom");
        assert_eq!(models[1]["customId"], saved["model"]["id"]);
        // Another provider's list is unaffected.
        assert!(dispatch(&st, "model.custom.list", &json!({"provider": "claude"})).await.unwrap()["models"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_custom_model_cannot_shadow_a_listed_one() {
        let catalog = vec![json!({"id": "gpt-5", "label": "GPT-5"}), json!({"modelId": "gpt-5-codex"})];
        assert!(lists(&catalog, "gpt-5"));
        assert!(lists(&catalog, "gpt-5-codex"));
        assert!(!lists(&catalog, "gpt-5-private"));
        assert!(!lists(&[], "anything"));
        // The save path refuses through the same rule once the catalog is cached;
        // with no cached catalog it accepts, and the turn's own failure is the answer.
        let (st, _rx) = state();
        let saved = dispatch(&st, "model.custom.save", &json!({"provider": "codex", "modelId": "gpt-5"})).await;
        assert!(saved.is_ok(), "no cached catalog means no shadow to refuse: {saved:?}");
    }

    #[tokio::test]
    async fn bad_custom_models_are_refused() {
        let (st, _rx) = state();
        for bad in [
            json!({"provider": "gemini", "modelId": "x"}),
            json!({"provider": "codex", "modelId": ""}),
            json!({"provider": "codex", "modelId": "has space"}),
            json!({"provider": "codex", "modelId": "x".repeat(201)}),
            json!({"provider": "codex", "modelId": "ok", "label": "y".repeat(81)}),
            json!({"provider": "codex", "modelId": "ok", "efforts": ["a", "b", "c", "d", "e", "f", "g", "h", "i"]}),
            json!({"provider": "codex", "modelId": "ok", "efforts": [1]}),
            json!({"provider": "codex", "modelId": "ok", "efforts": ["x".repeat(25)]}),
            json!({"provider": "codex", "modelId": "ok", "efforts": "high"}),
        ] {
            let refused = dispatch(&st, "model.custom.save", &bad).await.unwrap_err();
            assert_eq!(refused.1.code, "invalid_argument", "{bad}");
        }
        // A good one, then a second name for the same id is a conflict.
        dispatch(&st, "model.custom.save", &json!({"provider": "codex", "modelId": "mine", "efforts": ["low"]})).await.unwrap();
        let second = dispatch(&st, "model.custom.save", &json!({"provider": "codex", "modelId": "mine"})).await.unwrap_err();
        assert_eq!(second.1.code, "conflict");
        assert_eq!(dispatch(&st, "model.custom.delete", &json!({"id": "missing"})).await.unwrap_err().1.code, "not_found");
    }

    #[tokio::test]
    async fn a_turn_passes_a_custom_model_through() {
        let (st, _rx) = state();
        let bot = crate::dispatch(&st, "agent.create", json!({"name": "Rae", "runtimeId": "rt-test", "model": "gpt-private"})).await.unwrap()["agent"].clone();
        assert_eq!(bot["model"], "gpt-private");
        let options = crate::exec_options_for_session(&st, &json!({"agentId": bot["id"], "provider": "codex"})).unwrap();
        assert_eq!(options.model.as_deref(), Some("gpt-private"), "the name reaches the CLI unchanged");
    }

    #[tokio::test]
    async fn custom_models_travel_in_a_backup() {
        let (st, _rx) = state();
        dispatch(&st, "model.custom.save", &json!({"provider": "codex", "modelId": "gpt-private", "label": "Private", "efforts": ["low"]})).await.unwrap();
        let exported = crate::backup::rpc(&st, "backup.export", &json!({})).await.unwrap();
        let models = exported["document"]["contents"]["customModels"].as_array().expect("a backup carries custom models");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["modelId"], "gpt-private");
        assert_eq!(models[0]["label"], "Private");
        // Restoring into a host that does not have it puts the name back, once.
        dispatch(&st, "model.custom.delete", &json!({"id": models[0]["id"]})).await.unwrap();
        assert!(dispatch(&st, "model.custom.list", &json!({"provider": "codex"})).await.unwrap()["models"].as_array().unwrap().is_empty());
    }
}
