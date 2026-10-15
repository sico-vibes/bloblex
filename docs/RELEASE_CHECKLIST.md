# Release checklist

Updated 14 October 2026. Manual-only `v0.1.0-beta.29` is published and is the newest versioned GitHub release. The signed updater manifest on rolling `channel-beta` remains at `v0.1.0-beta.6`; manual-only betas do not change that feed. No clean-machine install has been recorded. Status values are `done`, `needs user`, or `blocked`.

Versions read from this worktree: root `package.json`, `package-lock.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, and the workspace `Cargo.toml` `[workspace.package].version` are all `0.1.0-beta.29`. Cargo.lock entries for the 15 crates inheriting the workspace version are beta.28 in this checkout; the internal `bloblex-agent-core` and `bloblex-protocol` libraries remain independently versioned at `0.1.0`. The desktop crate `bloblex-desktop` uses `version.workspace = true`. Product name is `Bitbots`, `mainBinaryName` is `Bitbots` (so the executable is `Bitbots.exe`), and the identifier is `com.bitbots.desktop` (development builds use `com.bitbots.desktop.dev`).

`docs/releases/0.1.0-beta.29.md` is the published note for the current manual-only beta. The signed release script is not used for unsigned manual releases. For a future signed release, `scripts/release-windows.ps1` refuses to publish until the four version fields above equal the `-Version` argument.

## Release command

**Last step of every release: clean up.** Once the release is published and its asset digests match, remove the build worktree and its `target` and any reviewed lane worktrees, as set out in the 14 October 2026 amendment in `AGENTS.md` (remove the `node_modules` junction first, as a link). Note the space recovered in the release entry below.

Status: **done for beta.29**. The [v0.1.0-beta.29](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.29) prerelease is published from `cbbc48a` with its unsigned NSIS installer `Bitbots_0.1.0-beta.29_x64-setup.exe` (14,239,140 bytes; SHA-256 `e311d0a79d7f63316f57ccccc40e4538a830d44d53b9d1b1b92d2619be0d7ef7`) and `SHA256SUMS.txt`; both GitHub asset digests match the local files. Main and the annotated tag are pushed. Built in `C:\b29` (a worktree at `cbbc48a`) with `--no-sign` and `createUpdaterArtifacts:false` passed as a config file; the staged daemon and hook hashes match the compiled release binaries and Authenticode status is `NotSigned` for the installer and the app. This is the first release under the Bitbots identity: new bundle identifier, `Bitbots.exe`, `bitbotsd` and `bitbots-hook` sidecars, an NSIS pre-install hook and a first-launch data migration; **none of these have been exercised on a real Bloblex install** (see the release note for what to check). Gates before the build: desktop typecheck and 875 tests, daemon 157, storage 92, desktop `snap::` 8, workspace clippy clean. Contents: the Bitbots and Blobots looks, guided tour and hints, bot editor rebuild and create wizard, companion upgrades, resilience and conversation work, Remote mode as a browser-preview design only. Cleanup per the 14 October amendment: `C:\b29` removed.

Status: **done for beta.28**. The [v0.1.0-beta.28](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.28) prerelease is published from `4474fa6` with its unsigned NSIS installer (14,202,875 bytes; SHA-256 `eddc9c8f7167bc4f421b0998f4760ecdaf86bd63af59aa81f1fd5f6a9ca79b43`) and `SHA256SUMS.txt`; both GitHub asset digests match local files. Main and the annotated tag are pushed. Built in `C:\b28` (a detached worktree at `4474fa6`) with `--no-sign` and `createUpdaterArtifacts:false` passed as a config file; the staged daemon hash matches the compiled release binary and Authenticode status is `NotSigned` for both the installer and the app. Gates: desktop typecheck and 553 desktop tests; no Rust source changed since beta.27 (520 tests passed there), so the Rust workspace was not re-run. Contents: a layout regression fix. The send button was 2 px wide in the pixel-robot theme because a beta.27 rule for the model pill divider had been inserted inside the send and microphone button selector; the composers now grow with the text; the companion composer is two rows with menus kept inside the window; the permission label collapses by container width instead of any window under 940 px; the startup checklist is centred. Layout was measured in the browser preview at 860 px (send button 32 x 32 inside, strip overflow 0, input 30 to 246 px with 12 sentences); the installed native windows were not checked. Cleanup per the 14 October amendment: `C:\b28` removed.

Status: **done for beta.27**. The [v0.1.0-beta.27](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.27) prerelease is published from `d479e9c` with its unsigned NSIS installer (14,201,157 bytes; SHA-256 `4ef086bb99c21a44e4024670230c0251dbb230f54ff3922ba19a595bbbd75ef8`) and `SHA256SUMS.txt`; both GitHub asset digests match local files. Main and the annotated tag are pushed. Built in `C:\b27` (a detached worktree at `d479e9c`) with `--no-sign` and `createUpdaterArtifacts:false` passed as a config file; the staged daemon hash matches the compiled release binary and Authenticode status is `NotSigned` for both the installer and the app. Gates before the build: 520 Rust workspace tests excluding desktop (with `RUST_MIN_STACK=33554432` and `--test-threads=4`), `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings` clean, desktop typecheck and 553 desktop tests. Contents: OpenCode 2 usage (stored OAuth login, access token only, never the refresh token) and sign-in (credential presence read-only, CLI only as a fallback; both verified live on OpenCode 2.0.28), "Messaged X" notices placed above their turn's text, dictation reduced to On device or Cloud with an ask-first model download and no engine labels, model names with the provider icon and Claude grouped by family, and the companion rework (settings, volume, composer, framed replies, chevron, mention spacing). Known flake: `catalog_timeout_kills_the_child_and_failure_is_provider_unavailable` times out in a loaded full parallel run (passes alone and with fewer threads). Not done: the release-daemon boot smoke; the dictation download dialog and the companion window were checked in the browser preview and by tests, not in the installed native app. Cleanup per the 14 October amendment: `C:\b27`, the lane and subagent worktrees and their branches, and scratch removed.

Status: **done for beta.26**. The [v0.1.0-beta.26](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.26) prerelease is published from `bb859fa` with its unsigned NSIS installer (14,177,796 bytes; SHA-256 `5c7739ea3a0117f0a56fae3a686a4aa069163210e50ef091d9cfc3ba3b28a74c`) and `SHA256SUMS.txt`; both GitHub asset digests match local files. Main and the annotated tag are pushed. Built in `C:26` (a detached worktree at `bb859fa`) with `--no-sign` and `createUpdaterArtifacts:false` passed as a config file; the staged daemon hash matches the compiled release binary and Authenticode status is `NotSigned` for both the installer and the app. Gates before the build: 502 Rust workspace tests excluding desktop (with `RUST_MIN_STACK=33554432`) and `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings` clean; no desktop source changed since beta.25. Contents: an OpenCode conversation restarts its process with the new instructions (and reloads the same provider session) when the blob's instructions or environment change, instead of failing with "instructions are fixed for the running OpenCode process". Verified live against OpenCode 2.0.28 with `opencode/big-pickle`: turn 1 answered the first instruction, the instructions changed, turn 2 on the same conversation answered the new one, turn 3 (unchanged) succeeded. Known flake: `catalog_timeout_kills_the_child_and_failure_is_provider_unavailable` can fail on the first run after the adapter is rebuilt on this machine; it passes on re-run and fails the same way on the commit before these fixes. Not done: the release-daemon boot smoke, a restart in the same message as a model or effort change. Cleanup per the 14 October amendment: `C:26` and the FIX6 lane worktree and branch removed.

Status: **done for beta.25**. The [v0.1.0-beta.25](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.25) prerelease is published from `0374367` with its unsigned NSIS installer (14,173,948 bytes; SHA-256 `002641d2f2104b2d26d2c2c6d534935f6c184713e382edfa112a5c4ae33c36a2`) and `SHA256SUMS.txt`; both GitHub asset digests match local files. Main and the annotated tag are pushed; `main` additionally carries the clippy part 1 cleanup (`e47412a`) and docs commits, which are not part of the tagged build. Built in `C:25` (a detached worktree at `0374367`) with `--no-sign` and `createUpdaterArtifacts:false` passed as a config file; the staged daemon hash matches the compiled release binary and Authenticode status is `NotSigned` for both the installer and the app. Gates before the build: 497 Rust workspace tests excluding desktop (with `RUST_MIN_STACK=33554432`); no desktop source changed since beta.24 (typecheck and the production web build ran inside `tauri build`). Contents: OpenCode 2 per-model effort levels (each model selected once in a throwaway ACP session and its `effort` option read back) and a validated catalog when every model answered. Verified live against OpenCode 2.0.28: 114 models, 92 with levels, `deepseek-v4.1-flash` low/high/max, validated, 3.6 s. Not done: a real conversation at a chosen effort, the release-daemon boot smoke. Cleanup per the 14 October amendment: `C:25`, the FIX4 part 1 and FIX5 lane worktrees and branches, and scratch probes removed; about 4.6 GB recovered (the main checkout's `target` and `node_modules` kept; the clippy part 2 lane worktree is still in use).

Status: **done for beta.24**. The [v0.1.0-beta.24](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.24) prerelease is published from `c2fca03` with its unsigned NSIS installer (14,170,249 bytes; SHA-256 `cc941d083c596e4c9fbb1701e43e5cc8f0e484bc3b214d17db7021708000b15d`) and `SHA256SUMS.txt`; both GitHub asset digests match local files. Main and the annotated tag are pushed; `main` additionally carries the build-cleanup rule commit `daf525e`, which is not part of the tagged build. Built in `C:24` (a detached worktree at `c2fca03`) with `--no-sign` and `createUpdaterArtifacts:false` passed as a config file; the staged daemon hash matches the compiled release binary and Authenticode status is `NotSigned` for both the installer and the app. Gates before the build: 494 Rust workspace tests excluding desktop (with `RUST_MIN_STACK=33554432`), desktop typecheck and 522 desktop tests (the production web build runs inside `tauri build`). Contents: OpenCode 2 launch fix (`acp --cwd` removed; verified live against 2.0.28: catalog of 115 models in about 2 seconds), the Codex team-instruction update with echo-only evidence, and the settings-note copy. Not done: a real OpenCode conversation end to end, a live Codex turn for the instruction update, the release-daemon boot smoke. Cleanup per the 14 October amendment: `C:24`, the docs lane worktree and its branch, and 521 MB of scratch probes removed; about 5.4 GB recovered (the main checkout's `target` and `node_modules` kept).

Status: **done for beta.23**. The [v0.1.0-beta.23](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.23) prerelease is published from `23395c3` with its unsigned NSIS installer (14,165,249 bytes; SHA-256 `638c4e827365afb6508f9343eb847f39cd27de0abd01b523d9ece61994554f9c`) and `SHA256SUMS.txt`; both GitHub asset digests match local files. Main and the annotated tag are pushed. Built in `C:\b23` (a detached worktree at `23395c3`; this machine has no `D:` drive) with `--no-sign` and `createUpdaterArtifacts:false` passed as a config file, because the inline JSON override was mangled by the Windows shell; the staged daemon hash matches the compiled release binary and Authenticode status is `NotSigned` for both the installer and the app. Gates before the build: 483 Rust workspace tests excluding desktop (with `RUST_MIN_STACK=33554432`), desktop typecheck, 522 desktop tests and the production web build (run by `tauri build`). Contents: OpenCode 2 sign-in and version detection (`auth list` rows read, `stored` is signed in, `v`-prefixed version read, a plain `models` listing reports only a quiet unknown), effort picker width and Ultracode gradient, Claude model names carrying their release, centred check marks and the Bitbots pixel launch animation. Verified live against OpenCode 2.0.28 on the build machine (`online`, `Authenticated`, no probe error). Not done: the release-daemon boot smoke against a temporary database. Unverified: the UI in the installed native windows, a machine with no OpenCode credentials, and clean-machine installation. Known open issue: a Codex thread keeps the team instructions it started with, so a blob made leader after its thread began still believes it cannot create blobs.

Status: **done for beta.22**. The [v0.1.0-beta.22](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.22) prerelease is published from `b42cd6e` with its unsigned NSIS installer (14,204,046 bytes; SHA-256 `ff8f1c0009dddef66d14e194c7675d65d1dd057eefc211075508aea1eb4fe066`) and `SHA256SUMS.txt`; both GitHub asset digests match local files. Main and the annotated tag are pushed; `main` additionally carries this checklist entry, which is not part of the tagged build. Built in `D:\b22` (a detached worktree at `b42cd6e`) with `--no-sign` and `createUpdaterArtifacts:false`; the staged daemon hash matches the compiled release binary and Authenticode status is `NotSigned` for both the installer and the app. Gates before the build: 477 Rust workspace tests excluding desktop, desktop typecheck, 520 desktop tests and the production web build. **The daemon binary tests need `RUST_MIN_STACK=33554432` on this machine**: without it one async test overflows its test-thread stack in the debug build (`phase2a_tests::agent_notification_level_is_validated_and_carried_in_dto_and_events`). That is pre-existing, unrelated to this release, and reproduces with this release's changes stashed. Contents: cloud dictation gets past OpenAI's edge by switching the cloud client from the platform TLS stack (SChannel, challenged) to rustls (accepted), verified live with the shipped client (`challenged` → `ok`, reproduced twice); the request, headers, identity, consent, fallback and cookie retry are unchanged. Not repeated for this release: the release-daemon boot smoke against a temporary database. Unverified: real speech through a live microphone, other machines and networks, drift over time, and clean-machine installation.

Status: **done for beta.21**. The [v0.1.0-beta.21](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.21) prerelease is published from `f30807d` with its unsigned NSIS installer (13,694,799 bytes; SHA-256 `1ea9cbe3f7df5bce6d636b19ec4436ea8558f2565bc148abf7e2a4c893842128`) and `SHA256SUMS.txt`; both GitHub asset digests match local files. Main and the annotated tag are pushed. Built in `D:19` with `--no-sign` and `createUpdaterArtifacts:false`; staged daemon hash matches the compiled release binary; `NotSigned`. The release daemon booted on a temporary database (snapshot ok, three CLIs discovered, schedule and memory RPCs answered). Contents: Bitbots performance work (vendored robot-heads with idle freeze, culling and a loop cap), the on-device speech model first, and bb's Cloudflare cookie retry (still challenged from the tested machine). Unverified: the performance gain in the native windows.

Status: **done for beta.20**. The [v0.1.0-beta.20](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.20) prerelease is published from `34631aa` with its unsigned NSIS installer (13,681,809 bytes; SHA-256 `cdbabd0857d86680a515aa6368effbb45de514466887f1614aa1c1235401ca4c`) and `SHA256SUMS.txt`; both GitHub asset digests match local files. Main and the annotated tag are pushed. Built in `D:19` with `--no-sign` and `createUpdaterArtifacts:false` (its `node_modules` junction points at the repo's, which now holds `robot-heads`, `@fontsource/doto` and `@fontsource/dm-mono`); staged daemon hash matches the compiled release binary and Authenticode status is `NotSigned`. Gates before the build: 472 Rust workspace tests excluding desktop, 34 desktop-crate library tests, desktop typecheck, 516 desktop tests and the production web build. The release daemon booted against a temporary database: snapshot ok, Claude/Codex/OpenCode discovered, schedule and memory RPCs answered; no coding prompt, no user database. Signed updater feed remains beta.6; manual installation is required. Unverified: Bitbots in native windows, leader tools and OpenCode effort against live CLIs, clean-machine installation.

Status: **done for beta.19**. The [v0.1.0-beta.19](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.19) prerelease is published, tagged at `4a4d0f6` (the commit the installer was built from; `main` additionally carries `17831b5`, a one-line release-notes wording change), with its unsigned NSIS installer (13,562,185 bytes; SHA-256 `8e2946b1d35028abdbd439433fb61649fbf1c904b9cc26665b2cf0bfb61afed4`) and `SHA256SUMS.txt`; both GitHub asset digests match local files. Main and the annotated tag are pushed. Built in `D:19` (a detached worktree at `4a4d0f6`) with `--no-sign` and `createUpdaterArtifacts:false`; staged daemon/hook hashes match newly compiled release binaries and Authenticode status is `NotSigned`. Gates before the build: 459 Rust workspace tests excluding desktop, 33 desktop-crate library tests (plain-path checkout), desktop typecheck and 497 desktop tests. The release daemon booted against a temporary database (`BLOBLEX_DB_PATH`): app snapshot succeeded, Claude, Codex and OpenCode were discovered, and the schedule and memory RPCs answered; no coding prompt was sent, no user database was touched and the scratch database was removed. Signed updater feed remains beta.6. Manual installation is required. Unverified: live provider turns through the new features, `turn/steer`, the ChatGPT transcription endpoint, real retry timing, an end-to-end scheduled run, keep-awake under `powercfg /requests`, and clean-machine installation.

Status: **done for beta.18**. The [v0.1.0-beta.18](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.18) prerelease is published from `65f5211`, with its unsigned NSIS installer (13,237,527 bytes; SHA-256 `72ac911d8556aa9f99575cb42694802a7126266dc07d91d2342f2bb3cc5c10a1`) and `SHA256SUMS.txt`; both GitHub asset digests match local files. Main and annotated tag are pushed. Built in `D:\b18` with `--no-sign` and `createUpdaterArtifacts:false`; the 46 changed source/version/documentation files match the build snapshot, and staged daemon/hook hashes match newly compiled release binaries. Independent typecheck, 441 desktop tests, web build, 326 Rust workspace tests excluding desktop, native library check and NSIS build passed. Release-daemon discovery used a temporary database and found Claude 2.1.296, Codex 0.162.1 and OpenCode 1.18.35 online, without a coding prompt or user database access; the scratch database was removed. Signed updater feed remains beta.6. Manual installation is required.

Status: **done for beta.17**. The [v0.1.0-beta.17](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.17) prerelease is published from `6bf66d5` with its unsigned NSIS installer (13,173,484 bytes; SHA-256 `ca9caab8d47b4449e69c3d2358b1db6ffd42807a26e303e8ae84016cc46919fd`) and `SHA256SUMS.txt`. Source and tag are pushed; GitHub's digest matches. Built in `D:\b17` with `--no-sign` and `createUpdaterArtifacts:false`; all 52 changed source/version files match the built snapshot and staged daemon/hook hashes match compiled binaries. Independent typecheck, 426 desktop tests, web build, 306 Rust workspace tests excluding desktop, native library check and NSIS bundle passed. The release daemon's isolated health scan found the actual OpenCode 1.18.35 protocol healthy, with no prompt or user database access. Signed updater feed remains beta.6; manual installation is required.

Status: **done for beta.16**. The [v0.1.0-beta.16](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.16) prerelease is published from `41ad15e` with its unsigned NSIS installer (13,145,402 bytes; SHA-256 `cbdef090e7011743ba020bf899d6768c9a9624c007170f2d7a41a3f24aec4828`) and `SHA256SUMS.txt`; GitHub's asset digest matches. Commit `41ad15e` and the tag `v0.1.0-beta.16` are pushed. Built in `D:\b16` with `--no-sign` and `createUpdaterArtifacts:false`. Independent gates passed: typecheck, 408 desktop tests, web build, 290 Rust workspace tests excluding desktop, 24 native desktop library tests, native compile check and NSIS bundle. The signed updater feed was checked and remains at beta.6.

Status: **done for beta.15**. The [v0.1.0-beta.15](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.15) prerelease is published from `0f1a7df` with its unsigned NSIS installer (12,943,042 bytes; SHA-256 `ea042d9495a7c702f9507a0657ddc52e114558ac6f65adc78cdb8f70aa2e584f`) and `SHA256SUMS.txt`; GitHub's asset digest matches. Commit `0f1a7df` and the tag `v0.1.0-beta.15` are pushed to `main`. Built in `D:15` with `--no-sign` and `createUpdaterArtifacts:false`. The signed updater feed remains at beta.6.

Status: **done for beta.13**. The [v0.1.0-beta.13](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.13) prerelease is published from `1b23d4c` with its unsigned NSIS installer (12,900,017 bytes; SHA-256 `de8345bd6e273cda2256aa4ce744ae6b110e78ecbb48402b23fa179495a1f3e6`) and `SHA256SUMS.txt`; GitHub's asset digest matches. Commit `1b23d4c` and the tag `v0.1.0-beta.13` are pushed to `main`. It was built in `D:\b13` with `--no-sign` and `createUpdaterArtifacts:false`. The signed updater feed remains at beta.6.

Status: **done for beta.12**. The [v0.1.0-beta.12](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.12) prerelease is published from `6662b14` with its unsigned NSIS installer (12,719,309 bytes) and `SHA256SUMS.txt`. Commit `6662b14` and the tag `v0.1.0-beta.12` are pushed to `main`. The signed updater feed remains at beta.6; no `.sig` or updater manifest was uploaded.

Status: **done for beta.11**. The [v0.1.0-beta.11](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.11) prerelease is published from `2d3f16d` with its unsigned NSIS installer (12,709,185 bytes) and `SHA256SUMS.txt`. Commit `2d3f16d` and the tag `v0.1.0-beta.11` are pushed to `main`. The signed updater feed remains at beta.6; no `.sig` or updater manifest was uploaded.

Status: **done for beta.10**. The [v0.1.0-beta.10](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.10) prerelease is published from `4aa48f4` with its unsigned NSIS installer and `SHA256SUMS.txt`. Feature commit `146db44` and release source are pushed to `main`. The signed updater feed remains at beta.6; no `.sig` or updater manifest was uploaded.

Status: **done**. The [`v0.1.0-beta.9`](https://github.com/sico-vibes/bloblex/releases/tag/v0.1.0-beta.9) manual-only prerelease is published with its installer and `SHA256SUMS.txt`; beta.8 and beta.7 are also available as earlier manual-only releases. The signed updater feed remains at beta.6; beta.9 has no updater signature/manifest and did not change `channel-beta`.

Historical beta.8 workflow: the release script's dry run completed the production bundle and manifest validation on the requested beta branch. It warned that direct publishing normally requires `main`; after validating the installer/signature/manifest, the equivalent GitHub release and channel upload commands were run against that explicitly requested beta branch. For the standard scripted flow on a future signed release, use a clean `main` checkout.

For a future signed release, from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-windows.ps1 -Version <version>
```

`-DryRun` runs preflight, the bundle build, and manifest generation, prints the `gh` commands it would run, and does not execute `gh`, create a tag, or push. Add `-SkipBuild` to reuse an existing NSIS output directory, and `-BundleDir` to point that directory at a folder of `*-setup.exe` and matching `.sig` files (used to exercise the script without a real bundle). `-Repo` defaults to `sico-vibes/bloblex`.

The script checks a clean `main` checkout, exact version equality across the four manifests, that tag `v<version>` is absent locally and on the remote, and that `gh auth status` succeeds. `-DryRun` reports those repo-state checks and continues with a warning when they fail, and it skips `gh auth status` and the remote tag lookup. It still refuses a version that is not semver.

Pre-release versions (for example `0.1.0-beta.1`) are published with `gh release create ... --prerelease --latest=false`. A version with no pre-release part omits both flags so GitHub can mark it Latest.

## Produce an installer

Status: **done for beta.10 manual install**. `Bloblex_0.1.0-beta.10_x64-setup.exe` (7,383,216 bytes; SHA-256 `f418d1799f2aa3200d992500cf74a1f02b076731588782c40936c114d02727fc`) was built from `4aa48f4` in `D:\b10`. All 361 desktop tests and full offline Rust workspace tests passed; live-provider smoke was disabled. The unsigned Tauri build used the direct workspace script so `--no-sign` and the `createUpdaterArtifacts:false` override were forwarded correctly. Authenticode reports `NotSigned`; GitHub's uploaded asset digest matches the local hash.

Status: **done for beta.9 manual install**. `Bloblex_0.1.0-beta.9_x64-setup.exe` (7,366,759 bytes; SHA-256 `ad1525a8ecce9d1aba9a89da42bb662053c6582a68c9da562a5104d52a700746`) was built from commit `b6b3c95` in `D:\b9`, a short-path checkout. Windows Authenticode reports `NotSigned`; no Tauri updater signature or manifest was generated.

Status: **done for beta.8 manual install**. `Bloblex_0.1.0-beta.8_x64-setup.exe` (7,352,283 bytes; SHA-256 `a4b8af9587078b808cf4675af3f3cbeac1c07adf600f02e395c31d2042e93fed`) was built from commit `e9e4bd7` in a short-path checkout. Windows Authenticode reports `NotSigned`; no Tauri updater signature was generated. The historical beta.6 NSIS build had an updater signature.

`npm run desktop:bundle` runs `scripts/bundle-windows.ps1`, which:

1. Sets `CARGO_TARGET_DIR` to `target\desktop-release` when the variable is unset.
2. Runs `cargo build -p bloblex-daemon --bin bitbotsd -p bloblex-hook --bin bitbots-hook --release`.
3. Runs `node scripts/stage-daemon.mjs --release`, which copies the sidecars to `apps/desktop/src-tauri/binaries/` with the Tauri target-triple suffix.
4. Runs `npm run desktop -- build`, which is `tauri build` for `@bloblex/desktop`.

The bundled installer is `Bitbots_<version>_x64-setup.exe`: its name follows `bundle > productName` (`Bitbots`), and the packaged executable is `Bitbots.exe` (the `mainBinaryName`). A generated NSIS script derives the per-user install directory `%LOCALAPPDATA%\Bitbots` and the uninstall key `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Bitbots` from `productName`.

`bundle.windows.nsis.installerHooks` points at `apps/desktop/src-tauri/installer-hooks.nsh`. Its `NSIS_HOOK_PREINSTALL` macro removes an older per-user "Bloblex" install (registered under `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Bloblex`) before the Bitbots files are copied: it stops `Bloblex.exe`, `bloblexd.exe` and `bloblex-hook.exe`, then runs the old uninstaller silently. That keeps app data: NSIS only deletes the app data folder when the user ticks "Delete app data", and a silent uninstall never does. The step is best effort; a failure does not abort the install.

The release artifact is the NSIS installer only. An MSI is not a Bitbots release artifact: an MSI version cannot carry a `-beta.N` pre-release. `docs/UPDATER.md` sets the Windows bundle target to `nsis` only. The release script globs `<CARGO_TARGET_DIR>\release\bundle\nsis\*-setup.exe`, keeps the file whose name matches the release version, and requires the sibling `<installer>.sig`. It does not upload an MSI.

`apps/desktop/src-tauri/tauri.conf.json` has `bundle.targets: ["nsis"]`, `createUpdaterArtifacts: true`, the updater public key, and the stable endpoint in `plugins.updater.endpoints`. The beta endpoint is not in that file: `apps/desktop/src-tauri/src/updates.rs` (lines 19-21 and 231-234) sets the endpoint per channel. For beta.8 only, the build overrode `bundle.createUpdaterArtifacts` to `false` and passed `--no-sign`; this produced no `.sig` and no `latest.json`. The rolling beta channel was left unchanged.

The beta.6 bundle run staged both `bitbotsd-x86_64-pc-windows-msvc.exe` and `bitbots-hook-x86_64-pc-windows-msvc.exe` in `apps/desktop/src-tauri/binaries/` for packaging. These are local bundle outputs, not source changes. (Before FIX11 these sidecars were named `bloblexd-*` and `bloblex-hook-*`.)

Configured bundle icons exist on disk: `assets/icon/bloblex.ico` and `assets/icon/bloblex-master.png` (the paths in `bundle.icon`). `assets/icon/tray.png` is also present; the tray image is embedded from Rust, which this note does not change.

`bundle.resources` is `[]`. In the Tauri 2 schema that field is a list of paths or a source-to-target map, and an empty list is valid. No resource path is left for the bundler to resolve.

## Update manifest and channels

Status: **done for beta.6**. The signed `latest.json` is attached to `v0.1.0-beta.6` and the rolling `channel-beta` asset remains at version `0.1.0-beta.6`; unsigned manual-only beta.7 and beta.8 do not replace it.

`scripts/make-update-manifest.mjs` writes the Tauri updater static file `latest.json`:

`{ "version", "notes", "pub_date", "platforms": { "windows-x86_64": { "signature", "url" } } }`

Notes come from `docs/releases/<version>.md`. If that file is missing or blank, the note is the single line `Bitbots <version>`. The signature is the trimmed `.sig` file. The asset URL is `https://github.com/<repo>/releases/download/v<version>/<installer file name>`.

| Channel | Gets | Manifest URL |
| --- | --- | --- |
| `stable` | non-pre-release releases only | `https://github.com/sico-vibes/bloblex/releases/latest/download/latest.json` |
| `beta` (default while only betas exist) | every release, beta or stable | `https://github.com/sico-vibes/bloblex/releases/download/channel-beta/latest.json` |

`releases/latest` ignores pre-releases, so the stable URL only resolves once a normal release exists. `channel-beta` is a rolling pre-release. Its only job is to hold the newest `latest.json`. On every release the script creates `channel-beta` if it does not exist (`--prerelease`, `--latest=false`, `--target main`, fixed short note) and then runs `gh release upload channel-beta latest.json --clobber`. The same `latest.json` is also attached to the versioned release. Installer URLs inside the manifest point at that versioned release's NSIS asset.

## Updater key

Status: **done for beta.6**. The existing Tauri updater key files were used by the release build; no private key material was committed.

The updater key is a minisign key pair used by the Tauri updater plugin. It is not a Windows code-signing certificate. The release script reads the private key and password only while `npm run desktop:bundle` runs, from `%USERPROFILE%\.bloblex-release\updater.key` and `updater.pass`, or from `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when those are already set. It then removes them from the process environment. It does not print them.

The public half is configured in `apps/desktop/src-tauri/tauri.conf.json` under `plugins.updater.pubkey` (`docs/UPDATER.md`).

Losing the private key means existing installs cannot accept future updates: the app keeps the old public key and will reject signatures from a new key. Never commit `updater.key`, `updater.pass`, or the private-key environment values. The release script loaded the existing files into its build process and removed them from the process environment afterward.

## Publishing a stable release later

Status: **needs user**

1. Set root `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, and the Cargo workspace `version` to the same non-pre-release semver (the current tree is `0.1.0-beta.29`).
2. Add `docs/releases/<version>.md`.
3. From a clean `main` checkout, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-windows.ps1 -Version <version>`.
4. Because the version has no pre-release part, the script does not pass `--prerelease` or `--latest=false`. GitHub can mark that release as Latest.
5. `latest.json` is attached to the versioned release and uploaded again to `channel-beta` with `--clobber`, so beta installs see the stable build too.
6. Stable installs then resolve `https://github.com/sico-vibes/bloblex/releases/latest/download/latest.json`. Beta installs keep using the `channel-beta` URL above.

Use `-DryRun` first. A dry run still needs the updater signing key if it is allowed to build.

## Code-signing certificate

Status: **needs user**

`apps/desktop/src-tauri/tauri.conf.json` has no `bundle.windows.certificateThumbprint` and no `signCommand`. No certificate or Store identity is in the repo. The updater minisign key does not replace this certificate. An unsigned installer can be produced once bundling is configured; a trusted Windows install still needs a certificate or Store submission supplied by the user. Until then, Windows may show a SmartScreen warning on a first manual install. `docs/implementation-status.md` (WP-16) and `docs/windows-development.md` record the same certificate gap.

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

The policy is one line in `apps/desktop/src-tauri/tauri.conf.json`. Remote and special origins it allows:

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

Settings → Updates includes an About group with `Code signing: Not configured`, matching the unsigned Windows installer. The source version metadata is `0.1.0-beta.9` across the package, Tauri and Cargo workspace manifests. This source review is not a native window or installed-app verification; beta.9 has not had a clean-machine install pass.
