//! Phase 1B: fan-out and compare.
//!
//! One prompt goes to several bots, each in its own new conversation, so the answers can be
//! read side by side. The record keeps the prompt and which conversation belongs to which bot;
//! everything else (state, reply, duration, tokens, copy) is read live from the conversations
//! on every read. Conversations are ordinary main conversations started the normal way, so
//! approvals, queues and limits behave as usual. A bot that cannot start does not stop the rest.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::path::PathBuf;

const MIN_BOTS: usize = 2;
const MAX_BOTS: usize = 6;
const MAX_TEXT_CHARS: usize = 100_000;
const MAX_TITLE_CHARS: usize = 120;
const DEFAULT_TITLE_CHARS: usize = 60;
const LIST_REPLY_CHARS: usize = 300;
/// When the prompt cannot start at once (the daemon is at its concurrency limit), it is queued
/// this many seconds ahead and goes when a slot opens.
const START_LATER_SECS: i64 = 6;

fn invalid(message: &str) -> DispatchError {
    derr("invalid_argument", message, StatusCode::BAD_REQUEST)
}

fn storage_error(error: bloblex_storage::StorageError) -> DispatchError {
    use bloblex_storage::StorageError::*;
    match error {
        AgentNotFound => derr("not_found", "That comparison no longer exists.", StatusCode::NOT_FOUND),
        InvalidAgent => invalid("The comparison request is invalid."),
        other => derr("internal", &other.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
    }
}

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "fanout.start" => start(st, p, None).await.map(|(fanout, _)| json!({"fanout": fanout})),
        "fanout.get" => {
            let record = st.db.fanout_get(required_id(p, "id")?).map_err(storage_error)?;
            Ok(json!({"fanout": view(st, &record, None)}))
        }
        "fanout.list" => {
            let limit = match p.get("limit") {
                None | Some(Value::Null) => 20,
                Some(value) => value.as_u64().filter(|limit| *limit >= 1).ok_or_else(|| invalid("limit must be a positive number."))?.min(100) as usize,
            };
            let records = st.db.fanout_list(limit).map_err(storage_error)?;
            Ok(json!({"fanouts": records.iter().map(|record| view(st, record, Some(LIST_REPLY_CHARS))).collect::<Vec<_>>()}))
        }
        "fanout.pick" => {
            let id = required_id(p, "id")?;
            let record = st.db.fanout_get(id).map_err(storage_error)?;
            let chosen = match p.get("sessionId") {
                None | Some(Value::Null) => None,
                Some(value) => {
                    let session = value.as_str().filter(|session| !session.is_empty()).ok_or_else(|| invalid("sessionId must be a conversation id or null."))?;
                    if !record["rows"].as_array().is_some_and(|rows| rows.iter().any(|row| row["sessionId"].as_str() == Some(session))) {
                        return Err(invalid("That conversation is not part of this comparison."));
                    }
                    Some(session)
                }
            };
            st.db.fanout_pick(id, chosen).map_err(storage_error)?;
            st.emit("fanout.changed", json!({"id": id})).await;
            let record = st.db.fanout_get(id).map_err(storage_error)?;
            Ok(json!({"fanout": view(st, &record, None)}))
        }
        "fanout.delete" => {
            let id = required_id(p, "id")?;
            st.db.fanout_delete(id).map_err(storage_error)?;
            st.emit("fanout.changed", json!({"id": id})).await;
            Ok(json!({"deleted": true}))
        }
        _ => Err(derr("not_found", "unknown fan-out method", StatusCode::NOT_FOUND)),
    }
}

fn required_id<'a>(p: &'a Value, key: &str) -> Result<&'a str, DispatchError> {
    p[key].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid(&format!("{key} is required.")))
}

/// Where the conversations go.
enum Scope {
    /// One project for every bot.
    Project { id: String, folder: PathBuf },
    /// Each bot's own default order.
    Default,
    /// No project: each bot's private workspace.
    None,
}

/// `fanout.start`. With `mcp_client`, the messages are marked as sent by the Bitbots MCP.
/// Returns the fan-out as the UI reads it and the raw rows.
pub(crate) async fn start(st: &AppState, p: &Value, mcp_client: Option<&str>) -> Result<(Value, Vec<Value>), DispatchError> {
    let ids = bot_ids(&p["agentIds"])?;
    let text = match p.get("text") {
        None | Some(Value::Null) => "",
        Some(value) => value.as_str().ok_or_else(|| invalid("text must be a string."))?,
    };
    if text.chars().count() > MAX_TEXT_CHARS { return Err(invalid("The message is longer than 100000 characters.")); }
    let attachments = crate::prompt_attachments(&p["attachments"])?;
    if text.is_empty() && attachments.is_empty() { return Err(invalid("Write a message or add an image first.")); }
    let worktrees = match p.get("worktrees") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_bool().ok_or_else(|| invalid("worktrees must be true or false."))?),
    };
    let title = match p.get("title") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_str().map(str::trim).filter(|title| !title.is_empty() && title.chars().count() <= MAX_TITLE_CHARS).ok_or_else(|| invalid("The title must be 1 to 120 characters."))?),
    };
    // Every bot is checked before anything is created, so a bad choice leaves nothing behind.
    let mut agents = Vec::with_capacity(ids.len());
    for id in &ids {
        let agent = st.db.agent_get(id).map_err(|error| match error {
            bloblex_storage::StorageError::AgentNotFound => derr("not_found", "One of the bots no longer exists.", StatusCode::NOT_FOUND),
            _ => invalid("One of the bots is not valid."),
        })?;
        if agent["archived"] == true { return Err(derr("conflict", &format!("{} is archived.", agent["name"].as_str().unwrap_or("A bot")), StatusCode::CONFLICT)); }
        agents.push(agent);
    }
    let scope = match p.get("projectId") {
        None => Scope::Default,
        Some(Value::Null) => Scope::None,
        Some(value) => {
            let id = value.as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid("projectId must be a project id or null."))?;
            let project = st.db.project_get(id).map_err(|_| derr("not_found", "That project no longer exists.", StatusCode::NOT_FOUND))?;
            let folder = project["path"].as_str().map(PathBuf::from).filter(|path| path.is_dir()).ok_or_else(|| invalid("That project has no folder on this computer."))?;
            Scope::Project { id: id.to_owned(), folder }
        }
    };
    let title = title.map(str::to_owned).unwrap_or_else(|| default_title(text));
    let fanout_id = bloblex_storage::Storage::new_id();
    let record_project = match &scope { Scope::Project { id, .. } => Some(id.as_str()), _ => None };
    st.db.fanout_create(&fanout_id, &title, text, record_project).map_err(storage_error)?;
    let mut rows = Vec::with_capacity(agents.len());
    for agent in &agents {
        let outcome = start_one(st, agent, &scope, text, &p["attachments"], !attachments.is_empty(), worktrees, &title, &fanout_id, mcp_client).await;
        let agent_id = agent["id"].clone();
        rows.push(match outcome {
            Ok(session) => json!({"agentId": agent_id, "sessionId": session, "error": Value::Null}),
            Err((session, message)) => json!({"agentId": agent_id, "sessionId": session, "error": message}),
        });
    }
    st.db.fanout_set_rows(&fanout_id, &json!(rows)).map_err(storage_error)?;
    st.emit("fanout.changed", json!({"id": fanout_id})).await;
    let record = st.db.fanout_get(&fanout_id).map_err(storage_error)?;
    Ok((view(st, &record, None), rows))
}

fn bot_ids(value: &Value) -> Result<Vec<String>, DispatchError> {
    let choose = || invalid("Choose 2 to 6 bots.");
    let items = value.as_array().ok_or_else(choose)?;
    let mut ids: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let id = item.as_str().filter(|id| !id.is_empty()).ok_or_else(choose)?;
        if ids.iter().any(|known| known == id) { return Err(choose()); }
        ids.push(id.to_owned());
    }
    if !(MIN_BOTS..=MAX_BOTS).contains(&ids.len()) { return Err(choose()); }
    Ok(ids)
}

fn default_title(text: &str) -> String {
    let first = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = first.chars().take(DEFAULT_TITLE_CHARS).collect::<String>();
    if title.trim().is_empty() { "Compare bots".to_owned() } else { title }
}

fn provider_of(st: &AppState, agent: &Value) -> String {
    let wanted = agent["runtimeId"].as_str().unwrap_or("");
    st.db.runtimes().unwrap_or_default().iter().find(|runtime| runtime["id"].as_str() == Some(wanted)).and_then(|runtime| runtime["provider"].as_str().map(str::to_owned)).unwrap_or_default()
}

/// Starts one bot's conversation and sends the prompt. `Err((session, message))` carries the conversation when one exists.
#[allow(clippy::too_many_arguments)]
async fn start_one(st: &AppState, agent: &Value, scope: &Scope, text: &str, attachments: &Value, has_images: bool, worktrees: Option<bool>, title: &str, fanout_id: &str, mcp_client: Option<&str>) -> Result<String, (Option<String>, String)> {
    let name = agent["name"].as_str().unwrap_or("This bot").to_owned();
    if has_images && !matches!(provider_of(st, agent).as_str(), "claude" | "codex" | "opencode") {
        return Err((None, format!("{name} uses a coding agent that doesn't take images.")));
    }
    let (folder, project_id): (Option<PathBuf>, Option<String>) = match scope {
        Scope::Project { id, folder } => (Some(folder.clone()), Some(id.clone())),
        Scope::Default => {
            let (folder, id) = crate::team::default_conversation_project(st, agent);
            if id.is_some() { (Some(folder), id) } else { (None, None) }
        }
        Scope::None => (None, None),
    };
    // A separate copy of the project for each bot, unless the owner turned that off.
    let mut link = Value::Null;
    let mut made: Option<crate::worktree::Worktree> = None;
    let mut path = folder.clone();
    if let (Some(source), true) = (folder.clone(), worktrees.unwrap_or(true)) {
        let topic = format!("{} {}", name, text.split_whitespace().take(5).collect::<Vec<_>>().join(" "));
        let found = tokio::task::spawn_blocking(move || crate::worktree::repo_root(&source).map(|repo| crate::worktree::create(&repo, &topic))).await.map_err(|_| (None, format!("A separate copy of the project could not be made for {name}.")))?;
        match found {
            None => {}
            Some(Ok(copy)) => { path = Some(copy.path.clone()); link = json!({"kind": "main", "worktree": copy.to_json()}); made = Some(copy); }
            Some(Err(_)) => return Err((None, format!("A separate copy of the project could not be made for {name}."))),
        }
    }
    let mut params = json!({"agentId": agent["id"], "lazy": true, "title": title});
    if let Some(path) = &path { params["projectPath"] = json!(path.to_string_lossy()); }
    params["projectId"] = project_id.as_ref().map_or(Value::Null, |id| json!(id));
    if !link.is_null() { params["link"] = link; }
    let session = match crate::new_session(st, params).await {
        Ok(session) => session,
        Err(error) => {
            if let Some(copy) = made { discard(copy).await; }
            return Err((None, error.1.message));
        }
    };
    let session_id = session["id"].as_str().unwrap_or("").to_owned();
    let _ = st.db.merge_session_data(&session_id, &json!({"fanoutId": fanout_id}));
    let mut prompt = json!({"sessionId": session_id, "text": text});
    if has_images { prompt["attachments"] = attachments.clone(); }
    let sent = match mcp_client {
        Some(client) => { prompt["meta"] = json!({"kind": "mcp", "client": client}); crate::session_prompt_for_mcp(st, prompt).await }
        None => crate::session_prompt(st, prompt).await,
    };
    match sent {
        Ok(_) => Ok(session_id),
        // The daemon is at its concurrency limit: the prompt waits a few seconds for a slot.
        Err(error) if error.1.code == "conflict" => {
            let later = (Utc::now() + chrono::Duration::seconds(START_LATER_SECS)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let mut queued = json!({"sessionId": session_id, "text": text, "dueAt": later});
            if has_images { queued["attachments"] = attachments.clone(); }
            match crate::queue::add_marked(st, queued, mcp_client).await {
                Ok(_) => Ok(session_id),
                Err(_) => Err((Some(session_id), error.1.message)),
            }
        }
        Err(error) => Err((Some(session_id), error.1.message)),
    }
}

async fn discard(copy: crate::worktree::Worktree) {
    let _ = tokio::task::spawn_blocking(move || crate::worktree::discard(&copy.repo, &copy.path, &copy.branch)).await;
}

/// The fan-out as the UI reads it: the record plus every row's live state.
pub(crate) fn view(st: &AppState, record: &Value, reply_cap: Option<usize>) -> Value {
    let rows = record["rows"].as_array().map(|rows| rows.iter().map(|row| row_view(st, row, reply_cap)).collect::<Vec<_>>()).unwrap_or_default();
    json!({
        "id": record["id"], "title": record["title"], "text": record["prompt"],
        "projectId": record["projectId"], "projectName": record["projectName"],
        "createdAt": record["createdAt"], "chosenSessionId": record["chosenSessionId"],
        "rows": rows,
    })
}

fn row_view(st: &AppState, row: &Value, reply_cap: Option<usize>) -> Value {
    let agent_id = row["agentId"].as_str().unwrap_or("");
    let agent_name = st.db.agent_get(agent_id).ok().and_then(|agent| agent["name"].as_str().map(str::to_owned));
    let mut out = json!({
        "agentId": row["agentId"], "agentName": agent_name, "sessionId": Value::Null, "state": "failed",
        "reply": Value::Null, "error": row["error"], "durationMs": Value::Null, "tokens": Value::Null, "worktree": Value::Null,
    });
    let Some(session_id) = row["sessionId"].as_str() else { return out };
    // A conversation the owner deleted since is shown as a failed row.
    let Ok(summary) = st.db.session_event_summary(session_id) else {
        out["error"] = json!("This conversation was deleted.");
        return out;
    };
    out["sessionId"] = json!(session_id);
    let latest = st.db.session_latest_turn(session_id).ok().flatten();
    // An error left behind by a recovered failure yields to a newer completed turn.
    let mut state = summary["state"].as_str().unwrap_or("idle").to_owned();
    if matches!(state.as_str(), "error" | "failed") && latest.as_ref().is_some_and(|turn| turn["state"] == "completed") { state = "completed".to_owned(); }
    out["state"] = json!(state);
    if let Some(turn) = &latest {
        let turn_id = turn["id"].as_str().unwrap_or("");
        if let Some(reply) = st.db.turn_last_assistant_text(session_id, turn_id).ok().flatten() {
            out["reply"] = json!(match reply_cap { Some(cap) if reply.chars().count() > cap => reply.chars().take(cap).collect::<String>(), _ => reply });
        }
        let stamp = |value: &Value| value.as_str().and_then(|raw| DateTime::parse_from_rfc3339(raw).ok());
        if let (Some(start), Some(end)) = (stamp(&turn["createdAt"]), stamp(&turn["completedAt"])) {
            let ms = (end - start).num_milliseconds();
            if ms > 0 { out["durationMs"] = json!(ms); }
        }
        if let Ok((input, output)) = st.db.turn_usage_tokens(turn_id) {
            let total = input.unwrap_or(0) + output.unwrap_or(0);
            if (input.is_some() || output.is_some()) && total > 0 { out["tokens"] = json!(total); }
        }
    }
    if let Some(copy) = summary["link"]["worktree"].as_object() {
        out["worktree"] = json!({"path": copy.get("path"), "branch": copy.get("branch")});
    }
    out
}
