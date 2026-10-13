//! Wire-replay scenarios for the Codex adapter. Each test drives the real
//! adapter against `fake_codex_server --replay <fixture>` and asserts the
//! normalised `AgentEvent` sequence. Fixtures are synthesised from the fake's
//! own output; see `docs/evidence/wire-fixtures.md`.
use bloblex_adapter_codex::CodexAdapter;
use bloblex_agent_core::{
    AdapterError, AgentAdapter, AgentEvent, ExecOptions, NewSessionRequest, PromptRequest,
    RecoveryHintKind, ResumeSessionRequest, RuntimeSpec, SteerOutcome, SteerRequest,
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::mpsc;

const PROVIDER: &str = "codex";
const CODEX_VERSION: &str = "0.159.3";

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/wire/fixtures")
}

fn fixture(name: &str) -> PathBuf {
    fixtures_dir().join(name)
}

/// Normal runs replay `fixture`. When `BLOBLEX_WIRE_RECORD` is exported the
/// fake runs live and records to this scenario's fixture instead (developer
/// regeneration; run with `--test-threads=1`).
fn fake_args(name: &str, extra: &[&str]) -> Vec<String> {
    if std::env::var_os("BLOBLEX_WIRE_RECORD").is_some() {
        std::fs::create_dir_all(fixture(name).parent().unwrap()).unwrap();
        unsafe {
            std::env::set_var("BLOBLEX_WIRE_RECORD", fixture(name));
            std::env::set_var("BLOBLEX_WIRE_SCENARIO", name);
        }
        return extra.iter().map(|value| (*value).to_owned()).collect();
    }
    let mut args = vec![
        "--replay".to_owned(),
        fixture(name).to_string_lossy().into_owned(),
    ];
    args.extend(extra.iter().map(|value| (*value).to_owned()));
    args
}

fn workspace() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "bloblex-codex-wire-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn runtime(name: &str, mode: Option<&str>) -> (RuntimeSpec, PathBuf) {
    let root = workspace();
    let extra: Vec<&str> = match mode {
        Some(mode) => vec!["--mode", mode],
        None => Vec::new(),
    };
    let runtime = RuntimeSpec {
        runtime_id: "wire".into(),
        provider: PROVIDER.into(),
        executable: PathBuf::from(env!("CARGO_BIN_EXE_fake_codex_server")),
        args: fake_args(name, &extra),
        cwd: Some(root.clone()),
    };
    (runtime, root)
}

fn request(session_id: &str, project_path: PathBuf) -> NewSessionRequest {
    NewSessionRequest {
        session_id: session_id.into(),
        project_path,
        exec_options: ExecOptions::default(),
    }
}

async fn next_event(rx: &mut mpsc::Receiver<AgentEvent>) -> AgentEvent {
    tokio::time::timeout(Duration::from_secs(20), rx.recv())
        .await
        .expect("an event arrives within the timeout")
        .expect("the adapter event channel stays open")
}

async fn collect_until_terminal(rx: &mut mpsc::Receiver<AgentEvent>) -> Vec<AgentEvent> {
    let mut seen = Vec::new();
    loop {
        let event = next_event(rx).await;
        let done = matches!(event, AgentEvent::TurnCompleted | AgentEvent::Error { .. });
        seen.push(event);
        if done {
            return seen;
        }
    }
}

async fn prompt(adapter: &CodexAdapter, handle: &bloblex_agent_core::SessionHandle, turn_id: &str, text: &str) {
    adapter
        .prompt(
            handle,
            PromptRequest {
                attachments: Vec::new(),
                turn_id: turn_id.into(),
                text: text.into(),
                exec_options: ExecOptions::default(),
            },
        )
        .await
        .unwrap();
}

async fn settle(root: &Path) {
    tokio::time::sleep(Duration::from_millis(250)).await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn codex_simple_turn_replays_a_completed_turn() {
    let (runtime, root) = runtime("simple-turn.ndjson", None);
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = mpsc::channel(64);
    let handle = adapter
        .new_session(&runtime, request("wire-simple", root.clone()), tx)
        .await
        .unwrap();
    prompt(&adapter, &handle, "turn-simple", "hello").await;
    let seen = collect_until_terminal(&mut rx).await;
    assert!(
        seen.iter().any(|event| matches!(event, AgentEvent::UsageReport { report, .. } if report.input_tokens == Some(7) && report.reasoning_tokens == Some(3))),
        "reported token usage reaches the adapter: {seen:?}"
    );
    assert!(seen.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    adapter.close_session(&handle).await.unwrap();
    adapter.shutdown().await;
    settle(&root).await;
}

#[tokio::test]
async fn codex_turn_steer_is_accepted() {
    let (runtime, root) = runtime("turn-steer-accepted.ndjson", None);
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = mpsc::channel(64);
    let handle = adapter
        .new_session(&runtime, request("wire-steer", root.clone()), tx)
        .await
        .unwrap();
    prompt(&adapter, &handle, "turn-steer", "hello").await;
    let outcome = adapter
        .steer(
            &handle,
            SteerRequest {
                turn_id: "turn-steer".into(),
                text: "add this".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(outcome, SteerOutcome::Accepted);
    let _ = collect_until_terminal(&mut rx).await;
    adapter.close_session(&handle).await.unwrap();
    adapter.shutdown().await;
    settle(&root).await;
}

#[tokio::test]
async fn codex_server_overloaded_turn_emits_a_recovery_hint() {
    let (runtime, root) = runtime("server-overloaded.ndjson", Some("fail-overload"));
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = mpsc::channel(64);
    let handle = adapter
        .new_session(&runtime, request("wire-overload", root.clone()), tx)
        .await
        .unwrap();
    prompt(&adapter, &handle, "turn-overload", "hello").await;
    let seen = collect_until_terminal(&mut rx).await;
    let hint = seen.iter().position(|event| {
        matches!(event, AgentEvent::RecoveryHint { kind: RecoveryHintKind::Overloaded, .. })
    });
    let error = seen.iter().position(|event| matches!(event, AgentEvent::Error { .. }));
    assert!(
        matches!((hint, error), (Some(hint), Some(error)) if hint < error),
        "an overload hint precedes the terminal error: {seen:?}"
    );
    assert!(!seen.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    adapter.close_session(&handle).await.unwrap();
    adapter.shutdown().await;
    settle(&root).await;
}

#[tokio::test]
async fn codex_rejected_resume_is_reported() {
    let (runtime, root) = runtime("resume-rejected.ndjson", Some("resume-reject"));
    let adapter = CodexAdapter::default();
    let (tx, _rx) = mpsc::channel(16);
    let result = adapter
        .resume_session(
            &runtime,
            ResumeSessionRequest {
                session_id: "wire-resume".into(),
                provider_session_id: "00000000-0000-4000-8000-000000000000".into(),
                project_path: root.clone(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await;
    assert!(matches!(result, Err(AdapterError::ResumeRejected)));
    adapter.shutdown().await;
    settle(&root).await;
}

#[test]
fn codex_wire_fixtures_are_versioned_and_present() {
    let mut count = 0;
    for entry in std::fs::read_dir(fixtures_dir()).expect("the wire fixtures directory exists") {
        let path = entry.unwrap().path();
        if path.extension().and_then(|value| value.to_str()) != Some("ndjson") {
            continue;
        }
        count += 1;
        let content = std::fs::read_to_string(&path).unwrap();
        let line = content.lines().next().expect("a header line");
        let value: Value = serde_json::from_str(line).expect("a JSON header line");
        let header = &value["header"];
        assert_eq!(header["provider"], PROVIDER, "{}", path.display());
        assert_eq!(header["cliVersion"], CODEX_VERSION, "{}", path.display());
        assert_eq!(header["synthesised"], true, "{}", path.display());
    }
    assert!(count > 0, "the codex wire fixture set must not be empty");
}
