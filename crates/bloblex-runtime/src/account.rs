//! Who is signed in, read only from each CLI's own account output (Phase 5).
//!
//! Nothing here opens, copies or parses a token or a credential file. The only
//! inputs are the stdout of `claude auth status`, the app server's
//! `account/read` reply, and `opencode auth list`. This module has no file
//! access at all, which `no_token_is_read_for_the_account` pins.
//!
//! Each probe is bounded and its process tree is killed when the budget runs
//! out, and a failure is `None`: unknown stays unknown.

use bloblex_process::{prepare_command, ProcessTree};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

/// Budget for one account read, as the brief sets it. Discovery runs this off
/// the runtime's other work.
pub const ACCOUNT_TIMEOUT_SECS: u64 = 10;
/// The label can be an email or an account name; a reply longer than this is
/// not an account name, so it is dropped rather than forwarded to a device.
const MAX_LABEL_CHARS: usize = 120;
const MAX_PLAN_CHARS: usize = 40;
/// The command behind each answer. Fixed text: a source never carries a path.
pub const CLAUDE_SOURCE: &str = "claude auth status";
pub const CODEX_SOURCE: &str = "codex app-server account/read";
pub const OPENCODE_SOURCE: &str = "opencode auth list";

/// One provider's answer to "who is signed in". `label` and `plan` are `null`
/// when the CLI does not say, which is not the same as an empty answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub label: Option<String>,
    pub plan: Option<String>,
    pub source: String,
}

impl AccountInfo {
    fn new(label: Option<String>, plan: Option<String>, source: &str) -> Self {
        Self { label, plan, source: source.to_owned() }
    }
}

/// Read one provider's account with that provider's own command, for one
/// account's environment.
pub async fn read(provider: &str, exe: &Path, args: &[String], environment: &[(String, String)]) -> Option<AccountInfo> {
    let limit = Duration::from_secs(ACCOUNT_TIMEOUT_SECS);
    match provider {
        "claude" => from_claude_status(&plain_output(exe, args, &["auth", "status"], environment, limit).await?),
        "opencode" => from_opencode_auth_list(&plain_output(exe, args, &["auth", "list", "--format", "json"], environment, limit).await?),
        "codex" => read_codex(exe, args, environment).await,
        _ => None,
    }
}

/// `claude auth status` prints one JSON object. Only `email` and
/// `subscriptionType` are taken; nothing else in it is copied.
pub fn from_claude_status(text: &str) -> Option<AccountInfo> {
    let value: Value = serde_json::from_str(text.trim()).ok()?;
    if value.get("loggedIn").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    Some(AccountInfo::new(
        value.get("email").and_then(Value::as_str).and_then(safe_label),
        value.get("subscriptionType").and_then(Value::as_str).and_then(safe_plan),
        CLAUDE_SOURCE,
    ))
}

/// The app server's `account/read` result. A ChatGPT account names its email
/// and plan; an API key or a hosted provider has no person behind it, so the
/// label stays null while the source still says the CLI answered.
pub fn from_codex_account_read(result: &Value) -> Option<AccountInfo> {
    let account = result.get("account")?;
    if account.is_null() {
        return None;
    }
    let kind = account.get("type").and_then(Value::as_str)?;
    match kind {
        "chatgpt" => Some(AccountInfo::new(
            account.get("email").and_then(Value::as_str).and_then(safe_label),
            account.get("planType").and_then(Value::as_str).and_then(safe_plan),
            CODEX_SOURCE,
        )),
        "apiKey" | "amazonBedrock" => Some(AccountInfo::new(None, None, CODEX_SOURCE)),
        // An account kind this build has not seen says nothing usable.
        _ => None,
    }
}

/// `opencode auth list` prints integrations (`OpenCode Go  API key  stored`), or
/// the same rows as JSON with `--format json`. Neither form names a person on a
/// stored key, so the label is taken only when a row carries an explicit
/// `email`/`account`/`username` field or an email-shaped value.
pub fn from_opencode_auth_list(text: &str) -> Option<AccountInfo> {
    if !opencode_names_a_row(text) {
        return None;
    }
    Some(AccountInfo::new(opencode_label(text), None, OPENCODE_SOURCE))
}

fn opencode_names_a_row(text: &str) -> bool {
    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(text.trim()) {
        return !items.is_empty();
    }
    crate::opencode_auth_list_has_recognized_rows(text)
}

/// An explicit account field in the JSON form, else an email-shaped token in
/// either form. A field named `label` is a credential kind ("API key"), never an
/// account, so it is not read.
fn opencode_label(text: &str) -> Option<String> {
    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(text.trim()) {
        for item in &items {
            if let Some(found) = named_account_field(item, 0) {
                return Some(found);
            }
        }
        return None;
    }
    text.split_whitespace().filter(|word| !word.starts_with("cred_")).find_map(looks_like_email)
}

fn named_account_field(value: &Value, depth: usize) -> Option<String> {
    if depth > 4 {
        return None;
    }
    match value {
        Value::Object(map) => {
            for key in ["email", "account", "username", "user", "login"] {
                if let Some(text) = map.get(key).and_then(Value::as_str).and_then(safe_label) {
                    return Some(text);
                }
            }
            map.values().filter(|entry| entry.is_object() || entry.is_array()).find_map(|entry| named_account_field(entry, depth + 1))
        }
        Value::Array(items) => items.iter().find_map(|entry| named_account_field(entry, depth + 1)),
        _ => None,
    }
}

fn looks_like_email(word: &str) -> Option<String> {
    let candidate = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '@' && c != '.' && c != '_' && c != '-' && c != '+');
    let (local, domain) = candidate.split_once('@')?;
    if local.is_empty() || !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') {
        return None;
    }
    let shaped = candidate.chars().all(|c| c.is_ascii_alphanumeric() || "@._-+".contains(c));
    shaped.then(|| safe_label(candidate)).flatten()
}

/// A label is trimmed, printable and short. Anything else is not a name.
fn safe_label(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let usable = !trimmed.is_empty()
        && trimmed.chars().count() <= MAX_LABEL_CHARS
        && !trimmed.chars().any(char::is_control);
    usable.then(|| trimmed.to_owned())
}

fn safe_plan(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let usable = !trimmed.is_empty()
        && trimmed.chars().count() <= MAX_PLAN_CHARS
        && trimmed.chars().all(|c| c.is_ascii_alphanumeric() || " ._-".contains(c));
    usable.then(|| trimmed.to_owned())
}

/// One short command whose stdout is the whole answer. Nothing from stderr is
/// parsed: a sign-in products' notices are not account output.
async fn plain_output(exe: &Path, args: &[String], extra: &[&str], environment: &[(String, String)], limit: Duration) -> Option<String> {
    let mut command = Command::new(exe);
    prepare_command(&mut command);
    command
        .args(args)
        .args(extra)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (name, value) in environment {
        command.env(name, value);
    }
    let mut child = command.spawn().ok()?;
    let process_tree = ProcessTree::attach(&mut child).ok()?;
    let result = tokio::time::timeout(limit, child.wait_with_output()).await;
    let _ = process_tree.terminate();
    let output = result.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).chars().take(64 * 1024).collect())
}

/// The app server's `account/read`: initialize, then ask. Notifications that
/// arrive first (an `account/updated` on a plan change) carry no `id` and are
/// skipped. The whole exchange sits inside one budget.
async fn read_codex(exe: &Path, args: &[String], environment: &[(String, String)]) -> Option<AccountInfo> {
    let limit = Duration::from_secs(ACCOUNT_TIMEOUT_SECS);
    let mut command = Command::new(exe);
    prepare_command(&mut command);
    command
        .args(args)
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (name, value) in environment {
        command.env(name, value);
    }
    let mut child = command.spawn().ok()?;
    let process_tree = ProcessTree::attach(&mut child).ok()?;
    let result = tokio::time::timeout(limit, async {
        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let mut lines = BufReader::new(stdout).lines();
        let mut stdin = stdin;
        send(&mut stdin, &serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"Bitbots","version":"0.1.0"},"capabilities":{"experimentalApi":true}}})).await?;
        let _ = reply(&mut lines, 1).await?;
        send(&mut stdin, &serde_json::json!({"jsonrpc":"2.0","method":"initialized","params":{}})).await?;
        send(&mut stdin, &serde_json::json!({"jsonrpc":"2.0","id":2,"method":"account/read","params":{}})).await?;
        reply(&mut lines, 2).await
    })
    .await;
    let _ = process_tree.terminate();
    let _ = child.kill().await;
    from_codex_account_read(&result.ok()??)
}

async fn send(stdin: &mut tokio::process::ChildStdin, value: &Value) -> Option<()> {
    let mut line = serde_json::to_vec(value).ok()?;
    line.push(b'\n');
    stdin.write_all(&line).await.ok()
}

async fn reply(lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>, id: u64) -> Option<Value> {
    loop {
        let line = lines.next_line().await.ok()??;
        let value: Value = serde_json::from_str(&line).ok()?;
        if value.get("id").and_then(Value::as_u64) == Some(id) {
            if value.get("error").is_some() {
                return None;
            }
            return value.get("result").cloned();
        }
    }
}
