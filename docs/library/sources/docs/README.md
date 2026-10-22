# Bitbots documentation

> **What this is:** the index of every Markdown document in the repository, grouped by purpose. Use it to find the current document for a task.
> **Status:** current. Rewritten by the documentation library pass of 19 October 2026 (structure and index only; facts were not changed); updated 22 October 2026 for the merged phase 1 and the expansion records.
> **Last updated:** 2026-10-22

Where a document and the code disagree, the code wins. For rules, [AGENTS.md](../AGENTS.md) wins. For anything else, the status line of the document says whether it is current, historical or superseded.

## Start here

- **Latest development review:** [20 October fixes and verification](library/content/reference/live-development-review-2026-10-20.md), including the two-theme decision and native development workflow.

- **AI agents and the delivery process:** read [AGENTS.md](../AGENTS.md) first, then [operations/operating-model.md](operations/operating-model.md) (a summary of AGENTS.md dated 14 October 2026, not updated for the 16 to 19 October amendments; AGENTS.md wins), [operations/implementation-status.md](operations/implementation-status.md) (open gaps), and [operations/release-checklist.md](operations/release-checklist.md) (release state).
- **New contributors:** [README.md](../README.md), then [reference/architecture.md](reference/architecture.md), [guides/windows-development.md](guides/windows-development.md), [product.md](design/product.md), [design-system.md](design/design-system.md), [ipc-contract.md](ipc-contract.md) and [reference/runtime-capabilities.md](reference/runtime-capabilities.md).
- **Plan and roadmap:** [plans/e2e-plan-v2.md](plans/e2e-plan-v2.md) is the plan. [plans/improvement-plan.md](plans/improvement-plan.md) is the roadmap that AGENTS.md names.
- **Product expansion:** [plans/expansion-plan-v2.md](plans/expansion-plan-v2.md) is the approved expansion plan (21 October 2026). Phase 1 (the tasks board, tree, timeline and task backend) is on `main`; its status is in [history/expansion-v2/](history/expansion-v2/). The 20 and 21 October records are historical: the [pause handoff](operations/expansion-handoff-2026-10-21.md), the [accepted reference plan](plans/reference-expansion-plan.md) and the [lane records](history/expansion/README.md). Each carries a 22 October update.
- **Release state:** [session-handoff.md](operations/session-handoff.md) is the dated handoff. The current release is `v0.1.0-beta.36` ([release notes](releases/0.1.0-beta.36.md)); `main` has later work that is not released. Beta.32 and later update themselves ([operations/updater.md](operations/updater.md)).
- **Reading the documentation offline:** open [DOCUMENTATION.html](DOCUMENTATION.html), one self-contained file at the top of `docs/` with the guides, the reference and every project document. Rebuild and check it with `node scripts/docs-library.mjs build` and `node scripts/docs-library.mjs check`.
- **Writing or editing a document:** [STYLE.md](STYLE.md).

## Folder map

```text
AGENTS.md, README.md, Cargo.toml, Cargo.lock, package.json, package-lock.json, .gitignore   root (kept)
docs/
  DOCUMENTATION.html        the generated offline library (open this)
  README.md                 this index
  STYLE.md                  documentation style guide
  ipc-contract.md           daemon IPC contract (kept)
  reference/                how the system works: contracts, capabilities, modes, analytics
  guides/                   runbooks: Windows development, live checks, native smoke
  design/                   design system, product, polish waves, archive/ (two old images)
  plans/                    the current plan and roadmap
  operations/               process, release, updater, implementation status, session handoff
  audits/                   documentation and coverage audits
  legal/                    third-party notices
  remote/                   Remote mode (kept: referenced by code)
  evidence/                 dated evidence records (kept: referenced by code and records)
  releases/                 release notes (kept: read by the app at build time)
  fixtures/, qa-schema/     test data (kept, byte-identical)
  history/                  dated records: fix-NN waves, improvement phases, phase specs, director log
  library/                  library source (content, assets), catalogue and snapshots
  library/audits/           the documentation lane's inventory, progress and review records
```

## Naming and status

- Files are lower-case kebab-case, except `AGENTS.md`, `README.md`, this index and `STYLE.md`. FIX wave records are `history/fix-NN/<topic>-<kind>.md`.
- Every document has a front block: what it is, its status and the date of its last change. Superseded records name their successor.
- Protected paths keep their place. See [STYLE.md](STYLE.md#protected-paths).

## Documents

## Root files

These stay at the repository root. `AGENTS.md` is the owner directive and wins on any conflict.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Bitbots collaboration instructions](../AGENTS.md) | Owner directive: how Bitbots is built and delivered, with the dated amendments, newest first. | owner directive; wins on any conflict | 2026-10-19 |
| [Bitbots](../README.md) | The front page of the repository: what Bitbots is, how to build and test it, and where the documentation starts. | current. The release figures in this file are set at v0.1.0-beta.35. | 2026-10-19 |

## Style

The documentation style guide.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Documentation style guide](STYLE.md) | the rules for writing and maintaining Bitbots documents: tone, layout, naming, links and how to mark what is verified. | current. Applies to every document written from October 2026 on. Historical records were brought under the front block but keep their own body layout (see [Historical records](#historical-records)). | 2026-10-19 |

## Legal

Licences and attributions.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Third-party notices](legal/third-party-notices.md) | the licences and attributions for third-party code, fonts and models that Bitbots bundles or adapts. | current | 2026-10-19 |

## Reference

How the system works and the contracts it keeps.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Approval modes contract: ask, auto-approve and bypass](reference/approval-modes.md) | The contract for the three permission modes (ask, auto and bypass): who decides, the safety rails and the RPC shape. | current; the budget clauses are historical (AGENTS.md, 12 October 2026 amendment) | 2026-10-15 |
| [Architecture](reference/architecture.md) | how Bitbots is put together: the desktop shell, the local daemon, the provider adapters, storage and the Remote gateway, and where to start reading each part. | current; new in the documentation library pass of 19 October 2026. The claims were checked against the tree at `17bc277` on that date; line numbers may move. | 2026-10-19 |
| [Phase 5 contract: cost and usage analytics (daemon RPC + UI)](reference/phase-5-analytics-contract.md) | The contract for cost and usage analytics: the daemon RPC, the UI and the definitions. | superseded in part; the monetary, estimate and subscription sections are retired (AGENTS.md, 12 October 2026 amendment) | 2026-10-14 |
| [Runtime capabilities of the installed CLIs](reference/runtime-capabilities.md) | The installed CLI capabilities Bitbots relies on, with the evidence for each: Claude Code, Codex and OpenCode. | current evidence record; the OpenCode 2.0.28 observations of 14 October 2026 are labelled in the OpenCode section | 2026-10-15 |
| [Bitbots daemon IPC contract (v1)](ipc-contract.md) | The daemon IPC contract (v1): methods, events, and the rules for the capability and the local listeners. | current | 2026-10-18 |

## Guides

Task-oriented runbooks.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Live CLI checks (Phase 2b entry gate)](guides/live-checks.md) | How the Director runs the live CLI checks against the signed-in provider CLIs. | current | 2026-10-15 |
| [Native smoke tooling](guides/native-smoke.md) | How to run the native smoke tooling against an isolated database. | current | 2026-10-02 |
| [Windows desktop development](guides/windows-development.md) | How to run, build and test Bitbots on Windows, using an isolated database. | current | 2026-10-19 |

## Design

The design system, the product brief, the polish waves and the archive of two old images.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Archived design images](design/archive/README.md) | the two images kept from earlier work when the repository root was tidied. Nothing in the app or in the documentation refers to them. | historical; archived on 19 October 2026 by the owner's root tidy-up. | 2026-10-19 |
| [Bitbots theme spec: the pixel re-skin (CSS only)](design/bitbots-theme-spec.md) | The pixel re-skin theme spec for the experimental Bitbots theme (CSS only), 13 October 2026. | historical; superseded in part by [themes-spec.md](history/fix-40/themes-spec.md) (the Frost look became Bitbots) | 2026-10-13 |
| [Bitbots Design System](design/design-system.md) | The visual design rules for Bitbots: the scene, tokens, layout, controls, companion, and the FIX39 and FIX40 rules. Read it before changing the UI. | current | 2026-10-19 |
| [Bitbots Product](design/product.md) | The product purpose, users, brand personality, anti-references and design principles for Bitbots. | current | 2026-10-15 |
| [UI/UX polish wave (15 October 2026, unreleased)](design/ui-polish-wave.md) | The UI and UX polish waves of 15 October 2026, recorded as they were shipped, unreleased. | historical | 2026-10-15 |

## Plans

The current plan and the roadmap.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Bitbots E2E plan: configurable blobs, sessions tree, token analytics, provider quota, release](plans/e2e-plan-v2.md) | The whole-product plan (E2E v2): the phases, the dated checkpoints and the open work. | current plan; its status section is dated 5 to 6 October 2026, and the release figure in the kept status paragraph (beta.23) is out of date; see [implementation-status.md](operations/implementation-status.md) | 2026-10-19 |
| [Bitbots improvement plan v2: a BB-informed, companion-style roadmap](plans/improvement-plan.md) | The v2 improvement roadmap for Bitbots: a companion-style plan that builds on the E2E plan. | current; the roadmap named by AGENTS.md (12 October 2026 amendment) | 2026-10-15 |
| [Expansion plan v2: tasks, desktop wins, providers, trusted access and phone relay](plans/expansion-plan-v2.md) | The approved expansion plan: the verdict on the first Codex draft, the features, five phases with gates, and 23 slices. | current; approved 21 October 2026; phase 1 is on `main` | 2026-10-21 |
| [Accepted product expansion plan (20 and 21 October 2026)](plans/reference-expansion-plan.md) | The owner's accepted scope and constraints for the 20 and 21 October expansion. | historical record, superseded in part (see its 22 October update) | 2026-10-22 |

## Operations

Process, release and status records.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Implementation status](operations/implementation-status.md) | The implementation status: released versions, phase status, work after the plan and the open gaps. | current; latest release v0.1.0-beta.36; a 22 October 2026 section covers phase 1 on `main` | 2026-10-22 |
| [Native smoke test results (Phase 2a + Phase 3)](operations/native-smoke-results.md) | Results of the native smoke test run on 2 October 2026 against an isolated database. | historical; a record of 2 October 2026 | 2026-10-15 |
| [Operating model: a dated summary of the rules (14 October 2026)](operations/operating-model.md) | A summary, dated 14 October 2026, of the rules in AGENTS.md. AGENTS.md wins on any conflict. The amendments of 16 to 19 October 2026 are not all reflected here. | current; a dated summary (14 October 2026), not updated for the 16 to 19 October amendments | 2026-10-19 |
| [Release checklist](operations/release-checklist.md) | The checklist for each Bitbots release: gates, publishing, digests, clean-up and open release items. | current | 2026-10-19 |
| [Bitbots session handoff](operations/session-handoff.md) | The session handoff: dated sections, newest first, with the current release and the open items. | current handoff with dated sections, newest first; the latest entry is 22 October 2026; the current release is v0.1.0-beta.36 | 2026-10-22 |
| [Product expansion pause handoff (21 October 2026)](operations/expansion-handoff-2026-10-21.md) | Lane status, exact evidence and image comparisons at the owner's pause. | historical record, superseded in part (see its 22 October update) | 2026-10-22 |
| [Auto-update and release contract](operations/updater.md) | The auto-update contract: decisions, channels, app behaviour, commands and the release process. | current | 2026-10-15 |

## Audits

Audits of the documentation and of the coverage.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Documentation audit (14 October 2026)](audits/docs-audit-2026-10-14.md) | The documentation audit of 14 October 2026: what was checked, what was fixed and what remained. | historical; its index role is replaced by [README.md](README.md) | 2026-10-14 |
| [V1 coverage audit](audits/v1-coverage.md) | The v1 coverage audit: the section 35 acceptance criteria, the required hardening and the runnable snapshot. | historical snapshot of 1 October 2026; the budget and pricing rows are retired | 2026-10-15 |

## Remote mode (protected paths)

Remote mode design, protocol and threat model. These paths are referenced by code and tests and do not move.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Draft amendment for AGENTS.md: Remote mode (for owner approval)](remote/AGENTS_AMENDMENT_DRAFT.md) | The draft amendment to AGENTS.md for Remote mode, as first written for owner approval. | historical; accepted into AGENTS.md (17 October 2026 amendment) | 2026-10-17 |
| [Remote mode: architecture](remote/ARCHITECTURE.md) | The architecture of Remote mode over Tailscale. | current (Tailscale method); later amendments are in AGENTS.md | 2026-10-16 |
| [Remote mode: phases](remote/PHASES.md) | The phases of the Remote mode work. | historical plan; see the status of each phase in docs/operations/session-handoff.md | 2026-10-16 |
| [Bitbots remote protocol (v1)](remote/PROTOCOL.md) | The Remote mode protocol (v1): requests, events and the rules for each. | current; the design for the wire contract. Its own line "Design, not implemented" is out of date: the daemon contains the gateway (crates/bloblex-daemon/src/remote/). | 2026-10-19 |
| [Remote mode: product specification](remote/REMOTE_MODE.md) | The product specification for Remote mode. | current | 2026-10-16 |
| [Remote mode: independent review (FIX24)](remote/REVIEW_NOTES.md) | The independent review of the Remote mode design (FIX24). | historical record | 2026-10-16 |
| [Remote mode: sequence diagrams](remote/SEQUENCES.md) | Sequence diagrams for Remote mode pairing, sign-in and requests. | current | 2026-10-16 |
| [Remote mode: threat model](remote/THREAT_MODEL.md) | The threat model for Remote mode. The release-gate checklists in sections 8 and 11 are still owed. | current | 2026-10-18 |
| [Remote mode: UX flows](remote/UX_FLOWS.md) | The UX flows for Remote mode. | current | 2026-10-16 |

## Evidence (protected paths)

Dated records that back claims. Their text is changed only by link repair and status lines.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Evidence: Bitbots pixel theme (CSS only) — 2026-10-13](evidence/bitbots-theme-2026-10-13.md) | Evidence for the Bitbots pixel theme (CSS only), 13 October 2026. | evidence; immutable record | 2026-10-13 |
| [Cloud dictation: what the Cloudflare challenge actually keys on (14 October 2026)](evidence/cloud-dictation-client-shape-2026-10-14.md) | Evidence for what the Cloudflare challenge keys on in cloud dictation, 14 October 2026. | evidence; immutable record | 2026-10-15 |
| [Cloud dictation diagnosis: "verification required" (Fix 1A)](evidence/cloud-dictation-diagnosis-2026-10-13.md) | Evidence for the cloud dictation diagnosis ("verification required"), 13 October 2026. | evidence; immutable record | 2026-10-15 |
| [Cloud dictation: the TLS backend fix (14 October 2026)](evidence/cloud-dictation-tls-backend-2026-10-14.md) | Evidence for the TLS backend fix in cloud dictation, 14 October 2026. | evidence; immutable record | 2026-10-14 |
| [Codex turn/steer evidence inventory (Phase 2B, 12 October 2026)](evidence/codex-turn-steer-2026-10-12.md) | Evidence inventory for Codex turn/steer (Phase 2B), 12 October 2026. | evidence; immutable record | 2026-10-15 |
| [Composer controls — 7 October 2026](evidence/composer-controls-2026-10-07.md) | Evidence for the composer controls, 7 October 2026. | evidence; immutable record | 2026-10-15 |
| [On-device dictation (beta.11)](evidence/dictation-2026-10-08.md) | Evidence for on-device dictation (beta.11), 8 October 2026. | evidence; immutable record | 2026-10-08 |
| [Floating dictation bubble (beta.12)](evidence/dictation-bubble-2026-10-08.md) | Evidence for the floating dictation bubble (beta.12), 8 October 2026. | evidence; immutable record | 2026-10-08 |
| [OpenCode effort evidence, 2026-10-13](evidence/opencode-effort-2026-10-13.md) | Evidence for OpenCode effort levels, 13 October 2026. | evidence; immutable record | 2026-10-13 |
| [Recovery-hint evidence inventory (Phase 1B, 12 October 2026)](evidence/recovery-hints-2026-10-12.md) | Evidence inventory for recovery hints (Phase 1B), 12 October 2026. | evidence; immutable record | 2026-10-12 |
| [Runtime capabilities (Phase 1.5)](evidence/task2-grok-runtime-capabilities.md) | Runtime capabilities of the installed CLIs (Phase 1.5), second record, 2 October 2026. | evidence; immutable record | 2026-10-15 |
| [Installed runtime capabilities for Phase 2b](evidence/task2-luna-runtime-capabilities-original.md) | The original read-only capability spike for Phase 2b, 2 October 2026. | evidence; immutable record | 2026-10-15 |
| [Wire fixtures and replay (Phase 3B)](evidence/wire-fixtures.md) | Wire fixtures and replay for recorded CLI output (Phase 3B). | evidence; immutable record | 2026-10-13 |

## Release notes (protected paths)

One note per release. The app reads these files at build time, so they keep their names and text.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Bloblex 0.1.0-beta.1](releases/0.1.0-beta.1.md) | Release notes for 0.1.0-beta.1. | release note (protected path) | 2026-10-02 |
| [Bloblex 0.1.0-beta.10](releases/0.1.0-beta.10.md) | Release notes for 0.1.0-beta.10. | release note (protected path) | 2026-10-07 |
| [Bloblex 0.1.0-beta.11](releases/0.1.0-beta.11.md) | Release notes for 0.1.0-beta.11. | release note (protected path) | 2026-10-08 |
| [Bloblex 0.1.0-beta.12](releases/0.1.0-beta.12.md) | Release notes for 0.1.0-beta.12. | release note (protected path) | 2026-10-08 |
| [Bloblex 0.1.0-beta.13](releases/0.1.0-beta.13.md) | Release notes for 0.1.0-beta.13. | release note (protected path) | 2026-10-10 |
| [Bloblex 0.1.0-beta.14](releases/0.1.0-beta.14.md) | Release notes for 0.1.0-beta.14. | release note (protected path) | 2026-10-10 |
| [Bloblex 0.1.0-beta.15](releases/0.1.0-beta.15.md) | Release notes for 0.1.0-beta.15. | release note (protected path) | 2026-10-11 |
| [Bloblex 0.1.0-beta.16](releases/0.1.0-beta.16.md) | Release notes for 0.1.0-beta.16. | release note (protected path) | 2026-10-11 |
| [Bloblex 0.1.0-beta.17](releases/0.1.0-beta.17.md) | Release notes for 0.1.0-beta.17. | release note (protected path) | 2026-10-11 |
| [Bloblex 0.1.0-beta.18](releases/0.1.0-beta.18.md) | Release notes for 0.1.0-beta.18. | release note (protected path) | 2026-10-12 |
| [Bloblex 0.1.0-beta.19](releases/0.1.0-beta.19.md) | Release notes for 0.1.0-beta.19. | release note (protected path) | 2026-10-19 |
| [Bloblex 0.1.0-beta.2](releases/0.1.0-beta.2.md) | Release notes for 0.1.0-beta.2. | release note (protected path) | 2026-10-02 |
| [Bloblex 0.1.0-beta.20](releases/0.1.0-beta.20.md) | Release notes for 0.1.0-beta.20. | release note (protected path) | 2026-10-13 |
| [Bloblex 0.1.0-beta.21](releases/0.1.0-beta.21.md) | Release notes for 0.1.0-beta.21. | release note (protected path) | 2026-10-13 |
| [Bloblex 0.1.0-beta.22](releases/0.1.0-beta.22.md) | Release notes for 0.1.0-beta.22. | release note (protected path) | 2026-10-14 |
| [Bloblex 0.1.0-beta.23](releases/0.1.0-beta.23.md) | Release notes for 0.1.0-beta.23. | release note (protected path) | 2026-10-14 |
| [Bloblex 0.1.0-beta.24](releases/0.1.0-beta.24.md) | Release notes for 0.1.0-beta.24. | release note (protected path) | 2026-10-14 |
| [Bloblex 0.1.0-beta.25](releases/0.1.0-beta.25.md) | Release notes for 0.1.0-beta.25. | release note (protected path) | 2026-10-14 |
| [Bloblex 0.1.0-beta.26](releases/0.1.0-beta.26.md) | Release notes for 0.1.0-beta.26. | release note (protected path) | 2026-10-14 |
| [Bloblex 0.1.0-beta.27](releases/0.1.0-beta.27.md) | Release notes for 0.1.0-beta.27. | release note (protected path) | 2026-10-14 |
| [Bloblex 0.1.0-beta.28](releases/0.1.0-beta.28.md) | Release notes for 0.1.0-beta.28. | release note (protected path) | 2026-10-14 |
| [Bitbots 0.1.0-beta.29](releases/0.1.0-beta.29.md) | Release notes for 0.1.0-beta.29. | release note (protected path) | 2026-10-15 |
| [Bloblex 0.1.0-beta.3](releases/0.1.0-beta.3.md) | Release notes for 0.1.0-beta.3. | release note (protected path) | 2026-10-03 |
| [Bitbots 0.1.0-beta.30](releases/0.1.0-beta.30.md) | Release notes for 0.1.0-beta.30. | release note (protected path) | 2026-10-17 |
| [Bitbots 0.1.0-beta.31](releases/0.1.0-beta.31.md) | Release notes for 0.1.0-beta.31. | release note (protected path) | 2026-10-17 |
| [Bitbots 0.1.0-beta.32](releases/0.1.0-beta.32.md) | Release notes for 0.1.0-beta.32. | release note (protected path) | 2026-10-18 |
| [Bitbots 0.1.0-beta.33](releases/0.1.0-beta.33.md) | Release notes for 0.1.0-beta.33. | release note (protected path) | 2026-10-18 |
| [Bitbots 0.1.0-beta.34](releases/0.1.0-beta.34.md) | Release notes for 0.1.0-beta.34. | release note (protected path) | 2026-10-18 |
| [Bitbots 0.1.0-beta.35](releases/0.1.0-beta.35.md) | Release notes for 0.1.0-beta.35. | release note (protected path) | 2026-10-19 |
| [Bitbots 0.1.0-beta.36](releases/0.1.0-beta.36.md) | Release notes for 0.1.0-beta.36. | release note (protected path) | 2026-10-19 |
| [Bloblex 0.1.0-beta.4](releases/0.1.0-beta.4.md) | Release notes for 0.1.0-beta.4. | release note (protected path) | 2026-10-04 |
| [Bloblex 0.1.0-beta.5](releases/0.1.0-beta.5.md) | Release notes for 0.1.0-beta.5. | release note (protected path) | 2026-10-04 |
| [Bloblex 0.1.0-beta.6](releases/0.1.0-beta.6.md) | Release notes for 0.1.0-beta.6. | release note (protected path) | 2026-10-04 |
| [Bloblex 0.1.0-beta.7](releases/0.1.0-beta.7.md) | Release notes for 0.1.0-beta.7. | release note (protected path) | 2026-10-06 |
| [Bloblex 0.1.0-beta.8](releases/0.1.0-beta.8.md) | Release notes for 0.1.0-beta.8. | release note (protected path) | 2026-10-06 |
| [Bloblex 0.1.0-beta.9](releases/0.1.0-beta.9.md) | Release notes for 0.1.0-beta.9. | release note (protected path) | 2026-10-06 |

## History

Dated records of the work. Each FIX wave has its own folder with its specs, briefs, reports, audits or research.

### FIX1: Dictation, OpenCode effort, team leader

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Fix 1A continuation: finish the dictation work (previous run stopped early)](history/fix-01/dictation-continue.md) | Instructions to finish the Fix 1A dictation work after an earlier run stopped early. | historical | 2026-10-13 |
| [Fix 1A spec: why ChatGPT dictation says "verification required" (diagnose, then fix what is ours)](history/fix-01/dictation-spec.md) | Spec for Fix 1A: why ChatGPT dictation reports verification required, and what to change in Bitbots. | historical; line 12 is amended for cloud dictation by the AGENTS.md amendment of 14 October 2026 | 2026-10-15 |
| [Fix 1B spec: OpenCode effort levels for DeepSeek (and every OpenCode model that has variants)](history/fix-01/opencode-effort-spec.md) | Spec for Fix 1B: OpenCode effort levels for DeepSeek and other OpenCode models with variants. | historical | 2026-10-15 |
| [Fix 1C continuation: finish the team/leader work (previous run stopped early)](history/fix-01/team-continue.md) | Instructions to finish the Fix 1C leader and team work after an earlier run stopped early. | superseded in part by [d1-manager-spec.md](history/fix-36/d1-manager-spec.md) | 2026-10-13 |
| [Fix 1C spec: leader-only blob creation over the Bitbots MCP bridge, workflows default on, one reaction per message](history/fix-01/team-spec.md) | Spec for Fix 1C: leader-only blob creation over the Bitbots MCP bridge, with workflows on by default. | superseded in part by [d1-manager-spec.md](history/fix-36/d1-manager-spec.md) | 2026-10-15 |

### FIX2: Codex team instructions, dictation TLS

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX2: Codex threads keep stale team instructions](history/fix-02/codex-team-instructions-spec.md) | Spec for FIX2: Codex threads that keep stale team instructions. | historical | 2026-10-15 |
| [Fix 2 spec: cloud dictation's TLS stack](history/fix-02/dictation-tls-spec.md) | Spec for Fix 2: the TLS stack used by cloud dictation. | historical | 2026-10-14 |

### FIX3: OpenCode 2 launch

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX3: OpenCode 2 does not accept `acp --cwd`](history/fix-03/opencode2-acp-launch-spec.md) | Spec for FIX3: OpenCode 2 does not accept the ACP `--cwd` launch argument. | historical | 2026-10-15 |

### FIX4: Clippy hygiene

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX4: bring `cargo clippy` back to clean (queued, run after beta.24)](history/fix-04/clippy-cleanup-spec.md) | Spec for FIX4: bringing `cargo clippy` back to clean, queued after beta.24. | historical | 2026-10-14 |

### FIX5: OpenCode 2 effort

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX5: OpenCode 2 per-model effort levels and a validated catalog](history/fix-05/opencode2-per-model-effort-spec.md) | Spec for FIX5: OpenCode 2 per-model effort levels and a validated catalog. | historical | 2026-10-14 |

### FIX6: OpenCode instructions

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX6: OpenCode turns fail when the blob's instructions change](history/fix-06/opencode-instructions-respawn-spec.md) | Spec for FIX6: OpenCode turns fail when a blob's instructions change. | historical | 2026-10-14 |

### FIX7: OpenCode usage and sign-in

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX7: OpenCode usage and sign-in status with OpenCode 1 and 2](history/fix-07/opencode-usage-and-signin-spec.md) | Spec for FIX7: OpenCode usage and sign-in status with OpenCode 1 and 2. | historical | 2026-10-15 |

### FIX8: Delegation timeline

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX8: delegation chips appear below the reply that follows them](history/fix-08/delegation-timeline-order-spec.md) | Spec for FIX8: delegation chips appear below the reply that follows them. | historical | 2026-10-14 |

### FIX9: Rename to Bitbots

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX9 rename report: Bloblex to Bitbots](history/fix-09/rename-report.md) | Report on FIX9: the rename from Bloblex to Bitbots. | historical | 2026-10-15 |
| [FIX9: rename the product from Bloblex to Bitbots](history/fix-09/rename-spec.md) | Spec for FIX9: renaming the product from Bloblex to Bitbots. | historical | 2026-10-15 |

### FIX10: Themes and style logic

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX10 report: theme style (Bitbots / Blobots) and user accent, logic layer](history/fix-10/report.md) | Report on FIX10: theme style (Bitbots and Blobots) and the user accent colour, logic layer. | historical | 2026-10-15 |
| [FIX10: theme style (Bitbots / Blobots) and user accent colour, logic layer](history/fix-10/theme-style-spec.md) | Spec for FIX10: theme style (Bitbots and Blobots) and the user accent colour, logic layer. | superseded in part by [themes-spec.md](history/fix-40/themes-spec.md) | 2026-10-15 |

### FIX11: Installed identity

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX11: Bitbots installed identity (installer, executables, data directory)](history/fix-11/identity-spec.md) | Spec for FIX11: the installed Bitbots identity (installer, executables and data directory). | historical | 2026-10-15 |
| [FIX11 report: Bitbots installed identity (installer, executables, data directory)](history/fix-11/report.md) | Report on FIX11: the installed Bitbots identity (installer, executables and data directory). | historical | 2026-10-15 |

### FIX12: Vocabulary (bots and blobs)

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX12 report — the characters are "bots" in Bitbots and "blobs" in Blobots](history/fix-12/report.md) | Report on FIX12: the characters are "bots" in Bitbots and "blobs" in Blobots. | historical | 2026-10-15 |
| [FIX12: the characters are "bots" in Bitbots and "blobs" in Blobots](history/fix-12/vocabulary-spec.md) | Spec for FIX12: the characters are "bots" in Bitbots and "blobs" in Blobots. | historical | 2026-10-15 |

### FIX13: UI preferences and polish

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX13: UI preferences plumbing, then a batch of small polish items](history/fix-13/prefs-and-polish-spec.md) | Spec for FIX13: UI preferences plumbing, then a batch of small polish items. | historical | 2026-10-15 |
| [FIX13 report: UI preferences plumbing + polish batch](history/fix-13/report.md) | Report on FIX13: UI preferences plumbing and a polish batch. | historical | 2026-10-15 |

### FIX14: Errors and connection resilience

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX14 report: plain-language errors, connection resilience, first-scan recovery, undo](history/fix-14/report.md) | Report on FIX14: plain-language errors, connection resilience, first-scan recovery and undo. | historical | 2026-10-15 |
| [FIX14: plain-language errors, connection resilience, first-scan recovery, undo](history/fix-14/resilience-spec.md) | Spec for FIX14: plain-language errors, connection resilience, first-scan recovery and undo. | historical | 2026-10-15 |

### FIX15: Conversation interactions

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX15: conversation interactions, roster interactions, density, skeletons](history/fix-15/conversation-spec.md) | Spec for FIX15: conversation interactions, roster interactions, density and skeletons. | historical | 2026-10-15 |
| [FIX15 report: conversation interactions, roster interactions, density, skeletons](history/fix-15/report.md) | Report on FIX15: conversation interactions, roster interactions, density and skeletons. | historical | 2026-10-15 |

### FIX16: Transport seam

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX16 report: a transport and platform seam](history/fix-16/report.md) | Report on FIX16: a transport and platform seam. | historical | 2026-10-15 |
| [FIX16: a transport and platform seam so the UI can run outside Tauri](history/fix-16/transport-seam-spec.md) | Spec for FIX16: a transport and platform seam so the UI can run outside Tauri. | historical | 2026-10-15 |

### FIX17: Remote simulator

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX17: the Remote mode simulator for the web preview](history/fix-17/remote-simulator-spec.md) | Spec for FIX17: the Remote mode simulator for the web preview. | historical | 2026-10-15 |
| [FIX17 report: the Remote mode simulator for the web preview](history/fix-17/report.md) | Report on FIX17: the Remote mode simulator for the web preview. | historical | 2026-10-15 |

### FIX18: Remote method tiers

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX18: which daemon methods a remote device may call (executable spec)](history/fix-18/remote-tiers-spec.md) | Executable spec for FIX18: which daemon methods a remote device may call. | historical | 2026-10-15 |
| [FIX18 report: remote method tiers](history/fix-18/report.md) | Report on FIX18: remote method tiers. | historical | 2026-10-15 |

### FIX19: Remote protocol document

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX19: write `docs/remote/PROTOCOL.md` (draft for the Director)](history/fix-19/remote-protocol-doc-spec.md) | Spec for FIX19: writing the remote protocol document (draft for the Director). | historical | 2026-10-15 |
| [FIX19 report: `docs/remote/PROTOCOL.md`](history/fix-19/report.md) | Report on FIX19: the remote protocol document. | historical | 2026-10-15 |

### FIX20: Companion access

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX20: companion keyboard access, offline banner, mood labels](history/fix-20/companion-access-spec.md) | Spec for FIX20: companion keyboard access, offline banner and mood labels. | historical | 2026-10-15 |
| [FIX20 report: companion keyboard access, offline banner, mood labels](history/fix-20/report.md) | Report on FIX20: companion keyboard access, offline banner and mood labels. | historical | 2026-10-15 |

### FIX21: Companion, second batch

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX21: companion, second batch (peek, focus mode, snap, activity, chat, drop, presence)](history/fix-21/companion-b-spec.md) | Spec for FIX21: the companion, second batch (peek, focus mode, snap, activity, chat, drop, presence). | historical | 2026-10-15 |
| [FIX21 report: companion, second batch (peek, focus mode, snap, activity, chat, drop, presence)](history/fix-21/report.md) | Report on FIX21: the companion, second batch. | historical | 2026-10-15 |

### FIX22: Bot page, second batch

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX22: bot page, second batch (instructions, folders, permissions, memory, details, templates)](history/fix-22/bot-page-b-spec.md) | Spec for FIX22: the bot page, second batch (instructions, folders, permissions, memory, details). | historical | 2026-10-15 |
| [FIX22 report — bot page, second batch](history/fix-22/report.md) | Report on FIX22: the bot page, second batch. | historical | 2026-10-15 |

### FIX23: Remote entry points

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX23: Remote entry points on the desktop (sidebar chip, profile menu, tour step)](history/fix-23/remote-entry-spec.md) | Spec for FIX23: Remote entry points on the desktop (sidebar chip, profile menu, tour step). | historical | 2026-10-15 |
| [FIX23 report: Remote entry points on the desktop](history/fix-23/report.md) | Report on FIX23: Remote entry points on the desktop. | historical | 2026-10-15 |

### FIX24: Remote independent review

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX24: independent review of the Remote design, and the sequence diagrams](history/fix-24/remote-review-spec.md) | Spec for FIX24: independent review of the Remote design and its sequence diagrams. | historical | 2026-10-15 |

### FIX25: Remote policy hardening

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX25: harden the remote policy code after the independent review](history/fix-25/remote-policy-hardening-spec.md) | Spec for FIX25: hardening the remote policy code after the independent review. | historical | 2026-10-15 |
| [FIX25 report: harden the remote policy code](history/fix-25/report.md) | Report on FIX25: hardening the remote policy code. | historical | 2026-10-15 |

### FIX27: Conversations per bot

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX27 (WP3) report: many conversations per bot, auto-titles, stable bot-to-bot tree](history/fix-27/conversations-report.md) | Report on FIX27 (WP3): many conversations per bot, auto-titles and a stable bot-to-bot tree. | historical | 2026-10-16 |
| [FIX27 (WP3): many conversations per bot, auto-titles, and a stable bot-to-bot tree](history/fix-27/conversations-spec.md) | Spec for FIX27 (WP3): many conversations per bot, auto-titles and a stable bot-to-bot tree. | historical | 2026-10-16 |

### FIX28: Model catalog and send

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX28 part 1 (WP1): model catalog cache — implementation report](history/fix-28/catalog-report.md) | Implementation report for FIX28 part 1 (WP1): the model catalog cache. | historical | 2026-10-16 |
| [FIX28 part 1 (WP1): a model catalog cache that never makes the user wait](history/fix-28/catalog-spec.md) | Spec for FIX28 part 1 (WP1): a model catalog cache that never makes the user wait. | historical | 2026-10-16 |
| [FIX28 part 2 (WP2): sending never blocks, and conversations warm up early — implementation report](history/fix-28/send-report.md) | Implementation report for FIX28 part 2 (WP2): sending and conversation warm-up. | historical | 2026-10-16 |
| [FIX28 part 2 (WP2): sending never blocks, and conversations warm up early](history/fix-28/send-spec.md) | Spec for FIX28 part 2 (WP2): sending never blocks, and conversations warm up early. | historical | 2026-10-16 |

### FIX29: Remote gateway and PWA

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX29 (WP6a): one remote policy for Rust and TypeScript](history/fix-29/wp6a-policy-spec.md) | Spec for FIX29 (WP6a): one remote policy for Rust and TypeScript. | historical | 2026-10-17 |
| [FIX29 (WP6a): one remote policy for Rust and TypeScript — implementation report](history/fix-29/wp6a-report.md) | Implementation report for FIX29 (WP6a): one remote policy for Rust and TypeScript. | historical | 2026-10-17 |
| [FIX29 (WP6b): the remote gateway in `bitbotsd` over Tailscale](history/fix-29/wp6b-gateway-spec.md) | Spec for FIX29 (WP6b): the remote gateway in the daemon over Tailscale. | historical | 2026-10-17 |
| [FIX29 WP6b — the remote gateway in `bitbotsd` over Tailscale](history/fix-29/wp6b-report.md) | Report on FIX29 WP6b: the remote gateway in the daemon over Tailscale. | historical | 2026-10-17 |
| [FIX29 (WP6c): the remote PWA build, transport and service worker](history/fix-29/wp6c-pwa-spec.md) | Spec for FIX29 (WP6c): the remote PWA build, transport and service worker. | historical | 2026-10-17 |
| [FIX29 (WP6c) report: the remote PWA build, transport and service worker](history/fix-29/wp6c-report.md) | Report on FIX29 (WP6c): the remote PWA build, transport and service worker. | historical | 2026-10-17 |
| [FIX29 (WP6c-1): the desktop crate builds before the remote app exists](history/fix-29/wp6c1-build-spec.md) | Spec for FIX29 (WP6c-1): the desktop crate builds before the remote app exists. | historical | 2026-10-17 |
| [FIX29 (WP6c-1) report: the desktop crate builds before the remote app exists](history/fix-29/wp6c1-report.md) | Report on FIX29 (WP6c-1): the desktop crate builds before the remote app exists. | historical | 2026-10-17 |
| [FIX29 (WP6d): align the remote UI contract, hook and simulator with the Tailscale design](history/fix-29/wp6d-contract-spec.md) | Spec for FIX29 (WP6d): aligning the remote UI contract, hook and simulator with the Tailscale design. | historical | 2026-10-17 |
| [FIX29 WP6d report — the remote UI contract, hook and simulator on the Tailscale design](history/fix-29/wp6d-report.md) | Report on FIX29 WP6d: the remote UI contract, hook and simulator. | historical | 2026-10-17 |

### FIX31: Backup and restore

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX31 (WP5) — back up and restore bots, memory, skills, automations and settings](history/fix-31/backup-report.md) | Report on FIX31 (WP5): backup and restore. | historical | 2026-10-17 |
| [FIX31 (WP5): back up and restore bots, memory, skills, automations and settings](history/fix-31/backup-spec.md) | Spec for FIX31 (WP5): backing up and restoring bots, memory, skills, automations and settings. | historical | 2026-10-16 |

### FIX32: Shared skills pool

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX32 (WP4) — one shared pool of skills for every bot](history/fix-32/skills-report.md) | Report on FIX32 (WP4): the shared skills pool. | historical | 2026-10-16 |
| [FIX32 (WP4): one shared pool of skills for every bot](history/fix-32/skills-spec.md) | Spec for FIX32 (WP4): one shared pool of skills for every bot. | historical | 2026-10-16 |

### FIX33: Small backend items

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX33 (WP7) report — small backend items from the owner review](history/fix-33/report.md) | Report on FIX33 (WP7): small backend items from the owner review. | historical | 2026-10-16 |
| [FIX33 (WP7): small backend items from the owner review](history/fix-33/small-backend-spec.md) | Spec for FIX33 (WP7): small backend items from the owner review. | historical | 2026-10-16 |

### FIX34: Remote web app, fresh session, CLI sign-in

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX34 A1: the remote web app loads ("Bitbots Remote is not installed")](history/fix-34/a1-remote-web-spec.md) | Spec for FIX34 A1: the remote web app loads instead of reporting that Bitbots Remote is not installed. | historical | 2026-10-17 |
| [FIX34 A1 report — the remote web app loads](history/fix-34/a1-report.md) | Report on FIX34 A1: the remote web app loads. | historical | 2026-10-17 |
| [FIX34 A2: "Started a fresh session" must not repeat in existing conversations](history/fix-34/a2-fresh-session-spec.md) | Spec for FIX34 A2: the fresh-session notice must not repeat in existing conversations. | historical | 2026-10-17 |
| [FIX34 A2: fresh-session notice on existing conversations](history/fix-34/a2-report.md) | Report on FIX34 A2: the fresh-session notice on existing conversations. | historical | 2026-10-17 |
| [FIX34 A5 follow-up: terminal launch quoting](history/fix-34/a5-followup.md) | Follow-up note for FIX34 A5: terminal launch quoting. | historical | 2026-10-17 |
| [FIX34 A5 — an expired CLI sign-in is detected, flagged and fixable from the app](history/fix-34/a5-report.md) | Report on FIX34 A5: an expired CLI sign-in is detected, flagged and fixable from the app. | historical | 2026-10-17 |
| [FIX34 A5: expired CLI sign-in is detected, flagged and fixable from the app](history/fix-34/a5-sign-in-spec.md) | Spec for FIX34 A5: detecting and fixing an expired CLI sign-in from the app. | historical | 2026-10-17 |

### FIX35: Native Remote

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX35 C1: Native Remote — a TLS listener on the public port with password sign-in](history/fix-35/c1-native-remote-spec.md) | Spec for FIX35 C1: Native Remote, a TLS listener on the public port with password sign-in. | historical | 2026-10-17 |
| [FIX35 C1 — Native Remote: a TLS listener on the public port with password sign-in](history/fix-35/c1-report.md) | Report on FIX35 C1: Native Remote. | historical | 2026-10-17 |
| [FIX35 C2: Native Remote connectivity — UPnP, firewall, CGNAT, external IP, self-test](history/fix-35/c2-connectivity-spec.md) | Spec for FIX35 C2: Native Remote connectivity (UPnP, firewall, CGNAT, external IP and self-test). | historical | 2026-10-17 |
| [FIX35 C2: finish up](history/fix-35/c2-finish.md) | Follow-up note for FIX35 C2: finishing up. | historical | 2026-10-17 |
| [FIX35 C2 — Native Remote connectivity: UPnP mapping, firewall, external IP, CGNAT, self-test](history/fix-35/c2-report.md) | Report on FIX35 C2: Native Remote connectivity. | historical | 2026-10-17 |
| [FIX35 follow-up: firewall rule name and the phone's sign-in call](history/fix-35/c3-followup.md) | Follow-up note for FIX35: the firewall rule name and the phone's sign-in call. | historical | 2026-10-17 |
| [FIX35 follow-up: tests must not bind all interfaces](history/fix-35/c4-test-bind.md) | Follow-up note for FIX35: tests must not bind all interfaces. | historical | 2026-10-17 |
| [FIX35 follow-up: no console flashes, one UAC prompt](history/fix-35/c5-windows.md) | Follow-up note for FIX35: no console flashes and one UAC prompt. | historical | 2026-10-17 |
| [FIX35 follow-up: a signed-out phone learns the method](history/fix-35/c6-me-method.md) | Follow-up note for FIX35: a signed-out phone learns the sign-in method. | historical | 2026-10-17 |

### FIX36: Manager bot

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX36 D1 follow-up: old databases must still migrate](history/fix-36/d1-followup.md) | Follow-up note for FIX36 D1: old databases must still migrate. | historical | 2026-10-17 |
| [FIX36 D1: the Manager — a permanent, global bot that replaces the team leader](history/fix-36/d1-manager-spec.md) | Spec for FIX36 D1: the Manager, a permanent global bot that replaces the team leader. | historical | 2026-10-17 |
| [FIX36 D1 — the Manager (lane report)](history/fix-36/d1-report.md) | Lane report for FIX36 D1: the Manager. | historical | 2026-10-17 |
| [FIX36 D2: the Manager proposes, the owner approves — projects, bots, tasks, and questions](history/fix-36/d2-proposals-spec.md) | Spec for FIX36 D2: the Manager proposes and the owner approves (projects, bots, tasks and questions). | historical | 2026-10-17 |
| [FIX36 D2 — the Manager proposes, the owner approves (lane report)](history/fix-36/d2-report.md) | Lane report for FIX36 D2: the Manager proposes and the owner approves. | historical | 2026-10-17 |
| [FIX36 D3: what the Manager knows outlives its model — profile, playbook, handover](history/fix-36/d3-knowledge-spec.md) | Spec for FIX36 D3: what the Manager knows outlives its model (profile, playbook, handover). | historical | 2026-10-17 |
| [FIX36 D3 — what the Manager knows outlives its model (lane report)](history/fix-36/d3-report.md) | Lane report for FIX36 D3: what the Manager knows outlives its model. | historical | 2026-10-17 |

### FIX37: Remote, resume, UI polish, slash commands, updates

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX37 G1: the phone page downloads instead of opening; Claude fails after signing in again](history/fix-37/g1-remote-and-resume-spec.md) | Spec for FIX37 G1: the phone page downloads instead of opening, and a Claude resume fails after sign-in. | historical | 2026-10-18 |
| [FIX37 G1 report: the Remote page downloads; a Claude resume that never initializes](history/fix-37/g1-report.md) | Report on FIX37 G1: the Remote page downloads, and a Claude resume that never initialises. | historical | 2026-10-18 |
| [FIX37 G2 — sidebar logos, clipped tooltips, clipped badge shadow](history/fix-37/g2-report.md) | Report on FIX37 G2: sidebar logos, clipped tooltips and clipped badge shadow. | historical | 2026-10-18 |
| [FIX37 G2: sidebar logos, clipped tooltips, clipped badge shadow](history/fix-37/g2-ui-polish-spec.md) | Spec for FIX37 G2: sidebar logos, clipped tooltips and a clipped badge shadow. | historical | 2026-10-18 |
| [FIX37 G3 — selection after a delete or archive](history/fix-37/g3-report.md) | Report on FIX37 G3: selection after a delete or archive. | historical | 2026-10-18 |
| [FIX37 G3: the app jumps between bots by itself after a delete or archive](history/fix-37/g3-selection-spec.md) | Spec for FIX37 G3: the app jumps between bots after a delete or archive. | historical | 2026-10-18 |
| [FIX37 G4 — slash commands in the composer (lane report)](history/fix-37/g4-report.md) | Lane report for FIX37 G4: slash commands in the composer. | historical | 2026-10-18 |
| [FIX37 G4: slash commands in the composer (skills, actions, Manager commands)](history/fix-37/g4-slash-commands-spec.md) | Spec for FIX37 G4: slash commands in the composer (skills, actions and Manager commands). | historical | 2026-10-18 |
| [FIX37 G5: automatic updates with a "Downloading" / "Restart to update" badge](history/fix-37/g5-auto-update-spec.md) | Spec for FIX37 G5: automatic updates with a Downloading and Restart to update badge. | historical | 2026-10-18 |
| [FIX37 G5 — automatic updates with a "Downloading" / "Restart to update" badge](history/fix-37/g5-report.md) | Report on FIX37 G5: automatic updates with a Downloading and Restart to update badge. | historical | 2026-10-18 |
| [FIX37 G6: the browser preview breaks on the new update exports](history/fix-37/g6-preview-parity-spec.md) | Spec for FIX37 G6: the browser preview breaks on the new update exports. | historical | 2026-10-18 |
| [FIX37 G6 report: browser preview parity with the update exports](history/fix-37/g6-report.md) | Report on FIX37 G6: browser preview parity with the update exports. | historical | 2026-10-18 |

### FIX38: Remote pairing, empty conversation, tree lines

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX38 H1: Remote pairing never completes (Tailscale and Direct) — dig deep](history/fix-38/h1-remote-pairing-spec.md) | Spec for FIX38 H1: Remote pairing never completes over Tailscale or Direct. | historical | 2026-10-18 |
| [FIX38 H1 — Remote pairing never completes (Tailscale and Direct)](history/fix-38/h1-report.md) | Report on FIX38 H1: Remote pairing never completes (Tailscale and Direct). | historical | 2026-10-18 |
| [FIX38 H2: clicking a bot with no conversation flashes, jumps to another bot, and saves a conversation named after the bot — dig deep](history/fix-38/h2-empty-conversation-spec.md) | Spec for FIX38 H2: clicking a bot with no conversation flashes, jumps and saves a conversation. | historical | 2026-10-18 |
| [FIX38 H2 — clicking a bot with no conversation](history/fix-38/h2-report.md) | Report on FIX38 H2: clicking a bot with no conversation. | historical | 2026-10-18 |
| [FIX38 H3 — broken branch lines in the Conversations column (classic look)](history/fix-38/h3-report.md) | Report on FIX38 H3: broken branch lines in the Conversations column (classic look). | historical | 2026-10-18 |
| [FIX38 H3: broken branch lines in the Conversations column (classic look)](history/fix-38/h3-tree-lines-spec.md) | Spec for FIX38 H3: broken branch lines in the Conversations column (classic look). | historical | 2026-10-18 |

### FIX39: Four-model pipeline, backend and UI items

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX39 implementation audit brief (Claude Sonnet 5.5)](history/fix-39/audit-impl-brief.md) | Brief for the implementation audit in FIX39 (Claude Sonnet 5.5). | historical | 2026-10-18 |
| [FIX39 research audit brief (Claude Sonnet 5.5)](history/fix-39/audit-research-brief.md) | Brief for the research audit in FIX39 (Claude Sonnet 5.5). | historical | 2026-10-18 |
| [FIX39 owner decisions (18 October 2026)](history/fix-39/decisions.md) | Owner decisions of 18 October 2026 that override the FIX39 research. | historical | 2026-10-18 |
| [FIX39 Director checks (browser preview)](history/fix-39/director-checks.md) | Director checks for FIX39 in the browser preview. | historical | 2026-10-18 |
| [FIX39 documentation brief (Claude Haiku 5.5)](history/fix-39/docs-brief.md) | Brief for the FIX39 documentation pass (Claude Haiku 5.5). | historical | 2026-10-18 |
| [FIX39 owner feedback (18 October 2026, after beta.33)](history/fix-39/feedback.md) | Owner feedback of 18 October 2026, after beta.33: the 24 items FIX39 addresses. | historical | 2026-10-18 |
| [FIX39 implementation brief (GPT Sol 6.1)](history/fix-39/implement-brief.md) | Brief for FIX39 implementation (GPT Sol 6.1). | historical | 2026-10-18 |
| [FIX39 P1 audit (Claude Sonnet 5.5)](history/fix-39/p1-audit.md) | Audit of FIX39 package P1 by Claude Sonnet 5.5. | historical | 2026-10-18 |
| [FIX39 P1 implementation report](history/fix-39/p1-report.md) | Implementation report for FIX39 package P1 (usage dialog, effort picker, search, update banner and more). | historical | 2026-10-18 |
| [FIX39 P10 audit — worktrees for parallel code tasks](history/fix-39/p10-audit.md) | Audit of FIX39 package P10: worktrees for parallel code tasks. | historical | 2026-10-18 |
| [FIX39 P10 report — worktrees for parallel code tasks](history/fix-39/p10-report.md) | Report for FIX39 package P10: worktrees for parallel code tasks. | historical | 2026-10-18 |
| [FIX39 P11 audit — reliability tests against the real CLIs](history/fix-39/p11-audit.md) | Audit of FIX39 package P11: reliability tests against the real CLIs. | historical | 2026-10-18 |
| [FIX39 P11 report — reliability tests against the real CLIs](history/fix-39/p11-report.md) | Report for FIX39 package P11: reliability tests against the real CLIs. | historical | 2026-10-18 |
| [FIX39 P12 audit — local diagnostics](history/fix-39/p12-audit.md) | Audit of FIX39 package P12: local diagnostics. | historical | 2026-10-18 |
| [FIX39 P12 report — local diagnostics](history/fix-39/p12-report.md) | Report for FIX39 package P12: local diagnostics. | historical | 2026-10-18 |
| [FIX39 P13 audit (Claude Sonnet 5.5)](history/fix-39/p13-audit.md) | Audit of FIX39 package P13 by Claude Sonnet 5.5. | historical | 2026-10-18 |
| [FIX39 P13 report — fixes found by the real-CLI tests](history/fix-39/p13-report.md) | Report for FIX39 package P13: fixes found by the real-CLI tests. | historical | 2026-10-18 |
| [FIX39 P2 audit (Claude Sonnet 5.5)](history/fix-39/p2-audit.md) | Audit of FIX39 package P2 by Claude Sonnet 5.5. | historical | 2026-10-18 |
| [FIX39 P2 implementation report](history/fix-39/p2-report.md) | Implementation report for FIX39 package P2 (readable activity and shape validation). | historical | 2026-10-18 |
| [FIX39 P3 audit (Claude Sonnet 5.5)](history/fix-39/p3-audit.md) | Audit of FIX39 package P3 by Claude Sonnet 5.5. | historical | 2026-10-18 |
| [FIX39 P3 report — Remote and native shell (items 23, 24, 10)](history/fix-39/p3-report.md) | Report for FIX39 package P3: Remote and native shell (items 23, 24 and 10). | historical | 2026-10-18 |
| [FIX39 P4 audit (Claude Sonnet 5.5)](history/fix-39/p4-audit.md) | Audit of FIX39 package P4 by Claude Sonnet 5.5. | historical | 2026-10-18 |
| [FIX39 P4 implementation report](history/fix-39/p4-report.md) | Implementation report for FIX39 package P4: symmetrical shapes, shape-preserving Shuffle and migration. | historical | 2026-10-18 |
| [FIX39 P5 audit (Claude Sonnet 5.5)](history/fix-39/p5-audit.md) | Audit of FIX39 package P5 by Claude Sonnet 5.5. | historical | 2026-10-18 |
| [FIX39 P5 — per-bot settings, permissions, lock, Experimental tab](history/fix-39/p5-report.md) | Report for FIX39 package P5: per-bot settings, permissions, lock and the Experimental tab. | historical | 2026-10-18 |
| [FIX39 P6 audit (Claude Sonnet 5.5)](history/fix-39/p6-audit.md) | Audit of FIX39 package P6 by Claude Sonnet 5.5. | historical | 2026-10-18 |
| [FIX39 package P6 — orchestration: parallel conversations, context recovery, tags](history/fix-39/p6-report.md) | Report for FIX39 package P6: parallel conversations, context recovery and tags. | historical | 2026-10-18 |
| [FIX39 P7 implementation audit (Claude Sonnet 5.5)](history/fix-39/p7-audit.md) | Implementation audit of FIX39 package P7 by Claude Sonnet 5.5. | historical | 2026-10-18 |
| [FIX39 P7 implementation report](history/fix-39/p7-report.md) | Implementation report for FIX39 package P7: the Bitbots tool set for the Manager. | historical | 2026-10-18 |
| [FIX39 P8 implementation audit (Claude Sonnet 5.5)](history/fix-39/p8-audit.md) | Implementation audit of FIX39 package P8 by Claude Sonnet 5.5. | historical | 2026-10-18 |
| [FIX39 package P8 — watchdog (T3 recommendations 3 and 4)](history/fix-39/p8-report.md) | Report for FIX39 package P8: the watchdog (T3 recommendations 3 and 4). | historical | 2026-10-18 |
| [FIX39 P9 audit (Claude Sonnet 5.5)](history/fix-39/p9-audit.md) | Audit of FIX39 package P9 by Claude Sonnet 5.5. | historical | 2026-10-18 |
| [FIX39 P9 implementation report](history/fix-39/p9-report.md) | Implementation report for FIX39 package P9. | historical | 2026-10-18 |
| [FIX39 research audit (Claude Sonnet 5.5)](history/fix-39/research-audit.md) | Audit of the FIX39 research by Claude Sonnet 5.5, before implementation. | historical | 2026-10-18 |
| [FIX39 research brief (DeepSeek lanes)](history/fix-39/research-brief.md) | Brief for the FIX39 research lanes (DeepSeek). | historical | 2026-10-18 |
| [FIX39 research — lane R1 (UI and UX, items 1–15)](history/fix-39/research-r1.md) | Research lane R1 for FIX39: UI and UX items 1 to 15. | historical | 2026-10-18 |
| [FIX39 research R2 — items 16–20](history/fix-39/research-r2.md) | Research lane R2 for FIX39: items 16 to 20. | historical | 2026-10-18 |
| [FIX39 research — lane R3](history/fix-39/research-r3.md) | Research lane R3 for FIX39. | historical | 2026-10-18 |

### FIX40: Looks, bot art, themes

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX40 Characters lane: bot art styles (light robots, hand-painted blobs) and the bot editor](history/fix-40/characters-spec.md) | Spec for the FIX40 Characters lane: bot art styles, light robots, hand-painted blobs and the bot editor. | historical | 2026-10-19 |
| [FIX40: look orbs instead of mini screenshots](history/fix-40/orbs-spec.md) | Spec for FIX40: look orbs instead of mini screenshots. | historical | 2026-10-19 |
| [FIX40 report: Bitbots looks, bot art and look orbs](history/fix-40/report.md) | Report for FIX40: Bitbots looks, bot art and look orbs. | historical; a record as of 19 October 2026 | 2026-10-19 |
| [FIX40 round 2: the Pop and Dot looks across the whole app](history/fix-40/round2-spec.md) | Spec for FIX40 round 2: the Pop and Dot looks across the whole app. | historical | 2026-10-19 |
| [FIX40 research brief: how T3 Code runs its agents, and what Bitbots should take from it](history/fix-40/t3-research-brief.md) | Brief for the FIX40 T3 Code research. | historical | 2026-10-18 |
| [FIX40 research — how T3 Code runs its agents, and what Bitbots should take from it](history/fix-40/t3-research.md) | Research on how T3 Code runs its agents, and what Bitbots should take from it (FIX40). | historical | 2026-10-18 |
| [FIX40 Themes lane: Frost becomes Bitbots, new looks, fonts, wallpapers, Appearance page](history/fix-40/themes-spec.md) | Spec for the FIX40 Themes lane: Frost becomes Bitbots, new looks, fonts, wallpapers and the Appearance page. | historical | 2026-10-19 |

### FIX41: Companion and dictation looks

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [FIX41 brief: the looks reach the companion and dictation windows](history/fix-41/companion-looks-brief.md) | Brief for FIX41: the looks reach the companion and dictation windows. | historical | 2026-10-19 |
| [FIX41 report: looks on the companion and dictation windows](history/fix-41/companion-looks-report.md) | Report for FIX41: looks on the companion and dictation windows. | historical; a record as of 19 October 2026 | 2026-10-19 |
| [FIX41 leftovers brief (Codex lane)](history/fix-41/leftovers-brief.md) | Brief for the FIX41 leftovers (Codex lane). | historical | 2026-10-19 |

### Improvement plan phases

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Phase 1A spec: one turn-end path, honest timeouts, delivery facts](history/improvement/phase-1a-spec.md) | Spec for the improvement plan's phase 1A: one turn-end path, honest timeouts and delivery facts. | historical | 2026-10-12 |
| [Phase 1B spec: typed recovery hints and honest context-change notices](history/improvement/phase-1b-spec.md) | Spec for phase 1B: typed recovery hints and honest context-change notices. | historical | 2026-10-12 |
| [Phase 2A spec: durable prompt queue and "send later" (backend)](history/improvement/phase-2a-spec.md) | Spec for phase 2A: a durable prompt queue and "send later" (backend). | historical | 2026-10-12 |
| [Phase 2B spec: steer a live Codex turn (backend, gated off by default)](history/improvement/phase-2b-spec.md) | Spec for phase 2B: steering a live Codex turn (backend, gated off by default). | historical | 2026-10-12 |
| [Phase 3A spec: safe automatic retry after overload and rate limits (backend)](history/improvement/phase-3a-spec.md) | Spec for phase 3A: safe automatic retry after overload and rate limits (backend). | historical | 2026-10-15 |
| [Phase 3B spec: recorded-wire replay tests per CLI version (test infrastructure)](history/improvement/phase-3b-spec.md) | Spec for phase 3B: recorded-wire replay tests per CLI version (test infrastructure). | historical | 2026-10-13 |
| [Phase 4A spec: scheduled automations for blobs (backend)](history/improvement/phase-4a-spec.md) | Spec for phase 4A: scheduled automations for blobs (backend). | historical | 2026-10-12 |
| [Phase 4B spec: keep the computer awake while Bitbots has work (native)](history/improvement/phase-4b-spec.md) | Spec for phase 4B: keeping the computer awake while Bitbots has work (native). | historical | 2026-10-15 |
| [Phase 5A spec: memory and "about you" (backend)](history/improvement/phase-5a-spec.md) | Spec for phase 5A: memory and "about you" (backend). | historical | 2026-10-12 |
| [Phase 6A spec: ask-the-user tool for OpenCode, hand-off draft and notification level (backend)](history/improvement/phase-6a-spec.md) | Spec for phase 6A: an ask-the-user tool for OpenCode, hand-off draft and notification level (backend). | historical | 2026-10-15 |
| [Phase 7 spec: opt-in cloud dictation through the Codex login (backend and native)](history/improvement/phase-7-spec.md) | Spec for phase 7: opt-in cloud dictation through the Codex login (backend and native). | historical | 2026-10-14 |
| [Bitbots improvement plan: CLI connectivity, reasoning effort, and dictation](history/improvement/plan-v1-qa-draft.md) | Early improvement plan (CLI connectivity, reasoning effort and dictation), QA draft, 12 October 2026. | superseded by [improvement-plan.md](plans/improvement-plan.md) | 2026-10-15 |

### Phase specs

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Phase 2a implementation spec: agent identity, storage and RPCs](history/phases/phase-2a-spec.md) | Implementation spec for phase 2a: agent identity, storage and RPCs. | historical | 2026-10-04 |
| [Phase 2b specification: execution options per blob](history/phases/phase-2b-spec.md) | Specification for phase 2b: execution options per blob. | historical | 2026-10-15 |
| [Phase 3 implementation spec: blob roster and editor](history/phases/phase-3-spec.md) | Implementation spec for phase 3: the blob roster and editor. | historical | 2026-10-15 |
| [Phase 4 implementation spec: per-blob project and session tree](history/phases/phase-4-spec.md) | Implementation spec for phase 4: the per-blob project and session tree. | historical | 2026-10-15 |

### Director log

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Director log](history/director-log.md) | Director log of the delegated work, kept as a dated record. | historical | 2026-10-15 |

### Product expansion, 20 and 21 October 2026 (paused records)

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Lane records and contracts](history/expansion/README.md) | Index of the paused lane reports, contracts and snapshot manifests from the owner's pause. | historical record, superseded in part (see its 22 October update) | 2026-10-22 |

### Product expansion v2, from 21 October 2026

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Expansion v2 records](history/expansion-v2/README.md) | Index of the phase 1 plan records, the working arrangement and the status table. | current index; its status table was written before the 22 October merge | 2026-10-22 |
| [Phase 1 status](history/expansion-v2/status.md) | Status of each phase 1 slice, with its evidence. | written before the 22 October merge; the 22 October entry in implementation status gives the merged state | 2026-10-21 |

## Library work records

The documentation lane keeps its inventory, progress log and review log here.

| Document | What it is | Status | Last updated |
| --- | --- | --- | --- |
| [Documentation library work log](library/audits/library-progress.md) | the running log of the library build lane (branch `docs-library`, worktree `D:\fx50`), kept so a successor can resume after an interruption. | complete for this brief; the checks and the report are recorded below. | 2026-10-19 |
| [Documentation inventory](library/audits/inventory.md) | the inventory of every tracked Markdown file, taken before any move (phase 1), with the old-to-new path map (phase 2). Lane work record; the library index lists it under library work records. | working record, written by the documentation lane (branch `docs-library`, worktree `D:\fx50`). | 2026-10-19 |
| [Documentation library work log](library/audits/progress.md) | the running log of the documentation lane (branch `docs-library`, worktree `D:\fx50`). Written so that a successor can resume after an interruption. | complete for this brief. Four phases are done; the owner decisions listed under "Open for the owner" are not. | 2026-10-19 |
| [docs/library/audits/review-1-reply.md](library/audits/review-1-reply.md) |  |  | 2026-10-19 |
| [Review request 1: the documentation library](library/audits/review-1-request.md) |  |  | 2026-10-19 |
| [docs/library/audits/review-2-reply.md](library/audits/review-2-reply.md) |  |  | 2026-10-19 |
| [Review request 2: the documentation library, after round 1](library/audits/review-2-request.md) |  |  | 2026-10-19 |
| [docs/library/audits/review-3-reply.md](library/audits/review-3-reply.md) |  |  | 2026-10-19 |
| [Review request 3: the documentation library, after round 2](library/audits/review-3-request.md) |  |  | 2026-10-19 |
| [Review log: Codex Luna](library/audits/review-log.md) | the record of each review round with Codex Luna (`gpt-6-luna`, high, read-only): Luna's points, the answer for each, and what changed. | complete; three rounds, no must-fix point left open. | 2026-10-19 |
