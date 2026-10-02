use async_trait::async_trait;
use bloblex_agent_core::*;
use bloblex_process::{prepare_command, ProcessTree};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};

mod catalog;
mod exec;
mod sha256;

#[doc(hidden)]
pub use sha256::sha256_hex;

struct Conn {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    process_tree: ProcessTree,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, AdapterError>>>>,
    incoming: Mutex<HashMap<String, Value>>,
    permission_options: Mutex<HashMap<String, Vec<Value>>>,
    next: AtomicU64,
    session_id: Mutex<Option<String>>,
    can_resume: AtomicBool,
    turn_completed: AtomicBool,
    local_session_id: String,
    events: EventSender,
    spawned_instructions: Option<String>,
    spawned_env: BTreeMap<String, String>,
    config_options: Mutex<Vec<Value>>,
    applied: Mutex<exec::Echoes>,
    usage: Mutex<exec::UsageSnap>,
    usage_seq: AtomicU64,
}

#[derive(Default)]
pub struct AcpAdapter {
    sessions: Mutex<HashMap<String, Arc<Conn>>>,
    /// Zero keeps the 20s catalog bound. Tests set a shorter bound.
    catalog_timeout_ms: AtomicU64,
}

impl AcpAdapter {
    pub fn with_catalog_timeout(timeout: Duration) -> Self {
        let adapter = Self::default();
        adapter
            .catalog_timeout_ms
            .store(timeout.as_millis().max(1) as u64, Ordering::Relaxed);
        adapter
    }

    fn catalog_timeout(&self) -> Duration {
        let millis = self.catalog_timeout_ms.load(Ordering::Relaxed);
        Duration::from_millis(if millis == 0 { 20_000 } else { millis })
    }

    async fn spawn(
        &self,
        runtime: &RuntimeSpec,
        cwd: &Path,
        events: EventSender,
        local_session_id: &str,
        options: &ExecOptions,
    ) -> Result<Arc<Conn>, AdapterError> {
        let mut cmd = Command::new(&runtime.executable);
        prepare_command(&mut cmd);
        cmd.args(&runtime.args)
            .arg("acp")
            .arg("--cwd")
            .arg(cwd)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Real runs keep the user profile (credentials live there). Isolation
        // is the per-process config document, never a redirected data dir.
        exec::apply_child_env(&mut cmd, options);
        let mut child = cmd.spawn().map_err(|e| AdapterError::Process(e.to_string()))?;
        let process_tree = ProcessTree::attach(&mut child).map_err(|e| AdapterError::Process(e.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AdapterError::Process("ACP stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Process("ACP stdout unavailable".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AdapterError::Process("ACP stderr unavailable".into()))?;
        let secret = exec::normalize_instructions(&options.instructions);
        let stderr_secret = secret.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut remaining = 8192usize;
            while remaining > 0 {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        remaining = remaining.saturating_sub(line.len());
                        let diagnostic = exec::scrub_stderr(&line, stderr_secret.as_deref());
                        tracing::warn!(target: "bloblex.provider", provider = "opencode", diagnostic = %diagnostic);
                    }
                    _ => break,
                }
            }
        });
        let c = Arc::new(Conn {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            process_tree,
            pending: Mutex::new(HashMap::new()),
            incoming: Mutex::new(HashMap::new()),
            permission_options: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            session_id: Mutex::new(None),
            can_resume: AtomicBool::new(false),
            turn_completed: AtomicBool::new(false),
            local_session_id: local_session_id.to_owned(),
            events,
            spawned_instructions: secret,
            spawned_env: options.env.clone(),
            config_options: Mutex::new(Vec::new()),
            applied: Mutex::new(exec::Echoes::default()),
            usage: Mutex::new(exec::UsageSnap::default()),
            usage_seq: AtomicU64::new(0),
        });
        let reader = Arc::clone(&c);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = msg.get("id") {
                    let key = id_key(id);
                    if let Some(method) = msg.get("method").and_then(Value::as_str) {
                        if method == "session/request_permission" {
                            let key = format!("{}:{key}", reader.local_session_id);
                            reader.incoming.lock().await.insert(key.clone(), id.clone());
                            let options = msg["params"]["options"].as_array().cloned().unwrap_or_default();
                            reader.permission_options.lock().await.insert(key.clone(), options);
                            emit_permission(&reader.events, msg.get("params").unwrap_or(&Value::Null), &key).await;
                        } else {
                            let response = json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": {"code": -32601, "message": "Method not supported by Bloblex ACP client"}
                            });
                            let mut bytes = serde_json::to_vec(&response).unwrap_or_default();
                            bytes.push(b'\n');
                            let _ = reader.stdin.lock().await.write_all(&bytes).await;
                        }
                    } else if let Some(tx) = reader.pending.lock().await.remove(&key) {
                        if let Some(err) = msg.get("error") {
                            let _ = tx.send(Err(AdapterError::Protocol(err.to_string())));
                        } else {
                            let _ = tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                        }
                    }
                }
                if msg.get("method").and_then(Value::as_str) == Some("session/update") {
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    if params["update"]["sessionUpdate"].as_str() == Some("usage_update") {
                        let mut snap = reader.usage.lock().await;
                        exec::record_usage_update(&mut snap, &params["update"], &line);
                    }
                    if params["update"]["sessionUpdate"].as_str() == Some("agent_turn_complete") {
                        reader.turn_completed.store(true, Ordering::SeqCst);
                    }
                    emit_update(&reader.events, &params).await;
                }
            }
            for (_, tx) in std::mem::take(&mut *reader.pending.lock().await) {
                let _ = tx.send(Err(AdapterError::Process("ACP process exited".into())));
            }
        });
        Ok(c)
    }

    async fn request(c: &Conn, method: &str, params: Value) -> Result<Value, AdapterError> {
        let id = c.next.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = oneshot::channel();
        c.pending.lock().await.insert(id.clone(), tx);
        let msg = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        let mut stdin = c.stdin.lock().await;
        let mut bytes = serde_json::to_vec(&msg).map_err(|e| AdapterError::Protocol(e.to_string()))?;
        bytes.push(b'\n');
        if let Err(e) = stdin.write_all(&bytes).await {
            c.pending.lock().await.remove(&id);
            return Err(AdapterError::Process(e.to_string()));
        }
        drop(stdin);
        let request_timeout = if method == "session/prompt" {
            Duration::from_secs(30 * 60)
        } else {
            Duration::from_secs(20)
        };
        match tokio::time::timeout(request_timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(AdapterError::Process("ACP connection closed".into())),
            Err(_) => {
                c.pending.lock().await.remove(&id);
                Err(AdapterError::Timeout)
            }
        }
    }

    async fn notify(c: &Conn, method: &str, params: Value) -> Result<(), AdapterError> {
        let msg = json!({"jsonrpc":"2.0","method":method,"params":params});
        let mut bytes = serde_json::to_vec(&msg).map_err(|e| AdapterError::Protocol(e.to_string()))?;
        bytes.push(b'\n');
        c.stdin
            .lock()
            .await
            .write_all(&bytes)
            .await
            .map_err(|e| AdapterError::Process(e.to_string()))
    }

    async fn fail_setting(
        c: &Conn,
        turn_id: Option<&str>,
        key: &str,
        requested: Value,
        reason: &str,
    ) {
        let mut outcomes = BTreeMap::new();
        outcomes.insert(key.into(), exec::rejected_outcome(requested, reason));
        let _ = c
            .events
            .send(AgentEvent::ExecApplied {
                turn_id: turn_id.unwrap_or("").to_owned(),
                outcomes,
            })
            .await;
    }

    async fn select(
        c: &Conn,
        provider_session_id: &str,
        config_id: &str,
        value: &str,
        outcome_key: &str,
        missing: &str,
        rejected: &str,
        turn_id: Option<&str>,
    ) -> Result<(), AdapterError> {
        let offered = {
            let options = c.config_options.lock().await;
            exec::config_option(&options, config_id)
                .map(exec::option_values)
                .unwrap_or_default()
        };
        if !offered.contains(value) {
            Self::fail_setting(c, turn_id, outcome_key, json!(value), missing).await;
            return Err(AdapterError::Protocol(missing.into()));
        }
        let result = match Self::request(
            c,
            "session/set_config_option",
            json!({"sessionId": provider_session_id, "configId": config_id, "value": value}),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                Self::fail_setting(c, turn_id, outcome_key, json!(value), rejected).await;
                return Err(AdapterError::Protocol(rejected.into()));
            }
        };
        let updated = exec::options_from_result(&result);
        let echoed = exec::config_option(&updated, config_id).and_then(exec::current_value);
        *c.config_options.lock().await = updated;
        if echoed.as_deref() != Some(value) {
            Self::fail_setting(c, turn_id, outcome_key, json!(value), rejected).await;
            return Err(AdapterError::Protocol(rejected.into()));
        }
        let mut applied = c.applied.lock().await;
        match config_id {
            "model" => applied.model = echoed,
            "mode" => applied.mode = echoed,
            "effort" => applied.effort = echoed,
            _ => {}
        }
        Ok(())
    }

    /// `session/new` or `session/load`, then model, then mode, then effort.
    /// A missing option or RPC error returns before the caller can prompt.
    async fn apply_options(
        c: &Conn,
        provider_session_id: &str,
        options: &ExecOptions,
        turn_id: Option<&str>,
    ) -> Result<(), AdapterError> {
        if let Some(reject) = exec::preflight(options) {
            let _ = c
                .events
                .send(AgentEvent::ExecApplied {
                    turn_id: turn_id.unwrap_or("").to_owned(),
                    outcomes: exec::single_outcome(reject, options),
                })
                .await;
            return Err(exec::preflight_error(reject));
        }
        if let Some(instructions) = exec::normalize_instructions(&options.instructions) {
            if c.spawned_instructions.as_deref() != Some(instructions.as_str()) {
                Self::fail_setting(c, turn_id, "instructions", json!(true), exec::ERR_INSTRUCTIONS_FIXED).await;
                return Err(AdapterError::Protocol(exec::ERR_INSTRUCTIONS_FIXED.into()));
            }
        }
        if !options.env.is_empty() && options.env != c.spawned_env {
            Self::fail_setting(c, turn_id, "env", json!(true), exec::ERR_ENV).await;
            return Err(AdapterError::Unsupported(exec::ERR_ENV.into()));
        }
        if let Some(model) = exec::nonempty(&options.model) {
            if c.applied.lock().await.model.as_deref() != Some(model) {
                Self::select(
                    c,
                    provider_session_id,
                    "model",
                    model,
                    "model",
                    exec::ERR_MODEL_MISSING,
                    exec::ERR_MODEL_REJECTED,
                    turn_id,
                )
                .await?;
            }
        }
        if exec::normalize_instructions(&options.instructions).is_some()
            && c.applied.lock().await.mode.as_deref() != Some(exec::AGENT_NAME)
        {
            Self::select(
                c,
                provider_session_id,
                "mode",
                exec::AGENT_NAME,
                "mode",
                exec::ERR_MODE_MISSING,
                exec::ERR_MODE_REJECTED,
                turn_id,
            )
            .await?;
        }
        if let Some(thinking) = exec::nonempty(&options.thinking) {
            if c.applied.lock().await.effort.as_deref() != Some(thinking) {
                Self::select(
                    c,
                    provider_session_id,
                    "effort",
                    thinking,
                    "thinking",
                    exec::ERR_EFFORT_MISSING,
                    exec::ERR_EFFORT_REJECTED,
                    turn_id,
                )
                .await?;
            }
        }
        Ok(())
    }

    async fn emit_turn_evidence(c: &Conn, turn_id: &str, options: &ExecOptions, result: Option<&Value>) {
        let stop = result.and_then(|value| value["stopReason"].as_str());
        let failed = stop != Some("end_turn");
        let seq = c.usage_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let snap = if failed {
            exec::UsageSnap::default()
        } else {
            c.usage.lock().await.clone()
        };
        let report = exec::usage_report(failed, result.unwrap_or(&Value::Null), &snap, seq);
        let _ = c
            .events
            .send(AgentEvent::UsageReport {
                turn_id: turn_id.to_owned(),
                report,
            })
            .await;
        let echoes = c.applied.lock().await.clone();
        let outcomes = exec::turn_outcomes(options, &echoes, stop);
        if !outcomes.is_empty() {
            let _ = c
                .events
                .send(AgentEvent::ExecApplied {
                    turn_id: turn_id.to_owned(),
                    outcomes,
                })
                .await;
        }
    }
}

async fn emit_update(tx: &EventSender, p: &Value) {
    let u = &p["update"];
    let kind = u["sessionUpdate"].as_str().unwrap_or("");
    let content = &u["content"];
    let text = content["text"].as_str().unwrap_or("");
    let event = match kind {
        "agent_message_chunk" => Some(AgentEvent::AssistantDelta { text: text.into() }),
        "agent_thought_chunk" => Some(AgentEvent::ThinkingDelta { text: text.into() }),
        "tool_call" => Some(AgentEvent::ToolStarted {
            tool_call_id: u["toolCallId"].as_str().unwrap_or("tool").into(),
            kind: u["kind"].as_str().unwrap_or("other").into(),
            title: u["title"].as_str().unwrap_or("Tool call").into(),
            raw: u.clone(),
        }),
        "tool_call_update" => {
            let tool_call_id = u["toolCallId"].as_str().unwrap_or("tool").into();
            if matches!(u["status"].as_str(), Some("completed" | "failed")) {
                Some(AgentEvent::ToolCompleted { tool_call_id, raw: u.clone() })
            } else {
                Some(AgentEvent::ToolUpdated { tool_call_id, raw: u.clone() })
            }
        }
        "agent_turn_complete" | "current_mode_update" | "session_info_update" | "usage_update" => None,
        _ => None,
    };
    if let Some(event) = event {
        let _ = tx.send(event).await;
    }
}

fn id_key(id: &Value) -> String {
    id.as_str().map(str::to_owned).unwrap_or_else(|| id.to_string())
}

async fn emit_permission(tx: &EventSender, p: &Value, id: &str) {
    let options = p["options"].as_array().cloned().unwrap_or_default();
    let choices = options
        .iter()
        .filter_map(|option| option["kind"].as_str().or(option["optionId"].as_str()).map(str::to_owned))
        .collect();
    let title = p["toolCall"]["title"]
        .as_str()
        .unwrap_or("Agent permission request")
        .to_owned();
    let _ = tx
        .send(AgentEvent::PermissionRequested {
            provider_request_id: id.into(),
            title,
            detail: p["toolCall"]["rawInput"].as_str().map(str::to_owned),
            choices,
            raw: p.clone(),
        })
        .await;
}

impl Conn {
    async fn pending_permission_options(&self, id: &str) -> Vec<Value> {
        self.permission_options.lock().await.get(id).cloned().unwrap_or_default()
    }
}

#[async_trait]
impl AgentAdapter for AcpAdapter {
    async fn model_catalog(&self, runtime: &RuntimeSpec) -> Result<ModelCatalog, AdapterError> {
        catalog::fetch_model_catalog(runtime, self.catalog_timeout()).await
    }

    async fn probe(&self, runtime: &RuntimeSpec) -> Result<ProbeResult, AdapterError> {
        let mut cmd = Command::new(&runtime.executable);
        prepare_command(&mut cmd);
        cmd.args(&runtime.args)
            .arg("acp")
            .arg("--help")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| AdapterError::Process(e.to_string()))?;
        let process_tree = ProcessTree::attach(&mut child).map_err(|e| AdapterError::Process(e.to_string()))?;
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .map_err(|_| { let _ = process_tree.terminate(); AdapterError::Process("ACP probe timed out".into()) })?
            .map_err(|e| AdapterError::Process(e.to_string()))?;
        if !status.success() {
            return Err(AdapterError::Unsupported("OpenCode ACP is unavailable".into()));
        }
        Ok(ProbeResult {
            provider: "opencode".into(),
            version: None,
            protocol: "acp-v1".into(),
            authenticated: None,
            capabilities: AgentCapabilities {
                resume: false,
                cancel: true,
                permissions: true,
                usage: true,
                files: false,
            },
        })
    }

    async fn new_session(
        &self,
        runtime: &RuntimeSpec,
        req: NewSessionRequest,
        events: EventSender,
    ) -> Result<SessionHandle, AdapterError> {
        if let Some(reject) = exec::preflight(&req.exec_options) {
            let _ = events
                .send(AgentEvent::ExecApplied {
                    turn_id: String::new(),
                    outcomes: exec::single_outcome(reject, &req.exec_options),
                })
                .await;
            return Err(exec::preflight_error(reject));
        }
        let c = self
            .spawn(runtime, &req.project_path, events, &req.session_id, &req.exec_options)
            .await?;
        let setup = async {
            let init = Self::request(
                &c,
                "initialize",
                json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"Bloblex","version":"0.1.0"}}),
            )
            .await?;
            c.can_resume.store(
                init["agentCapabilities"]["loadSession"].as_bool().unwrap_or(false),
                Ordering::Relaxed,
            );
            Self::notify(&c, "initialized", json!({})).await?;
            let result = Self::request(
                &c,
                "session/new",
                json!({"cwd": req.project_path, "mcpServers": []}),
            )
            .await?;
            let provider_id = result["sessionId"]
                .as_str()
                .ok_or_else(|| AdapterError::Protocol("session/new returned no sessionId".into()))?
                .to_owned();
            *c.session_id.lock().await = Some(provider_id.clone());
            *c.config_options.lock().await = exec::options_from_result(&result);
            Self::apply_options(&c, &provider_id, &req.exec_options, None).await?;
            Ok::<String, AdapterError>(provider_id)
        }
        .await;
        let provider_id = match setup {
            Ok(provider_id) => provider_id,
            Err(error) => {
                let _ = c.process_tree.terminate();
                let _ = c.child.lock().await.kill().await;
                return Err(error);
            }
        };
        let resume = c.can_resume.load(Ordering::Relaxed);
        self.sessions.lock().await.insert(req.session_id.clone(), c);
        Ok(SessionHandle {
            session_id: req.session_id,
            provider_session_id: provider_id,
            capabilities: AgentCapabilities {
                resume,
                cancel: true,
                permissions: true,
                usage: true,
                files: false,
            },
        })
    }

    async fn resume_session(
        &self,
        runtime: &RuntimeSpec,
        req: ResumeSessionRequest,
        events: EventSender,
    ) -> Result<SessionHandle, AdapterError> {
        if let Some(reject) = exec::preflight(&req.exec_options) {
            let _ = events
                .send(AgentEvent::ExecApplied {
                    turn_id: String::new(),
                    outcomes: exec::single_outcome(reject, &req.exec_options),
                })
                .await;
            return Err(exec::preflight_error(reject));
        }
        let c = self
            .spawn(runtime, &req.project_path, events, &req.session_id, &req.exec_options)
            .await?;
        let setup = async {
            let init = Self::request(
                &c,
                "initialize",
                json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"Bloblex","version":"0.1.0"}}),
            )
            .await?;
            if !init["agentCapabilities"]["loadSession"].as_bool().unwrap_or(false) {
                return Err(AdapterError::Unsupported("ACP agent did not advertise loadSession".into()));
            }
            c.can_resume.store(true, Ordering::Relaxed);
            Self::notify(&c, "initialized", json!({})).await?;
            let result = Self::request(
                &c,
                "session/load",
                json!({"sessionId": req.provider_session_id, "cwd": req.project_path, "mcpServers": []}),
            )
            .await?;
            *c.session_id.lock().await = Some(req.provider_session_id.clone());
            *c.config_options.lock().await = exec::options_from_result(&result);
            Self::apply_options(&c, &req.provider_session_id, &req.exec_options, None).await?;
            Ok::<(), AdapterError>(())
        }
        .await;
        if let Err(error) = setup {
            let _ = c.process_tree.terminate();
            let _ = c.child.lock().await.kill().await;
            return Err(error);
        }
        self.sessions.lock().await.insert(req.session_id.clone(), c);
        Ok(SessionHandle {
            session_id: req.session_id,
            provider_session_id: req.provider_session_id,
            capabilities: AgentCapabilities {
                resume: true,
                cancel: true,
                permissions: true,
                usage: true,
                files: false,
            },
        })
    }

    async fn prompt(&self, handle: &SessionHandle, req: PromptRequest) -> Result<(), AdapterError> {
        let c = self
            .sessions
            .lock()
            .await
            .get(&handle.session_id)
            .cloned()
            .ok_or_else(|| AdapterError::Process("ACP session missing".into()))?;
        Self::apply_options(&c, &handle.provider_session_id, &req.exec_options, Some(&req.turn_id)).await?;
        c.turn_completed.store(false, Ordering::SeqCst);
        *c.usage.lock().await = exec::UsageSnap::default();
        let result = match Self::request(
            &c,
            "session/prompt",
            json!({"sessionId": handle.provider_session_id, "prompt": [{"type": "text", "text": req.text}]}),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                Self::emit_turn_evidence(&c, &req.turn_id, &req.exec_options, None).await;
                return Err(AdapterError::Protocol("OpenCode prompt failed".into()));
            }
        };
        let stop = result["stopReason"].as_str().map(str::to_owned);
        // Turn lifecycle events stay ahead of usage/evidence so existing
        // callers that take the next event still observe completion.
        if stop.as_deref() == Some("cancelled") {
            let _ = c.events.send(AgentEvent::TurnCancelled).await;
        } else if stop.as_deref() == Some("end_turn") {
            let _ = c.events.send(AgentEvent::TurnCompleted).await;
        } else {
            let _ = c
                .events
                .send(AgentEvent::Error {
                    message: "OpenCode turn failed".into(),
                })
                .await;
        }
        Self::emit_turn_evidence(&c, &req.turn_id, &req.exec_options, Some(&result)).await;
        c.turn_completed.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn cancel(&self, handle: &SessionHandle) -> Result<(), AdapterError> {
        let c = self
            .sessions
            .lock()
            .await
            .get(&handle.session_id)
            .cloned()
            .ok_or_else(|| AdapterError::Process("ACP session missing".into()))?;
        let requests = std::mem::take(&mut *c.incoming.lock().await);
        for (key, id) in requests {
            let response = json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}});
            let mut bytes = serde_json::to_vec(&response).map_err(|e| AdapterError::Protocol(e.to_string()))?;
            bytes.push(b'\n');
            c.stdin
                .lock()
                .await
                .write_all(&bytes)
                .await
                .map_err(|e| AdapterError::Process(e.to_string()))?;
            c.permission_options.lock().await.remove(&key);
        }
        let cancelled = tokio::time::timeout(
            Duration::from_secs(2),
            Self::notify(&c, "session/cancel", json!({"sessionId": handle.provider_session_id})),
        ).await;
        if !matches!(cancelled, Ok(Ok(()))) {
            let _ = c.process_tree.terminate();
            let _ = c.child.lock().await.kill().await;
            return Ok(());
        }
        let completed = tokio::time::timeout(Duration::from_secs(2), async {
            while !c.turn_completed.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }).await;
        if completed.is_err() {
            let _ = c.process_tree.terminate();
            let _ = c.child.lock().await.kill().await;
        }
        Ok(())
    }

    async fn reply_permission(&self, id: &str, choice: &str) -> Result<(), AdapterError> {
        let all = self.sessions.lock().await.values().cloned().collect::<Vec<_>>();
        for c in all {
            let mut incoming = c.incoming.lock().await;
            if let Some(rid) = incoming.get(id).cloned() {
                let option = c.pending_permission_options(id).await;
                let option_id = option
                    .iter()
                    .find(|candidate| {
                        candidate["kind"].as_str() == Some(choice) || candidate["optionId"].as_str() == Some(choice)
                    })
                    .and_then(|candidate| candidate["optionId"].as_str())
                    .ok_or_else(|| AdapterError::Unsupported("permission choice is not supported by ACP agent".into()))?;
                let result = json!({"outcome":{"outcome":"selected","optionId":option_id}});
                let msg = json!({"jsonrpc":"2.0","id":rid,"result":result});
                let mut bytes = serde_json::to_vec(&msg).map_err(|e| AdapterError::Protocol(e.to_string()))?;
                bytes.push(b'\n');
                c.stdin
                    .lock()
                    .await
                    .write_all(&bytes)
                    .await
                    .map_err(|e| AdapterError::Process(e.to_string()))?;
                incoming.remove(id);
                drop(incoming);
                c.permission_options.lock().await.remove(id);
                return Ok(());
            }
        }
        Err(AdapterError::Unsupported("ACP permission request not found".into()))
    }

    async fn close_session(&self, handle: &SessionHandle) -> Result<(), AdapterError> {
        if let Some(c) = self.sessions.lock().await.remove(&handle.session_id) {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                Self::request(&c, "session/close", json!({"sessionId": handle.provider_session_id})),
            )
            .await;
            let _ = c.process_tree.terminate();
            let _ = c.child.lock().await.kill().await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_event_mapping_compiles_wire_schema() {
        let params = json!({"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}});
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            emit_update(&tx, &params).await;
            assert!(matches!(rx.recv().await, Some(AgentEvent::AssistantDelta { text }) if text == "hello"));
        });
        assert_eq!(id_key(&json!("1")), "1");
        assert_eq!(id_key(&json!(1)), "1");
        let usage = json!({"sessionId":"s","update":{"sessionUpdate":"usage_update","used":1,"size":2}});
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            emit_update(&tx, &usage).await;
        });
        assert!(rx.try_recv().is_err());
    }
}
