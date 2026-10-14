use bloblex_protocol::{AuthState, ProtocolFamily};
use bloblex_process::{prepare_command, ProcessTree};
use serde::{Deserialize, Serialize};
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
    let specs = tokio::task::spawn_blocking(|| ["claude", "codex", "opencode"].map(|id| (id, resolve_command(id)))).await;
    let Ok([claude, codex, opencode]) = specs else { return Vec::new(); };
    collect_discovery(discover_one(claude.0, claude.1), discover_one(codex.0, codex.1), discover_one(opencode.0, opencode.1)).await
}

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

async fn discover_one(id: &str, resolved: Option<ResolvedCommand>) -> Option<DiscoveredRuntime> {
    let resolved = resolved?;
    let mut runtime = DiscoveredRuntime {
        id: format!("rt_{id}_{}", short_hash(&resolved.executable.to_string_lossy())),
        host_id: "host_windows_local".into(), provider: id.into(), display_name: provider_display_name(id).into(),
        protocol_family: match id { "opencode" => ProtocolFamily::Acp, "codex" => ProtocolFamily::CodexAppServer, _ => ProtocolFamily::ClaudeStream },
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
        _ => help.contains("--input-format") && help.contains("stream-json"),
    });
    if !supported {
        runtime.probe_step = Some("Protocol check".into());
        runtime.probe_error = Some(help.err().unwrap_or("The CLI does not advertise the required protocol.").into());
        // Failed probes are retained and retried, never negatively cached.
        return Some(runtime);
    }
    runtime.status = "online".into();
    let (auth_state, gateway_auth_states, auth_error) = auth_status(id, &resolved.executable, &resolved.args).await;
    runtime.auth_state = auth_state;
    runtime.gateway_auth_states = gateway_auth_states;
    if let Some(error) = auth_error {
        runtime.probe_step = Some("Sign-in check".into());
        runtime.probe_error = Some(error.into());
    }
    for key in ["newSession", "resume", "cancel", "permissions", "usage", "files"] {
        runtime.capabilities.insert(key.into(), matches!((id, key), (_, "newSession" | "cancel") | ("claude" | "codex", "resume" | "usage") | ("codex" | "opencode", "permissions")));
    }
    Some(runtime)
}
fn provider_display_name(provider: &str) -> &'static str { match provider { "claude" => "Claude Code", "codex" => "Codex", "opencode" => "OpenCode", _ => "Coding agent" } }
async fn auth_status(provider: &str, exe: &Path, args: &[String]) -> (AuthState, BTreeMap<String, AuthState>, Option<&'static str>) {
    let mut av = args.iter().map(String::as_str).collect::<Vec<_>>();
    match provider {
        "claude" => av.extend(["auth", "status"]),
        "codex" => av.extend(["login", "status"]),
        "opencode" => av.extend(["auth", "list"]),
        _ => return (AuthState::Unknown, BTreeMap::new(), None),
    };
    if provider == "opencode" {
        if let Ok((true, output)) = safe_status_output(exe, &av).await {
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
        if let Ok((true, output)) = safe_status_output(exe, &verbose_args).await {
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
        if let Ok((true, output)) = safe_status_output(exe, &model_args).await {
            if opencode_plain_model_listing_names_a_gateway(&output) {
                return (AuthState::Unknown, BTreeMap::new(), None);
            }
        }
        return (AuthState::Unknown, BTreeMap::new(), Some("Sign-in status could not be checked."));
    }
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
    let mut cmd = Command::new(exe);
    prepare_command(&mut cmd);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|_| "Could not start the sign-in check.")?;
    let process_tree = ProcessTree::attach(&mut child).map_err(|_| "Could not supervise the sign-in check.")?;
    let result = timeout(Duration::from_secs(5), child.wait_with_output()).await;
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
        let failed = discover_one("codex", Some(fixture_command(false))).await.unwrap();
        assert_eq!(failed.status, "error");
        assert_eq!(failed.probe_step.as_deref(), Some("Protocol check"));
        assert_eq!(failed.probe_error.as_deref(), Some("Probe exited unsuccessfully."));
        assert!(!failed.probe_error.as_deref().unwrap().contains("PRIVATE_DIAGNOSTIC"));
        assert!(failed.capabilities.is_empty());
        let healed = discover_one("codex", Some(fixture_command(true))).await.unwrap();
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
        let runtime = discover_one("opencode", Some(command)).await.unwrap();
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
        let failed = discover_one("opencode", Some(command)).await.unwrap();
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
        let unsupported = discover_one("opencode", Some(command)).await.unwrap();
        assert_eq!(unsupported.status, "error");
        assert_eq!(unsupported.probe_step.as_deref(), Some("Protocol check"));
        assert_eq!(unsupported.probe_error.as_deref(), Some("The CLI does not advertise the required protocol."));
    }
    #[tokio::test]
    async fn missing_executable_reports_a_fixed_error() {
        let runtime = discover_one("codex", Some(ResolvedCommand { executable: PathBuf::from("bloblex-missing-probe-executable"), args: vec![] })).await.unwrap();
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
        let (state, gateways, error) = auth_status("opencode", &command.executable, &command.args).await;
        assert!(matches!(state, AuthState::Authenticated));
        assert_eq!(gateways.len(), 1);
        assert!(matches!(gateways.get("opencode"), Some(AuthState::Authenticated)));
        assert!(error.is_none());
    }
    #[tokio::test]
    async fn opencode_v2_auth_list_unknown_status_is_a_quiet_unknown() {
        let command = auth_fixture("OpenCode Console  Default  mystery-state");
        let (state, gateways, error) = auth_status("opencode", &command.executable, &command.args).await;
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
        let (state, gateways, error) = auth_status("opencode", &command.executable, &command.args).await;
        assert!(matches!(state, AuthState::Unknown), "a model listing is not proof of sign-in");
        assert!(gateways.is_empty());
        assert!(error.is_none());
    }
    #[tokio::test]
    async fn opencode_zen_only_plain_models_is_a_quiet_unknown() {
        let command = auth_fixture("opencode/big-pickle");
        let (state, gateways, error) = auth_status("opencode", &command.executable, &command.args).await;
        assert!(matches!(state, AuthState::Unknown));
        assert!(gateways.is_empty());
        assert!(error.is_none());
    }
}
