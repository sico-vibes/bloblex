//! FIX39 P10: git worktrees for parallel code tasks.
//!
//! When a code-writing delegation targets a git project where another task is
//! already working, the daemon runs it in its own linked worktree (a sibling
//! folder, on a `bitbots/<slug>` branch) so the two tasks cannot clash. Nothing
//! here touches the owner's uncommitted changes: a worktree is created from
//! `HEAD`, and a merge back is refused while the main checkout is dirty. Every
//! git call is a plain argument list — never a shell — and its output is read
//! only to branch on it, never logged.

use std::path::{Path, PathBuf};

/// The longest a worktree branch slug may be; the folder name matches.
const MAX_SLUG: usize = 40;
/// The folder family holds every task copy of one repository: `<repo>-bitbots`.
const FAMILY_SUFFIX: &str = "-bitbots";

/// A created task copy: the repository it belongs to, where it lives, the branch
/// checked out there, the branch it was taken from, and the commit it started at.
#[derive(Clone, Debug)]
pub(crate) struct Worktree {
    pub repo: PathBuf,
    pub path: PathBuf,
    pub branch: String,
    pub base: String,
    pub base_commit: String,
}

impl Worktree {
    /// The record stored on the side conversation's link. It carries no
    /// conversation text — only paths, a branch and a commit.
    pub(crate) fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "repo": self.repo.to_string_lossy(),
            "path": self.path.to_string_lossy(),
            "branch": self.branch,
            "base": self.base,
            "baseCommit": self.base_commit,
        })
    }
}

/// What a task copy changed against its base commit, for the merge card.
#[derive(Clone, Debug, Default)]
pub(crate) struct Summary {
    pub files: Vec<String>,
    pub insertions: u64,
    pub deletions: u64,
    pub untracked: u64,
}

impl Summary {
    /// A one-line diff summary, e.g. `3 files changed, +12 −4, 1 new`.
    pub(crate) fn line(&self) -> String {
        let count = self.files.len();
        let files = if count == 1 { "1 file changed".to_owned() } else { format!("{count} files changed") };
        let mut out = format!("{files}, +{} −{}", self.insertions, self.deletions);
        if self.untracked > 0 { out.push_str(&format!(", {} new", self.untracked)); }
        out
    }
}

/// One `git [-C dir] args...` run without a shell. Returns trimmed stdout on a
/// zero exit; an error string otherwise. Git's output is never logged.
fn run(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = crate::experiments::git_command()
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|_| "Git could not be started.".to_owned())?;
    if !output.status.success() {
        return Err("Git did not complete that command.".to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// The repository root for a folder inside it, as git reports it, or `None` when
/// the folder is missing or is not in a git repository. The path is left as git
/// prints it (absolute, forward slashes) so sibling worktree paths git accepts
/// are built from it; comparisons normalise case and separators separately.
pub(crate) fn repo_root(path: &Path) -> Option<PathBuf> {
    if !path.is_dir() { return None; }
    run(path, &["rev-parse", "--show-toplevel"]).ok().map(PathBuf::from)
}

/// A case- and separator-insensitive key for comparing two folders on Windows.
pub(crate) fn normalize(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// The current branch of a repository, or an error on a detached HEAD (a task
/// copy must branch from a branch so the merge back is unambiguous).
fn current_branch(repo: &Path) -> Result<String, String> {
    let branch = run(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch == "HEAD" { return Err("The repository is on a detached HEAD.".to_owned()); }
    Ok(branch)
}

/// Whether the working tree has any uncommitted or untracked change. Untracked
/// files count: a merge could overwrite one that the task also creates.
pub(crate) fn is_dirty(repo: &Path) -> Result<bool, String> {
    Ok(!run(repo, &["status", "--porcelain"])?.trim().is_empty())
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    run(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
}

/// A branch- and folder-safe slug for a task topic: lowercase ASCII letters and
/// digits with single dashes, at most 40 characters, never empty.
pub(crate) fn slug(topic: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for character in topic.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() { out.push(character); dash = false; }
        else if !dash && !out.is_empty() { out.push('-'); dash = true; }
        if out.len() >= MAX_SLUG { break; }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() { "task".to_owned() } else { trimmed.to_owned() }
}

/// Create `<repo>-bitbots/<slug>` on a new `bitbots/<slug>` branch from `HEAD`.
/// Returns `Err` (never panics) so the caller can fall back to the shared folder.
pub(crate) fn create(repo: &Path, topic: &str) -> Result<Worktree, String> {
    let repo = repo_root(repo).ok_or_else(|| "That folder is not a git repository.".to_owned())?;
    let base = current_branch(&repo)?;
    let base_commit = run(&repo, &["rev-parse", "HEAD"])?;
    let parent = repo.parent().ok_or_else(|| "The repository has no parent folder.".to_owned())?;
    let name = repo.file_name().and_then(|name| name.to_str()).unwrap_or("repo");
    let family = parent.join(format!("{name}{FAMILY_SUFFIX}"));
    std::fs::create_dir_all(&family).map_err(|error| format!("The task copy folder could not be created: {error}"))?;
    let base_slug = slug(topic);
    for attempt in 0..20usize {
        let slug = if attempt == 0 { base_slug.clone() } else { format!("{base_slug}-{}", attempt + 1) };
        let branch = format!("bitbots/{slug}");
        let path = family.join(&slug);
        if path.exists() || branch_exists(&repo, &branch) { continue; }
        let path_arg = path.to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-b", &branch, &path_arg, &base_commit]).map_err(|_| "The task copy could not be created.".to_owned())?;
        return Ok(Worktree { repo, path, branch, base, base_commit });
    }
    Err("No free name was available for a task copy.".to_owned())
}

/// What the task copy changed against `base_commit`: tracked changes (committed
/// or not) plus untracked files, with an insertion/deletion count.
pub(crate) fn inspect(worktree: &Path, base_commit: &str) -> Result<Summary, String> {
    let base = if base_commit.trim().is_empty() { "HEAD" } else { base_commit };
    let mut files: Vec<String> = run(worktree, &["diff", "--name-only", base])?
        .lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_owned).collect();
    let untracked: Vec<String> = run(worktree, &["ls-files", "--others", "--exclude-standard"])?
        .lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_owned).collect();
    files.extend(untracked.iter().cloned());
    files.sort();
    files.dedup();
    let mut insertions = 0u64;
    let mut deletions = 0u64;
    for line in run(worktree, &["diff", "--numstat", base])?.lines() {
        let mut columns = line.split('\t');
        if let (Some(added), Some(removed)) = (columns.next(), columns.next()) {
            insertions += added.trim().parse().unwrap_or(0);
            deletions += removed.trim().parse().unwrap_or(0);
        }
    }
    Ok(Summary { files, insertions, deletions, untracked: untracked.len() as u64 })
}

/// How many commits the copy's branch has made since `base_commit` (wave 14,
/// `worktree_status`); `None` when the base is unknown or git cannot say.
pub(crate) fn commits_ahead(worktree: &Path, base_commit: &str) -> Option<u64> {
    if base_commit.trim().is_empty() { return None; }
    run(worktree, &["rev-list", "--count", &format!("{}..HEAD", base_commit.trim())]).ok()?.parse().ok()
}

/// Commit everything in the task copy under a fixed Bitbots identity, so a merge
/// back has something to carry. A no-op when the copy is already clean.
pub(crate) fn commit_all(worktree: &Path, message: &str) -> Result<(), String> {
    run(worktree, &["add", "-A"])?;
    if run(worktree, &["status", "--porcelain"])?.trim().is_empty() { return Ok(()); }
    run(worktree, &["-c", "user.name=Bitbots", "-c", "user.email=bitbots@localhost", "commit", "-q", "-m", message])
        .map(|_| ())
}

/// Whether the copy is a registered linked worktree of `repo` with `branch`
/// checked out. A merge refuses anything else, so a forged proposal payload
/// cannot point at an arbitrary branch or folder.
fn verify(repo: &Path, worktree: &Path, branch: &str) -> Result<(), String> {
    if !branch.starts_with("bitbots/") { return Err("That is not a Bitbots task branch.".to_owned()); }
    if !worktree.is_dir() { return Err("The task's separate copy is gone.".to_owned()); }
    // Only a copy inside this repository's own `<repo>-bitbots` family is ever
    // merged or discarded, so a forged proposal cannot name any other folder.
    let family = repo.file_name().map(|name| format!("{}{FAMILY_SUFFIX}", name.to_string_lossy().to_lowercase()));
    let parent = worktree.parent().and_then(|parent| parent.file_name()).map(|name| name.to_string_lossy().to_lowercase());
    if family.is_none() || parent != family { return Err("That copy is not in this repository's task folder.".to_owned()); }
    let listed = run(repo, &["worktree", "list", "--porcelain"])?;
    let wanted = normalize(worktree);
    let registered = listed.lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .any(|path| normalize(Path::new(path.trim())) == wanted);
    if !registered { return Err("That copy is not a worktree of this repository.".to_owned()); }
    let head = run(worktree, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if head != branch { return Err("The task branch is not checked out in that copy.".to_owned()); }
    Ok(())
}

/// Merge a task branch back into the main checkout: fast-forward when possible,
/// otherwise a merge commit. Never forced. A dirty or mis-branched main checkout
/// and any conflict are refused with nothing changed.
pub(crate) fn merge(repo: &Path, worktree: &Path, branch: &str, base: &str) -> Result<String, String> {
    let repo = repo_root(repo).ok_or_else(|| "The project folder is no longer a git repository.".to_owned())?;
    verify(&repo, worktree, branch)?;
    if is_dirty(&repo)? {
        // The copy exists because another task was working here, so a dirty
        // checkout is often that task's own work in progress — never tell the
        // owner to stash it. Untracked files count as dirty too.
        return Err("Another task may still be working in the project folder, or it has uncommitted changes (including new files). Merge once that work is saved and the folder is clean, then approve again.".to_owned());
    }
    let current = current_branch(&repo).map_err(|_| "The project folder is not on a branch, so it cannot merge.".to_owned())?;
    if current != base {
        return Err(format!("The project folder is on {current}, not {base}. Switch back to {base}, then approve again."));
    }
    if run(&repo, &["merge-base", "--is-ancestor", branch, "HEAD"]).is_ok() { return Ok("already merged".to_owned()); }
    if run(&repo, &["merge", "--ff-only", branch]).is_ok() { return Ok("fast-forward".to_owned()); }
    // A merge commit needs an author. Use the same fixed Bitbots identity as the
    // task commit, so a machine without a global git identity can still merge.
    match run(&repo, &["-c", "user.name=Bitbots", "-c", "user.email=bitbots@localhost", "merge", "--no-ff", "--no-edit", branch]) {
        Ok(_) => Ok("merge commit".to_owned()),
        Err(_) => {
            let _ = run(&repo, &["merge", "--abort"]);
            Err("The changes could not be merged cleanly. The branch and its separate copy are untouched.".to_owned())
        }
    }
}

/// Remove a task copy and its now-merged branch. Returns whether the copy is
/// gone: Windows refuses to delete a folder the CLI still holds open, and a
/// leftover must never be reported as a completed cleanup.
pub(crate) fn remove_after_merge(repo: &Path, worktree: &Path, branch: &str) -> bool {
    let path = worktree.to_string_lossy().into_owned();
    let _ = run(repo, &["worktree", "remove", "--force", &path]);
    let _ = run(repo, &["worktree", "prune"]);
    if worktree.exists() { return false; }
    let _ = run(repo, &["branch", "-d", branch]);
    true
}

/// Discard a task copy the owner rejected: remove the worktree and delete the
/// branch even though its work was never merged. Only reached on an explicit
/// owner choice. Returns whether the copy is gone.
pub(crate) fn discard(repo: &Path, worktree: &Path, branch: &str) -> bool {
    // A rejected proposal can be edited before it is decided, so discard is
    // bounded by the same check as a merge: only this repo's own task copy and
    // branch are removed.
    if verify(repo, worktree, branch).is_err() { return false; }
    let path = worktree.to_string_lossy().into_owned();
    let _ = run(repo, &["worktree", "remove", "--force", &path]);
    let _ = run(repo, &["worktree", "prune"]);
    if worktree.exists() { return false; }
    let _ = run(repo, &["branch", "-D", branch]);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().map(|output| output.status.success()).unwrap_or(false)
    }

    fn git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git").current_dir(dir).args(args).output().map(|output| output.status.success()).unwrap_or(false)
    }

    /// A temp repo with one committed file, or `None` when git is not on PATH.
    fn repo() -> Option<PathBuf> {
        if !git_available() { return None; }
        let dir = std::env::temp_dir().join(format!("bloblex-wt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(git(&dir, &["init", "-q"]));
        assert!(git(&dir, &["config", "core.autocrlf", "false"]));
        std::fs::write(dir.join("readme.txt"), "hello\n").unwrap();
        assert!(git(&dir, &["add", "."]));
        assert!(git(&dir, &["-c", "user.name=Test", "-c", "user.email=test@bitbots.local", "commit", "-q", "-m", "init"]));
        Some(dir)
    }

    #[test]
    fn slug_is_branch_safe_and_never_empty() {
        assert_eq!(slug("Add login!"), "add-login");
        assert_eq!(slug("   "), "task");
        assert_eq!(slug("a/b\\c:d"), "a-b-c-d");
        assert!(slug(&"x".repeat(120)).len() <= MAX_SLUG);
    }

    #[test]
    fn repo_root_is_none_for_a_plain_folder() {
        let dir = std::env::temp_dir().join(format!("bloblex-plain-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(repo_root(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn worktree_round_trip_merges_then_cleans_up() {
        let Some(repo) = repo() else { return };
        let created = create(&repo, "Add login").unwrap();
        assert_eq!(created.branch, "bitbots/add-login");
        // Compare against git's own toplevel (`created.repo`), because the test's
        // `temp_dir()` may be the 8.3 short form while git reports the long one.
        let family = created.repo.parent().unwrap().join(format!("{}-bitbots", created.repo.file_name().unwrap().to_str().unwrap()));
        assert!(created.path.starts_with(&family));
        assert_eq!(run(&created.path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(), "bitbots/add-login");

        std::fs::write(created.path.join("feature.txt"), "one\ntwo\n").unwrap();
        commit_all(&created.path, "Bitbots task add-login").unwrap();
        let summary = inspect(&created.path, &created.base_commit).unwrap();
        assert_eq!(summary.files, vec!["feature.txt".to_owned()]);
        assert_eq!(summary.insertions, 2);

        assert_eq!(merge(&repo, &created.path, &created.branch, &created.base).unwrap(), "fast-forward");
        assert_eq!(std::fs::read_to_string(repo.join("feature.txt")).unwrap(), "one\ntwo\n");
        remove_after_merge(&repo, &created.path, &created.branch);
        assert!(!created.path.exists());
        assert!(!branch_exists(&repo, &created.branch));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn merge_refuses_a_dirty_main_checkout() {
        let Some(repo) = repo() else { return };
        let created = create(&repo, "Add login").unwrap();
        std::fs::write(created.path.join("feature.txt"), "x\n").unwrap();
        commit_all(&created.path, "Bitbots task").unwrap();
        // The owner edits the main checkout without committing.
        std::fs::write(repo.join("readme.txt"), "changed\n").unwrap();
        let error = merge(&repo, &created.path, &created.branch, &created.base).unwrap_err();
        assert!(error.contains("uncommitted changes"), "{error}");
        assert!(!repo.join("feature.txt").exists(), "nothing merged while dirty");
        assert!(created.path.exists(), "the task copy survives a refusal");
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn a_merge_conflict_is_refused_and_leaves_main_clean() {
        let Some(repo) = repo() else { return };
        let created = create(&repo, "Add login").unwrap();
        // Both sides change the same line of the same file.
        std::fs::write(created.path.join("readme.txt"), "task side\n").unwrap();
        commit_all(&created.path, "Bitbots task").unwrap();
        std::fs::write(repo.join("readme.txt"), "main side\n").unwrap();
        assert!(git(&repo, &["add", "."]));
        assert!(git(&repo, &["-c", "user.name=Test", "-c", "user.email=test@bitbots.local", "commit", "-q", "-m", "main edit"]));
        let error = merge(&repo, &created.path, &created.branch, &created.base).unwrap_err();
        assert!(error.contains("could not be merged"), "{error}");
        // Nothing is left half-merged: no merge in progress, the main edit is
        // untouched, and the task copy survives.
        assert!(!repo.join(".git").join("MERGE_HEAD").exists(), "no merge is left in progress");
        assert_eq!(std::fs::read_to_string(repo.join("readme.txt")).unwrap(), "main side\n");
        assert!(created.path.exists(), "the task copy survives a conflict");
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn a_diverged_history_merges_with_a_merge_commit() {
        let Some(repo) = repo() else { return };
        let created = create(&repo, "Add login").unwrap();
        std::fs::write(created.path.join("feature.txt"), "task\n").unwrap();
        commit_all(&created.path, "Bitbots task").unwrap();
        // A non-conflicting commit on main, so a fast-forward is impossible.
        std::fs::write(repo.join("other.txt"), "main\n").unwrap();
        assert!(git(&repo, &["add", "."]));
        assert!(git(&repo, &["-c", "user.name=Test", "-c", "user.email=test@bitbots.local", "commit", "-q", "-m", "main edit"]));
        assert_eq!(merge(&repo, &created.path, &created.branch, &created.base).unwrap(), "merge commit");
        assert!(repo.join("feature.txt").exists() && repo.join("other.txt").exists());
        assert!(!repo.join(".git").join("MERGE_HEAD").exists());
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn an_already_merged_branch_is_reported_not_remerged() {
        let Some(repo) = repo() else { return };
        let created = create(&repo, "Add login").unwrap();
        std::fs::write(created.path.join("feature.txt"), "x\n").unwrap();
        commit_all(&created.path, "Bitbots task").unwrap();
        assert_eq!(merge(&repo, &created.path, &created.branch, &created.base).unwrap(), "fast-forward");
        // The branch is now an ancestor of HEAD, so a second approval is a no-op.
        assert_eq!(merge(&repo, &created.path, &created.branch, &created.base).unwrap(), "already merged");
        assert!(remove_after_merge(&repo, &created.path, &created.branch), "the copy is gone");
        assert!(!branch_exists(&repo, &created.branch));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn discard_removes_the_copy_and_branch() {
        let Some(repo) = repo() else { return };
        let created = create(&repo, "Throwaway").unwrap();
        std::fs::write(created.path.join("scratch.txt"), "x\n").unwrap();
        commit_all(&created.path, "Bitbots task").unwrap();
        discard(&repo, &created.path, &created.branch);
        assert!(!created.path.exists());
        assert!(!branch_exists(&repo, &created.branch));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn a_copy_outside_the_task_folder_is_refused() {
        let Some(repo) = repo() else { return };
        let outside = std::env::temp_dir().join(format!("bloblex-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        let branch = "bitbots/outside";
        assert!(git(&repo, &["worktree", "add", "-b", branch, outside.to_str().unwrap(), "HEAD"]));
        assert!(merge(&repo, &outside, branch, &current_branch(&repo).unwrap()).is_err(), "a copy outside <repo>-bitbots is never merged");
        discard(&repo, &outside, branch);
        assert!(outside.exists(), "discard refuses a copy outside the task folder");
        // Clean up the deliberately-created worktree.
        let _ = run(&repo, &["worktree", "remove", "--force", outside.to_str().unwrap()]);
        let _ = run(&repo, &["branch", "-D", branch]);
        std::fs::remove_dir_all(&repo).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn a_forged_branch_is_refused() {
        let Some(repo) = repo() else { return };
        let created = create(&repo, "Add login").unwrap();
        assert!(merge(&repo, &created.path, "main", &created.base).is_err());
        assert!(merge(&repo, &created.path, "bitbots/other", &created.base).is_err());
        discard(&repo, &created.path, &created.branch);
        std::fs::remove_dir_all(&repo).ok();
    }
}
