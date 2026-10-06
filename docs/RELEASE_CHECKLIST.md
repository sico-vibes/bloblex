# Release checklist

Updated 6 October 2026. Manual-only `v0.1.0-beta.8` is published. The current source is `v0.1.0-beta.9`, being prepared as the next manual-only beta. The signed updater manifest on rolling `channel-beta` remains at `v0.1.0-beta.6`; manual-only betas do not change that feed. No clean-machine install has been recorded. Status values are `done`, `needs user`, or `blocked`.

Versions read from this worktree: root `package.json`, `package-lock.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, and the workspace `Cargo.toml` `[workspace.package].version` are all `0.1.0-beta.9`. Cargo.lock entries for crates that inherit the workspace version are beta.9; the internal `bloblex-agent-core` and `bloblex-protocol` libraries remain independently versioned at `0.1.0`. The desktop crate `bloblex-desktop` uses `version.workspace = true`. Product name is `Bloblex`. Identifier is `com.bloblex.desktop`.

`docs/releases/0.1.0-beta.9.md` is the note for the current manual-only beta. The signed release script is not used for unsigned manual releases. For a future signed release, `scripts/release-windows.ps1` refuses to publish until the four version fields above equal the `-Version` argument.

## Release command

Status: **done**. The [`v0.1.0-beta.8`](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.8) manual-only prerelease is published with its installer and `SHA256SUMS.txt`. Earlier manual-only beta.7 is also available. The signed updater feed remains at beta.6; beta.8 has no updater signature/manifest and did not change `channel-beta`.

The release script's dry run completed the production bundle and manifest validation on the requested beta branch. It warned that direct publishing normally requires `main`; after validating the installer/signature/manifest, the equivalent GitHub release and channel upload commands were run against this explicitly requested beta branch. For the standard scripted flow on a future release, use a clean `main` checkout.

For a future signed release, from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-windows.ps1 -Version <version>
```

`-DryRun` runs preflight, the bundle build, and manifest generation, prints the `gh` commands it would run, and does not execute `gh`, create a tag, or push. Add `-SkipBuild` to reuse an existing NSIS output directory, and `-BundleDir` to point that directory at a folder of `*-setup.exe` and matching `.sig` files (used to exercise the script without a real bundle). `-Repo` defaults to `sico-vibes/bloblex`.

The script checks a clean `main` checkout, exact version equality across the four manifests, that tag `v<version>` is absent locally and on the remote, and that `gh auth status` succeeds. `-DryRun` reports those repo-state checks and continues with a warning when they fail, and it skips `gh auth status` and the remote tag lookup. It still refuses a version that is not semver.

Pre-release versions (for example `0.1.0-beta.1`) are published with `gh release create ... --prerelease --latest=false`. A version with no pre-release part omits both flags so GitHub can mark it Latest.

## Produce an installer

Status: **done for beta.8 manual install**. `Bloblex_0.1.0-beta.8_x64-setup.exe` (7,352,283 bytes; SHA-256 `a4b8af9587078b808cf4675af3f3cbeac1c07adf600f02e395c31d2042e93fed`) was built from commit `e9e4bd7` in a short-path checkout. Windows Authenticode reports `NotSigned`; no Tauri updater signature was generated. The historical beta.6 NSIS build had an updater signature.

`npm run desktop:bundle` runs `scripts/bundle-windows.ps1`, which:

1. Sets `CARGO_TARGET_DIR` to `target\desktop-release` when the variable is unset.
2. Runs `cargo build -p bloblex-daemon --bin bloblexd -p bloblex-hook --bin bloblex-hook --release`.
3. Runs `node scripts/stage-daemon.mjs --release`, which copies the sidecars to `apps/desktop/src-tauri/binaries/` with the Tauri target-triple suffix.
4. Runs `npm run desktop -- build`, which is `tauri build` for `@bloblex/desktop`.

The release artifact is the NSIS installer only. An MSI is not a Bloblex release artifact: an MSI version cannot carry a `-beta.N` pre-release. `docs/UPDATER.md` sets the Windows bundle target to `nsis` only. The release script globs `<CARGO_TARGET_DIR>\release\bundle\nsis\*-setup.exe`, keeps the file whose name matches the release version, and requires the sibling `<installer>.sig`. It does not upload an MSI.

`tauri.conf.json` has `bundle.targets: ["nsis"]`, `createUpdaterArtifacts: true`, the updater public key, and stable/beta endpoints. For beta.8 only, the build overrode `bundle.createUpdaterArtifacts` to `false` and passed `--no-sign`; this produced no `.sig` and no `latest.json`. The rolling beta channel was left unchanged.

The beta.6 bundle run staged both `bloblexd-x86_64-pc-windows-msvc.exe` and `bloblex-hook-x86_64-pc-windows-msvc.exe` in `apps/desktop/src-tauri/binaries/` for packaging. These are local bundle outputs, not source changes.

Configured bundle icons exist on disk: `assets/icon/bloblex.ico` and `assets/icon/bloblex-master.png` (the paths in `bundle.icon`). `assets/icon/tray.png` is also present; the tray image is embedded from Rust, which this note does not change.

`bundle.resources` is `[]`. In the Tauri 2 schema that field is a list of paths or a source-to-target map, and an empty list is valid. No resource path is left for the bundler to resolve.

## Update manifest and channels

Status: **done for beta.6**. The signed `latest.json` is attached to `v0.1.0-beta.6` and the rolling `channel-beta` asset remains at version `0.1.0-beta.6`; unsigned manual-only beta.7 and beta.8 do not replace it.

`scripts/make-update-manifest.mjs` writes the Tauri updater static file `latest.json`:

`{ "version", "notes", "pub_date", "platforms": { "windows-x86_64": { "signature", "url" } } }`

Notes come from `docs/releases/<version>.md`. If that file is missing or blank, the note is the single line `Bloblex <version>`. The signature is the trimmed `.sig` file. The asset URL is `https://github.com/<repo>/releases/download/v<version>/<installer file name>`.

| Channel | Gets | Manifest URL |
| --- | --- | --- |
| `stable` | non-pre-release releases only | `https://github.com/sico-vibes/bloblex/releases/latest/download/latest.json` |
| `beta` (default while only betas exist) | every release, beta or stable | `https://github.com/sico-vibes/bloblex/releases/download/channel-beta/latest.json` |

`releases/latest` ignores pre-releases, so the stable URL only resolves once a normal release exists. `channel-beta` is a rolling pre-release. Its only job is to hold the newest `latest.json`. On every release the script creates `channel-beta` if it does not exist (`--prerelease`, `--latest=false`, `--target main`, fixed short note) and then runs `gh release upload channel-beta latest.json --clobber`. The same `latest.json` is also attached to the versioned release. Installer URLs inside the manifest point at that versioned release's NSIS asset.

## Updater key

Status: **done for beta.6**. The existing Tauri updater key files were used by the release build; no private key material was committed.

The updater key is a minisign key pair used by the Tauri updater plugin. It is not a Windows code-signing certificate. The release script reads the private key and password only while `npm run desktop:bundle` runs, from `%USERPROFILE%\.bloblex-release\updater.key` and `updater.pass`, or from `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when those are already set. It then removes them from the process environment. It does not print them.

The public half is configured in `tauri.conf.json` under `plugins.updater.pubkey` (`docs/UPDATER.md`).

Losing the private key means existing installs cannot accept future updates: the app keeps the old public key and will reject signatures from a new key. Never commit `updater.key`, `updater.pass`, or the private-key environment values. The release script loaded the existing files into its build process and removed them from the process environment afterward.

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

Status: **done** (source reviewed for beta.6; not a native UI check).

Settings → Updates includes an About group with `Code signing: Not configured`, matching the unsigned Windows installer. The source version metadata is now `0.1.0-beta.8` across the package, Tauri and Cargo workspace manifests. This source review is not a native window or installed-app verification, and beta.8 has not yet been built or installed.
