use futures_util::{SinkExt, StreamExt};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, RunEvent, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

mod updates;
mod speech;

#[cfg(test)]
mod file_inspection_tests;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Clone, Debug)]
struct DaemonConnection {
    address: String,
    capability: String,
}

struct DaemonProcess {
    child: Child,
    executable_copy: PathBuf,
    connection: DaemonConnection,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SelectedFilePurpose {
    Export,
    Import,
}

struct SelectedFilePath {
    path: PathBuf,
    purpose: SelectedFilePurpose,
}

struct AppState {
    daemon: Arc<Mutex<Option<DaemonProcess>>>,
    daemon_start_lock: Mutex<()>,
    event_cursor: Arc<AtomicU64>,
    active_session: Arc<Mutex<Option<String>>>,
    active_runtime: Arc<Mutex<Option<String>>>,
    event_stream_started: Arc<Mutex<bool>>,
    companion_resize_in_progress: Arc<AtomicBool>,
    companion_resize_generation: Arc<AtomicU64>,
    close_to_tray: AtomicBool,
    selected_file_paths: Mutex<HashMap<String, SelectedFilePath>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            daemon: Arc::new(Mutex::new(None)),
            daemon_start_lock: Mutex::new(()),
            event_cursor: Arc::new(AtomicU64::new(0)),
            active_session: Arc::new(Mutex::new(None)),
            active_runtime: Arc::new(Mutex::new(None)),
            event_stream_started: Arc::new(Mutex::new(false)),
            companion_resize_in_progress: Arc::new(AtomicBool::new(false)),
            companion_resize_generation: Arc::new(AtomicU64::new(0)),
            close_to_tray: AtomicBool::new(true),
            selected_file_paths: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyLine {
    protocol_version: u32,
    address: String,
    capability: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcRequest<'a> {
    v: u32,
    id: String,
    method: &'a str,
    params: &'a Value,
}

#[derive(Deserialize)]
struct RpcResponse {
    v: u32,
    id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<RpcError>,
}

#[derive(Deserialize)]
struct RpcError {
    code: String,
    message: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DaemonEvent {
    v: u32,
    #[serde(default)]
    event_id: String,
    sequence: u64,
    #[serde(default)]
    timestamp: String,
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Point {
    x: i32,
    y: i32,
    #[serde(default)]
    anchor_x: Option<f64>,
    #[serde(default)]
    bottom_gap: Option<f64>,
    #[serde(default)]
    monitor_name: Option<String>,
}

fn app_data_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let root = app.path().app_config_dir().ok()?;
    fs::create_dir_all(&root).ok()?;
    Some(root.join(name))
}

fn connection(state: &State<'_, AppState>) -> Result<DaemonConnection, String> {
    let mut process = state
        .daemon
        .lock()
        .map_err(|_| "Daemon state is unavailable.".to_string())?;
    let Some(daemon) = process.as_mut() else {
        return Err("The local Bloblex daemon is not running.".to_string());
    };
    if daemon
        .child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        let executable_copy = daemon.executable_copy.clone();
        *process = None;
        let _ = fs::remove_file(executable_copy);
        return Err("The local Bloblex daemon stopped unexpectedly.".to_string());
    }
    Ok(process
        .as_ref()
        .expect("checked daemon slot")
        .connection
        .clone())
}

fn candidate_daemon_paths(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = app.path().resolve(
        "binaries/bloblexd-x86_64-pc-windows-msvc.exe",
        tauri::path::BaseDirectory::Resource,
    ) {
        candidates.push(path);
    }
    if let Ok(path) = app
        .path()
        .resolve("bloblexd.exe", tauri::path::BaseDirectory::Resource)
    {
        candidates.push(path);
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("binaries/bloblexd-x86_64-pc-windows-msvc.exe"));
    if let Ok(target_dir) = std::env::var("CARGO_TARGET_DIR") {
        let target_dir = PathBuf::from(target_dir);
        candidates.push(target_dir.join("debug/bloblexd.exe"));
        candidates.push(target_dir.join("release/bloblexd.exe"));
    }
    candidates.push(manifest.join("../../../target/debug/bloblexd.exe"));
    candidates.push(manifest.join("../../../target/release/bloblexd.exe"));
    candidates
}

fn start_daemon(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let _startup_guard = state
        .daemon_start_lock
        .lock()
        .map_err(|_| "Daemon startup state is unavailable.".to_string())?;
    {
        let mut slot = state
            .daemon
            .lock()
            .map_err(|_| "Daemon state is unavailable.".to_string())?;
        if let Some(existing) = slot.as_mut() {
            if existing
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                return Ok(());
            }
            let stopped_copy = existing.executable_copy.clone();
            *slot = None;
            let _ = fs::remove_file(stopped_copy);
        }
    }
    let executable = candidate_daemon_paths(app)
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "bloblexd.exe is missing. Build the workspace daemon first (npm run build:daemon)."
                .to_string()
        })?;

    let mut runtime_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve Bloblex local data directory: {error}"))?;
    runtime_dir.push("runtime-processes");
    fs::create_dir_all(&runtime_dir)
        .map_err(|error| format!("Could not prepare the local daemon folder: {error}"))?;
    let executable_copy = runtime_dir.join(format!(
        "bloblexd-{}-{}.exe",
        std::process::id(),
        Uuid::new_v4()
    ));
    fs::copy(&executable, &executable_copy).map_err(|error| {
        format!("Could not copy the daemon to its private run location: {error}")
    })?;

    let mut command = Command::new(&executable_copy);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|error| {
        let _ = fs::remove_file(&executable_copy);
        format!("Could not start bloblexd.exe: {error}")
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Daemon bootstrap stream is unavailable.".to_string())?;
    let stderr = child.stderr.take();
    let mut reader = BufReader::new(stdout);
    let (bootstrap_tx, bootstrap_rx) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut line = String::new();
        let result = reader
            .read_line(&mut line)
            .map(|_| line)
            .map_err(|error| error.to_string());
        let _ = bootstrap_tx.send(result);
        for _line in reader.lines() {}
    });
    let line = match bootstrap_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(line)) if !line.trim().is_empty() => line,
        Ok(Ok(_)) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&executable_copy);
            return Err("Daemon exited before sending its bootstrap line.".to_string());
        }
        Ok(Err(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&executable_copy);
            return Err(format!("Could not read daemon bootstrap: {error}"));
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&executable_copy);
            return Err("Daemon did not send its bootstrap line within 10 seconds.".to_string());
        }
    };
    let ready: ReadyLine = match serde_json::from_str(line.trim()) {
        Ok(ready) => ready,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&executable_copy);
            return Err("Daemon returned an invalid bootstrap line.".to_string());
        }
    };
    if ready.protocol_version != 1
        || !ready.address.starts_with("127.0.0.1:")
        || ready.capability.is_empty()
    {
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_file(&executable_copy);
        return Err("Daemon bootstrap did not satisfy the local IPC contract.".to_string());
    }
    if let Some(stderr) = stderr {
        thread::spawn(move || for _line in BufReader::new(stderr).lines() {});
    }

    let mut slot = state
        .daemon
        .lock()
        .map_err(|_| "Daemon state is unavailable.".to_string())?;
    *slot = Some(DaemonProcess {
        child,
        executable_copy,
        connection: DaemonConnection {
            address: ready.address,
            capability: ready.capability,
        },
    });
    Ok(())
}

async fn rpc_call(
    connection: &DaemonConnection,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())?;
    let request_id = format!("desktop_{}", Uuid::new_v4());
    let request = RpcRequest {
        v: 1,
        id: request_id.clone(),
        method,
        params: &params,
    };
    let response = client
        .post(format!("http://{}/v1/rpc", connection.address))
        .header(AUTHORIZATION, format!("Bearer {}", connection.capability))
        .header(CONTENT_TYPE, "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|error| format!("Daemon request failed: {error}"))?;
    let status = response.status();
    let body = response
        .json::<RpcResponse>()
        .await
        .map_err(|error| format!("Daemon returned invalid JSON: {error}"))?;
    if body.v != 1 || body.id != request_id {
        return Err("Daemon response did not match the request.".to_string());
    }
    if !status.is_success() || !body.ok {
        let error = body.error.unwrap_or(RpcError {
            code: "internal".to_string(),
            message: "Daemon request failed.".to_string(),
        });
        return Err(format!("{}: {}", error.code, error.message));
    }
    Ok(body.result.unwrap_or(Value::Null))
}

#[tauri::command]
async fn daemon_rpc(
    state: State<'_, AppState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let conn = connection(&state)?;
    let result = rpc_call(&conn, &method, params).await?;
    if method == "app.snapshot" {
        if let Some(sequence) = result.get("sequence").and_then(Value::as_u64) {
            state.event_cursor.store(sequence, Ordering::Release);
        }
    }
    Ok(result)
}

#[tauri::command]
async fn daemon_events_start(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let mut started = state
        .event_stream_started
        .lock()
        .map_err(|_| "Event stream state is unavailable.".to_string())?;
    if *started {
        return Ok(());
    }
    *started = true;
    let cursor = state.event_cursor.load(Ordering::Acquire);
    let app_handle = app.clone();
    let event_cursor = Arc::clone(&state.event_cursor);
    let daemon = Arc::clone(&state.daemon);
    thread::spawn(move || event_loop(app_handle, daemon, event_cursor, cursor));
    Ok(())
}

#[tauri::command]
fn ensure_daemon(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    start_daemon(&app, &state)
}

fn event_loop(
    app: AppHandle,
    daemon: Arc<Mutex<Option<DaemonProcess>>>,
    cursor: Arc<AtomicU64>,
    initial: u64,
) {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    runtime.block_on(async move {
        let mut last = initial;
        let mut stream_connected = false;
        loop {
            let conn = daemon
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().map(|process| process.connection.clone()));
            let Some(conn) = conn else {
                if stream_connected {
                    let _ = app.emit("daemon-connection", false);
                    stream_connected = false;
                }
                thread::sleep(Duration::from_millis(900));
                continue;
            };
            let url = format!("ws://{}/v1/events", conn.address);
            let mut request = match url.into_client_request() {
                Ok(request) => request,
                Err(_) => break,
            };
            if let Ok(value) = format!("Bearer {}", conn.capability).parse() {
                request.headers_mut().insert(AUTHORIZATION, value);
            }
            match tokio_tungstenite::connect_async(request).await {
                Ok((mut socket, _)) => {
                    let snapshot_cursor = cursor.load(Ordering::Acquire);
                    if snapshot_cursor < last {
                        last = snapshot_cursor;
                    }
                    let sequence = cursor.load(Ordering::Acquire);
                    let hello = json!({"v": 1, "afterSequence": sequence});
                    if socket
                        .send(Message::Text(hello.to_string().into()))
                        .await
                        .is_err()
                    {
                        if stream_connected {
                            let _ = app.emit("daemon-connection", false);
                            stream_connected = false;
                        }
                        thread::sleep(Duration::from_millis(250));
                        continue;
                    }
                    while let Some(frame) = socket.next().await {
                        let Ok(frame) = frame else {
                            break;
                        };
                        let text = match frame {
                            Message::Text(text) => text.to_string(),
                            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                            Message::Ping(bytes) => {
                                let _ = socket.send(Message::Pong(bytes)).await;
                                continue;
                            }
                            Message::Close(_) => break,
                            _ => continue,
                        };
                        let Ok(event) = serde_json::from_str::<DaemonEvent>(&text) else {
                            continue;
                        };
                        if event.v != 1 {
                            continue;
                        }
                        if event.event_type == "events.replay.complete" {
                            let through = event
                                .payload
                                .get("throughSequence")
                                .and_then(Value::as_u64)
                                .unwrap_or(last);
                            last = last.max(through);
                            cursor.fetch_max(last, Ordering::Release);
                            if !stream_connected {
                                let _ = app.emit("daemon-connection", true);
                                stream_connected = true;
                            }
                            continue;
                        }
                        if event.event_type == "replay.gap" {
                            let _ = app.emit("daemon-event", event);
                            if stream_connected {
                                let _ = app.emit("daemon-connection", false);
                                stream_connected = false;
                            }
                            break;
                        }
                        if event.sequence <= last {
                            continue;
                        }
                        last = event.sequence;
                        cursor.store(last, Ordering::Release);
                        let _ = app.emit("daemon-event", event);
                    }
                    if stream_connected {
                        let _ = app.emit("daemon-connection", false);
                        stream_connected = false;
                    }
                }
                Err(_) => {
                    if stream_connected {
                        let _ = app.emit("daemon-connection", false);
                        stream_connected = false;
                    }
                }
            }
            thread::sleep(Duration::from_millis(900));
        }
    });
}

#[tauri::command]
fn select_project_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_title("Choose a project folder")
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn select_local_file(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_title("Choose a local file to reference")
        .blocking_pick_file()
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

fn remember_selected_path(
    state: &AppState,
    path: PathBuf,
    purpose: SelectedFilePurpose,
) -> Result<String, String> {
    if path.as_os_str().is_empty() {
        return Err("The selected file path is unavailable.".to_string());
    }
    let token = Uuid::new_v4().to_string();
    state
        .selected_file_paths
        .lock()
        .map_err(|_| "File selection state is unavailable.".to_string())?
        .insert(token.clone(), SelectedFilePath { path, purpose });
    Ok(token)
}

fn take_selected_path(
    state: &AppState,
    token: &str,
    purpose: SelectedFilePurpose,
) -> Result<PathBuf, String> {
    if token.trim().is_empty() {
        return Err("Choose a file through the file dialog first.".to_string());
    }
    let selection = state
        .selected_file_paths
        .lock()
        .map_err(|_| "File selection state is unavailable.".to_string())?
        .remove(token)
        .ok_or_else(|| "That file selection is unavailable. Choose it again.".to_string())?;
    if selection.purpose != purpose {
        return Err("That file selection cannot be used for this operation.".to_string());
    }
    Ok(selection.path)
}

fn write_markdown_export(state: &AppState, selection_token: &str, text: &str) -> Result<(), String> {
    let path = take_selected_path(state, selection_token, SelectedFilePurpose::Export)?;
    fs::write(path, text.as_bytes())
        .map_err(|_| "The Markdown file could not be saved.".to_string())
}

#[tauri::command]
fn select_markdown_export_path(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(selected) = app
        .dialog()
        .file()
        .set_file_name("conversation.md")
        .add_filter("Markdown", &["md"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "The selected file path is unavailable.".to_string())?;
    Ok(Some(remember_selected_path(&state, path, SelectedFilePurpose::Export)?))
}

#[tauri::command]
fn write_selected_export_text(
    state: State<'_, AppState>,
    selection_token: String,
    text: String,
) -> Result<(), String> {
    write_markdown_export(&state, &selection_token, &text)
}

#[tauri::command]
fn select_blob_export_path(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let stem = name.trim().chars().filter(|character| character.is_ascii_alphanumeric() || *character == '-' || *character == '_').take(48).collect::<String>();
    let suggested_name = if stem.is_empty() { "blob.json".to_string() } else { format!("{stem}.json") };
    let Some(selected) = app
        .dialog()
        .file()
        .set_file_name(suggested_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|_| "The selected file path is unavailable.".to_string())?;
    Ok(Some(remember_selected_path(&state, path, SelectedFilePurpose::Export)?))
}

#[tauri::command]
fn select_blob_import_path(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(selected) = app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|_| "The selected blob file path is unavailable.".to_string())?;
    Ok(Some(remember_selected_path(&state, path, SelectedFilePurpose::Import)?))
}

#[tauri::command]
fn read_blob_import(state: State<'_, AppState>, selection_token: String) -> Result<String, String> {
    let path = take_selected_path(&state, &selection_token, SelectedFilePurpose::Import)?;
    let metadata = fs::metadata(&path)
        .map_err(|_| "The selected blob file could not be read.".to_string())?;
    if metadata.len() > 64 * 1024 {
        return Err("This blob file is too large.".to_string());
    }
    let bytes = fs::read(&path)
        .map_err(|_| "The selected blob file could not be read.".to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err("This blob file is too large.".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "This blob file is not UTF-8 text.".to_string())
}

const MAX_STAGED_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const STAGED_ATTACHMENT_RETENTION: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);

/// Writes a pasted or picked image to Bloblex's local attachment folder so the
/// daemon can hand the provider a file path. The body is the raw image bytes;
/// the extension comes from the file signature, not from the caller.
#[tauri::command]
fn stage_prompt_attachment(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The image could not be read.".to_string());
    };
    if bytes.is_empty() || bytes.len() > MAX_STAGED_ATTACHMENT_BYTES {
        return Err("Images must be 10 MB or smaller.".to_string());
    }
    let extension = attachment_extension(bytes)
        .ok_or_else(|| "Only PNG, JPEG, GIF and WebP images can be attached.".to_string())?;
    let mut dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "The attachment folder is unavailable.".to_string())?;
    dir.push("attachments");
    fs::create_dir_all(&dir).map_err(|_| "The attachment folder could not be created.".to_string())?;
    prune_staged_attachments(&dir);
    let path = dir.join(format!("{}.{extension}", Uuid::new_v4()));
    fs::write(&path, bytes).map_err(|_| "The image could not be saved for sending.".to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn attachment_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) { return Some("png"); }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) { return Some("jpg"); }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { return Some("gif"); }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { return Some("webp"); }
    None
}

/// Staged images are only needed until the provider has read them; old ones
/// are removed opportunistically when a new image is staged.
fn prune_staged_attachments(dir: &std::path::Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let old = entry.metadata().ok().filter(|metadata| metadata.is_file())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > STAGED_ATTACHMENT_RETENTION);
        if old { let _ = fs::remove_file(entry.path()); }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileInspection {
    path: String,
    file_name: String,
    size_bytes: u64,
}

#[tauri::command]
fn inspect_local_file(path: String) -> Result<LocalFileInspection, String> {
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|_| "The selected file could not be found.".to_string())?;
    if !canonical.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    // Open only to verify access; file contents are never read here.
    let _access = fs::File::open(&canonical).map_err(|_| {
        "Bloblex cannot read this file path with the current Windows account.".to_string()
    })?;
    let metadata =
        fs::metadata(&canonical).map_err(|_| "File metadata is unavailable.".to_string())?;
    let file_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The selected file name is not valid Unicode.".to_string())?;
    Ok(LocalFileInspection {
        path: canonical.to_string_lossy().into_owned(),
        file_name: file_name.to_string(),
        size_bytes: metadata.len(),
    })
}

fn canonical_project_file(path: String, project_root: Option<String>) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(&path);
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        let root = project_root.as_deref().ok_or_else(|| {
            "A project folder is required to resolve this relative file path.".to_string()
        })?;
        PathBuf::from(root).join(candidate)
    };
    let canonical = absolute
        .canonicalize()
        .map_err(|_| "The file path no longer exists.".to_string())?;
    if let Some(root) = project_root.as_deref() {
        let canonical_root = PathBuf::from(root)
            .canonicalize()
            .map_err(|_| "The project folder no longer exists.".to_string())?;
        if !canonical.starts_with(&canonical_root) {
            return Err("The file is outside this session's project folder.".to_string());
        }
    }
    if !canonical.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    Ok(canonical)
}

#[tauri::command]
async fn open_in_editor(
    state: State<'_, AppState>,
    path: String,
    project_root: Option<String>,
) -> Result<(), String> {
    let path = canonical_project_file(path, project_root.clone())?
        .to_string_lossy()
        .into_owned();
    let conn = connection(&state)?;
    let settings = rpc_call(&conn, "settings.get", json!({})).await?;
    let settings = settings.get("settings").unwrap_or(&settings);
    let configured = settings
        .get("editorExecutable")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let executable = if let Some(configured) = configured {
        let editor = Path::new(configured);
        let executable_extension = editor
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com")
            });
        if !editor.is_absolute() || !editor.is_file() || !executable_extension {
            return Err(
                "The configured editor must be an existing absolute .exe or .com file.".to_string(),
            );
        }
        configured.to_string()
    } else {
        "notepad.exe".to_string()
    };
    let arguments = settings
        .get("editorArgs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut command = Command::new(executable);
    let mut used_file = false;
    for argument in arguments {
        let Some(argument) = argument.as_str() else {
            continue;
        };
        let expanded = argument
            .replace("{file}", &path)
            .replace("{project}", project_root.as_deref().unwrap_or(""));
        if expanded.contains(&path) {
            used_file = true;
        }
        command.arg(expanded);
    }
    if !used_file {
        command.arg(&path);
    }
    command
        .spawn()
        .map_err(|error| format!("Could not start the configured editor: {error}"))?;
    Ok(())
}

#[tauri::command]
fn resolve_project_file(path: String, project_root: Option<String>) -> Result<String, String> {
    Ok(canonical_project_file(path, project_root)?
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
fn reveal_in_explorer(path: String, project_root: Option<String>) -> Result<(), String> {
    let path = canonical_project_file(path, project_root)?;
    let folder = path
        .parent()
        .ok_or_else(|| "This file has no containing folder.".to_string())?;
    Command::new("explorer.exe")
        .arg(folder)
        .spawn()
        .map_err(|error| format!("Could not open File Explorer: {error}"))?;
    Ok(())
}

#[tauri::command]
fn show_main_window(app: AppHandle, session_id: Option<String>) -> Result<(), String> {
    if let Some(id) = session_id {
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(mut active) = state.active_session.lock() {
                *active = Some(id.clone());
            }
            let _ = app.emit("active-session", id);
        }
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main window is unavailable.".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn show_main_settings(app: AppHandle, session_id: Option<String>) -> Result<(), String> {
    show_main_window(app.clone(), session_id)?;
    app.emit("bloblex-open-settings", ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_active_session(app: AppHandle, session_id: Option<String>, state: State<'_, AppState>) {
    if let Ok(mut active) = state.active_session.lock() {
        *active = session_id.clone();
    }
    let _ = app.emit("active-session", session_id);
}

#[tauri::command]
fn get_active_session(state: State<'_, AppState>) -> Option<String> {
    state
        .active_session
        .lock()
        .ok()
        .and_then(|active| active.clone())
}

#[tauri::command]
fn set_active_runtime(app: AppHandle, runtime_id: Option<String>, state: State<'_, AppState>) {
    if let Ok(mut active) = state.active_runtime.lock() {
        *active = runtime_id.clone();
    }
    let _ = app.emit("active-runtime", runtime_id);
}

#[tauri::command]
fn get_active_runtime(state: State<'_, AppState>) -> Option<String> {
    state
        .active_runtime
        .lock()
        .ok()
        .and_then(|active| active.clone())
}

#[tauri::command]
fn toggle_companion(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("companion")
        .ok_or_else(|| "The companion window is unavailable.".to_string())?;
    if window.is_visible().unwrap_or(false) {
        window.hide().map_err(|error| error.to_string())?;
        let _ = app.emit("bloblex-companion-visible-changed", false);
        Ok(false)
    } else {
        window.show().map_err(|error| error.to_string())?;
        let _ = app.emit("bloblex-companion-visible-changed", true);
        Ok(true)
    }
}

#[tauri::command]
fn companion_visible(app: AppHandle) -> bool {
    app.get_webview_window("companion").and_then(|window| window.is_visible().ok()).unwrap_or(false)
}

#[tauri::command]
fn set_companion_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
    animate: bool,
) -> Result<(), String> {
    let window = app
        .get_webview_window("companion")
        .ok_or_else(|| "The companion window is unavailable.".to_string())?;
    let (desired_width, desired_height) = match mode.as_str() {
        "home" => (640.0, 160.0),
        "home-chat" => (640.0, 264.0),
        "petit" | "hidden" => (344.0, 62.0),
        _ => return Err("Unknown companion presentation state.".to_string()),
    };
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let initial = window.inner_size().map_err(|error| error.to_string())?;
    let start_width = initial.width as f64 / scale;
    let start_height = initial.height as f64 / scale;
    let start_position = window.outer_position().map_err(|error| error.to_string())?;
    let work_areas = companion_work_areas(&window);
    let initial_center = (
        start_position.x + initial.width as i32 / 2,
        start_position.y + initial.height as i32 / 2,
    );
    let generation = state
        .companion_resize_generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let generation_counter = Arc::clone(&state.companion_resize_generation);
    let resize_flag = Arc::clone(&state.companion_resize_in_progress);
    resize_flag.store(true, Ordering::SeqCst);
    if !animate {
        window
            .set_size(LogicalSize::new(desired_width, desired_height))
            .map_err(|error| error.to_string())?;
        let new_width = (desired_width * scale).round() as i32;
        let new_height = (desired_height * scale).round() as i32;
        let target=PhysicalPosition::new(
            start_position.x - (new_width - initial.width as i32) / 2,
            start_position.y - (new_height - initial.height as i32),
        );
        let target=clamp_companion_position(target,new_width,new_height,&work_areas,initial_center);
        window
            .set_position(target)
            .map_err(|error| error.to_string())?;
        let resize_flag = Arc::clone(&resize_flag);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(120));
            if generation_counter.load(Ordering::SeqCst) == generation {
                resize_flag.store(false, Ordering::SeqCst);
            }
        });
        return Ok(());
    }
    let expand = mode == "home" || mode == "home-chat";
    let grow_duration = 1.2;
    thread::spawn(move || {
        let began = std::time::Instant::now();
        let mut last_width = initial.width as i32;
        let mut last_height = initial.height as i32;
        loop {
            if generation_counter.load(Ordering::SeqCst) != generation {
                return;
            }
            let elapsed = began.elapsed().as_secs_f64();
            let progress = if expand {
                spring_progress(elapsed)
            } else {
                cubic_bezier(0.45, 0.0, 0.2, 1.0, elapsed / 0.34)
            };
            let width = (start_width + (desired_width - start_width) * progress).round() as i32;
            let height = (start_height + (desired_height - start_height) * progress).round() as i32;
            let duration = if expand { grow_duration } else { 0.34 };
            let width = if elapsed >= duration {
                (desired_width * scale).round() as i32
            } else {
                (width as f64 * scale).round() as i32
            };
            let height = if elapsed >= duration {
                (desired_height * scale).round() as i32
            } else {
                (height as f64 * scale).round() as i32
            };
            if let Err(error) =
                window.set_size(tauri::PhysicalSize::new(width as u32, height as u32))
            {
                eprintln!("Bloblex companion resize: {error}");
                break;
            }
            let next_position = PhysicalPosition::new(
                start_position.x - (width - initial.width as i32) / 2,
                start_position.y - (height - initial.height as i32),
            );
            let next_position=clamp_companion_position(next_position,width,height,&work_areas,initial_center);
            if let Err(error) = window.set_position(next_position) {
                eprintln!("Bloblex companion anchor: {error}");
                break;
            }
            last_width = width;
            last_height = height;
            if elapsed >= duration {
                break;
            }
            thread::sleep(Duration::from_millis(16));
        }
        let _ = (last_width, last_height);
        if generation_counter.load(Ordering::SeqCst) == generation {
            resize_flag.store(false, Ordering::SeqCst);
        }
    });
    Ok(())
}

fn clamp_physical_position(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    area_x: i32,
    area_y: i32,
    area_width: i32,
    area_height: i32,
) -> (i32, i32) {
    let (x, y, area_x, area_y) = (x as i64, y as i64, area_x as i64, area_y as i64);
    let (width, height, area_width, area_height) = (
        width.max(0) as i64,
        height.max(0) as i64,
        area_width.max(0) as i64,
        area_height.max(0) as i64,
    );
    let clamp_axis = |position: i64, size: i64, origin: i64, area_size: i64| {
        if size > area_size {
            origin
        } else {
            position.clamp(origin, origin + area_size - size)
        }
    };
    (
        clamp_axis(x, width, area_x, area_width) as i32,
        clamp_axis(y, height, area_y, area_height) as i32,
    )
}

fn companion_work_areas(window: &WebviewWindow) -> Vec<(i32, i32, i32, i32)> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            (
                area.position.x,
                area.position.y,
                area.size.width as i32,
                area.size.height as i32,
            )
        })
        .collect()
}

fn clamp_companion_position(
    position: PhysicalPosition<i32>,
    width: i32,
    height: i32,
    areas: &[(i32, i32, i32, i32)],
    fallback_center: (i32, i32),
) -> PhysicalPosition<i32> {
    let center = (position.x + width / 2, position.y + height / 2);
    let area = areas
        .iter()
        .find(|(x, y, w, h)| {
            center.0 >= *x && center.0 < *x + *w && center.1 >= *y && center.1 < *y + *h
        })
        .or_else(|| {
            areas.iter().find(|(x, y, w, h)| {
                fallback_center.0 >= *x
                    && fallback_center.0 < *x + *w
                    && fallback_center.1 >= *y
                    && fallback_center.1 < *y + *h
            })
        })
        .or_else(|| areas.first());
    if let Some((x, y, w, h)) = area {
        let (x, y) = clamp_physical_position(position.x, position.y, width, height, *x, *y, *w, *h);
        PhysicalPosition::new(x, y)
    } else {
        position
    }
}

#[cfg(test)]
mod companion_launch_tests {
    use super::{companion_last_launch_spot, companion_launch_spot, companion_saved_compact_spot, Point};

    #[test]
    fn launch_spot_is_centred_and_above_the_bottom_edge() {
        // 1920x1040 work area, 640x160 welcome island.
        let (x, y) = companion_launch_spot(0, 0, 1920, 1040, 640, 160);
        assert_eq!(x, 640);
        assert_eq!(y, 1040 - 160 - 187);
    }

    #[test]
    fn launch_spot_follows_a_secondary_display_and_stays_inside_it() {
        let (x, y) = companion_launch_spot(1920, 0, 1280, 680, 800, 200);
        assert_eq!(x, 1920 + 240);
        assert_eq!(y, 680 - 200 - 122);
        let (x, y) = companion_launch_spot(0, 0, 600, 300, 640, 160);
        assert_eq!((x, y), (0, 86));
    }

    #[test]
    fn last_position_keeps_the_welcome_island_bottom_center_on_the_saved_compact_spot() {
        let (x, y) = companion_last_launch_spot(900, 500, 344, 62, 640, 160, 0, 0, 1920, 1040);
        assert_eq!(x + 320, 900 + 172);
        assert_eq!(y + 160, 500 + 62);
    }

    #[test]
    fn last_position_is_clamped_inside_the_saved_displays_work_area() {
        let result = companion_last_launch_spot(3500, 900, 344, 62, 640, 160, 1920, 0, 1280, 680);
        assert_eq!(result, (2560, 520));
    }

    #[test]
    fn persisted_bottom_edge_is_converted_to_the_compact_rect_before_welcome_placement() {
        let point = Point { x: 900, y: 562, anchor_x: None, bottom_gap: None, monitor_name: None };
        let (saved_x, saved_y) = companion_saved_compact_spot(&point, 344, 62, 1.0, 0, 0, 1920, 1040);
        assert_eq!((saved_x, saved_y), (900, 500));
        let welcome = companion_last_launch_spot(saved_x, saved_y, 344, 62, 640, 160, 0, 0, 1920, 1040);
        assert_eq!(welcome, (752, 402));
    }
}

#[cfg(test)]
mod companion_clamp_tests {
    use super::clamp_physical_position;

    #[test]
    fn inside_is_unchanged() {
        assert_eq!(
            clamp_physical_position(120, 130, 200, 100, 0, 0, 500, 400),
            (120, 130)
        );
    }

    #[test]
    fn clamps_past_right_edge() {
        assert_eq!(
            clamp_physical_position(450, 80, 100, 100, 0, 0, 500, 400),
            (400, 80)
        );
    }

    #[test]
    fn clamps_past_left_edge() {
        assert_eq!(
            clamp_physical_position(-50, 80, 100, 100, 0, 0, 500, 400),
            (0, 80)
        );
    }

    #[test]
    fn clamps_past_top_edge() {
        assert_eq!(
            clamp_physical_position(80, -50, 100, 100, 0, 0, 500, 400),
            (80, 0)
        );
    }

    #[test]
    fn clamps_past_bottom_edge() {
        assert_eq!(
            clamp_physical_position(80, 350, 100, 100, 0, 0, 500, 400),
            (80, 300)
        );
    }

    #[test]
    fn oversized_window_pins_to_work_area_origin() {
        assert_eq!(
            clamp_physical_position(80, 80, 600, 450, 10, 20, 500, 400),
            (10, 20)
        );
    }

    #[test]
    fn clamps_on_negative_origin_monitor() {
        assert_eq!(
            clamp_physical_position(-20, 60, 100, 100, -1080, 0, 1080, 800),
            (-100, 60)
        );
    }
}

fn spring_progress(seconds: f64) -> f64 {
    let damping: f64 = 0.72;
    let omega = std::f64::consts::TAU / 0.5;
    let damped = omega * (1.0 - damping * damping).sqrt();
    1.0 - (-damping * omega * seconds).exp()
        * ((damped * seconds).cos()
            + damping / (1.0 - damping * damping).sqrt() * (damped * seconds).sin())
}

fn cubic_bezier(x1: f64, y1: f64, x2: f64, y2: f64, input: f64) -> f64 {
    let input = input.clamp(0.0, 1.0);
    let curve = |a: f64, b: f64, t: f64| {
        3.0 * (1.0 - t).powi(2) * t * a + 3.0 * (1.0 - t) * t.powi(2) * b + t.powi(3)
    };
    let (mut low, mut high) = (0.0, 1.0);
    for _ in 0..16 {
        let middle = (low + high) / 2.0;
        if curve(x1, x2, middle) < input {
            low = middle;
        } else {
            high = middle;
        }
    }
    curve(y1, y2, (low + high) / 2.0)
}

#[tauri::command]
async fn set_companion_visible(
    app: AppHandle,
    visible: bool,
) -> Result<(), String> {
    let window = app
        .get_webview_window("companion")
        .ok_or_else(|| "The companion window is unavailable.".to_string())?;
    if visible {
        window.show().map_err(|error| error.to_string())?;
    } else {
        window.hide().map_err(|error| error.to_string())?;
    }
    let _ = app.emit("bloblex-companion-visible-changed", visible);
    Ok(())
}

#[tauri::command]
fn set_companion_hotkey(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyB);
    if enabled {
        app.global_shortcut().register(shortcut).map_err(|_| "Ctrl+Alt+B is already in use.".to_string())
    } else if app.global_shortcut().is_registered(shortcut) {
        app.global_shortcut().unregister(shortcut).map_err(|_| "The companion shortcut could not be removed.".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn companion_hotkey_registered(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyB);
    Ok(app.global_shortcut().is_registered(shortcut))
}

#[tauri::command]
async fn set_close_to_tray(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let conn = connection(&state)?;
    rpc_call(
        &conn,
        "settings.set",
        json!({"key":"closeToTray","value":enabled}),
    )
    .await
    .map_err(|error| error.to_string())?;
    state.close_to_tray.store(enabled, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn companion_monitor_options(app: AppHandle) -> Result<Vec<String>, String> {
    let companion = app
        .get_webview_window("companion")
        .ok_or_else(|| "The companion window is unavailable.".to_string())?;
    let mut names = companion
        .available_monitors()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter_map(|monitor| monitor.name().cloned())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    Ok(names)
}

#[tauri::command]
fn current_companion_monitor(app: AppHandle) -> Result<Option<String>, String> {
    let companion = app
        .get_webview_window("companion")
        .ok_or_else(|| "The companion window is unavailable.".to_string())?;
    Ok(companion
        .current_monitor()
        .map_err(|error| error.to_string())?
        .and_then(|monitor| monitor.name().cloned()))
}

#[tauri::command]
fn set_companion_monitor(app: AppHandle, monitor_name: String) -> Result<(), String> {
    let companion = app
        .get_webview_window("companion")
        .ok_or_else(|| "The companion window is unavailable.".to_string())?;
    let monitor = companion
        .available_monitors()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|monitor| monitor.name().map(String::as_str) == Some(monitor_name.as_str()))
        .ok_or_else(|| {
            "That display is no longer available. Choose a connected display.".to_string()
        })?;
    let area = monitor.work_area();
    let size = companion.outer_size().map_err(|error| error.to_string())?;
    let scale = monitor.scale_factor();
    let gap = (18.0 * scale).round() as i32;
    let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
    let y = area.position.y + area.size.height as i32 - size.height as i32 - gap;
    companion
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    persist_companion_position(&app, &companion);
    Ok(())
}

#[tauri::command]
fn quit_bloblex(app: AppHandle, state: State<'_, AppState>) {
    let conn = connection(&state).ok();
    let app = app.clone();
    let daemon = Arc::clone(&state.daemon);
    thread::spawn(move || {
        if let Some(conn) = conn {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(4))
                .build();
            if let Ok(client) = client {
                let _ = client.post(format!("http://{}/v1/rpc", conn.address))
                    .header(AUTHORIZATION, format!("Bearer {}", conn.capability))
                    .json(&json!({"v":1,"id":format!("quit_{}",Uuid::new_v4()),"method":"daemon.shutdown","params":{}}))
                    .send();
            }
        }
        stop_daemon(daemon);
        app.exit(0);
    });
}

fn stop_daemon(daemon_process: Arc<Mutex<Option<DaemonProcess>>>) {
    if let Ok(mut slot) = daemon_process.lock() {
        if let Some(mut daemon) = slot.take() {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                if daemon.child.try_wait().ok().flatten().is_some() {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    let _ = daemon.child.kill();
                    let _ = daemon.child.wait();
                    break;
                }
                thread::sleep(Duration::from_millis(60));
            }
            let _ = fs::remove_file(daemon.executable_copy);
        }
    }
}

impl AppState {
    fn stop_child(&self) {
        stop_daemon(Arc::clone(&self.daemon));
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        self.stop_child();
    }
}

fn companion_position(app: &AppHandle, window: &WebviewWindow) -> PhysicalPosition<i32> {
    let monitors = window.available_monitors().unwrap_or_default();
    let primary = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.first().cloned());
    let Some(primary_monitor) = primary else {
        return PhysicalPosition::new(300, 600);
    };
    let scale = primary_monitor.scale_factor();
    let size = window
        .inner_size()
        .unwrap_or(tauri::PhysicalSize::new(344, 62));
    let width = size.width as i32;
    let height = size.height as i32;
    let inset = (12.0 * scale).round() as i32;
    let mut saved = None;
    if let Some(file) = app_data_file(app, "companion-position.json") {
        if let Ok(content) = fs::read_to_string(file) {
            saved = serde_json::from_str::<Point>(&content).ok();
        }
    }
    let monitor = saved
        .as_ref()
        .and_then(|point| {
            if let Some(name) = &point.monitor_name {
                if let Some(found) = monitors
                    .iter()
                    .find(|monitor| monitor.name().map(String::as_str) == Some(name.as_str()))
                {
                    return Some(found.clone());
                }
            }
            if point.anchor_x.is_some() {
                return None;
            }
            let center_x = point.x + width / 2;
            let center_y = point.y + height / 2;
            monitors
                .iter()
                .find(|monitor| {
                    let area = monitor.work_area();
                    center_x >= area.position.x
                        && center_x < area.position.x + area.size.width as i32
                        && center_y >= area.position.y
                        && center_y < area.position.y + area.size.height as i32
                })
                .cloned()
        })
        .unwrap_or(primary_monitor);
    let area = monitor.work_area();
    let position = saved
        .as_ref()
        .map(|point| {
            if let (Some(anchor_x), Some(bottom_gap)) = (point.anchor_x, point.bottom_gap) {
                let center_x = area.position.x
                    + (area.size.width as f64 * anchor_x.clamp(0.0, 1.0)).round() as i32;
                let bottom = area.position.y + area.size.height as i32
                    - (bottom_gap * monitor.scale_factor()).round() as i32;
                Point {
                    x: center_x - width / 2,
                    y: bottom - height,
                    anchor_x: None,
                    bottom_gap: None,
                    monitor_name: None,
                }
            } else {
                Point {
                    x: point.x,
                    y: point.y,
                    anchor_x: None,
                    bottom_gap: None,
                    monitor_name: None,
                }
            }
        })
        .unwrap_or_else(|| Point {
            x: area.position.x + ((area.size.width as i32 - width) / 2),
            y: area.position.y + area.size.height as i32 - height - inset,
            anchor_x: None,
            bottom_gap: None,
            monitor_name: None,
        });
    let min_x = area.position.x + inset;
    let min_y = area.position.y + inset;
    let max_x = area.position.x + area.size.width as i32 - width - inset;
    let max_y = area.position.y + area.size.height as i32 - height - inset;
    PhysicalPosition::new(
        position.x.clamp(min_x, max_x.max(min_x)),
        position.y.clamp(min_y, max_y.max(min_y)),
    )
}

/// The companion sits this fraction of the work-area height above the bottom edge.
const COMPANION_LAUNCH_BOTTOM_GAP: f64 = 0.18;

/// Every launch starts at the same calm spot: horizontally centred and a little
/// above the bottom of the display the companion last used (or the primary
/// display). Dragging afterwards still moves it anywhere.
fn companion_launch_position(app: &AppHandle, window: &WebviewWindow) -> PhysicalPosition<i32> {
    let saved = companion_position(app, window);
    let saved_size = window.inner_size().unwrap_or(tauri::PhysicalSize::new(344, 62));
    let saved_center = (saved.x + saved_size.width as i32 / 2, saved.y + saved_size.height as i32 / 2);
    let monitors = window.available_monitors().unwrap_or_default();
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let area = monitor.work_area();
            saved_center.0 >= area.position.x
                && saved_center.0 < area.position.x + area.size.width as i32
                && saved_center.1 >= area.position.y
                && saved_center.1 < area.position.y + area.size.height as i32
        })
        .cloned()
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned());
    let Some(monitor) = monitor else {
        return saved;
    };
    let scale = monitor.scale_factor();
    let width = (344.0 * scale).round() as i32;
    let height = (62.0 * scale).round() as i32;
    let area = monitor.work_area();
    let (x, y) = companion_launch_spot(
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
        width,
        height,
    );
    PhysicalPosition::new(x, y)
}

fn companion_last_launch_spot(
    saved_x: i32,
    saved_y: i32,
    saved_width: i32,
    saved_height: i32,
    welcome_width: i32,
    welcome_height: i32,
    area_x: i32,
    area_y: i32,
    area_width: i32,
    area_height: i32,
) -> (i32, i32) {
    let x = saved_x + saved_width / 2 - welcome_width / 2;
    let y = saved_y + saved_height - welcome_height;
    clamp_physical_position(x, y, welcome_width, welcome_height, area_x, area_y, area_width, area_height)
}

fn companion_saved_compact_spot(
    point: &Point,
    compact_width: i32,
    compact_height: i32,
    scale: f64,
    area_x: i32,
    area_y: i32,
    area_width: i32,
    area_height: i32,
) -> (i32, i32) {
    let (x, y) = match (point.anchor_x, point.bottom_gap) {
        (Some(anchor_x), Some(bottom_gap)) => {
            let center_x = area_x + (area_width as f64 * anchor_x.clamp(0.0, 1.0)).round() as i32;
            let bottom = area_y + area_height - (bottom_gap * scale).round() as i32;
            (center_x - compact_width / 2, bottom - compact_height)
        }
        _ => (point.x, point.y - compact_height),
    };
    clamp_physical_position(x, y, compact_width, compact_height, area_x, area_y, area_width, area_height)
}

fn companion_launch_spot(
    area_x: i32,
    area_y: i32,
    area_width: i32,
    area_height: i32,
    width: i32,
    height: i32,
) -> (i32, i32) {
    let gap = (area_height as f64 * COMPANION_LAUNCH_BOTTOM_GAP).round() as i32;
    let x = area_x + (area_width - width) / 2;
    let y = area_y + area_height - height - gap;
    clamp_physical_position(x, y, width, height, area_x, area_y, area_width, area_height)
}

fn persist_companion_position(app: &AppHandle, window: &WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let monitors = window.available_monitors().unwrap_or_default();
    let primary = window.primary_monitor().ok().flatten();
    let size = window
        .inner_size()
        .unwrap_or(tauri::PhysicalSize::new(344, 62));
    let center = PhysicalPosition::new(
        position.x + size.width as i32 / 2,
        position.y + size.height as i32 / 2,
    );
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let area = monitor.work_area();
            center.x >= area.position.x
                && center.x < area.position.x + area.size.width as i32
                && center.y >= area.position.y
                && center.y < area.position.y + area.size.height as i32
        })
        .or(primary.as_ref());
    if let Some(path) = app_data_file(app, "companion-position.json") {
        let temp = path.with_extension("json.tmp");
        let anchor = if let Some(monitor) = monitor {
            let area = monitor.work_area();
            let bottom_gap = (area.position.y + area.size.height as i32
                - position.y
                - size.height as i32) as f64
                / monitor.scale_factor();
            Point {
                x: position.x,
                y: position.y + size.height as i32,
                anchor_x: Some((center.x - area.position.x) as f64 / area.size.width as f64),
                bottom_gap: Some(bottom_gap),
                monitor_name: monitor.name().cloned(),
            }
        } else {
            Point {
                x: position.x,
                y: position.y + size.height as i32,
                anchor_x: None,
                bottom_gap: None,
                monitor_name: None,
            }
        };
        if fs::write(&temp, serde_json::to_vec(&anchor).unwrap_or_default()).is_ok() {
            let _ = fs::rename(temp, path);
        }
    }
}

fn make_companion(app: &AppHandle, start_at_last_position: bool) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(
        app,
        "companion",
        WebviewUrl::App("index.html?companion=1".into()),
    )
    .title("Bloblex Companion")
    .inner_size(344.0, 62.0)
    .position(400.0, 400.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .shadow(false)
    .build()?;
    let position = if start_at_last_position {
        let monitors = window.available_monitors().unwrap_or_default();
        let saved = app_data_file(app, "companion-position.json")
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|content| serde_json::from_str::<Point>(&content).ok());
        let default_monitor = window.primary_monitor().ok().flatten().or_else(|| monitors.first().cloned());
        let monitor = saved.as_ref().and_then(|point| {
            point.monitor_name.as_ref().and_then(|name| monitors.iter()
                .find(|monitor| monitor.name().map(String::as_str) == Some(name.as_str())).cloned())
                .or_else(|| {
                    let monitor = default_monitor.as_ref()?;
                    if point.anchor_x.is_some() { return default_monitor.clone(); }
                    let scale = monitor.scale_factor();
                    let compact_width = (344.0 * scale).round() as i32;
                    let compact_height = (62.0 * scale).round() as i32;
                    let center = (point.x + compact_width / 2, point.y - compact_height / 2);
                    monitors.iter().find(|monitor| {
                        let area = monitor.work_area();
                        center.0 >= area.position.x && center.0 < area.position.x + area.size.width as i32
                            && center.1 >= area.position.y && center.1 < area.position.y + area.size.height as i32
                    }).cloned().or_else(|| default_monitor.clone())
                })
        }).or(default_monitor);
        if let (Some(point), Some(monitor)) = (saved.as_ref(), monitor) {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let compact_width = (344.0 * scale).round() as i32;
            let compact_height = (62.0 * scale).round() as i32;
            let (saved_x, saved_y) = companion_saved_compact_spot(point, compact_width, compact_height, scale,
                area.position.x, area.position.y, area.size.width as i32, area.size.height as i32);
            let (x, y) = companion_last_launch_spot(saved_x, saved_y, compact_width, compact_height,
                compact_width, compact_height, area.position.x, area.position.y, area.size.width as i32, area.size.height as i32);
            PhysicalPosition::new(x, y)
        } else { companion_launch_position(app, &window) }
    } else { companion_launch_position(app, &window) };
    let _ = window.set_position(position);
    let app_handle = app.clone();
    let resize_flag = Arc::clone(&app.state::<AppState>().companion_resize_in_progress);
    let window_for_event = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Moved(_) = event {
            if !resize_flag.load(Ordering::SeqCst) {
                persist_companion_position(&app_handle, &window_for_event);
            }
        }
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_for_event.hide();
            let _ = app_handle.emit("bloblex-companion-visible-changed", false);
        }
    });
    Ok(window)
}

/// A frameless, always-on-top bubble shown only while dictation is active and
/// the companion is hidden. It mirrors the companion's transparency model.
fn make_dictation(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(
        app,
        "dictation",
        WebviewUrl::App("index.html?dictation=1".into()),
    )
    .title("Bloblex Dictation")
    .inner_size(240.0, 76.0)
    .position(500.0, 500.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .shadow(false)
    .build()?;
    let monitors = window.available_monitors().unwrap_or_default();
    if let Some(monitor) = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.first().cloned())
    {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let width = (240.0 * scale).round() as i32;
        let height = (76.0 * scale).round() as i32;
        // Sit above the companion island so the two never overlap.
        let gap = (132.0 * scale).round() as i32;
        let x = area.position.x + (area.size.width as i32 - width) / 2;
        let y = (area.position.y + area.size.height as i32 - height - gap).max(area.position.y);
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    let window_for_event = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_for_event.hide();
        }
    });
    Ok(window)
}

fn build_tray_menu(app: &AppHandle, sessions: &[Value]) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open", "Open Bloblex", true, None::<&str>)?;
    let companion = MenuItem::with_id(
        app,
        "companion",
        "Show / hide companion",
        true,
        None::<&str>,
    )?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh runtimes", true, None::<&str>)?;
    let refresh_sessions = MenuItem::with_id(
        app,
        "refresh-sessions",
        "Refresh active sessions",
        true,
        None::<&str>,
    )?;
    let mut session_items = Vec::new();
    for session in sessions.iter().filter(|item| tray_session_is_active(item)) {
        let id = session["id"].as_str().unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let provider = session["provider"].as_str().unwrap_or("Agent");
        let title = session["title"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Untitled session");
        let state = session["state"].as_str().unwrap_or("active");
        let label = format!("{} — {} ({})", provider, title, state);
        let label = label.chars().take(76).collect::<String>();
        session_items.push(MenuItem::with_id(
            app,
            format!("session:{id}"),
            label,
            true,
            None::<&str>,
        )?);
    }
    if session_items.is_empty() {
        session_items.push(MenuItem::with_id(
            app,
            "no-active-sessions",
            "No active sessions",
            false,
            None::<&str>,
        )?);
    }
    let mut session_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = session_items
        .iter()
        .map(|item| item as &dyn IsMenuItem<tauri::Wry>)
        .collect();
    session_refs.push(&refresh_sessions);
    let active_sessions = Submenu::with_id_and_items(
        app,
        "active-sessions",
        "Active sessions",
        true,
        &session_refs,
    )?;
    let pause_all = MenuItem::with_id(app, "pause-all", "Pause all agents…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Bloblex", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &open,
            &active_sessions,
            &pause_all,
            &companion,
            &refresh,
            &settings,
            &quit,
        ],
    )
}

fn tray_session_is_active(session: &Value) -> bool {
    matches!(
        session["state"].as_str().unwrap_or_default(),
        "starting" | "working" | "waiting_permission" | "waiting_user"
    )
}

fn load_tray_sessions(app: &AppHandle) -> Result<Vec<Value>, String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "Application state is unavailable".to_string())?;
    let conn = connection(&state)?;
    let response = tauri::async_runtime::block_on(rpc_call(&conn, "session.list", json!({})))?;
    Ok(response["sessions"].as_array().cloned().unwrap_or_default())
}

fn refresh_tray_sessions(app: AppHandle) {
    thread::spawn(move || {
        let sessions = match load_tray_sessions(&app) {
            Ok(sessions) => sessions,
            Err(error) => {
                let _ = app.emit("bloblex-tray-notice", error);
                return;
            }
        };
        let app_for_menu = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(tray) = app_for_menu.tray_by_id("bloblex-tray") else {
                return;
            };
            match build_tray_menu(&app_for_menu, &sessions) {
                Ok(menu) => {
                    if let Err(error) = tray.set_menu(Some(menu)) {
                        let _ = app_for_menu.emit(
                            "bloblex-tray-notice",
                            format!("Could not update active sessions: {error}"),
                        );
                    }
                }
                Err(error) => {
                    let _ = app_for_menu.emit(
                        "bloblex-tray-notice",
                        format!("Could not update active sessions: {error}"),
                    );
                }
            }
        });
    });
}

#[tauri::command]
fn refresh_tray_menu(app: AppHandle) {
    refresh_tray_sessions(app);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let sessions = load_tray_sessions(app).unwrap_or_default();
    let menu = build_tray_menu(app, &sessions)?;
    let decoded = image::load_from_memory(include_bytes!("../../../../assets/icon/tray.png"))
        .map_err(|error| std::io::Error::other(error.to_string()))?
        .to_rgba8();
    let (width, height) = decoded.dimensions();
    let icon = tauri::image::Image::new_owned(decoded.into_raw(), width, height);
    TrayIconBuilder::with_id("bloblex-tray")
        .tooltip("Bloblex")
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| {
            let event_id = event.id().as_ref().to_string();
            if let Some(session_id) = event_id.strip_prefix("session:") {
                let _ = show_main_window(app.clone(), Some(session_id.to_string()));
                return;
            }
            match event_id.as_str() {
                "open" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "companion" => {
                    let _ = toggle_companion(app.clone());
                }
                "refresh" => {
                    let app = app.clone();
                    thread::spawn(move || {
                        let _ = tauri::async_runtime::block_on(async {
                            if let Some(state) = app.try_state::<AppState>() {
                                if let Ok(conn) = connection(&state) {
                                    let _ = rpc_call(&conn, "runtime.refresh", json!({})).await;
                                }
                            }
                        });
                        refresh_tray_sessions(app);
                    });
                }
                "refresh-sessions" => refresh_tray_sessions(app.clone()),
                "pause-all" => {
                    let _ = show_main_window(app.clone(), None);
                    let _ = app.emit("bloblex-pause-all-requested", ());
                }
                "settings" => {
                    let _ = show_main_settings(app.clone(), None);
                }
                "quit" => {
                    if let Some(state) = app.try_state::<AppState>() {
                        quit_bloblex(app.clone(), state);
                    }
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, shortcut, event| {
            if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }
            use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
            let companion = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyB);
            let dictation = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyE);
            if shortcut == &companion {
                let _ = toggle_companion(app.clone());
            } else if shortcut == &dictation {
                let _ = app.emit("bloblex-dictation-toggle", ());
            }
        }).build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&["companion", "dictation"]).build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .manage(updates::UpdateService::default())
        .manage(speech::SpeechState::default())
        .setup(|app| {
            let mut start_at_last_position = false;
            let mut hotkey_enabled = true;
            if let Some(state) = app.try_state::<AppState>() {
                if let Err(error) = start_daemon(app.handle(), &state) {
                    eprintln!("Bloblex daemon startup: {error}");
                }
                if let Ok(conn) = connection(&state) {
                    if let Ok(settings) =
                        tauri::async_runtime::block_on(rpc_call(&conn, "settings.get", json!({})))
                    {
                        let preferences = settings.get("settings").unwrap_or(&settings);
                        start_at_last_position = preferences.get("companion.startPosition")
                            .and_then(Value::as_str) == Some("last");
                        hotkey_enabled = preferences.get("companion.hotkey")
                            .and_then(Value::as_bool).unwrap_or(true);
                        state.close_to_tray.store(
                            preferences
                                .get("closeToTray")
                                .and_then(Value::as_bool)
                                .unwrap_or(true),
                            Ordering::SeqCst,
                        );
                    }
                }
            }
            if hotkey_enabled {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyB);
                if let Err(error) = app.global_shortcut().register(shortcut) {
                    eprintln!("Bloblex companion shortcut unavailable: {error}");
                }
            }
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let dictation = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyE);
                if let Err(error) = app.global_shortcut().register(dictation) {
                    eprintln!("Bloblex dictation shortcut unavailable: {error}");
                }
            }
            let companion = make_companion(app.handle(), start_at_last_position)?;
            let _ = companion.hide();
            let _ = app.emit("bloblex-companion-visible-changed", false);
            let dictation = make_dictation(app.handle())?;
            let _ = dictation.hide();
            updates::start_background_checker(app.handle());
            build_tray(app.handle())?;
            if let Some(main) = app.get_webview_window("main") {
                let main_for_event = main.clone();
                let app_for_event = app.handle().clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(state) = app_for_event.try_state::<AppState>() {
                            if state.close_to_tray.load(Ordering::SeqCst) {
                                let _ = main_for_event.hide();
                            } else {
                                quit_bloblex(app_for_event.clone(), state);
                            }
                        } else {
                            let _ = main_for_event.hide();
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_rpc,
            daemon_events_start,
            ensure_daemon,
            select_project_folder,
            select_local_file,
            select_markdown_export_path,
            write_selected_export_text,
            select_blob_export_path,
            select_blob_import_path,
            read_blob_import,
            inspect_local_file,
            stage_prompt_attachment,
            open_in_editor,
            resolve_project_file,
            reveal_in_explorer,
            show_main_window,
            show_main_settings,
            set_active_session,
            get_active_session,
            set_active_runtime,
            get_active_runtime,
            toggle_companion,
            companion_visible,
            set_companion_mode,
            set_companion_visible,
            set_companion_hotkey,
            companion_hotkey_registered,
            set_close_to_tray,
            companion_monitor_options,
            current_companion_monitor,
            set_companion_monitor,
            refresh_tray_menu,
            quit_bloblex,
            speech::speech_models,
            speech::speech_model_status,
            speech::speech_model_download,
            speech::dictation_start,
            speech::dictation_stop,
            speech::dictation_cancel,
            speech::dictation_state,
            updates::updates_get_state,
            updates::updates_set_preferences,
            updates::updates_check,
            updates::updates_install
        ])
        .build(tauri::generate_context!())
        .expect("Bloblex desktop application failed to start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                updates::stop_background_checker(app);
                if let Some(state) = app.try_state::<AppState>() {
                    state.stop_child();
                }
            }
        });
}

#[cfg(test)]
mod markdown_export_tests {
    use super::{remember_selected_path, take_selected_path, write_markdown_export, AppState, SelectedFilePurpose};
    use std::path::PathBuf;

    #[test]
    fn export_rejects_a_path_not_selected_by_the_native_dialog() {
        let state = AppState::default();
        assert!(take_selected_path(&state, "C:/arbitrary/file.md", SelectedFilePurpose::Export).is_err());
        assert!(take_selected_path(&state, "C:/arbitrary/file.json", SelectedFilePurpose::Import).is_err());
        assert!(write_markdown_export(&state, "C:/arbitrary/file.md", "content").is_err());
        assert!(write_markdown_export(&state, "  ", "content").is_err());
    }

    #[test]
    fn native_dialog_selection_is_opaque_and_single_use() {
        let state = AppState::default();
        let selected = PathBuf::from("C:/selected/conversation.md");
        let token = remember_selected_path(&state, selected.clone(), SelectedFilePurpose::Export).unwrap();
        assert_ne!(token, selected.to_string_lossy());
        assert_eq!(take_selected_path(&state, &token, SelectedFilePurpose::Export).unwrap(), selected);
        assert!(take_selected_path(&state, &token, SelectedFilePurpose::Export).is_err());
    }

    #[test]
    fn import_selection_cannot_be_used_as_an_export_path() {
        let state = AppState::default();
        let token = remember_selected_path(
            &state,
            PathBuf::from("C:/selected/import.json"),
            SelectedFilePurpose::Import,
        ).unwrap();
        assert!(write_markdown_export(&state, &token, "content").is_err());
    }
}
