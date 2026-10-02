# Bloblex

Local Windows desktop control plane for Claude Code, Codex and OpenCode. A React/Tauri desktop shell and a draggable companion share state from a separate Rust daemon. Provider authentication stays with each CLI.

**Status: under active development (resumed 2 October 2026).** Not a completed v1 or a signed release. See [SESSION_HANDOFF.md](SESSION_HANDOFF.md), [docs/E2E_PLAN_V2.md](docs/E2E_PLAN_V2.md) and [docs/DIRECTOR_LOG.md](docs/DIRECTOR_LOG.md) for the current plan and progress.


## Continue this project

Start with [SESSION_HANDOFF.md](SESSION_HANDOFF.md). It records the current UI, evidence and unfinished work. [implementation-status.md](docs/implementation-status.md) preserves the checklist against the full plan. The commands below are reference information for a future user-authorized run; they were not executed after the stop.

The authoritative plan is [docs/E2E_PLAN_V2.md](docs/E2E_PLAN_V2.md). [Bloblex_UI_Concept.png](Bloblex_UI_Concept.png) supplies main-window design direction. The user requires island behavior in an original Bloblex character and a rounded rectangular floating bill, bottom-center by default and freely draggable.

## Local development

Requirements: Windows with the MSVC C++ toolchain, Rust/Cargo, Node/npm and WebView2. Each provider CLI manages its own installation and login. Exact versions verified on this machine are recorded in the handoff; they are a checkpoint, not a permanent compatibility promise.

From this folder:

```powershell
npm install
npm run desktop:dev
```

This builds and stages the daemon and hook helper in the default isolated `target/desktop-dev` folder, then starts Tauri with Vite. Native startup now uses a private daemon executable copy. Read [windows-development.md](docs/windows-development.md) for the running-executable lock repair and its current verification limits.

Renderer-only development:

```powershell
npm run dev
```

The preview uses `http://127.0.0.1:1420`; it does not establish native IPC, provider or companion-window acceptance. The installed/native inspection build embeds production assets and does not automatically pick up source or Vite changes.

## Checks and packaging

```powershell
npm run typecheck
npm test
npm run build
cargo test --workspace --exclude bloblex-desktop
```

Coordinate shared targets with other agents. Use a separate `CARGO_TARGET_DIR` while the app is open; the handoff describes current target folders and test limitations. The installed-provider smoke is opt-in and may use provider quota. A default suite pass does not mean those live paths ran.

```powershell
npm run desktop:bundle
```

This is the configured local NSIS/MSI build path, including daemon and hook sidecars. A successful installer build, clean-machine installation, signing, updater and trusted distribution are still required and are tracked as open work.

## Source map

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/` | Main and companion UI, normalized state reducer, procedural character |
| `apps/desktop/src-tauri/` | Native windows/tray, authenticated daemon proxy, file actions |
| `crates/bloblex-daemon/` | Authoritative runtime/session/permission/budget orchestration |
| `crates/bloblex-adapter-*` | ACP/OpenCode, Codex app-server and Claude protocol adapters |
| `crates/bloblex-storage/` | SQLite persistence, replay, reservations, recovery and valuations |
| `crates/bloblex-runtime/` | CLI discovery and launch specifications |
| `crates/bloblex-usage/`, `bloblex-budget/`, `bloblex-wsl/` | Normalization/pricing, policy helpers and WSL helpers |
| `tools/bloblex-hook/` | Bounded Claude hook helper; full integration remains open |
| `scripts/` | Local development, sidecar staging and installer build entry points |

## Evidence and references

- Independent QA report and current QA agent log
- Full acceptance scenarios, findings register, [v1 coverage audit](docs/v1-coverage.md)
- island UI fidelity criteria and motion/source mapping
- Preserved user reference screenshots, including the rejected earlier Bloblex pill
- [IPC contract](docs/ipc-contract.md), [product](PRODUCT.md), [design](DESIGN.md)
- Optional gateway assessment, which has not expanded the authorized v1 scope
