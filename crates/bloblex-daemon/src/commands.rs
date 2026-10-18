//! Slash commands: the hidden per-turn `<bloblex_command>` directive a chosen
//! skill or Manager command adds to the prompt. The user's message is stored
//! and shown exactly as typed (for example `/interview` or
//! `/code-review check the parser`); this directive is a per-turn prompt suffix
//! (the same mechanism as `<bloblex_skills>` / `<bloblex_manager>`) and is
//! never persisted.
//!
//! A command is `{ kind: "skill" | "manager", name: string }` on
//! `session.prompt`. Unknown or switched-off skills, and Manager commands sent
//! to a bot that is not the Manager, are refused with `invalid_argument`.

use axum::http::StatusCode;
use serde_json::Value;

use crate::{derr, skills, AppState, DispatchError};

/// The Manager's own commands, each with the instruction it contributes for the
/// turn. They are offered to, and accepted from, only the Manager.
const MANAGER_COMMANDS: &[(&str, &str)] = &[
    (
        "interview",
        "Run or continue your personalisation interview: ask the user your questions with ask_user (one card at a time) and save each answer with remember_about_user as soon as you have it.",
    ),
    (
        "onboard",
        "Onboard a project. Run your project interview with the user, then propose the project with propose_project and a team with propose_bot.",
    ),
    (
        "team",
        "Propose a team of bots for the project the user chooses. Propose each one with propose_bot and explain its responsibility; ask before creating anything.",
    ),
    (
        "status",
        "Summarise the state of every project: its bots, open tasks and anything waiting for the user's approval. Use list_projects and project_status.",
    ),
    (
        "playbook",
        "Review your own playbook and propose improvements with update_playbook. It is a proposal the user must approve.",
    ),
    (
        "remember",
        "Save what follows this command as a fact about the user with remember_about_user.",
    ),
];

fn invalid(message: impl Into<String>) -> DispatchError {
    let message = message.into();
    derr("invalid_argument", &message, StatusCode::BAD_REQUEST)
}

/// True when this session's bot is the built-in Manager.
pub fn is_manager_session(st: &AppState, session_id: &str) -> bool {
    let Ok(row) = st.db.session_detail(session_id) else { return false };
    let Some(agent_id) = row["agentId"].as_str().filter(|id| !id.is_empty()) else { return false };
    st.db
        .agent_get(agent_id)
        .map(|agent| agent["systemRole"].as_str() == Some("manager") && agent["archived"] != true)
        .unwrap_or(false)
}

/// Validate the optional `command` parameter for a prompt and return the hidden
/// `<bloblex_command>` directive to append to the provider prompt, or `None`
/// when no command was sent.
pub fn directive(st: &AppState, session_id: &str, value: &Value) -> Result<Option<String>, DispatchError> {
    if value.is_null() {
        return Ok(None);
    }
    let object = value.as_object().ok_or_else(|| invalid("command must be an object with a kind and a name"))?;
    let kind = object.get("kind").and_then(Value::as_str).unwrap_or("");
    let name = object.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if name.is_empty() {
        return Err(invalid("command.name is required"));
    }
    match kind {
        "skill" => {
            if !skills::valid_skill_name(name) {
                return Err(invalid("That is not a valid skill name."));
            }
            let agent_id = st
                .db
                .session_detail(session_id)
                .ok()
                .and_then(|row| row["agentId"].as_str().filter(|id| !id.is_empty()).map(str::to_owned));
            if !skills::usable_for_agent(st, agent_id.as_deref(), name) {
                return Err(invalid(format!("The skill \"{name}\" is not available to this bot.")));
            }
            Ok(Some(format!(
                "\n\n<bloblex_command>Load the skill \"{name}\" with load_skill now and follow it for this message.</bloblex_command>"
            )))
        }
        "manager" => {
            if !is_manager_session(st, session_id) {
                return Err(invalid("That command is only for the Manager."));
            }
            let instruction = MANAGER_COMMANDS
                .iter()
                .find(|(candidate, _)| *candidate == name)
                .map(|(_, text)| *text)
                .ok_or_else(|| invalid(format!("There is no Manager command \"/{name}\".")))?;
            Ok(Some(format!("\n\n<bloblex_command>{instruction}</bloblex_command>")))
        }
        _ => Err(invalid("command.kind must be \"skill\" or \"manager\"")),
    }
}
