# Architecture

Last reviewed: 2026-10-19 (v0.1.0-beta.35). Deep version: `docs/library/content/reference/architecture.md` and the other reference pages in `docs/library/content/reference/`.

## Processes

| Process | Code | Owns |
|---|---|---|
| Desktop shell (`Bitbots.exe`) | `apps/desktop/src-tauri/src/lib.rs` (Tauri 2) | Windows (main, companion, dictation), tray, global shortcut, single instance, native dialogs, file tokens, clipboard image, updater, wallpaper files, launching the daemon |
| Daemon (`bitbotsd`, crate `bloblex-daemon`) | `crates/bloblex-daemon/src/main.rs` (`dispatch()` is the RPC switch) | Sessions, turns, queue, retry/watchdog, approvals, usage, team/Manager tools, automations, memory, skills, settings, backup, remote gateway |
| Provider CLIs | Claude Code, Codex, OpenCode (installed by the user) | The actual coding work and their own logins |
| WebView2 pages | `apps/desktop/src` (React) | Main window (`/`), companion (`?companion=1`), dictation (`?dictation=1`), all from one bundle |
| Phone (optional) | `apps/desktop/src/remote` (separate PWA build `dist-remote`) | Remote client through the daemon's gateway |

The daemon is started by the shell as a child per app instance and exits with it (parent watchdog). Restarting `Bitbots.exe` restarts the daemon.

## Channels

- **UI ↔ daemon:** loopback HTTP `POST /v1/rpc` (methods) and WebSocket `GET /v1/events` (events), on `127.0.0.1`, protected by a capability token. Contract: `docs/ipc-contract.md`. UI side: `apps/desktop/src/tauri.ts` (desktop functions) and `apps/desktop/src/transport/nativeBridge.ts`; only those (and `desktopIntegrations.ts`) may call native Tauri commands (`transport/noDirectNative.test.ts` enforces it).
- **UI ↔ shell:** Tauri commands registered in the `invoke_handler` in `src-tauri/src/lib.rs`.
- **Daemon ↔ CLIs:** adapter crates: `bloblex-adapter-claude` (stream JSON), `bloblex-adapter-codex` (app-server JSON-RPC), `bloblex-adapter-acp` (OpenCode over ACP), `bloblex-adapter-opencode`, on `bloblex-agent-core` / `bloblex-runtime` / `bloblex-process`.
- **Phone ↔ daemon:** the remote gateway (`crates/bloblex-daemon/src/remote/`), off by default; Tailscale (`tailscale serve`, loopback only) or Native (HTTPS on `remote.nativePort`, password + owner approval). Policy for both TypeScript and Rust: `apps/desktop/src/remote/tiers.json` (parity tests fail when a method or event has no row). Rules: `AGENTS.md` (17 October amendments) and `docs/remote/`.

## Data

- Daemon data: `%LOCALAPPDATA%\Bitbots` (SQLite via `crates/bloblex-storage`, logs). Agents are JSON values validated in `bloblex-storage/src/lib.rs` (`validate_agent_fields`, `valid_look`); settings are a key/value table (`validate_setting_value` there and `validate_setting` in the daemon).
- WebView profile: `%LOCALAPPDATA%\com.bitbots.desktop` (localStorage caches such as `bitbots.style`, `bitbots.wallpaper`, `bitbots.glass`, `bitbots.font`; the daemon setting is the source of truth, the cache only avoids a first-paint flash).
- App local data: wallpapers (`wallpapers/custom.<ext>`), attachments.
- Release notes: `docs/releases/*.md` are imported by the app (`ui/WhatsNew.tsx`), so that folder must not move.

## Settings flow

Daemon setting → `settings.get` on connect and `settings.changed` events → `applyWindowSetting` in `apps/desktop/src/ui/App.tsx` → stores and document attributes (`blob/bitbots.ts` for `appearance.style`; `<html data-style data-wallpaper data-glass data-theme data-density data-text-size>`). The companion and dictation windows share localStorage and follow through the `storage` event.
