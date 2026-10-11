use super::*;
use std::io::Write;
use std::path::{Component, Path};
use std::process::{Command, Stdio};

/// Git started by the background daemon must not flash a console window on Windows.
fn git_command() -> Command {
    let mut command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

pub(super) fn automatic_title(row: &Value, name: &str, text: &str) -> Option<String> {
    if row["link"]["kind"] == "side" || row["title"] != name || row["messages"].as_array().is_some_and(|m| m.iter().any(|m| m["role"] == "user")) { return None; }
    let words = text.split_whitespace().take(6).collect::<Vec<_>>().join(" ");
    let title: String = words.trim_matches(|c: char| !c.is_alphanumeric()).chars().take(48).collect();
    if title.is_empty() { None } else { Some(title.trim_end_matches(|c: char| !c.is_alphanumeric()).to_owned()) }
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

/// Accept one complete, ordinary text patch only. Never fall back to checkout/reset.
pub(super) fn reverse_file(project: &Path, path: &str, detail: &Value) -> Result<(), String> {
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
    git_patch(&git_root, &patch, true, directory)?;
    git_patch(&git_root, &patch, false, directory)
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
        assert_eq!(automatic_title(&row,"Blob","... Fix the build and check tests please!"),Some("Fix the build and check".into()));
        assert!(automatic_title(&json!({"title":"Custom"}),"Blob","hello").is_none());
        assert!(automatic_title(&json!({"title":"Blob","link":{"kind":"side"}}),"Blob","hello").is_none());
        assert!(automatic_title(&json!({"title":"Blob","messages":[{"role":"user"}]}),"Blob","hello").is_none());
        assert!(automatic_title(&row,"Blob",&"x".repeat(80)).unwrap().chars().count() <= 48);
    }
}
