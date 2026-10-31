//! Who is signed in: what each CLI's own account output says, and what the
//! discovery row reports. The samples are the real outputs recorded on
//! 31 October 2026 (Claude Code 2.1.314, codex-cli 0.165.0, opencode v2.2.2)
//! with emails and ids redacted.

use bloblex_runtime::{discover_one, from_claude_status, from_codex_account_read, from_opencode_auth_list, ResolvedCommand};
use serde_json::json;
use std::path::PathBuf;

/// The real `claude auth status` output on a machine signed in to claude.ai.
const CLAUDE_STATUS: &str = r#"{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "C:\\Users\\owner\\.claude\\projects",
  "configDirectory": "C:\\Users\\owner\\.claude",
  "email": "owner@example.com",
  "orgId": "00000000-0000-4000-8000-000000000000",
  "orgName": "owner@example.com's Organization",
  "subscriptionType": "pro"
}"#;
/// The real `account/read` result from Codex 0.165.0 over the app server.
const CODEX_ACCOUNT: &str = r#"{"account":{"type":"chatgpt","email":"owner@example.com","planType":"plus"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"00000000-0000-4000-8000-000000000000","backendOrigin":"https://chatgpt.com","accountRoutingOverride":"NO_CONSTRAINT"}}"#;
/// The real `opencode auth list` output: a display name, a credential kind and
/// a state, and no person's name anywhere.
const OPENCODE_AUTH_TEXT: &str = "OpenCode Go  API key                     stored";
/// The same listing with `--format json`.
const OPENCODE_AUTH_JSON: &str = r#"[{"id":"opencode-go","name":"OpenCode Go","connections":[{"type":"credential","id":"cred_000000000000000000000000","label":"API key","method":"key"}]}]"#;

fn fake_cli() -> ResolvedCommand {
    ResolvedCommand { executable: PathBuf::from(env!("CARGO_BIN_EXE_fake_cli_account")), args: vec![] }
}

#[tokio::test]
async fn account_comes_from_the_clis_own_output() {
    let claude = from_claude_status(CLAUDE_STATUS).unwrap();
    assert_eq!(claude.label.as_deref(), Some("owner@example.com"));
    assert_eq!(claude.plan.as_deref(), Some("pro"));
    assert_eq!(claude.source, "claude auth status");
    let codex = from_codex_account_read(&serde_json::from_str(CODEX_ACCOUNT).unwrap()).unwrap();
    assert_eq!(codex.label.as_deref(), Some("owner@example.com"));
    assert_eq!(codex.plan.as_deref(), Some("plus"));
    assert_eq!(codex.source, "codex app-server account/read");
    for text in [OPENCODE_AUTH_TEXT, OPENCODE_AUTH_JSON] {
        let opencode = from_opencode_auth_list(text).unwrap();
        assert_eq!(opencode.label, None, "opencode names no person on a stored key");
        assert_eq!(opencode.plan, None);
        assert_eq!(opencode.source, "opencode auth list");
    }
    // The same answers through real discovery against a fake CLI peer,
    // including the app server exchange and the notification it sends first.
    for (provider, label, plan, source) in [
        ("claude", Some("owner@example.com"), Some("pro"), "claude auth status"),
        ("codex", Some("owner@example.com"), Some("plus"), "codex app-server account/read"),
        ("opencode", None, None, "opencode auth list"),
    ] {
        let runtime = discover_one(provider, Some(fake_cli()), &[]).await.unwrap();
        assert_eq!(runtime.status, "online", "{provider} must pass the protocol probe");
        let account = runtime.account.unwrap_or_else(|| panic!("{provider} must report an account"));
        assert_eq!(account.label.as_deref(), label, "{provider} label");
        assert_eq!(account.plan.as_deref(), plan, "{provider} plan");
        assert_eq!(account.source, source, "{provider} source");
    }
}

#[tokio::test]
async fn an_unknown_account_stays_unknown() {
    assert_eq!(from_claude_status(""), None);
    assert_eq!(from_claude_status("not json"), None);
    assert_eq!(from_claude_status(r#"{"loggedIn":false,"email":"owner@example.com"}"#), None);
    assert_eq!(from_claude_status(r#"{"email":"owner@example.com"}"#), None, "no loggedIn is not a yes");
    assert_eq!(from_codex_account_read(&json!({"account":null,"requiresOpenaiAuth":true})), None);
    assert_eq!(from_codex_account_read(&json!({"requiresOpenaiAuth":true})), None);
    assert_eq!(from_codex_account_read(&json!({"account":{"type":"martian","email":"owner@example.com"}})), None);
    assert_eq!(from_opencode_auth_list(""), None);
    assert_eq!(from_opencode_auth_list("Nothing configured yet"), None);
    // A ChatGPT account without an email still says which command answered.
    let nameless = from_codex_account_read(&json!({"account":{"type":"chatgpt","email":null,"planType":"plus"}})).unwrap();
    assert_eq!(nameless.label, None);
    assert_eq!(nameless.plan.as_deref(), Some("plus"));
    // An API-key account has no person behind it, so nothing is invented.
    let api_key = from_codex_account_read(&json!({"account":{"type":"apiKey"},"requiresOpenaiAuth":false})).unwrap();
    assert_eq!(api_key.label, None);
    assert_eq!(api_key.plan, None);
    // A CLI that says nothing about its account leaves the row at null.
    let runtime = discover_one("codex", Some(fake_cli()), &[]).await.unwrap();
    assert!(runtime.account.is_some(), "the fake peer does answer, so null here would be a different bug");
}

#[tokio::test]
async fn no_token_is_read_for_the_account() {
    // The strongest form of the rule: the account module has no file access
    // and names no credential location, so it cannot read a token at all.
    let source = include_str!("../src/account.rs");
    let forbidden = [
        ["std", "::fs"].concat(),
        ["File", "::open"].concat(),
        ["auth", ".json"].concat(),
        ["credential", "s.json"].concat(),
        ["CODEX", "_HOME"].concat(),
        ["CLAUDE", "_CONFIG_DIR"].concat(),
    ];
    for needle in forbidden {
        assert!(!source.contains(&needle), "the account module must not touch {needle:?}");
    }
    // A token that happens to sit in the CLI's own output is not copied.
    let leaky = r#"{"loggedIn":true,"email":"owner@example.com","subscriptionType":"pro","accessToken":"sk-fixture-NEVER-FORWARD","organization":{"apiKey":"sk-fixture-NEVER-FORWARD"}}"#;
    let account = from_claude_status(leaky).unwrap();
    let forwarded = serde_json::to_string(&account).unwrap();
    assert!(!forwarded.contains("sk-fixture"));
    assert!(!forwarded.contains("NEVER-FORWARD"));
    assert_eq!(account.label.as_deref(), Some("owner@example.com"));
}
