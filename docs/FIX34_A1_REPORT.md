# FIX34 A1 report — the remote web app loads

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, worktree `C:\fx51`, private
`CARGO_TARGET_DIR=C:/fxt/a1`. No `git commit` was run.

## Change

`crates/bloblex-daemon/src/remote/web.rs`

- `StaticFiles::load` now maps `/` to `remote.html` when that file is present,
  and falls back to `index.html` for an older layout. Every collected file keeps
  its own manifest key, so `/remote.html`, `/remote.webmanifest`, `/remote-sw.js`
  and `/assets/...` are all servable at their real paths.
- `is_empty()` now reports true only when the folder yielded **no** files. A
  folder with files but no entry page is no longer treated as empty.
- When files exist but neither `remote.html` nor `index.html` does, `load` logs
  one `tracing::warn!` at startup containing the folder path only, then leaves
  the manifest without a `/` key.
- `static_file` serves the built-in `NOT_INSTALLED_PAGE` at `/` for an
  absent/empty folder, and now also for a files-but-no-entry folder (no `/`
  key). All other paths for a non-empty folder still resolve through the
  manifest or 404. The built-in response is factored into
  `not_installed_response()`.

`pair_begin` URLs in `mod.rs` were left as `{origin}/` as the spec allows.

## Tests

`crates/bloblex-daemon/src/remote/tests.rs`

- `gateway_with_static_files` now builds the real packaged layout:
  `remote.html`, `remote.webmanifest`, `remote-sw.js`, `assets/app-AbC123.js`.
- `static_files_come_from_the_manifest_and_nothing_else` asserts `/` and
  `/remote.html` both return 200 with the entry page, `remote.webmanifest` and
  `remote-sw.js` return 200, `/assets/app-AbC123.js` returns 200 with its body,
  and an unknown path returns 404.
- `path_traversal_is_a_404` still exercises the same traversal shapes against
  the new layout (unchanged targets, updated fixture) and confirms the manifest
  still serves `/`.
- New `a_folder_with_files_but_no_entry_page_serves_the_built_in_page` builds a
  folder with only `assets/` and asserts `/` returns the built-in page with 200.
- `an_absent_web_folder_serves_the_built_in_page` is unchanged and still passes.

## Gate results

- `RUST_MIN_STACK=33554432 cargo test -p bloblex-daemon --no-fail-fast`
  - `292 passed; 0 failed` (lib), `1 passed; 0 failed` (other target). No
    FAILED, no panics. A focused `remote::` run first gave `76 passed; 0 failed`.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
  - `Finished` with no warnings or errors.

## Honesty notes

- This is source-only verification plus the crate's automated tests, run on the
  loopback HTTP surface the tests drive. It does not load the real packaged
  `remote-web` folder in a browser, and nothing here was checked against a live
  tailnet or a real phone. The claim is only that `/` now maps to `remote.html`
  and that the static-file router behaves as the tests assert.
- The `impl-b` read-only second opinion and the Director's review are still owed
  for this diff.
