//! Phase 4, Round 2: moving a conversation from one machine to another.
//!
//! **The giving machine** answers four `handoff.*` calls from the other machine's daemon, through
//! its Remote gateway: `preview`, `prepare`, `commit` and `abort`. `prepare` takes a *lease* on the
//! conversation (one per conversation, ten minutes, memory only), commits and pushes its own
//! `bitbots/` branch, and hands back a package. While the lease is live, and for good once `commit`
//! sets `link.movedTo`, this machine refuses every way to start a turn
//! ([`crate::machines::refuse_if_moved`]).
//!
//! **The taking machine** runs `machine.takeOver` as a job, six steps in a fixed order: `prepare`,
//! `code`, `bot`, `import`, `commit`, `open`. The import is written with `movedTo` still pointing at
//! the giving machine, so nothing can run here until `open` clears it, and nothing can run there once
//! `commit` has set it. **Only `commit` flips ownership**; before it, a failure aborts the lease and
//! undoes the import, so the giving machine keeps the conversation.
//!
//! Nothing here forces, resets or deletes a branch or a folder. No command goes through a shell. No
//! message text, path or credential is logged. The package holds no host path, environment value,
//! thinking or tool output.

use crate::machine_client::{self as client, ClientError};
use crate::machines;
use crate::repo_identity::Origin;
use crate::repository::{parse_status, run_git};
use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long the giving machine holds a conversation for a move.
const LEASE: Duration = Duration::from_secs(10 * 60);
/// The taking machine waits this long for `handoff.prepare` (a push can be slow).
const PREPARE_LIMIT: Duration = Duration::from_secs(5 * 60);
/// A push, on the giving machine.
const PUSH_LIMIT: Duration = Duration::from_secs(5 * 60);
/// A commit, on the giving machine (hooks may run).
const COMMIT_LIMIT: Duration = Duration::from_secs(2 * 60);
/// The fetch (5 minutes) and the few short commands after it.
const ATTACH_LIMIT: Duration = Duration::from_secs(7 * 60);
/// Every other call to the giving machine.
const CALL_LIMIT: Duration = Duration::from_secs(30);
/// How many messages travel, newest first.
const MAX_MESSAGES: usize = 2_000;
/// Most message text that travels.
const MAX_BYTES: usize = 16 * 1024 * 1024;
/// Most changed files named in the note.
const NOTE_FILES: usize = 12;
/// Most take-over jobs kept in memory.
const MAX_JOBS: usize = 20;
const NAME_MAX: usize = 60;
const GIT_READ: usize = 1024 * 1024;

fn invalid(message: &str) -> DispatchError {
    derr("invalid_argument", message, StatusCode::BAD_REQUEST)
}

fn conflict(message: &str) -> DispatchError {
    derr("conflict", message, StatusCode::CONFLICT)
}

fn internal(error: impl ToString) -> DispatchError {
    derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR)
}

// ---------------------------------------------------------------------------
// Memory: leases and jobs

#[derive(Clone)]
pub(crate) struct Lease {
    pub id: String,
    pub session_id: String,
    pub to_machine: String,
    pub to_name: String,
    expires: Instant,
}

#[derive(Clone)]
struct Job {
    id: String,
    machine_id: String,
    session_id: String,
    state: &'static str,
    steps: Vec<Value>,
    detail: Option<String>,
}

impl Job {
    fn to_value(&self) -> Value {
        json!({"id": self.id, "machineId": self.machine_id, "state": self.state, "steps": self.steps, "sessionId": self.session_id, "detail": self.detail})
    }
}

/// Everything the handoff keeps in memory. A restart ends every lease and forgets every job.
pub struct Handoffs {
    leases: Mutex<HashMap<String, Lease>>,
    jobs: Mutex<Vec<Job>>,
    lease_len: Mutex<Duration>,
    #[cfg(test)]
    fail_at: Mutex<Option<String>>,
}

impl Default for Handoffs {
    fn default() -> Self {
        Self {
            leases: Mutex::new(HashMap::new()),
            jobs: Mutex::new(Vec::new()),
            lease_len: Mutex::new(LEASE),
            #[cfg(test)]
            fail_at: Mutex::new(None),
        }
    }
}

impl Handoffs {
    /// The live lease on a conversation, if any. An expired one is dropped here.
    pub(crate) fn live(&self, session_id: &str) -> Option<Lease> {
        let mut leases = self.leases.lock().unwrap();
        match leases.get(session_id) {
            Some(lease) if lease.expires > Instant::now() => Some(lease.clone()),
            Some(_) => {
                leases.remove(session_id);
                None
            }
            None => None,
        }
    }

    pub(crate) fn begin(&self, session_id: &str, to_machine: &str, to_name: &str) -> Option<Lease> {
        self.live(session_id).is_none().then_some(())?;
        let lease = Lease {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            to_machine: to_machine.to_string(),
            to_name: to_name.to_string(),
            expires: Instant::now() + *self.lease_len.lock().unwrap(),
        };
        self.leases.lock().unwrap().insert(session_id.to_string(), lease.clone());
        Some(lease)
    }

    fn find(&self, handoff_id: &str) -> Option<Lease> {
        let session = self.leases.lock().unwrap().values().find(|lease| lease.id == handoff_id).map(|lease| lease.session_id.clone())?;
        self.live(&session).filter(|lease| lease.id == handoff_id)
    }

    fn end(&self, handoff_id: &str) {
        self.leases.lock().unwrap().retain(|_, lease| lease.id != handoff_id);
    }

    #[cfg(test)]
    pub(crate) fn set_lease_len(&self, length: Duration) {
        *self.lease_len.lock().unwrap() = length;
    }

    /// Tests make one named step of a take-over fail, to check what each failure leaves behind.
    #[cfg(test)]
    pub(crate) fn fail_at(&self, step: Option<&str>) {
        *self.fail_at.lock().unwrap() = step.map(str::to_string);
    }

    fn failpoint(&self, _step: &str) -> bool {
        #[cfg(test)]
        {
            return self.fail_at.lock().unwrap().as_deref() == Some(_step);
        }
        #[cfg(not(test))]
        false
    }

    fn job_update(&self, id: &str, change: impl FnOnce(&mut Job)) -> Option<Value> {
        let mut jobs = self.jobs.lock().unwrap();
        let job = jobs.iter_mut().find(|job| job.id == id)?;
        change(job);
        Some(job.to_value())
    }
}

// ---------------------------------------------------------------------------
// Entry

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "handoff.preview" => preview(st, p).await,
        "handoff.prepare" => prepare(st, p).await,
        "handoff.commit" => commit(st, p).await,
        "handoff.abort" => abort(st, p),
        "machine.takeOver.preview" => take_over_preview(st, p).await,
        "machine.takeOver" => take_over(st, p).await,
        "machine.takeOver.list" => Ok(json!({"jobs": st.machines.handoff.jobs.lock().unwrap().iter().map(Job::to_value).collect::<Vec<_>>()})),
        _ => Err(derr("not_found", "unknown handoff method", StatusCode::NOT_FOUND)),
    }
}

fn session_id_of(p: &Value) -> Result<&str, DispatchError> {
    p["sessionId"].as_str().filter(|id| !id.is_empty() && id.chars().count() <= 200).ok_or_else(|| invalid("sessionId is required"))
}

// ---------------------------------------------------------------------------
// The giving machine: what a conversation is, as the other machine may see it

/// A conversation's own task copy.
#[derive(Clone)]
struct Own {
    path: PathBuf,
    branch: String,
    base: String,
    base_commit: String,
}

#[derive(Default)]
struct GitFacts {
    identity: Option<String>,
    url: Option<String>,
    branch: Option<String>,
    has_remote: bool,
    uncommitted: u64,
    ahead: u64,
}

struct Facts {
    row: Value,
    bot_name: String,
    bot: Value,
    reason: Option<String>,
    moved_to: Value,
    own: Option<Own>,
    git: GitFacts,
}

async fn read_git(dir: &Path, args: &[&str]) -> Option<String> {
    let run = run_git(dir, args, GIT_READ).await;
    run.ok.then(|| String::from_utf8_lossy(&run.stdout).trim().to_string())
}

fn hex(text: &str) -> bool {
    !text.is_empty() && text.len() <= 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn own_copy_of(row: &Value) -> Option<Own> {
    let worktree = &row["link"]["worktree"];
    let path = PathBuf::from(worktree["path"].as_str().filter(|path| !path.trim().is_empty())?);
    path.is_dir().then(|| Own {
        path,
        branch: worktree["branch"].as_str().unwrap_or("").to_string(),
        base: worktree["base"].as_str().unwrap_or("").to_string(),
        base_commit: worktree["baseCommit"].as_str().unwrap_or("").to_string(),
    })
}

async fn git_facts(folder: &Path, own: Option<&Own>) -> GitFacts {
    let mut facts = GitFacts::default();
    if !folder.is_dir() || read_git(folder, &["rev-parse", "--show-toplevel"]).await.is_none() {
        return facts;
    }
    facts.branch = read_git(folder, &["symbolic-ref", "--short", "-q", "HEAD"]).await.filter(|branch| !branch.is_empty());
    facts.has_remote = read_git(folder, &["remote"]).await.is_some_and(|out| out.lines().any(|line| line.trim() == "origin"));
    if let Origin::Found(remote) = crate::repo_identity::of_folder(folder).await {
        facts.identity = Some(remote.identity);
        facts.url = Some(remote.url);
    }
    let status = run_git(folder, &["status", "--porcelain=v2", "-z", "--untracked-files=all"], GIT_READ).await;
    facts.uncommitted = if status.ok { parse_status(&status.stdout).len() as u64 } else { 0 };
    if let Some(own) = own.filter(|own| hex(&own.base_commit)) {
        let range = format!("{}..HEAD", own.base_commit);
        facts.ahead = read_git(folder, &["rev-list", "--count", &range]).await.and_then(|count| count.parse().ok()).unwrap_or(0);
    }
    facts
}

fn working(state: &str) -> bool {
    matches!(state, "starting" | "working" | "cancelling")
}

async fn gather(st: &AppState, session_id: &str) -> Result<Facts, DispatchError> {
    let row = st.db.session_detail(session_id).map_err(|_| derr("not_found", "Conversation not found.", StatusCode::NOT_FOUND))?;
    let agent = row["agentId"].as_str().and_then(|id| st.db.agent_get(id).ok());
    let bot_name = agent.as_ref().and_then(|agent| agent["name"].as_str()).unwrap_or("This bot").to_string();
    let moved_to = row["link"]["movedTo"].clone();
    let state = row["state"].as_str().unwrap_or("");
    let own = own_copy_of(&row);
    let folder = own.as_ref().map(|own| own.path.clone()).or_else(|| row["projectPath"].as_str().map(PathBuf::from).filter(|path| path.is_dir()));
    let git = match &folder {
        Some(folder) => git_facts(folder, own.as_ref()).await,
        None => GitFacts::default(),
    };

    let reason = if row["archived"] == true {
        Some("This conversation is archived.".to_string())
    } else if moved_to.is_object() {
        Some(format!("This conversation already moved to {}.", moved_to["name"].as_str().unwrap_or("another machine")))
    } else if st.active_turns.lock().await.contains_key(session_id) || working(state) {
        Some(format!("{bot_name} is working. Stop it or wait, then try again."))
    } else if state == "waiting_permission"
        || st.db.permissions_pending(session_id).map(|pending| !pending.is_empty()).unwrap_or(false)
        || st.db.pending_question_exists(session_id).unwrap_or(false)
    {
        Some("This conversation is waiting on an approval or a question.".to_string())
    } else if st.db.queue_count_queued(session_id).unwrap_or(0) > 0 {
        Some("This conversation has queued messages.".to_string())
    } else if st.db.delegation_list_for_origin(session_id).map(|rows| rows.iter().any(|row| !crate::delegations::is_terminal(row))).unwrap_or(false) {
        Some("This conversation has assignments running.".to_string())
    } else if agent.as_ref().is_some_and(|agent| agent["systemRole"].as_str() == Some("manager")) {
        Some("The Manager's conversations stay on their machine.".to_string())
    } else if agent.is_none()
        // Anything but a bot's own conversation: a side conversation, an automation or board task, a
        // group, or one that is itself an assignment's child.
        || !matches!(row["link"]["kind"].as_str(), None | Some("main"))
        || !row["fanoutId"].is_null()
        || st.db.delegation_list_for_side(session_id).map(|rows| !rows.is_empty()).unwrap_or(false)
    {
        Some("Only a bot's own conversations can move.".to_string())
    } else {
        None
    };
    Ok(Facts { bot: agent.unwrap_or(Value::Null), row, bot_name, reason, moved_to, own, git })
}

fn repo_value(facts: &Facts) -> Value {
    json!({
        "identity": facts.git.identity,
        "url": facts.git.url,
        "branch": facts.git.branch,
        "isWorktree": facts.own.is_some(),
        "hasRemote": facts.git.has_remote,
    })
}

fn preview_value(facts: &Facts, lease_blocks: bool) -> Value {
    let reason = facts.reason.clone().or_else(|| lease_blocks.then(|| "This conversation is already being moved.".to_string()));
    json!({
        "ready": reason.is_none(),
        "reason": reason,
        "title": facts.row["title"],
        "bot": {"id": facts.row["agentId"], "name": facts.bot_name, "provider": facts.row["provider"], "model": facts.bot["model"]},
        "repo": repo_value(facts),
        "uncommitted": facts.git.uncommitted,
        "commitsAhead": facts.git.ahead,
        "movedTo": if facts.moved_to.is_object() { json!({"machineId": facts.moved_to["machineId"], "name": facts.moved_to["name"]}) } else { Value::Null },
    })
}

async fn preview(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let sid = session_id_of(p)?;
    let facts = gather(st, sid).await?;
    Ok(preview_value(&facts, st.machines.handoff.live(sid).is_some()))
}

// ---------------------------------------------------------------------------
// The giving machine: prepare

fn step(id: &str, status: &str, detail: Option<&str>) -> Value {
    json!({"id": id, "status": status, "detail": detail})
}

/// A path shape that has no business in a package: a drive letter, a UNC share or a user's home.
fn has_host_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    let drive = bytes.windows(3).enumerate().any(|(at, window)| {
        window[0].is_ascii_alphabetic() && window[1] == b':' && (window[2] == b'\\' || window[2] == b'/') && (at == 0 || !bytes[at - 1].is_ascii_alphanumeric())
    });
    drive || text.contains("\\\\") || ["/home/", "/Users/", "/mnt/", "/var/folders/"].iter().any(|home| text.contains(home))
}

/// The conversation's text, for the package: roles `user`, `assistant` and `notice` only, newest 2,000
/// and at most 16 MiB. A notice that names a host path is left out. Returns `(messages, truncated,
/// pictures)`.
fn package_messages(row: &Value) -> (Vec<Value>, bool, u64) {
    let all = row["messages"].as_array().cloned().unwrap_or_default();
    let pictures = all.iter().map(|message| message["attachments"].as_array().map_or(0, Vec::len) as u64).sum();
    let mut kept: Vec<&Value> = all
        .iter()
        .filter(|message| match message["role"].as_str() {
            Some("user" | "assistant") => true,
            Some("notice") => !has_host_path(message["content"].as_str().unwrap_or("")),
            _ => false,
        })
        .collect();
    let mut truncated = false;
    if kept.len() > MAX_MESSAGES {
        kept = kept.split_off(kept.len() - MAX_MESSAGES);
        truncated = true;
    }
    let mut total = 0usize;
    let mut start = 0usize;
    for (at, message) in kept.iter().enumerate().rev() {
        total += message["content"].as_str().map_or(0, str::len) + 256;
        if total > MAX_BYTES {
            start = at + 1;
            truncated = true;
            break;
        }
    }
    let out = kept[start..]
        .iter()
        .map(|message| json!({"id": message["id"], "role": message["role"], "content": message["content"], "createdAt": message["createdAt"]}))
        .collect();
    (out, truncated, pictures)
}

/// The fixed note the taking machine shows: where it came from and when, the branch, and what did
/// not travel. No model writes it.
fn note_text(from: &str, facts: &Facts, head: Option<&str>, files: &[String]) -> String {
    let when = chrono::Utc::now().format("%Y-%m-%d %H:%M UTC");
    let mut text = format!("Taken over from {from} on {when}.");
    match &facts.own {
        Some(own) => {
            let short: String = head.unwrap_or("").chars().take(7).collect();
            let at = if short.is_empty() { String::new() } else { format!(" at {short}") };
            let commits = if facts.git.ahead == 1 { "1 commit".to_string() } else { format!("{} commits", facts.git.ahead) };
            text.push_str(&format!(" Branch {}{at}, {commits} ahead.", own.branch));
            if !files.is_empty() {
                let shown: Vec<&str> = files.iter().take(NOTE_FILES).map(String::as_str).collect();
                let more = files.len().saturating_sub(NOTE_FILES);
                text.push_str(&format!(" Changed: {}{}.", shown.join(", "), if more > 0 { format!(" and {more} more") } else { String::new() }));
            }
        }
        None => {
            let left = facts.git.uncommitted;
            text.push_str(&format!(" The files stayed on {from}{}.", if left > 0 { format!(", including {left} uncommitted {}", if left == 1 { "file" } else { "files" }) } else { String::new() }));
        }
    }
    text.push_str(&format!(" Pictures, tool steps and thinking stayed on {from}."));
    text
}

async fn prepare(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    if p["confirm"] != true {
        return Err(invalid("Confirm moving the conversation first."));
    }
    let sid = session_id_of(p)?;
    let to_machine = p["toMachineId"].as_str().filter(|id| client::safe_id(id)).ok_or_else(|| invalid("toMachineId is required"))?;
    let to_name = p["toName"].as_str().map(str::trim).filter(|name| (1..=NAME_MAX).contains(&name.chars().count())).ok_or_else(|| invalid("toName must be 1 to 60 characters"))?;
    let commit_uncommitted = p["commitUncommitted"].as_bool().unwrap_or(false);
    let lease = st.machines.handoff.begin(sid, to_machine, to_name).ok_or_else(|| conflict("This conversation is already being moved."))?;
    let outcome = prepare_inner(st, &lease, commit_uncommitted).await;
    if outcome.is_err() {
        st.machines.handoff.end(&lease.id);
    }
    outcome
}

/// A step failed: the lease ends and nothing moves. What already worked stays.
fn failed_prepare(st: &AppState, lease: &Lease, steps: Vec<Value>) -> Value {
    st.machines.handoff.end(&lease.id);
    json!({"handoffId": Value::Null, "steps": steps, "package": Value::Null})
}

async fn prepare_inner(st: &AppState, lease: &Lease, commit_uncommitted: bool) -> Result<Value, DispatchError> {
    let facts = gather(st, &lease.session_id).await?;
    if let Some(reason) = &facts.reason {
        return Err(conflict(reason));
    }
    let mut steps = Vec::new();

    // 1. commit: only in the conversation's own copy, only with the owner's consent.
    match (&facts.own, facts.git.uncommitted) {
        (Some(own), count) if count > 0 => {
            if !commit_uncommitted {
                steps.push(step("commit", "failed", Some("There are uncommitted files.")));
                return Ok(failed_prepare(st, lease, steps));
            }
            let (dir, message) = (own.path.clone(), format!("Handoff to {}", lease.to_name));
            let task = tokio::task::spawn_blocking(move || crate::worktree::commit_all(&dir, &message));
            match tokio::time::timeout(COMMIT_LIMIT, task).await {
                Ok(Ok(Ok(()))) => steps.push(step("commit", "done", None)),
                _ => {
                    steps.push(step("commit", "failed", Some("The uncommitted files could not be committed.")));
                    return Ok(failed_prepare(st, lease, steps));
                }
            }
        }
        (Some(_), _) => steps.push(step("commit", "skipped", Some("Nothing to commit."))),
        (None, _) => steps.push(step("commit", "skipped", Some("This conversation has no copy of its own."))),
    }

    // 2. push: the copy's own branch, never forced, never the base.
    match (&facts.own, facts.git.has_remote) {
        (Some(own), true) => {
            let branch = own.branch.as_str();
            let on_it = facts.git.branch.as_deref() == Some(branch);
            if !branch.starts_with("bitbots/") || branch == own.base || !on_it {
                steps.push(step("push", "failed", Some("Only the conversation's own bitbots/ branch can be pushed.")));
                return Ok(failed_prepare(st, lease, steps));
            }
            let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
            let git = OsString::from("git");
            let ran = crate::scaffold::run(&git, Some(&own.path), &["-c", "protocol.ext.allow=never", "push", "-u", "origin", &refspec], None, PUSH_LIMIT).await;
            if ran.ok {
                steps.push(step("push", "done", None));
            } else {
                let detail = if ran.timed_out { "The push took too long and was stopped." } else { "The branch could not be pushed." };
                steps.push(step("push", "failed", Some(detail)));
                return Ok(failed_prepare(st, lease, steps));
            }
        }
        (Some(_), false) => steps.push(step("push", "skipped", Some("This repository has no remote."))),
        (None, _) => steps.push(step("push", "skipped", Some("This conversation has no copy of its own."))),
    }

    // The package.
    let row = st.db.session_detail(&lease.session_id).map_err(internal)?;
    let (messages, truncated, pictures) = package_messages(&row);
    let tool_steps = row["tools"].as_array().map_or(0, Vec::len);
    let runtimes = st.runtimes.read().await.clone();
    let agent = st.db.agent_get(row["agentId"].as_str().unwrap_or("")).map_err(internal)?;
    let bot = crate::backup::export_bot(&agent, &runtimes);
    let head = match &facts.own {
        Some(own) => read_git(&own.path, &["rev-parse", "HEAD"]).await,
        None => None,
    };
    let files: Vec<String> = match facts.own.as_ref().filter(|own| hex(&own.base_commit)) {
        Some(own) => read_git(&own.path, &["diff", "--name-only", &format!("{}..HEAD", own.base_commit)])
            .await
            .map(|out| out.lines().map(|line| line.trim().chars().take(160).collect::<String>()).filter(|line| !line.is_empty()).collect())
            .unwrap_or_default(),
        None => Vec::new(),
    };
    // The uncommitted count above was read before the commit step; after it, the copy is clean.
    let mut after = facts;
    if after.own.is_some() {
        after.git.uncommitted = 0;
    }
    let note = note_text(&machines::machine_name(st), &after, head.as_deref(), &files);
    let package = json!({
        "version": 1,
        "session": {
            "id": row["id"], "title": row["title"], "createdAt": row["createdAt"],
            "branch": after.own.as_ref().map(|own| own.branch.clone()), "isWorktree": after.own.is_some(),
        },
        "bot": bot,
        "repo": {"identity": after.git.identity, "url": after.git.url, "branch": after.git.branch, "head": head},
        "note": note,
        "messages": messages,
        "truncated": truncated,
        "omitted": {"pictures": pictures, "toolSteps": tool_steps},
    });
    Ok(json!({"handoffId": lease.id, "steps": steps, "package": package}))
}

// ---------------------------------------------------------------------------
// The giving machine: commit and abort

async fn commit(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = p["handoffId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid("handoffId is required"))?;
    let gone = || conflict("That move isn't in progress any more, or it took too long. Start it again.");
    let lease = st.machines.handoff.find(id).ok_or_else(gone)?;
    let sid = lease.session_id.clone();
    let gate = crate::gate_for_session(st, &sid).await;
    let active = {
        // The same gate a new send takes before it reserves a turn, so exactly one of "a turn
        // starts" and "the conversation moves" wins.
        let _guard = gate.lock().await;
        if st.machines.handoff.find(id).is_none() {
            return Err(gone());
        }
        let busy = st.active_turns.lock().await.contains_key(&sid) || st.db.session_state(&sid).ok().flatten().is_some_and(|state| working(&state) || state == "waiting_permission");
        if busy {
            st.machines.handoff.end(id);
            return Err(conflict("This conversation started working again, so the move was cancelled."));
        }
        let row = st.db.session_brief(&sid).map_err(|_| derr("not_found", "Conversation not found.", StatusCode::NOT_FOUND))?;
        let mut link = row["link"].as_object().cloned().unwrap_or_default();
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        link.insert("movedTo".to_string(), json!({"machineId": lease.to_machine, "name": lease.to_name, "at": at}));
        st.db.set_session_link(&sid, &Value::Object(link)).map_err(internal)?;
        st.machines.handoff.end(id);
        let active = st.sessions.lock().await.remove(&sid);
        st.warm_lru.lock().await.retain(|warmed| warmed != &sid);
        let _ = st.db.update_session_state(&sid, "closed");
        if let Ok(summary) = st.db.session_event_summary(&sid) {
            st.emit("session.changed", summary).await;
        }
        active
    };
    crate::team::note(st, &sid, &format!("Moved to {}.", lease.to_name), json!({"kind": "handoff", "direction": "out", "toMachineId": lease.to_machine, "toName": lease.to_name})).await;
    if let Some(session) = active {
        let _ = session.adapter.close_session(&session.handle).await;
    }
    Ok(json!({"ok": true}))
}

fn abort(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = p["handoffId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid("handoffId is required"))?;
    st.machines.handoff.end(id);
    Ok(json!({"ok": true}))
}

// ---------------------------------------------------------------------------
// The taking machine: talking to the giving one

/// A sentence for a call to the giving machine that did not give an answer.
fn describe(st: &AppState, machine_id: &str, error: ClientError) -> String {
    let name = st.db.machine_link_get(machine_id).ok().flatten().and_then(|link| link["name"].as_str().map(str::to_string)).unwrap_or_else(|| "That machine".to_string());
    match &error {
        ClientError::Remote { code, .. } if code == "tier_required" => {
            format!("This machine needs Chat and approve on {name} to take over a conversation. Change it in {name}'s Remote settings.")
        }
        ClientError::Remote { message, .. } if message == "not on the remote allowlist" || message == "method is not supported" => {
            format!("{name} needs a newer version of Bitbots to hand a conversation over.")
        }
        ClientError::Remote { code, .. } if code == "forbidden_remote" => format!("{name} doesn't let this machine move conversations."),
        _ => machines::failure(st, machine_id, error).1.message,
    }
}

async fn call(st: &AppState, machine_id: &str, method: &str, params: Value, limit: Duration) -> Result<Value, String> {
    client::rpc_with_timeout(st, machine_id, method, params, limit).await.map_err(|error| describe(st, machine_id, error))
}

fn provider_label(provider: &str) -> &str {
    bloblex_runtime::provider_display_name(provider)
}

/// The local bot for the other machine's: the same id, else the same name and provider.
fn local_bot(st: &AppState, runtimes: &[Value], bot: &Value) -> Option<Value> {
    let agents = st.db.agent_list(false, None).unwrap_or_default();
    let provider = bot["provider"].as_str().unwrap_or("");
    let provider_of = |agent: &Value| runtimes.iter().find(|runtime| runtime["id"] == agent["runtimeId"]).and_then(|runtime| runtime["provider"].as_str()).map(str::to_string);
    if let Some(id) = bot["id"].as_str() {
        if let Some(agent) = agents.iter().find(|agent| agent["id"].as_str() == Some(id)) {
            return Some(agent.clone());
        }
    }
    let name = bot["name"].as_str().unwrap_or("").to_lowercase();
    agents
        .into_iter()
        .find(|agent| agent["name"].as_str().map(str::to_lowercase).as_deref() == Some(name.as_str()) && provider_of(agent).as_deref() == Some(provider))
}

async fn take_over_preview(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let machine = p["machineId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid("machineId is required"))?;
    let sid = session_id_of(p)?;
    st.db.machine_link_get(machine).map_err(internal)?.ok_or_else(|| derr("not_found", "That machine isn't linked.", StatusCode::NOT_FOUND))?;
    let remote = call(st, machine, "handoff.preview", json!({"sessionId": sid}), CALL_LIMIT).await.map_err(|message| derr("provider_unavailable", &message, StatusCode::BAD_GATEWAY))?;
    let runtimes = st.runtimes.read().await.clone();
    let provider = remote["bot"]["provider"].as_str().unwrap_or("");
    let runtime_ready = crate::backup::first_runtime_for(&runtimes, provider).is_some();
    let bot = local_bot(st, &runtimes, &remote["bot"]);
    let project = remote["repo"]["identity"].as_str().and_then(|identity| {
        crate::repo_identity::find_by_identity(st, &json!({"identity": identity})).ok().and_then(|found| found["project"].as_object().map(|project| json!({"id": project["id"], "name": project["name"]})))
    });
    let needs_project = remote["repo"]["identity"].is_string() && project.is_none();
    // The conversation already moved *here* and only the opening is left (a crash, or a failed last step).
    let coming_home = returning(st, machine, sid, &remote);
    let mut ready = remote["ready"] == true || coming_home;
    let mut reason = if coming_home { Value::Null } else { remote["reason"].clone() };
    if live_here(st, machine, sid) {
        ready = false;
        reason = json!(ALREADY_HERE);
    }
    if ready && !runtime_ready {
        ready = false;
        reason = json!(format!("{} isn't installed on this machine.", provider_label(provider)));
    }
    Ok(json!({
        "ready": ready,
        "reason": reason,
        "title": remote["title"],
        "bot": {
            "id": remote["bot"]["id"], "name": remote["bot"]["name"], "provider": remote["bot"]["provider"], "model": remote["bot"]["model"],
            "agentId": bot.as_ref().map(|bot| bot["id"].clone()).unwrap_or(Value::Null), "willCreate": bot.is_none(),
        },
        "repo": remote["repo"],
        "uncommitted": remote["uncommitted"],
        "commitsAhead": remote["commitsAhead"],
        "project": project,
        "needsProject": needs_project,
        "runtimeReady": runtime_ready,
    }))
}

const ALREADY_HERE: &str = "This conversation is already on this machine.";

/// Whether this machine already has a row with this id that isn't the other machine's conversation
/// waiting here: only a row whose `link.movedTo` names the giving machine may be updated by a take-over.
fn live_here(st: &AppState, machine_id: &str, session_id: &str) -> bool {
    st.db.session_brief(session_id).ok().is_some_and(|row| row["link"]["movedTo"]["machineId"].as_str() != Some(machine_id))
}

/// Whether the other machine says this conversation is already ours and our own row waits to be
/// opened: its `movedTo` names this machine, and ours names it.
fn returning(st: &AppState, machine_id: &str, session_id: &str, remote_preview: &Value) -> bool {
    let me = machines::machine_id(st);
    remote_preview["movedTo"]["machineId"].as_str() == Some(me.as_str())
        && st.db.session_brief(session_id).ok().is_some_and(|row| row["link"]["movedTo"]["machineId"].as_str() == Some(machine_id))
}

// ---------------------------------------------------------------------------
// The taking machine: the job

struct Args {
    machine_id: String,
    machine_name: String,
    session_id: String,
    project_id: Option<String>,
    commit_uncommitted: bool,
}

/// What to put back when a step fails before the giving machine commits.
enum Undo {
    Nothing,
    /// The import made this row: remove it.
    Delete,
    /// The import changed a row this machine already had: put it back as it was.
    Restore { snapshot: Value, before: Vec<String> },
}

struct Run<'a> {
    st: &'a AppState,
    job: &'a str,
    args: &'a Args,
    handoff_id: Option<String>,
    undo: Undo,
}

/// A step that did not work: which one, and the sentence the owner reads.
struct Fail {
    step: &'static str,
    detail: String,
}

fn fail(step: &'static str, detail: impl Into<String>) -> Fail {
    Fail { step, detail: detail.into() }
}

async fn take_over(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    if p["confirm"] != true {
        return Err(invalid("Confirm taking the conversation over first."));
    }
    let machine = p["machineId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid("machineId is required"))?;
    let sid = session_id_of(p)?;
    let link = st.db.machine_link_get(machine).map_err(internal)?.ok_or_else(|| derr("not_found", "That machine isn't linked.", StatusCode::NOT_FOUND))?;
    let project_id = match p.get("projectId") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let id = value.as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid("projectId must be a string"))?;
            let project = st.db.project_get(id).map_err(|_| derr("not_found", "That project no longer exists.", StatusCode::NOT_FOUND))?;
            if !project["path"].as_str().is_some_and(|path| Path::new(path).is_dir()) {
                return Err(invalid("That project has no folder on this computer."));
            }
            Some(id.to_string())
        }
    };
    let args = Args {
        machine_id: machine.to_string(),
        machine_name: link["name"].as_str().unwrap_or("That machine").to_string(),
        session_id: sid.to_string(),
        project_id,
        commit_uncommitted: p["commitUncommitted"].as_bool().unwrap_or(false),
    };
    let job = Job { id: uuid::Uuid::new_v4().to_string(), machine_id: args.machine_id.clone(), session_id: args.session_id.clone(), state: "running", steps: Vec::new(), detail: None };
    let value = {
        let mut jobs = st.machines.handoff.jobs.lock().unwrap();
        if jobs.iter().any(|other| other.state == "running" && other.session_id == args.session_id) {
            return Err(conflict("This conversation is already being taken over."));
        }
        jobs.push(job.clone());
        while jobs.len() > MAX_JOBS {
            match jobs.iter().position(|other| other.state != "running") {
                Some(at) => {
                    jobs.remove(at);
                }
                None => break,
            }
        }
        job.to_value()
    };
    let (st2, job_id) = (st.clone(), job.id.clone());
    tokio::spawn(async move { run_job(&st2, &job_id, &args).await });
    Ok(json!({"job": value}))
}

async fn emit_job(st: &AppState, value: Option<Value>) {
    if let Some(job) = value {
        st.emit("machine.takeOver.changed", json!({"job": job})).await;
    }
}

async fn add_step(st: &AppState, job: &str, id: &str, status: &str, detail: Option<&str>) {
    let value = st.machines.handoff.job_update(job, |job| job.steps.push(step(id, status, detail)));
    emit_job(st, value).await;
}

async fn finish(st: &AppState, job: &str, state: &'static str, detail: Option<String>) {
    let value = st.machines.handoff.job_update(job, |job| {
        job.state = state;
        job.detail = detail;
    });
    emit_job(st, value).await;
}

async fn run_job(st: &AppState, job: &str, args: &Args) {
    let mut run = Run { st, job, args, handoff_id: None, undo: Undo::Nothing };
    match run.execute().await {
        Ok(detail) => finish(st, job, "done", detail).await,
        Err(failure) => {
            run.rollback().await;
            add_step(st, job, failure.step, "failed", Some(&failure.detail)).await;
            finish(st, job, "failed", Some(failure.detail)).await;
        }
    }
}

fn package_ok(package: &Value, session_id: &str) -> bool {
    let text = |value: &Value| value.as_str().is_some();
    package["version"] == 1
        && package["session"]["id"].as_str() == Some(session_id)
        && text(&package["session"]["title"])
        && text(&package["bot"]["name"])
        && text(&package["bot"]["provider"])
        && package["messages"].as_array().is_some_and(|messages| {
            messages.len() <= MAX_MESSAGES
                && messages.iter().map(|message| message["content"].as_str().map_or(0, str::len)).sum::<usize>() <= MAX_BYTES
                && messages.iter().all(|message| text(&message["id"]) && text(&message["role"]) && text(&message["content"]))
        })
        && text(&package["note"])
}

impl Run<'_> {
    async fn execute(&mut self) -> Result<Option<String>, Fail> {
        let (st, args) = (self.st, self.args);
        let sid = args.session_id.as_str();
        let hand = &st.machines.handoff;

        // Before anything changes anywhere: can the other machine give it, and can this one run it?
        if live_here(st, &args.machine_id, sid) {
            return Err(fail("prepare", ALREADY_HERE));
        }
        let preview = call(st, &args.machine_id, "handoff.preview", json!({"sessionId": sid}), CALL_LIMIT).await.map_err(|detail| fail("prepare", detail))?;
        let coming_home = returning(st, &args.machine_id, sid, &preview);
        if preview["ready"] != true && !coming_home {
            return Err(fail("prepare", preview["reason"].as_str().unwrap_or("That conversation can't be moved right now.")));
        }
        let provider = preview["bot"]["provider"].as_str().unwrap_or("").to_string();
        let runtimes = st.runtimes.read().await.clone();
        let Some(runtime_id) = crate::backup::first_runtime_for(&runtimes, &provider) else {
            return Err(fail("prepare", format!("{} isn't installed on this machine.", provider_label(&provider))));
        };

        if coming_home {
            // Committed on the other machine already; only the opening is left.
            for id in ["prepare", "code", "bot", "import", "commit"] {
                add_step(st, self.job, id, "skipped", Some("Already moved to this machine.")).await;
            }
            return self.open(None, &args.machine_name.clone()).await;
        }

        // 1. prepare
        if hand.failpoint("prepare") {
            return Err(fail("prepare", "Test failure."));
        }
        let prepared = call(
            st,
            &args.machine_id,
            "handoff.prepare",
            json!({"sessionId": sid, "commitUncommitted": args.commit_uncommitted, "toMachineId": machines::machine_id(st), "toName": machines::machine_name(st), "confirm": true}),
            PREPARE_LIMIT,
        )
        .await
        .map_err(|detail| fail("prepare", detail))?;
        if let Some(failed) = prepared["steps"].as_array().and_then(|steps| steps.iter().find(|step| step["status"] == "failed")) {
            let detail = failed["detail"].as_str().unwrap_or("The other machine couldn't get the conversation ready.");
            return Err(fail("prepare", detail));
        }
        let (Some(handoff_id), true) = (prepared["handoffId"].as_str(), package_ok(&prepared["package"], sid)) else {
            return Err(fail("prepare", "The other machine sent something this version can't read."));
        };
        self.handoff_id = Some(handoff_id.to_string());
        let package = prepared["package"].clone();
        let pushed = prepared["steps"].as_array().is_some_and(|steps| steps.iter().any(|step| step["id"] == "push" && step["status"] == "done"));
        add_step(st, self.job, "prepare", "done", None).await;

        // 2. code
        if hand.failpoint("code") {
            return Err(fail("code", "Test failure."));
        }
        let project_path = args.project_id.as_deref().and_then(|id| st.db.project_get(id).ok()).and_then(|project| project["path"].as_str().map(PathBuf::from));
        let branch = package["session"]["branch"].as_str().map(str::to_string);
        let mut copy = None;
        match (package["session"]["isWorktree"] == true, pushed, &project_path, &branch) {
            (true, true, Some(repo), Some(branch)) => {
                let (repo, branch) = (repo.clone(), branch.clone());
                let task = tokio::task::spawn_blocking(move || crate::worktree_attach::attach_branch(&repo, &branch));
                match tokio::time::timeout(ATTACH_LIMIT, task).await {
                    Ok(Ok(Ok(attached))) => {
                        copy = Some(attached);
                        add_step(st, self.job, "code", "done", None).await;
                    }
                    Ok(Ok(Err(reason))) => return Err(fail("code", reason)),
                    _ => return Err(fail("code", "The branch could not be fetched in time.")),
                }
            }
            (false, ..) => add_step(st, self.job, "code", "skipped", Some(&format!("This conversation has no copy of its own, so its files stayed on {}.", args.machine_name))).await,
            (true, _, None, _) => add_step(st, self.job, "code", "skipped", Some(&format!("No project was chosen, so the code stayed on {}.", args.machine_name))).await,
            _ => add_step(st, self.job, "code", "skipped", Some(&format!("The branch wasn't pushed, so the code stayed on {}.", args.machine_name))).await,
        }

        // 3. bot
        if hand.failpoint("bot") {
            return Err(fail("bot", "Test failure."));
        }
        let (agent, created) = self.bot_for(&package["bot"], &runtime_id).await.map_err(|detail| fail("bot", detail))?;
        add_step(st, self.job, "bot", "done", created.then_some("Made a copy of the bot on this machine.")).await;

        // 4. import: the row exists here, still owned by the other machine.
        if hand.failpoint("import") {
            return Err(fail("import", "Test failure."));
        }
        self.import(&package, &agent, &provider, &runtime_id, copy.as_ref(), project_path.as_deref()).await.map_err(|detail| fail("import", detail))?;
        if hand.failpoint("import_after") {
            return Err(fail("import", "Test failure."));
        }
        add_step(st, self.job, "import", "done", None).await;

        // 5. commit: the one step that flips ownership.
        if hand.failpoint("commit") {
            return Err(fail("commit", "Test failure."));
        }
        let answer = client::rpc_with_timeout(st, &args.machine_id, "handoff.commit", json!({"handoffId": handoff_id}), CALL_LIMIT).await;
        // A test can lose a reply that did arrive.
        let answer = if hand.failpoint("commit_lost") { answer.and(Err(ClientError::Unreachable)) } else { answer };
        match answer {
            Ok(_) => {}
            // The other machine answered and refused: it still has the conversation.
            Err(ClientError::Remote { message, .. }) => return Err(fail("commit", message)),
            Err(ClientError::Revoked) => return Err(fail("commit", describe(st, &args.machine_id, ClientError::Revoked))),
            Err(ClientError::Invalid(message)) => return Err(fail("commit", message)),
            // No answer: it may or may not have committed. Ask, rather than guess.
            Err(ClientError::Unreachable | ClientError::TooLarge) => match self.moved_here(sid).await {
                Some(true) => {}
                Some(false) => return Err(fail("commit", "The other machine did not move the conversation.")),
                None => {
                    // Neither side can run it until this is settled: leave the import as it is, so a retry can finish.
                    self.handoff_id = None;
                    self.undo = Undo::Nothing;
                    return Err(fail("commit", format!("{} didn't answer, so it isn't clear who has the conversation. Nothing can run it until you take it over again.", args.machine_name)));
                }
            },
        }
        // From here the other machine no longer runs it, and nothing is undone.
        self.handoff_id = None;
        self.undo = Undo::Nothing;
        add_step(st, self.job, "commit", "done", None).await;

        // 6. open
        self.open(Some(&package), &args.machine_name.clone()).await
    }

    /// Asks the other machine whether it gave the conversation to this one. `None` when it can't say.
    async fn moved_here(&self, session_id: &str) -> Option<bool> {
        let me = machines::machine_id(self.st);
        let wait = self.st.machines.poll_every();
        for attempt in 0..3 {
            if attempt > 0 {
                tokio::time::sleep(wait).await;
            }
            if let Ok(preview) = client::rpc_with_timeout(self.st, &self.args.machine_id, "handoff.preview", json!({"sessionId": session_id}), CALL_LIMIT).await {
                return Some(preview["movedTo"]["machineId"].as_str() == Some(me.as_str()));
            }
        }
        None
    }

    /// The local bot for the package's, or a new one. A new bot never has Full access (that mode
    /// becomes this machine's default for new bots) and never has environment values.
    async fn bot_for(&self, bot: &Value, runtime_id: &str) -> Result<(Value, bool), String> {
        let st = self.st;
        let runtimes = st.runtimes.read().await.clone();
        // `export_bot` names the other machine's bot id `exportId`; the preview calls it `id`.
        let wanted = json!({"id": bot["exportId"], "name": bot["name"], "provider": bot["provider"]});
        if let Some(agent) = local_bot(st, &runtimes, &wanted) {
            return Ok((agent, false));
        }
        let approval = match bot["approvalMode"].as_str() {
            Some(mode @ ("ask" | "auto" | "accept_edits")) => json!(mode),
            _ => Value::Null,
        };
        let base_name = bot["name"].as_str().unwrap_or("Bot").trim().to_string();
        for attempt in 1..=6 {
            let name = if attempt == 1 { base_name.clone() } else { format!("{base_name} ({attempt})") };
            let fields = json!({
                "name": name,
                "runtimeId": runtime_id,
                "description": bot["description"].as_str().unwrap_or(""),
                "instructions": bot["instructions"].as_str().unwrap_or(""),
                "color": bot["color"].as_str().unwrap_or("mint"),
                "outfit": bot["outfit"].as_str().unwrap_or("auto"),
                "look": bot["look"],
                "role": bot["role"].as_str().unwrap_or(""),
                "model": bot["model"],
                "thinking": bot["thinking"],
                "serviceTier": bot["serviceTier"],
                "approvalMode": approval,
                "notificationLevel": bot["notificationLevel"],
                "leader": false,
                "hidden": bot["hidden"].as_bool().unwrap_or(false),
                "maxConcurrency": bot["maxConcurrency"].as_i64().filter(|count| (1..=50).contains(count)).unwrap_or(1),
                "customArgs": [],
                "customEnv": {},
            });
            match crate::agent_create_from_rpc(st, fields.clone()).await {
                Ok(agent) => return Ok((agent, true)),
                Err((_, error)) if error.code == "conflict" => continue,
                Err(_) => {
                    // This machine's catalog may not offer the other bot's model: take the default instead.
                    let mut plain = fields;
                    for key in ["model", "thinking", "serviceTier"] {
                        plain[key] = Value::Null;
                    }
                    match crate::agent_create_from_rpc(st, plain).await {
                        Ok(agent) => return Ok((agent, true)),
                        Err((_, error)) if error.code == "conflict" => continue,
                        Err(_) => return Err("A copy of the bot could not be made on this machine.".to_string()),
                    }
                }
            }
        }
        Err("A copy of the bot could not be made on this machine.".to_string())
    }

    /// Writes the conversation here with `movedTo` still pointing at the other machine, so nothing
    /// can run it until `open`. A row this machine already has (the conversation coming back) is
    /// updated, not duplicated; its messages stay and only the new ones are added.
    async fn import(&mut self, package: &Value, agent: &Value, provider: &str, runtime_id: &str, copy: Option<&crate::worktree::Worktree>, project: Option<&Path>) -> Result<(), String> {
        let (st, args) = (self.st, self.args);
        let sid = args.session_id.as_str();
        let snapshot = st.db.session_snapshot(sid).map_err(|_| "The conversation could not be stored.".to_string())?;
        if live_here(st, &args.machine_id, sid) {
            return Err(ALREADY_HERE.to_string());
        }
        let before = if snapshot.is_some() { st.db.session_message_ids(sid).unwrap_or_default() } else { Vec::new() };
        let old_data = snapshot.as_ref().and_then(|row| row["data"].as_str()).and_then(|data| serde_json::from_str::<Value>(data).ok()).filter(Value::is_object);
        let mut link = old_data.as_ref().and_then(|data| data["link"].as_object().cloned()).unwrap_or_default();
        if let Some(copy) = copy {
            link.insert("worktree".to_string(), copy.to_json());
        }
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        link.insert("movedTo".to_string(), json!({"machineId": args.machine_id, "name": args.machine_name, "at": at}));
        let mut data = old_data.unwrap_or_else(|| json!({}));
        if let Some(object) = data.as_object_mut() {
            object.remove("link");
        }
        if let Some(project_id) = &args.project_id {
            data["projectId"] = json!(project_id);
        }
        let folder = match (copy, project) {
            (Some(copy), _) => copy.path.clone(),
            (None, Some(project)) => project.to_path_buf(),
            (None, None) => crate::team::private_workspace(st, agent),
        };
        let row = json!({
            "id": sid,
            "provider": provider,
            "runtimeId": agent["runtimeId"].as_str().unwrap_or(runtime_id),
            "title": package["session"]["title"],
            "projectPath": folder.to_string_lossy(),
            "state": "idle",
            "link": Value::Object(link),
            "agentId": agent["id"],
            "createdAt": package["session"]["createdAt"],
            "data": data,
        });
        self.undo = match snapshot {
            Some(snapshot) => Undo::Restore { snapshot, before },
            None => Undo::Delete,
        };
        st.db.session_import(&row).map_err(|_| "The conversation could not be stored.".to_string())?;
        st.db.session_import_messages(sid, &package["messages"]).map_err(|_| "The conversation's messages could not be stored.".to_string())?;
        Ok(())
    }

    /// The last step: the conversation is this machine's. Clearing `movedTo` is the part that
    /// matters, so it comes first; the summary for the agent and the note follow.
    async fn open(&mut self, package: Option<&Value>, from_name: &str) -> Result<Option<String>, Fail> {
        let (st, args) = (self.st, self.args);
        let sid = args.session_id.as_str();
        let unfinished = "It moved, but this machine couldn't open it. Take it over again to finish.";
        if st.machines.handoff.failpoint("open_clear") {
            return Err(fail("open", unfinished));
        }
        let row = st.db.session_brief(sid).map_err(|_| fail("open", "The conversation is no longer here."))?;
        let mut link = row["link"].as_object().cloned().unwrap_or_default();
        link.remove("movedTo");
        st.db.set_session_link(sid, &Value::Object(link)).map_err(|_| fail("open", unfinished))?;
        let mut warning = None;
        if st.machines.handoff.failpoint("open") {
            warning = Some("It's on this machine now, but the summary for the agent couldn't be added.".to_string());
        } else {
            crate::knowledge::announce_context_loss(st, sid).await;
            let note = package.and_then(|package| package["note"].as_str()).map(str::to_string).unwrap_or_else(|| format!("Taken over from {from_name}."));
            crate::team::note(st, sid, &note, json!({"kind": "handoff", "fromMachineId": args.machine_id, "fromName": args.machine_name})).await;
        }
        // A fresh copy runs the project's setup steps before its first turn, as any new copy does.
        if let Ok(row) = st.db.session_detail(sid) {
            let folder = PathBuf::from(row["projectPath"].as_str().unwrap_or(""));
            if crate::project_setup::wanted(st, row["projectId"].as_str(), &row["link"], &folder) {
                let _ = st.db.merge_session_data(sid, &json!({"setupPending": true}));
            }
        }
        if let Ok(summary) = st.db.session_event_summary(sid) {
            st.emit("session.changed", summary).await;
        }
        add_step(st, self.job, "open", "done", warning.as_deref()).await;
        Ok(warning)
    }

    /// Undoes what a failed take-over did here, before the other machine committed. Nothing the
    /// other machine owns is touched: its lease just ends.
    async fn rollback(&mut self) {
        let (st, args) = (self.st, self.args);
        if let Some(handoff_id) = self.handoff_id.take() {
            let _ = client::rpc_with_timeout(st, &args.machine_id, "handoff.abort", json!({"handoffId": handoff_id}), Duration::from_secs(10)).await;
        }
        match std::mem::replace(&mut self.undo, Undo::Nothing) {
            Undo::Nothing => {}
            Undo::Delete => {
                let _ = st.db.session_delete(&args.session_id);
            }
            Undo::Restore { snapshot, before } => {
                let added: Vec<String> = st.db.session_message_ids(&args.session_id).unwrap_or_default().into_iter().filter(|id| !before.contains(id)).collect();
                let _ = st.db.session_remove_messages(&args.session_id, &added);
                let _ = st.db.session_restore(&snapshot);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

#[test]
fn the_package_caps_its_messages() {
    let message = |at: usize, text: &str| json!({"id": format!("m{at}"), "role": "assistant", "content": text, "createdAt": "2026-10-01T00:00:00.000Z"});
    let many: Vec<Value> = (0..2_050).map(|at| message(at, "x")).collect();
    let (kept, truncated, _) = package_messages(&json!({"messages": many}));
    assert_eq!(kept.len(), 2_000);
    assert!(truncated);
    assert_eq!(kept[0]["id"], "m50", "the newest 2,000 are kept");
    assert_eq!(kept[1_999]["id"], "m2049");
    let big = "y".repeat(6 * 1024 * 1024);
    let heavy: Vec<Value> = (0..4).map(|at| message(at, &big)).collect();
    let (kept, truncated, _) = package_messages(&json!({"messages": heavy}));
    assert!(truncated && kept.len() == 2, "16 MiB holds the newest two of four 6 MiB messages, got {}", kept.len());
    assert_eq!(kept[1]["id"], "m3");
    let few: Vec<Value> = (0..3).map(|at| message(at, "short")).collect();
    let (kept, truncated, _) = package_messages(&json!({"messages": few}));
    assert!(!truncated && kept.len() == 3);
}
#[test]
fn a_notice_with_a_host_path_is_recognised() {
    for text in ["Worked in C:\\Users\\sam\\repo", "see D:/work/app", "at /home/sam/app", "in /Users/sam/app", "\\\\server\\share\\x"] {
        assert!(has_host_path(text), "{text}");
    }
    for text in ["Moved to Desk.", "Messaged Mate", "See src/main.rs and a:b", "Fixed 3 files"] {
        assert!(!has_host_path(text), "{text}");
    }
}
#[test]
fn the_note_is_fixed_text_that_names_the_branch_and_what_stayed() {
    let facts = Facts {
        row: json!({}),
        bot_name: "Rae".into(),
        bot: Value::Null,
        reason: None,
        moved_to: Value::Null,
        own: Some(Own { path: PathBuf::from("."), branch: "bitbots/fix".into(), base: "main".into(), base_commit: "abc".into() }),
        git: GitFacts { ahead: 3, ..GitFacts::default() },
    };
    let files: Vec<String> = (0..15).map(|at| format!("src/f{at}.rs")).collect();
    let note = note_text("Desk", &facts, Some("0123456789abcdef"), &files);
    assert!(note.starts_with("Taken over from Desk on "), "{note}");
    assert!(note.contains("Branch bitbots/fix at 0123456, 3 commits ahead."), "{note}");
    assert!(note.contains("src/f11.rs and 3 more."), "at most 12 files: {note}");
    assert!(!note.contains("src/f12.rs"));
    assert!(note.ends_with("Pictures, tool steps and thinking stayed on Desk."));
}
}
