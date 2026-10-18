# FIX39 P7 implementation audit (Claude Sonnet 5.5)

**Verdict: FAIL (one blocker, must go back to Sol; the rest are small fixes in the same pass).**

I read the brief, AGENTS.md, the decisions (P7, decisions 3, 5 and 7), the research audit (items 16, 19, 21, 22), the report and the full diff, including the untracked `team_p7_tests.rs`. I did not rerun the gates: the report's numbers (401 daemon tests, 1257 vitest, clippy, build) look consistent with the diff, and the Director runs the full gates after merge.

Most of the package is sound. The Manager gets the full read set, every write is a proposal, locks and Full access are re-checked at approval, ordinary bots are refused per tool, tiers are untouched (`mcp.*` is `never`), nothing is logged, and `main.rs` changes are tests only. The blocker is in how an approved permission change is applied.

## Blocker

### B1. An approved permission change freezes model and effort, and pins permission, on every conversation of the bot
`proposals.rs:729-740` (`sync_bot_permission`), called from `proposals.rs:539` (`apply_permission`) and from `apply_update` (`proposals.rs:700`, `approvalMode`).

For every non-automation session of the bot it calls `conversation_lock_for(.., Some(mode), Some("manager"))` and `set_session_model_lock`. When a session has no lock, `conversation_lock_for` (`main.rs:1497-1507`) builds one from the current options, so it **writes the bot's current `model` and `thinking` into the session's lock**. `exec_options_for_session` (`main.rs:1459-1470`) lets a lock override the bot's model, effort and permission.

Failure scenario:
1. The Manager proposes "ask → auto" for Scout through a side conversation, and the owner approves.
2. Every Scout conversation, including the owner's own main chat with Scout, is now pinned to Scout's *current* model and effort, and to `auto`.
3. The owner then changes Scout's model, effort or permission in the composer (item 16 says these write the bot and reach every later conversation). Those chats ignore it. A Scout chat pinned to `auto` stays at `auto` after the owner sets Full access on the bot.

That is item 16's bug and item 19's bug returning through P7, and it widens the old behaviour (one side conversation) to all of the owner's chats. The test at `team_p7_tests.rs:207-223` only asserts the effective mode becomes `auto`, so it passes while the freeze happens.

Fix:
- The bot's `approvalMode` is the single source of truth. Update the bot (`agent_update`) and **do not create locks**.
- For sessions that **already** have `modelLock.approvalMode`, change or clear only that key, keeping the rest of the lock unchanged. Clearing is the better choice, so those chats follow the bot again. If clearing, remove `approvalModeSource` too.
- Sessions without a lock stay untouched.
- Make the loop not abort half way: a failure on one session must not leave the bot changed and the result an error. Apply the per-session edits best-effort, or compute them all before writing.
- Add tests that fail on the current code:
  - after approval, a chat with no lock has `modelLock` still `null`;
  - changing the bot's model afterwards is picked up by `exec_options_for_session` for that chat;
  - changing the bot's permission afterwards is picked up (this fails today);
  - a chat that already had an `approvalMode` pin follows the bot after approval.

## Findings to fix in the same pass

### F1. `list_blobs` prints a stray `?` and changes the ordinary bots' roster
`team.rs:372`: `line.push_str(&format!(" ? id: {id}"))`. Almost certainly a mangled separator (`·`). It is inside the shared `list_blobs`, so **ordinary bots** also get a roster line with `? id:` in it, while the task says they keep today's tools. Fix: use ` · id: {id}`, or add ids only on the Manager path (`manager_blobs`), and put it after the tags suffix so the line reads in one order. Check that the existing roster assertions in `main.rs` still hold.

### F2. The Manager's `list_conversations` lost the information its own instructions rely on
`team.rs:950` (`manager_conversations`) replaces the text listing with JSON of `id, agentId, title, state, projectPath, updatedAt, link`. The old listing said who started a conversation ("you started it"), the topic, the peer's name and the "Latest reply". The Manager prompt (`team.rs` runtime_instructions, "check `list_conversations`: if one you started with them is about the same subject, continue it") still depends on that, and `continuable` (`team.rs:508`) only accepts conversations the Manager started. The `main.rs:4724` assertion was loosened from the old exact line to `contains(&side) && contains("Check the build") && contains("Release notes")`, which hides the loss.

Fix: add to each row a `startedByYou` boolean (from `link.originSessionId`/`peerAgentId`), the `topic`, the peer bot's name, and a short `latestReply` (clipped, from the last assistant message, no more than a few hundred characters). Restore the strict assertions in `main.rs` against the new fields. Also add `limit`/order tests (the description says newest first, up to 100; nothing checks it).

### F3. Approval notes name opaque ids
`proposals.rs:358-370` (`describe`): `"bot" if update` prints `payload["blob"]`, `"project" if update` prints `payload["project"]`, and `"task"` prints `payload["bot"]`. P7 now stores **ids** there (`validate_update` and `assign_task` bind to ids, with `targetName`/`botName`/`projectName` alongside). `describe` feeds the "Rejected: …" and "Expired: …" notes in the Manager's chat and `knowledge.rs:385,390`, so the owner and the Manager see "update bot 6f3c…" or "assign a task to 9a1e…". Fix: prefer `targetName`, `botName`, `projectName`, falling back to the id. Add a test on `describe`.

### F4. `apply` now needs a live Manager session for every proposal kind
`proposals.rs:384`: `manager_of_session(...)?` runs before the `match`, so it also guards `playbook`, `profile`, `permission`, `project` and `bot` creation. If the Manager's conversation was archived after the card was proposed, an approval of a *create* or *playbook* card now fails with "This conversation is archived" and the proposal is stuck until it expires. That is a behaviour change outside P7. Fix: keep the check only for the new `update`/`open` branches and for `task` (where `apply_task` already does it, `proposals.rs:515`), or say in the report why the stricter rule is wanted and test it. Also confirm `sweep_at` (expiry) does not need the new `proposal_decision` lock; today it does not take it, so an expiry and an approval of the same card can still race. Taking the lock in the sweep's per-proposal step closes that.

### F5. Missing "refusal" tests required by the decisions
Decisions: "One daemon test per tool covers both outcomes: approval needed and a refusal." Not covered in `team_p7_tests.rs`: `list_projects`, `project_status`, `list_conversations` (Manager vs ordinary bot), and `set_conversation_permission` with `bypass` and with an ordinary bot (the second is covered, the first relies on older P5 tests; point at the exact test or add one). Add a small table test that every new tool name is refused for the ordinary bot, built from `manager_tool_schemas()` plus `proposals::tool_schemas()` so a future tool cannot be forgotten.

### F6. Weak or implementation-detail assertions
- `team_p7_tests.rs:118` checks that the prompt contains certain words ("researcher", "free bot", "doneGoal"…). It proves the text exists, not that routing works. It is acceptable as a guard against silent edits but is not evidence of the routing behaviour; the report already says live compliance is not claimed. Keep, but do not count it as proof. The stability half (same instructions and same tool list after tags and projects change) is good and is the part that matters for risk 5.
- `main.rs:4747`: the hop-depth refusal now happens at approval (`proposals::decide`), after the owner has been shown a card that can never succeed. Check the depth when the proposal is created too, and test it.

### F7. Smaller points
- `team.rs:~960-975` (`manager_blobs`): `freeOnly` means "no project", not "not busy" (the description and prompt say "free bot"). The reply carries `busy`, but the Manager is told to pick a "free" researcher, and a busy one may be picked. Rename the flag in the description to say "not tied to a project", or add `notBusy`. Also exclude the Manager itself from the result (it can carry a `researcher` tag and then be offered as the delegate; `validate_task_target` would refuse it later with a confusing message).
- `team.rs:~955` (`manager_conversations`): the project filter compares `projectPath` strings exactly. On Windows a differently cased or slashed path gives an empty result. Compare with the same normalisation the rest of the code uses for paths, or compare by canonical path.
- `apply_update` (`proposals.rs:700`) applies `agent.update` first and `agent_set_team` second: a failure in the second step leaves a half-applied change with an error to the Manager. Do both or neither (validate the team part before writing).
- `ProposalCard.tsx`: the *Edit* button is shown on the *Open a conversation* card although nothing on it is editable. Hide it for `opening`. The create-bot card prints `approvalMode` raw (`ask`/`auto`) while the update card's selector says "Ask first"/"Auto"; use the same labels in both. The look preview colour `#a7f3d0` is hard-coded; fine for a preview, but the Director still has to check the card in both looks and both themes (not verifiable from source).
- Two tool lists in prose (`team.rs` runtime_instructions and `knowledge.rs:348`) repeat the same names; they will drift. The spec asked for `knowledge.rs` to list the tools briefly, so keep that one and have `runtime_instructions` refer to it, or generate both from `manager_tool_schemas()` names.

## Checklist against the brief

1. **Items done as specified.** Yes, with the exceptions above:
   - read tools, project and bot creation with tags, bot editing (all listed fields, never Full access), project tags, start/message/open conversations, permission read/propose, Manager-filled brief/doneGoal/reportBack, routing guidance, proposing a missing bot or project: all present with approval gating;
   - the permission proposal is now **bot-wide** instead of one side conversation (`proposals.rs:539`). The decisions ("read a sub-conversation's permission and propose a change", item 19) and the P5 audit said one conversation. Bot-wide matches item 16 (permissions are per bot) and the card now says so plainly, which is acceptable, but only if B1 is fixed so it does not pin the owner's chats.
2. **Correctness.** B1, F1, F2, F4, F7 (and the Windows path comparison).
3. **Tests prove it.** Mostly behavioural and would fail on the old code (no early write, ordinary-bot refusal, lock before/after, concurrent approvals, archived Manager). Gaps: B1, F2 (loosened), F5, F6.
4. **Scope.** `team.rs`, `proposals.rs`, `knowledge.rs`, `main.rs` (tests only), `ProposalCard.tsx` and its test, the new `team_p7_tests.rs`. All in the package list. `tiers.json` untouched, justified: no new RPC, listener or event, and `mcp.*` is already `never`. `docs/FIX39_AUDIT_IMPL_BRIEF.md` shows as modified in the worktree; it is not part of Sol's package and should not be in the merge.
5. **Security.** No new `tracing` calls, no message, brief, recap or command text in logs. Read results (`read_blob`) use an allowlist that leaves out `customEnv`, credentials and tokens (test at `team_p7_tests.rs:80-94` checks the secret value). `read_conversation` returns up to 30 messages of any non-archived conversation, including other bots' and automation chats, to the Manager's model provider. That is what the decision asks for ("list and read conversations"), so it passes, but it should be said on the release notes. Approvals are not bypassed: edited payloads are re-validated (`bypass` refused), locks are re-checked at approval, and a global decision mutex stops double execution. Full access can never be proposed.
6. **Visual rules.** No sparkle or star icons added (`Pencil`, `ListChecks` only). No new CSS. Both looks and both themes need the Director's visual check on the cards (the look preview uses `BlobCanvas`).

## What Sol should do

1. Fix B1 and add the four tests listed under it.
2. Fix F1 to F4, then F5 and F6.
3. Take the F7 points that are cheap (Manager excluded from `manager_blobs`, `freeOnly` wording, Edit button on the Open card, label consistency); report any it leaves.
4. Rerun the daemon tests, clippy, `tsc -b` and the ProposalCard vitest file, and update `docs/FIX39_P7_REPORT.md` with the changes.
