// Phase 1B: fan-out and compare, send when a usage limit resets, the prompt stash, annotations,
// project scaffolding and the problem report. Included into `phase2a_tests` (like the Phase 1A tests)
// so it shares `state`, `online_team_state`, `TeamAdapter`, `QueueAdapter`, `queue_session` and the
// project helpers from `phase1a_tests.rs`.

fn p1b_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bitbots-1b-{label}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn p1b_png(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]).unwrap();
    path
}

fn p1b_git(dir: &Path, args: &[&str]) -> bool {
    std::process::Command::new("git").current_dir(dir).args(args).output().map(|output| output.status.success()).unwrap_or(false)
}

/// A git repository with one commit, not canonicalised (git and the worktree code take the plain path).
fn p1b_repo() -> PathBuf {
    let dir = p1b_dir("repo");
    assert!(p1b_git(&dir, &["init", "-q"]));
    assert!(p1b_git(&dir, &["config", "core.autocrlf", "false"]));
    std::fs::write(dir.join("readme.txt"), "hello\n").unwrap();
    assert!(p1b_git(&dir, &["add", "."]));
    assert!(p1b_git(&dir, &["-c", "user.name=Test", "-c", "user.email=test@bitbots.local", "commit", "-q", "-m", "init"]));
    dir
}

fn p1b_git_identity() {
    for (key, value) in [("GIT_AUTHOR_NAME", "Test"), ("GIT_AUTHOR_EMAIL", "test@bitbots.local"), ("GIT_COMMITTER_NAME", "Test"), ("GIT_COMMITTER_EMAIL", "test@bitbots.local")] {
        std::env::set_var(key, value);
    }
}

async fn p1b_team() -> (AppState, PathBuf) {
    let (st, _) = online_team_state().await;
    let data = p1b_dir("data");
    *st.team.data_dir.lock().unwrap() = Some(data.clone());
    (st, data)
}

async fn p1b_settled(st: &AppState, id: &str) -> Value {
    for _ in 0..300 {
        let fanout = dispatch(st, "fanout.get", json!({"id": id})).await.unwrap()["fanout"].clone();
        if fanout["rows"].as_array().unwrap().iter().all(|row| row["sessionId"].is_null() || !row["reply"].is_null()) { return fanout; }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("the fan-out never produced its replies: {}", dispatch(st, "fanout.get", json!({"id": id})).await.unwrap());
}

// ── 1. Fan-out and compare ───────────────────────────────────────────────

#[tokio::test]
async fn fanout_starts_one_conversation_per_bot_in_the_same_project() {
    let (st, _data) = p1b_team().await;
    let (project, folder) = real_project(&st, "Compare");
    let bots = ["One", "Two", "Three"].map(|name| new_agent(&st, name));
    let started = dispatch(&st, "fanout.start", json!({"agentIds": bots, "text": "Which is best?", "projectId": project})).await.unwrap()["fanout"].clone();
    assert_eq!(started["title"], "Which is best?");
    assert_eq!(started["text"], "Which is best?");
    assert_eq!((started["projectId"].as_str(), started["projectName"].as_str()), (Some(project.as_str()), Some("Compare")));
    assert!(started["chosenSessionId"].is_null());
    let rows = started["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    let mut sessions = Vec::new();
    for (row, bot) in rows.iter().zip(&bots) {
        assert_eq!(row["agentId"], bot.as_str());
        assert!(row["error"].is_null(), "{row}");
        let id = row["sessionId"].as_str().expect("a conversation per bot").to_owned();
        let detail = st.db.session_detail(&id).unwrap();
        assert_eq!(detail["projectId"], project.as_str());
        assert_eq!(detail["fanoutId"], started["id"]);
        assert_eq!(detail["title"], "Which is best?", "the title is each conversation's title");
        assert_eq!(PathBuf::from(detail["projectPath"].as_str().unwrap()), folder, "no git here, so they share the folder");
        sessions.push(id);
    }
    sessions.sort();
    sessions.dedup();
    assert_eq!(sessions.len(), 3, "each bot has its own conversation");
    // The conversation lists carry the fan-out id too.
    let listed = st.db.session_list(false).unwrap();
    assert_eq!(listed.iter().filter(|row| row["fanoutId"] == started["id"]).count(), 3);
    let settled = p1b_settled(&st, started["id"].as_str().unwrap()).await;
    assert!(settled["rows"].as_array().unwrap().iter().all(|row| row["reply"] == "handled: Which is best?"), "{settled}");
    // The record is listed, newest first.
    let all = dispatch(&st, "fanout.list", json!({})).await.unwrap();
    assert_eq!(all["fanouts"][0]["id"], started["id"]);
}

#[tokio::test]
async fn fanout_null_project_uses_each_private_workspace() {
    let (st, data) = p1b_team().await;
    let bots = ["Solo", "Duo"].map(|name| new_agent(&st, name));
    // The explicit null: no project, each bot's private workspace, even if it has a default.
    let (project, _) = real_project(&st, "Default");
    dispatch(&st, "agent.team.update", json!({"agentId": bots[0], "projectId": project})).await.unwrap();
    let started = dispatch(&st, "fanout.start", json!({"agentIds": bots, "text": "Hello", "projectId": Value::Null})).await.unwrap()["fanout"].clone();
    assert!(started["projectId"].is_null());
    let mut folders = Vec::new();
    for row in started["rows"].as_array().unwrap() {
        let detail = st.db.session_detail(row["sessionId"].as_str().unwrap()).unwrap();
        assert!(detail["projectId"].is_null(), "{detail}");
        let folder = PathBuf::from(detail["projectPath"].as_str().unwrap());
        assert!(folder.starts_with(data.join("workspaces")), "{folder:?}");
        folders.push(folder);
    }
    assert_ne!(folders[0], folders[1], "each bot has its own workspace");
    // Omitted: each bot's own default order, so the bot with a default project opens there.
    let omitted = dispatch(&st, "fanout.start", json!({"agentIds": bots, "text": "Again"})).await.unwrap()["fanout"].clone();
    let first = st.db.session_detail(omitted["rows"][0]["sessionId"].as_str().unwrap()).unwrap();
    let second = st.db.session_detail(omitted["rows"][1]["sessionId"].as_str().unwrap()).unwrap();
    assert_eq!(first["projectId"], project.as_str());
    assert!(second["projectId"].is_null());
}

#[tokio::test]
async fn fanout_makes_a_worktree_each_in_a_git_project() {
    let (mut st, _data) = p1b_team().await;
    // A coding agent that never finishes its turn, so an untouched copy is not tidied away.
    let hold = Arc::new(QueueAdapter::default());
    install_queue_adapter(&mut st, &hold);
    let repo = p1b_repo();
    let project = st.db.project_create("Repo", Some(&repo.to_string_lossy())).unwrap().0["id"].as_str().unwrap().to_owned();
    let bots = ["Wt One", "Wt Two"].map(|name| new_agent(&st, name));
    let started = dispatch(&st, "fanout.start", json!({"agentIds": bots, "text": "Build a thing", "projectId": project})).await.unwrap()["fanout"].clone();
    let rows = started["rows"].as_array().unwrap();
    let mut paths = Vec::new();
    let mut branches = Vec::new();
    for row in rows {
        assert!(row["error"].is_null(), "{row}");
        let copy = &row["worktree"];
        assert!(copy["path"].is_string() && copy["branch"].as_str().unwrap().starts_with("bitbots/"), "{row}");
        assert!(PathBuf::from(copy["path"].as_str().unwrap()).is_dir());
        let detail = st.db.session_detail(row["sessionId"].as_str().unwrap()).unwrap();
        assert_eq!(detail["link"]["kind"], "main");
        assert_eq!(detail["projectId"], project.as_str(), "a conversation in a copy is still in the project");
        assert_eq!(detail["projectPath"], copy["path"]);
        paths.push(copy["path"].clone());
        branches.push(copy["branch"].clone());
    }
    assert_ne!(paths[0], paths[1]);
    assert_ne!(branches[0], branches[1]);
    // Turned off, they share the folder and have no copy.
    let shared = dispatch(&st, "fanout.start", json!({"agentIds": bots, "text": "Share", "projectId": project, "worktrees": false})).await.unwrap()["fanout"].clone();
    for row in shared["rows"].as_array().unwrap() { assert!(row["worktree"].is_null(), "{row}"); }
    let _ = std::fs::remove_dir_all(format!("{}-bitbots", repo.display()));
    let _ = std::fs::remove_dir_all(&repo);
}

#[tokio::test]
async fn fanout_refuses_too_few_or_an_archived_bot_and_creates_nothing() {
    let (st, _data) = p1b_team().await;
    let bots = ["A", "B", "C", "D", "E", "F", "G"].map(|name| new_agent(&st, name));
    let invalid = |ids: Vec<&String>| json!({"agentIds": ids, "text": "hi"});
    for ids in [vec![], vec![&bots[0]], vec![&bots[0], &bots[0]], bots.iter().collect::<Vec<_>>()] {
        let error = dispatch(&st, "fanout.start", invalid(ids)).await.unwrap_err();
        assert_eq!((error.1.code.as_str(), error.1.message.as_str()), ("invalid_argument", "Choose 2 to 6 bots."));
    }
    st.db.agent_archive(&bots[1]).unwrap();
    let archived = dispatch(&st, "fanout.start", invalid(vec![&bots[0], &bots[1]])).await.unwrap_err();
    assert_eq!(archived.1.code, "conflict");
    let missing = dispatch(&st, "fanout.start", json!({"agentIds": [bots[0], Uuid::new_v4().to_string()], "text": "hi"})).await.unwrap_err();
    assert_eq!(missing.1.code, "not_found");
    let folderless = st.db.project_create("Nowhere", None).unwrap().0;
    let no_folder = dispatch(&st, "fanout.start", json!({"agentIds": [bots[0], bots[2]], "text": "hi", "projectId": folderless["id"]})).await.unwrap_err();
    assert_eq!(no_folder.1.code, "invalid_argument");
    let no_project = dispatch(&st, "fanout.start", json!({"agentIds": [bots[0], bots[2]], "text": "hi", "projectId": "nope"})).await.unwrap_err();
    assert_eq!(no_project.1.code, "not_found");
    let empty = dispatch(&st, "fanout.start", json!({"agentIds": [bots[0], bots[2]], "text": ""})).await.unwrap_err();
    assert_eq!(empty.1.code, "invalid_argument");
    assert!(dispatch(&st, "fanout.list", json!({})).await.unwrap()["fanouts"].as_array().unwrap().is_empty(), "no record was made");
    assert!(st.db.session_list(true).unwrap().is_empty(), "no conversation was made");
}

#[tokio::test]
async fn fanout_one_bad_row_does_not_stop_the_others() {
    let (st, data) = p1b_team().await;
    // A coding agent that takes no images.
    st.db.upsert_runtime(&json!({"id": "rt-noimg", "provider": "acp", "status": "online"})).unwrap();
    let plain = st.db.agent_create(&json!({"name": "Plain", "runtimeId": "rt-noimg"})).unwrap().0["id"].as_str().unwrap().to_owned();
    let plain_two = st.db.agent_create(&json!({"name": "Plain two", "runtimeId": "rt-noimg"})).unwrap().0["id"].as_str().unwrap().to_owned();
    let good = new_agent(&st, "Good");
    let shot = p1b_png(&data, "shot.png");
    let started = dispatch(&st, "fanout.start", json!({"agentIds": [good, plain], "text": "Look", "attachments": [{"path": shot, "name": "shot.png"}]})).await.unwrap()["fanout"].clone();
    let rows = started["rows"].as_array().unwrap();
    assert!(rows[0]["sessionId"].is_string() && rows[0]["error"].is_null(), "{}", rows[0]);
    assert!(rows[1]["sessionId"].is_null(), "{}", rows[1]);
    assert_eq!(rows[1]["state"], "failed");
    assert_eq!(rows[1]["error"], "Plain uses a coding agent that doesn't take images.");
    p1b_settled(&st, started["id"].as_str().unwrap()).await;
    // Every row failing still returns the record.
    let all_bad = dispatch(&st, "fanout.start", json!({"agentIds": [plain, plain_two], "text": "Look", "attachments": [{"path": shot, "name": "shot.png"}]})).await.unwrap()["fanout"].clone();
    assert!(all_bad["rows"].as_array().unwrap().iter().all(|row| row["state"] == "failed" && row["sessionId"].is_null() && row["error"].is_string()));
    assert_eq!(dispatch(&st, "fanout.get", json!({"id": all_bad["id"]})).await.unwrap()["fanout"]["rows"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn fanout_get_reports_replies_and_unknown_usage_as_null() {
    let (st, _data) = p1b_team().await;
    let bots = ["Reader", "Writer"].map(|name| new_agent(&st, name));
    let long = "x".repeat(400);
    let started = dispatch(&st, "fanout.start", json!({"agentIds": bots, "text": long, "title": "A long one"})).await.unwrap()["fanout"].clone();
    assert_eq!(started["title"], "A long one");
    let id = started["id"].as_str().unwrap();
    let got = p1b_settled(&st, id).await;
    for row in got["rows"].as_array().unwrap() {
        assert_eq!(row["reply"], format!("handled: {long}"), "get carries the whole reply");
        assert!(row["tokens"].is_null(), "the stub reported no usage, so it is unknown, never zero: {row}");
        assert!(row["durationMs"].is_null() || row["durationMs"].as_i64().unwrap() > 0, "{row}");
        assert!(row["agentName"].is_string());
        assert_ne!(row["state"], "failed");
    }
    // A reported usage becomes the total of the latest turn.
    let first = got["rows"][0]["sessionId"].as_str().unwrap();
    let turn = st.db.session_latest_turn(first).unwrap().unwrap()["id"].as_str().unwrap().to_owned();
    st.db.record_usage_event_for_test(first, &turn, 120, 30);
    let with_usage = dispatch(&st, "fanout.get", json!({"id": id})).await.unwrap()["fanout"].clone();
    assert_eq!(with_usage["rows"][0]["tokens"], 150);
    assert!(with_usage["rows"][1]["tokens"].is_null());
    // The list cuts a reply to 300 characters.
    let listed = dispatch(&st, "fanout.list", json!({"limit": 5})).await.unwrap()["fanouts"][0].clone();
    assert_eq!(listed["rows"][0]["reply"].as_str().unwrap().chars().count(), 300);
    // A deleted conversation reads as a failed row.
    st.db.session_delete(got["rows"][1]["sessionId"].as_str().unwrap()).unwrap();
    let after = dispatch(&st, "fanout.get", json!({"id": id})).await.unwrap()["fanout"].clone();
    assert_eq!(after["rows"][1]["state"], "failed");
    assert!(after["rows"][1]["sessionId"].is_null());
    assert_eq!(dispatch(&st, "fanout.get", json!({"id": "missing"})).await.unwrap_err().1.code, "not_found");
}

#[tokio::test]
async fn fanout_pick_and_delete() {
    let (st, _data) = p1b_team().await;
    let bots = ["Pick one", "Pick two"].map(|name| new_agent(&st, name));
    let started = dispatch(&st, "fanout.start", json!({"agentIds": bots, "text": "Choose"})).await.unwrap()["fanout"].clone();
    let id = started["id"].as_str().unwrap();
    let first = started["rows"][0]["sessionId"].as_str().unwrap().to_owned();
    let mut events = st.events.subscribe();
    let picked = dispatch(&st, "fanout.pick", json!({"id": id, "sessionId": first})).await.unwrap()["fanout"].clone();
    assert_eq!(picked["chosenSessionId"], first.as_str());
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), async { loop { let event = events.recv().await.unwrap(); if event.event_type == "fanout.changed" { break event; } } }).await.unwrap();
    assert_eq!(event.payload, json!({"id": id}), "the event carries no text");
    assert_eq!(dispatch(&st, "fanout.pick", json!({"id": id, "sessionId": "not-in-it"})).await.unwrap_err().1.code, "invalid_argument");
    assert_eq!(dispatch(&st, "fanout.get", json!({"id": id})).await.unwrap()["fanout"]["chosenSessionId"], first.as_str(), "a refused pick changes nothing");
    let cleared = dispatch(&st, "fanout.pick", json!({"id": id, "sessionId": Value::Null})).await.unwrap()["fanout"].clone();
    assert!(cleared["chosenSessionId"].is_null());
    assert_eq!(dispatch(&st, "fanout.pick", json!({"id": "missing", "sessionId": Value::Null})).await.unwrap_err().1.code, "not_found");
    // Deleting removes the record only.
    assert_eq!(st.db.session_detail(&first).unwrap()["fanoutId"], id);
    assert_eq!(dispatch(&st, "fanout.delete", json!({"id": id})).await.unwrap(), json!({"deleted": true}));
    assert_eq!(dispatch(&st, "fanout.get", json!({"id": id})).await.unwrap_err().1.code, "not_found");
    assert_eq!(dispatch(&st, "fanout.delete", json!({"id": id})).await.unwrap_err().1.code, "not_found");
    let kept = st.db.session_detail(&first).unwrap();
    assert!(kept["fanoutId"].is_null(), "the conversation stays and reads back no fan-out");
}

// ── 2. Send when a usage limit resets ────────────────────────────────────

fn p1b_future(secs: i64) -> String {
    (Utc::now() + chrono::Duration::seconds(secs)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[tokio::test]
async fn when_limit_resets_needs_a_limited_session() {
    let (mut st, _) = state();
    let adapter = Arc::new(QueueAdapter::default());
    install_queue_adapter(&mut st, &adapter);
    let _tx = queue_session(&st, &adapter, "wl-needs").await;
    let refused = dispatch(&st, "session.queue.add", json!({"sessionId": "wl-needs", "text": "later", "whenLimitResets": true})).await.unwrap_err();
    assert_eq!((refused.1.code.as_str(), refused.1.message.as_str()), ("conflict", "This conversation isn't waiting for a usage limit."));
    let both = dispatch(&st, "session.queue.add", json!({"sessionId": "wl-needs", "text": "later", "whenLimitResets": true, "dueAt": p1b_future(600)})).await.unwrap_err();
    assert_eq!(both.1.code, "invalid_argument");
    let bad_flag = dispatch(&st, "session.queue.add", json!({"sessionId": "wl-needs", "text": "later", "whenLimitResets": "yes"})).await.unwrap_err();
    assert_eq!(bad_flag.1.code, "invalid_argument");
    // A reset that is already past is not waiting either.
    st.db.watchdog_limit("wl-needs", Some(&past_due_at(30))).unwrap();
    assert_eq!(dispatch(&st, "session.queue.add", json!({"sessionId": "wl-needs", "text": "later", "whenLimitResets": true})).await.unwrap_err().1.code, "conflict");
    // A reset an hour out (beyond nothing the time picker would allow differently) is accepted as it is.
    let reset = p1b_future(3 * 3600);
    st.db.watchdog_limit("wl-needs", Some(&reset)).unwrap();
    let limited_until = st.db.session_detail("wl-needs").unwrap()["limitedUntil"].as_str().unwrap().to_owned();
    let added = dispatch(&st, "session.queue.add", json!({"sessionId": "wl-needs", "text": "when it resets", "whenLimitResets": true})).await.unwrap()["item"].clone();
    assert_eq!(added["kind"], "send_later");
    assert_eq!(added["whenLimitResets"], true);
    assert_eq!(added["dueAt"], limited_until.as_str());
    let listed = dispatch(&st, "session.queue.list", json!({"sessionId": "wl-needs"})).await.unwrap();
    assert_eq!(listed["items"][0]["whenLimitResets"], true);
    // An ordinary scheduled item reads false.
    let plain = dispatch(&st, "session.queue.add", json!({"sessionId": "wl-needs", "text": "ordinary", "dueAt": p1b_future(600)})).await.unwrap()["item"].clone();
    assert_eq!(plain["whenLimitResets"], false);
    // A side conversation keeps its refusal.
    st.db.create_session_for_agent("wl-side", "rt-test", "codex", ".", "Side", None).unwrap();
    st.db.set_session_link("wl-side", &json!({"kind": "side", "peerAgentId": "someone", "originSessionId": "wl-needs"})).unwrap();
    assert_eq!(dispatch(&st, "session.queue.add", json!({"sessionId": "wl-side", "text": "x", "whenLimitResets": true})).await.unwrap_err().1.code, "read_only");
}

#[tokio::test]
async fn when_limit_resets_sends_after_the_continuation_not_before() {
    let (mut st, _) = state();
    let adapter = Arc::new(QueueAdapter::default());
    install_queue_adapter(&mut st, &adapter);
    let tx = queue_session(&st, &adapter, "wl-order").await;
    st.db.watchdog_limit("wl-order", Some(&p1b_future(3600))).unwrap();
    let item = dispatch(&st, "session.queue.add", json!({"sessionId": "wl-order", "text": "after the reset", "whenLimitResets": true})).await.unwrap()["item"].clone();
    let item_id = item["id"].as_str().unwrap();
    // The reset arrives: the window is over and the item is due, but the watchdog has not run yet.
    st.db.watchdog_limit("wl-order", Some(&past_due_at(2))).unwrap();
    st.db.queue_set_due(item_id, &past_due_at(2)).unwrap();
    crate::queue::due_tick(&st).await;
    assert!(adapter.texts().is_empty(), "the continuation goes first: {:?}", adapter.texts());
    retry::sweep(&st).await;
    assert_eq!(st.db.queue_list("wl-order").unwrap().len(), 2, "the continuation is queued next to the waiting message");
    crate::queue::due_tick(&st).await;
    assert!(wait_for(|| adapter.texts() == vec!["Continue where you left off."]).await, "{:?}", adapter.texts());
    crate::queue::due_tick(&st).await;
    assert_eq!(adapter.texts().len(), 1, "a busy conversation is left alone");
    // The continuation's turn ends; the waiting message follows it.
    tx.send(AgentEvent::TurnCompleted).await.unwrap();
    assert!(wait_for(|| adapter.texts() == vec!["Continue where you left off.", "after the reset"]).await, "{:?}", adapter.texts());
    assert!(wait_for(|| st.db.queue_list("wl-order").unwrap().is_empty()).await);
}

#[tokio::test]
async fn when_limit_resets_follows_an_extended_limit() {
    let (mut st, _) = state();
    let adapter = Arc::new(QueueAdapter::default());
    install_queue_adapter(&mut st, &adapter);
    let _tx = queue_session(&st, &adapter, "wl-extend").await;
    st.db.watchdog_limit("wl-extend", Some(&p1b_future(3600))).unwrap();
    let item = dispatch(&st, "session.queue.add", json!({"sessionId": "wl-extend", "text": "wait for me", "whenLimitResets": true})).await.unwrap()["item"].clone();
    let item_id = item["id"].as_str().unwrap();
    // The first reset time comes, but the provider has pushed the window out.
    st.db.queue_set_due(item_id, &past_due_at(2)).unwrap();
    let extended = p1b_future(7200);
    st.db.watchdog_limit("wl-extend", Some(&extended)).unwrap();
    let mut events = st.events.subscribe();
    crate::queue::due_tick(&st).await;
    assert!(adapter.texts().is_empty(), "still limited, so nothing is sent");
    let moved = st.db.queue_get("wl-extend", item_id).unwrap();
    assert_eq!(moved["dueAt"], st.db.session_detail("wl-extend").unwrap()["limitedUntil"], "the item follows the new reset");
    assert_eq!(moved["status"], "queued");
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), async { loop { let event = events.recv().await.unwrap(); if event.event_type == "queue.changed" { break event; } } }).await.unwrap();
    assert_eq!(event.payload["sessionId"], "wl-extend");
    // An ordinary scheduled item on the same limited session keeps today's behaviour.
    let ordinary = dispatch(&st, "session.queue.add", json!({"sessionId": "wl-extend", "text": "ordinary", "dueAt": p1b_future(60)})).await.unwrap()["item"].clone();
    st.db.queue_set_due(ordinary["id"].as_str().unwrap(), &past_due_at(2)).unwrap();
    crate::queue::due_tick(&st).await;
    assert!(wait_for(|| adapter.texts() == vec!["ordinary"]).await, "{:?}", adapter.texts());
}

#[tokio::test]
async fn when_limit_resets_ignores_the_resume_setting() {
    let (mut st, _) = state();
    let adapter = Arc::new(QueueAdapter::default());
    install_queue_adapter(&mut st, &adapter);
    let _tx = queue_session(&st, &adapter, "wl-off").await;
    st.db.set_setting("experimental.resumeAfterUsageLimits", &json!(false)).unwrap();
    st.db.watchdog_limit("wl-off", Some(&p1b_future(3600))).unwrap();
    let item = dispatch(&st, "session.queue.add", json!({"sessionId": "wl-off", "text": "sent anyway", "whenLimitResets": true})).await.unwrap()["item"].clone();
    crate::queue::due_tick(&st).await;
    assert!(adapter.texts().is_empty(), "the window is still open");
    st.db.watchdog_limit("wl-off", Some(&past_due_at(2))).unwrap();
    st.db.queue_set_due(item["id"].as_str().unwrap(), &past_due_at(2)).unwrap();
    retry::sweep(&st).await;
    assert_eq!(st.db.queue_list("wl-off").unwrap().len(), 1, "the setting is off, so the watchdog queues no continuation");
    crate::queue::due_tick(&st).await;
    assert!(wait_for(|| adapter.texts() == vec!["sent anyway"]).await, "{:?}", adapter.texts());
}

// ── 3. Prompt stash ──────────────────────────────────────────────────────

#[tokio::test]
async fn stash_keeps_text_and_images_across_a_restart() {
    let dir = p1b_dir("stash-restart");
    let db_path = dir.join("bitbots.db");
    let shot = p1b_png(&dir, "shot.png");
    let id = {
        let (st, _) = state_with(Storage::open(&db_path).unwrap());
        *st.team.data_dir.lock().unwrap() = Some(dir.clone());
        let agent = new_agent(&st, "Stasher");
        let (project, _) = real_project(&st, "Stashed");
        let added = dispatch(&st, "stash.add", json!({"text": "Remember this", "attachments": [{"path": shot, "name": "shot.png"}], "agentId": agent, "projectId": project, "sessionId": "no-such-session"})).await.unwrap()["item"].clone();
        assert_eq!(added["agentName"], "Stasher");
        assert_eq!(added["projectName"], "Stashed");
        assert!(added["sessionId"].is_null(), "an unknown id is stored as null");
        assert_eq!(added["attachments"][0]["name"], "shot.png");
        assert_eq!(added["attachments"][0]["mediaType"], "image/png");
        assert_eq!(added["attachments"][0]["bytes"], 12);
        added["id"].as_str().unwrap().to_owned()
    };
    let (st, _) = state_with(Storage::open(&db_path).unwrap());
    *st.team.data_dir.lock().unwrap() = Some(dir.clone());
    let listed = dispatch(&st, "stash.list", json!({})).await.unwrap()["items"].clone();
    assert_eq!(listed[0]["id"], id.as_str());
    assert_eq!(listed[0]["text"], "Remember this");
    let file = listed[0]["attachments"][0]["file"].as_str().unwrap();
    let image = dispatch(&st, "stash.image", json!({"id": id, "file": file})).await.unwrap();
    assert!(image["dataUrl"].as_str().unwrap().starts_with("data:image/png;base64,"));
    assert_eq!((image["mediaType"].as_str(), image["name"].as_str()), (Some("image/png"), Some("shot.png")));
    let updated = dispatch(&st, "stash.update", json!({"id": id, "text": "Edited"})).await.unwrap()["item"].clone();
    assert_eq!(updated["text"], "Edited");
    assert!(updated["updatedAt"].as_str().unwrap() >= updated["createdAt"].as_str().unwrap());
    // An image-only item may lose its text but not everything.
    dispatch(&st, "stash.update", json!({"id": id, "text": ""})).await.unwrap();
    let text_only = dispatch(&st, "stash.add", json!({"text": "only words"})).await.unwrap()["item"].clone();
    assert_eq!(dispatch(&st, "stash.update", json!({"id": text_only["id"], "text": ""})).await.unwrap_err().1.code, "invalid_argument");
}

#[tokio::test]
async fn stash_refuses_empty_too_many_and_a_non_image() {
    let (st, data) = p1b_team().await;
    let empty = dispatch(&st, "stash.add", json!({"text": "   "})).await.unwrap_err();
    assert_eq!(empty.1.code, "invalid_argument");
    let fake = data.join("notes.png");
    std::fs::write(&fake, b"not an image at all").unwrap();
    assert_eq!(dispatch(&st, "stash.add", json!({"text": "x", "attachments": [{"path": fake}]})).await.unwrap_err().1.code, "invalid_argument");
    let shot = p1b_png(&data, "ok.png");
    let eleven = vec![json!({"path": shot}); 11];
    assert_eq!(dispatch(&st, "stash.add", json!({"text": "x", "attachments": eleven})).await.unwrap_err().1.code, "invalid_argument");
    let ten = vec![json!({"path": shot}); 10];
    let kept = dispatch(&st, "stash.add", json!({"text": "ten", "attachments": ten})).await.unwrap()["item"].clone();
    assert_eq!(kept["attachments"].as_array().unwrap().len(), 10, "ten images are fine, though a message holds eight");
    assert_eq!(dispatch(&st, "stash.add", json!({"text": "x".repeat(100_001)})).await.unwrap_err().1.code, "invalid_argument");
    assert_eq!(dispatch(&st, "stash.add", json!({"attachments": "no"})).await.unwrap_err().1.code, "invalid_argument");
    // The 101st item is refused.
    dispatch(&st, "stash.delete", json!({"id": kept["id"]})).await.unwrap();
    for index in 0..100 { st.db.stash_insert(&format!("fill-{index}"), "x", &json!([]), None, None, None, 100).unwrap(); }
    let full = dispatch(&st, "stash.add", json!({"text": "one too many"})).await.unwrap_err();
    assert_eq!((full.1.code.as_str(), full.1.message.as_str()), ("conflict", "The stash is full. Remove something first."));
}

#[tokio::test]
async fn stash_restore_gives_sendable_paths_and_removes_the_row() {
    let (st, data) = p1b_team().await;
    let shot = p1b_png(&data, "restore.png");
    let added = dispatch(&st, "stash.add", json!({"text": "Use me", "attachments": [{"path": shot, "name": "restore.png"}]})).await.unwrap()["item"].clone();
    let id = added["id"].as_str().unwrap();
    assert!(data.join("stash").join(id).is_dir());
    let restored = dispatch(&st, "stash.restore", json!({"id": id})).await.unwrap()["item"].clone();
    assert_eq!(restored["text"], "Use me");
    let path = PathBuf::from(restored["attachments"][0]["path"].as_str().unwrap());
    assert!(path.is_file() && path.starts_with(data.join("stash-restored")), "{path:?}");
    assert_eq!(restored["attachments"][0]["name"], "restore.png");
    assert!(prompt_attachments(&json!([{"path": path, "name": "restore.png"}])).is_ok(), "the paths can be sent like staged images");
    assert!(!data.join("stash").join(id).exists(), "the stash copy is gone");
    assert!(dispatch(&st, "stash.list", json!({})).await.unwrap()["items"].as_array().unwrap().is_empty());
    assert_eq!(dispatch(&st, "stash.restore", json!({"id": id})).await.unwrap_err().1.code, "not_found");
    // Startup removes restored folders older than the keep time, and only those.
    let fresh = data.join("stash-restored").join("fresh");
    std::fs::create_dir_all(&fresh).unwrap();
    crate::stash::prune_for_test(&data.join("stash-restored"), std::time::Duration::from_secs(3600));
    assert!(fresh.is_dir() && path.is_file(), "recent folders stay");
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    crate::stash::prune_for_test(&data.join("stash-restored"), std::time::Duration::from_millis(5));
    assert!(!fresh.exists() && !path.exists(), "old folders go");
}

#[tokio::test]
async fn stash_image_cannot_escape_its_folder() {
    let (st, data) = p1b_team().await;
    let shot = p1b_png(&data, "inside.png");
    std::fs::write(data.join("secret.txt"), "private").unwrap();
    let added = dispatch(&st, "stash.add", json!({"attachments": [{"path": shot}]})).await.unwrap()["item"].clone();
    let id = added["id"].as_str().unwrap();
    let real = added["attachments"][0]["file"].as_str().unwrap();
    assert!(dispatch(&st, "stash.image", json!({"id": id, "file": real})).await.is_ok());
    for file in ["../../secret.txt", "..\\..\\secret.txt", "../inside.png", "secret.txt", &shot.to_string_lossy(), "", "0.png/../0.png"] {
        let error = dispatch(&st, "stash.image", json!({"id": id, "file": file})).await.unwrap_err();
        assert!(matches!(error.1.code.as_str(), "not_found" | "invalid_argument"), "{file}: {}", error.1.code);
    }
    for bad_id in ["../x", "..\\x", "a/b", ""] {
        let error = dispatch(&st, "stash.image", json!({"id": bad_id, "file": real})).await.unwrap_err();
        assert_eq!(error.1.code, "invalid_argument", "{bad_id}");
    }
}

#[tokio::test]
async fn stash_delete_removes_files() {
    let (st, data) = p1b_team().await;
    let shot = p1b_png(&data, "delete.png");
    let added = dispatch(&st, "stash.add", json!({"text": "Bin me", "attachments": [{"path": shot}]})).await.unwrap()["item"].clone();
    let id = added["id"].as_str().unwrap();
    let folder = data.join("stash").join(id);
    assert!(folder.is_dir());
    let mut events = st.events.subscribe();
    assert_eq!(dispatch(&st, "stash.delete", json!({"id": id})).await.unwrap(), json!({"deleted": true}));
    assert!(!folder.exists());
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), async { loop { let event = events.recv().await.unwrap(); if event.event_type == "stash.changed" { break event; } } }).await.unwrap();
    assert_eq!(event.payload, json!({}), "the event carries no content");
    assert_eq!(dispatch(&st, "stash.delete", json!({"id": id})).await.unwrap_err().1.code, "not_found");
}

// ── 4. Annotations ───────────────────────────────────────────────────────

/// A conversation with one assistant message to mark: its id and the message id.
async fn p1b_annotatable(st: &AppState) -> (String, String) {
    let agent = new_agent(st, "Noted");
    let opened = dispatch(st, "agent.conversation.create", json!({"agentId": agent})).await.unwrap();
    let sid = opened["session"]["id"].as_str().unwrap().to_owned();
    let reply = st.db.append_message_with_data(&sid, "", "assistant", "First line of the reply.\nSecond line of the reply.", &json!({})).unwrap();
    (sid, reply["id"].as_str().unwrap().to_owned())
}

async fn p1b_last_prompt(adapter: &TeamAdapter) -> String {
    for _ in 0..200 {
        if let Some(text) = adapter.prompts.lock().unwrap().last().cloned() { return text; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("no prompt reached the coding agent");
}

#[tokio::test]
async fn annotations_reach_the_provider_before_the_text() {
    let (st, adapter) = online_team_state().await;
    *st.team.data_dir.lock().unwrap() = Some(p1b_dir("data"));
    let (sid, message) = p1b_annotatable(&st).await;
    dispatch(&st, "session.prompt", json!({"sessionId": sid, "text": "Please fix both.", "annotations": [
        {"messageId": message, "quote": "First line\nsecond quoted line", "note": "This is wrong"},
        {"messageId": message, "quote": "Second line", "note": "And this"},
    ]})).await.unwrap();
    let prompt = p1b_last_prompt(&adapter).await;
    let expected = "The owner marked parts of your earlier reply:\n\n1. On this part:\n> First line\n> second quoted line\nNote: This is wrong\n\n2. On this part:\n> Second line\nNote: And this\n\nPlease fix both.";
    assert!(prompt.starts_with(expected), "{prompt}");
}

#[tokio::test]
async fn annotations_are_stored_in_meta_and_text_stays_the_users() {
    let (st, _adapter) = online_team_state().await;
    *st.team.data_dir.lock().unwrap() = Some(p1b_dir("data"));
    let (sid, message) = p1b_annotatable(&st).await;
    let note = json!({"messageId": message, "quote": "from the rendered text, not exactly the stored one", "note": "Check this"});
    dispatch(&st, "session.prompt", json!({"sessionId": sid, "text": "My words only", "annotations": [note]})).await.unwrap();
    let messages = wait_for_messages(&st, &sid, |messages| messages.iter().any(|m| m["role"] == "user")).await;
    let sent = messages.iter().find(|m| m["role"] == "user").unwrap();
    assert_eq!(sent["content"], "My words only", "the transcript keeps the owner's words");
    assert_eq!(sent["meta"]["annotations"], json!([note]));
    wait_for_messages(&st, &sid, |messages| messages.iter().any(|m| m["role"] == "assistant" && m["content"].as_str().is_some_and(|c| c.starts_with("handled:")))).await;
    // The text may be empty when there is a note.
    dispatch(&st, "session.prompt", json!({"sessionId": sid, "text": "", "annotations": [note]})).await.unwrap();
    let again = wait_for_messages(&st, &sid, |messages| messages.iter().filter(|m| m["role"] == "user").count() == 2).await;
    assert_eq!(again.iter().rfind(|m| m["role"] == "user").unwrap()["meta"]["annotations"], json!([note]));
}

#[tokio::test]
async fn annotations_refuse_a_foreign_message_and_too_many() {
    let (st, _adapter) = online_team_state().await;
    *st.team.data_dir.lock().unwrap() = Some(p1b_dir("data"));
    let (sid, message) = p1b_annotatable(&st).await;
    st.db.create_session("an-other", "rt-test", "codex", ".", "Other").unwrap();
    let foreign = st.db.append_message("an-other", "", "assistant", "someone else's reply").unwrap();
    let mine = st.db.append_message("an-other", "", "user", "x").unwrap();
    let own_user = st.db.append_message_with_data(&sid, "", "user", "my own words", &json!({})).unwrap();
    let send = |notes: Value| { let st = st.clone(); let sid = sid.clone(); async move { dispatch(&st, "session.prompt", json!({"sessionId": sid, "text": "hi", "annotations": notes})).await.unwrap_err() } };
    let ok = json!({"messageId": message, "quote": "q", "note": "n"});
    for notes in [
        json!([{"messageId": foreign["id"], "quote": "q", "note": "n"}]),
        json!([{"messageId": mine["id"], "quote": "q", "note": "n"}]),
        json!([{"messageId": own_user["id"], "quote": "q", "note": "n"}]),
        json!([{"messageId": "missing", "quote": "q", "note": "n"}]),
        json!([{"messageId": message, "quote": "", "note": "n"}]),
        json!([{"messageId": message, "quote": "q", "note": ""}]),
        json!([{"messageId": message, "quote": "q".repeat(2001), "note": "n"}]),
        json!([{"messageId": message, "quote": "q", "note": "n".repeat(2001)}]),
        json!(vec![ok.clone(); 11]),
        json!("not a list"),
    ] {
        assert_eq!(send(notes.clone()).await.1.code, "invalid_argument", "{notes}");
    }
    assert_eq!(st.db.session_detail(&sid).unwrap()["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "user" && m["content"] == "hi").count(), 0, "nothing was sent");
    // Ten notes are fine.
    dispatch(&st, "session.prompt", json!({"sessionId": sid, "text": "ten", "annotations": vec![ok; 10]})).await.unwrap();
}

#[tokio::test]
async fn queued_annotations_survive_to_delivery() {
    let (mut st, _) = state();
    let adapter = Arc::new(QueueAdapter::default());
    install_queue_adapter(&mut st, &adapter);
    let tx = queue_session(&st, &adapter, "an-queue").await;
    let reply = st.db.append_message_with_data("an-queue", "", "assistant", "A reply to mark.", &json!({})).unwrap();
    mark_busy(&st, "an-queue", "an-turn").await;
    let note = json!({"messageId": reply["id"], "quote": "A reply", "note": "Say more"});
    let added = dispatch(&st, "session.queue.add", json!({"sessionId": "an-queue", "text": "Queued words", "annotations": [note]})).await.unwrap()["item"].clone();
    assert_eq!(added["annotations"], json!([note]));
    assert_eq!(dispatch(&st, "session.queue.list", json!({"sessionId": "an-queue"})).await.unwrap()["items"][0]["annotations"], json!([note]));
    // A note on a message that is not in the conversation is refused when queued, not later.
    let refused = dispatch(&st, "session.queue.add", json!({"sessionId": "an-queue", "text": "x", "annotations": [{"messageId": "missing", "quote": "q", "note": "n"}]})).await.unwrap_err();
    assert_eq!(refused.1.code, "invalid_argument");
    // Notes alone are a message.
    dispatch(&st, "session.queue.add", json!({"sessionId": "an-queue", "text": "", "annotations": [note]})).await.unwrap();
    // The turn ends and the queue delivers it.
    st.active_turns.lock().await.remove("an-queue");
    st.db.update_session_state("an-queue", "idle").unwrap();
    tx.send(AgentEvent::TurnCompleted).await.unwrap();
    assert!(wait_for(|| !adapter.texts().is_empty()).await);
    let delivered = adapter.texts()[0].clone();
    assert_eq!(delivered, "The owner marked parts of your earlier reply:\n\n1. On this part:\n> A reply\nNote: Say more\n\nQueued words");
    let messages = st.db.session_detail("an-queue").unwrap()["messages"].as_array().unwrap().clone();
    let user = messages.iter().find(|m| m["role"] == "user").unwrap();
    assert_eq!(user["content"], "Queued words");
    assert_eq!(user["meta"]["annotations"], json!([note]));
}

// ── 5. Create a new project ──────────────────────────────────────────────

/// The GitHub CLI replaced by a script on a path the test controls. It records its arguments, answers
/// `--version` and `api`, creates "repositories", files "issues" and can be told to fail.
struct GhStub {
    dir: PathBuf,
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

impl GhStub {
    async fn install() -> Self {
        let guard = crate::scaffold::GH_TEST_LOCK.lock().await;
        let dir = p1b_dir("gh");
        #[cfg(windows)]
        let (file, script) = ("gh.cmd", [
            "@echo off",
            "echo %* >> \"%~dp0calls.txt\"",
            "if \"%1\"==\"--version\" (echo gh version 2.0.0& exit /b 0)",
            "if \"%1\"==\"api\" (echo stub-login& exit /b 0)",
            "if exist \"%~dp0fail.flag\" (echo gh: boom token=abc123def456ghi 1>&2& exit /b 1)",
            "if \"%1\"==\"repo\" (echo https://github.com/stub-login/created& exit /b 0)",
            "if \"%1\"==\"issue\" (findstr \"^\" > \"%~dp0stdin.txt\"& echo https://github.com/sico-vibes/bloblex/issues/7& exit /b 0)",
            "exit /b 2",
        ].join("\r\n"));
        #[cfg(unix)]
        let (file, script) = ("gh", [
            "#!/bin/sh",
            "d=$(dirname \"$0\")",
            "echo \"$@\" >> \"$d/calls.txt\"",
            "case \"$1\" in --version) echo gh version 2.0.0; exit 0;; api) echo stub-login; exit 0;; esac",
            "if [ -e \"$d/fail.flag\" ]; then echo 'gh: boom token=abc123def456ghi' >&2; exit 1; fi",
            "case \"$1\" in repo) echo https://github.com/stub-login/created; exit 0;; issue) cat > \"$d/stdin.txt\"; echo https://github.com/sico-vibes/bloblex/issues/7; exit 0;; esac",
            "exit 2",
        ].join("\n"));
        std::fs::write(dir.join(file), script).unwrap();
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(dir.join(file), std::fs::Permissions::from_mode(0o755)).unwrap(); }
        *crate::scaffold::GH_STUB.lock().unwrap() = Some(dir.join(file));
        Self { dir, _guard: guard }
    }
    /// No GitHub CLI at all.
    async fn absent() -> Self {
        let guard = crate::scaffold::GH_TEST_LOCK.lock().await;
        let dir = p1b_dir("no-gh");
        *crate::scaffold::GH_STUB.lock().unwrap() = Some(dir.join("no-such-gh"));
        Self { dir, _guard: guard }
    }
    fn fail(&self) { std::fs::write(self.dir.join("fail.flag"), "x").unwrap(); }
    fn calls(&self) -> String { std::fs::read_to_string(self.dir.join("calls.txt")).unwrap_or_default() }
    fn stdin(&self) -> String { std::fs::read_to_string(self.dir.join("stdin.txt")).unwrap_or_default() }
}

impl Drop for GhStub {
    fn drop(&mut self) { *crate::scaffold::GH_STUB.lock().unwrap() = None; }
}

fn p1b_steps(result: &Value) -> Vec<(String, String)> {
    result["steps"].as_array().unwrap().iter().map(|step| (step["id"].as_str().unwrap().to_owned(), step["status"].as_str().unwrap().to_owned())).collect()
}

fn p1b_step_names(spec: &[(&str, &str)]) -> Vec<(String, String)> {
    spec.iter().map(|(id, status)| ((*id).to_owned(), (*status).to_owned())).collect()
}

#[tokio::test]
async fn scaffold_needs_confirm_and_a_valid_name() {
    let (st, _data) = p1b_team().await;
    let parent = p1b_dir("scaffold-parent");
    let base = json!({"name": "Fine", "parentPath": parent, "git": false, "confirm": true});
    let mut without = base.clone();
    without["confirm"] = json!(false);
    let refused = dispatch(&st, "project.scaffold", without).await.unwrap_err();
    assert_eq!((refused.1.code.as_str(), refused.1.message.as_str()), ("invalid_argument", "Confirm creating the project first."));
    let mut missing = base.clone();
    missing.as_object_mut().unwrap().remove("confirm");
    assert_eq!(dispatch(&st, "project.scaffold", missing).await.unwrap_err().1.message, "Confirm creating the project first.");
    for name in ["", "a/b", "a\\b", "what?", "dot.", "trailing ", "CON", "nul.txt", "x:y", &"x".repeat(81)] {
        let mut bad = base.clone();
        bad["name"] = json!(name);
        assert_eq!(dispatch(&st, "project.scaffold", bad).await.unwrap_err().1.code, "invalid_argument", "{name}");
    }
    let mut elsewhere = base.clone();
    elsewhere["parentPath"] = json!(parent.join("not-a-folder"));
    assert_eq!(dispatch(&st, "project.scaffold", elsewhere).await.unwrap_err().1.code, "invalid_argument");
    let mut relative = base.clone();
    relative["parentPath"] = json!("relative/folder");
    assert_eq!(dispatch(&st, "project.scaffold", relative).await.unwrap_err().1.code, "invalid_argument");
    assert!(std::fs::read_dir(&parent).unwrap().next().is_none(), "nothing was created");
    assert!(st.db.project_list().unwrap().is_empty());
    // Status reports git and (stubbed) gh.
    let _gh = GhStub::install().await;
    let status = dispatch(&st, "project.scaffold.status", json!({})).await.unwrap();
    assert_eq!(status["git"], true);
    assert_eq!(status["gh"], json!({"available": true, "login": "stub-login"}));
}

#[tokio::test]
async fn scaffold_refuses_a_folder_with_files() {
    let (st, _data) = p1b_team().await;
    let parent = p1b_dir("scaffold-busy");
    std::fs::create_dir_all(parent.join("Busy")).unwrap();
    std::fs::write(parent.join("Busy").join("keep.txt"), "mine").unwrap();
    let refused = dispatch(&st, "project.scaffold", json!({"name": "Busy", "parentPath": parent, "git": false, "confirm": true})).await.unwrap_err();
    assert_eq!((refused.1.code.as_str(), refused.1.message.as_str()), ("conflict", "That folder already exists and isn't empty."));
    assert_eq!(std::fs::read_to_string(parent.join("Busy").join("keep.txt")).unwrap(), "mine");
    assert!(st.db.project_list().unwrap().is_empty());
    // A file with that name is just as much in the way.
    std::fs::write(parent.join("File"), "x").unwrap();
    assert_eq!(dispatch(&st, "project.scaffold", json!({"name": "File", "parentPath": parent, "git": false, "confirm": true})).await.unwrap_err().1.code, "conflict");
    // An empty folder that already exists is fine.
    std::fs::create_dir_all(parent.join("Empty")).unwrap();
    let made = dispatch(&st, "project.scaffold", json!({"name": "Empty", "parentPath": parent, "git": false, "confirm": true})).await.unwrap();
    assert_eq!(made["project"]["name"], "Empty");
}

#[tokio::test]
async fn scaffold_creates_folder_project_and_first_commit() {
    p1b_git_identity();
    let (st, _data) = p1b_team().await;
    let gh = GhStub::install().await;
    let parent = p1b_dir("scaffold-full");
    let made = dispatch(&st, "project.scaffold", json!({"name": "My app", "parentPath": parent, "git": true, "github": {"visibility": "private"}, "confirm": true})).await.unwrap();
    assert_eq!(p1b_steps(&made), p1b_step_names(&[("folder", "done"), ("project", "done"), ("git_init", "done"), ("first_commit", "done"), ("github", "done")]), "{made}");
    for step in made["steps"].as_array().unwrap() { assert!(step["detail"].is_null(), "{step}"); }
    assert_eq!(made["githubUrl"], "https://github.com/stub-login/created");
    let folder = parent.join("My app");
    assert_eq!(std::fs::read_to_string(folder.join("README.md")).unwrap().trim(), "# My app");
    assert!(folder.join(".git").is_dir());
    let log = std::process::Command::new("git").current_dir(&folder).args(["log", "--format=%s"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&log.stdout).trim(), "Initial commit");
    let branch = std::process::Command::new("git").current_dir(&folder).args(["rev-parse", "--abbrev-ref", "HEAD"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&branch.stdout).trim(), "main");
    assert_eq!(made["project"]["name"], "My app");
    assert_eq!(dispatch(&st, "project.list", json!({})).await.unwrap()["projects"][0]["id"], made["project"]["id"]);
    let calls = gh.calls();
    assert!(calls.contains("repo create My-app --private --source . --remote origin --push"), "{calls}");
    // Public is asked for as public.
    let public = dispatch(&st, "project.scaffold", json!({"name": "Open", "parentPath": parent, "git": true, "github": {"visibility": "public"}, "confirm": true})).await.unwrap();
    assert_eq!(public["steps"][4]["status"], "done");
    assert!(gh.calls().contains("repo create Open --public"), "{}", gh.calls());
}

#[tokio::test]
async fn scaffold_without_git_only_makes_folder_and_project() {
    let (st, _data) = p1b_team().await;
    let parent = p1b_dir("scaffold-plain");
    let made = dispatch(&st, "project.scaffold", json!({"name": "Plain", "parentPath": parent, "git": false, "confirm": true})).await.unwrap();
    assert_eq!(p1b_steps(&made), p1b_step_names(&[("folder", "done"), ("project", "done"), ("git_init", "skipped"), ("first_commit", "skipped"), ("github", "skipped")]));
    assert!(parent.join("Plain").is_dir());
    assert!(!parent.join("Plain").join(".git").exists());
    assert!(std::fs::read_dir(parent.join("Plain")).unwrap().next().is_none(), "no README without git");
    assert!(made["githubUrl"].is_null());
    assert_eq!(made["project"]["name"], "Plain");
}

#[tokio::test]
async fn scaffold_keeps_the_project_when_github_fails() {
    p1b_git_identity();
    let (st, _data) = p1b_team().await;
    let gh = GhStub::install().await;
    gh.fail();
    let parent = p1b_dir("scaffold-fail");
    let made = dispatch(&st, "project.scaffold", json!({"name": "Kept", "parentPath": parent, "git": true, "github": {"visibility": "private"}, "confirm": true})).await.unwrap();
    assert_eq!(p1b_steps(&made), p1b_step_names(&[("folder", "done"), ("project", "done"), ("git_init", "done"), ("first_commit", "done"), ("github", "failed")]), "{made}");
    let detail = made["steps"][4]["detail"].as_str().unwrap();
    assert!(detail.contains("boom") && !detail.contains("abc123def456ghi"), "a one-line reason with the token redacted: {detail}");
    assert!(!detail.contains('\n'));
    assert!(made["githubUrl"].is_null());
    assert_eq!(made["project"]["name"], "Kept", "the project stays");
    assert_eq!(st.db.project_list().unwrap().len(), 1);
    // Without the GitHub CLI the step fails with a plain sentence and the rest is untouched.
    drop(gh);
    let _none = GhStub::absent().await;
    let again = dispatch(&st, "project.scaffold", json!({"name": "Kept two", "parentPath": parent, "git": true, "github": {"visibility": "public"}, "confirm": true})).await.unwrap();
    assert_eq!(again["steps"][3]["status"], "done");
    assert_eq!(again["steps"][4]["status"], "failed");
    assert_eq!(again["steps"][4]["detail"], "The GitHub CLI could not be started. Is it installed?");
    // A failing step makes the later ones report skipped.
    let blocker = parent.join("Blocked");
    std::fs::create_dir_all(&blocker).unwrap();
    let missing_parent = dispatch(&st, "project.scaffold", json!({"name": "Child", "parentPath": blocker, "git": true, "confirm": true})).await.unwrap();
    assert_eq!(missing_parent["steps"][0]["status"], "done");
}

#[tokio::test]
async fn scaffold_needs_git_for_github_and_a_visibility() {
    let (st, _data) = p1b_team().await;
    let parent = p1b_dir("scaffold-args");
    let attempt = |git: bool, github: Value| { let (st, parent) = (st.clone(), parent.clone()); async move { dispatch(&st, "project.scaffold", json!({"name": "Args", "parentPath": parent, "git": git, "github": github, "confirm": true})).await } };
    assert_eq!(attempt(false, json!({"visibility": "private"})).await.unwrap_err().1.code, "invalid_argument", "github needs git");
    for github in [json!({}), json!({"visibility": "internal"}), json!({"visibility": Value::Null}), json!({"visibility": true}), json!("private"), json!(true)] {
        let error = attempt(true, github.clone()).await.unwrap_err();
        assert_eq!(error.1.code, "invalid_argument", "{github}");
    }
    assert!(std::fs::read_dir(&parent).unwrap().next().is_none(), "a refused call creates nothing");
    assert!(st.db.project_list().unwrap().is_empty());
    // An explicit null is no GitHub.
    let none = attempt(true, Value::Null).await;
    p1b_git_identity();
    let none = none.unwrap();
    assert_eq!(none["steps"][4]["status"], "skipped");
}

// ── 6. Report a problem ──────────────────────────────────────────────────

#[tokio::test]
async fn issue_draft_has_only_the_listed_sections_and_no_secret_or_home_path() {
    let (st, _data) = p1b_team().await;
    let _gh = GhStub::absent().await;
    *st.runtimes.write().await = vec![json!({"id": "rt-test", "provider": "codex", "version": "1.2.3 token=supersecretvalue123456", "status": "online", "executablePath": "unused-test-runtime", "launchArgs": []})];
    let draft = dispatch(&st, "diagnostics.issueDraft", json!({})).await.unwrap();
    assert_eq!(draft["repo"], "sico-vibes/bloblex");
    assert_eq!(draft["title"], "");
    assert_eq!(draft["gh"], json!({"available": false, "login": Value::Null}));
    let body = draft["body"].as_str().unwrap();
    let headings: Vec<&str> = body.lines().filter(|line| line.starts_with("## ")).collect();
    assert_eq!(headings, ["## What happened", "## Version", "## Coding agents", "## Health check"]);
    assert!(body.contains(env!("CARGO_PKG_VERSION")));
    assert!(body.contains("codex 1.2.3"), "{body}");
    assert!(!body.contains("supersecretvalue123456"), "secrets are redacted: {body}");
    let what_happened = body.split("## Version").next().unwrap();
    assert_eq!(what_happened.trim(), "## What happened", "that section is left for the owner");
    for home in [std::env::var("USERPROFILE").ok(), std::env::var("HOME").ok()].into_iter().flatten().filter(|home| home.len() > 3) {
        assert!(!body.to_lowercase().contains(&home.to_lowercase().replace('\\', "/")) && !body.to_lowercase().contains(&home.to_lowercase()), "the home folder is hidden: {body}");
    }
    assert!(draft["url"].as_str().unwrap().starts_with("https://github.com/sico-vibes/bloblex/issues/new?title=&body="));
    // The home folder becomes ~ in either slash style, in any case.
    let homes = vec!["C:\\Users\\Someone".to_owned(), "C:/Users/Someone".to_owned()];
    assert_eq!(crate::issue_report::clean_with("at C:\\Users\\Someone\\app and c:/users/someone/x", &homes), "at ~\\app and ~/x");
    assert!(crate::issue_report::clean_with("password: hunter2", &homes).contains("[redacted]"));
}

#[test]
fn issue_url_is_encoded_and_bounded() {
    let body = format!("## What happened\n\n{}", "é & #".repeat(5000));
    let url = crate::issue_report::new_issue_url("A title: with spaces & more?", &body);
    assert!(url.starts_with("https://github.com/sico-vibes/bloblex/issues/new?title=A%20title%3A%20with%20spaces%20%26%20more%3F&body=%23%23%20What%20happened%0A%0A"), "{url}");
    assert!(!url.contains(' ') && !url.contains('\n') && url.matches('&').count() == 1 && url.matches('?').count() == 1, "only the separators are raw");
    let encoded_body = url.split("&body=").nth(1).unwrap();
    // 6000 characters of source: the heading and two newlines, then the repeated unit cut where the limit falls.
    let source_chars = "## What happened\n\n".chars().count();
    let unit = "é & #";
    let kept_units = (6000 - source_chars) / unit.chars().count();
    assert!(encoded_body.matches("%C3%A9").count() >= kept_units && encoded_body.matches("%C3%A9").count() <= kept_units + 1);
    assert!(url.len() < 6000 * 9 + 200, "the address is bounded: {}", url.len());
}

#[tokio::test]
async fn issue_post_needs_confirm_and_redacts_again() {
    let (st, _data) = p1b_team().await;
    let gh = GhStub::install().await;
    let base = json!({"title": "Crash on start", "body": "It crashed. password: hunter2 and token=abcdef0123456789abcdef", "confirm": true});
    let mut unconfirmed = base.clone();
    unconfirmed["confirm"] = json!(false);
    assert_eq!(dispatch(&st, "diagnostics.issuePost", unconfirmed).await.unwrap_err().1.code, "invalid_argument");
    for title in [json!(""), json!("   "), json!("t".repeat(201)), Value::Null] {
        let mut bad = base.clone();
        bad["title"] = title;
        assert_eq!(dispatch(&st, "diagnostics.issuePost", bad).await.unwrap_err().1.code, "invalid_argument");
    }
    let mut long = base.clone();
    long["body"] = json!("b".repeat(60_001));
    assert_eq!(dispatch(&st, "diagnostics.issuePost", long).await.unwrap_err().1.code, "invalid_argument");
    assert!(gh.calls().is_empty(), "nothing was sent for a refused call: {}", gh.calls());
    let posted = dispatch(&st, "diagnostics.issuePost", base).await.unwrap();
    assert_eq!(posted["url"], "https://github.com/sico-vibes/bloblex/issues/7");
    let calls = gh.calls();
    assert!(calls.contains("issue create --repo sico-vibes/bloblex --title \"Crash on start\" --body-file -"), "{calls}");
    let sent = gh.stdin();
    assert!(sent.contains("It crashed."), "{sent}");
    assert!(!sent.contains("hunter2") && !sent.contains("abcdef0123456789abcdef"), "redacted again before it left: {sent}");
}

#[tokio::test]
async fn issue_post_without_gh_says_how_to_continue() {
    let (st, _data) = p1b_team().await;
    let _gh = GhStub::absent().await;
    let error = dispatch(&st, "diagnostics.issuePost", json!({"title": "Hello", "body": "World", "confirm": true})).await.unwrap_err();
    assert_eq!((error.1.code.as_str(), error.1.message.as_str()), ("unsupported", "Install and sign in to the GitHub CLI, or open the issue in your browser."));
}

#[tokio::test]
async fn stash_restore_failure_keeps_the_item() {
    let (st, data) = p1b_team().await;
    let first = p1b_png(&data, "a.png");
    let second = p1b_png(&data, "b.png");
    let added = dispatch(&st, "stash.add", json!({"text": "Keep me", "attachments": [{"path": first}, {"path": second}]})).await.unwrap()["item"].clone();
    let id = added["id"].as_str().unwrap();
    let files: Vec<String> = added["attachments"].as_array().unwrap().iter().map(|image| image["file"].as_str().unwrap().to_owned()).collect();
    let folder = data.join("stash").join(id);
    std::fs::remove_file(folder.join(&files[1])).unwrap();
    let error = dispatch(&st, "stash.restore", json!({"id": id})).await.unwrap_err();
    assert_eq!(error.1.code, "not_found");
    let listed = dispatch(&st, "stash.list", json!({})).await.unwrap()["items"].clone();
    assert_eq!(listed[0]["attachments"].as_array().unwrap().len(), 2, "the row still lists both");
    assert!(folder.join(&files[0]).is_file(), "the remaining image is still in the stash");
    let restored = data.join("stash-restored");
    assert!(!restored.exists() || std::fs::read_dir(&restored).unwrap().next().is_none(), "no half-made target is left");
}

#[tokio::test]
async fn fanout_waits_for_a_slot_at_the_concurrency_limit() {
    let (mut st, _data) = p1b_team().await;
    let hold = Arc::new(QueueAdapter::default());
    install_queue_adapter(&mut st, &hold);
    st.db.set_setting("concurrency.botsAtOnce", &json!(1)).unwrap();
    let bots = ["Slot one", "Slot two"].map(|name| new_agent(&st, name));
    let started = dispatch(&st, "fanout.start", json!({"agentIds": bots, "text": "Wait for me", "worktrees": false})).await.unwrap()["fanout"].clone();
    let rows = started["rows"].as_array().unwrap();
    assert!(rows.iter().all(|row| row["sessionId"].is_string() && row["error"].is_null()), "{started}");
    let waiting = rows[1]["sessionId"].as_str().unwrap();
    let items = st.db.queue_list(waiting).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!((items[0]["kind"].as_str(), items[0]["text"].as_str(), items[0]["status"].as_str()), (Some("send_later"), Some("Wait for me"), Some("queued")));
    // The slot is still taken when the item comes due: it stays queued, and the queue is not paused.
    st.db.queue_set_due(items[0]["id"].as_str().unwrap(), &past_due_at(2)).unwrap();
    crate::queue::due_tick(&st).await;
    let after = st.db.queue_list(waiting).unwrap();
    assert_eq!((after.len(), after[0]["status"].as_str(), after[0]["error"].is_null()), (1, Some("queued"), true), "{after:?}");
    assert!(!st.queue.is_paused(waiting));
    assert!(wait_for(|| hold.texts().len() == 1).await, "the first bot is sent the message");
    assert_eq!(hold.texts().len(), 1, "and only the first");
    // Once a slot is free, it goes (the limit is raised here, as a finished turn would free one).
    st.db.set_setting("concurrency.botsAtOnce", &json!(2)).unwrap();
    crate::queue::due_tick(&st).await;
    assert!(wait_for(|| hold.texts().len() == 2).await);
}
