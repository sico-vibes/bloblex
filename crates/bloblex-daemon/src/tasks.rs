//! Durable task board (expansion-v2 slice 1A).
//!
//! A task is a board record, not a conversation. Only the desktop owner may
//! assign work: `task.dispatch` atomically commits the claim, the attempt run
//! and the queue position before any provider session exists, then either
//! starts the run or leaves it queued with a reason. A Manager-created task is
//! an unassigned draft and can never schedule or dispatch itself.
//!
//! This slice runs `report_only` work. A provider `turn.completed` is evidence
//! that the turn ended, never that the done goal was met, so it moves the task
//! to `awaiting_review`; only an owner review closes it.

use crate::{derr, new_session, session_prompt_for_task, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};

/// The only supervision policy this slice enforces.
const REPORT_ONLY: &str = "report_only";

fn storage_error(error: bloblex_storage::StorageError) -> DispatchError {
    use bloblex_storage::StorageError::*;
    match error {
        InvalidAgent => derr("invalid_argument", "The task request is invalid.", StatusCode::BAD_REQUEST),
        AgentNotFound => derr("not_found", "Task, bot, project or conversation not found.", StatusCode::NOT_FOUND),
        AgentConflict => derr("conflict", "The task changed, or its current state does not allow this action.", StatusCode::CONFLICT),
        other => derr("internal", &other.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn required_str<'a>(p: &'a Value, key: &str) -> Result<&'a str, DispatchError> {
    p[key].as_str().filter(|value| !value.is_empty()).ok_or_else(|| derr("invalid_argument", &format!("{key} is required"), StatusCode::BAD_REQUEST))
}

fn required_version(p: &Value) -> Result<i64, DispatchError> {
    p["expectedVersion"].as_i64().filter(|version| *version > 0).ok_or_else(|| derr("invalid_argument", "expectedVersion is required", StatusCode::BAD_REQUEST))
}

/// One observed timestamp, in the wire format the ledger stores.
fn stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn optional_id<'a>(p: &'a Value, key: &str) -> Result<Option<&'a str>, DispatchError> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_str().filter(|id| !id.is_empty()).map(Some).ok_or_else(|| derr("invalid_argument", &format!("{key} must be a task id or null"), StatusCode::BAD_REQUEST)),
    }
}

/// The event projection: normalized identifiers and lifecycle only. A task's
/// title, brief, done goal and report-back text never leave the daemon in an
/// activity event.
fn safe_task_event(task: &Value) -> Value {
    json!({
        "id": task["id"], "projectId": task["projectId"], "parentTaskId": task["parentTaskId"], "rootTaskId": task["rootTaskId"],
        "assigneeAgentId": task["assigneeAgentId"], "state": task["state"], "queuePosition": task["queuePosition"], "version": task["version"],
        "updatedAt": task["updatedAt"], "assignedAt": task["assignedAt"], "startedAt": task["startedAt"], "completedAt": task["completedAt"],
    })
}

fn run_event(run: &Value) -> Value {
    json!({
        "id": run["id"], "taskId": run["taskId"], "attempt": run["attempt"], "sessionId": run["sessionId"],
        "state": run["state"], "startedAt": run["startedAt"], "endedAt": run["endedAt"],
        "cancelRequestedAt": run["cancelRequestedAt"], "errorCode": run["errorCode"], "decision": run["decision"],
    })
}

async fn emit_task(st: &AppState, task: &Value) {
    st.emit("task.changed", json!({"task": safe_task_event(task)})).await;
}

async fn emit_run(st: &AppState, run: &Value) {
    st.emit("task.run.changed", json!({"taskId": run["taskId"], "run": run_event(run)})).await;
}

async fn emit_run_finished(st: &AppState, run: &Value) {
    st.emit("task.run.finished", json!({"taskId": run["taskId"], "run": run_event(run)})).await;
}

async fn emit_outcome(st: &AppState, task: &Value, run: &Value) {
    emit_task(st, task).await;
    emit_run(st, run).await;
    if matches!(run["state"].as_str(), Some("awaiting_review" | "done" | "failed" | "cancelled")) {
        emit_run_finished(st, run).await;
    }
}

/// Refuse a policy this slice does not implement, before anything is stored.
fn check_policy(policy: &Value) -> Result<(), DispatchError> {
    match policy.as_str() {
        None | Some(REPORT_ONLY) => Ok(()),
        Some("bounded" | "manager_completes") => Err(derr("unsupported", "Only report-only task supervision is available yet.", StatusCode::BAD_REQUEST)),
        _ => Err(derr("invalid_argument", "supervisionPolicy must be report_only.", StatusCode::BAD_REQUEST)),
    }
}

/// The task prompt handed to the bot: the same three user-authored parts every
/// time, so a run is reproducible from the ledger alone.
fn task_prompt(task: &Value) -> String {
    let title = task["title"].as_str().unwrap_or("Task");
    let mut text = format!("Task: {title}");
    for (heading, key) in [("Brief", "brief"), ("Done goal", "doneGoal"), ("Report back", "reportBack")] {
        let value = task[key].as_str().unwrap_or("").trim();
        if !value.is_empty() {
            text.push_str(&format!("\n\n{heading}:\n{value}"));
        }
    }
    text
}

/// Whether this bot already has a live turn (its own chat, a delegation or an
/// automation), and how many turns the daemon holds in total.
async fn live_turns(st: &AppState, agent_id: &str) -> (bool, usize) {
    let active = st.active_turns.lock().await.keys().cloned().collect::<Vec<_>>();
    let total = active.len();
    for session_id in active {
        if let Ok(row) = st.db.session_detail(&session_id) {
            if row["agentId"].as_str() == Some(agent_id) && matches!(row["state"].as_str(), Some("starting" | "working" | "waiting_permission" | "cancelling")) {
                return (true, total);
            }
        }
    }
    (false, total)
}

fn task_cap(settings: &Value) -> i64 {
    settings["task.concurrency.max"].as_u64().unwrap_or(1).clamp(1, 3) as i64
}

/// Decide whether a drop can start now or has to wait, and why. `None` means
/// the run may start.
async fn queue_reason(st: &AppState, agent_id: &str, settings: &Value) -> Option<&'static str> {
    if settings["task.globalPaused"] == true {
        return Some("global_pause");
    }
    let (bot_busy, live) = live_turns(st, agent_id).await;
    if bot_busy {
        return Some("bot_busy");
    }
    let running = st.db.task_running_count().unwrap_or(0);
    if running >= task_cap(settings) || live as i64 >= crate::global_concurrency_limit(st) {
        return Some("global_limit");
    }
    None
}

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "task.create" => {
            check_policy(&p["supervisionPolicy"])?;
            let task = st.db.task_create(p).map_err(storage_error)?;
            emit_task(st, &task).await;
            Ok(json!({"task": task}))
        }
        "task.list" => {
            let task_list = st.db
                .task_list(p["state"].as_str(), p["projectId"].as_str(), p["assigneeAgentId"].as_str(), p["parentTaskId"].as_str())
                .map_err(storage_error)?;
            Ok(json!({"tasks": task_list}))
        }
        "task.get" => Ok(json!({"task": st.db.task_get(required_str(p, "taskId")?).map_err(storage_error)?})),
        "task.update" => {
            check_policy(&p["supervisionPolicy"])?;
            let id = required_str(p, "taskId")?;
            let task = st.db.task_update(id, required_version(p)?, p).map_err(storage_error)?;
            emit_task(st, &task).await;
            Ok(json!({"task": task}))
        }
        "task.dispatch" => dispatch(st, p).await,
        "task.unassign" => {
            let task = st.db.task_unassign(required_str(p, "taskId")?, required_version(p)?).map_err(storage_error)?;
            emit_task(st, &task).await;
            advance_queue(st).await;
            Ok(json!({"task": task}))
        }
        "task.reorder" => {
            let before = optional_id(p, "beforeTaskId")?;
            let task = st.db.task_reorder(required_str(p, "taskId")?, before, required_version(p)?).map_err(storage_error)?;
            emit_task(st, &task).await;
            Ok(json!({"task": task}))
        }
        "task.cancel" => {
            let task = st.db.task_cancel_pending(required_str(p, "taskId")?, required_version(p)?).map_err(storage_error)?;
            emit_task(st, &task).await;
            advance_queue(st).await;
            Ok(json!({"task": task}))
        }
        "task.stop" => {
            let task = st.db.task_request_stop(required_str(p, "taskId")?, required_version(p)?).map_err(storage_error)?;
            emit_task(st, &task).await;
            // The cancellation is durable even if the turn is already gone.
            if let Ok(Some(run)) = st.db.task_run_latest(task["id"].as_str().unwrap_or("")) {
                emit_run(st, &run).await;
                if let Some(session_id) = run["sessionId"].as_str() {
                    let _ = Box::pin(crate::dispatch(st, "session.cancel", json!({"sessionId": session_id}))).await;
                }
            }
            Ok(json!({"task": task, "stopRequested": true}))
        }
        "task.review" => {
            let id = required_str(p, "taskId")?;
            let run_id = required_str(p, "runId")?;
            let decision = required_str(p, "decision")?;
            let evidence = required_str(p, "evidence")?;
            let (task, run) = st.db.task_review(id, run_id, decision, evidence, "owner", required_version(p)?).map_err(storage_error)?;
            emit_outcome(st, &task, &run).await;
            Ok(json!({"task": task, "run": run}))
        }
        "task.runs" => {
            let task_id = required_str(p, "taskId")?;
            st.db.task_get(task_id).map_err(storage_error)?;
            Ok(json!({"runs": st.db.task_runs_list(task_id).map_err(storage_error)?}))
        }
        _ => Err(derr("not_found", "unknown task method", StatusCode::NOT_FOUND)),
    }
}

/// The owner's drop action. One call assigns, claims and either starts or
/// queues; replaying an idempotency key returns the same run and never starts
/// a second provider session.
async fn dispatch(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let task_id = required_str(p, "taskId")?;
    let agent_id = required_str(p, "assigneeAgentId")?;
    let key = required_str(p, "idempotencyKey")?;
    let expected = required_version(p)?;
    let task = st.db.task_get(task_id).map_err(storage_error)?;
    if task["supervisionPolicy"].as_str() != Some(REPORT_ONLY) {
        return Err(derr("unsupported", "Only report-only task supervision is available yet.", StatusCode::BAD_REQUEST));
    }
    let agent = st.db.agent_get(agent_id).map_err(storage_error)?;
    if agent["archived"] == true {
        return Err(derr("conflict", "That bot is archived, so it cannot take a task.", StatusCode::CONFLICT));
    }
    let settings = st.db.settings().unwrap_or(Value::Null);
    let reason = queue_reason(st, agent_id, &settings).await;
    let queued = reason.is_some();
    let (task, run, replayed) = st.db.task_dispatch_claim(task_id, agent_id, expected, key, queued, reason).map_err(storage_error)?;
    if !replayed {
        emit_task(st, &task).await;
        emit_run(st, &run).await;
    }
    let (task, run) = if queued || replayed { (task, run) } else { start_claimed(st, &task, &run).await? };
    // A replay reports the reason the claim recorded, not a fresh guess.
    let claimed_reason = run["events"].as_array().and_then(|events| events.iter().find(|event| event["type"] == "dispatch_claimed")).and_then(|event| event["details"]["reason"].as_str()).map(str::to_owned);
    Ok(json!({
        "task": task,
        "run": run,
        "disposition": if run["state"] == "queued" { "queued" } else { "started" },
        "queuePosition": task["queuePosition"],
        "reason": if replayed { claimed_reason } else { reason.map(str::to_owned) },
        "replayed": replayed,
    }))
}

/// Create the provider session for a claimed run, bind it (the observed start)
/// and deliver the task prompt. A failure is stored on the run before it is
/// returned, so the board never shows work that was never handed over.
async fn start_claimed(st: &AppState, task: &Value, run: &Value) -> Result<(Value, Value), DispatchError> {
    let task_id = task["id"].as_str().unwrap_or("").to_owned();
    let run_id = run["id"].as_str().unwrap_or("").to_owned();
    let agent_id = task["assigneeAgentId"].as_str().unwrap_or("").to_owned();
    let agent = st.db.agent_get(&agent_id).map_err(storage_error)?;
    if agent["archived"] == true {
        let (task, run) = st.db.task_run_finish(&run_id, "failed", Some("bot_archived"), None).map_err(storage_error)?;
        emit_outcome(st, &task, &run).await;
        return Err(derr("conflict", "That bot is archived, so it cannot take a task.", StatusCode::CONFLICT));
    }
    let workspace = crate::team::workspace_for(st, &agent);
    let link = json!({"kind":"task","taskId":task_id,"runId":run_id,"rootTaskId":task["rootTaskId"],"parentTaskId":task["parentTaskId"]});
    let created = Box::pin(new_session(st, json!({
        "agentId": agent_id,
        "projectPath": workspace.to_string_lossy(),
        "title": format!("Task: {}", task["title"].as_str().unwrap_or("Task")),
        "lazy": true,
        "link": link,
    })))
    .await;
    let session_id = match created {
        Ok(session) => session["id"].as_str().unwrap_or("").to_owned(),
        Err(error) => {
            let (task, run) = st.db.task_run_finish(&run_id, "failed", Some("session_error"), None).map_err(storage_error)?;
            emit_outcome(st, &task, &run).await;
            return Err(error);
        }
    };
    let (task, run) = st.db.task_run_bind_session(&run_id, &session_id).map_err(storage_error)?;
    emit_task(st, &task).await;
    emit_run(st, &run).await;
    let text = task_prompt(&task);
    let prompt = json!({"sessionId": session_id, "text": text, "meta": {"kind":"task","taskId":task_id,"runId":run_id}});
    if let Err(error) = Box::pin(session_prompt_for_task(st, prompt)).await {
        let (task, run) = st.db.task_run_finish(&run_id, "failed", Some(&error.1.code), None).map_err(storage_error)?;
        emit_outcome(st, &task, &run).await;
        return Err(error);
    }
    Ok((task, run))
}

/// Start queued work whose bot and slot are free. The queue claim is atomic, so
/// after-turn, the periodic tick and a restart can all call this safely.
pub async fn advance_queue(st: &AppState) {
    let settings = st.db.settings().unwrap_or(Value::Null);
    if settings["task.globalPaused"] == true {
        return;
    }
    let queued = st.db.task_queued(None).unwrap_or_default();
    for task in queued {
        let task_id = task["id"].as_str().unwrap_or("");
        let agent_id = task["assigneeAgentId"].as_str().unwrap_or("");
        let Some(run) = st.db.task_run_latest(task_id).ok().flatten().filter(|run| run["state"] == "queued") else { continue };
        let (bot_busy, live) = live_turns(st, agent_id).await;
        let running = st.db.task_running_count().unwrap_or(0);
        if bot_busy || running >= task_cap(&settings) || live as i64 >= crate::global_concurrency_limit(st) {
            continue;
        }
        let Some((task, run)) = st.db.task_run_claim_queued(run["id"].as_str().unwrap_or("")).ok().flatten() else { continue };
        match start_claimed(st, &task, &run).await {
            Ok((task, run)) => emit_outcome(st, &task, &run).await,
            // A failed start already stored and announced its own outcome.
            Err(_) => continue,
        }
    }
}

/// Called once from the shared scheduler tick so queued work also moves when a
/// turn ended through a path that is not a task turn.
pub async fn sweep(st: &AppState) {
    advance_queue(st).await;
}

/// Startup reconciliation: ambiguous claims become `needs_you` (never a
/// duplicate spawn), then queued work is resumed once.
pub async fn startup(st: &AppState) {
    if let Ok(tasks) = st.db.task_recover_after_restart() {
        for task in tasks {
            emit_task(st, &task).await;
        }
    }
    advance_queue(st).await;
}

/// Turn-end hook, called once per turn from `team::after_turn`.
pub async fn after_turn(st: &AppState, session_id: &str, outcome: &str) {
    let Ok(session) = st.db.session_detail(session_id) else { return };
    if session["link"]["kind"] != "task" {
        return;
    }
    let Some(run_id) = session["link"]["runId"].as_str() else { return };
    // A run already closed by a stop or a restart must not be rewritten.
    let Ok(Some(run)) = st.db.task_run_for_session(session_id) else { return };
    if run["id"].as_str() != Some(run_id) {
        return;
    }
    let (state, code) = match outcome {
        "turn.completed" => ("awaiting_review", None),
        "turn.cancelled" => ("cancelled", Some("cancelled")),
        _ => ("failed", Some("provider_error")),
    };
    let decision = (state == "awaiting_review").then(|| {
        let at = stamp();
        json!({
            "status": "awaiting_review",
            "summary": "The provider turn ended; the done goal still needs the owner's review.",
            "evidence": [{"source":"turn","id":run_id,"at":at,"summary":"The provider reported the turn ended."}],
            "at": at, "reviewer": "pending", "round": 0,
        })
    });
    if let Ok((task, run)) = st.db.task_run_finish(run_id, state, code, decision.as_ref()) {
        emit_outcome(st, &task, &run).await;
    }
    // This turn freed a slot: move the next queued task on.
    advance_queue(st).await;
}

/// An approval or question is waiting on a task run: the board says `needs_you`
/// rather than looking busy forever.
pub async fn permission_pending(st: &AppState, session_id: &str) {
    let Ok(session) = st.db.session_detail(session_id) else { return };
    if session["link"]["kind"] != "task" {
        return;
    }
    let Ok(Some(run)) = st.db.task_run_for_session(session_id) else { return };
    if run["state"] != "running" {
        return;
    }
    if let Ok((task, run)) = st.db.task_run_finish(run["id"].as_str().unwrap_or(""), "needs_you", Some("permission_pending"), None) {
        emit_task(st, &task).await;
        emit_run(st, &run).await;
    }
}

/// The approval was answered: the run continues until its turn ends.
pub async fn permission_resolved(st: &AppState, session_id: &str) {
    let Ok(session) = st.db.session_detail(session_id) else { return };
    if session["link"]["kind"] != "task" {
        return;
    }
    let Ok(Some(run)) = st.db.task_run_for_session(session_id) else { return };
    if run["state"] != "needs_you" {
        return;
    }
    if let Ok(Some((task, run))) = st.db.task_run_resume(run["id"].as_str().unwrap_or("")) {
        emit_task(st, &task).await;
        emit_run(st, &run).await;
    }
}

/// MCP `create_task`: the Manager may only file an unassigned draft. It cannot
/// assign, dispatch, schedule or widen the scope it was given.
pub async fn manager_create(st: &AppState, origin_session: &str, args: &Value) -> Result<String, String> {
    if !args.is_object() {
        return Err("Task details must be an object.".into());
    }
    let mut input = args.clone();
    if input["supervisionPolicy"].as_str().is_some_and(|policy| policy != REPORT_ONLY) {
        return Err("Only report-only task supervision is available yet.".into());
    }
    input["originSessionId"] = json!(origin_session);
    // Draft fields only: anything about assignees or scheduling is ignored.
    if let Some(object) = input.as_object_mut() {
        object.remove("assigneeAgentId");
        object.remove("agentId");
        object.remove("queuePosition");
        object.remove("schedule");
        object.remove("scheduleId");
    }
    let task = st.db.task_create(&input).map_err(|error| error.to_string())?;
    emit_task(st, &task).await;
    Ok(format!(
        "Created unassigned task \"{}\" ({}). It will not run until the owner drops it on a bot in the task board.",
        task["title"].as_str().unwrap_or("Task"),
        task["id"].as_str().unwrap_or("unknown")
    ))
}
