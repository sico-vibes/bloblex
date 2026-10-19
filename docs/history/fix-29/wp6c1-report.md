# FIX29 (WP6c-1) report: the desktop crate builds before the remote app exists

> **What this is:** Report on FIX29 (WP6c-1): the desktop crate builds before the remote app exists.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, worktree `C:\fx50`, branch
`lane/fix29-wp6c1`. Spec: `docs/history/fix-29/wp6c1-build-spec.md`. Status: implemented, the two
runnable gates are green, **no commit made** (the Director reviews and commits).
`CARGO_TARGET_DIR=C:/fxtarget2` throughout; a fresh target directory, so every number below is
from a cold build in this worktree.

One file changed: `apps/desktop/src-tauri/build.rs`. No UI/UX file, no other Rust source and no
config was touched.

---

## 1. The change

`apps/desktop/src-tauri/build.rs`, 3 lines before, 74 after (+71):

```rust
fn main() {
    ensure_remote_web_placeholder();
    println!("cargo:rerun-if-changed={REMOTE_WEB_DIR}");
    tauri_build::build()
}
```

`ensure_remote_web_placeholder()` resolves `../dist-remote` from `CARGO_MANIFEST_DIR`, and if
`../dist-remote/remote.html` is missing, creates the folder (`create_dir_all`, a no-op when it
exists) and writes a 280-byte placeholder page:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Bitbots remote</title>
  </head>
  <body>
    <p>The remote app was not built. Run npm run build:remote.</p>
  </body>
</html>
```

Std-only: `std::fs`, `std::env`, `std::path::PathBuf`. `tauri-build` stays the only
build-dependency. Failures are warnings, not a panic — `tauri_build` then reports the missing
resource itself, and that message is the one that explains the failure.

### Why the whole fix lives in `build.rs`

Read from the vendored sources rather than assumed:

- `tauri-build` 2.7.1 `src/lib.rs`: the build script copies `bundle.externalBin` first
  (`copy_binaries`, line 141) and `bundle.resources` second (`copy_resources`, line 171, called at
  line 758-762).
- `copy_resources` iterates `ResourcePaths`, and `tauri-utils` 2.10.1 `src/resources.rs:207`
  (`resource_from_path`) returns `Error::ResourcePathNotFound` for a declared path that is not a
  directory, which is the message `resource path `..\dist-remote` doesn't exist`.
- The same file (`resources.rs:276-287`) shows a declared directory that **exists but is empty** is
  skipped silently: no error, just no resources. So an empty `dist-remote/` would not fail either,
  but it would also produce an empty resource set.
- `copy_resources` emits `cargo:rerun-if-changed` for every resource path it walked
  (`rerun_if_changed()`, `src/lib.rs:186-188`) — this matters for §3 below.

So nothing in `tauri.conf.json` needs to change, and `tauri_build::build()` cannot be told to
tolerate a missing resource: creating the path before calling it is the only local fix.

---

## 2. What was run, and what came back

The worktree had neither `apps/desktop/dist-remote/` (gitignored, WP6c) nor
`apps/desktop/src-tauri/binaries/bitbotsd-*.exe` (gitignored, release sidecars), so `cargo build`
stops at the sidecars before it ever reaches the resource copy. Both cases were probed.

### 2.1 Pre-fix reproduction (this is the spec's failure, confirmed)

To get past the sidecar step, two **empty** files were created at the gitignored paths
`apps/desktop/src-tauri/binaries/bitbotsd-x86_64-pc-windows-msvc.exe` and
`bitbots-hook-…exe` (both deleted again in §5). `cargo build -p bloblex-desktop` then reported:

```
  cargo:rerun-if-changed=binaries\bitbotsd-x86_64-pc-windows-msvc.exe
  cargo:rerun-if-changed=binaries\bitbots-hook-x86_64-pc-windows-msvc.exe
  resource path `..\dist-remote` doesn't exist
error: failed to run custom build command for `bloblex-desktop v0.1.0-beta.29 (…\apps\desktop\src-tauri)`
```

With no dummy sidecars the same command fails earlier, on the sidecar copy:

```
  resource path `binaries\bitbotsd-x86_64-pc-windows-msvc.exe` doesn't exist
```

### 2.2 Post-fix, verification item 1

| Command | Result |
|---|---|
| `cargo build -p bloblex-desktop`, no sidecars | Fails at `resource path `binaries\bitbotsd-…exe` doesn't exist` — the expected worktree stop, and **not** the resource error. `apps/desktop/dist-remote/remote.html` (280 bytes) existed afterwards. |
| `cargo build -p bloblex-desktop`, dummy sidecars | **The build script succeeds.** `tauri_build` ran to completion with nothing further printed, and copied the resource: `C:/fxtarget2/debug/remote-web/remote.html` is 280 bytes, the placeholder. The next failure is a *different, pre-existing* wall — the non-dev macro needs the other gitignored folder: `proc macro panicked … The `frontendDist` configuration is set to `"../dist"` but this path doesn't exist` (`src/lib.rs:2392`). |
| `npm run build` (to make `dist/`, then `cargo clippy -p bloblex-desktop`) | The crate compiles — `tauri_build` and `tauri::generate_context!()` both succeed with the placeholder resource. Clippy then stops on **pre-existing** lints in `src/{lib,power,speech,updates}.rs` (1 error `power.rs:222` "this loop never actually loops", 7 warnings; 8 errors under `-D warnings`). **None in `build.rs`.** |

So: yes, `tauri_build` is past. It is worth being blunt that this fix does **not** on its own make
`cargo build -p bloblex-desktop` succeed in a worktree: that still needs the sidecar binaries and
`../dist`. It removes exactly one of the three gitignored gates, the one this spec named.

### 2.3 Post-fix, verification item 2 — the real build replaces the placeholder

`npm run build:remote` in `apps/desktop` (exit 0, "built in 2.33s") emptied and rewrote the
folder: 21 files (14 hashed assets, 4 icons, `remote.html`, `remote.webmanifest`, `remote-sw.js`),
`remote.html` 1150 bytes and starting `<!doctype html>` with the real head — the placeholder is
gone.

Then `cargo build -p bloblex-desktop -v`:

- Cargo reported `Dirty … the file `apps\desktop\src-tauri\../dist-remote` has changed (40s after
  last build)`, re-ran the build script, and `copy_resources` refreshed
  `C:/fxtarget2/debug/remote-web/` to the real 21-file tree;
- `apps/desktop/dist-remote/remote.html` sha256 was **identical before and after** the build
  (`0aff48d2…`). The script did not overwrite the real page.

### 2.4 Post-fix, verification item 3

`cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` → **exit 0**, no diagnostics
("Finished `dev` profile … in 1m 15s").

### 2.5 Extra checks run

| Check | Result |
|---|---|
| Rebuild loop | A second `cargo build -p bloblex-desktop` with nothing changed did **not** re-run the build script (no `Running …build-script-build` under `-v`). After `npm run build:remote` it did re-run once. No constant rebuilds. |
| Folder exists, entry missing | `mkdir dist-remote` (empty), then `cargo build`: the placeholder was written, so `tauri_build` passed. |
| `rustfmt --check --edition 2021 apps/desktop/src-tauri/build.rs` | Clean. (`cargo fmt -p bloblex-desktop -- --check` reports diffs in `src/lib.rs`, `speech.rs`, `snap.rs`, `migrate.rs` — all pre-existing, untouched here; `build.rs` is not among them.) |
| `.gitignore` | `git check-ignore -v apps/desktop/dist-remote/remote.html` → `.gitignore:3`. The placeholder is untracked. |

---

## 3. Why `cargo:rerun-if-changed=../dist-remote` is safe (the check the spec asked for)

It is **not new pressure on the fingerprint set**: `tauri-build` already emits exactly this
directive from `copy_resources` (`tauri-build-2.7.1/src/lib.rs:186-188`) on every build where the
resource copy is reached, so any green build already watches this folder. The one case my own
directive adds is a build that dies before the copy — the missing-sidecar case — where it is
useful anyway.

Measured: no rebuild on an unchanged tree (2.5); one rebuild when the folder is replaced (2.3).
The write happens only when `remote.html` is absent, i.e. before the fingerprint for that run is
written, so the script cannot invalidate itself.

---

## 4. Verified vs not verified

**Verified here (commands and outputs above):**

- The spec's failure reproduces byte-for-byte: `resource path `..\dist-remote` doesn't exist`.
- After the change, `tauri_build` completes and copies the resource into the target tree.
- The placeholder appears when the folder is absent, and also when it exists without
  `remote.html`; an existing `remote.html` is never overwritten (sha256 unchanged across a build).
- `npm run build:remote` replaces the folder with the real build, and the next build picks up the
  real files.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`: clean.
- `build.rs` is rustfmt-clean.

**Not verified here:**

- **`cargo build`, `cargo test` and `cargo clippy -p bloblex-desktop` as green gates.** They cannot
  go green in this worktree for reasons this spec does not address: the release sidecars
  (`binaries/bitbotsd-*.exe`, `bitbots-hook-*.exe`) and `apps/desktop/dist/` are absent and
  gitignored. With both supplied by hand, the crate compiles; the remaining failures are
  pre-existing clippy lints in files this change does not touch. A reviewer wanting a green
  desktop clippy should note that `power.rs:222` already fails `-D warnings` on this branch.
- **`npm run tauri dev` and a real installer.** Not run: no native window here, and a release build
  needs the sidecars. So "an installer ships the real `remote-web/`" is argued from
  `beforeBuildCommand` (`npm run build && npm run build:remote`, `emptyOutDir: true`) and not
  observed.
- **WP6b serving the placeholder.** The gateway is not in this branch (`crates/bloblex-daemon/src/`
  has no `web.rs`), so nothing was served. WP6b's spec says an absent-or-empty folder makes `/`
  return its built-in "not installed" page; with the placeholder present the folder is non-empty,
  so `/remote.html` (and whatever the manifest maps) will return this page instead. Out of scope
  for this change, but the reviewer should know the two behaviours differ.
- **A fresh main checkout.** This worktree is one data point; the Director's own fresh-clone gate
  is the real test.

---

## 5. Judgement calls for the reviewer

1. **The trigger is the missing entry page, not the missing folder.** The spec said "if
   `../dist-remote` does not exist, create it and write a single placeholder `remote.html`".
   I check `remote.html` instead: it is the same condition in the normal case, it also repairs an
   emptied or stale folder (which satisfies `tauri_build` but silently yields no resources), and
   `fs::write` is only reached when the file is absent, so nothing is overwritten either way. If
   you prefer the literal folder check, `if page.exists()` becomes `if dir.exists()` and everything
   else stands.
2. **The `cargo:rerun-if-changed` directive was added** — see §3 — rather than left out, because
   the check came back "no new rebuild pressure" and it covers the early-failure path.
3. **Placeholder content.** Minimal, self-contained, no script, no stylesheet, no external
   reference, so it cannot trip the gateway's CSP; the filename is the remote build's entry page
   (`remote.html`), not `index.html`.
4. **Nothing is cleaned up.** If a real build once existed and a later build dies, the copied
   resources from the old build stay in the target tree beside the placeholder — `tauri-build`
   only copies, it never prunes. Pre-existing behaviour, unchanged by this patch.

## 6. Housekeeping

- Side effects of running the builds, in this order: `tauri-build` rewrites
  `apps/desktop/src-tauri/gen/schemas/{desktop,windows}-schema.json` with LF endings, which `git`
  then shows as modified even though the content is identical. I restored both files with
  `git checkout --` (not a commit) after the last cargo run, so the only tracked change is
  `build.rs`. Any other lane running `cargo build` in this crate will see the same two files
  dirtied — worth knowing, not introduced here.
- Removed again after probing: the two empty dummy sidecars, their copies in
  `C:/fxtarget2/debug/{bitbotsd,bitbots-hook}.exe`, and `apps/desktop/dist/` (built only for the
  clippy probe).
- Left in place: `apps/desktop/dist-remote/remote.html` (the 280-byte placeholder, gitignored) —
  the state the spec's verification step 2 describes. `C:/fxtarget2` itself is kept; it makes the
  next gates fast.
- No `git commit` was run. Final `git status --short`: `M apps/desktop/src-tauri/build.rs` and the
  untracked spec file, nothing else.
