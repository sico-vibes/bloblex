//! Phase 4: take a branch from another machine into a copy of this machine's repository.
//!
//! A handoff pushes a conversation's `bitbots/…` branch, and the machine taking it runs
//! `attach_branch` to get a copy to continue in. **`branch` comes from another machine**, so it is
//! checked before any git command sees it: it must start `bitbots/`, never start with `-`, and pass
//! `git check-ref-format --branch`. Every call is an argument list with no shell, sets
//! `GIT_TERMINAL_PROMPT=0` and uses git's own sign-in: nothing here reads, passes or prints a
//! credential, and no git output is logged.
//!
//! **Nothing here ever forces, deletes or resets what the owner has.** A copy with uncommitted files,
//! or a local branch holding commits the remote does not have, is refused with a plain sentence; a
//! folder this call made is removed again when its fast-forward fails, and nothing else is touched.
//! The folder family is `<repo>-bitbots/<slug>`, with a number when the name is taken, as
//! `worktree::create` does. This is its own file so it never touches `worktree.rs`.

use crate::worktree::{self, Worktree};
use std::path::{Path, PathBuf};

/// What an attach gives: exactly what `worktree::create` returns, so a conversation's `link.worktree`
/// looks the same whether its copy was made here or taken from another machine.
pub(crate) type Attached = Worktree;

/// The prefix every Bitbots branch has, and the only one this accepts.
const PREFIX: &str = "bitbots/";
/// The folder family holds every task copy of one repository.
const FAMILY_SUFFIX: &str = "-bitbots";

/// One `git [-C dir] args...` run without a shell. Trimmed stdout on a zero exit, else an error.
fn run(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = crate::experiments::git_command()
        .arg("--no-optional-locks").arg("-C").arg(dir).args(args)
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY").env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|_| "Git could not be started.".to_owned())?;
    if !output.status.success() { return Err("Git did not complete that command.".to_owned()); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// Why this branch may not be taken, or `None` when it may. It arrives from another machine, so it is
/// checked before git sees it: the `bitbots/` family only, never an option, and a valid ref name.
fn refuse(branch: &str) -> Option<String> {
    if branch.chars().count() > 200 || branch.chars().any(char::is_control) { return Some("That branch name can't be used.".to_owned()); }
    if branch.starts_with('-') { return Some("That branch name can't be used.".to_owned()); }
    if !branch.starts_with(PREFIX) || branch.len() == PREFIX.len() { return Some(format!("Only a `{PREFIX}` branch can be taken from another machine.")); }
    None
}

/// The worktree that already has `branch` checked out, from `git worktree list --porcelain`.
fn copy_on(repo: &Path, branch: &str) -> Option<PathBuf> {
    let list = run(repo, &["worktree", "list", "--porcelain"]).ok()?;
    let mut path: Option<PathBuf> = None;
    for line in list.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") { path = Some(PathBuf::from(rest.trim())); }
        if let Some(rest) = line.strip_prefix("branch ") {
            if rest.trim() == format!("refs/heads/{branch}") { return path; }
        }
        if line.trim().is_empty() { path = None; }
    }
    None
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    run(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
}

/// `git check-ref-format --branch <branch>`, so git itself refuses anything malformed.
fn ref_name_ok(repo: &Path, branch: &str) -> bool {
    run(repo, &["check-ref-format", "--branch", branch]).is_ok()
}

/// A free `<repo>-bitbots/<slug>` folder, adding a number when the name is taken. It never reuses or
/// removes an existing folder.
fn free_path(repo: &Path, branch: &str) -> Result<PathBuf, String> {
    let parent = repo.parent().ok_or_else(|| "The repository has no parent folder.".to_owned())?;
    let name = repo.file_name().and_then(|name| name.to_str()).unwrap_or("repo");
    let family = parent.join(format!("{name}{FAMILY_SUFFIX}"));
    std::fs::create_dir_all(&family).map_err(|error| format!("The task copy folder could not be created: {error}"))?;
    let slug = worktree::slug(branch.strip_prefix(PREFIX).unwrap_or(branch));
    for attempt in 0..20usize {
        let candidate = if attempt == 0 { family.join(&slug) } else { family.join(format!("{slug}-{}", attempt + 1)) };
        if !candidate.exists() { return Ok(candidate); }
    }
    Err("No free name was available for a task copy.".to_owned())
}

/// Take `branch` from `origin` into a copy of `repo_root`, and answer with it. A copy already on that
/// branch is fast-forwarded when it has no uncommitted files; a local branch is fast-forwarded only
/// when it holds no commit the remote does not have; a new branch is created at the fetched commit.
pub(crate) fn attach_branch(repo_root: &Path, branch: &str) -> Result<Attached, String> {
    if let Some(reason) = refuse(branch) { return Err(reason); }
    let repo = worktree::repo_root(repo_root).ok_or_else(|| "That folder is not a git repository.".to_owned())?;
    if !ref_name_ok(&repo, branch) { return Err("That branch name can't be used.".to_owned()); }
    // The one fetch. `FETCH_HEAD` is then the remote's commit for this branch.
    run(&repo, &["fetch", "origin", &format!("refs/heads/{branch}")]).map_err(|_| format!("`{branch}` could not be fetched from the remote."))?;
    let fetched = run(&repo, &["rev-parse", "FETCH_HEAD"]).map_err(|_| format!("`{branch}` could not be fetched from the remote."))?;
    let attached = |path: PathBuf| Attached { repo: repo.clone(), path, branch: branch.to_owned(), base: String::new(), base_commit: fetched.clone() };

    // 1. A copy is already on that branch: never overwrite what it has not committed.
    if let Some(path) = copy_on(&repo, branch) {
        if worktree::is_dirty(&path).unwrap_or(true) { return Err(format!("`{branch}` has uncommitted files here. Commit or discard them first.")); }
        run(&path, &["merge", "--ff-only", &fetched]).map_err(|_| format!("`{branch}` could not be brought up to date here."))?;
        return Ok(attached(path));
    }

    // 2. A local branch with no copy: it must hold nothing the remote does not have.
    if branch_exists(&repo, branch) {
        let ancestor = run(&repo, &["merge-base", "--is-ancestor", &format!("refs/heads/{branch}"), "FETCH_HEAD"]).is_ok();
        if !ancestor { return Err(format!("`{branch}` has commits here that aren't on the remote.")); }
        let path = free_path(&repo, branch)?;
        run(&repo, &["worktree", "add", &path.to_string_lossy(), branch]).map_err(|_| "The task copy could not be created.".to_owned())?;
        // Fast-forward only: the branch is an ancestor of what was fetched, so this can never lose work.
        if run(&path, &["merge", "--ff-only", &fetched]).is_err() {
            let _ = run(&repo, &["worktree", "remove", &path.to_string_lossy()]);
            return Err(format!("`{branch}` could not be brought up to date here."));
        }
        return Ok(attached(path));
    }

    // 3. No local branch: a new one at the fetched commit.
    let path = free_path(&repo, branch)?;
    run(&repo, &["worktree", "add", "-b", branch, &path.to_string_lossy(), "FETCH_HEAD"]).map_err(|_| "The task copy could not be created.".to_owned())?;
    Ok(attached(path))
}
