//! Phase 5: named account folders, one per provider.
//!
//! An account is a config folder the CLI is pointed at by environment. The
//! default account is the CLI's own folder: it has no row and cannot be
//! deleted. Nothing here reads a token or a credential file; who is signed in
//! comes from the CLI's own output (`bloblex_runtime`, section 1).

use crate::{agent_error, derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Mutex, OnceLock}};

/// What the last read said about one account, kept in memory only. `list` opens
/// the Settings page, so it never runs a CLI: an account not yet checked shows
/// `signedIn: false` with no label and no plan.
fn cache() -> &'static Mutex<HashMap<String, Value>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember(id: &str, label: Option<&str>, plan: Option<&str>, signed_in: bool) {
    if let Ok(mut map) = cache().lock() {
        map.insert(id.to_owned(), json!({"label": label, "plan": plan, "signedIn": signed_in}));
    }
}

fn remembered(id: &str) -> Value {
    cache()
        .lock()
        .ok()
        .and_then(|map| map.get(id).cloned())
        .unwrap_or_else(|| json!({"label": null, "plan": null, "signedIn": false}))
}

fn forget(id: &str) {
    if let Ok(mut map) = cache().lock() {
        map.remove(id);
    }
}

/// The providers an account may belong to.
pub const PROVIDERS: [&str; 3] = ["claude", "codex", "opencode"];
const MAX_NAME_CHARS: usize = 60;

/// The environment that points one provider at its own folder. This is the one
/// table: spawn, sign-in and check all read it.
pub fn account_environment(provider: &str, folder: &Path) -> Vec<(String, String)> {
    let path = folder.to_string_lossy().into_owned();
    match provider {
        "claude" => vec![("CLAUDE_CONFIG_DIR".into(), path)],
        "codex" => vec![("CODEX_HOME".into(), path)],
        // OpenCode reads both; pointing them at the same folder keeps every
        // account file inside it.
        "opencode" => vec![("XDG_CONFIG_HOME".into(), path.clone()), ("XDG_DATA_HOME".into(), path)],
        _ => Vec::new(),
    }
}

/// The PowerShell one-liner the owner runs: the environment is set for that one
/// command only, and the line holds no secret. A single quote is doubled, as
/// PowerShell does.
pub fn sign_in_command(provider: &str, folder: &Path) -> String {
    let quoted = format!("'{}'", folder.to_string_lossy().replace('\'', "''"));
    let prefix = account_environment(provider, folder)
        .iter()
        .map(|(name, _)| format!("$env:{name}={quoted}"))
        .collect::<Vec<_>>()
        .join("; ");
    let command = match provider {
        "claude" => "claude auth login",
        "codex" => "codex login",
        "opencode" => "opencode auth login",
        _ => "",
    };
    format!("{prefix}; {command}")
}

/// `<data>/accounts/<id>`: the only place an account folder may live, which is
/// what makes a delete safe.
pub fn account_folder(data_dir: &Path, id: &str) -> Option<PathBuf> {
    let safe = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    safe.then(|| data_dir.join("accounts").join(id))
}

fn data_dir(st: &AppState) -> Result<PathBuf, DispatchError> {
    st.team.data_dir.lock().ok().and_then(|dir| dir.clone())
        .ok_or_else(|| derr("internal", "The Bitbots data folder is not available.", StatusCode::INTERNAL_SERVER_ERROR))
}

/// A valid provider and a 1 to 60 character name, or `invalid_argument`.
fn check_provider(provider: &str) -> Result<(), DispatchError> {
    PROVIDERS.contains(&provider)
        .then_some(())
        .ok_or_else(|| derr("invalid_argument", "That is not a provider Bitbots knows.", StatusCode::BAD_REQUEST))
}

fn check_name(name: &str) -> Result<String, DispatchError> {
    let trimmed = name.trim();
    let characters = trimmed.chars().count();
    if characters == 0 || characters > MAX_NAME_CHARS {
        return Err(derr("invalid_argument", "A name is 1 to 60 characters.", StatusCode::BAD_REQUEST));
    }
    Ok(trimmed.to_owned())
}

/// The account's own answer, freshly read. A failure is `null`, never a guess.
async fn read_one(provider: &str, folder: &Path, runtime: Option<&Value>) -> Option<bloblex_runtime::AccountInfo> {
    let (executable, args) = match runtime {
        Some(row) => (PathBuf::from(row["executablePath"].as_str().unwrap_or("")), row["launchArgs"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default()),
        None => (PathBuf::from(provider), Vec::new()),
    };
    bloblex_runtime::read_account(provider, &executable, &args, &account_environment(provider, folder)).await
}

/// The runtime row for a provider, for its executable and launch arguments.
async fn runtime_for(st: &AppState, provider: &str) -> Option<Value> {
    st.runtimes.read().await.iter().find(|row| row["provider"] == provider).cloned()
}

fn signed_in(account: &Option<bloblex_runtime::AccountInfo>, runtime: Option<&Value>) -> bool {
    if account.is_some() {
        return true;
    }
    runtime.is_some_and(|row| row["authState"] == "authenticated")
}

/// `account.check`: ask the CLI again for one account and remember the answer.
pub async fn check_account(st: &AppState, id: &str) -> Result<Value, DispatchError> {
    let row = st.db.account_get(id).map_err(|_| derr("internal", "Could not read the account.", StatusCode::INTERNAL_SERVER_ERROR))?.ok_or_else(|| derr("not_found", "Account not found.", StatusCode::NOT_FOUND))?;
    let provider = row["provider"].as_str().unwrap_or("").to_owned();
    let dir = data_dir(st)?;
    let folder = account_folder(&dir, id).ok_or_else(|| derr("internal", "Could not read the account folder.", StatusCode::INTERNAL_SERVER_ERROR))?;
    let runtime = runtime_for(st, &provider).await;
    let account = read_one(&provider, &folder, runtime.as_ref()).await;
    let bots = st.db.account_bots(id).map_err(agent_error)?;
    let signed = signed_in(&account, runtime.as_ref());
    remember(id, account.as_ref().and_then(|a| a.label.as_deref()), account.as_ref().and_then(|a| a.plan.as_deref()), signed);
    Ok(json!({
        "account": {
            "id": row["id"], "provider": provider, "name": row["name"],
            "signedIn": signed,
            "label": account.as_ref().and_then(|a| a.label.clone()),
            "plan": account.as_ref().and_then(|a| a.plan.clone()),
            "bots": bots.len(),
        }
    }))
}

/// Phase 5: a bot's account must exist and belong to the bot's own provider.
pub async fn check_bot_account(st: &AppState, account: Option<&str>, runtime_id: Option<&str>) -> Result<(), DispatchError> {
    let Some(account) = account else { return Ok(()) };
    let live = st.runtimes.read().await.clone();
    let rows = if live.is_empty() { st.db.runtimes().unwrap_or_default() } else { live };
    let provider = runtime_id
        .and_then(|id| rows.into_iter().find(|row| row["id"].as_str() == Some(id)))
        .and_then(|row| row["provider"].as_str().map(str::to_owned));
    let usable = provider.is_some_and(|provider| st.db.account_for_provider(account, &provider).ok().flatten().is_some());
    if !usable {
        return Err(derr("invalid_argument", "That account isn't one this bot's coding agent can use.", StatusCode::BAD_REQUEST));
    }
    Ok(())
}

pub async fn dispatch(st: &AppState, method: &str, params: &Value) -> Result<Value, DispatchError> {
    match method {
        "account.list" => {
            let rows = st.db.account_list().map_err(|_| derr("internal", "Could not read the accounts.", StatusCode::INTERNAL_SERVER_ERROR))?;
            let accounts = rows.iter().map(|row| {
                let id = row["id"].as_str().unwrap_or("");
                let seen = remembered(id);
                json!({
                    "id": row["id"], "provider": row["provider"], "name": row["name"],
                    "signedIn": seen["signedIn"],
                    "label": seen["label"],
                    "plan": seen["plan"],
                    "bots": row["bots"],
                })
            }).collect::<Vec<_>>();
            Ok(json!({"accounts": accounts}))
        }
        "account.create" => {
            let provider = params["provider"].as_str().unwrap_or("");
            check_provider(provider)?;
            let name = check_name(params["name"].as_str().unwrap_or(""))?;
            let row = st.db.account_create(provider, &name).map_err(|_| derr("internal", "Could not create the account.", StatusCode::INTERNAL_SERVER_ERROR))?;
            let dir = data_dir(st)?;
            let folder = account_folder(&dir, row["id"].as_str().unwrap_or("")).ok_or_else(|| derr("internal", "Could not create the account folder.", StatusCode::INTERNAL_SERVER_ERROR))?;
            std::fs::create_dir_all(&folder).map_err(|_| derr("internal", "Could not create the account folder.", StatusCode::INTERNAL_SERVER_ERROR))?;
            crate::remote::native::apply_key_permissions(&folder);
            // A fresh folder holds no sign-in yet, and the first read is what
            // says so. It runs off the reply so Settings opens at once.
            let id = row["id"].as_str().unwrap_or("").to_owned();
            let background = st.clone();
            tokio::spawn(async move {
                let _ = check_account(&background, &id).await;
            });
            Ok(json!({"account": {"id": row["id"], "provider": provider, "name": name, "bots": 0}}))
        }
        "account.rename" => {
            let id = params["id"].as_str().unwrap_or("");
            let name = check_name(params["name"].as_str().unwrap_or(""))?;
            let row = st.db.account_rename(id, &name).map_err(|_| derr("internal", "Could not rename the account.", StatusCode::INTERNAL_SERVER_ERROR))?;
            let row = row.ok_or_else(|| derr("not_found", "Account not found.", StatusCode::NOT_FOUND))?;
            Ok(json!({"account": row}))
        }
        "account.delete" => {
            if params["confirm"].as_bool() != Some(true) {
                return Err(derr("invalid_argument", "Deleting an account needs `confirm: true`.", StatusCode::BAD_REQUEST));
            }
            let id = params["id"].as_str().unwrap_or("");
            let bots = st.db.account_bots(id).map_err(|_| derr("internal", "Could not read the account.", StatusCode::INTERNAL_SERVER_ERROR))?;
            // A turn still running on one of those bots keeps the account.
            let active = st.active_turns.lock().await;
            for session in active.keys() {
                let on_it = st.db.session_detail(session).ok().and_then(|row| row["agentId"].as_str().map(str::to_owned)).is_some_and(|agent| bots.contains(&agent));
                if on_it {
                    return Err(derr("conflict", "A turn is running on this account.", StatusCode::CONFLICT));
                }
            }
            drop(active);
            let removed = st.db.account_delete(id).map_err(|_| derr("internal", "Could not delete the account.", StatusCode::INTERNAL_SERVER_ERROR))?;
            if !removed {
                return Err(derr("not_found", "Account not found.", StatusCode::NOT_FOUND));
            }
            // Only a folder inside `<data>/accounts` is ever removed.
            forget(id);
            if let Ok(dir) = data_dir(st) {
                if let Some(folder) = account_folder(&dir, id) {
                    if folder.starts_with(dir.join("accounts")) {
                        let _ = std::fs::remove_dir_all(&folder);
                    }
                }
            }
            Ok(json!({"deleted": true}))
        }
        "account.signIn" => {
            let id = params["id"].as_str().unwrap_or("");
            let row = st.db.account_get(id).map_err(|_| derr("internal", "Could not read the account.", StatusCode::INTERNAL_SERVER_ERROR))?.ok_or_else(|| derr("not_found", "Account not found.", StatusCode::NOT_FOUND))?;
            let provider = row["provider"].as_str().unwrap_or("");
            let dir = data_dir(st)?;
            let folder = account_folder(&dir, id).ok_or_else(|| derr("internal", "Could not read the account folder.", StatusCode::INTERNAL_SERVER_ERROR))?;
            Ok(json!({"command": sign_in_command(provider, &folder)}))
        }
        "account.check" => check_account(st, params["id"].as_str().unwrap_or("")).await,
        _ => Err(derr("unsupported", "unknown account method", StatusCode::NOT_FOUND)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phase2a_tests::state;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bitbots-account-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn with_data_dir(st: &crate::AppState, dir: &Path) {
        *st.team.data_dir.lock().unwrap() = Some(dir.to_path_buf());
    }

    async fn new_account(st: &crate::AppState, provider: &str, name: &str) -> String {
        let reply = dispatch(st, "account.create", &json!({"provider": provider, "name": name})).await.unwrap();
        reply["account"]["id"].as_str().unwrap().to_owned()
    }

    async fn new_bot(st: &crate::AppState, name: &str, account: Option<&str>) -> Value {
        let mut fields = json!({"name": name, "runtimeId": "rt-test"});
        if let Some(account) = account {
            fields["accountId"] = json!(account);
        }
        crate::dispatch(st, "agent.create", fields).await.unwrap()["agent"].clone()
    }

    #[tokio::test]
    async fn accounts_create_a_private_folder() {
        let (st, _rx) = state();
        let dir = temp_dir("create");
        with_data_dir(&st, &dir);
        let id = new_account(&st, "codex", "Work").await;
        let folder = dir.join("accounts").join(&id);
        assert!(folder.is_dir(), "the account folder must exist at {}", folder.display());
        assert!(folder.starts_with(dir.join("accounts")));
        let command = dispatch(&st, "account.signIn", &json!({"id": id})).await.unwrap();
        let command = command["command"].as_str().unwrap().to_owned();
        assert!(command.starts_with("$env:CODEX_HOME='"), "{command}");
        assert!(command.ends_with("; codex login"), "{command}");
        assert!(command.contains(&format!("'{}'", folder.display())), "{command}");
    }

    #[tokio::test]
    async fn delete_needs_confirm_and_moves_bots_to_default() {
        let (st, _rx) = state();
        let dir = temp_dir("delete");
        with_data_dir(&st, &dir);
        let id = new_account(&st, "codex", "Work").await;
        let bot = new_bot(&st, "Rae", Some(&id)).await;
        assert_eq!(bot["accountId"], json!(id));
        let refused = dispatch(&st, "account.delete", &json!({"id": id})).await.unwrap_err();
        assert_eq!(refused.1.code, "invalid_argument");
        assert!(dir.join("accounts").join(&id).is_dir(), "a refused delete keeps the folder");
        let listed = dispatch(&st, "account.list", &json!({})).await.unwrap();
        assert_eq!(listed["accounts"][0]["bots"], json!(1));
        dispatch(&st, "account.delete", &json!({"id": id, "confirm": true})).await.unwrap();
        let after = crate::dispatch(&st, "agent.get", json!({"agentId": bot["id"]})).await.unwrap();
        assert_eq!(after["agent"]["accountId"], Value::Null, "a deleted account sends its bots back to the default");
        assert!(!dir.join("accounts").join(&id).exists());
    }

    #[tokio::test]
    async fn delete_refuses_a_running_turn() {
        let (st, _rx) = state();
        let dir = temp_dir("running");
        with_data_dir(&st, &dir);
        let id = new_account(&st, "codex", "Work").await;
        let bot = new_bot(&st, "Rae", Some(&id)).await;
        st.db.create_session_for_agent("s-account", "rt-test", "codex", ".", "Chat", bot["id"].as_str()).unwrap();
        st.active_turns.lock().await.insert("s-account".into(), "t-account".into());
        let refused = dispatch(&st, "account.delete", &json!({"id": id, "confirm": true})).await.unwrap_err();
        assert_eq!(refused.1.code, "conflict");
        assert!(dir.join("accounts").join(&id).is_dir());
        st.active_turns.lock().await.clear();
        dispatch(&st, "account.delete", &json!({"id": id, "confirm": true})).await.unwrap();
    }

    #[tokio::test]
    async fn delete_only_removes_inside_the_accounts_folder() {
        let dir = Path::new("C:/data");
        assert!(account_folder(dir, "../../Windows").is_none(), "a path is never built from a name the caller controls");
        assert!(account_folder(dir, "").is_none());
        assert!(account_folder(dir, "a/b").is_none());
        let inside = account_folder(dir, "0b3c4d5e").unwrap();
        assert_eq!(inside, dir.join("accounts").join("0b3c4d5e"));
        assert!(inside.starts_with(dir.join("accounts")));
    }

    #[tokio::test]
    async fn sign_in_command_quotes_the_folder() {
        let folder = Path::new("C:/Bitbots data/it's mine");
        let command = sign_in_command("claude", folder);
        assert!(command.starts_with("$env:CLAUDE_CONFIG_DIR='C:/Bitbots data/it''s mine'; "), "{command}");
        assert!(command.ends_with("claude auth login"), "{command}");
        assert!(!command.contains('"'), "the folder is quoted with PowerShell single quotes: {command}");
        let opencode = sign_in_command("opencode", folder);
        assert!(opencode.contains("$env:XDG_CONFIG_HOME=") && opencode.contains("$env:XDG_DATA_HOME="), "{opencode}");
    }

    #[tokio::test]
    async fn a_bot_cannot_use_another_providers_account() {
        let (st, _rx) = state();
        let dir = temp_dir("provider");
        with_data_dir(&st, &dir);
        let claude = new_account(&st, "claude", "Personal").await;
        let refused = crate::dispatch(&st, "agent.create", json!({"name": "Rae", "runtimeId": "rt-test", "accountId": claude})).await.unwrap_err();
        assert_eq!(refused.1.code, "invalid_argument");
        let bot = new_bot(&st, "Rae", None).await;
        let refused = crate::dispatch(&st, "agent.update", json!({"agentId": bot["id"], "accountId": "no-such-account"})).await.unwrap_err();
        assert_eq!(refused.1.code, "invalid_argument");
    }

    #[tokio::test]
    async fn the_account_environment_reaches_the_spawn() {
        let (st, _rx) = state();
        let dir = temp_dir("spawn");
        with_data_dir(&st, &dir);
        let id = new_account(&st, "codex", "Work").await;
        let bot = new_bot(&st, "Rae", Some(&id)).await;
        let options = crate::exec_options_for_session(&st, &json!({"agentId": bot["id"], "provider": "codex"})).unwrap();
        assert_eq!(options.env.get("CODEX_HOME"), Some(&dir.join("accounts").join(&id).display().to_string()));
    }

    /// Two bots on different accounts never share a provider process: the
    /// account's variables join `options.env`, and `options.env` sits inside the
    /// shared-process key of the Codex and ACP adapters (their `process_key`
    /// builders, pinned by those crates' own sharing tests).
    #[tokio::test]
    async fn two_accounts_never_share_a_process() {
        let (st, _rx) = state();
        let dir = temp_dir("share");
        with_data_dir(&st, &dir);
        let work = new_account(&st, "codex", "Work").await;
        let home = new_account(&st, "codex", "Home").await;
        let first = new_bot(&st, "Rae", Some(&work)).await;
        let second = new_bot(&st, "Sol", Some(&home)).await;
        let a = crate::exec_options_for_session(&st, &json!({"agentId": first["id"], "provider": "codex"})).unwrap();
        let b = crate::exec_options_for_session(&st, &json!({"agentId": second["id"], "provider": "codex"})).unwrap();
        assert_ne!(a.env.get("CODEX_HOME"), b.env.get("CODEX_HOME"), "each account is its own process key");
        assert_ne!(a.env, b.env);
    }

    #[tokio::test]
    async fn account_ids_never_travel_in_a_backup() {
        let account = "0b3c4d5e-0000-4000-8000-000000000000";
        let agent = json!({"id": "a1", "name": "Rae", "runtimeId": "rt-test", "customEnv": {"TERM": "xterm"}, "accountId": account});
        let exported = crate::backup::export_bot(&agent, &[]);
        assert!(!exported.to_string().contains(account), "a backup carries no account id: {exported}");
        assert!(exported.get("accountId").is_none());
        // A restored bot is created without one, so it lands on the default account.
        let (st, _rx) = state();
        let restored = crate::dispatch(&st, "agent.create", json!({"name": "Rae", "runtimeId": "rt-test"})).await.unwrap();
        assert_eq!(restored["agent"]["accountId"], Value::Null);
    }
}
