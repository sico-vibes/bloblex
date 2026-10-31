//! Phase 6 storage: one Web Push subscription per paired device.
//!
//! A row holds only what the browser's `PushSubscription` gave us: the push
//! service endpoint and the device's own key material (`p256dh` and `auth`),
//! which are public halves plus a shared secret the device and the push service
//! already know. Nothing here is a Bitbots credential. `device_id` is the
//! `remote_devices.id` of the phone, and a device has at most one row: a second
//! subscription replaces the first.
//!
//! `failed_at` is the first failed delivery, kept so the desktop can say a
//! subscription has stopped working. A push service answer of 404 or 410
//! deletes the row instead.

use super::{params, Connection, OptionalExtension, SecondsFormat, Storage, StorageError, Utc};
use serde_json::{json, Value};

/// Additive and idempotent, like every other `ensure_*` schema.
pub(super) fn ensure_phase6_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS remote_push(
            device_id TEXT PRIMARY KEY NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at TEXT NOT NULL,
            failed_at TEXT
        );",
    )?;
    Ok(())
}

const PUSH_SQL: &str = "SELECT device_id,endpoint,p256dh,auth,created_at,failed_at FROM remote_push";

fn push_dto(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "deviceId": r.get::<_, String>(0)?,
        "endpoint": r.get::<_, String>(1)?,
        "p256dh": r.get::<_, String>(2)?,
        "auth": r.get::<_, String>(3)?,
        "createdAt": r.get::<_, String>(4)?,
        "failedAt": r.get::<_, Option<String>>(5)?,
    }))
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl Storage {
    /// Writes a device's subscription, replacing an earlier one. A fresh
    /// subscription is a fresh endpoint and key pair, so `failed_at` clears.
    pub fn remote_push_upsert(
        &self,
        device_id: &str,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
    ) -> Result<Value, StorageError> {
        if device_id.is_empty() || endpoint.is_empty() || p256dh.is_empty() || auth.is_empty() {
            return Err(StorageError::InvalidAgent);
        }
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute(
            "INSERT INTO remote_push(device_id,endpoint,p256dh,auth,created_at)
             VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(device_id) DO UPDATE SET endpoint=excluded.endpoint,
               p256dh=excluded.p256dh,auth=excluded.auth,failed_at=NULL",
            params![device_id, endpoint, p256dh, auth, now()],
        )?;
        c.query_row(&format!("{PUSH_SQL} WHERE device_id=?1"), params![device_id], push_dto).map_err(StorageError::from)
    }

    pub fn remote_push_get(&self, device_id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row(&format!("{PUSH_SQL} WHERE device_id=?1"), params![device_id], push_dto).optional()?)
    }

    /// Every subscription, oldest first. The sender walks this list.
    pub fn remote_push_list(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut stmt = c.prepare(&format!("{PUSH_SQL} ORDER BY created_at ASC"))?;
        let rows = stmt.query_map([], push_dto)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Returns whether a row was removed, so a caller can tell "gone" from
    /// "there was nothing".
    pub fn remote_push_delete(&self, device_id: &str) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.execute("DELETE FROM remote_push WHERE device_id=?1", params![device_id])? > 0)
    }

    /// Records the first failure only, so a device that keeps failing does not
    /// move its timestamp on every attempt.
    pub fn remote_push_mark_failed(&self, device_id: &str) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.execute(
            "UPDATE remote_push SET failed_at=?2 WHERE device_id=?1 AND failed_at IS NULL",
            params![device_id, now()],
        )? > 0)
    }

    /// The conversation's bot name, for the one line a notification may carry.
    /// A session with no bot, or a deleted bot, gives `None` and the caller
    /// says "Bitbots" instead.
    pub fn session_agent_name(&self, session_id: &str) -> Option<String> {
        let c = self.conn.lock().ok()?;
        c.query_row(
            "SELECT a.name FROM sessions s JOIN agents a ON a.id = json_extract(s.data,'$.agentId') WHERE s.id=?1",
            params![session_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_push_table_keeps_one_row_per_device() {
        let storage = Storage::open_in_memory().unwrap();
        let first = storage
            .remote_push_upsert("phone-1", "https://fcm.googleapis.com/p/one", "p256dh-one", "auth-one")
            .unwrap();
        assert_eq!(first["deviceId"], json!("phone-1"));
        assert_eq!(first["failedAt"], Value::Null);
        assert!(storage.remote_push_mark_failed("phone-1").unwrap());
        assert!(!storage.remote_push_mark_failed("phone-1").unwrap(), "only the first failure is recorded");
        // A second subscription for the same device replaces the first.
        let second = storage
            .remote_push_upsert("phone-1", "https://fcm.googleapis.com/p/two", "p256dh-two", "auth-two")
            .unwrap();
        assert_eq!(second["endpoint"], json!("https://fcm.googleapis.com/p/two"));
        assert_eq!(second["failedAt"], Value::Null, "a fresh subscription clears the failure");
        assert_eq!(storage.remote_push_list().unwrap().len(), 1);
        storage
            .remote_push_upsert("phone-2", "https://web.push.apple.com/p/one", "p256dh-three", "auth-three")
            .unwrap();
        assert_eq!(storage.remote_push_list().unwrap().len(), 2);
        assert!(storage.remote_push_delete("phone-1").unwrap());
        assert!(!storage.remote_push_delete("phone-1").unwrap());
        assert_eq!(storage.remote_push_get("phone-1").unwrap(), None);
        assert_eq!(storage.remote_push_list().unwrap().len(), 1);
    }
}
