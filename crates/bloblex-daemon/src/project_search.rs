//! Phase 3: find a file, or a line, in a project.
//!
//! `project.files.search` ranks file paths against a query; `project.content.search` finds the lines
//! that match. Both name a conversation or a project — never a folder — and both answer empty rather
//! than an error when there is no folder to look in. In a repository the list comes from git, so
//! `.gitignore` is respected and untracked files are included; outside one, a bounded walk does the
//! same job. Every command is an argument list with no shell, runs off the runtime, has a time limit
//! and `GIT_TERMINAL_PROMPT=0`, and its output is read only to build the answer, never logged. A file
//! whose name says it holds a secret is left out of both answers.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The most files one search may read.
const MAX_FILES: usize = 50_000;
/// How long a file list is reused before it is read again.
const CACHE_TTL: Duration = Duration::from_secs(15);
/// How many folders keep a cached list.
const CACHE_FOLDERS: usize = 8;
/// The longest a git command or a walk may take.
const SEARCH_LIMIT: Duration = Duration::from_secs(10);
/// Folders a walk never goes into, besides hidden ones and `*-bitbots`.
const SKIP_FOLDERS: [&str; 4] = ["node_modules", "target", "dist", "vendor"];
/// The largest file the walk reads, and how much of it counts as text.
const MAX_TEXT_BYTES: u64 = 1024 * 1024;
/// How much of a file is checked for a NUL byte before it is treated as binary.
const BINARY_SNIFF: usize = 8 * 1024;
/// How much a match may score, per character and as a bonus.
const PER_CHAR: i64 = 1;
const BONUS_CONSECUTIVE: i64 = 8;
const BONUS_SEGMENT_START: i64 = 6;
const BONUS_FILE_NAME: i64 = 10;

fn invalid(message: &str) -> DispatchError {
    derr("invalid_argument", message, StatusCode::BAD_REQUEST)
}

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "project.files.search" => files(st, p).await,
        "project.content.search" => content(st, p).await,
        _ => Err(derr("not_found", "unknown search method", StatusCode::NOT_FOUND)),
    }
}

/// The folder a search looks in: the conversation's, else the project's. Never the client's.
fn folder(st: &AppState, p: &Value) -> Option<PathBuf> {
    if let Some(id) = p["sessionId"].as_str().filter(|id| !id.is_empty()) {
        let path = st.db.session_detail(id).ok()?.get("projectPath").and_then(Value::as_str).map(PathBuf::from)?;
        return path.is_dir().then_some(path);
    }
    if let Some(id) = p["projectId"].as_str().filter(|id| !id.is_empty()) {
        let path = st.db.project_get(id).ok()?.get("path").and_then(Value::as_str).map(PathBuf::from)?;
        return path.is_dir().then_some(path);
    }
    None
}

/// A cached file list for one folder, its source and whether it was cut short.
struct Listing {
    read: Instant,
    paths: Vec<String>,
    source: &'static str,
    truncated: bool,
}

fn cache() -> &'static Mutex<Vec<(String, Listing)>> {
    static CACHE: std::sync::OnceLock<Mutex<Vec<(String, Listing)>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// The files of a folder, from git in a repository and from a walk otherwise. Reused for 15 seconds,
/// so typing a query does not read the disk again for every keystroke.
async fn listing(folder: &Path) -> (Vec<String>, &'static str, bool) {
    let key = crate::worktree::normalize(folder);
    if let Ok(list) = cache().lock() {
        let found = list.iter().find(|(id, _)| id == &key).map(|(_, listing)| listing).filter(|listing| listing.read.elapsed() < CACHE_TTL);
        if let Some(found) = found { return (found.paths.clone(), found.source, found.truncated); }
    }
    let dir = folder.to_path_buf();
    let (paths, source, truncated) = tokio::task::spawn_blocking(move || read_files(&dir)).await.unwrap_or((Vec::new(), "walk", false));
    if let Ok(mut list) = cache().lock() {
        list.retain(|(id, _)| id != &key);
        list.insert(0, (key, Listing { read: Instant::now(), paths: paths.clone(), source, truncated }));
        list.retain(|(_, listing)| listing.read.elapsed() < CACHE_TTL);
        list.truncate(CACHE_FOLDERS);
    }
    (paths, source, truncated)
}

/// Whether the folder is a repository, worked out without starting git.
fn is_repository(folder: &Path) -> bool { folder.join(".git").exists() }

/// Every file of a folder, as relative paths with forward slashes.
fn read_files(folder: &Path) -> (Vec<String>, &'static str, bool) {
    if is_repository(folder) {
        if let Some(listed) = git_ls_files(folder) {
            let truncated = listed.len() >= MAX_FILES;
            let mut paths = listed;
            paths.truncate(MAX_FILES);
            paths.retain(|path| !crate::media::names_a_secret(Path::new(path)));
            return (paths, "git", truncated);
        }
    }
    let mut paths = Vec::new();
    let mut truncated = false;
    walk_files(folder, folder, &mut paths, &mut truncated, Instant::now() + SEARCH_LIMIT);
    paths.retain(|path| !crate::media::names_a_secret(Path::new(path)));
    (paths, "walk", truncated)
}

/// `git ls-files -co --exclude-standard`: tracked and untracked, with the ignore rules applied.
fn git_ls_files(folder: &Path) -> Option<Vec<String>> {
    let output = crate::experiments::git_command()
        .arg("--no-optional-locks").arg("-C").arg(folder)
        .args(["ls-files", "-co", "--exclude-standard", "-z"])
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null())
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY").env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0")
        .output().ok()?;
    if !output.status.success() { return None; }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut paths: Vec<String> = text.split('\0').filter(|path| !path.is_empty()).map(|path| path.replace('\\', "/")).collect();
    paths.sort();
    paths.dedup();
    Some(paths)
}

/// The files under a folder, relative to it, skipping what a search may never read.
fn walk_files(root: &Path, dir: &Path, out: &mut Vec<String>, truncated: &mut bool, deadline: Instant) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES || Instant::now() > deadline { *truncated = true; return; }
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() { continue; }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if file_type.is_dir() {
            if name.starts_with('.') || SKIP_FOLDERS.contains(&name.as_str()) || name.ends_with("-bitbots") { continue; }
            walk_files(root, &entry.path(), out, truncated, deadline);
        } else if file_type.is_file() {
            if let Ok(relative) = entry.path().strip_prefix(root) {
                out.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

async fn files(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let query: String = p["query"].as_str().unwrap_or("").chars().take(200).collect();
    let limit = p["limit"].as_u64().unwrap_or(20).clamp(1, 50) as usize;
    let Some(folder) = folder(st, p) else { return Ok(json!({"files": [], "truncated": false, "source": "walk"})) };
    let (paths, source, listing_truncated) = listing(&folder).await;
    let mut scored: Vec<(Value, i64, usize)> = Vec::new();
    for path in paths {
        let Some((score, matches)) = rank(&path, &query) else { continue };
        let name = path.rsplit('/').next().unwrap_or(&path).to_owned();
        let length = path.chars().count();
        scored.push((json!({"path": path, "name": name, "score": score, "matches": matches}), score, length));
    }
    scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.2.cmp(&b.2)).then(a.0["path"].as_str().unwrap_or("").cmp(b.0["path"].as_str().unwrap_or(""))));
    let truncated = listing_truncated || scored.len() > limit;
    scored.truncate(limit);
    Ok(json!({"files": scored.into_iter().map(|(file, _, _)| file).collect::<Vec<_>>(), "truncated": truncated, "source": source}))
}

/// How well a path answers a query: a fuzzy subsequence, preferring a match in the file name, run of
/// characters and the start of a segment. `None` when the query is not there at all, and the character
/// indexes of the match in the path.
fn rank(path: &str, query: &str) -> Option<(i64, Vec<usize>)> {
    let hay: Vec<char> = path.chars().collect();
    let needle: Vec<char> = query.chars().collect();
    if needle.is_empty() { return Some((0, Vec::new())); }
    let name_start = path.rfind('/').map(|byte| path[..byte].chars().count() + 1).unwrap_or(0);
    let mut matches = Vec::with_capacity(needle.len());
    let mut score = 0i64;
    let mut index = 0usize;
    let mut previous: Option<usize> = None;
    for (position, character) in hay.iter().enumerate() {
        if index >= needle.len() { break; }
        if !same(*character, needle[index]) { continue; }
        score += PER_CHAR;
        if position == 0 || matches!(hay[position - 1], '/' | '\\') { score += BONUS_SEGMENT_START; }
        if position >= name_start { score += BONUS_FILE_NAME; }
        if previous.is_some_and(|last| last + 1 == position) { score += BONUS_CONSECUTIVE; }
        previous = Some(position);
        matches.push(position);
        index += 1;
    }
    (index == needle.len()).then_some((score, matches))
}

/// One character of the query against one of the path, ignoring ASCII case only.
fn same(path: char, query: char) -> bool {
    path == query || (path.is_ascii() && query.is_ascii() && path.eq_ignore_ascii_case(&query))
}

async fn content(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let query = p["query"].as_str().filter(|query| !query.is_empty() && query.chars().count() <= 200)
        .ok_or_else(|| invalid("Type something to look for, up to 200 characters."))?
        .to_owned();
    let limit = p["limit"].as_u64().unwrap_or(100).clamp(1, 500) as usize;
    let case_sensitive = p["caseSensitive"] == true;
    let regex = p["regex"] == true;
    if regex {
        // The pattern is checked here, so a bad one is a plain reason rather than a failed command.
        let built = regex::RegexBuilder::new(&query).case_insensitive(!case_sensitive).build();
        if built.is_err() { return Ok(json!({"results": [], "truncated": false, "source": "walk", "reason": "That isn't a valid search pattern."})); }
    }
    let Some(folder) = folder(st, p) else { return Ok(json!({"results": [], "truncated": false, "source": "walk", "reason": Value::Null})) };
    let dir = folder.clone();
    let wanted = query.clone();
    let found = tokio::task::spawn_blocking(move || {
        if is_repository(&dir) {
            match git_grep(&dir, &wanted, case_sensitive, regex, limit) {
                Some(answer) => answer,
                None => walk_grep(&dir, &wanted, case_sensitive, regex, limit),
            }
        } else {
            walk_grep(&dir, &wanted, case_sensitive, regex, limit)
        }
    }).await.unwrap_or_default();
    Ok(json!({"results": found.results, "truncated": found.truncated, "source": found.source, "reason": found.reason}))
}

/// What a content search found, and whether it stopped early.
#[derive(Default)]
struct FoundLines {
    results: Vec<Value>,
    truncated: bool,
    source: &'static str,
    reason: Value,
}

/// `git grep -n -I --untracked --exclude-standard [-i] [-F|-E] -e <query> --`, with a time limit that
/// keeps whatever it had already printed.
fn git_grep(folder: &Path, query: &str, case_sensitive: bool, regex: bool, limit: usize) -> Option<FoundLines> {
    use std::io::Read;
    let mut command = crate::experiments::git_command();
    command.arg("--no-optional-locks").arg("-C").arg(folder)
        .args(["grep", "--no-color", "-n", "-I", "--untracked", "--exclude-standard"]);
    if !case_sensitive { command.arg("-i"); }
    command.arg(if regex { "-E" } else { "-F" }).arg("-e").arg(query).arg("--")
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null())
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY").env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0");
    let mut child = command.spawn().ok()?;
    // grep a match is exit 0, nothing found is 1, a real failure is 2 or more.
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    buffer.extend_from_slice(&chunk[..read]);
                    if buffer.len() > 8 * 1024 * 1024 { break; }
                }
            }
        }
        let _ = sender.send(buffer);
    });
    let collected = receiver.recv_timeout(SEARCH_LIMIT);
    let killed = collected.is_err();
    let bytes = collected.unwrap_or_default();
    let _ = child.kill();
    let mut lines: Vec<String> = String::from_utf8_lossy(&bytes).lines().map(str::to_owned).collect();
    let partial = killed || !bytes.ends_with(b"\n");
    let mut found = FoundLines { source: "git", truncated: false, ..FoundLines::default() };
    for line in lines.drain(..) {
        let Some((path, rest)) = line.split_once(':') else { continue };
        let Some((number, text)) = rest.split_once(':') else { continue };
        let Ok(number) = number.parse::<u64>() else { continue };
        let path = path.replace('\\', "/");
        if crate::media::names_a_secret(Path::new(&path)) { continue; }
        found.results.push(line_result(&path, number, text));
        if found.results.len() >= limit { found.truncated = true; break; }
    }
    if partial { found.truncated = true; }
    Some(found)
}

/// One result: the path, the line number and the trimmed, bounded line.
fn line_result(path: &str, line: u64, text: &str) -> Value {
    let preview: String = text.trim().chars().take(200).collect();
    json!({"path": path, "line": line, "preview": preview})
}

/// A walk for the lines that match: text files of at most 1 MiB, at most 5,000 of them, in 10 seconds.
fn walk_grep(folder: &Path, query: &str, case_sensitive: bool, regex: bool, limit: usize) -> FoundLines {
    let mut found = FoundLines { source: "walk", ..FoundLines::default() };
    let mut paths = Vec::new();
    let mut truncated = false;
    let deadline = Instant::now() + SEARCH_LIMIT;
    walk_files(folder, folder, &mut paths, &mut truncated, deadline);
    if paths.len() > 5_000 { paths.truncate(5_000); truncated = true; }
    let matcher = if regex {
        regex::RegexBuilder::new(query).case_insensitive(!case_sensitive).build().ok()
    } else {
        None
    };
    let needle = if case_sensitive { query.to_owned() } else { query.to_lowercase() };
    'files: for path in paths {
        if Instant::now() > deadline || found.results.len() >= limit { truncated = true; break; }
        if crate::media::names_a_secret(Path::new(&path)) { continue; }
        let full = folder.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let Ok(meta) = std::fs::metadata(&full) else { continue };
        if !meta.is_file() || meta.len() > MAX_TEXT_BYTES { continue; }
        let Ok(bytes) = std::fs::read(&full) else { continue };
        if bytes.len() > BINARY_SNIFF && bytes[..BINARY_SNIFF].contains(&0) { continue; }
        let text = String::from_utf8_lossy(&bytes);
        for (index, line) in text.lines().enumerate() {
            let hit = match &matcher {
                Some(matcher) => matcher.is_match(line),
                None => if case_sensitive { line.contains(&needle) } else { line.to_lowercase().contains(&needle) },
            };
            if !hit { continue; }
            found.results.push(line_result(&path, index as u64 + 1, line));
            if found.results.len() >= limit { truncated = true; break 'files; }
        }
    }
    found.truncated |= truncated;
    found
}
