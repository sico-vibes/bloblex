# FIX39 implementation brief (GPT Sol 6.1)

> **What this is:** Brief for FIX39 implementation (GPT Sol 6.1).
> **Status:** historical
> **Last updated:** 2026-10-18

You are an **implementer**: GPT Sol 6.1 at high effort, working in your own git worktree. Your package is named in your launch prompt (P1–P7).

## Read first
1. `AGENTS.md`: the section headings, plus the 18 October (later) amendment in full.
2. `docs/history/fix-39/decisions.md`. The owner's decisions override the research.
3. `docs/history/fix-39/research-audit.md`: your package's section, and the audit's item sections for your items. The audit corrects the research where they differ.
4. The research sections for your items in `docs/history/fix-39/research-r1.md`, `R2.md` or `R3.md`, for evidence and file:line pointers.
5. `docs/history/fix-39/feedback.md`, for the owner's own words.

## Rules
- **Never run `git commit`.**
- Edit only the files your package lists. If you truly need another file, keep the change minimal and say so in your report. Another package may be editing it.
- Do not edit `docs/design/design-system.md`, `docs/design/product.md`, `docs/legal/third-party-notices.md` or any `docs/` file except your report. The documentation lane handles docs.
- Every new daemon method or event needs a row in `apps/desktop/src/remote/tiers.json`; the parity test fails without one. New write methods are `never` remote.
- Security rules in `AGENTS.md` stand. Never log credentials, conversation text, or summary or recap text.
- Write tests first where you fix a bug, and make sure they fail on today's code.
- Keep your context small: grep, then read only the ranges you need.

## Gates (run them all; foreground; wait for each)
- Rust (if you changed Rust): `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"`, then `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`. If you changed `src-tauri`, also run `cargo test -p bloblex-desktop --lib`.
- UI: `cd apps/desktop && npx tsc -b && npx vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests |FAIL"`, then `npm run build`. If you changed the remote app, also run `npm run build:remote`.

## Report
Write `docs/FIX39_<package>_REPORT.md`:
- every item: what changed (file:line) and the tests that prove it;
- gate results;
- what you could not check (visual items, live behaviour);
- any file outside your list that you touched, and why.

The auditor (Claude Sonnet 5.5) reviews your diff against this report before the Director merges anything.
