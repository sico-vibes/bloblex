// Phase 4, Gogo's lane: `.bitbots.json` (section 4).
// Included into `phase2a_tests` so it shares that module's fixtures: `state`, `real_project`,
// `dispatch`, `json!`, `PathBuf` and `Value`.

const FILE: &str = ".bitbots.json";

/// A project with a real folder and a `.bitbots.json` in it.
fn shared_project(st: &AppState, name: &str, file: &str) -> (String, PathBuf) {
    let (id, dir) = real_project(st, name);
    std::fs::write(dir.join(FILE), file).unwrap();
    (id, dir)
}

async fn shared_get(st: &AppState, id: &str) -> Value {
    dispatch(st, "project.sharedSettings.get", json!({"projectId":id})).await.unwrap()
}

/// Trust the file as it is now, the way the window does after showing it.
async fn trust(st: &AppState, id: &str) -> Value {
    let hash = shared_get(st, id).await["hash"].as_str().expect("a hash").to_owned();
    dispatch(st, "project.sharedSettings.trust", json!({"projectId":id,"hash":hash,"confirm":true})).await.unwrap()
}

fn effective(st: &AppState, id: &str) -> Value {
    crate::shared_settings::effective_overrides(st, &st.db.project_get(id).unwrap())
}

#[tokio::test]
async fn the_file_does_nothing_until_trusted() {
    let (st, _) = state();
    let (id, _) = shared_project(&st, "Shared", r#"{"version":1,"setupScript":"echo hi","approvalMode":"auto"}"#);
    let before = shared_get(&st, &id).await;
    assert_eq!((before["found"].clone(), before["valid"].clone()), (json!(true), json!(true)));
    assert_eq!((before["trusted"].clone(), before["state"].clone()), (json!(false), json!("untrusted")));
    assert_eq!(before["settings"]["setupScript"], "echo hi", "the file is shown as it is");
    assert_eq!(before["hash"].as_str().unwrap().len(), 64, "the hash is the SHA-256 of its bytes");
    assert!(effective(&st, &id)["setupScript"].is_null(), "nothing is used before trust");
    assert!(effective(&st, &id)["approvalMode"].is_null());
    // A project with no file.
    let (plain, _) = real_project(&st, "Plain");
    let none = shared_get(&st, &plain).await;
    assert_eq!((none["found"].clone(), none["state"].clone()), (json!(false), json!("none")));
    // Trusted, the file's settings apply.
    let after = trust(&st, &id).await;
    assert_eq!((after["trusted"].clone(), after["state"].clone()), (json!(true), json!("trusted")));
    assert_eq!(effective(&st, &id)["setupScript"], "echo hi");
    assert_eq!(effective(&st, &id)["approvalMode"], "auto");
    // Untrusting clears it again.
    let cleared = dispatch(&st, "project.sharedSettings.untrust", json!({"projectId":id})).await.unwrap();
    assert_eq!(cleared["state"], "untrusted");
    assert!(effective(&st, &id)["setupScript"].is_null());
}

#[tokio::test]
async fn a_changed_file_stops_being_trusted() {
    let (st, _) = state();
    let (id, dir) = shared_project(&st, "Changing", r#"{"version":1,"setupScript":"echo one"}"#);
    trust(&st, &id).await;
    assert_eq!(effective(&st, &id)["setupScript"], "echo one");
    // A `git pull` changes the file: the stored hash no longer matches, so nothing runs.
    std::fs::write(dir.join(FILE), r#"{"version":1,"setupScript":"rm -rf everything"}"#).unwrap();
    assert!(effective(&st, &id)["setupScript"].is_null(), "a changed file is untrusted at once");
    let now = shared_get(&st, &id).await;
    assert_eq!((now["trusted"].clone(), now["state"].clone()), (json!(false), json!("untrusted")));
    assert_eq!(now["settings"]["setupScript"], "rm -rf everything", "it is shown, and not used");
}

#[tokio::test]
async fn a_repository_file_cannot_turn_on_full_access() {
    let (st, _) = state();
    let (id, _) = shared_project(&st, "Bypass", r#"{"version":1,"approvalMode":"bypass","setupScript":"echo hi"}"#);
    let got = shared_get(&st, &id).await;
    assert_eq!(got["valid"], true, "the file is valid; one field is refused");
    let problems = got["problems"].as_array().unwrap().iter().filter_map(Value::as_str).collect::<Vec<_>>();
    assert!(problems.contains(&"A repository file can't turn on Full access."), "{problems:?}");
    assert!(got["settings"]["approvalMode"].is_null());
    assert_eq!(got["settings"]["setupScript"], "echo hi", "the other fields stand");
    // Even trusted, the mode never becomes Full access.
    trust(&st, &id).await;
    assert!(effective(&st, &id)["approvalMode"].is_null());
    assert_eq!(effective(&st, &id)["setupScript"], "echo hi");
}

#[tokio::test]
async fn a_bad_field_is_named_and_the_rest_stand() {
    let (st, _) = state();
    let (id, _) = shared_project(&st, "Bad", r#"{"version":1,"setupScript":42,"approvalMode":"ask","defaultBot":"Rae","colour":"red"}"#);
    let got = shared_get(&st, &id).await;
    assert_eq!(got["valid"], true);
    assert!(got["settings"]["setupScript"].is_null(), "the bad field is dropped");
    assert_eq!(got["settings"]["approvalMode"], "ask");
    assert_eq!(got["settings"]["defaultBot"], "Rae");
    let problems = got["problems"].as_array().unwrap().iter().filter_map(Value::as_str).collect::<Vec<_>>();
    assert!(problems.iter().any(|problem| problem.contains("setupScript")), "{problems:?}");
    assert!(problems.iter().any(|problem| problem.contains("colour")), "an unknown key is named: {problems:?}");
    // Not JSON, or a version this build does not know, is invalid and unusable.
    let (broken, _) = shared_project(&st, "Broken", "{not json");
    let got = shared_get(&st, &broken).await;
    assert_eq!((got["found"].clone(), got["valid"].clone(), got["state"].clone()), (json!(true), json!(false), json!("invalid")));
    assert!(got["settings"].is_null());
    let (v2, _) = shared_project(&st, "V2", r#"{"version":2,"setupScript":"echo hi"}"#);
    assert_eq!(shared_get(&st, &v2).await["state"], "invalid");
    assert!(effective(&st, &v2)["setupScript"].is_null());
}

#[tokio::test]
async fn a_symlink_or_large_file_is_refused() {
    let (st, _) = state();
    // Larger than 64 KB.
    let (big, big_dir) = real_project(&st, "Big");
    std::fs::write(big_dir.join(FILE), "x".repeat(65 * 1024)).unwrap();
    let got = shared_get(&st, &big).await;
    assert_eq!((got["found"].clone(), got["valid"].clone()), (json!(true), json!(false)), "a large file is not read");
    // A folder where the file should be is not a regular file.
    let (folder, folder_dir) = real_project(&st, "Folder file");
    std::fs::create_dir_all(folder_dir.join(FILE)).unwrap();
    let got = shared_get(&st, &folder).await;
    assert_eq!((got["found"].clone(), got["valid"].clone()), (json!(true), json!(false)), "only a regular file is read");
    // A link, where the account may make one.
    let (linked, link_dir) = real_project(&st, "Linked");
    let target = link_dir.join("real.json");
    std::fs::write(&target, r#"{"version":1,"setupScript":"echo hi"}"#).unwrap();
    if std::os::windows::fs::symlink_file(&target, link_dir.join(FILE)).is_ok() {
        let got = shared_get(&st, &linked).await;
        assert_eq!((got["found"].clone(), got["valid"].clone()), (json!(true), json!(false)), "a link is not read");
        assert!(effective(&st, &linked)["setupScript"].is_null());
    }
}

#[tokio::test]
async fn the_projects_own_override_wins() {
    let (st, _) = state();
    let (id, _) = shared_project(&st, "Own", r#"{"version":1,"setupScript":"echo file","approvalMode":"auto"}"#);
    trust(&st, &id).await;
    let hash = shared_get(&st, &id).await["hash"].as_str().unwrap().to_owned();
    // The project's own script wins, field by field.
    dispatch(&st, "project.update", json!({"projectId":id,"overrides":{"setupScript":"echo own","copyFiles":[],"initSubmodules":false}})).await.unwrap();
    let overrides = effective(&st, &id);
    assert_eq!(overrides["setupScript"], "echo own");
    assert_eq!(overrides["approvalMode"], "auto", "a field the project leaves unset comes from the file");
    // A settings save that does not name the file keeps the trust.
    assert_eq!(st.db.project_get(&id).unwrap()["overrides"]["trustedSharedHash"], hash.as_str());
}

#[tokio::test]
async fn a_trusted_script_runs_in_a_new_copy() {
    let (st, _) = state();
    let (id, dir) = shared_project(&st, "Trusted run", r#"{"version":1,"setupScript":"echo from the file"}"#);
    trust(&st, &id).await;
    let copy = dir.join("copy");
    std::fs::create_dir_all(&copy).unwrap();
    let link = json!({"worktree":{"path": copy.to_string_lossy()}});
    // The runner asks the one resolver, so a trusted script asks for the setup in a conversation's copy.
    assert!(crate::project_setup::wanted(&st, Some(&id), &link, &copy), "a trusted script asks for the setup");
}

#[tokio::test]
async fn an_untrusted_script_never_runs() {
    let (st, _) = state();
    let (id, dir) = shared_project(&st, "Untrusted run", r#"{"version":1,"setupScript":"echo never"}"#);
    let copy = dir.join("copy");
    std::fs::create_dir_all(&copy).unwrap();
    let link = json!({"worktree":{"path": copy.to_string_lossy()}});
    assert!(!crate::project_setup::wanted(&st, Some(&id), &link, &copy), "an untrusted script never runs");
    assert!(effective(&st, &id)["setupScript"].is_null());
    // Trusted, and then changed: it stops running at once.
    trust(&st, &id).await;
    assert!(crate::project_setup::wanted(&st, Some(&id), &link, &copy));
    std::fs::write(dir.join(FILE), r#"{"version":1,"setupScript":"echo changed instead"}"#).unwrap();
    assert!(!crate::project_setup::wanted(&st, Some(&id), &link, &copy), "a changed file stops running at once");
}

#[tokio::test]
async fn trust_needs_the_current_hash() {
    let (st, _) = state();
    let (id, _) = shared_project(&st, "Hash", r#"{"version":1,"setupScript":"echo hi"}"#);
    let stale = dispatch(&st, "project.sharedSettings.trust", json!({"projectId":id,"hash":"0".repeat(64),"confirm":true})).await.unwrap_err();
    assert_eq!(stale.1.code, "conflict");
    assert_eq!(stale.1.message, "That file has changed. Check it again.");
    let hash = shared_get(&st, &id).await["hash"].as_str().unwrap().to_owned();
    let unconfirmed = dispatch(&st, "project.sharedSettings.trust", json!({"projectId":id,"hash":hash})).await.unwrap_err();
    assert_eq!(unconfirmed.1.code, "invalid_argument");
    assert_eq!(shared_get(&st, &id).await["state"], "untrusted", "nothing was trusted");
}

#[tokio::test]
async fn write_refuses_to_replace_without_asking() {
    let (st, _) = state();
    let (id, dir) = real_project(&st, "Writer");
    dispatch(&st, "project.update", json!({"projectId":id,"overrides":{"setupScript":"npm install","copyFiles":[],"initSubmodules":false}})).await.unwrap();
    assert_eq!(dispatch(&st, "project.sharedSettings.write", json!({"projectId":id})).await.unwrap_err().1.code, "invalid_argument", "no confirmation");
    assert!(!dir.join(FILE).exists(), "nothing is written without a confirmation");
    let wrote = dispatch(&st, "project.sharedSettings.write", json!({"projectId":id,"confirm":true})).await.unwrap();
    assert_eq!((wrote["state"].clone(), wrote["trusted"].clone()), (json!("trusted"), json!(true)));
    assert_eq!(wrote["settings"]["setupScript"], "npm install");
    assert!(dir.join(FILE).is_file());
    // A second write refuses to replace what is there.
    assert_eq!(dispatch(&st, "project.sharedSettings.write", json!({"projectId":id,"confirm":true})).await.unwrap_err().1.code, "conflict");
    let replaced = dispatch(&st, "project.sharedSettings.write", json!({"projectId":id,"confirm":true,"replace":true})).await.unwrap();
    assert_eq!(replaced["state"], "trusted");
    assert!(!std::fs::read_dir(&dir).unwrap().flatten().any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp")), "no temporary file is left");
}

#[tokio::test]
async fn write_leaves_out_full_access() {
    let (st, _) = state();
    let (id, dir) = real_project(&st, "Full writer");
    dispatch(&st, "project.update", json!({"projectId":id,"overrides":{"approvalMode":"bypass"},"confirm":true})).await.unwrap();
    let wrote = dispatch(&st, "project.sharedSettings.write", json!({"projectId":id,"confirm":true})).await.unwrap();
    assert!(wrote["settings"]["approvalMode"].is_null(), "Full access is never written to a repository file");
    let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
    assert!(!text.contains("bypass"), "{text}");
    assert!(text.contains("\"version\": 1"), "{text}");
}

#[tokio::test]
async fn trust_never_travels_in_a_backup_or_to_a_device() {
    let (st, _) = state();
    let (id, _) = shared_project(&st, "Trusted", r#"{"version":1,"setupScript":"echo hi"}"#);
    let hash = trust(&st, &id).await["hash"].as_str().unwrap().to_owned();
    assert_eq!(st.db.project_get(&id).unwrap()["overrides"]["trustedSharedHash"], hash.as_str());
    // A backup carries no projects at all, so no trust either.
    let exported = dispatch(&st, "backup.export", json!({})).await.unwrap();
    assert!(!exported.to_string().contains(&hash), "a backup never carries the trust");
    // A device never sees a project's overrides, so neither.
    let row = json!({"projects":[{"id":"p_1","overrides":st.db.project_get(&id).unwrap()["overrides"].clone(),"trustedSharedHash":hash}]});
    let redacted = crate::remote::policy::redact_result("project.list", &row, &crate::remote::policy::RedactOptions::default());
    assert!(!redacted.to_string().contains(&hash), "a device never sees the trust: {redacted}");
    assert!(redacted["projects"][0].get("overrides").is_none(), "the overrides are dropped");
}

#[tokio::test]
async fn a_trusted_file_sets_the_conversations_mode() {
    let (st, _) = state();
    let (id, dir) = shared_project(&st, "Mode file", r#"{"version":1,"approvalMode":"accept_edits"}"#);
    trust(&st, &id).await;
    let agent = st.db.agent_create(&json!({"name":"Modely","runtimeId":"rt-test","approvalMode":"auto"})).unwrap().0["id"].as_str().unwrap().to_owned();
    st.db.create_session_for_agent("shared-mode", "rt-test", "codex", &dir.to_string_lossy(), "Chat", Some(&agent)).unwrap();
    st.db.merge_session_data("shared-mode", &json!({"projectId": id})).unwrap();
    st.db.update_session_state("shared-mode", "idle").unwrap();
    // The turn's own decision uses the file's mode, before the bot's...
    let options = exec_options_for_session(&st, &st.db.session_detail("shared-mode").unwrap()).unwrap();
    assert_eq!(options.approval_mode, ApprovalMode::AcceptEdits);
    // ...and so does the row the window shows.
    let got = dispatch(&st, "session.get", json!({"sessionId":"shared-mode"})).await.unwrap();
    assert_eq!(got["projectApprovalMode"], "accept_edits");
    let listed = dispatch(&st, "session.list", json!({})).await.unwrap();
    let row = listed["sessions"].as_array().unwrap().iter().find(|row| row["id"] == "shared-mode").unwrap();
    assert_eq!(row["projectApprovalMode"], "accept_edits");
    // Untrusted, the bot's own mode stands.
    dispatch(&st, "project.sharedSettings.untrust", json!({"projectId":id})).await.unwrap();
    let options = exec_options_for_session(&st, &st.db.session_detail("shared-mode").unwrap()).unwrap();
    assert_eq!(options.approval_mode, ApprovalMode::Auto);
    assert!(dispatch(&st, "session.get", json!({"sessionId":"shared-mode"})).await.unwrap()["projectApprovalMode"].is_null());
}

#[tokio::test]
async fn project_update_cannot_grant_trust() {
    let (st, _) = state();
    let (id, _) = shared_project(&st, "No grant", r#"{"version":1,"setupScript":"echo hi"}"#);
    let hash = shared_get(&st, &id).await["hash"].as_str().unwrap().to_owned();
    // The correct hash, through the settings write: refused, so trust can only come from `.trust`.
    let refused = dispatch(&st, "project.update", json!({"projectId":id,"overrides":{"trustedSharedHash":hash}})).await.unwrap_err();
    assert_eq!(refused.1.code, "invalid_argument");
    assert_eq!(shared_get(&st, &id).await["state"], "untrusted", "nothing was trusted");
    assert!(effective(&st, &id)["setupScript"].is_null());
    // Even mixed with a real setting.
    let mixed = dispatch(&st, "project.update", json!({"projectId":id,"overrides":{"setupScript":"echo own","trustedSharedHash":hash}})).await.unwrap_err();
    assert_eq!(mixed.1.code, "invalid_argument");
    assert!(st.db.project_get(&id).unwrap()["overrides"]["trustedSharedHash"].is_null());
    // And a trusted project keeps its trust through a settings save.
    trust(&st, &id).await;
    dispatch(&st, "project.update", json!({"projectId":id,"overrides":{"setupScript":"echo own"}})).await.unwrap();
    assert_eq!(shared_get(&st, &id).await["state"], "trusted");
}

#[tokio::test]
async fn write_never_follows_a_planted_temp_link() {
    let (st, _) = state();
    let (id, dir) = real_project(&st, "Planted");
    let outside = std::env::temp_dir().join(format!("bitbots-4-outside-{}.json", Uuid::new_v4()));
    std::fs::write(&outside, "keep me").unwrap();
    let planted = dir.join(".bitbots.json.tmp");
    // Where the account may make a link, plant one at the temporary name.
    if std::os::windows::fs::symlink_file(&outside, &planted).is_ok() {
        let wrote = dispatch(&st, "project.sharedSettings.write", json!({"projectId":id,"confirm":true})).await.unwrap();
        assert_eq!(wrote["state"], "trusted");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep me", "the write never leaves the project folder");
        assert!(dir.join(FILE).is_file(), "the real file is written inside the project");
    }
    let _ = std::fs::remove_file(&outside);
    let _ = std::fs::remove_file(&planted);
}

#[tokio::test]
async fn default_bot_is_null_when_no_bot_has_that_name() {
    let (st, _) = state();
    let (id, _) = shared_project(&st, "Bot file", r#"{"version":1,"defaultBot":"Rae"}"#);
    // Untrusted: no default bot at all.
    let listed = dispatch(&st, "project.list", json!({})).await.unwrap();
    let project = listed["projects"].as_array().unwrap().iter().find(|project| project["id"] == id.as_str()).unwrap().clone();
    assert_eq!(project["sharedSettings"], "untrusted");
    assert!(project["defaultBot"].is_null());
    trust(&st, &id).await;
    let listed = dispatch(&st, "project.list", json!({})).await.unwrap();
    let project = listed["projects"].as_array().unwrap().iter().find(|project| project["id"] == id.as_str()).unwrap().clone();
    assert_eq!(project["sharedSettings"], "trusted");
    assert_eq!(project["defaultBot"]["name"], "Rae");
    assert!(project["defaultBot"]["agentId"].is_null(), "no bot here has that name");
    let bot = st.db.agent_create(&json!({"name":"Rae","runtimeId":"rt-test"})).unwrap().0;
    let listed = dispatch(&st, "project.list", json!({})).await.unwrap();
    let project = listed["projects"].as_array().unwrap().iter().find(|project| project["id"] == id.as_str()).unwrap().clone();
    assert_eq!(project["defaultBot"]["agentId"], bot["id"]);
}
