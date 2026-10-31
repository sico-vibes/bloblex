//! Phase 5 storage: named account folders.
//!
//! An account is a named config folder for one provider. The default account is
//! the CLI's own folder, has no row here, and cannot be deleted; a bot points at
//! one with `agents.account_id` (`NULL` is the default). Nothing in this table
//! is a secret: the folder is created and permissioned by the daemon, and the
//! account's sign-in happens in the owner's own terminal.

use super::{params, Connection, OptionalExtension, SecondsFormat, StorageError, Storage, Utc};
use serde_json::{json, Value};

/// Additive and idempotent, like every other `ensure_*` schema.
pub(super) fn ensure_phase5_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS accounts(
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
    );",
    )?;
    // A bot's account is a nullable pointer: the default account is the CLI's
    // own folder and has no row. Additive on older databases.
    let has_account: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='account_id')",
        [],
        |r| r.get(0),
    )?;
    if !has_account {
        c.execute("ALTER TABLE agents ADD COLUMN account_id TEXT", [])?;
    }
    // A custom model is a name the owner typed for a model the catalog does not
    // list. `provider` and `model_id` are unique together, so one name per id.
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS custom_models(
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 1 AND 200),
        label TEXT,
        efforts_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(provider, model_id)
    );",
    )?;
    Ok(())
}

const ACCOUNT_SQL: &str = "SELECT id,provider,name,created_at FROM accounts";

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn account_dto(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "provider": row.get::<_, String>(1)?,
        "name": row.get::<_, String>(2)?,
        "createdAt": row.get::<_, String>(3)?,
    }))
}

impl Storage {
    /// One account row, or `None` for an id that does not exist (including the
    /// default account, which has no row).
    pub fn account_get(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row(&format!("{ACCOUNT_SQL} WHERE id=?1"), [id], account_dto).optional()?)
    }

    /// Every named account, with how many bots point at it. The default account
    /// is not listed: it has no row.
    pub fn account_list(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut rows: Vec<Value> = {
            let mut q = c.prepare("SELECT json_object('id',id,'provider',provider,'name',name,'createdAt',created_at) FROM accounts ORDER BY provider,created_at,id")?;
            let text = q.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<String>, _>>()?;
            text.iter().filter_map(|row| serde_json::from_str(row).ok()).collect()
        };
        for row in rows.iter_mut() {
            let id = row["id"].as_str().unwrap_or("").to_owned();
            let bots: i64 = c.query_row("SELECT count(*) FROM agents WHERE account_id=?1", [&id], |r| r.get(0))?;
            row["bots"] = json!(bots);
        }
        Ok(rows)
    }

    /// Creates a named account for one provider. The caller validates the
    /// provider and the name; two accounts may share a name.
    pub fn account_create(&self, provider: &str, name: &str) -> Result<Value, StorageError> {
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = now();
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute(
            "INSERT INTO accounts(id,provider,name,created_at) VALUES(?1,?2,?3,?4)",
            params![id, provider, name.trim(), created_at],
        )?;
        Ok(json!({"id": id, "provider": provider, "name": name.trim(), "createdAt": created_at}))
    }

    /// Renames one account. `None` when the id does not exist.
    pub fn account_rename(&self, id: &str, name: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute("UPDATE accounts SET name=?2 WHERE id=?1", params![id, name.trim()])?;
        if changed == 0 {
            return Ok(None);
        }
        Ok(c.query_row(&format!("{ACCOUNT_SQL} WHERE id=?1"), [id], account_dto).optional()?)
    }

    /// Bots that point at one account, in list order. Used for the delete
    /// refusal and to move them back to the default account.
    pub fn account_bots(&self, id: &str) -> Result<Vec<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT id FROM agents WHERE account_id=?1 ORDER BY sort_order,created_at,id")?;
        let ids = q.query_map([id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    /// Deletes one account row and puts its bots back on the default account in
    /// the same transaction. `false` when the id does not exist; the daemon
    /// removes the folder afterwards.
    pub fn account_delete(&self, id: &str) -> Result<bool, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute("UPDATE agents SET account_id=NULL WHERE account_id=?1", [id])?;
        let removed = tx.execute("DELETE FROM accounts WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(removed > 0)
    }

    /// Whether a bot may point at this account: it must exist and belong to the
    /// bot's own provider.
    pub fn account_for_provider(&self, id: &str, provider: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row(
            "SELECT provider FROM accounts WHERE id=?1 AND provider=?2",
            params![id, provider],
            |r| r.get::<_, String>(0),
        )
        .optional()?)
    }
}

// ---------------------------------------------------------------------------
// Custom models
//
// A name the owner typed for a model the catalog does not list. It holds no
// secret, never enters a catalog cache, and travels in a backup as a name.

const CUSTOM_MODEL_SQL: &str = "SELECT json_object('id',id,'provider',provider,'modelId',model_id,'label',label,'efforts',json(efforts_json),'source','custom') FROM custom_models";

impl Storage {
    /// One provider's custom models, oldest first.
    pub fn custom_model_list(&self, provider: &str) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let text: Vec<String> = {
            let mut q = c.prepare(&format!("{CUSTOM_MODEL_SQL} WHERE provider=?1 ORDER BY created_at,id"))?;
            let rows = q.query_map([provider], |r| r.get::<_, String>(0))?.collect::<Result<Vec<String>, _>>()?;
            rows
        };
        Ok(text.iter().filter_map(|row| serde_json::from_str(row).ok()).collect())
    }

    /// Every custom model, for a backup.
    pub fn custom_model_all(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let text: Vec<String> = {
            let mut q = c.prepare(&format!("{CUSTOM_MODEL_SQL} ORDER BY provider,created_at,id"))?;
            let rows = q.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<String>, _>>()?;
            rows
        };
        Ok(text.iter().filter_map(|row| serde_json::from_str(row).ok()).collect())
    }

    /// Saves one custom model. A known `id` updates it; otherwise a new row is
    /// made. The provider and the model id are unique together, so a second
    /// name for the same id is a conflict and the caller says `conflict`.
    pub fn custom_model_save(&self, id: Option<&str>, provider: &str, model_id: &str, label: Option<&str>, efforts: &[String]) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let efforts_json = serde_json::to_string(efforts).unwrap_or_else(|_| "[]".to_owned());
        let id = match id {
            Some(id) => {
                match c.execute(
                    "UPDATE custom_models SET provider=?2,model_id=?3,label=?4,efforts_json=?5 WHERE id=?1",
                    params![id, provider, model_id, label, efforts_json],
                ) {
                    Ok(0) => return Err(StorageError::InvalidAgent),
                    Ok(_) => id.to_owned(),
                    Err(_) => return Err(StorageError::AgentConflict),
                }
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                c.execute(
                    "INSERT INTO custom_models(id,provider,model_id,label,efforts_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
                    params![id, provider, model_id, label, efforts_json, now()],
                ).map_err(|_| StorageError::AgentConflict)?;
                id
            }
        };
        c.query_row(&format!("{CUSTOM_MODEL_SQL} WHERE id=?1"), [&id], |r| r.get::<_, String>(0))
            .optional()?
            .and_then(|row| serde_json::from_str(&row).ok())
            .ok_or(StorageError::InvalidAgent)
    }

    /// One custom model by id.
    pub fn custom_model_get(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row = c.query_row(&format!("{CUSTOM_MODEL_SQL} WHERE id=?1"), [id], |r| r.get::<_, String>(0)).optional()?;
        Ok(row.and_then(|row| serde_json::from_str(&row).ok()))
    }

    /// Deletes one custom model. `false` when the id is unknown.
    pub fn custom_model_delete(&self, id: &str) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.execute("DELETE FROM custom_models WHERE id=?1", [id])? > 0)
    }
}
