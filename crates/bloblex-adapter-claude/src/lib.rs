//! Claude Code's documented print/stream-json mode, never interactive TUI scraping.
use async_trait::async_trait;
use bloblex_agent_core::*;
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
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

/// Create a Bloblex-owned instruction file. Windows std does not expose a
/// dependency-free ACL API; create-new protects against replacement and the
/// Bloblex private directory is used, but deployments needing a strict
/// current-user-only DACL must provide that ACL at the directory level.
fn write_private_instruction_file(text: &str) -> std::io::Result<PathBuf> {
    let base = std::env::var_os("BLOBLEX_PRIVATE_TMP").map(PathBuf::from).or_else(|| {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from).map(|p| p.join("Bloblex").join("private-tmp"))
    }).unwrap_or_else(|| std::env::temp_dir().join("Bloblex").join("private-tmp"));
    write_instruction_file_at(&base, text)
}
fn write_instruction_file_at(base: &std::path::Path, text: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(base)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700))?;
    }
    for _ in 0..8 {
        let path = base.join(format!("instruction-{}.txt", Uuid::new_v4()));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; opts.mode(0o600); }
        match opts.open(&path) {
            Ok(mut file) => { use std::io::Write; file.write_all(text.as_bytes())?; file.flush()?; drop(file); return Ok(path); }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "could not allocate a unique instruction file"))
}

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
    instruction_file: Option<PathBuf>,
    runtime: RuntimeSpec,
    cwd: PathBuf,
    launch_options: ExecOptions,
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
                usage_status: "unreported".into(), provider_update_id: None, context_used: None, context_size: None,
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
                    reasoning_tokens: u["output_tokens_details"]["thinking_tokens"].as_u64(), usage_status: if u.is_object() { "reported" } else { "unreported" }.into(),
                    provider_update_id: None, context_used: None, context_size: None,
                    model, cost_minor, cost_currency: cost_minor.map(|_| "USD".into()),
                    reported_cost_decimal: total_cost,
                }}).await;
            } else {
                let _ = tx.send(AgentEvent::UsageReport { turn_id: String::new(), report: UsageReport {
                    input_tokens: None, output_tokens: None, cache_read_tokens: None, cache_write_tokens: None, reasoning_tokens: None,
                    usage_status: "unreported".into(), provider_update_id: None, context_used: None, context_size: None,
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
    async fn start(
        &self,
        r: &RuntimeSpec,
        cwd: &PathBuf,
        provider_session_id: Option<&str>,
        events: EventSender,
        local_session_id: &str,
        options: &ExecOptions,
        instruction_changed: bool,
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
            Some(write_private_instruction_file(instructions).map_err(|e| AdapterError::Process(format!("private instruction file unavailable: {e}")))?)
        } else { None };
        c.args(typed_args(options, instruction_file.as_deref(), instruction_changed));
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
        let mut child = match c.spawn() { Ok(child) => child, Err(e) => { if let Some(path)=instruction_file.as_ref(){let _=std::fs::remove_file(path);} return Err(AdapterError::Process(e.to_string())); } };
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AdapterError::Process("Claude stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Process("Claude stdout unavailable".into()))?;
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
                                if reader.launch_options.instructions.is_some() {
                                    outcomes.insert("instructions".into(), SettingOutcome { requested: Some(json!(true)), applied: Some(true), evidence_kind: EvidenceKind::SuccessfulTurn, evidence_value: reader.instruction_file.as_ref().map(|_| json!("successful_turn")), reason: None });
                                }
                                if !outcomes.is_empty() { let turn_id=reader.active_turn_id.lock().await.clone().unwrap_or_default();let _=reader.events.send(AgentEvent::ExecApplied{turn_id,outcomes}).await; }
                            } else {
                                let mut outcomes = std::collections::BTreeMap::new();
                                for (key,requested) in [("model",reader.launch_options.model.as_ref().map(|v|json!(v))), ("thinking",reader.launch_options.thinking.as_ref().map(|v|json!(v))), ("serviceTier",reader.launch_options.service_tier.as_ref().map(|v|json!(v))), ("instructions",reader.launch_options.instructions.as_ref().map(|_|json!(true)))] {
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
            if let Some(path) = reader.instruction_file.as_ref() { let _ = std::fs::remove_file(path); }
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
        let c = self
            .start(r, &q.project_path, None, events, &q.session_id, &q.exec_options, false)
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
        let c = self
            .start(
                r,
                &q.project_path,
                Some(&q.provider_session_id),
                events,
                &q.session_id,
                &q.exec_options,
                false,
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
        let options_changed = c.launch_options.model != q.exec_options.model || c.launch_options.thinking != q.exec_options.thinking || c.launch_options.service_tier != q.exec_options.service_tier || c.launch_options.instructions != q.exec_options.instructions || c.launch_options.env != q.exec_options.env;
        if options_changed {
            let runtime = c.runtime.clone(); let cwd = c.cwd.clone(); let events = c.event_sender.clone();
            let provider_id = c.provider_id.lock().await.clone().ok_or_else(|| AdapterError::Unsupported("Claude resume identity is unavailable for changed execution options".into()))?;
            let changed_instruction = c.launch_options.instructions != q.exec_options.instructions;
            let _ = c.child.lock().await.kill().await;
            c = self.start(&runtime, &cwd, Some(&provider_id), events, &h.session_id, &q.exec_options, changed_instruction).await.map_err(|_| AdapterError::Unsupported("Claude could not resume with the requested execution options".into()))?;
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
        let file=write_instruction_file_at(&dir,"private sentinel").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(),"private sentinel");
        assert!(write_instruction_file_at(&dir,"replacement").unwrap()!=file);
        std::fs::remove_file(&file).unwrap();std::fs::remove_dir_all(&dir).unwrap();
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
