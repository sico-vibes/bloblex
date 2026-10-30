//! Phase 1B storage: fan-out records and the prompt stash.
//!
//! A fan-out is one prompt sent to several bots, each in its own conversation;
//! the record keeps the prompt and which conversation belongs to which bot, and
//! the replies are read live from the conversations. The stash keeps a draft
//! (text and image file names) so it can be used later anywhere. Neither table
//! is part of a backup, and neither is reachable by the Bitbots MCP.

use super::{params, Connection, OptionalExtension, SecondsFormat, StorageError, Storage, Utc, Uuid};
use serde_json::{json, Value};

/// Additive and idempotent, like every other `ensure_*` schema.
pub(super) fn ensure_phase1b_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS fanouts(
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        project_id TEXT,
        created_at TEXT NOT NULL,
        chosen_session_id TEXT,
        rows_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_fanouts_created ON fanouts(created_at DESC, id);
    CREATE TABLE IF NOT EXISTS prompt_stash(
        id TEXT PRIMARY KEY NOT NULL,
        text TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        agent_id TEXT,
        session_id TEXT,
        project_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_stash_created ON prompt_stash(created_at DESC, id);")?;
    Ok(())
}

const FANOUT_SQL: &str = "SELECT id,title,prompt,project_id,(SELECT p.name FROM projects p WHERE p.id=fanouts.project_id),created_at,chosen_session_id,rows_json FROM fanouts";

type FanoutRow = (String, String, String, Option<String>, Option<String>, String, Option<String>, String);

fn fanout_dto(row: FanoutRow) -> Value {
    let (id, title, prompt, project_id, project_name, created_at, chosen, rows) = row;
    json!({
        "id": id, "title": title, "prompt": prompt, "projectId": project_id, "projectName": project_name,
        "createdAt": created_at, "chosenSessionId": chosen,
        "rows": serde_json::from_str::<Value>(&rows).unwrap_or_else(|_| json!([])),
    })
}

fn fanout_columns(r: &rusqlite::Row<'_>) -> rusqlite::Result<FanoutRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
}

const STASH_SQL: &str = "SELECT id,text,attachments_json,agent_id,(SELECT a.name FROM agents a WHERE a.id=prompt_stash.agent_id),session_id,project_id,(SELECT p.name FROM projects p WHERE p.id=prompt_stash.project_id),created_at,updated_at FROM prompt_stash";

type StashRow = (String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String, String);

fn stash_dto(row: StashRow) -> Value {
    let (id, text, attachments, agent_id, agent_name, session_id, project_id, project_name, created_at, updated_at) = row;
    json!({
        "id": id, "text": text,
        "attachments": serde_json::from_str::<Value>(&attachments).unwrap_or_else(|_| json!([])),
        "agentId": agent_id, "agentName": agent_name, "sessionId": session_id, "projectId": project_id, "projectName": project_name,
        "createdAt": created_at, "updatedAt": updated_at,
    })
}

fn stash_columns(r: &rusqlite::Row<'_>) -> rusqlite::Result<StashRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl Storage {
    // ── Fan-outs ────────────────────────────────────────────────────────────

    /// Creates the record with no rows yet, so a conversation's `fanoutId` resolves
    /// from the moment it is stamped. `fanout_set_rows` fills the rows in.
    pub fn fanout_create(&self, id: &str, title: &str, prompt: &str, project_id: Option<&str>) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("INSERT INTO fanouts(id,title,prompt,project_id,created_at,chosen_session_id,rows_json) VALUES(?1,?2,?3,?4,?5,NULL,'[]')", params![id, title, prompt, project_id, now()])?;
        Ok(())
    }
    pub fn fanout_set_rows(&self, id: &str, rows: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        if c.execute("UPDATE fanouts SET rows_json=?2 WHERE id=?1", params![id, rows.to_string()])? == 0 { return Err(StorageError::AgentNotFound); }
        Ok(())
    }
    pub fn fanout_get(&self, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row = c.query_row(&format!("{FANOUT_SQL} WHERE id=?1"), [id], fanout_columns).optional()?;
        row.map(fanout_dto).ok_or(StorageError::AgentNotFound)
    }
    pub fn fanout_list(&self, limit: usize) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare(&format!("{FANOUT_SQL} ORDER BY created_at DESC, id LIMIT ?1"))?;
        let rows = q.query_map([limit as i64], fanout_columns)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().map(fanout_dto).collect())
    }
    /// Sets or clears the chosen conversation. The caller has checked that it is one of the rows.
    pub fn fanout_pick(&self, id: &str, session_id: Option<&str>) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        if c.execute("UPDATE fanouts SET chosen_session_id=?2 WHERE id=?1", params![id, session_id])? == 0 { return Err(StorageError::AgentNotFound); }
        Ok(())
    }
    /// Removes the record only; a conversation's `fanoutId` reads back null because it resolves through this table.
    pub fn fanout_delete(&self, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        if c.execute("DELETE FROM fanouts WHERE id=?1", [id])? == 0 { return Err(StorageError::AgentNotFound); }
        Ok(())
    }

    // ── Prompt stash ────────────────────────────────────────────────────────

    pub fn stash_count(&self) -> Result<i64, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT COUNT(*) FROM prompt_stash", [], |r| r.get(0))?)
    }
    /// Inserts one item under an id the caller chose (its image folder is named after it).
    #[allow(clippy::too_many_arguments)]
    pub fn stash_insert(&self, id: &str, text: &str, attachments: &Value, agent_id: Option<&str>, session_id: Option<&str>, project_id: Option<&str>, max_items: i64) -> Result<Value, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM prompt_stash", [], |r| r.get(0))?;
        if count >= max_items { return Err(StorageError::AgentConflict); }
        let stamp = now();
        tx.execute("INSERT INTO prompt_stash(id,text,attachments_json,agent_id,session_id,project_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)", params![id, text, attachments.to_string(), agent_id, session_id, project_id, stamp])?;
        let row = tx.query_row(&format!("{STASH_SQL} WHERE id=?1"), [id], stash_columns)?;
        tx.commit()?;
        Ok(stash_dto(row))
    }
    pub fn stash_get(&self, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row = c.query_row(&format!("{STASH_SQL} WHERE id=?1"), [id], stash_columns).optional()?;
        row.map(stash_dto).ok_or(StorageError::AgentNotFound)
    }
    pub fn stash_list(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare(&format!("{STASH_SQL} ORDER BY created_at DESC, id"))?;
        let rows = q.query_map([], stash_columns)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().map(stash_dto).collect())
    }
    pub fn stash_update_text(&self, id: &str, text: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        if c.execute("UPDATE prompt_stash SET text=?2,updated_at=?3 WHERE id=?1", params![id, text, now()])? == 0 { return Err(StorageError::AgentNotFound); }
        let row = c.query_row(&format!("{STASH_SQL} WHERE id=?1"), [id], stash_columns)?;
        Ok(stash_dto(row))
    }
    pub fn stash_delete(&self, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        if c.execute("DELETE FROM prompt_stash WHERE id=?1", [id])? == 0 { return Err(StorageError::AgentNotFound); }
        Ok(())
    }
    /// A fresh id for a stash item or a fan-out.
    pub fn new_id() -> String {
        Uuid::new_v4().to_string()
    }

    // ── Queue: send when a usage limit resets ───────────────────────────────

    /// Moves every waiting "when the limit resets" item of a session to a later reset.
    /// Returns whether any item moved.
    pub fn queue_move_limit_waiters(&self, session_id: &str, due_at: &str) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute(
            "UPDATE queued_prompts SET due_at=?2,updated_at=?3 WHERE session_id=?1 AND status='queued' AND kind='send_later' AND json_extract(params_json,'$.whenLimitResets')=1 AND (due_at IS NULL OR due_at<?2)",
            params![session_id, due_at, now()],
        )?;
        Ok(changed > 0)
    }
}

impl Storage {
    /// Whether a session holds a queued "send when the limit resets" item.
    pub fn queue_has_limit_waiters(&self, session_id: &str) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM queued_prompts WHERE session_id=?1 AND status='queued' AND kind='send_later' AND json_extract(params_json,'$.whenLimitResets')=1)", [session_id], |r| r.get(0))?)
    }
    /// A session's state and the end of its usage-limit window, cheaply.
    pub fn session_limit_info(&self, session_id: &str) -> Result<(String, Option<String>), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.query_row("SELECT state,limited_until FROM sessions WHERE id=?1", [session_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?.ok_or(StorageError::AgentNotFound)
    }
}

impl Storage {
    /// The newest turn of a conversation: `{id, state, createdAt, completedAt}`, read without loading the conversation.
    pub fn session_latest_turn(&self, session_id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row: Option<(String, String, String, Option<String>)> = c.query_row(
            "SELECT id,state,created_at,completed_at FROM turns WHERE session_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [session_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).optional()?;
        Ok(row.map(|(id, state, created, completed)| json!({"id": id, "state": state, "createdAt": created, "completedAt": completed})))
    }
    /// The text of the last assistant message a turn produced, if it has produced one.
    pub fn turn_last_assistant_text(&self, session_id: &str, turn_id: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let text: Option<String> = c.query_row(
            "SELECT content FROM messages WHERE session_id=?1 AND turn_id=?2 AND role='assistant' AND TRIM(content)!='' ORDER BY sequence DESC LIMIT 1",
            params![session_id, turn_id], |r| r.get(0),
        ).optional()?;
        Ok(text)
    }
}

impl Storage {
    /// Rewrites a queued item's due time, so a deterministic test can make it due now.
    #[doc(hidden)]
    pub fn queue_set_due(&self, id: &str, due_at: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("UPDATE queued_prompts SET due_at=?2 WHERE id=?1", params![id, due_at])?;
        Ok(())
    }
}

impl Storage {
    /// Records one usage reading for a turn, so a test can show a known token count.
    #[doc(hidden)]
    pub fn record_usage_event_for_test(&self, session_id: &str, turn_id: &str, input: i64, output: i64) {
        if let Ok(c) = self.conn.lock() {
            let _ = c.execute(
                "INSERT INTO usage_events(id,runtime_id,session_id,turn_id,provider,model,timestamp,input_tokens,output_tokens,source,raw) VALUES(?1,(SELECT runtime_id FROM sessions WHERE id=?2),?2,?3,'codex','m',?4,?5,?6,'terminal','{}')",
                params![Uuid::new_v4().to_string(), session_id, turn_id, now(), input, output],
            );
        }
    }
}
