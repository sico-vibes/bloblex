use bloblex_adapter_acp::AcpAdapter;
use bloblex_agent_core::{AgentAdapter, AgentEvent, ExecOptions, NewSessionRequest, PromptRequest, RuntimeSpec};
use std::{path::{Path, PathBuf}, process::Command, sync::Arc, time::Duration};
use tokio::sync::mpsc;

const CRASH_EVENT_TIMEOUT: Duration = Duration::from_secs(30);
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
            while Path::new("/proc").join(self.0.to_string()).exists() { tokio::time::sleep(Duration::from_millis(20)).await; }
        }).await.is_ok()
    }
}

fn runtime(mode: &str) -> RuntimeSpec {
    runtime_with_log(mode, None)
}

fn runtime_with_log(mode: &str, log: Option<&Path>) -> RuntimeSpec {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("fake-acp-agent.mjs");
    RuntimeSpec {
        runtime_id: "fixture".into(),
        provider: "opencode".into(),
        executable: PathBuf::from("node"),
        args: std::iter::once(fixture.to_string_lossy().into_owned())
            .chain(std::iter::once(mode.into()))
            .chain(log.map(|path| path.to_string_lossy().into_owned()))
            .collect(),
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
    new_session_with(adapter, &runtime(mode), session_id, ExecOptions::default(), 32).await
}

fn test_temp_dir() -> PathBuf {
    static NEXT_TEMP_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let path = std::env::temp_dir().join(format!(
        "bloblex-acp-shared-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        NEXT_TEMP_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

async fn new_session_with(
    adapter: &AcpAdapter,
    runtime: &RuntimeSpec,
    session_id: &str,
    exec_options: ExecOptions,
    channel_capacity: usize,
) -> (bloblex_agent_core::SessionHandle, mpsc::Receiver<AgentEvent>) {
    let mut command = Command::new("node");
    assert!(
        command.arg("--version").output().is_ok(),
        "Node.js is required for fake ACP child tests"
    );
    let (tx, rx) = mpsc::channel(channel_capacity);
    let handle = adapter
        .new_session(
            runtime,
            NewSessionRequest {
                session_id: session_id.into(),
                project_path: std::env::current_dir().unwrap(),
                exec_options,
            },
            tx,
        )
        .await
        .unwrap();
    (handle, rx)
}

fn prompt(adapter: Arc<AcpAdapter>, handle: bloblex_agent_core::SessionHandle, text: &'static str) -> tokio::task::JoinHandle<Result<(), bloblex_agent_core::AdapterError>> {
    tokio::spawn(async move {
        adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: format!("turn-{text}"), text: text.into(), exec_options: Default::default() }).await
    })
}

async fn crash_report_before_error(events: &mut mpsc::Receiver<AgentEvent>) -> bool {
    let mut report = false;
    loop {
        match tokio::time::timeout(CRASH_EVENT_TIMEOUT, events.recv()).await.unwrap() {
            Some(AgentEvent::UsageReport { report: value, .. }) => report = value.usage_status == "unreported",
            Some(AgentEvent::Error { .. }) => return report,
            Some(_) => {}
            None => panic!("crashed session event channel closed"),
        }
    }
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
                PromptRequest { attachments: Vec::new(),
                    turn_id: "turn-1".into(),
                    text: "Return fixture text".into(),
                    exec_options: Default::default(),
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
            AgentEvent::AssistantDelta { text } if text.starts_with("fixture response:") => saw_delta = true,
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
                PromptRequest { attachments: Vec::new(),
                    turn_id: "turn-permission".into(),
                    text: "Ask permission".into(),
                    exec_options: Default::default(),
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
                PromptRequest { attachments: Vec::new(),
                    turn_id: "turn-permission-b".into(),
                    text: "Ask permission".into(),
                    exec_options: Default::default(),
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
async fn shared_process_routes_sessions_and_slow_consumer_does_not_block_peer() {
    let adapter = Arc::new(AcpAdapter::with_idle_shutdown(Duration::from_secs(2)));
    let temp = test_temp_dir();
    let pid_log = temp.join("acp-pids.log");
    let runtime = runtime_with_log("interleave", Some(&pid_log));
    let (handle_a, mut events_a) = new_session_with(&adapter, &runtime, "shared-a", ExecOptions::default(), 1).await;
    let (handle_b, mut events_b) = new_session_with(&adapter, &runtime, "shared-b", ExecOptions::default(), 32).await;

    let prompt_a = prompt(adapter.clone(), handle_a.clone(), "slow-a");
    let prompt_b = prompt(adapter.clone(), handle_b.clone(), "fast-b");
    let b_result = tokio::time::timeout(FAST_PEER_EVENT_TIMEOUT, async {
        let mut delta = false;
        let mut completed = false;
        while !completed {
            match events_b.recv().await {
                Some(AgentEvent::AssistantDelta { text }) => {
                    assert!(text.contains(&handle_b.provider_session_id));
                    delta = true;
                }
                Some(AgentEvent::TurnCompleted) => completed = true,
                Some(_) => {}
                None => panic!("session B event stream closed"),
            }
        }
        delta
    }).await.unwrap();
    assert!(b_result);
    prompt_b.await.unwrap().unwrap();

    let mut a_delta = false;
    let mut a_completed = false;
    while !a_completed {
        match tokio::time::timeout(TURN_EVENT_TIMEOUT, events_a.recv()).await.unwrap() {
            Some(AgentEvent::AssistantDelta { text }) => {
                assert!(text.contains(&handle_a.provider_session_id));
                a_delta = true;
            }
            Some(AgentEvent::TurnCompleted) => a_completed = true,
            Some(_) => {}
            None => panic!("session A event stream closed"),
        }
    }
    assert!(a_delta);
    prompt_a.await.unwrap().unwrap();
    let starts = std::fs::read_to_string(&pid_log).unwrap().lines().filter(|line| line.starts_with("start:")).count();
    assert_eq!(starts, 1, "matching process keys must share one child");

    adapter.close_session(&handle_a).await.unwrap();
    let prompt_b_again = prompt(adapter.clone(), handle_b.clone(), "after-close");
    let mut b_completed = false;
    while !b_completed {
        match tokio::time::timeout(Duration::from_secs(2), events_b.recv()).await.unwrap() {
            Some(AgentEvent::TurnCompleted) => b_completed = true,
            Some(_) => {}
            None => panic!("session B event stream closed after session A closed"),
        }
    }
    prompt_b_again.await.unwrap().unwrap();
    adapter.close_session(&handle_b).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(temp);
}

#[tokio::test]
async fn different_environment_keys_spawn_separate_processes() {
    let adapter = Arc::new(AcpAdapter::default());
    let temp = test_temp_dir();
    let pid_log = temp.join("acp-env-pids.log");
    let runtime = runtime_with_log("success", Some(&pid_log));
    let mut env_a = std::collections::BTreeMap::new();
    env_a.insert("LANG".into(), "fixture-a".into());
    let mut env_b = std::collections::BTreeMap::new();
    env_b.insert("LANG".into(), "fixture-b".into());
    let options_a = ExecOptions { env: env_a, ..ExecOptions::default() };
    let options_b = ExecOptions { env: env_b, ..ExecOptions::default() };
    let (a, _) = new_session_with(&adapter, &runtime, "env-a", options_a, 8).await;
    let (b, _) = new_session_with(&adapter, &runtime, "env-b", options_b, 8).await;
    let starts = std::fs::read_to_string(&pid_log).unwrap().lines().filter(|line| line.starts_with("start:")).count();
    assert_eq!(starts, 2);
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(temp);
}

#[tokio::test]
async fn different_acp_config_content_spawns_separate_processes() {
    let adapter = AcpAdapter::default();
    let temp = test_temp_dir();
    let pid_log = temp.join("acp-config-pids.log");
    let runtime = runtime_with_log("success", Some(&pid_log));
    let options_a = ExecOptions { instructions: Some("instruction-a".into()), ..ExecOptions::default() };
    let options_b = ExecOptions { instructions: Some("instruction-b".into()), ..ExecOptions::default() };
    let (a, _) = new_session_with(&adapter, &runtime, "config-a", options_a, 8).await;
    let (b, _) = new_session_with(&adapter, &runtime, "config-b", options_b, 8).await;
    assert_eq!(std::fs::read_to_string(&pid_log).unwrap().lines().filter(|line| line.starts_with("start:")).count(), 2);
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(temp);
}

#[tokio::test]
async fn idle_shutdown_waits_for_last_session_then_stops_shared_child() {
    let adapter = Arc::new(AcpAdapter::with_idle_shutdown(Duration::from_millis(40)));
    let temp = test_temp_dir();
    let pid_log = temp.join("acp-idle-pids.log");
    let runtime = runtime_with_log("success", Some(&pid_log));
    let (a, _) = new_session_with(&adapter, &runtime, "idle-a", ExecOptions::default(), 8).await;
    let (b, _) = new_session_with(&adapter, &runtime, "idle-b", ExecOptions::default(), 8).await;
    let pid: u32 = std::fs::read_to_string(&pid_log).unwrap().lines()
        .find_map(|line| line.strip_prefix("start:").and_then(|pid| pid.parse().ok())).unwrap();
    let child = ProcessSignal::open(pid).expect("shared fake child process handle");
    adapter.close_session(&a).await.unwrap();
    assert!(!child.wait_signaled(IDLE_KEEPALIVE_WAIT).await, "one remaining attached session keeps the child alive past idle timeout");
    adapter.close_session(&b).await.unwrap();
    assert!(child.wait_signaled(PROCESS_EXIT_TIMEOUT).await, "last-session close eventually shuts down the child");
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(temp);
}

#[tokio::test]
async fn idle_join_race_never_kills_a_new_acp_attachment() {
    let adapter = AcpAdapter::with_idle_shutdown(Duration::from_millis(1));
    let temp = test_temp_dir();
    let pid_log = temp.join("acp-idle-race-pids.log");
    let runtime = runtime_with_log("success", Some(&pid_log));
    for index in 0..8 {
        let (tx, mut events) = mpsc::channel(16);
        let handle = adapter.new_session(
            &runtime,
            NewSessionRequest {
                session_id: format!("acp-idle-race-{index}"),
                project_path: std::env::current_dir().unwrap(),
                exec_options: ExecOptions::default(),
            },
            tx,
        ).await.unwrap();
        adapter.prompt(&handle, PromptRequest { attachments: Vec::new(),
            turn_id: format!("acp-idle-race-turn-{index}"),
            text: "idle race verification".into(),
            exec_options: ExecOptions::default(),
        }).await.unwrap();
        let mut completed = false;
        while !completed {
            match tokio::time::timeout(TURN_EVENT_TIMEOUT, events.recv()).await.unwrap().unwrap() {
                AgentEvent::TurnCompleted => completed = true,
                AgentEvent::Error { .. } => panic!("new attachment received an idle-shutdown error"),
                _ => {}
            }
        }
        adapter.close_session(&handle).await.unwrap();
    }
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(temp);
}

#[tokio::test]
async fn successful_acp_pause_all_keeps_shared_child_until_all_session_routes_close() {
    let adapter = Arc::new(AcpAdapter::with_idle_shutdown(Duration::from_millis(40)));
    let temp = test_temp_dir();
    let pid_log = temp.join("acp-pause-pids.log");
    let runtime = runtime_with_log("cancel", Some(&pid_log));
    let (a, mut events_a) = new_session_with(&adapter, &runtime, "pause-a", ExecOptions::default(), 16).await;
    let (b, mut events_b) = new_session_with(&adapter, &runtime, "pause-b", ExecOptions::default(), 16).await;
    let prompt_a = prompt(adapter.clone(), a.clone(), "hold-a");
    let prompt_b = prompt(adapter.clone(), b.clone(), "hold-b");
    let (delta_a, delta_b) = tokio::join!(events_a.recv(), events_b.recv());
    assert!(matches!(delta_a, Some(AgentEvent::AssistantDelta { .. })));
    assert!(matches!(delta_b, Some(AgentEvent::AssistantDelta { .. })));
    let (cancel_a, cancel_b) = tokio::join!(adapter.cancel(&a), adapter.cancel(&b));
    cancel_a.unwrap();
    cancel_b.unwrap();
    prompt_a.await.unwrap().unwrap();
    prompt_b.await.unwrap().unwrap();
    assert!(!std::fs::read_to_string(&pid_log).unwrap().lines().any(|line| line.starts_with("exit:")), "successful cancellation cannot kill a child with attached conversations");
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if std::fs::read_to_string(&pid_log).unwrap().lines().any(|line| line.starts_with("exit:")) { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(temp);
}

#[tokio::test]
async fn timed_out_acp_cancel_detaches_only_session_a_while_session_b_completes() {
    let adapter = Arc::new(AcpAdapter::with_idle_shutdown(Duration::from_secs(2)));
    let temp = test_temp_dir();
    let pid_log = temp.join("acp-cancel-timeout-pids.log");
    let runtime = runtime_with_log("cancel-timeout", Some(&pid_log));
    let (a, mut events_a) = new_session_with(&adapter, &runtime, "cancel-timeout-a", ExecOptions::default(), 32).await;
    let (b, mut events_b) = new_session_with(&adapter, &runtime, "cancel-timeout-b", ExecOptions::default(), 32).await;
    let prompt_a = prompt(adapter.clone(), a.clone(), "hold-a");
    let prompt_b = prompt(adapter.clone(), b.clone(), "stream-b");
    assert!(matches!(tokio::time::timeout(Duration::from_secs(2), events_a.recv()).await.unwrap(), Some(AgentEvent::AssistantDelta { .. })));
    assert!(matches!(tokio::time::timeout(Duration::from_secs(2), events_b.recv()).await.unwrap(), Some(AgentEvent::AssistantDelta { .. })));
    adapter.cancel(&a).await.unwrap();
    assert!(matches!(events_a.recv().await, Some(AgentEvent::UsageReport { .. })));
    assert!(matches!(events_a.recv().await, Some(AgentEvent::TurnCancelled)));
    assert!(!std::fs::read_to_string(&pid_log).unwrap().lines().any(|line| line.starts_with("exit:")), "session B keeps the shared process alive");
    let mut completed = false;
    while !completed {
        match tokio::time::timeout(Duration::from_secs(2), events_b.recv()).await.unwrap().unwrap() {
            AgentEvent::TurnCompleted => completed = true,
            AgentEvent::Error { .. } => panic!("session B must continue after session A detaches"),
            _ => {}
        }
    }
    assert!(!std::fs::read_to_string(&pid_log).unwrap().lines().any(|line| line.starts_with("exit:")));
    prompt_b.await.unwrap().unwrap();
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    adapter.shutdown().await;
    prompt_a.await.unwrap().unwrap();
    let _ = std::fs::remove_dir_all(temp);
}

#[tokio::test]
async fn crash_fans_out_and_next_prompt_restarts_then_loads_sessions() {
    let adapter = Arc::new(AcpAdapter::with_idle_shutdown(Duration::from_secs(2)));
    let temp = test_temp_dir();
    let pid_log = temp.join("acp-crash-pids.log");
    let runtime = runtime_with_log("crash", Some(&pid_log));
    let (a, mut events_a) = new_session_with(&adapter, &runtime, "crash-a", ExecOptions::default(), 32).await;
    let (b, mut events_b) = new_session_with(&adapter, &runtime, "crash-b", ExecOptions::default(), 32).await;
    let prompt_b = prompt(adapter.clone(), b.clone(), "wait-for-crash");
    let prompt_a = prompt(adapter.clone(), a.clone(), "crash");
    assert!(prompt_a.await.unwrap().is_err());
    assert!(prompt_b.await.unwrap().is_err());
    assert!(crash_report_before_error(&mut events_a).await, "session A crash usage remains unreported");
    assert!(crash_report_before_error(&mut events_b).await, "session B crash usage remains unreported");

    let restart = prompt(adapter.clone(), b.clone(), "after-restart");
    let mut completed = false;
    while !completed {
        match tokio::time::timeout(CRASH_EVENT_TIMEOUT, events_b.recv()).await.unwrap() {
            Some(AgentEvent::TurnCompleted) => completed = true,
            Some(AgentEvent::Error { .. }) => panic!("restarted session failed before completing its turn"),
            Some(_) => {}
            None => panic!("session B event stream closed after restart"),
        }
    }
    restart.await.unwrap().unwrap();
    let records = std::fs::read_to_string(&pid_log).unwrap();
    assert_eq!(records.lines().filter(|line| line.starts_with("start:")).count(), 2);
    assert!(records.lines().any(|line| line.starts_with("load:")), "restart resumes the provider session");
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(temp);
}

#[tokio::test]
async fn rejected_crash_load_starts_fresh_and_updates_daemon_provider_pointer() {
    let adapter = Arc::new(AcpAdapter::with_idle_shutdown(Duration::from_secs(2)));
    let temp = test_temp_dir();
    let pid_log = temp.join("acp-crash-reject-pids.log");
    let runtime = runtime_with_log("crash-reject", Some(&pid_log));
    let (a, mut events_a) = new_session_with(&adapter, &runtime, "crash-reject-a", ExecOptions::default(), 32).await;
    let (b, mut events_b) = new_session_with(&adapter, &runtime, "crash-reject-b", ExecOptions::default(), 32).await;
    let prompt_b = prompt(adapter.clone(), b.clone(), "hold");
    let prompt_a = prompt(adapter.clone(), a.clone(), "crash");
    assert!(prompt_a.await.unwrap().is_err());
    assert!(prompt_b.await.unwrap().is_err());
    assert!(crash_report_before_error(&mut events_a).await);
    assert!(crash_report_before_error(&mut events_b).await);

    let restart = prompt(adapter.clone(), b.clone(), "after-restart");
    let mut new_provider_id = None;
    let mut completed = false;
    while !completed {
        match tokio::time::timeout(Duration::from_secs(5), events_b.recv()).await.unwrap().unwrap() {
            AgentEvent::SessionStarted { provider_session_id } => new_provider_id = Some(provider_session_id),
            AgentEvent::TurnCompleted => completed = true,
            AgentEvent::Error { .. } => panic!("fresh ACP session failed"),
            _ => {}
        }
    }
    restart.await.unwrap().unwrap();
    assert_eq!(new_provider_id.as_deref(), Some("native-session-1"));
    let records = std::fs::read_to_string(&pid_log).unwrap();
    assert_eq!(records.lines().filter(|line| line.starts_with("start:")).count(), 2);
    adapter.close_session(&a).await.unwrap();
    adapter.close_session(&b).await.unwrap();
    adapter.shutdown().await;
    let _ = std::fs::remove_dir_all(temp);
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
                PromptRequest { attachments: Vec::new(),
                    turn_id: "turn-cancel".into(),
                    text: "Wait for cancellation".into(),
                    exec_options: Default::default(),
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
                PromptRequest { attachments: Vec::new(),
                    turn_id: "turn-permission-cancel".into(),
                    text: "Wait for permission".into(),
                    exec_options: Default::default(),
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
