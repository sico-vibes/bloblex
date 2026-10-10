use async_trait::async_trait;
use bloblex_agent_core::*;
use bloblex_process::{prepare_command, ProcessTree, StdinWriter};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex as StdMutex, Weak,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::{oneshot, Mutex},
};

mod catalog;
mod exec;
mod sha256;

#[doc(hidden)]
pub use sha256::sha256_hex;

struct Conn {
    process: Arc<SharedProcess>,
    process_key: String,
    detached: AtomicBool,
    runtime: RuntimeSpec,
    cwd: std::path::PathBuf,
    base_options: ExecOptions,
    incoming: Mutex<HashMap<String, Value>>,
    permission_options: Mutex<HashMap<String, Vec<Value>>>,
    session_id: Mutex<Option<String>>,
    can_resume: AtomicBool,
    turn_completed: AtomicBool,
    active_turn_id: Mutex<Option<String>>,
    cancelled_turn: AtomicBool,
    turn_lifecycle: Mutex<()>,
    local_session_id: String,
    events: SessionEventSink,
    spawned_instructions: Option<String>,
    spawned_env: BTreeMap<String, String>,
    config_options: Mutex<Vec<Value>>,
    default_mode: Mutex<Option<String>>,
    applied: Mutex<exec::Echoes>,
    usage: Mutex<exec::UsageSnap>,
    usage_seq: AtomicU64,
}

struct SharedProcess {
    stdin: Mutex<StdinWriter>,
    child: Mutex<Child>,
    process_tree: ProcessTree,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, AdapterError>>>>,
    next: AtomicU64,
    routes: Mutex<HashMap<String, Weak<Conn>>>,
    active_turns: Mutex<std::collections::HashSet<String>>,
    active_sessions: AtomicUsize,
    initialized: AtomicBool,
    load_session: AtomicBool,
    setup: Mutex<()>,
    alive: AtomicBool,
    shutdown_started: AtomicBool,
    intentional_shutdown: AtomicBool,
}

#[derive(Clone)]
struct SessionEventSink(Arc<SessionForwardQueue>);

struct SessionForwardQueue {
    events: StdMutex<VecDeque<QueuedEvent>>,
    notify: tokio::sync::Notify,
    closed: AtomicBool,
}

struct QueuedEvent {
    event: AgentEvent,
    delivered: Option<oneshot::Sender<()>>,
}

impl SessionEventSink {
    fn new(target: EventSender) -> Self {
        let queue = Arc::new(SessionForwardQueue {
            events: StdMutex::new(VecDeque::new()),
            notify: tokio::sync::Notify::new(),
            closed: AtomicBool::new(false),
        });
        let reader = Arc::clone(&queue);
        tokio::spawn(async move {
            loop {
                let notified = reader.notify.notified();
                let item = reader.events.lock().unwrap().pop_front();
                let Some(item) = item else { notified.await; continue; };
                if target.send(item.event).await.is_err() {
                    let mut queue = reader.events.lock().unwrap();
                    reader.closed.store(true, Ordering::Release);
                    queue.clear();
                    break;
                }
                if let Some(ack) = item.delivered { let _ = ack.send(()); }
            }
        });
        Self(queue)
    }

    async fn send(&self, event: AgentEvent) -> Result<(), ()> {
        let (ack, delivered) = oneshot::channel();
        {
            let mut queue = self.0.events.lock().unwrap();
            if self.0.closed.load(Ordering::Acquire) { return Err(()); }
            queue.push_back(QueuedEvent { event, delivered: Some(ack) });
        }
        self.0.notify.notify_one();
        delivered.await.map_err(|_| ())
    }

    fn enqueue(&self, mut event: AgentEvent) -> Result<(), ()> {
        let mut queue = self.0.events.lock().unwrap();
        if self.0.closed.load(Ordering::Acquire) { return Err(()); }
        // Coalesce only stream updates; every other event is retained in order, even above the cap.
        if queue.len() >= SESSION_FORWARD_QUEUE_COALESCE_CAP {
            if is_stream_event(&event) {
                for pending in queue.iter_mut().rev() {
                    if pending.delivered.is_some() || !is_stream_event(&pending.event) { break; }
                    match merge_stream_event(&mut pending.event, event) {
                        Ok(()) => {
                            drop(queue);
                            self.0.notify.notify_one();
                            return Ok(());
                        }
                        Err(unmatched) => event = unmatched,
                    }
                }
            }
        }
        queue.push_back(QueuedEvent { event, delivered: None });
        drop(queue);
        self.0.notify.notify_one();
        Ok(())
    }
}

const SHARED_PROCESS_IDLE_SHUTDOWN: Duration = Duration::from_secs(30);
const SESSION_FORWARD_QUEUE_COALESCE_CAP: usize = 128;

fn is_stream_event(event: &AgentEvent) -> bool {
    matches!(event, AgentEvent::AssistantDelta { .. } | AgentEvent::ThinkingDelta { .. } | AgentEvent::ToolUpdated { .. })
}

fn merge_stream_event(previous: &mut AgentEvent, incoming: AgentEvent) -> Result<(), AgentEvent> {
    match (previous, incoming) {
        (AgentEvent::AssistantDelta { text: left }, AgentEvent::AssistantDelta { text: right })
        | (AgentEvent::ThinkingDelta { text: left }, AgentEvent::ThinkingDelta { text: right }) => {
            left.push_str(&right);
            Ok(())
        }
        (
            AgentEvent::ToolUpdated { tool_call_id: left_id, raw: left },
            AgentEvent::ToolUpdated { tool_call_id: right_id, raw: right },
        ) if *left_id == right_id => {
            *left = right;
            Ok(())
        }
        (_, incoming) => Err(incoming),
    }
}

#[derive(Default)]
pub struct AcpAdapter {
    sessions: Mutex<HashMap<String, Arc<Conn>>>,
    processes: Arc<Mutex<HashMap<String, Arc<SharedProcess>>>>,
    start_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// Zero keeps the 20s catalog bound. Tests set a shorter bound.
    catalog_timeout_ms: AtomicU64,
    idle_shutdown_ms: AtomicU64,
}

impl AcpAdapter {
    async fn process_gate(&self, key: &str) -> Arc<Mutex<()>> {
        let mut locks = self.start_locks.lock().await;
        locks.entry(key.to_owned()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    }

    async fn acquire_process(
        &self,
        key: &str,
        runtime: &RuntimeSpec,
        cwd: &Path,
        options: &ExecOptions,
    ) -> Result<Arc<SharedProcess>, AdapterError> {
        let gate = self.process_gate(key).await;
        let _gate = gate.lock().await;
        {
            let processes = self.processes.lock().await;
            if let Some(process) = processes.get(key).filter(|process| process.alive.load(Ordering::Acquire)) {
                process.active_sessions.fetch_add(1, Ordering::AcqRel);
                return Ok(process.clone());
            }
        }
        let process = Self::spawn_process(runtime, cwd, options).await?;
        {
            let mut processes = self.processes.lock().await;
            process.active_sessions.store(1, Ordering::Release);
            processes.insert(key.to_owned(), process.clone());
        }
        Ok(process)
    }

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
        let config = exec::config_content(options);
        let inherited = std::env::vars_os()
            .map(|(key, value)| format!("{key:?}={value:?}\n"))
            .collect::<String>();
        let key_data = json!({
            "runtime": runtime.runtime_id,
            "executable": runtime.executable,
            "args": runtime.args,
            "cwd": cwd,
            "env": options.env,
            "config": config,
            "inheritedEnvironment": sha256_hex(inherited.as_bytes()),
        });
        let key = sha256_hex(key_data.to_string().as_bytes());
        let process = self.acquire_process(&key, runtime, cwd, options).await?;
        let secret = exec::normalize_instructions(&options.instructions);
        Ok(Arc::new(Conn {
            process,
            process_key: key,
            detached: AtomicBool::new(false),
            runtime: runtime.clone(),
            cwd: cwd.to_path_buf(),
            base_options: options.clone(),
            incoming: Mutex::new(HashMap::new()),
            permission_options: Mutex::new(HashMap::new()),
            session_id: Mutex::new(None),
            can_resume: AtomicBool::new(false),
            turn_completed: AtomicBool::new(false),
            active_turn_id: Mutex::new(None),
            cancelled_turn: AtomicBool::new(false),
            turn_lifecycle: Mutex::new(()),
            local_session_id: local_session_id.to_owned(),
            events: SessionEventSink::new(events),
            spawned_instructions: secret,
            spawned_env: options.env.clone(),
            config_options: Mutex::new(Vec::new()),
            default_mode: Mutex::new(None),
            applied: Mutex::new(exec::Echoes::default()),
            usage: Mutex::new(exec::UsageSnap::default()),
            usage_seq: AtomicU64::new(0),
        }))
    }

    #[doc(hidden)]
    pub fn with_idle_shutdown(timeout: Duration) -> Self {
        let adapter = Self::default();
        adapter.idle_shutdown_ms.store(timeout.as_millis().max(1) as u64, Ordering::Relaxed);
        adapter
    }

    fn idle_shutdown(&self) -> Duration {
        let millis = self.idle_shutdown_ms.load(Ordering::Relaxed);
        if millis == 0 { SHARED_PROCESS_IDLE_SHUTDOWN } else { Duration::from_millis(millis) }
    }

    async fn spawn_process(
        runtime: &RuntimeSpec,
        cwd: &Path,
        options: &ExecOptions,
    ) -> Result<Arc<SharedProcess>, AdapterError> {
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
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut remaining = 8192usize;
            while remaining > 0 {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        remaining = remaining.saturating_sub(line.len());
                    }
                    _ => break,
                }
            }
        });
        let process = Arc::new(SharedProcess {
            stdin: Mutex::new(StdinWriter::new(stdin)),
            child: Mutex::new(child),
            process_tree,
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            routes: Mutex::new(HashMap::new()),
            active_turns: Mutex::new(std::collections::HashSet::new()),
            active_sessions: AtomicUsize::new(0),
            initialized: AtomicBool::new(false),
            load_session: AtomicBool::new(false),
            setup: Mutex::new(()),
            alive: AtomicBool::new(true),
            shutdown_started: AtomicBool::new(false),
            intentional_shutdown: AtomicBool::new(false),
        });
        let reader = Arc::clone(&process);
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
                            let provider_id = msg["params"]["sessionId"].as_str().unwrap_or("");
                            if let Some(session) = reader.routes.lock().await.get(provider_id).and_then(Weak::upgrade) {
                                let request_key = format!("{}:{key}", session.local_session_id);
                                session.incoming.lock().await.insert(request_key.clone(), id.clone());
                                let options = msg["params"]["options"].as_array().cloned().unwrap_or_default();
                                session.permission_options.lock().await.insert(request_key.clone(), options);
                                emit_permission(&session.events, msg.get("params").unwrap_or(&Value::Null), &request_key).await;
                            } else {
                                let response = json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unknown session"}});
                                let mut bytes = serde_json::to_vec(&response).unwrap_or_default();
                                bytes.push(b'\n');
                                let _ = reader.stdin.lock().await.write(&bytes).await;
                            }
                        } else {
                            let response = json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": {"code": -32601, "message": "Method not supported by Bloblex ACP client"}
                            });
                            let mut bytes = serde_json::to_vec(&response).unwrap_or_default();
                            bytes.push(b'\n');
                            let _ = reader.stdin.lock().await.write(&bytes).await;
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
                    let provider_id = params["sessionId"].as_str().unwrap_or("");
                    if let Some(session) = reader.routes.lock().await.get(provider_id).and_then(Weak::upgrade) {
                        if params["update"]["sessionUpdate"].as_str() == Some("usage_update") {
                            let mut snap = session.usage.lock().await;
                            exec::record_usage_update(&mut snap, &params["update"], &line);
                        }
                        if params["update"]["sessionUpdate"].as_str() == Some("agent_turn_complete") {
                            session.turn_completed.store(true, Ordering::SeqCst);
                        }
                        emit_update(&session.events, &params).await;
                    }
                }
            }
            reader.alive.store(false, Ordering::Release);
            let sessions = reader.routes.lock().await.values().filter_map(Weak::upgrade).collect::<Vec<_>>();
            if !reader.intentional_shutdown.load(Ordering::Acquire) {
                for session in sessions {
                    let turn_id = {
                        let _lifecycle = session.turn_lifecycle.lock().await;
                        session.turn_completed.store(true, Ordering::Release);
                        session.active_turn_id.lock().await.take()
                    };
                    if let Some(turn_id) = turn_id {
                        let seq = session.usage_seq.fetch_add(1, Ordering::Relaxed) + 1;
                        let report = exec::usage_report(true, &Value::Null, &exec::UsageSnap::default(), seq);
                        let _ = session.events.enqueue(AgentEvent::UsageReport { turn_id, report });
                    }
                    let _ = session.events.enqueue(AgentEvent::Error { message: "OpenCode process exited unexpectedly".into() });
                }
            }
            for (_, tx) in std::mem::take(&mut *reader.pending.lock().await) {
                let _ = tx.send(Err(AdapterError::Process("ACP process exited".into())));
            }
            reader.shutdown().await;
        });
        Ok(process)
    }

    async fn ensure_initialized(c: &Conn) -> Result<bool, AdapterError> {
        let _guard = c.process.setup.lock().await;
        if c.process.initialized.load(Ordering::Acquire) {
            return Ok(c.process.load_session.load(Ordering::Acquire));
        }
        let init = Self::request(
            c,
            "initialize",
            json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"Bloblex","version":"0.1.0"}}),
        ).await?;
        let can_load = init["agentCapabilities"]["loadSession"].as_bool().unwrap_or(false);
        Self::notify(c, "initialized", json!({})).await?;
        c.process.load_session.store(can_load, Ordering::Release);
        c.process.initialized.store(true, Ordering::Release);
        Ok(can_load)
    }

    async fn schedule_idle_shutdown(&self, c: &Arc<Conn>) {
        let process = Arc::clone(&c.process);
        let key = c.process_key.clone();
        let processes = Arc::clone(&self.processes);
        let gate = self.process_gate(&key).await;
        let idle_shutdown = self.idle_shutdown();
        tokio::spawn(async move {
            tokio::time::sleep(idle_shutdown).await;
            let _gate = gate.lock().await;
            let removed = {
                let mut all = processes.lock().await;
                let still_current = all.get(&key).is_some_and(|current| Arc::ptr_eq(current, &process));
                if still_current && process.active_sessions.load(Ordering::Acquire) == 0 {
                    all.remove(&key);
                    true
                } else { false }
            };
            if removed { process.shutdown().await; }
        });
    }

    async fn abandon_setup(&self, c: &Arc<Conn>) {
        self.detach_route(c, None, true).await;
    }

    async fn detach_route(&self, c: &Arc<Conn>, provider_id: Option<&str>, shutdown_when_empty: bool) -> bool {
        let gate = self.process_gate(&c.process_key).await;
        let _gate = gate.lock().await;
        if let Some(provider_id) = provider_id { c.process.routes.lock().await.remove(provider_id); }
        if c.detached.swap(true, Ordering::AcqRel) { return false; }
        let removed = {
            let mut processes = self.processes.lock().await;
            if processes.get(&c.process_key).is_some_and(|current| Arc::ptr_eq(current, &c.process)) {
                let prior = c.process.active_sessions.load(Ordering::Acquire);
                if prior > 0 {
                    let remaining = c.process.active_sessions.fetch_sub(1, Ordering::AcqRel) - 1;
                    if remaining == 0 && shutdown_when_empty {
                        processes.remove(&c.process_key);
                        true
                    } else { remaining == 0 }
                } else { false }
            } else { false }
        };
        if removed && shutdown_when_empty { c.process.shutdown().await; }
        removed
    }

    async fn resume_after_crash(&self, session_id: &str, old: &Arc<Conn>) -> Result<Arc<Conn>, AdapterError> {
        let process = self.acquire_process(&old.process_key, &old.runtime, &old.cwd, &old.base_options).await?;
        let prior_id = old.session_id.lock().await.clone().ok_or_else(|| AdapterError::Process("ACP session has no provider session id".into()))?;
        let new = Arc::new(Conn {
            process,
            process_key: old.process_key.clone(),
            detached: AtomicBool::new(false),
            runtime: old.runtime.clone(),
            cwd: old.cwd.clone(),
            base_options: old.base_options.clone(),
            incoming: Mutex::new(HashMap::new()),
            permission_options: Mutex::new(HashMap::new()),
            session_id: Mutex::new(None),
            can_resume: AtomicBool::new(false),
            turn_completed: AtomicBool::new(true),
            active_turn_id: Mutex::new(None),
            cancelled_turn: AtomicBool::new(false),
            turn_lifecycle: Mutex::new(()),
            local_session_id: old.local_session_id.clone(),
            events: old.events.clone(),
            spawned_instructions: old.spawned_instructions.clone(),
            spawned_env: old.spawned_env.clone(),
            config_options: Mutex::new(Vec::new()),
            default_mode: Mutex::new(None),
            applied: Mutex::new(exec::Echoes::default()),
            usage: Mutex::new(exec::UsageSnap::default()),
            usage_seq: AtomicU64::new(0),
        });
        let setup = async {
            let can_load = Self::ensure_initialized(&new).await?;
            let result = if can_load {
                Self::request(&new, "session/load", json!({"sessionId":prior_id,"cwd":new.cwd.to_string_lossy(),"mcpServers":exec::acp_mcp_servers(&new.base_options.mcp_servers)})).await.map_err(|error| match error {
                    AdapterError::Protocol(message) if resume_rejected_evidence(&message) => AdapterError::ResumeRejected,
                    other => other,
                })
            } else {
                Err(AdapterError::Unsupported("ACP agent did not advertise loadSession".into()))
            };
            let (provider_id, result, resumed) = match result {
                Ok(result) => (prior_id, result, true),
                Err(AdapterError::ResumeRejected | AdapterError::Unsupported(_)) => {
                    let result = Self::request(&new, "session/new", json!({"cwd":new.cwd.to_string_lossy(),"mcpServers":exec::acp_mcp_servers(&new.base_options.mcp_servers)})).await?;
                    let id = result["sessionId"].as_str().ok_or_else(|| AdapterError::Protocol("session/new returned no sessionId".into()))?.to_owned();
                    (id, result, false)
                }
                Err(error) => return Err(error),
            };
            *new.session_id.lock().await = Some(provider_id.clone());
            new.can_resume.store(can_load, Ordering::Release);
            let config_options = exec::options_from_result(&result);
            *new.default_mode.lock().await = exec::default_provider_mode(&config_options);
            *new.config_options.lock().await = config_options;
            new.process.routes.lock().await.insert(provider_id.clone(), Arc::downgrade(&new));
            Self::apply_options(&new, &provider_id, &new.base_options, None).await?;
            Ok::<(String, bool), AdapterError>((provider_id, resumed))
        }.await;
        let (provider_id, resumed) = match setup {
            Ok(values) => values,
            Err(error) => {
                if let Some(provider_id) = new.session_id.lock().await.take() { new.process.routes.lock().await.remove(&provider_id); }
                self.abandon_setup(&new).await;
                return Err(error);
            }
        };
        if !resumed { new.turn_completed.store(true, Ordering::Release); }
        if !resumed {
            let _ = new.events.enqueue(AgentEvent::SessionStarted { provider_session_id: provider_id });
        }
        self.sessions.lock().await.insert(session_id.to_owned(), new.clone());
        Ok(new)
    }

    async fn detach_timed_out_cancel(&self, c: &Arc<Conn>, provider_id: &str) {
        let turn_id = {
            let _lifecycle = c.turn_lifecycle.lock().await;
            if c.turn_completed.load(Ordering::Acquire) { return; }
            c.cancelled_turn.store(true, Ordering::Release);
            c.turn_completed.store(true, Ordering::Release);
            c.active_turn_id.lock().await.take()
        };
        if let Some(turn_id) = turn_id {
            let seq = c.usage_seq.fetch_add(1, Ordering::Relaxed) + 1;
            let report = exec::usage_report(true, &Value::Null, &exec::UsageSnap::default(), seq);
            let _ = c.events.enqueue(AgentEvent::UsageReport { turn_id, report });
        }
        let _ = c.events.enqueue(AgentEvent::TurnCancelled);
        c.process.active_turns.lock().await.remove(provider_id);
        self.detach_route(c, Some(provider_id), true).await;
    }

    async fn request(c: &Conn, method: &str, params: Value) -> Result<Value, AdapterError> {
        let id = c.process.next.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = oneshot::channel();
        c.process.pending.lock().await.insert(id.clone(), tx);
        let msg = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        let mut bytes = serde_json::to_vec(&msg).map_err(|e| AdapterError::Protocol(e.to_string()))?;
        bytes.push(b'\n');
        if let Err(e) = c.process.stdin.lock().await.write(&bytes).await {
            c.process.pending.lock().await.remove(&id);
            return Err(AdapterError::Process(e.to_string()));
        }
        let request_timeout = if method == "session/prompt" {
            Duration::from_secs(30 * 60)
        } else {
            Duration::from_secs(20)
        };
        match tokio::time::timeout(request_timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(AdapterError::Process("ACP connection closed".into())),
            Err(_) => {
                c.process.pending.lock().await.remove(&id);
                Err(AdapterError::Timeout)
            }
        }
    }

    async fn notify(c: &Conn, method: &str, params: Value) -> Result<(), AdapterError> {
        let msg = json!({"jsonrpc":"2.0","method":method,"params":params});
        let mut bytes = serde_json::to_vec(&msg).map_err(|e| AdapterError::Protocol(e.to_string()))?;
        bytes.push(b'\n');
        c.process.stdin
            .lock()
            .await
            .write(&bytes)
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
        let applied_mode = c.applied.lock().await.mode.clone();
        let wanted_mode = if options.plan_mode {
            Some(exec::PLAN_MODE.to_owned())
        } else if exec::normalize_instructions(&options.instructions).is_some() {
            Some(exec::AGENT_NAME.to_owned())
        } else if matches!(applied_mode.as_deref(), Some(mode) if mode == exec::AGENT_NAME || mode == exec::PLAN_MODE) {
            let default_mode = c.default_mode.lock().await.clone();
            let Some(default_mode) = default_mode else {
                Self::fail_setting(c, turn_id, "instructions", json!(false), exec::ERR_MODE_MISSING).await;
                return Err(AdapterError::Protocol(exec::ERR_MODE_MISSING.into()));
            };
            Some(default_mode)
        } else { None };
        if let Some(mode) = wanted_mode.filter(|mode| applied_mode.as_deref() != Some(mode.as_str())) {
            Self::select(
                c,
                provider_session_id,
                "mode",
                &mode,
                if options.plan_mode { "mode" } else { "instructions" },
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

async fn emit_update(tx: &SessionEventSink, p: &Value) {
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
        "session_info_update" => u["title"]
            .as_str()
            .map(|title| AgentEvent::SessionTitle { title: title.to_owned() }),
        "usage_update" => {
            let used = u["used"].as_u64();
            let size = u["size"].as_u64();
            (used.is_some() || size.is_some()).then_some(AgentEvent::ContextUpdated { used, size })
        }
        "agent_turn_complete" | "current_mode_update" => None,
        _ => None,
    };
    if let Some(event) = event {
        let _ = tx.enqueue(event);
    }
}

fn id_key(id: &Value) -> String {
    id.as_str().map(str::to_owned).unwrap_or_else(|| id.to_string())
}

async fn emit_permission(tx: &SessionEventSink, p: &Value, id: &str) {
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
        .enqueue(AgentEvent::PermissionRequested {
            provider_request_id: id.into(),
            title,
            detail: p["toolCall"]["rawInput"].as_str().map(str::to_owned),
            choices,
            raw: p.clone(),
        });
}

impl Conn {
    async fn pending_permission_options(&self, id: &str) -> Vec<Value> {
        self.permission_options.lock().await.get(id).cloned().unwrap_or_default()
    }
}

impl SharedProcess {
    async fn shutdown(&self) {
        if self.shutdown_started.swap(true, Ordering::AcqRel) { return; }
        self.intentional_shutdown.store(true, Ordering::Release);
        self.alive.store(false, Ordering::Release);
        self.stdin
            .lock()
            .await
            .close(&mut *self.child.lock().await, &self.process_tree)
            .await;
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
            let can_resume = Self::ensure_initialized(&c).await?;
            c.can_resume.store(can_resume, Ordering::Release);
            let result = Self::request(
                &c,
                "session/new",
                json!({"cwd": req.project_path, "mcpServers": exec::acp_mcp_servers(&req.exec_options.mcp_servers)}),
            )
            .await?;
            let provider_id = result["sessionId"]
                .as_str()
                .ok_or_else(|| AdapterError::Protocol("session/new returned no sessionId".into()))?
                .to_owned();
            *c.session_id.lock().await = Some(provider_id.clone());
            c.process.routes.lock().await.insert(provider_id.clone(), Arc::downgrade(&c));
            let config_options = exec::options_from_result(&result);
            *c.default_mode.lock().await = exec::default_provider_mode(&config_options);
            *c.config_options.lock().await = config_options;
            Self::apply_options(&c, &provider_id, &req.exec_options, None).await?;
            Ok::<String, AdapterError>(provider_id)
        }
        .await;
        let provider_id = match setup {
            Ok(provider_id) => provider_id,
            Err(error) => {
                if let Some(provider_id) = c.session_id.lock().await.take() {
                    c.process.routes.lock().await.remove(&provider_id);
                }
                self.abandon_setup(&c).await;
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
            if !Self::ensure_initialized(&c).await? {
                return Err(AdapterError::Unsupported("ACP agent did not advertise loadSession".into()));
            }
            c.can_resume.store(true, Ordering::Relaxed);
            let result = Self::request(
                &c,
                "session/load",
                json!({"sessionId": req.provider_session_id, "cwd": req.project_path, "mcpServers": exec::acp_mcp_servers(&req.exec_options.mcp_servers)}),
            )
            .await
            .map_err(|error| match error {
                AdapterError::Protocol(message) if resume_rejected_evidence(&message) => {
                    AdapterError::ResumeRejected
                }
                other => other,
            })?;
            *c.session_id.lock().await = Some(req.provider_session_id.clone());
            c.process.routes.lock().await.insert(req.provider_session_id.clone(), Arc::downgrade(&c));
            let config_options = exec::options_from_result(&result);
            *c.default_mode.lock().await = exec::default_provider_mode(&config_options);
            *c.config_options.lock().await = config_options;
            Self::apply_options(&c, &req.provider_session_id, &req.exec_options, None).await?;
            Ok::<(), AdapterError>(())
        }
        .await;
        if let Err(error) = setup {
            if let Some(provider_id) = c.session_id.lock().await.take() {
                c.process.routes.lock().await.remove(&provider_id);
            }
            self.abandon_setup(&c).await;
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
        if !req.attachments.is_empty() {
            return Err(AdapterError::Unsupported("This runtime does not accept image attachments.".into()));
        }
        let mut c = self
            .sessions
            .lock()
            .await
            .get(&handle.session_id)
            .cloned()
            .ok_or_else(|| AdapterError::Process("ACP session missing".into()))?;
        if c.detached.load(Ordering::Acquire) || !c.process.alive.load(Ordering::Acquire) {
            c = self.resume_after_crash(&handle.session_id, &c).await?;
        }
        let provider_id = c.session_id.lock().await.clone().ok_or_else(|| AdapterError::Process("ACP session missing provider id".into()))?;
        Self::apply_options(&c, &provider_id, &req.exec_options, Some(&req.turn_id)).await?;
        *c.usage.lock().await = exec::UsageSnap::default();
        {
            let _lifecycle = c.turn_lifecycle.lock().await;
            c.turn_completed.store(false, Ordering::SeqCst);
            c.cancelled_turn.store(false, Ordering::Release);
            *c.active_turn_id.lock().await = Some(req.turn_id.clone());
        }
        c.process.active_turns.lock().await.insert(provider_id.clone());
        let result = match Self::request(
            &c,
            "session/prompt",
            json!({"sessionId": provider_id, "prompt": [{"type": "text", "text": req.text}]}),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                c.process.active_turns.lock().await.remove(&provider_id);
                let (was_cancelled, had_active_turn) = {
                    let _lifecycle = c.turn_lifecycle.lock().await;
                    (c.cancelled_turn.swap(false, Ordering::AcqRel), c.active_turn_id.lock().await.take().is_some())
                };
                if was_cancelled { return Ok(()); }
                if had_active_turn {
                    Self::emit_turn_evidence(&c, &req.turn_id, &req.exec_options, None).await;
                }
                return Err(AdapterError::Protocol("OpenCode prompt failed".into()));
            }
        };
        let was_cancelled = {
            let _lifecycle = c.turn_lifecycle.lock().await;
            if c.cancelled_turn.swap(false, Ordering::AcqRel) {
                true
            } else {
                c.turn_completed.store(true, Ordering::Release);
                false
            }
        };
        if was_cancelled {
            c.process.active_turns.lock().await.remove(&provider_id);
            c.active_turn_id.lock().await.take();
            return Ok(());
        }
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
        c.process.active_turns.lock().await.remove(&provider_id);
        c.active_turn_id.lock().await.take();
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
        let provider_id = c.session_id.lock().await.clone().unwrap_or_else(|| handle.provider_session_id.clone());
        let requests = std::mem::take(&mut *c.incoming.lock().await);
        for (key, id) in requests {
            let response = json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}});
            let mut bytes = serde_json::to_vec(&response).map_err(|e| AdapterError::Protocol(e.to_string()))?;
            bytes.push(b'\n');
            if c.process.stdin.lock().await.write(&bytes).await.is_err() {
                self.detach_timed_out_cancel(&c, &provider_id).await;
                return Ok(());
            }
            c.permission_options.lock().await.remove(&key);
        }
        let cancelled = tokio::time::timeout(
            Duration::from_secs(2),
            Self::notify(&c, "session/cancel", json!({"sessionId": provider_id})),
        ).await;
        if !matches!(cancelled, Ok(Ok(()))) {
            self.detach_timed_out_cancel(&c, &provider_id).await;
            return Ok(());
        }
        let completed = tokio::time::timeout(Duration::from_secs(2), async {
            while !c.turn_completed.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }).await;
        if completed.is_err() {
            self.detach_timed_out_cancel(&c, &provider_id).await;
            return Ok(());
        }
        c.process.active_turns.lock().await.remove(&provider_id);
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
                c.process.stdin
                    .lock()
                    .await
                    .write(&bytes)
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
            let provider_id = c.session_id.lock().await.clone().unwrap_or_else(|| handle.provider_session_id.clone());
            if c.process.alive.load(Ordering::Acquire) {
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    Self::request(&c, "session/close", json!({"sessionId": provider_id})),
                )
                .await;
            }
            let became_idle = self.detach_route(&c, Some(&provider_id), false).await;
            if became_idle { self.schedule_idle_shutdown(&c).await; }
        }
        Ok(())
    }

    async fn shutdown(&self) {
        let processes = {
            let mut map = self.processes.lock().await;
            std::mem::take(&mut *map)
        };
        for process in processes.into_values() {
            process.shutdown().await;
        }
    }
}

fn resume_rejected_evidence(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    (message.contains("session") || message.contains("resume"))
        && ["not found", "expired", "does not exist", "unknown id"]
            .iter()
            .any(|evidence| message.contains(evidence))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn session_relay_never_drops_critical_events_when_target_is_full() {
        let (target, mut receiver) = tokio::sync::mpsc::channel(1);
        target.try_send(AgentEvent::SessionIdle).unwrap();
        let sink = SessionEventSink::new(target);
        let stream_count = SESSION_FORWARD_QUEUE_COALESCE_CAP * 4;
        sink.enqueue(AgentEvent::ToolUpdated { tool_call_id: "tool".into(), raw: json!({"progress":1}) }).unwrap();
        for _ in 0..(SESSION_FORWARD_QUEUE_COALESCE_CAP / 2 - 1) {
            sink.enqueue(AgentEvent::AssistantDelta { text: "x".into() }).unwrap();
            sink.enqueue(AgentEvent::ThinkingDelta { text: "y".into() }).unwrap();
        }
        for _ in 0..stream_count {
            sink.enqueue(AgentEvent::AssistantDelta { text: "x".into() }).unwrap();
            sink.enqueue(AgentEvent::ThinkingDelta { text: "y".into() }).unwrap();
        }
        sink.enqueue(AgentEvent::ToolUpdated { tool_call_id: "tool".into(), raw: json!({"progress":2}) }).unwrap();
        let report = exec::usage_report(true, &Value::Null, &exec::UsageSnap::default(), 1);
        for event in [
            AgentEvent::PermissionRequested {
                provider_request_id: "permission".into(),
                title: "Approval".into(),
                detail: None,
                choices: vec!["allow_once".into()],
                raw: json!({}),
            },
            AgentEvent::UsageReport { turn_id: "turn".into(), report },
            AgentEvent::ToolCompleted { tool_call_id: "tool".into(), raw: json!({}) },
            AgentEvent::Error { message: "provider failed".into() },
            AgentEvent::TurnCompleted,
        ] {
            sink.enqueue(event).unwrap();
        }
        assert!(sink.0.events.lock().unwrap().len() <= SESSION_FORWARD_QUEUE_COALESCE_CAP + 8);
        let drain = tokio::spawn(async move {
            let mut events = Vec::new();
            let mut delta_chars = 0;
            let mut thinking_chars = 0;
            let mut saw_merged_delta = false;
            let mut saw_merged_thinking = false;
            let mut tool_updates = 0;
            loop {
                let event = receiver.recv().await.expect("relay channel stays open");
                match &event {
                    AgentEvent::AssistantDelta { text } => {
                        delta_chars += text.len();
                        saw_merged_delta |= text.len() > 1;
                    }
                    AgentEvent::ThinkingDelta { text } => {
                        thinking_chars += text.len();
                        saw_merged_thinking |= text.len() > 1;
                    }
                    AgentEvent::ToolUpdated { raw, .. } => {
                        tool_updates += 1;
                        assert_eq!(raw["progress"], 2);
                    }
                    _ => {}
                }
                events.push(event);
                if matches!(events.last(), Some(AgentEvent::TurnCompleted)) {
                    break (events, delta_chars, thinking_chars, saw_merged_delta, saw_merged_thinking, tool_updates);
                }
            }
        });
        let (events, delta_chars, thinking_chars, saw_merged_delta, saw_merged_thinking, tool_updates) = tokio::time::timeout(Duration::from_secs(5), drain).await.unwrap().unwrap();
        assert_eq!(delta_chars, stream_count + SESSION_FORWARD_QUEUE_COALESCE_CAP / 2 - 1);
        assert_eq!(thinking_chars, stream_count + SESSION_FORWARD_QUEUE_COALESCE_CAP / 2 - 1);
        assert!(saw_merged_delta, "consecutive deltas merge after the queue cap");
        assert!(saw_merged_thinking, "consecutive thought deltas merge after the queue cap");
        assert_eq!(tool_updates, 1, "consecutive progress updates coalesce to the latest state");
        assert!(events.iter().any(|event| matches!(event, AgentEvent::PermissionRequested { .. })));
        assert!(events.iter().any(|event| matches!(event, AgentEvent::UsageReport { .. })));
        assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolCompleted { .. })));
        assert!(events.iter().any(|event| matches!(event, AgentEvent::Error { .. })));
    }

    #[tokio::test]
    async fn relay_closes_after_target_is_dropped_and_later_enqueues_fail() {
        let (target, receiver) = tokio::sync::mpsc::channel(1);
        let sink = SessionEventSink::new(target);
        drop(receiver);
        assert!(sink.send(AgentEvent::SessionIdle).await.is_err());
        assert!(sink.enqueue(AgentEvent::AssistantDelta { text: "late".into() }).is_err());
    }

    #[tokio::test]
    async fn stalled_relay_bounds_alternating_streams_and_tool_start_flood() {
        let (target, mut receiver) = tokio::sync::mpsc::channel(1);
        target.try_send(AgentEvent::SessionIdle).unwrap();
        let sink = SessionEventSink::new(target);
        for _ in 0..SESSION_FORWARD_QUEUE_COALESCE_CAP / 2 {
            sink.enqueue(AgentEvent::AssistantDelta { text: "a".into() }).unwrap();
            sink.enqueue(AgentEvent::ThinkingDelta { text: "t".into() }).unwrap();
        }
        for _ in 0..SESSION_FORWARD_QUEUE_COALESCE_CAP * 8 {
            sink.enqueue(AgentEvent::AssistantDelta { text: "a".into() }).unwrap();
            sink.enqueue(AgentEvent::ThinkingDelta { text: "t".into() }).unwrap();
        }
        {
            let events = sink.0.events.lock().unwrap();
            assert!(events.len() <= SESSION_FORWARD_QUEUE_COALESCE_CAP);
            assert!(events.iter().any(|item| matches!(item.event, AgentEvent::AssistantDelta { ref text } if text.len() > 1)));
            assert!(events.iter().any(|item| matches!(item.event, AgentEvent::ThinkingDelta { ref text } if text.len() > 1)));
        }
        const TOOL_STARTED_FLOOD: usize = SESSION_FORWARD_QUEUE_COALESCE_CAP * 8;
        for index in 0..TOOL_STARTED_FLOOD {
            sink.enqueue(AgentEvent::ToolStarted { tool_call_id: format!("tool-{index}"), kind: "exec".into(), title: "progress".into(), raw: json!({}) }).unwrap();
        }
        assert_eq!(sink.0.events.lock().unwrap().iter().filter(|item| matches!(item.event, AgentEvent::ToolStarted { .. })).count(), TOOL_STARTED_FLOOD);
        assert!(matches!(receiver.recv().await, Some(AgentEvent::SessionIdle)));
        let delivered = tokio::time::timeout(Duration::from_secs(15), async {
            let mut started = 0;
            while started < TOOL_STARTED_FLOOD {
                if let Some(AgentEvent::ToolStarted { tool_call_id, .. }) = receiver.recv().await {
                    assert_eq!(tool_call_id, format!("tool-{started}"));
                    started += 1;
                }
            }
            started
        }).await.unwrap();
        assert_eq!(delivered, TOOL_STARTED_FLOOD);
    }

    #[test]
    fn parse_event_mapping_compiles_wire_schema() {
        let params = json!({"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}});
        let usage = json!({"sessionId":"s","update":{"sessionUpdate":"usage_update","used":1,"size":2}});
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (bounded, mut rx) = tokio::sync::mpsc::channel(1);
            let tx = SessionEventSink::new(bounded);
            emit_update(&tx, &params).await;
            assert!(matches!(rx.recv().await, Some(AgentEvent::AssistantDelta { text }) if text == "hello"));
            emit_update(&tx, &usage).await;
            assert!(matches!(rx.recv().await, Some(AgentEvent::ContextUpdated { used: Some(1), size: Some(2) })));
            emit_update(&tx, &json!({"sessionId":"s","update":{"sessionUpdate":"session_info_update","title":"ACP generated title"}})).await;
            assert!(matches!(rx.recv().await, Some(AgentEvent::SessionTitle { title }) if title == "ACP generated title"));
            assert!(rx.try_recv().is_err());
        });
        assert_eq!(id_key(&json!("1")), "1");
        assert_eq!(id_key(&json!(1)), "1");
    }
}
