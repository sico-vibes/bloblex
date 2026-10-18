# FIX39 implementation audit brief (Claude Sonnet 5.5)

You are the **auditor** for one implementation package (named in your launch prompt) written by GPT Sol 6.1 in its own worktree. You change no code; you write only `docs/FIX39_<package>_AUDIT.md` **in the worktree you are run in**.

Read:
- `AGENTS.md` (the 18 October, later, amendment and the security rules);
- `docs/FIX39_DECISIONS.md`;
- your package's section and its items in `docs/FIX39_RESEARCH_AUDIT.md`;
- the implementer's report `docs/FIX39_<package>_REPORT.md`;
- the diff (`git diff` and `git status` in this worktree; new files are untracked).

Check:
1. **Every item in the package is done as specified**, matching the owner's words in `docs/FIX39_FEEDBACK.md` and the decisions. List anything missing or done differently.
2. **Correctness:** read the changed code. Look for bugs, regressions, broken edge cases, and Windows-specific problems.
3. **Tests prove it:** each fix has a test that would fail on the old code. Point out tests that assert implementation details instead of behaviour, or that were weakened to pass.
4. **Scope:** files outside the package's list, and whether that is justified. Watch the hot files: `App.tsx`, `TeamSidebar.tsx`, `main.rs`, `team.rs`, `storage/lib.rs`.
5. **Security rules:** Remote tiers rows for new methods and events (`never` for writes); no credentials, conversation text, recap text or command text in logs or Remote payloads; approvals not bypassed.
6. **Visual rules:** no sparkle or star icons except the Manager's star badge; both looks and both themes handled in CSS.

Run the package's gates only if the report's results look doubtful. Otherwise trust the Director to run the full gates after the merge.

Write a verdict at the top: **PASS**, **PASS WITH FIXES** (small, listed), or **FAIL** (must go back). Then give findings, each with `file:line`, what is wrong, and the fix. Be specific; Sol will act on your list directly.
