# Operating model: the rules in effect today

> **AGENTS.md wins on any conflict.** This file is a derived summary. It adds no rule. Every bullet cites the AGENTS.md section it comes from. Where AGENTS.md itself contradicts its own text, the bullet says so and names the later amendment that applies. Derived 14 October 2026 from the AGENTS.md text in this checkout. Line numbers refer to `AGENTS.md` as of this pass.

## 1. Which AGENTS.md text is in force

- The amendments at the top of AGENTS.md override the sections below them where they differ: "Amendment (12 October 2026)" (line 3), "Amendment (14 October 2026)" (line 11), and the delegation section, "Delegation pipeline (from 1 October 2026, evening)" (line 22). The 1 October "Resume" and "User's current working arrangement" sections are marked superseded in the file (lines 26 and 34).
- The 1 October "Delegation pipeline" still applies except where the 12 October amendment changes it. Its line that the Director "never writes production code" (line 24) is replaced by the 12 October lanes rule (line 7), which lets the Director write UI and UX production code.
- The "Scope and invariants" section (lines 52-59) remains in force. Its clause "the daemon owns ... budgets" (line 57) is superseded by the budget retirement at line 9.

## 2. Lanes and ownership

- Heavy non-UI coding (Rust daemon, adapters, storage, speech crate, `src-tauri` native code, schema, non-visual TypeScript, backend tests) goes to OpenCode `opencode-go/deepseek-v4.1-flash` at high effort. (AGENTS.md, 12 Oct amendment, "Lanes", line 7.)
- UI and UX work (components, styles, copy, motion, island or companion, settings screens) is done by the Director (Claude), following `DESIGN.md` and `PRODUCT.md`. (Line 7.)
- The Director reviews every OpenCode diff and commits after gates. (Line 7; line 24.)
- The OpenCode lane never runs `git commit` and does not grade its own work. Backend diffs also get a read-only second opinion from a different lane, `impl-b`, via `scripts/run-cursor-delegate.ps1`. (Line 7.)
- Codex `impl` remains available when the owner assigns it. (Line 7.)
- `impl-b` is Cursor `grok-4.7-high` through the `cursor-delegate` skill, for bake-offs. `qa` is OpenCode `opencode-go/deepseek-v4.1-flash` and reports to the Director only. (Line 24.)
- Cursor runs must go through `scripts/run-cursor-delegate.ps1` from PowerShell. (Line 24.)
- Nobody edits the user's hooks or settings. (Line 24.)

## 3. Commits and release authority

- The default rule: implementers, including the OpenCode lane, never run `git commit`. The Director commits after review and gates. (AGENTS.md line 7, "never runs `git commit`"; line 24, "Implementers never run `git commit`".)
- One-release exception: the owner, acting as Director, delegated the commit and publication of the `beta.22` dictation fix to the OpenCode lane once. It does not change the general rule, and the read-only second opinion still applies to later backend work. (Line 20, "Commit and release authority, delegated once".)

## 4. Budgets and unattended work

- Budgets are retired. `budget.*` returns `unsupported`. Do not claim budget enforcement. (AGENTS.md line 9; the code is `crates/bloblex-daemon/src/main.rs:992`.)
- Unattended work, such as automations, must bring its own caps: a runtime limit, a concurrency limit, a global pause, and a permission mode that is never bypass. (Line 9.)

## 5. Cloud dictation (the dictation exception)

- Cloud dictation may read the Codex CLI's `auth.json` read-only to call ChatGPT transcription. (AGENTS.md, 12 Oct amendment, line 8.)
- It is opt-in with explicit consent. The on-device engine stays the default and the automatic fallback. The token, audio and transcripts are never persisted or logged. The exception covers dictation only. (Lines 8 and 18.)
- All other "no copied provider authentication" rules stand. (Line 8.)
- The endpoint `chatgpt.com/backend-api/transcribe` is recorded as owner-attested. No copy of OpenAI's reply is in the repository. If the endpoint or the terms change, the exception lapses. (14 Oct amendment, line 15.)

## 6. Request-shape matching (cloud dictation only)

- Matching the accepted request shape is allowed for this one call path. The accepted shape is the TLS stack: rustls, not the platform SChannel stack. (14 Oct amendment, lines 16 and 19; evidence `docs/evidence/cloud-dictation-tls-backend-2026-10-14.md`.)
- Presenting another client's identity stays forbidden. `originator` stays `bloblex`. The User-Agent stays Bloblex's. Do not send `originator: bb`, `bb-host-daemon`, a Codex or browser User-Agent, or any other app's name. (Line 17.)
- Stays forbidden: cookie replay, challenge-solving and retry loops. (Line 17.)
- **Open conflict:** `crates/bloblex-speech/src/cloud.rs:43-50` and `:921-935` keep Cloudflare cookies in memory and send them once more on a retry. That is cookie replay as line 17 defines it, and the 14 October FIX2 spec and the `beta.21` and `beta.22` release notes describe it as the kept "cookie retry". The owner must decide whether the shipped behaviour is allowed. This document does not resolve it.
- Unchanged by the amendment: cloud dictation stays opt-in with consent; the on-device engine stays the default and fallback; no persistence or logging of token, audio or transcripts; dictation only. (Line 18.)

## 7. Invariants (in force)

- No copied provider authentication, no primary terminal scraping, no raw provider JSON in React, no fabricated success or usage, and no unknown price presented as zero. (AGENTS.md lines 56, "Scope and invariants".)
- Daemon owns sessions and permission decisions. (Line 57; the budget part is retired by line 9.)
- Keep prompts in stdin and protocol fields, never in shell command text or large argv strings. (Line 58.)
- Never record capability secrets or provider credentials in docs or logs. (Line 58.)
- Preserve all requirements of the supplied plan. Do not redefine v1 around whichever subset already passes. (Line 54.)
- Companion: rounded corners, not a stadium-shaped outer pill; bottom-center default; free drag and retained placement. (Line 55.)
- Review tests for what they prove. Distinguish independent evidence, implementer reports, source-only implementation and unverified behaviour. (Line 59.)

## 8. Coordination

- The coordinator is responsible for the handoff, the status checklist and the documentation index. (AGENTS.md line 50, under "Ownership", the 1 October section that is not amended.)
