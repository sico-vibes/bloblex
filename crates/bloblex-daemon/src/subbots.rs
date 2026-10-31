//! Phase 8: sub-bots. A bot can start up to five helpers at once, each on a model
//! of its own, and read what they find when they finish.
//!
//! A sub-bot is a hidden bot row with a `parentAgentId`, started through the same
//! path as `message_blob` (`team::delegate_subbot`): a side conversation, a ledger
//! row, and its reply relayed to the parent as `[Reply from X]`. So the ledger,
//! Stop (`cancel_turn_group`) and the restart handling already cover it. The row is
//! left out of every roster, backup and tool list that counts bots.

use crate::{agent_error, derr, AppState, DispatchError, ModePin};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// Sub-bots one bot may have running or waiting, and one conversation may start.
const PER_BOT: usize = 5;
const PER_CONVERSATION: usize = 20;
/// Sub-bots one call may start.
const PER_CALL: usize = 5;

pub fn tool_schemas(noun: &str) -> Vec<Value> {
    vec![
        json!({"name":"list_models","description":format!("List the models you can give a sub-bot: every model of every signed-in coding agent on this computer, with the efforts each accepts. It reads what Bitbots already knows and never contacts a provider. Use it before spawn_subbots when you are unsure of a model's name."),"inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"spawn_subbots","description":format!("Start 1 to {PER_CALL} sub-bots, each its own {noun} with a conversation the user can open, read, message and stop. Give each one a self-contained `brief` and a `model`: an id from list_models, or a word from one, such as \"haiku\" (it must match exactly one model; otherwise nothing starts). A sub-bot can run on a different provider than you. Every entry is checked before any starts. It returns at once; each sub-bot's result arrives later in this conversation as a message starting with \"[Reply from <name>]\". After spawning, tell the user briefly who is doing what and end your turn. Sub-bots cannot start sub-bots, and they work with no more access than this conversation has."),"inputSchema":{"type":"object","properties":{
            "bots":{"type":"array","minItems":1,"maxItems":PER_CALL,"description":"The sub-bots to start.","items":{"type":"object","properties":{
                "brief":{"type":"string","description":"A self-contained brief: goal, context, paths, constraints and what to send back."},
                "model":{"type":"string","description":"A model id from list_models, or a word from one (for example \"haiku\")."},
                "thinking":{"type":"string","description":"The effort, one of the model's efforts from list_models (optional)."},
                "name":{"type":"string","description":"A short name (optional)."},
                "role":{"type":"string","description":"One sentence on what this sub-bot is for (optional)."},
                "topic":{"type":"string","description":"A short title of 3 to 6 words for its conversation (optional)."},
                "doneGoal":{"type":"string","description":"What must be true for its work to count as done. It is relayed back with the reply (optional)."}
            },"required":["brief","model"],"additionalProperties":false}},
            "project":{"type":"string","description":"The project (an id or exact name) the sub-bots work in. Defaults to the project of this conversation."}
        },"required":["bots"],"additionalProperties":false}}),
    ]
}

/// Whether a conversation belongs to a sub-bot (by its link or by its bot).
pub fn is_subbot_session(st: &AppState, session_id: &str) -> bool {
    let Ok(row) = st.db.session_brief(session_id) else { return false };
    row["link"]["subbot"] == true
        || row["agentId"].as_str().and_then(|id| st.db.agent_get(id).ok()).is_some_and(|agent| !agent["parentAgentId"].is_null())
}

fn norm(text: &str) -> String { text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect() }

/// One model a sub-bot could run, with the runtime that serves it.
#[derive(Clone, Debug)]
struct ModelRow { provider: String, runtime_id: String, id: String, name: String, efforts: Vec<String> }

/// Every model of every signed-in runtime, from the cache and the owner's custom
/// names. A provider with nothing cached yet lists nothing; nothing is probed.
fn model_rows(st: &AppState, runtimes: &[Value]) -> Vec<ModelRow> {
    let mut rows: Vec<ModelRow> = Vec::new();
    let mut seen = BTreeSet::new();
    for runtime in runtimes {
        if !crate::catalog::runtime_usable(runtime) || runtime["authState"] == "sign_in_failed" { continue; }
        let provider = runtime["provider"].as_str().unwrap_or("").to_owned();
        let Some(runtime_id) = runtime["id"].as_str().map(str::to_owned) else { continue };
        // One runtime per provider is enough: its catalog is the provider's.
        if provider.is_empty() || !seen.insert(provider.clone()) { continue; }
        let mut catalog = crate::catalog::cached(st, runtime).map(|served| served.value).unwrap_or_else(|| json!({"models":[]}));
        crate::custom_models::append_to(st, &mut catalog, &provider);
        for model in catalog["models"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let Some(id) = model["id"].as_str().filter(|id| !id.is_empty()) else { continue };
            if rows.iter().any(|row| row.provider == provider && row.id == id) { continue; }
            let efforts = model["supportedThinking"].as_array().map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
            rows.push(ModelRow { provider: provider.clone(), runtime_id: runtime_id.clone(), id: id.to_owned(), name: model["displayName"].as_str().unwrap_or(id).to_owned(), efforts });
        }
    }
    rows
}

fn similarity(wanted: &str, row: &ModelRow) -> usize {
    let (wanted, id) = (norm(wanted), norm(&row.id));
    if wanted.is_empty() { return 0; }
    // The longest run of the wanted text found in the id, by shrinking windows.
    (1..=wanted.len()).rev().find(|&len| wanted.as_bytes().windows(len).any(|part| std::str::from_utf8(part).is_ok_and(|part| id.contains(part)))).unwrap_or(0)
}

fn closest(wanted: &str, rows: &[ModelRow]) -> String {
    let mut ranked: Vec<&ModelRow> = rows.iter().collect();
    ranked.sort_by(|a, b| similarity(wanted, b).cmp(&similarity(wanted, a)).then(a.id.len().cmp(&b.id.len())).then(a.id.cmp(&b.id)));
    ranked.iter().take(4).map(|row| format!("{} ({})", row.id, row.provider)).collect::<Vec<_>>().join(", ")
}

/// A model as a person would say it: an id, or a word from one. A word must match
/// exactly one model on this machine, preferring the parent's provider.
fn resolve_model(rows: &[ModelRow], wanted: &str, parent_provider: &str) -> Result<ModelRow, String> {
    let wanted = wanted.trim();
    if wanted.is_empty() { return Err("model is required for every sub-bot.".into()); }
    if rows.is_empty() { return Err("No models are listed on this machine yet, so no sub-bot can be started. Open a bot's model picker once, or ask the user to sign in to a coding agent.".into()); }
    let key = norm(wanted);
    let lower = wanted.to_lowercase();
    let exact: Vec<&ModelRow> = rows.iter().filter(|row| row.id.to_lowercase() == lower).collect();
    let mut found: Vec<&ModelRow> = if exact.is_empty() { rows.iter().filter(|row| !key.is_empty() && (norm(&row.id).contains(&key) || norm(&row.name).contains(&key))).collect() } else { exact };
    if found.is_empty() {
        return Err(format!("No model on this machine matches \"{wanted}\". Closest: {}. Call list_models to see them all; nothing was started.", closest(wanted, rows)));
    }
    if found.iter().any(|row| row.provider == parent_provider) { found.retain(|row| row.provider == parent_provider); }
    match found.as_slice() {
        [only] => Ok((*only).clone()),
        many => Err(format!("\"{wanted}\" matches several models: {}. Use one full id; nothing was started.", many.iter().take(6).map(|row| format!("{} ({})", row.id, row.provider)).collect::<Vec<_>>().join(", "))),
    }
}

pub async fn list_models_tool(st: &AppState, session_id: &str) -> Result<String, String> {
    if is_subbot_session(st, session_id) { return Err("A sub-bot cannot use this tool.".into()); }
    let runtimes = st.runtimes.read().await.clone();
    let models = model_rows(st, &runtimes).into_iter().map(|row| json!({"provider":row.provider,"id":row.id,"name":row.name,"efforts":row.efforts})).collect::<Vec<_>>();
    Ok(json!({"models": models}).to_string())
}

fn text_arg(entry: &Value, key: &str, limit: usize) -> Result<Option<String>, String> {
    let Some(value) = entry.get(key).filter(|value| !value.is_null()) else { return Ok(None) };
    let text = value.as_str().ok_or_else(|| format!("{key} must be a string."))?.trim();
    if text.is_empty() { return Ok(None); }
    if text.chars().count() > limit { return Err(format!("{key} must be at most {limit} characters.")); }
    Ok(Some(text.to_owned()))
}

/// The parent conversation's launch access, which a sub-bot is pinned to.
fn parent_access(st: &AppState, session: &Value) -> Result<ModePin, String> {
    let options = crate::exec_options_for_session(st, session).map_err(|error| error.1.message)?;
    let mut mode = options.approval_mode.as_str().to_owned();
    // Full access stays Full access only when the owner started this turn. A turn a
    // teammate's reply woke (its hop depth is above zero) is capped at Auto.
    if mode == "bypass" && st.team.depth_of(session["id"].as_str().unwrap_or("")) > 0 { mode = "auto".into(); }
    Ok(ModePin { mode, plan: options.plan_mode })
}

/// A sub-bot's visible name: the given one, else its role, else "<Parent> helper N";
/// unique among the parent's, and across this call.
fn pick_name(parent: &str, given: Option<&str>, role: Option<&str>, taken: &mut BTreeSet<String>) -> String {
    let base: String = given.or(role).map(|name| name.chars().take(52).collect()).unwrap_or_default();
    let mut n = 1usize;
    loop {
        let candidate = if !base.is_empty() { if n == 1 { base.clone() } else { format!("{base} {n}") } } else { format!("{} helper {n}", parent.chars().take(40).collect::<String>()) };
        if taken.insert(candidate.to_lowercase()) { return candidate; }
        n += 1;
    }
}

struct Plan { brief: String, model: ModelRow, thinking: Option<String>, name: Option<String>, role: Option<String>, topic: Option<String>, done_goal: Option<String> }

pub async fn spawn_tool(st: &AppState, session_id: &str, args: &Value) -> Result<String, String> {
    if is_subbot_session(st, session_id) { return Err("A sub-bot cannot start sub-bots. Do the work yourself, or report back what you need.".into()); }
    let session = st.db.session_detail(session_id).map_err(|_| "This conversation is no longer available.")?;
    if session["archived"] == true { return Err("This conversation is archived.".into()); }
    // Unattended parents cannot grant access nobody is watching: an automation, a
    // board-task run, or a conversation another bot handed this one.
    let kind = session["link"]["kind"].as_str().unwrap_or("");
    if crate::is_unattended(&session["link"]) || matches!(kind, "automation" | "task") {
        return Err("Sub-bots can't be started from an unattended run, because nobody is watching to stop them. Do the work yourself, or report what you found.".into());
    }
    if kind == "side" {
        return Err("Sub-bots can't be started from a conversation another bot handed you. Do the work yourself, or report back what you need.".into());
    }
    let parent_id = session["agentId"].as_str().ok_or("Only a bot's conversation can start sub-bots.")?.to_owned();
    let parent = st.db.agent_get(&parent_id).map_err(|_| "Your bot is no longer available.")?;
    if parent["archived"] == true { return Err("This bot is archived.".into()); }
    if st.db.delegation_paused().unwrap_or(false) { return Err("Delegation is paused. Ask the user to resume it in Manager settings, or do the work yourself.".into()); }
    let entries = args["bots"].as_array().ok_or("bots must be a list of 1 to 5 sub-bots.")?;
    if entries.is_empty() || entries.len() > PER_CALL { return Err(format!("bots must hold 1 to {PER_CALL} sub-bots; {} were given.", entries.len())); }

    // Every entry is checked before any starts.
    let runtimes = st.runtimes.read().await.clone();
    let rows = model_rows(st, &runtimes);
    let parent_provider = runtimes.iter().find(|runtime| runtime["id"] == parent["runtimeId"]).and_then(|runtime| runtime["provider"].as_str()).unwrap_or("").to_owned();
    let mut plans = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let at = |message: String| if entries.len() > 1 { format!("Sub-bot {}: {message}", index + 1) } else { message };
        if !entry.is_object() { return Err(at("each entry must be an object.".into())); }
        let brief = text_arg(entry, "brief", 200_000).map_err(&at)?.ok_or_else(|| at("brief is required.".into()))?;
        let model = resolve_model(&rows, entry["model"].as_str().unwrap_or(""), &parent_provider).map_err(&at)?;
        let thinking = text_arg(entry, "thinking", 40).map_err(&at)?;
        if let Some(effort) = &thinking {
            if !model.efforts.is_empty() && !model.efforts.iter().any(|known| known == effort) {
                return Err(at(format!("{} takes the efforts {}, not \"{effort}\"; nothing was started.", model.id, model.efforts.join(", "))));
            }
        }
        plans.push(Plan {
            brief, model, thinking,
            name: text_arg(entry, "name", 60).map_err(&at)?,
            role: text_arg(entry, "role", 200).map_err(&at)?,
            topic: text_arg(entry, "topic", 80).map_err(&at)?,
            done_goal: text_arg(entry, "doneGoal", 2_000).map_err(&at)?,
        });
    }
    let project = text_arg(args, "project", 200)?;
    let project_args = json!({"project": project});
    crate::team::delegation_project(st, &project_args, &session, &parent)?;
    let pin = parent_access(st, &session)?;

    // A call replayed in the same turn (same brief, same parent) answers with the
    // sub-bots that already exist instead of starting more.
    let turn = st.active_turns.lock().await.get(session_id).cloned();
    let owned = st.db.subbot_delegations(&parent_id).map_err(|error| error.to_string())?;
    let previews: Vec<String> = plans.iter().map(|plan| plan.brief.chars().take(280).collect()).collect();
    let replay = |preview: &str| turn.as_deref().and_then(|turn| owned.iter().find(|row| row["originSessionId"] == session_id && row["originTurnId"] == turn && row["briefPreview"] == preview));
    let fresh = previews.iter().filter(|preview| replay(preview).is_none()).count();

    let live = owned.iter().filter(|row| matches!(row["status"].as_str(), Some("queued" | "running"))).count();
    if live + fresh > PER_BOT {
        return Err(format!("You already have {live} sub-bots running or waiting, and at most {PER_BOT} may be at once, so these {fresh} were not started. Wait for some to finish, or ask the user to stop one."));
    }
    let here = owned.iter().filter(|row| row["originSessionId"] == session_id).count();
    if here + fresh > PER_CONVERSATION {
        return Err(format!("This conversation has already started {here} sub-bots, and at most {PER_CONVERSATION} may be started in one conversation, so these {fresh} were not started. Report what you have, or ask the user to continue in a new conversation."));
    }

    let mut taken: BTreeSet<String> = st.db.subbot_agents(Some(&parent_id)).map_err(|error| error.to_string())?
        .iter().filter(|agent| agent["archived"] != true).filter_map(|agent| agent["name"].as_str().map(str::to_lowercase)).collect();
    let parent_name = parent["name"].as_str().unwrap_or("Bot").to_owned();
    let refs = st.db.env_refs_get(&parent_id).unwrap_or_default();
    let mut results = Vec::new();
    for (plan, preview) in plans.into_iter().zip(previews) {
        if let Some(row) = replay(&preview) {
            results.push(report(st, row));
            continue;
        }
        let same_provider = plan.model.provider == parent_provider;
        let name = pick_name(&parent_name, plan.name.as_deref(), plan.role.as_deref(), &mut taken);
        let mut instructions = parent["instructions"].as_str().unwrap_or("").trim().to_owned();
        if let Some(role) = &plan.role {
            if !instructions.is_empty() { instructions.push_str("\n\n"); }
            instructions.push_str(&format!("Your role here: {}.", role.trim_end_matches('.')));
        }
        let mut fields = json!({
            "name": name, "runtimeId": plan.model.runtime_id, "model": plan.model.id, "thinking": plan.thinking,
            "approvalMode": pin.mode, "instructions": instructions, "color": parent["color"],
            "description": format!("A sub-bot of {parent_name}."),
            "role": plan.role.as_deref().map(|role| role.chars().take(40).collect::<String>()).unwrap_or_default(),
        });
        if !parent["look"].is_null() { fields["look"] = parent["look"].clone(); }
        if same_provider && !parent["accountId"].is_null() { fields["accountId"] = parent["accountId"].clone(); }
        let (agent, events) = st.db.subbot_create(&parent_id, &fields).map_err(agent_error_text)?;
        st.broadcast_persisted(events);
        let agent_id = agent["id"].as_str().unwrap_or("").to_owned();
        if same_provider && !refs.is_empty() { let _ = st.db.env_refs_set(&agent_id, &refs); }
        let mut call = json!({"message": plan.brief});
        for (key, value) in [("topic", plan.topic), ("doneGoal", plan.done_goal), ("project", project.clone())] { if let Some(value) = value { call[key] = json!(value); } }
        let spawn = crate::team::SubbotSpawn { target: agent.clone(), pin: ModePin { mode: pin.mode.clone(), plan: pin.plan } };
        match crate::team::delegate_subbot(st, session_id, &call, &spawn).await {
            Ok(delegation) => {
                let row = st.db.delegation_list_for_side(&delegation.side).ok().and_then(|rows| rows.last().cloned());
                results.push(match row {
                    Some(row) => report(st, &row),
                    None => json!({"agentId":agent_id,"name":name,"provider":plan.model.provider,"model":plan.model.id,"sessionId":delegation.side,"delegationId":Value::Null,"status":if delegation.started { "running" } else { "queued" }}),
                });
            }
            Err(error) => {
                // The helper could not start; it is archived so nothing is left behind.
                if let Ok((_, events)) = st.db.agent_archive(&agent_id) { st.broadcast_persisted(events); }
                results.push(json!({"agentId":agent_id,"name":name,"provider":plan.model.provider,"model":plan.model.id,"sessionId":Value::Null,"delegationId":Value::Null,"status":"failed","error":error}));
            }
        }
    }
    let started = results.iter().filter(|row| row["status"] != "failed").count();
    let queued = results.iter().filter(|row| row["status"] == "queued").count();
    let mut out = json!({"subbots": results});
    out["note"] = json!(format!("{started} sub-bot{} started{}. Each result arrives here later as a message starting with \"[Reply from <name>]\". Tell the user briefly who is doing what and end your turn now.", if started == 1 { "" } else { "s" }, if queued > 0 { format!(" ({queued} waiting for a free slot)") } else { String::new() }));
    Ok(out.to_string())
}

fn agent_error_text(error: bloblex_storage::StorageError) -> String {
    match error {
        bloblex_storage::StorageError::AgentConflict => "A sub-bot could not be created for this bot.".into(),
        other => other.to_string(),
    }
}

/// The reply shape for one sub-bot from its ledger row.
fn report(st: &AppState, row: &Value) -> Value {
    let agent = row["targetAgentId"].as_str().and_then(|id| st.db.agent_get(id).ok()).unwrap_or(Value::Null);
    let provider = st.db.session_brief(row["sideSessionId"].as_str().unwrap_or("")).ok().map(|brief| brief["provider"].clone());
    json!({"agentId":row["targetAgentId"],"name":agent["name"],"provider":provider,"model":agent["model"],"sessionId":row["sideSessionId"],"delegationId":row["id"],"status":row["status"]})
}

/// `subbot.list`: the fleet of one conversation or of one bot, with each status
/// read from the ledger.
pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    if method != "subbot.list" { return Err(derr("not_found", "unknown sub-bot method", StatusCode::NOT_FOUND)); }
    let session_id = p["sessionId"].as_str().filter(|id| !id.is_empty());
    let agent_id = p["agentId"].as_str().filter(|id| !id.is_empty());
    if session_id.is_none() && agent_id.is_none() { return Err(derr("invalid_argument", "sessionId or agentId is required", StatusCode::BAD_REQUEST)); }
    let parent_ids: Vec<String> = match (agent_id, session_id) {
        (Some(agent), _) => { st.db.agent_get(agent).map_err(agent_error)?; vec![agent.to_owned()] }
        (None, Some(session)) => {
            let row = st.db.session_detail(session).map_err(|_| derr("not_found", "Conversation not found.", StatusCode::NOT_FOUND))?;
            row["agentId"].as_str().map(|id| vec![id.to_owned()]).unwrap_or_default()
        }
        _ => Vec::new(),
    };
    let mut subbots = Vec::new();
    for parent in &parent_ids {
        for row in st.db.subbot_delegations(parent).map_err(agent_error)? {
            if session_id.is_some_and(|session| row["originSessionId"] != session) { continue; }
            subbots.push(describe(st, parent, &row));
        }
    }
    Ok(json!({"subbots": subbots}))
}

fn describe(st: &AppState, parent: &str, row: &Value) -> Value {
    let agent = row["targetAgentId"].as_str().and_then(|id| st.db.agent_get(id).ok()).unwrap_or(Value::Null);
    let side = row["sideSessionId"].as_str().unwrap_or("");
    let brief = st.db.session_brief(side).unwrap_or(Value::Null);
    let running = row["status"] == "running";
    let doing = if running {
        let waiting = brief["state"] == "waiting_permission";
        Some(if waiting { "Waiting for approval".to_owned() } else { st.db.running_tool_title(side).ok().flatten().unwrap_or_else(|| "Working".to_owned()) })
    } else { None };
    // The role is in the instructions; the row keeps its first 40 characters.
    json!({
        "agentId": row["targetAgentId"], "parentAgentId": parent, "originSessionId": row["originSessionId"],
        "name": agent["name"], "role": agent["role"], "provider": brief["provider"], "model": agent["model"], "thinking": agent["thinking"],
        "sessionId": row["sideSessionId"], "delegationId": row["id"], "status": row["status"],
        "doingNow": doing, "startedAt": row["startedAt"].as_str().or(row["createdAt"].as_str()), "finishedAt": row["finishedAt"], "error": row["error"],
    })
}

/// Stops and archives the sub-bots in `rows` (ledger rows): live ones are
/// cancelled first, then each conversation is archived.
async fn stop_and_archive(st: &AppState, rows: Vec<Value>) {
    let mut origins: Vec<String> = rows.iter().filter_map(|row| row["originSessionId"].as_str().map(str::to_owned)).collect();
    origins.sort();
    origins.dedup();
    for origin in origins {
        let live: Vec<String> = rows.iter().filter(|row| row["originSessionId"] == origin.as_str() && !crate::delegations::is_terminal(row)).filter_map(|row| row["id"].as_str().map(str::to_owned)).collect();
        if !live.is_empty() { let _ = crate::delegations::rpc(st, "delegation.cancelGroup", &json!({"originSessionId": origin, "delegationIds": live})).await; }
    }
    for row in rows {
        let Some(side) = row["sideSessionId"].as_str() else { continue };
        if let Ok(updated) = st.db.session_archive(side, true) { st.emit("session.changed", updated).await; }
    }
}

/// Deleting a parent bot archives its sub-bots, and stops any still working.
pub async fn archive_for_agent(st: &AppState, parent_id: &str) {
    let rows = st.db.subbot_delegations(parent_id).unwrap_or_default();
    stop_and_archive(st, rows).await;
    if let Ok((_, events)) = st.db.subbot_archive_all(parent_id) { st.broadcast_persisted(events); }
}

/// Archiving or deleting one conversation archives the sub-bot conversations it started.
pub async fn archive_for_session(st: &AppState, origin: &str) {
    let Ok(row) = st.db.session_brief(origin) else { return };
    let Some(parent) = row["agentId"].as_str() else { return };
    let rows = st.db.subbot_delegations(parent).unwrap_or_default().into_iter().filter(|delegation| delegation["originSessionId"] == origin).collect();
    stop_and_archive(st, rows).await;
}

#[cfg(test)]
pub(crate) fn test_resolve(rows: &[(String, String)], wanted: &str, parent_provider: &str) -> Result<String, String> {
    let rows: Vec<ModelRow> = rows.iter().map(|(provider, id)| ModelRow { provider: provider.clone(), runtime_id: "rt".into(), id: id.clone(), name: id.clone(), efforts: Vec::new() }).collect();
    resolve_model(&rows, wanted, parent_provider).map(|row| row.id)
}
