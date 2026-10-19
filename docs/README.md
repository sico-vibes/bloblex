# Bitbots documentation hub

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
- **Release state today:** last tagged `v0.1.0-beta.33`. `v0.1.0-beta.34` ([releases/0.1.0-beta.34.md](releases/0.1.0-beta.34.md)) is in preparation with the FIX39 wave and is not yet tagged. Beta.32 and later update themselves ([UPDATER.md](UPDATER.md)).

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

### Remote mode (design, with a browser mock; not implemented in the daemon)

| Document | Purpose | Status | Last verified |
| --- | --- | --- | --- |
| [remote/REMOTE_MODE.md](remote/REMOTE_MODE.md) | Product spec: goals, non-goals, rules, screens. | design | 15 Oct 2026 |
| [remote/ARCHITECTURE.md](remote/ARCHITECTURE.md) | Gateway, relay, client, pairing, resume, multi-computer. | design | 15 Oct 2026 |
| [remote/THREAT_MODEL.md](remote/THREAT_MODEL.md) | Assets, actors, abuse cases, mitigations, review checklist. | design | 15 Oct 2026 |
| [remote/PROTOCOL.md](remote/PROTOCOL.md) | Wire contract and the generated method-tier table. | design | 15 Oct 2026 |
| [remote/UX_FLOWS.md](remote/UX_FLOWS.md) | Every host and device state, with preview flags. | design, mock built | 15 Oct 2026 |
| [remote/PHASES.md](remote/PHASES.md) | P0 to P3 with exit criteria. | plan | 15 Oct 2026 |
| [remote/AGENTS_AMENDMENT_DRAFT.md](remote/AGENTS_AMENDMENT_DRAFT.md) | Proposed AGENTS.md exception, awaiting owner approval. | draft, not in force | 15 Oct 2026 |
| [UI_POLISH_WAVE.md](UI_POLISH_WAVE.md) | What the 15 October polish wave changed and what is unverified. | current | 15 Oct 2026 |

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
| [IMPROVEMENT_PHASE_4B_SPEC.md](IMPROVEMENT_PHASE_4B_SPEC.md) | Phase 4B: keep-awake while Bitbots has work. | historical (delivered in beta.19) | 14 Oct 2026: header and links |
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
| [FIX38_H1_REMOTE_PAIRING_SPEC.md](FIX38_H1_REMOTE_PAIRING_SPEC.md) | Remote pairing completes in a real browser on both methods; Tailscale turn-off removes the handler. | implemented and released in `v0.1.0-beta.33`; report beside it | 18 Oct 2026: added with the wave |
| [FIX38_H2_EMPTY_CONVERSATION_SPEC.md](FIX38_H2_EMPTY_CONVERSATION_SPEC.md) | A bot without a conversation opens a draft; nothing saved before the first message. | implemented and released in `v0.1.0-beta.33`; report beside it | 18 Oct 2026: added with the wave |
| [FIX38_H3_TREE_LINES_SPEC.md](FIX38_H3_TREE_LINES_SPEC.md) | Continuous branch lines in the classic look. | implemented and released in `v0.1.0-beta.33`; report beside it | 18 Oct 2026: added with the wave |
| [FIX37_G1_REMOTE_AND_RESUME_SPEC.md](FIX37_G1_REMOTE_AND_RESUME_SPEC.md) | Phone page served as HTML; a failed provider resume falls back to a fresh session. | implemented and released in `v0.1.0-beta.32`; report beside it | 18 Oct 2026: added with the wave |
| [FIX37_G2_UI_POLISH_SPEC.md](FIX37_G2_UI_POLISH_SPEC.md) | Sidebar logo alignment, tooltips in a clamped top layer, side-badge shadow. | implemented and released in `v0.1.0-beta.32`; report beside it | 18 Oct 2026: added with the wave |
| [FIX37_G3_SELECTION_SPEC.md](FIX37_G3_SELECTION_SPEC.md) | No selection bouncing after a delete or archive. | implemented and released in `v0.1.0-beta.32`; report beside it | 18 Oct 2026: added with the wave |
| [FIX37_G4_SLASH_COMMANDS_SPEC.md](FIX37_G4_SLASH_COMMANDS_SPEC.md) | Slash commands: actions, skills, Manager commands. | implemented and released in `v0.1.0-beta.32`; report beside it | 18 Oct 2026: added with the wave |
| [FIX37_G5_AUTO_UPDATE_SPEC.md](FIX37_G5_AUTO_UPDATE_SPEC.md) | Background update download with a restart badge. | implemented and released in `v0.1.0-beta.32`; report beside it | 18 Oct 2026: added with the wave |
| [FIX37_G6_PREVIEW_PARITY_SPEC.md](FIX37_G6_PREVIEW_PARITY_SPEC.md) | Preview fixture parity with the native bridge. | implemented and released in `v0.1.0-beta.32`; report beside it | 18 Oct 2026: added with the wave |
| [FIX36_D3_KNOWLEDGE_SPEC.md](FIX36_D3_KNOWLEDGE_SPEC.md) | The Manager: what it knows about the user, its playbook, the handover after a model change; project folder paths must be full. | implemented and released in `v0.1.0-beta.31`; report beside it; live checks owed | 17 Oct 2026: added with the wave |
| [FIX36_D2_PROPOSALS_SPEC.md](FIX36_D2_PROPOSALS_SPEC.md) | The Manager proposes projects, bots and tasks for approval; `ask_user` for every provider. | implemented and released in `v0.1.0-beta.31`; report beside it; live checks owed | 17 Oct 2026: added with the wave |
| [FIX36_D1_MANAGER_SPEC.md](FIX36_D1_MANAGER_SPEC.md) | The Manager: a permanent global bot that replaces the team leader. Follow-up in `FIX36_D1_FOLLOWUP.md`. | implemented and released in `v0.1.0-beta.31`; report beside it; live checks owed | 17 Oct 2026: added with the wave |
| [FIX35_C2_CONNECTIVITY_SPEC.md](FIX35_C2_CONNECTIVITY_SPEC.md) | Native Remote connectivity: UPnP, the firewall rule, carrier NAT, `/api/ping`. Follow-ups `FIX35_C2_FINISH.md`, `FIX35_C3`-`C6`. | implemented and released in `v0.1.0-beta.31`; report beside it; live checks owed | 17 Oct 2026: added with the wave |
| [FIX35_C1_NATIVE_REMOTE_SPEC.md](FIX35_C1_NATIVE_REMOTE_SPEC.md) | Native Remote: HTTPS on the host's own address, password sign-in plus approval, abuse limits. | implemented and released in `v0.1.0-beta.31`; report beside it; live checks owed | 17 Oct 2026: added with the wave |
| [FIX34_A5_SIGN_IN_SPEC.md](FIX34_A5_SIGN_IN_SPEC.md) | An expired coding-agent sign-in is flagged, with a terminal sign-in and install. Follow-up in `FIX34_A5_FOLLOWUP.md`. | implemented and released in `v0.1.0-beta.31`; report beside it; live checks owed | 17 Oct 2026: added with the wave |
| [FIX34_A2_FRESH_SESSION_SPEC.md](FIX34_A2_FRESH_SESSION_SPEC.md) | No "fresh session" notice for a context that never had a turn. | implemented and released in `v0.1.0-beta.31`; report beside it; live checks owed | 17 Oct 2026: added with the wave |
| [FIX34_A1_REMOTE_WEB_SPEC.md](FIX34_A1_REMOTE_WEB_SPEC.md) | The remote web app's `remote.html` is served at `/`. | implemented and released in `v0.1.0-beta.31`; report beside it; live checks owed | 17 Oct 2026: added with the wave |
| [FIX33_SMALL_BACKEND_SPEC.md](FIX33_SMALL_BACKEND_SPEC.md) | Small backend items: capabilities mismatch, "bot" in both looks, `session.environment`, cloud dictation warm-up. | implemented and released in `v0.1.0-beta.30`; report beside it | 17 Oct 2026: added with the wave |
| [FIX28_CATALOG_SPEC.md](FIX28_CATALOG_SPEC.md) | Model catalog cache that never blocks a send, persisted and prewarmed at boot. | implemented and released in `v0.1.0-beta.30`; report beside it | 17 Oct 2026: added with the wave |
| [FIX28_SEND_SPEC.md](FIX28_SEND_SPEC.md) | A send is accepted at once and the coding agent starts behind it; `session.warm`. | implemented and released in `v0.1.0-beta.30`; report beside it | 17 Oct 2026: added with the wave |
| [FIX27_CONVERSATIONS_SPEC.md](FIX27_CONVERSATIONS_SPEC.md) | Many conversations per bot, auto-titles, a stable bot-to-bot tree, readable workspaces. | implemented and released in `v0.1.0-beta.30`; report beside it | 17 Oct 2026: added with the wave |
| [FIX32_SKILLS_SPEC.md](FIX32_SKILLS_SPEC.md) | One skills pool shared by every bot over MCP, with a routing block. | implemented and released in `v0.1.0-beta.30`; report beside it | 17 Oct 2026: added with the wave |
| [FIX31_BACKUP_SPEC.md](FIX31_BACKUP_SPEC.md) | Back up and restore bots, memory, skills, automations and settings. | implemented and released in `v0.1.0-beta.30`; report beside it | 17 Oct 2026: added with the wave |
| [FIX29_WP6A_POLICY_SPEC.md](FIX29_WP6A_POLICY_SPEC.md) | Remote: one policy file for Rust and TypeScript, with shared goldens. | implemented and released in `v0.1.0-beta.30`; report beside it | 17 Oct 2026: added with the wave |
| [FIX29_WP6B_GATEWAY_SPEC.md](FIX29_WP6B_GATEWAY_SPEC.md) | Remote: the gateway in `bitbotsd` over `tailscale serve`, pairing and device cookies. | implemented and released in `v0.1.0-beta.30`; report beside it; live Tailscale unverified | 17 Oct 2026: added with the wave |
| [FIX29_WP6C_PWA_SPEC.md](FIX29_WP6C_PWA_SPEC.md) | Remote: the PWA build, gateway transport and service worker. | implemented and released in `v0.1.0-beta.30`; report beside it | 17 Oct 2026: added with the wave |
| [FIX29_WP6C1_BUILD_SPEC.md](FIX29_WP6C1_BUILD_SPEC.md) | Remote: the desktop crate builds before the remote app exists. | implemented and released in `v0.1.0-beta.30`; report beside it | 17 Oct 2026: added with the wave |
| [FIX29_WP6D_CONTRACT_SPEC.md](FIX29_WP6D_CONTRACT_SPEC.md) | Remote: the renderer contract, hook and simulator follow the Tailscale design. | implemented and released in `v0.1.0-beta.30`; report beside it | 17 Oct 2026: added with the wave |

### FIX39 and FIX40 wave (18 October 2026)

Owner feedback, decisions, research, briefs, reports and audits for the beta.33 review. Each package's report and audit sit side by side. The release is [0.1.0-beta.34](releases/0.1.0-beta.34.md) (in preparation). Commits and verdicts are in [SESSION_HANDOFF.md](../SESSION_HANDOFF.md).

| Document | Purpose | Status | Last verified |
| --- | --- | --- | --- |
| [FIX39_FEEDBACK.md](FIX39_FEEDBACK.md) | The owner's and a friend's review of beta.33: 24 numbered items. | current input | 18 Oct 2026: added with the wave |
| [FIX39_DECISIONS.md](FIX39_DECISIONS.md) | The owner's answers, the decisions the audit made, and packages P1 to P13 with their file scopes. Overrides the research where they differ. | current | 18 Oct 2026: added with the wave |
| [FIX39_DIRECTOR_CHECKS.md](FIX39_DIRECTOR_CHECKS.md) | The Director's browser-preview checks after Wave A; the update-badge failure was handed to P5. | current | 18 Oct 2026: added with the wave |
| [FIX39_DOCS_BRIEF.md](FIX39_DOCS_BRIEF.md) | Brief for this wave's documentation lane (Claude Haiku 5.5). | historical brief | 18 Oct 2026: added with the wave |
| [FIX39_RESEARCH_BRIEF.md](FIX39_RESEARCH_BRIEF.md) | Brief for the research lane (DeepSeek): investigate every item, change no code. | historical brief | 18 Oct 2026: added with the wave |
| [FIX39_RESEARCH_R1.md](FIX39_RESEARCH_R1.md) | Research for items 1 to 15 (UI and UX), with file:line evidence and proposed designs. | historical; superseded by decisions where they differ | 18 Oct 2026: added with the wave |
| [FIX39_RESEARCH_R2.md](FIX39_RESEARCH_R2.md) | Research for items 16 to 20 (conversations, activity, permissions, context loss). | historical; superseded by decisions where they differ | 18 Oct 2026: added with the wave |
| [FIX39_RESEARCH_R3.md](FIX39_RESEARCH_R3.md) | Research for items 21 to 24 (Manager projects, Bitbots tool set, Tailscale, browser layout). | historical; superseded by decisions where they differ | 18 Oct 2026: added with the wave |
| [FIX39_RESEARCH_AUDIT.md](FIX39_RESEARCH_AUDIT.md) | Claude Sonnet 5.5's audit of the three research reports: a verdict per item, the package plan and the owner's questions. | historical; the owner's answers are in FIX39_DECISIONS.md | 18 Oct 2026: added with the wave |
| [FIX39_AUDIT_RESEARCH_BRIEF.md](FIX39_AUDIT_RESEARCH_BRIEF.md) | Brief for the research audit (Claude Sonnet 5.5). | historical brief | 18 Oct 2026: added with the wave |
| [FIX39_IMPLEMENT_BRIEF.md](FIX39_IMPLEMENT_BRIEF.md) | Brief for the implementation lanes (GPT Sol 6.1): rules and gates. | historical brief | 18 Oct 2026: added with the wave |
| [FIX39_AUDIT_IMPL_BRIEF.md](FIX39_AUDIT_IMPL_BRIEF.md) | Brief for the audit of each implementation diff (Claude Sonnet 5.5). | historical brief | 18 Oct 2026: added with the wave |
| [FIX40_T3_RESEARCH_BRIEF.md](FIX40_T3_RESEARCH_BRIEF.md) | Brief for studying T3 Code's agent runtime and the owner's vision. | historical brief | 18 Oct 2026: added with the wave |
| [FIX40_T3_RESEARCH.md](FIX40_T3_RESEARCH.md) | T3 Code research with file:line evidence and a recommendations table. P0 items were folded into FIX39 (P6, P8); the rest into P7, P9, P10 and P11. | current research | 18 Oct 2026: added with the wave |
| [FIX39_P1_REPORT.md](FIX39_P1_REPORT.md) · [FIX39_P1_AUDIT.md](FIX39_P1_AUDIT.md) | P1: usage dialog, effort picker, one search, update banner, checklist, Manager card, star badge, dividers, empty usage, sidebar previews. | implemented in `14777cb`; audit PASS WITH FIXES, fixed; in beta.34 | 18 Oct 2026: added with the wave |
| [FIX39_P2_REPORT.md](FIX39_P2_REPORT.md) · [FIX39_P2_AUDIT.md](FIX39_P2_AUDIT.md) | P2: readable agent activity (items 17 and the shape validation of item 4). | implemented in `14777cb`; audit PASS WITH FIXES, fixed; in beta.34 | 18 Oct 2026: added with the wave |
| [FIX39_P3_REPORT.md](FIX39_P3_REPORT.md) · [FIX39_P3_AUDIT.md](FIX39_P3_AUDIT.md) | P3: Remote errors and port conflicts, the wide browser layout, companion drag, parent watchdog and single instance. | implemented in `14777cb`; audit PASS WITH FIXES, fixed except F3 (recorded) and F4 (owed); in beta.34 | 18 Oct 2026: added with the wave |
| [FIX39_P4_REPORT.md](FIX39_P4_REPORT.md) · [FIX39_P4_AUDIT.md](FIX39_P4_AUDIT.md) | P4: eight symmetrical bot shapes, shape-preserving Shuffle and Surprise me, name migration. | implemented in `14777cb`; audit PASS WITH FIXES, fixed; in beta.34 | 18 Oct 2026: added with the wave |
| [FIX39_P5_REPORT.md](FIX39_P5_REPORT.md) · [FIX39_P5_AUDIT.md](FIX39_P5_AUDIT.md) | P5: Experimental page, model under the name, lock a bot, the composer writes the bot, permissions in a conversation. | implemented in `53773fd`; audit PASS WITH FIXES, fixed; in beta.34 | 18 Oct 2026: added with the wave |
| [FIX39_P6_REPORT.md](FIX39_P6_REPORT.md) · [FIX39_P6_AUDIT.md](FIX39_P6_AUDIT.md) | P6: parallel conversations with one bot and the global limit, context recap, tags, task folders, denial text. | implemented in `122ab81`; audit PASS WITH FIXES, fixed; restart gap open | 18 Oct 2026: added with the wave |
| [FIX39_P7_REPORT.md](FIX39_P7_REPORT.md) · [FIX39_P7_AUDIT.md](FIX39_P7_AUDIT.md) | P7: the Manager's Bitbots tool set, task briefs, routing by role, tags and project. | implemented in `fd738b2`; audit FAIL, fixed in a follow-up; no re-audit recorded | 18 Oct 2026: added with the wave |
| [FIX39_P8_REPORT.md](FIX39_P8_REPORT.md) · [FIX39_P8_AUDIT.md](FIX39_P8_AUDIT.md) | P8: watchdog, "Limited until", bounded retry and continuation after a crash or timeout. | implemented in `53d193d`; audit PASS WITH FIXES, fixed; in beta.34 | 18 Oct 2026: added with the wave |
| [FIX39_P9_REPORT.md](FIX39_P9_REPORT.md) · [FIX39_P9_AUDIT.md](FIX39_P9_AUDIT.md) | P9: Working bots panel, Full access as the default for new bots, Steer or Queue setting. | implemented in `dc3a131`; audit PASS WITH FIXES, fixed; in beta.34 | 18 Oct 2026: added with the wave |
| [FIX39_P10_REPORT.md](FIX39_P10_REPORT.md) · [FIX39_P10_AUDIT.md](FIX39_P10_AUDIT.md) | P10: a separate git worktree for a code task when another task works in the same repo, merged back on approval. | implemented in `4ba7367`; audit PASS WITH FIXES, fixed; in beta.34 | 18 Oct 2026: added with the wave |
| [FIX39_P11_REPORT.md](FIX39_P11_REPORT.md) · [FIX39_P11_AUDIT.md](FIX39_P11_AUDIT.md) | P11: real-CLI reliability suite with offline replay of recorded transcripts. | implemented in `e8d3dab`; audit FAIL, addressed in a follow-up; no re-audit recorded; Codex fixture to re-record | 18 Oct 2026: added with the wave |
| [FIX39_P12_REPORT.md](FIX39_P12_REPORT.md) · [FIX39_P12_AUDIT.md](FIX39_P12_AUDIT.md) | P12: rolling redacted logs and Export diagnostics. | implemented in `543f422`; audit PASS WITH FIXES, fixed; in beta.34 | 18 Oct 2026: added with the wave |
| [FIX39_P13_REPORT.md](FIX39_P13_REPORT.md) · [FIX39_P13_AUDIT.md](FIX39_P13_AUDIT.md) | P13: Claude permission change mid-conversation, and the steer gate per provider capability. | implemented in `8409827`; audit PASS (two optional nits); in beta.34 | 18 Oct 2026: added with the wave |

### FIX40 looks and bot art (19 October 2026)

The owner's request to replace the primary look with Frost, add Pop and Dot, and give each bot an art style and each look an orb. The wave is on `main` at `e4cf5b3` and not released. The record is [FIX40_REPORT.md](FIX40_REPORT.md); design rules are in [DESIGN.md](../DESIGN.md#fix40-looks-and-bot-art-19-october-2026).

| Document | Purpose | Status | Last verified |
| --- | --- | --- | --- |
| [FIX40_REPORT.md](FIX40_REPORT.md) | What the owner asked for, what landed, the pipeline, review rounds, environment findings, gates, follow-ups and commits. | current; on `main`, not released | 19 Oct 2026: added with the wave |
| [FIX40_THEMES_SPEC.md](FIX40_THEMES_SPEC.md) | Round 1 brief for the looks, Frost, wallpapers, fonts and the Appearance page (Codex lane). | historical brief; Solid glass values changed in review (see the report) | 19 Oct 2026: added with the wave |
| [FIX40_CHARACTERS_SPEC.md](FIX40_CHARACTERS_SPEC.md) | Round 1 brief for the bot art styles, hand-painted blobs and the bot editor (OpenCode lane). | historical brief | 19 Oct 2026: added with the wave |
| [FIX40_ROUND2_SPEC.md](FIX40_ROUND2_SPEC.md) | Round 2 brief for the Pop and Dot looks across the app, and the launch greeting (Pop was reassigned to Codex). | historical brief | 19 Oct 2026: added with the wave |
| [FIX40_ORBS_SPEC.md](FIX40_ORBS_SPEC.md) | Brief for the look orbs on the Appearance cards and onboarding (Codex lane). | historical brief | 19 Oct 2026: added with the wave |

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

Immutable records. The newest is [0.1.0-beta.34](releases/0.1.0-beta.34.md), in preparation and not yet tagged. Earlier notes are historical.

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
| [releases/0.1.0-beta.28.md](releases/0.1.0-beta.28.md) | historical | 14 Oct 2026: written with the release |
| [releases/0.1.0-beta.29.md](releases/0.1.0-beta.29.md) | historical | 15 Oct 2026: written with the release |
| [releases/0.1.0-beta.30.md](releases/0.1.0-beta.30.md) | historical | 17 Oct 2026: written with the release |
| [releases/0.1.0-beta.34.md](releases/0.1.0-beta.34.md) | in preparation (FIX39 wave; not yet tagged) | 18 Oct 2026: written with the wave |

## Handoff and history

| Document | Purpose | Status | Last verified |
| --- | --- | --- | --- |
| [SESSION_HANDOFF.md](../SESSION_HANDOFF.md) | Dated handoff log, newest first, with a "Lanes" section that predates the current rules. | historical (banner added) | 14 Oct 2026: read in full; budget and lane claims checked |
| [implementation-status.md](implementation-status.md) | Current scope, phase table, release-by-release scope and open gaps. | current for "Still open" and "Current source scope"; the phase table is historical | 14 Oct 2026: read in full; date corrected |
| [DIRECTOR_LOG.md](DIRECTOR_LOG.md) | Dated decisions and review notes from the Director, from 2 Oct 2026. | historical | 14 Oct 2026: header and links |
| [v1-coverage.md](v1-coverage.md) | Requirement audit of the v1 plan as of 1 Oct 2026. | historical (banner added; budget rows retired) | 14 Oct 2026: read in full |
| [DOCS_AUDIT.md](DOCS_AUDIT.md) | Per-file audit of this documentation set, with contradictions, unverified claims and missing docs. | current (new in this pass) | 14 Oct 2026 |
