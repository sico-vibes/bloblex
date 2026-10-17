//! Build script for the Bitbots desktop app.
//!
//! `tauri.conf.json` bundles `bundle.resources: { "../dist-remote/": "remote-web/" }`
//! (FIX29 WP6c), but `apps/desktop/dist-remote/` is gitignored and only
//! `npm run build:remote` creates it. `tauri_build::build()` copies the declared
//! resources and aborts with `ResourcePathNotFound` — "resource path
//! `..\dist-remote` doesn't exist" — when one is missing, so `cargo build`,
//! `cargo test` and `cargo clippy` failed on a fresh checkout and in every lane
//! worktree.
//!
//! This script fills the hole with one placeholder page before `tauri_build` runs.
//! A real build always wins: the placeholder is only written when
//! `../dist-remote/remote.html` is absent, so nothing is overwritten, and
//! `npm run build:remote` empties and rewrites the folder (`emptyOutDir: true`).
//! Release installers are unaffected — `beforeBuildCommand` runs that build first.

use std::fs;
use std::path::PathBuf;

/// The folder `bundle.resources` declares, resolved from `CARGO_MANIFEST_DIR`
/// (which is `apps/desktop/src-tauri`).
const REMOTE_WEB_DIR: &str = "../dist-remote";

/// The page the remote build emits as its entry point.
const REMOTE_WEB_ENTRY: &str = "remote.html";

const PLACEHOLDER_HTML: &str = "\
<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\">
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
    <title>Bitbots remote</title>
  </head>
  <body>
    <p>The remote app was not built. Run npm run build:remote.</p>
  </body>
</html>
";

/// Creates `../dist-remote/remote.html` when it is missing.
///
/// The trigger is the entry page, not the folder: an absent folder and a stale or
/// emptied one are the same hole, and neither case touches existing files.
fn ensure_remote_web_placeholder() {
    let dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    )
    .join(REMOTE_WEB_DIR);
    let page = dir.join(REMOTE_WEB_ENTRY);
    if page.exists() {
        return;
    }
    // `create_dir_all` is a no-op when the folder is already there.
    if let Err(error) = fs::create_dir_all(&dir) {
        // Stay quiet on the way out: `tauri_build` reports the missing resource with
        // its own error, which is the message that explains the failure.
        println!("cargo:warning=could not create {}: {error}", dir.display());
        return;
    }
    if let Err(error) = fs::write(&page, PLACEHOLDER_HTML) {
        println!("cargo:warning=could not write {}: {error}", page.display());
    }
}

fn main() {
    ensure_remote_web_placeholder();
    // `tauri-build` emits the same directive from `copy_resources` once the whole
    // resource set copies, so this adds no rebuild that a green build does not
    // already have. It only covers the path where that copy is never reached
    // (e.g. missing sidecar binaries in a worktree).
    println!("cargo:rerun-if-changed={REMOTE_WEB_DIR}");
    tauri_build::build()
}
