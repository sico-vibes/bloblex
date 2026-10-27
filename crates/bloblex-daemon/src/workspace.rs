//! `session.workspace`: where one conversation is actually working.
//!
//! A conversation is either working in its project folder (`shared`) or in its
//! own copy of the repository (`isolated`), and the owner must be able to tell
//! the difference — and to see, plainly, when isolation was wanted and did not
//! happen. Everything here is read-only: every git call is a plain argument list
//! (never a shell), runs with `--no-optional-locks` so not even the index is
//! refreshed, is bounded in time, and its output is read only to branch on it,
//! never logged. The client names a conversation; the folder always comes from
//! the session row.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// The longest one git call may take; a stuck git must never hang the RPC.
const GIT_TIMEOUT: Duration = Duration::from_secs(5);
/// A session state that means the conversation is working right now.
const WORKING: [&str; 3] = ["starting", "working", "waiting_permission"];

/// `session.workspace`: the folder, its repository, and who else is working in it.
pub(crate) async fn rpc(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty())
        .ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    let detail = st.db.session_detail(session_id).map_err(|_| derr("not_found", "session not found", StatusCode::NOT_FOUND))?;
    Ok(report(st, session_id, &detail).await)
}

/// The answered contract for one stored conversation row.
async fn report(st: &AppState, session_id: &str, detail: &Value) -> Value {
    let project_path = detail["projectPath"].as_str().unwrap_or("").trim().to_owned();
    let link = &detail["link"];
    let worktree = link["worktree"].as_object().map(|_| link["worktree"].clone());
    // `isolated` only when the copy's own folder is where this conversation runs,
    // compared the way Windows compares paths (case and separators aside).
    let isolated = worktree.as_ref().is_some_and(|worktree| {
        let path = worktree["path"].as_str().unwrap_or("");
        !path.is_empty() && !project_path.is_empty() && folder_key(Path::new(path)) == folder_key(Path::new(&project_path))
    });
    let mode = if project_path.is_empty() {
        "unknown"
    } else if isolated {
        "isolated"
    } else {
        "shared"
    };
    let isolation = link["worktreeError"].as_str().map(str::trim).filter(|reason| !reason.is_empty())
        .map(|reason| one_line(reason, 200));
    let worktree_answer = if isolated {
        worktree.as_ref().map(|worktree| json!({
            "path": worktree["path"].as_str().unwrap_or(""),
            "branch": worktree["branch"].as_str().unwrap_or(""),
            "base": worktree["base"].as_str().unwrap_or(""),
            "baseCommit": worktree["baseCommit"].as_str().unwrap_or(""),
            "repo": worktree["repo"].as_str().unwrap_or(""),
        }))
    } else {
        None
    };
    let (is_git, repo_root, branch, head) = if project_path.is_empty() {
        (false, None, None, None)
    } else {
        git_facts(&project_path).await
    };
    json!({
        "sessionId": session_id,
        "mode": mode,
        "projectPath": project_path,
        "isGit": is_git,
        "repoRoot": repo_root,
        "branch": branch,
        "head": head,
        "worktree": worktree_answer,
        "isolationFailure": isolation,
        "sharedWith": shared_with(st, session_id, &project_path),
    })
}

/// The other conversations working in the same folder right now. Evidence only:
/// two tasks in one folder are how two bots end up changing the same files.
fn shared_with(st: &AppState, session_id: &str, project_path: &str) -> Vec<Value> {
    if project_path.is_empty() { return Vec::new(); }
    let key = folder_key(Path::new(project_path));
    let Ok(rows) = st.db.session_list(false) else { return Vec::new() };
    rows.iter()
        .filter(|row| row["id"].as_str() != Some(session_id))
        .filter(|row| row["archived"] != true && WORKING.contains(&row["state"].as_str().unwrap_or("")))
        .filter(|row| row["projectPath"].as_str().is_some_and(|path| !path.is_empty() && folder_key(Path::new(path)) == key))
        .map(|row| json!({
            "sessionId": row["id"].as_str().unwrap_or(""),
            "agentId": row["agentId"].as_str().unwrap_or(""),
            "state": row["state"].as_str().unwrap_or(""),
        }))
        .collect()
}

/// A folder key that survives case and separator differences and, where the
/// folder can be resolved, symlinks and short names too.
fn folder_key(path: &Path) -> String {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    crate::worktree::normalize(&resolved)
}

/// One line, collapsed, capped: a stored reason is never a paragraph.
fn one_line(text: &str, limit: usize) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(limit).collect()
}

/// Whether the folder is a repository, its root, its branch and its commit.
async fn git_facts(project_path: &str) -> (bool, Option<String>, Option<String>, Option<String>) {
    let folder = PathBuf::from(project_path);
    let (root, branch, head) = tokio::join!(
        git(&folder, &["rev-parse", "--show-toplevel"]),
        git(&folder, &["rev-parse", "--abbrev-ref", "HEAD"]),
        git(&folder, &["rev-parse", "--short", "HEAD"]),
    );
    let Some(root) = root.filter(|root| !root.is_empty()) else { return (false, None, None, None) };
    // A detached HEAD reports the word HEAD instead of a branch name.
    let branch = branch.filter(|branch| !branch.is_empty() && branch != "HEAD");
    let head = head.filter(|head| !head.is_empty());
    (true, Some(root), branch, head)
}

/// One git call, off the runtime, bounded in time, with no shell and no stderr:
/// stdout is read only to branch on it and is never logged. A folder that is
/// missing, a git that is not installed and a failing command all answer `None`.
async fn git(folder: &Path, args: &'static [&'static str]) -> Option<String> {
    if !folder.is_dir() { return None; }
    let dir = folder.to_path_buf();
    let run = tokio::task::spawn_blocking(move || {
        crate::experiments::git_command()
            .arg("--no-optional-locks").arg("-C").arg(&dir).args(args)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
            .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_OBJECT_DIRECTORY").env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .env_remove("GIT_NAMESPACE").env_remove("GIT_EXTERNAL_DIFF").env_remove("GIT_PAGER")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .output()
    });
    match tokio::time::timeout(GIT_TIMEOUT, run).await {
        Ok(Ok(Ok(output))) if output.status.success() => Some(String::from_utf8_lossy(&output.stdout).trim().to_owned()),
        _ => None,
    }
}
