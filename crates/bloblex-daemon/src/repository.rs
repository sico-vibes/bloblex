//! `session.repository`: what the conversation's project folder changes
//! against its `HEAD`.
//!
//! The view is the repository's own current state — index and working tree
//! together, untracked files included — and never a claim about which bot wrote
//! what. It is read-only: every git call is an argument list (never a shell),
//! runs with `--no-optional-locks` so not even the index is refreshed, refuses
//! external diff drivers and textconv, is bounded in time and bytes, and its
//! output is never logged. The client names only a conversation; the folder
//! always comes from the session row.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// The longest one git call may take.
const GIT_TIMEOUT: Duration = Duration::from_secs(15);
/// Caps for the one-call outputs; a truncated status still lists what it read.
const TOPLEVEL_MAX_BYTES: usize = 8 * 1024;
const STATUS_MAX_BYTES: usize = 2 * 1024 * 1024;
const NUMSTAT_MAX_BYTES: usize = 1024 * 1024;
/// Per-file and whole-answer diff limits.
const PATCH_MAX_BYTES: usize = 96 * 1024;
const PATCH_POOL_BYTES: usize = 512 * 1024;
/// How many changed files are listed and how many carry a diff.
const MAX_FILES: usize = 200;
const MAX_PATCH_FILES: usize = 24;
/// An untracked file is read only up to this size and line count.
const UNTRACKED_MAX_BYTES: u64 = 256 * 1024;
const UNTRACKED_MAX_LINES: u64 = 20_000;
/// A NUL byte in the first bytes is git's own binary heuristic.
const BINARY_SNIFF_BYTES: usize = 8_000;

/// `session.repository`: the conversation's folder against its `HEAD`.
pub(crate) async fn session_repository(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty())
        .ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    let detail = st.db.session_detail(session_id).map_err(|_| derr("not_found", "session not found", StatusCode::NOT_FOUND))?;
    let Some(project_path) = detail["projectPath"].as_str().filter(|path| !path.is_empty()).map(str::to_owned) else {
        return Ok(empty_answer(None, "This conversation has no project folder."));
    };
    Ok(working_tree(&project_path).await)
}

/// The answered contract for a folder: repository changes against `HEAD`.
pub(crate) async fn working_tree(project_path: &str) -> Value {
    let folder = PathBuf::from(project_path);
    if !folder.is_dir() { return empty_answer(Some(project_path.to_owned()), "The project folder is missing."); }
    let top = run_git(&folder, &["rev-parse", "--show-toplevel"], TOPLEVEL_MAX_BYTES).await;
    if !top.started { return empty_answer(Some(project_path.to_owned()), "Git is not available on this computer."); }
    let root_text = text(&top.stdout);
    let root = PathBuf::from(root_text.trim());
    if !top.ok || root_text.trim().is_empty() || !root.is_dir() {
        return empty_answer(Some(project_path.to_owned()), "This project is not a git repository.");
    }
    let branch_run = run_git(&root, &["symbolic-ref", "--short", "-q", "HEAD"], TOPLEVEL_MAX_BYTES).await;
    let branch = (branch_run.ok).then(|| text(&branch_run.stdout).trim().to_owned()).filter(|name| !name.is_empty());
    let detached = branch.is_none();
    let unborn = !run_git(&root, &["rev-parse", "--verify", "-q", "HEAD"], TOPLEVEL_MAX_BYTES).await.ok;
    let status = run_git(&root, &["status", "--porcelain=v2", "-z", "--untracked-files=all", "--renames"], STATUS_MAX_BYTES).await;
    if !status.started || (!status.ok && status.stdout.is_empty()) {
        return repo_answer(project_path, &root, branch, detached, Vec::new(), (0, 0), false, Some("The repository's changes could not be read."));
    }
    let changes = parse_status(&status.stdout);
    let mut stats = HashMap::new();
    let mut stats_truncated = false;
    if !unborn {
        let numstat = run_git(&root, &["diff", "HEAD", "-M", "--numstat", "-z", "--no-ext-diff", "--no-textconv"], NUMSTAT_MAX_BYTES).await;
        if numstat.ok { stats = parse_numstat(&numstat.stdout); stats_truncated = numstat.truncated; }
    }
    let mut files = Vec::new();
    let mut pool = PATCH_POOL_BYTES;
    let (mut total_added, mut total_removed) = (0u64, 0u64);
    let mut answer_truncated = status.truncated || stats_truncated || changes.len() > MAX_FILES;
    let mut patches = 0usize;
    for change in changes.iter().take(MAX_FILES) {
        let added_label = if unborn { change.change != "deleted" } else { change.change == "added" };
        let label = if unborn { if change.change == "deleted" { "deleted" } else { "added" } } else { change.change };
        let mut added: Option<u64> = None;
        let mut removed: Option<u64> = None;
        let mut binary = false;
        let mut built = None;
        if change.untracked || (unborn && added_label) {
            let read = untracked_file(&root, &change.repository_path, &mut pool);
            added = read.added;
            removed = read.removed;
            binary = read.binary;
            built = Some((read.diff, read.truncated));
        } else {
            let mut found = false;
            let mut sum_added = 0u64;
            let mut sum_removed = 0u64;
            for key in [Some(change.repository_path.as_str()), change.previous_path.as_deref()].into_iter().flatten() {
                if let Some(stat) = stats.remove(key) {
                    found = true;
                    binary |= stat.binary;
                    sum_added += stat.added.unwrap_or(0);
                    sum_removed += stat.removed.unwrap_or(0);
                }
            }
            if found && !binary { added = Some(sum_added); removed = Some(sum_removed); }
            // A pure rename has no content of its own to show.
            let pure_rename = change.change == "renamed" && found && sum_added == 0 && sum_removed == 0;
            if !binary && !pure_rename {
                if patches >= MAX_PATCH_FILES || pool == 0 {
                    answer_truncated = true;
                } else {
                    patches += 1;
                    let patch = tracked_patch(&root, &change.repository_path, &mut pool).await;
                    answer_truncated |= patch.truncated;
                    built = Some((patch.diff, patch.truncated));
                }
            }
        }
        let (diff, file_truncated) = built.unwrap_or((None, false));
        answer_truncated |= file_truncated;
        total_added += added.unwrap_or(0);
        total_removed += removed.unwrap_or(0);
        files.push(json!({
            "path": absolute(&root, &change.repository_path),
            "repositoryPath": change.repository_path,
            "change": label,
            "addedLines": added,
            "removedLines": removed,
            "diff": diff,
            "binary": binary,
            "truncated": file_truncated,
        }));
    }
    repo_answer(project_path, &root, branch, detached, files, (total_added, total_removed), answer_truncated, None)
}

#[allow(clippy::too_many_arguments)]
fn repo_answer(project_path: &str, root: &Path, branch: Option<String>, detached: bool, files: Vec<Value>, totals: (u64, u64), truncated: bool, error: Option<&str>) -> Value {
    json!({
        "projectPath": project_path,
        "repoRoot": display_path(root),
        "gitRepo": true,
        "branch": branch,
        "detached": detached,
        "files": files,
        "addedLines": totals.0,
        "removedLines": totals.1,
        "truncated": truncated,
        "error": error,
    })
}

fn empty_answer(project_path: Option<String>, error: &str) -> Value {
    json!({
        "projectPath": project_path,
        "repoRoot": Value::Null,
        "gitRepo": false,
        "branch": Value::Null,
        "detached": false,
        "files": [],
        "addedLines": 0,
        "removedLines": 0,
        "truncated": false,
        "error": error,
    })
}

struct GitRun {
    stdout: Vec<u8>,
    truncated: bool,
    ok: bool,
    started: bool,
}

/// One `git --no-optional-locks -C <dir> <args...>` run without a shell, with a
/// hard time limit and a stdout cap, reading no stderr at all. Environment
/// overrides are removed so an inherited one cannot point git elsewhere, and
/// `GIT_TERMINAL_PROMPT=0` makes a missing credential answer instead of waiting.
async fn run_git(dir: &Path, args: &[&str], max_bytes: usize) -> GitRun {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("--no-optional-locks").arg("-C").arg(dir).args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY").env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_NAMESPACE").env_remove("GIT_EXTERNAL_DIFF").env_remove("GIT_PAGER")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    { command.creation_flags(0x0800_0000); }
    let Ok(mut child) = command.spawn() else {
        return GitRun { stdout: Vec::new(), truncated: false, ok: false, started: false };
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return GitRun { stdout: Vec::new(), truncated: false, ok: false, started: true };
    };
    let mut buffer = Vec::new();
    match tokio::time::timeout(GIT_TIMEOUT, (&mut stdout).take(max_bytes as u64 + 1).read_to_end(&mut buffer)).await {
        Ok(Ok(_)) if buffer.len() > max_bytes => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            GitRun { stdout: buffer[..max_bytes].to_vec(), truncated: true, ok: false, started: true }
        }
        Ok(Ok(_)) => match tokio::time::timeout(GIT_TIMEOUT, child.wait()).await {
            Ok(Ok(status)) => GitRun { stdout: buffer, truncated: false, ok: status.success(), started: true },
            _ => {
                let _ = child.kill().await;
                GitRun { stdout: Vec::new(), truncated: false, ok: false, started: true }
            }
        },
        _ => {
            let _ = child.kill().await;
            GitRun { stdout: Vec::new(), truncated: false, ok: false, started: true }
        }
    }
}

struct Patch {
    diff: Option<String>,
    truncated: bool,
}

/// The patch of one tracked path against `HEAD`, cut at the remaining budget.
async fn tracked_patch(root: &Path, repository_path: &str, pool: &mut usize) -> Patch {
    let literal = format!(":(literal){repository_path}");
    let limit = PATCH_MAX_BYTES.min(*pool);
    let run = run_git(root, &["diff", "HEAD", "-M", "--no-ext-diff", "--no-textconv", "--", literal.as_str()], limit).await;
    if !run.started || (!run.ok && run.stdout.is_empty() && !run.truncated) {
        return Patch { diff: None, truncated: false };
    }
    *pool = pool.saturating_sub(run.stdout.len());
    let out = text(&run.stdout);
    let diff = (!out.trim().is_empty()).then_some(out);
    Patch { diff, truncated: run.truncated }
}

struct Untracked {
    diff: Option<String>,
    added: Option<u64>,
    removed: Option<u64>,
    binary: bool,
    truncated: bool,
}

/// Read one untracked file inside the repository and describe it as an added
/// file. A symlink, a folder, or a path that would leave the repository is not
/// read; a file over the cap is reported as truncated instead.
fn untracked_file(root: &Path, repository_path: &str, pool: &mut usize) -> Untracked {
    let none = Untracked { diff: None, added: None, removed: None, binary: false, truncated: false };
    let Some(path) = safe_file(root, repository_path) else { return none };
    let Ok(file) = std::fs::File::open(&path) else { return none };
    let Ok(metadata) = file.metadata() else { return none };
    let truncated = metadata.len() > UNTRACKED_MAX_BYTES;
    let mut buffer = Vec::new();
    if file.take(UNTRACKED_MAX_BYTES).read_to_end(&mut buffer).is_err() { return none; }
    if buffer.iter().take(BINARY_SNIFF_BYTES).any(|byte| *byte == 0) {
        return Untracked { diff: None, added: None, removed: None, binary: true, truncated: false };
    }
    let content = String::from_utf8_lossy(&buffer).into_owned();
    let lines = if content.is_empty() { 0 } else { content.matches('\n').count() as u64 + u64::from(!content.ends_with('\n')) };
    if truncated || lines > UNTRACKED_MAX_LINES {
        return Untracked { diff: None, added: None, removed: None, binary: false, truncated: true };
    }
    Untracked { diff: added_file_diff(repository_path, &content, lines, pool), added: Some(lines), removed: Some(0), binary: false, truncated: false }
}

/// A display patch for a file that exists only in the working tree. It is not
/// git's own patch (there is no blob to compare against), so it carries no
/// index line; the content and the line count are exact.
fn added_file_diff(repository_path: &str, content: &str, lines: u64, pool: &mut usize) -> Option<String> {
    if *pool == 0 { return None; }
    let header = format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{lines} @@\n", path = repository_path);
    let max = PATCH_MAX_BYTES.min(*pool);
    let mut out = header;
    for line in content.split_inclusive('\n') {
        if out.len() + line.len() + 2 > max { break; }
        out.push('+');
        out.push_str(line);
        if !line.ends_with('\n') { out.push('\n'); }
    }
    *pool = pool.saturating_sub(out.len());
    Some(out)
}

/// Resolve one repository-relative path to a regular file inside the
/// repository. Parent components, absolute or drive-qualified parts, symlinks
/// and anything outside the repository root are refused so no ignored secret or
/// linked file outside the project is ever read.
fn safe_file(root: &Path, repository_path: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for part in repository_path.split('/') {
        if part.is_empty() || part == "." { continue; }
        if part == ".." || part.contains(':') || part.contains('\\') { return None; }
        path.push(part);
    }
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() { return None; }
    let root = std::fs::canonicalize(root).ok()?;
    let canonical = std::fs::canonicalize(&path).ok()?;
    canonical.starts_with(&root).then_some(path)
}

fn absolute(root: &Path, repository_path: &str) -> String {
    absolute_path(root, repository_path).map(|path| display_path(&path)).unwrap_or_else(|| display_path(root))
}

fn absolute_path(root: &Path, repository_path: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for part in repository_path.split('/') {
        if part.is_empty() || part == "." { continue; }
        if part == ".." || part.contains(':') || part.contains('\\') { return None; }
        path.push(part);
    }
    Some(path)
}

fn display_path(path: &Path) -> String {
    #[cfg(windows)]
    { path.to_string_lossy().replace('/', "\\") }
    #[cfg(not(windows))]
    { path.to_string_lossy().into_owned() }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

struct Change {
    repository_path: String,
    /// The original path of a rename, for folding its old-side counts in.
    previous_path: Option<String>,
    change: &'static str,
    untracked: bool,
}

/// `git status --porcelain=v2 -z` records. With `-z` every record is NUL
/// terminated and a rename is followed by its original path as its own field,
/// so spaces and unicode in names need no unquoting.
fn parse_status(stdout: &[u8]) -> Vec<Change> {
    let raw = text(stdout);
    let mut fields = raw.split('\0');
    let mut changes = Vec::new();
    while let Some(record) = fields.next() {
        if record.is_empty() { continue; }
        match record.chars().next() {
            Some('1') => {
                let parts: Vec<&str> = record.splitn(9, ' ').collect();
                if parts.len() == 9 {
                    changes.push(Change { repository_path: parts[8].to_owned(), previous_path: None, change: change_kind(parts[1]), untracked: false });
                }
            }
            Some('2') => {
                let parts: Vec<&str> = record.splitn(10, ' ').collect();
                if parts.len() == 10 {
                    let previous = fields.next().unwrap_or("");
                    changes.push(Change {
                        repository_path: parts[9].to_owned(),
                        previous_path: (!previous.is_empty()).then(|| previous.to_owned()),
                        change: "renamed",
                        untracked: false,
                    });
                }
            }
            Some('u') => {
                let parts: Vec<&str> = record.splitn(11, ' ').collect();
                if parts.len() == 11 {
                    changes.push(Change { repository_path: parts[10].to_owned(), previous_path: None, change: "modified", untracked: false });
                }
            }
            Some('?') => {
                if let Some(path) = record.strip_prefix("? ") {
                    changes.push(Change { repository_path: path.to_owned(), previous_path: None, change: "added", untracked: true });
                }
            }
            _ => {}
        }
    }
    changes
}

fn change_kind(xy: &str) -> &'static str {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') { return "renamed"; }
    if x == 'D' || y == 'D' { return "deleted"; }
    if x == 'A' || y == 'A' || x == '?' { return "added"; }
    "modified"
}

#[derive(Default, Clone, Copy)]
struct Stat {
    added: Option<u64>,
    removed: Option<u64>,
    binary: bool,
}

/// `git diff HEAD -M --numstat -z`: one record per tracked path, with a rename
/// as `added\tremoved\t` followed by the old and new paths as NUL fields.
fn parse_numstat(stdout: &[u8]) -> HashMap<String, Stat> {
    let raw = text(stdout);
    let mut fields = raw.split('\0');
    let mut stats = HashMap::new();
    while let Some(record) = fields.next() {
        if record.is_empty() { continue; }
        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let stat = Stat { added: added.parse().ok(), removed: removed.parse().ok(), binary: added == "-" && removed == "-" };
        if path.is_empty() {
            let old = fields.next().unwrap_or("");
            let new = fields.next().unwrap_or("");
            if !old.is_empty() { stats.insert(old.to_owned(), stat); }
            if !new.is_empty() { stats.insert(new.to_owned(), stat); }
        } else {
            stats.insert(path.to_owned(), stat);
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = crate::experiments::git_command().arg("-C").arg(dir).args(args).output().unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bloblex-repository-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "core.autocrlf", "false"]);
        dir
    }

    fn write(dir: &Path, name: &str, content: &str) {
        let path = dir.join(name);
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).unwrap(); }
        std::fs::write(path, content).unwrap();
    }

    fn file<'a>(view: &'a Value, repository_path: &str) -> &'a Value {
        view["files"].as_array().unwrap().iter().find(|file| file["repositoryPath"] == repository_path)
            .unwrap_or_else(|| panic!("{repository_path} in {}", view["files"]))
    }

    async fn view(dir: &Path) -> Value {
        working_tree(dir.to_string_lossy().as_ref()).await
    }

    #[tokio::test]
    async fn branch_totals_and_every_change_kind_against_head() {
        let dir = repo("kinds");
        write(&dir, "a.txt", "line1\nline2\nline3\n");
        write(&dir, "old.txt", "gone\nnow\n");
        write(&dir, "keep.txt", "keep\n");
        std::fs::write(dir.join("bin.dat"), [0u8, 1, 2, 3, 0, 255, 10, 13]).unwrap();
        write(&dir, ".gitignore", "secret.txt\n");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "initial"]);
        // Staged and unstaged in one file: the diff is against HEAD, once.
        write(&dir, "a.txt", "line1\nline2 changed\nline3\n");
        git(&dir, &["add", "a.txt"]);
        write(&dir, "a.txt", "line1\nline2 changed again\nline3\nline4\n");
        // Deleted, renamed, binary, untracked (spaces and unicode), ignored.
        std::fs::remove_file(dir.join("old.txt")).unwrap();
        git(&dir, &["mv", "keep.txt", "kept.txt"]);
        std::fs::write(dir.join("bin.dat"), [0u8, 1, 2, 3, 4, 0, 255, 10, 13]).unwrap();
        write(&dir, "n e w-ünïcode.txt", "new one\nnew two\n");
        write(&dir, "secret.txt", "ignored\n");
        let before = git(&dir, &["status", "--porcelain"]);
        let view = view(&dir).await;
        assert_eq!(git(&dir, &["status", "--porcelain"]), before, "reading is read-only");
        assert!(!dir.join(".git").join("index.lock").exists());
        assert_eq!(view["gitRepo"], true);
        assert_eq!(view["branch"], "main");
        assert_eq!(view["detached"], false);
        assert_eq!(view["repoRoot"], display_path(&dir));
        assert!(view["error"].is_null());
        // Staged plus unstaged is counted once, against HEAD: +2 −1 for a.txt.
        let a = file(&view, "a.txt");
        assert_eq!(a["change"], "modified");
        assert_eq!(a["addedLines"], 2);
        assert_eq!(a["removedLines"], 1);
        assert!(a["diff"].as_str().unwrap().contains("+line4"));
        assert_eq!(a["path"], display_path(&dir.join("a.txt")));
        let deleted = file(&view, "old.txt");
        assert_eq!(deleted["change"], "deleted");
        assert_eq!(deleted["addedLines"], 0);
        assert_eq!(deleted["removedLines"], 2);
        let renamed = file(&view, "kept.txt");
        assert_eq!(renamed["change"], "renamed");
        assert_eq!(renamed["addedLines"], 0);
        assert_eq!(renamed["removedLines"], 0);
        let binary = file(&view, "bin.dat");
        assert_eq!(binary["binary"], true);
        assert!(binary["addedLines"].is_null() && binary["diff"].is_null());
        let added = file(&view, "n e w-ünïcode.txt");
        assert_eq!(added["change"], "added");
        assert_eq!(added["addedLines"], 2);
        assert_eq!(added["removedLines"], 0);
        assert!(added["diff"].as_str().unwrap().contains("+new two"));
        assert!(view["files"].as_array().unwrap().iter().all(|entry| entry["repositoryPath"] != "secret.txt"), "an ignored file is not read");
        assert_eq!(view["addedLines"], 4);
        assert_eq!(view["removedLines"], 3);
        assert_eq!(view["truncated"], false);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn staged_and_unstaged_edits_are_not_double_counted() {
        let dir = repo("once");
        write(&dir, "a.txt", "v1\n");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "one"]);
        write(&dir, "a.txt", "v2\n");
        git(&dir, &["add", "a.txt"]);
        write(&dir, "a.txt", "v3\n");
        let view = view(&dir).await;
        let a = file(&view, "a.txt");
        assert_eq!(a["addedLines"], 1);
        assert_eq!(a["removedLines"], 1);
        assert_eq!(view["addedLines"], 1);
        assert_eq!(view["removedLines"], 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_unborn_repository_lists_every_file_as_added() {
        let dir = repo("unborn");
        write(&dir, "one.txt", "one\ntwo\n");
        write(&dir, "staged.txt", "three\n");
        git(&dir, &["add", "staged.txt"]);
        let view = view(&dir).await;
        assert_eq!(view["gitRepo"], true);
        assert_eq!(view["branch"], "main");
        assert_eq!(file(&view, "one.txt")["change"], "added");
        assert_eq!(file(&view, "one.txt")["addedLines"], 2);
        assert_eq!(file(&view, "staged.txt")["addedLines"], 1);
        assert_eq!(view["addedLines"], 3);
        assert!(view["error"].is_null());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_detached_head_has_no_branch_and_a_nested_folder_uses_the_repository_root() {
        let dir = repo("detached");
        write(&dir, "a.txt", "one\n");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "one"]);
        git(&dir, &["checkout", "-q", "--detach", "HEAD"]);
        let root_view = view(&dir).await;
        assert_eq!(root_view["detached"], true);
        assert!(root_view["branch"].is_null());
        std::fs::create_dir_all(dir.join("src")).unwrap();
        write(&dir, "src/nested.txt", "nested\n");
        let nested = view(&dir.join("src")).await;
        assert_eq!(nested["repoRoot"], display_path(&dir), "a project folder inside the repo reports the repository root");
        assert_eq!(file(&nested, "src/nested.txt")["addedLines"], 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn missing_git_and_missing_folders_are_safe_answers() {
        let dir = repo("safe");
        let plain = std::env::temp_dir().join(format!("bloblex-not-a-repo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&plain).unwrap();
        let outside = view(&plain).await;
        assert_eq!(outside["gitRepo"], false);
        assert_eq!(outside["error"], "This project is not a git repository.");
        assert!(outside["files"].as_array().unwrap().is_empty());
        let missing = view(&dir.join("gone")).await;
        assert_eq!(missing["gitRepo"], false);
        assert_eq!(missing["error"], "The project folder is missing.");
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(plain);
    }

    #[tokio::test]
    async fn the_change_set_and_each_diff_are_bounded() {
        let dir = repo("bounded");
        write(&dir, "seed.txt", "seed\n");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "seed"]);
        for index in 0..(MAX_FILES + 5) {
            write(&dir, &format!("many/file-{index}.txt"), "one line\n");
        }
        let big = "x".repeat(UNTRACKED_MAX_BYTES as usize + 1024);
        write(&dir, "big.txt", &big);
        let view = view(&dir).await;
        assert_eq!(view["files"].as_array().unwrap().len(), MAX_FILES);
        assert_eq!(view["truncated"], true, "more files than the cap is reported");
        let big = file(&view, "big.txt");
        assert_eq!(big["truncated"], true);
        assert!(big["addedLines"].is_null() && big["diff"].is_null());
        let _ = std::fs::remove_dir_all(dir);
    }
}
