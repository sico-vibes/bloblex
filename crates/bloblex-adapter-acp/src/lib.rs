use async_trait::async_trait;
use bloblex_agent_core::*;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};

struct Conn {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, AdapterError>>>>,
    incoming: Mutex<HashMap<String, Value>>,
    permission_options: Mutex<HashMap<String, Vec<Value>>>,
    next: AtomicU64,
    session_id: Mutex<Option<String>>,
    can_resume: AtomicBool,
    turn_completed: AtomicBool,
    local_session_id: String,
    events: EventSender,
}
#[derive(Default)]
pub struct AcpAdapter {
    sessions: Mutex<HashMap<String, Arc<Conn>>>,
}
impl AcpAdapter {
    async fn spawn(
        &self,
        runtime: &RuntimeSpec,
        cwd: &Path,
        events: EventSender,
        local_session_id: &str,
    ) -> Result<Arc<Conn>, AdapterError> {
        let mut cmd = Command::new(&runtime.executable);
        cmd.args(&runtime.args)
            .arg("acp")
            .arg("--cwd")
            .arg(cwd)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| AdapterError::Process(e.to_string()))?;
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
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut remaining = 8192usize;
            while remaining > 0 {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        remaining = remaining.saturating_sub(line.len());
                        tracing::warn!(target: "bloblex.provider", provider="opencode", diagnostic=%safe_stderr(&line));
                    }
                    _ => break,
                }
            }
        });
        let c = Arc::new(Conn {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            incoming: Mutex::new(HashMap::new()),
            permission_options: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            session_id: Mutex::new(None),
            can_resume: AtomicBool::new(false),
            turn_completed: AtomicBool::new(false),
            local_session_id: local_session_id.to_owned(),
            events,
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
                            let options = msg["params"]["options"]
                                .as_array()
                                .cloned()
                                .unwrap_or_default();
                            reader
                                .permission_options
                                .lock()
                                .await
                                .insert(key.clone(), options);
                            emit_permission(
                                &reader.events,
                                msg.get("params").unwrap_or(&Value::Null),
                                &key,
                            )
                            .await;
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
                    let params = msg.get("params").unwrap_or(&Value::Null);
                    if params["update"]["sessionUpdate"].as_str() == Some("agent_turn_complete") {
                        reader.turn_completed.store(true, Ordering::SeqCst);
                    }
                    emit_update(&reader.events, params).await;
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
        let mut bytes =
            serde_json::to_vec(&msg).map_err(|e| AdapterError::Protocol(e.to_string()))?;
        bytes.push(b'\n');
        if let Err(e) = stdin.write_all(&bytes).await {
            c.pending.lock().await.remove(&id);
            return Err(AdapterError::Process(e.to_string()));
        }
        drop(stdin);
        let request_timeout = if method == "session/prompt" {
            std::time::Duration::from_secs(30 * 60)
        } else {
            std::time::Duration::from_secs(20)
        };
        match tokio::time::timeout(request_timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(AdapterError::Process("ACP connection closed".into())),
            Err(_) => {
                c.pending.lock().await.remove(&id);
                Err(AdapterError::Protocol(format!(
                    "timeout waiting for {method}"
                )))
            }
        }
    }
    async fn notify(c: &Conn, method: &str, params: Value) -> Result<(), AdapterError> {
        let msg = json!({"jsonrpc":"2.0","method":method,"params":params});
        let mut b = serde_json::to_vec(&msg).map_err(|e| AdapterError::Protocol(e.to_string()))?;
        b.push(b'\n');
        c.stdin
            .lock()
            .await
            .write_all(&b)
            .await
            .map_err(|e| AdapterError::Process(e.to_string()))
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
                Some(AgentEvent::ToolCompleted {
                    tool_call_id,
                    raw: u.clone(),
                })
            } else {
                Some(AgentEvent::ToolUpdated {
                    tool_call_id,
                    raw: u.clone(),
                })
            }
        }
        // Completion is finalized from the session/prompt response, whose
        // stopReason distinguishes normal completion from cancellation.
        "agent_turn_complete" => None,
        "current_mode_update" => None,
        "session_info_update" => None,
        _ => None,
    };
    if let Some(e) = event {
        let _ = tx.send(e).await;
    }
}
fn id_key(id: &Value) -> String {
    id.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| id.to_string())
}
fn safe_stderr(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if [
        "password",
        "secret",
        "credential",
        "authorization",
        "bearer",
        "api_key",
        "token=",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return "[redacted provider diagnostic]".into();
    }
    line.split_whitespace()
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            if lower.contains("sk-ant-") || lower.contains("sk-") || lower.contains("ghp_") {
                "[redacted]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(512)
        .collect()
}
async fn emit_permission(tx: &EventSender, p: &Value, id: &str) {
    let options = p["options"].as_array().cloned().unwrap_or_default();
    let choices = options
        .iter()
        .filter_map(|o| {
            o["kind"]
                .as_str()
                .or(o["optionId"].as_str())
                .map(str::to_owned)
        })
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
        self.permission_options
            .lock()
            .await
            .get(id)
            .cloned()
            .unwrap_or_default()
    }
}
#[async_trait]
impl AgentAdapter for AcpAdapter {
    async fn probe(&self, r: &RuntimeSpec) -> Result<ProbeResult, AdapterError> {
        let mut cmd = Command::new(&r.executable);
        cmd.args(&r.args)
            .arg("acp")
            .arg("--help")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let status = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.status())
            .await
            .map_err(|_| AdapterError::Process("ACP probe timed out".into()))?
            .map_err(|e| AdapterError::Process(e.to_string()))?;
        if !status.success() {
            return Err(AdapterError::Unsupported(
                "OpenCode ACP is unavailable".into(),
            ));
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
                usage: false,
                files: false,
            },
        })
    }
    async fn new_session(
        &self,
        r: &RuntimeSpec,
        req: NewSessionRequest,
        events: EventSender,
    ) -> Result<SessionHandle, AdapterError> {
        let c = self
            .spawn(r, &req.project_path, events, &req.session_id)
            .await?;
        let init=Self::request(&c,"initialize",json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"Bloblex","version":"0.1.0"}})).await?;
        c.can_resume.store(
            init["agentCapabilities"]["loadSession"]
                .as_bool()
                .unwrap_or(false),
            Ordering::Relaxed,
        );
        Self::notify(&c, "initialized", json!({})).await?;
        let result = Self::request(
            &c,
            "session/new",
            json!({"cwd":req.project_path,"mcpServers":[]}),
        )
        .await?;
        let provider_id = result["sessionId"]
            .as_str()
            .ok_or_else(|| AdapterError::Protocol("session/new returned no sessionId".into()))?
            .to_owned();
        *c.session_id.lock().await = Some(provider_id.clone());
        self.sessions
            .lock()
            .await
            .insert(req.session_id.clone(), c.clone());
        let caps = AgentCapabilities {
            resume: c.can_resume.load(Ordering::Relaxed),
            cancel: true,
            permissions: true,
            usage: false,
            files: false,
        };
        Ok(SessionHandle {
            session_id: req.session_id,
            provider_session_id: provider_id,
            capabilities: caps,
        })
    }
    async fn resume_session(
        &self,
        r: &RuntimeSpec,
        req: ResumeSessionRequest,
        events: EventSender,
    ) -> Result<SessionHandle, AdapterError> {
        let c = self
            .spawn(r, &req.project_path, events, &req.session_id)
            .await?;
        let init=Self::request(&c,"initialize",json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"Bloblex","version":"0.1.0"}})).await?;
        if !init["agentCapabilities"]["loadSession"]
            .as_bool()
            .unwrap_or(false)
        {
            return Err(AdapterError::Unsupported(
                "ACP agent did not advertise loadSession".into(),
            ));
        }
        c.can_resume.store(true, Ordering::Relaxed);
        Self::notify(&c, "initialized", json!({})).await?;
        Self::request(
            &c,
            "session/load",
            json!({"sessionId":req.provider_session_id,"cwd":req.project_path,"mcpServers":[]}),
        )
        .await?;
        *c.session_id.lock().await = Some(req.provider_session_id.clone());
        self.sessions.lock().await.insert(req.session_id.clone(), c);
        Ok(SessionHandle {
            session_id: req.session_id,
            provider_session_id: req.provider_session_id,
            capabilities: AgentCapabilities {
                resume: true,
                cancel: true,
                permissions: true,
                usage: false,
                files: false,
            },
        })
    }
    async fn prompt(&self, h: &SessionHandle, req: PromptRequest) -> Result<(), AdapterError> {
        let c = self
            .sessions
            .lock()
            .await
            .get(&h.session_id)
            .cloned()
            .ok_or_else(|| AdapterError::Process("ACP session missing".into()))?;
        c.turn_completed.store(false, Ordering::SeqCst);
        let result = Self::request(
            &c,
            "session/prompt",
            json!({"sessionId":h.provider_session_id,"prompt":[{"type":"text","text":req.text}]}),
        )
        .await?;
        if result["stopReason"].as_str() == Some("cancelled") {
            let _ = c.events.send(AgentEvent::TurnCancelled).await;
        } else {
            let _ = c.events.send(AgentEvent::TurnCompleted).await;
        }
        c.turn_completed.store(true, Ordering::SeqCst);
        Ok(())
    }
    async fn cancel(&self, h: &SessionHandle) -> Result<(), AdapterError> {
        let c = self
            .sessions
            .lock()
            .await
            .get(&h.session_id)
            .cloned()
            .ok_or_else(|| AdapterError::Process("ACP session missing".into()))?;
        let requests = std::mem::take(&mut *c.incoming.lock().await);
        for (key, id) in requests {
            let response =
                json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}});
            let mut bytes =
                serde_json::to_vec(&response).map_err(|e| AdapterError::Protocol(e.to_string()))?;
            bytes.push(b'\n');
            c.stdin
                .lock()
                .await
                .write_all(&bytes)
                .await
                .map_err(|e| AdapterError::Process(e.to_string()))?;
            c.permission_options.lock().await.remove(&key);
        }
        Self::notify(
            &c,
            "session/cancel",
            json!({"sessionId":h.provider_session_id}),
        )
        .await
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
            let mut incoming = c.incoming.lock().await;
            if let Some(rid) = incoming.get(id).cloned() {
                let option = c.pending_permission_options(id).await;
                let option_id = option
                    .iter()
                    .find(|o| {
                        o["kind"].as_str() == Some(choice) || o["optionId"].as_str() == Some(choice)
                    })
                    .and_then(|o| o["optionId"].as_str())
                    .ok_or_else(|| {
                        AdapterError::Unsupported(
                            "permission choice is not supported by ACP agent".into(),
                        )
                    })?;
                let result = json!({"outcome":{"outcome":"selected","optionId":option_id}});
                let msg = json!({"jsonrpc":"2.0","id":rid,"result":result});
                let mut bytes =
                    serde_json::to_vec(&msg).map_err(|e| AdapterError::Protocol(e.to_string()))?;
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
        Err(AdapterError::Unsupported(
            "ACP permission request not found".into(),
        ))
    }
    async fn close_session(&self, h: &SessionHandle) -> Result<(), AdapterError> {
        if let Some(c) = self.sessions.lock().await.remove(&h.session_id) {
            let _ = Self::request(
                &c,
                "session/close",
                json!({"sessionId":h.provider_session_id}),
            )
            .await;
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
        let p = json!({"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}});
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            emit_update(&tx, &p).await;
            assert!(matches!(rx.recv().await, Some(AgentEvent::AssistantDelta { text }) if text == "hello"));
        });
        assert_eq!(id_key(&json!("1")), "1");
        assert_eq!(id_key(&json!(1)), "1");
    }
}
