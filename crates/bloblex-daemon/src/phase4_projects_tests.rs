// Phase 4, Gogo's lane: a project's repository identity (section 3).
// Included into `phase2a_tests` so it shares that module's fixtures: `state`, `dispatch`, `json!`,
// `PathBuf` and `Uuid`.

fn git_in(dir: &Path, args: &[&str]) -> String {
    let output = crate::experiments::git_command().arg("-C").arg(dir).args(args).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// A real folder that is a git repository, with an `origin` when one is given.
fn repo_folder(label: &str, origin: Option<&str>) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bitbots-4-{label}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    git_in(&dir, &["init", "-q", "-b", "main"]);
    if let Some(origin) = origin { git_in(&dir, &["remote", "add", "origin", origin]); }
    dir
}

/// Serializes the tests that read a folder's `origin` with the one that makes every read fail, so the
/// stub never catches another test mid-assertion. Async, because it is held across awaits.
static IDENTITY_READS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn hold_reads() -> tokio::sync::MutexGuard<'static, ()> { IDENTITY_READS.lock().await }

/// Test only: every `origin` read fails, as a timeout or a git that cannot start does. Cleared on drop,
/// so a failed assertion cannot leave the rest of the suite without reads.
struct FailReads;
impl FailReads {
    fn on() -> Self { crate::repo_identity::TEST_FAIL_READS.store(true, std::sync::atomic::Ordering::SeqCst); Self }
}
impl Drop for FailReads {
    fn drop(&mut self) { crate::repo_identity::TEST_FAIL_READS.store(false, std::sync::atomic::Ordering::SeqCst); }
}

#[test]
fn identity_is_the_same_for_every_url_shape() {
    for url in [
        "git@GitHub.com:Owner/Repo.git",
        "ssh://git@github.com/Owner/Repo",
        "https://user:token@github.com/Owner/Repo/",
        "https://github.com/owner/repo",
        "https://github.com/owner/repo.git",
        "https://github.com/owner/repo.git/",
        "git+ssh://git@github.com/Owner/Repo.git",
        "ssh://git@github.com:22/Owner/Repo.git",
        "https://github.com:443/Owner/Repo.git",
        "git@github.com:owner/repo",
    ] {
        assert_eq!(crate::repo_identity::normalize_remote(url).as_deref(), Some("github.com/owner/repo"), "{url}");
    }
    // A host that is not one of the three keeps its case, so it is a different identity.
    assert_eq!(crate::repo_identity::normalize_remote("git@example.com:Owner/Repo.git").as_deref(), Some("example.com/Owner/Repo"));
}

#[test]
fn identity_never_holds_a_credential() {
    for url in [
        "https://user:token@github.com/Owner/Repo.git",
        "https://oauth2:ghp_abcdefghijklmnop@gitlab.com/Team/App.git",
        "ssh://git:secret@bitbucket.org/team/app.git",
        "https://x-access-token:ghs_1234@github.com/o/r",
        "https://user:token@git.example.com:8443/Team/App.git",
    ] {
        let identity = crate::repo_identity::normalize_remote(url).expect("an identity");
        assert!(!identity.contains('@'), "{url} -> {identity}");
        let lower = identity.to_ascii_lowercase();
        for secret in ["token", "secret", "ghp_", "ghs_", "oauth2", "x-access-token"] {
            assert!(!lower.contains(secret), "{url} -> {identity}");
        }
    }
}

#[test]
fn other_hosts_keep_their_case_and_port() {
    let identity = crate::repo_identity::normalize_remote;
    assert_eq!(identity("git.example.com:8443/team/app").as_deref(), Some("git.example.com:8443/team/app"), "a non-default port stays");
    assert_eq!(identity("https://git.example.com:8443/Team/App").as_deref(), Some("git.example.com:8443/Team/App"));
    assert_eq!(identity("https://git.example.com/Team/App").as_deref(), Some("git.example.com/Team/App"), "a path on another host keeps its case");
    assert_eq!(identity("ssh://git@git.example.com:22/Team/App").as_deref(), Some("git.example.com/Team/App"), "the default port is left out");
    assert_eq!(identity("git@git.example.com:Team/App.git").as_deref(), Some("git.example.com/Team/App"));
    // The three hosts that ignore case lower the whole path.
    assert_eq!(identity("git@GitLab.com:Team/Sub/App.git").as_deref(), Some("gitlab.com/team/sub/app"));
    assert_eq!(identity("ssh://git@bitbucket.org/Team/App").as_deref(), Some("bitbucket.org/team/app"));
}

#[test]
fn a_local_path_has_no_identity() {
    for path in [
        "C:\\repos\\app", "c:/repos/app", "\\\\server\\share\\repo", "/home/me/repo", "./repo", "../repo", "repo", "", "  ",
        "file:///c:/repos/app", "file://server/share/repo", "ext::sh -c echo",
    ] {
        assert_eq!(crate::repo_identity::normalize_remote(path), None, "{path}");
    }
}

#[test]
fn safe_url_removes_the_password() {
    let safe = crate::repo_identity::safe_remote_url;
    assert_eq!(safe("https://user:token@github.com/Owner/Repo.git").as_deref(), Some("https://github.com/Owner/Repo.git"));
    assert_eq!(safe("git@github.com:Owner/Repo.git").as_deref(), Some("git@github.com:Owner/Repo.git"), "the literal git@ form carries no password");
    assert_eq!(safe("https://user:token@git.example.com:8443/Team/App?access_token=secret").as_deref(), Some("https://git.example.com:8443/Team/App"), "a query never travels either");
    // Only the literal `git` user stays. Any other user can be a token, so it is dropped.
    assert_eq!(safe("ghp_token123@github.com:owner/repo").as_deref(), Some("github.com:owner/repo"), "a token in the user position never travels");
    assert_eq!(safe("someone@git.example.com:8443/team/app").as_deref(), Some("git.example.com:8443/team/app"));
    assert_eq!(safe("git@git.example.com:8443/team/app").as_deref(), Some("git@git.example.com:8443/team/app"));
    // ssh needs its `git` user: without it the clone would run as the local Windows user and fail.
    assert_eq!(safe("ssh://git@github.com/Owner/Repo").as_deref(), Some("ssh://git@github.com/Owner/Repo"));
    assert_eq!(safe("ssh://git@git.example.com:8443/Team/App").as_deref(), Some("ssh://git@git.example.com:8443/Team/App"));
    assert_eq!(safe("ssh://someone:secret@github.com/Owner/Repo").as_deref(), Some("ssh://github.com/Owner/Repo"), "another user and its password are dropped");
    assert_eq!(safe("C:\\repos\\app"), None);
    assert_eq!(safe("file:///c:/repos/app"), None);
}

#[tokio::test]
async fn project_list_carries_the_identity() {
    let _reads = hold_reads().await;
    let (st, _) = state();
    let folder = repo_folder("identity", Some("https://user:ghp_secret@github.com/Owner/Repo.git"));
    let made = dispatch(&st, "project.create", json!({"name":"Repo","path":folder.to_string_lossy()})).await.unwrap();
    assert_eq!(made["project"]["repoIdentity"], "github.com/owner/repo");
    let id = made["project"]["id"].as_str().unwrap().to_owned();
    assert_eq!(dispatch(&st, "project.list", json!({})).await.unwrap()["projects"][0]["repoIdentity"], "github.com/owner/repo");
    assert_eq!(st.db.project_get(&id).unwrap()["repoIdentity"], "github.com/owner/repo");
    // A credential in the remote never reaches the column, the reply or the list.
    for text in [made.to_string(), dispatch(&st, "project.list", json!({})).await.unwrap().to_string(), st.db.project_get(&id).unwrap().to_string()] {
        assert!(!text.contains("ghp_secret") && !text.contains("user@"), "{text}");
    }
    let _ = std::fs::remove_dir_all(folder);
}

#[test]
fn the_identity_crosses_to_a_device_and_the_folder_does_not() {
    let row = json!({"projects": [{"id":"p_1","name":"Repo","path":"C:/Users/sam/repos/repo","repoIdentity":"github.com/owner/repo"}]});
    let got = crate::remote::policy::redact_result("project.list", &row, &crate::remote::policy::RedactOptions::default());
    assert_eq!(got["projects"][0]["repoIdentity"], "github.com/owner/repo", "an identity holds no credential, so it crosses");
    assert_ne!(got["projects"][0]["path"], row["projects"][0]["path"], "the folder stays tail-only");
}

#[tokio::test]
async fn project_list_runs_no_git() {
    let _reads = hold_reads().await;
    let (st, _) = state();
    let folder = repo_folder("no-git", Some("git@github.com:Owner/Repo.git"));
    dispatch(&st, "project.create", json!({"name":"Repo","path":folder.to_string_lossy()})).await.unwrap();
    // The folder stops being a repository. If the list read git again, the identity would be gone.
    std::fs::remove_dir_all(folder.join(".git")).unwrap();
    assert_eq!(dispatch(&st, "project.list", json!({})).await.unwrap()["projects"][0]["repoIdentity"], "github.com/owner/repo");
    let _ = std::fs::remove_dir_all(folder);
}

#[tokio::test]
async fn find_by_identity_skips_a_missing_folder() {
    let _reads = hold_reads().await;
    let (st, _) = state();
    let gone = repo_folder("gone", Some("https://github.com/Owner/Repo.git"));
    let here = repo_folder("here", Some("https://github.com/Owner/Repo.git"));
    let first = dispatch(&st, "project.create", json!({"name":"Gone","path":gone.to_string_lossy()})).await.unwrap()["project"]["id"].as_str().unwrap().to_owned();
    let second = dispatch(&st, "project.create", json!({"name":"Here","path":here.to_string_lossy()})).await.unwrap()["project"]["id"].as_str().unwrap().to_owned();
    let found = dispatch(&st, "project.findByIdentity", json!({"identity":"github.com/owner/repo"})).await.unwrap();
    assert_eq!(found["project"]["id"], first.as_str(), "the first project with the folder there");
    std::fs::remove_dir_all(&gone).unwrap();
    let found = dispatch(&st, "project.findByIdentity", json!({"identity":"github.com/owner/repo"})).await.unwrap();
    assert_eq!(found["project"]["id"], second.as_str(), "a project whose folder is gone is skipped");
    // The host is compared case-insensitively, as it was stored.
    assert_eq!(dispatch(&st, "project.findByIdentity", json!({"identity":"GitHub.com/Owner/Repo"})).await.unwrap()["project"]["id"], second.as_str());
    assert!(dispatch(&st, "project.findByIdentity", json!({"identity":"github.com/nobody/nothing"})).await.unwrap()["project"].is_null());
    assert_eq!(dispatch(&st, "project.findByIdentity", json!({})).await.unwrap_err().1.code, "invalid_argument");
    let _ = std::fs::remove_dir_all(here);
}

#[tokio::test]
async fn old_projects_get_an_identity_at_startup() {
    let _reads = hold_reads().await;
    let (st, _) = state();
    let folder = repo_folder("old", Some("ssh://git@gitlab.com/Team/App.git"));
    // A project registered before this version: the row is written with no identity.
    let id = st.db.project_create("Old", Some(&folder.to_string_lossy())).unwrap().0["id"].as_str().unwrap().to_owned();
    assert!(st.db.project_get(&id).unwrap()["repoIdentity"].is_null());
    crate::repo_identity::sweep(&st).await;
    assert_eq!(st.db.project_get(&id).unwrap()["repoIdentity"], "gitlab.com/team/app");
    // A project with no folder keeps none, and a folder that is gone is left as it is.
    let folderless = st.db.project_create("Nowhere", None).unwrap().0["id"].as_str().unwrap().to_owned();
    crate::repo_identity::sweep(&st).await;
    assert!(st.db.project_get(&folderless).unwrap()["repoIdentity"].is_null());
    let _ = std::fs::remove_dir_all(folder);
}

#[tokio::test]
async fn a_failed_read_keeps_the_stored_identity() {
    let _reads = hold_reads().await;
    let (st, _) = state();
    let folder = repo_folder("failed-read", Some("git@github.com:Owner/Repo.git"));
    let id = st.db.project_create("Repo", Some(&folder.to_string_lossy())).unwrap().0["id"].as_str().unwrap().to_owned();
    crate::repo_identity::sweep(&st).await;
    assert_eq!(st.db.project_get(&id).unwrap()["repoIdentity"], "github.com/owner/repo");
    {
        // Every read now fails, as a timeout or a git that cannot start does. That says nothing about
        // the folder, so the stored identity must stand.
        let _failing = FailReads::on();
        crate::repo_identity::sweep(&st).await;
        assert_eq!(st.db.project_get(&id).unwrap()["repoIdentity"], "github.com/owner/repo", "a failed sweep read keeps it");
        let kept = dispatch(&st, "project.update", json!({"projectId":id,"description":"Still here"})).await.unwrap();
        assert_eq!(kept["project"]["repoIdentity"], "github.com/owner/repo", "a failed update read keeps it");
    }
    // A read that finishes and finds no origin is evidence, and clears it.
    std::fs::remove_dir_all(folder.join(".git")).unwrap();
    crate::repo_identity::sweep(&st).await;
    assert!(st.db.project_get(&id).unwrap()["repoIdentity"].is_null(), "a finished read with no origin clears it");
    let _ = std::fs::remove_dir_all(folder);
}

#[tokio::test]
async fn project_update_refreshes_the_identity() {
    let _reads = hold_reads().await;
    let (st, _) = state();
    let folder = repo_folder("update", None);
    let made = dispatch(&st, "project.create", json!({"name":"Plain","path":folder.to_string_lossy()})).await.unwrap();
    let id = made["project"]["id"].as_str().unwrap().to_owned();
    assert!(made["project"]["repoIdentity"].is_null(), "a folder that is not a repository has no identity");
    git_in(&folder, &["remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
    let updated = dispatch(&st, "project.update", json!({"projectId":id,"description":"Same folder"})).await.unwrap();
    assert_eq!(updated["project"]["repoIdentity"], "github.com/owner/repo");
    // A sidebar collapse is layout, not settings: it never starts git, so the stored identity stands.
    git_in(&folder, &["remote", "set-url", "origin", "git@gitlab.com:Other/Repo.git"]);
    let collapsed = dispatch(&st, "project.update", json!({"projectId":id,"collapsed":true})).await.unwrap();
    assert_eq!(collapsed["project"]["repoIdentity"], "github.com/owner/repo");
    // Clearing the folder clears the identity with it.
    let cleared = dispatch(&st, "project.update", json!({"projectId":id,"path":null})).await.unwrap();
    assert!(cleared["project"]["repoIdentity"].is_null());
    let _ = std::fs::remove_dir_all(folder);
}
