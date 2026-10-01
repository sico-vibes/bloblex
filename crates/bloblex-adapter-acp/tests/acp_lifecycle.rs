use bloblex_adapter_acp::AcpAdapter;
use bloblex_agent_core::{AgentAdapter, AgentEvent, NewSessionRequest, PromptRequest, RuntimeSpec};
use std::{path::PathBuf, process::Command, sync::Arc, time::Duration};
use tokio::sync::mpsc;

fn runtime(mode: &str) -> RuntimeSpec {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("fake-acp-agent.mjs");
    RuntimeSpec {
        runtime_id: "fixture".into(),
        provider: "opencode".into(),
        executable: PathBuf::from("node"),
        args: vec![fixture.to_string_lossy().into_owned(), mode.into()],
        cwd: None,
    }
}

async fn new_session(
    adapter: &AcpAdapter,
    mode: &str,
    session_id: &str,
) -> (
    bloblex_agent_core::SessionHandle,
    mpsc::Receiver<AgentEvent>,
) {
    let mut command = Command::new("node");
    assert!(
        command.arg("--version").output().is_ok(),
        "Node.js is required for fake ACP child tests"
    );
    let (tx, rx) = mpsc::channel(32);
    let handle = adapter
        .new_session(
            &runtime(mode),
            NewSessionRequest {
                session_id: session_id.into(),
                project_path: std::env::current_dir().unwrap(),
            },
            tx,
        )
        .await
        .unwrap();
    (handle, rx)
}

#[tokio::test]
async fn fake_child_roundtrips_unknown_rpc_stream_and_prompt_stop_reason() {
    let adapter = Arc::new(AcpAdapter::default());
    let (handle, mut events) = new_session(&adapter, "success", "bloblex-success").await;
    let adapter_for_prompt = adapter.clone();
    let prompt_handle = handle.clone();
    let prompt = tokio::spawn(async move {
        adapter_for_prompt
            .prompt(
                &prompt_handle,
                PromptRequest {
                    turn_id: "turn-1".into(),
                    text: "Return fixture text".into(),
                },
            )
            .await
    });
    let mut saw_delta = false;
    while let Some(event) = tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .unwrap()
    {
        match event {
            AgentEvent::AssistantDelta { text } if text == "fixture response" => saw_delta = true,
            AgentEvent::TurnCompleted => break,
            _ => {}
        }
    }
    prompt.await.unwrap().unwrap();
    assert!(saw_delta);
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn fake_child_permission_reply_reaches_provider_and_resolves_prompt() {
    let adapter = Arc::new(AcpAdapter::default());
    let (handle_a, mut events_a) =
        new_session(&adapter, "permission", "bloblex-permission-a").await;
    let (handle_b, mut events_b) =
        new_session(&adapter, "permission", "bloblex-permission-b").await;
    let adapter_for_prompt = adapter.clone();
    let prompt_handle_a = handle_a.clone();
    let prompt_a = tokio::spawn(async move {
        adapter_for_prompt
            .prompt(
                &prompt_handle_a,
                PromptRequest {
                    turn_id: "turn-permission".into(),
                    text: "Ask permission".into(),
                },
            )
            .await
    });
    let adapter_for_prompt = adapter.clone();
    let prompt_handle_b = handle_b.clone();
    let prompt_b = tokio::spawn(async move {
        adapter_for_prompt
            .prompt(
                &prompt_handle_b,
                PromptRequest {
                    turn_id: "turn-permission-b".into(),
                    text: "Ask permission".into(),
                },
            )
            .await
    });
    let permission_id_a = loop {
        match tokio::time::timeout(Duration::from_secs(5), events_a.recv())
            .await
            .unwrap()
            .unwrap()
        {
            AgentEvent::PermissionRequested {
                provider_request_id,
                choices,
                ..
            } => {
                assert_eq!(choices, vec!["allow_once", "reject_once"]);
                break provider_request_id;
            }
            _ => {}
        }
    };
    let permission_id_b = loop {
        match tokio::time::timeout(Duration::from_secs(5), events_b.recv())
            .await
            .unwrap()
            .unwrap()
        {
            AgentEvent::PermissionRequested {
                provider_request_id,
                choices,
                ..
            } => {
                assert_eq!(choices, vec!["allow_once", "reject_once"]);
                break provider_request_id;
            }
            _ => {}
        }
    };
    assert_ne!(permission_id_a, permission_id_b);
    adapter
        .reply_permission(&permission_id_a, "allow_once")
        .await
        .unwrap();
    prompt_a.await.unwrap().unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), events_a.recv())
            .await
            .unwrap(),
        Some(AgentEvent::TurnCompleted)
    ));
    assert!(adapter
        .reply_permission(&permission_id_a, "allow_once")
        .await
        .is_err());
    adapter
        .reply_permission(&permission_id_b, "reject_once")
        .await
        .unwrap();
    prompt_b.await.unwrap().unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), events_b.recv())
            .await
            .unwrap(),
        Some(AgentEvent::TurnCompleted)
    ));
    adapter.close_session(&handle_a).await.unwrap();
    adapter.close_session(&handle_b).await.unwrap();
}

#[tokio::test]
async fn fake_child_cancel_uses_provider_stop_reason() {
    let adapter = Arc::new(AcpAdapter::default());
    let (handle, mut events) = new_session(&adapter, "cancel", "bloblex-cancel").await;
    let adapter_for_prompt = adapter.clone();
    let prompt_handle = handle.clone();
    let prompt = tokio::spawn(async move {
        adapter_for_prompt
            .prompt(
                &prompt_handle,
                PromptRequest {
                    turn_id: "turn-cancel".into(),
                    text: "Wait for cancellation".into(),
                },
            )
            .await
    });
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap(),
        Some(AgentEvent::AssistantDelta { .. })
    ));
    adapter.cancel(&handle).await.unwrap();
    prompt.await.unwrap().unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap(),
        Some(AgentEvent::TurnCancelled)
    ));
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn cancelling_pending_approval_settles_provider_request_and_rejects_late_reply() {
    let adapter = Arc::new(AcpAdapter::default());
    let (handle, mut events) =
        new_session(&adapter, "permission", "bloblex-permission-cancel").await;
    let adapter_for_prompt = adapter.clone();
    let prompt_handle = handle.clone();
    let prompt = tokio::spawn(async move {
        adapter_for_prompt
            .prompt(
                &prompt_handle,
                PromptRequest {
                    turn_id: "turn-permission-cancel".into(),
                    text: "Wait for permission".into(),
                },
            )
            .await
    });
    let permission_id = loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap()
        {
            AgentEvent::PermissionRequested {
                provider_request_id,
                ..
            } => break provider_request_id,
            _ => {}
        }
    };
    adapter.cancel(&handle).await.unwrap();
    prompt.await.unwrap().unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap(),
        Some(AgentEvent::TurnCancelled)
    ));
    assert!(adapter
        .reply_permission(&permission_id, "allow_once")
        .await
        .is_err());
    adapter.close_session(&handle).await.unwrap();
}
