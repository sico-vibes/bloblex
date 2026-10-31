//! Phase 4: `.bitbots.json`, a project's settings file committed to the repository.
//!
//! A repository is someone else's input, so the file **does nothing until the owner trusts that exact
//! content**: the SHA-256 of the bytes is kept in the project's `overrides.trustedSharedHash` (which
//! never travels in a backup and never reaches a device, like the rest of the overrides), and a file
//! whose hash no longer matches counts as untrusted, so a `git pull` cannot change what runs.
//!
//! The file is read from the project's own folder, never a conversation's copy; it must be a regular
//! file, not a link, of at most 64 KiB. A bad field is dropped and named in `problems` while the rest
//! stands, and **`approvalMode: "bypass"` is refused**: a repository file can never turn on Full
//! access. Nothing here commits, and no file content is ever logged.
//!
//! `effective_overrides` is the one place `setupScript` and `approvalMode` are resolved: the project's
//! own override wins, field by field, and then a trusted file.

use crate::{agent_error, derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// The file's name, in the project folder's root.
const NAME: &str = ".bitbots.json";
/// The largest file that is read at all.
const MAX_BYTES: u64 = 64 * 1024;
/// The one version this code reads.
const VERSION: u64 = 1;
/// The longest `setupScript` a repository file may carry, as in `validate_project_overrides`.
const MAX_SCRIPT_CHARS: usize = 4_000;
/// The longest `defaultBot` name.
const MAX_BOT_NAME_CHARS: usize = 80;
/// The modes a file may set. Full access is never one of them.
const MODES: [&str; 3] = ["ask", "auto", "accept_edits"];

/// One read of a project's file, and everything the reply needs from it.
#[derive(Clone, Default)]
struct File {
    found: bool,
    valid: bool,
    problems: Vec<String>,
    setup_script: Option<String>,
    approval_mode: Option<String>,
    default_bot: Option<String>,
    /// The SHA-256 of the bytes, lower-case hex.
    hash: Option<String>,
}

impl File {
    /// The owner trusted exactly this content, and it is usable.
    fn trusted(&self, project: &Value) -> bool {
        self.valid && self.hash.is_some() && project["overrides"]["trustedSharedHash"].as_str() == self.hash.as_deref()
    }
    fn state(&self, project: &Value) -> &'static str {
        if !self.found {
            "none"
        } else if !self.valid {
            "invalid"
        } else if self.trusted(project) {
            "trusted"
        } else {
            "untrusted"
        }
    }
    fn settings(&self) -> Value {
        if !self.valid { return Value::Null; }
        json!({"setupScript": self.setup_script, "approvalMode": self.approval_mode, "defaultBot": self.default_bot})
    }
}

/// One cached read: the file's size and modification time are the key, so a list of many projects
/// costs one stat each and no parse.
struct Cached {
    modified: Option<SystemTime>,
    len: u64,
    file: File,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Cached>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<PathBuf, Cached>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn invalid(problem: &str) -> File {
    File { found: true, valid: false, problems: vec![problem.to_owned()], ..File::default() }
}

/// The file in a project's own folder, from the cache when its size and modification time are
/// unchanged. A folder with no file is `found: false` and costs one failed stat.
fn read(folder: &Path) -> File {
    let path = folder.join(NAME);
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        if let Ok(mut cache) = cache().lock() { cache.remove(&path); }
        return File::default();
    };
    let (modified, len) = (meta.modified().ok(), meta.len());
    if let Ok(cache) = cache().lock() {
        if let Some(hit) = cache.get(&path) {
            if hit.len == len && hit.modified == modified { return hit.file.clone(); }
        }
    }
    let file = if meta.file_type().is_symlink() || !meta.is_file() {
        invalid("The file is a link or a folder, so it was not read.")
    } else if len > MAX_BYTES {
        invalid("The file is larger than 64 KB, so it was not read.")
    } else {
        match std::fs::read(&path) {
            Ok(bytes) => parse(&bytes),
            Err(_) => invalid("The file could not be read."),
        }
    };
    if let Ok(mut cache) = cache().lock() { cache.insert(path, Cached { modified, len, file: file.clone() }); }
    file
}

/// The project's own folder, or `None` when it has none that exists.
fn folder_of(project: &Value) -> Option<PathBuf> {
    let folder = PathBuf::from(project["path"].as_str().filter(|path| !path.trim().is_empty())?);
    folder.is_dir().then_some(folder)
}

fn read_of(project: &Value) -> File {
    folder_of(project).map(|folder| read(&folder)).unwrap_or_default()
}

/// The file's bytes, parsed: `valid` means it is JSON with a supported `version`. A bad field is
/// dropped and named while the rest stands; an unknown key is named and ignored.
fn parse(bytes: &[u8]) -> File {
    let Ok(text) = std::str::from_utf8(bytes) else { return invalid("The file isn't valid text.") };
    let Ok(value) = serde_json::from_str::<Value>(text) else { return invalid("The file isn't valid JSON.") };
    let Some(map) = value.as_object() else { return invalid("The file isn't a JSON object.") };
    // A file from before this version holds only `instructions`, with no version: that's version 1.
    if map.get("version").is_some_and(|version| version.as_u64() != Some(VERSION)) { return invalid("The file's version isn't 1, so it was not read."); }
    let mut file = File { found: true, valid: true, hash: Some(hex(&Sha256::digest(bytes))), ..File::default() };
    for (key, value) in map {
        match key.as_str() {
            // `instructions` is read elsewhere, for the bots (Phase 1A), and needs no trust to be named here.
            "version" | "instructions" => {}
            "setupScript" => match value.as_str() {
                Some(script) if script.chars().count() <= MAX_SCRIPT_CHARS && !script.contains('\0') => {
                    if !script.trim().is_empty() { file.setup_script = Some(script.to_owned()); }
                }
                Some(_) => file.problems.push("`setupScript` is longer than 4000 characters, so it was left out.".to_owned()),
                None => file.problems.push("`setupScript` must be text, so it was left out.".to_owned()),
            },
            "approvalMode" => match value.as_str() {
                Some("bypass") => file.problems.push("A repository file can't turn on Full access.".to_owned()),
                Some(mode) if MODES.contains(&mode) => file.approval_mode = Some(mode.to_owned()),
                Some(_) => file.problems.push("`approvalMode` must be ask, auto or accept_edits, so it was left out.".to_owned()),
                None => file.problems.push("`approvalMode` must be text, so it was left out.".to_owned()),
            },
            "defaultBot" => match value.as_str() {
                Some(name) if !name.trim().is_empty() && name.chars().count() <= MAX_BOT_NAME_CHARS && !name.contains('\0') => file.default_bot = Some(name.trim().to_owned()),
                Some(_) => file.problems.push("`defaultBot` must be a name of 1 to 80 characters, so it was left out.".to_owned()),
                None => file.problems.push("`defaultBot` must be text, so it was left out.".to_owned()),
            },
            other => file.problems.push(format!("`{other}` isn't a field this file reads, so it was ignored.")),
        }
    }
    file
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// **The one place a project's setup script and approval mode are resolved.** The project's own
/// override wins, field by field; then a trusted file. A file whose hash no longer matches is
/// untrusted, so a `git pull` cannot change what runs.
pub(crate) fn effective_overrides(_st: &AppState, project: &Value) -> Value {
    let mut overrides = project["overrides"].clone();
    if !overrides["setupScript"].is_null() && !overrides["approvalMode"].is_null() { return overrides; }
    let file = read_of(project);
    if !file.trusted(project) { return overrides; }
    if overrides["setupScript"].is_null() {
        if let Some(script) = file.setup_script { overrides["setupScript"] = json!(script); }
    }
    if overrides["approvalMode"].is_null() {
        if let Some(mode) = file.approval_mode { overrides["approvalMode"] = json!(mode); }
    }
    overrides
}

/// `project.list` rows gain the file's state and, from a trusted file, the bot it names. `agents` is
/// the bot list the caller already loaded, so this adds one stat per project and no query.
pub(crate) fn annotate(project: &mut Value, agents: &[Value]) {
    let file = read_of(project);
    let trusted = file.trusted(project);
    project["sharedSettings"] = json!(file.state(project));
    project["defaultBot"] = match file.default_bot.filter(|_| trusted) {
        Some(name) => {
            let agent = agents.iter().find(|agent| agent["name"].as_str() == Some(name.as_str())).map(|agent| agent["id"].clone()).unwrap_or(Value::Null);
            json!({"name": name, "agentId": agent})
        }
        None => Value::Null,
    };
}

/// `projectApprovalMode` on a session row comes from SQL, so a trusted file's mode is put on the row
/// here, once per call: nothing runs when no project trusts a file. (Events are not patched; a window
/// that replaces a row from `session.changed` keeps the SQL value until it reloads.)
pub(crate) fn effective_session_modes(st: &AppState, rows: &mut [Value]) {
    let Ok(projects) = st.db.project_list() else { return };
    let trusted = projects.iter().filter(|project| project["overrides"]["trustedSharedHash"].is_string())
        .map(|project| (project["id"].as_str().unwrap_or("").to_owned(), effective_overrides(st, project)["approvalMode"].as_str().map(str::to_owned)))
        .collect::<Vec<_>>();
    if trusted.is_empty() { return; }
    for row in rows.iter_mut() {
        let Some(id) = row["projectId"].as_str() else { continue };
        if let Some((_, mode)) = trusted.iter().find(|(project, _)| project == id) { row["projectApprovalMode"] = json!(mode); }
    }
}

/// `project.changed` events carry the row, and the window replaces its copy with it, so the file's
/// state goes on the event too.
pub(crate) fn annotate_events(events: &mut [Value], agents: &[Value]) {
    for event in events.iter_mut() {
        if let Some(project) = event.get_mut("payload").and_then(|payload| payload.get_mut("project")) { annotate(project, agents); }
    }
}

fn invalid_argument(message: &str) -> DispatchError { derr("invalid_argument", message, StatusCode::BAD_REQUEST) }

fn conflict(message: &str) -> DispatchError { derr("conflict", message, StatusCode::CONFLICT) }

/// The project a call names, or `not_found`.
fn project_of(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = p["projectId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid_argument("projectId is required"))?;
    st.db.project_get(id).map_err(agent_error)
}

/// The reply of `.get`, `.trust` and `.untrust`.
fn reply(project: &Value) -> Value {
    let file = read_of(project);
    let trusted = file.trusted(project);
    json!({
        "found": file.found,
        "valid": file.valid,
        "problems": file.problems,
        "settings": file.settings(),
        "hash": file.hash,
        "trusted": trusted,
        "state": file.state(project),
    })
}

/// Write the project's overrides with (or without) the trusted hash, and broadcast the change. Trust
/// is not part of `project.update`: this is the only path that sets it.
fn set_trust(st: &AppState, project: &Value, hash: Option<&str>) -> Result<Value, DispatchError> {
    let id = project["id"].as_str().unwrap_or("");
    let (project, events) = st.db.project_set_trusted_shared_hash(id, hash).map_err(agent_error)?;
    st.broadcast_persisted(events);
    Ok(reply(&project))
}

pub(crate) fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "project.sharedSettings.get" => Ok(reply(&project_of(st, p)?)),
        "project.sharedSettings.trust" => {
            let project = project_of(st, p)?;
            if p["confirm"] != true { return Err(invalid_argument("Confirm this file first.")); }
            let hash = p["hash"].as_str().map(str::trim).filter(|hash| !hash.is_empty()).ok_or_else(|| invalid_argument("hash is required"))?;
            let file = read_of(&project);
            if file.hash.as_deref() != Some(hash) { return Err(conflict("That file has changed. Check it again.")); }
            set_trust(st, &project, Some(hash))
        }
        "project.sharedSettings.untrust" => {
            let project = project_of(st, p)?;
            set_trust(st, &project, None)
        }
        "project.sharedSettings.write" => write(st, p),
        _ => Err(derr("not_found", "unknown shared settings method", StatusCode::NOT_FOUND)),
    }
}

/// Create the temporary file new, never following something already at that path. A repository could
/// plant a link there; removing it removes the link itself, not what it points at, and the second try
/// then creates a real file.
fn create_new(path: &Path) -> std::io::Result<std::fs::File> {
    match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = std::fs::remove_file(path);
            std::fs::OpenOptions::new().write(true).create_new(true).open(path)
        }
        Err(error) => Err(error),
    }
}

/// Write the project's own `setupScript` and `approvalMode` overrides, and the bot the file already
/// names, into `.bitbots.json`. Full access is left out, nothing is committed, and the new content is
/// trusted at once because the owner asked for it.
fn write(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let project = project_of(st, p)?;
    if p["confirm"] != true { return Err(invalid_argument("Confirm writing this file first.")); }
    let folder = folder_of(&project).ok_or_else(|| invalid_argument("This project has no folder."))?;
    let target = folder.join(NAME);
    if std::fs::symlink_metadata(&target).is_ok() && p["replace"] != true { return Err(conflict("That file already exists. Replace it?")); }
    let overrides = &project["overrides"];
    // Everything else already in the file stays, such as the `instructions` the bots read.
    let mut out = std::fs::read(&target).ok().filter(|_| !std::fs::symlink_metadata(&target).is_ok_and(|meta| meta.file_type().is_symlink()))
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    out.insert("version".to_owned(), json!(VERSION));
    out.remove("setupScript");
    out.remove("approvalMode");
    if let Some(script) = overrides["setupScript"].as_str() { out.insert("setupScript".to_owned(), json!(script)); }
    if let Some(mode) = overrides["approvalMode"].as_str().filter(|mode| MODES.contains(mode)) { out.insert("approvalMode".to_owned(), json!(mode)); }
    // The bot the file names now, so writing never loses it; it is inert until trusted, and the new
    // content is trusted below.
    let current = read_of(&project);
    if current.valid {
        if let Some(name) = current.default_bot { out.insert("defaultBot".to_owned(), json!(name)); }
    }
    let text = format!("{}\n", serde_json::to_string_pretty(&Value::Object(out)).map_err(|_| invalid_argument("The file could not be written."))?);
    // Write beside it and rename, so a failure never leaves half a file. The temporary file is created
    // new: a repository could plant a link there, and a plain write would follow it out of the folder.
    let temporary = folder.join(format!("{NAME}.tmp"));
    let mut file = create_new(&temporary).map_err(|_| invalid_argument("The file could not be written."))?;
    if std::io::Write::write_all(&mut file, text.as_bytes()).is_err() {
        drop(file);
        let _ = std::fs::remove_file(&temporary);
        return Err(invalid_argument("The file could not be written."));
    }
    drop(file);
    if std::fs::rename(&temporary, &target).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err(invalid_argument("The file could not be written."));
    }
    // The cache is keyed by size and time; a same-size rewrite within the same tick would be stale.
    if let Ok(mut cache) = cache().lock() { cache.remove(&target); }
    let hash = read(&folder).hash;
    set_trust(st, &project, hash.as_deref())
}
