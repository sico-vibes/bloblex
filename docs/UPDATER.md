# Auto-update and release contract

Goal: any release published to the Bloblex repository (stable or beta) can be found, downloaded and installed from inside the app.

## Decisions

- Update source: GitHub Releases of `sico-vibes/bloblex` (the repository becomes public for this; the app downloads with no login or token).
- Mechanism: the Tauri v2 updater plugin (`tauri-plugin-updater`) plus `tauri-plugin-process` (relaunch). Updates are verified with a minisign signature (the Tauri updater key pair). This is NOT Windows code signing: installers stay unsigned by a certificate, so Windows SmartScreen may warn on a first manual install. The updater key is separate and mandatory.
- Windows bundle target: `nsis` only (the NSIS installer is the updater artifact). MSI is dropped: it cannot carry a `-beta.N` pre-release version.
- Installer mode for updates: `passive` (progress shown, no questions).
- Versions are semver. `0.1.0-beta.1 < 0.1.0-beta.2 < 0.1.0`. The version lives in `package.json` (root and apps/desktop), `apps/desktop/src-tauri/tauri.conf.json` and the Cargo workspace version, and they must always match (the release script checks this).

## Channels

| Channel | Gets | Manifest URL |
| --- | --- | --- |
| `stable` | non-pre-release releases only | `https://github.com/sico-vibes/bloblex/releases/latest/download/latest.json` |
| `beta` (default while only betas exist) | every release, beta or stable | `https://github.com/sico-vibes/bloblex/releases/download/channel-beta/latest.json` |

`releases/latest` ignores pre-releases, so the `stable` URL only resolves once a normal release exists (a "not found" there is reported as "no stable release yet", never as an error banner). `channel-beta` is a rolling pre-release whose only job is to hold the newest `latest.json`; the release script uploads `latest.json` to it (replacing the old one) for EVERY release, and also attaches `latest.json` to the release itself. Installer download URLs inside the manifest point at the specific release's asset.

Manifest format (Tauri updater static JSON): `{ "version", "notes", "pub_date", "platforms": { "windows-x86_64": { "signature": "<contents of the .sig file>", "url": "<release asset URL of the NSIS .exe>" } } }`.

## App behaviour

- Preferences (persisted on the device, in the same place the existing `closeToTray`/companion preferences live): `channel` (`stable`|`beta`, default `beta`) and `autoCheck` (bool, default true).
- Background checker (Rust): first check about 15 s after start, then every 6 hours, only when `autoCheck` is true. A found update emits `bloblex-update-available`. Never installs on its own; the user chooses Install.
- Manual "Check now" works regardless of `autoCheck`.
- Install: downloads with progress events, then runs the passive installer which closes and relaunches the app. The UI warns before installing when any session is running or waiting for approval (the daemon and running turns end when the app exits) and requires an explicit confirm.
- Failure handling: network failure, bad signature, missing manifest and no-stable-release are shown as short safe messages, never raw error text, and never block the app. A downgrade is never offered (the plugin compares versions).
- Dev builds (`desktop:dev`) report "Updates unavailable in development builds" and never check.

## Tauri commands and events (UI contract)

Commands (invoke names, camelCase arguments, JSON results):

- `updates_get_state` -> `{ currentVersion: string, channel: "stable"|"beta", autoCheck: boolean, lastCheckedAt: string|null, available: UpdateInfo|null, devBuild: boolean }`
- `updates_set_preferences { channel?: "stable"|"beta", autoCheck?: boolean }` -> the new state (invalid channel -> `invalid_argument`).
- `updates_check` -> `{ status: "up_to_date"|"available"|"no_stable_release"|"error", update?: UpdateInfo, checkedAt: string, error?: string }` where `error` is one of the fixed strings `network`, `signature`, `manifest`, `unavailable`.
- `updates_install` -> resolves when the installer has been launched (the app then exits); rejects with `{code, message}` using the same fixed error strings plus `no_update`.

`UpdateInfo = { version: string, notes: string|null, pubDate: string|null, channel: "stable"|"beta" }`.

Events (listen names): `bloblex-update-available` (payload `UpdateInfo`), `bloblex-update-progress` (payload `{ phase: "downloading"|"installing", downloadedBytes: number, totalBytes: number|null }`).

## Release process (scripts/release-windows.ps1)

1. Verify a clean working tree on `main`, matching versions everywhere, the given tag does not exist, and `gh` is authenticated.
2. Read the updater private key and password from outside the repo (`%USERPROFILE%\.bloblex-release\updater.key` and `updater.pass`, or the `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` environment variables). Never print them, never write them into the repo or logs.
3. Run the existing bundle build (daemon and hook in release, stage the daemon, `tauri build` with updater artifacts), producing the NSIS installer and its `.sig`.
4. Generate `latest.json` for the version, release notes taken from `docs/releases/<version>.md` (or a default line).
5. Create the GitHub release (`--prerelease` when the version has a pre-release part) with the installer, its `.sig` and `latest.json`; then create-or-update the `channel-beta` pre-release and upload `latest.json` to it with `--clobber`.
6. Print the release URL and the SHA-256 of the installer. Support `-DryRun` (everything except the `gh` calls and tagging).

The public key is committed in `tauri.conf.json` (`plugins.updater.pubkey`); the private key is never committed.
