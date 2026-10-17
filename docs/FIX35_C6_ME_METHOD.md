# FIX35 follow-up: a signed-out phone learns the method

The phone client must show the Native sign-in screen (username and password) or the Tailscale pairing-code screen **before** it is signed in, but `GET /api/me` answers a signed-out device with only an error. **Never run `git commit`.** Keep context small.

1. `crates/bloblex-daemon/src/remote/web.rs`: when `me_get` refuses an unauthenticated device (no cookie, unknown or expired cookie, revoked), add `"method": <active method>` to the JSON error body. Nothing else is added (no host name, no device data). Test: a cookie-less `GET /api/me` returns 401 with `method` `native` when Native is active, `tailscale` otherwise.
2. `apps/desktop/src/remote/remoteTransport.ts`: `RemoteCallError` gains an optional `readonly method?: RemoteMethodId`; the `/api/me` error path fills it from the body when present. Test in `remoteTransport.test.ts`.
3. `apps/desktop/src/remote/deviceApi.ts`: the preview `me()` refusal carries `method` (the preview's option). Test in `deviceApi.test.ts`.

## Gates
- `RUST_MIN_STACK=33554432 cargo test -p bloblex-daemon --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"` (foreground; wait)
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote`

Append a short "C6" note to `docs/FIX35_C2_REPORT.md`.
