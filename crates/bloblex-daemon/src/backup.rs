//! FIX31: back up and restore bots, memory, skills, automations and settings.
//!
//! A backup is one `.bitbots-backup.json` document: an envelope
//! (`format`/`version`/`createdAt`/`app`) around a canonical `contents` object
//! and a SHA-256 checksum over `serde_json::to_vec(&contents)`. `serde_json`
//! maps are sorted in this build (no `preserve_order`), so that serialisation
//! is canonical and the checksum is stable across a save/load round trip.
//!
//! What is deliberately left out: projects (restored bots land Unassigned),
//! conversations, and every sign-in, token or cloud-dictation consent value.
//! The settings allowlist below is the only way a setting can travel.
//!
//! `backup.preview` validates the document, maps each bot's provider to a local
//! runtime and holds the parsed document for `backup.import`. Import applies
//! the user's rename/replace/skip choices, resolves memory scopes, stages any
//! skills on disk and restores everything else in one database transaction.

use crate::{agent_error, derr, AppState, DispatchError};
use axum::http::StatusCode;
use base64::Engine as _;
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::Mutex as StdMutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

/// The document's `format` marker.
pub const FORMAT: &str = "bitbots.backup";
/// The newest document version this build writes and reads.
pub const VERSION: u64 = 1;
/// How long a preview stays importable.
const PREVIEW_TTL: Duration = Duration::from_secs(600);
/// At most this many previews are held at once.
const PREVIEW_LIMIT: usize = 2;
/// Largest single skill file a backup may carry.
const MAX_SKILL_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Largest total skill payload a backup may carry.
const MAX_SKILL_TOTAL_BYTES: u64 = 50 * 1024 * 1024;

/// The exact settings keys a backup may carry. `experimental.*` boolean flags
/// are allowed in addition to this list (see `exportable_setting`).
const SETTING_ALLOWLIST: [&str; 33] = [
    "appearance.style",
    "appearance.accent",
    "appearance.density",
    "appearance.wallpaper",
    "appearance.glass",
    "appearance.font",
    "appearance.monoFont",
    "appearance.theme",
    "appearance.textSize",
    "companion.focusMode",
    "companion.soundsEnabled",
    "companion.soundVolume",
    "companion.openAtStartup",
    "companion.hotkey",
    "companion.chatSize",
    "companion.startPosition",
    "companion.pinnedBlobs",
    "notifications.enabled",
    "permissions.default_mode",
    "profile.name",
    "profile.about",
    "speech.enabled",
    "speech.engine",
    "speech.model",
    "memory.sharedAgentWrites",
    "retry.maxWaitSecs",
    "questions.expirySecs",
    "automations.maxConcurrent",
    "task.concurrency.max",
    "task.globalPaused",
    "claude.enableWorkflows",
    "conversations.autoTitle",
    "skills.enabled",
];

/// Previews awaiting `backup.import`. At most `PREVIEW_LIMIT`, each ten
/// minutes; the oldest is dropped first.
#[derive(Default)]
pub struct BackupPreviews {
    entries: StdMutex<Vec<PreviewEntry>>,
}

struct PreviewEntry {
    id: String,
    created: Instant,
    document: Value,
}

impl BackupPreviews {
    fn prune(entries: &mut Vec<PreviewEntry>) {
        entries.retain(|entry| entry.created.elapsed() < PREVIEW_TTL);
    }
    /// Stores a parsed document and returns its one-use id.
    pub fn store(&self, document: Value) -> String {
        let id = Uuid::new_v4().to_string();
        if let Ok(mut entries) = self.entries.lock() {
            Self::prune(&mut entries);
            while entries.len() >= PREVIEW_LIMIT && !entries.is_empty() {
                let oldest = entries
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, entry)| entry.created)
                    .map(|(index, _)| index)
                    .unwrap_or(0);
                entries.remove(oldest);
            }
            entries.push(PreviewEntry { id: id.clone(), created: Instant::now(), document });
        }
        id
    }
    /// Removes and returns the document for an id, honouring the TTL. `None`
    /// for an unknown or expired id: the caller returns `not_found`.
    pub fn take(&self, id: &str) -> Option<Value> {
        let mut entries = self.entries.lock().ok()?;
        Self::prune(&mut entries);
        let index = entries.iter().position(|entry| entry.id == id)?;
        Some(entries.remove(index).document)
    }
    /// Test-only: push every stored preview past its TTL.
    #[cfg(test)]
    pub fn expire_all(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            let expired = Instant::now().checked_sub(PREVIEW_TTL + Duration::from_secs(1)).unwrap_or_else(Instant::now);
            for entry in entries.iter_mut() {
                entry.created = expired;
            }
        }
    }
}

fn internal(message: &str) -> DispatchError {
    derr("internal", message, StatusCode::INTERNAL_SERVER_ERROR)
}

/// Whether a settings key may be exported. A forbidden key is always refused;
/// `experimental.*` is allowed only as a boolean; everything else must be on
/// the explicit allowlist.
fn exportable_setting(key: &str, value: &Value) -> bool {
    let lower = key.to_ascii_lowercase();
    if lower.starts_with("exec_gate.")
        || lower.starts_with("internal.")
        || lower.starts_with("migration.")
        || lower.starts_with("remote.")
        || lower.starts_with("speech.cloud.consent")
        || lower == "companion.positions"
    {
        return false;
    }
    // `hotkey` is allowed by name even though it contains "key".
    if lower != "companion.hotkey" && ["token", "secret", "password", "auth", "cookie", "key"].iter().any(|needle| lower.contains(needle)) {
        return false;
    }
    if key.starts_with("experimental.") {
        return value.is_boolean();
    }
    SETTING_ALLOWLIST.contains(&key)
}

fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

fn memory_has_secret(record: &Value) -> bool {
    bloblex_security::contains_secret_marker(record["title"].as_str().unwrap_or(""))
        || bloblex_security::contains_secret_marker(record["body"].as_str().unwrap_or(""))
}

/// The first usable installed runtime for a provider: one whose status is not
/// `error`. `None` means the provider cannot be restored on this machine.
fn first_runtime_for(runtimes: &[Value], provider: &str) -> Option<String> {
    runtimes
        .iter()
        .find(|runtime| runtime["provider"].as_str() == Some(provider) && runtime["status"].as_str() != Some("error"))
        .and_then(|runtime| runtime["id"].as_str())
        .map(str::to_owned)
}

// ---------------------------------------------------------------------------
// Export

/// One agent read, stripped to what a backup carries: no id, no runtime id, no
/// project, no custom arguments, and environment values dropped to their keys.
fn export_bot(agent: &Value, runtimes: &[Value]) -> Value {
    let runtime_id = agent["runtimeId"].as_str().unwrap_or("");
    let runtime = runtimes.iter().find(|runtime| runtime["id"].as_str() == Some(runtime_id));
    let env_keys = agent["customEnv"]
        .as_object()
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    json!({
        "exportId": agent["id"],
        "provider": runtime.and_then(|runtime| runtime["provider"].as_str()).unwrap_or(""),
        "runtimeHint": runtime.and_then(|runtime| runtime["version"].as_str()).map(|version| json!(version)).unwrap_or(Value::Null),
        "name": agent["name"],
        "description": agent["description"],
        "instructions": agent["instructions"],
        "color": agent["color"],
        "outfit": agent["outfit"],
        "look": agent["look"],
        "role": agent["role"],
        "model": agent["model"],
        "thinking": agent["thinking"],
        "serviceTier": agent["serviceTier"],
        "approvalMode": agent["approvalMode"],
        "notificationLevel": agent["notificationLevel"],
        "leader": agent["leader"],
        "hidden": agent["hidden"],
        "maxConcurrency": agent["maxConcurrency"],
        "customEnvKeys": env_keys,
    })
}

/// One memory record. Bot-scope notes name the bot; project-scope notes carry
/// the project name so another machine can match it.
fn export_memory(record: &Value, projects: &[Value]) -> Value {
    let mut out = json!({
        "id": record["id"],
        "scope": record["scope"],
        "kind": record["kind"],
        "title": record["title"],
        "body": record["body"],
        "tags": record["tags"],
        "importance": record["importance"],
        "pinned": record["pinned"],
        "origin": record["origin"],
        "reviewed": record["reviewed"],
        "createdAt": record["createdAt"],
        "updatedAt": record["updatedAt"],
    });
    match record["scope"].as_str() {
        Some("blob") => out["scopeId"] = record["scopeId"].clone(),
        Some("project") => {
            let id = record["scopeId"].as_str().unwrap_or("");
            let name = projects.iter().find(|project| project["id"].as_str() == Some(id)).and_then(|project| project["name"].as_str());
            out["projectId"] = record["scopeId"].clone();
            out["projectName"] = name.map(|name| json!(name)).unwrap_or(Value::Null);
        }
        _ => {}
    }
    out
}

fn export_automations(st: &AppState) -> Result<Vec<Value>, DispatchError> {
    let automations = st.db.automation_list(None).map_err(agent_error)?;
    Ok(automations
        .iter()
        .map(|automation| {
            json!({
                "agentId": automation["agentId"],
                "name": automation["name"],
                "prompt": automation["prompt"],
                "schedule": automation["schedule"],
                "sessionMode": automation["sessionMode"],
                "approvalMode": automation["approvalMode"],
                "maxRuntimeSecs": automation["maxRuntimeSecs"],
            })
        })
        .collect())
}

fn export_settings(st: &AppState) -> Result<Value, DispatchError> {
    let settings = st.db.settings().map_err(internal_agent_error)?;
    let mut out = Map::new();
    if let Some(object) = settings.as_object() {
        let mut keys = object.keys().collect::<Vec<_>>();
        keys.sort();
        for key in keys {
            if exportable_setting(key, &object[key]) {
                out.insert(key.clone(), object[key].clone());
            }
        }
    }
    Ok(Value::Object(out))
}

fn export_skills(st: &AppState) -> Result<Vec<Value>, DispatchError> {
    let rows = st.db.skills_list().map_err(agent_error)?;
    let mut total = 0u64;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let name = row["name"].as_str().unwrap_or("").to_owned();
        let files = crate::skills::read_files(st, &name).map_err(|message| internal(&message))?;
        let mut items = Vec::with_capacity(files.len());
        for (path, bytes) in files {
            let size = bytes.len() as u64;
            if size > MAX_SKILL_FILE_BYTES {
                return Err(derr("invalid_argument", &format!("The skill \"{name}\" has a file larger than 5 MB, so it cannot be exported."), StatusCode::BAD_REQUEST));
            }
            total += size;
            if total > MAX_SKILL_TOTAL_BYTES {
                return Err(derr("invalid_argument", "The skills are larger than 50 MB in total, so they cannot be exported.", StatusCode::BAD_REQUEST));
            }
            items.push(json!({"path": path, "sha256": bloblex_adapter_acp::sha256_hex(&bytes), "base64": base64_encode(&bytes)}));
        }
        out.push(json!({"name": name, "description": row["description"], "files": items}));
    }
    Ok(out)
}

fn build_document(contents: Value) -> Result<Value, DispatchError> {
    let canonical = serde_json::to_vec(&contents).map_err(|_| internal("The backup could not be serialised."))?;
    Ok(json!({
        "format": FORMAT,
        "version": VERSION,
        "createdAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "app": {"version": env!("CARGO_PKG_VERSION")},
        "contents": contents,
        "checksum": {"alg": "sha256", "value": bloblex_adapter_acp::sha256_hex(&canonical)},
    }))
}

async fn export(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let include = p.get("include");
    let wants = |name: &str| include.and_then(|include| include.get(name)).and_then(Value::as_bool).unwrap_or(true);
    let runtimes = st.runtimes.read().await.clone();
    let agents = st.db.agent_list(false, None).map_err(agent_error)?;
    let bots = agents.iter().map(|agent| export_bot(agent, &runtimes)).collect::<Vec<_>>();
    let projects = st.db.project_list().map_err(agent_error)?;
    let memory = if wants("memory") {
        st.db
            .memory_all_live()
            .map_err(agent_error)?
            .iter()
            .filter(|record| !memory_has_secret(record))
            .map(|record| export_memory(record, &projects))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let skills = if wants("skills") { export_skills(st)? } else { Vec::new() };
    let automations = if wants("automations") { export_automations(st)? } else { Vec::new() };
    let settings = if wants("settings") { export_settings(st)? } else { json!({}) };
    let stats = json!({
        "bots": bots.len(),
        "memory": memory.len(),
        "skills": skills.len(),
        "automations": automations.len(),
        "settings": settings.as_object().map(|object| object.len()).unwrap_or(0),
    });
    let contents = json!({
        "bots": bots,
        "memory": memory,
        "skills": skills,
        "automations": automations,
        "settings": settings,
    });
    Ok(json!({"document": build_document(contents)?, "stats": stats}))
}

// ---------------------------------------------------------------------------
// Document validation

/// Validates the envelope and checksum and returns the contents. A newer
/// version is `unsupported`; a damaged or edited file is `invalid_argument`.
fn check_document(document: &Value) -> Result<Value, DispatchError> {
    if document["format"].as_str() != Some(FORMAT) {
        return Err(derr("invalid_argument", "This is not a Bitbots backup file.", StatusCode::BAD_REQUEST));
    }
    let Some(version) = document["version"].as_u64() else {
        return Err(derr("invalid_argument", "The backup file has no version.", StatusCode::BAD_REQUEST));
    };
    if version > VERSION {
        return Err(derr("unsupported", "This backup was made by a newer version of Bitbots.", StatusCode::BAD_REQUEST));
    }
    let contents = document.get("contents").cloned().ok_or_else(|| derr("invalid_argument", "The backup file has no contents.", StatusCode::BAD_REQUEST))?;
    let expected = document["checksum"]["value"].as_str().unwrap_or("");
    let canonical = serde_json::to_vec(&contents).map_err(|_| internal("The backup could not be read."))?;
    if expected.is_empty() || bloblex_adapter_acp::sha256_hex(&canonical) != expected {
        return Err(derr("invalid_argument", "The backup file is damaged or was edited.", StatusCode::BAD_REQUEST));
    }
    if !contents.is_object() {
        return Err(derr("invalid_argument", "The backup file has no contents.", StatusCode::BAD_REQUEST));
    }
    Ok(contents)
}

// ---------------------------------------------------------------------------
// Preview

/// The pool's `content_sha256` for an incoming skill, computed the same way as
/// `skills::files_sha256`, so a same-name skill can be compared to the pool.
fn document_skill_sha256(skill: &Value) -> String {
    let empty = Vec::new();
    let mut files = Vec::new();
    for item in skill["files"].as_array().unwrap_or(&empty) {
        let path = item["path"].as_str().unwrap_or("").to_owned();
        let bytes = item["base64"].as_str().and_then(base64_decode).unwrap_or_default();
        files.push((path, bytes));
    }
    crate::skills::files_sha256(&files)
}

fn memory_is_identical(existing: &Value, incoming: &Value, scope_id: Option<&str>) -> bool {
    existing["scope"].as_str() == incoming["scope"].as_str()
        && existing["scopeId"].as_str() == scope_id
        && existing["kind"].as_str() == incoming["kind"].as_str()
        && existing["title"].as_str() == incoming["title"].as_str()
        && existing["body"].as_str() == incoming["body"].as_str()
        && serde_json::to_string(&existing["tags"]).is_ok_and(|tags| serde_json::to_string(&incoming["tags"]).is_ok_and(|other| tags == other))
        && existing["importance"].as_i64() == incoming["importance"].as_i64()
        && existing["pinned"].as_bool() == incoming["pinned"].as_bool()
        && existing["origin"].as_str() == incoming["origin"].as_str()
        && existing["reviewed"].as_bool() == incoming["reviewed"].as_bool()
}

/// Resolve an incoming project-scope note to a local project: the same id
/// first, then the same name (case-insensitive).
fn resolve_project(projects: &[Value], incoming: &Value) -> Option<String> {
    if let Some(id) = incoming["projectId"].as_str() {
        if let Some(project) = projects.iter().find(|project| project["id"].as_str() == Some(id)) {
            return project["id"].as_str().map(str::to_owned);
        }
    }
    let name = incoming["projectName"].as_str()?.trim().to_lowercase();
    if name.is_empty() {
        return None;
    }
    projects
        .iter()
        .find(|project| project["name"].as_str().map(str::to_lowercase) == Some(name.clone()))
        .and_then(|project| project["id"].as_str())
        .map(str::to_owned)
}

async fn preview(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let document = p.get("document").cloned().unwrap_or(Value::Null);
    let contents = check_document(&document)?;
    let runtimes = st.runtimes.read().await.clone();
    let agents = st.db.agent_list(false, None).map_err(agent_error)?;
    let projects = st.db.project_list().map_err(agent_error)?;
    let settings = st.db.settings().map_err(internal_agent_error).unwrap_or(Value::Null);

    let empty = Vec::new();
    let bots = contents["bots"].as_array().unwrap_or(&empty);
    let memory = contents["memory"].as_array().unwrap_or(&empty);
    let skills = contents["skills"].as_array().unwrap_or(&empty);
    let automations = contents["automations"].as_array().unwrap_or(&empty);
    let incoming_settings = contents["settings"].as_object();

    // Bots: name conflicts and provider warnings.
    let mut bot_conflicts = Vec::new();
    for bot in bots {
        let name = bot["name"].as_str().unwrap_or("").trim();
        if let Some(existing) = agents.iter().find(|agent| agent["name"].as_str().map(str::to_lowercase) == Some(name.to_lowercase())) {
            bot_conflicts.push(json!({"exportId": bot["exportId"], "name": name, "existingAgentId": existing["id"]}));
        }
    }

    // Skills: same-name conflicts and whether the content already matches.
    let existing_skills = st.db.skills_list().map_err(agent_error)?;
    let registered = existing_skills.iter().map(|skill| (skill["name"].as_str().unwrap_or("").to_owned(), skill["contentSha256"].as_str().unwrap_or("").to_owned())).collect::<Vec<_>>();
    let mut skill_conflicts = Vec::new();
    for skill in skills {
        let name = skill["name"].as_str().unwrap_or("");
        if let Some((_, hash)) = registered.iter().find(|(existing, _)| existing == name) {
            let same = *hash == document_skill_sha256(skill);
            skill_conflicts.push(json!({"name": name, "same": same}));
        }
    }

    // Memory: ids that already exist locally, and whether they are identical.
    let mut memory_conflicts = Vec::new();
    for record in memory {
        let Some(id) = record["id"].as_str() else { continue };
        let Ok(existing) = st.db.memory_get(id) else { continue };
        let scope_id: Option<String> = match record["scope"].as_str() {
            Some("blob") => record["scopeId"].as_str().map(str::to_owned),
            Some("project") => resolve_project(&projects, record),
            _ => None,
        };
        memory_conflicts.push(json!({"id": id, "identical": memory_is_identical(&existing, record, scope_id.as_deref())}));
    }

    // Settings: allowlisted keys whose local value differs.
    let mut setting_conflicts = Vec::new();
    if let Some(incoming) = incoming_settings {
        for (key, value) in incoming {
            if !exportable_setting(key, value) {
                continue;
            }
            let current = settings.get(key).cloned().unwrap_or(Value::Null);
            if current != Value::Null && &current != value {
                setting_conflicts.push(json!({"key": key, "current": current, "incoming": value}));
            }
        }
    }

    // Warnings.
    let mut warnings = Vec::new();
    let mut skipped_bots = 0usize;
    let mut providers_without_runtime = Vec::new();
    let mut environment_keys = 0usize;
    for bot in bots {
        let provider = bot["provider"].as_str().unwrap_or("");
        if first_runtime_for(&runtimes, provider).is_none() {
            skipped_bots += 1;
            if !provider.is_empty() && !providers_without_runtime.contains(&provider.to_owned()) {
                providers_without_runtime.push(provider.to_owned());
            }
        }
        environment_keys += bot["customEnvKeys"].as_array().map(Vec::len).unwrap_or(0);
    }
    if skipped_bots > 0 {
        warnings.push(format!("{skipped_bots} bot(s) will be skipped: no installed runtime was found for {}", if providers_without_runtime.is_empty() { "their provider".to_owned() } else { providers_without_runtime.join(", ") }));
    }
    let incoming_leaders = bots.iter().filter(|bot| bot["leader"].as_bool() == Some(true)).count();
    let has_leader = st.db.leader_agent().map_err(agent_error)?.is_some();
    if incoming_leaders > 0 && (has_leader || incoming_leaders > 1) {
        warnings.push("This backup contains a leader, but a leader is already set; the restored bot will not lead.".into());
    }
    if bots.iter().any(|bot| bot["approvalMode"].as_str() == Some("bypass")) {
        warnings.push("A restored bot used bypass approvals; it will be restored as ask.".into());
    }
    if environment_keys > 0 {
        warnings.push(format!("{environment_keys} environment value(s) are dropped (only key names travel in a backup)."));
    }
    let mut project_notes = 0usize;
    for record in memory {
        if record["scope"].as_str() == Some("project") && resolve_project(&projects, record).is_none() {
            project_notes += 1;
        }
    }
    if project_notes > 0 {
        warnings.push(format!("{project_notes} project note(s) will be skipped: no matching local project."));
    }
    let ignored_settings = incoming_settings.map(|incoming| incoming.iter().filter(|(key, value)| !exportable_setting(key, value)).count()).unwrap_or(0);
    if ignored_settings > 0 {
        warnings.push(format!("{ignored_settings} setting(s) are outside the backup allowlist and will be ignored."));
    }

    let preview_id = st.backup_previews.store(document);
    Ok(json!({
        "previewId": preview_id,
        "counts": {"bots": bots.len(), "memory": memory.len(), "skills": skills.len(), "automations": automations.len(), "settings": incoming_settings.map(Map::len).unwrap_or(0)},
        "conflicts": {"bots": bot_conflicts, "skills": skill_conflicts, "memory": memory_conflicts, "settings": setting_conflicts},
        "warnings": warnings,
    }))
}

/// `agent_error` maps a storage error onto a dispatch error; settings failures
/// should read as internal rather than agent failures.
fn internal_agent_error(error: bloblex_storage::StorageError) -> DispatchError {
    internal(&error.to_string())
}

// ---------------------------------------------------------------------------
// Import

struct StagedSkill {
    name: String,
    description: String,
    sha256: String,
    file_count: i64,
    total_bytes: i64,
    staging: PathBuf,
}

/// Decode the files of one incoming skill, enforcing the size caps and the path
/// guard. Returns `None` when the skill cannot be restored.
fn decode_skill_files(skill: &Value) -> Option<Vec<(String, Vec<u8>)>> {
    let empty = Vec::new();
    let items = skill["files"].as_array().unwrap_or(&empty);
    let mut files = Vec::with_capacity(items.len());
    let mut total = 0u64;
    for item in items {
        let path = item["path"].as_str()?.to_owned();
        if !crate::skills::safe_relative(&path) {
            return None;
        }
        let bytes = base64_decode(item["base64"].as_str()?)?;
        if item["sha256"].as_str().is_some_and(|expected| expected != bloblex_adapter_acp::sha256_hex(&bytes)) {
            return None;
        }
        let size = bytes.len() as u64;
        if size > MAX_SKILL_FILE_BYTES {
            return None;
        }
        total += size;
        if total > MAX_SKILL_TOTAL_BYTES {
            return None;
        }
        files.push((path, bytes));
    }
    if files.is_empty() {
        return None;
    }
    Some(files)
}

async fn import(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let preview_id = p["previewId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "previewId is required", StatusCode::BAD_REQUEST))?;
    let document = st.backup_previews.take(preview_id).ok_or_else(|| derr("not_found", "That preview has expired. Choose the backup file again.", StatusCode::NOT_FOUND))?;
    let contents = check_document(&document)?;

    let resolutions = p.get("resolutions").cloned().unwrap_or(Value::Null);
    let bot_resolutions = resolutions["bots"].as_object();
    let skill_resolutions = resolutions["skills"].as_object();
    let default_resolution = match resolutions["default"].as_str() {
        Some("skip") => "skip",
        _ => "rename",
    };

    let runtimes = st.runtimes.read().await.clone();
    let agents = st.db.agent_list(false, None).map_err(agent_error)?;
    let projects = st.db.project_list().map_err(agent_error)?;
    let empty = Vec::new();
    let bots = contents["bots"].as_array().unwrap_or(&empty);

    // Bots.
    let mut plan_bots = Vec::new();
    let mut skipped_bots = 0u64;
    let mut skipped_bot_ids: HashSet<String> = HashSet::new();
    let mut leader_used = st.db.leader_agent().map_err(agent_error)?.is_some();
    for bot in bots {
        let export_id = bot["exportId"].as_str().unwrap_or("").to_owned();
        let provider = bot["provider"].as_str().unwrap_or("");
        let Some(runtime_id) = first_runtime_for(&runtimes, provider) else {
            skipped_bots += 1;
            skipped_bot_ids.insert(export_id);
            continue;
        };
        let name = bot["name"].as_str().unwrap_or("Bot").trim().to_owned();
        let existing = agents.iter().find(|agent| agent["name"].as_str().map(str::to_lowercase) == Some(name.to_lowercase()));
        let resolution = if existing.is_some() {
            bot_resolutions.and_then(|map| map.get(&export_id)).and_then(Value::as_str).unwrap_or(default_resolution)
        } else {
            "rename"
        };
        if resolution == "skip" {
            skipped_bots += 1;
            skipped_bot_ids.insert(export_id);
            continue;
        }
        let approval = match bot["approvalMode"].as_str() {
            Some("bypass") => json!("ask"),
            Some("auto") => json!("auto"),
            Some("ask") => json!("ask"),
            _ => Value::Null,
        };
        let leader = bot["leader"].as_bool().unwrap_or(false) && !leader_used;
        if leader {
            leader_used = true;
        }
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
            "leader": leader,
            "hidden": bot["hidden"].as_bool().unwrap_or(false),
            "maxConcurrency": bot["maxConcurrency"].as_i64().filter(|count| (1..=50).contains(count)).unwrap_or(1),
            "customArgs": [],
            "customEnv": {},
        });
        let mut entry = json!({"exportId": export_id, "resolution": resolution, "leader": leader, "fields": fields});
        if resolution == "replace" {
            entry["replaceAgentId"] = existing.map(|agent| agent["id"].clone()).unwrap_or(Value::Null);
        }
        plan_bots.push(entry);
    }

    // Memory.
    let mut plan_memory = Vec::new();
    let mut skipped_memory = 0u64;
    for record in contents["memory"].as_array().unwrap_or(&empty) {
        if memory_has_secret(record) {
            skipped_memory += 1;
            continue;
        }
        let scope = record["scope"].as_str().unwrap_or("");
        let mut entry = json!({
            "sourceId": record["id"],
            "scope": scope,
            "kind": record["kind"],
            "title": record["title"],
            "body": record["body"],
            "tags": record["tags"],
            "importance": record["importance"],
            "pinned": record["pinned"],
            "origin": record["origin"],
            "reviewed": record["reviewed"],
            "createdAt": record["createdAt"],
        });
        match scope {
            "blob" => {
                let Some(export_id) = record["scopeId"].as_str() else { skipped_memory += 1; continue; };
                let known = bots.iter().any(|bot| bot["exportId"].as_str() == Some(export_id));
                if !known || skipped_bot_ids.contains(export_id) {
                    skipped_memory += 1;
                    continue;
                }
                entry["scopeExportId"] = json!(export_id);
            }
            "project" => match resolve_project(&projects, record) {
                Some(id) => entry["scopeId"] = json!(id),
                None => {
                    skipped_memory += 1;
                    continue;
                }
            },
            "shared" => {}
            _ => {
                skipped_memory += 1;
                continue;
            }
        }
        plan_memory.push(entry);
    }

    // Automations.
    let mut plan_automations = Vec::new();
    let mut skipped_automations = 0u64;
    for automation in contents["automations"].as_array().unwrap_or(&empty) {
        let Some(export_id) = automation["agentId"].as_str() else { skipped_automations += 1; continue; };
        let known = bots.iter().any(|bot| bot["exportId"].as_str() == Some(export_id));
        if !known || skipped_bot_ids.contains(export_id) {
            skipped_automations += 1;
            continue;
        }
        plan_automations.push(json!({
            "agentExportId": export_id,
            "name": automation["name"],
            "prompt": automation["prompt"],
            "schedule": automation["schedule"],
            "sessionMode": automation["sessionMode"],
            "approvalMode": automation["approvalMode"],
            "maxRuntimeSecs": automation["maxRuntimeSecs"],
        }));
    }

    // Settings: allowlisted keys are validated; the rest are ignored.
    let mut plan_settings = Vec::new();
    let mut skipped_settings = 0u64;
    if let Some(incoming) = contents["settings"].as_object() {
        let mut keys = incoming.keys().collect::<Vec<_>>();
        keys.sort();
        for key in keys {
            let value = if key == "appearance.style" && matches!(incoming[key].as_str(), Some("legacy" | "pop" | "dot")) { json!("bitbots") } else { incoming[key].clone() };
            if !exportable_setting(key, &value) {
                continue;
            }
            match crate::validate_setting(key, &value) {
                Ok(valid) => plan_settings.push(json!({"key": key, "value": valid})),
                Err(_) => skipped_settings += 1,
            }
        }
    }

    // Skills: stage the files first, so a failure leaves nothing behind and the
    // pool folders move into place only after the database transaction commits.
    let existing_skills = st.db.skills_list().map_err(agent_error)?;
    let registered = existing_skills.iter().map(|skill| skill["name"].as_str().unwrap_or("").to_owned()).collect::<Vec<_>>();
    let mut staged = Vec::new();
    let mut skipped_skills = 0u64;
    for skill in contents["skills"].as_array().unwrap_or(&empty) {
        let name = skill["name"].as_str().unwrap_or("").to_owned();
        if !crate::skills::valid_skill_name(&name) {
            skipped_skills += 1;
            continue;
        }
        if registered.iter().any(|existing| existing == &name) {
            let resolution = skill_resolutions.and_then(|map| map.get(&name)).and_then(Value::as_str).unwrap_or("skip");
            if resolution == "skip" {
                skipped_skills += 1;
                continue;
            }
        }
        let Some(files) = decode_skill_files(skill) else {
            skipped_skills += 1;
            continue;
        };
        match crate::skills::stage_files(st, &files) {
            Ok(staging) => {
                let total: i64 = files.iter().map(|(_, bytes)| bytes.len() as i64).sum();
                staged.push(StagedSkill {
                    name,
                    description: skill["description"].as_str().unwrap_or("").to_owned(),
                    sha256: crate::skills::files_sha256(&files),
                    file_count: files.len() as i64,
                    total_bytes: total,
                    staging,
                });
            }
            Err(_) => skipped_skills += 1,
        }
    }

    let plan = json!({
        "bots": plan_bots,
        "memory": plan_memory,
        "automations": plan_automations,
        "settings": plan_settings,
    });
    let outcome = match st.db.backup_import(&plan) {
        Ok(outcome) => outcome,
        Err(error) => {
            for skill in &staged {
                crate::skills::discard_staged(&skill.staging);
            }
            return Err(agent_error(error));
        }
    };

    // Place the staged skills now the transaction has committed.
    let mut skills_imported = 0u64;
    for skill in &staged {
        if crate::skills::commit_staged(st, &skill.staging, &skill.name).is_ok() {
            let upsert = json!({
                "name": skill.name,
                "description": skill.description,
                "source": "backup",
                "contentSha256": skill.sha256,
                "fileCount": skill.file_count,
                "totalBytes": skill.total_bytes,
            });
            if st.db.skills_upsert(&upsert).is_ok() {
                st.emit("skills.changed", json!({"action": "imported", "name": skill.name})).await;
                skills_imported += 1;
                continue;
            }
        }
        crate::skills::discard_staged(&skill.staging);
        skipped_skills += 1;
    }

    // Broadcast everything the transaction produced, then the new events.
    if let Some(events) = outcome["events"].as_array() {
        st.broadcast_persisted(events.clone());
    }
    if let Some(automations) = outcome["automations"].as_array() {
        for automation in automations {
            st.emit("automation.changed", json!({"automation": automation})).await;
        }
    }

    let imported = json!({
        "bots": outcome["bots"],
        "memory": outcome["memory"],
        "skills": skills_imported,
        "automations": outcome["automations"].as_array().map(Vec::len).unwrap_or(0),
        "settings": outcome["settings"],
    });
    let skipped = json!({
        "bots": skipped_bots + outcome["skipped"]["bots"].as_u64().unwrap_or(0),
        "memory": skipped_memory + outcome["skipped"]["memory"].as_u64().unwrap_or(0),
        "skills": skipped_skills,
        "automations": skipped_automations + outcome["skipped"]["automations"].as_u64().unwrap_or(0),
        "settings": skipped_settings + outcome["skipped"]["settings"].as_u64().unwrap_or(0),
    });
    st.emit("backup.imported", json!({"imported": imported, "skipped": skipped})).await;

    Ok(json!({
        "imported": imported,
        "skipped": skipped,
        "renamed": outcome["renamed"],
    }))
}

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "backup.export" => export(st, p).await,
        "backup.preview" => preview(st, p).await,
        "backup.import" => import(st, p).await,
        _ => Err(derr("not_found", "unknown backup method", StatusCode::NOT_FOUND)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contents_serialisation_is_canonical() {
        // serde_json maps are sorted in this build, so the checksum over
        // `to_vec(&contents)` does not depend on insertion order.
        let first = json!({"b": 1, "a": {"y": 2, "x": 1}});
        let second = {
            let mut a = Map::new();
            a.insert("x".into(), json!(1));
            a.insert("y".into(), json!(2));
            let mut root = Map::new();
            root.insert("a".into(), Value::Object(a));
            root.insert("b".into(), json!(1));
            Value::Object(root)
        };
        assert_eq!(serde_json::to_vec(&first).unwrap(), serde_json::to_vec(&second).unwrap());
    }

    #[test]
    fn settings_allowlist_excludes_secrets_and_keeps_named_keys() {
        assert!(exportable_setting("appearance.style", &json!("bitbots")));
        assert!(exportable_setting("companion.hotkey", &json!("Ctrl+Space")));
        assert!(exportable_setting("experimental.memory", &json!(true)));
        assert!(!exportable_setting("exec_gate.codex.model", &json!(true)));
        assert!(!exportable_setting("internal.foo", &json!(1)));
        assert!(!exportable_setting("remote.token", &json!("x")));
        assert!(!exportable_setting("speech.cloud.consentAt", &json!("2026")));
        assert!(!exportable_setting("companion.positions", &json!({})));
        assert!(!exportable_setting("experimental.notBoolean", &json!("yes")));
        assert!(!exportable_setting("model_catalog_cache", &json!([])));
    }

    #[test]
    fn haze_style_survives_a_document_round_trip() {
        let document = build_document(json!({"bots": [], "memory": [], "skills": [], "automations": [], "settings": {"appearance.style": "haze"}})).unwrap();
        assert!(check_document(&document).is_ok());
        let restored = &document["contents"]["settings"]["appearance.style"];
        assert_eq!(restored, &json!("haze"));
        // Import keeps an allowlisted key only when settings.set would accept it.
        assert!(exportable_setting("appearance.style", restored));
        let accepted = crate::validate_setting("appearance.style", restored).unwrap();
        assert_eq!(accepted, json!("haze"));
    }

    #[test]
    fn damaged_and_newer_documents_are_refused() {
        let contents = json!({"bots": [], "memory": [], "skills": [], "automations": [], "settings": {}});
        let document = build_document(contents).unwrap();
        assert!(check_document(&document).is_ok());

        let mut newer = document.clone();
        newer["version"] = json!(2);
        let error = check_document(&newer).unwrap_err();
        assert_eq!(error.1.code, "unsupported");

        let mut tampered = document.clone();
        tampered["contents"]["bots"] = json!([{"name": "sneaky"}]);
        let error = check_document(&tampered).unwrap_err();
        assert_eq!(error.1.code, "invalid_argument");
        assert_eq!(error.1.message, "The backup file is damaged or was edited.");

        let mut wrong_format = document;
        wrong_format["format"] = json!("something.else");
        assert_eq!(check_document(&wrong_format).unwrap_err().1.code, "invalid_argument");
    }

    #[test]
    fn previews_expire_and_keep_at_most_two() {
        let previews = BackupPreviews::default();
        let first = previews.store(json!({"n": 1}));
        assert_eq!(previews.take(&first).unwrap()["n"], json!(1));
        assert!(previews.take(&first).is_none(), "a preview is single-use");

        let kept = previews.store(json!({"n": 2}));
        previews.store(json!({"n": 3}));
        previews.store(json!({"n": 4}));
        assert!(previews.take(&kept).is_none(), "the oldest preview is evicted once two are held");
    }
}
