//! Phase 1: a project's setup script.
//!
//! A project may carry a script (`overrides.setupScript`, set only at the desktop). It runs once, in a
//! conversation's own git worktree, before that conversation's first turn: never in the project's main
//! folder and never in a conversation without its own worktree. The flag that asks for it is cleared
//! before the script starts, so a crash cannot run it twice. A failure never stops the turn; the agent
//! is told instead. The script's text and output are never logged: the notice carries one redacted line.

use crate::{team, AppState};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

const LIMIT: Duration = Duration::from_secs(300);
const DETAIL_CHARS: usize = 200;
/// What the script may print into memory.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[cfg(test)]
pub(crate) static TEST_LIMIT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn limit() -> Duration {
    #[cfg(test)]
    { let ms = TEST_LIMIT_MS.load(std::sync::atomic::Ordering::SeqCst); if ms > 0 { return Duration::from_millis(ms); } }
    LIMIT
}

/// Whether a new conversation should run its project's setup script: it has its own worktree (which
/// is the folder it works in, and not the project's own folder), and the project has a script.
pub(crate) fn wanted(st: &AppState, project_id: Option<&str>, link: &Value, session_path: &Path) -> bool {
    if !link["worktree"].is_object() { return false; }
    let Some(worktree) = link["worktree"]["path"].as_str().map(PathBuf::from).filter(|path| path.is_dir()) else { return false };
    let Some(project) = project_id.and_then(|id| st.db.project_get(id).ok()) else { return false };
    if project["overrides"]["setupScript"].as_str().is_none() { return false; }
    let main_folder = project["path"].as_str().map(|path| crate::worktree::normalize(Path::new(path)));
    let here = crate::worktree::normalize(&worktree);
    crate::worktree::normalize(session_path) == here && main_folder != Some(here)
}

/// At the start of a conversation's first turn: runs the script if the conversation is waiting for it.
/// How the setup step ended: carry on (with a sentence for the agent when the script failed), or the
/// owner pressed Stop while it ran.
pub(crate) enum Setup {
    Proceed(Option<String>),
    Cancelled,
}

pub(crate) async fn before_first_turn(st: &AppState, sid: &str, turn: &str) -> Setup {
    // Taking the flag clears it, so this runs at most once.
    if !st.db.session_take_setup_pending(sid).unwrap_or(false) { return Setup::Proceed(None); }
    let Some((script, worktree)) = script_and_worktree(st, sid) else { return Setup::Proceed(None) };
    team::note(st, sid, "Running this project's setup script…", json!({"kind": "setup_script", "status": "running"})).await;
    let (status, detail) = run(st, sid, turn, &script, &worktree).await;
    let text = match (status, &detail) {
        ("cancelled", _) => "The project's setup script was stopped.".to_owned(),
        ("done", _) => "The project's setup script finished.".to_owned(),
        ("timeout", _) => "The project's setup script took too long and was stopped.".to_owned(),
        (_, Some(detail)) => format!("The project's setup script failed: {detail}"),
        (_, None) => "The project's setup script failed.".to_owned(),
    };
    team::note(st, sid, &text, json!({"kind": "setup_script", "status": status, "detail": detail})).await;
    match status {
        "cancelled" => Setup::Cancelled,
        "done" => Setup::Proceed(None),
        _ => Setup::Proceed(Some(format!("The project's setup script failed in this worktree: {}", detail.unwrap_or_else(|| "it did not complete".to_owned())))),
    }
}

fn script_and_worktree(st: &AppState, sid: &str) -> Option<(String, PathBuf)> {
    let row = st.db.session_detail(sid).ok()?;
    let worktree = row["link"]["worktree"]["path"].as_str().map(PathBuf::from).filter(|path| path.is_dir())?;
    let project = row["projectId"].as_str().and_then(|id| st.db.project_get(id).ok())?;
    let script = project["overrides"]["setupScript"].as_str().filter(|script| !script.trim().is_empty())?.to_owned();
    // Never in the project's own folder.
    if project["path"].as_str().is_some_and(|path| crate::worktree::normalize(Path::new(path)) == crate::worktree::normalize(&worktree)) { return None; }
    Some((script, worktree))
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
                let last = |bytes: &[u8]| String::from_utf8_lossy(bytes).lines().map(str::trim).rev().find(|line| !line.is_empty()).map(str::to_owned);
                let detail = last(&stderr).or_else(|| last(&stdout))
                    .map(|line| crate::diagnostics::redact(&line).split_whitespace().collect::<Vec<_>>().join(" ").chars().take(DETAIL_CHARS).collect::<String>())
                    .filter(|line| !line.is_empty())
                    .unwrap_or_else(|| format!("It exited with code {}.", status.code().map_or_else(|| "unknown".to_owned(), |code| code.to_string())));
                ("failed", Some(detail))
            }
            Err(_) => ("failed", Some("The script could not be run.".to_owned())),
        },
        () = watch => { kill_tree(pid); let _ = child.kill().await; ("cancelled", None) }
        () = tokio::time::sleep(limit()) => { kill_tree(pid); let _ = child.kill().await; ("timeout", Some("It was stopped after 5 minutes.".to_owned())) }
    }
}
