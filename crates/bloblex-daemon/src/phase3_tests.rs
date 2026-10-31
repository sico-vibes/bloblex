// Phase 3, Gogo's lane: setup files and submodules, cloning, discovery and search.
// Included into `phase2a_tests` so it shares that module's fixtures: `state`, `online_team_state`,
// `TeamAdapter`, `real_project`, `set_overrides`, `wait_for_messages`, `setup_state`,
// `open_with_worktree` and `setup_notices`.

// ── Section 4: worktree setup ─────────────────────────────────────────────

/// A project whose overrides are `copyFiles` and/or `initSubmodules`, over `setup_state`'s fixture.
async fn files_state(overrides: Value) -> (AppState, Arc<TeamAdapter>, String, String, PathBuf, PathBuf) {
    let (st, adapter, project, agent, main, worktree) = setup_state("").await;
    set_overrides(&st, &project, overrides).await.unwrap();
    (st, adapter, project, agent, main, worktree)
}

fn last_notice(st: &AppState, sid: &str) -> Value {
    setup_notices(st, sid).last().cloned().unwrap()
}

#[tokio::test]
async fn overrides_validate_copy_files() {
    let (st, _) = state();
    let id = st.db.project_create("Files", None).unwrap().0["id"].as_str().unwrap().to_owned();
    let ok = json!({"copyFiles":["note.txt","docs/readme.md"],"initSubmodules":true});
    assert_eq!(set_overrides(&st, &id, ok.clone()).await.unwrap()["project"]["overrides"]["copyFiles"], json!(["note.txt","docs/readme.md"]));
    assert_eq!(st.db.project_get(&id).unwrap()["overrides"]["initSubmodules"], true);
    // Omitted or null leaves them alone, and the DTO always carries both keys.
    assert_eq!(set_overrides(&st, &id, json!({"approvalMode":"auto"})).await.unwrap()["project"]["overrides"]["copyFiles"], json!([]));
    assert_eq!(set_overrides(&st, &id, json!({"copyFiles":null,"initSubmodules":null})).await.unwrap()["project"]["overrides"]["initSubmodules"], false);
    for bad in [
        json!({"copyFiles":"note.txt"}),
        json!({"copyFiles":[""]}),
        json!({"copyFiles":["../outside.txt"]}),
        json!({"copyFiles":["docs/../outside.txt"]}),
        json!({"copyFiles":["C:/outside.txt"]}),
        json!({"copyFiles":["C:outside.txt"]}),
        json!({"copyFiles":["/outside.txt"]}),
        json!({"copyFiles":["\\\\server\\share\\x.txt"]}),
        json!({"copyFiles":["what?.txt"]}),
        json!({"copyFiles":["*.env"]}),
        json!({"copyFiles":["x".repeat(261)]}),
        json!({"copyFiles":vec!["a.txt";51]}),
        json!({"copyFiles":[7]}),
        json!({"initSubmodules":"yes"}),
        json!({"initSubmodules":0}),
    ] {
        assert_eq!(set_overrides(&st, &id, bad.clone()).await.unwrap_err().1.code, "invalid_argument", "{bad}");
    }
    // Fifty short paths are fine.
    let many = json!((0..50).map(|index| format!("f{index}.txt")).collect::<Vec<_>>());
    assert!(set_overrides(&st, &id, json!({"copyFiles":many})).await.is_ok());
    // The ordinary storage update still refuses the key outright.
    assert!(st.db.project_update(&id, &json!({"overrides":{"copyFiles":["x"]}})).is_err());
}

#[tokio::test]
async fn copy_files_reach_the_worktree_only() {
    let (st, adapter, project, agent, main, worktree) = files_state(json!({"copyFiles":["README.md","notes/one.txt"]})).await;
    std::fs::create_dir_all(main.join("notes")).unwrap();
    std::fs::write(main.join("notes").join("one.txt"), "copied\n").unwrap();
    std::fs::write(main.join("secret.txt"), "keep out\n").unwrap();
    let sid = open_with_worktree(&st, &agent, &project, &worktree).await;
    dispatch(&st, "session.prompt", json!({"sessionId":sid,"text":"Start"})).await.unwrap();
    wait_for_messages(&st, &sid, |messages| messages.iter().any(|message| message["role"] == "assistant")).await;
    assert_eq!(std::fs::read_to_string(worktree.join("README.md")).unwrap(), "safe");
    assert_eq!(std::fs::read_to_string(worktree.join("notes").join("one.txt")).unwrap(), "copied\n", "a nested folder is made");
    assert!(!worktree.join("secret.txt").exists(), "only what the project lists travels");
    assert!(main.join("notes").join("one.txt").exists() && main.join("secret.txt").exists(), "the project's own folder is untouched");
    let notice = last_notice(&st, &sid);
    assert_eq!(notice["meta"]["status"], "done");
    assert_eq!(notice["content"], "Copied 2 files.");
    assert_eq!(notice["meta"]["copied"], json!(["README.md","notes/one.txt"]));
    assert_eq!(notice["meta"]["skipped"], json!([]));
    assert!(!adapter.prompts.lock().unwrap()[0].contains("failed"), "a clean copy tells the agent nothing");
    let _ = std::fs::remove_dir_all(worktree);
}

#[tokio::test]
async fn an_existing_target_is_not_overwritten() {
    let (st, _adapter, project, agent, _main, worktree) = files_state(json!({"copyFiles":["README.md"]})).await;
    std::fs::write(worktree.join("README.md"), "local work\n").unwrap();
    let sid = open_with_worktree(&st, &agent, &project, &worktree).await;
    dispatch(&st, "session.prompt", json!({"sessionId":sid,"text":"Start"})).await.unwrap();
    wait_for_messages(&st, &sid, |messages| messages.iter().any(|message| message["role"] == "assistant")).await;
    assert_eq!(std::fs::read_to_string(worktree.join("README.md")).unwrap(), "local work\n", "the copy never overwrites what is there");
    let notice = last_notice(&st, &sid);
    assert_eq!(notice["meta"]["skipped"], json!(["README.md"]));
    assert_eq!(notice["meta"]["copied"], json!([]));
    assert_eq!(notice["content"], "Copied nothing.");
    let _ = std::fs::remove_dir_all(worktree);
}

#[tokio::test]
async fn a_missing_file_is_skipped_and_named() {
    let (st, _adapter, project, agent, _main, worktree) = files_state(json!({"copyFiles":["nope.txt","README.md"]})).await;
    let sid = open_with_worktree(&st, &agent, &project, &worktree).await;
    dispatch(&st, "session.prompt", json!({"sessionId":sid,"text":"Start"})).await.unwrap();
    wait_for_messages(&st, &sid, |messages| messages.iter().any(|message| message["role"] == "assistant")).await;
    let notice = last_notice(&st, &sid);
    assert_eq!(notice["meta"]["status"], "done", "a missing source is not a failure");
    assert_eq!(notice["meta"]["skipped"], json!(["nope.txt"]), "and it is named");
    assert_eq!(notice["meta"]["copied"], json!(["README.md"]));
    assert!(worktree.join("README.md").exists() && !worktree.join("nope.txt").exists());
    let _ = std::fs::remove_dir_all(worktree);
}

#[tokio::test]
async fn a_symlink_source_is_refused() {
    let (st, adapter, project, agent, main, worktree) = files_state(json!({"copyFiles":["link.txt","README.md"]})).await;
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(main.join("README.md"), main.join("link.txt"));
    #[cfg(not(windows))]
    let made = std::os::unix::fs::symlink(main.join("README.md"), main.join("link.txt"));
    // A machine without the privilege to make links cannot run this test; the rule is the same.
    if made.is_err() { let _ = std::fs::remove_dir_all(worktree); return; }
    let sid = open_with_worktree(&st, &agent, &project, &worktree).await;
    dispatch(&st, "session.prompt", json!({"sessionId":sid,"text":"Start"})).await.unwrap();
    wait_for_messages(&st, &sid, |messages| messages.iter().any(|message| message["role"] == "assistant")).await;
    let notice = last_notice(&st, &sid);
    assert_eq!(notice["meta"]["status"], "failed");
    assert_eq!(notice["meta"]["detail"], "link.txt is a link, so it was not copied.");
    assert!(!worktree.join("link.txt").exists(), "a link is never followed into the worktree");
    assert!(!worktree.join("README.md").exists(), "the rest of the copy stops at the failure");
    assert!(adapter.prompts.lock().unwrap()[0].starts_with("Setting up this project failed in this worktree: link.txt is a link"), "the turn still runs");
    let _ = std::fs::remove_dir_all(worktree);
}

/// A local repository to use as a submodule's origin, with one committed file.
fn submodule_source(label: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!("bitbots-p3-sub-{label}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let git = |args: &[&str]| std::process::Command::new("git").current_dir(&dir).args(args).output().map(|output| output.status.success()).unwrap_or(false);
    if !git(&["init", "-q"]) { return None; }
    std::fs::write(dir.join("inner.txt"), "inner\n").unwrap();
    if !git(&["add", "."]) || !git(&["-c","user.name=Test","-c","user.email=test@bitbots.local","commit","-q","-m","inner"]) { return None; }
    Some(dir.canonicalize().unwrap())
}

/// A repository with a submodule and one worktree of it: the folder a conversation would work in.
/// Returns the project, the bot, the repository, the worktree and the family folder.
async fn submodule_project(st: &AppState, label: &str) -> Option<(String, String, PathBuf, PathBuf, PathBuf)> {
    let source = submodule_source(label)?;
    let repo = std::env::temp_dir().join(format!("bitbots-p3-subrepo-{label}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| std::process::Command::new("git").current_dir(&repo).args(args).output().map(|output| output.status.success()).unwrap_or(false);
    if !git(&["init", "-q"]) || !git(&["config", "core.autocrlf", "false"]) { return None; }
    std::fs::write(repo.join("readme.txt"), "hello\n").unwrap();
    git(&["add", "."]);
    git(&["-c","user.name=Test","-c","user.email=test@bitbots.local","commit","-q","-m","init"]);
    // A test-only allowance: the submodule's origin is a folder on this machine, not the network.
    if !git(&["config", "protocol.file.allow", "always"]) { return None; }
    if !git(&["-c","protocol.file.allow=always","submodule","add","-q", source.to_str().unwrap(), "sub"]) { return None; }
    git(&["-c","user.name=Test","-c","user.email=test@bitbots.local","commit","-q","-m","sub"]);
    let family = repo.parent().unwrap().join(format!("{}-bitbots", repo.file_name().unwrap().to_string_lossy()));
    std::fs::create_dir_all(&family).unwrap();
    let worktree = family.join("task");
    if !git(&["worktree", "add", "-q", "-b", "bitbots/task", worktree.to_str().unwrap(), "HEAD"]) { return None; }
    let project = st.db.project_create("Subs", Some(&repo.to_string_lossy())).unwrap().0["id"].as_str().unwrap().to_owned();
    set_overrides(st, &project, json!({"initSubmodules": true})).await.unwrap();
    let agent = new_agent(st, "Subber");
    Some((project, agent, repo, worktree, family))
}

#[tokio::test]
async fn submodules_are_initialised_in_the_worktree() {
    let (st, adapter) = online_team_state().await;
    let Some((project, agent, repo, worktree, family)) = submodule_project(&st, "init").await else { return };
    assert!(!worktree.join("sub").join("inner.txt").exists(), "the checkout has the link, not the content");
    let sid = open_with_worktree(&st, &agent, &project, &worktree).await;
    dispatch(&st, "session.prompt", json!({"sessionId":sid,"text":"Start"})).await.unwrap();
    wait_for_messages(&st, &sid, |messages| messages.iter().any(|message| message["role"] == "assistant")).await;
    let notice = last_notice(&st, &sid);
    assert_eq!(notice["meta"]["status"], "done", "{notice}");
    assert_eq!(notice["content"], "Set up submodules.");
    assert_eq!(std::fs::read_to_string(worktree.join("sub").join("inner.txt")).unwrap(), "inner\n", "the submodule is filled in the worktree");
    assert!(adapter.prompts.lock().unwrap()[0].contains("Start"), "the turn ran");
    let _ = std::process::Command::new("git").current_dir(&repo).args(["worktree","prune"]).output();
    let _ = std::fs::remove_dir_all(family);
    let _ = std::fs::remove_dir_all(repo);
}

#[tokio::test]
async fn stop_during_submodules_cancels() {
    let (st, adapter) = online_team_state().await;
    let Some((project, agent, repo, worktree, family)) = submodule_project(&st, "stop").await else { return };
    // A script too, to prove a stop before the submodule step cancels the rest of the setup.
    set_overrides(&st, &project, json!({"initSubmodules": true, "setupScript": "echo ran> script.txt"})).await.unwrap();
    let sid = open_with_worktree(&st, &agent, &project, &worktree).await;
    st.db.update_session_state(&sid, "cancelling").unwrap();
    let ended = project_setup::before_first_turn(&st, &sid, "turn-stop").await;
    assert!(matches!(ended, project_setup::Setup::Cancelled), "the owner's stop cancels the setup");
    assert!(!worktree.join("script.txt").exists(), "the script never runs after a stop");
    let notices = setup_notices(&st, &sid);
    assert_eq!(notices.iter().map(|notice| notice["meta"]["status"].as_str().unwrap_or("")).collect::<Vec<_>>(), ["running", "cancelled"]);
    assert!(adapter.prompts.lock().unwrap().is_empty(), "the provider was never asked");
    let _ = std::process::Command::new("git").current_dir(&repo).args(["worktree","prune"]).output();
    let _ = std::fs::remove_dir_all(family);
    let _ = std::fs::remove_dir_all(repo);
}

#[tokio::test]
async fn backups_do_not_carry_copy_files() {
    let (st, _) = state();
    let (project, _) = real_project(&st, "Copier");
    set_overrides(&st, &project, json!({"copyFiles":["private-note.txt"],"initSubmodules":true})).await.unwrap();
    let exported = dispatch(&st, "backup.export", json!({})).await.unwrap();
    let text = exported.to_string();
    assert!(!text.contains("private-note.txt") && !text.contains("copyFiles") && !text.contains("initSubmodules"), "a backup carries no project setup files");
}

// ── Section 5: clone and discover ─────────────────────────────────────────

fn p3_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bitbots-p3-{label}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    // Not canonicalised: `\\?\` paths are not what a person's folder picker returns, and git refuses
    // them as a clone target.
    dir
}

/// A local repository a test may clone from, installed for as long as the guard lives. The rule for
/// real calls (network addresses only) stands; this is the one test-only allowance.
struct LocalRepo {
    path: PathBuf,
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

impl LocalRepo {
    /// A repository with one commit, at `<temp>/source`.
    async fn real(label: &str) -> Option<Self> {
        let guard = crate::project_clone::CLONE_TEST_LOCK.lock().await;
        let path = p3_dir(&format!("{label}-source"));
        let git = |args: &[&str]| std::process::Command::new("git").current_dir(&path).args(args).output().map(|output| output.status.success()).unwrap_or(false);
        if !git(&["init", "-q"]) { return None; }
        std::fs::write(path.join("readme.txt"), "cloned\n").unwrap();
        git(&["add", "."]);
        git(&["-c","user.name=Test","-c","user.email=test@bitbots.local","commit","-q","-m","init"]);
        *crate::project_clone::LOCAL_REPO.lock().unwrap() = Some(path.clone());
        Some(Self { path, _guard: guard })
    }

    /// A path that is allowed through the URL check but holds no repository: git cannot clone it.
    async fn missing(label: &str) -> Self {
        let guard = crate::project_clone::CLONE_TEST_LOCK.lock().await;
        let path = std::env::temp_dir().join(format!("bitbots-p3-{label}-not-a-repo-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        *crate::project_clone::LOCAL_REPO.lock().unwrap() = Some(path.clone());
        Self { path, _guard: guard }
    }
}

impl Drop for LocalRepo {
    fn drop(&mut self) { *crate::project_clone::LOCAL_REPO.lock().unwrap() = None; }
}

async fn job_of(st: &AppState, id: &str) -> Value {
    for _ in 0..400 {
        let listed = dispatch(st, "project.clone.list", json!({})).await.unwrap()["jobs"].as_array().cloned().unwrap_or_default();
        if let Some(job) = listed.into_iter().find(|job| job["id"].as_str() == Some(id)) {
            if job["state"] != "running" { return job; }
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the clone never finished");
}

#[tokio::test]
async fn clone_refuses_dangerous_urls() {
    let _guard = crate::project_clone::CLONE_TEST_LOCK.lock().await;
    *crate::project_clone::LOCAL_REPO.lock().unwrap() = None;
    let (st, _) = state();
    let parent = p3_dir("clone-danger");
    for url in [
        "-u", "-c core.pager=calc", "ext::sh -c echo", "ext::git-remote-ext", "file:///C:/repo", "FILE:///C:/repo",
        "http://example.com/x.git", "ftp://example.com/x.git", "not a url", "https://", "git@:path", "https:///path",
        "git@host:", "  https://github.com/a/b.git",
    ] {
        let error = dispatch(&st, "project.clone", json!({"url":url,"parent":parent,"confirm":true})).await.unwrap_err();
        assert_eq!(error.1.code, "invalid_argument", "{url}");
        assert!(!parent.join("b").exists(), "{url} never started a clone");
    }
    // The allowed forms are checked before git runs, in the module's own test.
    let _ = std::fs::remove_dir_all(parent);
}

#[tokio::test]
async fn clone_refuses_a_password_in_the_url() {
    let (st, _) = state();
    let parent = p3_dir("clone-password");
    for url in ["https://user:secret@example.com/x.git", "ssh://user:secret@example.com/x.git", "https://user:p%40ss@example.com/x.git"] {
        let error = dispatch(&st, "project.clone", json!({"url":url,"parent":parent,"confirm":true})).await.unwrap_err();
        assert_eq!(error.1.code, "invalid_argument", "{url}");
        assert_eq!(error.1.message, "Put no password in the URL. Sign in with git or the GitHub CLI instead.");
    }
    let _ = std::fs::remove_dir_all(parent);
}

#[tokio::test]
async fn clone_refuses_an_existing_target() {
    let Some(repo) = LocalRepo::real("existing").await else { return };
    let (st, _) = state();
    let parent = p3_dir("clone-existing");
    std::fs::create_dir_all(parent.join("source")).unwrap();
    let error = dispatch(&st, "project.clone", json!({"url":repo.path.to_string_lossy(),"parent":parent,"name":"source","confirm":true})).await.unwrap_err();
    assert_eq!(error.1.code, "conflict");
    assert_eq!(error.1.message, "That folder already exists.");
    let _ = std::fs::remove_dir_all(parent);
}

#[tokio::test]
async fn clone_needs_confirm() {
    let Some(repo) = LocalRepo::real("confirm").await else { return };
    let (st, _) = state();
    let parent = p3_dir("clone-confirm");
    for params in [
        json!({"url":repo.path.to_string_lossy(),"parent":parent}),
        json!({"url":repo.path.to_string_lossy(),"parent":parent,"confirm":false}),
    ] {
        let error = dispatch(&st, "project.clone", params).await.unwrap_err();
        assert_eq!((error.1.code.as_str(), error.1.message.as_str()), ("invalid_argument", "Confirm cloning the repository first."));
    }
    assert!(dispatch(&st, "project.clone.list", json!({})).await.unwrap()["jobs"].as_array().unwrap().iter().all(|job| job["url"] != json!(repo.path.to_string_lossy())), "no job was made");
    let _ = std::fs::remove_dir_all(parent);
}

#[tokio::test]
async fn clone_registers_the_project() {
    let Some(repo) = LocalRepo::real("register").await else { return };
    let (st, _) = state();
    let parent = p3_dir("clone-register");
    let started = dispatch(&st, "project.clone", json!({"url":repo.path.to_string_lossy(),"parent":parent,"name":"Cloned","confirm":true})).await.unwrap();
    let id = started["job"]["id"].as_str().unwrap().to_owned();
    assert_eq!(started["job"]["state"], "running", "the call answers at once");
    let job = job_of(&st, &id).await;
    assert_eq!(job["state"], "done", "{job}");
    assert_eq!(std::fs::read_to_string(parent.join("Cloned").join("readme.txt")).unwrap().trim(), "cloned", "git's own line endings are not the clone's business");
    let project = &job["project"];
    assert_eq!(project["name"], "Cloned");
    assert_eq!(PathBuf::from(project["path"].as_str().unwrap()), parent.join("Cloned"), "registered through project.create");
    let listed = dispatch(&st, "project.list", json!({})).await.unwrap();
    assert!(listed["projects"].as_array().unwrap().iter().any(|row| row["id"] == project["id"]));
    // A window that reopens sees the finished job.
    let jobs = dispatch(&st, "project.clone.list", json!({})).await.unwrap()["jobs"].as_array().cloned().unwrap();
    assert!(jobs.iter().any(|row| row["id"] == id.as_str() && row["state"] == "done"));
    let _ = std::fs::remove_dir_all(parent);
}

#[tokio::test]
async fn a_failed_clone_removes_only_its_own_folder() {
    let repo = LocalRepo::missing("failed").await;
    let (st, _) = state();
    let parent = p3_dir("clone-failed");
    let keep = parent.join("Keep");
    std::fs::create_dir_all(&keep).unwrap();
    std::fs::write(keep.join("mine.txt"), "my work\n").unwrap();
    let started = dispatch(&st, "project.clone", json!({"url":repo.path.to_string_lossy(),"parent":parent,"name":"Broken","confirm":true})).await.unwrap();
    let id = started["job"]["id"].as_str().unwrap().to_owned();
    let job = job_of(&st, &id).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert!(job["detail"].as_str().is_some_and(|detail| !detail.is_empty()), "one plain sentence: {job}");
    assert!(!parent.join("Broken").exists(), "the folder this job made is gone");
    assert!(keep.join("mine.txt").exists(), "nothing else on the disk is touched");
    assert!(dispatch(&st, "project.list", json!({})).await.unwrap()["projects"].as_array().unwrap().is_empty(), "no project is registered");
    let _ = std::fs::remove_dir_all(parent);
}

#[tokio::test]
async fn cancel_stops_the_clone_and_cleans_up() {
    let Some(repo) = LocalRepo::real("cancel").await else { return };
    let (st, _) = state();
    let parent = p3_dir("clone-cancel");
    // A slow transport, so the cancel lands while the job is running.
    crate::project_clone::CLONE_DELAY_MS.store(3_000, std::sync::atomic::Ordering::SeqCst);
    let started = dispatch(&st, "project.clone", json!({"url":repo.path.to_string_lossy(),"parent":parent,"name":"Stopped","confirm":true})).await.unwrap();
    let id = started["job"]["id"].as_str().unwrap().to_owned();
    let cancelling = dispatch(&st, "project.clone.cancel", json!({"id":id})).await.unwrap();
    assert_eq!(cancelling["job"]["id"], id.as_str());
    let job = job_of(&st, &id).await;
    crate::project_clone::CLONE_DELAY_MS.store(0, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(job["state"], "cancelled", "{job}");
    assert!(!parent.join("Stopped").exists(), "a cancelled clone leaves no folder");
    assert!(dispatch(&st, "project.list", json!({})).await.unwrap()["projects"].as_array().unwrap().is_empty(), "and no project");
    assert_eq!(dispatch(&st, "project.clone.cancel", json!({"id":"no-such-job"})).await.unwrap_err().1.code, "not_found");
    let _ = std::fs::remove_dir_all(parent);
}

/// A repository with one commit, at `path`.
fn make_repo(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    let git = |args: &[&str]| std::process::Command::new("git").current_dir(path).args(args).output().map(|output| output.status.success()).unwrap_or(false);
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(path.join("readme.txt"), "x\n").unwrap();
    git(&["add", "."]);
    git(&["-c","user.name=Test","-c","user.email=test@bitbots.local","commit","-q","-m","init"]);
}

#[tokio::test]
async fn discover_finds_repositories_within_depth() {
    let root = p3_dir("discover-depth");
    // One repository directly below the folder, and one three levels down.
    make_repo(&root.join("one"));
    make_repo(&root.join("b").join("c").join("two"));
    let (st, _) = state();
    let shallow = dispatch(&st, "project.discover", json!({"folder":root,"depth":1})).await.unwrap();
    let names = |reply: &Value| reply["repos"].as_array().unwrap().iter().map(|repo| repo["name"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(names(&shallow), vec!["one".to_owned()], "{shallow}");
    let deep = dispatch(&st, "project.discover", json!({"folder":root,"depth":3})).await.unwrap();
    let mut found = names(&deep);
    found.sort();
    assert_eq!(found, vec!["one".to_owned(), "two".to_owned()], "a deeper repository is found too: {deep}");
    assert_eq!(deep["repos"][0]["branch"], "main", "the branch is read");
    assert_eq!(deep["repos"][0]["alreadyAdded"], false);
    assert_eq!(deep["truncated"], false);
    // The depth is capped at five, and the folder is echoed back.
    assert!(dispatch(&st, "project.discover", json!({"folder":root,"depth":99})).await.unwrap()["repos"].as_array().unwrap().len() >= 2);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn discover_stops_at_a_repository() {
    let root = p3_dir("discover-stop");
    make_repo(&root.join("project"));
    make_repo(&root.join("project").join("sub"));
    let (st, _) = state();
    let reply = dispatch(&st, "project.discover", json!({"folder":root})).await.unwrap();
    let repos = reply["repos"].as_array().unwrap();
    assert_eq!(repos.len(), 1, "a submodule or nested copy is not listed separately: {reply}");
    assert_eq!(repos[0]["name"], "project");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn discover_skips_hidden_and_build_folders() {
    let root = p3_dir("discover-skip");
    for skipped in [".hidden", "node_modules", "target", "dist", "vendor", "thing-bitbots"] {
        make_repo(&root.join(skipped).join("inner"));
    }
    make_repo(&root.join("visible"));
    let (st, _) = state();
    let reply = dispatch(&st, "project.discover", json!({"folder":root})).await.unwrap();
    let names: Vec<String> = reply["repos"].as_array().unwrap().iter().map(|repo| repo["name"].as_str().unwrap().to_owned()).collect();
    assert_eq!(names, vec!["visible".to_owned()], "{reply}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn discover_marks_what_is_already_added() {
    let root = p3_dir("discover-added");
    make_repo(&root.join("known"));
    make_repo(&root.join("fresh"));
    let (st, _) = state();
    st.db.project_create("Known", Some(&root.join("known").to_string_lossy())).unwrap();
    let reply = dispatch(&st, "project.discover", json!({"folder":root})).await.unwrap();
    for repo in reply["repos"].as_array().unwrap() {
        let wanted = repo["name"] == "known";
        assert_eq!(repo["alreadyAdded"], wanted, "{repo}");
    }
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn discover_caps_what_it_lists() {
    let root = p3_dir("discover-cap");
    for index in 0..205 {
        std::fs::create_dir_all(root.join(format!("repo{index:03}")).join(".git")).unwrap();
    }
    let (st, _) = state();
    let reply = dispatch(&st, "project.discover", json!({"folder":root})).await.unwrap();
    assert_eq!(reply["repos"].as_array().unwrap().len(), 200, "at most 200 repositories");
    assert_eq!(reply["truncated"], true);
    let _ = std::fs::remove_dir_all(root);
}

// ── Section 6: file and content search ────────────────────────────────────

fn p3_write(root: &Path, name: &str, content: &str) {
    let path = root.join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).unwrap(); }
    std::fs::write(path, content).unwrap();
}

/// A registered project for a folder: the way a search names its target.
fn p3_project(st: &AppState, folder: &Path) -> String {
    st.db.project_create("Search", Some(&folder.to_string_lossy())).unwrap().0["id"].as_str().unwrap().to_owned()
}

async fn files_in(st: &AppState, project: &str, query: &str) -> Value {
    dispatch(st, "project.files.search", json!({"projectId":project,"query":query})).await.unwrap()
}

async fn content_in(st: &AppState, project: &str, query: &str) -> Value {
    dispatch(st, "project.content.search", json!({"projectId":project,"query":query})).await.unwrap()
}

fn paths_of(reply: &Value) -> Vec<String> {
    reply["files"].as_array().unwrap().iter().map(|file| file["path"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn files_rank_the_name_above_the_folder() {
    let root = p3_dir("search-name");
    p3_write(&root, "app/main.ts", "x");
    p3_write(&root, "main/other.ts", "x");
    let (st, _) = state();
    let project = p3_project(&st, &root);
    let reply = files_in(&st, &project, "main").await;
    let paths = paths_of(&reply);
    assert_eq!(paths.first().map(String::as_str), Some("app/main.ts"), "a match in the file name wins: {reply}");
    assert!(paths.contains(&"main/other.ts".to_owned()));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn files_rank_consecutive_above_scattered() {
    let root = p3_dir("search-runs");
    p3_write(&root, "test.ts", "x");
    p3_write(&root, "t/x/e/s/t.ts", "x");
    let (st, _) = state();
    let project = p3_project(&st, &root);
    let paths = paths_of(&files_in(&st, &project, "test").await);
    assert_eq!(paths.first().map(String::as_str), Some("test.ts"), "a run of characters beats a scattered match: {paths:?}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn files_report_where_the_query_matched() {
    let root = p3_dir("search-indexes");
    p3_write(&root, "src/main.rs", "x");
    let (st, _) = state();
    let project = p3_project(&st, &root);
    let reply = files_in(&st, &project, "ma").await;
    let file = &reply["files"][0];
    assert_eq!(file["path"], "src/main.rs");
    assert_eq!(file["name"], "main.rs");
    assert_eq!(file["matches"], json!([4, 5]), "the character indexes in the path");
    assert!(file["score"].as_i64().is_some());
    // An empty query matches everywhere, with no indexes.
    assert_eq!(files_in(&st, &project, "").await["files"][0]["matches"], json!([]));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn files_leave_out_secret_names() {
    let root = p3_dir("search-secrets");
    p3_write(&root, ".env", "TOKEN=x");
    p3_write(&root, "id_rsa", "secret");
    p3_write(&root, "key.pem", "secret");
    p3_write(&root, "notes.txt", "fine");
    let (st, _) = state();
    let project = p3_project(&st, &root);
    let reply = files_in(&st, &project, "").await;
    assert_eq!(paths_of(&reply), vec!["notes.txt".to_owned()], "{reply}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn files_respect_gitignore() {
    let root = p3_dir("search-ignore");
    make_repo(&root);
    p3_write(&root, ".gitignore", "ignored/\n*.log\n");
    p3_write(&root, "ignored/hidden.txt", "x");
    p3_write(&root, "noise.log", "x");
    p3_write(&root, "shown.txt", "x");
    let (st, _) = state();
    let project = p3_project(&st, &root);
    let reply = files_in(&st, &project, "txt").await;
    assert_eq!(reply["source"], "git");
    let paths = paths_of(&reply);
    assert!(paths.contains(&"shown.txt".to_owned()), "a plain file is offered: {reply}");
    assert!(!paths.iter().any(|path| path.starts_with("ignored/")), "an ignored folder is not offered: {paths:?}");
    assert!(!paths.contains(&"noise.log".to_owned()), "an ignored pattern is not offered: {paths:?}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn files_work_outside_a_repository() {
    let root = p3_dir("search-plain");
    p3_write(&root, "notes/today.md", "x");
    let (st, _) = state();
    let project = p3_project(&st, &root);
    let reply = files_in(&st, &project, "today").await;
    assert_eq!(reply["source"], "walk", "a plain folder is walked");
    assert_eq!(paths_of(&reply), vec!["notes/today.md".to_owned()]);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn an_empty_query_gives_the_shortest_paths() {
    let root = p3_dir("search-shortest");
    p3_write(&root, "bb/cc/dd.txt", "x");
    p3_write(&root, "a.txt", "x");
    p3_write(&root, "bb/cc.txt", "x");
    let (st, _) = state();
    let project = p3_project(&st, &root);
    let paths = paths_of(&files_in(&st, &project, "").await);
    assert_eq!(paths, vec!["a.txt".to_owned(), "bb/cc.txt".to_owned(), "bb/cc/dd.txt".to_owned()], "{paths:?}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn content_finds_a_line_in_a_tracked_and_an_untracked_file() {
    let root = p3_dir("content-git");
    make_repo(&root);
    p3_write(&root, "tracked.txt", "first\nneedle in a tracked file\n");
    let git = |args: &[&str]| std::process::Command::new("git").current_dir(&root).args(args).output().map(|output| output.status.success()).unwrap_or(false);
    git(&["add", "tracked.txt"]);
    p3_write(&root, "untracked.txt", "needle in a new file\n");
    let (st, _) = state();
    let project = p3_project(&st, &root);
    let reply = content_in(&st, &project, "needle").await;
    assert_eq!(reply["source"], "git");
    let results = reply["results"].as_array().unwrap();
    assert_eq!(results.len(), 2, "{reply}");
    assert!(results.iter().any(|row| row["path"] == "tracked.txt" && row["line"] == 2));
    assert!(results.iter().any(|row| row["path"] == "untracked.txt" && row["line"] == 1));
    assert_eq!(results[1]["preview"].as_str().unwrap(), "needle in a new file", "the line is trimmed");
    assert!(reply["truncated"] == false && reply["reason"].is_null());
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn content_leaves_out_secret_files_and_binaries() {
    let root = p3_dir("content-secrets");
    make_repo(&root);
    p3_write(&root, ".env", "needle=1\n");
    p3_write(&root, "ok.txt", "needle here\n");
    std::fs::write(root.join("bin.dat"), b"needle\x00\x01\x02\n").unwrap();
    let (st, _) = state();
    let project = p3_project(&st, &root);
    let reply = content_in(&st, &project, "needle").await;
    let paths: Vec<String> = reply["results"].as_array().unwrap().iter().map(|row| row["path"].as_str().unwrap().to_owned()).collect();
    assert_eq!(paths, vec!["ok.txt".to_owned()], "a secret name and a binary are left out: {reply}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn content_treats_the_query_as_literal_unless_regex() {
    let root = p3_dir("content-regex");
    p3_write(&root, "lines.txt", "first\na.c\nabc\n");
    let (st, _) = state();
    let project = p3_project(&st, &root);
    let literal = content_in(&st, &project, "a.c").await;
    assert_eq!(literal["results"].as_array().unwrap().len(), 1, "a dot is a dot: {literal}");
    assert_eq!(literal["results"][0]["line"], 2);
    let pattern = dispatch(&st, "project.content.search", json!({"projectId":project,"query":"a.c","regex":true})).await.unwrap();
    assert_eq!(pattern["results"].as_array().unwrap().len(), 2, "a regex matches both: {pattern}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_bad_pattern_gets_a_reason() {
    let root = p3_dir("content-bad");
    p3_write(&root, "a.txt", "anything\n");
    let (st, _) = state();
    let project = p3_project(&st, &root);
    let reply = dispatch(&st, "project.content.search", json!({"projectId":project,"query":"(","regex":true})).await.unwrap();
    assert_eq!(reply["results"], json!([]));
    assert_eq!(reply["reason"], "That isn't a valid search pattern.");
    // A literal search of the same text is fine, and an empty query is refused.
    assert_eq!(content_in(&st, &project, "(").await["reason"], Value::Null);
    assert_eq!(dispatch(&st, "project.content.search", json!({"projectId":project,"query":""})).await.unwrap_err().1.code, "invalid_argument");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn content_works_outside_a_repository() {
    let root = p3_dir("content-plain");
    p3_write(&root, "docs/notes.md", "  needle in a plain folder  \n");
    let (st, _) = state();
    let project = p3_project(&st, &root);
    let reply = content_in(&st, &project, "needle").await;
    assert_eq!(reply["source"], "walk");
    let results = reply["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!((results[0]["path"].as_str(), results[0]["line"].as_u64(), results[0]["preview"].as_str()), (Some("docs/notes.md"), Some(1), Some("needle in a plain folder")));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn search_without_a_folder_is_empty() {
    let (st, _) = state();
    let empty = dispatch(&st, "project.files.search", json!({"query":"x"})).await.unwrap();
    assert_eq!(empty["files"], json!([]));
    assert_eq!(dispatch(&st, "project.content.search", json!({"query":"x"})).await.unwrap()["results"], json!([]));
    // A project with no folder, and a conversation that does not exist, are the same empty answer.
    let project = st.db.project_create("No folder", None).unwrap().0["id"].as_str().unwrap().to_owned();
    assert_eq!(dispatch(&st, "project.files.search", json!({"projectId":project,"query":"x"})).await.unwrap()["files"], json!([]));
    assert_eq!(dispatch(&st, "project.content.search", json!({"sessionId":"nope","query":"x"})).await.unwrap()["results"], json!([]));
}
