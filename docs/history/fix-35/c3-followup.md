# FIX35 follow-up: firewall rule name and the phone's sign-in call

> **What this is:** Follow-up note for FIX35: the firewall rule name and the phone's sign-in call.
> **Status:** historical
> **Last updated:** 2026-10-17

C1 and C2 are in this worktree (`docs/history/fix-35/c1-report.md`, `docs/history/fix-35/c2-report.md`). **Never run `git commit`.** Keep context small: grep and read only the ranges you need. Do not edit `apps/desktop/src/ui/**`.

## 1. Firewall rule name (review finding)
In Windows PowerShell 5.1, `Start-Process -ArgumentList @(...)` joins the elements with spaces **without quoting**, so the element `name=Bitbots Remote` reaches `netsh` as two words and the add/delete fails or targets the wrong rule. Rename the rule to `Bitbots-Remote` (no space) everywhere: the show, add and delete commands and their tests. Also accept and clean up an old rule named `Bitbots Remote` on delete: try deleting both names; a missing rule is not an error.

## 2. The phone client's Native sign-in (non-visual TypeScript)
- `apps/desktop/src/remote/remoteTransport.ts`: add `login(input: { username, password, name, kind, platform }): Promise<{ state: RemotePairState }>` → `POST /api/login` (same-origin credentials, same error mapping as `pair`; a `401` with code `login_invalid` becomes `RemoteCallError` code `login_invalid`; `429` → `rate_limited`). Add `login_invalid` to `RemoteErrorCode`.
- `apps/desktop/src/remote/deviceApi.ts`: add `login(input)` to `RemoteDeviceApi`. In `createPreviewDeviceApi`, accept any username with password `preview-passphrase` (else throw `login_invalid`) and then behave like `pair` (pending → approved after the wait). Add `method?: 'tailscale' | 'native'` as an option of the preview API and return it from `me()`.
- `apps/desktop/src/remote/remoteTauri.ts`: `remoteDevice.login` → `transport().login(input)`.
- Tests in `apps/desktop/src/remote/remoteTransport.test.ts` for `login` (200 approved, 202 pending, 401 login_invalid, 429 rate_limited).

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"` (foreground; wait)
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote src/preview`

Append a "Follow-up" section to `docs/history/fix-35/c2-report.md`.
