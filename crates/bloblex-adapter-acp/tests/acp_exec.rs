use bloblex_adapter_acp::{sha256_hex, AcpAdapter};
use bloblex_agent_core::{
    AdapterError, AgentAdapter, AgentEvent, EvidenceKind, ExecOptions, NewSessionRequest, PromptRequest,
    ResumeSessionRequest, RuntimeSpec, SessionHandle,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

const SENTINEL: &str = "BLOBLEX_SENTINEL_INSTRUCTION_9f3a";
const PARENT_MARKER: &str = "PARENT_ONLY_MARKER_7c2e";
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(10);

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

fn runtime(args: Vec<String>) -> RuntimeSpec {
    RuntimeSpec {
        runtime_id: "fixture".into(),
        provider: "opencode".into(),
        executable: peer(),
        args,
        cwd: None,
    }
}

fn options(model: Option<&str>, thinking: Option<&str>, instructions: Option<&str>) -> ExecOptions {
    ExecOptions {
        model: model.map(str::to_owned),
        thinking: thinking.map(str::to_owned),
        instructions: instructions.map(str::to_owned),
        ..ExecOptions::default()
    }
}

struct Temp {
    dir: PathBuf,
}

impl Temp {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("bloblex-acp-test-{}", uuid_ish()));
        std::fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }

    fn record(&self) -> PathBuf {
        self.dir.join("record.json")
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn uuid_ish() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    format!(
        "{}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        Instant::now().elapsed().as_nanos()
    )
}

fn read_record(path: &Path) -> Value {
    let bytes = std::fs::read(path).unwrap_or_else(|error| panic!("record {}: {error}", path.display()));
    serde_json::from_slice(&bytes).unwrap()
}

fn rpc_trace(record: &Value) -> Vec<String> {
    record["rpc"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let method = entry["method"].as_str().unwrap();
            if method == "session/set_config_option" {
                format!(
                    "{method} {}={}",
                    entry["configId"].as_str().unwrap_or(""),
                    entry["value"].as_str().unwrap_or("")
                )
            } else {
                method.to_owned()
            }
        })
        .collect()
}

async fn open_session(
    adapter: &AcpAdapter,
    args: Vec<String>,
    exec: ExecOptions,
) -> (SessionHandle, mpsc::Receiver<AgentEvent>) {
    let (tx, rx) = mpsc::channel(64);
    let handle = adapter
        .new_session(
            &runtime(args),
            NewSessionRequest {
                session_id: "bloblex-session".into(),
                project_path: std::env::temp_dir(),
                exec_options: exec,
            },
            tx,
        )
        .await
        .unwrap();
    (handle, rx)
}

fn set_env(key: &str, value: &str) {
    unsafe { std::env::set_var(key, value) }
}

fn unset_env(key: &str) {
    unsafe { std::env::remove_var(key) }
}

struct EnvSet {
    key: &'static str,
    previous: Option<String>,
}

impl EnvSet {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        set_env(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvSet {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            set_env(self.key, previous);
        } else {
            unset_env(self.key);
        }
    }
}

fn assert_no_secret(haystack: &str) {
    assert!(!haystack.contains(SENTINEL), "instruction text leaked");
    assert!(!haystack.contains(PARENT_MARKER), "parent config leaked");
}

fn events_text(events: &[AgentEvent]) -> String {
    events
        .iter()
        .map(|event| format!("{event:?}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn take_report(events: &[AgentEvent]) -> &bloblex_agent_core::UsageReport {
    events
        .iter()
        .find_map(|event| match event {
            AgentEvent::UsageReport { report, .. } => Some(report),
            _ => None,
        })
        .unwrap()
}

fn take_outcomes(events: &[AgentEvent]) -> &BTreeMap<String, bloblex_agent_core::SettingOutcome> {
    events
        .iter()
        .find_map(|event| match event {
            AgentEvent::ExecApplied { outcomes, .. } => Some(outcomes),
            _ => None,
        })
        .unwrap()
}

#[tokio::test]
async fn session_setup_order_is_model_then_mode_then_effort_before_prompt() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into()];
    let exec = options(Some("opencode-go/deepseek-v4.1-flash"), Some("high"), Some(SENTINEL));
    let (handle, mut events) = open_session(&adapter, args, exec.clone()).await;
    let result = adapter
        .prompt(
            &handle,
            PromptRequest {
                turn_id: "turn-1".into(),
                text: "hello".into(),
                exec_options: exec,
            },
        )
        .await;
    assert!(result.is_ok());
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() {
        seen.push(event);
    }
    let record = read_record(&temp.record());
    assert_eq!(
        rpc_trace(&record),
        vec![
            "initialize".to_owned(),
            "initialized".to_owned(),
            "session/new".to_owned(),
            "session/set_config_option model=opencode-go/deepseek-v4.1-flash".to_owned(),
            "session/set_config_option mode=bloblex".to_owned(),
            "session/set_config_option effort=high".to_owned(),
            "session/prompt".to_owned(),
        ]
    );
    assert!(record["isolated_dirs"].as_array().unwrap().is_empty());
    let outcomes = take_outcomes(&seen);
    assert_eq!(outcomes["model"].applied, Some(true));
    assert!(matches!(outcomes["model"].evidence_kind, EvidenceKind::ProviderEcho));
    assert_eq!(outcomes["model"].evidence_value.as_ref().and_then(|v| v.as_str()), Some("opencode-go/deepseek-v4.1-flash"));
    assert_eq!(outcomes["mode"].applied, Some(true));
    assert!(matches!(outcomes["mode"].evidence_kind, EvidenceKind::ProviderEcho));
    assert_eq!(outcomes["thinking"].applied, None);
    assert!(matches!(outcomes["thinking"].evidence_kind, EvidenceKind::ProviderEcho));
    assert_eq!(outcomes["thinking"].evidence_value.as_ref().and_then(|v| v.as_str()), Some("high"));
    assert_eq!(outcomes["instructions"].applied, Some(true));
    assert!(matches!(outcomes["instructions"].evidence_kind, EvidenceKind::SuccessfulTurn));
    assert_eq!(outcomes["instructions"].requested.as_ref(), Some(&serde_json::json!(true)));
    assert_no_secret(&events_text(&seen));
    assert_no_secret(&serde_json::to_string(&record).unwrap());
    assert_eq!(record["config"]["prompt_sha256"].as_str().unwrap(), sha256_hex(SENTINEL.as_bytes()));
    assert_eq!(record["config"]["agent_ids"][0], "bloblex");
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn mode_and_effort_are_not_selected_without_instructions_or_thinking() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into()];
    let exec = options(Some("opencode-go/deepseek-v4.1-flash"), None, None);
    let (handle, _) = open_session(&adapter, args, exec.clone()).await;
    adapter
        .prompt(
            &handle,
            PromptRequest {
                turn_id: "turn-model".into(),
                text: "hello".into(),
                exec_options: exec,
            },
        )
        .await
        .unwrap();
    let trace = rpc_trace(&read_record(&temp.record()));
    assert_eq!(
        trace,
        vec![
            "initialize".to_owned(),
            "initialized".to_owned(),
            "session/new".to_owned(),
            "session/set_config_option model=opencode-go/deepseek-v4.1-flash".to_owned(),
            "session/prompt".to_owned(),
        ]
    );
    assert!(trace.iter().all(|call| !call.contains("mode=") && !call.contains("effort=")));
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn clearing_instructions_restores_provider_default_mode_before_next_turn() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into()];
    let with_instructions = options(None, None, Some(SENTINEL));
    let (handle, _) = open_session(&adapter, args, with_instructions.clone()).await;

    adapter
        .prompt(
            &handle,
            PromptRequest {
                turn_id: "turn-with-instructions".into(),
                text: "first".into(),
                exec_options: with_instructions,
            },
        )
        .await
        .unwrap();
    adapter
        .prompt(
            &handle,
            PromptRequest {
                turn_id: "turn-without-instructions".into(),
                text: "second".into(),
                exec_options: options(None, None, None),
            },
        )
        .await
        .unwrap();

    assert_eq!(
        rpc_trace(&read_record(&temp.record())),
        vec![
            "initialize".to_owned(),
            "initialized".to_owned(),
            "session/new".to_owned(),
            "session/set_config_option mode=bloblex".to_owned(),
            "session/prompt".to_owned(),
            "session/set_config_option mode=build".to_owned(),
            "session/prompt".to_owned(),
        ]
    );
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn parent_config_is_replaced_and_allowlisted_env_is_kept() {
    let _parent = EnvSet::set(
        "OPENCODE_CONFIG_CONTENT",
        &format!(r#"{{"$schema":"https://parent.invalid","agent":{{"notbloblex":{{"prompt":"{PARENT_MARKER}"}}}}}}"#),
    );
    let _kept = EnvSet::set("BLOBLEX_PARENT_KEPT", "1");
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let mut exec = options(Some("opencode/big-pickle"), None, Some(SENTINEL));
    exec.env.insert("LANG".into(), "en_US.UTF-8".into());
    exec.env.insert("TZ".into(), "UTC".into());
    let args = vec!["--record".into(), temp.record().to_string_lossy().into()];
    let (handle, mut events) = open_session(&adapter, args, exec.clone()).await;
    adapter
        .prompt(
            &handle,
            PromptRequest {
                turn_id: "turn-env".into(),
                text: "hello".into(),
                exec_options: exec,
            },
        )
        .await
        .unwrap();
    let record = read_record(&temp.record());
    let text = serde_json::to_string(&record).unwrap();
    assert_no_secret(&text);
    assert_eq!(record["config"]["prompt_sha256"].as_str().unwrap(), sha256_hex(SENTINEL.as_bytes()));
    assert_eq!(record["config"]["agent_ids"].as_array().unwrap().len(), 1);
    assert_eq!(record["config"]["bloblex_mode"], "primary");
    assert_eq!(record["config"]["schema"], "https://opencode.ai/config.json");
    assert_eq!(record["allow"]["LANG"], "en_US.UTF-8");
    assert_eq!(record["allow"]["TZ"], "UTC");
    assert!(record["env_keys"].as_array().unwrap().iter().any(|key| key == "BLOBLEX_PARENT_KEPT"));
    assert!(record["env_keys"].as_array().unwrap().iter().any(|key| key == "OPENCODE_CONFIG_CONTENT"));
    assert_eq!(record["isolated_dirs"].as_array().unwrap().len(), 0);
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() {
        seen.push(event);
    }
    assert_no_secret(&events_text(&seen));
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn disallowed_env_does_not_spawn_or_echo_the_value() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let mut exec = ExecOptions::default();
    exec.env.insert("API_TOKEN".into(), "super-secret-value".into());
    let (tx, mut events) = mpsc::channel(8);
    let error = adapter
        .new_session(
            &runtime(vec!["--record".into(), temp.record().to_string_lossy().into()]),
            NewSessionRequest {
                session_id: "no-spawn".into(),
                project_path: std::env::temp_dir(),
                exec_options: exec,
            },
            tx,
        )
        .await
        .unwrap_err();
    let rendered = error.to_string();
    assert!(matches!(error, AdapterError::Unsupported(_)));
    assert!(!rendered.contains("super-secret-value"));
    assert!(!temp.record().exists());
    let event = events.try_recv().unwrap();
    let AgentEvent::ExecApplied { outcomes, .. } = event else { panic!("expected rejection") };
    assert_eq!(outcomes["env"].applied, Some(false));
    assert!(!format!("{outcomes:?}").contains("super-secret-value"));
}

#[tokio::test]
async fn missing_effort_and_service_tier_stop_before_prompt() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec![
        "--record".into(),
        temp.record().to_string_lossy().into(),
        "--models".into(),
        "opencode/big-pickle".into(),
        "--variant-models".into(),
        "".into(),
    ];
    let (handle, mut events) = open_session(&adapter, args, options(Some("opencode/big-pickle"), None, Some(SENTINEL))).await;
    let missing = adapter
        .prompt(
            &handle,
            PromptRequest {
                turn_id: "turn-missing".into(),
                text: "hello".into(),
                exec_options: options(Some("opencode/big-pickle"), Some("low"), Some(SENTINEL)),
            },
        )
        .await
        .unwrap_err();
    assert!(missing.to_string().contains("requested effort is not offered"));
    assert!(!missing.to_string().contains(SENTINEL));
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() {
        seen.push(event);
    }
    let outcomes = take_outcomes(&seen);
    assert_eq!(outcomes["thinking"].applied, Some(false));
    let trace = rpc_trace(&read_record(&temp.record()));
    assert!(trace.iter().all(|call| call != "session/prompt"));
    assert!(trace.iter().all(|call| !call.contains("effort=")));
    assert_no_secret(&events_text(&seen));

    let tier = adapter
        .prompt(
            &handle,
            PromptRequest {
                turn_id: "turn-tier".into(),
                text: "hello".into(),
                exec_options: ExecOptions {
                    service_tier: Some("priority".into()),
                    ..ExecOptions::default()
                },
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(tier, AdapterError::Unsupported(_)));
    assert!(tier.to_string().contains("service tier is not supported"));
    let mut later = Vec::new();
    while let Ok(event) = events.try_recv() {
        later.push(event);
    }
    let tier_outcome = later.iter().find_map(|event| match event {
        AgentEvent::ExecApplied { outcomes, .. } if outcomes.contains_key("serviceTier") => Some(outcomes),
        _ => None,
    }).unwrap();
    assert_eq!(tier_outcome["serviceTier"].applied, Some(false));
    assert!(rpc_trace(&read_record(&temp.record())).iter().all(|call| call != "session/prompt"));
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn changed_instructions_do_not_reach_the_prompt() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into()];
    let (handle, _) = open_session(&adapter, args, options(None, None, Some(SENTINEL))).await;
    let error = adapter
        .prompt(
            &handle,
            PromptRequest {
                turn_id: "turn-changed".into(),
                text: "hello".into(),
                exec_options: options(None, None, Some("OTHER_INSTRUCTION_SHOULD_NOT_APPLY")),
            },
        )
        .await
        .unwrap_err();
    let rendered = error.to_string();
    assert!(rendered.contains("instructions are fixed"));
    assert!(!rendered.contains(SENTINEL));
    assert!(!rendered.contains("OTHER_INSTRUCTION_SHOULD_NOT_APPLY"));
    assert!(rpc_trace(&read_record(&temp.record())).iter().all(|call| call != "session/prompt"));
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn resume_uses_session_load_then_the_same_option_order() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into()];
    let exec = options(Some("opencode-go/deepseek-v4.1-flash"), Some("max"), Some(SENTINEL));
    let (tx, _rx) = mpsc::channel(8);
    let handle = adapter
        .resume_session(
            &runtime(args),
            ResumeSessionRequest {
                session_id: "resumed".into(),
                provider_session_id: "native-session".into(),
                project_path: std::env::temp_dir(),
                exec_options: exec.clone(),
            },
            tx,
        )
        .await
        .unwrap();
    adapter
        .prompt(
            &handle,
            PromptRequest {
                turn_id: "turn-resume".into(),
                text: "hello".into(),
                exec_options: exec,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        rpc_trace(&read_record(&temp.record())),
        vec![
            "initialize".to_owned(),
            "initialized".to_owned(),
            "session/load".to_owned(),
            "session/set_config_option model=opencode-go/deepseek-v4.1-flash".to_owned(),
            "session/set_config_option mode=bloblex".to_owned(),
            "session/set_config_option effort=max".to_owned(),
            "session/prompt".to_owned(),
        ]
    );
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn usage_maps_first_turn_later_turn_partial_unreported_and_failed_zeros() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into(), "--usage".into(), "sequence".into()];
    let (handle, mut events) = open_session(&adapter, args, ExecOptions::default()).await;
    adapter
        .prompt(&handle, PromptRequest { turn_id: "t1".into(), text: "one".into(), exec_options: ExecOptions::default() })
        .await
        .unwrap();
    adapter
        .prompt(&handle, PromptRequest { turn_id: "t2".into(), text: "two".into(), exec_options: ExecOptions::default() })
        .await
        .unwrap();
    let mut reports = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let AgentEvent::UsageReport { turn_id, report } = event {
            reports.push((turn_id, report));
        }
    }
    assert_eq!(reports.len(), 2);
    assert_eq!(reports[0].0, "t1");
    assert_eq!(reports[0].1.usage_status, "reported");
    assert_eq!(reports[0].1.input_tokens, Some(120));
    assert_eq!(reports[0].1.output_tokens, Some(30));
    assert_eq!(reports[0].1.reasoning_tokens, Some(23));
    assert_eq!(reports[0].1.cache_read_tokens, None);
    assert_eq!(reports[0].1.cache_write_tokens, None);
    assert_eq!(reports[0].1.context_used, Some(4000));
    assert_eq!(reports[0].1.context_size, Some(200000));
    assert_eq!(reports[0].1.reported_cost_decimal.as_deref(), Some("0.0015894"));
    assert_eq!(reports[0].1.cost_currency.as_deref(), Some("USD"));
    assert!(reports[0].1.cost_is_cumulative);
    assert_eq!(reports[0].1.cost_minor, None);
    assert_eq!(reports[0].1.provider_update_id.as_deref(), Some("1"));
    assert_eq!(reports[1].1.input_tokens, Some(30));
    assert_eq!(reports[1].1.cache_read_tokens, Some(90));
    assert_ne!(reports[1].1.input_tokens, Some(120));
    assert_eq!(reports[1].1.reported_cost_decimal.as_deref(), Some("0.001637988"));
    assert!(reports[1].1.cost_is_cumulative);
    assert_eq!(reports[1].1.provider_update_id.as_deref(), Some("2"));
    adapter.close_session(&handle).await.unwrap();

    for (mode, status, cost) in [("partial", "partial", Some("0.0015894")), ("none", "unreported", None), ("failed", "unreported", None)] {
        let temp = Temp::new();
        let adapter = AcpAdapter::default();
        let args = vec!["--record".into(), temp.record().to_string_lossy().into(), "--usage".into(), mode.into()];
        let (handle, mut events) = open_session(&adapter, args, ExecOptions::default()).await;
        adapter
            .prompt(&handle, PromptRequest { turn_id: mode.into(), text: "x".into(), exec_options: ExecOptions::default() })
            .await
            .unwrap();
        let mut report = None;
        while let Ok(event) = events.try_recv() {
            if let AgentEvent::UsageReport { report: found, .. } = event {
                report = Some(found);
            }
        }
        let report = report.unwrap();
        assert_eq!(report.usage_status, status, "{mode}");
        assert_eq!(report.reported_cost_decimal.as_deref(), cost, "{mode}");
        if mode != "partial" {
            assert_eq!(report.input_tokens, None, "{mode}");
            assert_eq!(report.output_tokens, None, "{mode}");
            assert_eq!(report.cache_read_tokens, None, "{mode}");
            assert!(!report.cost_is_cumulative, "{mode}");
        } else {
            assert_eq!(report.input_tokens, None);
            assert_eq!(report.context_used, Some(4000));
            assert!(report.cost_is_cumulative);
        }
        adapter.close_session(&handle).await.unwrap();
    }
}

#[tokio::test]
async fn cancelled_turn_does_not_treat_echo_or_zero_usage_as_applied() {
    let temp = Temp::new();
    let adapter = std::sync::Arc::new(AcpAdapter::default());
    let args = vec!["--record".into(), temp.record().to_string_lossy().into(), "--usage".into(), "cancel".into()];
    let exec = options(Some("opencode/big-pickle"), None, None);
    let (handle, mut events) = open_session(&adapter, args, exec.clone()).await;
    let adapter2 = std::sync::Arc::clone(&adapter);
    let handle2 = handle.clone();
    let exec2 = exec.clone();
    let prompt = tokio::spawn(async move {
        adapter2
            .prompt(
                &handle2,
                PromptRequest {
                    turn_id: "turn-cancel".into(),
                    text: "wait".into(),
                    exec_options: exec2,
                },
            )
            .await
    });
    let record = temp.record();
    let started = Instant::now();
    loop {
        assert!(started.elapsed() < Duration::from_secs(5), "prompt was not sent");
        let ready = std::fs::read(&record)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|value| rpc_trace(&value).iter().any(|call| call == "session/prompt"));
        if ready {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    adapter.cancel(&handle).await.unwrap();
    prompt.await.unwrap().unwrap();
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() {
        seen.push(event);
    }
    assert!(seen.iter().any(|event| matches!(event, AgentEvent::TurnCancelled)));
    let outcomes = take_outcomes(&seen);
    assert_eq!(outcomes["model"].applied, None);
    assert!(matches!(outcomes["model"].evidence_kind, EvidenceKind::ProviderEcho));
    let report = take_report(&seen);
    assert_eq!(report.usage_status, "unreported");
    assert_eq!(report.input_tokens, None);
    assert_eq!(report.reported_cost_decimal, None);
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn prompt_rpc_error_is_unreported_and_hides_provider_text() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into(), "--usage".into(), "error".into()];
    let (handle, mut events) = open_session(&adapter, args, options(None, None, Some(SENTINEL))).await;
    let error = adapter
        .prompt(
            &handle,
            PromptRequest {
                turn_id: "turn-error".into(),
                text: SENTINEL.into(),
                exec_options: options(None, None, Some(SENTINEL)),
            },
        )
        .await
        .unwrap_err();
    assert!(!error.to_string().contains(SENTINEL));
    assert!(!error.to_string().contains("provider failed"));
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() {
        seen.push(event);
    }
    let report = take_report(&seen);
    assert_eq!(report.usage_status, "unreported");
    assert_eq!(report.input_tokens, None);
    assert_no_secret(&events_text(&seen));
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn verbose_catalog_includes_zen_and_go_models_with_per_model_efforts() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let runtime = runtime(vec!["--record".into(), temp.record().to_string_lossy().into()]);
    let catalog = adapter.model_catalog(&runtime).await.unwrap();
    assert_eq!(catalog.source, "cli_list");
    assert!(catalog.validated);
    assert!(!catalog.fallback);
    assert_eq!(catalog.models.len(), 3);
    assert_eq!(catalog.models[0].id, "opencode/big-pickle");
    assert!(catalog.models[0].variants.is_none());
    assert!(catalog.models[0].supported_thinking.is_empty());
    assert!(catalog.models.iter().all(|model| model.host_dependent && model.service_tiers.is_empty()));
    assert_eq!(catalog.models[1].id, "opencode-go/deepseek-v4.1-flash");
    assert_eq!(catalog.models[1].supported_thinking, ["high", "low", "max"]);
    let record = read_record(&temp.record());
    assert_eq!(record["config"]["ok"], false);
    let isolated: BTreeSet<_> = record["isolated_dirs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        isolated,
        BTreeSet::new()
    );
}

#[tokio::test]
async fn verbose_catalog_is_used_when_session_handshake_has_no_config_options() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let runtime = runtime(vec!["--record".into(), temp.record().to_string_lossy().into(), "--catalog-no-config-options".into()]);
    let catalog = adapter.model_catalog(&runtime).await.unwrap();
    assert_eq!(catalog.source, "cli_list");
    assert!(catalog.validated);
    assert!(!catalog.fallback);
    assert_eq!(catalog.models.len(), 3);
}

#[tokio::test]
async fn config_options_fallback_uses_an_empty_bloblex_working_directory() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let runtime = runtime(vec!["--record".into(), temp.record().to_string_lossy().into(), "--verbose-invalid".into()]);
    let catalog = adapter.model_catalog(&runtime).await.unwrap();
    assert_eq!(catalog.source, "config_options");
    assert!(!catalog.validated);
    let record = read_record(&temp.record());
    let cwd = record["cwd"].as_str().unwrap();
    assert!(cwd.contains("bloblex-opencode-catalog-cwd-"));
    assert_ne!(std::path::Path::new(cwd), std::env::current_dir().unwrap());
    assert_eq!(record["cwd_entries"], 0);
    assert_eq!(record["isolated_dirs"].as_array().unwrap().len(), 0);
    let session = record["rpc"].as_array().unwrap().iter().find(|request| request["method"] == "session/new").unwrap();
    assert_eq!(session["cwd"], cwd);
}

#[tokio::test]
async fn catalog_timeout_kills_the_child_and_failure_is_provider_unavailable() {
    let temp = Temp::new();
    let adapter = std::sync::Arc::new(AcpAdapter::with_catalog_timeout(Duration::from_millis(400)));
    let started = Instant::now();
    let hang_runtime = runtime(vec!["--record".into(), temp.record().to_string_lossy().into(), "--hang".into()]);
    let catalog = tokio::spawn({
        let adapter = adapter.clone();
        async move { adapter.model_catalog(&hang_runtime).await }
    });
    tokio::time::timeout(PROCESS_EXIT_TIMEOUT, async {
        while !temp.record().exists() { tokio::time::sleep(Duration::from_millis(20)).await; }
    }).await.unwrap();
    let pid = read_record(&temp.record())["pid"].as_u64().unwrap() as u32;
    let child = ProcessSignal::open(pid).expect("catalog fake child process handle");
    let error = catalog.await.unwrap().unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(8), "catalog hang was not killed");
    assert!(matches!(error, AdapterError::Process(_)));
    assert!(error.to_string().contains("timed out"));
    assert!(child.wait_signaled(PROCESS_EXIT_TIMEOUT).await, "catalog timeout must reap its original child");

    let failed = AcpAdapter::default()
        .model_catalog(&runtime(vec!["--fail".into()]))
        .await
        .unwrap_err();
    assert!(matches!(failed, AdapterError::Process(_)));
    assert!(failed.to_string().contains("unavailable"));
}
