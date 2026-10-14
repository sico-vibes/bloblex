# Bloblex documentation hub

One place for every Markdown file in the repository. Each entry gives a one-line purpose, a status, and how far this pass checked it. The audit of each file is in [DOCS_AUDIT.md](DOCS_AUDIT.md). Where this hub and a document disagree, the code wins, then [AGENTS.md](../AGENTS.md) for rules.

**Verification levels** (pass of 14 October 2026):
- *read in full*: every line read and concrete claims checked against code.
- *claims checked*: read in full or in large part, with specific claims (paths, versions, names, limits) checked against code.
- *header and links*: the opening lines and links read, no claim-level check.
- *links only*: link and path check only. Used for immutable records (`releases/`, `evidence/`), which were not edited beyond link repair.

Status values: `current`, `superseded by <link>`, `historical`, or `in flight` (named by the owner, not in this tree).

## Start here

- **AI agents:** read [AGENTS.md](../AGENTS.md) first. It is the owner directive, with dated amendments newest first. Then [OPERATING_MODEL.md](OPERATING_MODEL.md) (the rules in effect today, derived from AGENTS.md). Then [implementation-status.md](implementation-status.md) for open gaps and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for release state.
- **New contributors:** [README.md](../README.md), then [windows-development.md](windows-development.md), [PRODUCT.md](../PRODUCT.md), [DESIGN.md](../DESIGN.md), [ipc-contract.md](ipc-contract.md) and [runtime-capabilities.md](runtime-capabilities.md).
- **Release state today:** `v0.1.0-beta.28` ([releases/0.1.0-beta.28.md](releases/0.1.0-beta.28.md)). The signed updater feed is still at `v0.1.0-beta.6` ([UPDATER.md](UPDATER.md)).

## Rules and ownership

| Document | Purpose | Status | Last verified |
| --- | --- | --- | --- |
| [AGENTS.md](../AGENTS.md) | Owner directive: lanes, dictation exception, request-shape matching for cloud dictation, commit authority, invariants. Not edited by this pass. | current (amendments of 12 and 14 Oct 2026 override earlier sections; see the contradictions list in the audit) | 14 Oct 2026: read in full |
| [OPERATING_MODEL.md](OPERATING_MODEL.md) | Short derived summary of the rules effective today, each bullet cited to AGENTS.md. | current (new in this pass) | 14 Oct 2026: derived from AGENTS.md |
| [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) | Licence and attribution for adapted reference code, vendored robot-heads, fonts and the dictation model terms. | current | 14 Oct 2026: claims checked in part (vendored files and source mechanisms exist) |

## Product and design

| Document | Purpose | Status | Last verified |
| --- | --- | --- | --- |
| [README.md](../README.md) | Repository front page: status, local development commands, source map, references. | current (corrected in this pass: version, budgets, bundle targets, updater state) | 14 Oct 2026: claims checked |
| [PRODUCT.md](../PRODUCT.md) | Users, purpose, anti-references and design principles. | current | 14 Oct 2026: read in full (product intent; no code facts) |
| [DESIGN.md](../DESIGN.md) | Tokens, layout, controls, companion corner radii and mood timings. | current | 14 Oct 2026: claims checked (radii, timers, token file, control files) |
| [APPROVAL_MODES.md](APPROVAL_MODES.md) | ask / auto / bypass contract and per-provider mapping. | current; budget clauses superseded by AGENTS.md 12 Oct amendment (corrected in this pass) | 14 Oct 2026: read in full; defaults checked (`main.rs:1060`) |

## Architecture and contracts

| Document | Purpose | Status | Last verified |
| --- | --- | --- | --- |
| [ipc-contract.md](ipc-contract.md) | Daemon RPC and event contract, transport, normalized types and security invariants. | current; budget, pricing and subscription sections retired (corrected in this pass) | 14 Oct 2026: read in full; RPC names diffed against dispatch; limits spot-checked |
| [runtime-capabilities.md](runtime-capabilities.md) | Evidence record of what each CLI build was observed to do. Includes a labelled OpenCode 2.0.28 block (14 Oct 2026). | current as an evidence record for 1-13 Oct builds; 2.0.28 block labelled | 14 Oct 2026: read in full; line citations re-checked and corrected |
| [PHASE_5_CONTRACT.md](PHASE_5_CONTRACT.md) | Usage analytics RPC and UI contract. | superseded in part (monetary cost and subscription sections retired; `failureClass` values differ from code) | 14 Oct 2026: read in full (first 68 lines, whole file) |

## Specs

| Document | Purpose | Status | Last verified |
| --- | --- | --- | --- |
| [E2E_PLAN_V2.md](E2E_PLAN_V2.md) | The long-running plan for backend and UI phases, with dated checkpoints. | current plan; checkpoint sections are dated and historical (broken links repaired) | 14 Oct 2026: claims partly checked; links checked |
| [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) | Owner-approved v2 roadmap (Phases 1-7), shipped in `v0.1.0-beta.19`. | current roadmap; phases delivered (stale line citations corrected) | 14 Oct 2026: claims checked in part |
| [PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) | Agent identity, storage and RPCs. | historical (delivered) | 14 Oct 2026: header and links |
| [PHASE_2B_SPEC.md](PHASE_2B_SPEC.md) | Execution options per blob and their gates. | historical (delivered) | 14 Oct 2026: header and links |
| [PHASE_3_SPEC.md](PHASE_3_SPEC.md) | Blob roster and editor. | historical (banner added; inventory names removed UI files) | 14 Oct 2026: inventory checked against `apps/desktop/src/ui/` |
| [PHASE_4_SPEC.md](PHASE_4_SPEC.md) | Per-blob project and session tree. | superseded by `TeamSidebar` (`apps/desktop/src/ui/TeamSidebar.tsx`); banner added, dead links converted | 14 Oct 2026: inventory checked against `apps/desktop/src/ui/` |
| [IMPROVEMENT_PHASE_1A_SPEC.md](IMPROVEMENT_PHASE_1A_SPEC.md) | Phase 1A: one turn-end path, honest timeouts, delivery facts. | historical (delivered in beta.19) | 14 Oct 2026: header and links |
| [IMPROVEMENT_PHASE_1B_SPEC.md](IMPROVEMENT_PHASE_1B_SPEC.md) | Phase 1B: typed recovery hints and context-change notices. | historical (delivered in beta.19) | 14 Oct 2026: header and links |
| [IMPROVEMENT_PHASE_2A_SPEC.md](IMPROVEMENT_PHASE_2A_SPEC.md) | Phase 2A: durable prompt queue and send later. | historical (delivered in beta.19) | 14 Oct 2026: header and links |
| [IMPROVEMENT_PHASE_2B_SPEC.md](IMPROVEMENT_PHASE_2B_SPEC.md) | Phase 2B: gated Codex `turn/steer`. | historical (delivered in beta.19) | 14 Oct 2026: header and links |
| [IMPROVEMENT_PHASE_3A_SPEC.md](IMPROVEMENT_PHASE_3A_SPEC.md) | Phase 3A: automatic retry after overload and rate limits. | historical (delivered in beta.19) | 14 Oct 2026: header and links |
| [IMPROVEMENT_PHASE_3B_SPEC.md](IMPROVEMENT_PHASE_3B_SPEC.md) | Phase 3B: recorded-wire replay tests. | historical (delivered in beta.19) | 14 Oct 2026: header and links |
| [IMPROVEMENT_PHASE_4A_SPEC.md](IMPROVEMENT_PHASE_4A_SPEC.md) | Phase 4A: scheduled automations. | historical (delivered in beta.19) | 14 Oct 2026: header and links |
| [IMPROVEMENT_PHASE_4B_SPEC.md](IMPROVEMENT_PHASE_4B_SPEC.md) | Phase 4B: keep-awake while Bloblex has work. | historical (delivered in beta.19) | 14 Oct 2026: header and links |
| [IMPROVEMENT_PHASE_5A_SPEC.md](IMPROVEMENT_PHASE_5A_SPEC.md) | Phase 5A: memory and "about you". | historical (delivered in beta.19) | 14 Oct 2026: header and links |
| [IMPROVEMENT_PHASE_6A_SPEC.md](IMPROVEMENT_PHASE_6A_SPEC.md) | Phase 6A: ask-the-user tool, hand-off draft, notification level. | historical (delivered in beta.19) | 14 Oct 2026: header and links |
| [IMPROVEMENT_PHASE_7_SPEC.md](IMPROVEMENT_PHASE_7_SPEC.md) | Phase 7: opt-in cloud dictation through the Codex login. | historical; banner notes the missing evidence file it names and the 14 Oct amendment | 14 Oct 2026: claims checked against `crates/bloblex-speech/src/cloud.rs` |
| [IMPROVEMENT_PLAN_v1_qa-draft.md](IMPROVEMENT_PLAN_v1_qa-draft.md) | QA draft of the roadmap (12 Oct). | superseded by [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) | 14 Oct 2026: header and banner |
| [FIX1_DICTATION_SPEC.md](FIX1_DICTATION_SPEC.md) | Fix 1A: why ChatGPT dictation said "verification required". | historical; its bot-protection rule is amended by AGENTS.md (14 Oct) | 14 Oct 2026: header and banner |
| [FIX1_DICTATION_CONTINUE.md](FIX1_DICTATION_CONTINUE.md) | Continuation note for Fix 1A. | historical | 14 Oct 2026: header |
| [FIX1_OPENCODE_EFFORT_SPEC.md](FIX1_OPENCODE_EFFORT_SPEC.md) | Fix 1B: OpenCode effort levels. | historical (effort gate shipped in beta.20; see [SESSION_HANDOFF.md](../SESSION_HANDOFF.md)) | 14 Oct 2026: header |
| [FIX1_TEAM_SPEC.md](FIX1_TEAM_SPEC.md) | Fix 1C: leader-only blob creation over the MCP bridge. | historical | 14 Oct 2026: header |
| [FIX1_TEAM_CONTINUE.md](FIX1_TEAM_CONTINUE.md) | Continuation note for Fix 1C. | historical | 14 Oct 2026: header |
| [FIX2_DICTATION_TLS_SPEC.md](FIX2_DICTATION_TLS_SPEC.md) | Fix 2: cloud dictation's TLS stack (rustls). | historical; implemented and released in `v0.1.0-beta.22` | 14 Oct 2026: header; code claims checked (`cloud.rs`, `Cargo.toml`) |
| [BITBOTS_THEME_SPEC.md](BITBOTS_THEME_SPEC.md) | CSS-only pixel theme ("Bitbots") spec. | historical (feature shipped as an experimental setting; see [SESSION_HANDOFF.md](../SESSION_HANDOFF.md)) | 14 Oct 2026: header |
| [FIX2_CODEX_TEAM_INSTRUCTIONS_SPEC.md](FIX2_CODEX_TEAM_INSTRUCTIONS_SPEC.md) | Codex threads keep stale team instructions; send changed text per turn, with echo evidence. | historical; implemented and released in `v0.1.0-beta.24` | 14 Oct 2026: added with the fix |
| [FIX3_OPENCODE2_ACP_LAUNCH_SPEC.md](FIX3_OPENCODE2_ACP_LAUNCH_SPEC.md) | OpenCode 2 rejects `acp --cwd`; launch and catalog without it. | historical; implemented and released in `v0.1.0-beta.24` | 14 Oct 2026: added with the fix |
| [FIX4_CLIPPY_CLEANUP_SPEC.md](FIX4_CLIPPY_CLEANUP_SPEC.md) | Clippy cleanup to zero findings, no behavior change. | historical; implemented in two parts (`e47412a` and the part 2 commit); `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings` passes | 14 Oct 2026: updated |
| [FIX7_OPENCODE_USAGE_AND_SIGNIN_SPEC.md](FIX7_OPENCODE_USAGE_AND_SIGNIN_SPEC.md) | OpenCode 1 and 2 usage and sign-in without depending on the CLI; the OAuth login finding is in the commit. | historical; implemented and released in `v0.1.0-beta.27` | 14 Oct 2026: added with the fix |
| [FIX8_DELEGATION_TIMELINE_ORDER_SPEC.md](FIX8_DELEGATION_TIMELINE_ORDER_SPEC.md) | Delegation notices and the turn text that follows them; the shipped fix places the notice above the turn text (the spec covered text after the call only). | historical; implemented and released in `v0.1.0-beta.27` | 14 Oct 2026: added with the fix |
| [FIX6_OPENCODE_INSTRUCTIONS_RESPAWN_SPEC.md](FIX6_OPENCODE_INSTRUCTIONS_RESPAWN_SPEC.md) | OpenCode turns failed when the blob's instructions changed; restart the process and reload the session. | historical; implemented and released in `v0.1.0-beta.26` | 14 Oct 2026: added with the fix |
| [FIX5_OPENCODE2_PER_MODEL_EFFORT_SPEC.md](FIX5_OPENCODE2_PER_MODEL_EFFORT_SPEC.md) | OpenCode 2 per-model effort levels and a validated catalog. | historical; implemented and released in `v0.1.0-beta.25` | 14 Oct 2026: added with the fix |

## Runbooks

| Document | Purpose | Status | Last verified |
| --- | --- | --- | --- |
| [windows-development.md](windows-development.md) | Local Windows development, unsigned local bundle, isolated-database rules, the running-executable lock history. | current | 14 Oct 2026: read in full; `dev-windows.ps1` and `bundle-windows.ps1` checked |
| [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) | Release procedure, per-release status, signing and clean-VM gaps, CSP and capabilities review. | current (version and endpoint claims corrected) | 14 Oct 2026: read in full; `release-windows.ps1` and config checked |
| [UPDATER.md](UPDATER.md) | Updater channels, manifest format, app behaviour and the release contract. | current | 14 Oct 2026: read in full; endpoints and timers checked (`updates.rs`) |
| Dictation runbook | Not present. See the audit, section "Missing documentation". | missing | not applicable |
| [scripts/live-checks/README.md](../scripts/live-checks/README.md) | Director-run live CLI probes; these spend real provider usage. | current | 14 Oct 2026: claims checked (script names exist); one machine-specific default path noted in audit |
| [scripts/native-smoke/README.md](../scripts/native-smoke/README.md) | Helpers for the native smoke test on an isolated database. | current | 14 Oct 2026: helper file names checked |

## Evidence (dated)

Immutable records. Only broken links were repaired. Their wording and conclusions are not changed.

| Document | Purpose | Status | Last verified |
| --- | --- | --- | --- |
| [NATIVE_SMOKE_RESULTS.md](NATIVE_SMOKE_RESULTS.md) | Phase 2a and 3 native smoke on an isolated database (2 Oct 2026). | historical (the only recorded native acceptance pass) | 14 Oct 2026: header and links |
| [evidence/bitbots-theme-2026-10-13.md](evidence/bitbots-theme-2026-10-13.md) | Bitbots theme evidence (13 Oct). | historical | 14 Oct 2026: links only |
| [evidence/cloud-dictation-client-shape-2026-10-14.md](evidence/cloud-dictation-client-shape-2026-10-14.md) | Cloud dictation client-shape findings and falsified claims (14 Oct). | historical; the AGENTS.md 14 Oct amendment cites it | 14 Oct 2026: links only |
| [evidence/cloud-dictation-diagnosis-2026-10-13.md](evidence/cloud-dictation-diagnosis-2026-10-13.md) | Cloudflare challenge diagnosis for cloud dictation (13 Oct). | historical | 14 Oct 2026: links only |
| [evidence/cloud-dictation-tls-backend-2026-10-14.md](evidence/cloud-dictation-tls-backend-2026-10-14.md) | TLS backend evidence: SChannel challenged, rustls accepted (14 Oct). | historical; cited by AGENTS.md | 14 Oct 2026: links only |
| [evidence/codex-turn-steer-2026-10-12.md](evidence/codex-turn-steer-2026-10-12.md) | Codex `turn/steer` evidence (12 Oct). | historical | 14 Oct 2026: links only |
| [evidence/composer-controls-2026-10-07.md](evidence/composer-controls-2026-10-07.md) | Composer controls evidence (7 Oct). | historical | 14 Oct 2026: links only |
| [evidence/dictation-2026-10-08.md](evidence/dictation-2026-10-08.md) | On-device dictation evidence (8 Oct). | historical | 14 Oct 2026: links only |
| [evidence/dictation-bubble-2026-10-08.md](evidence/dictation-bubble-2026-10-08.md) | Dictation bubble evidence (8 Oct). | historical | 14 Oct 2026: links only |
| [evidence/opencode-effort-2026-10-13.md](evidence/opencode-effort-2026-10-13.md) | OpenCode effort re-check on 1.18.35 (13 Oct). | historical | 14 Oct 2026: links only |
| [evidence/recovery-hints-2026-10-12.md](evidence/recovery-hints-2026-10-12.md) | Recovery hints evidence (12 Oct). | historical | 14 Oct 2026: links only |
| [evidence/task2-grok-runtime-capabilities.md](evidence/task2-grok-runtime-capabilities.md) | Independent runtime capability probe from the second implementer lane (undated file; its findings feed [runtime-capabilities.md](runtime-capabilities.md)). | historical | 14 Oct 2026: links only |
| [evidence/task2-luna-runtime-capabilities-original.md](evidence/task2-luna-runtime-capabilities-original.md) | Original capability spike from the first implementer lane (undated file). Names a schema path that is not in the tree (audit). | historical | 14 Oct 2026: links only |
| [evidence/wire-fixtures.md](evidence/wire-fixtures.md) | Wire fixtures used by the replay tests; synthesized from fakes, not real captures. | historical | 14 Oct 2026: links only |

## Release notes

Immutable records. The newest is [0.1.0-beta.28](releases/0.1.0-beta.28.md). Earlier notes are historical.

| Document | Status | Last verified |
| --- | --- | --- |
| [releases/0.1.0-beta.1.md](releases/0.1.0-beta.1.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.2.md](releases/0.1.0-beta.2.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.3.md](releases/0.1.0-beta.3.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.4.md](releases/0.1.0-beta.4.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.5.md](releases/0.1.0-beta.5.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.6.md](releases/0.1.0-beta.6.md) | historical (last release with the signed updater feed) | 14 Oct 2026: links only |
| [releases/0.1.0-beta.7.md](releases/0.1.0-beta.7.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.8.md](releases/0.1.0-beta.8.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.9.md](releases/0.1.0-beta.9.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.10.md](releases/0.1.0-beta.10.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.11.md](releases/0.1.0-beta.11.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.12.md](releases/0.1.0-beta.12.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.13.md](releases/0.1.0-beta.13.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.14.md](releases/0.1.0-beta.14.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.15.md](releases/0.1.0-beta.15.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.16.md](releases/0.1.0-beta.16.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.17.md](releases/0.1.0-beta.17.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.18.md](releases/0.1.0-beta.18.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.19.md](releases/0.1.0-beta.19.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.20.md](releases/0.1.0-beta.20.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.21.md](releases/0.1.0-beta.21.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.22.md](releases/0.1.0-beta.22.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.23.md](releases/0.1.0-beta.23.md) | historical | 14 Oct 2026: links only |
| [releases/0.1.0-beta.24.md](releases/0.1.0-beta.24.md) | historical | 14 Oct 2026: written with the release |
| [releases/0.1.0-beta.25.md](releases/0.1.0-beta.25.md) | historical | 14 Oct 2026: written with the release |
| [releases/0.1.0-beta.26.md](releases/0.1.0-beta.26.md) | historical | 14 Oct 2026: written with the release |
| [releases/0.1.0-beta.27.md](releases/0.1.0-beta.27.md) | historical | 14 Oct 2026: written with the release |
| [releases/0.1.0-beta.28.md](releases/0.1.0-beta.28.md) | historical (newest manual-only release) | 14 Oct 2026: written with the release |

## Handoff and history

| Document | Purpose | Status | Last verified |
| --- | --- | --- | --- |
| [SESSION_HANDOFF.md](../SESSION_HANDOFF.md) | Dated handoff log, newest first, with a "Lanes" section that predates the current rules. | historical (banner added) | 14 Oct 2026: read in full; budget and lane claims checked |
| [implementation-status.md](implementation-status.md) | Current scope, phase table, release-by-release scope and open gaps. | current for "Still open" and "Current source scope"; the phase table is historical | 14 Oct 2026: read in full; date corrected |
| [DIRECTOR_LOG.md](DIRECTOR_LOG.md) | Dated decisions and review notes from the Director, from 2 Oct 2026. | historical | 14 Oct 2026: header and links |
| [v1-coverage.md](v1-coverage.md) | Requirement audit of the v1 plan as of 1 Oct 2026. | historical (banner added; budget rows retired) | 14 Oct 2026: read in full |
| [DOCS_AUDIT.md](DOCS_AUDIT.md) | Per-file audit of this documentation set, with contradictions, unverified claims and missing docs. | current (new in this pass) | 14 Oct 2026 |
