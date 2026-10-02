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
    process::Command,
    time::{timeout, Duration},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRuntime {
    pub id: String,
    pub host_id: String,
    pub provider: String,
    pub protocol_family: ProtocolFamily,
    pub executable_path: String,
    pub launch_args: Vec<String>,
    pub version: Option<String>,
    pub auth_state: AuthState,
    pub status: String,
    pub capabilities: BTreeMap<String, bool>,
}

#[derive(Debug, Clone)]
pub struct ResolvedCommand {
    pub executable: PathBuf,
    pub args: Vec<String>,
}

pub fn resolve_command(name: &str) -> Option<ResolvedCommand> {
    let paths = env::var_os("PATH")?;
    #[cfg(windows)]
    let extensions = vec![".exe", ".com", ".cmd", ".bat", ".ps1", ""];
    #[cfg(not(windows))]
    let extensions = vec![""];
    for dir in env::split_paths(&paths) {
        for ext in &extensions {
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
            continue;
        }
        let auth_state = auth_status(id, &resolved.executable, &resolved.args).await;
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
            protocol_family: family,
            executable_path: resolved.executable.to_string_lossy().into_owned(),
            launch_args: resolved.args,
            version,
            auth_state,
            status: "online".into(),
            capabilities: caps,
        });
    }
    out
}
async fn auth_status(provider: &str, exe: &Path, args: &[String]) -> AuthState {
    let mut av = args.iter().map(String::as_str).collect::<Vec<_>>();
    match provider {
        "claude" => av.extend(["auth", "status"]),
        "codex" => av.extend(["login", "status"]),
        _ => return AuthState::Unknown,
    };
    let out = safe_status_output(exe, &av).await.unwrap_or_default();
    if provider == "claude" {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) {
            return match v["loggedIn"].as_bool() {
                Some(true) => AuthState::Authenticated,
                Some(false) => AuthState::Unauthenticated,
                None => AuthState::Unknown,
            };
        }
    }
    let l = out.to_ascii_lowercase();
    if l.contains("not logged in") || l.contains("not authenticated") {
        AuthState::Unauthenticated
    } else if l.contains("logged in using") || l.contains("logged in") {
        AuthState::Authenticated
    } else {
        AuthState::Unknown
    }
}
async fn safe_status_output(exe: &Path, args: &[&str]) -> Option<String> {
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
    if text.len() < 32 * 1024 {
        text.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    text.truncate(32 * 1024);
    Some(text)
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
    async fn resolves_installed_clis_to_real_native_targets() {
        for name in ["claude", "codex", "opencode"] {
            if let Some(resolved) = resolve_command(name) {
                assert!(resolved.executable.is_file());
                assert!(!resolved
                    .executable
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("cmd")));
            }
        }
        let providers = discover().await;
        println!(
            "discovered providers: {:?}",
            providers.iter().map(|r| &r.provider).collect::<Vec<_>>()
        );
    }
}
