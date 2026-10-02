//! Codex app-server adapter over JSON-RPC stdio; never reads terminal UI output.
use async_trait::async_trait;
use bloblex_agent_core::*;
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
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

const RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const CATALOG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
struct Conn {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, AdapterError>>>>,
    incoming: Mutex<HashMap<String, Value>>,
    next: AtomicU64,
    turn_id: Mutex<Option<String>>,
    events: EventSender,
    meta: Mutex<ThreadMeta>,
    turn: Mutex<TurnState>,
}
#[derive(Default)]
struct TurnState {
    id: Option<String>,
    options: ExecOptions,
    usage: Option<Value>,
}
#[derive(Clone, Default)]
struct ThreadMeta {
    model: Option<String>,
    tier: Option<String>,
    effort: Option<String>,
    desired_hash: Option<String>,
    baseline_hash: Option<String>,
    first_success_pending: bool,
}
fn id_key(id: &Value) -> String {
    id.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| id.to_string())
}
#[derive(Default)]
pub struct CodexAdapter {
    sessions: Mutex<HashMap<String, Arc<Conn>>>,
    instruction_context: Mutex<HashMap<String, (Option<String>, Option<String>)>>,
    thread_instruction_hashes: Mutex<HashMap<String, Option<String>>>,
}
impl CodexAdapter {
    async fn spawn(
        &self,
        r: &RuntimeSpec,
        cwd: &Path,
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
            meta: Mutex::new(ThreadMeta::default()),
            turn: Mutex::new(TurnState::default()),
        });
        let r = conn.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = v.get("id").map(id_key) {
                    if let Some(tx) = r.pending.lock().await.remove(&id) {
                        let result = if v.get("error").is_some() {
                            Err(AdapterError::Rejected(v["error"].to_string()))
                        } else {
                            let result = v.get("result").cloned().unwrap_or(Value::Null);
                            if let Some(turn_id) =
                                result["turn"]["id"].as_str().or(result["turnId"].as_str())
                            {
                                r.turn.lock().await.id = Some(turn_id.to_owned());
                            }
                            Ok(result)
                        };
                        let _ = tx.send(result);
                        continue;
                    }
                    if v["method"]
                        .as_str()
                        .is_some_and(|m| m.ends_with("requestApproval"))
                    {
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
                if let Some(method) = v["method"].as_str() {
                    let p = &v["params"];
                    let expected = r.turn.lock().await.id.clone();
                    match method {
                        "thread/tokenUsage/updated"
                            if expected.as_deref() == p["turnId"].as_str() =>
                        {
                            r.turn.lock().await.usage = Some(p["tokenUsage"]["last"].clone());
                        }
                        "turn/completed" if expected.as_deref() == p["turn"]["id"].as_str() => {
                            let status = p["turn"]["status"].as_str().unwrap_or("");
                            let success = status == "completed";
                            let failed = !success;
                            let (options, usage) = {
                                let mut t = r.turn.lock().await;
                                (t.options.clone(), t.usage.take())
                            };
                            let turn_id = r.turn_id.lock().await.clone().unwrap_or_default();
                            let meta = r.meta.lock().await.clone();
                            let report = usage_report(usage.as_ref(), meta.model.clone(), !failed);
                            let _ = r
                                .events
                                .send(AgentEvent::UsageReport {
                                    turn_id: turn_id.clone(),
                                    report,
                                })
                                .await;
                            if success {
                                let outcomes =
                                    outcomes_for_success(&meta, &options, usage.as_ref());
                                if !outcomes.is_empty() {
                                    let _ = r
                                        .events
                                        .send(AgentEvent::ExecApplied { turn_id, outcomes })
                                        .await;
                                }
                                r.meta.lock().await.first_success_pending = false;
                                let _ = r.events.send(AgentEvent::TurnCompleted).await;
                            } else if status == "interrupted" {
                                let _ = r.events.send(AgentEvent::TurnCancelled).await;
                            } else {
                                let _ = r
                                    .events
                                    .send(AgentEvent::Error {
                                        message: p["turn"]["error"].to_string(),
                                    })
                                    .await;
                            }
                        }
                        _ => {
                            if let Some(e) = map_notification(method, p) {
                                let _ = r.events.send(e).await;
                            }
                        }
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
        let mut b = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":m,"params":p}))
            .map_err(|e| AdapterError::Protocol(e.to_string()))?;
        b.push(b'\n');
        if let Err(e) = c.stdin.lock().await.write_all(&b).await {
            c.pending.lock().await.remove(&id);
            return Err(AdapterError::Process(e.to_string()));
        }
        match tokio::time::timeout(RPC_TIMEOUT, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => Err(AdapterError::Process("app-server closed".into())),
            Err(_) => {
                c.pending.lock().await.remove(&id);
                Err(AdapterError::Protocol(format!("timeout waiting for {m}")))
            }
        }
    }
    async fn notify(c: &Conn, m: &str, p: Value) -> Result<(), AdapterError> {
        let mut b = serde_json::to_vec(&json!({"jsonrpc":"2.0","method":m,"params":p}))
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
        Self::call(c,"initialize",json!({"clientInfo":{"name":"Bloblex","version":"0.1.0"},"capabilities":{"experimentalApi":false}})).await.map_err(|e| match e { AdapterError::Rejected(message) => AdapterError::Protocol(message), other => other })?;
        Self::notify(c, "initialized", json!({})).await
    }
    async fn startup_call(c: &Conn, method: &str, params: Value) -> Result<Value, AdapterError> {
        let result = match Self::initialize(c).await {
            Ok(()) => Self::call(c, method, params).await,
            Err(e) => Err(e),
        };
        if result.is_err() {
            let _ = c.child.lock().await.kill().await;
        }
        result
    }
    fn start_params(cwd: &Path, options: &ExecOptions) -> Value {
        let (approval,sandbox)=if options.approval_mode==bloblex_agent_core::ApprovalMode::Bypass {("never","danger-full-access")}else{("on-request","workspace-write")};
        let mut p = json!({"cwd":cwd.to_string_lossy(),"approvalPolicy":approval,"sandbox":sandbox});
        if let Some(v) = &options.model {
            p["model"] = json!(v)
        }
        if let Some(v) = options
            .service_tier
            .as_ref()
            .filter(|v| v.as_str() != "standard" && v.as_str() != "fast")
        {
            p["serviceTier"] = json!(v)
        }
        if let Some(v) = &options.instructions {
            p["developerInstructions"] = json!(v)
        }
        p
    }
    fn resume_params(id: &str, cwd: &Path, options: &ExecOptions) -> Value {
        let (approval,sandbox)=if options.approval_mode==ApprovalMode::Bypass {("never","danger-full-access")}else{("on-request","workspace-write")};
        let mut p = json!({"threadId":id,"cwd":cwd.to_string_lossy(),"approvalPolicy":approval,"sandbox":sandbox});
        if let Some(v) = &options.model {
            p["model"] = json!(v)
        }
        if let Some(v) = options
            .service_tier
            .as_ref()
            .filter(|v| v.as_str() != "standard" && v.as_str() != "fast")
        {
            p["serviceTier"] = json!(v)
        }
        p
    }
    async fn set_thread_meta(
        c: &Conn,
        t: &Value,
        hash: Option<String>,
        baseline: Option<String>,
        first_success_pending: bool,
    ) {
        *c.meta.lock().await = ThreadMeta {
            model: t["model"].as_str().map(str::to_owned),
            tier: t["serviceTier"].as_str().map(str::to_owned),
            effort: t["reasoningEffort"].as_str().map(str::to_owned),
            desired_hash: hash,
            baseline_hash: baseline,
            first_success_pending,
        };
    }
}

fn map_notification(method: &str, p: &Value) -> Option<AgentEvent> {
    match method {
        "item/agentMessage/delta" | "item/agentMessageDelta" => p["delta"]
            .as_str()
            .map(|text| AgentEvent::AssistantDelta { text: text.into() }),
        "item/started" => {
            let i = &p["item"];
            match i["type"].as_str().unwrap_or("") {
                "agentMessage" => i["text"]
                    .as_str()
                    .map(|text| AgentEvent::AssistantDelta { text: text.into() }),
                "userMessage" => None,
                _ => Some(AgentEvent::ToolStarted {
                    tool_call_id: i["id"].as_str().unwrap_or("item").into(),
                    kind: i["type"].as_str().unwrap_or("other").into(),
                    title: i["command"]
                        .as_str()
                        .or(i["name"].as_str())
                        .unwrap_or("Codex activity")
                        .into(),
                    raw: i.clone(),
                }),
            }
        }
        "item/completed" => {
            let i = &p["item"];
            match i["type"].as_str().unwrap_or("") {
                "agentMessage" => i["text"]
                    .as_str()
                    .map(|text| AgentEvent::AssistantMessage { text: text.into() }),
                "userMessage" => None,
                "fileChange" => i["changes"]
                    .as_array()
                    .and_then(|v| v.first())
                    .and_then(|c| c["path"].as_str())
                    .map(|path| AgentEvent::FileChanged {
                        path: path.into(),
                        raw: i.clone(),
                    }),
                _ => Some(AgentEvent::ToolCompleted {
                    tool_call_id: i["id"].as_str().unwrap_or("item").into(),
                    raw: i.clone(),
                }),
            }
        }
        _ => None,
    }
}
fn outcomes_for_success(
    meta: &ThreadMeta,
    o: &ExecOptions,
    usage: Option<&Value>,
) -> std::collections::BTreeMap<String, SettingOutcome> {
    let mut m = std::collections::BTreeMap::new();
    if let Some(req) = &o.model {
        m.insert(
            "model".into(),
            outcome(
                json!(req),
                meta.model.as_ref().map(|v| v == req),
                EvidenceKind::ProviderEcho,
                meta.model.as_ref().map(|v| json!(v)),
                None,
            ),
        );
    }
    if let Some(req) = &o.service_tier {
        m.insert(
            "serviceTier".into(),
            outcome(
                json!(req),
                meta.tier.as_ref().map(|v| v == req),
                EvidenceKind::ProviderEcho,
                meta.tier.as_ref().map(|v| json!(v)),
                None,
            ),
        );
    }
    if let Some(req) = &o.thinking {
        let n = usage.and_then(|v| v["reasoningOutputTokens"].as_u64());
        m.insert(
            "thinking".into(),
            outcome(
                json!(req),
                Some(true),
                if n.is_some() {
                    EvidenceKind::UsageEffect
                } else {
                    EvidenceKind::SuccessfulTurn
                },
                n.map(|v| json!(v))
                    .or_else(|| meta.effort.as_ref().map(|v| json!(v))),
                None,
            ),
        );
    }
    if meta.first_success_pending {
        if let Some(hash) = meta
            .desired_hash
            .as_ref()
            .filter(|hash| meta.baseline_hash.as_ref() == Some(*hash))
        {
            m.insert(
                "instructions".into(),
                outcome(
                    json!(hash),
                    Some(true),
                    EvidenceKind::SuccessfulTurn,
                    Some(json!(hash)),
                    None,
                ),
            );
        }
    }
    m
}
fn outcome(
    requested: Value,
    applied: Option<bool>,
    kind: EvidenceKind,
    value: Option<Value>,
    reason: Option<String>,
) -> SettingOutcome {
    SettingOutcome {
        requested: Some(requested),
        applied,
        evidence_kind: kind,
        evidence_value: value,
        reason,
    }
}
fn usage_report(last: Option<&Value>, model: Option<String>, success: bool) -> UsageReport {
    if !success {
        return UsageReport {
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            reasoning_tokens: None,
            usage_status: "unreported".into(),
            evidence_note: None,
            provider_update_id: None,
            context_used: None,
            context_size: None,
            model: None,
            cost_minor: None,
            cost_currency: None,
            reported_cost_decimal: None,
            cost_is_cumulative: false,
        };
    }
    let u = last.cloned().unwrap_or(Value::Null);
    let input = u["inputTokens"].as_u64();
    let cached = u["cachedInputTokens"].as_u64();
    let write = u["cacheWriteInputTokens"].as_u64();
    let adjusted = input
        .zip(cached)
        .zip(write)
        .and_then(|((i, c), w)| i.checked_sub(c)?.checked_sub(w));
    let note = if adjusted.is_none() && (input.is_some() || cached.is_some() || write.is_some()) {
        Some("inputTokens retained as reported because cache buckets were incomplete or exceeded the reported input".into())
    } else {
        None
    };
    UsageReport {
        input_tokens: adjusted.or(input),
        output_tokens: u["outputTokens"].as_u64(),
        cache_read_tokens: cached,
        cache_write_tokens: write,
        reasoning_tokens: u["reasoningOutputTokens"].as_u64(),
        usage_status: if last.is_some() {
            "reported"
        } else {
            "unreported"
        }
        .into(),
        evidence_note: note,
        provider_update_id: None,
        context_used: None,
        context_size: None,
        model,
        cost_minor: None,
        cost_currency: None,
        reported_cost_decimal: None,
        cost_is_cumulative: false,
    }
}
fn parse_catalog_model(m: &Value) -> Result<ModelInfo, AdapterError> {
    let id = m["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AdapterError::Protocol("Codex catalog model id missing".into()))?;
    let efforts = m["supportedReasoningEfforts"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v["reasoningEffort"].as_str().map(str::to_owned))
        .collect();
    let service_tiers = m["serviceTiers"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| {
            Some(ServiceTier {
                id: v["id"].as_str()?.into(),
                name: v["name"].as_str().unwrap_or(v["id"].as_str()?).into(),
            })
        })
        .collect();
    Ok(ModelInfo {
        id: id.into(),
        display_name: m["displayName"].as_str().unwrap_or(id).into(),
        provider_id: None,
        supported_thinking: efforts,
        default_thinking: m["defaultReasoningEffort"].as_str().map(str::to_owned),
        service_tiers,
        default_service_tier: m["defaultServiceTier"].as_str().map(str::to_owned),
        variants: None,
        host_dependent: true,
    })
}
async fn read_reply(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
) -> Result<Value, AdapterError> {
    loop {
        let line = tokio::time::timeout(CATALOG_TIMEOUT, lines.next_line())
            .await
            .map_err(|_| AdapterError::Process("Codex model catalog timed out".into()))?
            .map_err(|e| AdapterError::Process(e.to_string()))?
            .ok_or_else(|| AdapterError::Process("Codex app-server catalog exited".into()))?;
        let v: Value = serde_json::from_str(&line)
            .map_err(|_| AdapterError::Protocol("Codex catalog returned malformed JSON".into()))?;
        if v["id"].as_u64() == Some(id) {
            if v.get("error").is_some() {
                return Err(AdapterError::Protocol(
                    "Codex model catalog request failed".into(),
                ));
            }
            return Ok(v["result"].clone());
        }
    }
}
async fn write_rpc(
    stdin: &mut tokio::process::ChildStdin,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), AdapterError> {
    let mut b =
        serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .map_err(|e| AdapterError::Protocol(e.to_string()))?;
    b.push(b'\n');
    stdin
        .write_all(&b)
        .await
        .map_err(|e| AdapterError::Process(e.to_string()))
}
async fn catalog_pages(r: &RuntimeSpec) -> Result<Vec<Value>, AdapterError> {
    let mut cmd = Command::new(&r.executable);
    cmd.args(&r.args)
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(cwd) = &r.cwd {
        cmd.current_dir(cwd);
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| AdapterError::Process("Codex app-server catalog could not start".into()))?;
    let result = async {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| AdapterError::Process("catalog stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Process("catalog stdout unavailable".into()))?;
        let mut lines = BufReader::new(stdout).lines();
        write_rpc(&mut stdin,1,"initialize",json!({"clientInfo":{"name":"Bloblex","version":"0.1.0"},"capabilities":{"experimentalApi":false}})).await?;
        let _ = read_reply(&mut lines, 1).await?;
        let mut b =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","method":"initialized","params":{}}))
                .unwrap();
        b.push(b'\n');
        stdin
            .write_all(&b)
            .await
            .map_err(|e| AdapterError::Process(e.to_string()))?;
        let mut cursor = Value::Null;
        let mut seen = std::collections::HashSet::new();
        let mut pages = Vec::new();
        let mut id = 1;
        loop {
            id += 1;
            write_rpc(
                &mut stdin,
                id,
                "model/list",
                json!({"cursor":cursor,"includeHidden":false,"limit":100}),
            )
            .await?;
            let page = read_reply(&mut lines, id).await?;
            let next = page["nextCursor"].clone();
            pages.push(page);
            if next.is_null() {
                break;
            }
            if !seen.insert(next.to_string()) {
                return Err(AdapterError::Protocol(
                    "Codex model catalog cursor repeated".into(),
                ));
            }
            cursor = next;
        }
        Ok(pages)
    };
    let result = tokio::time::timeout(CATALOG_TIMEOUT, result)
        .await
        .map_err(|_| AdapterError::Process("Codex model catalog timed out".into()))
        .and_then(|v| v);
    let _ = child.kill().await;
    result
}

#[async_trait]
impl AgentAdapter for CodexAdapter {
    async fn model_catalog(&self, r: &RuntimeSpec) -> Result<ModelCatalog, AdapterError> {
        let pages = catalog_pages(r).await?;
        let mut models = Vec::new();
        for page in pages {
            let data = page["data"].as_array().ok_or_else(|| {
                AdapterError::Protocol("Codex model catalog page missing data".into())
            })?;
            for item in data {
                models.push(parse_catalog_model(item)?)
            }
        }
        let now = Utc::now();
        Ok(ModelCatalog {
            models,
            fetched_at: now.to_rfc3339(),
            expires_at: (now + Duration::seconds(60)).to_rfc3339(),
            fallback: false,
            source: "app_server".into(),
        })
    }
    async fn preflight_exec_options(&self, options: &ExecOptions) -> Result<(), AdapterError> {
        if options.service_tier.as_deref() == Some("fast") {
            return Err(AdapterError::Unsupported(
                "Codex speed selection must use a catalog tier id".into(),
            ));
        }
        Ok(())
    }
    async fn set_instruction_hash_context(
        &self,
        sid: &str,
        desired: Option<String>,
        baseline: Option<String>,
    ) {
        self.instruction_context
            .lock()
            .await
            .insert(sid.into(), (desired, baseline));
    }
    async fn probe(&self, r: &RuntimeSpec) -> Result<ProbeResult, AdapterError> {
        let mut c = Command::new(&r.executable);
        c.args(&r.args)
            .args(["app-server", "--help"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let o = tokio::time::timeout(std::time::Duration::from_secs(6), c.output())
            .await
            .map_err(|_| AdapterError::Process("Codex app-server probe timed out".into()))?
            .map_err(|e| AdapterError::Process(e.to_string()))?;
        if !o.status.success() || !String::from_utf8_lossy(&o.stdout).contains("app-server") {
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
        let t = Self::startup_call(
            &c,
            "thread/start",
            Self::start_params(&q.project_path, &q.exec_options),
        )
        .await?;
        let Some(tid) = t["thread"]["id"]
            .as_str()
            .or(t["id"].as_str())
            .map(str::to_owned)
        else {
            let _ = c.child.lock().await.kill().await;
            return Err(AdapterError::Protocol(
                "thread/start returned no thread id".into(),
            ));
        };
        let hash = instruction_sha256(q.exec_options.instructions.as_deref().unwrap_or(""));
        Self::set_thread_meta(&c, &t, hash.clone(), hash.clone(), true).await;
        self.thread_instruction_hashes
            .lock()
            .await
            .insert(q.session_id.clone(), hash);
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
        let t = Self::startup_call(
            &c,
            "thread/resume",
            Self::resume_params(&q.provider_session_id, &q.project_path, &q.exec_options),
        )
        .await?;
        let id = t["thread"]["id"]
            .as_str()
            .unwrap_or(&q.provider_session_id)
            .to_owned();
        let (desired, baseline) = self
            .instruction_context
            .lock()
            .await
            .get(&q.session_id)
            .cloned()
            .unwrap_or((
                instruction_sha256(q.exec_options.instructions.as_deref().unwrap_or("")),
                None,
            ));
        let installed = self
            .thread_instruction_hashes
            .lock()
            .await
            .get(&q.session_id)
            .cloned()
            .flatten()
            .or_else(|| baseline.clone())
            .or_else(|| desired.clone());
        Self::set_thread_meta(&c, &t, desired, installed, baseline.is_none()).await;
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
        let requested_hash =
            instruction_sha256(q.exec_options.instructions.as_deref().unwrap_or(""));
        let mut meta = c.meta.lock().await.clone();
        let changed = requested_hash != meta.baseline_hash;
        meta.desired_hash = requested_hash.clone();
        *c.meta.lock().await = meta.clone();
        if changed {
            let mut m = std::collections::BTreeMap::new();
            m.insert(
                "instructions".into(),
                outcome(
                    json!(requested_hash),
                    Some(false),
                    EvidenceKind::None,
                    None,
                    Some("instructions_change_requires_new_thread".into()),
                ),
            );
            let _ = c
                .events
                .send(AgentEvent::ExecApplied {
                    turn_id: q.turn_id.clone(),
                    outcomes: m,
                })
                .await;
        }
        let mut p =
            json!({"threadId":h.provider_session_id,"input":[{"type":"text","text":q.text}]});
        if let Some(v) = &q.exec_options.model {
            p["model"] = json!(v)
        }
        if let Some(v) = &q.exec_options.thinking {
            p["effort"] = json!(v)
        }
        if let Some(v) = q.exec_options.service_tier.as_ref() {
            if v == "standard" {
                p["serviceTierForTurn"] = json!("default")
            } else if v != "fast" {
                p["serviceTier"] = json!(v)
            }
        }
        let request_options = q.exec_options.clone();
        *c.turn.lock().await = TurnState {
            id: None,
            options: q.exec_options,
            usage: None,
        };
        *c.turn_id.lock().await = Some(q.turn_id);
        let result = match Self::call(&c, "turn/start", p).await {
            Ok(result) => result,
            Err(error) => {
                let mut rejected = std::collections::BTreeMap::new();
                for (key, value) in [
                    ("model", request_options.model.as_ref()),
                    ("thinking", request_options.thinking.as_ref()),
                    ("serviceTier", request_options.service_tier.as_ref()),
                ] {
                    if let Some(value) = value {
                        rejected.insert(
                            key.into(),
                            outcome(
                                json!(value),
                                Some(false),
                                EvidenceKind::None,
                                None,
                                Some("provider_rejected_before_turn".into()),
                            ),
                        );
                    }
                }
                if !rejected.is_empty() {
                    let _ = c
                        .events
                        .send(AgentEvent::ExecApplied {
                            turn_id: c.turn_id.lock().await.clone().unwrap_or_default(),
                            outcomes: rejected,
                        })
                        .await;
                }
                return Err(error);
            }
        };
        let id = result["turn"]["id"]
            .as_str()
            .or(result["turnId"].as_str())
            .ok_or_else(|| AdapterError::Protocol("turn/start returned no turn id".into()))?
            .to_owned();
        c.turn.lock().await.id = Some(id);
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
        let t = c
            .turn
            .lock()
            .await
            .id
            .clone()
            .ok_or_else(|| AdapterError::Unsupported("there is no active Codex turn".into()))?;
        Self::call(
            &c,
            "turn/interrupt",
            json!({"threadId":h.provider_session_id,"turnId":t}),
        )
        .await?;
        Ok(())
    }
    async fn reply_permission(&self, id: &str, choice: &str) -> Result<(), AdapterError> {
        for c in self
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>()
        {
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
                let mut b = serde_json::to_vec(
                    &json!({"jsonrpc":"2.0","id":request_id,"result":{"decision":decision}}),
                )
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
    #[test] fn approval_policy_and_sandbox_are_typed_and_bypass_only_for_bypass(){let cwd=Path::new("C:/project");let start=CodexAdapter::start_params(cwd,&ExecOptions::default());assert_eq!(start["approvalPolicy"],"on-request");assert_eq!(start["sandbox"],"workspace-write");let auto=CodexAdapter::start_params(cwd,&ExecOptions{approval_mode:ApprovalMode::Auto,..ExecOptions::default()});assert_eq!(auto["approvalPolicy"],"on-request");assert_eq!(auto["sandbox"],"workspace-write");let bypass=ExecOptions{approval_mode:ApprovalMode::Bypass,..ExecOptions::default()};let start=CodexAdapter::start_params(cwd,&bypass);assert_eq!(start["approvalPolicy"],"never");assert_eq!(start["sandbox"],"danger-full-access");let resume=CodexAdapter::resume_params("thread",cwd,&bypass);assert_eq!(resume["approvalPolicy"],"never");assert_eq!(resume["sandbox"],"danger-full-access");}
    #[test]
    fn usage_subtraction_is_validated_and_keeps_reported_fallback() {
        let a = usage_report(
            Some(
                &json!({"inputTokens":10,"cachedInputTokens":3,"cacheWriteInputTokens":2,"outputTokens":4,"reasoningOutputTokens":1}),
            ),
            Some("m".into()),
            true,
        );
        assert_eq!(a.input_tokens, Some(5));
        assert_eq!(a.reasoning_tokens, Some(1));
        let b = usage_report(
            Some(&json!({"inputTokens":2,"cachedInputTokens":3,"cacheWriteInputTokens":1})),
            None,
            true,
        );
        assert_eq!(b.input_tokens, Some(2));
        assert!(b.evidence_note.is_some());
        let c = usage_report(
            Some(&json!({"inputTokens":4,"cachedInputTokens":1})),
            None,
            true,
        );
        assert_eq!(c.input_tokens, Some(4));
        assert!(c.evidence_note.is_some());
        let d = usage_report(None, None, true);
        assert_eq!(d.input_tokens, None);
        let e = usage_report(Some(&json!({"cachedInputTokens":2})), None, true);
        assert_eq!(e.input_tokens, None);
        assert!(e.evidence_note.is_some());
        let c = usage_report(None, None, false);
        assert_eq!(c.usage_status, "unreported");
        assert_eq!(c.input_tokens, None);
    }
    #[test]
    fn catalog_models_normalize_tiers_and_efforts() {
        let m=parse_catalog_model(&json!({"id":"m","displayName":"Model","supportedReasoningEfforts":[{"reasoningEffort":"low"}],"defaultReasoningEffort":"low","serviceTiers":[{"id":"priority","name":"Fast"}]})).unwrap();
        assert_eq!(m.supported_thinking, vec!["low"]);
        assert_eq!(m.service_tiers[0].id, "priority");
        assert!(m.host_dependent);
    }
    #[test]
    fn standard_speed_never_becomes_a_tier_id() {
        let o = ExecOptions {
            service_tier: Some("standard".into()),
            ..ExecOptions::default()
        };
        assert_eq!(o.service_tier.as_deref(), Some("standard"));
        let p = CodexAdapter::resume_params("thread", Path::new("."), &o);
        assert!(p.get("serviceTier").is_none());
    }
}
