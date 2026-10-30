use super::*;
use std::io::Write;
use std::path::{Component, Path};
use std::process::{Command, Stdio};

/// Whether a useful experiment is on. Since 30 October 2026 an absent key means
/// on and only an explicit `false` turns it off, so a fresh install gets the
/// useful ones and a switch the owner turned off stays off. Every daemon read of
/// `experimental.<name>` goes through this one rule.
pub(crate) fn on(settings: &Value, name: &str) -> bool {
    let key = format!("experimental.{name}");
    settings.get(key.as_str()).and_then(Value::as_bool).unwrap_or(true)
}

/// Git started by the background daemon must not flash a console window on Windows.
pub(crate) fn git_command() -> Command {
    let mut command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

pub(super) fn automatic_title(row: &Value, name: &str, text: &str, images: usize) -> Option<String> {
    if row["link"]["kind"] == "side" || !is_default_title(row["title"].as_str(), name) || row["messages"].as_array().is_some_and(|m| m.iter().any(|m| m["role"] == "user")) { return None; }
    title_from_prompt(text, images)
}

/// A title may be derived only while the row still carries a default: the
/// bot's own name (the older default) or "New chat" (a lazily created one).
fn is_default_title(title: Option<&str>, name: &str) -> bool {
    title.is_some_and(|title| title == name || title == "New chat")
}

/// Greetings say nothing about the work, so they are dropped from the front of
/// a title; a prompt that is only a greeting gets a fallback title instead.
const GREETINGS: &[&str] = &["good morning", "good afternoon", "good evening", "greetings", "hello", "hiya", "howdy", "hey there", "hey", "hi", "yo", "sup"];

/// Conversational openers that wrap the real request ("can you fix …").
const FILLERS: &[&str] = &["i need you to", "i want you to", "help me with", "quick question", "can you", "could you", "would you", "will you", "can u", "i need", "i want", "help me", "let's", "lets", "please", "thanks", "thank you", "just", "question", "pls", "okay", "ok", "so", "um", "uhm", "well"];

/// A title from the first prompt's intent: fenced code and code-looking lines
/// are skipped, conversational openers are dropped, and an unhelpful prompt
/// (a greeting, a lone question word, code only, images only) still gets a
/// short fallback rather than a meaningless title. No model call.
fn title_from_prompt(text: &str, images: usize) -> Option<String> {
    let stripped = strip_fenced_code(text);
    let mut had_code = stripped.len() != text.len();
    let mut candidate: Option<String> = None;
    let mut opener = false;
    let mut greeting = false;
    let mut unhelpful = false;
    for line in stripped.lines() {
        let flat = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if flat.is_empty() { continue; }
        if is_code_like(&flat) { had_code = true; continue; }
        let (cleaned, was_opener, was_greeting) = strip_fillers(&flat);
        opener |= was_opener;
        greeting |= was_greeting;
        let trimmed = cleaned.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'').trim();
        if is_meaningful(trimmed) { candidate = Some(trimmed.to_owned()); break; }
        // Something was said, it just does not make a title ("why?", "help").
        unhelpful = true;
    }
    if let Some(title) = candidate { return Some(truncate_title(&title)); }
    if images > 0 { return Some(if images == 1 { "Shared 1 image".into() } else { format!("Shared {images} images") }); }
    if had_code { return Some("Code review".into()); }
    if greeting { return Some("Quick hello".into()); }
    if opener || unhelpful { return Some("Quick chat".into()); }
    None
}

/// Lines between code fences say nothing a title should quote.
fn strip_fenced_code(text: &str) -> String {
    let mut inside = false;
    let mut kept = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") { inside = !inside; continue; }
        if !inside { kept.push(line); }
    }
    kept.join("\n")
}

fn is_code_like(line: &str) -> bool {
    let text = line.trim();
    if text.is_empty() || text.starts_with("```") || text.starts_with("~~~") { return false; }
    let openers = ["fn ", "pub fn", "use ", "impl ", "const ", "let ", "var ", "import ", "export ", "def ", "class ", "function ", "select ", "insert ", "update ", "create ", "#include", "<?", "</", "<div", "#!/", "{\"", "[{"];
    let lower = text.to_lowercase();
    if openers.iter().any(|opener| lower.starts_with(opener)) { return true; }
    if text.ends_with(';') || text.ends_with('{') || text.ends_with('}') || text.ends_with("=>") { return true; }
    let alphanumeric = text.chars().filter(|c| c.is_alphanumeric()).count();
    alphanumeric * 2 < text.chars().count()
}

/// Drops leading greetings and openers, longest phrase first, so "hey, can you
/// fix the login bug?" keeps its intent: "fix the login bug".
fn strip_fillers(line: &str) -> (String, bool, bool) {
    let mut phrases = GREETINGS.iter().map(|phrase| (*phrase, true)).chain(FILLERS.iter().map(|phrase| (*phrase, false))).collect::<Vec<_>>();
    phrases.sort_by(|left, right| right.0.len().cmp(&left.0.len()));
    let mut rest = line.trim();
    let mut opener = false;
    let mut greeting = false;
    loop {
        let lower = rest.to_lowercase();
        let starts_phrase = |phrase: &str| lower.strip_prefix(phrase).is_some_and(|tail| tail.is_empty() || matches!(tail.chars().next(), Some(' ' | ',' | '!' | '.' | ':' | ';' | '?')));
        // After a greeting, "there" is filler; anywhere else it is a real word.
        let greeting_there = greeting && starts_phrase("there");
        let Some((phrase, is_greeting)) = (if greeting_there { Some(("there", false)) } else { None }).or_else(|| phrases.iter().find(|(phrase, _)| starts_phrase(phrase)).map(|(phrase, is_greeting)| (*phrase, *is_greeting))) else { break };
        opener = true;
        greeting |= is_greeting;
        rest = rest[phrase.len()..].trim_start_matches([' ', ',', '.', '!', ':', ';', '-', '—']).trim_start();
        if rest.is_empty() { break; }
    }
    (rest.to_owned(), opener, greeting)
}

/// A lone question word or a couple of characters do not make a title.
fn is_meaningful(text: &str) -> bool {
    if text.chars().filter(|c| c.is_alphanumeric()).count() < 3 { return false; }
    !matches!(text.to_lowercase().as_str(), "why" | "what" | "how" | "huh" | "eh" | "help")
}

/// Whitespace collapsed, at most 48 characters, cut on a word boundary with an
/// ellipsis when it is longer.
fn truncate_title(trimmed: &str) -> String {
    if trimmed.chars().count() <= 48 { return trimmed.to_owned(); }
    let mut title = String::new();
    for word in trimmed.split(' ') {
        let candidate = if title.is_empty() { word.chars().count() } else { title.chars().count() + 1 + word.chars().count() };
        if candidate > 47 && !title.is_empty() { break; }
        if !title.is_empty() { title.push(' '); }
        title.push_str(word);
    }
    if title.chars().count() > 47 { title = title.chars().take(47).collect(); }
    title.push('…');
    title
}

fn git_patch(project: &Path, patch: &str, check: bool, directory: &str) -> Result<(), String> {
    let mut command = git_command();
    command.current_dir(project).args(["apply", "-R", "--whitespace=nowarn"]);
    if check { command.arg("--check"); }
    if !directory.is_empty() { command.arg(format!("--directory={directory}")); }
    let mut child = command.arg("-").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_| "Git could not be started.".to_owned())?;
    let written = child.stdin.take().ok_or("Git did not accept the patch.")?.write_all(patch.as_bytes());
    let status = child.wait().map_err(|_| "Git did not finish checking the patch.")?;
    if written.is_err() || !status.success() { return Err("This turn's change no longer applies cleanly in reverse. No files were reverted.".into()); }
    Ok(())
}

/// A saved patch that passed every pre-flight check, ready to be applied in
/// reverse against one Git root.
struct ReversePatch {
    root: PathBuf,
    patch: String,
    directory: String,
}

/// Accept one complete, ordinary text patch only. Never fall back to checkout/reset.
pub(super) fn reverse_file(project: &Path, path: &str, detail: &Value) -> Result<(), String> {
    let prepared = prepare_reverse(project, path, detail)?;
    git_patch(&prepared.root, &prepared.patch, true, &prepared.directory)?;
    git_patch(&prepared.root, &prepared.patch, false, &prepared.directory)
}

/// The same checks `reverse_file` makes, ending at `git apply --check`: it says
/// whether the saved patch would still reverse cleanly without touching a file.
/// The checkpoint list uses it so a change whose file was edited afterwards is
/// reported as blocked instead of being offered for revert.
pub(super) fn reverse_file_check(project: &Path, path: &str, detail: &Value) -> Result<(), String> {
    let prepared = prepare_reverse(project, path, detail)?;
    git_patch(&prepared.root, &prepared.patch, true, &prepared.directory)
}

fn prepare_reverse(project: &Path, path: &str, detail: &Value) -> Result<ReversePatch, String> {
    let patch = detail["diff"].as_str().ok_or("No complete diff was saved for this change.")?;
    if detail["diffClipped"] == true || detail["clipped"] == true || detail["truncated"] == true || patch.contains("[truncated]") || patch.contains("…") {
        return Err("The saved diff was clipped or incomplete; this change cannot be reverted safely.".into());
    }
    let project = project.canonicalize().map_err(|_| "The project folder is unavailable.")?;
    let git = git_command().current_dir(&project).args(["rev-parse", "--show-toplevel"]).output().map_err(|_| "Git could not be started.")?;
    if !git.status.success() { return Err("The project is not a Git repository.".into()); }
    let git_root = PathBuf::from(String::from_utf8_lossy(&git.stdout).trim()).canonicalize().map_err(|_| "The Git repository is unavailable.")?;
    let prefix = project.strip_prefix(&git_root).map_err(|_| "The project is outside the Git repository.")?.to_str().ok_or("The project path is unsupported.")?.replace('\\', "/");
    let supplied = Path::new(path);
    if supplied.components().any(|c| matches!(c, Component::ParentDir)) || path.replace('\\', "/").split('/').any(|part| part.eq_ignore_ascii_case(".git")) { return Err("The changed path is outside the project or is unsafe.".into()); }
    let target = if supplied.is_absolute() { supplied.to_path_buf() } else { project.join(supplied) };
    let mut ancestor = target.as_path();
    while !ancestor.exists() { ancestor = ancestor.parent().ok_or("The changed path is outside the project.")?; }
    let resolved = ancestor.canonicalize().map_err(|_| "The changed path is unavailable.")?;
    if !resolved.starts_with(&project) || std::fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) { return Err("The changed path is outside the project or is a symbolic link.".into()); }
    let resolved_target = resolved.join(target.strip_prefix(ancestor).map_err(|_| "The changed path is unsafe.")?);
    let relative = resolved_target.strip_prefix(&project).map_err(|_| "The changed path is outside the project.")?;
    if relative.components().any(|c| !matches!(c, Component::Normal(_))) { return Err("The changed path is unsafe.".into()); }
    let project_path = relative.to_str().ok_or("The changed path is unsupported.")?.replace('\\', "/");
    let repository_path = if prefix.is_empty() { project_path.clone() } else { format!("{prefix}/{project_path}") };
    // Providers can report either project-relative or repository-relative headers.
    let uses_repository_paths = !prefix.is_empty() && patch.lines().any(|line| line == format!("--- a/{repository_path}") || line == format!("+++ b/{repository_path}"));
    let path = if uses_repository_paths { repository_path.clone() } else { project_path };
    let directory = if uses_repository_paths { "" } else { prefix.as_str() };
    // Some providers save complete hunks without filename headers.
    let patch = if patch.starts_with("@@ ") { format!("--- a/{path}\n+++ b/{path}\n{patch}") } else { patch.to_owned() };
    // Older detail excerpts trimmed the final newline. Git still validates every hunk count.
    let patch = if patch.ends_with('\n') { patch } else { patch + "\n" };
    let headers: Vec<&str> = patch.lines().filter(|l| l.starts_with("diff --git ")).collect();
    if headers.len() > 1 || headers.first().is_some_and(|h| **h != format!("diff --git a/{path} b/{path}")) { return Err("The saved diff contains other paths or unsupported headers.".into()); }
    let old: Vec<&str> = patch.lines().filter(|l| l.starts_with("--- ")).collect();
    let new: Vec<&str> = patch.lines().filter(|l| l.starts_with("+++ ")).collect();
    if old.len() != 1 || new.len() != 1 || !(old[0] == format!("--- a/{path}") || old[0] == "--- /dev/null") || !(new[0] == format!("+++ b/{path}") || new[0] == "+++ /dev/null") || (old[0] == "--- /dev/null" && new[0] == "+++ /dev/null") || !patch.lines().any(|l| l.starts_with("@@ ")) || patch.lines().any(|l| l.starts_with("rename ") || l.starts_with("copy ") || l.contains("120000") || l.starts_with("GIT binary patch") || l.starts_with("Binary files")) {
        return Err("The saved diff is incomplete or is not a supported single-file text patch.".into());
    }
    // Ask Git which exact paths it would change before permitting any write.
    let mut command = git_command();
    command.current_dir(&git_root).args(["apply", "-R", "--numstat", "-z"]);
    if !directory.is_empty() { command.arg(format!("--directory={directory}")); }
    let mut child = command.arg("-").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "Git could not inspect the patch.")?;
    child.stdin.take().ok_or("Git did not accept the patch.")?.write_all(patch.as_bytes()).map_err(|_| "Git could not read the patch.")?;
    let output = child.wait_with_output().map_err(|_| "Git could not inspect the patch.")?;
    let records: Vec<&[u8]> = output.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()).collect();
    if !output.status.success() || records.len() != 1 || records[0].splitn(3, |b| *b == b'\t').nth(2) != Some(repository_path.as_bytes()) { return Err("The saved diff contains other paths or is incomplete.".into()); }
    Ok(ReversePatch { root: git_root, patch, directory: directory.to_owned() })
}

pub(super) async fn delete_due(st: &AppState) {
    delete_before(st, Utc::now().timestamp_millis()).await;
}

/// Quitting ends the Undo opportunity, so finish queued deletions before acknowledging shutdown.
pub(super) async fn finish_pending_deletes(st: &AppState) {
    delete_before(st, i64::MAX).await;
}

async fn delete_before(st: &AppState, now: i64) {
    for (id, deadline) in st.db.due_session_deletes(now).unwrap_or_default() {
        let result = Box::pin(dispatch(st, "session.delete", json!({"sessionId":id,"deleteDeadline":deadline}))).await;
        if result.is_err() { tracing::warn!("A scheduled conversation deletion could not finish; it will be retried."); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repo() -> PathBuf {
        let path = std::env::temp_dir().join(format!("bloblex-revert-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        assert!(Command::new("git").current_dir(&path).args(["init", "-q"]).status().unwrap().success());
        assert!(Command::new("git").current_dir(&path).args(["config", "core.autocrlf", "false"]).status().unwrap().success());
        path
    }
    fn patch() -> Value { json!({"diff":"diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"}) }
    #[test]
    fn reverse_only_this_change_and_preserve_other_files() {
        let path = repo(); std::fs::write(path.join("a.txt"), "new\n").unwrap(); std::fs::write(path.join("other.txt"), "keep\n").unwrap();
        reverse_file(&path, "a.txt", &patch()).unwrap();
        assert_eq!(std::fs::read_to_string(path.join("a.txt")).unwrap(), "old\n");
        assert_eq!(std::fs::read_to_string(path.join("other.txt")).unwrap(), "keep\n");
        assert!(reverse_file(&path, "a.txt", &patch()).is_err());
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn refuse_clipped_incomplete_outside_and_multi_path_patches() {
        let path = repo(); std::fs::write(path.join("a.txt"), "new\n").unwrap();
        let mut clipped = patch(); clipped["diffClipped"] = json!(true);
        assert!(reverse_file(&path, "a.txt", &clipped).is_err());
        assert!(reverse_file(&path, "../a.txt", &patch()).is_err());
        assert!(reverse_file(&path, "a.txt", &json!({"diff":"+new"})).is_err());
        assert!(reverse_file(&path, "a.txt", &json!({"diff":format!("{}diff --git a/other.txt b/other.txt\n",patch()["diff"].as_str().unwrap())})).is_err());
        assert_eq!(std::fs::read_to_string(path.join("a.txt")).unwrap(), "new\n");
        std::fs::remove_dir_all(path.join(".git")).unwrap();
        assert!(reverse_file(&path, "a.txt", &patch()).unwrap_err().contains("not a Git"));
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn repository_subfolder_accepts_both_header_conventions_without_touching_peers() {
        let root = repo();
        let project = root.join("subfolder");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(root.join("peer.txt"), "keep\n").unwrap();
        std::fs::write(project.join("a.txt"), "new\n").unwrap();
        reverse_file(&project, "a.txt", &patch()).unwrap();
        assert_eq!(std::fs::read_to_string(project.join("a.txt")).unwrap(), "old\n");
        std::fs::write(project.join("a.txt"), "new\n").unwrap();
        let prefixed = patch()["diff"].as_str().unwrap().replace("a/a.txt", "a/subfolder/a.txt").replace("b/a.txt", "b/subfolder/a.txt");
        reverse_file(&project, "a.txt", &json!({"diff":prefixed})).unwrap();
        assert_eq!(std::fs::read_to_string(project.join("a.txt")).unwrap(), "old\n");
        assert_eq!(std::fs::read_to_string(root.join("peer.txt")).unwrap(), "keep\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reverse_complete_hunks_absolute_paths_and_created_deleted_files() {
        let path = repo();
        std::fs::write(path.join("a.txt"), "new\n").unwrap();
        reverse_file(&path, path.join("a.txt").to_str().unwrap(), &json!({"diff":"@@ -1 +1 @@\n-old\n+new\n"})).unwrap();
        assert_eq!(std::fs::read_to_string(path.join("a.txt")).unwrap(), "old\n");
        std::fs::write(path.join("added.txt"), "added\n").unwrap();
        reverse_file(&path, "added.txt", &json!({"diff":"--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+added\n"})).unwrap();
        assert!(!path.join("added.txt").exists());
        reverse_file(&path, "deleted.txt", &json!({"diff":"--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n"})).unwrap();
        assert_eq!(std::fs::read_to_string(path.join("deleted.txt")).unwrap(), "deleted\n");
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn title_changes_only_first_main_prompt_with_default_title() {
        let row = json!({"title":"Blob","messages":[]});
        assert_eq!(automatic_title(&row,"Blob","... Fix the build and check tests please!",0),Some("Fix the build and check tests please".into()));
        assert_eq!(automatic_title(&json!({"title":"New chat","messages":[]}),"Blob","Draft the release notes",0),Some("Draft the release notes".into()));
        assert!(automatic_title(&json!({"title":"Custom"}),"Blob","hello",0).is_none());
        assert!(automatic_title(&json!({"title":"Blob","link":{"kind":"side"}}),"Blob","hello",0).is_none());
        assert!(automatic_title(&json!({"title":"Blob","messages":[{"role":"user"}]}),"Blob","hello",0).is_none());
        assert!(automatic_title(&row,"Blob","   ",0).is_none());
        let long = automatic_title(&row,"Blob",&"x".repeat(80),0).unwrap();
        assert!(long.chars().count() <= 48 && long.ends_with('…'));
        let cut = automatic_title(&row,"Blob","Fix the flaky login test in the companion window please",0).unwrap();
        assert!(cut.chars().count() <= 48 && cut.ends_with('…') && !cut.contains("  "));
    }

    #[test]
    fn title_follows_the_first_intent_of_awkward_prompts() {
        let row = json!({"title":"New chat","messages":[]});
        // Greetings keep their intent, and a bare greeting still gets a title.
        assert_eq!(automatic_title(&row,"Blob","Hi there, can you fix the login redirect?",0).as_deref(),Some("fix the login redirect"));
        assert_eq!(automatic_title(&row,"Blob","hello",0).as_deref(),Some("Quick hello"));
        assert_eq!(automatic_title(&row,"Blob","Thanks!",0).as_deref(),Some("Quick chat"));
        // Short prompts: a lone question word gets a fallback, a real request does not.
        assert_eq!(automatic_title(&row,"Blob","why?",0).as_deref(),Some("Quick chat"));
        assert_eq!(automatic_title(&row,"Blob","add dark mode",0).as_deref(),Some("add dark mode"));
        // Code first: the prose after the block is the title; pure code falls back.
        assert_eq!(automatic_title(&row,"Blob","```ts\nconst x = 1;\n```\nMake the export button work",0).as_deref(),Some("Make the export button work"));
        assert_eq!(automatic_title(&row,"Blob","const x = 1;\nexport default x;\n",0).as_deref(),Some("Code review"));
        // Image-only messages name what was shared.
        assert_eq!(automatic_title(&row,"Blob","",1).as_deref(),Some("Shared 1 image"));
        assert_eq!(automatic_title(&row,"Blob","   ",3).as_deref(),Some("Shared 3 images"));
        // Long prose still truncates on a word boundary.
        let long = automatic_title(&row,"Blob","please summarise the whole of this long document about release notes and gates",0).unwrap();
        assert!(long.chars().count() <= 48 && long.ends_with('…'));
    }
}
