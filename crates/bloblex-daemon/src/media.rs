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
pub(crate) async fn preview(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let session_id = p["sessionId"].as_str().filter(|value| !value.is_empty())
        .ok_or_else(|| derr("invalid_argument", "sessionId is required", StatusCode::BAD_REQUEST))?;
    let requested = p["path"].as_str().filter(|value| !value.is_empty())
        .ok_or_else(|| derr("invalid_argument", "path is required", StatusCode::BAD_REQUEST))?;
    let row = st.db.session_detail(session_id).map_err(|_| derr("not_found", "Conversation not found.", StatusCode::NOT_FOUND))?;
    let root = row["projectPath"].as_str().unwrap_or("").to_owned();
    let requested = requested.to_owned();
    // Every read, every Git-free stat and the canonicalise happen off the async
    // runtime, so a slow disk cannot stall the daemon.
    tokio::task::spawn_blocking(move || inspect(&root, &requested))
        .await
        .map_err(|_| derr("internal", "Could not read that file.", StatusCode::INTERNAL_SERVER_ERROR))
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
fn names_a_secret(tail: &Path) -> bool {
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
