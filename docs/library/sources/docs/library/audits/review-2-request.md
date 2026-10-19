# Review request 2: the documentation library, after round 1

You reviewed this library in round 1 ([review-1-request.md](review-1-request.md); your reply is [review-1-reply.md](review-1-reply.md)). The changes made in answer are listed in [review-log.md](review-log.md). Read-only: change nothing.

Please check, for each item below, whether the change resolves your point, and list any remaining problem with a file path, a line where possible, and a proposed fix. Mark each as **must fix** or **should fix**. If nothing important remains, say so in one line and do not invent objections.

## Changes to check

1. `docs/library/audits/inventory.md` (front block): now calls itself a lane work record.
2. `docs/STYLE.md`: the art styles are the six from `apps/desktop/src/blob/art/art.ts`. The Status rule is now a vocabulary of first words (`current`, `historical`, `superseded`, `protected`, `evidence`, `owner directive`, `working record`, `in progress`) with a qualifier after a semicolon.
3. `docs/operations/operating-model.md`: its front block now says it is a summary dated 14 October 2026, not updated for the 16 to 19 October amendments. Its body is unchanged. Check that the index (`docs/README.md`) describes it the same way.
4. `docs/README.md`: the start list now links `reference/architecture.md` for new contributors.
5. `docs/guides/windows-development.md` (around line 30): the stale sentence about the updater is kept and followed by a note that says it is superseded on that point, with links to `docs/operations/updater.md` and the release checklist. Check that the note is clear and that the guide does not still contradict the checklist elsewhere.
6. `docs/plans/e2e-plan-v2.md` (front block): the status now names the stale beta.23 figure in the kept paragraph and points to `docs/operations/implementation-status.md`.
7. `docs/remote/PROTOCOL.md` (front block): the status says that the body's line "Design, not implemented" is out of date. The body is unchanged (protected).
8. `docs/reference/architecture.md`: rewritten. Check these claims against the code, with the citations: the Tailscale gateway binds `127.0.0.1` (`crates/bloblex-daemon/src/remote/mod.rs:792`); the Native method binds every interface and serves TLS (`crates/bloblex-daemon/src/remote/native.rs:15` and `:404`); the frontend seam (`apps/desktop/src/transport/nativeBridge.ts`, header comment); migrations (`crates/bloblex-storage/src/lib.rs`, `migrate_*` functions, `verified_backup` at `lib.rs:57` and `:129`, `schema_migrations` and `PRAGMA user_version` at `lib.rs:39-60` and `:94-95`).
9. `README.md` (around line 53): the updater feed sentence is kept and marked as superseded, with a link to the release checklist.
10. `docs/library/audits/review-log.md`: records each of your points and the answer.

## Please also check

- Whether the architecture file now says anything untrue about the Native method's status (it is off by default, and the release gate in `docs/remote/THREAT_MODEL.md` is still owed for a non-beta release).
- Whether `docs/STYLE.md` still says anything that the documents do not follow.

## Reply format

Start with a one-line verdict ("resolved", or "N items remain"). Then the list, each as: `path:line` - problem - proposed change - must fix or should fix.
