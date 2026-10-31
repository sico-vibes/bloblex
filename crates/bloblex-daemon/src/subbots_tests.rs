//! Phase 8, Lane Y: sub-bots. Every tool test goes through the bridge's own path
//! (a session token granted to a session, then `mcp_rpc`), and every method test
//! through `dispatch`.

use super::*;
use crate::phase2a_tests::state;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex as StdMutex};

#[derive(Default)]
struct YAdapter { cancels: StdMutex<Vec<String>>, prompts: StdMutex<Vec<String>> }

#[async_trait::async_trait]
impl bloblex_agent_core::AgentAdapter for YAdapter {
    async fn probe(&self, _: &RuntimeSpec) -> Result<bloblex_agent_core::ProbeResult, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
    async fn new_session(&self, _: &RuntimeSpec, request: NewSessionRequest, _: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> {
        Ok(SessionHandle { session_id: request.session_id.clone(), provider_session_id: format!("provider-{}", request.session_id), capabilities: Default::default() })
    }
    async fn resume_session(&self, _: &RuntimeSpec, _: ResumeSessionRequest, _: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
    async fn prompt(&self, _: &SessionHandle, request: PromptRequest) -> Result<(), bloblex_agent_core::AdapterError> { self.prompts.lock().unwrap().push(request.text); Ok(()) }
    async fn cancel(&self, handle: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { self.cancels.lock().unwrap().push(handle.session_id.clone()); Ok(()) }
    async fn reply_permission(&self, _: &str, _: &str) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
    async fn close_session(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
}

struct Fixture { st: AppState, adapter: Arc<YAdapter>, parent: String }

/// A Codex parent bot with a live, owner-started turn ("y-turn") in the
/// conversation "y-parent", and a signed-in Claude runtime whose cached catalog
/// lists one Haiku, so "spawn 3 sub-agents as Haiku" crosses providers.
async fn fixture() -> Fixture {
    let (mut st, _) = state();
    st.db.set_setting("concurrency.botsAtOnce", &json!(16)).unwrap();
    let adapter = Arc::new(YAdapter::default());
    st.adapters = Arc::new(crate::Adapters { acp: adapter.clone(), codex: adapter.clone(), claude: adapter.clone() });
    let codex = json!({"id":"y-codex","provider":"codex","status":"online","authState":"authenticated","executablePath":"unused-test-runtime","launchArgs":[]});
    let claude = json!({"id":"y-claude","provider":"claude","status":"online","authState":"authenticated","executablePath":"unused-test-runtime","launchArgs":[]});
    for runtime in [&codex, &claude] { st.db.upsert_runtime(runtime).unwrap(); }
    *st.runtimes.write().await = vec![codex.clone(), claude.clone()];
    *st.team.data_dir.lock().unwrap() = Some(std::env::temp_dir().join(format!("y-{}", uuid::Uuid::new_v4())));
    crate::catalog::seed(&st, &claude, json!({"validated":true,"models":[
        {"id":"claude-haiku-5-5","displayName":"Haiku 5.5","supportedThinking":["low","high"]},
        {"id":"claude-sonnet-5-5","displayName":"Sonnet 5.5","supportedThinking":["low","medium","high"]},
    ]}));
    crate::catalog::seed(&st, &codex, json!({"validated":true,"models":[
        {"id":"gpt-5.5","displayName":"GPT 5.5","supportedThinking":["low","high"]},
        {"id":"gpt-6-luna","displayName":"Luna","supportedThinking":["low","high"]},
    ]}));
    let parent = st.db.agent_create(&json!({"name":"Boss","runtimeId":"y-codex","instructions":"Be careful.","color":"violet","approvalMode":"ask","look":{"shape":"squircle"}})).unwrap().0;
    let parent_id = parent["id"].as_str().unwrap().to_owned();
    live_session(&st, &adapter, "y-parent", "y-turn", &parent_id).await;
    Fixture { st, adapter, parent: parent_id }
}

/// A conversation with a running turn and a live handle whose stops are recorded.
async fn live_session(st: &AppState, adapter: &Arc<YAdapter>, sid: &str, turn: &str, agent: &str) {
    st.db.create_session_for_agent(sid, "y-codex", "codex", ".", "Chat", Some(agent)).unwrap();
    st.db.create_turn(turn, sid).unwrap();
    st.db.update_session_state(sid, "working").unwrap();
    st.active_turns.lock().await.insert(sid.to_owned(), turn.to_owned());
    let handle = SessionHandle { session_id: sid.into(), provider_session_id: format!("provider-{sid}"), capabilities: Default::default() };
    let runtime = RuntimeSpec { runtime_id: "y-codex".into(), provider: "codex".into(), executable: PathBuf::from("fake"), args: vec![], cwd: None };
    st.sessions.lock().await.insert(sid.to_owned(), ActiveSession { handle, runtime, adapter: adapter.clone(), launch_approval_mode: ApprovalMode::Ask });
}

/// The bridge's own path: the session's token is granted back to its session, and
/// `mcp.tools.call` runs for that session.
async fn bridge(st: &AppState, session: &str, name: &str, args: Value) -> Value {
    let token = st.team.token_for_test(session);
    let granted = st.team.grant(&token).expect("the token is granted");
    assert_eq!(granted, session);
    team::mcp_rpc(st, &granted, "mcp.tools.call", &json!({"name":name,"arguments":args})).await.unwrap()
}

fn text(result: &Value) -> String { result["content"][0]["text"].as_str().unwrap_or("").to_owned() }
fn ok(result: &Value) -> Value { assert_ne!(result["isError"], true, "{result}"); serde_json::from_str(&text(result)).unwrap() }
fn refused(result: &Value) -> String { assert_eq!(result["isError"], true, "{result}"); text(result) }

static BRIEFS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A call of one brief per model. Every call gets fresh briefs, so a second call in
/// the same turn is a second request and not a replay of the first.
fn spawn_args(models: &[&str]) -> Value {
    json!({"bots": models.iter().enumerate().map(|(index, model)| json!({"brief":format!("Research part {index} of the topic (request {})", BRIEFS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)),"model":model,"role":"Research one angle","topic":format!("Angle {index}")})).collect::<Vec<_>>()})
}

/// What a provider's own turn end does: the turn closes, and the daemon's hook runs.
async fn end_turn(st: &AppState, delegation: &str, outcome: &str) {
    let row = st.db.delegation_get(delegation).unwrap();
    let (side, turn) = (row["sideSessionId"].as_str().unwrap().to_owned(), row["sideTurnId"].as_str().unwrap().to_owned());
    team::after_turn(st, &side, Some(turn), outcome, None);
}

fn subbot_count(st: &AppState) -> usize { st.db.subbot_agents(None).unwrap().len() }

async fn wait_for(st: &AppState, id: &str, status: &str) -> Value {
    for _ in 0..400 {
        let row = st.db.delegation_get(id).unwrap();
        if row["status"] == status { return row; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the assignment never reached {status}: {}", st.db.delegation_get(id).unwrap());
}

/// Waits until every listed assignment holds a side turn (its brief went out).
async fn wait_started(st: &AppState, ids: &[String]) {
    for id in ids {
        for _ in 0..400 {
            if st.db.delegation_get(id).unwrap()["sideTurnId"].as_str().is_some_and(|turn| !turn.is_empty()) { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
}

fn ids_of(spawned: &Value, key: &str) -> Vec<String> { spawned["subbots"].as_array().unwrap().iter().map(|row| row[key].as_str().unwrap().to_owned()).collect() }

#[tokio::test]
async fn spawn_starts_each_subbot_through_the_ledger() {
    // The owner's own test: "spawn 3 sub-agents as Haiku to research X", from a
    // Codex parent, through the bridge's path and then through dispatch.
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku", "haiku", "haiku"])).await);
    let rows = spawned["subbots"].as_array().unwrap();
    assert_eq!(rows.len(), 3, "{spawned}");
    let delegations = ids_of(&spawned, "delegationId");
    wait_started(&f.st, &delegations).await;
    for row in rows {
        assert_eq!(row["model"], "claude-haiku-5-5");
        assert_eq!(row["provider"], "claude", "the sub-bot runs on Haiku's provider, not its parent's");
        assert!(matches!(row["status"].as_str(), Some("queued" | "running")), "{row}");
        // The ledger row is the assignment: origin is the parent's conversation and turn.
        let ledger = f.st.db.delegation_get(row["delegationId"].as_str().unwrap()).unwrap();
        assert_eq!(ledger["originSessionId"], "y-parent");
        assert_eq!(ledger["originTurnId"], "y-turn");
        assert_eq!(ledger["targetAgentId"], row["agentId"]);
        // The bot is hidden, owned by the parent, and carries its look and instructions.
        let agent = f.st.db.agent_get(row["agentId"].as_str().unwrap()).unwrap();
        assert_eq!(agent["hidden"], true);
        assert_eq!(agent["parentAgentId"], f.parent.as_str());
        assert_eq!(agent["color"], "violet");
        assert_eq!(agent["look"], json!({"shape":"squircle"}));
        assert_eq!(agent["instructions"], "Be careful.\n\nYour role here: Research one angle.");
        assert_eq!(agent["model"], "claude-haiku-5-5");
        // Its conversation is a real side conversation the owner can open.
        let side = f.st.db.session_detail(row["sessionId"].as_str().unwrap()).unwrap();
        assert_eq!(side["link"]["kind"], "side");
        assert_eq!(side["link"]["subbot"], true);
        assert_eq!(side["link"]["originSessionId"], "y-parent");
        assert_eq!(side["provider"], "claude");
    }
    let names: BTreeSet<String> = rows.iter().map(|row| row["name"].as_str().unwrap().to_owned()).collect();
    assert_eq!(names.len(), 3, "names are unique among the parent's: {names:?}");
    // The window reads the fleet through dispatch, from the conversation or the bot.
    let listed = dispatch(&f.st, "subbot.list", json!({"sessionId":"y-parent"})).await.unwrap();
    assert_eq!(listed["subbots"].as_array().unwrap().len(), 3);
    let by_bot = dispatch(&f.st, "subbot.list", json!({"agentId":f.parent})).await.unwrap();
    assert_eq!(by_bot["subbots"], listed["subbots"]);
    let first = &listed["subbots"][0];
    for key in ["agentId", "parentAgentId", "originSessionId", "name", "role", "provider", "model", "thinking", "sessionId", "delegationId", "status", "doingNow", "startedAt", "finishedAt", "error"] {
        assert!(first.get(key).is_some(), "subbot.list carries {key}: {first}");
    }
    assert_eq!(first["parentAgentId"], f.parent.as_str());
    assert!(dispatch(&f.st, "subbot.list", json!({})).await.is_err(), "one of the two arguments is required");
    // `agent.list` still returns the hidden rows, with their parent, for the window to leave off the roster.
    let agents = dispatch(&f.st, "agent.list", json!({})).await.unwrap();
    assert_eq!(agents["agents"].as_array().unwrap().iter().filter(|agent| agent["parentAgentId"] == f.parent.as_str()).count(), 3);
}

#[test]
fn a_person_can_say_haiku() {
    let row = |provider: &str, id: &str| (provider.to_owned(), id.to_owned());
    let rows = vec![row("codex", "gpt-6-luna"), row("claude", "claude-haiku-5-5"), row("claude", "claude-sonnet-5-5")];
    assert_eq!(subbots::test_resolve(&rows, "haiku", "codex").unwrap(), "claude-haiku-5-5");
    assert_eq!(subbots::test_resolve(&rows, "Haiku 5.5", "codex").unwrap(), "claude-haiku-5-5");
    assert_eq!(subbots::test_resolve(&rows, "claude-sonnet-5-5", "claude").unwrap(), "claude-sonnet-5-5");
    // The parent's own provider wins when a word matches on both.
    let both = vec![row("claude", "claude-haiku-5-5"), row("opencode", "anthropic/claude-haiku-5-5")];
    assert_eq!(subbots::test_resolve(&both, "haiku", "opencode").unwrap(), "anthropic/claude-haiku-5-5");
}

#[tokio::test]
async fn an_ambiguous_model_names_the_closest() {
    let f = fixture().await;
    let claude = f.st.runtimes.read().await[1].clone();
    crate::catalog::seed(&f.st, &claude, json!({"validated":true,"models":[
        {"id":"claude-haiku-5-5","displayName":"Haiku 5.5","supportedThinking":[]},
        {"id":"claude-haiku-4-5","displayName":"Haiku 4.5","supportedThinking":[]},
    ]}));
    let error = refused(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    assert!(error.contains("claude-haiku-5-5") && error.contains("claude-haiku-4-5"), "{error}");
    assert!(error.contains("nothing was started"), "{error}");
    assert_eq!(subbot_count(&f.st), 0);
}

#[tokio::test]
async fn an_unknown_model_starts_nothing() {
    let f = fixture().await;
    let sessions = f.st.db.session_list(false).unwrap().len();
    let error = refused(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["gemini"])).await);
    assert!(error.contains("No model on this machine matches \"gemini\""), "{error}");
    assert!(error.contains("Closest:") && error.contains("claude-haiku-5-5") || error.contains("gpt"), "{error}");
    assert_eq!(subbot_count(&f.st), 0);
    assert_eq!(f.st.db.session_list(false).unwrap().len(), sessions);
}

#[tokio::test]
async fn it_is_all_or_nothing() {
    let f = fixture().await;
    let error = refused(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku", "haiku", "nonesuch"])).await);
    assert!(error.starts_with("Sub-bot 3:"), "the entry that failed is named: {error}");
    assert_eq!(subbot_count(&f.st), 0, "the two good entries did not start");
    assert!(f.st.db.delegation_list_for_origin("y-parent").unwrap().is_empty());
    // A bad effort is caught in the same pass.
    let mut args = spawn_args(&["haiku"]);
    args["bots"][0]["thinking"] = json!("max");
    assert!(refused(&bridge(&f.st, "y-parent", "spawn_subbots", args).await).contains("takes the efforts low, high"));
    assert_eq!(subbot_count(&f.st), 0);
    // And an empty or oversized list.
    assert!(refused(&bridge(&f.st, "y-parent", "spawn_subbots", json!({"bots":[]})).await).contains("1 to 5"));
    assert!(refused(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"; 6])).await).contains("1 to 5"));
}

#[tokio::test]
async fn list_models_reads_the_cache_and_custom_names() {
    let f = fixture().await;
    dispatch(&f.st, "model.custom.save", json!({"provider":"claude","modelId":"claude-private","label":"Private","efforts":["low"]})).await.unwrap();
    let models = ok(&bridge(&f.st, "y-parent", "list_models", json!({})).await);
    let listed = models["models"].as_array().unwrap();
    let find = |id: &str| listed.iter().find(|model| model["id"] == id).cloned().unwrap_or_else(|| panic!("{id} in {models}"));
    assert_eq!(find("claude-haiku-5-5")["provider"], "claude");
    assert_eq!(find("claude-haiku-5-5")["efforts"], json!(["low", "high"]));
    assert_eq!(find("gpt-6-luna")["provider"], "codex");
    assert_eq!(find("claude-private")["name"], "Private");
    // A signed-out runtime lists nothing.
    let mut runtimes = f.st.runtimes.read().await.clone();
    runtimes[1]["authState"] = json!("unauthenticated");
    *f.st.runtimes.write().await = runtimes;
    let models = ok(&bridge(&f.st, "y-parent", "list_models", json!({})).await);
    assert!(models["models"].as_array().unwrap().iter().all(|model| model["provider"] != "claude"));
}

#[tokio::test]
async fn a_subbot_is_not_a_teammate() {
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    let name = spawned["subbots"][0]["name"].as_str().unwrap().to_owned();
    let other = f.st.db.agent_create(&json!({"name":"Mate","runtimeId":"y-codex"})).unwrap().0;
    f.st.db.create_session_for_agent("y-mate", "y-codex", "codex", ".", "Mate chat", other["id"].as_str()).unwrap();
    f.st.db.update_session_state("y-mate", "idle").unwrap();
    // list_blobs leaves it out, and message_blob will not reach it by name.
    let listing = text(&bridge(&f.st, "y-mate", "list_blobs", json!({})).await);
    assert!(!listing.contains(&name) && listing.contains("Boss"), "{listing}");
    assert!(refused(&bridge(&f.st, "y-mate", "message_blob", json!({"blob":name,"message":"hi"})).await).contains("hidden"));
    // The Bitbots MCP and the roster-wide lists leave it out as well.
    let listed = crate::external::route(&f.st, "ext.tools.call", &json!({"name":"list_bots","arguments":{}})).await.unwrap();
    assert_ne!(listed["isError"], true, "{listed}");
    assert!(text(&listed).contains("Boss") && !text(&listed).contains(&name), "{listed}");
}

#[tokio::test]
async fn a_subbot_cannot_spawn() {
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    let side = spawned["subbots"][0]["sessionId"].as_str().unwrap().to_owned();
    let tools = team::mcp_rpc(&f.st, &side, "mcp.tools.list", &json!({})).await.unwrap();
    let names: Vec<&str> = tools["tools"].as_array().unwrap().iter().filter_map(|tool| tool["name"].as_str()).collect();
    assert!(!names.contains(&"spawn_subbots") && !names.contains(&"list_models"), "{names:?}");
    assert!(names.contains(&"message_blob"), "it still has its other tools");
    assert!(refused(&bridge(&f.st, &side, "spawn_subbots", spawn_args(&["haiku"])).await).contains("cannot start sub-bots"));
    assert!(refused(&bridge(&f.st, &side, "list_models", json!({})).await).contains("sub-bot"));
    assert_eq!(subbot_count(&f.st), 1);
    // The parent is offered both.
    let parent_tools = team::mcp_rpc(&f.st, "y-parent", "mcp.tools.list", &json!({})).await.unwrap();
    let parent_names: Vec<&str> = parent_tools["tools"].as_array().unwrap().iter().filter_map(|tool| tool["name"].as_str()).collect();
    assert!(parent_names.contains(&"spawn_subbots") && parent_names.contains(&"list_models"));
}

#[tokio::test]
async fn five_running_is_the_limit() {
    let f = fixture().await;
    let first = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"; 5])).await);
    assert_eq!(first["subbots"].as_array().unwrap().len(), 5);
    let error = refused(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    assert!(error.contains("at most 5"), "{error}");
    assert_eq!(subbot_count(&f.st), 5, "nothing started over the limit");
    // One finishing frees one place.
    f.st.db.delegation_mark_terminal(first["subbots"][0]["delegationId"].as_str().unwrap(), "completed", None).unwrap();
    ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    assert_eq!(subbot_count(&f.st), 6);
}

#[tokio::test]
async fn twenty_per_conversation_is_the_limit() {
    let f = fixture().await;
    for _ in 0..4 {
        let batch = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"; 5])).await);
        for row in batch["subbots"].as_array().unwrap() { f.st.db.delegation_mark_terminal(row["delegationId"].as_str().unwrap(), "completed", None).unwrap(); }
    }
    assert_eq!(subbot_count(&f.st), 20);
    let error = refused(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    assert!(error.contains("at most 20"), "{error}");
    assert_eq!(subbot_count(&f.st), 20);
}

#[tokio::test]
async fn an_unattended_turn_is_refused() {
    let f = fixture().await;
    for (index, link) in [json!({"kind":"task"}), json!({"kind":"side","peerAgentId":"x","originSessionId":"y-parent"})].into_iter().enumerate() {
        let sid = format!("y-unattended-{index}");
        f.st.db.create_session_for_agent(&sid, "y-codex", "codex", ".", "Run", Some(&f.parent)).unwrap();
        f.st.db.update_session_state(&sid, "working").unwrap();
        f.st.db.set_session_link(&sid, &link).unwrap();
        let error = refused(&bridge(&f.st, &sid, "spawn_subbots", spawn_args(&["haiku"])).await);
        assert!(error.contains("Sub-bots can't be started"), "{error}");
    }
    // A board-task run nobody watches never reaches the tool at all.
    f.st.db.create_session_for_agent("y-unattended-task", "y-codex", "codex", ".", "Run", Some(&f.parent)).unwrap();
    f.st.db.set_session_link("y-unattended-task", &json!({"kind":"task","unattended":true})).unwrap();
    let denied = team::mcp_rpc(&f.st, "y-unattended-task", "mcp.tools.call", &json!({"name":"spawn_subbots","arguments":spawn_args(&["haiku"])})).await;
    assert!(denied.is_err() || denied.unwrap()["isError"] == true);
    // An automation run never reaches the tool at all.
    f.st.db.create_session_for_agent("y-auto", "y-codex", "codex", ".", "Run", Some(&f.parent)).unwrap();
    f.st.db.set_session_link("y-auto", &json!({"kind":"automation"})).unwrap();
    let denied = team::mcp_rpc(&f.st, "y-auto", "mcp.tools.call", &json!({"name":"spawn_subbots","arguments":spawn_args(&["haiku"])})).await;
    assert_eq!(denied.unwrap_err().1.code, "forbidden");
    assert_eq!(subbot_count(&f.st), 0);
}

#[tokio::test]
async fn a_subbot_never_has_more_access_than_its_parent() {
    let f = fixture().await;
    // The parent bot asks for permission: so do its sub-bots, in the stored lock and at launch.
    let mode_of = |spawned: &Value| {
        let side = f.st.db.session_detail(spawned["subbots"][0]["sessionId"].as_str().unwrap()).unwrap();
        (side["modelLock"]["approvalMode"].clone(), f.st.db.agent_get(spawned["subbots"][0]["agentId"].as_str().unwrap()).unwrap()["approvalMode"].clone(), crate::exec_options_for_session(&f.st, &side).unwrap().approval_mode)
    };
    let ask = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    assert_eq!(mode_of(&ask), (json!("ask"), json!("ask"), ApprovalMode::Ask));
    // A conversation pinned to Auto passes Auto, and not more.
    let lock = json!({"model":null,"thinking":null,"approvalMode":"auto"});
    f.st.db.set_session_model_lock("y-parent", &lock).unwrap();
    let auto = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    assert_eq!(mode_of(&auto), (json!("auto"), json!("auto"), ApprovalMode::Auto));
    // Full access passes only when the owner's own turn is running...
    f.st.db.set_session_model_lock("y-parent", &json!({"model":null,"thinking":null,"approvalMode":"bypass"})).unwrap();
    f.st.db.delegation_mark_terminal(auto["subbots"][0]["delegationId"].as_str().unwrap(), "completed", None).unwrap();
    f.st.db.delegation_mark_terminal(ask["subbots"][0]["delegationId"].as_str().unwrap(), "completed", None).unwrap();
    let full = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    assert_eq!(mode_of(&full).2, ApprovalMode::Bypass);
    // ...and is capped at Auto in a turn a teammate's reply started.
    f.st.team.set_depth("y-parent", 1);
    f.st.db.delegation_mark_terminal(full["subbots"][0]["delegationId"].as_str().unwrap(), "completed", None).unwrap();
    let capped = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    assert_eq!(mode_of(&capped).2, ApprovalMode::Auto);
}

#[tokio::test]
async fn a_subbot_on_another_provider_starts_there() {
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku", "luna"])).await);
    let rows = spawned["subbots"].as_array().unwrap();
    assert_eq!((rows[0]["provider"].as_str(), rows[1]["provider"].as_str()), (Some("claude"), Some("codex")));
    let claude_agent = f.st.db.agent_get(rows[0]["agentId"].as_str().unwrap()).unwrap();
    assert_eq!(claude_agent["runtimeId"], "y-claude");
    assert_eq!(f.st.db.session_detail(rows[0]["sessionId"].as_str().unwrap()).unwrap()["runtimeId"], "y-claude");
    assert_eq!(f.st.db.agent_get(rows[1]["agentId"].as_str().unwrap()).unwrap()["runtimeId"], "y-codex");
}

#[tokio::test]
async fn the_result_reaches_the_parent() {
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", json!({"bots":[{"brief":"Find the answer","model":"haiku","name":"Finder","doneGoal":"One source"}]})).await);
    let (side, id) = (spawned["subbots"][0]["sessionId"].as_str().unwrap().to_owned(), spawned["subbots"][0]["delegationId"].as_str().unwrap().to_owned());
    wait_started(&f.st, std::slice::from_ref(&id)).await;
    let turn = f.st.db.delegation_get(&id).unwrap()["sideTurnId"].as_str().unwrap().to_owned();
    f.st.db.append_message_with_data(&side, &turn, "assistant", "It is 42.", &json!({})).unwrap();
    team::after_turn(&f.st, &side, Some(turn), "turn.completed", None);
    let row = wait_for(&f.st, &id, "completed").await;
    assert_eq!(row["status"], "completed");
    let mut texts = Vec::new();
    for _ in 0..300 {
        texts = f.st.team.queued_texts("y-parent").await;
        if !texts.is_empty() { break; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(texts.len(), 1, "{texts:?}");
    assert_eq!(texts[0], "[Reply from Finder]\nIt is 42.\nDone when: One source");
    let listed = dispatch(&f.st, "subbot.list", json!({"sessionId":"y-parent"})).await.unwrap();
    assert_eq!(listed["subbots"][0]["status"], "completed");
    assert!(listed["subbots"][0]["finishedAt"].is_string());
}

#[tokio::test]
async fn stopping_the_parent_stops_the_fleet() {
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"; 3])).await);
    let ids = ids_of(&spawned, "delegationId");
    wait_started(&f.st, &ids).await;
    let stopped = dispatch(&f.st, "session.cancel", json!({"sessionId":"y-parent"})).await.unwrap();
    assert_eq!(stopped["cancellationRequested"], true);
    assert_eq!(stopped["cascaded"], 3, "{stopped}");
    let sides = ids_of(&spawned, "sessionId");
    let cancels = f.adapter.cancels.lock().unwrap().clone();
    assert!(sides.iter().all(|side| cancels.contains(side)), "every sub-bot's turn was stopped: {cancels:?}");
    // Each provider confirms its stop, and the ledger records it.
    for id in &ids { end_turn(&f.st, id, "turn.cancelled").await; }
    for id in &ids { wait_for(&f.st, id, "cancelled").await; }
}

#[tokio::test]
async fn stopping_one_leaves_the_others() {
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"; 3])).await);
    let ids = ids_of(&spawned, "delegationId");
    wait_started(&f.st, &ids).await;
    let sides = ids_of(&spawned, "sessionId");
    dispatch(&f.st, "session.cancel", json!({"sessionId":sides[1]})).await.unwrap();
    assert_eq!(f.adapter.cancels.lock().unwrap().clone(), vec![sides[1].clone()], "only that one was asked to stop");
    // The assignment stays running until its turn's own end; the others are untouched.
    for id in [&ids[0], &ids[2]] { assert_eq!(f.st.db.delegation_get(id).unwrap()["status"], "running"); }
    assert!(f.st.active_turns.lock().await.contains_key("y-parent"), "the parent's turn was not stopped");
}

#[tokio::test]
async fn a_restart_interrupts_running_subbots() {
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"; 2])).await);
    let ids = ids_of(&spawned, "delegationId");
    wait_started(&f.st, &ids).await;
    for id in &ids { assert_eq!(f.st.db.delegation_get(id).unwrap()["status"], "running"); }
    delegations::startup(&f.st).await;
    for id in &ids { assert_eq!(f.st.db.delegation_get(id).unwrap()["status"], "interrupted"); }
    let listed = dispatch(&f.st, "subbot.list", json!({"sessionId":"y-parent"})).await.unwrap();
    assert!(listed["subbots"].as_array().unwrap().iter().all(|row| row["status"] == "interrupted"));
}

#[tokio::test]
async fn the_owner_can_message_a_subbot() {
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", json!({"bots":[{"brief":"Look it up","model":"haiku","name":"Looker"}]})).await);
    let (side, id) = (spawned["subbots"][0]["sessionId"].as_str().unwrap().to_owned(), spawned["subbots"][0]["delegationId"].as_str().unwrap().to_owned());
    wait_started(&f.st, std::slice::from_ref(&id)).await;
    let first = f.st.db.delegation_get(&id).unwrap()["sideTurnId"].as_str().unwrap().to_owned();
    f.st.db.append_message_with_data(&side, &first, "assistant", "Done.", &json!({})).unwrap();
    team::after_turn(&f.st, &side, Some(first.clone()), "turn.completed", None);
    wait_for(&f.st, &id, "completed").await;
    for _ in 0..300 { if !f.st.team.queued_texts("y-parent").await.is_empty() { break; } tokio::time::sleep(std::time::Duration::from_millis(10)).await; }
    assert_eq!(f.st.team.queued_texts("y-parent").await.len(), 1, "the assignment's own reply is relayed once");
    f.st.db.update_turn_state(&first, "completed").unwrap();
    f.st.active_turns.lock().await.remove(&side);
    f.st.db.update_session_state(&side, "idle").unwrap();
    // The owner types in its conversation: it is not read-only, and a turn starts.
    let prompt = dispatch(&f.st, "session.prompt", json!({"sessionId":side,"text":"And the second part?"})).await.unwrap();
    let turn = prompt["turnId"].as_str().unwrap().to_owned();
    assert_ne!(turn, first);
    for _ in 0..300 {
        if f.adapter.prompts.lock().unwrap().iter().any(|sent| sent.contains("And the second part?")) { break; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(f.adapter.prompts.lock().unwrap().iter().any(|sent| sent.contains("And the second part?")), "the owner's words reached the sub-bot");
    f.st.db.append_message_with_data(&side, &turn, "assistant", "Second part.", &json!({})).unwrap();
    team::after_turn(&f.st, &side, Some(turn), "turn.completed", None);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(f.st.team.queued_texts("y-parent").await.len(), 1, "a later message from the owner does not report to the parent again");
}

#[tokio::test]
async fn subbots_never_travel_in_a_backup() {
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    let name = spawned["subbots"][0]["name"].as_str().unwrap().to_owned();
    let exported = dispatch(&f.st, "backup.export", json!({})).await.unwrap();
    let bots = exported["document"]["contents"]["bots"].as_array().unwrap();
    assert!(bots.iter().any(|bot| bot["name"] == "Boss"));
    assert!(bots.iter().all(|bot| bot["name"] != name.as_str()), "{bots:?}");
    assert!(!exported.to_string().contains("Your role here"), "the sub-bot's instructions stay home");
}

#[tokio::test]
async fn deleting_the_parent_archives_them() {
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"; 2])).await);
    let ids = ids_of(&spawned, "delegationId");
    wait_started(&f.st, &ids).await;
    let agents = ids_of(&spawned, "agentId");
    let sides = ids_of(&spawned, "sessionId");
    dispatch(&f.st, "agent.delete", json!({"agentId":f.parent})).await.unwrap();
    for agent in &agents { assert_eq!(f.st.db.agent_get(agent).unwrap()["archived"], true); }
    for side in &sides { assert_eq!(f.st.db.session_detail(side).unwrap()["archived"], true); }
    let cancels = f.adapter.cancels.lock().unwrap().clone();
    assert!(sides.iter().all(|side| cancels.contains(side)), "the ones still working were stopped: {cancels:?}");
    for id in &ids { end_turn(&f.st, id, "turn.cancelled").await; }
    for id in &ids { wait_for(&f.st, id, "cancelled").await; }
}

#[tokio::test]
async fn archiving_the_parent_conversation_archives_them() {
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    wait_started(&f.st, &ids_of(&spawned, "delegationId")).await;
    let side = spawned["subbots"][0]["sessionId"].as_str().unwrap();
    dispatch(&f.st, "session.archive", json!({"sessionId":"y-parent","archived":true})).await.unwrap();
    assert_eq!(f.st.db.session_detail(side).unwrap()["archived"], true);
    // The bot itself stays, so the owner can still read the conversation.
    assert_eq!(f.st.db.agent_get(spawned["subbots"][0]["agentId"].as_str().unwrap()).unwrap()["archived"], false);
}

#[tokio::test]
async fn purging_the_parent_removes_them() {
    let f = fixture().await;
    let spawned = ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["haiku"])).await);
    let agent = spawned["subbots"][0]["agentId"].as_str().unwrap().to_owned();
    for session in f.st.db.session_list(true).unwrap() { f.st.db.update_session_state(session["id"].as_str().unwrap(), "idle").unwrap(); }
    f.st.active_turns.lock().await.clear();
    assert!(dispatch(&f.st, "agent.purge", json!({"agentId":f.parent})).await.is_err(), "the existing confirm is still required");
    dispatch(&f.st, "agent.purge", json!({"agentId":f.parent,"confirm":true})).await.unwrap();
    assert!(f.st.db.agent_get(&agent).is_err());
    assert!(f.st.db.subbot_agents(None).unwrap().is_empty());
}

#[tokio::test]
async fn a_replayed_call_starts_nothing_twice() {
    let f = fixture().await;
    let args = spawn_args(&["haiku", "haiku"]);
    let first = ok(&bridge(&f.st, "y-parent", "spawn_subbots", args.clone()).await);
    let again = ok(&bridge(&f.st, "y-parent", "spawn_subbots", args).await);
    assert_eq!(ids_of(&first, "agentId"), ids_of(&again, "agentId"));
    assert_eq!(subbot_count(&f.st), 2);
}

#[tokio::test]
async fn the_roster_order_ignores_subbots() {
    let f = fixture().await;
    let second = f.st.db.agent_create(&json!({"name":"Second","runtimeId":"y-codex"})).unwrap().0;
    let before = f.st.db.agent_list(false, None).unwrap().iter().filter(|agent| agent["parentAgentId"].is_null()).map(|agent| agent["sortOrder"].clone()).collect::<Vec<_>>();
    ok(&bridge(&f.st, "y-parent", "spawn_subbots", spawn_args(&["luna"; 3])).await);
    let third = f.st.db.agent_create(&json!({"name":"Third","runtimeId":"y-codex"})).unwrap().0;
    assert_eq!(third["sortOrder"], json!(before.len()), "a new bot lands after the visible ones: {before:?} {second}");
    dispatch(&f.st, "agent.delete", json!({"agentId":second["id"]})).await.unwrap();
    let after = f.st.db.agent_list(false, None).unwrap().iter().filter(|agent| agent["parentAgentId"].is_null()).map(|agent| agent["sortOrder"].clone()).collect::<Vec<_>>();
    assert_eq!(after, vec![json!(0), json!(1)]);
}
