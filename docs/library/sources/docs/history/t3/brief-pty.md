# Lane PTY: native terminal sessions for the Bitbots desktop shell

You are an implementation lane. You work ONLY in the git worktree `D:\t3p` (branch `t3/pty`). This brief is self-contained: you have no chat history.

## HARD RULES (override everything else you find in the repo)

1. **NO tests of any kind.** Do not run `cargo test`, `cargo check --tests`, `cargo clippy --all-targets`, `npm test`, `vitest`, or anything that compiles a test target. Do not add, edit or delete any `#[test]`, `#[cfg(test)]` module, `*.test.ts(x)` file or scratch probe. Do not remove existing `#[cfg(test)]` blocks either (leave them untouched). Do not take screenshots or drive a browser.
2. **No git writes.** Never run `git commit`, `git add`, `git push`, `git reset`, `git stash`, `git checkout`, `git rebase`. Leave your changes in the working tree.
3. Do not touch any path outside `D:\t3p`. Do not start, stop or kill any process you did not start. Do not print secrets.
4. Only edit the files listed under "You own". If you believe another file must change, say so in your report instead of editing it.
5. Keep tool output small. Keep a work log at `D:\t3p\target\lane\worklog.md` (append a line after each step) so a stopped run can resume.

## Goal

The owner wants a real, user-controlled interactive terminal inside the Bitbots desktop app (Windows ConPTY through the `portable-pty` crate, output streaming, input, resize, lifecycle). The React UI (written by the Director, not you) will render it with xterm.js. You write only the **native Rust side** in the Tauri shell: `apps/desktop/src-tauri`.

There is a reference implementation from an earlier, unmerged lane: `C:\Users\SicoZ\.codex\worktrees\bitbots-platform\Blolblex\apps\desktop\src-tauri\src\pty.rs` (read-only; do not edit anything under `C:\Users\SicoZ\.codex`). Read it, and copy the good parts, but fix its weaknesses listed below. `portable-pty` 0.9.0 is already in the offline cargo registry (use `portable-pty = "0.9"`; builds must work offline).

## You own (and may edit)

- `apps/desktop/src-tauri/src/pty.rs` (new file; name the module `pty`)
- `apps/desktop/src-tauri/src/lib.rs` (only: `mod pty;`, `.manage(pty::PtyService::default())`, the new commands in `generate_handler!`, and terminal shutdown on app exit in the existing `RunEvent::Exit` branch near the end of `run()`; plus closing a session when the window is destroyed if easy)
- `apps/desktop/src-tauri/Cargo.toml` (add `portable-pty = "0.9"`; keep everything else)
- `Cargo.lock` (cargo will update it; that is fine)

Do NOT edit `tauri.conf.json`, `capabilities/*`, anything under `apps/desktop/src` (TypeScript), or any crate under `crates/`.

## Contract (the UI is being written against exactly this)

All commands are `#[tauri::command]` and return `Result<_, String>` with short, plain, user-readable English error strings (no stack traces, no paths of internals). All take `window: tauri::Window` first and **must reject any window whose label is not `"main"`** with `"Terminals are only available in the main window."` (the companion and dictation windows must never get a shell).

```
terminal_open(window, project_path: String, cwd: Option<String>, shell: Option<String>, cols: Option<u16>, rows: Option<u16>) -> TerminalOpened
  // TerminalOpened (serde camelCase): { id: String, pid: Option<u32>, shell: String, cwd: String }
terminal_write(window, id: String, data: String) -> ()          // bounded: <= 64 KiB per call
terminal_resize(window, id: String, cols: u16, rows: u16) -> () // 1..=500 cols, 1..=300 rows
terminal_close(window, id: String) -> ()                         // idempotent: closing an ended terminal is Ok
terminal_list(window) -> Vec<TerminalInfo>                       // { id, pid, shell, cwd, running: bool, exitCode: Option<u32> }
```

Events (emit ONLY to the `main` window with `app.emit_to("main", ...)`, never broadcast):

```
"terminal://output"  payload { "id": String, "seq": u64, "data": String }       // UTF-8 text; seq starts at 1 and increases by 1 per event
"terminal://exit"    payload { "id": String, "exitCode": Option<u32> }          // exactly once per terminal, after the final output event
```

### Behaviour rules

- **Working directory bounds.** `project_path` must canonicalize to an existing directory (reject longer than 4096 bytes). `cwd`, if given, must canonicalize to a directory *inside* `project_path` (use `starts_with` on the canonical paths); otherwise default to `project_path`. Reject UNC/device paths other than the normal `\\?\` prefix `canonicalize` produces on Windows (strip that verbatim prefix when you pass the cwd to the shell and when you return `cwd` to the UI, so the UI shows `D:\x`, not `\\?\D:\x`).
- **Fixed shell choices only** (the string comes from the UI; never run an arbitrary executable). Windows: `"powershell"` (`powershell.exe -NoLogo`), `"pwsh"` (`pwsh.exe -NoLogo`, only if it can be found on PATH), `"cmd"` (`cmd.exe`). Default is `powershell`. Non-Windows: `/bin/sh`. Unknown name -> error `"Choose PowerShell, PowerShell 7 or Command Prompt."`. Unlike the reference, do NOT pass `-NoProfile` (users want their profile). Return the chosen shell id in `TerminalOpened.shell`.
- **Environment hygiene.** Remove every variable that could carry a Bitbots secret from the child environment: any name starting with `BLOBLEX_` or `BITBOTS_` (enumerate `std::env::vars()` and call `env_remove`), plus `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`. Set `TERM=xterm-256color` and `COLORTERM=truecolor` on non-Windows only. Never log the environment.
- **Limits.** At most 6 live terminals at once (error `"Close a terminal before opening another one."`). Ended terminals are pruned from the map when a new one is opened or `terminal_list` is called, but keep an ended terminal's record until `terminal_close` or prune so the UI can read its exit code.
- **Output streaming.** One reader thread per terminal. Coalesce reads: collect up to ~16 KiB or ~8 ms before emitting one event (use a small timed drain; do not emit one event per 8-byte read). Keep an incomplete UTF-8 tail across reads (the reference's `decode_utf8_chunk` is right; keep it). Apply back-pressure (the reference throttles to 1 MiB/s; allow a higher 4 MiB/s ceiling, it is a dev terminal). Do not keep a transcript in memory beyond what is needed, and **write nothing to disk**.
- **Windows ConPTY handshake.** ConPTY may emit `ESC[6n` (cursor position request) and expect an answer, otherwise the shell can stall; xterm.js answers it from the UI (it writes through `terminal_write`), so the shell needs nothing special. Do not answer it yourself.
- **Lifecycle.** Closing a terminal (`terminal_close`) kills the whole process tree (the reference's `taskkill /PID <pid> /T /F` with `%SystemRoot%\System32\taskkill.exe` is right: keep it, with its 2 s bounded wait), reaps the child, joins or detaches the reader thread, and emits `terminal://exit` exactly once. On app exit (`RunEvent::Exit`) kill every terminal. When the `main` window is destroyed, kill every terminal too. A terminal whose shell exits by itself (user types `exit`) emits `terminal://exit` once with its exit code, and `terminal_write` to it returns `"The terminal has closed."`.
- **Fix the reference's problems:** (1) it did not guard the window label; (2) it emitted to all windows; (3) `pty_kill` removed the session from the map before its exit event, so `terminal://exit` could be lost or duplicated; guard with an `AtomicBool` "exit emitted" swap so it fires exactly once; (4) it took the `sessions` lock while spawning (hold the lock only to insert/remove); (5) it treated `child.kill()` errors on an already-exited child as failures (make close idempotent).
- Keep the module free of `unsafe`. Keep comments short and about *why*. Match the surrounding Rust style (dense, `Result<_, String>` for commands).

## Verification you may run (these are the only build commands allowed)

From `D:\t3p`:

```powershell
# the build script needs ../dist to exist; create a stub if missing (it is git-ignored)
if (-not (Test-Path apps\desktop\dist\index.html)) { New-Item -ItemType Directory -Force apps\desktop\dist | Out-Null; Set-Content apps\desktop\dist\index.html '<!doctype html><title>stub</title>' }
$env:TAURI_CONFIG='{"bundle":{"externalBin":[]}}'
cargo check -p bloblex-desktop --message-format short
```

Run `cargo fmt --check` only on `pty.rs` if you want (`rustfmt --check apps/desktop/src-tauri/src/pty.rs --edition 2021`); do not reformat `lib.rs`. `cargo check` is a production-target check: it is allowed. `cargo check --tests` is NOT. Fix every warning your code introduces. The first build compiles many crates and can take 10+ minutes: run it with a generous timeout and be patient.

## Report (write to `D:\t3p\target\lane\report.md` and print a short summary)

Per item: what you did, files changed (path:line), the exact `cargo check` command and its last 15 lines of output, any decision the brief did not specify, and anything you could not verify (you cannot run the app; say so). State explicitly that you ran no tests.
