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
    time::{Duration, Instant},
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
mod harness_updates;
mod clipboard;
mod speech;
mod power;
mod backdrop;
mod pty;
mod migrate;

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

/// Wave 12, part E: what the daemon supervisor is doing, as the window sees it.
/// `state` is `running`, `restarting` or `gave_up`; `nextRetryMs` is the wait
/// before the next attempt (null when none is pending) and `lastExitCode` is the
/// exit status of the run that ended (null when it never ran or was stopped).
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonSupervisor {
    state: String,
    attempt: u32,
    next_retry_ms: Option<u64>,
    last_exit_code: Option<i32>,
}

impl DaemonSupervisor {
    fn running() -> Self {
        Self { state: "running".into(), ..Self::default() }
    }
}

/// The supervisor's own bookkeeping: the payload above plus the crash window and
/// the flags that keep it from fighting a deliberate stop.
#[derive(Default)]
struct SupervisorState {
    payload: DaemonSupervisor,
    /// When each crash happened, newest last; only the last two minutes count.
    crashes: Vec<Instant>,
    /// Set by `stop_daemon` and by app exit: a stop is never a crash.
    stopping: bool,
    /// Whether a live child has been seen since the app started, so the window
    /// before `start_daemon` (or a start that failed) is not read as a crash.
    armed: bool,
    /// One watch thread at a time, even after `daemon_restart_now`.
    watching: bool,
}

/// The backoff between restarts: 1, 2, 4, 8, 16 and then 30 seconds.
const SUPERVISOR_BACKOFF_MS: [u64; 6] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
/// After this many crashes inside the window, the supervisor stops retrying.
const SUPERVISOR_CRASH_LIMIT: usize = 5;
const SUPERVISOR_WINDOW: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, PartialEq, Eq)]
enum SelectedFilePurpose {
    Export,
    Import,
    BackupExport,
    BackupImport,
    DiagnosticsExport,
}

struct SelectedFilePath {
    path: PathBuf,
    purpose: SelectedFilePurpose,
}

struct AppState {
    daemon: Arc<Mutex<Option<DaemonProcess>>>,
    daemon_start_lock: Mutex<()>,
    /// Wave 12, part E: the child's watcher and the state it reports.
    daemon_supervisor: Arc<Mutex<SupervisorState>>,
    event_cursor: Arc<AtomicU64>,
    active_session: Arc<Mutex<Option<String>>>,
    active_runtime: Arc<Mutex<Option<String>>>,
    event_stream_started: Arc<Mutex<bool>>,
    companion_resize_in_progress: Arc<AtomicBool>,
    companion_resize_generation: Arc<AtomicU64>,
    companion_drag: Mutex<Option<CompanionDrag>>,
    companion_maximised: AtomicBool,
    close_to_tray: AtomicBool,
    selected_file_paths: Mutex<HashMap<String, SelectedFilePath>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            daemon: Arc::new(Mutex::new(None)),
            daemon_start_lock: Mutex::new(()),
            daemon_supervisor: Arc::new(Mutex::new(SupervisorState { payload: DaemonSupervisor::running(), ..SupervisorState::default() })),
            event_cursor: Arc::new(AtomicU64::new(0)),
            active_session: Arc::new(Mutex::new(None)),
            active_runtime: Arc::new(Mutex::new(None)),
            event_stream_started: Arc::new(Mutex::new(false)),
            companion_resize_in_progress: Arc::new(AtomicBool::new(false)),
            companion_resize_generation: Arc::new(AtomicU64::new(0)),
            companion_drag: Mutex::new(None),
            companion_maximised: AtomicBool::new(false),
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
        return Err("The local Bitbots daemon is not running.".to_string());
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
        return Err("The local Bitbots daemon stopped unexpectedly.".to_string());
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
        "binaries/bitbotsd-x86_64-pc-windows-msvc.exe",
        tauri::path::BaseDirectory::Resource,
    ) {
        candidates.push(path);
    }
    if let Ok(path) = app
        .path()
        .resolve("bitbotsd.exe", tauri::path::BaseDirectory::Resource)
    {
        candidates.push(path);
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("binaries/bitbotsd-x86_64-pc-windows-msvc.exe"));
    if let Ok(target_dir) = std::env::var("CARGO_TARGET_DIR") {
        let target_dir = PathBuf::from(target_dir);
        candidates.push(target_dir.join("debug/bitbotsd.exe"));
        candidates.push(target_dir.join("release/bitbotsd.exe"));
    }
    candidates.push(manifest.join("../../../target/debug/bitbotsd.exe"));
    candidates.push(manifest.join("../../../target/release/bitbotsd.exe"));
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
            "bitbotsd.exe is missing. Build the workspace daemon first (npm run build:daemon)."
                .to_string()
        })?;

    let mut runtime_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve Bitbots local data directory: {error}"))?;
    runtime_dir.push("runtime-processes");
    fs::create_dir_all(&runtime_dir)
        .map_err(|error| format!("Could not prepare the local daemon folder: {error}"))?;
    let executable_copy = runtime_dir.join(format!(
        "bitbotsd-{}-{}.exe",
        std::process::id(),
        Uuid::new_v4()
    ));
    fs::copy(&executable, &executable_copy).map_err(|error| {
        format!("Could not copy the daemon to its private run location: {error}")
    })?;

    let mut command = Command::new(&executable_copy);
    command
        .env("BLOBLEX_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // When the packaged remote web app is installed beside the shell, hand its
    // folder to the daemon so the remote gateway can serve it (WP6c builds it).
    if let Ok(remote_web) = app
        .path()
        .resolve("remote-web", tauri::path::BaseDirectory::Resource)
    {
        if remote_web.is_dir() {
            command.env("BITBOTS_REMOTE_WEB_DIR", &remote_web);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|error| {
        let _ = fs::remove_file(&executable_copy);
        format!("Could not start bitbotsd.exe: {error}")
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

#[cfg(target_os = "windows")]
fn approval_overlay(count: u32) -> tauri::image::Image<'static> {
    let mut rgba = vec![0u8; 32 * 32 * 4];
    for y in 0..32i32 {
        for x in 0..32i32 {
            if (x - 16).pow(2) + (y - 16).pow(2) <= 225 {
                let at = ((y * 32 + x) * 4) as usize;
                rgba[at..at + 4].copy_from_slice(&[232, 176, 75, 255]);
            }
        }
    }
    let digits = [
        [7u8, 5, 5, 5, 7], [2, 6, 2, 2, 7], [7, 1, 7, 4, 7], [7, 1, 7, 1, 7],
        [5, 5, 7, 1, 1], [7, 4, 7, 1, 7], [7, 4, 7, 5, 7], [7, 1, 1, 1, 1],
        [7, 5, 7, 5, 7], [7, 5, 7, 1, 7],
    ];
    let digit = digits[count.min(9) as usize];
    for (row, bits) in digit.iter().enumerate() {
        for col in 0..3 {
            if bits & (1 << (2 - col)) == 0 { continue; }
            for dy in 0..3 { for dx in 0..3 {
                let x = 10 + col * 3 + dx;
                let y = 8 + row * 3 + dy;
                let at = (y * 32 + x) * 4;
                rgba[at..at + 4].copy_from_slice(&[14, 14, 14, 255]);
            }}
        }
    }
    if count > 9 {
        for (x, y) in [(24, 14), (24, 15), (24, 16), (23, 15), (25, 15)] {
            let at = (y * 32 + x) * 4;
            rgba[at..at + 4].copy_from_slice(&[14, 14, 14, 255]);
        }
    }
    tauri::image::Image::new_owned(rgba, 32, 32)
}

#[tauri::command]
fn set_approval_badge(app: AppHandle, window: tauri::WebviewWindow, count: u32) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the main window can update the approval badge.".into()); }
    #[cfg(target_os = "windows")]
    window.set_overlay_icon(if count == 0 { None } else { Some(approval_overlay(count)) }).map_err(|_| "Could not update the taskbar badge.".to_string())?;
    if let Some(tray) = app.tray_by_id("bloblex-tray") {
        let tooltip = if count == 0 { "Bitbots".to_owned() } else { format!("Bitbots: {count} waiting") };
        tray.set_tooltip(Some(tooltip)).map_err(|_| "Could not update the tray tooltip.".to_string())?;
    }
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod approval_overlay_tests {
    use super::*;
    #[test]
    fn overlay_is_rgba_with_transparent_corners_and_visible_count() {
        let icon = approval_overlay(3);
        assert_eq!((icon.width(), icon.height()), (32, 32));
        assert_eq!(&icon.rgba()[0..4], &[0, 0, 0, 0]);
        assert!(icon.rgba().chunks_exact(4).any(|p| p == [14, 14, 14, 255]));
        assert_ne!(approval_overlay(1).rgba(), approval_overlay(9).rgba());
    }
}

#[tauri::command]
async fn daemon_rpc(
    app: AppHandle,
    state: State<'_, AppState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let first = match connection(&state) {
        Ok(conn) => rpc_call(&conn, &method, params.clone()).await,
        Err(error) => Err(error),
    };
    let result = match first {
        Err(error) if retry_startup_read(&method, &error) => {
            start_daemon(&app, &state)?;
            let current = connection(&state)?;
            rpc_call(&current, &method, params).await?
        }
        other => other?,
    };
    if method == "app.snapshot" {
        if let Some(sequence) = result.get("sequence").and_then(Value::as_u64) {
            state.event_cursor.store(sequence, Ordering::Release);
        }
    }
    Ok(result)
}

/// A lost transport can be retried once for observational startup calls only.
fn retry_startup_read(method: &str, error: &str) -> bool {
    matches!(method, "app.snapshot" | "runtime.refresh" | "runtime.models" | "runtime.capabilities" | "usage.summary" | "settings.get" | "message.image")
        && (error.starts_with("Daemon request failed:")
            || error == "The local Bitbots daemon is not running."
            || error == "The local Bitbots daemon stopped unexpectedly.")
}

#[cfg(test)]
mod startup_transport_tests {
    use super::retry_startup_read;

    #[test]
    fn retries_only_startup_reads_after_a_transport_loss() {
        for method in ["app.snapshot", "runtime.refresh", "runtime.models", "runtime.capabilities", "usage.summary", "settings.get"] {
            assert!(retry_startup_read(method, "Daemon request failed: connection refused"));
            assert!(!retry_startup_read(method, "unauthorized: capability refused"));
            assert!(!retry_startup_read(method, "invalid_argument: bad params"));
        }
        for method in ["session.prompt", "agent.purge", "settings.set", "daemon.shutdown"] {
            assert!(!retry_startup_read(method, "Daemon request failed: connection refused"));
        }
    }
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
    // Wave 13 (found in the live test): the window's reconnect must not start the
    // daemon behind the supervisor's back. While it waits out a backoff, or after it
    // gave up, only the supervisor (or the owner's Try again) starts it.
    if let Some(reason) = state.daemon_supervisor.lock().ok().and_then(|inner| supervisor_blocks_start(&inner.payload)) {
        return Err(reason.to_owned());
    }
    start_daemon(&app, &state)
}

/// Why a start from the window must wait, if it must.
fn supervisor_blocks_start(payload: &DaemonSupervisor) -> Option<&'static str> {
    match payload.state.as_str() {
        "gave_up" => Some("The Bitbots service keeps stopping, so it was not restarted again. Use Try again."),
        "restarting" => Some("The Bitbots service is restarting."),
        _ => None,
    }
}

#[cfg(test)]
mod supervisor_gate_tests {
    use super::*;
    // Wave 13: the window's reconnect waits for the supervisor, which a live crash test showed it did not.
    #[test]
    fn the_window_never_starts_the_daemon_while_the_supervisor_waits_or_gave_up() {
        let at = |state: &str| DaemonSupervisor { state: state.into(), ..DaemonSupervisor::running() };
        assert!(supervisor_blocks_start(&DaemonSupervisor::running()).is_none());
        assert!(supervisor_blocks_start(&at("restarting")).is_some());
        assert!(supervisor_blocks_start(&at("gave_up")).unwrap().contains("Try again"));
    }
}

/// The supervisor's current reading, for a window that just opened.
#[tauri::command]
fn daemon_supervisor_state(state: State<'_, AppState>) -> DaemonSupervisor {
    state
        .daemon_supervisor
        .lock()
        .map(|inner| inner.payload.clone())
        .unwrap_or_default()
}

/// Restart the child now, however long ago the last crash was, and start the
/// crash window again. The wait between automatic restarts is never applied to a
/// restart the owner asked for.
#[tauri::command]
fn daemon_restart_now(app: AppHandle, state: State<'_, AppState>) -> Result<DaemonSupervisor, String> {
    let supervisor = Arc::clone(&state.daemon_supervisor);
    {
        let mut inner = supervisor.lock().map_err(|_| "Daemon supervisor state is unavailable.".to_string())?;
        inner.crashes.clear();
        inner.payload = DaemonSupervisor { state: "restarting".into(), attempt: 0, next_retry_ms: Some(0), last_exit_code: inner.payload.last_exit_code };
    }
    emit_supervisor(&app, &supervisor);
    // A stop the owner asked for: the watcher must not count it as a crash.
    mark_daemon_stopping(&supervisor);
    stop_daemon(Arc::clone(&state.daemon));
    clear_daemon_stopping(&supervisor);
    let started = start_daemon(&app, &state);
    let payload = {
        let mut inner = supervisor.lock().map_err(|_| "Daemon supervisor state is unavailable.".to_string())?;
        match &started {
            Ok(()) => {
                inner.armed = true;
                inner.payload = DaemonSupervisor { state: "running".into(), attempt: 0, next_retry_ms: None, last_exit_code: inner.payload.last_exit_code };
            }
            Err(error) => {
                inner.payload.state = "restarting".into();
                inner.payload.attempt = 1;
                inner.payload.next_retry_ms = Some(SUPERVISOR_BACKOFF_MS[0]);
                log_shell("warn", &format!("daemon restart failed: {error}"));
            }
        }
        inner.payload.clone()
    };
    emit_supervisor(&app, &supervisor);
    start_daemon_watcher(&app);
    started.map(|_| payload)
}

fn emit_supervisor(app: &AppHandle, supervisor: &Arc<Mutex<SupervisorState>>) {
    if let Ok(inner) = supervisor.lock() {
        let _ = app.emit("daemon-supervisor", inner.payload.clone());
    }
}

fn mark_daemon_stopping(supervisor: &Arc<Mutex<SupervisorState>>) {
    if let Ok(mut inner) = supervisor.lock() {
        inner.stopping = true;
    }
}

fn clear_daemon_stopping(supervisor: &Arc<Mutex<SupervisorState>>) {
    if let Ok(mut inner) = supervisor.lock() {
        inner.stopping = false;
    }
}

/// Wave 12, part E: watch the child for as long as the app runs. A crashed daemon
/// used to come back only when the window next asked (`ensure_daemon`); this thread
/// restarts it with a growing backoff and gives up after five crashes in two
/// minutes, reporting every change as `daemon-supervisor`.
fn start_daemon_watcher(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let supervisor = Arc::clone(&state.daemon_supervisor);
    {
        let Ok(mut inner) = supervisor.lock() else { return };
        if inner.watching { return }
        inner.watching = true;
    }
    let app = app.clone();
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(500));
            let Some(state) = app.try_state::<AppState>() else { return };
            if supervisor.lock().map(|inner| inner.stopping).unwrap_or(true) {
                if let Ok(mut inner) = supervisor.lock() { inner.watching = false; }
                return;
            }
            // One read of the child: it is either running, or it has exited and its
            // record (and private copy) goes now.
            let exited: Option<Option<i32>> = {
                let Ok(mut slot) = state.daemon.lock() else { continue };
                let status = match slot.as_mut() {
                    Some(process) => process.child.try_wait().ok().flatten(),
                    None => None,
                };
                if status.is_some() {
                    if let Some(process) = slot.take() {
                        let _ = fs::remove_file(process.executable_copy);
                    }
                    Some(status.and_then(|status| status.code()))
                } else {
                    None
                }
            };
            if exited.is_none() {
                let live = state.daemon.lock().map(|slot| slot.is_some()).unwrap_or(false);
                let changed = {
                    let Ok(mut inner) = supervisor.lock() else { continue };
                    if !live {
                        false
                    } else {
                        inner.armed = true;
                        let changed = inner.payload.state != "running" || inner.payload.next_retry_ms.is_some();
                        if changed {
                            inner.payload = DaemonSupervisor { state: "running".into(), attempt: 0, next_retry_ms: None, last_exit_code: inner.payload.last_exit_code };
                        }
                        changed
                    }
                };
                if changed { emit_supervisor(&app, &supervisor); }
                continue;
            }
            // The child is gone. Before it ever ran, or during a stop the owner
            // asked for, that is not a crash.
            let give_up = {
                let Ok(mut inner) = supervisor.lock() else { continue };
                if inner.stopping {
                    inner.watching = false;
                    return;
                }
                if !inner.armed { continue }
                let now = Instant::now();
                inner.crashes.retain(|at| now.duration_since(*at) < SUPERVISOR_WINDOW);
                inner.crashes.push(now);
                inner.payload.last_exit_code = exited.unwrap_or(None);
                if inner.crashes.len() >= SUPERVISOR_CRASH_LIMIT {
                    inner.payload.state = "gave_up".into();
                    inner.payload.next_retry_ms = None;
                    true
                } else {
                    // The wait grows with the crashes inside the window, not with a
                    // counter a successful restart would reset (found in the live test).
                    let attempt = inner.crashes.len() as u32;
                    let wait = SUPERVISOR_BACKOFF_MS[(attempt as usize).saturating_sub(1).min(SUPERVISOR_BACKOFF_MS.len() - 1)];
                    inner.payload.state = "restarting".into();
                    inner.payload.attempt = attempt;
                    inner.payload.next_retry_ms = Some(wait);
                    false
                }
            };
            emit_supervisor(&app, &supervisor);
            if give_up {
                log_shell("error", "daemon stopped five times in two minutes; the supervisor gave up");
                if let Ok(mut inner) = supervisor.lock() { inner.watching = false; }
                return;
            }
            let wait = supervisor.lock().ok().and_then(|inner| inner.payload.next_retry_ms).unwrap_or(SUPERVISOR_BACKOFF_MS[0]);
            let deadline = Instant::now() + Duration::from_millis(wait);
            while Instant::now() < deadline {
                thread::sleep(Duration::from_millis(100));
                if supervisor.lock().map(|inner| inner.stopping).unwrap_or(true) {
                    if let Ok(mut inner) = supervisor.lock() { inner.watching = false; }
                    return;
                }
            }
            let started = start_daemon(&app, &state);
            {
                let Ok(mut inner) = supervisor.lock() else { continue };
                match &started {
                    Ok(()) => {
                        inner.armed = true;
                        inner.payload = DaemonSupervisor { state: "running".into(), attempt: 0, next_retry_ms: None, last_exit_code: inner.payload.last_exit_code };
                    }
                    // The attempt failed: the next pass counts it and waits longer.
                    Err(error) => log_shell("warn", &format!("daemon restart failed: {error}")),
                }
            }
            emit_supervisor(&app, &supervisor);
        }
    });
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

/// The one message the window recognises to open Settings › Backup instead.
const FULL_BOT_FILE: &str = "This is a full bot file with its notes and schedules. Import it in Settings › Backup.";

#[tauri::command]
fn read_blob_import(state: State<'_, AppState>, selection_token: String) -> Result<String, String> {
    let path = take_selected_path(&state, &selection_token, SelectedFilePurpose::Import)?;
    // Wave 13: a bot exported with its notes and schedules is a backup file; the
    // backup import shows what it holds before anything changes.
    if path.file_name().is_some_and(|name| name.to_string_lossy().to_ascii_lowercase().ends_with(".bitbots-backup.json")) {
        return Err(FULL_BOT_FILE.to_string());
    }
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

/// Largest `.bitbots-backup.json` the native reader accepts.
const MAX_BACKUP_BYTES: u64 = 64 * 1024 * 1024;

#[tauri::command]
fn select_backup_export_path(app: AppHandle, state: State<'_, AppState>, suggested_name: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // A bot template suggests the bot's name; only plain file-name characters are kept.
    let template_name = suggested_name.map(|name| name.chars().filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_')).take(60).collect::<String>().trim().to_owned()).filter(|name| !name.is_empty());
    let suggested_name = match template_name {
        Some(name) => format!("{name}.bitbots-backup.json"),
        None => format!("bitbots-backup-{}.bitbots-backup.json", chrono::Utc::now().format("%Y-%m-%d")),
    };
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Save a Bitbots backup")
        .set_file_name(suggested_name)
        .add_filter("Bitbots backup", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|_| "The selected file path is unavailable.".to_string())?;
    Ok(Some(remember_selected_path(&state, path, SelectedFilePurpose::BackupExport)?))
}

#[tauri::command]
fn select_backup_import_path(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Choose a Bitbots backup")
        .add_filter("Bitbots backup", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|_| "The selected backup file path is unavailable.".to_string())?;
    Ok(Some(remember_selected_path(&state, path, SelectedFilePurpose::BackupImport)?))
}

/// The Bitbots data folder the daemon uses: `%LOCALAPPDATA%\Bitbots` (or the
/// parent of `BLOBLEX_DB_PATH` when a test or a portable install overrides it).
fn bitbots_data_dir() -> Option<PathBuf> {
    std::env::var_os("BLOBLEX_DB_PATH")
        .map(PathBuf::from)
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(|local| PathBuf::from(local).join("Bitbots")))
}

/// FIX39 P12: the shell's own log file, beside the daemon's, under `logs/`.
/// Only fixed messages and OS error text are written here, never user text,
/// credentials, tokens or file contents.
fn log_shell(level: &str, message: &str) {
    let Some(dir) = bitbots_data_dir().map(|base| base.join("logs")) else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    // Pruning reads the folder and every file's metadata; do it once per day
    // rather than on every line, so a burst of companion-resize lines does not
    // stat the folder hundreds of times.
    let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let prune = match SHELL_LOG_DAY.lock() {
        Ok(mut last) => should_prune_shell_logs(&mut last, &day),
        Err(_) => false,
    };
    if prune {
        prune_shell_logs(&dir);
    }
    let name = format!("desktop.{day}.log");
    let line = format!(
        "{} {level} {}\n",
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        redact_log_line(message)
    );
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(dir.join(name)) {
        use std::io::Write;
        let _ = file.write_all(line.as_bytes());
    }
}

/// The day whose log file was last pruned; the folder is pruned again when it
/// changes, not on every line.
static SHELL_LOG_DAY: Mutex<Option<String>> = Mutex::new(None);

/// True when the day changed since the last prune (and records the new day).
fn should_prune_shell_logs(last: &mut Option<String>, day: &str) -> bool {
    let changed = last.as_deref() != Some(day);
    *last = Some(day.to_string());
    changed
}

/// A last guard for the shell's own lines, mirroring the daemon's redaction:
/// every `Bearer` (not just the first), `key=value`, `key: value`, and the JSON
/// form `"key":"value"` for the words that name credentials.
fn redact_log_line(message: &str) -> String {
    let mut out = message.to_string();
    for marker in ["Bearer ", "bearer "] {
        let mut from = 0;
        while let Some(found) = out[from..].find(marker) {
            let start = from + found + marker.len();
            let end = out[start..].find([' ', '\n', ';', '"']).map(|offset| start + offset).unwrap_or(out.len());
            if end <= start {
                from = start;
                continue;
            }
            out.replace_range(start..end, "[redacted]");
            from = start + "[redacted]".len();
        }
    }
    for key in ["token", "password", "secret", "capability", "credential", "authorization", "cookie", "api_key", "apikey"] {
        let mut from = 0;
        loop {
            let Some(found) = out[from..].to_ascii_lowercase().find(key) else { break };
            let key_start = from + found;
            let mut cursor = key_start + key.len();
            // A closing quote may sit between the key and the separator (JSON).
            if out[cursor..].starts_with('"') {
                cursor += 1;
            }
            let rest = &out[cursor..];
            cursor += rest.len() - rest.trim_start().len();
            match out[cursor..].chars().next() {
                Some('=') | Some(':') => cursor += 1,
                _ => {
                    from = key_start + key.len();
                    continue;
                }
            }
            let after = &out[cursor..];
            cursor += after.len() - after.trim_start().len();
            // A quoted value is redacted up to its closing quote; a bare value
            // ends at the first delimiter.
            let close = out[cursor..].chars().next().filter(|character| *character == '"' || *character == '\'');
            let (value_start, end) = match close {
                Some(quote) => {
                    let value_start = cursor + 1;
                    (value_start, out[value_start..].find(quote).map(|offset| value_start + offset).unwrap_or(out.len()))
                }
                None => (cursor, out[cursor..].find([' ', '\n', ';', ',', '"', '}', ']']).map(|offset| cursor + offset).unwrap_or(out.len())),
            };
            if end <= value_start {
                from = cursor;
                continue;
            }
            out.replace_range(value_start..end, "[redacted]");
            from = value_start + "[redacted]".len();
        }
    }
    out
}

/// Keep the shell's own log files to about 20 MB, oldest first, matching the
/// daemon's cap on the shared folder.
fn prune_shell_logs(dir: &Path) {
    const MAX: u64 = 20 * 1024 * 1024;
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<(String, u64)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("desktop.") || !name.ends_with(".log") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then_some((name, metadata.len()))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let mut total: u64 = files.iter().map(|(_, size)| *size).sum();
    for (name, size) in files.iter().skip(1) {
        if total <= MAX {
            break;
        }
        if fs::remove_file(dir.join(name)).is_ok() {
            total = total.saturating_sub(*size);
        }
    }
}

/// Writes bytes to `path` through a sibling temp file and a rename, so a
/// half-written file never replaces a good one.
fn write_bytes_file(path: &Path, bytes: &[u8], what: &str) -> Result<(), String> {
    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty()).map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&parent).map_err(|_| format!("The {what} folder could not be created."))?;
    let temp = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    fs::write(&temp, bytes).map_err(|_| format!("The {what} could not be written."))?;
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("The {what} could not be written: {error}")
    })
}

/// Writes bytes to `path` through a sibling temp file and a rename, so a
/// half-written backup never replaces a good one.
fn write_backup_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_bytes_file(path, bytes, "backup")
}

#[tauri::command]
async fn backup_export_write(state: State<'_, AppState>, selection_token: String, include: Option<Value>) -> Result<Value, String> {
    let path = take_selected_path(&state, &selection_token, SelectedFilePurpose::BackupExport)?;
    let conn = connection(&state)?;
    let params = match include {
        Some(include) => json!({ "include": include }),
        None => json!({}),
    };
    let result = rpc_call(&conn, "backup.export", params).await?;
    let document = result.get("document").cloned().ok_or_else(|| "The backup could not be created.".to_string())?;
    let bytes = serde_json::to_vec_pretty(&document).map_err(|_| "The backup could not be written.".to_string())?;
    write_backup_file(&path, &bytes)?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "stats": result.get("stats").cloned().unwrap_or(Value::Null),
    }))
}

/// Reads a chosen `.bitbots-backup.json` (cap 64 MB, UTF-8, JSON) and sends it
/// to the daemon for validation. The file text never passes through the
/// renderer; only the preview crosses back.
#[tauri::command]
async fn backup_import_preview(state: State<'_, AppState>, selection_token: String) -> Result<Value, String> {
    let path = take_selected_path(&state, &selection_token, SelectedFilePurpose::BackupImport)?;
    let metadata = fs::metadata(&path).map_err(|_| "The selected backup file could not be read.".to_string())?;
    if metadata.len() > MAX_BACKUP_BYTES {
        return Err("This backup file is too large.".to_string());
    }
    let bytes = fs::read(&path).map_err(|_| "The selected backup file could not be read.".to_string())?;
    if bytes.len() as u64 > MAX_BACKUP_BYTES {
        return Err("This backup file is too large.".to_string());
    }
    let document: Value = serde_json::from_slice(&bytes).map_err(|_| "This is not a Bitbots backup file.".to_string())?;
    let conn = connection(&state)?;
    rpc_call(&conn, "backup.preview", json!({ "document": document })).await
}

/// FIX39 P12: the save dialog for the diagnostics `.zip`; returns an opaque
/// selection token. The renderer never supplies a path.
#[tauri::command]
fn select_diagnostics_export_path(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let suggested_name = format!("bitbots-diagnostics-{}.zip", chrono::Utc::now().format("%Y-%m-%d"));
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Save the diagnostics file")
        .set_file_name(suggested_name)
        .add_filter("Zip", &["zip"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|_| "The selected file path is unavailable.".to_string())?;
    Ok(Some(remember_selected_path(&state, path, SelectedFilePurpose::DiagnosticsExport)?))
}

/// Asks the daemon for the diagnostics zip and writes it to the chosen path.
/// The zip is base64 over the loopback RPC; the renderer only sees a summary.
#[tauri::command]
async fn diagnostics_export_write(state: State<'_, AppState>, selection_token: String) -> Result<Value, String> {
    let path = take_selected_path(&state, &selection_token, SelectedFilePurpose::DiagnosticsExport)?;
    let conn = connection(&state)?;
    let result = rpc_call(&conn, "diagnostics.export", json!({})).await?;
    let encoded = result.get("base64").and_then(Value::as_str).ok_or_else(|| "The diagnostics file could not be created.".to_string())?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "The diagnostics file could not be created.".to_string())?;
    write_bytes_file(&path, &bytes, "diagnostics file")?;
    log_shell("info", "diagnostics exported");
    Ok(json!({
        "path": path.to_string_lossy(),
        "sizeBytes": bytes.len(),
        "files": result.get("files").cloned().unwrap_or(Value::Null),
    }))
}

const MAX_STAGED_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const STAGED_ATTACHMENT_RETENTION: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);

/// Writes a pasted or picked image to Bitbots' local attachment folder so the
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
        "Bitbots cannot read this file path with the current Windows account.".to_string()
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
fn show_main_settings(app: AppHandle, session_id: Option<String>, page: Option<String>) -> Result<(), String> {
    show_main_window(app.clone(), session_id)?;
    app.emit("bloblex-open-settings", page)
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

/// The provider display name used in the terminal window title.
fn runtime_terminal_name(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude" => Ok("Claude Code"),
        "codex" => Ok("Codex"),
        "opencode" => Ok("OpenCode"),
        _ => Err(format!("Unknown coding agent: {provider}")),
    }
}

/// The login command for one provider. Claude Code opens its own prompt and the
/// user types `/login`, so it gets a one-line hint first.
fn provider_login_script(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude" => Ok("echo 'Bitbots: at the Claude Code prompt type /login, finish signing in, then retry here.'; claude"),
        "codex" => Ok("codex login"),
        "opencode" => Ok("opencode auth login"),
        _ => Err(format!("Unknown coding agent: {provider}")),
    }
}

const OPENCODE_DOCS: &str = "https://opencode.ai/docs/";

/// The install command for one provider, with its login command chained in the
/// same window. OpenCode is npm-only, so a missing npm is an error that names
/// its docs rather than a command that cannot work.
fn provider_install_script(provider: &str, npm_available: bool) -> Result<String, String> {
    let install = match provider {
        "claude" => "irm https://claude.ai/install.ps1 | iex",
        "codex" => "irm https://chatgpt.com/codex/install.ps1 | iex",
        "opencode" => {
            if !npm_available {
                return Err(format!("OpenCode is installed with npm, which is not on PATH. Install Node.js first, or see {OPENCODE_DOCS}."));
            }
            "npm install -g opencode-ai"
        }
        _ => return Err(format!("Unknown coding agent: {provider}")),
    };
    Ok(format!("{install}; {}", provider_login_script(provider)?))
}

/// A terminal launch, built from the fixed table. `args` is the exact argv the
/// shell command is spawned with.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TerminalLaunch {
    program: String,
    args: Vec<String>,
    /// The window the renderer is told about: `wt` or `powershell`.
    terminal: &'static str,
    /// True only for the direct `powershell.exe` fallback, which must open its
    /// own console window (`CREATE_NEW_CONSOLE`). `wt.exe` opens one itself.
    new_console: bool,
}

/// The value `runtime_terminal` resolves to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalLaunched {
    launched: bool,
    terminal: &'static str,
}

/// Build the launch for one provider and action. Nothing is spawned here, which
/// is what lets the table be tested.
fn terminal_launch(provider: &str, action: &str, npm_available: bool, wt_available: bool) -> Result<TerminalLaunch, String> {
    let name = runtime_terminal_name(provider)?;
    let script = match action {
        "login" => provider_login_script(provider)?.to_owned(),
        "install" => provider_install_script(provider, npm_available)?,
        other => return Err(format!("Unknown terminal action: {other}")),
    };
    let title = format!("Bitbots: {name} sign-in");
    if wt_available {
        // Windows Terminal parses its own argument list before PowerShell sees
        // the script, and an unescaped `;` there is wt's command separator: it
        // would split `echo ...; claude` (and every chained install) into two
        // commands. wt's documented escape is `\;`.
        Ok(TerminalLaunch {
            program: "wt.exe".into(),
            args: vec![
                "new-tab".into(),
                "--title".into(),
                title,
                "powershell".into(),
                "-NoExit".into(),
                "-Command".into(),
                script.replace(';', "\\;"),
            ],
            terminal: "wt",
            new_console: false,
        })
    } else {
        // Spawn PowerShell directly so Windows gives it a console of its own
        // with `CREATE_NEW_CONSOLE`; the script is one argv entry, quoted by
        // `std::process::Command`, so nothing re-parses the `|` or `;` in it.
        Ok(TerminalLaunch {
            program: "powershell.exe".into(),
            args: vec!["-NoExit".into(), "-Command".into(), script],
            terminal: "powershell",
            new_console: true,
        })
    }
}

/// Whether a program exists on PATH. Used only to pick the terminal and to
/// refuse an OpenCode install without npm.
fn program_on_path(program: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false; };
    std::env::split_paths(&path).any(|directory| directory.join(program).is_file())
}

/// Opens a visible terminal window with the provider's login or install
/// command. Only the provider and action come from the renderer; the command
/// text itself is always ours.
#[tauri::command]
fn runtime_terminal(provider: String, action: String) -> Result<TerminalLaunched, String> {
    let launch = terminal_launch(&provider, &action, program_on_path("npm.cmd"), program_on_path("wt.exe"))?;
    let mut command = Command::new(&launch.program);
    command.args(&launch.args);
    // The direct PowerShell fallback is a console app with no window of its own,
    // so ask Windows for one. `wt.exe` opens its own window and must not get the
    // flag, and this is no CREATE_NO_WINDOW anywhere.
    #[cfg(windows)]
    if launch.new_console {
        command.creation_flags(0x00000010); // CREATE_NEW_CONSOLE
    }
    command
        .spawn()
        .map_err(|error| format!("Could not open a terminal window: {error}"))?;
    Ok(TerminalLaunched { launched: true, terminal: launch.terminal })
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

/// Expanded companion sizes, in logical pixels. The window is frameless and transparent, so the page
/// draws handles on its edges and corners and drives `companion_resize_*`; nothing depends on the
/// operating system's resize borders. The compact bar keeps its fixed size.
const COMPANION_MIN_SIZE: (f64, f64) = (520.0, 340.0);
const COMPANION_DEFAULT_SIZE: (f64, f64) = (640.0, 420.0);
const COMPANION_LARGE_SIZE: (f64, f64) = (960.0, 720.0);

#[derive(Deserialize, Serialize)]
struct CompanionSizeFile {
    width: f64,
    height: f64,
}

/// At least the minimum, at most the work area (the area wins on a screen smaller than the minimum).
fn clamp_companion_size(width: f64, height: f64, max_width: f64, max_height: f64) -> (f64, f64) {
    let width = if width.is_finite() { width } else { COMPANION_DEFAULT_SIZE.0 };
    let height = if height.is_finite() { height } else { COMPANION_DEFAULT_SIZE.1 };
    (
        width.max(COMPANION_MIN_SIZE.0).min(max_width.max(1.0)),
        height.max(COMPANION_MIN_SIZE.1).min(max_height.max(1.0)),
    )
}

fn parse_companion_size(raw: &[u8]) -> Option<(f64, f64)> {
    let file: CompanionSizeFile = serde_json::from_slice(raw).ok()?;
    (file.width.is_finite() && file.height.is_finite() && file.width > 0.0 && file.height > 0.0).then_some((file.width, file.height))
}

fn saved_companion_size(app: &AppHandle) -> (f64, f64) {
    app_data_file(app, "companion-size.json")
        .and_then(|path| fs::read(path).ok())
        .and_then(|raw| parse_companion_size(&raw))
        .unwrap_or(COMPANION_DEFAULT_SIZE)
}

fn save_companion_size(app: &AppHandle, size: Option<(f64, f64)>) {
    let Some(path) = app_data_file(app, "companion-size.json") else { return };
    let Some((width, height)) = size else {
        let _ = fs::remove_file(path);
        return;
    };
    let temp = path.with_extension("json.tmp");
    if fs::write(&temp, serde_json::to_vec(&CompanionSizeFile { width, height }).unwrap_or_default()).is_ok() {
        let _ = fs::rename(temp, path);
    }
}

/// The work area (physical x, y, width, height) the window mostly sits on.
fn companion_work_area_of(window: &WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    let areas = companion_work_areas(window);
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let center = (position.x + size.width as i32 / 2, position.y + size.height as i32 / 2);
    areas
        .iter()
        .find(|(x, y, w, h)| center.0 >= *x && center.0 < *x + *w && center.1 >= *y && center.1 < *y + *h)
        .or_else(|| areas.first())
        .copied()
}

/// Which sides a drag moves: `n`, `s`, `e`, `w` or a corner such as `se`.
#[derive(Clone, Copy, Debug, PartialEq)]
struct ResizeEdge {
    left: bool,
    right: bool,
    top: bool,
    bottom: bool,
}

fn parse_resize_edge(edge: &str) -> Option<ResizeEdge> {
    let flags = ResizeEdge { left: edge.contains('w'), right: edge.contains('e'), top: edge.contains('n'), bottom: edge.contains('s') };
    let valid = matches!(edge, "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw");
    valid.then_some(flags)
}

/// The rectangle (physical x, y, width, height) after dragging `edge` by `delta`. The opposite side
/// stays where it was, also when the size hits the minimum or the work area's size.
fn resized_rect(start: (i32, i32, i32, i32), delta: (i32, i32), edge: ResizeEdge, min: (i32, i32), max: (i32, i32)) -> (i32, i32, i32, i32) {
    let (x, y, width, height) = start;
    let fit = |value: i32, low: i32, high: i32| value.max(low).min(high.max(1));
    let (mut new_x, mut new_width) = (x, width);
    if edge.right {
        new_width = fit(width + delta.0, min.0, max.0);
    }
    if edge.left {
        new_width = fit(width - delta.0, min.0, max.0);
        new_x = x + width - new_width;
    }
    let (mut new_y, mut new_height) = (y, height);
    if edge.bottom {
        new_height = fit(height + delta.1, min.1, max.1);
    }
    if edge.top {
        new_height = fit(height - delta.1, min.1, max.1);
        new_y = y + height - new_height;
    }
    (new_x, new_y, new_width, new_height)
}

/// A resize in progress: where the drag started, so every step is measured from the same point.
struct CompanionDrag {
    edge: ResizeEdge,
    cursor: (f64, f64),
    rect: (i32, i32, i32, i32),
    min: (i32, i32),
    area: (i32, i32, i32, i32),
}

#[tauri::command]
fn companion_resize_begin(app: AppHandle, state: State<'_, AppState>, edge: String) -> Result<(), String> {
    let edge = parse_resize_edge(&edge).ok_or_else(|| "Unknown resize edge.".to_string())?;
    let window = app.get_webview_window("companion").ok_or_else(|| "The companion window is unavailable.".to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let cursor = window.cursor_position().map_err(|error| error.to_string())?;
    let area = companion_work_area_of(&window).ok_or_else(|| "No display was found.".to_string())?;
    // A running grow or shrink animation must not fight the drag.
    state.companion_resize_generation.fetch_add(1, Ordering::SeqCst);
    state.companion_resize_in_progress.store(true, Ordering::SeqCst);
    state.companion_maximised.store(false, Ordering::SeqCst);
    *state.companion_drag.lock().map_err(|_| "The companion is busy.".to_string())? = Some(CompanionDrag {
        edge,
        cursor: (cursor.x, cursor.y),
        rect: (position.x, position.y, size.width as i32, size.height as i32),
        min: ((COMPANION_MIN_SIZE.0 * scale).round() as i32, (COMPANION_MIN_SIZE.1 * scale).round() as i32),
        area,
    });
    Ok(())
}

#[tauri::command]
fn companion_resize_step(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let drag = state.companion_drag.lock().map_err(|_| "The companion is busy.".to_string())?;
    let Some(drag) = drag.as_ref() else { return Ok(()) };
    let window = app.get_webview_window("companion").ok_or_else(|| "The companion window is unavailable.".to_string())?;
    let cursor = window.cursor_position().map_err(|error| error.to_string())?;
    let delta = ((cursor.x - drag.cursor.0).round() as i32, (cursor.y - drag.cursor.1).round() as i32);
    let (x, y, width, height) = resized_rect(drag.rect, delta, drag.edge, drag.min, (drag.area.2, drag.area.3));
    let (x, y) = clamp_physical_position(x, y, width, height, drag.area.0, drag.area.1, drag.area.2, drag.area.3);
    window.set_size(tauri::PhysicalSize::new(width as u32, height as u32)).map_err(|error| error.to_string())?;
    window.set_position(PhysicalPosition::new(x, y)).map_err(|error| error.to_string())?;
    Ok(())
}

/// Ends a drag, remembers the size for the next start and returns it (logical pixels).
#[tauri::command]
fn companion_resize_end(app: AppHandle, state: State<'_, AppState>) -> Result<(f64, f64), String> {
    let window = app.get_webview_window("companion").ok_or_else(|| "The companion window is unavailable.".to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let logical = (size.width as f64 / scale, size.height as f64 / scale);
    let was_dragging = state.companion_drag.lock().map_err(|_| "The companion is busy.".to_string())?.take().is_some();
    if was_dragging {
        save_companion_size(&app, Some(logical));
        persist_companion_position(&app, &window);
    }
    let generation = state.companion_resize_generation.load(Ordering::SeqCst);
    let generation_counter = Arc::clone(&state.companion_resize_generation);
    let resize_flag = Arc::clone(&state.companion_resize_in_progress);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(150));
        if generation_counter.load(Ordering::SeqCst) == generation {
            resize_flag.store(false, Ordering::SeqCst);
        }
    });
    Ok(logical)
}

/// `large` grows the expanded companion to a big size for working beside another app, `normal`
/// returns to the remembered size and `default` forgets it. Returns whether it is now large.
#[tauri::command]
fn set_companion_size_preset(app: AppHandle, state: State<'_, AppState>, preset: String) -> Result<bool, String> {
    let window = app.get_webview_window("companion").ok_or_else(|| "The companion window is unavailable.".to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let area = companion_work_area_of(&window).ok_or_else(|| "No display was found.".to_string())?;
    let (max_width, max_height) = (area.2 as f64 / scale, area.3 as f64 / scale);
    let (target, large) = match preset.as_str() {
        "large" => (COMPANION_LARGE_SIZE, true),
        "normal" => (saved_companion_size(&app), false),
        "default" => { save_companion_size(&app, None); (COMPANION_DEFAULT_SIZE, false) }
        _ => return Err("Unknown companion size.".to_string()),
    };
    let (width, height) = clamp_companion_size(target.0, target.1, max_width, max_height);
    let start_position = window.outer_position().map_err(|error| error.to_string())?;
    let initial = window.inner_size().map_err(|error| error.to_string())?;
    let initial_center = (start_position.x + initial.width as i32 / 2, start_position.y + initial.height as i32 / 2);
    state.companion_resize_generation.fetch_add(1, Ordering::SeqCst);
    state.companion_resize_in_progress.store(true, Ordering::SeqCst);
    window.set_size(LogicalSize::new(width, height)).map_err(|error| error.to_string())?;
    let (new_width, new_height) = ((width * scale).round() as i32, (height * scale).round() as i32);
    let target_position = PhysicalPosition::new(
        start_position.x - (new_width - initial.width as i32) / 2,
        start_position.y - (new_height - initial.height as i32),
    );
    let target_position = clamp_companion_position(target_position, new_width, new_height, &companion_work_areas(&window), initial_center);
    window.set_position(target_position).map_err(|error| error.to_string())?;
    state.companion_maximised.store(large, Ordering::SeqCst);
    persist_companion_position(&app, &window);
    let generation = state.companion_resize_generation.load(Ordering::SeqCst);
    let generation_counter = Arc::clone(&state.companion_resize_generation);
    let resize_flag = Arc::clone(&state.companion_resize_in_progress);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(150));
        if generation_counter.load(Ordering::SeqCst) == generation {
            resize_flag.store(false, Ordering::SeqCst);
        }
    });
    Ok(large)
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
    // The expanded companion keeps the size the owner dragged it to (clamped to this display).
    let expanded = match companion_work_area_of(&window) {
        Some((_, _, area_width, area_height)) => {
            let scale = window.scale_factor().map_err(|error| error.to_string())?;
            let saved = saved_companion_size(&app);
            clamp_companion_size(saved.0, saved.1, area_width as f64 / scale, area_height as f64 / scale)
        }
        None => saved_companion_size(&app),
    };
    let (desired_width, desired_height) = match mode.as_str() {
        "home" | "home-chat" => expanded,
        "petit" | "hidden" => {
            state.companion_maximised.store(false, Ordering::SeqCst);
            (344.0, 62.0)
        }
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
                eprintln!("Bitbots companion resize: {error}");
                log_shell("warn", &format!("companion resize failed: {error}"));
                break;
            }
            let next_position = PhysicalPosition::new(
                start_position.x - (width - initial.width as i32) / 2,
                start_position.y - (height - initial.height as i32),
            );
            let next_position=clamp_companion_position(next_position,width,height,&work_areas,initial_center);
            if let Err(error) = window.set_position(next_position) {
                eprintln!("Bitbots companion anchor: {error}");
                log_shell("warn", &format!("companion anchor failed: {error}"));
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
mod companion_resize_tests {
    use super::{clamp_companion_size, parse_companion_size, parse_resize_edge, resized_rect, ResizeEdge, COMPANION_MIN_SIZE};

    fn edge(name: &str) -> ResizeEdge {
        parse_resize_edge(name).expect("a valid edge")
    }

    #[test]
    fn the_size_is_at_least_the_minimum_and_at_most_the_work_area() {
        assert_eq!(clamp_companion_size(100.0, 100.0, 1900.0, 1000.0), COMPANION_MIN_SIZE);
        assert_eq!(clamp_companion_size(5000.0, 5000.0, 1900.0, 1000.0), (1900.0, 1000.0));
        assert_eq!(clamp_companion_size(700.0, 500.0, 1900.0, 1000.0), (700.0, 500.0));
        // A screen smaller than the minimum wins over the minimum.
        assert_eq!(clamp_companion_size(640.0, 420.0, 480.0, 300.0), (480.0, 300.0));
        assert_eq!(clamp_companion_size(f64::NAN, f64::INFINITY, 1900.0, 1000.0), (640.0, 420.0));
    }

    #[test]
    fn a_saved_size_must_be_two_positive_numbers() {
        assert_eq!(parse_companion_size(br#"{"width":700.5,"height":480}"#), Some((700.5, 480.0)));
        for bad in [&br#"{"width":-1,"height":400}"#[..], br#"{"width":0,"height":400}"#, br#"{"width":"a","height":4}"#, b"not json", b"{}"] {
            assert_eq!(parse_companion_size(bad), None);
        }
    }

    #[test]
    fn edges_parse_and_anything_else_is_refused() {
        assert_eq!(edge("e"), ResizeEdge { left: false, right: true, top: false, bottom: false });
        assert_eq!(edge("nw"), ResizeEdge { left: true, right: false, top: true, bottom: false });
        for bad in ["", "x", "ee", "ns", "up"] {
            assert!(parse_resize_edge(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn dragging_the_right_or_bottom_edge_keeps_the_top_left_corner() {
        let start = (100, 200, 800, 600);
        assert_eq!(resized_rect(start, (50, 30), edge("se"), (500, 300), (1900, 1000)), (100, 200, 850, 630));
        assert_eq!(resized_rect(start, (-100, 0), edge("e"), (500, 300), (1900, 1000)), (100, 200, 700, 600));
    }

    #[test]
    fn dragging_the_left_or_top_edge_keeps_the_far_side_still() {
        let start = (100, 200, 800, 600);
        // Left edge moves 40 left: wider by 40, the right edge (x + width = 900) stays.
        assert_eq!(resized_rect(start, (-40, 0), edge("w"), (500, 300), (1900, 1000)), (60, 200, 840, 600));
        assert_eq!(resized_rect(start, (0, -50), edge("n"), (500, 300), (1900, 1000)), (100, 150, 800, 650));
        let corner = resized_rect(start, (60, 80), edge("nw"), (500, 300), (1900, 1000));
        assert_eq!((corner.0 + corner.2, corner.1 + corner.3), (900, 800));
    }

    #[test]
    fn the_minimum_and_the_work_area_stop_a_drag_without_moving_the_far_side() {
        let start = (100, 200, 800, 600);
        let (x, y, width, height) = resized_rect(start, (900, 900), edge("nw"), (500, 300), (1900, 1000));
        assert_eq!((width, height), (500, 300));
        assert_eq!((x + width, y + height), (900, 800), "the bottom right corner stays put");
        let (_, _, width, height) = resized_rect(start, (5000, 5000), edge("se"), (500, 300), (1900, 1000));
        assert_eq!((width, height), (1900, 1000));
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
    // Quitting is not a crash: the supervisor stops watching before the child goes.
    mark_daemon_stopping(&state.daemon_supervisor);
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
        // The watcher must not read this stop as a crash and start the daemon again.
        mark_daemon_stopping(&self.daemon_supervisor);
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

enum PositionWrite { Moved, Flush }

/// A single worker per window waits for quiet; no monitor query, file IO or
/// thread creation happens on a move event. A close flushes the last position.
fn debounce_position_writes(receive: std::sync::mpsc::Receiver<PositionWrite>, quiet: Duration, mut write: impl FnMut()) {
    use std::sync::mpsc::RecvTimeoutError;
    let mut pending = false;
    loop {
        let message = if pending { receive.recv_timeout(quiet) } else {
            receive.recv().map_err(|_| RecvTimeoutError::Disconnected)
        };
        match message {
            Ok(PositionWrite::Moved) => pending = true,
            Ok(PositionWrite::Flush) => { write(); pending = false; }
            Err(RecvTimeoutError::Timeout) => { write(); pending = false; }
            Err(RecvTimeoutError::Disconnected) => { if pending { write(); } return; }
        }
    }
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
    .title("Bitbots Companion")
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
    let (position_write, receive) = std::sync::mpsc::channel();
    let writer_app = app.clone();
    let writer_window = window.clone();
    thread::spawn(move || debounce_position_writes(receive, Duration::from_millis(300), || {
        persist_companion_position(&writer_app, &writer_window);
    }));
    window.on_window_event(move |event| {
        if let WindowEvent::Moved(_) = event {
            if !resize_flag.load(Ordering::SeqCst) {
                let _ = position_write.send(PositionWrite::Moved);
            }
        }
        if let WindowEvent::CloseRequested { api, .. } = event {
            let _ = position_write.send(PositionWrite::Flush);
            api.prevent_close();
            let _ = window_for_event.hide();
            let _ = app_handle.emit("bloblex-companion-visible-changed", false);
        }
    });
    Ok(window)
}

/// Registers Ctrl+E for dictation while it is turned on, and releases it when off.
#[tauri::command]
fn set_dictation_shortcut(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyE);
    let shortcuts = app.global_shortcut();
    let registered = shortcuts.is_registered(shortcut);
    if enabled && !registered {
        shortcuts.register(shortcut).map_err(|error| format!("Ctrl+E is in use by another app: {error}"))?;
    } else if !enabled && registered {
        shortcuts.unregister(shortcut).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Grows the dictation bubble to show the words as they arrive, or shrinks it
/// back to the compact pill. The bottom centre stays put, so it grows upwards.
#[tauri::command]
fn set_dictation_bubble_size(app: AppHandle, expanded: bool) -> Result<(), String> {
    let window = app.get_webview_window("dictation").ok_or_else(|| "The dictation bubble is unavailable.".to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let (width, height) = if expanded { (DICTATION_EXPANDED.0, DICTATION_EXPANDED.1) } else { (DICTATION_COMPACT.0, DICTATION_COMPACT.1) };
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let (next_width, next_height) = ((width * scale).round() as i32, (height * scale).round() as i32);
    let center = position.x + size.width as i32 / 2;
    let bottom = position.y + size.height as i32;
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.set_position(PhysicalPosition::new(center - next_width / 2, bottom - next_height));
    Ok(())
}
const DICTATION_COMPACT: (f64, f64) = (260.0, 76.0);
const DICTATION_EXPANDED: (f64, f64) = (460.0, 136.0);

/// A frameless, always-on-top bubble shown only while dictation is active and
/// the companion is hidden. It mirrors the companion's transparency model.
fn make_dictation(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(
        app,
        "dictation",
        WebviewUrl::App("index.html?dictation=1".into()),
    )
    .title("Bitbots Dictation")
    .inner_size(DICTATION_COMPACT.0, DICTATION_COMPACT.1)
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
        let width = (DICTATION_COMPACT.0 * scale).round() as i32;
        let height = (DICTATION_COMPACT.1 * scale).round() as i32;
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
    let open = MenuItem::with_id(app, "open", "Open Bitbots", true, None::<&str>)?;
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
    let quit = MenuItem::with_id(app, "quit", "Quit Bitbots", true, None::<&str>)?;
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
        .tooltip("Bitbots")
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
                    let _ = show_main_settings(app.clone(), None, None);
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
    // Move any Bloblex-era data to the Bitbots identity *before* the Tauri
    // builder creates the WebView2 profile under the new identifier.
    migrate::migrate_before_start();
    tauri::Builder::default()
        // Must register first: a second launch must never start another daemon.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
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
                // One window dictates: the companion while it is on screen, else the main window.
                let companion_shown = app.get_webview_window("companion").and_then(|window| window.is_visible().ok()).unwrap_or(false);
                let _ = app.emit_to(if companion_shown { "companion" } else { "main" }, "bloblex-dictation-toggle", ());
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
        .manage(power::PowerState::default())
        .manage(backdrop::BackdropState::default())
        .manage(pty::PtyService::default())
        .setup(|app| {
            log_shell("info", concat!("desktop started version ", env!("CARGO_PKG_VERSION")));
            let mut start_at_last_position = false;
            let mut hotkey_enabled = true;
            if let Some(state) = app.try_state::<AppState>() {
                if let Err(error) = start_daemon(app.handle(), &state) {
                    eprintln!("Bitbots daemon startup: {error}");
                    log_shell("warn", &format!("daemon startup failed: {error}"));
                }
                // Wave 12, part E: a crash now restarts the daemon without waiting
                // for the window to ask.
                start_daemon_watcher(app.handle());
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
                    eprintln!("Bitbots companion shortcut unavailable: {error}");
                    log_shell("warn", &format!("companion shortcut unavailable: {error}"));
                }
            }
            // Ctrl+E is registered by the main window once it knows dictation is
            // on (set_dictation_shortcut), so it is never taken from other apps
            // while dictation is off.
            let companion = make_companion(app.handle(), start_at_last_position)?;
            let _ = companion.hide();
            let _ = app.emit("bloblex-companion-visible-changed", false);
            let dictation = make_dictation(app.handle())?;
            let _ = dictation.hide();
            updates::start_background_checker(app.handle());
            build_tray(app.handle())?;
            if let Some(main) = app.get_webview_window("main") {
                backdrop::restore(app.handle(), &main);
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
                    } else if let WindowEvent::Destroyed = event {
                        // No shell survives the window that could show it.
                        if let Some(terminals) = app_for_event.try_state::<pty::PtyService>() {
                            terminals.shutdown();
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_rpc,
            set_approval_badge,
            daemon_events_start,
            ensure_daemon,
            daemon_supervisor_state,
            daemon_restart_now,
            select_project_folder,
            select_local_file,
            select_markdown_export_path,
            write_selected_export_text,
            select_blob_export_path,
            select_blob_import_path,
            read_blob_import,
            select_backup_export_path,
            select_backup_import_path,
            backup_export_write,
            backup_import_preview,
            select_diagnostics_export_path,
            diagnostics_export_write,
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
            runtime_terminal,
            harness_updates::harness_latest_version,
            harness_updates::harness_update,
            clipboard::clipboard_image,
            toggle_companion,
            companion_visible,
            set_companion_mode,
            companion_resize_begin,
            companion_resize_step,
            companion_resize_end,
            set_companion_size_preset,
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
            speech::speech_cloud_status,
            speech::speech_model_download,
            speech::dictation_start,
            speech::dictation_warm,
            speech::dictation_release,
            set_dictation_shortcut,
            set_dictation_bubble_size,
            speech::dictation_stop,
            speech::dictation_cancel,
            speech::dictation_state,
            speech::dictation_cloud_warm,
            updates::updates_get_state,
            updates::updates_phase,
            updates::updates_set_preferences,
            updates::updates_check,
            updates::updates_install,
            power::set_keep_awake,
            power::keep_awake_state,
            backdrop::window_backdrop_apply,
            backdrop::window_backdrop_state,
            pty::terminal_open,
            pty::terminal_write,
            pty::terminal_resize,
            pty::terminal_close,
            pty::terminal_list
        ])
        .build(tauri::generate_context!())
        .expect("Bitbots desktop application failed to start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(window) = app.get_webview_window("companion") {
                    persist_companion_position(app, &window);
                }
                updates::stop_background_checker(app);
                if let Some(power) = app.try_state::<power::PowerState>() {
                    power.release();
                }
                if let Some(state) = app.try_state::<AppState>() {
                    state.stop_child();
                }
                if let Some(terminals) = app.try_state::<pty::PtyService>() {
                    terminals.shutdown();
                }
            }
        });
}

#[cfg(test)]
mod markdown_export_tests {
    use super::{redact_log_line, remember_selected_path, should_prune_shell_logs, take_selected_path, write_backup_file, write_bytes_file, write_markdown_export, AppState, SelectedFilePurpose};
    use std::path::PathBuf;
    use std::fs;

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

    #[test]
    fn backup_selection_purposes_are_distinct_and_single_use() {
        let state = AppState::default();
        // A token chosen for a backup export cannot be spent as a backup import.
        let export = remember_selected_path(&state, PathBuf::from("C:/selected/backup.json"), SelectedFilePurpose::BackupExport).unwrap();
        assert!(take_selected_path(&state, &export, SelectedFilePurpose::BackupImport).is_err());
        // The purpose mismatch also consumes the token, so it cannot be retried.
        assert!(take_selected_path(&state, &export, SelectedFilePurpose::BackupExport).is_err());

        // A blob import token cannot be spent as a backup import either.
        let blob = remember_selected_path(&state, PathBuf::from("C:/selected/blob.json"), SelectedFilePurpose::Import).unwrap();
        assert!(take_selected_path(&state, &blob, SelectedFilePurpose::BackupImport).is_err());

        let import = remember_selected_path(&state, PathBuf::from("C:/selected/restore.json"), SelectedFilePurpose::BackupImport).unwrap();
        assert_eq!(take_selected_path(&state, &import, SelectedFilePurpose::BackupImport).unwrap(), PathBuf::from("C:/selected/restore.json"));
        assert!(take_selected_path(&state, &import, SelectedFilePurpose::BackupImport).is_err());
    }

    #[test]
    fn diagnostics_selection_purpose_is_separate_and_the_writer_is_atomic() {
        let state = AppState::default();
        let backup = remember_selected_path(&state, PathBuf::from("C:/selected/backup.json"), SelectedFilePurpose::BackupExport).unwrap();
        assert!(take_selected_path(&state, &backup, SelectedFilePurpose::DiagnosticsExport).is_err());
        let diagnostics = remember_selected_path(&state, PathBuf::from("C:/selected/diagnostics.zip"), SelectedFilePurpose::DiagnosticsExport).unwrap();
        assert_ne!(diagnostics, "C:/selected/diagnostics.zip");
        assert!(take_selected_path(&state, &diagnostics, SelectedFilePurpose::BackupExport).is_err());
        assert!(take_selected_path(&state, &diagnostics, SelectedFilePurpose::DiagnosticsExport).is_err());

        // The bytes land at the chosen path through a temp file and rename.
        let dir = std::env::temp_dir().join(format!("bitbots-diagnostics-write-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested/diagnostics.zip");
        write_bytes_file(&path, b"PK\x03\x04diagnostics", "diagnostics file").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"PK\x03\x04diagnostics");
        let leftovers: Vec<_> = fs::read_dir(dir.join("nested")).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(leftovers, vec!["diagnostics.zip".to_string()]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_shell_log_line_drops_tokens_and_passwords() {
        let line = redact_log_line("daemon startup failed: token=deadbeef password: swordfish Bearer abcdefghi");
        assert!(!line.contains("deadbeef"), "{line}");
        assert!(!line.contains("swordfish"), "{line}");
        assert!(!line.contains("abcdefghi"), "{line}");
        assert!(line.contains("daemon startup failed"), "{line}");
    }

    #[test]
    fn the_shell_log_line_drops_every_bearer_and_json_shaped_secret() {
        let line = redact_log_line(
            r#"first Bearer abcdefghi second Bearer jklmnopqr {"cookie":"cookieval","authorization": "authval","api_key":"keyval"} Authorization: Bearervalue"#,
        );
        for secret in ["abcdefghi", "jklmnopqr", "cookieval", "authval", "keyval", "Bearervalue"] {
            assert!(!line.contains(secret), "the shell redactor left {secret}: {line}");
        }
        assert!(line.contains("first"), "{line}");
        assert!(line.contains("second"), "the first replacement must not stop the scan: {line}");
    }

    #[test]
    fn the_shell_prunes_the_log_folder_only_when_the_day_changes() {
        let mut last: Option<String> = None;
        assert!(should_prune_shell_logs(&mut last, "2026-10-18"), "the first line of the process prunes");
        assert!(!should_prune_shell_logs(&mut last, "2026-10-18"), "later lines on the same day do not");
        assert!(should_prune_shell_logs(&mut last, "2026-10-19"), "a new day prunes once");
        assert!(!should_prune_shell_logs(&mut last, "2026-10-19"));
    }

    #[test]
    fn backup_writes_through_a_temp_file_and_rename() {
        let dir = std::env::temp_dir().join(format!("bitbots-backup-write-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("backup.bitbots-backup.json");
        write_backup_file(&target, b"{\"ok\":true}").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"{\"ok\":true}");
        // No temp file is left beside the target.
        let leftovers = std::fs::read_dir(&dir).unwrap().flatten().filter(|entry| entry.file_name().to_string_lossy().starts_with('.')).count();
        assert_eq!(leftovers, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod runtime_terminal_tests {
    use super::{provider_install_script, terminal_launch, TerminalLaunch, OPENCODE_DOCS};

    fn argv(provider: &str, action: &str, npm: bool, wt: bool) -> Vec<String> {
        let launch = terminal_launch(provider, action, npm, wt).unwrap();
        assert_eq!(launch.program, if launch.terminal == "wt" { "wt.exe" } else { "powershell.exe" });
        launch.args
    }

    #[test]
    fn provider_and_action_are_allowlisted() {
        for provider in ["claude", "codex", "opencode"] {
            for action in ["login", "install"] {
                assert!(terminal_launch(provider, action, true, true).is_ok(), "{provider}/{action} must be allowed");
                assert!(terminal_launch(provider, action, true, false).is_ok(), "{provider}/{action} must be allowed without wt");
            }
        }
        for provider in ["", "powershell", "Claude", "claude;calc", "../claude", "unknown"] {
            assert!(terminal_launch(provider, "login", true, true).is_err(), "{provider} must be rejected");
        }
        for action in ["", "shell", "Login", "login;calc", "--version"] {
            assert!(terminal_launch("claude", action, true, true).is_err(), "{action} must be rejected");
        }
    }

    #[test]
    fn login_argv_per_provider_in_a_windows_terminal_tab() {
        assert_eq!(
            argv("claude", "login", true, true),
            vec![
                "new-tab",
                "--title",
                "Bitbots: Claude Code sign-in",
                "powershell",
                "-NoExit",
                "-Command",
                // wt's own `;` separator is escaped for wt, not for PowerShell.
                "echo 'Bitbots: at the Claude Code prompt type /login, finish signing in, then retry here.'\\; claude",
            ]
        );
        assert_eq!(
            argv("codex", "login", true, true),
            vec!["new-tab", "--title", "Bitbots: Codex sign-in", "powershell", "-NoExit", "-Command", "codex login"]
        );
        assert_eq!(
            argv("opencode", "login", true, true),
            vec!["new-tab", "--title", "Bitbots: OpenCode sign-in", "powershell", "-NoExit", "-Command", "opencode auth login"]
        );
    }

    #[test]
    fn wt_escapes_every_semicolon_in_the_script() {
        for provider in ["claude", "codex", "opencode"] {
            for action in ["login", "install"] {
                let launch = terminal_launch(provider, action, true, true).unwrap();
                let script = &launch.args[6];
                assert_eq!(
                    script.matches(';').count(),
                    script.matches("\\;").count(),
                    "every `;` must be escaped before wt sees it: {provider}/{action}: {script}"
                );
                assert_eq!(launch.terminal, "wt");
                assert!(!launch.new_console, "wt opens its own window");
            }
        }
        // The chained Claude login really does carry a separator to escape.
        assert!(terminal_launch("claude", "login", true, true).unwrap().args[6].contains("\\; claude"));
    }

    #[test]
    fn install_argv_chains_the_login_command() {
        assert_eq!(
            argv("claude", "install", true, true)[6],
            "irm https://claude.ai/install.ps1 | iex\\; echo 'Bitbots: at the Claude Code prompt type /login, finish signing in, then retry here.'\\; claude"
        );
        assert_eq!(
            argv("codex", "install", true, true)[6],
            "irm https://chatgpt.com/codex/install.ps1 | iex\\; codex login"
        );
        assert_eq!(
            argv("opencode", "install", true, true)[6],
            "npm install -g opencode-ai\\; opencode auth login"
        );
    }

    #[test]
    fn opencode_install_without_npm_names_the_docs() {
        let error = provider_install_script("opencode", false).unwrap_err();
        assert!(error.contains(OPENCODE_DOCS));
        assert!(!error.to_lowercase().contains("password"));
    }

    #[test]
    fn the_fallback_spawns_powershell_directly_with_a_new_console() {
        let launch: TerminalLaunch = terminal_launch("codex", "install", false, false).unwrap();
        assert_eq!(launch.terminal, "powershell");
        assert!(
            launch.new_console,
            "the direct PowerShell fallback needs CREATE_NEW_CONSOLE"
        );
        assert_eq!(launch.program, "powershell.exe");
        // One argv entry, unquoted: `std::process::Command` quotes it, and no
        // cmd.exe is in the path to read the `|` or `;` itself.
        assert_eq!(
            launch.args,
            vec![
                "-NoExit",
                "-Command",
                "irm https://chatgpt.com/codex/install.ps1 | iex; codex login",
            ]
        );
    }
}

#[cfg(test)]
mod companion_persistence_tests {
    use super::*;

    #[test]
    fn rapid_moves_write_once_after_quiet_and_close_flushes() {
        let (send, receive) = std::sync::mpsc::channel();
        let (written, writes) = std::sync::mpsc::channel();
        // Queue the burst before starting the worker so scheduler load cannot
        // accidentally turn the burst into separate quiet periods.
        for _ in 0..20 { send.send(PositionWrite::Moved).unwrap(); }
        let worker = thread::spawn(move || debounce_position_writes(receive, Duration::from_millis(40), || { written.send(()).unwrap(); }));
        writes.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(writes.recv_timeout(Duration::from_millis(100)).is_err());
        send.send(PositionWrite::Moved).unwrap();
        send.send(PositionWrite::Flush).unwrap();
        writes.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(send);
        worker.join().unwrap();
        assert!(writes.try_recv().is_err());
    }
}
