//! FIX39 P12: local diagnostics.
//!
//! The daemon logs to a rolling file under the app's data folder (`logs/`), and
//! "Export diagnostics" writes one `.zip` with the recent logs, the last app
//! events, the environment, the settings with secrets removed and a README.
//!
//! Privacy (AGENTS.md): the log file and the zip never carry message or prompt
//! text, recap text, command text, file contents, credentials, tokens,
//! environment values, Tailscale status JSON or Remote cookies. Two mechanisms
//! keep that true:
//!
//! 1. no log call site passes user text (checked by
//!    `every_daemon_log_call_site_is_a_fixed_message` in `main.rs`), and
//! 2. [`RedactingWriter`] scrubs secret-shaped material out of every line that
//!    reaches the file, while [`scrub_events`] and [`scrub_settings`] remove
//!    content and secrets from what goes into the zip.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use axum::http::StatusCode;
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde_json::{json, Map, Value};
use tracing_appender::rolling::{RollingFileAppender, Rotation};

use crate::{derr, AppState, DispatchError};

/// The whole `logs/` folder is pruned to about this much, oldest first.
pub const MAX_LOG_BYTES: u64 = 20 * 1024 * 1024;
/// Daily files are kept for at most this many days.
pub const MAX_LOG_FILES: usize = 14;
/// How many recent app events the export carries.
pub const MAX_EVENTS: usize = 200;
/// A single log file is copied into the zip only up to its last this many bytes.
const MAX_LOG_TAIL_BYTES: usize = 5 * 1024 * 1024;

/// The settings key that raises the log level to `debug`.
pub const LOG_LEVEL_SETTING: &str = "diagnostics.logLevel";

/// The `logs/` folder inside the app's data folder.
pub fn log_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

/// The tracing target the daemon's own logs use: the Cargo `[[bin]]` name
/// (`bitbotsd`), which is also the crate name `module_path!()` is built from —
/// *not* the package name (`bloblex-daemon` → `bloblex_daemon`). A directive
/// naming the package would match no target, and `debug` would behave like
/// `info`.
const LOG_TARGET: &str = "bitbotsd";

/// The `EnvFilter` directive for a hidden log level. `debug` is scoped to this
/// crate only (`bitbotsd=debug,info`), so a dependency's debug output
/// (hyper, h2, rustls, reqwest, tungstenite) never reaches the file or the zip.
pub fn log_directive(level: &str) -> String {
    if level == "debug" {
        format!("{LOG_TARGET}=debug,info")
    } else {
        "info".to_string()
    }
}

// ---------------------------------------------------------------------------
// Redaction

fn secret_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            // Bearer tokens: `Authorization: Bearer eyJ...`
            r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}",
            // Provider keys: `sk-ant-...`, `sk-...`, `xai-...`
            r"\b(?:sk|xai|api)[-_][A-Za-z0-9_-]{12,}",
            // Argon2 password hashes and other `$...$` credential blobs
            r#"\$(?:argon2|scrypt|pbkdf2)[^\s"']{8,}"#,
            // `token=...`, `password: ...`, `Cookie: ...`, bare or quoted, and
            // the JSON form `"token":"..."` (the closing quote of the key may
            // sit between the key and the separator).
            r#"(?i)(capability|token|secret|password|passwd|credential|api[-_]?key|authorization|cookie)["']?(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;"'}\]]+)"#,
            // Remote session cookie: `bloblex_remote=...`
            r"(?i)\bbloblex[a-z_-]*=[^;\s]+",
        ]
        .iter()
        .filter_map(|pattern| Regex::new(pattern).ok())
        .collect()
    })
}

/// Replace secret-shaped material in one line of text. Ids, error classes,
/// versions, timings and exit codes are left alone.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for pattern in secret_patterns() {
        if pattern.is_match(&out) {
            out = pattern.replace_all(&out, "[redacted]").into_owned();
        }
    }
    out
}

/// A writer that redacts every chunk before it reaches the file.
pub struct RedactingWriter<W: Write> {
    inner: W,
}

impl<W: Write> RedactingWriter<W> {
    pub fn new(inner: W) -> Self {
        Self { inner }
    }
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        self.inner.write_all(redact(&text).as_bytes())?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// The only keys copied out of an app event. Everything else is dropped, so a
/// key nobody thought of (an agent's question text, a file path, a nested
/// message) cannot leak: this is an allowlist, not a denylist. Ids, enum-ish
/// state, error classes, providers, versions, timings and counters are kept;
/// message and prompt text, command text, recap text, file contents and paths
/// are not.
const EVENT_SAFE_KEYS: &[&str] = &[
    // envelope
    "v", "eventId", "sequence", "timestamp", "type", "payload",
    // identity
    "id", "sessionId", "turnId", "runtimeId", "agentId", "messageId", "permissionId",
    "requestId", "providerRequestId", "deviceId", "botId", "workspaceId", "threadId",
    "runId", "jobId", "callId", "projectId", "hostId", "toolCallId", "parentId",
    // state and classification
    "provider", "providerName", "state", "status", "code", "errorCode", "exitCode",
    "kind", "category", "risk", "mode", "role", "failureClass", "severity", "decision",
    "phase", "action", "tier", "level", "reasonCode", "model", "effort", "toolName",
    "protocol", "protocolFamily", "authState", "version", "adapter",
    // timestamps
    "at", "createdAt", "updatedAt", "startedAt", "endedAt", "expiresAt", "emittedAt",
    "completedAt", "failedAt", "queuedAt", "lastAttemptAt", "fetchedAt", "resetsAt",
    "pausedAt", "resolvedAt",
    // counters and sizes
    "count", "total", "index", "size", "sizeBytes", "bytes", "length", "attempt",
    "attempts", "retryCount", "failureCount", "durationMs", "elapsedMs", "tookMs",
    "inputTokens", "outputTokens", "contextTokens", "totalTokens", "cachedTokens",
    "percent", "usedPercent", "used", "limit", "remaining", "earliestSequence",
    "messageCount", "toolCount", "filesChanged", "additions", "deletions",
    // flags
    "ok", "success", "failed", "retryable", "available", "replayAvailable",
    "truncated", "locked", "enabled", "paused", "cancelled", "auto", "manual",
    "streaming", "partial",
];

/// Keys withheld from the exported settings: the owner's own free text and the
/// app's internal bookkeeping. Replaced with a marker so the file still shows
/// that the key existed.
fn is_withheld_setting(key: &str) -> bool {
    key == "profile.about" || key == "internal" || key.starts_with("internal.")
}

/// A true secret-shaped key. Token *counters* (`inputTokens`, `outputTokens`,
/// `contextTokens`) and commit hashes must survive, so `token` is matched as a
/// whole word or a `…Token` suffix, and `hash` only on its own.
fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    if ["secret", "password", "passwd", "credential", "authorization", "cookie", "api_key", "apikey", "api-key", "capability"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return true;
    }
    // A password-hash field is called `hash` (or `tokenHash`); a commit hash is
    // not a secret and must not be redacted.
    if lower == "hash" || lower == "tokenhash" {
        return true;
    }
    // `token`, `accessToken`, `refresh_token`, `id_token` … but not `tokens`,
    // `inputTokens`, `tokenCount` or `tokenUsage`.
    lower == "token" || lower.ends_with("token")
}

/// Copy a JSON value with only allowlisted keys kept, secret keys replaced and
/// any secret-shaped string redacted. Used for app events in the zip.
pub fn scrub_events(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, entry) in map {
                if is_secret_key(key) {
                    out.insert(key.clone(), json!("[redacted]"));
                } else if EVENT_SAFE_KEYS.contains(&key.as_str()) {
                    // `payload` is a container; a string under it is never safe.
                    if key == "payload" && !entry.is_object() && !entry.is_array() {
                        continue;
                    }
                    out.insert(key.clone(), scrub_events(entry));
                }
                // Every other key is dropped, so nothing unclassified leaks.
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(scrub_events).collect()),
        Value::String(text) => Value::String(redact(text)),
        other => other.clone(),
    }
}

/// The settings scrub: every key is kept so the owner can see their own
/// preferences, except the owner's free text (`profile.about`) and the app's
/// `internal.*` bookkeeping, which are marked `[omitted]`. Secret-shaped keys
/// are replaced and secret-shaped values redacted.
pub fn scrub_settings(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, entry) in map {
                if is_secret_key(key) {
                    out.insert(key.clone(), json!("[redacted]"));
                } else if is_withheld_setting(key) {
                    out.insert(key.clone(), json!("[omitted]"));
                } else {
                    out.insert(key.clone(), scrub_settings(entry));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(scrub_settings).collect()),
        Value::String(text) => Value::String(redact(text)),
        other => other.clone(),
    }
}

// ---------------------------------------------------------------------------
// The rolling log

/// Start the daemon's rolling log file. Returns the worker guard, which the
/// caller must keep alive for the process lifetime (dropping it stops the
/// writer thread). `None` means logging stays off (the folder could not be
/// created), never a fatal error.
pub fn init_logging(data_dir: &Path, level: &str) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    let dir = log_dir(data_dir);
    fs::create_dir_all(&dir).ok()?;
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("daemon")
        .filename_suffix("log")
        .max_log_files(MAX_LOG_FILES)
        .build(&dir)
        .ok()?;
    prune_logs(&dir);
    let (writer, guard) = tracing_appender::non_blocking(RedactingWriter::new(appender));
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(log_directive(level)));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(writer)
        .try_init()
        .ok()?;
    Some(guard)
}

/// The log files newest first, as `(file name, bytes)`.
fn log_files(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_log = name.ends_with(".log") && (name.starts_with("daemon.") || name.starts_with("desktop."));
        if !is_log || !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            continue;
        }
        files.push(name);
    }
    // The date and time in the name sort newest first.
    files.sort_by(|a, b| b.cmp(a));
    files.truncate(MAX_LOG_FILES * 2);
    let mut out = Vec::new();
    for name in files {
        let Ok(bytes) = fs::read(dir.join(&name)) else { continue };
        let bytes = tail(&bytes, MAX_LOG_TAIL_BYTES);
        out.push((name, bytes));
    }
    out
}

fn tail(bytes: &[u8], limit: usize) -> Vec<u8> {
    if bytes.len() <= limit {
        return bytes.to_vec();
    }
    let start = bytes.len() - limit;
    // Do not start mid-line: drop up to the first newline.
    match bytes[start..].iter().position(|byte| *byte == b'\n') {
        Some(offset) if offset + 1 < limit => bytes[start + offset + 1..].to_vec(),
        _ => bytes[start..].to_vec(),
    }
}

/// Delete the oldest log files until the folder is back under the cap. The
/// newest file is always kept, even if it alone is larger.
pub fn prune_logs(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<(String, u64)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".log") || !(name.starts_with("daemon.") || name.starts_with("desktop.")) {
            continue;
        }
        if let Ok(metadata) = entry.metadata() {
            if metadata.is_file() {
                files.push((name, metadata.len()));
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let mut total: u64 = files.iter().map(|(_, size)| *size).sum();
    for (name, size) in files.iter().skip(1) {
        if total <= MAX_LOG_BYTES {
            break;
        }
        if fs::remove_file(dir.join(name)).is_ok() {
            total = total.saturating_sub(*size);
        }
    }
}

// ---------------------------------------------------------------------------
// The export

struct Entry {
    name: String,
    bytes: Vec<u8>,
}

fn data_dir_of(st: &AppState) -> Option<PathBuf> {
    st.team.data_dir.lock().ok().and_then(|dir| dir.clone())
}

/// The whole contents of the export, before zipping.
async fn collect(st: &AppState) -> Result<Vec<Entry>, DispatchError> {
    let mut entries = Vec::new();
    entries.push(Entry {
        name: "README.txt".to_string(),
        bytes: readme().into_bytes(),
    });
    entries.push(Entry {
        name: "environment.json".to_string(),
        bytes: pretty(&environment(st).await),
    });
    entries.push(Entry {
        name: "settings.json".to_string(),
        bytes: pretty(&settings_document(st)),
    });
    entries.push(Entry {
        name: "events.json".to_string(),
        bytes: pretty(&events_document(st)?),
    });
    if let Some(dir) = data_dir_of(st) {
        for (name, bytes) in log_files(&log_dir(&dir)) {
            // Belt and braces: an old file written before the filter existed is
            // still scrubbed on its way into the zip.
            let text = String::from_utf8_lossy(&bytes).into_owned();
            entries.push(Entry {
                name: format!("logs/{name}"),
                bytes: redact(&text).into_bytes(),
            });
        }
    }
    Ok(entries)
}

fn pretty(value: &Value) -> Vec<u8> {
    serde_json::to_vec_pretty(value).unwrap_or_else(|_| b"{}".to_vec())
}

fn readme() -> String {
    [
        "Bitbots diagnostics",
        "",
        "This file was written by Bitbots on this computer. Nothing in it was uploaded anywhere.",
        "",
        "README.txt        this note",
        "environment.json  the Bitbots version, the operating system and the coding agents found with their versions",
        "settings.json     your Bitbots settings with secrets removed",
        "events.json       the last app events with message text, command text and recap text removed",
        "logs/             the most recent daemon and desktop log lines",
        "",
        "Privacy: the logs and this export never contain message or prompt text, recap text, command text,",
        "file contents, credentials, tokens, environment values, Tailscale status JSON or Remote cookies.",
        "Ids, error classes, provider names, versions, timings and exit codes are kept.",
    ]
    .join("\n")
}

async fn environment(st: &AppState) -> Value {
    let runtimes = st.runtimes.read().await;
    environment_document(&runtimes)
}

/// The provider facts the export may carry: name, version and status. Who is
/// signed in — an email, on Phase 5's `account` field — is never diagnostics
/// material, so it is not copied here.
fn environment_document(runtimes: &[Value]) -> Value {
    let agents: Vec<Value> = runtimes
        .iter()
        .map(|runtime| {
            json!({
                "provider": runtime["provider"].as_str().unwrap_or("unknown"),
                "name": runtime["displayName"].as_str().unwrap_or(""),
                "version": runtime["version"].as_str().unwrap_or("unknown"),
                "status": runtime["status"].as_str().unwrap_or("unknown"),
            })
        })
        .collect();
    json!({
        "app": "Bitbots",
        "appVersion": env!("CARGO_PKG_VERSION"),
        "protocolVersion": bloblex_protocol::PROTOCOL_VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "osVersion": os_version(),
        "generatedAt": timestamp(),
        "agents": agents,
    })
}

fn settings_document(st: &AppState) -> Value {
    let settings = st.db.settings().unwrap_or_else(|_| json!({}));
    scrub_settings(&settings)
}

fn events_document(st: &AppState) -> Result<Value, DispatchError> {
    let latest = st.db.latest_sequence().map_err(storage_error)?;
    let after = latest.saturating_sub(MAX_EVENTS as u64);
    let events = st.db.replay_events(after, MAX_EVENTS).map_err(storage_error)?;
    Ok(json!({
        "generatedAt": timestamp(),
        "count": events.len(),
        "events": scrub_events(&Value::Array(events)),
    }))
}

fn storage_error(error: bloblex_storage::StorageError) -> DispatchError {
    derr("internal", &format!("diagnostics could not read local records: {error}"), StatusCode::INTERNAL_SERVER_ERROR)
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The OS version, reduced to a numeric version like `10.0.26100`. Anything the
/// command prints beyond that is dropped.
pub(crate) fn os_version() -> String {
    #[cfg(target_os = "windows")]
    let output = std::process::Command::new("cmd").args(["/c", "ver"]).output();
    #[cfg(unix)]
    let output = std::process::Command::new("uname").arg("-r").output();
    #[cfg(not(any(unix, target_os = "windows")))]
    let output: Result<std::process::Output, std::io::Error> = Err(std::io::Error::other("unsupported platform"));
    let Ok(output) = output else { return "unknown".to_string() };
    numeric_version(&String::from_utf8_lossy(&output.stdout)).unwrap_or_else(|| "unknown".to_string())
}

/// The longest run of digits and dots in `text` that looks like a version.
fn numeric_version(text: &str) -> Option<String> {
    let mut best: Option<String> = None;
    let mut current = String::new();
    for character in text.chars().chain(std::iter::once(' ')) {
        if character.is_ascii_digit() || character == '.' {
            current.push(character);
        } else if !current.is_empty() {
            if current.contains('.') && current.len() >= 3 && best.as_ref().is_none_or(|b| b.len() < current.len()) {
                best = Some(current.clone());
            }
            current.clear();
        }
    }
    best
}

fn build_zip(entries: &[Entry]) -> Result<Vec<u8>, DispatchError> {
    let mut cursor = io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o600);
        for entry in entries {
            zip.start_file(entry.name.clone(), options)
                .map_err(|error| zip_error(&error))?;
            zip.write_all(&entry.bytes)
                .map_err(|error| derr("internal", &format!("the diagnostics zip could not be written: {error}"), StatusCode::INTERNAL_SERVER_ERROR))?;
        }
        zip.finish().map_err(|error| zip_error(&error))?;
    }
    Ok(cursor.into_inner())
}

fn zip_error(error: &zip::result::ZipError) -> DispatchError {
    derr("internal", &format!("the diagnostics zip could not be written: {error}"), StatusCode::INTERNAL_SERVER_ERROR)
}

fn file_list(entries: &[Entry]) -> Value {
    Value::Array(
        entries
            .iter()
            .map(|entry| json!({ "name": entry.name, "sizeBytes": entry.bytes.len() }))
            .collect(),
    )
}

fn zip_name() -> String {
    format!("bitbots-diagnostics-{}.zip", Utc::now().format("%Y-%m-%d"))
}

/// `diagnostics.preview` and `diagnostics.export`.
pub async fn rpc(st: &AppState, method: &str, params: &Value) -> Result<Value, DispatchError> {
    match method {
        "diagnostics.issueDraft" => crate::issue_report::draft(st).await,
        "diagnostics.issuePost" => crate::issue_report::post(st, params).await,
        "diagnostics.preview" => {
            let entries = collect(st).await?;
            Ok(json!({
                "generatedAt": timestamp(),
                "fileName": zip_name(),
                "files": file_list(&entries),
            }))
        }
        "diagnostics.export" => {
            let entries = collect(st).await?;
            let total: usize = entries.iter().map(|entry| entry.bytes.len()).sum();
            let zip = build_zip(&entries)?;
            use base64::Engine as _;
            Ok(json!({
                "fileName": zip_name(),
                "sizeBytes": zip.len(),
                "uncompressedBytes": total,
                "files": file_list(&entries),
                "base64": base64::engine::general_purpose::STANDARD.encode(&zip),
            }))
        }
        _ => Err(derr("unsupported", "unknown diagnostics method", StatusCode::NOT_FOUND)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_removes_tokens_and_credentials_but_keeps_ids() {
        let line = "request failed session=abc-123 token=0631d4ce Capability: \"deadbeef\" bearer eyJhbGciOiJIUzI1NiIs password: hunter2 sk-ant-abcdefghijklmnop x-api-key=AKIA1234567890 \
                    $argon2id$v=19$m=19456,t=2,p=1$c2FsdA$hashvalue bloblex_remote=2f5d1c67 code=401 took=120ms";
        let out = redact(line);
        for secret in ["0631d4ce", "deadbeef", "eyJhbGciOiJIUzI1NiIs", "hunter2", "sk-ant-abcdefghijklmnop", "AKIA1234567890", "c2FsdA$hashvalue", "2f5d1c67"] {
            assert!(!out.contains(secret), "redaction left {secret} in {out}");
        }
        assert!(out.contains("session=abc-123"), "non-secret ids survive: {out}");
        assert!(out.contains("code=401"), "error classes survive: {out}");
        assert!(out.contains("took=120ms"), "timings survive: {out}");
    }

    /// F3: a JSON body with a quoted key must be redacted too, not just
    /// `token=value`. This is the shape a formatted error or a `Debug` struct
    /// produces.
    #[test]
    fn redaction_removes_json_shaped_secrets() {
        let line = r#"response {"token":"jsonTokenValue","password": "hunter2","cookie":"sessionCookieValue","api_key":"keyValue1234"}"#;
        let out = redact(line);
        for secret in ["jsonTokenValue", "hunter2", "sessionCookieValue", "keyValue1234"] {
            assert!(!out.contains(secret), "redaction left {secret} in {out}");
        }
    }

    /// F4: usage counters and commit hashes are not secrets; real credentials
    /// still are.
    #[test]
    fn token_counters_and_commit_hashes_survive_redaction() {
        for safe in ["inputTokens", "outputTokens", "contextTokens", "input_tokens", "tokenCount", "tokensUsed", "commitHash", "hash", "sessionId", "provider"] {
            if safe == "hash" {
                continue; // a bare `hash` is a password hash field: kept secret
            }
            assert!(!is_secret_key(safe), "{safe} must not be treated as a secret");
        }
        for secret in ["token", "accessToken", "refresh_token", "idToken", "authToken", "bearerToken", "tokenHash", "hash", "secret", "password", "apiKey", "capability", "authorization", "cookie"] {
            assert!(is_secret_key(secret), "{secret} must be treated as a secret");
        }
        let event = json!({"inputTokens": 120, "outputTokens": 40, "contextTokens": 90, "accessToken": "SECRETACCESS", "commitHash": "abc123def456"});
        let out = scrub_events(&event).to_string();
        assert!(out.contains("120") && out.contains("40") && out.contains("90"), "usage counters survive: {out}");
        assert!(!out.contains("SECRETACCESS"), "{out}");
        assert!(!out.contains("abc123def456"), "a commit hash is not a secret but is also not allowlisted: {out}");
    }

    /// Phase 5: an email is not diagnostics material. The export's environment
    /// document lists only each provider's name, version and status, and the
    /// event copy drops everything outside its allowlist, so the account on a
    /// runtime row reaches neither file.
    #[test]
    fn the_account_stays_out_of_a_diagnostics_bundle() {
        let runtimes = vec![json!({
            "id": "rt_claude_1",
            "provider": "claude",
            "displayName": "Claude Code",
            "version": "2.1.314",
            "status": "online",
            "authState": "authenticated",
            "account": {"label": "owner@example.com", "plan": "pro", "source": "claude auth status"},
        })];
        let out = environment_document(&runtimes).to_string();
        assert!(!out.contains("owner@example.com"), "the sign-in label must not be exported: {out}");
        assert!(!out.contains('@'), "{out}");
        assert!(!out.contains("claude auth status"), "the source names a command, not diagnostics material: {out}");
        assert!(out.contains("2.1.314"), "the version is diagnostics material: {out}");
        let event = json!({"type": "runtime.changed", "payload": {"runtimes": runtimes}});
        let scrubbed = scrub_events(&event).to_string();
        assert!(!scrubbed.contains("owner@example.com"), "an event copy must not carry the account: {scrubbed}");
        assert!(!scrubbed.contains('@'), "{scrubbed}");
    }

    #[test]
    fn the_log_directive_does_not_enable_dependencies_debug() {
        assert_eq!(log_directive("info"), "info");
        // The daemon's crate target is the `[[bin]]` name, not the package name.
        assert_eq!(log_directive("debug"), "bitbotsd=debug,info");
        assert!(!log_directive("debug").split(',').any(|part| part.trim() == "debug"), "a bare `debug` would turn on every dependency");
    }

    /// F6 (follow-up): the directive must actually reach the daemon's own
    /// target. `bloblex_daemon=debug,info` matched nothing — tracing derives the
    /// target from the `[[bin]]` name `bitbotsd` — so debug silently behaved
    /// like info. This builds a real `EnvFilter` from the directive and asks it
    /// about both the daemon target and a dependency target.
    #[test]
    fn the_debug_directive_enables_the_daemon_target_but_no_dependency() {
        use tracing::callsite::Callsite;
        use tracing::field::FieldSet;
        use tracing::metadata::{Kind, Metadata};
        use tracing::subscriber::Interest;
        use tracing::Level;
        use tracing_subscriber::layer::Layer;

        struct NoCallsite;
        impl Callsite for NoCallsite {
            fn set_interest(&self, _: Interest) {}
            fn metadata(&self) -> &Metadata<'_> {
                unimplemented!("only used to build static test metadata")
            }
        }
        static CALLSITE: NoCallsite = NoCallsite;

        static BITBOTSD_DEBUG: Metadata<'static> = Metadata::new(
            "bitbotsd_debug",
            "bitbotsd",
            Level::DEBUG,
            None,
            None,
            None,
            FieldSet::new(&[], tracing::callsite::Identifier(&CALLSITE)),
            Kind::EVENT,
        );
        static HYPER_DEBUG: Metadata<'static> = Metadata::new(
            "hyper_debug",
            "hyper",
            Level::DEBUG,
            None,
            None,
            None,
            FieldSet::new(&[], tracing::callsite::Identifier(&CALLSITE)),
            Kind::EVENT,
        );

        let filter = tracing_subscriber::EnvFilter::new(log_directive("debug"));
        let daemon = <tracing_subscriber::EnvFilter as Layer<tracing_subscriber::Registry>>::register_callsite(&filter, &BITBOTSD_DEBUG);
        let dependency = <tracing_subscriber::EnvFilter as Layer<tracing_subscriber::Registry>>::register_callsite(&filter, &HYPER_DEBUG);
        assert!(daemon.is_always(), "the daemon's own debug logs must be enabled: {daemon:?}");
        assert!(dependency.is_never(), "a dependency's debug output must stay off: {dependency:?}");

        let info_filter = tracing_subscriber::EnvFilter::new(log_directive("info"));
        let daemon_at_info = <tracing_subscriber::EnvFilter as Layer<tracing_subscriber::Registry>>::register_callsite(&info_filter, &BITBOTSD_DEBUG);
        assert!(daemon_at_info.is_never(), "the default level must stay at info: {daemon_at_info:?}");
    }

    #[test]
    fn the_redacting_writer_never_writes_a_secret_to_the_file() {
        let path = std::env::temp_dir().join(format!("bloblex-log-{}.log", uuid::Uuid::new_v4()));
        {
            let file = std::fs::File::create(&path).unwrap();
            let mut writer = RedactingWriter::new(file);
            writer
                .write_all(b"warn provider turn failed token=feedface password: swordfish\n")
                .unwrap();
            writer.flush().unwrap();
        }
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(!written.contains("feedface"), "{written}");
        assert!(!written.contains("swordfish"), "{written}");
        assert!(written.contains("warn provider turn failed"), "{written}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn scrubbing_removes_message_command_and_recap_text() {
        let event = json!({
            "type": "turn.completed",
            "payload": {
                "sessionId": "s-1",
                "text": "PRIVATE MESSAGE",
                "delta": "PRIVATE DELTA",
                "thinking": "PRIVATE THINKING",
                "prompt": "PRIVATE PROMPT",
                "command": "PRIVATE COMMAND",
                "output": "PRIVATE OUTPUT",
                "recap": "PRIVATE RECAP",
                "failureMessage": "PRIVATE FAILURE",
                "token": "PRIVATE TOKEN",
                "exitCode": 1,
                "provider": "codex"
            }
        });
        let out = scrub_events(&event).to_string();
        for secret in ["PRIVATE MESSAGE", "PRIVATE DELTA", "PRIVATE THINKING", "PRIVATE PROMPT", "PRIVATE COMMAND", "PRIVATE OUTPUT", "PRIVATE RECAP", "PRIVATE FAILURE", "PRIVATE TOKEN"] {
            assert!(!out.contains(secret), "scrub left {secret} in {out}");
        }
        assert!(out.contains("turn.completed"));
        assert!(out.contains("s-1"));
        assert!(out.contains("exitCode"));
    }

    #[test]
    fn scrubbing_settings_keeps_preferences_and_removes_secrets() {
        let settings = json!({
            "appearance.style": "bitbots",
            "remote.native.account": { "username": "owner", "hash": "$argon2id$v=19$m=1$salt$digest" },
            "notifications.enabled": true,
            "profile.about": "PRIVATE OWNER ABOUT TEXT",
            "internal.delete.workspaces.s-9": { "deadline": 8000 },
            "internal.backup.lastRunAt": "2026-10-18"
        });
        let out = scrub_settings(&settings);
        assert_eq!(out["appearance.style"], json!("bitbots"));
        assert_eq!(out["notifications.enabled"], json!(true));
        assert_eq!(out["remote.native.account"]["hash"], json!("[redacted]"));
        // A conscious choice: the account username is kept (it is only a label,
        // not a secret, and it says which account is configured).
        assert_eq!(out["remote.native.account"]["username"], json!("owner"));
        assert_eq!(out["profile.about"], json!("[omitted]"), "the owner's own free text must not travel");
        assert_eq!(out["internal.delete.workspaces.s-9"], json!("[omitted]"));
        assert_eq!(out["internal.backup.lastRunAt"], json!("[omitted]"));
        assert!(!out.to_string().contains("PRIVATE OWNER ABOUT TEXT"), "{out}");
    }

    /// F1: the real `permission.requested` question payload must not travel.
    #[test]
    fn a_question_event_loses_its_text() {
        let event = json!({
            "v": 1, "eventId": "e-1", "sequence": 42, "timestamp": "2026-10-18T20:00:00Z",
            "type": "permission.requested",
            "payload": {
                "id": "perm-1", "sessionId": "s-2", "runtimeId": "rt-1",
                "kind": "question", "category": "question", "risk": "none", "status": "pending",
                "title": "PRIVATE QUESTION TITLE",
                "detail": "PRIVATE QUESTION DETAIL",
                "questions": [
                    { "question": "PRIVATE QUESTION TEXT", "header": "PRIVATE HEADER",
                      "options": [
                        { "label": "PRIVATE OPTION LABEL", "description": "PRIVATE OPTION DESCRIPTION" },
                        { "label": "PRIVATE SECOND LABEL", "description": "PRIVATE SECOND DESCRIPTION" }
                      ] }
                ]
            }
        });
        let out = scrub_events(&event).to_string();
        for private in [
            "PRIVATE QUESTION TITLE", "PRIVATE QUESTION DETAIL", "PRIVATE QUESTION TEXT",
            "PRIVATE HEADER", "PRIVATE OPTION LABEL", "PRIVATE OPTION DESCRIPTION",
            "PRIVATE SECOND LABEL", "PRIVATE SECOND DESCRIPTION",
        ] {
            assert!(!out.contains(private), "the question text leaked ({private}): {out}");
        }
        assert!(out.contains("permission.requested"));
        assert!(out.contains("perm-1"));
        assert!(out.contains("s-2"));
        assert!(out.contains("\"kind\":\"question\""), "{out}");
    }

    #[test]
    fn the_oldest_log_files_are_deleted_first() {
        let dir = std::env::temp_dir().join(format!("bloblex-logs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Three files of 12 MB each: the oldest two must go to get under 20 MB.
        for day in ["2026-10-15", "2026-10-16", "2026-10-17"] {
            std::fs::write(dir.join(format!("daemon.{day}.log")), vec![b'x'; 12 * 1024 * 1024]).unwrap();
        }
        prune_logs(&dir);
        let remaining: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        assert!(remaining.contains(&"daemon.2026-10-17.log".to_string()));
        assert!(!remaining.contains(&"daemon.2026-10-15.log".to_string()), "{remaining:?}");
        let total: u64 = remaining.iter().map(|name| std::fs::metadata(dir.join(name)).unwrap().len()).sum();
        assert!(total <= MAX_LOG_BYTES, "the folder is back under the cap: {total}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_version_shaped_os_output_is_kept() {
        assert_eq!(numeric_version("Microsoft Windows [Version 10.0.26100.4061]"), Some("10.0.26100.4061".to_string()));
        assert_eq!(numeric_version("6.8.0-45-generic"), Some("6.8.0".to_string()));
        assert_eq!(numeric_version("no version here"), None);
    }
}
