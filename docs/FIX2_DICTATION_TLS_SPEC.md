# Fix 2 spec: cloud dictation's TLS stack

Status: **implemented and released** in `v0.1.0-beta.22` (tag at `b42cd6e`).
Owner approved request-shape matching for this call path (`AGENTS.md`, amendment
14 October 2026) and delegated this one commit and release to the OpenCode lane.
The read-only second opinion from another lane was not run for this release. This
file replaces an earlier draft that named ALPN as the cause; ALPN was tested and
ruled out.

## Problem

Cloud dictation (`crates/bloblex-speech/src/cloud.rs`, `CloudTranscriber`) is
answered with `403` + `cf-mitigated: challenge`. The on-device engine is the
default and the fallback, so dictation works; the ChatGPT engine is dead on this
machine.

## Cause

The endpoint's edge decides on the **TLS ClientHello fingerprint**, not on
identity, headers, body or ALPN. The shipped client used `reqwest`'s default
backend — `native-tls`, i.e. SChannel on Windows — whose fingerprint is
challenged. rustls's is accepted.

Evidence, method and the falsified alternatives (identity, audio container, TLS
library alone, HTTP client library, header set, order and casing, address
family, ALPN):
[docs/evidence/cloud-dictation-client-shape-2026-10-14.md](evidence/cloud-dictation-client-shape-2026-10-14.md)
and
[docs/evidence/cloud-dictation-tls-backend-2026-10-14.md](evidence/cloud-dictation-tls-backend-2026-10-14.md).

## Change

`crates/bloblex-speech` only.

1. `Cargo.toml`: `reqwest` gains `rustls-tls`; add `rustls 0.23` (ring) and
   `webpki-roots 0.26`. All already in the workspace lock.
2. `cloud.rs`: build the client from a preconfigured rustls config
   (`use_preconfigured_tls`), HTTP/1.1 only, same 65 s timeout, same
   no-redirect policy. `alpn_protocols` is left empty because that is rustls's
   default and keeps the handshake minimal — it is **not** the reason the
   request passes, and the code says so.
3. Nothing else: same URL, same multipart body, `model=gpt-transcribe`,
   `originator: bloblex`, our User-Agent, the cookie jar, the single
   cookie-carrying retry, the `Challenged` mapping, the cooldown and the honest
   message all stay.

## Constraints

- No identity is imitated: no other app's `originator`, User-Agent or token.
- Opt-in consent, on-device default and fallback, and the never-persist rule for
  token, audio and transcripts all stay.
- No challenge-solving, no cookie replay beyond the existing single retry, no
  retry loop.
- Silence only in probes and tests.

## Gates and what they returned

- `cargo test -p bloblex-speech`: 56 passed (2 new).
- `cargo test --workspace --exclude bloblex-desktop`: all pass except
  `bloblex-daemon --bin bloblexd`, which aborts with `STATUS_STACK_OVERFLOW`.
  **Pre-existing**: reproduced with this change stashed. Needs its own ticket.
- Live before/after with the shipped client: `challenged` → `ok`, twice.
- Outstanding for the Director: desktop-crate check from a plain path (the
  apostrophe in `D:\Basem's\...` breaks its build script), typecheck/build, the
  installer, and the read-only second opinion from another lane.

## Trade-off to accept or change

The cloud client now trusts `webpki-roots` rather than the OS store. A private
CA (corporate MITM proxy) would break; `rustls-tls-native-roots` is the
alternative. Not done here.

## Evidence written

`docs/evidence/cloud-dictation-tls-backend-2026-10-14.md`, including the
**Not verified** list: real speech, live microphone, other networks, drift over
time, and the endpoint's permission status, which a `200` does not establish.
