//! Phase 3: worktrees no conversation is using any more.
//!
//! A conversation that works in its own copy of the repository leaves that copy (`<repo>-bitbots/<slug>`
//! on `bitbots/<slug>`) behind when it is deleted or archived, and the owner has no way to find it again.
//! `worktree.abandoned` lists those copies; `worktree.removeAbandoned` removes one, only after the owner
//! confirmed it. **Nothing here runs on a timer, and nothing is removed without that call.**
//!
//! The list is the guard: `removeAbandoned` recomputes it and refuses an id it does not see again, so a
//! copy that a live conversation works in — or that is a registered project's own folder — can never be
//! removed, whatever the caller sends. Both of the current bots are themselves live conversations in
//! worktrees, which is why that rule is the one that matters most. Every git call is a plain argument
//! list (never a shell), bounded in time, and its output is read only to branch on it, never logged.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// The folder family every task copy lives under: `<repo>-bitbots`.
const FAMILY_SUFFIX: &str = "-bitbots";
/// How long one repository's whole scan may take; a stuck git must never hang the RPC.
const SCAN_LIMIT: Duration = Duration::from_secs(20);
/// How long one removal may take: Windows can be slow to delete a deep folder.
const REMOVE_LIMIT: Duration = Duration::from_secs(120);

/// One task copy that no live conversation uses.
#[derive(Clone, Debug)]
struct Found {
    id: String,
    repo: PathBuf,
    path: PathBuf,
    branch: String,
    reason: &'static str,
    dirty: u64,
    ahead: u64,
    last_activity: Option<String>,
}

impl Found {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "repo": self.repo.to_string_lossy(),
            "path": self.path.to_string_lossy(),
            "branch": self.branch,
            "reason": self.reason,
            "dirtyFiles": self.dirty,
            "commitsAhead": self.ahead,
            "lastActivityAt": self.last_activity,
        })
    }
}

fn invalid(message: &str) -> DispatchError {
    derr("invalid_argument", message, StatusCode::BAD_REQUEST)
}

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "worktree.abandoned" => Ok(json!({"items": scan(st).await.iter().map(Found::to_json).collect::<Vec<_>>()})),
        "worktree.removeAbandoned" => remove(st, p).await,
        _ => Err(derr("not_found", "unknown worktree method", StatusCode::NOT_FOUND)),
    }
}

/// One `git [-C dir] args...` without a shell. Git's output is read to branch on it and never logged.
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = crate::experiments::git_command()
        .arg("--no-optional-locks").arg("-C").arg(dir).args(args)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY").env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_NAMESPACE").env_remove("GIT_EXTERNAL_DIFF").env_remove("GIT_PAGER")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    if !output.status.success() { return None; }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// A case- and separator-insensitive folder key, stable as an id across restarts.
fn key(path: &Path) -> String {
    crate::worktree::normalize(path)
}

/// A short, stable id for one copy: an FNV-1a hash of its normalised path, so a phone and the desktop
/// agree on it and nothing about the folder's contents is carried.
fn id_of(path: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key(path).as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// The RFC 3339 time the folder last changed, or `None` when it cannot be read.
fn last_activity(path: &Path) -> Option<String> {
    let modified = std::fs::metadata(path).and_then(|meta| meta.modified()).ok()?;
    let time: chrono::DateTime<chrono::Utc> = modified.into();
    Some(time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// A list of everything the current database knows about, so one scan can decide every entry.
#[derive(Default)]
struct Where {
    /// Folders a non-archived conversation works in: it could still open there.
    live: HashSet<String>,
    /// Folders an archived conversation still points at, so the reason can say so.
    archived: HashSet<String>,
    /// Every registered project's own folder.
    projects: HashSet<String>,
    /// Repository roots to look in, unvalidated.
    repos: Vec<PathBuf>,
}

impl Where {
    fn add_repo(&mut self, path: PathBuf) {
        if !self.repos.iter().any(|other| key(other) == key(&path)) { self.repos.push(path); }
    }

    fn folder(&mut self, path: &str, archived: bool) {
        if path.trim().is_empty() { return; }
        let path = Path::new(path);
        if archived { self.archived.insert(key(path)); } else { self.live.insert(key(path)); }
    }
}

impl AppState {
    /// Every folder and repository this database points at. `None` when the conversations can't be
    /// read: an empty "live" set would make every copy look abandoned, so nothing is listed then.
    fn where_worktrees_live(&self) -> Option<Where> {
        let sessions = self.db.session_list(true).ok()?;
        let mut out = Where::default();
        for project in self.db.project_list().unwrap_or_default() {
            let Some(path) = project["path"].as_str().filter(|path| !path.trim().is_empty()) else { continue };
            out.folder(path, false);
            out.projects.insert(key(Path::new(path)));
            out.add_repo(PathBuf::from(path));
        }
        for session in sessions {
            // An archived conversation with a turn still running is using its folder.
            let archived = session["archived"] == true && !crate::workspace::WORKING.contains(&session["state"].as_str().unwrap_or(""));
            if let Some(path) = session["projectPath"].as_str() { out.folder(path, archived); }
            let worktree = &session["link"]["worktree"];
            if let Some(path) = worktree["path"].as_str() { out.folder(path, archived); }
            if let Some(repo) = worktree["repo"].as_str().filter(|repo| !repo.trim().is_empty()) {
                out.add_repo(PathBuf::from(repo));
            }
        }
        Some(out)
    }
}

/// Every copy under a repository's `<repo>-bitbots` family that no live conversation uses.
async fn scan(st: &AppState) -> Vec<Found> {
    let Some(mut where_) = st.where_worktrees_live() else { return Vec::new() };
    let mut found = Vec::new();
    for repo in std::mem::take(&mut where_.repos) {
        let live = where_.live.clone();
        let archived = where_.archived.clone();
        let projects = where_.projects.clone();
        let task = tokio::task::spawn_blocking(move || scan_repo(&repo, &live, &archived, &projects));
        let Ok(Ok(mut items)) = tokio::time::timeout(SCAN_LIMIT, task).await else { continue };
        found.append(&mut items);
    }
    found.sort_by(|a, b| a.path.to_string_lossy().to_lowercase().cmp(&b.path.to_string_lossy().to_lowercase()));
    found
}

/// One repository: its registered worktrees, filtered down to the ones nothing live uses.
fn scan_repo(repo: &Path, live: &HashSet<String>, archived: &HashSet<String>, projects: &HashSet<String>) -> Vec<Found> {
    let Some(root) = crate::worktree::repo_root(repo) else { return Vec::new() };
    let Some(listed) = git(&root, &["worktree", "list", "--porcelain"]) else { return Vec::new() };
    let Some(name) = root.file_name().map(|name| name.to_string_lossy().into_owned()) else { return Vec::new() };
    let Some(parent) = root.parent() else { return Vec::new() };
    let family = format!("{}/", key(&parent.join(format!("{name}{FAMILY_SUFFIX}"))));
    let root_key = key(&root);
    let mut found = Vec::new();
    for (path, branch, locked) in parse_worktrees(&listed) {
        // The main worktree is the repository itself, and a locked copy is the owner's to keep.
        if key(&path) == root_key || locked { continue; }
        let Some(branch) = branch else { continue };
        if !branch.starts_with("bitbots/") || !key(&path).starts_with(&family) { continue; }
        let folder = key(&path);
        // A copy a live conversation works in, or a project's own folder, is never abandoned.
        if live.contains(&folder) || projects.contains(&folder) { continue; }
        let reason = if !path.is_dir() {
            "folder_missing"
        } else if archived.contains(&folder) {
            "conversation_archived"
        } else {
            "conversation_deleted"
        };
        let dirty = if reason == "folder_missing" { 0 } else { git(&path, &["status", "--porcelain"]).map(|text| text.lines().filter(|line| !line.trim().is_empty()).count() as u64).unwrap_or(0) };
        let ahead = git(&root, &["rev-list", "--count", &format!("HEAD..refs/heads/{branch}")]).and_then(|count| count.trim().parse().ok()).unwrap_or(0);
        found.push(Found { id: id_of(&path), repo: root.clone(), path: path.clone(), branch, reason, dirty, ahead, last_activity: last_activity(&path) });
    }
    found
}

/// `git worktree list --porcelain`: every entry's path, branch (without `refs/heads/`) and lock.
fn parse_worktrees(listed: &str) -> Vec<(PathBuf, Option<String>, bool)> {
    let mut out: Vec<(PathBuf, Option<String>, bool)> = Vec::new();
    for line in listed.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            out.push((PathBuf::from(rest.trim()), None, false));
        } else if let Some(rest) = line.strip_prefix("branch ") {
            if let Some(entry) = out.last_mut() { entry.1 = Some(rest.trim().trim_start_matches("refs/heads/").to_owned()); }
        } else if line == "locked" || line.starts_with("locked ") {
            if let Some(entry) = out.last_mut() { entry.2 = true; }
        }
    }
    out
}

/// What would be lost if this copy went without `force`.
fn lost(entry: &Found, delete_branch: bool) -> String {
    let mut parts = Vec::new();
    if entry.dirty > 0 {
        parts.push(format!("{} uncommitted {}", entry.dirty, if entry.dirty == 1 { "file" } else { "files" }));
    }
    if delete_branch && entry.ahead > 0 {
        parts.push(format!("{} {}", entry.ahead, if entry.ahead == 1 { "commit" } else { "commits" }));
    }
    format!("{} would be lost.", parts.join(" and "))
}

/// Run one git command off the runtime, with a time limit. `false` when it failed or took too long.
async fn run_git(dir: PathBuf, args: Vec<String>) -> bool {
    let task = tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git(&dir, &refs).is_some()
    });
    matches!(tokio::time::timeout(REMOVE_LIMIT, task).await, Ok(Ok(true)))
}

fn is_empty_or_missing(path: &Path) -> bool {
    match std::fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_none(),
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Removes the folder if it's there and empty, retrying briefly. True when it's gone. `remove_dir`
/// refuses a folder with anything in it, so this can only ever take an empty one.
async fn tidy_empty_folder(path: &Path) -> bool {
    for attempt in 0..4 {
        if !path.exists() || std::fs::remove_dir(path).is_ok() { return true; }
        if attempt < 3 { tokio::time::sleep(Duration::from_millis(400)).await; }
    }
    false
}

async fn remove(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    if p["confirm"] != true { return Err(invalid("Confirm removing the worktree first.")); }
    let id = p["id"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid("Choose a worktree to remove."))?;
    let delete_branch = p["deleteBranch"].as_bool().unwrap_or(false);
    let force = p["force"].as_bool().unwrap_or(false);
    // The list is recomputed every time: an id that is not on it now — a live conversation's copy, a
    // project's own folder, or anything this daemon did not list — is refused with nothing changed.
    let entry = scan(st).await.into_iter().find(|entry| entry.id == id)
        .ok_or_else(|| derr("not_found", "That worktree is no longer on the list.", StatusCode::NOT_FOUND))?;
    let losing_work = entry.dirty > 0 || (delete_branch && entry.ahead > 0);
    if losing_work && !force {
        return Err(derr("conflict", &lost(&entry, delete_branch), StatusCode::CONFLICT));
    }

    let removed = if entry.reason == "folder_missing" {
        // The folder is already gone; only the repository's record of it is left.
        run_git(entry.repo.clone(), vec!["worktree".into(), "prune".into()]).await
            && !parse_worktrees(&git(&entry.repo, &["worktree", "list", "--porcelain"]).unwrap_or_default())
                .iter().any(|(path, _, _)| key(path) == key(&entry.path))
    } else {
        let mut args = vec!["worktree".to_owned(), "remove".to_owned()];
        if force { args.push("--force".to_owned()); }
        args.push(entry.path.to_string_lossy().into_owned());
        let finished = run_git(entry.repo.clone(), args).await;
        // On Windows git deletes the files and then fails on the empty folder itself while a process,
        // such as the coding agent, still has it as its working folder. The copy is gone by then, and
        // git's record is only cleared by a prune. A folder with anything left in it isn't removed.
        finished || (is_empty_or_missing(&entry.path) && run_git(entry.repo.clone(), vec!["worktree".into(), "prune".into()]).await)
    };
    // The emptied folder holds nothing, so it's only tidied here and never blocks the rest.
    let folder_left = removed && entry.reason != "folder_missing" && !tidy_empty_folder(&entry.path).await;

    // The branch goes only once the copy has: if removing failed, its commits may be all that's left.
    let mut branch_deleted = false;
    if delete_branch && removed {
        let _ = run_git(entry.repo.clone(), vec!["branch".into(), "-D".into(), entry.branch.clone()]).await;
        branch_deleted = git(&entry.repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", entry.branch)]).is_none();
    }

    let mut detail = match (entry.reason, removed) {
        ("folder_missing", true) => "The leftover record was removed.".to_owned(),
        ("folder_missing", false) => "The leftover record could not be removed.".to_owned(),
        (_, true) if folder_left => "The worktree was removed. Its empty folder is still in use, so it stays until that ends.".to_owned(),
        (_, true) => "The worktree was removed.".to_owned(),
        (_, false) => "The worktree could not be removed, because something is still using its folder. Nothing else was changed, so try again once that has finished.".to_owned(),
    };
    if delete_branch && removed {
        detail.push_str(if branch_deleted { " Its branch was deleted." } else { " Its branch could not be deleted." });
    }
    Ok(json!({"removed": removed, "branchDeleted": branch_deleted, "detail": detail}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch;
    use crate::phase2a_tests::state;
    use std::process::Command;

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().map(|output| output.status.success()).unwrap_or(false)
    }

    fn git_ok(dir: &Path, args: &[&str]) -> bool {
        Command::new("git").current_dir(dir).args(args).output().map(|output| output.status.success()).unwrap_or(false)
    }

    /// A temp repository with one commit, and the sibling family folder its copies live in.
    fn repo(label: &str) -> Option<(PathBuf, PathBuf)> {
        if !git_available() { return None; }
        let dir = std::env::temp_dir().join(format!("bitbots-p3-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(git_ok(&dir, &["init", "-q"]));
        assert!(git_ok(&dir, &["config", "core.autocrlf", "false"]));
        std::fs::write(dir.join("readme.txt"), "hello\n").unwrap();
        assert!(git_ok(&dir, &["add", "."]));
        assert!(git_ok(&dir, &["-c", "user.name=Test", "-c", "user.email=test@bitbots.local", "commit", "-q", "-m", "init"]));
        let family = dir.parent().unwrap().join(format!("{}-bitbots", dir.file_name().unwrap().to_string_lossy()));
        Some((dir, family))
    }

    /// A linked worktree the way the daemon makes one: `<repo>-bitbots/<slug>` on `bitbots/<slug>`.
    fn worktree(repo: &Path, family: &Path, slug: &str) -> PathBuf {
        std::fs::create_dir_all(family).unwrap();
        let path = family.join(slug);
        assert!(git_ok(repo, &["worktree", "add", "-q", "-b", &format!("bitbots/{slug}"), path.to_str().unwrap(), "HEAD"]));
        path
    }

    fn cleanup(repo: &Path, family: &Path) {
        let _ = Command::new("git").current_dir(repo).args(["worktree", "prune"]).output();
        let _ = std::fs::remove_dir_all(family);
        let _ = std::fs::remove_dir_all(repo);
    }

    /// A conversation in `folder`, linked to the task copy `worktree`, as `session.new` stores it.
    /// The repository is also a registered project, which is how the daemon still knows it after the
    /// conversation is gone.
    fn conversation(st: &AppState, project: &str, id: &str, folder: &Path, worktree: &Path, repo: &Path) {
        st.db.create_session(id, "rt-test", "codex", &folder.to_string_lossy(), "Task").unwrap();
        st.db.update_session_state(id, "idle").unwrap();
        st.db.merge_session_data(id, &json!({"projectId": project})).unwrap();
        let link = json!({"kind":"main","worktree":{"path":worktree.to_string_lossy(),"branch":format!("bitbots/{}", worktree.file_name().unwrap().to_string_lossy()),"base":"main","baseCommit":"","repo":repo.to_string_lossy()}});
        st.db.set_session_link(id, &link).unwrap();
    }

    /// The repository as a registered project: its own folder.
    fn project(st: &AppState, repo: &Path) -> String {
        st.db.project_create("Repo", Some(&repo.to_string_lossy())).unwrap().0["id"].as_str().unwrap().to_owned()
    }

    async fn items(st: &AppState) -> Vec<Value> {
        dispatch(st, "worktree.abandoned", json!({})).await.unwrap()["items"].as_array().cloned().unwrap()
    }

    #[tokio::test]
    async fn a_live_conversations_worktree_is_never_listed() {
        let Some((repo, family)) = repo("live") else { return };
        let copy = worktree(&repo, &family, "live");
        let (st, _) = state();
        let project = project(&st, &repo);
        conversation(&st, &project, "live-session", &copy, &copy, &repo);
        assert!(items(&st).await.is_empty(), "a conversation that still exists keeps its copy");
        // A running bot's folder is never listed even while it is busy.
        st.db.update_session_state("live-session", "working").unwrap();
        assert!(items(&st).await.is_empty());
        cleanup(&repo, &family);
    }

    #[tokio::test]
    async fn a_deleted_conversations_worktree_is_listed() {
        let Some((repo, family)) = repo("deleted") else { return };
        let copy = worktree(&repo, &family, "gone");
        let (st, _) = state();
        let project = project(&st, &repo);
        conversation(&st, &project, "gone-session", &copy, &copy, &repo);
        dispatch(&st, "session.delete", json!({"sessionId":"gone-session"})).await.unwrap();
        let listed = items(&st).await;
        assert_eq!(listed.len(), 1, "{listed:?}");
        let entry = &listed[0];
        assert_eq!(entry["reason"], "conversation_deleted");
        assert_eq!(entry["branch"], "bitbots/gone");
        assert_eq!(PathBuf::from(entry["path"].as_str().unwrap()), copy);
        assert_eq!(PathBuf::from(entry["repo"].as_str().unwrap()), repo);
        assert_eq!((entry["dirtyFiles"].as_u64(), entry["commitsAhead"].as_u64()), (Some(0), Some(0)));
        assert!(entry["lastActivityAt"].as_str().is_some(), "{entry}");
        assert_eq!(entry["id"].as_str().unwrap().len(), 16, "the id is a hash of the path");
        cleanup(&repo, &family);
    }

    #[tokio::test]
    async fn an_archived_conversations_worktree_says_so() {
        let Some((repo, family)) = repo("archived") else { return };
        let copy = worktree(&repo, &family, "parked");
        let (st, _) = state();
        let project = project(&st, &repo);
        conversation(&st, &project, "parked-session", &copy, &copy, &repo);
        dispatch(&st, "session.archive", json!({"sessionId":"parked-session","archived":true})).await.unwrap();
        let listed = items(&st).await;
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0]["reason"], "conversation_archived");
        cleanup(&repo, &family);
    }

    #[tokio::test]
    async fn an_archived_conversation_with_a_running_turn_is_never_listed() {
        let Some((repo, family)) = repo("archived-busy") else { return };
        let copy = worktree(&repo, &family, "busy");
        let (st, _) = state();
        let project = project(&st, &repo);
        conversation(&st, &project, "busy-session", &copy, &copy, &repo);
        dispatch(&st, "session.archive", json!({"sessionId":"busy-session","archived":true})).await.unwrap();
        st.db.update_session_state("busy-session", "working").unwrap();
        assert!(items(&st).await.is_empty(), "a turn is still using that folder");
        cleanup(&repo, &family);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_folder_only_held_as_a_working_folder_counts_as_removed() {
        let Some((repo, family)) = repo("cwd") else { return };
        let copy = worktree(&repo, &family, "cwd");
        let (st, _) = state();
        let project = project(&st, &repo);
        conversation(&st, &project, "cwd-session", &copy, &copy, &repo);
        dispatch(&st, "session.delete", json!({"sessionId":"cwd-session"})).await.unwrap();
        let id = items(&st).await[0]["id"].as_str().unwrap().to_owned();
        // A process working in the folder, as a coding agent does, stops Windows deleting the folder itself.
        let mut holder = Command::new("cmd").args(["/c", "ping -n 30 127.0.0.1 > nul"]).current_dir(&copy).spawn().unwrap();
        let reply = dispatch(&st, "worktree.removeAbandoned", json!({"id":id,"deleteBranch":true,"force":true,"confirm":true})).await.unwrap();
        let _ = holder.kill();
        let _ = holder.wait();
        assert_eq!(reply["removed"], true, "{reply}");
        assert_eq!(reply["branchDeleted"], true, "{reply}");
        assert!(!git_ok(&repo, &["rev-parse", "--verify", "--quiet", "refs/heads/bitbots/cwd"]));
        assert!(items(&st).await.is_empty());
        cleanup(&repo, &family);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_failed_removal_keeps_the_branch() {
        use std::os::windows::fs::OpenOptionsExt as _;
        let Some((repo, family)) = repo("held") else { return };
        let copy = worktree(&repo, &family, "held");
        let (st, _) = state();
        let project = project(&st, &repo);
        conversation(&st, &project, "held-session", &copy, &copy, &repo);
        dispatch(&st, "session.delete", json!({"sessionId":"held-session"})).await.unwrap();
        let id = items(&st).await[0]["id"].as_str().unwrap().to_owned();
        // No sharing at all, so nothing can delete this file while it's open.
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(copy.join("readme.txt")).unwrap();
        let reply = dispatch(&st, "worktree.removeAbandoned", json!({"id":id,"deleteBranch":true,"force":true,"confirm":true})).await.unwrap();
        assert_eq!(reply["removed"], false, "{reply}");
        assert_eq!(reply["branchDeleted"], false, "{reply}");
        assert!(git_ok(&repo, &["rev-parse", "--verify", "--quiet", "refs/heads/bitbots/held"]), "the branch must survive a failed removal");
        drop(held);
        cleanup(&repo, &family);
    }

    #[tokio::test]
    async fn a_folder_outside_the_family_is_never_listed() {
        let Some((repo, family)) = repo("outside") else { return };
        // A worktree a person made by hand, outside `<repo>-bitbots`, on a bitbots branch.
        let outside = std::env::temp_dir().join(format!("bitbots-p3-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        assert!(git_ok(&repo, &["worktree", "add", "-q", "-b", "bitbots/outside", outside.to_str().unwrap(), "HEAD"]));
        let (st, _) = state();
        let _project = project(&st, &repo);
        assert!(items(&st).await.is_empty(), "only this repository's own family is ever listed");
        let _ = Command::new("git").current_dir(&repo).args(["worktree", "remove", "--force", outside.to_str().unwrap()]).output();
        let _ = std::fs::remove_dir_all(&outside);
        cleanup(&repo, &family);
    }

    #[tokio::test]
    async fn a_locked_worktree_is_never_listed() {
        let Some((repo, family)) = repo("locked") else { return };
        let copy = worktree(&repo, &family, "kept");
        let (st, _) = state();
        let project = project(&st, &repo);
        conversation(&st, &project, "kept-session", &copy, &copy, &repo);
        dispatch(&st, "session.delete", json!({"sessionId":"kept-session"})).await.unwrap();
        assert_eq!(items(&st).await.len(), 1, "it is listed while it is not locked");
        assert!(git_ok(&repo, &["worktree", "lock", copy.to_str().unwrap()]));
        assert!(items(&st).await.is_empty(), "a locked copy is the owner's to keep");
        cleanup(&repo, &family);
    }

    #[tokio::test]
    async fn remove_needs_confirm_and_a_listed_id() {
        let Some((repo, family)) = repo("confirm") else { return };
        let copy = worktree(&repo, &family, "guarded");
        let (st, _) = state();
        let project = project(&st, &repo);
        conversation(&st, &project, "guarded-session", &copy, &copy, &repo);
        dispatch(&st, "session.delete", json!({"sessionId":"guarded-session"})).await.unwrap();
        let id = items(&st).await[0]["id"].as_str().unwrap().to_owned();
        for params in [json!({"id":id}), json!({"id":id,"confirm":false})] {
            assert_eq!(dispatch(&st, "worktree.removeAbandoned", params).await.unwrap_err().1.code, "invalid_argument");
        }
        assert_eq!(dispatch(&st, "worktree.removeAbandoned", json!({"id":"nope","confirm":true})).await.unwrap_err().1.code, "not_found");
        // A live conversation's id is not on the list, so it is refused as never seen.
        let other = worktree(&repo, &family, "second");
        conversation(&st, &project, "second-session", &other, &other, &repo);
        assert_eq!(dispatch(&st, "worktree.removeAbandoned", json!({"id":id_of(&other),"confirm":true})).await.unwrap_err().1.code, "not_found");
        assert!(other.is_dir() && copy.is_dir(), "nothing was removed");
        cleanup(&repo, &family);
    }

    #[tokio::test]
    async fn remove_refuses_dirty_or_ahead_without_force() {
        let Some((repo, family)) = repo("force") else { return };
        let copy = worktree(&repo, &family, "dirty");
        let (st, _) = state();
        let project = project(&st, &repo);
        conversation(&st, &project, "dirty-session", &copy, &copy, &repo);
        dispatch(&st, "session.delete", json!({"sessionId":"dirty-session"})).await.unwrap();
        std::fs::write(copy.join("work.txt"), "half done\n").unwrap();
        let listed = items(&st).await;
        assert_eq!(listed[0]["dirtyFiles"], 1);
        let id = listed[0]["id"].as_str().unwrap().to_owned();
        let refused = dispatch(&st, "worktree.removeAbandoned", json!({"id":id,"deleteBranch":true,"confirm":true})).await.unwrap_err();
        assert_eq!(refused.1.code, "conflict");
        assert_eq!(refused.1.message, "1 uncommitted file would be lost.");
        assert!(copy.is_dir(), "nothing was removed");
        // Committed work alone needs force too, but only when the branch would go with it.
        assert!(git_ok(&copy, &["add", "."]));
        assert!(git_ok(&copy, &["-c", "user.name=Test", "-c", "user.email=test@bitbots.local", "commit", "-q", "-m", "work"]));
        let refused = dispatch(&st, "worktree.removeAbandoned", json!({"id":id,"deleteBranch":true,"confirm":true})).await.unwrap_err();
        assert_eq!(refused.1.message, "1 commit would be lost.");
        assert!(copy.is_dir());
        cleanup(&repo, &family);
    }

    #[tokio::test]
    async fn remove_with_force_takes_the_worktree_and_branch() {
        let Some((repo, family)) = repo("take") else { return };
        let copy = worktree(&repo, &family, "take");
        let (st, _) = state();
        let project = project(&st, &repo);
        conversation(&st, &project, "take-session", &copy, &copy, &repo);
        dispatch(&st, "session.delete", json!({"sessionId":"take-session"})).await.unwrap();
        std::fs::write(copy.join("work.txt"), "done\n").unwrap();
        assert!(git_ok(&copy, &["add", "."]));
        assert!(git_ok(&copy, &["-c", "user.name=Test", "-c", "user.email=test@bitbots.local", "commit", "-q", "-m", "work"]));
        let id = items(&st).await[0]["id"].as_str().unwrap().to_owned();
        let reply = dispatch(&st, "worktree.removeAbandoned", json!({"id":id,"deleteBranch":true,"force":true,"confirm":true})).await.unwrap();
        assert_eq!((reply["removed"].as_bool(), reply["branchDeleted"].as_bool()), (Some(true), Some(true)), "{reply}");
        assert!(!copy.exists(), "the folder is gone");
        assert!(!git_ok(&repo, &["rev-parse", "--verify", "--quiet", "refs/heads/bitbots/take"]), "its branch is gone too");
        assert!(items(&st).await.is_empty(), "nothing is left to list");
        cleanup(&repo, &family);
    }

    #[tokio::test]
    async fn keeping_the_branch_keeps_its_commits() {
        let Some((repo, family)) = repo("keep") else { return };
        let copy = worktree(&repo, &family, "keep");
        let (st, _) = state();
        let project = project(&st, &repo);
        conversation(&st, &project, "keep-session", &copy, &copy, &repo);
        dispatch(&st, "session.delete", json!({"sessionId":"keep-session"})).await.unwrap();
        std::fs::write(copy.join("work.txt"), "kept\n").unwrap();
        assert!(git_ok(&copy, &["add", "."]));
        assert!(git_ok(&copy, &["-c", "user.name=Test", "-c", "user.email=test@bitbots.local", "commit", "-q", "-m", "kept"]));
        let listed = items(&st).await;
        assert_eq!(listed[0]["commitsAhead"], 1);
        let id = listed[0]["id"].as_str().unwrap().to_owned();
        let reply = dispatch(&st, "worktree.removeAbandoned", json!({"id":id,"confirm":true})).await.unwrap();
        assert_eq!((reply["removed"].as_bool(), reply["branchDeleted"].as_bool()), (Some(true), Some(false)), "{reply}");
        assert!(!copy.exists());
        assert!(git_ok(&repo, &["rev-parse", "--verify", "--quiet", "refs/heads/bitbots/keep"]), "the branch still holds its commit");
        cleanup(&repo, &family);
    }

    #[tokio::test]
    async fn a_missing_folder_is_pruned() {
        let Some((repo, family)) = repo("missing") else { return };
        let copy = worktree(&repo, &family, "lost");
        let (st, _) = state();
        let project = project(&st, &repo);
        conversation(&st, &project, "lost-session", &copy, &copy, &repo);
        dispatch(&st, "session.delete", json!({"sessionId":"lost-session"})).await.unwrap();
        // Somebody deleted the folder by hand; git still remembers the copy.
        std::fs::remove_dir_all(&copy).unwrap();
        let listed = items(&st).await;
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0]["reason"], "folder_missing");
        assert_eq!(listed[0]["dirtyFiles"], 0);
        let id = listed[0]["id"].as_str().unwrap().to_owned();
        let reply = dispatch(&st, "worktree.removeAbandoned", json!({"id":id,"confirm":true})).await.unwrap();
        assert_eq!(reply["removed"].as_bool(), Some(true), "{reply}");
        assert!(items(&st).await.is_empty(), "the stale record is gone from the list");
        cleanup(&repo, &family);
    }
}
