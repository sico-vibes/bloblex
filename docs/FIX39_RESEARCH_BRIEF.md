# FIX39 research brief (DeepSeek lanes)

You are a **research** lane: OpenCode `deepseek-v4.1-flash` (high). Read `AGENTS.md` section headings (especially the 18 October, later, amendment) and `docs/FIX39_FEEDBACK.md`. You **change no code and no existing file**; you only write your report file named below. Never run `git commit`.

Your items are listed in your launch prompt. For each item, write a section with:

1. **What the owner sees** (one or two lines, from the feedback).
2. **Evidence:** the code paths involved, with `file:line`, and what they do today. Read the code; do not guess. Where a cause can be proven (a test you can reason through, a log, a CLI's real output), prove it.
3. **Cause(s):** every cause you find, not just the first plausible one.
4. **Proposed design:** what to change, where, and how to test it (unit, mounted, end-to-end). Name the files. Keep UI work in line with `DESIGN.md`. No sparkle/star icons except the Manager's star badge (item 8).
5. **Size:** S / M / L, and dependencies on other items.
6. **Questions for the owner**, only where a real product decision is needed (keep them few and concrete, with a recommended answer).

You may look things up on the web (the owner's references: `https://grokbots.ai/studio`, `https://github.com/pingdotgg/t3code`) and read installed CLIs' real help output. You may ask Claude Haiku 5.5 for quick facts with `claude -p --model claude-haiku-5-5 --effort high "<question>"` (short questions; include the needed context in the question; never send secrets, tokens, or the owner's file contents). Keep your own context small: grep, then read only the ranges you need.

Write `docs/FIX39_RESEARCH_<your lane>.md`. End with a short **"Implementation packages"** list grouping your items into packages a separate implementer can take independently (name the files each touches, so packages from different lanes can run in parallel without editing the same files where possible).
