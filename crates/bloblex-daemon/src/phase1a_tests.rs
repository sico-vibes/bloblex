// Phase 1A (bots across projects). Included into `phase2a_tests` so it shares
// that module's fixtures: `state`, `online_team_state`, `TeamAdapter`, `call_tool`,
// `permission_fixture` and the rule helpers.

fn project_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bitbots-1a-{label}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("README.md"), "safe").unwrap();
    dir.canonicalize().unwrap()
}

/// A project registered with a real folder: its id and its folder.
fn real_project(st: &AppState, name: &str) -> (String, PathBuf) {
    let dir = project_dir(name);
    let project = st.db.project_create(name, Some(&dir.to_string_lossy())).unwrap().0;
    (project["id"].as_str().unwrap().to_owned(), PathBuf::from(project["path"].as_str().unwrap()))
}

fn new_agent(st: &AppState, name: &str) -> String {
    st.db.agent_create(&json!({"name":name,"runtimeId":"rt-test"})).unwrap().0["id"].as_str().unwrap().to_owned()
}

async fn open_in(st: &AppState, agent: &str, project: &str) -> Value {
    dispatch(st, "agent.conversation.create", json!({"agentId":agent,"projectId":project})).await.unwrap()["session"].clone()
}

#[tokio::test]
async fn a_conversation_opens_in_the_project_it_picks() {
    let (st, _) = online_team_state().await;
    *st.team.data_dir.lock().unwrap() = Some(std::env::temp_dir().join(format!("bitbots-1a-data-{}", Uuid::new_v4())));
    let (alpha_id, alpha_dir) = real_project(&st, "Alpha");
    let (beta_id, beta_dir) = real_project(&st, "Beta");
    let agent = new_agent(&st, "Roamer");
    dispatch(&st, "agent.team.update", json!({"agentId":agent,"projectId":alpha_id})).await.unwrap();

    let session = open_in(&st, &agent, &beta_id).await;
    assert_eq!(session["projectId"], beta_id.as_str(), "{session}");
    assert_eq!(session["projectName"], "Beta");
    assert_eq!(PathBuf::from(session["projectPath"].as_str().unwrap()), beta_dir, "the folder is the picked project's, not the bot's default");
    assert_ne!(PathBuf::from(session["projectPath"].as_str().unwrap()), alpha_dir);
    // The conversation list and the snapshot carry the project too.
    let listed = dispatch(&st, "agent.conversations", json!({"agentId":agent})).await.unwrap();
    assert_eq!(listed["conversations"][0]["projectId"], beta_id.as_str());
    assert_eq!(listed["conversations"][0]["projectName"], "Beta");
    let snapshot = st.db.snapshot().unwrap();
    let in_snapshot = snapshot["sessions"].as_array().unwrap().iter().find(|row| row["id"] == session["id"]).unwrap().clone();
    assert_eq!((in_snapshot["projectId"].as_str(), in_snapshot["projectName"].as_str()), (Some(beta_id.as_str()), Some("Beta")));
    assert_eq!(st.db.session_event_summary(session["id"].as_str().unwrap()).unwrap()["projectName"], "Beta");

    // session.new takes the same parameter.
    let direct = dispatch(&st, "session.new", json!({"agentId":agent,"projectId":alpha_id,"lazy":true})).await.unwrap();
    assert_eq!(st.db.session_detail(direct["id"].as_str().unwrap()).unwrap()["projectName"], "Alpha");

    // A project that does not exist, or has no folder, is refused.
    let missing = dispatch(&st, "agent.conversation.create", json!({"agentId":agent,"projectId":"nope"})).await.unwrap_err();
    assert_eq!(missing.1.code, "not_found");
    let folderless = st.db.project_create("Nowhere", None).unwrap().0;
    let refused = dispatch(&st, "agent.conversation.create", json!({"agentId":agent,"projectId":folderless["id"]})).await.unwrap_err();
    assert_eq!(refused.1.code, "invalid_argument");
    assert_eq!(refused.1.message, "That project has no folder on this computer.");
}

#[tokio::test]
async fn a_new_conversation_defaults_to_the_bots_last_project() {
    let (st, _) = online_team_state().await;
    *st.team.data_dir.lock().unwrap() = Some(std::env::temp_dir().join(format!("bitbots-1a-data-{}", Uuid::new_v4())));
    let (alpha_id, _) = real_project(&st, "Alpha");
    let (beta_id, _) = real_project(&st, "Beta");
    let agent = new_agent(&st, "Remember");
    // No conversation and no default: the bot's private workspace.
    let first = dispatch(&st, "agent.conversation.create", json!({"agentId":agent})).await.unwrap()["session"].clone();
    assert!(first["projectId"].is_null(), "{first}");
    assert!(st.db.agent_get(&agent).unwrap()["lastProjectId"].is_null());
    // With a default and no history, the default.
    dispatch(&st, "agent.team.update", json!({"agentId":agent,"projectId":alpha_id})).await.unwrap();
    let agent2 = new_agent(&st, "Defaulted");
    dispatch(&st, "agent.team.update", json!({"agentId":agent2,"projectId":alpha_id})).await.unwrap();
    let from_default = dispatch(&st, "agent.conversation.create", json!({"agentId":agent2})).await.unwrap()["session"].clone();
    assert_eq!(from_default["projectId"], alpha_id.as_str());
    // After a conversation in Beta, new ones open in Beta, not the default.
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    let in_beta = open_in(&st, &agent2, &beta_id).await;
    assert_eq!(st.db.agent_get(&agent2).unwrap()["lastProjectId"], beta_id.as_str(), "the agent DTO says where it last worked");
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    let next = dispatch(&st, "agent.conversation.create", json!({"agentId":agent2})).await.unwrap()["session"].clone();
    assert_eq!(next["projectId"], beta_id.as_str(), "{next}");
    assert_eq!(st.db.agent_get(&agent2).unwrap()["projectId"], alpha_id.as_str(), "the default is untouched");
    // Archiving the Beta conversations sends the bot back to its default.
    for id in [in_beta["id"].as_str().unwrap(), next["id"].as_str().unwrap()] { st.db.session_archive(id, true).unwrap(); }
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    let back = dispatch(&st, "agent.conversation.create", json!({"agentId":agent2})).await.unwrap()["session"].clone();
    assert_eq!(back["projectId"], alpha_id.as_str(), "{back}");
}

#[tokio::test]
async fn agent_projects_lists_every_project_a_bot_has_worked_in() {
    let (st, _) = online_team_state().await;
    *st.team.data_dir.lock().unwrap() = Some(std::env::temp_dir().join(format!("bitbots-1a-data-{}", Uuid::new_v4())));
    let (alpha_id, alpha_dir) = real_project(&st, "Alpha");
    let (beta_id, _) = real_project(&st, "Beta");
    let (gamma_id, _) = real_project(&st, "Gamma");
    std::fs::create_dir_all(alpha_dir.join(".git")).unwrap();
    let agent = new_agent(&st, "Traveller");
    dispatch(&st, "agent.team.update", json!({"agentId":agent,"projectId":gamma_id})).await.unwrap();
    open_in(&st, &agent, &alpha_id).await;
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    let archived = open_in(&st, &agent, &beta_id).await;
    open_in(&st, &agent, &beta_id).await;
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    // A conversation in the private workspace.
    let private = dispatch(&st, "session.new", json!({"agentId":agent,"projectPath":crate::team::private_workspace(&st, &st.db.agent_get(&agent).unwrap()),"lazy":true})).await.unwrap();
    st.db.merge_session_data(private["id"].as_str().unwrap(), &json!({"projectId":null})).unwrap();
    // An archived conversation does not count.
    st.db.session_archive(archived["id"].as_str().unwrap(), true).unwrap();

    let listed = dispatch(&st, "agent.projects", json!({"agentId":agent})).await.unwrap();
    let projects = listed["projects"].as_array().unwrap();
    let names: Vec<&str> = projects.iter().map(|project| project["name"].as_str().unwrap()).collect();
    assert_eq!(projects.len(), 4, "{names:?}");
    // Most recent activity first; the default project with no conversations sorts last.
    assert_eq!(names.first(), Some(&"No project"), "{names:?}");
    assert_eq!(names.last(), Some(&"Gamma"), "{names:?}");
    let by_name = |name: &str| projects.iter().find(|project| project["name"] == name).unwrap();
    assert_eq!(by_name("Beta")["conversationCount"], 1, "the archived one is not counted");
    assert_eq!(by_name("Alpha")["conversationCount"], 1);
    assert_eq!(by_name("Gamma")["conversationCount"], 0);
    assert_eq!(by_name("Gamma")["isDefault"], true);
    assert_eq!(by_name("Alpha")["isDefault"], false);
    assert_eq!(by_name("Alpha")["isGitRepo"], true);
    assert_eq!(by_name("Beta")["isGitRepo"], false);
    assert!(by_name("Gamma")["lastActivityAt"].is_null());
    assert!(by_name("Alpha")["lastActivityAt"].as_str().is_some());
    assert!(by_name("Alpha")["path"].as_str().is_some());
    let none = by_name("No project");
    assert!(none["id"].is_null() && none["path"].is_null() && none["conversationCount"] == 1, "{none}");
    assert_eq!(dispatch(&st, "agent.projects", json!({"agentId":Uuid::new_v4().to_string()})).await.unwrap_err().1.code, "not_found");
}

#[tokio::test]
async fn the_project_section_comes_from_the_conversation_not_the_bot() {
    let (st, _) = online_team_state().await;
    *st.team.data_dir.lock().unwrap() = Some(std::env::temp_dir().join(format!("bitbots-1a-data-{}", Uuid::new_v4())));
    let (alpha_id, _) = real_project(&st, "Alpha");
    let (beta_id, beta_dir) = real_project(&st, "Beta");
    dispatch(&st, "project.update", json!({"projectId":beta_id,"description":"The billing service.","tags":["billing"]})).await.unwrap();
    let agent_id = new_agent(&st, "Mixer");
    dispatch(&st, "agent.team.update", json!({"agentId":agent_id,"projectId":alpha_id})).await.unwrap();
    let agent = st.db.agent_get(&agent_id).unwrap();

    // The repository's own rules ride along, capped; the bot's default is not used.
    std::fs::write(beta_dir.join(".bitbots.json"), json!({"instructions": format!("Run cargo fmt. {}", "x".repeat(5000))}).to_string()).unwrap();
    let mut options = ExecOptions::default();
    team::attach(&st, "section", Some(&agent_id), &json!({"kind":"main"}), Some(&beta_dir), Some(&beta_id), &mut options);
    let text = options.instructions.unwrap();
    assert!(text.contains("You work in the project \"Beta\""), "{text}");
    assert!(text.contains(&beta_dir.display().to_string()));
    assert!(text.contains("The billing service.") && text.contains("billing"));
    assert!(text.contains("Run cargo fmt."));
    assert!(!text.contains("\"Alpha\""), "the bot's default project never leaks in");
    let capped = team::project_instructions_file(&beta_dir).unwrap();
    assert_eq!(capped.chars().count(), 4_000, "the file's instructions are capped at 4,000 characters");

    // Invalid JSON, a missing key and a non-string value are all ignored.
    for body in ["not json {", "{\"other\":1}", "{\"instructions\":42}", "{\"instructions\":\"  \"}"] {
        std::fs::write(beta_dir.join(".bitbots.json"), body).unwrap();
        assert!(team::project_instructions_file(&beta_dir).is_none(), "{body}");
    }
    let mut ignored = ExecOptions::default();
    team::attach(&st, "section2", Some(&agent_id), &json!({"kind":"main"}), Some(&beta_dir), Some(&beta_id), &mut ignored);
    assert!(ignored.instructions.unwrap().contains("You work in the project \"Beta\""), "a bad file still leaves the project section");

    // No project: the private workspace text, whatever the bot's default is.
    let mut casual = ExecOptions::default();
    team::attach(&st, "section3", Some(&agent_id), &json!({"kind":"main"}), Some(&project_dir("scratch")), None, &mut casual);
    let casual = casual.instructions.unwrap();
    assert!(casual.contains("not tied to a project") && !casual.contains("\"Alpha\""), "{casual}");
    // The older entry point still describes the bot's own default.
    assert!(team::runtime_instructions(&st, &agent, &json!({"kind":"main"}), Path::new(".")).contains("\"Alpha\""));

}

#[tokio::test]
async fn the_provider_gets_the_conversations_project_section() {
    let (st, adapter) = online_team_state().await;
    *st.team.data_dir.lock().unwrap() = Some(std::env::temp_dir().join(format!("bitbots-1a-data-{}", Uuid::new_v4())));
    let (alpha_id, _) = real_project(&st, "Alpha");
    let (beta_id, beta_dir) = real_project(&st, "Beta");
    std::fs::write(beta_dir.join(".bitbots.json"), json!({"instructions":"Use tabs."}).to_string()).unwrap();
    let agent = new_agent(&st, "Mixer");
    dispatch(&st, "agent.team.update", json!({"agentId":agent,"projectId":alpha_id})).await.unwrap();
    let session = dispatch(&st, "session.new", json!({"agentId":agent,"projectId":beta_id})).await.unwrap();
    let launched = adapter.instructions.lock().unwrap().get(session["id"].as_str().unwrap()).cloned().expect("the provider was started");
    assert!(launched.contains("You work in the project \"Beta\"") && launched.contains("Use tabs."), "{launched}");
    assert!(!launched.contains("\"Alpha\""));
}

#[tokio::test]
async fn project_memory_stays_in_its_project() {
    let (st, _) = online_team_state().await;
    *st.team.data_dir.lock().unwrap() = Some(std::env::temp_dir().join(format!("bitbots-1a-data-{}", Uuid::new_v4())));
    st.db.set_setting("experimental.memory", &json!(true)).unwrap();
    st.db.set_setting("memory.sharedAgentWrites", &json!(true)).unwrap();
    let (alpha_id, _) = real_project(&st, "Alpha");
    let (beta_id, _) = real_project(&st, "Beta");
    let agent = new_agent(&st, "Rememberer");
    dispatch(&st, "agent.team.update", json!({"agentId":agent,"projectId":alpha_id})).await.unwrap();
    let in_alpha = open_in(&st, &agent, &alpha_id).await["id"].as_str().unwrap().to_owned();
    let in_beta = open_in(&st, &agent, &beta_id).await["id"].as_str().unwrap().to_owned();
    st.db.memory_create(&json!({"scope":"project","scopeId":alpha_id,"kind":"fact","title":"Alpha deploys on Friday","body":"Alpha ships every Friday.","origin":"user"})).unwrap();
    st.db.memory_create(&json!({"scope":"project","scopeId":beta_id,"kind":"fact","title":"Beta uses Postgres","body":"Beta stores data in Postgres.","origin":"user"})).unwrap();
    st.db.memory_create(&json!({"scope":"blob","scopeId":agent,"kind":"preference","title":"Short answers","body":"Keep answers short.","origin":"user"})).unwrap();

    let text = |response: &Value| response["content"][0]["text"].as_str().unwrap_or("").to_owned();
    let alpha_view = text(&call_tool(&st, &in_alpha, "memory_search", json!({"query":"deploys"})).await);
    assert!(alpha_view.contains("Alpha deploys on Friday"), "{alpha_view}");
    let wrong = text(&call_tool(&st, &in_beta, "memory_search", json!({"query":"deploys"})).await);
    assert!(!wrong.contains("Alpha deploys"), "a note tied to one project never appears in another: {wrong}");
    let beta_view = text(&call_tool(&st, &in_beta, "memory_search", json!({"query":"Postgres"})).await);
    assert!(beta_view.contains("Beta uses Postgres"), "{beta_view}");
    // The bot's own notes follow it into every project.
    assert!(text(&call_tool(&st, &in_beta, "memory_search", json!({"query":"Short answers"})).await).contains("Short answers"));
    assert!(text(&call_tool(&st, &in_alpha, "memory_search", json!({"query":"Short answers"})).await).contains("Short answers"));
    // A project note saved from a conversation is tied to that conversation's project, not the bot's default.
    let saved = text(&call_tool(&st, &in_beta, "memory_write", json!({"title":"Beta cron","body":"Beta runs a nightly job.","kind":"fact","scope":"project"})).await);
    assert!(!saved.to_lowercase().contains("not in a project"), "{saved}");
    let record = st.db.memory_list(&json!({})).unwrap().into_iter().find(|row| row["title"] == "Beta cron").expect("the note was saved");
    assert_eq!((record["scope"].as_str(), record["scopeId"].as_str()), (Some("project"), Some(beta_id.as_str())), "{record}");
}

#[tokio::test]
async fn an_always_rule_for_one_project_does_not_apply_in_another() {
    let (mut st, mut events) = state();
    let (alpha_id, alpha_dir) = real_project(&st, "Alpha");
    let (beta_id, beta_dir) = real_project(&st, "Beta");
    let agent = st.db.agent_create(&json!({"name":"Scoped","runtimeId":"rt-test"})).unwrap().0["id"].as_str().unwrap().to_owned();
    let in_alpha = permission_fixture(&mut st, "scope-alpha", &agent, &alpha_dir).await;
    let in_beta = permission_fixture(&mut st, "scope-beta", &agent, &beta_dir).await;
    for (sid, project) in [("scope-alpha", &alpha_id), ("scope-beta", &beta_id)] { st.db.merge_session_data(sid, &json!({"projectId":project})).unwrap(); }

    in_alpha.send(read_request("README.md")).await.unwrap();
    let card = next_rule_event(&mut events, "permission.requested").await;
    assert_eq!((card["projectId"].as_str(), card["projectName"].as_str()), (Some(alpha_id.as_str()), Some("Alpha")), "the card says which project: {card}");
    let snapshot = st.db.snapshot().unwrap();
    let pending = snapshot["permissions"].as_array().unwrap().iter().find(|row| row["id"] == card["id"]).cloned().unwrap();
    assert_eq!(pending["projectName"], "Alpha");
    let replied = dispatch(&st, "permission.reply", json!({"permissionId":card["id"],"choice":"allow","remember":true,"rememberScope":"project"})).await.unwrap();
    assert_eq!(replied["rule"]["projectId"], alpha_id.as_str());
    assert_eq!(replied["rule"]["projectName"], "Alpha");

    // The same request in Alpha is answered by the rule.
    in_alpha.send(read_request("README.md")).await.unwrap();
    let resolved = next_rule_event(&mut events, "permission.auto_resolved").await;
    assert_eq!(resolved["ruleId"], replied["rule"]["id"]);
    // In Beta the same request still asks.
    in_beta.send(read_request("README.md")).await.unwrap();
    let asked = next_rule_event(&mut events, "permission.requested").await;
    assert_eq!(asked["sessionId"], "scope-beta");
    assert_eq!(asked["projectId"], beta_id.as_str());
    // Every rule row always carries the project key.
    let listed = dispatch(&st, "permission.rules.list", json!({"agentId":agent})).await.unwrap();
    assert_eq!((listed["rules"][0]["projectId"].as_str(), listed["rules"][0]["projectName"].as_str()), (Some(alpha_id.as_str()), Some("Alpha")));
}

#[tokio::test]
async fn an_everywhere_rule_applies_in_every_project() {
    let (mut st, mut events) = state();
    let (alpha_id, alpha_dir) = real_project(&st, "Alpha");
    let (beta_id, beta_dir) = real_project(&st, "Beta");
    let agent = st.db.agent_create(&json!({"name":"Everywhere","runtimeId":"rt-test"})).unwrap().0["id"].as_str().unwrap().to_owned();
    let in_alpha = permission_fixture(&mut st, "every-alpha", &agent, &alpha_dir).await;
    let in_beta = permission_fixture(&mut st, "every-beta", &agent, &beta_dir).await;
    for (sid, project) in [("every-alpha", &alpha_id), ("every-beta", &beta_id)] { st.db.merge_session_data(sid, &json!({"projectId":project})).unwrap(); }

    in_alpha.send(read_request("README.md")).await.unwrap();
    let card = next_rule_event(&mut events, "permission.requested").await;
    // An invalid scope is refused before the card is claimed.
    let bad = dispatch(&st, "permission.reply", json!({"permissionId":card["id"],"choice":"allow","remember":true,"rememberScope":"galaxy"})).await.unwrap_err();
    assert_eq!(bad.1.code, "invalid_argument");
    // The default (older clients) is everywhere for this bot.
    let replied = dispatch(&st, "permission.reply", json!({"permissionId":card["id"],"choice":"allow","remember":true})).await.unwrap();
    assert!(replied["rule"]["projectId"].is_null(), "{replied}");
    in_alpha.send(read_request("README.md")).await.unwrap();
    assert_eq!(next_rule_event(&mut events, "permission.auto_resolved").await["ruleId"], replied["rule"]["id"]);
    in_beta.send(read_request("README.md")).await.unwrap();
    let resolved = next_rule_event(&mut events, "permission.auto_resolved").await;
    assert_eq!((resolved["sessionId"].as_str(), &resolved["ruleId"]), (Some("every-beta"), &replied["rule"]["id"]), "{resolved}");
    let listed = dispatch(&st, "permission.rules.list", json!({})).await.unwrap();
    assert!(listed["rules"][0].as_object().unwrap().contains_key("projectId") && listed["rules"][0]["projectId"].is_null());
}

#[tokio::test]
async fn the_rules_rpc_moves_a_rule_between_scopes() {
    let (st, mut events) = state();
    let (alpha_id, _) = real_project(&st, "Alpha");
    let agent = st.db.agent_create(&json!({"name":"Mover","runtimeId":"rt-test"})).unwrap().0["id"].as_str().unwrap().to_owned();
    let rule = st.db.permission_rule_create(&agent, "read", "README.md", "Read `README.md`", None).unwrap();
    let id = rule["id"].as_str().unwrap();
    let moved = dispatch(&st, "permission.rules.update", json!({"id":id,"scope":"project","projectId":alpha_id})).await.unwrap();
    assert_eq!((moved["rule"]["projectId"].as_str(), moved["rule"]["projectName"].as_str()), (Some(alpha_id.as_str()), Some("Alpha")));
    assert_eq!(next_rule_event(&mut events, "permission.rules.changed").await["agentId"], agent.as_str());
    let back = dispatch(&st, "permission.rules.update", json!({"id":id,"scope":"bot"})).await.unwrap();
    assert!(back["rule"]["projectId"].is_null());
    assert_eq!(dispatch(&st, "permission.rules.update", json!({"id":id,"scope":"project"})).await.unwrap_err().1.code, "invalid_argument", "a project scope needs a projectId");
    assert_eq!(dispatch(&st, "permission.rules.update", json!({"id":id,"scope":"planet"})).await.unwrap_err().1.code, "invalid_argument");
    assert_eq!(dispatch(&st, "permission.rules.update", json!({"id":id,"scope":"project","projectId":"nope"})).await.unwrap_err().1.code, "not_found");
    assert_eq!(dispatch(&st, "permission.rules.update", json!({"id":"missing","scope":"bot"})).await.unwrap_err().1.code, "not_found");
}

#[tokio::test]
async fn message_blob_opens_the_side_conversation_in_the_senders_project() {
    let (st, adapter) = online_team_state().await;
    *st.team.data_dir.lock().unwrap() = Some(std::env::temp_dir().join(format!("bitbots-1a-data-{}", Uuid::new_v4())));
    let (alpha_id, alpha_dir) = real_project(&st, "Alpha");
    let (beta_id, beta_dir) = real_project(&st, "Beta");
    let sender = new_agent(&st, "Sender");
    let worker = new_agent(&st, "Worker");
    let main = open_in(&st, &sender, &alpha_id).await["id"].as_str().unwrap().to_owned();

    // No project named: it opens where the sender's conversation is.
    let sent = call_tool(&st, &main, "message_blob", json!({"blob":"Worker","message":"Check the build","topic":"Inherit"})).await;
    assert_ne!(sent["isError"], true, "{sent}");
    let side = st.db.side_session(&worker, &sender).unwrap().unwrap();
    let detail = st.db.session_detail(&side).unwrap();
    assert_eq!((detail["projectId"].as_str(), detail["projectName"].as_str()), (Some(alpha_id.as_str()), Some("Alpha")), "{detail}");
    assert_eq!(PathBuf::from(detail["projectPath"].as_str().unwrap()), alpha_dir);
    wait_for_messages(&st, &side, |m| m.iter().any(|m| m["role"] == "assistant")).await;
    assert!(adapter.instructions.lock().unwrap().get(&side).unwrap().contains("You work in the project \"Alpha\""), "the side conversation's instructions name the sender's project");

    // An explicit project, by exact name or id, wins.
    let named = call_tool(&st, &main, "message_blob", json!({"blob":"Worker","message":"Check beta","topic":"Explicit","project":"Beta"})).await;
    assert_ne!(named["isError"], true, "{named}");
    let by_id = call_tool(&st, &main, "message_blob", json!({"blob":"Worker","message":"Check beta again","topic":"Explicit two","project":beta_id})).await;
    assert_ne!(by_id["isError"], true, "{by_id}");
    let sides = dispatch(&st, "agent.conversations", json!({"agentId":worker,"projectId":beta_id})).await.unwrap();
    assert_eq!(sides["conversations"].as_array().unwrap().len(), 2, "{sides}");
    let beta_side = st.db.session_detail(sides["conversations"][0]["id"].as_str().unwrap()).unwrap();
    assert_eq!(PathBuf::from(beta_side["projectPath"].as_str().unwrap()), beta_dir);
    // A project that does not exist or has no folder is refused with a reason.
    let missing = call_tool(&st, &main, "message_blob", json!({"blob":"Worker","message":"x","topic":"Nope","project":"Nowhere"})).await;
    assert_eq!(missing["isError"], true, "{missing}");
    st.db.project_create("Folderless", None).unwrap();
    let folderless = call_tool(&st, &main, "message_blob", json!({"blob":"Worker","message":"x","topic":"Nope two","project":"Folderless"})).await;
    assert!(folderless["content"][0]["text"].as_str().unwrap().contains("no folder"), "{folderless}");
    // The Manager's instructions say any bot can work in any project.
    let boss = st.db.agent_create(&json!({"name":"Boss","runtimeId":"rt-test","systemRole":"manager"})).unwrap().0;
    let instructions = team::runtime_instructions(&st, &boss, &json!({"kind":"main"}), Path::new("."));
    assert!(instructions.contains("can work in any project"), "{instructions}");
}

#[tokio::test]
async fn an_explicit_null_project_opens_in_the_private_workspace() {
    let (st, adapter) = online_team_state().await;
    *st.team.data_dir.lock().unwrap() = Some(std::env::temp_dir().join(format!("bitbots-1a-data-{}", Uuid::new_v4())));
    st.db.set_setting("experimental.memory", &json!(true)).unwrap();
    let (alpha_id, alpha_dir) = real_project(&st, "Alpha");
    dispatch(&st, "project.update", json!({"projectId":alpha_id,"description":"The Alpha service."})).await.unwrap();
    let agent_id = new_agent(&st, "Defaulted");
    dispatch(&st, "agent.team.update", json!({"agentId":agent_id,"projectId":alpha_id})).await.unwrap();
    let agent = st.db.agent_get(&agent_id).unwrap();
    let private = team::private_workspace(&st, &agent);

    // The RPC: null is "No project", not "omitted".
    let none = dispatch(&st, "agent.conversation.create", json!({"agentId":agent_id,"projectId":null})).await.unwrap()["session"].clone();
    let none_id = none["id"].as_str().unwrap().to_owned();
    assert_eq!(PathBuf::from(none["projectPath"].as_str().unwrap()), private, "{none}");
    assert_ne!(PathBuf::from(none["projectPath"].as_str().unwrap()), alpha_dir);
    assert!(none["projectId"].is_null() && none["projectName"].is_null(), "{none}");
    assert!(st.db.session_event_summary(&none_id).unwrap()["projectId"].is_null());
    let listed = dispatch(&st, "agent.conversations", json!({"agentId":agent_id})).await.unwrap();
    let row = listed["conversations"].as_array().unwrap().iter().find(|row| row["id"] == none_id.as_str()).unwrap().clone();
    assert!(row["projectId"].is_null() && row["projectName"].is_null(), "{row}");
    let snapshot = st.db.snapshot().unwrap();
    let in_snapshot = snapshot["sessions"].as_array().unwrap().iter().find(|row| row["id"] == none_id.as_str()).unwrap().clone();
    assert!(in_snapshot["projectId"].is_null() && in_snapshot["projectName"].is_null());
    let projects = dispatch(&st, "agent.projects", json!({"agentId":agent_id})).await.unwrap();
    let no_project = projects["projects"].as_array().unwrap().iter().find(|project| project["name"] == "No project").expect("listed as No project").clone();
    assert!(no_project["id"].is_null() && no_project["conversationCount"] == 1, "{no_project}");

    // Instructions: the casual wording, never Alpha's section.
    let mut options = ExecOptions::default();
    let detail = st.db.session_detail(&none_id).unwrap();
    team::attach(&st, &none_id, Some(&agent_id), &json!({"kind":"main"}), Some(Path::new(detail["projectPath"].as_str().unwrap())), detail["projectId"].as_str(), &mut options);
    let text = options.instructions.unwrap();
    assert!(text.contains("not tied to a project") && !text.contains("\"Alpha\"") && !text.contains("The Alpha service."), "{text}");
    // A live provider start (session.new with a null project and no folder) agrees.
    let started = dispatch(&st, "session.new", json!({"agentId":agent_id,"projectId":null})).await.unwrap();
    let launched = adapter.instructions.lock().unwrap().get(started["id"].as_str().unwrap()).cloned().expect("started");
    assert!(launched.contains("not tied to a project") && !launched.contains("\"Alpha\""), "{launched}");
    let started_detail = st.db.session_detail(started["id"].as_str().unwrap()).unwrap();
    assert!(started_detail["projectId"].is_null());
    assert_eq!(PathBuf::from(started_detail["projectPath"].as_str().unwrap()), private);

    // Null with a folder keeps the folder; an unregistered folder stays unstamped.
    let elsewhere = project_dir("elsewhere");
    let kept = dispatch(&st, "session.new", json!({"agentId":agent_id,"projectId":null,"projectPath":elsewhere,"lazy":true})).await.unwrap();
    let kept = st.db.session_detail(kept["id"].as_str().unwrap()).unwrap();
    assert_eq!(PathBuf::from(kept["projectPath"].as_str().unwrap()), elsewhere);
    assert!(kept["projectId"].is_null(), "{kept}");
    // A folder that is a registered project is that project (inferred from the folder).
    let registered = dispatch(&st, "session.new", json!({"agentId":agent_id,"projectId":null,"projectPath":alpha_dir,"lazy":true})).await.unwrap();
    assert_eq!(st.db.session_detail(registered["id"].as_str().unwrap()).unwrap()["projectId"], alpha_id.as_str());

    // Project memory for Alpha is not visible here.
    st.db.memory_create(&json!({"scope":"project","scopeId":alpha_id,"kind":"fact","title":"Alpha deploys on Friday","body":"Alpha ships every Friday.","origin":"user"})).unwrap();
    let text = |response: &Value| response["content"][0]["text"].as_str().unwrap_or("").to_owned();
    let seen = text(&call_tool(&st, &none_id, "memory_search", json!({"query":"deploys"})).await);
    assert!(!seen.contains("Alpha deploys"), "{seen}");

    // Omitting projectId still gives the default project; the explicit null did not change it.
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    let omitted = dispatch(&st, "agent.conversation.create", json!({"agentId":agent_id})).await.unwrap()["session"].clone();
    assert_eq!(omitted["projectId"], alpha_id.as_str(), "{omitted}");
    assert_eq!(st.db.agent_get(&agent_id).unwrap()["projectId"], alpha_id.as_str());
}

#[tokio::test]
async fn rules_in_a_no_project_conversation() {
    let (mut st, mut events) = state();
    let (alpha_id, alpha_dir) = real_project(&st, "Alpha");
    let agent = st.db.agent_create(&json!({"name":"Rules","runtimeId":"rt-test"})).unwrap().0["id"].as_str().unwrap().to_owned();
    st.db.agent_set_team(&agent, &json!({"projectId":alpha_id})).unwrap();
    // The private-workspace conversation, as an explicit null leaves it.
    let private = project_dir("private");
    let in_none = permission_fixture(&mut st, "none-session", &agent, &private).await;
    st.db.merge_session_data("none-session", &json!({"projectId":null})).unwrap();
    assert!(st.db.session_detail("none-session").unwrap()["projectId"].is_null());
    let _ = alpha_dir;
    // A rule scoped to Alpha does not apply in it.
    st.db.permission_rule_create(&agent, "read", "README.md", "Read `README.md`", Some(&alpha_id)).unwrap();
    in_none.send(read_request("README.md")).await.unwrap();
    let card = next_rule_event(&mut events, "permission.requested").await;
    assert_eq!(card["sessionId"], "none-session");
    assert!(card["projectId"].is_null() && card["projectName"].is_null(), "{card}");
    // "This project" from it stores an everywhere rule, since there is no project.
    let replied = dispatch(&st, "permission.reply", json!({"permissionId":card["id"],"choice":"allow","remember":true,"rememberScope":"project"})).await.unwrap();
    assert!(replied["rule"]["projectId"].is_null(), "{replied}");
    assert_eq!(st.db.permission_rules(Some(&agent)).unwrap().len(), 2, "Alpha's rule is untouched");
}
