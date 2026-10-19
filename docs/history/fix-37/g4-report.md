# FIX37 G4 — slash commands in the composer (lane report)

> **What this is:** Lane report for FIX37 G4: slash commands in the composer.
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: OpenCode `opencode-go/deepseek-v4.1-flash` (high), worktree `C:\fx64`
(branch `lane/fix37-g4`), private `CARGO_TARGET_DIR=C:\fxt\d3`. No `git commit`
was run.

Spec: [docs/history/fix-37/g4-slash-commands-spec.md](g4-slash-commands-spec.md).
Read first: `AGENTS.md` headings, `docs/design/design-system.md`,
[docs/history/fix-32/skills-spec.md](../fix-32/skills-spec.md) (the skills pool) and
[docs/history/fix-36/d3-report.md](../fix-36/d3-report.md) (Manager knowledge).

Typing `/` at the start of the composer, or after a space, opens a menu of
**Actions**, **Skills** and **Manager** commands. Actions run in the app and
send nothing; a skill or Manager command attaches to the message as a chip and
travels to the provider as a hidden per-turn directive.

## 1. Daemon

### `session.prompt` accepts `command`

- New module `crates/bloblex-daemon/src/commands.rs`:
  - `directive(st, session_id, &value) -> Result<Option<String>, DispatchError>`
    validates the optional `command` parameter and returns the hidden directive
    (or `None` when none was sent).
  - The parameter is `{ kind: "skill" | "manager", name: string }`.
  - **Skill:** `name` must match `^[a-z0-9][a-z0-9-]{0,63}$` and be switched on
    for the session's bot (the global `skills.enabled` switch and the per-bot
    opt-out; native de-duplication is *not* applied, so an explicit choice still
    works when the coding agent already has the same skill). Unknown or
    switched-off skills are refused with `invalid_argument`.
  - **Manager:** only the Manager's own commands are accepted, and only for a
    session whose bot is the Manager (`systemRole == "manager"`, not archived).
    A Manager command sent to an ordinary bot, or an unknown name, is refused
    with `invalid_argument`.
  - The directive is one of:
    - `<bloblex_command>Load the skill "code-review" with load_skill now and follow it for this message.</bloblex_command>`
    - the Manager command's instruction text (interview, onboard, team, status,
      playbook, remember), inside `<bloblex_command>`.
- `session_prompt_impl` (`main.rs`) computes the directive once, at admission,
  and carries it in `TurnDriver.command_directive`. `run_turn` appends it to the
  provider prompt next to `<bloblex_handover>` / `<bloblex_manager>` /
  `<bloblex_memory>` / `<bloblex_skills>` / references / reply. It is **never**
  part of the stored user message, which keeps the text exactly as typed
  (`/code-review check the parser`).
- The queue carries the command through too: `session.queue.add` validates it
  before queueing, and `queue::allowlisted_params` / `queue::prompt_params`
  copy it so a queued message still delivers the directive when it is sent.

### `skills.forAgent { agentId }`

- New `skills::rpc` arm (`"skills.forAgent"`), added to the daemon dispatch arm
  beside `skills.list`/`skills.get`.
- Returns `{ skills: [{ name, description, source }] }` — the pool rows switched
  on for that bot (the global switch and the per-bot opt-out), so the composer
  can list what it may offer. `agentId` is required (`invalid_argument`
  otherwise).
- Helpers `skills::skills_for_agent` and `skills::usable_for_agent` (both
  `pub(crate)`) make the RPC and the explicit-command check use the same rule.

### Remote tiers

`apps/desktop/src/remote/tiers.json` gains one row:

| method | class | minTier | why |
| --- | --- | --- | --- |
| `skills.forAgent` | read | viewer | Lists the shared skills switched on for one bot, which the composer needs to offer them. |

Sending a command follows `session.prompt`'s existing `chat` tier, so no other
tier changes. The parity test stays green.

## 2. UI

- New `apps/desktop/src/ui/slashCommands.ts`: the command model and pure
  helpers — `slashQuery` (the `/query` at the caret, at the start or after a
  space), `slashItems` (Actions, this bot's Skills, then Manager commands,
  filtered by name/description), `leadingCommand` (a `/name` typed by hand),
  `commandMessage`, and `requestExecutionPicker` (the window event that opens
  the existing model/effort controls).
- New `apps/desktop/src/ui/SlashMenu.tsx`: the menu (group headings, a per-row
  icon, `/name`, a one-line description, an optional keyboard hint on the
  right) and `SlashCommandChip`. It shares the mention picker's geometry
  (`position: absolute; bottom: calc(100% + 8px)`) and never covers the
  composer text. Styles are appended to `ui/composer.css`
  (`.slash-menu`, `.slash-option`, `.slash-chip`).
- `App.tsx`:
  - The main composer: `/` opens the menu, typing filters it, Arrow keys move,
    Enter/Tab picks, Escape closes. The handlers sit beside the existing
    `@mention` and `#conversation` autocompletes; the menu is a separate
    component and the `App.tsx` changes stay in the composer area.
  - Actions run in the app and send nothing: `/plan` (`setPlanMode`), `/new`
    (`newSession`), `/model` and `/effort` (open the existing pickers via the
    `bloblex:exec-picker` window event, handled inside
    `SessionExecutionControls`), `/rename` (the text-prompt dialog +
    `session.rename`), `/export` (`exportConversation(false)`), and `/help`
    (keeps the menu open as the full list).
  - A skill or Manager command becomes a chip at the start of the message. The
    composer holds the rest; on send the message is composed as
    `/name <rest>` and `session.prompt` (or `session.queue.add`) is given
    `command: { kind, name }`. Backspace on an empty composer removes the chip,
    as does the chip's ×.
  - The companion composer (`Companion`) does the same, offering only the
    actions that make sense there (`new`, `model`, `effort`) plus skills and
    Manager commands. `onSendPrompt` gained an optional command.
  - Skills are loaded with `skills.forAgent` for whoever the composer is talking
    to (the selected bot, or the companion's bot).
- `apps/desktop/src/preview/fixtureBridge.ts`: `skills.forAgent` returns the
  fixture pool filtered for the agent, and `session.prompt` validates `command`
  (unknown/switched-off skill and a Manager command to an ordinary bot raise
  `invalid_argument`), so the browser preview works.

## 3. Tests

Rust (`crates/bloblex-daemon/src/main.rs`, `phase2a_tests`):
`a_chosen_skill_or_manager_command_is_a_hidden_per_turn_directive` — a skill
directive reaches the provider prompt but not the stored message; an unknown
skill, a bad kind, a per-bot opt-out and a Manager command sent to an ordinary
bot are all `invalid_argument`; the Manager's own command carries its
instruction and stays Manager-only; `skills.forAgent` lists the pool and
requires an `agentId`.

TypeScript:
- `ui/slashCommands.test.ts` — query detection, grouping and filtering, the
  companion action set, hand-typed commands, message composition.
- `ui/SlashMenu.mounted.test.tsx` — groups and active row, pick/hover, empty
  menu, the chip.
- `ui/App.slash.mounted.test.tsx` — `/` opens the menu and filters; picking an
  action runs it (`session.model.update` with `planMode`) and sends nothing;
  picking a skill shows a chip and sends `session.prompt` with the composed text
  and `command`; Manager commands appear only for the Manager.
- `ui/ComposerControls.mounted.test.tsx` — `/model` and `/effort` open the
  existing model menu and effort popover through the `bloblex:exec-picker`
  event.
- `preview/fixtureBridge.composer.test.ts` — `skills.forAgent` and the
  `command` handling on `session.prompt`.

## 4. Gates

Run in this worktree after the final edit:

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — **all suites ok, 0 failed** (339 in `bloblex-daemon`, 103 in
  `bloblex-storage`, every other binary ok; no `FAILED`, no `panicked`).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` —
  **clean** (`Finished`).
- `cd apps/desktop && npx tsc -b` — **clean**.
- `cd apps/desktop && npx vitest run --maxWorkers=3` — **157 files, 1107 tests
  passed**, no failures.
- `cd apps/desktop && npm run build` — **built** (only the pre-existing
  chunk-size warning).

## 5. Notes / not verified

- **The provider actually honouring the directive is not proven here.** The
  daemon test asserts the `<bloblex_command>` text reaches the adapter prompt;
  whether a given CLI calls `load_skill` when told to is the same open question
  recorded in the FIX32 report.
- **`skills.forAgent` excludes nothing for native copies.** The list is the
  global switch and the per-bot opt-out only, so a skill the coding agent also
  has natively still appears in the composer; picking it is allowed.
- **No keyboard shortcuts are defined for any action yet**, so the menu's
  right-hand hint column renders nothing. The row supports a `shortcut` when one
  is added.
- **The companion offers a reduced action set** (`new`, `model`, `effort`);
  `/plan`, `/rename`, `/export` and `/help` are main-window only, because the
  companion has no plan pill, rename or export surface.
- **UI is my own work this wave** (owner directive for FIX37); the Director
  reviews every diff and runs the gates on the merged result.
