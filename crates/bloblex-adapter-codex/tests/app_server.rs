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
        adapter.prompt(&handle, PromptRequest { turn_id: turn_id.into(), text: text.into(), exec_options: opts() }).await
    })
}

fn method_count(record: &PathBuf, method: &str) -> usize {
    log(record).iter().filter(|row| row["method"] == method).count()
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
        match tokio::time::timeout(TURN_EVENT_TIMEOUT, rx_b.recv()).await.unwrap().unwrap() {
            AgentEvent::TurnCompleted => b_completed = true,
            _ => {}
        }
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
        match tokio::time::timeout(TURN_EVENT_TIMEOUT, rx_b.recv()).await.unwrap().unwrap() {
            AgentEvent::TurnCompleted => completed = true,
            _ => {}
        }
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
        adapter.prompt(&handle, PromptRequest {
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
        match tokio::time::timeout(TURN_EVENT_TIMEOUT, rx_b.recv()).await.unwrap().unwrap() {
            AgentEvent::AssistantDelta { text } => { assert_eq!(text, format!("answer:{}", b.provider_session_id)); saw_b_stream = true; }
            _ => {}
        }
    }
    let pid: u32 = std::fs::read_to_string(record.with_extension("pid")).unwrap().parse().unwrap();
    let child = ProcessSignal::open(pid).expect("shared fake child process handle");
    adapter.cancel(&a).await.unwrap();
    assert!(matches!(tokio::time::timeout(TURN_EVENT_TIMEOUT, rx_a.recv()).await.unwrap(), Some(AgentEvent::UsageReport { .. })));
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
        match tokio::time::timeout(Duration::from_secs(3), rx_b.recv()).await.unwrap().unwrap() {
            AgentEvent::TurnCompleted => completed = true,
            _ => {}
        }
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
    let mut completed = false;
    while !completed {
        match tokio::time::timeout(Duration::from_secs(3), rx_b.recv()).await.unwrap().unwrap() {
            AgentEvent::SessionStarted { provider_session_id } => fresh_provider_id = Some(provider_session_id),
            AgentEvent::TurnCompleted => completed = true,
            _ => {}
        }
    }
    restart.await.unwrap().unwrap();
    assert_eq!(fresh_provider_id.as_deref(), Some("thread-1"));
    assert_eq!(method_count(&record, "thread/start"), 3);
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(record.parent().unwrap());
}
