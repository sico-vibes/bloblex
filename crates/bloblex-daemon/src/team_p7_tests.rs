use super::*;
use crate::phase2a_tests::state;

async fn fixture() -> (AppState, String, String) {
    let (st, _) = state();
    st.db.upsert_runtime(&json!({"id":"p7-rt","provider":"codex","status":"offline"})).unwrap();
    *st.runtimes.write().await = vec![json!({"id":"p7-rt","provider":"codex","status":"offline"})];
    *st.team.data_dir.lock().unwrap() = Some(std::env::temp_dir().join(format!("p7-{}", uuid::Uuid::new_v4())));
    let boss = st.db.agent_create(&json!({"name":"Manager","runtimeId":"p7-rt","systemRole":"manager"})).unwrap().0;
    let worker = st.db.agent_create(&json!({"name":"Scout","runtimeId":"p7-rt","approvalMode":"ask"})).unwrap().0;
    for (sid, agent) in [("p7-boss", &boss), ("p7-worker", &worker)] {
        st.db.create_session_for_agent(sid, "p7-rt", "codex", ".", sid, agent["id"].as_str()).unwrap();
        st.db.update_session_state(sid, "idle").unwrap();
    }
    (st, boss["id"].as_str().unwrap().into(), worker["id"].as_str().unwrap().into())
}
async fn call(st: &AppState, sid: &str, name: &str, args: Value) -> Value {
    mcp_rpc(st, sid, "mcp.tools.call", &json!({"name":name,"arguments":args})).await.unwrap()
}
fn pending(st: &AppState) -> Value { st.db.proposals_pending().unwrap().last().unwrap().clone() }
async fn approve(st: &AppState) -> Value {
    crate::proposals::decide(st, &json!({"id":pending(st)["id"],"decision":"approve"})).await.unwrap()
}

#[tokio::test]
async fn p7_update_bot_requires_approval_rechecks_lock_and_restricts_fields() {
    let (st, _, worker) = fixture().await;
    for field in [json!({"name":"New Scout"}), json!({"description":"Research"}), json!({"role":"Researcher"}), json!({"instructions":"Check sources"}), json!({"tags":["researcher"]}), json!({"model":"test-model","thinking":"high"}), json!({"look":{"shape":"circle"}}), json!({"approvalMode":"auto"})] {
        let before = st.db.agent_get(&worker).unwrap();
        let mut args = field.clone(); args["blob"] = json!(worker);
        let result = call(&st,"p7-boss","update_blob",args.clone()).await;
        assert_ne!(result["isError"], true, "{result}");
        assert_eq!(st.db.agent_get(&worker).unwrap(), before, "no write before approval");
        st.db.agent_set_locked(&worker,true).unwrap();
        assert_eq!(call(&st,"p7-boss","update_blob",args.clone()).await["isError"],true);
        assert!(crate::proposals::decide(&st,&json!({"id":pending(&st)["id"],"decision":"approve"})).await.is_err());
        st.db.agent_set_locked(&worker,false).unwrap();
        approve(&st).await;
        let updated=st.db.agent_get(&worker).unwrap();
        for (key,value) in field.as_object().unwrap() { assert_eq!(&updated[key],value,"{key}"); }
        assert_eq!(call(&st,"p7-worker","update_blob",args).await["isError"],true);
    }
    for fields in [json!({"approvalMode":"bypass"}), json!({"customEnv":{"SECRET":"no"}}), json!({"locked":false}), json!({"runtimeId":"other"})] {
        let mut args=fields; args["blob"]=json!(worker);
        assert_eq!(call(&st,"p7-boss","update_blob",args).await["isError"],true);
    }
}

#[tokio::test]
async fn p7_project_edits_are_proposals_and_unknown_projects_refused() {
    let (st,_,_) = fixture().await;
    let project=st.db.project_create("Portal",Some(".")).unwrap().0;
    let args=json!({"project":project["id"],"tags":["research"],"description":"Portal research"});
    assert_ne!(call(&st,"p7-boss","update_project",args.clone()).await["isError"],true);
    assert_eq!(st.db.project_get(project["id"].as_str().unwrap()).unwrap()["tags"],json!([]));
    approve(&st).await;
    assert_eq!(st.db.project_get(project["id"].as_str().unwrap()).unwrap()["tags"],json!(["research"]));
    assert_eq!(call(&st,"p7-worker","update_project",args).await["isError"],true);
    assert_eq!(call(&st,"p7-boss","update_project",json!({"project":"missing","tags":[]})).await["isError"],true);
}

#[tokio::test]
async fn p7_manager_message_and_start_require_task_contract_and_approval() {
    let (st,_,worker)=fixture().await;
    for tool in ["message_blob","start_conversation","assign_task"] {
        let args=if tool=="message_blob" { json!({"blob":worker,"message":"Research it","doneGoal":"Sources checked","reportBack":"Findings with sources","topic":"Research the market"}) } else { json!({"bot":worker,"brief":"Research it","doneGoal":"Sources checked","reportBack":"Findings with sources","topic":"Research the market"}) };
        let count=st.db.session_list(false).unwrap().len();
        let result=call(&st,"p7-boss",tool,args).await;
        assert_ne!(result["isError"],true,"{tool}: {result}");
        assert_eq!(pending(&st)["payload"]["doneGoal"],"Sources checked");
        assert_eq!(pending(&st)["payload"]["reportBack"],"Findings with sources");
        assert_eq!(st.db.session_list(false).unwrap().len(),count);
        let bad=if tool=="message_blob" {json!({"blob":worker,"message":"Missing contract"})} else {json!({"bot":worker,"brief":"Missing contract"})};
        assert_eq!(call(&st,"p7-boss",tool,bad).await["isError"],true);
    }
    assert_eq!(call(&st,"p7-worker","start_conversation",json!({})).await["isError"],true);
}

#[tokio::test]
async fn p7_read_tools_are_manager_only_bounded_and_omit_secrets() {
    let (st,_,worker)=fixture().await;
    let project=st.db.project_create("Portal",Some(".")).unwrap().0;
    st.db.agent_update(&worker,&json!({"customEnv":{"LANG":"secret-value"}})).unwrap();
    st.db.append_message_with_data("p7-worker","","user","Hello",&json!({})).unwrap();
    for (tool,args) in [("read_blob",json!({"blob":worker})),("read_project",json!({"project":project["id"]})),("read_conversation",json!({"conversation":"p7-worker"})),("get_conversation_permission",json!({"conversation":"p7-worker"}))] {
        let result=call(&st,"p7-boss",tool,args.clone()).await;
        assert_ne!(result["isError"],true,"{tool}: {result}");
        assert!(!result.to_string().contains("secret-value"));
        assert_eq!(call(&st,"p7-worker",tool,args).await["isError"],true);
        assert_eq!(call(&st,"p7-boss",tool,json!({})).await["isError"],true);
    }
    let list=call(&st,"p7-boss","list_conversations",json!({"blob":worker})).await;
    assert!(list.to_string().contains("p7-worker"));
}

#[tokio::test]
async fn p7_open_conversation_waits_for_approval_and_refuses_missing() {
    let (st,_,_)=fixture().await;
    assert_ne!(call(&st,"p7-boss","open_conversation",json!({"conversation":"p7-worker"})).await["isError"],true);
    assert_eq!(pending(&st)["payload"]["action"],"open");
    assert_eq!(call(&st,"p7-worker","open_conversation",json!({"conversation":"p7-worker"})).await["isError"],true);
    assert_eq!(call(&st,"p7-boss","open_conversation",json!({"conversation":"missing"})).await["isError"],true);
    let pending_open = pending(&st)["id"].clone();
    approve(&st).await;
    assert_eq!(st.db.proposal_get(pending_open.as_str().unwrap()).unwrap()["result"]["sessionId"],"p7-worker");
}

#[tokio::test]
async fn p7_routing_guidance_is_stable_and_covers_researcher_example() {
    let (st,boss,worker)=fixture().await;
    let agent=st.db.agent_get(&boss).unwrap();
    let tools_before=mcp_rpc(&st,"p7-boss","mcp.tools.list",&json!({})).await.unwrap();
    let before=runtime_instructions(&st,&agent,&json!({"kind":"main"}),std::path::Path::new("."));
    st.db.agent_set_team(&worker,&json!({"tags":["researcher"]})).unwrap();
    st.db.project_create("New project",Some(".")).unwrap();
    assert_eq!(before,runtime_instructions(&st,&agent,&json!({"kind":"main"}),std::path::Path::new(".")));
    assert_eq!(tools_before,mcp_rpc(&st,"p7-boss","mcp.tools.list",&json!({})).await.unwrap());
    for phrase in ["researcher","free bot","doneGoal","reportBack","ask_user","propose_bot","propose_project"] {assert!(before.contains(phrase),"{phrase}");}
}

#[derive(Default)]
struct P7Adapter;
#[async_trait::async_trait]
impl bloblex_agent_core::AgentAdapter for P7Adapter {
    async fn probe(&self, _: &bloblex_agent_core::RuntimeSpec) -> Result<bloblex_agent_core::ProbeResult, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
    async fn new_session(&self, _: &bloblex_agent_core::RuntimeSpec, request: bloblex_agent_core::NewSessionRequest, _: tokio::sync::mpsc::Sender<bloblex_agent_core::AgentEvent>) -> Result<bloblex_agent_core::SessionHandle, bloblex_agent_core::AdapterError> {
        Ok(bloblex_agent_core::SessionHandle { session_id: request.session_id, provider_session_id: "p7-fake".into(), capabilities: Default::default() })
    }
    async fn resume_session(&self, _: &bloblex_agent_core::RuntimeSpec, _: bloblex_agent_core::ResumeSessionRequest, _: tokio::sync::mpsc::Sender<bloblex_agent_core::AgentEvent>) -> Result<bloblex_agent_core::SessionHandle, bloblex_agent_core::AdapterError> { Err(bloblex_agent_core::AdapterError::Unsupported("test".into())) }
    async fn prompt(&self, _: &bloblex_agent_core::SessionHandle, _: bloblex_agent_core::PromptRequest) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
    async fn cancel(&self, _: &bloblex_agent_core::SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
    async fn reply_permission(&self, _: &str, _: &str) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
    async fn close_session(&self, _: &bloblex_agent_core::SessionHandle) -> Result<(), bloblex_agent_core::AdapterError> { Ok(()) }
}

#[tokio::test]
async fn p7_approved_parallel_tasks_carry_contract_and_follow_up_uses_same_conversation() {
    let (mut st,_,worker)=fixture().await;
    st.adapters = std::sync::Arc::new(crate::Adapters { acp: std::sync::Arc::new(P7Adapter), codex: std::sync::Arc::new(P7Adapter), claude: std::sync::Arc::new(P7Adapter) });
    let mut sides=Vec::new();
    for tool in ["assign_task","start_conversation","message_blob"] {
        let mut args = json!({"brief":"Research the market","bot":worker,"doneGoal":"Three checked sources","reportBack":"Findings with links","topic":"Research the market"});
        if tool=="message_blob" {
            args.as_object_mut().unwrap().remove("brief"); args.as_object_mut().unwrap().remove("bot");
            args["message"]=json!("Research the market"); args["blob"]=json!(worker);
        }
        assert_ne!(call(&st,"p7-boss",tool,args).await["isError"],true);
        let result=approve(&st).await;
        let side=result["result"]["sideSessionId"].as_str().unwrap().to_owned();
        assert!(!sides.contains(&side),"new topics are parallel conversations");
        sides.push(side.clone());
        for _ in 0..100 {
            if st.db.session_detail(&side).unwrap()["messages"].as_array().is_some_and(|messages| messages.iter().any(|m| m["content"].as_str().is_some_and(|text| text.contains("Three checked sources") && text.contains("Findings with links")))) { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let row=st.db.session_detail(&side).unwrap();
        assert!(row["messages"].to_string().contains("Three checked sources"));
        assert!(row["messages"].to_string().contains("Findings with links"));
    }
    let count=st.db.session_list(false).unwrap().len();
    assert_ne!(call(&st,"p7-boss","message_blob",json!({"blob":worker,"message":"Check another source","conversation":sides[0],"doneGoal":"Source checked","reportBack":"Source and verdict"})).await["isError"],true);
    assert_eq!(approve(&st).await["result"]["sideSessionId"],sides[0]);
    assert_eq!(st.db.session_list(false).unwrap().len(),count);
}

#[tokio::test]
async fn p7_create_tools_propose_validate_and_apply_tags_and_safe_permissions() {
    let (st,_,_)=fixture().await;
    let dir=std::env::temp_dir().join(format!("p7-project-{}",uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let project_args=json!({"name":"Portal","tags":["research"],"folder":{"mode":"existing","path":dir}});
    assert_ne!(call(&st,"p7-boss","propose_project",project_args.clone()).await["isError"],true);
    assert!(st.db.project_list().unwrap().is_empty());
    assert_eq!(call(&st,"p7-worker","propose_project",project_args).await["isError"],true);
    approve(&st).await;
    let project=st.db.project_list().unwrap()[0].clone();
    assert_eq!(project["tags"],json!(["research"]));
    let args=json!({"name":"Portal Researcher","provider":"codex","role":"Researcher","tags":["researcher"],"project":project["id"],"approvalMode":"auto","thinking":"high","look":{"shape":"circle"}});
    assert_ne!(call(&st,"p7-boss","propose_bot",args.clone()).await["isError"],true);
    assert_eq!(st.db.agent_list(false,None).unwrap().len(),2);
    assert_eq!(call(&st,"p7-worker","propose_bot",args).await["isError"],true);
    let result=approve(&st).await;
    let created=&result["result"]["agent"];
    assert_eq!(created["tags"],json!(["researcher"])); assert_eq!(created["projectId"],project["id"]); assert_eq!(created["approvalMode"],"auto");
    assert_eq!(call(&st,"p7-boss","propose_bot",json!({"name":"Unsafe","provider":"codex","approvalMode":"bypass"})).await["isError"],true);
    assert_eq!(call(&st,"p7-boss","propose_project",json!({"name":"Unsafe","folder":{"mode":"existing","path":dir},"tags":["x".repeat(25)]})).await["isError"],true);
    std::fs::remove_dir(&dir).unwrap();
}

#[tokio::test]
async fn p7_researcher_routing_respects_free_bots_roles_and_project() {
    let (st,_,worker)=fixture().await;
    let project=st.db.project_create("Portal",Some(".")).unwrap().0;
    st.db.agent_set_team(&worker,&json!({"role":"Researcher","tags":["researcher"]})).unwrap();
    let local=st.db.agent_create(&json!({"name":"Portal Scout","runtimeId":"p7-rt"})).unwrap().0;
    st.db.agent_set_team(local["id"].as_str().unwrap(),&json!({"projectId":project["id"],"tags":["researcher"],"role":"Researcher"})).unwrap();
    let free=call(&st,"p7-boss","list_blobs",json!({"freeOnly":true,"tag":"researcher","role":"researcher"})).await;
    assert!(free.to_string().contains(&worker)); assert!(!free.to_string().contains("Portal Scout"));
    let scoped=call(&st,"p7-boss","list_blobs",json!({"project":"Portal","tag":"researcher"})).await;
    assert!(scoped.to_string().contains("Portal Scout")); assert!(!scoped.to_string().contains(&worker));
    assert_eq!(call(&st,"p7-boss","list_blobs",json!({"project":"unknown"})).await["isError"],true);
    st.db.project_create("Portal",Some(".")).unwrap();
    assert_eq!(call(&st,"p7-boss","read_project",json!({"project":"Portal"})).await["isError"],true);
}

#[tokio::test]
async fn p7_permission_read_and_proposal_apply_to_all_bot_chats_and_recheck_lock() {
    let (st,boss,worker)=fixture().await;
    st.db.set_session_link("p7-worker",&json!({"kind":"side","peerAgentId":boss,"originSessionId":"p7-boss"})).unwrap();
    st.db.create_session_for_agent("p7-other-chat","p7-rt","codex",".","Other",Some(&worker)).unwrap();
    let args=json!({"conversation":"p7-worker","mode":"auto"});
    assert_ne!(call(&st,"p7-boss","set_conversation_permission",args.clone()).await["isError"],true);
    assert_eq!(st.db.agent_get(&worker).unwrap()["approvalMode"],"ask");
    st.db.agent_set_locked(&worker,true).unwrap();
    assert_eq!(call(&st,"p7-boss","set_conversation_permission",args).await["isError"],true);
    assert!(crate::proposals::decide(&st,&json!({"id":pending(&st)["id"],"decision":"approve"})).await.is_err());
    st.db.agent_set_locked(&worker,false).unwrap(); approve(&st).await;
    assert_eq!(st.db.agent_get(&worker).unwrap()["approvalMode"],"auto");
    for sid in ["p7-worker","p7-other-chat"] {
        assert_eq!(crate::exec_options_for_session(&st,&st.db.session_detail(sid).unwrap()).unwrap().approval_mode.as_str(),"auto");
    }
    assert_eq!(call(&st,"p7-worker","set_conversation_permission",json!({"conversation":"p7-worker","mode":"auto"})).await["isError"],true);
}

#[tokio::test]
async fn p7_concurrent_approvals_execute_once_and_edited_bypass_is_refused() {
    let (st,_,worker)=fixture().await;
    call(&st,"p7-boss","update_blob",json!({"blob":worker,"approvalMode":"auto"})).await;
    let proposal=pending(&st);
    assert!(crate::proposals::decide(&st,&json!({"id":proposal["id"],"decision":"approve","edits":{"approvalMode":"bypass"}})).await.is_err());
    assert_eq!(st.db.agent_get(&worker).unwrap()["approvalMode"],"ask");
    let args=json!({"id":proposal["id"],"decision":"approve"});
    let (first,second)=tokio::join!(crate::proposals::decide(&st,&args),crate::proposals::decide(&st,&args));
    assert_eq!(usize::from(first.is_ok())+usize::from(second.is_ok()),1);
    assert_eq!(st.db.agent_get(&worker).unwrap()["approvalMode"],"auto");
}

#[tokio::test]
async fn p7_read_conversation_enforces_message_and_character_bounds() {
    let (st,_,_)=fixture().await;
    for _ in 0..35 {st.db.append_message_with_data("p7-worker","","user",&"x".repeat(5000),&json!({})).unwrap();}
    let result=call(&st,"p7-boss","read_conversation",json!({"conversation":"p7-worker"})).await;
    let out: Value=serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(out["messages"].as_array().unwrap().len(),30);
    assert_eq!(out["earlierMessagesOmitted"],5);
    assert!(out["messages"].as_array().unwrap().iter().all(|m| m["content"].as_str().unwrap().len()==4000));
}

#[tokio::test]
async fn p7_task_routing_refuses_wrong_project_or_missing_folder() {
    let (st,_,worker)=fixture().await;
    let first=st.db.project_create("First",Some(".")).unwrap().0;
    let second=st.db.project_create("Second",Some(".")).unwrap().0;
    st.db.agent_set_team(&worker,&json!({"projectId":first["id"]})).unwrap();
    assert_eq!(call(&st,"p7-boss","assign_task",json!({"bot":worker,"project":second["id"],"brief":"Research","doneGoal":"Done","reportBack":"Evidence"})).await["isError"],true);
    let pathless=st.db.project_create("Pathless",None).unwrap().0;
    st.db.agent_set_team(&worker,&json!({"projectId":pathless["id"]})).unwrap();
    assert_eq!(call(&st,"p7-boss","assign_task",json!({"bot":worker,"brief":"Research","doneGoal":"Done","reportBack":"Evidence"})).await["isError"],true);
    assert!(st.db.proposals_pending().unwrap().is_empty());
}

#[tokio::test]
async fn p7_archived_manager_cannot_fall_back_to_ordinary_message_routing() {
    let (mut st,_,worker)=fixture().await;
    st.adapters = std::sync::Arc::new(crate::Adapters { acp: std::sync::Arc::new(P7Adapter), codex: std::sync::Arc::new(P7Adapter), claude: std::sync::Arc::new(P7Adapter) });
    st.db.session_archive("p7-boss",true).unwrap();
    let count=st.db.session_list(false).unwrap().len();
    let result=call(&st,"p7-boss","message_blob",json!({"blob":worker,"message":"Research","doneGoal":"Done","reportBack":"Evidence"})).await;
    assert_eq!(result["isError"],true,"archiving must not turn the Manager into an ordinary sender");
    assert_eq!(st.db.session_list(false).unwrap().len(),count);
}

// P7 audit B1: an approved permission change must not pin model, effort or mode
// on the bot's other chats. The bot's approvalMode is the single source of truth.
#[tokio::test]
async fn p7_permission_change_releases_pins_and_bot_stays_the_source_of_truth() {
    let (st,boss,worker)=fixture().await;
    st.db.set_session_link("p7-worker",&json!({"kind":"side","peerAgentId":boss,"originSessionId":"p7-boss"})).unwrap();
    // A chat with no lock, and a chat that pinned its own mode.
    st.db.create_session_for_agent("p7-pinned","p7-rt","codex",".","Pinned",Some(&worker)).unwrap();
    st.db.set_session_model_lock("p7-pinned",&json!({"model":"alpha","thinking":"low","approvalMode":"ask","approvalModeSource":"manager"})).unwrap();
    assert_ne!(call(&st,"p7-boss","set_conversation_permission",json!({"conversation":"p7-worker","mode":"auto"})).await["isError"],true);
    approve(&st).await;
    assert_eq!(st.db.agent_get(&worker).unwrap()["approvalMode"],"auto");
    // 1. A chat with no lock must not gain one (a lock would freeze today's model and effort).
    assert!(st.db.session_detail("p7-worker").unwrap()["modelLock"].is_null(),"approval must not create a lock");
    // 4. A chat that pinned its mode keeps its model and effort but follows the bot again.
    let pinned=st.db.session_detail("p7-pinned").unwrap()["modelLock"].clone();
    assert_eq!(pinned["model"],"alpha"); assert_eq!(pinned["thinking"],"low");
    assert!(pinned.get("approvalMode").is_none() && pinned.get("approvalModeSource").is_none(),"{pinned}");
    // Later bot changes reach both chats (a stale pin would freeze them).
    st.db.agent_update(&worker,&json!({"model":"beta"})).unwrap();
    crate::dispatch(&st,"agent.update",json!({"agentId":worker,"approvalMode":"ask"})).await.unwrap();
    let unpinned=crate::exec_options_for_session(&st,&st.db.session_detail("p7-worker").unwrap()).unwrap();
    assert_eq!(unpinned.model.as_deref(),Some("beta"),"2. changing the bot's model reaches a chat with no lock");
    assert_eq!(unpinned.approval_mode.as_str(),"ask");
    // 3. Changing the bot's permission reaches a chat that had a pin too.
    assert_eq!(crate::exec_options_for_session(&st,&st.db.session_detail("p7-pinned").unwrap()).unwrap().approval_mode.as_str(),"ask");
}

// P7 audit F5: a table built from the real schemas, so a future tool cannot be
// forgotten. Every P7 Manager-only tool is refused for an ordinary bot.
#[tokio::test]
async fn p7_every_manager_tool_is_refused_for_an_ordinary_bot() {
    let (st,_,_)=fixture().await;
    let mut names: Vec<String> = manager_tool_schemas().iter().filter_map(|tool| tool["name"].as_str().map(str::to_owned)).collect();
    names.extend(crate::proposals::tool_schemas().iter().filter_map(|tool| tool["name"].as_str().map(str::to_owned)));
    names.sort(); names.dedup();
    assert!(names.len()>=14,"the table must cover the whole P7 surface: {names:?}");
    for name in names {
        let result=call(&st,"p7-worker",&name,json!({})).await;
        assert_eq!(result["isError"],true,"{name} must be refused for an ordinary bot: {result}");
        assert!(result["content"][0]["text"].as_str().unwrap().contains("Only the Manager"),"{name}: {result}");
    }
    // The list/read tools an ordinary bot legitimately keeps stay available.
    assert_ne!(call(&st,"p7-worker","list_blobs",json!({})).await["isError"],true);
    assert_ne!(call(&st,"p7-worker","list_conversations",json!({})).await["isError"],true);
}

#[tokio::test]
async fn p7_permission_proposal_refuses_bypass() {
    let (st,boss,_)=fixture().await;
    st.db.set_session_link("p7-worker",&json!({"kind":"side","peerAgentId":boss,"originSessionId":"p7-boss"})).unwrap();
    let refused=call(&st,"p7-boss","set_conversation_permission",json!({"conversation":"p7-worker","mode":"bypass"})).await;
    assert_eq!(refused["isError"],true,"{refused}");
    assert!(st.db.proposals_pending().unwrap().is_empty());
}

// P7 audit F2/F7: the Manager's listing keeps who started it, the topic, the
// peer and the latest reply, newest first, and filters by project across case
// and slash differences.
#[tokio::test]
async fn p7_manager_conversations_carry_origin_topic_peer_and_reply() {
    let (st,boss,worker)=fixture().await;
    st.db.set_session_link("p7-worker",&json!({"kind":"side","peerAgentId":boss,"peerName":"Manager","originSessionId":"p7-boss","topic":"Check the build"})).unwrap();
    st.db.append_message_with_data("p7-worker","","assistant","Build is green",&json!({})).unwrap();
    let result=call(&st,"p7-boss","list_conversations",json!({"blob":worker})).await;
    let out: Value=serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    let row=out["conversations"].as_array().unwrap().iter().find(|row|row["id"]=="p7-worker").unwrap();
    assert_eq!(row["startedByYou"],true);
    assert_eq!(row["topic"],"Check the build");
    assert_eq!(row["peerName"],"Scout");
    assert_eq!(row["agentName"],"Scout");
    assert!(row["latestReply"].as_str().unwrap().contains("Build is green"));
    // An ordinary bot still reads the prose listing that says who started it.
    assert!(call(&st,"p7-worker","list_conversations",json!({})).await["content"][0]["text"].as_str().unwrap().contains("started it"));
}

#[tokio::test]
async fn p7_manager_conversations_are_newest_first_and_match_project_paths() {
    let (st,_,worker)=fixture().await;
    // The listing follows session_list (newest first) and is capped at 100.
    for n in 0..105 {
        let sid=format!("p7-many-{n:03}");
        st.db.create_session_for_agent(&sid,"p7-rt","codex",".","Many",Some(&worker)).unwrap();
        // A rename rewrites updated_at with a millisecond stamp, so the order is
        // deterministic rather than tied to the create path's timestamp format.
        st.db.session_rename(&sid,&format!("Many {n}")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let listed=call(&st,"p7-boss","list_conversations",json!({"blob":worker})).await;
    let out: Value=serde_json::from_str(listed["content"][0]["text"].as_str().unwrap()).unwrap();
    let ids: Vec<String>=out["conversations"].as_array().unwrap().iter().filter_map(|row|row["id"].as_str().map(str::to_owned)).collect();
    assert_eq!(ids.len(),100,"the listing is capped at 100");
    assert!(ids.contains(&"p7-many-104".to_owned()),"the newest row is present: {ids:?}");
    assert!(!ids.contains(&"p7-many-000".to_owned()),"rows past the cap are dropped");
    assert!(ids.iter().position(|id|id=="p7-many-104").unwrap()<ids.iter().position(|id|id=="p7-many-005").unwrap(),"newest first: {ids:?}");
    // The project filter compares folders across case and slash differences.
    let project=st.db.project_create("CaseProj",Some("C:/Temp/CaseProj")).unwrap().0;
    st.db.create_session_for_agent("p7-case","p7-rt","codex","c:\\temp\\caseproj\\","Case",Some(&worker)).unwrap();
    let filtered=call(&st,"p7-boss","list_conversations",json!({"project":project["id"]})).await;
    let out: Value=serde_json::from_str(filtered["content"][0]["text"].as_str().unwrap()).unwrap();
    let ids: Vec<&str>=out["conversations"].as_array().unwrap().iter().filter_map(|row|row["id"].as_str()).collect();
    assert!(ids.contains(&"p7-case"),"case- and slash-insensitive project filter: {ids:?}");
}

// P7 audit F3: the decision notes name the target, not its opaque id.
#[test]
fn p7_describe_prefers_display_names_over_ids() {
    use crate::proposals::describe;
    assert_eq!(describe("bot",&json!({"action":"update","blob":"id-1","targetName":"Scout"})),"update bot Scout");
    assert_eq!(describe("project",&json!({"action":"update","project":"id-2","targetName":"Portal"})),"update project Portal");
    assert_eq!(describe("task",&json!({"bot":"id-3","botName":"Scout"})),"assign a task to Scout");
    assert_eq!(describe("task",&json!({"action":"open","conversation":"id-4","title":"Release notes"})),"open the conversation \"Release notes\"");
    // Legacy cards without a stored name still read as the id.
    assert_eq!(describe("bot",&json!({"action":"update","blob":"id-5"})),"update bot id-5");
}

// P7 audit F6: an over-depth request is refused before a card is shown.
#[tokio::test]
async fn p7_depth_is_refused_before_a_card_is_shown() {
    let (st,_,worker)=fixture().await;
    st.team.set_depth("p7-boss",6);
    let result=call(&st,"p7-boss","assign_task",json!({"bot":worker,"brief":"Research","doneGoal":"Done","reportBack":"Evidence"})).await;
    assert_eq!(result["isError"],true);
    assert!(result["content"][0]["text"].as_str().unwrap().contains("too many bots"));
    assert!(st.db.proposals_pending().unwrap().is_empty(),"no card for a request that could never succeed");
}

