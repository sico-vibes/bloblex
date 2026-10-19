# Review request 1: the documentation library

You are reviewing the documentation of the Bitbots repository in the worktree `D:\fx50` (branch `docs-library`). Read-only: change nothing. Reply with concrete problems, each with a file path and a line where possible, and a proposed fix. Group the reply into: structure, naming, style guide, index, document samples, factual or link problems, missing coverage. Mark each point as **must fix** (wrong, broken or misleading) or **should fix** (inconsistent or unclear). Do not repeat praise.

## What was done

1. Every tracked Markdown file (256 files) was inventoried. The inventory and the old-to-new path map are in `docs/library/audits/inventory.md`.
2. Documents were moved with `git mv` into a structure under `docs/`: `reference/`, `guides/`, `design/`, `plans/`, `operations/`, `audits/`, and `history/` (FIX wave records in `history/fix-NN/`, the improvement phases in `history/improvement/`, the phase specs in `history/phases/`, and the director log). Protected paths did not move: `docs/releases/`, `docs/remote/`, `docs/evidence/`, `docs/ipc-contract.md`, `docs/fixtures/`, `docs/qa-schema/` and the root files `AGENTS.md`, `README.md`, `DESIGN.md`, `PRODUCT.md`, `SESSION_HANDOFF.md`, `THIRD_PARTY_NOTICES.md`.
3. File names are lower-case kebab-case, except root files, `docs/README.md` and `docs/STYLE.md`.
4. Every document now starts with a level-one heading and a front block: `What this is`, `Status` and `Last updated`. Historical records keep their body text; only the front block was added (and, where the record already had a status line, its text was kept as a paragraph under the block).
5. A new reference document, `docs/reference/architecture.md`, was written from the code, with file and line citations.
6. `docs/README.md` was regenerated as the index from the front blocks: one row per document.
7. Links were checked: 839 relative links, all resolve. References in code files were changed only in comments.

## Please review

- `docs/STYLE.md`: the rules. Are they clear, consistent, and do they match what the documents actually do? In particular, the rule that historical records keep their body layout (not restructured to the five-part layout) and the naming table.
- `docs/README.md`: the index. Is the structure easy to navigate? Are the "Start here" pointers right? Does any row misdescribe its document?
- `docs/library/audits/inventory.md`: the proposed structure and the justification for each folder. Is anything in the wrong folder?
- `docs/reference/architecture.md`: check its claims against the code. Every citation is `path:line` (line numbers may be off by a few). Report any claim that is wrong, unverifiable or overstated.
- Sample documents, one or two per kind, to check the front block and tone: `docs/operations/release-checklist.md`, `docs/guides/windows-development.md`, `docs/plans/e2e-plan-v2.md`, `docs/history/fix-39/p5-report.md`, `docs/history/fix-01/team-spec.md`, `docs/evidence/cloud-dictation-tls-backend-2026-10-14.md`, `docs/remote/PROTOCOL.md`, `README.md`.
- Missing coverage: is there anything a new contributor or an AI agent needs to know about how the system works that no current document says?

## Known limits (do not report these as new)

- The status of the root `README.md` figures (it says `v0.1.0-beta.34`; `Cargo.toml` and `package.json` say `beta.35`). The owner must decide the wording; this pass only annotated it.
- Several historical records mention paths that no longer exist, or refer to other repositories (for example the T3 Code research and `docs/user/...`). They are listed in the inventory as pre-existing dangling mentions and are not changed.
- `docs/releases/` notes are not changed beyond link repair, because the app reads them at build time.
- `AGENTS.md` is the owner directive; only its paths were updated.

## Reply format

Start with a one-paragraph verdict. Then the numbered list of points, each as: `path:line` - problem - proposed change - must fix or should fix.
