# FIX39 research audit brief (Claude Sonnet 5.5)

> **What this is:** Brief for the research audit in FIX39 (Claude Sonnet 5.5).
> **Status:** historical
> **Last updated:** 2026-10-18

You are the **auditor**. Read `AGENTS.md` (the 18 October, later, amendment), `docs/history/fix-39/feedback.md` (24 owner items) and the three research reports `docs/history/fix-39/research-r1.md` (items 1–15), `R2.md` (16–20), `R3.md` (21–24), written by DeepSeek. You change no code and no existing file; you write only `docs/history/fix-39/research-audit.md`.

## Audit every item

For each item 1–24:

- **Verify the evidence:** open the cited `file:line` and check the claim. Mark the item **Confirmed**, **Partly right** (say what is wrong or missing) or **Wrong** (give the real cause, with your own evidence).
- **Check the design:** will it actually fix what the owner sees? Is it safe (security rules in `AGENTS.md`: Remote, capability, no credentials in logs, approvals)? Does it break another item or existing behaviour? Is the test plan strong enough to prove it (tests that would fail on today's code)?
- Flag anything the research missed in the owner's words.

Item 20 (context lost after a restart, and the owner's question about T3 Code / ACP) and item 22 (an MCP to control Bitbots) need a clear, plain answer the Director can pass to the owner. Check them especially carefully.

## Then produce, for the implementer (GPT Sol 6.1)

1. **Packages:** a final list of implementation packages (P1, P2, …). Each has: the items it covers, the files it touches, what done looks like (behaviour plus the tests that prove it), and its dependencies. Packages that can run in parallel **must not edit the same files**. Say which ones must run in sequence. Aim for 4–6 packages.
2. **Owner questions:** only the decisions that are truly the owner's, each with options and your recommendation. Keep it short.
3. **Risks** the Director should watch while the packages run.

Keep your context lean: read the cited ranges, not whole files. Be specific and blunt; this audit decides what gets built.
