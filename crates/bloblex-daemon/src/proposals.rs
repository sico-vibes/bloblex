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
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// A proposal lives for 24 hours before it lapses.
pub const EXPIRY_HOURS: i64 = 24;
/// The team cap carried over from the old `create_blob`.
const MAX_TEAM: usize = 12;

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The stable MCP descriptions the Manager sees. Writes return a proposal id
/// immediately and wait for the owner; status reads need no approval.
pub fn tool_schemas() -> Vec<Value> {
    let mut schemas = vec![
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
        json!({"name":"set_conversation_permission","description":"Propose changing the bot's permission using a side conversation you started. It applies to all that bot's conversations from their next turn, after owner approval. Allowed modes are \"ask\" and \"auto\"; full access can never be set here.","inputSchema":{"type":"object","properties":{
            "conversation":{"type":"string","description":"The side conversation's id, from list_conversations."},
            "mode":{"type":"string","enum":["ask","auto"],"description":"The bot permission for all its conversations from their next turn."}
        },"required":["conversation","mode"],"additionalProperties":false}}),
    ];
    for tool in &mut schemas {
        let name = tool["name"].as_str().unwrap_or("").to_owned();
        let props = tool["inputSchema"]["properties"].as_object_mut().unwrap();
        match name.as_str() {
            "propose_project" => { props.insert("tags".into(), tag_schema()); }
            "propose_bot" => {
                props.insert("tags".into(), tag_schema());
                props.insert("thinking".into(), json!({"type":["string","null"],"description":"Effort id; null uses the model default."}));
                props.insert("look".into(), json!({"type":["object","null"],"description":"Look as returned by read_blob: shape, seed, traits, bot, icon (logo, logo-tint, logo-mono, char-albert-einstein, char-nikola-tesla, char-cleopatra, char-superman, char-sherlock-holmes, char-robin-hood, char-thor, char-hulk, char-marie-curie, char-joan-of-arc, char-amelia-earhart, char-sun-wukong, char-frida-kahlo, char-captain-marvel, char-ada-lovelace, char-ludwig-van-beethoven, char-charlie-chaplin, char-william-shakespeare, char-queen-elizabeth-i, char-master-chief, char-sonic, char-anubis, char-wolfgang-amadeus-mozart, char-arthur-morgan, char-count-dracula, char-hua-mulan, char-gandalf, char-benjamin-franklin, char-kratos). Haze look: the bot's mark. logo, logo-tint and logo-mono show the runtime's logo in its own colours, the bot colour or one colour; char-* selects one of the Haze character portraits in its original colours."}));
                props.insert("approvalMode".into(), json!({"type":"string","enum":["ask","auto"]}));
            }
            "assign_task" => {
                props.insert("doneGoal".into(), json!({"type":"string","description":"Fill this yourself: observable completion criteria."}));
                props.insert("reportBack".into(), json!({"type":"string","description":"Fill this yourself: findings, evidence and open questions the bot should return."}));
                props.insert("topic".into(), json!({"type":"string","description":"A new short topic starts parallel work."}));
                props.insert("conversation".into(), json!({"type":"string","description":"Continue a side conversation you started, instead of a new parallel one."}));
                tool["inputSchema"]["required"] = json!(["bot","brief","doneGoal","reportBack"]);
            }
            _ => {}
        }
    }
    schemas
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
    reject_unknown(map, &["name", "description", "folder", "tags"], "the project proposal")?;
    let name = required_str(map, "name", 80)?;
    let description = optional_str(map, "description", 255)?;
    let folder = validate_folder(map.get("folder").ok_or("folder is required.")?)?;
    let tags = validated_tags(args.get("tags"))?;
    Ok(json!({"name":name,"description":description,"folder":folder,"tags":tags}))
}

async fn validate_bot(st: &AppState, args: &Value) -> Result<Value, String> {
    let map = args.as_object().ok_or("the bot proposal must be an object.")?;
    reject_unknown(map, &["name", "role", "description", "instructions", "provider", "model", "project", "tags", "thinking", "look", "approvalMode"], "the bot proposal")?;
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
    let project = if project.is_empty() { project } else { crate::team::project_named(st,&project)?["id"].as_str().unwrap_or("").to_owned() };
    let runtime_id = st.runtimes.read().await.iter()
        .find(|runtime| runtime["provider"].as_str() == Some(provider.as_str()))
        .and_then(|runtime| runtime["id"].as_str().map(str::to_owned))
        .ok_or_else(|| format!("No {provider} runtime is installed."))?;
    let agents = st.db.agent_list(false, None).map_err(|error| error.to_string())?;
    if agents.len() >= MAX_TEAM {
        return Err(format!("The team already has {} bots; Bitbots allows at most 12. Archive one before creating another.", agents.len()));
    }
    if agents.iter().any(|agent| agent["name"].as_str().map(str::trim).map(str::to_lowercase).is_some_and(|existing| existing == name.to_lowercase())) {
        return Err(format!("A bot named {name} already exists. Choose a different name."));
    }
    if !project.is_empty() { crate::team::project_named(st, &project)?; }
    let mut payload = json!({"name":name,"role":role,"description":description,"instructions":instructions,"provider":provider,"model":model,"project":project,"tags":validated_tags(args.get("tags"))?});
    for key in ["thinking", "look", "approvalMode"] { if let Some(value) = args.get(key) { payload[key] = value.clone(); } }
    if model.is_empty() { payload["model"] = Value::Null; }
    validate_bot_options(&payload)?;
    // Validate the same catalogue constraints used by agent.create before
    // showing an approval card. Unknown IDs must not become promises that can
    // only fail after the owner approves; never substitute another model.
    crate::validate_agent_catalog(st, &runtime_id, &payload).await
        .map_err(|error| format!("{} Choose an available model and effort from the coding agent's catalogue.", error.1.message))?;
    Ok(payload)
}

fn validate_task(args: &Value) -> Result<Value, String> {
    let map = args.as_object().ok_or("the task proposal must be an object.")?;
    reject_unknown(map, &["bot", "project", "brief", "doneGoal", "reportBack", "topic", "conversation", "botName", "projectName"], "the task proposal")?;
    let bot = required_str(map, "bot", 80)?;
    let project = optional_str(map, "project", 200)?;
    let brief = required_str(map, "brief", 180_000)?;
    let done = required_str(map, "doneGoal", 4000)?;
    let report = required_str(map, "reportBack", 4000)?;
    let topic = optional_str(map, "topic", 60)?;
    let conversation = optional_str(map, "conversation", 80)?;
    Ok(json!({"bot":bot,"project":project,"brief":brief,"doneGoal":done,"reportBack":report,"topic":topic,"conversation":conversation}))
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
    // FIX39 P7 audit F6: refuse a delegation that is already too deep before the
    // owner is shown an approval card that could never succeed. The delivery
    // path re-checks the depth as well.
    if crate::team::depth_exceeded(st, session_id) { return Err(crate::team::depth_error()); }
    let mut payload = validate_task(args)?;
    validate_task_target(st, &manager, &payload)?;
    let target = crate::team::blob_named(st,payload["bot"].as_str().unwrap_or(""))?;
    payload["bot"] = target["id"].clone();
    payload["botName"] = target["name"].clone();
    // Bind the approval to ids, so renames cannot silently retarget a task.
    if let Some(project) = payload["project"].as_str().filter(|p| !p.is_empty()) {
        payload["project"] = crate::team::project_named(st,project)?["id"].clone();
    } else {
        // Any bot works in any project: with none named, the task opens in the
        // project of the conversation it is sent from, else the bot's default.
        let has_folder = |id: &str| crate::team::project_named(st, id).is_ok_and(|project| project["path"].as_str().is_some_and(|path| Path::new(path).is_dir()));
        let sender = st.db.session_detail(session_id).ok().and_then(|row| row["projectId"].as_str().map(str::to_owned)).filter(|id| has_folder(id));
        if let Some(project) = sender.as_deref().or(target["projectId"].as_str()) { payload["project"] = json!(project); }
    }
    validate_task_target(st, &manager, &payload)?;
    if let Some(project) = payload["project"].as_str().filter(|p| !p.is_empty()) { payload["projectName"] = crate::team::project_named(st,project)?["name"].clone(); }
    let bot = target["name"].as_str().unwrap_or("bot").to_owned();
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
    let id = create_proposal(st, session_id, &manager, "permission", payload, format!("Change {target}'s permission to {mode}"), Some(detail)).await?;
    Ok(waiting(&id))
}

/// Read-only: a project's bots, each with its latest conversation title, state
/// and last activity.
pub async fn project_status(st: &AppState, args: &Value) -> Result<String, String> {
    let wanted = args["project"].as_str().map(str::trim).filter(|project| !project.is_empty()).ok_or("project is required.")?;
    let project = crate::team::project_named(st,wanted)?;
    let project_id = project["id"].as_str().unwrap_or("");
    let name = project["name"].as_str().unwrap_or("Project");
    // FIX39 item 21: a project's tags are the routing signal, so `project_status`
    // shows them too.
    let tags = project["tags"].as_array().map(|tags| tags.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default();
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
    let tagged = if tags.is_empty() { String::new() } else { format!(" · tags: {}", tags.join(", ")) };
    if rows.is_empty() { return Ok(format!("Project \"{name}\"{tagged} has no bots yet.")); }
    Ok(format!("Project \"{name}\"{tagged}:\n{}", rows.join("\n")))
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
    // Names are friendlier than ids on the Manager's decision notes: prefer the
    // display name the proposal stored, falling back to the id for legacy cards.
    fn named<'a>(payload: &'a Value, name_key: &str, id_key: &str, fallback: &'a str) -> &'a str {
        payload[name_key].as_str().or_else(|| payload[id_key].as_str()).unwrap_or(fallback)
    }
    match kind {
        "project" if payload["action"] == "update" => format!("update project {}", named(payload, "targetName", "project", "a project")),
        "bot" if payload["action"] == "update" => format!("update bot {}", named(payload, "targetName", "blob", "a bot")),
        "task" if payload["action"] == "open" => format!("open the conversation \"{}\"", payload["title"].as_str().unwrap_or("a conversation")),
        "project" => format!("create project {}", payload["name"].as_str().unwrap_or("a project")),
        "bot" => format!("create bot {}", payload["name"].as_str().unwrap_or("a bot")),
        "task" => format!("assign a task to {}", named(payload, "botName", "bot", "a bot")),
        "permission" => format!("set a conversation's permission to {}", payload["mode"].as_str().unwrap_or("a mode")),
        "merge" => format!("merge {} into {}", payload["branch"].as_str().unwrap_or("a task branch"), payload["baseBranch"].as_str().unwrap_or("its branch")),
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
        "bot" | "project" if payload["action"] == "update" => {
            // Edited approval payloads face the same role and lock checks.
            manager_of_session(st, session_id).map_err(invalid)?;
            apply_update(st, kind, payload).await
        }
        "task" if payload["action"] == "open" => {
            manager_of_session(st, session_id).map_err(invalid)?;
            let map = payload.as_object().ok_or_else(|| invalid("Invalid open request.".into()))?;
            reject_unknown(map, &["action","conversation","title"], "open conversation").map_err(invalid)?;
            let id = required_str(map, "conversation", 80).map_err(invalid)?;
            let row = crate::team::readable_conversation(st, &id).map_err(invalid)?;
            Ok((json!({"sessionId":row["id"],"runtimeId":row["runtimeId"],"action":"open"}), "opened a conversation".into()))
        }
        "project" => apply_project(st, payload),
        "bot" => apply_bot(st, agent_id, payload).await,
        "task" => apply_task(st, session_id, payload).await,
        "permission" => apply_permission(st, agent_id, payload).await,
        "merge" => apply_merge(st, session_id, payload).await,
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
    let payload = validate_project(payload).map_err(invalid)?;
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
    if !description.is_empty() || payload["tags"] != json!([]) {
        let id = project["id"].as_str().unwrap_or("").to_owned();
        let (updated, events) = st.db.project_update(&id, &json!({"description": description, "tags":payload["tags"]})).map_err(agent_error)?;
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
    for key in ["thinking", "look", "approvalMode"] { if let Some(value) = payload.get(key) { fields[key] = value.clone(); } }
    let agent = crate::agent_create_from_rpc(st, fields).await?;
    let created_id = agent["id"].as_str().unwrap_or("").to_owned();
    let mut team_fields = json!({"tags":payload["tags"]});
    if !role.is_empty() { team_fields["role"] = json!(role); }
    if let Some(project_id) = &project_id { team_fields["projectId"] = json!(project_id); }
    if team_fields.as_object().is_some_and(|object| !object.is_empty()) {
        let (_agent, events) = st.db.agent_set_team(&created_id, &team_fields).map_err(agent_error)?;
        st.broadcast_persisted(events);
    }
    Ok((json!({"agentId": created_id, "agent": st.db.agent_get(&created_id).map_err(agent_error)?}), format!("created bot {name}")))
}

async fn apply_task(st: &AppState, session_id: &str, payload: &Value) -> Result<(Value, String), DispatchError> {
    // Cards persisted before P7 have only a brief. New tool calls require the
    // Manager-filled contract, while old approvals retain their delivery path.
    let mut compatible = payload.clone();
    if compatible.get("doneGoal").is_none() { compatible["doneGoal"] = json!("Complete the task described in the brief."); }
    if compatible.get("reportBack").is_none() { compatible["reportBack"] = json!("Report results, evidence and open questions."); }
    let payload = validate_task(&compatible).map_err(invalid)?;
    let manager = manager_of_session(st, session_id).map_err(invalid)?;
    validate_task_target(st, &manager, &payload).map_err(invalid)?;
    let bot = payload["bot"].as_str().unwrap_or("");
    // FIX39 item 19.4: the task's project decides the folder the delegated
    // conversation runs in, so the approver sees — and the daemon uses — the
    // exact place the bot may write with `auto`.
    let mut project_path = Value::Null;
    if let Some(project) = payload["project"].as_str().filter(|project| !project.is_empty()) {
        let projects = st.db.project_list().map_err(agent_error)?;
        let found = projects.iter().find(|candidate| candidate["id"].as_str() == Some(project) || candidate["name"].as_str().is_some_and(|name| name.trim().eq_ignore_ascii_case(project)));
        let found = found.ok_or_else(|| invalid(format!("No project matches \"{project}\".")))?;
        project_path = json!(found["path"].as_str().unwrap_or(""));
    }
    let brief = format!("{}\n\nDone goal:\n{}\n\nReport back:\n{}", payload["brief"].as_str().unwrap_or(""), payload["doneGoal"].as_str().unwrap_or(""), payload["reportBack"].as_str().unwrap_or(""));
    let topic = payload["topic"].as_str().filter(|topic| !topic.is_empty()).map(str::to_owned).unwrap_or_else(|| crate::team::topic_from(payload["brief"].as_str().unwrap_or("Task")));
    let delegation = crate::team::delegate_approved(st, session_id, &json!({"blob": bot, "message": brief, "projectPath": project_path,"topic":topic,"conversation":payload["conversation"],"doneGoal":payload["doneGoal"]})).await.map_err(invalid)?;
    // A replayed approval must not read as a second task: it names the assignment
    // that already exists.
    let verb = if delegation.duplicate.is_some() { "had already sent this task to" } else if delegation.started { "started a task for" } else { "queued a task for" };
    Ok((json!({"sideSessionId": delegation.side, "topic": delegation.title, "bot": delegation.target_name, "started": delegation.started, "projectPath": project_path}), format!("{verb} {}", delegation.target_name)))
}

/// Apply an approved bot permission change, identified by a side conversation. Full access is
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
    // The conversation identifies the bot; permissions apply to all its chats.
    let (_, events) = st.db.agent_update(&target_id, &json!({"approvalMode":mode})).map_err(agent_error)?;
    st.broadcast_persisted(events);
    sync_bot_permission(st,&target_id).await;
    Ok((json!({"sessionId": conversation, "approvalMode": mode}), format!("set a conversation's permission to {mode}")))
}

/// FIX39 P10: validate a merge proposal. Only the daemon creates these, but a
/// decision may carry owner edits, so every field is re-checked before git runs.
fn validate_merge(args: &Value) -> Result<Value, String> {
    let map = args.as_object().ok_or("the merge proposal must be an object.")?;
    reject_unknown(map, &["action", "worktree", "repo", "branch", "baseBranch", "baseCommit", "conversation", "botName", "taskTitle", "files", "diffSummary"], "the merge proposal")?;
    if map.get("action").is_some_and(|action| action != "merge") { return Err("Unsupported merge action.".into()); }
    let worktree = required_str(map, "worktree", 1000)?;
    let repo = required_str(map, "repo", 1000)?;
    let branch = required_str(map, "branch", 200)?;
    if !branch.starts_with("bitbots/") { return Err("That is not a Bitbots task branch.".into()); }
    let base = required_str(map, "baseBranch", 200)?;
    let base_commit = optional_str(map, "baseCommit", 100)?;
    let conversation = optional_str(map, "conversation", 80)?;
    let bot_name = optional_str(map, "botName", 80)?;
    let task_title = optional_str(map, "taskTitle", 120)?;
    let files = map.get("files").and_then(Value::as_array)
        .map(|files| files.iter().filter_map(Value::as_str).take(50).map(str::to_owned).collect::<Vec<_>>())
        .unwrap_or_default();
    let diff_summary = optional_str(map, "diffSummary", 200)?;
    Ok(json!({"action":"merge","worktree":worktree,"repo":repo,"branch":branch,"baseBranch":base,"baseCommit":base_commit,"conversation":conversation,"botName":bot_name,"taskTitle":task_title,"files":files,"diffSummary":diff_summary}))
}

/// Finish with a task copy: drop the `worktree` record from the conversation's
/// link so the same copy is not offered again, and point the conversation back at
/// the project folder. The copy's own folder is gone, so a follow-up that resumes
/// the same session must not be left aimed at a deleted folder.
fn finish_worktree(st: &AppState, conversation: &str, repo: &Path) {
    let Ok(row) = st.db.session_detail(conversation) else { return };
    let mut link = row["link"].clone();
    if let Some(object) = link.as_object_mut() { object.remove("worktree"); }
    let _ = st.db.set_session_link(conversation, &link);
    if repo.is_absolute() { let _ = st.db.set_session_project_path(conversation, &repo.to_string_lossy()); }
}

/// Remove a rejected task's copy and branch. Only reached when the owner chooses
/// Discard on the merge card. Returns whether the copy is actually gone, so a
/// locked folder is reported instead of swallowed.
async fn discard_task_copy(payload: &Value) -> bool {
    let repo = PathBuf::from(payload["repo"].as_str().unwrap_or(""));
    let worktree = PathBuf::from(payload["worktree"].as_str().unwrap_or(""));
    let branch = payload["branch"].as_str().unwrap_or("").to_owned();
    if !(repo.is_absolute() && worktree.is_absolute() && branch.starts_with("bitbots/")) { return false; }
    tokio::task::spawn_blocking(move || crate::worktree::discard(&repo, &worktree, &branch)).await.unwrap_or(false)
}

/// Apply an approved merge: commit the task copy, merge its branch into the main
/// checkout (fast-forward or a merge commit, never forced), then remove the copy
/// and branch. A dirty or mis-branched main checkout, or a conflict, leaves the
/// proposal pending so the owner can fix it and approve again.
async fn apply_merge(st: &AppState, session_id: &str, payload: &Value) -> Result<(Value, String), DispatchError> {
    manager_of_session(st, session_id).map_err(invalid)?;
    let payload = validate_merge(payload).map_err(invalid)?;
    let repo = PathBuf::from(payload["repo"].as_str().unwrap_or(""));
    let worktree = PathBuf::from(payload["worktree"].as_str().unwrap_or(""));
    if !repo.is_absolute() || !worktree.is_absolute() { return Err(invalid("The merge needs full folder paths.".into())); }
    let branch = payload["branch"].as_str().unwrap_or("").to_owned();
    let base = payload["baseBranch"].as_str().unwrap_or("").to_owned();
    // Audit F3: a task is multi-turn, so an approval can arrive mid-turn. Committing
    // then would race the bot's edits and `worktree remove --force` would fail on a
    // folder the CLI still holds open. Refuse and leave the card pending.
    let conversation = payload["conversation"].as_str().filter(|id| !id.is_empty()).map(str::to_owned);
    if let Some(conversation) = &conversation {
        if crate::team::session_busy(st, conversation).await {
            return Err(derr("conflict", "That task is still working. Approve again when it finishes.", StatusCode::CONFLICT));
        }
    }
    // A fixed, content-free commit message: the branch slug, never the task text.
    let message = format!("Bitbots task {}", branch.trim_start_matches("bitbots/"));
    let (merge_repo, merge_worktree, merge_branch, merge_base) = (repo.clone(), worktree.clone(), branch.clone(), base.clone());
    let how = tokio::task::spawn_blocking(move || {
        crate::worktree::commit_all(&merge_worktree, &message)?;
        crate::worktree::merge(&merge_repo, &merge_worktree, &merge_branch, &merge_base)
    })
    .await
    .map_err(|_| derr("internal", "The merge could not be run.", StatusCode::INTERNAL_SERVER_ERROR))?
    .map_err(|error| derr("conflict", &error, StatusCode::CONFLICT))?;
    let (cleanup_repo, cleanup_worktree, cleanup_branch) = (repo.clone(), worktree.clone(), branch.clone());
    let gone = tokio::task::spawn_blocking(move || crate::worktree::remove_after_merge(&cleanup_repo, &cleanup_worktree, &cleanup_branch)).await.unwrap_or(false);
    let files = payload["files"].as_array().map(Vec::len).unwrap_or(0);
    let mut summary = format!("merged {branch} into {base} ({how})");
    if gone {
        if let Some(conversation) = &conversation { finish_worktree(st, conversation, &repo); }
    } else {
        // Keep the record so the leftover copy and branch stay tracked; never claim
        // a cleanup that did not happen.
        summary.push_str(" · the separate copy could not be removed");
    }
    Ok((json!({"branch": branch, "repo": repo, "how": how, "files": files, "copyRemoved": gone}), summary))
}

/// FIX39 P10: run after every turn. When a side conversation that ran in its own
/// worktree finishes, the Manager proposes merging it back. A copy with no
/// changes is removed quietly instead.
pub(crate) async fn after_task_turn(st: &AppState, session_id: &str, outcome: &str) {
    if outcome != "turn.completed" { return; }
    let Ok(row) = st.db.session_detail(session_id) else { return };
    let link = row["link"].clone();
    let Some(worktree) = link.get("worktree").filter(|worktree| worktree.is_object()) else { return };
    let repo = PathBuf::from(worktree["repo"].as_str().unwrap_or(""));
    let workdir = PathBuf::from(worktree["path"].as_str().unwrap_or(""));
    let branch = worktree["branch"].as_str().unwrap_or("").to_owned();
    let base = worktree["base"].as_str().unwrap_or("").to_owned();
    let base_commit = worktree["baseCommit"].as_str().unwrap_or("").to_owned();
    if !workdir.is_dir() {
        // The copy is already gone (for example, removed by hand); just repoint the
        // conversation so a follow-up does not resume in a deleted folder.
        finish_worktree(st, session_id, &repo);
        return;
    }
    let (inspect_dir, inspect_base) = (workdir.clone(), base_commit.clone());
    let summary = match tokio::task::spawn_blocking(move || crate::worktree::inspect(&inspect_dir, &inspect_base)).await {
        Ok(Ok(summary)) => summary,
        _ => return,
    };
    if summary.files.is_empty() {
        let (discard_repo, discard_worktree, discard_branch) = (repo.clone(), workdir.clone(), branch.clone());
        let gone = tokio::task::spawn_blocking(move || crate::worktree::discard(&discard_repo, &discard_worktree, &discard_branch)).await.unwrap_or(false);
        if gone {
            finish_worktree(st, session_id, &repo);
            crate::team::note(st, session_id, "Nothing was changed, so the separate copy was removed.", json!({"kind":"worktree","direction":"discarded"})).await;
        } else {
            // Keep the record: the copy is still there and must not be forgotten.
            crate::team::note(st, session_id, "Nothing was changed, but the separate copy could not be removed.", json!({"kind":"worktree","direction":"discarded"})).await;
        }
        return;
    }
    // One offer per copy: a second completed turn does not stack another card.
    let offered = st.db.proposals_pending().unwrap_or_default().iter()
        .any(|proposal| proposal["kind"] == "merge" && proposal["payload"]["worktree"] == worktree["path"]);
    if offered { return; }
    let Some(origin) = link["originSessionId"].as_str().filter(|origin| st.db.session_exists(origin).unwrap_or(false)) else { return };
    let Ok(manager) = manager_of_session(st, origin) else { return };
    let bot_name = row["agentId"].as_str().and_then(|id| st.db.agent_get(id).ok())
        .and_then(|agent| agent["name"].as_str().map(str::to_owned)).unwrap_or_else(|| "the bot".into());
    let task_title = row["title"].as_str().unwrap_or("the task").to_owned();
    let files: Vec<Value> = summary.files.iter().take(50).map(|file| json!(file)).collect();
    let payload = json!({
        "action":"merge","worktree":worktree["path"],"repo":worktree["repo"],"branch":branch,"baseBranch":base,"baseCommit":worktree["baseCommit"],
        "conversation":session_id,"botName":bot_name,"taskTitle":task_title,"files":files,"diffSummary":summary.line(),
    });
    let title = format!("Merge \"{task_title}\" into {base}");
    let detail = Some(format!("{} · branch {branch}", summary.line()));
    let _ = create_proposal(st, origin, &manager, "merge", payload, title, detail).await;
}

async fn post_note(st: &AppState, session_id: &str, text: &str, id: &str, kind: &str, decision: &str) {
    crate::team::note(st, session_id, text, json!({"kind":"proposal","proposalId":id,"proposalKind":kind,"decision":decision})).await;
}

/// `proposal.decide { id, decision, edits? }`.
pub async fn decide(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = p["id"].as_str().map(str::trim).filter(|id| !id.is_empty()).ok_or_else(|| invalid("id is required.".into()))?;
    let _decision_guard = st.team.proposal_decision.lock().await;
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
        // FIX39 P10 audit F3: discarding a copy the task is still editing would
        // race the bot and leave an orphan folder. Refuse and leave the card
        // pending; a plain reject (keep the branch) is always allowed.
        let discarding = kind == "merge" && p["discard"].as_bool() == Some(true);
        if discarding {
            if let Some(conversation) = payload["conversation"].as_str().filter(|id| !id.is_empty()) {
                if crate::team::session_busy(st, conversation).await {
                    return Err(derr("conflict", "That task is still working. Reject again when it finishes.", StatusCode::CONFLICT));
                }
            }
        }
        if !st.db.proposal_decide(id, "rejected", None, "reject", &decided_at).map_err(agent_error)? {
            return Err(derr("conflict", "That proposal has already been decided.", StatusCode::CONFLICT));
        }
        // FIX39 P10: a rejected merge keeps the task's copy by default; the owner
        // may instead choose to discard the branch and its copy.
        let mut note = format!("Rejected: {}", describe(&kind, &payload));
        if discarding {
            if discard_task_copy(&payload).await {
                if let Some(conversation) = payload["conversation"].as_str().filter(|id| !id.is_empty()) {
                    finish_worktree(st, conversation, &PathBuf::from(payload["repo"].as_str().unwrap_or("")));
                }
            } else {
                note.push_str(" · the separate copy could not be removed");
            }
        }
        post_note(st, &session_id, &note, id, &kind, "rejected").await;
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
    // FIX39 P7 audit F4: the same mutex as `proposal.decide`, so expiring a card
    // and approving it cannot race. A decision holds it across apply and record.
    let _decision_guard = st.team.proposal_decision.lock().await;
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

fn tag_schema() -> Value { json!({"type":"array","maxItems":8,"items":{"type":"string","minLength":1,"maxLength":24}}) }

fn validated_tags(value: Option<&Value>) -> Result<Value, String> {
    let Some(value) = value else { return Ok(json!([])) };
    let tags = value.as_array().filter(|tags| tags.len() <= 8).ok_or("tags must be an array of at most 8 strings.")?;
    let mut clean = Vec::new();
    for tag in tags {
        let tag = tag.as_str().map(str::trim).filter(|tag| !tag.is_empty() && tag.chars().count() <= 24 && !tag.chars().any(char::is_control)).ok_or("Each tag must be 1 to 24 characters without controls.")?.to_lowercase();
        if tag.chars().count() > 24 { return Err("Each normalized tag must be at most 24 characters.".into()); }
        if !clean.contains(&tag) { clean.push(tag); }
    }
    Ok(json!(clean))
}

fn validate_bot_options(payload: &Value) -> Result<(), String> {
    if payload.get("approvalMode").is_some_and(|mode| !matches!(mode.as_str(), Some("ask" | "auto"))) {
        return Err("The Manager can propose ask or auto, never Full access.".into());
    }
    for key in ["model", "thinking"] {
        if let Some(value) = payload.get(key).filter(|value| !value.is_null()) {
            let text = value.as_str().filter(|text| !text.trim().is_empty() && text.chars().count() <= 200 && !text.contains('\0')).ok_or_else(|| format!("{key} must be a model/effort id or null."))?;
            if text.trim() != text { return Err(format!("{key} must not have surrounding spaces.")); }
        }
    }
    if payload.get("look").is_some_and(|look| !look.is_null() && (!look.is_object() || look.to_string().len() > 8192)) {
        return Err("look must be a small Bitbots look object or null.".into());
    }
    Ok(())
}

async fn validate_update(st: &AppState, kind: &str, args: &Value) -> Result<Value, String> {
    let map = args.as_object().ok_or("The update must be an object.")?;
    let (key, allowed): (&str, &[&str]) = if kind == "bot" {
        ("blob", &["action","targetName","blob","name","description","role","instructions","tags","look","model","thinking","approvalMode"])
    } else { ("project", &["action","targetName","project","description","tags"]) };
    reject_unknown(map, allowed, "the update")?;
    if args.get("action").is_some_and(|action| action != "update") { return Err("Unsupported update action.".into()); }
    let wanted = required_str(map, key, 200)?;
    let target = if kind == "bot" { crate::team::blob_named(st, &wanted)? } else { crate::team::project_named(st, &wanted)? };
    if kind == "bot" && crate::bot_is_locked(&target) { return Err("This bot is locked. Unlock it to change its settings.".into()); }
    let mut out = json!({"action":"update",key:target["id"]});
    for (field, limit) in [("name",40),("description",255),("role",40),("instructions",4000)] {
        if map.contains_key(field) {
            let value = if field == "name" { required_str(map,field,limit)? } else { optional_str(map,field,limit)? };
            if value.contains('\0') { return Err(format!("{field} cannot contain a null character.")); }
            out[field] = json!(value);
        }
    }
    if map.contains_key("tags") { out["tags"] = validated_tags(map.get("tags"))?; }
    for field in ["look","model","thinking","approvalMode"] { if let Some(value) = map.get(field) { out[field] = value.clone(); } }
    if out.as_object().unwrap().len() == 2 { return Err("Give at least one field to update.".into()); }
    if kind == "bot" {
        validate_bot_options(&out)?;
        let mut effective = target.clone();
        for (key,value) in out.as_object().unwrap() { effective[key] = value.clone(); }
        if map.contains_key("model") || map.contains_key("thinking") {
            crate::validate_agent_catalog(st, target["runtimeId"].as_str().unwrap_or(""), &effective).await.map_err(|error| error.1.message)?;
        }
    }
    out["targetName"] = target["name"].clone();
    Ok(out)
}

pub async fn propose_update(st: &AppState, session_id: &str, kind: &str, args: &Value) -> Result<String, String> {
    let manager = manager_of_session(st, session_id)?;
    let payload = validate_update(st, kind, args).await?;
    let id = create_proposal(st,session_id,&manager,kind,payload,format!("Update {kind} settings"),None).await?;
    Ok(waiting(&id))
}

async fn apply_update(st: &AppState, kind: &str, payload: &Value) -> Result<(Value,String), DispatchError> {
    let payload = validate_update(st, kind, payload).await.map_err(invalid)?;
    if kind == "project" {
        let id = payload["project"].as_str().unwrap();
        let mut fields = payload.clone();
        for key in ["action","targetName","project"] { fields.as_object_mut().unwrap().remove(key); }
        let (project,events) = st.db.project_update(id,&fields).map_err(agent_error)?;
        st.broadcast_persisted(events);
        return Ok((json!({"project":project}),"updated project settings".into()));
    }
    let id = payload["blob"].as_str().unwrap();
    // Both halves are validated before either is written: `validate_update` above
    // checked every listed field, including the role length and the tag shape
    // that `agent_set_team` also enforces. A failure in the second step is
    // therefore a storage error, not a validation that could have been caught.
    let mut fields = payload.clone();
    for key in ["action","targetName","blob","role","tags"] { fields.as_object_mut().unwrap().remove(key); }
    fields["agentId"] = json!(id);
    // Use the owner's normal catalog normalization and validation. Boxing the
    // RPC edge avoids the proposal -> dispatch -> proposal async type cycle.
    Box::pin(crate::dispatch(st,"agent.update",fields)).await?;
    let mut team_fields = json!({});
    for key in ["role","tags"] { if let Some(value) = payload.get(key) { team_fields[key] = value.clone(); } }
    if !team_fields.as_object().unwrap().is_empty() {
        let (_,events) = st.db.agent_set_team(id,&team_fields).map_err(agent_error)?;
        st.broadcast_persisted(events);
    }
    if payload["approvalMode"].as_str().is_some() { sync_bot_permission(st,id).await; }
    Ok((json!({"agent":st.db.agent_get(id).map_err(agent_error)?}),"updated bot settings".into()))
}

/// Permissions belong to the bot, not to a conversation (FIX39 item 16). The
/// bot's `approvalMode` is the single source of truth and is already written by
/// the caller. A conversation that pinned its own mode is released back to the
/// bot so it follows every later change; a conversation with no lock is never
/// given one (that would freeze today's model and effort and ignore the bot).
/// Editing the pins is best-effort: a failure on one chat does not undo the
/// approved bot change or fail the approval.
async fn sync_bot_permission(st: &AppState, agent_id: &str) {
    let rows = match st.db.session_list(false) { Ok(rows) => rows, Err(_) => return };
    for row in rows.iter().filter(|row| row["agentId"] == agent_id && row["link"]["kind"] != "automation") {
        let sid = row["id"].as_str().unwrap_or("");
        let Ok(detail) = st.db.session_detail(sid) else { continue };
        let Some(lock) = detail["modelLock"].as_object().filter(|lock| lock.contains_key("approvalMode")) else { continue };
        let mut lock = lock.clone();
        lock.remove("approvalMode");
        lock.remove("approvalModeSource");
        if let Ok(updated) = st.db.set_session_model_lock(sid, &Value::Object(lock)) {
            st.emit("session.changed", updated).await;
        }
    }
}

fn validate_task_target(st: &AppState, manager: &Value, payload: &Value) -> Result<(), String> {
    let target = crate::team::blob_named(st,payload["bot"].as_str().unwrap_or(""))?;
    if target["id"] == manager["id"] { return Err("You cannot delegate to yourself.".into()); }
    let project = payload["project"].as_str().filter(|p| !p.is_empty()).map(|p| crate::team::project_named(st,p)).transpose()?;
    // Any bot may be asked to work in any project; its folder is visible on the
    // approval card.
    if let Some(project) = &project {
        if !project["path"].as_str().is_some_and(|path| !path.trim().is_empty() && Path::new(path).is_dir()) {
            return Err("That project has no usable folder. Ask the owner to choose its folder before assigning work.".into());
        }
    }
    if let Some(conversation) = payload["conversation"].as_str().filter(|c| !c.is_empty()) {
        let id = crate::team::continuable(st,conversation,manager["id"].as_str().unwrap_or(""),target["id"].as_str().unwrap_or(""),target["name"].as_str().unwrap_or("bot"))?;
        if let Some(project) = project {
            if crate::team::readable_conversation(st,&id)?["projectPath"] != project["path"] { return Err("That conversation uses a different folder. Start a new topic for this project.".into()); }
        }
    }
    Ok(())
}

pub async fn propose_open(st: &AppState, session_id: &str, args: &Value) -> Result<String,String> {
    let manager = manager_of_session(st,session_id)?;
    let map = args.as_object().ok_or("The open request must be an object.")?;
    reject_unknown(map,&["conversation"],"open conversation")?;
    let id = required_str(map,"conversation",80)?;
    let row = crate::team::readable_conversation(st,&id)?;
    let payload = json!({"action":"open","conversation":id,"title":row["title"]});
    let id = create_proposal(st,session_id,&manager,"task",payload,"Open a conversation".into(),None).await?;
    Ok(waiting(&id))
}

pub async fn propose_start(st: &AppState, session_id: &str, args: &Value) -> Result<String,String> {
    let map = args.as_object().ok_or("The task must be an object.")?;
    required_str(map,"topic",60)?;
    if map.contains_key("conversation") { return Err("start_conversation starts a new topic; use message_blob to continue a conversation.".into()); }
    assign_task(st,session_id,args).await
}
