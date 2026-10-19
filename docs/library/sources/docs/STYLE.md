# Documentation style guide

> **What this is:** the rules for writing and maintaining Bitbots documents: tone, layout, naming, links and how to mark what is verified.
> **Status:** current. Applies to every document written from October 2026 on. Historical records were brought under the front block but keep their own body layout (see [Historical records](#historical-records)).
> **Last updated:** 2026-10-19

## Tone

- Plain, direct and specific. Short sentences. Active voice.
- British-neutral English: "behaviour", "organise" and "licence" are fine; do not mix spellings within one document.
- Sentence-case headings. One level-one heading per document, equal to the title.
- No marketing words ("seamless", "powerful", "robust"). No emoji. No exclamation marks.
- Say what is unknown. Use "unknown" or "not verified" rather than a guess, and never present an unverified result as a success.

## Names

Use the current names in new text:

| Use | Meaning |
| --- | --- |
| Bitbots | The desktop app and the product. |
| bot | One agent character in Bitbots. Use "bot" for the character itself, whatever it looks like. |
| Blobots | The look whose bots are drawn as blobs. A bot's art style is chosen separately: one of six (3D robot, Flat robot, Pop robot, Dot robot, Glossy blob, Hand-painted). |
| look | A visual style the user picks: Bitbots (the Frost look), Blobots, Legacy, Pop, Dot. |
| companion | The floating window that shows bot state. |
| daemon | The local `bitbotsd` process that owns sessions, permissions and usage. |
| Manager | The permanent, global bot that plans and proposes work. |
| lane | One delegated work stream in the delivery process. |
| Director | The orchestrating Claude session in the delivery process. |

In historical records, "blob" and "Bloblex" keep their original wording.

Code identifiers keep their names (crate names such as `bloblex-daemon`, file paths, and type names). Do not rename them in prose; put the path in code font.

## Front block

Every document starts with a level-one heading and this block (a quote, three lines):

```markdown
# Title

> **What this is:** one or two sentences.
> **Status:** current; a qualifier after the semicolon | historical | superseded by a link to its successor | protected | evidence; immutable record
> **Last updated:** YYYY-MM-DD
```

- **What this is** says what the reader gets from the document, not its history.
- **Status** starts with one of these words: `current`, `historical`, `superseded`, `protected`, `evidence`, `owner directive`, `working record`, `in progress`. A short qualifier may follow after a semicolon. A superseded document names its successor in the same line.
- **Last updated** is the date of the last change to the document's own text. Link repairs and front blocks added by the library pass of 19 October 2026 do not count as changes. A document corrected in that pass takes 19 October 2026. Do not invent dates.

## Layouts by kind

Headings may be shortened, but the parts keep this order.

| Kind | Sections |
| --- | --- |
| Reference | Purpose; How it works; Key files; Gotchas |
| Guide | Before you start; Steps; Check the result; If something fails |
| Design rule | Rules; Where they apply; Exceptions; Source |
| Plan or spec | Context; Goals; Scope; Decisions; Work items; Acceptance |
| History record | Context; Decisions; What landed; Verification; Follow-ups |
| Operations | Purpose; Procedure; Record; Open items |

Release notes (`docs/releases/`) and evidence (`docs/evidence/`) keep their own shape. They are protected and only gain a status line where the front block is needed.

## Historical records

A history record (a FIX wave report, a spec, a brief, an audit) keeps its content, dates and wording. This pass adds the front block and, where a later document replaces it, one line that names the successor. The body is not restructured into the five-part layout, because that would rewrite the record. New history records use the five-part layout.

## Linking

- Use relative links to files: `[approval modes](reference/approval-modes.md)`. Link text names the document or the path, not "here" or "this link".
- Link each document only where it is needed. Do not repeat a link list in every document.
- Repository roots: link the root files from `docs/` with `../`, e.g. `[AGENTS.md](../AGENTS.md)`.
- Use a fragment only when the anchor exists in the target.

## Citing code

- Cite code as `path:line`, in code font: `crates/bloblex-daemon/src/main.rs:992`. Prefer a function or test name when the line may move.
- Cite a path that exists. Cite a commit by its short hash in code font.

## Verification markers

Say how far a claim was checked:

- **Verified:** checked against the code, a test run or a recorded run, with the source named.
- **Claimed:** reported by an implementer or a report, not re-checked in this pass.
- **Not verified:** not run, or run only in a browser preview or a unit test. Say which environment.

Write these as plain words in the sentence ("not verified in a native window"). Do not use icons or colour alone.

## Dates and versions

- Dates are written as `19 October 2026` in prose and `2026-10-19` in front blocks and tables.
- Versions are written as `v0.1.0-beta.35`. Say "the current release" only when the document is dated.

## Files and naming

- Lowercase kebab-case for every file under `docs/` except `docs/README.md` and `docs/STYLE.md`.
- Root files keep their upper-case names (`AGENTS.md`, `README.md`, `docs/design/design-system.md`, `docs/design/product.md`, `docs/operations/session-handoff.md`, `docs/legal/third-party-notices.md`).
- Folders by purpose: `reference/`, `guides/`, `design/`, `plans/`, `operations/`, `audits/`, `history/` (FIX waves in `history/fix-NN/`), `evidence/`, `releases/`, `remote/`, `library/` (the lane's work logs).
- A FIX wave file is `history/fix-NN/<topic>-<kind>.md`, for example `history/fix-39/p1-report.md`. The kind is one of `spec`, `brief`, `report`, `audit`, `research`, `decisions` or `follow-up`.

## Protected paths

Protected paths are read by the app or by tests, or are the evidence for a claim. They are not moved. Their text may be repaired (links, status lines), but facts are not changed. The protected list is in [the inventory](library/audits/inventory.md).
