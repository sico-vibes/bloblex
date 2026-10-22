---
name: bitbots-development
description: Develop, fix, review, release and document Bitbots (the Tauri desktop app for coding-agent bots; React/TypeScript UI in apps/desktop, Rust daemon in crates/). Use for any work in this repository - UI and design changes, looks and themes, bot art, settings, daemon RPCs, adapters, tests, the browser preview, releases, docs - and to learn the design language, the codebase map, the gates and the lane workflow. Includes a mandatory procedure to record what you learn back into this skill.
---

# Bitbots development

This skill makes any agent (Claude, Codex Luna/Sol, OpenCode DeepSeek, or another model) productive in the Bitbots repository without re-deriving how it works. Read this file first, then only the reference you need.

**This skill is living.** Every task that teaches something new must end by updating it (see "Keep this skill current" below). A task is not finished until that is done.

## What Bitbots is (one paragraph)

Bitbots is a Windows desktop app (Tauri 2) that runs *bots*: named, styled personas on top of coding-agent CLIs the user already has (Claude Code, Codex, OpenCode). A Rust daemon (`bitbotsd`, crate `bloblex-daemon`) owns sessions, turns, permission decisions, usage and SQLite storage; the desktop shell (`apps/desktop/src-tauri`) owns windows and OS integration; the React UI (`apps/desktop/src`) renders the main window, the floating **companion** and the **dictation** island, all talking to the daemon over a loopback HTTP + WebSocket API guarded by a capability token. A remote gateway inside the daemon (off by default) lets paired phones reach the bots. Internal crate and package names still say `bloblex` (the old product name); the product is **Bitbots**.

## Golden rules (never break these)

1. **Read before you change, and search the past when stuck.** Open `AGENTS.md` (top amendments = how this project is run right now), then the reference file for your area below. The documentation library (`docs/DOCUMENTATION.html`, sources in `docs/library/content/`) explains every subsystem in depth, and `docs/history/` records every past wave; see "When you are stuck" below.
2. **The daemon owns decisions.** Sessions, permission/approval decisions, usage and storage live in the daemon. The UI never fabricates success, usage or prices, and shows unknown as unknown. Budgets are retired: `budget.*` returns `unsupported`, so never claim budget enforcement; unattended work (automations) must bring its own runtime limit, concurrency limit, global pause, and a permission mode that is never bypass.
3. **No copied provider authentication, no scraping the provider's terminal, no raw provider JSON in React, prompts go through stdin/protocol (never shell command text).** The one owner-approved exception is opt-in cloud dictation: it may read the Codex CLI's `auth.json` read-only to call `chatgpt.com/backend-api/transcribe`, with on-device dictation as the default and fallback, matching the accepted request shape only on that path, keeping `originator` and the User-Agent as Bitbots, and never replaying cookies, solving challenges or retrying in loops (`AGENTS.md`, 12 and 14 October amendments). Never log or print credentials, tokens, capability secrets, audio, transcripts or message content.
4. **Design language is law** (see `references/design-language.md`): rounded rectangles like the logo for controls and surfaces in both looks (no pills or circles, except the required circular Manager and locked-bot avatar badges and the look orbs; bot artwork keeps its own shapes), flat surfaces, no glow, no halo, no decorative gradients, plain sentence-case copy, status colour only when something is happening.
5. **Verify where users run it.** The browser preview runs Vite's dev server; the installed app runs the production bundle in WebView2. Some bugs exist only in production (see `references/lessons.md`, FIX42). For anything that loads assets, styles or native APIs, verify the production build or the installed app, not only the preview.
6. **Lanes never commit.** Implementation lanes (Codex, OpenCode) leave changes in their worktree; the Director reviews, runs the gates, commits, merges, releases. Follow the current pipeline in `AGENTS.md` and `references/pipeline.md`.
7. **Run the gates** in `references/verification.md` before calling anything done, and report failures honestly with output.
8. **Never weaken or delete a test to make it pass.** Update a test only when the owner changed the behaviour it pins, and say so.
9. **Short paths for native builds.** The main checkout path contains an apostrophe (`D:\Basem's\...`), which breaks the Windows resource compiler: build or test the desktop crate (`bloblex-desktop`) and make release builds from a worktree or clone at a short path such as `D:\fxNN` or `D:\bNN`.

## How to do a task

1. **Orient.** Read `AGENTS.md`, this file, and the matching reference: UI or design → `design-language.md`; where code lives → `codebase-map.md`; a common change (look, bot art, setting, RPC, page) → `recipes.md`; checking work → `verification.md`; lanes, worktrees, releases → `pipeline.md`; past pitfalls → `lessons.md` (search it for your area first; it saves hours).
2. **Find the real code.** Use `references/codebase-map.md`, then search. Cite `path:line` in notes and reports.
3. **Change the smallest correct thing**, matching the surrounding code style (dense one-line JSX and long lines are normal here; sparse comments; British-neutral sentence-case copy).
4. **Test it**: add or update tests next to the code (`*.test.ts`, `*.mounted.test.tsx`, Rust `#[cfg(test)]`), then run the gates.
5. **Look at it.** UI changes: check the browser preview in every look the change touches (Bitbots/Frost and Blobots, dark and light), and the production build when the change involves styles, assets or loading.
6. **Record it**: update this skill (below), and the docs the change makes stale.

## When you are stuck, search the past first

Bitbots has a long, written history, and most problems have been met before. Whenever something fails in a way you do not understand, a fix does not take, a gate fails for an unclear reason, the preview and the app disagree, or you are about to guess, stop and search before you invent anything:

1. `references/lessons.md` in this skill: known pitfalls with their causes and fixes.
2. The documentation library: open `docs/DOCUMENTATION.html` (or read its sources in `docs/library/content/`) for how the subsystem is meant to work.
3. The wave history: `docs/history/fix-NN/` holds every brief, report, decision and review since the start; search it for the symptom, the file name, the setting key or the error text (for example `rg -n "<error text or symbol>" docs/history docs/reference docs/operations`). `docs/operations/implementation-status.md` and `docs/operations/session-handoff.md` give the latest state, and `docs/history/director-log.md` the reasoning behind past decisions.
4. Git history for the files involved (`git log -p --follow <file>`, `git log -S "<symbol>"`): why the code looks the way it does.

If the answer was there, follow it and say where you found it. If it was not, and you then solve the problem, record it in `references/lessons.md` so the next agent finds it in step 1.

## Keep this skill current (mandatory)

At the end of every task, before you report it done, ask: *did this task teach anything a future agent would need?* If yes, update this skill in the same change. Typical triggers:

| What happened | Where to record it | Form |
|---|---|---|
| You fixed a bug whose cause was not obvious | `references/lessons.md` | A dated entry: symptom, root cause (with evidence), fix, how to avoid it |
| A design decision or visual rule changed (spacing, alignment, a colour, a component's shape, copy wording) | `references/design-language.md` | Edit the rule in place (do not append a contradicting rule); add the date and the owner's wording if given |
| A new pattern, module, setting, RPC, look or art was added | `references/codebase-map.md` and, if it is a repeatable change, `references/recipes.md` | Update the map entry; add or adjust the recipe steps |
| A gate, tool, flag or environment fact changed (toolchain, CLI version, sandbox behaviour) | `references/verification.md` or `references/pipeline.md` | Replace the outdated instruction; note the date |
| The owner set or changed a working rule | `references/pipeline.md` (and `AGENTS.md` if it is a project rule) | Quote the rule and date it |

Rules for updating:
- **Edit, don't pile up.** Search the file first. If an entry covers the topic, update it rather than adding a second one. Remove instructions that are no longer true; history belongs in `docs/history/`, not here.
- **Be concrete and short.** Name files (`path:line` where useful), commands and values. One entry should fit on a screen.
- **Date every lesson** (`YYYY-MM-DD`) and name the commit or branch when known.
- **Keep `SKILL.md` small.** Only change it when a golden rule or the task procedure changes; detail goes in `references/`.
- **Say what you updated** in your final report ("Skill: added lesson X; updated recipe Y").
- If you cannot edit (read-only sandbox), put the proposed skill update in your report so the Director applies it.

## Reference files

- `references/architecture.md`: processes, channels, data flow, and where each responsibility lives.
- `references/codebase-map.md`: directory and file map for the UI, daemon, crates, native shell, preview harness and docs.
- `references/design-language.md`: the design system: looks, tokens, shape and colour rules, bot art, companion, copy.
- `references/recipes.md`: step-by-step changes that recur (add a look, a bot art or painted shape, a settings key, a daemon RPC, a settings page, a preview fixture).
- `references/verification.md`: gates, the browser preview, production checks, inspecting the installed app, flaky-test causes.
- `references/pipeline.md`: the Director and lane workflow, launching Codex and OpenCode lanes, worktrees, cleanup, and the release procedure.
- `references/lessons.md`: dated pitfalls and their fixes (the living log).
