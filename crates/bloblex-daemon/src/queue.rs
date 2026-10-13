//! Durable prompt queue and "send later".
//!
//! A session can hold a bounded list of stored prompts. While a turn is live
//! the UI may enqueue instead of steering; the daemon drains the queue once per
//! finished turn, when the user resumes, when an item is due, or when the user
//! asks to send one now. Failures and cancelled/errored turns pause the queue so
//! nothing fires unexpectedly. Scheduled items carry a `due_at` and are exempt
//! from pause.

use crate::{derr, session_prompt, AppState, DispatchError};
use bloblex_storage::StorageError;
use axum::http::StatusCode;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex as StdMutex},
};
use tokio::sync::Mutex;

/// Most prompts a single session may hold at once.
const QUEUE_MAX: i64 = 20;
/// Scheduled items must be at least this far out.
const DUE_MIN_SECS: i64 = 5;
/// Scheduled items must be at most this far out.
const DUE_MAX_SECS: i64 = 366 * 24 * 60 * 60;
/// A send this many seconds late appends a transcript notice.
const LATE_NOTICE_SECS: i64 = 60;

/// In-memory per-session queue control: pause flags and one drain lock each.
pub struct Queue {
    paused: StdMutex<HashSet<String>>,
    locks: StdMutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Default for Queue {
    fn default() -> Self {
        Self { paused: StdMutex::new(HashSet::new()), locks: StdMutex::new(HashMap::new()) }
    }
}

impl Queue {
    fn lock_for(&self, session_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(|poison| poison.into_inner());
        locks.entry(session_id.to_owned()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    }
    pub fn is_paused(&self, session_id: &str) -> bool {
        self.paused.lock().map(|set| set.contains(session_id)).unwrap_or(false)
    }
    fn mark_paused(&self, session_id: &str) {
        if let Ok(mut set) = self.paused.lock() { set.insert(session_id.to_owned()); }
    }
    fn clear_paused(&self, session_id: &str) {
        if let Ok(mut set) = self.paused.lock() { set.remove(session_id); }
    }
    /// Every session with a queued plain prompt starts paused after a restart.
    pub fn mark_startup_paused(&self, sessions: Vec<String>) {
        if let Ok(mut set) = self.paused.lock() { for session in sessions { set.insert(session); } }
    }
    pub fn forget(&self, session_id: &str) {
        if let Ok(mut set) = self.paused.lock() { set.remove(session_id); }
        if let Ok(mut locks) = self.locks.lock() { locks.remove(session_id); }
    }
}

fn queue_error(error: StorageError) -> DispatchError {
    match error {
        StorageError::AgentNotFound => derr("not_found", "Queue item not found.", StatusCode::NOT_FOUND),
        StorageError::AgentConflict => derr("conflict", "That item can no longer be changed.", StatusCode::CONFLICT),
        StorageError::InvalidAgent => derr("invalid_argument", "The queue request is invalid.", StatusCode::BAD_REQUEST),
        other => derr("internal", &other.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Resolve a writable session for a queue mutation or read.
fn queue_session(st: &AppState, session_id: &str) -> Result<Value, DispatchError> {
    let row = st.db.session_detail(session_id).map_err(|_| derr("not_found", "Conversation not found.", StatusCode::NOT_FOUND))?;
    if row["archived"] == true { return Err(derr("not_found", "Conversation is archived.", StatusCode::NOT_FOUND)); }
    Ok(row)
}

fn now_utc() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Validate a scheduled time and normalize it to fixed-width UTC so string
/// ordering in SQLite matches chronological ordering.
fn validate_due_at(raw: &str) -> Result<String, DispatchError> {
    let invalid = || derr("invalid_argument", "Pick a time between a few seconds and one year from now.", StatusCode::BAD_REQUEST);
    let parsed = chrono::DateTime::parse_from_rfc3339(raw).map_err(|_| invalid())?;
    let due = parsed.with_timezone(&Utc);
    let delta = due.signed_duration_since(Utc::now()).num_seconds();
    if !(DUE_MIN_SECS..=DUE_MAX_SECS).contains(&delta) { return Err(invalid()); }
    Ok(due.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// Keep only the allowlisted prompt keys the daemon stores for later delivery.
fn allowlisted_params(p: &Value, text: &str, attachments: &[bloblex_agent_core::PromptAttachment]) -> Value {
    let attachments = attachments.iter().map(|attachment| json!({"path":attachment.path.to_string_lossy(),"name":attachment.name})).collect::<Vec<_>>();
    let mut params = json!({"text":text,"attachments":attachments});
    if let Some(refs) = p["conversationRefs"].as_array() {
        let refs = refs.iter().filter_map(Value::as_str).take(5).collect::<Vec<_>>();
        if !refs.is_empty() { params["conversationRefs"] = json!(refs); }
    }
    if p["replyTo"].is_object() { params["replyTo"] = p["replyTo"].clone(); }
    params
}

/// Rebuild the `session.prompt` request for a stored item.
fn prompt_params(session_id: &str, item: &Value) -> Value {
    let mut params = json!({"sessionId":session_id,"text":item["text"].clone()});
    if item["attachments"].as_array().is_some_and(|items| !items.is_empty()) { params["attachments"] = item["attachments"].clone(); }
    if item["conversationRefs"].as_array().is_some_and(|items| !items.is_empty()) { params["conversationRefs"] = item["conversationRefs"].clone(); }
    if item["replyTo"].is_object() { params["replyTo"] = item["replyTo"].clone(); }
    // Internal auto-retry items carry the daemon-generated meta the prompt path
    // validates against its allowlist. Plain/scheduled items have none.
    if item["meta"].is_object() { params["meta"] = item["meta"].clone(); }
    params
}

pub(crate) async fn emit_changed(st: &AppState, session_id: &str) {
    let items = st.db.queue_list(session_id).unwrap_or_default();
    let paused = st.queue.is_paused(session_id);
    st.emit("queue.changed", json!({"sessionId":session_id,"items":items,"paused":paused})).await;
}

/// Validate the prompt body and attachments exactly like `session.prompt`.
fn validate_body(session: &Value, p: &Value) -> Result<Vec<bloblex_agent_core::PromptAttachment>, DispatchError> {
    let text = p["text"].as_str().unwrap_or("");
    let attachments = crate::prompt_attachments(&p["attachments"])?;
    if (text.is_empty() && attachments.is_empty()) || text.len() > 1_000_000 {
        return Err(derr("invalid_argument", "text must contain 1 to 1000000 UTF-8 bytes", StatusCode::BAD_REQUEST));
    }
    if !attachments.is_empty() && !matches!(session["provider"].as_str().unwrap_or(""), "claude" | "codex") {
        return Err(derr("unsupported", "This coding agent does not accept image attachments.", StatusCode::BAD_REQUEST));
    }
    Ok(attachments)
}

pub async fn add(st: &AppState, p: Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    let session = queue_session(st, session_id)?;
    if session["link"]["kind"] == "side" {
        return Err(derr("read_only", "Side conversations are read-only. Send a new message in the main conversation.", StatusCode::FORBIDDEN));
    }
    let attachments = validate_body(&session, &p)?;
    let due_at = match p.get("dueAt") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) => Some(validate_due_at(raw)?),
        _ => return Err(derr("invalid_argument", "dueAt must be an RFC3339 timestamp", StatusCode::BAD_REQUEST)),
    };
    if st.db.queue_count_queued(session_id).map_err(queue_error)? >= QUEUE_MAX {
        return Err(derr("conflict", "The queue is full.", StatusCode::CONFLICT));
    }
    let text = p["text"].as_str().unwrap_or("");
    let params = allowlisted_params(&p, text, &attachments);
    let kind = if due_at.is_some() { "send_later" } else { "user" };
    let item = st.db.queue_add(session_id, &params, kind, due_at.as_deref()).map_err(queue_error)?;
    emit_changed(st, session_id).await;
    Ok(json!({"item":item}))
}

pub async fn list(st: &AppState, p: Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    queue_session(st, session_id)?;
    let items = st.db.queue_list(session_id).map_err(queue_error)?;
    Ok(json!({"items":items,"paused":st.queue.is_paused(session_id)}))
}

pub async fn update(st: &AppState, p: Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    let id = p["id"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "id is required", StatusCode::BAD_REQUEST))?;
    let session = queue_session(st, session_id)?;
    let existing = st.db.queue_get(session_id, id).map_err(queue_error)?;
    let text = match p.get("text") {
        None => None,
        Some(Value::String(value)) => Some(value.as_str()),
        _ => return Err(derr("invalid_argument", "text must be a string", StatusCode::BAD_REQUEST)),
    };
    if let Some(text) = text {
        let attachments = existing["attachments"].as_array().map(Vec::len).unwrap_or(0);
        if (text.is_empty() && attachments == 0) || text.len() > 1_000_000 {
            return Err(derr("invalid_argument", "text must contain 1 to 1000000 UTF-8 bytes", StatusCode::BAD_REQUEST));
        }
    }
    // Re-validate any stored attachments against the current provider.
    if existing["attachments"].as_array().is_some_and(|items| !items.is_empty()) && !matches!(session["provider"].as_str().unwrap_or(""), "claude" | "codex") {
        return Err(derr("unsupported", "This coding agent does not accept image attachments.", StatusCode::BAD_REQUEST));
    }
    let due_at = match p.get("dueAt") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(raw)) => Some(Some(validate_due_at(raw)?)),
        _ => return Err(derr("invalid_argument", "dueAt must be an RFC3339 timestamp", StatusCode::BAD_REQUEST)),
    };
    let item = st.db.queue_update(session_id, id, text, due_at.as_ref().map(|value| value.as_deref())).map_err(queue_error)?;
    emit_changed(st, session_id).await;
    Ok(json!({"item":item}))
}

pub async fn reorder(st: &AppState, p: Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    queue_session(st, session_id)?;
    let ids = p["ids"].as_array().filter(|items| items.iter().all(Value::is_string)).map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>()).ok_or_else(|| derr("invalid_argument", "ids must be an array of strings", StatusCode::BAD_REQUEST))?;
    st.db.queue_reorder(session_id, &ids).map_err(queue_error)?;
    emit_changed(st, session_id).await;
    Ok(json!({"items":st.db.queue_list(session_id).map_err(queue_error)?}))
}

pub async fn delete(st: &AppState, p: Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    let id = p["id"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "id is required", StatusCode::BAD_REQUEST))?;
    queue_session(st, session_id)?;
    st.db.queue_delete(session_id, id).map_err(queue_error)?;
    emit_changed(st, session_id).await;
    Ok(json!({"deleted":true}))
}

pub async fn send_now(st: &AppState, p: Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    let id = p["id"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "id is required", StatusCode::BAD_REQUEST))?;
    queue_session(st, session_id)?;
    st.db.queue_get(session_id, id).map_err(queue_error)?;
    if crate::team::session_busy(st, session_id).await {
        st.db.queue_move_to_front(session_id, id).map_err(queue_error)?;
        emit_changed(st, session_id).await;
        return Ok(json!({"queued":true}));
    }
    send_specific(st, session_id, id).await?;
    Ok(json!({"queued":false,"sent":true}))
}

pub async fn resume(st: &AppState, p: Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    queue_session(st, session_id)?;
    st.queue.clear_paused(session_id);
    emit_changed(st, session_id).await;
    if !crate::team::session_busy(st, session_id).await {
        drain_next(st, session_id, true).await;
    }
    Ok(json!({"paused":false}))
}

/// Send one specific queued item immediately (idle session only).
async fn send_specific(st: &AppState, session_id: &str, id: &str) -> Result<(), DispatchError> {
    let lock = st.queue.lock_for(session_id);
    let _guard = lock.lock().await;
    let item = st.db.queue_claim(session_id, id, &now_utc()).map_err(queue_error)?;
    match item {
        Some(item) => { send_claimed(st, session_id, &item).await; Ok(()) }
        None => Err(derr("conflict", "That item is no longer queued.", StatusCode::CONFLICT)),
    }
}

/// Claim and send the next eligible item. `allow_plain` is the caller's wish to
/// send plain prompts; a paused session forces scheduled-only selection.
pub(crate) async fn drain_next(st: &AppState, session_id: &str, allow_plain: bool) {
    let lock = st.queue.lock_for(session_id);
    let _guard = lock.lock().await;
    let allow_plain = allow_plain && !st.queue.is_paused(session_id);
    let item = match st.db.queue_claim_next(session_id, &now_utc(), allow_plain) {
        Ok(Some(item)) => item,
        Ok(None) => return,
        Err(_) => return,
    };
    send_claimed(st, session_id, &item).await;
}

async fn send_claimed(st: &AppState, session_id: &str, item: &Value) {
    let id = item["id"].as_str().unwrap_or("").to_owned();
    let request = prompt_params(session_id, item);
    let result = if item["kind"] == "retry" {
        crate::session_prompt_queued(st, request).await
    } else if item["meta"]["kind"] == "question_answer" {
        crate::session_prompt_for_question_answer(st, request).await
    } else {
        session_prompt(st, request).await
    };
    match result {
        Ok(_) => {
            let _ = st.db.queue_mark_sent(&id);
            if item["kind"] == "send_later" {
                if let Some(late) = item["lateBySecs"].as_i64().filter(|late| *late > LATE_NOTICE_SECS) {
                    let minutes = ((late + 30) / 60).max(1);
                    crate::team::note(st, session_id, &format!("Scheduled message sent {minutes} min late."), json!({"kind":"queue_late","lateBySecs":minutes * 60})).await;
                }
            }
            emit_changed(st, session_id).await;
        }
        Err(error) => {
            // A turn that started between the idle check and this send is a
            // transient conflict: keep the item queued and let it fire after
            // that turn instead of failing it or pausing the queue.
            if error.1.code == "conflict" {
                let _ = st.db.queue_requeue(&id);
            } else {
                let _ = st.db.queue_mark_failed(&id, &error.1.message);
                st.queue.mark_paused(session_id);
            }
            emit_changed(st, session_id).await;
        }
    }
}

/// Queue a message a provider reported stale at the head of the plain queue,
/// so it is retried before anything already waiting. The caller has already
/// validated the session and text.
pub async fn enqueue_steer(st: &AppState, session_id: &str, text: &str) -> Result<Value, DispatchError> {
    queue_session(st, session_id)?;
    if st.db.queue_count_queued(session_id).map_err(queue_error)? >= QUEUE_MAX {
        return Err(derr("conflict", "The queue is full.", StatusCode::CONFLICT));
    }
    let item = st.db.queue_add_front(session_id, &json!({"text":text,"attachments":[]})).map_err(queue_error)?;
    emit_changed(st, session_id).await;
    Ok(item)
}

/// Runs after every finished turn. A completed turn drains the next item; an
/// error or cancellation pauses the queue so nothing fires unexpectedly.
pub async fn after_turn(st: &AppState, session_id: &str, outcome: &str) {
    match outcome {
        "turn.completed" => {
            if !crate::team::session_busy(st, session_id).await {
                drain_next(st, session_id, true).await;
            }
        }
        "turn.error" | "turn.cancelled" => {
            if st.db.queue_has_queued(session_id).unwrap_or(false) {
                st.queue.mark_paused(session_id);
                emit_changed(st, session_id).await;
            }
        }
        _ => {}
    }
}

/// Send one due scheduled item per idle session. Plain prompts are not touched.
pub async fn due_tick(st: &AppState) {
    let sessions = match st.db.queue_due_sessions(&now_utc()) { Ok(sessions) => sessions, Err(_) => return };
    for session_id in sessions {
        if crate::team::session_busy(st, &session_id).await { continue; }
        drain_next(st, &session_id, false).await;
    }
}

pub async fn due_loop(st: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = interval.tick() => due_tick(&st).await,
            _ = st.stopping.notified() => break,
        }
    }
}

pub async fn queue_rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "session.queue.add" => add(st, p.clone()).await,
        "session.queue.list" => list(st, p.clone()).await,
        "session.queue.update" => update(st, p.clone()).await,
        "session.queue.reorder" => reorder(st, p.clone()).await,
        "session.queue.delete" => delete(st, p.clone()).await,
        "session.queue.send_now" => send_now(st, p.clone()).await,
        "session.queue.resume" => resume(st, p.clone()).await,
        _ => Err(derr("not_found", "unknown queue method", StatusCode::NOT_FOUND)),
    }
}
