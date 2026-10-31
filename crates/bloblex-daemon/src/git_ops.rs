//! Phase 3: review a conversation's changes and act on them — one file's whole diff, staging, and
//! discarding a file's changes with a safety copy.
//!
//! The client names a conversation and a repository path exactly as `session.repository` listed it;
//! the folder always comes from the stored session row. Every git call is an argument list (never a
//! shell) with `--literal-pathspecs`, so a name with glob characters is only ever that name. Nothing
//! here logs a path, file content or git's output. These calls are desktop only (`never` in
//! `tiers.json`) and are not on the Bitbots MCP.
//!
//! `session.git.revert` destroys work, so its order is fixed: confirm, refuse while a bot is working
//! in the folder, require the path to be in the current status list, refuse a link, a folder or a
//! submodule, **keep a safety copy and check it**, and only then discard. A failed copy discards
//! nothing.

use crate::repository::{self, Change};
use crate::{derr, workspace, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// One file's whole diff stops here.
const DIFF_MAX_BYTES: usize = 2 * 1024 * 1024;
const NUMSTAT_MAX_BYTES: usize = 64 * 1024;
/// A file larger than this is never discarded, because it would not be kept.
const COPY_MAX_BYTES: u64 = 20 * 1024 * 1024;
/// How many paths one staging call takes.
const MAX_STAGE_PATHS: usize = 200;
const BINARY_SNIFF_BYTES: usize = 8_000;
const REVERTED_DIR: &str = "reverted";
const REVERTED_KEEP_DAYS: u64 = 7;
const STATUS_LIMIT: usize = 1024 * 1024;

fn invalid(message: &str) -> DispatchError {
    derr("invalid_argument", message, StatusCode::BAD_REQUEST)
}

fn git_failed(message: &str) -> DispatchError {
    derr("internal", message, StatusCode::INTERNAL_SERVER_ERROR)
}

/// The conversation's id and project folder, from the stored row.
fn session_folder(st: &AppState, p: &Value) -> Result<(String, Value, String), DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty())
        .ok_or_else(|| invalid("sessionId is required"))?.to_owned();
    let detail = st.db.session_detail(&session_id).map_err(|_| derr("not_found", "session not found", StatusCode::NOT_FOUND))?;
    let folder = detail["projectPath"].as_str().filter(|path| !path.is_empty()).map(str::to_owned)
        .ok_or_else(|| invalid("This conversation has no project folder."))?;
    Ok((session_id, detail, folder))
}

/// Whether any conversation, this one included, is working in the folder right now.
pub(crate) fn busy_in_folder(st: &AppState, session_id: &str, detail: &Value, folder: &str) -> bool {
    workspace::WORKING.contains(&detail["state"].as_str().unwrap_or("")) || !workspace::shared_with(st, session_id, folder).is_empty()
}

pub(crate) fn busy_error() -> DispatchError {
    derr("conflict", "A bot is working in this folder. Stop it or wait, then try again.", StatusCode::CONFLICT)
}

fn repository_path(p: &Value, key: &str) -> Result<String, DispatchError> {
    p[key].as_str().filter(|path| !path.is_empty() && path.len() <= 4096 && !path.contains('\0')).map(str::to_owned)
        .ok_or_else(|| invalid("repositoryPath is required"))
}

async fn files_of(folder: &str) -> Value {
    repository::working_tree(folder).await["files"].clone()
}

/// With `--literal-pathspecs` a path is only itself, so it needs no `:(literal)` prefix.
fn pathspec(path: &str) -> String {
    path.to_owned()
}

// ── session.git.diff ─────────────────────────────────────────────────────

pub(crate) async fn diff(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let (_, _, folder) = session_folder(st, p)?;
    let path = repository_path(p, "repositoryPath")?;
    let located = repository::locate(&folder).await.map_err(invalid)?;
    let found = located.changes.iter().find(|change| change.repository_path == path && !change.untracked)
        .or_else(|| located.changes.iter().find(|change| change.repository_path == path));
    let Some(change) = found else {
        return Ok(json!({"repositoryPath": path, "previousPath": Value::Null, "change": Value::Null, "diff": Value::Null,
            "truncated": false, "binary": false, "addedLines": Value::Null, "removedLines": Value::Null, "staged": "none"}));
    };
    let label = if located.unborn { if change.change == "deleted" { "deleted" } else { "added" } } else { change.change };
    let synthesised = change.untracked || (located.unborn && label == "added");
    let (diff, truncated, binary, added, removed) = if synthesised {
        synthesise(&located.root, &path)
    } else if located.unborn {
        (None, false, false, None, None)
    } else {
        tracked(&located.root, change).await
    };
    Ok(json!({
        "repositoryPath": change.repository_path,
        "previousPath": change.previous_path,
        "change": label,
        "diff": diff,
        "truncated": truncated,
        "binary": binary,
        "addedLines": added,
        "removedLines": removed,
        "staged": change.staged,
    }))
}

type Whole = (Option<String>, bool, bool, Option<u64>, Option<u64>);

/// The whole patch of a tracked path against `HEAD` and its line counts.
async fn tracked(root: &Path, change: &Change) -> Whole {
    let mut specs = vec![pathspec(&change.repository_path)];
    if let Some(previous) = &change.previous_path { specs.push(pathspec(previous)); }
    let mut stat_args = vec!["--literal-pathspecs", "diff", "HEAD", "-M", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--"];
    stat_args.extend(specs.iter().map(String::as_str));
    let numstat = repository::run_git(root, &stat_args, NUMSTAT_MAX_BYTES).await;
    let (mut added, mut removed, mut binary, mut counted) = (0u64, 0u64, false, false);
    if numstat.ok {
        for stat in repository::parse_numstat(&numstat.stdout).values() {
            counted = true;
            binary |= stat.binary;
            added += stat.added.unwrap_or(0);
            removed += stat.removed.unwrap_or(0);
        }
    }
    if binary { return (None, false, true, None, None); }
    let mut patch_args = vec!["--literal-pathspecs", "diff", "HEAD", "-M", "--no-ext-diff", "--no-textconv", "--"];
    patch_args.extend(specs.iter().map(String::as_str));
    let run = repository::run_git(root, &patch_args, DIFF_MAX_BYTES).await;
    if !run.started || (!run.ok && run.stdout.is_empty() && !run.truncated) { return (None, false, false, None, None); }
    let text = repository::text(&run.stdout);
    let diff = (!text.trim().is_empty()).then_some(text);
    (diff, run.truncated, false, counted.then_some(added), counted.then_some(removed))
}

/// A display patch for a file that exists only in the working tree, with the larger cap. A link,
/// a folder or a path leaving the repository is not read.
fn synthesise(root: &Path, path: &str) -> Whole {
    let none: Whole = (None, false, false, None, None);
    let Some(file_path) = repository::safe_file(root, path) else { return none };
    let Ok(file) = std::fs::File::open(&file_path) else { return none };
    let Ok(metadata) = file.metadata() else { return none };
    let header_room = 4096;
    let take = (DIFF_MAX_BYTES - header_room) as u64;
    let mut buffer = Vec::new();
    if file.take(take).read_to_end(&mut buffer).is_err() { return none; }
    if buffer.iter().take(BINARY_SNIFF_BYTES).any(|byte| *byte == 0) { return (None, false, true, None, None); }
    let truncated = metadata.len() > take;
    if truncated {
        if let Some(cut) = buffer.iter().rposition(|byte| *byte == b'\n') { buffer.truncate(cut + 1); }
    }
    let content = String::from_utf8_lossy(&buffer).into_owned();
    let lines = if content.is_empty() { 0 } else { content.matches('\n').count() as u64 + u64::from(!content.ends_with('\n')) };
    let mut out = format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{lines} @@\n");
    for line in content.split_inclusive('\n') {
        out.push('+');
        out.push_str(line);
        if !line.ends_with('\n') { out.push('\n'); }
    }
    let counts = (!truncated).then_some(lines);
    (Some(out), truncated, false, counts, counts.map(|_| 0))
}

// ── session.git.stage ────────────────────────────────────────────────────

pub(crate) async fn stage(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let (_, _, folder) = session_folder(st, p)?;
    let staged = p["staged"].as_bool().ok_or_else(|| invalid("staged must be true or false."))?;
    let wanted = p["paths"].as_array().filter(|paths| (1..=MAX_STAGE_PATHS).contains(&paths.len()))
        .ok_or_else(|| invalid("Choose between 1 and 200 files."))?;
    let located = repository::locate(&folder).await.map_err(invalid)?;
    let mut paths: Vec<String> = Vec::new();
    for entry in wanted {
        let path = entry.as_str().ok_or_else(|| invalid("That file has no changes."))?;
        let Some(change) = located.changes.iter().find(|change| change.repository_path == path) else {
            return Err(invalid("That file has no changes."));
        };
        for name in [Some(change.repository_path.as_str()), change.previous_path.as_deref()].into_iter().flatten() {
            if !paths.iter().any(|known| known == name) { paths.push(name.to_owned()); }
        }
    }
    let mut args: Vec<&str> = vec!["--literal-pathspecs"];
    if staged { args.extend(["add", "--"]); }
    else if located.unborn { args.extend(["rm", "--cached", "-q", "--"]); }
    else { args.extend(["restore", "--staged", "--"]); }
    args.extend(paths.iter().map(String::as_str));
    let run = repository::run_git(&located.root, &args, STATUS_LIMIT).await;
    if !run.ok { return Err(git_failed("Git couldn't change what is staged.")); }
    Ok(json!({"files": files_of(&folder).await}))
}

// ── session.git.revert and revertUndo ────────────────────────────────────

const LINK_REFUSAL: &str = "Bitbots won't discard a link, a folder or a submodule here. Use git for that.";

/// The size of the file at a repository path (`None` when nothing is there), refusing a link, a
/// folder, or a path that leaves the repository through a linked parent.
fn inspect_leaf(root: &Path, repository_path: &str) -> Result<(PathBuf, Option<u64>), &'static str> {
    let absolute = repository::absolute_path(root, repository_path).filter(|_| !repository_path.is_empty()).ok_or(LINK_REFUSAL)?;
    let canonical_root = std::fs::canonicalize(root).map_err(|_| LINK_REFUSAL)?;
    let mut ancestor = absolute.parent();
    while let Some(folder) = ancestor {
        if std::fs::symlink_metadata(folder).is_ok() {
            let resolved = std::fs::canonicalize(folder).map_err(|_| LINK_REFUSAL)?;
            if !resolved.starts_with(&canonical_root) { return Err(LINK_REFUSAL); }
            break;
        }
        ancestor = folder.parent();
    }
    match std::fs::symlink_metadata(&absolute) {
        Err(_) => Ok((absolute, None)),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => Err(LINK_REFUSAL),
        Ok(meta) => Ok((absolute, Some(meta.len()))),
    }
}

fn reverted_dir(st: &AppState) -> Result<PathBuf, DispatchError> {
    let base = st.team.data_dir.lock().ok().and_then(|dir| dir.clone());
    base.map(|dir| dir.join(REVERTED_DIR)).ok_or_else(|| derr("unavailable", "The folder for kept copies is unavailable.", StatusCode::SERVICE_UNAVAILABLE))
}

/// Keeps a copy of a file and checks it. On any failure nothing is left behind.
fn keep_copy(st: &AppState, session_id: &str, repository_path: &str, source: &Path, length: u64) -> Result<String, DispatchError> {
    let refuse = || git_failed("Bitbots couldn't keep a copy of that file, so it didn't discard it.");
    let undo_id = uuid::Uuid::new_v4().to_string();
    let folder = reverted_dir(st)?.join(&undo_id);
    let outcome = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&folder)?;
        let copied = std::fs::copy(source, folder.join("content"))?;
        if copied != length || std::fs::metadata(folder.join("content"))?.len() != length {
            return Err(std::io::Error::other("short copy"));
        }
        let meta = json!({"sessionId": session_id, "repositoryPath": repository_path, "createdAt": chrono::Utc::now().to_rfc3339()});
        std::fs::write(folder.join("meta.json"), serde_json::to_vec(&meta).unwrap_or_default())
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&folder);
        return Err(refuse());
    }
    Ok(undo_id)
}

pub(crate) async fn revert(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let (session_id, detail, folder) = session_folder(st, p)?;
    let path = repository_path(p, "repositoryPath")?;
    if p["confirm"] != true { return Err(invalid("Confirm discarding this file's changes first.")); }
    if busy_in_folder(st, &session_id, &detail, &folder) { return Err(busy_error()); }
    let located = repository::locate(&folder).await.map_err(invalid)?;
    let change = located.changes.iter().find(|change| change.repository_path == path && !change.untracked)
        .or_else(|| located.changes.iter().find(|change| change.repository_path == path))
        .ok_or_else(|| invalid("That file has no changes."))?;
    if change.special { return Err(invalid(LINK_REFUSAL)); }
    let (absolute, length) = inspect_leaf(&located.root, &path).map_err(invalid)?;
    if let Some(previous) = &change.previous_path { inspect_leaf(&located.root, previous).map_err(invalid)?; }
    if length.is_some_and(|length| length > COPY_MAX_BYTES) {
        return Err(invalid("That file is too large to keep a copy of, so Bitbots won't discard it."));
    }
    // The safety copy comes first; a failed copy returns here and discards nothing.
    let undo_id = match length {
        Some(length) => Some(keep_copy(st, &session_id, &path, &absolute, length)?),
        None => None,
    };
    let root = located.root.as_path();
    let spec = pathspec(&path);
    let restore = |target: String| async move {
        repository::run_git(root, &["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", target.as_str()], STATUS_LIMIT).await.ok
    };
    let drop_index = || async { repository::run_git(root, &["--literal-pathspecs", "rm", "--cached", "-q", "--", spec.as_str()], STATUS_LIMIT).await.ok };
    let done = if change.untracked {
        true
    } else if let Some(previous) = &change.previous_path {
        restore(pathspec(previous)).await && drop_index().await
    } else if change.change == "added" || located.unborn {
        drop_index().await
    } else {
        restore(spec.clone()).await
    };
    let remove_working = change.untracked || change.previous_path.is_some() || change.change == "added" || located.unborn;
    if !done || (remove_working && length.is_some() && std::fs::remove_file(&absolute).is_err()) {
        return Err(git_failed("Git couldn't finish discarding that file."));
    }
    let name = path.rsplit('/').next().unwrap_or(&path).to_owned();
    Ok(json!({"undoId": undo_id, "name": name, "files": files_of(&folder).await}))
}

fn valid_undo_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

pub(crate) async fn revert_undo(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let (session_id, _, folder) = session_folder(st, p)?;
    let missing = || derr("not_found", "That copy is no longer available.", StatusCode::NOT_FOUND);
    let undo_id = p["undoId"].as_str().filter(|id| valid_undo_id(id)).ok_or_else(missing)?;
    let record = reverted_dir(st)?.join(undo_id);
    let meta: Value = std::fs::read(record.join("meta.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).ok_or_else(missing)?;
    if meta["sessionId"].as_str() != Some(session_id.as_str()) { return Err(missing()); }
    let path = meta["repositoryPath"].as_str().filter(|path| !path.is_empty()).ok_or_else(missing)?.to_owned();
    let changed = || derr("conflict", "That file has changed since, so Bitbots won't overwrite it.", StatusCode::CONFLICT);
    let located = repository::locate(&folder).await.map_err(invalid)?;
    if located.changes.iter().any(|change| change.repository_path == path || change.previous_path.as_deref() == Some(path.as_str())) { return Err(changed()); }
    let (absolute, length) = inspect_leaf(&located.root, &path).map_err(|_| changed())?;
    if length.is_some() {
        // A file with no changes is fine to replace only when git tracks it; an ignored or
        // otherwise untracked file there belongs to someone else.
        let tracked = repository::run_git(&located.root, &["--literal-pathspecs", "ls-files", "--error-unmatch", "--", pathspec(&path).as_str()], STATUS_LIMIT).await.ok;
        if !tracked { return Err(changed()); }
    }
    if let Some(parent) = absolute.parent() { std::fs::create_dir_all(parent).map_err(|_| git_failed("Bitbots couldn't put the file back."))?; }
    std::fs::copy(record.join("content"), &absolute).map_err(|_| git_failed("Bitbots couldn't put the file back."))?;
    let _ = std::fs::remove_dir_all(&record);
    Ok(json!({"files": files_of(&folder).await}))
}

/// At startup, removes kept copies older than a week.
pub(crate) fn prune_reverted(st: &AppState) {
    let Ok(base) = reverted_dir(st) else { return };
    prune_older_than(&base, Duration::from_secs(REVERTED_KEEP_DAYS * 24 * 60 * 60));
}

fn prune_older_than(folder: &Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(folder) else { return };
    for entry in entries.flatten() {
        let old = entry.metadata().and_then(|meta| meta.modified()).ok().and_then(|modified| SystemTime::now().duration_since(modified).ok()).is_some_and(|elapsed| elapsed > age);
        if old { let _ = std::fs::remove_dir_all(entry.path()); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phase2a_tests::state;
    use uuid::Uuid;

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = crate::experiments::git_command().arg("-C").arg(dir).args(args).output().unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bloblex-gitops-{tag}-{}", Uuid::new_v4()));
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

    fn commit_all(dir: &Path, message: &str) {
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", message]);
    }

    /// A state with one idle conversation in `dir` and a data folder of its own.
    fn setup(dir: &Path) -> (AppState, PathBuf) {
        let (st, _) = state();
        let data = std::env::temp_dir().join(format!("bloblex-gitops-data-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&data).unwrap();
        *st.team.data_dir.lock().unwrap() = Some(data.clone());
        st.db.create_session("review", "rt-test", "codex", &dir.to_string_lossy(), "Review").unwrap();
        st.db.update_session_state("review", "completed").unwrap();
        (st, data)
    }

    async fn call(st: &AppState, method: &str, p: Value) -> Result<Value, DispatchError> {
        crate::dispatch(st, method, p).await
    }

    fn staged_of(files: &Value, path: &str) -> String {
        files.as_array().unwrap().iter().find(|file| file["repositoryPath"] == path).unwrap()["staged"].as_str().unwrap().to_owned()
    }

    fn listed(files: &Value, path: &str) -> bool {
        files.as_array().unwrap().iter().any(|file| file["repositoryPath"] == path)
    }

    fn copies(data: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(data.join(REVERTED_DIR)).map(|entries| entries.flatten().map(|entry| entry.path()).collect()).unwrap_or_default()
    }

    #[tokio::test]
    async fn staged_state_comes_from_the_status_codes() {
        let dir = repo("staged");
        for name in ["all.txt", "partial.txt", "none.txt"] { write(&dir, name, "one\n"); }
        commit_all(&dir, "init");
        write(&dir, "all.txt", "two\n");
        git(&dir, &["add", "all.txt"]);
        write(&dir, "partial.txt", "two\n");
        git(&dir, &["add", "partial.txt"]);
        write(&dir, "partial.txt", "three\n");
        write(&dir, "none.txt", "two\n");
        write(&dir, "fresh.txt", "new\n");
        let view = repository::working_tree(dir.to_string_lossy().as_ref()).await;
        let files = &view["files"];
        assert_eq!(staged_of(files, "all.txt"), "all");
        assert_eq!(staged_of(files, "partial.txt"), "partial");
        assert_eq!(staged_of(files, "none.txt"), "none");
        assert_eq!(staged_of(files, "fresh.txt"), "none", "an untracked file is not staged");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn whole_diff_goes_past_the_summary_cap() {
        let dir = repo("whole");
        let lines = |tag: &str| (0..20_000).map(|n| format!("{tag} line {n}\n")).collect::<String>();
        write(&dir, "big.txt", &lines("old"));
        commit_all(&dir, "init");
        write(&dir, "big.txt", &lines("new"));
        let untracked = (0..30_000).map(|n| format!("fresh line {n}\n")).collect::<String>();
        write(&dir, "fresh.txt", &untracked);
        let (st, _data) = setup(&dir);
        let summary = call(&st, "session.repository", json!({"sessionId": "review"})).await.unwrap();
        let in_summary = summary["files"].as_array().unwrap().iter().find(|file| file["repositoryPath"] == "big.txt").unwrap();
        assert_eq!(in_summary["truncated"], true, "the summary is capped");
        let whole = call(&st, "session.git.diff", json!({"sessionId": "review", "repositoryPath": "big.txt"})).await.unwrap();
        assert_eq!(whole["truncated"], false);
        assert_eq!(whole["addedLines"], 20_000);
        assert_eq!(whole["change"], "modified");
        assert!(whole["diff"].as_str().unwrap().contains("+new line 19999"));
        let fresh = call(&st, "session.git.diff", json!({"sessionId": "review", "repositoryPath": "fresh.txt"})).await.unwrap();
        assert_eq!(fresh["change"], "added");
        assert!(fresh["diff"].as_str().unwrap().contains("+fresh line 29999"));
        assert_eq!(fresh["addedLines"], 30_000);
        let none = call(&st, "session.git.diff", json!({"sessionId": "review", "repositoryPath": "nothing.txt"})).await.unwrap();
        assert!(none["diff"].is_null());
        assert_eq!(none["truncated"], false);
        assert_eq!(call(&st, "session.git.diff", json!({"sessionId": "absent", "repositoryPath": "a"})).await.unwrap_err().1.code, "not_found");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stage_and_unstage_a_file() {
        let dir = repo("stage");
        write(&dir, "a.txt", "one\n");
        write(&dir, "b.txt", "one\n");
        commit_all(&dir, "init");
        write(&dir, "a.txt", "two\n");
        write(&dir, "b.txt", "two\n");
        write(&dir, "[x].txt", "glob\n");
        let (st, _data) = setup(&dir);
        let staged = call(&st, "session.git.stage", json!({"sessionId": "review", "paths": ["a.txt", "[x].txt"], "staged": true})).await.unwrap();
        assert_eq!(staged_of(&staged["files"], "a.txt"), "all");
        assert_eq!(staged_of(&staged["files"], "[x].txt"), "all", "a glob-looking name is only itself");
        assert_eq!(staged_of(&staged["files"], "b.txt"), "none");
        let unstaged = call(&st, "session.git.stage", json!({"sessionId": "review", "paths": ["a.txt"], "staged": false})).await.unwrap();
        assert_eq!(staged_of(&unstaged["files"], "a.txt"), "none");
        assert_eq!(staged_of(&unstaged["files"], "[x].txt"), "all");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "two\n", "unstaging keeps the working file");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stage_refuses_a_path_with_no_changes() {
        let dir = repo("stage-no");
        write(&dir, "a.txt", "one\n");
        write(&dir, "clean.txt", "one\n");
        commit_all(&dir, "init");
        write(&dir, "a.txt", "two\n");
        let (st, _data) = setup(&dir);
        for paths in [json!(["a.txt", "clean.txt"]), json!(["../a.txt"]), json!([7])] {
            let refused = call(&st, "session.git.stage", json!({"sessionId": "review", "paths": paths, "staged": true})).await.unwrap_err();
            assert_eq!((refused.1.code.as_str(), refused.1.message.as_str()), ("invalid_argument", "That file has no changes."));
        }
        assert_eq!(git(&dir, &["diff", "--cached", "--name-only"]), "", "nothing was applied");
        for paths in [json!([]), Value::Null, json!((0..201).map(|n| format!("f{n}")).collect::<Vec<_>>())] {
            assert_eq!(call(&st, "session.git.stage", json!({"sessionId": "review", "paths": paths, "staged": true})).await.unwrap_err().1.code, "invalid_argument");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stage_works_before_the_first_commit() {
        let dir = repo("stage-unborn");
        write(&dir, "a.txt", "one\n");
        let (st, _data) = setup(&dir);
        let staged = call(&st, "session.git.stage", json!({"sessionId": "review", "paths": ["a.txt"], "staged": true})).await.unwrap();
        assert_eq!(staged_of(&staged["files"], "a.txt"), "all");
        let unstaged = call(&st, "session.git.stage", json!({"sessionId": "review", "paths": ["a.txt"], "staged": false})).await.unwrap();
        assert_eq!(staged_of(&unstaged["files"], "a.txt"), "none");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    fn modified_repo(tag: &str) -> PathBuf {
        let dir = repo(tag);
        write(&dir, "a.txt", "original\n");
        commit_all(&dir, "init");
        write(&dir, "a.txt", "mine\n");
        dir
    }

    #[tokio::test]
    async fn revert_needs_confirm() {
        let dir = modified_repo("confirm");
        let (st, data) = setup(&dir);
        for confirm in [json!(false), json!("true"), Value::Null] {
            let refused = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "a.txt", "confirm": confirm})).await.unwrap_err();
            assert_eq!(refused.1.code, "invalid_argument");
        }
        assert_eq!(call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "a.txt"})).await.unwrap_err().1.code, "invalid_argument");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "mine\n");
        assert!(copies(&data).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn revert_refuses_while_a_bot_is_working_in_the_folder() {
        let dir = modified_repo("busy");
        let (st, data) = setup(&dir);
        let body = json!({"sessionId": "review", "repositoryPath": "a.txt", "confirm": true});
        // Another conversation in the same folder.
        st.db.create_session("other", "rt-test", "codex", &dir.to_string_lossy(), "Other").unwrap();
        st.db.update_session_state("other", "working").unwrap();
        let refused = call(&st, "session.git.revert", body.clone()).await.unwrap_err();
        assert_eq!((refused.1.code.as_str(), refused.1.message.as_str()), ("conflict", "A bot is working in this folder. Stop it or wait, then try again."));
        // This conversation itself.
        st.db.update_session_state("other", "completed").unwrap();
        st.db.update_session_state("review", "working").unwrap();
        assert_eq!(call(&st, "session.git.revert", body.clone()).await.unwrap_err().1.code, "conflict");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "mine\n");
        assert!(copies(&data).is_empty());
        st.db.update_session_state("review", "completed").unwrap();
        call(&st, "session.git.revert", body).await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn revert_restores_a_modified_file_and_keeps_a_copy() {
        let dir = modified_repo("modified");
        git(&dir, &["add", "a.txt"]);
        write(&dir, "a.txt", "mine again\n");
        let (st, data) = setup(&dir);
        let done = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "a.txt", "confirm": true})).await.unwrap();
        assert_eq!(done["name"], "a.txt");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "original\n");
        assert_eq!(git(&dir, &["status", "--porcelain"]), "", "the index and the working file are both back at HEAD");
        assert!(done["files"].as_array().unwrap().is_empty());
        let undo = done["undoId"].as_str().unwrap();
        let kept = data.join(REVERTED_DIR).join(undo);
        assert_eq!(std::fs::read_to_string(kept.join("content")).unwrap(), "mine again\n");
        let meta: Value = serde_json::from_slice(&std::fs::read(kept.join("meta.json")).unwrap()).unwrap();
        assert_eq!(meta["sessionId"], "review");
        assert_eq!(meta["repositoryPath"], "a.txt");
        assert!(meta["createdAt"].is_string());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn revert_deletes_an_untracked_file_and_keeps_a_copy() {
        let dir = modified_repo("untracked");
        write(&dir, "new/fresh.txt", "fresh\n");
        write(&dir, "added.txt", "staged\n");
        git(&dir, &["add", "added.txt"]);
        let (st, data) = setup(&dir);
        let gone = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "new/fresh.txt", "confirm": true})).await.unwrap();
        assert!(!dir.join("new/fresh.txt").exists());
        assert_eq!(gone["name"], "fresh.txt");
        assert_eq!(std::fs::read_to_string(data.join(REVERTED_DIR).join(gone["undoId"].as_str().unwrap()).join("content")).unwrap(), "fresh\n");
        // Added to the index and not in HEAD: leaves the index and the disk.
        let added = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "added.txt", "confirm": true})).await.unwrap();
        assert!(!dir.join("added.txt").exists());
        assert!(!listed(&added["files"], "added.txt"));
        assert_eq!(git(&dir, &["ls-files", "added.txt"]), "");
        // A deleted tracked file has nothing to copy.
        std::fs::remove_file(dir.join("a.txt")).unwrap();
        let restored = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "a.txt", "confirm": true})).await.unwrap();
        assert!(restored["undoId"].is_null());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "original\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn revert_handles_a_rename() {
        let dir = repo("rename");
        write(&dir, "old.txt", "content\nmore\n");
        commit_all(&dir, "init");
        git(&dir, &["mv", "old.txt", "new.txt"]);
        let (st, data) = setup(&dir);
        let done = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "new.txt", "confirm": true})).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("old.txt")).unwrap(), "content\nmore\n");
        assert!(!dir.join("new.txt").exists());
        assert_eq!(git(&dir, &["status", "--porcelain"]), "");
        assert!(done["undoId"].is_string());
        assert_eq!(copies(&data).len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn revert_refuses_a_symlink_and_a_submodule() {
        let dir = repo("special");
        write(&dir, "a.txt", "one\n");
        commit_all(&dir, "init");
        // A link and a gitlink recorded in the index only, so no symlink privilege is needed.
        let blob = {
            let mut child = crate::experiments::git_command().arg("-C").arg(&dir).args(["hash-object", "-w", "--stdin"])
                .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
            std::io::Write::write_all(child.stdin.as_mut().unwrap(), b"a.txt").unwrap();
            String::from_utf8_lossy(&child.wait_with_output().unwrap().stdout).trim().to_owned()
        };
        let head = git(&dir, &["rev-parse", "HEAD"]);
        git(&dir, &["update-index", "--add", "--cacheinfo", &format!("120000,{blob},link")]);
        git(&dir, &["update-index", "--add", "--cacheinfo", &format!("160000,{head},sub")]);
        git(&dir, &["commit", "-q", "-m", "link and submodule"]);
        let (st, data) = setup(&dir);
        for path in ["link", "sub"] {
            let refused = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": path, "confirm": true})).await.unwrap_err();
            assert_eq!(refused.1.code, "invalid_argument", "{path}");
        }
        // A real symlink or folder on disk in the way of a listed path is refused as well.
        write(&dir, "dir/inner.txt", "x\n");
        let refused = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "dir", "confirm": true})).await.unwrap_err();
        assert_eq!(refused.1.code, "invalid_argument");
        assert!(dir.join("dir/inner.txt").exists());
        assert!(copies(&data).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_failed_copy_discards_nothing() {
        let dir = modified_repo("nocopy");
        write(&dir, "fresh.txt", "untracked\n");
        let (st, data) = setup(&dir);
        // The folder for copies cannot be made: a file sits where it should be.
        std::fs::write(data.join(REVERTED_DIR), "in the way").unwrap();
        for path in ["a.txt", "fresh.txt"] {
            let refused = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": path, "confirm": true})).await.unwrap_err();
            assert_eq!(refused.1.message, "Bitbots couldn't keep a copy of that file, so it didn't discard it.");
        }
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "mine\n");
        assert_eq!(std::fs::read_to_string(dir.join("fresh.txt")).unwrap(), "untracked\n");
        assert!(git(&dir, &["status", "--porcelain"]).contains("a.txt"));
        // No data folder at all is the same: nothing discarded.
        *st.team.data_dir.lock().unwrap() = None;
        assert_eq!(call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "a.txt", "confirm": true})).await.unwrap_err().1.code, "unavailable");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "mine\n");
        // A path that is not in the status list never reaches the copy or git.
        let refused = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "../elsewhere.txt", "confirm": true})).await.unwrap_err();
        assert_eq!(refused.1.message, "That file has no changes.");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_file_over_the_copy_limit_is_not_discarded() {
        let dir = repo("large");
        write(&dir, "a.txt", "one\n");
        commit_all(&dir, "init");
        let big = std::fs::File::create(dir.join("big.bin")).unwrap();
        big.set_len(COPY_MAX_BYTES + 1).unwrap();
        drop(big);
        let (st, data) = setup(&dir);
        let refused = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "big.bin", "confirm": true})).await.unwrap_err();
        assert_eq!(refused.1.message, "That file is too large to keep a copy of, so Bitbots won't discard it.");
        assert!(dir.join("big.bin").exists());
        assert!(copies(&data).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn undo_puts_it_back() {
        let dir = modified_repo("undo");
        write(&dir, "fresh.txt", "untracked\n");
        let (st, data) = setup(&dir);
        let reverted = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "a.txt", "confirm": true})).await.unwrap();
        let undo = reverted["undoId"].as_str().unwrap();
        let back = call(&st, "session.git.revertUndo", json!({"sessionId": "review", "undoId": undo})).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "mine\n");
        assert!(listed(&back["files"], "a.txt"));
        assert_eq!(staged_of(&back["files"], "a.txt"), "none", "the staged state is not restored");
        assert!(copies(&data).is_empty(), "the copy is deleted");
        // An untracked file comes back the same way, in a folder that was removed meanwhile.
        let gone = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "fresh.txt", "confirm": true})).await.unwrap();
        call(&st, "session.git.revertUndo", json!({"sessionId": "review", "undoId": gone["undoId"]})).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("fresh.txt")).unwrap(), "untracked\n");
        // A copy is used once.
        assert_eq!(call(&st, "session.git.revertUndo", json!({"sessionId": "review", "undoId": undo})).await.unwrap_err().1.code, "not_found");
        for bad in ["../x", "", "..\\x"] {
            assert_eq!(call(&st, "session.git.revertUndo", json!({"sessionId": "review", "undoId": bad})).await.unwrap_err().1.code, "not_found");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn undo_refuses_when_the_file_changed_since() {
        let dir = modified_repo("undo-changed");
        write(&dir, "fresh.txt", "untracked\n");
        let (st, data) = setup(&dir);
        let first = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "a.txt", "confirm": true})).await.unwrap();
        write(&dir, "a.txt", "edited since\n");
        let refused = call(&st, "session.git.revertUndo", json!({"sessionId": "review", "undoId": first["undoId"]})).await.unwrap_err();
        assert_eq!((refused.1.code.as_str(), refused.1.message.as_str()), ("conflict", "That file has changed since, so Bitbots won't overwrite it."));
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "edited since\n");
        assert_eq!(copies(&data).len(), 1, "the copy is kept after a refusal");
        // An untracked file recreated since is also not overwritten.
        let second = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "fresh.txt", "confirm": true})).await.unwrap();
        write(&dir, "fresh.txt", "someone else\n");
        assert_eq!(call(&st, "session.git.revertUndo", json!({"sessionId": "review", "undoId": second["undoId"]})).await.unwrap_err().1.code, "conflict");
        assert_eq!(std::fs::read_to_string(dir.join("fresh.txt")).unwrap(), "someone else\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn undo_refuses_another_conversations_record() {
        let dir = modified_repo("undo-other");
        let (st, data) = setup(&dir);
        st.db.create_session("second", "rt-test", "codex", &dir.to_string_lossy(), "Second").unwrap();
        st.db.update_session_state("second", "completed").unwrap();
        let reverted = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "a.txt", "confirm": true})).await.unwrap();
        let refused = call(&st, "session.git.revertUndo", json!({"sessionId": "second", "undoId": reverted["undoId"]})).await.unwrap_err();
        assert_eq!(refused.1.code, "not_found");
        assert_eq!(copies(&data).len(), 1);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "original\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn old_copies_are_removed_at_startup() {
        let dir = modified_repo("prune");
        let (st, data) = setup(&dir);
        let reverted = call(&st, "session.git.revert", json!({"sessionId": "review", "repositoryPath": "a.txt", "confirm": true})).await.unwrap();
        // Startup keeps a fresh copy.
        prune_reverted(&st);
        assert_eq!(copies(&data).len(), 1);
        // Anything older than the age goes; nothing is older than a week yet, so use the helper.
        prune_older_than(&data.join(REVERTED_DIR), Duration::from_secs(24 * 60 * 60));
        assert_eq!(copies(&data).len(), 1);
        std::thread::sleep(Duration::from_millis(30));
        prune_older_than(&data.join(REVERTED_DIR), Duration::from_millis(1));
        assert!(copies(&data).is_empty());
        assert_eq!(call(&st, "session.git.revertUndo", json!({"sessionId": "review", "undoId": reverted["undoId"]})).await.unwrap_err().1.code, "not_found");
        let _ = std::fs::remove_dir_all(dir);
    }
}
