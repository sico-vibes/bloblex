//! Claude Code's documented print/stream-json mode, never interactive TUI scraping.
use async_trait::async_trait;
use bloblex_agent_core::*;
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

struct Conn {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    events: EventSender,
    provider_id: Mutex<Option<String>>,
    active_turn: AtomicBool,
    cancellation_requested: AtomicBool,
    permission_requests: Mutex<HashMap<String, (Value, Value)>>,
    local_session_id: String,
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
            let _ = tx
                .send(AgentEvent::UsageUpdated {
                    raw: v.clone(),
                    input_tokens: u["input_tokens"].as_u64(),
                    output_tokens: u["output_tokens"].as_u64(),
                    cache_read_tokens: u["cache_read_input_tokens"].as_u64(),
                    cache_write_tokens: u["cache_creation_input_tokens"].as_u64(),
                    model: v["model"].as_str().map(str::to_owned),
                })
                .await;
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
        let mut child = c
            .spawn()
            .map_err(|e| AdapterError::Process(e.to_string()))?;
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
        });
        let reader = conn.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if v["type"].as_str() == Some("result") {
                        reader.active_turn.store(false, Ordering::SeqCst);
                    }
                    parse_line(
                        &reader.events,
                        &v,
                        &reader.provider_id,
                        &reader.permission_requests,
                        &reader.local_session_id,
                    )
                    .await;
                }
            }
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
            .start(r, &q.project_path, None, events, &q.session_id)
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
        let c = self
            .sessions
            .lock()
            .await
            .get(&h.session_id)
            .cloned()
            .ok_or_else(|| AdapterError::Process("Claude session not active".into()))?;
        let bytes =
            serde_json::to_vec(&json!({"type":"user","message":{"role":"user","content":q.text}}))
                .map_err(|e| AdapterError::Protocol(e.to_string()))?;
        c.cancellation_requested.store(false, Ordering::SeqCst);
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
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            parse_line(&tx, &v, &provider_id, &requests, "local-session").await;
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
}
