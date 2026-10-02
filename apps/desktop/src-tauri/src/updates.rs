use std::{
    sync::{Arc, Mutex},
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

impl Default for UpdateChannel {
    fn default() -> Self {
        Self::Beta
    }
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

#[derive(Default)]
pub struct UpdateService {
    available: Mutex<Option<(Update, UpdateInfo)>>,
    checker: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Debug, PartialEq, Eq)]
enum CheckFailure {
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
struct Preferences {
    channel: UpdateChannel,
    auto_check: bool,
    last_checked_at: Option<String>,
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
        .ok_or_else(|| "The local Bloblex daemon is unavailable.".to_string())?;
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
        .ok_or_else(|| "The local Bloblex daemon is unavailable.".to_string())?;
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

async fn check_and_emit(app: &AppHandle, channel: UpdateChannel) -> CheckResult {
    let checked_at = Utc::now().to_rfc3339();
    persist_check_time(app, &checked_at).await;
    if let Some(service) = app.try_state::<UpdateService>() {
        if let Ok(mut available) = service.available.lock() {
            *available = None;
        }
    }
    match perform_check(app, channel).await {
        Ok(Some(update)) => {
            let info = update_info(&update, channel);
            if let Some(service) = app.try_state::<UpdateService>() {
                if let Ok(mut available) = service.available.lock() {
                    *available = Some((update, info.clone()));
                }
            }
            let _ = app.emit("bloblex-update-available", &info);
            CheckResult {
                status: "available",
                update: Some(info),
                checked_at,
                error: None,
            }
        }
        Ok(None) => {
            if let Some(service) = app.try_state::<UpdateService>() {
                if let Ok(mut available) = service.available.lock() {
                    *available = None;
                }
            }
            CheckResult {
                status: "up_to_date",
                update: None,
                checked_at,
                error: None,
            }
        }
        Err(CheckFailure::NoStableRelease) => CheckResult {
            status: "no_stable_release",
            update: None,
            checked_at,
            error: None,
        },
        Err(failure) => CheckResult {
            status: "error",
            update: None,
            checked_at,
            error: Some(failure.code()),
        },
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn updates_get_state(app: AppHandle) -> Result<UpdateStateDto, String> {
    let preferences = read_preferences(&app).await?;
    let available = app.try_state::<UpdateService>().and_then(|service| {
        service
            .available
            .lock()
            .ok()?
            .as_ref()
            .map(|(_, info)| info.clone())
    });
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
                if let Ok(mut available) = service.available.lock() {
                    *available = None;
                }
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
    match read_preferences(&app).await {
        Ok(preferences) => check_and_emit(&app, preferences.channel).await,
        Err(_) => CheckResult {
            status: "error",
            update: None,
            checked_at: Utc::now().to_rfc3339(),
            error: Some("unavailable"),
        },
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
    let service = app.try_state::<UpdateService>().ok_or(InstallError {
        code: "no_update",
        message: "There is no update ready to install.",
    })?;
    let (update, _) = service
        .available
        .lock()
        .map_err(|_| InstallError {
            code: "unavailable",
            message: "The update service is unavailable.",
        })?
        .take()
        .ok_or(InstallError {
            code: "no_update",
            message: "There is no update ready to install.",
        })?;

    let app_for_progress = app.clone();
    let downloaded = Arc::new(Mutex::new(0_u64));
    let downloaded_for_chunks = Arc::clone(&downloaded);
    let bytes = update
        .download(
            move |chunk, total| {
                let count = if let Ok(mut downloaded) = downloaded_for_chunks.lock() {
                    *downloaded += chunk as u64;
                    *downloaded
                } else {
                    chunk as u64
                };
                let _ = app_for_progress.emit(
                    "bloblex-update-progress",
                    json!({"phase":"downloading","downloadedBytes":count,"totalBytes":total}),
                );
            },
            || {},
        )
        .await
        .map_err(|error| {
            let failure = map_updater_error(&error);
            InstallError {
                code: failure.code(),
                message: install_message(failure.code()),
            }
        })?;

    let total = bytes.len() as u64;
    let _ = app.emit(
        "bloblex-update-progress",
        json!({"phase":"installing","downloadedBytes":total,"totalBytes":Some(total)}),
    );
    tauri::async_runtime::spawn_blocking(move || update.install(&bytes))
        .await
        .map_err(|_| InstallError {
            code: "unavailable",
            message: "The update could not be installed.",
        })?
        .map_err(|error| {
            let failure = map_updater_error(&error);
            InstallError {
                code: failure.code(),
                message: install_message(failure.code()),
            }
        })
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
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            if !cfg!(debug_assertions) {
                if let Ok(preferences) = read_preferences(&app_handle).await {
                    if preferences.auto_check {
                        let _ = check_and_emit(&app_handle, preferences.channel).await;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
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
    use semver::Version;

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
        let current = Version::parse("0.1.0-beta.1").unwrap();
        assert!(is_newer_version(
            &current,
            &Version::parse("0.1.0-beta.2").unwrap()
        ));
        assert!(is_newer_version(
            &current,
            &Version::parse("0.1.0").unwrap()
        ));
        assert!(!is_newer_version(
            &current,
            &Version::parse("0.1.0-beta.1").unwrap()
        ));
        assert!(!is_newer_version(
            &current,
            &Version::parse("0.1.0-alpha.9").unwrap()
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
}
