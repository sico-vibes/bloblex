# Bloblex session handoff

Current as of 5 October 2026. The plan is [docs/E2E_PLAN_V2.md](docs/E2E_PLAN_V2.md). Phase status, later work and evidence commits are in [docs/implementation-status.md](docs/implementation-status.md).

Current worktree follow-up: usage is reported-token analytics plus account quota. Active budget admission/warnings and monetary valuation, pricing and subscription UI are retired; migration 10 adds only a quota cache and preserves all existing usage, valuation, pricing, subscription and budget records. Codex quota uses the structured `account/rateLimits/read` app-server method matched against the checked-in Codex 0.159.3 schema. Claude Code quota reads only the access token from the existing Windows `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) and calls Anthropic's OAuth usage endpoint; it never refreshes or writes credentials. OpenCode Go quota reads `OPENCODE_API_KEY`, then an existing `opencode-go` entry from OpenCode `auth.json` or its credential SQLite DB opened read-only/query-only, and calls the OpenCode Go usage endpoint. Generic OpenCode provider usage is not presented as account quota. All three sources emit normalized quota fields only; credentials and raw provider payloads are not persisted, logged, or sent to the UI. Fake credential/API response tests cover source parsing, field normalization, status classification, and secret exclusion. An isolated daemon quota check succeeded with Claude Code 2.1.291, Codex codex-cli 0.160.1, and OpenCode 1.18.34. It used a temporary `BLOBLEX_DB_PATH`, sent no prompts, and did not open the user's database. The sanitized output and docs retain provider/status/window presence only, with no percentages or reset times. Normal cache behavior wrote normalized quota snapshots to the ignored isolated scratch DB at `target/provider-quota-live-smoke/quota.db`; it contains no credentials or raw provider payloads and remains because cleanup was blocked. Native UI behavior remains unverified. The earlier isolated live Claude turn remains the only live provider-turn proof.

`v0.1.0-beta.7` is the current release candidate; `v0.1.0-beta.6` remains the latest published release until beta.7 is uploaded. Acceptance evidence includes unit, mounted, fake-process and one live Claude daemon session on an isolated database. The desktop development app starts, but no native chat interaction or clean-machine installer pass has been recorded for this candidate.

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
