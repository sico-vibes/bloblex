//! The non-blocking `ask_user` bridge tool and the expiry sweep for the cards
//! it leaves behind.
//!
//! The bridge's tool call times out after about a minute, so the tool cannot
//! wait for a human. It persists the question as a normal question card, returns
//! at once, and lets the turn finish. The answer travels back through the
//! durable queue as the agent's next prompt. FIX36 D2: this is available to
//! every provider's own conversation, not only OpenCode; Claude and Codex may
//! also use their native question paths.

use crate::{derr, team, AppState, DispatchError};
use axum::http::StatusCode;
use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

const DEFAULT_EXPIRY_SECS: i64 = 86_400;
const MIN_EXPIRY_SECS: i64 = 1_800;
const MAX_EXPIRY_SECS: i64 = 604_800;

/// The free-text answer the agent receives right after asking.
const SHOWN: &str = "Your question was shown to the user. End your turn now. Their answer will arrive as your next message.";
const DISMISSED: &str = "The user dismissed your question without answering.";
const EXPIRED_NOTICE: &str = "A question expired without an answer.";

/// How long a persisted question stays answerable, from `questions.expirySecs`
/// (1800 to 604800 seconds), defaulting to 24 hours.
pub fn expiry_secs(st: &AppState) -> i64 {
    st.db
        .settings()
        .ok()
        .and_then(|settings| settings["questions.expirySecs"].as_i64())
        .filter(|secs| (MIN_EXPIRY_SECS..=MAX_EXPIRY_SECS).contains(secs))
        .unwrap_or(DEFAULT_EXPIRY_SECS)
}

fn expiry_at(st: &AppState) -> String {
    (Utc::now() + Duration::seconds(expiry_secs(st))).to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The MCP tool description, offered in every bot's own conversation.
pub fn tool_schema() -> Value {
    json!({
        "name": "ask_user",
        "description": "Ask the user one to six structured questions. The questions appear as a card in the chat; they may take a while to answer, so call this and then end your turn. Do not wait or poll. The user's answer arrives later as your next message.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "A short card title, up to 120 characters."},
                "questions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 6,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "An id for this question, up to 64 characters (optional; one is chosen for you)."},
                            "header": {"type": "string", "description": "A short label for this question, up to 40 characters (optional)."},
                            "question": {"type": "string", "description": "The question itself, up to 400 characters."},
                            "options": {
                                "type": "array",
                                "maxItems": 10,
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": {"type": "string", "description": "The option text, up to 80 characters."},
                                        "description": {"type": "string", "description": "Optional context, up to 200 characters."}
                                    },
                                    "required": ["label"],
                                    "additionalProperties": false
                                }
                            },
                            "multiSelect": {"type": "boolean", "description": "Allow more than one option."},
                            "allowOther": {"type": "boolean", "description": "Allow a free-text answer. Defaults to true."}
                        },
                        "required": ["question"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["questions"],
            "additionalProperties": false
        }
    })
}

/// Persist and announce an `ask_user` call. Returns the text the agent sees.
pub async fn ask_user_tool(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    let session = st.db.session_detail(session_id).map_err(|_| "This conversation is no longer available.".to_owned())?;
    if session["archived"] == true { return Err("This conversation is archived.".into()); }
    match session["link"]["kind"].as_str() {
        Some("side") => return Err("ask_user is not available in side conversations.".into()),
        Some("automation") => return Err("ask_user is not available to scheduled runs.".into()),
        _ => {}
    }
    let (title, questions) = validate_args(args)?;
    let id = Uuid::new_v4().to_string();
    let expires_at = expiry_at(st);
    let provider_request_id = format!("mcp:{}", Uuid::new_v4());
    st.db
        .insert_question(&id, session_id, &provider_request_id, &title, &questions, Some(&expires_at))
        .map_err(|error| format!("The question could not be recorded: {error}"))?;
    st.emit(
        "permission.requested",
        json!({
            "id": id,
            "sessionId": session_id,
            "runtimeId": session["runtimeId"],
            "kind": "question",
            "category": "question",
            "title": title,
            "detail": null,
            "risk": "none",
            "choices": ["answer", "dismiss"],
            "questions": questions,
            "expiresAt": expires_at,
            "status": "pending"
        }),
    )
    .await;
    Ok(SHOWN.to_owned())
}

fn required_string(object: &Value, key: &str, limit: usize) -> Result<String, String> {
    match object.get(key) {
        Some(Value::String(text)) => {
            let text = text.trim();
            if text.is_empty() { return Err(format!("{key} cannot be empty.")); }
            if text.chars().count() > limit { return Err(format!("{key} must be at most {limit} characters.")); }
            Ok(text.to_owned())
        }
        Some(_) => Err(format!("{key} must be a string.")),
        None => Err(format!("{key} is required.")),
    }
}

fn optional_string(object: &Value, key: &str, limit: usize) -> Result<Option<String>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let text = text.trim();
            if text.is_empty() { return Ok(None); }
            if text.chars().count() > limit { return Err(format!("{key} must be at most {limit} characters.")); }
            Ok(Some(text.to_owned()))
        }
        Some(_) => Err(format!("{key} must be a string.")),
    }
}

fn bool_field(object: &Value, key: &str) -> Result<Option<bool>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("{key} must be a boolean.")),
    }
}

fn reject_unknown(object: &Value, allowed: &[&str], context: &str) -> Result<(), String> {
    let Some(map) = object.as_object() else { return Err(format!("{context} must be an object.")); };
    if let Some(key) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("{context} has an unsupported field: {key}."));
    }
    Ok(())
}

fn validate_args(args: &Value) -> Result<(String, Value), String> {
    reject_unknown(args, &["title", "questions"], "ask_user input")?;
    let title = optional_string(args, "title", 120)?.unwrap_or_else(|| "A question".to_owned());
    let list = args["questions"].as_array().filter(|list| (1..=6).contains(&list.len())).ok_or("questions must be an array of 1 to 6 items.")?;
    let mut questions = Vec::with_capacity(list.len());
    let mut seen_ids = std::collections::BTreeSet::new();
    for (index, item) in list.iter().enumerate() {
        reject_unknown(item, &["id", "header", "question", "options", "multiSelect", "allowOther"], "a question")?;
        let question = required_string(item, "question", 400)?;
        let header = optional_string(item, "header", 40)?.unwrap_or_default();
        let id = optional_string(item, "id", 64)?.unwrap_or_else(|| format!("q{}", index + 1));
        if !seen_ids.insert(id.clone()) { return Err(format!("question ids must be unique; \"{id}\" is repeated.")); }
        let options = match item.get("options") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(options)) if options.len() <= 10 => options.iter().map(|option| {
                reject_unknown(option, &["label", "description"], "an option")?;
                let label = required_string(option, "label", 80)?;
                let description = optional_string(option, "description", 200)?.unwrap_or_default();
                Ok::<Value, String>(json!({"label": label, "description": description}))
            }).collect::<Result<Vec<_>, String>>()?,
            Some(Value::Array(_)) => return Err("each question may have at most 10 options.".into()),
            Some(_) => return Err("options must be an array.".into()),
        };
        let multi_select = bool_field(item, "multiSelect")?.unwrap_or(false);
        let allow_other = bool_field(item, "allowOther")?.unwrap_or(true);
        if options.is_empty() && !allow_other { return Err("a question with no options must allow a free-text answer.".into()); }
        questions.push(json!({
            "id": id,
            "header": header,
            "question": question,
            "options": options,
            "multiSelect": multi_select,
            "allowOther": allow_other
        }));
    }
    Ok((title, Value::Array(questions)))
}

/// Mark every question whose expiry has passed as `expired` and tell the user.
/// Expired cards are never treated as answered; a later reply is a conflict.
pub async fn sweep(st: &AppState) {
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let expired = match st.db.expire_due_questions(&now) { Ok(expired) => expired, Err(_) => return };
    for row in expired {
        let id = row["id"].as_str().unwrap_or("");
        let session_id = row["sessionId"].as_str().unwrap_or("");
        st.emit("permission.resolved", json!({"permissionId": id, "choice": "expired", "status": "expired"})).await;
        if !session_id.is_empty() {
            team::note(st, session_id, EXPIRED_NOTICE, json!({"kind": "question_expired"})).await;
        }
    }
}

/// Answer or dismiss a question created by `ask_user`. The adapter is never
/// called: the outcome travels back to the agent as a normal queued prompt.
pub async fn reply_mcp_question(st: &AppState, id: &str, session_id: &str, choice: &str, p: &Value) -> Result<Value, DispatchError> {
    let data = st.db.permission_get(id).map_err(|_| derr("conflict", "That question is no longer available.", StatusCode::CONFLICT))?;
    let answered = choice == "answer";
    let text = if answered {
        let answers = p["answers"].as_object().map(|map| map.iter().map(|(key, value)| (key.clone(), match value {
            Value::Array(items) => items.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>(),
            Value::String(text) => vec![text.clone()],
            _ => Vec::new(),
        })).collect::<std::collections::BTreeMap<String, Vec<String>>>()).unwrap_or_default();
        answer_text(&data["questions"], &answers)
    } else {
        DISMISSED.to_owned()
    };
    st.db
        .resolve_question(id, if answered { "answered" } else { "dismissed" })
        .map_err(|error| match error {
            bloblex_storage::StorageError::AgentConflict => derr("conflict", "That question is no longer pending.", StatusCode::CONFLICT),
            other => derr("internal", &other.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
        })?;
    deliver_answer(st, session_id, text, id).await;
    st.emit("permission.resolved", json!({"permissionId": id, "choice": choice})).await;
    Ok(json!({"resolved": true}))
}

/// The follow-up prompt for an answered question: the header and the answers
/// only, bounded so a long answer cannot bloat the prompt.
fn answer_text(questions: &Value, answers: &std::collections::BTreeMap<String, Vec<String>>) -> String {
    let mut lines = vec!["The user answered your question.".to_owned()];
    let mut body = String::new();
    if let Some(list) = questions.as_array() {
        for question in list {
            let id = question["id"].as_str().unwrap_or("");
            let header = question["header"].as_str().unwrap_or("Question");
            let Some(values) = answers.get(id).filter(|values| !values.is_empty()) else { continue };
            let joined = values.iter().map(|value| value.trim()).filter(|value| !value.is_empty()).collect::<Vec<_>>().join(", ");
            if joined.is_empty() { continue; }
            let line = format!("{header}: {joined}");
            let projected = body.chars().count() + if body.is_empty() { 0 } else { 1 } + line.chars().count();
            if projected > 2000 { break; }
            if !body.is_empty() { body.push('\n'); }
            body.push_str(&line);
        }
    }
    if body.is_empty() { return "The user answered your question, but no answer text was provided.".to_owned(); }
    lines.push(String::new());
    lines.push(body);
    lines.join("\n")
}

/// Deliver the answer as the session's next prompt. Sent at once when idle;
/// otherwise queued at the front as a plain item.
async fn deliver_answer(st: &AppState, session_id: &str, text: String, question_id: &str) {
    let meta = json!({"kind": "question_answer", "questionId": question_id});
    if !team::session_busy(st, session_id).await
        && crate::session_prompt_for_question_answer(st, json!({"sessionId":session_id,"text":text.clone(),"meta":meta.clone()})).await.is_ok()
    {
        return;
    }
    let params = json!({"text": text, "attachments": [], "meta": meta});
    if st.db.queue_add_front(session_id, &params).is_ok() {
        crate::queue::emit_changed(st, session_id).await;
    }
}
