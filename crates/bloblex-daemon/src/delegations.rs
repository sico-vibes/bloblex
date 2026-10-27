//! Durable delegation ledger (FIX47).
//!
//! A Manager's `message_blob` opens or continues a side conversation with a
//! teammate. The side conversation's own state is not the assignment's state —
//! several assignments can continue one conversation — so each assignment gets
//! its own row here: who sent it, which Manager turn sent it, which side turn
//! carries it, how it ended, where it ran and which conversation it belongs to.
//!
//! The in-memory team queue stays the fast path for delivery; this module is the
//! record behind it, and the thing that lets a queued brief outlive a restart.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};

/// The error a restart leaves on a brief that was working when the daemon stopped.
const INTERRUPTED: &str = "Bitbots restarted while this was working.";
/// The automatic-retry decision is recorded on the same terminal path as the turn
/// hook, but the order differs per call site, so the hook waits for it instead of
/// guessing. Bounded, and only while automatic retry is on.
const RETRY_DECISION_WAIT_MS: u64 = 100;
const RETRY_DECISION_WAIT_STEPS: u32 = 80;

fn storage_error(error: bloblex_storage::StorageError) -> DispatchError {
    use bloblex_storage::StorageError::*;
    match error {
        InvalidAgent => derr("invalid_argument", "The delegation request is invalid.", StatusCode::BAD_REQUEST),
        AgentNotFound => derr("not_found", "Delegation or conversation not found.", StatusCode::NOT_FOUND),
        AgentConflict => derr("conflict", "The delegation changed, or its current state does not allow this action.", StatusCode::CONFLICT),
        other => derr("internal", &other.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Status text is one line and short: a provider message may wrap, and the ledger
/// stores a summary, never a transcript.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The event carries the origin conversation, so the daemon's own
/// `deleted_sessions` filter drops it for a conversation that is gone.
async fn emit(st: &AppState, dto: &Value) {
    st.emit("delegation.updated", json!({"sessionId": dto["originSessionId"], "delegation": dto})).await;
}

/// The reply to the Manager is owed once per outcome: the first caller to find
/// the row's reply slot empty claims it, and a duplicate turn ending stays silent
/// instead of waking the Manager again. `pending` outlives a restart, which is
/// what lets the next boot offer the reply again.
pub(crate) fn claim_reply(st: &AppState, row: &Value) -> bool {
    row["id"].as_str().is_some_and(|id| st.db.delegation_reply_claim(id).unwrap_or(false))
}

/// Records whether the claimed reply went out or still waits for the Manager.
pub(crate) fn settle_reply(st: &AppState, row: &Value, delivered: bool) {
    if let Some(id) = row["id"].as_str() { let _ = st.db.delegation_reply_settle(id, delivered); }
}

/// A queued reply that has just left the queue has reached the Manager, so the
/// row it belongs to stops waiting. Used by the drain, which is the only place a
/// reply offered at startup actually goes out.
pub(crate) fn settle_queued_reply(st: &AppState, meta: &Value) {
    if meta["kind"] != "blob_reply" { return; }
    if let Some(id) = meta["delegationId"].as_str() { let _ = st.db.delegation_reply_settle(id, true); }
}

/// Record one assignment and announce it. `None` means the ledger write failed:
/// the delivery still happens (messaging must never depend on the ledger), but
/// nothing claims a status that was never stored. The flag says whether this call
/// created the row: a replayed brief gets the row already recorded and `false`, so
/// the caller delivers nothing a second time.
pub(crate) async fn record(st: &AppState, input: Value) -> Option<(Value, bool)> {
    let (row, created) = st.db.delegation_create(&input).ok()?;
    if created { emit(st, &row).await; }
    Some((row, created))
}

/// The assignment's turn started (`side_turn_id` is the turn carrying its brief).
///
/// A very fast turn can end before this runs: the turn's own end hook then finds
/// the row still `queued`, leaves it alone, and nothing would ever end it. So the
/// turn is read back after the row is marked running, and a turn that is already
/// over finishes the row at once with the outcome it really had. Bounded (one
/// read) and idempotent: a terminal row is never rewritten.
pub(crate) async fn started(st: &AppState, id: &str, turn_id: &str) {
    let Some(dto) = adopt(st, id, turn_id).await else { return };
    // Another ending already moved it: this turn is not the live one any more.
    if dto["status"] != "running" { return; }
    // A turn whose automatic retry is already decided is not finished here: the
    // retry adopts a new turn, and that turn's own end decides the assignment.
    if st.db.turn_data(turn_id).unwrap_or(Value::Null)["retryDecision"]["decision"] == "retry" { return; }
    let side = dto["sideSessionId"].as_str().unwrap_or("");
    if let Some((status, error)) = turn_outcome(st, side, turn_id) {
        // A turn that ended by asking the owner a question did not finish the
        // work: the assignment waits on the answer, not on this read-back. The
        // hold is the assignment's own question, never the conversation's.
        if status != "completed" || !question_holds_assignment_open(st, &dto) {
            finish(st, id, status, error).await;
        }
    }
}

/// Marks the row running on a turn and announces it. An automatic retry adopts
/// its new turn through here and not through [`started`], because that turn has
/// already ended by the time it is adopted: its end is the outcome below, never
/// a read-back.
///
/// A late adoption never moves the row back onto an older turn: the answer turn's
/// adoption is spawned, so it can land after the next answer's turn was already
/// adopted, and `delegation_mark_running` only guards the row's *status*.
async fn adopt(st: &AppState, id: &str, turn_id: &str) -> Option<Value> {
    if turn_id.is_empty() { return None; }
    let row = st.db.delegation_get(id).ok()?;
    let side = row["sideSessionId"].as_str().unwrap_or("");
    if let Some(current) = row["sideTurnId"].as_str().filter(|turn| !turn.is_empty() && *turn != turn_id) {
        if turn_is_newer(st, side, turn_id, current) == Some(false) { return None; }
    }
    let dto = st.db.delegation_mark_running(id, turn_id).ok()?;
    emit(st, &dto).await;
    Some(dto)
}

/// The assignment could not start, or its turn ended in anything but completion
/// or cancellation.
pub(crate) async fn failed(st: &AppState, id: &str, reason: &str) {
    let reason = one_line(reason);
    finish(st, id, "failed", Some(if reason.is_empty() { "The turn failed.".to_owned() } else { reason })).await;
}

/// Marks a row terminal and announces it. The row that was stored comes back, so
/// a caller can answer with the assignment's own current state; a row that was
/// already terminal is returned unchanged, never rewritten.
async fn finish(st: &AppState, id: &str, status: &str, error: Option<String>) -> Option<Value> {
    let dto = st.db.delegation_mark_terminal(id, status, error.as_deref()).ok()?;
    emit(st, &dto).await;
    // Lane V1: a wake still pending on an assignment that is over can no longer
    // announce anything useful, and a late re-offer must not do it. The durable
    // claim is dropped (a no-op when it already settled), and a wake still waiting
    // in the Manager's in-memory queue is taken out so the drain never delivers it.
    let _ = st.db.delegation_drop_pending_wake(id);
    if let Some(origin) = dto["originSessionId"].as_str() {
        st.team.cancel_queued_wakes(origin, id).await;
    }
    // Nothing can read a question once its assignment is over: the cards it left
    // pending are closed with no prompt, and its Manager is told without content.
    // Cards of another assignment in the same conversation (and their wake
    // claims) are never touched here.
    if matches!(status, "cancelled" | "failed" | "interrupted") {
        if let Some(side) = dto["sideSessionId"].as_str() { close_pending_questions(st, id, side).await; }
    }
    Some(dto)
}

/// Closes the pending question cards that belong to one assignment: each is
/// dismissed with no prompt (nothing is left to read an answer), the card is
/// announced as resolved so it disappears, and the Manager that delegated the
/// work gets one non-waking notice with no content.
///
/// Only this assignment's own cards are closed. A legacy card (one created
/// before questions carried their assignment id) has no owner to compare, so it
/// is only closed when the conversation carries no other open assignment; with
/// another assignment still live it may be that one's card, and it is left
/// alone, exactly like its row and its wake claim.
async fn close_pending_questions(st: &AppState, delegation_id: &str, side_session_id: &str) {
    if side_session_id.is_empty() { return; }
    let other_open = st.db.delegation_list_for_side(side_session_id).unwrap_or_default().iter()
        .any(|row| row["id"].as_str() != Some(delegation_id) && is_open(row));
    let legacy_closeable = !other_open;
    let mut ids = st.db.pending_questions_for_delegation(delegation_id).unwrap_or_default();
    if legacy_closeable {
        for id in st.db.pending_questions_for_session(side_session_id).unwrap_or_default() {
            if question_delegation_id(st, &id).is_none() && !ids.contains(&id) { ids.push(id); }
        }
    }
    for id in &ids {
        // `begin` is the claim: a card the owner is answering right now stays
        // with that answer, which notices the ended assignment itself.
        if st.db.begin_permission_reply(id, "dismiss").ok().flatten().is_none() { continue; }
        if st.db.resolve_question(id, "dismissed").is_err() { continue; }
        st.emit("permission.resolved", json!({"permissionId": id, "choice": "dismissed", "status": "cancelled"})).await;
        question_resolved(st, side_session_id, id, "closed").await;
    }
    // The assignment is over, so none of its questions holds anything open any
    // more: an answer that was still waiting must not keep a released row alive.
    for id in st.db.question_ids_for_delegation(delegation_id).unwrap_or_default() {
        let _ = st.db.question_mark_answer_pending(&id, false);
    }
}

/// A brief the restart cut off is never redelivered and has no reply to re-offer
/// (an interrupted row is deliberately not in [`Storage::delegation_pending_replies`]),
/// so the Manager is told once, without content, that the work stopped.
async fn notice_interrupted(st: &AppState, row: &Value) {
    let (Some(origin), Some(side)) = (row["originSessionId"].as_str(), row["sideSessionId"].as_str()) else { return };
    if origin.is_empty() || origin == side || !st.db.session_exists(origin).unwrap_or(false) { return; }
    let agent = row["targetAgentId"].as_str().unwrap_or("");
    let name = st.db.agent_get(agent).ok().and_then(|agent| agent["name"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "Teammate".to_owned());
    crate::team::note(st, origin, &format!("{name}'s work was interrupted when Bitbots restarted. Ask {name} in its conversation whether anything was left unfinished."), json!({
        "kind": "delegation",
        "direction": "interrupted",
        "peerAgentId": agent,
        "peerName": name,
        "sideSessionId": side,
        "delegationId": row["id"],
    })).await;
}

/// The reply to the Manager for an assignment [`cancel_row`] finished itself (a
/// brief that never went out, or a turn that was already over). The turn's own end
/// hook is not going to run, so nothing else would ever claim this reply; a later
/// duplicate ending finds the claim taken and sends nothing.
async fn relay_stopped(st: &AppState, row: &Value) {
    if !is_terminal(row) { return; }
    let (Some(origin), Some(side), Some(id)) = (row["originSessionId"].as_str(), row["sideSessionId"].as_str(), row["id"].as_str()) else { return };
    if origin.is_empty() || origin == side || !st.db.session_exists(origin).unwrap_or(false) { return; }
    let kind = row["status"].as_str().unwrap_or("");
    if !matches!(kind, "completed" | "cancelled" | "failed") { return; }
    if !claim_reply(st, row) { return; }
    let agent = row["targetAgentId"].as_str().unwrap_or("");
    let name = st.db.agent_get(agent).ok().and_then(|agent| agent["name"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "Teammate".to_owned());
    let source = match kind {
        "completed" => row["sideTurnId"].as_str().filter(|turn| !turn.is_empty())
            .and_then(|turn| st.db.turn_reply(side, turn).ok().flatten()),
        "cancelled" => None,
        _ => row["error"].as_str().map(str::to_owned),
    };
    let text = format!("[Reply from {name}]\n{}", crate::team::reply_text(kind, source.as_deref()));
    let depth = st.team.depth_of(side);
    let delivery = crate::team::deliver_reply(st, origin, side, agent, &name, text, Some(id), depth).await;
    settle_reply(st, row, delivery == crate::team::Delivery::Sent);
}

/// One non-waking notice in the Manager's conversation that a delegated bot's
/// question is over, in any outcome. It is written with [`crate::team::note`], so
/// it never starts a Manager turn, and it carries no question, option or answer
/// text: the owner's answer stays between the owner and the child, whose final
/// reply reaches the Manager through the ordinary relay. A conversation that is
/// not a side one, or whose origin is gone, writes nothing.
pub(crate) async fn question_resolved(st: &AppState, side_session_id: &str, request_id: &str, outcome: &str) {
    if side_session_id.is_empty() || request_id.is_empty() { return; }
    let Ok(session) = st.db.session_detail(side_session_id) else { return };
    if session["link"]["kind"] != "side" { return; }
    let origin = session["link"]["originSessionId"].as_str().unwrap_or("");
    if origin.is_empty() || origin == side_session_id || !st.db.session_exists(origin).unwrap_or(false) { return; }
    let (phrase, outcome) = match outcome {
        "answered" => ("answered", "answered"),
        "dismissed" => ("dismissed", "dismissed"),
        "expired" => ("expired without an answer", "expired"),
        _ => ("closed because the assignment ended", "closed"),
    };
    // The assignment the question belongs to: the id stored on the card itself,
    // and only for a legacy card with none, the old guess (the turn that is live,
    // else the open one, else the newest this conversation carries).
    let row = match question_delegation_id(st, request_id) {
        Some(id) => st.db.delegation_get(&id).ok(),
        None => active_turn(st, side_session_id).await
            .and_then(|turn| st.db.delegation_find_for_side_turn(side_session_id, &turn).ok().flatten())
            .or_else(|| st.db.delegation_latest_open_for_side(side_session_id).ok().flatten())
            .or_else(|| st.db.delegation_list_for_side(side_session_id).ok().and_then(|rows| rows.into_iter().next_back())),
    };
    let delegation = row.as_ref().and_then(|row| row["id"].as_str()).unwrap_or("");
    let agent_id = row.as_ref().and_then(|row| row["targetAgentId"].as_str())
        .or_else(|| session["agentId"].as_str()).unwrap_or("");
    let name = st.db.agent_get(agent_id).ok().and_then(|agent| agent["name"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "Teammate".to_owned());
    // The request is over, so a wake still waiting to announce it is no longer
    // meaningful (Lane V1): it is settled `dropped`, and a copy still in the
    // Manager's queue is taken out. Settling is conditional on this exact request,
    // so a newer request's pending wake is never touched; a wake already sent
    // stays sent (nothing is unsent).
    if !delegation.is_empty() {
        let _ = st.db.delegation_wake_settle(delegation, request_id, "dropped");
        st.team.cancel_queued_wake(origin, delegation, request_id).await;
    }
    crate::team::note(st, origin, &format!("{name}'s question was {phrase}."), json!({
        "kind": "question_resolved",
        "fromAgentId": agent_id,
        "fromName": name,
        "sideSessionId": side_session_id,
        "delegationId": delegation,
        "requestId": request_id,
        "outcome": outcome,
    })).await;
}

/// What a side turn's end means for the reply to the Manager, so a reply is sent
/// once per outcome and never invented from a guess.
pub(crate) enum TurnEnd {
    /// Nothing governs the reply: no assignment owns this turn, or an automatic
    /// retry is about to continue it (that end is not terminal).
    Ungoverned,
    /// The assignment is still open because its turn ended on a question only
    /// the owner can answer: nothing is finished and no reply is owed yet.
    Waiting,
    /// The assignment's reply is owed, and its row is the once-only claim.
    Owed(Value),
}

/// Turn-end hook for a side conversation: the assignment that owned the turn gets
/// the turn's own outcome.
///
/// Invariants this relies on: a `queued` row owns no prompt yet, so its ending is
/// decided by `started()` reading the turn back, never guessed here; a turn that
/// ends while the answer to *this* assignment's own question is live is an older
/// ending arriving late, so it owns neither the status nor the reply and nothing
/// is relayed for it (any other live turn leaves this ending to be judged on its
/// own turn, so a failure is never swallowed); and a turn with no exact turn-id
/// match is only attributed to a conversation with exactly one open assignment.
pub(crate) async fn after_turn(st: &AppState, side_session_id: &str, turn: Option<String>, outcome: &str, detail: Option<String>) -> TurnEnd {
    // The answer's turn has started while this (question) turn's ending was still
    // on its way: the live turn finishes the assignment and relays its reply, and
    // this ending must not finish it first. Only the answer's own turn counts:
    // another assignment's turn in the same conversation, or an automatic retry,
    // is no reason to swallow this ending, because nothing else would ever report
    // this assignment's failure to the Manager.
    if let Some(live) = active_turn(st, side_session_id).await.filter(|live| turn.as_deref() != Some(live.as_str())) {
        if turn.as_deref().is_some_and(|ending| answer_continues_row(st, side_session_id, &live, ending)) { return TurnEnd::Waiting; }
    }
    let found = turn.as_deref()
        .and_then(|turn| st.db.delegation_find_for_side_turn(side_session_id, turn).ok().flatten())
        .or_else(|| single_open_for_side(st, side_session_id));
    let Some(row) = found else {
        // No assignment owns this turn. An answer's turn whose assignment already
        // ended has nothing left to report (its reply was relayed by that
        // assignment), so it is not sent to the Manager a second time.
        return if turn.as_deref().is_some_and(|turn| turn_is_question_answer(st, side_session_id, turn)) { TurnEnd::Waiting } else { TurnEnd::Ungoverned };
    };
    // Only a running assignment owns a turn: a queued one has not started, and a
    // terminal one is never rewritten by a late or duplicated ending.
    if row["status"] != "running" { return TurnEnd::Owed(row); }
    let id = row["id"].as_str().unwrap_or("").to_owned();
    let owns = match (turn.as_deref(), row["sideTurnId"].as_str().filter(|turn| !turn.is_empty())) {
        // The hook was called without a turn id: nothing to attribute, the row's
        // own outcome is reported.
        (None, _) => true,
        (Some(turn), Some(current)) => turn == current,
        // The row started without a recorded turn: this one becomes it.
        (Some(_), None) => false,
    };
    if !owns {
        let Some(ending) = turn.as_deref() else { return TurnEnd::Ungoverned };
        // A newer turn continues this assignment (an automatic retry, adopted at
        // its end); an older turn's late ending is not this assignment's news.
        let current = row["sideTurnId"].as_str().filter(|turn| !turn.is_empty());
        let newer = current.is_none_or(|current| {
            turn_is_newer(st, side_session_id, ending, current)
                .unwrap_or_else(|| turn_outcome(st, side_session_id, current).is_some())
        });
        if !newer { return TurnEnd::Waiting; }
        adopt(st, &id, ending).await;
    }
    match outcome {
        "turn.completed" => {
            // A turn that ended by asking the owner a question is not finished
            // work: the assignment stays `running` on its own turn id, and the
            // answer's next turn ends it. Only the owner can answer, and the
            // Manager may not relay one in its place.
            if question_holds_assignment_open(st, &row) {
                return TurnEnd::Waiting;
            }
            match finish(st, &id, "completed", None).await { Some(dto) => TurnEnd::Owed(dto), None => TurnEnd::Ungoverned }
        }
        "turn.cancelled" => match finish(st, &id, "cancelled", None).await { Some(dto) => TurnEnd::Owed(dto), None => TurnEnd::Ungoverned },
        _ => {
            // A retry queued by `retry::after_failed_turn` is the assignment still
            // running, not a failure: the retry's own turn decides its end.
            if retry_scheduled(st, turn.as_deref()).await { return TurnEnd::Ungoverned; }
            let detail = detail.map(|detail| one_line(&detail)).filter(|detail| !detail.is_empty()).unwrap_or_else(|| "The turn failed.".to_owned());
            match finish(st, &id, "failed", Some(detail)).await { Some(dto) => TurnEnd::Owed(dto), None => TurnEnd::Ungoverned }
        }
    }
}

/// Whether `turn_id` was created after `other_turn_id` in this conversation, read
/// from the stored turn list, which is in creation order. `None` when either turn
/// is not in it any more.
fn turn_is_newer(st: &AppState, side_session_id: &str, turn_id: &str, other_turn_id: &str) -> Option<bool> {
    let side = st.db.session_detail(side_session_id).ok()?;
    let turns = side["turns"].as_array()?;
    let index = |id: &str| turns.iter().position(|turn| turn["id"].as_str() == Some(id));
    Some(index(turn_id)? > index(other_turn_id)?)
}

/// Whether a turn was started by the daemon as the continuation of an assignment:
/// the answer to an `ask_user` question. Used only when no assignment can be found
/// for the turn, so its reply is not relayed as if it were a new result.
fn turn_is_question_answer(st: &AppState, side_session_id: &str, turn_id: &str) -> bool {
    answer_question_id(st, side_session_id, turn_id).is_some()
}

/// The question an answer turn carries, read from the turn's own user message.
fn answer_question_id(st: &AppState, side_session_id: &str, turn_id: &str) -> Option<String> {
    let session = st.db.session_detail(side_session_id).ok()?;
    let messages = session["messages"].as_array()?;
    let message = messages.iter().find(|message| {
        message["turnId"].as_str() == Some(turn_id) && message["role"] == "user" && message["meta"]["kind"] == "question_answer"
    })?;
    message["meta"]["questionId"].as_str().filter(|id| !id.is_empty()).map(str::to_owned)
}

/// Whether the turn that is live right now is the answer to a question of the
/// assignment that owns `ending_turn`. That is the one case where an ending that
/// arrives late must stay silent: the answer's turn will finish the assignment
/// and relay its reply. A legacy card (no stored assignment id) only counts when
/// its conversation carries this one open assignment, the same rule every other
/// legacy lookup uses.
fn answer_continues_row(st: &AppState, side_session_id: &str, live: &str, ending_turn: &str) -> bool {
    let Ok(Some(row)) = st.db.delegation_find_for_side_turn(side_session_id, ending_turn) else { return false };
    if row["status"] != "running" { return false; }
    let Some(question) = answer_question_id(st, side_session_id, live) else { return false };
    match question_delegation_id(st, &question) {
        Some(id) => row["id"].as_str() == Some(id.as_str()),
        // A legacy card has no owner to compare: keep the old session-level rule,
        // but only while this conversation carries a single open assignment.
        None => open_for_side_count(st, side_session_id) == 1 && st.db.pending_question_exists(side_session_id).unwrap_or(false),
    }
}

/// The answer's own turn has started: the assignment the answered question belongs
/// to adopts it, so that turn's ending is the one that finishes the row, claims the
/// reply once and relays the child's final text, even though the answer was queued
/// behind the question's turn.
///
/// Deliberately synchronous, and it spawns the announcement: this runs on the
/// prompt path, whose futures already reach back here through the turn-end hook, so
/// an `async fn` would make the daemon's future types recursive (E0391).
/// Idempotent: a second call for the same turn finds it adopted and only makes sure
/// the question no longer holds the assignment open.
pub(crate) fn answer_started(st: &AppState, delegation_id: &str, turn_id: &str, question_id: &str) {
    if delegation_id.is_empty() || turn_id.is_empty() { return; }
    // From here the assignment waits on this turn, not on the question, so the
    // hold is released in every case below (including an assignment that ended
    // while the answer was in flight: nothing can be adopted any more).
    let _ = st.db.question_mark_answer_pending(question_id, false);
    let Ok(row) = st.db.delegation_get(delegation_id) else { return };
    // Only a running assignment has a turn to adopt. A terminal row is never
    // rewritten; a queued one has not been briefed and its own start adopts.
    if row["status"] != "running" { return; }
    if row["sideTurnId"].as_str() == Some(turn_id) { return; }
    let (state, id, turn) = (st.clone(), delegation_id.to_owned(), turn_id.to_owned());
    tokio::spawn(async move {
        // The same adoption `started` uses: the row's turn becomes this one and the
        // Manager's board is told, once.
        let _ = adopt(&state, &id, &turn).await;
    });
}

/// Whether this failed turn is about to be retried automatically. The retry hook
/// records its decision in the turn's data, possibly after this hook has run, so
/// while automatic retry is on an undecided turn is waited for (bounded) rather
/// than reported failed too early.
async fn retry_scheduled(st: &AppState, turn: Option<&str>) -> bool {
    let Some(turn) = turn else { return false };
    let decision = |data: &Value| data["retryDecision"]["decision"].as_str().map(str::to_owned);
    let mut current = decision(&st.db.turn_data(turn).unwrap_or(Value::Null));
    if current.as_deref() != Some("retry") && st.db.settings().unwrap_or(Value::Null)["experimental.autoRetry"] == true {
        for _ in 0..RETRY_DECISION_WAIT_STEPS {
            tokio::time::sleep(std::time::Duration::from_millis(RETRY_DECISION_WAIT_MS)).await;
            current = decision(&st.db.turn_data(turn).unwrap_or(Value::Null));
            // `deciding` is the single-owner claim, so keep waiting past it.
            if current.as_deref().is_some_and(|decision| decision != "deciding") { break; }
        }
    }
    current.as_deref() == Some("retry")
}

/// The automatic retry that belonged to this failed turn was cancelled or
/// superseded, so the assignment will not continue: report it failed rather than
/// leaving it running with no turn left to end it.
///
/// The row is found through every turn the assignment has used, not only its
/// current one: an answer turn moves `sideTurnId`, so a retry created for the
/// turn that failed earlier still belongs to the same row. Two open rows that
/// both used the turn is a state this never guesses about; only exactly one is
/// acted on, and a restart's reconciliation covers the rest.
pub(crate) async fn retry_dropped(st: &AppState, side_session_id: &str, turn_id: &str) {
    let rows = st.db.delegation_open_rows_for_turn(side_session_id, turn_id).unwrap_or_default();
    let [row] = rows.as_slice() else { return };
    if row["status"] != "running" { return; }
    let id = row["id"].as_str().unwrap_or("");
    // A row whose current turn is the live one is still running that turn; only a
    // row with nothing left to end it is reported failed here.
    if let Some(live) = active_turn(st, side_session_id).await {
        let live_row = st.db.delegation_find_for_side_turn(side_session_id, &live).ok().flatten();
        if live_row.and_then(|live_row| live_row["id"].as_str().map(str::to_owned)).as_deref() == Some(id) { return; }
    }
    let ended = finish(st, id, "failed", Some("The turn failed and no automatic retry will continue it.".to_owned())).await;
    // The Manager is owed the failure: nothing else will relay it, because the
    // turn's own end was reported as "a retry continues this".
    if let Some(ended) = ended { relay_stopped(st, &ended).await; }
}

/// The turn id a side conversation is running right now, if any.
pub(crate) async fn active_turn(st: &AppState, session_id: &str) -> Option<String> {
    st.active_turns.lock().await.get(session_id).cloned()
}

/// The assignment whose turn is the one that asked a question: the row of the
/// conversation's live turn, else the single `running` row of that conversation
/// when exactly one exists. `None` means the question is unlinked (a legacy card,
/// or a conversation with no assignment): a caller must never guess past this.
pub(crate) async fn question_owner_row(st: &AppState, side_session_id: &str) -> Option<Value> {
    if let Some(row) = active_turn(st, side_session_id).await
        .and_then(|turn| st.db.delegation_find_for_side_turn(side_session_id, &turn).ok().flatten())
    {
        return Some(row);
    }
    let mut running = st.db.delegation_list_for_side(side_session_id).unwrap_or_default()
        .into_iter().filter(|row| row["status"] == "running");
    let only = running.next()?;
    if running.next().is_some() { return None; }
    Some(only)
}

/// The assignment a question card belongs to: the id the daemon stored on the
/// card's own record when it was created, and only for a legacy card with none,
/// the newest assignment the conversation carries.
pub(crate) fn question_row(st: &AppState, side_session_id: &str, request_id: &str) -> Option<Value> {
    match question_delegation_id(st, request_id) {
        Some(id) => st.db.delegation_get(&id).ok(),
        None => st.db.delegation_list_for_side(side_session_id).ok().and_then(|rows| rows.into_iter().next_back()),
    }
}

/// Nothing can start the turn this answer was holding its assignment open for: its
/// queue item is gone and the conversation is idle. The hold is released, and when
/// the assignment's own turn already ended it takes that turn's outcome and its
/// reply goes out once, exactly as the turn's own hook would have done.
pub(crate) async fn dropped_answer(st: &AppState, side_session_id: &str, question_id: &str) {
    let Some(row) = question_row(st, side_session_id, question_id) else { return };
    if row["status"] != "running" { return; }
    let _ = st.db.question_mark_answer_pending(question_id, false);
    // Another of its questions may still hold it open.
    if question_holds_assignment_open(st, &row) { return; }
    let turn = row["sideTurnId"].as_str().unwrap_or("");
    let Some((status, error)) = turn_outcome(st, side_session_id, turn) else { return };
    let ended = finish(st, row["id"].as_str().unwrap_or(""), status, error).await;
    if let Some(ended) = ended { relay_stopped(st, &ended).await; }
}

/// The assignment id stored on a question card, if it has one.
fn question_delegation_id(st: &AppState, request_id: &str) -> Option<String> {
    st.db.permission_get(request_id).ok()
        .and_then(|card| card["delegationId"].as_str().filter(|id| !id.is_empty()).map(str::to_owned))
}

/// Whether one assignment is still open: waiting for its brief or running.
fn is_open(row: &Value) -> bool {
    matches!(row["status"].as_str(), Some("queued" | "running"))
}

/// How many assignments one side conversation carries that are still open.
fn open_for_side_count(st: &AppState, side_session_id: &str) -> usize {
    st.db.delegation_list_for_side(side_session_id).unwrap_or_default().iter().filter(|row| is_open(row)).count()
}

/// The one open assignment of a side conversation, when exactly one exists.
///
/// A turn with no exact turn-id match may only be attributed to a conversation
/// that carries a single open assignment. With several open rows, guessing could
/// finish the wrong one (and claim its reply), so the ending is left ungoverned.
fn single_open_for_side(st: &AppState, side_session_id: &str) -> Option<Value> {
    let mut open = st.db.delegation_list_for_side(side_session_id).unwrap_or_default().into_iter().filter(is_open);
    let only = open.next()?;
    if open.next().is_some() { return None; }
    Some(only)
}

/// Whether a question still holds one assignment open.
///
/// A card of its own is the answer. A legacy card (created before the association
/// existed, so it carries no assignment id) keeps the old session-level check, but
/// only while the conversation carries exactly one open assignment: another
/// assignment's card can never hold this one.
fn question_holds_assignment_open(st: &AppState, row: &Value) -> bool {
    let id = row["id"].as_str().unwrap_or("");
    if st.db.question_holds_open(id).unwrap_or(false) { return true; }
    let side = row["sideSessionId"].as_str().unwrap_or("");
    if side.is_empty() { return false; }
    open_for_side_count(st, side) == 1 && st.db.pending_question_exists(side).unwrap_or(false)
}

/// One pending request being announced to a Manager: already checked, already
/// shortened to what may leave the side conversation.
struct Update {
    origin: String,
    side: String,
    agent_id: String,
    name: String,
    text: String,
    delegation: String,
    request_id: String,
    request_kind: String,
    title: String,
    depth: u32,
}

/// The text of one wake, composed here once so the live path and the boot
/// re-offer send exactly the same words. Delivery is identified by assignment and
/// request IDs. It names the bot and the request's short title only: no
/// question, option, command, diff or tool input ever appears in it.
fn wake_text(name: &str, request_kind: &str, title: &str) -> String {
    let waiting = if request_kind == "question" { "answer a question" } else { "approve a request" };
    format!("[Update from {name}]\n{name} is waiting for the user to {waiting}: \"{title}\". The user decides in {name}'s own conversation; you cannot answer it. Tell the user, and do not approve anything or send the task again.")
}

/// Records a wake whose delivery reached the Manager. A queued delivery stays
/// `pending` until the drain sends it, exactly like a reply.
fn settle_wake(st: &AppState, delegation_id: &str, request_id: &str, delivered: bool) {
    if delivered { let _ = st.db.delegation_wake_settle(delegation_id, request_id, "sent"); }
}

/// A queued wake that has just left the queue has reached the Manager, so the row
/// stops waiting. Used by the drain, which is the only place a wake offered at
/// startup (or queued behind a busy Manager) actually goes out.
pub(crate) fn settle_queued_wake(st: &AppState, meta: &Value) {
    if meta["kind"] != "blob_update" { return; }
    if let (Some(id), Some(request)) = (meta["delegationId"].as_str(), meta["requestId"].as_str()) {
        let _ = st.db.delegation_wake_settle(id, request, "sent");
    }
}

/// A queued wake that will never be delivered because its assignment is over is
/// recorded as dropped, so a later boot does not offer it again.
pub(crate) fn drop_queued_wake(st: &AppState, meta: &Value) {
    if meta["kind"] != "blob_update" { return; }
    if let (Some(id), Some(request)) = (meta["delegationId"].as_str(), meta["requestId"].as_str()) {
        let _ = st.db.delegation_wake_settle(id, request, "dropped");
    }
}

/// Delivers one update from its own task and never reports back to the caller.
///
/// Deliberately synchronous: the delivery path reaches the prompt driver, which
/// reaches back to the event forwarder, so an `async fn` wrapper here would make
/// the daemon's future types recursive. The wake is already claimed in the ledger
/// by its caller, so this task announces a request at most once per id (the claim
/// is durable and its ack is idempotent on replay); the delivery's outcome settles
/// it (`sent` only when the prompt was accepted, and a queued item stays `pending`
/// for the drain to settle).
fn spawn_update(st: AppState, update: Update) {
    tokio::spawn(async move {
        // The wake can be dropped between the claim and this task (the assignment
        // ended, or the request was answered): a dropped wake is never sent.
        if !st.db.delegation_wake_pending(&update.delegation, &update.request_id).unwrap_or(false) { return; }
        if matches!(st.db.permission_status(&update.request_id), Ok(Some(status)) if status != "pending") {
            let _ = st.db.delegation_wake_settle(&update.delegation, &update.request_id, "dropped");
            return;
        }
        let delivery = crate::team::deliver_update(&st, &update.origin, &update.side, &update.agent_id, &update.name,
            update.text, &update.delegation, &update.request_id, &update.request_kind, &update.title, update.depth).await;
        settle_wake(&st, &update.delegation, &update.request_id, delivery == crate::team::Delivery::Sent);
    });
}

/// A child's pending approval or question wakes the Manager conversation that
/// assigned its work, once per request. The Manager is only told: it is given no
/// way to answer, and this never touches the request itself.
///
/// Invariants this relies on: only a `running` assignment owns a turn that can be
/// waiting (a `queued` one has not been briefed, a terminal one is over); the
/// wake is claimed in the ledger before anything is delivered, so a repeated
/// event, a second surface or a retry announces the same request once; and the
/// title is the request's short title only, never a command, diff or tool input.
pub(crate) async fn attention(st: &AppState, side_session_id: &str, request_id: &str, request_kind: &str, title: &str) {
    if request_id.is_empty() { return; }
    // The request belongs to the assignment whose turn raised it: the id stored on
    // the card itself, and only for a legacy card the old guess (the live turn,
    // else the open one). The wake is claimed on that row, so a card of one
    // assignment is never announced through another's row.
    let row = match question_delegation_id(st, request_id) {
        Some(id) => st.db.delegation_get(&id).ok(),
        None => active_turn(st, side_session_id).await
            .and_then(|turn| st.db.delegation_find_for_side_turn(side_session_id, &turn).ok().flatten())
            .or_else(|| st.db.delegation_latest_open_for_side(side_session_id).ok().flatten()),
    };
    let Some(row) = row else { return };
    if row["status"] != "running" { return; }
    let Some(id) = row["id"].as_str() else { return };
    // The Manager is reached through the side conversation's own link, never by
    // guessing: a conversation that is not a side one wakes nothing, and a
    // delegation to oneself is refused upstream and skipped here as well.
    let Ok(session) = st.db.session_detail(side_session_id) else { return };
    let origin = session["link"]["originSessionId"].as_str().unwrap_or("");
    if origin.is_empty() || origin == side_session_id || !st.db.session_exists(origin).unwrap_or(false) { return; }
    let agent_id = row["targetAgentId"].as_str().unwrap_or("");
    let name = st.db.agent_get(agent_id).ok().and_then(|agent| agent["name"].as_str().map(str::to_owned)).unwrap_or_else(|| "Teammate".to_owned());
    let title: String = one_line(title).chars().take(160).collect();
    // `question` or `approval` only; any other wording keeps today's "approve"
    // text, which is what every existing caller means by a non-question request.
    let request_kind = if request_kind == "question" { "question" } else { "approval" };
    // The claim stores the pending wake (state, short title, kind) in one atomic
    // statement, so a restart can re-offer it. It refuses to replace a wake that
    // is still pending: that older notice is delivered first, never overwritten.
    if !st.db.delegation_wake_claim(id, request_id, &title, request_kind).unwrap_or(false) { return; }
    let text = wake_text(&name, request_kind, &title);
    // The hop depth the side conversation is running at travels with the notice,
    // exactly as a reply does, so the Manager's own hops still count.
    let depth = st.team.depth_of(side_session_id);
    spawn_update(st.clone(), Update {
        origin: origin.to_owned(),
        side: side_session_id.to_owned(),
        agent_id: agent_id.to_owned(),
        name,
        text,
        delegation: id.to_owned(),
        request_id: request_id.to_owned(),
        request_kind: request_kind.to_owned(),
        title,
        depth,
    });
}

/// Startup reconciliation, called once next to `tasks::startup`.
///
/// Nothing can be running right after a boot: a live row takes its turn's own
/// persisted outcome, and anything still marked live becomes `interrupted` with
/// the restart's reason. An interrupted brief is never redelivered automatically
/// (it may already have changed files); only a row that never started is.
pub async fn startup(st: &AppState) {
    for row in st.db.delegation_list_by_status("running").unwrap_or_default() {
        // An answer that can no longer start a turn (its queue item was deleted,
        // or the item was left `sending` by the restart) must not hold this
        // assignment open: the hold is released before the outcome is read, and
        // the normal logic below finishes the row.
        release_abandoned_answers(st, &row);
        let (status, error) = stopped_outcome(st, &row);
        // A turn that ended on a question only the owner can answer did not
        // finish the assignment: the row is left running on that turn, so the
        // answer's next turn ends it (an expiry or dismissal still prompts the
        // child, so it can never stay running with nothing to end it).
        if status == "completed" && question_holds_assignment_open(st, &row) { continue; }
        let ended = finish(st, row["id"].as_str().unwrap_or(""), status, error).await;
        // A brief the restart cut off is never redelivered and, unlike a
        // completion, has no reply to re-offer: without a notice the Manager would
        // never learn the work stopped. One note per assignment, written once
        // because the row is terminal from here on.
        if status == "interrupted" {
            if let Some(ended) = ended { notice_interrupted(st, &ended).await; }
        } else if let Some(ended) = &ended {
            // The turn ended just before the daemon stopped, so no live hook ever
            // claimed its reply: the claim is taken here (once), which is what makes
            // the offer loop below pick this row up exactly like one a previous boot
            // left waiting.
            if matches!(status, "completed" | "failed") { claim_reply(st, ended); }
        }
    }
    for row in st.db.delegation_queued_for_recovery().unwrap_or_default() {
        let (Some(id), Some(side)) = (row["id"].as_str(), row["sideSessionId"].as_str()) else { continue };
        let Some(text) = row["deliveryText"].as_str().filter(|text| !text.is_empty()) else { continue };
        if !st.db.session_exists(side).unwrap_or(false) { continue; }
        let from = row["fromAgentId"].as_str().unwrap_or("");
        let name = st.db.agent_get(from).ok().and_then(|agent| agent["name"].as_str().map(str::to_owned)).unwrap_or_else(|| "The Manager".to_owned());
        // No notice is written: the "Waiting for" line is already in the transcript,
        // and the brief is redelivered exactly once, by the drain.
        let meta = json!({"kind":"blob_message","fromAgentId":from,"fromName":name,"delegationId":id});
        st.team.restore_queued(side, text.to_owned(), meta, row["deliveryDepth"].as_u64().unwrap_or(0) as u32).await;
    }
    // An assignment that ended while its reply was still waiting for a busy
    // Manager when the daemon stopped is offered again, exactly once per boot: the
    // reply is recomposed by the same `reply_text` the live path uses (a
    // completion's text is read from the turn again, never stored on the row), so
    // a failed or cancelled ending survives the restart like a completed one. The
    // offer is a queued delivery, because this runs before the team address
    // exists; the boot drain below sends it, and only then is it marked delivered.
    for row in st.db.delegation_pending_replies().unwrap_or_default() {
        offer_reply(st, &row).await;
    }
    // Lane V1: a wake claimed before the restart is offered again, once, and only
    // while it still means something. This runs after the reply offers, so the
    // Manager hears about finished work before a request that may still be open.
    for row in st.db.delegation_pending_wakes().unwrap_or_default() {
        offer_wake(st, &row).await;
    }
}

/// Re-offers one pending wake at boot. The three conditions are the facts the
/// live path had when it claimed: (a) the assignment is still running, (b) the
/// request card is still pending for the owner (the card's row status, which is
/// what the answer flow moves), and (c) the origin (Manager) conversation still
/// exists and is not archived. Anything else marks the wake `dropped` and writes
/// nothing: a cancelled or deleted parent is safe to skip.
///
/// The one ambiguous outcome is a process that died after `deliver` accepted the
/// prompt and before the ack. The Manager's stored messages are the proof: the
/// wake prompt is an ordinary user message with this exact text (the `blob_update`
/// meta is not persisted by the prompt path), so its presence means `sent`, its
/// absence means the wake never reached the transcript and can be offered again,
/// and a lookup that cannot answer at all marks it `dropped` rather than risk
/// sending it twice.
async fn offer_wake(st: &AppState, row: &Value) {
    let (Some(id), Some(origin), Some(request)) = (row["id"].as_str(), row["originSessionId"].as_str(), row["requestId"].as_str()) else { return };
    let drop = |st: &AppState| { let _ = st.db.delegation_drop_pending_wake(id); };
    match st.db.delegation_get(id) {
        Ok(current) if current["status"] == "running" => {}
        _ => { drop(st); return; }
    }
    match st.db.session_brief(origin) {
        Ok(session) if session["archived"] != true => {}
        _ => { drop(st); return; }
    }
    match st.db.permission_status(request) {
        Ok(Some(status)) if status == "pending" => {}
        _ => { drop(st); return; }
    }
    let (Some(title), Some(kind)) = (row["title"].as_str().filter(|title| !title.is_empty()), row["kind"].as_str()) else {
        drop(st);
        return;
    };
    let agent = row["targetAgentId"].as_str().unwrap_or("");
    let name = st.db.agent_get(agent).ok().and_then(|agent| agent["name"].as_str().map(str::to_owned)).unwrap_or_else(|| "Teammate".to_owned());
    let text = wake_text(&name, kind, title);
    match st.db.delegation_wake_delivered(origin, id, request) {
        Ok(true) => { let _ = st.db.delegation_wake_settle(id, request, "sent"); return; }
        Ok(false) => {}
        Err(_) => { let _ = st.db.delegation_wake_settle(id, request, "dropped"); return; }
    }
    // A queued offer, exactly like a reply: this runs before the team address
    // exists, so the boot drain sends it and settles it then. The wake stays
    // `pending` until that send, and a boot that never reaches the drain offers it
    // again next time.
    let meta = json!({"kind":"blob_update","fromAgentId":agent,"fromName":name,
        "sideSessionId":row["sideSessionId"],"delegationId":id,"requestId":request,
        "requestKind":kind,"title":title});
    st.team.restore_queued(origin, text, meta, row["deliveryDepth"].as_u64().unwrap_or(0) as u32).await;
}

/// Queue one assignment's reply for the Manager, composed exactly as the live path
/// composes it (`reply_text`; a completion's text is read from the side turn again,
/// never stored on the row). The offer is a queued delivery, because this runs
/// before the team address exists: the boot drain sends it, and only then is the
/// row marked delivered. A row already offered by a previous boot is offered again,
/// which is what keeps a reply that never left the queue from being lost.
async fn offer_reply(st: &AppState, row: &Value) {
    let (Some(id), Some(origin), Some(side)) = (row["id"].as_str(), row["originSessionId"].as_str(), row["sideSessionId"].as_str()) else { return };
    if !st.db.session_exists(origin).unwrap_or(false) { return; }
    let kind = match row["status"].as_str() {
        Some(status @ ("completed" | "cancelled" | "failed")) => status,
        // Anything else is not a reply.
        _ => return,
    };
    let source = match kind {
        "completed" => row["sideTurnId"].as_str().filter(|turn| !turn.is_empty())
            .and_then(|turn| st.db.turn_reply(side, turn).ok().flatten()),
        "cancelled" => None,
        _ => row["error"].as_str().map(str::to_owned),
    };
    let reply = crate::team::reply_text(kind, source.as_deref());
    let agent = row["targetAgentId"].as_str().unwrap_or("");
    let name = st.db.agent_get(agent).ok().and_then(|agent| agent["name"].as_str().map(str::to_owned)).unwrap_or_else(|| "Teammate".to_owned());
    let meta = json!({"kind":"blob_reply","fromAgentId":agent,"fromName":name,"sideSessionId":side,"delegationId":id});
    st.team.restore_queued(origin, format!("[Reply from {name}]\n{reply}"), meta, row["deliveryDepth"].as_u64().unwrap_or(0) as u32).await;
}

/// Clears the answer hold of one assignment's questions when nothing can start the
/// answer's turn any more: the conversation holds no prompt carrying that
/// question's id, so no turn is coming for it. This runs at boot, before any turn.
fn release_abandoned_answers(st: &AppState, row: &Value) {
    let (side, id) = (row["sideSessionId"].as_str().unwrap_or(""), row["id"].as_str().unwrap_or(""));
    if side.is_empty() || id.is_empty() { return; }
    for question in st.db.question_ids_for_delegation(id).unwrap_or_default() {
        let Ok(card) = st.db.permission_get(&question) else { continue };
        if card["answerPending"] != true { continue; }
        if st.db.queue_has_question_answer(side, &question).unwrap_or(false) { continue; }
        let _ = st.db.question_mark_answer_pending(&question, false);
    }
}

/// The honest status for one row that was live when the daemon stopped.
fn stopped_outcome(st: &AppState, row: &Value) -> (&'static str, Option<String>) {
    row["sideTurnId"].as_str()
        .and_then(|turn| turn_outcome(st, row["sideSessionId"].as_str().unwrap_or(""), turn))
        .unwrap_or_else(|| ("interrupted", Some(INTERRUPTED.to_owned())))
}

/// The outcome a side turn already has, or `None` while it is still live. Shared
/// by the restart reconciliation and by [`started`], so a turn that ended before
/// its assignment was marked running gets exactly the outcome it had.
fn turn_outcome(st: &AppState, side_session_id: &str, turn_id: &str) -> Option<(&'static str, Option<String>)> {
    if turn_id.is_empty() { return None; }
    let side = st.db.session_detail(side_session_id).ok()?;
    let stored = side["turns"].as_array()?.iter().find(|row_turn| row_turn["id"].as_str() == Some(turn_id))?;
    let state = stored["state"].as_str().unwrap_or("");
    // `recover_after_restart` rewrites a live turn to `error` with this marker, so
    // a brief cut off by the restart is not reported as a provider failure.
    let restarted = st.db.turn_data(turn_id).unwrap_or(Value::Null)["watchdogInterrupted"] == true;
    match state {
        "completed" => Some(("completed", None)),
        "cancelled" => Some(("cancelled", None)),
        "error" | "failed" if restarted => Some(("interrupted", Some(INTERRUPTED.to_owned()))),
        "error" | "failed" => {
            let detail = stored["failureMessage"].as_str().filter(|detail| !detail.trim().is_empty()).unwrap_or("The turn failed.");
            Some(("failed", Some(one_line(detail))))
        }
        _ => None,
    }
}

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        // Read-only: the assignments one conversation made, oldest first, or the
        // ones a side conversation carries.
        "delegation.list" => {
            let origin = p["originSessionId"].as_str().filter(|id| !id.is_empty());
            let side = p["sideSessionId"].as_str().filter(|id| !id.is_empty());
            match (origin, side) {
                (Some(_), Some(_)) => Err(derr("invalid_argument", "delegation.list takes originSessionId or sideSessionId, not both", StatusCode::BAD_REQUEST)),
                (Some(origin), None) => list(st, origin, false),
                (None, Some(side)) => list(st, side, true),
                (None, None) => Err(derr("invalid_argument", "originSessionId or sideSessionId is required", StatusCode::BAD_REQUEST)),
            }
        }
        // The owner stops one assignment. A brief that has not gone out never
        // does; a turn is stopped only when it is this assignment's own turn.
        "delegation.cancel" => {
            let id = p["delegationId"].as_str().map(str::trim).filter(|id| !id.is_empty())
                .ok_or_else(|| derr("invalid_argument", "delegationId is required", StatusCode::BAD_REQUEST))?;
            let row = st.db.delegation_get(id).map_err(storage_error)?;
            Ok(json!({"delegation": cancel_row(st, &row).await}))
        }
        // The owner stops everything one Manager turn started. Rows of another
        // origin turn, or of another Manager conversation, are never touched.
        "delegation.cancelGroup" => cancel_group(st, p).await,
        _ => Err(derr("not_found", "unknown delegation method", StatusCode::NOT_FOUND)),
    }
}

fn list(st: &AppState, id: &str, by_side: bool) -> Result<Value, DispatchError> {
    st.db.session_detail(id).map_err(|_| derr("not_found", "Conversation not found.", StatusCode::NOT_FOUND))?;
    let rows = if by_side { st.db.delegation_list_for_side(id) } else { st.db.delegation_list_for_origin(id) }.map_err(storage_error)?;
    Ok(json!({"delegations": rows}))
}

/// `delegation.cancelGroup`: the same stop rule for every live assignment one
/// origin turn made, answered with those rows as they stand afterwards.
async fn cancel_group(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let origin = p["originSessionId"].as_str().map(str::trim).filter(|id| !id.is_empty())
        .ok_or_else(|| derr("invalid_argument", "originSessionId is required", StatusCode::BAD_REQUEST))?;
    let turn = p["originTurnId"].as_str().filter(|turn| !turn.is_empty());
    let ids: Vec<&str> = p["delegationIds"].as_array().map(|ids| ids.iter().filter_map(Value::as_str).filter(|id| !id.is_empty()).collect()).unwrap_or_default();
    if turn.is_none() && ids.is_empty() {
        return Err(derr("invalid_argument", "originTurnId or delegationIds is required", StatusCode::BAD_REQUEST));
    }
    st.db.session_detail(origin).map_err(|_| derr("not_found", "Conversation not found.", StatusCode::NOT_FOUND))?;
    let rows = st.db.delegation_list_for_origin(origin).map_err(storage_error)?;
    let mut out = Vec::new();
    for row in rows.iter().filter(|row| group_member(row, origin, turn, &ids)) {
        out.push(if is_terminal(row) { row.clone() } else { cancel_row(st, row).await });
    }
    Ok(json!({"delegations": out}))
}

/// Whether one row belongs to the group being stopped: this same Manager turn
/// (or one of the named assignments) in this same conversation.
fn group_member(row: &Value, origin: &str, turn: Option<&str>, ids: &[&str]) -> bool {
    if row["originSessionId"].as_str() != Some(origin) { return false; }
    match turn {
        Some(turn) => row["originTurnId"].as_str() == Some(turn),
        None => row["id"].as_str().is_some_and(|id| ids.contains(&id)),
    }
}

/// Whether one assignment is over: past it, a late or duplicated ending is never
/// rewritten, and a question it left pending can no longer be answered.
pub(crate) fn is_terminal(row: &Value) -> bool {
    matches!(row["status"].as_str(), Some("completed" | "failed" | "cancelled" | "interrupted"))
}

/// Stops one assignment and returns its row as it stands after the attempt. A
/// terminal row is returned unchanged; nothing is ever forced on a live turn
/// that this assignment does not own.
async fn cancel_row(st: &AppState, row: &Value) -> Value {
    let id = row["id"].as_str().unwrap_or("");
    if is_terminal(row) { return row.clone(); }
    let side = row["sideSessionId"].as_str().unwrap_or("");
    let origin = row["originSessionId"].as_str().unwrap_or("");
    // A waiting assignment whose turn already ended has not finished its work;
    // the owner is stopping it now, so it ends as cancelled, not completed.
    let waiting = question_holds_assignment_open(st, row);
    // The owner stopped this assignment, so the questions it left pending are
    // closed at once, with no prompt: a card cannot outlive the work it asked
    // about. Another assignment's cards, row and wake claim are left untouched.
    close_pending_questions(st, id, side).await;
    if row["status"] == "queued" {
        // The brief is still only text: take it out of the queue before the row
        // is closed, so the drain can never deliver a cancelled assignment.
        st.team.cancel_queued(side, id).await;
        let ended = finish(st, id, "cancelled", None).await.unwrap_or_else(|| row.clone());
        relay_stopped(st, &ended).await;
        return ended;
    }
    // Running. Only this assignment's own turn may be stopped, and never the
    // Manager's conversation (a delegation to oneself is refused upstream; this
    // is the belt beside it). The turn id travels with the request: the stop only
    // happens while that exact turn is still the conversation's live one.
    let turn = row["sideTurnId"].as_str().unwrap_or("");
    if !turn.is_empty() && origin != side {
        match crate::cancel_session_turn_if(st, side, turn).await {
            // The turn that was read here is still the live one and the stop was
            // asked for: the turn's own end hook marks the row through
            // `after_turn`, so the row is answered as it stands.
            Ok(result) if result["cancellationRequested"] == true => row.clone(),
            // `turn_changed`: nothing was stopped. Re-read the row and the live
            // turn once (never a loop) and decide from what is really there.
            Ok(_) => {
                let now = st.db.delegation_get(id).unwrap_or_else(|_| row.clone());
                if is_terminal(&now) { return now; }
                let own = now["sideTurnId"].as_str().unwrap_or("");
                let live = st.active_turns.lock().await.get(side).cloned();
                // (a) The row's own turn ended while the stop was being checked:
                // it takes that turn's real outcome, exactly like the branch that
                // finds an ended turn below.
                let ended = if live.as_deref() != Some(own) {
                    turn_outcome(st, side, own)
                } else {
                    None
                };
                let ended = match ended {
                    Some((status, error)) => {
                        let status = if waiting && status == "completed" { "cancelled" } else { status };
                        finish(st, id, status, if status == "cancelled" { None } else { error }).await
                    }
                    // (b) Another turn is live and it is not this row's (or the
                    // own turn ended without a readable outcome): end only the
                    // row as cancelled and never touch the session.
                    None => finish(st, id, "cancelled", None).await,
                };
                let ended = ended.unwrap_or_else(|| now.clone());
                relay_stopped(st, &ended).await;
                ended
            }
            // Nothing could be asked to stop: the row would otherwise stay live
            // with no turn left to end it.
            Err(_) => {
                let ended = finish(st, id, "cancelled", None).await.unwrap_or_else(|| row.clone());
                relay_stopped(st, &ended).await;
                ended
            }
        }
    } else if let Some((status, error)) = turn_outcome(st, side, turn) {
        // Its turn is already over: report what really happened, not "cancelled".
        // A turn that ended on a question is the exception: the owner is
        // stopping the work that question is about, so it ends as cancelled.
        let status = if waiting && status == "completed" { "cancelled" } else { status };
        let ended = finish(st, id, status, if status == "cancelled" { None } else { error }).await.unwrap_or_else(|| row.clone());
        relay_stopped(st, &ended).await;
        ended
    } else {
        // No live turn of its own is left to end it.
        let ended = finish(st, id, "cancelled", None).await.unwrap_or_else(|| row.clone());
        relay_stopped(st, &ended).await;
        ended
    }
}
