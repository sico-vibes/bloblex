# FIX35 follow-up: tests must not bind all interfaces

The owner kept getting Windows Firewall "Allow access?" prompts while the lane ran tests: the Native Remote tests turn Native on, and `crates/bloblex-daemon/src/remote/native.rs` binds `0.0.0.0` (and `[::]`). Windows asks once per newly built test executable. **Never run `git commit`.** Keep context small: grep and read only the ranges you need.

## Change
- Make the Native bind host a field of the Native/remote state, defaulting to the production value (`0.0.0.0`, plus `[::]`). Under `#[cfg(test)]` (or through the test constructor the remote tests already use) set it to `127.0.0.1` and skip the IPv6 wildcard. Production code paths must still bind `0.0.0.0`.
- Keep one test asserting the **production default** is `0.0.0.0` by reading the constant/default, without binding a socket.
- Grep every test in the workspace for `bind(("0.0.0.0"`, `"0.0.0.0:`, `"[::]"` and `("::"` and make sure no test binds a non-loopback address.
- Make sure no test runs real `netsh`, `powershell` or UPnP discovery (fakes only).

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"` (foreground; wait)
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`

Append a short note to `docs/FIX35_C2_REPORT.md`.
