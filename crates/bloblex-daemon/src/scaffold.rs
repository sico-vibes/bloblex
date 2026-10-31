//! Phase 1B: create a new project.
//!
//! `project.scaffold` makes a folder, registers it as a project and, when asked, starts a git
//! repository with a first commit and publishes it to GitHub. The dialog that lists these steps is
//! the owner's approval, so the call needs `confirm: true`. Every command runs without a shell,
//! with a time limit, and uses git's and the GitHub CLI's own sign-in: this code never reads,
//! passes or prints a token. It is desktop only and is not offered to the Bitbots MCP, because it
//! can publish a repository.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

const GIT_LIMIT: Duration = Duration::from_secs(60);
const GH_LIMIT: Duration = Duration::from_secs(120);
const LOGIN_LIMIT: Duration = Duration::from_secs(10);
const MAX_NAME_CHARS: usize = 80;
/// What a command may print into memory.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const DETAIL_CHARS: usize = 200;

/// The result of one command. Output is read to branch on it and to build a one-line reason.
pub(crate) struct Ran {
    pub started: bool,
    pub ok: bool,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

#[cfg(test)]
pub(crate) static GH_STUB: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
/// Serialises the tests that point `gh` at a stub.
#[cfg(test)]
pub(crate) static GH_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The GitHub CLI program. A test can point it at a stub; nothing else can.
pub(crate) fn gh_program() -> OsString {
    #[cfg(test)]
    { if let Some(stub) = GH_STUB.lock().ok().and_then(|stub| stub.clone()) { return stub.into_os_string(); } }
    OsString::from("gh")
}

/// One command without a shell, with a time limit. `git` and `gh` find their own stored sign-in;
/// nothing here passes a credential, and a prompt cannot wait for input.
pub(crate) async fn run(program: &OsString, dir: Option<&Path>, args: &[&str], stdin: Option<&str>, limit: Duration) -> Ran {
    use tokio::io::AsyncWriteExt;
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY").env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1");
    if let Some(dir) = dir { command.current_dir(dir); }
    #[cfg(windows)]
    { command.creation_flags(0x0800_0000); }
    let none = |started: bool, timed_out: bool| Ran { started, ok: false, timed_out, stdout: String::new(), stderr: String::new() };
    let Ok(mut child) = command.spawn() else { return none(false, false) };
    let input = stdin.map(str::to_owned);
    let pipe = child.stdin.take();
    let work = async move {
        if let (Some(text), Some(mut pipe)) = (input, pipe) {
            let _ = pipe.write_all(text.as_bytes()).await;
            drop(pipe);
        }
        child.wait_with_output().await
    };
    match tokio::time::timeout(limit, work).await {
        Ok(Ok(output)) => {
            let text = |bytes: &[u8]| String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_OUTPUT_BYTES)]).into_owned();
            Ran { started: true, ok: output.status.success(), timed_out: false, stdout: text(&output.stdout), stderr: text(&output.stderr) }
        }
        Ok(Err(_)) => none(true, false),
        Err(_) => none(true, true),
    }
}

/// A one-line, redacted reason for a failed command: the first line it printed, or a plain sentence.
fn reason(ran: &Ran, what: &str) -> String {
    if !ran.started { return format!("{what} could not be started. Is it installed?"); }
    if ran.timed_out { return format!("{what} took too long and was stopped."); }
    let line = ran.stderr.lines().chain(ran.stdout.lines()).map(str::trim).find(|line| !line.is_empty());
    match line {
        Some(line) => one_line(line),
        None => format!("{what} did not complete."),
    }
}

/// Redacted, one line, bounded.
pub(crate) fn one_line(text: &str) -> String {
    let clean = crate::diagnostics::redact(text).split_whitespace().collect::<Vec<_>>().join(" ");
    clean.chars().take(DETAIL_CHARS).collect()
}

/// Whether the GitHub CLI is installed, and who it is signed in as (null on any failure).
pub(crate) async fn gh_status() -> Value {
    let gh = gh_program();
    let installed = run(&gh, None, &["--version"], None, LOGIN_LIMIT).await;
    if !installed.ok { return json!({"available": false, "login": Value::Null}); }
    let user = run(&gh, None, &["api", "user", "--jq", ".login"], None, LOGIN_LIMIT).await;
    let login = user.ok.then(|| user.stdout.trim().to_owned()).filter(|login| !login.is_empty() && login.len() <= 100 && !login.contains(char::is_whitespace));
    json!({"available": true, "login": login})
}

fn invalid(message: &str) -> DispatchError {
    derr("invalid_argument", message, StatusCode::BAD_REQUEST)
}

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "project.scaffold.status" => {
            let git = run(&OsString::from("git"), None, &["--version"], None, LOGIN_LIMIT).await.ok;
            Ok(json!({"git": git, "gh": gh_status().await}))
        }
        "project.scaffold" => scaffold(st, p).await,
        _ => Err(derr("not_found", "unknown project method", StatusCode::NOT_FOUND)),
    }
}

/// A valid Windows folder name: not empty, none of `<>:"/\|?*` or a control character, no trailing
/// dot or space, and not a reserved device name (with or without an extension).
pub(crate) fn valid_folder_name(name: &str) -> bool {
    let count = name.chars().count();
    if count == 0 || count > MAX_NAME_CHARS || name.trim().is_empty() { return false; }
    if name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) { return false; }
    if name.ends_with('.') || name.ends_with(' ') || name.starts_with(' ') { return false; }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0');
    !reserved
}

/// GitHub's repository name: spaces become `-`, other characters it refuses are dropped.
fn github_slug(name: &str) -> String {
    name.chars().map(|c| if c == ' ' { '-' } else { c }).filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect()
}

fn step(id: &str, status: &str, detail: Option<String>) -> Value {
    json!({"id": id, "status": status, "detail": detail})
}

async fn scaffold(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    if p["confirm"] != true { return Err(invalid("Confirm creating the project first.")); }
    let name = p["name"].as_str().filter(|name| valid_folder_name(name)).ok_or_else(|| invalid("Choose a name that works as a folder name, up to 80 characters."))?;
    let parent = p["parentPath"].as_str().map(PathBuf::from).filter(|path| path.is_absolute() && path.is_dir()).ok_or_else(|| invalid("Choose an existing folder to create the project in."))?;
    let git = match p.get("git") {
        None | Some(Value::Null) => false,
        Some(value) => value.as_bool().ok_or_else(|| invalid("git must be true or false."))?,
    };
    let github = match p.get("github") {
        None | Some(Value::Null) => None,
        Some(value) => Some(match value["visibility"].as_str() {
            Some("private") => "--private",
            Some("public") => "--public",
            _ => return Err(invalid("Choose private or public for the GitHub repository.")),
        }),
    };
    if github.is_some() && !git { return Err(invalid("A GitHub repository needs git.")); }
    let target = parent.join(name);
    if target.exists() && (!target.is_dir() || std::fs::read_dir(&target).map(|mut entries| entries.next().is_some()).unwrap_or(true)) {
        return Err(derr("conflict", "That folder already exists and isn't empty.", StatusCode::CONFLICT));
    }

    let mut steps: Vec<Value> = Vec::new();
    let mut project = Value::Null;
    let mut github_url = Value::Null;
    let mut failed = false;
    let skipped = |id: &str, asked: bool, failed: bool| step(id, "skipped", Some(if !asked { "Not asked for.".to_owned() } else if failed { "An earlier step failed.".to_owned() } else { String::new() }));

    // 1. folder
    match std::fs::create_dir_all(&target) {
        Ok(()) => steps.push(step("folder", "done", None)),
        Err(_) => { failed = true; steps.push(step("folder", "failed", Some("The folder could not be created.".to_owned()))); }
    }
    // 2. project, so it exists even if a later step fails
    if failed {
        steps.push(skipped("project", true, true));
    } else {
        let created = crate::team::team_rpc(st, "project.create", &json!({"name": name, "path": target.to_string_lossy()})).await;
        match created {
            Ok(made) => { project = made["project"].clone(); steps.push(step("project", "done", None)); }
            Err(error) => { failed = true; steps.push(step("project", "failed", Some(one_line(&error.1.message)))); }
        }
    }
    let git_program = OsString::from("git");
    // 3. git init
    if !git || failed {
        steps.push(skipped("git_init", git, failed));
    } else {
        let ran = run(&git_program, Some(&target), &["init", "-b", "main"], None, GIT_LIMIT).await;
        if ran.ok { steps.push(step("git_init", "done", None)); } else { failed = true; steps.push(step("git_init", "failed", Some(reason(&ran, "git")))); }
    }
    // 4. first commit
    if !git || failed {
        steps.push(skipped("first_commit", git, failed));
    } else {
        let wrote = std::fs::write(target.join("README.md"), format!("# {name}\n"));
        let outcome = if wrote.is_err() {
            Err("README.md could not be written.".to_owned())
        } else {
            let added = run(&git_program, Some(&target), &["add", "README.md"], None, GIT_LIMIT).await;
            if !added.ok { Err(reason(&added, "git")) } else {
                let committed = run(&git_program, Some(&target), &["commit", "-m", "Initial commit"], None, GIT_LIMIT).await;
                if committed.ok { Ok(()) } else { Err(reason(&committed, "git")) }
            }
        };
        match outcome {
            Ok(()) => steps.push(step("first_commit", "done", None)),
            Err(detail) => { failed = true; steps.push(step("first_commit", "failed", Some(detail))); }
        }
    }
    // 5. GitHub
    match github {
        None => steps.push(skipped("github", false, failed)),
        Some(_) if failed => steps.push(skipped("github", true, true)),
        Some(visibility) => {
            let slug = github_slug(name);
            if slug.is_empty() {
                failed = true;
                steps.push(step("github", "failed", Some("The name has no characters GitHub accepts.".to_owned())));
            } else {
                let gh = gh_program();
                let ran = run(&gh, Some(&target), &["repo", "create", &slug, visibility, "--source", ".", "--remote", "origin", "--push"], None, GH_LIMIT).await;
                if ran.ok {
                    github_url = repo_url(&target, &ran).map_or(Value::Null, Value::String);
                    steps.push(step("github", "done", None));
                } else {
                    steps.push(step("github", "failed", Some(reason(&ran, "The GitHub CLI"))));
                }
            }
        }
    }
    let _ = failed;
    Ok(json!({"project": project, "steps": steps, "githubUrl": github_url}))
}

/// The address `gh repo create` printed, or the origin remote when it printed none.
fn repo_url(target: &Path, ran: &Ran) -> Option<String> {
    let printed = ran.stdout.lines().chain(ran.stderr.lines()).map(str::trim).find(|line| line.starts_with("https://github.com/") && !line.contains(char::is_whitespace));
    if let Some(url) = printed { return Some(url.to_owned()); }
    let output = crate::experiments::git_command().arg("-C").arg(target).args(["remote", "get-url", "origin"]).output().ok()?;
    let url = String::from_utf8_lossy(&output.stdout).trim().trim_end_matches(".git").to_owned();
    (output.status.success() && url.starts_with("https://github.com/")).then_some(url)
}

#[cfg(test)]
mod name_tests {
    use super::*;

    #[test]
    fn folder_names_follow_windows_rules() {
        for good in ["My project", "a", "site.v2", "x".repeat(80).as_str()] { assert!(valid_folder_name(good), "{good}"); }
        for bad in ["", " ", "a/b", "a\\b", "a:b", "what?", "a*b", "a<b", "a>b", "a|b", "q\"q", "dot.", "space ", "CON", "con.txt", "NUL", "com1", "LPT9.log", "..", ".", &"x".repeat(81)] { assert!(!valid_folder_name(bad), "{bad}"); }
        assert!(valid_folder_name("COM0") && valid_folder_name("console"));
    }

    #[test]
    fn github_names_keep_only_what_github_accepts() {
        assert_eq!(github_slug("My cool app!"), "My-cool-app");
        assert_eq!(github_slug("a_b.c-d"), "a_b.c-d");
        assert_eq!(github_slug("???"), "");
    }
}
