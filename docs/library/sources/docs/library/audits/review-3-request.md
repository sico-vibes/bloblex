# Review request 3: the documentation library, after round 2

Round 2 is answered in [review-log.md](review-log.md) (see the Round 2 table). Your round 2 reply is [review-2-reply.md](review-2-reply.md). Read-only: change nothing.

Please check only the six round 2 items, against the files now in the tree:

1. `docs/guides/windows-development.md` line 28 and the note on line 30.
2. `docs/reference/architecture.md`, the "Storage and migrations" paragraph: is the backup claim now exact? Check `crates/bloblex-storage/src/lib.rs` (`verified_backup` call sites, `migrate_context_failure_class`).
3. `docs/reference/architecture.md`: every citation is a full repository-relative path.
4. `docs/operations/operating-model.md` (title, front block) and `docs/README.md` (its start-list line and its row).
5. The status lines of `docs/operations/operating-model.md`, `docs/reference/architecture.md` and `docs/remote/PROTOCOL.md` use a semicolon after the status word, as `docs/STYLE.md` requires.
6. `docs/STYLE.md`: the new rule on "Last updated".

Also list any **must fix** problem you find in the files you read for these items, with `path:line`. If none remains, reply with the one line "resolved: no remaining must-fix items", then any should-fix items.
