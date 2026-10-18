# FIX39 owner decisions (18 October 2026)

Answers to the questions in `docs/FIX39_RESEARCH_AUDIT.md`, plus the decisions the audit made itself. Implementers follow these over anything else in the research.

## The owner's answers

1. **Parallel conversations per bot (item 18): no per-bot cap.** The owner: "why there's a cap to begin with? … the idea of conversation or bots is to be like what we're doing right now with lanes … I don't see the reason for capping it, but we can do 3 if we must."
   - Remove the per-bot concurrency cap for every bot, both new and existing: one bot can run many conversations at once, as the Director runs many lanes.
   - Keep only the **global** safety limit, shown as a setting (Settings › General › "Bots working at once", default 4, range 1–16).
   - If a hard technical reason prevents unlimited per-bot work for one provider, cap that provider at 3 and say why in the report.
   - Show "waiting" (queued) honestly when the global limit is reached.
2. **Workspace (item 21): projects added to Bitbots, with tags; the Manager may set tags itself** (never on a locked bot). Scanning disk folders is out of scope.
3. **Bitbots MCP (item 22): build it, but as Bitbots' own internal tool set.** The owner meant T3 Code's own MCP that lets models act inside the T3 app, not an endpoint for outside agents. Bots and especially the Manager get a complete, documented set of Bitbots tools on the existing bloblex MCP bridge to act inside Bitbots:
   - list and read bots, projects, conversations and status;
   - create bots; change a bot's name, description, role, instructions, look, model, effort and permission mode;
   - create projects and set tags;
   - start, open and message conversations, including parallel sub-conversations;
   - read and set a sub-conversation's permission (item 19).

   Rules that stay:
   - Every consequential write by the Manager goes through a proposal card the owner approves (the 17 October decision, "approve every action"). Reads need no approval.
   - Ordinary bots get only the tools they have today, unless the owner later widens them.
   - Locked bots refuse every change.
   - Nothing on this bridge is reachable from outside the computer. No external MCP endpoint is built.
4. **The leftover background services** (PIDs 18900, 14080, 18356) were ended with the owner's permission on 18 October. 18900 held the Tailscale port 48620, which made "Allow remote devices" fail. Package P3 must make that impossible to repeat (parent watchdog and single instance).

## Decided in the audit (not asked)

- The composer always writes the bot's settings (item 16).
- The Manager is never lockable; the daemon enforces the lock (item 13).
- The Manager cannot set Full access (item 19).
- Context recovery uses a bounded summary of the conversation from Bitbots' own record (item 20).
- The eight target shapes and their migration (item 4).
- "N/A" and "No usage yet" (item 14).

## Visual rules for every UI package

- Follow `DESIGN.md`.
- No sparkle or star icons (`Sparkles`, `Sparkle`, `Wand2`, `WandSparkles`, ✦ ✧ ✨) except the Manager's star badge (item 8).
- Both looks (classic and Bitbots) and both themes.

## P7: the Bitbots tool set (added by the Director from the owner's answer 3)

- **When:** Wave D, after P6 is merged. It shares `team.rs`, `proposals.rs` and `main.rs` with P5 and P6.
- **Files:**
  - `crates/bloblex-daemon/src/team.rs` (bridge tool schemas and handlers);
  - `proposals.rs` (new proposal kinds where a write needs approval);
  - `main.rs` (tool routing only);
  - `knowledge.rs` (the Manager suffix that lists its tools, kept short);
  - `apps/desktop/src/ui/ProposalCard.tsx` (cards for the new kinds);
  - `apps/desktop/src/remote/tiers.json`;
  - tests.
- **Done means:**
  - The Manager has documented tools to list and read bots, projects, conversations and status.
  - It can propose, with approval, creating a bot and changing a bot's name, description, role, instructions, look, model, effort or permission mode (never Full access).
  - It can create projects and set tags, and start, message or open parallel sub-conversations.
  - It can read a sub-conversation's permission and propose a change.
  - Locked bots refuse every change. Ordinary bots keep today's tools.
  - One daemon test per tool covers both outcomes: approval needed and a refusal.
  - The tool list in the Manager's prompt stays stable, so it does not change the instruction hash on every turn.

## P8: watchdog (the T3 research's P0 recommendations 3 and 4, folded in by the owner, 18 October)

The owner chose to fold the T3 research's P0 items into this release (`docs/FIX40_T3_RESEARCH.md`, §3). Recommendations 1 and 2 are already part of P6. P8 covers the other two:

- **Usage limits become a state, not an error (recommendation 3).**
  - Classify quota and rate-limit failures from every provider, with the reset time when the provider gives one.
  - Mark the conversation "Limited until <time>" in the transcript, sidebar and companion.
  - Resume it automatically when the window opens: a scheduled sweep in the daemon, on by default. Settings › Experimental gets "Resume after usage limits".
  - Never loop on an expired or unknown window; with no reset time, back off and ask.
  - Evidence and design: T3 `UsageLimitRecoveryWorker.ts`, `ClaudeAdapterV2.ts:2749-2831`, cited in the research.
- **Bounded retry and continuation (recommendation 4).**
  - Transient provider failures get a bounded retry with jittered backoff and one owner per turn. These include process start failures, dropped streams and 5xx errors; usage limits are excluded (they take the state above).
  - After a turn is killed or crashes (app restart, timeout), the next activation continues it with a one-off "Continue where you left off" prompt. The chain is bounded, and the context recap from P6 is included when the resume failed.
  - The user sees one honest line, for example "Retrying (2 of 3)…" or "Picking up where it left off", never a pile of errors.
- **Files:**
  - adapter error mapping in `crates/bloblex-adapter-{claude,codex,acp}`;
  - `crates/bloblex-daemon/src/retry.rs`;
  - `main.rs`, the turn start, failure and continuation path only;
  - `quota.rs` / `quota_sources.rs`;
  - the `crates/bloblex-storage/src/lib.rs` state columns, with a migration tested on a previous-version database;
  - `apps/desktop/src/remote/tiers.json` rows for new events;
  - UI: the notice copy in `errorCopy.ts`, the "Limited" state in `teamSelectors.ts` / `TeamSidebar.tsx` and the transcript notice, and the Experimental toggle.
- **When:** after P6 is merged; it shares `main.rs` and storage. It may run in parallel with P7 only if each keeps to its own areas of `main.rs` (P8 the turn path, P7 the tool routing).
- **Done means:** tests that fail on today's code for each of these:
  - a Claude, a Codex and an OpenCode usage-limit error become "Limited" with the right reset time;
  - the sweep resumes it;
  - an expired window does not loop;
  - a transient failure is retried within the bound and then reported once;
  - a killed turn continues on the next activation with the recap.

  Nothing in the retry or continuation path logs conversation text.
