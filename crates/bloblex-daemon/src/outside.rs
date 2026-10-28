//! Wave 13: the companion watches Claude Code sessions the owner started outside
//! Bitbots (in a terminal or an editor).
//!
//! It is opt-in. `outside.preview` shows the exact change to Claude Code's own
//! `settings.json`; `outside.enable` (with `confirm: true`) backs the file up
//! beside itself, adds Bitbots' hook entries and writes a small endpoint file
//! in the data folder; `outside.disable` removes only Bitbots' entries (and
//! backs the file up again). The hook bridge (`bitbots-hook --outside <file>`)
//! reads that endpoint file and sends each event as `outside.hook`, authorised
//! by a token that can do nothing else: never the daemon capability.
//!
//! Only the session id, the folder name, the tool name and a state are kept,
//! in memory. Prompts, messages, tool inputs and the full folder path never are.
//! Claude Code that Bitbots itself starts carries `BITBOTS_MANAGED=1`, so the
//! bridge ignores it and Bitbots' own conversations never show up twice.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::Mutex as StdMutex};

/// The Claude Code hook events Bitbots listens to.
const EVENTS: [&str; 7] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];
/// A session that has said nothing for this long is dropped from the list.
const STALE_AFTER_MINUTES: i64 = 120;
/// At most this many outside sessions are tracked at once.
const MAX_SESSIONS: usize = 24;
/// The setting that records the owner's opt-in.
pub const SETTING: &str = "outside.watch";
/// The endpoint file's name inside the data folder.
const ENDPOINT_FILE: &str = "outside-hook.json";

#[derive(Clone)]
struct Watched {
    folder: String,
    state: &'static str,
    tool: Option<String>,
    started_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

/// In-memory state: the narrow hook token for this daemon run and the sessions seen.
pub struct Outside {
    token: String,
    sessions: StdMutex<HashMap<String, Watched>>,
}

impl Default for Outside {
    fn default() -> Self {
        Self { token: bloblex_security::new_capability(), sessions: StdMutex::new(HashMap::new()) }
    }
}

impl Outside {
    /// Whether a bearer value is this run's hook token.
    pub fn accepts(&self, supplied: &str) -> bool {
        bloblex_security::capability_matches(&self.token, supplied)
    }
}

fn fmt(at: DateTime<Utc>) -> String { at.to_rfc3339_opts(SecondsFormat::Millis, true) }

/// Claude Code's user settings file, honouring `CLAUDE_CONFIG_DIR`.
pub fn claude_settings_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(PathBuf::from));
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| home.map(|home| home.join(".claude"))).map(|base| base.join("settings.json"))
}

/// The hook bridge. The desktop shell names it (`BITBOTS_HOOK_BRIDGE`), because the
/// daemon runs from a private copy that has no bridge beside it; a daemon started
/// by hand finds it beside its own executable.
pub fn hook_bridge_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("BITBOTS_HOOK_BRIDGE").map(PathBuf::from).filter(|path| path.is_file()) {
        return Some(path);
    }
    let name = if cfg!(windows) { "bitbots-hook.exe" } else { "bitbots-hook" };
    std::env::current_exe().ok()?.parent().map(|folder| folder.join(name)).filter(|path| path.is_file())
}

fn endpoint_path(st: &AppState) -> Option<PathBuf> {
    st.team.data_dir.lock().unwrap().clone().map(|dir| dir.join(ENDPOINT_FILE))
}

/// The command Claude Code runs for every hook event.
pub fn hook_command(bridge: &Path, endpoint: &Path) -> String {
    format!("\"{}\" --outside \"{}\"", bridge.display(), endpoint.display())
}

/// Whether a hook entry is one Bitbots added.
fn is_ours(entry: &Value) -> bool {
    entry["command"].as_str().is_some_and(|command| command.contains("bitbots-hook") && command.contains("--outside"))
}

/// The settings with Bitbots' entries removed: other hooks, and every other
/// setting, are kept as they were. Empty groups and events are dropped.
pub fn without_hooks(settings: &Value) -> Value {
    let mut out = settings.clone();
    let Some(hooks) = out.get_mut("hooks").and_then(Value::as_object_mut) else { return out };
    for groups in hooks.values_mut() {
        if let Some(list) = groups.as_array_mut() {
            for group in list.iter_mut() {
                if let Some(entries) = group.get_mut("hooks").and_then(Value::as_array_mut) { entries.retain(|entry| !is_ours(entry)); }
            }
            list.retain(|group| group["hooks"].as_array().is_none_or(|entries| !entries.is_empty()));
        }
    }
    hooks.retain(|_, groups| groups.as_array().is_none_or(|list| !list.is_empty()));
    if hooks.is_empty() { if let Some(map) = out.as_object_mut() { map.remove("hooks"); } }
    out
}

/// The settings with Bitbots' entries added once per event (replacing an older copy).
pub fn with_hooks(settings: &Value, command: &str) -> Result<Value, String> {
    let mut out = without_hooks(settings);
    let map = out.as_object_mut().ok_or("Claude Code's settings file does not hold a settings object.")?;
    let hooks = map.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks.as_object_mut().ok_or("The \"hooks\" setting in Claude Code's settings file is not an object.")?;
    for event in EVENTS {
        let groups = hooks.entry(event).or_insert_with(|| json!([]));
        let list = groups.as_array_mut().ok_or_else(|| format!("The \"{event}\" hooks in Claude Code's settings file are not a list."))?;
        let mut group = json!({"hooks":[{"type":"command","command":command,"timeout":5}]});
        if matches!(event, "PreToolUse" | "PostToolUse") { group["matcher"] = json!("*"); }
        list.push(group);
    }
    Ok(out)
}

/// Whether the settings already carry Bitbots' entries.
pub fn installed(settings: &Value) -> bool {
    settings["hooks"].as_object().is_some_and(|hooks| hooks.values().any(|groups| groups.as_array().is_some_and(|list| list.iter().any(|group| group["hooks"].as_array().is_some_and(|entries| entries.iter().any(is_ours))))))
}

/// Reads a settings file. A missing file is an empty object; a file that is not
/// a JSON object is refused, so Bitbots never overwrites something it cannot read.
fn read_settings(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => serde_json::from_str::<Value>(&text).ok().filter(Value::is_object)
            .ok_or_else(|| "Claude Code's settings file is not valid JSON, so Bitbots did not change it.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(_) => Err("Claude Code's settings file could not be read.".to_owned()),
    }
}

/// Copies the current file beside itself before a change; `None` when there was no file.
fn back_up(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.is_file() { return Ok(None); }
    let backup = path.with_file_name(format!("settings.json.bitbots-backup-{}", Utc::now().format("%Y%m%d-%H%M%S")));
    std::fs::copy(path, &backup).map_err(|_| "Claude Code's settings file could not be backed up, so it was not changed.".to_owned())?;
    Ok(Some(backup))
}

fn write_settings(path: &Path, settings: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|_| "Claude Code's settings folder could not be created.".to_owned())?; }
    let text = serde_json::to_string_pretty(settings).map_err(|_| "The settings could not be written.".to_owned())? + "\n";
    let temp = path.with_extension("json.bitbots-tmp");
    std::fs::write(&temp, text).map_err(|_| "Claude Code's settings file could not be written.".to_owned())?;
    std::fs::rename(&temp, path).map_err(|_| { let _ = std::fs::remove_file(&temp); "Claude Code's settings file could not be replaced.".to_owned() })
}

/// Writes (or refreshes) the endpoint file the bridge reads: this run's address
/// and hook token. It sits in Bitbots' own data folder.
pub fn write_endpoint(st: &AppState) {
    let (Some(path), Some(address)) = (endpoint_path(st), st.team.address.lock().unwrap().clone()) else { return };
    let _ = std::fs::write(path, json!({"address": address, "token": st.outside.token}).to_string());
}

fn remove_endpoint(st: &AppState) {
    if let Some(path) = endpoint_path(st) { let _ = std::fs::remove_file(path); }
}

/// Startup: refresh the endpoint file when the owner opted in, so a hook that
/// fires after a restart reaches this run.
pub fn startup(st: &AppState) {
    if st.db.settings().ok().is_some_and(|settings| settings[SETTING] == true) { write_endpoint(st); }
}

// ---------------------------------------------------------------------------
// Hook events

/// One hook event from the bridge. Only the session id, folder name, tool name
/// and event kind are read; everything else in the payload is ignored.
pub async fn hook(st: &AppState, event: &Value) -> Value {
    let Some(id) = event["session_id"].as_str().map(str::trim).filter(|id| !id.is_empty() && id.len() <= 128) else { return json!({"received":false}) };
    let name = event["hook_event_name"].as_str().unwrap_or("");
    let folder = event["cwd"].as_str().and_then(|cwd| Path::new(cwd).file_name().and_then(|name| name.to_str())).unwrap_or("").chars().take(80).collect::<String>();
    let tool = event["tool_name"].as_str().map(|tool| tool.chars().take(60).collect::<String>());
    let now = Utc::now();
    let changed = {
        let mut sessions = st.outside.sessions.lock().unwrap_or_else(|poison| poison.into_inner());
        sessions.retain(|_, watched| now - watched.updated_at < Duration::minutes(STALE_AFTER_MINUTES));
        if name == "SessionEnd" {
            sessions.remove(id).is_some()
        } else {
            let state = match name {
                "SessionStart" => "idle",
                "UserPromptSubmit" | "PreToolUse" | "PostToolUse" => "working",
                // Claude Code notifies when it needs a permission or is waiting for input.
                "Notification" if event["message"].as_str().is_some_and(|message| message.to_ascii_lowercase().contains("permission")) => "waiting",
                "Notification" => "idle",
                "Stop" => "done",
                _ => return json!({"received":false}),
            };
            if !sessions.contains_key(id) && sessions.len() >= MAX_SESSIONS {
                if let Some(oldest) = sessions.iter().min_by_key(|(_, watched)| watched.updated_at).map(|(key, _)| key.clone()) { sessions.remove(&oldest); }
            }
            let entry = sessions.entry(id.to_owned()).or_insert_with(|| Watched { folder: folder.clone(), state, tool: None, started_at: now, updated_at: now });
            if !folder.is_empty() { entry.folder = folder; }
            entry.state = state;
            entry.tool = if name == "PreToolUse" { tool } else if state == "working" { entry.tool.take() } else { None };
            entry.updated_at = now;
            true
        }
    };
    if changed { st.emit("outside.sessions.changed", json!({"sessions": list(st)})).await; }
    json!({"received":true})
}

/// The watched sessions, most recent first.
pub fn list(st: &AppState) -> Vec<Value> {
    let now = Utc::now();
    let sessions = st.outside.sessions.lock().unwrap_or_else(|poison| poison.into_inner());
    let mut rows = sessions.iter().filter(|(_, watched)| now - watched.updated_at < Duration::minutes(STALE_AFTER_MINUTES)).collect::<Vec<_>>();
    rows.sort_by(|a, b| b.1.updated_at.cmp(&a.1.updated_at));
    rows.into_iter().map(|(id, watched)| json!({
        "id": id, "provider": "claude", "folder": watched.folder, "state": watched.state, "tool": watched.tool,
        "startedAt": fmt(watched.started_at), "updatedAt": fmt(watched.updated_at),
    })).collect()
}

// ---------------------------------------------------------------------------
// RPC

fn bad(message: &str) -> DispatchError { derr("conflict", message, StatusCode::CONFLICT) }

fn status(st: &AppState, settings_path: Option<&Path>) -> Value {
    let enabled = st.db.settings().ok().is_some_and(|settings| settings[SETTING] == true);
    let current = settings_path.map(read_settings);
    json!({
        "enabled": enabled,
        "installed": current.as_ref().and_then(|value| value.as_ref().ok()).is_some_and(installed),
        "settingsPath": settings_path.map(|path| path.display().to_string()),
        "bridgeAvailable": hook_bridge_path().is_some(),
        "problem": current.and_then(Result::err),
    })
}

/// The before and after text of Claude Code's settings for the consent screen.
fn preview(settings_path: &Path, command: &str) -> Result<Value, DispatchError> {
    let before = read_settings(settings_path).map_err(|message| bad(&message))?;
    let after = with_hooks(&before, command).map_err(|message| bad(&message))?;
    Ok(json!({
        "settingsPath": settings_path.display().to_string(),
        "exists": settings_path.is_file(),
        "before": serde_json::to_string_pretty(&before).unwrap_or_default(),
        "after": serde_json::to_string_pretty(&after).unwrap_or_default(),
    }))
}

/// The paths a change needs, or why it cannot happen on this machine.
fn targets(st: &AppState) -> Result<(PathBuf, String), DispatchError> {
    let settings_path = claude_settings_path().ok_or_else(|| bad("Claude Code's settings folder could not be found."))?;
    let bridge = hook_bridge_path().ok_or_else(|| bad("The hook bridge is not installed beside Bitbots, so outside sessions cannot be watched."))?;
    let endpoint = endpoint_path(st).ok_or_else(|| bad("Bitbots' data folder is not ready yet."))?;
    Ok((settings_path, hook_command(&bridge, &endpoint)))
}

pub(crate) fn enable_at(st: &AppState, settings_path: &Path, command: &str) -> Result<Value, DispatchError> {
    let before = read_settings(settings_path).map_err(|message| bad(&message))?;
    let after = with_hooks(&before, command).map_err(|message| bad(&message))?;
    let backup = back_up(settings_path).map_err(|message| bad(&message))?;
    write_settings(settings_path, &after).map_err(|message| bad(&message))?;
    st.db.set_setting(SETTING, &json!(true)).map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
    write_endpoint(st);
    Ok(json!({"backupPath": backup.map(|path| path.display().to_string())}))
}

pub(crate) fn disable_at(st: &AppState, settings_path: &Path) -> Result<Value, DispatchError> {
    let before = read_settings(settings_path);
    let mut backup = None;
    if let Ok(before) = &before {
        if installed(before) {
            backup = back_up(settings_path).map_err(|message| bad(&message))?;
            write_settings(settings_path, &without_hooks(before)).map_err(|message| bad(&message))?;
        }
    }
    st.db.set_setting(SETTING, &json!(false)).map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
    remove_endpoint(st);
    st.outside.sessions.lock().unwrap_or_else(|poison| poison.into_inner()).clear();
    Ok(json!({"backupPath": backup.map(|path| path.display().to_string()), "problem": before.err()}))
}

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "outside.status" => Ok(status(st, claude_settings_path().as_deref())),
        "outside.preview" => { let (settings_path, command) = targets(st)?; preview(&settings_path, &command) }
        "outside.enable" => {
            if p["confirm"] != true { return Err(derr("confirmation_required", "Confirm the change to Claude Code's settings first.", StatusCode::CONFLICT)); }
            let (settings_path, command) = targets(st)?;
            let mut result = enable_at(st, &settings_path, &command)?;
            result["status"] = status(st, Some(&settings_path));
            Ok(result)
        }
        "outside.disable" => {
            let settings_path = claude_settings_path().ok_or_else(|| bad("Claude Code's settings folder could not be found."))?;
            let mut result = disable_at(st, &settings_path)?;
            st.emit("outside.sessions.changed", json!({"sessions": []})).await;
            result["status"] = status(st, Some(&settings_path));
            Ok(result)
        }
        "outside.sessions" => Ok(json!({"sessions": list(st)})),
        _ => Err(derr("not_found", "unknown outside method", StatusCode::NOT_FOUND)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    const COMMAND: &str = "\"C:\\Bitbots\\bitbots-hook.exe\" --outside \"C:\\Data\\outside-hook.json\"";

    #[test]
    fn hooks_are_added_once_and_removed_without_touching_anything_else() {
        let user = json!({"model":"opus","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"my-guard.sh"}]}]}});
        let added = with_hooks(&user, COMMAND).unwrap();
        assert!(installed(&added));
        assert_eq!(added["model"], "opus", "other settings stay");
        assert_eq!(added["hooks"]["PreToolUse"].as_array().unwrap().len(), 2, "the owner's own hook stays beside ours");
        let again = with_hooks(&added, COMMAND).unwrap();
        assert_eq!(again, added, "adding twice changes nothing");
        assert_eq!(added["hooks"].as_object().unwrap().len(), EVENTS.len());
        let removed = without_hooks(&added);
        assert_eq!(removed, user, "removing restores exactly what the owner had");
        assert_eq!(without_hooks(&with_hooks(&json!({}), COMMAND).unwrap()), json!({}), "no empty hooks object is left behind");
        assert!(with_hooks(&json!({"hooks":[]}), COMMAND).is_err(), "a settings shape Bitbots cannot read is refused");
    }

    #[test]
    fn a_settings_file_that_is_not_json_is_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("bitbots-outside-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(read_settings(&path).is_err());
        assert_eq!(read_settings(&dir.join("missing.json")).unwrap(), json!({}), "a missing file is an empty one");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_hook_command_quotes_both_paths() {
        assert_eq!(hook_command(Path::new("C:\\Program Files\\Bitbots\\bitbots-hook.exe"), Path::new("C:\\Users\\me\\AppData\\outside-hook.json")),
            "\"C:\\Program Files\\Bitbots\\bitbots-hook.exe\" --outside \"C:\\Users\\me\\AppData\\outside-hook.json\"");
    }
}
