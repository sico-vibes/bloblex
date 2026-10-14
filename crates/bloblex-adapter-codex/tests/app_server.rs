use bloblex_adapter_codex::CodexAdapter;
use bloblex_agent_core::*;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(10);
const IDLE_KEEPALIVE_WAIT: Duration = Duration::from_millis(200);
const TURN_EVENT_TIMEOUT: Duration = Duration::from_secs(15);
const FAST_PEER_EVENT_TIMEOUT: Duration = Duration::from_secs(4);

#[cfg(windows)]
struct ProcessSignal(usize);

#[cfg(windows)]
impl ProcessSignal {
    fn open(pid: u32) -> Option<Self> {
        #[link(name = "kernel32")]
        extern "system" { fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void; }
        let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
        (!handle.is_null()).then_some(Self(handle as usize))
    }

    async fn wait_signaled(&self, timeout: Duration) -> bool {
        let handle = self.0;
        let millis = timeout.as_millis().min(u32::MAX as u128) as u32;
        tokio::task::spawn_blocking(move || {
            #[link(name = "kernel32")]
            extern "system" { fn WaitForSingleObject(handle: *mut std::ffi::c_void, millis: u32) -> u32; }
            unsafe { WaitForSingleObject(handle as *mut std::ffi::c_void, millis) == 0 }
        }).await.unwrap()
    }
}

#[cfg(windows)]
impl Drop for ProcessSignal {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        extern "system" { fn CloseHandle(handle: *mut std::ffi::c_void) -> i32; }
        unsafe { CloseHandle(self.0 as *mut std::ffi::c_void); }
    }
}

#[cfg(not(windows))]
struct ProcessSignal(u32);

#[cfg(not(windows))]
impl ProcessSignal {
    fn open(pid: u32) -> Option<Self> { Some(Self(pid)) }
    async fn wait_signaled(&self, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, async {
            while pid_is_live(self.0) { tokio::time::sleep(Duration::from_millis(20)).await; }
        }).await.is_ok()
    }
}

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
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, millis: u32) -> u32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        // SYNCHRONIZE lets us query the process object's signaled state. A
        // handle can remain open after exit, so OpenProcess alone is not proof
        // that the process is still running.
        const SYNCHRONIZE: u32 = 0x0010_0000;
        const WAIT_TIMEOUT: u32 = 258;
        let handle = OpenProcess(SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            false
        } else {
            let state = WaitForSingleObject(handle, 0);
            let _ = CloseHandle(handle);
            state == WAIT_TIMEOUT
        }
    }
}

#[tokio::test]
async fn account_rate_limits_read_uses_the_checked_app_server_method() {
    let (runtime, record) = setup(None);
    let response = CodexAdapter::default().read_account_quota(&runtime).await.unwrap();
    assert_eq!(response["ordinaryUsageAllowed"], true);
    assert_eq!(response["rateLimitsByLimitId"]["codex"]["primary"]["usedPercent"], 42);
    let calls = log(&record);
    let request = calls.iter().find(|call| call["method"] == "account/rateLimits/read").unwrap();
    assert_eq!(request["params"]["excludeResetCreditDetails"], true);
    assert!(calls.iter().any(|call| call["method"] == "initialize"));
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
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

fn new_request(session_id: &str, project_path: PathBuf, exec_options: ExecOptions) -> NewSessionRequest {
    NewSessionRequest { session_id: session_id.into(), project_path, exec_options }
}

fn start_prompt(adapter: std::sync::Arc<CodexAdapter>, handle: SessionHandle, turn_id: &'static str, text: &'static str) -> tokio::task::JoinHandle<Result<(), AdapterError>> {
    tokio::spawn(async move {
        adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: turn_id.into(), text: text.into(), exec_options: opts() }).await
    })
}

fn method_count(record: &PathBuf, method: &str) -> usize {
    log(record).iter().filter(|row| row["method"] == method).count()
}

#[tokio::test]
async fn fake_peer_forwards_modern_command_output_deltas_and_mcp_details() {
    let (runtime, _record) = setup(Some("activity"));
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let handle = adapter.new_session(&runtime, qnew(), tx).await.unwrap();
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "activity-turn".into(), text: "activity".into(), exec_options: opts() }).await.unwrap();
    let mut events = Vec::new();
    loop {
        let event = tokio::time::timeout(TURN_EVENT_TIMEOUT, rx.recv()).await.unwrap().unwrap();
        let done = matches!(event, AgentEvent::TurnCompleted);
        events.push(event);
        if done { break; }
    }
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolStarted { tool_call_id, title, raw, .. } if tool_call_id == "cmd-modern" && title == "cargo test -p bloblex-storage" && raw["cwd"] == "D:/project")));
    let chunks = events.iter().filter_map(|event| match event {
        AgentEvent::ToolUpdated { tool_call_id, raw } if tool_call_id == "cmd-modern" => raw["outputDelta"].as_str(),
        _ => None,
    }).collect::<Vec<_>>().concat();
    assert_eq!(chunks, "first chunk");
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolCompleted { tool_call_id, raw } if tool_call_id == "cmd-modern" && raw["aggregatedOutput"] == "first chunk" && raw["exitCode"] == 0)));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolStarted { tool_call_id, title, raw, .. } if tool_call_id == "mcp-modern" && title == "bloblex · message_blob" && raw["arguments"]["blob"] == "Gogo")));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolUpdated { tool_call_id, raw } if tool_call_id == "mcp-modern" && raw["progress"] == "Waiting for teammate")));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolCompleted { tool_call_id, raw } if tool_call_id == "mcp-modern" && raw["result"]["content"][0]["text"] == "Sent to Gogo.")));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolStarted { tool_call_id, title, raw, .. } if tool_call_id == "dynamic-modern" && title == "search · find_page" && raw["arguments"]["query"] == "quota docs")));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolCompleted { tool_call_id, raw } if tool_call_id == "dynamic-modern" && raw["contentItems"][0]["text"] == "Found usage documentation." && raw["success"] == true)));
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
}

#[tokio::test]
async fn exact_start_turn_resume_fields_and_replayed_usage_are_scoped() {
    let (r, record) = setup(None);
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let h = adapter.new_session(&r, qnew(), tx).await.unwrap();
    adapter
        .prompt(
            &h,
            PromptRequest { attachments: Vec::new(),
                turn_id: "local-1".into(),
                text: "hello".into(),
                exec_options: opts(),
            },
        )
        .await
        .unwrap();
    let mut first_events = Vec::new();
    while first_events.len() < 4 {
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        if matches!(event, AgentEvent::PromptAccepted) { continue; }
        let done = matches!(event, AgentEvent::TurnCompleted);
        first_events.push(event);
        if done { break; }
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
            PromptRequest { attachments: Vec::new(),
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
    let mut events: Vec<AgentEvent> = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(2), rx2.recv())
            .await
            .unwrap()
            .unwrap();
        let done = matches!(event, AgentEvent::TurnCompleted);
        if !matches!(event, AgentEvent::PromptAccepted) { events.push(event); }
        if done { break; }
    }
    assert!(first_events.iter().any(|e| matches!(e,AgentEvent::ExecApplied{turn_id,outcomes} if turn_id=="local-1"&&outcomes["instructions"].applied==Some(true)&&outcomes["instructions"].evidence_kind==EvidenceKind::SuccessfulTurn)));
    assert!(first_events.iter().any(|e|matches!(e,AgentEvent::ExecApplied{turn_id,outcomes} if turn_id=="local-1"&&outcomes["model"].applied==Some(true)&&outcomes["model"].evidence_value==Some(json!("m1"))&&outcomes["serviceTier"].evidence_value==Some(json!("priority")))));
    assert!(events.iter().any(|e|matches!(e,AgentEvent::ExecApplied{turn_id,outcomes} if turn_id=="local-2"&&outcomes["instructions"].applied.is_none()&&outcomes["instructions"].reason.as_deref()==Some("instructions_sent_unverified"))));
    assert!(events.iter().any(|e|matches!(e,AgentEvent::UsageReport{turn_id,report} if turn_id=="local-2"&&report.input_tokens==Some(7))));
    let rows = log(&record);
    let redacted_log = std::fs::read_to_string(&record).unwrap();
    assert!(!redacted_log.contains("sentinel instruction"));
    assert!(!redacted_log.contains("hello"));
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
    assert_eq!(start["developerInstructionsSha256"], instruction_sha256("sentinel instruction").unwrap());
    assert_eq!(start["developerInstructionsPresent"], true);
    assert_eq!(start["developerInstructionsExact"], true);
    assert!(start.get("config").is_none());
    let turn = &rows[3]["params"];
    assert_eq!(turn["input"][0]["textSha256"], instruction_sha256("hello").unwrap());
    assert_eq!(turn["input"][0]["textPresent"], true);
    assert_eq!(turn["input"][0]["textExact"], true);
    assert_eq!(turn["model"], "m1");
    assert_eq!(turn["effort"], "low");
    assert_eq!(turn["serviceTier"], "priority");
    assert!(turn.get("developerInstructions").is_none());
    let resume = &rows[4]["params"];
    assert_eq!(resume["threadId"], h.provider_session_id);
    assert_eq!(resume["developerInstructionsSha256"], instruction_sha256("sentinel instruction").unwrap());
    assert_eq!(resume["developerInstructionsPresent"], true);
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
    assert_eq!(catalog.source, "live_query");
    assert!(catalog.validated);
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
            PromptRequest { attachments: Vec::new(),
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
            PromptRequest { attachments: Vec::new(),
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
            PromptRequest { attachments: Vec::new(),
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
async fn failed_turn_with_structured_error_info_emits_a_recovery_hint() {
    for (mode, expected) in [
        ("fail-auth", Some(RecoveryHintKind::AuthRequired)),
        ("fail-rate", Some(RecoveryHintKind::RateLimited)),
        ("fail-overload", Some(RecoveryHintKind::Overloaded)),
        ("fail", None),
    ] {
        let (r, _record) = setup(Some(mode));
        let adapter = CodexAdapter::default();
        let (tx, mut rx) = tokio::sync::mpsc::channel(32);
        let h = adapter.new_session(&r, qnew(), tx).await.unwrap();
        adapter
            .prompt(
                &h,
                PromptRequest { attachments: Vec::new(),
                    turn_id: "hint-turn".into(),
                    text: "hello".into(),
                    exec_options: opts(),
                },
            )
            .await
            .unwrap();
        let mut saw = None;
        loop {
            match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap() {
                AgentEvent::RecoveryHint { kind, retry_after_secs } => { assert_eq!(retry_after_secs, None); saw = Some(kind); }
                AgentEvent::Error { .. } => break,
                _ => {}
            }
        }
        assert_eq!(saw, expected, "mode {mode}");
        adapter.close_session(&h).await.unwrap();
        let _ = std::fs::remove_dir_all(r.cwd.unwrap());
    }
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
            PromptRequest { attachments: Vec::new(),
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
    let release = record.parent().unwrap().join("release-rejection");
    let mut runtime = r;
    runtime.args.extend(["--wait-for".into(), release.to_string_lossy().into_owned()]);
    let adapter = std::sync::Arc::new(adapter);
    let creating = tokio::spawn({
        let adapter = adapter.clone();
        async move { adapter.new_session(&runtime, qnew(), tx).await }
    });
    let pid_file = record.with_extension("pid");
    tokio::time::timeout(PROCESS_EXIT_TIMEOUT, async {
        while !pid_file.exists() { tokio::time::sleep(Duration::from_millis(20)).await; }
    }).await.unwrap();
    let pid: u32 = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
    let child = ProcessSignal::open(pid).expect("fake child process handle");
    std::fs::write(&release, "continue").unwrap();
    assert!(creating.await.unwrap().is_err());
    assert!(child.wait_signaled(PROCESS_EXIT_TIMEOUT).await, "failed setup must reap its fake child");
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
            PromptRequest { attachments: Vec::new(),
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

#[tokio::test]
async fn shared_process_routes_interleaved_threads_and_preserves_slow_session_terminal_events() {
    let (runtime, record) = setup(Some("interleave"));
    let adapter = std::sync::Arc::new(CodexAdapter::with_idle_shutdown(Duration::from_secs(2)));
    let cwd = runtime.cwd.clone().unwrap();
    let (tx_a, mut rx_a) = tokio::sync::mpsc::channel(1);
    let (tx_b, mut rx_b) = tokio::sync::mpsc::channel(32);
    let a = adapter.new_session(&runtime, new_request("shared-a", cwd.clone(), opts()), tx_a).await.unwrap();
    let b = adapter.new_session(&runtime, new_request("shared-b", cwd.clone(), opts()), tx_b).await.unwrap();

    let prompt_a = start_prompt(adapter.clone(), a.clone(), "slow-turn", "slow");
    let prompt_b = start_prompt(adapter.clone(), b.clone(), "fast-turn", "fast");
    prompt_a.await.unwrap().unwrap();
    prompt_b.await.unwrap().unwrap();
    let b_delta = tokio::time::timeout(FAST_PEER_EVENT_TIMEOUT, async {
        loop {
            if let Some(AgentEvent::AssistantDelta { text }) = rx_b.recv().await {
                if text.starts_with("answer:") { break text; }
            }
        }
    }).await.unwrap();
    assert_eq!(b_delta, format!("answer:{}", b.provider_session_id));
    let mut b_completed = false;
    while !b_completed {
        if let AgentEvent::TurnCompleted = tokio::time::timeout(TURN_EVENT_TIMEOUT, rx_b.recv()).await.unwrap().unwrap() { b_completed = true }
    }

    let mut a_delta = false;
    let mut a_completed = false;
    while !a_completed {
        match tokio::time::timeout(TURN_EVENT_TIMEOUT, rx_a.recv()).await.unwrap().unwrap() {
            AgentEvent::AssistantDelta { text } => { assert_eq!(text, format!("answer:{}", a.provider_session_id)); a_delta = true; }
            AgentEvent::TurnCompleted => a_completed = true,
            _ => {}
        }
    }
    assert!(a_delta, "the queued stream delta is retained");
    assert_eq!(method_count(&record, "initialize"), 1, "matching process keys share one child");

    adapter.close_session(&a).await.unwrap();
    start_prompt(adapter.clone(), b.clone(), "after-close", "again").await.unwrap().unwrap();
    let mut completed = false;
    while !completed {
        if let AgentEvent::TurnCompleted = tokio::time::timeout(TURN_EVENT_TIMEOUT, rx_b.recv()).await.unwrap().unwrap() { completed = true }
    }
    adapter.close_session(&b).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn different_environment_keys_spawn_separate_codex_processes() {
    let (runtime, record) = setup(None);
    let adapter = CodexAdapter::default();
    let mut env_a = std::collections::BTreeMap::new();
    env_a.insert("LANG".into(), "fixture-a".into());
    let mut env_b = std::collections::BTreeMap::new();
    env_b.insert("LANG".into(), "fixture-b".into());
    let mut options_a = opts(); options_a.env = env_a;
    let mut options_b = opts(); options_b.env = env_b;
    let cwd = runtime.cwd.clone().unwrap();
    let (tx_a, _) = tokio::sync::mpsc::channel(8);
    let (tx_b, _) = tokio::sync::mpsc::channel(8);
    let a = adapter.new_session(&runtime, new_request("env-a", cwd.clone(), options_a), tx_a).await.unwrap();
    let b = adapter.new_session(&runtime, new_request("env-b", cwd.clone(), options_b), tx_b).await.unwrap();
    assert_eq!(method_count(&record, "initialize"), 2);
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn different_project_working_directories_spawn_separate_codex_processes() {
    let (runtime, record) = setup(None);
    let adapter = CodexAdapter::default();
    let base = runtime.cwd.clone().unwrap();
    let cwd_a = base.join("project-a");
    let cwd_b = base.join("project-b");
    std::fs::create_dir_all(&cwd_a).unwrap();
    std::fs::create_dir_all(&cwd_b).unwrap();
    let (tx_a, _) = tokio::sync::mpsc::channel(8);
    let (tx_b, _) = tokio::sync::mpsc::channel(8);
    let a = adapter.new_session(&runtime, new_request("cwd-a", cwd_a.clone(), opts()), tx_a).await.unwrap();
    let b = adapter.new_session(&runtime, new_request("cwd-b", cwd_b.clone(), opts()), tx_b).await.unwrap();
    assert_eq!(method_count(&record, "initialize"), 2);
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(base);
}

#[tokio::test]
async fn idle_shutdown_waits_until_last_codex_session_closes() {
    let (runtime, record) = setup(None);
    let adapter = CodexAdapter::with_idle_shutdown(Duration::from_millis(40));
    let cwd = runtime.cwd.clone().unwrap();
    let (tx_a, _) = tokio::sync::mpsc::channel(8);
    let (tx_b, _) = tokio::sync::mpsc::channel(8);
    let a = adapter.new_session(&runtime, new_request("idle-a", cwd.clone(), opts()), tx_a).await.unwrap();
    let b = adapter.new_session(&runtime, new_request("idle-b", cwd.clone(), opts()), tx_b).await.unwrap();
    let pid: u32 = std::fs::read_to_string(record.with_extension("pid")).unwrap().parse().unwrap();
    let child = ProcessSignal::open(pid).expect("shared fake child process handle");
    adapter.close_session(&a).await.unwrap();
    assert!(!child.wait_signaled(IDLE_KEEPALIVE_WAIT).await, "one remaining attached session keeps the process alive");
    adapter.close_session(&b).await.unwrap();
    assert!(child.wait_signaled(PROCESS_EXIT_TIMEOUT).await, "idle child shuts down after its last session closes");
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn idle_join_race_never_kills_a_new_codex_attachment() {
    let (runtime, record) = setup(None);
    let adapter = CodexAdapter::with_idle_shutdown(Duration::from_millis(1));
    let cwd = runtime.cwd.clone().unwrap();
    for index in 0..8 {
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        let handle = adapter.new_session(
            &runtime,
            new_request(&format!("idle-race-{index}"), cwd.clone(), opts()),
            tx,
        ).await.unwrap();
        adapter.prompt(&handle, PromptRequest { attachments: Vec::new(),
            turn_id: format!("idle-race-turn-{index}"),
            text: "idle race verification".into(),
            exec_options: opts(),
        }).await.unwrap();
        let mut completed = false;
        while !completed {
            match tokio::time::timeout(TURN_EVENT_TIMEOUT, rx.recv()).await.unwrap().unwrap() {
                AgentEvent::TurnCompleted => completed = true,
                AgentEvent::Error { .. } => panic!("new attachment received an idle-shutdown error"),
                _ => {}
            }
        }
        adapter.close_session(&handle).await.unwrap();
    }
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn successful_pause_all_keeps_shared_child_until_all_session_routes_close() {
    let (runtime, record) = setup(Some("stall"));
    let adapter = std::sync::Arc::new(CodexAdapter::with_idle_shutdown(Duration::from_millis(40)));
    let cwd = runtime.cwd.clone().unwrap();
    let (tx_a, _) = tokio::sync::mpsc::channel(8);
    let (tx_b, _) = tokio::sync::mpsc::channel(8);
    let a = adapter.new_session(&runtime, new_request("pause-a", cwd.clone(), opts()), tx_a).await.unwrap();
    let b = adapter.new_session(&runtime, new_request("pause-b", cwd.clone(), opts()), tx_b).await.unwrap();
    start_prompt(adapter.clone(), a.clone(), "pause-turn-a", "hold-a").await.unwrap().unwrap();
    start_prompt(adapter.clone(), b.clone(), "pause-turn-b", "hold-b").await.unwrap().unwrap();
    let pid: u32 = std::fs::read_to_string(record.with_extension("pid")).unwrap().parse().unwrap();
    let child = ProcessSignal::open(pid).expect("shared fake child process handle");
    let (cancel_a, cancel_b) = tokio::join!(adapter.cancel(&a), adapter.cancel(&b));
    cancel_a.unwrap();
    cancel_b.unwrap();
    assert!(!child.wait_signaled(Duration::ZERO).await, "successful cancellation cannot kill a child with attached conversations");
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    assert!(child.wait_signaled(PROCESS_EXIT_TIMEOUT).await, "last route close eventually shuts down the child");
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn timed_out_cancel_detaches_only_session_a_while_session_b_finishes() {
    let (runtime, record) = setup(Some("cancel-timeout"));
    let adapter = std::sync::Arc::new(CodexAdapter::with_idle_shutdown(Duration::from_secs(2)));
    let cwd = runtime.cwd.clone().unwrap();
    let (tx_a, mut rx_a) = tokio::sync::mpsc::channel(32);
    let (tx_b, mut rx_b) = tokio::sync::mpsc::channel(32);
    let a = adapter.new_session(&runtime, new_request("cancel-a", cwd.clone(), opts()), tx_a).await.unwrap();
    let b = adapter.new_session(&runtime, new_request("cancel-b", cwd.clone(), opts()), tx_b).await.unwrap();
    start_prompt(adapter.clone(), a.clone(), "cancel-a-turn", "hold-a").await.unwrap().unwrap();
    start_prompt(adapter.clone(), b.clone(), "cancel-b-turn", "stream-b").await.unwrap().unwrap();
    let mut saw_b_stream = false;
    while !saw_b_stream {
        if let AgentEvent::AssistantDelta { text } = tokio::time::timeout(TURN_EVENT_TIMEOUT, rx_b.recv()).await.unwrap().unwrap() { assert_eq!(text, format!("answer:{}", b.provider_session_id)); saw_b_stream = true; }
    }
    let pid: u32 = std::fs::read_to_string(record.with_extension("pid")).unwrap().parse().unwrap();
    let child = ProcessSignal::open(pid).expect("shared fake child process handle");
    adapter.cancel(&a).await.unwrap();
    let usage = loop {
        match tokio::time::timeout(TURN_EVENT_TIMEOUT, rx_a.recv()).await.unwrap() {
            Some(AgentEvent::PromptAccepted) => continue,
            other => break other,
        }
    };
    assert!(matches!(usage, Some(AgentEvent::UsageReport { .. })));
    assert!(matches!(tokio::time::timeout(TURN_EVENT_TIMEOUT, rx_a.recv()).await.unwrap(), Some(AgentEvent::TurnCancelled)));
    assert!(!child.wait_signaled(Duration::ZERO).await, "A's cancel timeout must not kill the child used by B");
    let mut b_completed = false;
    while !b_completed {
        match tokio::time::timeout(TURN_EVENT_TIMEOUT, rx_b.recv()).await.unwrap().unwrap() {
            AgentEvent::TurnCompleted => b_completed = true,
            AgentEvent::Error { .. } => panic!("session B must continue after session A detaches"),
            _ => {}
        }
    }
    assert!(!child.wait_signaled(Duration::ZERO).await);
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn crash_notifies_all_sessions_and_next_prompt_restarts_with_resume() {
    let (runtime, record) = setup(Some("crash"));
    let adapter = std::sync::Arc::new(CodexAdapter::with_idle_shutdown(Duration::from_secs(2)));
    let cwd = runtime.cwd.clone().unwrap();
    let (tx_a, mut rx_a) = tokio::sync::mpsc::channel(32);
    let (tx_b, mut rx_b) = tokio::sync::mpsc::channel(32);
    let a = adapter.new_session(&runtime, new_request("crash-a", cwd.clone(), opts()), tx_a).await.unwrap();
    let b = adapter.new_session(&runtime, new_request("crash-b", cwd.clone(), opts()), tx_b).await.unwrap();
    let prompt_b = start_prompt(adapter.clone(), b.clone(), "crash-b-turn", "hold");
    let prompt_a = start_prompt(adapter.clone(), a.clone(), "crash-a-turn", "crash");
    prompt_a.await.unwrap().unwrap();
    prompt_b.await.unwrap().unwrap();
    async fn has_failed_usage_before_error(rx: &mut tokio::sync::mpsc::Receiver<AgentEvent>) -> bool {
        let mut unreported = false;
        loop {
            match tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap() {
                Some(AgentEvent::UsageReport { report, .. }) => unreported = report.usage_status == "unreported",
                Some(AgentEvent::Error { .. }) => return unreported,
                Some(_) => {}
                None => panic!("crashed session event channel closed"),
            }
        }
    }
    assert!(has_failed_usage_before_error(&mut rx_a).await, "session A reserves no invented usage");
    assert!(has_failed_usage_before_error(&mut rx_b).await, "session B reserves no invented usage");

    let restart = start_prompt(adapter.clone(), b.clone(), "restart-turn", "after-restart");
    let mut completed = false;
    while !completed {
        if let AgentEvent::TurnCompleted = tokio::time::timeout(Duration::from_secs(3), rx_b.recv()).await.unwrap().unwrap() { completed = true }
    }
    restart.await.unwrap().unwrap();
    assert_eq!(method_count(&record, "initialize"), 2, "the next prompt lazily starts a replacement process");
    assert!(method_count(&record, "thread/resume") >= 1, "the saved provider thread is resumed");
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn rejected_crash_resume_starts_fresh_and_updates_daemon_provider_pointer() {
    let (runtime, record) = setup(Some("crash-reject"));
    let adapter = std::sync::Arc::new(CodexAdapter::with_idle_shutdown(Duration::from_secs(2)));
    let cwd = runtime.cwd.clone().unwrap();
    let (tx_a, mut rx_a) = tokio::sync::mpsc::channel(32);
    let (tx_b, mut rx_b) = tokio::sync::mpsc::channel(32);
    let a = adapter.new_session(&runtime, new_request("crash-reject-a", cwd.clone(), opts()), tx_a).await.unwrap();
    let b = adapter.new_session(&runtime, new_request("crash-reject-b", cwd.clone(), opts()), tx_b).await.unwrap();
    start_prompt(adapter.clone(), b.clone(), "rejected-crash-b", "hold").await.unwrap().unwrap();
    start_prompt(adapter.clone(), a.clone(), "rejected-crash-a", "crash").await.unwrap().unwrap();
    async fn consume_error(rx: &mut tokio::sync::mpsc::Receiver<AgentEvent>) {
        loop { if matches!(tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap(), Some(AgentEvent::Error { .. })) { return; } }
    }
    consume_error(&mut rx_a).await;
    consume_error(&mut rx_b).await;

    let restart = start_prompt(adapter.clone(), b.clone(), "fresh-after-crash", "new-thread");
    let mut fresh_provider_id = None;
    let mut context_changed = false;
    let mut completed = false;
    while !completed {
        match tokio::time::timeout(Duration::from_secs(3), rx_b.recv()).await.unwrap().unwrap() {
            AgentEvent::SessionStarted { provider_session_id } => fresh_provider_id = Some(provider_session_id),
            AgentEvent::ContextChanged { reason: ContextChangeReason::FreshSession, context_lost: true } => context_changed = true,
            AgentEvent::TurnCompleted => completed = true,
            _ => {}
        }
    }
    restart.await.unwrap().unwrap();
    assert_eq!(fresh_provider_id.as_deref(), Some("thread-1"));
    assert!(context_changed, "a rejected resume announces the fresh-session context change");
    assert_eq!(method_count(&record, "thread/start"), 3);
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}

#[tokio::test]
async fn successful_resume_after_crash_announces_no_context_change() {
    let (runtime, _record) = setup(Some("crash"));
    let adapter = std::sync::Arc::new(CodexAdapter::with_idle_shutdown(Duration::from_secs(2)));
    let cwd = runtime.cwd.clone().unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    let h = adapter.new_session(&runtime, new_request("resume-ok", cwd.clone(), opts()), tx).await.unwrap();
    start_prompt(adapter.clone(), h.clone(), "resume-ok-crash", "crash").await.unwrap().unwrap();
    loop {
        if matches!(tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap(), Some(AgentEvent::Error { .. })) { break; }
    }
    adapter
        .prompt(&h, PromptRequest { attachments: Vec::new(), turn_id: "resume-ok-next".into(), text: "after".into(), exec_options: opts() })
        .await
        .unwrap();
    let mut events = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap().unwrap();
        let done = matches!(event, AgentEvent::TurnCompleted);
        events.push(event);
        if done { break; }
    }
    assert!(!events.iter().any(|event| matches!(event, AgentEvent::ContextChanged { .. })), "a successful resume keeps the conversation context");
    adapter.close_session(&h).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(cwd);
}

#[tokio::test]
async fn fake_peer_acknowledges_each_accepted_turn_start_and_never_a_rejected_one() {
    let (runtime, _record) = setup(None);
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let handle = adapter.new_session(&runtime, qnew(), tx).await.unwrap();
    for turn in ["ack-1", "ack-2"] {
        adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: turn.into(), text: "hello".into(), exec_options: opts() }).await.unwrap();
        // `prompt` only returns once the acknowledgement is delivered, so wait
        // for both it and the turn end even if the fast fake finishes first.
        let mut accepted = 0;
        let mut completed = false;
        while !completed || accepted == 0 {
            let event = tokio::time::timeout(TURN_EVENT_TIMEOUT, rx.recv()).await.unwrap().unwrap();
            if matches!(event, AgentEvent::PromptAccepted) { accepted += 1; }
            if matches!(event, AgentEvent::TurnCompleted) { completed = true; }
        }
        assert_eq!(accepted, 1, "one acceptance per prompt");
    }
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());

    let (runtime, _record) = setup(Some("reject"));
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let handle = adapter.new_session(&runtime, qnew(), tx).await.unwrap();
    let result = adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "rejected".into(), text: "hello".into(), exec_options: opts() }).await;
    assert!(result.is_err());
    while let Ok(event) = rx.try_recv() {
        assert!(!matches!(event, AgentEvent::PromptAccepted), "a rejected turn/start is never acknowledged");
    }
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
}

#[tokio::test]
async fn steer_accepts_with_the_schema_exact_request_and_reports_stale_and_reject() {
    // accept: the request is exactly the generated TurnSteerParams shape.
    let (runtime, record) = setup(None);
    let adapter = CodexAdapter::default();
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    let handle = adapter.new_session(&runtime, qnew(), tx).await.unwrap();
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "local-steer".into(), text: "hello".into(), exec_options: opts() }).await.unwrap();
    let accepted = adapter.steer(&handle, SteerRequest { turn_id: "local-steer".into(), text: "add this".into() }).await.unwrap();
    assert_eq!(accepted, SteerOutcome::Accepted);
    let rows = log(&record);
    let steer = rows.iter().find(|row| row["method"] == "turn/steer").expect("turn/steer request recorded");
    assert_eq!(steer["params"]["threadId"], handle.provider_session_id);
    assert_eq!(steer["params"]["expectedTurnId"], "turn-1");
    assert_eq!(steer["params"]["input"][0]["type"], "text");
    assert_eq!(steer["params"]["input"][0]["textPresent"], true);
    assert_eq!(steer["params"]["input"][0]["textSha256"], instruction_sha256("add this").unwrap());
    assert_eq!(rows.iter().filter(|row| row["method"] == "turn/steer").count(), 1);
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());

    // stale: the provider says the expected turn is no longer active.
    let (runtime, _record) = setup(Some("steer-stale"));
    let adapter = CodexAdapter::default();
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    let handle = adapter.new_session(&runtime, qnew(), tx).await.unwrap();
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "stale-turn".into(), text: "hello".into(), exec_options: opts() }).await.unwrap();
    let stale = adapter.steer(&handle, SteerRequest { turn_id: "stale-turn".into(), text: "too late".into() }).await.unwrap();
    assert_eq!(stale, SteerOutcome::Stale);
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());

    // reject: an unrelated JSON-RPC error stays an error.
    let (runtime, _record) = setup(Some("steer-reject"));
    let adapter = CodexAdapter::default();
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    let handle = adapter.new_session(&runtime, qnew(), tx).await.unwrap();
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "reject-turn".into(), text: "hello".into(), exec_options: opts() }).await.unwrap();
    let error = adapter.steer(&handle, SteerRequest { turn_id: "reject-turn".into(), text: "nope".into() }).await.unwrap_err();
    assert!(matches!(error, AdapterError::Rejected(_)));
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
}

fn instructions(text: &str) -> ExecOptions {
    ExecOptions { instructions: Some(text.into()), ..opts() }
}

/// Collects events until the turn ends, so a test observes the ExecApplied
/// outcomes the completion path emits and never races the next turn.
async fn drain_turn(rx: &mut tokio::sync::mpsc::Receiver<AgentEvent>) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    loop {
        let event = tokio::time::timeout(TURN_EVENT_TIMEOUT, rx.recv()).await.unwrap().unwrap();
        let done = matches!(event, AgentEvent::TurnCompleted);
        events.push(event);
        if done { break; }
    }
    events
}

#[tokio::test]
async fn changed_instructions_use_collaboration_mode_and_a_matching_echo_confirms_them() {
    let (runtime, record) = setup(Some("echo-instructions"));
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let handle = adapter.new_session(&runtime, qnew(), tx).await.unwrap();
    // Unchanged hash: no collaborationMode churn on a normal turn.
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "same-1".into(), text: "hello".into(), exec_options: opts() }).await.unwrap();
    drain_turn(&mut rx).await;
    // Changed hash on an existing thread: the new text rides the turn.
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "change-1".into(), text: "hello".into(), exec_options: instructions("changed instructions") }).await.unwrap();
    let events = drain_turn(&mut rx).await;
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ExecApplied { turn_id, outcomes }
        if turn_id == "change-1"
        && outcomes["instructions"].applied == Some(true)
        && outcomes["instructions"].evidence_kind == EvidenceKind::ProviderEcho)));
    // The confirmed change advances the baseline, so the next turn is quiet.
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "same-2".into(), text: "hello".into(), exec_options: instructions("changed instructions") }).await.unwrap();
    drain_turn(&mut rx).await;
    let turns = log(&record).into_iter().filter(|row| row["method"] == "turn/start").collect::<Vec<_>>();
    assert!(turns[0]["params"].get("collaborationMode").is_none(), "an unchanged hash sends no collaborationMode");
    assert_eq!(turns[1]["params"]["collaborationMode"]["mode"], "default");
    assert_eq!(turns[1]["params"]["collaborationMode"]["settings"]["model"], "m1");
    assert_eq!(turns[1]["params"]["collaborationMode"]["settings"]["developerInstructionsSha256"], instruction_sha256("changed instructions").unwrap());
    assert!(turns[2]["params"].get("collaborationMode").is_none(), "an applied change is not resent");
    let redacted = std::fs::read_to_string(&record).unwrap();
    assert!(!redacted.contains("sentinel instruction"));
    assert!(!redacted.contains("changed instructions"));
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
}

#[tokio::test]
async fn an_unverified_instructions_change_reports_applied_null_and_sends_the_new_text() {
    let (runtime, record) = setup(None);
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let handle = adapter.new_session(&runtime, qnew(), tx).await.unwrap();
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "unverified".into(), text: "hello".into(), exec_options: instructions("changed instructions") }).await.unwrap();
    let events = drain_turn(&mut rx).await;
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ExecApplied { turn_id, outcomes }
        if turn_id == "unverified"
        && outcomes["instructions"].applied.is_none()
        && outcomes["instructions"].reason.as_deref() == Some("instructions_sent_unverified"))));
    let turn = log(&record).into_iter().find(|row| row["method"] == "turn/start").unwrap();
    assert_eq!(turn["params"]["collaborationMode"]["mode"], "default");
    assert_eq!(turn["params"]["collaborationMode"]["settings"]["developerInstructionsSha256"], instruction_sha256("changed instructions").unwrap());
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
}

#[tokio::test]
async fn a_mismatched_settings_echo_reports_the_change_as_rejected() {
    let (runtime, record) = setup(Some("echo-other"));
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let handle = adapter.new_session(&runtime, qnew(), tx).await.unwrap();
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "mismatch".into(), text: "hello".into(), exec_options: instructions("changed instructions") }).await.unwrap();
    let events = drain_turn(&mut rx).await;
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ExecApplied { turn_id, outcomes }
        if turn_id == "mismatch"
        && outcomes["instructions"].applied == Some(false)
        && outcomes["instructions"].reason.as_deref() == Some("instructions_change_requires_new_thread"))));
    let redacted = std::fs::read_to_string(&record).unwrap();
    assert!(!redacted.contains("changed instructions"));
    assert!(!redacted.contains("other instructions"));
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
}

#[tokio::test]
async fn a_plan_turn_sends_null_instructions_and_the_next_default_turn_restores_current_text() {
    let (runtime, record) = setup(None);
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let handle = adapter.new_session(&runtime, qnew(), tx).await.unwrap();
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "plan-1".into(), text: "hello".into(), exec_options: ExecOptions { plan_mode: true, ..opts() } }).await.unwrap();
    drain_turn(&mut rx).await;
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "plan-2".into(), text: "hello".into(), exec_options: opts() }).await.unwrap();
    drain_turn(&mut rx).await;
    let turns = log(&record).into_iter().filter(|row| row["method"] == "turn/start").collect::<Vec<_>>();
    assert_eq!(turns[0]["params"]["collaborationMode"]["mode"], "plan");
    assert_eq!(turns[0]["params"]["collaborationMode"]["settings"]["developerInstructionsPresent"], false);
    assert_eq!(turns[1]["params"]["collaborationMode"]["mode"], "default");
    assert_eq!(turns[1]["params"]["collaborationMode"]["settings"]["developerInstructionsSha256"], instruction_sha256("sentinel instruction").unwrap());
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
}

#[tokio::test]
async fn an_instructions_change_without_a_known_model_keeps_the_new_conversation_outcome() {
    let (runtime, record) = setup(Some("no-model"));
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let options = ExecOptions { model: None, instructions: Some("sentinel instruction".into()), ..opts() };
    let handle = adapter
        .new_session(&runtime, NewSessionRequest { session_id: "no-model".into(), project_path: PathBuf::from("."), exec_options: options.clone() }, tx)
        .await
        .unwrap();
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "no-model-turn".into(), text: "hello".into(), exec_options: ExecOptions { instructions: Some("changed instructions".into()), ..options.clone() } }).await.unwrap();
    let outcomes = tokio::time::timeout(TURN_EVENT_TIMEOUT, async {
        loop {
            if let Some(AgentEvent::ExecApplied { turn_id, outcomes }) = rx.recv().await {
                if turn_id == "no-model-turn" { break outcomes; }
            }
        }
    }).await.unwrap();
    assert_eq!(outcomes["instructions"].applied, Some(false));
    assert_eq!(outcomes["instructions"].reason.as_deref(), Some("instructions_change_requires_new_thread"));
    let turns = log(&record).into_iter().filter(|row| row["method"] == "turn/start").collect::<Vec<_>>();
    assert!(turns.iter().all(|row| row["params"].get("collaborationMode").is_none()), "no model means nothing is sent");
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
}

#[tokio::test]
async fn a_rejected_turn_start_keeps_the_instruction_baseline_and_retries() {
    let (runtime, record) = setup(Some("reject"));
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let handle = adapter.new_session(&runtime, qnew(), tx).await.unwrap();
    for turn in ["reject-1", "reject-2"] {
        let result = adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: turn.into(), text: "hello".into(), exec_options: instructions("changed instructions") }).await;
        assert!(result.is_err());
        let outcomes = tokio::time::timeout(TURN_EVENT_TIMEOUT, async {
            loop {
                if let Some(AgentEvent::ExecApplied { turn_id, outcomes }) = rx.recv().await {
                    if turn_id == turn { break outcomes; }
                }
            }
        }).await.unwrap();
        assert_eq!(outcomes["instructions"].applied, Some(false));
        assert_eq!(outcomes["instructions"].reason.as_deref(), Some("instructions_change_requires_new_thread"));
    }
    let turns = log(&record).into_iter().filter(|row| row["method"] == "turn/start").collect::<Vec<_>>();
    assert_eq!(turns.len(), 2, "a rejected turn/start is retried on the next turn");
    let expected = instruction_sha256("changed instructions").unwrap();
    assert!(turns.iter().all(|row| row["params"]["collaborationMode"]["settings"]["developerInstructionsSha256"] == json!(expected)));
    adapter.close_session(&handle).await.unwrap();
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
}

#[tokio::test]
async fn resume_sends_developer_instructions_only_when_the_stored_hash_differs() {
    let (runtime, record) = setup(None);
    let adapter = CodexAdapter::default();
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    let handle = adapter.new_session(&runtime, new_request("resume-diff", PathBuf::from("."), opts()), tx).await.unwrap();
    let provider = handle.provider_session_id.clone();
    adapter.close_session(&handle).await.unwrap();
    let differ = instruction_sha256("changed instructions").unwrap();
    let installed = instruction_sha256("sentinel instruction").unwrap();
    adapter.set_instruction_hash_context("resume-diff", Some(differ.clone()), Some(installed)).await;
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    let resumed = adapter.resume_session(&runtime, ResumeSessionRequest { session_id: "resume-diff".into(), provider_session_id: provider.clone(), project_path: PathBuf::from("."), exec_options: instructions("changed instructions") }, tx).await.unwrap();
    adapter.close_session(&resumed).await.unwrap();
    // Equal hash: nothing is resent.
    adapter.set_instruction_hash_context("resume-diff", Some(differ.clone()), Some(differ.clone())).await;
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    let resumed = adapter.resume_session(&runtime, ResumeSessionRequest { session_id: "resume-diff".into(), provider_session_id: provider, project_path: PathBuf::from("."), exec_options: instructions("changed instructions") }, tx).await.unwrap();
    adapter.close_session(&resumed).await.unwrap();
    let resumes = log(&record).into_iter().filter(|row| row["method"] == "thread/resume").collect::<Vec<_>>();
    assert_eq!(resumes.len(), 2);
    assert_eq!(resumes[0]["params"]["developerInstructionsSha256"], differ);
    assert_eq!(resumes[0]["params"]["developerInstructionsPresent"], true);
    assert!(resumes[1]["params"].get("developerInstructions").is_none(), "an equal stored hash sends nothing");
    let _ = std::fs::remove_dir_all(runtime.cwd.unwrap());
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}
