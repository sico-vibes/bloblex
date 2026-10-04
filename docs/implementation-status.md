# Implementation status

Current as of 4 October 2026. Plan: [E2E_PLAN_V2.md](E2E_PLAN_V2.md). Handoff: [SESSION_HANDOFF.md](../SESSION_HANDOFF.md).

**Evidence class:** desktop unit and mounted tests, plus daemon and adapter tests that use in-memory storage or fake processes. Release `v0.1.0-beta.4` is the latest release. Work after beta.4 is on main and unreleased. There is still no accepted live-provider session and no native window pass of the current tree. The Phase 3 isolated-database smoke (`5138c8e`, revision `e770db8`, [NATIVE_SMOKE_RESULTS.md](NATIVE_SMOKE_RESULTS.md)) is the only recorded native pass.

## Phase status

| Phase | Status | Evidence | Verification limit |
| --- | --- | --- | --- |
| 1 Logo and icons | Implemented | `7f10e60` | Asset script and files. |
| 1.5 CLI capability record | Implemented | `2b4b92f` | Recorded probes in [runtime-capabilities.md](runtime-capabilities.md). Not a live session pass. |
| 2a Blob storage and RPCs | Implemented | `1b0232a` | Storage and daemon tests. The Phase 3 smoke exercised migration and the roster on an isolated database. |
| 3 Blob roster and editor | Implemented | `92f626a` | Unit/mounted tests, plus the isolated native smoke above. Defects N1–N4 in that smoke were not re-run natively. |
| 4 Project and session tree | Implemented | `395fd78` | Unit and mounted tests only. |
| 2b Execution options | Implemented | `2dc0ae9`, `013e32b`, `73c4f03`, `9045022`, `7c0eb77` | Fake-process adapter tests and storage tests. No live CLI execution of the current adapters. |
| 5 Usage analytics | Implemented | `55808fa`, `07bb620` | UI normaliser tests and the daemon analytics test. No live usage reconciliation. |
| 6 Settings | Implemented | `0314cb2`, `aabbd0f`, redesign `aea5eb1` | General, Agents (runtimes and approvals merged in), Usage & limits, Updates. Unit and mounted tests only. |
| 7 Native verification and release | Partly done | updater `f15f9d2`…`889bb93`, releases beta.1–beta.3 | Updater, release script and public beta releases are done. Native window checks, code signing and a clean-machine install are open. |

## Work after the plan phases

| Change | Evidence | Verification limit |
| --- | --- | --- |
| Interface redesign: chat-style shell, one-page blob editor, custom dropdowns, settling blob moods, favourites and pins, companion launch and welcome | `aea5eb1`, `bb76b7e`, `70222f2` (released as beta.2 and beta.3) | Unit and mounted tests, browser preview with fixtures. |
| Batch A: unread markers, Windows notifications, rename/archive/delete conversations (migration 6), grouped tool activity, Start with Windows | Batch A commit on main (3 Oct) | Unit, mounted, storage and daemon tests (fake adapters). Toast click activation is not supported on Windows. Not yet in a release. |
| Batch E: model list provenance (source, update time, suggestions vs validated), presentation overlay (names, default marker, family groups), OpenCode instruction/mode fixes | Batch E commit on main (3 Oct) | Fake-peer and daemon tests. Codex per-turn context is not possible with the installed app-server schema. Not yet in a release. |
| Patch D: Settings > Usage & limits (budgets, price overrides, subscription fees), Analytics links and budget card, export a conversation as Markdown, export/import a blob setup | Patch D commit on main (3 Oct) | Unit, mounted, storage and native-command tests. Cost budgets are not offered (turn admission cannot estimate cost yet). Not yet in a release. |
| Batch B: Ctrl+K quick switcher, composer model and thinking switch, safe Markdown, unified diff view and approval shortcuts shared with the companion | `863a779` | Unit and mounted tests only. No native window or live-provider check. Not yet in a release. |
| B1: shared Codex app-server and OpenCode ACP processes per runtime key, per-session queues, idle shutdown, crash restart and resume, bounded cancel | `1f802b0` | Unit and fake-process tests only. No native window or live-provider check. Not yet in a release. |
| Batch C: first-run setup for empty installs, companion start position and hotkey, system/dark/light themes, text size, and reorderable favourites and pins | `e6b1076` | Unit and mounted tests only. No native window or live-provider check. Not yet in a release. |
| Blob wardrobe: per-blob outfits, seasonal automatic outfit, wardrobe editor, migration 7 | `0d21c46` | Unit and mounted tests only. No native window or live-provider check. Not yet in a release. |
| Launch intro and startup checks, companion off by default with sidebar toggle and open-at-startup setting, and three-step first-run onboarding with install/sign-in guides | `a862351` | Unit, mounted and fake-process tests only. Startup timing, companion window lifecycle, install/sign-in flows and native behavior have not been checked in a live app. Not yet in a release. |
| OpenCode Go models and official model prices: 150 exact-decimal rows, price tiers, per-field sources, migration 8 | `9561e7d` | Workspace tests, desktop check, typecheck, Vitest and build passed. These use unit/mounted tests, in-memory storage and fake processes; no live provider or native-window verification. Not yet in a release. |

The three changes above were implemented by the `impl` lane, reviewed by `impl-b` over two or three rounds, and merged by the Director after gates. The current main gates passed: `cargo test --workspace` (231 passed), desktop check, typecheck, Vitest (338/338), and build. These checks do not establish native-window behavior or live-provider operation.

## How to check the desktop app

From `apps/desktop`, or from the repo root via the workspace scripts:

```powershell
npm run typecheck
npm test
npm run build
```

Backend: `cargo test --workspace` and `cargo check -p bloblex-desktop --lib` with a private `CARGO_TARGET_DIR`. Do not start `desktop:dev`, Vite, the daemon, or Tauri for this check. Do not open `%LOCALAPPDATA%\Bloblex`.

## Still open

- Phase 7 native items: companion drag/DPI, file drop, approvals in both windows, tray Pause all, keyboard, reduced motion, launch checks and onboarding, Quit, code signing, clean-machine install.
- Live provider sessions (Claude Code, Codex, OpenCode) against the current daemon.
- Cost budgets enforced before a turn (needs a same-currency cost estimate at admission).
- A `context` failure class on the daemon (the UI already labels it "Context full").
- WSL.
