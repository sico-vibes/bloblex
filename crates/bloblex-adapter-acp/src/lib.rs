use async_trait::async_trait;
use base64::Engine;
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

async fn image_prompt_content(req: &PromptRequest) -> Result<Vec<Value>, AdapterError> {
    let mut content = vec![json!({"type":"text","text":req.text})];
    for image in &req.attachments {
        let bytes = tokio::fs::read(&image.path).await.map_err(|_| AdapterError::Process("An attached image is no longer readable.".into()))?;
        if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 { return Err(AdapterError::Unsupported("An image must be smaller than 20 MB.".into())); }
        content.push(json!({"type":"image","mimeType":image.media_type,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}));
    }
    Ok(content)
}

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
    prompt_ack_pending: AtomicBool,
    question_calls: Mutex<std::collections::HashSet<String>>,
    image_calls: Mutex<ImageCalls>,
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
    image_prompts: AtomicBool,
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
        if queue.len() >= SESSION_FORWARD_QUEUE_COALESCE_CAP && is_stream_event(&event) {
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
        queue.push_back(QueuedEvent { event, delivered: None });
        drop(queue);
        self.0.notify.notify_one();
        Ok(())
    }
}

const SHARED_PROCESS_IDLE_SHUTDOWN: Duration = Duration::from_secs(30);

/// Test only: when above zero, every request except `session/prompt` times out after this many
/// milliseconds instead of 20 seconds. A prompt has no timer, so the tests set it small to show that.
#[doc(hidden)]
pub static TEST_REQUEST_TIMEOUT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const SESSION_FORWARD_QUEUE_COALESCE_CAP: usize = 128;

fn is_stream_event(event: &AgentEvent) -> bool {
    matches!(event, AgentEvent::AssistantDelta { .. } | AgentEvent::ThinkingDelta { .. } | AgentEvent::ToolUpdated { .. })
}

// The Err variant carries the whole AgentEvent; boxing would change the adapter's public event shape.
#[allow(clippy::result_large_err)]
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

    /// The identity of a shared provider process: a hash of the launch inputs
    /// that a running `opencode acp` process cannot change after it starts.
    /// `spawn` and `reconnect` must agree on this construction, because the
    /// same key means the same process, and a different key means a new one.
    fn process_key(runtime: &RuntimeSpec, cwd: &Path, options: &ExecOptions) -> String {
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
        sha256_hex(key_data.to_string().as_bytes())
    }

    async fn spawn(
        &self,
        runtime: &RuntimeSpec,
        cwd: &Path,
        events: EventSender,
        local_session_id: &str,
        options: &ExecOptions,
    ) -> Result<Arc<Conn>, AdapterError> {
        let key = Self::process_key(runtime, cwd, options);
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
            prompt_ack_pending: AtomicBool::new(false),
            question_calls: Mutex::new(std::collections::HashSet::new()),
            image_calls: Mutex::new(ImageCalls::default()),
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
        // OpenCode 1.x and 2.x both take the working directory from the process
        // cwd and from `session/new`; `acp --cwd` only exists on 1.x and makes a
        // 2.x CLI print help instead of answering JSON-RPC.
        cmd.args(&runtime.args)
            .arg("acp")
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
            image_prompts: AtomicBool::new(false),
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
                                "error": {"code": -32601, "message": "Method not supported by Bitbots ACP client"}
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
                        // The first session/update after the prompt is written is
                        // positive evidence the provider took it. Enqueued after
                        // the update's own mapping so existing event order holds.
                        let prompt_accepted = session.prompt_ack_pending.swap(false, Ordering::SeqCst);
                        if is_child_usage_update(&params) {
                            if prompt_accepted { let _ = session.events.enqueue(AgentEvent::PromptAccepted); }
                            continue;
                        }
                        if params["update"]["sessionUpdate"].as_str() == Some("usage_update") {
                            let mut snap = session.usage.lock().await;
                            exec::record_usage_update(&mut snap, &params["update"], &line);
                        }
                        if params["update"]["sessionUpdate"].as_str() == Some("agent_turn_complete") {
                            session.turn_completed.store(true, Ordering::SeqCst);
                        }
                        if hides_question_card(&mut *session.question_calls.lock().await, &params["update"]) {
                            if prompt_accepted { let _ = session.events.enqueue(AgentEvent::PromptAccepted); }
                            continue;
                        }
                        // Phase 2: a request for an image, or its completion, is
                        // reported as its own event; the tool row is unchanged
                        // and nothing here depends on a turn being active.
                        emit_image_request(&session.events, &params["update"], &session.image_calls).await;
                        let context_model = session.applied.lock().await.model.clone();
                        emit_update(&session.events, &params, context_model).await;
                        if prompt_accepted { let _ = session.events.enqueue(AgentEvent::PromptAccepted); }
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
                    if let Some(ref turn_id) = turn_id {
                        let seq = session.usage_seq.fetch_add(1, Ordering::Relaxed) + 1;
                        let report = exec::usage_report(true, &Value::Null, &exec::UsageSnap::default(), seq);
                        let _ = session.events.enqueue(AgentEvent::UsageReport { turn_id: turn_id.clone(), report });
                    }
                    // A process that exits with no turn in flight did not fail a
                    // turn: the exit is not reported as one, so a finished turn
                    // is never relabelled as a failure. A running turn keeps its
                    // terminal error.
                    if turn_id.is_some() {
                        let _ = session.events.enqueue(AgentEvent::Error { message: "OpenCode process exited unexpectedly".into() });
                    }
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
        c.process.image_prompts.store(init["agentCapabilities"]["promptCapabilities"]["image"].as_bool().unwrap_or(false), Ordering::Release);
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

    /// True when the requested turn needs a process started with a different
    /// configuration than the one this connection is on. Instructions only
    /// matter when the turn carries some (clearing them just returns to the
    /// provider's default mode on the running process), and `env` only when
    /// the turn sets any. Model and effort are *not* part of this: they are
    /// applied per session through `session/set_config_option`.
    fn needs_reconnect(c: &Conn, options: &ExecOptions) -> bool {
        if let Some(instructions) = exec::normalize_instructions(&options.instructions) {
            if c.spawned_instructions.as_deref() != Some(instructions.as_str()) {
                return true;
            }
        }
        !options.env.is_empty() && options.env != c.spawned_env
    }

    /// Builds a `Conn` on `process` and re-establishes the provider session:
    /// `session/load` for the existing provider id, falling back to
    /// `session/new` only where a provider cannot resume. The replacement is
    /// installed in `self.sessions` on success; on failure the freshly
    /// acquired process is released and the caller's old connection is left
    /// untouched. `options` is the configuration the new process was started
    /// with, not necessarily the old connection's.
    async fn establish_session(
        &self,
        session_id: &str,
        old: &Arc<Conn>,
        process: Arc<SharedProcess>,
        process_key: String,
        prior_id: String,
        options: &ExecOptions,
    ) -> Result<Arc<Conn>, AdapterError> {
        let new = Arc::new(Conn {
            process,
            process_key,
            detached: AtomicBool::new(false),
            runtime: old.runtime.clone(),
            cwd: old.cwd.clone(),
            base_options: options.clone(),
            incoming: Mutex::new(HashMap::new()),
            permission_options: Mutex::new(HashMap::new()),
            session_id: Mutex::new(None),
            can_resume: AtomicBool::new(false),
            turn_completed: AtomicBool::new(true),
            active_turn_id: Mutex::new(None),
            cancelled_turn: AtomicBool::new(false),
            turn_lifecycle: Mutex::new(()),
            prompt_ack_pending: AtomicBool::new(false),
            question_calls: Mutex::new(std::collections::HashSet::new()),
            image_calls: Mutex::new(ImageCalls::default()),
            local_session_id: old.local_session_id.clone(),
            events: old.events.clone(),
            spawned_instructions: exec::normalize_instructions(&options.instructions),
            spawned_env: options.env.clone(),
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
                    AdapterError::Process(message) => AdapterError::ResumeFailed(message),
                    AdapterError::Timeout => AdapterError::ResumeFailed("session/load timed out".into()),
                    other => other,
                })
            } else {
                Err(AdapterError::Unsupported("ACP agent did not advertise loadSession".into()))
            };
            let (provider_id, result, resumed) = match result {
                Ok(result) => (prior_id, result, true),
                Err(AdapterError::ResumeRejected | AdapterError::ResumeFailed(_) | AdapterError::Unsupported(_)) => {
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

    async fn resume_after_crash(&self, session_id: &str, old: &Arc<Conn>) -> Result<Arc<Conn>, AdapterError> {
        let prior_id = old.session_id.lock().await.clone().ok_or_else(|| AdapterError::Process("ACP session has no provider session id".into()))?;
        let options = old.base_options.clone();
        let process = self.acquire_process(&old.process_key, &old.runtime, &old.cwd, &options).await?;
        self.establish_session(session_id, old, process, old.process_key.clone(), prior_id, &options).await
    }

    /// Re-establishes the session on a process started with `options`, for when
    /// the blob's instructions or environment changed since the current
    /// process started (`OPENCODE_CONFIG_CONTENT` is read only at process
    /// start). The conversation continues on the new process through
    /// `session/load`. The old connection is detached only once the new one is
    /// live, so a shared process is never killed while another session uses it
    /// and a failed reconnect leaves the old connection usable.
    async fn reconnect(
        &self,
        session_id: &str,
        old: &Arc<Conn>,
        options: &ExecOptions,
    ) -> Result<Arc<Conn>, AdapterError> {
        // Same guarantee the crash path relies on: a turn is never in flight
        // while its connection is replaced.
        if old.active_turn_id.lock().await.is_some() {
            return Err(AdapterError::Protocol("cannot reconfigure OpenCode while a turn is running".into()));
        }
        let prior_id = old.session_id.lock().await.clone().ok_or_else(|| AdapterError::Process("ACP session has no provider session id".into()))?;
        let key = Self::process_key(&old.runtime, &old.cwd, options);
        let process = self.acquire_process(&key, &old.runtime, &old.cwd, options).await?;
        let new = self.establish_session(session_id, old, process, key, prior_id.clone(), options).await?;
        self.detach_route(old, Some(&prior_id), true).await;
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
        // A turn has no time limit: a long one is legitimate, and the daemon's silence watchdog decides
        // when a quiet one is stuck. Every other request keeps a short timeout.
        match Self::request_timeout(method) {
            None => match rx.await {
                Ok(r) => r,
                Err(_) => Err(AdapterError::Process("ACP connection closed".into())),
            },
            Some(limit) => match tokio::time::timeout(limit, rx).await {
                Ok(Ok(r)) => r,
                Ok(Err(_)) => Err(AdapterError::Process("ACP connection closed".into())),
                Err(_) => {
                    c.process.pending.lock().await.remove(&id);
                    Err(AdapterError::Timeout)
                }
            },
        }
    }

    /// How long a request may wait for its answer. `session/prompt` waits as long as the turn runs.
    fn request_timeout(method: &str) -> Option<Duration> {
        let test_ms = TEST_REQUEST_TIMEOUT_MS.load(Ordering::Relaxed);
        if method == "session/prompt" { return None; }
        Some(if test_ms > 0 { Duration::from_millis(test_ms) } else { Duration::from_secs(20) })
    }

    /// Best effort: tells OpenCode to stop `provider_id`'s turn, so no work carries on unseen after
    /// Bitbots has stopped waiting for it.
    async fn stop_provider_turn(c: &Conn, provider_id: &str) {
        let _ = tokio::time::timeout(Duration::from_secs(2), Self::notify(c, "session/cancel", json!({"sessionId": provider_id}))).await;
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

    // One positional argument per config axis keeps the three call sites explicit.
    #[allow(clippy::too_many_arguments)]
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
        // Effort is discovered by the `thought_level` category when the id is
        // not literally `effort`; model and mode resolve by their own id.
        let Some(resolved_id) = ({
            let options = c.config_options.lock().await;
            exec::resolve_option_id(&options, config_id)
        }) else {
            Self::fail_setting(c, turn_id, outcome_key, json!(value), missing).await;
            return Err(AdapterError::Protocol(missing.into()));
        };
        let offered = {
            let options = c.config_options.lock().await;
            exec::config_option(&options, &resolved_id)
                .map(exec::option_values)
                .unwrap_or_default()
        };
        if !offered.contains(value) {
            Self::fail_setting(c, turn_id, outcome_key, json!(value), missing).await;
            return Err(AdapterError::Protocol(missing.into()));
        }
        // OpenCode can publish a stale effort a moment after a mode switch, so
        // an effort that does not echo back is set again a couple of times.
        let attempts = if config_id == "effort" { 3 } else { 1 };
        let mut detail = String::new();
        for attempt in 0..attempts {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let updated = match Self::set_option(c, provider_session_id, &resolved_id, value).await {
                Ok(updated) => updated,
                Err(message) => {
                    detail = message;
                    break;
                }
            };
            let echoed = exec::config_option(&updated, &resolved_id).and_then(exec::current_value);
            if echoed.as_deref() == Some(value) {
                let mut applied = c.applied.lock().await;
                match config_id {
                    "model" => applied.model = echoed,
                    "mode" => applied.mode = echoed,
                    "effort" => applied.effort = echoed,
                    _ => {}
                }
                return Ok(());
            }
            detail = Self::echo_detail(echoed.as_deref(), value);
        }
        let reason = format!("{rejected}: {detail}");
        Self::fail_setting(c, turn_id, outcome_key, json!(value), &reason).await;
        Err(AdapterError::Protocol(reason))
    }

    /// One `session/set_config_option`; stores and returns the refreshed
    /// option list. The error is the provider's own message.
    async fn set_option(c: &Conn, provider_session_id: &str, option_id: &str, value: &str) -> Result<Vec<Value>, String> {
        let result = Self::request(
            c,
            "session/set_config_option",
            json!({"sessionId": provider_session_id, "configId": option_id, "value": value}),
        )
        .await
        .map_err(|error| Self::rpc_error_message(&error))?;
        let updated = exec::options_from_result(&result);
        *c.config_options.lock().await = updated.clone();
        Ok(updated)
    }

    fn rpc_error_message(error: &AdapterError) -> String {
        let text = match error {
            AdapterError::Protocol(raw) => serde_json::from_str::<Value>(raw)
                .ok()
                .and_then(|value| value["message"].as_str().map(str::to_owned))
                .unwrap_or_else(|| raw.clone()),
            other => other.to_string(),
        };
        text.chars().take(200).collect()
    }

    fn echo_detail(echoed: Option<&str>, wanted: &str) -> String {
        format!("OpenCode answered {} instead of {wanted}", echoed.map(|value| format!("\"{value}\"")).unwrap_or_else(|| "nothing".into()))
    }

    /// Effort goes in one call with the model (`provider/model/<effort>`),
    /// because OpenCode's agent switch republishes the model without its
    /// variant and would otherwise wipe an effort set on its own. Models
    /// without an effort option, and the `default` effort, use plain `select`.
    async fn select_effort(
        c: &Conn,
        provider_session_id: &str,
        model: Option<&str>,
        thinking: &str,
        turn_id: Option<&str>,
    ) -> Result<(), AdapterError> {
        let (effort_id, model_id, offered, current_model) = {
            let options = c.config_options.lock().await;
            let effort_id = exec::resolve_option_id(&options, "effort");
            let model_id = exec::resolve_option_id(&options, "model");
            let offered = effort_id
                .as_deref()
                .and_then(|id| exec::config_option(&options, id))
                .map(exec::option_values)
                .unwrap_or_default();
            let current_model = model_id.as_deref().and_then(|id| exec::config_option(&options, id)).and_then(exec::current_value);
            (effort_id, model_id, offered, current_model)
        };
        let base = model.map(str::to_owned).or(current_model);
        let (Some(effort_id), Some(model_id), Some(base)) = (effort_id, model_id, base) else {
            return Self::select(c, provider_session_id, "effort", thinking, "thinking", exec::ERR_EFFORT_MISSING, exec::ERR_EFFORT_REJECTED, turn_id).await;
        };
        if thinking == "default" || !offered.contains(thinking) {
            return Self::select(c, provider_session_id, "effort", thinking, "thinking", exec::ERR_EFFORT_MISSING, exec::ERR_EFFORT_REJECTED, turn_id).await;
        }
        let wire = format!("{base}/{thinking}");
        let mut detail = String::new();
        for attempt in 0..3 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let updated = match Self::set_option(c, provider_session_id, &model_id, &wire).await {
                Ok(updated) => updated,
                Err(message) => {
                    detail = message;
                    break;
                }
            };
            let echoed_effort = exec::config_option(&updated, &effort_id).and_then(exec::current_value);
            if echoed_effort.as_deref() == Some(thinking) {
                let echoed_model = exec::config_option(&updated, &model_id).and_then(exec::current_value);
                let mut applied = c.applied.lock().await;
                if echoed_model.is_some() {
                    applied.model = echoed_model;
                }
                applied.effort = echoed_effort;
                return Ok(());
            }
            detail = Self::echo_detail(echoed_effort.as_deref(), thinking);
        }
        let reason = format!("{}: {detail}", exec::ERR_EFFORT_REJECTED);
        Self::fail_setting(c, turn_id, "thinking", json!(thinking), &reason).await;
        Err(AdapterError::Protocol(reason))
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
        let mut mode_changed = false;
        if let Some(mode) = wanted_mode.filter(|mode| applied_mode.as_deref() != Some(mode.as_str())) {
            mode_changed = true;
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
            if mode_changed || c.applied.lock().await.effort.as_deref() != Some(thinking) {
                Self::select_effort(c, provider_session_id, exec::nonempty(&options.model), thinking, turn_id).await?;
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

/// Whether a refused prompt means the agent is still running the previous turn.
fn is_busy_reason(reason: &str) -> bool {
    reason.to_ascii_lowercase().contains("busy")
}

/// What the owner reads for a failed prompt: the provider's own reason, on one line, or the plain
/// fallback. A busy agent gets a plain sentence instead of a bare protocol error. The daemon redacts
/// credentials from this line before it is shown.
fn failed_prompt_message(reason: &str) -> String {
    let one_line = reason.split_whitespace().collect::<Vec<_>>().join(" ");
    let one_line: String = one_line.chars().take(200).collect();
    if one_line.is_empty() || one_line == "OpenCode prompt failed" { return "OpenCode prompt failed".to_owned(); }
    if is_busy_reason(&one_line) {
        return "OpenCode is still working on the previous message. Wait for it to finish or press Stop, then send this again.".to_owned();
    }
    format!("OpenCode prompt failed: {one_line}")
}

/// The terminal error for a failed `session/prompt`. When an `Error` event was
/// queued for an active turn the event stream owns the turn
/// (`TurnErrorReported`); when there was no active turn nothing was queued, so
/// the daemon must finalize the turn itself (`Protocol`), as it did before
/// recovery existed. Returning `TurnErrorReported` without a queued `Error`
/// would leave the turn stuck in `working`.
fn failed_prompt_terminal(had_active_turn: bool) -> AdapterError {
    let message = "OpenCode prompt failed".to_owned();
    if had_active_turn { AdapterError::TurnErrorReported(message) } else { AdapterError::Protocol(message) }
}

/// OpenCode's `question` tool cannot work through Bitbots (it needs ACP
/// elicitation) and is denied in the injected config, so its refused or failed
/// card is dropped instead of shown as an error. The call id is remembered so
/// the later updates of the same call are dropped too.
fn hides_question_card(calls: &mut std::collections::HashSet<String>, update: &Value) -> bool {
    let id = update["toolCallId"].as_str().unwrap_or("");
    match update["sessionUpdate"].as_str() {
        Some("tool_call") => {
            let named = |key: &str| update[key].as_str().is_some_and(|value| value.eq_ignore_ascii_case("question"));
            if named("title") || named("name") {
                calls.insert(id.to_owned());
                return true;
            }
            false
        }
        Some("tool_call_update") => calls.contains(id),
        _ => false,
    }
}

/// The one tool whose structured output may name a file: OpenCode's image tool.
const IMAGE_TOOL: &str = "experimental_image_generate";

/// What this session has already reported about images.
///
/// OpenCode 2.2.2 names the tool only in the *started* update (`title` is the
/// tool name, `name` is absent) and puts `{path, model, jobID}` in
/// `rawOutput.metadata` of the *finished* one, which carries no name at all. So
/// the call id is remembered when the tool is named, and the finished update is
/// only read for a call that was named.
#[derive(Default)]
struct ImageCalls {
    /// Call ids this session identified as the image tool.
    known: std::collections::HashSet<String>,
    /// Calls whose stem was already reported, so a repeated update reports once.
    reported: std::collections::HashSet<String>,
    /// Calls whose failure was already reported.
    failed: std::collections::HashSet<String>,
    /// Every known call id, in order, so a completion notice can be attached to
    /// its request when there is exactly one candidate.
    ids: Vec<String>,
}

impl ImageCalls {
    fn remember(&mut self, id: &str) {
        if self.known.insert(id.to_owned()) { self.ids.push(id.to_owned()); }
    }
    /// The call a completion notice belongs to. A notice may only finish a call
    /// this session already knows: its own id, or the only call there is. Any
    /// other notice is ignored — it must never create a record or name a file,
    /// and the sweep finds the file on its own.
    fn call_for_notice(&self, job: Option<&str>) -> Option<String> {
        if let Some(job) = job {
            if self.ids.iter().any(|id| id == job) { return Some(job.to_owned()); }
        }
        (self.ids.len() == 1).then(|| self.ids[0].clone())
    }
}

/// Whether this update names OpenCode's image tool. Only the exact tool name
/// counts, and a shell call can never be it: OpenCode takes a shell call's title
/// from the model, so a model could title its own command after the tool. A bot
/// cannot get a file named by printing text either.
fn names_image_tool(u: &Value) -> bool {
    if u["kind"].as_str() == Some("execute") { return false; }
    let exact = |value: Option<&Value>| value.and_then(Value::as_str).is_some_and(|text| text.trim().eq_ignore_ascii_case(IMAGE_TOOL));
    exact(u.get("name"))
        || exact(u.get("toolName"))
        || exact(u.get("title"))
        || exact(u.get("rawInput").and_then(|input| input.get("tool")))
        || exact(u.get("rawInput").and_then(|input| input.get("name")))
        || exact(u.get("_meta").and_then(|meta| meta.get("opencode/tool")))
}

/// The stem from the tool's finished update. Only the real shape counts:
/// `rawOutput.metadata` is the tool's own `{path, model, jobID}`, and a job id
/// beside the path is what makes it that structured output. Nothing is ever
/// parsed out of text, and there is no other key this will read.
fn image_stem(u: &Value) -> Option<String> {
    let meta = u.get("rawOutput")?.get("metadata")?;
    meta.get("jobID").and_then(Value::as_str).filter(|job| !job.is_empty())?;
    meta.get("path").and_then(Value::as_str).map(str::trim).filter(|path| !path.is_empty()).map(str::to_owned)
}

/// The failure of a finished image tool call, as the runtime reports it.
fn image_failure(u: &Value) -> Option<String> {
    if u["status"].as_str() != Some("failed") { return None; }
    let reason = u["rawOutput"]["error"].as_str()
        .or_else(|| u["rawOutput"]["metadata"]["error"].as_str())
        .or_else(|| u["error"].as_str())
        .map(str::trim)
        .filter(|reason| !reason.is_empty());
    Some(reason.map(|reason| reason.lines().next().unwrap_or("").chars().take(200).collect())
        .unwrap_or_else(|| "The image request failed.".to_owned()))
}

/// Text a completion notice may carry, from the runtime's own fixed wording.
fn notice_text(description: &str) -> (Option<String>, Option<String>) {
    const SAVED: &str = "Image request finished. Saved image: ";
    const FAILED: &str = "Image request failed for ";
    if let Some(rest) = description.strip_prefix(SAVED) {
        // `<file> (<model>)`: the file is everything before the last " (".
        let file = rest.rsplit_once(" (").map(|(file, _)| file).unwrap_or(rest).trim();
        if std::path::Path::new(file).is_absolute() { return (Some(file.to_owned()), None); }
        return (None, None);
    }
    if let Some(rest) = description.strip_prefix(FAILED) {
        // `<stem>: <reason>`; the stem is a path and is never kept.
        let reason = rest.split_once(": ").map(|(_, reason)| reason).unwrap_or("").trim();
        let reason = if reason.is_empty() { "The image request failed." } else { reason };
        return (None, Some(reason.chars().take(200).collect()));
    }
    (None, None)
}

/// A completion notice, when one arrives. OpenCode's `notice` update carries a
/// title and description only; the structured metadata is on the session part,
/// not on the ACP update. The notice is never required: the daemon's sweep finds
/// the file when no notice arrives.
fn image_notice(u: &Value) -> Option<(Option<String>, Option<String>)> {
    if u["sessionUpdate"].as_str() != Some("notice") || u["title"].as_str() != Some("Image generation") { return None; }
    let meta = u.get("metadata").or_else(|| u.get("_meta"));
    if let Some(meta) = meta.filter(|meta| meta["source"].as_str() == Some(IMAGE_TOOL)) {
        let failed = meta["state"].as_str().is_some_and(|state| matches!(state, "failed" | "error" | "cancelled"));
        let path = meta["path"].as_str().filter(|path| std::path::Path::new(path).is_absolute());
        let failure = failed.then(|| meta["error"].as_str().unwrap_or("The image request failed.").chars().take(200).collect::<String>());
        if let (Some(path), false) = (path, failed) { return Some((Some(path.to_owned()), None)); }
        if failure.is_some() { return Some((None, failure)); }
    }
    let (saved, failure) = notice_text(u["description"].as_str().unwrap_or(""));
    (saved.is_some() || failure.is_some()).then_some((saved, failure))
}

/// Reports a request for an image, and nothing else: the tool row is left as it
/// is, a relative or absent path records nothing, and a notice is used when one
/// arrives. The event carries no image bytes; `inline_base64` is only for
/// providers that return the image itself.
async fn emit_image_request(tx: &SessionEventSink, u: &Value, calls: &tokio::sync::Mutex<ImageCalls>) {
    let mut state = calls.lock().await;
    if let Some((saved, failure)) = image_notice(u) {
        let job = u["metadata"]["jobID"].as_str().or_else(|| u["_meta"]["jobID"].as_str()).map(str::to_owned);
        // No known call means no record: the notice is dropped, not turned into one.
        let Some(tool_call_id) = state.call_for_notice(job.as_deref()) else { return; };
        let _ = tx.enqueue(AgentEvent::ImageRequested { tool_call_id, stem: None, saved_path: saved, inline_base64: None, failure });
        return;
    }
    let Some(tool_call_id) = u["toolCallId"].as_str().filter(|id| !id.is_empty()) else { return; };
    if names_image_tool(u) { state.remember(tool_call_id); }
    // The finished update carries no tool name, so only a call named earlier is read.
    if !state.known.contains(tool_call_id) { return; }
    if let Some(failure) = image_failure(u) {
        if !state.failed.insert(tool_call_id.to_owned()) { return; }
        let _ = tx.enqueue(AgentEvent::ImageRequested { tool_call_id: tool_call_id.to_owned(), stem: None, saved_path: None, inline_base64: None, failure: Some(failure) });
        return;
    }
    if state.reported.contains(tool_call_id) { return; }
    let Some(stem) = image_stem(u) else { return; };
    // A stem that is not absolute records nothing at all.
    if !std::path::Path::new(&stem).is_absolute() { return; }
    state.reported.insert(tool_call_id.to_owned());
    let _ = tx.enqueue(AgentEvent::ImageRequested {
        tool_call_id: tool_call_id.to_owned(),
        stem: Some(stem),
        saved_path: None,
        inline_base64: None,
        failure: None,
    });
}

async fn emit_update(tx: &SessionEventSink, p: &Value, context_model: Option<String>) {
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
            title: tool_activity(u["kind"].as_str().unwrap_or("other"), u, u["title"].as_str().unwrap_or("Tool call")).label,
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
            (used.is_some() || size.is_some()).then_some(AgentEvent::ContextUpdated { used, size, model: context_model, estimated: false })
        }
        "agent_turn_complete" | "current_mode_update" => None,
        _ => None,
    };
    if let Some(event) = event {
        let _ = tx.enqueue(event);
    }
}

fn is_child_usage_update(params: &Value) -> bool {
    params["update"]["sessionUpdate"].as_str() == Some("usage_update")
        && params["update"]["_meta"]["opencode/child-session"].is_string()
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
    // `apply_options` selects the agent's model config option before each
    // prompt (836-850), and refuses with ERR_MODEL_MISSING/REJECTED instead of
    // prompting when the agent does not accept it.
    fn model_switch(&self) -> ModelSwitch { ModelSwitch::KeepsSession }
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
                // A load that never came up (the agent failed to initialize or
                // the call timed out) cannot be resumed either: report it so the
                // caller can start a fresh session instead of failing the turn.
                AdapterError::Process(message) => AdapterError::ResumeFailed(message),
                AdapterError::Timeout => {
                    AdapterError::ResumeFailed("session/load timed out".into())
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
        // A changed instruction text or environment needs a process started
        // with the new configuration. Reconnect before options are applied so
        // the turn runs on the right process instead of failing.
        if Self::needs_reconnect(&c, &req.exec_options) {
            c = self.reconnect(&handle.session_id, &c, &req.exec_options).await?;
        }
        let provider_id = c.session_id.lock().await.clone().ok_or_else(|| AdapterError::Process("ACP session missing provider id".into()))?;
        if !req.attachments.is_empty() && !c.process.image_prompts.load(Ordering::Acquire) {
            return Err(AdapterError::Unsupported("This coding agent did not advertise image support.".into()));
        }
        let prompt = image_prompt_content(&req).await?;
        Self::apply_options(&c, &provider_id, &req.exec_options, Some(&req.turn_id)).await?;
        *c.usage.lock().await = exec::UsageSnap::default();
        {
            let _lifecycle = c.turn_lifecycle.lock().await;
            c.turn_completed.store(false, Ordering::SeqCst);
            c.cancelled_turn.store(false, Ordering::Release);
            *c.active_turn_id.lock().await = Some(req.turn_id.clone());
        }
        c.process.active_turns.lock().await.insert(provider_id.clone());
        c.prompt_ack_pending.store(true, Ordering::SeqCst);
        let result = match Self::request(
            &c,
            "session/prompt",
            json!({"sessionId": provider_id, "prompt": prompt}),
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                let value = serde_json::from_str::<Value>(&error.to_string().replace("provider protocol error: ", "")).unwrap_or_else(|_| json!({"message":error.to_string()}));
                c.process.active_turns.lock().await.remove(&provider_id);
                let (was_cancelled, had_active_turn) = {
                    let _lifecycle = c.turn_lifecycle.lock().await;
                    (c.cancelled_turn.swap(false, Ordering::AcqRel), c.active_turn_id.lock().await.take().is_some())
                };
                if was_cancelled { return Ok(()); }
                // Bitbots is giving this turn up. If the agent is still running it (the request failed on
                // our side, not because it answered), tell it to stop so nothing carries on unseen.
                // A "busy" refusal is about the previous turn, which must keep running.
                if !matches!(error, AdapterError::Process(_)) && !is_busy_reason(&Self::rpc_error_message(&error)) { Self::stop_provider_turn(&c, &provider_id).await; }
                if had_active_turn {
                    // The hint and the terminal event share one ordered stream,
                    // and the hint is only sent when an Error actually follows
                    // it, so a cancelled turn never leaves a stale hint behind.
                    if let Some(kind) = bloblex_agent_core::recovery::provider_recovery(&value) {
                        let _ = c.events.send(AgentEvent::RecoveryHint { kind, retry_after_secs: bloblex_agent_core::recovery::provider_retry_after(&value, chrono::Utc::now().timestamp()).map(|secs| secs.max(0) as u64) }).await;
                    }
                    Self::emit_turn_evidence(&c, &req.turn_id, &req.exec_options, None).await;
                    // TurnErrorReported keeps Result failure for callers while
                    // making that stream the daemon's only terminal owner.
                    let _ = c.events.send(AgentEvent::Error { message: failed_prompt_message(&Self::rpc_error_message(&error)) }).await;
                    return Err(failed_prompt_terminal(true));
                }
                // No active turn: no Error was queued, so the event stream has
                // no terminal owner and the daemon must finalize the turn.
                return Err(failed_prompt_terminal(false));
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
            if let Some(kind) = bloblex_agent_core::recovery::provider_recovery(&result) {
                let _ = c.events.send(AgentEvent::RecoveryHint { kind, retry_after_secs: bloblex_agent_core::recovery::provider_retry_after(&result, chrono::Utc::now().timestamp()).map(|secs| secs.max(0) as u64) }).await;
            }
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
                // Closing a conversation whose turn is still running (the watchdog does this when it gives
                // up on a quiet turn) must stop that turn first, or OpenCode keeps working on it unseen.
                if c.active_turn_id.lock().await.is_some() || c.process.active_turns.lock().await.contains(&provider_id) {
                    Self::stop_provider_turn(&c, &provider_id).await;
                }
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

    #[test]
    fn question_tool_cards_are_hidden_with_their_updates() {
        let mut calls = std::collections::HashSet::new();
        assert!(hides_question_card(&mut calls, &json!({"sessionUpdate":"tool_call","toolCallId":"q1","name":"question","title":"question"})));
        assert!(hides_question_card(&mut calls, &json!({"sessionUpdate":"tool_call_update","toolCallId":"q1","status":"failed"})));
        assert!(!hides_question_card(&mut calls, &json!({"sessionUpdate":"tool_call","toolCallId":"r1","name":"read","title":"read"})));
        assert!(!hides_question_card(&mut calls, &json!({"sessionUpdate":"tool_call_update","toolCallId":"r1","status":"completed"})));
    }

    #[tokio::test]
    async fn images_are_encoded_as_acp_content_blocks_without_exposing_a_local_path() {
        let path = std::env::temp_dir().join(format!("acp-image-{}.png", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, [137,80,78,71]).await.unwrap();
        let req = PromptRequest { turn_id:"image-test".into(), text:"Describe this".into(), exec_options:ExecOptions::default(), attachments:vec![PromptAttachment { path:path.clone(), name:"screenshot.png".into(), media_type:"image/png".into() }] };
        let content = image_prompt_content(&req).await.unwrap();
        assert_eq!(content, vec![json!({"type":"text","text":"Describe this"}), json!({"type":"image","mimeType":"image/png","data":"iVBORw=="})]);
        assert!(!serde_json::to_string(&content).unwrap().contains(path.to_str().unwrap()));
        tokio::fs::remove_file(path).await.unwrap();
    }

    #[tokio::test]
    async fn activity_titles_include_the_tool_target() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let sink = SessionEventSink::new(tx);
        for (kind, input, expected) in [
            ("read", json!({"path":"README.md"}), "Read README.md"),
            ("execute", json!({"command":"cargo test\necho complete"}), "Ran cargo test"),
        ] {
            emit_update(&sink, &json!({"update":{"sessionUpdate":"tool_call","toolCallId":"tool","kind":kind,"title":kind,"rawInput":input}}), None).await;
            assert!(matches!(rx.recv().await, Some(AgentEvent::ToolStarted { title, .. }) if title == expected), "{kind}");
        }
    }

    /// The image tool's finished update carries `rawOutput.metadata.path` (the
    /// stem, without an extension) and no tool name; the name arrives once, in
    /// the started update. The same call is reported once.
    #[tokio::test]
    async fn an_image_tool_update_reports_its_stem_once() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let sink = SessionEventSink::new(tx);
        let calls = tokio::sync::Mutex::new(ImageCalls::default());
        let stem = std::env::temp_dir().join("bitbots-image-test").to_string_lossy().into_owned();
        let started = json!({"sessionUpdate":"tool_call","toolCallId":"img-1","status":"in_progress","kind":"other","title":"experimental_image_generate","locations":[],"rawInput":{"prompt":"a cat"}});
        emit_image_request(&sink, &started, &calls).await;
        assert!(rx.try_recv().is_err(), "a started call has no path yet");
        let finished = json!({"sessionUpdate":"tool_call_update","toolCallId":"img-1","status":"completed","locations":[],"content":[{"type":"content","content":{"type":"text","text":"Image job started."}}],"rawOutput":{"metadata":{"path":stem,"model":"provider/model","jobID":"job-1"}}});
        emit_image_request(&sink, &finished, &calls).await;
        let Some(AgentEvent::ImageRequested { tool_call_id, stem: reported, saved_path, inline_base64, failure }) = rx.recv().await else { panic!("an image request was expected") };
        assert_eq!(tool_call_id, "img-1");
        assert_eq!(reported.as_deref(), Some(stem.as_str()));
        assert!(saved_path.is_none() && inline_base64.is_none() && failure.is_none());
        emit_image_request(&sink, &finished, &calls).await;
        assert!(rx.try_recv().is_err());
    }

    /// Only that tool's structured output counts: a tool that merely mentions a
    /// saved image in its text, or names a path in its own output, does not.
    #[tokio::test]
    async fn only_the_image_tool_can_name_an_image() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let sink = SessionEventSink::new(tx);
        let calls = tokio::sync::Mutex::new(ImageCalls::default());
        let absolute = std::env::temp_dir().join("bitbots-not-an-image.png").to_string_lossy().into_owned();
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call","toolCallId":"cmd-1","status":"in_progress","kind":"execute","title":"Ran a command"}), &calls).await;
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call_update","toolCallId":"cmd-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":format!("Saved image: {absolute}")}}]}), &calls).await;
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call","toolCallId":"read-1","status":"in_progress","kind":"read","title":"read"}), &calls).await;
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call_update","toolCallId":"read-1","status":"completed","rawOutput":{"metadata":{"path":absolute}}}), &calls).await;
        assert!(rx.try_recv().is_err());
    }

    /// A finished update for a call id that was never named as the image tool
    /// records nothing, even though it carries a structured path.
    #[tokio::test]
    async fn a_finished_update_for_an_unnamed_call_records_nothing() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let sink = SessionEventSink::new(tx);
        let calls = tokio::sync::Mutex::new(ImageCalls::default());
        let stem = std::env::temp_dir().join("bitbots-unnamed").to_string_lossy().into_owned();
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call_update","toolCallId":"other-9","status":"completed","rawOutput":{"metadata":{"path":stem,"model":"m","jobID":"j"}}}), &calls).await;
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call_update","toolCallId":"other-9","status":"completed","rawOutput":{"path":stem}}), &calls).await;
        assert!(rx.try_recv().is_err());
    }

    /// A shell call's title comes from the model, so a command titled after the
    /// image tool must never name a file — not even with JSON in its output.
    #[tokio::test]
    async fn a_shell_call_titled_like_the_image_tool_names_nothing() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let sink = SessionEventSink::new(tx);
        let calls = tokio::sync::Mutex::new(ImageCalls::default());
        let stem = std::env::temp_dir().join("bitbots-shell-claim").to_string_lossy().into_owned();
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call","toolCallId":"sh-1","status":"in_progress","kind":"execute","title":"experimental_image_generate","rawInput":{"command":"echo hi"}}), &calls).await;
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call_update","toolCallId":"sh-1","status":"completed","kind":"execute","title":"experimental_image_generate","content":[{"type":"content","content":{"type":"text","text":format!(r#"{{"path":"{stem}"}}"#)}}],"rawOutput":{"metadata":{"path":stem,"jobID":"j-1"}}}), &calls).await;
        assert!(rx.try_recv().is_err());
    }

    /// A notice may only finish a call this session already knows; alone, it
    /// records nothing and names no file.
    #[tokio::test]
    async fn a_notice_with_no_known_call_records_nothing() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let sink = SessionEventSink::new(tx);
        let calls = tokio::sync::Mutex::new(ImageCalls::default());
        let file = std::env::temp_dir().join("bitbots-orphan.png").to_string_lossy().into_owned();
        emit_image_request(&sink, &json!({"sessionUpdate":"notice","severity":"info","title":"Image generation","description":format!("Image request finished. Saved image: {file} (provider/model).")}), &calls).await;
        emit_image_request(&sink, &json!({"sessionUpdate":"notice","severity":"error","title":"Image generation","description":"Image request failed for /tmp/x: nope"}), &calls).await;
        assert!(rx.try_recv().is_err());
    }

    /// A stem that is not absolute records nothing at all.
    #[tokio::test]
    async fn a_relative_image_stem_records_nothing() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let sink = SessionEventSink::new(tx);
        let calls = tokio::sync::Mutex::new(ImageCalls::default());
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call","toolCallId":"img-2","status":"in_progress","title":"experimental_image_generate"}), &calls).await;
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call_update","toolCallId":"img-2","status":"completed","rawOutput":{"metadata":{"path":"images/out"}}}), &calls).await;
        assert!(rx.try_recv().is_err());
    }

    /// A failed image names its reason, from the error the runtime put in the
    /// structured output.
    #[tokio::test]
    async fn a_failed_image_tool_update_reports_the_reason() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let sink = SessionEventSink::new(tx);
        let calls = tokio::sync::Mutex::new(ImageCalls::default());
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call","toolCallId":"img-3","status":"in_progress","title":"experimental_image_generate"}), &calls).await;
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call_update","toolCallId":"img-3","status":"failed","title":"experimental_image_generate","rawOutput":{"metadata":{},"error":"No image model is available.\ntry later"}}), &calls).await;
        let Some(AgentEvent::ImageRequested { failure, stem, .. }) = rx.recv().await else { panic!("a failed image was expected") };
        assert_eq!(failure.as_deref(), Some("No image model is available."));
        assert!(stem.is_none());
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call_update","toolCallId":"img-3","status":"failed","rawOutput":{"error":"No image model is available."}}), &calls).await;
        assert!(rx.try_recv().is_err());
    }

    /// A completion notice, when one arrives, gives the exact file or the reason;
    /// it is attached to the only request this session reported.
    #[tokio::test]
    async fn an_image_completion_notice_names_the_exact_file_or_the_failure() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let sink = SessionEventSink::new(tx);
        let calls = tokio::sync::Mutex::new(ImageCalls::default());
        let stem = std::env::temp_dir().join("bitbots-notice").to_string_lossy().into_owned();
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call","toolCallId":"img-4","status":"in_progress","title":"experimental_image_generate"}), &calls).await;
        emit_image_request(&sink, &json!({"sessionUpdate":"tool_call_update","toolCallId":"img-4","status":"completed","rawOutput":{"metadata":{"path":stem,"model":"provider/model","jobID":"job-9"}}}), &calls).await;
        let _ = rx.recv().await;
        let file = std::env::temp_dir().join("bitbots-notice.png").to_string_lossy().into_owned();
        emit_image_request(&sink, &json!({"sessionUpdate":"notice","severity":"info","title":"Image generation","description":format!("Image request finished. Saved image: {file} (provider/model).")}), &calls).await;
        let Some(AgentEvent::ImageRequested { tool_call_id, saved_path, failure, .. }) = rx.recv().await else { panic!("a finished image was expected") };
        assert_eq!(tool_call_id, "img-4");
        assert_eq!(saved_path.as_deref(), Some(file.as_str()));
        assert!(failure.is_none());
        emit_image_request(&sink, &json!({"sessionUpdate":"notice","severity":"error","title":"Image generation","description":"Image request failed for something: quota exhausted"}), &calls).await;
        let Some(AgentEvent::ImageRequested { failure, .. }) = rx.recv().await else { panic!("a failed image was expected") };
        assert_eq!(failure.as_deref(), Some("quota exhausted"));
    }

    /// A failed prompt with no active turn queues no `Error` event, so the
    /// adapter must not claim the stream owns the turn: it returns `Protocol`
    /// and lets the daemon finalize it. With an active turn the queued `Error`
    /// makes the stream the terminal owner, so it returns `TurnErrorReported`.
    #[test]
    fn a_failed_prompt_without_an_active_turn_is_a_protocol_error() {
        assert!(
            matches!(failed_prompt_terminal(false), AdapterError::Protocol(_)),
            "no Error event was queued, so the daemon finalizes the turn"
        );
        assert!(
            matches!(failed_prompt_terminal(true), AdapterError::TurnErrorReported(_)),
            "the queued Error event owns the turn"
        );
    }

    #[test]
    fn a_prompt_has_no_timer_and_other_requests_keep_theirs() {
        assert_eq!(AcpAdapter::request_timeout("session/prompt"), None);
        assert_eq!(AcpAdapter::request_timeout("session/new"), Some(Duration::from_secs(20)));
        TEST_REQUEST_TIMEOUT_MS.store(300, Ordering::Relaxed);
        let (prompt, other) = (AcpAdapter::request_timeout("session/prompt"), AcpAdapter::request_timeout("session/set_config_option"));
        TEST_REQUEST_TIMEOUT_MS.store(0, Ordering::Relaxed);
        assert_eq!(prompt, None, "no setting gives a turn a timer");
        assert_eq!(other, Some(Duration::from_millis(300)));
    }

    #[test]
    fn a_failed_prompt_message_gives_the_reason_a_busy_sentence_or_the_fallback() {
        assert_eq!(failed_prompt_message("provider failed"), "OpenCode prompt failed: provider failed");
        assert_eq!(failed_prompt_message("first line\n  second   line"), "OpenCode prompt failed: first line second line");
        assert_eq!(failed_prompt_message(""), "OpenCode prompt failed");
        assert_eq!(failed_prompt_message("   "), "OpenCode prompt failed");
        assert_eq!(failed_prompt_message(&"x".repeat(500)).chars().count(), "OpenCode prompt failed: ".len() + 200);
        let busy = failed_prompt_message("Session is busy");
        assert!(busy.starts_with("OpenCode is still working on the previous message.") && !busy.contains("Session is busy"), "{busy}");
    }

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
            emit_update(&tx, &params, None).await;
            assert!(matches!(rx.recv().await, Some(AgentEvent::AssistantDelta { text }) if text == "hello"));
            emit_update(&tx, &usage, Some("opencode-go/deepseek-v4.1-flash".into())).await;
            assert!(matches!(rx.recv().await, Some(AgentEvent::ContextUpdated { used: Some(1), size: Some(2), model: Some(ref model), estimated:false }) if model == "opencode-go/deepseek-v4.1-flash"));
            emit_update(&tx, &json!({"sessionId":"s","update":{"sessionUpdate":"session_info_update","title":"ACP generated title"}}), None).await;
            assert!(matches!(rx.recv().await, Some(AgentEvent::SessionTitle { title }) if title == "ACP generated title"));
            assert!(rx.try_recv().is_err());
        });
        assert_eq!(id_key(&json!("1")), "1");
        assert_eq!(id_key(&json!(1)), "1");
    }

    #[test]
    fn child_session_usage_is_not_attributed_to_parent_context() {
        let update = json!({"update":{"sessionUpdate":"usage_update","used":300,"size":1000,"_meta":{"opencode/child-session":"child-id"}}});
        assert!(is_child_usage_update(&update));
        let parent = json!({"update":{"sessionUpdate":"usage_update","used":300,"size":1000}});
        assert!(!is_child_usage_update(&parent));
    }
}
