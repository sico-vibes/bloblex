# FIX39 P3 audit (Claude Sonnet 5.5)

> **What this is:** Audit of FIX39 package P3 by Claude Sonnet 5.5.
> **Status:** historical
> **Last updated:** 2026-10-18

**Verdict: PASS WITH FIXES.** All five steps are present and match `docs/history/fix-39/research-audit.md` items 23, 24 and 10 and decision 4. I found no blocking defect. Four small fixes are listed; none needs a design change. I did not rerun the gates, because the report's results are specific and consistent with the diff.

Read: `AGENTS.md`, `docs/history/fix-39/decisions.md`, the P3 section and items 10/23/24 of `docs/history/fix-39/research-audit.md`, `docs/history/fix-39/p3-report.md`, and the full diff (including the untracked `layout.ts`, `layout.test.ts`, `parent_watchdog.rs`).

## 1. Items done as specified

| Item | Result |
|---|---|
| 23 message passthrough and sweep | Done. `useRemote.ts:144` and the three named copies (`ManagerPage`, `MemoryPage`, `SchedulesView`) now use `rpcFailure(reason).message`. The sweep also covers the extra `MemoryPage` and `SchedulesView` catch sites. |
| 23 bind first, probe after failure | Done (`remote/mod.rs` `bind_gateway`, `enable`). The probe runs only when the configured endpoint is occupied, ignores proxies and redirects, and has a 500 ms timeout and a 1 KiB body cap. |
| 23 Bitbots-owned port gives conflict plus `port_in_use`, no `serve` | Done, and tested (`tests.rs:2092`, asserts no `--bg` call). |
| 23 foreign listener gives fallback port, persisted, serve argv uses it | Done, and tested (`tests.rs:2114`). |
| 23 fixed `/api/ping` marker | Done (`web.rs:577`). It is content-free. |
| 23 `starting` and `not_running`, `NeedsLogin` stays `logged_out` | Done (`tailscale.rs`), including the non-zero-exit-with-status case. Stderr is never echoed. |
| Decision 4 watchdog and single instance | Done. The watchdog is in `run` only, holds a `SYNCHRONIZE`-only handle, and feeds the existing `select!` so the normal shutdown (UPnP mapping removal) runs. `tauri-plugin-single-instance` is registered first. |
| 10 snap removed, free drag | Done. `snap.rs`, `companionSnap.ts` and its test are deleted, and no importer remains. |
| 10 debounced persistence | Done. One worker per window, 300 ms quiet, flush on close and on exit, and the launch-time clamp is unchanged. |
| 24 wide layout | Done. `resolveLayout` uses width ≥ 900 and `(pointer: fine)`, with an Auto/Phone/Wide override in `localStorage` wrapped in try/catch, one tree under `data-layout`, and no user-agent sniffing. |

## 2. Correctness findings

**F1 (fix). Windows: a reserved or excluded port range aborts Remote instead of falling back.**
`remote/mod.rs`, `bind_gateway`, the `Err(_) =>` arm (about line 777). Only `AddrInUse` moves to the next candidate. On Windows, a port inside a Hyper-V, WSL or Docker excluded range fails with `PermissionDenied` (WSAEACCES, 10013), not `AddrInUse`. The default 48620 can sit in such a range. `enable` then fails with "could not listen" and the fallback never runs, which is the symptom this item exists to remove.
Fix: treat `ErrorKind::PermissionDenied` like `AddrInUse` for the candidate loop. Do not run the ownership probe for it, because nothing is listening. Keep the final error for the exhausted case. Add a small unit test around the candidate choice if it can be isolated, or note that it is untestable without a real excluded range.

**F2 (fix, small). A recovered conflict leaves `link = "error"`.**
`remote/mod.rs`, `refresh_tailscale`. After the other copy quits, "Check again" clears `gateway_conflict_port` and the Ready branch clears `inner.error` only when `inner.link == "error"`, but it leaves `link` at `"error"`. `link` stays `error` with no message until the next `enable`. Pre-existing semantics for other errors, but this change made it reachable on the happy recovery path.
Fix: in the Ready branch, when `inner.link == "error"` and Remote is not enabled, set `inner.link = "off"`. Add one assertion to `fix39_another_bitbots_gateway_refuses_enable_without_serving` (or a sibling test): after the gateway is gone, `remote.status` reports `tailscale = ready` and `link = off`.

**F3 (note, no change required). The ownership probe hits the other copy's `/api/ping`.**
`ping_get` (`web.rs:565-577`) records "this network" as the reach origin and emits `remote.changed` when that copy runs Native. A conflict probe from loopback can therefore make the other copy show "Reached from this network". It is only possible when the other copy runs Native on this same configured port, which `enable` already forbids by skipping the Native port. I mention it so nobody is surprised; it needs no fix.

**F4 (check, owed to the Director). Single instance versus startup order and the updater.**
`lib.rs`, `run`: `migrate::migrate_before_start()` runs before `tauri::Builder`, so a second launch executes the local-data migration before the single-instance check. It looks idempotent (the legacy directory is gone after the first run), but I did not exercise it. Update-then-restart can also race the first process's mutex: the relaunched shell could treat the dying shell as the "first instance" and exit without a window. This is audit risk 10, and the report lists it as unverified. Treat it as a release blocker for the next build: test update-then-restart on a throwaway build.

Everything else I read is correct:
- Watchdog: `INFINITE` is `u32::MAX`. The handle is closed. A daemon without `BLOBLEX_PARENT_PID` keeps the sender alive, so a dropped sender is never read as a parent exit. A bad pid fails startup loudly. The 5 s bound with `process::exit(0)` is correct.
- Debounce worker: handles timeout, flush and disconnect, and writes pending state on disconnect.
- Wide-layout CSS: the phone rules are unchanged except that the roster padding (14 px) matches the old `.rm-main` padding.

## 3. Tests prove it

- `useRemote.test.tsx:156`: a string rejection keeps the daemon text. It fails on the old code (the old code returned the UI fallback). Good behaviour test.
- `tests.rs:2092` and `:2114`: real sockets, not mocks of the helper. Both would fail on the old code. Good.
- `tailscale.rs:577,588,602`: behaviour through `evaluate` and `probe`. Good.
- `parent_watchdog.rs`: a real daemon, a real parent, an abrupt exit, listener closed and (on Windows) process exited. It fails if the watchdog is removed. Good. Cleanup kills only the pid it created.
- `rapid_moves_write_once_after_quiet_and_close_flushes` tests the debounce worker with a closure, not the Tauri event wiring (`on_window_event`). That is unavoidable without a window. The manual drag test remains required (risk 11).
- `RemoteApp.mounted.test.tsx` layout tests assert structure with a mocked `matchMedia`. They prove selection logic, not appearance.

**F5 (fix, small). No test covers the three swept pages.**
`ManagerPage`, `MemoryPage` and `SchedulesView` changed their error text behaviour (the `code: ` prefix is now stripped and plain strings are shown), with no new test. Add one mounted assertion per page, or one shared test of the changed catch path, with a string rejection (`conflict: Real reason`) showing `Real reason`. Without it the sweep can regress silently.

## 4. Scope

Within the P3 file list. The additions outside it are justified:
- `Cargo.lock` follows the new dependency.
- `layout.test.ts` and `parent_watchdog.rs` are tests.
- `docs/history/fix-39/p3-report.md` is the report.

Hot files: `main.rs` is touched only in `run` (watchdog and one `select!` arm). `App.tsx`, `TeamSidebar.tsx`, `team.rs` and `storage/lib.rs` are untouched. No generated files are in the diff.

**F6 (nit). Import placement.** In `ManagerPage.tsx`, `MemoryPage.tsx` and `SchedulesView.tsx` the new `import { rpcFailure }` sits above the file's leading comment block, and in `useRemote.ts` and `RemoteApp.tsx` it sits above the React import. Move each into the existing import group so the files read like their neighbours.

## 5. Security rules

- No new daemon method or event, so no `tiers.json` row is needed. Parity tests are green per the report.
- `/api/ping` returns the fixed `{"ok":true,"app":"bitbots","role":"remote-gateway"}`: no host, owner or account data.
- New daemon error text names only a port number. No credentials, conversation text or command text. Tailscale stderr is not echoed, and status JSON is not logged.
- Gateway stays loopback-only. Fallback candidates are loopback, and the Native port is skipped. No approval path changed.
- The watchdog opens the parent with `SYNCHRONIZE` only.

## 6. Visual rules

- No sparkle or star icons were added.
- The wide CSS uses theme tokens (`--surface-*`, `--line`, `--text-*`) that `theme.css` defines for both themes. The remote bundle has no look switch, so "both looks" applies only to the desktop `RemoteSettings` strings, which are plain text.
- `Select` is new to the remote bundle. `.select-trigger` styling comes from `theme.css`, `shell.css` and `bitbots.css`. The remote `main.tsx` loads only `theme.css`, `styles.css`, `accent.css` and `polish.css`. The Director must look at the Layout control in the phone and wide views, in both themes. If it renders unstyled, add the minimum trigger and menu rules to `remote.css`.

## 7. Docs owed (for the Haiku lane, not Sol)

- `docs/ipc-contract.md:147` lists the `remote.status.tailscale` values without `starting` and `not_running`.
- `apps/desktop/src/preview/fixtureBridge.ts:34-39` (`REMOTE_PREVIEW_FLAGS`) lacks the two new states, so the browser preview cannot select them even though `remoteFixture.ts` supports them. This is a one-line fix and may be done by Sol with F2/F5.

## Fix list for Sol

1. F1: treat `PermissionDenied` as a skip in `bind_gateway`.
2. F2: reset `link` to `off` on recovery, with an assertion.
3. F5: add a swept-page error-text test.
4. F6: move the imports.
5. Add the two new states to `REMOTE_PREVIEW_FLAGS` in `fixtureBridge.ts`.

## Owed before release (Director)

- Tailscale on a live tailnet, including the conflict message from a real second copy.
- One manual companion drag on Windows (drag, release, no lag, position kept across close and reopen).
- Single instance and update-then-restart on a throwaway build (F4).
- Wide and phone layouts in both themes, including the `Select` control.
