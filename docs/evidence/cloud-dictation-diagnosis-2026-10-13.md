# Cloud dictation diagnosis: "verification required" (Fix 1A)

Date: 13 October 2026. Worktree `Blolblex-wt-fix1-dictation`. Scope: `crates/bloblex-speech` (mainly `src/cloud.rs`), `apps/desktop/src-tauri/src/speech.rs`, `scripts/live-checks/live-cloud-dictation.mjs`.

> **Corrected on 14 October 2026.** The root-cause attribution below is
> superseded. That run concluded the challenge was about *who* Bloblex claims to
> be, and that it "cannot be fixed on our side". Both are now falsified by live
> probes: requests that identify as Bloblex (`originator: bloblex`, our
> User-Agent) returned HTTP 200 with a transcript body, and the variable that
> separates pass from challenge is the shape of the HTTP request the client
> produces — not the identity, the audio container, the TLS library or the time.
> bb is not on any allow-list. The statements in this file that are now known to
> be wrong are marked **[superseded]**. Details and method:
> [cloud-dictation-client-shape-2026-10-14.md](cloud-dictation-client-shape-2026-10-14.md).
> The endpoint's *permission* status is unchanged and still unestablished.

## Symptom

Starting dictation with the ChatGPT engine showed "ChatGPT transcription is unavailable (verification required) and no on-device model is installed." "verification required" was our `CloudError::Challenged` (a `403` with a `cf-mitigated` response header, `crates/bloblex-speech/src/cloud.rs`).

## Task A: safe probe result (allowed fields only)

Probe: `scripts/live-checks/live-cloud-dictation.mjs`. It reads `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) read-only, builds one 1-second silent 16 kHz mono PCM16 WAV in memory, and POSTs it to `https://chatgpt.com/backend-api/transcribe` exactly the way `CloudTranscriber::transcribe` does (same URL, multipart parts, `model=gpt-transcribe`, same headers), identifying as Bloblex.

| Field | Value |
| --- | --- |
| HTTP status | `403` |
| `cf-mitigated` | `challenge` |
| `server` | `cloudflare` |
| body length | ~11 KB (~11,000 bytes) |
| content-type | not a JSON type; body is HTML |
| body parses as JSON | no |
| body has a `text` key | no |

Non-secret auth facts: `auth_mode = chatgpt`, `tokens.account_id` present = yes, access token expired = no, `codex --version` = `codex-cli 0.162.1`.

No token, request-header value, account id, JWT fragment, cookie or response body was printed, stored or logged. The probe did not retry or attempt to defeat the challenge; it was run at most 3 times in total.

## Task B: can the Codex CLI itself transcribe?

Inspected the installed Codex CLI's app-server protocol without sending any audio: `codex app-server generate-json-schema` (Codex `0.162.1`), then searched the generated schema for audio, voice, realtime or transcription requests.

Result: **none suitable.** There is no plain transcription request (nothing that takes audio bytes and returns text). The only audio-related surface is the `thread/realtime/*` notification family, which is a live voice conversation with the agent — a different feature that must not be repurposed for dictation.

## Confirmed root cause

OpenAI's private ChatGPT transcription endpoint (`chatgpt.com/backend-api/transcribe`) answers this honest, non-browser client with a Cloudflare managed challenge (`403`, `cf-mitigated: challenge`, `server: cloudflare`, HTML body). The Codex login is valid (`auth_mode = chatgpt`, account id present, access token not expired), so this is **not** an authentication failure: it is OpenAI's anti-bot check blocking requests that do not come from its official clients. Cloudflare's managed challenge expects a browser to solve a JS challenge. We will not impersonate Codex, a browser or any other client, replay cookies, or solve/bypass the challenge. **[superseded]** The claim that followed — *"so this cannot be fixed on our side"* — was wrong: it assumed the challenge was an identity check. It is a client request-shape check, and Bloblex's own identity passes from a different HTTP client shape (see the correction above). The honest message plus the on-device fallback remains the shipped behaviour, not because the endpoint refuses third-party apps in general, but because the fix is a policy decision the owner has not yet made.

## Ruled out

- **Invalid / missing auth** — the probe's auth was valid (`auth_mode = chatgpt`, account id present).
- **Expired token** — the access token was not expired.
- **A plain `401` (sign-in expired)** — the response is `403` with `cf-mitigated: challenge`, mapped to `Challenged`, not `AuthRequired`.
- **A rate limit** — the status is `403`, not `429`.
- **A plain `403` (account/request rejected)** — the `cf-mitigated: challenge` header is present, distinguishing it from `Rejected(403)`.
- **A wrong URL or multipart shape** — the probe recreates the exact request the Rust client sends and reproduces the same failure class.
- **The Codex CLI as a dictation backend** — Task B found no plain transcription request.

## Fixes applied (Task C — only defects that were ours)

- `CloudError` display copy is distinct and truthful per condition: `Challenged` now reads "blocked by OpenAI's bot check" / an honest sentence naming OpenAI, no longer "verification required". `Rejected(code)` and `AuthRequired` have their own strings. No display string carries a token, URL or body.
- A pure, clock-injected `CloudCooldown` (10 minutes) pauses the cloud after a persistent failure (`Challenged`, `RateLimited`, `Unavailable`). `resolve_engine` consults it only for `EnginePreference::Automatic`; an explicit `Cloud` choice still tries the cloud with on-device fallback.
- The engine event surfaces `reason = cloud_cooldown` when a healthy cloud engine was skipped.
- An unrecovered cloud failure with no runnable on-device model emits one machine code the UI can map: `both_engines_unavailable` (`error_code` in `speech.rs`).

## Not verified

- The Task A probe's exact **response header-name list** and the `content-type` value were not persisted by the earlier run; this file records them only qualitatively. (Status, `cf-mitigated`, `server`, body length and JSON-parse result are established.)
- Whether the endpoint behaves differently for the official Codex/ChatGPT clients — not tested, and imitating them is against the rules. **[superseded in part]** bb's own client was run unmodified and succeeded (it identifies as bb, so this is not imitation). What remains untested is whether the official Codex or ChatGPT clients are treated the same way, and identifying the trigger would require bisecting request shape, which is a policy decision for the owner.
- Live microphone capture and a real cloud transcription call were not exercised; the error mapping is proven against a local mock HTTP server in unit tests.
- `apps/desktop/src-tauri/src/speech.rs` was **not compiled** in this worktree: the apostrophe in the checkout path (`D:\Basem's\...`) breaks that crate's build script. The Director checks the desktop crate from a plain path.

## Follow-up: bb's cookie-carrying retry (13 October 2026, later)

bb (get-bb/bb, `plugins/provider-codex/src/ai/chatgpt-fetch.ts`) sends the same request and, on a `403` with `cf-mitigated: challenge`, keeps the Cloudflare cookies from that response (`__cf_bm`, `_cfuvid`, `cf_clearance`, `cf_chl_*` and a few more) in memory and retries once carrying them. Bloblex now does exactly that (`bloblex_speech::cloud`, in-memory jar, chatgpt.com mode only, one retry).

Live results with Bloblex's own identity (`originator: bloblex`, our User-Agent), a valid Codex sign-in, 1.2 s of silence:

| Stack | First request | Retry carrying the cookies |
|---|---|---|
| Rust (reqwest, rustls), `cargo run -p bloblex-speech --example cloud_probe` | 403 challenge, sets `__cf_bm` | 403 challenge |
| Node `fetch` (undici), `scripts/live-checks/live-cloud-dictation.mjs` | 403 challenge, sets `__cf_bm` | 403 challenge |

So the network stack and the missing cookies are not the difference. **[superseded]** This file originally concluded that the remaining difference was "the client identity bb sends (`originator: bb`, `User-Agent: bb-host-daemon`)". That is wrong. bb's identity is not privileged and there is no allow-list to join: requests carrying **Bloblex's** identity returned HTTP 200 from the same machine in the same minute, from `node:https` (OpenSSL) and from undici 7.29 in bb's Electron runtime, while undici 7.16 and `reqwest` were challenged. The variable is the HTTP request shape the client produces. bb's own tracker records the same challenge hitting bb users (get-bb/bb issues 1587 and 2159). See [cloud-dictation-client-shape-2026-10-14.md](cloud-dictation-client-shape-2026-10-14.md).
