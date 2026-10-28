# Lane U3 report: restart truth, ambiguous sends, orphaned cards, bounded reads

Worktree `D:\u3`, branch `lane/u3`. Six `cargo check` runs of
`cargo check -p bloblex-daemon -p bloblex-storage`, all clean and warning-free.
**No tests were run, added, edited or deleted. No git writes.**

Files changed: `crates/bloblex-storage/src/lib.rs`, `crates/bloblex-daemon/src/queue.rs`,
`crates/bloblex-daemon/src/retry.rs`, `crates/bloblex-daemon/src/main.rs` (boot and recovery
only), plus one dated lesson in
`.claude/skills/bitbots-development/references/lessons.md` (required by `AGENTS.md`; it is
outside the brief's file list — drop that hunk if the Director does not want it in this
lane). No test code touched, `update_session_model`, `session_prompt_impl`, `delegations.rs`,
`questions.rs`, `team.rs`, `proposals.rs`, adapters, `apps/` and `docs/` untouched.

---

## Item 1 — an ambiguous queued send is never replayed by accident

### Evidence

- Claim: `queue_claim_next` sets `status='sending'` (`storage:3381-3398`), `queue_claim`
  sets `status='sending'` from `queued`/`failed` and clears `error` (`storage:3399-3408`).
  A `sending` row means the daemon had already handed the prompt to `session_prompt` when
  the process died, so it may have reached the provider.
- Boot rewrite (before this lane; the statement was line 4788 and is now 4879) wrote every
  `sending` row to `failed` with "Interrupted by a restart. Check the conversation before
  sending again.", with no marker, and `queue_claim` would happily resend it.
- Replay paths today: `send_now` → `send_specific` → `queue_claim` (`queue.rs:243-280`);
  `drain_next`/`due_tick`/`after_turn` use `queue_claim_next`, which only selects
  `status='queued'` (`storage:3381`), so a failed item is never drained automatically.

### Verdict / change

- **(a) Wording.** One stable constant, `QUEUE_AMBIGUOUS_ERROR` (`storage:1015`):
  "Bitbots stopped while sending this. It may already have reached the agent. Check the
  conversation before sending it again." The boot rewrite stores it (`storage:4879`).
- **(b) Marker.** The boot rewrite also runs
  `params_json=json_set(params_json,'$.ambiguous',json('true'))` (`storage:4879`). It lives
  inside the item's own JSON: additive, no column migration, invisible to the prompt rebuild
  (`queue.rs:prompt_params` copies only allowlisted keys).
- **Gates.** `session.queue.send_now` (`queue.rs:243-279`) and `session.queue.update`
  (`queue.rs:177-215`) read the item DTO and, when `ambiguous` is true without
  `confirmResend: true`, return `derr("confirmation_required", QUEUE_AMBIGUOUS_ERROR, 409)`.
  The `send_now` gate sits **before** the busy branch, so an ambiguous item is never moved to
  the front to fire by itself.
- **Confirmed resend.** `queue_claim` now clears `$.ambiguous` in the same statement that
  claims the row (`storage:3402`), so a second failure after a confirmed resend is recorded
  as a plain definitive failure. `queue.update` on a confirmed ambiguous item goes through
  the new `queue_revise_failed` (`storage:3304`): it rewrites text/`dueAt`, drops the marker
  and **keeps `status='failed'`** — an edit never sends anything; only an explicit
  `send_now` does.
- **(c) DTO.** `queued_prompt_dto` now always emits `"ambiguous": <bool>` (`storage:1689`),
  so `queue_list`/`queue_get`/`queue_update`/`queue_claim` DTOs all carry it.
- **(d) Definitive refusals unchanged.** `queue_mark_failed` (`storage:3413`) still writes
  `failed` + the error text with no marker.

### Where each failure kind is written

| Failure kind | Written at | Status / marker |
|---|---|---|
| Daemon stopped while the send was claimed | `storage:4879` (`recover_restart_state`) | `failed`, `error=QUEUE_AMBIGUOUS_ERROR`, `ambiguous:true` |
| Provider/daemon refused it at send time (not a conflict) | `queue.rs:333` → `storage:3413` `queue_mark_failed` | `failed`, the RPC's message, no marker |
| Transient conflict (a turn started in between) | `queue.rs:330-331` → `storage:3422` `queue_requeue` | back to `queued`, `error=NULL` |
| Overdue auto-retry dropped after a restart | `retry.rs:494` → `storage:3499` `queue_delete_by_id` | row deleted, notice only |
| User deletes an item | `queue.rs:228-235` → `storage:3345` | row deleted (`queued`/`failed` only) |

### Interleaving analysis

- `send_now` reads the DTO, then (busy) `queue_move_to_front`, or (idle) takes the
  per-session drain lock, then `queue_claim`. Between the gate and the claim the only writer
  that can touch the row is another queue RPC on the same session: `drain_next` cannot pick a
  `failed` row, and `queue_claim` itself is a conditional `UPDATE ... WHERE status IN
  ('queued','failed')` whose 0-row result becomes the existing "That item is no longer
  queued." conflict. So two confirmations cannot send the item twice; the loser sees the
  conflict.
- Boot runs before the router exists (`main.rs:4433` vs `4511`), so the rewrite cannot race a
  send: no adapter session exists yet and no client is connected.
- `due_loop`/`after_turn` only ever claim `queued`, so an ambiguous row is invisible to the
  automatic paths even while its session is paused or resumed.

### Contract changes (additive)

- Queue item DTO: `ambiguous: boolean` (always present).
- `session.queue.send_now` / `session.queue.update` params accept `confirmResend: boolean`;
  without it on an ambiguous item they return error code `confirmation_required` (HTTP 409)
  with `QUEUE_AMBIGUOUS_ERROR`.
- `session.queue.update` on a confirmed ambiguous item returns the item still `failed`
  (before this lane it returned `conflict`, because only `queued` items could be edited).

### Decisions not specified

- 409 rather than 400 for `confirmation_required`: it is a precondition, not a malformed
  request, and matches how queue conflicts are reported.
- The same constant is used for the stored error and the RPC error so the user reads one
  sentence both times.
- `queue_revise_failed` clears the marker on the confirmation. The alternative (keep it, so
  the following `send_now` asks again) would double-confirm the same decision.
- A busy `send_now` on a **failed** item now returns `conflict` ("Wait for the current turn to
  finish, then send this again.") instead of promising `{"queued":true}` while
  `queue_move_to_front` silently did nothing for a non-queued row
  (`storage:3355-3379` only reorders `queued` rows). Found while wiring the confirmed resend.

### Gaps left

- Errors from `session_prompt` after the prompt may have been written but before the turn was
  acknowledged are still stored as definitive failures by `queue_mark_failed`. The brief's
  (d) asked for definitive refusals to stay unchanged, and the adapter contract does not say
  which failures are post-delivery, so I did not guess. A future change could mark `failed`
  with `ambiguous` when the turn never saw `PromptAccepted` (`accepted_turns`).

---

## Item 2 — orphaned approval and question cards after a restart

### Evidence (what the boot sequence did before this lane)

- Recovery already expired **every** `pending`/`resolving` row of `permission_requests` at
  boot (`storage:4876` predecessor), writing `$.status='expired'`,
  `$.resolution='daemon_restarted'`. So native cards do **not** survive as `pending`.
- What was missing: no `permission.resolved` was emitted for them and the transcript was
  never told, so a window connected to the live event stream kept a card that could no
  longer be answered, and the conversation had no record of why the request vanished.
- The blanket update also expired two daemon-owned kinds that *are* still answerable:
  `mcp:` questions (`questions.rs:136` sets `provider_request_id = "mcp:<uuid>"`; answered
  in-process by `reply_mcp_question`, `questions.rs:274+`, and expired by the 10 s
  `questions::sweep` through `expires_at`, `questions.rs:251-270`) and proposal cards
  (`provider_request_id = "proposal:<id>"`, `storage:2421`; decided by `proposal.decide` and
  expired by `proposals::sweep`). Both sweeps run from `automations.rs:361-365` every 10 s.
- Native cards expire correctly: `insert_permission` stores a real provider request id
  (`storage:5297+`) and `permission.reply` answers it by calling the adapter
  (`main.rs:1243`), which no longer exists after a restart.

### Verdict / change

Proven gap: cards were closed but nobody was told, and two answerable kinds were closed by
mistake.

- The boot update is now scoped (`storage:4876`):
  `provider_request_id IS NULL OR (NOT LIKE 'mcp:%' AND NOT LIKE 'proposal:%')`.
- `recover_restart_state` returns the closed `{id, sessionId}` rows (`storage:4869-4875`).
- Boot (`main.rs:4492-4505`) emits, per closed card,
  `permission.resolved {"permissionId", "choice":"expired", "status":"expired",
  "reason":"daemon_restarted"}`, and appends **one** `team::note` per affected conversation:
  "Bitbots restarted, so this request is no longer waiting. Ask again if it still matters."
  (`{"kind":"permission_expired","reason":"daemon_restarted"}`). Deduplicated with a
  `HashSet` over `closedCards`, so one note per conversation even with several cards.
- No session has a live provider handle at boot (`st.sessions` is built empty at
  `main.rs:4455`), so no card is skipped for that reason.

### Interleaving analysis

- Card expiry and card selection happen in one `IMMEDIATE` transaction inside
  `recover_restart_state`, before `AppState` exists, so no reply RPC can interleave: a
  `permission.reply` for an old card returns 409 "permission is no longer pending"
  (`main.rs:1204-1211`) once boot is done.
- The events are emitted after `delegations::startup` and `tasks::startup`, so a side
  conversation's assignment is already `interrupted`/`needs_you` before its card is
  announced closed; nothing a client replays contradicts the ledger.
- `emit` persists to `app_events` and broadcasts (`main.rs:136-154`). A client connected
  later gets the card removed by the snapshot (`status='pending'` filter, `storage:5751`)
  and, if it replays from an older sequence, the same `permission.resolved` event.
- `questions::sweep` now finds no `mcp:` card closed by boot, so it cannot double-resolve;
  its own `permission.resolved`/note path is untouched.

### Contract changes

- New event payload keys on `permission.resolved` at boot: `status:"expired"` and
  `reason:"daemon_restarted"` (existing consumers match on `permissionId`,
  `apps/desktop/src/types.ts:513-516`).
- New transcript notice `meta.kind = "permission_expired"`.

### Decisions not specified

- **Proposal cards are skipped too**, not just `mcp:` cards. Before this lane a restart
  expired a pending proposal's card while the `proposals` row stayed `pending`; the card is
  the surface the Manager page reads (`snapshot.permissions` filtered by `kind='proposal'`),
  so the owner silently lost the ability to decide it. They remain answerable and expire
  through `proposals::sweep`. If U2 wants a different rule for proposals, only the `NOT LIKE
  'proposal:%'` clause and the note loop need to change.
- `choice:"expired"` mirrors `questions::sweep`'s existing payload (`questions.rs:257`).
- The note is content-free (no title, no detail, no message text) as required.

### Gaps left

- A card whose session was deleted between the crash and boot: `permission_requests` rows
  cascade on session delete, so nothing is left to close; no note is written, correctly.
- `tasks::permission_resolved` is not called for boot-closed cards. `tasks::startup` runs
  after recovery and already settles ambiguous runs to `needs_you`, so a second path would
  be a duplicate.

---

## Item 3 — the session state after a crash is true

### Evidence

- `recover_restart_state` (`storage:4847`): turns in `starting|working|waiting_permission|
  cancelling` → `state='error'`, `data.watchdogInterrupted=true`,
  `started_at=COALESCE(...)`, `completed_at=now`, `failure_class='other'` (`storage:4858`);
  sessions → `offline` + `continuation_pending=1` (`storage:4863`; the flag is now conditional,
  see below).
- Reservations live in SQLite (`active_turn_reservations`, `storage:67`;
  `create_reserved_turn` writes turn + reservation together, `storage:4787-4799`;
  `active_turn_reservation_count` reads the table, `storage:4800-4803`). Recovery deletes
  every reservation whose turn is now terminal (`storage:4859`), which after the turn update
  is every reservation — no slot can leak across a restart.
- `main.rs:4506-4510` emits `session.changed` for every recovered session plus the
  `repair_stale_failed_sessions` repairs (`storage:4823-4835`).
- `limited`/`continuation_pending`: `watchdog_due_sessions` + `retry::sweep` continue at most
  three times (`watchdog_enqueue` requires `recovery_count<3`, `storage:3206-3218`), and
  `continue_on_activation` consumes the flag under the activation gate (`retry.rs:584-592`).

### Verdict / change

Two proven gaps, both fixed; the rest verified as already truthful.

1. **A conversation stuck in `retrying`.** `retry::schedule` sets the session `retrying`
   (`retry.rs:364`) and relies on the queue item. If the daemon died while that retry item
   was `sending`, the boot rewrite turned it `failed`; `queue_retry_sessions` only looks at
   `queued|sending` (`storage:3472-3478`) so `retry::reconcile_restart` never touched the
   session and it showed "retrying" for ever with nothing pending. Recovery now moves a
   `retrying` session with no `queued|sending` retry item to `idle` (`storage:4885-4891`,
   after the queue rewrite) and returns it in the settled list, so `session.changed` fires.
2. **Automation sessions carried a flag that can never fire.** `watchdog_enqueue` refuses
   `link.kind='automation'` (`storage:3209`), so setting `continuation_pending=1` at boot was
   a permanent lie for unattended runs. It is now 0 for automation sessions
   (`storage:4863`); their state still becomes `offline`, and `automation_interrupt_running`
   (`storage:4490-4494`) still marks the run `interrupted` (`main.rs:4481`).

Verified as already truthful and left alone: the four live states become `offline` + a
terminal turn with the `watchdogInterrupted` marker (which `delegations.rs:429-435` maps to
an `interrupted` outcome for a lane); the turn reservation table is emptied; `limited`
sessions wait for `retry::sweep`, which stops at `recovery_count<3`.

### Interleaving analysis

- Recovery runs in one `IMMEDIATE` transaction before any task is spawned
  (`main.rs:4433`); the queue rewrite that makes a claimed retry `failed` comes **before**
  the `retrying` pass, so the pass never sees a stale `sending` row.
- `reconcile_restart` (`main.rs:4490`) runs after recovery and sees the same rows: a
  `retrying` session it drops as an overdue retry is already `idle` from recovery or is moved
  by `watchdog_retry_idle`, and neither path touches a session with a live turn
  (`session_busy` is memory-only and empty at boot).
- `session.changed` for the newly idled sessions arrives before the router is built; clients
  read the same state from the snapshot.

### Contract changes

- Session state after a crash: `retrying` with no surviving retry item now settles to
  `idle` (previously it stayed `retrying`).
- `continuation_pending` is not set for automation sessions.

### Decisions not specified

- `idle` (not `completed`, not `offline`) is the truthful label for "no turn is running and
  nothing is waiting": `offline` implies a resumable context waiting to be picked up, which
  is the meaning for the four live states.
- The turn outcome stays `error` + `failureClass:"other"` + `data.watchdogInterrupted`, the
  existing "interrupted-style" vocabulary: `delegations.rs:431-435` matches on
  `watchdogInterrupted` to report `interrupted`, and inventing a new `failure_class` would
  change the analytics buckets (`analytics_failure_class`) and the `session_detail` message
  table.

### Gaps left

- A session in `limited` whose window has passed and whose `recovery_count` is already 3
  stays `limited` with a past `limitedUntil`, and `watchdog_due_sessions` keeps returning it
  every second while `watchdog_enqueue` refuses. Nothing is lost (a user prompt is still
  accepted: only non-user origins are refused while `limited`, `main.rs:3084-3086`), but the
  label is stale and the sweep is a no-op loop. Fixing it means deciding the owner-facing
  wording for "the automatic continuations are used up", so I left it for the Director.
- The same cap makes `continue_on_activation` a silent no-op after the third recovery, with
  `continuation_pending` left at 1. The turn is visibly failed in the transcript, so this is
  not silent abandonment, but there is no dedicated notice.
- A native question card is now closed at boot (item 2) while a `limited` session may still
  show `limitedUntil`; the two are independent state and neither blocks the other.

---

## Item 4 — bounded reads on hot paths

### What each path reads (as found in code)

1. **`app.snapshot`** — `main.rs:945` → `Storage::snapshot` (`storage:5719-5761`). One
   `MAX(sequence)`, all runtimes, and then **for every non-archived session** a
   `session_detail_locked` (`storage:5766-5781`) plus, at the end, all pending permissions,
   a full `SUM` over `usage_events` (all time, `storage:5708-5717`), all settings, all agents
   and all projects. `session_detail_locked` is 6+ queries per session: base row, context
   counters, all turns, all messages **with bodies**, all tool calls, all file changes, and
   a correlated `app_events` subquery **per turn** for the failure detail
   (`storage:5775`). Complexity: Θ(S × (M_s + T_s·E)) before this lane, where S = sessions,
   M_s = messages of a session, T_s = turns, E = rows of `app_events` (append-only, never
   pruned). After the new index it is Θ(S × (M_s + T_s + C_s)) with C_s = context/turn-error
   events of that session. The desktop calls this after every send (`App.tsx:1946, 1973,
   1990, 2093, 2180` via `refresh()` at 865-901).
2. **`session.list`** (`storage:2983-2989`) — one query over `sessions`, with two correlated
   subqueries per row resolving a project label (`json_extract(data,'$.projectId')` by PK and
   `projects.path` **unindexed**). Θ(S × P) before, Θ(S·log P) now.
3. **`session.get`** (`main.rs:1166`) — `session_detail` for one session: Θ(M_s + T_s +
   Tool_s + F_s) with message bodies, which is what the transcript needs. The per-turn
   `app_events` scan inside it was the only unbounded part.
4. **`session_event_summary`** (`storage:3011`, used by every `session.changed` and by the
   boot loop) — one session row plus `session_context_locked` (`storage:6359-6380`), which
   scanned **all** of `app_events` (`json_valid(payload) AND json_extract(...)=?1 ORDER BY
   sequence DESC LIMIT 1`). Θ(E) per call before, now bounded to context-event rows.
5. **Turn-end hooks** (`main.rs:4298` → `team::after_turn` `team.rs:999-1059`):
   `team::after_turn` starts with `session_detail` (the **whole conversation**, only to read
   `link`) on every finished turn; then `delegations::after_turn` (two indexed lookups,
   `delegations.rs:217-220`), `proposals::after_task_turn`, `automations::after_turn`,
   `tasks::after_turn`, `queue::after_turn` (`queue.rs:356-370`: `session_busy` is memory,
   `queue_has_queued`/`queue_claim_next` use `idx_queued_prompts_session`), and
   `retry::after_failed_turn` (`retry.rs:216+`: settings, turn data, one session row twice
   for provider/`link` — now `session_brief` instead of `session_detail` — and quota
   snapshots).

### Verdict / change

Clear wins that change no contract:

- **Indexes** (additive, `CREATE INDEX IF NOT EXISTS`):
  `idx_app_events_type_sequence ON app_events(event_type, sequence)`
  (`storage:1970`) — the context lookup and the per-turn failure-detail lookup become
  index ranges over one or two event types instead of full scans;
  `idx_messages_session_role ON messages(session_id, role)` (`storage:1971`) — message
  counts and existence checks (`storage:2324`, `session_had_provider_turns` 3076, `session_has_user_messages` 3090, `session_auto_title` 3029) are
  index-only;
  `idx_projects_path ON projects(path)` (`storage:464`, in `ensure_team_schema`, because
  `projects` is created there and the base batch runs before it) — the session-list and
  summary label lookups stop scanning every project.
- **Body loads where only fields are read**:
  `Storage::session_brief` (`storage:3002`) reads one session row
  (scalars + `link`); used by `retry::after_failed_turn` (was `session_detail`, `retry.rs:235`,
  `262`) and by `queue::queue_session` (`queue.rs:78-83`), which every queue RPC calls —
  including `session.queue.list`. Those calls were loading the entire transcript to check
  `archived`/`provider`/`link`.

Nothing else was changed: no result shape, no cache.

### Contract changes

- None. `session_brief` is a new internal read; the queue DTO/reply shapes are unchanged by
  this item (item 1 adds `ambiguous`).

### Decisions not specified / left alone

- **`app.snapshot` still reads every message body of every conversation.** Making it
  bounded means changing its result shape (paging or summary-only) or adding a cache; both
  are ruled out by the brief. The indexes remove the unbounded `app_events` part; the
  per-session query count (S × 6) remains. The proper fix is a per-session lazy load in the
  window, which is the Director's call.
- **`team::after_turn` still loads the whole conversation per finished turn** just to read
  `link` (`team.rs:1005`). U2 owns `team.rs`, and the drop-in replacement is the same
  `session_brief` read: `let row = st.db.session_brief(&session_id)` then keep `row["link"]`.
  I did not edit their file.
- `usage_summary_locked` aggregates all `usage_events` on every snapshot; no index can bound
  a full `SUM`, and a cache is forbidden.
- `drain_next` (queue lock) and `due_tick` (per due session) are already bounded by
  `QUEUE_MAX` and the two queue indexes.
- The `app_events` replay read (`storage:2749-2760`) is `sequence > ? LIMIT ?` on the primary
  key; fine.

---

## Existing tests that reference what I changed (names only)

Storage (`crates/bloblex-storage/src/lib.rs`):
`restart_recovery_keeps_native_resume_identity_and_expires_approvals` (asserts
`recover_after_restart() == vec!["s"]`, which is why that function keeps its `Vec<String>`
return and delegates to `recover_restart_state`), `session_delete_cascades_the_prompt_queue_and_restart_fails_interrupted_sends`
(pins the **old** boot error text at line 8371 — see the warning below),
`queued_prompts_order_reorder_update_and_delete_follow_state_rules`,
`p8_previous_database_migrates_and_recovery_is_claimed_once`,
`snapshot_after_reopen_excludes_archived_conversations`.

Daemon (`crates/bloblex-daemon/src/main.rs`):
`p8_killed_turn_continues_on_activation_with_recap_after_resume_failure`,
`send_now_moves_to_front_when_busy_and_sends_when_idle`,
`a_failed_queue_item_can_be_retried_with_send_now`,
`a_failed_send_marks_failed_pauses_and_keeps_the_row`,
`queue_validation_covers_bounds_full_readonly_and_empty_text`,
`queue_send_claimed_requeues_on_conflict`,
`restart_drops_only_overdue_retries`,
`restart_with_the_feature_off_drops_pending_retries_silently`.

**Warning for the Director (one assertion is now stale, and I may not edit tests):**
`crates/bloblex-storage/src/lib.rs:8371`, inside
`session_delete_cascades_the_prompt_queue_and_restart_fails_interrupted_sends`, asserts the
exact old text "Interrupted by a restart. Check the conversation before sending again.".
Item 1(a) changes that text on purpose, so the assertion must become
`QUEUE_AMBIGUOUS_ERROR` (and could additionally assert `settled["ambiguous"] == true`). Every
other assertion above still holds as far as I can read it: no test asserts the full queue DTO
object (they index fields), and `recover_after_restart`'s type is unchanged.

---

## Catalogued behaviour changes (for the release notes)

- A queued send interrupted mid-flight is `failed` with `ambiguous:true` and a plain sentence
  saying it may have reached the agent; resending or editing it requires
  `confirmResend:true`, otherwise `confirmation_required`.
- Pending native approval/question cards are closed at boot with
  `permission.resolved {status:"expired", reason:"daemon_restarted"}` and one transcript
  note per conversation; `mcp:` questions and proposal cards stay open.
- A conversation left `retrying` by a crash no longer stays that way.
- Automation sessions no longer carry a continuation flag that cannot fire.

## Gaps worth a follow-up (summary)

1. Post-acceptance `session_prompt` errors are still recorded as definitive failures (item 1).
2. `app.snapshot` still ships every message body; `team::after_turn` still loads the whole
   conversation per turn (item 4). Both need the Director/U2.
3. A `limited` session with an exhausted `recovery_count` shows a stale `limitedUntil` and the
   sweep re-queries it every second (item 3).

---

## Appendix — tails of each `cargo check -p bloblex-daemon -p bloblex-storage`

Run 1 (first, full dependency build; last 15 lines of 40 captured):

```
    Checking tower-http v0.6.11
    Checking bloblex-security v0.1.0-beta.38 (D:\u3\crates\bloblex-security)
    Checking regex v1.13.1
    Checking sha2 v0.10.9
    Checking rustls-pemfile v2.2.0
    Checking hyper-util v0.1.21
    Checking if-addrs v0.15.0
    Checking tokio-rustls v0.26.6
    Checking hyper-tls v0.6.0
    Checking igd-next v0.18.0
    Checking axum v0.8.9
    Checking reqwest v0.12.28
    Checking bloblex-storage v0.1.0-beta.38 (D:\u3\crates\bloblex-storage)
    Checking bloblex-daemon v0.1.0-beta.38 (D:\u3\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 18s
```

Run 2 (after the queue DTO change; the command prints only what it rebuilt):

```
    Checking bloblex-storage v0.1.0-beta.38 (D:\u3\crates\bloblex-storage)
    Checking bloblex-daemon v0.1.0-beta.38 (D:\u3\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 15.64s
```

Run 3 (after the automation `continuation_pending` change):

```
    Checking bloblex-storage v0.1.0-beta.38 (D:\u3\crates\bloblex-storage)
    Checking bloblex-daemon v0.1.0-beta.38 (D:\u3\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 11.29s
```

Run 4 (after switching `queue_session` to `session_brief`):

```
    Checking bloblex-daemon v0.1.0-beta.38 (D:\u3\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.53s
```

Run 5 (after widening `session_brief`):

```
    Checking bloblex-storage v0.1.0-beta.38 (D:\u3\crates\bloblex-storage)
    Checking bloblex-daemon v0.1.0-beta.38 (D:\u3\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 11.08s
```

Run 6 (final confirmation after the report was written):

```
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.81s
```

No warning was printed by any run. `cargo check --tests` and every test runner were left
unrun on purpose.
