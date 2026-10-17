# FIX37 G4: slash commands in the composer (skills, actions, Manager commands)

Lane: OpenCode `deepseek-v4.1-flash` (high), its own worktree. The owner has asked the lanes to do UI work in this wave. **Never run `git commit`.** Keep context small. Read the section headings of `AGENTS.md`, then `DESIGN.md`, `docs/FIX32_SKILLS_SPEC.md` (skills pool) and `docs/FIX36_D3_REPORT.md` (Manager knowledge). Another lane is changing selection logic in `App.tsx` at the same time: keep your `App.tsx` changes small and in the composer area; put the menu in its own component file.

## What the owner wants

Like Claude Code: typing `/` at the start of the composer (or after a space) opens a menu; typing filters it; arrow keys move, Enter or Tab picks, Escape closes. The menu lists:

1. **Actions** that the app itself performs (no message is sent):
   - `/plan` toggles plan mode for this conversation (the existing plan switch).
   - `/new` starts a new conversation with this bot.
   - `/model` opens the model picker; `/effort` opens the effort picker (the existing composer controls).
   - `/rename` renames this conversation; `/export` exports it as Markdown (existing actions).
   - `/help` shows the list of commands.
2. **Skills** from the shared skills pool that are enabled for this bot (Settings › Skills, per-bot opt-outs). Picking one inserts a chip `/skill-name` in the composer; on send, the bot is told to load that skill for this message.
3. **Manager commands**, shown only when the conversation's bot is the Manager (`systemRole: "manager"`):
   - `/interview`: run (or continue) the personalisation interview with `ask_user` cards and save the answers with `remember_about_user`.
   - `/onboard`: onboard a new or existing project through its interview, then propose the project and a team.
   - `/team`: propose a team (bots) for a chosen project.
   - `/status`: summarise every project's state, open tasks and waiting approvals.
   - `/playbook`: review its own playbook and propose improvements (an `update_playbook` proposal).
   - `/remember`: save what follows the command as a fact about the user.

## Daemon (non-visual part)

- `session.prompt` accepts optional `command: { kind: "skill" | "manager", name: string }`. The user's message is stored and shown as typed (for example `/interview` or `/code-review check the parser`). The daemon adds a **hidden, per-turn directive** to the prompt it sends to the provider (the same suffix mechanism as `<bloblex_skills>` / `<bloblex_manager>`), for example `<bloblex_command>Load the skill "code-review" with load_skill now and follow it for this message.</bloblex_command>`, or the Manager command's instruction text. Unknown or disabled skills, or a Manager command sent to a bot that is not the Manager, are refused with `invalid_argument`.
- Add `skills.forAgent { agentId }` (or reuse an existing method) so the UI can list the skills enabled for a bot, if no such method exists. Every new method or event needs a row in `apps/desktop/src/remote/tiers.json` (the parity test fails otherwise); these are `read`/`viewer` for listing and follow `session.prompt`'s tier for sending.
- Tests in `main.rs`: the directive is in the provider prompt but not in the stored message; a disabled skill and a Manager command to an ordinary bot are refused.

## UI

- New `SlashMenu.tsx` (+ CSS) styled like the existing mention picker (`MentionPicker`) and the command palette: groups "Actions", "Skills", "Manager", each row an icon, the `/name` and a one-line description; the shortcut hint on the right where one exists. Keyboard and mouse as above; it never covers the composer text.
- Wire it into the main window composer (where `@` mentions are handled in `App.tsx`) and the companion composer.
- A picked skill or Manager command shows as a chip at the start of the message (removable with Backspace), like the reply-context strip.
- The preview fixture (`apps/desktop/src/preview/fixtureBridge.ts`) handles the new parameters so the browser preview works.
- Mounted tests: `/` opens the menu, filtering, picking an action runs it without sending, picking a skill sends `command` with the prompt, Manager commands appear only for the Manager.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"` (foreground; wait)
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cd apps/desktop && npx tsc -b && npx vitest run --maxWorkers=3 2>&1 | grep -E "Test Files|Tests |FAIL"` and `npm run build`

Write `docs/FIX37_G4_REPORT.md`.
