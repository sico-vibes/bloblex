//! Authorised media preview for the chat.
//!
//! The webview's CSP allows `blob:` and `data:` sources only, so the daemon
//! hands the transcript its bytes as a data URL (exactly as `message.image`
//! does) or its text. A preview is read only from inside the conversation's own
//! project folder: the path is joined, checked as text, canonicalised and
//! required to stay inside that folder; files that may hold secrets are refused
//! by name; and the bytes have to match what the extension claims, or the reply
//! says the file cannot be previewed. This must never become a general file
//! read: every refusal is a normal reply with a status, and a path outside the
//! folder is never probed.
//!
//! Nothing here logs a path or a byte of content.

use chrono::Utc;
use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use base64::Engine as _;
use serde_json::{json, Value};
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};

/// A caller-supplied path longer than this is refused before any filesystem work.
const MAX_PATH_BYTES: usize = 1024;
/// Text is read up to this many bytes; a longer file reports `truncated`.
const TEXT_LIMIT: u64 = 256 * 1024;
/// Bytes looked at for a NUL when deciding whether text is really binary.
const TEXT_SNIFF_BYTES: usize = 4096;
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES: u64 = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 24 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SVG_BYTES: u64 = 1024 * 1024;

const REASON_OUTSIDE: &str = "That file is outside this project.";
const REASON_SECRETS: &str = "Bitbots does not preview files that may hold secrets.";
/// A generated record is read through its leaf, so a link there is refused.
const REASON_LINK: &str = "That file is a link, which Bitbots does not open.";
const REASON_MISMATCH: &str = "The file doesn't match its type.";

/// What the extension says the file is. Only the allowlist below can produce
/// anything but `Unsupported`, and the bytes still have to agree.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Image,
    Audio,
    Video,
    Pdf,
    Text,
    Unsupported,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Image => "image",
            Kind::Audio => "audio",
            Kind::Video => "video",
            Kind::Pdf => "pdf",
            Kind::Text => "text",
            Kind::Unsupported => "unsupported",
        }
    }
}

/// `media.preview`: one file from the conversation's project folder, as bytes
/// or text, for the transcript's card. Only a bad request or an unknown
/// conversation is an error; everything about the file itself is a status.
///
/// With `mediaId` instead of `path`, the file is the one generated-image record
/// stored for this conversation: the caller names a record, never a path, and
/// the reply never carries the folder.
pub(crate) async fn preview(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|value| !value.is_empty())
        .ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    let requested = p["path"].as_str().filter(|value| !value.is_empty());
    let media_id = p["mediaId"].as_str().filter(|value| !value.is_empty());
    if requested.is_some() && media_id.is_some() {
        return Err(derr("invalid_argument", "Use either path or mediaId, not both.", StatusCode::BAD_REQUEST));
    }
    let row = st.db.session_detail(session_id).map_err(|_| derr("not_found", "Conversation not found.", StatusCode::NOT_FOUND))?;
    let Some(media_id) = media_id else {
        let Some(requested) = requested else {
            return Err(derr("invalid_argument", "path or mediaId is required", StatusCode::BAD_REQUEST));
        };
        let root = row["projectPath"].as_str().unwrap_or("").to_owned();
        let requested = requested.to_owned();
        // Every read, every Git-free stat and the canonicalise happen off the async
        // runtime, so a slow disk cannot stall the daemon.
        return tokio::task::spawn_blocking(move || inspect(&root, &requested))
            .await
            .map_err(|_| derr("internal", "Could not read that file.", StatusCode::INTERNAL_SERVER_ERROR));
    };
    // A record of this conversation only, and only once its image is complete.
    let record = st.db.media_get(session_id, media_id)
        .map_err(|_| derr("internal", "Could not read that image.", StatusCode::INTERNAL_SERVER_ERROR))?;
    let unavailable = match &record {
        None => Some("That image is not part of this conversation."),
        Some(record) if record["status"] != "ready" => Some("That image is not ready yet."),
        Some(_) => None,
    };
    if let Some(reason) = unavailable {
        return Ok(refuse(base("", Kind::Image, None), "unavailable", reason));
    }
    let Some(stored) = record.and_then(|record| record["path"].as_str().map(str::to_owned)) else {
        return Ok(refuse(base("", Kind::Image, None), "unavailable", "That file is no longer there."));
    };
    tokio::task::spawn_blocking(move || inspect_generated(&stored))
        .await
        .map_err(|_| derr("internal", "Could not read that image.", StatusCode::INTERNAL_SERVER_ERROR))
}

/// A reply with every field the UI reads, filled in as the checks pass.
fn base(name: &str, kind: Kind, media_type: Option<&str>) -> Value {
    json!({
        "status": "ok",
        "reason": Value::Null,
        "name": name,
        "relativePath": Value::Null,
        "kind": kind.name(),
        "mediaType": media_type,
        "size": Value::Null,
        "dataUrl": Value::Null,
        "text": Value::Null,
        "truncated": false,
        "language": if kind == Kind::Text { json!(language_for(extension_of(name))) } else { Value::Null },
    })
}

fn refuse(mut reply: Value, status: &str, reason: &str) -> Value {
    reply["status"] = json!(status);
    reply["reason"] = json!(reason);
    reply
}

/// The file name only, for the card's title.
fn name_of(requested: &str) -> String {
    Path::new(requested).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

fn extension_of(name: &str) -> String {
    Path::new(name).extension().map(|ext| ext.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn kind_for(ext: &str) -> Kind {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "svg" | "avif" => Kind::Image,
        "mp3" | "wav" | "ogg" | "oga" | "m4a" | "aac" | "flac" | "opus" => Kind::Audio,
        "mp4" | "webm" | "mov" | "m4v" | "ogv" => Kind::Video,
        "pdf" => Kind::Pdf,
        "txt" | "md" | "markdown" | "json" | "jsonc" | "csv" | "tsv" | "log" | "yaml" | "yml" | "toml" | "ini"
        | "xml" | "html" | "htm" | "css" | "scss" | "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "rs" | "py"
        | "go" | "java" | "c" | "h" | "cpp" | "hpp" | "cs" | "rb" | "php" | "sh" | "ps1" | "bat" | "sql"
        | "diff" | "patch" | "lock" => Kind::Text,
        _ => Kind::Unsupported,
    }
}

/// The media type comes from the extension, never from anything the caller
/// sends beyond the path it asked to preview.
fn media_type_for(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "ogg" | "oga" | "opus" => Some("audio/ogg"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "flac" => Some("audio/flac"),
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mov" => Some("video/quicktime"),
        "m4v" => Some("video/x-m4v"),
        "ogv" => Some("video/ogg"),
        "pdf" => Some("application/pdf"),
        "txt" | "log" | "ini" | "ps1" | "bat" | "lock" => Some("text/plain"),
        "md" | "markdown" => Some("text/markdown"),
        "json" | "jsonc" => Some("application/json"),
        "csv" => Some("text/csv"),
        "tsv" => Some("text/tab-separated-values"),
        "yaml" | "yml" => Some("text/yaml"),
        "toml" => Some("application/toml"),
        "xml" => Some("application/xml"),
        "html" | "htm" => Some("text/html"),
        "css" => Some("text/css"),
        "scss" => Some("text/x-scss"),
        "js" | "mjs" | "cjs" => Some("text/javascript"),
        "jsx" => Some("text/jsx"),
        "ts" => Some("text/typescript"),
        "tsx" => Some("text/tsx"),
        "rs" => Some("text/rust"),
        "py" => Some("text/x-python"),
        "go" => Some("text/x-go"),
        "java" => Some("text/x-java"),
        "c" | "h" => Some("text/x-c"),
        "cpp" | "hpp" => Some("text/x-c++"),
        "cs" => Some("text/x-csharp"),
        "rb" => Some("text/x-ruby"),
        "php" => Some("text/x-php"),
        "sh" => Some("text/x-sh"),
        "sql" => Some("application/sql"),
        "diff" | "patch" => Some("text/x-diff"),
        _ => None,
    }
}

/// A short hint for the code viewer; the extension itself is good enough for
/// most files.
fn language_for(ext: String) -> String {
    match ext.as_str() {
        "yml" => "yaml".into(),
        "htm" => "html".into(),
        "jsonc" => "json".into(),
        "mjs" | "cjs" | "jsx" => "javascript".into(),
        "tsx" => "typescript".into(),
        "patch" => "diff".into(),
        _ => ext,
    }
}

/// The path with `.` and `..` resolved as text, so a path that leaves the
/// project folder is refused before the disk is asked whether it exists.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => { out.pop(); }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// A path as a comparable string: one separator, no Windows verbatim prefix,
/// no trailing separator, and case-folded on Windows.
fn comparable(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let without_prefix = match raw.strip_prefix("//?/UNC/") {
        Some(rest) => format!("//{rest}"),
        None => raw.strip_prefix("//?/").map(str::to_owned).unwrap_or(raw),
    };
    let trimmed = without_prefix.trim_end_matches('/').to_owned();
    if cfg!(windows) { trimmed.to_lowercase() } else { trimmed }
}

/// Containment on the comparable form, so root and target agree about the
/// verbatim prefix and, on Windows, about letter case.
fn is_inside(root: &Path, target: &Path) -> bool {
    let root = comparable(root);
    let target = comparable(target);
    target == root || target.starts_with(&format!("{root}/"))
}

/// The part of the canonical target below the canonical project folder.
fn tail_of(root: &Path, target: &Path) -> PathBuf {
    if let Ok(rest) = target.strip_prefix(root) { return rest.to_path_buf(); }
    let root_components = root.components().count();
    let parts: Vec<_> = target.components().collect();
    if parts.len() < root_components { return target.to_path_buf(); }
    parts[root_components..].iter().collect()
}

/// Any component that routinely holds credentials, and the file names that do.
pub(crate) fn names_a_secret(tail: &Path) -> bool {
    for component in tail.components() {
        let Component::Normal(part) = component else { continue };
        let part = part.to_string_lossy().to_lowercase();
        if matches!(part.as_str(), ".git" | "node_modules" | ".ssh" | ".aws" | ".gnupg") { return true; }
    }
    let Some(name) = tail.file_name().map(|name| name.to_string_lossy().to_lowercase()) else { return true };
    name.starts_with(".env")
        || [".pem", ".key", ".pfx", ".p12", ".kdbx"].iter().any(|ending| name.ends_with(ending))
        || matches!(name.as_str(), "id_rsa" | "id_ed25519" | ".npmrc" | ".pypirc" | "credentials" | "auth.json" | "secrets.json")
}

/// The whole check, in the order the brief sets out. Runs on the blocking pool.
fn inspect(root: &str, requested: &str) -> Value {
    let name = name_of(requested);
    let ext = extension_of(&name);
    let kind = kind_for(&ext);
    let mut reply = base(&name, kind, media_type_for(&ext));
    if requested.len() > MAX_PATH_BYTES || requested.contains('\0') {
        return refuse(reply, "blocked", "That file path is not valid.");
    }
    // 1. The root is the conversation's project folder and nothing else.
    if root.is_empty() {
        return refuse(reply, "unavailable", "This conversation has no project folder.");
    }
    let Ok(root_path) = Path::new(root).canonicalize() else {
        return refuse(reply, "unavailable", "This conversation's project folder is unavailable.");
    };
    if !root_path.is_dir() {
        return refuse(reply, "unavailable", "This conversation's project folder is unavailable.");
    }
    // 2. Join, then refuse by text first: a path that leaves the folder is
    // never probed, so its existence outside the folder stays unknown.
    let supplied = Path::new(requested);
    let joined = if supplied.is_absolute() { supplied.to_path_buf() } else { root_path.join(supplied) };
    if !is_inside(&root_path, &lexical(&joined)) {
        return refuse(reply, "blocked", REASON_OUTSIDE);
    }
    // 3. A symlinked leaf is never followed.
    match std::fs::symlink_metadata(&joined) {
        Ok(metadata) if metadata.file_type().is_symlink() => return refuse(reply, "blocked", REASON_OUTSIDE),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return refuse(reply, "unavailable", "That file is no longer there.");
        }
        Err(_) => return refuse(reply, "unavailable", "That file can't be read."),
    }
    // 4. Canonicalise, so `..`, symlinked folders and junctions are resolved,
    // and require the result to stay inside the canonical root.
    let Ok(target) = joined.canonicalize() else {
        return refuse(reply, "unavailable", "That file is no longer there.");
    };
    if !is_inside(&root_path, &target) {
        return refuse(reply, "blocked", REASON_OUTSIDE);
    }
    let tail = tail_of(&root_path, &target);
    if tail.as_os_str().is_empty() {
        return refuse(reply, "unavailable", "That path is not a file.");
    }
    reply["relativePath"] = json!(tail.to_string_lossy().replace('\\', "/"));
    // 5. Denied names, even inside the folder.
    if names_a_secret(&tail) {
        return refuse(reply, "blocked", REASON_SECRETS);
    }
    // 6. A regular file only, and never an empty one.
    let Ok(metadata) = std::fs::metadata(&target) else {
        return refuse(reply, "unavailable", "That file is no longer there.");
    };
    if !metadata.is_file() {
        return refuse(reply, "unavailable", "That path is not a file.");
    }
    let size = metadata.len();
    reply["size"] = json!(size);
    if size == 0 {
        return refuse(reply, "unavailable", "That file is empty.");
    }
    // 7. The extension allowlist.
    if kind == Kind::Unsupported {
        return refuse(reply, "unsupported", &format!("Bitbots can't preview {} files yet.", if ext.is_empty() { "untyped".into() } else { format!(".{ext}") }));
    }
    // 8. Size caps, checked before anything is read.
    if let Some(limit) = size_limit(kind, &ext) {
        if size > limit {
            return refuse(reply, "tooLarge", &format!("That file is too large to preview (limit {} MB).", limit / (1024 * 1024)));
        }
    }
    if kind == Kind::Text {
        let Ok(file) = std::fs::File::open(&target) else {
            return refuse(reply, "unavailable", "That file can't be read.");
        };
        let mut bytes = Vec::new();
        if file.take(TEXT_LIMIT).read_to_end(&mut bytes).is_err() {
            return refuse(reply, "unavailable", "That file can't be read.");
        }
        if bytes[..bytes.len().min(TEXT_SNIFF_BYTES)].contains(&0) {
            return refuse(reply, "unsupported", "That file is binary.");
        }
        reply["text"] = json!(String::from_utf8_lossy(&bytes));
        reply["truncated"] = json!(size > TEXT_LIMIT);
        return reply;
    }
    let Ok(bytes) = std::fs::read(&target) else {
        return refuse(reply, "unavailable", "That file can't be read.");
    };
    // 9. The bytes have to match what the extension claims.
    if !matches_its_type(kind, &ext, &bytes) {
        return refuse(reply, "unsupported", REASON_MISMATCH);
    }
    let Some(media_type) = media_type_for(&ext) else {
        return refuse(reply, "unsupported", REASON_MISMATCH);
    };
    reply["dataUrl"] = json!(format!("data:{media_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)));
    reply
}

fn size_limit(kind: Kind, ext: &str) -> Option<u64> {
    match kind {
        Kind::Image if ext == "svg" => Some(MAX_SVG_BYTES),
        Kind::Image => Some(MAX_IMAGE_BYTES),
        Kind::Audio => Some(MAX_AUDIO_BYTES),
        Kind::Video => Some(MAX_VIDEO_BYTES),
        Kind::Pdf => Some(MAX_PDF_BYTES),
        Kind::Text | Kind::Unsupported => None,
    }
}

fn matches_its_type(kind: Kind, ext: &str, bytes: &[u8]) -> bool {
    match kind {
        Kind::Image => image_matches(ext, bytes),
        Kind::Pdf => bytes.starts_with(b"%PDF-"),
        // A container signature is cheap where a family has one; where it has
        // none, the extension is trusted, but a file that is plainly something
        // else (a PNG called `.mp4`) is refused.
        Kind::Audio | Kind::Video => !looks_like_another_kind(bytes),
        Kind::Text | Kind::Unsupported => true,
    }
}

fn image_matches(ext: &str, bytes: &[u8]) -> bool {
    match ext {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "gif" => bytes.starts_with(b"GIF8"),
        "webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "bmp" => bytes.starts_with(b"BM"),
        "ico" => bytes.starts_with(&[0, 0, 1, 0]),
        "avif" => bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis"),
        "svg" => svg_matches(bytes),
        _ => false,
    }
}

/// An SVG must look like an XML document that carries an `<svg>` element; a
/// script or an HTML page renamed `.svg` is refused.
fn svg_matches(bytes: &[u8]) -> bool {
    if bytes.len() > MAX_SVG_BYTES as usize { return false; }
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']);
    let lower = trimmed.to_lowercase();
    (lower.starts_with("<svg") || trimmed.starts_with("<?xml")) && lower.contains("<svg")
}

/// Signatures of the families an audio or video file is not: enough to catch a
/// mislabelled image or document without a container parser.
fn looks_like_another_kind(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"GIF8")
        || bytes.starts_with(b"%PDF-")
        || bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"MZ")
        || bytes.starts_with(b"\x7fELF")
        || (bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

// ── Phase 2: generated images ────────────────────────────────────────────────
/// Where an image the provider handed us as bytes is written, under the data folder.
const GENERATED_DIR: &str = "generated";
/// An image is capped exactly as an attached one is.
const MAX_GENERATED_BYTES: u64 = 20 * 1024 * 1024;
/// How often the pending rows are looked at. Two seconds is cheap when nothing
/// is pending: one indexed read of an empty set.
const MEDIA_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
/// After this the image is not coming: OpenCode's own job gives up at 30 minutes.
const MEDIA_DEADLINE_SECS: i64 = 35 * 60;
/// A file written moments before the request is still its result: allow this
/// much clock slack between the request time and the file's modification time.
const MEDIA_CLOCK_SLACK_SECS: i64 = 5;
/// The extensions a stem may take, in the order. The agent chose the name; the
/// format is only known when the file arrives.
const STEM_EXTENSIONS: [&str; 4] = ["png", "jpg", "webp", "gif"];

/// One `ImageRequested` from an adapter. The order is the brief's: a file the
/// provider already saved, then the image itself, then where to expect it, then
/// a failure. Exactly one of them applies, and nothing here depends on a turn
/// being active.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn requested(
    st: &AppState,
    sid: &str,
    turn: Option<&str>,
    provider: &str,
    tool_call_id: &str,
    stem: Option<String>,
    saved_path: Option<String>,
    inline_base64: Option<String>,
    failure: Option<String>,
) {
    if !st.db.session_exists(sid).unwrap_or(false) {
        return;
    }
    // One row per call id: a later notice updates the request it describes.
    let existing = st.db.media_by_call(sid, tool_call_id).ok().flatten();
    let media_id = existing.as_ref().and_then(|row| row["id"].as_str().map(str::to_owned))
        .unwrap_or_else(bloblex_storage::Storage::new_media_id);
    let turn_id = existing.as_ref().and_then(|row| row["turnId"].as_str().map(str::to_owned))
        .or_else(|| turn.map(str::to_owned));
    let row = if let Some(failure) = failure {
        // A reported failure wins over anything else the same event carries.
        let detail = failure_reason(&failure);
        finish_failed(st, &media_id, existing.as_ref(), sid, turn_id.as_deref(), provider, tool_call_id, &detail)
    } else {
        // Codex sends both the file it saved and the image itself: the saved file
        // wins, because copying it into the data folder would only duplicate it.
        // The bytes are the fallback when that file cannot be used.
        let saved = saved_path.map(|path| (path.clone(), check_saved_file(&path)));
        match (saved, inline_base64) {
            (Some((path, Ok((name, bytes, media_type)))), _) => {
                finish_ready(st, &media_id, existing.as_ref(), sid, turn_id.as_deref(), provider, tool_call_id, &path, &name, bytes, media_type)
            }
            (_, Some(encoded)) => match write_inline(st, sid, &media_id, &encoded).await {
                Ok((path, name, bytes, media_type)) => {
                    finish_ready(st, &media_id, existing.as_ref(), sid, turn_id.as_deref(), provider, tool_call_id, &path, &name, bytes, media_type)
                }
                Err(detail) => finish_failed(st, &media_id, existing.as_ref(), sid, turn_id.as_deref(), provider, tool_call_id, &detail),
            },
            (Some((_, Err(detail))), None) => finish_failed(st, &media_id, existing.as_ref(), sid, turn_id.as_deref(), provider, tool_call_id, &detail),
            (None, None) => match stem {
                // A stem that is not absolute records nothing at all: the daemon would
                // otherwise be looking for a file relative to a folder it did not choose.
                Some(stem) => {
                    if !std::path::Path::new(&stem).is_absolute() { return; }
                    let stem = stem.trim_end_matches(['.', ' ', '\\', '/']).to_owned();
                    if stem.is_empty() || existing.is_some() { return; }
                    st.db.media_insert(&media_id, sid, turn_id.as_deref(), provider, tool_call_id, Some(&stem), None, "pending", None, None, None, None).ok().flatten()
                }
                None => return,
            },
        }
    };
    if let Some(row) = row {
        publish(st, &row).await;
    }
}

/// A file name or reason as one bounded line, free of control characters.
fn one_line(text: &str, limit: usize) -> String {
    let line = text.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
    line.chars().filter(|c| !c.is_control()).take(limit).collect()
}

/// A provider's own reason, made safe for the transcript and for a phone: one
/// bounded line, the daemon's secret redaction, and no path. OpenCode's failures
/// name the stem, and `meta` must carry no path at all.
fn failure_reason(text: &str) -> String {
    let redacted = crate::diagnostics::redact(&one_line(text, 200));
    let without_paths = without_paths(&redacted);
    if without_paths.is_empty() { "The image request failed.".to_owned() } else { without_paths }
}

/// The text with every absolute-path-looking token replaced by "the file".
fn without_paths(text: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for token in text.split_whitespace() {
        if looks_like_path(token) { out.push("the file"); } else { out.push(token); }
    }
    out.join(" ")
}

fn looks_like_path(token: &str) -> bool {
    let trimmed = token.trim_matches(|c: char| matches!(c, '\'' | '"' | '(' | ')' | ',' | '.' | ';' | '`'));
    let bytes = trimmed.as_bytes();
    // A drive path (`C:\...`, `C:/...`), a UNC share, or a Unix root.
    if bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/') {
        return true;
    }
    if trimmed.starts_with("\\\\") || (trimmed.starts_with('/') && trimmed.len() > 1) {
        return true;
    }
    trimmed.contains('\\') || trimmed.contains('/')
}

/// Marks the row ready, or the pending row that already exists.
#[allow(clippy::too_many_arguments)]
fn finish_ready(
    st: &AppState,
    media_id: &str,
    existing: Option<&Value>,
    sid: &str,
    turn: Option<&str>,
    provider: &str,
    tool_call_id: &str,
    path: &str,
    name: &str,
    bytes: u64,
    media_type: &str,
) -> Option<Value> {
    match existing {
        Some(_) => st.db.media_mark_ready(media_id, path, name, bytes as i64, media_type).ok().flatten(),
        None => st.db.media_insert(media_id, sid, turn, provider, tool_call_id, None, Some(path), "ready", Some(name), Some(bytes as i64), Some(media_type), None).ok().flatten(),
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_failed(
    st: &AppState,
    media_id: &str,
    existing: Option<&Value>,
    sid: &str,
    turn: Option<&str>,
    provider: &str,
    tool_call_id: &str,
    detail: &str,
) -> Option<Value> {
    match existing {
        Some(_) => st.db.media_mark_failed(media_id, detail).ok().flatten(),
        None => st.db.media_insert(media_id, sid, turn, provider, tool_call_id, None, None, "failed", None, None, None, Some(detail)).ok().flatten(),
    }
}

/// The one place the transcript learns about a generated image: the message
/// that carries the media id, then the session summary and the small event.
/// `meta` holds no path, so a message crossing to a phone has nothing to redact.
async fn publish(st: &AppState, row: &Value) {
    let Some(media_id) = row["id"].as_str() else { return };
    let Some(sid) = row["sessionId"].as_str() else { return };
    let status = row["status"].as_str().unwrap_or("failed");
    let name = row["name"].as_str().unwrap_or("");
    let detail = row["detail"].as_str().unwrap_or("");
    let text = match status {
        "pending" => "Generating an image…".to_owned(),
        "ready" => format!("Generated an image: {name}"),
        _ => format!("The image couldn't be generated: {}", if detail.is_empty() { "the request failed." } else { detail }),
    };
    let meta = json!({
        "kind": "generated_image",
        "mediaId": media_id,
        "status": status,
        "name": row["name"],
        "bytes": row["bytes"],
        "mediaType": row["mediaType"],
        "provider": row["provider"],
        "detail": row["detail"],
    });
    // A record whose conversation is gone writes nothing; the row went with it.
    // `message.completed` carries the whole message, and the client replaces the
    // row with this id rather than appending, so the card moves from "Generating…"
    // to its result without a reload.
    if let Ok(message) = st.db.media_message_write(media_id, sid, &text, &meta) {
        if !message.is_null() {
            st.emit("message.completed", json!({"sessionId":sid,"messageId":media_id,"role":"notice","message":message})).await;
        }
    }
    if let Ok(summary) = st.db.session_event_summary(sid) {
        st.emit("session.changed", summary).await;
    }
    st.emit("media.generated", json!({"sessionId":sid,"mediaId":media_id,"status":status})).await;
}

/// The extension an image's own bytes claim, and its media type.
fn generated_extension(media_type: &str) -> &'static str {
    match media_type { "image/png" => "png", "image/jpeg" => "jpg", "image/gif" => "gif", _ => "webp" }
}

fn generated_folder(st: &AppState, sid: &str) -> Option<PathBuf> {
    let base = st.team.data_dir.lock().ok().and_then(|dir| dir.clone())?;
    Some(base.join(GENERATED_DIR).join(sid))
}

/// Writes the provider's own image bytes under the data folder, named after the
/// media id. Only the four formats the chat can show are accepted.
async fn write_inline(st: &AppState, sid: &str, media_id: &str, encoded: &str) -> Result<(String, String, u64, &'static str), String> {
    // Base64 is about 4/3 of the bytes: refuse an obviously oversized text before
    // copying it or decoding it.
    const MAX_ENCODED_BYTES: usize = MAX_GENERATED_BYTES as usize / 3 * 4 + 64;
    if encoded.len() > MAX_ENCODED_BYTES {
        return Err("The generated image was too large to keep.".to_owned());
    }
    let compact: String = encoded.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.len() > MAX_ENCODED_BYTES {
        return Err("The generated image was too large to keep.".to_owned());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(compact.as_bytes())
        .map_err(|_| "The generated image was damaged.".to_owned())?;
    if bytes.is_empty() { return Err("The generated image was empty.".to_owned()); }
    if bytes.len() as u64 > MAX_GENERATED_BYTES { return Err("The generated image was too large to keep.".to_owned()); }
    let media_type = crate::image_media_type(&bytes[..bytes.len().min(12)]).ok_or_else(|| "The generated image was not a PNG, JPEG, WebP or GIF.".to_owned())?;
    let folder = generated_folder(st, sid).ok_or_else(|| "The image folder is unavailable.".to_owned())?;
    let ext = generated_extension(media_type);
    let file = format!("{media_id}.{ext}");
    tokio::fs::create_dir_all(&folder).await.map_err(|_| "The image folder is unavailable.".to_owned())?;
    let path = folder.join(&file);
    tokio::fs::write(&path, &bytes).await.map_err(|_| "The generated image could not be saved.".to_owned())?;
    Ok((path.to_string_lossy().into_owned(), file, bytes.len() as u64, media_type))
}

/// Checks a file the provider says it already saved: absolute, a regular file,
/// not a symlink, not empty, inside the size cap, one of the four formats, and
/// its bytes have to agree with its extension.
fn check_saved_file(path: &str) -> Result<(String, u64, &'static str), String> {
    if !std::path::Path::new(path).is_absolute() || path.contains('\0') {
        return Err("The generated image was not saved to a usable path.".to_owned());
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "The generated image is no longer there.".to_owned())?;
    if metadata.file_type().is_symlink() { return Err("The generated image is a link, which Bitbots does not open.".to_owned()); }
    if !metadata.is_file() { return Err("The generated image is no longer there.".to_owned()); }
    let bytes_on_disk = metadata.len();
    if bytes_on_disk == 0 { return Err("The generated image was empty.".to_owned()); }
    if bytes_on_disk > MAX_GENERATED_BYTES { return Err("The generated image was too large to keep.".to_owned()); }
    let name = Path::new(path).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = extension_of(&name);
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") {
        return Err("The generated image was not a PNG, JPEG, WebP or GIF.".to_owned());
    }
    let header = {
        use std::io::Read as _;
        let mut header = [0u8; 16];
        let read = std::fs::File::open(path).and_then(|mut file| file.read(&mut header)).unwrap_or(0);
        header[..read].to_vec()
    };
    let media_type = crate::image_media_type(&header).ok_or_else(|| "The generated image was not a PNG, JPEG, WebP or GIF.".to_owned())?;
    if !image_matches(&ext, &header) { return Err(REASON_MISMATCH.to_owned()); }
    Ok((name, bytes_on_disk, media_type))
}

/// The sweep: two seconds apart, look at every pending row and decide whether
/// its file has arrived. Nothing here holds a turn open or changes session state.
pub(crate) async fn sweep_loop(st: AppState) {
    let mut ticker = tokio::time::interval(MEDIA_SWEEP_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ticker.tick() => sweep_once(&st).await,
            // The daemon's own shutdown signal: stop rather than tick into a closing store.
            _ = st.stopping.notified() => return,
        }
    }
}

/// One pass of the sweep, so a test can make time pass without waiting.
pub(crate) async fn sweep_once(st: &AppState) {
    let Ok(rows) = st.db.media_pending() else { return };
    for row in rows {
        let Some(media_id) = row["id"].as_str().map(str::to_owned) else { continue };
        let Some(sid) = row["sessionId"].as_str().map(str::to_owned) else { continue };
        if !st.db.session_exists(&sid).unwrap_or(false) { continue; }
        let Some(stem) = row["stem"].as_str().map(str::to_owned) else { continue };
        let requested_at = row["createdAt"].as_str().and_then(|stamp| chrono::DateTime::parse_from_rfc3339(stamp).ok()).map(|stamp| stamp.with_timezone(&Utc));
        match find_stem_file(&stem, requested_at, row["bytes"].as_i64()).await {
            StemLook::Arrived(path, name, bytes, media_type) => {
                if let Ok(Some(row)) = st.db.media_mark_ready(&media_id, &path, &name, bytes, media_type) {
                    publish(st, &row).await;
                }
            }
            StemLook::Waiting(size) => {
                // A file whose size never settles is still a file that never
                // arrived: the deadline applies here too.
                if expired(requested_at) {
                    if let Ok(Some(row)) = st.db.media_mark_failed(&media_id, "The image didn't arrive.") {
                        publish(st, &row).await;
                    }
                } else {
                    let _ = st.db.media_note_pending_size(&media_id, size);
                }
            }
            StemLook::Nothing => {
                if expired(requested_at) {
                    if let Ok(Some(row)) = st.db.media_mark_failed(&media_id, "The image didn't arrive.") {
                        publish(st, &row).await;
                    }
                }
            }
        }
    }
}

/// Whether a request has been waiting long enough that its image is not coming.
fn expired(requested_at: Option<chrono::DateTime<Utc>>) -> bool {
    requested_at.is_some_and(|at| Utc::now().signed_duration_since(at).num_seconds() >= MEDIA_DEADLINE_SECS)
}

enum StemLook {
    /// The file is there, complete and shows as one of the four formats.
    Arrived(String, String, i64, &'static str),
    /// A file that passes every check except that its size has not settled; the
    /// size is remembered so the next pass can require the same one.
    Waiting(i64),
    /// Nothing usable at that path yet.
    Nothing,
}

/// The first of `<stem>.<ext>` that is a complete image: a regular file, not a
/// symlink, written at or after the request (with clock slack), of a known
/// format, and the same size on two passes in a row.
async fn find_stem_file(stem: &str, requested_at: Option<chrono::DateTime<Utc>>, last_size: Option<i64>) -> StemLook {
    for ext in STEM_EXTENSIONS {
        let path = format!("{stem}.{ext}");
        let Some(candidate) = tokio::task::spawn_blocking(move || probe_candidate(path)).await.ok().flatten() else { continue };
        let (path, name, size, modified) = candidate;
        if let (Some(requested_at), Some(modified)) = (requested_at, modified) {
            // A file that was already there before the request is not its result.
            if modified + chrono::Duration::seconds(MEDIA_CLOCK_SLACK_SECS) < requested_at { continue; }
        }
        let bytes = match tokio::fs::read(&path).await { Ok(bytes) => bytes, Err(_) => continue };
        if bytes.is_empty() || bytes.len() as u64 > MAX_GENERATED_BYTES { continue; }
        let Some(media_type) = crate::image_media_type(&bytes[..bytes.len().min(12)]) else { continue };
        if !image_matches(ext, &bytes[..bytes.len().min(16)]) { continue; }
        if last_size != Some(size) { return StemLook::Waiting(size); }
        return StemLook::Arrived(path.to_string_lossy().into_owned(), name, size, media_type);
    }
    StemLook::Nothing
}

/// The cheap file checks for one candidate path, on the blocking pool.
fn probe_candidate(path: String) -> Option<(PathBuf, String, i64, Option<chrono::DateTime<Utc>>)> {
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() { return None; }
    if metadata.len() == 0 || metadata.len() > MAX_GENERATED_BYTES { return None; }
    let modified = metadata.modified().ok().map(chrono::DateTime::<Utc>::from);
    let name = Path::new(&path).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    Some((PathBuf::from(path), name, metadata.len() as i64, modified))
}

/// `media.preview {mediaId}`: the exact file its record stores, and nothing the
/// caller names. The reply is the usual card shape with `kind:"image"`,
/// `relativePath:null` and the file's name only, so the folder never leaves.
fn inspect_generated(stored: &str) -> Value {
    let name = name_of(stored);
    let ext = extension_of(&name);
    let mut reply = base(&name, Kind::Image, media_type_for(&ext));
    // Only the four generated formats, by extension and then by bytes. No SVG.
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") {
        return refuse(reply, "unsupported", REASON_MISMATCH);
    }
    match std::fs::symlink_metadata(stored) {
        Ok(metadata) if metadata.file_type().is_symlink() => return refuse(reply, "blocked", REASON_LINK),
        Ok(metadata) if !metadata.is_file() => return refuse(reply, "unavailable", "That file is no longer there."),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return refuse(reply, "unavailable", "That file is no longer there."),
        Err(_) => return refuse(reply, "unavailable", "That file can't be read."),
    }
    let Ok(metadata) = std::fs::metadata(stored) else {
        return refuse(reply, "unavailable", "That file is no longer there.");
    };
    let size = metadata.len();
    reply["size"] = json!(size);
    if size == 0 {
        return refuse(reply, "unavailable", "That file is empty.");
    }
    if size > MAX_GENERATED_BYTES {
        return refuse(reply, "tooLarge", "That image is too large to preview (limit 20 MB).");
    }
    let Ok(bytes) = std::fs::read(stored) else {
        return refuse(reply, "unavailable", "That file can't be read.");
    };
    if !image_matches(&ext, &bytes) {
        return refuse(reply, "unsupported", REASON_MISMATCH);
    }
    let Some(media_type) = media_type_for(&ext) else {
        return refuse(reply, "unsupported", REASON_MISMATCH);
    };
    reply["dataUrl"] = json!(format!("data:{media_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)));
    reply
}

/// `media.reveal {sessionId, mediaId}`: shows a complete image in its folder,
/// with the file selected. The caller names a record, never a path, and the
/// daemon opens only the path that record stores.
pub(crate) async fn reveal(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|value| !value.is_empty())
        .ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    let media_id = p["mediaId"].as_str().filter(|value| !value.is_empty())
        .ok_or_else(|| derr("invalid_argument", "mediaId is required", StatusCode::BAD_REQUEST))?;
    st.db.session_detail(session_id).map_err(|_| derr("not_found", "Conversation not found.", StatusCode::NOT_FOUND))?;
    let record = st.db.media_get(session_id, media_id)
        .map_err(|_| derr("internal", "Could not read that image.", StatusCode::INTERNAL_SERVER_ERROR))?;
    let unavailable = match &record {
        None => Some("That image is not part of this conversation."),
        Some(record) if record["status"] != "ready" => Some("That image is not ready yet."),
        Some(_) => None,
    };
    if let Some(reason) = unavailable {
        return Ok(json!({"status":"unavailable","revealed":false,"reason":reason}));
    }
    let Some(stored) = record.and_then(|record| record["path"].as_str().map(str::to_owned)) else {
        return Ok(json!({"status":"unavailable","revealed":false,"reason":"That file is no longer there."}));
    };
    if !Path::new(&stored).is_file() {
        return Ok(json!({"status":"unavailable","revealed":false,"reason":"That file is no longer there."}));
    }
    show_in_folder(&stored);
    Ok(json!({"status":"ok","revealed":true}))
}

/// Opens the file's folder with the file selected: one fixed program, two fixed
/// arguments, no shell. `/select` wants backslashes, and Codex paths can use
/// forward slashes, so the path is normalised first; passing `/select,` as its
/// own argument is what keeps a path with spaces in it whole. A test proves the
/// decision above, not Explorer.
fn show_in_folder(path: &str) {
    if cfg!(test) { return; }
    let native = path.replace('/', "\\");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        let _ = std::process::Command::new("explorer.exe")
            .arg("/select,")
            .arg(native)
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = native;
        let folder = Path::new(path).parent().unwrap_or(Path::new("."));
        let _ = std::process::Command::new("xdg-open").arg(folder).spawn();
    }
}
