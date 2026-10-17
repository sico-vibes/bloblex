# FIX35 follow-up: no console flashes, one UAC prompt

Review findings on `crates/bloblex-daemon/src/remote/connectivity.rs`. **Never run `git commit`.** Keep context small: read only the ranges you need.

1. **Console windows flash.** `run_with_timeout` (the `netsh ... show rule` reading) and `run_process` (the `powershell` that raises UAC) spawn without `CREATE_NO_WINDOW`, so the windowless daemon pops a console each time. Set `creation_flags(0x0800_0000)` on Windows for both, as `remote/tailscale.rs:108` does. Also add `-WindowStyle Hidden` to the `Start-Process` line in `elevated_command`, so the elevated `netsh` does not flash its own console (the UAC prompt itself still shows). Update the argv tests.
2. **Two UAC prompts on remove.** The rule name `Bitbots Remote` (with a space) never shipped: it existed only in this unmerged worktree. Delete `LEGACY_FIREWALL_RULE_NAME`, `FIREWALL_RULE_NAMES_TO_DELETE` and the quoting branch in `remove_rule_args`; `remove_rule` runs one elevated delete of `Bitbots-Remote`. Keep detection by `LocalPort`. Update the tests.

## Gates
- `RUST_MIN_STACK=33554432 cargo test -p bloblex-daemon --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"` (foreground; wait)
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`

Append a short "C5" note to `docs/FIX35_C2_REPORT.md`.
