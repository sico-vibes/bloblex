# Lane B report — whole-turn undo removed, per-file report kept honest

Worktree `D:\t4b` (branch `t4/checkpoints`). Edited files: `checkpoints.rs`
(new in this worktree, untracked) and the one named dispatch arm in `main.rs`.
`experiments.rs` was **not** edited.

`cargo check -p bloblex-daemon --message-format short` passes with no warnings.

## What changed (path:line)

### `crates/bloblex-daemon/src/checkpoints.rs`

- **1–14** module doc comment rewritten: the module is a read-only report; undo is
  per file through `file.revert` only; no whole-turn restore, with the reasons
  (a batch stopping halfway leaves the turn part undone; file undo cannot rewind
  the provider's memory).
- **16** import list: dropped `gate_for_session` (only `revert_turn` used it).
- **21–36** constants: `NOT_ATTEMPTED` and `BUSY` deleted with `revert_turn`.
  `PROVIDER_REASON` now reads *"Undoing a file does not change what the agent
  remembers of the conversation. Tell the agent if you want it to know."*
  Added `INCOMPLETE_DIFF_REASONS` (see `diffComplete` below). `CHECK_LIMIT`,
  `NOT_GIT`, `NO_PROJECT` unchanged.
- **47–73** `session_checkpoints`: same shape except the capability keys.
- **75–89** `inspect`: internal keys renamed `fileUndo` / `fileUndoReason`
  (were `workspaceRestore` / `workspaceReason`); same truth source.
- **91–100** `workspace_status` renamed `undo_status` (same logic, unchanged):
  true only for a canonicalizable project folder that Git reports as inside a
  work tree.
- **102–139** `file_dto`: adds `diffComplete`; `state` values and the plain-sentence
  blocked reasons unchanged; everything else in the object unchanged.
- **141–149** new `fn diff_complete(&Result<(), String>) -> bool`.
- **145–224 (old)** `revert_turn` and `refusal` deleted in full. No
  `git checkout/reset/stash/clean` exists anywhere in the module, before or after.

### `crates/bloblex-daemon/src/main.rs`

- **line 1058 (old)**: deleted `"session.checkpoints.revertTurn" => checkpoints::revert_turn(st, &p).await,`.
  `"session.checkpoints"` at line 1057 and the `file.revert` arm (1041–1056) are
  byte-for-byte unchanged. No other main.rs edit.

## The new `capability` shape

```json
"capability": {
  "fileUndo": true,
  "fileUndoReason": null,
  "providerStateRestore": false,
  "providerReason": "Undoing a file does not change what the agent remembers of the conversation. Tell the agent if you want it to know."
}
```

- `fileUndo` is true exactly when `workspaceRestore` was true: Git repository and
  Git usable. `fileUndoReason` carries the same sentences as `workspaceReason`.
- `providerStateRestore` stays `false`.
- Per file: `{ id, turnId, path, operation, additions, deletions, state, reason, diffComplete }`.
  `state` stays `available | reverted | blocked`; nothing else in the file object
  was renamed.

### How `diffComplete` is derived (no duplicated rule)

`file_dto` now keeps the result of the one `experiments::reverse_file_check` call
it already makes and passes it to `diff_complete`, which returns `false` only when
that result is one of the four refusals `prepare_reverse` makes about the saved
diff itself (`experiments.rs` 170, 172, 204, 214, quoted verbatim in
`INCOMPLETE_DIFF_REASONS`, whose doc comment says to keep it in step). Every other
refusal — unsafe path, not a Git repository, *"no longer applies cleanly in
reverse"* — leaves `diffComplete: true`, which is the honest answer: a complete
diff exists, the file has drifted. A change already marked `reverted` reports
`true` without re-running the check, because `file.revert` refuses an incomplete
diff before it writes. No second copy of the clipping/truncation rule was added.

Two consequences worth knowing, both accepted deliberately:

1. `reverse_file_check` now runs even when `fileUndo` is false, so the field is
   read from the rule instead of guessed. For a complete diff that costs one Git
   call per file (bounded by `CHECK_LIMIT`, 200); an unusable diff returns before
   Git is started. It stays inside `spawn_blocking`, so no executor stall.
2. The list of diff refusals is a string list in `checkpoints.rs`. If the wording
   in `prepare_reverse` changes, that list must change with it (noted in the code).

## What I verified in `experiments::reverse_file` (item 3)

No change was needed; it already does what the brief asks. `experiments.rs`
133–158: `reverse_file` calls `prepare_reverse` (all patch validation, ending with
`git apply -R --numstat` so Git itself names the one path it would touch), then
`git_patch(root, patch, check = true, …)` which runs `git apply -R --check`
immediately before `git_patch(root, patch, check = false, …)` runs the real
`git apply -R` — same function call, same prepared patch, no `await`, no
`spawn_blocking` boundary between them, so nothing else in the daemon can run
between check and apply. After a successful apply `reverse_file` returns the
`Result` and does nothing else: the only bookkeeping
(`st.db.mark_file_reverted`) stays in the `file.revert` arm in `main.rs`, which I
did not touch. `reverse_file_check` is still called by `checkpoints.rs`, and
`prepare_reverse`/`git_patch` by both, so no helper became unused — `experiments.rs`
needs no edit.

## Cargo check — last 15 lines (first, uncached run)

```
    Checking bloblex-adapter-codex v0.1.0-beta.38 (D:\t4b\crates\bloblex-adapter-codex)
    Checking bloblex-adapter-claude v0.1.0-beta.38 (D:\t4b\crates\bloblex-adapter-claude)
    Checking idna_adapter v1.2.2
    Checking idna v1.1.0
    Checking url v2.5.8
    Checking tower-http v0.6.11
    Checking hyper v1.11.1
    Checking hyper-util v0.1.21
    Checking hyper-tls v0.6.0
    Checking bloblex-storage v0.1.0-beta.38 (D:\t4b\crates\bloblex-storage)
    Checking axum v0.8.9
    Checking igd-next v0.18.0
    Checking reqwest v0.12.28
    Checking bloblex-daemon v0.1.0-beta.38 (D:\t4b\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 23s
```

A second identical run was cached: `Finished \`dev\` profile … in 0.64s`. Neither
run printed a warning or an error (no unused-function, unused-constant or
unused-import warning).

## Stale tests (not edited, none run)

- `crates/bloblex-daemon/src/checkpoints.rs` has **no** `#[cfg(test)]` block and
  never had one, so nothing became stale there.
- No Rust or TypeScript test refers to `session.checkpoints`, `revertTurn`,
  `revert_turn`, `workspaceRestore` or `workspaceReason` (checked with ripgrep over
  `*.rs`, `*.test.ts`, `*.test.tsx`). The only test that touches this work is
  indirect and outside my lane: see the parity item below.

## Follow-ups outside this lane's files (NOT edited — for the Director)

1. `apps/desktop/src/remote/tiers.json` lines 1005–1011 still carry a
   `session.checkpoints.revertTurn` row. `remoteTiers.parity.test.ts` →
   *"has no stale rules"* (lines 132–144) fails on exactly this: a
   `METHOD_RULES` entry the dispatch no longer has. That row must be deleted by
   whoever owns the remote policy.
2. `apps/desktop/src/ui/SessionRailExtras.tsx` (untracked, new) still calls
   `'session.checkpoints.revertTurn'` (line 89) and reads
   `capability.workspaceRestore` / `workspaceReason` (lines 26, 104, 106). With
   this change the call returns an `unknown method` error and the capability
   fields are `undefined`. The UI lane must switch to `fileUndo` /
   `fileUndoReason`, drive undo per file through `file.revert`, and may use the
   new per-file `diffComplete` to explain a permanently blocked change.
3. `docs/ipc-contract.md` lines 302–303 still describe `workspaceRestore`,
   `workspaceReason` and the `revertTurn` method; the docs lane should replace
   them with the new capability keys, the `diffComplete` field and a note that
   undo is `file.revert` only.
4. `.claude/skills/bitbots-development/references/codebase-map.md` line 42 names
   `session.checkpoints.revertTurn` as a daemon method; that line should lose it.

## Tests

**I ran no tests of any kind.** No `cargo test`, no `cargo check --tests`, no
`cargo clippy --all-targets`, no `npm test`/`vitest`, no scratch probes, no
screenshots, no browser, no app run. The only command executed against the code
was the two `cargo check -p bloblex-daemon --message-format short` runs above.
No git writes were made (`status` and `diff` reads only).
