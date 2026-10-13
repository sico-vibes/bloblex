//! Dictation command surface.
//!
//! Owns the audio capture thread and a decode worker. The worker can be warmed
//! ahead of time (`dictation_warm`), is reused across sessions for the same
//! model whichever window starts them, and tears itself down after an idle
//! period. A session opens the microphone before the model finishes loading,
//! so audio queues instead of being lost. The pure lifecycle lives in
//! `bloblex_speech`; this module is the native shell.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use bloblex_speech::capture::{start_capture, AudioFrame};
use bloblex_speech::cloud::{
    auth_status, resolve_engine, AudioBuffer, CloudCooldown, CloudError, CloudTranscriber,
    EnginePreference, ResolvedEngine, BOTH_ENGINES_UNAVAILABLE, CLOUD_SAMPLE_RATE, MAX_BUFFER_SAMPLES,
};
use bloblex_speech::{
    catalog, downmix_to_mono, get_catalog_model, model_manager, resample_to_rate, rms_level,
    DictationLifecycle, DictationOwner, EngineEvent, SpeechEngine, SpeechModelManifest,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// How long a warm worker waits for the next session before releasing the model.
const IDLE_WORKER_TEARDOWN: Duration = Duration::from_secs(600);
/// How long the bubble lingers after a session ends so the finish cue is visible.
const BUBBLE_LINGER: Duration = Duration::from_millis(2400);
/// Throttle for microphone level events (~16 Hz).
const LEVEL_INTERVAL: Duration = Duration::from_millis(60);

/// Incremented when a new session claims the bubble; a pending hide is skipped
/// if the generation moved on (a new dictation started during the linger).
static BUBBLE_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct SpeechState {
    lifecycle: Arc<Mutex<DictationLifecycle>>,
    worker: Mutex<Option<WorkerHandle>>,
    cloud_cooldown: Arc<Mutex<CloudCooldown>>,
}

struct WorkerHandle {
    commands: Sender<WorkerCommand>,
    join: Option<JoinHandle<()>>,
    model_id: String,
}

enum WorkerCommand {
    Start(SessionPlan),
    Stop,
    Teardown,
    Frame(AudioFrame),
}

/// One dictation session's resolved engine decision, handed to the worker.
#[derive(Clone, Copy)]
struct SessionPlan {
    owner: DictationOwner,
    engine: ResolvedEngine,
    has_local_fallback: bool,
    /// Why a healthy cloud engine was skipped, if it was (e.g. `cloud_cooldown`).
    reason: Option<&'static str>,
}

fn parse_owner(owner: Option<String>) -> Result<DictationOwner, String> {
    match owner.as_deref() {
        None => Ok(DictationOwner::Desktop),
        Some(value) => DictationOwner::parse(value).map_err(|error| error.to_string()),
    }
}

fn has_non_ascii(value: &str) -> bool {
    value.chars().any(|character| !character.is_ascii())
}

/// sherpa-onnx cannot load models from non-ASCII Windows paths. Fall back to an
/// ASCII shared location, mirroring Orca's cache-path workaround.
fn resolve_cache_root(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_local_data_dir()
        .map(|directory| directory.join("speech-models"))
        .unwrap_or_else(|_| PathBuf::from("speech-models"));
    if !has_non_ascii(&base.to_string_lossy()) {
        return base;
    }
    let digest = model_manager::sha256_bytes(base.to_string_lossy().as_bytes());
    let short = &digest[..16];
    std::env::var("ProgramData")
        .or_else(|_| std::env::var("PROGRAMDATA"))
        .ok()
        .map(|root| {
            PathBuf::from(root)
                .join("Bloblex")
                .join("speech-models")
                .join(short)
        })
        .filter(|candidate| !has_non_ascii(&candidate.to_string_lossy()))
        .unwrap_or(base)
}

fn emit(app: &AppHandle, owner: DictationOwner, kind: &str, text: Option<&str>) {
    let payload = json!({ "type": kind, "owner": owner.as_str(), "text": text });
    let _ = app.emit("bloblex-dictation", payload);
}

fn emit_error(app: &AppHandle, owner: DictationOwner, text: &str, code: Option<&str>) {
    let payload = json!({ "type": "error", "owner": owner.as_str(), "text": text, "code": code });
    let _ = app.emit("bloblex-dictation", payload);
}

/// Status-only engine announcement for the UI indicator. Never carries content.
fn emit_engine_choice(
    app: &AppHandle,
    owner: DictationOwner,
    engine: ResolvedEngine,
    fallback: bool,
    reason: Option<&str>,
) {
    let _ = app.emit(
        "bloblex-dictation-engine",
        json!({ "owner": owner.as_str(), "engine": engine.as_str(), "fallback": fallback, "reason": reason }),
    );
}

/// The calm message for a cloud failure: names the reason class, never the body.
fn cloud_failure_message(error: &CloudError, has_local_fallback: bool) -> String {
    if has_local_fallback {
        format!(
            "ChatGPT transcription failed ({}), and the on-device model could not run.",
            error.reason()
        )
    } else {
        error.user_message()
    }
}

/// The event decisions for the cloud-failure path, kept pure so points 2 and 3
/// are testable without a Tauri `AppHandle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CloudFailureEvents {
    /// Announce that ChatGPT failed and the on-device engine took over.
    announce_fallback: bool,
    /// The machine reason that rides the fallback announcement, if any.
    reason: Option<&'static str>,
    /// Emit the calm error for an unrecovered failure.
    emit_error: bool,
    /// The machine code for that unrecovered failure: both engines unavailable.
    error_code: Option<&'static str>,
    /// Emit `stopped` so the UI finishes normally.
    emit_stopped: bool,
}

/// Decide the cloud-failure events. `has_local_fallback` is whether a local model
/// could take over; `recovered` is whether it actually produced output. A
/// fallback is announced only when it truly ran; an unrecovered failure emits
/// the error and no `stopped`, so the UI never turns the error into "Nothing
/// heard". An unrecovered failure carries one clear code, `both_engines_unavailable`.
fn cloud_failure_events(
    error: &CloudError,
    has_local_fallback: bool,
    recovered: bool,
) -> CloudFailureEvents {
    let used_fallback = has_local_fallback && recovered;
    CloudFailureEvents {
        announce_fallback: used_fallback,
        reason: used_fallback.then(|| error.code()),
        emit_error: !used_fallback,
        error_code: (!used_fallback).then_some(BOTH_ENGINES_UNAVAILABLE),
        emit_stopped: used_fallback,
    }
}

fn emit_engine_event(app: &AppHandle, owner: DictationOwner, event: EngineEvent) {
    match event {
        EngineEvent::Partial(text) => emit(app, owner, "partial", Some(&text)),
        EngineEvent::Final(text) => emit(app, owner, "final", Some(&text)),
    }
}

fn companion_visible(app: &AppHandle) -> bool {
    app.get_webview_window("companion")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

fn show_dictation_bubble(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("dictation") {
        let _ = window.show();
    }
}

fn hide_dictation_bubble_after(app: &AppHandle, delay: Duration) {
    let app = app.clone();
    let generation = BUBBLE_GENERATION.load(Ordering::SeqCst);
    thread::spawn(move || {
        thread::sleep(delay);
        if BUBBLE_GENERATION.load(Ordering::SeqCst) == generation {
            if let Some(window) = app.get_webview_window("dictation") {
                let _ = window.hide();
            }
        }
    });
}

fn worker_is_alive(handle: &WorkerHandle) -> bool {
    handle
        .join
        .as_ref()
        .map(|join| !join.is_finished())
        .unwrap_or(false)
}

/// Drop a worker whose thread has already exited (e.g. after idle teardown).
fn reap_finished(state: &SpeechState) {
    let mut guard = match state.worker.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let finished = guard.as_ref().map(|handle| !worker_is_alive(handle)).unwrap_or(false);
    if finished {
        if let Some(mut handle) = guard.take() {
            if let Some(join) = handle.join.take() {
                let _ = join.join();
            }
        }
    }
}

fn teardown_worker(state: &SpeechState) {
    let handle = state.worker.lock().ok().and_then(|mut slot| slot.take());
    if let Some(mut worker) = handle {
        let _ = worker.commands.send(WorkerCommand::Teardown);
        if let Some(join) = worker.join.take() {
            let _ = join.join();
        }
    }
}

/// Whether the cloud engine is still cooling down after a persistent failure.
fn cloud_paused(state: &SpeechState) -> bool {
    state
        .cloud_cooldown
        .lock()
        .map(|cooldown| cooldown.active(Instant::now()))
        .unwrap_or(false)
}

#[tauri::command]
pub fn speech_models() -> Result<Value, String> {
    serde_json::to_value(catalog()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn speech_model_status(app: AppHandle, model_id: String) -> Result<Value, String> {
    let manifest = get_catalog_model(&model_id)
        .ok_or_else(|| "unknown speech model".to_string())?
        .clone();
    let root = resolve_cache_root(&app);
    let directory = model_manager::model_directory(&root, &model_id);
    let ready = model_manager::model_is_ready(&directory, &manifest);
    Ok(json!({
        "modelId": model_id,
        "ready": ready,
        "sizeBytes": manifest.size_bytes,
    }))
}

/// Status-only view of the Codex login used for cloud dictation. No secrets.
#[tauri::command]
pub fn speech_cloud_status() -> Result<Value, String> {
    let status = auth_status();
    Ok(json!({
        "authState": status.state,
        "authMode": status.mode,
        "expiresAt": status.expires_at,
    }))
}

#[tauri::command]
pub async fn speech_model_download(app: AppHandle, model_id: String) -> Result<Value, String> {
    let manifest = get_catalog_model(&model_id)
        .ok_or_else(|| "unknown speech model".to_string())?
        .clone();
    let root = resolve_cache_root(&app);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;
    let emit_app = app.clone();
    let emit_id = manifest.id.clone();
    let directory = model_manager::ensure_model(&client, &root, &manifest, move |completed, total| {
        let _ = emit_app.emit(
            "bloblex-speech-download",
            json!({ "modelId": emit_id, "completed": completed, "total": total }),
        );
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(json!({ "modelId": model_id, "directory": directory.to_string_lossy() }))
}

#[tauri::command]
pub fn dictation_start(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
    owner: Option<String>,
    engine: Option<String>,
    cloud_consent: Option<bool>,
) -> Result<(), String> {
    let owner = parse_owner(owner)?;
    let preference = EnginePreference::parse(engine.as_deref().unwrap_or("local"));
    let consent = cloud_consent.unwrap_or(false);
    let manifest = get_catalog_model(&model_id).cloned();
    if manifest.is_none() && preference == EnginePreference::Local {
        return Err("unknown speech model".to_string());
    }
    let root = resolve_cache_root(&app);
    let directory = manifest
        .as_ref()
        .map(|_| model_manager::model_directory(&root, &model_id));
    let local_ready = match (manifest.as_ref(), directory.as_ref()) {
        (Some(manifest), Some(directory)) => model_manager::model_is_ready(directory, manifest),
        _ => false,
    };
    let resolved = resolve_engine(preference, consent, &auth_status(), local_ready, cloud_paused(&state));
    if let Some(code) = resolved.unavailable {
        return Err(if preference == EnginePreference::Local {
            "speech_model_not_ready".to_string()
        } else {
            code.to_string()
        });
    }
    let plan = SessionPlan {
        owner,
        engine: resolved.primary,
        has_local_fallback: resolved.fallback.is_some(),
        reason: resolved.reason,
    };

    {
        let mut lifecycle = state
            .lifecycle
            .lock()
            .map_err(|_| "speech state is unavailable".to_string())?;
        lifecycle
            .begin_start(owner, &model_id)
            .map_err(|error| error.to_string())?;
    }

    reap_finished(&state);

    // Reuse a warm worker for the same model, whoever used it last.
    let reusable = {
        let guard = state
            .worker
            .lock()
            .map_err(|_| "speech state is unavailable".to_string())?;
        guard.as_ref().and_then(|handle| {
            (handle.model_id == model_id && worker_is_alive(handle)).then(|| handle.commands.clone())
        })
    };
    if let Some(commands) = reusable {
        if commands.send(WorkerCommand::Start(plan)).is_ok() {
            if let Ok(mut lifecycle) = state.lifecycle.lock() {
                let _ = lifecycle.mark_active(owner);
            }
            return Ok(());
        }
    }

    teardown_worker(&state);
    spawn_worker(&app, &state, manifest, directory, model_id, Some(plan))?;
    if let Ok(mut lifecycle) = state.lifecycle.lock() {
        let _ = lifecycle.mark_active(owner);
    }
    Ok(())
}

/// Loads the model in the background so the first dictation starts at once.
/// Does nothing while a session runs, when the model is not downloaded, or
/// when a worker for the same model is already warm.
#[tauri::command]
pub fn dictation_warm(app: AppHandle, state: State<'_, SpeechState>, model_id: String) -> Result<bool, String> {
    let Some(manifest) = get_catalog_model(&model_id).cloned() else { return Ok(false) };
    let root = resolve_cache_root(&app);
    let directory = model_manager::model_directory(&root, &model_id);
    if !model_manager::model_is_ready(&directory, &manifest) {
        return Ok(false);
    }
    if state.lifecycle.lock().map(|lifecycle| lifecycle.phase_name() != "idle").unwrap_or(true) {
        return Ok(false);
    }
    reap_finished(&state);
    let warm = state
        .worker
        .lock()
        .map(|guard| guard.as_ref().is_some_and(|handle| handle.model_id == model_id && worker_is_alive(handle)))
        .unwrap_or(false);
    if warm {
        return Ok(true);
    }
    teardown_worker(&state);
    spawn_worker(&app, &state, Some(manifest), Some(directory), model_id, None)?;
    Ok(true)
}

/// Frees the model, for example when dictation is turned off.
#[tauri::command]
pub fn dictation_release(state: State<'_, SpeechState>) -> Result<(), String> {
    if state.lifecycle.lock().map(|lifecycle| lifecycle.phase_name() != "idle").unwrap_or(false) {
        return Ok(());
    }
    teardown_worker(&state);
    Ok(())
}

fn spawn_worker(
    app: &AppHandle,
    state: &SpeechState,
    manifest: Option<SpeechModelManifest>,
    directory: Option<PathBuf>,
    model_id: String,
    start: Option<SessionPlan>,
) -> Result<(), String> {
    let (commands, receiver) = std::sync::mpsc::channel::<WorkerCommand>();
    let capture_commands = commands.clone();
    let worker_app = app.clone();
    let lifecycle = Arc::clone(&state.lifecycle);
    let cooldown = Arc::clone(&state.cloud_cooldown);
    let join = thread::spawn(move || {
        run_worker(worker_app, manifest, directory, lifecycle, cooldown, receiver, capture_commands, start);
    });
    *state
        .worker
        .lock()
        .map_err(|_| "speech state is unavailable".to_string())? = Some(WorkerHandle {
        commands,
        join: Some(join),
        model_id,
    });
    Ok(())
}

/// Ends a session that could not run and tells the window why.
fn fail_session(app: &AppHandle, lifecycle: &Arc<Mutex<DictationLifecycle>>, owner: DictationOwner, message: &str) {
    emit(app, owner, "error", Some(message));
    if let Ok(mut lifecycle) = lifecycle.lock() {
        let _ = lifecycle.begin_stop(owner);
    }
    hide_dictation_bubble_after(app, BUBBLE_LINGER);
}

/// Load the on-device engine for the worker's model, if one is available.
fn load_local_engine(
    manifest: &Option<SpeechModelManifest>,
    directory: &Option<PathBuf>,
) -> Result<SpeechEngine, String> {
    match (manifest.as_ref(), directory.as_ref()) {
        (Some(manifest), Some(directory)) => {
            SpeechEngine::load(manifest, directory).map_err(|error| error.to_string())
        }
        _ => Err("speech_model_not_ready".to_string()),
    }
}

/// Transcribe 16 kHz mono samples through ChatGPT, blocking this worker thread.
fn transcribe_cloud(samples: &[f32]) -> Result<String, CloudError> {
    let transcriber = CloudTranscriber::new();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| CloudError::Unavailable)?;
    runtime.block_on(transcriber.transcribe_samples(samples, None))
}

/// Feed the buffered samples through the local engine after a cloud failure.
/// Returns true when the local engine produced output.
fn fallback_to_local(
    app: &AppHandle,
    owner: DictationOwner,
    engine: &mut Option<SpeechEngine>,
    manifest: &Option<SpeechModelManifest>,
    directory: &Option<PathBuf>,
    samples: &[f32],
) -> bool {
    if engine.is_none() {
        match load_local_engine(manifest, directory) {
            Ok(loaded) => *engine = Some(loaded),
            Err(_) => return false,
        }
    }
    let Some(local) = engine.as_mut() else {
        return false;
    };
    let resampled = resample_to_rate(samples, CLOUD_SAMPLE_RATE, local.sample_rate());
    for event in local.accept(&resampled) {
        emit_engine_event(app, owner, event);
    }
    for event in local.finish() {
        emit_engine_event(app, owner, event);
    }
    local.reset();
    true
}

fn run_worker(
    app: AppHandle,
    manifest: Option<SpeechModelManifest>,
    directory: Option<PathBuf>,
    lifecycle: Arc<Mutex<DictationLifecycle>>,
    cooldown: Arc<Mutex<CloudCooldown>>,
    receiver: Receiver<WorkerCommand>,
    capture_commands: Sender<WorkerCommand>,
    start: Option<SessionPlan>,
) {
    let mut engine: Option<SpeechEngine> = None;
    if start.is_none() {
        // Warm-up: load now. A failure is reported by the next real start.
        engine = load_local_engine(&manifest, &directory).ok();
    }
    let mut pending = start;
    let mut last_level = Instant::now();
    loop {
        let plan = match pending.take() {
            Some(plan) => plan,
            // Idle: wait for a session, dropping stray frames, then release the model.
            None => match receiver.recv_timeout(IDLE_WORKER_TEARDOWN) {
                Ok(WorkerCommand::Start(plan)) => plan,
                Ok(WorkerCommand::Teardown) | Err(_) => break,
                Ok(_) => continue,
            },
        };
        let owner = plan.owner;

        // Open the microphone before the model is ready: audio queues in the
        // channel while it loads, so the first words are never lost.
        let commands = capture_commands.clone();
        let capture = match start_capture(move |frame| {
            let _ = commands.send(WorkerCommand::Frame(frame));
        }) {
            Ok(capture) => capture,
            Err(error) => {
                fail_session(&app, &lifecycle, owner, &error.to_string());
                continue;
            }
        };
        let surface = if companion_visible(&app) { "companion" } else { "bubble" };
        let _ = app.emit(
            "bloblex-dictation-surface",
            json!({ "surface": surface, "owner": owner.as_str() }),
        );
        if surface == "bubble" {
            BUBBLE_GENERATION.fetch_add(1, Ordering::SeqCst);
            show_dictation_bubble(&app);
        }
        emit(&app, owner, "ready", None);
        emit_engine_choice(&app, owner, plan.engine, false, plan.reason);

        match plan.engine {
            ResolvedEngine::OnDevice => {
                if engine.is_none() {
                    emit(&app, owner, "loading", None);
                    match load_local_engine(&manifest, &directory) {
                        Ok(loaded) => {
                            engine = Some(loaded);
                            emit(&app, owner, "loaded", None);
                        }
                        Err(error) => {
                            capture.stop();
                            fail_session(&app, &lifecycle, owner, &error);
                            continue;
                        }
                    }
                }
                let Some(local) = engine.as_mut() else { continue };
                loop {
                    match receiver.recv() {
                        Ok(WorkerCommand::Frame(frame)) => {
                            let mono = downmix_to_mono(&frame.samples, frame.channels as usize);
                            let resampled = resample_to_rate(&mono, frame.sample_rate, local.sample_rate());
                            if last_level.elapsed() >= LEVEL_INTERVAL {
                                last_level = Instant::now();
                                let _ = app.emit(
                                    "bloblex-dictation-level",
                                    json!({ "level": rms_level(&resampled) }),
                                );
                            }
                            for event in local.accept(&resampled) {
                                emit_engine_event(&app, owner, event);
                            }
                        }
                        Ok(WorkerCommand::Stop) | Err(_) => {
                            capture.stop();
                            for event in local.finish() {
                                emit_engine_event(&app, owner, event);
                            }
                            emit(&app, owner, "stopped", None);
                            hide_dictation_bubble_after(&app, BUBBLE_LINGER);
                            local.reset();
                            break;
                        }
                        Ok(WorkerCommand::Teardown) => {
                            capture.stop();
                            let _ = local.finish();
                            emit(&app, owner, "stopped", None);
                            hide_dictation_bubble_after(&app, BUBBLE_LINGER);
                            return;
                        }
                        Ok(WorkerCommand::Start(_)) => {}
                    }
                }
            }
            ResolvedEngine::ChatGpt => {
                let mut buffer = AudioBuffer::new(MAX_BUFFER_SAMPLES);
                loop {
                    match receiver.recv() {
                        Ok(WorkerCommand::Frame(frame)) => {
                            let mono = downmix_to_mono(&frame.samples, frame.channels as usize);
                            let resampled = resample_to_rate(&mono, frame.sample_rate, CLOUD_SAMPLE_RATE);
                            if last_level.elapsed() >= LEVEL_INTERVAL {
                                last_level = Instant::now();
                                let _ = app.emit(
                                    "bloblex-dictation-level",
                                    json!({ "level": rms_level(&resampled) }),
                                );
                            }
                            if buffer.push(&resampled).is_err() {
                                capture.stop();
                                emit_error(
                                    &app,
                                    owner,
                                    &CloudError::TooLarge.user_message(),
                                    Some(CloudError::TooLarge.code()),
                                );
                                if let Ok(mut lifecycle) = lifecycle.lock() {
                                    let _ = lifecycle.begin_stop(owner);
                                }
                                hide_dictation_bubble_after(&app, BUBBLE_LINGER);
                                break;
                            }
                        }
                        Ok(WorkerCommand::Stop) | Err(_) => {
                            capture.stop();
                            emit(&app, owner, "processing", None);
                            let samples = buffer.samples().to_vec();
                            match transcribe_cloud(&samples) {
                                Ok(text) => {
                                    if let Ok(mut cooldown) = cooldown.lock() {
                                        cooldown.clear();
                                    }
                                    if !text.is_empty() {
                                        emit(&app, owner, "final", Some(&text));
                                    }
                                }
                                Err(error) => {
                                    if let Ok(mut cooldown) = cooldown.lock() {
                                        cooldown.record(Instant::now(), &error);
                                    }
                                    let recovered = plan.has_local_fallback
                                        && fallback_to_local(
                                            &app, owner, &mut engine, &manifest, &directory, &samples,
                                        );
                                    let events = cloud_failure_events(
                                        &error,
                                        plan.has_local_fallback,
                                        recovered,
                                    );
                                    if events.announce_fallback {
                                        emit_engine_choice(
                                            &app,
                                            owner,
                                            ResolvedEngine::ChatGpt,
                                            true,
                                            events.reason,
                                        );
                                    }
                                    if events.emit_error {
                                        emit_error(
                                            &app,
                                            owner,
                                            &cloud_failure_message(&error, plan.has_local_fallback),
                                            events.error_code,
                                        );
                                        if let Ok(mut lifecycle) = lifecycle.lock() {
                                            let _ = lifecycle.begin_stop(owner);
                                        }
                                    }
                                    if events.emit_stopped {
                                        emit(&app, owner, "stopped", None);
                                    }
                                    hide_dictation_bubble_after(&app, BUBBLE_LINGER);
                                    break;
                                }
                            }
                            emit(&app, owner, "stopped", None);
                            hide_dictation_bubble_after(&app, BUBBLE_LINGER);
                            break;
                        }
                        Ok(WorkerCommand::Teardown) => {
                            capture.stop();
                            emit(&app, owner, "stopped", None);
                            hide_dictation_bubble_after(&app, BUBBLE_LINGER);
                            return;
                        }
                        Ok(WorkerCommand::Start(_)) => {}
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn dictation_stop(
    app: AppHandle,
    state: State<'_, SpeechState>,
    owner: Option<String>,
) -> Result<(), String> {
    let owner = parse_owner(owner)?;
    let was_active = state
        .lifecycle
        .lock()
        .map(|lifecycle| lifecycle.active_owner() == Some(owner))
        .unwrap_or(false);
    {
        let mut lifecycle = state
            .lifecycle
            .lock()
            .map_err(|_| "speech state is unavailable".to_string())?;
        lifecycle
            .begin_stop(owner)
            .map_err(|error| error.to_string())?;
    }
    if was_active {
        emit(&app, owner, "processing", None);
        if let Ok(guard) = state.worker.lock() {
            if let Some(handle) = guard.as_ref() {
                let _ = handle.commands.send(WorkerCommand::Stop);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn dictation_cancel(state: State<'_, SpeechState>, owner: Option<String>) -> Result<(), String> {
    let owner = parse_owner(owner)?;
    let was_active = state
        .lifecycle
        .lock()
        .map(|lifecycle| lifecycle.active_owner() == Some(owner))
        .unwrap_or(false);
    if let Ok(mut lifecycle) = state.lifecycle.lock() {
        let _ = lifecycle.begin_stop(owner);
    }
    if was_active {
        if let Ok(guard) = state.worker.lock() {
            if let Some(handle) = guard.as_ref() {
                let _ = handle.commands.send(WorkerCommand::Stop);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn dictation_state(state: State<'_, SpeechState>) -> Result<Value, String> {
    reap_finished(&state);
    let lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "speech state is unavailable".to_string())?;
    let warm = state
        .worker
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|handle| (handle.model_id.clone(), worker_is_alive(handle))));
    Ok(json!({
        "phase": lifecycle.phase_name(),
        "owner": lifecycle.active_owner().map(DictationOwner::as_str),
        "modelId": lifecycle.active_model(),
        "warmModelId": warm.as_ref().map(|(id, _)| id.clone()),
        "warm": warm.map(|(_, alive)| alive).unwrap_or(false),
    }))
}

#[cfg(test)]
mod tests {
    use super::{cloud_failure_events, cloud_failure_message};
    use bloblex_speech::cloud::CloudError;

    #[test]
    fn cloud_failure_events_announce_only_a_used_fallback() {
        let error = CloudError::RateLimited;

        // Fallback exists and ran: announce it, no error, finish normally.
        let recovered = cloud_failure_events(&error, true, true);
        assert!(recovered.announce_fallback);
        assert_eq!(recovered.reason, Some("rate_limited"));
        assert!(!recovered.emit_error);
        assert_eq!(recovered.error_code, None);
        assert!(recovered.emit_stopped);

        // Fallback exists but failed: no announcement, error, no stopped.
        let failed = cloud_failure_events(&error, true, false);
        assert!(!failed.announce_fallback);
        assert_eq!(failed.reason, None);
        assert!(failed.emit_error);
        assert_eq!(failed.error_code, Some("both_engines_unavailable"));
        assert!(!failed.emit_stopped);

        // No fallback at all: error, no stopped, one clear code.
        let absent = cloud_failure_events(&error, false, false);
        assert!(!absent.announce_fallback);
        assert!(absent.emit_error);
        assert_eq!(absent.error_code, Some("both_engines_unavailable"));
        assert!(!absent.emit_stopped);
    }

    #[test]
    fn cloud_failure_copy_names_the_reason_not_the_body() {
        assert_eq!(
            cloud_failure_message(&CloudError::RateLimited, false),
            "ChatGPT transcription is unavailable (rate limited) and no on-device model is installed."
        );
        let error = CloudError::Rejected(400);
        let message = cloud_failure_message(&error, true);
        assert!(message.contains("rejected"));
        assert!(!message.contains("http"));
    }

    #[test]
    fn challenged_message_does_not_say_verification_required() {
        let message = cloud_failure_message(&CloudError::Challenged, false);
        assert!(!message.contains("verification"));
        assert!(message.contains("OpenAI"));
    }
}
