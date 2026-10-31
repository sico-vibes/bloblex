//! Phase 4 storage: machine links.
//!
//! One row per other machine this one is paired with. The row holds what the
//! owner sees (name, address, sign-in kind, certificate fingerprint, tier) and
//! nothing secret: the device token lives in a user-only file in the daemon's
//! data folder and never reaches the database. `id` is the other machine's own
//! `machine.id`, and `device_id` is the id of *our* device record on that
//! machine (what its Remote list shows).

use super::{params, Connection, OptionalExtension, SecondsFormat, StorageError, Storage, Utc};
use serde_json::{json, Value};

/// Additive and idempotent, like every other `ensure_*` schema.
pub(super) fn ensure_phase4_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS machine_links(
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        auth TEXT NOT NULL,
        fingerprint TEXT,
        tier TEXT NOT NULL,
        paired_at TEXT NOT NULL,
        last_seen_at TEXT,
        state TEXT NOT NULL DEFAULT 'offline',
        device_id TEXT
    );",
    )?;
    Ok(())
}

const LINK_SQL: &str = "SELECT id,name,url,auth,fingerprint,tier,paired_at,last_seen_at,state,device_id FROM machine_links";

fn link_dto(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "name": r.get::<_, String>(1)?,
        "url": r.get::<_, String>(2)?,
        "auth": r.get::<_, String>(3)?,
        "fingerprint": r.get::<_, Option<String>>(4)?,
        "tier": r.get::<_, String>(5)?,
        "pairedAt": r.get::<_, String>(6)?,
        "lastSeenAt": r.get::<_, Option<String>>(7)?,
        "state": r.get::<_, String>(8)?,
        "deviceId": r.get::<_, Option<String>>(9)?,
    }))
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl Storage {
    /// Writes a link, replacing an earlier one for the same machine. A second
    /// pairing keeps nothing of the first but its row id.
    pub fn machine_link_upsert(&self, link: &Value) -> Result<Value, StorageError> {
        let text = |key: &str| link[key].as_str().map(str::to_string);
        let (Some(id), Some(name), Some(url), Some(auth), Some(tier)) =
            (text("id"), text("name"), text("url"), text("auth"), text("tier"))
        else {
            return Err(StorageError::InvalidAgent);
        };
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute(
            "INSERT INTO machine_links(id,name,url,auth,fingerprint,tier,paired_at,last_seen_at,state,device_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,auth=excluded.auth,
               fingerprint=excluded.fingerprint,tier=excluded.tier,paired_at=excluded.paired_at,
               last_seen_at=excluded.last_seen_at,state=excluded.state,device_id=excluded.device_id",
            params![
                id,
                name,
                url,
                auth,
                text("fingerprint"),
                tier,
                text("pairedAt").unwrap_or_else(now),
                text("lastSeenAt"),
                text("state").unwrap_or_else(|| "online".to_string()),
                text("deviceId"),
            ],
        )?;
        Ok(c.query_row(&format!("{LINK_SQL} WHERE id=?1"), [&id], link_dto)?)
    }

    pub fn machine_link_get(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row(&format!("{LINK_SQL} WHERE id=?1"), [id], link_dto).optional()?)
    }

    /// Every link, oldest pairing first.
    pub fn machine_links(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = c.prepare(&format!("{LINK_SQL} ORDER BY paired_at, id"))?;
        let rows = statement.query_map([], link_dto)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn machine_link_count(&self) -> Result<i64, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT COUNT(*) FROM machine_links", [], |r| r.get(0))?)
    }

    /// Records what the last contact showed. `seen` also moves `last_seen_at`.
    pub fn machine_link_set_state(&self, id: &str, state: &str, seen: bool) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = if seen {
            c.execute("UPDATE machine_links SET state=?2,last_seen_at=?3 WHERE id=?1", params![id, state, now()])?
        } else {
            c.execute("UPDATE machine_links SET state=?2 WHERE id=?1", params![id, state])?
        };
        Ok(changed > 0)
    }

    /// The tier the other machine now gives this device.
    pub fn machine_link_set_tier(&self, id: &str, tier: &str) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.execute("UPDATE machine_links SET tier=?2 WHERE id=?1", params![id, tier])? > 0)
    }

    pub fn machine_link_rename(&self, id: &str, name: &str) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.execute("UPDATE machine_links SET name=?2 WHERE id=?1", params![id, name])? > 0)
    }

    pub fn machine_link_delete(&self, id: &str) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.execute("DELETE FROM machine_links WHERE id=?1", [id])? > 0)
    }

    // ── Handoff: putting a returning conversation back as it was ─────────────

    /// The raw columns of one conversation, so a take-over that fails after it touched a row the
    /// machine already had (a conversation coming back) can put that row back exactly.
    pub fn session_snapshot(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row(
            "SELECT runtime_id,provider,project_path,title,state,created_at,updated_at,agent_id,provider_session_id,resumable,data FROM sessions WHERE id=?1",
            [id],
            |r| {
                Ok(json!({
                    "id": id,
                    "runtimeId": r.get::<_, String>(0)?,
                    "provider": r.get::<_, String>(1)?,
                    "projectPath": r.get::<_, String>(2)?,
                    "title": r.get::<_, String>(3)?,
                    "state": r.get::<_, String>(4)?,
                    "createdAt": r.get::<_, String>(5)?,
                    "updatedAt": r.get::<_, String>(6)?,
                    "agentId": r.get::<_, Option<String>>(7)?,
                    "providerSessionId": r.get::<_, Option<String>>(8)?,
                    "resumable": r.get::<_, i64>(9)?,
                    "data": r.get::<_, Option<String>>(10)?,
                }))
            },
        ).optional()?)
    }

    /// Writes a [`Storage::session_snapshot`] back. `false` when the row is gone.
    pub fn session_restore(&self, snapshot: &Value) -> Result<bool, StorageError> {
        let id = snapshot["id"].as_str().ok_or(StorageError::InvalidAgent)?;
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.execute(
            "UPDATE sessions SET runtime_id=?2,provider=?3,project_path=?4,title=?5,state=?6,created_at=?7,updated_at=?8,agent_id=?9,provider_session_id=?10,resumable=?11,data=?12 WHERE id=?1",
            params![
                id,
                snapshot["runtimeId"].as_str().unwrap_or(""),
                snapshot["provider"].as_str().unwrap_or(""),
                snapshot["projectPath"].as_str().unwrap_or(""),
                snapshot["title"].as_str().unwrap_or(""),
                snapshot["state"].as_str().unwrap_or("idle"),
                snapshot["createdAt"].as_str().unwrap_or(""),
                snapshot["updatedAt"].as_str().unwrap_or(""),
                snapshot["agentId"].as_str(),
                snapshot["providerSessionId"].as_str(),
                snapshot["resumable"].as_i64().unwrap_or(0),
                snapshot["data"].as_str(),
            ],
        )? > 0)
    }

    /// The ids of the messages a conversation has.
    pub fn session_message_ids(&self, session_id: &str) -> Result<Vec<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT id FROM messages WHERE session_id=?1")?;
        let ids = q.query_map([session_id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    /// Removes the named messages from a conversation, in one transaction.
    pub fn session_remove_messages(&self, session_id: &str, ids: &[String]) -> Result<(), StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM messages WHERE session_id=?1 AND id=?2", params![session_id, id])?;
        }
        tx.commit()?;
        Ok(())
    }
}
