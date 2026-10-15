# Bitbots

Bitbots (formerly Bloblex)

Local Windows desktop control plane for Claude Code, Codex, and OpenCode. A React/Tauri shell and a companion window share state from the `bloblexd` daemon. Each provider CLI keeps its own login.

**Status: `v0.1.0-beta.28`** (the version in `Cargo.toml` and `package.json`), published as a manual, unsigned NSIS installer. The signed updater feed stays at `v0.1.0-beta.6`. Full native acceptance and a clean-machine install remain open ([docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)). Release notes: [docs/releases/0.1.0-beta.23.md](docs/releases/0.1.0-beta.23.md). History and dated records: [SESSION_HANDOFF.md](SESSION_HANDOFF.md) and [docs/implementation-status.md](docs/implementation-status.md). The hub for every document is [docs/README.md](docs/README.md).

## Continue this project

Start with [SESSION_HANDOFF.md](SESSION_HANDOFF.md) and [docs/implementation-status.md](docs/implementation-status.md). The plan remains [docs/E2E_PLAN_V2.md](docs/E2E_PLAN_V2.md).

## Local development

Requirements: Windows with the MSVC C++ toolchain, Rust/Cargo, Node/npm, and WebView2. Install dependencies in this checkout (`npm ci`). Do not reuse another checkout's `node_modules`.

Desktop checks, from this folder or from `apps/desktop`:

```powershell
npm run typecheck
npm test
npm run build
```

Those commands do not launch the app or the daemon.

Native development, when you intend to open the window, uses an isolated database. Never point it at `%LOCALAPPDATA%\Bloblex`.

```powershell
npm run desktop:dev
```

Details: [docs/windows-development.md](docs/windows-development.md).

Renderer-only Vite (`npm run dev`) does not establish native IPC or a provider session.

Backend tests, in a private Cargo target and a fresh database path:

```powershell
cargo test --workspace --exclude bloblex-desktop
```

An opt-in provider smoke may use provider quota. A default test pass does not mean a live provider path ran.

```powershell
npm run desktop:bundle
```

This is the local NSIS path (`bundle.targets` is `nsis` only in `apps/desktop/src-tauri/tauri.conf.json`). A trusted signed installer and a clean-machine install are still open (Phase 7). The signed updater feed is at `v0.1.0-beta.6` ([docs/UPDATER.md](docs/UPDATER.md)).

## Source map

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/` | Main and companion UI, analytics, approval and execution contracts |
| `apps/desktop/src-tauri/` | Native windows, tray, authenticated daemon proxy, file actions |
| `crates/bloblex-daemon/` | Sessions, permissions, usage analytics and quota RPCs. Budgets are retired: `budget.*` returns `unsupported` (`crates/bloblex-daemon/src/main.rs:992`) |
| `crates/bloblex-adapter-*` | OpenCode ACP, Codex app-server, and Claude adapters |
| `crates/bloblex-storage/` | SQLite, migrations, usage analytics |
| `crates/bloblex-runtime/` | CLI discovery and launch specifications |
| `crates/bloblex-usage/`, `bloblex-budget/`, `bloblex-wsl/` | Usage helpers and the official price table (`crates/bloblex-usage/data/official-prices.json`); `bloblex-budget` is a workspace member that no crate depends on (budgets are retired); WSL helpers |
| `tools/bloblex-hook/` | Bounded Claude hook helper |
| `scripts/` | Windows dev, sidecar staging, and installer entry points |

## References

- [IPC contract](docs/ipc-contract.md)
- [Phase 5 analytics contract](docs/PHASE_5_CONTRACT.md)
- [Approval modes](docs/APPROVAL_MODES.md)
- [Product](PRODUCT.md) and [design](DESIGN.md)
