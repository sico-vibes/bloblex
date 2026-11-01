//! Project icons: the icon the owner picks for a project, and the favicon inside the project's own
//! folder.
//!
//! The icon lives in the project's `overrides` beside the trusted `.bitbots.json` hash, so it has the
//! same outlets: `project.update` refuses the key (only `project.icon.set` writes it), a settings save
//! keeps what is stored, a backup carries no projects and a device never sees `overrides`. The reply
//! and the event are the project as `project.update` returns them, so every window refreshes.
//!
//! `project.favicon` answers with the bytes of one file, chosen from a fixed list of places inside
//! the folder the stored project row names — never a path a client sends. It reads no other file,
//! starts no command, opens no socket and never walks the folder.

use crate::{agent_error, derr, AppState, DispatchError};
use axum::http::StatusCode;
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The largest favicon `project.favicon` answers with. A larger file is skipped, never read.
const MAX_ICON_BYTES: u64 = 256 * 1024;

/// Where a favicon may be, in this order; the first file that answers wins. Every entry is a fixed
/// relative path, so the client can never name one.
const FAVICON_PATHS: [&str; 30] = [
    "favicon.svg", "favicon.ico", "favicon.png",
    "icon.svg", "icon.png",
    "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
    "public/icon.svg", "public/icon.png",
    "static/favicon.svg", "static/favicon.ico", "static/favicon.png",
    "src/favicon.svg", "src/favicon.ico", "src/favicon.png",
    "app/favicon.ico", "app/icon.svg", "app/icon.png",
    "src/app/favicon.ico", "src/app/icon.svg", "src/app/icon.png",
    "assets/favicon.svg", "assets/favicon.png", "assets/icon.svg", "assets/icon.png",
    "apps/web/public/favicon.svg", "apps/web/public/favicon.ico", "apps/web/public/favicon.png",
    "apps/desktop/public/favicon.svg",
];

fn invalid(message: &str) -> DispatchError {
    derr("invalid_argument", message, StatusCode::BAD_REQUEST)
}

pub(crate) async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "project.icon.set" => set(st, p),
        "project.favicon" => favicon(st, p).await,
        _ => Err(derr("not_found", "unknown project icon method", StatusCode::NOT_FOUND)),
    }
}

/// `project.icon.set {projectId, icon}`: `icon` is an object of 1 to 3 fields or null to clear it.
/// The reply is the project as `project.update` returns it, and so is the event.
fn set(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = p["projectId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid("projectId is required"))?;
    let icon = match p.get("icon").ok_or_else(|| invalid("icon is required: an object, or null to clear it."))? {
        Value::Null => None,
        icon => Some(bloblex_storage::validate_project_icon(icon).map_err(|_| invalid("An icon is {kind, value, color}: kind is emoji, lucide or favicon, value is 1 to 40 characters with no control character and empty only for a favicon, and color is #rrggbb or null."))?),
    };
    let (mut project, mut events) = st.db.project_set_icon(id, icon.as_ref()).map_err(agent_error)?;
    let agents = st.db.agent_list(false, None).map_err(agent_error)?;
    crate::shared_settings::annotate(&mut project, &agents);
    crate::shared_settings::annotate_events(&mut events, &agents);
    st.broadcast_persisted(events);
    Ok(json!({"project": project}))
}

/// `project.favicon {projectId}`: `{found: false}`, or `{found: true, path, mime, dataBase64}` with
/// the relative path of the file that answered, its media type from its extension, and its bytes.
async fn favicon(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = p["projectId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid("projectId is required"))?;
    // The folder is the stored project's own. A project with none, or whose folder is gone, has no
    // favicon; an unknown id is not an error, so a deleted project's card still renders.
    let Some(folder) = st.db.project_get(id).ok().and_then(|project| project["path"].as_str().map(PathBuf::from)).filter(|folder| folder.is_dir()) else {
        return Ok(json!({"found": false}));
    };
    let found = tokio::task::spawn_blocking(move || find_favicon(&folder)).await.unwrap_or(None);
    Ok(match found {
        Some((path, mime, bytes)) => json!({"found": true, "path": path, "mime": mime, "dataBase64": base64::engine::general_purpose::STANDARD.encode(bytes)}),
        None => json!({"found": false}),
    })
}

/// The first entry of `FAVICON_PATHS` that is a regular file of at most `MAX_ICON_BYTES` and still
/// resolves inside the project's folder, with its media type and bytes.
fn find_favicon(folder: &Path) -> Option<(&'static str, &'static str, Vec<u8>)> {
    let root = folder.canonicalize().ok()?;
    for relative in FAVICON_PATHS {
        // A link, or a path with `..`, resolves to what it points at; one that lands outside the
        // project's folder is refused, and so is a folder or an oversized file.
        let Ok(real) = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR)).canonicalize() else { continue };
        if !stays_inside(&root, &real) { continue };
        let Ok(meta) = std::fs::metadata(&real) else { continue };
        if !meta.is_file() || meta.len() > MAX_ICON_BYTES { continue; }
        let Ok(bytes) = std::fs::read(&real) else { continue };
        if bytes.len() as u64 > MAX_ICON_BYTES { continue; }
        return Some((relative, media_type_of(relative), bytes));
    }
    None
}

/// Whether a resolved file is still inside the project's folder. It compares whole path components,
/// so a folder whose name merely starts with the project's (`shop` and `shop-two`) is outside.
pub(crate) fn stays_inside(root: &Path, real: &Path) -> bool {
    real.starts_with(root)
}

/// The media type comes from the extension of the fixed path, never from the file's content.
fn media_type_of(relative: &str) -> &'static str {
    if relative.ends_with(".svg") { "image/svg+xml" } else if relative.ends_with(".ico") { "image/x-icon" } else { "image/png" }
}
