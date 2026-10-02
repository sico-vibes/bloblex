use bloblex_adapter_codex::CodexAdapter;
use bloblex_agent_core::*;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn setup(mode: Option<&str>) -> (RuntimeSpec, PathBuf) {
    let root = std::env::temp_dir().join(format!("bloblex-codex-test-{}", uuid_like()));
    std::fs::create_dir_all(&root).unwrap();
    let record = root.join("rpc.jsonl");
    let pidfile = record.with_extension("pid");
    let mut args = vec![
        "--record".into(),
        record.to_string_lossy().into_owned(),
        "--pidfile".into(),
        pidfile.to_string_lossy().into_owned(),
    ];
    if let Some(mode) = mode {
        args.extend(["--mode".into(), mode.into()]);
    }
    let runtime = RuntimeSpec {
        runtime_id: "fake".into(),
        provider: "codex".into(),
        executable: PathBuf::from(env!("CARGO_BIN_EXE_fake_codex_server")),
        args,
        cwd: Some(root.clone()),
    };
    (runtime, record)
}
fn uuid_like() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}
fn log(path: &PathBuf) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}
#[tokio::test]
async fn fake_peer_receives_approval_and_sandbox_fields_for_each_mode(){
    for (mode,name,approval,sandbox) in [(ApprovalMode::Ask,"ask","on-request","workspace-write"),(ApprovalMode::Auto,"auto","on-request","workspace-write"),(ApprovalMode::Bypass,"bypass","never","danger-full-access")]{
        let(rt,record)=setup(None);let adapter=CodexAdapter::default();let(tx,_rx)=tokio::sync::mpsc::channel(32);let opts=ExecOptions{approval_mode:mode,..ExecOptions::default()};
        let handle=adapter.new_session(&rt,NewSessionRequest{session_id:name.into(),project_path:rt.cwd.clone().unwrap(),exec_options:opts},tx).await.unwrap();let rows=log(&record);let start=rows.iter().find(|r|r["method"]=="thread/start").unwrap();assert_eq!(start["params"]["approvalPolicy"],approval);assert_eq!(start["params"]["sandbox"],sandbox);adapter.close_session(&handle).await.unwrap();let _=std::fs::remove_dir_all(rt.cwd.unwrap());
    }
}
#[cfg(windows)]
fn pid_is_live(pid: u32) -> bool {
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        let handle = OpenProcess(0x1000, 0, pid);
        if handle.is_null() {
            false
        } else {
            let _ = CloseHandle(handle);
            true
        }
    }
}
#[cfg(not(windows))]
fn pid_is_live(pid: u32) -> bool {
    std::path::Path::new("/proc").join(pid.to_string()).exists()
}
fn opts() -> ExecOptions {
    ExecOptions {
        model: Some("m1".into()),
        thinking: Some("low".into()),
        service_tier: Some("priority".into()),
        instructions: Some("sentinel instruction".into()),
        ..ExecOptions::default()
    }
}
fn qnew() -> NewSessionRequest {
    NewSessionRequest {
        session_id: "s".into(),
        project_path: PathBuf::from("."),
        exec_options: opts(),
    }
}

#[tokio::test]
async fn exact_start_turn_resume_fields_and_replayed_usage_are_scoped() {
    let (r, record) = setup(None);
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let h = adapter.new_session(&r, qnew(), tx).await.unwrap();
    let first = adapter
        .prompt(
            &h,
            PromptRequest {
                turn_id: "local-1".into(),
                text: "hello".into(),
                exec_options: opts(),
            },
        )
        .await
        .unwrap();
    let _ = first;
    let mut first_events = Vec::new();
    for _ in 0..4 {
        first_events.push(
            tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .unwrap()
                .unwrap(),
        );
        if matches!(first_events.last(), Some(AgentEvent::TurnCompleted)) {
            break;
        }
    }
    assert!(first_events.iter().any(|e|matches!(e,AgentEvent::UsageReport{report,..} if report.input_tokens==Some(7)&&report.reasoning_tokens==Some(3))));
    adapter.close_session(&h).await.unwrap();
    adapter
        .set_instruction_hash_context(
            "s",
            Some("changed-hash".into()),
            Some("original-hash".into()),
        )
        .await;
    let (tx2, mut rx2) = tokio::sync::mpsc::channel(64);
    let resumed = adapter
        .resume_session(
            &r,
            ResumeSessionRequest {
                session_id: "s".into(),
                provider_session_id: h.provider_session_id.clone(),
                project_path: PathBuf::from("."),
                exec_options: opts(),
            },
            tx2,
        )
        .await
        .unwrap();
    adapter
        .prompt(
            &resumed,
            PromptRequest {
                turn_id: "local-2".into(),
                text: "next".into(),
                exec_options: ExecOptions {
                    instructions: Some("changed instructions".into()),
                    ..opts()
                },
            },
        )
        .await
        .unwrap();
    let mut events = Vec::new();
    for _ in 0..4 {
        events.push(
            tokio::time::timeout(Duration::from_secs(2), rx2.recv())
                .await
                .unwrap()
                .unwrap(),
        );
        if matches!(events.last(), Some(AgentEvent::TurnCompleted)) {
            break;
        }
    }
    assert!(first_events.iter().any(|e| matches!(e,AgentEvent::ExecApplied{turn_id,outcomes} if turn_id=="local-1"&&outcomes["instructions"].applied==Some(true)&&outcomes["instructions"].evidence_kind==EvidenceKind::SuccessfulTurn)));
    assert!(first_events.iter().any(|e|matches!(e,AgentEvent::ExecApplied{turn_id,outcomes} if turn_id=="local-1"&&outcomes["model"].applied==Some(true)&&outcomes["model"].evidence_value==Some(json!("m1"))&&outcomes["serviceTier"].evidence_value==Some(json!("priority")))));
    assert!(events.iter().any(|e|matches!(e,AgentEvent::ExecApplied{turn_id,outcomes} if turn_id=="local-2"&&outcomes["instructions"].applied==Some(false)&&outcomes["instructions"].reason.as_deref()==Some("instructions_change_requires_new_thread"))));
    assert!(events.iter().any(|e|matches!(e,AgentEvent::UsageReport{turn_id,report} if turn_id=="local-2"&&report.input_tokens==Some(7))));
    let rows = log(&record);
    let calls = rows
        .iter()
        .filter_map(|v| v["method"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        calls,
        vec![
            "initialize",
            "initialized",
            "thread/start",
            "turn/start",
            "initialize",
            "initialized",
            "thread/resume",
            "turn/start"
        ]
    );
    let start = &rows[2]["params"];
    assert_eq!(start["cwd"], ".");
    assert_eq!(start["approvalPolicy"], "on-request");
    assert_eq!(start["sandbox"], "workspace-write");
    assert_eq!(start["model"], "m1");
    assert_eq!(start["serviceTier"], "priority");
    assert_eq!(start["developerInstructions"], "sentinel instruction");
    assert!(start.get("config").is_none());
    let turn = &rows[3]["params"];
    assert_eq!(turn["input"][0]["text"], "hello");
    assert_eq!(turn["model"], "m1");
    assert_eq!(turn["effort"], "low");
    assert_eq!(turn["serviceTier"], "priority");
    assert!(turn.get("developerInstructions").is_none());
    let resume = &rows[6]["params"];
    assert_eq!(resume["threadId"], h.provider_session_id);
    assert!(resume.get("developerInstructions").is_none());
    for row in &rows {
        assert_ne!(row["params"]["serviceTier"], "fast");
        assert_ne!(row["params"]["serviceTier"], "standard");
    }
    adapter.close_session(&resumed).await.unwrap();
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn catalog_paginates_visible_models_on_one_short_lived_process() {
    let (r, record) = setup(None);
    let catalog = CodexAdapter::default().model_catalog(&r).await.unwrap();
    assert_eq!(catalog.source, "app_server");
    assert!(!catalog.fallback);
    assert!(catalog.models.iter().all(|m| m.host_dependent));
    assert_eq!(
        catalog
            .models
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["m1", "m2"]
    );
    let rows = log(&record);
    let calls = rows
        .iter()
        .filter_map(|v| v["method"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        calls,
        vec!["initialize", "initialized", "model/list", "model/list"]
    );
    assert_eq!(rows[2]["params"]["includeHidden"], false);
    assert_eq!(rows[2]["params"]["limit"], 100);
    assert!(rows[2]["params"]["cursor"].is_null());
    assert_eq!(rows[3]["params"]["cursor"], "page-2");
    assert_eq!(catalog.models[0].service_tiers[0].id, "priority");
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn resumed_thread_replay_is_filtered_until_the_new_turn_starts() {
    let (runtime, _) = setup(Some("replay"));
    let adapter = CodexAdapter::default();
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    let created = adapter
        .new_session(
            &runtime,
            NewSessionRequest {
                session_id: "replay-session".into(),
                project_path: runtime.cwd.clone().unwrap(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await
        .unwrap();
    adapter.close_session(&created).await.unwrap();

    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    let resumed = adapter
        .resume_session(
            &runtime,
            ResumeSessionRequest {
                session_id: "replay-session".into(),
                provider_session_id: created.provider_session_id,
                project_path: runtime.cwd.clone().unwrap(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await
        .unwrap();
    adapter
        .prompt(
            &resumed,
            PromptRequest {
                turn_id: "fresh-turn".into(),
                text: "new prompt".into(),
                exec_options: ExecOptions::default(),
            },
        )
        .await
        .unwrap();

    let mut events = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let completed = matches!(event, AgentEvent::TurnCompleted);
        events.push(event);
        if completed {
            break;
        }
    }
    assert!(events.iter().any(|event| matches!(
        event,
        AgentEvent::AssistantDelta { text } if text == "new answer"
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        AgentEvent::AssistantDelta { text } if text == "stale answer"
    )));
    adapter.close_session(&resumed).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
}

#[tokio::test]
async fn stored_thread_is_rejected_only_when_provider_reports_missing_identity() {
    let (runtime, _) = setup(Some("resume-reject"));
    let adapter = CodexAdapter::default();
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    let created = adapter
        .new_session(
            &runtime,
            NewSessionRequest {
                session_id: "resume-session".into(),
                project_path: runtime.cwd.clone().unwrap(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await
        .unwrap();
    adapter.close_session(&created).await.unwrap();

    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    let result = adapter
        .resume_session(
            &runtime,
            ResumeSessionRequest {
                session_id: "resume-session".into(),
                provider_session_id: created.provider_session_id,
                project_path: runtime.cwd.clone().unwrap(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await;
    assert!(matches!(result, Err(AdapterError::ResumeRejected)));
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
}

#[tokio::test]
async fn context_overflow_is_reported_as_a_typed_adapter_event() {
    let (runtime, _) = setup(Some("context"));
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let handle = adapter
        .new_session(
            &runtime,
            NewSessionRequest {
                session_id: "context-session".into(),
                project_path: runtime.cwd.clone().unwrap(),
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
                turn_id: "context-turn".into(),
                text: "large prompt".into(),
                exec_options: ExecOptions::default(),
            },
        )
        .await
        .unwrap();
    let mut observed_context = false;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        if matches!(event, AgentEvent::ContextExhausted) {
            observed_context = true;
            break;
        }
        if matches!(event, AgentEvent::TurnCompleted | AgentEvent::Error { .. }) {
            break;
        }
    }
    assert!(observed_context);
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
}

#[tokio::test]
async fn catalog_timeout_is_bounded_and_reported_unavailable() {
    let (r, record) = setup(Some("stall"));
    let started = tokio::time::Instant::now();
    let result = CodexAdapter::default().model_catalog(&r).await;
    assert!(matches!(result, Err(AdapterError::Process(_))));
    assert!(started.elapsed() < Duration::from_secs(15));
    let pid: u32 = std::fs::read_to_string(record.with_extension("pid"))
        .unwrap()
        .parse()
        .unwrap();
    for _ in 0..20 {
        if !pid_is_live(pid) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        !pid_is_live(pid),
        "timed-out model catalog child must be killed"
    );
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn failed_turn_emits_only_nullable_unreported_usage() {
    let (r, record) = setup(Some("fail"));
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    let h = adapter.new_session(&r, qnew(), tx).await.unwrap();
    adapter
        .prompt(
            &h,
            PromptRequest {
                turn_id: "local-fail".into(),
                text: "fail".into(),
                exec_options: opts(),
            },
        )
        .await
        .unwrap();
    let mut got_usage = false;
    let mut got_error = false;
    for _ in 0..5 {
        let e = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        match e {
            AgentEvent::UsageReport { turn_id, report } => {
                got_usage = true;
                assert_eq!(turn_id, "local-fail");
                assert_eq!(report.usage_status, "unreported");
                assert_eq!(report.input_tokens, None);
                assert_eq!(report.output_tokens, None);
                assert_eq!(report.model, None);
            }
            AgentEvent::Error { .. } => got_error = true,
            _ => {}
        }
        if got_usage && got_error {
            break;
        }
    }
    assert!(got_usage && got_error);
    assert_eq!(
        log(&record)
            .iter()
            .filter(|v| v["method"] == "turn/start")
            .count(),
        1
    );
    adapter.close_session(&h).await.unwrap();
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn turn_start_rpc_rejection_is_reported_without_retry() {
    let (r, record) = setup(Some("reject"));
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    let h = adapter.new_session(&r, qnew(), tx).await.unwrap();
    let err = adapter
        .prompt(
            &h,
            PromptRequest {
                turn_id: "local-reject".into(),
                text: "do not retry".into(),
                exec_options: opts(),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, AdapterError::Rejected(_)));
    let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(event,AgentEvent::ExecApplied{turn_id,outcomes} if turn_id=="local-reject"&&outcomes["model"].applied==Some(false)&&outcomes["thinking"].applied==Some(false)&&outcomes["serviceTier"].applied==Some(false)&&outcomes["model"].reason.as_deref()==Some("provider_rejected_before_turn"))
    );
    let calls = log(&record)
        .into_iter()
        .filter(|v| v["method"] == "turn/start")
        .count();
    assert_eq!(calls, 1);
    adapter.close_session(&h).await.unwrap();
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn thread_start_rpc_rejection_terminates_the_fake_server() {
    let (r, record) = setup(Some("reject-start"));
    let adapter = CodexAdapter::default();
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    assert!(adapter.new_session(&r, qnew(), tx).await.is_err());
    let pid: u32 = std::fs::read_to_string(record.with_extension("pid"))
        .unwrap()
        .parse()
        .unwrap();
    for _ in 0..20 {
        if !pid_is_live(pid) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!pid_is_live(pid));
    let calls = log(&record)
        .into_iter()
        .filter_map(|v| v["method"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    assert_eq!(calls, vec!["initialize", "initialized", "thread/start"]);
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn standard_speed_uses_default_only_for_the_single_turn() {
    let (r, record) = setup(None);
    let adapter = CodexAdapter::default();
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    let mut options = opts();
    options.service_tier = Some("standard".into());
    let h = adapter
        .new_session(
            &r,
            NewSessionRequest {
                session_id: "standard".into(),
                project_path: PathBuf::from("."),
                exec_options: options.clone(),
            },
            tx,
        )
        .await
        .unwrap();
    adapter
        .prompt(
            &h,
            PromptRequest {
                turn_id: "standard-turn".into(),
                text: "one turn".into(),
                exec_options: options,
            },
        )
        .await
        .unwrap();
    let rows = log(&record);
    let start = &rows[2]["params"];
    assert!(start.get("serviceTier").is_none());
    assert!(start.get("serviceTierForTurn").is_none());
    let turn = rows.iter().find(|v| v["method"] == "turn/start").unwrap();
    assert_eq!(turn["params"]["serviceTierForTurn"], "default");
    assert!(turn["params"].get("serviceTier").is_none());
    adapter.close_session(&h).await.unwrap();
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}
