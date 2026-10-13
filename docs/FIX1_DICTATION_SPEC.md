# Fix 1A spec: why ChatGPT dictation says "verification required" (diagnose, then fix what is ours)

Owner: OpenCode lane (backend/native only). Reviewer: Director. The desktop UI (`apps/desktop/src`) is the Director's; **do not touch it, and do not touch `crates/bloblex-daemon`, `crates/bloblex-adapter-*`.**
Scope: `crates/bloblex-speech` (mainly `src/cloud.rs`), `apps/desktop/src-tauri/src/speech.rs`, `docs/evidence/`.

## Symptom (owner report)
The owner is signed in to Codex (ChatGPT login) on this PC. Starting dictation with the ChatGPT engine shows: "ChatGPT transcription is unavailable (verification required) and no on-device model is installed." "verification required" is our `CloudError::Challenged` (403 with a `cf-mitigated` response header, `crates/bloblex-speech/src/cloud.rs` ~L716). The owner does not understand it and asked for a root cause.

## Hard rules (security, non-negotiable)
- Never run `git commit`, `git push`, `git checkout`, `git stash`. Leave changes uncommitted. Work only inside this worktree except for the explicit read-only auth-file read in the probe below.
- **Never print, log, store, paste into a file or include in your report any token, API key, account id, JWT fragment, cookie or response body.** A probe may print only: HTTP status code, the *names* (not values) of response headers, the value of `cf-mitigated`, `content-type`, `server`, body length, and whether the body parses as JSON with a `text` key.
- **No bypass of bot protection.** Do not change `User-Agent`, `originator` or any header to imitate Codex, a browser or any other client, do not replay cookies, do not solve or work around a challenge, do not add a retry loop to defeat it. We identify as Bloblex. This is a diagnosis, not an evasion exercise. If the root cause is "Cloudflare challenges non-browser clients to this private endpoint", the correct outcome is an honest message plus the existing fallback, and you say so.
- The owner approved reading the Codex `auth.json` read-only for dictation only (see `AGENTS.md`). Probing the endpoint with one tiny silent clip using that login is within that approval; do it at most 3 times in total.

## Task A: reproduce with a safe probe
1. Write `scripts/live-checks/live-cloud-dictation.mjs` (Node, no dependencies). It reads `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) read-only, extracts only what the request needs, builds a 1-second silent 16 kHz mono PCM16 WAV in memory, and POSTs it exactly the way `CloudTranscriber::transcribe` does (same URL, multipart parts, `model=gpt-transcribe`, same headers). It prints only the allowed fields above, as one JSON object. It must never print the request headers or the token.
2. Run it and record the result in the evidence file. If it returns 200 with a `text` key, the Cloudflare case is not reproduced from a plain script: say so, and investigate what differs in the app (TLS stack, proxy env vars, http version, `Expect`/`Connection` headers, timeouts, WAV size).
3. Also report from `auth.json` **non-secret** facts only: `auth_mode` value, whether `tokens.account_id` is present (yes/no), whether the access token is expired (from `exp`), and the Codex CLI version if available through `codex --version`.

## Task B: find out whether the Codex CLI itself can transcribe (a better path than copying its token)
Inspect the installed Codex CLI's app-server protocol without sending any audio: `codex app-server generate-json-schema --out <dir inside this worktree's target/tmp>` (or `generate-ts`). Search the generated schema for any request/method related to audio, voice, realtime or transcription. Report the exact method names and parameter shapes you find, or "none". Do not implement anything for it; this is evidence for the owner's decision.

## Task C: fix what is ours
Based on the findings, and only for defects that are really ours, fix them with tests. Candidates to check (report each as confirmed or ruled out):
1. A `403` without `cf-mitigated` is `Rejected(403)`; a 403 whose body says the account lacks access, or a 401, are different problems from "verification required". Make sure each real condition maps to a distinct, truthful `CloudError` display string (no vague "verification required" for a non-challenge).
2. The `Challenged` display string should be honest and plain: it is OpenAI's anti-bot check blocking requests that do not come from the official apps. Put a short stable machine `reason` code in the engine event (already `challenged`), and keep display strings free of tokens/URLs/bodies.
3. After a `Challenged` (or other persistent failure) in `automatic` mode, the app should not re-attempt the cloud on every dictation in the same run: add a small in-memory cool-down (e.g. 10 minutes) so repeated dictations go straight to the on-device engine instead of failing slowly. Expose the cool-down state in the engine event `reason` (`cloud_cooldown`). Tests for the pure cool-down logic with an injected clock.
4. The "no on-device model is installed" half of the message: confirm in `speech.rs` how readiness is computed and that a missing local model with a failed cloud call produces one clear error code the UI can map ("both engines unavailable"). Name that code in your report; do not change UI.

## Gates
```
CARGO_TARGET_DIR=D:/b-p7 cargo test -p bloblex-speech
CARGO_TARGET_DIR=D:/b-p7 cargo check -p bloblex-desktop
```
(if the desktop crate cannot be built from this apostrophe-free sibling path for a reason you cannot fix, say so plainly.)

## Evidence file
`docs/evidence/cloud-dictation-diagnosis-2026-10-13.md`: probe output (allowed fields only), Task B result, what is confirmed/ruled out, what remains unverified.

## Final report (plain text, last message)
1. Files changed. 2. Root cause in one paragraph (state clearly if it is Cloudflare blocking us and cannot be fixed on our side without impersonating another client). 3. Task B finding. 4. Tests added by exact name and gate output. 5. Anything unverified.
