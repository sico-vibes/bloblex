//! Phase 2 storage: generated images.
//!
//! One row per image a coding agent was asked to make. The row holds no image
//! bytes and, before the image exists, no path either: it holds the stem the
//! agent chose (without an extension), and the sweep in the daemon finds the
//! file later. A row belongs to one conversation and is deleted with it (the
//! file on disk is left alone). Nothing leaves this module through an RPC: the
//! daemon reads a row, and replies carry the media id only.

use super::{params, Connection, OptionalExtension, SecondsFormat, StorageError, Storage, Utc, Uuid};
use serde_json::{json, Value};

/// Additive and idempotent, like every other `ensure_*` schema.
pub(super) fn ensure_phase2_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS generated_media(
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT,
        provider TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        stem TEXT,
        path TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
        name TEXT,
        bytes INTEGER,
        media_type TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, tool_call_id)
    );
    CREATE INDEX IF NOT EXISTS idx_generated_media_pending ON generated_media(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_generated_media_session ON generated_media(session_id);",
    )?;
    Ok(())
}

const MEDIA_SQL: &str = "SELECT id,session_id,turn_id,provider,tool_call_id,stem,path,status,name,bytes,media_type,detail,created_at,updated_at FROM generated_media";
type MediaRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
    String,
    String,
);

fn media_dto(row: MediaRow) -> Value {
    let (id, session_id, turn_id, provider, tool_call_id, stem, path, status, name, bytes, media_type, detail, created_at, updated_at) = row;
    json!({
        "id": id, "sessionId": session_id, "turnId": turn_id, "provider": provider,
        "toolCallId": tool_call_id, "stem": stem, "path": path, "status": status,
        "name": name, "bytes": bytes, "mediaType": media_type, "detail": detail,
        "createdAt": created_at, "updatedAt": updated_at,
    })
}

fn media_columns(r: &rusqlite::Row<'_>) -> rusqlite::Result<MediaRow> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get(7)?,
        r.get(8)?,
        r.get(9)?,
        r.get(10)?,
        r.get(11)?,
        r.get(12)?,
        r.get(13)?,
    ))
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl Storage {
    /// Records a request for one image, under a media id the caller chose (the
    /// transcript message uses the same id). Returns `None` when this call id is
    /// already recorded for the conversation, so an adapter that repeats an
    /// update cannot make a second row.
    #[allow(clippy::too_many_arguments)]
    pub fn media_insert(
        &self,
        id: &str,
        session_id: &str,
        turn_id: Option<&str>,
        provider: &str,
        tool_call_id: &str,
        stem: Option<&str>,
        path: Option<&str>,
        status: &str,
        name: Option<&str>,
        bytes: Option<i64>,
        media_type: Option<&str>,
        detail: Option<&str>,
    ) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let stamp = now();
        let changed = c.execute(
            "INSERT INTO generated_media(id,session_id,turn_id,provider,tool_call_id,stem,path,status,name,bytes,media_type,detail,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)
             ON CONFLICT(session_id,tool_call_id) DO NOTHING",
            params![id, session_id, turn_id, provider, tool_call_id, stem, path, status, name, bytes, media_type, detail, stamp],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let row = c.query_row(&format!("{MEDIA_SQL} WHERE id=?1"), [id], media_columns)?;
        Ok(Some(media_dto(row)))
    }

    /// One row of this conversation, and nothing from another one.
    pub fn media_get(&self, session_id: &str, id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row = c
            .query_row(&format!("{MEDIA_SQL} WHERE session_id=?1 AND id=?2"), params![session_id, id], media_columns)
            .optional()?;
        Ok(row.map(media_dto))
    }

    /// The row by id alone, for the daemon's own bookkeeping (never a reply).
    pub fn media_by_id(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row = c.query_row(&format!("{MEDIA_SQL} WHERE id=?1"), [id], media_columns).optional()?;
        Ok(row.map(media_dto))
    }

    /// The row a provider call id already made for this conversation, if any.
    /// One call id names one image, so a repeated update cannot add a second row.
    pub fn media_by_call(&self, session_id: &str, tool_call_id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row = c
            .query_row(&format!("{MEDIA_SQL} WHERE session_id=?1 AND tool_call_id=?2"), params![session_id, tool_call_id], media_columns)
            .optional()?;
        Ok(row.map(media_dto))
    }

    /// Every row still waiting for its file, oldest first. Cheap when empty.
    pub fn media_pending(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare(&format!("{MEDIA_SQL} WHERE status='pending' ORDER BY created_at, id"))?;
        let rows = q.query_map([], media_columns)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().map(media_dto).collect())
    }

    /// How many rows a conversation holds, whatever their status.
    pub fn media_count(&self, session_id: &str) -> Result<i64, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT COUNT(*) FROM generated_media WHERE session_id=?1", [session_id], |r| r.get(0))?)
    }

    /// The size a pending row saw on a sweep, so the next sweep can require the
    /// same size before it calls the file complete.
    pub fn media_note_pending_size(&self, id: &str, bytes: i64) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute(
            "UPDATE generated_media SET bytes=?2,updated_at=?3 WHERE id=?1 AND status='pending'",
            params![id, bytes, now()],
        )?;
        Ok(())
    }

    /// Turns a pending row into a complete one. A row that already finished is
    /// left as it is, so a late sweep cannot overwrite the result.
    pub fn media_mark_ready(&self, id: &str, path: &str, name: &str, bytes: i64, media_type: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute(
            "UPDATE generated_media SET status='ready',path=?2,name=?3,bytes=?4,media_type=?5,detail=NULL,updated_at=?6 WHERE id=?1 AND status='pending'",
            params![id, path, name, bytes, media_type, now()],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let row = c.query_row(&format!("{MEDIA_SQL} WHERE id=?1"), [id], media_columns)?;
        Ok(Some(media_dto(row)))
    }

    /// Records a failure with a one-line reason. A row that already finished is
    /// left as it is.
    pub fn media_mark_failed(&self, id: &str, detail: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute(
            "UPDATE generated_media SET status='failed',detail=?2,updated_at=?3 WHERE id=?1 AND status IN ('pending','failed')",
            params![id, detail, now()],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let row = c.query_row(&format!("{MEDIA_SQL} WHERE id=?1"), [id], media_columns)?;
        Ok(Some(media_dto(row)))
    }

    /// Drops a conversation's rows. The files on disk are not touched.
    pub fn media_delete_for_session(&self, session_id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("DELETE FROM generated_media WHERE session_id=?1", [session_id])?;
        Ok(())
    }

    /// A fresh media id, so it can name the transcript message before anything is stored.
    pub fn new_media_id() -> String {
        Uuid::new_v4().to_string()
    }

    /// Rewrites when a request was made, so a test can let the deadline pass
    /// without waiting for it. Never used by the daemon.
    #[doc(hidden)]
    pub fn media_set_requested_at_for_test(&self, id: &str, stamp: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("UPDATE generated_media SET created_at=?2 WHERE id=?1", params![id, stamp])?;
        Ok(())
    }
}

impl Storage {
    /// The transcript's one message for a generated image, under the media id as
    /// its message id. Appends when it is new, rewrites it in place when it is
    /// not, and returns the stored row both times. It is stored with no turn,
    /// exactly as a team notice is: the client matches a notice on turn and role,
    /// so a notice that carried a turn could overwrite another one from that turn.
    /// `meta` never holds a path. The real turn stays on the `generated_media` row.
    pub fn media_message_write(&self, message_id: &str, session_id: &str, content: &str, meta: &Value) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session_id], |r| r.get(0))?;
        if !exists {
            return Ok(Value::Null);
        }
        let data = json!({"meta": meta}).to_string();
        let existing: Option<(i64, String)> = c
            .query_row("SELECT sequence,created_at FROM messages WHERE session_id=?1 AND id=?2", params![session_id, message_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let sequence: i64 = match existing {
            Some((sequence, created_at)) => {
                c.execute("UPDATE messages SET content=?2,data=?3 WHERE session_id=?1 AND id=?4", params![session_id, content, data, message_id])?;
                return Ok(json!({"id":message_id,"sessionId":session_id,"turnId":"","sequence":sequence,"role":"notice","content":content,"createdAt":created_at,"meta":meta}));
            }
            None => c.query_row("SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE session_id=?1", [session_id], |r| r.get(0))?,
        };
        let created_at = Utc::now().to_rfc3339();
        c.execute(
            "INSERT INTO messages(id,session_id,turn_id,sequence,role,content,created_at,data) VALUES(?1,?2,NULL,?3,'notice',?4,?5,?6)",
            params![message_id, session_id, sequence, content, created_at, data],
        )?;
        Ok(json!({"id":message_id,"sessionId":session_id,"turnId":"","sequence":sequence,"role":"notice","content":content,"createdAt":created_at,"meta":meta}))
    }
}
