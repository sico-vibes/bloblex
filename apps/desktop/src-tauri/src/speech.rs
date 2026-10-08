//! Dictation command surface.
//!
//! Owns the audio capture thread and a decode worker. The worker is kept warm
//! across sessions (reused when the model and owner match) and tears itself
//! down after an idle period, mirroring Orca's session lifecycle. The pure
//! lifecycle lives in `bloblex_speech`; this module is the native shell.

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use bloblex_speech::capture::{start_capture, AudioFrame};
use bloblex_speech::{
    catalog, downmix_to_mono, get_catalog_model, model_manager, resample_to_rate,
    DictationLifecycle, DictationOwner, EngineEvent, SpeechEngine, SpeechModelManifest,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// How long a warm worker waits for the next session before releasing the model.
const IDLE_WORKER_TEARDOWN: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct SpeechState {
    lifecycle: Arc<Mutex<DictationLifecycle>>,
    worker: Mutex<Option<WorkerHandle>>,
}

struct WorkerHandle {
    commands: Sender<WorkerCommand>,
    join: Option<JoinHandle<()>>,
    model_id: String,
    owner: DictationOwner,
}

enum WorkerCommand {
    Start,
    Stop,
    Teardown,
    Frame(AudioFrame),
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

fn emit_engine_event(app: &AppHandle, owner: DictationOwner, event: EngineEvent) {
    match event {
        EngineEvent::Partial(text) => emit(app, owner, "partial", Some(&text)),
        EngineEvent::Final(text) => emit(app, owner, "final", Some(&text)),
    }
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
) -> Result<(), String> {
    let owner = parse_owner(owner)?;
    let manifest = get_catalog_model(&model_id)
        .ok_or_else(|| "unknown speech model".to_string())?
        .clone();
    let root = resolve_cache_root(&app);
    let directory = model_manager::model_directory(&root, &model_id);
    if !model_manager::model_is_ready(&directory, &manifest) {
        return Err("speech_model_not_ready".to_string());
    }

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

    // Reuse a warm worker when the model and owner match.
    let reusable = {
        let guard = state
            .worker
            .lock()
            .map_err(|_| "speech state is unavailable".to_string())?;
        guard.as_ref().and_then(|handle| {
            if handle.model_id == model_id && handle.owner == owner && worker_is_alive(handle) {
                Some(handle.commands.clone())
            } else {
                None
            }
        })
    };
    if let Some(commands) = reusable {
        if commands.send(WorkerCommand::Start).is_ok() {
            if let Ok(mut lifecycle) = state.lifecycle.lock() {
                let _ = lifecycle.mark_active(owner);
            }
            return Ok(());
        }
    }

    teardown_worker(&state);

    let (commands, receiver) = std::sync::mpsc::channel::<WorkerCommand>();
    let capture_commands = commands.clone();
    let worker_app = app.clone();
    let lifecycle = Arc::clone(&state.lifecycle);
    let worker_model = model_id.clone();
    let join = thread::spawn(move || {
        run_worker(
            worker_app,
            manifest,
            directory,
            owner,
            lifecycle,
            receiver,
            capture_commands,
        );
    });

    if let Ok(mut lifecycle) = state.lifecycle.lock() {
        let _ = lifecycle.mark_active(owner);
    }
    *state
        .worker
        .lock()
        .map_err(|_| "speech state is unavailable".to_string())? = Some(WorkerHandle {
        commands,
        join: Some(join),
        model_id: worker_model,
        owner,
    });
    Ok(())
}

fn run_worker(
    app: AppHandle,
    manifest: SpeechModelManifest,
    directory: PathBuf,
    owner: DictationOwner,
    lifecycle: Arc<Mutex<DictationLifecycle>>,
    receiver: Receiver<WorkerCommand>,
    capture_commands: Sender<WorkerCommand>,
) {
    let mut engine = match SpeechEngine::load(&manifest, &directory) {
        Ok(engine) => engine,
        Err(error) => {
            emit(&app, owner, "error", Some(&error.to_string()));
            if let Ok(mut lifecycle) = lifecycle.lock() {
                lifecycle.cancel_start(owner);
            }
            return;
        }
    };

    let mut start_pending = false;
    loop {
        if !std::mem::replace(&mut start_pending, false) {
            match receiver.recv() {
                Ok(WorkerCommand::Start) => {}
                Ok(WorkerCommand::Teardown) | Err(_) => break,
                Ok(_) => continue,
            }
        }

        let commands = capture_commands.clone();
        match start_capture(move |frame| {
            let _ = commands.send(WorkerCommand::Frame(frame));
        }) {
            Ok(capture) => {
                emit(&app, owner, "ready", None);
                loop {
                    match receiver.recv() {
                        Ok(WorkerCommand::Frame(frame)) => {
                            let mono = downmix_to_mono(&frame.samples, frame.channels as usize);
                            let resampled = resample_to_rate(&mono, frame.sample_rate, engine.sample_rate());
                            for event in engine.accept(&resampled) {
                                emit_engine_event(&app, owner, event);
                            }
                        }
                        Ok(WorkerCommand::Stop) | Err(_) => {
                            capture.stop();
                            for event in engine.finish() {
                                emit_engine_event(&app, owner, event);
                            }
                            emit(&app, owner, "stopped", None);
                            engine.reset();
                            break;
                        }
                        Ok(WorkerCommand::Teardown) => {
                            capture.stop();
                            let _ = engine.finish();
                            emit(&app, owner, "stopped", None);
                            return;
                        }
                        Ok(WorkerCommand::Start) => {}
                    }
                }
            }
            Err(error) => {
                emit(&app, owner, "error", Some(&error.to_string()));
                if let Ok(mut lifecycle) = lifecycle.lock() {
                    lifecycle.cancel_start(owner);
                }
            }
        }

        // Idle: wait for a new session before releasing the model.
        let mut restart = false;
        loop {
            match receiver.recv_timeout(IDLE_WORKER_TEARDOWN) {
                Ok(WorkerCommand::Start) => {
                    restart = true;
                    break;
                }
                Ok(WorkerCommand::Teardown) | Err(_) => break,
                Ok(_) => continue,
            }
        }
        if !restart {
            break;
        }
        start_pending = true;
    }
}

#[tauri::command]
pub fn dictation_stop(state: State<'_, SpeechState>, owner: Option<String>) -> Result<(), String> {
    let owner = parse_owner(owner)?;
    {
        let mut lifecycle = state
            .lifecycle
            .lock()
            .map_err(|_| "speech state is unavailable".to_string())?;
        lifecycle
            .begin_stop(owner)
            .map_err(|error| error.to_string())?;
    }
    if let Ok(guard) = state.worker.lock() {
        if let Some(handle) = guard.as_ref() {
            if handle.owner == owner {
                let _ = handle.commands.send(WorkerCommand::Stop);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn dictation_cancel(state: State<'_, SpeechState>, owner: Option<String>) -> Result<(), String> {
    let owner = parse_owner(owner)?;
    if let Ok(mut lifecycle) = state.lifecycle.lock() {
        lifecycle.cancel_start(owner);
    }
    if let Ok(guard) = state.worker.lock() {
        if let Some(handle) = guard.as_ref() {
            if handle.owner == owner {
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
