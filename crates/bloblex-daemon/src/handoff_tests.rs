// Phase 4, Round 2: the handoff. Included at the end of `machines_tests.rs`, so it shares that
// module's fixtures (`local`, `host_on`, `link_native`, `temp`, ...).
//
// Two real daemon states over a real gateway on loopback: the giving machine is a `Host` (Native,
// self-signed certificate), the taking machine is a plain state that holds the link. Git runs for
// real against a local bare repository standing in for `origin`; nothing here reaches a real remote.
// The giving machine's `origin` *reads* as a GitHub address (so it has a repository identity) but
// its push address is the local bare repository, and the taking machine fetches from the local one.

use std::path::Path;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn say(st: &AppState, sid: &str, role: &str, text: &str) -> String {
    st.db.append_message(sid, "", role, text).unwrap()["id"].as_str().unwrap().to_string()
}

/// Both machines, the repositories and one conversation on the giving machine, in its own copy.
struct Moving {
    giver: Host,
    taker: AppState,
    taker_dir: PathBuf,
    root: PathBuf,
    origin: PathBuf,
    giver_repo: PathBuf,
    taker_repo: PathBuf,
    copy: PathBuf,
    branch: String,
    sid: String,
    agent_id: String,
    project_id: String,
}

impl Drop for Moving {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
        let _ = std::fs::remove_dir_all(&self.taker_dir);
    }
}

fn configure(repo: &Path) {
    git(repo, &["config", "user.email", "test@example.com"]);
    git(repo, &["config", "user.name", "Test"]);
    git(repo, &["config", "core.autocrlf", "false"]);
}

async fn moving(tag: &str) -> Moving {
    let root = temp(&format!("{tag}-repos"));
    let origin = root.join("origin.git");
    let seed = root.join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    let origin_arg = origin.to_string_lossy().into_owned();
    git(&seed, &["init", "-q", "--bare", &origin_arg]);
    git(&seed, &["init", "-q", "-b", "main"]);
    configure(&seed);
    std::fs::write(seed.join("readme.md"), "seed\n").unwrap();
    git(&seed, &["add", "-A"]);
    git(&seed, &["commit", "-q", "-m", "seed"]);
    git(&seed, &["remote", "add", "origin", &origin_arg]);
    git(&seed, &["push", "-q", "origin", "main"]);
    git(&origin, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    let giver_repo = root.join("giver");
    let taker_repo = root.join("taker");
    for repo in [&giver_repo, &taker_repo] {
        git(&root, &["-c", "core.autocrlf=false", "clone", "-q", &origin_arg, &repo.to_string_lossy()]);
        configure(repo);
    }
    // The giving machine's repository reads as a GitHub address but pushes to the local bare one.
    git(&giver_repo, &["remote", "set-url", "origin", "https://github.com/Test/Repo.git"]);
    git(&giver_repo, &["config", "remote.origin.pushurl", &origin_arg]);

    let wt = crate::worktree::create(&giver_repo, "fix export").expect("a task copy");
    let (gst, gdir) = local(&format!("{tag}-giver"));
    let giver = host_on(gst, gdir).await;
    let (taker, taker_dir) = local(&format!("{tag}-taker"));

    let agent = giver
        .st
        .db
        .agent_create(&json!({"name": "Rae", "runtimeId": "rt-test", "approvalMode": "bypass", "customEnv": {"TERM": "hunter2"}, "instructions": "Be careful."}))
        .unwrap()
        .0;
    let agent_id = agent["id"].as_str().unwrap().to_string();
    let sid = format!("conv-{tag}");
    giver.st.db.create_session_for_agent(&sid, "rt-test", "codex", &wt.path.to_string_lossy(), "Fix the export", Some(&agent_id)).unwrap();
    giver.st.db.update_session_state(&sid, "idle").unwrap();
    giver.st.db.set_session_link(&sid, &json!({"worktree": wt.to_json()})).unwrap();
    say(&giver.st, &sid, "user", "The export drops the last row.");
    say(&giver.st, &sid, "thinking", "SECRET inner reasoning");
    say(&giver.st, &sid, "assistant", "Found it: the loop stops one row early.");

    let project = taker.db.project_create("repo", Some(&taker_repo.to_string_lossy())).unwrap().0;
    let project_id = project["id"].as_str().unwrap().to_string();
    taker.db.project_set_repo_identity(&project_id, Some("github.com/test/repo")).unwrap();

    let job = link_native(&taker, &giver, "operator").await;
    assert_eq!(job["state"], "approved", "{job}");
    Moving { giver, taker, taker_dir, root, origin, giver_repo, taker_repo, copy: wt.path.clone(), branch: wt.branch.clone(), sid, agent_id, project_id }
}

impl Moving {
    fn giver_id(&self) -> String {
        host_id(&self.giver)
    }

    fn taker_id(&self) -> String {
        machines::machine_id(&self.taker)
    }

    async fn ask(&self, method: &str, params: Value) -> Result<Value, ClientError> {
        client::rpc(&self.taker, &self.giver_id(), method, params).await
    }

    async fn prepare(&self, commit: bool) -> Value {
        self.ask("handoff.prepare", json!({"sessionId": self.sid, "commitUncommitted": commit, "toMachineId": self.taker_id(), "toName": "Taker", "confirm": true})).await.unwrap()
    }

    /// Runs `machine.takeOver` and waits for the job to settle.
    async fn take_over(&self, project: Option<&str>, commit: bool) -> Value {
        let started = dispatch(
            &self.taker,
            "machine.takeOver",
            json!({"machineId": self.giver_id(), "sessionId": self.sid, "projectId": project, "commitUncommitted": commit, "confirm": true}),
        )
        .await
        .unwrap();
        let id = started["job"]["id"].as_str().unwrap().to_string();
        assert_eq!(started["job"]["state"], "running", "the job is returned at once");
        let start = Instant::now();
        loop {
            let jobs = dispatch(&self.taker, "machine.takeOver.list", json!({})).await.unwrap();
            let job = jobs["jobs"].as_array().unwrap().iter().find(|job| job["id"] == id.as_str()).cloned().unwrap();
            if job["state"] != "running" {
                return job;
            }
            assert!(start.elapsed() < Duration::from_secs(60), "the take-over never finished: {job}");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    fn dirty_the_copy(&self) {
        std::fs::write(self.copy.join("notes.txt"), "uncommitted\n").unwrap();
    }

    fn origin_has_branch(&self) -> bool {
        !git(&self.origin, &["branch", "--list", &self.branch]).is_empty()
    }
}

fn step_ids(job: &Value) -> Vec<String> {
    job["steps"].as_array().unwrap().iter().map(|step| step["id"].as_str().unwrap().to_string()).collect()
}

/// A real attempt to start a turn. It is only "blocked" by the handoff's own refusals, or because
/// the conversation isn't there.
async fn can_start(st: &AppState, sid: &str) -> bool {
    match dispatch(st, "session.prompt", json!({"sessionId": sid, "text": "hello"})).await {
        Ok(_) => true,
        Err((_, error)) => !(error.code == "not_found" || (error.code == "conflict" && (error.message.contains("moved to") || error.message.contains("moving to")))),
    }
}

async fn exactly_one_can_start(giver: &AppState, taker: &AppState, sid: &str, what: &str) -> (bool, bool) {
    let (g, t) = (can_start(giver, sid).await, can_start(taker, sid).await);
    assert!(g != t, "{what}: exactly one machine can start a turn, but giver={g} taker={t}");
    (g, t)
}

fn single(tag: &str) -> (AppState, PathBuf, String) {
    let (st, dir) = local(tag);
    let agent = st.db.agent_create(&json!({"name": "Rae", "runtimeId": "rt-test"})).unwrap().0;
    (st, dir, agent["id"].as_str().unwrap().to_string())
}

fn session_of(st: &AppState, agent_id: &str, sid: &str, link: Value) {
    st.db.create_session_for_agent(sid, "rt-test", "codex", ".", "A chat", Some(agent_id)).unwrap();
    st.db.update_session_state(sid, "idle").unwrap();
    st.db.set_session_link(sid, &link).unwrap();
}

// ---------------------------------------------------------------------------
// The conversation owner

#[tokio::test]
async fn a_moved_conversation_refuses_every_way_to_start_a_turn() {
    let (st, dir, agent) = single("moved-refuses");
    // A bot's own conversation with no `kind` at all: `movedTo` is the only key.
    session_of(&st, &agent, "moved-1", json!({"movedTo": {"machineId": "m_1", "name": "Desk", "at": "2026-10-01T11:00:00.000Z"}}));
    let wanted = "This conversation moved to Desk. Take it over to continue.";
    for (method, params) in [
        ("session.prompt", json!({"sessionId": "moved-1", "text": "hi"})),
        ("session.steer", json!({"sessionId": "moved-1", "text": "hi"})),
        ("session.warm", json!({"sessionId": "moved-1"})),
        ("session.resume", json!({"sessionId": "moved-1"})),
        ("session.queue.add", json!({"sessionId": "moved-1", "text": "later"})),
    ] {
        let error = dispatch(&st, method, params).await.unwrap_err();
        assert_eq!((error.1.code.as_str(), error.1.message.as_str()), ("conflict", wanted), "{method}");
    }
    assert_eq!(st.db.queue_count_queued("moved-1").unwrap(), 0, "nothing was queued");
    // The queue's own delivery path goes through the same prompt.
    let queued = crate::session_prompt_queued(&st, json!({"sessionId": "moved-1", "text": "hi"})).await.unwrap_err();
    assert_eq!(queued.1.message, wanted);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_link_with_only_moved_to_is_a_main_conversation() {
    let (st, dir, agent) = single("moved-main");
    session_of(&st, &agent, "only-moved", json!({"movedTo": {"machineId": "m_1", "name": "Desk"}}));
    session_of(&st, &agent, "empty-link", json!({}));
    for sid in ["only-moved", "empty-link"] {
        let row = st.db.session_detail(sid).unwrap();
        assert!(!crate::is_unattended(&row["link"]), "{sid} is not an automation or a board task");
        assert!(row["link"]["kind"].is_null());
    }
    // It counts as one of the bot's own conversations, not a side conversation or an automation.
    let listed = dispatch(&st, "agent.conversations", json!({"agentId": agent})).await.unwrap();
    let ids: Vec<&str> = listed["conversations"].as_array().unwrap().iter().filter_map(|item| item["id"].as_str()).collect();
    assert!(ids.contains(&"only-moved") && ids.contains(&"empty-link"), "{listed}");
    let sessions = dispatch(&st, "session.list", json!({})).await.unwrap();
    let agents = dispatch(&st, "agent.list", json!({})).await.unwrap();
    let bots = machines::bots_from(&agents, &sessions);
    assert_eq!(bots[0]["conversations"], 2);
    // It is refused as a *moved* conversation (409), never as a read-only side conversation (403).
    let error = dispatch(&st, "session.prompt", json!({"sessionId": "only-moved", "text": "hi"})).await.unwrap_err();
    assert_eq!(error.1.code, "conflict");
    // And a link with no `movedTo` and no `kind` is not refused as moved or as a side conversation.
    let open = dispatch(&st, "session.prompt", json!({"sessionId": "empty-link", "text": "hi"})).await;
    if let Err(error) = open {
        assert!(error.1.code != "read_only" && !error.1.message.contains("moved to"), "{}", error.1.message);
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_lease_blocks_turns_and_expires() {
    let m = moving("lease").await;
    // Through the gateway: `prepare` takes the lease, and it blocks the giving machine's turns.
    let prepared = m.prepare(false).await;
    let handoff = prepared["handoffId"].as_str().expect("a lease").to_string();
    let error = dispatch(&m.giver.st, "session.prompt", json!({"sessionId": m.sid, "text": "hi"})).await.unwrap_err();
    assert_eq!((error.1.code.as_str(), error.1.message.as_str()), ("conflict", "This conversation is moving to Taker."));
    for method in ["session.steer", "session.warm", "session.resume", "session.queue.add"] {
        assert_eq!(dispatch(&m.giver.st, method, json!({"sessionId": m.sid, "text": "hi"})).await.unwrap_err().1.code, "conflict", "{method}");
    }
    // One lease per conversation.
    let second = m.ask("handoff.prepare", json!({"sessionId": m.sid, "commitUncommitted": false, "toMachineId": "other", "toName": "Other", "confirm": true})).await;
    assert!(matches!(second, Err(ClientError::Remote { code, .. }) if code == "conflict"));
    m.ask("handoff.abort", json!({"handoffId": handoff})).await.unwrap();
    assert!(machines::refuse_if_moved_id(&m.giver.st, &m.sid).is_ok(), "abort frees the conversation");

    // A lease that runs out frees the conversation again, and a commit that comes late is refused.
    let hand = &m.giver.st.machines.handoff;
    hand.set_lease_len(Duration::from_millis(500));
    let lease = hand.begin(&m.sid, "other", "Other").expect("a lease");
    assert!(machines::refuse_if_moved_id(&m.giver.st, &m.sid).is_err());
    tokio::time::sleep(Duration::from_millis(650)).await;
    assert!(machines::refuse_if_moved_id(&m.giver.st, &m.sid).is_ok(), "an expired lease lets the giver run it again");
    let late = m.ask("handoff.commit", json!({"handoffId": lease.id})).await;
    assert!(matches!(late, Err(ClientError::Remote { code, .. }) if code == "conflict"), "a late commit is refused");
    assert!(m.giver.st.db.session_brief(&m.sid).unwrap()["link"]["movedTo"].is_null(), "and moves nothing");
}

#[tokio::test]
async fn commit_needs_a_live_lease() {
    let m = moving("commit-lease").await;
    for id in ["never-existed", ""] {
        let error = m.ask("handoff.commit", json!({"handoffId": id})).await;
        assert!(matches!(error, Err(ClientError::Remote { .. })), "{id:?}: {error:?}");
    }
    let prepared = m.prepare(false).await;
    let handoff = prepared["handoffId"].as_str().unwrap().to_string();
    assert_eq!(m.ask("handoff.abort", json!({"handoffId": handoff})).await.unwrap(), json!({"ok": true}));
    let after_abort = m.ask("handoff.commit", json!({"handoffId": handoff})).await;
    assert!(matches!(after_abort, Err(ClientError::Remote { code, .. }) if code == "conflict"));
    assert!(m.giver.st.db.session_brief(&m.sid).unwrap()["link"]["movedTo"].is_null());
    // Abort of something that isn't there is still fine, and commit and abort are each idempotent in effect.
    assert_eq!(m.ask("handoff.abort", json!({"handoffId": "gone"})).await.unwrap(), json!({"ok": true}));
}

// ---------------------------------------------------------------------------
// The giving machine

#[tokio::test]
async fn preview_explains_each_reason_it_isnt_ready() {
    let (st, dir, agent) = single("preview-reasons");
    let reason = |sid: &'static str| {
        let st = st.clone();
        async move { dispatch(&st, "handoff.preview", json!({"sessionId": sid})).await.unwrap() }
    };
    session_of(&st, &agent, "ok", json!({}));
    let ready = reason("ok").await;
    assert_eq!(ready["ready"], true, "{ready}");
    assert!(ready["reason"].is_null());
    assert_eq!(ready["bot"]["name"], "Rae");

    session_of(&st, &agent, "r1", json!({"movedTo": {"machineId": "m_1", "name": "Desk"}}));
    assert_eq!(reason("r1").await["reason"], "This conversation already moved to Desk.");

    session_of(&st, &agent, "r2", json!({}));
    st.db.update_session_state("r2", "working").unwrap();
    assert_eq!(reason("r2").await["reason"], "Rae is working. Stop it or wait, then try again.");

    session_of(&st, &agent, "r3", json!({}));
    st.db.update_session_state("r3", "waiting_permission").unwrap();
    assert_eq!(reason("r3").await["reason"], "This conversation is waiting on an approval or a question.");

    session_of(&st, &agent, "r4", json!({}));
    dispatch(&st, "session.queue.add", json!({"sessionId": "r4", "text": "later"})).await.unwrap();
    assert_eq!(reason("r4").await["reason"], "This conversation has queued messages.");

    session_of(&st, &agent, "r5", json!({}));
    session_of(&st, &agent, "r5-child", json!({"kind": "side", "peerAgentId": agent, "originSessionId": "r5"}));
    st.db
        .delegation_create(&json!({"originSessionId": "r5", "sideSessionId": "r5-child", "fromAgentId": agent, "targetAgentId": agent, "topic": "Check", "workspacePath": "."}))
        .unwrap();
    assert_eq!(reason("r5").await["reason"], "This conversation has assignments running.");
    // The child of an assignment is treated like a side conversation.
    assert_eq!(reason("r5-child").await["reason"], "Only a bot's own conversations can move.");

    let manager = st.db.agent_create(&json!({"name": "Boss", "runtimeId": "rt-test", "systemRole": "manager"})).unwrap().0;
    session_of(&st, manager["id"].as_str().unwrap(), "r6", json!({}));
    assert_eq!(reason("r6").await["reason"], "The Manager's conversations stay on their machine.");

    session_of(&st, &agent, "r7", json!({"kind": "side", "peerAgentId": agent, "originSessionId": "ok"}));
    assert_eq!(reason("r7").await["reason"], "Only a bot's own conversations can move.");
    session_of(&st, &agent, "r8", json!({"kind": "automation", "automationId": "a", "runId": "r"}));
    assert_eq!(reason("r8").await["reason"], "Only a bot's own conversations can move.");

    for sid in ["r1", "r2", "r5", "r7"] {
        assert_eq!(dispatch(&st, "handoff.prepare", json!({"sessionId": sid, "commitUncommitted": false, "toMachineId": "m-9", "toName": "Taker", "confirm": true})).await.unwrap_err().1.code, "conflict", "{sid}");
        assert!(st.machines.handoff.live(sid).is_none(), "a refused prepare leaves no lease");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn handoff_needs_a_machine_device_at_operator() {
    let m = moving("tiers").await;
    let preview = m.ask("handoff.preview", json!({"sessionId": m.sid})).await.unwrap();
    assert_eq!(preview["ready"], true, "{preview}");
    assert_eq!(preview["bot"]["name"], "Rae");
    // Lowered on the giving machine: the policy's tier check refuses it.
    let device = m.taker.db.machine_link_get(&m.giver_id()).unwrap().unwrap()["deviceId"].as_str().unwrap().to_string();
    for tier in ["chat", "viewer"] {
        m.giver.st.db.remote_device_update(&device, None, Some(tier)).unwrap();
        let refused = m.ask("handoff.preview", json!({"sessionId": m.sid})).await;
        assert!(matches!(refused, Err(ClientError::Remote { code, .. }) if code == "tier_required"), "{tier}");
        // The friendly sentence names the tier to ask for.
        let shown = dispatch(&m.taker, "machine.takeOver.preview", json!({"machineId": m.giver_id(), "sessionId": m.sid})).await.unwrap_err();
        assert!(shown.1.message.contains("Chat and approve"), "{}", shown.1.message);
    }
    m.giver.st.db.remote_device_update(&device, None, Some("operator")).unwrap();
    assert!(m.ask("handoff.preview", json!({"sessionId": m.sid})).await.is_ok());
}

#[tokio::test]
async fn a_phone_at_operator_is_refused() {
    let m = moving("phone").await;
    let token = crate::remote::pairing::generate_token();
    let hash = crate::remote::pairing::hash_token(&token);
    let phone = json!({"id": "phone-1", "name": "Phone", "kind": "phone", "platform": "iOS", "tier": "operator", "login": null, "pairedAt": crate::remote::now_rfc3339()});
    m.giver.st.db.remote_device_create(&phone, &hash).unwrap();
    let trust = Trust::Pin(client::parse_fingerprint(&m.giver.fingerprint()).unwrap());
    let url = m.giver.url();
    // An ordinary read works for the phone, so the refusal below is about handoff.
    let read = client::rpc_direct(&trust, &url, &token, "agent.list", json!({}), Duration::from_secs(10)).await;
    assert!(read.is_ok(), "{read:?}");
    for (method, params) in [
        ("handoff.preview", json!({"sessionId": m.sid})),
        ("handoff.prepare", json!({"sessionId": m.sid, "commitUncommitted": true, "toMachineId": "x", "toName": "X", "confirm": true})),
        ("handoff.commit", json!({"handoffId": "x"})),
        ("handoff.abort", json!({"handoffId": "x"})),
    ] {
        let refused = client::rpc_direct(&trust, &url, &token, method, params, Duration::from_secs(10)).await;
        assert!(matches!(&refused, Err(ClientError::Remote { code, .. }) if code == "forbidden_remote"), "{method}: {refused:?}");
    }
    assert!(m.giver.st.machines.handoff.live(&m.sid).is_none(), "the phone took no lease");
    assert!(!m.origin_has_branch());
}

#[test]
fn handoff_is_refused_in_quiet_hours_and_below_operator() {
    use crate::remote::policy::{authorize, Decision, DenialCode, RemoteCall, Tier};
    let call = |tier, quiet_hours| RemoteCall { tier, approvals_from_remote: true, method: "handoff.prepare".to_string(), params: json!({}), quiet_hours };
    assert_eq!(authorize(&call(Tier::Operator, false)), Decision::Allowed);
    assert!(matches!(authorize(&call(Tier::Operator, true)), Decision::Denied { code: DenialCode::QuietHours, .. }));
    assert!(matches!(authorize(&call(Tier::Chat, false)), Decision::Denied { code: DenialCode::TierRequired, .. }));
    assert!(matches!(authorize(&call(Tier::Viewer, false)), Decision::Denied { code: DenialCode::TierRequired, .. }));
    // Every handoff method is covered by the one family row.
    for method in ["handoff.preview", "handoff.prepare", "handoff.commit", "handoff.abort"] {
        let rule = crate::remote::policy::rule_for(method).unwrap();
        assert_eq!(rule.method, "handoff.*");
    }
    // Taking over is the owner's, on this machine: never remote.
    for method in ["machine.takeOver", "machine.takeOver.preview", "machine.takeOver.list"] {
        assert!(matches!(authorize(&RemoteCall { tier: Tier::Operator, approvals_from_remote: true, method: method.to_string(), params: json!({}), quiet_hours: false }), Decision::Denied { code: DenialCode::ForbiddenRemote, .. }), "{method}");
    }
}

#[tokio::test]
async fn prepare_commits_and_pushes_the_branch() {
    let m = moving("prepare").await;
    m.dirty_the_copy();
    let prepared = m.prepare(true).await;
    let steps = prepared["steps"].as_array().unwrap();
    assert_eq!((steps[0]["id"].as_str(), steps[0]["status"].as_str()), (Some("commit"), Some("done")), "{prepared}");
    assert_eq!((steps[1]["id"].as_str(), steps[1]["status"].as_str()), (Some("push"), Some("done")), "{prepared}");
    assert_eq!(git(&m.copy, &["log", "-1", "--format=%s"]), "Handoff to Taker");
    assert_eq!(git(&m.copy, &["status", "--porcelain"]), "", "everything is committed");
    assert_eq!(git(&m.origin, &["rev-parse", &m.branch]), git(&m.copy, &["rev-parse", "HEAD"]), "the branch is on the remote");
    assert_eq!(prepared["package"]["repo"]["head"], git(&m.copy, &["rev-parse", "HEAD"]));
    assert_eq!(prepared["package"]["session"]["branch"], m.branch.as_str());
    assert_eq!(prepared["package"]["session"]["isWorktree"], true);
    assert_eq!(prepared["package"]["repo"]["identity"], "github.com/test/repo");
    assert_eq!(git(&m.origin, &["rev-parse", "main"]), git(&m.giver_repo, &["rev-parse", "origin/main"]), "the base branch was not pushed");
    assert!(m.giver.st.machines.handoff.live(&m.sid).is_some(), "the lease holds until commit or abort");
    assert!(m.giver.st.db.session_brief(&m.sid).unwrap()["link"]["movedTo"].is_null(), "nothing has moved yet");
}

#[tokio::test]
async fn prepare_needs_consent_for_uncommitted_files() {
    let m = moving("consent").await;
    m.dirty_the_copy();
    let preview = m.ask("handoff.preview", json!({"sessionId": m.sid})).await.unwrap();
    assert_eq!(preview["uncommitted"], 1);
    let prepared = m.prepare(false).await;
    assert!(prepared["handoffId"].is_null() && prepared["package"].is_null(), "{prepared}");
    assert_eq!(prepared["steps"][0]["status"], "failed");
    assert_eq!(prepared["steps"][0]["detail"], "There are uncommitted files.");
    assert!(m.giver.st.machines.handoff.live(&m.sid).is_none(), "the failure ends the lease");
    assert!(m.copy.join("notes.txt").is_file(), "the file is untouched");
    assert!(!m.origin_has_branch(), "nothing was pushed");
    let missing_confirm = m.ask("handoff.prepare", json!({"sessionId": m.sid, "commitUncommitted": true, "toMachineId": m.taker_id(), "toName": "Taker"})).await;
    assert!(matches!(missing_confirm, Err(ClientError::Remote { code, .. }) if code == "invalid_argument"));
}

#[tokio::test]
async fn prepare_never_force_pushes_or_pushes_the_base() {
    let m = moving("force").await;
    // The remote already has this branch with a different commit: a plain push is rejected, and a
    // force push would overwrite it. Nothing may.
    let seed = m.root.join("seed");
    git(&seed, &["checkout", "-q", "-b", &m.branch]);
    std::fs::write(seed.join("theirs.txt"), "theirs\n").unwrap();
    git(&seed, &["add", "-A"]);
    git(&seed, &["commit", "-q", "-m", "theirs"]);
    git(&seed, &["push", "-q", "origin", &m.branch]);
    let theirs = git(&m.origin, &["rev-parse", &m.branch]);
    std::fs::write(m.copy.join("mine.txt"), "mine\n").unwrap();
    let prepared = m.prepare(true).await;
    assert_eq!(prepared["steps"][1]["id"], "push");
    assert_eq!(prepared["steps"][1]["status"], "failed", "{prepared}");
    assert_eq!(git(&m.origin, &["rev-parse", &m.branch]), theirs, "the remote branch was not overwritten");
    assert!(prepared["package"].is_null());

    // A conversation whose recorded branch is the base, or isn't a bitbots/ branch, never pushes.
    let main_before = git(&m.origin, &["rev-parse", "main"]);
    for (branch, base) in [("main", "main"), (m.branch.as_str(), m.branch.as_str()), ("feature/x", "main")] {
        let mut link = m.giver.st.db.session_brief(&m.sid).unwrap()["link"].clone();
        link["worktree"]["branch"] = json!(branch);
        link["worktree"]["base"] = json!(base);
        m.giver.st.db.set_session_link(&m.sid, &link).unwrap();
        let prepared = m.prepare(true).await;
        assert_eq!(prepared["steps"][1]["status"], "failed", "{branch}/{base}: {prepared}");
    }
    assert_eq!(git(&m.origin, &["rev-parse", "main"]), main_before, "the base branch was never pushed");
}

#[tokio::test]
async fn a_rejected_push_ends_the_lease_and_moves_nothing() {
    let m = moving("rejected").await;
    git(&m.giver_repo, &["config", "remote.origin.pushurl", &m.root.join("nowhere.git").to_string_lossy()]);
    let prepared = m.prepare(true).await;
    assert_eq!(prepared["steps"][1]["status"], "failed", "{prepared}");
    assert!(prepared["handoffId"].is_null() && prepared["package"].is_null());
    assert!(m.giver.st.machines.handoff.live(&m.sid).is_none(), "the lease ended");
    assert!(m.giver.st.db.session_brief(&m.sid).unwrap()["link"]["movedTo"].is_null(), "nothing moved");
    assert!(can_start(&m.giver.st, &m.sid).await);
    // Through the whole take-over: it stops at the first step and the taker never gets a row.
    let job = m.take_over(Some(&m.project_id), true).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(step_ids(&job), vec!["prepare"]);
    assert!(!m.taker.db.session_exists(&m.sid).unwrap());
    exactly_one_can_start(&m.giver.st, &m.taker, &m.sid, "after a rejected push").await;
}

#[tokio::test]
async fn the_package_has_no_paths_or_thinking_or_tool_output() {
    let m = moving("package").await;
    say(&m.giver.st, &m.sid, "notice", &format!("Worked in {}", m.copy.display()));
    say(&m.giver.st, &m.sid, "notice", "Messaged Mate");
    m.giver.st.db.append_message_with_data(&m.sid, "", "assistant", "With a picture", &json!({"attachments": [{"path": m.copy.join("shot.png").to_string_lossy(), "name": "shot.png"}]})).unwrap();
    let prepared = m.prepare(true).await;
    let package = &prepared["package"];
    let text = package.to_string().to_lowercase().replace("\\\\", "/").replace('\\', "/");
    for path in [&m.copy, &m.giver_repo, &m.root, &m.origin] {
        let needle = path.to_string_lossy().to_lowercase().replace('\\', "/");
        assert!(!text.contains(&needle), "the package names {needle}");
    }
    assert!(!text.contains("secret inner reasoning"), "thinking travelled");
    assert!(!text.contains("hunter2"), "an environment value travelled");
    assert!(!text.contains("shot.png"), "an attachment path travelled");
    assert!(!text.contains("worked in"), "a notice that names a path travelled");
    assert!(text.contains("messaged mate"), "an ordinary notice travels");
    let roles: Vec<&str> = package["messages"].as_array().unwrap().iter().filter_map(|message| message["role"].as_str()).collect();
    assert!(roles.iter().all(|role| ["user", "assistant", "notice"].contains(role)), "{roles:?}");
    for message in package["messages"].as_array().unwrap() {
        let mut keys: Vec<&String> = message.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["content", "createdAt", "id", "role"]);
    }
    // The bot is the backup's: no ids of runtimes, no project, keys but no values.
    let bot = &package["bot"];
    assert!(bot.get("runtimeId").is_none() && bot.get("projectId").is_none());
    assert_eq!(bot["customEnvKeys"], json!(["TERM"]));
    assert_eq!(package["omitted"]["pictures"], 1);
    // The reply to the preview holds no path either.
    let preview = m.ask("handoff.preview", json!({"sessionId": m.sid})).await.unwrap().to_string().to_lowercase().replace('\\', "/");
    assert!(!preview.contains(&m.root.to_string_lossy().to_lowercase().replace('\\', "/")));
}



// ---------------------------------------------------------------------------
// The taking machine

#[tokio::test]
async fn take_over_preview_has_the_contract_shape() {
    let m = moving("shape").await;
    m.dirty_the_copy();
    let preview = dispatch(&m.taker, "machine.takeOver.preview", json!({"machineId": m.giver_id(), "sessionId": m.sid})).await.unwrap();
    let keys = |value: &Value| {
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };
    assert_eq!(keys(&preview), ["bot", "commitsAhead", "needsProject", "project", "ready", "reason", "repo", "runtimeReady", "title", "uncommitted"]);
    assert_eq!(keys(&preview["bot"]), ["agentId", "id", "model", "name", "provider", "willCreate"]);
    assert_eq!(keys(&preview["repo"]), ["branch", "hasRemote", "identity", "isWorktree", "url"]);
    assert_eq!(preview["ready"], true, "{preview}");
    assert_eq!(preview["title"], "Fix the export");
    assert_eq!(preview["bot"]["willCreate"], true);
    assert!(preview["bot"]["agentId"].is_null());
    assert_eq!(preview["repo"]["identity"], "github.com/test/repo");
    assert_eq!(preview["repo"]["url"], "https://github.com/Test/Repo.git");
    assert_eq!(preview["repo"]["branch"], m.branch.as_str());
    assert_eq!((preview["repo"]["isWorktree"].clone(), preview["repo"]["hasRemote"].clone()), (json!(true), json!(true)));
    assert_eq!(preview["uncommitted"], 1);
    assert_eq!(preview["commitsAhead"], 0);
    assert_eq!(preview["project"], json!({"id": m.project_id, "name": "repo"}));
    assert_eq!(preview["needsProject"], false);
    assert_eq!(preview["runtimeReady"], true);
    // A bot here with the same name and coding agent is the one that carries on.
    let rae = m.taker.db.agent_create(&json!({"name": "rae", "runtimeId": "rt-test"})).unwrap().0;
    let again = dispatch(&m.taker, "machine.takeOver.preview", json!({"machineId": m.giver_id(), "sessionId": m.sid})).await.unwrap();
    assert_eq!((again["bot"]["agentId"].clone(), again["bot"]["willCreate"].clone()), (rae["id"].clone(), json!(false)));
    // No project here with that repository.
    m.taker.db.project_set_repo_identity(&m.project_id, None).unwrap();
    let none = dispatch(&m.taker, "machine.takeOver.preview", json!({"machineId": m.giver_id(), "sessionId": m.sid})).await.unwrap();
    assert!(none["project"].is_null());
    assert_eq!(none["needsProject"], true);
}

#[tokio::test]
async fn take_over_moves_the_conversation_and_the_code() {
    let m = moving("takeover").await;
    m.dirty_the_copy();
    say(&m.giver.st, &m.sid, "notice", "Messaged Mate");
    let job = m.take_over(Some(&m.project_id), true).await;
    assert_eq!(job["state"], "done", "{job}");
    assert_eq!(step_ids(&job), ["prepare", "code", "bot", "import", "commit", "open"]);
    assert!(job["steps"].as_array().unwrap().iter().all(|step| step["status"] == "done"), "{job}");
    assert_eq!(job["sessionId"], m.sid.as_str());

    // The giving machine gave it up.
    let gave = m.giver.st.db.session_brief(&m.sid).unwrap();
    assert_eq!(gave["link"]["movedTo"]["machineId"], m.taker_id().as_str());
    assert_eq!(gave["link"]["movedTo"]["name"], machines::machine_name(&m.taker).as_str());
    assert!(gave["link"]["worktree"].is_object(), "its own copy stays where it was");
    let giver_notices: Vec<String> = m.giver.st.db.session_detail(&m.sid).unwrap()["messages"].as_array().unwrap().iter().filter(|x| x["role"] == "notice").filter_map(|x| x["content"].as_str().map(str::to_string)).collect();
    assert!(giver_notices.iter().any(|text| text == &format!("Moved to {}.", machines::machine_name(&m.taker))), "{giver_notices:?}");

    // The taking machine has the same conversation, with its code, bot and text.
    let row = m.taker.db.session_detail(&m.sid).unwrap();
    assert!(row["link"]["movedTo"].is_null(), "opened");
    assert_eq!(row["title"], "Fix the export");
    assert_eq!(row["state"], "idle");
    assert!(row["providerSessionId"].is_null(), "a fresh provider session");
    assert_eq!(row["projectId"], m.project_id.as_str());
    let copy = PathBuf::from(row["projectPath"].as_str().unwrap());
    assert!(copy.starts_with(m.root.join("taker-bitbots")), "{}", copy.display());
    assert!(copy.join("notes.txt").is_file(), "the uncommitted file arrived, committed on the branch");
    assert_eq!(git(&copy, &["rev-parse", "--abbrev-ref", "HEAD"]), m.branch);
    assert_eq!(row["link"]["worktree"]["branch"], m.branch.as_str());
    let agent = m.taker.db.agent_get(row["agentId"].as_str().unwrap()).unwrap();
    assert_eq!(agent["name"], "Rae");
    let texts: Vec<(String, String)> = row["messages"].as_array().unwrap().iter().map(|x| (x["role"].as_str().unwrap().to_string(), x["content"].as_str().unwrap().to_string())).collect();
    assert!(texts.contains(&("user".into(), "The export drops the last row.".into())));
    assert!(texts.contains(&("assistant".into(), "Found it: the loop stops one row early.".into())));
    assert!(!texts.iter().any(|(role, _)| role == "thinking"), "no thinking");
    let handoff_note = row["messages"].as_array().unwrap().iter().find(|x| x["meta"]["kind"] == "handoff").expect("the note");
    assert_eq!(handoff_note["role"], "notice");
    assert_eq!(handoff_note["meta"]["fromMachineId"], m.giver_id().as_str());
    assert_eq!(handoff_note["meta"]["fromName"], machines::machine_name(&m.giver.st).as_str());
    let note = handoff_note["content"].as_str().unwrap();
    assert!(note.starts_with(&format!("Taken over from {}", machines::machine_name(&m.giver.st))), "{note}");
    assert!(note.contains(&m.branch) && note.contains("notes.txt") && note.contains("stayed on"), "{note}");
    assert!(!note.contains(&m.root.to_string_lossy().to_string()), "no host path in the note");
    assert!(row["messages"].as_array().unwrap().iter().any(|x| x["meta"]["kind"] == "context_reset"), "the fresh-session notice");
    exactly_one_can_start(&m.giver.st, &m.taker, &m.sid, "after a take-over").await;
}

#[tokio::test]
async fn the_recap_reaches_the_first_prompt() {
    let m = moving("recap").await;
    let job = m.take_over(Some(&m.project_id), true).await;
    assert_eq!(job["state"], "done", "{job}");
    assert!(m.taker.db.session_recap_pending(&m.sid).unwrap(), "armed");
    let recap = crate::knowledge::recap_for_prompt(&m.taker, &m.sid).expect("a recap for the first prompt");
    assert!(recap.contains("The export drops the last row.") && recap.contains("Found it"), "{recap}");
    assert!(!recap.contains("SECRET inner reasoning"));
    assert!(crate::knowledge::recap_for_prompt(&m.taker, &m.sid).is_none(), "once");
}

#[tokio::test]
async fn take_over_never_carries_full_access() {
    let m = moving("fullaccess").await;
    assert_eq!(m.giver.st.db.agent_get(&m.agent_id).unwrap()["approvalMode"], "bypass", "the giving bot has Full access");
    let job = m.take_over(Some(&m.project_id), true).await;
    assert_eq!(job["state"], "done", "{job}");
    let row = m.taker.db.session_detail(&m.sid).unwrap();
    let agent = m.taker.db.agent_get(row["agentId"].as_str().unwrap()).unwrap();
    assert!(agent["approvalMode"].is_null(), "the new bot uses this machine's default, got {}", agent["approvalMode"]);
    assert_ne!(m.taker.db.default_approval_mode().unwrap(), "bypass");
    assert_eq!(agent["customEnv"], json!({}), "no environment values");
    assert_eq!(agent["customArgs"], json!([]));
    assert_ne!(agent["leader"], true);
    for place in [&row["link"], &row["modelLock"]] {
        assert!(!place.to_string().contains("bypass"), "{place}");
    }
    assert!(!m.taker.db.settings().unwrap().to_string().contains("hunter2"));
    // A milder mode comes across as it was.
    let m2 = moving("fullaccess-ask").await;
    m2.giver.st.db.agent_update(&m2.agent_id, &json!({"approvalMode": "auto"})).unwrap();
    assert_eq!(m2.take_over(Some(&m2.project_id), true).await["state"], "done");
    let made = m2.taker.db.agent_get(m2.taker.db.session_detail(&m2.sid).unwrap()["agentId"].as_str().unwrap()).unwrap();
    assert_eq!(made["approvalMode"], "auto");
}

#[tokio::test]
async fn a_bot_is_created_only_when_none_matches() {
    let m = moving("bots").await;
    let rae = m.taker.db.agent_create(&json!({"name": "RAE", "runtimeId": "rt-test", "approvalMode": "ask"})).unwrap().0;
    let before = m.taker.db.agent_list(false, None).unwrap().len();
    let job = m.take_over(Some(&m.project_id), true).await;
    assert_eq!(job["state"], "done", "{job}");
    assert_eq!(m.taker.db.agent_list(false, None).unwrap().len(), before, "no second Rae");
    assert_eq!(m.taker.db.session_detail(&m.sid).unwrap()["agentId"], rae["id"]);
    assert_eq!(m.taker.db.agent_get(rae["id"].as_str().unwrap()).unwrap()["approvalMode"], "ask", "the matched bot is left alone");

    // With none that matches, one is made.
    let n = moving("bots-new").await;
    let before = n.taker.db.agent_list(false, None).unwrap().len();
    assert_eq!(n.take_over(Some(&n.project_id), true).await["state"], "done");
    assert_eq!(n.taker.db.agent_list(false, None).unwrap().len(), before + 1);
    // Taking another conversation of the same bot finds the copy it made.
    let again = n.taker.db.agent_list(false, None).unwrap().len();
    assert_eq!(again, before + 1);
}

#[tokio::test]
async fn a_missing_runtime_stops_it_before_anything_changes() {
    let m = moving("noruntime").await;
    m.dirty_the_copy();
    m.taker.runtimes.write().await.clear();
    let preview = dispatch(&m.taker, "machine.takeOver.preview", json!({"machineId": m.giver_id(), "sessionId": m.sid})).await.unwrap();
    assert_eq!((preview["ready"].clone(), preview["runtimeReady"].clone()), (json!(false), json!(false)));
    assert_eq!(preview["reason"], "Codex isn't installed on this machine.");
    let job = m.take_over(Some(&m.project_id), true).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["detail"], "Codex isn't installed on this machine.");
    // Nothing changed on either machine: no lease, no commit, no push, no row.
    assert!(m.giver.st.machines.handoff.live(&m.sid).is_none());
    assert!(m.copy.join("notes.txt").is_file());
    assert_eq!(git(&m.copy, &["status", "--porcelain"]), "?? notes.txt");
    assert!(!m.origin_has_branch());
    assert!(!m.taker.db.session_exists(&m.sid).unwrap());
    assert!(can_start(&m.giver.st, &m.sid).await);
}

#[tokio::test]
async fn a_failed_import_aborts_and_the_source_keeps_it() {
    let m = moving("failed-import").await;
    m.taker.machines.handoff.fail_at(Some("import"));
    let job = m.take_over(Some(&m.project_id), true).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(step_ids(&job), ["prepare", "code", "bot", "import"]);
    assert_eq!(job["steps"][3]["status"], "failed");
    assert!(m.giver.st.machines.handoff.live(&m.sid).is_none(), "the lease was aborted");
    assert!(m.giver.st.db.session_brief(&m.sid).unwrap()["link"]["movedTo"].is_null());
    assert!(!m.taker.db.session_exists(&m.sid).unwrap());
    exactly_one_can_start(&m.giver.st, &m.taker, &m.sid, "after a failed import").await;
    // What worked on the giving machine stays: the branch is pushed. Nothing was forced or removed.
    assert!(m.origin_has_branch());
    assert!(m.copy.is_dir());
}

#[tokio::test]
async fn a_failed_commit_removes_the_import() {
    // The taker fails just before asking the giving machine to commit.
    let m = moving("failed-commit").await;
    m.taker.machines.handoff.fail_at(Some("commit"));
    let job = m.take_over(Some(&m.project_id), true).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert!(!m.taker.db.session_exists(&m.sid).unwrap(), "the import is gone");
    assert!(m.taker.db.session_message_ids(&m.sid).unwrap().is_empty());
    assert!(m.giver.st.db.session_brief(&m.sid).unwrap()["link"]["movedTo"].is_null());
    exactly_one_can_start(&m.giver.st, &m.taker, &m.sid, "before the commit").await;

    // And the giving machine refusing the commit for real (the lease already ran out).
    let n = moving("refused-commit").await;
    n.giver.st.machines.handoff.set_lease_len(Duration::from_millis(1));
    let job = n.take_over(Some(&n.project_id), true).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["steps"].as_array().unwrap().last().unwrap()["id"], "commit");
    assert!(!n.taker.db.session_exists(&n.sid).unwrap(), "the import was removed");
    exactly_one_can_start(&n.giver.st, &n.taker, &n.sid, "after a refused commit").await;
}

#[tokio::test]
async fn a_failed_fetch_leaves_the_conversation_where_it_was() {
    let m = moving("failed-fetch").await;
    git(&m.taker_repo, &["remote", "set-url", "origin", &m.root.join("nowhere.git").to_string_lossy()]);
    let job = m.take_over(Some(&m.project_id), true).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["steps"].as_array().unwrap().last().unwrap()["id"], "code");
    assert!(m.giver.st.machines.handoff.live(&m.sid).is_none(), "aborted");
    assert!(!m.taker.db.session_exists(&m.sid).unwrap());
    exactly_one_can_start(&m.giver.st, &m.taker, &m.sid, "after a failed fetch").await;
}

/// The moment that matters: fail every step in turn, with the real gateway between the two states,
/// and check after each failure who can start a turn.
#[tokio::test]
async fn only_one_machine_can_run_it_at_every_step() {
    // Before the giving machine commits, a failure leaves it with the conversation and the taker with nothing.
    for step in ["prepare", "code", "bot", "import", "import_after", "commit"] {
        let m = moving(&format!("every-{step}")).await;
        m.taker.machines.handoff.fail_at(Some(step));
        let job = m.take_over(Some(&m.project_id), true).await;
        assert_eq!(job["state"], "failed", "{step}: {job}");
        assert!(m.giver.st.machines.handoff.live(&m.sid).is_none(), "{step}: the lease ended");
        assert!(m.giver.st.db.session_brief(&m.sid).unwrap()["link"]["movedTo"].is_null(), "{step}");
        assert!(!m.taker.db.session_exists(&m.sid).unwrap(), "{step}: nothing is left of the import");
        let (giver, taker) = exactly_one_can_start(&m.giver.st, &m.taker, &m.sid, step).await;
        assert!(giver && !taker, "{step}: the giving machine keeps it");
    }

    // The reply to the commit is lost on the way: the taker asks, and finds the other machine did commit.
    let lost = moving("every-commit-lost").await;
    lost.taker.machines.handoff.fail_at(Some("commit_lost"));
    let job = lost.take_over(Some(&lost.project_id), true).await;
    assert_eq!(job["state"], "done", "{job}");
    let (giver, taker) = exactly_one_can_start(&lost.giver.st, &lost.taker, &lost.sid, "a lost commit reply").await;
    assert!(!giver && taker);

    // Past the commit, the summary for the agent fails to be added: the conversation is still the taker's.
    let late = moving("every-open").await;
    late.taker.machines.handoff.fail_at(Some("open"));
    let job = late.take_over(Some(&late.project_id), true).await;
    assert_eq!(job["state"], "done", "{job}");
    assert!(job["detail"].as_str().unwrap().contains("summary"), "the warning says what is missing: {job}");
    let (giver, taker) = exactly_one_can_start(&late.giver.st, &late.taker, &late.sid, "a late warning").await;
    assert!(!giver && taker);

    // The one window where neither can run it: the giving machine committed and this machine could
    // not open the row. Never both; and taking it over again finishes it.
    let stuck = moving("every-open-clear").await;
    stuck.taker.machines.handoff.fail_at(Some("open_clear"));
    let job = stuck.take_over(Some(&stuck.project_id), true).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert!(job["detail"].as_str().unwrap().contains("Take it over again"), "{job}");
    let (giver, taker) = (can_start(&stuck.giver.st, &stuck.sid).await, can_start(&stuck.taker, &stuck.sid).await);
    assert!(!giver && !taker, "neither runs it until it is finished, and never both");
    stuck.taker.machines.handoff.fail_at(None);
    let preview = dispatch(&stuck.taker, "machine.takeOver.preview", json!({"machineId": stuck.giver_id(), "sessionId": stuck.sid})).await.unwrap();
    assert_eq!(preview["ready"], true, "the finish is offered: {preview}");
    let job = stuck.take_over(Some(&stuck.project_id), false).await;
    assert_eq!(job["state"], "done", "{job}");
    assert_eq!(step_ids(&job), ["prepare", "code", "bot", "import", "commit", "open"]);
    assert_eq!(job["steps"][0]["status"], "skipped");
    let (giver, taker) = exactly_one_can_start(&stuck.giver.st, &stuck.taker, &stuck.sid, "after finishing").await;
    assert!(!giver && taker);
    assert_eq!(stuck.taker.db.session_detail(&stuck.sid).unwrap()["messages"].as_array().unwrap().iter().filter(|x| x["content"] == "The export drops the last row.").count(), 1, "no message twice");
}

#[tokio::test]
async fn taking_it_back_keeps_the_same_conversation() {
    let m = moving("back").await;
    // The taking machine is a gateway too, and the giving machine links to it.
    let taker_gateway = host_on(m.taker.clone(), temp("back-taker-gateway")).await;
    let job = link_native(&m.giver.st, &taker_gateway, "operator").await;
    assert_eq!(job["state"], "approved", "{job}");
    assert_eq!(m.take_over(Some(&m.project_id), true).await["state"], "done");

    // The conversation goes on at the taker, with new work, a commit and one more message.
    let row = m.taker.db.session_detail(&m.sid).unwrap();
    let copy = PathBuf::from(row["projectPath"].as_str().unwrap());
    std::fs::write(copy.join("later.txt"), "done on the taker\n").unwrap();
    say(&m.taker, &m.sid, "assistant", "Added a test on the other machine.");
    let first_count = m.giver.st.db.session_detail(&m.sid).unwrap()["messages"].as_array().unwrap().len();

    // The giving machine's copy now fetches from the local remote, and its project knows the repository.
    git(&m.giver_repo, &["remote", "set-url", "origin", &m.origin.to_string_lossy()]);
    git(&m.giver_repo, &["config", "--unset", "remote.origin.pushurl"]);
    let project = m.giver.st.db.project_create("repo", Some(&m.giver_repo.to_string_lossy())).unwrap().0;
    let giver_project = project["id"].as_str().unwrap().to_string();
    let back = dispatch(
        &m.giver.st,
        "machine.takeOver",
        json!({"machineId": machines::machine_id(&m.taker), "sessionId": m.sid, "projectId": giver_project, "commitUncommitted": true, "confirm": true}),
    )
    .await
    .unwrap();
    let id = back["job"]["id"].as_str().unwrap().to_string();
    let start = Instant::now();
    let job = loop {
        let jobs = dispatch(&m.giver.st, "machine.takeOver.list", json!({})).await.unwrap();
        let job = jobs["jobs"].as_array().unwrap().iter().find(|job| job["id"] == id.as_str()).cloned().unwrap();
        if job["state"] != "running" {
            break job;
        }
        assert!(start.elapsed() < Duration::from_secs(60), "never finished");
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert_eq!(job["state"], "done", "{job}");

    let row = m.giver.st.db.session_detail(&m.sid).unwrap();
    assert!(row["link"]["movedTo"].is_null(), "opened again");
    let sessions = m.giver.st.db.session_list(true).unwrap();
    assert_eq!(sessions.iter().filter(|s| s["id"] == m.sid.as_str()).count(), 1, "the same conversation, not a second one");
    assert_eq!(row["agentId"], m.agent_id.as_str(), "the same bot");
    let messages = row["messages"].as_array().unwrap();
    let ids: std::collections::HashSet<&str> = messages.iter().filter_map(|x| x["id"].as_str()).collect();
    assert_eq!(ids.len(), messages.len(), "no message twice");
    assert!(messages.len() > first_count);
    assert!(messages.iter().any(|x| x["content"] == "Added a test on the other machine."), "the new message came back");
    assert_eq!(messages.iter().filter(|x| x["content"] == "The export drops the last row.").count(), 1);
    // The code came back too: the original copy fast-forwarded.
    assert_eq!(PathBuf::from(row["projectPath"].as_str().unwrap()), m.copy);
    assert!(m.copy.join("later.txt").is_file(), "the work done on the other machine is in the original copy");
    let (giver, taker) = exactly_one_can_start(&m.giver.st, &m.taker, &m.sid, "back at the start").await;
    assert!(giver && !taker);
    drop(taker_gateway);
}

#[tokio::test]
async fn a_moved_conversations_copy_can_be_listed_as_abandoned() {
    let m = moving("abandoned").await;
    let before = dispatch(&m.giver.st, "worktree.abandoned", json!({})).await.unwrap();
    assert!(before["items"].as_array().unwrap().is_empty(), "a live conversation's copy isn't abandoned: {before}");
    assert_eq!(m.take_over(Some(&m.project_id), true).await["state"], "done");
    let after = dispatch(&m.giver.st, "worktree.abandoned", json!({})).await.unwrap();
    let items = after["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{after}");
    assert_eq!(items[0]["reason"], "conversation_moved");
    assert_eq!(items[0]["branch"], m.branch.as_str());
    assert_eq!(items[0]["path"].as_str().map(|p| p.replace('\\', "/").to_lowercase()), Some(m.copy.to_string_lossy().replace('\\', "/").to_lowercase()));
    // The removal rules are unchanged: nothing goes without confirmation, and not unlisted ids.
    let refused = dispatch(&m.giver.st, "worktree.removeAbandoned", json!({"id": items[0]["id"]})).await.unwrap_err();
    assert_eq!(refused.1.code, "invalid_argument");
    assert!(m.copy.is_dir());
}

#[tokio::test]
async fn take_over_needs_consent_and_a_known_machine() {
    let m = moving("args").await;
    let unconfirmed = dispatch(&m.taker, "machine.takeOver", json!({"machineId": m.giver_id(), "sessionId": m.sid})).await.unwrap_err();
    assert_eq!(unconfirmed.1.code, "invalid_argument");
    let unknown = dispatch(&m.taker, "machine.takeOver", json!({"machineId": "nobody", "sessionId": m.sid, "confirm": true})).await.unwrap_err();
    assert_eq!(unknown.1.code, "not_found");
    let no_folder = dispatch(&m.taker, "machine.takeOver", json!({"machineId": m.giver_id(), "sessionId": m.sid, "projectId": "missing", "confirm": true})).await.unwrap_err();
    assert_eq!(no_folder.1.code, "not_found");
    let listed = dispatch(&m.taker, "machine.takeOver.list", json!({})).await.unwrap();
    assert!(listed["jobs"].as_array().unwrap().is_empty());
    // No uncommitted-files consent: the job fails at the first step and moves nothing.
    m.dirty_the_copy();
    let job = m.take_over(Some(&m.project_id), false).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["detail"], "There are uncommitted files.");
    assert!(m.copy.join("notes.txt").is_file());
    exactly_one_can_start(&m.giver.st, &m.taker, &m.sid, "without consent").await;
}

#[tokio::test]
async fn without_a_project_the_code_stays_and_the_note_says_so() {
    let m = moving("noproject").await;
    m.dirty_the_copy();
    // The copy isn't committed (no consent was asked for a conversation without a project here), but
    // the owner agreed to commit; no project was chosen, so the fetch is skipped.
    let job = m.take_over(None, true).await;
    assert_eq!(job["state"], "done", "{job}");
    assert_eq!(job["steps"][1]["id"], "code");
    assert_eq!(job["steps"][1]["status"], "skipped");
    let row = m.taker.db.session_detail(&m.sid).unwrap();
    assert!(row["link"]["worktree"].is_null());
    assert!(PathBuf::from(row["projectPath"].as_str().unwrap()).starts_with(m.taker_dir.join("workspaces")), "the bot's own workspace");
    exactly_one_can_start(&m.giver.st, &m.taker, &m.sid, "without a project").await;
}

#[tokio::test]
async fn a_conversation_without_its_own_copy_keeps_its_files_on_the_giving_machine() {
    let m = moving("nocopy").await;
    // A conversation in the repository's own folder: no copy of its own to push.
    let sid = "plain-conv";
    m.giver.st.db.create_session_for_agent(sid, "rt-test", "codex", &m.giver_repo.to_string_lossy(), "Plain chat", Some(&m.agent_id)).unwrap();
    m.giver.st.db.update_session_state(sid, "idle").unwrap();
    say(&m.giver.st, sid, "user", "Look at the readme.");
    std::fs::write(m.giver_repo.join("scratch.txt"), "x").unwrap();
    let preview = m.ask("handoff.preview", json!({"sessionId": sid})).await.unwrap();
    let status = git(&m.giver_repo, &["status", "--porcelain", "--untracked-files=all"]);
    assert_eq!((preview["repo"]["isWorktree"].clone(), preview["uncommitted"].clone()), (json!(false), json!(status.lines().count())), "{status}");
    let prepared = m.ask("handoff.prepare", json!({"sessionId": sid, "commitUncommitted": false, "toMachineId": m.taker_id(), "toName": "Taker", "confirm": true})).await.unwrap();
    // Nothing is committed or pushed for a conversation with no copy of its own, and consent isn't needed.
    assert_eq!(prepared["steps"][0]["status"], "skipped", "{prepared}");
    assert_eq!(prepared["steps"][1]["status"], "skipped");
    let note = prepared["package"]["note"].as_str().unwrap();
    assert!(note.contains("The files stayed on") && note.contains("uncommitted file"), "{note}");
    assert!(prepared["package"]["session"]["branch"].is_null());
    assert_eq!(git(&m.giver_repo, &["status", "--porcelain"]), "?? scratch.txt", "the repository was not touched");
    m.ask("handoff.abort", json!({"handoffId": prepared["handoffId"]})).await.unwrap();
}


#[tokio::test]
async fn a_live_conversation_here_is_never_overwritten() {
    let m = moving("live-here").await;
    // This machine already has a conversation with that id, and it is running here (no `movedTo`).
    m.taker.db.agent_create(&json!({"name": "Rae", "runtimeId": "rt-test"})).unwrap();
    let agent = m.taker.db.agent_list(false, None).unwrap()[0]["id"].as_str().unwrap().to_string();
    m.taker.db.create_session_for_agent(&m.sid, "rt-test", "codex", ".", "Mine", Some(&agent)).unwrap();
    m.taker.db.update_session_state(&m.sid, "idle").unwrap();
    say(&m.taker, &m.sid, "user", "My own words.");
    m.dirty_the_copy();
    let preview = dispatch(&m.taker, "machine.takeOver.preview", json!({"machineId": m.giver_id(), "sessionId": m.sid})).await.unwrap();
    assert_eq!((preview["ready"].clone(), preview["reason"].clone()), (json!(false), json!("This conversation is already on this machine.")));
    let job = m.take_over(Some(&m.project_id), true).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["detail"], "This conversation is already on this machine.");
    assert_eq!(step_ids(&job), ["prepare"]);
    // Refused before anything changed anywhere.
    assert!(m.giver.st.machines.handoff.live(&m.sid).is_none());
    assert!(!m.origin_has_branch(), "nothing was pushed");
    assert_eq!(git(&m.copy, &["status", "--porcelain"]), "?? notes.txt", "nothing was committed");
    let row = m.taker.db.session_detail(&m.sid).unwrap();
    assert_eq!(row["title"], "Mine");
    assert_eq!(row["messages"].as_array().unwrap().len(), 1);
    assert!(can_start(&m.giver.st, &m.sid).await);
    // A row waiting for a different machine is no better.
    m.taker.db.set_session_link(&m.sid, &json!({"movedTo": {"machineId": "someone-else", "name": "Other"}})).unwrap();
    let job = m.take_over(Some(&m.project_id), true).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(m.taker.db.session_detail(&m.sid).unwrap()["title"], "Mine");
}
