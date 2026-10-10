//! Team engine. Blobs belong to projects, carry a role, and one of them can lead.
//! Each provider session gets Bloblex's runtime instructions and an app-owned
//! MCP server (`bloblexd mcp-bridge`) with `list_blobs` and `message_blob`.
//! `message_blob` opens a side conversation with the teammate; when the
//! teammate's turn ends, its reply is relayed back into the sender's
//! conversation, which wakes the sender to report to the user.

use crate::{agent_error, derr, new_session, session_prompt, AppState, DispatchError};
use axum::http::StatusCode;
use bloblex_agent_core::{ExecOptions, McpServerSpec};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::PathBuf,
    sync::Mutex as StdMutex,
};
use tokio::sync::Mutex;

/// Longest chain of blob-to-blob hops one user request may start.
const MAX_DEPTH: u32 = 6;
pub const SERVER_NAME: &str = "bloblex";

#[derive(Default)]
pub struct Team {
    /// session id -> per-session MCP capability, and the reverse lookup.
    tokens: StdMutex<HashMap<String, String>>,
    grants: StdMutex<HashMap<String, String>>,
    pub address: StdMutex<Option<String>>,
    pub data_dir: StdMutex<Option<PathBuf>>,
    /// Hop depth of the turn currently running in a session.
    depth: StdMutex<HashMap<String, u32>>,
    /// Prompts waiting for a busy session to finish its turn.
    queued: Mutex<HashMap<String, VecDeque<Queued>>>,
}

#[derive(Clone)]
struct Queued { text: String, meta: Value, depth: u32 }

impl Team {
    fn token_for(&self, session_id: &str) -> String {
        let mut tokens = self.tokens.lock().unwrap();
        if let Some(token) = tokens.get(session_id) { return token.clone(); }
        let token = bloblex_security::new_capability();
        tokens.insert(session_id.to_owned(), token.clone());
        self.grants.lock().unwrap().insert(token.clone(), session_id.to_owned());
        token
    }
    pub fn grant(&self, token: &str) -> Option<String> {
        let grants = self.grants.lock().unwrap();
        grants.iter().find(|(candidate, _)| bloblex_security::capability_matches(candidate, token)).map(|(_, session)| session.clone())
    }
    #[cfg(test)]
    pub fn set_depth(&self, session_id: &str, depth: u32) { self.depth.lock().unwrap().insert(session_id.to_owned(), depth); }
    pub fn forget(&self, session_id: &str) {
        if let Some(token) = self.tokens.lock().unwrap().remove(session_id) { self.grants.lock().unwrap().remove(&token); }
        self.depth.lock().unwrap().remove(session_id);
    }
}

fn agent_name(agent: &Value) -> String { agent["name"].as_str().unwrap_or("A teammate").to_owned() }

fn user_name(st: &AppState) -> Option<String> {
    st.db.settings().ok().and_then(|settings| settings["profile.name"].as_str().map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned))
}

/// The folder a blob works in: its project's folder, or its own workspace.
pub fn workspace_for(st: &AppState, agent: &Value) -> PathBuf {
    if let Some(project) = agent["projectId"].as_str().and_then(|id| st.db.project_get(id).ok()) {
        if let Some(path) = project["path"].as_str().map(PathBuf::from).filter(|path| path.is_dir()) { return path; }
    }
    let base = st.team.data_dir.lock().unwrap().clone().unwrap_or_else(std::env::temp_dir);
    let dir = base.join("workspaces").join(agent["id"].as_str().unwrap_or("blob"));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Bloblex context appended to every blob session's system instructions.
pub fn runtime_instructions(st: &AppState, agent: &Value, link: &Value, workspace: &std::path::Path) -> String {
    let name = agent_name(agent);
    let mut lines = vec![format!("You are {name}, a blob: one of the user's AI teammates in Bloblex, a desktop app where several coding agents work side by side on the user's computer.")];
    if let Some(role) = agent["role"].as_str().map(str::trim).filter(|role| !role.is_empty()) { lines.push(format!("Your role: {role}.")); }
    if let Some(description) = agent["description"].as_str().map(str::trim).filter(|d| !d.is_empty()) { lines.push(format!("What you are for: {description}")); }
    lines.push(match user_name(st) {
        Some(user) => format!("The user is {user}."),
        None => "The user has not set a name; address them as the admin.".into(),
    });
    let project = agent["projectId"].as_str().and_then(|id| st.db.project_get(id).ok());
    lines.push(match project {
        Some(project) => format!("You work in the project \"{}\" at {}. Treat that folder as your workspace.", project["name"].as_str().unwrap_or("project"), workspace.display()),
        None => format!("You are a casual blob, not tied to a project. Your scratch workspace is {}; take general requests and work wherever the user points you.", workspace.display()),
    });
    if agent["leader"] == true {
        lines.push("You are the team leader. The user usually talks to you first; you coordinate the other blobs and report back.".into());
    }
    lines.push(String::new());
    lines.push("Teammates are separate agents with their own tools and memory. Use the bloblex tools: `list_blobs` shows the team (name, role, what each is for, whether they are busy); `message_blob` sends one teammate a message in a private side conversation between the two of you.".into());
    lines.push("When the user tags a blob with @Name, or asks you to hand work to someone, write that teammate a self-contained brief (they cannot see this conversation: include the goal, context, paths, constraints and what to send back) and send it with `message_blob`. Then tell the user in one short sentence who you asked and end your turn: do not wait, poll or sleep. The reply arrives later in this conversation as a message starting with \"[Reply from <name>]\". When it arrives, report to the user: what they did or found, your own verdict, and any open questions. You can follow up with the same teammate through `message_blob`.".into());
    if link["kind"] == "side" {
        let peer = link["peerName"].as_str().unwrap_or("another blob");
        lines.push(String::new());
        lines.push(format!("This is a side conversation. Messages here come from {peer}, another blob, not from the user. Do what {peer} asks and answer them directly; your final message each turn is delivered back to {peer} automatically. Keep it focused: results, evidence and open questions."));
    }
    format!("<bloblex_team>\n{}\n</bloblex_team>", lines.join("\n"))
}

/// Adds team instructions and the MCP bridge to a blob session's options.
pub fn attach(st: &AppState, session_id: &str, agent_id: Option<&str>, link: &Value, options: &mut ExecOptions) {
    let Some(agent) = agent_id.and_then(|id| st.db.agent_get(id).ok()) else { return };
    let workspace = workspace_for(st, &agent);
    let team = runtime_instructions(st, &agent, link, &workspace);
    options.instructions = Some(match options.instructions.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
        Some(own) => format!("{team}\n\n{own}"),
        None => team,
    });
    let address = st.team.address.lock().unwrap().clone();
    if let (Some(address), Ok(exe)) = (address, std::env::current_exe()) {
        let token = st.team.token_for(session_id);
        options.mcp_servers = vec![McpServerSpec {
            name: SERVER_NAME.into(),
            command: exe,
            args: vec!["mcp-bridge".into()],
            env: BTreeMap::from([("BLOBLEX_DAEMON_ADDR".to_owned(), address), ("BLOBLEX_MCP_TOKEN".to_owned(), token)]),
        }];
    }
}

fn tools() -> Value {
    json!([
        {"name":"list_blobs","description":"List your teammates in Bloblex: name, role, what each is for, project, whether they are busy, and which one is the leader.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"message_blob","description":"Send a message to one teammate in your private side conversation with them. Returns at once; their reply is delivered to you later as a message starting with \"[Reply from <name>]\". After sending, tell the user who you asked and end your turn.","inputSchema":{"type":"object","properties":{"blob":{"type":"string","description":"The teammate's name, as shown by list_blobs."},"message":{"type":"string","description":"A self-contained brief: goal, context, paths, constraints and what to send back."}},"required":["blob","message"],"additionalProperties":false}}
    ])
}

/// MCP calls from `bloblexd mcp-bridge`, authorized by a per-session token.
pub async fn mcp_rpc(st: &AppState, session_id: &str, method: &str, params: &Value) -> Result<Value, DispatchError> {
    match method {
        "mcp.tools.list" => Ok(json!({"tools":tools()})),
        "mcp.tools.call" => {
            let name = params["name"].as_str().unwrap_or("");
            let args = &params["arguments"];
            let result = match name {
                "list_blobs" => list_blobs(st, session_id).await,
                "message_blob" => message_blob(st, session_id, args).await,
                _ => Err(format!("Unknown tool {name}.")),
            };
            Ok(match result {
                Ok(text) => json!({"content":[{"type":"text","text":text}]}),
                Err(text) => json!({"content":[{"type":"text","text":text}],"isError":true}),
            })
        }
        _ => Err(derr("not_found", "unknown team method", StatusCode::NOT_FOUND)),
    }
}

async fn session_busy(st: &AppState, session_id: &str) -> bool {
    if st.active_turns.lock().await.contains_key(session_id) { return true; }
    st.db.session_state(session_id).ok().flatten().is_some_and(|state| matches!(state.as_str(), "starting" | "working" | "waiting_permission" | "cancelling"))
}

async fn list_blobs(st: &AppState, session_id: &str) -> Result<String, String> {
    let me = st.db.session_detail(session_id).ok().and_then(|row| row["agentId"].as_str().map(str::to_owned));
    let agents = st.db.agent_list(false, None).map_err(|error| error.to_string())?;
    let projects = st.db.project_list().unwrap_or_default();
    let sessions = st.db.session_list(false).unwrap_or_default();
    let runtimes = st.runtimes.read().await.clone();
    let mut rows = Vec::new();
    for agent in agents.iter().filter(|agent| agent["hidden"] != true) {
        let id = agent["id"].as_str().unwrap_or("");
        let project = agent["projectId"].as_str().and_then(|pid| projects.iter().find(|p| p["id"] == pid)).and_then(|p| p["name"].as_str()).unwrap_or("none (casual)");
        let busy = sessions.iter().any(|s| s["agentId"] == id && matches!(s["state"].as_str(), Some("working" | "starting" | "waiting_permission")));
        let provider = runtimes.iter().find(|r| r["id"] == agent["runtimeId"]).and_then(|r| r["provider"].as_str()).unwrap_or("unknown");
        let mut line = format!("- {}", agent_name(agent));
        if me.as_deref() == Some(id) { line.push_str(" (you)"); }
        if agent["leader"] == true { line.push_str(" [leader]"); }
        if let Some(role) = agent["role"].as_str().filter(|r| !r.trim().is_empty()) { line.push_str(&format!(" — {role}")); }
        line.push_str(&format!(" · {provider} · project: {project} · {}", if busy { "busy" } else { "available" }));
        if let Some(description) = agent["description"].as_str().map(str::trim).filter(|d| !d.is_empty()) { line.push_str(&format!("\n  {description}")); }
        rows.push(line);
    }
    Ok(if rows.is_empty() { "No blobs are on the team yet.".into() } else { format!("Your team:\n{}", rows.join("\n")) })
}

fn resolve_blob(agents: &[Value], wanted: &str) -> Option<Value> {
    let wanted = wanted.trim().trim_start_matches('@').to_lowercase();
    agents.iter().find(|agent| agent["id"].as_str() == Some(wanted.as_str()) || agent["name"].as_str().is_some_and(|name| name.trim().to_lowercase() == wanted)).cloned()
}

async fn message_blob(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    let message = args["message"].as_str().map(str::trim).filter(|m| !m.is_empty()).ok_or("message is required.")?.to_owned();
    if message.len() > 200_000 { return Err("The message is too long; keep briefs under 200 KB.".into()); }
    let from_row = st.db.session_detail(session_id).map_err(|_| "This conversation is no longer available.")?;
    let from_id = from_row["agentId"].as_str().ok_or("Only blob conversations can message teammates.")?.to_owned();
    let from = st.db.agent_get(&from_id).map_err(|_| "Your blob is no longer available.")?;
    let agents = st.db.agent_list(false, None).map_err(|error| error.to_string())?;
    let names = agents.iter().filter(|a| a["id"] != from_id.as_str() && a["hidden"] != true).map(agent_name).collect::<Vec<_>>().join(", ");
    let target = resolve_blob(&agents, args["blob"].as_str().unwrap_or("")).ok_or_else(|| format!("No teammate is called that. Teammates: {names}."))?;
    let target_id = target["id"].as_str().unwrap_or("").to_owned();
    if target_id == from_id { return Err("You cannot message yourself.".into()); }
    let depth = st.team.depth.lock().unwrap().get(session_id).copied().unwrap_or(0) + 1;
    if depth > MAX_DEPTH { return Err("This request has already passed between too many blobs. Report back to the user instead.".into()); }
    let from_name = agent_name(&from);
    let target_name = agent_name(&target);
    let link = json!({"kind":"side","peerAgentId":from_id,"peerName":from_name,"originSessionId":session_id});
    let side = match st.db.side_session(&target_id, &from_id).map_err(|error| error.to_string())? {
        Some(side) => { let _ = st.db.set_session_link(&side, &link); side }
        None => {
            let created = new_session(st, json!({"agentId":target_id,"projectPath":workspace_for(st, &target),"title":format!("{from_name} ⇄ {target_name}"),"link":link})).await
                .map_err(|error| format!("Could not open a conversation with {target_name}: {}", error.1.message))?;
            created["id"].as_str().unwrap_or("").to_owned()
        }
    };
    let preview = message.chars().take(280).collect::<String>();
    note(st, session_id, &preview, json!({"kind":"delegation","direction":"sent","peerAgentId":target_id,"peerName":target_name,"sideSessionId":side})).await;
    let state = st.clone();
    let side_for_task = side.clone();
    tokio::spawn(async move {
        deliver(&state, &side_for_task, message, json!({"kind":"blob_message","fromAgentId":from_id,"fromName":from_name}), depth).await;
    });
    Ok(format!("Sent to {target_name}. They are working on it in your side conversation; their reply will arrive here as a message starting with \"[Reply from {target_name}]\". Tell the user you asked {target_name} and end your turn now."))
}

/// A visible note in a conversation that is not a prompt (e.g. "Messaged Codex").
async fn note(st: &AppState, session_id: &str, content: &str, meta: Value) {
    if let Ok(message) = st.db.append_message_with_data(session_id, "", "notice", content, &json!({"meta":meta})) {
        if !message.is_null() {
            st.emit("message.completed", json!({"sessionId":session_id,"messageId":message["id"],"role":"notice","message":message})).await;
        }
    }
}

/// Prompts a session now, or queues the prompt until its current turn ends.
async fn deliver(st: &AppState, session_id: &str, text: String, meta: Value, depth: u32) {
    if session_busy(st, session_id).await {
        st.team.queued.lock().await.entry(session_id.to_owned()).or_default().push_back(Queued { text, meta, depth });
        return;
    }
    st.team.depth.lock().unwrap().insert(session_id.to_owned(), depth);
    if let Err(error) = session_prompt(st, json!({"sessionId":session_id,"text":text.clone(),"meta":meta.clone()})).await {
        if error.1.code == "conflict" {
            st.team.queued.lock().await.entry(session_id.to_owned()).or_default().push_front(Queued { text, meta, depth });
        } else {
            st.team.depth.lock().unwrap().remove(session_id);
            relay_failure(st, session_id, &error.1.message).await;
        }
    }
}

/// When a side conversation cannot even start a turn, tell the sender.
async fn relay_failure(st: &AppState, side_session: &str, reason: &str) {
    let Ok(row) = st.db.session_detail(side_session) else { return };
    let link = &row["link"];
    let Some(origin) = link["originSessionId"].as_str() else { return };
    let name = row["agentId"].as_str().and_then(|id| st.db.agent_get(id).ok()).map(|a| agent_name(&a)).unwrap_or_else(|| "The teammate".into());
    note(st, origin, &format!("{name} could not start: {reason}"), json!({"kind":"delegation","direction":"failed","peerAgentId":row["agentId"],"peerName":name,"sideSessionId":side_session})).await;
}

/// Runs after every turn: relays side-conversation replies and drains queues.
pub fn after_turn(st: &AppState, session_id: &str, turn: Option<String>, outcome: &str, detail: Option<String>) {
    let st = st.clone();
    let session_id = session_id.to_owned();
    let outcome = outcome.to_owned();
    tokio::spawn(async move {
        let depth = st.team.depth.lock().unwrap().remove(&session_id).unwrap_or(0);
        if let Ok(row) = st.db.session_detail(&session_id) {
            let link = row["link"].clone();
            if link["kind"] == "side" {
                if let Some(origin) = link["originSessionId"].as_str().filter(|origin| st.db.session_exists(origin).unwrap_or(false)) {
                    let target_id = row["agentId"].as_str().unwrap_or("").to_owned();
                    let name = st.db.agent_get(&target_id).map(|a| agent_name(&a)).unwrap_or_else(|_| "Teammate".into());
                    let reply = match outcome.as_str() {
                        "turn.completed" => turn.as_deref().and_then(|turn| st.db.turn_reply(&session_id, turn).ok().flatten()).unwrap_or_else(|| "(finished without a text reply)".into()),
                        "turn.cancelled" => "The task was cancelled before it finished.".into(),
                        _ => format!("The turn failed: {}", detail.unwrap_or_else(|| "the provider reported an error".into())),
                    };
                    let text = format!("[Reply from {name}]\n{reply}");
                    deliver(&st, origin, text, json!({"kind":"blob_reply","fromAgentId":target_id,"fromName":name,"sideSessionId":session_id}), depth).await;
                }
            }
        }
        let next = st.team.queued.lock().await.get_mut(&session_id).and_then(VecDeque::pop_front);
        if let Some(next) = next { deliver(&st, &session_id, next.text, next.meta, next.depth).await; }
    });
}

/// A blob's single main conversation, created on first open in its workspace.
pub async fn agent_conversation(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let agent_id = p["agentId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "agentId is required", StatusCode::BAD_REQUEST))?;
    let agent = st.db.agent_get(agent_id).map_err(agent_error)?;
    if agent["archived"] == true { return Err(derr("conflict", "archived blobs have no conversation", StatusCode::CONFLICT)); }
    if let Some(id) = st.db.main_session(agent_id).map_err(agent_error)? {
        return Ok(json!({"session": st.db.session_detail(&id).map_err(agent_error)?, "created": false}));
    }
    let created = new_session(st, json!({"agentId":agent_id,"projectPath":workspace_for(st, &agent),"title":agent_name(&agent)})).await?;
    let id = created["id"].as_str().unwrap_or("");
    Ok(json!({"session": st.db.session_detail(id).map_err(agent_error)?, "created": true}))
}

pub async fn team_rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "project.list" => Ok(json!({"projects": st.db.project_list().map_err(agent_error)?})),
        "project.create" => {
            let (project, events) = st.db.project_create(p["name"].as_str().unwrap_or(""), p["path"].as_str()).map_err(agent_error)?;
            st.broadcast_persisted(events);
            Ok(json!({"project": project}))
        }
        "project.update" => {
            let id = p["projectId"].as_str().unwrap_or("");
            let (project, events) = st.db.project_update(id, p).map_err(agent_error)?;
            st.broadcast_persisted(events);
            Ok(json!({"project": project}))
        }
        "project.delete" => {
            let events = st.db.project_delete(p["projectId"].as_str().unwrap_or("")).map_err(agent_error)?;
            st.broadcast_persisted(events);
            Ok(json!({"deleted": true}))
        }
        "agent.team.update" => {
            let id = p["agentId"].as_str().unwrap_or("");
            let before = st.db.agent_get(id).map_err(agent_error)?;
            let (agent, events) = st.db.agent_set_team(id, p).map_err(agent_error)?;
            st.broadcast_persisted(events);
            // A blob that moves to another project starts a fresh conversation there.
            if before["projectId"] != agent["projectId"] {
                if let Ok(Some(main)) = st.db.main_session(id) {
                    if !session_busy(st, &main).await {
                        if let Ok(session) = st.db.session_archive(&main, true) { st.emit("session.changed", session).await; }
                    }
                }
            }
            Ok(json!({"agent": agent}))
        }
        "agent.conversation" => agent_conversation(st, p).await,
        _ => Err(derr("not_found", "unknown method", StatusCode::NOT_FOUND)),
    }
}
