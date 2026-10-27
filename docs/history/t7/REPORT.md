# T7 wave report (27 October 2026): T3 review round 2, model switching, conversations, assignments, resilience

Owner request: review T3 Code again (checkout `220eb735`) and implement what is valuable for composer UX, model selection and switching, several conversations per bot, bot-to-bot awareness, Manager assignment, and backend resilience and performance. No more connectors. **Owner rule for the wave: no tests, no screenshots, no probes, no UI sweeps, no test-target compilation, no test edits.** Nothing here was run in the app.

## Lanes

| Lane | Worktree | Work | Brief and report |
|---|---|---|---|
| Director (Claude) | main checkout | all UI, review, integration, docs, skill | this file |
| OpenCode `opencode-go/deepseek-v4.1-flash#high` U1 | `D:\u1` | honest model switching, atomic model write, stale-update refusal, idempotent `session.prompt` / `session.queue.add` | `brief-u1-model-and-commands.md`, `report-u1-model-and-commands.md` |
| OpenCode U2 | `D:\u2` | review and hardening of the unmerged `D:\t6` question-race patch, native question links, assignment dedupe, availability, queue reason, wake and stop semantics | `brief-u2-delegation-questions.md`, `report-u2-delegation-questions.md` (t6 itself: `brief-t6-question-race.md`, `report-t6-question-race-reviewed.md`) |
| OpenCode U3 | `D:\u3` | restart truth, ambiguous queued sends, orphaned cards, hot reads | `brief-u3-restart-and-reads.md`, `report-u3-restart-and-reads.md` |

No lane ran a test, a test-target build or a git write (their logs were searched for `cargo test`, `--tests`, clippy, vitest, `npm test` and git writes; only read-only `git status/log/branch --show-current/stash list` appear). Briefs were written from the actual Bitbots code, with T3's `ProviderSessionTransitionPolicy.ts` (apply-on-next-turn / restart-and-resume / create-with-handoff / reject) and `CommandReceiptStore.ts` (idempotent commands) as the reference ideas. No T3 file was copied.

## D:\t6 (unmerged question-race lane), reviewed independently

Its four-file patch applied cleanly to the baseline and was given to U2 as the starting point; nothing in it had been run by anyone. Review found one real defect, which U2 confirmed by tracing and fixed: the guard at the top of `delegations::after_turn` returned `Waiting` whenever any other turn of the conversation was live, so a failure of assignment A was dropped when B's brief or a retry had just started, and the Manager never heard. It now waits only when the live turn is the answer to this assignment's own question (`answer_continues_row`). Also fixed: a late `adopt` could move an assignment back to an older turn; a card stuck `resolving` held its assignment for ever (now ages out after 2 minutes); an answer that could not be delivered or whose queue item was deleted could hold its assignment (cleared at once, or by a sweep after 2 minutes); native provider question cards (Claude, Codex) were unlinked and never woke the Manager (now linked and woken); `retry_dropped` missed an assignment whose turn had moved on (rows keep `turn_ids`). t6 is integrated; its worktree and branch are untouched.

## What changed

### Model selection and switching
- **Capability-aware.** `AgentAdapter::model_switch()` (`KeepsSession` or `NewSession`, default `NewSession`). Codex, Claude and ACP/OpenCode declare `KeepsSession`, each with the proving `file:line` in a comment (Codex sends `model` in every `turn/start`; Claude's `prompt()` restarts with `--resume` and the new `--model`; ACP selects the model option before each prompt and refuses instead of prompting). The daemon used to clear the provider session and demand confirmation for every provider.
- **`session.model.plan`** (read-only, allowed during a turn): `continuity` kept / recap / none, one provider-specific sentence, `busy`, `locked`, `contextAtRisk`. `update_session_model` uses the same facts so they cannot disagree. On `KeepsSession` nothing is cleared, no reset event, no recap, no confirmation; the next prompt carries the model. On `NewSession` the old behaviour (confirmation, reset, recap or Manager handover) is unchanged.
- **Atomic and not stale.** The lock write and provider-id clear are one transaction (`session_apply_model_change`); `expectedModel` makes a choice made against a changed model a `conflict` before anything is written; a repeated identical request writes nothing.
- **Composer.** The picker asks the plan first and shows the dialog only for a fresh session, with the daemon's sentence and what stays. The pill describes the model and effort that apply from the next message, stays focusable during a turn and says when it can change, shows a retry when the catalog is missing, and the menu says the choice is per conversation and also the default for new ones. A failure writing the bot's default no longer turns a successful change into an error. Drafts, attachments, history and project are never touched by this flow.
- Queued prompts read the lock when they are sent (verified in `queue.rs` and `exec_options_for_session`), so they run on the model chosen later.

### Conversations
`ConversationsPanel`: a labelled *New chat* button, a filter field above 7 conversations (matching titles keep their branches), *Needs you* and *Failed* flags in place of the time. Opening, renaming, archiving, deleting and the side-conversation branches already existed and are unchanged. Drafts and pending work keep routing by conversation id (`draftStore`); the new `clientMessageId` is kept in each pending row.

### Idempotent sends
`session.prompt` and `session.queue.add` accept `clientMessageId`. A replay returns the original `turnId` with `deduplicated:true` and starts no second turn (checked under the per-session gate, before the active-turn refusal, and again inside the admission gate); a different text under one id is a `conflict`. The key is stored with the message (`meta.clientMessageId`, indexed). The UI makes one id per message and Retry reuses it. `session.steer` is not made idempotent on purpose. **This is at-most-once per id while the message row exists, not a claim of exactly-once delivery.**

### Composer
Steer or queue is an explicit choice (*Steer now* / *After this turn*) beside *Stop and send instead*; the placeholder and send glyph follow it; typing stays possible while an approval waits (the message queues); a runtime that is not ready says so; the Manager's empty chat tells the owner to type @ to name a bot. No reserved blank row and no second attach button were added.

### Assignments (Manager) and bot-to-bot
Per-assignment questions and holds (t6 plus U2). Duplicate `message_blob` calls in one Manager turn are one assignment (`dedupe_key`, key = Manager turn + target + brief hash; no time window, so a later Manager turn can send again). The Manager gets a specific refusal for an archived, hidden, locked or runtime-less target. `queueReason` (`busy`, `slots`) is on the row and shown as *Queued · bot is busy* / *Queued · no free slot*. Cancelling a queued assignment or one whose turn already ended now relays its reply once, and a restart that interrupts an assignment leaves a content-free note in the Manager's chat. Stop is scoped to the exact assignment (verified in `cancel_row`). Approval rules are unchanged; the Manager cannot answer or approve.

### Self-healing and performance
- A queued send that was `sending` at a crash is `failed` with `ambiguous:true` and a plain sentence; it is never replayed automatically, and resending or editing it needs `confirmResend:true` (the queue row asks *Send it again?*).
- Boot recovery closes only native approval and question cards, emits `permission.resolved` with `reason:"daemon_restarted"` and writes one note per conversation; `mcp:` questions and proposal cards stay answerable (before, a restart silently expired a pending proposal's card while its row stayed pending). A session left `retrying` with no retry item goes to `idle`; automation sessions no longer get a continuation flag that cannot fire.
- Hot reads: indexes on `app_events(event_type,sequence)`, `messages(session_id,role)`, `projects(path)`, `permission_requests` by `delegationId`, `delegations(side_session_id,side_turn_id)`; `session_brief` replaces `session_detail` in the queue RPCs, the retry hook and `team::after_turn` (a turn end no longer loads the whole conversation).

## Validation that ran (production only)
- Each lane: `cargo check -p bloblex-daemon -p bloblex-storage` (clean, no warnings); the three patches were combined in `D:\u2` and checked there with `-p bloblex-daemon -p bloblex-storage`, then the combined patch was applied to the main checkout and `cargo check -p bloblex-daemon -p bloblex-storage -p bloblex-agent-core -p bloblex-adapter-claude -p bloblex-adapter-codex -p bloblex-adapter-acp` was run (target dir `D:\u2\target`, so the main `target` was not touched): clean. `team::after_turn` was changed afterwards and `cargo check -p bloblex-daemon` re-run: clean.
- UI: production-only `tsc` (a temporary config that extends the real one and excludes every test file; removed afterwards) clean after the last edit; `npx vite build` to a temp directory clean. The desktop crate (`bloblex-desktop`) was not built: no native code changed in this wave.
- `git apply --check` for every patch against the main checkout.
- **Not run: every test, every screenshot, the app, a real provider, a phone.**

## Known stale tests and unverified behaviour
- **Stale test (not edited, per the owner rule):** `session_delete_cascades_the_prompt_queue_and_restart_fails_interrupted_sends` in `crates/bloblex-storage/src/lib.rs` pins the old boot error text. It must assert `QUEUE_AMBIGUOUS_ERROR` and `ambiguous == true`.
- Tests that reference changed code are listed in each lane report. A mounted App test may pin the textarea being disabled during `waiting_permission`. `ComposerStatus` tests render it without the new optional props (still valid). `delegation_create` and `delegations::record` changed their return type to `(row, created)`; a search found no test that calls either directly, only `team.rs` and `delegations.rs`. Test targets were not compiled, so any other compile break is unknown.
- Every `KeepsSession` claim rests on reading the adapters, not on a run against Claude, Codex or OpenCode. If a provider refuses a model change on the next prompt, the existing turn error surfaces (no silent fallback to another model or a fresh session), and the owner can switch back.
- The layout of the new composer pieces (mode choice, ambiguous confirm, filter field, flags) has not been seen.

## Open gaps (stated, not closed)
1. The Manager wake for a child's pending request is claimed durably but delivered through the in-memory team queue; a restart between the claim and the delivery loses the wake (the request itself stays visible).
2. `cancel_row` checks the live turn and then cancels it in two steps; a turn change in the microseconds between could cancel another assignment's turn. Closing it needs a generation-checked cancel.
3. `app.snapshot` still ships every message of every conversation; the real fix is a lazy per-conversation load in the window (a contract change).
4. Errors from `session_prompt` after the prompt may have been written are still stored as definitive queue failures (no `accepted_turns` signal is used yet).
5. A `limited` session whose `recovery_count` is exhausted keeps a stale `limitedUntil` and is re-queried every second; it needs an owner-facing wording.
6. An interrupted assignment produces a note, not a `[Reply from X]`; one line in `notice_interrupted` changes that if wanted.
7. No global "pause all delegation" exists (only `automations.paused`), so none is enforced for Manager assignments.

## Preview and merge state
- **Source merged into the main working tree** (uncommitted, on top of the owner's dirty baseline; nothing committed, reset, stashed or deleted). `D:\t6` is still its own unmerged branch; its patch is now part of the main tree through U2.
- **The running `D:\hz1` preview has the new UI (hot-copied: its ten files matched the baseline byte for byte), not the new backend.** The daemon there is the old build, so the new behaviour that needs it (`session.model.plan` and the keep-session switch, `clientMessageId` de-duplication, `queueReason`, ambiguous sends, restart recovery) will not appear until that preview's daemon is rebuilt and the dev shell restarted. Against the old daemon the UI falls back safely: the plan call fails and the old confirmation dialog is used; the extra parameters are ignored. I did not restart anything.
- `tiers.json` gained a `session.model.plan` row (`never`); it was not copied to `D:\hz1` because only a rebuilt daemon reads it.
