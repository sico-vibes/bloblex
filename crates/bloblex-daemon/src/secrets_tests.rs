// Phase 5, Sona S1: secrets in the credential store (section 5) and one-use secret
// requests (section 6). Included into `phase2a_tests` so it shares that module's
// fixtures: `state`, `state_with`, `dispatch`, `json!`, `Value`, `Uuid` and `Arc`. Test
// builds keep secrets in memory (`secrets::store`), so no test here touches the real
// store; only the round-trip test does, under a name nobody else uses.

use std::collections::BTreeMap;
use std::time::Duration as TestDuration;

/// A value no test output may ever contain.
const SEC_SENTINEL: &str = "hunter2-SEC_SENTINEL-value";

/// A fresh name, so tests sharing the in-memory store never meet.
fn sec_unique(prefix: &str) -> String { format!("{prefix}-{}", Uuid::new_v4().simple()) }

fn sec_bot(st: &AppState, name: &str) -> String {
    st.db.agent_create(&json!({"name": name, "runtimeId": "rt-test"})).unwrap().0["id"].as_str().unwrap().to_owned()
}

/// A bot with a conversation and a running turn, and a data folder for one-use files.
async fn sec_asking(st: &AppState, name: &str) -> (String, String, std::path::PathBuf) {
    let agent = sec_bot(st, name);
    let session = sec_unique("sec-session");
    st.db.create_session_for_agent(&session, "rt-test", "codex", ".", "Chat", Some(&agent)).unwrap();
    st.db.update_session_state(&session, "working").unwrap();
    st.active_turns.lock().await.insert(session.clone(), format!("turn-{session}"));
    let data = std::env::temp_dir().join(format!("bitbots-secrets-{}", Uuid::new_v4()));
    *st.team.data_dir.lock().unwrap() = Some(data.clone());
    (agent, session, data)
}

async fn sec_tool(st: &AppState, session: &str, name: &str, args: Value) -> Result<Value, DispatchError> {
    team::mcp_rpc(st, session, "mcp.tools.call", &json!({"name": name, "arguments": args})).await
}

fn sec_tool_text(result: &Value) -> String { result["content"][0]["text"].as_str().unwrap_or("").to_owned() }

async fn sec_open_requests(st: &AppState, session: &str) -> Vec<Value> {
    dispatch(st, "secret.request.list", json!({})).await.unwrap()["requests"].as_array().unwrap().iter().filter(|row| row["sessionId"] == session).cloned().collect()
}

async fn sec_wait_for_request(st: &AppState, session: &str) -> Value {
    for _ in 0..100 {
        if let Some(row) = sec_open_requests(st, session).await.into_iter().next() { return row; }
        tokio::time::sleep(TestDuration::from_millis(20)).await;
    }
    panic!("no request appeared for {session}");
}

fn sec_files_in(dir: &std::path::Path) -> usize { std::fs::read_dir(dir).map(|entries| entries.count()).unwrap_or(0) }

/// Everything a test can observe, as one string: every event the daemon pushed
/// and every message of the conversation.
fn sec_observable(st: &AppState, session: &str) -> String {
    let events = st.db.replay_events(0, 100_000).map(|events| json!(events).to_string()).unwrap_or_default();
    format!("{events}\n{}", st.db.session_detail(session).unwrap())
}

// ---------------------------------------------------------------------------
// Section 5

#[cfg(windows)]
#[test]
fn a_secret_round_trips_through_the_credential_store() {
    // Talks to the real Credential Manager under a name no one else uses, and removes it.
    let name = sec_unique("bitbots-test-roundtrip");
    if secrets::wincred::write(&name, SEC_SENTINEL.as_bytes()).is_err() { eprintln!("the credential store is unavailable here; skipping"); return; }
    let read = secrets::wincred::read(&name).unwrap().expect("the secret is there");
    assert_eq!(read.as_str(), SEC_SENTINEL);
    assert!(secrets::wincred::list().unwrap().iter().any(|(listed, at)| listed == &name && !at.is_empty()), "it is listed with a time");
    secrets::wincred::write(&name, b"second").unwrap();
    assert_eq!(secrets::wincred::read(&name).unwrap().unwrap().as_str(), "second", "an existing name is replaced");
    assert!(secrets::wincred::delete(&name).unwrap());
    assert!(secrets::wincred::read(&name).unwrap().is_none(), "it is gone");
    assert!(!secrets::wincred::delete(&name).unwrap(), "deleting a missing one says so");
}

#[tokio::test]
async fn there_is_no_way_to_read_a_value_back() {
    let (st, _) = state();
    let name = sec_unique("gh");
    assert_eq!(dispatch(&st, "secret.set", json!({"name": name, "value": SEC_SENTINEL})).await.unwrap_err().1.code, "invalid_argument", "no confirm, no write");
    let set = dispatch(&st, "secret.set", json!({"name": name, "value": SEC_SENTINEL, "confirm": true})).await.unwrap();
    assert_eq!(set, json!({"name": name}), "the reply holds no value");
    let listed = dispatch(&st, "secret.list", json!({})).await.unwrap();
    let row = listed["secrets"].as_array().unwrap().iter().find(|row| row["name"] == name).expect("listed").clone();
    let mut keys = row.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys, ["name", "updatedAt", "usedBy"]);
    assert!(!listed.to_string().contains(SEC_SENTINEL));
    for method in ["secret.get", "secret.read", "secret.value", "secret.reveal", "secret.export"] {
        assert!(matches!(dispatch(&st, method, json!({"name": name})).await.unwrap_err().1.code.as_str(), "not_found" | "unsupported"), "{method} must not exist");
    }
    for bad in [json!({"name": "has space", "value": "x", "confirm": true}), json!({"name": "", "value": "x", "confirm": true}), json!({"name": "a".repeat(65), "value": "x", "confirm": true}), json!({"name": name, "value": "", "confirm": true}), json!({"name": name, "value": "x".repeat(2049), "confirm": true})] {
        assert_eq!(dispatch(&st, "secret.set", bad).await.unwrap_err().1.code, "invalid_argument");
    }
    dispatch(&st, "secret.set", json!({"name": name, "value": "x".repeat(2048), "confirm": true})).await.expect("2,048 bytes is the limit");
}

#[tokio::test]
async fn a_value_never_reaches_storage_events_or_logs() {
    let dir = std::env::temp_dir().join(format!("bitbots-secret-db-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("bitbots.db");
    let (st, _) = state_with(Storage::open(&db_path).unwrap());
    let name = sec_unique("tok");
    dispatch(&st, "secret.set", json!({"name": name, "value": SEC_SENTINEL, "confirm": true})).await.unwrap();
    let agent = dispatch(&st, "agent.create", json!({"name": "Rae", "runtimeId": "rt-test", "envRefs": {"GITHUB_TOKEN": name}})).await.unwrap()["agent"].clone();
    let id = agent["id"].as_str().unwrap().to_owned();
    st.db.create_session_for_agent("sec-leak", "rt-test", "codex", ".", "Chat", Some(&id)).unwrap();
    // Use the secret the way a spawn does, then look everywhere.
    let mut env = BTreeMap::new();
    secrets::add_to_environment(&st, Some(&id), &mut env).unwrap();
    assert_eq!(env.get("GITHUB_TOKEN").map(String::as_str), Some(SEC_SENTINEL), "the spawn does get the value");
    let mut seen = vec![
        agent.to_string(),
        dispatch(&st, "agent.list", json!({})).await.unwrap().to_string(),
        dispatch(&st, "agent.get", json!({"agentId": id})).await.unwrap().to_string(),
        dispatch(&st, "secret.list", json!({})).await.unwrap().to_string(),
        dispatch(&st, "app.snapshot", json!({})).await.unwrap().to_string(),
        dispatch(&st, "backup.export", json!({})).await.unwrap().to_string(),
        dispatch(&st, "diagnostics.preview", json!({})).await.unwrap().to_string(),
        st.db.settings().unwrap().to_string(),
        sec_observable(&st, "sec-leak"),
        format!("{:?}", st.db.agent_get(&id).unwrap()),
    ];
    // The database file itself, with its write-ahead log.
    let mut files_read = 0;
    for entry in std::fs::read_dir(&dir).unwrap().flatten() { if let Ok(bytes) = std::fs::read(entry.path()) { files_read += 1; seen.push(String::from_utf8_lossy(&bytes).into_owned()); } }
    assert!(files_read >= 1, "the database file was read");
    for (index, text) in seen.iter().enumerate() { assert!(!text.contains(SEC_SENTINEL), "the value leaked into observation {index}"); }
    // The module never formats a value into a log: it logs nothing at all.
    let source = include_str!("secrets.rs");
    let banned = [["tra", "cing::"].concat(), ["print", "ln!"].concat(), ["d", "bg!"].concat()];
    assert!(banned.iter().all(|word| !source.contains(word.as_str())), "secrets.rs must not log");
}

#[tokio::test]
async fn env_refs_reach_the_spawn() {
    let (st, _) = state();
    let (a, b) = (sec_unique("alpha"), sec_unique("beta"));
    for (name, value) in [(&a, "value-a"), (&b, "value-b")] { dispatch(&st, "secret.set", json!({"name": name, "value": value, "confirm": true})).await.unwrap(); }
    let created = dispatch(&st, "agent.create", json!({"name": "Rae", "runtimeId": "rt-test", "customEnv": {"LANG": "en_GB.UTF-8"}, "envRefs": {"API_KEY": a, "GITHUB_TOKEN": b}})).await.unwrap()["agent"].clone();
    assert_eq!(created["envRefs"], json!({"API_KEY": a, "GITHUB_TOKEN": b}), "secret-looking variable names are allowed");
    let id = created["id"].as_str().unwrap();
    assert_eq!(dispatch(&st, "agent.get", json!({"agentId": id})).await.unwrap()["agent"]["envRefs"], created["envRefs"]);
    let mut env = BTreeMap::from([("LANG".to_owned(), "en_GB.UTF-8".to_owned())]);
    secrets::add_to_environment(&st, Some(id), &mut env).unwrap();
    assert_eq!(env.get("API_KEY").map(String::as_str), Some("value-a"));
    assert_eq!(env.get("GITHUB_TOKEN").map(String::as_str), Some("value-b"));
    assert_eq!(env.get("LANG").map(String::as_str), Some("en_GB.UTF-8"), "the plain environment stays");
    // An update that omits the field keeps the references; one that names them replaces them.
    dispatch(&st, "agent.update", json!({"agentId": id, "description": "x"})).await.unwrap();
    assert_eq!(dispatch(&st, "agent.get", json!({"agentId": id})).await.unwrap()["agent"]["envRefs"].as_object().unwrap().len(), 2);
    let updated = dispatch(&st, "agent.update", json!({"agentId": id, "envRefs": {"API_KEY": a}})).await.unwrap()["agent"].clone();
    assert_eq!(updated["envRefs"], json!({"API_KEY": a}));
    let mut env = BTreeMap::new();
    secrets::add_to_environment(&st, Some(id), &mut env).unwrap();
    assert_eq!(env.keys().collect::<Vec<_>>(), ["API_KEY"]);
    dispatch(&st, "agent.update", json!({"agentId": id, "envRefs": null})).await.unwrap();
    assert_eq!(dispatch(&st, "agent.get", json!({"agentId": id})).await.unwrap()["agent"]["envRefs"], json!({}));
}

#[tokio::test]
async fn a_missing_secret_fails_the_turn_with_its_name() {
    let (st, _) = state();
    let name = sec_unique("not-there");
    let id = dispatch(&st, "agent.create", json!({"name": "Rae", "runtimeId": "rt-test", "envRefs": {"GITHUB_TOKEN": name}})).await.unwrap()["agent"]["id"].as_str().unwrap().to_owned();
    let error = secrets::add_to_environment(&st, Some(&id), &mut BTreeMap::new()).unwrap_err();
    assert_eq!(error.1.code, "conflict");
    assert!(error.1.message.contains(&name), "{}", error.1.message);
    // The real path: a prompt in a conversation of this bot is refused before anything starts.
    st.db.create_session_for_agent("sec-missing", "rt-test", "codex", ".", "Chat", Some(&id)).unwrap();
    st.db.update_session_state("sec-missing", "idle").unwrap();
    let refused = dispatch(&st, "session.prompt", json!({"sessionId": "sec-missing", "text": "go"})).await.unwrap_err();
    assert!(refused.1.message.contains(&name), "the turn fails naming the secret: {}", refused.1.message);
}

#[tokio::test]
async fn delete_refuses_a_secret_in_use() {
    let (st, _) = state();
    let name = sec_unique("shared");
    dispatch(&st, "secret.set", json!({"name": name, "value": "v", "confirm": true})).await.unwrap();
    dispatch(&st, "agent.create", json!({"name": "Rae", "runtimeId": "rt-test", "envRefs": {"A_TOKEN": name}})).await.unwrap();
    dispatch(&st, "agent.create", json!({"name": "Sam", "runtimeId": "rt-test", "envRefs": {"B_TOKEN": name}})).await.unwrap();
    let listed = dispatch(&st, "secret.list", json!({})).await.unwrap();
    assert_eq!(listed["secrets"].as_array().unwrap().iter().find(|row| row["name"] == name).unwrap()["usedBy"], json!(["Rae", "Sam"]));
    assert_eq!(dispatch(&st, "secret.delete", json!({"name": name})).await.unwrap_err().1.code, "invalid_argument", "no confirm");
    let refused = dispatch(&st, "secret.delete", json!({"name": name, "confirm": true})).await.unwrap_err();
    assert_eq!(refused.1.code, "conflict");
    assert!(refused.1.message.contains("Rae") && refused.1.message.contains("Sam"), "{}", refused.1.message);
    let rae = st.db.agent_list(false, None).unwrap().into_iter().find(|agent| agent["name"] == "Rae").unwrap();
    dispatch(&st, "agent.update", json!({"agentId": rae["id"], "envRefs": {}})).await.unwrap();
    assert_eq!(dispatch(&st, "secret.delete", json!({"name": name, "confirm": true})).await.unwrap_err().1.code, "conflict", "one bot still uses it");
    let sam = st.db.agent_list(false, None).unwrap().into_iter().find(|agent| agent["name"] == "Sam").unwrap();
    dispatch(&st, "agent.update", json!({"agentId": sam["id"], "envRefs": {}})).await.unwrap();
    assert_eq!(dispatch(&st, "secret.delete", json!({"name": name, "confirm": true})).await.unwrap(), json!({"deleted": true}));
    assert!(secrets::store::read(&name).unwrap().is_none());
}

#[tokio::test]
async fn dangerous_env_keys_stay_refused() {
    let (st, _) = state();
    let name = sec_unique("fine");
    for key in ["PATH", "path", "SystemRoot", "COMSPEC", "PATHEXT", "NODE_OPTIONS", "LD_PRELOAD", "CODEX_HOME", "BITBOTS_HOOK_BRIDGE", "bloblex_x", "HAS SPACE", "1LEADING", "WITH=EQUALS", ""] {
        let created = dispatch(&st, "agent.create", json!({"name": "Bad", "runtimeId": "rt-test", "envRefs": {key: name}})).await;
        assert_eq!(created.unwrap_err().1.code, "invalid_argument", "{key:?} must be refused");
    }
    for bad in [json!({"A_TOKEN": "bad name"}), json!({"A_TOKEN": 5}), json!([]), json!("x")] {
        assert_eq!(dispatch(&st, "agent.create", json!({"name": "Bad", "runtimeId": "rt-test", "envRefs": bad})).await.unwrap_err().1.code, "invalid_argument");
    }
    assert_eq!(dispatch(&st, "agent.create", json!({"name": "Bad", "runtimeId": "rt-test", "envRefs": {"A_TOKEN": name, "a_token": name}})).await.unwrap_err().1.code, "invalid_argument", "one reference per variable");
    assert!(st.db.agent_list(false, None).unwrap().iter().all(|agent| agent["name"] != "Bad"), "a refused create leaves no bot");
    dispatch(&st, "agent.create", json!({"name": "Fine", "runtimeId": "rt-test", "envRefs": {"MY_API_KEY": name}})).await.unwrap();
    // customEnv keeps its own, stricter rules.
    assert_eq!(dispatch(&st, "agent.create", json!({"name": "Bad", "runtimeId": "rt-test", "customEnv": {"GITHUB_TOKEN": "x"}})).await.unwrap_err().1.code, "invalid_argument");
}

#[tokio::test]
async fn backups_carry_only_the_keys() {
    let (st, _) = state();
    let name = sec_unique("backup-secret");
    dispatch(&st, "secret.set", json!({"name": name, "value": SEC_SENTINEL, "confirm": true})).await.unwrap();
    dispatch(&st, "agent.create", json!({"name": "Rae", "runtimeId": "rt-test", "envRefs": {"GITHUB_TOKEN": name}})).await.unwrap();
    let export = dispatch(&st, "backup.export", json!({})).await.unwrap();
    let text = export.to_string();
    assert!(!text.contains(SEC_SENTINEL) && !text.contains(&name), "neither the value nor the secret's name is in a backup");
    assert!(text.contains("envRefKeys"), "the keys are: {text}");
    assert!(text.contains("\"envRefKeys\":[\"GITHUB_TOKEN\"]"), "{text}");
    assert!(!text.contains("\"envRefs\""), "no references travel");
}

#[test]
fn devices_see_no_env_refs() {
    use crate::remote::policy::{redact_result, RedactOptions};
    let agent = json!({"id": "a_1", "name": "Rae", "envRefs": {"GITHUB_TOKEN": "gh-main"}, "customEnv": {"LANG": "en"}});
    for (method, input) in [("agent.get", json!({"agent": agent.clone()})), ("agent.list", json!({"agents": [agent.clone()]}))] {
        let out = redact_result(method, &input, &RedactOptions::default()).to_string();
        assert!(!out.contains("envRefs") && !out.contains("gh-main") && !out.contains("GITHUB_TOKEN"), "{method}: {out}");
    }
}

// ---------------------------------------------------------------------------
// Section 6

#[tokio::test]
async fn a_bot_can_ask_and_the_turn_waits() {
    let (st, mut events) = state();
    let (_, session, _) = sec_asking(&st, "Rae").await;
    let listed = team::mcp_rpc(&st, &session, "mcp.tools.list", &json!({})).await.unwrap();
    assert!(listed["tools"].as_array().unwrap().iter().any(|tool| tool["name"] == "request_secret"), "the tool is offered");
    let (st2, session2) = (st.clone(), session.clone());
    let call = tokio::spawn(async move { sec_tool(&st2, &session2, "request_secret", json!({"name": "GITHUB_TOKEN", "reason": "Push the branch."})).await });
    let row = sec_wait_for_request(&st, &session).await;
    assert_eq!((row["name"].as_str(), row["reason"].as_str(), row["botName"].as_str()), (Some("GITHUB_TOKEN"), Some("Push the branch."), Some("Rae")));
    assert!(row["id"].is_string() && row["expiresAt"].is_string());
    tokio::time::sleep(TestDuration::from_millis(400)).await;
    assert!(!call.is_finished(), "the turn waits while the owner has not answered");
    let mut saw_pending = false;
    while let Ok(event) = events.try_recv() { if event.event_type == "secret.request.changed" && event.payload["status"] == "pending" { saw_pending = true; assert_eq!(event.payload["name"], "GITHUB_TOKEN"); } }
    assert!(saw_pending, "the window is told");
    for bad in [json!({"name": "has space", "reason": "x"}), json!({"name": "OK", "reason": ""}), json!({"name": "OK", "reason": "x".repeat(301)}), json!({"name": "OK"}), json!({"name": "OK", "reason": "x", "extra": 1})] {
        assert_eq!(sec_tool(&st, &session, "request_secret", bad).await.unwrap()["isError"], true);
    }
    let again = sec_tool(&st, &session, "request_secret", json!({"name": "OTHER", "reason": "x"})).await.unwrap();
    assert_eq!(again["isError"], true, "one open request per conversation");
    dispatch(&st, "secret.request.decline", json!({"id": row["id"]})).await.unwrap();
    call.await.unwrap().unwrap();
}

#[tokio::test]
async fn the_value_reaches_a_private_file_only() {
    let (st, _) = state();
    let (_, session, data) = sec_asking(&st, "Rae").await;
    let (st2, session2) = (st.clone(), session.clone());
    let call = tokio::spawn(async move { sec_tool(&st2, &session2, "request_secret", json!({"name": "GITHUB_TOKEN", "reason": "Push."})).await });
    let row = sec_wait_for_request(&st, &session).await;
    assert_eq!(dispatch(&st, "secret.request.answer", json!({"id": row["id"], "value": ""})).await.unwrap_err().1.code, "invalid_argument");
    dispatch(&st, "secret.request.answer", json!({"id": row["id"], "value": SEC_SENTINEL})).await.unwrap();
    let result = call.await.unwrap().unwrap();
    let text = sec_tool_text(&result);
    assert!(result["isError"].is_null(), "{text}");
    assert!(!text.contains(SEC_SENTINEL), "the tool result holds the path, never the value");
    let path = data.join("one-use").join(row["id"].as_str().unwrap());
    assert!(text.contains(path.to_str().unwrap()), "{text}");
    assert!(text.contains("GITHUB_TOKEN") && text.contains("don't print it"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), SEC_SENTINEL);
    assert!(sec_open_requests(&st, &session).await.is_empty(), "the request is closed");
    assert_eq!(dispatch(&st, "secret.request.answer", json!({"id": row["id"], "value": "again"})).await.unwrap_err().1.code, "conflict", "one answer only");
    let notice = st.db.session_detail(&session).unwrap()["messages"].as_array().unwrap().iter().find(|message| message["role"] == "notice").cloned().expect("a notice");
    assert_eq!(notice["content"], "You gave Rae GITHUB_TOKEN for this turn.");
    assert_eq!(sec_files_in(&data.join("one-use")), 1, "the file is the only place");
    st.active_turns.lock().await.remove(&session);
}

#[tokio::test]
async fn the_file_is_gone_when_the_turn_ends() {
    let (st, _) = state();
    let (_, session, data) = sec_asking(&st, "Rae").await;
    let (st2, session2) = (st.clone(), session.clone());
    let call = tokio::spawn(async move { sec_tool(&st2, &session2, "request_secret", json!({"name": "GITHUB_TOKEN", "reason": "Push."})).await });
    let row = sec_wait_for_request(&st, &session).await;
    dispatch(&st, "secret.request.answer", json!({"id": row["id"], "value": SEC_SENTINEL})).await.unwrap();
    call.await.unwrap().unwrap();
    let path = data.join("one-use").join(row["id"].as_str().unwrap());
    tokio::time::sleep(TestDuration::from_millis(600)).await;
    assert!(path.exists(), "the file stays while the turn runs");
    st.active_turns.lock().await.remove(&session);
    for _ in 0..40 { if !path.exists() { break; } tokio::time::sleep(TestDuration::from_millis(100)).await; }
    assert!(!path.exists(), "the file is deleted when the turn ends");
}

#[test]
fn leftover_files_go_at_startup() {
    let data = std::env::temp_dir().join(format!("bitbots-leftover-{}", Uuid::new_v4()));
    let folder = data.join("one-use");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("left-behind"), SEC_SENTINEL).unwrap();
    std::fs::write(folder.join("another"), SEC_SENTINEL).unwrap();
    std::fs::write(data.join("keep-me.txt"), "other data").unwrap();
    secrets::sweep_leftovers(&data);
    assert_eq!(sec_files_in(&folder), 0, "every leftover is deleted");
    assert!(data.join("keep-me.txt").exists(), "nothing outside the folder is touched");
    secrets::sweep_leftovers(&data.join("missing"));
}

#[tokio::test]
async fn cancel_ends_the_request() {
    let (st, mut events) = state();
    let (_, session, _) = sec_asking(&st, "Rae").await;
    let (st2, session2) = (st.clone(), session.clone());
    let call = tokio::spawn(async move { sec_tool(&st2, &session2, "request_secret", json!({"name": "GITHUB_TOKEN", "reason": "Push."})).await });
    let row = sec_wait_for_request(&st, &session).await;
    st.active_turns.lock().await.remove(&session);
    let result = call.await.unwrap().unwrap();
    assert_eq!(result["isError"], true);
    assert!(sec_tool_text(&result).contains("turn ended"), "{}", sec_tool_text(&result));
    assert!(sec_open_requests(&st, &session).await.is_empty());
    assert_eq!(dispatch(&st, "secret.request.answer", json!({"id": row["id"], "value": SEC_SENTINEL})).await.unwrap_err().1.code, "conflict", "a cancelled request takes no answer");
    let mut statuses = Vec::new();
    while let Ok(event) = events.try_recv() { if event.event_type == "secret.request.changed" { statuses.push(event.payload["status"].as_str().unwrap_or("").to_owned()); } }
    assert_eq!(statuses, ["pending", "cancelled"]);
}

#[tokio::test]
async fn the_wait_has_a_limit() {
    let (st, _) = state();
    let (_, session, data) = sec_asking(&st, "Rae").await;
    let args = json!({"name": "GITHUB_TOKEN", "reason": "Push."});
    let text = secrets::request_secret_with(&st, &session, &args, TestDuration::from_millis(600)).await.unwrap();
    assert!(text.contains("did not answer in time"), "{text}");
    assert!(sec_open_requests(&st, &session).await.is_empty());
    assert_eq!(sec_files_in(&data.join("one-use")), 0);
}

#[tokio::test]
async fn a_declined_request_tells_the_bot() {
    let (st, _) = state();
    let (_, session, data) = sec_asking(&st, "Rae").await;
    let (st2, session2) = (st.clone(), session.clone());
    let call = tokio::spawn(async move { sec_tool(&st2, &session2, "request_secret", json!({"name": "GITHUB_TOKEN", "reason": "Push."})).await });
    let row = sec_wait_for_request(&st, &session).await;
    dispatch(&st, "secret.request.decline", json!({"id": row["id"]})).await.unwrap();
    let result = call.await.unwrap().unwrap();
    assert!(result["isError"].is_null());
    assert!(sec_tool_text(&result).contains("declined"), "{}", sec_tool_text(&result));
    assert_eq!(sec_files_in(&data.join("one-use")), 0, "a decline writes no file");
    assert_eq!(dispatch(&st, "secret.request.decline", json!({"id": row["id"]})).await.unwrap_err().1.code, "conflict");
}

#[tokio::test]
async fn an_unattended_turn_is_refused_without_asking() {
    let (st, _) = state();
    let agent = sec_bot(&st, "Rae");
    let unattended = |id: &str, link: Value| {
        st.db.create_session_for_agent(id, "rt-test", "codex", ".", "Chat", Some(&agent)).unwrap();
        st.db.set_session_link(id, &link).unwrap();
    };
    unattended("sec-auto", json!({"kind": "automation"}));
    unattended("sec-task", json!({"kind": "task", "unattended": true}));
    unattended("sec-origin", json!({"kind": "automation"}));
    unattended("sec-side", json!({"kind": "side", "peerAgentId": "peer", "originSessionId": "sec-origin"}));
    for session in ["sec-auto", "sec-task", "sec-side"] {
        st.active_turns.lock().await.insert(session.to_owned(), format!("turn-{session}"));
        let listed = team::mcp_rpc(&st, session, "mcp.tools.list", &json!({})).await.unwrap();
        assert!(!listed["tools"].as_array().unwrap().iter().any(|tool| tool["name"] == "request_secret"), "{session}: not offered");
        let outcome = sec_tool(&st, session, "request_secret", json!({"name": "GITHUB_TOKEN", "reason": "Push."})).await;
        match outcome {
            Ok(result) => { assert_eq!(result["isError"], true); assert!(sec_tool_text(&result).contains("nobody is watching"), "{session}: {}", sec_tool_text(&result)); }
            Err(error) => assert_eq!(error.1.code, "forbidden", "{session}"),
        }
        assert!(sec_open_requests(&st, session).await.is_empty(), "{session}: nothing was asked");
    }
}

#[tokio::test]
async fn full_access_does_not_answer_it() {
    let (st, _) = state();
    let (agent, session, _) = sec_asking(&st, "Rae").await;
    st.db.agent_update(&agent, &json!({"approvalMode": "bypass"})).unwrap();
    let (st2, session2) = (st.clone(), session.clone());
    let call = tokio::spawn(async move { sec_tool(&st2, &session2, "request_secret", json!({"name": "GITHUB_TOKEN", "reason": "Push."})).await });
    let row = sec_wait_for_request(&st, &session).await;
    tokio::time::sleep(TestDuration::from_millis(600)).await;
    assert!(!call.is_finished(), "Full access leaves the request waiting for the owner");
    assert_eq!(sec_open_requests(&st, &session).await.len(), 1);
    dispatch(&st, "secret.request.decline", json!({"id": row["id"]})).await.unwrap();
    call.await.unwrap().unwrap();
}

#[tokio::test]
async fn the_value_is_in_no_message_event_or_log() {
    let (st, _) = state();
    let (_, session, data) = sec_asking(&st, "Rae").await;
    let (st2, session2) = (st.clone(), session.clone());
    let call = tokio::spawn(async move { sec_tool(&st2, &session2, "request_secret", json!({"name": "GITHUB_TOKEN", "reason": "Push."})).await });
    let row = sec_wait_for_request(&st, &session).await;
    dispatch(&st, "secret.request.answer", json!({"id": row["id"], "value": SEC_SENTINEL})).await.unwrap();
    let result = call.await.unwrap().unwrap();
    assert!(!result.to_string().contains(SEC_SENTINEL));
    let everything = [
        sec_observable(&st, &session),
        dispatch(&st, "secret.request.list", json!({})).await.unwrap().to_string(),
        dispatch(&st, "app.snapshot", json!({})).await.unwrap().to_string(),
        dispatch(&st, "diagnostics.preview", json!({})).await.unwrap().to_string(),
        st.db.settings().unwrap().to_string(),
    ];
    for (index, text) in everything.iter().enumerate() { assert!(!text.contains(SEC_SENTINEL), "the value leaked into observation {index}"); }
    // Only the one file holds it, and only until the turn ends.
    let holders = std::fs::read_dir(data.join("one-use")).unwrap().flatten().filter(|entry| std::fs::read_to_string(entry.path()).is_ok_and(|text| text.contains(SEC_SENTINEL))).count();
    assert_eq!(holders, 1);
    st.active_turns.lock().await.remove(&session);
}

#[test]
fn a_device_cannot_answer() {
    use crate::remote::policy::{authorize, Decision, RemoteCall, Tier};
    for method in ["secret.request.answer", "secret.request.decline", "secret.request.list", "secret.list", "secret.set", "secret.delete"] {
        for tier in [Tier::Viewer, Tier::Chat, Tier::Operator] {
            let call = RemoteCall { tier, approvals_from_remote: true, method: method.to_owned(), params: json!({"id": "x", "value": SEC_SENTINEL}), quiet_hours: false };
            assert!(matches!(authorize(&call), Decision::Denied { .. }), "{method} must be denied at every tier");
        }
    }
}
