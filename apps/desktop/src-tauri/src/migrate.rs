//! FIX11: move Bloblex-era local data to the Bitbots identity.
//!
//! These functions work on paths alone, so they can be unit-tested with
//! temporary directories. Nothing here reads, parses or logs file *contents*:
//! only paths and counts cross these functions.
//!
//! Two directories are migrated:
//!
//! 1. the Tauri `app_local_data_dir` (`%LOCALAPPDATA%\com.bloblex.desktop`,
//!    or `...\.dev` in development), which holds the WebView2 profile, staged
//!    attachments and downloaded speech models; and
//! 2. the shared data directory `%LOCALAPPDATA%\Bloblex`, which holds the
//!    SQLite database, the private instruction files and the speech-model
//!    fallback.
//!
//! The move runs before the Tauri builder creates the WebView2 profile under
//! the new identifier, so the profile is carried over rather than recreated.
//!
//! The shared directory needs care: it is also the per-user NSIS *install*
//! directory (`$LOCALAPPDATA\<productName>`), so after the new installer runs
//! the target already exists and holds `Bitbots.exe`. Replacing it would delete
//! the running application and strand the database. The identifier directory is
//! a disposable profile and may be replaced; the shared directory is merged
//! file by file, never overwriting an existing file.

use serde::Serialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

/// Marker a completed migration leaves in the target directory.
pub const MARKER_FILE: &str = "migrated-from-bloblex.json";

/// Identifier directories. Kept in step with `tauri.conf.json` and
/// `scripts/dev-windows.ps1`.
pub const LEGACY_IDENTIFIER: &str = "com.bloblex.desktop";
pub const LEGACY_IDENTIFIER_DEV: &str = "com.bloblex.desktop.dev";
pub const TARGET_IDENTIFIER: &str = "com.bitbots.desktop";
pub const TARGET_IDENTIFIER_DEV: &str = "com.bitbots.desktop.dev";

/// The old and new names of the shared data directory.
pub const LEGACY_DATA_DIR: &str = "Bloblex";
pub const TARGET_DATA_DIR: &str = "Bitbots";

/// How long a failing whole-directory rename is retried before the copy
/// fallback runs.
const RENAME_RETRY_WINDOW: Duration = Duration::from_secs(5);
const RENAME_RETRY_INTERVAL: Duration = Duration::from_millis(100);

/// The result of one directory migration.
#[derive(Debug, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// The legacy directory is absent, the target already holds the database,
    /// or a previous run left its marker next to the data.
    NotNeeded,
    /// `fs::rename` moved the whole directory in one step.
    Moved,
    /// The whole-directory rename was not possible and a recursive copy ran.
    /// Nothing is overwritten and the legacy directory is left in place.
    Copied { skipped: Vec<PathBuf> },
    /// The move could not be completed. The application still starts.
    Failed(String),
}

#[derive(Serialize)]
struct Marker {
    from: String,
    at: String,
    method: &'static str,
    skipped: Vec<String>,
}

/// Runs the full migration. Called once from [`crate::run`] before the Tauri
/// builder starts. It never panics and, on failure, never stops the app from
/// starting with a fresh profile.
pub fn migrate_before_start() {
    let Some(local) = local_app_data() else {
        eprintln!("Bitbots local data migration skipped: LOCALAPPDATA is not set.");
        return;
    };
    let (legacy_identifier, target_identifier) = if tauri::is_dev() {
        (LEGACY_IDENTIFIER_DEV, TARGET_IDENTIFIER_DEV)
    } else {
        (LEGACY_IDENTIFIER, TARGET_IDENTIFIER)
    };
    // The identifier directory is a disposable profile: a fresh shell may be
    // replaced outright.
    report(
        "app",
        migrate_directory(
            &local.join(legacy_identifier),
            &local.join(target_identifier),
            true,
        ),
    );
    // Development has its own database; it must not migrate the installed store
    // or rewrite the installed application's autostart entry.
    if tauri::is_dev() { return; }
    // The shared directory doubles as the install directory: merge instead of
    // replacing so the installed application is never deleted.
    report(
        "shared",
        migrate_directory(&local.join(LEGACY_DATA_DIR), &local.join(TARGET_DATA_DIR), false),
    );
    migrate_autostart();
}

fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn report(scope: &str, outcome: MigrationOutcome) {
    match outcome {
        MigrationOutcome::NotNeeded => {}
        MigrationOutcome::Moved => {
            eprintln!("Bitbots {scope} data was moved from the Bloblex location.");
        }
        MigrationOutcome::Copied { skipped } => {
            eprintln!(
                "Bitbots {scope} data was copied from the Bloblex location ({} file(s) skipped; the Bloblex folder was kept).",
                skipped.len()
            );
        }
        MigrationOutcome::Failed(reason) => {
            eprintln!(
                "Bitbots {scope} data could not be migrated: {reason}. Starting with a fresh profile."
            );
        }
    }
}

/// Moves `legacy` to `target` following the FIX11 rules. Pure over paths.
///
/// `replace_fresh_shell` is true for the disposable identifier profile and
/// false for the shared directory, where an existing target is merged into.
fn migrate_directory(legacy: &Path, target: &Path, replace_fresh_shell: bool) -> MigrationOutcome {
    migrate_with(legacy, target, rename_with_retry, replace_fresh_shell)
}

fn migrate_with<R>(
    legacy: &Path,
    target: &Path,
    rename: R,
    replace_fresh_shell: bool,
) -> MigrationOutcome
where
    R: Fn(&Path, &Path) -> io::Result<()>,
{
    if !legacy.is_dir() {
        return MigrationOutcome::NotNeeded;
    }
    if holds_database(target) || target.join(MARKER_FILE).is_file() {
        return MigrationOutcome::NotNeeded;
    }
    if target.exists() && replace_fresh_shell {
        if let Err(error) = remove_shell(target) {
            return MigrationOutcome::Failed(format!(
                "could not clear the fresh {} folder: {error}",
                target.display()
            ));
        }
    }
    if !target.exists() {
        match rename(legacy, target) {
            Ok(()) => {
                return match write_marker(target, legacy, "rename", &[]) {
                    Ok(()) => MigrationOutcome::Moved,
                    Err(error) => MigrationOutcome::Failed(format!(
                        "data moved but the migration marker could not be written: {error}"
                    )),
                };
            }
            Err(rename_error) => {
                let result = copy_and_mark(legacy, target, !replace_fresh_shell);
                return match result {
                    Ok(outcome) => outcome,
                    Err(copy_error) => MigrationOutcome::Failed(format!(
                        "rename failed ({rename_error}); copy failed ({copy_error})"
                    )),
                };
            }
        }
    }
    // The target is kept (shared directory / install directory): merge the
    // legacy data in without overwriting anything already there.
    match copy_and_mark(legacy, target, !replace_fresh_shell) {
        Ok(outcome) => outcome,
        Err(error) => MigrationOutcome::Failed(format!("copy into the existing target failed: {error}")),
    }
}

fn copy_and_mark(legacy: &Path, target: &Path, skip_binaries: bool) -> io::Result<MigrationOutcome> {
    let skipped = copy_tree(legacy, target, skip_binaries)?;
    write_marker(target, legacy, "copy", &skipped)?;
    Ok(MigrationOutcome::Copied { skipped })
}

/// True when the target directory already holds a SQLite database file.
fn holds_database(directory: &Path) -> bool {
    let Ok(entries) = fs::read_dir(directory) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
            && entry
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("db"))
    })
}

fn remove_shell(target: &Path) -> io::Result<()> {
    if target.is_dir() {
        fs::remove_dir_all(target)
    } else {
        fs::remove_file(target)
    }
}

fn rename_with_retry(legacy: &Path, target: &Path) -> io::Result<()> {
    let deadline = Instant::now() + RENAME_RETRY_WINDOW;
    loop {
        match fs::rename(legacy, target) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if Instant::now() >= deadline {
                    return Err(error);
                }
                thread::sleep(RENAME_RETRY_INTERVAL);
            }
        }
    }
}

/// Recursively copies `source` into `destination`. Files that already exist in
/// the destination, and files that cannot be opened, are skipped and returned.
fn copy_tree(source: &Path, destination: &Path, skip_binaries: bool) -> io::Result<Vec<PathBuf>> {
    let mut skipped = Vec::new();
    copy_into(source, destination, skip_binaries, &mut skipped)?;
    Ok(skipped)
}

/// Program files of the old install (the shared folder doubled as its install
/// directory). They are never user data and must not land in the new install.
fn is_program_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("dll"))
}

fn copy_into(
    source: &Path,
    destination: &Path,
    skip_binaries: bool,
    skipped: &mut Vec<PathBuf>,
) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_into(&from, &to, skip_binaries, skipped)?;
        } else if kind.is_file() && skip_binaries && is_program_file(&from) {
            // Left behind on purpose; not reported as a failure.
        } else if kind.is_file() && (to.exists() || fs::copy(&from, &to).is_err()) {
            skipped.push(from);
        }
    }
    Ok(())
}

fn write_marker(
    target: &Path,
    legacy: &Path,
    method: &'static str,
    skipped: &[PathBuf],
) -> io::Result<()> {
    let marker = Marker {
        from: legacy.to_string_lossy().into_owned(),
        at: chrono::Utc::now().to_rfc3339(),
        method,
        skipped: skipped
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
    };
    let body = serde_json::to_vec_pretty(&marker).map_err(io::Error::other)?;
    fs::write(target.join(MARKER_FILE), body)
}

/// Detects and replaces the old "Bloblex" autostart entry.
///
/// The old app only ever wrote `HKCU\...\Run\Bloblex` while "Start with
/// Windows" was on, so the presence of that value is the signal to carry the
/// setting over to the new `Bitbots` value. `reg.exe` is used because no
/// registry crate is a dependency and, at this point, the Tauri builder (and
/// with it the autostart plugin) has not started yet.
#[cfg(windows)]
fn migrate_autostart() {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let run_reg = |args: &[&str]| -> bool {
        Command::new("reg.exe")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    };

    if !run_reg(&["query", RUN_KEY, "/v", "Bloblex"]) {
        return;
    }
    let _ = run_reg(&["delete", RUN_KEY, "/v", "Bloblex", "/f"]);
    if run_reg(&["query", RUN_KEY, "/v", "Bitbots"]) {
        return;
    }
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let value = format!("\"{}\"", executable.display());
    if !run_reg(&[
        "add", RUN_KEY, "/v", "Bitbots", "/t", "REG_SZ", "/d", &value, "/f",
    ]) {
        eprintln!("Bitbots could not re-create the start-with-Windows entry.");
    }
}

#[cfg(not(windows))]
fn migrate_autostart() {}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "bitbots-migrate-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn read_marker(target: &Path) -> serde_json::Value {
        let body = fs::read(target.join(MARKER_FILE)).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[test]
    fn moves_everything_when_the_target_is_absent() {
        let scratch = Scratch::new("move");
        let legacy = scratch.path().join("legacy");
        let target = scratch.path().join("target");
        fs::create_dir_all(legacy.join("nested")).unwrap();
        fs::write(legacy.join("a.txt"), b"a").unwrap();
        fs::write(legacy.join("nested/b.txt"), b"b").unwrap();

        let outcome = migrate_directory(&legacy, &target, true);

        assert_eq!(outcome, MigrationOutcome::Moved);
        assert!(!legacy.exists());
        assert!(target.join("a.txt").is_file());
        assert!(target.join("nested/b.txt").is_file());
    }

    #[test]
    fn records_the_legacy_path_and_method_in_the_marker() {
        let scratch = Scratch::new("marker");
        let legacy = scratch.path().join("legacy");
        let target = scratch.path().join("target");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("a.txt"), b"a").unwrap();

        migrate_directory(&legacy, &target, true);

        let marker = read_marker(&target);
        assert_eq!(marker["from"].as_str().unwrap(), legacy.to_string_lossy());
        assert_eq!(marker["method"], "rename");
        assert!(marker["skipped"].as_array().unwrap().is_empty());
        let at = marker["at"].as_str().unwrap();
        assert!(chrono::DateTime::parse_from_rfc3339(at).is_ok(), "at was {at}");
    }

    #[test]
    fn does_nothing_without_a_legacy_directory() {
        let scratch = Scratch::new("absent");
        let legacy = scratch.path().join("legacy");
        let target = scratch.path().join("target");

        assert_eq!(
            migrate_directory(&legacy, &target, true),
            MigrationOutcome::NotNeeded
        );
        assert!(!target.exists());
    }

    #[test]
    fn replaces_an_empty_shell_in_the_identifier_profile() {
        let scratch = Scratch::new("shell");
        let legacy = scratch.path().join("legacy");
        let target = scratch.path().join("target");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("a.txt"), b"a").unwrap();
        fs::create_dir_all(target.join("stale")).unwrap();
        fs::write(target.join("stale/shell.txt"), b"shell").unwrap();

        assert_eq!(
            migrate_directory(&legacy, &target, true),
            MigrationOutcome::Moved
        );
        assert!(target.join("a.txt").is_file());
        assert!(!target.join("stale/shell.txt").exists());
    }

    #[test]
    fn merges_into_an_existing_target_without_overwriting() {
        let scratch = Scratch::new("merge");
        let legacy = scratch.path().join("legacy");
        let target = scratch.path().join("target");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("bloblex.db"), b"old database").unwrap();
        fs::write(legacy.join("uninstall.exe"), b"old uninstaller").unwrap();
        fs::write(legacy.join("bloblexd.exe"), b"old daemon").unwrap();
        fs::create_dir_all(target.join("private-tmp")).unwrap();
        fs::write(target.join("uninstall.exe"), b"new uninstaller").unwrap();

        let outcome = migrate_directory(&legacy, &target, false);

        assert_eq!(
            outcome,
            MigrationOutcome::Copied { skipped: Vec::new() }
        );
        // Program files of the old install are left behind, not copied.
        assert!(!target.join("bloblexd.exe").exists());
        // The installed file is untouched, the database is carried over, and
        // the legacy folder is kept.
        assert_eq!(fs::read(target.join("uninstall.exe")).unwrap(), b"new uninstaller");
        assert_eq!(fs::read(target.join("bloblex.db")).unwrap(), b"old database");
        assert!(legacy.join("bloblex.db").is_file());
        assert_eq!(read_marker(&target)["method"], "copy");
    }

    #[test]
    fn keeps_a_target_that_already_holds_a_database() {
        let scratch = Scratch::new("database");
        let legacy = scratch.path().join("legacy");
        let target = scratch.path().join("target");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("a.txt"), b"a").unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("bloblex.db"), b"database").unwrap();

        assert_eq!(
            migrate_directory(&legacy, &target, false),
            MigrationOutcome::NotNeeded
        );
        assert!(legacy.join("a.txt").is_file());
        assert!(!target.join("a.txt").exists());
        assert!(!target.join(MARKER_FILE).exists());
    }

    #[test]
    fn a_second_call_is_a_no_op() {
        let scratch = Scratch::new("idempotent");
        let legacy = scratch.path().join("legacy");
        let target = scratch.path().join("target");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("a.txt"), b"a").unwrap();

        assert_eq!(
            migrate_directory(&legacy, &target, true),
            MigrationOutcome::Moved
        );
        assert_eq!(
            migrate_directory(&legacy, &target, true),
            MigrationOutcome::NotNeeded
        );
    }

    #[cfg(windows)]
    #[test]
    fn copy_fallback_skips_a_locked_file_and_keeps_the_legacy_folder() {
        use std::os::windows::fs::OpenOptionsExt;

        let scratch = Scratch::new("locked");
        let legacy = scratch.path().join("legacy");
        let target = scratch.path().join("target");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("plain.txt"), b"plain").unwrap();
        let locked = legacy.join("locked.txt");
        fs::write(&locked, b"locked").unwrap();
        // A handle that shares nothing blocks both the directory rename and a
        // later read of the file.
        let handle = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&locked)
            .unwrap();

        let outcome = migrate_with(
            &legacy,
            &target,
            |_, _| Err(io::Error::new(io::ErrorKind::PermissionDenied, "rename blocked")),
            true,
        );

        assert_eq!(
            outcome,
            MigrationOutcome::Copied {
                skipped: vec![locked.clone()]
            }
        );
        drop(handle);
        assert!(target.join("plain.txt").is_file());
        assert!(!target.join("locked.txt").exists());
        assert!(legacy.join("plain.txt").is_file());
        assert!(legacy.join("locked.txt").is_file());
        let marker = read_marker(&target);
        assert_eq!(marker["method"], "copy");
        assert_eq!(marker["skipped"][0].as_str().unwrap(), locked.to_string_lossy());
    }
}
