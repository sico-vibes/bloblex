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
    AgentAdapter, AgentEvent, ApprovalMode, ExecOptions, NewSessionRequest, PromptRequest, ResumeSessionRequest, RuntimeSpec,
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
    collections::{HashMap, HashSet}, future::IntoFuture, net::SocketAddr, path::PathBuf, sync::{Arc, OnceLock, Mutex as StdMutex},
    time::Instant,
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, Mutex, RwLock},
};
use uuid::Uuid;

mod model_presentation;

static MODEL_CATALOG_CACHE: OnceLock<StdMutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();

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
    denied_turns: Arc<Mutex<HashSet<String>>>,
    session_gates: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    deleted_sessions: Arc<Mutex<HashSet<String>>>,
    stopping: Arc<tokio::sync::Notify>,
}
#[derive(Clone)]
struct Adapters {
    acp: Arc<dyn AgentAdapter>,
    codex: Arc<dyn AgentAdapter>,
    claude: Arc<dyn AgentAdapter>,
}
#[derive(Clone)]
struct ActiveSession {
    handle: SessionHandle,
    runtime: RuntimeSpec,
    adapter: Arc<dyn AgentAdapter>,
    launch_approval_mode: ApprovalMode,
}
impl AppState {
    async fn emit(&self, kind: &str, payload: Value) {
        if kind != "session.deleted" {
            let id = payload.get("sessionId").and_then(Value::as_str)
                .or_else(|| (kind == "session.changed").then(|| payload.get("id").and_then(Value::as_str)).flatten());
            if let Some(id) = id {
                if self.deleted_sessions.lock().await.contains(id) { return; }
            }
        }
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
    fn broadcast_persisted(&self, events: Vec<Value>) {
        for event in events {
            let _ = self.events.send(EventEnvelope { v:1,event_id:event["eventId"].as_str().unwrap_or("").to_owned(),sequence:event["sequence"].as_u64().unwrap_or(0),timestamp:event["timestamp"].as_str().unwrap_or("").to_owned(),event_type:event["type"].as_str().unwrap_or("").to_owned(),payload:event["payload"].clone() });
        }
    }
}

fn adapter_failure_class(error: &bloblex_agent_core::AdapterError, permission_denied: bool) -> &'static str {
    if matches!(error, bloblex_agent_core::AdapterError::Timeout) {
        return "timeout";
    }
    if permission_denied {
        return "permission_denied";
    }
    match error {
        bloblex_agent_core::AdapterError::ContextExhausted => "context",
        bloblex_agent_core::AdapterError::Timeout => "timeout",
        bloblex_agent_core::AdapterError::Rejected(_)
        | bloblex_agent_core::AdapterError::Unsupported(_) => "config_unsupported",
        bloblex_agent_core::AdapterError::Protocol(_) => "provider_error",
        bloblex_agent_core::AdapterError::ResumeRejected => "other",
        bloblex_agent_core::AdapterError::Process(_)
        | bloblex_agent_core::AdapterError::Other(_) => "other",
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
fn agent_error(e: bloblex_storage::StorageError) -> DispatchError {
    use bloblex_storage::StorageError::*;
    match e { InvalidAgent=>derr("invalid_argument","agent fields or membership are invalid",StatusCode::BAD_REQUEST),AgentNotFound=>derr("not_found","agent or runtime not found",StatusCode::NOT_FOUND),AgentConflict=>derr("conflict","agent conflicts with current state",StatusCode::CONFLICT),_=>derr("internal","agent storage operation failed",StatusCode::INTERNAL_SERVER_ERROR) }
}
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
        "exec.snapshot.get" => {
            let id=p["snapshotId"].as_str().filter(|s|!s.is_empty()).ok_or_else(||derr("invalid_argument","snapshotId is required",StatusCode::BAD_REQUEST))?;
            st.db.exec_snapshot_get(id).map_err(|e|derr("internal",&e.to_string(),StatusCode::INTERNAL_SERVER_ERROR))?.ok_or_else(||derr("not_found","execution snapshot not found",StatusCode::NOT_FOUND))
        }
        "exec.snapshot.list" => {
            let sid=p["sessionId"].as_str().filter(|s|!s.is_empty()).ok_or_else(||derr("invalid_argument","sessionId is required",StatusCode::BAD_REQUEST))?;
            let after=match p.get("after"){None|Some(Value::Null)=>None,Some(Value::String(s))=>Some(s.as_str()),_=>return Err(derr("invalid_argument","after must be a snapshot id",StatusCode::BAD_REQUEST))};
            let limit=match p.get("limit"){None=>50,Some(v)=>u32::try_from(v.as_u64().ok_or_else(||derr("invalid_argument","limit must be a positive integer",StatusCode::BAD_REQUEST))?).map_err(|_|derr("invalid_argument","limit is out of range",StatusCode::BAD_REQUEST))?};
            if limit==0||limit>200{return Err(derr("invalid_argument","limit must be between 1 and 200",StatusCode::BAD_REQUEST));}
            if st.db.session_detail(sid).is_err(){return Err(derr("not_found","session not found",StatusCode::NOT_FOUND));}
            if let Some(cursor)=after{let snapshot=st.db.exec_snapshot_get(cursor).map_err(|e|derr("internal",&e.to_string(),StatusCode::INTERNAL_SERVER_ERROR))?;if !snapshot.is_some_and(|v|v["sessionId"]==sid){return Err(derr("invalid_argument","after must identify a snapshot in this session",StatusCode::BAD_REQUEST));}}
            let (snapshots,next)=st.db.exec_snapshot_list(sid,after,limit).map_err(|e|derr("internal",&e.to_string(),StatusCode::INTERNAL_SERVER_ERROR))?;
            Ok(json!({"snapshots":snapshots,"next":next}))
        }
        "exec.snapshot.latest" => {
            let sid=p["sessionId"].as_str().filter(|s|!s.is_empty()).ok_or_else(||derr("invalid_argument","sessionId is required",StatusCode::BAD_REQUEST))?;
            if st.db.session_detail(sid).is_err(){return Err(derr("not_found","session not found",StatusCode::NOT_FOUND));}
            st.db.exec_snapshot_latest(sid).map(|v|v.unwrap_or(Value::Null)).map_err(|e|derr("internal",&e.to_string(),StatusCode::INTERNAL_SERVER_ERROR))
        }
        "runtime.capabilities" => runtime_capabilities(st,&p).await,
        "runtime.models" => runtime_models(st, &p).await,
        "agent.list" => {
            let include=match p.get("includeArchived"){None=>false,Some(v)=>v.as_bool().ok_or_else(||derr("invalid_argument","includeArchived must be a boolean",StatusCode::BAD_REQUEST))?};
            let runtime=match p.get("runtimeId"){None=>None,Some(v)=>Some(v.as_str().ok_or_else(||derr("invalid_argument","runtimeId must be a string",StatusCode::BAD_REQUEST))?)};
            st.db.agent_list(include,runtime).map(|agents|json!({"agents":agents})).map_err(agent_error)
        }
        "agent.get" => { let id=p["agentId"].as_str().ok_or_else(||derr("invalid_argument","agentId is required",StatusCode::BAD_REQUEST))?; st.db.agent_get(id).map(|agent|json!({"agent":agent})).map_err(agent_error) }
        "permissions.policy.get" => { let default=st.db.default_approval_mode().map_err(agent_error)?;let agents=st.db.agent_list(false,None).map_err(agent_error)?;let per_agent=agents.iter().map(|a|json!({"agentId":a["id"],"mode":a["approvalMode"],"effectiveMode":a["effectiveApprovalMode"]})).collect::<Vec<_>>();Ok(json!({"defaultMode":default,"perAgent":per_agent})) }
        "agent.create" => { let runtime_id=p["runtimeId"].as_str().ok_or_else(||derr("invalid_argument","runtimeId is required",StatusCode::BAD_REQUEST))?;validate_agent_catalog(st,runtime_id,&p).await?;let (agent,events)=st.db.agent_create(&p).map_err(agent_error)?;st.broadcast_persisted(events);Ok(json!({"agent":agent})) }
        "agent.update" => { let id=p["agentId"].as_str().ok_or_else(||derr("invalid_argument","agentId is required",StatusCode::BAD_REQUEST))?;let existing=st.db.agent_get(id).map_err(agent_error)?;let mut fields=p.clone();fields.as_object_mut().unwrap().remove("agentId");let runtime_id=fields["runtimeId"].as_str().unwrap_or(existing["runtimeId"].as_str().unwrap_or(""));let mut effective=existing.clone();if let (Some(dst),Some(src))=(effective.as_object_mut(),fields.as_object()){for(k,v)in src{dst.insert(k.clone(),v.clone());}}validate_agent_catalog(st,runtime_id,&effective).await?;let (agent,events)=st.db.agent_update(id,&fields).map_err(agent_error)?;st.broadcast_persisted(events);Ok(json!({"agent":agent})) }
        "agent.delete" => { let id=p["agentId"].as_str().ok_or_else(||derr("invalid_argument","agentId is required",StatusCode::BAD_REQUEST))?;let (agent,events)=st.db.agent_archive(id).map_err(agent_error)?;st.broadcast_persisted(events);Ok(json!({"agent":agent})) }
        "agent.reorder" => { let rt=p["runtimeId"].as_str().ok_or_else(||derr("invalid_argument","runtimeId is required",StatusCode::BAD_REQUEST))?;let ids=p["agentIds"].as_array().filter(|a|a.iter().all(Value::is_string)).ok_or_else(||derr("invalid_argument","agentIds must be an array of strings",StatusCode::BAD_REQUEST))?.iter().map(|v|v.as_str().unwrap().to_owned()).collect::<Vec<_>>();let (agents,events)=st.db.agent_reorder(rt,&ids).map_err(agent_error)?;st.broadcast_persisted(events);Ok(json!({"agents":agents})) }
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
            let default_events=st.db.ensure_default_agents().map_err(|e|derr("internal",&e.to_string(),StatusCode::INTERNAL_SERVER_ERROR))?;
            st.broadcast_persisted(default_events);
            *st.runtimes.write().await = values.clone();
            st.emit("runtime.changed", json!({"runtimes":values})).await;
            Ok(json!({"runtimes":values}))
        }
        "session.list" => {
            let include = match p.get("includeArchived") { None => false, Some(value) => value.as_bool().ok_or_else(|| derr("invalid_argument", "includeArchived must be a boolean", StatusCode::BAD_REQUEST))? };
            Ok(json!({"sessions":st.db.session_list(include).map_err(|e|derr("internal",&e.to_string(),StatusCode::INTERNAL_SERVER_ERROR))?}))
        },
        "session.rename" => {
            let id = p["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
            let title = p["title"].as_str().ok_or_else(|| derr("invalid_argument", "title must be a string", StatusCode::BAD_REQUEST))?;
            if !(1..=120).contains(&title.trim().chars().count()) { return Err(derr("invalid_argument", "title must be between 1 and 120 characters", StatusCode::BAD_REQUEST)); }
            let gate = gate_for_session(st, id).await;
            let _event_guard = gate.lock().await;
            if session_is_deleted(st, id).await { return Err(derr("not_found", "session not found", StatusCode::NOT_FOUND)); }
            let session = st.db.session_rename(id, title).map_err(|error| match error {
                bloblex_storage::StorageError::AgentNotFound => derr("not_found", "session not found", StatusCode::NOT_FOUND),
                bloblex_storage::StorageError::InvalidAgent => derr("invalid_argument", "title must be between 1 and 120 characters", StatusCode::BAD_REQUEST),
                other => derr("internal", &other.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
            })?;
            st.emit("session.changed", session.clone()).await;
            Ok(json!({"session":session}))
        }
        "session.archive" => {
            let id = p["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
            let archived = p["archived"].as_bool().ok_or_else(|| derr("invalid_argument", "archived must be a boolean", StatusCode::BAD_REQUEST))?;
            let gate = gate_for_session(st, id).await;
            let _event_guard = gate.lock().await;
            if session_is_deleted(st, id).await { return Err(derr("not_found", "session not found", StatusCode::NOT_FOUND)); }
            let session = st.db.session_archive(id, archived).map_err(|error| match error {
                bloblex_storage::StorageError::AgentNotFound => derr("not_found", "session not found", StatusCode::NOT_FOUND),
                other => derr("internal", &other.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
            })?;
            st.emit("session.changed", session.clone()).await;
            Ok(json!({"session":session}))
        }
        "session.delete" => {
            let id = p["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
            let gate = gate_for_session(st, id).await;
            let (active, active_turn) = {
                let _event_guard = gate.lock().await;
                if session_is_deleted(st, id).await { return Err(derr("not_found", "session not found", StatusCode::NOT_FOUND)); }
                let state = st.db.session_state(id).map_err(|e| derr("internal", &e.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
                let Some(state) = state else { return Err(derr("not_found", "session not found", StatusCode::NOT_FOUND)); };
                if matches!(state.as_str(), "starting" | "working" | "cancelling" | "waiting_permission") {
                    return Err(derr("conflict", "cannot delete a session while it is starting, working, cancelling, or waiting for approval", StatusCode::CONFLICT));
                }
                st.db.session_delete(id).map_err(|error| match error {
                    bloblex_storage::StorageError::AgentNotFound => derr("not_found", "session not found", StatusCode::NOT_FOUND),
                    bloblex_storage::StorageError::SessionActive => derr("conflict", "cannot delete a session while it is starting, working, cancelling, or waiting for approval", StatusCode::CONFLICT),
                    other => derr("internal", &other.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
                })?;
                st.deleted_sessions.lock().await.insert(id.to_owned());
                let active = st.sessions.lock().await.remove(id);
                let active_turn = st.active_turns.lock().await.remove(id);
                if let Some(turn) = active_turn.as_deref() { st.denied_turns.lock().await.remove(turn); }
                st.emit("session.deleted", json!({"sessionId":id})).await;
                remove_session_gate(st, id, &gate).await;
                (active, active_turn)
            };
            if let Some(session) = active {
                if active_turn.is_some() { let _ = session.adapter.cancel(&session.handle).await; }
                let _ = session.adapter.close_session(&session.handle).await;
            }
            Ok(json!({"deleted":true}))
        }
        "session.get" => st
            .db
            .session_detail(p["sessionId"].as_str().unwrap_or(""))
            .map_err(|e| derr("not_found", &e.to_string(), StatusCode::NOT_FOUND)),
        "session.new" => new_session(st, p).await,
        "session.resume" => resume_session(st, p).await,
        "session.prompt" => session_prompt(st, p).await,
        "session.cancel" => {
            let id = p["sessionId"].as_str().unwrap_or("");
            let gate = gate_for_session(st, id).await;
            let active = {
                let _guard = gate.lock().await;
                if session_is_deleted(st, id).await { return Err(derr("not_found", "active session not found", StatusCode::NOT_FOUND)); }
                let active = st.sessions.lock().await.get(id).cloned().ok_or_else(|| derr("not_found", "active session not found", StatusCode::NOT_FOUND))?;
                st.db.update_session_state(id, "cancelling").map_err(|e| derr("internal", &e.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
                if let Ok(summary) = st.db.session_event_summary(id) { st.emit("session.changed", summary).await; }
                active
            };
            if let Err(e)=active.adapter.cancel(&active.handle).await {
                let _ = restore_cancel_state(st, id, &gate).await;
                return Err(derr("unsupported",&e.to_string(),StatusCode::BAD_REQUEST));
            }
            Ok(json!({"cancellationRequested":true}))
        }
        "session.close" => {
            let id = p["sessionId"].as_str().unwrap_or("");
            let gate = gate_for_session(st, id).await;
            let (active, active_turn) = {
                let _guard = gate.lock().await;
                if session_is_deleted(st, id).await { return Ok(json!({"closed":true})); }
                let state = st.db.session_state(id).map_err(|e| derr("internal", &e.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
                if state.as_deref() == Some("starting") { return Err(derr("conflict", "session is starting", StatusCode::CONFLICT)); }
                let active_turn = st.active_turns.lock().await.remove(id);
                if let Some(turn) = active_turn.as_deref() {
                    st.denied_turns.lock().await.remove(turn);
                    let _ = st.db.update_turn_outcome(turn, "cancelled", Some("cancelled"));
                }
                let active = st.sessions.lock().await.remove(id);
                let _ = st.db.update_session_state(id, "closed");
                if let Ok(summary) = st.db.session_event_summary(id) { st.emit("session.changed", summary).await; }
                remove_session_gate(st, id, &gate).await;
                (active, active_turn)
            };
            if let Some(session) = active {
                if active_turn.is_some() { let _ = session.adapter.cancel(&session.handle).await; }
                session.adapter.close_session(&session.handle).await.map_err(|e| derr("provider_error", &e.to_string(), StatusCode::BAD_GATEWAY))?;
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
            let gate = gate_for_session(st, &session_id).await;
            let active = {
                let _guard = gate.lock().await;
                if session_is_deleted(st, &session_id).await || !session_gate_is_current(st, &session_id, &gate).await {
                    let _ = st.db.finish_permission_reply(id, false);
                    return Err(derr("not_found", "session not found", StatusCode::NOT_FOUND));
                }
                st.sessions.lock().await.get(&session_id).cloned()
            };
            let Some(active) = active else {
                let _ = st.db.finish_permission_reply(id, false);
                return Err(derr(
                    "provider_unavailable",
                    "provider session is no longer active",
                    StatusCode::BAD_GATEWAY,
                ));
            };
            if let Err(e) = active.adapter.reply_permission(&provider_id, choice).await {
                let _guard = gate.lock().await;
                if !session_is_deleted(st, &session_id).await { let _ = st.db.finish_permission_reply(id, false); }
                return Err(derr("unsupported", &e.to_string(), StatusCode::BAD_REQUEST));
            }
            let _guard = gate.lock().await;
            if !session_gate_is_current(st, &session_id, &gate).await || session_is_deleted(st, &session_id).await
                || !st.db.session_exists(&session_id).unwrap_or(false) || !st.sessions.lock().await.contains_key(&session_id)
            {
                let _ = st.db.finish_permission_reply(id, false);
                return Err(derr("not_found", "session is no longer active", StatusCode::NOT_FOUND));
            }
            st.db.finish_permission_reply(id, true).map_err(|e| derr("internal", &e.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
            let _ = st.db.update_session_state(&session_id, "working");
            if let Ok(summary) = st.db.session_event_summary(&session_id) { st.emit("session.changed", summary).await; }
            if matches!(choice.to_ascii_lowercase().as_str(), "deny" | "reject" | "no") {
                if let Some(turn_id) = st.active_turns.lock().await.get(&session_id).cloned() { st.denied_turns.lock().await.insert(turn_id); }
            }
            st.emit("permission.resolved", json!({"permissionId":id,"choice":choice})).await;
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
        "usage.analytics" => {
            if p.get("projectPath").is_some_and(|value| !value.is_null() && !value.is_string())
                || p.get("agentId").is_some_and(|value| !value.is_null() && !value.is_string())
            {
                return Err(derr("invalid_argument", "projectPath and agentId must be strings", StatusCode::BAD_REQUEST));
            }
            st.db.usage_analytics(&p).map_err(|error| match error {
                bloblex_storage::StorageError::InvalidAnalytics => derr("invalid_argument", "analytics range, bucket, or timezone is invalid", StatusCode::BAD_REQUEST),
                bloblex_storage::StorageError::AgentNotFound => derr("not_found", "agent not found", StatusCode::NOT_FOUND),
                other => derr("internal", &other.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
            })
        }
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
            if k.is_empty(){return Err(derr("invalid_argument","key is required",StatusCode::BAD_REQUEST));}
            if k.starts_with("exec_gate.")&&!p["value"].is_boolean(){return Err(derr("invalid_argument","execution gates require a JSON boolean",StatusCode::BAD_REQUEST));}
            if k=="notifications.enabled"&&!p["value"].is_boolean(){return Err(derr("invalid_argument","notifications.enabled requires a JSON boolean",StatusCode::BAD_REQUEST));}
            if k=="permissions.default_mode"&&!p["value"].as_str().is_some_and(|v|["ask","auto"].contains(&v)){return Err(derr("invalid_argument","permissions.default_mode must be ask or auto",StatusCode::BAD_REQUEST));}
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
            let events=st.db.set_setting(k, &p["value"]).map_err(|e| {
                derr(
                    if k.starts_with("exec_gate.")||k=="permissions.default_mode"||k=="notifications.enabled"{"invalid_argument"}else{"internal"},
                    &e.to_string(),
                    if k.starts_with("exec_gate.")||k=="permissions.default_mode"||k=="notifications.enabled"{StatusCode::BAD_REQUEST}else{StatusCode::INTERNAL_SERVER_ERROR},
                )
            })?;
            st.broadcast_persisted(events);
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

fn validate_spawn_target(runtime: &RuntimeSpec) -> Result<(), DispatchError> {
    if runtime.executable.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("ps1")) {
        return Err(derr("invalid_argument", "runtime executable must resolve to a native executable", StatusCode::BAD_REQUEST));
    }
    if runtime.args.iter().any(|argument| argument.contains('\0')) {
        return Err(derr("invalid_argument", "stored launch arguments are invalid", StatusCode::BAD_REQUEST));
    }
    if runtime.args.is_empty() {
        return Ok(());
    }
    let is_node = runtime.executable.file_stem().is_some_and(|name| {
        name.to_string_lossy().eq_ignore_ascii_case("node")
    });
    let script = runtime.args.len() == 1
        && PathBuf::from(&runtime.args[0]).is_file()
        && PathBuf::from(&runtime.args[0]).extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("js") || extension.eq_ignore_ascii_case("cjs")
        });
    if is_node && script {
        Ok(())
    } else {
        Err(derr("invalid_argument", "stored launch arguments are outside the runtime allowlist", StatusCode::BAD_REQUEST))
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
fn exec_options_for_session(st:&AppState,session:&Value)->Result<ExecOptions,DispatchError>{
    let default=st.db.default_approval_mode().map_err(agent_error)?;
    let Some(agent_id)=session["agentId"].as_str() else { return Ok(ExecOptions{approval_mode:parse_mode(&default),max_concurrency:4,..ExecOptions::default()}); };
    let a=st.db.agent_get(agent_id).map_err(agent_error)?;
    let env=a["customEnv"].as_object().map(|o|o.iter().filter_map(|(k,v)|v.as_str().map(|s|(k.clone(),s.to_owned()))).collect()).unwrap_or_default();
    let mode=a["approvalMode"].as_str().unwrap_or(&default);
    Ok(ExecOptions{approval_mode:parse_mode(mode),model:a["model"].as_str().map(str::to_owned),thinking:a["thinking"].as_str().map(str::to_owned),service_tier:a["serviceTier"].as_str().map(str::to_owned),instructions:a["instructions"].as_str().filter(|s|!s.trim().is_empty()).map(str::to_owned),extra_args:a["customArgs"].as_array().map(|v|v.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default(),env,max_concurrency:a["maxConcurrency"].as_u64().unwrap_or(1) as u32})
}
fn parse_mode(s:&str)->ApprovalMode{match s{"auto"=>ApprovalMode::Auto,"bypass"=>ApprovalMode::Bypass,_=>ApprovalMode::Ask}}
fn provider_mode(provider:&str)->&'static str{match provider{"claude"=>"bypassPermissions","codex"=>"never",_=>"daemon_allow_all"}}
fn normalized_permission(provider:&str,raw:&Value)->(String,Value){
    let name=raw["request"]["tool_name"].as_str().or_else(||raw["params"]["toolCall"]["kind"].as_str()).or_else(||raw["toolCall"]["kind"].as_str()).unwrap_or("");
    let mut body=if provider=="claude"&&!raw["request"]["input"].is_null(){raw["request"]["input"].clone()}else if !raw["params"]["toolCall"].is_null(){raw["params"]["toolCall"].clone()}else{raw.clone()};
    if let Some(s)=body.as_str(){if let Ok(parsed)=serde_json::from_str::<Value>(s){body=parsed}}
    let mut kind=name.to_ascii_lowercase().replace(['-','_',' '],"");
    if kind.is_empty(){let title=raw["params"]["toolCall"]["title"].as_str().or_else(||raw["toolCall"]["title"].as_str()).unwrap_or("").to_ascii_lowercase();if title.contains("command")||title.contains("shell")||title.contains("terminal"){kind="shell".into();}}
    kind=match kind.as_str(){"bash"|"shell"|"terminal"|"command"=>"shell".into(),"read"|"glob"|"grep"|"ls"|"list"|"search"=>kind,"notebookread"=>"notebook_read".into(),"edit"|"write"=>kind,"notebookedit"=>"edit".into(),_=>"unknown".into()};
    (kind,body)
}
async fn emit_codex_startup_rejections(st:&AppState,session_id:&str,agent_id:Option<&str>,runtime_id:&str,options:&ExecOptions){
    for (setting,requested) in [("model",options.model.as_ref()),("thinking",options.thinking.as_ref()),("serviceTier",options.service_tier.as_ref()),("instructions",options.instructions.as_ref())] {
        if requested.is_some(){st.emit("exec.options.rejected",json!({"sessionId":session_id,"agentId":agent_id,"runtimeId":runtime_id,"setting":setting,"code":"provider_rejected","reason":"Codex app-server rejected the requested startup settings before prompt delivery."})).await;}
    }
}
async fn active_for_agent(st:&AppState,agent_id:&str)->u32{
    let sessions=st.active_turns.lock().await.keys().cloned().collect::<Vec<_>>();let mut n=0;
    for sid in sessions{if st.db.session_detail(&sid).is_ok_and(|v|v["agentId"]==agent_id){n+=1;}}n
}
fn catalog_key(runtime: &Value) -> String {
    format!("{}|{}|{}|{}|{}", runtime["id"].as_str().unwrap_or(""), runtime["executablePath"].as_str().unwrap_or(""), runtime["version"].as_str().unwrap_or(""), serde_json::to_string(&runtime["launchArgs"]).unwrap_or_default(), runtime["profileId"].as_str().unwrap_or(""))
}
async fn fetch_model_catalog(st: &AppState, runtime: &Value, refresh: bool) -> Result<Value, DispatchError> {
    let spec = runtime_from(runtime);
    let key = catalog_key(runtime);
    let cache = MODEL_CATALOG_CACHE.get_or_init(|| StdMutex::new(HashMap::new()));
    if !refresh { if let Ok(cache) = cache.lock() { if let Some((at, value)) = cache.get(&key) { if at.elapsed() < std::time::Duration::from_secs(60) { return Ok(value.clone()); } } } }
    let provider = runtime["provider"].as_str().unwrap_or("");
    let adapter = adapter_for(&st.adapters, provider).ok_or_else(|| derr("unsupported", "model catalogs are unsupported for this runtime", StatusCode::BAD_REQUEST))?;
    let mut catalog = adapter.model_catalog(&spec).await.map_err(|e| match e {
        bloblex_agent_core::AdapterError::Unsupported(_) => derr("unsupported", "model catalogs are unsupported for this runtime", StatusCode::BAD_REQUEST),
        bloblex_agent_core::AdapterError::Process(_) => derr("provider_unavailable", "runtime model catalog is unavailable", StatusCode::BAD_GATEWAY),
        _ => derr("provider_error", "runtime returned an invalid model catalog", StatusCode::BAD_GATEWAY),
    })?;
    model_presentation::apply(&mut catalog.models, catalog.validated, catalog.fallback);
    let value = json!({"runtimeId":spec.runtime_id,"provider":provider,"models":catalog.models,"fetchedAt":catalog.fetched_at,"expiresAt":catalog.expires_at,"fallback":catalog.fallback,"source":catalog.source,"validated":catalog.validated});
    if let Ok(mut cache) = cache.lock() { cache.insert(key, (Instant::now(), value.clone())); }
    Ok(value)
}
async fn runtime_models(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = p["runtimeId"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| derr("invalid_argument", "runtimeId is required", StatusCode::BAD_REQUEST))?;
    let refresh = p.get("refresh").map(|v| v.as_bool().ok_or_else(|| derr("invalid_argument", "refresh must be a boolean", StatusCode::BAD_REQUEST))).transpose()?.unwrap_or(false);
    let runtime = st.runtimes.read().await.iter().find(|r| r["id"] == id).cloned().ok_or_else(|| derr("not_found", "runtime not found", StatusCode::NOT_FOUND))?;
    fetch_model_catalog(st, &runtime, refresh).await
}
async fn validate_agent_catalog(st: &AppState, runtime_id: &str, value: &Value) -> Result<(), DispatchError> {
    for key in ["model", "thinking", "serviceTier"] {
        if value.get(key).is_some_and(|v| v.is_string() && v.as_str().unwrap().is_empty()) { return Err(derr("invalid_argument", &format!("{key} must be a non-empty identifier"), StatusCode::BAD_REQUEST)); }
    }
    if value["customArgs"].as_array().is_some_and(|a| !a.is_empty()) { return Err(derr("invalid_argument", "customArgs must be empty", StatusCode::BAD_REQUEST)); }
    if let Some(env) = value["customEnv"].as_object() {
        const ALLOWED: [&str; 5] = ["LANG", "LC_ALL", "TZ", "NO_COLOR", "TERM"];
        for (key, val) in env {
            let upper = key.to_ascii_uppercase();
            let secret = ["TOKEN", "SECRET", "PASSWORD", "KEY", "AUTH", "CREDENTIAL", "COOKIE"].iter().any(|p| upper.contains(p));
            if secret || !ALLOWED.contains(&upper.as_str()) || val.as_str().is_none_or(|s| s.contains('\0')) { return Err(derr("invalid_argument", "customEnv contains an unsupported key or value", StatusCode::BAD_REQUEST)); }
        }
    }
    let runtime = st.runtimes.read().await.iter().find(|r| r["id"] == runtime_id).cloned().ok_or_else(|| derr("not_found", "runtime not found", StatusCode::NOT_FOUND))?;
    let catalog = match fetch_model_catalog(st, &runtime, false).await { Ok(c) => c, Err(_) => return Ok(()) };
    validate_option_values_against_catalog(value["model"].as_str(),value["thinking"].as_str(),value["serviceTier"].as_str(),Some(&catalog),runtime["provider"]=="codex")
}
fn validate_option_values_against_catalog(model_id:Option<&str>,thinking:Option<&str>,service_tier:Option<&str>,catalog:Option<&Value>,allow_standard_turn_tier:bool)->Result<(),DispatchError>{
    if service_tier==Some("fast")||(service_tier==Some("standard")&&!allow_standard_turn_tier){return Err(derr("invalid_argument","serviceTier must be a catalog tier id; standard speed is a per-turn default request",StatusCode::BAD_REQUEST));}
    let Some(catalog)=catalog.filter(|c|c["validated"]==true && c["fallback"]!=true)else{return Ok(())};
    let models=catalog["models"].as_array().ok_or_else(||derr("provider_error","runtime returned an invalid model catalog",StatusCode::BAD_GATEWAY))?;
    let selected=if let Some(id)=model_id{Some(models.iter().find(|m|m["id"]==id).ok_or_else(||derr("invalid_argument","model is not available in this runtime catalog",StatusCode::BAD_REQUEST))?)}else{None};
    if let Some(effort) = thinking {
        let selected_efforts = selected
            .and_then(|model| model["supportedThinking"].as_array())
            .filter(|values| !values.is_empty());
        if let Some(values) = selected_efforts {
            if !values.iter().any(|value| value.as_str() == Some(effort)) {
                return Err(derr(
                    "invalid_argument",
                    "thinking is not supported by the selected model",
                    StatusCode::BAD_REQUEST,
                ));
            }
        } else if selected.is_none() {
            let known_efforts = models
                .iter()
                .filter_map(|model| model["supportedThinking"].as_array())
                .filter(|values| !values.is_empty())
                .collect::<Vec<_>>();
            if !known_efforts.is_empty()
                && !known_efforts
                    .iter()
                    .any(|values| values.iter().any(|value| value.as_str() == Some(effort)))
            {
                return Err(derr(
                    "invalid_argument",
                    "thinking is not supported by the runtime catalog",
                    StatusCode::BAD_REQUEST,
                ));
            }
        }
    }
    if let Some(tier)=service_tier.filter(|tier|!(allow_standard_turn_tier&&*tier=="standard")){let supported=selected.map(|m|m["serviceTiers"].as_array().is_some_and(|a|a.iter().any(|v|v["id"]==tier))).unwrap_or_else(||models.iter().any(|m|m["serviceTiers"].as_array().is_some_and(|a|a.iter().any(|v|v["id"]==tier))));if !supported{return Err(derr("invalid_argument",if selected.is_some(){"serviceTier is not supported by the selected model"}else{"serviceTier is not supported by the runtime catalog"},StatusCode::BAD_REQUEST));}}
    Ok(())
}
async fn validate_exec_catalog(st:&AppState,runtime:&Value,options:&ExecOptions)->Result<(),DispatchError>{
    for (name,value) in [("model",options.model.as_deref()),("thinking",options.thinking.as_deref()),("serviceTier",options.service_tier.as_deref())]{if value.is_some_and(str::is_empty){return Err(derr("invalid_argument",&format!("{name} must be a non-empty identifier"),StatusCode::BAD_REQUEST));}}
    if options.model.is_none()&&options.thinking.is_none()&&options.service_tier.is_none(){return Ok(())}
    let catalog=fetch_model_catalog(st,runtime,false).await.ok();
    validate_option_values_against_catalog(options.model.as_deref(),options.thinking.as_deref(),options.service_tier.as_deref(),catalog.as_ref(),runtime["provider"]=="codex")
}
async fn preflight_exec_options(st:&AppState,runtime:&Value,provider:&str,options:&ExecOptions)->Option<(String,DispatchError)>{
    if let Ok(Some((setting,reason)))=exec_option_rejection(st,provider,options){return Some((setting.into(),derr("unsupported",reason,StatusCode::BAD_REQUEST)))}
    if let Err(error)=validate_exec_catalog(st,runtime,options).await {
        let setting=if error.1.message.contains("thinking"){"thinking"}else if error.1.message.contains("serviceTier"){"serviceTier"}else{"model"};return Some((setting.into(),error))
    }
    None
}
const EXEC_UNAVAILABLE: &str = "The requested setting is unavailable for this runtime until its execution check passes.";
fn safe_requested_options(options: &ExecOptions) -> Value {
    json!({"model":options.model,"thinking":options.thinking,"serviceTier":options.service_tier,"approvalMode":options.approval_mode.as_str(),"instructionsPresent":options.instructions.is_some(),"extraArgs":[],"maxConcurrency":options.max_concurrency,"customEnvKeys":options.env.keys().collect::<Vec<_>>()})
}
fn exec_option_rejection(st: &AppState, provider: &str, options: &ExecOptions) -> Result<Option<(&'static str, &'static str)>, DispatchError> {
    let capabilities: &[(&str, bool)] = match provider {
        "claude" => &[("model",true),("thinking",true),("serviceTier",false),("instructions",true)],
        "codex" => &[("model",true),("thinking",true),("serviceTier",true),("instructions",true)],
        "opencode" => &[("model",true),("thinking",true),("serviceTier",false),("instructions",true)],
        _ => &[],
    };
    let settings = st.db.settings().map_err(|e| derr("internal", &e.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
    for (name, value) in [("model",options.model.is_some()),("thinking",options.thinking.is_some()),("serviceTier",options.service_tier.is_some()),("instructions",options.instructions.is_some())] {
        if !value { continue; }
        let supported = capabilities.iter().find(|(key,_)| *key == name).is_some_and(|(_,yes)| *yes);
        let gate_name = if name == "serviceTier" { "serviceTier" } else { name };
        let enabled = if name == "serviceTier" && provider == "claude" { false } else { supported && settings[&format!("exec_gate.{provider}.{gate_name}")].as_bool().unwrap_or(false) };
        if !enabled { return Ok(Some((name, EXEC_UNAVAILABLE))); }
    }
    Ok(None)
}
async fn runtime_capabilities(st:&AppState,p:&Value)->Result<Value,DispatchError>{
    let runtime_id=p["runtimeId"].as_str().filter(|s|!s.is_empty()).ok_or_else(||derr("invalid_argument","runtimeId is required",StatusCode::BAD_REQUEST))?;
    let runtime=st.runtimes.read().await.iter().find(|r|r["id"]==runtime_id).cloned().ok_or_else(||derr("not_found","runtime not found",StatusCode::NOT_FOUND))?;
    let provider=runtime["provider"].as_str().unwrap_or("");
    let table:[(&str,bool,&str,&str);5]=match provider{
        "claude"=>[("model",true,"spawn","provider_echo"),("thinking",true,"spawn","usage_effect"),("serviceTier",false,"turn","none"),("instructions",true,"spawn","successful_turn"),("customEnv",true,"process","request_shape")],
        "codex"=>[("model",true,"spawn","provider_echo"),("thinking",true,"turn","usage_effect"),("serviceTier",true,"turn","provider_echo"),("instructions",true,"spawn","successful_turn"),("customEnv",true,"process","request_shape")],
        "opencode"=>[("model",true,"session","provider_echo"),("thinking",true,"session","none"),("serviceTier",false,"session","none"),("instructions",true,"session","successful_turn"),("customEnv",true,"process","request_shape")],
        _=>[("model",false,"turn","none"),("thinking",false,"turn","none"),("serviceTier",false,"turn","none"),("instructions",false,"turn","none"),("customEnv",false,"process","none")],
    };
    let settings=st.db.settings().map_err(|e|derr("internal",&e.to_string(),StatusCode::INTERNAL_SERVER_ERROR))?;
    let mut reported=serde_json::Map::new();
    for (setting,supported,scope,evidence) in table {
        let key=match setting{"model"=>format!("exec_gate.{provider}.model"),"thinking"=>format!("exec_gate.{provider}.thinking"),"serviceTier"=>format!("exec_gate.{provider}.serviceTier"),"instructions"=>format!("exec_gate.{provider}.instructions"),_=>String::new()};
        let gate=if key.is_empty(){true}else{settings[&key].as_bool().unwrap_or(false)};
        let mut value=json!({"supported":supported,"enabled":supported&&gate,"scope":scope,"evidence":evidence});
        if setting=="customEnv"{value["allowedKeys"]=json!(["LANG","LC_ALL","TZ","NO_COLOR","TERM"]);}
        if !supported{value["reason"]=json!(if setting=="customEnv"{"environment options are unsupported for this runtime"}else{"setting is unsupported by this runtime"});}
        else if !gate{value["reason"]=json!("execution entry gate is disabled");}
        reported.insert(setting.into(),value);
    }
    let active=st.active_turns.lock().await.len() as u32;
    let agent_id=match p.get("agentId"){None|Some(Value::Null)=>None,Some(Value::String(s))=>Some(s.as_str()),_=>return Err(derr("invalid_argument","agentId must be a string",StatusCode::BAD_REQUEST))};
    let agent_concurrency=if let Some(id)=agent_id{
        let a=st.db.agent_get(id).map_err(agent_error)?;if a["runtimeId"]!=runtime_id{return Err(derr("invalid_argument","agentId does not belong to runtimeId",StatusCode::BAD_REQUEST));}
        let configured=a["maxConcurrency"].as_u64().unwrap_or(1) as u32;Some(json!({"configuredMaxConcurrency":configured,"effectiveMaxConcurrency":configured.min(4),"active":active_for_agent(st,id).await}))
    }else{None};
    let mut agents=Vec::new();
    if agent_id.is_none(){for a in st.db.agent_list(false,Some(runtime_id)).map_err(agent_error)?{let id=a["id"].as_str().unwrap_or("");let configured=a["maxConcurrency"].as_u64().unwrap_or(1) as u32;agents.push(json!({"agentId":id,"configuredMaxConcurrency":configured,"effectiveMaxConcurrency":configured.min(4),"active":active_for_agent(st,id).await}));}}
    let provider_version = runtime["version"].as_str().unwrap_or("");
    let version_recognized = recognized_cli_version(provider, provider_version);
    Ok(json!({"runtimeId":runtime_id,"versionRecognized":version_recognized,"settings":reported,"globalConcurrency":{"limit":4,"active":active},"agentConcurrency":agent_concurrency,"agentConcurrencies":agents,"hostDependent":true}))
}

fn recognized_cli_version(provider: &str, version: &str) -> bool {
    let lower = version.to_ascii_lowercase();
    let token = lower
        .split_whitespace()
        .find(|part| part.bytes().next().is_some_and(|byte| byte.is_ascii_digit()))
        .unwrap_or("");
    let mut parts = token.split('.');
    let Some(major) = parts.next().and_then(|part| part.parse::<u32>().ok()) else {
        return false;
    };
    if parts.next().and_then(|part| part.parse::<u32>().ok()).is_none() {
        return false;
    }
    match provider {
        "claude" => major >= 2,
        "codex" => major <= 1,
        "opencode" => major >= 1,
        _ => false,
    }
}
async fn new_session(st: &AppState, p: Value) -> Result<Value, DispatchError> {
    let agent_supplied=p.get("agentId").is_some(); let runtime_supplied=p.get("runtimeId").is_some();
    if agent_supplied==runtime_supplied{return Err(derr("invalid_argument","exactly one of agentId or runtimeId is required",StatusCode::BAD_REQUEST));}
    let agent_id=if agent_supplied{Some(p["agentId"].as_str().ok_or_else(||derr("invalid_argument","agentId must be a string",StatusCode::BAD_REQUEST))?.to_owned())}else{None};
    let runtime_id = if let Some(agent_id)=agent_id.as_deref(){let agent=st.db.agent_get(agent_id).map_err(agent_error)?;if agent["archived"]==true{return Err(derr("conflict","archived agents cannot start sessions",StatusCode::CONFLICT));}agent["runtimeId"].as_str().unwrap_or("").to_owned()}else{p["runtimeId"].as_str().ok_or_else(||derr("invalid_argument","runtimeId must be a string",StatusCode::BAD_REQUEST))?.to_owned()};
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
    validate_spawn_target(&spec)?;
    let provider = runtime["provider"].as_str().unwrap_or("").to_owned();
    let adapter = adapter_for(&st.adapters, &provider).ok_or_else(|| {
        derr(
            "unsupported",
            "provider adapter is not available",
            StatusCode::BAD_REQUEST,
        )
    })?;
    let options_session=if let Some(agent_id)=agent_id.as_deref(){st.db.agent_get(agent_id).map_err(agent_error)?}else{json!({"agentId":null})};
    let exec_options=exec_options_for_session(st,&options_session)?;
    let id = Uuid::new_v4().to_string();
    if let Some((setting, error)) = preflight_exec_options(st,&runtime,&provider,&exec_options).await {
        st.emit("exec.options.rejected", json!({"sessionId":id,"agentId":agent_id,"runtimeId":runtime_id,"setting":setting,"code":error.1.code,"reason":error.1.message})).await;
        return Err(error);
    }
    let title = p["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("New chat")
        .to_owned();
    st.db
        .create_session_for_agent(
            &id,
            &runtime_id,
            &provider,
            &project.to_string_lossy(),
            &title,
            agent_id.as_deref(),
        )
        .map_err(agent_error)?;
    let startup_options=exec_options.clone();
    let (tx, rx) = tokio::sync::mpsc::channel(256);
    let handle_result = adapter
        .new_session(
            &spec,
            NewSessionRequest {
                session_id: id.clone(),
                project_path: project,
                exec_options,
            },
            tx,
        )
        .await;
    let handle=match handle_result {
        Ok(handle)=>handle,
        Err(e)=>{
            let _=st.db.update_session_state(&id,"error");
            if provider=="codex"&&matches!(&e,bloblex_agent_core::AdapterError::Rejected(_)) {emit_codex_startup_rejections(st,&id,agent_id.as_deref(),&runtime_id,&startup_options).await;}
            return Err(derr("provider_error",&e.to_string(),StatusCode::BAD_GATEWAY));
        }
    };
    st.db
        .set_session_provider_id(&id, &handle.provider_session_id, handle.capabilities.resume)
        .map_err(|e| {
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        })?;
    st.db.update_session_state(&id, "idle").map_err(|e| {
        derr("internal", &e.to_string(), StatusCode::INTERNAL_SERVER_ERROR)
    })?;
    let active = ActiveSession {
        handle: handle.clone(),
        runtime: spec,
        adapter,
        launch_approval_mode: startup_options.approval_mode,
    };
    st.sessions.lock().await.insert(id.clone(), active);
    if startup_options.approval_mode==ApprovalMode::Bypass && matches!(provider.as_str(),"claude"|"codex") { st.emit("permission.bypass_active",json!({"sessionId":id,"agentId":agent_id,"providerMode":provider_mode(&provider)})).await; }
    let state = st.clone();
    let stream_id = id.clone();
    let event_provider = provider.clone();
    let event_runtime = runtime_id.clone();
    tokio::spawn(async move {
        forward_events(state, stream_id, event_provider, event_runtime, rx).await
    });
    if let Ok(session_event) = st.db.session_event_summary(&id) {
        st.emit("session.changed", session_event).await;
    }
    Ok(
        json!({"id":id,"runtimeId":runtime_id,"agentId":agent_id,"provider":provider,"providerSessionId":handle.provider_session_id,"projectPath":p["projectPath"],"title":title,"state":"idle","resumable":handle.capabilities.resume,"turns":[],"messages":[],"tools":[],"files":[]}),
    )
}
async fn resume_or_start_fresh(
    st: &AppState,
    adapter: Arc<dyn AgentAdapter>,
    runtime: &RuntimeSpec,
    session_id: &str,
    provider_session_id: String,
    project_path: PathBuf,
    exec_options: ExecOptions,
) -> Result<(SessionHandle, tokio::sync::mpsc::Receiver<AgentEvent>, bool), bloblex_agent_core::AdapterError> {
    let (tx, rx) = tokio::sync::mpsc::channel(256);
    match adapter
        .resume_session(
            runtime,
            ResumeSessionRequest {
                session_id: session_id.to_owned(),
                provider_session_id,
                project_path: project_path.clone(),
                exec_options: exec_options.clone(),
            },
            tx,
        )
        .await
    {
        Ok(handle) => Ok((handle, rx, false)),
        Err(bloblex_agent_core::AdapterError::ResumeRejected) => {
            st.db
                .clear_session_provider_id(session_id)
                .map_err(|error| bloblex_agent_core::AdapterError::Other(error.to_string()))?;
            st.emit(
                "session.resume_rejected",
                json!({
                    "sessionId": session_id,
                    "outcomeNote": "The saved provider session expired. A new provider session was started."
                }),
            )
            .await;
            let (fresh_tx, fresh_rx) = tokio::sync::mpsc::channel(256);
            let handle = adapter
                .new_session(
                    runtime,
                    NewSessionRequest {
                        session_id: session_id.to_owned(),
                        project_path,
                        exec_options,
                    },
                    fresh_tx,
                )
                .await?;
            Ok((handle, fresh_rx, true))
        }
        Err(error) => Err(error),
    }
}

async fn resume_session(st: &AppState, p: Value) -> Result<Value, DispatchError> {
    let sid = p["sessionId"].as_str().unwrap_or("").to_owned();
    let gate = gate_for_session(st, &sid).await;
    let (row, previous_state) = {
        let _guard = gate.lock().await;
        if session_is_deleted(st, &sid).await { return Err(derr("not_found", "session not found", StatusCode::NOT_FOUND)); }
        if st.sessions.lock().await.contains_key(&sid) {
            return Err(derr("conflict", "session is already active", StatusCode::CONFLICT));
        }
        let state = st.db.session_state(&sid).map_err(|e| derr("internal", &e.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
        let Some(previous_state) = state else { return Err(derr("not_found", "session not found", StatusCode::NOT_FOUND)); };
        if matches!(previous_state.as_str(), "starting" | "working" | "cancelling" | "waiting_permission") {
            return Err(derr("conflict", "session is already active", StatusCode::CONFLICT));
        }
        let row = st.db.session_detail(&sid).map_err(|_| derr("not_found", "session not found", StatusCode::NOT_FOUND))?;
        (row, previous_state)
    };
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
    validate_spawn_target(&spec)?;
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
    let exec_options=exec_options_for_session(st,&row)?;
    if let Some((setting, error)) = preflight_exec_options(st,&rt,&provider,&exec_options).await {
        let _guard = gate.lock().await;
        if !session_gate_is_current(st, &sid, &gate).await || session_is_deleted(st, &sid).await || !st.db.session_exists(&sid).unwrap_or(false) {
            return Err(derr("not_found", "session not found", StatusCode::NOT_FOUND));
        }
        if st.db.session_state(&sid).ok().flatten().as_deref() != Some(previous_state.as_str()) || st.sessions.lock().await.contains_key(&sid) {
            return Err(derr("conflict", "session changed while resume was preparing", StatusCode::CONFLICT));
        }
        st.emit("exec.options.rejected", json!({"sessionId":sid,"agentId":row["agentId"],"runtimeId":runtime,"setting":setting,"code":error.1.code,"reason":error.1.message})).await;
        return Err(error);
    }
    let desired_instruction_hash=bloblex_agent_core::instruction_sha256(exec_options.instructions.as_deref().unwrap_or(""));
    if provider=="codex" {let baseline=st.db.codex_thread_instruction_sha256(&sid).map_err(|e|derr("internal",&e.to_string(),StatusCode::INTERNAL_SERVER_ERROR))?;adapter.set_instruction_hash_context(&sid,desired_instruction_hash,baseline).await;}
    let startup_options=exec_options.clone();
    let resume_result = resume_or_start_fresh(
        st,
        adapter.clone(),
        &spec,
        &sid,
        native_id,
        project.clone(),
        exec_options,
    )
    .await;
    let (handle, rx, resume_fallback) = match resume_result {
        Ok(result) => result,
        Err(bloblex_agent_core::AdapterError::ContextExhausted) => {
            st.emit("session.context_exhausted", json!({"sessionId": sid,"canRetireSession": true,"message": "Context window is full. Start a new conversation."})).await;
            return Err(derr("provider_error", "Context window is full. Start a new conversation.", StatusCode::BAD_GATEWAY));
        }
        Err(other) => {
            if provider=="codex"&&matches!(&other,bloblex_agent_core::AdapterError::Rejected(_)) {emit_codex_startup_rejections(st,&sid,row["agentId"].as_str(),&runtime,&startup_options).await;}
            return Err(derr("provider_error",&other.to_string(),StatusCode::BAD_GATEWAY));
        }
    };
    let current_gate = gate_for_session(st, &sid).await;
    let installed = {
        let _guard = current_gate.lock().await;
        let installed = session_gate_is_current(st, &sid, &gate).await
            && !session_is_deleted(st, &sid).await
            && st.db.session_state(&sid).ok().flatten().as_deref() == Some(previous_state.as_str())
            && st.db.session_detail(&sid).is_ok_and(|session| session["archived"] != true)
            && !st.sessions.lock().await.contains_key(&sid);
        if installed {
            st.sessions.lock().await.insert(sid.clone(), ActiveSession {
                handle: handle.clone(),
                runtime: spec.clone(),
                adapter: adapter.clone(),
                launch_approval_mode: startup_options.approval_mode,
            });
            st.db.update_session_state(&sid, "idle").map_err(|e| derr("internal", &e.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
            if let Ok(summary) = st.db.session_event_summary(&sid) { st.emit("session.changed", summary).await; }
        }
        installed
    };
    if !installed {
        let _ = adapter.close_session(&handle).await;
        if session_is_deleted(st, &sid).await || !st.db.session_exists(&sid).unwrap_or(false) {
            return Err(derr("not_found", "session not found", StatusCode::NOT_FOUND));
        }
        return Err(derr(
            "conflict",
            "session became active while resume was starting",
            StatusCode::CONFLICT,
        ));
    }
    if startup_options.approval_mode==ApprovalMode::Bypass&&matches!(provider.as_str(),"claude"|"codex"){st.emit("permission.bypass_active",json!({"sessionId":sid,"agentId":row["agentId"],"providerMode":provider_mode(&provider)})).await;}
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
    Ok(json!({
        "sessionId": p["sessionId"],
        "resumed": !resume_fallback,
        "state": "idle",
        "outcomeNote": resume_fallback.then_some("The saved provider session expired. A new provider session was started.")
    }))
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
    let mut gate = gate_for_session(st, &sid).await;
    let (mut active, session_options, previous_state) = {
        let _guard = gate.lock().await;
        if session_is_deleted(st, &sid).await || !session_gate_is_current(st, &sid, &gate).await {
            return Err(derr("not_found", "active session not found", StatusCode::NOT_FOUND));
        }
        let active = st.sessions.lock().await.get(&sid).cloned().ok_or_else(|| derr("not_found", "active session not found", StatusCode::NOT_FOUND))?;
        if st.active_turns.lock().await.contains_key(&sid) { return Err(derr("conflict", "this session already has an active turn", StatusCode::CONFLICT)); }
        let row = st.db.session_detail(&sid).map_err(|_| derr("not_found", "session not found", StatusCode::NOT_FOUND))?;
        let state = row["state"].as_str().unwrap_or("idle").to_owned();
        if matches!(state.as_str(), "starting" | "working" | "cancelling" | "waiting_permission") {
            return Err(derr("conflict", "this session already has an active turn", StatusCode::CONFLICT));
        }
        (active, row, state)
    };
    let exec_options=exec_options_for_session(st,&session_options)?;
    let turn = Uuid::new_v4().to_string();
    let runtime_value=st.runtimes.read().await.iter().find(|r|r["id"]==active.runtime.runtime_id).cloned().unwrap_or(Value::Null);
    let desired_instruction_hash=bloblex_agent_core::instruction_sha256(exec_options.instructions.as_deref().unwrap_or(""));
    let baseline=if active.runtime.provider=="codex" {st.db.codex_thread_instruction_sha256(&sid)}else{st.db.claude_instruction_sha256(&sid)}.map_err(|e|derr("internal",&e.to_string(),StatusCode::INTERNAL_SERVER_ERROR))?;
    let mut rejection=preflight_exec_options(st,&runtime_value,&active.runtime.provider,&exec_options).await;
    if rejection.is_none(){if let Err(e)=active.adapter.preflight_exec_options(&exec_options).await{let (code,msg)=match e{bloblex_agent_core::AdapterError::Unsupported(m)=>("unsupported",m),_=>("provider_error","Provider option preparation failed before prompt delivery.".into())};rejection=Some(("instructions".into(),derr(code,&msg,StatusCode::BAD_REQUEST)));}}
    if let Some((setting, error)) = rejection {
        let _guard = gate.lock().await;
        if !session_gate_is_current(st, &sid, &gate).await || session_is_deleted(st, &sid).await || !st.db.session_exists(&sid).unwrap_or(false) {
            return Err(derr("not_found", "active session not found", StatusCode::NOT_FOUND));
        }
        if !st.sessions.lock().await.contains_key(&sid) || st.active_turns.lock().await.contains_key(&sid) {
            return Err(derr("conflict", "this session is no longer available for a new turn", StatusCode::CONFLICT));
        }
        let snapshot_id = Uuid::new_v4().to_string();
        let requested=safe_requested_options(&exec_options);let applied=json!({setting.clone():{"applied":false,"reason":"execution_gate_or_capability_unavailable"}});
        let (_,event)=st.db.reject_exec_turn(&sid,&turn,&snapshot_id,&text,&requested,&applied,&json!({}),desired_instruction_hash.as_deref(),&json!({"adapter":active.runtime.provider}),&json!({"agentId":session_options["agentId"],"runtimeId":active.runtime.runtime_id,"setting":setting,"code":error.1.code,"reason":error.1.message})).map_err(|e|derr("internal",&e.to_string(),StatusCode::INTERNAL_SERVER_ERROR))?;
        st.broadcast_persisted(vec![event]);
        return Err(error);
    }
    active.adapter.set_instruction_hash_context(&sid,desired_instruction_hash.clone(),baseline.clone()).await;
    if active.runtime.provider == "codex" && active.launch_approval_mode != exec_options.approval_mode {
        let old = {
            let _guard = gate.lock().await;
            if !session_gate_is_current(st, &sid, &gate).await || session_is_deleted(st, &sid).await || !st.db.session_exists(&sid).unwrap_or(false) {
                return Err(derr("not_found", "active session not found", StatusCode::NOT_FOUND));
            }
            if st.active_turns.lock().await.contains_key(&sid) { return Err(derr("conflict", "this session already has an active turn", StatusCode::CONFLICT)); }
            let Some(old) = st.sessions.lock().await.remove(&sid) else { return Err(derr("not_found", "active session not found", StatusCode::NOT_FOUND)); };
            remove_session_gate(st, &sid, &gate).await;
            old
        };
        old.adapter.close_session(&old.handle).await.map_err(|error| derr("provider_error", &error.to_string(), StatusCode::BAD_GATEWAY))?;
        if session_is_deleted(st, &sid).await || !st.db.session_exists(&sid).unwrap_or(false) {
            return Err(derr("not_found", "session not found", StatusCode::NOT_FOUND));
        }
        let (tx, rx) = tokio::sync::mpsc::channel(256);
        let handle = old.adapter.resume_session(
            &old.runtime,
            ResumeSessionRequest {
                session_id: sid.clone(),
                provider_session_id: old.handle.provider_session_id.clone(),
                project_path: PathBuf::from(session_options["projectPath"].as_str().unwrap_or("")),
                exec_options: exec_options.clone(),
            },
            tx,
        ).await.map_err(|error| derr("provider_error", &error.to_string(), StatusCode::BAD_GATEWAY))?;
        active = ActiveSession { handle: handle.clone(), runtime: old.runtime.clone(), adapter: old.adapter.clone(), launch_approval_mode: exec_options.approval_mode };
        gate = gate_for_session(st, &sid).await;
        let installed = {
            let _guard = gate.lock().await;
            if session_is_deleted(st, &sid).await || !st.db.session_exists(&sid).unwrap_or(false)
                || st.db.session_state(&sid).ok().flatten().as_deref() != Some(previous_state.as_str())
                || st.sessions.lock().await.contains_key(&sid)
            { false } else {
                st.sessions.lock().await.insert(sid.clone(), active.clone());
                true
            }
        };
        if !installed {
            let _ = active.adapter.close_session(&active.handle).await;
            return Err(if session_is_deleted(st, &sid).await || !st.db.session_exists(&sid).unwrap_or(false) {
                derr("not_found", "session not found", StatusCode::NOT_FOUND)
            } else { derr("conflict", "session changed while execution options were being applied", StatusCode::CONFLICT) });
        }
        let state = st.clone();
        let stream_id = sid.clone();
        let event_provider = active.runtime.provider.clone();
        let event_runtime = active.runtime.runtime_id.clone();
        tokio::spawn(async move { forward_events(state, stream_id, event_provider, event_runtime, rx).await; });
    }
    {
        let _event_guard = gate.lock().await;
        if !session_gate_is_current(st, &sid, &gate).await || session_is_deleted(st, &sid).await || !st.db.session_exists(&sid).unwrap_or(false) {
            return Err(derr("not_found", "active session not found", StatusCode::NOT_FOUND));
        }
        if !st.sessions.lock().await.contains_key(&sid) || st.active_turns.lock().await.contains_key(&sid) {
            return Err(derr("conflict", "this session already has an active turn", StatusCode::CONFLICT));
        }
        let live_session = st.db.session_detail(&sid).map_err(|_| derr("not_found", "session not found", StatusCode::NOT_FOUND))?;
        if live_session["archived"] == true || live_session["state"] != previous_state {
            return Err(derr("conflict", "session changed while a new turn was being prepared", StatusCode::CONFLICT));
        }
        let mut turns = st.active_turns.lock().await;
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
            let _ = st.db.record_budget_stopped_turn(&turn, &sid);
            return Err(derr("budget_blocked", "an applicable budget has insufficient remaining capacity or cannot be safely estimated", StatusCode::TOO_MANY_REQUESTS));
        }
        let admitted = st.db.create_reserved_turn(&turn, &sid).map_err(|e| {
            let _ = st.db.release_budget_turn(&turn);
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        })?;
        if !admitted {
            let _ = st.db.release_budget_turn(&turn);
            return Err(derr("conflict", "daemon or agent concurrency limit reached", StatusCode::CONFLICT));
        }
        st.db
            .append_message(&sid, &turn, "user", &text)
            .map_err(|e| {
                let _ = st.db.release_budget_turn(&turn);
                let _ = st.db.update_turn_outcome(&turn, "error", Some("other"));
                derr(
                    "internal",
                    &e.to_string(),
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            })?;
        let snapshot_id = Uuid::new_v4().to_string();
        let requested = safe_requested_options(&exec_options);
        let requested_any = exec_options.model.is_some() || exec_options.thinking.is_some() || exec_options.service_tier.is_some() || exec_options.instructions.is_some() || !exec_options.env.is_empty() || exec_options.approval_mode!=ApprovalMode::Ask;
        let settings = st.db.settings().unwrap_or(Value::Null);
        let gates = json!({"model":settings[format!("exec_gate.{}.model",active.runtime.provider)],"thinking":settings[format!("exec_gate.{}.thinking",active.runtime.provider)],"serviceTier":settings[format!("exec_gate.{}.serviceTier",active.runtime.provider)],"instructions":settings[format!("exec_gate.{}.instructions",active.runtime.provider)]});
        let launch_applied=active.runtime.provider=="claude"||active.runtime.provider=="codex";
        let mode_outcome=json!({"value":exec_options.approval_mode.as_str(),"applied":true,"kind":"request_shape","reason":if launch_applied{"provider launch mode requested for this turn"}else{"daemon policy mode"}});
        let snapshot = st.db.create_exec_snapshot(&sid,&turn,&snapshot_id,&requested,&json!({"approvalMode":mode_outcome}),&json!({"approvalMode":{"kind":"request_shape","value":exec_options.approval_mode.as_str()}}),desired_instruction_hash.as_deref(),&json!({"adapter":active.runtime.provider,"gates":gates,"approvalMode":exec_options.approval_mode.as_str()}),if requested_any{"partial"}else{"runtime_default"}).map_err(|e|{let _=st.db.update_turn_outcome(&turn,"error",Some("other"));let _=st.db.release_budget_turn(&turn);derr("internal",&e.to_string(),StatusCode::INTERNAL_SERVER_ERROR)})?;
        st.emit("exec.options.changed", json!({"sessionId":sid,"turnId":turn,"agentId":session["agentId"],"runtimeId":active.runtime.runtime_id,"requested":snapshot["requested"],"applied":snapshot["applied"],"snapshotId":snapshot_id})).await;
        st.db.update_session_state(&sid, "working").map_err(|e| {
            let _ = st.db.update_turn_outcome(&turn, "error", Some("other"));
            let _ = st.db.release_budget_turn(&turn);
            derr(
                "internal",
                &e.to_string(),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        })?;
        turns.insert(sid.clone(), turn.clone());
        drop(turns);
        if let Ok(working) = st.db.session_event_summary(&sid) {
            st.emit("session.changed", working).await;
        }
        if exec_options.approval_mode == ApprovalMode::Bypass && matches!(active.runtime.provider.as_str(), "claude" | "codex") {
            st.emit("permission.bypass_active", json!({"sessionId":sid,"agentId":session_options["agentId"],"providerMode":provider_mode(&active.runtime.provider)})).await;
        }
    }
    st.denied_turns.lock().await.remove(&turn);
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
                    exec_options,
                },
            )
            .await
        {
            let permission_denied = state.denied_turns.lock().await.remove(&turn2);
            let failure_class = adapter_failure_class(&e, permission_denied);
            let public_message = match failure_class {
                "context" => "Context window is full. Start a new conversation.",
                "config_unsupported" => "Requested execution settings were unsupported.",
                "provider_error" => "The provider reported a turn error.",
                "permission_denied" => "A required permission was denied.",
                _ => "The turn could not be completed.",
            };
            let gate = gate_for_session(&state, &sid2).await;
            let _guard = gate.lock().await;
            if !session_gate_is_current(&state, &sid2, &gate).await || session_is_deleted(&state, &sid2).await
                || !state.db.session_exists(&sid2).unwrap_or(false) || !state.sessions.lock().await.contains_key(&sid2)
            { return; }
            let _ = state.db.update_turn_outcome(&turn2, "error", Some(failure_class));
            let _ = state.db.update_session_state(&sid2, "error");
            // Budget admission remains charged when usage is unknown; the
            // concurrency slot is released because this execution ended.
            state.active_turns.lock().await.remove(&sid2);
            if let Ok(summary) = state.db.session_event_summary(&sid2) { state.emit("session.changed", summary).await; }
            state.emit("turn.error", json!({"sessionId":sid2,"turnId":turn2,"message":public_message})).await;
        }
    });
    Ok(json!({"turnId":turn,"accepted":true}))
}

async fn gate_for_session(st: &AppState, id: &str) -> Arc<Mutex<()>> {
    let mut gates = st.session_gates.lock().await;
    gates.entry(id.to_owned()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

async fn remove_session_gate(st: &AppState, id: &str, gate: &Arc<Mutex<()>>) {
    let mut gates = st.session_gates.lock().await;
    if gates.get(id).is_some_and(|current| Arc::ptr_eq(current, gate)) { gates.remove(id); }
}

async fn session_gate_is_current(st: &AppState, id: &str, gate: &Arc<Mutex<()>>) -> bool {
    st.session_gates.lock().await.get(id).is_some_and(|current| Arc::ptr_eq(current, gate))
}

async fn session_is_deleted(st: &AppState, id: &str) -> bool {
    st.deleted_sessions.lock().await.contains(id)
}

async fn restore_cancel_state(st: &AppState, id: &str, gate: &Arc<Mutex<()>>) {
    let _guard = gate.lock().await;
    if session_is_deleted(st, id).await || st.db.session_state(id).ok().flatten().as_deref() != Some("cancelling") { return; }
    let _ = st.db.update_session_state(id, "working");
    if let Ok(summary) = st.db.session_event_summary(id) { st.emit("session.changed", summary).await; }
}

async fn forward_events(
    st: AppState,
    sid: String,
    provider: String,
    runtime_id: String,
    rx: tokio::sync::mpsc::Receiver<AgentEvent>,
) {
    forward_events_with_timeouts(
        st,
        sid,
        provider,
        runtime_id,
        rx,
        std::time::Duration::from_secs(45),
        std::time::Duration::from_secs(300),
    )
    .await;
}

async fn forward_events_with_timeouts(
    st: AppState,
    sid: String,
    provider: String,
    runtime_id: String,
    mut rx: tokio::sync::mpsc::Receiver<AgentEvent>,
    startup_no_progress_timeout: std::time::Duration,
    semantic_inactivity_timeout: std::time::Duration,
) {
    let gate = gate_for_session(&st, &sid).await;
    let mut watched_turn: Option<String> = None;
    let mut last_semantic_progress = Instant::now();
    let mut saw_semantic_progress = false;
    loop {
        let active_turn = st.active_turns.lock().await.get(&sid).cloned();
        let received = if let Some(turn_id) = active_turn.as_ref() {
            if watched_turn.as_deref() != Some(turn_id.as_str()) {
                watched_turn = Some(turn_id.clone());
                last_semantic_progress = Instant::now();
                saw_semantic_progress = false;
            }
            let limit = if saw_semantic_progress {
                semantic_inactivity_timeout
            } else {
                startup_no_progress_timeout
            };
            let remaining = limit.saturating_sub(last_semantic_progress.elapsed());
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(event) => event,
                Err(_) => {
                    let active = {
                        let _guard = gate.lock().await;
                        if !session_gate_is_current(&st, &sid, &gate).await
                            || session_is_deleted(&st, &sid).await
                            || !st.db.session_exists(&sid).unwrap_or(false)
                        { break; }
                        st.sessions.lock().await.remove(&sid)
                    };
                    let mut resumed = None;
                    if let Some(active) = active {
                        let _ = active.adapter.close_session(&active.handle).await;
                        if let Some(row) = st.db.session_detail(&sid).ok() {
                            let options = exec_options_for_session(&st, &row).unwrap_or_default();
                            let (fresh_tx, fresh_rx) = tokio::sync::mpsc::channel(256);
                            if let Ok(handle) = active.adapter.resume_session(
                                &active.runtime,
                                ResumeSessionRequest {
                                    session_id: sid.clone(),
                                    provider_session_id: active.handle.provider_session_id.clone(),
                                    project_path: PathBuf::from(row["projectPath"].as_str().unwrap_or("")),
                                    exec_options: options,
                                },
                                fresh_tx,
                            ).await {
                                resumed = Some((ActiveSession {
                                    handle,
                                    runtime: active.runtime.clone(),
                                    adapter: active.adapter.clone(),
                                    launch_approval_mode: active.launch_approval_mode,
                                }, fresh_rx));
                            }
                        }
                    }
                    let _guard = gate.lock().await;
                    if !session_gate_is_current(&st, &sid, &gate).await
                        || session_is_deleted(&st, &sid).await
                        || !st.db.session_exists(&sid).unwrap_or(false)
                    {
                        drop(_guard);
                        if let Some((active, _)) = resumed { let _ = active.adapter.close_session(&active.handle).await; }
                        break;
                    }
                    if let Some((active, fresh_rx)) = resumed {
                        st.sessions.lock().await.insert(sid.clone(), active);
                        let _ = st.db.update_session_state(&sid, "idle");
                        rx = fresh_rx;
                    } else {
                        let _ = st.db.update_session_state(&sid, "error");
                    }
                    let _ = st.db.update_turn_outcome(turn_id, "error", Some("timeout"));
                    if let Ok(summary) = st.db.session_event_summary(&sid) { st.emit("session.changed", summary).await; }
                    st.active_turns.lock().await.remove(&sid);
                    st.emit("turn.error", json!({
                        "sessionId": sid,
                        "turnId": turn_id,
                        "failureClass": "timeout",
                        "message": "The provider stopped making progress before the turn completed."
                    })).await;
                    watched_turn = None;
                    continue;
                }
            }
        } else {
            watched_turn = None;
            match tokio::time::timeout(std::time::Duration::from_millis(100), rx.recv()).await {
                Ok(event) => event,
                Err(_) => continue,
            }
        };
        let Some(ev) = received else { break; };
        let event_guard = gate.lock().await;
        if !session_gate_is_current(&st, &sid, &gate).await
            || session_is_deleted(&st, &sid).await
            || !st.db.session_exists(&sid).unwrap_or(false)
            || !st.sessions.lock().await.contains_key(&sid)
        { break; }
        if matches!(
            &ev,
            AgentEvent::AssistantDelta { .. }
                | AgentEvent::AssistantMessage { .. }
                | AgentEvent::ThinkingDelta { .. }
                | AgentEvent::ToolStarted { .. }
                | AgentEvent::ToolUpdated { .. }
                | AgentEvent::ToolCompleted { .. }
                | AgentEvent::FileChanged { .. }
                | AgentEvent::PermissionRequested { .. }
        ) {
            saw_semantic_progress = true;
            last_semantic_progress = Instant::now();
        }
        let turn = st.active_turns.lock().await.get(&sid).cloned();
        let (ty, payload) = match ev {
            AgentEvent::SessionStarted {
                provider_session_id,
            } => {
                let _ = st
                    .db
                    .set_session_provider_id(&sid, &provider_session_id, true);
                let session = st.db.session_event_summary(&sid).unwrap_or(Value::Null);
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
                let inserted = st.db.insert_permission(
                    &id,
                    &sid,
                    &provider_request_id,
                    &title,
                    detail.as_deref(),
                    &choices,
                    &raw,
                );
                let session=st.db.session_detail(&sid).unwrap_or(Value::Null);
                let default=st.db.default_approval_mode().unwrap_or_else(|_|"ask".into());
                let mode=session["agentId"].as_str().and_then(|agent|st.db.agent_get(agent).ok()).and_then(|a|a["approvalMode"].as_str().map(str::to_owned)).unwrap_or(default);
                let turn_id=turn.clone();
                let (kind,normalized)=normalized_permission(&provider,&raw);
                let base_summary=bloblex_agent_core::permission_summary(&kind,&normalized);
                let (summary,decision)=if mode=="bypass" { (base_summary,Some(("policy:bypass".to_owned(),"BYPASS".to_owned()))) }
                else if mode=="auto" {
                    let project=PathBuf::from(session["projectPath"].as_str().unwrap_or(""));
                    let classified=bloblex_agent_core::classify_permission(&kind,&normalized,&project);let category=classified.category.to_owned();let decision=classified.allowed.then(||("policy:auto".to_owned(),category));(classified.summary,decision)
                } else {(base_summary,None)};
                if inserted.is_ok() && session["state"]=="working" && st.active_turns.lock().await.contains_key(&sid) {
                    if let Some((resolved_by,category))=decision {
                        let choice=choices.iter().find(|c|["allow","allow_once","accept","yes"].contains(&c.as_str())).cloned();
                        if let Some(choice)=choice {
                        if let Some((_,reserved_provider_id))=st.db.begin_permission_reply(&id,&choice).ok().flatten() {
                        let active = { st.sessions.lock().await.get(&sid).cloned() };
                        if let Some(active)=active {
                            drop(event_guard);
                            let reply_result = active.adapter.reply_permission(&reserved_provider_id,&choice).await;
                            let _event_guard = gate.lock().await;
                            if !session_gate_is_current(&st, &sid, &gate).await || session_is_deleted(&st, &sid).await
                                || !st.db.session_exists(&sid).unwrap_or(false) || !st.sessions.lock().await.contains_key(&sid)
                            { break; }
                            if reply_result.is_ok() {
                                let _=st.db.finish_permission_policy_reply(&id,true,&resolved_by,&choice);
                                st.emit("permission.auto_resolved",json!({"permissionId":id,"sessionId":sid,"turnId":turn_id,"agentId":session["agentId"],"mode":mode,"decision":choice,"category":category,"summary":summary.chars().take(160).collect::<String>()})).await;
                                st.emit("permission.resolved",json!({"permissionId":id,"choice":choice})).await;
                                continue;
                            } else { let _=st.db.finish_permission_policy_reply(&id,false,&resolved_by,&choice); }
                        } else { let _=st.db.finish_permission_policy_reply(&id,false,&resolved_by,&choice); }
                            }
                    }
                    }
                }
                if inserted.is_ok() && session["state"] == "working" {
                    let _ = st.db.update_session_state(&sid, "waiting_permission");
                    if let Ok(summary) = st.db.session_event_summary(&sid) {
                        st.emit("session.changed", summary).await;
                    }
                }
                ("permission.requested",json!({"id":id,"sessionId":sid,"runtimeId":runtime_id,"category":"other","title":title,"detail":detail,"risk":"unknown","choices":choices,"expiresAt":null,"status":"pending"}))
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
                let usage_status = if [input_tokens, output_tokens, cache_read_tokens, cache_write_tokens].iter().any(Option::is_some) { "partial" } else { "unreported" };
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
                let usage = json!({"id":Uuid::new_v4().to_string(),"runtimeId":runtime_id,"sessionId":sid,"turnId":turn,"provider":provider,"model":model,"timestamp":timestamp,"inputTokens":input_tokens,"outputTokens":output_tokens,"cacheReadTokens":cache_read_tokens,"cacheWriteTokens":cache_write_tokens,"source":"fallback","raw":raw,"providerReportedCostMinor":record.reported_cost_minor,"providerReportedCurrency":record.currency,"usageStatus":usage_status,"valuation":valuation});
                let _ = st.db.insert_usage(&usage);
                (
                    "usage.updated",
                    json!({"id":usage["id"],"runtimeId":runtime_id,"sessionId":sid,"turnId":turn,"provider":provider,"model":model,"timestamp":usage["timestamp"],"inputTokens":input_tokens,"outputTokens":output_tokens,"cacheReadTokens":cache_read_tokens,"cacheWriteTokens":cache_write_tokens,"reasoningTokens":null,"providerReportedCostMinor":record.reported_cost_minor,"providerReportedCurrency":record.currency,"source":"fallback","usageStatus":usage_status,"valuation":valuation}),
                )
            }
            AgentEvent::ExecApplied { turn_id, outcomes } => {
                if let Ok((_snapshot,event))=st.db.update_exec_snapshot_evidence(&turn_id,&serde_json::to_value(&outcomes).unwrap_or(Value::Null)) {
                    st.broadcast_persisted(vec![event.clone()]);
                    ("exec.options.changed",event["payload"].clone())
                } else {
                    let session = st.db.session_detail(&sid).unwrap_or(Value::Null);
                    ("exec.options.changed", json!({"sessionId":sid,"turnId":turn_id,"agentId":session["agentId"],"runtimeId":runtime_id,"applied":outcomes}))
                }
            }
            AgentEvent::UsageReport { turn_id, report } => {
                let timestamp = Utc::now().to_rfc3339();
                let model = report.model.clone();
                let provider_update_id = report
                    .provider_update_id
                    .as_deref()
                    .map(|id| format!("{}:{}", turn_id, id));
                let valuation = if report.cost_minor.is_some() {
                    serde_json::to_value(bloblex_usage::Valuation {
                        basis: bloblex_usage::CostBasis::ProviderReportedActual,
                        amount_minor: report.cost_minor,
                        currency: report.cost_currency.clone(),
                        pricing_rule_id: None,
                        status: "reported_actual".into(),
                    })
                    .unwrap_or(Value::Null)
                } else if report.reported_cost_decimal.is_none() {
                    let rules = st
                        .db
                        .pricing_list(Some(&provider))
                        .ok()
                        .and_then(|value| {
                            serde_json::from_value::<Vec<bloblex_usage::PriceRule>>(value["rules"].clone()).ok()
                        })
                        .unwrap_or_default();
                    let rule = bloblex_usage::resolve_rule_at(&provider, model.as_deref(), &timestamp, &rules);
                    let record = bloblex_usage::UsageRecord {
                        input_tokens: report.input_tokens,
                        output_tokens: report.output_tokens,
                        cache_read_tokens: report.cache_read_tokens,
                        cache_write_tokens: report.cache_write_tokens,
                        reasoning_tokens: report.reasoning_tokens,
                        model: model.clone(),
                        reported_cost_minor: None,
                        currency: None,
                        source: "terminal".into(),
                        raw: Value::Null,
                    };
                    serde_json::to_value(bloblex_usage::estimate(&record, rule)).unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                let usage = json!({"id":Uuid::new_v4().to_string(),"runtimeId":runtime_id,"sessionId":sid,"turnId":turn_id,"provider":provider,"model":model,"timestamp":timestamp,"inputTokens":report.input_tokens,"outputTokens":report.output_tokens,"cacheReadTokens":report.cache_read_tokens,"cacheWriteTokens":report.cache_write_tokens,"reasoningTokens":report.reasoning_tokens,"source":"terminal","raw":{},"providerReportedCostMinor":report.cost_minor,"providerReportedCurrency":report.cost_currency,"providerUpdateId":provider_update_id,"usageStatus":report.usage_status,"contextUsed":report.context_used,"contextSize":report.context_size,"reportedCostDecimal":report.reported_cost_decimal,"costIsCumulative":report.cost_is_cumulative,"valuation":valuation});
                let _ = st.db.insert_usage(&usage);
                ("usage.updated", json!({"id":usage["id"],"runtimeId":runtime_id,"sessionId":sid,"turnId":turn_id,"provider":provider,"model":model,"timestamp":timestamp,"inputTokens":report.input_tokens,"outputTokens":report.output_tokens,"cacheReadTokens":report.cache_read_tokens,"cacheWriteTokens":report.cache_write_tokens,"reasoningTokens":report.reasoning_tokens,"providerReportedCostMinor":report.cost_minor,"providerReportedCurrency":report.cost_currency,"source":"stream","usageStatus":report.usage_status,"evidenceNote":report.evidence_note,"contextUsed":report.context_used,"contextSize":report.context_size}))
            }
            AgentEvent::TurnCompleted => {
                if let Some(t) = turn.as_deref() { st.denied_turns.lock().await.remove(t); }
                if let Some(t) = turn.as_deref() {
                    let _ = st.db.update_turn_state(t, "completed");
                    if let Ok(metrics) = st.db.latest_turn_budget_metrics(t) {
                        let _ = st.db.reconcile_budget_turn_metrics(t, &metrics);
                    }
                }
                let _ = st.db.update_session_state(&sid, "completed");
                st.active_turns.lock().await.remove(&sid);
                if let Ok(summary) = st.db.session_event_summary(&sid) {
                    st.emit("session.changed", summary).await;
                }
                (
                    "turn.completed",
                    json!({"sessionId":sid,"turnId":turn,"state":"completed"}),
                )
            }
            AgentEvent::TurnCancelled => {
                if let Some(t) = turn.as_deref() { st.denied_turns.lock().await.remove(t); }
                if let Some(t) = turn.as_deref() {
                    let _ = st.db.update_turn_outcome(t, "cancelled", Some("cancelled"));
                    if let Ok(metrics) = st.db.latest_turn_budget_metrics(t) {
                        let _ = st.db.reconcile_budget_turn_metrics(t, &metrics);
                    }
                }
                let _ = st.db.update_session_state(&sid, "cancelled");
                st.active_turns.lock().await.remove(&sid);
                if let Ok(summary) = st.db.session_event_summary(&sid) {
                    st.emit("session.changed", summary).await;
                }
                (
                    "turn.cancelled",
                    json!({"sessionId":sid,"turnId":turn,"state":"cancelled"}),
                )
            }
            AgentEvent::ContextExhausted => {
                if let Some(t) = turn.as_deref() {
                    let _ = st.db.update_turn_outcome(t, "error", Some("context"));
                }
                let _ = st.db.update_session_state(&sid, "error");
                st.active_turns.lock().await.remove(&sid);
                if let Ok(summary) = st.db.session_event_summary(&sid) {
                    st.emit("session.changed", summary).await;
                }
                (
                    "turn.error",
                    json!({
                        "sessionId": sid,
                        "turnId": turn,
                        "message": "Context window is full. Start a new conversation.",
                        "failureClass": "context",
                        "canRetireSession": true
                    }),
                )
            }
            AgentEvent::Error { message: _ } => {
                let denied = if let Some(t) = turn.as_deref() {
                    let denied = st.denied_turns.lock().await.remove(t);
                    let class = if denied { "permission_denied" } else { "provider_error" };
                    let _ = st.db.update_turn_outcome(t, "error", Some(class));
                    denied
                } else { false };
                let message = if denied {
                    "A required permission was denied."
                } else {
                    "The provider reported a turn error."
                };
                let _ = st.db.update_session_state(&sid, "error");
                st.active_turns.lock().await.remove(&sid);
                if let Ok(summary) = st.db.session_event_summary(&sid) {
                    st.emit("session.changed", summary).await;
                }
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
                let session = st.db.session_event_summary(&sid).unwrap_or(Value::Null);
                ("session.changed", session)
            }
        };
        if ty == "exec.options.changed" && payload.get("snapshotId").is_some() { continue; }
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
    let default_agent_events=db.ensure_default_agents()?;
    let st = AppState {
        token: Arc::new(token.clone()),
        started: Instant::now(),
        db,
        events,
        runtimes: Arc::new(RwLock::new(runtimes)),
        adapters,
        sessions: Arc::new(Mutex::new(HashMap::new())),
        active_turns: Arc::new(Mutex::new(HashMap::new())),
        denied_turns: Arc::new(Mutex::new(HashSet::new())),
        session_gates: Arc::new(Mutex::new(HashMap::new())),
        deleted_sessions: Arc::new(Mutex::new(HashSet::new())),
        stopping: Arc::new(tokio::sync::Notify::new()),
    };
    st.broadcast_persisted(default_agent_events);
    for id in recovered_sessions {
        if let Ok(session) = st.db.session_event_summary(&id) {
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

#[cfg(test)]
mod phase2a_tests {
    use super::*;
    #[derive(Default)] struct PolicyAdapter{replies:std::sync::atomic::AtomicUsize}
    #[async_trait::async_trait] impl AgentAdapter for PolicyAdapter {
        async fn probe(&self,_:&RuntimeSpec)->Result<bloblex_agent_core::ProbeResult,bloblex_agent_core::AdapterError>{Err(bloblex_agent_core::AdapterError::Unsupported("test".into()))}
        async fn new_session(&self,_:&RuntimeSpec,_:NewSessionRequest,_:tokio::sync::mpsc::Sender<AgentEvent>)->Result<SessionHandle,bloblex_agent_core::AdapterError>{Err(bloblex_agent_core::AdapterError::Unsupported("test".into()))}
        async fn resume_session(&self,_:&RuntimeSpec,_:ResumeSessionRequest,_:tokio::sync::mpsc::Sender<AgentEvent>)->Result<SessionHandle,bloblex_agent_core::AdapterError>{Err(bloblex_agent_core::AdapterError::Unsupported("test".into()))}
        async fn prompt(&self,_:&SessionHandle,_:PromptRequest)->Result<(),bloblex_agent_core::AdapterError>{Ok(())}
        async fn cancel(&self,_:&SessionHandle)->Result<(),bloblex_agent_core::AdapterError>{Ok(())}
        async fn reply_permission(&self,_:&str,_:&str)->Result<(),bloblex_agent_core::AdapterError>{self.replies.fetch_add(1,std::sync::atomic::Ordering::SeqCst);Ok(())}
        async fn close_session(&self,_:&SessionHandle)->Result<(),bloblex_agent_core::AdapterError>{Ok(())}
    }
    struct CatalogAdapter(bloblex_agent_core::ModelCatalog);
    #[async_trait::async_trait]
    impl AgentAdapter for CatalogAdapter {
        async fn model_catalog(&self, _: &RuntimeSpec) -> Result<bloblex_agent_core::ModelCatalog, bloblex_agent_core::AdapterError> {
            Ok(self.0.clone())
        }
        async fn probe(&self, _: &RuntimeSpec) -> Result<bloblex_agent_core::ProbeResult, bloblex_agent_core::AdapterError> {
            Err(bloblex_agent_core::AdapterError::Unsupported("test".into()))
        }
        async fn new_session(&self, _: &RuntimeSpec, _: NewSessionRequest, _: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> {
            Err(bloblex_agent_core::AdapterError::Unsupported("test".into()))
        }
        async fn resume_session(&self, _: &RuntimeSpec, _: ResumeSessionRequest, _: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> {
            Err(bloblex_agent_core::AdapterError::Unsupported("test".into()))
        }
        async fn prompt(&self, _: &SessionHandle, _: PromptRequest) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn cancel(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn reply_permission(&self, _: &str, _: &str) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn close_session(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
    }
    struct LifecycleAdapter {
        reject_resume: bool,
        allow_resume: bool,
        resume_calls: std::sync::atomic::AtomicUsize,
        new_calls: std::sync::atomic::AtomicUsize,
        close_calls: std::sync::atomic::AtomicUsize,
    }
    #[derive(Default)]
    struct LateOutputAdapter {
        sender: std::sync::Mutex<Option<tokio::sync::mpsc::Sender<AgentEvent>>>,
        close_calls: std::sync::atomic::AtomicUsize,
    }
    #[async_trait::async_trait]
    impl AgentAdapter for LateOutputAdapter {
        async fn probe(&self, _: &RuntimeSpec) -> Result<bloblex_agent_core::ProbeResult, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
        async fn new_session(&self, _: &RuntimeSpec, request: NewSessionRequest, events: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> {
            *self.sender.lock().unwrap() = Some(events);
            Ok(SessionHandle { session_id: request.session_id, provider_session_id: "fake-late-output".into(), capabilities: bloblex_agent_core::AgentCapabilities::default() })
        }
        async fn resume_session(&self, _: &RuntimeSpec, request: ResumeSessionRequest, events: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> {
            *self.sender.lock().unwrap() = Some(events);
            Ok(SessionHandle { session_id: request.session_id, provider_session_id: request.provider_session_id, capabilities: bloblex_agent_core::AgentCapabilities::default() })
        }
        async fn prompt(&self, _: &SessionHandle, _: PromptRequest) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn cancel(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn reply_permission(&self, _: &str, _: &str) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn close_session(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> {
            self.close_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let sender = self.sender.lock().unwrap().clone();
            if let Some(sender) = sender {
                sender.send(AgentEvent::AssistantMessage { text: "late provider output".into() }).await.map_err(|_| bloblex_agent_core::AdapterError::Other("event receiver closed".into()))?;
            }
            Ok(())
        }
    }
    struct BlockingPreflightAdapter {
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }
    #[async_trait::async_trait]
    impl AgentAdapter for BlockingPreflightAdapter {
        async fn probe(&self, _: &RuntimeSpec) -> Result<bloblex_agent_core::ProbeResult, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
        async fn new_session(&self, _: &RuntimeSpec, _: NewSessionRequest, _: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
        async fn resume_session(&self, _: &RuntimeSpec, _: ResumeSessionRequest, _: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
        async fn prompt(&self, _: &SessionHandle, _: PromptRequest) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn cancel(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn reply_permission(&self, _: &str, _: &str) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn close_session(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn preflight_exec_options(&self, _: &ExecOptions) -> Result<(), bloblex_agent_core::AdapterError> {
            self.started.notify_one();
            self.release.notified().await;
            Ok(())
        }
    }
    #[async_trait::async_trait]
    impl AgentAdapter for LifecycleAdapter {
        async fn probe(&self, _: &RuntimeSpec) -> Result<bloblex_agent_core::ProbeResult, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
        async fn new_session(&self, _: &RuntimeSpec, request: NewSessionRequest, events: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> {
            self.new_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = events.send(AgentEvent::SessionStarted { provider_session_id: "fresh-provider-session".into() }).await;
            Ok(SessionHandle { session_id: request.session_id, provider_session_id: "fresh-provider-session".into(), capabilities: bloblex_agent_core::AgentCapabilities::default() })
        }
        async fn resume_session(&self, _: &RuntimeSpec, request: ResumeSessionRequest, events: tokio::sync::mpsc::Sender<AgentEvent>) -> Result<SessionHandle, bloblex_agent_core::AdapterError> {
            self.resume_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.reject_resume { return Err(bloblex_agent_core::AdapterError::ResumeRejected); }
            if self.allow_resume {
                let _ = events.send(AgentEvent::SessionStarted { provider_session_id: "saved-provider-session".into() }).await;
                return Ok(SessionHandle { session_id: request.session_id, provider_session_id: request.provider_session_id, capabilities: bloblex_agent_core::AgentCapabilities::default() });
            }
            Err(bloblex_agent_core::AdapterError::Protocol("generic adapter error".into()))
        }
        async fn prompt(&self, _: &SessionHandle, _: PromptRequest) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn cancel(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn reply_permission(&self, _: &str, _: &str) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
        async fn close_session(&self, _: &SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { self.close_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst); Ok(()) }
    }
    #[test] fn normalized_permission_requests_map_provider_tool_names_and_fail_closed(){
        let(kind,body)=normalized_permission("claude",&json!({"request":{"tool_name":"Bash","input":{"command":"git status"}}}));assert_eq!(kind,"shell");assert_eq!(body["command"],"git status");
        let(kind,body)=normalized_permission("claude",&json!({"request":{"tool_name":"Read","input":{"file_path":"src/lib.rs"}}}));assert_eq!(kind,"read");assert_eq!(body["file_path"],"src/lib.rs");
        let(kind,body)=normalized_permission("opencode",&json!({"params":{"toolCall":{"title":"Run fixture command","rawInput":"echo safe"}}}));assert_eq!(kind,"shell");assert_eq!(body["rawInput"],"echo safe");
        let(kind,_)=normalized_permission("codex",&json!({"params":{"approval":{"unknown":true}}}));assert_eq!(kind,"unknown");
    }
    #[test]
    fn authoritative_timeout_errors_map_to_the_timeout_failure_class() {
        assert_eq!(adapter_failure_class(&bloblex_agent_core::AdapterError::Timeout, false), "timeout");
    }
    #[test]
    fn cli_version_recognition_is_provider_specific_and_conservative() {
        assert!(recognized_cli_version("claude", "2.1.286"));
        assert!(recognized_cli_version("codex", "codex-cli 0.159.3"));
        assert!(recognized_cli_version("opencode", "1.18.34"));
        assert!(!recognized_cli_version("claude", "unknown"));
        assert!(!recognized_cli_version("codex", "9.0.0"));
    }
    #[test]
    fn stored_launch_arguments_allow_only_native_script_wrappers() {
        let dir = std::env::temp_dir().join(format!("bloblex-launch-args-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("cli.js");
        std::fs::write(&script, "fixture").unwrap();
        let valid = RuntimeSpec {
            runtime_id: "runtime".into(),
            provider: "codex".into(),
            executable: PathBuf::from("node.exe"),
            args: vec![script.to_string_lossy().into_owned()],
            cwd: None,
        };
        assert!(validate_spawn_target(&valid).is_ok());
        let powershell = RuntimeSpec {
            executable: PathBuf::from("cli.ps1"),
            args: vec![],
            ..valid.clone()
        };
        assert!(validate_spawn_target(&powershell).is_err());
        let extra = RuntimeSpec {
            args: vec!["--profile".into(), "work".into()],
            ..valid
        };
        assert!(validate_spawn_target(&extra).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
    fn state()->(AppState,broadcast::Receiver<EventEnvelope>){
        let db=Arc::new(Storage::open_in_memory().unwrap());db.upsert_runtime(&json!({"id":"rt-test","provider":"codex","status":"offline"})).unwrap();let(events,rx)=broadcast::channel(64);
        let st=AppState{token:Arc::new("test-only".into()),started:Instant::now(),db,events,runtimes:Arc::new(RwLock::new(vec![json!({"id":"rt-test","provider":"codex","status":"offline"})])),adapters:Arc::new(Adapters{acp:Arc::new(AcpAdapter::default()),codex:Arc::new(CodexAdapter::default()),claude:Arc::new(ClaudeAdapter::default())}),sessions:Arc::new(Mutex::new(HashMap::new())),active_turns:Arc::new(Mutex::new(HashMap::new())),denied_turns:Arc::new(Mutex::new(HashSet::new())),session_gates:Arc::new(Mutex::new(HashMap::new())),deleted_sessions:Arc::new(Mutex::new(HashSet::new())),stopping:Arc::new(tokio::sync::Notify::new())};(st,rx)
    }
    #[tokio::test]
    async fn session_management_rpcs_validate_persist_emit_and_protect_active_sessions() {
        let (st, mut events) = state();
        st.db.create_session("session-management", "rt-test", "codex", ".", "Original").unwrap();
        st.db.update_session_state("session-management", "idle").unwrap();
        assert_eq!(dispatch(&st, "session.rename", json!({"sessionId":"session-management","title":"  Renamed  "})).await.unwrap()["session"]["title"], "Renamed");
        let renamed = events.recv().await.unwrap();
        assert_eq!(renamed.event_type, "session.changed");
        assert!(renamed.payload.get("messages").is_none());
        assert_eq!(dispatch(&st, "session.rename", json!({"sessionId":"session-management","title":" "})).await.unwrap_err().1.code, "invalid_argument");
        dispatch(&st, "session.archive", json!({"sessionId":"session-management","archived":true})).await.unwrap();
        let archived = events.recv().await.unwrap();
        assert_eq!(archived.event_type, "session.changed");
        assert!(archived.payload.get("messages").is_none());
        assert!(dispatch(&st, "session.list", json!({})).await.unwrap()["sessions"].as_array().unwrap().is_empty());
        assert_eq!(dispatch(&st, "session.list", json!({"includeArchived":true})).await.unwrap()["sessions"][0]["archived"], true);
        dispatch(&st, "session.archive", json!({"sessionId":"session-management","archived":false})).await.unwrap();
        let _ = events.recv().await.unwrap();
        dispatch(&st, "session.delete", json!({"sessionId":"session-management"})).await.unwrap();
        assert_eq!(events.recv().await.unwrap().event_type, "session.deleted");
        st.db.create_session("session-active-delete", "rt-test", "codex", ".", "Active").unwrap();
        assert_eq!(dispatch(&st, "session.delete", json!({"sessionId":"session-active-delete"})).await.unwrap_err().1.code, "conflict");
        assert_eq!(dispatch(&st, "settings.set", json!({"key":"notifications.enabled","value":"true"})).await.unwrap_err().1.code, "invalid_argument");
        dispatch(&st, "settings.set", json!({"key":"notifications.enabled","value":true})).await.unwrap();
        assert_eq!(st.db.settings().unwrap()["notifications.enabled"], true);
    }
    #[tokio::test]
    async fn deleting_session_closes_fake_adapter_and_drops_late_provider_output() {
        let (st, mut events) = state();
        let session_id = "delete-late-output";
        st.db.create_session(session_id, "rt-test", "codex", ".", "Delete test").unwrap();
        st.db.update_session_state(session_id, "idle").unwrap();
        let (sender, receiver) = tokio::sync::mpsc::channel(8);
        let adapter = Arc::new(LateOutputAdapter::default());
        *adapter.sender.lock().unwrap() = Some(sender);
        let runtime = RuntimeSpec { runtime_id: "rt-test".into(), provider: "codex".into(), executable: PathBuf::from("fake"), args: vec![], cwd: None };
        let handle = SessionHandle { session_id: session_id.into(), provider_session_id: "fake-late-output".into(), capabilities: bloblex_agent_core::AgentCapabilities::default() };
        st.sessions.lock().await.insert(session_id.into(), ActiveSession { handle, runtime, adapter: adapter.clone(), launch_approval_mode: ApprovalMode::Ask });
        let forwarder = tokio::spawn(forward_events(st.clone(), session_id.into(), "codex".into(), "rt-test".into(), receiver));

        dispatch(&st, "session.delete", json!({"sessionId":session_id})).await.unwrap();
        let deleted = events.recv().await.unwrap();
        assert_eq!(deleted.event_type, "session.deleted");
        forwarder.await.unwrap();

        assert_eq!(adapter.close_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(!st.sessions.lock().await.contains_key(session_id));
        assert_eq!(st.db.session_exists(session_id).unwrap(), false);
        assert!(st.db.session_detail(session_id).is_err());
        let replay = st.db.replay_events(0, 100).unwrap();
        assert!(replay.iter().any(|event| event["type"] == "session.deleted"));
        assert!(!replay.iter().any(|event| event["type"] == "session.changed" && event["payload"]["id"] == session_id));
        assert!(!serde_json::to_string(&replay).unwrap().contains("late provider output"));
        assert!(events.try_recv().is_err());
    }
    #[tokio::test]
    async fn live_turn_finish_and_permission_events_persist_unreadable_state_changes() {
        let (st, mut events) = state();

        st.db.create_session("finish-transition", "rt-test", "codex", ".", "Finish").unwrap();
        st.db.update_session_state("finish-transition", "working").unwrap();
        st.db.create_turn("finish-turn", "finish-transition").unwrap();
        st.active_turns.lock().await.insert("finish-transition".into(), "finish-turn".into());
        st.sessions.lock().await.insert("finish-transition".into(), ActiveSession {
            handle: SessionHandle { session_id: "finish-transition".into(), provider_session_id: "native-finish".into(), capabilities: bloblex_agent_core::AgentCapabilities::default() },
            runtime: RuntimeSpec { runtime_id: "rt-test".into(), provider: "codex".into(), executable: PathBuf::from("fake"), args: vec![], cwd: None },
            adapter: Arc::new(LifecycleAdapter { reject_resume: false, allow_resume: false, resume_calls: Default::default(), new_calls: Default::default(), close_calls: Default::default() }),
            launch_approval_mode: ApprovalMode::Ask,
        });
        let last_seen = st.db.session_event_summary("finish-transition").unwrap()["updatedAt"].as_str().unwrap().to_owned();
        let (finish_tx, finish_rx) = tokio::sync::mpsc::channel(4);
        let finish_forwarder = tokio::spawn(forward_events(st.clone(), "finish-transition".into(), "codex".into(), "rt-test".into(), finish_rx));
        finish_tx.send(AgentEvent::TurnCompleted).await.unwrap();
        let finished = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv()).await.unwrap().unwrap();
        assert_eq!(finished.event_type, "session.changed");
        assert_eq!(finished.payload["state"], "completed");
        assert!(finished.payload["updatedAt"].as_str().unwrap() > last_seen.as_str());
        assert!(finished.payload.get("messages").is_none());
        assert_eq!(events.recv().await.unwrap().event_type, "turn.completed");
        drop(finish_tx);
        finish_forwarder.await.unwrap();

        st.db.create_session("approval-transition", "rt-test", "codex", ".", "Approval").unwrap();
        st.db.update_session_state("approval-transition", "working").unwrap();
        st.db.create_turn("approval-turn", "approval-transition").unwrap();
        st.active_turns.lock().await.insert("approval-transition".into(), "approval-turn".into());
        st.sessions.lock().await.insert("approval-transition".into(), ActiveSession {
            handle: SessionHandle { session_id: "approval-transition".into(), provider_session_id: "native-approval".into(), capabilities: bloblex_agent_core::AgentCapabilities::default() },
            runtime: RuntimeSpec { runtime_id: "rt-test".into(), provider: "codex".into(), executable: PathBuf::from("fake"), args: vec![], cwd: None },
            adapter: Arc::new(LifecycleAdapter { reject_resume: false, allow_resume: false, resume_calls: Default::default(), new_calls: Default::default(), close_calls: Default::default() }),
            launch_approval_mode: ApprovalMode::Ask,
        });
        let last_seen = st.db.session_event_summary("approval-transition").unwrap()["updatedAt"].as_str().unwrap().to_owned();
        let (approval_tx, approval_rx) = tokio::sync::mpsc::channel(4);
        let approval_forwarder = tokio::spawn(forward_events(st.clone(), "approval-transition".into(), "codex".into(), "rt-test".into(), approval_rx));
        approval_tx.send(AgentEvent::PermissionRequested {
            provider_request_id: "approval-request".into(),
            title: "Read a file".into(),
            detail: None,
            choices: vec!["allow".into(), "deny".into()],
            raw: json!({}),
        }).await.unwrap();
        let approval = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv()).await.unwrap().unwrap();
        assert_eq!(approval.event_type, "session.changed");
        assert_eq!(approval.payload["state"], "waiting_permission");
        assert!(approval.payload["updatedAt"].as_str().unwrap() > last_seen.as_str());
        assert_eq!(events.recv().await.unwrap().event_type, "permission.requested");
        drop(approval_tx);
        approval_forwarder.await.unwrap();
    }
    #[tokio::test]
    async fn slow_adapter_preflight_does_not_block_another_sessions_event_stream() {
        let (st, mut events) = state();
        st.db.create_session("slow-session", "rt-test", "codex", ".", "Slow").unwrap();
        st.db.update_session_state("slow-session", "idle").unwrap();
        st.db.create_session("fast-session", "rt-test", "codex", ".", "Fast").unwrap();
        st.db.create_turn("fast-turn", "fast-session").unwrap();
        st.db.update_session_state("fast-session", "working").unwrap();
        st.active_turns.lock().await.insert("fast-session".into(), "fast-turn".into());

        let slow_adapter = Arc::new(BlockingPreflightAdapter { started: tokio::sync::Notify::new(), release: tokio::sync::Notify::new() });
        let runtime = RuntimeSpec { runtime_id: "rt-test".into(), provider: "codex".into(), executable: PathBuf::from("fake"), args: vec![], cwd: None };
        st.sessions.lock().await.insert("slow-session".into(), ActiveSession {
            handle: SessionHandle { session_id: "slow-session".into(), provider_session_id: "slow-native".into(), capabilities: bloblex_agent_core::AgentCapabilities::default() },
            runtime: runtime.clone(), adapter: slow_adapter.clone(), launch_approval_mode: ApprovalMode::Ask,
        });
        st.sessions.lock().await.insert("fast-session".into(), ActiveSession {
            handle: SessionHandle { session_id: "fast-session".into(), provider_session_id: "fast-native".into(), capabilities: bloblex_agent_core::AgentCapabilities::default() },
            runtime, adapter: Arc::new(LifecycleAdapter { reject_resume: false, allow_resume: false, resume_calls: Default::default(), new_calls: Default::default(), close_calls: Default::default() }), launch_approval_mode: ApprovalMode::Ask,
        });

        let (fast_tx, fast_rx) = tokio::sync::mpsc::channel(8);
        let forwarder = tokio::spawn(forward_events(st.clone(), "fast-session".into(), "codex".into(), "rt-test".into(), fast_rx));
        let prompt_state = st.clone();
        let prompt = tokio::spawn(async move { session_prompt(&prompt_state, json!({"sessionId":"slow-session","text":"hello"})).await });
        tokio::time::timeout(std::time::Duration::from_secs(5), slow_adapter.started.notified()).await.unwrap();
        fast_tx.send(AgentEvent::TurnCompleted).await.unwrap();
        let fast_event = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.event_type == "session.changed" && event.payload["id"] == "fast-session" { break event; }
            }
        }).await.unwrap();
        assert_eq!(fast_event.payload["state"], "completed");

        slow_adapter.release.notify_one();
        assert_eq!(prompt.await.unwrap().unwrap()["accepted"], true);
        drop(fast_tx);
        forwarder.await.unwrap();
    }
    #[tokio::test]
    async fn daemon_resume_rejection_clears_pointer_starts_fresh_and_records_outcome(){
        let(st,mut events)=state();
        st.db.create_session("resume-test","rt-test","codex",".","Resume test").unwrap();
        st.db.set_session_provider_id("resume-test","saved-provider-session",true).unwrap();
        let adapter=Arc::new(LifecycleAdapter{reject_resume:true,allow_resume:false,resume_calls:Default::default(),new_calls:Default::default(),close_calls:Default::default()});
        let runtime=RuntimeSpec{runtime_id:"rt-test".into(),provider:"codex".into(),executable:PathBuf::from("fake"),args:vec![],cwd:None};
        let(handle,_rx,fallback)=resume_or_start_fresh(&st,adapter.clone(),&runtime,"resume-test","saved-provider-session".into(),PathBuf::from("."),ExecOptions::default()).await.unwrap();
        assert!(fallback);
        assert_eq!(handle.provider_session_id,"fresh-provider-session");
        assert_eq!(adapter.resume_calls.load(std::sync::atomic::Ordering::SeqCst),1);
        assert_eq!(adapter.new_calls.load(std::sync::atomic::Ordering::SeqCst),1);
        assert_eq!(st.db.session_detail("resume-test").unwrap()["providerSessionId"],Value::Null);
        let event=events.recv().await.unwrap();
        assert_eq!(event.event_type,"session.resume_rejected");
        assert!(event.payload["outcomeNote"].as_str().unwrap().contains("new provider session was started"));
    }
    #[tokio::test]
    async fn daemon_generic_resume_error_preserves_saved_provider_pointer(){
        let(st,_events)=state();
        st.db.create_session("resume-generic","rt-test","codex",".","Resume test").unwrap();
        st.db.set_session_provider_id("resume-generic","saved-provider-session",true).unwrap();
        let adapter=Arc::new(LifecycleAdapter{reject_resume:false,allow_resume:false,resume_calls:Default::default(),new_calls:Default::default(),close_calls:Default::default()});
        let runtime=RuntimeSpec{runtime_id:"rt-test".into(),provider:"codex".into(),executable:PathBuf::from("fake"),args:vec![],cwd:None};
        let error=resume_or_start_fresh(&st,adapter.clone(),&runtime,"resume-generic","saved-provider-session".into(),PathBuf::from("."),ExecOptions::default()).await.unwrap_err();
        assert!(matches!(error,bloblex_agent_core::AdapterError::Protocol(_)));
        assert_eq!(adapter.new_calls.load(std::sync::atomic::Ordering::SeqCst),0);
        assert_eq!(st.db.session_detail("resume-generic").unwrap()["providerSessionId"],"saved-provider-session");
    }
    #[tokio::test]
    async fn watchdogs_expire_both_progress_windows_close_sessions_and_release_turns(){
        for semantic_progress in [false,true]{
            let(st,mut events)=state();
            let sid=if semantic_progress{"semantic-timeout"}else{"startup-timeout"};
            let turn=if semantic_progress{"semantic-turn"}else{"startup-turn"};
            st.db.create_session(sid,"rt-test","codex",".","Watchdog").unwrap();
            st.db.create_turn(turn,sid).unwrap();
            st.db.update_session_state(sid,"working").unwrap();
            st.active_turns.lock().await.insert(sid.into(),turn.into());
            let adapter=Arc::new(LifecycleAdapter{reject_resume:false,allow_resume:true,resume_calls:Default::default(),new_calls:Default::default(),close_calls:Default::default()});
            let handle=SessionHandle{session_id:sid.into(),provider_session_id:"native".into(),capabilities:bloblex_agent_core::AgentCapabilities::default()};
            let runtime=RuntimeSpec{runtime_id:"rt-test".into(),provider:"codex".into(),executable:PathBuf::from("fake"),args:vec![],cwd:None};
            st.sessions.lock().await.insert(sid.into(),ActiveSession{handle,runtime,adapter:adapter.clone(),launch_approval_mode:ApprovalMode::Ask});
            let(tx,rx)=tokio::sync::mpsc::channel(8);
            let task=tokio::spawn(forward_events_with_timeouts(st.clone(),sid.into(),"codex".into(),"rt-test".into(),rx,std::time::Duration::from_millis(25),std::time::Duration::from_millis(25)));
            if semantic_progress { tx.send(AgentEvent::AssistantDelta{text:"progress".into()}).await.unwrap(); }
            let mut saw_error=false;
            while !saw_error {
                let event=tokio::time::timeout(std::time::Duration::from_secs(1),events.recv()).await.unwrap().unwrap();
                if event.event_type=="turn.error" { assert_eq!(event.payload["failureClass"],"timeout"); saw_error=true; }
            }
            drop(tx);
            task.await.unwrap();
            assert_eq!(st.db.turn_failure_class(turn).unwrap().as_deref(),Some("timeout"));
            assert_eq!(st.active_turns.lock().await.contains_key(sid),false);
            assert_eq!(adapter.close_calls.load(std::sync::atomic::Ordering::SeqCst),1);
            assert_eq!(adapter.resume_calls.load(std::sync::atomic::Ordering::SeqCst),1);
            assert_eq!(st.db.session_detail(sid).unwrap()["state"],"idle");
            assert!(st.sessions.lock().await.contains_key(sid));
        }
    }
    #[tokio::test]
    async fn agent_rpc_crud_reorder_archive_errors_and_persisted_event_sequence(){
        let(st,mut events)=state();
        let created=dispatch(&st,"agent.create",json!({"name":"Alpha","runtimeId":"rt-test","instructions":"keep private","customEnv":{"TERM":"xterm-256color"}})).await.unwrap()["agent"].clone();let id=created["id"].as_str().unwrap().to_owned();
        let ev=events.recv().await.unwrap();assert_eq!(ev.event_type,"agent.changed");assert_eq!(ev.payload["action"],"created");assert!(ev.payload.get("instructions").is_none());assert!(ev.payload.get("customEnv").is_none());assert!(ev.payload.get("customArgs").is_none());
        assert_eq!(dispatch(&st,"agent.get",json!({"agentId":id})).await.unwrap()["agent"]["name"],"Alpha");assert_eq!(dispatch(&st,"agent.list",json!({})).await.unwrap()["agents"].as_array().unwrap().len(),1);
        let second=dispatch(&st,"agent.create",json!({"name":"Beta","runtimeId":"rt-test"})).await.unwrap()["agent"]["id"].as_str().unwrap().to_owned();let _=events.recv().await.unwrap();
        let updated=dispatch(&st,"agent.update",json!({"agentId":id,"name":"Alpha Prime"})).await.unwrap();assert_eq!(updated["agent"]["name"],"Alpha Prime");let update_event=events.recv().await.unwrap();assert!(update_event.sequence>ev.sequence);
        let reorder=dispatch(&st,"agent.reorder",json!({"runtimeId":"rt-test","agentIds":[second,id]})).await.unwrap();assert_eq!(reorder["agents"][0]["id"],second);let _=events.recv().await.unwrap();let _=events.recv().await.unwrap();
        assert_eq!(dispatch(&st,"agent.reorder",json!({"runtimeId":"rt-test","agentIds":[id]})).await.unwrap_err().1.code,"invalid_argument");
        let archived=dispatch(&st,"agent.delete",json!({"agentId":second})).await.unwrap();assert_eq!(archived["agent"]["archived"],true);let archive_event=events.recv().await.unwrap();assert_eq!(archive_event.payload["action"],"archived");
        assert_eq!(dispatch(&st,"agent.delete",json!({"agentId":second})).await.unwrap()["agent"]["archived"],true);
        assert_eq!(dispatch(&st,"agent.update",json!({"agentId":second,"name":"x"})).await.unwrap_err().1.code,"conflict");
        assert_eq!(dispatch(&st,"agent.get",json!({"agentId":Uuid::new_v4().to_string()})).await.unwrap_err().1.code,"not_found");
        assert_eq!(dispatch(&st,"agent.create",json!({"name":"Alpha Prime","runtimeId":"rt-test"})).await.unwrap_err().1.code,"conflict");
    }
    #[tokio::test]
    async fn approval_policy_rpc_defaults_and_rejects_global_bypass(){
        let(st,mut events)=state();let created=dispatch(&st,"agent.create",json!({"name":"Guarded","runtimeId":"rt-test"})).await.unwrap()["agent"].clone();let id=created["id"].as_str().unwrap();let _=events.recv().await.unwrap();
        assert_eq!(created["approvalMode"],Value::Null);assert_eq!(created["effectiveApprovalMode"],"ask");
        assert_eq!(dispatch(&st,"settings.set",json!({"key":"permissions.default_mode","value":"bypass"})).await.unwrap_err().1.code,"invalid_argument");
        dispatch(&st,"settings.set",json!({"key":"permissions.default_mode","value":"auto"})).await.unwrap();assert_eq!(events.recv().await.unwrap().payload,json!({"key":"permissions.default_mode","mode":"auto"}));
        let updated=dispatch(&st,"agent.update",json!({"agentId":id,"approvalMode":"bypass"})).await.unwrap()["agent"].clone();assert_eq!(updated["approvalMode"],"bypass");assert_eq!(updated["effectiveApprovalMode"],"bypass");assert_eq!(events.recv().await.unwrap().event_type,"agent.changed");
        let policy=dispatch(&st,"permissions.policy.get",json!({})).await.unwrap();assert_eq!(policy["defaultMode"],"auto");assert_eq!(policy["perAgent"][0]["effectiveMode"],"bypass");
        assert_eq!(dispatch(&st,"agent.create",json!({"name":"Bad","runtimeId":"rt-test","approvalMode":"dangerous"})).await.unwrap_err().1.code,"invalid_argument");
    }
    #[test]
    fn approval_mode_resolution_reloads_for_each_turn_and_keeps_per_agent_override(){
        let(st,_)=state();let(agent,_)=st.db.agent_create(&json!({"name":"Inherited","runtimeId":"rt-test"})).unwrap();let id=agent["id"].as_str().unwrap();
        let row=json!({"agentId":id});assert_eq!(exec_options_for_session(&st,&row).unwrap().approval_mode,ApprovalMode::Ask);
        st.db.set_setting("permissions.default_mode",&json!("auto")).unwrap();assert_eq!(exec_options_for_session(&st,&row).unwrap().approval_mode,ApprovalMode::Auto);
        st.db.agent_update(id,&json!({"approvalMode":"bypass"})).unwrap();assert_eq!(exec_options_for_session(&st,&row).unwrap().approval_mode,ApprovalMode::Bypass);
        st.db.set_setting("permissions.default_mode",&json!("ask")).unwrap();assert_eq!(exec_options_for_session(&st,&row).unwrap().approval_mode,ApprovalMode::Bypass);
    }
    #[tokio::test]
    async fn an_explicit_permission_denial_classifies_a_later_terminal_turn_error() {
        let (st, mut events) = state();
        st.db.create_session("s-denied", "rt-test", "codex", ".", "Denied").unwrap();
        st.db.create_turn("t-denied", "s-denied").unwrap();
        st.active_turns.lock().await.insert("s-denied".into(), "t-denied".into());
        st.db.insert_permission("p-denied", "s-denied", "provider-denied", "Protected action", None, &["deny".into()], &json!({})).unwrap();
        let adapter = Arc::new(PolicyAdapter::default());
        let handle = SessionHandle { session_id: "s-denied".into(), provider_session_id: "native".into(), capabilities: bloblex_agent_core::AgentCapabilities::default() };
        let runtime = RuntimeSpec { runtime_id: "rt-test".into(), provider: "codex".into(), executable: PathBuf::from("fake"), args: vec![], cwd: None };
        st.sessions.lock().await.insert("s-denied".into(), ActiveSession { handle, runtime, adapter, launch_approval_mode: ApprovalMode::Ask });
        dispatch(&st, "permission.reply", json!({"permissionId":"p-denied","choice":"deny"})).await.unwrap();
        assert_eq!(events.recv().await.unwrap().event_type, "session.changed");
        assert!(st.denied_turns.lock().await.contains("t-denied"));
        let (tx, rx) = tokio::sync::mpsc::channel(2);
        let task = tokio::spawn(forward_events(st.clone(), "s-denied".into(), "codex".into(), "rt-test".into(), rx));
        tx.send(AgentEvent::Error { message: "private provider detail".into() }).await.unwrap();
        drop(tx);
        task.await.unwrap();
        assert_eq!(events.recv().await.unwrap().event_type, "permission.resolved");
        let mut event = events.recv().await.unwrap();
        if event.event_type == "session.changed" { event = events.recv().await.unwrap(); }
        assert_eq!(event.event_type, "turn.error");
        assert_eq!(event.payload["message"], "A required permission was denied.");
        assert_eq!(st.db.turn_failure_class("t-denied").unwrap().as_deref(), Some("permission_denied"));
    }
    #[tokio::test]
    async fn automatic_permission_path_acknowledges_audits_and_fails_closed(){
        let(st,mut observed)=state();let root=std::env::temp_dir().join(format!("bloblex-policy-daemon-{}",Uuid::new_v4()));std::fs::create_dir_all(&root).unwrap();std::fs::write(root.join("README.md"),"safe").unwrap();let root=root.canonicalize().unwrap();
        let(agent,_)=st.db.agent_create(&json!({"name":"Policy","runtimeId":"rt-test","approvalMode":"auto"})).unwrap();let agent_id=agent["id"].as_str().unwrap().to_owned();let sid="policy-session";st.db.create_session_for_agent(sid,"rt-test","claude",&root.to_string_lossy(),"Policy",Some(&agent_id)).unwrap();st.db.create_turn("policy-turn",sid).unwrap();st.db.update_session_state(sid,"working").unwrap();st.active_turns.lock().await.insert(sid.into(),"policy-turn".into());
        let adapter=Arc::new(PolicyAdapter::default());let handle=SessionHandle{session_id:sid.into(),provider_session_id:"native".into(),capabilities:bloblex_agent_core::AgentCapabilities::default()};let runtime=RuntimeSpec{runtime_id:"rt-test".into(),provider:"claude".into(),executable:PathBuf::from("fake"),args:vec![],cwd:Some(root.clone())};st.sessions.lock().await.insert(sid.into(),ActiveSession{handle,runtime,adapter:adapter.clone(),launch_approval_mode:ApprovalMode::Ask});
        let(tx,rx)=tokio::sync::mpsc::channel(8);let task=tokio::spawn(forward_events(st.clone(),sid.into(),"claude".into(),"rt-test".into(),rx));tx.send(AgentEvent::PermissionRequested{provider_request_id:"req-read".into(),title:"Read file".into(),detail:Some("private body excluded".into()),choices:vec!["allow".into(),"deny".into()],raw:json!({"request":{"tool_name":"Read","input":{"file_path":"README.md"}}})}).await.unwrap();let received=tokio::time::timeout(std::time::Duration::from_secs(5),observed.recv()).await;let resolved=received.unwrap_or_else(|_|panic!("auto resolution timed out; replies={}, state={}",adapter.replies.load(std::sync::atomic::Ordering::SeqCst),st.db.session_detail(sid).unwrap()["state"])).unwrap();assert_eq!(resolved.event_type,"permission.auto_resolved");
        st.db.agent_update(&agent_id,&json!({"approvalMode":"bypass"})).unwrap();st.db.update_session_state(sid,"cancelling").unwrap();tx.send(AgentEvent::PermissionRequested{provider_request_id:"req-cancelled".into(),title:"Unknown tool".into(),detail:None,choices:vec!["allow".into(),"deny".into()],raw:json!({"request":{"tool_name":"NetworkFetch","input":{"url":"https://example.invalid"}}})}).await.unwrap();drop(tx);tokio::time::timeout(std::time::Duration::from_secs(5), task).await.unwrap().unwrap();
        assert_eq!(adapter.replies.load(std::sync::atomic::Ordering::SeqCst),1);let mut audited=Some(resolved.payload);let mut surfaced=false;while let Ok(ev)=observed.try_recv(){if ev.event_type=="permission.auto_resolved"{audited=Some(ev.payload)}if ev.event_type=="permission.requested"{surfaced=true;}}let event=audited.expect("automatic decision audit");assert_eq!(event["mode"],"auto");assert_eq!(event["category"],"READ");assert!(event["summary"].as_str().unwrap().contains("README.md"));assert_eq!(st.db.permission_resolved_by(event["permissionId"].as_str().unwrap()).unwrap().as_deref(),Some("policy:auto"));assert!(surfaced,"cancelled session permission remains visible for user approval");let _=std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn session_new_agent_xor_and_archived_conflict_are_validated(){
        let(st,_)=state();let a=dispatch(&st,"agent.create",json!({"name":"Agent","runtimeId":"rt-test"})).await.unwrap()["agent"]["id"].as_str().unwrap().to_owned();let _=dispatch(&st,"agent.delete",json!({"agentId":a})).await.unwrap();
        assert_eq!(dispatch(&st,"session.new",json!({"projectPath":".","runtimeId":"rt-test","agentId":Uuid::new_v4().to_string()})).await.unwrap_err().1.code,"invalid_argument");
        assert_eq!(dispatch(&st,"session.new",json!({"projectPath":"."})).await.unwrap_err().1.code,"invalid_argument");
        assert_eq!(dispatch(&st,"session.new",json!({"projectPath":".","agentId":a})).await.unwrap_err().1.code,"conflict");
        assert_eq!(dispatch(&st,"session.new",json!({"projectPath":".","agentId":Uuid::new_v4().to_string()})).await.unwrap_err().1.code,"not_found");
        let active=dispatch(&st,"agent.create",json!({"name":"Active","runtimeId":"rt-test"})).await.unwrap()["agent"]["id"].as_str().unwrap().to_owned();
        assert_eq!(dispatch(&st,"session.new",json!({"projectPath":"C:/does-not-exist","agentId":active})).await.unwrap_err().1.code,"invalid_argument");
        assert_eq!(dispatch(&st,"session.new",json!({"projectPath":".","runtimeId":"missing"})).await.unwrap_err().1.code,"not_found");
    }
    #[tokio::test]
    async fn execution_snapshot_rpc_shapes_and_stable_errors(){
        let(st,_)=state();
        assert_eq!(dispatch(&st,"exec.snapshot.get",json!({})).await.unwrap_err().1.code,"invalid_argument");
        assert_eq!(dispatch(&st,"exec.snapshot.get",json!({"snapshotId":"missing"})).await.unwrap_err().1.code,"not_found");
        assert_eq!(dispatch(&st,"exec.snapshot.list",json!({})).await.unwrap_err().1.code,"invalid_argument");
        assert_eq!(dispatch(&st,"exec.snapshot.list",json!({"sessionId":"missing"})).await.unwrap_err().1.code,"not_found");
        assert_eq!(dispatch(&st,"exec.snapshot.list",json!({"sessionId":"missing","limit":0})).await.unwrap_err().1.code,"invalid_argument");
        assert_eq!(dispatch(&st,"exec.snapshot.list",json!({"sessionId":"missing","limit":201})).await.unwrap_err().1.code,"invalid_argument");
        assert_eq!(dispatch(&st,"exec.snapshot.latest",json!({})).await.unwrap_err().1.code,"invalid_argument");
        assert_eq!(dispatch(&st,"exec.snapshot.latest",json!({"sessionId":"missing"})).await.unwrap_err().1.code,"not_found");
        st.db.create_session("s","rt-test","codex","C:/repo","RPC").unwrap();
        assert_eq!(dispatch(&st,"exec.snapshot.list",json!({"sessionId":"s","after":"missing"})).await.unwrap_err().1.code,"invalid_argument");
        assert!(dispatch(&st,"exec.snapshot.latest",json!({"sessionId":"s"})).await.unwrap().is_null());
        st.db.create_turn("t1","s").unwrap();st.db.create_exec_snapshot("s","t1","snap1",&json!({"model":"gpt-6","maxConcurrency":2}),&json!({"model":{"applied":true}}),&json!({"model":{"kind":"provider_echo","value":"gpt-6"}}),None,&json!({"adapter":"codex"}),"applied").unwrap();
        let snapshot=dispatch(&st,"exec.snapshot.get",json!({"snapshotId":"snap1"})).await.unwrap();assert_eq!(snapshot["id"],"snap1");assert_eq!(snapshot["requested"]["model"],"gpt-6");
        let latest=dispatch(&st,"exec.snapshot.latest",json!({"sessionId":"s"})).await.unwrap();assert_eq!(latest["id"],"snap1");
        let list=dispatch(&st,"exec.snapshot.list",json!({"sessionId":"s","limit":5})).await.unwrap();assert_eq!(list["snapshots"].as_array().unwrap().len(),1);assert!(list["next"].is_null());
    }
    #[tokio::test]
    async fn runtime_capabilities_reflect_static_support_gates_and_audited_changes(){
        let(st,mut events)=state();
        assert_eq!(dispatch(&st,"runtime.capabilities",json!({})).await.unwrap_err().1.code,"invalid_argument");
        assert_eq!(dispatch(&st,"runtime.capabilities",json!({"runtimeId":"missing"})).await.unwrap_err().1.code,"not_found");
        assert_eq!(dispatch(&st,"runtime.capabilities",json!({"runtimeId":"rt-test","agentId":7})).await.unwrap_err().1.code,"invalid_argument");
        let initial=dispatch(&st,"runtime.capabilities",json!({"runtimeId":"rt-test"})).await.unwrap();assert_eq!(initial["settings"]["model"]["supported"],true);assert_eq!(initial["settings"]["model"]["enabled"],true);assert_eq!(initial["settings"]["customEnv"]["enabled"],true);assert_eq!(initial["settings"]["serviceTier"]["supported"],true);assert_eq!(initial["globalConcurrency"],json!({"limit":4,"active":0}));
        assert_eq!(dispatch(&st,"settings.set",json!({"key":"exec_gate.codex.model","value":"false"})).await.unwrap_err().1.code,"invalid_argument");
        dispatch(&st,"settings.set",json!({"key":"exec_gate.codex.model","value":false})).await.unwrap();let event=events.recv().await.unwrap();assert_eq!(event.event_type,"settings.changed");assert_eq!(event.payload,json!({"key":"exec_gate.codex.model","enabled":false}));
        let after=dispatch(&st,"runtime.capabilities",json!({"runtimeId":"rt-test"})).await.unwrap();assert_eq!(after["settings"]["model"]["supported"],true);assert_eq!(after["settings"]["model"]["enabled"],false);
        dispatch(&st,"settings.set",json!({"key":"exec_gate.codex.model","value":false})).await.unwrap();assert!(events.try_recv().is_err());
        let claude=json!({"id":"rt-claude","provider":"claude"});*st.runtimes.write().await=vec![claude];let caps=dispatch(&st,"runtime.capabilities",json!({"runtimeId":"rt-claude"})).await.unwrap();assert_eq!(caps["settings"]["serviceTier"]["supported"],false);assert_eq!(caps["settings"]["serviceTier"]["enabled"],false);assert_eq!(caps["settings"]["thinking"]["evidence"],"usage_effect");
        *st.runtimes.write().await=vec![json!({"id":"rt-opencode","provider":"opencode"})];st.db.upsert_runtime(&json!({"id":"rt-opencode","provider":"opencode"})).unwrap();let caps=dispatch(&st,"runtime.capabilities",json!({"runtimeId":"rt-opencode"})).await.unwrap();assert_eq!(caps["settings"]["thinking"]["supported"],true);assert_eq!(caps["settings"]["thinking"]["enabled"],false);assert_eq!(caps["settings"]["serviceTier"]["supported"],false);st.db.set_setting("exec_gate.opencode.thinking",&json!(true)).unwrap();let enabled=dispatch(&st,"runtime.capabilities",json!({"runtimeId":"rt-opencode"})).await.unwrap();assert_eq!(enabled["settings"]["thinking"]["supported"],true);assert_eq!(enabled["settings"]["thinking"]["enabled"],true);
        let agent=st.db.agent_create(&json!({"name":"Capped","runtimeId":"rt-opencode","maxConcurrency":8})).unwrap().0;let caps=dispatch(&st,"runtime.capabilities",json!({"runtimeId":"rt-opencode","agentId":agent["id"]})).await.unwrap();assert_eq!(caps["agentConcurrency"]["configuredMaxConcurrency"],8);assert_eq!(caps["agentConcurrency"]["effectiveMaxConcurrency"],4);
    }
    #[test]
    fn requested_options_fail_closed_when_the_setting_gate_is_off(){
        let(st,_)=state();let events=st.db.set_setting("exec_gate.codex.model",&json!(false)).unwrap();st.broadcast_persisted(events);
        let requested=ExecOptions{model:Some("gpt-test".into()),..ExecOptions::default()};let rejection=exec_option_rejection(&st,"codex",&requested).unwrap().unwrap();assert_eq!(rejection.0,"model");assert_eq!(rejection.1,EXEC_UNAVAILABLE);
        assert!(exec_option_rejection(&st,"codex",&ExecOptions::default()).unwrap().is_none());
    }
    #[test]
    fn opencode_thinking_support_and_gate_share_one_source_of_truth(){
        let(st,_)=state();
        let requested=ExecOptions{thinking:Some("high".into()),..ExecOptions::default()};
        assert!(exec_option_rejection(&st,"opencode",&ExecOptions::default()).unwrap().is_none());
        assert_eq!(exec_option_rejection(&st,"opencode",&requested).unwrap().unwrap().1,EXEC_UNAVAILABLE);
        st.db.set_setting("exec_gate.opencode.thinking",&json!(true)).unwrap();
        assert!(exec_option_rejection(&st,"opencode",&requested).unwrap().is_none());
    }
    #[tokio::test]
    async fn runtime_models_dispatch_applies_presentation_overlay_before_returning_rows() {
        let (mut st, _) = state();
        let model = |id: &str, display_name: &str, is_default| bloblex_agent_core::ModelInfo {
            id: id.into(), display_name: display_name.into(), provider_id: None,
            supported_thinking: Vec::new(), default_thinking: None, service_tiers: Vec::new(),
            default_service_tier: None, variants: None, host_dependent: true,
            is_default, group: None, availability: None,
        };
        let catalog = bloblex_agent_core::ModelCatalog {
            models: vec![
                model("gpt-5.5", "gpt-5.5", Some(false)),
                model("gpt-6-sol", "gpt-6-sol", Some(false)),
                model("gpt-6-luna", "gpt-6-luna", Some(true)),
            ],
            fetched_at: "2026-10-03T00:00:00Z".into(),
            expires_at: "2026-10-03T00:01:00Z".into(),
            fallback: false,
            source: "config_options".into(),
            validated: true,
        };
        let runtime_id = "rt-presentation-overlay-test";
        st.adapters = Arc::new(Adapters {
            acp: Arc::new(CatalogAdapter(catalog)),
            codex: Arc::new(CodexAdapter::default()),
            claude: Arc::new(ClaudeAdapter::default()),
        });
        *st.runtimes.write().await = vec![json!({
            "id": runtime_id,
            "provider": "opencode",
            "status": "online",
            "executablePath": "unused-test-runtime",
            "launchArgs": []
        })];

        let response = dispatch(
            &st,
            "runtime.models",
            json!({"runtimeId": runtime_id, "refresh": true}),
        )
        .await
        .unwrap();
        let models = response["models"].as_array().unwrap();
        assert_eq!(models[0]["id"], "gpt-6-luna");
        assert_eq!(models[0]["displayName"], "GPT-6 Luna");
        assert_eq!(models[0]["isDefault"], true);
        assert_eq!(models[0]["group"], "GPT-6");
        assert_eq!(models[0]["availability"], "offered");
        assert_eq!(models[1]["group"], "GPT-6");
        assert_eq!(models[2]["group"], "Other models");
    }

    #[tokio::test]
    async fn saved_thinking_is_not_rejected_without_model_specific_effort_evidence() {
        let (mut st, _) = state();
        let runtime_id = "rt-effort-unreported-test";
        let catalog = bloblex_agent_core::ModelCatalog {
            models: vec![bloblex_agent_core::ModelInfo {
                id: "opencode/example-model".into(),
                display_name: "Example model".into(),
                provider_id: None,
                supported_thinking: Vec::new(),
                default_thinking: None,
                service_tiers: Vec::new(),
                default_service_tier: None,
                variants: None,
                host_dependent: true,
                is_default: None,
                group: None,
                availability: None,
            }],
            fetched_at: "2026-10-03T00:00:00Z".into(),
            expires_at: "2026-10-03T00:01:00Z".into(),
            fallback: false,
            source: "config_options".into(),
            validated: true,
        };
        st.adapters = Arc::new(Adapters {
            acp: Arc::new(CatalogAdapter(catalog)),
            codex: Arc::new(CodexAdapter::default()),
            claude: Arc::new(ClaudeAdapter::default()),
        });
        *st.runtimes.write().await = vec![json!({
            "id": runtime_id,
            "provider": "opencode",
            "status": "online",
            "executablePath": "unused-test-runtime",
            "launchArgs": []
        })];

        validate_agent_catalog(
            &st,
            runtime_id,
            &json!({"model":"opencode/example-model","thinking":"high"}),
        )
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn catalog_validation_rejects_turn_values_but_accepts_custom_ids_without_authority(){
        let authoritative=json!({"fallback":false,"validated":true,"models":[{"id":"claude-sonnet-test","supportedThinking":["low","high"],"serviceTiers":[{"id":"priority"}]}]});
        assert!(validate_option_values_against_catalog(Some("custom-model"),Some("custom-effort"),Some("custom-tier"),None,false).is_ok());
        assert!(validate_option_values_against_catalog(Some("custom-model"),Some("custom-effort"),Some("custom-tier"),Some(&json!({"fallback":true,"models":[]})),false).is_ok());
        assert!(validate_option_values_against_catalog(Some("suggestion-only"),None,None,Some(&json!({"fallback":false,"validated":false,"models":[]})),false).is_ok());
        let model_only_catalog=json!({"fallback":false,"validated":true,"models":[{"id":"opencode-go/deepseek-v4.1-flash","supportedThinking":[]}]});
        assert!(validate_option_values_against_catalog(Some("opencode-go/deepseek-v4.1-flash"),Some("high"),None,Some(&model_only_catalog),false).is_ok());
        assert_eq!(validate_option_values_against_catalog(Some("missing"),None,None,Some(&authoritative),false).unwrap_err().1.code,"invalid_argument");
        assert_eq!(validate_option_values_against_catalog(Some("claude-sonnet-test"),Some("xhigh"),None,Some(&authoritative),false).unwrap_err().1.message,"thinking is not supported by the selected model");
        assert_eq!(validate_option_values_against_catalog(Some("claude-sonnet-test"),None,Some("slow"),Some(&authoritative),false).unwrap_err().1.message,"serviceTier is not supported by the selected model");
        assert_eq!(validate_option_values_against_catalog(Some("claude-sonnet-test"),Some("high"),Some("fast"),Some(&authoritative),false).unwrap_err().1.code,"invalid_argument");
        assert!(validate_option_values_against_catalog(Some("claude-sonnet-test"),None,Some("standard"),Some(&authoritative),true).is_ok());
        assert_eq!(validate_option_values_against_catalog(Some("claude-sonnet-test"),None,Some("standard"),Some(&authoritative),false).unwrap_err().1.code,"invalid_argument");
        let(st,_)=state();let empty=ExecOptions{model:Some(String::new()),..ExecOptions::default()};assert_eq!(validate_exec_catalog(&st,&json!({"id":"rt-test","provider":"codex"}),&empty).await.unwrap_err().1.code,"invalid_argument");
    }
    #[tokio::test]
    async fn agent_list_without_capability_is_rejected_before_dispatch(){
        let(st,_)=state();let request=RpcRequest{v:PROTOCOL_VERSION,id:"auth-test".into(),method:"agent.list".into(),params:json!({})};
        let response=main_rpc(State(st),ConnectInfo("127.0.0.1:12345".parse().unwrap()),HeaderMap::new(),Json(request)).await.into_response();
        assert_eq!(response.status(),StatusCode::UNAUTHORIZED);
    }
}
