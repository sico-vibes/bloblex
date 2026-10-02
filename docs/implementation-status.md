# Implementation status

Current as of 2 October 2026. Plan: [E2E_PLAN_V2.md](E2E_PLAN_V2.md). Handoff: [SESSION_HANDOFF.md](../SESSION_HANDOFF.md).

**Evidence class:** desktop unit and mounted tests, plus daemon and adapter tests that use in-memory storage or fake processes. No live-provider session and no native window verification of the current tree. The Phase 3 isolated-database smoke (`5138c8e`, revision `e770db8`, [NATIVE_SMOKE_RESULTS.md](NATIVE_SMOKE_RESULTS.md)) is the only recorded native pass, and it predates Phases 4, 2b, 5, and 6.

## Phase status

| Phase | Status | Evidence | Verification limit |
| --- | --- | --- | --- |
| 1 Logo and icons | Implemented | `7f10e60` | Asset script and files. Installer/tray icon check is Phase 7. |
| 1.5 CLI capability record | Implemented | `2b4b92f` | Recorded probes in [runtime-capabilities.md](runtime-capabilities.md). Not a live session pass. |
| 2a Blob storage and RPCs | Implemented | `1b0232a` | Storage and daemon tests. The Phase 3 smoke exercised migration and the roster on an isolated database. |
| 3 Blob roster and editor | Implemented | `92f626a` | Unit/mounted tests, plus the isolated native smoke above. Defects N1–N4 in that smoke were not re-run natively. |
| 4 Project and session tree | Implemented | `395fd78` | Unit and mounted tests only. |
| 2b Execution options | Implemented | `2dc0ae9`, `013e32b`, `73c4f03`, `9045022`, `7c0eb77` | Fake-process adapter tests and storage tests. No live CLI execution of the current adapters. |
| 5 Usage analytics | Implemented | `55808fa`, `07bb620` | UI normaliser tests and the daemon analytics test. No live usage reconciliation. |
| 6 Settings | Implemented | `0314cb2`, `aabbd0f` | General, Agents, Runtimes, Permissions, including approval modes. Unit and mounted tests only. |
| 7 Native verification and release | Pending | — | Companion drag/DPI, file drop, both-window approvals, tray Pause all, keyboard, reduced motion, Quit, installer, signing, updater. |

## How to check the desktop app

From `apps/desktop`, or from the repo root via the workspace scripts:

```powershell
npm run typecheck
npm test
npm run build
```

Do not start `desktop:dev`, Vite, the daemon, or Tauri for this check. Do not open `%LOCALAPPDATA%\Bloblex`.

## Still open

- Phase 7 native items above.
- Live provider sessions (Claude Code, Codex, OpenCode) against the current daemon.
- A `context` failure class on the daemon. The UI labels `failureClass: "context"` as "Context full". The daemon's stored classes and `analytics_failure_class` do not emit it, and session turn JSON omits `failureClass`.
- OpenCode thinking: `runtime.capabilities` reports it supported, while prompt preflight treats it as unsupported. That disagreement is in the daemon, not the desktop parser.
- Settings pages for Usage and Billing, language, and theme.
- WSL, signing, and the updater.
