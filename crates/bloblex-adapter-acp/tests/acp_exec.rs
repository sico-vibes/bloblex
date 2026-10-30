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

fn catalog_model<'a>(
    catalog: &'a bloblex_agent_core::ModelCatalog,
    id: &str,
) -> &'a bloblex_agent_core::ModelInfo {
    catalog
        .models
        .iter()
        .find(|model| model.id == id)
        .unwrap_or_else(|| panic!("catalog is missing {id}"))
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
            PromptRequest { attachments: Vec::new(),
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
            "session/set_config_option model=opencode-go/deepseek-v4.1-flash/high".to_owned(),
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
            PromptRequest { attachments: Vec::new(),
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
            PromptRequest { attachments: Vec::new(),
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
            PromptRequest { attachments: Vec::new(),
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
            PromptRequest { attachments: Vec::new(),
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
            PromptRequest { attachments: Vec::new(),
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
            PromptRequest { attachments: Vec::new(),
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
async fn effort_option_is_selected_by_thought_level_category_not_by_hard_coded_id() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec![
        "--record".into(),
        temp.record().to_string_lossy().into(),
        "--effort-id".into(),
        "think".into(),
    ];
    let exec = options(Some("opencode-go/deepseek-v4.1-flash"), Some("high"), None);
    let (handle, mut events) = open_session(&adapter, args, exec.clone()).await;
    adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-category".into(), text: "hello".into(), exec_options: exec })
        .await
        .unwrap();
    let trace = rpc_trace(&read_record(&temp.record()));
    assert!(
        trace.contains(&"session/set_config_option model=opencode-go/deepseek-v4.1-flash/high".to_owned()),
        "effort found by category is sent with the model as one value: {trace:?}",
    );
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() { seen.push(event); }
    let outcomes = take_outcomes(&seen);
    assert_eq!(outcomes["thinking"].evidence_value.as_ref().and_then(|value| value.as_str()), Some("high"));
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn rejected_effort_value_is_a_typed_error_and_never_reaches_the_prompt() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec![
        "--record".into(),
        temp.record().to_string_lossy().into(),
        "--reject-effort".into(),
        "high".into(),
    ];
    let (handle, mut events) = open_session(&adapter, args, options(Some("opencode-go/deepseek-v4.1-flash"), None, None)).await;
    let error = adapter
        .prompt(
            &handle,
            PromptRequest { attachments: Vec::new(),
                turn_id: "turn-reject".into(),
                text: "hello".into(),
                exec_options: options(Some("opencode-go/deepseek-v4.1-flash"), Some("high"), None),
            },
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("OpenCode rejected the effort setting"), "{error}");
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() { seen.push(event); }
    let outcomes = take_outcomes(&seen);
    assert_eq!(outcomes["thinking"].applied, Some(false));
    let trace = rpc_trace(&read_record(&temp.record()));
    assert!(trace.iter().all(|call| call != "session/prompt"), "a rejected effort stops before the prompt");
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn effort_is_set_again_when_opencode_echoes_a_stale_default_once() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into(), "--stale-effort".into(), "1".into()];
    let exec = options(Some("opencode-go/deepseek-v4.1-flash"), Some("high"), Some(SENTINEL));
    let (handle, mut events) = open_session(&adapter, args, exec.clone()).await;
    adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-stale".into(), text: "hello".into(), exec_options: exec })
        .await
        .expect("the second try echoes high");
    let trace = rpc_trace(&read_record(&temp.record()));
    let combined = "session/set_config_option model=opencode-go/deepseek-v4.1-flash/high".to_owned();
    assert_eq!(trace.iter().filter(|call| **call == combined).count(), 2, "{trace:?}");
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() { seen.push(event); }
    let outcomes = take_outcomes(&seen);
    assert_eq!(outcomes["thinking"].evidence_value.as_ref().and_then(|value| value.as_str()), Some("high"));
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn effort_that_never_sticks_fails_with_both_values_in_the_reason() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into(), "--stale-effort".into(), "99".into()];
    let exec = options(Some("opencode-go/deepseek-v4.1-flash"), Some("high"), None);
    let (handle, mut events) = open_session(&adapter, args, options(Some("opencode-go/deepseek-v4.1-flash"), None, None)).await;
    let error = adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-never".into(), text: "hello".into(), exec_options: exec })
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("OpenCode rejected the effort setting"), "{error}");
    assert!(error.contains("\"default\"") && error.contains("high"), "{error}");
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() { seen.push(event); }
    let reason = take_outcomes(&seen)["thinking"].reason.clone().unwrap_or_default();
    assert!(reason.contains("\"default\"") && reason.contains("high"), "{reason}");
    let trace = rpc_trace(&read_record(&temp.record()));
    assert_eq!(trace.iter().filter(|call| call.ends_with("/high")).count(), 3, "three tries in all: {trace:?}");
    assert!(trace.iter().all(|call| call != "session/prompt"));
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn effort_rpc_error_message_reaches_the_failure_reason() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into(), "--reject-effort".into(), "high".into()];
    let exec = options(Some("opencode-go/deepseek-v4.1-flash"), Some("high"), None);
    let (handle, mut events) = open_session(&adapter, args, options(Some("opencode-go/deepseek-v4.1-flash"), None, None)).await;
    let error = adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-rpc".into(), text: "hello".into(), exec_options: exec })
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("option value is not offered"), "{error}");
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() { seen.push(event); }
    let reason = take_outcomes(&seen)["thinking"].reason.clone().unwrap_or_default();
    assert!(reason.contains("option value is not offered"), "{reason}");
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn default_effort_keeps_the_plain_effort_call() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into()];
    let exec = options(Some("opencode-go/deepseek-v4.1-flash"), Some("default"), None);
    let (handle, _events) = open_session(&adapter, args, exec.clone()).await;
    adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-default".into(), text: "hello".into(), exec_options: exec })
        .await
        .unwrap();
    let trace = rpc_trace(&read_record(&temp.record()));
    assert!(trace.contains(&"session/set_config_option effort=default".to_owned()), "{trace:?}");
    assert!(trace.iter().all(|call| !call.ends_with("/default")), "{trace:?}");
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn changed_instructions_reestablish_the_session_without_failing() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into()];
    let changed = "INSTRUCTION_APPLIED_ON_THE_NEW_PROCESS";
    let (handle, mut events) = open_session(&adapter, args, options(None, None, Some(SENTINEL))).await;

    adapter
        .prompt(
            &handle,
            PromptRequest { attachments: Vec::new(),
                turn_id: "turn-one".into(),
                text: "first".into(),
                exec_options: options(None, None, Some(SENTINEL)),
            },
        )
        .await
        .unwrap();
    let first_pid = read_record(&temp.record())["pid"].clone();

    // The second turn changes the blob's instructions. OpenCode only reads
    // `OPENCODE_CONFIG_CONTENT` at process start, so the adapter re-establishes
    // the session on a process started with the new text instead of failing.
    adapter
        .prompt(
            &handle,
            PromptRequest { attachments: Vec::new(),
                turn_id: "turn-two".into(),
                text: "second".into(),
                exec_options: options(None, None, Some(changed)),
            },
        )
        .await
        .unwrap();

    let record = read_record(&temp.record());
    assert_ne!(record["pid"], first_pid, "the changed configuration is a new process");
    assert_eq!(
        record["config"]["prompt_sha256"].as_str().unwrap(),
        sha256_hex(changed.as_bytes()),
        "the new process was started with the new instruction text"
    );
    assert_eq!(
        rpc_trace(&record),
        vec![
            "initialize".to_owned(),
            "initialized".to_owned(),
            "session/load".to_owned(),
            "session/set_config_option mode=bloblex".to_owned(),
            "session/prompt".to_owned(),
        ],
        "the new process continues the existing provider session"
    );
    let load = record["rpc"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["method"] == "session/load")
        .expect("the new process received session/load");
    assert_eq!(load["sessionId"], "native-session", "session/load carries the existing provider id");
    assert!(!serde_json::to_string(&record).unwrap().contains(changed), "instruction text is never recorded verbatim");

    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() { seen.push(event); }
    let outcomes = take_outcomes(&seen);
    assert_eq!(outcomes["instructions"].applied, Some(true), "the applied turn proves the instruction change");
    assert!(matches!(outcomes["instructions"].evidence_kind, EvidenceKind::SuccessfulTurn));
    assert_no_secret(&events_text(&seen));
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn unchanged_instructions_do_not_reestablish_the_session() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into()];
    let exec = options(None, None, Some(SENTINEL));
    let (handle, _) = open_session(&adapter, args, exec.clone()).await;
    for turn in ["turn-stable-1", "turn-stable-2"] {
        adapter
            .prompt(
                &handle,
                PromptRequest { attachments: Vec::new(),
                    turn_id: turn.into(),
                    text: "hello".into(),
                    exec_options: exec.clone(),
                },
            )
            .await
            .unwrap();
    }
    let trace = rpc_trace(&read_record(&temp.record()));
    assert!(trace.iter().all(|call| call != "session/load"), "stable text never respawns: {trace:?}");
    assert_eq!(trace.iter().filter(|call| *call == "initialize").count(), 1, "no new process: {trace:?}");
    assert_eq!(trace.iter().filter(|call| *call == "session/new").count(), 1, "the same provider session: {trace:?}");
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn changed_env_reestablishes_the_session() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into()];
    let mut first = ExecOptions::default();
    first.env.insert("LANG".into(), "fixture-a".into());
    let (handle, _) = open_session(&adapter, args, first.clone()).await;
    adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-env-1".into(), text: "one".into(), exec_options: first })
        .await
        .unwrap();

    let mut second = ExecOptions::default();
    second.env.insert("LANG".into(), "fixture-b".into());
    adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-env-2".into(), text: "two".into(), exec_options: second })
        .await
        .unwrap();

    let record = read_record(&temp.record());
    assert_eq!(record["allow"]["LANG"], "fixture-b", "the new process carries the new environment");
    assert!(rpc_trace(&record).contains(&"session/load".to_owned()), "an env change re-establishes the session");
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn rejected_load_falls_back_to_a_new_session_and_reports_the_reset() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into(), "--reject-load".into()];
    let (handle, mut events) = open_session(&adapter, args, options(None, None, Some(SENTINEL))).await;
    adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-1".into(), text: "one".into(), exec_options: options(None, None, Some(SENTINEL)) })
        .await
        .unwrap();
    adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-2".into(), text: "two".into(), exec_options: options(None, None, Some("CHANGED_AFTER_LOAD_REJECT")) })
        .await
        .unwrap();

    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() { seen.push(event); }
    assert!(
        seen.iter().any(|event| matches!(event, AgentEvent::SessionStarted { .. })),
        "a provider that cannot resume reports the context reset the crash path reports"
    );
    let trace = rpc_trace(&read_record(&temp.record()));
    assert!(trace.contains(&"session/load".to_owned()));
    assert!(trace.contains(&"session/new".to_owned()), "the rejected load falls back to a fresh session: {trace:?}");
    assert!(trace.contains(&"session/prompt".to_owned()), "the turn still runs: {trace:?}");
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn failed_reconnect_keeps_the_old_connection_usable() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec![
        "--record".into(),
        temp.record().to_string_lossy().into(),
        "--fail-load".into(),
        "provider exploded".into(),
    ];
    let (handle, _) = open_session(&adapter, args, options(None, None, Some(SENTINEL))).await;
    adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-1".into(), text: "one".into(), exec_options: options(None, None, Some(SENTINEL)) })
        .await
        .unwrap();

    let error = adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-2".into(), text: "two".into(), exec_options: options(None, None, Some("CHANGED_BUT_RECONNECT_FAILS")) })
        .await
        .unwrap_err();
    let rendered = error.to_string();
    assert!(rendered.contains("provider exploded"), "the provider error is surfaced: {rendered}");
    assert!(!rendered.contains("instructions are fixed"), "the fixed-instructions error is not the normal path: {rendered}");
    assert!(!rendered.contains(SENTINEL));

    // The old connection was never disturbed: its original instructions still
    // run on its original process.
    adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-3".into(), text: "three".into(), exec_options: options(None, None, Some(SENTINEL)) })
        .await
        .unwrap();
    let record = read_record(&temp.record());
    assert_eq!(record["config"]["prompt_sha256"].as_str().unwrap(), sha256_hex(SENTINEL.as_bytes()));
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
            PromptRequest { attachments: Vec::new(),
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
            "session/set_config_option model=opencode-go/deepseek-v4.1-flash/max".to_owned(),
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
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "t1".into(), text: "one".into(), exec_options: ExecOptions::default() })
        .await
        .unwrap();
    adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "t2".into(), text: "two".into(), exec_options: ExecOptions::default() })
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
            .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: mode.into(), text: "x".into(), exec_options: ExecOptions::default() })
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
                PromptRequest { attachments: Vec::new(),
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
            PromptRequest { attachments: Vec::new(),
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
    assert_eq!(catalog.models[1].supported_thinking, ["low", "high", "max"], "levels are ordered low to high");
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
    assert!(catalog.validated, "every model answered the walk even from the fallback");
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
async fn opencode2_session_and_catalog_spawn_without_the_removed_cwd_flag() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let session_record = temp.dir.join("session.json");
    let exec = options(Some("opencode-go/model-007"), Some("high"), None);
    let args = vec!["--record".into(), session_record.to_string_lossy().into_owned(), "--v2".into()];
    let (handle, mut events) = open_session(&adapter, args, exec.clone()).await;
    adapter
        .prompt(
            &handle,
            PromptRequest { attachments: Vec::new(), turn_id: "turn-v2".into(), text: "hello".into(), exec_options: exec },
        )
        .await
        .unwrap();
    let mut completed = false;
    while !completed {
        match tokio::time::timeout(Duration::from_secs(10), events.recv()).await.unwrap() {
            Some(AgentEvent::TurnCompleted) => completed = true,
            Some(AgentEvent::Error { .. }) => panic!("v2-shaped session failed"),
            Some(_) => {}
            None => panic!("v2-shaped session closed early"),
        }
    }
    adapter.close_session(&handle).await.unwrap();
    let session_argv = read_record(&session_record)["argv"].clone();
    let session_argv = session_argv.as_array().unwrap();
    assert!(session_argv.iter().any(|arg| arg == "acp"), "the real session still launches acp: {session_argv:?}");
    assert!(!session_argv.iter().any(|arg| arg == "--cwd"), "the removed flag must not be sent: {session_argv:?}");

    let catalog_record = temp.dir.join("catalog.json");
    let catalog_args = vec![
        "--record".into(),
        catalog_record.to_string_lossy().into_owned(),
        "--v2".into(),
        "--verbose-invalid".into(),
    ];
    let catalog = adapter.model_catalog(&runtime(catalog_args)).await.unwrap();
    assert_eq!(catalog.source, "config_options");
    let catalog_argv = read_record(&catalog_record)["argv"].clone();
    let catalog_argv = catalog_argv.as_array().unwrap();
    assert!(catalog_argv.iter().any(|arg| arg == "acp"));
    assert!(!catalog_argv.iter().any(|arg| arg == "--cwd"), "the catalog must not send the removed flag: {catalog_argv:?}");
}

#[tokio::test]
async fn opencode2_config_options_catalog_walks_every_model_for_its_own_efforts() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec![
        "--record".into(),
        temp.record().to_string_lossy().into(),
        "--v2".into(),
        "--verbose-invalid".into(),
    ];
    let catalog = adapter.model_catalog(&runtime(args)).await.unwrap();
    assert_eq!(catalog.source, "config_options");
    assert!(!catalog.fallback);
    assert_eq!(catalog.models.len(), 115, "the v2 session lists the whole gateway");
    // The walk selects every model, so each row carries that model's own answer.
    assert_eq!(catalog_model(&catalog, "opencode-go/model-001").supported_thinking, ["low", "medium", "high"], "levels are ordered low to high");
    assert_eq!(catalog_model(&catalog, "opencode-go/model-002").supported_thinking, ["low", "high", "max"]);
    assert!(catalog_model(&catalog, "opencode-go/model-003").supported_thinking.is_empty(), "a model with no effort option has none");
    assert_eq!(catalog_model(&catalog, "opencode-go/model-005").supported_thinking, ["none", "minimal", "thinking"], "unknown names stay after known ones");
    assert!(catalog_model(&catalog, "opencode-go/model-004").supported_thinking.is_empty(), "the rejected model keeps no levels");
    assert!(
        catalog.models.iter().all(|model| !model.supported_thinking.iter().any(|level| level == "default")),
        "`default` is synthetic, not a level",
    );
    let flagged = catalog.models.iter().filter(|model| model.is_default == Some(true)).collect::<Vec<_>>();
    assert_eq!(flagged.len(), 1, "exactly the session's current model is flagged");
    assert_eq!(flagged[0].id, "opencode-go/model-007");
    assert!(!catalog.validated, "one model was rejected, so the walk is not complete");
    let argv = read_record(&temp.record())["argv"].clone();
    assert!(!argv.as_array().unwrap().iter().any(|arg| arg == "--cwd"));
}

#[tokio::test]
async fn opencode2_config_options_catalog_is_validated_when_every_model_answers() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec![
        "--record".into(),
        temp.record().to_string_lossy().into(),
        "--v2".into(),
        "--v2-all-answer".into(),
        "--verbose-invalid".into(),
    ];
    let catalog = adapter.model_catalog(&runtime(args)).await.unwrap();
    assert_eq!(catalog.source, "config_options");
    assert!(catalog.validated, "every model answered, so the provider's own lists are authoritative");
    assert_eq!(catalog_model(&catalog, "opencode-go/model-004").supported_thinking, ["max"], "the previously rejected model now answers");
    assert!(catalog_model(&catalog, "opencode-go/model-003").supported_thinking.is_empty(), "a model with no effort option still answers");
    assert!(
        catalog.models.iter().filter(|model| model.id != "opencode-go/model-003").all(|model| !model.supported_thinking.is_empty()),
        "every other model reports its levels",
    );
}

#[tokio::test]
async fn opencode2_config_options_catalog_budget_keeps_partial_results_and_reaps_the_child() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec![
        "--record".into(),
        temp.record().to_string_lossy().into(),
        "--v2".into(),
        "--v2-stop-after".into(),
        "3".into(),
        "--verbose-invalid".into(),
    ];
    let started = Instant::now();
    let catalog = adapter.model_catalog(&runtime(args)).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(8), "a model that stops answering must not outlive the per-call budget");
    assert_eq!(catalog.source, "config_options");
    assert!(!catalog.validated, "a budget cut leaves the walk incomplete");
    assert_eq!(catalog.models.len(), 115, "the partial catalog still lists every model");
    assert_eq!(catalog_model(&catalog, "opencode-go/model-001").supported_thinking, ["low", "medium", "high"]);
    assert_eq!(catalog_model(&catalog, "opencode-go/model-002").supported_thinking, ["low", "high", "max"]);
    assert!(catalog_model(&catalog, "opencode-go/model-004").supported_thinking.is_empty(), "models after the cut keep no levels");
    let pid = read_record(&temp.record())["pid"].as_u64().unwrap() as u32;
    if let Some(child) = ProcessSignal::open(pid) {
        assert!(child.wait_signaled(PROCESS_EXIT_TIMEOUT).await, "the catalog probe child must not linger");
    }
}

#[tokio::test]
async fn opencode2_session_selects_the_model_before_its_effort() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into(), "--v2".into()];
    let exec = options(Some("opencode-go/model-002"), Some("high"), None);
    let (handle, _) = open_session(&adapter, args, exec.clone()).await;
    adapter
        .prompt(
            &handle,
            PromptRequest { attachments: Vec::new(), turn_id: "turn-order".into(), text: "hello".into(), exec_options: exec },
        )
        .await
        .unwrap();
    let trace = rpc_trace(&read_record(&temp.record()));
    let model_at = trace.iter().position(|call| call == "session/set_config_option model=opencode-go/model-002").expect("the model is selected");
    let effort_at = trace.iter().position(|call| call == "session/set_config_option model=opencode-go/model-002/high").expect("the effort is selected");
    assert!(model_at < effort_at, "effort options depend on the model, so the model goes first: {trace:?}");
    adapter.close_session(&handle).await.unwrap();
}

#[tokio::test]
async fn failing_verbose_listing_falls_through_quickly_without_lingering_children() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let pid_log = temp.dir.join("pids.log");
    let args = vec![
        "--record".into(),
        temp.record().to_string_lossy().into(),
        "--verbose-invalid".into(),
        "--pid-log".into(),
        pid_log.to_string_lossy().into(),
    ];
    let started = Instant::now();
    let catalog = adapter.model_catalog(&runtime(args)).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(5), "a failed verbose listing must not hold up the config-options fallback");
    assert_eq!(catalog.source, "config_options");
    let log = std::fs::read_to_string(&pid_log).unwrap();
    let pids = log
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            Some((parts.next()?.parse::<u32>().ok()?, parts.next()?.to_owned()))
        })
        .collect::<Vec<_>>();
    assert!(pids.iter().any(|(_, role)| role == "verbose"), "the verbose listing ran: {log}");
    for (pid, role) in pids {
        // A process that already exited cannot be opened at all; if it is still
        // openable, it must terminate promptly rather than linger.
        if let Some(child) = ProcessSignal::open(pid) {
            assert!(child.wait_signaled(PROCESS_EXIT_TIMEOUT).await, "{role} child {pid} must not linger");
        }
    }
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

#[tokio::test]
async fn fake_peer_acknowledges_the_first_update_per_prompt_and_never_a_rejected_prompt() {
    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into(), "--usage".into(), "sequence".into()];
    let (handle, mut events) = open_session(&adapter, args, ExecOptions::default()).await;
    for turn in ["ack-1", "ack-2"] {
        adapter
            .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: turn.into(), text: "hello".into(), exec_options: ExecOptions::default() })
            .await
            .unwrap();
        let accepted = tokio::time::timeout(Duration::from_secs(10), async {
            let mut accepted = 0;
            loop {
                match events.recv().await.unwrap() {
                    AgentEvent::PromptAccepted => accepted += 1,
                    AgentEvent::TurnCompleted => break accepted,
                    _ => {}
                }
            }
        }).await.unwrap();
        assert_eq!(accepted, 1, "one acceptance per prompt");
    }
    adapter.close_session(&handle).await.unwrap();

    let temp = Temp::new();
    let adapter = AcpAdapter::default();
    let args = vec!["--record".into(), temp.record().to_string_lossy().into(), "--usage".into(), "error".into()];
    let (handle, mut events) = open_session(&adapter, args, ExecOptions::default()).await;
    let result = adapter
        .prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "rejected".into(), text: "hello".into(), exec_options: ExecOptions::default() })
        .await;
    assert!(result.is_err());
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(event, AgentEvent::PromptAccepted), "a rejected prompt is never acknowledged");
    }
    adapter.close_session(&handle).await.unwrap();
}
