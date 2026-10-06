use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf};
use thiserror::Error;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode { #[default] Ask, Auto, Bypass }
impl ApprovalMode {
    pub fn as_str(self) -> &'static str { match self { Self::Ask => "ask", Self::Auto => "auto", Self::Bypass => "bypass" } }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionClassification { pub allowed: bool, pub category: &'static str, pub summary: String }
pub fn permission_summary(tool_kind:&str,raw:&Value)->String{
    let kind=tool_kind.to_ascii_lowercase();
    if ["shell","bash","command","terminal"].contains(&kind.as_str()) {let s=raw.get("command").and_then(Value::as_str).or_else(||raw.get("rawInput").and_then(Value::as_str)).or_else(||raw["toolCall"]["rawInput"].as_str()).or_else(||raw["params"]["toolCall"]["rawInput"].as_str()).or_else(||raw.as_str()).unwrap_or("");return safe_summary(&kind,&command_head(s));}
    fn path(v:&Value)->Option<&str>{match v{Value::Object(m)=>m.iter().find_map(|(k,v)|if ["path","file_path","filePath","target","uri"].contains(&k.as_str()){v.as_str()}else{path(v)}),Value::Array(a)=>a.iter().find_map(path),_=>None}}
    safe_summary(&kind,path(raw).unwrap_or("unknown"))
}

/// Conservative, daemon-callable classifier. Any missing or ambiguous evidence fails closed.
pub fn classify_permission(
    tool_kind: &str,
    raw: &Value,
    project: &std::path::Path,
) -> PermissionClassification {
    let kind = tool_kind.to_ascii_lowercase();
    let read = ["read", "glob", "grep", "list", "search", "notebook_read"];
    let edit = ["edit", "write", "file_edit", "file_write"];
    let mut paths = Vec::new();

    fn collect(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    if ["path", "file_path", "filePath", "target", "uri"].contains(&key.as_str()) {
                        if let Some(path) = child.as_str() {
                            out.push(path.to_owned());
                        }
                    } else {
                        collect(child, out);
                    }
                }
            }
            Value::Array(values) => {
                for child in values {
                    collect(child, out);
                }
            }
            _ => {}
        }
    }

    collect(raw, &mut paths);
    let project = match project.canonicalize() {
        Ok(path) => path,
        Err(_) => return denied(&kind, "unknown"),
    };
    let worktree = project
        .ancestors()
        .find(|path| path.join(".git").exists())
        .map(std::path::Path::to_path_buf);

    if read.contains(&kind.as_str()) || edit.contains(&kind.as_str()) {
        if paths.is_empty() {
            return denied(&kind, "unknown");
        }
        for input in &paths {
            if !safe_command_path(input, &project, worktree.as_deref(), read.contains(&kind.as_str())) {
                return denied(&kind, input);
            }
        }
        return PermissionClassification {
            allowed: true,
            category: if read.contains(&kind.as_str()) { "READ" } else { "EDIT" },
            summary: safe_summary(&kind, paths.first().map(String::as_str).unwrap_or("")),
        };
    }

    if ["shell", "bash", "command", "terminal"].contains(&kind.as_str()) {
        let command = raw
            .get("command")
            .and_then(Value::as_str)
            .or_else(|| raw.get("rawInput").and_then(Value::as_str))
            .or_else(|| raw["toolCall"]["rawInput"].as_str())
            .or_else(|| raw["params"]["toolCall"]["rawInput"].as_str())
            .or_else(|| raw.as_str())
            .unwrap_or("");
        let summary = command_head(command);
        if command.is_empty() || has_shell_operator(command) {
            return denied(&kind, &summary);
        }
        let Some(words) = tokenize_command(command) else {
            return denied(&kind, &summary);
        };
        if words.is_empty() {
            return denied(&kind, "unknown");
        }
        let head = normalize_executable(&words[0]);
        let safe = match head.as_str() {
            "git" => safe_git(&words),
            "ls" | "dir" => words.iter().skip(1).all(|word| {
                !word.starts_with('-') && safe_command_path(word, &project, worktree.as_deref(), true)
            }),
            "pwd" | "echo" => true,
            "rg" | "grep" => safe_search(&words, &project, worktree.as_deref()),
            "cat" | "type" => {
                !unsafe_command_arguments(&words)
                    && !words.iter().skip(1).any(|word| word.starts_with('-'))
                    && words.iter().skip(1).all(|word| {
                        safe_command_path(word, &project, worktree.as_deref(), true)
                    })
            }
            "find" => safe_find(&words, &project, worktree.as_deref()),
            "node" => words.get(1).is_some_and(|arg| arg == "--version" || arg == "-v"),
            _ => false,
        };
        if safe {
            return PermissionClassification {
                allowed: true,
                category: "SAFE_COMMANDS",
                summary: safe_summary(&kind, &summary),
            };
        }
        return denied(&kind, &summary);
    }
    denied(&kind, "unknown")
}

fn has_shell_operator(command: &str) -> bool {
    ["&&", "||", ";", "|", ">", "<", "`", "$", "%", "!", "&", "\n", "\r", "\t", "\u{000b}", "\u{000c}"]
        .iter()
        .any(|operator| command.contains(operator))
}

fn tokenize_command(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for ch in command.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(active) = quote {
            if ch == active {
                quote = None;
            } else {
                current.push(ch);
            }
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
        } else if ch.is_whitespace() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if escaped || quote.is_some() {
        return None;
    }
    if !current.is_empty() {
        words.push(current);
    }
    Some(words)
}

fn normalize_executable(word: &str) -> String {
    let base = word.rsplit(['/', '\\']).next().unwrap_or(word);
    let lower = base.to_ascii_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_owned()
}

fn safe_git(words: &[String]) -> bool {
    if unsafe_command_arguments(words) {
        return false;
    }
    let Some(subcommand) = words.get(1).map(|word| word.to_ascii_lowercase()) else {
        return false;
    };
    if words.iter().skip(2).any(|word| {
        word == "-c"
            || word.starts_with("-c=")
            || ["--output", "--ext-diff", "--textconv", "--git-dir", "--work-tree", "-C"]
                .contains(&word.as_str())
            || word.starts_with("--output=")
            || word.starts_with("--git-dir=")
            || word.starts_with("--work-tree=")
    }) {
        return false;
    }
    if subcommand == "branch" {
        return words.iter().skip(2).all(|word| {
            ["-a", "-r", "-v", "-vv", "--list", "--show-current"].contains(&word.as_str())
        });
    }
    ["status", "diff", "log", "show", "rev-parse"].contains(&subcommand.as_str())
        && words.iter().skip(2).all(|word| !word.starts_with('-') || safe_relative_arg(word))
}

fn safe_search(words: &[String], project: &std::path::Path, worktree: Option<&std::path::Path>) -> bool {
    if unsafe_command_arguments(words) {
        return false;
    }
    let command = normalize_executable(&words[0]);
    let mut index = 1;
    let mut operands = Vec::new();
    let mut options_ended = false;
    let mut saw_pattern = false;

    while index < words.len() {
        let word = words[index].as_str();
        if options_ended {
            operands.push(word);
            index += 1;
            continue;
        }
        if word == "--" {
            options_ended = true;
            index += 1;
            continue;
        }
        if !word.starts_with('-') || word == "-" {
            if !saw_pattern {
                saw_pattern = true;
            } else {
                operands.push(word);
            }
            index += 1;
            continue;
        }

        let option = word.to_ascii_lowercase();
        if ["--pre", "--pre-glob", "--hostname-bin", "--search-zip", "-z"]
            .contains(&option.as_str())
            || option.starts_with("--pre=")
            || option.starts_with("--pre-glob=")
            || option.starts_with("--hostname-bin=")
            || option.starts_with("--search-zip=")
        {
            return false;
        }

        if command == "rg" {
            if [
                "-i", "-n", "-h", "-v", "-w", "-x", "-f", "-s", "-F", "-S", "-H",
                "--heading", "--no-heading", "--line-number", "--no-line-number", "--column",
                "--no-column", "--hidden", "--no-ignore", "--no-messages", "--count",
                "--count-matches", "--files", "--files-with-matches", "--files-without-match",
            ]
                .contains(&option.as_str())
            {
                if option == "-f" { return false; }
                index += 1;
                continue;
            }
            if [
                "-e", "--regexp", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-A",
                "--after-context", "-B", "--before-context", "-C", "--context", "-m",
                "--max-count", "--maxdepth", "--sort",
            ]
                .contains(&option.as_str())
            {
                index += 1;
                if index >= words.len() || words[index].starts_with('-') { return false; }
                if matches!(option.as_str(), "-g" | "--glob")
                    && !safe_glob_arg(&words[index])
                {
                    return false;
                }
                index += 1;
                continue;
            }
            if ["-e", "-g", "-t", "-T", "-A", "-B", "-C", "-m"]
                .iter()
                .any(|prefix| option.starts_with(prefix) && option.len() > prefix.len())
            {
                if option.starts_with("-g") && !safe_glob_arg(&word[2..]) { return false; }
                index += 1;
                continue;
            }
            if [
                "--regexp=", "--glob=", "--type=", "--type-not=", "--after-context=",
                "--before-context=", "--context=", "--max-count=", "--maxdepth=", "--sort=",
            ]
                .iter().any(|prefix| option.starts_with(prefix))
            {
                if let Some(glob) = option.strip_prefix("--glob=") {
                    if !safe_glob_arg(glob) { return false; }
                }
                index += 1;
                continue;
            }
            return false;
        }

        if [
            "-i", "-n", "-v", "-w", "-x", "-c", "-l", "-L", "-q", "-H", "-h", "-s", "-r",
            "-R", "-E", "-F", "--ignore-case", "--line-number", "--count", "--with-filename",
            "--no-filename", "--recursive", "--extended-regexp", "--fixed-strings",
            "--word-regexp", "--line-regexp", "--no-messages", "--color", "--colour",
        ]
            .contains(&option.as_str())
        {
            index += 1;
            continue;
        }
        if ["-e", "--regexp", "--include", "--exclude", "--include-dir", "--exclude-dir"]
            .contains(&option.as_str())
            {
                index += 1;
                if index >= words.len() || words[index].starts_with('-') { return false; }
                if matches!(option.as_str(), "--include" | "--exclude" | "--include-dir" | "--exclude-dir")
                    && !safe_glob_arg(&words[index])
                {
                    return false;
                }
                index += 1;
            continue;
        }
        if option == "-f" || option.starts_with("-f") {
            let path = if option == "-f" {
                index += 1;
                if index >= words.len() { return false; }
                words[index].as_str()
            } else {
                &word[2..]
            };
            if !safe_command_path(path, project, worktree, true) { return false; }
            index += 1;
            continue;
        }
        if ["--regexp=", "--include=", "--exclude=", "--include-dir=", "--exclude-dir="]
            .iter().any(|prefix| option.starts_with(prefix))
        {
            if ["--include=", "--exclude=", "--include-dir=", "--exclude-dir="]
                .iter()
                .any(|prefix| option.strip_prefix(prefix).is_some_and(|value| !safe_glob_arg(value)))
            {
                return false;
            }
            index += 1;
            continue;
        }
        return false;
    }

    saw_pattern && operands.iter().all(|path| safe_command_path(path, project, worktree, true))
}

fn safe_glob_arg(value: &str) -> bool {
    !value.starts_with('/')
        && !value.starts_with('\\')
        && !foreign_windows_absolute(value)
        && !value.replace('\\', "/").split('/').any(|part| part == "..")
        && !unsafe_secret_spelling(value)
}

fn safe_find(words: &[String], project: &std::path::Path, worktree: Option<&std::path::Path>) -> bool {
    if unsafe_command_arguments(words) {
        return false;
    }
    let denied_options = [
        "-ok", "-okdir", "-execdir", "-fprint", "-fprint0", "-fprintf", "-fls", "-delete",
        "-exec",
    ];
    if words.iter().skip(1).any(|word| {
        denied_options.iter().any(|bad| word.eq_ignore_ascii_case(bad))
    }) {
        return false;
    }
    let Some(root) = words.get(1) else { return false; };
    if root.starts_with('-') || !safe_command_path(root, project, worktree, true) {
        return false;
    }
    let value_options = [
        "-name", "-iname", "-path", "-ipath", "-type", "-size", "-mtime", "-mmin", "-atime",
        "-amin", "-ctime", "-cmin", "-perm", "-user", "-group", "-uid", "-gid", "-inum",
        "-links", "-maxdepth", "-mindepth", "-newer",
    ];
    let flags = [
        "-print", "-print0", "-ls", "-depth", "-empty", "-readable", "-writable", "-executable",
        "-hidden", "-true", "-false", "-prune", "-and", "-a", "-or", "-o", "!", "(", ")",
    ];
    let mut index = 2;
    while index < words.len() {
        let token = words[index].to_ascii_lowercase();
        if flags.contains(&token.as_str()) {
            index += 1;
            continue;
        }
        if value_options.contains(&token.as_str()) {
            index += 1;
            if index >= words.len() { return false; }
            let value = &words[index];
            if matches!(token.as_str(), "-path" | "-ipath") && unsafe_secret_spelling(value) {
                return false;
            }
            if token == "-newer" && !safe_command_path(value, project, worktree, true) {
                return false;
            }
            index += 1;
            continue;
        }
        return false;
    }
    true
}

fn unsafe_secret_spelling(value: &str) -> bool {
    let normalized = value.replace('\\', "/").to_ascii_lowercase();
    normalized.split('/').any(|segment| {
        segment.contains(".git")
            || segment.contains(".env")
            || segment.ends_with(".pem")
            || segment.ends_with(".key")
            || ["credential", "credentials", "token", "secret"]
                .iter()
                .any(|needle| segment.contains(needle))
    })
}

fn safe_command_path(
    input: &str,
    project: &std::path::Path,
    worktree: Option<&std::path::Path>,
    allow_worktree: bool,
) -> bool {
    if unsafe_path_spelling(input) {
        return false;
    }
    let Some(normalized) = normalize_path_spelling(input) else { return false; };
    if foreign_windows_absolute(&normalized) { return false; }
    let path = std::path::Path::new(&normalized);
    let candidate = if path.is_absolute() { path.to_path_buf() } else { project.join(path) };
    let Some(resolved) = canonicalize_target(&candidate) else { return false; };
    let in_project = path_within(&resolved, project);
    let in_worktree = allow_worktree && worktree.is_some_and(|root| path_within(&resolved, root));
    if !in_project && !in_worktree { return false; }
    let relative = resolved.strip_prefix(project).unwrap_or(&resolved).to_string_lossy().replace('\\', "/");
    let lower = relative.to_ascii_lowercase();
    if lower.split('/').any(|segment| segment == ".git") { return false; }
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    !(base.starts_with(".env")
        || [".pem", ".key"].iter().any(|suffix| base.ends_with(suffix))
        || ["credential", "credentials", "token", "secret"].iter().any(|needle| base.contains(needle)))
}
fn unsafe_command_arguments(words: &[String]) -> bool {
    words.iter().skip(1).any(|word| {
        word == "--"
            || word.starts_with('@')
            || unsafe_path_spelling(word)
            || word.chars().any(|ch| matches!(ch, '\u{2215}' | '\u{2044}' | '\u{FF0F}' | '\u{29F8}'))
    })
}
fn unsafe_path_spelling(value: &str) -> bool {
    if value == "." || value == ".." {
        return false;
    }
    if value.contains(':') || value.ends_with(['.', ' ']) {
        return true;
    }
    let base = value.rsplit(['/', '\\']).next().unwrap_or(value);
    let stem = base.split('.').next().unwrap_or(base).trim_end_matches(['.', ' ']);
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9")
        || base.contains('~')
}
fn foreign_windows_absolute(input:&str)->bool{
    #[cfg(not(windows))] {let b=input.as_bytes();return (b.len()>=3&&b[0].is_ascii_alphabetic()&&b[1]==b':'&&(b[2]==b'\\'||b[2]==b'/'))||input.starts_with("\\\\")||input.contains('\\');}
    #[cfg(windows)] {let _=input;false}
}
fn normalize_path_spelling(input:&str)->Option<String>{
    if input.is_empty()||input.contains('\0'){return None}
    let slash=input.replace('\\',"/");let bytes=slash.as_bytes();
    let (prefix,rest,absolute)=if slash.starts_with("//"){("//".to_owned(),slash.trim_start_matches('/'),true)}else if bytes.len()>=3&&bytes[0].is_ascii_alphabetic()&&bytes[1]==b':'&&bytes[2]==b'/'{(format!("{}:/",bytes[0] as char),&slash[3..],true)}else if slash.starts_with('/') {("/".to_owned(),slash.trim_start_matches('/'),true)}else{(String::new(),slash.as_str(),false)};
    let mut parts=Vec::new();for part in rest.split('/') {match part {""|"."=>{},".."=>{if parts.last().is_some_and(|p|*p!=".."){parts.pop();}else if absolute{return None}else{parts.push("..")}},_=>parts.push(part)}}
    let joined=parts.join("/");Some(if prefix=="//"{format!("//{joined}")}else if prefix.ends_with("/"){format!("{prefix}{joined}")}else if prefix.is_empty(){joined}else{format!("{prefix}{joined}")})
}
fn canonicalize_target(path:&std::path::Path)->Option<std::path::PathBuf>{
    if let Ok(p)=path.canonicalize(){return Some(p)}
    let name=path.file_name()?;let parent=path.parent()?;
    let canonical_parent=parent.canonicalize().ok()?;Some(canonical_parent.join(name))
}
fn safe_relative_arg(word:&str)->bool{let w=word.trim_matches('"');let p=std::path::Path::new(w);!p.is_absolute()&&!foreign_windows_absolute(w)&&!w.contains("..\\")&&!w.starts_with("../")}
fn path_within(path:&std::path::Path,root:&std::path::Path)->bool{
    #[cfg(windows)] {let p=path.to_string_lossy().replace('\\',"/").to_ascii_lowercase();let r=root.to_string_lossy().replace('\\',"/").trim_end_matches('/').to_ascii_lowercase();return p==r||p.strip_prefix(&r).is_some_and(|tail|tail.starts_with('/'));}
    #[cfg(not(windows))] {path.starts_with(root)}
}
fn command_head(s:&str)->String { let mut words=s.split_whitespace();let Some(first)=words.next()else{return "unknown".into()};let head=match first.to_ascii_lowercase().as_str(){"git"=>words.next().map(|sub|format!("git {sub}")),"node"=>words.next().filter(|arg|*arg=="--version"||*arg=="-v").map(|arg|format!("node {arg}")),_=>None}.unwrap_or_else(||first.to_owned());head.chars().take(120).collect() }
fn safe_summary(kind:&str,value:&str)->String { format!("{}: {}",kind.chars().take(24).collect::<String>(),value.chars().take(120).collect::<String>()) }
fn denied(kind:&str,value:&str)->PermissionClassification { PermissionClassification{allowed:false,category:"ASKED",summary:safe_summary(kind,value)} }

#[cfg(test)]
mod approval_tests {
    use super::*;
    use serde_json::json;
    use std::{fs, path::PathBuf, sync::atomic::{AtomicU64, Ordering}, time::{SystemTime, UNIX_EPOCH}};
    fn project() -> PathBuf {
        static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);
        let p = std::env::temp_dir().join(format!(
            "bloblex-policy-{}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
            NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(p.join(".git")).unwrap();
        fs::write(p.join("readme.md"), "x").unwrap();
        fs::write(p.join("edit.txt"), "x").unwrap();
        fs::write(p.join(".env.local"), "x").unwrap();
        p.canonicalize().unwrap()
    }
    #[test]
    fn classifier_table_fails_closed_and_accepts_only_safe_categories() {
        let p = project();
        fs::write(p.join("secret.pem"), "key").unwrap();
        fs::write(p.join("id_token"), "secret").unwrap();
        let cases = [
            ("read", "readme.md", true),
            ("glob", "readme.md", true),
            ("edit", "edit.txt", true),
            ("write", "edit.txt", true),
            ("read", ".env.local", false),
            ("edit", ".git/config", false),
            ("edit", "../outside", false),
        ];
        for (kind, path, expected) in cases {
            assert_eq!(
                classify_permission(kind, &json!({"path": path}), &p).allowed,
                expected,
                "file tool {kind} {path}"
            );
        }
        let commands = [
            ("git status --short", true),
            ("node --version", true),
            ("find . -name '*.rs'", true),
            ("find . -maxdepth 2 -type f", true),
            ("find . -newer ../outside", false),
            ("find . -path ./.env.local", false),
            ("find . -files0-from ../outside", false),
            ("find . -delete", false),
            ("git push", false),
            ("ls && whoami", false),
            ("echo x | sh", false),
            ("echo %PATH%", false),
            ("echo `whoami`", false),
            ("echo $(whoami)", false),
            ("echo x; dir", false),
            ("echo\twhoami", false),
            ("echo\u{000b}whoami", false),
            ("echo\u{000c}whoami", false),
            ("GIT.EXE status", true),
            ("\"git\" status", true),
            ("git branch", true),
            ("git branch -a -r -vv --list", true),
            ("git branch new-name", false),
            ("git branch -D old-name", false),
            ("git branch -m old new", false),
            ("git -c alias.x=bad status", false),
            ("git --output=out status", false),
            ("git --output out status", false),
            ("git --ext-diff diff", false),
            ("git --textconv diff", false),
            ("git --git-dir ../outside status", false),
            ("git --work-tree ../outside status", false),
            ("git -C ../outside status", false),
            ("git status -- @response", false),
            ("git show refs/heads/main:file:stream", false),
            ("git status CON", false),
            ("git status trailing. ", false),
            ("git show short~1", false),
            ("git show src／file.rs", false),
            ("rg --pre cat pattern src", false),
            ("rg --pre-glob '*.rs' cat pattern src", false),
            ("rg --hostname-bin ../outside pattern src", false),
            ("rg --search-zip pattern src", false),
            ("rg -z pattern src", false),
            ("grep -z pattern src", false),
            ("rg pattern ../outside", false),
            ("rg pattern .env.local", false),
            ("rg --glob ../outside pattern .", false),
            ("rg --glob '*.pem' pattern .", false),
            ("rg --files-from ../outside pattern .", false),
            ("rg -- pattern -- src/readme.md", false),
            ("rg pattern @patterns.txt", false),
            ("rg pattern src/file:stream", false),
            ("rg pattern NUL", false),
            ("rg pattern src/trailing.", false),
            ("rg pattern src/PROGRA~1", false),
            ("rg pattern src／readme.md", false),
            ("grep -f ../outside pattern .", false),
            ("grep -f .env.local pattern .", false),
            ("grep pattern secret.pem", false),
            ("grep pattern id_token", false),
            ("grep -- pattern -- readme.md", false),
            ("grep pattern @response.txt", false),
            ("grep pattern file:stream", false),
            ("grep pattern AUX", false),
            ("grep pattern trailing. ", false),
            ("grep pattern SHORT~1", false),
            ("grep pattern src／file", false),
            ("cat .env.local", false),
            ("type secret.pem", false),
            ("cat -- readme.md", false),
            ("cat @response.txt", false),
            ("type file:stream", false),
            ("cat NUL", false),
            ("type trailing. ", false),
            ("cat SHORT~1", false),
            ("cat src／readme.md", false),
            ("find . -name x:stream", false),
            ("find . -name NUL", false),
            ("find . -name 'trailing. ' ", false),
            ("find . -name PROGRA~1", false),
            ("find . -name src／file", false),
            ("find . -- -name '*.rs'", false),
            ("find . @response.txt", false),
            ("find . -ok echo {} \\;", false),
            ("find . -okdir echo {} \\;", false),
            ("find . -execdir echo {} \\;", false),
            ("find . -fprint out", false),
            ("find . -fprint0 out", false),
            ("find . -fprintf out '%p'", false),
            ("find . -fls out", false),
            ("find . -delete", false),
            ("find . -exec echo {} \\;", false),
            ("find . '-ExEc' echo", false),
            ("find . '-DELETE'", false),
        ];
        for (command, expected) in commands {
            let result = classify_permission("shell", &json!({"command": command}), &p);
            assert_eq!(result.allowed, expected, "command {command}");
            assert_eq!(result.category, if expected { "SAFE_COMMANDS" } else { "ASKED" });
        }
        let _ = fs::remove_dir_all(p);
    }
    #[test] fn symlink_escape_is_denied_and_path_spellings_fail_closed(){let p=project();let outside=p.parent().unwrap().join(format!("{}-outside",p.file_name().unwrap().to_string_lossy()));fs::create_dir_all(&outside).unwrap();fs::write(outside.join("secret.txt"),"x").unwrap();let link=p.join("escape");
        #[cfg(unix)] let linked=std::os::unix::fs::symlink(&outside,&link).is_ok();
        #[cfg(windows)] let linked=std::os::windows::fs::symlink_dir(&outside,&link).is_ok();
        if linked {assert!(!classify_permission("read",&json!({"path":"escape/secret.txt"}),&p).allowed);} else {eprintln!("SKIP symlink permission test: creating a directory symlink is unavailable");}
        for path in ["C:\\outside\\safe.txt","\\\\server\\share\\safe.txt","../../secret.txt"]{assert!(!classify_permission("read",&json!({"path":path}),&p).allowed,"{}",path);}
        let _=fs::remove_dir_all(p);let _=fs::remove_dir_all(outside);
    }
    #[test] fn pure_path_normalization_covers_windows_separators_unc_and_traversal(){assert_eq!(normalize_path_spelling("C:\\Repo\\A\\..\\File.txt").as_deref(),Some("C:/Repo/File.txt"));assert_eq!(normalize_path_spelling("\\\\server\\share\\folder\\..\\file.txt").as_deref(),Some("//server/share/file.txt"));assert_eq!(normalize_path_spelling("src//a/../file.rs").as_deref(),Some("src/file.rs"));assert_eq!(normalize_path_spelling("../../outside").as_deref(),Some("../../outside"));assert_eq!(normalize_path_spelling("C:/../../outside"),None);assert_eq!(normalize_path_spelling(""),None);}
    #[test] fn reads_may_cover_git_worktree_while_edits_stay_in_project(){let root=project();let child=root.join("nested");fs::create_dir(&child).unwrap();assert!(classify_permission("read",&json!({"path":"../readme.md"}),&child).allowed);assert!(!classify_permission("edit",&json!({"path":"../readme.md"}),&child).allowed);let _=fs::remove_dir_all(root);}
}

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("unsupported capability: {0}")]
    Unsupported(String),
    #[error("provider protocol error: {0}")]
    Protocol(String),
    #[error("operation timed out")]
    Timeout,
    #[error("context window is full")]
    ContextExhausted,
    #[error("provider rejected the stored session id")]
    ResumeRejected,
    #[error("provider rejected execution settings: {0}")]
    Rejected(String),
    #[error("provider process unavailable: {0}")]
    Process(String),
    #[error("operation failed: {0}")]
    Other(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSpec {
    pub runtime_id: String,
    pub provider: String,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub resume: bool,
    pub cancel: bool,
    pub permissions: bool,
    pub usage: bool,
    pub files: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub provider: String,
    pub version: Option<String>,
    pub protocol: String,
    pub authenticated: Option<bool>,
    pub capabilities: AgentCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOptions {
    #[serde(default)]
    pub approval_mode: ApprovalMode,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub service_tier: Option<String>,
    pub instructions: Option<String>,
    pub extra_args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub max_concurrency: u32,
}
impl Default for ExecOptions {
    fn default() -> Self {
        Self { approval_mode: ApprovalMode::Ask, model: None, thinking: None, service_tier: None, instructions: None, extra_args: vec![], env: BTreeMap::new(), max_concurrency: 1 }
    }
}

/// A normalized provider catalog. `fallback` catalogs are suggestions only and
/// must never be treated as authoritative validation for execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub models: Vec<ModelInfo>,
    pub fetched_at: String,
    pub expires_at: String,
    pub fallback: bool,
    pub source: String,
    /// Whether the daemon may use this live source to validate turn options.
    #[serde(default)]
    pub validated: bool,
}

/// One profile-visible model and the settings that model accepts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub supported_thinking: Vec<String>,
    pub default_thinking: Option<String>,
    pub service_tiers: Vec<ServiceTier>,
    pub default_service_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variants: Option<Vec<String>>,
    pub host_dependent: bool,
    /// Provider default marker added by the local daemon presentation overlay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
    /// Local display group, such as a model family.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Whether the provider currently reports this model as offered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub availability: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTier {
    pub id: String,
    pub name: String,
}

/// Normalized successful or partial usage; every metric remains nullable when
/// the provider did not report it. Raw provider payloads must not be attached.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub usage_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_note: Option<String>,
    pub provider_update_id: Option<String>,
    pub context_used: Option<u64>,
    pub context_size: Option<u64>,
    pub model: Option<String>,
    pub cost_minor: Option<i64>,
    pub cost_currency: Option<String>,
    pub reported_cost_decimal: Option<String>,
    /// True when `reported_cost_decimal` is a session-cumulative total.
    /// OpenCode ACP's `usage_update.cost.amount` is cumulative; the daemon
    /// derives the per-turn delta. Omitted JSON deserializes as false so
    /// per-turn costs from other adapters stay per-turn.
    #[serde(default)]
    pub cost_is_cumulative: bool,
}

/// Computes a lowercase SHA-256 digest without retaining the input. Used for
/// instruction baselines; callers persist only the returned hexadecimal digest.
pub fn instruction_sha256(text: &str) -> Option<String> {
    if text.is_empty() { return None; }
    const K:[u32;64]=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    let bytes=text.as_bytes();let bit_len=(bytes.len() as u64).wrapping_mul(8);let mut data=bytes.to_vec();data.push(0x80);while data.len()%64!=56{data.push(0)}data.extend_from_slice(&bit_len.to_be_bytes());
    let mut h=[0x6a09e667u32,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    for block in data.chunks_exact(64){let mut w=[0u32;64];for(i,word)in block.chunks_exact(4).enumerate(){w[i]=u32::from_be_bytes([word[0],word[1],word[2],word[3]])}for i in 16..64{let s0=w[i-15].rotate_right(7)^w[i-15].rotate_right(18)^(w[i-15]>>3);let s1=w[i-2].rotate_right(17)^w[i-2].rotate_right(19)^(w[i-2]>>10);w[i]=w[i-16].wrapping_add(s0).wrapping_add(w[i-7]).wrapping_add(s1)}
        let(mut a,mut b,mut c,mut d,mut e,mut f,mut g,mut hh)=(h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7]);for i in 0..64{let s1=e.rotate_right(6)^e.rotate_right(11)^e.rotate_right(25);let ch=(e&f)^(!e&g);let t1=hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);let s0=a.rotate_right(2)^a.rotate_right(13)^a.rotate_right(22);let maj=(a&b)^(a&c)^(b&c);let t2=s0.wrapping_add(maj);hh=g;g=f;f=e;e=d.wrapping_add(t1);d=c;c=b;b=a;a=t1.wrapping_add(t2)}for(i,v)in[a,b,c,d,e,f,g,hh].into_iter().enumerate(){h[i]=h[i].wrapping_add(v)}}
    Some(h.iter().map(|v|format!("{v:08x}")).collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind { None, RequestShape, ProviderEcho, UsageEffect, SuccessfulTurn }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingOutcome {
    pub requested: Option<Value>,
    pub applied: Option<bool>,
    pub evidence_kind: EvidenceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionRequest {
    pub session_id: String,
    pub project_path: PathBuf,
    #[serde(default)]
    pub exec_options: ExecOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSessionRequest {
    pub session_id: String,
    pub provider_session_id: String,
    pub project_path: PathBuf,
    #[serde(default)]
    pub exec_options: ExecOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    pub turn_id: String,
    pub text: String,
    #[serde(default)]
    pub exec_options: ExecOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHandle {
    pub session_id: String,
    pub provider_session_id: String,
    pub capabilities: AgentCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type", content = "payload")]
pub enum AgentEvent {
    SessionStarted {
        provider_session_id: String,
    },
    /// A provider-reported human-readable conversation title.
    SessionTitle {
        title: String,
    },
    /// Structured context-window measurements; each field remains unknown
    /// unless the provider reports it directly.
    ContextUpdated {
        used: Option<u64>,
        size: Option<u64>,
    },
    AssistantDelta {
        text: String,
    },
    AssistantMessage {
        text: String,
    },
    ThinkingDelta {
        text: String,
    },
    ToolStarted {
        tool_call_id: String,
        kind: String,
        title: String,
        raw: Value,
    },
    ToolUpdated {
        tool_call_id: String,
        raw: Value,
    },
    ToolCompleted {
        tool_call_id: String,
        raw: Value,
    },
    FileChanged {
        path: String,
        raw: Value,
    },
    PermissionRequested {
        provider_request_id: String,
        title: String,
        detail: Option<String>,
        choices: Vec<String>,
        raw: Value,
    },
    UsageUpdated {
        raw: Value,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cache_read_tokens: Option<u64>,
        cache_write_tokens: Option<u64>,
        model: Option<String>,
    },
    /// Provider has evaluated execution settings; values are normalized evidence.
    ExecApplied { turn_id: String, outcomes: BTreeMap<String, SettingOutcome> },
    /// Normalized usage with nullable buckets; emitted only for valid provider reports.
    UsageReport { turn_id: String, report: UsageReport },
    TurnCompleted,
    TurnCancelled,
    /// Positive provider evidence that the current context cannot accept more input.
    ContextExhausted,
    Error {
        message: String,
    },
    SessionIdle,
}

pub type EventSender = mpsc::Sender<AgentEvent>;

/// Safe-to-surface process state collected for a stalled provider turn.
/// stderr remains transient here; callers must filter it before persistence/UI.
#[derive(Debug, Clone, Default)]
pub struct AgentDiagnostic {
    pub process_running: Option<bool>,
    pub stderr_tail: Option<String>,
    pub api_retry_count: Option<u32>,
    pub api_retry_http_status_seen: bool,
    pub api_retry_connection_failure: bool,
}

#[async_trait]
pub trait AgentAdapter: Send + Sync {
    /// Return a profile-scoped model catalog. Adapters that do not support
    /// discovery keep source compatibility and report `Unsupported` by default.
    async fn model_catalog(&self, _runtime: &RuntimeSpec) -> Result<ModelCatalog, AdapterError> {
        Err(AdapterError::Unsupported("model catalog is unavailable".into()))
    }
    /// Returns a provider's structured account quota response when the native
    /// protocol exposes one. Callers must normalize it before persistence/UI.
    async fn read_account_quota(&self, _runtime: &RuntimeSpec) -> Result<Value, AdapterError> {
        Err(AdapterError::Unsupported("account quota is unavailable".into()))
    }
    /// Supplies per-turn instruction hash context. Defaults preserve source
    /// compatibility for providers whose instruction lifecycle is adapter-local.
    async fn set_instruction_hash_context(&self, _session_id:&str, _desired:Option<String>, _baseline:Option<String>) {}
    /// Performs option preparation that can fail before a user prompt is
    /// admitted. Implementations must not send the user prompt here.
    async fn preflight_exec_options(&self, _options:&ExecOptions) -> Result<(),AdapterError> { Ok(()) }
    /// Returns a transient process snapshot for timeout diagnostics. Provider
    /// stderr must be sanitized before it is emitted, logged, or persisted.
    async fn diagnostic(&self, _session_id: &str) -> Option<AgentDiagnostic> { None }
    async fn probe(&self, runtime: &RuntimeSpec) -> Result<ProbeResult, AdapterError>;
    async fn new_session(
        &self,
        runtime: &RuntimeSpec,
        req: NewSessionRequest,
        events: EventSender,
    ) -> Result<SessionHandle, AdapterError>;
    async fn resume_session(
        &self,
        runtime: &RuntimeSpec,
        req: ResumeSessionRequest,
        events: EventSender,
    ) -> Result<SessionHandle, AdapterError>;
    async fn prompt(&self, handle: &SessionHandle, req: PromptRequest) -> Result<(), AdapterError>;
    async fn cancel(&self, handle: &SessionHandle) -> Result<(), AdapterError>;
    async fn reply_permission(
        &self,
        provider_request_id: &str,
        choice: &str,
    ) -> Result<(), AdapterError>;
    async fn close_session(&self, handle: &SessionHandle) -> Result<(), AdapterError>;
    /// Stops adapter-owned provider processes during daemon shutdown.
    async fn shutdown(&self) {}
}

#[cfg(test)]
mod exec_option_tests {
    use super::*;

    #[test]
    fn old_adapter_request_shapes_default_exec_options_and_new_fields_are_camel_case() {
        let new:NewSessionRequest=serde_json::from_value(serde_json::json!({"sessionId":"s","projectPath":"."})).unwrap();
        let resume:ResumeSessionRequest=serde_json::from_value(serde_json::json!({"sessionId":"s","providerSessionId":"p","projectPath":"."})).unwrap();
        let prompt:PromptRequest=serde_json::from_value(serde_json::json!({"turnId":"t","text":"hello"})).unwrap();
        assert_eq!(new.exec_options.max_concurrency,1);assert_eq!(resume.exec_options.max_concurrency,1);assert!(prompt.exec_options.env.is_empty());
        let encoded=serde_json::to_value(ExecOptions::default()).unwrap();assert!(encoded.get("serviceTier").is_some());assert!(encoded.get("maxConcurrency").is_some());assert!(encoded.get("service_tier").is_none());
        assert_eq!(serde_json::to_value(EvidenceKind::ProviderEcho).unwrap(),"provider_echo");
    }
    #[test]
    fn instruction_sha256_is_standard_and_empty_is_absent(){assert_eq!(instruction_sha256("abc").as_deref(),Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));assert_eq!(instruction_sha256(""),None);}


    #[test]
    fn usage_report_cost_is_cumulative_defaults_false_and_serializes_camel_case() {
        let report: UsageReport = serde_json::from_value(serde_json::json!({
            "inputTokens": 1, "outputTokens": 2, "cacheReadTokens": null, "cacheWriteTokens": null,
            "reasoningTokens": null, "usageStatus": "reported", "providerUpdateId": "1",
            "contextUsed": null, "contextSize": null, "model": null, "costMinor": null,
            "costCurrency": "USD", "reportedCostDecimal": "0.0015894"
        })).unwrap();
        assert!(!report.cost_is_cumulative);
        assert_eq!(report.reported_cost_decimal.as_deref(), Some("0.0015894"));
        let mut report = report;
        report.cost_is_cumulative = true;
        let encoded = serde_json::to_value(&report).unwrap();
        assert_eq!(encoded["costIsCumulative"], true);
        assert!(encoded.get("cost_is_cumulative").is_none());
    }
}
