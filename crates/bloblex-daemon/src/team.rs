//! Team engine. Blobs belong to projects, carry a role, and one of them can lead.
//! Each provider session gets Bloblex's runtime instructions and an app-owned
//! MCP server (`bloblexd mcp-bridge`) with `list_blobs`, `list_conversations`
//! and `message_blob`. `message_blob` opens a side conversation with the
//! teammate, titled by its topic, or continues an earlier one; when the
//! teammate's turn ends, its reply is relayed back into the sender's
//! conversation, which wakes the sender to report to the user.

use crate::{agent_create_from_rpc, agent_error, derr, new_session, AppState, DispatchError};
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
    /// Blobs the leader created in the current turn, per session (rate limit).
    created: StdMutex<HashMap<String, u32>>,
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
    #[cfg(test)]
    pub(crate) fn token_for_test(&self, session_id: &str) -> String { self.token_for(session_id) }
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
    #[cfg(test)]
    pub(crate) async fn enqueue_for_test(&self, session_id: &str, text: &str) {
        self.queued.lock().await.entry(session_id.to_owned()).or_default().push_back(Queued { text: text.to_owned(), meta: json!({}), depth: 0 });
    }
    #[cfg(test)]
    pub(crate) async fn queued_len(&self, session_id: &str) -> usize {
        self.queued.lock().await.get(session_id).map_or(0, VecDeque::len)
    }
    fn creations(&self, session_id: &str) -> u32 { self.created.lock().unwrap().get(session_id).copied().unwrap_or(0) }
    fn record_creation(&self, session_id: &str) { *self.created.lock().unwrap().entry(session_id.to_owned()).or_insert(0) += 1; }
    fn clear_creations(&self, session_id: &str) { self.created.lock().unwrap().remove(session_id); }
}

fn agent_name(agent: &Value) -> String { agent["name"].as_str().unwrap_or("A teammate").to_owned() }

fn user_name(st: &AppState) -> Option<String> {
    st.db.settings().ok().and_then(|settings| settings["profile.name"].as_str().map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned))
}

fn profile_about(st: &AppState) -> Option<String> {
    st.db.settings().ok().and_then(|settings| settings["profile.about"].as_str().map(str::trim).filter(|about| !about.is_empty()).map(str::to_owned))
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
    if let Some(about) = profile_about(st) {
        lines.push(format!("About the user (from their own notes): {about}"));
    }
    let project = agent["projectId"].as_str().and_then(|id| st.db.project_get(id).ok());
    lines.push(match project {
        Some(project) => format!("You work in the project \"{}\" at {}. Treat that folder as your workspace.", project["name"].as_str().unwrap_or("project"), workspace.display()),
        None => format!("You are a casual blob, not tied to a project. Your scratch workspace is {}; take general requests and work wherever the user points you.", workspace.display()),
    });
    if agent["leader"] == true {
        lines.push("You are the team leader. The user usually talks to you first; you coordinate the other blobs and report back.".into());
        lines.push("You are the only blob who can create teammates. When the user asks for a new bot or a team, use `create_blob`: call `list_blobs` and `list_projects` first to avoid duplicates and to pick the right project, read the project folder or its description yourself to decide which roles fit, then create at most a handful. Give each a distinct short name, a role such as CTO, one sentence of purpose, and instructions describing its working style. Afterwards, tell the user who was created and where.".into());
    } else {
        match st.db.leader_agent().ok().flatten() {
            Some(leader) => lines.push(format!("You cannot create or change blobs; only the team leader can. If the user asks you to, say so briefly and tag the leader as @{} so the user can ask them.", agent_name(&leader))),
            None => lines.push("You cannot create or change blobs; only the team leader can. If the user asks you to, say so briefly and tell the user they need to set a team leader.".into()),
        }
    }
    lines.push(String::new());
    lines.push("Teammates are separate agents with their own tools and memory. Use the bloblex tools: `list_blobs` shows the team (name, role, what each is for, whether they are busy); `message_blob` sends one teammate a message in a private side conversation between the two of you; `list_conversations` lists your side conversations, each with a short topic.".into());
    lines.push("When the user tags a blob with @Name, or asks you to hand work to someone, write that teammate a self-contained brief (they cannot see this conversation: include the goal, context, paths, constraints and what to send back) and send it with `message_blob`. Then tell the user in one short sentence who you asked and end your turn: do not wait, poll or sleep. The reply arrives later in this conversation as a message starting with \"[Reply from <name>]\". When it arrives, report to the user: what they did or found, your own verdict, and any open questions.".into());
    lines.push("Each side conversation has a topic, like a chat title. Before messaging a teammate, check `list_conversations`: if one you started with them is about the same subject, continue it by passing its id as `conversation` (they keep the context there). Otherwise start a new one and give it a short `topic` of 3 to 6 words. When the user references a conversation with #, continue that one.".into());
    if link["kind"] == "side" {
        let peer = link["peerName"].as_str().unwrap_or("another blob");
        lines.push(String::new());
        lines.push(format!("This is a side conversation. Messages here come from {peer}, another blob, not from the user. Do what {peer} asks and answer them directly; your final message each turn is delivered back to {peer} automatically. Keep it focused: results, evidence and open questions."));
        if let Some(topic) = link["topic"].as_str().filter(|topic| !topic.trim().is_empty()) { lines.push(format!("Topic of this conversation: {topic}.")); }
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

/// The tool list for a session. Automation-run sessions get no team or
/// scheduling tools (recursion guard): they must not message teammates, create
/// conversations or schedule anything. Memory tools are only listed while
/// `experimental.memory` is on; automation runs may keep memory tools but the
/// write rails restrict them to blob scope.
fn tools(is_automation: bool, memory_enabled: bool, ask_user: bool, is_leader: bool) -> Value {
    let memory = if memory_enabled { crate::memory::tool_schemas() } else { Vec::new() };
    if is_automation {
        return json!(memory);
    }
    let mut list: Vec<Value> = vec![
        json!({"name":"list_blobs","description":"List your teammates in Bloblex: name, role, what each is for, project, whether they are busy, and which one is the leader.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"list_conversations","description":"List your side conversations with teammates, newest first: id, topic, teammate, who started it, size and the latest reply. Use it to find a conversation to continue.","inputSchema":{"type":"object","properties":{"blob":{"type":"string","description":"Only conversations with this teammate (optional)."}},"additionalProperties":false}}),
        json!({"name":"message_blob","description":"Send a message to one teammate in a private side conversation. Continue an earlier conversation you started by passing its id as `conversation`, or start a new one with a short `topic`. Returns at once; their reply is delivered to you later as a message starting with \"[Reply from <name>]\". After sending, tell the user who you asked and end your turn.","inputSchema":{"type":"object","properties":{"blob":{"type":"string","description":"The teammate's name, as shown by list_blobs."},"message":{"type":"string","description":"A self-contained brief: goal, context, paths, constraints and what to send back."},"topic":{"type":"string","description":"For a new conversation: a short title of 3 to 6 words, like a chat title."},"conversation":{"type":"string","description":"The id of a conversation you started with this teammate, from list_conversations, to continue it."}},"required":["blob","message"],"additionalProperties":false}}),
        json!({"name":"schedule_task","description":"Propose a scheduled task for your blob. It is created disabled and will never run until the user approves it in Bloblex. Use this only when the user asks for something recurring or at a set time.","inputSchema":{"type":"object","properties":{"name":{"type":"string","description":"A short title, 1 to 80 characters."},"prompt":{"type":"string","description":"The instruction to run unattended when the task fires."},"when":{"type":"object","description":"A schedule object: {\"kind\":\"once\",\"at\":\"<RFC3339>\"} or {\"kind\":\"cron\",\"cron\":\"m h dom mon dow\",\"timezone\":\"Area/City\"}."}},"required":["name","prompt","when"],"additionalProperties":false}}),
        json!({"name":"list_my_schedules","description":"List this blob's scheduled tasks, whether each is enabled, and when it next runs.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
    ];
    // Only the team leader may create or change blobs.
    if is_leader {
        list.push(json!({"name":"list_projects","description":"List the projects a blob can belong to: id, name, folder and description. Call it before create_blob to attach a new blob to the right project.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}));
        list.push(json!({"name":"create_blob","description":"Create a new blob (an AI teammate) on the team. Only the team leader may create blobs. Give a short unique name, an optional role, a one-sentence purpose and instructions describing how it should work. The new blob inherits a safe permission mode; it is never the leader.","inputSchema":{"type":"object","properties":{"name":{"type":"string","description":"A short unique name, 1 to 40 characters."},"role":{"type":"string","description":"A role label such as CTO (optional, up to 40 characters)."},"description":{"type":"string","description":"What this blob is for, up to 255 characters (optional)."},"instructions":{"type":"string","description":"Persona and working style, up to 4000 characters (optional)."},"project":{"type":"string","description":"A project id or exact project name to attach the blob to (optional; absent makes a casual blob)."},"provider":{"type":"string","description":"claude, codex or opencode (optional; defaults to the leader's own runtime)."},"model":{"type":"string","description":"A model id from that runtime's catalog (optional)."},"thinking":{"type":"string","description":"An effort level supported by the chosen model (optional)."}},"required":["name"],"additionalProperties":false}}));
        list.push(json!({"name":"update_blob","description":"Update an existing blob's role, description or instructions. Only the team leader may change blobs; it cannot change a blob's runtime, permission mode, project or leader flag, and cannot archive or delete one.","inputSchema":{"type":"object","properties":{"blob":{"type":"string","description":"The blob's name or id."},"role":{"type":"string","description":"A new role label (optional, up to 40 characters)."},"description":{"type":"string","description":"A new purpose (optional, up to 255 characters)."},"instructions":{"type":"string","description":"New instructions (optional, up to 4000 characters)."}},"required":["blob"],"additionalProperties":false}}));
    }
    // OpenCode has no native question tool over ACP, so the bridge offers one.
    if ask_user { list.push(crate::questions::tool_schema()); }
    list.extend(memory);
    json!(list)
}

/// MCP calls from `bloblexd mcp-bridge`, authorized by a per-session token.
pub async fn mcp_rpc(st: &AppState, session_id: &str, method: &str, params: &Value) -> Result<Value, DispatchError> {
    // Recursion guard: a session linked to an automation run can neither use
    // team/scheduling tools nor reach any automation write RPC. Memory tools
    // are allowed, but only while the feature is on and only blob scope.
    let session = st.db.session_detail(session_id).ok();
    let is_automation = session.as_ref().map(|row| row["link"]["kind"] == "automation").unwrap_or(false);
    // `ask_user` exists only where the provider has no native question tool:
    // OpenCode main conversations, never automation runs or side conversations.
    let ask_user = session.as_ref().is_some_and(|row| {
        row["archived"] != true
            && row["provider"].as_str() == Some("opencode")
            && !matches!(row["link"]["kind"].as_str(), Some("side" | "automation"))
    });
    let memory_enabled = crate::memory::enabled(st);
    if is_automation && method.starts_with("automation.") {
        return Err(derr("forbidden", "Automation runs cannot change automations.", StatusCode::FORBIDDEN));
    }
    // Blob creation is reserved for the leader's own blob. Side conversations
    // of the leader are allowed (the session's agent is the leader); automation
    // sessions never reach here.
    let is_leader = session.as_ref().is_some_and(|row| {
        row["agentId"].as_str().is_some_and(|id| st.db.agent_get(id).is_ok_and(|agent| agent["leader"] == true && agent["archived"] != true))
    });
    match method {
        "mcp.tools.list" => Ok(json!({"tools":tools(is_automation, memory_enabled, ask_user, is_leader)})),
        "mcp.tools.call" => {
            let name = params["name"].as_str().unwrap_or("");
            if is_automation && !name.starts_with("memory_") {
                return Err(derr("forbidden", "Automation runs cannot use team or scheduling tools.", StatusCode::FORBIDDEN));
            }
            let args = &params["arguments"];
            let result = match name {
                "list_blobs" => list_blobs(st, session_id).await,
                "list_conversations" => list_conversations(st, session_id, args).await,
                "message_blob" => message_blob(st, session_id, args).await,
                "list_projects" if is_leader => list_projects(st).await,
                "create_blob" if is_leader => create_blob(st, session_id, args).await,
                "update_blob" if is_leader => update_blob(st, args).await,
                "list_projects" | "create_blob" | "update_blob" => Err(non_leader_create_error(st)),
                "schedule_task" => crate::automations::schedule_task_tool(st, session_id, args).await,
                "list_my_schedules" => crate::automations::list_my_schedules_tool(st, session_id).await,
                "ask_user" if ask_user => crate::questions::ask_user_tool(st, session_id, args).await,
                "ask_user" => Err("ask_user is only available to OpenCode main conversations.".into()),
                "memory_search" if memory_enabled => crate::memory::tool_search(st, session_id, args).await,
                "memory_get" if memory_enabled => crate::memory::tool_get(st, session_id, args).await,
                "memory_write" if memory_enabled => crate::memory::tool_write(st, session_id, args).await,
                "memory_update" if memory_enabled => crate::memory::tool_update(st, session_id, args).await,
                "memory_forget" if memory_enabled => crate::memory::tool_forget(st, session_id, args).await,
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

pub(crate) async fn session_busy(st: &AppState, session_id: &str) -> bool {
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

/// A bounded, trimmed string tool argument. `None` when absent or empty.
fn bounded_text(args: &Value, key: &str, limit: usize) -> Result<Option<String>, String> {
    let Some(value) = args.get(key) else { return Ok(None) };
    let Some(text) = value.as_str() else { return Err(format!("{key} must be a string.")) };
    let text = text.trim();
    if text.is_empty() { return Ok(None); }
    if text.chars().count() > limit { return Err(format!("{key} must be at most {limit} characters.")); }
    Ok(Some(text.to_owned()))
}

/// The error a non-leader gets when it tries to create or change blobs.
fn non_leader_create_error(st: &AppState) -> String {
    match st.db.leader_agent().ok().flatten() {
        Some(leader) => { let name = agent_name(&leader); format!("Only the team leader ({name}) can create blobs. Ask the user to tag @{name}.") }
        None => "Only the team leader can create blobs, and this team has no leader yet. Ask the user to set one.".into(),
    }
}

/// Leader-only: projects a blob can be attached to.
async fn list_projects(st: &AppState) -> Result<String, String> {
    let projects = st.db.project_list().map_err(|error| error.to_string())?;
    if projects.is_empty() { return Ok("No projects exist yet. Create one in Bloblex, or create a casual blob with no project.".into()); }
    let rows = projects.iter().map(|project| {
        let name = project["name"].as_str().unwrap_or("Project");
        let id = project["id"].as_str().unwrap_or("");
        let path = project["path"].as_str().map(str::trim).filter(|path| !path.is_empty()).unwrap_or("(no folder)");
        let mut line = format!("- {name} (id {id}) · {path}");
        if let Some(description) = project["description"].as_str().map(str::trim).filter(|d| !d.is_empty()) { line.push_str(&format!("\n  {description}")); }
        line
    }).collect::<Vec<_>>();
    Ok(format!("Projects you can attach a blob to:\n{}", rows.join("\n")))
}

/// Leader-only: create a blob through the same path as the `agent.create` RPC.
async fn create_blob(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    let leader_id = st.db.session_detail(session_id).ok().and_then(|row| row["agentId"].as_str().map(str::to_owned)).ok_or("Only a blob conversation can create blobs.")?;
    let leader = st.db.agent_get(&leader_id).map_err(|_| "Your blob is no longer available.")?;
    if leader["leader"] != true || leader["archived"] == true { return Err(non_leader_create_error(st)); }
    let name = bounded_text(args, "name", 40)?.ok_or("name is required.")?;
    if name.chars().count() < 1 { return Err("name is required.".into()); }
    let role = bounded_text(args, "role", 40)?;
    let description = bounded_text(args, "description", 255)?;
    let instructions = bounded_text(args, "instructions", 4000)?;
    let agents = st.db.agent_list(false, None).map_err(|error| error.to_string())?;
    if agents.len() >= 12 { return Err(format!("The team already has {} blobs; Bloblex allows at most 12. Archive one before creating another.", agents.len())); }
    if st.team.creations(session_id) >= 5 { return Err("You have already created 5 blobs this turn. Ask the user before creating more.".into()); }
    if agents.iter().any(|agent| agent["name"].as_str().map(str::trim).map(str::to_lowercase).is_some_and(|existing| existing == name.to_lowercase())) {
        return Err(format!("A blob named {name} already exists. Choose a different name."));
    }
    let project_id = match args["project"].as_str().map(str::trim).filter(|project| !project.is_empty()) {
        None => None,
        Some(wanted) => {
            let projects = st.db.project_list().map_err(|error| error.to_string())?;
            match projects.iter().find(|project| project["id"].as_str() == Some(wanted) || project["name"].as_str().is_some_and(|project_name| project_name.trim() == wanted)) {
                Some(project) => project["id"].as_str().map(str::to_owned),
                None => {
                    let names = projects.iter().filter_map(|project| project["name"].as_str()).collect::<Vec<_>>().join(", ");
                    return Err(format!("No project matches \"{wanted}\". Available projects: {}.", if names.is_empty() { "none" } else { &names }));
                }
            }
        }
    };
    let runtimes = st.runtimes.read().await.clone();
    let runtime = match args["provider"].as_str().map(str::trim).filter(|provider| !provider.is_empty()) {
        Some(provider) => {
            if !["claude", "codex", "opencode"].contains(&provider) { return Err(format!("provider must be claude, codex or opencode; got \"{provider}\".")); }
            runtimes.iter().find(|runtime| runtime["provider"] == provider).cloned().ok_or_else(|| format!("No {provider} runtime is installed."))?
        }
        None => {
            let runtime_id = leader["runtimeId"].as_str().ok_or("Your blob has no runtime.")?;
            runtimes.iter().find(|runtime| runtime["id"] == runtime_id).cloned().ok_or("Your runtime is not available.")?
        }
    };
    let provider = runtime["provider"].as_str().unwrap_or("unknown").to_owned();
    // Created blobs inherit a safe mode: never bypass, and auto only when the
    // leader's own effective mode is auto.
    let approval = if leader["effectiveApprovalMode"].as_str() == Some("auto") { "auto" } else { "ask" };
    let mut fields = json!({"name":name,"runtimeId":runtime["id"],"approvalMode":approval});
    if let Some(description) = &description { fields["description"] = json!(description); }
    if let Some(instructions) = &instructions { fields["instructions"] = json!(instructions); }
    if let Some(model) = args["model"].as_str().map(str::trim).filter(|model| !model.is_empty()) { fields["model"] = json!(model); }
    if let Some(thinking) = args["thinking"].as_str().map(str::trim).filter(|thinking| !thinking.is_empty()) { fields["thinking"] = json!(thinking); }
    let agent = agent_create_from_rpc(st, fields).await.map_err(|error| error.1.message)?;
    let agent_id = agent["id"].as_str().unwrap_or("").to_owned();
    if role.is_some() || project_id.is_some() {
        let mut team_fields = json!({});
        if let Some(role) = &role { team_fields["role"] = json!(role); }
        if let Some(project_id) = &project_id { team_fields["projectId"] = json!(project_id); }
        let (_agent, events) = st.db.agent_set_team(&agent_id, &team_fields).map_err(|error| error.to_string())?;
        st.broadcast_persisted(events);
    }
    st.team.record_creation(session_id);
    let role_label = role.as_deref().unwrap_or("no role");
    let project_label = project_id.as_deref().and_then(|id| st.db.project_get(id).ok()).and_then(|project| project["name"].as_str().map(str::to_owned)).unwrap_or_else(|| "no project".into());
    note(st, session_id, &format!("Created blob {name} ({role_label}) in {project_label}."), json!({"kind":"blob_created","agentId":agent_id,"name":name})).await;
    let role_part = role.as_deref().map(|role| format!(" ({role})")).unwrap_or_default();
    let project_part = if project_label == "no project" { " as a casual blob".into() } else { format!(" in {project_label}") };
    Ok(format!("Created blob {name}{role_part}{project_part} on {provider}. Tell the user who was created and where."))
}

/// Leader-only: update a blob's role, purpose or instructions (never its
/// runtime, mode, project, leader flag, archive or deletion).
async fn update_blob(st: &AppState, args: &Value) -> Result<String, String> {
    let wanted = args["blob"].as_str().map(str::trim).filter(|blob| !blob.is_empty()).ok_or("blob is required.")?;
    let role = bounded_text(args, "role", 40)?;
    let description = bounded_text(args, "description", 255)?;
    let instructions = bounded_text(args, "instructions", 4000)?;
    if role.is_none() && description.is_none() && instructions.is_none() { return Err("Give at least one of role, description or instructions to update.".into()); }
    let agents = st.db.agent_list(false, None).map_err(|error| error.to_string())?;
    let target = resolve_blob(&agents, wanted).ok_or_else(|| format!("No blob is called {wanted}."))?;
    let target_id = target["id"].as_str().unwrap_or("").to_owned();
    if let Some(role) = &role {
        let (_agent, events) = st.db.agent_set_team(&target_id, &json!({"role":role})).map_err(|error| error.to_string())?;
        st.broadcast_persisted(events);
    }
    if description.is_some() || instructions.is_some() {
        let mut fields = json!({});
        if let Some(description) = &description { fields["description"] = json!(description); }
        if let Some(instructions) = &instructions { fields["instructions"] = json!(instructions); }
        let (_agent, events) = st.db.agent_update(&target_id, &fields).map_err(|error| error.to_string())?;
        st.broadcast_persisted(events);
    }
    Ok(format!("Updated blob {}.", target["name"].as_str().unwrap_or(wanted)))
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
    let topic = args["topic"].as_str().and_then(clean_topic);
    let wanted = args["conversation"].as_str().map(str::trim).filter(|id| !id.is_empty());
    let existing = match wanted {
        Some(id) => Some(continuable(st, id, &from_id, &target_id, &target_name)?),
        // Without a topic or an id, keep talking in the latest conversation with them.
        None if topic.is_none() => st.db.side_session(&target_id, &from_id).map_err(|error| error.to_string())?,
        None => None,
    };
    let (side, title) = match existing {
        Some(side) => {
            let row = st.db.session_detail(&side).map_err(|error| error.to_string())?;
            let mut link = row["link"].clone();
            link["peerName"] = json!(from_name);
            link["originSessionId"] = json!(session_id);
            let _ = st.db.set_session_link(&side, &link);
            (side, row["title"].as_str().unwrap_or("").to_owned())
        }
        None => {
            let title = topic.unwrap_or_else(|| topic_from(&message));
            let link = json!({"kind":"side","peerAgentId":from_id,"peerName":from_name,"originSessionId":session_id,"topic":title});
            let created = new_session(st, json!({"agentId":target_id,"projectPath":workspace_for(st, &target),"title":title,"link":link})).await
                .map_err(|error| format!("Could not open a conversation with {target_name}: {}", error.1.message))?;
            (created["id"].as_str().unwrap_or("").to_owned(), title)
        }
    };
    let preview = message.chars().take(280).collect::<String>();
    note_above_turn_text(st, session_id, &preview, json!({"kind":"delegation","direction":"sent","peerAgentId":target_id,"peerName":target_name,"sideSessionId":side,"topic":title})).await;
    let state = st.clone();
    let side_for_task = side.clone();
    tokio::spawn(async move {
        deliver(&state, &side_for_task, message, json!({"kind":"blob_message","fromAgentId":from_id,"fromName":from_name}), depth).await;
    });
    Ok(format!("Sent to {target_name} in \"{title}\" (conversation {side}). They are working on it; their reply will arrive here as a message starting with \"[Reply from {target_name}]\". Tell the user you asked {target_name} and end your turn now."))
}

/// A conversation id the sender may continue: one they started with this teammate.
fn continuable(st: &AppState, id: &str, from_id: &str, target_id: &str, target_name: &str) -> Result<String, String> {
    let row = st.db.session_detail(id).map_err(|_| format!("No conversation has the id {id}. Call list_conversations to see yours."))?;
    let link = &row["link"];
    if link["kind"] != "side" || row["archived"] == true { return Err(format!("{id} is not an open side conversation. Call list_conversations to see yours.")); }
    let title = row["title"].as_str().unwrap_or("that conversation");
    if row["agentId"] == target_id && link["peerAgentId"] == from_id { return Ok(id.to_owned()); }
    if row["agentId"] == from_id && link["peerAgentId"] == target_id {
        return Err(format!("{target_name} started \"{title}\" with you, and your final message there goes back to them automatically. To ask {target_name} something, continue a conversation you started or start a new one with a topic."));
    }
    Err(format!("\"{title}\" is not a conversation between you and {target_name}."))
}

/// A topic the sender gave, tidied: no quotes or leading #, at most 60 characters.
fn clean_topic(raw: &str) -> Option<String> {
    let topic = raw.trim().trim_matches(|c| c == '"' || c == '\'' || c == '#').trim();
    (!topic.is_empty()).then(|| topic.chars().take(60).collect())
}

/// A title for a conversation started without a topic: the brief's first words.
fn topic_from(message: &str) -> String {
    let line = message.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("Conversation");
    let words = line.split_whitespace().take(7).collect::<Vec<_>>().join(" ");
    let mut topic = words.trim_end_matches(|c: char| ",.;:!?".contains(c)).to_owned();
    if topic.chars().count() > 48 { topic = topic.chars().take(47).collect::<String>() + "…"; }
    if topic.is_empty() { "Conversation".into() } else { topic }
}

fn one_line(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > limit { flat.chars().take(limit - 1).collect::<String>() + "…" } else { flat }
}

async fn list_conversations(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    let me = st.db.session_detail(session_id).ok().and_then(|row| row["agentId"].as_str().map(str::to_owned)).ok_or("Only blob conversations have side conversations.")?;
    let agents = st.db.agent_list(true, None).map_err(|error| error.to_string())?;
    let only = args["blob"].as_str().map(str::trim).filter(|name| !name.is_empty()).map(|name| resolve_blob(&agents, name).ok_or_else(|| format!("No teammate is called {name}."))).transpose()?;
    let name_of = |id: &str| agents.iter().find(|agent| agent["id"] == id).map(agent_name).unwrap_or_else(|| "A former teammate".into());
    let mut rows = Vec::new();
    for row in st.db.side_conversations(&me).map_err(|error| error.to_string())? {
        let id = row["id"].as_str().unwrap_or("");
        let mine = row["peerAgentId"] == me.as_str();
        let other = if mine { row["agentId"].as_str().unwrap_or("") } else { row["peerAgentId"].as_str().unwrap_or("") };
        if only.as_ref().is_some_and(|agent| agent["id"] != other) { continue; }
        let when = row["updatedAt"].as_str().unwrap_or("").get(..16).unwrap_or("").replace('T', " ");
        let mut line = format!("- {id} · \"{}\" with {} · {} · {} messages · last active {when} UTC", row["title"].as_str().unwrap_or("Conversation"), name_of(other), if mine { "you started it" } else { "they started it" }, row["messages"]);
        if let Some(reply) = st.db.last_reply(id).ok().flatten() { line.push_str(&format!("\n  Latest reply: {}", one_line(&reply, 180))); }
        rows.push(line);
        if rows.len() >= 15 { break; }
    }
    if rows.is_empty() { return Ok("You have no side conversations yet. Start one with message_blob and a short topic.".into()); }
    Ok(format!("Your side conversations, newest first:\n{}\n\nTo continue one you started, call message_blob with its id as `conversation`. Conversations a teammate started with you are answered automatically when they message you.", rows.join("\n")))
}

/// Context for side conversations the user referenced with # in a prompt.
/// Returns the text appended to the prompt the blob receives, and the
/// references kept on the stored message (the visible text stays as typed).
pub fn reference_context(st: &AppState, session_id: &str, refs: &Value) -> Option<(String, Value)> {
    let ids = refs.as_array()?.iter().filter_map(Value::as_str).take(5).collect::<Vec<_>>();
    if ids.is_empty() { return None; }
    let me = st.db.session_detail(session_id).ok()?["agentId"].as_str()?.to_owned();
    let agents = st.db.agent_list(true, None).ok()?;
    let name_of = |id: &str| agents.iter().find(|agent| agent["id"] == id).map(agent_name).unwrap_or_else(|| "a former teammate".into());
    let mut lines = Vec::new();
    let mut kept = Vec::new();
    for id in ids {
        let Ok(row) = st.db.session_detail(id) else { continue };
        let link = &row["link"];
        let (agent, peer) = (row["agentId"].as_str().unwrap_or(""), link["peerAgentId"].as_str().unwrap_or(""));
        if link["kind"] != "side" || (agent != me && peer != me) { continue; }
        let title = row["title"].as_str().unwrap_or("Conversation");
        let mine = peer == me;
        let other = if mine { agent } else { peer };
        let mut line = format!("- \"{title}\" (conversation {id}) with {}, {}.", name_of(other), if mine { "which you started" } else { "which they started" });
        if mine { line.push_str(&format!(" To follow up there, call message_blob with blob \"{}\" and conversation \"{id}\".", name_of(other))); }
        if let Some(reply) = st.db.last_reply(id).ok().flatten() { line.push_str(&format!("\n  Latest reply: {}", one_line(&reply, 600))); }
        lines.push(line);
        kept.push(json!({"id":id,"title":title}));
    }
    if kept.is_empty() { return None; }
    Some((format!("\n\n<bloblex_references>\nThe user referenced these side conversations with #:\n{}\n</bloblex_references>", lines.join("\n")), Value::Array(kept)))
}

/// A visible note in a conversation that is not a prompt (e.g. "Messaged Codex").
/// A notice for something the blob DID during its running turn ("Messaged X").
/// It is placed above the turn's assistant text so the call reads before what the
/// assistant says about it; the event names the message it sits above so open
/// windows insert it in the same place a reload would show it.
pub(crate) async fn note_above_turn_text(st: &AppState, session_id: &str, content: &str, meta: Value) {
    let turn = st.active_turns.lock().await.get(session_id).cloned().unwrap_or_default();
    let Ok((message, before)) = st.db.append_notice_above_turn_text(session_id, &turn, content, &json!({"meta":meta})) else { return };
    if message.is_null() { return; }
    let mut payload = json!({"sessionId":session_id,"messageId":message["id"],"role":"notice","message":message});
    if let Some(before) = before { payload["beforeMessageId"] = json!(before); }
    st.emit("message.completed", payload).await;
}

pub(crate) async fn note(st: &AppState, session_id: &str, content: &str, meta: Value) {
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
    if let Err(error) = crate::session_prompt_for_team(st, json!({"sessionId":session_id,"text":text.clone(),"meta":meta.clone()})).await {
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
        st.team.clear_creations(&session_id);
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
        // Automation runs map the same turn outcome onto their run row.
        crate::automations::after_turn(&st, &session_id, &outcome).await;
        // The durable user queue drains before Team deliveries, so a queued
        // prompt is sent first and any pending team delivery follows it.
        crate::queue::after_turn(&st, &session_id, &outcome).await;
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
