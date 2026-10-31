//! Phase 3: clone a repository, and find the repositories under a folder.
//!
//! `project.clone` starts a clone and answers at once with a job, so the window can close and reopen
//! without losing it; `project.clone.list` reads the jobs in memory and `project.clone.cancel` stops
//! one. **The URL is untrusted input**: only `https://`, `ssh://` and the `git@host:path` form are
//! accepted, a leading `-`, an `ext::` transport, `file:`, `http://` and any URL holding a password
//! are refused before git is started, and git itself is told `protocol.ext.allow=never`. Every call is
//! an argument list with no shell, with a time limit, `GIT_TERMINAL_PROMPT=0`, and git's own sign-in:
//! this code never reads, passes or prints a credential.
//!
//! `project.discover` walks a folder the owner picked, never follows a symlink, and stops at the first
//! repository on each branch, so a project's own submodules are never offered as separate projects.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The longest a clone may run before it is stopped.
const CLONE_LIMIT: Duration = Duration::from_secs(30 * 60);
/// The time `project.discover` may spend walking.
const WALK_BUDGET: Duration = Duration::from_secs(10);
/// How much of a clone's output is read to build one line.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// The most jobs kept in memory for a window that reopens.
const MAX_JOBS: usize = 20;
/// The most folders and repositories a walk may look at.
const MAX_FOLDERS: usize = 5_000;
const MAX_REPOS: usize = 200;
/// The default and deepest walk depth.
const DEFAULT_DEPTH: u64 = 3;
const MAX_DEPTH: u64 = 5;
/// Folders a walk never goes into, besides hidden ones and `*-bitbots`.
const SKIP_FOLDERS: [&str; 4] = ["node_modules", "target", "dist", "vendor"];

#[cfg(test)]
pub(crate) static CLONE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Test only: a local repository this machine may clone from. Real calls accept only network URLs.
#[cfg(test)]
pub(crate) static LOCAL_REPO: Mutex<Option<PathBuf>> = Mutex::new(None);
/// Test only: a delay that stands in for a slow transport, so a cancel can be observed.
#[cfg(test)]
pub(crate) static CLONE_DELAY_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// One clone, held in memory only. Nothing about it is written to the database.
#[derive(Clone)]
struct Job {
    id: String,
    url: String,
    target: PathBuf,
    state: &'static str,
    detail: Option<String>,
    project: Value,
    /// Set by `project.clone.cancel`; the running task finishes and cleans up.
    cancelled: bool,
    /// The `git` process, so a cancel can stop its whole tree.
    pid: Option<u32>,
}

impl Job {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "url": self.url,
            "target": self.target.to_string_lossy(),
            "state": self.state,
            "detail": self.detail,
            "project": self.project,
        })
    }
}

fn jobs() -> &'static Mutex<Vec<Job>> {
    static JOBS: OnceLock<Mutex<Vec<Job>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Add a job, keeping only the newest few: a reopened window needs the recent ones, not history.
fn remember(job: Job) {
    let Ok(mut list) = jobs().lock() else { return };
    list.retain(|other| other.id != job.id);
    list.insert(0, job);
    list.truncate(MAX_JOBS);
}

fn job(id: &str) -> Option<Job> {
    jobs().lock().ok()?.iter().find(|job| job.id == id).cloned()
}

/// Change one job in place; `false` when it is no longer remembered.
fn update(id: &str, change: impl FnOnce(&mut Job)) -> bool {
    let Ok(mut list) = jobs().lock() else { return false };
    match list.iter_mut().find(|job| job.id == id) {
        Some(job) => { change(job); true }
        None => false,
    }
}

fn cancelled(id: &str) -> bool { job(id).is_some_and(|job| job.cancelled) }

fn invalid(message: &str) -> DispatchError {
    derr("invalid_argument", message, StatusCode::BAD_REQUEST)
}

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "project.clone" => start(st, p).await,
        "project.clone.cancel" => cancel(p),
        "project.clone.list" => {
            let list: Vec<Value> = jobs().lock().map(|jobs| jobs.iter().map(Job::to_json).collect()).unwrap_or_default();
            Ok(json!({"jobs": list}))
        }
        "project.discover" => discover(st, p).await,
        _ => Err(derr("not_found", "unknown project method", StatusCode::NOT_FOUND)),
    }
}

/// Why this URL may not be cloned, or `None` when it may. The URL is untrusted input: everything git
/// could read as an option or as another transport is refused here, before a process is started.
fn refuse_url(url: &str, allow_local: bool) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    if url.is_empty() || url.trim() != url || url.chars().any(|c| c.is_control() || c.is_whitespace()) { return Some("That doesn't look like a repository address.".to_owned()); }
    if url.starts_with('-') { return Some("A repository address cannot start with a dash.".to_owned()); }
    if lower.contains("ext::") { return Some("That kind of repository address is not supported.".to_owned()); }
    if lower.starts_with("file:") { return Some("Bitbots clones from a server, not from a folder on this machine.".to_owned()); }
    if lower.starts_with("http://") { return Some("Use https:// rather than http:// to clone.".to_owned()); }
    // The URL is only passed as an argument, but a password in it would end up in git's own history.
    if let Some(authority) = url.split_once("://").and_then(|(_, rest)| rest.split(['/', '?', '#']).next()) {
        if let Some((userinfo, _)) = authority.rsplit_once('@') {
            if userinfo.contains(':') { return Some("Put no password in the URL. Sign in with git or the GitHub CLI instead.".to_owned()); }
        }
    }
    let network = lower.starts_with("https://") || lower.starts_with("ssh://");
    let host = |start: usize| url[start..].split(['/', '?', '#']).next().unwrap_or("").trim();
    if network {
        let start = if lower.starts_with("https://") { 8 } else { 6 };
        let host = host(start);
        let host = host.rsplit_once('@').map(|(_, host)| host).unwrap_or(host);
        // A host starting with a dash would read as an option to ssh.
        if host.is_empty() || host.starts_with(':') || host.starts_with('-') { return Some("That doesn't look like a repository address.".to_owned()); }
        return None;
    }
    // The `git@host:path` form: a user, an `@`, a host, a colon and a path.
    if let Some((user, rest)) = url.split_once('@') {
        if let Some((host, path)) = rest.split_once(':') {
            let user_ok = !user.is_empty() && user.len() <= 64 && user.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
            if user_ok && !host.is_empty() && !host.starts_with('-') && !host.contains(['/', '\\', ' ']) && !path.is_empty() && !path.starts_with(':') { return None; }
        }
    }
    // A local folder is only ever a test's own repository; the rule for real calls stands.
    if allow_local && Path::new(url).is_absolute() { return None; }
    Some("That doesn't look like a repository address.".to_owned())
}

/// The folder name a URL suggests: its last segment, without `.git`.
fn suggested_name(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next().unwrap_or("");
    last.trim_end_matches(".git").to_owned()
}

async fn start(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    if p["confirm"] != true { return Err(invalid("Confirm cloning the repository first.")); }
    // The address is checked exactly as it arrives: a stray space or newline from a paste is refused.
    let url = p["url"].as_str().filter(|url| !url.is_empty()).ok_or_else(|| invalid("Enter the repository's address."))?;
    #[cfg(test)]
    let allow_local = LOCAL_REPO.lock().ok().and_then(|repo| repo.clone()).is_some_and(|repo| repo == Path::new(url));
    #[cfg(not(test))]
    let allow_local = false;
    if let Some(reason) = refuse_url(url, allow_local) { return Err(invalid(&reason)); }
    let parent = p["parent"].as_str().map(PathBuf::from).filter(|parent| parent.is_absolute() && parent.is_dir())
        .ok_or_else(|| invalid("Choose an existing folder to clone into."))?;
    let name = match p["name"].as_str().map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => name.to_owned(),
        None => suggested_name(url),
    };
    if !crate::scaffold::valid_folder_name(&name) { return Err(invalid("The repository's name doesn't work as a folder name. Choose another.")); }
    let target = parent.join(&name);
    if target.exists() { return Err(derr("conflict", "That folder already exists.", StatusCode::CONFLICT)); }

    let job = Job { id: uuid::Uuid::new_v4().to_string(), url: url.to_owned(), target: target.clone(), state: "running", detail: None, project: Value::Null, cancelled: false, pid: None };
    let answer = job.to_json();
    remember(job.clone());
    let st = st.clone();
    tokio::spawn(async move { run(st, job, name).await; });
    Ok(json!({"job": answer}))
}

/// Stops one clone: the task sees the flag, kills git's tree and removes the folder it made.
fn cancel(p: &Value) -> Result<Value, DispatchError> {
    let id = p["id"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid("Choose a clone to cancel."))?;
    let Some(found) = job(id) else { return Err(derr("not_found", "That clone is not running.", StatusCode::NOT_FOUND)) };
    if found.state != "running" { return Ok(json!({"job": found.to_json()})); }
    update(id, |job| job.cancelled = true);
    if let Some(pid) = found.pid { kill_tree(Some(pid)); }
    Ok(json!({"job": job(id).map(|job| job.to_json()).unwrap_or_else(|| found.to_json())}))
}

/// One clone: git, then either a registered project or a removed folder.
async fn run(st: AppState, job: Job, name: String) {
    #[cfg(test)]
    {
        let ms = CLONE_DELAY_MS.load(std::sync::atomic::Ordering::SeqCst);
        if ms > 0 {
            let until = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < until {
                if cancelled(&job.id) { finish(&st, &job, "cancelled", None, Value::Null, true).await; return; }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }
    if cancelled(&job.id) { finish(&st, &job, "cancelled", None, Value::Null, true).await; return; }
    let started = clone(&job).await;
    match started {
        CloneOutcome::Done => {
            // Registering reuses `project.create`, so a clone looks like any other new project.
            let made = crate::team::team_rpc(&st, "project.create", &json!({"name": name, "path": job.target.to_string_lossy()})).await;
            match made {
                Ok(reply) => finish(&st, &job, "done", None, reply["project"].clone(), false).await,
                Err(error) => finish(&st, &job, "failed", Some(crate::scaffold::one_line(&error.1.message)), Value::Null, true).await,
            }
        }
        CloneOutcome::Failed(detail) => finish(&st, &job, "failed", Some(detail), Value::Null, true).await,
        CloneOutcome::Cancelled => finish(&st, &job, "cancelled", None, Value::Null, true).await,
        CloneOutcome::TimedOut => finish(&st, &job, "failed", Some("The clone took too long and was stopped.".to_owned()), Value::Null, true).await,
    }
}

enum CloneOutcome { Done, Failed(String), Cancelled, TimedOut }

/// `git -c protocol.ext.allow=never clone --no-recurse-submodules -- <url> <target>`, off the runtime.
async fn clone(job: &Job) -> CloneOutcome {
    let mut command = tokio::process::Command::new("git");
    command.args(["-c", "protocol.ext.allow=never", "clone", "--no-recurse-submodules", "--"])
        .arg(&job.url).arg(&job.target)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY").env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env("GIT_TERMINAL_PROMPT", "0").env("NO_COLOR", "1");
    for (key, _) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if upper.starts_with("BITBOTS_") || upper.starts_with("BLOBLEX_") { command.env_remove(&key); }
    }
    #[cfg(windows)]
    { command.creation_flags(0x0800_0000); }
    let Ok(mut child) = command.spawn() else { return CloneOutcome::Failed("git could not be started.".to_owned()) };
    let pid = child.id();
    update(&job.id, |job| job.pid = pid);
    async fn read_all(pipe: Option<impl tokio::io::AsyncRead + Unpin>) -> Vec<u8> {
        use tokio::io::AsyncReadExt;
        let mut out = Vec::new();
        if let Some(pipe) = pipe { let _ = pipe.take(MAX_OUTPUT_BYTES as u64).read_to_end(&mut out).await; }
        out
    }
    let (stdout, stderr) = (tokio::spawn(read_all(child.stdout.take())), tokio::spawn(read_all(child.stderr.take())));
    let id = job.id.clone();
    let watch = async {
        loop {
            if cancelled(&id) { return; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    let outcome = tokio::select! {
        status = child.wait() => match status {
            Ok(status) if status.success() => CloneOutcome::Done,
            Ok(status) => {
                let (out, err) = (stdout.await.unwrap_or_default(), stderr.await.unwrap_or_default());
                CloneOutcome::Failed(clone_reason(&err, &out, status.code()))
            }
            Err(_) => CloneOutcome::Failed("git could not be run.".to_owned()),
        },
        () = watch => { kill_tree(pid); let _ = child.kill().await; CloneOutcome::Cancelled }
        () = tokio::time::sleep(CLONE_LIMIT) => { kill_tree(pid); let _ = child.kill().await; CloneOutcome::TimedOut }
    };
    update(&job.id, |job| job.pid = None);
    outcome
}

/// One redacted line from git, or a plain sentence.
fn clone_reason(stderr: &[u8], stdout: &[u8], code: Option<i32>) -> String {
    let (err, out) = (String::from_utf8_lossy(stderr), String::from_utf8_lossy(stdout));
    let line = err.lines().chain(out.lines()).map(str::trim).find(|line| !line.is_empty());
    match line {
        Some(line) => crate::scaffold::one_line(line),
        None => format!("git exited with code {}.", code.map_or_else(|| "unknown".to_owned(), |code| code.to_string())),
    }
}

/// End a job, remove the folder this job made when it failed or was stopped, and tell the window.
async fn finish(st: &AppState, entry: &Job, state: &'static str, detail: Option<String>, project: Value, clean: bool) {
    if clean { remove_created_folder(&entry.target); }
    update(&entry.id, |job| { job.state = state; job.detail = detail.clone(); job.project = project.clone(); job.pid = None; });
    let changed = job(&entry.id).map(|job| job.to_json()).unwrap_or_else(|| entry.to_json());
    st.emit("project.clone.changed", json!({"job": changed})).await;
}

/// Remove a folder a failed clone made. Only a folder that is empty or holds the clone's own `.git` is
/// removed, so a race with the owner's work never deletes anything that is not ours.
fn remove_created_folder(target: &Path) {
    if !target.exists() { return; }
    let empty = std::fs::read_dir(target).map(|mut entries| entries.next().is_none()).unwrap_or(false);
    if !empty && !target.join(".git").exists() { return; }
    let _ = std::fs::remove_dir_all(target);
}

/// Stops `pid` and everything it started (git spawns its transport as a child).
fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).creation_flags(0x0800_0000)
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
    }
    #[cfg(not(windows))]
    { let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).status(); }
}

/// One repository a walk found.
struct Found {
    path: PathBuf,
    branch: Option<String>,
}

/// `project.discover`: the repositories under a folder the owner picked, never following a symlink.
async fn discover(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let folder = p["folder"].as_str().map(PathBuf::from).filter(|folder| folder.is_absolute() && folder.is_dir())
        .ok_or_else(|| invalid("Choose an existing folder to look in."))?;
    let depth = p["depth"].as_u64().unwrap_or(DEFAULT_DEPTH).min(MAX_DEPTH);
    let root = folder.clone();
    let (found, truncated) = tokio::task::spawn_blocking(move || walk(&root, depth)).await.unwrap_or_default();
    let projects: Vec<String> = st.db.project_list().unwrap_or_default().iter()
        .filter_map(|project| project["path"].as_str().map(|path| crate::worktree::normalize(Path::new(path))))
        .collect();
    let repos: Vec<Value> = found.into_iter().map(|repo| {
        let name = repo.path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        json!({
            "path": repo.path.to_string_lossy(),
            "name": name,
            "branch": repo.branch,
            "alreadyAdded": projects.iter().any(|project| project == &crate::worktree::normalize(&repo.path)),
        })
    }).collect();
    Ok(json!({"folder": folder.to_string_lossy(), "repos": repos, "truncated": truncated}))
}

/// Walk breadth-first with a time, folder and repository budget. A repository is never descended into,
/// so a project's own submodules are not offered as projects of their own.
fn walk(folder: &Path, depth: u64) -> (Vec<Found>, bool) {
    let deadline = Instant::now() + WALK_BUDGET;
    let mut queue: std::collections::VecDeque<(PathBuf, u64)> = std::collections::VecDeque::new();
    queue.push_back((folder.to_path_buf(), 0));
    let mut found: Vec<Found> = Vec::new();
    let mut truncated = false;
    let mut folders = 0usize;
    while let Some((dir, level)) = queue.pop_front() {
        if Instant::now() > deadline || folders >= MAX_FOLDERS || found.len() >= MAX_REPOS { truncated = true; break; }
        folders += 1;
        if is_repository(&dir) {
            found.push(Found { path: dir.clone(), branch: current_branch(&dir) });
            continue;
        }
        if level >= depth { continue; }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            if !file_type.is_dir() { continue; }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.starts_with('.') || SKIP_FOLDERS.contains(&name.as_str()) || name.ends_with("-bitbots") { continue; }
            queue.push_back((entry.path(), level + 1));
        }
    }
    found.sort_by(|a, b| a.path.to_string_lossy().to_lowercase().cmp(&b.path.to_string_lossy().to_lowercase()));
    (found, truncated)
}

/// A folder with a `.git` of its own: a working repository or a worktree.
fn is_repository(dir: &Path) -> bool { dir.join(".git").exists() }

/// The branch a repository is on, read from its `HEAD` without starting git, or `None` on a detached
/// commit. A worktree's `.git` is a file naming the real git folder.
fn current_branch(dir: &Path) -> Option<String> {
    let dot = dir.join(".git");
    let git_dir = if dot.is_dir() {
        dot
    } else {
        let pointer = std::fs::read_to_string(&dot).ok()?;
        let target = PathBuf::from(pointer.trim().strip_prefix("gitdir:")?.trim());
        if target.is_absolute() { target } else { dir.join(target) }
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    head.trim().strip_prefix("ref: refs/heads/").map(str::to_owned).filter(|branch| !branch.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_checked_before_git_runs() {
        // The forms a person actually copies.
        for good in ["https://github.com/sico-vibes/bloblex.git", "https://github.com/sico-vibes/bloblex", "ssh://git@github.com/sico-vibes/bloblex.git", "ssh://git@example.com:2222/a/b.git", "git@github.com:sico-vibes/bloblex.git", "git@example.com:team/repo"] {
            assert_eq!(refuse_url(good, false), None, "{good}");
        }
        for bad in [
            "-u", "-c core.pager=calc", "ext::sh -c echo", "ext::git-remote-ext", "file:///C:/repo", "FILE:///C:/repo",
            "http://example.com/x.git", "HTTP://example.com/x.git", "ftp://example.com/x.git", "not a url", " https://x/y",
            "https://", "https:///path", "ssh://-oProxyCommand=calc/x", "git@-oProxyCommand=calc:x", "git@:path", "git@host:", "git@host", "user with space@host:path", "C:/local/repo", "\\\\server\\share",
        ] {
            assert!(refuse_url(bad, false).is_some(), "{bad} is refused");
        }
        // A password is refused with the one sentence the owner sees.
        for password in ["https://user:secret@example.com/x.git", "ssh://user:pw@example.com/x.git"] {
            assert_eq!(refuse_url(password, false).as_deref(), Some("Put no password in the URL. Sign in with git or the GitHub CLI instead."), "{password}");
        }
        // A local path is only ever allowed through the test-only allowance.
        assert!(refuse_url("C:/local/repo", false).is_some());
        assert_eq!(refuse_url("C:/local/repo", true), None);
        assert_eq!(suggested_name("https://github.com/sico-vibes/bloblex.git"), "bloblex");
        assert_eq!(suggested_name("git@github.com:team/repo.git"), "repo");
        assert_eq!(suggested_name("https://github.com/team/repo/"), "repo");
    }

    #[test]
    fn a_failed_clone_never_deletes_work_that_is_not_its_own() {
        let root = std::env::temp_dir().join(format!("bitbots-p3-clean-{}", uuid::Uuid::new_v4()));
        // A half-made clone: its own `.git` is there, so it is ours to remove.
        let half = root.join("half");
        std::fs::create_dir_all(half.join(".git")).unwrap();
        std::fs::write(half.join("partial.txt"), "x").unwrap();
        remove_created_folder(&half);
        assert!(!half.exists(), "a partial clone is removed");
        // An empty target the clone made itself.
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        remove_created_folder(&empty);
        assert!(!empty.exists(), "an empty folder is removed");
        // A folder with the owner's work and no `.git` is not ours, so it stays.
        let mine = root.join("mine");
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::write(mine.join("notes.txt"), "keep me").unwrap();
        remove_created_folder(&mine);
        assert!(mine.join("notes.txt").exists(), "the owner's own work is never deleted");
        remove_created_folder(&root.join("never-made"));
        let _ = std::fs::remove_dir_all(root);
    }
}
