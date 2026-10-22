# Bitbots

> **What this is:** The front page of the repository: what Bitbots is, how to build and test it, and where the documentation starts.
> **Status:** current. The release figures in this file are set at v0.1.0-beta.36; `main` is ahead of that release with unreleased work.
> **Last updated:** 2026-10-22

Bitbots (formerly Bloblex)

Local Windows desktop control plane for Claude Code, Codex, and OpenCode. A React/Tauri shell and a companion window share state from the `bitbotsd` daemon. Each provider CLI keeps its own login.

**Status: `v0.1.0-beta.36`** (the version in `Cargo.toml` and `package.json`), published as an NSIS installer that is not Authenticode-signed but is signed for the updater (new key) and offered on the beta update channel; beta.32 and later update themselves; older versions install by hand once. Full native acceptance and a clean-machine install remain open ([docs/operations/release-checklist.md](docs/operations/release-checklist.md)). Release notes: [docs/releases/0.1.0-beta.36.md](docs/releases/0.1.0-beta.36.md). History and dated records: [docs/operations/session-handoff.md](docs/operations/session-handoff.md) and [docs/operations/implementation-status.md](docs/operations/implementation-status.md). The hub for every document is [docs/README.md](docs/README.md).

## Documentation

Open [docs/DOCUMENTATION.html](docs/DOCUMENTATION.html) in a browser for the full documentation (guides, how it works, and every project document). Design rules: [docs/design/design-system.md](docs/design/design-system.md). Third-party licences: [docs/legal/third-party-notices.md](docs/legal/third-party-notices.md).

## Continue this project

Start with [docs/operations/session-handoff.md](docs/operations/session-handoff.md) and [docs/operations/implementation-status.md](docs/operations/implementation-status.md). The plan remains [docs/plans/e2e-plan-v2.md](docs/plans/e2e-plan-v2.md).

## Local development

Requirements: Windows with the MSVC C++ toolchain, Rust/Cargo, Node/npm, and WebView2. Install dependencies in this checkout (`npm ci`). Do not reuse another checkout's `node_modules`.

Desktop checks, from this folder or from `apps/desktop`:

```powershell
npm run typecheck
npm test
npm run build
```

Those commands do not launch the app or the daemon.

Native development, when you intend to open the window, uses an isolated database. Never point it at `%LOCALAPPDATA%\Bitbots`.

```powershell
npm run desktop:dev
```

Details: [docs/guides/windows-development.md](docs/guides/windows-development.md).

Renderer-only Vite (`npm run dev`) does not establish native IPC or a provider session.

Backend tests, in a private Cargo target and a fresh database path:

```powershell
cargo test --workspace --exclude bloblex-desktop
```

An opt-in provider smoke may use provider quota. A default test pass does not mean a live provider path ran.

```powershell
npm run desktop:bundle
```

This is the local NSIS path (`bundle.targets` is `nsis` only in `apps/desktop/src-tauri/tauri.conf.json`). A trusted signed installer and a clean-machine install are still open (Phase 7). The signed updater feed is at `v0.1.0-beta.6` (superseded: the feed now offers the latest beta; see the [release checklist](docs/operations/release-checklist.md)) ([docs/operations/updater.md](docs/operations/updater.md)).

## Source map

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/` | Main and companion UI, analytics, approval and execution contracts |
| `apps/desktop/src-tauri/` | Native windows, tray, authenticated daemon proxy, file actions |
| `crates/bloblex-daemon/` | Sessions, permissions, usage analytics, quota RPCs and the durable task board (`src/tasks.rs`). Budgets are retired: `budget.*` returns `unsupported` (`crates/bloblex-daemon/src/main.rs:1270`) |
| `crates/bloblex-adapter-*` | OpenCode ACP, Codex app-server, and Claude adapters |
| `crates/bloblex-storage/` | SQLite, migrations, usage analytics |
| `crates/bloblex-runtime/` | CLI discovery and launch specifications |
| `crates/bloblex-usage/`, `bloblex-budget/`, `bloblex-wsl/` | Usage helpers and the official price table (`crates/bloblex-usage/data/official-prices.json`); `bloblex-budget` is a workspace member that no crate depends on (budgets are retired); WSL helpers |
| `tools/bloblex-hook/` | Bounded Claude hook helper |
| `scripts/` | Windows dev, sidecar staging, and installer entry points |

## References

- [IPC contract](docs/ipc-contract.md)
- [Phase 5 analytics contract](docs/reference/phase-5-analytics-contract.md)
- [Approval modes](docs/reference/approval-modes.md)
- [Product](docs/design/product.md) and [design](docs/design/design-system.md)
