# FIX34 A1: the remote web app loads ("Bitbots Remote is not installed")

> **What this is:** Spec for FIX34 A1: the remote web app loads instead of reporting that Bitbots Remote is not installed.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree, private `CARGO_TARGET_DIR`. **Do not run `git commit`.** Read `AGENTS.md` first. Keep your context small: grep and read only the ranges you need; pipe long command output through `tail`/`grep`.

## Problem (found by the Director)
The installed beta.30 serves the built-in "Bitbots Remote is not installed" page. The packaged `remote-web` folder is correct (`remote.html`, `remote.webmanifest`, `remote-sw.js`, `assets/`, `icons/`), and `BITBOTS_REMOTE_WEB_DIR` reaches the daemon. But `crates/bloblex-daemon/src/remote/web.rs` `StaticFiles::load` (around line 697) maps `/` only when `/index.html` exists, and `is_empty()` is true whenever `/` is missing, so `static_file` (around line 745) serves `NOT_INSTALLED_PAGE` for `/` and 404 for everything else. The remote build's entry page is `remote.html`.

## Fix
- `StaticFiles::load`: map `/` to `remote.html` when present, else `index.html`. Keep every manifest file servable at its own path (so `/remote.html` works too).
- Distinguish "no files" from "files but no entry page": the built-in page is for an absent/empty folder only; a folder with files but no entry page logs one warning at load (path only) and serves the built-in page at `/`.
- `pair_begin` URLs (`mod.rs` ~671) may stay `{origin}/`.
- Tests in `crates/bloblex-daemon/src/remote/tests.rs`: change the `gateway_with_static_files` fixture (~line 63-90) to the real layout (`remote.html`, `remote.webmanifest`, `remote-sw.js`, `assets/app-AbC123.js`); assert `/` and `/remote.html` return 200 with the entry page, `/assets/...` returns 200, an unknown path 404, traversal still 404, and a folder with only `assets/` serves the built-in page at `/`.

## Gates
- `RUST_MIN_STACK=33554432 cargo test -p bloblex-daemon --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`

## Report
`docs/history/fix-34/a1-report.md`: change, tests, gate results.
