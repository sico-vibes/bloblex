# Phase 4B spec: keep the computer awake while Bitbots has work (native)

> **What this is:** Spec for phase 4B: keeping the computer awake while Bitbots has work (native).
> **Status:** historical
> **Last updated:** 2026-10-15

Owner: OpenCode lane (native Rust only). Reviewer: Director. The UI decides when it is wanted and calls these commands; do not touch `apps/desktop/src` or the daemon.
Scope: new `apps/desktop/src-tauri/src/power.rs`, registration in `apps/desktop/src-tauri/src/lib.rs`. No new dependencies (declare the one Win32 function with an `extern "system"` block).

## Rules
- Work only in this worktree; **do not read or list any path outside it** (an out-of-tree read is auto-rejected and ends your session). Never run git commit/push/checkout/stash.
- `CARGO_TARGET_DIR=D:/b-p7`. The desktop crate cannot be checked from this path (the apostrophe in the folder name breaks the Windows resource compiler), so keep the new module small, dependency-free and unit-testable with the crate-independent logic isolated behind a trait; say plainly that the desktop crate was not compiled here.
- Match repo style. No `unwrap()` outside tests.

## Behaviour
- Command `set_keep_awake(enabled: bool) -> Result<bool, String>` returns the state now in force. Command `keep_awake_state() -> bool`.
- On Windows: while enabled, a single dedicated parked thread calls `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` (not `ES_DISPLAY_REQUIRED`: the screen may sleep). The execution state is per-thread, so the thread must stay alive until disabled. Disabling or app exit calls `SetThreadExecutionState(ES_CONTINUOUS)` on that thread and lets it end. Enabling twice is a no-op; disabling when off is a no-op.
- Non-Windows: store the flag, do nothing else, return Ok.
- Also release on `RunEvent::Exit` / state drop so a crash path never leaves the request held (the OS also drops it when the thread dies).
- It never prevents the user from putting the computer to sleep (lid close, Start menu); document that in the module comment.

## Tests
A `PowerBackend` trait with `set(bool)` (real Win32 implementation and a recording fake): idempotent enable/disable, release on drop, state reporting, a failed backend call reports an error without flipping the state.

## Gates
`CARGO_TARGET_DIR=D:/b-p7 cargo test -p bloblex-speech` (to prove nothing else broke) and, if possible, `cargo test -p bloblex-desktop --lib power::` (report honestly if it cannot build here).

## Final report
Files changed, tests, gate output, what is unverified (the real Windows behaviour has not been observed; check with `powercfg /requests` while it is on).
