# Bloblex session handoff

Current as of 7 October 2026. The plan is [docs/E2E_PLAN_V2.md](docs/E2E_PLAN_V2.md). Phase status, later work and evidence commits are in [docs/implementation-status.md](docs/implementation-status.md).

## Published follow-up (8 October 2026, beta.11)

On-device dictation is added on a new `bloblex-speech` crate: a sherpa-onnx engine with cpal microphone capture, a pinned Hugging Face model catalog with per-file SHA-256 verification and resume, 16 kHz mono resampling, bounded offline chunking, an owner-locked session lifecycle, and a warm decode worker that releases the model after two idle minutes. The desktop exposes Tauri dictation commands and events, the main and companion composers show a live provisional transcript, Ctrl+E toggles dictation globally, and Settings gains a Speech model manager. Release commit `2d3f16d` is pushed to `main` and tagged `v0.1.0-beta.11`. All 361 desktop tests, typecheck/build, the offline Rust workspace suite (including 19 speech unit tests), the `native` desktop check, and the unsigned NSIS bundle passed; the installer is 12,709,185 bytes with SHA-256 `dabeb15e800bc2efc97f9175eede1ac772de254f389e8102ea26892eede024b9`. [Beta.11](docs/releases/0.1.0-beta.11.md) is published with the installer and checksum; the signed updater feed remains at beta.6. Live microphone capture, real model inference, and native/live interaction remain unverified; see [the evidence and limits](docs/evidence/dictation-2026-10-08.md). Local preview artifacts remain untracked.

## Published follow-up (7 October 2026, beta.10)

Composer controls now use source-derived reference motion and real advertised effort levels, a compact reported-context ring, paired-message outline previews and an async hold-to-delete success morph. The daemon fixes initial agent-option lookup, updates after completed turns, context reset ordering/fresh-context resets, and stale resume/turn lock races. Feature commit `146db44` and release source `4aa48f4` are pushed to `main`; the source is tagged `v0.1.0-beta.10`. All 361 desktop tests, typecheck/build, full offline Rust workspace tests from `D:\b10` with live smoke disabled, and the unsigned NSIS bundle passed. [Beta.10](docs/releases/0.1.0-beta.10.md) is published with the installer and checksum; the signed updater feed remains at beta.6. Source ports retain intentional metadata/theme/RPC differences; see [the evidence and limits](docs/evidence/composer-controls-2026-10-07.md). Native and real-provider behavior remains unverified. Local preview artifacts remain untracked.

## Current uncommitted follow-up (6 October 2026)

The active scope adds lazy session resume before a prompt is persisted, provider-reported title updates from Codex/OpenCode with explicit rename precedence, persisted provider-reported context and a session-scoped model/effort lock with confirmation on model changes. Claude title updates are not available from the structured stream used by Bloblex; the read-only public-source audit does not establish that `-p --session-id` sessions reliably appear in Claude's session index, so Bloblex keeps its current title rather than reading transcripts or deriving one from prompt text. Claude context uses the latest assistant call's usage paired with that result's matching `modelUsage.contextWindow`; Codex uses current-turn `last.totalTokens` plus optional `modelContextWindow`; OpenCode uses ACP `usage_update` used/size. Individually reported fields can appear on their own, but a percent is displayed only when both used tokens and window size are present; unknown values remain unknown.

The composer now has separate model and effort controls. A changed model requires a warning confirmation; the stored session lock is used on later turns and resume. The message outline uses actual conversation messages and keyboard navigation; conversation deletion uses a hold-to-confirm dialog while retaining cancel/Escape behavior. Focused fake/in-memory and mounted checks have been added. The desktop native window and real provider sessions for these new paths remain unverified; do not point development or tests at the user's database.

Current worktree follow-up: usage is reported-token analytics plus account quota. Active budget admission/warnings and monetary valuation, pricing and subscription UI are retired; migration 10 adds only a quota cache and preserves all existing usage, valuation, pricing, subscription and budget records. Codex quota uses the structured `account/rateLimits/read` app-server method matched against the checked-in Codex 0.159.3 schema. Claude Code quota reads only the access token from the existing Windows `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) and calls Anthropic's OAuth usage endpoint; it never refreshes or writes credentials. OpenCode Go quota reads `OPENCODE_API_KEY`, then an existing `opencode-go` entry from OpenCode `auth.json` or its credential SQLite DB opened read-only/query-only, and calls the OpenCode Go usage endpoint. Generic OpenCode provider usage is not presented as account quota. All three sources emit normalized quota fields only; credentials and raw provider payloads are not persisted, logged, or sent to the UI. Fake credential/API response tests cover source parsing, field normalization, status classification, and secret exclusion. An isolated daemon quota check succeeded with Claude Code 2.1.291, Codex codex-cli 0.160.1, and OpenCode 1.18.34. It used a temporary `BLOBLEX_DB_PATH`, sent no prompts, and did not open the user's database. The sanitized output and docs retain provider/status/window presence only, with no percentages or reset times. Normal cache behavior wrote normalized quota snapshots to the ignored isolated scratch DB at `target/provider-quota-live-smoke/quota.db`; it contains no credentials or raw provider payloads and remains because cleanup was blocked. Native UI behavior remains unverified. The earlier isolated live Claude turn remains the only live provider-turn proof.

`v0.1.0-beta.9` is published as a manual-only unsigned GitHub release; `main` includes its source and release documentation. It contains the 6 October conversation follow-up plus beta.8's usage and quota work. The signed updater feed remains on beta.6. Desktop tests (326), typecheck, production build, full offline Rust workspace tests, daemon cargo check, and the unsigned NSIS bundle pass. Rust tests and the bundle use a short-path checkout because Windows `rc.exe` misparses this repository's apostrophe-containing path. Native chat interaction, clean-machine install, and live provider verification of this follow-up remain unverified.

The recovered Claude UI, daemon, and wardrobe scope is released as `v0.1.0-beta.6` from branch `beta/claude-resume-2026-10-04`. See [the release notes](docs/releases/0.1.0-beta.6.md) and [implementation status](docs/implementation-status.md). The release feed is published, but a native-window or installed upgrade check remains open.

## What exists

Bloblex is a Windows desktop app: a React/Tauri shell (`apps/desktop`) and a separate daemon (`bloblexd`) that owns sessions, permissions, token usage and normalized quota state. The shell and the companion read the daemon's normalized state. Provider CLIs (Claude Code, Codex, OpenCode) keep their own login.

On main:

- Plan phases 1–6 and 2b: logo, capability record, persisted blobs and the editor, the project/session tree, execution options and adapters, usage analytics, settings with ask / auto / bypass approval modes.
- Auto-update from GitHub releases (stable and beta channels, signed NSIS updates) and the release script; see [docs/UPDATER.md](docs/UPDATER.md) and [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).
- The interface redesign: chat-style main window, one-page blob editor, custom dropdowns, blob moods that settle over time, favourites and pinned conversations/projects, companion launch with the full welcome.
- Conversation management: unread markers, Windows notifications, rename/archive/delete (migration 6), grouped tool activity, Start with Windows.
- Honest model lists: catalog source and update time, suggestions vs validated lists, display names, default marker and family groups.
- Token analytics with no monetary valuation, plus a compact quota row and an extended Usage sheet. Codex, Claude Code OAuth plans, and OpenCode Go have separate normalized quota sources; generic OpenCode providers are omitted. Isolated daemon fetches have been verified for Claude Code 2.1.291, Codex codex-cli 0.160.1, and OpenCode 1.18.34; native UI behavior remains unverified.
- Markdown export of a conversation, export/import of a blob setup.
- Batch B: Ctrl+K quick switcher, composer model and thinking switch, safe Markdown, unified diff view and approval shortcuts. The companion uses the same approval card.
- Batch B1: one shared Codex app-server or OpenCode ACP process per runtime key, per-session queues that coalesce streaming deltas only, idle shutdown, crash restart and resume, and bounded per-session cancel. Claude Code remains one process per session.
- Batch C: first-run setup on an empty install, companion start position and Ctrl+Alt+B hotkey, system/dark/light themes and text size, and reorderable favourites and pins. A contrast test checks the light theme against AA.
- Blob wardrobe: per-blob outfits with seasonal automatic selection, drawn to match the blob and stored by migration 7.
- Launch intro with startup checks, companion off by default with a sidebar toggle and an open-at-startup setting, and three-step first-run onboarding with verified install and sign-in guides.
- Historical OpenCode Go model price catalog and pricing records remain in the database/source tree for history, but are not read by the active usage UI or token recording path.

The beta.7 candidate gates passed before this uncommitted follow-up: `cargo test --workspace`, desktop typecheck, Vitest (341/341), and production build. Those counts do not cover the quota/usage-retirement changes below. One live Claude session returned the expected sentinel after changing the model before the first prompt. That session used an isolated database; the native app's message flow and a clean-machine installer remain unverified.

## Lanes

The Director (orchestrating Claude session) reviews diffs, runs the gates and commits. Implementers do not commit.

| Lane | Role |
| --- | --- |
| `impl` | Codex, production code including Rust |
| `impl-b` | Cursor Grok, used as the independent read-only reviewer of each branch |
| `qa` | OpenCode, research and QA; reports to the Director |

The implementer sandbox cannot spawn esbuild, so the Director runs Vitest and the Vite build. Cursor runs go through `scripts/run-cursor-delegate.ps1`; in read-only mode Cursor has no shell, so give it the diff as a file. Do not edit the user's hooks or settings.

## Build and test

From the repository root, with this checkout's own `node_modules` (`npm ci`; never link another checkout's modules):

```powershell
npm run typecheck
npm test
npm run build
cargo test --workspace
cargo check -p bloblex-desktop --lib
```

The Director's gate output is outside OneDrive at `C:\dev\bloblex-target` (`CARGO_TARGET_DIR`). Review lanes must also use a short `CARGO_TARGET_DIR`; long paths break the Windows linker. `cargo check -p bloblex-desktop` needs the gitignored sidecar binaries in `apps/desktop/src-tauri/binaries` (copy them into a new worktree). Before committing, run the naming check: no third-party product names anywhere in the repo.

Native development, only when a person is ready to launch the app, is `npm run desktop:dev` with an explicit isolated `BLOBLEX_DB_PATH`. See [docs/windows-development.md](docs/windows-development.md). Never point a test or a dev run at `%LOCALAPPDATA%\Bloblex`.

Releases: [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md). The update signing key lives outside the repo and must never be committed.

## What needs the user's native testing (Phase 7)

- Companion transparency, free drag, monitor clamping, DPI, resize timing, and the launch welcome.
- Launch startup checks, companion toggle/open-at-startup behavior, and first-run onboarding on a native install.
- Real file drop, approvals in both windows, tray Pause all, keyboard focus, and reduced motion.
- Notifications, Start with Windows, and the export/import file dialogs.
- Quit and process-tree cleanup; a clean-machine install; code signing.

## Known gaps

- One isolated live Claude daemon turn returned the expected sentinel after changing the model before the first prompt. Separate isolated quota fetches succeeded for Claude Code 2.1.291, Codex codex-cli 0.160.1, and OpenCode 1.18.34. These do not prove native UI behavior; Codex/OpenCode live turns and native behavior remain unverified. Generic OpenCode providers do not have account quota support.
- Codex blob instructions stay thread-level: the installed app-server schema has no per-turn context field.
- Budget admission, budget warnings, pricing/subscription valuation and monetary analytics are retired in the active product path. Existing database history is preserved and no longer presented as current usage.
- The daemon does not emit a `context` failure class; session turn JSON omits `failureClass`.
- WSL.
- Tracked `apps/desktop/tsconfig.tsbuildinfo` is rewritten by `tsc -b`; restore it before committing if it changes.
