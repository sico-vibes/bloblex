//! Wire-replay scenarios for the Claude adapter. Each test drives the real
//! adapter against `fake-claude --replay <fixture>` and asserts the normalised
//! `AgentEvent` sequence. Fixtures are synthesised from the fake's own output;
//! see `docs/evidence/wire-fixtures.md`.
use bloblex_adapter_claude::ClaudeAdapter;
use bloblex_agent_core::{
    AgentAdapter, AgentEvent, ContextChangeReason, ExecOptions, NewSessionRequest, PromptRequest,
    RecoveryHintKind, RuntimeSpec,
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::mpsc;
use uuid::Uuid;

const PROVIDER: &str = "claude";
const CLAUDE_VERSION: &str = "2.1.286";

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

fn runtime(name: &str, extra: &[&str]) -> RuntimeSpec {
    RuntimeSpec {
        runtime_id: "wire".into(),
        provider: PROVIDER.into(),
        executable: PathBuf::from(env!("CARGO_BIN_EXE_fake-claude")),
        args: fake_args(name, extra),
        cwd: None,
    }
}

struct Session {
    root: PathBuf,
    adapter: ClaudeAdapter,
    rx: mpsc::Receiver<AgentEvent>,
    handle: bloblex_agent_core::SessionHandle,
}

impl Session {
    /// Let the adapter issue its post-turn housekeeping request before the
    /// provider is torn down, so a recording captures a complete final line.
    async fn finish(&mut self) {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let _ = self.adapter.close_session(&self.handle).await;
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn open(name: &str, extra: &[&str], session_id: &str) -> Session {
    let root = std::env::temp_dir().join(format!("bloblex-claude-wire-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let adapter = ClaudeAdapter::with_private_tmp_dir(root.join("private"));
    let (tx, mut rx) = mpsc::channel(64);
    let handle = adapter
        .new_session(
            &runtime(name, extra),
            NewSessionRequest {
                session_id: session_id.into(),
                project_path: root.clone(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await
        .unwrap();
    loop {
        if matches!(next_event(&mut rx).await, AgentEvent::SessionStarted { .. }) {
            break;
        }
    }
    Session { root, adapter, rx, handle }
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

async fn prompt(session: &mut Session, turn_id: &str, text: &str) {
    session
        .adapter
        .prompt(
            &session.handle,
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

#[tokio::test]
async fn claude_simple_turn_replays_a_text_result() {
    let mut session = open("simple-turn.ndjson", &[], "wire-simple").await;
    prompt(&mut session, "turn-simple", "hello").await;
    let seen = collect_until_terminal(&mut session.rx).await;
    assert!(
        seen.iter().any(|event| matches!(event, AgentEvent::UsageReport { report, .. } if report.input_tokens == Some(7))),
        "reported usage reaches the adapter: {seen:?}"
    );
    assert!(seen.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    session.finish().await;
}

#[tokio::test]
async fn claude_tool_call_permission_allow_roundtrips() {
    let mut session = open(
        "tool-permission-allow.ndjson",
        &["--fake-tool-permission"],
        "wire-permission",
    )
    .await;
    prompt(&mut session, "turn-permission", "hello").await;
    let mut seen = Vec::new();
    let permission_id = loop {
        let event = next_event(&mut session.rx).await;
        let id = match &event {
            AgentEvent::PermissionRequested { provider_request_id, .. } => Some(provider_request_id.clone()),
            _ => None,
        };
        seen.push(event);
        if let Some(id) = id {
            break id;
        }
    };
    assert_eq!(permission_id, "wire-permission:21");
    session.adapter.reply_permission(&permission_id, "allow").await.unwrap();
    seen.extend(collect_until_terminal(&mut session.rx).await);
    assert!(
        seen.iter().any(|event| matches!(event, AgentEvent::ToolStarted { tool_call_id, .. } if tool_call_id == "tool-1")),
        "the tool call is surfaced before its permission prompt: {seen:?}"
    );
    assert!(seen.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    session.finish().await;
}

#[tokio::test]
async fn claude_permission_deny_still_completes_the_turn() {
    let mut session = open(
        "permission-deny.ndjson",
        &["--fake-tool-permission"],
        "wire-permission-deny",
    )
    .await;
    prompt(&mut session, "turn-permission-deny", "hello").await;
    let mut seen = Vec::new();
    let permission_id = loop {
        let event = next_event(&mut session.rx).await;
        let id = match &event {
            AgentEvent::PermissionRequested { provider_request_id, .. } => Some(provider_request_id.clone()),
            _ => None,
        };
        seen.push(event);
        if let Some(id) = id {
            break id;
        }
    };
    session.adapter.reply_permission(&permission_id, "deny").await.unwrap();
    seen.extend(collect_until_terminal(&mut session.rx).await);
    assert!(seen.iter().any(|event| matches!(event, AgentEvent::PermissionRequested { .. })));
    assert!(seen.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    session.finish().await;
}

#[tokio::test]
async fn claude_api_error_status_429_emits_a_recovery_hint_before_the_error() {
    let mut session = open("api-error-429.ndjson", &["--fake-api-error-status=429"], "wire-429").await;
    prompt(&mut session, "turn-429", "hello").await;
    let seen = collect_until_terminal(&mut session.rx).await;
    let hint = seen.iter().position(|event| {
        matches!(event, AgentEvent::RecoveryHint { kind: RecoveryHintKind::RateLimited, .. })
    });
    let error = seen.iter().position(|event| matches!(event, AgentEvent::Error { .. }));
    assert!(
        matches!((hint, error), (Some(hint), Some(error)) if hint < error),
        "a rate-limit hint precedes the terminal error: {seen:?}"
    );
    assert!(seen.iter().any(|event| matches!(event, AgentEvent::UsageReport { report, .. } if report.usage_status == "unreported")));
    assert!(!seen.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    session.finish().await;
}

#[tokio::test]
async fn claude_compact_boundary_resets_context_then_announces_compaction() {
    let mut session = open(
        "compact-boundary.ndjson",
        &["--fake-compact-boundary"],
        "wire-compact",
    )
    .await;
    prompt(&mut session, "turn-compact", "hello").await;
    let seen = collect_until_terminal(&mut session.rx).await;
    let reset = seen.iter().position(|event| matches!(event, AgentEvent::ContextReset));
    let changed = seen.iter().position(|event| {
        matches!(
            event,
            AgentEvent::ContextChanged {
                reason: ContextChangeReason::Compaction,
                context_lost: false
            }
        )
    });
    assert!(
        matches!((reset, changed), (Some(reset), Some(changed)) if reset < changed),
        "the reset is sent before the context-change notice: {seen:?}"
    );
    session.finish().await;
}

#[test]
fn claude_wire_fixtures_are_versioned_and_present() {
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
        assert_eq!(header["cliVersion"], CLAUDE_VERSION, "{}", path.display());
        assert_eq!(header["synthesised"], true, "{}", path.display());
    }
    assert!(count > 0, "the claude wire fixture set must not be empty");
}
