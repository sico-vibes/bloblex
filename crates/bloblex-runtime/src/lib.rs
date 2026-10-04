use bloblex_protocol::{AuthState, ProtocolFamily};
use bloblex_process::{prepare_command, ProcessTree};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
};
use tokio::{
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
}

#[derive(Debug, Clone)]
pub struct ResolvedCommand {
    pub executable: PathBuf,
    pub args: Vec<String>,
}

static NEGATIVE_CAPABILITY_CACHE: OnceLock<Mutex<std::collections::HashSet<String>>> =
    OnceLock::new();

fn negative_probe_key(provider: &str, executable: &Path, version: Option<&str>) -> String {
    format!(
        "{provider}|{}|{}",
        executable.to_string_lossy().to_ascii_lowercase(),
        version.unwrap_or("unknown")
    )
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

async fn bounded_output(exe: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(exe);
    prepare_command(&mut cmd);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().ok()?;
    let process_tree = ProcessTree::attach(&mut child).ok()?;
    let output = timeout(Duration::from_secs(6), child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    let _ = process_tree.terminate();
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    if text.len() < 32 * 1024 {
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    text.truncate(32 * 1024);
    Some(text)
}

pub async fn discover() -> Vec<DiscoveredRuntime> {
    let specs = [
        ("claude", "claude", "claude_stream"),
        ("codex", "codex", "codex_app_server"),
        ("opencode", "opencode", "acp"),
    ];
    let mut out = Vec::new();
    for (id, cmd_name, proto) in specs {
        let Some(resolved) = resolve_command(cmd_name) else {
            continue;
        };
        let mut version_args = resolved.args.iter().map(String::as_str).collect::<Vec<_>>();
        version_args.push("--version");
        let ver = bounded_output(&resolved.executable, &version_args)
            .await
            .unwrap_or_default();
        let version = ver
            .lines()
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let cache_key = negative_probe_key(
            id,
            &resolved.executable,
            version.as_deref(),
        );
        let unsupported_cache = NEGATIVE_CAPABILITY_CACHE.get_or_init(|| Mutex::new(Default::default()));
        if unsupported_cache.lock().is_ok_and(|cache| cache.contains(&cache_key)) {
            continue;
        }
        let family = match proto {
            "acp" => ProtocolFamily::Acp,
            "codex_app_server" => ProtocolFamily::CodexAppServer,
            _ => ProtocolFamily::ClaudeStream,
        };
        let mut probe_args = resolved.args.iter().map(String::as_str).collect::<Vec<_>>();
        match id {
            "opencode" => probe_args.extend(["acp", "--help"]),
            "codex" => probe_args.extend(["app-server", "--help"]),
            _ => probe_args.push("--help"),
        };
        let help = bounded_output(&resolved.executable, &probe_args)
            .await
            .unwrap_or_default();
        let supported = match id {
            "opencode" => help.contains("ACP") || help.contains("acp"),
            "codex" => help.contains("app-server"),
            _ => help.contains("--input-format") && help.contains("stream-json"),
        };
        if !supported {
            if let Ok(mut cache) = unsupported_cache.lock() {
                cache.insert(cache_key);
            }
            continue;
        }
        let (auth_state, gateway_auth_states) = auth_status(id, &resolved.executable, &resolved.args).await;
        let mut caps = BTreeMap::new();
        for k in [
            "newSession",
            "resume",
            "cancel",
            "permissions",
            "usage",
            "files",
        ] {
            caps.insert(
                k.into(),
                match (id, k) {
                    (_, "newSession" | "cancel") => true,
                    ("claude", "resume") => true,
                    ("codex", "resume") => true,
                    ("codex", "permissions") => true,
                    ("codex", "usage") => true,
                    ("claude", "usage") => true,
                    ("opencode", "permissions") => true,
                    _ => false,
                },
            );
        }
        out.push(DiscoveredRuntime {
            id: format!(
                "rt_{id}_{}",
                short_hash(&resolved.executable.to_string_lossy())
            ),
            host_id: "host_windows_local".into(),
            provider: id.into(),
            display_name: provider_display_name(id).into(),
            protocol_family: family,
            executable_path: resolved.executable.to_string_lossy().into_owned(),
            launch_args: resolved.args,
            version,
            auth_state,
            gateway_auth_states,
            status: "online".into(),
            capabilities: caps,
        });
    }
    out
}
fn provider_display_name(provider: &str) -> &'static str { match provider { "claude" => "Claude Code", "codex" => "Codex", "opencode" => "OpenCode", _ => "Coding agent" } }
async fn auth_status(provider: &str, exe: &Path, args: &[String]) -> (AuthState, BTreeMap<String, AuthState>) {
    let mut av = args.iter().map(String::as_str).collect::<Vec<_>>();
    match provider {
        "claude" => av.extend(["auth", "status"]),
        "codex" => av.extend(["login", "status"]),
        "opencode" => av.extend(["auth", "list"]),
        _ => return (AuthState::Unknown, BTreeMap::new()),
    };
    if provider == "opencode" {
        if let Some((true, output)) = safe_status_output(exe, &av).await {
            if let Some(states) = parse_opencode_auth_list(&output) {
                return (aggregate_auth_states(&states), states);
            }
        }
        let mut model_args = args.iter().map(String::as_str).collect::<Vec<_>>();
        model_args.extend(["models", "--verbose"]);
        if let Some((true, output)) = safe_status_output(exe, &model_args).await {
            let states = opencode_model_gateways(&output);
            if !states.is_empty() {
                return (aggregate_auth_states(&states), states);
            }
        }
        return (AuthState::Unknown, BTreeMap::new());
    }
    let out = safe_status_output(exe, &av).await.map(|(_, text)| text).unwrap_or_default();
    if provider == "claude" {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) {
            return (match v["loggedIn"].as_bool() {
                Some(true) => AuthState::Authenticated,
                Some(false) => AuthState::Unauthenticated,
                None => AuthState::Unknown,
            }, BTreeMap::new());
        }
    }
    let l = out.to_ascii_lowercase();
    if l.contains("not logged in") || l.contains("not authenticated") {
        (AuthState::Unauthenticated, BTreeMap::new())
    } else if l.contains("logged in using") || l.contains("logged in") {
        (AuthState::Authenticated, BTreeMap::new())
    } else {
        (AuthState::Unknown, BTreeMap::new())
    }
}
fn safe_gateway_name(input: &str) -> Option<String> {
    match input.trim().trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_').to_ascii_lowercase().as_str() {
        "opencode" => Some("opencode".into()),
        "opencode-go" => Some("opencode-go".into()),
        _ => None,
    }
}
fn parse_opencode_auth_list(output: &str) -> Option<BTreeMap<String, AuthState>> {
    let mut states = BTreeMap::new();
    for line in output.lines() {
        let line = line.trim().trim_matches('|').trim();
        let fields = line.split(|c: char| c == '|' || c == ':' || c == ',' || c == '\t').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>();
        let (raw_name, status_fields): (&str, Vec<String>) = if fields.len() >= 2 { (fields[0], fields[1..].iter().map(|field| (*field).to_owned()).collect()) } else {
            let words = line.split_whitespace().collect::<Vec<_>>();
            if words.len() < 2 { continue; }
            let tail = if words.len() >= 3 && matches!((words[1].to_ascii_lowercase().as_str(), words[2].to_ascii_lowercase().as_str()), ("logged", "in") | ("logged", "out") | ("signed", "in") | ("signed", "out") | ("not", "configured") | ("not", "authenticated") | ("not", "logged") | ("no", "credentials")) {
                if words[1].eq_ignore_ascii_case("not") && words[2].eq_ignore_ascii_case("logged") && words.get(3).is_some_and(|word| word.eq_ignore_ascii_case("in")) { words[1..4].join(" ") } else { words[1..3].join(" ") }
            } else { words[1].to_owned() };
            (words[0], vec![tail])
        };
        let Some(name) = safe_gateway_name(raw_name) else { continue; };
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
        "configured" | "authenticated" | "connected" | "signed in" | "logged in" | "true" | "yes" => Some(AuthState::Authenticated),
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
async fn safe_status_output(exe: &Path, args: &[&str]) -> Option<(bool, String)> {
    let mut cmd = Command::new(exe);
    prepare_command(&mut cmd);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().ok()?;
    let process_tree = ProcessTree::attach(&mut child).ok()?;
    let out = timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    let _ = process_tree.terminate();
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    if text.len() < 32 * 1024 && (args.ends_with(&["auth", "status"]) || args.ends_with(&["login", "status"])) {
        text.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    text.truncate(32 * 1024);
    Some((out.status.success(), text))
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
    fn negative_probe_cache_key_changes_with_cli_version() {
        let executable = Path::new("C:/tools/cli.exe");
        assert_ne!(
            negative_probe_key("codex", executable, Some("0.1.0")),
            negative_probe_key("codex", executable, Some("0.2.0"))
        );
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
        assert!(!executable_extensions().iter().any(|extension| *extension == ".ps1"));
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
}
