# Architecture

> **What this is:** how Bitbots is put together: the desktop shell, the local daemon, the provider adapters, storage and the Remote gateway, and where to start reading each part.
> **Status:** current; new in the documentation library pass of 19 October 2026. The claims were checked against the tree at `17bc277` on that date; line numbers may move.
> **Last updated:** 2026-10-19

## Purpose

Bitbots is a local Windows control plane for the coding-agent CLIs Claude Code, Codex and OpenCode. A React interface and a companion window show the state of every bot. A separate local daemon owns the sessions, the permission decisions and the stored history. Each provider CLI keeps its own sign-in ([docs/design/product.md](../design/product.md)).

## How it works

**Two processes.**

- The desktop shell (`apps/desktop/src-tauri`) is a Tauri application. It creates the native windows, the tray and the file actions, and it proxies calls to the daemon. The React code in `apps/desktop/src` runs in those windows.
- The daemon (`crates/bloblex-daemon`, shipped as the sidecar `bitbotsd`) owns sessions, permissions, usage and storage. It is listed as an external binary in `apps/desktop/src-tauri/tauri.conf.json:46`.

**Daemon API.** The daemon serves an axum router with two routes: `POST /v1/rpc` for requests and `GET /v1/events` for the event stream (`crates/bloblex-daemon/src/main.rs:4295-4297`). Its listener binds to `127.0.0.1` on an ephemeral port (`crates/bloblex-daemon/src/main.rs:4299`). Every request is checked against the daemon capability (`crates/bloblex-daemon/src/main.rs:349-380`). The full method, event and error contract is in [../ipc-contract.md](../ipc-contract.md).

**Dispatch.** Requests are routed by `dispatch()` (`crates/bloblex-daemon/src/main.rs:819`). The `budget.*` methods return `unsupported` (`crates/bloblex-daemon/src/main.rs:1240`), because budgets are retired ([AGENTS.md](../../AGENTS.md), 12 October 2026 amendment).

**Provider adapters.** Each provider has an adapter crate, and the daemon depends on the ones it uses (`crates/bloblex-daemon/Cargo.toml`):

| Crate | Provider and transport |
| --- | --- |
| `bloblex-adapter-claude` | Claude Code, in its documented print and stream-json mode. Not interactive terminal scraping (`crates/bloblex-adapter-claude/src/lib.rs:1`). |
| `bloblex-adapter-codex` | Codex, through the app-server over JSON-RPC on stdio. Never reads terminal output (`crates/bloblex-adapter-codex/src/lib.rs:1`). |
| `bloblex-adapter-acp` | OpenCode, through the provider-neutral ACP adapter. |
| `bloblex-adapter-opencode` | The OpenCode launcher; it uses the ACP adapter and adds `acp` and `--cwd` to the resolved executable (`crates/bloblex-adapter-opencode/src/lib.rs:1`). |

**Shared crates.** `bloblex-protocol` holds the RPC request and response types (`crates/bloblex-protocol/src/lib.rs:8-30`). `bloblex-agent-core` holds the shared agent logic. `bloblex-storage` is the SQLite store and its migrations. `bloblex-security` holds the capability and loopback checks. `bloblex-runtime` finds the provider CLIs and builds their launch specifications. `bloblex-usage` holds the usage helpers and the official price table. `bloblex-speech` is the on-device dictation engine (`crates/bloblex-speech/src/lib.rs:1`). `bloblex-wsl` holds the WSL helpers. `tools/bloblex-hook` is the bounded Claude hook helper.

**Storage and migrations.** The database path is `BLOBLEX_DB_PATH` when it is set (`crates/bloblex-daemon/src/main.rs:4221`). Otherwise the desktop uses the data folder `%LOCALAPPDATA%\Bitbots` (`apps/desktop/src-tauri/src/lib.rs:873-879`). Development and tests point `BLOBLEX_DB_PATH` at a scratch file.

Schema changes are versioned migrations in `crates/bloblex-storage/src/lib.rs`. Each migration is its own `migrate_*` function. Most migrations that change the schema take a verified backup before the DDL (`verified_backup` at `crates/bloblex-storage/src/lib.rs:57` and `crates/bloblex-storage/src/lib.rs:129`). At least one does not (`migrate_context_failure_class` at `crates/bloblex-storage/src/lib.rs:1218`). Each applied version is recorded in the `schema_migrations` table and in `PRAGMA user_version` (`crates/bloblex-storage/src/lib.rs:39-60` and `crates/bloblex-storage/src/lib.rs:94-95`). To test a change, run it against a scratch database and never against `%LOCALAPPDATA%\Bitbots`.

**Frontend.** `apps/desktop/src/transport/nativeBridge.ts` is the seam over the Tauri API for UI code. Its header says that only `src/tauri.ts` and `src/desktopIntegrations.ts`, besides the `transport/` folder, may import `@tauri-apps/*` directly. The UI components are in `apps/desktop/src/ui`. The browser preview (`apps/desktop/src/preview`) replaces the native bridge with fixtures, so it does not run real sessions.

**Tauri commands.** The shell registers its commands in one handler list (`apps/desktop/src-tauri/src/lib.rs:2726`). Two windows are created with `WebviewWindowBuilder` (`apps/desktop/src-tauri/src/lib.rs:2256` and `apps/desktop/src-tauri/src/lib.rs:2371`), and the companion window is looked up by its label (`apps/desktop/src-tauri/src/lib.rs:1491`).

**Remote gateway.** Remote mode adds a gateway inside the daemon. It is off by default. It has two methods, and only one is active at a time (AGENTS.md, 17 October 2026 amendments):

- **Tailscale** (the first method). The gateway listens on `127.0.0.1` only, and Tailscale serves it to paired devices (`crates/bloblex-daemon/src/remote/mod.rs:792`).
- **Native** (the second method). When Native is on, the gateway's own listener binds every interface on its own port, and it serves HTTPS only with a certificate that Bitbots generates (`crates/bloblex-daemon/src/remote/native.rs:15`, and the TLS configuration at `crates/bloblex-daemon/src/remote/native.rs:404`). The daemon API listener stays on loopback in both methods.

The policy that says which methods a remote device may call is shared by Rust and TypeScript (`apps/desktop/src/remote/tiers.json`). The design is in [../remote/ARCHITECTURE.md](../remote/ARCHITECTURE.md), and the threat model is in [../remote/THREAT_MODEL.md](../remote/THREAT_MODEL.md). The protocol document in [../remote/PROTOCOL.md](../remote/PROTOCOL.md) has its own status note.

## Key files

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/` | Main and companion UI, contracts for approvals, execution and analytics |
| `apps/desktop/src/transport/` | The seam over the Tauri API for UI code |
| `apps/desktop/src-tauri/` | Native windows, tray, daemon proxy, file actions, updates, speech and power |
| `crates/bloblex-daemon/` | Daemon entry point, RPC dispatch, teams, automations, memory, skills, remote gateway |
| `crates/bloblex-adapter-*` | Provider adapters (see the table above) |
| `crates/bloblex-storage/` | SQLite store and migrations |
| `scripts/` | Windows development, sidecar staging, installer and release entry points |

## Gotchas

- Crate and binary names still say `bloblex` (for example `bloblex-daemon`, `bitbotsd`). The product is Bitbots. Do not rename code identifiers in prose.
- The daemon API listener is loopback-only. The Tailscale gateway is loopback-only too. The Native method is the one exception: when it is on, it binds every interface and needs TLS, and it is off by default (AGENTS.md, 17 October 2026 amendment).
- The desktop crate builds from a short path, not from a path with an apostrophe (noted in [../history/fix-40/report.md](../history/fix-40/report.md), section on the apostrophe in the path).
- Browser preview and unit tests do not establish native behaviour. Say so when you report a result.
- AGENTS.md permits one exception to the rule that Bitbots does not read provider credentials: opt-in cloud dictation may read the Codex sign-in file, read-only (AGENTS.md, 12 and 14 October 2026). Its limits are in [operating-model.md](../operations/operating-model.md).
