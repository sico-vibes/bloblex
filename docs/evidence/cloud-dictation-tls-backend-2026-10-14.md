# Cloud dictation: the TLS backend fix (14 October 2026)

Status: **released.** Shipped in `v0.1.0-beta.22` (annotated tag at `b42cd6e`,
installer SHA-256 `ff8f1c0009dddef66d14e194c7675d65d1dd057eefc211075508aea1eb4fe066`).
Implemented in the OpenCode lane under the owner's one-release commit and release
delegation (`AGENTS.md`, 14 October 2026). The read-only second opinion from
another lane was **not** run for this release; it remains the standing rule for
later backend diffs.

Supersedes the ALPN framing in `docs/FIX2_DICTATION_ALPN_SPEC.md`. The ALPN
hypothesis was tested and **disproved**; see "Correction" below.

## What changed

`crates/bloblex-speech` only. Two files plus `Cargo.lock`:

- `Cargo.toml` — `reqwest` gains the `rustls-tls` feature; new direct deps
  `rustls 0.23` (ring provider) and `webpki-roots 0.26`. All three were already
  in the workspace lock.
- `src/cloud.rs` — new `cloud_tls_config()` and `build_cloud_client(timeout)`.
  The client is built with `use_preconfigured_tls(rustls config)` (reqwest uses
  a preconfigured config verbatim), `.http1_only()`, the same 65 s timeout and
  the same no-redirect policy. The request itself is untouched: same URL, same
  multipart body, `model=gpt-transcribe`, `originator: bloblex`, our
  User-Agent, the same cookie jar and single cookie-carrying retry.

Nothing else in the crate changed. No identity, header, consent, cooldown or
error-mapping change.

## Live result

`cargo run -q -p bloblex-speech --example cloud_probe` — 1.2 s of silence, no
audio of the owner's voice, no token or body printed.

| | before | after |
| --- | --- | --- |
| outcome | `outcome=error code=challenged` | `outcome=ok text_len=0` |
| HTTP | `403`, `cf-mitigated: challenge` | `200` with a JSON `text` field |
| cookies set | `__cf_bm` | `__cf_bm`, `__cflb`, `_cfuvid` |

The "after" result was reproduced twice, minutes apart, on this machine. The
"before" result is the shipped client's behaviour and matches the 13 October
record.

## Correction: ALPN is not the cause

An earlier finding from the same day showed that, for Node/OpenSSL clients,
adding `ALPNProtocols: ["http/1.1"]` flipped a passing request to `403` and
removing it flipped it back. That was read as "the edge challenges a ClientHello
that advertises ALPN".

**That reading is wrong as a general rule.** Tested directly on the fix: the
rustls config with `alpn_protocols = vec!["http/1.1"]` **also returned `200`**.
So the ALPN result only ever described the undici-vs-`node:https` pair — those
two clients differ in their JA3, and undici's is the one that gets challenged.
It was a coincidence of that comparison, not the mechanism.

**What the evidence actually supports:** the edge decides on the **TLS
ClientHello fingerprint (JA3-style), not on identity, headers, body or ALPN**.
Every observation fits this:

| Client | TLS stack | Result |
| --- | --- | --- |
| shipped Rust client | native-tls → SChannel | challenged |
| same client, preconfigured rustls | rustls (ring) | **200** |
| same, with ALPN re-advertised | rustls (ring) | **200** |
| `fetch` (undici 7.16) | OpenSSL | challenged |
| `node:https` | OpenSSL | **200** |
| `fetch` (undici 7.29) | BoringSSL | **200** |
| bb's own CLI | BoringSSL (Electron) | **200** |

SChannel's fingerprint is challenged; rustls's, OpenSSL-without-ALPN's and
Chromium's are accepted. `alpn_protocols` is left empty in the config because
that is rustls's own default here and it keeps the handshake minimal — **not**
because it is what makes the request pass. The unit test pins that choice and
says so.

## Tests and gates

- `cargo test -p bloblex-speech`: **56 passed**, 0 failed (54 before, 2 new:
  `cloud_tls_config_advertises_no_alpn`, `build_cloud_client_succeeds`).
- `cargo test --workspace --exclude bloblex-desktop`: every crate passes
  **except** `bloblex-daemon --bin bloblexd`, whose test binary aborts with
  `STATUS_STACK_OVERFLOW` (`0xc00000fd`).
  - **Pre-existing and unrelated.** Verified by `git stash`-ing this change and
    re-running: the same binary crashes the same way on the unmodified tree.
    Not recorded anywhere in `docs/`. It needs its own ticket; it is not a
    regression from this work.
- Not run here (Director's gate): the desktop crate (its build script breaks on
  the apostrophe in `D:\Basem's\...`), typecheck/build, the installer, and the
  second-opinion lane review.

## Trade-offs and not verified

- **Trust store.** The cloud client now uses `webpki-roots` instead of the OS
  store that SChannel used. A user behind a corporate MITM proxy with a private
  CA would break. `rustls-tls-native-roots` is the fix if that matters; it is
  not done here.
- Silence only. No real speech, no live microphone, no non-silent audio.
- One machine, one network, one day. The fingerprint verdict can drift; the
  `Challenged` mapping, the cooldown and the honest message stay in place
  precisely because of that.
- **Permission is still unestablished.** A `200` is not authorization. The
  endpoint's status for third-party apps rests on the owner's account of
  OpenAI's reply (`AGENTS.md`, 14 October amendment), which no blob has seen.
- `Cargo.lock` changed because of the new direct deps. Nothing was downloaded
  that was not already in the lock.

## Reproducing

```
cargo run -q -p bloblex-speech --example cloud_probe
```

Expected on this machine today: `outcome=ok text_len=0`.
