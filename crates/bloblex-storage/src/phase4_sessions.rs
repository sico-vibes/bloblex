//! Phase 4 storage, Gogo's lane: a project's repository identity (section 3) and, later, an
//! imported conversation (section 5). Sona's `machine_links` table lives in `phase4.rs`.
//!
//! A repository identity is derived, not the owner's: it is read from the project's folder when the
//! project is created, updated or cloned, and once at startup, so `project.list` never runs git. It
//! holds a host and a path only — never a user, a password or a token — and it is the one project
//! field that crosses to another machine.

use super::{params, project_rows, push_team_event, Connection, SecondsFormat, Storage, StorageError, TransactionBehavior, Utc};
use serde_json::{json, Value};

/// Additive and idempotent, like every other `ensure_*` schema.
pub(super) fn ensure_phase4_sessions_schema(c: &Connection) -> Result<(), StorageError> {
    let has_repo_identity: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('projects') WHERE name='repo_identity')", [], |r| r.get(0))?;
    if !has_repo_identity { c.execute("ALTER TABLE projects ADD COLUMN repo_identity TEXT", [])?; }
    Ok(())
}

impl Storage {
    /// Store the repository identity read from the project's folder; `None` clears it. No event and
    /// no `updated_at`: it follows the folder rather than being an owner edit.
    pub fn project_set_repo_identity(&self, id: &str, identity: Option<&str>) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("UPDATE projects SET repo_identity=?2 WHERE id=?1", params![id, identity])?;
        Ok(())
    }
    /// Insert a conversation taken from another machine under its own id. Coming back to a machine
    /// that already has the row updates it instead — its own `created_at` and every message it has are
    /// kept, and its provider session is cleared so the provider starts a fresh context. One
    /// transaction: a refused row inserts nothing.
    pub fn session_import(&self, row: &Value) -> Result<(), StorageError> {
        let id = row["id"].as_str().map(str::trim).filter(|id| !id.is_empty() && id.chars().count() <= 200).ok_or(StorageError::InvalidAgent)?;
        let provider = row["provider"].as_str().map(str::trim).filter(|provider| !provider.is_empty() && provider.chars().count() <= 40).ok_or(StorageError::InvalidAgent)?;
        let runtime_id = row["runtimeId"].as_str().map(str::trim).filter(|runtime| !runtime.is_empty() && runtime.chars().count() <= 200).ok_or(StorageError::InvalidAgent)?;
        let title = row["title"].as_str().unwrap_or("").trim();
        let title: String = title.chars().take(500).collect();
        let project = row["projectPath"].as_str().unwrap_or("");
        let state = row["state"].as_str().filter(|state| ["idle", "starting", "completed", "failed"].contains(state)).unwrap_or("idle");
        let link = row.get("link").filter(|link| link.is_object()).cloned().ok_or(StorageError::InvalidAgent)?;
        let agent = row["agentId"].as_str().filter(|agent| !agent.is_empty());
        let created = row["createdAt"].as_str().map(str::trim).filter(|created| !created.is_empty()).unwrap_or("").to_owned();
        let created = if created.is_empty() { Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true) } else { created };
        let mut data = row.get("data").filter(|data| data.is_object()).cloned().unwrap_or_else(|| json!({}));
        data["link"] = link;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(agent) = agent {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1 AND archived=0)", [agent], |r| r.get(0))?;
            if !exists { return Err(StorageError::AgentNotFound); }
        }
        tx.execute(
            "INSERT INTO sessions(id,runtime_id,provider,project_path,title,state,created_at,updated_at,agent_id,provider_session_id,resumable,data) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,0,?10)
             ON CONFLICT(id) DO UPDATE SET runtime_id=excluded.runtime_id,provider=excluded.provider,project_path=excluded.project_path,title=excluded.title,state=excluded.state,agent_id=excluded.agent_id,provider_session_id=NULL,resumable=0,data=excluded.data,updated_at=excluded.updated_at",
            params![id, runtime_id, provider, project, title, state, created, now, agent, data.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }
    /// Insert the messages that came with an imported conversation, in one transaction: a message id
    /// that is already here is skipped, the rest take the next sequence numbers in the order given and
    /// keep their own `created_at`. A refused message leaves nothing behind.
    pub fn session_import_messages(&self, session_id: &str, messages: &Value) -> Result<Value, StorageError> {
        let messages = messages.as_array().ok_or(StorageError::InvalidAgent)?;
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session_id], |r| r.get(0))?;
        if !exists { return Err(StorageError::AgentNotFound); }
        let mut sequence: i64 = tx.query_row("SELECT COALESCE(MAX(sequence),0) FROM messages WHERE session_id=?1", [session_id], |r| r.get(0))?;
        let (mut inserted, mut skipped) = (0usize, 0usize);
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        for message in messages {
            let id = message["id"].as_str().map(str::trim).filter(|id| !id.is_empty() && id.chars().count() <= 200).ok_or(StorageError::InvalidAgent)?;
            let role = message["role"].as_str().filter(|role| ["user", "assistant", "notice"].contains(role)).ok_or(StorageError::InvalidAgent)?;
            let content = message["content"].as_str().ok_or(StorageError::InvalidAgent)?;
            let created = message["createdAt"].as_str().map(str::trim).filter(|created| !created.is_empty()).map(str::to_owned).unwrap_or_else(|| now.clone());
            let here: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE id=?1)", [id], |r| r.get(0))?;
            if here { skipped += 1; continue; }
            sequence += 1;
            tx.execute(
                "INSERT INTO messages(id,session_id,turn_id,sequence,role,content,created_at,data) VALUES(?1,?2,NULL,?3,?4,?5,?6,'{}')",
                params![id, session_id, sequence, role, content, created],
            )?;
            inserted += 1;
        }
        tx.commit()?;
        Ok(json!({"inserted": inserted, "skipped": skipped}))
    }
    /// The one way the `.bitbots.json` the owner trusted changes: `Some(hash)` trusts that content,
    /// `None` withdraws it. It is not reachable through `project.update`, whose overrides validator
    /// refuses the key, so trust can only come from `project.sharedSettings.trust` and `.write`.
    pub fn project_set_trusted_shared_hash(&self, id: &str, hash: Option<&str>) -> Result<(Value, Vec<Value>), StorageError> {
        if hash.is_some_and(|hash| hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))) { return Err(StorageError::InvalidAgent); }
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)", [id], |r| r.get(0))?;
        if !exists { return Err(StorageError::AgentNotFound); }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        match hash {
            Some(hash) => tx.execute("UPDATE projects SET overrides_json=json_set(CASE WHEN json_valid(overrides_json) THEN overrides_json ELSE '{}' END,'$.trustedSharedHash',?2),updated_at=?3 WHERE id=?1", params![id, hash, now])?,
            None => tx.execute("UPDATE projects SET overrides_json=json_remove(CASE WHEN json_valid(overrides_json) THEN overrides_json ELSE '{}' END,'$.trustedSharedHash'),updated_at=?2 WHERE id=?1", params![id, now])?,
        };
        let project = project_rows(&tx)?.into_iter().find(|project| project["id"] == id).ok_or(StorageError::AgentNotFound)?;
        let event = push_team_event(&tx, "project.changed", &json!({"action":"updated","project":project}))?;
        tx.commit()?;
        Ok((project, vec![event]))
    }
}
