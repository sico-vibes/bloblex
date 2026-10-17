# FIX34 A5 follow-up: terminal launch quoting

Follow-up to `docs/FIX34_A5_SIGN_IN_SPEC.md` in this worktree; your earlier work is already here (`docs/FIX34_A5_REPORT.md`). **Never run `git commit`.** Keep context small: read only `apps/desktop/src-tauri/src/lib.rs` lines ~1100-1240 (`provider_login_script`, `provider_install_script`, `terminal_launch`, `runtime_terminal`) and its tests (~2600-2680).

Two review findings to fix in `terminal_launch`:

1. **Windows Terminal splits on `;`.** `wt.exe` treats an unescaped `;` in its arguments as its own command separator, so the Claude login script (`echo ...; claude`) and every install script (`<install>; <login>`) would be split by wt. In the wt branch, escape every `;` in the script as `\;` (wt's documented escape) before putting it in `args`.
2. **Drop the cmd.exe fallback.** Replace `cmd /c start Bitbots powershell ... "<script>"` (hand-quoted) with spawning `powershell.exe` directly: program `powershell.exe`, args `["-NoExit", "-Command", script]` (no extra quotes; let `std::process::Command` quote it), and on Windows set `creation_flags(CREATE_NEW_CONSOLE)` (`0x00000010`) so it opens its own visible window. Keep `terminal: "powershell"`. Apply the flag only for this fallback (add a field to `TerminalLaunch` such as `new_console: bool`).

Update the unit tests for both branches (assert the escaped wt args and the direct powershell argv/flag).

Re-run:
- `cargo test -p bloblex-desktop --lib 2>&1 | grep -E "test result|FAILED"` (if blocked by missing sidecars, say so)
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`

Append a short "Follow-up" section to `docs/FIX34_A5_REPORT.md`.
