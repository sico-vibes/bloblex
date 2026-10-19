# Phase 2A spec: durable prompt queue and "send later" (backend)

> **What this is:** Spec for phase 2A: a durable prompt queue and "send later" (backend).
> **Status:** historical
> **Last updated:** 2026-10-12

Owner: OpenCode lane (backend only). Reviewer: Director. Parent plan: `docs/plans/improvement-plan.md` Phase 2. The desktop UI is built in parallel by the Director against this contract; do not touch `apps/`.
Scope: `crates/bloblex-storage`, `crates/bloblex-daemon` (new `src/queue.rs`, `main.rs`, `team.rs`), `docs/ipc-contract.md`. No new dependencies.

## Rules
- Work only in this worktree. **Never run `git commit`, `git push`, `git checkout`, `git stash`.** Leave changes uncommitted.
- Cargo: `CARGO_TARGET_DIR=D:/b-p1` and `RUST_MIN_STACK=33554432` (one daemon test overflows the default stack on the base commit; pre-existing, do not fix).
- Match repo style (dense Rust, existing helper names). No `unwrap()` in non-test code you add. Never log or persist tokens or raw provider JSON.
- Existing behaviour not listed here must stay identical. In particular **do not change team delivery semantics**: `Team.queued`, `deliver`, `session_prompt_for_team` and side-conversation relays keep working exactly as today.

## Background (verified at the base commit)
- Prompts are sent with the `session.prompt` RPC (`session_prompt_impl` in `main.rs`). While a turn is live it returns `conflict` ("this session already has an active turn"). Accepted params: `sessionId, text, attachments, conversationRefs, replyTo` (and internal `meta`).
- Team deliveries are queued in memory in `Team.queued` and drained by `team::after_turn`, which runs after `turn.completed|turn.error|turn.cancelled` (Phase 1A made every failure path call it exactly once).
- `ensure_team_schema` in `bloblex-storage` shows the idempotent additive-schema pattern (no ledger/`user_version` bump). Follow it. `recover_after_restart()` is where startup settles interrupted rows.
- Image attachments are re-validated by `prompt_attachments` at send time; keep that.

## Data model
New table via an idempotent `ensure_queue_schema()` (called where `ensure_team_schema` is):
```
queued_prompts(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL,
  params_json TEXT NOT NULL,          -- allowlisted prompt params only (below)
  kind TEXT NOT NULL,                 -- 'user' | 'send_later'
  due_at TEXT,                        -- RFC3339 UTC, null for 'user'
  status TEXT NOT NULL,               -- 'queued' | 'sending' | 'failed'
  error TEXT,                         -- safe, short, user-facing; never raw provider output
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)
```
Index on `(session_id, status, position)` and `(status, due_at)`. Rows must be deleted when their session is deleted (delete explicitly in the session-deletion path if foreign keys are not enforced). Sent items are **deleted**; the sent prompt appears as an ordinary message.
`params_json` stores only these keys from the request: `text`, `attachments` (array of `{path,name}`), `conversationRefs`, `replyTo`. Anything else is dropped. Validate at enqueue time exactly like `session.prompt` does (text or attachments present, text <= 1,000,000 bytes, attachments parse via `prompt_attachments`).

## RPCs (register next to `session.prompt`; params are objects)
All return the item DTO below where an item is returned, and emit `queue.changed` after any mutation.
- `session.queue.add {sessionId, text, attachments?, conversationRefs?, replyTo?, dueAt?}` -> `{item}`.
  - `dueAt` (RFC3339) makes `kind='send_later'`; it must be at least 5 seconds in the future and at most 366 days out, else `invalid_argument` ("Pick a time between a few seconds and one year from now.").
  - Errors: `not_found` (missing or archived session), `read_only` (side conversations, same wording as `session.prompt`), `unsupported` (attachments on a provider that does not accept them, same check as `session.prompt`), `conflict` with message "The queue is full." at 20 queued items per session.
  - It does not require the session to be busy. The UI decides when to queue vs send.
- `session.queue.list {sessionId}` -> `{items:[Item], paused:boolean}` ordered: due send-later first by `due_at`, then by `position`.
- `session.queue.update {sessionId, id, text?, dueAt?}` (`dueAt: null` converts to a plain queued item). Only `status='queued'` items; otherwise `conflict`.
- `session.queue.reorder {sessionId, ids:[...]}`: `ids` must be exactly the set of that session's `queued` plain items; otherwise `invalid_argument`.
- `session.queue.delete {sessionId, id}`: only `queued` or `failed`; otherwise `conflict`.
- `session.queue.send_now {sessionId, id}`: if the session is idle, send that item now; if busy, move it to position 0 and return `{queued:true}` (it must NOT steer or interrupt).
- `session.queue.resume {sessionId}`: clears `paused` and, if idle, drains the next item. `failed` items stay until deleted or sent with `send_now`.
Item DTO (camelCase): `{id, sessionId, text, attachments:[{name,path}], conversationRefs:[string], replyTo?:object, kind, dueAt:string|null, status, error:string|null, position:number, createdAt, lateBySecs?:number}`.
Event `queue.changed` payload: `{sessionId, items:[Item], paused:boolean}` (full list for that session). Add a short entry for the RPCs and the event to `docs/ipc-contract.md`.

## Drain and pause rules
Add the drain call in/next to `team::after_turn` (or a hook it calls) so it runs once per finished turn:
1. After `turn.completed`: if the session is idle and not paused, send the next item. **Priority order:** due `send_later` items, then plain queued items by `position`. User queue goes before `Team.queued` deliveries (those still drain exactly as today, afterwards).
2. After `turn.error` or `turn.cancelled`: set `paused = true` for that session if it has queued items, and emit `queue.changed`. Nothing auto-sends. (A user who pressed Stop or whose turn failed must not have the next prompt fire unexpectedly.)
3. `paused` is in-memory per session. On daemon start, every session that has `queued` plain items starts paused. Due `send_later` items are exempt from pause: they fire when due and the session is idle.
4. Sending an item: atomically flip `queued -> sending` (`UPDATE ... WHERE status='queued'`, check rows affected), then call the same function `session.prompt` uses with the stored params (user path, not the internal team path). On success delete the row. On error set `status='failed'` with a short safe message (use the `DispatchError` message; never raw provider text), set `paused = true`, emit `queue.changed`.
5. Per-session drain must be serialized (a lock or single-flight) so two triggers (turn end + due tick + `send_now`) can never send the same item twice or two items at once.
6. A due-time loop runs in the daemon (spawn in `run()` next to the existing background loops) every 1 second: for each `queued` `send_later` item with `due_at <= now` whose session is idle, send it. If the session is busy, leave it; it is drained first at the next turn end. `lateBySecs` in the DTO is derived (now minus `due_at` when positive, never stored). If the item is more than 60 seconds past `due_at` when it sends, then after a successful send append a transcript notice with the existing `team::note` helper: role `notice`, content `Scheduled message sent N min late.` (N rounded, at least 1), meta `{"kind":"queue_late","lateBySecs":N*60}`.
7. Startup: in the daemon's startup recovery, any `sending` row becomes `failed` with error `Interrupted by a restart. Check the conversation before sending again.` Never auto-resend after a restart.
8. Queue mutation RPCs on a session that was deleted or archived return `not_found`.

## Tests (required; deterministic, in-memory storage, existing fake adapters)
Storage: schema idempotent twice; add/list ordering (due first, then position); reorder permutation validation; update/delete state rules; cascade/explicit delete on session delete; `sending` -> `failed` on startup settle.
Daemon:
1. Queue add while busy, then `turn.completed` sends the next item exactly once; the queue event shows the item removed.
2. `turn.error` and `turn.cancelled` pause the queue and send nothing; `session.queue.resume` sends the next item; a second queued item still waits for the next completed turn.
3. A due `send_later` item fires when idle and bypasses pause; when busy it fires first at the next completed turn; late items append the notice exactly once.
4. `send_now` on a busy session moves the item to front and does not send; on an idle session sends immediately.
5. Failed send (e.g. archived session or rejected attachment) marks `failed`, pauses, keeps the row.
6. Serialization: two simultaneous drain triggers send one item once.
7. Validation: `dueAt` bounds, queue-full at 20, read-only side session, empty text.
8. Team deliveries still drain after the user queue, unchanged (extend the existing team queue test or add one).
9. All pre-existing tests pass unchanged.

## Gates (run and report real output)
```
CARGO_TARGET_DIR=D:/b-p1 RUST_MIN_STACK=33554432 cargo test -p bloblex-storage -p bloblex-daemon -p bloblex-agent-core -p bloblex-adapter-claude -p bloblex-adapter-codex -p bloblex-adapter-acp
```
Clippy is already failing on base; only avoid adding new findings.

## Final report (plain text, last message)
1. Files changed (one line each). 2. For each section above: what you did and the exact test names. 3. Gate output summary per crate. 4. Anything unverified, any spec/source mismatch, and decisions you made where the spec was silent. Fake-peer verified only; do not claim live-CLI verification.
