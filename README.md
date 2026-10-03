# Bloblex

Local Windows desktop control plane for Claude Code, Codex, and OpenCode. A React/Tauri shell and a companion window share state from the `bloblexd` daemon. Each provider CLI keeps its own login.

**Status: Phases 1–6 and 2b, the interface redesign, auto-update and the post-plan batches are on main. Public beta releases are published (latest `v0.1.0-beta.3`); later work is not released yet.** Installers are not code-signed. Checks are unit, mounted and fake-process tests; there is no accepted live-provider session and no native window pass of the current tree. See [SESSION_HANDOFF.md](SESSION_HANDOFF.md) and the status table in [docs/E2E_PLAN_V2.md](docs/E2E_PLAN_V2.md).

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

This is the local NSIS/MSI path. A signed installer, clean-machine install, and updater are still open (Phase 7).

## Source map

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/` | Main and companion UI, analytics, approval and execution contracts |
| `apps/desktop/src-tauri/` | Native windows, tray, authenticated daemon proxy, file actions |
| `crates/bloblex-daemon/` | Sessions, permissions, budgets, analytics RPC |
| `crates/bloblex-adapter-*` | OpenCode ACP, Codex app-server, and Claude adapters |
| `crates/bloblex-storage/` | SQLite, migrations, usage analytics |
| `crates/bloblex-runtime/` | CLI discovery and launch specifications |
| `crates/bloblex-usage/`, `bloblex-budget/`, `bloblex-wsl/` | Pricing helpers, budgets, WSL helpers |
| `tools/bloblex-hook/` | Bounded Claude hook helper |
| `scripts/` | Windows dev, sidecar staging, and installer entry points |

## References

- [IPC contract](docs/ipc-contract.md)
- [Phase 5 analytics contract](docs/PHASE_5_CONTRACT.md)
- [Approval modes](docs/APPROVAL_MODES.md)
- [Product](PRODUCT.md) and [design](DESIGN.md)
