use bloblex_protocol::{AuthState, ProtocolFamily};
use bloblex_process::{prepare_command, ProcessTree};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
pub mod providers;
pub use providers::{acp_launch_args, acp_provider, discovery_ids, is_acp_provider, AcpProvider, ACP_PROVIDERS};
use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    time::{timeout, Duration},
};

/// Sign-in probe budget for Claude and Codex.
const SIGN_IN_TIMEOUT_SECS: u64 = 5;
/// OpenCode 2 answers commands through a background service, so a cold
/// `auth list` can take several seconds. The whole OpenCode sign-in phase gets
/// 15 s, and each probe in it may use the full budget: the first probe can
/// answer with 15 s while the phase as a whole still fits the 31 s discovery
/// budget alongside the 6 s version and protocol probes.
const OPENCODE_SIGN_IN_TIMEOUT_SECS: u64 = 15;
/// Upper bound for a credential file read, matching the daemon's quota reader.
const MAX_CREDENTIAL_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRuntime {
    pub id: String,
    pub host_id: String,
    pub provider: String,
    pub display_name: String,
    pub protocol_family: ProtocolFamily,
    pub executable_path: String,
    pub launch_args: Vec<String>,
    pub version: Option<String>,
    pub auth_state: AuthState,
    pub gateway_auth_states: BTreeMap<String, AuthState>,
    pub status: String,
    pub capabilities: BTreeMap<String, bool>,
    #[serde(default)]
    pub probe_error: Option<String>,
    #[serde(default)]
    pub probe_step: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedCommand {
    pub executable: PathBuf,
    pub args: Vec<String>,
}

fn executable_extensions() -> Vec<&'static str> {
    #[cfg(windows)]
    {
        vec![".exe", ".com", ".cmd", ".bat", ""]
    }
    #[cfg(not(windows))]
    {
        vec![""]
    }
}

pub fn resolve_command(name: &str) -> Option<ResolvedCommand> {
    let paths = env::var_os("PATH")?;
    for dir in env::split_paths(&paths) {
        for ext in executable_extensions() {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                if candidate
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("cmd"))
                {
                    if let Some(r) = resolve_npm_cmd(&candidate) {
                        return Some(r);
                    }
                }
                return Some(ResolvedCommand {
                    executable: candidate,
                    args: vec![],
                });
            }
        }
    }
    None
}

fn resolve_npm_cmd(path: &Path) -> Option<ResolvedCommand> {
    let text = std::fs::read_to_string(path).ok()?;
    let base = path.parent()?;
    resolve_npm_shim_content(&text, base)
}
fn resolve_npm_shim_content(text: &str, base: &Path) -> Option<ResolvedCommand> {
    for line in text.lines() {
        let expanded = expand_shim_vars(line, base);
        let tokens = quoted_tokens(&expanded);
        let exe = tokens
            .iter()
            .find(|a| a.to_ascii_lowercase().ends_with(".exe"))
            .map(PathBuf::from);
        if let Some(exe) = exe.as_ref().filter(|p| p.is_file()) {
            if !exe
                .file_name()
                .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("node.exe"))
            {
                return Some(ResolvedCommand {
                    executable: exe.clone(),
                    args: vec![],
                });
            }
        }
        let script = tokens
            .iter()
            .find(|a| {
                let l = a.to_ascii_lowercase();
                l.ends_with(".js") || l.ends_with(".cjs")
            })
            .map(PathBuf::from);
        if let Some(script) = script.as_ref().filter(|p| p.is_file()) {
            let node = exe
                .filter(|p| {
                    p.file_name()
                        .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("node.exe"))
                })
                .or_else(|| {
                    let sibling = base.join("node.exe");
                    sibling.is_file().then_some(sibling)
                })
                .or_else(|| resolve_command("node").map(|n| n.executable));
            if let Some(node) = node {
                return Some(ResolvedCommand {
                    executable: node,
                    args: vec![script.to_string_lossy().into_owned()],
                });
            }
        }
    }
    None
}
fn expand_shim_vars(input: &str, base: &Path) -> String {
    input
        .replace("%~dp0%", &base.display().to_string())
        .replace("%~dp0", &base.display().to_string())
        .replace("%dp0%", &base.display().to_string())
}
fn quoted_tokens(input: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    for ch in input.chars() {
        if ch == '"' {
            in_quote = !in_quote;
            if !in_quote && !current.is_empty() {
                result.push(std::mem::take(&mut current));
            }
        } else if ch.is_whitespace() && !in_quote {
            if !current.is_empty() {
                result.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch)
        }
    }
    if !current.is_empty() {
        result.push(current)
    }
    result
}

// All diagnostics are fixed text; provider stdout/stderr never becomes an error.
async fn bounded_output(exe: &Path, args: &[&str]) -> Result<String, &'static str> {
    let mut cmd = Command::new(exe);
    prepare_command(&mut cmd);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|_| "Could not start the coding agent.")?;
    let process_tree = ProcessTree::attach(&mut child).map_err(|_| "Could not supervise the coding agent.")?;
    let stdout = child.stdout.take().ok_or("Could not read the probe result.")?;
    let stderr = child.stderr.take().ok_or("Could not read the probe result.")?;
    let result = timeout(Duration::from_secs(6), async {
        tokio::try_join!(child.wait(), read_probe_stream(stdout), read_probe_stream(stderr))
    }).await;
    let _ = process_tree.terminate();
    let (status, stdout, stderr) = result.map_err(|_| "Probe timed out.")?.map_err(|_| "Could not read the probe result.")?;
    if !status.success() { return Err("Probe exited unsuccessfully."); }
    // Successful help may be printed to stderr by a Windows npm shim. Inspect
    // both bounded streams, but only after validating the exit status. Callers
    // use fixed protocol tokens or a sanitized version and never persist this.
    let mut text = String::from_utf8_lossy(&stdout).into_owned();
    if text.len() < 32 * 1024 {
        text.push_str(&String::from_utf8_lossy(&stderr));
    }
    Ok(text.chars().take(32 * 1024).collect())
}

/// Retain only the first 32 KiB while draining the rest to keep child pipes
/// flowing without allowing arbitrary CLI output to grow memory without bound.
async fn read_probe_stream(mut stream: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut retained = Vec::with_capacity(4 * 1024);
    let mut chunk = [0u8; 4 * 1024];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 { break; }
        let keep = (32 * 1024usize).saturating_sub(retained.len()).min(read);
        retained.extend_from_slice(&chunk[..keep]);
    }
    Ok(retained)
}

pub async fn discover() -> Vec<DiscoveredRuntime> {
    // Resolve away from the async executor; PATH may include slow network drives.
    let specs = tokio::task::spawn_blocking(|| discovery_ids().map(|id| (id, resolve_command(id)))).await;
    let Ok([claude, codex, opencode, gemini, qwen]) = specs else { return Vec::new(); };
    // The OpenCode stored-credential check is CLI-free and only ever reads
    // these four variables; tests pass a synthetic set instead.
    let environment = opencode_environment();
    let (a, b, c, d, e) = tokio::join!(
        discover_one(claude.0, claude.1, &environment),
        discover_one(codex.0, codex.1, &environment),
        discover_one(opencode.0, opencode.1, &environment),
        discover_one(gemini.0, gemini.1, &environment),
        discover_one(qwen.0, qwen.1, &environment)
    );
    [a, b, c, d, e].into_iter().flatten().collect()
}

#[cfg(test)]
async fn collect_discovery(a: impl std::future::Future<Output = Option<DiscoveredRuntime>>, b: impl std::future::Future<Output = Option<DiscoveredRuntime>>, c: impl std::future::Future<Output = Option<DiscoveredRuntime>>) -> Vec<DiscoveredRuntime> {
    let (a, b, c) = tokio::join!(a, b, c);
    [a, b, c].into_iter().flatten().collect()
}

fn safe_version(output: &str) -> Option<String> {
    // CLI version labels only; an unexpected response is never forwarded.
    let line = output.lines().next()?.trim();
    if line.len() > 100 || !line.chars().all(|c| c.is_ascii_alphanumeric() || " .()-_+".contains(c)) { return None; }
    // OpenCode 2 prints `opencode v2.0.28`; the `v` is a label, not part of the number.
    let version = line.split_whitespace().map(|part| part.strip_prefix('v').unwrap_or(part)).find(|part| part.chars().next().is_some_and(|c| c.is_ascii_digit()) && part.contains('.'))?;
    if !version.chars().all(|c| c.is_ascii_digit() || c == '.') { return None; }
    Some(version.to_owned())
}

async fn discover_one(id: &str, resolved: Option<ResolvedCommand>, environment: &[(String, String)]) -> Option<DiscoveredRuntime> {
    let resolved = resolved?;
    let mut runtime = DiscoveredRuntime {
        id: format!("rt_{id}_{}", short_hash(&resolved.executable.to_string_lossy())),
        host_id: "host_windows_local".into(), provider: id.into(), display_name: provider_display_name(id).into(),
        protocol_family: match id { "codex" => ProtocolFamily::CodexAppServer, p if is_acp_provider(p) => ProtocolFamily::Acp, _ => ProtocolFamily::ClaudeStream },
        executable_path: resolved.executable.to_string_lossy().into_owned(), launch_args: resolved.args.clone(),
        version: None, auth_state: AuthState::Unknown, gateway_auth_states: BTreeMap::new(),
        status: "error".into(), capabilities: BTreeMap::new(), probe_error: None, probe_step: None,
    };
    let mut version_args = resolved.args.iter().map(String::as_str).collect::<Vec<_>>();
    version_args.push("--version");
    match bounded_output(&resolved.executable, &version_args).await {
        Ok(output) => runtime.version = safe_version(&output),
        Err(error) => { runtime.probe_step = Some("Version check".into()); runtime.probe_error = Some(error.into()); }
    }
    let mut probe_args = resolved.args.iter().map(String::as_str).collect::<Vec<_>>();
    match id { "opencode" => probe_args.extend(["acp", "--help"]), "codex" => probe_args.extend(["app-server", "--help"]), _ => probe_args.push("--help") }
    let help = bounded_output(&resolved.executable, &probe_args).await;
    let supported = help.as_ref().is_ok_and(|help| match id {
        "opencode" => help.contains("ACP") || help.contains("acp"),
        "codex" => help.contains("app-server"),
        // A table provider proves itself by advertising the flag it is launched
        // with (`--acp`); that is the check the installed CLI can answer.
        p if is_acp_provider(p) => help.contains("acp") || help.contains("ACP"),
        _ => help.contains("--input-format") && help.contains("stream-json"),
    });
    if !supported {
        runtime.probe_step = Some("Protocol check".into());
        runtime.probe_error = Some(help.err().unwrap_or("The CLI does not advertise the required protocol.").into());
        // Failed probes are retained and retried, never negatively cached.
        return Some(runtime);
    }
    runtime.status = "online".into();
    let (auth_state, gateway_auth_states, auth_error) = auth_status(id, &resolved.executable, &resolved.args, environment).await;
    runtime.auth_state = auth_state;
    runtime.gateway_auth_states = gateway_auth_states;
    if let Some(error) = auth_error {
        runtime.probe_step = Some("Sign-in check".into());
        runtime.probe_error = Some(error.into());
    }
    for key in ["newSession", "resume", "cancel", "permissions", "usage", "files"] {
        // A table provider runs the same ACP adapter as OpenCode, so it has the
        // same honest capabilities: sessions, turns, tools, approvals and the
        // models `session/new` reports. No resume, no usage.
        let supported = match key {
            "newSession" | "cancel" => true,
            "resume" | "usage" => matches!(id, "claude" | "codex"),
            "permissions" => id == "codex" || is_acp_provider(id),
            _ => false,
        };
        runtime.capabilities.insert(key.into(), supported);
    }
    Some(runtime)
}
pub fn provider_display_name(provider: &str) -> &'static str {
    if let Some(row) = acp_provider(provider) { return row.display_name; }
    match provider { "claude" => "Claude Code", "codex" => "Codex", "opencode" => "OpenCode", _ => "Coding agent" }
}
async fn auth_status(provider: &str, exe: &Path, args: &[String], environment: &[(String, String)]) -> (AuthState, BTreeMap<String, AuthState>, Option<&'static str>) {
    if provider == "opencode" {
        return opencode_auth_status(exe, args, environment).await;
    }
    let mut av = args.iter().map(String::as_str).collect::<Vec<_>>();
    match provider {
        "claude" => av.extend(["auth", "status"]),
        "codex" => av.extend(["login", "status"]),
        _ => return (AuthState::Unknown, BTreeMap::new(), None),
    };
    let out = match safe_status_output(exe, &av).await { Ok((_, text)) => text, Err(error) => return (AuthState::Unknown, BTreeMap::new(), Some(error)) };
    if provider == "claude" {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) {
            return (match v["loggedIn"].as_bool() {
                Some(true) => AuthState::Authenticated,
                Some(false) => AuthState::Unauthenticated,
                None => AuthState::Unknown,
            }, BTreeMap::new(), None);
        }
    }
    let l = out.to_ascii_lowercase();
    if l.contains("not logged in") || l.contains("not authenticated") {
        (AuthState::Unauthenticated, BTreeMap::new(), None)
    } else if l.contains("logged in using") || l.contains("logged in") {
        (AuthState::Authenticated, BTreeMap::new(), None)
    } else {
        (AuthState::Unknown, BTreeMap::new(), None)
    }
}
/// OpenCode sign-in. A CLI-free stored-credential check runs first and is the
/// source of truth for "a credential is stored"; only when it finds nothing
/// does the CLI get asked. OpenCode 2 answers through a background service, so
/// the whole phase is capped at 15 s.
async fn opencode_auth_status(exe: &Path, args: &[String], environment: &[(String, String)]) -> (AuthState, BTreeMap<String, AuthState>, Option<&'static str>) {
    // A stored credential proves a credential is stored, never that it is
    // valid; the label stays "signed in" as it does today for `stored`.
    if let Some(states) = opencode_stored_gateways(environment) {
        return (aggregate_auth_states(&states), states, None);
    }
    let limit = Duration::from_secs(OPENCODE_SIGN_IN_TIMEOUT_SECS);
    match timeout(limit, opencode_auth_status_from_cli(exe, args)).await {
        Ok(result) => result,
        Err(_) => (AuthState::Unknown, BTreeMap::new(), Some("Sign-in status could not be checked.")),
    }
}
async fn opencode_auth_status_from_cli(exe: &Path, args: &[String]) -> (AuthState, BTreeMap<String, AuthState>, Option<&'static str>) {
    let limit = Duration::from_secs(OPENCODE_SIGN_IN_TIMEOUT_SECS);
    let mut av = args.iter().map(String::as_str).collect::<Vec<_>>();
    av.extend(["auth", "list"]);
    if let Ok((true, output)) = safe_status_output_within(exe, &av, limit).await {
        if let Some(states) = parse_opencode_auth_list(&output) {
            return (aggregate_auth_states(&states), states, None);
        }
        // A successful `auth list` that printed integration rows we could
        // not classify is still evidence that the command ran; report the
        // unknown state quietly instead of a checked-and-failed probe. The
        // row text itself never leaves this function.
        if opencode_auth_list_has_recognized_rows(&output) {
            return (AuthState::Unknown, BTreeMap::new(), None);
        }
    }
    // v1 `models --verbose` still exposes gateway JSON. A non-zero exit
    // falls through to the plain v2 listing rather than ending the check.
    let mut verbose_args = args.iter().map(String::as_str).collect::<Vec<_>>();
    verbose_args.extend(["models", "--verbose"]);
    if let Ok((true, output)) = safe_status_output_within(exe, &verbose_args, limit).await {
        let states = opencode_model_gateways(&output);
        if !states.is_empty() {
            return (aggregate_auth_states(&states), states, None);
        }
    }
    // v2 `models` (no flags) prints one `provider/model` per line. A
    // listing proves the CLI runs, not that anyone is signed in (the
    // catalog lists gateway models whether or not a credential exists), so
    // it reports a quiet unknown rather than a checked-and-failed probe.
    let mut model_args = args.iter().map(String::as_str).collect::<Vec<_>>();
    model_args.push("models");
    if let Ok((true, output)) = safe_status_output_within(exe, &model_args, limit).await {
        if opencode_plain_model_listing_names_a_gateway(&output) {
            return (AuthState::Unknown, BTreeMap::new(), None);
        }
    }
    (AuthState::Unknown, BTreeMap::new(), Some("Sign-in status could not be checked."))
}
/// The four environment variables the OpenCode data-dir rules honour, in the
/// same shape the daemon's quota reader uses. Nothing else is read.
fn opencode_environment() -> Vec<(String, String)> {
    ["USERPROFILE", "HOME", "XDG_DATA_HOME", "OPENCODE_DB"]
        .into_iter()
        .filter_map(|name| env::var_os(name).map(|value| (name.to_owned(), value.to_string_lossy().into_owned())))
        .collect()
}
fn opencode_data_dir(environment: &[(String, String)]) -> Option<PathBuf> {
    let value = |key: &str| {
        environment
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };
    if let Some(path) = value("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path).join("opencode"));
    }
    value("USERPROFILE")
        .or_else(|| value("HOME"))
        .filter(|value| !value.is_empty())
        .map(|home| PathBuf::from(home).join(".local").join("share").join("opencode"))
}
fn opencode_db_paths(environment: &[(String, String)]) -> Vec<PathBuf> {
    let value = |key: &str| {
        environment
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };
    if let Some(path) = value("OPENCODE_DB").filter(|value| !value.is_empty()) {
        return vec![PathBuf::from(path)];
    }
    let Some(dir) = opencode_data_dir(environment) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("opencode") && name.ends_with(".db"))
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths.reverse();
    paths
}
/// OpenCode 1 stores credentials in `auth.json`. Only the presence of a
/// gateway entry is taken: the credential value is parsed as an ignored token
/// and never materialised, stored, returned or logged.
#[derive(Deserialize)]
struct OpenCodeAuthPresence {
    #[serde(rename = "opencode")]
    zen: Option<serde::de::IgnoredAny>,
    #[serde(rename = "opencode-go")]
    go: Option<serde::de::IgnoredAny>,
}
fn auth_file_gateways(path: &Path) -> Option<BTreeMap<String, AuthState>> {
    let metadata = std::fs::metadata(path).ok()?;
    if metadata.len() > MAX_CREDENTIAL_FILE_BYTES {
        return None;
    }
    let raw = std::fs::read(path).ok()?;
    let presence = serde_json::from_slice::<OpenCodeAuthPresence>(&raw).ok()?;
    let mut states = BTreeMap::new();
    if presence.zen.is_some() {
        states.insert("opencode".into(), AuthState::Authenticated);
    }
    if presence.go.is_some() {
        states.insert("opencode-go".into(), AuthState::Authenticated);
    }
    (!states.is_empty()).then_some(states)
}
/// OpenCode 2 stores credentials in `opencode*.db`. Opened read-only with
/// `query_only`, and only the `integration_id` column is selected: the `value`
/// column (the secret) is never touched.
fn credential_db_gateways(path: &Path) -> Option<BTreeMap<String, AuthState>> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.pragma_update(None, "query_only", "ON").ok()?;
    let mut statement = conn.prepare("SELECT integration_id FROM credential WHERE active=1").ok()?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0)).ok()?;
    let mut states = BTreeMap::new();
    for integration in rows.flatten() {
        // `safe_gateway_name` is the allow-list: only `opencode` and
        // `opencode-go` can be produced.
        if let Some(name) = safe_gateway_name(&integration) {
            states.insert(name, AuthState::Authenticated);
        }
    }
    (!states.is_empty()).then_some(states)
}
/// Fast, CLI-free "is a credential stored" check. Returns `None` when the
/// files or tables are missing or hold no matching row, so the caller falls
/// through to the CLI instead of claiming `Unauthenticated`.
fn opencode_stored_gateways(environment: &[(String, String)]) -> Option<BTreeMap<String, AuthState>> {
    let mut states = BTreeMap::new();
    if let Some(dir) = opencode_data_dir(environment) {
        if let Some(found) = auth_file_gateways(&dir.join("auth.json")) {
            states.extend(found);
        }
    }
    for path in opencode_db_paths(environment) {
        if let Some(found) = credential_db_gateways(&path) {
            states.extend(found);
        }
    }
    (!states.is_empty()).then_some(states)
}
fn safe_gateway_name(input: &str) -> Option<String> {
    match input.trim().trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_').to_ascii_lowercase().as_str() {
        "opencode" => Some("opencode".into()),
        "opencode-go" => Some("opencode-go".into()),
        _ => None,
    }
}
/// Map an OpenCode integration/display name onto an allow-listed gateway key.
/// v2 `auth list` prints human display names (`OpenCode Console`, `OpenCode Go`,
/// `OpenCode Zen`); v1 prints the gateway keys directly. `safe_gateway_name`
/// stays the allow-list, so no key outside it can be produced.
fn opencode_integration_key(raw_name: &str) -> Option<String> {
    match raw_name.trim().to_ascii_lowercase().as_str() {
        "opencode console" | "opencode zen" => return Some("opencode".into()),
        "opencode go" => return Some("opencode-go".into()),
        _ => {}
    }
    safe_gateway_name(raw_name)
}
/// Split an `auth list` row on `| : ,`, tab, and runs of two or more spaces.
/// v2 uses whitespace-aligned columns; a v1 single-space or separator row is
/// still handled by the word-based fallback in `parse_opencode_auth_list`.
fn split_opencode_auth_fields(line: &str) -> Vec<String> {
    let chars = line.chars().collect::<Vec<_>>();
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch == '|' || ch == ':' || ch == ',' || ch == '\t' {
            fields.push(std::mem::take(&mut current));
            index += 1;
        } else if ch == ' ' {
            let mut end = index;
            while end < chars.len() && chars[end] == ' ' { end += 1; }
            if end - index >= 2 { fields.push(std::mem::take(&mut current)); } else { current.push(' '); }
            index = end;
        } else {
            current.push(ch);
            index += 1;
        }
    }
    fields.push(current);
    fields.into_iter().map(|field| field.trim().to_owned()).filter(|field| !field.is_empty()).collect()
}
/// True when an `auth list` run printed at least one integration row we
/// recognise, even if its status cell was not classifiable. Used to report a
/// quiet unknown instead of a probe failure. Never returns row text.
fn opencode_auth_list_has_recognized_rows(output: &str) -> bool {
    output.lines().any(|line| {
        let fields = split_opencode_auth_fields(line);
        let name = if fields.len() >= 2 {
            Some(fields[0].as_str())
        } else {
            fields.first().and_then(|field| field.split_whitespace().next())
        };
        name.and_then(opencode_integration_key).is_some()
    })
}
fn parse_opencode_auth_list(output: &str) -> Option<BTreeMap<String, AuthState>> {
    let mut states = BTreeMap::new();
    for line in output.lines() {
        let fields = split_opencode_auth_fields(line);
        let (raw_name, status_fields): (String, Vec<String>) = if fields.len() >= 2 {
            (fields[0].clone(), fields[1..].to_vec())
        } else if let Some(single) = fields.first() {
            let words = single.split_whitespace().collect::<Vec<_>>();
            if words.len() < 2 { continue; }
            let tail = if words.len() >= 3 && matches!((words[1].to_ascii_lowercase().as_str(), words[2].to_ascii_lowercase().as_str()), ("logged", "in") | ("logged", "out") | ("signed", "in") | ("signed", "out") | ("not", "configured") | ("not", "authenticated") | ("not", "logged") | ("no", "credentials")) {
                if words[1].eq_ignore_ascii_case("not") && words[2].eq_ignore_ascii_case("logged") && words.get(3).is_some_and(|word| word.eq_ignore_ascii_case("in")) { words[1..4].join(" ") } else { words[1..3].join(" ") }
            } else { words[1].to_owned() };
            (words[0].to_owned(), vec![tail])
        } else {
            continue;
        };
        let Some(name) = opencode_integration_key(&raw_name) else { continue; };
        // Inspect only one status cell. A credential or other free-form value
        // after it is discarded, never copied into normalized runtime state.
        let state = status_fields.iter().find_map(|field| explicit_auth_state(field.as_str()));
        let Some(state) = state else { continue; };
        states.insert(name, state);
    }
    (!states.is_empty()).then_some(states)
}
fn explicit_auth_state(input: &str) -> Option<AuthState> {
    match input.trim().to_ascii_lowercase().as_str() {
        "configured" | "authenticated" | "connected" | "signed in" | "logged in" | "stored" | "true" | "yes" => Some(AuthState::Authenticated),
        "not configured" | "no credentials" | "unauthenticated" | "not authenticated" | "not logged in" | "signed out" | "logged out" | "missing" | "false" | "no" => Some(AuthState::Unauthenticated),
        _ => None,
    }
}
fn aggregate_auth_states(states: &BTreeMap<String, AuthState>) -> AuthState {
    if states.is_empty() { return AuthState::Unknown; }
    if states.values().any(|state| matches!(state, AuthState::Authenticated)) { AuthState::Authenticated }
    else if states.values().all(|state| matches!(state, AuthState::Unauthenticated)) { AuthState::Unauthenticated }
    else { AuthState::Unknown }
}
fn add_model_gateway(header: &str, body: &str, states: &mut BTreeMap<String, AuthState>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else { return; };
    let Some((provider, model_id)) = header.split_once('/') else { return; };
    if model_id.is_empty() { return; }
    let Some(name) = safe_gateway_name(provider) else { return; };
    if value.get("id").and_then(serde_json::Value::as_str) != Some(model_id) { return; }
    if value.get("providerID").and_then(serde_json::Value::as_str).and_then(safe_gateway_name).as_deref() != Some(name.as_str()) { return; }
    if value.is_object() { states.insert(name, AuthState::Authenticated); }
}
fn opencode_model_gateways(output: &str) -> BTreeMap<String, AuthState> {
    let mut states = BTreeMap::new();
    let lines = output.lines().collect::<Vec<_>>();
    let mut index = 0;
    while index < lines.len() {
        let header = lines[index].trim();
        if let Some((provider, model)) = header.split_once('/') {
            if !model.is_empty() && safe_gateway_name(provider).is_some() {
                let mut body = String::new();
                let mut depth = 0i32;
                let mut started = false;
                let mut in_string = false;
                let mut escape = false;
                let mut end = index + 1;
                for (offset, line) in lines.iter().enumerate().skip(index + 1) {
                    body.push_str(line);
                    body.push('\n');
                    for ch in line.chars() {
                        if in_string {
                            if escape { escape = false; }
                            else if ch == '\\' { escape = true; }
                            else if ch == '"' { in_string = false; }
                        } else if ch == '"' { in_string = true; }
                        else if ch == '{' { depth += 1; started = true; }
                        else if ch == '}' { depth -= 1; }
                    }
                    if started && depth == 0 { end = offset + 1; break; }
                }
                if started && depth == 0 {
                    add_model_gateway(header, &body, &mut states);
                    index = end;
                    continue;
                }
            }
        }
        index += 1;
    }
    if states.is_empty() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(output) {
            if let Some(models) = value.get("models").and_then(serde_json::Value::as_array) {
                for model in models {
                    let provider = model.get("providerID").and_then(serde_json::Value::as_str);
                    let id = model.get("id").and_then(serde_json::Value::as_str).unwrap_or("");
                    if !id.is_empty() { if let Some(name) = provider.and_then(safe_gateway_name) { states.insert(name, AuthState::Authenticated); } }
                }
            }
        }
    }
    states
}
/// v2 `opencode models` prints one `provider/model` per line. True when at least
/// one line names an allow-listed gateway. That shows the CLI answered, never
/// that anyone is signed in.
fn opencode_plain_model_listing_names_a_gateway(output: &str) -> bool {
    output.lines().any(|line| {
        line.trim().split_once('/').is_some_and(|(provider, model)| !model.is_empty() && safe_gateway_name(provider).is_some())
    })
}
async fn safe_status_output(exe: &Path, args: &[&str]) -> Result<(bool, String), &'static str> {
    safe_status_output_within(exe, args, Duration::from_secs(SIGN_IN_TIMEOUT_SECS)).await
}
async fn safe_status_output_within(exe: &Path, args: &[&str], limit: Duration) -> Result<(bool, String), &'static str> {
    let mut cmd = Command::new(exe);
    prepare_command(&mut cmd);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|_| "Could not start the sign-in check.")?;
    let process_tree = ProcessTree::attach(&mut child).map_err(|_| "Could not supervise the sign-in check.")?;
    let result = timeout(limit, child.wait_with_output()).await;
    let _ = process_tree.terminate();
    let out = result.map_err(|_| "Sign-in check timed out.")?.map_err(|_| "Could not read the sign-in result.")?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    if text.len() < 32 * 1024 && (args.ends_with(&["auth", "status"]) || args.ends_with(&["login", "status"])) {
        text.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    text = text.chars().take(32 * 1024).collect();
    Ok((out.status.success(), text))
}
fn short_hash(s: &str) -> String {
    let mut h = 2166136261u32;
    for b in s.to_lowercase().bytes() {
        h = (h ^ b as u32).wrapping_mul(16777619)
    }
    format!("{h:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    #[test]
    fn version_output_is_reduced_to_a_numeric_version() {
        assert_eq!(safe_version("codex-cli 0.161.0"), Some("0.161.0".into()));
        assert_eq!(safe_version("2.1.296 (Claude Code)"), Some("2.1.296".into()));
        assert_eq!(safe_version("opencode v2.0.28"), Some("2.0.28".into()));
        assert_eq!(safe_version("unexpected private diagnostic"), None);
        assert_eq!(safe_version("0.161.0\nprivate diagnostic"), Some("0.161.0".into()));
    }
    #[tokio::test]
    async fn discovery_polls_all_providers_concurrently() {
        let barrier = tokio::sync::Barrier::new(3);
        let probe = || async { barrier.wait().await; None };
        let result = tokio::time::timeout(Duration::from_secs(1), collect_discovery(probe(), probe(), probe())).await;
        assert!(result.is_ok(), "sequential probes cannot pass the three-provider barrier");
    }
    #[tokio::test]
    async fn probe_stream_retains_a_bounded_prefix_while_draining_the_child_pipe() {
        let (mut writer, reader) = tokio::io::duplex(64 * 1024);
        let writer_task = tokio::spawn(async move { writer.write_all(&vec![b'x'; 48 * 1024]).await.unwrap(); });
        let retained = read_probe_stream(reader).await.unwrap();
        writer_task.await.unwrap();
        assert_eq!(retained.len(), 32 * 1024);
    }
    fn fixture_command(success: bool) -> ResolvedCommand {
        #[cfg(windows)]
        { ResolvedCommand { executable: PathBuf::from("cmd.exe"), args: vec!["/d".into(), "/c".into(), if success { "echo 1.2.3 & echo app-server --input-format stream-json & echo logged in using fixture" } else { "echo PRIVATE_DIAGNOSTIC & exit /b 1" }.into()] } }
        #[cfg(not(windows))]
        { ResolvedCommand { executable: PathBuf::from("/bin/sh"), args: vec!["-c".into(), if success { "printf '1.2.3\napp-server --input-format stream-json\nlogged in using fixture\n'" } else { "printf 'PRIVATE_DIAGNOSTIC\n'; exit 1" }.into()] } }
    }
    #[tokio::test]
    async fn failed_probe_is_safe_visible_and_can_heal_on_the_same_executable() {
        let failed = discover_one("codex", Some(fixture_command(false)), &[]).await.unwrap();
        assert_eq!(failed.status, "error");
        assert_eq!(failed.probe_step.as_deref(), Some("Protocol check"));
        assert_eq!(failed.probe_error.as_deref(), Some("Probe exited unsuccessfully."));
        assert!(!failed.probe_error.as_deref().unwrap().contains("PRIVATE_DIAGNOSTIC"));
        assert!(failed.capabilities.is_empty());
        let healed = discover_one("codex", Some(fixture_command(true)), &[]).await.unwrap();
        assert_eq!(healed.id, failed.id);
        assert_eq!(healed.status, "online");
        assert!(healed.probe_error.is_none());
        assert_eq!(healed.version.as_deref(), Some("1.2.3"));
    }
    #[tokio::test]
    async fn opencode_successful_stderr_only_acp_help_passes_protocol_check() {
        #[cfg(windows)]
        let command = ResolvedCommand { executable: PathBuf::from("cmd.exe"), args: vec![
            "/d".into(), "/c".into(), "echo ACP stdio protocol 1>&2".into(),
        ] };
        #[cfg(not(windows))]
        let command = ResolvedCommand { executable: PathBuf::from("/bin/sh"), args: vec![
            "-c".into(), "printf 'Usage: opencode acp --help\\nACP stdio protocol\\n' >&2".into(),
        ] };
        let runtime = discover_one("opencode", Some(command), &[]).await.unwrap();
        assert_eq!(runtime.status, "online");
        assert!(runtime.probe_step.as_deref() != Some("Protocol check"), "stderr-only successful ACP help must pass protocol validation");
        assert_eq!(runtime.probe_step.as_deref(), Some("Sign-in check"));
        assert_eq!(runtime.probe_error.as_deref(), Some("Sign-in status could not be checked."));
    }
    #[tokio::test]
    async fn failed_protocol_probe_remains_sanitized() {
        #[cfg(windows)]
        let command = ResolvedCommand { executable: PathBuf::from("cmd.exe"), args: vec![
            "/d".into(), "/c".into(), "echo PRIVATE ACP diagnostic 1>&2 & exit /b 1".into(),
        ] };
        #[cfg(not(windows))]
        let command = ResolvedCommand { executable: PathBuf::from("/bin/sh"), args: vec![
            "-c".into(), "printf 'PRIVATE ACP diagnostic\\n' >&2; exit 1".into(),
        ] };
        let failed = discover_one("opencode", Some(command), &[]).await.unwrap();
        assert_eq!(failed.status, "error");
        assert_eq!(failed.probe_step.as_deref(), Some("Protocol check"));
        assert_eq!(failed.probe_error.as_deref(), Some("Probe exited unsuccessfully."));
        assert!(!failed.probe_error.as_deref().unwrap().contains("PRIVATE"));
    }
    #[tokio::test]
    async fn successful_but_unrelated_opencode_help_remains_unsupported() {
        #[cfg(windows)]
        let command = ResolvedCommand { executable: PathBuf::from("cmd.exe"), args: vec![
            "/d".into(), "/c".into(), "ver".into(),
        ] };
        #[cfg(not(windows))]
        let command = ResolvedCommand { executable: PathBuf::from("/bin/sh"), args: vec![
            "-c".into(), "printf 'generic command help\\n'".into(),
        ] };
        let unsupported = discover_one("opencode", Some(command), &[]).await.unwrap();
        assert_eq!(unsupported.status, "error");
        assert_eq!(unsupported.probe_step.as_deref(), Some("Protocol check"));
        assert_eq!(unsupported.probe_error.as_deref(), Some("The CLI does not advertise the required protocol."));
    }
    #[tokio::test]
    async fn missing_executable_reports_a_fixed_error() {
        let runtime = discover_one("codex", Some(ResolvedCommand { executable: PathBuf::from("bloblex-missing-probe-executable"), args: vec![] }), &[]).await.unwrap();
        assert_eq!(runtime.probe_error.as_deref(), Some("Could not start the coding agent."));
        assert!(matches!(runtime.auth_state, AuthState::Unknown));
    }
    #[test]
    fn npm_path_expansion_is_rooted_at_shim() {
        let base = PathBuf::from("C:/Users/me/AppData/Roaming/npm");
        let expanded = expand_shim_vars("%dp0%/node_modules/opencode.exe", &base);
        assert!(expanded.contains("C:/Users/me/AppData/Roaming/npm/node_modules/opencode.exe"));
        assert!(!expanded.contains("%dp0%"));
    }
    #[test]
    fn tokenizes_wrapper_args() {
        assert_eq!(
            quoted_tokens("\"C:/npm/node.exe\" \"C:/npm/tool.js\" %*"),
            vec!["C:/npm/node.exe", "C:/npm/tool.js", "%*"]
        );
    }
    #[test]
    fn hash_is_stable() {
        assert_eq!(short_hash("abc"), short_hash("abc"));
    }
    #[test]
    fn npm_wrapper_fixtures_resolve_native_exes_and_node_scripts() {
        let root = std::env::temp_dir().join(format!("bloblex-fixture-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for dir in [
            "node_modules/@anthropic-ai/claude-code/bin",
            "node_modules/opencode-ai/bin",
            "node_modules/@openai/codex/bin",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        for p in [
            root.join("node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
            root.join("node_modules/opencode-ai/bin/opencode.exe"),
            root.join("node.exe"),
            root.join("node_modules/@openai/codex/bin/codex.js"),
        ] {
            std::fs::write(p, b"fixture").unwrap();
        }
        for name in ["npm-claude.cmd", "npm-opencode.cmd", "npm-codex.cmd"] {
            let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs/fixtures")
                .join(name);
            let resolved =
                resolve_npm_shim_content(&std::fs::read_to_string(fixture).unwrap(), &root)
                    .unwrap();
            assert!(resolved.executable.is_file());
            assert!(!resolved.executable.to_string_lossy().ends_with(".cmd"));
            if name.contains("codex") {
                assert!(resolved.executable.ends_with("node.exe"));
                assert!(resolved.args[0].ends_with("codex.js"));
            } else {
                assert!(resolved.args.is_empty());
            }
        }
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn resolver_never_returns_a_powershell_script() {
        assert!(!executable_extensions().contains(&".ps1"));
    }
    #[test]
    fn opencode_auth_list_keeps_only_allowlisted_gateways_and_exact_state_bits() {
        let fake_cli_output = "opencode-go configured sk-fixture-NEVER-FORWARD-0123456789\nopencode signed in\nopencode-go unauthenticated\nopencode-go logged out\nsk-fixture-NEVER-FORWARD-0123456789 configured";
        let states = parse_opencode_auth_list(fake_cli_output).unwrap();
        assert!(matches!(states.get("opencode"), Some(AuthState::Authenticated)));
        assert!(matches!(states.get("opencode-go"), Some(AuthState::Unauthenticated)));
        assert_eq!(states.len(), 2);
        let forwarded = serde_json::to_string(&states).unwrap();
        assert!(!forwarded.contains("sk-fixture"));
        assert!(!forwarded.contains("NEVER-FORWARD"));
    }
    #[test]
    fn fake_cli_process_auth_output_is_reduced_before_runtime_state() {
        let executable = std::env::current_exe().unwrap();
        let args = ["--exact", "tests::fake_opencode_auth_cli_process_fixture", "--nocapture"];
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (success, output) = runtime.block_on(safe_status_output(&executable, &args)).unwrap();
        assert!(success);
        let states = parse_opencode_auth_list(&output).unwrap();
        assert!(matches!(states.get("opencode-go"), Some(AuthState::Unauthenticated)));
        assert!(!states.keys().any(|key| key.contains("sk-fixture")));
        let dto = serde_json::to_string(&states).unwrap();
        assert!(!dto.contains("sk-fixture"));
    }
    #[test]
    fn fake_opencode_auth_cli_process_fixture() {
        println!("opencode-go unauthenticated sk-fixture-NEVER-FORWARD-0123456789");
        println!("sk-fixture-NEVER-FORWARD-0123456789 configured");
    }
    #[test]
    fn opencode_model_listing_fallback_is_gateway_scoped_and_discards_other_values() {
        let fixture = include_str!("../../bloblex-adapter-acp/tests/fixtures/models-verbose.txt");
        let states = opencode_model_gateways(fixture);
        assert_eq!(states.len(), 2);
        assert!(states.values().all(|state| matches!(state, AuthState::Authenticated)));
        assert!(states.contains_key("opencode"));
        assert!(states.contains_key("opencode-go"));
        let forwarded = serde_json::to_string(&states).unwrap();
        assert!(!forwarded.contains("Big Pickle"));
        assert!(!forwarded.contains("deepseek"));
        assert!(opencode_model_gateways("opencode-go/model-a\n{broken").is_empty());
        assert!(parse_opencode_auth_list("Provider | Auth\nopencode-go | OAuth").is_none());
    }
    /// Fixture command that prints exactly one `row` line; the runtime appends
    /// the subcommand args, so on Windows `& rem` absorbs them.
    fn auth_fixture(row: &str) -> ResolvedCommand {
        #[cfg(windows)]
        {
            ResolvedCommand { executable: PathBuf::from("cmd.exe"), args: vec!["/d".into(), "/c".into(), format!("echo {row}& rem")] }
        }
        #[cfg(not(windows))]
        {
            ResolvedCommand { executable: PathBuf::from("/bin/sh"), args: vec!["-c".into(), format!("printf '%s\\n' '{row}'")] }
        }
    }
    #[test]
    fn opencode_v2_auth_list_maps_display_names_to_allowlisted_gateways() {
        let console = parse_opencode_auth_list("OpenCode Console  Default                     stored").unwrap();
        assert_eq!(console.len(), 1);
        assert!(matches!(console.get("opencode"), Some(AuthState::Authenticated)));
        assert!(matches!(aggregate_auth_states(&console), AuthState::Authenticated));

        let both = parse_opencode_auth_list("OpenCode Go  Default  stored\nOpenCode Console  Default  stored").unwrap();
        assert_eq!(both.len(), 2);
        assert!(matches!(both.get("opencode-go"), Some(AuthState::Authenticated)));
        assert!(matches!(both.get("opencode"), Some(AuthState::Authenticated)));

        let zen = parse_opencode_auth_list("OpenCode Zen  Default  stored").unwrap();
        assert_eq!(zen.len(), 1);
        assert!(matches!(zen.get("opencode"), Some(AuthState::Authenticated)));
    }
    #[tokio::test]
    async fn opencode_v2_auth_list_row_signs_in_on_the_calling_path() {
        let command = auth_fixture("OpenCode Console  Default                     stored");
        let (state, gateways, error) = auth_status("opencode", &command.executable, &command.args, &[]).await;
        assert!(matches!(state, AuthState::Authenticated));
        assert_eq!(gateways.len(), 1);
        assert!(matches!(gateways.get("opencode"), Some(AuthState::Authenticated)));
        assert!(error.is_none());
    }
    #[tokio::test]
    async fn opencode_v2_auth_list_unknown_status_is_a_quiet_unknown() {
        let command = auth_fixture("OpenCode Console  Default  mystery-state");
        let (state, gateways, error) = auth_status("opencode", &command.executable, &command.args, &[]).await;
        assert!(matches!(state, AuthState::Unknown));
        assert!(gateways.is_empty());
        assert!(error.is_none());
    }
    #[test]
    fn plain_models_listing_only_says_that_a_gateway_answered() {
        assert!(opencode_plain_model_listing_names_a_gateway("opencode-go/glm-5.2\nopencode/big-pickle"));
        assert!(opencode_plain_model_listing_names_a_gateway("opencode/big-pickle"));
        assert!(!opencode_plain_model_listing_names_a_gateway("anthropic/claude"));
        assert!(!opencode_plain_model_listing_names_a_gateway("opencode-go/"));
        assert!(!opencode_plain_model_listing_names_a_gateway(""));
    }
    #[tokio::test]
    async fn opencode_go_plain_models_is_a_quiet_unknown_not_a_sign_in() {
        let command = auth_fixture("opencode-go/glm-5.2");
        let (state, gateways, error) = auth_status("opencode", &command.executable, &command.args, &[]).await;
        assert!(matches!(state, AuthState::Unknown), "a model listing is not proof of sign-in");
        assert!(gateways.is_empty());
        assert!(error.is_none());
    }
    #[tokio::test]
    async fn opencode_zen_only_plain_models_is_a_quiet_unknown() {
        let command = auth_fixture("opencode/big-pickle");
        let (state, gateways, error) = auth_status("opencode", &command.executable, &command.args, &[]).await;
        assert!(matches!(state, AuthState::Unknown));
        assert!(gateways.is_empty());
        assert!(error.is_none());
    }
    fn opencode_temp_dir(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("bloblex-runtime-{label}-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn opencode_v1_auth_file_presence_is_a_stored_credential() {
        let dir = opencode_temp_dir("opencode-v1-presence");
        let data_dir = dir.join(".local").join("share").join("opencode");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(
            data_dir.join("auth.json"),
            r#"{"opencode-go":{"type":"api","key":"fixture-secret"}}"#,
        )
        .unwrap();
        let environment = vec![("USERPROFILE".to_string(), dir.to_string_lossy().into_owned())];
        let states = opencode_stored_gateways(&environment).unwrap();
        assert_eq!(states.len(), 1);
        assert!(matches!(states.get("opencode-go"), Some(AuthState::Authenticated)));
        // The stored credential value never reaches runtime state.
        assert!(!serde_json::to_string(&states).unwrap().contains("fixture-secret"));
        // No data dir, no auth.json and no db: the check claims nothing.
        assert!(opencode_stored_gateways(&[]).is_none());
        assert_eq!(opencode_data_dir(&environment), Some(data_dir));
        assert_eq!(
            opencode_data_dir(&[("XDG_DATA_HOME".to_string(), "D:/data".to_string())]),
            Some(PathBuf::from("D:/data/opencode"))
        );
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn opencode_v2_credential_db_presence_selects_only_the_integration_id() {
        let dir = opencode_temp_dir("opencode-v2-presence");
        let db = dir.join("opencode.db");
        {
            // The table deliberately has no `value` column: a query that
            // selected the secret column would fail here, so passing proves
            // only `integration_id` (and `active`) is read.
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TABLE credential(integration_id TEXT, active INTEGER);").unwrap();
            conn.execute("INSERT INTO credential VALUES('opencode',1)", []).unwrap();
            conn.execute("INSERT INTO credential VALUES('anthropic',1)", []).unwrap();
        }
        let environment = vec![("OPENCODE_DB".to_string(), db.to_string_lossy().into_owned())];
        let states = opencode_stored_gateways(&environment).unwrap();
        assert_eq!(states.len(), 1);
        assert!(matches!(states.get("opencode"), Some(AuthState::Authenticated)));

        // An inactive credential is not a stored credential.
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute("UPDATE credential SET active=0", []).unwrap();
        }
        assert!(opencode_stored_gateways(&environment).is_none());

        // A database without the table, and a missing file, claim nothing.
        let empty = dir.join("empty.db");
        Connection::open(&empty).unwrap();
        assert!(credential_db_gateways(&empty).is_none());
        assert!(credential_db_gateways(&dir.join("absent.db")).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn opencode_stored_credential_short_circuits_a_slow_auth_list() {
        let dir = opencode_temp_dir("opencode-presence-shortcut");
        let db = dir.join("opencode.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TABLE credential(integration_id TEXT, active INTEGER);").unwrap();
            conn.execute("INSERT INTO credential VALUES('opencode',1)", []).unwrap();
        }
        let environment = vec![("OPENCODE_DB".to_string(), db.to_string_lossy().into_owned())];
        #[cfg(windows)]
        let command = ResolvedCommand {
            executable: PathBuf::from("cmd.exe"),
            args: vec!["/d".into(), "/c".into(), "ping -n 30 127.0.0.1 > nul".into()],
        };
        #[cfg(not(windows))]
        let command = ResolvedCommand {
            executable: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), "sleep 30".into()],
        };
        let result = timeout(Duration::from_secs(2), auth_status("opencode", &command.executable, &command.args, &environment)).await;
        let (state, gateways, error) = result.expect("a stored credential must not wait on a slow CLI");
        assert!(matches!(state, AuthState::Authenticated));
        assert!(matches!(gateways.get("opencode"), Some(AuthState::Authenticated)));
        assert!(error.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn opencode_presence_check_without_a_credential_falls_through_to_the_cli() {
        let command = auth_fixture("OpenCode Console  Default  stored");
        let (state, gateways, error) = auth_status("opencode", &command.executable, &command.args, &[]).await;
        assert!(matches!(state, AuthState::Authenticated));
        assert!(matches!(gateways.get("opencode"), Some(AuthState::Authenticated)));
        assert!(error.is_none());
        // A data dir with neither auth.json nor a database also claims nothing.
        let dir = opencode_temp_dir("opencode-presence-empty");
        let data_dir = dir.join(".local").join("share").join("opencode");
        std::fs::create_dir_all(&data_dir).unwrap();
        assert!(opencode_stored_gateways(&[("USERPROFILE".to_string(), dir.to_string_lossy().into_owned())]).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A CLI that answers the two probes a table provider gets: `--version`,
    /// then `--help` naming the ACP flag it is launched with.
    fn acp_fixture() -> ResolvedCommand {
        #[cfg(windows)]
        { ResolvedCommand { executable: PathBuf::from("cmd.exe"), args: vec!["/d".into(), "/c".into(), "echo 4.5.6 & echo --acp".into()] } }
        #[cfg(not(windows))]
        { ResolvedCommand { executable: PathBuf::from("/bin/sh"), args: vec!["-c".into(), "printf '4.5.6\\n--acp\\n'".into()] } }
    }

    #[tokio::test]
    async fn a_table_provider_is_discovered() {
        for (id, display, command) in [("gemini", "Gemini CLI", "gemini"), ("qwen", "Qwen Code", "qwen")] {
            let row = discover_one(id, Some(acp_fixture()), &[]).await.expect("the fixture answers both probes");
            assert_eq!(row.provider, id);
            assert_eq!(row.display_name, display);
            assert!(matches!(row.protocol_family, ProtocolFamily::Acp));
            assert_eq!(row.status, "online", "{:?}", row.probe_error);
            assert_eq!(row.version.as_deref(), Some("4.5.6"));
            // The ACP adapter's honest capabilities: sessions, turns, tools and
            // approvals; no resume, no usage, and nothing about files.
            assert_eq!(row.capabilities.get("permissions"), Some(&true), "{id}");
            assert_eq!(row.capabilities.get("newSession"), Some(&true));
            assert_eq!(row.capabilities.get("cancel"), Some(&true));
            assert_eq!(row.capabilities.get("resume"), Some(&false), "{id}");
            assert_eq!(row.capabilities.get("usage"), Some(&false), "{id}");
            // The table names the command discovery looked for.
            assert_eq!(acp_provider(id).map(|row| row.command), Some(command));
        }
    }

    #[tokio::test]
    async fn a_missing_provider_is_not_listed() {
        // Nothing on PATH: no row at all, exactly as for the three before it.
        assert!(discover_one("gemini", None, &[]).await.is_none());
        assert!(discover_one("qwen", None, &[]).await.is_none());
        // A CLI that does not advertise ACP is kept as an error row, never as
        // an online one, and is retried rather than negatively cached.
        #[cfg(windows)]
        let useless = ResolvedCommand { executable: PathBuf::from("cmd.exe"), args: vec!["/d".into(), "/c".into(), "echo 4.5.6".into()] };
        #[cfg(not(windows))]
        let useless = ResolvedCommand { executable: PathBuf::from("/bin/sh"), args: vec!["-c".into(), "printf '4.5.6\\n'".into()] };
        let row = discover_one("gemini", Some(useless), &[]).await.expect("a failed probe keeps its row");
        assert_eq!(row.status, "error");
        assert_eq!(row.probe_step.as_deref(), Some("Protocol check"));
    }
}
