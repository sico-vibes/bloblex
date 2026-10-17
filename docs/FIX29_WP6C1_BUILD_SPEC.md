# FIX29 (WP6c-1): the desktop crate builds before the remote app exists

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree. **Do not run `git commit`.** Read `AGENTS.md` first.

## Problem
WP6c added `bundle.resources: { "../dist-remote/": "remote-web/" }` to `apps/desktop/src-tauri/tauri.conf.json`. `tauri_build::build()` fails with `ResourcePathNotFound` when that folder is missing (`tauri-utils` `resources.rs`). `dist-remote/` is gitignored and only `npm run build:remote` creates it, so `npm run tauri dev`, `cargo test -p bloblex-desktop` and `cargo clippy` on a fresh checkout or a lane worktree now fail.

## Fix
In `apps/desktop/src-tauri/build.rs`, before `tauri_build::build()`: if `../dist-remote` (resolve from `CARGO_MANIFEST_DIR`) does not exist, create it and write a single placeholder `remote.html` (a minimal valid HTML page: "The remote app was not built. Run npm run build:remote."). Do not overwrite an existing folder or file. Add `cargo:rerun-if-changed=../dist-remote` only if it does not cause constant rebuilds (check). Keep it dependency-free.

WP6b's static server builds its manifest from whatever is in the folder, so a placeholder page is served as-is and nothing else changes. Release builds are unaffected: `beforeBuildCommand` runs `build:remote` first and replaces the folder's contents (`emptyOutDir: true`).

## Verify
1. With `apps/desktop/dist-remote` absent (this worktree has none), `cargo build -p bloblex-desktop` gets past `tauri_build` (it may then stop on the missing gitignored sidecar binaries `binaries/bitbotsd*`; say so, that is expected in a worktree).
2. The folder and placeholder exist afterwards; running `npm run build:remote` in `apps/desktop` replaces them.
3. `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` still clean.

## Report
`docs/FIX29_WP6C1_REPORT.md`: the change, what was run, what could not run in a worktree.
