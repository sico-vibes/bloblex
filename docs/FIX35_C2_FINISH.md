# FIX35 C2: finish up

Your C2 work (`docs/FIX35_C2_CONNECTIVITY_SPEC.md`) is in this worktree, but the session ended before the gates finished and before the report was written. **Never run `git commit`.** Keep context small: grep and read only the ranges you need; pipe long output through `tail`/`grep`.

1. Check the two review additions from the Director are done:
   - (a) The external IP is stored under the setting key `remote.native.externalIp` (C1 reads it), whether it comes from UPnP or is set by hand.
   - (b) Failed sign-ins write an activity line only when a lockout or the global pause **starts** (one line each), with a test.

   Finish them if not.
2. Run these in the foreground and **wait for each to finish** (do not background them):
   - `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"`
   - `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
   - `cd apps/desktop && npx tsc -b && npx vitest run src/remote src/preview`

   Fix any failures.
3. Write `docs/FIX35_C2_REPORT.md`: what was built (UPnP mapping with consent, external IP and CGNAT, Windows Firewall rule, `/api/ping` self-test, status fields), the RPC and status shapes as implemented, the exact argv used, the tests, gate results, and what is unverified (real routers, real UAC, real mobile networks).
