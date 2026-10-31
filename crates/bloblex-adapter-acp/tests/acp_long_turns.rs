//! A turn has no timer; giving up on one stops it; a failed prompt says why.
use bloblex_adapter_acp::AcpAdapter;
use bloblex_agent_core::{AgentAdapter, AgentEvent, ExecOptions, NewSessionRequest, PromptRequest, RuntimeSpec, SessionHandle};
use serde_json::Value;
use std::{path::{Path, PathBuf}, sync::Arc, time::{Duration, Instant}};
use tokio::sync::mpsc;

fn peer() -> PathBuf {
    if let Some(path) = std::env::var_os("CARGO_BIN_EXE_fake_acp_peer") { return PathBuf::from(path); }
    let exe = std::env::current_exe().expect("test executable");
    let debug_dir = exe.parent().and_then(|dir| dir.parent()).expect("cargo debug dir");
    let windows = debug_dir.join("fake-acp-peer.exe");
    if windows.exists() { windows } else { debug_dir.join("fake-acp-peer") }
}

fn temp_dir(label: &str) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let dir = std::env::temp_dir().join(format!("bloblex-acp-long-{label}-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn open(adapter: &AcpAdapter, args: Vec<String>) -> (SessionHandle, mpsc::Receiver<AgentEvent>) {
    let (tx, rx) = mpsc::channel(64);
    let runtime = RuntimeSpec { runtime_id: "fixture".into(), provider: "opencode".into(), executable: peer(), args, cwd: None };
    let handle = adapter
        .new_session(&runtime, NewSessionRequest { session_id: "long-turn".into(), project_path: std::env::temp_dir(), exec_options: ExecOptions::default() }, tx)
        .await
        .unwrap();
    (handle, rx)
}

fn prompt_request() -> PromptRequest {
    PromptRequest { attachments: Vec::new(), turn_id: "turn-long".into(), text: "go".into(), exec_options: ExecOptions::default() }
}

fn trace(record: &Path) -> Vec<String> {
    std::fs::read(record)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|value| value["rpc"].as_array().cloned().unwrap_or_default().iter().filter_map(|entry| entry["method"].as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

async fn wait_for_call(record: &Path, method: &str) {
    let started = Instant::now();
    while !trace(record).iter().any(|call| call == method) {
        assert!(started.elapsed() < Duration::from_secs(10), "{method} was never sent");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The short timeout is one setting for the whole process, so these tests run one at a time.
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn a_long_opencode_prompt_is_not_failed_by_a_timer() {
    let _one_at_a_time = ONE_AT_A_TIME.lock().await;
    let dir = temp_dir("long");
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), dir.join("record.json").to_string_lossy().into_owned(), "--prompt-delay-ms".into(), "1500".into()];
    let (handle, mut events) = open(&adapter, args).await;
    // Other requests are now cut to 300 ms; the prompt, answered after 1.5 s, still succeeds.
    bloblex_adapter_acp::TEST_REQUEST_TIMEOUT_MS.store(300, std::sync::atomic::Ordering::Relaxed);
    let started = Instant::now();
    let result = adapter.prompt(&handle, prompt_request()).await;
    bloblex_adapter_acp::TEST_REQUEST_TIMEOUT_MS.store(0, std::sync::atomic::Ordering::Relaxed);
    result.expect("a slow turn is not a failure");
    assert!(started.elapsed() >= Duration::from_millis(1400), "the turn really was slow");
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() { seen.push(event); }
    assert!(seen.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    assert!(!seen.iter().any(|event| matches!(event, AgentEvent::Error { .. })));
    assert!(!trace(&dir.join("record.json")).iter().any(|call| call == "session/cancel"), "nothing was cancelled");
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn giving_up_on_an_opencode_turn_cancels_it() {
    // The daemon's silence watchdog gives up by closing the conversation; the turn must be told to stop first.
    let _one_at_a_time = ONE_AT_A_TIME.lock().await;
    let dir = temp_dir("giveup");
    let record = dir.join("record.json");
    let adapter = Arc::new(AcpAdapter::default());
    let args = vec!["--record".into(), record.to_string_lossy().into_owned(), "--usage".into(), "cancel".into()];
    let (handle, _events) = open(&adapter, args).await;
    let running = {
        let (adapter, handle) = (Arc::clone(&adapter), handle.clone());
        tokio::spawn(async move { adapter.prompt(&handle, prompt_request()).await })
    };
    wait_for_call(&record, "session/prompt").await;
    adapter.close_session(&handle).await.unwrap();
    let calls = trace(&record);
    let cancel = calls.iter().position(|call| call == "session/cancel").expect("session/cancel was sent");
    let close = calls.iter().position(|call| call == "session/close");
    assert!(close.is_none_or(|close| cancel < close), "the turn is stopped before the conversation is closed: {calls:?}");
    let _ = tokio::time::timeout(Duration::from_secs(10), running).await.expect("the prompt call ends once the turn is stopped");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_busy_refusal_says_so_and_leaves_the_previous_turn_running() {
    let _one_at_a_time = ONE_AT_A_TIME.lock().await;
    let dir = temp_dir("busy");
    let record = dir.join("record.json");
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), record.to_string_lossy().into_owned(), "--usage".into(), "busy".into()];
    let (handle, mut events) = open(&adapter, args).await;
    adapter.prompt(&handle, prompt_request()).await.unwrap_err();
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() { seen.push(event); }
    let message = seen.iter().find_map(|event| match event { AgentEvent::Error { message } => Some(message.clone()), _ => None }).expect("an Error event");
    assert!(message.starts_with("OpenCode is still working on the previous message."), "{message}");
    wait_for_call(&record, "session/prompt").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!trace(&record).iter().any(|call| call == "session/cancel"), "the turn that is still running is not ours to stop");
    let _ = adapter.close_session(&handle).await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_failed_opencode_prompt_reports_the_providers_reason() {
    let _one_at_a_time = ONE_AT_A_TIME.lock().await;
    let dir = temp_dir("reason");
    let record = dir.join("record.json");
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), record.to_string_lossy().into_owned(), "--usage".into(), "error".into()];
    let (handle, mut events) = open(&adapter, args).await;
    let error = adapter.prompt(&handle, prompt_request()).await.unwrap_err();
    assert!(!error.to_string().contains("provider failed"), "the returned error stays fixed; the reason travels on the event");
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() { seen.push(event); }
    let message = seen.iter().find_map(|event| match event { AgentEvent::Error { message } => Some(message.clone()), _ => None }).expect("an Error event");
    assert_eq!(message, "OpenCode prompt failed: provider failed");
    // Bitbots has given up on the turn, so the agent is told to stop it.
    wait_for_call(&record, "session/cancel").await;
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}
