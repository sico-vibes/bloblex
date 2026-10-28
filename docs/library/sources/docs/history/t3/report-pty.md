# Lane PTY — report

Worktree: `D:\t3p`, branch `t3/pty`. Scope: native Rust side of interactive terminals only. The React/xterm.js side was not touched.

**No tests of any kind were run** (no `cargo test`, no `--tests`, no `clippy --all-targets`, no `npm test`/`vitest`, no probes, no browser/screenshots). **No git writes** were run (`commit`/`add`/`push`/`reset`/`stash`/`checkout`/`rebase`); everything is left in the working tree. No existing `#[cfg(test)]` block or test file was edited or deleted.

## Files changed

| File | What |
| --- | --- |
| `apps/desktop/src-tauri/src/pty.rs` (new, 679 lines) | whole module `pty`: `PtyService`, session state, 5 commands, output pump, path/shell/env policy, process-tree kill |
| `apps/desktop/src-tauri/src/lib.rs:33` | `mod pty;` |
| `apps/desktop/src-tauri/src/lib.rs:2983` | `.manage(pty::PtyService::default())` |
| `apps/desktop/src-tauri/src/lib.rs:3045-3050` | `WindowEvent::Destroyed` arm on the main window: `terminals.shutdown()` (the existing `CloseRequested` arm is untouched) |
| `apps/desktop/src-tauri/src/lib.rs:3128-3132` | `pty::terminal_open`, `terminal_write`, `terminal_resize`, `terminal_close`, `terminal_list` in `generate_handler!` |
| `apps/desktop/src-tauri/src/lib.rs:3148-3150` | `RunEvent::Exit`: `terminals.shutdown()` |
| `apps/desktop/src-tauri/Cargo.toml:19` | `portable-pty = "0.9"` |
| `Cargo.lock` (line 4160) | `portable-pty 0.9.0` + its new deps, written by cargo |

Nothing under `apps/desktop/src` (TypeScript), `crates/`, `tauri.conf.json` or `capabilities/*` was edited. `apps/desktop/src-tauri/gen/schemas/*.json` show as modified in `git status` but `git diff --numstat` reports zero line changes for them: `cargo check` (the tauri build script) rewrote them with LF line endings. Content is unchanged.

## What was implemented, item by item

1. **Window label guard** — `guard_main()` (`pty.rs:157`) is the first statement of every command; anything whose label is not `main` gets `"Terminals are only available in the main window."`, so the companion and dictation windows can never get a shell.
2. **Contract shapes** — `TerminalOpened` (`pty.rs:47`) `{ id, pid, shell, cwd }`, `TerminalInfo` (`pty.rs:56`) `{ id, pid, shell, cwd, running, exitCode }`, both `#[serde(rename_all = "camelCase")]`, all commands `Result<_, String>` with short English errors. Events are `OutputEvent { id, seq, data }` (`pty.rs:67`) and `ExitEvent { id, exitCode }` (`pty.rs:75`), emitted only with `app.emit_to("main", …)` (`pty.rs:472`, `pty.rs:478`) — never broadcast.
3. **Working directory bounds** — `project_dir` (`pty.rs:166`) rejects empty, `> 4096` bytes (`"The project path is too long."`), non-canonicalizable (`"The project folder could not be found."`) and non-directories (`"The project path is not a folder."`). `folder_inside` (`pty.rs:182`) canonicalizes `cwd`, requires `is_dir`, and requires `canonical.starts_with(root)` on the *canonical* paths (`"The terminal folder must be inside this project."`); no `cwd` (or an empty/blank one) defaults to the project root. `user_path` (`pty.rs:201`) strips the verbatim `\\?\` prefix and rejects `\\?\UNC\…`, other non-drive `\\?\` paths (volumes, GLOBALROOT) and bare `\\`/`\\.\` paths, so the shell is started in `D:\x` and `TerminalOpened.cwd` is `D:\x`, not `\\?\D:\x`.
4. **Fixed shell list** — `choose_shell` (`pty.rs:235`): `powershell` → `powershell.exe -NoLogo` (default), `pwsh` → `pwsh.exe -NoLogo` only when `on_path("pwsh.exe")` finds it on `PATH` (else `"PowerShell 7 is not installed."`), `cmd` → `cmd.exe` with no args, unknown → `"Choose PowerShell, PowerShell 7 or Command Prompt."`. **No `-NoProfile`** (users keep their profile; the reference had it). Non-Windows maps the same ids to `/bin/sh`. The chosen id is returned in `TerminalOpened.shell`.
5. **Environment hygiene** — `sanitize_environment` (`pty.rs:257`) walks the process environment and calls `env_remove` for every name starting with `BLOBLEX_` or `BITBOTS_` (compared upper-case so case variants on Windows are caught too) and for `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`; `TERM=xterm-256color` and `COLORTERM=truecolor` are set on non-Windows only. Nothing about the environment is ever logged.
6. **Limits** — 6 live terminals (`MAX_TERMINALS`), error `"Close a terminal before opening another one."` (`pty.rs:340-343`). Write is capped at 64 KiB (`"Terminal input is too large."`), resize at 1..=500 cols / 1..=300 rows (`"The terminal size is outside the supported range."`), open defaults are 80×24. Ended terminals are pruned on `terminal_open` and on `terminal_list`; a session that just ended is still reported **once** by `terminal_list` with `running: false` and its `exitCode` before it is pruned (`pty.rs:672-678`), so the UI can read the code; `terminal_close` also removes it. The 4096-byte path bound and a 64-byte id bound are enforced everywhere.
7. **Output streaming** — one pty reader (`relay`, `pty.rs:417`) does the blocking reads only, and the per-terminal pump thread (`pty.rs:431`) coalesces: it waits for the first chunk, then keeps draining up to 16 KiB or 8 ms before one `terminal://output` event. Reads are 8 KiB so a burst is never one event per 8-byte read. The incomplete UTF-8 tail is kept across reads by `decode_utf8_chunk` (`pty.rs:487`, the reference's version, kept) and flushed once as U+FFFD at end of stream. `seq` starts at 1 and increments by exactly 1 per event. `Throttle` (`pty.rs:518`) holds the pipe back at 4 MiB/s (the pty stalls, not the UI). No transcript is kept and nothing is written to disk.
8. **ConPTY `ESC[6n`** — deliberately not answered in Rust; xterm.js answers it through `terminal_write`, as the brief specifies.
9. **Lifecycle** — `terminal_close` (`pty.rs:646`) removes the session from the map (idempotent: unknown or already-ended id is `Ok(())`), kills the tree with `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F` under a 2 s bound (`pty.rs:567`), reaps the child (1 s grace for a shell that exits on its own, then kill), and joins the pump if it finishes within 2 s, otherwise detaches it (a wedged read can never hang the close). `terminal://exit` is emitted exactly once from a single site guarded by an `AtomicBool` swap (`emit_exit`, `pty.rs:478`), after the last output event. `RunEvent::Exit` and the main window's `Destroyed` event both call `PtyService::shutdown()` (`pty.rs:146`), which drains the map and kills every tree. A shell that exits by itself (user types `exit`) ends the stream, reports its code, and afterwards `terminal_write` returns `"The terminal has closed."`.
10. **Reference weaknesses fixed** — (1) window label guard added; (2) events now go only to `main`; (3) `terminal_close` no longer removes-then-kills blindly: the exit event is owned by the pump and fires once through the atomic swap, and the exit code is kept on the session; (4) the `sessions` lock is taken only to prune/count and to insert/remove — never across `openpty`/`spawn_command`; (5) close is idempotent and treats `child.kill()` errors on an already-exited child as success (`terminate_and_reap`, `pty.rs:556`).
11. **Style** — no `unsafe`, no `#[test]`, short "why" comments, dense `Result<_, String>` commands matching `lib.rs`.

## Verification

Only the allowed production-target check was run, from `D:\t3p`, after creating the git-ignored `apps/desktop/dist/index.html` stub:

```powershell
$env:TAURI_CONFIG='{"bundle":{"externalBin":[]}}'
cargo check -p bloblex-desktop --message-format short
```

Last 15 lines of the final run (full log at `D:\t3p\target\lane\check.log`):

```
    Checking bloblex-desktop v0.1.0-beta.38 (D:\t3p\apps\desktop\src-tauri)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.23s
```

The first run in this lane compiled the whole dependency graph, including `Checking portable-pty v0.9.0`, and failed with two errors that I fixed (`Window::app_handle` needed `tauri::Manager` in scope; the resize chain borrowed a temporary `MutexGuard`, so it now binds the guard); a later run showed one `unused mut` warning that I also fixed. The final run is warning-free, and the crate builds offline (`--offline` was also used successfully while the registry had no `Cargo.lock` entry).

## Decisions the brief did not specify

- **Two threads per terminal, not one.** A blocking `Read` cannot be time-sliced inside a single thread, and coalescing needs an 8 ms deadline; so one relay thread only reads and one pump thread coalesces, emits, reaps and emits the exit. Both are per terminal (max 6), and `terminal_close` joins or detaches the pump. The alternative (one thread, one event per read) would have broken the coalescing rule.
- **`std::env::vars_os()` instead of `vars()`** for the environment sweep, because `vars()` panics on a non-Unicode entry; the same variables are removed.
- **`terminal_list` reports an ended terminal once and then prunes it**, satisfying both "prune on list" and "keep the record so the UI can read its exit code".
- **Default size 80×24** when `cols`/`rows` are omitted; provided values are range-checked with the resize rule.
- **`terminal_close` is `async`** and does the 2 s taskkill / 2 s pump join on `spawn_blocking`, so a wedged shell can never freeze the window. `terminal_open`, `terminal_write`, `terminal_resize` and `terminal_list` stay synchronous.
- **`terminal_resize` on an ended terminal is `Ok(())`** (a resize observer firing after exit is not an error); only `terminal_write` returns `"The terminal has closed."`.
- **`terminal_close` on an unknown id is `Ok(())`** — the close path is idempotent, as double-clicks in the UI would otherwise raise errors.
- **Case-insensitive secret prefixes** (`BLOBLEX_`/`BITBOTS_` upper-cased before the check) so a lowercase variant on Windows cannot leak.
- **Extra error strings** the brief did not spell out: `"PowerShell 7 is not installed."`, `"That folder is not on a local drive."` (UNC/device/volume), `"The terminal folder could not be found."`, `"The terminal folder is not a folder."`, `"A terminal could not be opened on this device."`, `"The selected shell could not be started."`, `"The terminal could not be started."`, `"The terminal could not be resized."`, `"The terminal service is unavailable."`, `"The terminal input is unavailable."`.
- **Argument naming for the UI.** Tauri maps JS camelCase to the Rust snake_case parameters (the repo already relies on this: `resolve_project_file` is called with `{ path, projectRoot }`, `show_main_settings` with `{ sessionId, page }`). So the xterm.js side must invoke `terminal_open` with `{ projectPath, cwd, shell, cols, rows }`; the other four names are single words and unchanged.
- **No capability change needed.** `capabilities/default.json` already grants `core:event:allow-listen` to the main window, and app commands need no capability entry.

## Not verified (cannot, in this lane)

- I did not run the app or the desktop build, so nothing was exercised at runtime: no real ConPTY spawn, no prompt drawing, no resize propagation, no `taskkill` on a live tree, no xterm.js round-trip, no behaviour on the companion/dictation windows. Static reasoning and `cargo check` are the only evidence.
- The 8 ms / 16 KiB coalescing and the 4 MiB/s throttle are unmeasured; the numbers are read from the code.
- `pwsh` on this machine was not probed, so the `on_path` branch is untested on real hardware; the `pwsh`-missing error path is likewise unexercised.
- The `WindowEvent::Destroyed` hook and the `RunEvent::Exit` shutdown were not observed firing; they are wired in the same places the existing code already handles those events.
- `rustfmt --check` on `pty.rs` is not clean at default settings (100 columns): the file is written at the repo's ~120-column dense style, like `lib.rs`, and I did not reformat `lib.rs` as instructed.
