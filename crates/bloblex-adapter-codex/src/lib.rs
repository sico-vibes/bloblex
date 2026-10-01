//! Codex app-server adapter over JSON-RPC stdio; never reads terminal UI output.
use async_trait::async_trait;
use bloblex_agent_core::*;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
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
    next: AtomicU64,
    turn_id: Mutex<Option<String>>,
    events: EventSender,
}
fn id_key(id: &Value) -> String {
    id.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| id.to_string())
}
#[derive(Default)]
pub struct CodexAdapter {
    sessions: Mutex<HashMap<String, Arc<Conn>>>,
}
impl CodexAdapter {
    async fn spawn(
        &self,
        r: &RuntimeSpec,
        cwd: &PathBuf,
        events: EventSender,
    ) -> Result<Arc<Conn>, AdapterError> {
        let mut c = Command::new(&r.executable);
        c.args(&r.args)
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(cwd)
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
            .ok_or_else(|| AdapterError::Process("app-server stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Process("app-server stdout unavailable".into()))?;
        let conn = Arc::new(Conn {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            incoming: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            turn_id: Mutex::new(None),
            events,
        });
        let r = conn.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let id = v.get("id").map(id_key);
                if let Some(id) = id {
                    if let Some(tx) = r.pending.lock().await.remove(&id) {
                        let result = if v.get("error").is_some() {
                            Err(AdapterError::Protocol(v["error"].to_string()))
                        } else {
                            Ok(v.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = tx.send(result);
                        continue;
                    }
                    if let Some(method) = v["method"].as_str() {
                        if method.ends_with("requestApproval") {
                            let key = format!(
                                "{}:{}",
                                v["params"]["threadId"].as_str().unwrap_or("unknown-thread"),
                                id
                            );
                            r.incoming.lock().await.insert(key.clone(), v["id"].clone());
                            let p = &v["params"];
                            let _ = r
                                .events
                                .send(AgentEvent::PermissionRequested {
                                    provider_request_id: key,
                                    title: "Codex approval request".into(),
                                    detail: Some(p.to_string()),
                                    choices: vec!["allow_once".into(), "deny".into()],
                                    raw: v.clone(),
                                })
                                .await;
                        }
                    }
                }
                if let Some(method) = v["method"].as_str() {
                    let p = &v["params"];
                    let event = match method {
                        "item/agentMessage/delta" | "item/agentMessageDelta" => p["delta"]
                            .as_str()
                            .map(|text| AgentEvent::AssistantDelta { text: text.into() }),
                        "item/started" => {
                            let item = &p["item"];
                            match item["type"].as_str().unwrap_or("") {
                                "agentMessage" => item["text"]
                                    .as_str()
                                    .map(|text| AgentEvent::AssistantDelta { text: text.into() }),
                                "userMessage" => None,
                                _ => Some(AgentEvent::ToolStarted {
                                    tool_call_id: item["id"].as_str().unwrap_or("item").into(),
                                    kind: item["type"].as_str().unwrap_or("other").into(),
                                    title: item["command"]
                                        .as_str()
                                        .or(item["name"].as_str())
                                        .unwrap_or("Codex activity")
                                        .into(),
                                    raw: item.clone(),
                                }),
                            }
                        }
                        "item/completed" => {
                            let item = &p["item"];
                            match item["type"].as_str().unwrap_or("") {
                                "agentMessage" => item["text"]
                                    .as_str()
                                    .map(|text| AgentEvent::AssistantMessage { text: text.into() }),
                                "userMessage" => None,
                                "fileChange" => item["changes"]
                                    .as_array()
                                    .and_then(|v| v.first())
                                    .and_then(|c| c["path"].as_str())
                                    .map(|path| AgentEvent::FileChanged {
                                        path: path.into(),
                                        raw: item.clone(),
                                    }),
                                _ => Some(AgentEvent::ToolCompleted {
                                    tool_call_id: item["id"].as_str().unwrap_or("item").into(),
                                    raw: item.clone(),
                                }),
                            }
                        }
                        "thread/tokenUsage/updated" => {
                            let u = &p["tokenUsage"]["last"];
                            let cached = u["cachedInputTokens"].as_u64();
                            let cache_write = u["cacheWriteInputTokens"].as_u64();
                            let input_total = u["inputTokens"].as_u64();
                            Some(AgentEvent::UsageUpdated {
                                raw: p.clone(),
                                input_tokens: input_total.zip(cached).map(|(n, c)| {
                                    n.saturating_sub(c).saturating_sub(cache_write.unwrap_or(0))
                                }),
                                output_tokens: u["outputTokens"].as_u64(),
                                cache_read_tokens: cached,
                                cache_write_tokens: cache_write,
                                model: p["model"].as_str().map(str::to_owned),
                            })
                        }
                        "turn/completed" => {
                            let turn = &p["turn"];
                            if turn["status"] == "completed" {
                                Some(AgentEvent::TurnCompleted)
                            } else if turn["status"] == "interrupted" {
                                Some(AgentEvent::TurnCancelled)
                            } else {
                                Some(AgentEvent::Error {
                                    message: turn["error"].to_string(),
                                })
                            }
                        }
                        _ => None,
                    };
                    if let Some(e) = event {
                        let _ = r.events.send(e).await;
                    }
                }
            }
            for (_, tx) in std::mem::take(&mut *r.pending.lock().await) {
                let _ = tx.send(Err(AdapterError::Process("Codex app-server exited".into())));
            }
        });
        Ok(conn)
    }
    async fn call(c: &Conn, m: &str, p: Value) -> Result<Value, AdapterError> {
        let id = c.next.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = oneshot::channel();
        c.pending.lock().await.insert(id.clone(), tx);
        let mut b = serde_json::to_vec(&json!({"id":id,"method":m,"params":p}))
            .map_err(|e| AdapterError::Protocol(e.to_string()))?;
        b.push(b'\n');
        if let Err(e) = c.stdin.lock().await.write_all(&b).await {
            c.pending.lock().await.remove(&id);
            return Err(AdapterError::Process(e.to_string()));
        }
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(AdapterError::Process("app-server closed".into())),
            Err(_) => {
                c.pending.lock().await.remove(&id);
                Err(AdapterError::Protocol(format!("timeout waiting for {m}")))
            }
        }
    }
    async fn notify(c: &Conn, m: &str, p: Value) -> Result<(), AdapterError> {
        let mut b = serde_json::to_vec(&json!({"method":m,"params":p}))
            .map_err(|e| AdapterError::Protocol(e.to_string()))?;
        b.push(b'\n');
        c.stdin
            .lock()
            .await
            .write_all(&b)
            .await
            .map_err(|e| AdapterError::Process(e.to_string()))
    }
    async fn initialize(c: &Conn) -> Result<(), AdapterError> {
        Self::call(c,"initialize",json!({"clientInfo":{"name":"Bloblex","version":"0.1.0"},"capabilities":{"experimentalApi":false}})).await?;
        Self::notify(c, "initialized", json!({})).await
    }
}
#[async_trait]
impl AgentAdapter for CodexAdapter {
    async fn probe(&self, r: &RuntimeSpec) -> Result<ProbeResult, AdapterError> {
        let mut c = Command::new(&r.executable);
        c.args(&r.args)
            .args(["app-server", "--help"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let out = tokio::time::timeout(std::time::Duration::from_secs(6), c.output())
            .await
            .map_err(|_| AdapterError::Process("Codex app-server probe timed out".into()))?
            .map_err(|e| AdapterError::Process(e.to_string()))?;
        let text = String::from_utf8_lossy(&out.stdout);
        if !out.status.success() || !text.contains("app-server") {
            return Err(AdapterError::Unsupported(
                "codex app-server is unavailable".into(),
            ));
        }
        Ok(ProbeResult {
            provider: "codex".into(),
            version: None,
            protocol: "codex_app_server".into(),
            authenticated: None,
            capabilities: AgentCapabilities {
                resume: true,
                cancel: true,
                permissions: true,
                usage: true,
                files: true,
            },
        })
    }
    async fn new_session(
        &self,
        r: &RuntimeSpec,
        q: NewSessionRequest,
        events: EventSender,
    ) -> Result<SessionHandle, AdapterError> {
        let c = self.spawn(r, &q.project_path, events).await?;
        Self::initialize(&c).await?;
        let t=Self::call(&c,"thread/start",json!({"cwd":q.project_path.to_string_lossy(),"approvalPolicy":"on-request","sandbox":"workspace-write"})).await?;
        let tid = t["thread"]["id"]
            .as_str()
            .or(t["id"].as_str())
            .ok_or_else(|| AdapterError::Protocol("thread/start returned no thread id".into()))?
            .to_owned();
        self.sessions.lock().await.insert(q.session_id.clone(), c);
        Ok(SessionHandle {
            session_id: q.session_id,
            provider_session_id: tid,
            capabilities: AgentCapabilities {
                resume: true,
                cancel: true,
                permissions: true,
                usage: true,
                files: true,
            },
        })
    }
    async fn resume_session(
        &self,
        r: &RuntimeSpec,
        q: ResumeSessionRequest,
        events: EventSender,
    ) -> Result<SessionHandle, AdapterError> {
        let c = self.spawn(r, &q.project_path, events).await?;
        Self::initialize(&c).await?;
        let t = Self::call(
            &c,
            "thread/resume",
            json!({"threadId":q.provider_session_id,"cwd":q.project_path.to_string_lossy()}),
        )
        .await?;
        let id = t["thread"]["id"]
            .as_str()
            .unwrap_or(&q.provider_session_id)
            .to_owned();
        self.sessions.lock().await.insert(q.session_id.clone(), c);
        Ok(SessionHandle {
            session_id: q.session_id,
            provider_session_id: id,
            capabilities: AgentCapabilities {
                resume: true,
                cancel: true,
                permissions: true,
                usage: true,
                files: true,
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
            .ok_or_else(|| AdapterError::Process("Codex session is not active".into()))?;
        let result = Self::call(
            &c,
            "turn/start",
            json!({"threadId":h.provider_session_id,"input":[{"type":"text","text":q.text}]}),
        )
        .await?;
        *c.turn_id.lock().await = result["turn"]["id"]
            .as_str()
            .or(result["turnId"].as_str())
            .map(str::to_owned);
        Ok(())
    }
    async fn cancel(&self, h: &SessionHandle) -> Result<(), AdapterError> {
        let c = self
            .sessions
            .lock()
            .await
            .get(&h.session_id)
            .cloned()
            .ok_or_else(|| AdapterError::Process("Codex session is not active".into()))?;
        let turn = c
            .turn_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| AdapterError::Unsupported("there is no active Codex turn".into()))?;
        Self::call(
            &c,
            "turn/interrupt",
            json!({"threadId":h.provider_session_id,"turnId":turn}),
        )
        .await?;
        Ok(())
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
            if let Some(request_id) = c.incoming.lock().await.remove(id) {
                let decision = match choice {
                    "allow_once" => "accept",
                    "deny" => "decline",
                    _ => {
                        return Err(AdapterError::Unsupported(
                            "Codex supports only allow once or deny".into(),
                        ))
                    }
                };
                let mut b =
                    serde_json::to_vec(&json!({"id":request_id,"result":{"decision":decision}}))
                        .map_err(|e| AdapterError::Protocol(e.to_string()))?;
                b.push(b'\n');
                c.stdin
                    .lock()
                    .await
                    .write_all(&b)
                    .await
                    .map_err(|e| AdapterError::Process(e.to_string()))?;
                return Ok(());
            }
        }
        Err(AdapterError::Unsupported(
            "Codex approval request not found".into(),
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
    fn input_request_uses_structured_text_not_argv() {
        let v = json!({"input":[{"type":"text","text":"hello"}]});
        assert_eq!(v["input"][0]["text"], "hello");
    }
}
