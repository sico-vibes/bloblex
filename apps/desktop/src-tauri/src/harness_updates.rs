use std::{process::Stdio, time::Duration};

use serde::Serialize;
use serde_json::Value;
use tauri::command;
use tokio::process::Command;

const REGISTRY: &str = "https://registry.npmjs.org";
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessUpdateResult {
    pub provider: String,
    pub version: String,
}

fn package_and_updater(
    provider: &str,
) -> Option<(&'static str, &'static str, &'static [&'static str])> {
    match provider {
        "claude" => Some(("@anthropic-ai/claude-code", "claude", &["update"])),
        "codex" => Some(("@openai/codex", "codex", &["update"])),
        "opencode" => Some(("opencode-ai", "opencode", &["upgrade"])),
        _ => None,
    }
}

fn parse_version(value: &str) -> Option<semver::Version> {
    let value = value.trim();
    let start = value.find(|ch: char| ch.is_ascii_digit())?;
    let candidate = value[start..]
        .split_whitespace()
        .next()?
        .trim_start_matches('v');
    semver::Version::parse(candidate).ok()
}

async fn latest_version(package: &'static str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(LOOKUP_TIMEOUT)
        .user_agent("Bitbots")
        .build()
        .map_err(|error| format!("Could not prepare update check: {error}"))?;
    let response: Value = client
        .get(format!("{REGISTRY}/{package}/latest"))
        .send()
        .await
        .map_err(|error| format!("Could not check for harness updates: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Could not check for harness updates: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Could not read the harness version: {error}"))?;
    response["version"]
        .as_str()
        .filter(|version| parse_version(version).is_some())
        .map(str::to_owned)
        .ok_or_else(|| "The package registry returned an invalid version.".into())
}

#[command]
pub async fn harness_latest_version(provider: String) -> Result<String, String> {
    let (package, _, _) = package_and_updater(&provider)
        .ok_or_else(|| "Updates are not available for this harness.".to_owned())?;
    latest_version(package).await
}

#[command(rename_all = "camelCase")]
pub async fn harness_update(
    provider: String,
    current_version: String,
) -> Result<HarnessUpdateResult, String> {
    let (package, executable, args) = package_and_updater(&provider)
        .ok_or_else(|| "Updates are not available for this harness.".to_owned())?;
    let current = parse_version(&current_version)
        .ok_or_else(|| "The installed harness version could not be read.".to_owned())?;
    let latest = latest_version(package).await?;
    let latest_parsed = parse_version(&latest)
        .ok_or_else(|| "The package registry returned an invalid version.".to_owned())?;
    if latest_parsed <= current {
        return Err("This harness is already up to date.".into());
    }

    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command"]);
        // Both the executable and its arguments come from the fixed provider
        // table above; no renderer-supplied command text reaches PowerShell.
        command.arg(format!("& {executable} {}", args.join(" ")));
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(executable);
        command.args(args);
        command
    };

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(UPDATE_TIMEOUT, command.output())
        .await
        .map_err(|_| "The harness update timed out. Retry from Settings → Agents.".to_owned())?
        .map_err(|error| format!("Could not start the harness updater: {error}"))?;
    if !output.status.success() {
        return Err(
            "The harness updater reported an error. Retry or update it with its own CLI.".into(),
        );
    }

    let installed = read_installed_version(executable).await?;
    let installed_parsed = parse_version(&installed).ok_or_else(|| {
        "The updater finished, but the installed version could not be verified.".to_owned()
    })?;
    if installed_parsed < latest_parsed {
        return Err(format!(
            "The updater finished, but the harness still reports version {installed}."
        ));
    }

    Ok(HarnessUpdateResult {
        provider,
        version: installed_parsed.to_string(),
    })
}

async fn read_installed_version(executable: &'static str) -> Result<String, String> {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command"]);
        command.arg(format!("& {executable} --version"));
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(executable);
        command.arg("--version");
        command
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| "Timed out while verifying the installed harness version.".to_owned())?
        .map_err(|error| format!("Could not verify the installed harness version: {error}"))?;
    if !output.status.success() {
        return Err("The updater finished, but the harness version check failed.".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
