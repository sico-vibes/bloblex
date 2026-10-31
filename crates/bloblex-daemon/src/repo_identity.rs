//! Phase 4: a project's repository identity, so the same repository is found on another machine.
//!
//! A handoff moves a conversation from one computer to another, and the copy of the code has to be
//! the same repository on both. An identity is `host/path` — `github.com/owner/repo` — with the host
//! always lower case and the path lower case only on the hosts that ignore case. **A remote URL can
//! hold a credential**, so it is reduced to a host and a path here: the `repo_identity` column never
//! holds a user, a password or a token, and the address that crosses to a device comes from
//! `safe_remote_url`, which removes them. No URL is ever logged.
//!
//! `project.list` never runs git. The identity is read from the folder when a project is created,
//! updated or cloned, and once for every project at startup (`sweep`), in a `git remote get-url
//! origin` that has a 5-second limit and never reads, passes or prints a credential.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// The longest a `git remote get-url origin` may take: it reads one line of the repository's config.
const LIMIT: Duration = Duration::from_secs(5);
/// What that command may print. An address is short; anything longer is not one.
const MAX_URL_BYTES: usize = 8 * 1024;
/// The hosts whose repository path ignores case. Everywhere else a path keeps the case it has.
const LOWER_PATH_HOSTS: [&str; 3] = ["github.com", "gitlab.com", "bitbucket.org"];
/// The longest identity this code accepts or returns.
const MAX_IDENTITY_CHARS: usize = 400;

/// One repository as this machine sees it: the identity, and the address with no credential in it.
pub(crate) struct Remote {
    pub(crate) identity: String,
    /// The address with no credential in it. Nothing in section 3 reads it; the handoff package does.
    #[allow(dead_code)]
    pub(crate) url: String,
}

/// What reading a folder's `origin` gave. **Unknown is not None:** a read that could not run (git
/// missing) or timed out is no evidence about the folder, so a stored identity is kept. Only a read
/// that finished and found no usable address clears one.
pub(crate) enum Origin {
    /// A repository address this code understands.
    Found(Remote),
    /// git ran and there is no usable `origin`: not a repository, no origin, or a local path.
    None,
    /// The read could not finish.
    Unknown,
}

/// Test only: make every read report `Unknown`, so the "a failed read keeps what is stored" path can
/// be checked without a real timeout. Guarded by `phase4_projects_tests::IDENTITY_READS`.
#[cfg(test)]
pub(crate) static TEST_FAIL_READS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `git@GitHub.com:Owner/Repo.git`, `ssh://git@github.com/Owner/Repo` and
/// `https://user:token@github.com/Owner/Repo/` all give `github.com/owner/repo`. The host is always
/// lower case; the path only for GitHub, GitLab and Bitbucket. A non-default port stays
/// (`git.example.com:8443/team/app`). A local path, a `file:` URL or an unknown scheme gives `None`.
pub(crate) fn normalize_remote(url: &str) -> Option<String> {
    let (host, port, path) = split_remote(url)?;
    let path = if LOWER_PATH_HOSTS.contains(&host.as_str()) { path.to_ascii_lowercase() } else { path };
    let identity = match port { Some(port) => format!("{host}:{port}/{path}"), None => format!("{host}/{path}") };
    (identity.chars().count() <= MAX_IDENTITY_CHARS).then_some(identity)
}

/// The address with any user and password removed, so it can cross to another machine. The one user
/// that stays is the literal `git` — `git@host:path` and `ssh://git@host/path` — because it is part
/// of the address, not a credential, and ssh needs it. Any other user, and every password, is dropped
/// (`ghp_token123@github.com:owner/repo` → `github.com:owner/repo`). A query and a fragment go too.
/// Anything that is not a remote address — a local path, `file:`, an unknown scheme — gives `None`.
pub(crate) fn safe_remote_url(url: &str) -> Option<String> {
    let url = url.trim();
    split_remote(url)?;
    let Some(scheme_end) = url.find("://") else {
        // `[user@]host[:port]:path`: only the literal `git` user is kept.
        let (authority, rest) = url.split_once(':')?;
        let host_port = authority.rsplit('@').next().unwrap_or(authority);
        let user = authority.rsplit_once('@').map(|(user, _)| user);
        return Some(if user == Some("git") { format!("{authority}:{rest}") } else { format!("{host_port}:{rest}") });
    };
    let scheme = url[..scheme_end].to_ascii_lowercase();
    let rest = &url[scheme_end + 3..];
    let split = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (host, port) = host_and_port(&rest[..split])?;
    let user = rest[..split].rsplit_once('@').map(|(userinfo, _)| userinfo).filter(|userinfo| *userinfo == "git");
    let path = rest[split..].split(['?', '#']).next().unwrap_or("");
    let user = match user { Some(user) => format!("{user}@"), None => String::new() };
    Some(match port { Some(port) => format!("{scheme}://{user}{host}:{port}{path}"), None => format!("{scheme}://{user}{host}{path}") })
}

/// The host (lower case), the port when it is not the scheme's default, and the repository path.
fn split_remote(url: &str) -> Option<(String, Option<u16>, String)> {
    let url = url.trim();
    if url.is_empty() || url.chars().count() > 2048 || url.contains('\\') || url.chars().any(char::is_control) { return None; }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("file:") || lower.starts_with("ext::") { return None; }
    if let Some(scheme_end) = url.find("://") {
        let default = default_port(&lower[..scheme_end])?;
        let rest = &url[scheme_end + 3..];
        let split = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let (host, port) = host_and_port(&rest[..split])?;
        return Some((host, port.filter(|port| *port != default), clean_path(&rest[split..])?));
    }
    // `[user@]host:path` and `host:8443/path`, but never a Windows drive (`C:\repo`, `c:/repo`).
    let (authority, rest) = url.split_once(':')?;
    if authority.chars().count() < 2 || authority.contains('/') { return None; }
    let (host, named_port) = host_and_port(authority)?;
    // A number right after the colon is a port, as in `git.example.com:8443/team/app`. This form is
    // ssh's, so `host:22/path` loses the port like any other default one.
    let (port, path) = match rest.split_once('/') {
        Some((digits, tail)) if !digits.is_empty() && digits.len() <= 5 && digits.bytes().all(|byte| byte.is_ascii_digit()) => (Some(digits.parse::<u16>().ok()?), tail),
        _ => (named_port, rest),
    };
    Some((host, port.filter(|port| *port != 22), clean_path(path)?))
}

/// The scheme's default port, or `None` for a scheme this code does not read as a remote.
fn default_port(scheme: &str) -> Option<u16> {
    match scheme {
        "https" | "git+https" => Some(443),
        "http" | "git+http" => Some(80),
        "ssh" | "git" | "git+ssh" | "ssh+git" => Some(22),
        _ => None,
    }
}

/// The host, lower-cased, and the port when the authority names one. Any user and password in the
/// authority is dropped before anything else: a credential is never part of an identity.
fn host_and_port(authority: &str) -> Option<(String, Option<u16>)> {
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = match host_port.rsplit_once(':') { Some((host, port)) => (host, Some(port)), None => (host_port, None) };
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) { return None; }
    let port = match port {
        None | Some("") => None,
        Some(port) if port.len() <= 5 && port.bytes().all(|byte| byte.is_ascii_digit()) => Some(port.parse::<u16>().ok()?),
        Some(_) => return None,
    };
    Some((host.to_ascii_lowercase(), port))
}

/// The repository path: no leading or trailing slash, no `.git`, no query or fragment, no `..`, and
/// no `@` or `:` that could have carried a credential.
fn clean_path(path: &str) -> Option<String> {
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let path = path.trim_matches('/');
    let path = match path.char_indices().rev().nth(3) {
        Some((index, _)) if path[index..].eq_ignore_ascii_case(".git") => &path[..index],
        _ => path,
    };
    let path = path.trim_end_matches('/');
    if path.is_empty() || path.chars().any(char::is_control) || path.contains('@') || path.contains(':') { return None; }
    if path.split('/').any(|part| part.is_empty() || part == "." || part == "..") { return None; }
    Some(path.to_owned())
}

/// The comparison form of an identity: a bare `host/path` as it is stored, with the host lower-cased
/// and the path lower-cased for the hosts that ignore case.
fn identity_key(identity: &str) -> String {
    let identity = identity.trim().trim_end_matches('/');
    let identity = identity.strip_suffix(".git").unwrap_or(identity);
    match identity.split_once('/') {
        Some((host, path)) => {
            let host = host.to_ascii_lowercase();
            let path = if LOWER_PATH_HOSTS.contains(&host.as_str()) { path.to_ascii_lowercase() } else { path.to_owned() };
            format!("{host}/{path}")
        }
        None => identity.to_ascii_lowercase(),
    }
}

/// The folder's `origin` remote, as an identity and as an address with no credential in it. A folder
/// that is not a git repository, or whose `origin` is a local path, has neither.
pub(crate) async fn of_folder(folder: &Path) -> Origin {
    if !folder.is_dir() { return Origin::None; }
    let url = match origin_url(folder).await { Ok(url) => url, Err(()) => return Origin::Unknown };
    let Some(url) = url else { return Origin::None };
    match (normalize_remote(&url), safe_remote_url(&url)) {
        (Some(identity), Some(url)) => Origin::Found(Remote { identity, url }),
        // An `origin` this code cannot read as a repository address is no identity at all.
        _ => Origin::None,
    }
}

/// The read for the folder a project points at, for `project.create` and `project.update`. A missing
/// or blank folder has none.
pub(crate) async fn of_path(path: Option<&str>) -> Origin {
    let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else { return Origin::None };
    of_folder(Path::new(path)).await
}

/// `git -C <folder> remote get-url origin`: no shell, no credential handling, one line, 5 seconds.
/// `Ok(None)` is git's own answer — no repository, or no `origin`. `Err(())` is the read not finishing
/// (git could not start, or it ran past the limit), which says nothing about the folder.
async fn origin_url(folder: &Path) -> Result<Option<String>, ()> {
    #[cfg(test)]
    {
        if TEST_FAIL_READS.load(std::sync::atomic::Ordering::SeqCst) { return Err(()); }
    }
    let mut command = tokio::process::Command::new("git");
    command
        .arg("--no-optional-locks").arg("-C").arg(folder).args(["remote", "get-url", "origin"])
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY").env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_NAMESPACE").env_remove("GIT_PAGER")
        .env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|_| ())?;
    let mut stdout = child.stdout.take().ok_or(())?;
    let mut buffer = Vec::new();
    use tokio::io::AsyncReadExt;
    if tokio::time::timeout(LIMIT, (&mut stdout).take(MAX_URL_BYTES as u64).read_to_end(&mut buffer)).await.is_err() {
        let _ = child.kill().await;
        return Err(());
    }
    match tokio::time::timeout(LIMIT, child.wait()).await {
        Ok(Ok(status)) if !status.success() => return Ok(None),
        Ok(Ok(_)) => {}
        _ => {
            let _ = child.kill().await;
            return Err(());
        }
    }
    let text = String::from_utf8_lossy(&buffer);
    let line = text.lines().next().unwrap_or("").trim();
    Ok((!line.is_empty()).then(|| line.to_owned()))
}

/// Fill in every project's identity once at startup, so a project registered before this version has
/// one. Off the runtime and one folder at a time; a folder that is not there is left as it is, and a
/// read that could not finish keeps whatever is stored.
pub(crate) async fn sweep(st: &AppState) {
    let Ok(projects) = st.db.project_list() else { return };
    for project in projects {
        let Some(id) = project["id"].as_str() else { continue };
        let Some(folder) = project["path"].as_str().filter(|folder| !folder.trim().is_empty()) else { continue };
        if !Path::new(folder).is_dir() { continue; }
        let identity = match of_folder(Path::new(folder)).await {
            Origin::Found(remote) => Some(remote.identity),
            Origin::None => None,
            Origin::Unknown => continue,
        };
        if project["repoIdentity"].as_str() != identity.as_deref() {
            let _ = st.db.project_set_repo_identity(id, identity.as_deref());
        }
    }
}

/// `project.findByIdentity {identity}` → `{project}` or `{project: null}`: the first project whose
/// folder is there, so a project whose copy has been deleted never wins. No git runs.
pub(crate) fn find_by_identity(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let identity = p["identity"].as_str().map(str::trim).filter(|identity| !identity.is_empty() && identity.chars().count() <= MAX_IDENTITY_CHARS)
        .ok_or_else(|| derr("invalid_argument", "identity is required", StatusCode::BAD_REQUEST))?;
    let wanted = identity_key(identity);
    let projects = st.db.project_list().map_err(crate::agent_error)?;
    let found = projects.into_iter().find(|project| {
        project["repoIdentity"].as_str().is_some_and(|stored| identity_key(stored) == wanted)
            && project["path"].as_str().is_some_and(|folder| Path::new(folder).is_dir())
    });
    Ok(json!({"project": found}))
}
