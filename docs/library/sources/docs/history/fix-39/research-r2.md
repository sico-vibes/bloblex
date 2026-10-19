# FIX39 research R2 — items 16–20

> **What this is:** Research lane R2 for FIX39: items 16 to 20.
> **Status:** historical
> **Last updated:** 2026-10-18

Lane: research R2 (OpenCode `opencode-go/deepseek-v4.1-flash`, high). No code was changed; this is the only file written. No `git commit`. Evidence is from the tree at the time of writing (`main.rs` is large; every `file:line` below was read, not guessed).

Items: 16 composer settings per bot · 17 agent activity readability · 18 Manager multitasking · 19 permissions mid sub-conversation · 20 context lost after restart (with the T3 Code comparison the owner asked for).

---

## 16. Composer settings are per bot, not per conversation

### What the owner sees
With the Manager selected and no conversation open, choosing Auto-approve in the composer fails with the red error `not_found: session not found`. The owner wants permission mode, effort and model chosen in the composer to apply to the bot at once and to every later conversation, with or without a conversation open.

### Evidence
- A bot with no conversation is shown a **local draft session**, never sent to the daemon: `apps/desktop/src/ui/teamSelectors.ts:302` (`DRAFT_SESSION_PREFIX = 'draft:'`), `:305-307` (`isDraftSession`), `:314-323` (`draftSessionFor(agent)` → `id: 'draft:<agentId>'`).
- `App.tsx:543-545` builds `selectedSession` and falls back to `draftSessionFor(activeSelectedAgent)` when no real session matches. That draft is passed straight to both composer controls: `App.tsx:2559` (`<PermissionModeControl session={selectedSession} …>`) and `App.tsx:2562` (`<SessionExecutionControls session={selectedSession} …>`).
- The permission control writes through `session.model.update` with the session id it was given — the draft id: `apps/desktop/src/ui/ComposerControls.tsx:79-87` (`rpc('session.model.update', { sessionId: before.id, approvalMode: next })`). The model/effort/speed control does the same at `apps/desktop/src/ui/SessionExecutionControls.tsx:82-84`, `:101`, `:116`.
- The daemon resolves the id against the sessions table and fails: `crates/bloblex-daemon/src/main.rs:2461` (`session_detail(sid)` → `not_found` "session not found"), reached after `:2457`. The draft row never exists (a real row is only created on the first send, `apps/desktop/src/ui/App.tsx:1801-1806` → `createConversation`, `:1577-1595` → `agent.conversation.create`).
- The control is honest about today's model: `ComposerControls.tsx:108` prints "Applies to this conversation only.", and `ComposerControls.tsx:43-48` (`sessionApprovalMode`) treats a session pin (`modelLock.approvalMode`) as the conversation's own mode, otherwise inheriting the agent's.
- The per-bot write path already exists and takes everything the composer offers: `main.rs:855-877` (`agent.update`, including `model`, `thinking`, `serviceTier`, `approvalMode`, with catalog validation). Effective execution options are rebuilt from the agent plus the session lock per turn: `main.rs:1407-1427`.
- A secondary symptom: with a draft session id, `runtime.models` fails inside `session_detail` (`main.rs:1591`, `map_err(agent_error)` → internal error). It is invisible today only because the boot-time runtime-wide catalog is the cache fallback (`apps/desktop/src/ui/catalogCache.ts:126-145`, `prefetchCatalogs` `:154-163`). `runtime.capabilities` is safe with a missing session (`capability_selected_model` tolerates the error).
- Side-car finding for item 13 (locked bots): the draft path has no lock awareness; `agent.update` will happily change a locked bot unless the lock is enforced in the daemon.

### Causes
1. **Primary:** the composer controls target a *conversation* RPC (`session.model.update`) while the selection can be a *local draft* that has no row; the daemon answers `not_found: session not found`. This is exactly the reported error, for permissions, model and effort alike (they share the same call).
2. **Design:** the composer was built as a per-conversation override (`modelLock`), while the owner wants it to be the bot's setting. Nothing in the composer ever writes `agent.update`.
3. **Minor:** a draft session id is also passed to `runtime.models`, producing a swallowed daemon error.

### Proposed design
Make the composer controls write to the bot when the selection is a draft, and per the owner's wording treat the composer as the bot's setting generally.
- New helper (UI): `composerTarget(session, agent)` returning `{ kind: 'agent', agentId }` when `isDraftSession(session)` or per the answer to Q1 below, else `{ kind: 'session', sessionId }`.
- `apps/desktop/src/ui/ComposerControls.tsx` (`PermissionModeControl.apply`, `:79-93`): when the target is the agent, call `agent.update { agentId, approvalMode: next }`; keep the optimistic update and the rollback; drop the `session.model.update` call. Change the menu note (`:108`) and the aria label (`:96`) from "this conversation" to the bot ("Applies to <Bot> from now on."), unless the mode is pinned to the conversation.
- `apps/desktop/src/ui/SessionExecutionControls.tsx` (`save` `:76-96`, `requestEffort` `:98-102`, `setFast` `:110-122`): same branch. On a draft, `agent.update { agentId, model }` / `{ agentId, thinking }` / `{ agentId, serviceTier }`. The model-change confirmation dialog (`:149`) should say it changes the bot (and that an open conversation may restart its provider context).
- `apps/desktop/src/ui/App.tsx`: pass a target instead of a raw session, or let the controls import `isDraftSession` and read `agent.id`. Stop passing a draft id to `runtime.models`/`runtime.capabilities` (`SessionExecutionControls.tsx:50,57`): omit `sessionId` when it is a draft.
- Effective state comes back through the existing `agent.changed` event into the snapshot, so no extra refresh is needed.
- UI stays within `docs/design/design-system.md`; no new icons.

Tests:
- Unit (UI): `composerTarget` for draft vs real session.
- Mounted (`apps/desktop/src/ui/ComposerControls.mounted.test.tsx`): with a draft session, choosing Auto calls `agent.update` and **not** `session.model.update`; with a real session it keeps today's call. Same pair for `SessionExecutionControls`.
- Daemon (`crates/bloblex-daemon/src/main.rs` tests): `agent.update { approvalMode }` then `exec_options_for_session` for a **new** session returns the new mode; a draft id still returns `not_found` (unchanged contract).
- End-to-end (manual): Manager selected, no conversation → Ask first → Auto-approve shows no error, and the first message opens a conversation already in Auto.

### Size
M. Depends on item 13 (lock enforcement) for correctness once locks ship; independent of 18/19/20.

### Questions for the owner
- **Q1 (product):** with a conversation *open*, should the composer change (a) the bot (and therefore every later conversation, as the feedback says), or (b) only that conversation, keeping the bot's default untouched? **Recommended: (a) write the bot**, and additionally pin the open conversation so the change takes effect in the running chat — with the existing model-change confirmation left in place. (b) would leave the reported failure fixed only in the draft case.

---

## 17. Agent activity is unreadable

### What the owner sees
A turn's "Ran 34 commands · used 21 tools" expands to raw lines: full PowerShell/bash command strings, and bare "Glob", "Read", "Grep" with no target. The owner wants what each step did, on which file or folder, grouped, with the command text available on demand.

### Evidence
- The summary line and counts come from `apps/desktop/src/ui/conversation.ts:157-165` (`activitySummary`) and the grouping at `:124-154`; the panel is `apps/desktop/src/ui/ActivityDetails.tsx:107-118` (`ActivitySummaryLine`) → `:91-104` (`Step`) → `:65-89` (`StepDetail`).
- The step title is `apps/desktop/src/ui/ActivityDetails.tsx:34-46` (`activityTitle`):
  - commands: `:43` returns `detail.command` — the **entire command string**;
  - everything else: `:45` returns `activity.title ?? toolName` — and for Claude that title *is* the tool name (below).
- Category mapping: `conversation.ts:13-14` (`COMMAND_KINDS`, `SEARCH_KINDS`) and `:113-121`. Claude's `Bash` → `bash` → "command"; `Glob`/`Read`/`Grep` → "tool" (they only become "file"/"search" if the daemon labelled them so).
- Root cause in the Claude adapter: `crates/bloblex-adapter-claude/src/lib.rs:565-574` sets `title` to `c["name"]` (e.g. `"Glob"`, `"Read"`, `"Grep"`, `"Bash"`) and `kind` to the same provider tool name; the arguments live in `c["input"]` and are never used for the title.
- The daemon-neutral detail builder is `crates/bloblex-storage/src/lib.rs:5240-5265` (`tool_detail`). It extracts `command`, `output`, `tool`, `input` (pretty JSON of the argument object), `result`, `progress`, `query`, `path` — but not `pattern` (Claude's Glob/Grep), not a labelled target, and it keeps the full command only in `command`. `upsert_tool_in_turn` at `:3784-3826` stores that detail.
- Comparison inside our own tree: the Codex adapter builds a readable title (`crates/bloblex-adapter-codex/src/lib.rs:928-951`: the command text, `Searched: <query>`, `Viewed <path>`, `server · tool`), and ACP/OpenCode trusts the agent's title (`crates/bloblex-adapter-acp/src/lib.rs:914-919`). Claude is the outlier, and it is the runtime the owner tested (CC Haiku).
- The command text is already reachable on demand today: the expanded `StepDetail` shows `Command`/`Input` blocks (`ActivityDetails.tsx:69-87`), and the storage test `crates/bloblex-storage/src/lib.rs:6485` pins the bounded, merged detail. The problem is the collapsed label and the lack of grouping, not the absence of data.

### Causes
1. **Provider title is useless for Claude** (adapter sets the bare tool name; arguments unused) — this makes 21 steps all read "Glob/Read/Grep".
2. **Command steps show the raw command** because `activityTitle` falls back to `detail.command` and there is no short label (head of the command, e.g. `cargo test`, plus a target).
3. **No grouping** inside a turn: a flat `<ol>` of steps (`ActivityDetails.tsx:116`), so a long turn reads as a wall.
4. `tool_detail` does not extract the argument a user would name (Glob/Grep pattern, search path, fetch URL), so even a better title cannot be built from the stored detail for every tool.

### Proposed design
Normalize at the adapter boundary and present in groups; keep the raw text behind one expand.
- Daemon/adapter: add `bloblex_agent_core::tool_activity(kind: &str, raw: &Value, fallback: &str) -> ToolActivity { category, verb, target, label }` (new function in `crates/bloblex-agent-core/src/lib.rs`, next to `permission_summary` `:17`), mapping provider tool names/arguments to `Read <file>`, `Searched "<pattern>"`, `Listed <dir>`, `Ran <command head>`, `Edited <file>`, `Fetched <host>`, `Used <tool>`. Use it in the Claude adapter (`crates/bloblex-adapter-claude/src/lib.rs:570`) so `title` is readable from the start; use it as the fallback in the Codex/ACP adapters so all three converge.
- `crates/bloblex-storage/src/lib.rs:5240` (`tool_detail`): additionally extract `pattern` (`input.pattern`), `filePath` (`input.file_path`/`input.path`), `url` (`input.url`), and a `label` (the head of a command, first ~40 chars of the first line) while keeping `command` untrimmed for the details pane.
- UI `apps/desktop/src/ui/ActivityDetails.tsx`:
  - `activityTitle` (`:34-46`) prefers `detail.label`/`detail.target` (verb + target) and uses `detail.command` only if nothing else exists (then show the command head, not the whole string).
  - Group the steps of one turn by category inside `ActivitySummaryLine` (`:107-118`): subheadings "Commands", "Files read", "Searches", "Edits", "Other"; the collapsed line stays "Ran N commands · used N tools".
  - Keep the raw command/input in `StepDetail` (`:65-89`) exactly as today, so the command text is "available on demand".
- No star/sparkle icons (`docs/design/design-system.md`); reuse the existing `Terminal`/`FileText`/`Globe`/`Wrench` icons (`:56-63`).

Tests:
- Rust unit: `tool_activity` for Claude `Bash`/`Glob`/`Grep`/`Read`/`Edit`, Codex `commandExecution`/`webSearch`, ACP `read`/`execute`; `tool_detail` gains `pattern`/`filePath`/`label` and keeps merging start+completion (`crates/bloblex-storage/src/lib.rs:6485`).
- UI unit: `activityTitle` for a title-less tool with a path/pattern; grouping produces the subheadings and stable ordering.
- Mounted: extend `ActivityDetails.skills.test.ts` + a mounted test that a 3-step turn renders grouped rows and the full command only after expanding.

### Size
M–L (adapter + storage + UI + tests). Independent of the other items; internally splittable into 17a (daemon/adapter/storage) and 17b (UI).

### Questions for the owner
- **Q2 (small product choice):** for a command step, should the collapsed label be the command's first words (`cargo test`) or its purpose when the provider gives one (`Ran the test suite`)? **Recommended: the command's first words**, with the full text one expand away — it is honest and needs no inference.

---

## 18. Manager multitasking: parallel conversations with one bot

### What the owner sees
The friend asked the Manager to run several conversations with the **same bot** at once. One bot-to-bot conversation showed the empty "Ready when you are" screen while the Manager said that bot was running; nothing of its work was visible.

### Evidence
The daemon does allow several sessions for one agent, and the side conversation is created and used correctly — until admission:
- The Manager delegates with `message_blob` / `assign_task` → `crates/bloblex-daemon/src/team.rs:413-462` (`delegate`), which creates the side session with the target bot's workspace (`:449`, `workspace_for` `:329-345`).
- Delivery goes through `deliver` (`team.rs:570-584`): if the session is not busy it calls `session_prompt_for_team`; on a `conflict` it **pushes the message onto `st.team.queued[side_session]` and returns** (`:571-574`, `:577-579`).
- `session_busy` is per session only (`team.rs:307-310`), so a bot busy in *another* conversation does not look busy here.
- Admission then hits the per-agent limit: `crates/bloblex-daemon/src/main.rs:2889-2891` (`create_reserved_turn` false → `conflict` "daemon or agent concurrency limit reached"), and `:2865-2871` (global turns ≥ 4). The per-agent rule is `crates/bloblex-storage/src/lib.rs:3420-3438`: `count >= max_concurrency.clamp(1, 4)` with `max_concurrency` per agent, **default 1** (`insert_agent`, storage; also the agent form field `apps/desktop/src/ui/agentForm.ts:243`). So by default one bot can run exactly one turn at a time.
- Nothing drains the queue for a session that never started: the flush happens in `team::after_turn` for **that** session only (`team.rs:596-626`, `:623-624`). Because the side session never got a turn, `after_turn(side)` never fires, so the delegation is **stranded indefinitely** and the side conversation row stays empty.
- The UI then shows the generic empty state: `apps/desktop/src/ui/App.tsx:2483` (`groupedConversationItems.length === 0 … 'Ready when you are.'`) — exactly the reported screen. Side conversations are surfaced via `apps/desktop/src/ui/teamSelectors.ts:24-28` (`sideSessionsFor`).
- The Manager is told it worked: `team.rs:410` returns "They are working on it; their reply will arrive here…" unconditionally. `list_blobs` does report "whether they are busy" (`team.rs:207`), and the daemon already reports per-agent concurrency (`main.rs:1815`), but the delegation path ignores both.
- Confirmed test seam: `main.rs:7519` (`mark_busy`) and `:7533` prove the queue drains one item per completed turn *of that session* — the model that strands a session which never ran.

### Causes
1. **Per-bot concurrency defaults to 1** (`agents.max_concurrency`), so a second conversation with the same bot cannot start while the first runs.
2. **A delegation blocked by admission is queued against the session that never started**, and nothing else ever drains that queue → permanently invisible work.
3. **The Manager is told the bot is working** even when the turn was only queued, so the user and the Manager disagree with reality.
4. **The UI has no "waiting to start" state** for a delegated conversation; an empty session renders as the bot's empty first-run screen.

### Proposed design
Make parallel conversations with one bot actually start, and make a blocked delegation visible and recoverable.
- Daemon: give team deliveries a durable pending record per **agent** (not per empty session). In `team::deliver` (`team.rs:570-584`) stop queueing against a session that has no turn; instead insert into a per-agent pending list, and drain it in `after_turn` for *any* session of that agent (change the flush at `:623-624` to also consider pending deliveries whose agent now has capacity). This removes the stranding; it is the minimum fix even if concurrency stays 1.
- Concurrency: keep the per-bot setting and the global limit of 4, but (per Q3) raise the default for new bots and/or let a Manager delegation run up to the agent's configured limit. The admission code is already written for it (`main.rs:2889`, storage `:3420`).
- Manager reply: `team::message_blob` (`team.rs:407-411`) and `proposals::apply_task` (`proposals.rs:402-414`) should return whether the turn started or is queued ("CC Haiku is running another conversation; this one is queued next"), so the Manager stops promising work that has not begun.
- UI: mark a delegated conversation that is waiting as such (a `queued`/`waiting` session state or a delegation notice in the session), and change `App.tsx:2483` so a session with a pending delegation never renders the empty "Ready when you are." state; show "Waiting for <Bot> to finish another conversation" plus a working indicator.
- Keep the Activity panel (item 17) as the place to see the work once it starts.

Tests:
- Daemon (`crates/bloblex-daemon/src/team.rs` / `main.rs` tests, fake adapters, temp DB): one agent with `maxConcurrency = 1`, two side sessions — the second is reported queued, starts when the first ends, and both conversations end up with their messages (no stranding). Plus: global limit 4 with four busy sessions → the fifth is queued, not lost.
- Daemon: `message_blob`'s return text distinguishes started vs queued.
- Mounted (`App.emptyConversation.mounted.test.tsx` is the closest existing fixture): a side session with a pending delegation renders the waiting state, not "Ready when you are.".

### Size
M. Depends on item 19 only for the "Manager can change a sub-conversation's permissions" part; otherwise independent. Shares `crates/bloblex-daemon/src/main.rs` and `team.rs` with 19/20 (see packages).

### Questions for the owner
- **Q3 (product):** how many conversations may one bot run at once by default? **Recommended: 2 for a bot the Manager can delegate to (max 3), with the global limit of 4 unchanged**, and the queued state always visible. Keeping 1 is safe but means the Manager must serialise per bot and say so.

---

## 19. Permissions in a running sub-conversation

### What the owner sees
The friend changed the Haiku bot's permissions, but in the bot-to-bot conversation it kept saying it had no permission ("paths still denied after the retry"). A sub-conversation started with Ask first kept it. The owner wants a way to change permissions mid sub-conversation, and the Manager to be able to change it itself (with approval per the Manager rules).

### Evidence
There is no path that can change a sub-conversation's permission mode today, and the "denied" the bot reported has a second, independent cause.
- **The UI offers no control for a side conversation.** `apps/desktop/src/ui/App.tsx:2525` replaces the whole composer (and therefore `PermissionModeControl`, `:2559`) with just a "Close chat" button whenever `sideSession` is set.
- **The RPC refuses during a turn.** `crates/bloblex-daemon/src/main.rs:2458-2460`: `session.model.update` returns `conflict` "model cannot change while a turn is active"; the same call is the only way to set `approvalMode` (`:2493-2497`, `:2525-2559`).
- **Side conversations are read-only for user prompts:** `main.rs:2801` returns `read_only` "Side conversations are read-only…" for any non-`Team` origin. So the user cannot even nudge the bot from there.
- **The Manager has no tool for it**, by design: the Manager tool list is `crates/bloblex-daemon/src/team.rs:206-225`, and `update_blob` explicitly "cannot change a {noun}'s runtime, permission mode or project" (`team.rs:218`). The proposal kinds are project/bot/task/profile (`crates/bloblex-daemon/src/proposals.rs:28`, `validate_task` `:149-156`, `apply_task` `:402-414`); there is no permission kind.
- **Permission is decided from the current agent at request time**, so an *idle* change does take effect on the next turn: `main.rs:3591-3603` builds the decision from `exec_options_for_session` (agent + lock, `:1407-1427`). But a **running provider keeps the mode it was launched with**: Codex is explicitly relaunched when the mode changed (`main.rs:3016-3018`), Claude relaunches inside its own `prompt` when options changed (`crates/bloblex-adapter-claude/src/lib.rs:1137-1165`), and bypass launches announce themselves (`main.rs:2025`, `:2277`).
- **The "paths still denied" cause is the classifier, not the mode.** In `auto`, each path must be inside the conversation's project dir (or the git worktree for reads): `crates/bloblex-agent-core/src/lib.rs:24-121` (`classify_permission`) and `safe_command_path` (rejects out-of-project paths). A delegated bot runs in its own workspace, not the project: `team.rs:449` uses `workspace_for(st, &target)` (`:329-345`), and `proposals::apply_task` **validates** the proposed project but then **ignores it** when delegating (`proposals.rs:402-414` — `payload["project"]` is only checked, `delegate` is called without it). So a task about a project runs in the bot's workspace, and every path in the real project is outside the allowed set — auto still refuses, exactly "still denied after the retry".
- Side sessions do not pin a mode at creation (`resolve_session_model_lock` `main.rs:1466` writes only model/thinking/workflows; `team::attach` `team.rs:170-189` writes instructions/MCP), so an inherited "Ask first" comes from the agent/global default at launch, which matches the report.

### Causes
1. No UI affordance to change permissions in a side conversation (composer removed).
2. No daemon/Manager capability to change a sub-conversation's mode, and the change is refused while a turn is active.
3. A mid-run mode change cannot affect the running provider process except by relaunch; today nothing relaunches for a permission change on a live turn.
4. **Independent of the mode:** a delegated task runs in the bot's workspace, so the `auto` classifier denies project paths — changing "Ask first" to "Auto" cannot fix that, and the bot reports "denied".

### Proposed design
Two changes: a supported way to set the mode, and running delegated work in the right folder.
- Daemon: add `session.permissions.set { sessionId, approvalMode }` (or relax `session.model.update` to accept `approvalMode` alone while a turn runs). It must: work for side sessions; when idle, persist to the session lock exactly as today (`main.rs:2525-2559`); when a turn is active, record the change for the next turn and tell the running provider when the provider supports it (Claude → relaunch on the next prompt, which already exists; Codex → the existing relaunch at `:3018`). Never allow an automation session to leave `auto`/`plan` (`main.rs:2546-2552`).
- Manager: a new tool `set_conversation_permission { conversation, mode }`, proposal-gated as a new kind `"permission"` in `crates/bloblex-daemon/src/proposals.rs` (same shape as `assign_task`, `:149-226`; the card goes through `create_proposal` `:170-192`, so the owner approves it and it is auditable). The Manager may only raise/lower a **side conversation it started**, and never to `bypass` without the owner's approval card.
- UI: keep side conversations read-only for prompts, but put a compact permission pill in the side-conversation header (same `PermissionModeControl` component, `ComposerControls.tsx:56`), showing "Ask first · set by the Manager" when it came from a proposal. Respect the bot lock from item 13.
- Fix the project context: pass the proposed project's path through `apply_task` (`proposals.rs:402-414`) into `team::delegate`/`new_session` so the delegated conversation runs in the project the task names. This is what makes `auto` actually able to touch the project.
- Explain a denial: the permission card and the turn's notice should carry the classifier's category/summary (`bloblex_agent_core::permission_summary`, `lib.rs:17-22`) so "denied" always says *what* and *where*.

Tests:
- Daemon: `session.permissions.set` on an idle side session changes the mode; during a turn it is recorded and applies to the next turn; automation sessions keep `auto`; side conversations still reject user prompts.
- Daemon: `apply_task` with a project starts the side conversation in that project (assert the `projectPath`), and a subsequent `auto` classification allows a project path.
- Daemon: the Manager's permission proposal creates a pending card and applies only on approval.
- Mounted: the side-conversation header renders the permission pill and calls the new RPC.

### Size
M–L. Depends on item 18 for the side-conversation state model and on the Manager proposal plumbing; shares `main.rs`/`team.rs`/`proposals.rs` with 18 and 20.

### Questions for the owner
- **Q4 (product):** when a permission change arrives while a sub-conversation is mid-turn, should it (a) take effect from the next turn (safe, the current turn finishes under the old rules) or (b) cancel/relaunch the running turn so it applies immediately? **Recommended: (a) next turn**, with the card saying so; (b) risks losing the in-flight work exactly like item 20.
- **Q5 (product):** may the Manager set `Full access` on a sub-conversation by itself? **Recommended: no — only Ask first / Auto; Full access stays a proposal the owner must approve explicitly.**

---

## 20. Context lost after a restart (and how T3 Code differs)

### What the owner sees
After an error ("The coding agent took too long. No answer arrived in time.") the friend restarted the app; reopening the same conversation said "Started a fresh session. The agent no longer has earlier context." The owner asks how the same conversation can lose its context, whether our provider integration is the problem, whether T3 Code does it better, and whether we should use ACP.

### Evidence — how our provider integration works today
One provider process per Bitbots conversation, with the provider's own session id stored on the row:
- Claude: the `claude` CLI in `--output-format stream-json`, fresh with `--session-id <uuid>`, resume with `--resume <id>` — `crates/bloblex-adapter-claude/src/lib.rs:754-756` (`assigned_id`), `:794-798`, and `resume_session` `:1094-1125`. A rejected resume is detected from the CLI's result line, `:722-733` ("No conversation found with session ID" → `ResumeRejected`).
- Codex: the `codex app-server`, `thread/start` / `thread/resume` — `crates/bloblex-adapter-codex/src/lib.rs:631`, `:1437-1501`; rejection/timeout mapping at `:704-731`.
- OpenCode: ACP over stdio, `session/new` / `session/load`, gated on the agent advertising `loadSession` (`crates/bloblex-adapter-acp/src/lib.rs:463-467`, `:1032-1095`, `:1097-1167`; OpenCode 1.18.x does advertise it — `docs/evidence/task2-grok-runtime-capabilities.md:279`).
- The daemon decides between resume and a fresh session in `resume_inner` (`crates/bloblex-daemon/src/main.rs:2138-2143`): resume requires `resumable && providerSessionId && session_had_provider_turns`. `note_prompt_delivered` (`:2975-2981`) marks a session resumable after the first delivered prompt.
- If the adapter rejects or fails the resume, `resume_or_start_fresh` starts a **brand-new provider session** and, when the old context had a prompt, writes the notice: `:2041-2110` (fallback, `:2074-2093`), `:2283-2287` (notice), text at `:187` (`ContextChangeReason::FreshSession` → "Started a fresh session. The agent no longer has earlier context."). The message shown by the UI is the timeout copy, `apps/desktop/src/ui/errorCopy.ts:121-126`.
- **The new provider session receives no history.** `NewSessionRequest` carries only `session_id`, `project_path` and `exec_options` (`crates/bloblex-agent-core/src/lib.rs:895-900`); the prompt path builds text from the message plus memory/skills/reference blocks (`main.rs:3095-3117`). Nothing replays the Bitbots messages. So the user keeps the transcript; the agent does not.
- Two paths deliberately lose context: a model change clears the provider id and resets the context (`main.rs:2568`, `:2573`), and a sign-in failure demotes it (`:547-551`). The Manager is the only bot that gets a handover on a model change (`crates/bloblex-daemon/src/knowledge.rs:420-430`, delivered as a one-off `<bloblex_handover>` block appended to the first prompt, `main.rs:3104`, `:3109-3117`).
- The timeout handler kills the provider process and tries to resume it in place (`main.rs:3385-3448`), so a timeout need not lose context — unless that resume fails.
- History of this area: `docs/history/fix-34/a2-fresh-session-spec.md` already removed *spurious* "fresh session" notices (warm-ups of never-used provider sessions). The friend's case had a real delivered turn, so this is a genuine resume failure.

### Evidence — what T3 Code does (github.com/pingdotgg/t3code)
Architecture and provider model, from its own docs:
- It is a server + web/desktop/mobile client over authenticated RPC; provider processes, terminals and files belong to the server, clients never substitute their own machine. Event log is the source of truth with a command/effect worker (`docs/internals/overview.md`). Bitbots' split (daemon owns sessions; Tauri shell is a client) is the same idea.
- **Provider threads are first-class, with explicit coverage.** A thread may contain runs from several providers; each provider has its own native thread id, and the app thread stays canonical. Provider switching is a documented feature with a handoff artifact (`docs/orchestration-v2/provider-switching-and-context.md`, `docs/orchestration-v2/thread-lineage-and-context-transfer.md`).
- **Resume is preferred, and failure has a defined fallback:** "default to resuming that provider's previous provider thread and inject a delta summary … Create a fresh provider thread with a full app-thread summary only when resuming … fails". Handoffs are textual summaries of the app history (user/assistant messages, command executions, file changes, checkpoints; 240 characters per text item) and never claim native parity (`docs/internals/context-handoffs.md`).
- Transports are the same family we use: Claude Code CLI/config, Codex app-server, OpenCode 1.x/2.x server, plus ACP Registry agents (ACP v2 preferred, v1 negotiated) — `docs/user/providers-claude.md`, `docs/user/providers-codex.md`, `docs/user/providers-opencode.md`, `docs/user/providers-acp.md`. ACP is not a better resume mechanism for Claude or Codex, which have no ACP; and their own ACP page says checkpoint rollback starts a fresh agent session because ACP agents cannot rewind.
- Permission modes there are per thread with an environment/project default ("it applies to that thread"; settings default for new threads) — `docs/user/permission-modes.md`. That is relevant to Q1 for item 16.

**Plainly, the difference.** Both projects pin the provider's native session and try to resume it. T3 Code *always* has a fallback that preserves meaning: if native resume fails, it creates a new provider thread and injects a summary of the app's own history, and it records the provider thread/coverage so it can choose delta vs full. Bitbots, when resume fails, starts a fresh provider session and shows a notice — the agent is left knowing nothing, even though the daemon holds the whole conversation. That is the whole of item 20: not the transport, the missing fallback.

### Causes
1. **No context handoff on resume failure** (confirmed, code above). The provider's transcript is external state we do not control; the only durable copy is in our DB, and we never feed it back.
2. **Plausible trigger for the friend's failure:** the turn timed out and the daemon killed the CLI mid-turn (`main.rs:3385-3448`); if the CLI had not persisted that session (or persisted it under a different id), the later `--resume` was rejected and we started fresh. This needs one replay/log to confirm which of: transcript absent, session id drift, or `CLAUDE_CONFIG_DIR`/HOME mismatch. Confidence: mechanism high, specific trigger medium.
3. **Same class of loss happens by design on a model change** for every non-Manager bot (`main.rs:2568`): no handover, so the next prompt has no idea what happened before.
4. **The failure is under-reported:** the notice says context is gone but not why, and the UI's model-change/session copy does not offer a way to continue with a recap.

### Proposed design
Adopt T3 Code's *fallback*, not its whole graph model, and keep our transports.
- On any fallback where `previous_had_turns` is true (`main.rs:2210-2224`, `:2283`), arm a one-off **recap** for the next prompt, built from the daemon's own history: the last N user/assistant messages (clipped), the files changed, the commands run, and any plan/todo state. Deliver it exactly like the Manager handover: a `<bloblex_recap>` block appended to the first prompt only, never persisted (`knowledge.rs:434-445`, `main.rs:3104`, `:3109-3117`). Store the fact it was queued (session data flag + a `session.recap.armed`-style event) so it is auditable.
- Arm the same recap for non-Manager bots after a model change (`main.rs:2568-2580`), replacing the silent reset; keep the Manager's richer handover as-is.
- Change the notice/copy: "This conversation's provider session expired, so the agent was given a summary of the conversation." Keep "no longer has earlier context" only when there was nothing to summarise.
- Surface the resume failure where the owner can see it (`session.resume_rejected` already exists, `main.rs:2085-2092`; render its `outcomeNote`), so a repeated failure is diagnosable rather than mysterious.
- **Do not switch to ACP.** Our Claude and Codex integrations are the same native transports T3 Code uses; ACP is only for OpenCode (where we already use it) and for third-party agents. ACP would not add resumability for Claude/Codex, and T3's own ACP notes say ACP agents cannot rewind.
- Later (L, not FIX39): T3's provider-thread/coverage model with delta handoffs (`thread-lineage-and-context-transfer.md`) if the owner wants provider switching or forks. The single-conversation recap above gets the felt benefit for much less.

Tests:
- Daemon (fake adapter that rejects resume): a conversation with a delivered turn whose resume is rejected → the next prompt text contains `<bloblex_recap>` with the last messages/files, the block is not persisted, and the notice says the agent was given a summary. A never-prompted (warm-up) session still announces nothing.
- Daemon: model change on a non-Manager bot arms the recap; the Manager keeps its `<bloblex_handover>`.
- UI: the notice copy and the resume-rejection `outcomeNote` render in the conversation.
- Manual replay (owed evidence): reproduce the timeout, restart, and capture the daemon event for the resume attempt, to pin the underlying cause in `crates/bloblex-adapter-claude` (transcript absent vs id drift).

### Size
M for the recap + model-change coverage; L if the full provider-thread/coverage model is adopted. Depends on item 19 only for the ticket wording around "the agent forgot the permission change"; shares `main.rs`/`knowledge.rs` with 18/19.

### Questions for the owner
- **Q6 (product):** is a *summarised* recovery acceptable (the agent gets a recap, not the bytes of every message)? **Recommended: yes** — it is what T3 Code does, and it is the only way to survive a provider transcript we do not own.

---

## Implementation packages

Grouped so separate lanes can run in parallel where files do not collide. `crates/bloblex-daemon/src/main.rs` is touched by P4, P5 and P6: those three must either run in sequence or be split by function and merged carefully.

- **P1 — composer is the bot's setting (item 16).** Files: `apps/desktop/src/ui/ComposerControls.tsx`, `apps/desktop/src/ui/SessionExecutionControls.tsx`, `apps/desktop/src/ui/App.tsx`, `apps/desktop/src/ui/teamSelectors.ts`, tests in `apps/desktop/src/ui/ComposerControls.mounted.test.tsx` / `SessionExecutionControls.mounted.test.tsx`. Independent; needs Q1 answered. Blocks nothing.
- **P2 — readable activity, daemon side (item 17a).** Files: `crates/bloblex-agent-core/src/lib.rs` (new `tool_activity`), `crates/bloblex-storage/src/lib.rs` (`tool_detail`, `:5240`), `crates/bloblex-adapter-claude/src/lib.rs`, `crates/bloblex-adapter-codex/src/lib.rs`, `crates/bloblex-adapter-acp/src/lib.rs`, plus their tests. Run before P3.
- **P3 — readable activity, UI side (item 17b).** Files: `apps/desktop/src/ui/conversation.ts`, `apps/desktop/src/ui/ActivityDetails.tsx`, `ActivityDetails.skills.test.ts` + a new mounted test. Needs P2's detail fields to exist; can start in parallel if the field names are frozen first.
- **P4 — Manager multitasking (item 18).** Files: `crates/bloblex-daemon/src/team.rs` (`deliver`, `after_turn`, `message_blob`), `crates/bloblex-daemon/src/main.rs` (admission/reporting, tests), `crates/bloblex-storage/src/lib.rs` (pending-delivery record if stored), `apps/desktop/src/ui/App.tsx` + `teamSelectors.ts` (waiting state). Needs Q3.
- **P5 — permissions mid sub-conversation (item 19).** Files: `crates/bloblex-daemon/src/main.rs` (`session.permissions.set`, prompt path), `crates/bloblex-daemon/src/team.rs` (Manager tool), `crates/bloblex-daemon/src/proposals.rs` (new `permission` kind; project passed through `apply_task`), `crates/bloblex-agent-core/src/lib.rs` (denial summary), `apps/desktop/src/ui/ComposerControls.tsx` + `App.tsx` (side header pill), tests. Needs Q4/Q5. Run after or interleaved with P4.
- **P6 — context recovery after a failed resume (item 20).** Files: `crates/bloblex-daemon/src/main.rs` (arm the recap on fallback and model change), `crates/bloblex-daemon/src/knowledge.rs` (recap builder beside the handover), `crates/bloblex-storage/src/lib.rs` (session flag), notice copy in `apps/desktop/src/ui/` (`errorCopy.ts`/conversation notices), tests. Independent of P4/P5 in logic but shares `main.rs`; sequence it or split by function.

Suggested order for a single lane: P1 → P2 → P3 → P6 → P4 → P5 (P6 first among the daemon ones because it changes only the resume/model-change paths, the smallest shared-file footprint).
