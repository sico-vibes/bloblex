//! Wave 12, part F: the Doctor.
//!
//! One read-only pass over the things that most often stop Bitbots working: the
//! coding agents it discovered, the database file, the hook bridge beside the
//! daemon, the Remote gateway when it is on, and the on-device speech model when
//! one is installed. Every check says what it looked at in a sentence the owner
//! can act on.
//!
//! Two rules keep it safe:
//!
//! 1. **A fix is an existing safe RPC.** A check never invents a destructive
//!    action; a rescan (`runtime.refresh`) and a sign-in reset
//!    (`runtime.auth.clear`) are the whole vocabulary, and a check with nothing
//!    safe to offer reports `fix: null`.
//! 2. **No secrets in `detail`.** No tokens, credential contents or environment
//!    values: only executable paths, versions, counts, status words and SQLite's
//!    own answer.

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};

use crate::{derr, AppState, DispatchError};

/// The app's own local data folder name on Windows (`tauri.conf.json`'s
/// identifier, which is what the shell's `app_local_data_dir` resolves to).
const APP_LOCAL_FOLDER: &str = "com.bitbots.desktop";

/// A short, single-line detail: provider text can wrap, a Doctor row cannot.
fn one_line(text: &str, limit: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(limit).collect()
}

fn check(id: &str, area: &str, label: &str, status: &str, detail: String, fix: Option<Value>) -> Value {
    json!({"id":id,"area":area,"label":label,"status":status,"detail":detail,"fix":fix})
}

/// The one fix a missing runtime or a failed protocol probe offers: scan again.
fn rescan_fix() -> Value {
    json!({"label":"Scan for coding agents again","method":"runtime.refresh","params":{}})
}

/// Every coding agent the daemon keeps a record for: installed, version, sign-in
/// and protocol, all read from the stored records rather than run again here.
fn runtime_checks(runtimes: &[Value]) -> Vec<Value> {
    let mut checks = Vec::new();
    for runtime in runtimes {
        let id = runtime["id"].as_str().unwrap_or("");
        let provider = runtime["provider"].as_str().unwrap_or("");
        let name = runtime["displayName"].as_str().map(str::trim).filter(|name| !name.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| match provider { "claude" => "Claude Code".into(), "codex" => "Codex".into(), "opencode" => "OpenCode".into(), _ => "Coding agent".into() });
        let executable = runtime["executablePath"].as_str().unwrap_or("");
        let installed = !executable.is_empty() && Path::new(executable).is_file();
        checks.push(if installed {
            check(&format!("runtime.{id}.installed"), "runtime", &format!("{name} is installed"), "ok", format!("Found at {executable}."), None)
        } else {
            check(&format!("runtime.{id}.installed"), "runtime", &format!("{name} is installed"), "fail",
                if executable.is_empty() { format!("{name} was not found on this computer.") } else { format!("{name} is not at {executable} any more.") },
                Some(rescan_fix()))
        });
        let version = runtime["version"].as_str().map(str::trim).filter(|version| !version.is_empty());
        checks.push(match version {
            Some(version) => check(&format!("runtime.{id}.version"), "runtime", &format!("{name} reports its version"), "ok", format!("Version {version}."), None),
            None => check(&format!("runtime.{id}.version"), "runtime", &format!("{name} reports its version"), "warn", format!("{name} did not report a version."), Some(rescan_fix())),
        });
        let auth = runtime["authState"].as_str().unwrap_or("unknown");
        let (status, detail, fix) = match auth {
            "authenticated" => ("ok", format!("{name} is signed in."), None),
            "sign_in_failed" => ("fail", format!("{name} could not sign in last time it ran. Sign in again in the coding agent itself."), None),
            "unauthenticated" => ("warn", format!("{name} is not signed in."), None),
            _ => ("warn", format!("Bitbots could not tell whether {name} is signed in."), Some(rescan_fix())),
        };
        checks.push(check(&format!("runtime.{id}.auth"), "runtime", &format!("{name} is signed in"), status, detail, fix));
        let online = runtime["status"].as_str().unwrap_or("").eq_ignore_ascii_case("online");
        let step = runtime["probeStep"].as_str().unwrap_or("");
        checks.push(if online {
            check(&format!("runtime.{id}.protocol"), "runtime", &format!("{name} speaks the protocol Bitbots needs"), "ok", format!("The {} protocol check passed.", runtime["protocolFamily"].as_str().unwrap_or("expected")), None)
        } else if step == "Protocol check" {
            check(&format!("runtime.{id}.protocol"), "runtime", &format!("{name} speaks the protocol Bitbots needs"), "fail",
                format!("{name} did not answer with the expected protocol. Update it and scan again."), Some(rescan_fix()))
        } else {
            check(&format!("runtime.{id}.protocol"), "runtime", &format!("{name} speaks the protocol Bitbots needs"), "warn",
                if step.is_empty() { format!("{name}'s protocol was not checked yet.") } else { format!("The {step} step of the check did not finish.") }, Some(rescan_fix()))
        });
    }
    checks
}

/// The database: SQLite's quick check, the schema version, and the file's size.
fn database_checks(st: &AppState) -> Vec<Value> {
    let Ok(diagnosis) = st.db.diagnosis() else {
        return vec![check("database.read", "database", "Bitbots can read its database", "fail",
            "The database could not be read.".to_owned(), None)];
    };
    let quick = diagnosis["quickCheck"].as_str().unwrap_or("unknown");
    let version = diagnosis["schemaVersion"].as_i64().unwrap_or(0);
    let migrations = diagnosis["schemaMigrations"].as_i64().unwrap_or(0);
    let size = diagnosis["sizeBytes"].as_u64().unwrap_or(0);
    vec![
        check("database.quickCheck", "database", "The database is intact", if quick == "ok" { "ok" } else { "fail" },
            if quick == "ok" { "SQLite's quick check passed.".to_owned() } else { format!("SQLite's quick check reported: {}.", one_line(quick, 160)) }, None),
        check("database.schema", "database", "The database schema is current", if version == migrations { "ok" } else { "fail" },
            format!("Schema version {version} of {migrations}, using {}.", human_size(size)), None),
    ]
}

fn human_size(bytes: u64) -> String {
    match bytes {
        0..=1023 => format!("{bytes} bytes"),
        _ if bytes < 1024 * 1024 => format!("{} KB", bytes / 1024),
        _ => format!("{} MB", bytes / (1024 * 1024)),
    }
}

/// The hook bridge the shell stages beside the daemon. It carries a coding
/// agent's own hooks to Bitbots; nothing here reads its contents.
fn hook_checks() -> Vec<Value> {
    // The installed daemon runs from a private copy, so the shell names the bridge
    // (owner report, 28 October 2026: the old check looked beside that copy).
    let found = crate::outside::hook_bridge_path().is_some();
    vec![check("hooks.bridge", "hooks", "Hook bridge", if found { "ok" } else { "warn" },
        if found { "Installed. Coding agents can report hook events to Bitbots.".to_owned() }
        else { "Missing: bitbots-hook.exe is not in Bitbots' install folder, so coding agents cannot report hook events. To fix it, install the latest Bitbots release again; your bots and conversations are kept.".to_owned() }, None)]
}

/// The Remote gateway, only when the owner has it on.
fn remote_checks(st: &AppState) -> Vec<Value> {
    let status = st.remote.status_value(st);
    if status["enabled"] != true { return Vec::new(); }
    let method = status["method"].as_str().unwrap_or("tailscale");
    let port = status["port"].as_u64().unwrap_or(0);
    let devices = status["deviceCount"].as_u64().unwrap_or(0);
    let error = status["error"].as_str().map(str::trim).filter(|error| !error.is_empty());
    let (state, detail) = match error {
        Some(error) => ("fail", format!("Remote is on over {method}, port {port}, for {devices} paired device(s), but it reported: {}.", one_line(error, 160))),
        None => ("ok", format!("Remote is on over {method}, port {port}, for {devices} paired device(s).")),
    };
    vec![check("remote.gateway", "remote", "The Remote gateway is running", state, detail, None)]
}

/// The on-device speech model, only when one is installed. The shell keeps it in
/// the app's local folder, or in the shared location it falls back to when that
/// path is not ASCII.
fn speech_checks() -> Vec<Value> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join(APP_LOCAL_FOLDER).join("speech-models"));
    }
    if let Ok(program_data) = std::env::var("PROGRAMDATA") {
        roots.push(PathBuf::from(program_data).join("Bitbots").join("speech-models"));
    }
    for root in roots {
        if !root.is_dir() { continue; }
        let folders = std::fs::read_dir(&root).map(|entries| entries.flatten().filter(|entry| entry.path().is_dir()).count()).unwrap_or(0);
        if folders == 0 { continue; }
        return vec![check("speech.model", "speech", "The on-device speech model is installed", "ok",
            format!("{folders} on-device speech model folder(s) are installed for dictation."), None)];
    }
    Vec::new()
}

/// `doctor.run`: every check, newest reading first, and a timestamp the UI shows.
pub async fn run(st: &AppState) -> Result<Value, DispatchError> {
    let mut checks = Vec::new();
    {
        let runtimes = st.runtimes.read().await.clone();
        checks.extend(runtime_checks(&runtimes));
    }
    checks.extend(database_checks(st));
    checks.extend(hook_checks());
    checks.extend(remote_checks(st));
    checks.extend(speech_checks());
    if checks.is_empty() {
        return Err(derr("conflict", "There is nothing to check yet.", StatusCode::CONFLICT));
    }
    Ok(json!({"checkedAt":Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),"checks":checks}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_executable_fails_with_a_rescan_fix() {
        let runtimes = vec![json!({
            "id": "rt_missing", "provider": "claude", "displayName": "Claude Code",
            "protocolFamily": "claude_stream", "executablePath": "C:/definitely/not/here/claude.exe",
            "version": "1.2.3", "authState": "authenticated", "status": "offline"
        })];
        let checks = runtime_checks(&runtimes);
        let installed = checks.iter().find(|row| row["id"] == "runtime.rt_missing.installed").expect("an installed check");
        assert_eq!(installed["status"], "fail");
        assert_eq!(installed["area"], "runtime");
        assert_eq!(installed["fix"]["method"], "runtime.refresh");
        assert_eq!(installed["fix"]["params"], json!({}));
        // A runtime that is installed here keeps the rescan out of its row.
        let here = json!({"id":"rt_here","provider":"codex","displayName":"Codex","protocolFamily":"codex_app_server","executablePath":std::env::current_exe().unwrap().to_string_lossy(),"version":"0.1","authState":"authenticated","status":"online"});
        let checks = runtime_checks(&[here]);
        assert_eq!(checks.iter().find(|row| row["id"] == "runtime.rt_here.installed").unwrap()["status"], "ok");
        assert!(checks.iter().find(|row| row["id"] == "runtime.rt_here.installed").unwrap()["fix"].is_null());
    }

    #[tokio::test]
    async fn doctor_run_returns_the_documented_shape_and_names_no_secret() {
        let (st, _) = crate::phase2a_tests::state();
        let result = run(&st).await.unwrap();
        assert!(result["checkedAt"].as_str().is_some_and(|stamp| stamp.contains('T')));
        let checks = result["checks"].as_array().expect("checks");
        assert!(!checks.is_empty());
        for row in checks {
            let area = row["area"].as_str().unwrap();
            assert!(["runtime", "database", "hooks", "remote", "speech"].contains(&area), "{area}");
            assert!(["ok", "warn", "fail"].contains(&row["status"].as_str().unwrap()), "{row}");
            assert!(row["id"].as_str().is_some_and(|id| !id.is_empty()));
            assert!(row["label"].as_str().is_some_and(|label| !label.is_empty()));
            assert!(row["detail"].as_str().is_some());
            let fix = &row["fix"];
            if !fix.is_null() {
                // Every fix points at an RPC that already exists.
                assert!(["runtime.refresh", "runtime.auth.clear"].contains(&fix["method"].as_str().unwrap()), "{fix}");
                assert!(fix["label"].as_str().is_some_and(|label| !label.is_empty()));
            }
            let detail = row["detail"].as_str().unwrap();
            for secret in ["token", "Bearer ", "password", "api_key"] {
                assert!(!detail.to_lowercase().contains(&secret.to_lowercase()), "{detail}");
            }
        }
        assert!(checks.iter().any(|row| row["area"] == "database"));
    }

    #[test]
    fn database_and_hook_rows_are_one_line_and_actionable() {
        assert_eq!(human_size(900), "900 bytes");
        assert_eq!(human_size(2048), "2 KB");
        assert_eq!(human_size(5 * 1024 * 1024), "5 MB");
        assert_eq!(one_line("a\n b  c", 20), "a b c");
        let hooks = hook_checks();
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0]["status"], "warn", "a test binary has no hook bridge beside it");
    }
}
