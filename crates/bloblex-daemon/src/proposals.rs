//! FIX36 D2: the Manager proposes, the owner approves.
//!
//! Every consequential action the Manager wants to take — creating a project,
//! creating a bot, assigning a task, and (D3) changing its own playbook — is
//! written down as a *proposal* and surfaced through the normal permission
//! plumbing as a `kind: "proposal"` card. Nothing is created before the owner
//! approves it. Approval runs the action and posts a short note back into the
//! Manager's conversation so the Manager sees the outcome on its next turn.

use crate::{agent_error, derr, AppState, DispatchError};
use axum::http::StatusCode;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::path::Path;
use uuid::Uuid;

/// A proposal lives for 24 hours before it lapses.
pub const EXPIRY_HOURS: i64 = 24;
/// The team cap carried over from the old `create_blob`.
const MAX_TEAM: usize = 12;

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The MCP tool descriptions the Manager sees. All four return immediately; the
/// first three wait for the owner's decision.
pub fn tool_schemas() -> Vec<Value> {
    vec![
        json!({"name":"propose_project","description":"Propose a new project for the user to approve. Nothing is created until they approve it. For a brand-new folder the owner picks the location in the approval card; use mode \"new\". For a folder that already exists use mode \"existing\" and its path.","inputSchema":{"type":"object","properties":{
            "name":{"type":"string","description":"The project name, 1 to 80 characters."},
            "description":{"type":"string","description":"One sentence on what the project is for, up to 255 characters (optional)."},
            "folder":{"type":"object","properties":{
                "mode":{"type":"string","enum":["new","existing"],"description":"\"new\" creates the folder (the owner picks where); \"existing\" uses a folder that is already there."},
                "parentHint":{"type":"string","description":"For mode \"new\": a hint about where the folder should live (optional)."},
                "path":{"type":"string","description":"For mode \"existing\": the folder path."}
            },"required":["mode"],"additionalProperties":false}
        },"required":["name","folder"],"additionalProperties":false}}),
        json!({"name":"propose_bot","description":"Propose a new bot (an AI teammate) for the user to approve. Nothing is created until they approve it. Give a short unique name, an optional role, a one-sentence purpose and instructions describing how it should work.","inputSchema":{"type":"object","properties":{
            "name":{"type":"string","description":"A short unique name, 1 to 40 characters."},
            "role":{"type":"string","description":"A role label such as CTO (optional, up to 40 characters)."},
            "description":{"type":"string","description":"What this bot is for, up to 255 characters (optional)."},
            "instructions":{"type":"string","description":"Persona and working style, up to 4000 characters (optional)."},
            "provider":{"type":"string","enum":["claude","codex","opencode"],"description":"The coding agent the bot runs on."},
            "model":{"type":"string","description":"A model id from that runtime's catalog (optional)."},
            "project":{"type":"string","description":"A project id or exact project name to attach the bot to (optional; absent makes a casual bot)."}
        },"required":["name","provider"],"additionalProperties":false}}),
        json!({"name":"assign_task","description":"Propose a task for one of your bots. It is delivered like message_blob when the user approves: a private side conversation, and the reply comes back here. Nothing is assigned until they approve it.","inputSchema":{"type":"object","properties":{
            "bot":{"type":"string","description":"The bot's name or id."},
            "project":{"type":"string","description":"A project id or exact project name the task belongs to (optional)."},
            "brief":{"type":"string","description":"A self-contained brief: goal, context, paths, constraints and what to send back."}
        },"required":["bot","brief"],"additionalProperties":false}}),
        json!({"name":"project_status","description":"Show a project's bots with their latest conversation title, state and last activity.","inputSchema":{"type":"object","properties":{
            "project":{"type":"string","description":"A project id or exact project name."}
        },"required":["project"],"additionalProperties":false}}),
        json!({"name":"set_conversation_permission","description":"Propose a permission change for a side conversation you started, for the user to approve. Nothing changes until they approve the card. Allowed modes are \"ask\" and \"auto\"; full access can never be set here.","inputSchema":{"type":"object","properties":{
            "conversation":{"type":"string","description":"The side conversation's id, from list_conversations."},
            "mode":{"type":"string","enum":["ask","auto"],"description":"The permission mode for that conversation from its next turn."}
        },"required":["conversation","mode"],"additionalProperties":false}}),
    ]
}

// ---------------------------------------------------------------------------
// Small validation helpers (shared by the propose_* tools and by an approval
// that carries the owner's edits).

fn reject_unknown(object: &serde_json::Map<String, Value>, allowed: &[&str], context: &str) -> Result<(), String> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("{context} has an unsupported field: {key}."));
    }
    Ok(())
}

fn required_str(object: &serde_json::Map<String, Value>, key: &str, limit: usize) -> Result<String, String> {
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

fn optional_str(object: &serde_json::Map<String, Value>, key: &str, limit: usize) -> Result<String, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(text)) => {
            let text = text.trim();
            if text.chars().count() > limit { return Err(format!("{key} must be at most {limit} characters.")); }
            Ok(text.to_owned())
        }
        Some(_) => Err(format!("{key} must be a string.")),
    }
}

fn validate_folder(folder: &Value) -> Result<Value, String> {
    let map = folder.as_object().ok_or("folder must be an object.")?;
    let mode = required_str(map, "mode", 20)?;
    match mode.as_str() {
        "new" => {
            reject_unknown(map, &["mode", "parentHint", "path"], "folder")?;
            let parent = optional_str(map, "parentHint", 260)?;
            let path = optional_str(map, "path", 1000)?;
            Ok(json!({"mode":"new","parentHint":parent,"path":path}))
        }
        "existing" => {
            reject_unknown(map, &["mode", "path"], "folder")?;
            let path = required_str(map, "path", 1000)?;
            Ok(json!({"mode":"existing","path":path}))
        }
        other => Err(format!("folder.mode must be \"new\" or \"existing\"; got \"{other}\".")),
    }
}

fn validate_project(args: &Value) -> Result<Value, String> {
    let map = args.as_object().ok_or("the project proposal must be an object.")?;
    reject_unknown(map, &["name", "description", "folder"], "the project proposal")?;
    let name = required_str(map, "name", 80)?;
    let description = optional_str(map, "description", 255)?;
    let folder = validate_folder(map.get("folder").ok_or("folder is required.")?)?;
    Ok(json!({"name":name,"description":description,"folder":folder}))
}

async fn validate_bot(st: &AppState, args: &Value) -> Result<Value, String> {
    let map = args.as_object().ok_or("the bot proposal must be an object.")?;
    reject_unknown(map, &["name", "role", "description", "instructions", "provider", "model", "project"], "the bot proposal")?;
    let name = required_str(map, "name", 40)?;
    let role = optional_str(map, "role", 40)?;
    let description = optional_str(map, "description", 255)?;
    let instructions = optional_str(map, "instructions", 4000)?;
    let provider = required_str(map, "provider", 20)?;
    if !["claude", "codex", "opencode"].contains(&provider.as_str()) {
        return Err(format!("provider must be claude, codex or opencode; got \"{provider}\"."));
    }
    let model = optional_str(map, "model", 200)?;
    let project = optional_str(map, "project", 200)?;
    if !st.runtimes.read().await.iter().any(|runtime| runtime["provider"].as_str() == Some(provider.as_str())) {
        return Err(format!("No {provider} runtime is installed."));
    }
    let agents = st.db.agent_list(false, None).map_err(|error| error.to_string())?;
    if agents.len() >= MAX_TEAM {
        return Err(format!("The team already has {} bots; Bitbots allows at most 12. Archive one before creating another.", agents.len()));
    }
    if agents.iter().any(|agent| agent["name"].as_str().map(str::trim).map(str::to_lowercase).is_some_and(|existing| existing == name.to_lowercase())) {
        return Err(format!("A bot named {name} already exists. Choose a different name."));
    }
    Ok(json!({"name":name,"role":role,"description":description,"instructions":instructions,"provider":provider,"model":model,"project":project}))
}

fn validate_task(args: &Value) -> Result<Value, String> {
    let map = args.as_object().ok_or("the task proposal must be an object.")?;
    reject_unknown(map, &["bot", "project", "brief"], "the task proposal")?;
    let bot = required_str(map, "bot", 80)?;
    let project = optional_str(map, "project", 200)?;
    let brief = required_str(map, "brief", 200_000)?;
    Ok(json!({"bot":bot,"project":project,"brief":brief}))
}

/// FIX39 item 19: a permission change for one side conversation. Full access is
/// never offered: the Manager may only choose Ask first or Auto.
fn validate_permission(args: &Value) -> Result<Value, String> {
    let map = args.as_object().ok_or("the permission proposal must be an object.")?;
    reject_unknown(map, &["conversation", "mode"], "the permission proposal")?;
    let conversation = required_str(map, "conversation", 80)?;
    let mode = required_str(map, "mode", 10)?;
    if !matches!(mode.as_str(), "ask" | "auto") {
        return Err("mode must be \"ask\" or \"auto\"; full access is never set here.".into());
    }
    Ok(json!({"conversation": conversation, "mode": mode}))
}

/// The Manager's conversation, or the non-manager refusal. The tool list only
/// offers these tools to the Manager, but the dispatch re-checks so a stale or
/// forged call cannot slip through.
pub(crate) fn manager_of_session(st: &AppState, session_id: &str) -> Result<Value, String> {
    let session = st.db.session_detail(session_id).map_err(|_| "This conversation is no longer available.".to_owned())?;
    if session["archived"] == true { return Err("This conversation is archived.".into()); }
    let agent_id = session["agentId"].as_str().ok_or_else(|| "Only the Manager can propose work.".to_owned())?;
    let agent = st.db.agent_get(agent_id).map_err(|_| "Your bot is no longer available.".to_owned())?;
    if agent["systemRole"].as_str() != Some("manager") || agent["archived"] == true { return Err(crate::team::non_manager_error(st)); }
    Ok(agent)
}

/// Write the proposal down and announce its card. Returns the proposal id.
pub(crate) async fn create_proposal(st: &AppState, session_id: &str, manager: &Value, kind: &str, payload: Value, title: String, detail: Option<String>) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let at = Utc::now();
    let created_at = iso(at);
    let expires_at = iso(at + Duration::hours(EXPIRY_HOURS));
    let session = st.db.session_detail(session_id).map_err(|_| "This conversation is no longer available.".to_owned())?;
    let record = json!({"id": &id, "sessionId": session_id, "agentId": manager["id"], "kind": kind, "payload": payload});
    let proposal = json!({"id": &id, "kind": kind, "payload": record["payload"].clone()});
    let permission = json!({
        "id": &id, "sessionId": session_id, "kind": "proposal", "category": "proposal",
        "title": title, "detail": detail, "risk": "none", "choices": ["approve", "reject"],
        "proposal": proposal, "expiresAt": expires_at, "status": "pending"
    });
    st.db
        .insert_proposal(&record, &permission, &created_at, &expires_at)
        .map_err(|error| format!("The proposal could not be recorded: {error}"))?;
    // The card and its event are the same object plus the runtime.
    let mut event = permission;
    event["runtimeId"] = session["runtimeId"].clone();
    st.emit("permission.requested", event).await;
    Ok(id)
}

fn waiting(id: &str) -> String {
    format!("Waiting for the user's approval (proposal {id}).")
}

pub async fn propose_project(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    let manager = manager_of_session(st, session_id)?;
    let payload = validate_project(args)?;
    let name = payload["name"].as_str().unwrap_or("").to_owned();
    let detail = payload["description"].as_str().filter(|d| !d.is_empty()).map(str::to_owned);
    let id = create_proposal(st, session_id, &manager, "project", payload, format!("Create the project \"{name}\""), detail).await?;
    Ok(waiting(&id))
}

pub async fn propose_bot(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    let manager = manager_of_session(st, session_id)?;
    let payload = validate_bot(st, args).await?;
    let name = payload["name"].as_str().unwrap_or("").to_owned();
    let role = payload["role"].as_str().unwrap_or("");
    let provider = payload["provider"].as_str().unwrap_or("");
    let detail = if role.is_empty() { provider.to_owned() } else { format!("{role} · {provider}") };
    let id = create_proposal(st, session_id, &manager, "bot", payload, format!("Create the bot \"{name}\""), Some(detail)).await?;
    Ok(waiting(&id))
}

pub async fn assign_task(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    let manager = manager_of_session(st, session_id)?;
    let payload = validate_task(args)?;
    let bot = payload["bot"].as_str().unwrap_or("").to_owned();
    let mut detail: String = payload["brief"].as_str().unwrap_or("").chars().take(200).collect();
    if let Some(project) = payload["project"].as_str().filter(|project| !project.is_empty()) {
        detail = format!("{project}: {detail}");
    }
    let id = create_proposal(st, session_id, &manager, "task", payload, format!("Assign a task to {bot}"), Some(detail)).await?;
    Ok(waiting(&id))
}

/// FIX39 item 19: propose a permission change for a side conversation the
/// Manager itself started. Locked bots refuse it, and full access is never
/// offered.
pub async fn propose_permission(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    let manager = manager_of_session(st, session_id)?;
    let payload = validate_permission(args)?;
    let conversation = payload["conversation"].as_str().unwrap_or("").to_owned();
    let row = st.db.session_detail(&conversation).map_err(|_| format!("No conversation {conversation}."))?;
    if row["link"]["kind"] != "side" { return Err("Only a side conversation between two bots can be changed here.".into()); }
    let manager_id = manager["id"].as_str().unwrap_or("");
    if row["link"]["peerAgentId"].as_str() != Some(manager_id) {
        return Err("Only a side conversation the Manager started can be changed here.".into());
    }
    let target_id = row["agentId"].as_str().unwrap_or("").to_owned();
    if st.db.agent_get(&target_id).map(|agent| crate::bot_is_locked(&agent)).unwrap_or(false) {
        return Err("This bot is locked. Unlock it to change its settings.".into());
    }
    let mode = payload["mode"].as_str().unwrap_or("ask").to_owned();
    let target = st.db.agent_get(&target_id).ok().and_then(|agent| agent["name"].as_str().map(str::to_owned)).unwrap_or_else(|| "the bot".into());
    let detail = format!("Conversation {conversation} · applies from the next turn");
    let id = create_proposal(st, session_id, &manager, "permission", payload, format!("Change {target}'s conversation permission to {mode}"), Some(detail)).await?;
    Ok(waiting(&id))
}

/// Read-only: a project's bots, each with its latest conversation title, state
/// and last activity.
pub async fn project_status(st: &AppState, args: &Value) -> Result<String, String> {
    let wanted = args["project"].as_str().map(str::trim).filter(|project| !project.is_empty()).ok_or("project is required.")?;
    let projects = st.db.project_list().map_err(|error| error.to_string())?;
    let project = projects.iter().find(|project| project["id"].as_str() == Some(wanted) || project["name"].as_str().is_some_and(|name| name.trim().eq_ignore_ascii_case(wanted))).ok_or_else(|| format!("No project matches \"{wanted}\"."))?;
    let project_id = project["id"].as_str().unwrap_or("");
    let name = project["name"].as_str().unwrap_or("Project");
    let agents = st.db.agent_list(false, None).map_err(|error| error.to_string())?;
    let sessions = st.db.session_list(false).unwrap_or_default();
    let rows = agents.iter().filter(|agent| agent["projectId"].as_str() == Some(project_id)).map(|agent| {
        let agent_id = agent["id"].as_str().unwrap_or("");
        let latest = sessions.iter().filter(|session| session["agentId"].as_str() == Some(agent_id)).max_by_key(|session| session["updatedAt"].as_str().unwrap_or("").to_owned());
        let (title, state, activity) = match latest {
            Some(session) => (session["title"].as_str().unwrap_or("(no conversation)").to_owned(), session["state"].as_str().unwrap_or("unknown").to_owned(), session["updatedAt"].as_str().unwrap_or("").get(..16).unwrap_or("").replace('T', " ")),
            None => ("(no conversation)".to_owned(), "unknown".to_owned(), String::new()),
        };
        format!("- {} — {state} · \"{title}\" · last active {activity} UTC", agent["name"].as_str().unwrap_or("Bot"))
    }).collect::<Vec<_>>();
    if rows.is_empty() { return Ok(format!("Project \"{name}\" has no bots yet.")); }
    Ok(format!("Bots in \"{name}\":\n{}", rows.join("\n")))
}

// ---------------------------------------------------------------------------
// Deciding a proposal.

/// Merge the owner's partial edits into the payload. One level is enough: the
/// card edits nested objects such as `folder` by sending `{"folder":{...}}`.
fn merge_payload(base: &mut Value, edits: &Value) {
    if let (Some(base), Some(edits)) = (base.as_object_mut(), edits.as_object()) {
        for (key, value) in edits {
            match (base.get_mut(key), value) {
                (Some(Value::Object(inner)), Value::Object(edit)) => { for (key, value) in edit { inner.insert(key.clone(), value.clone()); } }
                _ => { base.insert(key.clone(), value.clone()); }
            }
        }
    }
}

pub(crate) fn describe(kind: &str, payload: &Value) -> String {
    match kind {
        "project" => format!("create project {}", payload["name"].as_str().unwrap_or("a project")),
        "bot" => format!("create bot {}", payload["name"].as_str().unwrap_or("a bot")),
        "task" => format!("assign a task to {}", payload["bot"].as_str().unwrap_or("a bot")),
        "permission" => format!("set a conversation's permission to {}", payload["mode"].as_str().unwrap_or("a mode")),
        "playbook" => "change the Manager's playbook".to_owned(),
        "profile" => match payload["op"].as_str().unwrap_or("set") {
            "forget" => format!("forget what the Manager knows ({})", payload["key"].as_str().unwrap_or("a preference")),
            _ => format!("change what the Manager knows ({})", payload["key"].as_str().unwrap_or("a preference")),
        },
        _ => "act".to_owned(),
    }
}

fn invalid(message: String) -> DispatchError {
    derr("invalid_argument", &message, StatusCode::BAD_REQUEST)
}

/// Run an approved proposal. Returns the stored result and a one-line summary
/// for the Manager's note.
async fn apply(st: &AppState, session_id: &str, agent_id: Option<&str>, kind: &str, payload: &Value) -> Result<(Value, String), DispatchError> {
    match kind {
        "project" => apply_project(st, payload),
        "bot" => apply_bot(st, agent_id, payload).await,
        "task" => apply_task(st, session_id, payload).await,
        "permission" => apply_permission(st, agent_id, payload).await,
        "playbook" => apply_playbook(st, payload),
        "profile" => apply_profile(st, payload),
        _ => Err(invalid("That proposal kind is not supported.".into())),
    }
}

/// Append the approved playbook text as a new `manager` version.
fn apply_playbook(st: &AppState, payload: &Value) -> Result<(Value, String), DispatchError> {
    let text = payload["text"].as_str().map(str::trim).filter(|text| !text.is_empty()).ok_or_else(|| invalid("The playbook text is required.".into()))?;
    if text.chars().count() > crate::knowledge::MAX_PLAYBOOK_CHARS {
        return Err(invalid(format!("The playbook must be at most {} characters.", crate::knowledge::MAX_PLAYBOOK_CHARS)));
    }
    let playbook = st.db.manager_playbook_append(text, "manager").map_err(agent_error)?;
    Ok((json!({"version": playbook["version"], "playbook": playbook}), "updated the Manager's playbook".to_owned()))
}

/// Apply an approved profile change: `set` writes the fact, `forget` removes it.
fn apply_profile(st: &AppState, payload: &Value) -> Result<(Value, String), DispatchError> {
    let category = payload["category"].as_str().unwrap_or("");
    let key = payload["key"].as_str().unwrap_or("");
    match payload["op"].as_str().unwrap_or("set") {
        "forget" => {
            let removed = st.db.manager_profile_delete_key(category, key).map_err(agent_error)?;
            Ok((json!({"deleted": removed, "category": category, "key": key}), format!("forgot what the Manager knew ({key})")))
        }
        "set" => {
            let value = payload["value"].as_str().unwrap_or("");
            let source = payload["source"].as_str().unwrap_or("learned");
            let fact = st.db.manager_profile_put(category, key, value, source, None).map_err(agent_error)?;
            Ok((json!({"fact": fact, "category": category, "key": key}), format!("updated what the Manager knew ({key})")))
        }
        _ => Err(invalid("A profile proposal must be a set or a forget.".into())),
    }
}

fn apply_project(st: &AppState, payload: &Value) -> Result<(Value, String), DispatchError> {
    let name = payload["name"].as_str().unwrap_or("").to_owned();
    let description = payload["description"].as_str().unwrap_or("").to_owned();
    let folder = &payload["folder"];
    let mode = folder["mode"].as_str().unwrap_or("");
    let chosen = folder["path"].as_str().map(str::trim).filter(|path| !path.is_empty());
    let path = match mode {
        "existing" => {
            let path = chosen.ok_or_else(|| invalid("Choose an existing folder for the project.".into()))?;
            // A folder must be a full path: a bare name or `./x` would resolve
            // against the daemon's own working directory, which the user did not
            // choose.
            if !Path::new(path).is_absolute() { return Err(invalid("Choose a full folder path.".into())); }
            if !Path::new(path).is_dir() { return Err(invalid(format!("The folder {path} does not exist."))); }
            path.to_owned()
        }
        "new" => {
            let path = chosen.ok_or_else(|| invalid("The owner must choose a folder for the new project.".into()))?;
            if !Path::new(path).is_absolute() { return Err(invalid("Choose a full folder path.".into())); }
            // `create_dir_all` on an existing *file* fails with a raw OS error;
            // refuse it plainly instead.
            if Path::new(path).is_file() { return Err(invalid(format!("{path} is a file, not a folder."))); }
            std::fs::create_dir_all(path).map_err(|error| derr("internal", &format!("The folder could not be created: {error}"), StatusCode::INTERNAL_SERVER_ERROR))?;
            path.to_owned()
        }
        _ => return Err(invalid("folder.mode must be \"new\" or \"existing\".".into())),
    };
    let (project, events) = st.db.project_create(&name, Some(&path)).map_err(agent_error)?;
    st.broadcast_persisted(events);
    let mut project = project;
    if !description.is_empty() {
        let id = project["id"].as_str().unwrap_or("").to_owned();
        let (updated, events) = st.db.project_update(&id, &json!({"description": description})).map_err(agent_error)?;
        st.broadcast_persisted(events);
        project = updated;
    }
    Ok((json!({"projectId": project["id"], "project": project}), format!("created project {name}")))
}

async fn apply_bot(st: &AppState, agent_id: Option<&str>, payload: &Value) -> Result<(Value, String), DispatchError> {
    let payload = validate_bot(st, payload).await.map_err(invalid)?;
    let name = payload["name"].as_str().unwrap_or("").to_owned();
    let role = payload["role"].as_str().unwrap_or("");
    let provider = payload["provider"].as_str().unwrap_or("");
    // Resolve the project before creating the bot so a bad project leaves no
    // half-made teammate behind.
    let project_id = match payload["project"].as_str().filter(|project| !project.is_empty()) {
        None => None,
        Some(wanted) => {
            let projects = st.db.project_list().map_err(agent_error)?;
            let found = projects.iter().find(|project| project["id"].as_str() == Some(wanted) || project["name"].as_str().is_some_and(|project_name| project_name.trim().eq_ignore_ascii_case(wanted)));
            Some(found.and_then(|project| project["id"].as_str()).map(str::to_owned).ok_or_else(|| invalid(format!("No project matches \"{wanted}\".")))?)
        }
    };
    let runtime = st.runtimes.read().await.iter().find(|runtime| runtime["provider"].as_str() == Some(provider)).cloned().ok_or_else(|| invalid(format!("No {provider} runtime is installed.")))?;
    // Created bots inherit a safe mode from the Manager: never bypass.
    let approval = if agent_id.and_then(|id| st.db.agent_get(id).ok()).and_then(|manager| manager["effectiveApprovalMode"].as_str().map(str::to_owned)).as_deref() == Some("auto") { "auto" } else { "ask" };
    let mut fields = json!({"name": name, "runtimeId": runtime["id"], "approvalMode": approval});
    if !payload["description"].as_str().unwrap_or("").is_empty() { fields["description"] = payload["description"].clone(); }
    if !payload["instructions"].as_str().unwrap_or("").is_empty() { fields["instructions"] = payload["instructions"].clone(); }
    if !payload["model"].as_str().unwrap_or("").is_empty() { fields["model"] = payload["model"].clone(); }
    let agent = crate::agent_create_from_rpc(st, fields).await?;
    let created_id = agent["id"].as_str().unwrap_or("").to_owned();
    let mut team_fields = json!({});
    if !role.is_empty() { team_fields["role"] = json!(role); }
    if let Some(project_id) = &project_id { team_fields["projectId"] = json!(project_id); }
    if team_fields.as_object().is_some_and(|object| !object.is_empty()) {
        let (_agent, events) = st.db.agent_set_team(&created_id, &team_fields).map_err(agent_error)?;
        st.broadcast_persisted(events);
    }
    Ok((json!({"agentId": created_id, "agent": agent}), format!("created bot {name}")))
}

async fn apply_task(st: &AppState, session_id: &str, payload: &Value) -> Result<(Value, String), DispatchError> {
    let payload = validate_task(payload).map_err(invalid)?;
    let bot = payload["bot"].as_str().unwrap_or("");
    if let Some(project) = payload["project"].as_str().filter(|project| !project.is_empty()) {
        let projects = st.db.project_list().map_err(agent_error)?;
        if !projects.iter().any(|candidate| candidate["id"].as_str() == Some(project) || candidate["name"].as_str().is_some_and(|name| name.trim().eq_ignore_ascii_case(project))) {
            return Err(invalid(format!("No project matches \"{project}\".")));
        }
    }
    let brief = payload["brief"].as_str().unwrap_or("");
    let delegation = crate::team::delegate(st, session_id, &json!({"blob": bot, "message": brief})).await.map_err(invalid)?;
    Ok((json!({"sideSessionId": delegation.side, "topic": delegation.title, "bot": delegation.target_name}), format!("assigned a task to {}", delegation.target_name)))
}

/// Apply an approved permission change to one side conversation. Full access is
/// refused even here, and a locked bot refuses the change. P5 audit S5: the
/// proposal may have been edited before approval, so the target conversation is
/// re-checked against the Manager that proposed it, exactly as at create time.
async fn apply_permission(st: &AppState, agent_id: Option<&str>, payload: &Value) -> Result<(Value, String), DispatchError> {
    let conversation = payload["conversation"].as_str().unwrap_or("").to_owned();
    let mode = payload["mode"].as_str().unwrap_or("ask").to_owned();
    if !matches!(mode.as_str(), "ask" | "auto") {
        return Err(invalid("A conversation permission must be ask or auto.".into()));
    }
    let row = st.db.session_detail(&conversation).map_err(|_| invalid("That conversation is no longer available.".into()))?;
    if row["link"]["kind"] != "side" { return Err(invalid("That conversation is not a side conversation.".into())); }
    let manager_id = agent_id.unwrap_or("");
    if row["link"]["peerAgentId"].as_str() != Some(manager_id) {
        return Err(invalid("That conversation was not started by the Manager that proposed this change.".into()));
    }
    let target_id = row["agentId"].as_str().unwrap_or("").to_owned();
    if st.db.agent_get(&target_id).map(|agent| crate::bot_is_locked(&agent)).unwrap_or(false) {
        return Err(derr("conflict", "This bot is locked. Unlock it to change its settings.", StatusCode::CONFLICT));
    }
    // P5 audit F3: the same lock builder the owner's own RPC uses, so an
    // approved proposal does not drop Claude workflows or plan mode either.
    let lock = crate::conversation_lock_for(st, &row, Some(&mode), Some("manager"))?;
    let updated = st.db.set_session_model_lock(&conversation, &lock).map_err(agent_error)?;
    st.emit("session.changed", updated).await;
    Ok((json!({"sessionId": conversation, "approvalMode": mode}), format!("set a conversation's permission to {mode}")))
}

async fn post_note(st: &AppState, session_id: &str, text: &str, id: &str, kind: &str, decision: &str) {
    crate::team::note(st, session_id, text, json!({"kind":"proposal","proposalId":id,"proposalKind":kind,"decision":decision})).await;
}

/// `proposal.decide { id, decision, edits? }`.
pub async fn decide(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = p["id"].as_str().map(str::trim).filter(|id| !id.is_empty()).ok_or_else(|| invalid("id is required.".into()))?;
    let decision = p["decision"].as_str().map(str::trim).unwrap_or("");
    if !["approve", "reject"].contains(&decision) { return Err(invalid("decision must be \"approve\" or \"reject\".".into())); }
    let proposal = st.db.proposal_get(id).map_err(|_| derr("conflict", "That proposal is no longer available.", StatusCode::CONFLICT))?;
    if proposal["status"].as_str() != Some("pending") { return Err(derr("conflict", "That proposal has already been decided.", StatusCode::CONFLICT)); }
    let session_id = proposal["sessionId"].as_str().unwrap_or("").to_owned();
    let kind = proposal["kind"].as_str().unwrap_or("").to_owned();
    let agent_id = proposal["agentId"].as_str().map(str::to_owned);
    let mut payload = proposal["payload"].clone();
    if let Some(edits) = p.get("edits").filter(|edits| !edits.is_null()) {
        if !edits.is_object() { return Err(invalid("edits must be an object.".into())); }
        merge_payload(&mut payload, edits);
    }
    let decided_at = iso(Utc::now());
    if decision == "reject" {
        if !st.db.proposal_decide(id, "rejected", None, "reject", &decided_at).map_err(agent_error)? {
            return Err(derr("conflict", "That proposal has already been decided.", StatusCode::CONFLICT));
        }
        post_note(st, &session_id, &format!("Rejected: {}", describe(&kind, &payload)), id, &kind, "rejected").await;
        st.emit("permission.resolved", json!({"permissionId": id, "choice": "reject", "status": "rejected"})).await;
        st.emit("proposal.changed", json!({"id":id,"kind":kind,"sessionId":session_id,"status":"rejected","result":Value::Null,"decidedAt":decided_at})).await;
        return Ok(json!({"id": id, "decision": "rejected"}));
    }
    // Approve: run the action, then record the outcome. A validation failure
    // (a missing folder, an unknown project) leaves the proposal pending so the
    // owner can fix the card and try again.
    let (result, summary) = apply(st, &session_id, agent_id.as_deref(), &kind, &payload).await?;
    if !st.db.proposal_decide(id, "approved", Some(&result), "approve", &decided_at).map_err(agent_error)? {
        return Err(derr("conflict", "That proposal has already been decided.", StatusCode::CONFLICT));
    }
    post_note(st, &session_id, &format!("Approved: {summary}"), id, &kind, "approved").await;
    st.emit("permission.resolved", json!({"permissionId": id, "choice": "approve", "status": "resolved"})).await;
    st.emit("proposal.changed", json!({"id":id,"kind":kind,"sessionId":session_id,"status":"approved","result":result,"decidedAt":decided_at})).await;
    Ok(json!({"id": id, "decision": "approved", "result": result}))
}

/// Expire proposals whose 24 hours have lapsed. Called from the same periodic
/// sweep as the questions, so a lapsed card disappears from every surface.
pub async fn sweep(st: &AppState) {
    sweep_at(st, Utc::now()).await;
}

/// The injectable-clock form: `at` is "now". A proposal created at `at0` lasts
/// until `at0 + 24h`, so a caller can fast-forward the clock in a test.
pub async fn sweep_at(st: &AppState, at: DateTime<Utc>) {
    let cutoff = iso(at - Duration::hours(EXPIRY_HOURS));
    let decided_at = iso(at);
    let expired = match st.db.expire_due_proposals(&cutoff, &decided_at) { Ok(rows) => rows, Err(_) => return };
    for row in expired {
        let id = row["id"].as_str().unwrap_or("").to_owned();
        let session_id = row["sessionId"].as_str().unwrap_or("").to_owned();
        let kind = row["kind"].as_str().unwrap_or("").to_owned();
        let payload = row["payload"].clone();
        st.emit("permission.resolved", json!({"permissionId": id, "choice": "expired", "status": "expired"})).await;
        if !session_id.is_empty() {
            post_note(st, &session_id, &format!("Expired: {}", describe(&kind, &payload)), &id, &kind, "expired").await;
            st.emit("proposal.changed", json!({"id":id,"kind":kind,"sessionId":session_id,"status":"expired","result":Value::Null,"decidedAt":decided_at})).await;
        }
    }
}
