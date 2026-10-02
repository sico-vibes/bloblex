# Release checklist

Source and config review only. No installer was built, no app or daemon was started, and no signing material was added while writing this file. Status values are `done`, `needs user`, or `blocked`.

Versions read from the tree: root `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, and the workspace `Cargo.toml` `[workspace.package].version` are all `0.1.0`. The desktop crate `bloblex-desktop` uses `version.workspace = true`. Product name is `Bloblex`. Identifier is `com.bloblex.desktop`.

## Produce an installer

Status: **needs user**

From the repository root, the configured command is:

```powershell
npm run desktop:bundle
```

That runs `scripts/bundle-windows.ps1`, which:

1. Sets `CARGO_TARGET_DIR` to `target\desktop-release` when the variable is unset.
2. Runs `cargo build -p bloblex-daemon --bin bloblexd -p bloblex-hook --bin bloblex-hook --release`.
3. Runs `node scripts/stage-daemon.mjs --release`, which copies the sidecars to `apps/desktop/src-tauri/binaries/` with the Tauri target-triple suffix.
4. Runs `npm run desktop -- build`, which is `tauri build` for `@bloblex/desktop`.

`tauri.conf.json` sets bundle targets to `nsis` and `msi`, NSIS `installMode` to `currentUser`, and WebView2 `webviewInstallMode` to `downloadBootstrapper` (silent). Tauri writes those bundles under the release `bundle` directory of `CARGO_TARGET_DIR`. This checklist did not run the command, so no installer path or file size is recorded here.

At review time `apps/desktop/src-tauri/binaries/` contained `bloblex-hook-x86_64-pc-windows-msvc.exe` only. The daemon sidecar is produced by the bundle script; it was not built for this note.

Configured bundle icons exist on disk: `assets/icon/bloblex.ico` and `assets/icon/bloblex-master.png` (the paths in `bundle.icon`). `assets/icon/tray.png` is also present; the tray image is embedded from Rust, which this note does not change.

`bundle.resources` is `[]`. In the Tauri 2 schema that field is a list of paths or a source-to-target map, and an empty list is valid. No resource path is left for the bundler to resolve. `bundle.createUpdaterArtifacts` is `false`.

## Code-signing certificate

Status: **needs user**

`tauri.conf.json` has no `bundle.windows.certificateThumbprint` and no `signCommand`. No certificate or Store identity is in the repo. An unsigned local installer can be produced by the command above; a trusted Windows release still needs a certificate or Store submission supplied by the user. `docs/implementation-status.md` (WP-16) and `docs/windows-development.md` record the same gap.

## Updater key

Status: **needs user**

The desktop crate does not depend on `tauri-plugin-updater`. `tauri.conf.json` has no `plugins.updater` block, and `createUpdaterArtifacts` is false. An updater public key, a signing key, and a signed update endpoint are not configured. The Settings General page states `Updates: not configured` and `Signing: not configured` as read-only text.

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

Settings → General → About is read-only: version from `apps/desktop/package.json` (same `0.1.0` as `tauri.conf.json`), channel `local build`, `Updates: not configured`, `Signing: not configured`. There is no update or sign control.
