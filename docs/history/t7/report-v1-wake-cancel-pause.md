# Lane V1 report (27 October 2026): durable Manager wake, turn-checked cancel, optional delegation pause

Worktree `D:\v1`, branch `lane/v1`. No tests, no test-target builds, no app/browser/probe/screenshot, no git writes were run. Only `cargo check -p bloblex-daemon -p bloblex-storage` (production targets). Files touched: `crates/bloblex-daemon/src/delegations.rs`, `team.rs`, `main.rs` (only the cancel functions and the `validate_setting` arm), `backup.rs` (allowlist only), `crates/bloblex-storage/src/lib.rs` (delegation, question and `permission_requests` functions, schema and the setting validation entry).

The T7 report is missing from this worktree (`docs/history/t7` does not exist here). It was read read-only from the main checkout (`D:\Basem's\Coding\Blolblex\docs\history\t7\REPORT.md`), together with `report-u2-delegation-questions.md`; the wake/cancel facts below were then re-read in the code of this worktree.

---

## Item 1 — the child-question wake survives a restart

### Evidence read first

- `delegations::attention` (`delegations.rs:661`) claimed `wake_request` on the assignment row and then `spawn_update` → `team::deliver_update` (`team.rs:1044-1052`) → `team::deliver` (`team.rs:991-1031`), which either prompts now or puts the text in the **in-memory** `Team.queued` map (`team.rs:37`, `queue_delivery` `team.rs:1055-1073`). The claim was durable, the delivery not: a restart after the claim and before the Manager's prompt lost the wake. The request card stayed visible.
- The reply pattern copied here: `reply_state` (`pending`/`delivered`, schema comment `lib.rs:1005-1010`), `claim_reply` (`delegations.rs:50-52`), `settle_reply` (`54-57`), `settle_queued_reply` (`59-65`), `delegation_pending_replies` (`lib.rs:4029-4039`), boot offers (`delegations.rs:762-764`, `offer_reply` `830-849`), boot drain after the team address exists (`main.rs:4758-4763`), and the queue drain that settles a queued reply (`team.rs:1098-1125`).

### Exact new contract

**Columns (additive, guarded by `pragma_table_info` + `ALTER TABLE ... ADD COLUMN`, `lib.rs:1015-1026`):**

| column | type | meaning |
|---|---|---|
| `wake_state` | TEXT | `NULL` = none, `pending` = claimed and not yet proved delivered, `sent` = prompt accepted (directly or by the drain), `dropped` = no longer meaningful or unprovable |
| `wake_title` | TEXT | the request's short title only: `one_line(title).chars().take(160)` (`delegations.rs:684`), cleared when the wake settles |
| `wake_kind` | TEXT | `question` or `approval` (`delegations.rs:687`), cleared when the wake settles |

`CREATE INDEX ... idx_delegations_wake_pending ON delegations(wake_state) WHERE wake_state='pending'` (`lib.rs:1048`). None of the three columns is in `DELEGATION_COLUMNS`/the DTO (`lib.rs:1067`), in any event, or in any log line. The wake text carries the bot name and that title only; the same text is written to the Manager's transcript by the existing delivery path.

**Claim (one atomic UPDATE, `lib.rs:3939-3952`):**

```sql
UPDATE delegations SET wake_request=?2,wake_state='pending',wake_title=?3,wake_kind=?4,updated_at=?5
WHERE id=?1 AND status='running'
  AND (wake_request IS NULL OR wake_request != ?2)
  AND (wake_state IS NULL OR wake_state != 'pending')
```

Returns `true` only when exactly one row changed. Empty request id or a kind other than `question`/`approval` returns `false` without touching the row. Title is re-truncated to 160 characters inside the storage call.

**Settle (`lib.rs:3968-3979`):** `state` must be `sent` or `dropped`; the UPDATE additionally requires `wake_request=?2 AND wake_state='pending'`, so a late ack for an older request cannot overwrite a newer wake, and a repeated ack changes nothing. Clears `wake_title`/`wake_kind`.

**Drop (`lib.rs:3982-3989`):** `wake_state='dropped'` for whatever wake is `pending` on the row; no request id needed (used by `finish`). Idempotent.

**Reads:** `delegation_wake_pending(id, request)` (`lib.rs:3955`), `delegation_pending_wakes()` (`lib.rs:3995-3998`, one row per assignment with `id, originSessionId, sideSessionId, requestId, targetAgentId, title, kind, deliveryDepth, status`), `delegation_wake_delivered(origin, text)` (`lib.rs:4006-4013`, `LIMIT 1` on `messages(session_id, role, content)`), `permission_status(id)` (`lib.rs:2432-2436`).

**Live path (`delegations.rs`):** `attention` normalises the kind, truncates the title, claims with title+kind (`691`), composes the text with the shared `wake_text` (`604-607`), and spawns `spawn_update` (`641-648`). Before delivering, the task re-reads `delegation_wake_pending` (`646`) so a wake dropped between the claim and the task is never sent; after `deliver_update` it settles `sent` exactly when `Delivery::Sent` (`648`), exactly like a reply. `Delivery::Queued` leaves it `pending`.

**Queued path:** the drain settles a sent wake through `settle_queued_wake` (`delegations.rs:618-623`, called at `team.rs:1123`). A queued wake whose assignment is already terminal is skipped by `stopped_delegation` (`team.rs:1089-1095`, now includes `blob_update`) and settled `dropped` by `drop_queued_wake` (`delegations.rs:627-630`, called at `team.rs:1115`).

**Terminal assignment:** `finish` (`delegations.rs:133-152`) drops the pending wake (`140`) and removes that assignment's queued wake items from the Manager's in-memory queue (`team.rs:118-126`). This runs for completed, failed, cancelled and interrupted rows, because `finish` is the single terminal path.

**Request over:** `question_resolved` (`delegations.rs:241-277`) settles this exact request's pending wake `dropped` and removes that request's queued item (`274-276`, `team.rs:128-138`), so an answered/dismissed/expired/closed question never announces itself afterwards. A newer request's wake on the same assignment is untouched (request id match in both the settle and the queue removal).

**Boot recovery (`delegations.rs:716-771`, `offer_wake` `787-822`):** after the reply offers, for every row with `wake_state='pending'`:
1. the assignment must still be `running`, else `dropped` (`delegation_get`, `790-793`);
2. the origin (Manager) conversation must exist and not be archived, else `dropped` (`session_brief`, `794-797`);
3. the request card must still be `pending` by its row status, else `dropped` (`permission_status`, `798-801`);
4. the one ambiguous case (the process died between `deliver` accepting the prompt and the ack) is decided from the Manager's stored messages: if a `role='user'` message with the exact composed wake text exists, settle `sent` and send nothing; if the lookup errors, settle `dropped` and write nothing (`809-813`);
5. otherwise the wake is re-queued once through the same delivery path replies use (`restore_queued` with a `blob_update` meta identical to `deliver_update`'s, `818-821`), stays `pending`, and the boot drain sends and settles it.

The exact refusal/wake sentences are unchanged; the only new user-visible string in the lane is item 3's pause sentence.

### Interleaving analysis (item 1)

- **A claims a wake while B finishes the assignment.** The claim's UPDATE requires `status='running'`; if `finish` won, the claim changes 0 rows and returns false, so nothing is announced. If the claim won, `finish` drops the pending wake (`delegations.rs:140`) and removes queued items; the delivery task's pre-send `delegation_wake_pending` check (`646`) also finds it dropped and returns without sending. A later ack is refused by `wake_state='pending'` in the settle WHERE. Therefore a wake of finished work is not delivered, and a dropped wake cannot be revived by a late ack.
- **A queues the wake (Manager busy) while B answers the question.** `question_resolved` settles the wake `dropped` and removes that request's queued item (`team.rs:128-138`). If the drain already popped the item, the update may still be delivered (it left the queue just before); the wake text is then stale by the time it lands, but it is the same item that was already claimed, so it is not a duplicate. Recorded as a narrow stale-notice window below.
- **A drains a queued wake while B finishes the assignment.** Two guards: `finish` removes the item while it is still queued (`cancel_queued_wakes`), and the drain re-checks `stopped_delegation` on a terminal row (`team.rs:1089-1095`) before delivering. If the drain popped the item before `finish` ran, the delivery proceeds — the wake is about work that was running a moment earlier; it is not re-sent and settles `sent`.
- **Two `attention` calls for the same request.** The first claim changes 1 row; the second hits `wake_request != ?2` and changes 0; one wake per request id, idempotent on replay.
- **A claims request A; request B arrives while A is still `pending`.** The claim is refused (`wake_state != 'pending'`), so the older undelivered wake is never overwritten (the brief's rule). Consequence, stated as a limitation: B has no wake from that call; once A settles, only a *new* `attention` for B (this code does not generate one) would announce it. See "Unknown / unverifiable".
- **Restart between claim and delivery.** The wake is `pending`; at boot `offer_wake` re-checks running/origin/card, proves absence or presence from the stored message, and either re-queues it or settles it. This closes T7 gap 1 for wakes that never reached the transcript.
- **Restart after the provider accepted the prompt but before the ack.** The prompt is stored before `session_prompt_for_team` returns (`main.rs:3397-3406`, inside the same gate block), so the message is present; `delegation_wake_delivered` returns true and the wake is settled `sent` without a second send.
- **Restart between the boot offer and the boot drain.** The wake is queued in memory and `pending`; the process dies again; the next boot re-offers it (the previous offer's message was never written). Offer is idempotent per request via `restore_queued`'s dedupe on `(delegationId, kind, requestId)` (`team.rs:47-63`) while the process lives, and the durable claim is the cross-process guard.
- **Manager busy at boot (another restored reply is being delivered).** The wake is queued behind it (FIFO, `restore_queued` to the back) and delivered by the drain after the Manager's turn ends; `settle_queued_wake` then marks it `sent`.
- **A late ack for request A after a newer request B was claimed.** `wake_request=?2` in the settle means A's ack cannot mark B `sent`; B's own delivery settles B. A's queued item, if any, is removed by `finish`/`question_resolved` only for A's id.
- **A wake whose prompt path fails with a non-conflict error.** `deliver` writes the failure note to the Manager and returns `Sent` (`team.rs:1018-1025`), so the wake settles `sent`. It is not re-offered: the prompt path failed at the time, and a boot re-offer would take the same path again. Stated as a decision, not a claim of successful delivery.

---

## Item 2 — cancel is checked against the turn it means to stop

### Evidence

- Old `delegations::cancel_row` read `active_turns` without the gate, compared it with `sideTurnId`, then called `cancel_session_turn`, which cancelled `retry::cancel_pending(st, id, ...)` for the whole session **before** taking the session gate (`main.rs:2550-2557` before this change) and then cancelled whatever was live. A turn change between the read and the cancel could stop another assignment's turn.
- `starting_cancels` is `Arc<Mutex<HashSet<String>>>` keyed by turn id (`main.rs:109`), so it is already turn-scoped.

### Exact new contract

- `cancel_session_turn(st, id)` (`main.rs:2554-2560`) is kept as the no-expectation wrapper: it drops pending retries first, then runs the shared body. `session.cancel` (`main.rs:1194`) is therefore unchanged in order and behaviour.
- `cancel_session_turn_if(st, id, expected_turn_id)` (`main.rs:2571-2576`) returns `Ok({"cancellationRequested": true})` when that exact turn was live and the stop was recorded or asked for, and `Ok({"cancellationRequested": false, "reason": "turn_changed"})` — cancelling nothing, writing no state and dropping no retry — when the live turn is absent or different. An empty expected id is `turn_changed` without touching anything. Errors are the existing typed ones (`not_found` for a deleted/absent session, `unsupported` when the adapter refuses).
- Shared body (`main.rs:2586-2651`): under the per-session gate, read the live turn once (`2594`), compare it with the expectation (`2595-2599`), then set `cancelling` and either take the active session or record the turn id in `starting_cancels` (`2600-2616`). A new turn reservation needs the same gate (`main.rs:3304-3428`), so inside the gate the map can only lose the entry, not gain a different turn. After the gate: for the `Starting` case the retry is dropped and `cancellationRequested:true` is returned (`2627-2630`); for the active case the provider stop is issued first (`2634`), the retry is dropped only then and only for an expected call (`2635-2637`), and an adapter error restores the state and returns `unsupported` (`2638-2641`).
- `cancel_row` (`delegations.rs:968-1050`) calls the checked version with the row's `sideTurnId` whenever the row is running, has a turn id and is not its own origin (`994`). On success it returns the row as it stands (its own end hook marks it). On `turn_changed` it re-reads the row and the live turn **once** (`991-1002`) and then: (a) its own turn ended -> the existing outcome branch (completed/failed/cancelled; a waiting completed row becomes cancelled; `1004-1013`), or (b) another turn is live / no readable outcome -> end only the row as cancelled, exactly like the no-live-turn branch, never touching the session (`1022-1027`). It never loops. An adapter error ends the row as cancelled as before (`1031-1036`).

### Remaining window (stated precisely)

The turn identity is checked and the stop recorded under the gate. After the gate is released, `adapter.cancel` still cannot carry a turn id (the adapter API takes the session handle). So the sequence "turn T ends by itself, the turn-end path writes a new state and `queue::after_turn` starts a queued prompt as T2, then our `adapter.cancel` reaches the provider" is possible in principle. The provider would then be asked to stop T2. This lane cannot close it without a turn-scoped adapter cancel (adapters are outside the files I own). I minimised it by issuing the provider stop before the retry drop; the earlier order did DB work (`retry::cancel_pending`) before the stop. What *is* closed is the original defect: a different live turn is no longer cancelled on behalf of this assignment, and no retry is dropped before the identity check.

`starting_cancels` is keyed by turn id, and the id inserted is the one read under the gate (`2607-2608`); a turn that ended in between leaves the map without an entry, so nothing is inserted and the call returns `not_found` (the session can only lose the entry under the gate, as argued above).

`retry::cancel_pending` itself is session-scoped (`retry.rs:417-423`, `queue_delete_retries(session_id)`), not turn-scoped. The check guarantees it only runs for the conversation whose expected turn matched and is live; it then removes every retry row of that session. Nothing in the read code allows a pending retry to belong to a turn other than the one that failed last in that same session, and a live turn and a pending retry do not coexist normally (the retry is created after a failure and starts its own turn), but the delete is by session, not by turn.

### Interleaving analysis (item 2)

- **A checks turn T is live; B ends T and starts T2 before A takes the gate.** The check inside the gate sees T2 (or none) and returns `turn_changed`; A stops nothing and drops no retry.
- **A takes the gate and sees T; B cannot reserve a turn while A holds the gate.** The reservation insert for any new turn happens under the same gate (`main.rs:3304-3428`), and a prompt refuses a session in `cancelling` (the state is written at `main.rs:3419-3420`; the refusal is `main.rs:3278-3280`). So from the check to the state write no different turn can appear.
- **T ends right after the gate is released, before `adapter.cancel`.** The provider is asked to stop a handle whose turn is finishing (or a newly started T2; see the window above). The row, however, is decided by the two reads in `cancel_row`: if T's outcome is readable, the row takes it (not "cancelled"); if another turn is live, only the row ends as cancelled. A later ending of an already terminal row is `TurnEnd::Owed` with the reply claim already taken, so no second reply (`delegations.rs:332`, team hook `team.rs:1187-1208`).
- **A checks T; T ends; `retry` creates a retry for T before A's retry drop.** A's checked call matched T while it was live; the retry drop then removes that retry. If the adapter stop failed, the retry is dropped anyway (old behaviour).
- **Two cancels for the same row.** `is_terminal(row)` at entry returns a finished row unchanged; the second call either finds the row running (same expected turn; a second `cancelling` write) or terminal. No duplicate reply: `relay_stopped` claims `reply_state` once (`delegations.rs:213-219`).

---

## Item 3 — optional global pause on new delegation

### Exact contract

- Setting `delegation.paused`, JSON boolean, default `false` when the row is absent (`delegation_paused`, `lib.rs:4018-4022`: one keyed `SELECT value ... WHERE key='delegation.paused'`; malformed values read as false).
- Daemon validation: `main.rs:1401` — `invalid_argument`, "delegation.paused requires a JSON boolean". Storage validation: `lib.rs:1666` — `InvalidAgent` for a non-boolean (used by `settings.set` and the backup importer).
- Backup allowlist: `backup.rs:45` length 34 and the entry at `74`, so the key round-trips in a backup.
- Check in `team::delegate` (`team.rs:768-782`): after the dedupe replay return (`768-772`) and before any conversation is opened, queued brief is recorded or worktree is prepared. One read. While true a new assignment returns the exact sentence:
  `Delegation is paused. Ask the user to resume it in Manager settings, or do the work yourself.`
  `message_blob` relays it to the Manager as the tool error (`team.rs:694-701`).
- Nothing else reads it: running assignments, queued briefs already recorded, approvals already decided, questions, replies, wakes and cancels never consult the setting (no other call site; `delegation_paused` is called only at `team.rs:779`).
- Remote: `settings.set` is class `never` in `apps/desktop/src/remote/tiers.json:355-358`, so the key cannot be written from a remote device. `settings.get` remains readable (`tiers.json:222`), which only exposes a boolean.

### Interleaving analysis (item 3)

- **The owner pauses while a brief is being recorded.** `delegate` reads the setting once, after the replay lookup. A call that read `false` before the pause continues to record and deliver (the pause is not retroactive, by design: it must never touch queued work). A call that reads `true` refuses before creating anything.
- **A replayed tool call arrives while paused.** The dedupe lookup runs first (`team.rs:768-772`) and returns the recorded row with `duplicate`, so the replay is never turned into a refusal.
- **An approved `assign_task` runs while paused.** `proposals::assign_task` calls the same `team::delegate` (`proposals.rs:544`), so the new assignment is refused with the same sentence and the approval fails with that message; the approval/card machinery itself is untouched. This is a decision I am flagging (see below).

---

## Decisions the brief left open (and what I chose)

1. **Ambiguous-delivery proof.** The brief names `meta.requestId` on a stored `blob_update` message. That meta is not persisted (`main.rs:3126-3131` accepts only `blob_message`/`blob_reply`), and `main.rs` is frozen for this lane. I used the exact composed wake text as the stored proof, with a `LIMIT 1` query served by `idx_messages_session_role`. Consequence: a duplicate identical wake text from an earlier request can be mistaken for this one (listed below).
2. **Boot re-offer transport.** The brief says "through the same `deliver_update` path". At `delegations::startup` the team address does not exist yet (`main.rs:4729` vs `4758`), which is exactly why replies are queued. I queue the identical text/meta with `restore_queued`; the boot drain calls the same `deliver` that `deliver_update` calls, and the settle hook is the same. A direct `deliver_update` call there could prompt with a missing MCP address.
3. **Card pending test.** The brief says `permission_get`; I used the card row status (`permission_status`) because `data.status` lags behind a failed reply (`lib.rs:5741-5749`). For `mcp:` questions the row status is `pending` until answered, which satisfies the brief's clause.
4. **Non-conflict delivery failure.** `deliver` reports a non-conflict prompt failure to the Manager as a note and returns `Sent` (`team.rs:1018-1025`), so the wake settles `sent` rather than staying pending forever. It is not re-offered.
5. **Second request while the first wake is pending.** Per the brief, the claim is refused, never replaced; the older wake is the one delivered. The newer request keeps its visible card. See the limitation below.
6. **Pause scope.** Applied inside `team::delegate`, which is shared by `message_blob` and the approved `assign_task` path. The brief names `team::delegate`, so this is literal; the consequence for an approval is stated above.
7. **No `settings.changed` event.** `write_setting` announces only listed prefixes/keys (`lib.rs:1693`); `delegation.paused` is not among them (like `retry.*`, `questions.*`, `claude.*`). Adding it would edit the shared writer outside the items the brief lists for storage, so I did not. An open window keeps the old value until it reloads settings; the next `settings.get`/snapshot has the new one.
8. **`validation_key` in `settings.set`.** The brief allows only the `validate_setting` arm in `main.rs`, so `delegation.paused` was not added to the `validation_key` list (`main.rs:1329`). That list only chooses the error code when storage rejects a value; storage's validator accepts exactly what the daemon's does (boolean), so a rejection cannot occur in practice.
9. **Kind normalisation.** `attention` maps every non-`question` kind to `approval`, preserving today's "approve a request" text; every existing caller passes `question` or `approval` (`main.rs:4288`, `main.rs:4517`, `questions.rs:173`).

---

## Cases left unknown or unverifiable (stated exactly)

1. **Identical wake text from two requests.** If request A's wake was delivered and request B on the same assignment later has the same bot name, kind and title (so the same text), and the process dies before B's ack, the boot lookup finds A's message and settles B `sent`. B's notice is then not sent; no duplicate is sent either. The stored data cannot distinguish the two, because the prompt meta is not persisted.
2. **Wake message deleted by the user.** If the delivered wake message is removed from the Manager's transcript before a restart while its wake is still `pending` (only possible if the process died before ack), the text lookup returns false and the wake is re-offered. I did not find a per-message delete path in the daemon; whether the UI can delete a single message is unverified here.
3. **Bot renamed between a delivered wake and the restart.** The boot text is composed from the *current* agent name; the sent message carries the old name. If the process died before the ack, the lookup misses and the wake is re-offered (duplicate text with a new name). Only possible across a rename and an unacked crash.
4. **Approval answered while its wake is still queued.** Unlike questions, there is no approval-resolution hook in the files I own, so the queued wake can still be delivered after the card is resolved. It is a stale notice, not a duplicate; the row stays running (an answered approval does not end the assignment), so the boot conditions would also allow a re-offer if it were still pending.
5. **A second request on the same running assignment while the first wake is `pending`.** Not announced by that call (claim refused as required); nothing in the read code generates a second `attention` for it later. The card remains visible in Needs you.
6. **Provider-level cancel after the gate** can still reach a turn that ended and was replaced by a queued prompt (item 2's remaining window). No adapter or provider was run, so the actual behaviour of an interrupt against a freshly started turn is unverified.
7. **The state where the live turn at `cancel_row`'s re-read is again the row's own turn** (requires the live turn to change away and back to the same id between two statements; no code path re-inserts a turn id) is treated as case (b): the row ends as cancelled, the session is untouched.
8. **`delegation.paused` in the UI.** No UI switch or live event was added (files frozen / outside the listed items). Setting it requires `settings.set` or a backup import.
9. **The schema migration on a real pre-T7 database** was read, not run: three guarded `ALTER TABLE ... ADD COLUMN` and a partial index, executed by `ensure_delegation_schema` on open (`lib.rs:981-1049`). The backup round-trip of the new key was not run.
10. **A wake claimed by the previous build.** Such a row has `wake_request` set but `wake_state`, `wake_title` and `wake_kind` NULL (they are added by this change). It is not re-offered at boot, because the title the re-offer would need was never stored; the request card stays visible. Only wakes claimed after this change are durable.
11. **None of the runtime behaviour above was exercised.** No test, app, provider, browser, restart or screenshot was run, per the hard rules.

---

## Existing tests that reference changed code (names only, not run)

- `crates/bloblex-daemon/src/main.rs`: `cancel_while_starting_skips_prompt`, `manager_delegates_to_a_teammate_and_is_woken_by_the_relayed_reply`, `delegation_notice_splits_a_turn_and_reply_paths_read_one_row`, `timeout_finalisation_drains_the_queued_team_delivery`, `team_deliveries_drain_after_the_user_queue`, `a_transient_turn_conflict_keeps_the_item_queued_and_unpaused`, `row_a_refused_drain_keeps_the_queue_order`, `row_repeated_refused_drains_write_one_waiting_notice`, `row_a_finished_turn_drains_another_conversations_queue`, `task_restart_marks_ambiguous_work_needs_you_and_resumes_queued_work_once`, `automations_coalesce_missed_runs_skip_overlaps_and_respect_global_pause`.
- `crates/bloblex-daemon/src/team_p7_tests.rs`: `p7_manager_messages_a_teammate_immediately_with_no_proposal_or_task`, `p7_manager_messages_a_teammate_at_once_while_start_and_assign_stay_approved` (and the module's other `message_blob` tests that share `install_delegation`).
- `crates/bloblex-daemon/src/team_p10_tests.rs`: `p10_a_follow_up_after_a_merge_runs_in_an_existing_folder`, `p10_isolates_a_code_task_when_another_runs_in_the_repo`, `p10_isolates_when_the_other_task_is_queued_or_has_not_started_a_turn`.
- `crates/bloblex-storage/src/lib.rs`: `appearance_values_validate` (calls `validate_setting_value`), and the delegation schema/setting tests in that module that run `Storage::open_in_memory` (they now also create the three new columns and the partial index through the same schema path).
- `crates/bloblex-daemon/src/backup.rs`: `haze_style_survives_a_document_round_trip` (exercises the settings allowlist).

No test file was edited, added or deleted; no test target was compiled. Any test that would need a signature change would be a compile break I cannot see without compiling tests: the only changed signature is `storage::delegation_wake_claim` (now takes `title` and `kind`), and a search found no test caller (only `delegations::attention`).

---

## Checks

`cargo check -p bloblex-daemon -p bloblex-storage` (production targets only; `$env:RUST_MIN_STACK=33554432`), last 15 lines of the full rebuild:

```
    Checking url v2.5.8
    Checking bloblex-runtime v0.1.0-beta.38 (D:\v1\crates\bloblex-runtime)
    Checking tower-http v0.6.11
    Checking bloblex-adapter-claude v0.1.0-beta.38 (D:\v1\crates\bloblex-adapter-claude)
    Checking bloblex-adapter-codex v0.1.0-beta.38 (D:\v1\crates\bloblex-adapter-codex)
    Checking bloblex-adapter-acp v0.1.0-beta.38 (D:\v1\crates\bloblex-adapter-acp)
    Checking hyper v1.11.1
    Checking hyper-util v0.1.21
    Checking hyper-tls v0.6.0
    Checking igd-next v0.18.0
    Checking axum v0.8.9
    Checking reqwest v0.12.28
    Checking bloblex-storage v0.1.0-beta.38 (D:\v1\crates\bloblex-storage)
    Checking bloblex-daemon v0.1.0-beta.38 (D:\v1\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 07s
```

The final check, after the last edit, printed only these lines (everything else was cached):

```
    Checking bloblex-daemon v0.1.0-beta.38 (D:\v1\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 6.20s
```

No warnings in either run. Intermediate runs after the reorder and comment edits were clean as well (`29.37s`, `9.84s`, `8.19s`).
