# FIX40 research brief: how T3 Code runs its agents, and what Bitbots should take from it

> **What this is:** Brief for the FIX40 T3 Code research.
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: OpenCode `deepseek-v4.1-flash` (high), **research only**. Read the section headings of `AGENTS.md`, especially the 18 October (later) amendment. You change no Bitbots code and no existing file; you write only `docs/history/fix-40/t3-research.md`. Never run `git commit`.

## Source to study

T3 Code is MIT-licensed: `https://github.com/pingdotgg/t3code`.
- Shallow-clone it **outside** the Bitbots repo: `git clone --depth 1 https://github.com/pingdotgg/t3code C:/fxt/t3code-src`.
- **Read it; do not install dependencies and do not run any of its code.**
- If their orchestrator V2 lives on a branch or in a recent release, find it (README, releases, docs, changelog) and read that code.
- Read Bitbots' own code to compare: the provider adapters in `crates/bloblex-adapter-*`, the session and turn handling in `crates/bloblex-daemon/src/main.rs`, team, side conversations and the bridge in `team.rs`, `proposals.rs` and `knowledge.rs`.
- Read the FIX39 research and audit for what we already know about our failures: `docs/history/fix-39/research-r2.md`, `docs/history/fix-39/research-audit.md`, items 16 to 22.

You may ask Claude Haiku 5.5 short factual questions with `claude -p --model claude-haiku-5-5 --effort high "<question>"`. Never send secrets or the owner's file contents.

## Questions to answer, with file:line evidence from T3 and from Bitbots

1. **Provider connections.** How does T3 connect to Claude Code, Codex and OpenCode? Cover:
   - process model: long-lived or per turn, and SDK or CLI protocol;
   - how a session or thread is created, resumed and recovered after a crash or restart;
   - how context survives when a resume fails;
   - timeouts and retries;
   - how it detects that a provider is out of usage or rate-limited, and what it does then.

   Compare each point with ours.
2. **Threads.** What a thread is in T3: what is stored on their side versus inside the CLI, and how the UI shows a running thread's live activity. How does that map to Bitbots conversations and sub-conversations?
3. **Orchestrator V2.** How it plans, delegates and runs several agents in parallel:
   - isolation (worktrees or folders);
   - how sub-agents report back;
   - how the user steers mid-run (messages while the agent works, interrupts, queueing);
   - how results are verified or merged;
   - watchdogs and failure handling.
4. **Steering.** How a user message sent while an agent is working reaches it: steer, queue or interrupt, per provider. Compare with ours: Codex steer, the queue, and Stop.
5. **Permissions.** Where permission and sandbox mode are decided (per agent, per thread or per run), and whether they can change mid-run.
6. **Their MCP.** T3's own MCP that lets models act inside the app: what tools it offers and how they are scoped and approved. Compare with our bloblex bridge and the P7 tool set in `docs/history/fix-39/decisions.md`.
7. **Reliability engineering.** Anything else that explains why T3 feels robust: event model, persistence, tests against real CLIs, error copy.

## The owner's vision: the measuring stick for every recommendation

The owner prefers Bitbots' bots and visual UI over T3's threads, but Bitbots must be as reliable as T3. Recommendations must fit this model:

- **The Manager feels like texting a capable team lead** (the owner compares it to Grok Bot's team leader). The owner chats naturally, sends messages while it works, steers it, and it replies and adjusts, the way the owner steers the Director's lanes mid-flight. It should feel neither restricted nor bureaucratic.
- **It routes work by itself.** It hands a task to the right bot based on role, description and tags, does small things itself when no bot fits, or proactively suggests creating a bot to own the task.
- **Projects bind bots to a folder (repo); free bots are not bound.** Examples:
  - "Do some research" with no project named goes to a free bot tagged researcher.
  - "Research X for project P", or any mention of P in the message, goes to P's researcher. If P has none, the Manager proposes creating one.
  - The Manager must resolve which project the user means, from names, tags and context, before acting.
- **Sub-conversations stay bots talking to each other**, driven by the bots. The owner needs full visibility of what they say to each other, live.
- **Permissions belong to the bot** and apply to all its conversations, not to individual conversations.
- **A watchdog:** timeouts, retries, fallback when a provider hits a limit, and honest status.

Consider the Director's earlier suggestions too, and say which T3 evidence supports or contradicts them:
- tasks with a brief, a done-criterion and a report;
- one-shot runs instead of resumed chats where it helps;
- worktrees for parallel coding;
- Manager grounding rules: list projects and bots first, ask when unsure;
- a reliability test suite against real CLIs.

Do not take a suggestion that would make the Manager feel restricted. Prefer designs where reliability is invisible and the chat stays natural.

## Deliverable: `docs/history/fix-40/t3-research.md`

1. **Short summary:** why T3 is robust, in plain words, in five to ten lines.
2. **Findings per question:** T3's design and ours, side by side, with evidence.
3. **Recommendations table:** columns are #, Recommendation, Problem it fixes (cite owner items or the friend's failures), T3 evidence, Fits the owner's vision? (yes, partly or no, and why), Effort (S/M/L), Priority (P0/P1/P2), Bitbots files affected. Order it by priority. P0 means the things without which users will leave, like the friend did.
4. **What not to copy from T3,** and why: anything that conflicts with the bots model.
5. **Licence note:** what we may reuse from MIT code and what attribution `docs/legal/third-party-notices.md` would need.

Keep your context small: grep, then read only the ranges you need.
