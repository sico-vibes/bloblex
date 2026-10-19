# FIX37 G1: the phone page downloads instead of opening; Claude fails after signing in again

> **What this is:** Spec for FIX37 G1: the phone page downloads instead of opening, and a Claude resume fails after sign-in.
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: OpenCode `deepseek-v4.1-flash` (high), its own worktree. **Never run `git commit`.** Keep context small: grep, then read only the ranges you need. Read the section headings of `AGENTS.md` first.

## 1. The remote web app downloads as a file (both Tailscale and Direct)

Opening the Remote address in a browser downloads a file named `download` holding `remote.html` instead of showing the page.

**Cause (confirmed):** `crates/bloblex-daemon/src/remote/web.rs` `static_file` looks up `/` in the manifest (which maps it to `remote.html`) but calls `content_type_of(path)` with the **request** path `/`, which has no extension, so the response is `application/octet-stream`; with `X-Content-Type-Options: nosniff` the browser downloads it.

**Fix:** derive the content type from the **resolved file** (the manifest value's extension), not the request path. Check every route that serves the entry page or a fallback (e.g. a client-side route without an extension, if one is served) gets `text/html; charset=utf-8`.

**Tests** (`remote/tests.rs`): `GET /` and `GET /remote.html` return `200` with `content-type: text/html; charset=utf-8`; a `.js`, `.css` and `.webmanifest` asset keep their types; an unknown path stays `404`.

## 2. "The coding agent is not available" on the first message after signing in again

The owner's Claude sign-in had expired, they signed in again in a terminal, then sent "What model are you?" in an existing conversation. The app's event log shows:

```
turn.error {"detail":"provider process unavailable: Claude resume did not initialize","failureClass":"provider_unavailable","message":"The coding agent could not start."}
```

The session was `resumable: true` with a stored Claude session id. Resuming it failed to initialize (the old provider session belongs to the failed sign-in, or no longer exists), and the turn failed instead of continuing.

**Fix:**
- When a Claude **resume** fails to initialize (the process exits or errors before `system/init`, or the resume id is rejected), fall back to a **fresh** provider session for the same Bitbots session and deliver the prompt there, recording the existing `context_reset` notice with `contextLost: true` (the same path FIX34 A2 uses when a resume is rejected). Only if the fresh start also fails is the turn an error.
- Check Codex and OpenCode for the same pattern (resume/load of a stored provider session failing at start) and apply the same fallback where it is missing.
- A turn that failed with a sign-in error must not leave the session's provider id marked resumable if that provider session never completed a turn (see `providerTurns` from FIX34 A2).
- A successful turn after the fallback clears the runtime's `sign_in_failed` flag as today.

**Tests** (`main.rs` tests with the fake adapters): a resume that fails to initialize falls back to a fresh session, the prompt is delivered, one `context_reset` notice with `contextLost: true` is recorded, and the turn succeeds; a fresh start that also fails gives `provider_unavailable`; a session whose provider id never had a turn is not resumed.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"` (foreground; wait for it)
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`

Write `docs/history/fix-37/g1-report.md`: what changed (file:line), tests added, gate results, what is unverified.
