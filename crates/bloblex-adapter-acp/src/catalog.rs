use crate::exec::{ERR_CATALOG, ERR_CATALOG_TIMEOUT};
use bloblex_agent_core::{AdapterError, ModelCatalog, ModelInfo, RuntimeSpec};
use bloblex_process::{prepare_command, ProcessTree};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
};
use uuid::Uuid;

pub(crate) const ISOLATION_MARKER: &str = "bloblex-oc-catalog";

pub(crate) async fn fetch_model_catalog(
    runtime: &RuntimeSpec,
    timeout: Duration,
) -> Result<ModelCatalog, AdapterError> {
    if let Some(mut models) = fetch_config_options(runtime, timeout).await {
        if let Ok(verbose_models) = fetch_verbose_catalog(runtime, timeout).await {
            crate::exec::apply_model_efforts(&mut models, &verbose_models);
        }
        let fetched = unix_now();
        return Ok(ModelCatalog {
            models,
            fetched_at: rfc3339_from_unix(fetched),
            expires_at: rfc3339_from_unix(fetched.saturating_add(60)),
            fallback: false,
            source: "config_options".into(),
            validated: true,
        });
    }
    let models = fetch_verbose_catalog(runtime, timeout).await?;
    let fetched = unix_now();
    Ok(ModelCatalog {
        models,
        fetched_at: rfc3339_from_unix(fetched),
        expires_at: rfc3339_from_unix(fetched.saturating_add(60)),
        fallback: false,
        source: "cli_list".into(),
        validated: false,
    })
}

async fn fetch_verbose_catalog(
    runtime: &RuntimeSpec,
    timeout: Duration,
) -> Result<Vec<ModelInfo>, AdapterError> {
    let temp = TempHome::new().map_err(|_| AdapterError::Process(ERR_CATALOG.into()))?;
    let mut command = Command::new(&runtime.executable);
    prepare_command(&mut command);
    command
        .args(&runtime.args)
        .arg("models")
        .arg("--verbose")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .current_dir(temp.path())
        .kill_on_drop(true);
    temp.apply_env(&mut command);
    command.env_remove("OPENCODE_CONFIG_CONTENT");
    let mut child = command
        .spawn()
        .map_err(|_| AdapterError::Process(ERR_CATALOG.into()))?;
    let process_tree = ProcessTree::attach(&mut child).map_err(|_| AdapterError::Process(ERR_CATALOG.into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AdapterError::Process(ERR_CATALOG.into()))?;
    let read = tokio::time::timeout(timeout, read_limited(stdout, 4_000_000)).await;
    let text = match read {
        Err(_) => {
            kill_child(&mut child, &process_tree).await;
            return Err(AdapterError::Process(ERR_CATALOG_TIMEOUT.into()));
        }
        Ok(Err(error)) => {
            kill_child(&mut child, &process_tree).await;
            return Err(error);
        }
        Ok(Ok(text)) => text,
    };
    let status = match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(Ok(status)) => status,
        _ => {
            kill_child(&mut child, &process_tree).await;
            return Err(AdapterError::Process(ERR_CATALOG.into()));
        }
    };
    kill_child(&mut child, &process_tree).await;
    if !status.success() {
        return Err(AdapterError::Process(ERR_CATALOG.into()));
    }
    parse_verbose_catalog(&text).map_err(|_| AdapterError::Process(ERR_CATALOG.into()))
}

async fn fetch_config_options(runtime: &RuntimeSpec, timeout: Duration) -> Option<Vec<ModelInfo>> {
    let temp = TempHome::new().ok()?;
    let mut command = Command::new(&runtime.executable);
    prepare_command(&mut command);
    command
        .args(&runtime.args)
        .arg("acp")
        .arg("--cwd")
        .arg(temp.path())
        .current_dir(temp.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    temp.apply_env(&mut command);
    command.env_remove("OPENCODE_CONFIG_CONTENT");
    let mut child = command.spawn().ok()?;
    let process_tree = ProcessTree::attach(&mut child).ok()?;
    let stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let result = tokio::time::timeout(timeout, async move {
        let mut stdin = stdin;
        let mut stdout = BufReader::new(stdout).lines();
        for request in [
            r#"{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"Bloblex","version":"0.1.0"}}}"#,
            r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":"2","method":"session/new","params":{"cwd":".","mcpServers":[]}}"#,
        ] {
            stdin.write_all(request.as_bytes()).await.ok()?;
            stdin.write_all(b"\n").await.ok()?;
        }
        while let Some(line) = stdout.next_line().await.ok()? {
            let message: Value = serde_json::from_str(&line).ok()?;
            if message["id"].as_str() == Some("2") && message.get("error").is_none() {
                return crate::exec::config_option_catalog(
                    &crate::exec::options_from_result(&message["result"]),
                );
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    let _ = process_tree.terminate();
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

async fn kill_child(child: &mut Child, process_tree: &ProcessTree) {
    let _ = process_tree.terminate();
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn read_limited(stdout: impl AsyncRead + Unpin, limit: usize) -> Result<String, AdapterError> {
    let mut reader = tokio::io::BufReader::new(stdout);
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let read = reader
            .read(&mut buf)
            .await
            .map_err(|_| AdapterError::Process(ERR_CATALOG.into()))?;
        if read == 0 {
            break;
        }
        if out.len().saturating_add(read) > limit {
            return Err(AdapterError::Process(ERR_CATALOG.into()));
        }
        out.extend_from_slice(&buf[..read]);
    }
    String::from_utf8(out).map_err(|_| AdapterError::Process(ERR_CATALOG.into()))
}

struct TempHome(PathBuf);

impl TempHome {
    fn new() -> std::io::Result<Self> {
        let path = std::env::temp_dir().join(format!("{ISOLATION_MARKER}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(path.join("config"))?;
        std::fs::create_dir_all(path.join("data"))?;
        std::fs::create_dir_all(path.join("cache"))?;
        std::fs::create_dir_all(path.join("state"))?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn apply_env(&self, command: &mut Command) {
        let config = self.0.join("config");
        let data = self.0.join("data");
        let cache = self.0.join("cache");
        let state = self.0.join("state");
        command.env("XDG_CONFIG_HOME", &config);
        command.env("XDG_DATA_HOME", &data);
        command.env("XDG_CACHE_HOME", &cache);
        command.env("XDG_STATE_HOME", &state);
        command.env("OPENCODE_CONFIG_DIR", &config);
        command.env("OPENCODE_DATA_DIR", &data);
        command.env("OPENCODE_CACHE_DIR", &cache);
        command.env("OPENCODE_STATE_DIR", &state);
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn parse_verbose_catalog(text: &str) -> Result<Vec<ModelInfo>, String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut index = 0;
    let mut models = Vec::new();
    while index < lines.len() {
        let line = lines[index].trim();
        if line.is_empty() {
            index += 1;
            continue;
        }
        if !is_header(line) {
            return Err("verbose catalog line is not a model header".into());
        }
        let header = line.to_owned();
        index += 1;
        let (value, next) = take_object(&lines, index)?;
        index = next;
        models.push(model_from(&header, &value)?);
    }
    if models.is_empty() {
        return Err("verbose catalog contained no models".into());
    }
    Ok(models)
}

fn is_header(line: &str) -> bool {
    let mut parts = line.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(provider), Some(model), None) => token(provider) && token(model),
        _ => false,
    }
}

fn token(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn take_object(lines: &[&str], start: usize) -> Result<(Value, usize), String> {
    let mut buf = String::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    let mut started = false;
    for (offset, line) in lines.iter().enumerate().skip(start) {
        if !started && line.trim().is_empty() {
            continue;
        }
        for ch in line.chars() {
            if in_string {
                if escape {
                    escape = false;
                } else if ch == '\\' {
                    escape = true;
                } else if ch == '"' {
                    in_string = false;
                }
            } else if ch == '"' {
                in_string = true;
            } else if ch == '{' {
                depth += 1;
                started = true;
            } else if ch == '}' {
                depth -= 1;
            }
        }
        buf.push_str(line);
        buf.push('\n');
        if started && depth == 0 {
            let value: Value = serde_json::from_str(&buf).map_err(|_| "verbose model JSON is invalid".to_owned())?;
            return Ok((value, offset + 1));
        }
        if started && depth < 0 {
            break;
        }
    }
    Err("verbose model JSON is incomplete".into())
}

fn model_from(header: &str, value: &Value) -> Result<ModelInfo, String> {
    let id = value["id"].as_str().ok_or("verbose model id is missing")?;
    let provider = value["providerID"].as_str().ok_or("verbose model providerID is missing")?;
    let composed = format!("{provider}/{id}");
    if header != composed {
        return Err("verbose model header does not match providerID/id".into());
    }
    if let Some(cost) = value.get("cost") {
        if !cost.is_object() {
            return Err("verbose model cost is invalid".into());
        }
    }
    if let Some(limit) = value.get("limit") {
        if !limit.is_object() {
            return Err("verbose model limit is invalid".into());
        }
    }
    if let Some(reasoning) = value.pointer("/capabilities/reasoning") {
        if !reasoning.is_boolean() {
            return Err("verbose model reasoning capability is invalid".into());
        }
    }
    let variant_keys = match value.get("variants") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Object(map)) => map.keys().cloned().collect::<Vec<_>>(),
        Some(_) => return Err("verbose model variants are invalid".into()),
    };
    let display = value["name"].as_str().unwrap_or(header).to_owned();
    let supported = variant_keys.clone();
    Ok(ModelInfo {
        id: composed,
        display_name: display,
        provider_id: Some(provider.to_owned()),
        supported_thinking: supported,
        default_thinking: None,
        service_tiers: Vec::new(),
        default_service_tier: None,
        variants: if variant_keys.is_empty() { None } else { Some(variant_keys) },
        host_dependent: true,
        is_default: None,
        group: None,
        availability: None,
    })
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn rfc3339_from_unix(secs: u64) -> String {
    let days = secs / 86_400;
    let tod = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    let second = tod % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days: u64) -> (i32, u32, u32) {
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = (y + if month <= 2 { 1 } else { 0 }) as i32;
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_epoch_formats_as_rfc3339() {
        assert_eq!(rfc3339_from_unix(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn verbose_fixture_parses_without_inventing_default_effort() {
        let text = include_str!("../tests/fixtures/models-verbose.txt");
        let models = parse_verbose_catalog(text).unwrap();
        assert_eq!(models.len(), 3);
        assert!(models.iter().all(|model| model.host_dependent));
        assert_eq!(models[0].id, "opencode/big-pickle");
        assert_eq!(models[0].display_name, "Big Pickle");
        assert_eq!(models[0].provider_id.as_deref(), Some("opencode"));
        assert!(models[0].supported_thinking.is_empty());
        assert!(models[0].variants.is_none());
        assert_eq!(models[1].id, "opencode-go/deepseek-v4.1-flash");
        let thinking: std::collections::BTreeSet<_> = models[1].supported_thinking.iter().cloned().collect();
        assert_eq!(thinking, ["high", "low", "max"].into_iter().map(str::to_owned).collect());
        assert!(!models[1].supported_thinking.iter().any(|level| level == "default"));
        assert_eq!(models[2].display_name, "Reasoning Only");
        assert!(models[2].supported_thinking.is_empty());
    }

    #[test]
    fn invalid_cost_or_brace_in_a_string_is_handled() {
        let bad = "opencode/big-pickle\n{\"id\":\"big-pickle\",\"providerID\":\"opencode\",\"name\":\"Big Pickle\",\"cost\":\"free\"}\n";
        assert!(parse_verbose_catalog(bad).is_err());
        let braces = "opencode/brace-name\n{\"id\":\"brace-name\",\"providerID\":\"opencode\",\"name\":\"Big {Pickle}\",\"cost\":{\"input\":0},\"limit\":{\"context\":1},\"capabilities\":{\"reasoning\":false},\"variants\":{}}\n";
        let models = parse_verbose_catalog(braces).unwrap();
        assert_eq!(models[0].display_name, "Big {Pickle}");
    }
}
