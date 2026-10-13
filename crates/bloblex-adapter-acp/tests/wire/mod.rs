//! Wire-replay scenarios for the ACP/OpenCode adapter. Each test drives the
//! real adapter against `fake-acp-peer --replay <fixture>` and asserts the
//! normalised `AgentEvent` sequence. Fixtures are synthesised from the fake's
//! own output; see `docs/evidence/wire-fixtures.md`.
use bloblex_adapter_acp::AcpAdapter;
use bloblex_agent_core::{
    AgentAdapter, AgentEvent, EvidenceKind, ExecOptions, NewSessionRequest, PromptRequest,
    RuntimeSpec,
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::mpsc;

const PROVIDER: &str = "opencode";
const ACP_VERSION: &str = "1.18.34";

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

fn peer() -> PathBuf {
    if let Some(path) = std::env::var_os("CARGO_BIN_EXE_fake_acp_peer") {
        return PathBuf::from(path);
    }
    let exe = std::env::current_exe().expect("test executable");
    let debug_dir = exe.parent().and_then(|dir| dir.parent()).expect("cargo debug dir");
    let windows = debug_dir.join("fake-acp-peer.exe");
    if windows.exists() {
        windows
    } else {
        debug_dir.join("fake-acp-peer")
    }
}

fn workspace() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "bloblex-acp-wire-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn runtime(name: &str, extra: &[&str]) -> RuntimeSpec {
    RuntimeSpec {
        runtime_id: "wire".into(),
        provider: PROVIDER.into(),
        executable: peer(),
        args: fake_args(name, extra),
        cwd: None,
    }
}

async fn next_event(rx: &mut mpsc::Receiver<AgentEvent>) -> AgentEvent {
    tokio::time::timeout(Duration::from_secs(20), rx.recv())
        .await
        .expect("an event arrives within the timeout")
        .expect("the adapter event channel stays open")
}

#[tokio::test]
async fn acp_simple_turn_reports_a_usage_update() {
    let root = workspace();
    let adapter = AcpAdapter::default();
    let (tx, mut rx) = mpsc::channel(64);
    let handle = adapter
        .new_session(
            &runtime("simple-turn.ndjson", &[]),
            NewSessionRequest {
                session_id: "wire-simple".into(),
                project_path: root.clone(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await
        .unwrap();
    adapter
        .prompt(
            &handle,
            PromptRequest {
                attachments: Vec::new(),
                turn_id: "turn-simple".into(),
                text: "hello".into(),
                exec_options: ExecOptions::default(),
            },
        )
        .await
        .unwrap();
    // The ACP adapter enqueues completion before the evidence events, and the
    // prompt future resolves once every event is queued.
    let events: Vec<AgentEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    let report = events
        .iter()
        .find_map(|event| match event {
            AgentEvent::UsageReport { report, .. } => Some(report),
            _ => None,
        })
        .expect("a usage report reaches the adapter");
    assert_eq!(report.input_tokens, Some(120));
    assert_eq!(report.output_tokens, Some(30));
    assert_eq!(report.reasoning_tokens, Some(23));
    assert_eq!(report.context_used, Some(4000));
    assert_eq!(report.reported_cost_decimal.as_deref(), Some("0.0015894"));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    tokio::time::sleep(Duration::from_millis(250)).await;
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn acp_effort_selection_is_echoed() {
    let root = workspace();
    let adapter = AcpAdapter::default();
    let options = ExecOptions {
        model: Some("opencode-go/deepseek-v4.1-flash".into()),
        thinking: Some("high".into()),
        instructions: Some("wire effort fixture instruction".into()),
        ..ExecOptions::default()
    };
    let (tx, mut rx) = mpsc::channel(64);
    let handle = adapter
        .new_session(
            &runtime("effort-echo.ndjson", &[]),
            NewSessionRequest {
                session_id: "wire-effort".into(),
                project_path: root.clone(),
                exec_options: options.clone(),
            },
            tx,
        )
        .await
        .unwrap();
    adapter
        .prompt(
            &handle,
            PromptRequest {
                attachments: Vec::new(),
                turn_id: "turn-effort".into(),
                text: "hello".into(),
                exec_options: options,
            },
        )
        .await
        .unwrap();
    let events: Vec<AgentEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    let outcomes = events
        .iter()
        .find_map(|event| match event {
            AgentEvent::ExecApplied { outcomes, .. } => Some(outcomes),
            _ => None,
        })
        .expect("applied outcomes reach the adapter");
    assert_eq!(outcomes["model"].applied, Some(true));
    assert!(matches!(outcomes["model"].evidence_kind, EvidenceKind::ProviderEcho));
    assert_eq!(
        outcomes["thinking"].evidence_value.as_ref().and_then(Value::as_str),
        Some("high")
    );
    assert!(events.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    tokio::time::sleep(Duration::from_millis(250)).await;
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn acp_permission_request_roundtrips() {
    let root = workspace();
    let adapter = Arc::new(AcpAdapter::default());
    let (tx, mut rx) = mpsc::channel(64);
    let handle = adapter
        .new_session(
            &runtime("permission-request.ndjson", &["--permission-request"]),
            NewSessionRequest {
                session_id: "wire-permission".into(),
                project_path: root.clone(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await
        .unwrap();
    let prompt_adapter = Arc::clone(&adapter);
    let prompt_handle = handle.clone();
    let prompt = tokio::spawn(async move {
        prompt_adapter
            .prompt(
                &prompt_handle,
                PromptRequest {
                    attachments: Vec::new(),
                    turn_id: "turn-permission".into(),
                    text: "hello".into(),
                    exec_options: ExecOptions::default(),
                },
            )
            .await
    });
    let permission_id = loop {
        match next_event(&mut rx).await {
            AgentEvent::PermissionRequested { provider_request_id, choices, .. } => {
                assert!(choices.iter().any(|choice| choice == "allow_once"));
                break provider_request_id;
            }
            AgentEvent::Error { .. } => panic!("the turn failed before asking for permission"),
            _ => {}
        }
    };
    assert_eq!(permission_id, "wire-permission:permission-1");
    adapter.reply_permission(&permission_id, "allow_once").await.unwrap();
    prompt.await.unwrap().unwrap();
    let events: Vec<AgentEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert!(events.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    tokio::time::sleep(Duration::from_millis(250)).await;
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn acp_wire_fixtures_are_versioned_and_present() {
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
        assert_eq!(header["cliVersion"], ACP_VERSION, "{}", path.display());
        assert_eq!(header["synthesised"], true, "{}", path.display());
    }
    assert!(count > 0, "the acp wire fixture set must not be empty");
}
