# FIX37 G1 report: the Remote page downloads; a Claude resume that never initializes

> **What this is:** Report on FIX37 G1: the Remote page downloads, and a Claude resume that never initialises.
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: OpenCode `deepseek-v4.1-flash` (high). Worktree `C:\fx61`. No commit was run.

## 1. The remote web app downloads as a file

`crates/bloblex-daemon/src/remote/web.rs` `static_file` looked up the request path
in the manifest (so `/` resolved to `remote.html`) but passed the **request** path
to `content_type_of`. `/` has no extension, so the entry page was served as
`application/octet-stream`; with `X-Content-Type-Options: nosniff` the browser
downloaded it as `download`.

- `web.rs:999-1003` — the content type now comes from the **resolved file**
  (`content_type_of(&file.to_string_lossy())`), not the request path. Both `/` and
  `/remote.html` therefore answer `text/html; charset=utf-8`.
- The two fallbacks that serve the built-in entry page (`not_installed_response`,
  `web.rs:972-979`) already set `text/html; charset=utf-8`; no other route serves
  an entry page (unknown paths are a `404`, not an SPA fallback).

Tests (`crates/bloblex-daemon/src/remote/tests.rs`):

- `raw_content_type` helper (`tests.rs:821`) reads the response's `content-type`.
- `static_files_come_from_the_manifest_and_nothing_else` (`tests.rs:828`) now
  asserts `GET /` and `GET /remote.html` are `200` with
  `text/html; charset=utf-8`; `/remote-sw.js` stays `text/javascript`,
  `/assets/app.css` stays `text/css`, `/remote.webmanifest` stays
  `application/manifest+json`, `/assets/app-AbC123.js` stays `text/javascript`,
  and `/nope.js` stays `404`. A CSS fixture was added (`tests.rs:76`).

## 2. "The coding agent is not available" after signing in again

A stored Claude resume that failed to initialize returned
`AdapterError::Process("Claude resume did not initialize")`, which the daemon
treated as a terminal turn error instead of continuing the conversation.

**New error variant.** `crates/bloblex-agent-core/src/lib.rs:672-676` adds
`AdapterError::ResumeFailed(String)` ("provider resume did not initialize: …").
It is distinct from `ResumeRejected` (the provider rejected a stored id) and from
a generic `Protocol` failure (and a `Process` failure outside a resume start),
which must stay terminal.

**Daemon fallback.** `crates/bloblex-daemon/src/main.rs`:

- `resume_or_start_fresh` (`main.rs:2065-2105`) now falls back to a fresh
  provider session for `ResumeRejected` **and** `ResumeFailed`, using the existing
  FIX34 A2 path: clear the provider id, quietly clear the context meter, emit
  `session.context.reset` and `session.resume_rejected` when the context had a
  delivered prompt, then start fresh. `resume_inner` records the existing
  `context_reset` notice with `contextLost: true` when the fallback happened and
  the context had a turn (`main.rs:2286`). Only if the fresh `new_session`
  also fails is the turn an error (`provider_unavailable`).
- `adapter_failure_class` maps the new variant to `"other"` (`main.rs:160-161`).

**Adapters.**

- Claude (`crates/bloblex-adapter-claude/src/lib.rs:945-947`): a resume that
  never emits `system/init` (process exits or errors before init, or the 8s gate
  times out) now returns `ResumeFailed` instead of `Process`.
- Codex (`crates/bloblex-adapter-codex/src/lib.rs:720-728`): a `thread/resume`
  that fails to come up (`Process` or `Timeout` after `initialize`) is reported
  as `ResumeFailed`; the crash-resume path treats it like `ResumeRejected`
  (`lib.rs:636`).
- OpenCode/ACP (`crates/bloblex-adapter-acp/src/lib.rs:1130-1136` and
  `579-580`): a `session/load` that fails to come up is reported as
  `ResumeFailed`, and `establish_session` starts a fresh `session/new` for it
  (`lib.rs:588`). Recognised rejections still map to `ResumeRejected`.

**A stale `resumable` flag is no longer trusted.** `resume_inner`
(`main.rs:2138-2142`) now also requires `session_had_provider_turns` before
resuming, so a handle whose context never had a delivered prompt is never sent
into a resume that can only fail (legacy rows without the `providerTurns` key
still count as used when they hold messages).

**A sign-in failure no longer leaves an unproven handle resumable.**
`demote_provider_context_after_sign_in_failure` (`main.rs:535-551`) clears the
provider id (which also resets `providerTurns`) when the failing turn's context
never completed a turn: `providerTurns <= 1` when the prompt reached the adapter
(`main.rs:3807`), or `0` when it did not (`main.rs:3120`). A context with two or
more delivered prompts keeps its handle; a legacy row (no `providerTurns` key)
reads as 0 for the non-delivered case and is left alone when it holds messages.

Tests (`main.rs`):

- `restart_send_is_accepted_then_resumes_and_prompts` (`main.rs:5101`): case 4
  (`main.rs:5207`) now proves a resume that fails to initialize falls back — the
  prompt is delivered to a fresh session, exactly one `context_reset` notice with
  `contextLost: true` and `reason: fresh_session` is recorded, the turn
  completes, and the provider id becomes the fresh one. A second case
  (`main.rs:5246`) proves a fresh start that also fails gives
  `provider_unavailable`. Its `prepare` helper now stores `providerTurns: 1`
  (`main.rs:5139`), which is what makes a saved handle eligible at all.
- `a_stored_provider_id_without_a_turn_is_not_resumed` (`main.rs:5769`): a
  `resumable` handle with `providerTurns: 0` starts fresh (0 resume calls) and
  nothing is announced.
- `a_sign_in_failure_drops_a_provider_context_that_never_completed_a_turn`
  (`main.rs:5790`): a sign-in failure on a one-prompt context drops the handle
  and its `resumable` flag; on a two-prompt context the handle is kept.
- `daemon_generic_resume_error_preserves_saved_provider_pointer` (unchanged)
  still proves a generic adapter error does **not** fall back.
- `resume_failure_becomes_turn_error` (unchanged, `SendAdapter` returns a generic
  `Protocol` failure) still proves a non-resume-specific error stays terminal.

Adapter test: `crates/bloblex-adapter-claude/tests/lifecycle.rs:552`
`resume_that_never_initializes_is_reported_for_a_fresh_retry` drives the fake CLI
mode `--fake-resume-no-init` (added at
`crates/bloblex-adapter-claude/src/bin/fake_claude.rs:56`), which exits on
`--resume` without emitting `system/init`, and asserts `ResumeFailed`.

## Gates

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — 43 test targets, 721 tests passed. One run reported
  `phase2a_tests::catalog_cached_only_never_waits` failing; that test is a timing
  test in the catalog path this diff does not touch (probe 40 ms, sleep 80 ms
  before asserting the background refresh filled the cache). It passes 3/3 in
  isolation and the full run is clean on re-run, so it is recorded as a
  pre-existing load flake, not a regression.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.

## Unverified

- No live Claude/Codex/OpenCode run against a real expired sign-in; the fallback
  is exercised only by the fake adapters and the fake Claude CLI.
- The Claude resume gate is a fixed 8 seconds. A resume that is merely slow
  (>8 s) now falls back to a fresh session instead of failing; not measured
  against a real slow machine.
- "Never completed a turn" is approximated by `providerTurns <= 1` (delivered
  prompts), because no completed-turn counter exists. A first prompt that
  completed and a second that failed before delivery would read as 1 and be
  demoted; the next activation then starts fresh silently rather than resuming.
- The Remote fix is verified at the HTTP level only; the page was not opened in
  a real phone browser.
- Codex and ACP `ResumeFailed` mapping is not covered by an adapter-level test
  (their fixtures have no "resume never initializes" mode); only the daemon
  fallback is tested.
