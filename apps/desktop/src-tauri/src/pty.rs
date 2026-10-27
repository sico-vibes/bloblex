//! Native terminal sessions for the dock.
//!
//! The renderer can only reach a short list of shells, started inside a project
//! folder it names. Sessions live in memory only: no transcript is written
//! anywhere, and nothing here touches the disk.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{Receiver, RecvTimeoutError, SyncSender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, Window};
use uuid::Uuid;

const MAIN_WINDOW: &str = "main";
const ONLY_MAIN: &str = "Terminals are only available in the main window.";
const UNAVAILABLE: &str = "The terminal service is unavailable.";
const CLOSED: &str = "The terminal has closed.";
const TOO_MANY: &str = "Close a terminal before opening another one.";

const MAX_TERMINALS: usize = 6;
const MAX_WRITE_BYTES: usize = 64 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 300;
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

const READ_CHUNK: usize = 8 * 1024;
const COALESCE_BYTES: usize = 16 * 1024;
const COALESCE_WINDOW: Duration = Duration::from_millis(8);
const MAX_BYTES_PER_SECOND: usize = 4 * 1024 * 1024;
const EXIT_WAIT: Duration = Duration::from_secs(1);
const PUMP_WAIT: Duration = Duration::from_secs(2);
const TASKKILL_WAIT: Duration = Duration::from_secs(2);
const QUEUE_DEPTH: usize = 64;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpened {
    pub id: String,
    pub pid: Option<u32>,
    pub shell: String,
    pub cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub shell: String,
    pub cwd: String,
    pub running: bool,
    pub exit_code: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent<'a> {
    id: &'a str,
    seq: u64,
    data: &'a str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent<'a> {
    id: &'a str,
    exit_code: Option<u32>,
}

struct Session {
    id: String,
    pid: Option<u32>,
    shell: String,
    cwd: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    sequence: AtomicU64,
    /// The UI asked for the shell to go away; output and input stop at once.
    closing: AtomicBool,
    /// The shell is gone and its exit code is final.
    ended: AtomicBool,
    exit_emitted: AtomicBool,
    exit_code: Mutex<Option<u32>>,
    pump: Mutex<Option<Pump>>,
}

/// The thread that turns pty reads into events. `done` disconnects when it returns.
struct Pump {
    handle: JoinHandle<()>,
    done: Receiver<()>,
}

impl Session {
    fn info(&self) -> TerminalInfo {
        TerminalInfo {
            id: self.id.clone(),
            pid: self.pid,
            shell: self.shell.clone(),
            cwd: self.cwd.clone(),
            running: !self.ended.load(Ordering::Acquire),
            exit_code: *self.exit_code.lock().unwrap_or_else(|error| error.into_inner()),
        }
    }

    /// Kill the shell and everything it started. The pump still reports the exit.
    fn stop(&self) {
        self.closing.store(true, Ordering::Release);
        if !self.ended.load(Ordering::Acquire) {
            if let Ok(mut child) = self.child.lock() {
                let _ = reap(&mut child);
            }
        }
        self.ended.store(true, Ordering::Release);
    }

    /// Join the pump, but never hang on it: a wedged read is left detached.
    fn wait_for_pump(&self) {
        let pump = self.pump.lock().ok().and_then(|mut slot| slot.take());
        let Some(pump) = pump else { return };
        if !matches!(pump.done.recv_timeout(PUMP_WAIT), Err(RecvTimeoutError::Timeout)) {
            let _ = pump.handle.join();
        }
    }
}

#[derive(Default)]
pub struct PtyService {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl PtyService {
    /// The app is exiting or the main window is gone: no shell outlives it.
    pub fn shutdown(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut sessions) => sessions.drain().map(|(_, session)| session).collect::<Vec<_>>(),
            Err(error) => error.into_inner().drain().map(|(_, session)| session).collect(),
        };
        for session in sessions {
            session.stop();
        }
    }
}

fn guard_main(window: &Window) -> Result<(), String> {
    if window.label() == MAIN_WINDOW {
        Ok(())
    } else {
        Err(ONLY_MAIN.into())
    }
}

/// A project folder as `canonicalize` reports it, kept for `starts_with` checks.
fn project_dir(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("The project folder could not be found.".into());
    }
    if path.len() > MAX_PATH_BYTES {
        return Err("The project path is too long.".into());
    }
    let canonical = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "The project folder could not be found.".to_string())?;
    if !canonical.is_dir() {
        return Err("The project path is not a folder.".into());
    }
    Ok(canonical)
}

fn folder_inside(path: &str, root: &Path) -> Result<PathBuf, String> {
    if path.len() > MAX_PATH_BYTES {
        return Err("The terminal folder path is too long.".into());
    }
    let canonical = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "The terminal folder could not be found.".to_string())?;
    if !canonical.is_dir() {
        return Err("The terminal folder is not a folder.".into());
    }
    if !canonical.starts_with(root) {
        return Err("The terminal folder must be inside this project.".into());
    }
    Ok(canonical)
}

/// Drop the verbatim prefix `canonicalize` adds so the UI shows `D:\x`, and
/// refuse UNC and device paths, which are not plain project folders.
#[cfg(windows)]
fn user_path(path: &Path) -> Result<PathBuf, String> {
    let text = path.as_os_str().to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let mut characters = rest.chars();
        let drive = characters.next().is_some_and(|letter| letter.is_ascii_alphabetic())
            && characters.next() == Some(':');
        if rest.starts_with(r"UNC\") || !drive {
            return Err("That folder is not on a local drive.".into());
        }
        return Ok(PathBuf::from(rest));
    }
    if text.starts_with(r"\\") {
        return Err("That folder is not on a local drive.".into());
    }
    Ok(path.to_path_buf())
}

#[cfg(not(windows))]
fn user_path(path: &Path) -> Result<PathBuf, String> {
    Ok(path.to_path_buf())
}

struct ShellChoice {
    id: &'static str,
    exe: &'static str,
    args: &'static [&'static str],
}

fn on_path(exe: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&path).any(|dir| !dir.as_os_str().is_empty() && dir.join(exe).is_file())
}

/// Only fixed shells: the name comes from the UI and must map to a known one.
fn choose_shell(requested: Option<&str>) -> Result<ShellChoice, String> {
    let unknown = || "Choose PowerShell, PowerShell 7 or Command Prompt.".to_string();
    #[cfg(windows)]
    {
        match requested.unwrap_or("powershell") {
            "powershell" => Ok(ShellChoice { id: "powershell", exe: "powershell.exe", args: &["-NoLogo"] }),
            "pwsh" if on_path("pwsh.exe") => Ok(ShellChoice { id: "pwsh", exe: "pwsh.exe", args: &["-NoLogo"] }),
            "pwsh" => Err("PowerShell 7 is not installed.".into()),
            "cmd" => Ok(ShellChoice { id: "cmd", exe: "cmd.exe", args: &[] }),
            _ => Err(unknown()),
        }
    }
    #[cfg(not(windows))]
    {
        match requested.unwrap_or("sh") {
            "sh" | "powershell" | "pwsh" | "cmd" => Ok(ShellChoice { id: "sh", exe: "/bin/sh", args: &[] }),
            _ => Err(unknown()),
        }
    }
}

/// No Bitbots secret may reach a user shell's environment.
fn sanitize_environment(command: &mut CommandBuilder) {
    for (name, _) in std::env::vars_os() {
        let name = name.to_string_lossy();
        let upper = name.to_ascii_uppercase();
        if upper.starts_with("BLOBLEX_")
            || upper.starts_with("BITBOTS_")
            || upper == "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
        {
            command.env_remove(name.as_ref());
        }
    }
    #[cfg(not(windows))]
    {
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
    }
}

fn check_size(cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 || cols > MAX_COLS || rows > MAX_ROWS {
        return Err("The terminal size is outside the supported range.".into());
    }
    Ok(())
}

fn prune_ended(service: &PtyService) -> Result<(), String> {
    service
        .sessions
        .lock()
        .map_err(|_| UNAVAILABLE.to_string())?
        .retain(|_, session| !session.ended.load(Ordering::Acquire));
    Ok(())
}

fn live_terminals(service: &PtyService) -> Result<usize, String> {
    Ok(service
        .sessions
        .lock()
        .map_err(|_| UNAVAILABLE.to_string())?
        .len())
}

fn lookup(service: &PtyService, id: &str) -> Result<Arc<Session>, String> {
    if id.is_empty() || id.len() > 64 {
        return Err(CLOSED.into());
    }
    service
        .sessions
        .lock()
        .map_err(|_| UNAVAILABLE.to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| CLOSED.to_string())
}

#[tauri::command]
pub fn terminal_open(
    window: Window,
    state: State<'_, PtyService>,
    project_path: String,
    cwd: Option<String>,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<TerminalOpened, String> {
    guard_main(&window)?;
    let root = project_dir(&project_path)?;
    let inside = match cwd.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => folder_inside(value, &root)?,
        None => root.clone(),
    };
    let shell = choose_shell(shell.as_deref().map(str::trim).filter(|id| !id.is_empty()))?;
    let size = PtySize {
        rows: rows.unwrap_or(DEFAULT_ROWS),
        cols: cols.unwrap_or(DEFAULT_COLS),
        pixel_width: 0,
        pixel_height: 0,
    };
    check_size(size.cols, size.rows)?;
    // The shell gets the plain path; `canonicalize`'s `\\?\` prefix confuses it.
    let root_display = user_path(&root)?;
    let cwd_display = if inside == root { root_display.clone() } else { user_path(&inside)? };

    prune_ended(&state)?;
    if live_terminals(&state)? >= MAX_TERMINALS {
        return Err(TOO_MANY.into());
    }

    let pair = native_pty_system()
        .openpty(size)
        .map_err(|_| "A terminal could not be opened on this device.".to_string())?;
    let mut command = CommandBuilder::new(shell.exe);
    command.args(shell.args);
    command.cwd(cwd_display.as_path());
    sanitize_environment(&mut command);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|_| "The selected shell could not be started.".to_string())?;
    let pid = child.process_id();
    drop(pair.slave);
    let (reader, writer) = match (pair.master.try_clone_reader(), pair.master.take_writer()) {
        (Ok(reader), Ok(writer)) => (reader, writer),
        _ => {
            // Never leave a half-built terminal with a live shell behind it.
            let mut child = child;
            terminate_process_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            return Err("The terminal could not be started.".to_string());
        }
    };

    let id = Uuid::new_v4().to_string();
    let session = Arc::new(Session {
        id: id.clone(),
        pid,
        shell: shell.id.to_string(),
        cwd: cwd_display.to_string_lossy().into_owned(),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        sequence: AtomicU64::new(0),
        closing: AtomicBool::new(false),
        ended: AtomicBool::new(false),
        exit_emitted: AtomicBool::new(false),
        exit_code: Mutex::new(None),
        pump: Mutex::new(None),
    });
    state
        .sessions
        .lock()
        .map_err(|_| UNAVAILABLE.to_string())?
        .insert(id.clone(), Arc::clone(&session));
    // Started after the insert so no event can name an unknown terminal.
    let pump = spawn_pump(reader, window.app_handle().clone(), Arc::clone(&session));
    if let Ok(mut slot) = session.pump.lock() {
        *slot = Some(pump);
    }
    Ok(TerminalOpened {
        id,
        pid,
        shell: shell.id.to_string(),
        cwd: cwd_display.to_string_lossy().into_owned(),
    })
}

fn spawn_pump(reader: Box<dyn Read + Send>, app: AppHandle, session: Arc<Session>) -> Pump {
    let (chunks, receiver) = std::sync::mpsc::sync_channel::<Vec<u8>>(QUEUE_DEPTH);
    thread::spawn(move || relay(reader, chunks));
    let (done, done_rx) = std::sync::mpsc::channel::<()>();
    let handle = thread::spawn(move || {
        pump(receiver, app, session);
        drop(done);
    });
    Pump { handle, done: done_rx }
}

/// Blocking reads only; a full queue stops reading, which is the back-pressure
/// the pty needs when output outruns the window.
fn relay(mut reader: Box<dyn Read + Send>, chunks: SyncSender<Vec<u8>>) {
    let mut buffer = vec![0_u8; READ_CHUNK];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if chunks.send(buffer[..count].to_vec()).is_err() {
                    break;
                }
            }
        }
    }
}

fn pump(receiver: Receiver<Vec<u8>>, app: AppHandle, session: Arc<Session>) {
    let mut pending = Vec::with_capacity(COALESCE_BYTES);
    let mut tail = Vec::with_capacity(4);
    let mut throttle = Throttle::new();
    loop {
        let Ok(first) = receiver.recv() else { break };
        pending.extend_from_slice(&first);
        // Give the shell a moment to finish the burst before spending an event on it.
        let deadline = Instant::now() + COALESCE_WINDOW;
        while pending.len() < COALESCE_BYTES {
            let wait = deadline.saturating_duration_since(Instant::now());
            if wait.is_zero() {
                break;
            }
            match receiver.recv_timeout(wait) {
                Ok(chunk) => pending.extend_from_slice(&chunk),
                Err(_) => break,
            }
        }
        if session.closing.load(Ordering::Acquire) {
            break;
        }
        throttle.wait(pending.len());
        let data = decode_utf8_chunk(&mut tail, &pending);
        pending.clear();
        if !data.is_empty() && !emit_output(&app, &session, &data) {
            break;
        }
    }
    if !tail.is_empty() && !session.closing.load(Ordering::Acquire) {
        let _ = emit_output(&app, &session, "\u{fffd}");
    }
    let exit_code = {
        let mut child = session.child.lock().unwrap_or_else(|error| error.into_inner());
        reap(&mut child)
    };
    *session.exit_code.lock().unwrap_or_else(|error| error.into_inner()) = exit_code;
    session.ended.store(true, Ordering::Release);
    emit_exit(&app, &session);
}

fn emit_output(app: &AppHandle, session: &Session, data: &str) -> bool {
    let seq = session.sequence.fetch_add(1, Ordering::Relaxed) + 1;
    app.emit_to(MAIN_WINDOW, "terminal://output", OutputEvent { id: &session.id, seq, data })
        .is_ok()
}

fn emit_exit(app: &AppHandle, session: &Session) {
    if session.exit_emitted.swap(true, Ordering::AcqRel) {
        return;
    }
    let exit_code = *session.exit_code.lock().unwrap_or_else(|error| error.into_inner());
    let _ = app.emit_to(MAIN_WINDOW, "terminal://exit", ExitEvent { id: &session.id, exit_code });
}

/// Decode what arrived, keeping an incomplete trailing sequence for the next read.
fn decode_utf8_chunk(pending: &mut Vec<u8>, incoming: &[u8]) -> String {
    pending.extend_from_slice(incoming);
    let mut output = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                output.push_str(valid);
                pending.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if let Ok(text) = std::str::from_utf8(&pending[..valid]) {
                    output.push_str(text);
                }
                match error.error_len() {
                    Some(length) => {
                        output.push('\u{fffd}');
                        pending.drain(..valid + length);
                    }
                    None => {
                        pending.drain(..valid);
                        break;
                    }
                }
            }
        }
    }
    output
}

struct Throttle {
    window: Instant,
    bytes: usize,
}

impl Throttle {
    fn new() -> Self {
        Self { window: Instant::now(), bytes: 0 }
    }

    /// Hold the pipe back rather than flood the window with a build log.
    fn wait(&mut self, count: usize) {
        loop {
            if self.window.elapsed() >= Duration::from_secs(1) {
                self.window = Instant::now();
                self.bytes = 0;
            }
            if self.bytes.saturating_add(count) <= MAX_BYTES_PER_SECOND {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        self.bytes = self.bytes.saturating_add(count);
    }
}

/// Wait briefly for a shell that is leaving on its own, then take the tree down.
fn reap(child: &mut Box<dyn Child + Send + Sync>) -> Option<u32> {
    let deadline = Instant::now() + EXIT_WAIT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.exit_code()),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) | Err(_) => return terminate_and_reap(child),
        }
    }
}

fn terminate_and_reap(child: &mut Box<dyn Child + Send + Sync>) -> Option<u32> {
    if let Ok(Some(status)) = child.try_wait() {
        return Some(status.exit_code());
    }
    terminate_process_tree(child.process_id());
    // Kill fails on a shell that just exited; the wait below is what decides.
    let _ = child.kill();
    child.wait().ok().map(|status| status.exit_code())
}

#[cfg(windows)]
fn terminate_process_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    let Some(system_root) = std::env::var_os("SystemRoot") else { return };
    let taskkill = PathBuf::from(system_root).join("System32").join("taskkill.exe");
    if !taskkill.is_file() {
        return;
    }
    let Ok(mut child) = std::process::Command::new(taskkill)
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return;
    };
    let deadline = Instant::now() + TASKKILL_WAIT;
    loop {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(not(windows))]
fn terminate_process_tree(_pid: Option<u32>) {}

#[tauri::command]
pub fn terminal_write(
    window: Window,
    state: State<'_, PtyService>,
    id: String,
    data: String,
) -> Result<(), String> {
    guard_main(&window)?;
    if data.len() > MAX_WRITE_BYTES {
        return Err("Terminal input is too large.".into());
    }
    let session = lookup(&state, &id)?;
    if session.closing.load(Ordering::Acquire) || session.ended.load(Ordering::Acquire) {
        return Err(CLOSED.into());
    }
    if data.is_empty() {
        return Ok(());
    }
    let mut writer = session.writer.lock().map_err(|_| "The terminal input is unavailable.")?;
    writer
        .write_all(data.as_bytes())
        .and_then(|()| writer.flush())
        .map_err(|_| CLOSED.to_string())
}

#[tauri::command]
pub fn terminal_resize(
    window: Window,
    state: State<'_, PtyService>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    guard_main(&window)?;
    check_size(cols, rows)?;
    let session = lookup(&state, &id)?;
    if session.ended.load(Ordering::Acquire) {
        return Ok(());
    }
    let master = session.master.lock().map_err(|_| "The terminal is unavailable.")?;
    master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|_| "The terminal could not be resized.".to_string())
}

#[tauri::command]
pub async fn terminal_close(
    window: Window,
    state: State<'_, PtyService>,
    id: String,
) -> Result<(), String> {
    guard_main(&window)?;
    if id.is_empty() || id.len() > 64 {
        return Ok(());
    }
    let session = state
        .sessions
        .lock()
        .map_err(|_| UNAVAILABLE.to_string())?
        .remove(&id);
    let Some(session) = session else { return Ok(()) };
    // Taking a process tree down can take a moment; never hold the window for it.
    let _ = tauri::async_runtime::spawn_blocking(move || {
        session.stop();
        // The pump emits the one exit event; this only stops waiting on it.
        session.wait_for_pump();
    })
    .await;
    Ok(())
}

#[tauri::command]
pub fn terminal_list(window: Window, state: State<'_, PtyService>) -> Result<Vec<TerminalInfo>, String> {
    guard_main(&window)?;
    let mut sessions = state.sessions.lock().map_err(|_| UNAVAILABLE.to_string())?;
    // Ended terminals are reported once, so the window can read their exit code.
    let terminals = sessions.values().map(|session| session.info()).collect();
    sessions.retain(|_, session| !session.ended.load(Ordering::Acquire));
    Ok(terminals)
}
