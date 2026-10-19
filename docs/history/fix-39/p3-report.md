# FIX39 P3 report — Remote and native shell (items 23, 24, 10)

> **What this is:** Report for FIX39 package P3: Remote and native shell (items 23, 24 and 10).
> **Status:** historical
> **Last updated:** 2026-10-18

**Package:** P3, package definition in `docs/history/fix-39/research-audit.md:234-238`, owner decisions in `docs/history/fix-39/decisions.md:25`.
**Branch:** `lane/fix39-p3` at `C:\fx83` (Cargo target `C:/fxt/d3`). No `git commit` was run.
**Handover:** the implementation was left uncommitted by the previous implementer (Sol), who stopped without a report. This session checked every step of P3 against the audit, found all five steps present and correct, repaired a broken local build cache (outside the repository), ran all gates and wrote this report. No production code was changed by this session; it changed nothing in the diff except this report. `docs/history/fix-39/p3-audit.md` does not exist, so there were no extra audit findings to apply.

## Step 1 — Remote error passthrough and the error-message sweep (item 23)

**What changed**
- `apps/desktop/src/remote/useRemote.ts:1,144`: the action error now goes through `rpcFailure(reason).message` instead of only reading `reason.message`. A daemon rejection that arrives as a plain string (Tauri `invoke`) therefore keeps its real text; only the `code: ` prefix is stripped. The UI's own fallback text is only used when there is no text at all.
- The same helper replaced the three copies the audit named:
  - `apps/desktop/src/ui/ManagerPage.tsx:1,84,100`
  - `apps/desktop/src/ui/MemoryPage.tsx:1,70,78,133,212`
  - `apps/desktop/src/ui/SchedulesView.tsx:1,130,297,311`
- `apps/desktop/src/ui/RemoteSettings.tsx:171,254` already renders `status.error` / `state.error`, so the real daemon sentence (port conflict, Tailscale refusal) is what the owner sees.

**Tests**
- `apps/desktop/src/remote/useRemote.test.tsx:156` — a string rejection `conflict: Another copy of Bitbots is already serving Remote on this computer.` leaves exactly `Another copy of Bitbots …` in `state.error`, after a status reload, with `tailscale: 'port_in_use'`.

## Step 2 — Port conflict, ping marker, fallback port, Tailscale states (item 23)

**What changed**
- Bind first, probe after failure: `enable` now binds through `bind_gateway` (`crates/bloblex-daemon/src/remote/mod.rs:764`) before touching Tailscale (`:810-833`), so there is no probe/bind race. The Tailscale target and `serve` publication use the port actually bound.
- Conflict detection: only when the configured endpoint is occupied is it probed with `GET /api/ping` (`is_bitbots_gateway`, `mod.rs:747`). A Bitbots gateway produces the conflict text “Another copy of Bitbots is already serving Remote on this computer. Quit the other copy (or restart Bitbots), then try again.”, `tailscale = port_in_use`, `link = error`, and a `conflict` RPC error; no `tailscale serve` is started. `gateway_conflict_port` (`mod.rs:245,711-717`) survives status reloads while that gateway still answers, and is cleared once it is gone so “Check again” can recover.
- Fallback: a foreign listener (anything that does not answer with the Bitbots marker) moves the gateway to the next free loopback port — configured port, then `+1 … +9` skipping the Native port, then an OS-assigned port (`bind_gateway:764-782`) — and the chosen port is persisted as `remote.port` (`mod.rs:875`). It is also what `serve` publishes.
- Ping marker: `GET /api/ping` answers the fixed, content-free `{"ok":true,"app":"bitbots","role":"remote-gateway"}` (`crates/bloblex-daemon/src/remote/web.rs:577`). Nothing about the host, owner or account is added.
- Tailscale state map: `Starting` and `NotRunning` added (`crates/bloblex-daemon/src/remote/tailscale.rs:165-166,178-179`). A CLI failure or an unreadable status is `not_running` with advice to open Tailscale, not `logged_out` (`:279,287,307`); `NeedsLogin` stays `logged_out` (`:306`); `Starting`/`NoState` map to `starting` (`:305`). A non-zero CLI exit that still reports a known `BackendState` keeps that state (`:269-277`). Stderr is never echoed.
- The TS contract and UI cover the new states: `apps/desktop/src/remote/remoteContract.ts:35`, `apps/desktop/src/ui/RemoteSettings.tsx:25-26`, `apps/desktop/src/preview/remoteFixture.ts:89-90`. The `port_in_use` help text no longer claims only “another app uses the port”, since it now also covers a second Bitbots.

**Tests**
- `crates/bloblex-daemon/src/remote/tests.rs:2092` — a real gateway on the port: `enable` returns `conflict`, the message names the other copy, state is `port_in_use`, no listener is kept, `remote.status` reports it, and the fake CLI was never asked to `serve --bg`.
- `crates/bloblex-daemon/src/remote/tests.rs:2114` — a foreign JSON service holds the port: `enable` succeeds on a different bound port, `remote_port` reports the persisted port, and the serve argv carries that port.
- `crates/bloblex-daemon/src/remote/tests.rs:1775` — `/api/ping` returns exactly the marker JSON (and still records “this network” as the reach origin).
- `crates/bloblex-daemon/src/remote/tailscale.rs:577,588,602` — `Starting`/`NoState` → `starting`, `Stopped`/service failure → `not_running`, `NeedsLogin` → `logged_out`, including the non-zero-exit-with-status case.
- `apps/desktop/src/ui/RemoteSettings.mounted.test.tsx:92` — `port_in_use`, `starting` and `not_running` each show their own title and keep “Allow remote devices” disabled.
- `apps/desktop/src/preview/remoteFixture.test.ts:60` — every non-ready state, including the two new ones, refuses to enable with the matching text.

## Step 3 — Parent watchdog and single instance (item 23, decision 4)

**What changed**
- The shell passes its own pid to the daemon it spawns (`apps/desktop/src-tauri/src/lib.rs:262`, `BLOBLEX_PARENT_PID`).
- The daemon opens that process with `SYNCHRONIZE` only (no memory or termination rights), waits on its handle, and exits when it is signalled (`crates/bloblex-daemon/src/main.rs:3945-3986`). The wait feeds a oneshot into the existing `tokio::select!` in `run` (`main.rs:4096`), so the normal shutdown path (including removing Bitbots' own UPnP mapping) runs. A five-second bound and `process::exit(0)` follow so a stuck adapter cannot keep an orphan alive. Unix uses `getppid`. A daemon started without the variable (manual run, tests) is unchanged and never treats a dropped sender as a parent exit.
- `tauri-plugin-single-instance` is registered before every other plugin (`lib.rs:2375-2381`; `apps/desktop/src-tauri/Cargo.toml:21`; `Cargo.lock`), and a second launch focuses, unminimises and shows the existing main window instead of starting a second daemon.
- `apps/desktop/src-tauri/src/lib.rs:2536-2539`: the shell also flushes the companion position on `RunEvent::Exit`.

**Tests**
- `crates/bloblex-daemon/tests/parent_watchdog.rs` (new): `daemon_exits_when_its_parent_disappears` starts a helper test process, the helper starts the real `bitbotsd` with its pid, waits for the printed loopback address, then exits abruptly; the test proves the daemon's listener closes and the daemon process exits. `parent_helper` is the helper. On failure the cleanup kills only the daemon this test created.
- Second-launch behaviour itself is not unit-testable here; see “Not checked”.

## Step 4 — Companion: remove snap, debounce persistence (item 10)

**What changed**
- Snap removed completely: `apps/desktop/src-tauri/src/snap.rs`, `apps/desktop/src/blob/companionSnap.ts`, `apps/desktop/src/blob/companionSnap.test.ts` and `mod snap` are deleted. No importer remains (`grep` for `companionSnap`/`mod snap`/`snap::` is empty).
- `Moved` no longer does monitor queries, file IO or thread creation on the window-event thread. It sends `Moved` on a channel; one worker per window waits for 300 ms of quiet and then performs a single `persist_companion_position` (`apps/desktop/src-tauri/src/lib.rs:1930-1945,2058-2070`).
- A close request sends `Flush` and writes immediately (`lib.rs:2071-2075`); the process exit path writes once more (`lib.rs:2536-2539`).
- The launch-time clamp (`clamp_physical_position`, `lib.rs:1377`, used by `companion_launch_spot`, `:1892`) and the UI “Reset companion position” action (`apps/desktop/src/ui/App.tsx:3763`) are unchanged.
- The debounce worker is also robust to a dropped channel (writes any pending position and stops).

**Tests**
- `apps/desktop/src-tauri/src/lib.rs:2737` — `rapid_moves_write_once_after_quiet_and_close_flushes`: 20 queued moves produce exactly one write after the quiet period, no second write, then a move plus a close flush produce exactly one more write, and the worker ends with nothing pending.
- `cargo test -p bloblex-desktop --lib`: 57 passed.

## Step 5 — Wide browser layout (item 24)

**What changed**
- New `apps/desktop/src/remote/layout.ts`: `resolveLayout` is wide when width ≥ 900 px **and** `(pointer: fine)`, unless the owner chose `phone` or `wide`; `useRemoteLayout` keeps the choice in `localStorage` (`bitbots.remote.layout`) with try/catch on both read and write and reacts to both media queries. No user-agent sniffing.
- `apps/desktop/src/remote/RemoteApp.tsx:117,269` puts one component tree under `.rm-stage[data-layout=…]`. In wide mode the roster (search, bots, the active bot's conversations) sits beside the conversation, the bottom tabs and the back arrow are not rendered, and “This device” stays reachable from the roster header (`:295-302`). The phone tree is unchanged.
- “This device” gains a small Auto / Phone / Wide choice (`RemoteApp.tsx:505-508`) using the existing `Select`.
- `apps/desktop/src/remote/remote.css:167-188`: wide removes the phone frame, lays out a two-column workspace, and bounds the device page, connect/waiting screens, messages and log so the wide view is not a stretched phone.

**Tests**
- `apps/desktop/src/remote/layout.test.ts:5` — the `resolveLayout` table (≥900, fine pointer, coarse pointer, each override).
- `apps/desktop/src/remote/RemoteApp.mounted.test.tsx:297,310,316` — mounted with a mocked `matchMedia`: wide shows roster and chat together with no tabs and follows a resize back to phone; a coarse pointer stays phone; a stored `phone` override wins and changing it to Wide persists `bitbots.remote.layout = 'wide'`.
- `apps/desktop/src/remote/remoteBuild.test.ts` and the tiers parity tests are part of the green suite below.

## Gates (run in this worktree, `CARGO_TARGET_DIR=C:/fxt/d3`)

| Gate | Result |
|---|---|
| `cargo test --workspace --exclude bloblex-desktop --no-fail-fast` (`RUST_MIN_STACK=33554432`) | **pass**, exit 0: 44 test targets ok, 735 tests passed, 0 failed (includes the 2 `parent_watchdog` tests and the new remote/tailscale tests) |
| `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` | **pass** (finished with no warnings) |
| `cargo test -p bloblex-desktop --lib` | **pass**: 57 passed, 0 failed |
| `cargo check -p bloblex-desktop --lib` | no warnings |
| `cd apps/desktop && npx tsc -b` | **pass** |
| `npx vitest run --maxWorkers=3` | **pass**: 164 files, 1159 tests, 0 failed |
| `npm run build` | **pass** |
| `npm run build:remote` | **pass** |

Notes on the gates:
- The first full Rust run had one transient failure, `phase2a_tests::session_environment_reports_a_git_branch` (`git commit` failed while the machine was loaded). It passes alone and in a clean full rerun of the bin target (351 passed), and the final full workspace run above is clean. It is load-sensitive, not related to P3.
- `cargo test -p bloblex-desktop --lib` initially could not link `sherpa-onnx-c-api`: the local prebuilt cache under `C:/fxt/d3/sherpa-onnx-prebuilt` was a truncated archive plus a half-extracted `lib` directory. I removed the corrupt cache and copied a complete extraction from another existing target directory (`C:/fxt/a5`) into `C:/fxt/d3`. No repository file was involved.
- `cargo clippy -p bloblex-desktop --lib -- -D warnings` is **not** a gate and fails on seven pre-existing lints in `speech.rs`, `power.rs` and untouched `lib.rs` functions; none is in the P3 diff. `cargo fmt --check` already fails on unrelated pre-existing formatting in `lib.rs` at the branch point, so neither was treated as a P3 regression.
- To run the desktop gates at all I built and staged the gitignored sidecars with `node scripts/stage-daemon.mjs` into `apps/desktop/src-tauri/binaries/` (debug, gitignored). No tracked file was added.

## Not checked here (owed to the Director / release)

- **Live Tailscale**: the fix was proven by unit tests and a fake CLI; turning Remote on against a real tailnet, the conflict message from a real second gateway, and the fallback port with real `tailscale serve` are not verified in this worktree.
- **Real phone / tailnet** remains unverified, as at beta.30.
- **Companion drag on Windows**: the 300 ms debounce and the removal of the snap need one manual drag (drag, release, it stays; no lag), and a check that closing and reopening restores the last position. Unit tests cannot prove the felt behaviour (audit risk 11).
- **Single instance and updater**: a second launch focusing the first window, and update-then-restart, need a throwaway build (audit risk 10). The plugin is new to the shell.
- **Wide layout visually**: a real wide browser window and a phone-sized window in both themes and both looks; tests prove structure, not appearance (audit risk 9). The Director should also confirm the `Select` control looks right inside the remote bundle, which does not load the desktop settings CSS.
- **`/api/ping` on an existing tailnet**: the new marker is fixed and content-free, but a phone hitting it on a live serve was not exercised.

## Files touched outside the P3 list

None in git. The only work outside the listed source files was:
- generated, gitignored build outputs: `apps/desktop/src-tauri/binaries/*` (staged debug sidecars), `apps/desktop/dist/`, `apps/desktop/dist-remote/`;
- the local Cargo cache repair under `C:/fxt/d3/sherpa-onnx-prebuilt` described above;
- `apps/desktop/src-tauri/gen/schemas/{desktop,windows}-schema.json`, which the Tauri build rewrote with LF line endings and which were restored from the index afterwards. Their blob hashes are unchanged, so they carry no content change.

No `docs/` file other than this report was edited. No `git commit` was run.

## Follow-up (audit)

`docs/history/fix-39/p3-audit.md` (Claude Sonnet 5.5) now exists with verdict **PASS WITH FIXES** for all five P3 steps. This session (a second implementer, taking over after the first ran out of usage) applied the requested findings F1, F2, F5 and F6, left F3 and F4 as the audit directed, and reran every gate. The text above is the first session's record and is unchanged; the note in its step 1 that no audit file existed was true at that time.

### F1 — a reserved or excluded Windows port range must not abort Remote (`remote/mod.rs`)

- `crates/bloblex-daemon/src/remote/mod.rs:774` and `:781`: two small classifiers, `bind_error_allows_fallback` and `bind_error_is_occupied`. `bind_gateway` (`:785`) now treats `ErrorKind::PermissionDenied` like `AddrInUse` in the candidate loop: the candidate is skipped and the `+1 … +9`/OS-assigned fallback continues, so a default port inside a Hyper-V, WSL or Docker excluded range (WSAEACCES, 10013) no longer aborts Remote. The ownership probe runs only for `AddrInUse` (`bind_error_is_occupied`), because a permission failure means nothing is listening. Any other error kind remains fatal with the old message, and the exhausted-candidate error is unchanged.
- Test: `crates/bloblex-daemon/src/remote/tests.rs:2155` `bind_failures_that_rule_out_only_one_candidate` — asserts `AddrInUse` and `PermissionDenied` both allow the next candidate, only `AddrInUse` is probed, and other kinds stay fatal. This is the isolated unit test the audit allowed (it cannot be driven end to end without a real excluded range).

### F2 — a recovered conflict must not leave `link = "error"` (`remote/mod.rs`)

- `crates/bloblex-daemon/src/remote/mod.rs:725-733`: in `refresh_tailscale`'s Ready branch, when `link == "error"` the error is cleared and, if Remote is not enabled, `link` is set back to `"off"`. With Remote on, the link keeps its own state. "Check again" after the other copy quits therefore shows the switch off, not stuck on `error`.
- Test: the existing `fix39_another_bitbots_gateway_refuses_enable_without_serving` (`tests.rs:2092`; recovery block at `:2111`) now disables the other gateway, waits for its marker to stop answering, reloads `remote.status`, and asserts `tailscale = "ready"`, `link = "off"` and a null `error`.

### F3 — the ownership probe may mark the other copy "Reached from this network" (no change)

Recorded as the audit requires. The probe hits the other copy's `/api/ping`, which records a reach origin; it is only reachable when the other copy runs Native on the same configured port, which `enable` already forbids by skipping the Native port. No code change.

### F4 — single instance versus startup order and the updater (no change; owed to the Director)

Recorded as the audit requires. `migrate::migrate_before_start()` still runs before the single-instance check, and update-then-restart can race the dying process's mutex. It needs a throwaway build (audit risk 10 / "Owed before release"). No code change; unchanged from the first report's "Not checked".

### F5 — a test for the three swept pages

Three mounted assertions, each rejecting a status call with the plain string `conflict: Real reason` and asserting the page shows exactly `Real reason` (code prefix stripped):

- `apps/desktop/src/ui/ManagerPage.mounted.test.tsx:90` (via `manager.profile.list`),
- `apps/desktop/src/ui/MemoryPage.mounted.test.tsx:165` (via `memory.list`),
- `apps/desktop/src/ui/SchedulesView.mounted.test.tsx:170` (via the global-pause handler).

Each fails on the pre-sweep code, which showed the page's own fallback for a string rejection instead of the daemon's text.

### F6 — import placement

The new imports were moved into each file's import group, below the leading comment block and the React import:

- `apps/desktop/src/ui/ManagerPage.tsx:9`, `apps/desktop/src/ui/MemoryPage.tsx:10`, `apps/desktop/src/ui/SchedulesView.tsx:7` — `rpcFailure` now sits with the other module imports;
- `apps/desktop/src/remote/useRemote.ts:2` — `rpcFailure` below the React import;
- `apps/desktop/src/remote/RemoteApp.tsx:2-3` — `./layout` and `../ui/Select` below the React import.

### Fix-list item 5 — preview flags

`apps/desktop/src/preview/fixtureBridge.ts:39` (`REMOTE_PREVIEW_FLAGS`) gains `starting` and `not_running`, which `remoteFixture.ts` already supports, so the browser preview can select them. The flag comment above it names both states. This file is outside the P3 list but the audit explicitly allowed this one-liner with F2/F5.

### Gates rerun in this worktree (`CARGO_TARGET_DIR=C:/fxt/d3`)

| Gate | Result |
|---|---|
| `cargo test --workspace --exclude bloblex-desktop --no-fail-fast` (`RUST_MIN_STACK=33554432`) | **pass**, 0 failed; the `bitbotsd` bin target is 352 passed (351 before, +1 new unit test) |
| `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` | **pass**, no warnings |
| `cargo test -p bloblex-desktop --lib` | **pass**: 57 passed, 0 failed |
| `cd apps/desktop && npx tsc -b` | **pass** |
| `npx vitest run --maxWorkers=3` | **pass**: 164 files, 1162 tests, 0 failed (1159 before, +3 F5 tests) |
| `npm run build` | **pass** |
| `npm run build:remote` | **pass** |

`cargo test -p bloblex-daemon -- remote::tests::fix39_ remote::tests::bind_failures` was also run first and passed 3/3. The `cargo test` run prints two pre-existing `unused_mut` warnings in `main.rs:4699,4721` (test-only code, not in the P3 diff and not seen by the clippy gate).

### Scope and status

- Files changed by this session: `crates/bloblex-daemon/src/remote/mod.rs`, `crates/bloblex-daemon/src/remote/tests.rs`, the three `*.mounted.test.tsx` files above, the five import placements, `apps/desktop/src/preview/fixtureBridge.ts`, and this report. All are on the P3 list except `fixtureBridge.ts` (justified above) and the report.
- No `git commit` was run. Everything from the first session is preserved untouched.
- Still owed to the Director (unchanged): live Tailscale, a real phone, one manual companion drag on Windows, wide/phone layouts in both themes and the `Select` control, and F4 (single instance and update-then-restart).
