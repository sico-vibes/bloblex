//! Claude Code's documented print/stream-json mode, never interactive TUI scraping.
use async_trait::async_trait;
use bloblex_agent_core::*;
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    time::{Duration as StdDuration, SystemTime},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};
use uuid::Uuid;

#[derive(Debug,Clone)]
struct PrivateInstructionFile { path:PathBuf, lock_path:PathBuf }
fn private_tmp_dir(override_dir:Option<&std::path::Path>)->PathBuf {
    override_dir.map(PathBuf::from).or_else(||std::env::var_os("BLOBLEX_PRIVATE_TMP").map(PathBuf::from)).or_else(||std::env::var_os("LOCALAPPDATA").map(PathBuf::from).map(|p|p.join("Bloblex").join("private-tmp"))).unwrap_or_else(||std::env::temp_dir().join("Bloblex").join("private-tmp"))
}
fn icacls(path:&std::path::Path,directory:bool,system_root_override:Option<&std::path::Path>)->std::io::Result<()> {
    #[cfg(windows)] {
        let root=system_root_override.map(PathBuf::from).or_else(||std::env::var_os("SystemRoot").map(PathBuf::from)).ok_or_else(||std::io::Error::new(std::io::ErrorKind::PermissionDenied,"SystemRoot is unavailable"))?;
        let user=match(std::env::var("USERDOMAIN"),std::env::var("USERNAME")){(Ok(d),Ok(u))if !d.is_empty()&&!u.is_empty()=>format!("{d}\\{u}"),_=>return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied,"current Windows account is unavailable"))};
        let grant=if directory{format!("{user}:(OI)(CI)F")}else{format!("{user}:F")};
        let mut command=std::process::Command::new(root.join("System32").join("icacls.exe"));command.arg(path).arg("/inheritance:r").arg("/grant:r").arg(grant).stdout(Stdio::null()).stderr(Stdio::null());
        let status=command.status()?;if !status.success(){return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied,"icacls rejected the private path"))}
    }
    #[cfg(not(windows))] { let _=(path,directory,system_root_override); }
    Ok(())
}
fn remove_private_pair(pair:&PrivateInstructionFile){let _=std::fs::remove_file(&pair.path);let _=std::fs::remove_file(&pair.lock_path);}
fn process_is_live(pid:u32)->bool {
    #[cfg(windows)] unsafe {
        #[link(name="kernel32")] extern "system" { fn OpenProcess(access:u32,inherit:i32,pid:u32)->*mut std::ffi::c_void; fn CloseHandle(handle:*mut std::ffi::c_void)->i32; }
        let handle=OpenProcess(0x1000,0,pid);if handle.is_null(){false}else{let _=CloseHandle(handle);true}
    }
    #[cfg(not(windows))] { std::path::Path::new("/proc").join(pid.to_string()).exists() }
}
fn cleanup_private_instruction_files_at(base:&std::path::Path,now:SystemTime)->std::io::Result<()> {
    let entries=match std::fs::read_dir(base){Ok(v)=>v,Err(e)if e.kind()==std::io::ErrorKind::NotFound=>return Ok(()),Err(e)=>return Err(e)};
    for entry in entries.flatten(){let path=entry.path();if path.extension().and_then(|x|x.to_str())!=Some("txt")||!entry.file_name().to_string_lossy().starts_with("instruction-"){continue}
        let Some(stem)=path.file_stem()else{continue};let lock_path=path.with_file_name(format!("{}.lock",stem.to_string_lossy()));let pair=PrivateInstructionFile{path:path.clone(),lock_path:lock_path.clone()};
        let Ok(metadata)=std::fs::metadata(&path)else{continue};let old=metadata.modified().ok().and_then(|m|now.duration_since(m).ok()).is_some_and(|age|age>=StdDuration::from_secs(24*60*60));if !old{continue}
        let Ok(pid_text)=std::fs::read_to_string(&lock_path)else{continue};let Ok(pid)=pid_text.trim().parse::<u32>()else{continue};if !process_is_live(pid){remove_private_pair(&pair)}
    }
    Ok(())
}
fn write_private_instruction_file_at(base:&std::path::Path,text:&str,system_root_override:Option<&std::path::Path>)->std::io::Result<PrivateInstructionFile>{
    std::fs::create_dir_all(base)?;
    #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(base,std::fs::Permissions::from_mode(0o700))?;}
    icacls(base,true,system_root_override)?;cleanup_private_instruction_files_at(base,SystemTime::now())?;
    for _ in 0..8 {let path=base.join(format!("instruction-{}.txt",Uuid::new_v4()));let lock_path=path.with_extension("lock");let mut opts=std::fs::OpenOptions::new();opts.write(true).create_new(true);
        #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;opts.mode(0o600);}
        match opts.open(&path){Ok(mut file)=>{let pair=PrivateInstructionFile{path,lock_path};let result=(||{icacls(&pair.path,false,system_root_override)?;let mut lock=std::fs::OpenOptions::new().write(true).create_new(true).open(&pair.lock_path)?;icacls(&pair.lock_path,false,system_root_override)?;use std::io::Write;write!(lock,"{}",std::process::id())?;lock.flush()?;drop(lock);file.write_all(text.as_bytes())?;file.flush()?;drop(file);Ok(pair.clone())})();if result.is_err(){remove_private_pair(&pair)}return result},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>continue,Err(e)=>return Err(e)}
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists,"could not allocate a unique instruction file"))
}
fn write_private_instruction_file_at_dir(override_dir:Option<&std::path::Path>,text:&str,system_root_override:Option<&std::path::Path>)->std::io::Result<PrivateInstructionFile>{let base=private_tmp_dir(override_dir);write_private_instruction_file_at(&base,text,system_root_override)}

fn parse_model_catalog(value: &Value) -> Result<Vec<ModelInfo>, AdapterError> {
    let models = value["models"].as_array().ok_or_else(|| AdapterError::Protocol("Claude catalog has no models array".into()))?;
    let mut normalized = Vec::new();
    for model in models {
        let id = model["value"].as_str().or_else(|| model["id"].as_str()).ok_or_else(|| AdapterError::Protocol("Claude catalog model id is missing".into()))?;
        let levels = model["supportedEffortLevels"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
        normalized.push(ModelInfo {
            id: id.into(), display_name: model["displayName"].as_str().or_else(|| model["name"].as_str()).unwrap_or(id).into(),
            provider_id: model["providerId"].as_str().map(str::to_owned), supported_thinking: levels,
            default_thinking: model["defaultEffort"].as_str().map(str::to_owned), service_tiers: vec![],
            default_service_tier: None, variants: None, host_dependent: true,
        });
    }
    if normalized.is_empty() { return Err(AdapterError::Protocol("Claude catalog is empty".into())); }
    Ok(normalized)
}

fn fallback_catalog() -> Vec<ModelInfo> {
    ["sonnet", "opus", "fable", "haiku"].into_iter().map(|id| ModelInfo {
        id: id.into(), display_name: id.into(), provider_id: None, supported_thinking: vec![],
        default_thinking: None, service_tiers: vec![], default_service_tier: None, variants: None, host_dependent: true,
    }).collect()
}
fn typed_args(options: &ExecOptions, instruction_file: Option<&std::path::Path>, instruction_changed: bool) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(model) = options.model.as_deref() { args.extend(["--model".into(), model.into()]); }
    if let Some(effort) = options.thinking.as_deref() { args.extend(["--effort".into(), effort.into()]); }
    if let Some(path) = instruction_file { args.extend(["--append-system-prompt-file".into(), path.to_string_lossy().into_owned()]); }
    if instruction_changed { args.extend(["--system-prompt-snapshot".into(), "off".into()]); }
    args
}
fn exact_usd_minor(decimal: &str) -> Option<i64> {
    let value = decimal.strip_prefix('+').unwrap_or(decimal);
    if value.starts_with('-') { return None; }
    let mut parts=value.split('.'); let whole=parts.next()?.parse::<i64>().ok()?; let fraction=parts.next().unwrap_or("");
    if parts.next().is_some() || !fraction.bytes().all(|b|b.is_ascii_digit()) || fraction.len()>2 && fraction[2..].bytes().any(|b|b!=b'0') { return None; }
    let first=if fraction.len()>0 { (fraction.as_bytes()[0]-b'0') as i64 } else { 0 };
    let second=if fraction.len()>1 { (fraction.as_bytes()[1]-b'0') as i64 } else { 0 };
    whole.checked_mul(100)?.checked_add(first*10+second)
}

struct Conn {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    events: EventSender,
    provider_id: Mutex<Option<String>>,
    active_turn: AtomicBool,
    cancellation_requested: AtomicBool,
    permission_requests: Mutex<HashMap<String, (Value, Value)>>,
    local_session_id: String,
    instruction_file: Option<PrivateInstructionFile>,
    runtime: RuntimeSpec,
    cwd: PathBuf,
    launch_options: ExecOptions,
    desired_instruction_sha256: Option<String>,
    event_sender: EventSender,
    active_turn_id: Mutex<Option<String>>,
}
fn control_response(original_id: Value, input: Value, choice: &str) -> Result<Value, AdapterError> {
    let response = match choice {
        "allow" => json!({"behavior":"allow","updatedInput":input}),
        "deny" => json!({"behavior":"deny","message":"Denied in Bloblex"}),
        _ => {
            return Err(AdapterError::Unsupported(
                "Claude permission choice must be allow or deny".into(),
            ))
        }
    };
    Ok(
        json!({"type":"control_response","response":{"subtype":"success","request_id":original_id,"response":response}}),
    )
}
#[derive(Default)]
pub struct ClaudeAdapter {
    sessions: Mutex<HashMap<String, Arc<Conn>>>,
    instruction_hash_context: Mutex<HashMap<String,(Option<String>,Option<String>)>>,
    private_tmp_override: Option<PathBuf>,
    system_root_override: Option<PathBuf>,
}
async fn parse_line(
    tx: &EventSender,
    v: &Value,
    provider_id: &Mutex<Option<String>>,
    permission_requests: &Mutex<HashMap<String, (Value, Value)>>,
    local_session_id: &str,
    active_turn_id: &Mutex<Option<String>>,
) {
    let typ = v["type"].as_str().unwrap_or("");
    match typ {
        "system" => {
            if v["subtype"].as_str() == Some("init") {
                if let Some(id) = v["session_id"].as_str() {
                    *provider_id.lock().await = Some(id.into());
                    let _ = tx
                        .send(AgentEvent::SessionStarted {
                            provider_session_id: id.into(),
                        })
                        .await;
                }
            }
        }
        "stream_event" => {
            let e = &v["event"];
            if e["type"].as_str() == Some("content_block_delta") {
                if let Some(t) = e["delta"]["text"].as_str() {
                    let _ = tx.send(AgentEvent::AssistantDelta { text: t.into() }).await;
                }
            }
        }
        "assistant" => {
            if let Some(content) = v["message"]["content"].as_array() {
                for c in content {
                    match c["type"].as_str().unwrap_or("") {
                        "text" => {
                            if let Some(s) = c["text"].as_str() {
                                let _ = tx
                                    .send(AgentEvent::AssistantMessage { text: s.into() })
                                    .await;
                            }
                        }
                        "tool_use" => {
                            let _ = tx
                                .send(AgentEvent::ToolStarted {
                                    tool_call_id: c["id"].as_str().unwrap_or("claude-tool").into(),
                                    kind: c["name"].as_str().unwrap_or("tool").into(),
                                    title: c["name"].as_str().unwrap_or("Claude tool").into(),
                                    raw: c.clone(),
                                })
                                .await;
                        }
                        _ => {}
                    }
                }
            }
        }
        "user" => {
            if let Some(content) = v["message"]["content"].as_array() {
                for c in content {
                    if c["type"].as_str() == Some("tool_result") {
                        let _ = tx
                            .send(AgentEvent::ToolCompleted {
                                tool_call_id: c["tool_use_id"]
                                    .as_str()
                                    .unwrap_or("claude-tool")
                                    .into(),
                                raw: c.clone(),
                            })
                            .await;
                    }
                }
            }
        }
        "result" if v["is_error"].as_bool().unwrap_or(false) => {
            let turn_id = active_turn_id.lock().await.clone().unwrap_or_default();
            let _ = tx.send(AgentEvent::UsageReport { turn_id, report: UsageReport {
                input_tokens: None, output_tokens: None, cache_read_tokens: None, cache_write_tokens: None, reasoning_tokens: None,
                usage_status: "unreported".into(), evidence_note: None, provider_update_id: None, context_used: None, context_size: None,
                model: None, cost_minor: None, cost_currency: None, reported_cost_decimal: None,
            }}).await;
            let _ = tx
                .send(AgentEvent::Error {
                    message: v["result"]
                        .as_str()
                        .unwrap_or("Claude reported a turn error")
                        .to_owned(),
                })
                .await;
        }
        "result" => {
            let u = &v["usage"];
            if !v["is_error"].as_bool().unwrap_or(false) {
                let model = v["modelUsage"].as_object().and_then(|o| o.keys().next().cloned());
                let total_cost = v["total_cost_usd"].as_number().map(ToString::to_string);
                let cost_minor = total_cost.as_deref().and_then(exact_usd_minor);
            let turn_id = active_turn_id.lock().await.clone().unwrap_or_default();
            let _ = tx.send(AgentEvent::UsageReport { turn_id, report: UsageReport {
                    input_tokens: u["input_tokens"].as_u64(), output_tokens: u["output_tokens"].as_u64(),
                    cache_read_tokens: u["cache_read_input_tokens"].as_u64(), cache_write_tokens: u["cache_creation_input_tokens"].as_u64(),
                    reasoning_tokens: u["output_tokens_details"]["thinking_tokens"].as_u64(), usage_status: if u.is_object() { "reported" } else { "unreported" }.into(), evidence_note: None,
                    provider_update_id: None, context_used: None, context_size: None,
                    model, cost_minor, cost_currency: cost_minor.map(|_| "USD".into()),
                    reported_cost_decimal: total_cost,
                }}).await;
            } else {
                let _ = tx.send(AgentEvent::UsageReport { turn_id: String::new(), report: UsageReport {
                    input_tokens: None, output_tokens: None, cache_read_tokens: None, cache_write_tokens: None, reasoning_tokens: None,
                    usage_status: "unreported".into(), evidence_note: None, provider_update_id: None, context_used: None, context_size: None,
                    model: None, cost_minor: None, cost_currency: None, reported_cost_decimal: None,
                }}).await;
            }
            let _ = tx.send(AgentEvent::TurnCompleted).await;
        }
        "control_request" => {
            // Claude's stream-json request identifiers are JSON values, not
            // necessarily strings. Keep the original value for the response.
            if v["request"]["subtype"].as_str() != Some("can_use_tool") {
                return;
            }
            let original_id = v["request_id"].clone();
            let provider_request_id = original_id
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| original_id.to_string());
            let id = format!("{local_session_id}:{provider_request_id}");
            let tool_name = v["request"]["tool_name"]
                .as_str()
                .unwrap_or("tool")
                .to_owned();
            let input = v["request"]["input"].clone();
            permission_requests
                .lock()
                .await
                .insert(id.clone(), (original_id, input.clone()));
            let _ = tx
                .send(AgentEvent::PermissionRequested {
                    provider_request_id: id,
                    title: format!("Allow Claude to use {tool_name}?"),
                    detail: Some(input.to_string()),
                    choices: vec!["allow".into(), "deny".into()],
                    raw: v.clone(),
                })
                .await;
        }
        "control_cancel_request" => {
            let original_id = v["request_id"].clone();
            let provider_request_id = original_id
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| original_id.to_string());
            permission_requests
                .lock()
                .await
                .remove(&format!("{local_session_id}:{provider_request_id}"));
        }
        _ => {}
    }
}
impl ClaudeAdapter {
    pub fn with_private_tmp_dir(path:PathBuf)->Self{Self{sessions:Mutex::new(HashMap::new()),instruction_hash_context:Mutex::new(HashMap::new()),private_tmp_override:Some(path),system_root_override:None}}
    /// Test seam: use a fake `System32/icacls.exe` while keeping the same ACL arguments.
    pub fn with_test_acl_executable(path:PathBuf,system_root:PathBuf)->Self{Self{sessions:Mutex::new(HashMap::new()),instruction_hash_context:Mutex::new(HashMap::new()),private_tmp_override:Some(path),system_root_override:Some(system_root)}}
    fn create_instruction_file(&self,text:&str)->std::io::Result<PrivateInstructionFile>{write_private_instruction_file_at_dir(self.private_tmp_override.as_deref(),text,self.system_root_override.as_deref())}
    async fn start(
        &self,
        r: &RuntimeSpec,
        cwd: &PathBuf,
        provider_session_id: Option<&str>,
        events: EventSender,
        local_session_id: &str,
        options: &ExecOptions,
        instruction_changed: bool,
        desired_instruction_sha256: Option<String>,
    ) -> Result<Arc<Conn>, AdapterError> {
        let assigned_id = provider_session_id
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut c = Command::new(&r.executable);
        c.args(&r.args).args([
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--include-hook-events",
            "--permission-mode",
            "default",
            "--permission-prompt-tool",
            "stdio",
        ]);
        let instruction_file = if let Some(instructions) = options.instructions.as_deref().filter(|s| !s.is_empty()) {
            Some(self.create_instruction_file(instructions).map_err(|e| AdapterError::Process(format!("private instruction file unavailable: {e}")))?)
        } else { None };
        c.args(typed_args(options, instruction_file.as_ref().map(|f|f.path.as_path()), instruction_changed));
        if let Some(id) = provider_session_id {
            c.args(["--resume", id]);
        } else {
            c.args(["--session-id", assigned_id.as_str()]);
        }
        c.current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = match c.spawn() { Ok(child) => child, Err(e) => { if let Some(pair)=instruction_file.as_ref(){remove_private_pair(pair);} return Err(AdapterError::Process(e.to_string())); } };
        let Some(stdin)=child.stdin.take()else{let _=child.start_kill();if let Some(pair)=instruction_file.as_ref(){remove_private_pair(pair);}return Err(AdapterError::Process("Claude stdin unavailable".into()))};
        let Some(stdout)=child.stdout.take()else{let _=child.start_kill();if let Some(pair)=instruction_file.as_ref(){remove_private_pair(pair);}return Err(AdapterError::Process("Claude stdout unavailable".into()))};
        let conn = Arc::new(Conn {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            events: events.clone(),
            provider_id: Mutex::new(Some(assigned_id)),
            active_turn: AtomicBool::new(false),
            cancellation_requested: AtomicBool::new(false),
            permission_requests: Mutex::new(HashMap::new()),
            local_session_id: local_session_id.into(),
            instruction_file: instruction_file.clone(),
            runtime: r.clone(), cwd: cwd.clone(), launch_options: options.clone(),
            desired_instruction_sha256,
            event_sender: events.clone(),
            active_turn_id: Mutex::new(None),
        });
        let reader = conn.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        if v["type"].as_str() == Some("result") {
                            reader.active_turn.store(false, Ordering::SeqCst);
                            if !v["is_error"].as_bool().unwrap_or(false) {
                                let mut outcomes = std::collections::BTreeMap::new();
                                let usage = &v["usage"];
                                if let Some(requested) = reader.launch_options.model.as_deref() {
                                    let echoed = v["modelUsage"].as_object().is_some_and(|m| m.contains_key(requested));
                                    outcomes.insert("model".into(), SettingOutcome { requested: Some(json!(requested)), applied: Some(echoed), evidence_kind: EvidenceKind::ProviderEcho, evidence_value: echoed.then(|| json!(requested)), reason: None });
                                }
                                if let Some(requested) = reader.launch_options.thinking.as_deref() {
                                    let thinking = usage["output_tokens_details"]["thinking_tokens"].as_u64();
                                    outcomes.insert("thinking".into(), SettingOutcome { requested: Some(json!(requested)), applied: thinking.map(|_| true), evidence_kind: EvidenceKind::UsageEffect, evidence_value: thinking.map(|n| json!(n)), reason: None });
                                }
                                outcomes.insert("instructions".into(), SettingOutcome { requested: Some(json!(reader.desired_instruction_sha256)), applied: Some(true), evidence_kind: EvidenceKind::SuccessfulTurn, evidence_value: Some(json!(reader.desired_instruction_sha256)), reason: None });
                                if !outcomes.is_empty() { let turn_id=reader.active_turn_id.lock().await.clone().unwrap_or_default();let _=reader.events.send(AgentEvent::ExecApplied{turn_id,outcomes}).await; }
                            } else {
                                let mut outcomes = std::collections::BTreeMap::new();
                                for (key,requested) in [("model",reader.launch_options.model.as_ref().map(|v|json!(v))), ("thinking",reader.launch_options.thinking.as_ref().map(|v|json!(v))), ("serviceTier",reader.launch_options.service_tier.as_ref().map(|v|json!(v))), ("instructions",Some(json!(reader.desired_instruction_sha256)))] {
                                    if let Some(requested)=requested { outcomes.insert(key.into(),SettingOutcome{requested:Some(requested),applied:None,evidence_kind:EvidenceKind::None,evidence_value:None,reason:Some("failed_turn".into())}); }
                                }
                                if !outcomes.is_empty(){let turn_id=reader.active_turn_id.lock().await.clone().unwrap_or_default();let _=reader.events.send(AgentEvent::ExecApplied{turn_id,outcomes}).await;}
                            }
                        }
                    parse_line(
                        &reader.events,
                        &v,
                        &reader.provider_id,
                        &reader.permission_requests,
                        &reader.local_session_id,
                        &reader.active_turn_id,
                    )
                    .await;
                }
            }
            if let Some(pair) = reader.instruction_file.as_ref() { remove_private_pair(pair); }
            if reader.active_turn.swap(false, Ordering::SeqCst) {
                let event = if reader.cancellation_requested.swap(false, Ordering::SeqCst) {
                    AgentEvent::TurnCancelled
                } else {
                    AgentEvent::Error {
                        message: "Claude process exited before completing the turn".into(),
                    }
                };
                let _ = reader.events.send(event).await;
            }
        });
        Ok(conn)
    }
}
#[async_trait]
impl AgentAdapter for ClaudeAdapter {
    async fn model_catalog(&self, r: &RuntimeSpec) -> Result<ModelCatalog, AdapterError> {
        let now = Utc::now();
        let mut command = Command::new(&r.executable);
        command.args(&r.args).args(["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--permission-mode", "default", "--permission-prompt-tool", "stdio", "--no-session-persistence"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        if let Some(cwd) = r.cwd.as_ref() { command.current_dir(cwd); }
        let result = async {
            let mut child = command.spawn().map_err(|e| AdapterError::Process(e.to_string()))?;
            let mut stdin = child.stdin.take().ok_or_else(|| AdapterError::Process("Claude catalog stdin unavailable".into()))?;
            let stdout = child.stdout.take().ok_or_else(|| AdapterError::Process("Claude catalog stdout unavailable".into()))?;
            let request = json!({"type":"control_request","request_id":"bloblex-list-models","request":{"subtype":"list_models"}});
            let mut bytes = serde_json::to_vec(&request).map_err(|e| AdapterError::Protocol(e.to_string()))?; bytes.push(b'\n');
            stdin.write_all(&bytes).await.map_err(|e| AdapterError::Process(e.to_string()))?; stdin.flush().await.map_err(|e| AdapterError::Process(e.to_string()))?; drop(stdin);
            let mut lines = BufReader::new(stdout).lines();
            let mut found = None;
            while let Some(line) = tokio::time::timeout(std::time::Duration::from_secs(8), lines.next_line()).await.map_err(|_| AdapterError::Process("Claude catalog timed out".into()))?.map_err(|e| AdapterError::Process(e.to_string()))? {
                let parsed: Value = serde_json::from_str(&line).map_err(|_| AdapterError::Protocol("Claude catalog response was malformed".into()))?;
                if parsed["type"] == "control_response" && parsed["response"]["subtype"] == "success" { found = Some(parsed["response"].clone()); break; }
            }
            let _ = child.kill().await;
            let body = found.ok_or_else(|| AdapterError::Protocol("Claude catalog response was missing".into()))?;
            parse_model_catalog(&body["response"])
        }.await;
        let (models, fallback, source) = match result { Ok(models) => (models, false, "control_request"), Err(_) => (fallback_catalog(), true, "static") };
        Ok(ModelCatalog { models, fetched_at: now.to_rfc3339(), expires_at: (now + Duration::seconds(60)).to_rfc3339(), fallback, source: source.into() })
    }
    async fn probe(&self, r: &RuntimeSpec) -> Result<ProbeResult, AdapterError> {
        let mut c = Command::new(&r.executable);
        c.args(&r.args)
            .arg("--help")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let out = tokio::time::timeout(std::time::Duration::from_secs(6), c.output())
            .await
            .map_err(|_| AdapterError::Process("Claude probe timed out".into()))?
            .map_err(|e| AdapterError::Process(e.to_string()))?;
        let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
        if text.len() < 32 * 1024 {
            text.push_str(&String::from_utf8_lossy(&out.stderr));
        }
        if !text.contains("--output-format") || !text.contains("stream-json") {
            return Err(AdapterError::Unsupported(
                "Claude Code streaming mode is unavailable".into(),
            ));
        }
        Ok(ProbeResult {
            provider: "claude".into(),
            version: None,
            protocol: "claude_stream".into(),
            authenticated: None,
            capabilities: AgentCapabilities {
                resume: true,
                cancel: true,
                permissions: true,
                usage: true,
                files: false,
            },
        })
    }
    async fn new_session(
        &self,
        r: &RuntimeSpec,
        q: NewSessionRequest,
        events: EventSender,
    ) -> Result<SessionHandle, AdapterError> {
        let mut launch_options=q.exec_options.clone();launch_options.instructions=None;
        let c = self
            .start(r, &q.project_path, None, events, &q.session_id, &launch_options, false, None)
            .await?;
        let id = c
            .provider_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| AdapterError::Protocol("Claude session id missing".into()))?;
        self.sessions.lock().await.insert(q.session_id.clone(), c);
        Ok(SessionHandle {
            session_id: q.session_id,
            provider_session_id: id,
            capabilities: AgentCapabilities {
                resume: true,
                cancel: true,
                permissions: true,
                usage: true,
                files: false,
            },
        })
    }
    async fn resume_session(
        &self,
        r: &RuntimeSpec,
        q: ResumeSessionRequest,
        events: EventSender,
    ) -> Result<SessionHandle, AdapterError> {
        let mut launch_options=q.exec_options.clone();launch_options.instructions=None;
        let c = self
            .start(
                r,
                &q.project_path,
                Some(&q.provider_session_id),
                events,
                &q.session_id,
                &launch_options,
                false,
                None,
            )
            .await?;
        self.sessions.lock().await.insert(q.session_id.clone(), c);
        Ok(SessionHandle {
            session_id: q.session_id,
            provider_session_id: q.provider_session_id,
            capabilities: AgentCapabilities {
                resume: true,
                cancel: true,
                permissions: true,
                usage: true,
                files: false,
            },
        })
    }
    async fn prompt(&self, h: &SessionHandle, q: PromptRequest) -> Result<(), AdapterError> {
        let mut c = self
            .sessions
            .lock()
            .await
            .get(&h.session_id)
            .cloned()
            .ok_or_else(|| AdapterError::Process("Claude session not active".into()))?;
        let (desired_hash,baseline)=self.instruction_hash_context.lock().await.remove(&h.session_id).unwrap_or((None,None));
        let instruction_changed=baseline.as_ref().is_some_and(|old|Some(old)!=desired_hash.as_ref());
        let options_changed = c.launch_options.model != q.exec_options.model || c.launch_options.thinking != q.exec_options.thinking || c.launch_options.service_tier != q.exec_options.service_tier || c.launch_options.instructions != q.exec_options.instructions || c.launch_options.env != q.exec_options.env || instruction_changed;
        if options_changed {
            let runtime = c.runtime.clone(); let cwd = c.cwd.clone(); let events = c.event_sender.clone();
            let provider_id = c.provider_id.lock().await.clone().ok_or_else(|| AdapterError::Unsupported("Claude resume identity is unavailable for changed execution options".into()))?;
            let _ = c.child.lock().await.kill().await;
            c = self.start(&runtime, &cwd, Some(&provider_id), events, &h.session_id, &q.exec_options, instruction_changed, desired_hash.clone()).await.map_err(|_| AdapterError::Unsupported("Claude could not resume with the requested execution options".into()))?;
            self.sessions.lock().await.insert(h.session_id.clone(), c.clone());
        }
        let bytes =
            serde_json::to_vec(&json!({"type":"user","message":{"role":"user","content":q.text}}))
                .map_err(|e| AdapterError::Protocol(e.to_string()))?;
        c.cancellation_requested.store(false, Ordering::SeqCst);
        *c.active_turn_id.lock().await = Some(q.turn_id.clone());
        c.active_turn.store(true, Ordering::SeqCst);
        let mut stdin = c.stdin.lock().await;
        if let Err(error) = stdin.write_all(&bytes).await {
            c.active_turn.store(false, Ordering::SeqCst);
            return Err(AdapterError::Process(error.to_string()));
        }
        if let Err(error) = stdin.write_all(b"\n").await {
            c.active_turn.store(false, Ordering::SeqCst);
            return Err(AdapterError::Process(error.to_string()));
        }
        Ok(())
    }
    async fn set_instruction_hash_context(&self,session_id:&str,desired:Option<String>,baseline:Option<String>){self.instruction_hash_context.lock().await.insert(session_id.into(),(desired,baseline));}
    async fn preflight_exec_options(&self,options:&ExecOptions)->Result<(),AdapterError>{
        if let Some(text)=options.instructions.as_deref().filter(|s|!s.is_empty()) { let pair=self.create_instruction_file(text).map_err(|_|AdapterError::Unsupported("The requested instructions are unavailable because secure private storage could not be established.".into()))?;remove_private_pair(&pair); }
        Ok(())
    }
    async fn cancel(&self, h: &SessionHandle) -> Result<(), AdapterError> {
        let c = self
            .sessions
            .lock()
            .await
            .get(&h.session_id)
            .cloned()
            .ok_or_else(|| AdapterError::Process("Claude session not active".into()))?;
        c.cancellation_requested.store(true, Ordering::SeqCst);
        let result = c.child.lock().await.kill().await;
        result.map_err(|e| AdapterError::Process(e.to_string()))
    }
    async fn reply_permission(&self, id: &str, choice: &str) -> Result<(), AdapterError> {
        let all = self
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for c in all {
            let request = c.permission_requests.lock().await.get(id).cloned();
            if let Some((original_id, input)) = request {
                let wire = control_response(original_id, input, choice)?;
                let mut bytes =
                    serde_json::to_vec(&wire).map_err(|e| AdapterError::Protocol(e.to_string()))?;
                bytes.push(b'\n');
                c.stdin.lock().await.write_all(&bytes).await.map_err(|e| {
                    AdapterError::Process(format!("writing Claude permission reply: {e}"))
                })?;
                c.permission_requests.lock().await.remove(id);
                return Ok(());
            }
        }
        Err(AdapterError::Unsupported(
            "Claude permission request is unknown or already answered".into(),
        ))
    }
    async fn close_session(&self, h: &SessionHandle) -> Result<(), AdapterError> {
        if let Some(c) = self.sessions.lock().await.remove(&h.session_id) {
            let _ = c.child.lock().await.kill().await;
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_request_parser_preserves_wire_id_and_input() {
        let v = json!({"type":"control_request","request_id":"r-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"echo test"}}});
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let requests = Mutex::new(HashMap::new());
        let provider_id = Mutex::new(None);
        let active_turn = Mutex::new(None);
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            parse_line(&tx, &v, &provider_id, &requests, "local-session", &active_turn).await;
            assert!(matches!(rx.recv().await, Some(AgentEvent::PermissionRequested { provider_request_id, choices, .. }) if provider_request_id == "local-session:r-1" && choices == vec!["allow", "deny"]));
            let stored = requests.lock().await.get("local-session:r-1").cloned().unwrap();
            assert_eq!(stored.0, json!("r-1"));
            assert_eq!(stored.1, json!({"command":"echo test"}));
            let allow = control_response(stored.0, stored.1, "allow").unwrap();
            assert_eq!(allow["response"]["request_id"], "r-1");
            assert_eq!(allow["response"]["response"]["behavior"], "allow");
            assert_eq!(allow["response"]["response"]["updatedInput"]["command"], "echo test");
        });
    }

    #[test]
    fn claude_catalog_fixture_and_typed_argument_order_are_normalized() {
        let rows=parse_model_catalog(&json!({"models":[{"value":"claude-sonnet-5-5","displayName":"Sonnet","providerId":"anthropic","supportedEffortLevels":["low","high"],"defaultEffort":"high"}]})).unwrap();
        assert_eq!(rows[0].id,"claude-sonnet-5-5");assert_eq!(rows[0].supported_thinking,vec!["low","high"]);assert!(rows[0].host_dependent);
        let options=ExecOptions{model:Some("claude-sonnet-5-5".into()),thinking:Some("low".into()),instructions:Some("sentinel only".into()),..ExecOptions::default()};
        assert_eq!(typed_args(&options,Some(std::path::Path::new("C:\\private\\instruction.txt")),true),vec!["--model","claude-sonnet-5-5","--effort","low","--append-system-prompt-file","C:\\private\\instruction.txt","--system-prompt-snapshot","off"]);
        assert!(!typed_args(&options,None,false).iter().any(|v|v=="--system-prompt"));
    }

    #[test]
    fn instruction_file_is_create_new_private_and_removable() {
        let dir=std::env::temp_dir().join(format!("bloblex-fake-private-{}",Uuid::new_v4()));
        let file=match write_private_instruction_file_at(&dir,"private sentinel",None) { Ok(file)=>file, Err(error)=>{assert_eq!(error.kind(),std::io::ErrorKind::PermissionDenied);assert_eq!(std::fs::read_dir(&dir).unwrap().count(),0);std::fs::remove_dir_all(&dir).unwrap();return;} };
        assert_eq!(std::fs::read_to_string(&file.path).unwrap(),"private sentinel");assert!(file.lock_path.exists());
        let replacement=write_private_instruction_file_at(&dir,"replacement",None).unwrap();assert_ne!(replacement.path,file.path);
        remove_private_pair(&file);remove_private_pair(&replacement);std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cleanup_removes_only_old_owned_pairs_with_dead_pid(){
        let dir=std::env::temp_dir().join(format!("bloblex-cleanup-{}",Uuid::new_v4()));std::fs::create_dir_all(&dir).unwrap();let stale=PrivateInstructionFile{path:dir.join("instruction-stale.txt"),lock_path:dir.join("instruction-stale.lock")};let live=PrivateInstructionFile{path:dir.join("instruction-live.txt"),lock_path:dir.join("instruction-live.lock")};let other=dir.join("other.txt");std::fs::write(&stale.path,"stale").unwrap();std::fs::write(&live.path,"live").unwrap();std::fs::write(&other,"untouched").unwrap();
        let dead=[u32::MAX,u32::MAX-1,4,3,2,1].into_iter().find(|pid|!process_is_live(*pid)).unwrap_or(u32::MAX);std::fs::write(&stale.lock_path,dead.to_string()).unwrap();std::fs::write(&live.lock_path,std::process::id().to_string()).unwrap();
        let future=SystemTime::now()+StdDuration::from_secs(25*60*60);cleanup_private_instruction_files_at(&dir,future).unwrap();
        assert!(!stale.path.exists());assert!(!stale.lock_path.exists());assert!(live.path.exists());assert!(live.lock_path.exists());assert!(other.exists());remove_private_pair(&live);std::fs::remove_file(other).unwrap();std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn spawn_failure_removes_secure_instruction_pair(){
        let root=std::env::temp_dir().join(format!("bloblex-spawn-fail-{}",Uuid::new_v4()));let dir=root.join("private");let system=root.join("fake-system");let system32=system.join("System32");std::fs::create_dir_all(&system32).unwrap();
        let fake_icacls=std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("fake-icacls.exe");std::fs::copy(fake_icacls,system32.join("icacls.exe")).unwrap();let adapter=ClaudeAdapter::with_test_acl_executable(dir.clone(),system);let(events,_)=tokio::sync::mpsc::channel(4);
        let runtime=RuntimeSpec{runtime_id:"fake".into(),provider:"claude".into(),executable:root.join("does-not-exist.exe"),args:vec![],cwd:Some(root.clone())};let options=ExecOptions{instructions:Some("private test sentinel".into()),..ExecOptions::default()};
        assert!(adapter.start(&runtime,&root,None,events,"session",&options,false,Some("hash".into())).await.is_err());assert_eq!(std::fs::read_dir(&dir).unwrap().count(),0);std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn successful_claude_usage_is_normalized_and_error_zeros_stay_null() {
        let (tx,mut rx)=tokio::sync::mpsc::channel(8);let id=Mutex::new(None);let permissions=Mutex::new(HashMap::new());let active=Mutex::new(Some("turn-1".to_owned()));
        let rt=tokio::runtime::Runtime::new().unwrap();rt.block_on(async {
            parse_line(&tx,&json!({"type":"result","is_error":false,"session_id":"provider-update","usage":{"input_tokens":8,"output_tokens":3,"cache_read_input_tokens":2,"cache_creation_input_tokens":1,"output_tokens_details":{"thinking_tokens":0}},"modelUsage":{"claude-sonnet-5-5":{"inputTokens":8}},"total_cost_usd":0.01}),&id,&permissions,"s",&active).await;
            match rx.recv().await.unwrap(){AgentEvent::UsageReport{turn_id,report}=>{assert_eq!(turn_id,"turn-1");assert_eq!(report.input_tokens,Some(8));assert_eq!(report.reasoning_tokens,Some(0));assert_eq!(report.model.as_deref(),Some("claude-sonnet-5-5"));assert_eq!(report.cost_minor,Some(1));assert_eq!(report.reported_cost_decimal.as_deref(),Some("0.01"));},_=>panic!("normalized usage expected")}
            assert!(matches!(rx.recv().await,Some(AgentEvent::TurnCompleted)));
            parse_line(&tx,&json!({"type":"result","is_error":true,"usage":{"input_tokens":0,"output_tokens":0},"modelUsage":{}}),&id,&permissions,"s",&active).await;
            match rx.recv().await.unwrap(){AgentEvent::UsageReport{report,..}=>{assert_eq!(report.usage_status,"unreported");assert_eq!(report.input_tokens,None);assert_eq!(report.output_tokens,None);assert_eq!(report.model,None);},_=>panic!("unreported usage expected")}
        });
    }
}
