# FIX39 P6 audit (Claude Sonnet 5.5)

> **What this is:** Audit of FIX39 package P6 by Claude Sonnet 5.5.
> **Status:** historical
> **Last updated:** 2026-10-18

**Verdict: PASS WITH FIXES.** Items 18, 20, 21, 19.4 and 19.5 are implemented as specified and the owner's decision 1 (no per-bot cap, global "Bots working at once" only) is followed literally. Three small correctness bugs in the new queue and notice code, one risk-7 gap on the approval card, and a few missing tests must be fixed before merge. I did not re-run the gates: the report's results look credible and the findings below are from reading the code.

Scope read: `AGENTS.md`, `docs/history/fix-39/decisions.md`, `docs/history/fix-39/research-audit.md` (P6, items 18–21, risks 3, 5, 6, 7), `docs/history/fix-39/p6-report.md`, and the full diff (16 modified files plus the new `TeamSidebar.tags.mounted.test.tsx`).

## What checks out

- **Item 18.** `create_reserved_turn` (`storage/lib.rs:3498`) lost the per-bot check and takes the global limit; `session_prompt_impl` (`main.rs:2995`) enforces the same limit on `active_turns`. The setting is validated (1–16), allowlisted and defaulted to 4. `runtime.capabilities` and `BlobSettings.concurrencyText` stop claiming a per-bot cap. The drain is global (`team.rs:677`, called from `after_turn`). The Manager is told "started" or "queued" (`team.rs:456`, `proposals.rs:449`). No provider-specific cap was needed and none is claimed.
- **Item 20.** Armed on the resume-fallback path (`main.rs:2363`), the adapter `FreshSession` path (`main.rs:3922`) and a Manager-less model change. Only the boolean `recapPending` is persisted. The block is built from the DB, bounded (8 messages × 600 chars, 12 paths, 6 000 chars), escaped with `<`/`>`/`&`, appended to one prompt and cleared when read. I found no `tracing`, event or Remote payload that carries recap text. `meta.kind` stays `context_reset`, so the item 15 preview filter keeps working. `runtime_instructions` is untouched, so tags cannot change the Codex instruction hash (risk 5): the deviation is right.
- **Item 21.** Columns added idempotently for `agents` and `projects`; the migration test drops both columns and reopens, which proves an old database opens. Validation is correct. Tags show in `list_projects`, `list_blobs` and `project_status`. `update_project` is Manager-only and an ordinary bot is refused. A locked bot refuses tag changes through the Manager (`update_blob` lock check, `team.rs:398`) and through the owner path (`team.rs:834`). The tag editor, menu entries and chips are fine, and the locked entry is disabled.
- **Item 19.4 / 19.5.** `apply_task` resolves the project folder and `delegate` uses it only if it is an existing directory, otherwise the bot's own workspace. `permission_summary` now returns category plus target, truncated to 120 chars as before.
- **Security.** No new daemon RPC or event, so no `tiers.json` row is owed: the new `update_project` is a bridge tool, not a dispatch method. `settings.set` stays `never` remote. Approvals are not bypassed. Task approval still goes through the proposal card.
- **Visual.** The new icon is `Tag`; no sparkle/star. Tag and dialog CSS use tokens only, so both themes work.

## Findings (Sol: fix these)

### 1. Retrying a refused delivery reorders the queue and stacks "Waiting for…" notices — `team.rs:635-650`, `:652-668`, `:677-688`
`deliver`'s conflict branch used to `push_front` the item back. It now calls `queue_delivery`, which does `push_back` and writes a notice whenever the queue was empty before the push.
- **Order:** queue `[A, B]` for one side conversation. The drain pops A, `deliver` hits the global limit (`conflict`), and A is pushed to the back: `[B, A]`. Messages are now delivered out of order.
- **Duplicate notice:** the drain pops the only item, so the queue is empty. When the global limit still refuses, `queue_delivery` sees `was_empty == true` and writes a second "Waiting for X to finish another conversation." Each failed drain adds one more. The comment on the function says this does not happen; it does.
- **Fix:** keep the original two-way behaviour. The conflict branch re-inserts at the front with no notice (give `queue_delivery` a `front: bool` or split a small `requeue_front` helper). Write the notice only from the first arrival (the `session_busy` branch and the first conflict), not from a retry. A simple guard is to skip the notice when the session's last message is already the `state: "queued"` notice.
- **Tests to add (they fail today):** (a) two queued items on one session with the global limit full: after a refused drain the order is still `[A, B]`; (b) after two refused drains the transcript holds exactly one queued notice.

### 2. The "Waiting for…" notice is also written into the *origin's* conversation for queued replies — `team.rs:718` via `queue_delivery`
`deliver` is also how a side reply is relayed back to the sender (`team.rs:718`, `meta.kind = "blob_reply"`). When the origin (often the Manager's main conversation) is mid-turn, `queue_delivery` writes "Waiting for <Manager> to finish another conversation." into that main conversation. That is wrong: nothing new is waiting, a reply is, and the text names the Manager in the Manager's own chat.
- **Fix:** write the notice only when `meta["kind"] == "blob_message"` (a forward delegation into a side conversation). Replies keep silent queuing.
- **Test:** a `blob_reply` delivery to a busy session adds no notice.

### 3. A model change on a never-prompted non-Manager conversation now writes a "no longer has earlier context" notice — `knowledge.rs:425-428`, `:104-113`
`announce_model_change` now routes every non-Manager to `announce_context_loss`, whose `else` branch writes the plain notice even with no history. Before this change a non-Manager model change was silent. A conversation that was never prompted becomes non-empty (the "Ready when you are" screen disappears, the sidebar preview changes) for a loss that did not happen. `main.rs:2670` calls it on every `model_changed`.
- **Fix:** in `announce_model_change`'s non-Manager branch, call `announce_context_loss` only when `session_has_conversation_history` is true; otherwise stay silent. (The two fallback paths already guard on `previous_had_turns`, which is why they are fine.)
- **Test:** a model change on a non-Manager session with no messages writes no notice and arms nothing. The existing `row_a_model_change_arms_a_recap_for_a_non_manager_bot` only covers the case with history.

### 4. The task card's folder line can show "—" when the daemon will in fact use a project — `ProposalCard.tsx:127`
The daemon (`proposals.rs:449`) matches the project by id or case-insensitive trimmed name. The card matches by exact `project.name`. A draft whose `project` is an id, differs in case, or has stray spaces shows "—" while the delegated bot still runs in that project's folder and can write there. That defeats the purpose of risk 7.
- **Fix:** resolve it the same way (id, or `trim().toLowerCase()` of the name). If the project is named but not found, show a plain "Project not found" instead of "—" (the daemon will refuse it anyway).
- **Test:** add a mounted/unit test for the card: the folder line shows the path for an exact name, a differently cased name and an id, and is absent when no project is named. None exists today for this line.

### 5. Missing coverage and one unreported gap (small)
- No test covers the **retry-while-full** path of the drain (finding 1 would have been caught by it); `row_a_finished_turn_drains_another_conversations_queue` only proves the cross-session release when a slot is free.
- No UI test for the **waiting indicator** (`App.tsx:2524`) or the **empty state being skipped** (`App.tsx:2486`), and none for the **Settings › General "Bots working at once"** row. `isWaitingDelegation` is unit-tested, which is a start. Add one mounted assertion each, or say in the report that the Director verifies them by eye.
- The research audit (item 18) recommended handling the in-memory `st.team.queued` after a restart (a side conversation that shows a waiting notice but has no turn). P6 does not do this and the report does not say so. Either implement the `relay_failure` startup pass or state the gap in the report so the Director can decide.

## Notes (no action required)
- Agent export and duplicate do not carry `tags` (`insert_agent` ignores them). Acceptable for this package; worth one line in the docs.
- The recap includes the just-stored current user message as the last "User:" line, so it appears twice in the first prompt. Harmless and bounded.
- `TagEditor` calls `rpc` directly instead of going through the `actions` object like every other sidebar mutation. It works and is tested, but is a pattern break in a hot file.
- `fmt --check` is dirty at baseline, as the report says; the new code follows the file style.

## Scope
Files outside the listed set are all justified in the report (`SettingsSheet.tsx`/`settingsIndex.ts` for the setting row, `BlobSettings.tsx` for the stale cap text, `ProposalCard.tsx` for risk 7, `agent-core/lib.rs` for 19.5). `App.tsx` is touched only for the empty state and the indicator. `tiers.json` is correctly unchanged.


## Re-check (Sonnet), verbatim

The auditor re-checked the follow-up and replied:

PASS

All five findings are fixed, and I found no remaining must-fix items. I read the code and tests only; I did not re-run the gates.

- **Finding 1:** `deliver` now takes a `retry` flag (`team.rs:650`). A retried item that is refused again goes back to the front through `requeue_front` (`team.rs:700`) with no notice. This covers both the global-limit conflict branch and the `session_busy` branch. A first arrival still queues at the back. Two tests cover it: `row_a_refused_drain_keeps_the_queue_order` (`main.rs:11009`) and `row_repeated_refused_drains_write_one_waiting_notice` (`main.rs:11031`).
- **Finding 2:** `queue_delivery` only writes the notice when `meta.kind == "blob_message"` (`team.rs:678`). A `blob_reply` queues silently, and `row_a_reply_to_a_busy_origin_adds_no_waiting_notice` (`main.rs:11055`) covers it.
- **Finding 3:** `announce_model_change` calls `announce_context_loss` only when `session_has_conversation_history` is true (`knowledge.rs:430`). The Manager path is unchanged. `row_a_model_change_on_a_never_prompted_bot_stays_silent` (`main.rs:11147`) covers it.
- **Finding 4:** `projectForDraft` (`ProposalCard.tsx:38`) matches by id or by trimmed, case-insensitive name, as the daemon does. The folder line shows the path, or "Project not found" for an unknown name, and is absent when no project is named (`ProposalCard.tsx:145`). The mounted and unit tests cover these cases.
- **Finding 5:** The new UI tests cover the waiting indicator (`App.agent.mounted.test.tsx:1095`) and the "Bots working at once" setting (`SettingsSheet.appearance.mounted.test.tsx:156`). The restart gap for `st.team.queued` is now stated in the report. The extra `MessageMeta` type addition (`direction: 'waiting'`, `state?: 'queued'`) in `types.ts` only adds types for fields the daemon already emits.

The restart gap is not implemented, only documented. That is acceptable for merge; the Director decides whether to schedule the `relay_failure` startup pass.
