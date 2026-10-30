//! Phase 1B: the prompt stash.
//!
//! A draft kept with its images so it can be used anywhere later; it outlives the composer's
//! two-hour local draft. Images are copied into `<data>/stash/<id>/`. The stash is desktop only:
//! it is never in a backup, never on the Bitbots MCP and never sent to a remote device. Prompt,
//! note and image names are never logged.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const MAX_ITEMS: i64 = 100;
const MAX_TEXT_CHARS: usize = 100_000;
const MAX_ATTACHMENTS: usize = 10;
/// How many images `prompt_attachments` accepts in one call.
const CHECK_CHUNK: usize = 8;
const STASH_DIR: &str = "stash";
const RESTORED_DIR: &str = "stash-restored";
/// A restored image folder older than this is removed at startup.
const RESTORED_KEEP_DAYS: u64 = 7;

fn invalid(message: &str) -> DispatchError {
    derr("invalid_argument", message, StatusCode::BAD_REQUEST)
}

fn storage_error(error: bloblex_storage::StorageError) -> DispatchError {
    use bloblex_storage::StorageError::*;
    match error {
        AgentNotFound => derr("not_found", "That stash item no longer exists.", StatusCode::NOT_FOUND),
        AgentConflict => derr("conflict", "The stash is full. Remove something first.", StatusCode::CONFLICT),
        InvalidAgent => invalid("The stash request is invalid."),
        other => derr("internal", &other.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn data_dir(st: &AppState) -> Result<PathBuf, DispatchError> {
    st.team.data_dir.lock().ok().and_then(|dir| dir.clone()).ok_or_else(|| derr("unavailable", "The stash folder is unavailable.", StatusCode::SERVICE_UNAVAILABLE))
}

fn required_id<'a>(p: &'a Value, key: &str) -> Result<&'a str, DispatchError> {
    p[key].as_str().filter(|id| !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')).ok_or_else(|| invalid(&format!("{key} is required.")))
}

fn text_of(p: &Value) -> Result<String, DispatchError> {
    let text = match p.get("text") {
        None | Some(Value::Null) => "",
        Some(value) => value.as_str().ok_or_else(|| invalid("text must be a string."))?,
    };
    if text.chars().count() > MAX_TEXT_CHARS { return Err(invalid("The text is longer than 100000 characters.")); }
    Ok(text.to_owned())
}

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "stash.add" => add(st, p).await,
        "stash.list" => Ok(json!({"items": st.db.stash_list().map_err(storage_error)?})),
        "stash.update" => {
            let id = required_id(p, "id")?;
            let text = text_of(p)?;
            let item = st.db.stash_get(id).map_err(storage_error)?;
            if text.trim().is_empty() && item["attachments"].as_array().is_none_or(Vec::is_empty) {
                return Err(invalid("A stash item needs text or an image."));
            }
            let item = st.db.stash_update_text(id, &text).map_err(storage_error)?;
            st.emit("stash.changed", json!({})).await;
            Ok(json!({"item": item}))
        }
        "stash.image" => image(st, p),
        "stash.restore" => restore(st, p).await,
        "stash.delete" => {
            let id = required_id(p, "id")?;
            st.db.stash_delete(id).map_err(storage_error)?;
            let _ = std::fs::remove_dir_all(data_dir(st)?.join(STASH_DIR).join(id));
            st.emit("stash.changed", json!({})).await;
            Ok(json!({"deleted": true}))
        }
        _ => Err(derr("not_found", "unknown stash method", StatusCode::NOT_FOUND)),
    }
}

/// An id the stash only records: an unknown one is stored as null.
fn known(value: &Value, exists: impl Fn(&str) -> bool) -> Option<String> {
    value.as_str().filter(|id| !id.is_empty() && id.len() <= 128 && exists(id)).map(str::to_owned)
}

async fn add(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let text = text_of(p)?;
    let files = match p.get("attachments") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        _ => return Err(invalid("attachments must be a list.")),
    };
    if files.len() > MAX_ATTACHMENTS { return Err(invalid("A stash item can hold up to 10 images.")); }
    let mut checked = Vec::with_capacity(files.len());
    for chunk in files.chunks(CHECK_CHUNK) { checked.extend(crate::prompt_attachments(&Value::Array(chunk.to_vec()))?); }
    if text.trim().is_empty() && checked.is_empty() { return Err(invalid("Write something or add an image to stash.")); }
    if st.db.stash_count().map_err(storage_error)? >= MAX_ITEMS {
        return Err(derr("conflict", "The stash is full. Remove something first.", StatusCode::CONFLICT));
    }
    let agent_id = known(&p["agentId"], |id| st.db.agent_get(id).is_ok());
    let session_id = known(&p["sessionId"], |id| st.db.session_exists(id).unwrap_or(false));
    let project_id = known(&p["projectId"], |id| st.db.project_get(id).is_ok());
    let id = bloblex_storage::Storage::new_id();
    let folder = data_dir(st)?.join(STASH_DIR).join(&id);
    let mut stored = Vec::with_capacity(checked.len());
    if !checked.is_empty() {
        std::fs::create_dir_all(&folder).map_err(|_| derr("internal", "The stash folder could not be created.", StatusCode::INTERNAL_SERVER_ERROR))?;
        for (index, image) in checked.iter().enumerate() {
            let file = format!("{index}.{}", crate::attachment_extension_for(&image.media_type));
            let copied = std::fs::copy(&image.path, folder.join(&file));
            match copied {
                Ok(bytes) => stored.push(json!({"file": file, "name": image.name, "bytes": bytes, "mediaType": image.media_type})),
                Err(_) => { let _ = std::fs::remove_dir_all(&folder); return Err(derr("internal", "An image could not be saved to the stash.", StatusCode::INTERNAL_SERVER_ERROR)); }
            }
        }
    }
    let item = match st.db.stash_insert(&id, &text, &json!(stored), agent_id.as_deref(), session_id.as_deref(), project_id.as_deref(), MAX_ITEMS) {
        Ok(item) => item,
        Err(error) => { let _ = std::fs::remove_dir_all(&folder); return Err(storage_error(error)); }
    };
    st.emit("stash.changed", json!({})).await;
    Ok(json!({"item": item}))
}

/// `stash.image`: one stored image as a data URL, in the shape `task.image` answers with. The file
/// name must be one the item lists, so no path leaves the item's folder.
fn image(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = required_id(p, "id")?;
    let file = p["file"].as_str().filter(|file| !file.is_empty()).ok_or_else(|| invalid("file is required."))?;
    let item = st.db.stash_get(id).map_err(storage_error)?;
    let entry = item["attachments"].as_array().and_then(|list| list.iter().find(|image| image["file"].as_str() == Some(file)))
        .ok_or_else(|| derr("not_found", "That image is not part of this stash item.", StatusCode::NOT_FOUND))?;
    let bytes = std::fs::read(data_dir(st)?.join(STASH_DIR).join(id).join(file)).map_err(|_| derr("not_found", "The image file is no longer available.", StatusCode::NOT_FOUND))?;
    let media_type = entry["mediaType"].as_str().unwrap_or("image/png");
    Ok(json!({"id": file, "name": entry["name"], "mediaType": media_type, "dataUrl": format!("data:{media_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))}))
}

/// Takes an item out of the stash: its images move to a folder the composer can send from, and the
/// row goes. The text and the new image paths are returned; nothing stays in the stash.
async fn restore(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = required_id(p, "id")?;
    let item = st.db.stash_get(id).map_err(storage_error)?;
    let base = data_dir(st)?;
    let source = base.join(STASH_DIR).join(id);
    let mut attachments = Vec::new();
    let list = item["attachments"].as_array().cloned().unwrap_or_default();
    if !list.is_empty() {
        let target = base.join(RESTORED_DIR).join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&target).map_err(|_| derr("internal", "The images could not be restored.", StatusCode::INTERNAL_SERVER_ERROR))?;
        for image in &list {
            let Some(file) = image["file"].as_str() else { continue };
            let to = target.join(file);
            let from = source.join(file);
            // Copy, never move: the stash item stays whole until every copy has worked.
            if std::fs::copy(&from, &to).is_err() { let _ = std::fs::remove_dir_all(&target); return Err(derr("not_found", "A stashed image is no longer available.", StatusCode::NOT_FOUND)); }
            attachments.push(json!({"path": to.to_string_lossy(), "name": image["name"]}));
        }
    }
    st.db.stash_delete(id).map_err(storage_error)?;
    let _ = std::fs::remove_dir_all(&source);
    st.emit("stash.changed", json!({})).await;
    Ok(json!({"item": {"text": item["text"], "attachments": attachments}}))
}

/// At startup, removes restored image folders older than a week.
pub(crate) fn prune_restored(st: &AppState) {
    let Ok(base) = data_dir(st) else { return };
    prune_older_than(&base.join(RESTORED_DIR), Duration::from_secs(RESTORED_KEEP_DAYS * 24 * 60 * 60));
}

fn prune_older_than(folder: &Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(folder) else { return };
    for entry in entries.flatten() {
        let old = entry.metadata().and_then(|meta| meta.modified()).ok().and_then(|modified| SystemTime::now().duration_since(modified).ok()).is_some_and(|elapsed| elapsed > age);
        if old { let _ = std::fs::remove_dir_all(entry.path()); }
    }
}

#[cfg(test)]
pub(crate) fn prune_for_test(folder: &Path, age: Duration) { prune_older_than(folder, age); }
