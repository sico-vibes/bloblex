use crate::quota::{normalize_claude_quota, normalize_opencode_go_quota, ProviderQuota};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};
use zeroize::Zeroize;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OPENCODE_GO_USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";
const MAX_CREDENTIAL_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFailure {
    NoCredentials,
    Unauthorized,
    NoSubscription,
    Unavailable,
    Protocol,
}

#[derive(Deserialize)]
struct ClaudeCredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    oauth: Option<ClaudeOAuthCredentials>,
}

#[derive(Deserialize)]
struct ClaudeOAuthCredentials {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
}

fn parse_claude_access_token(raw: &str) -> Option<String> {
    let value: ClaudeCredentialsFile = serde_json::from_str(raw).ok()?;
    let mut token = value.oauth?.access_token?;
    if token.trim().is_empty() {
        token.zeroize();
        return None;
    }
    let trimmed = token.trim().to_owned();
    token.zeroize();
    Some(trimmed)
}

fn claude_credentials_path(home: &Path, config_dir: Option<&Path>) -> PathBuf {
    config_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".claude"))
        .join(".credentials.json")
}

fn read_claude_access_token_at(path: &Path) -> Result<String, SourceFailure> {
    let metadata = fs::metadata(path).map_err(|_| SourceFailure::NoCredentials)?;
    if metadata.len() > MAX_CREDENTIAL_FILE_BYTES {
        return Err(SourceFailure::Protocol);
    }
    let mut raw = fs::read_to_string(path).map_err(|_| SourceFailure::NoCredentials)?;
    let token = parse_claude_access_token(&raw);
    raw.zeroize();
    token.ok_or(SourceFailure::NoCredentials)
}

fn current_claude_access_token() -> Result<String, SourceFailure> {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or(SourceFailure::NoCredentials)?;
    let config_dir = env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    read_claude_access_token_at(&claude_credentials_path(&home, config_dir.as_deref()))
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
        .map(|home| {
            PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("opencode")
        })
}

#[derive(Deserialize)]
struct OpenCodeKeyValue {
    #[serde(rename = "type")]
    kind: Option<String>,
    key: Option<String>,
}

#[derive(Deserialize)]
struct OpenCodeAuthFile {
    #[serde(rename = "opencode-go")]
    go: Option<OpenCodeKeyValue>,
}

fn parsed_opencode_key(mut value: OpenCodeKeyValue, expected: &[&str]) -> Option<String> {
    if value
        .kind
        .as_deref()
        .is_some_and(|kind| !expected.contains(&kind))
    {
        value.kind.zeroize();
        value.key.zeroize();
        return None;
    }
    value.kind.zeroize();
    let mut key = value.key?;
    if key.trim().is_empty() {
        key.zeroize();
        return None;
    }
    let trimmed = key.trim().to_owned();
    key.zeroize();
    Some(trimmed)
}

fn key_from_auth_file(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_CREDENTIAL_FILE_BYTES {
        return None;
    }
    let mut raw = fs::read(path).ok()?;
    let file = serde_json::from_slice::<OpenCodeAuthFile>(&raw);
    raw.zeroize();
    let file = file.ok()?;
    parsed_opencode_key(file.go?, &["api"])
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
    let Ok(entries) = fs::read_dir(dir) else {
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

fn key_from_credential_db(path: &Path) -> Option<String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.pragma_update(None, "query_only", "ON").ok()?;
    let mut raw: Option<String> = conn.query_row(
        "SELECT value FROM credential WHERE integration_id='opencode-go' AND active=1 ORDER BY time_created DESC LIMIT 1",
        [],
        |row| row.get(0),
    ).optional().ok()?;
    let value = serde_json::from_str::<OpenCodeKeyValue>(raw.as_deref()?);
    if let Some(raw) = &mut raw {
        raw.zeroize();
    }
    let value = value.ok()?;
    parsed_opencode_key(value, &["key", "api"])
}

fn resolve_opencode_saved_go_key(environment: &[(String, String)]) -> Option<String> {
    let data_dir = opencode_data_dir(&environment);
    if let Some(data_dir) = &data_dir {
        if let Some(key) = key_from_auth_file(&data_dir.join("auth.json")) {
            return Some(key);
        }
    }
    for path in opencode_db_paths(&environment) {
        if let Some(key) = key_from_credential_db(&path) {
            return Some(key);
        }
    }
    None
}

#[cfg(test)]
fn resolve_opencode_go_key(environment: &[(String, String)]) -> Option<String> {
    if let Some(key) = environment
        .iter()
        .find(|(name, value)| name == "OPENCODE_API_KEY" && !value.trim().is_empty())
        .map(|(_, value)| value.trim().to_owned())
    {
        return Some(key);
    }
    resolve_opencode_saved_go_key(environment)
}

fn current_opencode_go_key() -> Result<String, SourceFailure> {
    let environment = ["USERPROFILE", "HOME", "XDG_DATA_HOME", "OPENCODE_DB"]
        .into_iter()
        .filter_map(|name| {
            env::var_os(name).map(|value| (name.to_owned(), value.to_string_lossy().into_owned()))
        })
        .collect::<Vec<_>>();
    let mut api_key = env::var("OPENCODE_API_KEY").ok();
    if let Some(key) = api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        let resolved = key.to_owned();
        api_key.zeroize();
        return Ok(resolved);
    }
    api_key.zeroize();
    resolve_opencode_saved_go_key(&environment).ok_or(SourceFailure::NoCredentials)
}

fn client() -> Result<reqwest::Client, SourceFailure> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| SourceFailure::Unavailable)
}

fn usage_request(
    client: &reqwest::Client,
    url: &str,
    bearer: &str,
    claude: bool,
) -> Result<reqwest::Request, SourceFailure> {
    let mut request = client
        .get(url)
        .bearer_auth(bearer)
        .header(reqwest::header::ACCEPT, "application/json");
    if claude {
        request = request
            .header("anthropic-beta", "oauth-2025-04-20")
            .header(reqwest::header::USER_AGENT, "claude-code/2.1.0");
    }

    request.build().map_err(|_| SourceFailure::Unavailable)
}

fn decode_usage_response(
    status: reqwest::StatusCode,
    body: &[u8],
    claude: bool,
) -> Result<Value, SourceFailure> {
    match status.as_u16() {
        401 => return Err(SourceFailure::Unauthorized),
        403 if !claude => return Err(SourceFailure::NoSubscription),
        403 => return Err(SourceFailure::Unauthorized),
        status if !(200..300).contains(&status) => return Err(SourceFailure::Unavailable),
        _ => {}
    }
    serde_json::from_slice(body).map_err(|_| SourceFailure::Protocol)
}

async fn get_json(
    client: &reqwest::Client,
    url: &str,
    bearer: &str,
    claude: bool,
) -> Result<Value, SourceFailure> {
    let response = client
        .execute(usage_request(client, url, bearer, claude)?)
        .await
        .map_err(|_| SourceFailure::Unavailable)?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|_| SourceFailure::Unavailable)?;
    decode_usage_response(status, &body, claude)
}

pub async fn fetch_claude_quota(
    runtime_id: String,
    fetched_at: String,
) -> Result<ProviderQuota, SourceFailure> {
    fetch_claude_quota_from(
        &runtime_id,
        &fetched_at,
        current_claude_access_token()?,
        CLAUDE_USAGE_URL,
    )
    .await
}

async fn fetch_claude_quota_from(
    runtime_id: &str,
    fetched_at: &str,
    token: String,
    url: &str,
) -> Result<ProviderQuota, SourceFailure> {
    let client = client()?;
    let mut token = token;
    let response = get_json(&client, url, &token, true).await;
    token.zeroize();
    let response = response?;
    normalize_claude_quota(runtime_id, &response, fetched_at).ok_or(SourceFailure::Protocol)
}

pub async fn fetch_opencode_go_quota(
    runtime_id: String,
    fetched_at: String,
) -> Result<ProviderQuota, SourceFailure> {
    fetch_opencode_go_quota_from(
        &runtime_id,
        &fetched_at,
        current_opencode_go_key()?,
        OPENCODE_GO_USAGE_URL,
    )
    .await
}

async fn fetch_opencode_go_quota_from(
    runtime_id: &str,
    fetched_at: &str,
    key: String,
    url: &str,
) -> Result<ProviderQuota, SourceFailure> {
    let client = client()?;
    let mut key = key;
    let response = get_json(&client, url, &key, false).await;
    key.zeroize();
    let response = response?;
    normalize_opencode_go_quota(runtime_id, &response, fetched_at).ok_or(SourceFailure::Protocol)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!("bloblex-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn claude_file_reader_accepts_only_access_token_and_never_returns_other_fields() {
        let dir = temp_dir("claude-credentials");
        let path = dir.join(".credentials.json");
        fs::write(&path, r#"{"claudeAiOauth":{"accessToken":"oauth-secret","refreshToken":"must-not-return","expiresAt":999}}"#).unwrap();
        assert_eq!(read_claude_access_token_at(&path).unwrap(), "oauth-secret");
        assert_eq!(
            claude_credentials_path(Path::new("C:/Users/u"), None),
            Path::new("C:/Users/u/.claude/.credentials.json")
        );
        assert_eq!(
            claude_credentials_path(Path::new("C:/Users/u"), Some(Path::new("D:/claude-config"))),
            Path::new("D:/claude-config/.credentials.json")
        );
        fs::write(&path, "not-json").unwrap();
        assert_eq!(
            read_claude_access_token_at(&path),
            Err(SourceFailure::NoCredentials)
        );
        fs::remove_file(&path).unwrap();
        assert_eq!(
            read_claude_access_token_at(&path),
            Err(SourceFailure::NoCredentials)
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn opencode_resolves_go_keys_from_auth_json_and_read_only_credential_db() {
        let dir = temp_dir("opencode-auth");
        let data_dir = dir.join(".local").join("share").join("opencode");
        fs::create_dir_all(&data_dir).unwrap();
        let auth = data_dir.join("auth.json");
        fs::write(&auth, r#"{"opencode":{"type":"api","key":"zen-key"},"opencode-go":{"type":"api","key":"go-key"}}"#).unwrap();
        assert_eq!(key_from_auth_file(&auth).as_deref(), Some("go-key"));
        let malformed_auth = data_dir.join("malformed-auth.json");
        fs::write(
            &malformed_auth,
            r#"{"opencode-go":{"type":"oauth","key":"wrong"}}"#,
        )
        .unwrap();
        assert_eq!(key_from_auth_file(&malformed_auth), None);
        let auth_env = vec![("USERPROFILE".into(), dir.to_string_lossy().to_string())];
        assert_eq!(
            resolve_opencode_go_key(&auth_env).as_deref(),
            Some("go-key")
        );
        let env_preferred = vec![
            ("USERPROFILE".into(), dir.to_string_lossy().to_string()),
            ("OPENCODE_API_KEY".into(), "environment-key".into()),
        ];
        assert_eq!(
            resolve_opencode_go_key(&env_preferred).as_deref(),
            Some("environment-key")
        );
        assert_eq!(
            opencode_data_dir(&[("USERPROFILE".into(), "C:/Users/u".into())]),
            Some(PathBuf::from("C:/Users/u/.local/share/opencode"))
        );
        assert_eq!(
            opencode_data_dir(&[("XDG_DATA_HOME".into(), "D:/data".into())]),
            Some(PathBuf::from("D:/data/opencode"))
        );

        let db = dir.join("opencode.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TABLE credential(integration_id TEXT,value TEXT,active INTEGER,time_created INTEGER);") .unwrap();
            conn.execute(
                "INSERT INTO credential VALUES('opencode-go',?1,1,1)",
                params![r#"{"type":"key","key":"db-go-key"}"#],
            )
            .unwrap();
        }
        assert_eq!(key_from_credential_db(&db).as_deref(), Some("db-go-key"));
        let db_env = vec![("OPENCODE_DB".into(), db.to_string_lossy().to_string())];
        assert_eq!(
            resolve_opencode_go_key(&db_env).as_deref(),
            Some("db-go-key")
        );
        let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM credential", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(conn.execute("UPDATE credential SET active=0", []).is_err());
        let env_fallback = vec![("OPENCODE_API_KEY".into(), "env-key".into())];
        assert_eq!(
            resolve_opencode_go_key(&env_fallback).as_deref(),
            Some("env-key")
        );
        assert_eq!(resolve_opencode_go_key(&[]), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_http_requests_and_fake_responses_are_normalized_without_secrets() {
        let secret = "test-go-secret-never-emit";
        let client = reqwest::Client::new();
        let go_request = usage_request(&client, OPENCODE_GO_USAGE_URL, secret, false).unwrap();
        assert_eq!(
            go_request.headers()[reqwest::header::AUTHORIZATION],
            format!("Bearer {secret}")
        );
        assert_eq!(
            go_request.headers()[reqwest::header::ACCEPT],
            "application/json"
        );
        let claude_request = usage_request(&client, CLAUDE_USAGE_URL, secret, true).unwrap();
        assert_eq!(
            claude_request.headers()[reqwest::header::AUTHORIZATION],
            format!("Bearer {secret}")
        );
        assert_eq!(
            claude_request.headers()["anthropic-beta"],
            "oauth-2025-04-20"
        );

        let go_body = br#"{"usage":{"rolling":{"status":"ok","percent":34,"resetsAt":"2026-10-06T14:00:00Z"}}}"#;
        let go = decode_usage_response(reqwest::StatusCode::OK, go_body, false).unwrap();
        assert_eq!(
            normalize_opencode_go_quota("rt", &go, "now")
                .unwrap()
                .limits[0]
                .primary
                .as_ref()
                .unwrap()
                .used_percent,
            34
        );
        let claude_body =
            br#"{"five_hour":{"utilization":34.0,"resets_at":"2026-10-06T14:00:00Z"}}"#;
        let claude = decode_usage_response(reqwest::StatusCode::OK, claude_body, true).unwrap();
        assert_eq!(
            normalize_claude_quota("rt", &claude, "now").unwrap().limits[0]
                .primary
                .as_ref()
                .unwrap()
                .used_percent,
            34
        );

        assert_eq!(
            decode_usage_response(
                reqwest::StatusCode::UNAUTHORIZED,
                br#"{"error":"credential-body-secret"}"#,
                false
            ),
            Err(SourceFailure::Unauthorized)
        );
        assert_eq!(
            decode_usage_response(
                reqwest::StatusCode::FORBIDDEN,
                br#"{"error":"body-secret"}"#,
                false
            ),
            Err(SourceFailure::NoSubscription)
        );
        assert_eq!(
            decode_usage_response(
                reqwest::StatusCode::FORBIDDEN,
                br#"{"error":"body-secret"}"#,
                true
            ),
            Err(SourceFailure::Unauthorized)
        );
        assert_eq!(
            decode_usage_response(
                reqwest::StatusCode::OK,
                b"malformed body credential-like",
                false
            ),
            Err(SourceFailure::Protocol)
        );
        assert!(!format!("{:?}", SourceFailure::Unauthorized).contains(secret));
        assert!(!format!("{:?}", SourceFailure::NoSubscription).contains("body-secret"));
    }
}
