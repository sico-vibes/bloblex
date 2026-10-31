// Phase 4, Gogo's lane: taking a branch from another machine, and importing a conversation.
// Included into `phase2a_tests` so it shares that module's fixtures: `state`, `dispatch`, `json!`,
// `PathBuf`, `Uuid` and `git_in` (from `phase4_projects_tests.rs`).

/// A bare `origin` with `main`, the `seed` clone that pushes to it, and a `clone` that stands in for
/// this machine's repository.
fn origin_and_clone(label: &str) -> (PathBuf, PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("bitbots-4-{label}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    let origin = base.join("origin.git");
    let seed = base.join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    let origin_arg = origin.to_string_lossy().into_owned();
    git_in(&seed, &["init", "-q", "--bare", &origin_arg]);
    git_in(&seed, &["init", "-q", "-b", "main"]);
    git_in(&seed, &["config", "user.email", "test@example.com"]);
    git_in(&seed, &["config", "user.name", "Test"]);
    git_in(&seed, &["config", "core.autocrlf", "false"]);
    std::fs::write(seed.join("readme.md"), "seed\n").unwrap();
    git_in(&seed, &["add", "-A"]);
    git_in(&seed, &["commit", "-q", "-m", "seed"]);
    git_in(&seed, &["remote", "add", "origin", &origin_arg]);
    git_in(&seed, &["push", "-q", "origin", "main"]);
    // The bare repository's own HEAD, so a clone checks `main` out.
    git_in(&origin, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    let clone = base.join("clone");
    let clone_arg = clone.to_string_lossy().into_owned();
    git_in(&base, &["clone", "-q", &origin_arg, &clone_arg]);
    git_in(&clone, &["config", "user.email", "test@example.com"]);
    git_in(&clone, &["config", "user.name", "Test"]);
    (origin, seed, clone)
}

/// Commit a file on `branch` in `seed` and push it, as the machine giving the conversation would.
fn push_branch(seed: &Path, branch: &str, file: &str) {
    let exists = !git_in(seed, &["branch", "--list", branch]).trim().is_empty();
    if exists { git_in(seed, &["checkout", "-q", branch]); } else { git_in(seed, &["checkout", "-q", "-b", branch]); }
    std::fs::write(seed.join(file), format!("{branch}\n")).unwrap();
    git_in(seed, &["add", "-A"]);
    git_in(seed, &["commit", "-q", "-m", "work"]);
    git_in(seed, &["push", "-q", "origin", branch]);
}

#[tokio::test]
async fn attach_creates_a_copy_from_the_remote_branch() {
    let (_origin, seed, clone) = origin_and_clone("attach-new");
    push_branch(&seed, "bitbots/feature", "feature.txt");
    let attached = crate::worktree_attach::attach_branch(&clone, "bitbots/feature").expect("a copy");
    assert_eq!(attached.branch, "bitbots/feature");
    assert!(attached.path.is_dir(), "the copy is made");
    assert!(attached.path.join("feature.txt").is_file(), "the branch's work is there");
    assert_eq!(attached.path.parent().unwrap().file_name().unwrap().to_string_lossy(), "clone-bitbots");
    assert_eq!(attached.path.file_name().unwrap().to_string_lossy(), "feature");
    // The local branch is at the fetched commit, and the clone's own checkout is untouched.
    assert_eq!(git_in(&clone, &["rev-parse", "bitbots/feature"]), attached.base_commit);
    assert_eq!(git_in(&clone, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
}

#[tokio::test]
async fn attach_fast_forwards_an_existing_copy() {
    let (_origin, seed, clone) = origin_and_clone("attach-ff");
    push_branch(&seed, "bitbots/ff", "one.txt");
    let first = crate::worktree_attach::attach_branch(&clone, "bitbots/ff").expect("a copy");
    push_branch(&seed, "bitbots/ff", "two.txt");
    let again = crate::worktree_attach::attach_branch(&clone, "bitbots/ff").expect("the same copy");
    assert_eq!(again.path, first.path, "the copy already on the branch is reused");
    assert!(again.path.join("two.txt").is_file(), "it is fast-forwarded");
}

#[tokio::test]
async fn attach_refuses_a_dirty_copy() {
    let (_origin, seed, clone) = origin_and_clone("attach-dirty");
    push_branch(&seed, "bitbots/dirty", "one.txt");
    let copy = crate::worktree_attach::attach_branch(&clone, "bitbots/dirty").expect("a copy");
    std::fs::write(copy.path.join("uncommitted.txt"), "keep me\n").unwrap();
    push_branch(&seed, "bitbots/dirty", "two.txt");
    let error = crate::worktree_attach::attach_branch(&clone, "bitbots/dirty").unwrap_err();
    assert!(error.contains("uncommitted"), "{error}");
    assert!(copy.path.join("uncommitted.txt").is_file(), "nothing is discarded");
    assert!(!copy.path.join("two.txt").exists(), "and nothing is merged");
}

#[tokio::test]
async fn attach_refuses_local_commits_it_would_lose() {
    let (_origin, seed, clone) = origin_and_clone("attach-lose");
    // A local branch here with a commit of its own...
    git_in(&clone, &["checkout", "-q", "-b", "bitbots/local"]);
    std::fs::write(clone.join("mine.txt"), "mine\n").unwrap();
    git_in(&clone, &["add", "-A"]);
    git_in(&clone, &["commit", "-q", "-m", "mine"]);
    git_in(&clone, &["checkout", "-q", "main"]);
    let mine = git_in(&clone, &["rev-parse", "bitbots/local"]);
    // ...and a different commit for the same branch on the remote.
    push_branch(&seed, "bitbots/local", "theirs.txt");
    let error = crate::worktree_attach::attach_branch(&clone, "bitbots/local").unwrap_err();
    assert_eq!(error, "`bitbots/local` has commits here that aren't on the remote.");
    assert_eq!(git_in(&clone, &["rev-parse", "bitbots/local"]), mine, "the local branch is not moved");
    assert!(git_in(&clone, &["status", "--porcelain"]).is_empty());
}

#[tokio::test]
async fn attach_refuses_a_branch_outside_bitbots() {
    let (_origin, _seed, clone) = origin_and_clone("attach-outside");
    for branch in ["main", "feature", "", "bitbots/", "refs/heads/bitbots/x"] {
        let error = crate::worktree_attach::attach_branch(&clone, branch).unwrap_err();
        assert!(error.contains("bitbots/") || error.contains("can't be used"), "{branch}: {error}");
    }
    assert!(!clone.parent().unwrap().join("clone-bitbots").join("main").exists(), "no copy was made");
}

#[tokio::test]
async fn attach_refuses_a_branch_starting_with_a_dash() {
    let (_origin, _seed, clone) = origin_and_clone("attach-dash");
    for branch in ["-x", "--upload-pack=evil", "-"] {
        assert_eq!(crate::worktree_attach::attach_branch(&clone, branch).unwrap_err(), "That branch name can't be used.", "{branch}");
    }
}

#[tokio::test]
async fn attach_takes_a_numbered_folder_when_the_name_is_used() {
    let (_origin, seed, clone) = origin_and_clone("attach-number");
    push_branch(&seed, "bitbots/used", "one.txt");
    let family = clone.parent().unwrap().join("clone-bitbots");
    std::fs::create_dir_all(family.join("used")).unwrap();
    let attached = crate::worktree_attach::attach_branch(&clone, "bitbots/used").expect("a copy");
    assert_eq!(attached.path.file_name().unwrap().to_string_lossy(), "used-2");
    assert!(family.join("used").is_dir(), "the folder that was there is left alone");
}

fn imported_row(id: &str) -> Value {
    json!({
        "id": id, "title": "Handed over", "provider": "codex", "runtimeId": "rt-test",
        "projectPath": ".", "createdAt": "2026-10-01T10:00:00.000Z", "state": "idle",
        "link": {"kind": "main", "movedTo": {"machineId": "m_1", "name": "Desk", "at": "2026-10-01T11:00:00.000Z"}},
        "data": {},
    })
}

#[tokio::test]
async fn importing_messages_skips_ones_already_there() {
    let (st, _) = state();
    st.db.session_import(&imported_row("handoff-1")).unwrap();
    let first = json!([
        {"id":"m_1","role":"user","content":"one","createdAt":"2026-10-01T10:00:00.000Z"},
        {"id":"m_2","role":"assistant","content":"two","createdAt":"2026-10-01T10:01:00.000Z"},
    ]);
    assert_eq!(st.db.session_import_messages("handoff-1", &first).unwrap(), json!({"inserted":2,"skipped":0}));
    let again = json!([
        {"id":"m_2","role":"assistant","content":"two","createdAt":"2026-10-01T10:01:00.000Z"},
        {"id":"m_3","role":"user","content":"three","createdAt":"2026-10-01T10:02:00.000Z"},
    ]);
    assert_eq!(st.db.session_import_messages("handoff-1", &again).unwrap(), json!({"inserted":1,"skipped":1}));
    let detail = st.db.session_detail("handoff-1").unwrap();
    let messages = detail["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    assert_eq!((messages[2]["content"].clone(), messages[2]["id"].clone()), (json!("three"), json!("m_3")));
    // The conversation is the one that came, and it is marked as moved to the machine that gave it.
    assert_eq!(detail["title"], "Handed over");
    assert_eq!(detail["link"]["movedTo"]["name"], "Desk");
}

#[tokio::test]
async fn importing_messages_keeps_their_order_and_times() {
    let (st, _) = state();
    st.db.session_import(&imported_row("handoff-2")).unwrap();
    // Given out of alphabetical order, with times that do not match the ids.
    let messages = json!([
        {"id":"z_last","role":"notice","content":"third","createdAt":"2026-09-03T09:00:00.000Z"},
        {"id":"a_first","role":"user","content":"first","createdAt":"2026-09-01T09:00:00.000Z"},
        {"id":"m_middle","role":"assistant","content":"second","createdAt":"2026-09-02T09:00:00.000Z"},
    ]);
    assert_eq!(st.db.session_import_messages("handoff-2", &messages).unwrap(), json!({"inserted":3,"skipped":0}));
    let detail = st.db.session_detail("handoff-2").unwrap();
    let rows = detail["messages"].as_array().unwrap();
    let got = rows.iter().map(|row| (row["id"].as_str().unwrap().to_owned(), row["createdAt"].as_str().unwrap().to_owned())).collect::<Vec<_>>();
    assert_eq!(got, vec![
        ("z_last".to_owned(), "2026-09-03T09:00:00.000Z".to_owned()),
        ("a_first".to_owned(), "2026-09-01T09:00:00.000Z".to_owned()),
        ("m_middle".to_owned(), "2026-09-02T09:00:00.000Z".to_owned()),
    ], "the order given is kept, and so is each time");
}

#[tokio::test]
async fn a_failed_import_leaves_nothing() {
    let (st, _) = state();
    // A row without a provider is refused, and no conversation appears.
    assert!(st.db.session_import(&json!({"id":"bad-1","title":"x","runtimeId":"rt-test","link":{"kind":"main"}})).is_err());
    assert!(st.db.session_detail("bad-1").is_err());
    // A message that cannot be read rolls back the ones before it in the same call.
    st.db.session_import(&imported_row("handoff-3")).unwrap();
    let mixed = json!([
        {"id":"ok_1","role":"user","content":"fine","createdAt":"2026-10-01T10:00:00.000Z"},
        {"id":"bad_1","role":"system","content":"not a role the package carries","createdAt":"2026-10-01T10:01:00.000Z"},
    ]);
    assert!(st.db.session_import_messages("handoff-3", &mixed).is_err());
    assert!(st.db.session_detail("handoff-3").unwrap()["messages"].as_array().unwrap().is_empty(), "nothing is left behind");
}

#[tokio::test]
async fn a_template_of_every_bot_carries_no_secrets() {
    let (st, _) = state();
    let bot = st.db.agent_create(&json!({"name":"Templated","runtimeId":"rt-test","customEnv":{"LANG":"super-secret-value"}})).unwrap().0;
    let id = bot["id"].as_str().unwrap().to_owned();
    let exported = dispatch(&st, "backup.export", json!({"include":{"agentIds":[id]}})).await.unwrap();
    assert_eq!(exported["document"]["kind"], "template");
    assert!(!exported.to_string().contains("super-secret-value"), "a template never carries an environment value");
}

#[tokio::test]
async fn updates_channel_never_travels_in_a_backup() {
    let (st, _) = state();
    st.db.set_setting("updates.channel", &json!("canary-test-channel")).unwrap();
    let exported = dispatch(&st, "backup.export", json!({})).await.unwrap();
    assert!(!exported.to_string().contains("canary-test-channel"), "the update channel is one machine's choice");
}
