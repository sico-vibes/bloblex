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

## More owner decisions (18 October, evening): borrow two T3 defaults and schedule every remaining recommendation

5. **Full access is the default permission for new bots.** The owner chose this in place of "Ask first".
   - Onboarding, the create wizard, the Manager setup and bot templates all default to Full access, and the UI says so plainly.
   - Existing bots keep their setting.
   - **Unchanged by AGENTS.md:** automations still never run with bypass, approvals from Remote stay off by default, and the Manager still cannot *propose* Full access for a bot. Only the owner sets it.
6. **Steer vs Queue becomes a visible setting** (T3's model).
   - Settings › General gets "When you send while a bot is working": **Steer** (reaches it now, where the provider supports it) or **Queue** (waits for the turn to end).
   - It comes with a one-line explanation and a keyboard modifier that sends the other way. It is shown in the composer while a bot works.
   - When the provider can't steer, it falls back to Queue and says so.
7. **Every remaining T3 recommendation is scheduled** (`docs/FIX40_T3_RESEARCH.md`, §3):
   - **P7 (extended):**
     - **Rec. 12:** delegation carries a brief, a done goal and a report-back. The Manager fills these in its tool calls; there is no form for the user.
     - **Rec. 14:** the Manager proposes creating a bot or project when none fits.
     - **Routing by role, tags and project:**
       - "do some research" goes to a free bot tagged researcher;
       - "research … for project P", or any mention of P, goes to P's researcher, or the Manager proposes creating one;
       - the Manager resolves the project before acting and asks with options when unsure.
   - **P9:** rec. 11 (live, visible activity and bot-to-bot messages in a running sub-conversation), plus decisions 5 and 6 above.
   - **P10:** rec. 13. A code-writing delegation gets its own git worktree when another task is working in the same repo; the Manager chooses this invisibly and merges back with approval.
   - **P11:** rec. 10, the real-CLI reliability suite (below).

## P11: reliability tests against the real CLIs (recommendation 10)

- **Live tests** run only when `BITBOTS_LIVE_TESTS=1`; they are skipped in the normal gates.
- **Models:** the cheapest from each provider, with simple prompts such as "which model are you?" and a short multi-turn exchange:
  - **Claude Code:** `claude-haiku-5-5`, effort medium.
  - **Codex:** `gpt-6-luna`, effort medium.
  - **OpenCode:** `opencode/deepseek-v4.1-flash-free`. This is the free Zen model, for tests only; the lanes keep using the Go plan.
- **Scenarios**, per provider, through Bitbots' real adapter and daemon path: start, turn, model report, second turn in the same session, resume after a daemon restart, a steer or queue while working, a permission-mode change, and a usage-limit or unavailable answer turning into a clean reported state or skip, not a failure.
- **Transcript replay:** the live runs record sanitised transcripts. Those transcripts become fixtures that a normal, offline test replays through the real adapters on every gate, as T3 does, so regressions are caught without spending tokens.
- **Rules:**
  - never print or store credentials;
  - fixtures contain no personal paths or secrets;
  - the CLIs use their normal installed sign-in, read-only, because live tests need it; nothing writes to CLI config or session files outside what a normal run creates;
  - Bitbots' own data (database, settings, workspaces) always goes to temporary folders, never the owner's real Bitbots data;
  - a usage limit is a reported skip with the reset time.
- **Files:** new test files and fixture folders under `crates/bloblex-adapter-*/tests` and `crates/bloblex-daemon/tests`, a small recorder helper, and a `docs/` note added by the documentation lane. P11 touches no production code, except a test-only hook if one is truly needed.
- **When:** now, in parallel with P6, because its files are separate.

## P12: local diagnostics (owner, 18 October, evening)

The background service logs only to stderr, which nobody keeps, and there is no way for a user to send a report. The owner approved adding:

- **A rolling log file** for the daemon and the desktop shell, in the app's data folder under `logs/`:
  - daily rotation, at most about 20 MB in total, oldest deleted;
  - level `info` by default, with a hidden setting for `debug`.
- **Redaction:** following the AGENTS.md privacy rules, logs never contain message or prompt text, recap text, command text, file contents, credentials, tokens, environment values, Tailscale status JSON or Remote cookies.
  - A central redaction helper plus a test over every log call site that could carry user text.
  - IDs, error classes, provider names, versions, timings and exit codes are allowed.
- **"Export diagnostics"** in Settings › General (also in the profile menu's help group). It writes one `.zip` through the native save dialog, using the existing opaque-token pattern, with no webview-supplied path. The zip contains:
  - the recent log files;
  - the last N `app_events`, with any message text stripped;
  - app version, OS version and CLI names and versions;
  - settings with secrets removed;
  - a `README.txt` saying what is inside.

  A preview lists the contents before saving. Nothing is uploaded anywhere.
- **Files:**
  - new `crates/bloblex-daemon/src/diagnostics.rs`;
  - `main.rs`, the tracing set-up and the RPC routing only;
  - `crates/bloblex-daemon/Cargo.toml` (`tracing-appender`; a zip crate if not present);
  - `apps/desktop/src-tauri/src/lib.rs`, the shell's own log file and the save dialog command only;
  - `apps/desktop/src/remote/tiers.json` (`diagnostics.export` is `never` remote);
  - UI: the Settings row, the profile menu item and the preview dialog;
  - tests.
- **When:** now. It touches only the tracing set-up and routing in `main.rs`, separate from P7 and P8's areas.
