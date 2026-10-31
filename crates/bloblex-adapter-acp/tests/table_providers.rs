//! A provider that is only a row in `bloblex-runtime`'s table runs through this
//! adapter exactly as OpenCode does: sessions, turns and approvals. These tests
//! are the reason a new ACP provider needs no adapter code at all.

use bloblex_adapter_acp::AcpAdapter;
use bloblex_agent_core::{AgentAdapter, AgentEvent, ExecOptions, NewSessionRequest, PromptRequest, RuntimeSpec};
use std::{path::PathBuf, process::Command, sync::Arc, time::Duration};

const EVENT_TIMEOUT: Duration = Duration::from_secs(10);

fn fixture() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("fake-acp-agent.mjs").to_string_lossy().into_owned()
}

/// A runtime for one provider, with the fixture standing in for its CLI. The
/// adapter appends the provider's own ACP flag after these arguments, which is
/// what the fixture ignores.
fn runtime_for(provider: &str, mode: &str) -> RuntimeSpec {
    assert!(Command::new("node").arg("--version").output().is_ok(), "Node.js is required for fake ACP child tests");
    RuntimeSpec { runtime_id: format!("fixture-{provider}"), provider: provider.into(), executable: PathBuf::from("node"), args: vec![fixture(), mode.into()], cwd: None }
}

async fn open(provider: &str, mode: &str, session_id: &str) -> (Arc<AcpAdapter>, bloblex_agent_core::SessionHandle, tokio::sync::mpsc::Receiver<AgentEvent>) {
    let adapter = Arc::new(AcpAdapter::default());
    let (tx, rx) = tokio::sync::mpsc::channel(64);
    let handle = adapter
        .new_session(
            &runtime_for(provider, mode),
            NewSessionRequest { session_id: session_id.into(), project_path: std::env::current_dir().unwrap(), exec_options: ExecOptions::default() },
            tx,
        )
        .await
        .expect("the fixture answers session/new");
    (adapter, handle, rx)
}

fn prompt(adapter: &Arc<AcpAdapter>, handle: &bloblex_agent_core::SessionHandle, text: &'static str) -> tokio::task::JoinHandle<Result<(), bloblex_agent_core::AdapterError>> {
    let adapter = adapter.clone();
    let handle = handle.clone();
    tokio::spawn(async move {
        adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: format!("turn-{text}"), text: text.into(), exec_options: Default::default() }).await
    })
}

#[tokio::test]
async fn a_table_provider_runs_a_turn() {
    let (adapter, handle, mut events) = open("gemini", "success", "table-gemini-turn").await;
    let turn = prompt(&adapter, &handle, "Return fixture text");
    let mut saw_delta = false;
    let mut completed = false;
    while let Ok(Some(event)) = tokio::time::timeout(EVENT_TIMEOUT, events.recv()).await {
        match event {
            AgentEvent::AssistantDelta { text } if text.starts_with("fixture response:") => saw_delta = true,
            AgentEvent::TurnCompleted => { completed = true; break; }
            _ => {}
        }
    }
    turn.await.expect("the prompt call returns").expect("a Gemini turn completes");
    assert!(saw_delta, "the provider's text reaches the daemon");
    assert!(completed, "and the turn completes");
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn a_table_provider_asks_for_approval() {
    let (adapter, handle, mut events) = open("qwen", "permission", "table-qwen-approval").await;
    let turn = prompt(&adapter, &handle, "Ask permission");
    let request_id = loop {
        let event = tokio::time::timeout(EVENT_TIMEOUT, events.recv()).await.expect("an event arrives").expect("the channel stays open");
        // The same choices OpenCode asks with: a table provider is not given a
        // different approval vocabulary.
        if let AgentEvent::PermissionRequested { provider_request_id, choices, .. } = event {
            assert_eq!(choices, vec!["allow_once", "reject_once"]);
            break provider_request_id;
        }
    };
    adapter.reply_permission(&request_id, "allow_once").await.expect("the approval reaches the provider");
    turn.await.expect("the prompt call returns").expect("the approved turn completes");
    assert!(matches!(tokio::time::timeout(EVENT_TIMEOUT, events.recv()).await, Ok(Some(AgentEvent::TurnCompleted))));
    // One decision per request, as before.
    assert!(adapter.reply_permission(&request_id, "allow_once").await.is_err());
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn opencode_still_behaves_as_before() {
    // The table must not reach OpenCode: it keeps the `acp` subcommand it has
    // always used, and a plain turn behaves exactly as it did.
    assert_eq!(bloblex_runtime::acp_launch_args("opencode"), &["acp"]);
    let (adapter, handle, mut events) = open("opencode", "success", "opencode-unchanged").await;
    let turn = prompt(&adapter, &handle, "Return fixture text");
    let mut saw_delta = false;
    while let Ok(Some(event)) = tokio::time::timeout(EVENT_TIMEOUT, events.recv()).await {
        match event {
            AgentEvent::AssistantDelta { text } if text.starts_with("fixture response:") => saw_delta = true,
            AgentEvent::TurnCompleted => break,
            _ => {}
        }
    }
    turn.await.expect("the prompt call returns").expect("an OpenCode turn still completes");
    assert!(saw_delta);
    adapter.close_session(&handle).await.unwrap();
}
