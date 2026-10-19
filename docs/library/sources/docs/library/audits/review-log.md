# Review log: Codex Luna

> **What this is:** the record of each review round with Codex Luna (`gpt-6-luna`, high, read-only): Luna's points, the answer for each, and what changed.
> **Status:** complete; three rounds, no must-fix point left open.
> **Last updated:** 2026-10-19

## Round 1

Request: [review-1-request.md](review-1-request.md). Reply, verbatim: [review-1-reply.md](review-1-reply.md). Luna's verdict: the archive is organised, but several documents presented as current are stale or contradict the implementation.

| # | Luna's point | Answer | Change |
| --- | --- | --- | --- |
| 1 | The inventory calls itself "not part of the library" but sits under `docs/library/`. (should fix) | Agreed. | Wording changed to "lane work record; the library index lists it under library work records". |
| 2 | `docs/STYLE.md` names the bot art styles "light robots" and "hand-painted blobs"; `apps/desktop/src/blob/art/art.ts` has six styles. (should fix) | Agreed. The names came from a report title. | STYLE lists the six styles: 3D robot, Flat robot, Pop robot, Dot robot, Glossy blob, Hand-painted. |
| 3 | The Status rule does not match the values in use ("working record", "in progress", "owner directive", "evidence"). (must fix) | Agreed. | STYLE defines the first-word vocabulary and a qualifier after a semicolon. |
| 4 | The index says the operating model gives "the rules in effect today", but it was derived on 14 October and predates the 16 to 19 October amendments. (must fix) | Agreed. The document is a dated summary, not the current rule set. | Front block and index say so; AGENTS.md wins. The body is unchanged. |
| 5 | The new-contributor path does not link the architecture overview. (should fix) | Agreed. | The index start list links `reference/architecture.md`. |
| 6 | `docs/guides/windows-development.md` says the updater is disabled; the release checklist records a signed updater for beta.35. (must fix) | Agreed as a contradiction. The sentence dates from 15 October. | Sentence kept; a "superseded on this point (19 October 2026)" note names the current source. |
| 7 | `docs/plans/e2e-plan-v2.md` gives beta.23 as the current release. (must fix) | Agreed. | Front status names the stale figure and points to implementation status. The kept paragraph is unchanged. |
| 8 | `docs/remote/PROTOCOL.md` body says "Design, not implemented", but the daemon contains the gateway. (must fix) | Agreed. The body is protected, so only the front block changed. | Front status says the body line is out of date and names `crates/bloblex-daemon/src/remote/`. |
| 9 | `docs/reference/architecture.md` says `nativeBridge.ts` is the only place that talks to the native shell; `src/tauri.ts` also imports Tauri APIs. (must fix) | Agreed. Checked: the `nativeBridge.ts` header allows `src/tauri.ts` and `src/desktopIntegrations.ts`. | The frontend paragraph states the exception. |
| 10 | Architecture generalises the loopback listener to all Remote access and says "never a public bind". The Native method binds every interface, with TLS (`native.rs`). (must fix) | Agreed. Checked: the production bind is `0.0.0.0` and `[::]` while Native is on. | Architecture describes both methods. Native is the one interface-bound listener, off by default. |
| 11 | README says the signed updater feed is at `v0.1.0-beta.6`; the release checklist says the beta channel offers beta.35. (must fix) | Agreed as a contradiction. The figure is kept and marked as superseded. | Note added with a link to the release checklist. The README's release-version figure is the owner's call (final report). |
| 12 | Architecture cites `main.rs:...` without a path. (should fix) | Agreed. | All citations use full repository-relative paths. |
| 13 | No database and migrations workflow. (should fix) | Agreed in part. Migrations are described (versioned `migrate_*` functions, backup before schema change, ledger and `user_version`) with citations. No separate guide was written. | Architecture section "Storage and migrations". A separate guide is a candidate for a later pass. |

Luna did not dispute the verdict, and no point was rejected.

## Round 2

Request: [review-2-request.md](review-2-request.md). Reply, verbatim: [review-2-reply.md](review-2-reply.md). Luna's verdict: six items remain.

| # | Luna's point | Answer | Change |
| --- | --- | --- | --- |
| 1 | `guides/windows-development.md:28` still says updater keys and release hosting need configuration. (must fix) | Agreed. The sentence on line 28 was the one in conflict with the checklist. | It now says the updater key is configured for beta.35 and points to the note. The Windows code-signing certificate stays open. |
| 2 | "Schema-changing migrations take a verified backup" is too broad: `migrate_context_failure_class` (`crates/bloblex-storage/src/lib.rs:1218`) does not. (must fix) | Agreed. Checked in the code. | Architecture says most migrations take a backup and names the exception. |
| 3 | Shortened citations (`lib.rs`, `native.rs`) in architecture. (should fix) | Agreed. | Full repository-relative paths throughout the architecture file. |
| 4 | The operating-model title and status still read as current rules; its date predates the front-block changes. (should fix) | Agreed. | Title is now "a dated summary of the rules (14 October 2026)"; status "current; a dated summary"; last updated 19 October 2026. |
| 5 | The index does not carry the caveat about the 16 to 19 October amendments. (should fix) | Agreed. | The start list and the row now say so. |
| 6 | Qualifiers without a semicolon after the status word (operating model, architecture, PROTOCOL). (should fix) | Agreed. | Each uses a semicolon. Evidence records use "evidence; immutable record". |

Two rules were added to STYLE in answer to round 2: `Last updated` records the last change to a document's own text, and link repairs or front blocks added by this pass do not count. So 19 October 2026 is set only where the text was corrected.

## Round 3

Request: [review-3-request.md](review-3-request.md). Reply, verbatim: [review-3-reply.md](review-3-reply.md). Luna: "resolved: no remaining must-fix items". Luna confirmed the other round 2 items, and raised three should-fix points on citations.

| # | Luna's point | Answer | Change |
| --- | --- | --- | --- |
| 1 | Architecture still has shortened citations (`lib.rs:129`, `lib.rs:1218`, `lib.rs:94-95`, and the `lib.rs` citations for the desktop windows). (should fix) | Agreed. | All citations use full repository-relative paths. |
| 2 | Architecture cites "crate doc comment" without a path (adapter rows and the speech crate). (should fix) | Agreed. | Each row cites the crate `src/lib.rs:1`, where the doc comment is (checked with grep). |

The round 3 fixes were checked by link and text search, not by a fourth Luna round. The debate stops here: no must-fix point remains, and the three rounds covered the whole list.

Summary of the debate: Luna disputed none of the findings. Where Luna's point was a claim about current state, the code or the release checklist was checked first and the document was corrected or annotated. Where the document was a historical record, the text was kept and a status note was added.
