use super::*;

impl Storage {
    /// Only normalized message fields are returned; provider data stays in storage.
    pub fn search_messages(&self, query: &str) -> Result<Vec<Value>, StorageError> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 200 { return Ok(vec![]); }
        let pattern = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT m.id,m.session_id,s.agent_id,s.title,m.role,m.created_at,m.content FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.archived=0 AND m.role IN ('user','assistant') AND m.content LIKE ?1 ESCAPE '\\' ORDER BY m.created_at DESC,m.id LIMIT 50")?;
        let rows = q.query_map([pattern], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, Option<String>>(2)?,r.get::<_, String>(3)?,r.get::<_, String>(4)?,r.get::<_, String>(5)?,r.get::<_, String>(6)?)))?;
        rows.map(|row| {
            let (id, session, agent, title, role, created, content) = row?;
            let chars: Vec<char> = content.chars().collect();
            let needle: Vec<char> = query.chars().map(|c| c.to_ascii_lowercase()).collect();
            let at = chars.windows(needle.len()).position(|w| w.iter().map(|c| c.to_ascii_lowercase()).eq(needle.iter().copied())).unwrap_or(0);
            let start = at.saturating_sub(45);
            let end = (start + 180).max(at + needle.len() + 45).min(chars.len());
            let snippet = format!("{}{}{}", if start > 0 { "…" } else { "" }, chars[start..end].iter().collect::<String>(), if end < chars.len() { "…" } else { "" });
            let blob = agent.as_deref().and_then(|id| agent_read(&c, id).ok()).map(|a| json!({"id":a["id"],"name":a["name"],"color":a["color"],"look":a["look"],"archived":a["archived"]}));
            Ok(json!({"messageId":id,"sessionId":session,"blobId":agent,"blob":blob,"title":title,"role":role,"createdAt":created,"snippet":snippet}))
        }).collect()
    }

    pub fn agent_restore(&self, id: &str) -> Result<(Value, Vec<Value>), StorageError> {
        validate_agent_id(id)?;
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old = agent_read(&tx, id)?;
        if old["archived"] != true { tx.commit()?; return Ok((old, vec![])); }
        ensure_name_free(&tx, old["name"].as_str().unwrap_or("").to_lowercase().as_str(), Some(id))?;
        let runtime = old["runtimeId"].as_str().unwrap_or("");
        let order: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order)+1,0) FROM agents WHERE runtime_id=?1 AND archived=0", [runtime], |r| r.get(0))?;
        tx.execute("UPDATE agents SET archived=0,sort_order=?2,updated_at=?3 WHERE id=?1", params![id,order,Utc::now().to_rfc3339()])?;
        let agent = agent_read(&tx, id)?;
        let event = push_agent_event(&tx, "restored", &agent)?;
        tx.commit()?;
        Ok((agent, vec![event]))
    }

    pub fn mark_file_reverted(&self, session: &str, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute("UPDATE file_changes SET data=json_set(data,'$.detail.reverted',json('true')) WHERE id=?1 AND session_id=?2", params![id,session])?;
        if changed == 0 { return Err(StorageError::AgentNotFound); }
        Ok(())
    }

    // Durable deadlines survive a window close and are drained on daemon restart.
    pub fn pending_session_delete(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let value: Option<String> = c.query_row("SELECT value FROM settings WHERE key=?1", [format!("internal.delete.{id}")], |r| r.get(0)).optional()?;
        value.map(|v| serde_json::from_str(&v).map_err(StorageError::from)).transpose()
    }
    pub fn clear_session_delete(&self, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("DELETE FROM settings WHERE key=?1", [format!("internal.delete.{id}")])?;
        Ok(())
    }
    pub fn due_session_deletes(&self, now: i64) -> Result<Vec<(String, i64)>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT substr(key,17),json_extract(value,'$.deadline') FROM settings WHERE key GLOB 'internal.delete.*' AND json_extract(value,'$.deadline')<=?1")?;
        let rows = q.query_map([now], |r| Ok((r.get(0)?,r.get(1)?)))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Storage { Storage::open_in_memory().unwrap() }
    #[test]
    fn search_is_literal_bounded_and_excludes_archived_sessions() {
        let db = db();
        db.create_session("s", "rt", "codex", ".", "Title").unwrap();
        db.create_session("archived", "rt", "codex", ".", "Hidden").unwrap();
        for i in 0..60 { db.append_message("s", &format!("t{i}"), "user", "prefix 50%_\\ literal suffix").unwrap(); }
        db.append_message("archived", "t", "assistant", "50%_\\ hidden").unwrap();
        db.session_archive("archived", true).unwrap();
        let found = db.search_messages("50%_\\").unwrap();
        assert_eq!(found.len(), 50);
        assert!(found.iter().all(|r| r["sessionId"] == "s" && r.get("raw").is_none()));
        assert!(db.search_messages("50%_x").unwrap().is_empty());
        assert!(db.search_messages(" ").unwrap().is_empty());
    }
    #[test]
    fn saved_patch_preserves_whitespace_and_marks_every_clipped_excerpt() {
        let patch = "--- a/a\n+++ b/a\n@@ -1 +1 @@\n- old \n+ new \n";
        assert_eq!(file_detail("a", &json!({"diff":patch}))["diff"], patch);
        assert_eq!(file_detail("a", &json!({"diff":"x".repeat(DETAIL_TEXT_LIMIT + 1)}))["diffClipped"], true);
        assert_eq!(file_detail("a", &json!({"diff":patch,"truncated":true}))["diffClipped"], true);
    }

    #[test]
    fn deletion_deadlines_persist_and_can_be_cancelled() {
        let dir = std::env::temp_dir().join(format!("bloblex-undo-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        { let db = Storage::open(&path).unwrap(); db.set_setting("internal.delete.s", &json!({"deadline":8000,"archived":false})).unwrap(); }
        { let db = Storage::open(&path).unwrap(); assert!(db.due_session_deletes(7999).unwrap().is_empty()); assert_eq!(db.due_session_deletes(8000).unwrap(), vec![("s".into(),8000)]); db.clear_session_delete("s").unwrap(); assert!(db.due_session_deletes(9000).unwrap().is_empty()); }
        fs::remove_dir_all(dir).unwrap();
    }
}
