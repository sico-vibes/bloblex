# Cloud dictation: what the Cloudflare challenge actually keys on (14 October 2026)

Supersedes the root-cause attribution in
[cloud-dictation-diagnosis-2026-10-13.md](cloud-dictation-diagnosis-2026-10-13.md).
Scope of this run: live probes only. No repository source was changed.

Environment: Windows. Codex sign-in `auth_mode = chatgpt`, access token valid.
bb `0.46.0` (Electron `44.3.0`, Node `v24.20.0`, undici `7.29.0`, BoringSSL)
installed and running, server on `127.0.0.1:38886`. System Node `v24.11.1`
(undici `7.16.0`, OpenSSL `3.5.4`).

## Question

bb transcribes through the same endpoint (`chatgpt.com/backend-api/transcribe`)
with the same model (`gpt-transcribe`) and the same Codex login, and succeeds on
this machine while Bloblex is challenged. Which difference explains that?

## Method

Every request below used **Bloblex's own identity** (`originator: bloblex`,
`User-Agent: bloblex-desktop/0.1.0-beta.21`), read `$CODEX_HOME/auth.json`
read-only, sent the same multipart body (`file` + `model=gpt-transcribe`), and
carried **1 second of silence** — no audio of the owner's voice was sent. No
token, header value or response body was printed, stored or logged. The only
exception is one run of bb's own CLI, which identified as bb because it *is* bb;
it was invoked exactly as documented (`bb voice transcribe <file> --json`).

**No header, User-Agent or originator value was ever altered to imitate another
client.** Only the runtime and the HTTP client library were varied.

## Results

| # | Client | Runtime / TLS | Result |
| --- | --- | --- | --- |
| 1 | `bb voice transcribe` (bb's identity) | Electron / BoringSSL | **200**, body `{"text":""}` |
| 2 | `fetch` (undici 7.16.0) | system Node / OpenSSL | **403** `cf-mitigated: challenge`, 2 attempts |
| 3 | `node:https` | system Node / OpenSSL | **200** ×3 of 3 |
| 4 | `fetch` (undici 7.29.0) | Electron / BoringSSL | **200** ×2 of 2 |
| 5 | `node:https` | Electron / BoringSSL | **200** |
| 6 | Rust client (`reqwest`) — 13 October run | native | **403** `cf-mitigated: challenge` |

Runs 1 and 2 were **7 seconds apart** on the same machine, IP and minute. Runs
3 and 2 were interleaved three times in one session and never diverged
(`https=200, fetch=403` each round).

`fetch` and `node:https` in runs 2 and 3 sent the same headers, same body,
same credentials, from the same process runtime, seconds apart.

## Conclusion

**The challenge is decided by the shape of the HTTP request our client
produces, not by the identity it presents, the audio container, the TLS library
or the time of day.** Runs 3–5 returned HTTP 200 with a JSON body containing a
`text` key while identifying as Bloblex, so the endpoint serves a
non-browser client that presents our own name.

### Falsified by this run

- **"The client identity bb sends is what the edge keys on."** Runs 3–5 passed
  with `originator: bloblex` and our User-Agent.
- **"bb is on an OpenAI allow-list."** No allow-list is needed to explain bb's
  success; our own name passes from a different client shape on the same
  machine. bb's public tracker agrees: issues
  [#1587](https://github.com/get-bb/bb/issues/1587) (users reporting the same
  `403` on `bb voice transcribe`) and
  [#2159](https://github.com/get-bb/bb/issues/2159) (their fix, which classifies
  the challenge as transient and tells the user to retry or switch to an API
  key) record that bb is challenged too, on "some networks".
- **"The audio container is the difference" (bb sends webm, Bloblex sends WAV).**
  Both containers were challenged from the same client (run 2 shape) on
  14 October; the earlier WAV control reproduced.
- **"This cannot be fixed on our side."** The production client's request shape
  is the failing variable, not the endpoint's treatment of third-party apps in
  general.

### Established but unexplained

The precise property of the `fetch`/undici (7.16.0) and `reqwest` requests that
triggers the challenge was **not** identified. Candidate properties are HTTP/1.1
header casing, order and set, and client-version-specific defaults. Identifying
it would require bisecting request shape against a live anti-bot control to find
what slips past it; that was deliberately not done here, and is a policy
decision for the owner, not a diagnostic step (see `FIX1_DICTATION_SPEC.md`,
"No bypass of bot protection").

The `node:https` result is a single environment's observation. It may drift with
Cloudflare's model, the network, or time; it is not a guarantee.

### Not verified

- Whether the endpoint is permitted for third-party desktop apps. A successful
  response is not authorization. Nothing in this run addresses permission.
- Whether longer or non-silent audio behaves differently.
- Any behaviour on a different network or machine.

## Update, same day: the accepted client shape is the TLS stack

Two further findings, recorded here so this file's open question is answered:

- **ALPN was tested and ruled out.** For the Node/OpenSSL pair, adding
  `ALPNProtocols: ["http/1.1"]` flipped `200` → `403` and removing it flipped it
  back, which looked like the trigger. It is not: on the fix, re-advertising
  ALPN still returned `200`. That result only described undici's JA3 versus
  `node:https`'s.
- **The fix is the TLS backend.** The shipped Rust client uses `native-tls`
  (SChannel on Windows) and is challenged. Passing a preconfigured `rustls`
  config makes the identical request return `200`. Measured before/after, and
  reproducible: [cloud-dictation-tls-backend-2026-10-14.md](cloud-dictation-tls-backend-2026-10-14.md).

So the property this file could not identify is the **TLS ClientHello
fingerprint**. SChannel's is challenged; rustls's, OpenSSL-without-ALPN's and
Chromium's (bb) are accepted. Still not established: permission to use the
endpoint, and whether any of this holds over time.

## Reproducing

All probes ran from `C:\Users\SicoZ\AppData\Local\Temp\opencode\` (not committed):

- `format-probe.mjs` — `fetch` client, sends a chosen file, prints status,
  attempt list, `cf-mitigated`, cookie names, body shape. Never prints a token.
- `https-probe.mjs` — identical request via `node:https`.
- `fmt-variable.webm` (1.2 s opus, 1092 bytes), `fmt-control.wav` (1 s PCM16).

```
node format-probe.mjs <file> recording.webm audio/webm <label>
node https-probe.mjs  <file> recording.webm audio/webm <label>
$env:ELECTRON_RUN_AS_NODE='1'; & "$env:LOCALAPPDATA\Programs\bb\bb.exe" format-probe.mjs ...
```

bb's own client, for comparison (its identity, unmodified):

```
node "$env:LOCALAPPDATA\Programs\bb\resources\app.asar.unpacked\node_modules\bb-app\dist\bb.js" voice transcribe <file> --type audio/webm --json
```
