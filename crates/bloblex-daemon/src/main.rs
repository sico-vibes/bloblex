use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use bloblex_adapter_acp::AcpAdapter;
use bloblex_adapter_claude::ClaudeAdapter;
use bloblex_adapter_codex::CodexAdapter;
use bloblex_agent_core::{
    AgentAdapter, AgentEvent, NewSessionRequest, PromptRequest, ResumeSessionRequest, RuntimeSpec,
    SessionHandle,
};
use bloblex_protocol::{
    DaemonReady, EventEnvelope, RpcError, RpcRequest, RpcResponse, PROTOCOL_VERSION,
};
use bloblex_security::{capability_matches, is_loopback, new_capability};
use bloblex_storage::Storage;
use chrono::Utc;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::HashMap, future::IntoFuture, net::SocketAddr, path::PathBuf, sync::Arc,
    time::Instant,
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, Mutex, RwLock},
};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    token: Arc<String>,
    started: Instant,
    db: Arc<Storage>,
    events: broadcast::Sender<EventEnvelope>,
    runtimes: Arc<RwLock<Vec<Value>>>,
    adapters: Arc<Adapters>,
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
    active_turns: Arc<Mutex<HashMap<String, String>>>,
    stopping: Arc<tokio::sync::Notify>,
}
#[derive(Clone)]
struct Adapters {
    acp: Arc<AcpAdapter>,
    codex: Arc<CodexAdapter>,
    claude: Arc<ClaudeAdapter>,
}
#[derive(Clone)]
struct ActiveSession {
    handle: SessionHandle,
    runtime: RuntimeSpec,
    adapter: Arc<dyn AgentAdapter>,
}
impl AppState {
    async fn emit(&self, kind: &str, payload: Value) {
        if let Ok((sequence, event_id, timestamp)) = self.db.push_event(kind, &payload) {
            let _ = self.events.send(EventEnvelope {
                v: 1,
                event_id,
                sequence,
                timestamp,
                event_type: kind.into(),
                payload,
            });
        }
    }
}

fn auth(headers: &HeaderMap, token: &str) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let Some(supplied) = value.strip_prefix("Bearer ") else {
        return false;
    };
    capability_matches(token, supplied)
}
async fn main_rpc(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RpcRequest>,
) -> impl IntoResponse {
    if !is_loopback(peer) {
        return (
            StatusCode::FORBIDDEN,
            Json(error(req.id, "unauthorized", "loopback clients only")),
        );
    }
    if !auth(&headers, &st.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(error(
                req.id,
                "unauthorized",
                "missing or invalid daemon capability",
            )),
        );
    }
    if req.v != PROTOCOL_VERSION {
        return (
            StatusCode::BAD_REQUEST,
            Json(error(req.id, "unsupported", "protocol version mismatch")),
        );
    }
    let id = req.id.clone();
    match dispatch(&st, req.method.as_str(), req.params).await {
        Ok(v) => (
            StatusCode::OK,
            Json(RpcResponse {
                v: PROTOCOL_VERSION,
                id,
                ok: true,
                result: Some(v),
                error: None,
            }),
        ),
        Err(e) => (
            e.0,
            Json(RpcResponse {
                v: PROTOCOL_VERSION,
                id,
                ok: false,
                result: None,
                error: Some(e.1),
            }),
        ),
    }
}
fn error(id: String, code: &str, message: &str) -> RpcResponse {
    RpcResponse {
        v: PROTOCOL_VERSION,
        id,
        ok: false,
        result: None,
        error: Some(RpcError {
            code: code.into(),
            message: message.into(),
        }),
    }
}
type DispatchError = (StatusCode, RpcError);
fn derr(code: &str, msg: &str, status: StatusCode) -> DispatchError {
    (
        status,
        RpcError {
            code: code.into(),
            message: msg.into(),
        },
    )
}

async fn dispatch(st: &AppState, method: &str, p: Value) -> Result<Value, DispatchError> {
    match method {
        "app.snapshot" => st.db.snapshot().map_err(|e| {
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }),
        "hook.event" => {
            let event = &p["event"];
            let name = event["hook_event_name"].as_str().unwrap_or("unknown");
            let payload = json!({
                "hookEvent": name,
                "sessionId": event["session_id"],
                "toolName": event["tool_name"],
            });
            st.emit("hook.observed", payload).await;
            Ok(json!({"received":true,"failOpen":true}))
        }
        "events.replay" => {
            let after = p["afterSequence"].as_u64().unwrap_or(0);
            let ev = st.db.replay_events(after, 1000).map_err(|e| {
                derr(
                    "internal",
                    &e.to_string(),
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            })?;
            Ok(
                json!({"replayAvailable":!ev.first().is_some_and(|e|e["replayAvailable"]==false),"events":ev}),
            )
        }
        "daemon.health" => Ok(
            json!({"state":"ready","version":env!("CARGO_PKG_VERSION"),"uptimeSeconds":st.started.elapsed().as_secs(),"heartbeatAt":Utc::now().to_rfc3339()}),
        ),
        "daemon.shutdown" => {
            st.stopping.notify_waiters();
            Ok(json!({"stopping":true}))
        }
        "runtime.list" => Ok(json!({"runtimes":*st.runtimes.read().await})),
        "runtime.refresh" => {
            let found = bloblex_runtime::discover().await;
            let mut values = Vec::new();
            for r in found {
                let value = serde_json::to_value(r).unwrap_or(Value::Null);
                let _ = st.db.upsert_runtime(&value);
                values.push(value)
            }
            *st.runtimes.write().await = values.clone();
            st.emit("runtime.changed", json!({"runtimes":values})).await;
            Ok(json!({"runtimes":values}))
        }
        "session.list" => Ok(
            json!({"sessions":st.db.sessions().map_err(|e|derr("internal",&e.to_string(),StatusCode::INTERNAL_SERVER_ERROR))?}),
        ),
        "session.get" => st
            .db
            .session_detail(p["sessionId"].as_str().unwrap_or(""))
            .map_err(|e| derr("not_found", &e.to_string(), StatusCode::NOT_FOUND)),
        "session.new" => new_session(st, p).await,
        "session.resume" => resume_session(st, p).await,
        "session.prompt" => session_prompt(st, p).await,
        "session.cancel" => {
            let id = p["sessionId"].as_str().unwrap_or("");
            let active = st.sessions.lock().await.get(id).cloned().ok_or_else(|| {
                derr(
                    "not_found",
                    "active session not found",
                    StatusCode::NOT_FOUND,
                )
            })?;
            active
                .adapter
                .cancel(&active.handle)
                .await
                .map_err(|e| derr("unsupported", &e.to_string(), StatusCode::BAD_REQUEST))?;
            st.db.update_session_state(id, "cancelling").map_err(|e| {
                derr(
                    "internal",
                    &e.to_string(),
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            })?;
            let session = st
                .db
                .session_detail(id)
                .unwrap_or(json!({"id":id,"state":"cancelling"}));
            st.emit("session.changed", session).await;
            Ok(json!({"cancellationRequested":true}))
        }
        "session.close" => {
            let id = p["sessionId"].as_str().unwrap_or("");
            let active = st.sessions.lock().await.remove(id);
            let active_turn = st.active_turns.lock().await.remove(id);
            if let Some(turn) = active_turn {
                let _ = st.db.update_turn_state(&turn, "cancelled");
                if let Some(s) = active.as_ref() {
                    let _ = s.adapter.cancel(&s.handle).await;
                }
            }
            if let Some(s) = active {
                s.adapter
                    .close_session(&s.handle)
                    .await
                    .map_err(|e| derr("provider_error", &e.to_string(), StatusCode::BAD_GATEWAY))?;
            }
            let _ = st.db.update_session_state(id, "closed");
            if let Ok(session) = st.db.session_detail(id) {
                st.emit("session.changed", session).await;
            }
            Ok(json!({"closed":true}))
        }
        "permission.reply" => {
            let id = p["permissionId"].as_str().unwrap_or("");
            let choice = p["choice"].as_str().unwrap_or("");
            let Some((session_id, provider_id)) = st
                .db
                .begin_permission_reply(id, choice)
                .map_err(|e| derr("conflict", &e.to_string(), StatusCode::CONFLICT))?
            else {
                return Err(derr(
                    "conflict",
                    "permission is no longer pending or choice is unsupported",
                    StatusCode::CONFLICT,
                ));
            };
            let Some(active) = st.sessions.lock().await.get(&session_id).cloned() else {
                let _ = st.db.finish_permission_reply(id, false);
                return Err(derr(
                    "provider_unavailable",
                    "provider session is no longer active",
                    StatusCode::BAD_GATEWAY,
                ));
            };
            if let Err(e) = active.adapter.reply_permission(&provider_id, choice).await {
                let _ = st.db.finish_permission_reply(id, false);
                return Err(derr("unsupported", &e.to_string(), StatusCode::BAD_REQUEST));
            }
            st.db.finish_permission_reply(id, true).map_err(|e| {
                derr(
                    "internal",
                    &e.to_string(),
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            })?;
            st.emit(
                "permission.resolved",
                json!({"permissionId":id,"choice":choice}),
            )
            .await;
            Ok(json!({"resolved":true}))
        }
        "budget.list" => st.db.budget_list().map_err(|e| {
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }),
        "budget.set" => st
            .db
            .save_budget(&p)
            .map_err(|e| derr("invalid_argument", &e.to_string(), StatusCode::BAD_REQUEST))
            .map(|_| json!({"saved":true})),
        "budget.delete" => st
            .db
            .delete_budget(p["policyId"].as_str().unwrap_or(""))
            .map_err(|e| {
                derr(
                    "internal",
                    &e.to_string(),
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            })
            .map(|_| json!({"deleted":true})),
        "usage.summary" => st.db.usage_summary(&p).map_err(|e| {
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }),
        "runtime.profile.list" => st.db.profiles().map_err(|e| {
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }),
        "runtime.profile.save" => st
            .db
            .save_profile(&p["profile"])
            .map_err(|e| derr("invalid_argument", &e.to_string(), StatusCode::BAD_REQUEST))
            .map(|_| json!({"saved":true})),
        "runtime.profile.delete" => st
            .db
            .delete_profile(p["profileId"].as_str().unwrap_or(""))
            .map_err(|e| {
                derr(
                    "internal",
                    &e.to_string(),
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            })
            .map(|_| json!({"deleted":true})),
        "settings.get" => st.db.settings().map_err(|e| {
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }),
        "settings.set" => {
            let k = p["key"].as_str().unwrap_or("");
            if k.to_ascii_lowercase().contains("token")
                || k.to_ascii_lowercase().contains("secret")
                || k.to_ascii_lowercase().contains("password")
            {
                return Err(derr(
                    "invalid_argument",
                    "credential material cannot be stored as a setting",
                    StatusCode::BAD_REQUEST,
                ));
            }
            st.db.set_setting(k, &p["value"]).map_err(|e| {
                derr(
                    "internal",
                    &e.to_string(),
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            })?;
            Ok(json!({"saved":true}))
        }
        "pricing.list" => st.db.pricing_list(p["provider"].as_str()).map_err(|e| {
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }),
        "pricing.override" => st
            .db
            .save_pricing(&p["rule"])
            .map_err(|e| derr("invalid_argument", &e.to_string(), StatusCode::BAD_REQUEST))
            .map(|_| json!({"saved":true})),
        "subscription.list" => st.db.subscriptions().map_err(|e| {
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }),
        "subscription.save" => st
            .db
            .save_subscription(&p["plan"])
            .map_err(|e| derr("invalid_argument", &e.to_string(), StatusCode::BAD_REQUEST))
            .map(|_| json!({"saved":true})),
        _ => Err(derr(
            "unsupported",
            "method is not supported",
            StatusCode::NOT_FOUND,
        )),
    }
}

fn runtime_from(v: &Value) -> RuntimeSpec {
    RuntimeSpec {
        runtime_id: v["id"].as_str().unwrap_or("").into(),
        provider: v["provider"].as_str().unwrap_or("").into(),
        executable: PathBuf::from(v["executablePath"].as_str().unwrap_or("")),
        args: v["launchArgs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        cwd: None,
    }
}
fn adapter_for(a: &Adapters, provider: &str) -> Option<Arc<dyn AgentAdapter>> {
    match provider {
        "opencode" => Some(a.acp.clone()),
        "codex" => Some(a.codex.clone()),
        "claude" => Some(a.claude.clone()),
        _ => None,
    }
}
async fn new_session(st: &AppState, p: Value) -> Result<Value, DispatchError> {
    let runtime_id = p["runtimeId"].as_str().unwrap_or("").to_owned();
    let project = PathBuf::from(p["projectPath"].as_str().unwrap_or(""));
    if !project.is_dir() {
        return Err(derr(
            "invalid_argument",
            "projectPath must be an existing directory",
            StatusCode::BAD_REQUEST,
        ));
    }
    let runtime = st
        .runtimes
        .read()
        .await
        .iter()
        .find(|r| r["id"] == runtime_id)
        .cloned()
        .ok_or_else(|| derr("not_found", "runtime not found", StatusCode::NOT_FOUND))?;
    let spec = runtime_from(&runtime);
    let provider = runtime["provider"].as_str().unwrap_or("").to_owned();
    let adapter = adapter_for(&st.adapters, &provider).ok_or_else(|| {
        derr(
            "unsupported",
            "provider adapter is not available",
            StatusCode::BAD_REQUEST,
        )
    })?;
    let id = Uuid::new_v4().to_string();
    let title = p["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("New chat")
        .to_owned();
    st.db
        .create_session(
            &id,
            &runtime_id,
            &provider,
            &project.to_string_lossy(),
            &title,
        )
        .map_err(|e| {
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        })?;
    let (tx, rx) = tokio::sync::mpsc::channel(256);
    let handle = adapter
        .new_session(
            &spec,
            NewSessionRequest {
                session_id: id.clone(),
                project_path: project,
            },
            tx,
        )
        .await
        .map_err(|e| {
            let _ = st.db.update_session_state(&id, "error");
            derr("provider_error", &e.to_string(), StatusCode::BAD_GATEWAY)
        })?;
    st.db
        .set_session_provider_id(&id, &handle.provider_session_id, handle.capabilities.resume)
        .map_err(|e| {
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        })?;
    let active = ActiveSession {
        handle: handle.clone(),
        runtime: spec,
        adapter,
    };
    st.sessions.lock().await.insert(id.clone(), active);
    let state = st.clone();
    let stream_id = id.clone();
    let event_provider = provider.clone();
    let event_runtime = runtime_id.clone();
    tokio::spawn(async move {
        forward_events(state, stream_id, event_provider, event_runtime, rx).await
    });
    let session_event = st.db.session_detail(&id).unwrap_or_else(|_| {
        json!({"id":id,"runtimeId":runtime_id,"provider":provider,"title":title,"state":"idle"})
    });
    st.emit("session.changed", session_event).await;
    Ok(
        json!({"id":id,"runtimeId":runtime_id,"provider":provider,"providerSessionId":handle.provider_session_id,"projectPath":p["projectPath"],"title":title,"state":"idle","resumable":handle.capabilities.resume,"turns":[],"messages":[],"tools":[],"files":[]}),
    )
}
async fn resume_session(st: &AppState, p: Value) -> Result<Value, DispatchError> {
    let sid = p["sessionId"].as_str().unwrap_or("").to_owned();
    if st.sessions.lock().await.contains_key(&sid) {
        return Err(derr(
            "conflict",
            "session is already active",
            StatusCode::CONFLICT,
        ));
    }
    let row = st
        .db
        .session_detail(&sid)
        .map_err(|_| derr("not_found", "session not found", StatusCode::NOT_FOUND))?;
    if !row["resumable"].as_bool().unwrap_or(false) {
        return Err(derr(
            "unsupported",
            "provider did not advertise resume support",
            StatusCode::BAD_REQUEST,
        ));
    }
    let rt = st
        .runtimes
        .read()
        .await
        .iter()
        .find(|r| r["id"] == row["runtimeId"])
        .cloned()
        .ok_or_else(|| {
            derr(
                "provider_unavailable",
                "runtime is not installed",
                StatusCode::BAD_GATEWAY,
            )
        })?;
    let spec = runtime_from(&rt);
    let provider = row["provider"].as_str().unwrap_or("").to_owned();
    let runtime = row["runtimeId"].as_str().unwrap_or("").to_owned();
    let native_id = row["providerSessionId"].as_str().unwrap_or("").to_owned();
    let project = PathBuf::from(row["projectPath"].as_str().unwrap_or(""));
    let adapter = adapter_for(&st.adapters, &provider).ok_or_else(|| {
        derr(
            "unsupported",
            "provider adapter is unavailable",
            StatusCode::BAD_REQUEST,
        )
    })?;
    let (tx, rx) = tokio::sync::mpsc::channel(256);
    let handle = adapter
        .resume_session(
            &spec,
            ResumeSessionRequest {
                session_id: sid.clone(),
                provider_session_id: native_id,
                project_path: project,
            },
            tx,
        )
        .await
        .map_err(|e| derr("provider_error", &e.to_string(), StatusCode::BAD_GATEWAY))?;
    if st.sessions.lock().await.contains_key(&sid) {
        let _ = adapter.close_session(&handle).await;
        return Err(derr(
            "conflict",
            "session became active while resume was starting",
            StatusCode::CONFLICT,
        ));
    }
    st.sessions.lock().await.insert(
        sid.clone(),
        ActiveSession {
            handle: handle.clone(),
            runtime: spec,
            adapter,
        },
    );
    let state = st.clone();
    let sid_for_events = sid.clone();
    let provider_for_events = provider.clone();
    let runtime_for_events = runtime.clone();
    tokio::spawn(async move {
        forward_events(
            state,
            sid_for_events,
            provider_for_events,
            runtime_for_events,
            rx,
        )
        .await
    });
    st.db.update_session_state(&sid, "idle").map_err(|e| {
        derr(
            "internal",
            &e.to_string(),
            StatusCode::INTERNAL_SERVER_ERROR,
        )
    })?;
    st.emit(
        "session.changed",
        st.db.session_detail(&sid).unwrap_or_else(
            |_| json!({"id":sid,"runtimeId":runtime,"provider":provider,"state":"idle"}),
        ),
    )
    .await;
    Ok(json!({"sessionId":p["sessionId"],"resumed":true,"state":"idle"}))
}
async fn session_prompt(st: &AppState, p: Value) -> Result<Value, DispatchError> {
    let sid = p["sessionId"].as_str().unwrap_or("").to_owned();
    let text = p["text"].as_str().unwrap_or("").to_owned();
    if text.is_empty() || text.len() > 1_000_000 {
        return Err(derr(
            "invalid_argument",
            "text must contain 1 to 1000000 UTF-8 bytes",
            StatusCode::BAD_REQUEST,
        ));
    }
    let active = st.sessions.lock().await.get(&sid).cloned().ok_or_else(|| {
        derr(
            "not_found",
            "active session not found",
            StatusCode::NOT_FOUND,
        )
    })?;
    let turn = Uuid::new_v4().to_string();
    {
        let mut turns = st.active_turns.lock().await;
        if turns.contains_key(&sid) {
            return Err(derr(
                "conflict",
                "this session already has an active turn",
                StatusCode::CONFLICT,
            ));
        }
        if turns.len() >= 4 {
            return Err(derr(
                "conflict",
                "daemon concurrency limit of four active turns reached",
                StatusCode::CONFLICT,
            ));
        }
        let session = st.db.session_detail(&sid).map_err(|e| {
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        })?;
        // Conservative bounded prompt-size estimate for admission. Providers do
        // not expose a common max-output token setting here; completion usage
        // reconciles this reservation when available, otherwise it remains
        // charged. Unknown cost/concurrency demands fail closed in storage.
        let estimated_input_tokens = ((text.as_bytes().len() as i64 + 2) / 3).max(1);
        let reserved = st
            .db
            .reserve_applicable_budgets_with_demands(
                &turn,
                &sid,
                &active.runtime.runtime_id,
                &active.runtime.provider,
                session["projectPath"].as_str().unwrap_or(""),
                &json!({"tokens":estimated_input_tokens,"input_tokens":estimated_input_tokens,"turns":1,"runtime_minutes":1}),
            )
            .map_err(|e| {
                derr(
                    "internal",
                    &e.to_string(),
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            })?;
        if !reserved {
            return Err(derr("budget_blocked", "an applicable budget has insufficient remaining capacity or cannot be safely estimated", StatusCode::TOO_MANY_REQUESTS));
        }
        st.db.create_turn(&turn, &sid).map_err(|e| {
            let _ = st.db.release_budget_turn(&turn);
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        })?;
        st.db
            .append_message(&sid, &turn, "user", &text)
            .map_err(|e| {
                let _ = st.db.release_budget_turn(&turn);
                derr(
                    "internal",
                    &e.to_string(),
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            })?;
        st.db.update_session_state(&sid, "working").map_err(|e| {
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        })?;
        turns.insert(sid.clone(), turn.clone());
    }
    let state = st.clone();
    let sid2 = sid.clone();
    let turn2 = turn.clone();
    tokio::spawn(async move {
        if let Err(e) = active
            .adapter
            .prompt(
                &active.handle,
                PromptRequest {
                    turn_id: turn2.clone(),
                    text,
                },
            )
            .await
        {
            let _ = state.db.update_turn_state(&turn2, "error");
            let _ = state.db.update_session_state(&sid2, "error");
            // Keep the reservation when usage is unknown so restart recovery cannot
            // silently free capacity for a turn that may have consumed tokens.
            state.active_turns.lock().await.remove(&sid2);
            state
                .emit(
                    "turn.error",
                    json!({"sessionId":sid2,"turnId":turn2,"message":e.to_string()}),
                )
                .await;
        }
    });
    let working = st
        .db
        .session_detail(&sid)
        .unwrap_or(json!({"id":sid,"state":"working"}));
    st.emit("session.changed", working).await;
    Ok(json!({"turnId":turn,"accepted":true}))
}
async fn forward_events(
    st: AppState,
    sid: String,
    provider: String,
    runtime_id: String,
    mut rx: tokio::sync::mpsc::Receiver<AgentEvent>,
) {
    while let Some(ev) = rx.recv().await {
        let turn = st.active_turns.lock().await.get(&sid).cloned();
        let (ty, payload) = match ev {
            AgentEvent::SessionStarted {
                provider_session_id,
            } => {
                let _ = st
                    .db
                    .set_session_provider_id(&sid, &provider_session_id, true);
                let session = st
                    .db
                    .session_detail(&sid)
                    .unwrap_or(json!({"id":sid,"providerSessionId":provider_session_id}));
                ("session.changed", session)
            }
            AgentEvent::AssistantDelta { text } => {
                let m = st
                    .db
                    .append_message_delta(&sid, turn.as_deref().unwrap_or(""), &text)
                    .unwrap_or(Value::Null);
                (
                    "message.delta",
                    json!({"sessionId":sid,"turnId":turn,"id":m["id"],"messageId":m["id"],"sequence":m["sequence"],"role":"assistant","delta":text}),
                )
            }
            AgentEvent::AssistantMessage { text } => {
                let m = st
                    .db
                    .finalize_latest_assistant(&sid, turn.as_deref().unwrap_or(""), &text)
                    .unwrap_or(Value::Null);
                (
                    "message.completed",
                    json!({"id":m["id"],"messageId":m["id"],"sessionId":sid,"turnId":turn,"sequence":m["sequence"],"role":"assistant","content":text}),
                )
            }
            AgentEvent::ToolStarted {
                tool_call_id,
                kind,
                title,
                raw,
            } => {
                let tool = st
                    .db
                    .upsert_tool(&sid, &tool_call_id, &kind, &title, "running", &raw)
                    .unwrap_or(Value::Null);
                (
                    "tool.changed",
                    json!({"sessionId":sid,"turnId":turn,"id":tool_call_id,"kind":tool["kind"],"title":tool["title"],"state":"running"}),
                )
            }
            AgentEvent::ToolUpdated { tool_call_id, raw } => {
                let tool = st
                    .db
                    .upsert_tool(&sid, &tool_call_id, "other", "Activity", "running", &raw)
                    .unwrap_or(Value::Null);
                (
                    "tool.changed",
                    json!({"sessionId":sid,"turnId":turn,"id":tool_call_id,"kind":tool["kind"],"title":tool["title"],"state":"running"}),
                )
            }
            AgentEvent::ToolCompleted { tool_call_id, raw } => {
                let tool = st
                    .db
                    .upsert_tool(&sid, &tool_call_id, "other", "Tool", "completed", &raw)
                    .unwrap_or(Value::Null);
                (
                    "tool.changed",
                    json!({"sessionId":sid,"turnId":turn,"id":tool_call_id,"kind":tool["kind"],"title":tool["title"],"state":"completed"}),
                )
            }
            AgentEvent::FileChanged { path, raw } => {
                let _ = st.db.insert_file(&sid, &path, &raw);
                (
                    "file.changed",
                    json!({"sessionId":sid,"turnId":turn,"path":path}),
                )
            }
            AgentEvent::PermissionRequested {
                provider_request_id,
                title,
                detail,
                choices,
                raw,
            } => {
                let id = Uuid::new_v4().to_string();
                let _ = st.db.insert_permission(
                    &id,
                    &sid,
                    &provider_request_id,
                    &title,
                    detail.as_deref(),
                    &choices,
                    &raw,
                );
                (
                    "permission.requested",
                    json!({"id":id,"sessionId":sid,"runtimeId":runtime_id,"category":"other","title":title,"detail":detail,"risk":"unknown","choices":choices,"expiresAt":null,"status":"pending"}),
                )
            }
            AgentEvent::UsageUpdated {
                raw,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                model,
            } => {
                let timestamp = Utc::now().to_rfc3339();
                let record = bloblex_usage::UsageRecord {
                    input_tokens: input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_write_tokens,
                    reasoning_tokens: None,
                    model: model.clone(),
                    reported_cost_minor: raw["costMinor"].as_i64(),
                    currency: raw["currency"].as_str().map(str::to_owned),
                    source: "stream".into(),
                    raw: raw.clone(),
                };
                let rules = st
                    .db
                    .pricing_list(Some(&provider))
                    .ok()
                    .and_then(|v| {
                        serde_json::from_value::<Vec<bloblex_usage::PriceRule>>(v["rules"].clone())
                            .ok()
                    })
                    .unwrap_or_default();
                let rule =
                    bloblex_usage::resolve_rule_at(&provider, model.as_deref(), &timestamp, &rules);
                let valuation = if record.reported_cost_minor.is_some() {
                    bloblex_usage::Valuation {
                        basis: bloblex_usage::CostBasis::ProviderReportedActual,
                        amount_minor: record.reported_cost_minor,
                        currency: record.currency.clone(),
                        pricing_rule_id: None,
                        status: "reported_actual".into(),
                    }
                } else {
                    bloblex_usage::estimate(&record, rule)
                };
                let valuation = serde_json::to_value(valuation).unwrap_or(Value::Null);
                let usage = json!({"id":Uuid::new_v4().to_string(),"runtimeId":runtime_id,"sessionId":sid,"turnId":turn,"provider":provider,"model":model,"timestamp":timestamp,"inputTokens":input_tokens,"outputTokens":output_tokens,"cacheReadTokens":cache_read_tokens,"cacheWriteTokens":cache_write_tokens,"source":"stream","raw":raw,"providerReportedCostMinor":record.reported_cost_minor,"providerReportedCurrency":record.currency,"valuation":valuation});
                let _ = st.db.insert_usage(&usage);
                (
                    "usage.updated",
                    json!({"id":usage["id"],"runtimeId":runtime_id,"sessionId":sid,"turnId":turn,"provider":provider,"model":model,"timestamp":usage["timestamp"],"inputTokens":input_tokens,"outputTokens":output_tokens,"cacheReadTokens":cache_read_tokens,"cacheWriteTokens":cache_write_tokens,"reasoningTokens":null,"providerReportedCostMinor":record.reported_cost_minor,"providerReportedCurrency":record.currency,"source":"stream","valuation":valuation}),
                )
            }
            AgentEvent::TurnCompleted => {
                if let Some(t) = turn.as_deref() {
                    let _ = st.db.update_turn_state(t, "completed");
                    if let Ok(metrics) = st.db.latest_turn_budget_metrics(t) {
                        let _ = st.db.reconcile_budget_turn_metrics(t, &metrics);
                    }
                }
                let _ = st.db.update_session_state(&sid, "completed");
                st.active_turns.lock().await.remove(&sid);
                (
                    "turn.completed",
                    json!({"sessionId":sid,"turnId":turn,"state":"completed"}),
                )
            }
            AgentEvent::TurnCancelled => {
                if let Some(t) = turn.as_deref() {
                    let _ = st.db.update_turn_state(t, "cancelled");
                    if let Ok(metrics) = st.db.latest_turn_budget_metrics(t) {
                        let _ = st.db.reconcile_budget_turn_metrics(t, &metrics);
                    }
                }
                let _ = st.db.update_session_state(&sid, "cancelled");
                st.active_turns.lock().await.remove(&sid);
                (
                    "turn.cancelled",
                    json!({"sessionId":sid,"turnId":turn,"state":"cancelled"}),
                )
            }
            AgentEvent::Error { message } => {
                if let Some(t) = turn.as_deref() {
                    let _ = st.db.update_turn_state(t, "error");
                }
                let _ = st.db.update_session_state(&sid, "error");
                st.active_turns.lock().await.remove(&sid);
                (
                    "turn.error",
                    json!({"sessionId":sid,"turnId":turn,"message":message}),
                )
            }
            AgentEvent::ThinkingDelta { text } => {
                let m = st
                    .db
                    .append_typed_message_delta(
                        &sid,
                        turn.as_deref().unwrap_or(""),
                        "thinking",
                        &text,
                    )
                    .unwrap_or(Value::Null);
                (
                    "message.delta",
                    json!({"sessionId":sid,"turnId":turn,"id":m["id"],"messageId":m["id"],"sequence":m["sequence"],"role":"thinking","delta":text}),
                )
            }
            AgentEvent::SessionIdle => {
                let _ = st.db.update_session_state(&sid, "idle");
                let session = st
                    .db
                    .session_detail(&sid)
                    .unwrap_or(json!({"id":sid,"state":"idle"}));
                ("session.changed", session)
            }
        };
        st.emit(ty, payload).await;
    }
}

async fn ws_client(mut socket: WebSocket, st: AppState) {
    let mut live = st.events.subscribe();
    let Some(Ok(Message::Text(first))) = socket.next().await else {
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(&first) else {
        return;
    };
    let mut after = v["afterSequence"].as_u64().unwrap_or(0);
    loop {
        let replay = st.db.replay_events(after, 1000).unwrap_or_default();
        let count = replay.len();
        for ev in replay {
            if ev["replayAvailable"] == false {
                let _=socket.send(Message::Text(json!({"v":1,"eventId":"gap","sequence":after,"timestamp":Utc::now().to_rfc3339(),"type":"replay.gap","payload":ev}).to_string().into())).await;
                return;
            }
            let seq = ev["sequence"].as_u64().unwrap_or(0);
            if seq > after {
                if socket
                    .send(Message::Text(ev.to_string().into()))
                    .await
                    .is_err()
                {
                    return;
                }
                after = seq;
            }
        }
        if count < 1000 {
            break;
        }
    }
    let replay_complete = json!({
        "v": 1,
        "eventId": format!("replay-complete-{after}"),
        "sequence": after,
        "timestamp": Utc::now().to_rfc3339(),
        "type": "events.replay.complete",
        "payload": {"throughSequence": after}
    });
    if socket
        .send(Message::Text(replay_complete.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {item=live.recv()=>match item{Ok(e)if e.sequence>after=>{if socket.send(Message::Text(serde_json::to_string(&e).unwrap_or_default().into())).await.is_err(){break}after=e.sequence},Ok(_)=>{},Err(broadcast::error::RecvError::Lagged(_))=>{let _=socket.send(Message::Text(json!({"v":1,"eventId":"gap","sequence":after,"timestamp":Utc::now().to_rfc3339(),"type":"replay.gap","payload":{"replayAvailable":false}}).to_string().into())).await;break},Err(_)=>break},msg=socket.next()=>match msg{Some(Ok(Message::Close(_)))|None=>break,_=>{}}}
    }
}
async fn start_ws(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !is_loopback(peer) || !auth(&headers, &st.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |s| ws_client(s, st)).into_response()
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let db_path = std::env::var_os("BLOBLEX_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let local = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            local.join("Bloblex/bloblex.db")
        });
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?
    }
    let db = Arc::new(Storage::open(db_path)?);
    let recovered_sessions = db.recover_after_restart()?;
    let token = new_capability();
    let (events, _) = broadcast::channel(1024);
    let adapters = Arc::new(Adapters {
        acp: Arc::new(AcpAdapter::default()),
        codex: Arc::new(CodexAdapter::default()),
        claude: Arc::new(ClaudeAdapter::default()),
    });
    let found = bloblex_runtime::discover().await;
    let mut runtimes = Vec::new();
    for r in found {
        let v = serde_json::to_value(r)?;
        db.upsert_runtime(&v)?;
        runtimes.push(v)
    }
    let st = AppState {
        token: Arc::new(token.clone()),
        started: Instant::now(),
        db,
        events,
        runtimes: Arc::new(RwLock::new(runtimes)),
        adapters,
        sessions: Arc::new(Mutex::new(HashMap::new())),
        active_turns: Arc::new(Mutex::new(HashMap::new())),
        stopping: Arc::new(tokio::sync::Notify::new()),
    };
    for id in recovered_sessions {
        if let Ok(session) = st.db.session_detail(&id) {
            st.emit("session.changed", session).await;
        }
    }
    let app = Router::new()
        .route("/v1/rpc", post(main_rpc))
        .route("/v1/events", get(start_ws))
        .with_state(st.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    println!(
        "{}",
        serde_json::to_string(&DaemonReady {
            message_type: "bloblexd.ready".into(),
            protocol_version: PROTOCOL_VERSION,
            address: addr.to_string(),
            capability: token
        })?
    );
    use std::io::Write;
    std::io::stdout().flush()?;
    let shutdown = st.stopping.clone();
    tokio::select! {r=axum::serve(listener,app.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(async move{shutdown.notified().await}).into_future()=>r?,_=tokio::signal::ctrl_c()=>{}}
    let sessions = std::mem::take(&mut *st.sessions.lock().await);
    for (_, s) in sessions {
        let _ = s.adapter.close_session(&s.handle).await;
    }
    Ok(())
}
#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    if let Err(e) = run().await {
        eprintln!("bloblexd failed: {e}");
        std::process::exit(1)
    }
}
