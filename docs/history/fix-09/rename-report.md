# FIX9 rename report: Bloblex to Bitbots

> **What this is:** Report on FIX9: the rename from Bloblex to Bitbots.
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026 by the OpenCode lane. Spec:
[docs/history/fix-09/rename-spec.md](rename-spec.md). The diff is left uncommitted in this
worktree.

## Summary

The product name is now **Bitbots**. Every place a person reads the product
name has been renamed case-correctly ("Bloblex" to "Bitbots", "Bloblex's" to
"Bitbots'", "bloblex"/"BLOBLEX" in prose to the same case). Identifiers, paths,
protocol values and URLs are unchanged. The word "blob" (the characters, "Blob
page", "blob settings") is untouched, as the spec directs; the secondary theme
name Blobots is FIX10's work.

`README.md` gained the note "Bitbots (formerly Bloblex)" under its title.

## Gates

- `npm run typecheck` - pass.
- `npm run test` (desktop) - pass, 553 tests in 89 files.
- `cargo test --workspace --exclude bloblex-desktop` - see "Gate results" below.

## Files changed (119)

**Config and entry points**
- `apps/desktop/src-tauri/tauri.conf.json` (`productName`, window `title`).
- `apps/desktop/index.html`, `preview.html`, `gallery.html`,
  `launch-preview.html`, `polish-preview.html`, `dictation-preview.html`
  (`<title>` only).

**Desktop UI copy and tests** (`apps/desktop/src`)
- `approvalContract.ts`, `executionContract.ts`, `tauri.ts`,
  `updatesContract.ts`, `updatesContract.test.ts`
- `blob/BlobCanvas.tsx`, `blob/blobEngine.ts`, `blob/characterMotion.test.ts`,
  `blob/companionFsm.ts`, `blob/greetingScene.ts`, `blob/look/forms.ts`,
  `blob/look/index.ts`
- `preview/fixtureBridge.ts`, `preview/gallery.tsx`, `preview/main.tsx`
- `ui/App.tsx`, `ui/CompanionTeam.tsx`, `ui/DictationBubble.tsx`,
  `ui/LaunchIntro.tsx`, `ui/ProfileMenu.tsx`, `ui/PromptQueue.tsx`,
  `ui/SchedulesView.tsx`, `ui/SessionExecutionControls.tsx`,
  `ui/TeamMessages.tsx`, `ui/agentForm.ts`, `ui/approvalUi.tsx`,
  `ui/experiments.ts`, `ui/meterMotion.ts`, `ui/rosterSelectors.ts`,
  `ui/runtimeDiscovery.ts`
- Mounted/unit tests updated to the renamed strings:
  `ui/App.agent.mounted.test.tsx`, `ui/App.companion.mounted.test.tsx`,
  `ui/App.lifecycle.mounted.test.tsx`, `ui/ConfirmDialog.hold.mounted.test.tsx`,
  `ui/LaunchIntro.mounted.test.tsx`, `ui/PromptQueue.mounted.test.tsx`,
  `ui/SessionExecutionControls.mounted.test.tsx`,
  `ui/sessionActions.mounted.test.tsx`, `ui/updates.mounted.test.tsx`,
  `ui/agentForm.test.ts`
- `vendor/robot-heads/index.js` (the "vendored by Bloblex" comments only; the
  `BLOBLEX_FRAME_MS` constant is untouched).

**Desktop native** (`apps/desktop/src-tauri/src`)
- `lib.rs` (error strings, tray tooltip and menu, companion/dictation window
  titles, log lines, panic message), `updates.rs` (two "daemon is unavailable"
  errors), `power.rs` (module docs), `file_inspection_tests.rs` (fixture text
  and its assertion).

**Rust crates**
- `crates/bloblex-adapter-acp/src/{catalog.rs,exec.rs,lib.rs}`
- `crates/bloblex-adapter-claude/src/lib.rs` and its wire fixture
  `tests/wire/fixtures/permission-deny.ndjson`
- `crates/bloblex-adapter-codex/src/lib.rs`
- `crates/bloblex-agent-core/src/lib.rs`
- `crates/bloblex-daemon/src/{automations.rs,main.rs,mcp_bridge.rs,quota_sources.rs,retry.rs,team.rs}`
  and `tests/daemon_smoke.rs`
- `crates/bloblex-speech/{Cargo.toml,src/capture.rs,src/catalog.rs,src/cloud.rs,src/lib.rs}`
- `crates/bloblex-storage/src/lib.rs`

**Scripts**
- `scripts/live-checks/{live-cloud-dictation,live-codex-echo,live-codex,live-composer,live-opencode-effort,live-opencode}.mjs`
- `scripts/make-update-manifest.mjs` and `scripts/make-update-manifest.test.mjs`
  (the updater note text `Bloblex <version>` to `Bitbots <version>` and the
  assertions that check it)
- `scripts/native-smoke/tray.ps1`, `scripts/release-windows.ps1`

**Root documents**
- `README.md`, `AGENTS.md` (title only; amendment/history sections keep their
  wording), `DESIGN.md`, `PRODUCT.md`, `SESSION_HANDOFF.md`,
  `THIRD_PARTY_NOTICES.md`

**`docs/`**
- `docs/reference/approval-modes.md`, `docs/history/director-log.md`, `docs/plans/e2e-plan-v2.md`,
  `docs/plans/improvement-plan.md`, `docs/history/improvement/plan-v1-qa-draft.md`,
  `docs/history/improvement/phase-3a-spec.md`, `docs/history/improvement/phase-4b-spec.md`,
  `docs/history/improvement/phase-6a-spec.md`, `docs/operations/native-smoke-results.md`,
  `docs/operations/operating-model.md`, `docs/history/phases/phase-2b-spec.md`, `docs/history/phases/phase-3-spec.md`, `docs/history/phases/phase-4-spec.md`,
  `README.md`, `docs/operations/release-checklist.md` (current-state lines only), `docs/operations/updater.md`,
  `ipc-contract.md`, `docs/reference/runtime-capabilities.md`, `docs/audits/v1-coverage.md`
- `docs/history/fix-01/dictation-spec.md`, `docs/history/fix-01/opencode-effort-spec.md`, `docs/history/fix-01/team-spec.md`,
  `docs/history/fix-02/codex-team-instructions-spec.md`, `docs/history/fix-03/opencode2-acp-launch-spec.md`,
  `docs/history/fix-07/opencode-usage-and-signin-spec.md`
- `evidence/cloud-dictation-client-shape-2026-10-14.md`,
  `evidence/cloud-dictation-diagnosis-2026-10-13.md`,
  `evidence/codex-turn-steer-2026-10-12.md`,
  `evidence/composer-controls-2026-10-07.md`,
  `evidence/task2-grok-runtime-capabilities.md`,
  `evidence/task2-luna-runtime-capabilities-original.md`

## Identifiers deliberately kept

Grouped by kind. All were left exactly as written.

**Crates, binaries and packages**
- Cargo package/crate names (`bloblex-*`), binary names (`bloblexd`,
  `bloblex-hook`), `Cargo.toml` `name`, `Cargo.lock`, `bundle.externalBin`.
- npm names `bloblex` and `@bloblex/desktop`, `package-lock.json`.
- Rust `use bloblex_*` paths, `bloblex_*` module references and Rust test
  function names (for example
  `claude_catalog_probe_targets_bloblex_sonnet_default_and_keys_workflows_to_that_probe`).

**Tauri, OS and data identifiers**
- Bundle identifier `com.bloblex.desktop` (and `com.bloblex.desktop.dev`).
- The app-data directory name `Bloblex`: `%LOCALAPPDATA%\Bloblex`,
  `%TEMP%\Bloblex`, `Bloblex/bloblex.db`, `Bloblex/private-tmp`,
  `Bloblex/speech-models`, `C:/Bloblex/workspaces/...` fixture path.
- Tauri command `quit_bloblex`, tray id `bloblex-tray`, icon file names
  `bloblex.ico` and `bloblex-master.png`.

**Environment variables**
- `BLOBLEX_*` (for example `BLOBLEX_DB_PATH`, `BLOBLEX_DAEMON_ADDR`,
  `BLOBLEX_WIRE_RECORD`, `BLOBLEX_STAGE_DESTINATION`) and the vendored constant
  `BLOBLEX_FRAME_MS`.

**Protocol and wire values**
- MCP server name `bloblex` (`SERVER_NAME`, `serverInfo.name`), the MCP tool
  titles `bloblex · list_blobs` / `bloblex · message_blob`, and the Claude
  tool-prefix needles `mcp__bloblex__` / `bloblex_*` in `is_team_tool_permission`.
- The ACP mode value `bloblex` (`AGENT_NAME`, config-option `value`) and its
  recorded wire options.
- Dictation `originator: bloblex` and the `bloblex-desktop/<version>`
  User-Agent (kept by the 12 and 14 October AGENTS amendments).
- Frontend event names (`bloblex-*`), the drag MIME type
  `application/x-bloblex-agent`, localStorage/sessionStorage keys
  (`bloblex.appearance`, `bloblex.bitbots`, `bloblex.selectedAgentId`), and the
  look seed `'bloblex'`.
- Frontend symbol names `quitBloblex` and `bloblexLogo`.

**URLs and release assets**
- Git remote / repo slug `sico-vibes/bloblex` and the updater endpoint URLs.
- Published installer names `Bloblex_0.1.0-beta.N_x64-setup.exe` (including the
  ones in `scripts/make-update-manifest.test.mjs`).

**Records left as written**
- `docs/releases/0.1.0-beta.1.md` .. `0.1.0-beta.28.md` (published notes).
- `docs/operations/release-checklist.md` history entries (installer names and their
  digests).
- `docs/history/fix-09/rename-spec.md` (this directive) and the amendment/history sections
  of `AGENTS.md`.
- `docs/history/fix-10/theme-style-spec.md` has no product-name prose; it is left alone.

## User-visible strings that are also identifiers

These read as the product name to a person but are, or are tied to, an
identifier, so they were left and are listed here per the spec:

- **ACP and Codex `clientInfo.name = "Bloblex"`** in the `initialize`
  handshake (`crates/bloblex-adapter-acp/src/catalog.rs:161`,
  `crates/bloblex-adapter-acp/src/lib.rs:461`,
  `crates/bloblex-adapter-codex/src/lib.rs:699,1268,1332`) and the recorded
  `dir:"in"` lines in the wire fixtures under
  `crates/bloblex-adapter-{acp,codex}/tests/wire/fixtures/`. It is the client
  identity sent to a provider (visible in provider logs) and part of the wire
  protocol; the replay tests compare it byte-for-byte.
- **The ACP mode display name** `{ value: "bloblex", name: "Bloblex" }` in
  `crates/bloblex-adapter-acp/tests/fixtures/fake-acp-agent.mjs:43`. The `value`
  is the mode identifier; the display `name` matches it. The recorded
  `effort-echo.ndjson` uses the lower-case identifier.
- **MCP tool titles** `bloblex · list_blobs` / `bloblex · message_blob` shown in
  the conversation UI (`apps/desktop/src/preview/fixtureBridge.ts:132-133`,
  `apps/desktop/src/ui/sessionActions.mounted.test.tsx:48`); they are built from
  the MCP server name `bloblex`.
- **`originator: bloblex`** in the cloud-dictation client, kept by the AGENTS
  amendment; the `originator` value is a protocol identity.
- **`quit_bloblex`** (Tauri command) and the **`bloblex-tray`** id appear in
  source and logs; both are identifiers.
- **Data-directory paths** such as `%LOCALAPPDATA%\Bloblex` that appear inside
  otherwise user-facing documentation and error copy.

## Left for other owners (not renamed here)

- `apps/desktop/src/ui/FirstRunOnboarding.tsx`, `SettingsSheet.tsx`,
  `SettingsSheet.appearance.mounted.test.tsx` and
  `FirstRunOnboarding.mounted.test.tsx` still read "Bloblex"; the FIX10 lane's
  owners rename them, and their mounted tests were left matching so the suite
  stays green.
- `apps/desktop/src/ui/theme.css` still has a "Bloblex design tokens" comment;
  CSS is owned by the theme/Director work.
- `apps/desktop/src/blob/bitbots.ts` and `blob/bitbots.test.ts` (the
  `bloblex.bitbots` cache key is an identifier anyway).
- The daemon `settings.set` handler and settings validation in
  `crates/bloblex-daemon/src/main.rs` were not touched.

## Gate results

<!-- FILLED IN BELOW -->
