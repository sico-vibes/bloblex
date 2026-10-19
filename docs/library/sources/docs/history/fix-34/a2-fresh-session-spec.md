# FIX34 A2: "Started a fresh session" must not repeat in existing conversations

> **What this is:** Spec for FIX34 A2: the fresh-session notice must not repeat in existing conversations.
> **Status:** historical
> **Last updated:** 2026-10-17

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree, private `CARGO_TARGET_DIR`. **Do not run `git commit`.** Read `AGENTS.md` first. Keep your context small: grep and read only the ranges you need (`main.rs` is very large); pipe long output through `tail`/`grep`.

## Problem (found by the Director)
Existing conversations show "Started a fresh session. The agent no longer has earlier context." several times in a row. Text: `context_change_notice()` (`crates/bloblex-daemon/src/main.rs` ~181). Written on two paths: the adapter `AgentEvent::ContextChanged` handler (~3523-3534) and the daemon resume path (~2074-2078, `if resume_fallback && !lazy_first_activation`).

Loop: the UI calls `session.warm` 400 ms after a conversation is selected. `session_warm` (~2211-2238) runs `activate_session(.., Owner::Warm)` → `resume_inner` (~1921). `WARM_MAX = 2` (~2178) closes the oldest warmed session when a third is warmed. On a fallback, `resume_inner` saves the new provider id as resumable (~2037) and clears `lazyStart` (~2038) even though no prompt was sent. Claude never writes a session that had no prompt, so the next resume of that id is rejected (`ResumeRejected`, Branch A ~2005-2007) and another notice is written; non-resumable rows (OpenCode without `loadSession`) take Branch B (~2008-2016) every time.

## Fix
1. Track whether the current provider context has ever had a delivered prompt: a session data flag `providerTurns` (integer), reset to 0 whenever a fresh provider session is started (any fallback, lazy start, `ContextChanged` with a new session), and incremented when a prompt is accepted by the adapter (the first prompt/turn start of that provider session). Persist it with the session row data like `lazyStart`.
2. Write the context-reset notice and emit `session.context.reset` **only** when the context being replaced had `providerTurns > 0`. A fallback from a never-used provider session is silent (still update the provider id internally).
3. Do not clear `lazyStart` on an activation that delivered no prompt (warm-up); clear it on the first delivered prompt.
4. Do not mark a provider id `resume: true` until it has had a turn (`providerTurns > 0`); before that, a later activation starts fresh silently instead of attempting `--resume` of an id the provider never saved.
5. The `ContextChanged` adapter path (Codex crash/respawn) follows the same rule: no notice when the previous context had no turns.
Keep `session.resume_rejected` and other events' behaviour for sessions that did have turns.

## Tests (daemon, fake adapters, temp DB)
- Warm the same idle conversation 3 times with evictions in between (warm 3 others), no prompt: zero `context_reset` notices, zero `session.context.reset` events.
- Lazy conversation: warm then prompt → no notice; the prompt resumes/starts once.
- A conversation with a delivered turn whose resume is rejected → exactly one notice.
- Codex-style `ContextChanged` with a never-prompted session → no notice; after a turn → one notice.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`

## Report
`docs/history/fix-34/a2-report.md`: changes with line references, tests, gates, what stays unverified (real CLIs).
