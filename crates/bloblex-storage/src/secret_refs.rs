//! Phase 5 storage: which of a bot's environment variables point at a secret.
//!
//! The row holds the variable's name and the secret's *name* in the Windows
//! credential store, never a value. A restored or purged bot's rows are simply
//! unused: `env_ref_users` only counts bots that still exist.

use super::{params, Connection, StorageError, Storage};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Additive and idempotent, like every other `ensure_*` schema.
pub(super) fn ensure_secret_refs_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_env_refs(
        agent_id TEXT NOT NULL,
        env_key TEXT NOT NULL,
        secret_name TEXT NOT NULL,
        PRIMARY KEY(agent_id, env_key)
    );",
    )?;
    Ok(())
}

impl Storage {
    /// `{ENV_KEY: secretName}` for one bot.
    pub fn env_refs_get(&self, agent_id: &str) -> Result<BTreeMap<String, String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT env_key,secret_name FROM agent_env_refs WHERE agent_id=?1 ORDER BY env_key")?;
        let rows = q.query_map(params![agent_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Replaces a bot's references with exactly `refs`.
    pub fn env_refs_set(&self, agent_id: &str, refs: &BTreeMap<String, String>) -> Result<(), StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction()?;
        tx.execute("DELETE FROM agent_env_refs WHERE agent_id=?1", params![agent_id])?;
        for (key, name) in refs {
            tx.execute("INSERT INTO agent_env_refs(agent_id,env_key,secret_name) VALUES(?1,?2,?3)", params![agent_id, key, name])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The names of the live bots that point at a secret.
    pub fn env_ref_users(&self, secret_name: &str) -> Result<Vec<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT DISTINCT a.name FROM agent_env_refs r JOIN agents a ON a.id=r.agent_id WHERE r.secret_name=?1 ORDER BY a.name")?;
        let rows = q.query_map(params![secret_name], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Every referenced secret name with the bots using it, for `secret.list`.
    pub fn env_ref_usage(&self) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT r.secret_name, COUNT(DISTINCT r.agent_id) FROM agent_env_refs r JOIN agents a ON a.id=r.agent_id GROUP BY r.secret_name")?;
        let rows = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        let mut out = serde_json::Map::new();
        for row in rows { let (name, count) = row?; out.insert(name, json!(count)); }
        Ok(Value::Object(out))
    }
}
