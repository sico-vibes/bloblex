//! A fake coding-agent CLI for the account tests: it answers the probes
//! discovery makes (`--version`, `--help`, `auth status`, `login status`,
//! `auth list`) and speaks the Codex app-server exchange on stdio. Its output
//! copies the real shapes recorded on 31 October 2026, with redacted values.

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

const CLAUDE_STATUS: &str = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"owner@example.com","subscriptionType":"pro"}"#;
const OPENCODE_AUTH_TEXT: &str = "OpenCode Go  API key                     stored";
const OPENCODE_AUTH_JSON: &str = r#"[{"id":"opencode-go","name":"OpenCode Go","connections":[{"type":"credential","id":"cred_000000000000000000000000","label":"API key","method":"key"}]}]"#;
const CODEX_ACCOUNT_RESULT: &str = r#"{"account":{"type":"chatgpt","email":"owner@example.com","planType":"plus"},"requiresOpenaiAuth":true}"#;

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let joined = args.join(" ");
    if args.iter().any(|arg| arg == "--version") {
        println!("1.2.3");
        return;
    }
    if joined.contains("auth status") {
        println!("{CLAUDE_STATUS}");
        return;
    }
    if joined.contains("login status") {
        println!("Logged in using ChatGPT");
        return;
    }
    if joined.contains("auth list") {
        // With `--format json`, the listing form; otherwise the text form.
        if args.iter().any(|arg| arg == "json") {
            print!("{}", OPENCODE_AUTH_JSON);
        } else {
            println!("{OPENCODE_AUTH_TEXT}");
        }
        return;
    }
    if args.iter().any(|arg| arg == "--help") {
        // Every provider's protocol marker in one answer: discovery asks the
        // same fake binary for all three.
        println!("--input-format stream-json\napp-server --listen stdio://\nACP stdio protocol");
        return;
    }
    if joined.contains("app-server") {
        app_server();
    }
}

/// Answer `initialize` and `account/read`, and send the `account/updated`
/// notification the real app server emits before the reply.
fn app_server() {
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        let id = value.get("id").cloned();
        match value.get("method").and_then(Value::as_str) {
            Some("initialize") => {
                let reply = json!({"id":id,"result":{"userAgent":"fake/1.2.3","codexHome":"[redacted]","platformFamily":"windows","platformOs":"windows"}});
                out(&reply);
            }
            Some("account/read") => {
                out(&json!({"method":"account/updated","params":{"authMode":"chatgpt","planType":"plus"}}));
                let result: Value = serde_json::from_str(CODEX_ACCOUNT_RESULT).unwrap();
                out(&json!({"id":id,"result":result}));
                break;
            }
            _ => {}
        }
    }
}

fn out(value: &Value) {
    println!("{value}");
    let _ = io::stdout().flush();
}
