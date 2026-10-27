# Lane A report: chart/table instructions, child-request wake, durable failed/cancelled replies

Worktree `D:\t4a`, branch `t4/delegation`. No tests were run of any kind (no `cargo test`,
`cargo check --tests`, `cargo clippy --all-targets`, `npm test`, no test target compiled, no test
block added, edited or deleted). No git write of any kind was made (no commit/add/push/reset/stash/
checkout/rebase). No process was started beyond `cargo check`; no app, browser or screenshot was used.

Only these files were edited: `crates/bloblex-daemon/src/team.rs`,
`crates/bloblex-daemon/src/delegations.rs`, `crates/bloblex-daemon/src/questions.rs`,
`crates/bloblex-storage/src/lib.rs`, `crates/bloblex-daemon/src/main.rs` (one added block inside the
`AgentEvent::PermissionRequested` arm, nothing else), plus `target/lane/report.md` and
`target/lane/worklog.md`.

---

## Item 1: chart and table schemas in `runtime_instructions`

**Changed**

- `crates/bloblex-daemon/src/team.rs:298-315` — new `const CHART_TABLE_INSTRUCTIONS: &str`, built with
  `concat!` from the brief's text verbatim (real newlines, literal ``` fences). The two JSON
  examples are raw string literals so their quoting is byte-identical to the brief; the table example
  uses `r##"…"##` because it contains `"#12"` (an `r#"…"#` literal would have terminated early).
- `crates/bloblex-daemon/src/team.rs:350-353` — `lines.push(CHART_TABLE_INSTRUCTIONS.into());`, placed
  after the teammate/delegation/`list_conversations` lines and before the `link["kind"] == "side"`
  block, so every bot (Manager, ordinary bot, side and task conversations) gets the same block.
- `crates/bloblex-daemon/src/team.rs:339` — Manager-only line, verbatim from the brief:
  `A message that starts with [Update from NAME] means a teammate is waiting … do not try to answer
  for them, approve anything, or send the task again.` It sits in the `systemRole == "manager"` branch
  after the notes/playbook line.
- No tool description was touched.

**Invariants relied on**: `runtime_instructions` joins `lines` with `\n` inside `<bloblex_team>`, so a
single multi-line push renders exactly as the brief's block, blank lines included. The text is the
contract with `apps/desktop/src/ui/richData.ts`; the fences, field names, limits and examples are
unchanged from the brief.

**Left open by the brief**: none material. I added no blank `String::new()` separator, so the block
follows the last delegation line directly, exactly as "placed after … and before …" reads.

---

## Item 2: a child's pending approval/question wakes its Manager, once, with no authority

**Changed**

- `crates/bloblex-storage/src/lib.rs:999-1002` — nullable column `wake_request TEXT`, added with the
  same idempotent `pragma_table_info` guard `reply_state` uses. Not added to `DELEGATION_COLUMNS`, so
  it never reaches the wire DTO.
- `crates/bloblex-storage/src/lib.rs:3567-3579` — `delegation_wake_claim(id, request_id) -> Result<bool>`:
  one atomic `UPDATE delegations SET wake_request=?2 WHERE id=?1 AND status='running' AND
  (wake_request IS NULL OR wake_request != ?2)`, returns `changed == 1` (empty request id → `false`).
- `crates/bloblex-daemon/src/delegations.rs:191-194` — `active_turn()` (reads `st.active_turns`).
- `crates/bloblex-daemon/src/delegations.rs:196-222` — private `struct Update` plus
  `fn spawn_update(st, Update)`, which delivers the notice from its own task (see the E0391 note below).
- `crates/bloblex-daemon/src/delegations.rs:224-274` — `pub(crate) async fn attention(st,
  side_session_id, request_id, request_kind, title)`:
  1. row = `delegation_find_for_side_turn(side, active turn)` else `delegation_latest_open_for_side(side)`;
     returns unless `status == "running"`;
  2. origin = `session_detail(side).link.originSessionId`; returns if empty, equal to the side session,
     or `!session_exists(origin)`;
  3. `delegation_wake_claim` — only a claim that changed a row goes on;
  4. title = `one_line(title)` truncated to 160 chars; text and meta exactly as briefed
     (`{"kind":"blob_update","fromAgentId","fromName","sideSessionId","delegationId","requestId",
     "requestKind","title"}`), carried at the side conversation's hop depth and sent through
     `team::deliver_update` → `deliver` (the same path as `deliver_reply`).
- `crates/bloblex-daemon/src/team.rs:44-52` — `same_delivery` now also compares `meta["requestId"]`,
  so two different requests on one assignment are both delivered and one request is never queued
  twice. Briefs and replies have no `requestId` on either side (both `Null`), so their dedupe is
  unchanged.
- `crates/bloblex-daemon/src/team.rs:846-857` — `deliver` treats `blob_update` like `blob_reply`: a
  delivery carrying a `delegationId` starts/fails the assignment only for a forwarded brief.
- `crates/bloblex-daemon/src/team.rs:86-90` — `Team::depth_of(session_id)`, so `delegations.rs` can
  read the hop depth without touching `team`'s private map.
- `crates/bloblex-daemon/src/team.rs:877-898` — `deliver_update` next to `deliver_reply`, building
  the `blob_update` meta and calling `deliver(..., retry = false)`.
- `crates/bloblex-daemon/src/team.rs:932-938` (doc comment on `stopped_delegation`) — states that an
  update carries a running assignment's id and is never dropped there. The function itself is
  unchanged: it only ever drops `blob_message`, so an update for a running assignment always goes out.
- `crates/bloblex-daemon/src/main.rs:4053-4063` — inside `AgentEvent::PermissionRequested`, after the
  policy auto-resolution attempt (which `continue`s when it succeeds) and the automation auto-deny
  block, and only when `inserted.is_ok() && !auto_approved && !is_automation &&
  session["link"]["kind"] == "side"`, `attention(..., "approval", &title)` is spawned. Nothing about
  the request is resolved, answered or dismissed; the arm's own `permission.requested` payload and
  the auto paths are untouched.
- `crates/bloblex-daemon/src/questions.rs:104-108, 125-129` — at the end of `ask_user_tool`, after the
  question is recorded and `permission.requested` is emitted, `attention(..., "question", &title)` is
  spawned; its result is ignored and the tool still returns `SHOWN` immediately.

**Invariants relied on**: `claim_reply`'s slot pattern (one atomic conditional UPDATE wins once) is
mirrored by `delegation_wake_claim`; `deliver` already queues behind a busy session and writes no
"Waiting for" notice for a non-`blob_message`, so an update from a busy teammate queues silently; the
row is only ever read here, never written except the `wake_request` claim; the title is the caller's
short title (permission `title`, question `title`) only, so no command, diff or tool input can reach
the Manager's chat.

**Decision the brief left open — E0391 (important)**: with the call sites added, `cargo check` failed
with `error[E0391]: cycle detected when computing type of opaque session_prompt_impl::{opaque#0}`. The
new path closes a genuine type cycle: `session_prompt_impl` → `run_turn` → spawned
`forward_events` → `attention`/`deliver_update` → `deliver` → `session_prompt_for_team` →
`session_prompt_impl`. `tokio::spawn` does not erase the spawned future's type, and `Box::pin(… as
Pin<Box<dyn Future…>>)` does not help either, because the concrete type still has to be computed.
The fix is a *synchronous* spawner, `delegations::spawn_update`, whose signature is `fn(…) -> ()`:
`attention` no longer awaits the delivery path, so its future type ends at the spawner's signature and
the cycle is gone. This also satisfies "must not delay or fail the request itself": the claim is
durable before the task is spawned, and a slow or busy Manager only delays the notice.

Other decisions: the update's hop depth is the side conversation's current depth (`Team::depth_of`),
mirroring `after_turn`'s reply depth, because `deliveryDepth` is deliberately not in the delegation
DTO. The wake is claimed before delivery, so a queued notice that never leaves the queue is not
re-sent for the same request (the brief asks for "once per request", not "once delivered"). In
`main.rs` the request kind is always `"approval"` — `AgentEvent::PermissionRequested` never carries a
question, which travels through `questions.rs`.

**Known reachability gap (not a deviation)**: `ask_user_tool` refuses side conversations
(`crates/bloblex-daemon/src/questions.rs:91-93`), so today a *question* left pending in a side
conversation cannot occur; the hook is wired as the brief requires and becomes live if that refusal is
ever relaxed. Approval requests in side conversations do occur and are the live path.

---

## Item 3: failed and cancelled replies survive a restart

**Changed**

- `crates/bloblex-daemon/src/team.rs:980-994` — new `pub(crate) fn reply_text(outcome_kind,
  reply_or_detail)`: `completed` → the reply (or `(finished without a text reply)`), `cancelled` →
  `The task was cancelled before it finished.`, anything else → `The turn failed: {detail}` with
  `the provider reported an error` when the detail is empty/missing. Blank/whitespace-only text is
  treated as missing.
- `crates/bloblex-daemon/src/team.rs:1022-1034` — `after_turn` maps `turn.completed` /
  `turn.cancelled` / other → `completed` / `cancelled` / `failed`, reads the turn's stored reply only
  for a completion, and calls `reply_text`. Same `[Reply from NAME]` prefix, same meta, same
  `settle_reply(delivery == Sent)`.
- `crates/bloblex-storage/src/lib.rs:3581-3590` — `delegation_pending_replies` widened to
  `status IN ('completed','failed','cancelled') AND reply_state='pending'` (still `ORDER BY
  created_at,rowid`, still no reply text stored), and its select now also returns `status` and `error`
  so the re-offer can recompose the right wording. `interrupted` stays out.
- `crates/bloblex-daemon/src/delegations.rs:292-318` — `startup` re-offers every such row: a
  completion re-reads `turn_reply` (a missing turn now falls back instead of skipping the row), a
  cancellation uses the fixed sentence, a failure uses the row's `error` column with the same
  fallback. Same `[Reply from NAME]\n{reply}` text and meta as the live path, queued through
  `restore_queued`, settled to `delivered` by the existing drain (`settle_queued_reply`).
- Stale comments corrected: the startup block no longer says "a completed assignment", and
  `delegation_pending_replies`'s doc now names failed/cancelled and says why `interrupted` is not
  re-offered.

**Invariants relied on**: `reply_state` is only set to `pending` by `delegation_reply_claim`, which is
only called in `team::after_turn` for an `Owed` row, and is only settled by the live delivery or the
drain — so the widened query can only pick up endings that really owed a reply. `delegation_create`,
`mark_running` and `mark_terminal` are unchanged; a row's stored `error` is already one line and
bounded at 300 chars by `mark_terminal`.

**Left open**: a completed row whose turn id or stored reply is gone now produces the "(finished
without a text reply)" body instead of being skipped. That is the wording the live path already used
when the turn had no text, so the two paths stay identical; it also means no owed reply can be lost
silently at boot.

---

## Verification (only the two allowed commands)

```
PS D:\t4a> $env:RUST_MIN_STACK='33554432'
PS D:\t4a> cargo check -p bloblex-storage --message-format short
```

last 15 lines (the output was shorter):

```
    Checking bloblex-storage v0.1.0-beta.38 (D:\t4a\crates\bloblex-storage)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.95s
```

```
PS D:\t4a> cargo check -p bloblex-daemon --message-format short
```

last 15 lines (the output was shorter):

```
    Checking bloblex-storage v0.1.0-beta.38 (D:\t4a\crates\bloblex-storage)
    Checking bloblex-daemon v0.1.0-beta.38 (D:\t4a\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.80s
```

Both crates were re-checked after touching every edited source file (so a cached "Finished" could not
hide a warning). No warnings are reported; none were introduced. `cargo clippy` was not run (the brief
forbids `--all-targets`, and no clippy run was asked for); `deliver_update` carries
`#[allow(clippy::too_many_arguments)]`, matching the existing precedent in `main.rs`.

## Existing tests that this change makes stale

**None that I could find**, and I edited no test code. Specifically checked by reading:

- `crates/bloblex-daemon/src/team_p7_tests.rs:92-94` — only `contains` assertions on instructions; the
  new block contains neither `message_blob`-removal phrasing nor the string it asserts is absent.
- `crates/bloblex-daemon/src/team_p7_tests.rs:171-175` — asserts two calls to `runtime_instructions`
  are equal; the new text is constant, so it stays equal.
- `crates/bloblex-daemon/src/main.rs:4999-5003` and `main.rs:6337` — assert the live reply relay
  (`"[Reply from Mate]\nhandled: Check the build"` and "contains `The turn failed`"); both wordings
  are preserved by `reply_text`.
- No test refers to `delegation_pending_replies`, `reply_state`, `wake_request`, `blob_update` or
  `same_delivery` (searched the whole crate tree), so the widened query and the extra dedupe key have
  no test asserting the old behaviour.

## What I could not verify (no tests, no app, no browser)

- Runtime behaviour of all three items: that a side conversation's pending approval really wakes the
  Manager once, that the queued update drains, that the boot re-offer of a failed/cancelled row sends
  and settles, and that the new instruction text renders as the two block types in the desktop
  renderer. Only compilation was verified.
- The E0391 fix is verified only in that `cargo check` compiles; the spawned notice task's ordering
  relative to the request itself was reasoned from the code, not observed.
- The question path of item 2 is unreachable today (see the reachability gap above) and so was not
  exercised even in principle.
