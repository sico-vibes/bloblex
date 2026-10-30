//! Wave 14: the Bitbots MCP. An MCP server that lets a Claude Code session the
//! owner started outside Bitbots see and drive the running app: list bots,
//! projects and conversations, start or continue a conversation (optionally in
//! its own git worktree), steer or stop it, wait for the reply, answer
//! approvals and read turn metrics.
//!
//! It is opt-in and off by default. `external.enable` (with `confirm: true`)
//! makes a token that can do nothing else (never the daemon capability), writes
//! the endpoint file `{address, token}` in the data folder and copies the daemon
//! executable to `bitbots-mcp.exe` beside it, so the long-lived stdio process
//! never locks the installed `bitbotsd.exe`. The client runs
//! `bitbots-mcp.exe mcp-server --endpoint <file>`; that forwards to the `ext.*`
//! route in `main_rpc`, which accepts only this token and only while the switch
//! is on. What a client may do depends on the level the owner chose: `viewer`
//! (read), `chat` (send, steer, stop) or `operator` (worktrees, bots, approvals).
//!
//! Nothing that carries message text is logged or put in an activity line. Tool
//! results are allowlisted fields: never environment values, profiles, tokens or
//! the capability.

use crate::{agent_error, derr, AppState, DispatchError};
use axum::http::StatusCode;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex as StdMutex,
    time::{Duration, Instant},
};

/// The stored switch. Not settable through `settings.set`.
pub const ENABLED: &str = "mcp.external.enabled";
/// The stored level. Not settable through `settings.set`.
pub const TIER: &str = "mcp.external.tier";
/// The endpoint file's name inside the data folder.
const ENDPOINT_FILE: &str = "mcp-external.json";
/// The bridge copy's name inside the data folder.
const BRIDGE_FILE: &str = if cfg!(windows) { "bitbots-mcp.exe" } else { "bitbots-mcp" };
/// `external.changed` for ordinary calls goes out at most this often.
const BROADCAST_EVERY: Duration = Duration::from_secs(5);
/// The longest `wait_for_turn` may wait.
const MAX_WAIT_SECS: u64 = 600;
/// How often `wait_for_turn` looks at the conversation.
const WAIT_STEP: Duration = Duration::from_millis(300);
/// The longest message text one `send_message` or `steer` may carry.
const MAX_TEXT_CHARS: usize = 100_000;
/// The longest text of one message returned by `read_conversation`.
const MAX_MESSAGE_CHARS: usize = 30_000;

// ---------------------------------------------------------------------------
// State and levels

/// In-memory state: the token for this daemon run (none while off), the last
/// client that said hello and the last call.
#[derive(Default)]
pub struct External {
    token: StdMutex<Option<String>>,
    last_call_at: StdMutex<Option<String>>,
    last_client: StdMutex<Option<String>>,
    last_broadcast: StdMutex<Option<Instant>>,
}

impl External {
    /// Whether a bearer value is this run's MCP token.
    pub fn accepts(&self, supplied: &str) -> bool {
        self.token.lock().unwrap_or_else(|poison| poison.into_inner()).as_deref().is_some_and(|token| bloblex_security::capability_matches(token, supplied))
    }

    fn set_token(&self, token: Option<String>) {
        *self.token.lock().unwrap_or_else(|poison| poison.into_inner()) = token;
    }

    fn client(&self) -> Option<String> {
        self.last_client.lock().unwrap_or_else(|poison| poison.into_inner()).clone()
    }

    fn reset_seen(&self) {
        *self.last_call_at.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
        *self.last_client.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
        *self.last_broadcast.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Tier {
    Viewer,
    Chat,
    Operator,
}

impl Tier {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "viewer" => Some(Self::Viewer),
            "chat" => Some(Self::Chat),
            "operator" => Some(Self::Operator),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Chat => "chat",
            Self::Operator => "operator",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Viewer => "Viewer",
            Self::Chat => "Chat",
            Self::Operator => "Operator",
        }
    }
}

/// Whether the owner has switched the Bitbots MCP on.
pub fn enabled(st: &AppState) -> bool {
    st.db.settings().ok().is_some_and(|settings| settings[ENABLED] == true)
}

fn tier_of(st: &AppState) -> Tier {
    st.db.settings().ok().and_then(|settings| settings[TIER].as_str().and_then(Tier::parse)).unwrap_or(Tier::Chat)
}

/// A client name made safe to store and show: no control characters, 60 at most.
fn clean(text: &str) -> String {
    text.chars().filter(|ch| !ch.is_control()).take(60).collect::<String>().trim().to_owned()
}

/// The origin mark a message sent through the MCP carries:
/// `{kind:"mcp", client}`, with "MCP" when the client never said its name.
pub fn origin(client: Option<&str>) -> Value {
    let client = client.map(clean).filter(|name| !name.is_empty()).unwrap_or_else(|| "MCP".to_owned());
    json!({"kind": "mcp", "client": client})
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------
// Endpoint file and bridge copy

fn data_dir(st: &AppState) -> Option<PathBuf> {
    st.team.data_dir.lock().unwrap().clone()
}

fn endpoint_path(st: &AppState) -> Option<PathBuf> {
    data_dir(st).map(|dir| dir.join(ENDPOINT_FILE))
}

fn bridge_path(st: &AppState) -> Option<PathBuf> {
    data_dir(st).map(|dir| dir.join(BRIDGE_FILE)).filter(|path| path.is_file())
}

/// Writes the endpoint file the stdio server reads: this run's address and token.
fn write_endpoint(st: &AppState, token: &str) -> Result<(), DispatchError> {
    let (Some(path), Some(address)) = (endpoint_path(st), st.team.address.lock().unwrap().clone()) else {
        return Err(derr("conflict", "Bitbots' data folder is not ready yet.", StatusCode::CONFLICT));
    };
    std::fs::write(path, json!({"address": address, "token": token}).to_string())
        .map_err(|_| derr("internal", "The Bitbots MCP's endpoint file could not be written.", StatusCode::INTERNAL_SERVER_ERROR))
}

fn remove_endpoint(st: &AppState) {
    if let Some(path) = endpoint_path(st) { let _ = std::fs::remove_file(path); }
}

/// The executable that is copied. Tests copy a small file instead of the test binary.
#[cfg(not(test))]
fn bridge_source() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

#[cfg(test)]
fn bridge_source() -> Option<PathBuf> {
    Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
}

/// Copies the daemon's own executable to `bitbots-mcp.exe` in the data folder.
/// The copy goes to a temporary name first; when the target is locked (a client is
/// running it) the rename fails and the old copy stays, which keeps working because
/// the tools come from the daemon, not from the bridge.
fn copy_bridge(dir: &Path) {
    let Some(source) = bridge_source() else { return };
    let target = dir.join(BRIDGE_FILE);
    let temp = dir.join(format!("{BRIDGE_FILE}.new"));
    if std::fs::copy(&source, &temp).is_err() || std::fs::rename(&temp, &target).is_err() {
        let _ = std::fs::remove_file(&temp);
    }
}

async fn refresh_bridge(st: &AppState) {
    if let Some(dir) = data_dir(st) {
        let _ = tokio::task::spawn_blocking(move || copy_bridge(&dir)).await;
    }
}

/// Startup: a fresh token, endpoint file and bridge copy when the owner had the
/// MCP on, so a client that reconnects after a restart reaches this run.
pub fn startup(st: &AppState) {
    if !enabled(st) { return; }
    let token = bloblex_security::new_capability();
    if write_endpoint(st, &token).is_err() { return; }
    st.external.set_token(Some(token));
    if let Some(dir) = data_dir(st) {
        tokio::task::spawn_blocking(move || copy_bridge(&dir));
    }
}

// ---------------------------------------------------------------------------
// Capability RPCs (the app's Settings page; never remote)

/// The status object: also the `external.changed` payload. It never holds the token.
fn status(st: &AppState) -> Value {
    let on = enabled(st);
    let bridge = if on { bridge_path(st) } else { None };
    let endpoint = if on { endpoint_path(st) } else { None };
    let command = match (&bridge, &endpoint) {
        (Some(bridge), Some(endpoint)) => Some(format!("claude mcp add bitbots -- \"{}\" mcp-server --endpoint \"{}\"", bridge.display(), endpoint.display())),
        _ => None,
    };
    json!({
        "enabled": on,
        "tier": tier_of(st).as_str(),
        "endpointPath": endpoint.map(|path| path.display().to_string()),
        "bridgePath": bridge.map(|path| path.display().to_string()),
        "command": command,
        "lastCallAt": st.external.last_call_at.lock().unwrap_or_else(|poison| poison.into_inner()).clone(),
        "lastClient": st.external.client(),
    })
}

async fn announce(st: &AppState) {
    st.emit("external.changed", status(st)).await;
}

fn store(st: &AppState, key: &str, value: Value) -> Result<(), DispatchError> {
    st.db.set_setting(key, &value).map(|_| ()).map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))
}

fn requested_tier(p: &Value, default: Option<Tier>) -> Result<Tier, DispatchError> {
    match p.get("tier") {
        None | Some(Value::Null) => default.ok_or_else(|| derr("invalid_argument", "tier is required", StatusCode::BAD_REQUEST)),
        Some(value) => value.as_str().and_then(Tier::parse).ok_or_else(|| derr("invalid_argument", "tier must be viewer, chat or operator", StatusCode::BAD_REQUEST)),
    }
}

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "external.status" => Ok(status(st)),
        "external.enable" => {
            if p["confirm"] != true { return Err(derr("invalid_argument", "Confirm turning on the Bitbots MCP first.", StatusCode::BAD_REQUEST)); }
            let tier = requested_tier(p, Some(Tier::Chat))?;
            let token = bloblex_security::new_capability();
            write_endpoint(st, &token)?;
            if let Err(error) = store(st, TIER, json!(tier.as_str())).and_then(|()| store(st, ENABLED, json!(true))) {
                remove_endpoint(st);
                return Err(error);
            }
            st.external.set_token(Some(token));
            st.external.reset_seen();
            refresh_bridge(st).await;
            announce(st).await;
            Ok(status(st))
        }
        "external.disable" => {
            st.external.set_token(None);
            remove_endpoint(st);
            st.external.reset_seen();
            store(st, ENABLED, json!(false))?;
            announce(st).await;
            Ok(status(st))
        }
        "external.setTier" => {
            if !enabled(st) { return Err(derr("conflict", "Turn the Bitbots MCP on first.", StatusCode::CONFLICT)); }
            let tier = requested_tier(p, None)?;
            store(st, TIER, json!(tier.as_str()))?;
            announce(st).await;
            Ok(status(st))
        }
        "external.rotate" => {
            if !enabled(st) { return Err(derr("conflict", "Turn the Bitbots MCP on first.", StatusCode::CONFLICT)); }
            let token = bloblex_security::new_capability();
            write_endpoint(st, &token)?;
            st.external.set_token(Some(token));
            announce(st).await;
            Ok(status(st))
        }
        _ => Err(derr("not_found", "unknown external method", StatusCode::NOT_FOUND)),
    }
}

// ---------------------------------------------------------------------------
// The tool route

/// Records a call: `lastCallAt` now, and an `external.changed` broadcast at most
/// every five seconds (at once when `force`).
async fn touch(st: &AppState, force: bool) {
    *st.external.last_call_at.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(now());
    let due = {
        let mut last = st.external.last_broadcast.lock().unwrap_or_else(|poison| poison.into_inner());
        let due = force || last.is_none_or(|at| at.elapsed() >= BROADCAST_EVERY);
        if due { *last = Some(Instant::now()); }
        due
    };
    if due { announce(st).await; }
}

/// `ext.hello`, `ext.tools.list` and `ext.tools.call`. The caller has already
/// checked the bearer token and the switch.
pub async fn route(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "ext.hello" => {
            let name = clean(p["clientName"].as_str().unwrap_or(""));
            let changed = {
                let mut last = st.external.last_client.lock().unwrap_or_else(|poison| poison.into_inner());
                let changed = !name.is_empty() && last.as_deref() != Some(name.as_str());
                if changed { *last = Some(name); }
                changed
            };
            touch(st, changed).await;
            Ok(json!({"ok": true}))
        }
        "ext.tools.list" => {
            touch(st, false).await;
            Ok(json!({"tools": tool_list(tier_of(st))}))
        }
        "ext.tools.call" => {
            touch(st, false).await;
            let name = p["name"].as_str().unwrap_or("").to_owned();
            let args = if p["arguments"].is_object() { p["arguments"].clone() } else { json!({}) };
            let tier = tier_of(st);
            let outcome = call_tool(st, tier, &name, &args).await;
            Ok(match outcome {
                Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}],"isError":false}),
                Err(message) => json!({"content":[{"type":"text","text":message}],"isError":true}),
            })
        }
        _ => Err(derr("not_found", "unknown ext method", StatusCode::NOT_FOUND)),
    }
}

/// One content-free activity line: who used which tool, on which bot. Never message text.
async fn record(st: &AppState, tool: &str, bot: Option<String>) {
    let client = st.external.client().map(|name| clean(&name)).filter(|name| !name.is_empty()).unwrap_or_else(|| "MCP".to_owned());
    let line = match bot.filter(|name| !name.is_empty()) {
        Some(bot) => format!("{client} used {tool} on {bot}."),
        None => format!("{client} used {tool}."),
    };
    crate::remote::audit(st, None, "mcp", &line).await;
}

// ---------------------------------------------------------------------------
// Tools

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type": "object", "properties": properties, "required": required, "additionalProperties": false})
}

fn entry(tier: Tier, name: &str, description: &str, input: Value) -> (Tier, Value) {
    (tier, json!({"name": name, "description": description, "inputSchema": input}))
}

/// Every tool with the level it needs.
fn catalog() -> Vec<(Tier, Value)> {
    use Tier::{Chat, Operator, Viewer};
    let id = |what: &str| json!({"type": "string", "description": what});
    vec![
        entry(Viewer, "get_status", "The Bitbots version, how many bots there are, the turns running now (bot, start time, what it is doing) and how many approvals are waiting.", schema(json!({}), &[])),
        entry(Viewer, "list_bots", "The owner's bots: id, name, role, coding agent, model, effort, permission mode, project folder, whether it is busy, and whether it is the Manager.", schema(json!({}), &[])),
        entry(Viewer, "list_runtimes", "The coding agents installed on this computer, with the models and efforts each offers: enough to call create_bot.", schema(json!({}), &[])),
        entry(Viewer, "list_projects", "The distinct project folders bots work in, which bots use each, and whether each is a git repository.", schema(json!({}), &[])),
        entry(Viewer, "list_conversations", "Conversations, newest first: id, bot, title, state, last update and its separate git copy when it has one.", schema(json!({"botId": id("Only this bot's conversations."), "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "How many to return (default 20)."}}), &[])),
        entry(Viewer, "read_conversation", "A conversation's messages: id, role, text, time and kind. Tool steps are one line each and images are paths only. Without afterMessageId you get the latest messages; with it, the ones after that message.", schema(json!({"sessionId": id("The conversation."), "afterMessageId": id("Only messages after this one."), "limit": {"type": "integer", "minimum": 1, "maximum": 200, "description": "How many to return (default 50)."}}), &["sessionId"])),
        entry(Viewer, "wait_for_turn", "Waits for the conversation's running turn to finish (up to timeoutSecs, 600 at most), then returns the reply and the turn's metrics, or the error when the turn failed. It returns early when an approval or a question is waiting.", schema(json!({"sessionId": id("The conversation."), "timeoutSecs": {"type": "integer", "minimum": 1, "maximum": 600, "description": "How long to wait (default 120)."}}), &["sessionId"])),
        entry(Viewer, "turn_metrics", "Per turn: start and end time, duration, tool calls, tokens when the coding agent reported them, the outcome, and the error (message and detail) of a failed turn. Unknown values are left out, never zero.", schema(json!({"sessionId": id("The conversation."), "last": {"type": "integer", "minimum": 1, "maximum": 50, "description": "How many turns (default 5)."}}), &["sessionId"])),
        entry(Viewer, "worktree_status", "For a conversation working in its own git copy: branch, base, files changed and commits ahead. Null when it has none.", schema(json!({"sessionId": id("The conversation.")}), &["sessionId"])),
        entry(Viewer, "list_approvals", "Approvals waiting for the owner: id, conversation, bot, tool and a summary.", schema(json!({}), &[])),
        entry(Chat, "send_message", "Sends a message to a bot. With sessionId it continues that conversation (queued after the running turn when it is busy); with botId it continues the bot's latest conversation, or starts a new one when newConversation is true or there is none. Returns at once; use wait_for_turn for the reply.", schema(json!({"botId": id("The bot."), "sessionId": id("An existing conversation."), "text": id("The message, up to 100,000 characters."), "newConversation": {"type": "boolean", "description": "Start a new conversation with botId."}, "projectPath": id("The folder for a new conversation (default: the bot's own).")}), &["text"])),
        entry(Chat, "steer", "Sends extra guidance to the turn that is running now, without stopping it.", schema(json!({"sessionId": id("The conversation."), "text": id("The guidance.")}), &["sessionId", "text"])),
        entry(Chat, "stop_turn", "Stops the turn that is running in a conversation.", schema(json!({"sessionId": id("The conversation.")}), &["sessionId"])),
        entry(Operator, "create_bot", "Creates a bot. Use list_runtimes for the runtime and model; the bot works in projectPath. Its permission mode is ask unless you pass auto.", schema(json!({"name": id("The bot's name, up to 60 characters."), "runtimeId": id("From list_runtimes."), "model": id("A model id from list_runtimes."), "effort": id("An effort the model offers."), "projectPath": id("The folder the bot works in."), "role": id("A short role, up to 40 characters."), "approvalMode": {"type": "string", "enum": ["ask", "auto"], "description": "How the bot asks before acting (default ask)."}}), &["name", "runtimeId", "model", "projectPath"])),
        entry(Operator, "answer_approval", "Allows or denies one waiting approval from list_approvals.", schema(json!({"approvalId": id("From list_approvals."), "decision": {"type": "string", "enum": ["allow", "deny"]}}), &["approvalId", "decision"])),
    ]
}

/// The tools a level may see. `worktree` on `send_message` needs the Operator level, so it is not offered below it.
fn tool_list(tier: Tier) -> Vec<Value> {
    catalog().into_iter().filter(|(needs, _)| *needs <= tier).map(|(_, mut tool)| {
        if tool["name"] == "send_message" && tier == Tier::Operator {
            tool["inputSchema"]["properties"]["worktree"] = json!({"type": "boolean", "description": "For a new conversation in a git project: work in a new linked git worktree and branch, so it cannot clash with the owner's working folder."});
            tool["description"] = json!(format!("{} With worktree: true the new conversation starts in its own git worktree.", tool["description"].as_str().unwrap_or("")));
        }
        tool
    }).collect()
}

fn needs(tier: Tier) -> String {
    format!("This tool needs the {} level in Bitbots › Settings › Connections.", tier.label())
}

type ToolResult = Result<Value, String>;

fn fail(error: DispatchError) -> String {
    error.1.message
}

fn text_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty())
}

fn count_arg(args: &Value, key: &str, default: usize, max: usize) -> usize {
    args.get(key).and_then(Value::as_u64).map_or(default, |value| value as usize).clamp(1, max)
}

fn cap(text: &str, max: usize) -> String {
    if text.chars().count() <= max { text.to_owned() } else { format!("{} … [cut]", text.chars().take(max).collect::<String>()) }
}

/// Runs one tool the level allows. A refusal or a failure is `Err(message)`.
async fn call_tool(st: &AppState, tier: Tier, name: &str, args: &Value) -> ToolResult {
    let Some((needed, _)) = catalog().into_iter().find(|(_, tool)| tool["name"] == name) else {
        return Err(format!("There is no tool called {name}."));
    };
    if needed > tier { return Err(needs(needed)); }
    let bot = bot_for(st, args);
    let outcome = match name {
        "get_status" => get_status(st).await,
        "list_bots" => list_bots(st).await,
        "list_runtimes" => list_runtimes(st).await,
        "list_projects" => list_projects(st).await,
        "list_conversations" => list_conversations(st, args),
        "read_conversation" => read_conversation(st, args),
        "wait_for_turn" => wait_for_turn(st, args).await,
        "turn_metrics" => turn_metrics(st, args),
        "worktree_status" => worktree_status(st, args).await,
        "list_approvals" => list_approvals(st),
        "send_message" => send_message(st, tier, args).await,
        "steer" => steer(st, args).await,
        "stop_turn" => stop_turn(st, args).await,
        "create_bot" => create_bot(st, args).await,
        "answer_approval" => answer_approval(st, args).await,
        _ => Err(format!("There is no tool called {name}.")),
    };
    record(st, name, bot).await;
    outcome
}

// ---------------------------------------------------------------------------
// Reading helpers

fn bot_name(st: &AppState, agent_id: &str) -> Option<String> {
    st.db.agent_get(agent_id).ok().and_then(|agent| agent["name"].as_str().map(str::to_owned))
}

fn session_bot(st: &AppState, session_id: &str) -> Option<String> {
    st.db.session_brief(session_id).ok().and_then(|row| row["agentId"].as_str().and_then(|id| bot_name(st, id)))
}

/// The bot a call is about, for its activity line: a bot id, a conversation's bot, or a new bot's name.
fn bot_for(st: &AppState, args: &Value) -> Option<String> {
    if let Some(id) = text_arg(args, "botId") { return bot_name(st, id); }
    if let Some(id) = text_arg(args, "sessionId") { return session_bot(st, id); }
    text_arg(args, "name").map(|name| cap(name, 60))
}

fn is_busy_state(state: &str) -> bool {
    matches!(state, "starting" | "working" | "waiting_permission" | "cancelling")
}

async fn busy_agents(st: &AppState) -> HashSet<String> {
    let active: HashSet<String> = st.active_turns.lock().await.keys().cloned().collect();
    st.db.session_list(false).unwrap_or_default().iter()
        .filter(|row| row["id"].as_str().is_some_and(|id| active.contains(id)) || row["state"].as_str().is_some_and(is_busy_state))
        .filter_map(|row| row["agentId"].as_str().map(str::to_owned))
        .collect()
}

fn project_path_of(st: &AppState, agent: &Value) -> Option<String> {
    agent["projectId"].as_str().and_then(|id| st.db.project_get(id).ok()).and_then(|project| project["path"].as_str().filter(|path| !path.is_empty()).map(str::to_owned))
        .or_else(|| agent["defaultProject"].as_str().filter(|path| !path.is_empty()).map(str::to_owned))
}

/// A bot as the MCP shows it: allowlisted fields only (never instructions, environment or profile values).
fn bot_view(st: &AppState, agent: &Value, runtimes: &[Value], busy: &HashSet<String>) -> Value {
    let provider = runtimes.iter().find(|runtime| runtime["id"] == agent["runtimeId"]).and_then(|runtime| runtime["provider"].as_str()).unwrap_or("");
    let id = agent["id"].as_str().unwrap_or("");
    json!({
        "id": id,
        "name": agent["name"],
        "role": agent["role"].as_str().filter(|role| !role.is_empty()),
        "provider": provider,
        "model": agent["model"],
        "effort": agent["thinking"],
        "approvalMode": agent["effectiveApprovalMode"],
        "projectPath": project_path_of(st, agent),
        "status": if busy.contains(id) { "busy" } else { "idle" },
        "isManager": agent["systemRole"] == "manager",
    })
}

/// The tool step a running turn is on, when its title is safe to show.
fn doing_now(st: &AppState, session_id: &str) -> Option<String> {
    let detail = st.db.session_detail(session_id).ok()?;
    let tools = detail["tools"].as_array()?;
    let title = tools.iter().rev().find(|tool| tool["state"] == "running")?["title"].as_str()?;
    (!bloblex_security::contains_secret_marker(title)).then(|| cap(title, 120))
}

/// Cards that wait for the owner. Questions and proposals have their own answers, so only permission requests are "approvals".
fn is_approval(card: &Value) -> bool {
    !matches!(card["kind"].as_str(), Some("question") | Some("proposal"))
}

fn card_view(st: &AppState, card: &Value) -> Value {
    let session = card["sessionId"].as_str().unwrap_or("");
    json!({
        "id": card["id"],
        "sessionId": session,
        "bot": session_bot(st, session),
        "tool": card["title"].as_str().map(|title| cap(title, 120)),
        "summary": card["detail"].as_str().map(|detail| cap(detail, 300)),
    })
}

fn approvals(st: &AppState, session_id: &str) -> Vec<Value> {
    st.db.permissions_pending(session_id).unwrap_or_default().iter().filter(|card| is_approval(card)).map(|card| card_view(st, card)).collect()
}

fn require_session(st: &AppState, args: &Value) -> Result<(String, Value), String> {
    let id = text_arg(args, "sessionId").ok_or("sessionId is required.")?.to_owned();
    let row = st.db.session_brief(&id).map_err(|_| "That conversation was not found.".to_owned())?;
    Ok((id, row))
}

// ---------------------------------------------------------------------------
// Viewer tools

async fn get_status(st: &AppState) -> ToolResult {
    let bots = st.db.agent_list(false, None).map_err(|error| fail(agent_error(error)))?.len();
    let turns: Vec<(String, String)> = st.active_turns.lock().await.iter().map(|(session, turn)| (session.clone(), turn.clone())).collect();
    let running: Vec<Value> = turns.iter().map(|(session, turn)| json!({
        "sessionId": session,
        "bot": session_bot(st, session),
        "startedAt": st.db.turn_started_at(turn).ok().flatten(),
        "doingNow": doing_now(st, session),
    })).collect();
    Ok(json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "botCount": bots,
        "runningTurns": running,
        "pendingApprovals": approvals(st, "").len(),
    }))
}

async fn list_bots(st: &AppState) -> ToolResult {
    let agents = st.db.agent_list(false, None).map_err(|error| fail(agent_error(error)))?;
    let runtimes = st.runtimes.read().await.clone();
    let busy = busy_agents(st).await;
    Ok(json!(agents.iter().map(|agent| bot_view(st, agent, &runtimes, &busy)).collect::<Vec<_>>()))
}

async fn list_runtimes(st: &AppState) -> ToolResult {
    let runtimes = st.runtimes.read().await.clone();
    let mut rows = Vec::new();
    for runtime in runtimes {
        let provider = runtime["provider"].as_str().unwrap_or("");
        let models = match tokio::time::timeout(Duration::from_secs(8), crate::catalog::get(st, &runtime, None, None, crate::catalog::Mode::Fresh)).await {
            Ok(Ok(Some(served))) => served.value["models"].as_array().map(|models| models.iter().map(|model| json!({
                "id": model["id"],
                "efforts": model["supportedThinking"].as_array().cloned().unwrap_or_default(),
            })).collect::<Vec<_>>()).unwrap_or_default(),
            _ => Vec::new(),
        };
        rows.push(json!({"id": runtime["id"], "provider": provider, "label": crate::provider_display_name(provider), "models": models}));
    }
    Ok(json!(rows))
}

async fn list_projects(st: &AppState) -> ToolResult {
    let projects = st.db.project_list().map_err(|error| fail(agent_error(error)))?;
    let agents = st.db.agent_list(false, None).map_err(|error| fail(agent_error(error)))?;
    let mut rows: Vec<(String, Value)> = Vec::new();
    for project in &projects {
        let Some(path) = project["path"].as_str().filter(|path| !path.is_empty()) else { continue };
        let key = crate::worktree::normalize(Path::new(path));
        if rows.iter().any(|(seen, _)| *seen == key) { continue; }
        let ids: Vec<&str> = agents.iter().filter(|agent| agent["projectId"] == project["id"]).filter_map(|agent| agent["id"].as_str()).collect();
        rows.push((key, json!({"path": path, "projectId": project["id"], "name": project["name"], "botIds": ids})));
    }
    let paths: Vec<String> = rows.iter().filter_map(|(_, row)| row["path"].as_str().map(str::to_owned)).collect();
    let git = tokio::task::spawn_blocking(move || paths.iter().map(|path| crate::worktree::repo_root(Path::new(path)).is_some()).collect::<Vec<_>>()).await.unwrap_or_default();
    Ok(json!(rows.into_iter().zip(git.into_iter().chain(std::iter::repeat(false))).map(|((_, mut row), is_git)| { row["isGitRepo"] = json!(is_git); row }).collect::<Vec<_>>()))
}

fn list_conversations(st: &AppState, args: &Value) -> ToolResult {
    let limit = count_arg(args, "limit", 20, 100);
    let bot = text_arg(args, "botId");
    let rows = st.db.session_list(false).map_err(|error| fail(agent_error(error)))?;
    let items: Vec<Value> = rows.iter()
        .filter(|row| bot.is_none_or(|bot| row["agentId"].as_str() == Some(bot)))
        .take(limit)
        .map(|row| {
            let mut item = json!({"sessionId": row["id"], "botId": row["agentId"], "title": row["title"], "state": row["state"], "updatedAt": row["updatedAt"]});
            if let Some(worktree) = row["link"]["worktree"].as_object() {
                item["worktree"] = json!({"path": worktree.get("path"), "branch": worktree.get("branch")});
            }
            item
        }).collect();
    Ok(json!(items))
}

/// The time a stored record carries, for ordering a tool step among messages.
fn stamp(value: &Value) -> Option<DateTime<Utc>> {
    value.as_str().and_then(|text| DateTime::parse_from_rfc3339(text).ok()).map(|at| at.with_timezone(&Utc))
}

/// The error of a failed turn, as the app shows it: the plain message and the Details line.
fn turn_error(turn: &Value) -> Option<Value> {
    if turn["state"].as_str() != Some("error") { return None; }
    let message = match turn["failureClass"].as_str() {
        Some(class) => crate::failure_public_message(class).to_owned(),
        None => turn["failureMessage"].as_str().unwrap_or("The turn could not be completed.").to_owned(),
    };
    let mut error = json!({"message": message});
    if let Some(detail) = turn["detail"].as_str().filter(|detail| !detail.is_empty()) {
        error["detail"] = json!(if bloblex_security::contains_secret_marker(detail) { "(hidden)".to_owned() } else { cap(detail, 1000) });
    }
    Some(error)
}

/// A conversation as one list: its messages, with each tool step reduced to a line.
fn conversation_items(detail: &Value) -> Vec<Value> {
    let mut tools: Vec<(Option<DateTime<Utc>>, Value)> = detail["tools"].as_array().cloned().unwrap_or_default().iter().map(|tool| {
        let title = tool["title"].as_str().unwrap_or("Tool");
        let title = if bloblex_security::contains_secret_marker(title) { "(hidden)".to_owned() } else { cap(title, 160) };
        (stamp(&tool["startedAt"]), json!({
            "id": tool["id"], "role": "tool", "text": format!("{title} ({})", tool["state"].as_str().unwrap_or("done")),
            "createdAt": tool["startedAt"], "kind": "tool",
        }))
    }).collect();
    for turn in detail["turns"].as_array().cloned().unwrap_or_default() {
        let Some(error) = turn_error(&turn) else { continue };
        let text = match error["detail"].as_str() { Some(detail) => format!("{}
{detail}", error["message"].as_str().unwrap_or("")), None => error["message"].as_str().unwrap_or("").to_owned() };
        let at = turn["completedAt"].clone();
        tools.push((stamp(&at), json!({"id": format!("{}-error", turn["id"].as_str().unwrap_or("turn")), "role": "error", "text": text, "createdAt": at, "kind": "error"})));
    }
    tools.sort_by_key(|(at, _)| (at.is_none(), *at));
    let mut tools = tools.into_iter().peekable();
    let mut items = Vec::new();
    for message in detail["messages"].as_array().cloned().unwrap_or_default() {
        let at = stamp(&message["createdAt"]);
        while tools.peek().is_some_and(|(tool_at, _)| tool_at.is_some() && at.is_some() && *tool_at <= at) {
            items.push(tools.next().map(|(_, tool)| tool).unwrap_or(Value::Null));
        }
        let mut item = json!({
            "id": message["id"], "role": message["role"], "text": cap(message["content"].as_str().unwrap_or(""), MAX_MESSAGE_CHARS),
            "createdAt": message["createdAt"], "kind": message["meta"]["kind"].as_str().unwrap_or("message"),
        });
        if message["meta"]["origin"].is_object() { item["origin"] = message["meta"]["origin"].clone(); }
        if let Some(images) = message["attachments"].as_array().filter(|images| !images.is_empty()) {
            item["images"] = json!(images.iter().map(|image| json!({"path": image["path"]})).collect::<Vec<_>>());
        }
        items.push(item);
    }
    items.extend(tools.map(|(_, tool)| tool));
    items
}

fn read_conversation(st: &AppState, args: &Value) -> ToolResult {
    let (id, _) = require_session(st, args)?;
    let limit = count_arg(args, "limit", 50, 200);
    let detail = st.db.session_detail(&id).map_err(|_| "That conversation was not found.".to_owned())?;
    let items = conversation_items(&detail);
    let page: Vec<Value> = match text_arg(args, "afterMessageId") {
        Some(after) => {
            let at = items.iter().position(|item| item["id"].as_str() == Some(after)).ok_or("afterMessageId is not in this conversation.")?;
            items.into_iter().skip(at + 1).take(limit).collect()
        }
        None => { let skip = items.len().saturating_sub(limit); items.into_iter().skip(skip).collect() }
    };
    Ok(json!(page))
}

/// The metrics of a conversation's last `last` turns, oldest first. Unknown values are left out.
fn metrics_of(st: &AppState, session_id: &str, last: usize) -> Vec<Value> {
    let Ok(detail) = st.db.session_detail(session_id) else { return Vec::new() };
    let tools = detail["tools"].as_array().cloned().unwrap_or_default();
    let turns = detail["turns"].as_array().cloned().unwrap_or_default();
    let skip = turns.len().saturating_sub(last);
    turns.iter().skip(skip).map(|turn| {
        let id = turn["id"].as_str().unwrap_or("");
        let mut row = json!({
            "turnId": id,
            "startedAt": turn["createdAt"],
            "toolCalls": tools.iter().filter(|tool| tool["turnId"].as_str() == Some(id)).count(),
            "outcome": turn["state"],
        });
        if let (Some(start), Some(end)) = (stamp(&turn["createdAt"]), stamp(&turn["completedAt"])) {
            row["endedAt"] = turn["completedAt"].clone();
            row["durationMs"] = json!((end - start).num_milliseconds().max(0));
        }
        if let Some(class) = turn["failureClass"].as_str() { row["failureClass"] = json!(class); }
        if let Some(error) = turn_error(turn) { row["error"] = error; }
        if let Ok((input, output)) = st.db.turn_usage_tokens(id) {
            if let Some(input) = input { row["inputTokens"] = json!(input); }
            if let Some(output) = output { row["outputTokens"] = json!(output); }
        }
        row
    }).collect()
}

fn turn_metrics(st: &AppState, args: &Value) -> ToolResult {
    let (id, _) = require_session(st, args)?;
    Ok(json!(metrics_of(st, &id, count_arg(args, "last", 5, 50))))
}

async fn wait_for_turn(st: &AppState, args: &Value) -> ToolResult {
    let (id, _) = require_session(st, args)?;
    let secs = args.get("timeoutSecs").and_then(Value::as_u64).unwrap_or(120).clamp(1, MAX_WAIT_SECS);
    let deadline = Instant::now() + Duration::from_secs(secs);
    // The turn to report: the running one, or the newest finished one.
    let running_turn = st.active_turns.lock().await.get(&id).cloned();
    let watched = match running_turn {
        Some(turn) => Some(turn),
        None => st.db.session_detail(&id).ok().and_then(|detail| detail["turns"].as_array().and_then(|turns| turns.last().and_then(|turn| turn["id"].as_str().map(str::to_owned)))),
    };
    loop {
        let state = st.db.session_state(&id).ok().flatten().unwrap_or_default();
        let busy = crate::team::session_busy(st, &id).await;
        if busy {
            let waiting: Vec<Value> = st.db.permissions_pending(&id).unwrap_or_default().iter().map(|card| {
                let mut view = card_view(st, card);
                view["kind"] = json!(if is_approval(card) { "approval" } else { card["kind"].as_str().unwrap_or("question") });
                view
            }).collect();
            if !waiting.is_empty() {
                return Ok(json!({"done": false, "state": state, "approvalPending": true, "approvals": waiting}));
            }
        } else {
            let reply = watched.as_deref().and_then(|turn| st.db.turn_reply(&id, turn).ok().flatten()).or_else(|| st.db.latest_turn_reply(&id).ok().flatten());
            let mut done = json!({"done": true, "state": state});
            if let Some(reply) = reply { done["reply"] = json!(cap(&reply, 60_000)); }
            if let Some(metrics) = metrics_of(st, &id, 1).pop() {
                if let Some(error) = metrics.get("error") { done["error"] = error.clone(); }
                done["metrics"] = metrics;
            }
            return Ok(done);
        }
        if Instant::now() >= deadline { return Ok(json!({"done": false, "state": state, "timedOut": true})); }
        tokio::time::sleep(WAIT_STEP.min(deadline.saturating_duration_since(Instant::now()))).await;
    }
}

async fn worktree_status(st: &AppState, args: &Value) -> ToolResult {
    let (id, _) = require_session(st, args)?;
    let detail = st.db.session_detail(&id).map_err(|_| "That conversation was not found.".to_owned())?;
    let worktree = detail["link"]["worktree"].clone();
    let (Some(path), true) = (worktree["path"].as_str().map(PathBuf::from), worktree.is_object()) else { return Ok(Value::Null) };
    if !path.is_dir() { return Ok(Value::Null); }
    let base_commit = worktree["baseCommit"].as_str().unwrap_or("").to_owned();
    let inspected = {
        let (path, base_commit) = (path.clone(), base_commit.clone());
        tokio::task::spawn_blocking(move || crate::worktree::inspect(&path, &base_commit).map(|summary| (summary, crate::worktree::commits_ahead(&path, &base_commit)))).await
    };
    let Ok(Ok((summary, ahead))) = inspected else { return Err("Git could not read that conversation's copy.".to_owned()) };
    Ok(json!({
        "path": worktree["path"], "branch": worktree["branch"], "base": worktree["base"],
        "filesChanged": summary.files.len(), "files": summary.files.iter().take(50).collect::<Vec<_>>(),
        "insertions": summary.insertions, "deletions": summary.deletions, "untracked": summary.untracked,
        "commitsAhead": ahead,
    }))
}

fn list_approvals(st: &AppState) -> ToolResult {
    Ok(json!(approvals(st, "")))
}

// ---------------------------------------------------------------------------
// Chat tools

fn valid_text(args: &Value) -> Result<String, String> {
    let text = args.get("text").and_then(Value::as_str).unwrap_or("");
    if text.trim().is_empty() { return Err("text is required.".to_owned()); }
    if text.chars().count() > MAX_TEXT_CHARS { return Err(format!("text is longer than {MAX_TEXT_CHARS} characters.")); }
    Ok(text.to_owned())
}

/// The bot's newest conversation that is its own (not a side, scheduled or task run).
fn latest_conversation(st: &AppState, agent_id: &str) -> Option<String> {
    st.db.session_list(false).ok()?.iter().find(|row| {
        row["agentId"].as_str() == Some(agent_id) && !matches!(row["link"]["kind"].as_str(), Some("side") | Some("automation") | Some("task"))
    }).and_then(|row| row["id"].as_str().map(str::to_owned))
}

/// Below the Operator level a new conversation may only use the bot's own folder or a project the owner registered.
fn allowed_folder(st: &AppState, tier: Tier, agent: &Value, requested: &str) -> Result<(), String> {
    if tier >= Tier::Operator { return Ok(()); }
    let wanted = crate::worktree::normalize(Path::new(requested));
    let own = crate::worktree::normalize(&crate::team::workspace_for(st, agent));
    let known = st.db.project_list().unwrap_or_default().iter().filter_map(|project| project["path"].as_str().map(|path| crate::worktree::normalize(Path::new(path)))).any(|path| path == wanted);
    if wanted == own || known { Ok(()) } else { Err(format!("That folder is neither this bot's own nor a registered project. {}", needs(Tier::Operator))) }
}

async fn send_message(st: &AppState, tier: Tier, args: &Value) -> ToolResult {
    let text = valid_text(args)?;
    let want_worktree = args.get("worktree").and_then(Value::as_bool).unwrap_or(false);
    if want_worktree && tier < Tier::Operator { return Err(needs(Tier::Operator)); }
    let new_conversation = args.get("newConversation").and_then(Value::as_bool).unwrap_or(false);
    let client = st.external.client();
    let client_name = client.as_deref().unwrap_or("MCP");
    let mut created: Option<Value> = None;
    let mut worktree: Option<Value> = None;
    let session_id = match (text_arg(args, "sessionId"), text_arg(args, "botId")) {
        (Some(_), _) if new_conversation || want_worktree => return Err("sessionId continues an existing conversation; use botId for a new one.".to_owned()),
        (Some(id), _) => {
            let row = st.db.session_brief(id).map_err(|_| "That conversation was not found.".to_owned())?;
            if row["link"]["kind"] == "side" { return Err("That is a side conversation and is read-only.".to_owned()); }
            id.to_owned()
        }
        (None, Some(bot)) => {
            let agent = st.db.agent_get(bot).map_err(|_| "That bot was not found.".to_owned())?;
            if agent["archived"] == true { return Err("That bot is archived.".to_owned()); }
            let existing = if new_conversation || want_worktree { None } else { latest_conversation(st, bot) };
            match existing {
                Some(id) => id,
                None => {
                    let mut folder = match text_arg(args, "projectPath") {
                        Some(path) => { allowed_folder(st, tier, &agent, path)?; PathBuf::from(path) }
                        None => crate::team::workspace_for(st, &agent),
                    };
                    let mut link = Value::Null;
                    if want_worktree {
                        if !folder.is_dir() { return Err("projectPath must be an existing folder.".to_owned()); }
                        let topic = text.split_whitespace().take(6).collect::<Vec<_>>().join(" ");
                        let source = folder.clone();
                        let made = tokio::task::spawn_blocking(move || {
                            let repo = crate::worktree::repo_root(&source).ok_or_else(|| "That project is not a git repository, so it cannot work in a worktree.".to_owned())?;
                            crate::worktree::create(&repo, &topic)
                        }).await.map_err(|_| "The worktree could not be made.".to_owned())??;
                        folder = made.path.clone();
                        link = json!({"kind": "main", "worktree": made.to_json()});
                        worktree = Some(made.to_json());
                    }
                    let opened = crate::new_session(st, json!({"agentId": bot, "projectPath": folder.to_string_lossy(), "lazy": true, "link": link})).await;
                    match opened {
                        Ok(session) => { created = Some(session.clone()); session["id"].as_str().unwrap_or("").to_owned() }
                        Err(error) => {
                            if let Some(made) = &worktree {
                                let (repo, path, branch) = (PathBuf::from(made["repo"].as_str().unwrap_or("")), PathBuf::from(made["path"].as_str().unwrap_or("")), made["branch"].as_str().unwrap_or("").to_owned());
                                let _ = tokio::task::spawn_blocking(move || crate::worktree::discard(&repo, &path, &branch)).await;
                            }
                            return Err(fail(error));
                        }
                    }
                }
            }
        }
        (None, None) => return Err("Give a botId or a sessionId.".to_owned()),
    };
    let mut result = deliver(st, &session_id, &text, client_name).await?;
    if created.is_some() { result["newConversation"] = json!(true); }
    if let Some(worktree) = worktree { result["worktree"] = json!({"path": worktree["path"], "branch": worktree["branch"]}); }
    Ok(result)
}

/// Queues a message after the running turn, marked as sent by the MCP.
async fn queue_message(st: &AppState, session_id: &str, text: &str, client: &str) -> ToolResult {
    crate::queue::add_marked(st, json!({"sessionId": session_id, "text": text}), Some(client)).await
        .map(|_| json!({"sessionId": session_id, "turnStarted": false, "queued": true}))
        .map_err(fail)
}

/// Starts a turn with the message, or queues it after the running one.
async fn deliver(st: &AppState, session_id: &str, text: &str, client: &str) -> ToolResult {
    if crate::team::session_busy(st, session_id).await { return queue_message(st, session_id, text, client).await; }
    // A message from the owner's tool supersedes an automatic retry, as a typed one does.
    crate::retry::cancel_pending(st, session_id, crate::retry::DeclineReason::Superseded, false).await;
    match crate::session_prompt_for_mcp(st, json!({"sessionId": session_id, "text": text, "meta": {"kind": "mcp", "client": client}})).await {
        Ok(_) => Ok(json!({"sessionId": session_id, "turnStarted": true})),
        Err(error) if error.1.code == "conflict" && crate::team::session_busy(st, session_id).await => queue_message(st, session_id, text, client).await,
        Err(error) => Err(fail(error)),
    }
}

async fn steer(st: &AppState, args: &Value) -> ToolResult {
    let (id, _) = require_session(st, args)?;
    let text = valid_text(args)?;
    let client = st.external.client();
    let outcome = crate::session_steer_marked(st, json!({"sessionId": id, "text": text}), Some(client.as_deref().unwrap_or("MCP"))).await.map_err(fail)?;
    Ok(outcome)
}

async fn stop_turn(st: &AppState, args: &Value) -> ToolResult {
    let (id, _) = require_session(st, args)?;
    crate::cancel_session_turn(st, &id).await.map_err(fail)
}

// ---------------------------------------------------------------------------
// Operator tools

async fn create_bot(st: &AppState, args: &Value) -> ToolResult {
    let name = text_arg(args, "name").ok_or("name is required.")?;
    let runtime_id = text_arg(args, "runtimeId").ok_or("runtimeId is required.")?;
    let model = text_arg(args, "model").ok_or("model is required.")?;
    let project = text_arg(args, "projectPath").ok_or("projectPath is required.")?;
    let mode = text_arg(args, "approvalMode").unwrap_or("ask");
    if !matches!(mode, "ask" | "auto") { return Err("approvalMode must be ask or auto.".to_owned()); }
    if !Path::new(project).is_dir() { return Err("projectPath must be an existing folder.".to_owned()); }
    let mut fields = json!({"name": name, "runtimeId": runtime_id, "model": model, "approvalMode": mode});
    if let Some(effort) = text_arg(args, "effort") { fields["thinking"] = json!(effort); }
    if let Some(role) = text_arg(args, "role") { fields["role"] = json!(role); }
    // The bot's project: the registered one at that folder, or a new one named after it.
    let wanted = crate::worktree::normalize(Path::new(project));
    let known = st.db.project_list().unwrap_or_default().into_iter().find(|row| row["path"].as_str().is_some_and(|path| crate::worktree::normalize(Path::new(path)) == wanted));
    let project_id = match known {
        Some(row) => row["id"].as_str().unwrap_or("").to_owned(),
        None => {
            let label = Path::new(project).file_name().and_then(|folder| folder.to_str()).filter(|folder| !folder.is_empty()).unwrap_or("Project").to_owned();
            let made = crate::team::team_rpc(st, "project.create", &json!({"name": label, "path": project})).await.map_err(fail)?;
            made["project"]["id"].as_str().unwrap_or("").to_owned()
        }
    };
    let created = crate::agent_create_from_rpc(st, fields).await.map_err(fail)?;
    let agent_id = created["id"].as_str().unwrap_or("").to_owned();
    if !project_id.is_empty() {
        crate::team::team_rpc(st, "agent.team.update", &json!({"agentId": agent_id, "projectId": project_id})).await.map_err(fail)?;
    }
    let agent = st.db.agent_get(&agent_id).map_err(|error| fail(agent_error(error)))?;
    let runtimes = st.runtimes.read().await.clone();
    Ok(bot_view(st, &agent, &runtimes, &HashSet::new()))
}

async fn answer_approval(st: &AppState, args: &Value) -> ToolResult {
    let id = text_arg(args, "approvalId").ok_or("approvalId is required.")?;
    let decision = text_arg(args, "decision").ok_or("decision is required.")?;
    if !matches!(decision, "allow" | "deny") { return Err("decision must be allow or deny.".to_owned()); }
    let card = st.db.permission_get(id).map_err(|_| "That approval was not found.".to_owned())?;
    if st.db.permission_status(id).ok().flatten().as_deref() != Some("pending") { return Err("That approval is no longer waiting.".to_owned()); }
    if !is_approval(&card) { return Err("That is a question for the owner, not an approval.".to_owned()); }
    let choices: Vec<&str> = card["choices"].as_array().map(|choices| choices.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let wanted: &[&str] = if decision == "allow" { &["allow_once", "allow", "accept", "yes"] } else { &["deny", "reject", "decline", "no", "cancel"] };
    let choice = wanted.iter().find(|choice| choices.contains(choice)).ok_or("That approval has no matching choice.")?;
    crate::dispatch(st, "permission.reply", json!({"permissionId": id, "choice": choice})).await.map_err(fail)?;
    Ok(json!({"approvalId": id, "decision": decision}))
}

#[cfg(test)]
#[path = "external_tests.rs"]
mod tests;
