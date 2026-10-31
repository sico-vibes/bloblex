//! Scheduled automations (Phase 4A).
//!
//! A blob can own cron or one-shot automations. The scheduler tick selects due,
//! enabled automations and starts a normal blob session whose `link.kind` is
//! `automation`; the single turn-end path maps the turn outcome back onto a run
//! row. Everything that could run unattended is fenced: approval mode is
//! clamped to `plan`/`auto`, unclassified permissions are auto-denied,
//! questions are dismissed, missed occurrences coalesce into one, overlaps are
//! skipped, and four consecutive failures pause the automation visibly. A run
//! that failed after it changed something is never retried automatically: the
//! owner retries it from its run history (wave 13).

use crate::{derr, new_session, session_prompt_for_automation, AppState, DispatchError};
use axum::http::StatusCode;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use uuid::Uuid;

/// A run this many seconds after its scheduled time records `late:<secs>`.
pub const LATE_THRESHOLD_SECS: i64 = 60;
/// How long a due automation may wait for the concurrency limit or a live user
/// turn before it is recorded `skipped` with reason `busy`.
const BUSY_DEFER_SECS: i64 = 15 * 60;
/// Retry delays after the first, second and third failure of a run that only
/// read things (wave 13: 1, 5 and 15 minutes).
const RETRY_DELAYS_SECS: [i64; 3] = [60, 300, 900];
/// Consecutive failures before an automation pauses itself.
const MAX_CONSECUTIVE_FAILURES: i64 = 4;
/// Scheduler cadence.
const TICK_SECS: u64 = 10;

/// In-memory busy tracking: when an automation first became due while the host
/// was busy, so the 15-minute deferral can be measured per automation.
#[derive(Default)]
pub struct Automations {
    busy_since: StdMutex<HashMap<String, DateTime<Utc>>>,
    /// Automations whose run is being started right now. The scheduler and
    /// "Run now" both claim here first, so neither opens a second conversation
    /// while the other is still starting the same automation.
    starting: StdMutex<std::collections::HashSet<String>>,
}

/// Releases a start claim when the start finishes, whichever way it ends.
pub(crate) struct StartClaim<'a> { automations: &'a Automations, id: String }

impl Drop for StartClaim<'_> {
    fn drop(&mut self) {
        if let Ok(mut starting) = self.automations.starting.lock() { starting.remove(&self.id); }
    }
}

impl Automations {
    /// The one start claim for an automation, or `None` while another start of
    /// the same automation is still under way.
    pub(crate) fn claim_start(&self, id: &str) -> Option<StartClaim<'_>> {
        let mut starting = self.starting.lock().unwrap_or_else(|poison| poison.into_inner());
        starting.insert(id.to_owned()).then(|| StartClaim { automations: self, id: id.to_owned() })
    }
    /// Record (or refresh) the first busy moment for an automation.
    fn mark_busy(&self, id: &str, now: DateTime<Utc>) -> DateTime<Utc> {
        let mut busy = self.busy_since.lock().unwrap_or_else(|poison| poison.into_inner());
        *busy.entry(id.to_owned()).or_insert(now)
    }
    fn clear(&self, id: &str) {
        if let Ok(mut busy) = self.busy_since.lock() {
            busy.remove(id);
        }
    }
    pub fn forget(&self, id: &str) {
        self.clear(id);
    }
    #[cfg(test)]
    pub(crate) fn set_busy_since(&self, id: &str, at: DateTime<Utc>) {
        if let Ok(mut busy) = self.busy_since.lock() {
            busy.insert(id.to_owned(), at);
        }
    }
}

/// A run's approval mode. An automation is only ever `plan` or `auto`, so nothing
/// a webhook (or anything else) sends can put a run in `bypass`.
pub(crate) fn run_mode(approval: Option<&str>) -> &'static str {
    match approval {
        Some("plan") => "plan",
        _ => "auto",
    }
}

fn now_utc() -> DateTime<Utc> {
    Utc::now()
}

fn fmt(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value).ok().map(|parsed| parsed.with_timezone(&Utc))
}

/// Map storage validation and lookups onto the wire error codes.
fn automation_error(error: bloblex_storage::StorageError) -> DispatchError {
    use bloblex_storage::StorageError::*;
    match error {
        InvalidAgent => derr("invalid_argument", "The automation request is invalid.", StatusCode::BAD_REQUEST),
        AgentNotFound => derr("not_found", "Automation not found.", StatusCode::NOT_FOUND),
        AgentConflict => derr("conflict", "The automation request conflicts with the current state.", StatusCode::CONFLICT),
        other => derr("internal", &other.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
    }
}

pub(crate) async fn emit_changed(st: &AppState, automation: &Value) {
    let automation = crate::webhooks::with_block(st, automation.clone());
    st.emit("automation.changed", json!({"automation": automation})).await;
}

async fn emit_run_changed(st: &AppState, run: &Value) {
    st.emit("automation.run.changed", json!({"run": run})).await;
}

async fn emit_run_finished(st: &AppState, automation: &Value, run: &Value) {
    st.emit(
        "automation.run.finished",
        json!({
            "runId": run["id"],
            "automationId": automation["id"],
            "agentId": automation["agentId"],
            "sessionId": run["sessionId"],
            "status": run["status"],
            "reason": run["reason"],
        }),
    )
    .await;
}

/// Recompute and store the next occurrence after now (missed runs coalesce).
async fn advance_next(st: &AppState, automation: &Value) -> Result<Option<String>, DispatchError> {
    let id = automation["id"].as_str().unwrap_or("");
    let schedule = bloblex_storage::cron::parse_schedule(&automation["schedule"], None).map_err(automation_error)?;
    let next = bloblex_storage::cron::next_run_at(&schedule, now_utc()).map_err(automation_error)?;
    st.db.automation_set_next(id, next.as_deref()).map_err(automation_error)?;
    Ok(next)
}

async fn record_skipped(st: &AppState, automation: &Value, reason: &str, scheduled_for: &str) {
    let id = automation["id"].as_str().unwrap_or("");
    let run_id = Uuid::new_v4().to_string();
    let run = match st.db.automation_run_insert(&run_id, id, None, "skipped", Some(reason), Some(scheduled_for), &fmt(now_utc())) {
        Ok(run) => run,
        Err(_) => return,
    };
    emit_run_changed(st, &run).await;
    emit_run_finished(st, automation, &run).await;
}

/// Whether the blob this automation belongs to already has a live, non-automation
/// turn. Automation run sessions do not count against themselves.
async fn agent_has_live_user_turn(st: &AppState, agent_id: &str) -> bool {
    let active = st.active_turns.lock().await.keys().cloned().collect::<Vec<_>>();
    for session_id in active {
        if let Ok(row) = st.db.session_detail(&session_id) {
            if row["agentId"].as_str() == Some(agent_id) && row["link"]["kind"] != "automation" {
                return true;
            }
        }
    }
    false
}

/// Start a run. `advance` is false for `automation.run_now`, which must not move
/// `next_run_at`. Returns the new run DTO.
async fn start_run(st: &AppState, automation: &Value, scheduled_for: &str, advance: bool) -> Result<Value, DispatchError> {
    start_run_with(st, automation, scheduled_for, advance, None).await
}

/// The same run with a webhook request body appended to the prompt. The body is
/// someone else's input, so it reaches the prompt only as inert quoted data
/// (Phase 5, section 8; THREAT_MODEL §18).
async fn start_run_with(st: &AppState, automation: &Value, scheduled_for: &str, advance: bool, body: Option<&str>) -> Result<Value, DispatchError> {
    let automation_id = automation["id"].as_str().unwrap_or("").to_owned();
    let Some(_claim) = st.automations.claim_start(&automation_id) else {
        return Err(derr("conflict", "This automation is already starting.", StatusCode::CONFLICT));
    };
    let agent_id = automation["agentId"].as_str().unwrap_or("").to_owned();
    let name = automation["name"].as_str().unwrap_or("Automation").to_owned();
    let mut prompt = automation["prompt"].as_str().unwrap_or("").to_owned();
    if let Some(body) = body {
        prompt = crate::webhooks::prompt_with_body(&prompt, body);
    }
    let mode = run_mode(automation["approvalMode"].as_str());
    let session_mode = automation["sessionMode"].as_str().unwrap_or("new");
    let agent = st.db.agent_get(&agent_id).map_err(automation_error)?;
    if agent["archived"] == true {
        st.db.automation_pause(&automation_id).map_err(automation_error)?;
        return Err(derr("conflict", &format!("The {} is archived, so its automations are paused.", crate::team::entity_noun(false)), StatusCode::CONFLICT));
    }
    if advance {
        advance_next(st, automation).await?;
    }
    let run_id = Uuid::new_v4().to_string();
    let link = json!({"kind":"automation","automationId":automation_id,"runId":run_id,"approvalMode":mode});
    let mut reuse = None;
    if session_mode == "reuse" {
        if let Some(existing) = automation["reuseSessionId"].as_str().filter(|id| !id.is_empty()) {
            let usable = st.db.session_detail(existing).map(|row| row["archived"] != true).unwrap_or(false);
            if usable {
                reuse = Some(existing.to_owned());
            }
        }
    }
    let session_id = match reuse {
        Some(existing) => {
            st.db.set_session_link(&existing, &link).map_err(automation_error)?;
            existing
        }
        None => {
            let workspace = crate::team::workspace_for(st, &agent);
            match new_session(
                st,
                json!({"agentId":agent_id,"projectPath":workspace.to_string_lossy(),"title":format!("Automation: {name}"),"link":link}),
            )
            .await
            {
                Ok(created) => {
                    let id = created["id"].as_str().unwrap_or("").to_owned();
                    if session_mode == "reuse" {
                        let _ = st.db.automation_set_reuse_session(&automation_id, &id);
                    }
                    id
                }
                Err(error) => {
                    // The occurrence cannot even open a session: record it and
                    // account a failure (retry, then pause) instead of silently
                    // advancing past it.
                    if let Ok(run) = st.db.automation_run_insert(&run_id, &automation_id, None, "failed", Some("session_error"), Some(scheduled_for), &fmt(now_utc())) {
                        emit_run_changed(st, &run).await;
                        account_failure(st, automation, &run, false).await;
                    }
                    return Err(error);
                }
            }
        }
    };
    let late = parse(scheduled_for).map(|scheduled| (now_utc() - scheduled).num_seconds()).unwrap_or(0);
    let reason = (late > LATE_THRESHOLD_SECS).then(|| format!("late:{late}"));
    let run = st.db
        .automation_run_insert(&run_id, &automation_id, Some(&session_id), "running", reason.as_deref(), Some(scheduled_for), &fmt(now_utc()))
        .map_err(automation_error)?;
    emit_run_changed(st, &run).await;
    let meta = json!({"kind":"automation","automationId":automation_id,"runId":run_id});
    if let Err(error) = session_prompt_for_automation(st, json!({"sessionId":session_id,"text":prompt,"meta":meta})).await {
        let status = if error.1.code == "conflict" { "skipped" } else { "failed" };
        let code = if error.1.code == "conflict" { "busy" } else { "prompt_error" };
        if let Ok(Some(finished)) = st.db.automation_run_finish(&run_id, status, Some(code)) {
            emit_run_changed(st, &finished).await;
            emit_run_finished(st, automation, &finished).await;
        }
        return Err(error);
    }
    Ok(run)
}

/// Account a failure against its automation: below the threshold a run that only
/// read things retries after 1, 5 and 15 minutes; on the fourth failure the
/// automation disables and pauses visibly. A run that `acted` (edited files or
/// ran commands) is not retried: it keeps its next scheduled occurrence and the
/// owner decides whether to retry it now.
async fn account_failure(st: &AppState, automation: &Value, run: &Value, acted: bool) {
    let id = automation["id"].as_str().unwrap_or("");
    let failures = automation["consecutiveFailures"].as_i64().unwrap_or(0) + 1;
    let updated = if failures >= MAX_CONSECUTIVE_FAILURES {
        st.db.automation_finish_failure(id, failures, None, true)
    } else if acted {
        let next = bloblex_storage::cron::parse_schedule(&automation["schedule"], None).ok()
            .and_then(|schedule| bloblex_storage::cron::next_run_at(&schedule, now_utc()).ok().flatten());
        st.db.automation_finish_failure(id, failures, next.as_deref(), false)
    } else {
        let delay = RETRY_DELAYS_SECS[(failures as usize - 1).min(RETRY_DELAYS_SECS.len() - 1)];
        let next = fmt(now_utc() + Duration::seconds(delay));
        st.db.automation_finish_failure(id, failures, Some(&next), false)
    };
    if let Ok(updated) = updated {
        emit_changed(st, &updated).await;
    }
    emit_run_finished(st, automation, run).await;
}

/// Turn-end hook for an automation-linked session, called once per turn from
/// `team::after_turn`.
pub async fn after_turn(st: &AppState, session_id: &str, outcome: &str) {
    let Ok(session) = st.db.session_detail(session_id) else { return };
    let link = &session["link"];
    if link["kind"] != "automation" {
        return;
    }
    let Some(run_id) = link["runId"].as_str() else { return };
    let Some(automation_id) = link["automationId"].as_str() else { return };
    let Ok(automation) = st.db.automation_get(automation_id) else { return };
    match outcome {
        "turn.completed" => {
            // A run whose whole reply is `(pass)` found nothing to report.
            let quiet = st.db.latest_turn_reply(session_id).ok().flatten().is_some_and(|reply| reply.trim().eq_ignore_ascii_case("(pass)"));
            if let Ok(Some(run)) = st.db.automation_run_finish(run_id, "completed", quiet.then_some("nothing_to_report")) {
                let schedule = bloblex_storage::cron::parse_schedule(&automation["schedule"], None).ok();
                let disable = schedule.as_ref().is_some_and(|schedule| schedule.kind == "once");
                // A `once` automation that already ran has no next occurrence.
                let next = if disable { None } else {
                    schedule.as_ref().and_then(|schedule| bloblex_storage::cron::next_run_at(schedule, now_utc()).ok().flatten())
                };
                if let Ok(updated) = st.db.automation_finish_success(automation_id, next.as_deref(), disable) {
                    emit_changed(st, &updated).await;
                }
                emit_run_changed(st, &run).await;
                emit_run_finished(st, &automation, &run).await;
            }
        }
        "turn.cancelled" => {
            if let Ok(Some(run)) = st.db.automation_run_finish(run_id, "cancelled", Some("cancelled")) {
                if automation["schedule"]["kind"] == "once" {
                    if let Ok(updated) = st.db.automation_finish_success(automation_id, None, true) {
                        emit_changed(st, &updated).await;
                    }
                }
                emit_run_changed(st, &run).await;
                emit_run_finished(st, &automation, &run).await;
            }
        }
        "turn.error" => {
            let acted = run_acted(st, run_id, session_id);
            if let Ok(Some(run)) = st.db.automation_run_finish(run_id, "failed", Some(if acted { "error_after_changes" } else { "error" })) {
                emit_run_changed(st, &run).await;
                account_failure(st, &automation, &run, acted).await;
            }
        }
        _ => {}
    }
}

/// Enforce `max_runtime_secs`: cancel the run session and record `timeout`.
async fn watchdog(st: &AppState) {
    let runs = st.db.automation_runs_running().unwrap_or_default();
    let now = now_utc();
    for run in runs {
        let Some(started) = run["startedAt"].as_str().and_then(parse) else { continue };
        let cap = run["maxRuntimeSecs"].as_i64().unwrap_or(1800);
        if (now - started).num_seconds() <= cap {
            continue;
        }
        let run_id = run["id"].as_str().unwrap_or("");
        let acted = run["sessionId"].as_str().is_some_and(|session_id| run_acted(st, run_id, session_id));
        let Ok(Some(finished)) = st.db.automation_run_finish(run_id, "timeout", Some(if acted { "timeout_after_changes" } else { "timeout" })) else { continue };
        if let Some(session_id) = run["sessionId"].as_str() {
            let _ = st.db.update_session_state(session_id, "cancelling");
            let active = st.sessions.lock().await.get(session_id).cloned();
            if let Some(active) = active {
                let _ = active.adapter.cancel(&active.handle).await;
            }
        }
        let automation_id = run["automationId"].as_str().unwrap_or("");
        if let Ok(automation) = st.db.automation_get(automation_id) {
            emit_run_changed(st, &finished).await;
            account_failure(st, &automation, &finished, acted).await;
        }
    }
}

/// Whether a run changed anything (edited, moved or deleted a file, or ran a
/// command) since it started. Unknown counts as changed, so a run is only
/// retried automatically when it is known to have only read.
fn run_acted(st: &AppState, run_id: &str, session_id: &str) -> bool {
    let Some(started) = st.db.automation_run_get(run_id).ok().and_then(|run| run["startedAt"].as_str().map(str::to_owned)) else { return true };
    st.db.session_acted_since(session_id, &started).unwrap_or(true)
}

/// One scheduler pass: watchdog, then due automations.
pub async fn sweep(st: &AppState) {
    watchdog(st).await;
    let settings = st.db.settings().unwrap_or(Value::Null);
    if settings["automations.paused"] == true {
        return;
    }
    let max_concurrent = settings["automations.maxConcurrent"].as_u64().unwrap_or(1).clamp(1, 3) as i64;
    let due = st.db.automation_due(&fmt(now_utc())).unwrap_or_default();
    for automation in due {
        let id = automation["id"].as_str().unwrap_or("").to_owned();
        let scheduled_for = automation["nextRunAt"].as_str().unwrap_or("").to_owned();
        if st.db.automation_run_running_for(&id).ok().flatten().is_some() {
            let _ = advance_next(st, &automation).await;
            record_skipped(st, &automation, "still_running", &scheduled_for).await;
            st.automations.clear(&id);
            continue;
        }
        let running = st.db.automation_running_count().unwrap_or(0);
        let global = st.active_turns.lock().await.len() as i64;
        let agent_busy = agent_has_live_user_turn(st, automation["agentId"].as_str().unwrap_or("")).await;
        if running >= max_concurrent || global >= 4 || agent_busy {
            let since = st.automations.mark_busy(&id, now_utc());
            if (now_utc() - since).num_seconds() >= BUSY_DEFER_SECS {
                let _ = advance_next(st, &automation).await;
                record_skipped(st, &automation, "busy", &scheduled_for).await;
                st.automations.clear(&id);
            }
            continue;
        }
        st.automations.clear(&id);
        let scheduled = if scheduled_for.is_empty() { fmt(now_utc()) } else { scheduled_for };
        let _ = start_run(st, &automation, &scheduled, true).await;
    }
}

/// The 10-second scheduler loop, spawned beside the queue due loop.
pub async fn sweep_loop(st: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(TICK_SECS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = interval.tick() => {
                sweep(&st).await;
                // Questions left by `ask_user` expire on the same periodic
                // sweep, so no separate loop is needed.
                crate::questions::sweep(&st).await;
                // FIX36 D2: lapsed Manager proposals expire on the same tick.
                crate::proposals::sweep(&st).await;
                // Queued board tasks move on when a slot frees up outside a
                // task turn (a user chat or an automation ended).
                crate::tasks::sweep(&st).await;
            },
            _ = st.stopping.notified() => break,
        }
    }
}

/// Pause an archived blob's automations and announce each change.
pub async fn pause_for_agent(st: &AppState, agent_id: &str) {
    if let Ok(updated) = st.db.automation_pause_for_agent(agent_id) {
        for automation in updated {
            if let Some(id) = automation["id"].as_str() {
                st.automations.forget(id);
            }
            emit_changed(st, &automation).await;
        }
    }
}

async fn run_now(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = p["id"].as_str().filter(|value| !value.is_empty()).ok_or_else(|| derr("invalid_argument", "id is required", StatusCode::BAD_REQUEST))?;
    let automation = st.db.automation_get(id).map_err(automation_error)?;
    let settings = st.db.settings().unwrap_or(Value::Null);
    if settings["automations.paused"] == true {
        return Err(derr("conflict", "Automations are paused.", StatusCode::CONFLICT));
    }
    if st.db.automation_run_running_for(id).map_err(automation_error)?.is_some() {
        return Err(derr("conflict", "This automation is already running.", StatusCode::CONFLICT));
    }
    let run = start_run(st, &automation, &fmt(now_utc()), false).await?;
    Ok(json!({"run": run}))
}

/// One run started by a signed webhook (Phase 5, section 8). The fences are the
/// scheduler's own: the global pause, the concurrency limit, single flight, and
/// the automation's `plan`/`auto` mode, which `start_run` clamps. `Ok(None)`
/// means nothing ran, which the route answers exactly as it answers a run.
pub async fn webhook_run(st: &AppState, automation: &Value, body: Option<&str>) -> Result<Option<Value>, DispatchError> {
    let id = automation["id"].as_str().unwrap_or("");
    let settings = st.db.settings().unwrap_or(Value::Null);
    if settings["automations.paused"] == true || automation["enabled"] != true {
        return Ok(None);
    }
    if st.db.automation_run_running_for(id).map_err(automation_error)?.is_some() {
        return Ok(None);
    }
    let max_concurrent = settings["automations.maxConcurrent"].as_u64().unwrap_or(1).clamp(1, 3) as i64;
    let running = st.db.automation_running_count().unwrap_or(0);
    let global = st.active_turns.lock().await.len() as i64;
    if running >= max_concurrent || global >= 4 {
        return Ok(None);
    }
    let run = start_run_with(st, automation, &fmt(now_utc()), false, body).await?;
    Ok(Some(run))
}

fn preview(p: &Value) -> Result<Value, DispatchError> {
    let schedule = bloblex_storage::cron::parse_schedule(&p["schedule"], None).map_err(automation_error)?;
    let count = match p.get("count") {
        None | Some(Value::Null) => 3,
        Some(value) => value.as_u64().filter(|count| (1..=10).contains(count)).ok_or_else(|| derr("invalid_argument", "count must be between 1 and 10", StatusCode::BAD_REQUEST))? as usize,
    };
    let items = bloblex_storage::cron::preview(&schedule, count, now_utc()).map_err(automation_error)?;
    Ok(json!({
        "utc": items.iter().map(|(utc, _)| json!(utc)).collect::<Vec<_>>(),
        "local": items.iter().map(|(_, local)| json!(local)).collect::<Vec<_>>(),
    }))
}

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "automation.create" => {
            let automation = st.db.automation_create(p).map_err(automation_error)?;
            emit_changed(st, &automation).await;
            Ok(json!({"automation": crate::webhooks::with_block(st, automation)}))
        }
        "automation.list" => {
            let automation_list = st.db.automation_list(p["agentId"].as_str()).map_err(automation_error)?;
            Ok(json!({"automations": automation_list.into_iter().map(|item| crate::webhooks::with_block(st, item)).collect::<Vec<_>>()}))
        }
        "automation.get" => {
            let id = p["id"].as_str().filter(|value| !value.is_empty()).ok_or_else(|| derr("invalid_argument", "id is required", StatusCode::BAD_REQUEST))?;
            Ok(json!({"automation": crate::webhooks::with_block(st, st.db.automation_get(id).map_err(automation_error)?)}))
        }
        "automation.update" => {
            let id = p["id"].as_str().filter(|value| !value.is_empty()).ok_or_else(|| derr("invalid_argument", "id is required", StatusCode::BAD_REQUEST))?;
            let automation = st.db.automation_update(id, p).map_err(automation_error)?;
            emit_changed(st, &automation).await;
            Ok(json!({"automation": crate::webhooks::with_block(st, automation)}))
        }
        "automation.pause" => {
            let id = p["id"].as_str().filter(|value| !value.is_empty()).ok_or_else(|| derr("invalid_argument", "id is required", StatusCode::BAD_REQUEST))?;
            let automation = st.db.automation_pause(id).map_err(automation_error)?;
            st.automations.forget(id);
            emit_changed(st, &automation).await;
            Ok(json!({"automation": crate::webhooks::with_block(st, automation)}))
        }
        "automation.resume" => {
            let id = p["id"].as_str().filter(|value| !value.is_empty()).ok_or_else(|| derr("invalid_argument", "id is required", StatusCode::BAD_REQUEST))?;
            let automation = st.db.automation_resume(id).map_err(automation_error)?;
            emit_changed(st, &automation).await;
            Ok(json!({"automation": crate::webhooks::with_block(st, automation)}))
        }
        "automation.delete" => {
            let id = p["id"].as_str().filter(|value| !value.is_empty()).ok_or_else(|| derr("invalid_argument", "id is required", StatusCode::BAD_REQUEST))?;
            st.db.automation_delete(id).map_err(automation_error)?;
            // Phase 5, section 8: the webhook secret goes with the automation, so
            // an id that is recreated later never inherits a live secret.
            let _ = crate::secrets::store::delete(&crate::webhooks::secret_name(id));
            st.automations.forget(id);
            st.emit("automation.deleted", json!({"id": id})).await;
            Ok(json!({"deleted": true}))
        }
        "automation.run_now" => run_now(st, p).await,
        "automation.runs" => {
            let id = p["id"].as_str().filter(|value| !value.is_empty()).ok_or_else(|| derr("invalid_argument", "id is required", StatusCode::BAD_REQUEST))?;
            let limit = match p.get("limit") {
                None | Some(Value::Null) => 20,
                Some(value) => value.as_u64().filter(|limit| (1..=100).contains(limit)).ok_or_else(|| derr("invalid_argument", "limit must be between 1 and 100", StatusCode::BAD_REQUEST))? as usize,
            };
            let before = match p.get("before") {
                None | Some(Value::Null) => None,
                Some(value) => Some(value.as_str().filter(|value| !value.is_empty()).ok_or_else(|| derr("invalid_argument", "before must be a run id", StatusCode::BAD_REQUEST))?),
            };
            let runs = st.db.automation_runs_list(id, limit, before).map_err(automation_error)?;
            Ok(json!({"runs": runs}))
        }
        "automation.preview" => preview(p),
        _ => Err(derr("not_found", "unknown automation method", StatusCode::NOT_FOUND)),
    }
}

/// MCP `schedule_task`: an agent may only ever *propose* a schedule. The
/// automation is created disabled with `pause_reason='needs_approval'`, plan
/// mode and `created_by='agent'`; it can never enable or run itself.
pub async fn schedule_task_tool(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    let session = st.db.session_detail(session_id).map_err(|_| "This conversation is no longer available.".to_string())?;
    let agent_id = session["agentId"].as_str().ok_or_else(|| format!("Only {} conversations can schedule tasks.", crate::team::entity_noun(false)))?.to_owned();
    let name = args["name"].as_str().map(str::trim).filter(|name| !name.is_empty()).ok_or("name is required.")?;
    let prompt = args["prompt"].as_str().map(str::trim).filter(|prompt| !prompt.is_empty()).ok_or("prompt is required.")?;
    let when = &args["when"];
    if !when.is_object() {
        return Err("when must be a schedule object: {\"kind\":\"once\",\"at\":\"...\"} or {\"kind\":\"cron\",\"cron\":\"...\",\"timezone\":\"...\"}.".to_string());
    }
    let input = json!({
        "agentId": agent_id,
        "name": name,
        "prompt": prompt,
        "schedule": when,
        "sessionMode": "new",
        "approvalMode": "plan",
        "enabled": false,
        "createdBy": "agent",
        "pauseReason": "needs_approval",
    });
    let automation = st.db.automation_create(&input).map_err(|error| error.to_string())?;
    emit_changed(st, &automation).await;
    Ok(format!(
        "Proposed scheduled task \"{name}\" (automation {}). It is disabled and will not run until the user approves it in Bitbots.",
        automation["id"].as_str().unwrap_or("")
    ))
}

/// MCP `list_my_schedules`: read-only view of the current blob's automations.
pub async fn list_my_schedules_tool(st: &AppState, session_id: &str) -> Result<String, String> {
    let session = st.db.session_detail(session_id).map_err(|_| "This conversation is no longer available.".to_string())?;
    let agent_id = session["agentId"].as_str().ok_or_else(|| format!("Only {} conversations have schedules.", crate::team::entity_noun(false)))?.to_owned();
    let schedules = st.db.automation_list(Some(&agent_id)).map_err(|error| error.to_string())?;
    if schedules.is_empty() {
        return Ok("You have no scheduled tasks. Use schedule_task to propose one; the user must approve it before it can run.".into());
    }
    let lines = schedules.iter().map(|item| {
        let state = if item["enabled"] == true { "enabled".to_owned() } else { format!("disabled ({})", item["pauseReason"].as_str().unwrap_or("paused")) };
        format!(
            "- {} · {} · next run {}",
            item["name"].as_str().unwrap_or("Task"),
            state,
            item["nextRunAt"].as_str().unwrap_or("none")
        )
    }).collect::<Vec<_>>();
    Ok(format!("Your scheduled tasks (none run until the user approves them):\n{}", lines.join("\n")))
}
