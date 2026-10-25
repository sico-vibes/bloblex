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
use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::path::PathBuf;

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

/// The folder the daemon keeps task images in, inside its own data folder.
const IMAGE_DIR: &str = "task-images";
const MAX_TASK_IMAGES: usize = 8;
/// A scheduled occurrence that is more than this many seconds late (the computer was asleep or Bitbots
/// was closed) is skipped, never run late.
const SCHEDULE_GRACE_SECS: i64 = 300;

fn images_dir(st: &AppState) -> Result<PathBuf, DispatchError> {
    let base = st.team.data_dir.lock().ok().and_then(|dir| dir.clone());
    base.map(|dir| dir.join(IMAGE_DIR)).ok_or_else(|| derr("unavailable", "The task image folder is unavailable.", StatusCode::SERVICE_UNAVAILABLE))
}

fn image_extension(media_type: &str) -> &'static str {
    match media_type { "image/png" => "png", "image/jpeg" => "jpg", "image/gif" => "gif", _ => "webp" }
}

/// Turns the `attachments` of a create or update (new staged files as `{path,name}`, kept images as `{id}`)
/// into stored `images`: each new file is checked like a chat attachment (signature, 10 MB) and copied into
/// the daemon's own folder, so a task outlives the staging folder's clean-up. A client can never write the
/// `images` list itself. Returns the files this call created, so a failed save can remove them.
pub(crate) fn adopt_images(st: &AppState, input: &mut Value, existing: Option<&Value>) -> Result<Vec<PathBuf>, DispatchError> {
    let invalid = |message: &str| derr("invalid_argument", message, StatusCode::BAD_REQUEST);
    let Some(object) = input.as_object_mut() else { return Ok(Vec::new()) };
    object.remove("images");
    let items = match object.remove("attachments") {
        None => return Ok(Vec::new()),
        Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(invalid("attachments must be a list")),
    };
    if items.len() > MAX_TASK_IMAGES { return Err(invalid("A task can include up to 8 images.")); }
    let mut stored = Vec::new();
    let mut created: Vec<PathBuf> = Vec::new();
    let result = (|| -> Result<(), DispatchError> {
        for item in &items {
            if let Some(id) = item["id"].as_str() {
                let kept = existing.and_then(|task| task["images"].as_array()).and_then(|list| list.iter().find(|image| image["id"].as_str() == Some(id)));
                stored.push(kept.ok_or_else(|| invalid("An attached image is no longer part of this task."))?.clone());
                continue;
            }
            let staged = crate::prompt_attachments(&json!([{"path": item["path"], "name": item["name"]}]))?.remove(0);
            let dir = images_dir(st)?;
            std::fs::create_dir_all(&dir).map_err(|_| derr("internal", "The task image folder could not be created.", StatusCode::INTERNAL_SERVER_ERROR))?;
            let id = uuid::Uuid::new_v4().to_string();
            let file = format!("{id}.{}", image_extension(&staged.media_type));
            let target = dir.join(&file);
            std::fs::copy(&staged.path, &target).map_err(|_| derr("internal", "An image could not be saved with the task.", StatusCode::INTERNAL_SERVER_ERROR))?;
            created.push(target.clone());
            let bytes = std::fs::metadata(&target).map(|metadata| metadata.len()).unwrap_or(0);
            stored.push(json!({"id": id, "file": file, "mediaType": staged.media_type, "name": staged.name, "bytes": bytes}));
        }
        Ok(())
    })();
    if let Err(error) = result {
        for path in created { let _ = std::fs::remove_file(path); }
        return Err(error);
    }
    object.insert("images".into(), Value::Array(stored));
    Ok(created)
}

/// Delete image files a task no longer lists, unless another task (a repeat's copies) still does.
fn drop_unused_images(st: &AppState, before: &Value, after: &Value) {
    let Ok(dir) = images_dir(st) else { return };
    let kept: Vec<&str> = after["images"].as_array().map(|list| list.iter().filter_map(|image| image["id"].as_str()).collect()).unwrap_or_default();
    for image in before["images"].as_array().into_iter().flatten() {
        let (Some(id), Some(file)) = (image["id"].as_str(), image["file"].as_str()) else { continue };
        if kept.contains(&id) || st.db.task_image_in_use(file).unwrap_or(true) { continue; }
        let _ = std::fs::remove_file(dir.join(file));
    }
}

/// `task.image`: one stored image of a task as a data URL, for the thumbnail. Nothing else reads these files.
fn image_data(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let task = st.db.task_get(required_str(p, "taskId")?).map_err(storage_error)?;
    let image_id = required_str(p, "imageId")?;
    let image = task["images"].as_array().and_then(|list| list.iter().find(|image| image["id"].as_str() == Some(image_id))).ok_or_else(|| derr("not_found", "That image is not part of this task.", StatusCode::NOT_FOUND))?;
    let path = images_dir(st)?.join(image["file"].as_str().unwrap_or(""));
    let bytes = std::fs::read(&path).map_err(|_| derr("not_found", "The image file is no longer available.", StatusCode::NOT_FOUND))?;
    let media_type = image["mediaType"].as_str().unwrap_or("image/png");
    Ok(json!({"id": image_id, "name": image["name"], "mediaType": media_type, "dataUrl": format!("data:{media_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))}))
}

/// The task's images as the `{path,name}` list a prompt takes (checked again when the prompt is sent).
#[cfg(test)]
pub(crate) fn prompt_images_for_test(st: &AppState, task: &Value) -> Vec<Value> { prompt_images(st, task) }

fn prompt_images(st: &AppState, task: &Value) -> Vec<Value> {
    let Ok(dir) = images_dir(st) else { return Vec::new() };
    task["images"].as_array().into_iter().flatten().filter_map(|image| Some(json!({"path": dir.join(image["file"].as_str()?).to_string_lossy(), "name": image["name"]}))).collect()
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value).ok().map(|parsed| parsed.with_timezone(&Utc))
}

fn format_time(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
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
            let mut input = p.clone();
            let created = adopt_images(st, &mut input, None)?;
            let task = match st.db.task_create(&input) {
                Ok(task) => task,
                Err(error) => { for path in created { let _ = std::fs::remove_file(path); } return Err(storage_error(error)); }
            };
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
            let before = st.db.task_get(id).map_err(storage_error)?;
            let mut input = p.clone();
            let created = adopt_images(st, &mut input, Some(&before))?;
            let task = match st.db.task_update(id, required_version(p)?, &input) {
                Ok(task) => task,
                Err(error) => { for path in created { let _ = std::fs::remove_file(path); } return Err(storage_error(error)); }
            };
            drop_unused_images(st, &before, &task);
            emit_task(st, &task).await;
            Ok(json!({"task": task}))
        }
        "task.dispatch" => dispatch(st, p, false).await,
        "task.image" => image_data(st, p),
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
async fn dispatch(st: &AppState, p: &Value, scheduled: bool) -> Result<Value, DispatchError> {
    let task_id = required_str(p, "taskId")?;
    let agent_id = required_str(p, "assigneeAgentId")?;
    let key = required_str(p, "idempotencyKey")?;
    let expected = required_version(p)?;
    let task = st.db.task_get(task_id).map_err(storage_error)?;
    if !scheduled && task["scheduleState"] == "active" {
        return Err(derr("conflict", "This task is scheduled. Set When to Now to start it yourself.", StatusCode::CONFLICT));
    }
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
    let mut link = json!({"kind":"task","taskId":task_id,"runId":run_id,"rootTaskId":task["rootTaskId"],"parentTaskId":task["parentTaskId"]});
    // A run a schedule started has nobody at the keyboard: it keeps the unattended rails (never bypass).
    if task["unattended"] == true { link["unattended"] = json!(true); link["approvalMode"] = json!("auto"); }
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
    let prompt = json!({"sessionId": session_id, "text": text, "attachments": prompt_images(st, &task), "meta": {"kind":"task","taskId":task_id,"runId":run_id}});
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
    watchdog(st).await;
    schedules(st).await;
    advance_queue(st).await;
}

/// The task's time limit: a run the provider has been working on for longer than its `maxRuntimeSecs` is
/// closed as failed with `timeout` and its turn is cancelled, like an automation run.
async fn watchdog(st: &AppState) {
    watchdog_at(st, Utc::now()).await;
}

pub(crate) async fn watchdog_at(st: &AppState, now: DateTime<Utc>) {
    for (run, cap) in st.db.task_runs_running().unwrap_or_default() {
        let Some(started) = run["startedAt"].as_str().and_then(parse_time) else { continue };
        if (now - started).num_seconds() <= cap { continue }
        let Ok((task, finished)) = st.db.task_run_finish(run["id"].as_str().unwrap_or(""), "failed", Some("timeout"), None) else { continue };
        emit_outcome(st, &task, &finished).await;
        if let Some(session_id) = run["sessionId"].as_str() {
            let _ = Box::pin(crate::dispatch(st, "session.cancel", json!({"sessionId": session_id}))).await;
        }
    }
}

/// Fire the scheduled tasks that are due. A repeat starts a fresh copy under the template for each
/// occurrence; a one-time task starts itself. An occurrence more than five minutes overdue, or due while
/// the board is paused, is skipped and never run late; one due while the previous occurrence is still
/// going is skipped too.
async fn schedules(st: &AppState) {
    let now = Utc::now();
    let due = st.db.task_schedules_due(&format_time(now)).unwrap_or_default();
    if due.is_empty() { return }
    let paused = st.db.settings().unwrap_or(Value::Null)["task.globalPaused"] == true;
    for task in due { fire_schedule(st, &task, now, paused).await; }
}

async fn record_schedule(st: &AppState, id: &str, outcome: &str, next_at: Option<&str>, state: &str) {
    if let Ok(task) = st.db.task_schedule_record(id, outcome, next_at, state) { emit_task(st, &task).await; }
}

pub(crate) async fn fire_schedule(st: &AppState, task: &Value, now: DateTime<Utc>, paused: bool) {
    let id = task["id"].as_str().unwrap_or("");
    let scheduled_for = task["scheduleNextAt"].as_str().unwrap_or("");
    let Ok(schedule) = bloblex_storage::cron::parse_schedule(&task["schedule"], None) else {
        record_schedule(st, id, "invalid_schedule", None, "missed").await;
        return;
    };
    let once = schedule.kind == "once";
    let next = if once { None } else { bloblex_storage::cron::next_run_at(&schedule, now).ok().flatten() };
    let repeat_state = if next.is_some() { "active" } else { "completed" };
    let late = parse_time(scheduled_for).map(|at| (now - at).num_seconds()).unwrap_or(0);
    let skipped = if paused { Some("skipped_paused") } else if late > SCHEDULE_GRACE_SECS { Some("skipped_late") } else { None };
    if let Some(outcome) = skipped {
        record_schedule(st, id, outcome, next.as_deref(), if once { "missed" } else { repeat_state }).await;
        return;
    }
    let agent_id = task["scheduleAgentId"].as_str().unwrap_or("").to_owned();
    let key = format!("schedule:{id}:{scheduled_for}");
    let disposition = |result: &Result<Value, DispatchError>| match result { Ok(done) if done["disposition"] == "queued" => "queued", Ok(_) => "started", Err(_) => "failed_to_start" };
    if once {
        let _ = st.db.task_mark_unattended(id);
        let result = dispatch(st, &json!({"taskId": id, "assigneeAgentId": agent_id, "idempotencyKey": key, "expectedVersion": task["version"]}), true).await;
        record_schedule(st, id, disposition(&result), None, if result.is_ok() { "completed" } else { "missed" }).await;
        return;
    }
    if st.db.task_active_children(id).unwrap_or(0) > 0 {
        record_schedule(st, id, "skipped_overlap", next.as_deref(), repeat_state).await;
        return;
    }
    let Ok(clone) = st.db.task_clone_scheduled(id) else {
        record_schedule(st, id, "failed_to_start", next.as_deref(), repeat_state).await;
        return;
    };
    emit_task(st, &clone).await;
    let result = dispatch(st, &json!({"taskId": clone["id"], "assigneeAgentId": agent_id, "idempotencyKey": key, "expectedVersion": clone["version"]}), true).await;
    record_schedule(st, id, disposition(&result), next.as_deref(), repeat_state).await;
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

/// The images the owner sent in a conversation, in the order sent, as `{path,name}`.
fn conversation_images(st: &AppState, session_id: &str) -> Vec<Value> {
    let Ok(detail) = st.db.session_detail(session_id) else { return Vec::new() };
    detail["messages"].as_array().into_iter().flatten().filter(|message| message["role"] == "user")
        .flat_map(|message| message["attachments"].as_array().cloned().unwrap_or_default())
        .filter(|image| image["path"].as_str().is_some_and(|path| !path.is_empty()))
        .map(|image| json!({"path": image["path"], "name": image["name"]}))
        .collect()
}

/// Which of the conversation's images the Manager asked to attach: a list of 1-based numbers or `all`.
fn pick_images(st: &AppState, session_id: &str, wanted: &Value) -> Result<Vec<Value>, String> {
    let all = conversation_images(st, session_id);
    match wanted {
        Value::Null => Ok(Vec::new()),
        Value::String(word) if word == "all" => Ok(all.into_iter().take(MAX_TASK_IMAGES).collect()),
        Value::Array(numbers) => numbers.iter().map(|number| {
            let index = number.as_u64().filter(|index| *index >= 1).ok_or("images must be image numbers (1 is the first image the user sent) or all.")? as usize;
            all.get(index - 1).cloned().ok_or_else(|| format!("Image {index} is not in this conversation; the user sent {} image(s).", all.len()))
        }).collect(),
        _ => Err("images must be image numbers (1 is the first image the user sent) or all.".into()),
    }
}

/// MCP `create_task`: the Manager may only file an unassigned draft. It cannot
/// assign, dispatch, schedule or widen the scope it was given. It may attach images the owner
/// sent in the same conversation, by their number.
pub async fn manager_create(st: &AppState, origin_session: &str, args: &Value) -> Result<String, String> {
    if !args.is_object() {
        return Err("Task details must be an object.".into());
    }
    let mut input = args.clone();
    let wanted = input["images"].clone();
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
        object.remove("scheduleAgentId");
        object.remove("attachments");
        object.remove("images");
        object.remove("unattended");
    }
    let picked = pick_images(st, origin_session, &wanted)?;
    let mut created = Vec::new();
    if !picked.is_empty() {
        input["attachments"] = Value::Array(picked);
        created = adopt_images(st, &mut input, None).map_err(|error| error.1.message)?;
    }
    let task = match st.db.task_create(&input) {
        Ok(task) => task,
        Err(error) => { for path in created { let _ = std::fs::remove_file(path); } return Err(error.to_string()); }
    };
    emit_task(st, &task).await;
    Ok(format!(
        "Created unassigned task \"{}\" ({}){}. It will not run until the owner drops it on a bot in the task board.",
        task["title"].as_str().unwrap_or("Task"),
        task["id"].as_str().unwrap_or("unknown"),
        match task["images"].as_array().map(Vec::len).unwrap_or(0) { 0 => String::new(), count => format!(" with {count} image(s)") }
    ))
}
