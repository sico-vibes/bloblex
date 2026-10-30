//! Wave 14: the Bitbots MCP. The tool route is driven in-process, the way
//! `main_rpc` drives it for a real client; the stdio server has its own tests in
//! `mcp_bridge.rs`.

use super::*;
use crate::phase2a_tests::{state, TeamAdapter};
use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap},
    response::IntoResponse,
    Json,
};
use bloblex_agent_core::{AgentEvent, NewSessionRequest, PromptRequest, ResumeSessionRequest, RuntimeSpec, SessionHandle, SteerOutcome, SteerRequest};
use bloblex_protocol::{EventEnvelope, RpcRequest};
use std::sync::Arc;
use tokio::sync::broadcast;

/// A coding agent that takes a prompt and never finishes it, so a turn stays live.
#[derive(Default)]
struct HoldAdapter;

#[async_trait::async_trait]
impl bloblex_agent_core::AgentAdapter for HoldAdapter {
    async fn probe(&self, _: &RuntimeSpec) -> Result<bloblex_agent_core::ProbeResult, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
    async fn new_session(&self, _: &RuntimeSpec, request: NewSessionRequest, _: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> {
        Ok(SessionHandle { session_id: request.session_id, provider_session_id: "hold".into(), capabilities: Default::default() })
    }
    async fn resume_session(&self, _: &RuntimeSpec, _: ResumeSessionRequest, _: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
    async fn prompt(&self, _: &SessionHandle, _: PromptRequest) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
    async fn steer(&self, _: &SessionHandle, _: SteerRequest) -> Result<SteerOutcome, bloblex_agent_core::AdapterError> { Ok(SteerOutcome::Accepted) }
    async fn cancel(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
    async fn reply_permission(&self, _: &str, _: &str) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
    async fn close_session(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
}

/// A coding agent whose every prompt fails the way OpenCode's rejected effort does.
#[derive(Default)]
struct FailAdapter;

#[async_trait::async_trait]
impl bloblex_agent_core::AgentAdapter for FailAdapter {
    async fn probe(&self, _: &RuntimeSpec) -> Result<bloblex_agent_core::ProbeResult, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
    async fn new_session(&self, _: &RuntimeSpec, request: NewSessionRequest, _: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> {
        Ok(SessionHandle { session_id: request.session_id, provider_session_id: "fail".into(), capabilities: Default::default() })
    }
    async fn resume_session(&self, _: &RuntimeSpec, _: ResumeSessionRequest, _: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
    async fn prompt(&self, _: &SessionHandle, _: PromptRequest) -> Result<(), bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Protocol("OpenCode rejected the effort setting: OpenCode answered \"default\" instead of high".into())) }
    async fn steer(&self, _: &SessionHandle, _: SteerRequest) -> Result<SteerOutcome, bloblex_agent_core::AdapterError> { Ok(SteerOutcome::Accepted) }
    async fn cancel(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
    async fn reply_permission(&self, _: &str, _: &str) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
    async fn close_session(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
}

const SECRET_ENV: &str = "secret-env-value-123";

struct Ctx {
    st: AppState,
    events: broadcast::Receiver<EventEnvelope>,
    agent: String,
    token: String,
    dir: PathBuf,
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bitbots-ext-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A state with one bot (a runtime profile value in its environment), a stub coding
/// agent (`hold` keeps turns live; otherwise every prompt is answered at once) and
/// the MCP switched on at `tier`.
async fn fixture(tier: &str, hold: bool) -> Ctx {
    let adapter: Arc<dyn bloblex_agent_core::AgentAdapter> = if hold { Arc::new(HoldAdapter) } else { Arc::new(TeamAdapter::default()) };
    fixture_with(tier, adapter).await
}

async fn fixture_with(tier: &str, codex: Arc<dyn bloblex_agent_core::AgentAdapter>) -> Ctx {
    let (mut st, events) = state();
    let runtime = json!({"id": "ext-rt", "provider": "codex", "status": "online", "executablePath": "unused-test-runtime", "launchArgs": []});
    st.db.upsert_runtime(&runtime).unwrap();
    *st.runtimes.write().await = vec![runtime];
    st.adapters = Arc::new(crate::Adapters { acp: st.adapters.acp.clone(), codex, claude: st.adapters.claude.clone() });
    let dir = temp_dir("data");
    *st.team.data_dir.lock().unwrap() = Some(dir.clone());
    *st.team.address.lock().unwrap() = Some("127.0.0.1:1".to_owned());
    let agent = st.db.agent_create(&json!({"name": "Scout", "runtimeId": "ext-rt", "approvalMode": "ask", "instructions": "keep-private-instructions", "customEnv": {"LANG": SECRET_ENV}})).unwrap().0["id"].as_str().unwrap().to_owned();
    rpc(&st, "external.enable", &json!({"tier": tier, "confirm": true})).await.unwrap();
    let token = st.external.token.lock().unwrap().clone().expect("a token after enable");
    Ctx { st, events, agent, token, dir }
}

async fn tool(st: &AppState, name: &str, args: Value) -> (bool, Value) {
    let reply = route(st, "ext.tools.call", &json!({"name": name, "arguments": args})).await.unwrap();
    let text = reply["content"][0]["text"].as_str().unwrap_or("").to_owned();
    (reply["isError"] == true, serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

async fn tool_names(st: &AppState) -> Vec<String> {
    let listed = route(st, "ext.tools.list", &json!({})).await.unwrap();
    listed["tools"].as_array().unwrap().iter().filter_map(|tool| tool["name"].as_str().map(str::to_owned)).collect()
}

fn git(dir: &Path, args: &[&str]) -> bool {
    std::process::Command::new("git").current_dir(dir).args(args).output().map(|output| output.status.success()).unwrap_or(false)
}

fn make_repo() -> Option<PathBuf> {
    if !std::process::Command::new("git").arg("--version").output().map(|output| output.status.success()).unwrap_or(false) { return None; }
    let dir = temp_dir("repo");
    assert!(git(&dir, &["init", "-q"]));
    assert!(git(&dir, &["config", "core.autocrlf", "false"]));
    std::fs::write(dir.join("readme.txt"), "hello\n").unwrap();
    assert!(git(&dir, &["add", "."]));
    assert!(git(&dir, &["-c", "user.name=Test", "-c", "user.email=test@bitbots.local", "commit", "-q", "-m", "init"]));
    Some(dir)
}

async fn post(st: &AppState, bearer: Option<&str>, method: &str) -> axum::http::StatusCode {
    let mut headers = HeaderMap::new();
    if let Some(bearer) = bearer { headers.insert(header::AUTHORIZATION, format!("Bearer {bearer}").parse().unwrap()); }
    let request = RpcRequest { v: 1, id: "test".into(), method: method.into(), params: json!({}) };
    crate::main_rpc(State(st.clone()), ConnectInfo("127.0.0.1:5555".parse().unwrap()), headers, Json(request)).await.into_response().status()
}

#[tokio::test]
async fn external_tools_need_the_token_and_the_switch() {
    let c = fixture("chat", false).await;
    assert_eq!(post(&c.st, None, "ext.tools.list").await, StatusCode::UNAUTHORIZED, "no token");
    assert_eq!(post(&c.st, Some("not-the-token"), "ext.tools.list").await, StatusCode::UNAUTHORIZED, "a wrong token");
    assert_eq!(post(&c.st, Some(c.st.token.as_str()), "ext.tools.list").await, StatusCode::UNAUTHORIZED, "the daemon capability is not the MCP token");
    assert_eq!(post(&c.st, Some(&c.token), "ext.tools.list").await, StatusCode::OK, "the right token with the switch on");
    assert_eq!(post(&c.st, Some(&c.token), "ext.hello").await, StatusCode::OK);
    // The switch off, with the token still in memory: refused all the same.
    c.st.db.set_setting(ENABLED, &json!(false)).unwrap();
    assert_eq!(post(&c.st, Some(&c.token), "ext.tools.list").await, StatusCode::UNAUTHORIZED, "the switch is off");
    c.st.db.set_setting(ENABLED, &json!(true)).unwrap();
    assert_eq!(post(&c.st, Some(&c.token), "ext.tools.list").await, StatusCode::OK);
    // The capability-only API does not accept the MCP token.
    assert_eq!(post(&c.st, Some(&c.token), "external.status").await, StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[tokio::test]
async fn external_enable_requires_confirm_and_rotates_the_token() {
    let mut c = fixture("chat", false).await;
    let st = &c.st;
    rpc(st, "external.disable", &json!({})).await.unwrap();
    let endpoint = data_dir(st).unwrap().join(ENDPOINT_FILE);
    assert!(!endpoint.exists(), "disable removes the endpoint file");
    assert_eq!(rpc(st, "external.enable", &json!({"tier": "chat"})).await.unwrap_err().1.code, "invalid_argument", "no confirm");
    assert_eq!(rpc(st, "external.enable", &json!({"tier": "root", "confirm": true})).await.unwrap_err().1.code, "invalid_argument", "an unknown level");
    assert!(!rpc(st, "external.status", &json!({})).await.unwrap()["enabled"].as_bool().unwrap(), "a refused enable changes nothing");
    assert!(!endpoint.exists());

    while c.events.try_recv().is_ok() {}
    let enabled = rpc(st, "external.enable", &json!({"tier": "chat", "confirm": true})).await.unwrap();
    let first = st.external.token.lock().unwrap().clone().unwrap();
    assert_eq!(enabled["enabled"], true);
    assert_eq!(enabled["tier"], "chat");
    assert!(endpoint.is_file());
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&endpoint).unwrap()).unwrap();
    assert_eq!(file["token"], first.as_str());
    assert_eq!(file["address"], "127.0.0.1:1");
    let bridge = PathBuf::from(enabled["bridgePath"].as_str().expect("a bridge copy"));
    assert!(bridge.is_file());
    let command = enabled["command"].as_str().unwrap();
    assert!(command.starts_with("claude mcp add bitbots -- \""), "{command}");
    assert!(command.contains(&format!("\"{}\" mcp-server --endpoint \"{}\"", bridge.display(), endpoint.display())), "{command}");
    assert!(!enabled.to_string().contains(&first), "the status never holds the token");
    let event = loop {
        let event = tokio::time::timeout(Duration::from_secs(2), c.events.recv()).await.unwrap().unwrap();
        if event.event_type == "external.changed" { break event; }
    };
    assert_eq!(event.payload["enabled"], true);
    assert!(!event.payload.to_string().contains(&first), "the event never holds the token");

    let rotated = rpc(st, "external.rotate", &json!({})).await.unwrap();
    let second = st.external.token.lock().unwrap().clone().unwrap();
    assert_ne!(first, second);
    assert!(!st.external.accepts(&first), "the old token stops working");
    assert!(st.external.accepts(&second));
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&endpoint).unwrap()).unwrap();
    assert_eq!(file["token"], second.as_str(), "the file carries the new token");
    assert!(!rotated.to_string().contains(&second));

    assert_eq!(rpc(st, "external.setTier", &json!({"tier": "root"})).await.unwrap_err().1.code, "invalid_argument");
    assert_eq!(rpc(st, "external.setTier", &json!({"tier": "operator"})).await.unwrap()["tier"], "operator");
    let disabled = rpc(st, "external.disable", &json!({})).await.unwrap();
    assert_eq!(disabled["enabled"], false);
    assert!(disabled["command"].is_null() && disabled["endpointPath"].is_null());
    assert!(!endpoint.exists());
    assert!(!st.external.accepts(&second), "disable clears the token in memory");
    assert_eq!(rpc(st, "external.setTier", &json!({"tier": "chat"})).await.unwrap_err().1.code, "conflict", "a level only changes while on");
    assert_eq!(rpc(st, "external.rotate", &json!({})).await.unwrap_err().1.code, "conflict");
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[tokio::test]
async fn external_settings_cannot_be_set_directly() {
    let c = fixture("chat", false).await;
    for (key, value) in [(ENABLED, json!(true)), (TIER, json!("operator")), ("mcp.external.other", json!(1))] {
        let refused = crate::dispatch(&c.st, "settings.set", json!({"key": key, "value": value})).await.unwrap_err();
        assert_eq!(refused.1.code, "invalid_argument", "{key}");
        assert!(refused.1.message.contains("external.enable"), "{}", refused.1.message);
    }
    assert_eq!(tier_of(&c.st), Tier::Chat, "the level was not changed");
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[tokio::test]
async fn external_tiers_filter_tools() {
    let c = fixture("viewer", false).await;
    let st = &c.st;
    let viewer = tool_names(st).await;
    assert!(viewer.contains(&"get_status".to_owned()) && viewer.contains(&"wait_for_turn".to_owned()));
    for hidden in ["send_message", "steer", "stop_turn", "create_bot", "answer_approval"] { assert!(!viewer.contains(&hidden.to_owned()), "a viewer sees {hidden}"); }
    let (refused, message) = tool(st, "send_message", json!({"botId": c.agent, "text": "hi"})).await;
    assert!(refused, "a refused call is an error result");
    assert!(message.as_str().unwrap().contains("needs the Chat level in Bitbots › Settings › Connections"), "{message}");

    rpc(st, "external.setTier", &json!({"tier": "chat"})).await.unwrap();
    let chat = tool_names(st).await;
    for shown in ["send_message", "steer", "stop_turn"] { assert!(chat.contains(&shown.to_owned()), "chat lacks {shown}"); }
    for hidden in ["create_bot", "answer_approval"] { assert!(!chat.contains(&hidden.to_owned()), "chat sees {hidden}"); }
    let listed = route(st, "ext.tools.list", &json!({})).await.unwrap();
    let send = listed["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == "send_message").unwrap().clone();
    assert!(send["inputSchema"]["properties"].get("worktree").is_none(), "worktree is an Operator option");
    let (refused, message) = tool(st, "create_bot", json!({"name": "X", "runtimeId": "ext-rt", "model": "m", "projectPath": "."})).await;
    assert!(refused && message.as_str().unwrap().contains("needs the Operator level in Bitbots › Settings › Connections"), "{message}");
    let (refused, message) = tool(st, "send_message", json!({"botId": c.agent, "text": "hi", "newConversation": true, "worktree": true})).await;
    assert!(refused && message.as_str().unwrap().contains("Operator level"), "{message}");
    assert!(tool(st, "answer_approval", json!({"approvalId": "x", "decision": "allow"})).await.0);
    assert!(tool(st, "no_such_tool", json!({})).await.0);

    rpc(st, "external.setTier", &json!({"tier": "operator"})).await.unwrap();
    let operator = tool_names(st).await;
    for shown in ["create_bot", "answer_approval", "send_message"] { assert!(operator.contains(&shown.to_owned())); }
    let listed = route(st, "ext.tools.list", &json!({})).await.unwrap();
    let send = listed["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == "send_message").unwrap().clone();
    assert!(send["inputSchema"]["properties"].get("worktree").is_some());
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[tokio::test]
async fn external_send_message_marks_the_origin() {
    let c = fixture("chat", false).await;
    let st = &c.st;
    route(st, "ext.hello", &json!({"clientName": "claude-code"})).await.unwrap();
    let (error, sent) = tool(st, "send_message", json!({"botId": c.agent, "text": "Hello from outside", "newConversation": true})).await;
    assert!(!error, "{sent}");
    assert_eq!(sent["turnStarted"], true);
    let session = sent["sessionId"].as_str().unwrap().to_owned();
    let (_, waited) = tool(st, "wait_for_turn", json!({"sessionId": session, "timeoutSecs": 10})).await;
    assert_eq!(waited["done"], true, "{waited}");
    // A second message continues the same conversation, and is marked too.
    let (error, again) = tool(st, "send_message", json!({"sessionId": session, "text": "And again"})).await;
    assert!(!error, "{again}");
    tool(st, "wait_for_turn", json!({"sessionId": session, "timeoutSecs": 10})).await;
    let detail = st.db.session_detail(&session).unwrap();
    let users: Vec<&Value> = detail["messages"].as_array().unwrap().iter().filter(|message| message["role"] == "user").collect();
    assert_eq!(users.len(), 2, "{users:?}");
    for message in users {
        assert_eq!(message["meta"]["origin"]["kind"], "mcp", "{message}");
        assert_eq!(message["meta"]["origin"]["client"], "claude-code");
    }
    // The origin travels in the conversation as the UI reads it, and the MCP shows it as well.
    let (_, read) = tool(st, "read_conversation", json!({"sessionId": session})).await;
    assert!(read.as_array().unwrap().iter().any(|item| item["role"] == "user" && item["origin"]["kind"] == "mcp"), "{read}");
    // Nothing else can claim the mark: the user path drops it.
    assert!(crate::sanitize_prompt_meta(&json!({"kind": "mcp", "client": "x"}), crate::PromptOrigin::User).is_none());
    assert_eq!(crate::sanitize_prompt_meta(&json!({"kind": "mcp", "client": "x"}), crate::PromptOrigin::Mcp), Some(json!({"origin": {"kind": "mcp", "client": "x"}})));
    // An activity line names the tool and the bot, never the text.
    let lines = st.db.remote_activity_list(20).unwrap();
    assert!(lines.iter().any(|line| line["kind"] == "mcp" && line["summary"] == "claude-code used send_message on Scout."), "{lines:?}");
    assert!(!lines.to_vec().iter().any(|line| line.to_string().contains("Hello from outside")));
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[tokio::test]
async fn external_a_message_to_a_busy_conversation_is_queued_and_keeps_its_mark() {
    let c = fixture("chat", true).await;
    let st = &c.st;
    route(st, "ext.hello", &json!({"clientName": "claude-code"})).await.unwrap();
    let (_, sent) = tool(st, "send_message", json!({"botId": c.agent, "text": "First", "newConversation": true})).await;
    let session = sent["sessionId"].as_str().unwrap().to_owned();
    assert_eq!(sent["turnStarted"], true);
    let (error, queued) = tool(st, "send_message", json!({"sessionId": session, "text": "Second"})).await;
    assert!(!error, "{queued}");
    assert_eq!(queued["queued"], true);
    assert_eq!(queued["turnStarted"], false);
    let items = st.db.queue_list(&session).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["meta"]["kind"], "mcp");
    assert_eq!(items[0]["meta"]["client"], "claude-code");
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[tokio::test]
async fn external_wait_for_turn_returns_reply_and_metrics() {
    let c = fixture("chat", false).await;
    let st = &c.st;
    let (_, sent) = tool(st, "send_message", json!({"botId": c.agent, "text": "Summarise the build", "newConversation": true})).await;
    let session = sent["sessionId"].as_str().unwrap().to_owned();
    let (error, waited) = tool(st, "wait_for_turn", json!({"sessionId": session, "timeoutSecs": 10})).await;
    assert!(!error, "{waited}");
    assert_eq!(waited["done"], true, "{waited}");
    assert!(waited["reply"].as_str().unwrap().contains("handled: Summarise the build"), "{waited}");
    assert_eq!(waited["metrics"]["outcome"], "completed");
    assert_eq!(waited["metrics"]["toolCalls"], 0);
    assert!(waited["metrics"]["durationMs"].is_number());
    assert!(waited["metrics"].get("inputTokens").is_none() && waited["metrics"].get("outputTokens").is_none(), "unknown values are left out, never 0");
    assert!(waited["metrics"].get("costUsd").is_none());
    let (_, metrics) = tool(st, "turn_metrics", json!({"sessionId": session})).await;
    assert_eq!(metrics.as_array().unwrap().len(), 1);
    assert_eq!(metrics[0]["outcome"], "completed");
    // Nothing is running: the wait answers at once with the same reply.
    let started = Instant::now();
    let (_, again) = tool(st, "wait_for_turn", json!({"sessionId": session, "timeoutSecs": 600})).await;
    assert_eq!(again["done"], true);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(tool(st, "wait_for_turn", json!({"sessionId": "missing"})).await.0);
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[tokio::test]
async fn failed_turn_shows_its_error_in_wait_for_turn_read_conversation_and_turn_metrics() {
    let c = fixture_with("chat", Arc::new(FailAdapter)).await;
    let st = &c.st;
    let (_, sent) = tool(st, "send_message", json!({"botId": c.agent, "text": "Do the thing", "newConversation": true})).await;
    let session = sent["sessionId"].as_str().unwrap().to_owned();
    let (error, waited) = tool(st, "wait_for_turn", json!({"sessionId": session, "timeoutSecs": 10})).await;
    assert!(!error, "{waited}");
    assert_eq!(waited["done"], true, "{waited}");
    assert_eq!(waited["metrics"]["outcome"], "error", "{waited}");
    assert!(waited["error"]["message"].as_str().is_some_and(|message| !message.is_empty()), "{waited}");
    assert!(waited["error"]["detail"].as_str().is_some_and(|detail| detail.contains("effort")), "the Details line is kept: {waited}");
    let (_, metrics) = tool(st, "turn_metrics", json!({"sessionId": session})).await;
    assert_eq!(metrics[0]["error"], waited["error"], "{metrics}");
    let (_, conversation) = tool(st, "read_conversation", json!({"sessionId": session})).await;
    let notice = conversation.as_array().unwrap().iter().find(|item| item["role"] == "error").unwrap_or_else(|| panic!("an error item in {conversation}"));
    assert!(notice["text"].as_str().unwrap().contains(waited["error"]["message"].as_str().unwrap()), "{notice}");
    assert_eq!(notice["kind"], "error");
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[tokio::test]
async fn external_wait_for_turn_returns_early_on_approval() {
    let c = fixture("chat", false).await;
    let st = &c.st;
    st.db.create_session_for_agent("ext-wait", "ext-rt", "codex", ".", "Waiting", Some(&c.agent)).unwrap();
    st.db.update_session_state("ext-wait", "waiting_permission").unwrap();
    st.db.create_turn("ext-wait-turn", "ext-wait").unwrap();
    st.active_turns.lock().await.insert("ext-wait".into(), "ext-wait-turn".into());
    st.db.insert_permission("perm-ext", "ext-wait", "provider-ext", "Run npm test", Some("npm test"), &["allow_once".into(), "deny".into()], &json!({}), &json!({})).unwrap();
    let started = Instant::now();
    let (error, waited) = tool(st, "wait_for_turn", json!({"sessionId": "ext-wait", "timeoutSecs": 60})).await;
    assert!(!error, "{waited}");
    assert!(started.elapsed() < Duration::from_secs(5), "it returns early, not after the timeout");
    assert_eq!(waited["done"], false);
    assert_eq!(waited["approvalPending"], true);
    assert_eq!(waited["approvals"][0]["id"], "perm-ext");
    let (_, listed) = tool(st, "list_approvals", json!({})).await;
    assert_eq!(listed[0]["id"], "perm-ext");
    assert_eq!(listed[0]["bot"], "Scout");
    assert_eq!(listed[0]["tool"], "Run npm test");
    let (_, status) = tool(st, "get_status", json!({})).await;
    assert_eq!(status["pendingApprovals"], 1);
    assert_eq!(status["runningTurns"][0]["sessionId"], "ext-wait");
    assert_eq!(status["runningTurns"][0]["bot"], "Scout");
    // Answering an approval is an Operator action.
    assert!(tool(st, "answer_approval", json!({"approvalId": "perm-ext", "decision": "allow"})).await.0);
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[tokio::test]
async fn external_steer_and_stop_work_on_a_running_turn_and_steer_is_marked() {
    let c = fixture("chat", true).await;
    let st = &c.st;
    route(st, "ext.hello", &json!({"clientName": "claude-code"})).await.unwrap();
    let (_, sent) = tool(st, "send_message", json!({"botId": c.agent, "text": "Long job", "newConversation": true})).await;
    let session = sent["sessionId"].as_str().unwrap().to_owned();
    for _ in 0..200 {
        if st.sessions.lock().await.contains_key(&session) { break; }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let (error, steered) = tool(st, "steer", json!({"sessionId": session, "text": "Use the other approach"})).await;
    assert!(!error, "{steered}");
    assert_eq!(steered["steered"], true);
    let detail = st.db.session_detail(&session).unwrap();
    let marked = detail["messages"].as_array().unwrap().iter().find(|message| message["meta"]["kind"] == "steer").expect("the steer message");
    assert_eq!(marked["meta"]["origin"], json!({"kind": "mcp", "client": "claude-code"}));
    let (error, stopped) = tool(st, "stop_turn", json!({"sessionId": session})).await;
    assert!(!error, "{stopped}");
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[tokio::test]
async fn external_worktree_send_creates_a_linked_worktree() {
    let Some(repo) = make_repo() else { return };
    let c = fixture("operator", true).await;
    let st = &c.st;
    let (error, sent) = tool(st, "send_message", json!({"botId": c.agent, "text": "Add a login page", "newConversation": true, "worktree": true, "projectPath": repo.to_string_lossy()})).await;
    assert!(!error, "{sent}");
    let path = PathBuf::from(sent["worktree"]["path"].as_str().unwrap());
    let branch = sent["worktree"]["branch"].as_str().unwrap().to_owned();
    assert!(path.is_dir(), "the worktree exists");
    assert!(branch.starts_with("bitbots/"), "{branch}");
    let session = sent["sessionId"].as_str().unwrap().to_owned();
    let detail = st.db.session_detail(&session).unwrap();
    assert_eq!(crate::worktree::normalize(Path::new(detail["projectPath"].as_str().unwrap())), crate::worktree::normalize(&path), "the conversation starts in the worktree");
    assert_eq!(detail["link"]["worktree"]["branch"], branch.as_str());
    let listed = std::process::Command::new("git").current_dir(&repo).args(["worktree", "list", "--porcelain"]).output().unwrap();
    assert!(String::from_utf8_lossy(&listed.stdout).replace('\\', "/").to_lowercase().contains(&path.to_string_lossy().replace('\\', "/").to_lowercase()), "git lists it as a linked worktree");
    let (_, conversations) = tool(st, "list_conversations", json!({"botId": c.agent})).await;
    assert_eq!(conversations[0]["worktree"]["branch"], branch.as_str());
    let (_, status) = tool(st, "worktree_status", json!({"sessionId": session})).await;
    assert_eq!(status["branch"], branch.as_str());
    assert_eq!(status["filesChanged"], 0);
    assert_eq!(status["commitsAhead"], 0);
    // A folder that is not a git repository is refused with a reason.
    let plain = temp_dir("plain");
    let (error, refused) = tool(st, "send_message", json!({"botId": c.agent, "text": "x", "newConversation": true, "worktree": true, "projectPath": plain.to_string_lossy()})).await;
    assert!(error && refused.as_str().unwrap().contains("not a git repository"), "{refused}");
    // A conversation that is not in a worktree reports none.
    let (_, plain_sent) = tool(st, "send_message", json!({"botId": c.agent, "text": "plain", "newConversation": true})).await;
    let (_, none) = tool(st, "worktree_status", json!({"sessionId": plain_sent["sessionId"]})).await;
    assert!(none.is_null());
    let family = repo.parent().unwrap().join(format!("{}-bitbots", repo.file_name().unwrap().to_str().unwrap()));
    let _ = std::fs::remove_dir_all(&family);
    let _ = std::fs::remove_dir_all(&repo);
    let _ = std::fs::remove_dir_all(&plain);
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[tokio::test]
async fn external_create_bot_goes_through_validation_and_defaults_to_ask() {
    let c = fixture("operator", false).await;
    let st = &c.st;
    let project = temp_dir("project");
    let args = json!({"name": "Builder", "runtimeId": "ext-rt", "model": "some-model", "projectPath": project.to_string_lossy(), "role": "Developer"});
    let (error, created) = tool(st, "create_bot", args.clone()).await;
    assert!(!error, "{created}");
    assert_eq!(created["name"], "Builder");
    assert_eq!(created["provider"], "codex");
    assert_eq!(created["model"], "some-model");
    assert_eq!(created["approvalMode"], "ask");
    assert_eq!(created["role"], "Developer");
    assert_eq!(created["isManager"], false);
    assert_eq!(crate::worktree::normalize(Path::new(created["projectPath"].as_str().unwrap())), crate::worktree::normalize(&project));
    // The same name is refused by the same rules the app uses.
    assert!(tool(st, "create_bot", args.clone()).await.0, "a duplicate name is refused");
    let mut bypass = args.clone();
    bypass["name"] = json!("Reckless");
    bypass["approvalMode"] = json!("bypass");
    assert!(tool(st, "create_bot", bypass).await.0, "an outside session cannot make a Full access bot");
    let mut missing = args;
    missing["name"] = json!("Lost");
    missing["projectPath"] = json!(project.join("nowhere").to_string_lossy());
    assert!(tool(st, "create_bot", missing).await.0);
    let _ = std::fs::remove_dir_all(&project);
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[tokio::test]
async fn external_results_never_contain_the_token_or_env_values() {
    let c = fixture("operator", false).await;
    let st = &c.st;
    let mut seen = vec![
        serde_json::to_string(&rpc(st, "external.status", &json!({})).await.unwrap()).unwrap(),
        serde_json::to_string(&route(st, "ext.tools.list", &json!({})).await.unwrap()).unwrap(),
    ];
    let (_, session) = tool(st, "send_message", json!({"botId": c.agent, "text": "hello", "newConversation": true})).await;
    tool(st, "wait_for_turn", json!({"sessionId": session["sessionId"], "timeoutSecs": 10})).await;
    for (name, args) in [
        ("get_status", json!({})), ("list_bots", json!({})), ("list_runtimes", json!({})), ("list_projects", json!({})),
        ("list_conversations", json!({})), ("list_approvals", json!({})),
        ("read_conversation", json!({"sessionId": session["sessionId"]})),
        ("turn_metrics", json!({"sessionId": session["sessionId"]})),
        ("worktree_status", json!({"sessionId": session["sessionId"]})),
        ("send_message", json!({})), ("create_bot", json!({"name": "X"})),
    ] {
        let reply = route(st, "ext.tools.call", &json!({"name": name, "arguments": args})).await.unwrap();
        seen.push(reply.to_string());
    }
    let (_, bots) = tool(st, "list_bots", json!({})).await;
    let bot = &bots.as_array().unwrap()[0];
    assert_eq!(bot["name"], "Scout");
    assert_eq!(bot["provider"], "codex");
    assert_eq!(bot["approvalMode"], "ask");
    assert_eq!(bot["status"], "idle");
    for key in ["customEnv", "instructions", "look", "color"] { assert!(bot.get(key).is_none(), "list_bots leaks {key}"); }
    for text in &seen {
        assert!(!text.contains(&c.token), "a result holds the MCP token");
        assert!(!text.contains(&c.st.token.to_string()), "a result holds the daemon capability");
        assert!(!text.contains(SECRET_ENV), "a result holds an environment value");
        assert!(!text.contains("keep-private-instructions"), "a result holds the bot's instructions");
    }
    let _ = std::fs::remove_dir_all(&c.dir);
}

#[cfg(windows)]
#[test]
fn external_a_locked_bridge_copy_is_kept() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = temp_dir("locked");
    let target = dir.join(BRIDGE_FILE);
    std::fs::write(&target, "old copy").unwrap();
    // A client is running the old copy: Windows will not replace a file held open without sharing.
    let _held = std::fs::OpenOptions::new().read(true).share_mode(1).open(&target).unwrap();
    copy_bridge(&dir);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "old copy", "the old copy stays");
    assert!(!dir.join(format!("{BRIDGE_FILE}.new")).exists(), "no half copy is left behind");
    drop(_held);
    copy_bridge(&dir);
    assert_ne!(std::fs::read_to_string(&target).unwrap(), "old copy", "an unlocked copy is replaced");
    let _ = std::fs::remove_dir_all(&dir);
}
