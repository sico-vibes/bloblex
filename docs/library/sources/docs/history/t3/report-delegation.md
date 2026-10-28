# Lane DELEGATION — report

Worktree `D:\t3d` (branch `t3/daemon`). Files touched: `crates/bloblex-daemon/src/delegations.rs`,
`crates/bloblex-daemon/src/team.rs`, `crates/bloblex-daemon/src/workspace.rs` (new),
`crates/bloblex-storage/src/lib.rs` (delegation ledger only), `crates/bloblex-daemon/src/main.rs`
(four small anchors plus the one extracted helper the brief allows).

**I ran no tests.** No `cargo test`, no `--tests`, no clippy `--all-targets`, no vitest, no
scratch probes, no browser. Only the two `cargo check` commands the brief allows (output at the
end). No git writes: everything is left in the working tree.

Note on the working tree: `main.rs`, `team.rs` and `storage/lib.rs` already carried another lane's
uncommitted changes when I started (`git diff --stat` shows far more than my edits). I only edited
the regions listed below and left everything else alone.

---

## Item 1 — the started/terminal race

**Finding.** The race is real, and `team::after_turn` is a `tokio::spawn` (main.rs:4280), so it
genuinely runs concurrently with the delivery path. `deliver()` (team.rs:808) calls
`session_prompt_for_team` and only then `delegations::started`. A turn that ends first makes
`after_turn` see a `queued` row, return early, and then `started` flips it to `running` with nothing
left to end it — a card stuck on "working" forever.

**Changed.**
- `delegations.rs:240` `turn_outcome()` — the classification `stopped_outcome()` used, split out so
  it can be reused: `completed`, `cancelled`, `error|failed` (with the turn's `failureMessage`, or
  `interrupted` + the restart sentence when `watchdogInterrupted` is set), and `None` while the turn
  is still live. It also returns `None` for an empty turn id.
- `delegations.rs:231` `stopped_outcome()` is now `turn_outcome(...).unwrap_or(interrupted)` — the
  restart path keeps exactly the old behaviour, including `interrupted` when the side session or
  its turn cannot be read.
- `delegations.rs:84` `started()` marks the row running, emits, returns early if the row is no
  longer `running` (a terminal row is never rewritten), skips the read-back when the turn's
  `retryDecision` is already `retry` (otherwise it would finish a turn an automatic retry is about
  to continue), and otherwise reads the turn back once and finishes the row with its real outcome.
  Bounded (one read), idempotent (`delegation_mark_terminal` only moves `queued|running` rows).
- `delegations.rs:99` `adopt()` — mark-running + emit without the read-back. `after_turn`'s retry
  path (`delegations.rs:149`) uses this and **not** `started`, because it adopts a turn that has
  *already ended*; a read-back there would kill the row before `retry_scheduled()` could keep it
  running. This was a bug I introduced and then removed while implementing.
- `delegations.rs:133-141` — documented invariant on `after_turn`: a `queued` row owns no prompt
  yet, so its ending is decided by the `started` re-read and never guessed here (the early return
  for non-`running` rows is kept, now returning `TurnEnd::Owed(row)` so the reply is still owed).

**Invariants relied on.** `delegation_mark_running`/`delegation_mark_terminal` only move rows out of
`queued|running`, so a duplicate ending can never rewrite a terminal row; `turns` rows are written
before their end event is emitted, so a read-back after the event always sees the final state.

**Cost noted.** The read-back uses `session_detail` (the same source as `stopped_outcome`), which
builds the whole side transcript under the DB mutex — once per delivery. I chose that over a new
narrow SQL read to keep one source of truth for the failure message; a `delegation_side_turn`-style
narrow read is the obvious optimisation if it ever shows up in profiles.

---

## Item 2 — durability and duplicates

What I checked and what I changed:

1. **One row delivered twice.** `restore_queued`, `queue_delivery` and `requeue_front` all pushed
   straight onto the `VecDeque`. Added `team.rs:44` `same_delivery()` and `team.rs:51` `enqueue()`,
   which refuses a second item with the same `delegationId` **and** the same `meta.kind` (a brief
   and its reply live in different queues, but the kind keeps them apart regardless). All three
   push sites now go through it (`team.rs:92`, `team.rs:858`, `team.rs:879`).
2. **A cancelled brief must never be delivered.** `team.rs:886` `stopped_delegation()` reads the
   row of a popped forward delivery (`kind == "blob_message"` only — a reply carries the id of a row
   that is terminal by definition) and the drain (`team.rs:895`) drops such items silently in a
   loop, so the next item is still tried. `cancel_queued` (`team.rs:97`, used by
   `delegation.cancel`) removes the item outright as well, so both the fast path and the queue are
   closed.
3. **The reply relay sent twice.** There was **no existing guard**: `team::after_turn` relayed
   whenever the link was a side conversation, whatever the ledger said. New once-only guard: the
   row's `reply_state` column. `delegations::claim_reply` (`delegations.rs:50`) is one atomic
   `UPDATE ... SET reply_state='pending' WHERE id=?1 AND reply_state IS NULL`; only the caller whose
   update changed a row relays (`team.rs:946-950`). A turn no assignment tracks (the existing
   "reply to a busy origin" test path) or one an automatic retry continues has nothing to claim and
   still relays, as before.
4. **Result durability.** New nullable column `reply_state` on `delegations`, added by a guarded
   `pragma_table_info` + `ALTER TABLE` in `ensure_delegation_schema` (`storage/lib.rs:997`), the
   same idempotent pattern `ensure_tasks_schema` uses. Values: `NULL` (no reply owed yet),
   `pending` (owed/claimed, possibly still queued), `delivered`. Helpers
   `delegation_reply_claim` (`storage/lib.rs:3542`), `delegation_reply_settle`
   (`storage/lib.rs:3553`) and `delegation_pending_replies` (`storage/lib.rs:3566`).
   - Live path: claim → relay → settle `delivered` only when the delivery actually went out
     (`team.rs:960-963`); a queued reply stays `pending`.
   - Boot path (`delegations.rs:210-224`): for a **`completed`** row whose `reply_state` is
     `pending`, read the text from `st.db.turn_reply(side, sideTurnId)` again (never stored), and
     re-offer it **as a queued delivery** — `delegations::startup` runs before the team MCP address
     exists (main.rs:4468 vs 4483), so prompting there would attach a bridge with no address. The
     existing boot drain (main.rs:4488) sends it, and the drain settles the row `delivered` when it
     really leaves the queue (`team.rs:900`, `delegations.rs:62`).
   - Bounded: the row stores only the two words; the reply text is re-read.
   - **Not recovered:** `failed`/`cancelled` replies. The brief scopes recovery to `completed`, and
     the failure wording lives in the live hook's `detail`; recovering those would mean a second
     copy of that wording. A `pending` flag can therefore linger on a `failed` row; nothing reads
     it.
   - **Exactly once, honestly:** within one boot the offer happens once (the item is in the
     in-memory queue and deduped by `delegationId`). If the daemon is killed between the offer and
     the drain, the row is still `pending` and the next boot offers it again — it cannot duplicate a
     reply that was never sent, but a crash between `deliver` returning `Sent` and
     `delegation_reply_settle` could.

**Decision the brief left open.** `delegationIds` is accepted as the alternative filter of
`delegation.cancelGroup` (see item 3), and `reply_state` is deliberately **not** added to
`DELEGATION_COLUMNS`, so the wire shape of `delegation.list` is unchanged (no other lane's DTO
assertions can break on a new key). If the UI wants to show "reply pending", add
`'replyState',reply_state` to `DELEGATION_COLUMNS` — one line.

**One trap I hit and closed.** Attaching `delegationId` to the reply meta (needed for the once-only
claim and dedupe) made `deliver()` treat a reply as the assignment's own delivery: it would call
`delegations::started` / `failed` on the row from the *Manager's* turn id. `deliver`
(`team.rs:816-819`) now only treats the id as an assignment for non-`blob_reply` deliveries.

---

## Item 3 — stop RPCs

- `delegations.rs:276` `delegation.cancel { delegationId }` → `{ delegation: <dto> }`.
- `delegations.rs:284` / `delegations.rs:297` `delegation.cancelGroup { originSessionId,
  originTurnId }` → `{ delegations: [...] }`, oldest first, and `delegationIds: [String]` is
  accepted in place of `originTurnId`; neither → `invalid_argument`.
- Arms registered in `main.rs:832` (`"delegation.list" | "delegation.cancel" |
  "delegation.cancelGroup"`), one line changed next to the existing arm.
- `delegations.rs:331` `cancel_row()` is the single rule:
  - terminal → returned unchanged (not an error);
  - `queued` → `st.team.cancel_queued(side, id)` then `finish(..., "cancelled")`, which clears
    `delivery_text` and emits `delegation.updated` (the brief never goes out);
  - `running` and the side session's *currently active* turn **is** `sideTurnId` →
    `crate::cancel_session_turn`, and the row is returned as it stands (`running`), because
    `after_turn("turn.cancelled")` is what marks it — nothing is force-marked before the turn ends;
  - `running` but its own turn is already over → finished with that turn's **real** outcome
    (`completed`/`cancelled`/`failed`), not silently relabelled `cancelled`;
  - `running` with no live turn of its own left → `cancelled`.
  - Guard `origin != side`: a delegation is never messaged to its own session, but the belt is
    there: `delegation.cancel` can never cancel the Manager's own turn.
- `delegations.rs:316` `group_member()` keeps a group call to one Manager conversation and one
  origin turn (or the named ids); other rows are never touched. Rows whose turn is live but not
  this assignment's are answered unchanged.
- Shared cancel path: the `session.cancel` arm body was moved verbatim into
  `main.rs:2541` `pub(crate) async fn cancel_session_turn(st, id)` and the arm is now a one-line
  call (`main.rs:1186`). That is the one extra main.rs change the brief allows; no behaviour change
  for `session.cancel` (same retry cancellation, same starting-turn handling, same errors).
- Errors: unknown id → `not_found` (via `storage_error`), wrong shape → `invalid_argument`.
- Return shape of the group call: I answer with **the rows the call was about** (matching origin
  turn or named ids), after the attempt, oldest first — not every row of the conversation. Say so
  to the UI lane if it expects the whole list.

---

## Item 4 — workspace report

New `crates/bloblex-daemon/src/workspace.rs`, registered as `main.rs:1170`
`"session.workspace" => workspace::rpc(st, &p).await` next to `"session.repository"`, and
`mod workspace;` at `main.rs:63`.

Contract implemented exactly as specified: `sessionId`, `mode` (`shared|isolated|unknown`),
`projectPath`, `isGit`, `repoRoot`, `branch`, `head`, `worktree` (`{path,branch,base,baseCommit,
repo}` or null), `isolationFailure`, `sharedWith` (`[{sessionId,agentId,state}]`).

- `isolated` only when `link.worktree` is an object **and** its `path` canonicalizes to the same
  folder as `projectPath` (`folder_key`: `std::fs::canonicalize` falling back to
  `worktree::normalize`, so case, separators, short names and junctions all compare equal).
  Otherwise `shared`; `unknown` only with no project path.
- `isGit`/`repoRoot`/`branch`/`head` come from three concurrent read-only git calls
  (`rev-parse --show-toplevel`, `--abbrev-ref HEAD`, `--short HEAD`), each run through
  `crate::experiments::git_command()` in `tokio::task::spawn_blocking`, with `--no-optional-locks`,
  `current_dir` = the project folder, stdin null, stderr null, the git environment variables
  cleared, `GIT_TERMINAL_PROMPT=0`, and a 5 s `tokio::time::timeout` cap. Output is read to branch
  on it and never logged. `branch` is null for a detached HEAD (git says `HEAD`).
- `sharedWith`: non-archived conversations *other* than this one whose `projectPath` resolves to the
  same folder and whose stored state is `starting|working|waiting_permission`.
- `isolationFailure`: read from `link.worktreeError`, capped to one line / 200 chars.
- Read-only: nothing writes to the repository or the worktree.

**Making the failure visible** (`team.rs:235-286`, `team.rs:642-651`). `prepare_worktree` returned
`None` for three different things. It is now `prepare_worktree_attempt` returning
`WorktreeAttempt { worktree, error }`, and `delegate` stores `link.worktreeError` only when
isolation was *tried and failed*:
- research bot, no clash, or a folder with no `.git` entry → **not applicable**, no error (a folder
  that looks like a repo but whose `repo_root` fails is treated as "git unavailable" and *is*
  recorded — that is the `.git`-entry test);
- `worktree::create` returning `Err` (detached HEAD, no parent folder, no free name, `git worktree
  add` failed, the family folder could not be created) → its own one-line sentence, scrubbed of the
  home-folder path (`short_reason`), capped at 200 chars;
- the `create` task itself failing to join → "The separate copy of the project could not be made.".
`prepare_worktree` remains as a `#[cfg(test)]` shim with its old signature so
`team_p10_tests.rs` still compiles (see the stale list).

**Could not verify:** no browser, no app run, and no git repository fixtures were created, so the
`isolated`/`sharedWith`/`isolationFailure` paths are source-reviewed only. `D:\t3d` itself is a git
repo, so a manual `session.workspace` call against a live daemon is the cheap confirmation.

---

## Files that must change outside my ownership

1. `apps/desktop/src/remote/tiers.json` — the remote parity test extracts every arm of
   `dispatch()` and fails any method with no `METHOD_RULES` entry. My three new methods need rows:
   `delegation.cancel`, `delegation.cancelGroup` and `session.workspace`. `delegation.list` there is
   `class: "never"` ("absolute workspace and worktree paths … remote redaction does not reduce
   yet"); the same reasoning applies to all three, though `session.workspace` is a good candidate
   for `viewer` once the redaction question is settled.
2. `docs/ipc-contract.md` — `delegation.cancel`, `delegation.cancelGroup`, `session.workspace`, and
   the new `reply_state` invariant, are undocumented today (`docs/` is off-limits to this lane).
3. If the UI wants the reply state on the delegation DTO, add `'replyState',reply_state` to
   `DELEGATION_COLUMNS` in `crates/bloblex-storage/src/lib.rs:1002` (my lane deliberately left the
   wire shape unchanged).

## Existing tests / fixtures affected (not edited)

- **Signature kept only for tests:** `crates/bloblex-daemon/src/team_p10_tests.rs:85, 90, 96, 98,
  203` call `crate::team::prepare_worktree(...)` and assert `is_none()`/`is_some()`. The real
  function is now `prepare_worktree_attempt`; `prepare_worktree` survives as a `#[cfg(test)]`
  one-line shim with the same signature, so those tests compile and mean what they meant.
- **Signature changed, no test calls it:** `delegations::after_turn` now returns
  `delegations::TurnEnd` (only `team.rs:940` calls it). `delegations::finish` returns the row
  (module-private).
- **Semantically re-checked, expected to still pass:** `main.rs`
  `row_repeated_refused_drains_write_one_waiting_notice` (drain/requeue order, still one notice) and
  `row_a_reply_to_a_busy_origin_adds_no_waiting_notice` (no ledger row → `TurnEnd::Ungoverned` →
  relayed and queued silently, as before). `row_a_drain_releases_another_conversations_delivery`
  uses `enqueue_for_test` (no `delegationId`) so the new terminal check never fires.
- Nothing in `crates/bloblex-storage` tests the delegation ledger, so the new column does not make
  a storage test stale.
- Stale-by-design, left untouched as instructed: none found.

## Decisions the brief did not specify

- `delegation.cancel` of a `running` row whose turn is already over finishes it with the turn's
  real outcome instead of `cancelled` (reporting a lie would be worse than reporting the truth).
- If `cancel_session_turn` refuses (e.g. `not_found`), the row is marked `cancelled` directly,
  because otherwise it would stay live with no turn left to end it.
- The drained reply settles `delivered` at the point it leaves the queue.
- Group cancel answers with the rows it was about, not the whole conversation.

## Verification (the only commands run)

```
> cargo check -p bloblex-storage --message-format short
    Checking bloblex-storage v0.1.0-beta.38 (D:\t3d\crates\bloblex-storage)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.29s

> cargo check -p bloblex-daemon --message-format short
    Checking bloblex-daemon v0.1.0-beta.38 (D:\t3d\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.89s
```

Both clean: no warnings, no errors. (`Select-String -Pattern 'error|warning'` over the full daemon
check output returned nothing.) **No tests were run.**
