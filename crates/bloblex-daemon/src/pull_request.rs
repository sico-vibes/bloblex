//! Phase 3: open a pull request for the conversation's branch.
//!
//! `session.pr.draft` reads the repository and says whether a pull request can be opened, with a
//! proposed title and body built from the commits only (never from conversation text).
//! `session.pr.create` then runs up to three steps, each reported like `project.scaffold`'s: commit
//! (only when asked), push, and `gh pr create` with the body on stdin.
//!
//! Safety rules: the push is of the conversation's own branch to `origin` and never forced, the
//! base branch is never pushed, no step runs through a shell, `git` and `gh` use their own stored
//! sign-in (this code never reads, passes or prints a credential), the remote's address is never
//! returned or logged, and no message text from the conversation is used. Desktop only: `never` in
//! `tiers.json`, not on the Bitbots MCP.

use crate::repository::{self, run_git, text};
use crate::scaffold::{self, Ran};
use crate::{derr, git_ops, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

const READ_LIMIT: usize = 1024 * 1024;
const VIEW_LIMIT: Duration = Duration::from_secs(10);
const PUSH_LIMIT: Duration = Duration::from_secs(300);
const CREATE_LIMIT: Duration = Duration::from_secs(120);
const MAX_TITLE: usize = 256;
const MAX_BODY: usize = 60_000;
const MAX_BASE: usize = 200;
const MAX_COMMIT_MESSAGE: usize = 10_000;
const DRAFT_TITLE_CHARS: usize = 72;
const MAX_SUBJECTS: usize = 20;
/// Git's well-known empty tree, the base for a branch whose first commit is a root commit.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn invalid(message: &str) -> DispatchError {
    derr("invalid_argument", message, StatusCode::BAD_REQUEST)
}

/// Everything the draft and the create call need to know about the conversation's repository.
struct Facts {
    reason: Option<String>,
    gh: Value,
    root: Option<PathBuf>,
    branch: Option<String>,
    base: Option<String>,
    /// The repository's own default branch as far as git, the task copy's link or GitHub say,
    /// whatever base the caller named. A pull request never comes from it.
    discovered_base: Option<String>,
    is_worktree: bool,
    has_origin: bool,
    commits_ahead: u64,
    uncommitted: u64,
    /// The range of commits this branch adds: `<base>..HEAD`, or `HEAD --not --remotes` (less the
    /// branch's own remote copy) when no base ref exists locally; the default branch itself is
    /// refused earlier, so that fallback only ever describes a feature branch.
    range: Vec<String>,
    /// The base ref the range and the diff compare against, when one exists.
    base_ref: Option<String>,
}

async fn verifies(root: &Path, reference: &str) -> bool {
    run_git(root, &["rev-parse", "--verify", "-q", &format!("{reference}^{{commit}}")], 4096).await.ok
}

async fn read(root: &Path, args: &[&str]) -> Option<String> {
    let run = run_git(root, args, READ_LIMIT).await;
    run.ok.then(|| text(&run.stdout))
}

async fn gather(detail: &Value, folder: &str, base_override: Option<&str>) -> Facts {
    let gh = scaffold::gh_status().await;
    let mut facts = Facts { reason: None, gh, root: None, branch: None, base: None, discovered_base: None, is_worktree: false, has_origin: false, commits_ahead: 0, uncommitted: 0, range: Vec::new(), base_ref: None };
    let folder_path = PathBuf::from(folder);
    let root = if folder_path.is_dir() {
        read(&folder_path, &["rev-parse", "--show-toplevel"]).await.map(|out| PathBuf::from(out.trim())).filter(|root| root.is_dir())
    } else { None };
    let Some(root) = root else {
        facts.reason = Some("This conversation isn't in a git repository.".to_owned());
        return facts;
    };
    facts.branch = read(&root, &["symbolic-ref", "--short", "-q", "HEAD"]).await.map(|out| out.trim().to_owned()).filter(|name| !name.is_empty());
    let link_worktree = &detail["link"]["worktree"];
    facts.is_worktree = link_worktree["path"].as_str().is_some_and(|path| !path.is_empty() && crate::worktree::normalize(Path::new(path)) == crate::worktree::normalize(&folder_path));
    let mut discovered = link_worktree["base"].as_str().map(str::trim).filter(|base| !base.is_empty()).map(str::to_owned);
    if discovered.is_none() {
        let head = read(&root, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]).await;
        discovered = head.map(|out| out.trim().trim_start_matches("origin/").to_owned()).filter(|base| !base.is_empty());
    }
    if discovered.is_none() && facts.gh["available"] == true && !facts.gh["login"].is_null() {
        let args = ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"];
        let ran = scaffold::run(&scaffold::gh_program(), Some(&root), &args, None, VIEW_LIMIT).await;
        discovered = ran.ok.then(|| ran.stdout.trim().to_owned()).filter(|name| valid_base(name));
    }
    facts.base = base_override.map(str::to_owned).or_else(|| discovered.clone());
    facts.discovered_base = discovered;
    facts.has_origin = read(&root, &["remote"]).await.is_some_and(|out| out.lines().any(|line| line.trim() == "origin"));
    facts.uncommitted = read(&root, &["status", "--porcelain=v2", "-z", "--untracked-files=all"]).await
        .map_or(0, |out| repository::parse_status(out.as_bytes()).len() as u64);
    let has_head = verifies(&root, "HEAD").await;
    if has_head {
        if let Some(base) = &facts.base {
            for candidate in [format!("origin/{base}"), base.clone()] {
                if verifies(&root, &candidate).await { facts.base_ref = Some(candidate); break; }
            }
        }
        facts.range = match &facts.base_ref {
            Some(reference) => vec![format!("{reference}..HEAD")],
            // The branch's own remote copy is not a base: after a push whose pull request failed,
            // the commits still count, so the owner can try again.
            None => {
                let mut range = vec!["HEAD".to_owned(), "--not".to_owned()];
                if let Some(branch) = &facts.branch { range.push(format!("--exclude=origin/{branch}")); }
                range.push("--remotes".to_owned());
                range
            }
        };
        let mut args = vec!["rev-list", "--count"];
        args.extend(facts.range.iter().map(String::as_str));
        facts.commits_ahead = read(&root, &args).await.and_then(|out| out.trim().parse().ok()).unwrap_or(0);
    }
    facts.reason = first_reason(&facts);
    facts.root = Some(root);
    facts
}

fn first_reason(facts: &Facts) -> Option<String> {
    let Some(branch) = &facts.branch else { return Some("This conversation is on a detached commit.".to_owned()) };
    // Never the base, never the repository's default branch, and when no default is known, never
    // a branch with a name that usually is one.
    let is_default = facts.base.as_deref() == Some(branch.as_str())
        || match &facts.discovered_base {
            Some(default) => default == branch,
            None => ["main", "master", "trunk", "develop"].contains(&branch.as_str()),
        };
    if is_default {
        return Some(format!("Pull requests need their own branch. This conversation is on `{branch}`."));
    }
    if !facts.has_origin { return Some("This repository has no `origin` remote.".to_owned()); }
    if facts.gh["available"] != true { return Some("The GitHub CLI isn't installed.".to_owned()); }
    if facts.gh["login"].is_null() { return Some("The GitHub CLI isn't signed in.".to_owned()); }
    if facts.commits_ahead == 0 && facts.uncommitted == 0 { return Some("There's nothing to propose yet.".to_owned()); }
    None
}

fn cap_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// A proposed title and body from the commits. No conversation text goes in the body.
async fn propose(detail: &Value, facts: &Facts) -> (String, String) {
    let conversation_title = detail["title"].as_str().map(str::trim).filter(|title| !title.is_empty()).unwrap_or("Changes from Bitbots").to_owned();
    let Some(root) = &facts.root else { return (cap_chars(&conversation_title, DRAFT_TITLE_CHARS), String::new()) };
    let mut subjects: Vec<String> = Vec::new();
    if !facts.range.is_empty() {
        let limit = MAX_SUBJECTS.to_string();
        let mut args = vec!["log", "--format=%s", "--reverse", "-n", limit.as_str()];
        args.extend(facts.range.iter().map(String::as_str));
        if let Some(out) = read(root, &args).await {
            subjects = out.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_owned).collect();
        }
    }
    let title = if facts.commits_ahead == 1 && subjects.len() == 1 { subjects[0].clone() } else { conversation_title };
    let (files, added, removed) = file_totals(root, facts).await;
    let mut body = String::from("## Changes\n");
    for subject in &subjects { body.push_str(&format!("- {subject}\n")); }
    let noun = if files == 1 { "file" } else { "files" };
    body.push_str(&format!("\n## Files\n{files} {noun}, +{added} \u{2212}{removed}\n\nMade with Bitbots."));
    (cap_chars(&title, DRAFT_TITLE_CHARS), body)
}

/// Files and line counts of everything the branch changes: committed and uncommitted tracked
/// changes together once, then the untracked files by name only.
async fn file_totals(root: &Path, facts: &Facts) -> (u64, u64, u64) {
    let mut paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    let (mut added, mut removed) = (0u64, 0u64);
    // The point the branch left from: the merge base with the base ref, or, when the base is
    // unknown, the parent of the oldest commit that is on no remote.
    let diff_base = match &facts.base_ref {
        Some(reference) => read(root, &["merge-base", "HEAD", reference]).await.map(|out| out.trim().to_owned()),
        None if !facts.range.is_empty() => {
            let mut args = vec!["rev-list", "--reverse"];
            args.extend(facts.range.iter().map(String::as_str));
            match read(root, &args).await.and_then(|out| out.lines().next().map(str::to_owned)) {
                Some(first) if verifies(root, &format!("{first}^")).await => Some(format!("{first}^")),
                Some(_) => Some(EMPTY_TREE.to_owned()),
                None => None,
            }
        }
        None => None,
    };
    if let Some(base) = diff_base.filter(|base| !base.is_empty()) {
        let run = run_git(root, &["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", &base], READ_LIMIT).await;
        for (path, stat) in repository::parse_numstat(&run.stdout) {
            paths.insert(path);
            added += stat.added.unwrap_or(0);
            removed += stat.removed.unwrap_or(0);
        }
    }
    if let Some(out) = read(root, &["status", "--porcelain=v2", "-z", "--untracked-files=all"]).await {
        for change in repository::parse_status(out.as_bytes()) { paths.insert(change.repository_path); }
    }
    (paths.len() as u64, added, removed)
}

/// An open pull request for the current branch, if `gh` can name one.
async fn existing_url(facts: &Facts) -> Option<String> {
    let root = facts.root.as_ref()?;
    if facts.gh["available"] != true || facts.gh["login"].is_null() || !facts.has_origin || facts.branch.is_none() { return None; }
    let ran = scaffold::run(&scaffold::gh_program(), Some(root), &["pr", "view", "--json", "url,state"], None, VIEW_LIMIT).await;
    if !ran.ok { return None; }
    let view: Value = serde_json::from_str(ran.stdout.trim()).ok()?;
    if view["state"] != "OPEN" { return None; }
    view["url"].as_str().and_then(https_url)
}

/// `https://` with a host and no whitespace or control characters, else `None`.
fn https_url(candidate: &str) -> Option<String> {
    let candidate = candidate.trim();
    let rest = candidate.strip_prefix("https://")?;
    let valid = !rest.is_empty() && !rest.starts_with('/') && candidate.len() <= 2048
        && !candidate.chars().any(|c| c.is_whitespace() || c.is_control());
    valid.then(|| candidate.to_owned())
}

pub(crate) async fn draft(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid("sessionId is required"))?;
    let detail = st.db.session_detail(session_id).map_err(|_| derr("not_found", "session not found", StatusCode::NOT_FOUND))?;
    let folder = detail["projectPath"].as_str().unwrap_or("").to_owned();
    let facts = gather(&detail, &folder, None).await;
    let (title, body) = propose(&detail, &facts).await;
    let existing = existing_url(&facts).await;
    Ok(json!({
        "ready": facts.reason.is_none(),
        "reason": facts.reason,
        "gh": facts.gh,
        "repoRoot": facts.root.as_deref().map(repository::display_path),
        "branch": facts.branch,
        "base": facts.base,
        "isWorktree": facts.is_worktree,
        "remote": facts.has_origin.then_some("origin"),
        "commitsAhead": facts.commits_ahead,
        "uncommitted": facts.uncommitted,
        "title": title,
        "body": body,
        "existingUrl": existing,
    }))
}

fn step(id: &str, status: &str, detail: Option<String>) -> Value {
    json!({"id": id, "status": status, "detail": detail})
}

/// A one-line, redacted reason for a failed command.
fn why(ran: &Ran, what: &str) -> String {
    if !ran.started { return format!("{what} could not be started. Is it installed?"); }
    if ran.timed_out { return format!("{what} took too long and was stopped."); }
    ran.stderr.lines().chain(ran.stdout.lines()).map(str::trim).find(|line| !line.is_empty())
        .map_or_else(|| format!("{what} did not complete."), scaffold::one_line)
}

/// A base branch name `gh` can take as a separate argument: no leading dash, no spaces, no
/// characters git refuses in a ref.
fn valid_base(base: &str) -> bool {
    !base.is_empty() && base.chars().count() <= MAX_BASE && !base.starts_with('-') && !base.starts_with('/') && !base.ends_with('/')
        && !base.contains("..") && !base.ends_with(".lock")
        && !base.chars().any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c))
}

pub(crate) async fn create(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    if p["confirm"] != true { return Err(invalid("Confirm opening the pull request first.")); }
    let title = p["title"].as_str().map(str::trim).filter(|title| !title.is_empty() && title.chars().count() <= MAX_TITLE)
        .ok_or_else(|| invalid("Give the pull request a title of up to 256 characters."))?.to_owned();
    let body = match p.get("body") {
        None | Some(Value::Null) => String::new(),
        Some(value) => value.as_str().filter(|body| body.chars().count() <= MAX_BODY).ok_or_else(|| invalid("The description can be up to 60,000 characters."))?.to_owned(),
    };
    let base = match p.get("base") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_str().filter(|base| valid_base(base)).ok_or_else(|| invalid("That isn't a branch name Bitbots can use as the base."))?.to_owned()),
    };
    let draft = match p.get("draft") {
        None | Some(Value::Null) => false,
        Some(value) => value.as_bool().ok_or_else(|| invalid("draft must be true or false."))?,
    };
    let commit_message = match p.get("commitMessage") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_str().filter(|message| message.chars().count() <= MAX_COMMIT_MESSAGE).ok_or_else(|| invalid("The commit message is too long."))?.trim().to_owned()).filter(|message| !message.is_empty()),
    };
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid("sessionId is required"))?;
    let detail = st.db.session_detail(session_id).map_err(|_| derr("not_found", "session not found", StatusCode::NOT_FOUND))?;
    let folder = detail["projectPath"].as_str().filter(|path| !path.is_empty()).map(str::to_owned).ok_or_else(|| invalid("This conversation isn't in a git repository."))?;
    if git_ops::busy_in_folder(st, session_id, &detail, &folder) { return Err(git_ops::busy_error()); }
    let facts = gather(&detail, &folder, base.as_deref()).await;
    if let Some(reason) = &facts.reason { return Err(invalid(reason)); }
    if facts.commits_ahead == 0 && commit_message.is_none() {
        return Err(invalid("There are no commits to propose yet. Add a commit message to include the uncommitted files."));
    }
    let (Some(root), Some(branch)) = (facts.root.clone(), facts.branch.clone()) else { return Err(invalid("This conversation isn't in a git repository.")) };
    let base = base.or(facts.base.clone());

    let mut steps: Vec<Value> = Vec::new();
    let mut failed = false;
    // 1. commit
    match &commit_message {
        None => steps.push(step("commit", "skipped", Some("No commit message, so uncommitted files are left out.".to_owned()))),
        Some(message) => {
            let (dir, message) = (root.clone(), message.clone());
            let outcome = tokio::task::spawn_blocking(move || crate::worktree::commit_all(&dir, &message)).await;
            match outcome {
                Ok(Ok(())) => steps.push(step("commit", "done", None)),
                Ok(Err(reason)) => { failed = true; steps.push(step("commit", "failed", Some(scaffold::one_line(&reason)))); }
                Err(_) => { failed = true; steps.push(step("commit", "failed", Some("The commit did not complete.".to_owned()))); }
            }
        }
    }
    // 2. push: the conversation's own branch to origin, never forced, never the base.
    let git = OsString::from("git");
    if failed {
        steps.push(step("push", "skipped", Some("An earlier step failed.".to_owned())));
    } else {
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        let ran = scaffold::run(&git, Some(&root), &["-c", "protocol.ext.allow=never", "push", "-u", "origin", &refspec], None, PUSH_LIMIT).await;
        if ran.ok { steps.push(step("push", "done", None)); } else { failed = true; steps.push(step("push", "failed", Some(why(&ran, "git")))); }
    }
    // 3. the pull request
    let mut url = Value::Null;
    if failed {
        steps.push(step("pr", "skipped", Some("An earlier step failed.".to_owned())));
    } else {
        let mut args: Vec<&str> = vec!["pr", "create", "--head", &branch, "--title", &title, "--body-file", "-"];
        if let Some(base) = &base { args.extend(["--base", base.as_str()]); }
        if draft { args.push("--draft"); }
        let ran = scaffold::run(&scaffold::gh_program(), Some(&root), &args, Some(&body), CREATE_LIMIT).await;
        if !ran.ok {
            steps.push(step("pr", "failed", Some(why(&ran, "The GitHub CLI"))));
        } else if let Some(found) = ran.stdout.lines().chain(ran.stderr.lines()).find_map(https_url) {
            url = json!(found);
            steps.push(step("pr", "done", None));
        } else {
            steps.push(step("pr", "failed", Some("The GitHub CLI didn't print the pull request's address.".to_owned())));
        }
    }
    if let Some(opened) = url.as_str() {
        crate::team::note(st, session_id, &format!("Opened a pull request: {opened}"), json!({"kind": "pull_request", "url": opened, "title": title})).await;
    }
    Ok(json!({"steps": steps, "url": url}))
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

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bloblex-pr-{tag}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn init(dir: &Path) {
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "user.name", "Test"]);
        git(dir, &["config", "core.autocrlf", "false"]);
    }

    fn write(dir: &Path, name: &str, content: &str) {
        std::fs::write(dir.join(name), content).unwrap();
    }

    fn commit(dir: &Path, name: &str, content: &str, message: &str) {
        write(dir, name, content);
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", message]);
    }

    /// The GitHub CLI replaced by a script: it records its arguments and its standard input and
    /// answers like a signed-in `gh`, unless told otherwise. It never touches the network.
    struct GhStub {
        dir: PathBuf,
        _guard: tokio::sync::MutexGuard<'static, ()>,
    }

    impl GhStub {
        async fn install() -> Self {
            let guard = scaffold::GH_TEST_LOCK.lock().await;
            let dir = temp("gh");
            #[cfg(windows)]
            let (file, script) = ("gh.cmd", [
                "@echo off",
                "echo %* >> \"%~dp0calls.txt\"",
                "if \"%1\"==\"--version\" (echo gh version 2.0.0& exit /b 0)",
                "if \"%1\"==\"api\" if exist \"%~dp0noauth.flag\" exit /b 1",
                "if \"%1\"==\"api\" (echo stub-login& exit /b 0)",
                "if \"%1\"==\"pr\" if \"%2\"==\"view\" if exist \"%~dp0existing.flag\" (echo {\"url\":\"https://github.com/o/r/pull/3\",\"state\":\"OPEN\"}& exit /b 0)",
                "if \"%1\"==\"pr\" if \"%2\"==\"view\" exit /b 1",
                "if \"%1\"==\"repo\" if exist \"%~dp0default.txt\" (type \"%~dp0default.txt\"& exit /b 0)",
                "if \"%1\"==\"repo\" exit /b 1",
                "if exist \"%~dp0fail.flag\" (echo gh: boom 1>&2& exit /b 1)",
                "if \"%1\"==\"pr\" if \"%2\"==\"create\" if exist \"%~dp0silent.flag\" (findstr \"^\" > \"%~dp0stdin.txt\"& exit /b 0)",
                "if \"%1\"==\"pr\" if \"%2\"==\"create\" (findstr \"^\" > \"%~dp0stdin.txt\"& echo https://github.com/o/r/pull/9& exit /b 0)",
                "exit /b 2",
            ].join("\r\n"));
            #[cfg(unix)]
            let (file, script) = ("gh", [
                "#!/bin/sh",
                "d=$(dirname \"$0\")",
                "echo \"$@\" >> \"$d/calls.txt\"",
                "case \"$1\" in --version) echo gh version 2.0.0; exit 0;; esac",
                "if [ \"$1\" = api ]; then if [ -e \"$d/noauth.flag\" ]; then exit 1; fi; echo stub-login; exit 0; fi",
                "if [ \"$1\" = pr ] && [ \"$2\" = view ]; then if [ -e \"$d/existing.flag\" ]; then echo '{\"url\":\"https://github.com/o/r/pull/3\",\"state\":\"OPEN\"}'; exit 0; fi; exit 1; fi",
                "if [ \"$1\" = repo ]; then if [ -e \"$d/default.txt\" ]; then cat \"$d/default.txt\"; exit 0; fi; exit 1; fi",
                "if [ -e \"$d/fail.flag\" ]; then echo 'gh: boom' >&2; exit 1; fi",
                "if [ \"$1\" = pr ] && [ \"$2\" = create ]; then cat > \"$d/stdin.txt\"; if [ ! -e \"$d/silent.flag\" ]; then echo https://github.com/o/r/pull/9; fi; exit 0; fi",
                "exit 2",
            ].join("\n"));
            std::fs::write(dir.join(file), script).unwrap();
            #[cfg(unix)]
            { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(dir.join(file), std::fs::Permissions::from_mode(0o755)).unwrap(); }
            *scaffold::GH_STUB.lock().unwrap() = Some(dir.join(file));
            Self { dir, _guard: guard }
        }
        fn flag(&self, name: &str) { std::fs::write(self.dir.join(name), "x").unwrap(); }
        fn calls(&self) -> String { std::fs::read_to_string(self.dir.join("calls.txt")).unwrap_or_default() }
        fn stdin(&self) -> String { std::fs::read_to_string(self.dir.join("stdin.txt")).unwrap_or_default().replace("\r\n", "\n") }
    }

    impl Drop for GhStub {
        fn drop(&mut self) { *scaffold::GH_STUB.lock().unwrap() = None; }
    }

    /// A work repository on branch `feature/x`, one commit ahead of `main`, with a local bare
    /// repository as `origin`, and a conversation titled "Review" working in it.
    struct Fixture {
        st: AppState,
        work: PathBuf,
        bare: PathBuf,
    }

    fn fixture(tag: &str) -> Fixture {
        let work = temp(&format!("{tag}-work"));
        let bare = temp(&format!("{tag}-origin"));
        git(&bare, &["init", "-q", "--bare", "-b", "main"]);
        init(&work);
        commit(&work, "readme.txt", "hello\n", "Start the project");
        git(&work, &["remote", "add", "origin", &bare.to_string_lossy()]);
        git(&work, &["push", "-q", "-u", "origin", "main"]);
        git(&work, &["checkout", "-q", "-b", "feature/x"]);
        commit(&work, "feature.txt", "one\ntwo\n", "Add the feature");
        let (st, _) = state();
        st.db.create_session("review", "rt-test", "codex", &work.to_string_lossy(), "Review").unwrap();
        st.db.update_session_state("review", "completed").unwrap();
        Fixture { st, work, bare }
    }

    async fn call(st: &AppState, method: &str, p: Value) -> Result<Value, DispatchError> {
        crate::dispatch(st, method, p).await
    }

    async fn draft_of(st: &AppState) -> Value {
        call(st, "session.pr.draft", json!({"sessionId": "review"})).await.unwrap()
    }

    fn create_body(extra: Value) -> Value {
        let mut body = json!({"sessionId": "review", "title": "Add the feature", "body": "Body text\n## Notes\n- one", "base": Value::Null, "draft": false, "commitMessage": Value::Null, "confirm": true});
        for (key, value) in extra.as_object().unwrap() { body[key] = value.clone(); }
        body
    }

    fn remote_ref(bare: &Path, name: &str) -> Option<String> {
        let output = crate::experiments::git_command().arg("-C").arg(bare).args(["rev-parse", "--verify", "-q", name]).output().unwrap();
        output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    fn ids(result: &Value) -> Vec<(String, String)> {
        result["steps"].as_array().unwrap().iter().map(|step| (step["id"].as_str().unwrap().to_owned(), step["status"].as_str().unwrap().to_owned())).collect()
    }

    fn expect(spec: &[(&str, &str)]) -> Vec<(String, String)> {
        spec.iter().map(|(id, status)| ((*id).to_owned(), (*status).to_owned())).collect()
    }

    #[tokio::test]
    async fn draft_explains_each_reason_it_isnt_ready() {
        let _gh = GhStub::install().await;
        let f = fixture("reasons");
        let ready = draft_of(&f.st).await;
        assert_eq!(ready["ready"], true);
        assert!(ready["reason"].is_null());
        assert_eq!(ready["branch"], "feature/x");
        assert_eq!(ready["remote"], "origin");
        assert_eq!(ready["commitsAhead"], 1);
        assert_eq!(ready["uncommitted"], 0);
        assert_eq!(ready["gh"], json!({"available": true, "login": "stub-login"}));
        // 7. nothing to propose.
        git(&f.work, &["checkout", "-q", "-b", "empty", "main"]);
        git(&f.work, &["remote", "set-head", "origin", "main"]);
        let nothing = draft_of(&f.st).await;
        assert_eq!((nothing["ready"].clone(), nothing["reason"].clone()), (json!(false), json!("There's nothing to propose yet.")));
        assert_eq!(nothing["base"], "main");
        // 3. on the base branch itself.
        git(&f.work, &["checkout", "-q", "main"]);
        let own = draft_of(&f.st).await;
        assert_eq!(own["reason"], "Pull requests need their own branch. This conversation is on `main`.");
        // 2. detached.
        git(&f.work, &["checkout", "-q", "--detach", "feature/x"]);
        assert_eq!(draft_of(&f.st).await["reason"], "This conversation is on a detached commit.");
        git(&f.work, &["checkout", "-q", "feature/x"]);
        // 6 and 5. The GitHub CLI.
        let gh_dir = scaffold::GH_STUB.lock().unwrap().clone().unwrap().parent().unwrap().to_path_buf();
        std::fs::write(gh_dir.join("noauth.flag"), "x").unwrap();
        assert_eq!(draft_of(&f.st).await["reason"], "The GitHub CLI isn't signed in.");
        std::fs::remove_file(gh_dir.join("noauth.flag")).unwrap();
        *scaffold::GH_STUB.lock().unwrap() = Some(gh_dir.join("no-such-gh"));
        assert_eq!(draft_of(&f.st).await["reason"], "The GitHub CLI isn't installed.");
        // 4. no origin.
        git(&f.work, &["remote", "remove", "origin"]);
        assert_eq!(draft_of(&f.st).await["reason"], "This repository has no `origin` remote.");
        // 1. not a repository.
        let plain = temp("plain");
        f.st.db.create_session("plain", "rt-test", "codex", &plain.to_string_lossy(), "Plain").unwrap();
        let none = call(&f.st, "session.pr.draft", json!({"sessionId": "plain"})).await.unwrap();
        assert_eq!((none["ready"].clone(), none["reason"].clone()), (json!(false), json!("This conversation isn't in a git repository.")));
        assert!(none["repoRoot"].is_null());
        assert_eq!(call(&f.st, "session.pr.draft", json!({"sessionId": "absent"})).await.unwrap_err().1.code, "not_found");
    }

    #[tokio::test]
    async fn draft_title_and_body_come_from_the_commits() {
        let gh = GhStub::install().await;
        let f = fixture("title");
        let one = call(&f.st, "session.pr.draft", json!({"sessionId": "review"})).await.unwrap();
        assert_eq!(one["title"], "Add the feature", "a single commit gives its subject");
        let body = one["body"].as_str().unwrap();
        assert!(body.starts_with("## Changes\n- Add the feature\n"), "{body}");
        assert!(body.contains("\n## Files\n1 file, +2 \u{2212}0\n"), "{body}");
        assert!(body.ends_with("Made with Bitbots."));
        // Two commits and an uncommitted file: the conversation's title, both subjects, three files.
        commit(&f.work, "more.txt", "x\n", "Handle the edge case");
        write(&f.work, "loose.txt", "y\n");
        let two = call(&f.st, "session.pr.draft", json!({"sessionId": "review"})).await.unwrap();
        assert_eq!(two["title"], "Review");
        assert_eq!(two["commitsAhead"], 2);
        assert_eq!(two["uncommitted"], 1);
        let body = two["body"].as_str().unwrap();
        assert!(body.contains("- Add the feature\n- Handle the edge case\n"), "{body}");
        assert!(body.contains("3 files, +3 \u{2212}0"), "{body}");
        // An open pull request is reported, a closed one is not.
        assert!(two["existingUrl"].is_null());
        gh.flag("existing.flag");
        let existing = call(&f.st, "session.pr.draft", json!({"sessionId": "review"})).await.unwrap();
        assert_eq!(existing["existingUrl"], "https://github.com/o/r/pull/3");
        // The title is cut at 72 characters.
        f.st.db.session_rename("review", &"t".repeat(100)).unwrap();
        let long = call(&f.st, "session.pr.draft", json!({"sessionId": "review"})).await.unwrap();
        assert_eq!(long["title"].as_str().unwrap().chars().count(), 72);
    }

    #[tokio::test]
    async fn draft_never_returns_the_remote_url() {
        let _gh = GhStub::install().await;
        let f = fixture("secret");
        git(&f.work, &["remote", "set-url", "origin", "https://person:s3cretT0ken@example.invalid/owner/repo.git"]);
        let draft = call(&f.st, "session.pr.draft", json!({"sessionId": "review"})).await.unwrap();
        assert_eq!(draft["remote"], "origin");
        let all = draft.to_string();
        assert!(!all.contains("s3cretT0ken") && !all.contains("example.invalid") && !all.contains("person"), "{all}");
    }

    #[tokio::test]
    async fn create_needs_confirm() {
        let gh = GhStub::install().await;
        let f = fixture("confirm");
        for confirm in [json!(false), json!("true"), Value::Null] {
            assert_eq!(call(&f.st, "session.pr.create", create_body(json!({"confirm": confirm}))).await.unwrap_err().1.code, "invalid_argument");
        }
        let mut missing = create_body(json!({}));
        missing.as_object_mut().unwrap().remove("confirm");
        assert_eq!(call(&f.st, "session.pr.create", missing).await.unwrap_err().1.code, "invalid_argument");
        for bad in [json!({"title": ""}), json!({"title": "   "}), json!({"title": "t".repeat(257)}), json!({"body": "b".repeat(60_001)}), json!({"base": "-x"}), json!({"base": "a b"}), json!({"draft": "yes"})] {
            assert_eq!(call(&f.st, "session.pr.create", create_body(bad)).await.unwrap_err().1.code, "invalid_argument");
        }
        assert!(remote_ref(&f.bare, "refs/heads/feature/x").is_none(), "nothing was pushed");
        assert!(!gh.calls().contains("pr create"));
    }

    #[tokio::test]
    async fn create_commits_pushes_and_opens() {
        let gh = GhStub::install().await;
        let f = fixture("full");
        write(&f.work, "extra.txt", "extra\n");
        let result = call(&f.st, "session.pr.create", create_body(json!({"commitMessage": "Add the extras", "base": "main", "draft": true}))).await.unwrap();
        assert_eq!(ids(&result), expect(&[("commit", "done"), ("push", "done"), ("pr", "done")]), "{result}");
        assert_eq!(result["url"], "https://github.com/o/r/pull/9");
        assert_eq!(git(&f.work, &["log", "-1", "--format=%s"]), "Add the extras");
        assert_eq!(git(&f.work, &["status", "--porcelain"]), "");
        assert_eq!(remote_ref(&f.bare, "refs/heads/feature/x").unwrap(), git(&f.work, &["rev-parse", "HEAD"]));
        let calls = gh.calls().replace('"', "");
        assert!(calls.contains("pr create --head feature/x --title Add the feature --body-file - --base main --draft"), "{calls}");
        // Without a base or draft those flags are left out.
        let again = call(&f.st, "session.pr.create", create_body(json!({"base": Value::Null}))).await.unwrap();
        assert_eq!(again["url"], "https://github.com/o/r/pull/9");
        let last = gh.calls().lines().rfind(|line| line.contains("pr create")).unwrap().to_owned();
        assert!(!last.contains("--draft") && !last.contains("--base"), "{last}");
    }

    #[tokio::test]
    async fn create_leaves_uncommitted_files_out_without_a_message() {
        let _gh = GhStub::install().await;
        let f = fixture("loose");
        write(&f.work, "loose.txt", "not yet\n");
        let result = call(&f.st, "session.pr.create", create_body(json!({"commitMessage": "   "}))).await.unwrap();
        assert_eq!(ids(&result), expect(&[("commit", "skipped"), ("push", "done"), ("pr", "done")]));
        assert_eq!(git(&f.work, &["status", "--porcelain"]), "?? loose.txt", "the file is still uncommitted");
        assert_eq!(remote_ref(&f.bare, "refs/heads/feature/x").unwrap(), git(&f.work, &["rev-parse", "HEAD"]));
        let pushed = git(&f.bare, &["ls-tree", "-r", "--name-only", "refs/heads/feature/x"]);
        assert!(!pushed.contains("loose.txt"), "{pushed}");
        // Only uncommitted files and no message: nothing to open a request for.
        git(&f.work, &["checkout", "-q", "-b", "bare-branch", "main"]);
        write(&f.work, "only.txt", "x\n");
        let refused = call(&f.st, "session.pr.create", create_body(json!({}))).await.unwrap_err();
        assert_eq!(refused.1.code, "invalid_argument");
    }

    #[tokio::test]
    async fn create_never_force_pushes_and_never_pushes_the_base() {
        let gh = GhStub::install().await;
        let f = fixture("force");
        let main_before = remote_ref(&f.bare, "refs/heads/main").unwrap();
        // The branch already exists on origin with different history, and local main moved on.
        let other = temp("force-other");
        git(&other, &["clone", "-q", &f.bare.to_string_lossy(), "."]);
        git(&other, &["config", "user.email", "o@example.com"]);
        git(&other, &["config", "user.name", "Other"]);
        git(&other, &["checkout", "-q", "-b", "feature/x", "origin/main"]);
        commit(&other, "theirs.txt", "theirs\n", "Someone else's work");
        git(&other, &["push", "-q", "origin", "feature/x"]);
        let theirs = remote_ref(&f.bare, "refs/heads/feature/x").unwrap();
        git(&f.work, &["checkout", "-q", "main"]);
        commit(&f.work, "local-main.txt", "m\n", "Local main moved");
        git(&f.work, &["checkout", "-q", "feature/x"]);
        let result = call(&f.st, "session.pr.create", create_body(json!({"base": "main"}))).await.unwrap();
        assert_eq!(ids(&result), expect(&[("commit", "skipped"), ("push", "failed"), ("pr", "skipped")]), "{result}");
        assert!(result["url"].is_null());
        assert_eq!(remote_ref(&f.bare, "refs/heads/feature/x").unwrap(), theirs, "the remote branch is untouched");
        assert_eq!(remote_ref(&f.bare, "refs/heads/main").unwrap(), main_before, "the base is never pushed");
        assert!(!gh.calls().contains("pr create"));
        // Naming the branch as its own base is refused before anything happens.
        let refused = call(&f.st, "session.pr.create", create_body(json!({"base": "feature/x"}))).await.unwrap_err();
        assert_eq!(refused.1.code, "invalid_argument");
        assert!(refused.1.message.starts_with("Pull requests need their own branch."));
        // On the base branch itself, nothing is pushed either.
        git(&f.work, &["checkout", "-q", "main"]);
        let on_base = call(&f.st, "session.pr.create", create_body(json!({"base": "main", "commitMessage": "Push main"}))).await.unwrap_err();
        assert_eq!(on_base.1.code, "invalid_argument");
        assert_eq!(remote_ref(&f.bare, "refs/heads/main").unwrap(), main_before);
    }

    #[tokio::test]
    async fn create_stops_at_a_failed_push_and_keeps_the_commit() {
        let gh = GhStub::install().await;
        let f = fixture("stop");
        write(&f.work, "extra.txt", "extra\n");
        // Point origin somewhere that does not exist so the push fails.
        git(&f.work, &["remote", "set-url", "origin", &f.bare.join("gone").to_string_lossy()]);
        let result = call(&f.st, "session.pr.create", create_body(json!({"commitMessage": "Keep this"}))).await.unwrap();
        assert_eq!(ids(&result), expect(&[("commit", "done"), ("push", "failed"), ("pr", "skipped")]), "{result}");
        assert!(result["url"].is_null());
        assert_eq!(git(&f.work, &["log", "-1", "--format=%s"]), "Keep this", "what already worked stays");
        assert!(result["steps"][1]["detail"].as_str().is_some_and(|detail| !detail.is_empty() && !detail.contains('\n')));
        assert!(!gh.calls().contains("pr create"));
        // The notice is only written on success.
        let detail = f.st.db.session_detail("review").unwrap();
        assert!(!detail["messages"].as_array().unwrap().iter().any(|m| m["meta"]["kind"] == "pull_request"));
        // A failing gh leaves the push done and the pr failed, with a redacted one-line reason.
        git(&f.work, &["remote", "set-url", "origin", &f.bare.to_string_lossy()]);
        gh.flag("fail.flag");
        let failed = call(&f.st, "session.pr.create", create_body(json!({}))).await.unwrap();
        assert_eq!(ids(&failed), expect(&[("commit", "skipped"), ("push", "done"), ("pr", "failed")]));
        assert_eq!(failed["steps"][2]["detail"], "gh: boom");
        assert!(failed["url"].is_null());
    }

    #[tokio::test]
    async fn an_address_gh_does_not_print_fails_the_step() {
        let gh = GhStub::install().await;
        let f = fixture("noaddress");
        gh.flag("silent.flag");
        let result = call(&f.st, "session.pr.create", create_body(json!({}))).await.unwrap();
        assert_eq!(ids(&result), expect(&[("commit", "skipped"), ("push", "done"), ("pr", "failed")]), "{result}");
        assert!(result["url"].is_null());
    }

    #[tokio::test]
    async fn create_refuses_while_a_bot_is_working_in_the_folder() {
        let gh = GhStub::install().await;
        let f = fixture("busy");
        f.st.db.create_session("other", "rt-test", "codex", &f.work.to_string_lossy(), "Other").unwrap();
        f.st.db.update_session_state("other", "working").unwrap();
        let refused = call(&f.st, "session.pr.create", create_body(json!({}))).await.unwrap_err();
        assert_eq!((refused.1.code.as_str(), refused.1.message.as_str()), ("conflict", "A bot is working in this folder. Stop it or wait, then try again."));
        f.st.db.update_session_state("other", "completed").unwrap();
        f.st.db.update_session_state("review", "working").unwrap();
        assert_eq!(call(&f.st, "session.pr.create", create_body(json!({}))).await.unwrap_err().1.code, "conflict");
        assert!(remote_ref(&f.bare, "refs/heads/feature/x").is_none());
        assert!(!gh.calls().contains("pr create"));
    }

    #[tokio::test]
    async fn create_passes_the_body_on_stdin() {
        let gh = GhStub::install().await;
        let f = fixture("stdin");
        let body = "First line\n\n## Notes\n- one\n- two";
        call(&f.st, "session.pr.create", create_body(json!({"body": body}))).await.unwrap();
        assert_eq!(gh.stdin().trim_end(), body);
        let calls = gh.calls();
        assert!(!calls.contains("First line") && !calls.contains("Notes"), "the body is not in the arguments: {calls}");
    }

    #[tokio::test]
    async fn created_pr_writes_a_notice_with_its_url() {
        let _gh = GhStub::install().await;
        let f = fixture("notice");
        let result = call(&f.st, "session.pr.create", create_body(json!({"title": "Notice title"}))).await.unwrap();
        let url = result["url"].as_str().unwrap().to_owned();
        let detail = f.st.db.session_detail("review").unwrap();
        let notices: Vec<&Value> = detail["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "notice" && m["meta"]["kind"] == "pull_request").collect();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0]["content"], format!("Opened a pull request: {url}"));
        assert_eq!(notices[0]["meta"]["url"], url);
        assert_eq!(notices[0]["meta"]["title"], "Notice title");
    }

    /// A work repository on `main` with a commit and an `origin` that has no branches at all.
    fn unpushed_main(tag: &str) -> Fixture {
        let work = temp(&format!("{tag}-work"));
        let bare = temp(&format!("{tag}-origin"));
        git(&bare, &["init", "-q", "--bare", "-b", "main"]);
        init(&work);
        commit(&work, "readme.txt", "hello
", "Start the project");
        git(&work, &["remote", "add", "origin", &bare.to_string_lossy()]);
        let (st, _) = state();
        st.db.create_session("review", "rt-test", "codex", &work.to_string_lossy(), "Review").unwrap();
        st.db.update_session_state("review", "completed").unwrap();
        Fixture { st, work, bare }
    }

    #[tokio::test]
    async fn an_unknown_base_on_main_is_refused_and_pushes_nothing() {
        let gh = GhStub::install().await;
        let f = unpushed_main("unknown-main");
        let draft = draft_of(&f.st).await;
        assert!(draft["base"].is_null());
        assert_eq!(draft["reason"], "Pull requests need their own branch. This conversation is on `main`.");
        for extra in [json!({}), json!({"commitMessage": "Push it"}), json!({"base": "other"})] {
            let refused = call(&f.st, "session.pr.create", create_body(extra)).await.unwrap_err();
            assert_eq!(refused.1.code, "invalid_argument");
            assert!(refused.1.message.starts_with("Pull requests need their own branch."), "{}", refused.1.message);
        }
        assert!(remote_ref(&f.bare, "refs/heads/main").is_none(), "main never reached origin");
        assert!(!gh.calls().contains("pr create"));
    }

    #[tokio::test]
    async fn the_base_comes_from_github_when_git_does_not_know_it() {
        let gh = GhStub::install().await;
        let f = fixture("gh-base");
        assert!(draft_of(&f.st).await["base"].is_null(), "no answer from gh yet");
        std::fs::write(gh.dir.join("default.txt"), "develop
").unwrap();
        let draft = draft_of(&f.st).await;
        assert_eq!(draft["base"], "develop");
        assert_eq!(draft["ready"], true);
        assert!(gh.calls().contains("repo view --json defaultBranchRef"));
        // GitHub says the branch itself is the default: refused.
        std::fs::write(gh.dir.join("default.txt"), "feature/x
").unwrap();
        let own = draft_of(&f.st).await;
        assert_eq!(own["ready"], false);
        assert_eq!(own["reason"], "Pull requests need their own branch. This conversation is on `feature/x`.");
        // A nonsense answer is ignored.
        std::fs::write(gh.dir.join("default.txt"), "-bad name
").unwrap();
        assert!(draft_of(&f.st).await["base"].is_null());
    }

    #[tokio::test]
    async fn a_supplied_base_does_not_allow_pushing_the_default_branch() {
        let gh = GhStub::install().await;
        let f = unpushed_main("supplied-base");
        std::fs::write(gh.dir.join("default.txt"), "main
").unwrap();
        let refused = call(&f.st, "session.pr.create", create_body(json!({"base": "elsewhere", "commitMessage": "Push main"}))).await.unwrap_err();
        assert_eq!(refused.1.code, "invalid_argument");
        assert!(refused.1.message.contains("`main`"));
        assert!(remote_ref(&f.bare, "refs/heads/main").is_none());
        assert!(!gh.calls().contains("pr create"));
    }
}
