//! Phase 1B: report a problem.
//!
//! `diagnostics.issueDraft` builds the text of a GitHub issue from facts that carry no
//! conversation: the app version, the Windows version, each coding agent's name and version, and the
//! health checks that are not ok. Everything passes through `diagnostics::redact` and the home
//! folder becomes `~`. Nothing leaves the computer until the owner has read the exact text and
//! `diagnostics.issuePost` is called with `confirm: true`; the post uses the GitHub CLI's own
//! sign-in. Neither the draft nor the post logs any of the text.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::time::Duration;

pub(crate) const REPO: &str = "sico-vibes/bloblex";
/// Source characters of the body that go into the new-issue address, before encoding.
const URL_BODY_CHARS: usize = 6_000;
const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_CHARS: usize = 60_000;
const POST_LIMIT: Duration = Duration::from_secs(60);
const SIGN_IN_HELP: &str = "Install and sign in to the GitHub CLI, or open the issue in your browser.";

/// The user's home folder in text, in both slash styles, so it can be hidden.
fn home_folders() -> Vec<String> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    let home = home.trim().trim_end_matches(['\\', '/']).to_owned();
    if home.len() < 3 { return Vec::new(); }
    let forward = home.replace('\\', "/");
    let mut folders = vec![home];
    if folders[0] != forward { folders.push(forward); }
    folders
}

/// Secrets removed and the home folder shown as `~`.
pub(crate) fn clean(text: &str) -> String {
    clean_with(text, &home_folders())
}

pub(crate) fn clean_with(text: &str, homes: &[String]) -> String {
    let mut out = crate::diagnostics::redact(text);
    for home in homes {
        if let Ok(pattern) = regex::Regex::new(&format!("(?i){}", regex::escape(home))) {
            out = pattern.replace_all(&out, regex::NoExpand("~")).into_owned();
        }
    }
    out
}

/// Percent-encodes everything but the unreserved characters.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') { out.push(byte as char); } else { out.push_str(&format!("%{byte:02X}")); }
    }
    out
}

/// GitHub's new-issue address with the title and the (bounded) body filled in.
pub(crate) fn new_issue_url(title: &str, body: &str) -> String {
    let body = body.chars().take(URL_BODY_CHARS).collect::<String>();
    format!("https://github.com/{REPO}/issues/new?title={}&body={}", encode(title), encode(&body))
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn body(st: &AppState) -> String {
    let mut lines: Vec<String> = vec!["## What happened".into(), String::new(), String::new(), "## Version".into(), String::new()];
    lines.push(format!("- Bitbots {}", env!("CARGO_PKG_VERSION")));
    lines.push(format!("- Windows {}", crate::diagnostics::os_version()));
    lines.push(String::new());
    lines.push("## Coding agents".into());
    lines.push(String::new());
    let runtimes = st.runtimes.read().await.clone();
    if runtimes.is_empty() { lines.push("- None found".into()); }
    for runtime in &runtimes {
        let provider = runtime["provider"].as_str().unwrap_or("unknown");
        let version = runtime["version"].as_str().filter(|version| !version.is_empty()).unwrap_or("unknown");
        lines.push(format!("- {provider} {version}"));
    }
    lines.push(String::new());
    lines.push("## Health check".into());
    lines.push(String::new());
    let report = crate::doctor::run(st).await.unwrap_or(Value::Null);
    let problems = report["checks"].as_array().map(|checks| checks.iter().filter(|check| check["status"] != "ok").collect::<Vec<_>>()).unwrap_or_default();
    if problems.is_empty() { lines.push("- Every check passed.".into()); }
    for check in problems {
        lines.push(format!("- {}: {}. {}", one_line(check["label"].as_str().unwrap_or("Check")), check["status"].as_str().unwrap_or("unknown"), one_line(check["detail"].as_str().unwrap_or(""))));
    }
    clean(&lines.join("\n"))
}

pub(crate) async fn draft(st: &AppState) -> Result<Value, DispatchError> {
    let text = body(st).await;
    Ok(json!({"repo": REPO, "title": "", "body": text, "url": new_issue_url("", &text), "gh": crate::scaffold::gh_status().await}))
}

pub(crate) async fn post(_st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let invalid = |message: &str| derr("invalid_argument", message, StatusCode::BAD_REQUEST);
    if p["confirm"] != true { return Err(invalid("Confirm sending the report first.")); }
    let title = p["title"].as_str().map(str::trim).filter(|title| !title.is_empty() && title.chars().count() <= MAX_TITLE_CHARS).ok_or_else(|| invalid("The title must be 1 to 200 characters."))?;
    let body = match p.get("body") {
        None | Some(Value::Null) => "",
        Some(value) => value.as_str().filter(|body| body.chars().count() <= MAX_BODY_CHARS).ok_or_else(|| invalid("The report is longer than 60000 characters."))?,
    };
    // The owner may have typed anything since the draft, so both texts are cleaned again.
    let (title, body) = (one_line(&clean(title)), clean(body));
    let gh: OsString = crate::scaffold::gh_program();
    let ran = crate::scaffold::run(&gh, None, &["issue", "create", "--repo", REPO, "--title", &title, "--body-file", "-"], Some(&body), POST_LIMIT).await;
    let unavailable = || derr("unsupported", SIGN_IN_HELP, StatusCode::BAD_REQUEST);
    if !ran.started { return Err(unavailable()); }
    if !ran.ok {
        let said = format!("{} {}", ran.stderr, ran.stdout).to_ascii_lowercase();
        if said.contains("gh auth login") || said.contains("not logged in") || said.contains("authentication") { return Err(unavailable()); }
        let detail = if ran.timed_out { "GitHub took too long to answer.".to_owned() } else { crate::scaffold::one_line(ran.stderr.lines().chain(ran.stdout.lines()).find(|line| !line.trim().is_empty()).unwrap_or("GitHub did not accept the report.")) };
        return Err(derr("unavailable", &detail, StatusCode::BAD_GATEWAY));
    }
    let url = ran.stdout.lines().map(str::trim).find(|line| line.starts_with("https://github.com/") && !line.contains(char::is_whitespace)).map(str::to_owned)
        .unwrap_or_else(|| format!("https://github.com/{REPO}/issues"));
    Ok(json!({"url": url}))
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn encoding_keeps_only_unreserved_characters() {
        assert_eq!(encode("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
        assert_eq!(encode("Az09-_.~"), "Az09-_.~");
    }
}
