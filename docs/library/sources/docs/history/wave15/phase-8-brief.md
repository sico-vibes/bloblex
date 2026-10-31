# Brief: Phase 8, sub-bots

Owner, 31 October 2026: "each bot can have a fleet under them", "we keep the full workflow visible for everyone to keep track of their bots and sub-bots". Source: `docs/plans/expansion-plan-v3.md`, Phase 8. The research is the Haiku comparison with T3 Code at commit 79f1fadfc.

**Lanes.**
- **Gogo (Lane X):** section 1, Claude's own sub-agents.
- **Sona (Lane Y):** sections 2 and 3, `spawn_subbots`.
- **The Director:** all front end.

Keep the contract exactly. If something can't work as written, pick the smallest change and say so.

**A sub-bot in one sentence:** a hidden bot row with `parentAgentId`, with its own conversation, started through the existing assignment path, so the ledger, relay, Stop and restart handling already work.

**All new RPCs:** `tiers.json` class `never` except where a section says otherwise. Events `drop`, except where a section says otherwise.

## 1. Claude's own sub-agents (Lane X, `crates/bloblex-adapter-claude`, daemon, storage)

Today `parse_line` emits every frame the same way. So a Task's text lands in the parent's reply, and its tools look like the parent's own. `is_subagent_message` is only used for the model and usage.

- **Tool events:** a frame with `parent_tool_use_id` sets `parentToolCallId` on the tool it starts or finishes. Add an optional field to `AgentEvent::ToolStarted` and `ToolCompleted` (`parent_tool_call_id: Option<String>`). Every other adapter passes `None`. The tool row's stored data gains `parentToolCallId`, and it reaches the window with the rest of the row.
- **Text:** a sub-agent's assistant text must **not** become `AssistantMessage`. Attach it to the parent Task row's `detail.output` (appended, capped as other output is), so a reply only ever holds the bot's own words. If the parent row isn't known, drop nothing: append it to a notice-free buffer on the row when it arrives, or if that's impossible, keep today's behaviour for that frame and say so.
- **Permissions** from a sub-agent still reach the owner exactly as today.
- **Model:** the `Task` row's `detail` gains `subagent: {type, model, description}` from its input, when present.
- **Check a real transcript.** Run one real Claude Code turn that uses the Task tool, with a cheap model, and save a redacted sample as a test fixture. Don't trust field names from memory.
- Don't touch the Codex adapter: native Codex children wait.

**Tests:** `a_subagents_tools_carry_their_parent`, `a_subagents_text_stays_out_of_the_reply`, `a_subagents_text_reaches_its_task_row`, `the_parents_own_tools_have_no_parent`, `a_subagents_permission_still_reaches_the_owner`, `the_task_row_says_which_subagent`, and a fixture test from the real transcript.

## 2. `spawn_subbots` (Lane Y, new `subbots.rs`)

### The bot row

`agents` gains `parent_agent_id`, in new storage file `phase8.rs`. `agent.parentAgentId` is on every read. A sub-bot row:
- `hidden: true`, and left out of `list_blobs`, the Manager's lists, `agent.team`, backups and the Bitbots MCP's `list_bots`.
- `instructions`: the parent's, then the brief's `role` as one sentence.
- `color` and `look`: the parent's.
- `model`, `thinking` and `runtimeId` from the spawn. `approvalMode`: see Limits.
- `accountId` and `envRefs`: the parent's, when the provider is the same; else none.
- Name: the given name or the role, else "`<Parent>` helper N". Unique among the parent's.

### The tools

Bot tools, through the same bridge as `message_blob`. A sub-bot is never offered either one.

**`list_models {}`** → `{models: [{provider, id, name, efforts}]}`, for every signed-in runtime on this machine, from the cached catalog plus custom models. Never polls.

**`spawn_subbots {bots, project}`**, `bots` being 1 to 5 of `{brief, model, thinking, name, role, topic, doneGoal}`:
- `model` is an id, or a word from one, as a person would say it: "haiku" resolves to `claude-haiku-5-5` when exactly one id on this machine contains it, preferring the parent's provider. No match or several: fail with a sentence naming the closest ids. **All or nothing:** check every entry before starting any.
- The provider comes from the model. A sub-bot can run on a different provider than its parent's.
- `project` follows the delegation rules (`delegation_project`, `prepare_worktree_attempt`). The default is the parent conversation's project.
- Each sub-bot goes through the same path as `message_blob`: a side conversation, a ledger row, and the reply relayed to the parent as `[Reply from X]`. Its `link` gains `subbot: true`.
- Reply: `{subbots: [{agentId, name, provider, model, sessionId, delegationId, status}]}`, with `queued` when no slot is free. It returns at once. The parent gets each result later, as it does from a teammate.

### Limits

- **At most 5 running or queued per parent bot, and 20 per parent conversation.** Over either: fail with a sentence and start none.
- **No depth.** A sub-bot's session is never offered the tools, and a call from one is refused.
- **Access:** a sub-bot's mode is its parent conversation's effective mode, never more. `bypass` stays `bypass` only when the parent's own turn is one the owner started. In any unattended parent (automation, task-board run, or a delegated child) the tool is refused with a plain sentence.
- `concurrency.botsAtOnce` still applies. A sub-bot waits for a slot like any assignment.
- **Stop:** stopping the parent's turn stops its sub-bots. `cancel_turn_group` should already reach them through the ledger: test it. Stopping one stops only that one.
- **Restart:** running ones become `interrupted`, as assignments do.
- **Deleting** a parent conversation or bot archives its sub-bots. `agent.purge` of a parent removes them, and it needs the existing confirm.
- A sub-bot's own conversation is messageable by the owner: `session.prompt` on it works, and it's not read-only. Its `[Reply from]` relay only fires for the assignment itself, not for each later message from the owner.

**Tests:** `spawn_starts_each_subbot_through_the_ledger`, `a_person_can_say_haiku`, `an_ambiguous_model_names_the_closest`, `an_unknown_model_starts_nothing`, `it_is_all_or_nothing`, `a_subbot_is_not_a_teammate`, `a_subbot_cannot_spawn`, `five_running_is_the_limit`, `twenty_per_conversation_is_the_limit`, `an_unattended_turn_is_refused`, `a_subbot_never_has_more_access_than_its_parent`, `a_subbot_on_another_provider_starts_there`, `stopping_the_parent_stops_the_fleet`, `stopping_one_leaves_the_others`, `a_restart_interrupts_running_subbots`, `the_result_reaches_the_parent`, `the_owner_can_message_a_subbot`, `subbots_never_travel_in_a_backup`, `deleting_the_parent_archives_them`.

## 3. What the window reads (Lane Y)

- **`subbot.list {sessionId, agentId}`** → `{subbots: [{agentId, parentAgentId, originSessionId, name, role, provider, model, thinking, sessionId, delegationId, status, doingNow, startedAt, finishedAt, error}]}`. Either argument: `sessionId` for the fleet of one conversation, `agentId` for all of a bot's. `status` comes from the ledger.
- `tiers.json`: `subbot.list` is class `read`, `minTier: viewer`, so a phone can see a fleet too. `subbot.changed {parentAgentId, sessionId}` is `allow`, with nothing else in it.
- `agent.list` keeps returning hidden rows as it does, with `parentAgentId`, so the window can leave them off the roster.

## Keeping the lanes apart

Lane X: `crates/bloblex-adapter-claude`, `crates/bloblex-agent-core` (the event), the daemon's tool event arms, and storage for the tool row. Lane Y: `subbots.rs`, `phase8.rs`, `team.rs` (tool list and arm), dispatch arm after `"project.scaffold"`, `tiers.json` after `delegation.list`, `docs/ipc-contract.md` at the end.

## Rules

As in `docs/history/wave15/phase-5-7-brief.md`: never commit, push, merge or switch branches. Change nothing outside your worktree, apart from test folders and your build folder. No `npm install`. `CARGO_TARGET_DIR=C:\bt\<lane letter>`, and delete it when your last chunk is done. Tests in the foreground. `crates/bloblex-storage/src/lib.rs` has one NUL byte: edit it only with your edit tool. Don't edit the skill files. Keep `every_daemon_log_call_site_is_a_fixed_message` true. **Spend as little as you can on real provider turns:** use the cheapest model, and only where the brief asks.

**A test must go through `dispatch`**, or the real tool path, at least once for every new method. Two bugs in the last phase passed their unit tests because a handler was called directly.

## Gates

From PowerShell, with `BITBOTS_HOOK_BRIDGE` and `BITBOTS_REMOTE_WEB_DIR` removed: `$env:RUST_MIN_STACK='33554432'; cargo test --workspace --exclude bloblex-desktop --no-fail-fast`, then `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`.

## Report

Files changed; item by item; every contract change with its reason; new test names and any existing test you changed; exact gate tails; what you could not verify; what the window needs; proposed skill text.
