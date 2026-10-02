# Native smoke test results (Phase 2a + Phase 3)

Run by the Director on 2 October 2026, ~07:40-08:20 BST, git revision `e770db8`, Windows 11, real `npm run desktop:dev` build against an **isolated database** (`BLOBLEX_DB_PATH` set to a scratch file; the live inspection database and the two earlier dev daemons were never touched). Screenshots are in [docs/evidence/native-smoke/](evidence/native-smoke/); tooling is in [scripts/native-smoke/](../scripts/native-smoke/) (WebView2 remote-debugging port + UI Automation + synthesized mouse input; no extra dependencies).

## Part A: Phase 2a migration against a REAL v1 database

The pre-Phase-2a sidecar (`bloblexd`, 1 Oct 19:48) was run on a scratch path to produce a genuine v1-schema database (it discovered the three installed runtimes), then seeded with 4 sessions / 4 turns / 4 usage rows including an orphaned runtime and a usage row with no session. The current daemon then opened it.

| Check | Result |
| --- | --- |
| Backup + manifest written before any DDL (integrity ok, schemaVersion 1, row counts) | PASS |
| `user_version` 2, ledger `[1,2]`, `integrity_check` ok, `foreign_key_check` 0 rows | PASS |
| One default blob per runtime; canonical uppercase colours (`#F38C6F`, `#82AAFF`, `#BF9CFF`), descriptions, sort order 0 | PASS |
| Sessions backfilled to their runtime's blob; orphaned-runtime session stays `NULL` | PASS |
| Usage rows backfilled from their session; orphan and missing-session rows stay `NULL` | PASS |
| Row counts unchanged (sessions 4, turns 4, usage 4) | PASS |
| Second open: no new backup, same agent ids, no extra ledger rows (idempotent) | PASS |

Observation: the backup directory also contains `-shm`/`-wal` sidecar files next to the backup `.db` (the WAL is 0 bytes). Harmless, but the restore helper copies only the `.db`.

## Part B: native app, checklist of docs/PHASE_3_SPEC.md section 9

| Step | Result | Evidence |
| --- | --- | --- |
| 1-5 Revision recorded; isolated DB created and in use; live DB write time/size unchanged (WAL 1,009,432 bytes, 23:46:07 on 1 Oct) | PASS | n/a |
| 6 Roster: one blob per runtime, colours coral / blue / violet, runtime label under each, real CLI versions | PASS | `01-main-native.png` |
| 6b Companion compact bar shows the selected blob and peer minis | PASS | `02-companion-native.png` |
| 7 Edit Claude, change colour to pink, save: sidebar row, chat header face, large face, companion island face, companion mini and companion focus card are pink; stored as `pink`; exactly one persisted `agent.changed` event | PASS | `03`, `04`, `15` |
| 8 Tray menu (opened through UI Automation): Open Bloblex, **Active sessions**, **Pause all agents...**, Show / hide companion, Refresh runtimes, Settings, Quit Bloblex | PASS | text list (menu is a native popup) |
| 9 Companion window transparent around a rounded opaque island (wallpaper visible at all four corners) | PASS | `12-companion-on-desktop.png` |
| 9 Free drag: window moved by exactly (+300, +250) when dragged from the top strip | PASS (partial, see N1) | `13-companion-after-drag.png` |
| 9 Free drag from the face or the name/status text | **FAIL** (N1) | n/a |
| 10 Second blob on the same runtime ("Pink sibling", lemon, "Second blob."): both rows show, faces differ | PASS | `06`, `07` |
| 10 Real sessions started per blob (`session.new` with `agentId` through the app bridge, because the native folder picker cannot be driven): each linked to its own agent, state `idle`; both ids together rejected `invalid_argument` | PASS | n/a |
| 11 Archive confirmation shows the specified wording; row leaves roster; selection falls to the next blob; archived row keeps its original `sort_order` (QA finding F1 verified on a real run) | PASS | `10`, `11` |
| 12 Quit from the app menu: app, daemon, both real `claude.exe` sessions, conhost and Vite all exit; the app's daemon copy is removed; the two earlier dev daemons and the user's `opencode` process are untouched | PASS | n/a |
| 13 Restart against the same DB: pink colour, archived sibling absent, selection and the new session persist (session offline with Resume control) | PASS | `18-main-after-restart.png` |
| Expanded companion: focus card with honest "Cost Unknown", blob pills from agents with selection glow | PASS | `14-companion-expanded.png` |

## Defects found

| ID | Severity | Finding | Where |
| --- | --- | --- | --- |
| N1 | major | Dragging the companion by its face or its name/status text does nothing. The mouse-down lands on `.compact-copy` / the face canvas, which sit inside the `data-tauri-drag-region` element but do not carry the attribute themselves; Tauri only starts a drag when the event target itself carries it. Dragging from the empty top strip works. Capability `core:window:allow-start-dragging` is granted. | `apps/desktop/src/ui/App.tsx` (~1549-1566), `companion.css` |
| N2 | minor | Expanding the compact companion near a monitor edge is not clamped to the work area: the window grew from 344x62 to 640x160 anchored at bottom-centre and ended 87 px past the right edge of its monitor (x = -553..87 on a monitor ending at x = 0). | `apps/desktop/src-tauri/src/lib.rs` `set_companion_mode` (~765-835) |
| N3 | minor | The companion focus card shows tokens/cost totals that are daemon-wide (2,575 tokens) under whichever blob is selected, which reads as per-blob. Per-agent attribution belongs to Phase 5; until then the card should label the figure as total. | `apps/desktop/src/ui/App.tsx` companion card |
| N4 | nit | Backup directory contains sidecar files beside the backup `.db`. | `crates/bloblex-storage/src/lib.rs` `verified_backup` |

## Not covered

- Native folder picker dialog (cannot be driven programmatically); sessions were started through the same RPC the picker feeds.
- Real file drop onto the companion, multi-DPI behaviour (single DPI 100% monitor setup here), reduced-motion setting, and tray "Pause all agents" action (menu item presence only).
- Installer/signing/updater (Phase 7).
