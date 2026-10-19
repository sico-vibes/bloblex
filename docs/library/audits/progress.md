# Documentation library work log

> **What this is:** the running log of the documentation lane (branch `docs-library`, worktree `D:\fx50`). Written so that a successor can resume after an interruption.
> **Status:** complete for this brief. Four phases are done; the owner decisions listed under "Open for the owner" are not.
> **Last updated:** 2026-10-19

## Rules in force

- Work only in `D:\fx50`. No `git commit`, `git push`, `git reset`, `git stash`, or checkout of other branches. `git mv` is allowed. New files are left untracked (not staged).
- Protected paths keep their location: `docs/releases/`, `docs/remote/`, `docs/ipc-contract.md`, `docs/evidence/`, `docs/fixtures/`, `docs/qa-schema/`, and the root files `AGENTS.md`, `README.md`, `DESIGN.md`, `PRODUCT.md`, `SESSION_HANDOFF.md`, `THIRD_PARTY_NOTICES.md`.
- Facts, numbers, decisions and dates do not change. Facts that look wrong are listed in the final report and in the inventory.

## Phase 1: inventory (done)

- 256 tracked Markdown files inventoried in [inventory.md](inventory.md): current path, proposed path, kind, subsystem, status, last date, duplicates, contradictions and pre-existing dangling mentions.

## Phase 2: organise and name (done)

- Structure: `docs/reference/`, `docs/guides/`, `docs/design/`, `docs/plans/`, `docs/operations/`, `docs/audits/`, `docs/history/` (FIX waves in `docs/history/fix-NN/`, `improvement/`, `phases/`, and `director-log.md`), plus the protected folders.
- Naming: lower-case kebab-case for moved files. Root files, `docs/README.md` and `docs/STYLE.md` keep upper case.
- 191 files moved with `git mv` (the full map is in the inventory). `docs/README.md` stays and was rewritten.
- References rewritten by script: link targets recomputed from each file's new location; full old paths and unique bare names rewritten in prose; in code files only comment lines were touched.
- Code edits (comment text only, 6 lines in 6 files): `apps/desktop/src/remote/serviceWorker.test.ts`, `crates/bloblex-adapter-acp/tests/live/mod.rs`, `crates/bloblex-adapter-claude/tests/live/mod.rs`, `crates/bloblex-adapter-codex/tests/live/mod.rs`, `crates/bloblex-daemon/src/main.rs`, `crates/bloblex-speech/src/cloud.rs`.
- Byte-order marks removed from four moved files (text only).
- Line endings normalised to CRLF, matching the working copy.

## Phase 3: style and polish (done, with the limits below)

- [STYLE.md](../../STYLE.md) written: tone, names, front block, layouts by kind, historical records, linking, citing code, verification markers, dates, file naming, protected paths.
- Every document now has the front block (what it is, status, last updated). Historical records keep their body. The status line of older records is kept as a paragraph under the block.
- New: [docs/reference/architecture.md](../../reference/architecture.md), written from the code with full-path citations (claims checked at `17bc277`).
- `docs/README.md` regenerated from the front blocks: one row per document, with the start list and the folder map.
- Deliberate limits: historical records were not restructured to the five-part layout (content preservation); release notes changed only by links (the app imports them); `AGENTS.md` only had its paths updated; the old index's per-document "last verified" column is not in the new index (it remains in [docs-audit-2026-10-14.md](../../audits/docs-audit-2026-10-14.md)).

## Phase 4: review with Codex Luna (done, three rounds)

- Round 1: [review-1-request.md](review-1-request.md), reply [review-1-reply.md](review-1-reply.md) (13 points, all accepted, several corrections of stale current-state claims).
- Round 2: [review-2-request.md](review-2-request.md), reply [review-2-reply.md](review-2-reply.md) (6 points, all accepted; one migration claim corrected in code terms).
- Round 3: [review-3-request.md](review-3-request.md), reply [review-3-reply.md](review-3-reply.md): "no remaining must-fix items"; two should-fix citation points, fixed after the reply and checked by search, not by a fourth round.
- The full record is in [review-log.md](review-log.md).

## Phase 5: checks (done)

- Relative links: 866 checked across 267 files, 0 broken (`node` link checker, run from the scratchpad).
- Protected paths: no protected file moved. `docs/qa-schema` and `docs/fixtures` have no changes (`git status` empty for both).
- `npm run typecheck` at `D:\fx50`: exit 0, after the comment edits.
- `git diff` on code files: 6 lines, all comment text.
- Final report: in the lane's reply to the Director.

## Open for the owner

- `README.md` status figures (`v0.1.0-beta.34` in the status block; `Cargo.toml` and `package.json` say beta.35). Annotated, not changed.
- `README.md` updater feed sentence (`v0.1.0-beta.6`): annotated as superseded, not changed.
- `docs/remote/PROTOCOL.md` body says "Design, not implemented" (protected body; annotated in the front block).
- Remote threat-model release gate (`docs/remote/THREAT_MODEL.md`, sections 8 and 11) is still owed for a non-beta release (AGENTS.md, 17 October 2026).
- Pre-existing dangling mentions listed in the inventory.
- Lane work files are kept in `docs/library/audits/`. Delete or move them when the owner no longer needs the review record.
