//! Turn checkpoints: what each turn changed, and which of those changes could be
//! undone one file at a time.
//!
//! The conversation already records every reported file change with the diff the
//! provider saved. This module is a read-only report: it asks Git which changes
//! still reverse cleanly (`experiments::reverse_file_check`, the same validation
//! and `git apply --check` that `file.revert` uses) so a file edited after the
//! agent wrote it is reported as blocked and is never offered for undo.
//!
//! Nothing here changes a file, a turn or the conversation. Undo is per file and
//! happens only through `file.revert`, one change at a time, in its own dispatch
//! arm. There is no whole-turn restore: a batch that stopped halfway would leave
//! the turn part undone, and no file undo can rewind what the provider's agent
//! remembers of the conversation anyway.

use crate::{derr, experiments, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Only the newest changes are checked, because each check is a Git process.
const CHECK_LIMIT: usize = 200;
const NOT_GIT: &str = "This folder is not a Git repository, so changes can't be restored.";
const NO_PROJECT: &str = "This conversation has no project folder.";
/// Bitbots undoes files; it cannot rewind a provider's own conversation memory.
const PROVIDER_REASON: &str = "Undoing a file does not change what the agent remembers of the conversation. Tell the agent if you want it to know.";
/// The refusals `experiments::prepare_reverse` makes that are about the saved
/// diff itself, never about the folder or a later edit to the file. A change
/// that hit one of these never had a complete diff, so no undo can ever apply
/// it; every other refusal leaves a complete diff in place.
const INCOMPLETE_DIFF_REASONS: [&str; 4] = [
    "No complete diff was saved for this change.",
    "The saved diff was clipped or incomplete; this change cannot be reverted safely.",
    "The saved diff is incomplete or is not a supported single-file text patch.",
    "The saved diff contains other paths or is incomplete.",
];

fn is_busy(row: &Value) -> bool {
    matches!(row["state"].as_str(), Some("starting" | "working" | "cancelling" | "waiting_permission"))
}

fn session_id_of(p: &Value) -> Result<&str, DispatchError> {
    p["sessionId"].as_str().filter(|value| !value.is_empty())
        .ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))
}

/// `session.checkpoints`: the per-turn list of changes, each with the state that
/// decides whether the UI may offer an undo of that one file.
pub(crate) async fn session_checkpoints(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let session_id = session_id_of(p)?;
    let row = st.db.session_detail(session_id).map_err(|_| derr("not_found", "Conversation not found.", StatusCode::NOT_FOUND))?;
    let project = PathBuf::from(row["projectPath"].as_str().unwrap_or(""));
    let busy = is_busy(&row);
    // Oldest first in storage; keep the newest CHECK_LIMIT and drop older ones.
    let mut files: Vec<Value> = row["files"].as_array().cloned().unwrap_or_default();
    if files.len() > CHECK_LIMIT { files.drain(..files.len() - CHECK_LIMIT); }
    let checked = tokio::task::spawn_blocking(move || inspect(&project, &files))
        .await
        .map_err(|_| derr("internal", "Could not check these changes.", StatusCode::INTERNAL_SERVER_ERROR))?;
    Ok(json!({
        "sessionId": session_id,
        "capability": {
            // Undoing one file at a time; never the whole turn.
            "fileUndo": checked["fileUndo"],
            "fileUndoReason": checked["fileUndoReason"],
            // Bitbots undoes files, never the provider's conversation memory.
            "providerStateRestore": false,
            "providerReason": PROVIDER_REASON,
        },
        "busy": busy,
        "turns": group_turns(checked["files"].as_array().cloned().unwrap_or_default()),
    }))
}

/// The blocking half: the folder's Git state once, then every recorded change.
fn inspect(project: &Path, files: &[Value]) -> Value {
    let (file_undo, file_undo_reason) = undo_status(project);
    let mut checked: Vec<Option<Value>> = vec![None; files.len()];
    // Newest first, so a bounded run covers the changes a user is most likely
    // to undo; the list itself is put back in recorded order.
    for (index, file) in files.iter().enumerate().rev() {
        checked[index] = Some(file_dto(project, file, file_undo, file_undo_reason.as_deref()));
    }
    json!({
        "fileUndo": file_undo,
        "fileUndoReason": file_undo_reason,
        "files": checked.into_iter().flatten().collect::<Vec<_>>(),
    })
}

fn undo_status(project: &Path) -> (bool, Option<String>) {
    if project.as_os_str().is_empty() { return (false, Some(NO_PROJECT.into())); }
    let Ok(project) = project.canonicalize() else { return (false, Some("This conversation's project folder is unavailable.".into())); };
    match experiments::git_command().current_dir(&project).args(["rev-parse", "--is-inside-work-tree"]).output() {
        Ok(output) if output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true" => (true, None),
        Ok(output) if output.status.success() => (false, Some("This folder is not a Git working copy, so changes can't be restored.".into())),
        Ok(_) => (false, Some(NOT_GIT.into())),
        Err(_) => (false, Some("Git could not be started, so changes can't be restored.".into())),
    }
}

fn file_dto(project: &Path, file: &Value, undo: bool, undo_reason: Option<&str>) -> Value {
    let detail = &file["detail"];
    let path = file["path"].as_str().unwrap_or("");
    let (additions, deletions) = line_counts(detail["diff"].as_str());
    let (state, reason, diff_complete) = if detail["reverted"] == true {
        // `file.revert` refuses an incomplete diff before it writes anything, so
        // a change already marked reverted had a complete saved diff.
        ("reverted", None, true)
    } else {
        // The check runs even when the folder cannot undo anything, so
        // `diffComplete` is read from the one rule instead of guessed. An
        // unusable diff returns before Git starts; a complete one costs the call
        // the branch below needs anyway.
        let outcome = experiments::reverse_file_check(project, path, detail);
        let diff_complete = diff_complete(&outcome);
        if !undo {
            ("blocked", Some(undo_reason.unwrap_or(NOT_GIT).to_owned()), diff_complete)
        } else {
            match outcome {
                Ok(()) => ("available", None, diff_complete),
                // The concurrent-modification guard: Git refuses the reverse check
                // when the file no longer matches what the patch expects.
                Err(message) => ("blocked", Some(message), diff_complete),
            }
        }
    };
    json!({
        "id": file["id"],
        "turnId": file["turnId"],
        "path": path,
        "operation": detail["change"],
        "additions": additions,
        "deletions": deletions,
        "state": state,
        "reason": reason,
        "diffComplete": diff_complete,
    })
}

/// Whether a complete saved diff exists, read from the check's own result so the
/// rule stays in `experiments::prepare_reverse`: only its diff refusals mean the
/// diff itself is missing or unusable.
fn diff_complete(outcome: &Result<(), String>) -> bool {
    match outcome {
        Ok(()) => true,
        Err(message) => !INCOMPLETE_DIFF_REASONS.contains(&message.as_str()),
    }
}

/// Added and removed lines in a saved unified diff, headers excluded.
fn line_counts(diff: Option<&str>) -> (Option<u32>, Option<u32>) {
    let Some(diff) = diff.filter(|text| !text.is_empty()) else { return (None, None) };
    let mut additions = 0u32;
    let mut deletions = 0u32;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") { continue; }
        if line.starts_with('+') { additions = additions.saturating_add(1); }
        else if line.starts_with('-') { deletions = deletions.saturating_add(1); }
    }
    (Some(additions), Some(deletions))
}

/// Group the recorded order into turns, oldest first. A change recorded without
/// a turn keeps a `null` turn id, and the group sits where its first change does.
fn group_turns(files: Vec<Value>) -> Vec<Value> {
    let mut turns: Vec<(Option<String>, Vec<Value>)> = Vec::new();
    for file in files {
        let turn_id = file["turnId"].as_str().map(str::to_owned);
        match turns.iter_mut().find(|(id, _)| id == &turn_id) {
            Some((_, group)) => group.push(file),
            None => turns.push((turn_id, vec![file])),
        }
    }
    turns.into_iter().map(|(turn_id, files)| json!({"turnId": turn_id, "files": files})).collect()
}

