//! Team engine. Blobs belong to projects, carry a role, and one of them can lead.
//! Each provider session gets Bitbots' runtime instructions and an app-owned
//! MCP server (`bitbotsd mcp-bridge`) with `list_blobs`, `list_conversations`
//! and `message_blob`. `message_blob` opens a side conversation with the
//! teammate, titled by its topic, or continues an earlier one; when the
//! teammate's turn ends, its reply is relayed back into the sender's
//! conversation, which wakes the sender to report to the user.

use crate::{agent_error, bot_is_locked, derr, locked_bot_error, new_session, AppState, DispatchError};
use axum::http::StatusCode;
use bloblex_agent_core::{ExecOptions, McpServerSpec};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::Mutex as StdMutex,
};
use tokio::sync::Mutex;
use uuid::Uuid;

/// Longest chain of blob-to-blob hops one user request may start.
const MAX_DEPTH: u32 = 6;
pub const SERVER_NAME: &str = "bloblex";

#[derive(Default)]
pub struct Team {
    /// session id -> per-session MCP capability, and the reverse lookup.
    tokens: StdMutex<HashMap<String, String>>,
    grants: StdMutex<HashMap<String, String>>,
    pub address: StdMutex<Option<String>>,
    pub data_dir: StdMutex<Option<PathBuf>>,
    /// Hop depth of the turn currently running in a session.
    depth: StdMutex<HashMap<String, u32>>,
    /// A proposal can be approved only once, even when two surfaces decide it.
    pub(crate) proposal_decision: Mutex<()>,
    /// Prompts waiting for a busy session to finish its turn.
    queued: Mutex<HashMap<String, VecDeque<Queued>>>,
}

#[derive(Clone)]
struct Queued { id: String, text: String, meta: Value, depth: u32 }

/// Whether a waiting item is the same delivery: one assignment's brief, one
/// assignment's reply, or one request's update, is never queued twice. An update
/// is told apart by its request id, so two requests on one assignment both go out
/// while neither is queued twice.
fn same_delivery(item: &Queued, meta: &Value) -> bool {
    let Some(id) = meta["delegationId"].as_str().filter(|id| !id.is_empty()) else { return false };
    item.meta["delegationId"].as_str() == Some(id)
        && item.meta["kind"] == meta["kind"]
        && item.meta["requestId"] == meta["requestId"]
}

/// Adds one delivery to a session's queue, at the back or at the front, unless
/// that same delivery already waits there. Returns `(pushed, was_empty)`.
fn enqueue(queues: &mut HashMap<String, VecDeque<Queued>>, session_id: &str, item: Queued, front: bool) -> (bool, bool) {
    let queue = queues.entry(session_id.to_owned()).or_default();
    let was_empty = queue.is_empty();
    if queue.iter().any(|existing| same_delivery(existing, &item.meta)) { return (false, was_empty); }
    if front { queue.push_front(item); } else { queue.push_back(item); }
    (true, was_empty)
}

/// The tags line the team tools add to a project or a bot, or an empty string.
fn tags_suffix(tags: &Value) -> String {
    let list = tags.as_array().map(|tags| tags.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default();
    if list.is_empty() { String::new() } else { format!(" · tags: {}", list.join(", ")) }
}

impl Team {
    fn token_for(&self, session_id: &str) -> String {
        let mut tokens = self.tokens.lock().unwrap();
        if let Some(token) = tokens.get(session_id) { return token.clone(); }
        let token = bloblex_security::new_capability();
        tokens.insert(session_id.to_owned(), token.clone());
        self.grants.lock().unwrap().insert(token.clone(), session_id.to_owned());
        token
    }
    #[cfg(test)]
    pub(crate) fn token_for_test(&self, session_id: &str) -> String { self.token_for(session_id) }
    pub fn grant(&self, token: &str) -> Option<String> {
        let grants = self.grants.lock().unwrap();
        grants.iter().find(|(candidate, _)| bloblex_security::capability_matches(candidate, token)).map(|(_, session)| session.clone())
    }
    /// The hop depth a session's current turn is running at, so a delivery made
    /// from outside this module (a child's pending request) carries it too.
    pub(crate) fn depth_of(&self, session_id: &str) -> u32 {
        self.depth.lock().unwrap().get(session_id).copied().unwrap_or(0)
    }
    #[cfg(test)]
    pub fn set_depth(&self, session_id: &str, depth: u32) { self.depth.lock().unwrap().insert(session_id.to_owned(), depth); }
    pub fn forget(&self, session_id: &str) {
        if let Some(token) = self.tokens.lock().unwrap().remove(session_id) { self.grants.lock().unwrap().remove(&token); }
        self.depth.lock().unwrap().remove(session_id);
    }
    /// A restart puts a persisted brief back behind whatever the queue already
    /// holds. It writes no notice: the "Waiting for" line is already in the
    /// transcript, and this is the same delivery continuing. A brief that is
    /// already waiting (a row that was both persisted and still in memory) is
    /// not added a second time.
    pub(crate) async fn restore_queued(&self, st: &AppState, session_id: &str, text: String, meta: Value, depth: u32) {
        self.push_queued(st, session_id, text, meta, depth, false).await;
    }
    /// Wave 12, part B: the queue is durable, so boot offers every message that was
    /// still waiting for a busy teammate. A row whose conversation is gone is
    /// dropped (nothing could ever receive it); a row whose conversation is
    /// archived stays in storage and is not offered, so restoring it later still
    /// finds its queue.
    pub(crate) async fn restore_persisted_queue(&self, st: &AppState) {
        for row in st.db.team_queue_rows(None).unwrap_or_default() {
            let (Some(id), Some(session)) = (row["id"].as_str(), row["sessionId"].as_str()) else { continue };
            let Some(text) = row["text"].as_str().filter(|text| !text.is_empty()) else { let _ = st.db.team_queue_remove(id); continue; };
            match st.db.session_brief(session) {
                Ok(brief) if brief["archived"] != true => {}
                Ok(_) => continue,
                Err(_) => { let _ = st.db.team_queue_remove(id); continue; }
            }
            let meta = row["meta"].clone();
            let depth = row["depth"].as_u64().unwrap_or(0) as u32;
            let item = Queued { id: id.to_owned(), text: text.to_owned(), meta, depth };
            enqueue(&mut *self.queued.lock().await, session, item, false);
        }
    }
    /// Writes one delivery to the queue table and puts it in memory, so a restart
    /// can still offer it. Dedupe comes first: the same brief is never stored or
    /// queued twice. A failed write leaves the delivery in memory only, exactly as
    /// the queue behaved before it was durable.
    async fn push_queued(&self, st: &AppState, session_id: &str, text: String, meta: Value, depth: u32, front: bool) -> (bool, bool) {
        let mut queues = self.queued.lock().await;
        let was_empty = queues.get(session_id).is_none_or(VecDeque::is_empty);
        if queues.get(session_id).is_some_and(|queue| queue.iter().any(|item| same_delivery(item, &meta))) { return (false, was_empty); }
        let id = st.db.team_queue_add(session_id, &text, &meta, depth, front).unwrap_or_else(|_| Uuid::new_v4().to_string());
        enqueue(&mut queues, session_id, Queued { id, text, meta, depth }, front)
    }
    /// Takes the waiting brief of one assignment out of a session's queue, so a
    /// cancelled assignment is never delivered. Returns how many items went.
    pub(crate) async fn cancel_queued(&self, st: &AppState, session_id: &str, delegation_id: &str) -> usize {
        self.retain_queued(st, session_id, |item| item.meta["delegationId"].as_str() != Some(delegation_id)).await
    }
    /// Takes the wakes of one assignment out of a session's queue (Lane V1): once
    /// the assignment is over its pending wake is dropped, and a notice still
    /// waiting in memory must not go out afterwards. Other items of the same
    /// assignment, and every other assignment's, are left where they are.
    pub(crate) async fn cancel_queued_wakes(&self, st: &AppState, session_id: &str, delegation_id: &str) -> usize {
        self.retain_queued(st, session_id, |item| !(item.meta["kind"] == "blob_update" && item.meta["delegationId"].as_str() == Some(delegation_id))).await
    }
    /// Takes one request's wake out of a session's queue, leaving a newer request's
    /// wake on the same assignment alone: the request it announced was answered or
    /// dismissed, so that notice is no longer meaningful.
    pub(crate) async fn cancel_queued_wake(&self, st: &AppState, session_id: &str, delegation_id: &str, request_id: &str) -> usize {
        self.retain_queued(st, session_id, |item| !(item.meta["kind"] == "blob_update"
            && item.meta["delegationId"].as_str() == Some(delegation_id)
            && item.meta["requestId"].as_str() == Some(request_id))).await
    }
    /// Keeps the items `keep` accepts and removes the rest from memory and from the
    /// queue table, so a cancelled delivery can never come back after a restart.
    async fn retain_queued(&self, st: &AppState, session_id: &str, keep: impl Fn(&Queued) -> bool) -> usize {
        let mut queues = self.queued.lock().await;
        let Some(queue) = queues.get_mut(session_id) else { return 0 };
        let before = queue.len();
        let mut removed = Vec::new();
        queue.retain(|item| { if keep(item) { true } else { removed.push(item.id.clone()); false } });
        let count = before - queue.len();
        drop(queues);
        for id in removed { let _ = st.db.team_queue_remove(&id); }
        count
    }
    #[cfg(test)]
    pub(crate) async fn enqueue_for_test(&self, session_id: &str, text: &str) {
        self.queued.lock().await.entry(session_id.to_owned()).or_default().push_back(Queued { id: Uuid::new_v4().to_string(), text: text.to_owned(), meta: json!({}), depth: 0 });
    }
    #[cfg(test)]
    pub(crate) async fn queued_len(&self, session_id: &str) -> usize {
        self.queued.lock().await.get(session_id).map_or(0, VecDeque::len)
    }
    /// Queue a delivery with a real `meta`, so a test can exercise the waiting
    /// notice (`kind: "blob_message"`) or the silent reply path (`blob_reply`).
    #[cfg(test)]
    pub(crate) async fn enqueue_meta_for_test(&self, session_id: &str, text: &str, meta: Value) {
        self.queued.lock().await.entry(session_id.to_owned()).or_default().push_back(Queued { id: Uuid::new_v4().to_string(), text: text.to_owned(), meta, depth: 0 });
    }
    /// The texts currently queued for a session, front first, so a test can prove
    /// a refused retry did not reorder the queue.
    #[cfg(test)]
    pub(crate) async fn queued_texts(&self, session_id: &str) -> Vec<String> {
        self.queued.lock().await.get(session_id).map(|queue| queue.iter().map(|item| item.text.clone()).collect()).unwrap_or_default()
    }
}

fn agent_name(agent: &Value) -> String { agent["name"].as_str().unwrap_or("A teammate").to_owned() }

/// The word the model-facing prose uses for one of these characters: always
/// "bot". Owner review, 16 October 2026: the characters are bots in both looks,
/// so the prose no longer changes with `appearance.style`. (This changes the
/// instruction hash once for Blobots users, so their next turn re-sends the
/// instructions.)
pub(crate) fn entity_noun(plural: bool) -> String {
    let word = "bot";
    if plural { format!("{word}s") } else { word.to_owned() }
}

/// FIX39 P7 audit F6: whether delegating from this session would exceed the hop
/// limit. Used when the proposal is created, so the owner is never shown a card
/// that could never succeed; the delivery path re-checks it.
pub(crate) fn depth_exceeded(st: &AppState, session_id: &str) -> bool {
    st.team.depth.lock().unwrap().get(session_id).copied().unwrap_or(0) + 1 > MAX_DEPTH
}

/// The one message both the creation-time and delivery-time depth checks return.
pub(crate) fn depth_error() -> String {
    format!("This request has already passed between too many {}. Report back to the user instead.", entity_noun(true))
}

fn user_name(st: &AppState) -> Option<String> {
    st.db.settings().ok().and_then(|settings| settings["profile.name"].as_str().map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned))
}

fn profile_about(st: &AppState) -> Option<String> {
    st.db.settings().ok().and_then(|settings| settings["profile.about"].as_str().map(str::trim).filter(|about| !about.is_empty()).map(str::to_owned))
}

/// The folder a blob works in: its project's folder, or its own workspace.
pub fn workspace_for(st: &AppState, agent: &Value) -> PathBuf {
    if let Some(project) = agent["projectId"].as_str().and_then(|id| st.db.project_get(id).ok()) {
        if let Some(path) = project["path"].as_str().map(PathBuf::from).filter(|path| path.is_dir()) { return path; }
    }
    let base = st.team.data_dir.lock().unwrap().clone().unwrap_or_else(std::env::temp_dir);
    let workspaces = base.join("workspaces");
    let agent_id = agent["id"].as_str().unwrap_or("blob");
    // A folder named after the raw agent id is the older layout; keep using it,
    // because Claude and Codex resume is bound to the working directory and a
    // move would strand saved sessions.
    let legacy = workspaces.join(agent_id);
    if legacy.is_dir() { return legacy; }
    let dir = workspaces.join(workspace_dir_name(&agent_name(agent), agent_id));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// The on-disk name of a pathless bot's workspace: a short ASCII slug of the
/// bot's name plus the first eight characters of its id, so the folder reads as
/// the bot instead of a bare UUID.
fn workspace_dir_name(name: &str, agent_id: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for character in name.chars().flat_map(char::to_lowercase) {
        let mapped = if character.is_ascii_alphanumeric() { last_dash = false; Some(character) } else if !last_dash && !slug.is_empty() { last_dash = true; Some('-') } else { None };
        if let Some(character) = mapped {
            if slug.len() >= 32 { break; }
            slug.push(character);
        }
    }
    let slug = slug.trim_matches('-');
    let id8: String = agent_id.chars().take(8).collect();
    if slug.is_empty() { format!("bot-{id8}") } else { format!("{slug}-{id8}") }
}

/// FIX39 P10: a read-only/research bot never gets a worktree. There is no field
/// for "writes code", so the signal is the routing tag/role the Manager already
/// uses: a bot tagged or roled as a researcher is treated as read-only.
fn is_research_agent(agent: &Value) -> bool {
    let role = agent["role"].as_str().unwrap_or("").to_lowercase();
    if role.contains("research") || role.contains("read-only") || role.contains("reader") { return true; }
    agent["tags"].as_array().map(|tags| tags.iter().filter_map(Value::as_str).any(|tag| {
        let tag = tag.to_lowercase();
        tag.starts_with("research") || tag == "read-only" || tag == "reader" || tag == "viewer"
    })).unwrap_or(false)
}

/// Whether another conversation is working in the same repository right now —
/// mid-turn, queued for a turn, or holding a session state that has not finished
/// (`starting`, `working`, `waiting_permission`, `cancelling`). The last two
/// matter because a delegation is created before it runs: when the global limit
/// is full the first task is queued with no live turn yet, and a second task in
/// the same repo must still not share its folder. Two repos match when their
/// `git rev-parse --show-toplevel` folders are the same, so a task already in its
/// own worktree does not count as a clash. The git calls run off the runtime.
async fn repo_is_busy_elsewhere(st: &AppState, origin: &str, repo: &Path) -> bool {
    let queued: Vec<String> = st.team.queued.lock().await.iter()
        .filter(|(_, queue)| !queue.is_empty()).map(|(id, _)| id.clone()).collect();
    let mut paths: Vec<PathBuf> = Vec::new();
    for row in st.db.session_list(false).unwrap_or_default() {
        let Some(id) = row["id"].as_str().filter(|id| *id != origin) else { continue };
        let busy = session_busy(st, id).await || queued.iter().any(|queued| queued == id);
        if !busy { continue; }
        if let Some(path) = row["projectPath"].as_str().filter(|path| !path.is_empty()) { paths.push(PathBuf::from(path)); }
    }
    if paths.is_empty() { return false; }
    let target = crate::worktree::normalize(repo);
    tokio::task::spawn_blocking(move || paths.iter().any(|path| crate::worktree::repo_root(path).is_some_and(|other| crate::worktree::normalize(&other) == target)))
        .await.unwrap_or(false)
}

/// FIX39 P10 + DELEGATION item 4: give a code-writing delegation its own git
/// worktree when its project is a git repo and another task is working there.
/// Isolation has three outcomes, and they are not the same thing: made, not
/// applicable (no clash, a research bot, or a folder that is no repository) and
/// tried but failed. Only the last one is reported to the owner.
pub(crate) struct WorktreeAttempt {
    /// The record to store on the side conversation, when a copy was made.
    pub worktree: Option<Value>,
    /// Why isolation was tried and did not happen, in plain words.
    pub error: Option<String>,
}

fn shared(reason: Option<String>) -> WorktreeAttempt { WorktreeAttempt { worktree: None, error: reason } }

pub(crate) async fn prepare_worktree_attempt(st: &AppState, origin: &str, project_path: &Path, title: &str, target: &Value) -> WorktreeAttempt {
    if is_research_agent(target) { return shared(None); }
    let path = project_path.to_path_buf();
    // A `.git` entry (a folder, or the file a linked worktree has) tells "git is
    // unavailable or refused" apart from "this folder is simply not a repository".
    let looks_like_repo = path.join(".git").exists();
    let repo = match tokio::task::spawn_blocking(move || crate::worktree::repo_root(&path)).await {
        Ok(Some(repo)) => repo,
        _ if !looks_like_repo => return shared(None),
        _ => return shared(Some("Git could not be reached to make a separate copy of the project.".to_owned())),
    };
    if !repo_is_busy_elsewhere(st, origin, &repo).await { return shared(None); }
    let (repo_for_create, topic) = (repo, title.to_owned());
    match tokio::task::spawn_blocking(move || crate::worktree::create(&repo_for_create, &topic)).await {
        Ok(Ok(worktree)) => WorktreeAttempt { worktree: Some(worktree.to_json()), error: None },
        // `create` answers in plain sentences and never panics, so its reason is
        // the one to show.
        Ok(Err(reason)) => shared(Some(reason)),
        Err(_) => shared(Some("The separate copy of the project could not be made.".to_owned())),
    }
}

/// The worktree record alone. Kept beside [`prepare_worktree_attempt`] for the
/// P10 tests, which only assert whether a copy was made.
#[cfg(test)]
pub(crate) async fn prepare_worktree(st: &AppState, origin: &str, project_path: &Path, title: &str, target: &Value) -> Option<Value> {
    prepare_worktree_attempt(st, origin, project_path, title, target).await.worktree
}

/// A one-line reason for an isolation failure: no command output past its first
/// line, no home-folder path, at most 200 characters.
fn short_reason(raw: &str) -> String {
    let mut text = raw.lines().next().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(home) = std::env::var(key) {
            let home = home.trim();
            if home.len() > 3 {
                text = text.replace(home, "the home folder");
                text = text.replace(&home.replace('\\', "/"), "the home folder");
            }
        }
    }
    text.chars().take(200).collect()
}

/// The chart and table block schemas, appended to every bot's instructions.
///
/// This text is the contract with the renderer in
/// `apps/desktop/src/ui/richData.ts`: the fences, the field names and the limits
/// are what it accepts, so the wording and the JSON examples are kept verbatim.
const CHART_TABLE_INSTRUCTIONS: &str = concat!(
    "Charts and tables in chat. The Bitbots window draws two fenced block types as interactive views. Use them only for numbers and rows you actually have from the user, your tools, files or commands in this conversation. Never invent, estimate or pad values to make a chart; if you do not have the data, say so or fetch it first. A plain Markdown table is fine for a short list; use a chart when the user asks for a chart, graph or plot, or when comparing numbers across categories or over time is the point. Add one sentence outside the block saying what it shows and where the data came from.",
    "\n\n```bitbots-chart\n",
    r#"{"type":"bar","title":"Build time by job","unit":"s","categories":["lint","test","bundle"],"series":[{"name":"main","values":[12.4,98.1,45]}]}"#,
    "\n```\n\n",
    r#""type" is "bar" or "line". "categories" are strings. Each series has a "name" and exactly one number per category (null for a missing value). Use at most 6 series and 200 categories, and one unit for the whole chart: put measures with different units in separate charts. Optional: "title", "caption", "unit". Shorthand for one series: {"type":"bar","data":[{"label":"lint","value":12.4}]}."#,
    "\n\n```bitbots-table\n",
    r##"{"title":"Open issues","columns":["Issue","Owner","Age (days)"],"rows":[["#12","Sam",4],["#15","Ada",9]]}"##,
    "\n```\n\n",
    r#""columns" are names; each row is a list in column order (or an object keyed by column name); at most 24 columns and 1000 rows; keep numbers as numbers. Each block must be valid JSON on its own with nothing else inside the fence. Plain Markdown tables and csv code blocks are also shown as sortable tables.

Showing files. To show a file from the project folder, write ![short description](relative/path.png) on its own line for an image, or [name](relative/path.pdf) as a link for a PDF, audio, video or text file. Only files that exist inside the project folder can be shown, so create or save the file first and use its real path."#,
);

/// Bitbots context appended to every blob session's system instructions.
pub fn runtime_instructions(st: &AppState, agent: &Value, link: &Value, workspace: &std::path::Path) -> String {
    let name = agent_name(agent);
    let noun = entity_noun(false);
    let nouns = entity_noun(true);
    let mut lines = vec![format!("You are {name}, a {noun}: one of the user's AI teammates in Bitbots, a desktop app where several coding agents work side by side on the user's computer.")];
    if let Some(role) = agent["role"].as_str().map(str::trim).filter(|role| !role.is_empty()) { lines.push(format!("Your role: {role}.")); }
    if let Some(description) = agent["description"].as_str().map(str::trim).filter(|d| !d.is_empty()) { lines.push(format!("What you are for: {description}")); }
    lines.push(match user_name(st) {
        Some(user) => format!("The user is {user}."),
        None => "The user has not set a name; address them as the admin.".into(),
    });
    if let Some(about) = profile_about(st) {
        lines.push(format!("About the user (from their own notes): {about}"));
    }
    let project = agent["projectId"].as_str().and_then(|id| st.db.project_get(id).ok());
    lines.push(match project {
        Some(project) => format!("You work in the project \"{}\" at {}. Treat that folder as your workspace.", project["name"].as_str().unwrap_or("project"), workspace.display()),
        None => format!("You are a casual {noun}, not tied to a project. Your scratch workspace is {}; take general requests and work wherever the user points you.", workspace.display()),
    });
    if agent["systemRole"].as_str() == Some("manager") {
        lines.push(format!("You are {name}, the user's Manager: chat like a capable team lead. Ground yourself with list_projects and list_blobs, then route by role, description, tags and project. Resolve any project mentioned by name, tags or context before acting; when unsure, ask_user with concrete options. With no project, research goes to a free bot tagged researcher; for project P, use P's researcher. If none fits, propose_bot for that project (or propose_project when a project is needed); do small things yourself when appropriate; you ask the user before creating projects, bots or assigning tasks."));
        lines.push("Read details with your read tools, and make consequential changes an approval card: creating or updating projects and bots, assigning a task, opening a conversation and changing a permission are proposed and wait for the owner. A message to a teammate is not consequential: `message_blob` is sent at once with no approval, so use it for ordinary delegation and only use `assign_task` when the user wants the work tracked as a task. Fill the brief or message yourself, and for a task also doneGoal and reportBack; never ask the user to fill a task form. Use a new topic for parallel work or conversation to follow up. Locked bots refuse settings changes; never propose Full access. After delegating, say briefly who will do what and end your turn. Approval outcomes are recorded here; teammate replies arrive later and wake you to report back.".into());
        lines.push("Your notes about the user and your playbook are yours across model changes: keep the profile current with `remember_about_user` (read it with `recall_about_user`), and propose playbook edits with `update_playbook`. Never store secrets in either.".to_owned());
        lines.push("A message that starts with [Update from NAME] means a teammate is waiting for the user to approve or answer something in that teammate's own conversation. Tell the user briefly which teammate and what is being asked, point them to that conversation, and do not try to answer for them, approve anything, or send the task again.".to_owned());
        // Wave 12, part D: the relay carries the assignment's own "Done when" line,
        // so the Manager checks instead of trusting the prose, and says nothing
        // when there is nothing to say.
        lines.push("Before you report a finished assignment, compare the reply with its 'Done when' line and start your report with 'Checked:' or 'Not done yet:' and why.".to_owned());
        lines.push("When nothing changed and nothing needs the user, say nothing or one short line.".to_owned());
    } else {
        match st.db.manager_agent().ok().flatten() {
            Some(manager) => lines.push(format!("You cannot create projects or {nouns}; the Manager does that. If the user asks you to, say so briefly and tag the Manager as @{} so the user can ask them.", agent_name(&manager))),
            None => lines.push(format!("You cannot create projects or {nouns}; the Manager does that. If the user asks you to, say so briefly and tell the user they need to set up a Manager.")),
        }
    }
    lines.push(String::new());
    lines.push("Teammates are separate agents with their own tools and memory. Use the bloblex tools: `list_blobs` shows the team (name, role, what each is for, whether they are busy); `message_blob` sends one teammate a message in a private side conversation between the two of you; `list_conversations` lists your side conversations, each with a short topic.".into());
    lines.push(format!("When the user tags a {noun} with @Name, or asks you to hand work to someone, write that teammate a self-contained brief (they cannot see this conversation: include the goal, context, paths, constraints and what to send back) and send it with `message_blob`. Then tell the user in one short sentence who you asked and end your turn: do not wait, poll or sleep. The reply arrives later in this conversation as a message starting with \"[Reply from <name>]\". When it arrives, report to the user: what they did or found, your own verdict, and any open questions."));
    lines.push("Each side conversation has a topic, like a chat title. Before messaging a teammate, check `list_conversations`: if one you started with them is about the same subject, continue it by passing its id as `conversation` (they keep the context there). Otherwise start a new one and give it a short `topic` of 3 to 6 words. When the user references a conversation with #, continue that one.".into());
    // Every bot, Manager and side conversations included: the renderer contract
    // for charts and tables sits after the delegation lines and before the
    // side-conversation block.
    lines.push(CHART_TABLE_INSTRUCTIONS.into());
    if link["kind"] == "side" {
        let peer = link["peerName"].as_str().unwrap_or(noun.as_str());
        lines.push(String::new());
        lines.push(format!("This is a side conversation. Messages here come from {peer}, another {noun}, not from the user. Do what {peer} asks and answer them directly; your final message each turn is delivered back to {peer} automatically. Keep it focused: results, evidence and open questions."));
        if let Some(topic) = link["topic"].as_str().filter(|topic| !topic.trim().is_empty()) { lines.push(format!("Topic of this conversation: {topic}.")); }
        lines.push("If you need a decision or information only the user can give, use the ask_user tool, then end your turn. Your Manager is told you are waiting, but only the user can answer; their answer arrives as your next message. Do not ask the Manager to answer for the user.".into());
        lines.push("If you were asked to check something and there is nothing to report, reply exactly `(pass)`.".into());
    }
    format!("<bloblex_team>\n{}\n</bloblex_team>", lines.join("\n"))
}

/// Adds team instructions and the MCP bridge to a blob session's options.
pub fn attach(st: &AppState, session_id: &str, agent_id: Option<&str>, link: &Value, options: &mut ExecOptions) {
    let Some(agent) = agent_id.and_then(|id| st.db.agent_get(id).ok()) else { return };
    let workspace = workspace_for(st, &agent);
    let team = runtime_instructions(st, &agent, link, &workspace);
    options.instructions = Some(match options.instructions.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
        Some(own) => format!("{team}\n\n{own}"),
        None => team,
    });
    let address = st.team.address.lock().unwrap().clone();
    if let (Some(address), Ok(exe)) = (address, std::env::current_exe()) {
        let token = st.team.token_for(session_id);
        options.mcp_servers = vec![McpServerSpec {
            name: SERVER_NAME.into(),
            command: exe,
            args: vec!["mcp-bridge".into()],
            env: BTreeMap::from([("BLOBLEX_DAEMON_ADDR".to_owned(), address), ("BLOBLEX_MCP_TOKEN".to_owned(), token)]),
        }];
    }
}

/// The tool list for a session. Automation-run sessions get no team or
/// scheduling tools (recursion guard): they must not message teammates, create
/// conversations or schedule anything. Memory tools are only listed while
/// `experimental.memory` is on; automation runs may keep memory tools but the
/// write rails restrict them to blob scope.
fn tools(is_automation: bool, memory_enabled: bool, ask_user: bool, is_manager: bool, noun: &str, _nouns: &str) -> Value {
    let memory = if memory_enabled { crate::memory::tool_schemas() } else { Vec::new() };
    // The shared skills pool is read-only, so every bot gets it, including
    // automation runs (the index is what tells a bot the pool exists).
    let skill_tools = crate::skills::tool_schemas();
    if is_automation {
        let mut list = memory;
        list.extend(skill_tools);
        return json!(list);
    }
    let mut list: Vec<Value> = vec![
        json!({"name":"list_blobs","description":"List your teammates in Bitbots: name, role, what each is for, project, whether they are busy, and which one is the Manager.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"list_conversations","description":"List your side conversations with teammates, newest first: id, topic, teammate, who started it, size and the latest reply. Use it to find a conversation to continue.","inputSchema":{"type":"object","properties":{"blob":{"type":"string","description":"Only conversations with this teammate (optional)."}},"additionalProperties":false}}),
        json!({"name":"message_blob","description":"Send a message to one teammate in a private side conversation. Use it whenever the user asks you to message, ask or hand work to a teammate: it is sent at once, with no approval card. Continue an earlier conversation you started by passing its id as `conversation`, or start a new one with a short `topic`. Returns at once; their reply is delivered to you later as a message starting with \"[Reply from <name>]\". After sending, tell the user who you asked and end your turn.","inputSchema":{"type":"object","properties":{"blob":{"type":"string","description":"The teammate's name, as shown by list_blobs."},"message":{"type":"string","description":"A self-contained brief: goal, context, paths, constraints and what to send back."},"doneGoal":{"type":"string","description":"What must be true for the work to count as done. It is relayed back with the reply as a 'Done when' line (optional)."},"topic":{"type":"string","description":"For a new conversation: a short title of 3 to 6 words, like a chat title."},"conversation":{"type":"string","description":"The id of a conversation you started with this teammate, from list_conversations, to continue it."}},"required":["blob","message"],"additionalProperties":false}}),
        json!({"name":"schedule_task","description":format!("Propose a scheduled task for your {noun}. It is created disabled and will never run until the user approves it in Bitbots. Use this only when the user asks for something recurring or at a set time."),"inputSchema":{"type":"object","properties":{"name":{"type":"string","description":"A short title, 1 to 80 characters."},"prompt":{"type":"string","description":"The instruction to run unattended when the task fires."},"when":{"type":"object","description":"A schedule object: {\"kind\":\"once\",\"at\":\"<RFC3339>\"} or {\"kind\":\"cron\",\"cron\":\"m h dom mon dow\",\"timezone\":\"Area/City\"}."}},"required":["name","prompt","when"],"additionalProperties":false}}),
        json!({"name":"list_my_schedules","description":format!("List this {noun}'s scheduled tasks, whether each is enabled, and when it next runs."),"inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
    ];
    if is_manager {
        // Same names for existing tools; the Manager's write variants always
        // create approval cards. Ordinary bots keep the original schemas.
        list.extend(manager_tool_schemas());
        list.extend(crate::proposals::tool_schemas());
        list.extend(crate::knowledge::tool_schemas());
        // The board draft tool: creates only, never assigns or dispatches.
        list.push(json!({"name":"create_task","description":format!("Create an unassigned task on the user's task board. It is a draft: it has no bot, does not run and cannot be scheduled. The user decides which {noun} gets it by dragging it in Bitbots. Use it when the user asks for work to be tracked on the board; use message_blob for ordinary delegation."),"inputSchema":{"type":"object","properties":{"title":{"type":"string","description":"A short title, 1 to 120 characters."},"brief":{"type":"string","description":"The full brief: goal, context, paths and constraints."},"doneGoal":{"type":"string","description":"What must be true for the task to count as done."},"reportBack":{"type":"string","description":"What the bot should report when it stops."},"projectId":{"type":"string","description":"The project this task belongs to (optional)."},"parentTaskId":{"type":"string","description":"The parent task, when this is a follow-up (optional)."},"images":{"description":"Images the user attached in this conversation that the task needs: a list of their numbers (1 is the first image the user sent here, 2 the next, and so on) or the word all. Optional.","anyOf":[{"type":"array","items":{"type":"integer","minimum":1},"maxItems":8},{"type":"string","enum":["all"]}]}},"required":["title","brief","doneGoal","reportBack"],"additionalProperties":false}}));
        for tool in &mut list {
            if tool["name"] == "list_blobs" {
                tool["description"] = json!("List bots with ids, role, description, tags, project and busy/available status. Filter by project (id/name), role, tag or freeOnly. Research without a project uses a free researcher (freeOnly = not tied to a project); a named project uses its own researcher, or propose_bot if none fits.");
                tool["inputSchema"]["properties"] = json!({"project":{"type":"string","description":"A project id or exact name."},"role":{"type":"string"},"tag":{"type":"string"},"freeOnly":{"type":"boolean","description":"true means bots not tied to a project (free bots), not merely idle."}});
            }
            if tool["name"] == "list_conversations" {
                tool["description"] = json!("List Bitbots conversations and their status, newest first (up to 100). Optional bot and project filters. Use read_conversation for recent messages.");
                tool["inputSchema"]["properties"]["project"] = json!({"type":"string"});
            }
        }
    }
    // OpenCode has no native question tool over ACP, so the bridge offers one.
    if ask_user { list.push(crate::questions::tool_schema()); }
    list.extend(memory);
    list.extend(skill_tools);
    json!(list)
}

#[cfg(test)]
pub(crate) fn mcp_tools_for_test() -> Vec<Value> {
    tools(false, false, false, true, &entity_noun(false), &entity_noun(true)).as_array().cloned().unwrap_or_default()
}

/// MCP calls from `bitbotsd mcp-bridge`, authorized by a per-session token.
pub async fn mcp_rpc(st: &AppState, session_id: &str, method: &str, params: &Value) -> Result<Value, DispatchError> {
    // Recursion guard: a session linked to an automation run can neither use
    // team/scheduling tools nor reach any automation write RPC. Memory tools
    // are allowed, but only while the feature is on and only blob scope.
    let session = st.db.session_detail(session_id).ok();
    let is_automation = session.as_ref().map(|row| crate::is_unattended(&row["link"])).unwrap_or(false);
    // `ask_user` is offered wherever someone can answer, whatever the provider
    // (FIX36 D2 removed the OpenCode-only gate). A delegated side conversation
    // is allowed too, as long as nothing in its origin chain is unattended: the
    // owner answers there, and the Manager is only told it is waiting.
    let ask_user = session.as_ref().is_some_and(|row| crate::questions::may_ask(st, row).is_ok());
    let memory_enabled = crate::memory::enabled(st);
    if is_automation && method.starts_with("automation.") {
        return Err(derr("forbidden", "Automation runs cannot change automations.", StatusCode::FORBIDDEN));
    }
    // Changing blobs is reserved for the Manager's own blob. Side conversations
    // of the Manager are allowed (the session's agent is the Manager);
    // automation sessions never reach here.
    // Manager identity follows the session's bot, not the session's own archived
    // flag: an archived Manager conversation must not fall through to the
    // ordinary team tools (which would send without an approval card). Every
    // Manager write still re-checks `manager_of_session`, which refuses an
    // archived conversation, so a downgrade is impossible.
    let is_manager = session.as_ref().is_some_and(|row| {
        row["agentId"].as_str().is_some_and(|id| st.db.agent_get(id).is_ok_and(|agent| agent["systemRole"].as_str() == Some("manager") && agent["archived"] != true))
    });
    match method {
        "mcp.tools.list" => Ok(json!({"tools":tools(is_automation, memory_enabled, ask_user, is_manager, &entity_noun(false), &entity_noun(true))})),
        "mcp.tools.call" => {
            let name = params["name"].as_str().unwrap_or("");
            if is_automation && !name.starts_with("memory_") && !matches!(name, "list_skills" | "load_skill" | "read_skill_file") {
                return Err(derr("forbidden", "Automation runs cannot use team or scheduling tools.", StatusCode::FORBIDDEN));
            }
            let args = &params["arguments"];
            let result = match name {
                "list_blobs" if is_manager => manager_blobs(st, session_id, args).await,
                "list_blobs" => list_blobs(st, session_id).await,
                "list_conversations" if is_manager => manager_conversations(st, session_id, args),
                "list_conversations" => list_conversations(st, session_id, args).await,
                // Messaging is not consequential: it is delivered at once for
                // every bot, the Manager included. Consequential changes
                // (projects, bots, permissions, assign_task) stay proposals.
                // The archived guard stays: an archived Manager conversation
                // cannot message either.
                "message_blob" => {
                    if is_manager && session.as_ref().is_some_and(|row| row["archived"] == true) {
                        Err("This conversation is archived.".into())
                    } else {
                        message_blob(st, session_id, args).await
                    }
                }
                "list_projects" if is_manager => list_projects(st).await,
                "update_blob" if is_manager => crate::proposals::propose_update(st, session_id, "bot", args).await,
                "update_project" if is_manager => crate::proposals::propose_update(st, session_id, "project", args).await,
                "read_blob" | "read_project" | "read_conversation" | "get_conversation_permission" if is_manager => manager_read(st, name, args).await,
                "open_conversation" if is_manager => crate::proposals::propose_open(st, session_id, args).await,
                "start_conversation" if is_manager => crate::proposals::propose_start(st, session_id, args).await,
                "propose_project" if is_manager => crate::proposals::propose_project(st, session_id, args).await,
                "propose_bot" if is_manager => crate::proposals::propose_bot(st, session_id, args).await,
                "assign_task" if is_manager => crate::proposals::assign_task(st, session_id, args).await,
                "create_task" if is_manager => crate::tasks::manager_create(st, session_id, args).await,
                "project_status" if is_manager => crate::proposals::project_status(st, args).await,
                "set_conversation_permission" if is_manager => crate::proposals::propose_permission(st, session_id, args).await,
                "remember_about_user" if is_manager => crate::knowledge::tool_remember(st, session_id, args).await,
                "forget_about_user" if is_manager => crate::knowledge::tool_forget(st, session_id, args).await,
                "recall_about_user" if is_manager => crate::knowledge::tool_recall(st, args),
                "update_playbook" if is_manager => crate::knowledge::tool_update_playbook(st, session_id, args).await,
                "read_blob" | "read_project" | "read_conversation" | "get_conversation_permission" | "open_conversation" | "start_conversation" | "list_projects" | "update_blob" | "update_project" | "propose_project" | "propose_bot" | "assign_task" | "create_task" | "project_status" | "set_conversation_permission" | "remember_about_user" | "forget_about_user" | "recall_about_user" | "update_playbook" => Err(non_manager_error(st)),
                "schedule_task" => crate::automations::schedule_task_tool(st, session_id, args).await,
                "list_my_schedules" => crate::automations::list_my_schedules_tool(st, session_id).await,
                "ask_user" if ask_user => crate::questions::ask_user_tool(st, session_id, args).await,
                "ask_user" => Err("ask_user is not available in this conversation.".into()),
                "memory_search" if memory_enabled => crate::memory::tool_search(st, session_id, args).await,
                "memory_get" if memory_enabled => crate::memory::tool_get(st, session_id, args).await,
                "memory_write" if memory_enabled => crate::memory::tool_write(st, session_id, args).await,
                "memory_update" if memory_enabled => crate::memory::tool_update(st, session_id, args).await,
                "memory_forget" if memory_enabled => crate::memory::tool_forget(st, session_id, args).await,
                "list_skills" => crate::skills::tool_list(st, session_id).await,
                "load_skill" => crate::skills::tool_load(st, session_id, args).await,
                "read_skill_file" => crate::skills::tool_read_file(st, session_id, args).await,
                _ => Err(format!("Unknown tool {name}.")),
            };
            Ok(match result {
                Ok(text) => json!({"content":[{"type":"text","text":text}]}),
                Err(text) => json!({"content":[{"type":"text","text":text}],"isError":true}),
            })
        }
        _ => Err(derr("not_found", "unknown team method", StatusCode::NOT_FOUND)),
    }
}

pub(crate) async fn session_busy(st: &AppState, session_id: &str) -> bool {
    if st.active_turns.lock().await.contains_key(session_id) { return true; }
    st.db.session_state(session_id).ok().flatten().is_some_and(|state| matches!(state.as_str(), "starting" | "working" | "waiting_permission" | "cancelling"))
}

async fn list_blobs(st: &AppState, session_id: &str) -> Result<String, String> {
    let me = st.db.session_detail(session_id).ok().and_then(|row| row["agentId"].as_str().map(str::to_owned));
    let agents = st.db.agent_list(false, None).map_err(|error| error.to_string())?;
    let projects = st.db.project_list().unwrap_or_default();
    let sessions = st.db.session_list(false).unwrap_or_default();
    let runtimes = st.runtimes.read().await.clone();
    let mut rows = Vec::new();
    for agent in agents.iter().filter(|agent| agent["hidden"] != true) {
        let id = agent["id"].as_str().unwrap_or("");
        let project = agent["projectId"].as_str().and_then(|pid| projects.iter().find(|p| p["id"] == pid)).and_then(|p| p["name"].as_str()).unwrap_or("none (casual)");
        let busy = sessions.iter().any(|s| s["agentId"] == id && matches!(s["state"].as_str(), Some("working" | "starting" | "waiting_permission")));
        let provider = runtimes.iter().find(|r| r["id"] == agent["runtimeId"]).and_then(|r| r["provider"].as_str()).unwrap_or("unknown");
        let mut line = format!("- {}", agent_name(agent));
        if me.as_deref() == Some(id) { line.push_str(" (you)"); }
        if agent["systemRole"].as_str() == Some("manager") { line.push_str(" [manager]"); }
        if let Some(role) = agent["role"].as_str().filter(|r| !r.trim().is_empty()) { line.push_str(&format!(" — {role}")); }
        line.push_str(&format!(" · {provider} · project: {project} · {}", if busy { "busy" } else { "available" }));
        // FIX39 item 21: a bot's tags are the routing signal the Manager matches
        // against a project's tags. The id follows the tags so the line reads in
        // one order (P7 audit F1).
        line.push_str(&tags_suffix(&agent["tags"]));
        line.push_str(&format!(" · id: {id}"));
        if let Some(description) = agent["description"].as_str().map(str::trim).filter(|d| !d.is_empty()) { line.push_str(&format!("\n  {description}")); }
        rows.push(line);
    }
    Ok(if rows.is_empty() { format!("No {} are on the team yet.", entity_noun(true)) } else { format!("Your team:\n{}", rows.join("\n")) })
}

pub(crate) fn resolve_blob(agents: &[Value], wanted: &str) -> Option<Value> {
    let wanted = wanted.trim().trim_start_matches('@').to_lowercase();
    agents.iter().find(|agent| agent["id"].as_str() == Some(wanted.as_str()) || agent["name"].as_str().is_some_and(|name| name.trim().to_lowercase() == wanted)).cloned()
}

/// A bounded, trimmed string tool argument. `None` when absent or empty.
fn bounded_text(args: &Value, key: &str, limit: usize) -> Result<Option<String>, String> {
    let Some(value) = args.get(key) else { return Ok(None) };
    let Some(text) = value.as_str() else { return Err(format!("{key} must be a string.")) };
    let text = text.trim();
    if text.is_empty() { return Ok(None); }
    if text.chars().count() > limit { return Err(format!("{key} must be at most {limit} characters.")); }
    Ok(Some(text.to_owned()))
}

/// The error a non-manager gets when it tries to list projects or change blobs.
pub(crate) fn non_manager_error(st: &AppState) -> String {
    match st.db.manager_agent().ok().flatten() {
        Some(manager) => { let name = agent_name(&manager); format!("Only the Manager can list projects or change {}. Ask the Manager (@{name}).", entity_noun(true)) }
        None => format!("Only the Manager can list projects or change {}, and this team has no Manager yet. Ask the user to set one up.", entity_noun(true)),
    }
}

/// Manager-only: projects a blob can be attached to.
async fn list_projects(st: &AppState) -> Result<String, String> {
    let projects = st.db.project_list().map_err(|error| error.to_string())?;
    if projects.is_empty() { return Ok(format!("No projects exist yet. Create one in Bitbots, or create a casual {} with no project.", entity_noun(false))); }
    let rows = projects.iter().map(|project| {
        let name = project["name"].as_str().unwrap_or("Project");
        let id = project["id"].as_str().unwrap_or("");
        let path = project["path"].as_str().map(str::trim).filter(|path| !path.is_empty()).unwrap_or("(no folder)");
        let mut line = format!("- {name} (id {id}) · {path}");
        line.push_str(&tags_suffix(&project["tags"]));
        if let Some(description) = project["description"].as_str().map(str::trim).filter(|d| !d.is_empty()) { line.push_str(&format!("\n  {description}")); }
        line
    }).collect::<Vec<_>>();
    Ok(format!("Projects you can attach a {} to:\n{}", entity_noun(false), rows.join("\n")))
}

/// One delivered brief: the side conversation it opened (or continued), its
/// topic, and the teammate's name. Shared by `message_blob` and by FIX36 D2's
/// `assign_task` approval, so a task is delivered exactly like a message.
pub(crate) struct Delegation {
    pub side: String,
    pub title: String,
    pub target_name: String,
    /// Whether the turn started at once or was queued behind the global limit.
    /// FIX39 item 18: the Manager must not be told work is running when it is
    /// only waiting for a slot.
    pub started: bool,
    /// Why a queued assignment has not started: `busy` (its conversation is
    /// mid-turn) or `slots` (every global slot is taken). `None` when it started.
    pub queue_reason: Option<String>,
    /// The assignment's status when this call replayed a brief that was already
    /// sent: nothing was recorded or delivered a second time.
    pub duplicate: Option<String>,
}

/// One brief is one assignment: the Manager's turn, the sender, the target and the
/// brief's own text. `None` without an origin turn, because a call outside a turn
/// cannot be a replay of itself.
fn delegation_dedupe_key(origin_turn: Option<&str>, origin: &str, from: &str, target: &str, message: &str) -> Option<String> {
    let turn = origin_turn.filter(|turn| !turn.is_empty())?;
    let mut hasher = Sha256::new();
    for part in [origin, turn, from, target] {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    hasher.update(message.as_bytes());
    Some(format!("{:x}", hasher.finalize()))
}

/// Why this teammate's runtime cannot start a turn right now, as a sentence the
/// Manager can act on. This is the lookup `new_session` uses, and nothing else is
/// re-checked here: approval rules are untouched.
async fn unavailable_runtime(st: &AppState, target: &Value) -> Option<String> {
    let name = agent_name(target);
    let runtime_id = target["runtimeId"].as_str().unwrap_or("");
    let runtimes = st.runtimes.read().await;
    let Some(runtime) = runtimes.iter().find(|runtime| runtime["id"].as_str() == Some(runtime_id)) else {
        return Some(format!("{name} has no installed runtime any more, so it cannot start work. Ask the user to choose a runtime for {name}, or pick another teammate."));
    };
    let provider = runtime["provider"].as_str().unwrap_or("");
    // Presence and a usable adapter are what `new_session` needs before it can
    // even try; the executable's own preflight stays there, and its message names
    // the target, so nothing is duplicated here.
    if provider.is_empty() || crate::adapter_for(&st.adapters, provider).is_none() {
        return Some(format!("{name}'s runtime is not usable by Bitbots any more, so it cannot start work. Ask the user to fix {name}'s runtime, or pick another teammate."));
    }
    None
}

/// The delegation a replayed brief already recorded, with nothing recorded or
/// delivered a second time.
fn already_sent(row: &Value, target_name: &str) -> Delegation {
    Delegation {
        side: row["sideSessionId"].as_str().unwrap_or("").to_owned(),
        title: row["topic"].as_str().unwrap_or("").to_owned(),
        target_name: target_name.to_owned(),
        started: row["status"] == "running",
        queue_reason: row["queueReason"].as_str().map(str::to_owned),
        duplicate: Some(row["status"].as_str().unwrap_or("").to_owned()),
    }
}

async fn message_blob(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    let delegation = delegate(st, session_id, args).await?;
    let (target_name, title, side) = (&delegation.target_name, &delegation.title, &delegation.side);
    // A replayed call is answered with the assignment that really exists, never
    // with a second delivery.
    if let Some(status) = &delegation.duplicate {
        let state = match status.as_str() {
            "completed" => "it has finished",
            "failed" => "it failed",
            "cancelled" => "it was cancelled",
            "interrupted" => "a restart interrupted it",
            "queued" => "it is still waiting its turn",
            _ => "it is still running",
        };
        let reply = if matches!(status.as_str(), "queued" | "running") {
            format!("Its reply will arrive here as a message starting with \"[Reply from {target_name}]\".")
        } else {
            "Whatever it reported has already arrived here.".to_owned()
        };
        return Ok(format!("That brief was already sent to {target_name} in \"{title}\" (conversation {side}) for this turn and was not sent again; {state}. {reply} Tell the user you already asked {target_name} and end your turn now."));
    }
    let state = if delegation.started {
        "They are working on it"
    } else if delegation.queue_reason.as_deref() == Some("busy") {
        "They are finishing another conversation, so this one is queued and starts as soon as a slot frees"
    } else if delegation.queue_reason.as_deref() == Some("slots") {
        "Every bot slot is busy right now, so this one is queued and starts as soon as one frees"
    } else {
        "It is queued and starts as soon as a slot frees"
    };
    Ok(format!("Sent to {target_name} in \"{title}\" (conversation {side}). {state}; their reply will arrive here as a message starting with \"[Reply from {target_name}]\". Tell the user you asked {target_name} and end your turn now."))
}

/// A Manager-initiated hand-off: the global pause (`delegation.paused`) applies.
pub(crate) async fn delegate(st: &AppState, session_id: &str, args: &Value) -> Result<Delegation, String> {
    delegate_with(st, session_id, args, true).await
}

/// A hand-off the owner approved in the chat. The pause never blocks it: the owner just decided, and a pause must not
/// make an approval fail.
pub(crate) async fn delegate_approved(st: &AppState, session_id: &str, args: &Value) -> Result<Delegation, String> {
    delegate_with(st, session_id, args, false).await
}

async fn delegate_with(st: &AppState, session_id: &str, args: &Value, honour_pause: bool) -> Result<Delegation, String> {
    let message = args["message"].as_str().map(str::trim).filter(|m| !m.is_empty()).ok_or("message is required.")?.to_owned();
    if message.len() > 200_000 { return Err("The message is too long; keep briefs under 200 KB.".into()); }
    let from_row = st.db.session_detail(session_id).map_err(|_| "This conversation is no longer available.")?;
    let from_id = from_row["agentId"].as_str().ok_or_else(|| format!("Only {} conversations can message teammates.", entity_noun(false)))?.to_owned();
    let from = st.db.agent_get(&from_id).map_err(|_| format!("Your {} is no longer available.", entity_noun(false)))?;
    let agents = st.db.agent_list(false, None).map_err(|error| error.to_string())?;
    let names = agents.iter().filter(|a| a["id"] != from_id.as_str() && a["hidden"] != true).map(agent_name).collect::<Vec<_>>().join(", ");
    let wanted = args["blob"].as_str().unwrap_or("");
    // A teammate nobody can reach is named in the refusal, so the Manager learns
    // why it is not on the list instead of only that the name is unknown.
    let target = match resolve_blob(&agents, wanted) {
        Some(target) => target,
        None => {
            let all = st.db.agent_list(true, None).unwrap_or_default();
            return Err(match resolve_blob(&all, wanted) {
                Some(unreachable) if unreachable["archived"] == true => format!("{} is archived, so it cannot be reached. Ask the user to restore it, or pick another teammate. Teammates: {names}.", agent_name(&unreachable)),
                Some(unreachable) if unreachable["hidden"] == true => format!("{} is hidden from the team, so work cannot be sent to it. Ask the user to show it in the team, or pick another teammate. Teammates: {names}.", agent_name(&unreachable)),
                _ => format!("No teammate is called that. Teammates: {names}."),
            });
        }
    };
    let target_id = target["id"].as_str().unwrap_or("").to_owned();
    let target_name = agent_name(&target);
    if target_id == from_id { return Err("You cannot message yourself.".into()); }
    // Why this teammate cannot take work now, before any conversation is made.
    if target["hidden"] == true {
        return Err(format!("{target_name} is hidden from the team, so work cannot be sent to it. Ask the user to show it in the team, or pick another teammate."));
    }
    if bot_is_locked(&target) {
        return Err(format!("{target_name} is locked, so it cannot start new work. Ask the user to unlock {target_name}, or pick another teammate."));
    }
    if let Some(reason) = unavailable_runtime(st, &target).await { return Err(reason); }
    let depth = st.team.depth.lock().unwrap().get(session_id).copied().unwrap_or(0) + 1;
    if depth > MAX_DEPTH { return Err(depth_error()); }
    let from_name = agent_name(&from);
    let topic = args["topic"].as_str().and_then(clean_topic);
    // FIX47: the assignment is recorded against the Manager turn that sent it, so
    // a replay of the same tool call can be recognised below.
    let origin_turn = st.active_turns.lock().await.get(session_id).cloned();
    let dedupe_key = delegation_dedupe_key(origin_turn.as_deref(), session_id, &from_id, &target_id, &message);
    if let Some(key) = &dedupe_key {
        if let Some(row) = st.db.delegation_find_by_dedupe(key).ok().flatten() {
            return Ok(already_sent(&row, &target_name));
        }
    }
    // Owner's global pause (Lane V1, item 3): a *new* assignment is refused while
    // it is on. A replay above already returned its recorded row, so a pause never
    // turns a replay into a refusal, and nothing that is already recorded,
    // running, queued, approved or waiting is touched: this is the first check a
    // new brief meets. One keyed settings read, and the sentence is the Manager's
    // to relay.
    if honour_pause && st.db.delegation_paused().unwrap_or(false) {
        return Err("Delegation is paused. Ask the user to resume it in Manager settings, or do the work yourself.".into());
    }
    let wanted_conversation = args["conversation"].as_str().map(str::trim).filter(|id| !id.is_empty());
    let existing = match wanted_conversation {
        Some(id) => Some(continuable(st, id, &from_id, &target_id, &target_name)?),
        // Without a topic or an id, keep talking in the latest conversation with
        // them, preferring the one this conversation started.
        None if topic.is_none() => st.db.side_session_for(&target_id, &from_id, session_id).map_err(|error| error.to_string())?,
        None => None,
    };
    let (side, title) = match existing {
        Some(side) => {
            let row = st.db.session_detail(&side).map_err(|error| error.to_string())?;
            let mut link = row["link"].clone();
            link["peerName"] = json!(from_name);
            link["originSessionId"] = json!(session_id);
            let _ = st.db.set_session_link(&side, &link);
            (side, row["title"].as_str().unwrap_or("").to_owned())
        }
        None => {
            let title = topic.unwrap_or_else(|| topic_from(&message));
            let mut link = json!({"kind":"side","peerAgentId":from_id,"peerName":from_name,"originSessionId":session_id,"spawnedFromSessionId":session_id,"topic":title});
            // FIX39 item 19.4: an approved task that names a project runs the
            // delegated conversation in that project's folder, so the `auto`
            // classifier can touch the files the task is about. Without it the
            // bot works in its own scratch workspace and every project path is
            // outside the allowed set.
            let project_path = args["projectPath"].as_str().map(str::trim).filter(|path| !path.is_empty())
                .map(std::path::PathBuf::from).filter(|path| path.is_dir())
                .unwrap_or_else(|| workspace_for(st, &target));
            // FIX39 P10: when another task is already working in this git repo,
            // run this one in its own worktree instead, so the two cannot clash.
            let mut run_path = project_path;
            let attempt = prepare_worktree_attempt(st, session_id, &run_path, &title, &target).await;
            if let Some(worktree) = attempt.worktree {
                if let Some(path) = worktree["path"].as_str() { run_path = PathBuf::from(path); }
                link["worktree"] = worktree;
            } else if let Some(reason) = attempt.error {
                // Isolation was wanted and did not happen, so this runs in the
                // shared folder. Record why, in the link, once: the workspace
                // report shows it instead of claiming the folder is fine.
                link["worktreeError"] = json!(short_reason(&reason));
            }
            let created = new_session(st, json!({"agentId":target_id,"projectPath":run_path,"title":title,"link":link.clone()})).await
                .map_err(|error| format!("Could not open a conversation with {target_name}: {}", error.1.message))?;
            let side = created["id"].as_str().unwrap_or("").to_owned();
            if let Some(worktree) = link.get("worktree").filter(|worktree| worktree.is_object()) {
                // The one visible trace of the isolation in the sub-conversation.
                let repo_name = Path::new(worktree["repo"].as_str().unwrap_or("")).file_name().and_then(|name| name.to_str()).unwrap_or("the project");
                let branch = worktree["branch"].as_str().unwrap_or("");
                note(st, &side, &format!("Working in a separate copy of {repo_name} (branch {branch}) so other work there isn't disturbed; the changes will be offered for merge when the task is done."),
                    json!({"kind":"worktree","direction":"isolated","branch":branch})).await;
            }
            (side, title)
        }
    };
    // FIX39 item 18: with no per-bot cap, a delivery starts unless the
    // conversation is mid-turn or every global slot is taken. The reason travels
    // with the row, so the Manager's board can say which of the two it is.
    let busy = session_busy(st, &side).await;
    let slots_full = st.db.active_turn_reservation_count().unwrap_or(0) >= crate::global_concurrency_limit(st).max(0) as u64;
    let started = !busy && !slots_full;
    let queue_reason = if started { None } else if busy { Some("busy") } else { Some("slots") };
    let queue_reason = queue_reason.map(str::to_owned);
    let preview = message.chars().take(280).collect::<String>();
    // FIX47: the assignment is recorded before it is announced, so the Manager's
    // conversation can show its own status for it (the side conversation's state
    // is not the assignment's: several assignments can share one conversation).
    // A ledger failure never blocks the message.
    let side_row = st.db.session_detail(&side).ok();
    let workspace_path = side_row.as_ref().and_then(|row| row["projectPath"].as_str()).unwrap_or_default().to_owned();
    let worktree = side_row.as_ref().map(|row| row["link"]["worktree"].clone()).filter(Value::is_object);
    let recorded = crate::delegations::record(st, json!({
        "originSessionId": session_id, "originTurnId": &origin_turn, "sideSessionId": &side,
        "fromAgentId": &from_id, "targetAgentId": &target_id, "topic": &title, "briefPreview": &preview,
        "workspacePath": &workspace_path, "worktree": &worktree, "deliveryText": &message, "deliveryDepth": depth,
        "dedupeKey": &dedupe_key, "queueReason": &queue_reason, "doneGoal": args["doneGoal"],
    })).await;
    // A concurrent replay lost the race to record: its row is the assignment, and
    // nothing is announced or delivered here.
    if let Some((row, created)) = &recorded {
        if !*created { return Ok(already_sent(row, &target_name)); }
    }
    let delegation_id = recorded.as_ref().and_then(|(row, _)| row["id"].as_str().map(str::to_owned));
    let mut notice = json!({"kind":"delegation","direction":"sent","peerAgentId":target_id,"peerName":target_name,"sideSessionId":side,"topic":title,"originTurnId":origin_turn});
    if let Some(reason) = &queue_reason { notice["queueReason"] = json!(reason); }
    if let Some(id) = &delegation_id { notice["delegationId"] = json!(id); }
    note_above_turn_text(st, session_id, &preview, notice).await;
    let state = st.clone();
    let side_for_task = side.clone();
    let mut meta = json!({"kind":"blob_message","fromAgentId":from_id,"fromName":from_name});
    if let Some(id) = &delegation_id { meta["delegationId"] = json!(id); }
    tokio::spawn(async move {
        deliver(&state, &side_for_task, message, meta, depth, false).await;
    });
    Ok(Delegation { side, title, target_name, started, queue_reason, duplicate: None })
}

/// A conversation id the sender may continue: one they started with this teammate.
pub(crate) fn continuable(st: &AppState, id: &str, from_id: &str, target_id: &str, target_name: &str) -> Result<String, String> {
    let row = st.db.session_detail(id).map_err(|_| format!("No conversation has the id {id}. Call list_conversations to see yours."))?;
    let link = &row["link"];
    if link["kind"] != "side" || row["archived"] == true { return Err(format!("{id} is not an open side conversation. Call list_conversations to see yours.")); }
    let title = row["title"].as_str().unwrap_or("that conversation");
    if row["agentId"] == target_id && link["peerAgentId"] == from_id { return Ok(id.to_owned()); }
    if row["agentId"] == from_id && link["peerAgentId"] == target_id {
        return Err(format!("{target_name} started \"{title}\" with you, and your final message there goes back to them automatically. To ask {target_name} something, continue a conversation you started or start a new one with a topic."));
    }
    Err(format!("\"{title}\" is not a conversation between you and {target_name}."))
}

/// A topic the sender gave, tidied: no quotes or leading #, at most 60 characters.
fn clean_topic(raw: &str) -> Option<String> {
    let topic = raw.trim().trim_matches(|c| c == '"' || c == '\'' || c == '#').trim();
    (!topic.is_empty()).then(|| topic.chars().take(60).collect())
}

/// A title for a conversation started without a topic: the brief's first words.
pub(crate) fn topic_from(message: &str) -> String {
    let line = message.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("Conversation");
    let words = line.split_whitespace().take(7).collect::<Vec<_>>().join(" ");
    let mut topic = words.trim_end_matches(|c: char| ",.;:!?".contains(c)).to_owned();
    if topic.chars().count() > 48 { topic = topic.chars().take(47).collect::<String>() + "…"; }
    if topic.is_empty() { "Conversation".into() } else { topic }
}

fn one_line(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > limit { flat.chars().take(limit - 1).collect::<String>() + "…" } else { flat }
}

async fn list_conversations(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    let me = st.db.session_detail(session_id).ok().and_then(|row| row["agentId"].as_str().map(str::to_owned)).ok_or_else(|| format!("Only {} conversations have side conversations.", entity_noun(false)))?;
    let agents = st.db.agent_list(true, None).map_err(|error| error.to_string())?;
    let only = args["blob"].as_str().map(str::trim).filter(|name| !name.is_empty()).map(|name| resolve_blob(&agents, name).ok_or_else(|| format!("No teammate is called {name}."))).transpose()?;
    let name_of = |id: &str| agents.iter().find(|agent| agent["id"] == id).map(agent_name).unwrap_or_else(|| "A former teammate".into());
    let mut rows = Vec::new();
    for row in st.db.side_conversations(&me).map_err(|error| error.to_string())? {
        let id = row["id"].as_str().unwrap_or("");
        let mine = row["peerAgentId"] == me.as_str();
        let other = if mine { row["agentId"].as_str().unwrap_or("") } else { row["peerAgentId"].as_str().unwrap_or("") };
        if only.as_ref().is_some_and(|agent| agent["id"] != other) { continue; }
        let when = row["updatedAt"].as_str().unwrap_or("").get(..16).unwrap_or("").replace('T', " ");
        let mut line = format!("- {id} · \"{}\" with {} · {} · {} messages · last active {when} UTC", row["title"].as_str().unwrap_or("Conversation"), name_of(other), if mine { "you started it" } else { "they started it" }, row["messages"]);
        if let Some(reply) = st.db.last_reply(id).ok().flatten() { line.push_str(&format!("\n  Latest reply: {}", one_line(&reply, 180))); }
        rows.push(line);
        if rows.len() >= 15 { break; }
    }
    if rows.is_empty() { return Ok("You have no side conversations yet. Start one with message_blob and a short topic.".into()); }
    Ok(format!("Your side conversations, newest first:\n{}\n\nTo continue one you started, call message_blob with its id as `conversation`. Conversations a teammate started with you are answered automatically when they message you.", rows.join("\n")))
}

/// Context for side conversations the user referenced with # in a prompt.
/// Returns the text appended to the prompt the blob receives, and the
/// references kept on the stored message (the visible text stays as typed).
pub fn reference_context(st: &AppState, session_id: &str, refs: &Value) -> Option<(String, Value)> {
    let ids = refs.as_array()?.iter().filter_map(Value::as_str).take(5).collect::<Vec<_>>();
    if ids.is_empty() { return None; }
    let me = st.db.session_detail(session_id).ok()?["agentId"].as_str()?.to_owned();
    let agents = st.db.agent_list(true, None).ok()?;
    let name_of = |id: &str| agents.iter().find(|agent| agent["id"] == id).map(agent_name).unwrap_or_else(|| "a former teammate".into());
    let mut lines = Vec::new();
    let mut kept = Vec::new();
    for id in ids {
        let Ok(row) = st.db.session_detail(id) else { continue };
        let link = &row["link"];
        let (agent, peer) = (row["agentId"].as_str().unwrap_or(""), link["peerAgentId"].as_str().unwrap_or(""));
        if link["kind"] != "side" || (agent != me && peer != me) { continue; }
        let title = row["title"].as_str().unwrap_or("Conversation");
        let mine = peer == me;
        let other = if mine { agent } else { peer };
        let mut line = format!("- \"{title}\" (conversation {id}) with {}, {}.", name_of(other), if mine { "which you started" } else { "which they started" });
        if mine { line.push_str(&format!(" To follow up there, call message_blob with blob \"{}\" and conversation \"{id}\".", name_of(other))); }
        if let Some(reply) = st.db.last_reply(id).ok().flatten() { line.push_str(&format!("\n  Latest reply: {}", one_line(&reply, 600))); }
        lines.push(line);
        kept.push(json!({"id":id,"title":title}));
    }
    if kept.is_empty() { return None; }
    Some((format!("\n\n<bloblex_references>\nThe user referenced these side conversations with #:\n{}\n</bloblex_references>", lines.join("\n")), Value::Array(kept)))
}

/// A visible note in a conversation that is not a prompt (e.g. "Messaged Codex").
/// A notice for something the blob DID during its running turn ("Messaged X").
/// It is placed above the turn's assistant text so the call reads before what the
/// assistant says about it; the event names the message it sits above so open
/// windows insert it in the same place a reload would show it.
pub(crate) async fn note_above_turn_text(st: &AppState, session_id: &str, content: &str, meta: Value) {
    let turn = st.active_turns.lock().await.get(session_id).cloned().unwrap_or_default();
    let Ok((message, before)) = st.db.append_notice_above_turn_text(session_id, &turn, content, &json!({"meta":meta})) else { return };
    if message.is_null() { return; }
    let mut payload = json!({"sessionId":session_id,"messageId":message["id"],"role":"notice","message":message});
    if let Some(before) = before { payload["beforeMessageId"] = json!(before); }
    st.emit("message.completed", payload).await;
}

pub(crate) async fn note(st: &AppState, session_id: &str, content: &str, meta: Value) {
    if let Ok(message) = st.db.append_message_with_data(session_id, "", "notice", content, &json!({"meta":meta})) {
        if !message.is_null() {
            st.emit("message.completed", json!({"sessionId":session_id,"messageId":message["id"],"role":"notice","message":message})).await;
        }
    }
}

/// Whether a delivery went out now or is waiting for the conversation to be free.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Delivery { Sent, Queued }

/// Prompts a session now, or queues the prompt until its current turn ends.
/// `retry` is true when the drain is re-delivering an item it just popped, so a
/// second refusal puts it back at the FRONT (order kept) and never writes a
/// second "Waiting for" notice.
async fn deliver(st: &AppState, session_id: &str, text: String, meta: Value, depth: u32, retry: bool) -> Delivery {
    if session_busy(st, session_id).await {
        if retry { requeue_front(st, session_id, text, meta, depth).await; }
        else { queue_delivery(st, session_id, text, meta, depth).await; }
        return Delivery::Queued;
    }
    // FIX47: the delivery carries the ledger row it belongs to, so starting and
    // failing update that assignment and not the side conversation's other ones.
    // A reply carries the row it reports on as well, and an update from a side
    // conversation its open assignment; neither starts nor fails that assignment:
    // only a forwarded brief does.
    let delegation = (!matches!(meta["kind"].as_str(), Some("blob_reply" | "blob_update")))
        .then(|| meta["delegationId"].as_str()).flatten().map(str::to_owned);
    st.team.depth.lock().unwrap().insert(session_id.to_owned(), depth);
    match crate::session_prompt_for_team(st, json!({"sessionId":session_id,"text":text.clone(),"meta":meta.clone()})).await {
        Ok(accepted) => {
            if let Some(id) = delegation.as_deref() { crate::delegations::started(st, id, accepted["turnId"].as_str().unwrap_or("")).await; }
            Delivery::Sent
        }
        Err(error) => {
            st.team.depth.lock().unwrap().remove(session_id);
            if error.1.code == "conflict" {
                // The global limit refused it. A retry goes back to the front with no
                // new notice; a first arrival queues at the back and says so.
                // FIX47: a refused delivery has not started, so its row stays queued.
                if retry { requeue_front(st, session_id, text, meta, depth).await; }
                else { queue_delivery(st, session_id, text, meta, depth).await; }
                Delivery::Queued
            } else {
                if let Some(id) = delegation.as_deref() { crate::delegations::failed(st, id, &error.1.message).await; }
                relay_failure(st, session_id, &error.1.message, delegation.as_deref()).await;
                // The sender was told the delivery failed, so nothing is waiting.
                Delivery::Sent
            }
        }
    }
}

/// The `[Reply from X]` relay into the Manager's conversation, with its ledger
/// row attached so the relay is sent once per outcome and outlives a restart.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn deliver_reply(st: &AppState, origin: &str, side: &str, agent_id: &str, name: &str, text: String, delegation: Option<&str>, depth: u32) -> Delivery {
    let mut meta = json!({"kind":"blob_reply","fromAgentId":agent_id,"fromName":name,"sideSessionId":side});
    if let Some(id) = delegation { meta["delegationId"] = json!(id); }
    deliver(st, origin, text, meta, depth, false).await
}

/// The `[Update from X]` notice into the Manager's conversation: a teammate's own
/// conversation is waiting for the owner to approve or answer something. It goes
/// through the same path as a reply, so a busy Manager queues it. It carries the
/// assignment and the request id, which keeps one request from queueing twice,
/// and it neither starts nor fails that assignment (only a brief does). It grants
/// nothing: the request stays the owner's to answer where it was asked.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn deliver_update(st: &AppState, origin: &str, side: &str, agent_id: &str, name: &str, text: String,
    delegation: &str, request_id: &str, request_kind: &str, title: &str, depth: u32) -> Delivery {
    let meta = json!({"kind":"blob_update","fromAgentId":agent_id,"fromName":name,"sideSessionId":side,
        "delegationId":delegation,"requestId":request_id,"requestKind":request_kind,"title":title});
    deliver(st, origin, text, meta, depth, false).await
}

/// Queues one delivery behind a busy conversation and makes it visible. FIX39
/// item 18: an empty side conversation used to render the bot's "Ready when you
/// are" screen while its work sat in an in-memory queue; the visible notice means
/// the wait is honest and the conversation is never mistaken for idle.
async fn queue_delivery(st: &AppState, session_id: &str, text: String, meta: Value, depth: u32) {
    // FIX39 P6 audit finding 2: only a forwarded delegation says it is waiting. A
    // side reply relayed back to a busy origin queues silently — nothing new is
    // waiting, and the text would name the origin's own bot in its own chat.
    let notify = meta["kind"] == "blob_message";
    // Only the first item that makes the queue non-empty writes the notice, so a
    // delivery retried as slots come and go does not stack "Waiting for" lines.
    // The same brief is never queued twice, however often it is offered.
    let (pushed, was_empty) = {
        st.team.push_queued(st, session_id, text, meta, depth, false).await
    };
    if !pushed || !was_empty || !notify { return; }
    let name = st.db.session_detail(session_id).ok()
        .and_then(|row| row["agentId"].as_str().and_then(|id| st.db.agent_get(id).ok()))
        .map(|agent| agent_name(&agent))
        .unwrap_or_else(|| "The teammate".into());
    note(st, session_id, &format!("Waiting for {name} to finish another conversation."), json!({"kind":"delegation","direction":"waiting","state":"queued"})).await;
}

/// Puts a refused delivery back at the FRONT of its queue with no notice. FIX39
/// P6 audit finding 1: the drain pops the front item and may still be refused
/// (the global limit is held by another conversation), so re-delivering it must
/// not move it behind messages that arrived after it.
async fn requeue_front(st: &AppState, session_id: &str, text: String, meta: Value, depth: u32) {
    st.team.push_queued(st, session_id, text, meta, depth, true).await;
}

/// Whether a delivery that has reached the front belongs to an assignment that is
/// already over: a cancelled (or otherwise finished) delegation must never be
/// delivered. Only forward briefs and wakes are checked; a reply carries the id
/// of the row it reports on, which is terminal by definition. A wake of a
/// finished assignment is also no longer meaningful (Lane V1), and the caller
/// records it dropped.
fn stopped_delegation(st: &AppState, meta: &Value) -> bool {
    if !matches!(meta["kind"].as_str(), Some("blob_message" | "blob_update")) { return false; }
    let Some(id) = meta["delegationId"].as_str().filter(|id| !id.is_empty()) else { return false };
    if meta["kind"] == "blob_update" {
        if let Some(request) = meta["requestId"].as_str().filter(|request| !request.is_empty()) {
            // Approvals can resolve while the Manager is busy. Do not deliver a
            // stale wake once its original card has already been decided.
            if matches!(st.db.permission_status(request), Ok(Some(status)) if status != "pending") { return true; }
        }
    }
    st.db.delegation_get(id).ok().is_some_and(|row| matches!(row["status"].as_str(), Some("completed" | "failed" | "cancelled" | "interrupted")))
}

/// FIX39 item 18: after any turn ends, try every session with a queued delivery,
/// not only the one that just finished. The global limit can be what refused a
/// delivery, so a turn ending in a *different* conversation must release it.
pub(crate) async fn drain_queued_deliveries(st: &AppState, preferred: Option<&str>) {
    let mut ids: Vec<String> = st.team.queued.lock().await.iter().filter(|(_, queue)| !queue.is_empty()).map(|(id, _)| id.clone()).collect();
    if let Some(preferred) = preferred {
        ids.retain(|id| id != preferred);
        ids.insert(0, preferred.to_owned());
    }
    for sid in ids {
        if session_busy(st, &sid).await { continue; }
        // The front may hold briefs whose assignment was cancelled while it
        // waited: those are dropped silently, never delivered, and the next item
        // is tried instead.
        loop {
            let next = st.team.queued.lock().await.get_mut(&sid).and_then(VecDeque::pop_front);
            let Some(next) = next else { break };
            // The durable row goes the moment the delivery leaves the queue, so a
            // restart can never offer something that already went out.
            let _ = st.db.team_queue_remove(&next.id);
            if stopped_delegation(st, &next.meta) {
                // A wake whose assignment ended while it waited is recorded as
                // dropped, so a later boot does not offer it again.
                crate::delegations::drop_queued_wake(st, &next.meta);
                continue;
            }
            let delivery = deliver(st, &sid, next.text, next.meta.clone(), next.depth, true).await;
            // A reply or wake that finally leaves the queue has reached the
            // Manager, so the row it reports on stops waiting for it.
            if delivery == Delivery::Sent {
                crate::delegations::settle_queued_reply(st, &next.meta);
                crate::delegations::settle_queued_wake(st, &next.meta);
            }
            break;
        }
    }
}

/// When a side conversation cannot even start a turn, tell the sender.
async fn relay_failure(st: &AppState, side_session: &str, reason: &str, delegation: Option<&str>) {
    let Ok(row) = st.db.session_detail(side_session) else { return };
    let link = &row["link"];
    let Some(origin) = link["originSessionId"].as_str() else { return };
    let name = row["agentId"].as_str().and_then(|id| st.db.agent_get(id).ok()).map(|a| agent_name(&a)).unwrap_or_else(|| "The teammate".into());
    let mut meta = json!({"kind":"delegation","direction":"failed","peerAgentId":row["agentId"],"peerName":name,"sideSessionId":side_session});
    if let Some(id) = delegation { meta["delegationId"] = json!(id); }
    note(st, origin, &format!("{name} could not start: {reason}"), meta).await;
}

/// The wording of the `[Reply from X]` body for one assignment outcome, shared by
/// the live relay in [`after_turn`] and the startup re-offer in
/// [`crate::delegations::startup`], so a reply that outlives a restart reads
/// exactly like the one sent at the time.
///
/// `outcome_kind` is `completed`, `cancelled` or `failed`; `reply_or_detail` is
/// the turn's stored reply for a completion and the failure's detail otherwise.
pub(crate) fn reply_text(outcome_kind: &str, reply_or_detail: Option<&str>) -> String {
    let present = reply_or_detail.map(str::trim).filter(|text| !text.is_empty());
    match outcome_kind {
        "completed" => present.unwrap_or("(finished without a text reply)").to_owned(),
        "cancelled" => "The task was cancelled before it finished.".to_owned(),
        _ => format!("The turn failed: {}", present.unwrap_or("the provider reported an error")),
    }
}

/// The body of one relay: the reply itself, then the assignment's own "Done when"
/// line when it has one (wave 12, part D), so the Manager compares the result with
/// what was asked instead of guessing. Shared by the live relay, a stop and the
/// startup re-offer, so all three read the same.
pub(crate) fn relay_body(reply: &str, done_goal: Option<&str>) -> String {
    match done_goal.map(str::trim).filter(|goal| !goal.is_empty()) {
        Some(goal) => format!("{reply}\nDone when: {goal}"),
        None => reply.to_owned(),
    }
}

/// Runs after every turn: relays side-conversation replies and drains queues.
pub fn after_turn(st: &AppState, session_id: &str, turn: Option<String>, outcome: &str, detail: Option<String>) {
    let st = st.clone();
    let session_id = session_id.to_owned();
    let outcome = outcome.to_owned();
    tokio::spawn(async move {
        let depth = st.team.depth.lock().unwrap().remove(&session_id).unwrap_or(0);
        // Only the link and the bot are read here, so the turn end must not load the whole conversation.
        if let Ok(row) = st.db.session_brief(&session_id) {
            let link = row["link"].clone();
            if link["kind"] == "side" {
                // FIX47: the assignment that owned this turn gets its outcome
                // before the reply is relayed, so a status shown to the user is
                // never ahead of or behind the message it is about.
                let end = crate::delegations::after_turn(&st, &session_id, turn.clone(), &outcome, detail.clone()).await;
                // A turn that ended on a question only the owner can answer has
                // not finished the assignment: nothing is relayed, and the
                // assignment keeps running until the answer's next turn ends it.
                // A silent `(pass)` assignment is finished but owes no reply either.
                let origin = (!matches!(end, crate::delegations::TurnEnd::Waiting | crate::delegations::TurnEnd::Silent))
                    .then(|| link["originSessionId"].as_str().filter(|origin| st.db.session_exists(origin).unwrap_or(false)))
                    .flatten();
                if let Some(origin) = origin {
                    // A duplicate turn ending must not wake the Manager twice: the
                    // ledger row's reply slot is the claim, so only the first call
                    // that finds it empty sends. A turn no assignment tracks (or
                    // one an automatic retry continues) has nothing to claim.
                    let owed: Option<&Value> = match &end {
                        crate::delegations::TurnEnd::Ungoverned | crate::delegations::TurnEnd::Waiting | crate::delegations::TurnEnd::Silent => None,
                        crate::delegations::TurnEnd::Owed(row) => Some(row),
                    };
                    if owed.is_none_or(|row| crate::delegations::claim_reply(&st, row)) {
                        let target_id = row["agentId"].as_str().unwrap_or("").to_owned();
                        let name = st.db.agent_get(&target_id).map(|a| agent_name(&a)).unwrap_or_else(|_| "Teammate".into());
                        let kind = match outcome.as_str() { "turn.completed" => "completed", "turn.cancelled" => "cancelled", _ => "failed" };
                        let source = match kind {
                            "completed" => turn.as_deref().and_then(|turn| st.db.turn_reply(&session_id, turn).ok().flatten()),
                            "cancelled" => None,
                            _ => detail.clone(),
                        };
                        let reply = reply_text(kind, source.as_deref());
                        let text = format!("[Reply from {name}]\n{}", relay_body(&reply, owed.and_then(|row| row["doneGoal"].as_str())));
                        let delegation = owed.and_then(|row| row["id"].as_str());
                        let delivery = deliver_reply(&st, origin, &session_id, &target_id, &name, text, delegation, depth).await;
                        // A reply still waiting in the queue keeps `pending`, so the
                        // next boot offers it again instead of losing it.
                        if let Some(row) = owed { crate::delegations::settle_reply(&st, row, delivery == Delivery::Sent); }
                    }
                }
            }
        }
        // FIX39 P10: a task that ran in its own worktree offers a merge when its
        // turn finishes; a task with nothing to merge just cleans up.
        crate::proposals::after_task_turn(&st, &session_id, &outcome).await;
        // Automation runs map the same turn outcome onto their run row.
        crate::automations::after_turn(&st, &session_id, &outcome).await;
        // Board task runs map it onto their task and run.
        crate::tasks::after_turn(&st, &session_id, &outcome).await;
        // The durable user queue drains before Team deliveries, so a queued
        // prompt is sent first and any pending team delivery follows it.
        crate::queue::after_turn(&st, &session_id, &outcome).await;
        // FIX39 item 18: drain this session first, then any other session whose
        // delivery was refused by the global limit while this turn held a slot.
        drain_queued_deliveries(&st, Some(&session_id)).await;
    });
}

/// A blob's single main conversation, created on first open in its workspace.
pub async fn agent_conversation(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let agent_id = p["agentId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "agentId is required", StatusCode::BAD_REQUEST))?;
    let agent = st.db.agent_get(agent_id).map_err(agent_error)?;
    if agent["archived"] == true { return Err(derr("conflict", &format!("archived {} have no conversation", entity_noun(true)), StatusCode::CONFLICT)); }
    if let Some(id) = st.db.main_session(agent_id).map_err(agent_error)? {
        return Ok(json!({"session": st.db.session_detail(&id).map_err(agent_error)?, "created": false}));
    }
    let created = new_session(st, json!({"agentId":agent_id,"projectPath":workspace_for(st, &agent),"title":agent_name(&agent)})).await?;
    let id = created["id"].as_str().unwrap_or("");
    Ok(json!({"session": st.db.session_detail(id).map_err(agent_error)?, "created": true}))
}

/// A new conversation with a bot, created ahead of its first message. Nothing
/// is spawned: the row is persisted (idle, not resumable, lazy) and the first
/// prompt's activation starts the provider.
pub async fn agent_conversation_create(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let agent_id = p["agentId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "agentId is required", StatusCode::BAD_REQUEST))?;
    let agent = st.db.agent_get(agent_id).map_err(agent_error)?;
    if agent["archived"] == true { return Err(derr("invalid_argument", &format!("archived {} have no conversation", entity_noun(true)), StatusCode::BAD_REQUEST)); }
    let title = p["title"].as_str().map(str::trim).filter(|title| !title.is_empty()).unwrap_or("New chat").to_owned();
    if title.chars().count() > 120 { return Err(derr("invalid_argument", "title must be at most 120 characters", StatusCode::BAD_REQUEST)); }
    let created = new_session(st, json!({"agentId":agent_id,"projectPath":workspace_for(st, &agent),"title":title,"lazy":true})).await?;
    let id = created["id"].as_str().unwrap_or("");
    Ok(json!({"session": st.db.session_detail(id).map_err(agent_error)?}))
}

/// Every conversation a bot has in a project: its main conversations plus the
/// side conversations it started as the asking peer, nested by the session that
/// spawned them.
pub async fn agent_conversations(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let agent_id = p["agentId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "agentId is required", StatusCode::BAD_REQUEST))?;
    st.db.agent_get(agent_id).map_err(agent_error)?;
    let include_archived = match p.get("includeArchived") {
        None | Some(Value::Null) => false,
        Some(value) => value.as_bool().ok_or_else(|| derr("invalid_argument", "includeArchived must be a boolean", StatusCode::BAD_REQUEST))?,
    };
    let project_id = match p.get("projectId") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "projectId must be a string", StatusCode::BAD_REQUEST))?),
    };
    let rows = st.db.agent_conversations(agent_id, project_id, include_archived).map_err(agent_error)?;
    let ids = rows.iter().filter_map(|row| row["id"].as_str().map(str::to_owned)).collect::<Vec<_>>();
    let conversations = rows.into_iter().map(|row| {
        let kind = row["kind"].as_str().unwrap_or("main").to_owned();
        let peer = row["peerAgentId"].as_str();
        let role = if kind == "side" { if peer == Some(agent_id) { json!("sender") } else { json!("receiver") } } else { Value::Null };
        let parent = row["spawnedFromSessionId"].as_str().or_else(|| row["originSessionId"].as_str());
        let parent_id = parent.filter(|id| ids.iter().any(|known| known == id)).map(|id| json!(id)).unwrap_or(Value::Null);
        json!({
            "id": row["id"], "title": row["title"], "state": row["state"], "createdAt": row["createdAt"], "updatedAt": row["updatedAt"],
            "archived": row["archived"], "projectId": row["projectId"], "kind": kind, "agentId": row["agentId"], "peerAgentId": row["peerAgentId"],
            "topic": row["topic"], "parentId": parent_id, "role": role, "messageCount": row["messageCount"]
        })
    }).collect::<Vec<_>>();
    Ok(json!({"conversations": conversations}))
}

pub async fn team_rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "project.list" => Ok(json!({"projects": st.db.project_list().map_err(agent_error)?})),
        "project.create" => {
            let (project, events) = st.db.project_create(p["name"].as_str().unwrap_or(""), p["path"].as_str()).map_err(agent_error)?;
            st.broadcast_persisted(events);
            Ok(json!({"project": project}))
        }
        "project.update" => {
            let id = p["projectId"].as_str().unwrap_or("");
            let (project, events) = st.db.project_update(id, p).map_err(agent_error)?;
            st.broadcast_persisted(events);
            Ok(json!({"project": project}))
        }
        "project.delete" => {
            let id = p["projectId"].as_str().unwrap_or("");
            // FIX39 item 13 / P5 audit F2: deleting a project would move its
            // locked bots to Unassigned, which is a settings change. Refuse
            // while any of them is locked.
            let agents = st.db.agent_list(false, None).map_err(agent_error)?;
            if agents.iter().any(|agent| agent["projectId"].as_str() == Some(id) && bot_is_locked(agent)) {
                return Err(locked_bot_error());
            }
            let events = st.db.project_delete(id).map_err(agent_error)?;
            st.broadcast_persisted(events);
            Ok(json!({"deleted": true}))
        }
        "agent.team.update" => {
            let id = p["agentId"].as_str().unwrap_or("");
            // FIX39 item 13: a locked bot keeps its settings. Placement the
            // owner still expects to work (sidebar pin, sort order, visibility)
            // stays open; a project, role or leader change is a settings change.
            // P5 audit F2: compare against the stored values, so a write that
            // repeats them (a drop inside the same project) stays layout, while
            // `projectId: null` (the "Unassigned" target) and `leader` are
            // refused like any other change.
            if let Ok(agent) = st.db.agent_get(id) {
                if bot_is_locked(&agent) {
                    let project_changed = p.get("projectId").is_some_and(|project| project.as_str() != agent["projectId"].as_str());
                    let role_changed = p.get("role").is_some_and(|role| role.as_str().map(str::trim) != agent["role"].as_str());
                    let leader_changed = p.get("leader").is_some_and(|leader| leader.as_bool() != agent["leader"].as_bool());
                    // FIX39 item 21: a locked bot's tags are locked with the rest
                    // of its settings.
                    let tags_changed = p.get("tags").is_some_and(|tags| tags != &agent["tags"]);
                    if project_changed || role_changed || leader_changed || tags_changed { return Err(locked_bot_error()); }
                }
            }
            // FIX36: the Manager works across every project and its leadership
            // is permanent, so neither a project nor a leader change applies.
            if let Ok(agent) = st.db.agent_get(id) {
                if agent["systemRole"].as_str() == Some("manager") {
                    if p.get("projectId").is_some_and(|project| !project.is_null()) { return Err(derr("conflict", "The Manager works across every project", StatusCode::CONFLICT)); }
                    if p.get("leader").is_some() { return Err(derr("conflict", "The Manager can't be removed; you can rename it or change its model", StatusCode::CONFLICT)); }
                }
            }
            let (agent, events) = st.db.agent_set_team(id, p).map_err(agent_error)?;
            st.broadcast_persisted(events);
            // A bot that changes project keeps its conversations; the panel
            // filters them by project instead of archiving the old main one.
            Ok(json!({"agent": agent}))
        }
        "agent.conversation" => agent_conversation(st, p).await,
        "agent.conversation.create" => agent_conversation_create(st, p).await,
        "agent.conversations" => agent_conversations(st, p).await,
        _ => Err(derr("not_found", "unknown method", StatusCode::NOT_FOUND)),
    }
}

#[cfg(test)]
#[path = "team_p7_tests.rs"]
mod p7_tests;

#[cfg(test)]
#[path = "team_p10_tests.rs"]
mod p10_tests;

/// Stable Manager-only additions to the existing local, session-capability
/// bridge. No daemon RPC or listener is added by this tool surface.
fn manager_tool_schemas() -> Vec<Value> {
    let mut list = vec![json!({"name":"list_projects","description":"List registered projects, folders, descriptions and routing tags. No disk scanning.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}})];
    for (name, key, description) in [
        ("read_blob", "blob", "Read a bot's identity, instructions, role, tags, look, model, effort, permission and lock. Environment values and credentials are excluded."),
        ("read_project", "project", "Read one registered project's folder, description and routing tags."),
        ("read_conversation", "conversation", "Read a conversation's status and last 30 messages (each clipped to 4000 characters)."),
        ("get_conversation_permission", "conversation", "Read the bot's permission and any effective conversation pin; permissions belong to the bot."),
        ("open_conversation", "conversation", "Propose opening an existing conversation in Bitbots. The owner approves before selection changes."),
    ] {
        list.push(json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":{key:{"type":"string","description":"An exact id or name (conversation requires an id)."}},"required":[key],"additionalProperties":false}}));
    }
    let mut fields = json!({
        "blob":{"type":"string","description":"Exact bot id or name."},
        "name":{"type":"string","maxLength":40}, "description":{"type":"string","maxLength":255},
        "role":{"type":"string","maxLength":40}, "instructions":{"type":"string","maxLength":4000},
        "look":{"type":["object","null"],"description":"Bot look: shape, optional seed, traits, optional art (robot, blob, painted), optional paint (classic, cube, star, flower, pear, peanut, ghost, bunny, kitty, ufo, boxbot, tile), optional icon (logo, logo-tint, logo-mono, char-albert-einstein, char-nikola-tesla, char-cleopatra, char-superman, char-sherlock-holmes, char-robin-hood, char-thor, char-hulk, char-marie-curie, char-joan-of-arc, char-amelia-earhart, char-sun-wukong, char-frida-kahlo, char-captain-marvel, char-ada-lovelace, char-ludwig-van-beethoven, char-charlie-chaplin, char-william-shakespeare, char-queen-elizabeth-i, char-master-chief, char-sonic, char-anubis, char-wolfgang-amadeus-mozart, char-arthur-morgan, char-count-dracula, char-hua-mulan, char-gandalf, char-benjamin-franklin, char-kratos) and bot outline/colors, as returned by read_blob. Haze look: the bot's mark. logo, logo-tint and logo-mono show the runtime's logo in its own colours, the bot colour or one colour; char-* selects one of the Haze character portraits in its original colours."},
        "model":{"type":["string","null"]}, "thinking":{"type":["string","null"],"description":"Effort id, or null for model default."},
        "approvalMode":{"type":"string","enum":["ask","auto"]},
        "tags":{"type":"array","maxItems":8,"items":{"type":"string","minLength":1,"maxLength":24}}
    });
    list.push(json!({"name":"update_blob","description":"Update an existing bot by proposing a settings change for approval. Never Full access. Locked bots refuse every edit. Only listed fields can change; tags replace the current set.","inputSchema":{"type":"object","properties":fields,"required":["blob"],"additionalProperties":false}}));
    fields = json!({"project":{"type":"string"},"description":{"type":"string","maxLength":255},"tags":{"type":"array","maxItems":8,"items":{"type":"string","minLength":1,"maxLength":24}}});
    list.push(json!({"name":"update_project","description":"Propose changes to a project's description or tags. Nothing changes before owner approval.","inputSchema":{"type":"object","properties":fields,"required":["project"],"additionalProperties":false}}));
    let mut start = crate::proposals::tool_schemas().into_iter().find(|tool| tool["name"] == "assign_task").unwrap();
    start["name"] = json!("start_conversation");
    start["description"] = json!("Propose a new parallel side conversation with a bot. Supply brief, doneGoal, reportBack and a short topic yourself; the owner approves before work starts.");
    // Unlike assign_task, this tool always creates a new side conversation.
    start["inputSchema"]["properties"].as_object_mut().unwrap().remove("conversation");
    start["inputSchema"]["required"] = json!(["bot","brief","doneGoal","reportBack","topic"]);
    list.push(start);
    list
}

pub(crate) fn project_named(st: &AppState, wanted: &str) -> Result<Value, String> {
    let projects = st.db.project_list().map_err(|error| error.to_string())?;
    let wanted = wanted.trim();
    if let Some(project) = projects.iter().find(|p| p["id"].as_str() == Some(wanted)) { return Ok(project.clone()); }
    let matches = projects.into_iter().filter(|p| p["name"].as_str().is_some_and(|name| name.trim().eq_ignore_ascii_case(wanted))).collect::<Vec<_>>();
    match matches.as_slice() {
        [project] => Ok(project.clone()),
        [] => Err(format!("No project matches {wanted}. List projects and propose_project if needed.")),
        _ => Err("Several projects have that name. Ask the user with options, then use its id.".into()),
    }
}

pub(crate) fn blob_named(st: &AppState, wanted: &str) -> Result<Value, String> {
    let agents = st.db.agent_list(false, None).map_err(|error| error.to_string())?;
    resolve_blob(&agents, wanted).ok_or_else(|| format!("No bot matches {wanted}. List bots and propose_bot if none fits."))
}

pub(crate) fn readable_conversation(st: &AppState, wanted: &str) -> Result<Value, String> {
    let row = st.db.session_detail(wanted).map_err(|_| "That conversation is no longer available.".to_owned())?;
    if row["archived"] == true { return Err("That conversation is archived.".into()); }
    Ok(row)
}

fn selected_fields(value: &Value, keys: &[&str]) -> Value {
    let mut out = json!({});
    for key in keys { if let Some(value) = value.get(*key) { out[*key] = value.clone(); } }
    out
}

async fn manager_read(st: &AppState, name: &str, args: &Value) -> Result<String, String> {
    let (key, limit) = match name { "read_blob" => ("blob", 80), "read_project" => ("project", 200), _ => ("conversation", 80) };
    let wanted = bounded_text(args, key, limit)?.ok_or_else(|| format!("{key} is required."))?;
    let result = match name {
        "read_blob" => selected_fields(&blob_named(st, &wanted)?, &["id","name","description","role","instructions","look","color","model","thinking","runtimeId","projectId","tags","locked","approvalMode","effectiveApprovalMode","systemRole"]),
        "read_project" => selected_fields(&project_named(st, &wanted)?, &["id","name","path","description","tags"]),
        _ => {
            let row = readable_conversation(st, &wanted)?;
            let mut out = selected_fields(&row, &["id","agentId","title","state","projectPath","updatedAt"]);
            if name == "get_conversation_permission" {
                let agent = st.db.agent_get(row["agentId"].as_str().unwrap_or("")).map_err(|_| "That bot is no longer available.".to_owned())?;
                let options = crate::exec_options_for_session(st, &row).map_err(|error| error.1.message)?;
                out["botPermission"] = agent["effectiveApprovalMode"].clone();
                out["effectivePermission"] = json!(options.approval_mode.as_str());
                out["locked"] = json!(bot_is_locked(&agent));
            } else {
                let messages = row["messages"].as_array().cloned().unwrap_or_default();
                let start = messages.len().saturating_sub(30);
                out["messages"] = json!(messages[start..].iter().map(|message| json!({"role":message["role"],"content":message["content"].as_str().unwrap_or("").chars().take(4000).collect::<String>()})).collect::<Vec<_>>());
                out["earlierMessagesOmitted"] = json!(start);
            }
            out
        }
    };
    Ok(result.to_string())
}

/// A path key for comparing project folders across case and slash differences
/// (P7 audit F7). Windows treats `C:\X` and `c:/x/` as the same folder.
fn normalized_path(path: &str) -> String {
    path.trim().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn manager_conversations(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    let me = st.db.session_detail(session_id).ok().and_then(|row| row["agentId"].as_str().map(str::to_owned)).unwrap_or_default();
    let blob = bounded_text(args, "blob", 80)?.map(|wanted| blob_named(st, &wanted)).transpose()?;
    let project = bounded_text(args, "project", 200)?.map(|wanted| project_named(st, &wanted)).transpose()?;
    let agents = st.db.agent_list(true, None).map_err(|error| error.to_string())?;
    let name_of = |id: &str| agents.iter().find(|agent| agent["id"] == id).map(agent_name).unwrap_or_else(|| "A former teammate".into());
    let project_path = project.as_ref().and_then(|project| project["path"].as_str()).map(normalized_path);
    let sessions = st.db.session_list(false).map_err(|error| error.to_string())?;
    let rows = sessions.iter()
        .filter(|row| blob.as_ref().is_none_or(|blob| row["agentId"] == blob["id"]))
        .filter(|row| project_path.as_ref().is_none_or(|path| row["projectPath"].as_str().map(normalized_path).as_ref() == Some(path)))
        .take(100)
        .map(|row| {
            let link = &row["link"];
            let id = row["id"].as_str().unwrap_or("");
            let side = link["kind"] == "side";
            let started_by_you = side && !me.is_empty() && link["peerAgentId"].as_str() == Some(me.as_str());
            let peer = if started_by_you { row["agentId"].as_str().unwrap_or("") } else { link["peerAgentId"].as_str().unwrap_or("") };
            // The Manager's prompt relies on this line: who started it, the
            // topic, the peer and the latest reply (P7 audit F2).
            let mut out = selected_fields(row, &["id","agentId","title","state","projectPath","updatedAt"]);
            out["agentName"] = json!(row["agentId"].as_str().map(name_of));
            out["topic"] = link["topic"].clone();
            out["startedByYou"] = json!(started_by_you);
            out["peerName"] = if side { json!(name_of(peer)) } else { Value::Null };
            out["latestReply"] = json!(st.db.last_reply(id).ok().flatten().map(|reply| one_line(&reply, 300)));
            out
        })
        .collect::<Vec<_>>();
    Ok(json!({"conversations":rows}).to_string())
}

async fn manager_blobs(st: &AppState, session_id: &str, args: &Value) -> Result<String,String> {
    let project = bounded_text(args,"project",200)?.map(|name| project_named(st,&name)).transpose()?;
    let role = bounded_text(args,"role",40)?;
    let tag = bounded_text(args,"tag",24)?;
    if args.get("freeOnly").is_some_and(|value| !value.is_boolean()) { return Err("freeOnly must be a boolean.".into()); }
    let free = args["freeOnly"] == true;
    if free && project.is_some() { return Err("Choose a project or freeOnly, not both.".into()); }
    if project.is_none() && role.is_none() && tag.is_none() && !free { return list_blobs(st,session_id).await; }
    let agents = st.db.agent_list(false,None).map_err(|error| error.to_string())?;
    let sessions = st.db.session_list(false).map_err(|error| error.to_string())?;
    let bots = agents.iter().filter(|bot| bot["hidden"] != true)
        // P7 audit F7: the Manager must not be offered as its own delegate
        // (even when it carries a matching tag); validate_task_target refuses it
        // later, but with a confusing message.
        .filter(|bot| bot["systemRole"].as_str() != Some("manager"))
        .filter(|bot| !free || bot["projectId"].is_null())
        .filter(|bot| project.as_ref().is_none_or(|project| bot["projectId"] == project["id"]))
        .filter(|bot| role.as_ref().is_none_or(|role| bot["role"].as_str().is_some_and(|actual| actual.eq_ignore_ascii_case(role))))
        .filter(|bot| tag.as_ref().is_none_or(|tag| bot["tags"].as_array().is_some_and(|tags| tags.iter().any(|actual| actual.as_str().is_some_and(|actual| actual.eq_ignore_ascii_case(tag))))))
        .map(|bot| { let mut out = selected_fields(bot,&["id","name","role","description","tags","projectId","locked"]); out["busy"] = json!(sessions.iter().any(|session| session["agentId"] == bot["id"] && matches!(session["state"].as_str(),Some("starting"|"working"|"waiting_permission")))); out }).collect::<Vec<_>>();
    Ok(json!({"bots":bots,"ifNone":"Propose a suitable bot for the resolved project, or a free bot when no project was named. Ask the user with options if the project is unclear."}).to_string())
}
