# Phase 7 spec: opt-in cloud dictation through the Codex login (backend and native)

> Status: historical spec; the cloud dictation path shipped in `v0.1.0-beta.22` with a rustls client ([FIX2_DICTATION_TLS_SPEC.md](FIX2_DICTATION_TLS_SPEC.md)). The evidence file named in this spec (`docs/evidence/cloud-dictation-2026-10-12.md`, line 42) is not in the tree; the 13-14 October evidence is [cloud-dictation-diagnosis-2026-10-13.md](evidence/cloud-dictation-diagnosis-2026-10-13.md), [cloud-dictation-client-shape-2026-10-14.md](evidence/cloud-dictation-client-shape-2026-10-14.md) and [cloud-dictation-tls-backend-2026-10-14.md](evidence/cloud-dictation-tls-backend-2026-10-14.md). The request-shape rule in AGENTS.md (14 October 2026) is the current one.

Owner: OpenCode lane (backend/native only). Reviewer: Director. Parent plan: `docs/IMPROVEMENT_PLAN.md` Phase 7. The desktop UI (`apps/desktop/src`) is built by the Director against this contract; **do not touch it, and do not touch `crates/bloblex-daemon`**.
Scope: `crates/bloblex-speech` (new `src/cloud.rs`, `lib.rs` exports), `apps/desktop/src-tauri/src/speech.rs`, `apps/desktop/src-tauri/src/lib.rs` (command registration only), `docs/`. No new dependencies unless unavoidable; build multipart by hand (the workspace `reqwest` has `json` only; the desktop crate also has `blocking`).

## Owner decision (this is an explicit, scoped exception to "no copied provider authentication")
The owner approved, for **dictation only**, reading the Codex CLI's `auth.json` read-only to call ChatGPT transcription. It is **opt-in with consent**, the on-device engine stays the default and the automatic fallback, and tokens, audio and transcripts are **never persisted or logged**. Nothing else may use that token.

## Rules
- Work only in this worktree. **Never run `git commit`, `git push`, `git checkout`, `git stash`.** Leave changes uncommitted. Only attach/read files that are inside this worktree.
- Cargo: `CARGO_TARGET_DIR=D:/b-p7`. Pure logic must be testable without the `native` feature: `cargo test -p bloblex-speech` (no features).
- Match repo style. No `unwrap()` in non-test code you add. A token, audio bytes, a transcript or a response body must never appear in a log line, an error string, a `Debug` output, a panic message or a test snapshot.
- Do not read or write any user path other than the Codex auth file (read-only) and the existing model cache. Never write audio to disk.
- If `cargo check -p bloblex-desktop` cannot complete (missing network for native build scripts, or longer than 20 minutes), say so plainly in the report and rely on `bloblex-speech` tests; keep the `speech.rs` change small and isolated so it is reviewable by reading.

## Cloud transcriber (`bloblex-speech::cloud`, pure, no `native` feature)
- **Auth discovery (read-only, fresh per call, no caching):** `$CODEX_HOME` (trim; if empty use the user home `.codex`) joined with `auth.json`. Parse JSON. If `auth_mode == "apikey"` or only an `OPENAI_API_KEY` string is present: mode `ApiKey`. Otherwise ChatGPT mode: `tokens.access_token` (JWT string) and account id from `tokens.account_id`, else the JWT payload claim `["https://api.openai.com/auth"]["chatgpt_account_id"]` (access token first, then `tokens.id_token`). Decode the JWT payload with base64url (no signature check; `base64` is already a workspace dependency, use it). Optional claim `chatgpt_account_is_fedramp == true` adds header `X-OpenAI-Fedramp: true`.
- **Status API (no secrets):** `AuthStatus { state: Ready | Missing | Unreadable | Expired | ApiKey | Unsupported, mode: Option<"chatgpt"|"apiKey">, expires_at: Option<String> }`. `Expired` is derived from the JWT `exp`; it is only a hint (the Codex CLI refreshes its own file), the transcriber still attempts the call and maps a 401 to `AuthRequired`.
- **Secret handling:** token and API key live only in a private struct with a manual `Debug` that prints `<redacted>`, and are zeroed on drop if `zeroize` is already in the lockfile (otherwise overwrite the `String` bytes manually before drop; no new dependency).
- **Request (ChatGPT mode):** `POST https://chatgpt.com/backend-api/transcribe`, `multipart/form-data` with parts `file` (filename `recording.wav`, content type `audio/wav`), `model` = `gpt-transcribe`, optional `prompt`. Headers: `Authorization: Bearer <access_token>`, `chatgpt-account-id: <id>`, `originator: bloblex`, `User-Agent: bloblex-desktop/<crate version>`, optional fedramp header. API-key mode: `POST https://api.openai.com/v1/audio/transcriptions` with `Authorization: Bearer <key>` and the same form fields. Total timeout 65 s; reject audio over 20 MiB or under ~1 s of speech before any network call; read at most 1 MiB of response; parse `{"text": "<string>"}` only.
- **Base URL injectable** for tests (constructor parameter), default as above.
- **Errors (`CloudError`, typed, `Display` carries no body/URL/token):** `AuthMissing`, `AuthRequired` (401), `RateLimited` (429), `Challenged` (403 with a `cf-mitigated` header; **no cookie replay**, fall back instead), `Unavailable` (5xx, timeout, connection), `TooLarge`, `TooShort`, `BadResponse`, `Rejected(u16)` (other 4xx). Map each to a stable machine code string: `auth_missing|auth_required|rate_limited|challenged|unavailable|too_large|too_short|bad_response|rejected`.
- **Audio:** helper that turns 16 kHz mono f32/i16 samples into a PCM16 WAV in memory with a correct 44-byte header; a bounded in-memory buffer type with a hard cap (about 10 minutes at 16 kHz mono PCM16, i.e. under the 20 MiB cap).

## Engine selection (`bloblex-speech`, pure function with tests)
`resolve_engine(preference: Local|Automatic|Cloud, consent: bool, auth: &AuthStatus, local_ready: bool) -> Resolved { primary: OnDevice|ChatGpt, fallback: Option<OnDevice>, unavailable: Option<code> }` with these rules: `Local` never uses the network. `Automatic` and `Cloud` use ChatGPT only if `consent && auth is Ready/ApiKey/Expired`; otherwise on-device if `local_ready`; otherwise `unavailable` with a code (`consent_required`, `auth_missing`, `model_not_ready`). When ChatGPT is primary and `local_ready`, `fallback = OnDevice`. Consent is never inferred.

## Native wiring (`apps/desktop/src-tauri/src/speech.rs`, keep it thin)
- New command `speech_cloud_status() -> {authState, authMode, expiresAt}` using `AuthStatus` (camelCase JSON). Register it in `lib.rs` next to the other speech commands.
- Extend `dictation_start` with two optional trailing arguments `engine: Option<String>` (`"local"|"automatic"|"cloud"`, default `"local"`) and `cloud_consent: Option<bool>` (default false). The current signature requires a ready local model and errors `speech_model_not_ready`; keep that behaviour **only when the resolved primary is on-device with no cloud option**. When the primary is ChatGPT, a missing local model is fine (no fallback available).
- Cloud sessions reuse the worker/lifecycle/capture/level/bubble plumbing. Instead of the sherpa engine, frames are downmixed, resampled to 16 kHz and appended to the bounded buffer (levels still emitted). On `Stop`, emit the existing `processing` event, transcribe off the worker thread with the blocking client, then emit the existing final-text event and `stopped`. On a buffer-cap hit emit an error with code `too_long` and stop capture.
- **Fallback:** if the cloud call fails and `fallback == OnDevice`, feed the same buffered samples through the local engine (load it if needed) and emit the final text from it. Never silently drop audio.
- **Engine event for the UI (status only, no content):** emit `bloblex-dictation-engine` with `{ "owner": ..., "engine": "on-device" | "chatgpt", "fallback": bool, "reason": "<machine code>" | null }` once per session when the engine is chosen, and again with `fallback: true` and the reason if a cloud failure fell back. If neither engine can produce text, emit the existing error event with a calm user-facing message that names the reason class (not the body), e.g. `ChatGPT transcription is unavailable (rate limited) and no on-device model is installed.`
- Nothing else in `speech.rs` changes behaviour for `engine = local`: that path must stay byte-for-byte as it is today.

## Tests (required; deterministic, no real network, no real tokens)
`bloblex-speech` unit tests: auth.json variants (chatgpt with `tokens.account_id`, claim-only account id from access token and from id token, apikey, missing, malformed, unreadable); JWT `exp` expired/valid; fedramp header; redaction (`format!("{:?}")` of the secret struct and of `CloudError` never contains the token/body); WAV header fields; buffer cap; multipart body well-formed (boundary, part order, final CRLF); `resolve_engine` truth table including consent never inferred; error mapping through a loopback fake HTTP server (use `tokio` and a plain `TcpListener`; cases 200, 401, 403+cf-mitigated, 429, 500, oversized body, bad JSON, slow body timeout with a short injected timeout); size/duration pre-checks make no network call.
Desktop: if `cargo check -p bloblex-desktop` runs, include its result; add `#[cfg(test)]` unit tests in `speech.rs` only for pure helpers you extract.
All pre-existing `bloblex-speech` tests pass.

## Evidence file
`docs/evidence/cloud-dictation-2026-10-12.md`: the exact request shape, what is fake-verified, and a **Not verified live** list (WAV acceptance by the real endpoint, behaviour under Cloudflare, token refresh timing, account-plan limits).

## Gates (run and report real output)
```
CARGO_TARGET_DIR=D:/b-p7 cargo test -p bloblex-speech
CARGO_TARGET_DIR=D:/b-p7 cargo check -p bloblex-desktop   # report the result honestly if it cannot complete
```

## Final report (plain text, last message)
1. Files changed. 2. Per section: what you did and exact test names. 3. Gate output per command. 4. Anything unverified, spec/source mismatches, declined items. Fake-peer verified only; no live-endpoint claim.
