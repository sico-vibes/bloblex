use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{async_runtime::JoinHandle, AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};
use url::Url;

use crate::{connection, rpc_call, AppState};

const CHANNEL_KEY: &str = "updates.channel";
const AUTO_CHECK_KEY: &str = "updates.autoCheck";
const LAST_CHECKED_KEY: &str = "updates.lastCheckedAt";
const STABLE_ENDPOINT: &str =
    "https://github.com/sico-vibes/bloblex/releases/latest/download/latest.json";
const BETA_ENDPOINT: &str =
    "https://github.com/sico-vibes/bloblex/releases/download/channel-beta/latest.json";

/// Tauri rejects `.` in event names, so the phase channel is `updates-state`.
const STATE_EVENT: &str = "updates-state";
const AVAILABLE_EVENT: &str = "bloblex-update-available";
const PROGRESS_EVENT: &str = "bloblex-update-progress";

/// First background check after start, then the schedule below.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    #[default]
    Beta,
}

impl UpdateChannel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Self::Stable => STABLE_ENDPOINT,
            Self::Beta => BETA_ENDPOINT,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
    channel: UpdateChannel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Downloading,
    Ready,
    Installing,
    Error,
}

/// The updater phase the UI subscribes to. Every field except `phase` is
/// omitted when absent, and `message` is always one of the fixed sentences in
/// [`install_message`] — never raw error text.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStateEvent {
    phase: UpdatePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl Default for UpdateStateEvent {
    fn default() -> Self {
        Self {
            phase: UpdatePhase::Idle,
            version: None,
            downloaded_bytes: None,
            total_bytes: None,
            message: None,
        }
    }
}

impl UpdateStateEvent {
    fn idle() -> Self {
        Self::default()
    }

    fn checking() -> Self {
        Self {
            phase: UpdatePhase::Checking,
            ..Self::default()
        }
    }

    fn downloading(version: &str, downloaded: u64, total: Option<u64>) -> Self {
        Self {
            phase: UpdatePhase::Downloading,
            version: Some(version.to_owned()),
            downloaded_bytes: Some(downloaded),
            total_bytes: total,
            message: None,
        }
    }

    fn ready(version: &str) -> Self {
        Self {
            phase: UpdatePhase::Ready,
            version: Some(version.to_owned()),
            ..Self::default()
        }
    }

    fn installing(version: Option<String>) -> Self {
        Self {
            phase: UpdatePhase::Installing,
            version,
            ..Self::default()
        }
    }

    fn error(message: &str) -> Self {
        Self {
            phase: UpdatePhase::Error,
            message: Some(message.to_owned()),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStateDto {
    current_version: String,
    channel: UpdateChannel,
    auto_check: bool,
    last_checked_at: Option<String>,
    available: Option<UpdateInfo>,
    dev_build: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    update: Option<UpdateInfo>,
    checked_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
pub struct InstallError {
    code: &'static str,
    message: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CheckFailure {
    Network,
    Signature,
    Manifest,
    Unavailable,
    NoStableRelease,
}

impl CheckFailure {
    fn code(&self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Signature => "signature",
            Self::Manifest => "manifest",
            Self::Unavailable => "unavailable",
            Self::NoStableRelease => "unavailable",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Preferences {
    channel: UpdateChannel,
    auto_check: bool,
    last_checked_at: Option<String>,
}

pub(crate) type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;
type EmitFn = Arc<Mutex<dyn FnMut(UpdateStateEvent) + Send + 'static>>;
type ProgressFn = Arc<Mutex<dyn FnMut(u64, Option<u64>) + Send + 'static>>;
/// One background check: resolves to the offered update, if any.
type CheckHook = Box<dyn FnOnce() -> BoxFuture<Result<Option<Box<dyn UpdateSource>>, CheckFailure>> + Send>;

/// Publishes phase changes to the shared state and to the UI event at once.
#[derive(Clone)]
pub(crate) struct PhaseSink {
    state: Arc<Mutex<UpdateStateEvent>>,
    emit: EmitFn,
}

impl PhaseSink {
    pub(crate) fn publish(&self, event: UpdateStateEvent) {
        if let Ok(mut current) = self.state.lock() {
            *current = event.clone();
        }
        if let Ok(mut sink) = self.emit.lock() {
            sink(event);
        }
    }

    fn progress(&self, version: String) -> ProgressFn {
        let sink = self.clone();
        Arc::new(Mutex::new(move |downloaded, total| {
            sink.publish(UpdateStateEvent::downloading(&version, downloaded, total));
        }))
    }
}

/// One offered update: its metadata, how to fetch it and how to install it.
/// The real implementation wraps the plugin's `Update`; tests substitute a fake.
pub(crate) trait UpdateSource: Send {
    fn info(&self) -> &UpdateInfo;
    fn download(&self, progress: ProgressFn) -> BoxFuture<Result<Vec<u8>, CheckFailure>>;
    fn install(&self, bytes: Vec<u8>) -> BoxFuture<Result<(), CheckFailure>>;
}

struct PluginUpdate {
    update: Update,
    info: UpdateInfo,
}

impl UpdateSource for PluginUpdate {
    fn info(&self) -> &UpdateInfo {
        &self.info
    }

    fn download(&self, progress: ProgressFn) -> BoxFuture<Result<Vec<u8>, CheckFailure>> {
        let update = self.update.clone();
        Box::pin(async move {
            let counter = Arc::new(AtomicU64::new(0));
            update
                .download(
                    move |chunk, total| {
                        let done = counter.fetch_add(chunk as u64, Ordering::SeqCst) + chunk as u64;
                        if let Ok(mut report) = progress.lock() {
                            report(done, total);
                        }
                    },
                    || {},
                )
                .await
                .map_err(|error| map_updater_error(&error))
        })
    }

    fn install(&self, bytes: Vec<u8>) -> BoxFuture<Result<(), CheckFailure>> {
        let update = self.update.clone();
        Box::pin(async move {
            match tauri::async_runtime::spawn_blocking(move || update.install(&bytes)).await {
                Ok(Ok(())) => Ok(()),
                Ok(Err(error)) => Err(map_updater_error(&error)),
                Err(_) => Err(CheckFailure::Unavailable),
            }
        })
    }
}

struct StagedUpdate {
    source: Box<dyn UpdateSource>,
    info: UpdateInfo,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct UpdateService {
    state: Arc<Mutex<UpdateStateEvent>>,
    available: Mutex<Option<UpdateInfo>>,
    staged: Mutex<Option<StagedUpdate>>,
    checker: Mutex<Option<JoinHandle<()>>>,
}

impl UpdateService {
    fn phase(&self, emit: EmitFn) -> PhaseSink {
        PhaseSink {
            state: Arc::clone(&self.state),
            emit,
        }
    }

    fn snapshot(&self) -> UpdateStateEvent {
        self.state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default()
    }

    fn set_available(&self, info: Option<UpdateInfo>) {
        if let Ok(mut available) = self.available.lock() {
            *available = info;
        }
    }

    fn stage(&self, staged: StagedUpdate) {
        if let Ok(mut slot) = self.staged.lock() {
            *slot = Some(staged);
        }
    }

    fn has_staged(&self) -> bool {
        self.staged.lock().map(|slot| slot.is_some()).unwrap_or(false)
    }

    fn take_staged(&self) -> Option<StagedUpdate> {
        self.staged.lock().ok()?.take()
    }
}

#[derive(Debug)]
pub(crate) enum CycleOutcome {
    UpToDate,
    Ready { info: UpdateInfo },
    Failed { code: &'static str, message: &'static str },
}

fn parse_channel(value: Option<&Value>) -> Result<UpdateChannel, &'static str> {
    match value.and_then(Value::as_str) {
        None => Ok(UpdateChannel::default()),
        Some("stable") => Ok(UpdateChannel::Stable),
        Some("beta") => Ok(UpdateChannel::Beta),
        Some(_) => Err("invalid_argument"),
    }
}

fn is_newer_version(current: &semver::Version, offered: &semver::Version) -> bool {
    offered > current
}

fn map_updater_error(error: &UpdaterError) -> CheckFailure {
    match error {
        UpdaterError::Minisign(_) | UpdaterError::Base64(_) | UpdaterError::SignatureUtf8(_) => {
            CheckFailure::Signature
        }
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) | UpdaterError::Io(_) => {
            CheckFailure::Network
        }
        UpdaterError::EmptyEndpoints
        | UpdaterError::UnsupportedArch
        | UpdaterError::UnsupportedOs
        | UpdaterError::FailedToDetermineExtractPath
        | UpdaterError::TargetNotFound(_)
        | UpdaterError::TargetsNotFound(_)
        | UpdaterError::AuthenticationFailed
        | UpdaterError::DebInstallFailed
        | UpdaterError::PackageInstallFailed
        | UpdaterError::InvalidUpdaterFormat
        | UpdaterError::TempDirNotFound
        | UpdaterError::TempDirNotOnSameMountPoint => CheckFailure::Unavailable,
        _ => CheckFailure::Manifest,
    }
}

fn update_info(update: &Update, channel: UpdateChannel) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
        pub_date: update.date.map(|date| date.to_string()),
        channel,
    }
}

async fn read_preferences(app: &AppHandle) -> Result<Preferences, String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "The local Bitbots daemon is unavailable.".to_string())?;
    let conn = connection(&state)?;
    let settings = rpc_call(&conn, "settings.get", json!({})).await?;
    let settings = settings.get("settings").unwrap_or(&settings);
    let channel = parse_channel(settings.get(CHANNEL_KEY))
        .map_err(|_| "The saved update channel is invalid.".to_string())?;
    Ok(Preferences {
        channel,
        auto_check: settings
            .get(AUTO_CHECK_KEY)
            .and_then(Value::as_bool)
            .unwrap_or(true),
        last_checked_at: settings
            .get(LAST_CHECKED_KEY)
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

async fn save_setting(app: &AppHandle, key: &str, value: Value) -> Result<(), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "The local Bitbots daemon is unavailable.".to_string())?;
    let conn = connection(&state)?;
    rpc_call(&conn, "settings.set", json!({"key":key,"value":value})).await?;
    Ok(())
}

async fn probe_manifest(channel: UpdateChannel) -> Result<(), CheckFailure> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| CheckFailure::Unavailable)?;
    let response = client
        .get(channel.endpoint())
        .send()
        .await
        .map_err(|_| CheckFailure::Network)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return if channel == UpdateChannel::Stable {
            Err(CheckFailure::NoStableRelease)
        } else {
            Err(CheckFailure::Manifest)
        };
    }
    if response.status().is_success() || response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(());
    }
    if response.status().is_server_error() {
        return Err(CheckFailure::Network);
    }
    Err(CheckFailure::Manifest)
}

async fn perform_check(
    app: &AppHandle,
    channel: UpdateChannel,
) -> Result<Option<Update>, CheckFailure> {
    probe_manifest(channel).await?;
    let endpoint = Url::parse(channel.endpoint()).map_err(|_| CheckFailure::Unavailable)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| map_updater_error(&error))?
        .version_comparator(|current, release| is_newer_version(&current, &release.version))
        .configure_client(|client| client.timeout(Duration::from_secs(45)))
        .build()
        .map_err(|error| map_updater_error(&error))?;
    updater
        .check()
        .await
        .map_err(|error| map_updater_error(&error))
}

async fn persist_check_time(app: &AppHandle, checked_at: &str) {
    let _ = save_setting(app, LAST_CHECKED_KEY, Value::String(checked_at.to_owned())).await;
}

fn app_emitter(app: &AppHandle) -> EmitFn {
    let app = app.clone();
    Arc::new(Mutex::new(move |event: UpdateStateEvent| {
        let _ = app.emit(STATE_EVENT, &event);
        if event.phase == UpdatePhase::Downloading {
            let _ = app.emit(
                PROGRESS_EVENT,
                json!({
                    "phase": "downloading",
                    "downloadedBytes": event.downloaded_bytes.unwrap_or(0),
                    "totalBytes": event.total_bytes,
                }),
            );
        }
    }))
}

fn plugin_check(app: &AppHandle, channel: UpdateChannel) -> CheckHook {
    let app = app.clone();
    Box::new(move || {
        Box::pin(async move {
            match perform_check(&app, channel).await? {
                Some(update) => {
                    let info = update_info(&update, channel);
                    Ok(Some(
                        Box::new(PluginUpdate { update, info }) as Box<dyn UpdateSource>
                    ))
                }
                None => Ok(None),
            }
        })
    })
}

/// Drives one full background cycle: check, then download in the background.
/// It never installs — installing only happens from `updates_install`.
pub(crate) async fn run_background_cycle<C>(
    check: C,
    sink: &PhaseSink,
    service: &UpdateService,
) -> CycleOutcome
where
    C: FnOnce() -> BoxFuture<Result<Option<Box<dyn UpdateSource>>, CheckFailure>>,
{
    sink.publish(UpdateStateEvent::checking());
    let source = match check().await {
        Ok(Some(source)) => source,
        Ok(None) | Err(CheckFailure::NoStableRelease) => {
            sink.publish(UpdateStateEvent::idle());
            return CycleOutcome::UpToDate;
        }
        Err(failure) => {
            let message = install_message(failure.code());
            sink.publish(UpdateStateEvent::error(message));
            return CycleOutcome::Failed {
                code: failure.code(),
                message,
            };
        }
    };
    download_source(source, sink, service).await
}

async fn download_source(
    source: Box<dyn UpdateSource>,
    sink: &PhaseSink,
    service: &UpdateService,
) -> CycleOutcome {
    let info = source.info().clone();
    sink.publish(UpdateStateEvent::downloading(&info.version, 0, None));
    let progress = sink.progress(info.version.clone());
    match source.download(progress).await {
        Ok(bytes) => {
            service.stage(StagedUpdate {
                source,
                info: info.clone(),
                bytes,
            });
            sink.publish(UpdateStateEvent::ready(&info.version));
            CycleOutcome::Ready { info }
        }
        Err(failure) => {
            let message = install_message(failure.code());
            sink.publish(UpdateStateEvent::error(message));
            CycleOutcome::Failed {
                code: failure.code(),
                message,
            }
        }
    }
}

/// Installs the staged bytes. Without a staged update there is nothing to do.
pub(crate) async fn install_staged(
    sink: &PhaseSink,
    service: &UpdateService,
) -> Result<(), &'static str> {
    let Some(staged) = service.take_staged() else {
        return Err("no_update");
    };
    let StagedUpdate { source, info, bytes } = staged;
    sink.publish(UpdateStateEvent::installing(Some(info.version)));
    match source.install(bytes).await {
        Ok(()) => Ok(()),
        Err(failure) => {
            sink.publish(UpdateStateEvent::error(install_message(failure.code())));
            Err(failure.code())
        }
    }
}

/// One scheduler tick: run the check only when automatic checks are on and the
/// preferences were read. Returns the check's output, or `None` when skipped.
pub(crate) async fn scheduler_tick<C, F, O>(
    preferences: &Result<Preferences, String>,
    check: F,
) -> Option<O>
where
    F: FnOnce(UpdateChannel) -> C,
    C: Future<Output = O>,
{
    match preferences {
        Ok(preferences) if preferences.auto_check => Some(check(preferences.channel).await),
        _ => None,
    }
}

async fn run_cycle(app: &AppHandle, channel: UpdateChannel) -> CycleOutcome {
    let Some(service) = app.try_state::<UpdateService>() else {
        return CycleOutcome::Failed {
            code: "unavailable",
            message: install_message("unavailable"),
        };
    };
    let sink = service.phase(app_emitter(app));
    let check = plugin_check(app, channel);
    let outcome = run_background_cycle(check, &sink, &service).await;
    apply_outcome(app, &service, &outcome);
    outcome
}

fn apply_outcome(app: &AppHandle, service: &UpdateService, outcome: &CycleOutcome) {
    match outcome {
        CycleOutcome::Ready { info } => {
            service.set_available(Some(info.clone()));
            let _ = app.emit(AVAILABLE_EVENT, info);
        }
        CycleOutcome::UpToDate => service.set_available(None),
        CycleOutcome::Failed { .. } => {}
    }
}

fn spawn_download(app: &AppHandle, source: Box<dyn UpdateSource>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(service) = app.try_state::<UpdateService>() else {
            return;
        };
        let sink = service.phase(app_emitter(&app));
        let outcome = download_source(source, &sink, &service).await;
        apply_outcome(&app, &service, &outcome);
    });
}

#[tauri::command(rename_all = "camelCase")]
pub async fn updates_get_state(app: AppHandle) -> Result<UpdateStateDto, String> {
    let preferences = read_preferences(&app).await?;
    let available = app
        .try_state::<UpdateService>()
        .and_then(|service| service.available.lock().ok()?.clone());
    Ok(UpdateStateDto {
        current_version: app.package_info().version.to_string(),
        channel: preferences.channel,
        auto_check: preferences.auto_check,
        last_checked_at: preferences.last_checked_at,
        available,
        dev_build: cfg!(debug_assertions),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn updates_phase(app: AppHandle) -> UpdateStateEvent {
    app.try_state::<UpdateService>()
        .map(|service| service.snapshot())
        .unwrap_or_default()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn updates_set_preferences(
    app: AppHandle,
    channel: Option<String>,
    auto_check: Option<bool>,
) -> Result<UpdateStateDto, String> {
    let current = read_preferences(&app).await?;
    if let Some(channel) = channel {
        let parsed = parse_channel(Some(&Value::String(channel)))
            .map_err(|_| "invalid_argument".to_string())?;
        if parsed != current.channel {
            save_setting(&app, CHANNEL_KEY, Value::String(parsed.as_str().to_owned())).await?;
            if let Some(service) = app.try_state::<UpdateService>() {
                if let Ok(mut staged) = service.staged.lock() {
                    *staged = None;
                }
                service.phase(app_emitter(&app)).publish(UpdateStateEvent::idle());
            }
        }
    }
    if let Some(auto_check) = auto_check {
        save_setting(&app, AUTO_CHECK_KEY, Value::Bool(auto_check)).await?;
    }
    updates_get_state(app).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn updates_check(app: AppHandle) -> CheckResult {
    if cfg!(debug_assertions) {
        return CheckResult {
            status: "error",
            update: None,
            checked_at: Utc::now().to_rfc3339(),
            error: Some("unavailable"),
        };
    }
    let preferences = match read_preferences(&app).await {
        Ok(preferences) => preferences,
        Err(_) => {
            return CheckResult {
                status: "error",
                update: None,
                checked_at: Utc::now().to_rfc3339(),
                error: Some("unavailable"),
            };
        }
    };
    let checked_at = Utc::now().to_rfc3339();
    persist_check_time(&app, &checked_at).await;
    let Some(service) = app.try_state::<UpdateService>() else {
        return CheckResult {
            status: "error",
            update: None,
            checked_at,
            error: Some("unavailable"),
        };
    };
    let sink = service.phase(app_emitter(&app));
    match perform_check(&app, preferences.channel).await {
        Ok(Some(update)) => {
            let info = update_info(&update, preferences.channel);
            service.set_available(Some(info.clone()));
            spawn_download(
                &app,
                Box::new(PluginUpdate {
                    update,
                    info: info.clone(),
                }),
            );
            CheckResult {
                status: "available",
                update: Some(info),
                checked_at,
                error: None,
            }
        }
        Ok(None) => {
            service.set_available(None);
            sink.publish(UpdateStateEvent::idle());
            CheckResult {
                status: "up_to_date",
                update: None,
                checked_at,
                error: None,
            }
        }
        Err(CheckFailure::NoStableRelease) => {
            sink.publish(UpdateStateEvent::idle());
            CheckResult {
                status: "no_stable_release",
                update: None,
                checked_at,
                error: None,
            }
        }
        Err(failure) => {
            sink.publish(UpdateStateEvent::error(install_message(failure.code())));
            CheckResult {
                status: "error",
                update: None,
                checked_at,
                error: Some(failure.code()),
            }
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn updates_install(app: AppHandle) -> Result<(), InstallError> {
    if cfg!(debug_assertions) {
        return Err(InstallError {
            code: "unavailable",
            message: "Updates unavailable in development builds.",
        });
    }
    let Some(service) = app.try_state::<UpdateService>() else {
        return Err(InstallError {
            code: "unavailable",
            message: "The update service is unavailable.",
        });
    };
    let sink = service.phase(app_emitter(&app));

    if !service.has_staged() {
        let preferences = match read_preferences(&app).await {
            Ok(preferences) => preferences,
            Err(_) => {
                return Err(InstallError {
                    code: "unavailable",
                    message: install_message("unavailable"),
                });
            }
        };
        let check = plugin_check(&app, preferences.channel);
        match run_background_cycle(check, &sink, &service).await {
            CycleOutcome::Ready { info } => service.set_available(Some(info)),
            CycleOutcome::UpToDate => {
                return Err(InstallError {
                    code: "no_update",
                    message: install_message("no_update"),
                });
            }
            CycleOutcome::Failed { code, message } => {
                return Err(InstallError { code, message });
            }
        }
    }

    match install_staged(&sink, &service).await {
        Ok(()) => Ok(()),
        Err(code) => Err(InstallError {
            code,
            message: install_message(code),
        }),
    }
}

fn install_message(code: &str) -> &'static str {
    match code {
        "network" => "The update could not be downloaded.",
        "signature" => "The update signature could not be verified.",
        "manifest" => "The update information is invalid.",
        "unavailable" => "Updates are currently unavailable.",
        "no_update" => "There is no update ready to install.",
        _ => "The update could not be installed.",
    }
}

pub fn start_background_checker(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Some(service) = app.try_state::<UpdateService>() else {
        return;
    };
    let app_handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let preferences = read_preferences(&app_handle).await;
            let _ = scheduler_tick(&preferences, |channel| run_cycle(&app_handle, channel)).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
    if let Ok(mut checker) = service.checker.lock() {
        *checker = Some(task);
    };
}

pub fn stop_background_checker(app: &AppHandle) {
    if let Some(service) = app.try_state::<UpdateService>() {
        if let Ok(mut checker) = service.checker.lock() {
            if let Some(task) = checker.take() {
                task.abort();
            }
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn offer(version: &str) -> UpdateInfo {
        UpdateInfo {
            version: version.to_owned(),
            notes: None,
            pub_date: None,
            channel: UpdateChannel::Beta,
        }
    }

    fn preferences(auto_check: bool, channel: UpdateChannel) -> Preferences {
        Preferences {
            channel,
            auto_check,
            last_checked_at: None,
        }
    }

    struct FakeSource {
        info: UpdateInfo,
        download: Result<Vec<u8>, CheckFailure>,
        installs: Arc<AtomicUsize>,
        install_result: Result<(), CheckFailure>,
    }

    impl FakeSource {
        fn new(version: &str, download: Result<Vec<u8>, CheckFailure>) -> (Self, Arc<AtomicUsize>) {
            let installs = Arc::new(AtomicUsize::new(0));
            (
                Self {
                    info: offer(version),
                    download,
                    installs: Arc::clone(&installs),
                    install_result: Ok(()),
                },
                installs,
            )
        }
    }

    impl UpdateSource for FakeSource {
        fn info(&self) -> &UpdateInfo {
            &self.info
        }

        fn download(&self, progress: ProgressFn) -> BoxFuture<Result<Vec<u8>, CheckFailure>> {
            let result = self.download.clone();
            Box::pin(async move {
                if let Ok(bytes) = &result {
                    if let Ok(mut report) = progress.lock() {
                        report(bytes.len() as u64, Some(bytes.len() as u64));
                    }
                }
                result
            })
        }

        fn install(&self, _bytes: Vec<u8>) -> BoxFuture<Result<(), CheckFailure>> {
            let installs = Arc::clone(&self.installs);
            let result = self.install_result;
            Box::pin(async move {
                installs.fetch_add(1, Ordering::SeqCst);
                result
            })
        }
    }

    fn check_with(
        source: FakeSource,
    ) -> impl FnOnce() -> BoxFuture<Result<Option<Box<dyn UpdateSource>>, CheckFailure>> {
        move || {
            Box::pin(async move { Ok(Some(Box::new(source) as Box<dyn UpdateSource>)) })
        }
    }

    fn harness() -> (
        PhaseSink,
        Arc<Mutex<Vec<UpdateStateEvent>>>,
        UpdateService,
    ) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let emit: EmitFn = {
            let seen = Arc::clone(&seen);
            Arc::new(Mutex::new(move |event: UpdateStateEvent| {
                if let Ok(mut log) = seen.lock() {
                    log.push(event);
                }
            }))
        };
        let service = UpdateService::default();
        let sink = service.phase(emit);
        (sink, seen, service)
    }

    #[test]
    fn parses_only_supported_channels_and_defaults_to_beta() {
        assert_eq!(parse_channel(None), Ok(UpdateChannel::Beta));
        assert_eq!(
            parse_channel(Some(&json!("stable"))),
            Ok(UpdateChannel::Stable)
        );
        assert_eq!(parse_channel(Some(&json!("beta"))), Ok(UpdateChannel::Beta));
        assert_eq!(
            parse_channel(Some(&json!("nightly"))),
            Err("invalid_argument")
        );
    }

    #[test]
    fn channel_urls_match_the_release_contract() {
        assert_eq!(UpdateChannel::Stable.endpoint(), STABLE_ENDPOINT);
        assert_eq!(UpdateChannel::Beta.endpoint(), BETA_ENDPOINT);
    }

    #[test]
    fn semver_rejects_equal_and_older_offers() {
        let current = semver::Version::parse("0.1.0-beta.1").unwrap();
        assert!(is_newer_version(
            &current,
            &semver::Version::parse("0.1.0-beta.2").unwrap()
        ));
        assert!(is_newer_version(
            &current,
            &semver::Version::parse("0.1.0").unwrap()
        ));
        assert!(!is_newer_version(
            &current,
            &semver::Version::parse("0.1.0-beta.1").unwrap()
        ));
        assert!(!is_newer_version(
            &current,
            &semver::Version::parse("0.1.0-alpha.9").unwrap()
        ));
    }

    #[test]
    fn errors_map_to_fixed_safe_categories() {
        let signature = UpdaterError::SignatureUtf8("invalid signature".to_owned());
        let manifest = UpdaterError::ReleaseNotFound;
        let unavailable = UpdaterError::UnsupportedArch;
        assert_eq!(map_updater_error(&signature), CheckFailure::Signature);
        assert_eq!(map_updater_error(&manifest), CheckFailure::Manifest);
        assert_eq!(map_updater_error(&unavailable), CheckFailure::Unavailable);
        assert_eq!(
            install_message("no_update"),
            "There is no update ready to install."
        );
    }

    #[test]
    fn phase_events_serialise_with_camel_case_and_no_absent_fields() {
        let idle = serde_json::to_value(UpdateStateEvent::idle()).unwrap();
        assert_eq!(idle, json!({ "phase": "idle" }));

        let downloading = serde_json::to_value(UpdateStateEvent::downloading(
            "0.1.0-beta.32",
            512,
            Some(2048),
        ))
        .unwrap();
        assert_eq!(
            downloading,
            json!({
                "phase": "downloading",
                "version": "0.1.0-beta.32",
                "downloadedBytes": 512,
                "totalBytes": 2048,
            })
        );
    }

    #[test]
    fn a_newer_version_moves_checking_downloading_ready_without_installing() {
        let (sink, seen, service) = harness();
        let (source, installs) = FakeSource::new("0.1.0-beta.32", Ok(vec![1, 2, 3, 4]));
        let outcome = tauri::async_runtime::block_on(run_background_cycle(
            check_with(source),
            &sink,
            &service,
        ));

        assert!(matches!(outcome, CycleOutcome::Ready { .. }));
        let phases: Vec<UpdatePhase> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.phase)
            .collect();
        assert_eq!(phases.first(), Some(&UpdatePhase::Checking));
        assert!(phases.contains(&UpdatePhase::Downloading));
        assert_eq!(phases.last(), Some(&UpdatePhase::Ready));
        assert!(!phases.contains(&UpdatePhase::Installing));
        assert_eq!(service.snapshot().phase, UpdatePhase::Ready);
        assert!(service.has_staged());
        // The background cycle never installs: only the explicit command does.
        assert_eq!(installs.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn installing_uses_the_staged_bytes_only_when_the_command_runs() {
        let (sink, _seen, service) = harness();
        let (source, installs) = FakeSource::new("0.1.0-beta.32", Ok(vec![9, 9, 9]));
        tauri::async_runtime::block_on(run_background_cycle(check_with(source), &sink, &service));
        assert_eq!(installs.load(Ordering::SeqCst), 0);

        tauri::async_runtime::block_on(install_staged(&sink, &service)).unwrap();
        assert_eq!(installs.load(Ordering::SeqCst), 1);
        assert_eq!(service.snapshot().phase, UpdatePhase::Installing);
        assert!(!service.has_staged());

        // A second install has nothing staged and must not touch the installer.
        assert_eq!(
            tauri::async_runtime::block_on(install_staged(&sink, &service)),
            Err("no_update")
        );
        assert_eq!(installs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_failed_download_reports_a_safe_error_and_stages_nothing() {
        let (sink, seen, service) = harness();
        let (source, installs) = FakeSource::new("0.1.0-beta.32", Err(CheckFailure::Signature));
        let outcome = tauri::async_runtime::block_on(run_background_cycle(
            check_with(source),
            &sink,
            &service,
        ));

        match outcome {
            CycleOutcome::Failed { code, message } => {
                assert_eq!(code, "signature");
                assert_eq!(message, "The update signature could not be verified.");
            }
            other => panic!("expected a failure, got {other:?}"),
        }
        let last = seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.phase, UpdatePhase::Error);
        assert_eq!(
            last.message.as_deref(),
            Some("The update signature could not be verified.")
        );
        assert!(!service.has_staged());
        assert_eq!(installs.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_scheduler_skips_checks_when_automatic_checks_are_off() {
        let called = Arc::new(AtomicUsize::new(0));
        let off = Ok(preferences(false, UpdateChannel::Beta));
        let skipped = tauri::async_runtime::block_on(scheduler_tick(&off, {
            let called = Arc::clone(&called);
            move |_channel| {
                let called = Arc::clone(&called);
                async move {
                    called.fetch_add(1, Ordering::SeqCst);
                }
            }
        }));
        assert!(skipped.is_none());
        assert_eq!(called.load(Ordering::SeqCst), 0);

        let seen_channel = Arc::new(Mutex::new(None));
        let on = Ok(preferences(true, UpdateChannel::Stable));
        let ran = tauri::async_runtime::block_on(scheduler_tick(&on, {
            let seen_channel = Arc::clone(&seen_channel);
            move |channel| {
                let seen_channel = Arc::clone(&seen_channel);
                async move {
                    *seen_channel.lock().unwrap() = Some(channel);
                }
            }
        }));
        assert_eq!(ran, Some(()));
        assert_eq!(*seen_channel.lock().unwrap(), Some(UpdateChannel::Stable));

        let unreadable: Result<Preferences, String> = Err("offline".to_owned());
        let skipped = tauri::async_runtime::block_on(scheduler_tick(&unreadable, |_| async {}));
        assert!(skipped.is_none());
    }
}
