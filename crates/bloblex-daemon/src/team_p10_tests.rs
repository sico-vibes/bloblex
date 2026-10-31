//! FIX39 P10: worktrees for parallel code tasks. Every test that needs a real
//! repository builds one under the system temp folder and removes it again; git
//! is required, so each such test skips when git is not on PATH.
use super::*;
#[cfg(windows)]
use crate::dispatch;
use crate::phase2a_tests::{state, TeamAdapter};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn git_available() -> bool {
    std::process::Command::new("git").arg("--version").output().map(|output| output.status.success()).unwrap_or(false)
}

fn git(dir: &Path, args: &[&str]) -> bool {
    std::process::Command::new("git").current_dir(dir).args(args).output().map(|output| output.status.success()).unwrap_or(false)
}

/// A temp repo with one committed file.
fn make_repo() -> Option<PathBuf> {
    if !git_available() { return None; }
    let dir = std::env::temp_dir().join(format!("bloblex-p10-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    assert!(git(&dir, &["init", "-q"]));
    assert!(git(&dir, &["config", "core.autocrlf", "false"]));
    std::fs::write(dir.join("readme.txt"), "hello\n").unwrap();
    assert!(git(&dir, &["add", "."]));
    assert!(git(&dir, &["-c", "user.name=Test", "-c", "user.email=test@bitbots.local", "commit", "-q", "-m", "init"]));
    Some(dir)
}

async fn fixture() -> (AppState, String, String) {
    let (mut st, _) = state();
    st.db.upsert_runtime(&json!({"id":"p10-rt","provider":"codex","status":"offline"})).unwrap();
    *st.runtimes.write().await = vec![json!({"id":"p10-rt","provider":"codex","status":"offline","executablePath":"unused-test-runtime","launchArgs":[]})];
    // A stub coding agent, so opening a delegated conversation does not need a
    // real CLI on the test machine.
    st.adapters = Arc::new(crate::Adapters { acp: st.adapters.acp.clone(), codex: Arc::new(TeamAdapter::default()), claude: st.adapters.claude.clone() });
    *st.team.data_dir.lock().unwrap() = Some(std::env::temp_dir().join(format!("p10-ws-{}", uuid::Uuid::new_v4())));
    let boss = st.db.agent_create(&json!({"name":"Manager","runtimeId":"p10-rt","systemRole":"manager"})).unwrap().0;
    let worker = st.db.agent_create(&json!({"name":"Builder","runtimeId":"p10-rt","approvalMode":"ask"})).unwrap().0;
    for (sid, agent) in [("p10-boss", &boss), ("p10-worker", &worker)] {
        st.db.create_session_for_agent(sid, "p10-rt", "codex", ".", sid, agent["id"].as_str()).unwrap();
        st.db.update_session_state(sid, "idle").unwrap();
    }
    (st, boss["id"].as_str().unwrap().into(), worker["id"].as_str().unwrap().into())
}

/// Seed a live turn for another conversation working in `path`.
async fn another_task_in(st: &AppState, session: &str, path: &str, agent: &str) {
    st.db.create_session_for_agent(session, "p10-rt", "codex", path, session, Some(agent)).unwrap();
    st.db.update_session_state(session, "working").unwrap();
    st.active_turns.lock().await.insert(session.to_owned(), "other-turn".into());
}

fn family_of(repo: &Path) -> PathBuf {
    repo.parent().unwrap().join(format!("{}-bitbots", repo.file_name().unwrap().to_str().unwrap()))
}

#[tokio::test]
async fn p10_isolates_a_code_task_when_another_runs_in_the_repo() {
    let Some(repo) = make_repo() else { return };
    let root = crate::worktree::repo_root(&repo).unwrap();
    let (st, _, worker) = fixture().await;
    another_task_in(&st, "p10-other", &repo.to_string_lossy(), &worker).await;
    let delegation = crate::team::delegate(&st, "p10-boss", &json!({
        "blob": worker, "message": "Add the login form", "topic": "Add login", "projectPath": repo.to_string_lossy()
    })).await.unwrap();
    let side = st.db.session_detail(&delegation.side).unwrap();
    let project_path = side["projectPath"].as_str().unwrap();
    assert!(PathBuf::from(project_path).starts_with(family_of(&root)), "ran in its own copy: {project_path}");
    assert_eq!(side["link"]["worktree"]["branch"], "bitbots/add-login");
    assert_eq!(side["link"]["worktree"]["repo"].as_str().unwrap(), root.to_string_lossy());
    let messages = side["messages"].as_array().cloned().unwrap_or_default();
    assert!(messages.iter().any(|message| message["content"].as_str().unwrap_or("").contains("separate copy")), "one line note: {messages:?}");
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&root)).ok();
}

#[tokio::test]
async fn p10_never_isolates_for_a_plain_folder_a_research_bot_or_no_clash() {
    let Some(repo) = make_repo() else { return };
    let root = crate::worktree::repo_root(&repo).unwrap();
    let (st, _, worker) = fixture().await;
    let builder = st.db.agent_get(&worker).unwrap();
    // No other task is working there yet.
    assert!(crate::team::prepare_worktree(&st, "p10-boss", &repo, "Add login", &builder).await.is_none());
    // A clash, but the folder is not a git repository.
    let plain = std::env::temp_dir().join(format!("bloblex-p10-plain-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&plain).unwrap();
    another_task_in(&st, "p10-other", &plain.to_string_lossy(), &worker).await;
    assert!(crate::team::prepare_worktree(&st, "p10-boss", &plain, "Add login", &builder).await.is_none());
    // A clash in a git repo, but the target is a research (read-only) bot.
    another_task_in(&st, "p10-repo-task", &repo.to_string_lossy(), &worker).await;
    let research_id = st.db.agent_create(&json!({"name":"Scout","runtimeId":"p10-rt"})).unwrap().0["id"].as_str().unwrap().to_owned();
    st.db.agent_set_team(&research_id, &json!({"tags":["researcher"]})).unwrap();
    let research = st.db.agent_get(&research_id).unwrap();
    assert!(crate::team::prepare_worktree(&st, "p10-boss", &repo, "Research the market", &research).await.is_none());
    // A clash in a git repo with a coding bot does isolate.
    let worktree = crate::team::prepare_worktree(&st, "p10-boss", &repo, "Add login", &builder).await;
    assert!(worktree.is_some());
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&root)).ok();
    std::fs::remove_dir_all(&plain).ok();
}

/// Create a side conversation whose link carries a real worktree with one
/// committed change, so `after_task_turn` sees work to offer.
fn side_with_change(st: &AppState, repo: &Path, worker: &str, session: &str) -> crate::worktree::Worktree {
    let worktree = crate::worktree::create(repo, "Add login").unwrap();
    std::fs::write(worktree.path.join("feature.txt"), "one\ntwo\n").unwrap();
    crate::worktree::commit_all(&worktree.path, "Bitbots task add-login").unwrap();
    st.db.create_session_for_agent(session, "p10-rt", "codex", &worktree.path.to_string_lossy(), "Add login", Some(worker)).unwrap();
    st.db.set_session_link(session, &json!({"kind":"side","peerAgentId":worker,"peerName":"Builder","originSessionId":"p10-boss","topic":"Add login","worktree":worktree.to_json()})).unwrap();
    st.db.update_session_state(session, "idle").unwrap();
    worktree
}

async fn offer_merge(st: &AppState, session: &str) -> Value {
    crate::proposals::after_task_turn(st, session, "turn.completed").await;
    st.db.proposals_pending().unwrap().into_iter().find(|proposal| proposal["kind"] == "merge").expect("a merge card")
}

#[tokio::test]
async fn p10_a_finished_task_offers_a_merge_and_approval_merges_it() {
    let Some(repo) = make_repo() else { return };
    let (st, _, worker) = fixture().await;
    let worktree = side_with_change(&st, &repo, &worker, "p10-side");
    let proposal = offer_merge(&st, "p10-side").await;
    assert_eq!(proposal["payload"]["branch"], "bitbots/add-login");
    assert_eq!(proposal["payload"]["conversation"], "p10-side");
    assert!(proposal["payload"]["files"].as_array().unwrap().iter().any(|file| file == "feature.txt"));
    assert!(proposal["payload"]["diffSummary"].as_str().unwrap().contains("1 file changed"));

    crate::proposals::decide(&st, &json!({"id":proposal["id"],"decision":"approve"})).await.unwrap();
    assert_eq!(std::fs::read_to_string(repo.join("feature.txt")).unwrap(), "one\ntwo\n");
    assert!(!worktree.path.exists(), "the copy is removed after a merge");
    assert!(st.db.session_detail("p10-side").unwrap()["link"].get("worktree").is_none(), "the record is cleared");
    std::fs::remove_dir_all(&repo).ok();
}

#[tokio::test]
async fn p10_a_rejected_merge_keeps_the_copy_unless_discarded() {
    let Some(repo) = make_repo() else { return };
    let (st, _, worker) = fixture().await;
    let worktree = side_with_change(&st, &repo, &worker, "p10-side-a");
    let proposal = offer_merge(&st, "p10-side-a").await;
    // Reject keeps the branch and its copy for the owner to inspect.
    crate::proposals::decide(&st, &json!({"id":proposal["id"],"decision":"reject"})).await.unwrap();
    assert!(worktree.path.exists(), "kept on plain reject");
    assert!(!repo.join("feature.txt").exists(), "nothing merged");
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&worktree.repo)).ok();

    // A second task, rejected with discard, removes the copy and branch.
    let Some(repo) = make_repo() else { return };
    let worktree = side_with_change(&st, &repo, &worker, "p10-side-b");
    let proposal = offer_merge(&st, "p10-side-b").await;
    crate::proposals::decide(&st, &json!({"id":proposal["id"],"decision":"reject","discard":true})).await.unwrap();
    assert!(!worktree.path.exists(), "discarded on request");
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&worktree.repo)).ok();
}

// FIX39 P10 audit F1: a finished task's copy is removed on merge, so a follow-up
// to the same bot must not resume the side conversation in a folder that is gone.
#[tokio::test]
async fn p10_a_follow_up_after_a_merge_runs_in_an_existing_folder() {
    let Some(repo) = make_repo() else { return };
    let root = crate::worktree::repo_root(&repo).unwrap();
    let (st, boss, worker) = fixture().await;
    let worktree = crate::worktree::create(&repo, "Add login").unwrap();
    std::fs::write(worktree.path.join("feature.txt"), "one\ntwo\n").unwrap();
    crate::worktree::commit_all(&worktree.path, "Bitbots task add-login").unwrap();
    // The side conversation a real delegation would create: the Manager started
    // it, so a later topic-less message reuses it.
    st.db.create_session_for_agent("p10-side", "p10-rt", "codex", &worktree.path.to_string_lossy(), "Add login", Some(&worker)).unwrap();
    st.db.set_session_link("p10-side", &json!({"kind":"side","peerAgentId":boss,"peerName":"Manager","originSessionId":"p10-boss","spawnedFromSessionId":"p10-boss","topic":"Add login","worktree":worktree.to_json()})).unwrap();
    st.db.update_session_state("p10-side", "idle").unwrap();
    let proposal = offer_merge(&st, "p10-side").await;
    crate::proposals::decide(&st, &json!({"id":proposal["id"],"decision":"approve"})).await.unwrap();
    assert!(!worktree.path.exists(), "the copy is removed after the merge");
    // The natural next step: ask the same bot for more with no topic, so the latest
    // side conversation is reused. It must run somewhere that exists.
    let follow_up = crate::team::delegate(&st, "p10-boss", &json!({"blob": worker, "message": "Also fix the footer"})).await.unwrap();
    assert_eq!(follow_up.side, "p10-side", "the follow-up continues the same conversation");
    let path = st.db.session_detail("p10-side").unwrap()["projectPath"].as_str().unwrap().to_owned();
    assert!(PathBuf::from(&path).is_dir(), "the follow-up runs in an existing folder, not the deleted copy: {path}");
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&root)).ok();
}

// FIX39 P10 audit F2: "another task is working" must also count a task the daemon
// has queued (no turn yet) and a session whose stored state alone says it works.
#[tokio::test]
async fn p10_isolates_when_the_other_task_is_queued_or_has_not_started_a_turn() {
    let Some(repo) = make_repo() else { return };
    let root = crate::worktree::repo_root(&repo).unwrap();
    let (st, _, worker) = fixture().await;
    // (a) The other task is mid-turn but has registered no active turn: its stored
    // state alone says it is working.
    st.db.create_session_for_agent("p10-state", "p10-rt", "codex", &repo.to_string_lossy(), "Other", Some(&worker)).unwrap();
    st.db.update_session_state("p10-state", "working").unwrap();
    let builder = st.db.agent_get(&worker).unwrap();
    assert!(crate::team::prepare_worktree(&st, "p10-boss", &repo, "Add login", &builder).await.is_some(),
        "a stored working state counts as a clash");
    st.db.update_session_state("p10-state", "idle").unwrap();
    // (b) Every slot is taken, so the first delegation is queued with no turn yet;
    // a second delegation to the same repo must still isolate.
    st.db.set_setting("concurrency.botsAtOnce", &json!(1)).unwrap();
    assert!(st.db.create_reserved_turn("p10-holder-turn", "p10-boss", 1).unwrap(), "the only slot is taken");
    let first = crate::team::delegate(&st, "p10-boss", &json!({
        "blob": worker, "message": "Add the login form", "topic": "Add login", "projectPath": repo.to_string_lossy()
    })).await.unwrap();
    assert!(!first.started, "the first delegation is queued");
    for _ in 0..300 {
        if st.team.queued_len(&first.side).await > 0 { break; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(st.team.queued_len(&first.side).await > 0, "its delivery is queued");
    let first_path = PathBuf::from(st.db.session_detail(&first.side).unwrap()["projectPath"].as_str().unwrap());
    assert!(!first_path.starts_with(family_of(&root)), "the queued task holds the shared folder");
    let second = crate::team::delegate(&st, "p10-boss", &json!({
        "blob": worker, "message": "Fix the footer", "topic": "Fix footer", "projectPath": repo.to_string_lossy()
    })).await.unwrap();
    let second_path = PathBuf::from(st.db.session_detail(&second.side).unwrap()["projectPath"].as_str().unwrap());
    assert!(second_path.starts_with(family_of(&root)), "the second runs in its own copy: {}", second_path.display());
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&root)).ok();
}

// FIX39 P10 audit F3: merge or discard while the task is still running is refused
// and leaves the card pending, so the copy is never removed mid-edit.
#[tokio::test]
async fn p10_refuses_a_merge_or_discard_while_the_task_is_still_running() {
    let Some(repo) = make_repo() else { return };
    let (st, _, worker) = fixture().await;
    let worktree = side_with_change(&st, &repo, &worker, "p10-side");
    let proposal = offer_merge(&st, "p10-side").await;
    // The task is mid-turn: its side conversation has a live turn.
    st.active_turns.lock().await.insert("p10-side".to_owned(), "running".into());
    let approve = crate::proposals::decide(&st, &json!({"id":proposal["id"],"decision":"approve"})).await.unwrap_err();
    assert_eq!(approve.1.code, "conflict");
    assert!(!repo.join("feature.txt").exists(), "nothing merged while the task runs");
    assert!(worktree.path.exists(), "the copy survives");
    assert_eq!(st.db.proposal_get(proposal["id"].as_str().unwrap()).unwrap()["status"], "pending", "the card stays pending");
    let discard = crate::proposals::decide(&st, &json!({"id":proposal["id"],"decision":"reject","discard":true})).await.unwrap_err();
    assert_eq!(discard.1.code, "conflict");
    assert!(worktree.path.exists(), "the copy survives a refused discard");
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&worktree.repo)).ok();
}

// An open conversation can always get another message, so a turn that changed
// nothing leaves its copy exactly as it was.
#[tokio::test]
async fn p10_a_task_with_no_changes_keeps_its_copy_without_a_card() {
    let Some(repo) = make_repo() else { return };
    let (st, _, worker) = fixture().await;
    let worktree = crate::worktree::create(&repo, "Read only").unwrap();
    st.db.create_session_for_agent("p10-side", "p10-rt", "codex", &worktree.path.to_string_lossy(), "Read only", Some(&worker)).unwrap();
    st.db.set_session_link("p10-side", &json!({"kind":"side","originSessionId":"p10-boss","worktree":worktree.to_json()})).unwrap();
    st.db.update_session_state("p10-side", "idle").unwrap();
    crate::proposals::after_task_turn(&st, "p10-side", "turn.completed").await;
    assert!(st.db.proposals_pending().unwrap().iter().all(|proposal| proposal["kind"] != "merge"), "no card for nothing");
    assert!(worktree.path.join("readme.txt").is_file(), "the copy is still there for the next message");
    let side = st.db.session_detail("p10-side").unwrap();
    assert_eq!(side["link"]["worktree"]["branch"], "bitbots/read-only", "the record stays");
    assert!(side["messages"].as_array().unwrap().iter().all(|message| !message["content"].as_str().unwrap_or("").contains("separate copy")), "nothing to tell the owner: {side}");
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&worktree.repo)).ok();
}

/// A process with `folder` as its working folder, as a coding agent has, which
/// stops Windows deleting the folder itself. One process, so killing it frees it.
#[cfg(windows)]
fn hold_as_working_folder(folder: &Path) -> std::process::Child {
    std::process::Command::new("ping").args(["-n", "60", "127.0.0.1"]).stdout(std::process::Stdio::null()).current_dir(folder).spawn().unwrap()
}

/// What the discard used to leave behind: git has deleted the files and its
/// record of the copy, and the held folder itself is still there, empty.
#[cfg(windows)]
fn empty_the_copy(worktree: &crate::worktree::Worktree) {
    let _ = std::process::Command::new("git").current_dir(&worktree.repo).args(["worktree", "remove", "--force", worktree.path.to_str().unwrap()]).output();
    assert!(git(&worktree.repo, &["worktree", "prune"]));
    assert!(worktree.path.is_dir(), "the held folder cannot be deleted");
    assert_eq!(std::fs::read_dir(&worktree.path).unwrap().count(), 0, "everything in it was");
}

#[cfg(windows)]
fn is_registered(repo: &Path, worktree: &Path) -> bool {
    let listed = std::process::Command::new("git").current_dir(repo).args(["worktree", "list", "--porcelain"]).output().unwrap();
    String::from_utf8_lossy(&listed.stdout).lines().filter_map(|line| line.strip_prefix("worktree ")).any(|path| crate::worktree::normalize(Path::new(path)) == crate::worktree::normalize(worktree))
}

/// A main conversation in its own copy, with its coding agent running.
#[cfg(windows)]
async fn live_conversation_in_a_copy(st: &AppState, repo: &Path, worker: &str, session: &str) -> crate::worktree::Worktree {
    let worktree = crate::worktree::create(repo, "Say hello").unwrap();
    st.db.create_session_for_agent(session, "p10-rt", "codex", &worktree.path.to_string_lossy(), "Say hello", Some(worker)).unwrap();
    st.db.set_session_link(session, &json!({"kind":"main","worktree":worktree.to_json()})).unwrap();
    st.db.update_session_state(session, "idle").unwrap();
    dispatch(st, "session.resume", json!({"sessionId":session})).await.unwrap();
    assert!(st.sessions.lock().await.contains_key(session), "the agent is running");
    worktree
}

/// The next message, all the way through the prompt path to a finished turn.
#[cfg(windows)]
async fn send_and_finish(st: &AppState, session: &str) {
    let turn = dispatch(st, "session.prompt", json!({"sessionId":session,"text":"Now do something"})).await.unwrap()["turnId"].as_str().unwrap().to_owned();
    for _ in 0..500 {
        if st.active_turns.lock().await.get(session).is_none_or(|active| *active != turn) { return; }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("the turn did not finish");
}

// The live smoke's failure: a fan-out bot says hello, and its coding agent's
// working folder stops Windows removing the copy. Git deleted the files anyway,
// so the conversation was left working in an empty folder that is not a repository.
#[cfg(windows)]
#[tokio::test]
async fn p10_a_turn_that_changed_nothing_leaves_a_held_copy_intact() {
    let Some(repo) = make_repo() else { return };
    let (st, _, worker) = fixture().await;
    let worktree = live_conversation_in_a_copy(&st, &repo, &worker, "p10-held").await;
    let mut holder = hold_as_working_folder(&worktree.path);
    crate::proposals::after_task_turn(&st, "p10-held", "turn.completed").await;
    let intact = worktree.path.join("readme.txt").is_file();
    let registered = is_registered(&worktree.repo, &worktree.path);
    let detail = st.db.session_detail("p10-held").unwrap();
    let _ = holder.kill();
    let _ = holder.wait();
    assert!(intact, "the files are still there");
    assert!(registered, "git still knows the copy");
    assert_eq!(detail["projectPath"].as_str().unwrap(), worktree.path.to_string_lossy());
    assert!(st.sessions.lock().await.contains_key("p10-held"), "the agent keeps running there");
    assert!(detail["messages"].as_array().unwrap().iter().all(|message| !message["content"].as_str().unwrap_or("").contains("could not be removed")), "{detail}");
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&worktree.repo)).ok();
}

// The same folder, held the same way, when the owner approves a merge: the work
// is merged and the copy is gone, whatever the empty folder is still doing, so
// nothing says otherwise and the conversation does not stay behind in it.
#[cfg(windows)]
#[tokio::test]
async fn p10_a_merge_finishes_while_the_folder_is_held() {
    let Some(repo) = make_repo() else { return };
    let (st, _, worker) = fixture().await;
    let worktree = side_with_change(&st, &repo, &worker, "p10-side");
    dispatch(&st, "session.resume", json!({"sessionId":"p10-side"})).await.unwrap();
    let proposal = offer_merge(&st, "p10-side").await;
    let mut holder = hold_as_working_folder(&worktree.path);
    let decided = crate::proposals::decide(&st, &json!({"id":proposal["id"],"decision":"approve"})).await;
    let branch_left = git(&worktree.repo, &["rev-parse", "--verify", "--quiet", "refs/heads/bitbots/add-login"]);
    let _ = holder.kill();
    let _ = holder.wait();
    let result = decided.unwrap();
    assert_eq!(result["result"]["copyRemoved"], true, "{result}");
    assert_eq!(std::fs::read_to_string(repo.join("feature.txt")).unwrap(), "one\ntwo\n");
    assert!(!branch_left, "a merged branch goes with its copy");
    let side = st.db.session_detail("p10-side").unwrap();
    assert!(side["link"].get("worktree").is_none(), "the record is cleared: {side}");
    assert_eq!(crate::worktree::normalize(Path::new(side["projectPath"].as_str().unwrap())), crate::worktree::normalize(&worktree.repo), "the next message runs in the project");
    assert!(!st.sessions.lock().await.contains_key("p10-side"), "the old agent stays in the old folder, so it is closed");
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&worktree.repo)).ok();
}

#[cfg(windows)]
#[tokio::test]
async fn p10_a_discard_finishes_while_the_folder_is_held() {
    let Some(repo) = make_repo() else { return };
    let (st, _, worker) = fixture().await;
    let worktree = side_with_change(&st, &repo, &worker, "p10-side");
    dispatch(&st, "session.resume", json!({"sessionId":"p10-side"})).await.unwrap();
    let proposal = offer_merge(&st, "p10-side").await;
    let mut holder = hold_as_working_folder(&worktree.path);
    let decided = crate::proposals::decide(&st, &json!({"id":proposal["id"],"decision":"reject","discard":true})).await;
    let _ = holder.kill();
    let _ = holder.wait();
    decided.unwrap();
    assert!(!git(&worktree.repo, &["rev-parse", "--verify", "--quiet", "refs/heads/bitbots/add-login"]), "a discarded branch goes with its copy");
    let side = st.db.session_detail("p10-side").unwrap();
    assert!(side["link"].get("worktree").is_none(), "the record is cleared: {side}");
    let boss = st.db.session_detail("p10-boss").unwrap();
    assert!(boss["messages"].as_array().unwrap().iter().all(|message| !message["content"].as_str().unwrap_or("").contains("could not be removed")), "{boss}");
    assert!(!st.sessions.lock().await.contains_key("p10-side"));
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&worktree.repo)).ok();
}

// A file really stuck in the copy is different: the copy survives, and the record
// and the branch stay with it, and the owner hears about it.
#[cfg(windows)]
#[tokio::test]
async fn p10_a_merge_with_a_file_stuck_in_the_copy_still_says_so() {
    use std::os::windows::fs::OpenOptionsExt as _;
    let Some(repo) = make_repo() else { return };
    let (st, _, worker) = fixture().await;
    let worktree = side_with_change(&st, &repo, &worker, "p10-side");
    let proposal = offer_merge(&st, "p10-side").await;
    // An ignored file: the merge's `git add` never reads it, so only the removal trips on it.
    std::fs::write(repo.join(".git").join("info").join("exclude"), "stuck.log\n").unwrap();
    std::fs::write(worktree.path.join("stuck.log"), "x\n").unwrap();
    // No sharing at all, so nothing can delete this file while it's open.
    let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(worktree.path.join("stuck.log")).unwrap();
    let result =crate::proposals::decide(&st, &json!({"id":proposal["id"],"decision":"approve"})).await.unwrap();
    drop(held);
    assert_eq!(result["result"]["copyRemoved"], false, "{result}");
    assert!(st.db.session_detail("p10-side").unwrap()["link"]["worktree"].is_object(), "the leftover stays tracked");
    assert!(git(&worktree.repo, &["rev-parse", "--verify", "--quiet", "refs/heads/bitbots/add-login"]), "the branch stays");
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&worktree.repo)).ok();
}

// Conversations the old discard already emptied are still out there. The next
// message gets its copy back, from the branch that survived, before the bot runs.
#[cfg(windows)]
#[tokio::test]
async fn p10_the_next_message_restores_an_emptied_copy() {
    let Some(repo) = make_repo() else { return };
    let (st, _, worker) = fixture().await;
    let worktree = live_conversation_in_a_copy(&st, &repo, &worker, "p10-emptied").await;
    let mut holder = hold_as_working_folder(&worktree.path);
    empty_the_copy(&worktree);
    send_and_finish(&st, "p10-emptied").await;
    let restored = worktree.path.join("readme.txt").is_file();
    let registered = is_registered(&worktree.repo, &worktree.path);
    let _ = holder.kill();
    let _ = holder.wait();
    assert!(restored, "the files are back");
    assert!(registered, "git knows the copy again");
    assert_eq!(crate::worktree::repo_root(&worktree.path).map(|root| crate::worktree::normalize(&root)), Some(crate::worktree::normalize(&worktree.path)));
    let detail = st.db.session_detail("p10-emptied").unwrap();
    assert!(detail["messages"].as_array().unwrap().iter().any(|message| message["content"].as_str().unwrap_or("").contains("was restored")), "{detail}");
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&worktree.repo)).ok();
}

// Files a bot wrote into an emptied folder are the only copy of that work, and git
// will not check out over them, so they are left alone and the owner is told.
#[cfg(windows)]
#[tokio::test]
async fn p10_an_emptied_copy_with_files_in_it_is_left_alone_and_reported() {
    let Some(repo) = make_repo() else { return };
    let (st, _, worker) = fixture().await;
    let worktree = live_conversation_in_a_copy(&st, &repo, &worker, "p10-orphan").await;
    let mut holder = hold_as_working_folder(&worktree.path);
    empty_the_copy(&worktree);
    std::fs::write(worktree.path.join("orphan.txt"), "work\n").unwrap();
    send_and_finish(&st, "p10-orphan").await;
    let _ = holder.kill();
    let _ = holder.wait();
    assert_eq!(std::fs::read_to_string(worktree.path.join("orphan.txt")).unwrap(), "work\n");
    let detail = st.db.session_detail("p10-orphan").unwrap();
    assert!(detail["messages"].as_array().unwrap().iter().any(|message| message["content"].as_str().unwrap_or("").contains("could not be restored")), "{detail}");
    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(family_of(&worktree.repo)).ok();
}
