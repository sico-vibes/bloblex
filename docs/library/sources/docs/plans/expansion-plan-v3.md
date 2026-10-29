# Expansion plan v3: the connector

Owner request of 29 October 2026. Bitbots becomes the connector for everything the owner runs: other Claude Code sessions drive it through an MCP, it works the same on a second Windows laptop, and it adopts what T3 Code does better. The research behind this plan is the Haiku comparison of T3 Code and Bitbots (29 October 2026) and the OpenCode 2.2 image-generation review.

Every phase must work in both the **full app** and **companion mode**. Each phase lists what the companion shows.

## Lanes

- **Backend:** Claude Sonnet 5.5 at medium effort. That means the daemon, storage, adapters, `src-tauri` native code, schema, non-visual TypeScript and backend tests.
- **Frontend:** the Director (Claude) does all UI and UX: components, styles, copy, motion, companion, settings and UI tests.
- The backend lane never runs `git commit`. The Director reviews every diff, runs the gates and commits.
- **Phase 0** is built by a Sonnet 5.5 subagent of the Director's Claude Code session.
- **From Phase 1**, the work is assigned through the new MCP to a Sonnet 5.5 (medium) bot inside the owner's running Bitbots app. That bot works in its own git worktree, never in the checkout the running app was built from. The owner confirms before this starts.

## Phase 0: the Bitbots MCP (first, release on its own)

An MCP server that lets a Claude Code session outside Bitbots see and drive the owner's running app.

**What it can do:**

- See bots, projects and conversations.
- Create a bot.
- Start a conversation, optionally in a fresh git worktree.
- Message, steer or stop a bot.
- Wait for a reply.
- Answer approvals.
- Read turn metrics (duration, tools used, tokens where known) to measure performance.

**Design:**

- **Transport:** stdio. Claude Code runs `bitbotsd.exe mcp-server`. It reads an endpoint file the daemon writes when the owner turns the MCP on. The calls go to a separate loopback route with its own token.
- **The daemon capability is never used.** The route is `/rpc` with methods prefixed `ext.`, gated like `outside.hook`.
- **Off by default.** The owner turns it on in Settings › Connections and picks a level:
  - **View**: read only.
  - **Chat**: message, steer, stop and new conversations.
  - **Operator**: also create bots, answer approvals and use worktrees.
- **Token handling:** the token is rotated on every enable and on **Reset access**. Turning the MCP off invalidates the token at once.
- **Owner visibility:** messages sent through the MCP are marked as coming from an outside session, so the owner sees who wrote them, in the full app and the companion.
- **Remote:** the MCP's own methods are never remote (`tiers.json`). The MCP never exposes provider credentials, environment values or the capability.

**Companion:** a bot that is working on an MCP request shows its normal working state. The pill has no extra chrome.

**Done when:** a Claude Code session connects with one `claude mcp add` command, lists the owner's bots, sends "bing" to an OpenCode bot and reads "bong" back. The tools are covered by daemon tests. The release notes give the connect command.

The brief: `docs/history/wave14/mcp-brief.md`.

## Phase 1A: bots across projects (owner decision, 29 October 2026)

A bot is no longer owned by a project. The owner builds a few good bots once, and they work in every project. A bot stays a bot, with its own status. It never becomes a list of threads. Its conversations are grouped by project inside it.

- **Model.**
  - A bot has no required project. Each conversation picks its project, and the bot knows which project a conversation is in.
  - **Migration:** a bot's current project becomes its default for new conversations. Existing conversations keep the project they already carry (`sessions.data.projectId` exists today).
  - A conversation in a git project still gets its own worktree when another conversation is already working there.
- **Sidebar.** It lists bots, with their status, as today. Opening a bot shows its conversations grouped by project, and **New conversation** has a project picker that defaults to the bot's last project.
- **Context.** Each conversation sees both:
  - **the bot's part:** its identity, instructions, skills and what it knows about the owner;
  - **the project's part:** the project's own notes and rules, and a `.bitbots.json` in the repo when there is one.

  Memory is split the same way: a note is either about the bot or the owner, or tied to one project. A note tied to one project never appears in another.
- **Approvals.** **Always allow** offers both scopes: **in this project** or **everywhere for this bot**. The Approvals page shows each rule's scope and lets the owner change it.
- **Manager and team.**
  - The Manager assigns work by project to any bot.
  - `message_blob` and `assign_task` carry the project.
  - Bots may message each other across projects.
- **The MCP** gains a `projectPath` on every conversation tool, and `list_projects` lists the bots that have conversations in each project.

**Companion:** the pill shows the bot and, when it is working, the project name. Its conversation picker groups by project too.

This phase goes before the rest of Phase 1, because the sidebar, memory and approvals work all build on it.

## Phase 1B: from Theo's T3 Code video (filtered for bots, desktop only)

Thread-inbox features (snooze, settle, working sections, bulk settle) and anything mobile are left out: Bitbots has bots with a status, not threads, and the focus is the desktop app.

- **Fan-out and compare:** one prompt to several bots, with the answers side by side.
- **Queue a message to send when a usage limit resets.**
- **Prompt stash:** save a draft, with its images, and move it to another bot or conversation.
- **Annotate a reply:** mark part of a bot's reply and send the note with your next message.
- **Create a new project:** git init, and optionally create the GitHub repo and push, after approval.
- **Report a problem:** a redacted diagnostics bundle and a draft GitHub issue, after approval.
- **Later, with Phase 3:** link PRs to conversations, and a PR list across projects sorted by merge readiness.
- **Later, with Phase 4:**
  - several routes per machine (Tailscale, home network, Native);
  - one update for every machine, after approval;
  - open in VS Code on another machine.

## Phase 1: approvals and settings

- **Approval modes.** `permissions.default_mode` gains **Auto-accept edits** and **Full access**, beside Ask and Auto. Full access is an option the owner chooses, never the default for new installs. The Settings copy says what it allows. Unattended work (automations) still never runs in bypass.
- **Usage-bar credential read becomes opt-in.** Today `quota_sources.rs` reads each CLI's sign-in to show usage bars; that becomes a setting, off by default. An AGENTS.md exception records what it reads, that the credential is never stored or logged, and that the read is only for the usage bar.
- **Useful experiments on by default:**
  - memory;
  - message search;
  - change review;
  - undo;
  - message actions;
  - auto-titles;
  - auto-retry.

  New installs and installs that never touched the switch get them on. A switch the owner turned off stays off.
- **Send shortcut:** choose Enter, Ctrl+Enter or Shift+Enter to send.
- **Keybinding editor** for the app's shortcuts.
- **Per-project settings overrides:** model, approval mode, setup script.
- **Settings compatibility shims:** old keys are read and migrated on read, as the look migration does.
- **Cleanup:** remove the retired Glass entry from `settingsIndex.ts`.

**Companion:** the approval card offers the same choices.

## Phase 2: images from any path

- **OpenCode** (`experimental_image_generate`, on by default from v2.2.2). The ACP adapter reads the tool result's "Saved image: <file>" and emits an image item.
- **Codex.** Map the `image_generation_call` item and the image skill's output to the same image item.
- **Where images are read from.** Generated images may be saved anywhere. The daemon records the exact path announced by the image tool in the session's generated-media list. `media.preview` serves only those exact files: an image type checked by its content, and a size cap. Arbitrary paths stay refused, and the project-folder rule stays for everything else.
- **Prompting.** The composer's "+" menu gains **Generate an image**, which asks the bot to use its own image tool. It is shown only for coding agents that have one.

**Full app:** the image streams into the transcript when it is saved, with open, copy and save actions. **Companion:** a thumbnail in the pill's reply.

## Phase 3: git and review

- **Diff view:** side by side and unified, per file, with stage, revert and comment-to-bot actions.
- **Native PR creation** from a worktree, through `gh` when it is signed in, with a drafted title and body.
- **Abandoned worktree cleanup:** list worktrees whose conversation is gone and offer to remove them, never silently.
- **Worktree setup:** a per-project setup script (install dependencies, copy env files the owner lists) and submodule init.
- **Clone and discover repos:** clone a URL into a projects folder; discover git repos under a folder.
- **File picker and project search:** `@` mentions with fuzzy file search, and content search.

**Companion:** "Changes ready" with a count and the diff opened in the full app.

## Phase 4: machines (Windows only)

Run Bitbots on a second Windows laptop and use it the same way. Linux is out of scope for now.

- **Install and sign-in.** The same installer and updater. A first-run import of a template backup brings the bots, skills and schedules, but no secrets.
- **Machines registry.** Each install has a machine id and name. Pairing two installs reuses Remote: Tailscale or Native, owner approval, tier per device. One app then lists the other machine's bots under that machine's name.
- **Repo identity by Git remote.** A project is identified by its normalized remote URL, so the same repo on two machines is one project. An optional `.bitbots.json` in the repo carries shared project settings: setup script, default bot, approval mode.
- **Connection ownership.** Only one machine runs a given conversation; the other shows it read-only, with **Take over**, which hands off with a note.
- **Handoff between machines:** move a conversation with its handoff note; the worktree branch is pushed first when there is a remote.
- **Channel switch:** stable or beta, per machine.

**Companion:** a machine badge on a bot running elsewhere.

## Phase 5: providers and accounts

- **Account identity per runtime:** which account each CLI is signed in to, shown without reading tokens.
- **Several accounts per provider:** separate CLI config folders, as T3 stacks them.
- **Custom model editor:** add a model id and effort levels a catalog does not list.
- **More providers through ACP:** Gemini CLI, Qwen Code and others that speak ACP.
- **Codex protocol schema** generated and pinned, so a CLI update cannot silently change it.
- **Secret references:** environment values point at the Windows credential store instead of plain text. **One-use secret requests:** a bot asks, and the owner fills a secure form for that one run.

## Phase 6: reach and triggers

- **Phone push:** content-free ("Rae needs you"), through Remote.
- **Webhook triggers:** start a schedule from a signed webhook, only after a threat-model section in `docs/remote/THREAT_MODEL.md`.
- **Terminal:**
  - several tabs;
  - links that open;
  - the bot's commands shown read-only beside the owner's.
- **Sandboxed visual replies:** HTML or SVG a bot returns, rendered in an isolated frame.
- **Sidebar:**
  - sort by recent, name or status;
  - grouping by project;
  - finished conversations settle down the list on their own.

## Phase 7: quality gates

- **CI on GitHub Actions** with the same gates the Director runs locally: typecheck, vitest, cargo test, clippy and builds.
- **Performance gate:**
  - cold start time;
  - snapshot size;
  - a 1,000-message conversation's render time, with budgets that fail the build.

## Order and checks

1. Phase 0, release, owner installs, Director connects and smoke-tests, **owner confirms**.
2. Then, through the MCP, Phases 1 and 2 (they share no files), then 3, 4, 5, 6 and 7. Each phase is a release candidate on its own.
3. Every phase: the gates in `.claude/skills/bitbots-development`, the browser preview for UI in Haze and Stone, dark and light, and the companion. Each phase ends with a live check by the owner and the skill update.
