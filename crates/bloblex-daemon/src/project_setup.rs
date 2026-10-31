//! Phase 1: a project's setup steps, and Phase 3: its files and submodules.
//!
//! A project may carry a script (`overrides.setupScript`), files to copy (`overrides.copyFiles`) and
//! submodules to initialise (`overrides.initSubmodules`), all set only at the desktop. They run once,
//! in a conversation's own git worktree, before that conversation's first turn: never in the project's
//! main folder and never in a conversation without its own worktree. The order is copy, submodules,
//! then script. The flag that asks for them is cleared before anything starts, so a crash cannot run
//! them twice. A failure never stops the turn; the agent is told instead. Nothing here logs a script's
//! text, a file's contents or a command's output: a notice carries one redacted line and file names.

use crate::{team, AppState};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

const LIMIT: Duration = Duration::from_secs(300);
const DETAIL_CHARS: usize = 200;
/// What the script may print into memory.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// The largest file a project may copy into a worktree. Anything bigger is refused, never truncated.
const MAX_COPY_BYTES: u64 = 20 * 1024 * 1024;

#[cfg(test)]
pub(crate) static TEST_LIMIT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn limit() -> Duration {
    #[cfg(test)]
    { let ms = TEST_LIMIT_MS.load(std::sync::atomic::Ordering::SeqCst); if ms > 0 { return Duration::from_millis(ms); } }
    LIMIT
}

/// The project's setup steps for one conversation, each read from the stored project row.
#[derive(Clone, Debug, Default)]
struct Plan {
    /// The project's own folder: the source of every copied file.
    main: PathBuf,
    /// The conversation's own worktree: where everything happens.
    worktree: PathBuf,
    script: Option<String>,
    copy_files: Vec<String>,
    submodules: bool,
}

impl Plan {
    fn any(&self) -> bool { self.script.is_some() || !self.copy_files.is_empty() || self.submodules }
}

/// The copy files and submodule switch of a project's overrides, as stored.
fn copy_files(overrides: &Value) -> Vec<String> {
    overrides["copyFiles"].as_array().map(|files| files.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()
}

fn submodules(overrides: &Value) -> bool { overrides["initSubmodules"] == true }

/// Whether a new conversation should run its project's setup steps: it has its own worktree (which
/// is the folder it works in, and not the project's own folder), and the project asks for one of the
/// three steps.
pub(crate) fn wanted(st: &AppState, project_id: Option<&str>, link: &Value, session_path: &Path) -> bool {
    if !link["worktree"].is_object() { return false; }
    let Some(worktree) = link["worktree"]["path"].as_str().map(PathBuf::from).filter(|path| path.is_dir()) else { return false; };
    let Some(project) = project_id.and_then(|id| st.db.project_get(id).ok()) else { return false };
    let overrides = &project["overrides"];
    let wanted = overrides["setupScript"].as_str().is_some() || !copy_files(overrides).is_empty() || submodules(overrides);
    if !wanted { return false; }
    let main_folder = project["path"].as_str().map(|path| crate::worktree::normalize(Path::new(path)));
    let here = crate::worktree::normalize(&worktree);
    crate::worktree::normalize(session_path) == here && main_folder != Some(here)
}

/// How the setup step ended: carry on (with a sentence for the agent when something failed), or the
/// owner pressed Stop while it ran.
pub(crate) enum Setup {
    Proceed(Option<String>),
    Cancelled,
}

pub(crate) async fn before_first_turn(st: &AppState, sid: &str, turn: &str) -> Setup {
    // Taking the flag clears it, so this runs at most once.
    if !st.db.session_take_setup_pending(sid).unwrap_or(false) { return Setup::Proceed(None); }
    let Some(plan) = plan(st, sid) else { return Setup::Proceed(None) };
    // With only a script, the owner is told about the script; with files or submodules, about the setup.
    let script_only = plan.script.is_some() && plan.copy_files.is_empty() && !plan.submodules;
    let label = if script_only { "The project's setup script" } else { "Setting up this project" };
    let running = if plan.copy_files.is_empty() && !plan.submodules { "Running this project's setup script…" } else { "Setting up this project in your worktree…" };
    team::note(st, sid, running, json!({"kind": "setup_script", "status": "running"})).await;
    let mut done = Done { script_only, submodules: plan.submodules, ..Done::default() };

    // 1. Copy the project's files into the worktree. An existing target is never overwritten.
    if !plan.copy_files.is_empty() {
        let (main, worktree, files) = (plan.main.clone(), plan.worktree.clone(), plan.copy_files.clone());
        let copied = tokio::task::spawn_blocking(move || copy_files_into(&main, &worktree, &files)).await.unwrap_or_default();
        done.copied = copied.copied;
        done.skipped = copied.skipped;
        if let Some(detail) = copied.failure {
            return finish(st, sid, label, "failed", Some(detail), done).await;
        }
    }
    // 2. Submodules, with the setup script's time limit. Stop works as it does for the script.
    if plan.submodules {
        let (status, detail) = submodules_update(st, sid, turn, &plan.worktree).await;
        if status != "done" { return finish(st, sid, label, status, detail, done).await; }
    }
    // 3. The script.
    if let Some(script) = plan.script.as_deref() {
        let (status, detail) = run(st, sid, turn, script, &plan.worktree).await;
        if status != "done" { return finish(st, sid, label, status, detail, done).await; }
        done.script = true;
    }
    finish(st, sid, label, "done", None, done).await
}

/// What the setup steps did, for the one notice that reports them.
#[derive(Default)]
struct Done {
    copied: Vec<String>,
    skipped: Vec<String>,
    /// Whether a setup script was configured and ran to the end.
    script: bool,
    /// Whether submodules were asked for.
    submodules: bool,
    /// Whether the project asks for a script alone, which keeps its own wording.
    script_only: bool,
}

/// The one summary sentence for a finished setup. Names only, never contents.
fn done_text(done: &Done) -> String {
    if done.script_only { return "The project's setup script finished.".to_owned(); }
    let mut parts: Vec<String> = Vec::new();
    if !done.copied.is_empty() {
        let files = if done.copied.len() == 1 { "1 file".to_owned() } else { format!("{} files", done.copied.len()) };
        parts.push(match done.skipped.is_empty() { true => format!("Copied {files}"), false => format!("Copied {files} and skipped {}", done.skipped.len()) });
    }
    if done.submodules { parts.push("set up submodules".to_owned()); }
    if done.script { parts.push("ran the setup script".to_owned()); }
    if parts.is_empty() { return "Copied nothing.".to_owned(); }
    let mut sentence = parts.join(" and ");
    if let Some(first) = sentence.get_mut(0..1) { first.make_ascii_uppercase(); }
    sentence.push('.');
    sentence
}

/// The final notice, and how the turn carries on. A failure reports like a failed script: the turn
/// still runs, and the agent is told one redacted line.
async fn finish(st: &AppState, sid: &str, label: &str, status: &'static str, detail: Option<String>, done: Done) -> Setup {
    let text = match (status, &detail) {
        ("done", _) => done_text(&done),
        ("cancelled", _) => format!("{label} was stopped."),
        ("timeout", _) => format!("{label} took too long and was stopped."),
        (_, Some(detail)) => format!("{label} failed: {detail}"),
        (_, None) => format!("{label} failed."),
    };
    team::note(st, sid, &text, json!({"kind": "setup_script", "status": status, "detail": detail, "copied": done.copied, "skipped": done.skipped})).await;
    match status {
        "cancelled" => Setup::Cancelled,
        "done" => Setup::Proceed(None),
        _ => Setup::Proceed(Some(format!("{label} failed in this worktree: {}", detail.unwrap_or_else(|| "it did not complete".to_owned())))),
    }
}

fn plan(st: &AppState, sid: &str) -> Option<Plan> {
    let row = st.db.session_detail(sid).ok()?;
    let worktree = row["link"]["worktree"]["path"].as_str().map(PathBuf::from).filter(|path| path.is_dir())?;
    let project = row["projectId"].as_str().and_then(|id| st.db.project_get(id).ok())?;
    let main = project["path"].as_str().map(PathBuf::from)?;
    // Never in the project's own folder.
    if crate::worktree::normalize(&main) == crate::worktree::normalize(&worktree) { return None; }
    let overrides = &project["overrides"];
    let plan = Plan {
        main,
        worktree,
        script: overrides["setupScript"].as_str().filter(|script| !script.trim().is_empty()).map(str::to_owned),
        copy_files: copy_files(overrides),
        submodules: submodules(overrides),
    };
    plan.any().then_some(plan)
}

/// What a copy pass did: the names it copied, the names it skipped, and the one failure that stopped it.
#[derive(Default)]
struct Copied {
    copied: Vec<String>,
    skipped: Vec<String>,
    failure: Option<String>,
}

/// Copy each file from the project's folder into the worktree. A source must be a regular file, not a
/// symlink, of at most 20 MiB; a missing source is skipped; an existing target is never overwritten.
fn copy_files_into(main: &Path, worktree: &Path, files: &[String]) -> Copied {
    let mut out = Copied::default();
    for name in files {
        let source = main.join(name);
        let target = worktree.join(name);
        let Ok(meta) = std::fs::symlink_metadata(&source) else {
            // Nothing there: skipped, and named, so the owner can see what did not travel.
            out.skipped.push(name.clone());
            continue;
        };
        if meta.file_type().is_symlink() {
            out.failure = Some(format!("{name} is a link, so it was not copied."));
            return out;
        }
        if !meta.is_file() {
            out.skipped.push(name.clone());
            continue;
        }
        if meta.len() > MAX_COPY_BYTES {
            out.failure = Some(format!("{name} is larger than 20 MB, so it was not copied."));
            return out;
        }
        if target.exists() {
            out.skipped.push(name.clone());
            continue;
        }
        if let Some(parent) = target.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                out.failure = Some(format!("{name} could not be copied."));
                return out;
            }
        }
        if std::fs::copy(&source, &target).is_err() {
            out.failure = Some(format!("{name} could not be copied."));
            return out;
        }
        out.copied.push(name.clone());
    }
    out
}

/// Stops `pid` and everything it started. Killing only `cmd.exe` would leave npm and friends running.
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

/// Whether the owner pressed Stop for this turn: the stop is recorded for a turn that has no provider yet,
/// or the conversation is already marked as cancelling.
async fn stop_requested(st: &AppState, sid: &str, turn: &str) -> bool {
    st.starting_cancels.lock().await.contains(turn) || st.db.session_state(sid).ok().flatten().as_deref() == Some("cancelling")
}

/// One line of a command's output, redacted and capped: never a file's contents or a whole log.
fn last_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes).lines().map(str::trim).rev().find(|line| !line.is_empty())
        .map(|line| crate::diagnostics::redact(line).split_whitespace().collect::<Vec<_>>().join(" ").chars().take(DETAIL_CHARS).collect::<String>())
        .filter(|line| !line.is_empty())
}

/// `cmd /d /s /c <script>` in `dir`: no stdin, no window, killed when dropped or when the time is up.
async fn run(st: &AppState, sid: &str, turn: &str, script: &str, dir: &Path) -> (&'static str, Option<String>) {
    let mut command = if cfg!(windows) { tokio::process::Command::new("cmd") } else { tokio::process::Command::new("sh") };
    #[cfg(windows)]
    { command.raw_arg(format!("/d /s /c \"{script}\"")); command.creation_flags(0x0800_0000); }
    #[cfg(not(windows))]
    { command.arg("-c").arg(script); }
    command.current_dir(dir).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true).env("NO_COLOR", "1");
    // The script is the project's, not Bitbots': nothing of the daemon's own settings goes with it.
    for (name, _) in std::env::vars_os() {
        let upper = name.to_string_lossy().to_ascii_uppercase();
        if upper.starts_with("BITBOTS_") || upper.starts_with("BLOBLEX_") { command.env_remove(&name); }
    }
    let Ok(mut child) = command.spawn() else { return ("failed", Some("The script could not be started.".to_owned())) };
    let pid = child.id();
    // Read the output on the side, so the child stays ours: it must be alive when its tree is killed.
    async fn read_all(pipe: Option<impl tokio::io::AsyncRead + Unpin>) -> Vec<u8> {
        use tokio::io::AsyncReadExt;
        let mut out = Vec::new();
        if let Some(pipe) = pipe { let _ = pipe.take(MAX_OUTPUT_BYTES as u64).read_to_end(&mut out).await; }
        out
    }
    let (stdout, stderr) = (tokio::spawn(read_all(child.stdout.take())), tokio::spawn(read_all(child.stderr.take())));
    let watch = async { loop { if stop_requested(st, sid, turn).await { return; } tokio::time::sleep(Duration::from_millis(100)).await; } };
    tokio::select! {
        status = child.wait() => match status {
            Ok(status) if status.success() => ("done", None),
            Ok(status) => {
                let (stdout, stderr) = (stdout.await.unwrap_or_default(), stderr.await.unwrap_or_default());
                let detail = last_line(&stderr).or_else(|| last_line(&stdout))
                    .unwrap_or_else(|| format!("It exited with code {}.", status.code().map_or_else(|| "unknown".to_owned(), |code| code.to_string())));
                ("failed", Some(detail))
            }
            Err(_) => ("failed", Some("The script could not be run.".to_owned())),
        },
        () = watch => { kill_tree(pid); let _ = child.kill().await; ("cancelled", None) }
        () = tokio::time::sleep(limit()) => { kill_tree(pid); let _ = child.kill().await; ("timeout", Some("It was stopped after 5 minutes.".to_owned())) }
    }
}

/// `git -C <worktree> submodule update --init --recursive`: the project's own repositories, none
/// recursed into by the daemon itself, with the setup script's time limit and its Stop.
async fn submodules_update(st: &AppState, sid: &str, turn: &str, dir: &Path) -> (&'static str, Option<String>) {
    let mut command = tokio::process::Command::new("git");
    command.arg("-C").arg(dir).args(["submodule", "update", "--init", "--recursive"])
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true)
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY").env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env("GIT_TERMINAL_PROMPT", "0").env("NO_COLOR", "1");
    for (name, _) in std::env::vars_os() {
        let upper = name.to_string_lossy().to_ascii_uppercase();
        if upper.starts_with("BITBOTS_") || upper.starts_with("BLOBLEX_") { command.env_remove(&name); }
    }
    #[cfg(windows)]
    { command.creation_flags(0x0800_0000); }
    if stop_requested(st, sid, turn).await { return ("cancelled", None); }
    let Ok(mut child) = command.spawn() else { return ("failed", Some("git could not be started.".to_owned())) };
    let pid = child.id();
    async fn read_all(pipe: Option<impl tokio::io::AsyncRead + Unpin>) -> Vec<u8> {
        use tokio::io::AsyncReadExt;
        let mut out = Vec::new();
        if let Some(pipe) = pipe { let _ = pipe.take(MAX_OUTPUT_BYTES as u64).read_to_end(&mut out).await; }
        out
    }
    let (stdout, stderr) = (tokio::spawn(read_all(child.stdout.take())), tokio::spawn(read_all(child.stderr.take())));
    let watch = async { loop { if stop_requested(st, sid, turn).await { return; } tokio::time::sleep(Duration::from_millis(100)).await; } };
    tokio::select! {
        status = child.wait() => match status {
            Ok(status) if status.success() => ("done", None),
            Ok(status) => {
                let (stdout, stderr) = (stdout.await.unwrap_or_default(), stderr.await.unwrap_or_default());
                let detail = last_line(&stderr).or_else(|| last_line(&stdout))
                    .unwrap_or_else(|| format!("git exited with code {}.", status.code().map_or_else(|| "unknown".to_owned(), |code| code.to_string())));
                ("failed", Some(detail))
            }
            Err(_) => ("failed", Some("git could not be run.".to_owned())),
        },
        () = watch => { kill_tree(pid); let _ = child.kill().await; ("cancelled", None) }
        () = tokio::time::sleep(limit()) => { kill_tree(pid); let _ = child.kill().await; ("timeout", Some("It was stopped after 5 minutes.".to_owned())) }
    }
}
