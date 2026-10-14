# FIX8: delegation chips appear below the reply that follows them

Written 14 October 2026. Backend only (`crates/bloblex-storage`,
`crates/bloblex-daemon`, and their tests). No `apps/` edits.

## 1. Symptom (owner)

A user asks a blob to ask another blob something. The conversation reads:

1. user: "Can you ask Blob'si what model they are?"
2. assistant: "I asked Blob'si what model they're using. They'll reply here when
   they respond."
3. chip: "Messaged Blob'si"
4. chip: "Message from Blob'si"
5. assistant: "Blob'si couldn't answer because ..."

Expected order: user, **"Messaged Blob'si"**, assistant "I asked ...", **"Message
from Blob'si"**, assistant "Blob'si couldn't answer ...". The chip for the call
must sit above the text that follows the call.

## 2. Cause (read from the code)

- All assistant text of one turn is appended to **one** message row.
  `Storage::append_typed_message_delta` (`crates/bloblex-storage/src/lib.rs`
  ~line 2676) finds the turn's existing assistant row and appends; a row is
  created, with the next `sequence`, only when the turn has none.
- The "Messaged X" chip is a `notice` message written by `team::note`
  (`crates/bloblex-daemon/src/team.rs` ~line 539, called from the `message_blob`
  tool handler ~line 446) via `append_message_with_data`, which also takes the next
  `sequence`.
- So when the model streams any text **before** it calls `message_blob` (even a
  short preface or a leading whitespace/commentary delta), the assistant row is
  created first and keeps the lower `sequence`; the chip gets a higher one; and the
  text streamed **after** the call is appended to the earlier row, i.e. it renders
  above the chip.
- The relayed reply ("Message from X") is a later `notice` on its own, and the
  recipient's answer is a later turn, so those are already in order.

## 3. Required behavior

1. After a notice that records a delegation (`meta.kind == "delegation"`, any
   direction) is appended to a session **during a turn**, the next assistant text
   delta of that same turn must start a **new** assistant message row (new
   `sequence`, after the notice) instead of appending to the earlier row. Later
   deltas of that turn append to the new row, until another delegation notice
   splits it again.
2. Do not split on other tools, on reasoning/thinking, or on turns without a
   delegation: those transcripts must be byte-for-byte unchanged (same message
   rows, same sequences).
3. `message.delta` and `message.completed` events for the split row carry the new
   message's id and sequence, as for any message. Finalization
   (`finalize_latest_assistant` for `AssistantMessage { text }`) must finalize the
   **latest** row of the turn with the text that belongs to it, not overwrite the
   earlier row with the whole turn's text. Read how the finalizer takes `text` from
   the adapters (it receives the full message) and make the split rows keep their
   own text; add a test for a provider that sends one final `AssistantMessage`
   with the full turn text after a split (the pre-split part must stay on the first
   row and only the remainder on the second; if the full text cannot be
   partitioned reliably, keep each row's streamed content and do not rewrite
   either).
4. Replay and restart: a conversation reloaded from the database shows the same
   order. Persisted rows are the source of truth; no ordering logic may live only
   in memory.
5. Do not change what the model sees; this is presentation order only. Do not
   touch usage, token counting or the turn's `turn_id` association (both rows keep
   the same `turn_id`; check that anything keyed on "the assistant message of a
   turn", such as `message_reply_source`, copy/retry/edit-and-resend, queue and
   cancel handling, still behaves: they must handle two assistant rows in one
   turn; fix any that assume one).

## 4. Tests (storage + daemon, fake adapters only)

- delta, delegation notice, delta, in one turn: two assistant rows, ordered
  `[row A][notice][row B]`; the second delta lands in row B.
- delta, tool (non-delegation), delta: one row, unchanged.
- two delegations in one turn: three assistant rows interleaved correctly.
- reload from the database reproduces the order and the per-row text.
- finalization with a full-turn `AssistantMessage` after a split (section 3.3).
- `message_reply_source` / retry / edit paths with a split turn.

## 5. Gates

```
cargo test -p bloblex-storage
cargo test -p bloblex-daemon          # RUST_MIN_STACK=33554432 on this machine
cargo clippy -p bloblex-storage -p bloblex-daemon --no-deps --all-targets -- -D warnings
```

The workspace is clippy-clean; keep it so.

## 6. Report

Files changed, exact test lines, which code paths assumed "one assistant message
per turn" and what you did about each, and anything unsure.
