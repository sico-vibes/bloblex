//! Phase 8 storage: sub-bots.
//!
//! A sub-bot is a hidden `agents` row with a `parent_agent_id`. It is created in
//! one transaction with its parent's look and instructions already applied by the
//! caller, and its `name_key` carries the row id, so two parents' "helper 1" never
//! collide on the global unique-name index while the visible name stays plain.

use super::{
    agent_read, insert_agent, params, push_agent_event, Connection, SecondsFormat, Storage, StorageError,
    OptionalExtension, TransactionBehavior, Utc,
};
use serde_json::Value;

/// Additive and idempotent, like every other `ensure_*` schema.
pub(super) fn ensure_phase8_schema(c: &Connection) -> Result<(), StorageError> {
    let has: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='parent_agent_id')",
        [],
        |r| r.get(0),
    )?;
    if !has {
        c.execute_batch("ALTER TABLE agents ADD COLUMN parent_agent_id TEXT")?;
    }
    c.execute_batch("CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id) WHERE parent_agent_id IS NOT NULL;")?;
    Ok(())
}

impl Storage {
    /// Creates a hidden sub-bot of `parent_id`. `input` is an ordinary agent
    /// create body (name, runtimeId, model, thinking, approvalMode, instructions,
    /// color, look, role, accountId).
    pub fn subbot_create(&self, parent_id: &str, input: &Value) -> Result<(Value, Vec<Value>), StorageError> {
        super::validate_agent_fields(input, true)?;
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let parent = agent_read(&tx, parent_id)?;
        // No depth: a sub-bot never has sub-bots, and the Manager never does.
        if !parent["parentAgentId"].is_null() || parent["archived"] == true { return Err(StorageError::AgentConflict); }
        let runtime = input["runtimeId"].as_str().unwrap_or("");
        if !super::runtime_exists(&tx, runtime)? { return Err(StorageError::AgentNotFound); }
        let id = super::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let name = input["name"].as_str().unwrap_or("").trim().to_owned();
        let key = format!("{}\u{1f}{id}", name.to_lowercase());
        // Sub-bots never join a roster, but the table wants a unique order per
        // runtime. They count up from two billion, far above any bot a person can
        // see, and every query that places a visible bot leaves them out.
        let pos: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order),1999999999)+1 FROM agents WHERE runtime_id=?1 AND parent_agent_id IS NOT NULL", [runtime], |r| r.get(0))?;
        insert_agent(&tx, &id, input, &name, &key, pos, &now)?;
        tx.execute("UPDATE agents SET hidden=1,parent_agent_id=?2 WHERE id=?1", params![id, parent_id])?;
        let agent = agent_read(&tx, &id)?;
        let event = push_agent_event(&tx, "created", &agent)?;
        tx.commit()?;
        Ok((agent, vec![event]))
    }

    /// Every sub-bot row of one parent (or of any parent), archived ones included.
    pub fn subbot_agents(&self, parent_id: Option<&str>) -> Result<Vec<Value>, StorageError> {
        let ids: Vec<String> = {
            let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
            let mut q = c.prepare("SELECT id FROM agents WHERE parent_agent_id IS NOT NULL AND (?1 IS NULL OR parent_agent_id=?1) ORDER BY created_at,id")?;
            let rows = q.query_map([parent_id], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            rows
        };
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        ids.iter().map(|id| agent_read(&c, id)).collect()
    }

    /// Archives every live sub-bot of a parent. Returns the rows and their events.
    pub fn subbot_archive_all(&self, parent_id: &str) -> Result<(Vec<Value>, Vec<Value>), StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let ids: Vec<String> = {
            let mut q = tx.prepare("SELECT id FROM agents WHERE parent_agent_id=?1 AND archived=0")?;
            let rows = q.query_map([parent_id], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            rows
        };
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let (mut agents, mut events) = (Vec::new(), Vec::new());
        for id in ids {
            tx.execute("UPDATE agents SET archived=1,updated_at=?2 WHERE id=?1", params![id, now])?;
            let agent = agent_read(&tx, &id)?;
            events.push(push_agent_event(&tx, "archived", &agent)?);
            agents.push(agent);
        }
        tx.commit()?;
        Ok((agents, events))
    }

    /// Every assignment whose target is a sub-bot of `parent_id`, oldest first.
    pub fn subbot_delegations(&self, parent_id: &str) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        super::delegation_list(
            &c,
            &format!("SELECT json_object({}) FROM delegations WHERE target_agent_id IN (SELECT id FROM agents WHERE parent_agent_id=?1) ORDER BY created_at,rowid", super::DELEGATION_COLUMNS),
            parent_id,
        )
    }

    /// The title of the tool a conversation is running right now, if any.
    pub fn running_tool_title(&self, session_id: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let title: Option<Option<String>> = c
            .query_row(
                "SELECT json_extract(data,'$.title') FROM tool_calls WHERE session_id=?1 AND state='running' ORDER BY rowid DESC LIMIT 1",
                [session_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(title.flatten())
    }
}
