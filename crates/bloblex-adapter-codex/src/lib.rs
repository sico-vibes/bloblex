//! Codex app-server adapter over JSON-RPC stdio; never reads terminal UI output.
use async_trait::async_trait;
use bloblex_agent_core::*;
use bloblex_process::{prepare_command, ProcessTree, StdinWriter};
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex as StdMutex, Weak,
    },
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::{oneshot, Mutex},
};

const RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const CATALOG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const SHA256_EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

fn sha256_fingerprint(value: &str) -> String {
    instruction_sha256(value).unwrap_or_else(|| SHA256_EMPTY.to_owned())
}
struct Conn {
    process: Arc<SharedProcess>,
    process_key: String,
    detached: AtomicBool,
    runtime: RuntimeSpec,
    cwd: std::path::PathBuf,
    base_options: ExecOptions,
    incoming: Mutex<HashMap<String, Value>>,
    turn_id: Mutex<Option<String>>,
    events: SessionEventSink,
    meta: Mutex<ThreadMeta>,
    turn: Mutex<TurnState>,
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

const SHARED_PROCESS_IDLE_SHUTDOWN: std::time::Duration = std::time::Duration::from_secs(30);
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
struct TurnState {
    id: Option<String>,
    thread_id: Option<String>,
    replay_gate: bool,
    options: ExecOptions,
    usage: Option<Value>,
    completed: bool,
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
    processes: Arc<Mutex<HashMap<String, Arc<SharedProcess>>>>,
    start_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    instruction_context: Mutex<HashMap<String, (Option<String>, Option<String>)>>,
    thread_instruction_hashes: Mutex<HashMap<String, Option<String>>>,
    idle_shutdown_ms: AtomicU64,
}
impl CodexAdapter {
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

    #[doc(hidden)]
    pub fn with_idle_shutdown(timeout: std::time::Duration) -> Self {
        let adapter = Self::default();
        adapter.idle_shutdown_ms.store(timeout.as_millis().max(1) as u64, Ordering::Relaxed);
        adapter
    }

    fn idle_shutdown(&self) -> std::time::Duration {
        let millis = self.idle_shutdown_ms.load(Ordering::Relaxed);
        if millis == 0 { SHARED_PROCESS_IDLE_SHUTDOWN } else { std::time::Duration::from_millis(millis) }
    }

    async fn spawn(
        &self,
        r: &RuntimeSpec,
        cwd: &Path,
        events: EventSender,
        options: &ExecOptions,
    ) -> Result<Arc<Conn>, AdapterError> {
        let inherited = std::env::vars_os()
            .map(|(key, value)| format!("{key:?}={value:?}\n"))
            .collect::<String>();
        let key_data = json!({
            "runtime": r.runtime_id,
            "executable": r.executable,
            "args": r.args,
            "cwd": cwd,
            "env": options.env,
            "inheritedEnvironment": sha256_fingerprint(&inherited),
        });
        let key = sha256_fingerprint(&key_data.to_string());
        let process = self.acquire_process(&key, r, cwd, options).await?;
        Ok(Arc::new(Conn {
            process,
            process_key: key,
            detached: AtomicBool::new(false),
            runtime: r.clone(),
            cwd: cwd.to_path_buf(),
            base_options: options.clone(),
            incoming: Mutex::new(HashMap::new()),
            turn_id: Mutex::new(None),
            events: SessionEventSink::new(events),
            meta: Mutex::new(ThreadMeta::default()),
            turn: Mutex::new(TurnState::default()),
        }))
    }

    async fn spawn_process(
        r: &RuntimeSpec,
        cwd: &Path,
        options: &ExecOptions,
    ) -> Result<Arc<SharedProcess>, AdapterError> {
        let mut c = Command::new(&r.executable);
        prepare_command(&mut c);
        c.args(&r.args)
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for (key, value) in &options.env {
            if !["LANG", "LC_ALL", "TZ", "NO_COLOR", "TERM"].contains(&key.as_str())
                || value.contains('\0')
            {
                return Err(AdapterError::Unsupported("custom environment contains an unsupported key".into()));
            }
            c.env(key, value);
        }
        let mut child = c
            .spawn()
            .map_err(|e| AdapterError::Process(e.to_string()))?;
        let process_tree = ProcessTree::attach(&mut child).map_err(|e| AdapterError::Process(e.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AdapterError::Process("app-server stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Process("app-server stdout unavailable".into()))?;
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
            setup: Mutex::new(()),
            alive: AtomicBool::new(true),
            shutdown_started: AtomicBool::new(false),
            intentional_shutdown: AtomicBool::new(false),
        });
        let reader = process.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let request_id = v.get("id").map(id_key);
                if let Some(id) = request_id.as_ref() {
                    if let Some(tx) = reader.pending.lock().await.remove(id) {
                        let result = if v.get("error").is_some() { Err(AdapterError::Rejected(v["error"].to_string())) }
                            else { Ok(v.get("result").cloned().unwrap_or(Value::Null)) };
                        let _ = tx.send(result);
                        continue;
                    }
                }
                let method = v["method"].as_str().unwrap_or("");
                let p = &v["params"];
                let thread_id = p["threadId"].as_str().unwrap_or("");
                let Some(r) = reader.routes.lock().await.get(thread_id).and_then(Weak::upgrade) else { continue; };
                if request_id.is_some() {
                    if v["method"]
                        .as_str()
                        .is_some_and(|m| m.ends_with("requestApproval"))
                    {
                        let key = format!("{}:{}", thread_id, request_id.as_deref().unwrap_or("unknown-request"));
                        r.incoming.lock().await.insert(key.clone(), v["id"].clone());
                        let _ = r.events.enqueue(AgentEvent::PermissionRequested {
                                provider_request_id: key,
                                title: "Codex approval request".into(),
                                detail: Some(p.to_string()),
                                choices: vec!["allow_once".into(), "deny".into()],
                                raw: v.clone(),
                        });
                    }
                }
                if !method.is_empty() {
                    let expected = r.turn.lock().await.id.clone();
                    if method == "turn/started" {
                        let thread_id = r.turn.lock().await.thread_id.clone();
                        if thread_id.as_deref() == p["threadId"].as_str() {
                            let mut state = r.turn.lock().await;
                            state.id = p["turn"]["id"].as_str().map(str::to_owned);
                            state.replay_gate = false;
                        }
                        continue;
                    }
                    if method.starts_with("item/") {
                        let state = r.turn.lock().await;
                        if state.replay_gate
                            || state.thread_id.as_deref() != p["threadId"].as_str()
                            || state.id.as_deref() != p["turnId"].as_str()
                        {
                            continue;
                        }
                    }
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
                                if t.completed { continue; }
                                t.completed = true;
                                (t.options.clone(), t.usage.take())
                            };
                            reader.active_turns.lock().await.remove(thread_id);
                            let turn_id = r.turn_id.lock().await.clone().unwrap_or_default();
                            let meta = r.meta.lock().await.clone();
                            let report = usage_report(usage.as_ref(), meta.model.clone(), !failed);
                            let _ = r.events.enqueue(AgentEvent::UsageReport {
                                    turn_id: turn_id.clone(),
                                    report,
                            });
                            if success {
                                let outcomes =
                                    outcomes_for_success(&meta, &options, usage.as_ref());
                                if !outcomes.is_empty() {
                                    let _ = r.events.enqueue(AgentEvent::ExecApplied { turn_id, outcomes });
                                }
                                r.meta.lock().await.first_success_pending = false;
                                let _ = r.events.enqueue(AgentEvent::TurnCompleted);
                            } else if status == "interrupted" {
                                let _ = r.events.enqueue(AgentEvent::TurnCancelled);
                            } else if context_exhausted_evidence(
                                &p["turn"]["error"].to_string(),
                            ) {
                                let _ = r.events.enqueue(AgentEvent::ContextExhausted);
                            } else {
                                let _ = r.events.enqueue(AgentEvent::Error { message: p["turn"]["error"].to_string() });
                            }
                        }
                        _ => {
                            if let Some(e) = map_notification(method, p) {
                                let _ = r.events.enqueue(e);
                            }
                        }
                    }
                }
            }
            reader.alive.store(false, Ordering::Release);
            for (_, tx) in std::mem::take(&mut *reader.pending.lock().await) {
                let _ = tx.send(Err(AdapterError::Process("Codex app-server exited".into())));
            }
            let sessions = reader.routes.lock().await.values().filter_map(Weak::upgrade).collect::<Vec<_>>();
            for session in sessions {
                let (turn_id, usage, active) = {
                    let mut turn = session.turn.lock().await;
                    let active = turn.id.is_some() && !turn.completed;
                    turn.completed = true;
                    (session.turn_id.lock().await.clone().unwrap_or_default(), turn.usage.take(), active)
                };
                if active {
                    let model = session.meta.lock().await.model.clone();
                    let _ = session.events.enqueue(AgentEvent::UsageReport {
                        turn_id,
                        report: usage_report(usage.as_ref(), model, false),
                    });
                }
                if !reader.intentional_shutdown.load(Ordering::Acquire) {
                    let _ = session.events.enqueue(AgentEvent::Error { message: "Codex app-server exited unexpectedly".into() });
                }
            }
            reader.shutdown().await;
        });
        Ok(process)
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
        let previous_id = old.turn.lock().await.thread_id.clone().ok_or_else(|| AdapterError::Process("Codex session has no provider thread".into()))?;
        let new = Arc::new(Conn {
            process,
            process_key: old.process_key.clone(),
            detached: AtomicBool::new(false),
            runtime: old.runtime.clone(),
            cwd: old.cwd.clone(),
            base_options: old.base_options.clone(),
            incoming: Mutex::new(HashMap::new()),
            turn_id: Mutex::new(old.turn_id.lock().await.clone()),
            events: old.events.clone(),
            meta: Mutex::new(old.meta.lock().await.clone()),
            turn: Mutex::new(TurnState { thread_id: Some(previous_id.clone()), ..TurnState::default() }),
        });
        let setup = async {
            let resumed = Self::startup_call(
                &new,
                "thread/resume",
                Self::resume_params(&previous_id, &new.cwd, &new.base_options),
            ).await;
            let (thread, fresh) = match resumed {
                Ok(thread) => (thread, false),
                Err(AdapterError::ResumeRejected) => {
                    (Self::startup_call(&new, "thread/start", Self::start_params(&new.cwd, &new.base_options)).await?, true)
                }
                Err(error) => return Err(error),
            };
            let id = thread["thread"]["id"].as_str().or(thread["id"].as_str()).unwrap_or(&previous_id).to_owned();
            if fresh {
                let hash = instruction_sha256(new.base_options.instructions.as_deref().unwrap_or(""));
                Self::set_thread_meta(&new, &thread, hash.clone(), hash.clone(), true).await;
                self.thread_instruction_hashes.lock().await.insert(session_id.to_owned(), hash);
            } else {
                let previous = old.meta.lock().await.clone();
                Self::set_thread_meta(&new, &thread, previous.desired_hash, previous.baseline_hash, previous.first_success_pending).await;
            }
            Ok::<(String, bool), AdapterError>((id, fresh))
        }.await;
        let (id, fresh) = match setup {
            Ok(values) => values,
            Err(error) => { self.abandon_setup(&new).await; return Err(error); }
        };
        new.turn.lock().await.thread_id = Some(id.clone());
        new.process.routes.lock().await.insert(id.clone(), Arc::downgrade(&new));
        if fresh {
            let _ = new.events.enqueue(AgentEvent::SessionStarted { provider_session_id: id.clone() });
        }
        self.sessions.lock().await.insert(session_id.to_owned(), new.clone());
        Ok(new)
    }
    async fn call(c: &Conn, m: &str, p: Value) -> Result<Value, AdapterError> {
        let id = c.process.next.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = oneshot::channel();
        c.process.pending.lock().await.insert(id.clone(), tx);
        let mut b = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":m,"params":p}))
            .map_err(|e| AdapterError::Protocol(e.to_string()))?;
        b.push(b'\n');
        if let Err(e) = c.process.stdin.lock().await.write(&b).await {
            c.process.pending.lock().await.remove(&id);
            return Err(AdapterError::Process(e.to_string()));
        }
        match tokio::time::timeout(RPC_TIMEOUT, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => Err(AdapterError::Process("app-server closed".into())),
            Err(_) => {
                c.process.pending.lock().await.remove(&id);
                Err(AdapterError::Timeout)
            }
        }
    }
    async fn notify(c: &Conn, m: &str, p: Value) -> Result<(), AdapterError> {
        let mut b = serde_json::to_vec(&json!({"jsonrpc":"2.0","method":m,"params":p}))
            .map_err(|e| AdapterError::Protocol(e.to_string()))?;
        b.push(b'\n');
        c.process.stdin
            .lock()
            .await
            .write(&b)
            .await
            .map_err(|e| AdapterError::Process(e.to_string()))
    }
    async fn initialize(c: &Conn) -> Result<(), AdapterError> {
        let _guard = c.process.setup.lock().await;
        if c.process.initialized.load(Ordering::Acquire) { return Ok(()); }
        Self::call(c,"initialize",json!({"clientInfo":{"name":"Bloblex","version":"0.1.0"},"capabilities":{"experimentalApi":false}})).await.map_err(|e| match e { AdapterError::Rejected(message) => AdapterError::Protocol(message), other => other })?;
        Self::notify(c, "initialized", json!({})).await?;
        c.process.initialized.store(true, Ordering::Release);
        Ok(())
    }
    async fn startup_call(c: &Conn, method: &str, params: Value) -> Result<Value, AdapterError> {
        let result = match Self::initialize(c).await {
            Ok(()) => Self::call(c, method, params).await,
            Err(e) => Err(e),
        };
        match result {
            Err(AdapterError::Rejected(message))
                if method == "thread/resume" && context_exhausted_evidence(&message) =>
            {
                Err(AdapterError::ContextExhausted)
            }
            Err(AdapterError::Rejected(message))
                if method == "thread/resume" && resume_rejected_evidence(&message) =>
            {
                Err(AdapterError::ResumeRejected)
            }
            other => other,
        }
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

fn resume_rejected_evidence(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    (message.contains("thread") || message.contains("session"))
        && ["not found", "expired", "does not exist", "unknown id"]
            .iter()
            .any(|evidence| message.contains(evidence))
}

fn context_exhausted_evidence(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "context window is full",
        "prompt is too long",
        "maximum context length",
        "resume overflow",
        "compaction failed: context",
        "thread context overflow",
    ]
        .iter()
        .any(|evidence| message.contains(evidence))
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
        is_default: m["isDefault"].as_bool(),
        group: None,
        availability: None,
        reported_price: None,
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
    stdin: &StdinWriter,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), AdapterError> {
    let mut b =
        serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .map_err(|e| AdapterError::Protocol(e.to_string()))?;
    b.push(b'\n');
    stdin
        .write(&b)
        .await
        .map_err(|e| AdapterError::Process(e.to_string()))
}
async fn catalog_pages(r: &RuntimeSpec) -> Result<Vec<Value>, AdapterError> {
    let mut cmd = Command::new(&r.executable);
    prepare_command(&mut cmd);
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
    let process_tree = ProcessTree::attach(&mut child).map_err(|e| AdapterError::Process(e.to_string()))?;
    let result = async {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AdapterError::Process("catalog stdin unavailable".into()))?;
        let stdin = StdinWriter::new(stdin);
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Process("catalog stdout unavailable".into()))?;
        let mut lines = BufReader::new(stdout).lines();
        write_rpc(&stdin,1,"initialize",json!({"clientInfo":{"name":"Bloblex","version":"0.1.0"},"capabilities":{"experimentalApi":false}})).await?;
        let _ = read_reply(&mut lines, 1).await?;
        let mut b =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","method":"initialized","params":{}}))
                .unwrap();
        b.push(b'\n');
        stdin
            .write(&b)
            .await
            .map_err(|e| AdapterError::Process(e.to_string()))?;
        let mut cursor = Value::Null;
        let mut seen = std::collections::HashSet::new();
        let mut pages = Vec::new();
        let mut id = 1;
        loop {
            id += 1;
            write_rpc(
                &stdin,
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
    let _ = process_tree.terminate();
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
            source: "live_query".into(),
            validated: true,
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
        prepare_command(&mut c);
        c.args(&r.args)
            .args(["app-server", "--help"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = c.spawn().map_err(|e| AdapterError::Process(e.to_string()))?;
        let process_tree = ProcessTree::attach(&mut child).map_err(|e| AdapterError::Process(e.to_string()))?;
        let o = tokio::time::timeout(std::time::Duration::from_secs(6), child.wait_with_output())
            .await
            .map_err(|_| { let _ = process_tree.terminate(); AdapterError::Process("Codex app-server probe timed out".into()) })?
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
        let c = self.spawn(r, &q.project_path, events, &q.exec_options).await?;
        let t = match Self::startup_call(
            &c,
            "thread/start",
            Self::start_params(&q.project_path, &q.exec_options),
        )
        .await {
            Ok(thread) => thread,
            Err(error) => { self.abandon_setup(&c).await; return Err(error); }
        };
        let Some(tid) = t["thread"]["id"]
            .as_str()
            .or(t["id"].as_str())
            .map(str::to_owned)
        else {
            self.abandon_setup(&c).await;
            return Err(AdapterError::Protocol(
                "thread/start returned no thread id".into(),
            ));
        };
        c.turn.lock().await.thread_id = Some(tid.clone());
        c.process.routes.lock().await.insert(tid.clone(), Arc::downgrade(&c));
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
        let c = self.spawn(r, &q.project_path, events, &q.exec_options).await?;
        let t = match Self::startup_call(
            &c,
            "thread/resume",
            Self::resume_params(&q.provider_session_id, &q.project_path, &q.exec_options),
        )
        .await {
            Ok(thread) => thread,
            Err(error) => { self.abandon_setup(&c).await; return Err(error); }
        };
        let id = t["thread"]["id"]
            .as_str()
            .unwrap_or(&q.provider_session_id)
            .to_owned();
        c.turn.lock().await.thread_id = Some(id.clone());
        c.process.routes.lock().await.insert(id.clone(), Arc::downgrade(&c));
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
        let mut c = self
            .sessions
            .lock()
            .await
            .get(&h.session_id)
            .cloned()
            .ok_or_else(|| AdapterError::Process("Codex session is not active".into()))?;
        if c.detached.load(Ordering::Acquire) || !c.process.alive.load(Ordering::Acquire) {
            c = self.resume_after_crash(&h.session_id, &c).await?;
        }
        let provider_thread = c.turn.lock().await.thread_id.clone().ok_or_else(|| AdapterError::Process("Codex session has no provider thread".into()))?;
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
            json!({"threadId":provider_thread,"input":[{"type":"text","text":q.text}]});
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
            thread_id: Some(provider_thread.clone()),
            replay_gate: true,
            options: q.exec_options,
            usage: None,
            completed: false,
        };
        *c.turn_id.lock().await = Some(q.turn_id);
        c.process.active_turns.lock().await.insert(provider_thread.clone());
        let result = match Self::call(&c, "turn/start", p).await {
            Ok(result) => result,
            Err(error) => {
                c.process.active_turns.lock().await.remove(&provider_thread);
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
        {
            let mut turn = c.turn.lock().await;
            turn.id = Some(id);
            turn.completed = false;
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
            .ok_or_else(|| AdapterError::Process("Codex session is not active".into()))?;
        let t = c
            .turn
            .lock()
            .await
            .id
            .clone()
            .ok_or_else(|| AdapterError::Unsupported("there is no active Codex turn".into()))?;
        let thread_id = c.turn.lock().await.thread_id.clone().ok_or_else(|| AdapterError::Process("Codex session has no provider thread".into()))?;
        let interrupted = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            Self::call(&c, "turn/interrupt", json!({"threadId":thread_id,"turnId":t})),
        ).await;
        if matches!(interrupted, Ok(Ok(_))) {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
            while !c.turn.lock().await.completed && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }
        if !c.turn.lock().await.completed {
            let (turn_id, usage) = {
                let mut state = c.turn.lock().await;
                state.completed = true;
                state.replay_gate = true;
                (c.turn_id.lock().await.clone().unwrap_or_default(), state.usage.take())
            };
            c.process.active_turns.lock().await.remove(&thread_id);
            let model = c.meta.lock().await.model.clone();
            let _ = c.events.enqueue(AgentEvent::UsageReport {
                turn_id,
                report: usage_report(usage.as_ref(), model, false),
            });
            let _ = c.events.enqueue(AgentEvent::TurnCancelled);
            self.detach_route(&c, Some(&thread_id), true).await;
        }
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
                c.process.stdin
                    .lock()
                    .await
                    .write(&b)
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
            let thread_id = c.turn.lock().await.thread_id.clone();
            let became_idle = self.detach_route(&c, thread_id.as_deref(), false).await;
            if became_idle { self.schedule_idle_shutdown(&c).await; }
        }
        Ok(())
    }

    async fn shutdown(&self) {
        let processes = {
            let mut map = self.processes.lock().await;
            std::mem::take(&mut *map)
        };
        for process in processes.into_values() { process.shutdown().await; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_environment_fingerprint_handles_empty_environment() {
        assert_eq!(sha256_fingerprint(""), SHA256_EMPTY);
    }

    #[tokio::test]
    async fn session_relay_coalesces_streams_but_keeps_critical_events() {
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
        for event in [
            AgentEvent::PermissionRequested {
                provider_request_id: "permission".into(),
                title: "Approval".into(), detail: None,
                choices: vec!["allow_once".into()], raw: json!({}),
            },
            AgentEvent::UsageReport { turn_id: "turn".into(), report: usage_report(None, None, false) },
            AgentEvent::ToolCompleted { tool_call_id: "tool".into(), raw: json!({}) },
            AgentEvent::Error { message: "provider failed".into() },
            AgentEvent::TurnCompleted,
        ] { sink.enqueue(event).unwrap(); }
        assert!(sink.0.events.lock().unwrap().len() <= SESSION_FORWARD_QUEUE_COALESCE_CAP + 8);
        let drain = tokio::spawn(async move {
            let mut events = Vec::new();
            let mut chars = 0;
            let mut thinking_chars = 0;
            let mut merged = false;
            let mut merged_thinking = false;
            let mut progress_updates = 0;
            loop {
                let event = receiver.recv().await.expect("relay channel stays open");
                match &event {
                    AgentEvent::AssistantDelta { text } => { chars += text.len(); merged |= text.len() > 1; }
                    AgentEvent::ThinkingDelta { text } => { thinking_chars += text.len(); merged_thinking |= text.len() > 1; }
                    AgentEvent::ToolUpdated { raw, .. } => { progress_updates += 1; assert_eq!(raw["progress"], 2); }
                    _ => {}
                }
                let terminal = matches!(&event, AgentEvent::TurnCompleted);
                events.push(event);
                if terminal { break (events, chars, thinking_chars, merged, merged_thinking, progress_updates); }
            }
        });
        let (events, chars, thinking_chars, merged, merged_thinking, progress_updates) = tokio::time::timeout(std::time::Duration::from_secs(5), drain).await.unwrap().unwrap();
        assert_eq!(chars, stream_count + SESSION_FORWARD_QUEUE_COALESCE_CAP / 2 - 1);
        assert_eq!(thinking_chars, stream_count + SESSION_FORWARD_QUEUE_COALESCE_CAP / 2 - 1);
        assert!(merged);
        assert!(merged_thinking);
        assert_eq!(progress_updates, 1);
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
        let delivered = tokio::time::timeout(std::time::Duration::from_secs(15), async {
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
