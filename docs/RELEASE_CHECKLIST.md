# Release checklist

Source and config review, plus the release script and updater manifest helper. No installer was built, no app or daemon was started, and no signing material was read or copied while writing this file. Status values are `done`, `needs user`, or `blocked`.

Versions read from this worktree: root `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, and the workspace `Cargo.toml` `[workspace.package].version` are all `0.1.0-beta.6`. The desktop crate `bloblex-desktop` uses `version.workspace = true`. Product name is `Bloblex`. Identifier is `com.bloblex.desktop`.

`docs/releases/0.1.0-beta.6.md` is the note for this beta. Outside `-DryRun`, `scripts/release-windows.ps1` refuses to publish until the four version fields above equal the `-Version` argument.

## Release command

Status: **done** (script and manifest helper). Publishing a GitHub release is **needs user**.

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-windows.ps1 -Version 0.1.0-beta.1
```

`-DryRun` runs preflight, the bundle build, and manifest generation, prints the `gh` commands it would run, and does not execute `gh`, create a tag, or push. Add `-SkipBuild` to reuse an existing NSIS output directory, and `-BundleDir` to point that directory at a folder of `*-setup.exe` and matching `.sig` files (used to exercise the script without a real bundle). `-Repo` defaults to `sico-vibes/bloblex`.

The script checks a clean `main` checkout, exact version equality across the four manifests, that tag `v<version>` is absent locally and on the remote, and that `gh auth status` succeeds. `-DryRun` reports those repo-state checks and continues with a warning when they fail, and it skips `gh auth status` and the remote tag lookup. It still refuses a version that is not semver.

Pre-release versions (for example `0.1.0-beta.1`) are published with `gh release create ... --prerelease --latest=false`. A version with no pre-release part omits both flags so GitHub can mark it Latest.

## Produce an installer

Status: **needs user**

`npm run desktop:bundle` runs `scripts/bundle-windows.ps1`, which:

1. Sets `CARGO_TARGET_DIR` to `target\desktop-release` when the variable is unset.
2. Runs `cargo build -p bloblex-daemon --bin bloblexd -p bloblex-hook --bin bloblex-hook --release`.
3. Runs `node scripts/stage-daemon.mjs --release`, which copies the sidecars to `apps/desktop/src-tauri/binaries/` with the Tauri target-triple suffix.
4. Runs `npm run desktop -- build`, which is `tauri build` for `@bloblex/desktop`.

The release artifact is the NSIS installer only. An MSI is not a Bloblex release artifact: an MSI version cannot carry a `-beta.N` pre-release. `docs/UPDATER.md` sets the Windows bundle target to `nsis` only. The release script globs `<CARGO_TARGET_DIR>\release\bundle\nsis\*-setup.exe`, keeps the file whose name matches the release version, and requires the sibling `<installer>.sig`. It does not upload an MSI.

`tauri.conf.json` in this worktree still has `bundle.targets` of `nsis` and `msi`, and `bundle.createUpdaterArtifacts` is `false`. That file is owned by the Tauri lane; this checklist does not edit it. Until `createUpdaterArtifacts` is enabled and the target list is `nsis`, `tauri build` will not emit the `.sig` the release script requires, and it may still emit an MSI that the release script ignores. No installer path or file size is recorded here because the bundle command was not run.

At review time `apps/desktop/src-tauri/binaries/` contained `bloblex-hook-x86_64-pc-windows-msvc.exe` only. The daemon sidecar is produced by the bundle script; it was not built for this note.

Configured bundle icons exist on disk: `assets/icon/bloblex.ico` and `assets/icon/bloblex-master.png` (the paths in `bundle.icon`). `assets/icon/tray.png` is also present; the tray image is embedded from Rust, which this note does not change.

`bundle.resources` is `[]`. In the Tauri 2 schema that field is a list of paths or a source-to-target map, and an empty list is valid. No resource path is left for the bundler to resolve.

## Update manifest and channels

Status: **done** (helper and release script). No manifest has been published. That publish is **needs user**.

`scripts/make-update-manifest.mjs` writes the Tauri updater static file `latest.json`:

`{ "version", "notes", "pub_date", "platforms": { "windows-x86_64": { "signature", "url" } } }`

Notes come from `docs/releases/<version>.md`. If that file is missing or blank, the note is the single line `Bloblex <version>`. The signature is the trimmed `.sig` file. The asset URL is `https://github.com/<repo>/releases/download/v<version>/<installer file name>`.

| Channel | Gets | Manifest URL |
| --- | --- | --- |
| `stable` | non-pre-release releases only | `https://github.com/sico-vibes/bloblex/releases/latest/download/latest.json` |
| `beta` (default while only betas exist) | every release, beta or stable | `https://github.com/sico-vibes/bloblex/releases/download/channel-beta/latest.json` |

`releases/latest` ignores pre-releases, so the stable URL only resolves once a normal release exists. `channel-beta` is a rolling pre-release. Its only job is to hold the newest `latest.json`. On every release the script creates `channel-beta` if it does not exist (`--prerelease`, `--latest=false`, `--target main`, fixed short note) and then runs `gh release upload channel-beta latest.json --clobber`. The same `latest.json` is also attached to the versioned release. Installer URLs inside the manifest point at that versioned release's NSIS asset.

## Updater key

Status: **needs user**

The updater key is a minisign key pair used by the Tauri updater plugin. It is not a Windows code-signing certificate. The release script reads the private key and password only while `npm run desktop:bundle` runs, from `%USERPROFILE%\.bloblex-release\updater.key` and `updater.pass`, or from `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when those are already set. It then removes them from the process environment. It does not print them.

The public half belongs in `tauri.conf.json` under `plugins.updater.pubkey` (`docs/UPDATER.md`). This worktree's `tauri.conf.json` has no `plugins.updater` block. Putting that public key in the config is the Tauri lane's file, and generating the key pair is the user's.

Losing the private key means existing installs cannot accept future updates: the app keeps the old public key and will reject signatures from a new key. Never commit `updater.key`, `updater.pass`, or the private-key environment values. This checklist did not read or copy `%USERPROFILE%\.bloblex-release`.

## Publishing a stable release later

Status: **needs user**

1. Set root `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, and the Cargo workspace `version` to the same non-pre-release semver (the current tree is `0.1.0-beta.6`).
2. Add `docs/releases/<version>.md`.
3. From a clean `main` checkout, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-windows.ps1 -Version <version>`.
4. Because the version has no pre-release part, the script does not pass `--prerelease` or `--latest=false`. GitHub can mark that release as Latest.
5. `latest.json` is attached to the versioned release and uploaded again to `channel-beta` with `--clobber`, so beta installs see the stable build too.
6. Stable installs then resolve `https://github.com/sico-vibes/bloblex/releases/latest/download/latest.json`. Beta installs keep using the `channel-beta` URL above.

Use `-DryRun` first. A dry run still needs the updater signing key if it is allowed to build.

## Code-signing certificate

Status: **needs user**

`tauri.conf.json` has no `bundle.windows.certificateThumbprint` and no `signCommand`. No certificate or Store identity is in the repo. The updater minisign key does not replace this certificate. An unsigned installer can be produced once bundling is configured; a trusted Windows install still needs a certificate or Store submission supplied by the user. Until then, Windows may show a SmartScreen warning on a first manual install. `docs/implementation-status.md` (WP-16) and `docs/windows-development.md` record the same certificate gap.

## Clean-VM install

Status: **needs user**

No clean virtual machine install, repair, upgrade, or uninstall was run. `docs/implementation-status.md` (WP-16) and `docs/NATIVE_SMOKE_RESULTS.md` leave installer and clean-install proof open. A machine without WebView2 will hit the configured download bootstrapper; that download was not exercised.

## WSL path

Status: **blocked**

`docs/implementation-status.md` (WP-15) records inventory and path helpers only. Usable distro probes, launch of distinct Claude Code, Codex, and OpenCode runtimes, and Windows/WSL session cleanup are still open. The only distro noted as available on the review machine was Docker's internal distro, which the status file says must not be used as a stand-in. This item needs both the remaining runtime work and a real development distro from the user.

## Native smoke (Phase 7)

From `docs/E2E_PLAN_V2.md` Phase 7. Where a row says recorded, the evidence is `docs/NATIVE_SMOKE_RESULTS.md` (2 October 2026, revision `e770db8`, isolated database). That pass was not repeated for this checklist.

| Check | Status | Note |
| --- | --- | --- |
| Companion transparency | done | Recorded pass (wallpaper visible at the island corners). Not re-run. |
| Free drag | blocked | Recorded pass from the top strip only. Drag from the face or the name does nothing (defect N1). |
| DPI and multiple monitors | needs user | The recorded pass used one monitor at 100% DPI. |
| Resize timing | blocked | Recorded defect N2: expanding the companion near a monitor edge is not clamped. The clamp lives in the native window code. |
| Real file drop | needs user | Listed as not covered in the recorded smoke. |
| Approvals in both windows | needs user | Not recorded as a pass in that smoke. |
| Tray, including Pause all | needs user | The recorded menu lists Pause all. The action itself was not run. |
| Keyboard and focus | needs user | Mounted tests cover the Settings dialog, the blob confirm dialog, and Analytics tabs. A native keyboard pass was not run. |
| Reduced motion | needs user | Stylesheets shorten or disable the settings sheet and analytics skeleton animations. A native reduced-motion pass was not run. |
| Quit and process-tree cleanup | done | Recorded pass for Quit from the app menu on that build. Not re-run. |

## Content security policy

Status: **done** (present in `app.security.csp`; not exercised in a WebView)

The policy is one line in `tauri.conf.json`. Remote and special origins it allows:

| Directive | Origins |
| --- | --- |
| `default-src`, `script-src`, `base-uri` | `'self'` only. Scripts are not loaded from a network host. |
| `style-src` | `'self'` and `'unsafe-inline'` (inline style attributes in the shell). |
| `img-src` | `'self'`, `asset:`, `http://asset.localhost`, `blob:`, `data:` |
| `font-src` | `'self'`, `data:` |
| `connect-src` | `'self'`, `ipc:`, `http://ipc.localhost`, `http://127.0.0.1:1420`, `ws://127.0.0.1:1420` |
| `object-src` | `'none'` |
| `frame-ancestors` | `'none'` |

`http://asset.localhost` and `http://ipc.localhost` are the Tauri asset and IPC hosts. `127.0.0.1:1420` is the local Vite dev server (HTTP and WebSocket). No public internet origin is listed. The dev port is also what `beforeDevCommand` / `devUrl` use. A generated dev config can retarget that port; the committed policy names 1420.

## Capabilities

Status: **done** as a review; the file was not edited.

`apps/desktop/src-tauri/capabilities/default.json` grants `core:event:allow-listen`, `core:event:allow-unlisten`, and `core:window:allow-start-dragging` to the `main` and `companion` windows. The webview does not import the dialog, opener, or window-state plugin packages. Those plugins are initialized from Rust. Application invoke handlers are not listed as extra capability permissions in that file; the 2 October native smoke still reached daemon RPC, the tray, and window drag.

## About page

Status: **done**

Settings → General → About is read-only: version from `apps/desktop/package.json` (same `0.1.0` as `tauri.conf.json`), channel `local build`, `Updates: not configured`, `Signing: not configured`. There is no update or sign control. That text matches `apps/desktop/src/ui/SettingsSheet.tsx` in this worktree. Wiring it to the updater is outside this checklist.
