# Documentation inventory

> **What this is:** the inventory of every tracked Markdown file, taken before any move (phase 1), with the old-to-new path map (phase 2). Lane work record; the library index lists it under library work records.
> **Status:** working record, written by the documentation lane (branch `docs-library`, worktree `D:\fx50`).
> **Last updated:** 2026-10-19

## Conventions used

- **Kind** is one of: reference, guide, design rule, plan, spec, report, evidence, release note, operations, audit, history, log, brief, decision, follow-up note, research, contract.
- **Status** is provisional until phase 3 reads each document: `current`, `historical`, `superseded`, `protected`. Protected files keep their paths (see the brief).
- **Last date** is the last commit that changed the file, from `git log`, before this pass.
- Totals: 256 Markdown files tracked. 35 are release notes (`docs/releases/`, protected), 29 are protected elsewhere (root files, `docs/remote/`, `docs/evidence/`, `docs/ipc-contract.md`), and 192 move or stay as the index (`docs/README.md`). Of the 192, 157 are FIX wave records and 34 are named documents, and 191 move. `docs/README.md` stays. The two `scripts/*/README.md` files move into `docs/guides/`.

## Protected, not moved

| Current path | Kind | Subsystem | Status | Last date |
| --- | --- | --- | --- | --- |
| `AGENTS.md` | owner directive | project-wide | current or dated (see phase 3) | 2026-10-19 |
| `DESIGN.md` | design rule | project-wide | current or dated (see phase 3) | 2026-10-19 |
| `PRODUCT.md` | design rule | project-wide | current or dated (see phase 3) | 2026-10-15 |
| `README.md` | guide (root) | project-wide | current or dated (see phase 3) | 2026-10-18 |
| `SESSION_HANDOFF.md` | history (handoff) | project-wide | current or dated (see phase 3) | 2026-10-19 |
| `THIRD_PARTY_NOTICES.md` | legal notice | project-wide | current or dated (see phase 3) | 2026-10-19 |
| `docs/ipc-contract.md` | reference (IPC contract) | project-wide | current or dated (see phase 3) | 2026-10-18 |
| `docs/releases/*.md` (35 files) | release note | release history | historical, imported by the app (`WhatsNew.tsx`) | 2026-10-02 to 2026-10-19 |
| `docs/remote/*.md` (9 files) | reference and specs (Remote) | Remote mode | current or superseded, see phase 3 | 2026-10-16 to 2026-10-18 |
| `docs/evidence/*.md` (13 files) | evidence | dictation, runtime capabilities, OpenCode, Codex | dated records | 2026-10-08 to 2026-10-15 |

Also protected: `docs/qa-schema/`, `docs/fixtures/` (data, byte-identical).

## Moved or kept (full map)

| Current path | Proposed path | Kind | Subsystem | Status (provisional) | Last date |
| --- | --- | --- | --- | --- | --- |
| `docs/FIX10_REPORT.md` | `docs/history/fix-10/report.md` | report | Themes and style logic | historical | 2026-10-15 |
| `docs/FIX10_THEME_STYLE_SPEC.md` | `docs/history/fix-10/theme-style-spec.md` | spec | Themes and style logic | superseded in part by | 2026-10-15 |
| `docs/FIX11_IDENTITY_SPEC.md` | `docs/history/fix-11/identity-spec.md` | spec | Installed identity | historical | 2026-10-15 |
| `docs/FIX11_REPORT.md` | `docs/history/fix-11/report.md` | report | Installed identity | historical | 2026-10-15 |
| `docs/FIX12_REPORT.md` | `docs/history/fix-12/report.md` | report | Vocabulary (bots and blobs) | historical | 2026-10-15 |
| `docs/FIX12_VOCABULARY_SPEC.md` | `docs/history/fix-12/vocabulary-spec.md` | spec | Vocabulary (bots and blobs) | historical | 2026-10-15 |
| `docs/FIX13_PREFS_AND_POLISH_SPEC.md` | `docs/history/fix-13/prefs-and-polish-spec.md` | spec | UI preferences and polish | historical | 2026-10-15 |
| `docs/FIX13_REPORT.md` | `docs/history/fix-13/report.md` | report | UI preferences and polish | historical | 2026-10-15 |
| `docs/FIX14_REPORT.md` | `docs/history/fix-14/report.md` | report | Errors and connection resilience | historical | 2026-10-15 |
| `docs/FIX14_RESILIENCE_SPEC.md` | `docs/history/fix-14/resilience-spec.md` | spec | Errors and connection resilience | historical | 2026-10-15 |
| `docs/FIX15_CONVERSATION_SPEC.md` | `docs/history/fix-15/conversation-spec.md` | spec | Conversation interactions | historical | 2026-10-15 |
| `docs/FIX15_REPORT.md` | `docs/history/fix-15/report.md` | report | Conversation interactions | historical | 2026-10-15 |
| `docs/FIX16_REPORT.md` | `docs/history/fix-16/report.md` | report | Transport seam | historical | 2026-10-15 |
| `docs/FIX16_TRANSPORT_SEAM_SPEC.md` | `docs/history/fix-16/transport-seam-spec.md` | spec | Transport seam | historical | 2026-10-15 |
| `docs/FIX17_REMOTE_SIMULATOR_SPEC.md` | `docs/history/fix-17/remote-simulator-spec.md` | spec | Remote simulator | historical | 2026-10-15 |
| `docs/FIX17_REPORT.md` | `docs/history/fix-17/report.md` | report | Remote simulator | historical | 2026-10-15 |
| `docs/FIX18_REMOTE_TIERS_SPEC.md` | `docs/history/fix-18/remote-tiers-spec.md` | spec | Remote method tiers | historical | 2026-10-15 |
| `docs/FIX18_REPORT.md` | `docs/history/fix-18/report.md` | report | Remote method tiers | historical | 2026-10-15 |
| `docs/FIX19_REMOTE_PROTOCOL_DOC_SPEC.md` | `docs/history/fix-19/remote-protocol-doc-spec.md` | spec | Remote protocol document | historical | 2026-10-15 |
| `docs/FIX19_REPORT.md` | `docs/history/fix-19/report.md` | report | Remote protocol document | historical | 2026-10-15 |
| `docs/FIX1_DICTATION_CONTINUE.md` | `docs/history/fix-01/dictation-continue.md` | follow-up note | Dictation, OpenCode effort, team leader | historical | 2026-10-13 |
| `docs/FIX1_DICTATION_SPEC.md` | `docs/history/fix-01/dictation-spec.md` | spec | Dictation, OpenCode effort, team leader | historical | 2026-10-15 |
| `docs/FIX1_OPENCODE_EFFORT_SPEC.md` | `docs/history/fix-01/opencode-effort-spec.md` | spec | Dictation, OpenCode effort, team leader | historical | 2026-10-15 |
| `docs/FIX1_TEAM_CONTINUE.md` | `docs/history/fix-01/team-continue.md` | follow-up note | Dictation, OpenCode effort, team leader | superseded in part by | 2026-10-13 |
| `docs/FIX1_TEAM_SPEC.md` | `docs/history/fix-01/team-spec.md` | spec | Dictation, OpenCode effort, team leader | superseded in part by | 2026-10-15 |
| `docs/FIX20_COMPANION_ACCESS_SPEC.md` | `docs/history/fix-20/companion-access-spec.md` | spec | Companion access | historical | 2026-10-15 |
| `docs/FIX20_REPORT.md` | `docs/history/fix-20/report.md` | report | Companion access | historical | 2026-10-15 |
| `docs/FIX21_COMPANION_B_SPEC.md` | `docs/history/fix-21/companion-b-spec.md` | spec | Companion, second batch | historical | 2026-10-15 |
| `docs/FIX21_REPORT.md` | `docs/history/fix-21/report.md` | report | Companion, second batch | historical | 2026-10-15 |
| `docs/FIX22_BOT_PAGE_B_SPEC.md` | `docs/history/fix-22/bot-page-b-spec.md` | spec | Bot page, second batch | historical | 2026-10-15 |
| `docs/FIX22_REPORT.md` | `docs/history/fix-22/report.md` | report | Bot page, second batch | historical | 2026-10-15 |
| `docs/FIX23_REMOTE_ENTRY_SPEC.md` | `docs/history/fix-23/remote-entry-spec.md` | spec | Remote entry points | historical | 2026-10-15 |
| `docs/FIX23_REPORT.md` | `docs/history/fix-23/report.md` | report | Remote entry points | historical | 2026-10-15 |
| `docs/FIX24_REMOTE_REVIEW_SPEC.md` | `docs/history/fix-24/remote-review-spec.md` | spec | Remote independent review | historical | 2026-10-15 |
| `docs/FIX25_REMOTE_POLICY_HARDENING_SPEC.md` | `docs/history/fix-25/remote-policy-hardening-spec.md` | spec | Remote policy hardening | historical | 2026-10-15 |
| `docs/FIX25_REPORT.md` | `docs/history/fix-25/report.md` | report | Remote policy hardening | historical | 2026-10-15 |
| `docs/FIX27_CONVERSATIONS_REPORT.md` | `docs/history/fix-27/conversations-report.md` | report | Conversations per bot | historical | 2026-10-16 |
| `docs/FIX27_CONVERSATIONS_SPEC.md` | `docs/history/fix-27/conversations-spec.md` | spec | Conversations per bot | historical | 2026-10-16 |
| `docs/FIX28_CATALOG_REPORT.md` | `docs/history/fix-28/catalog-report.md` | report | Model catalog and send | historical | 2026-10-16 |
| `docs/FIX28_CATALOG_SPEC.md` | `docs/history/fix-28/catalog-spec.md` | spec | Model catalog and send | historical | 2026-10-16 |
| `docs/FIX28_SEND_REPORT.md` | `docs/history/fix-28/send-report.md` | report | Model catalog and send | historical | 2026-10-16 |
| `docs/FIX28_SEND_SPEC.md` | `docs/history/fix-28/send-spec.md` | spec | Model catalog and send | historical | 2026-10-16 |
| `docs/FIX29_WP6A_POLICY_SPEC.md` | `docs/history/fix-29/wp6a-policy-spec.md` | spec | Remote gateway and PWA | historical | 2026-10-17 |
| `docs/FIX29_WP6A_REPORT.md` | `docs/history/fix-29/wp6a-report.md` | report | Remote gateway and PWA | historical | 2026-10-17 |
| `docs/FIX29_WP6B_GATEWAY_SPEC.md` | `docs/history/fix-29/wp6b-gateway-spec.md` | spec | Remote gateway and PWA | historical | 2026-10-17 |
| `docs/FIX29_WP6B_REPORT.md` | `docs/history/fix-29/wp6b-report.md` | report | Remote gateway and PWA | historical | 2026-10-17 |
| `docs/FIX29_WP6C1_BUILD_SPEC.md` | `docs/history/fix-29/wp6c1-build-spec.md` | spec | Remote gateway and PWA | historical | 2026-10-17 |
| `docs/FIX29_WP6C1_REPORT.md` | `docs/history/fix-29/wp6c1-report.md` | report | Remote gateway and PWA | historical | 2026-10-17 |
| `docs/FIX29_WP6C_PWA_SPEC.md` | `docs/history/fix-29/wp6c-pwa-spec.md` | spec | Remote gateway and PWA | historical | 2026-10-17 |
| `docs/FIX29_WP6C_REPORT.md` | `docs/history/fix-29/wp6c-report.md` | report | Remote gateway and PWA | historical | 2026-10-17 |
| `docs/FIX29_WP6D_CONTRACT_SPEC.md` | `docs/history/fix-29/wp6d-contract-spec.md` | spec | Remote gateway and PWA | historical | 2026-10-17 |
| `docs/FIX29_WP6D_REPORT.md` | `docs/history/fix-29/wp6d-report.md` | report | Remote gateway and PWA | historical | 2026-10-17 |
| `docs/FIX2_CODEX_TEAM_INSTRUCTIONS_SPEC.md` | `docs/history/fix-02/codex-team-instructions-spec.md` | spec | Codex team instructions, dictation TLS | historical | 2026-10-15 |
| `docs/FIX2_DICTATION_TLS_SPEC.md` | `docs/history/fix-02/dictation-tls-spec.md` | spec | Codex team instructions, dictation TLS | historical | 2026-10-14 |
| `docs/FIX31_BACKUP_REPORT.md` | `docs/history/fix-31/backup-report.md` | report | Backup and restore | historical | 2026-10-17 |
| `docs/FIX31_BACKUP_SPEC.md` | `docs/history/fix-31/backup-spec.md` | spec | Backup and restore | historical | 2026-10-16 |
| `docs/FIX32_SKILLS_REPORT.md` | `docs/history/fix-32/skills-report.md` | report | Shared skills pool | historical | 2026-10-16 |
| `docs/FIX32_SKILLS_SPEC.md` | `docs/history/fix-32/skills-spec.md` | spec | Shared skills pool | historical | 2026-10-16 |
| `docs/FIX33_REPORT.md` | `docs/history/fix-33/report.md` | report | Small backend items | historical | 2026-10-16 |
| `docs/FIX33_SMALL_BACKEND_SPEC.md` | `docs/history/fix-33/small-backend-spec.md` | spec | Small backend items | historical | 2026-10-16 |
| `docs/FIX34_A1_REMOTE_WEB_SPEC.md` | `docs/history/fix-34/a1-remote-web-spec.md` | spec | Remote web app, fresh session, CLI sign-in | historical | 2026-10-17 |
| `docs/FIX34_A1_REPORT.md` | `docs/history/fix-34/a1-report.md` | report | Remote web app, fresh session, CLI sign-in | historical | 2026-10-17 |
| `docs/FIX34_A2_FRESH_SESSION_SPEC.md` | `docs/history/fix-34/a2-fresh-session-spec.md` | spec | Remote web app, fresh session, CLI sign-in | historical | 2026-10-17 |
| `docs/FIX34_A2_REPORT.md` | `docs/history/fix-34/a2-report.md` | report | Remote web app, fresh session, CLI sign-in | historical | 2026-10-17 |
| `docs/FIX34_A5_FOLLOWUP.md` | `docs/history/fix-34/a5-followup.md` | follow-up note | Remote web app, fresh session, CLI sign-in | historical | 2026-10-17 |
| `docs/FIX34_A5_REPORT.md` | `docs/history/fix-34/a5-report.md` | report | Remote web app, fresh session, CLI sign-in | historical | 2026-10-17 |
| `docs/FIX34_A5_SIGN_IN_SPEC.md` | `docs/history/fix-34/a5-sign-in-spec.md` | spec | Remote web app, fresh session, CLI sign-in | historical | 2026-10-17 |
| `docs/FIX35_C1_NATIVE_REMOTE_SPEC.md` | `docs/history/fix-35/c1-native-remote-spec.md` | spec | Native Remote | historical | 2026-10-17 |
| `docs/FIX35_C1_REPORT.md` | `docs/history/fix-35/c1-report.md` | report | Native Remote | historical | 2026-10-17 |
| `docs/FIX35_C2_CONNECTIVITY_SPEC.md` | `docs/history/fix-35/c2-connectivity-spec.md` | spec | Native Remote | historical | 2026-10-17 |
| `docs/FIX35_C2_FINISH.md` | `docs/history/fix-35/c2-finish.md` | follow-up note | Native Remote | historical | 2026-10-17 |
| `docs/FIX35_C2_REPORT.md` | `docs/history/fix-35/c2-report.md` | report | Native Remote | historical | 2026-10-17 |
| `docs/FIX35_C3_FOLLOWUP.md` | `docs/history/fix-35/c3-followup.md` | follow-up note | Native Remote | historical | 2026-10-17 |
| `docs/FIX35_C4_TEST_BIND.md` | `docs/history/fix-35/c4-test-bind.md` | follow-up note | Native Remote | historical | 2026-10-17 |
| `docs/FIX35_C5_WINDOWS.md` | `docs/history/fix-35/c5-windows.md` | follow-up note | Native Remote | historical | 2026-10-17 |
| `docs/FIX35_C6_ME_METHOD.md` | `docs/history/fix-35/c6-me-method.md` | follow-up note | Native Remote | historical | 2026-10-17 |
| `docs/FIX36_D1_FOLLOWUP.md` | `docs/history/fix-36/d1-followup.md` | follow-up note | Manager bot | historical | 2026-10-17 |
| `docs/FIX36_D1_MANAGER_SPEC.md` | `docs/history/fix-36/d1-manager-spec.md` | spec | Manager bot | historical | 2026-10-17 |
| `docs/FIX36_D1_REPORT.md` | `docs/history/fix-36/d1-report.md` | report | Manager bot | historical | 2026-10-17 |
| `docs/FIX36_D2_PROPOSALS_SPEC.md` | `docs/history/fix-36/d2-proposals-spec.md` | spec | Manager bot | historical | 2026-10-17 |
| `docs/FIX36_D2_REPORT.md` | `docs/history/fix-36/d2-report.md` | report | Manager bot | historical | 2026-10-17 |
| `docs/FIX36_D3_KNOWLEDGE_SPEC.md` | `docs/history/fix-36/d3-knowledge-spec.md` | spec | Manager bot | historical | 2026-10-17 |
| `docs/FIX36_D3_REPORT.md` | `docs/history/fix-36/d3-report.md` | report | Manager bot | historical | 2026-10-17 |
| `docs/FIX37_G1_REMOTE_AND_RESUME_SPEC.md` | `docs/history/fix-37/g1-remote-and-resume-spec.md` | spec | Remote, resume, UI polish, slash commands, updates | historical | 2026-10-18 |
| `docs/FIX37_G1_REPORT.md` | `docs/history/fix-37/g1-report.md` | report | Remote, resume, UI polish, slash commands, updates | historical | 2026-10-18 |
| `docs/FIX37_G2_REPORT.md` | `docs/history/fix-37/g2-report.md` | report | Remote, resume, UI polish, slash commands, updates | historical | 2026-10-18 |
| `docs/FIX37_G2_UI_POLISH_SPEC.md` | `docs/history/fix-37/g2-ui-polish-spec.md` | spec | Remote, resume, UI polish, slash commands, updates | historical | 2026-10-18 |
| `docs/FIX37_G3_REPORT.md` | `docs/history/fix-37/g3-report.md` | report | Remote, resume, UI polish, slash commands, updates | historical | 2026-10-18 |
| `docs/FIX37_G3_SELECTION_SPEC.md` | `docs/history/fix-37/g3-selection-spec.md` | spec | Remote, resume, UI polish, slash commands, updates | historical | 2026-10-18 |
| `docs/FIX37_G4_REPORT.md` | `docs/history/fix-37/g4-report.md` | report | Remote, resume, UI polish, slash commands, updates | historical | 2026-10-18 |
| `docs/FIX37_G4_SLASH_COMMANDS_SPEC.md` | `docs/history/fix-37/g4-slash-commands-spec.md` | spec | Remote, resume, UI polish, slash commands, updates | historical | 2026-10-18 |
| `docs/FIX37_G5_AUTO_UPDATE_SPEC.md` | `docs/history/fix-37/g5-auto-update-spec.md` | spec | Remote, resume, UI polish, slash commands, updates | historical | 2026-10-18 |
| `docs/FIX37_G5_REPORT.md` | `docs/history/fix-37/g5-report.md` | report | Remote, resume, UI polish, slash commands, updates | historical | 2026-10-18 |
| `docs/FIX37_G6_PREVIEW_PARITY_SPEC.md` | `docs/history/fix-37/g6-preview-parity-spec.md` | spec | Remote, resume, UI polish, slash commands, updates | historical | 2026-10-18 |
| `docs/FIX37_G6_REPORT.md` | `docs/history/fix-37/g6-report.md` | report | Remote, resume, UI polish, slash commands, updates | historical | 2026-10-18 |
| `docs/FIX38_H1_REMOTE_PAIRING_SPEC.md` | `docs/history/fix-38/h1-remote-pairing-spec.md` | spec | Remote pairing, empty conversation, tree lines | historical | 2026-10-18 |
| `docs/FIX38_H1_REPORT.md` | `docs/history/fix-38/h1-report.md` | report | Remote pairing, empty conversation, tree lines | historical | 2026-10-18 |
| `docs/FIX38_H2_EMPTY_CONVERSATION_SPEC.md` | `docs/history/fix-38/h2-empty-conversation-spec.md` | spec | Remote pairing, empty conversation, tree lines | historical | 2026-10-18 |
| `docs/FIX38_H2_REPORT.md` | `docs/history/fix-38/h2-report.md` | report | Remote pairing, empty conversation, tree lines | historical | 2026-10-18 |
| `docs/FIX38_H3_REPORT.md` | `docs/history/fix-38/h3-report.md` | report | Remote pairing, empty conversation, tree lines | historical | 2026-10-18 |
| `docs/FIX38_H3_TREE_LINES_SPEC.md` | `docs/history/fix-38/h3-tree-lines-spec.md` | spec | Remote pairing, empty conversation, tree lines | historical | 2026-10-18 |
| `docs/FIX39_AUDIT_IMPL_BRIEF.md` | `docs/history/fix-39/audit-impl-brief.md` | brief | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_AUDIT_RESEARCH_BRIEF.md` | `docs/history/fix-39/audit-research-brief.md` | research | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_DECISIONS.md` | `docs/history/fix-39/decisions.md` | decision or feedback | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_DIRECTOR_CHECKS.md` | `docs/history/fix-39/director-checks.md` | decision or feedback | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_DOCS_BRIEF.md` | `docs/history/fix-39/docs-brief.md` | brief | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_FEEDBACK.md` | `docs/history/fix-39/feedback.md` | decision or feedback | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_IMPLEMENT_BRIEF.md` | `docs/history/fix-39/implement-brief.md` | brief | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P10_AUDIT.md` | `docs/history/fix-39/p10-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P10_REPORT.md` | `docs/history/fix-39/p10-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P11_AUDIT.md` | `docs/history/fix-39/p11-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P11_REPORT.md` | `docs/history/fix-39/p11-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P12_AUDIT.md` | `docs/history/fix-39/p12-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P12_REPORT.md` | `docs/history/fix-39/p12-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P13_AUDIT.md` | `docs/history/fix-39/p13-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P13_REPORT.md` | `docs/history/fix-39/p13-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P1_AUDIT.md` | `docs/history/fix-39/p1-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P1_REPORT.md` | `docs/history/fix-39/p1-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P2_AUDIT.md` | `docs/history/fix-39/p2-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P2_REPORT.md` | `docs/history/fix-39/p2-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P3_AUDIT.md` | `docs/history/fix-39/p3-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P3_REPORT.md` | `docs/history/fix-39/p3-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P4_AUDIT.md` | `docs/history/fix-39/p4-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P4_REPORT.md` | `docs/history/fix-39/p4-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P5_AUDIT.md` | `docs/history/fix-39/p5-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P5_REPORT.md` | `docs/history/fix-39/p5-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P6_AUDIT.md` | `docs/history/fix-39/p6-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P6_REPORT.md` | `docs/history/fix-39/p6-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P7_AUDIT.md` | `docs/history/fix-39/p7-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P7_REPORT.md` | `docs/history/fix-39/p7-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P8_AUDIT.md` | `docs/history/fix-39/p8-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P8_REPORT.md` | `docs/history/fix-39/p8-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P9_AUDIT.md` | `docs/history/fix-39/p9-audit.md` | audit | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_P9_REPORT.md` | `docs/history/fix-39/p9-report.md` | report | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_RESEARCH_AUDIT.md` | `docs/history/fix-39/research-audit.md` | research | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_RESEARCH_BRIEF.md` | `docs/history/fix-39/research-brief.md` | research | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_RESEARCH_R1.md` | `docs/history/fix-39/research-r1.md` | research | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_RESEARCH_R2.md` | `docs/history/fix-39/research-r2.md` | research | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX39_RESEARCH_R3.md` | `docs/history/fix-39/research-r3.md` | research | Four-model pipeline, backend and UI items | historical | 2026-10-18 |
| `docs/FIX3_OPENCODE2_ACP_LAUNCH_SPEC.md` | `docs/history/fix-03/opencode2-acp-launch-spec.md` | spec | OpenCode 2 launch | historical | 2026-10-15 |
| `docs/FIX40_CHARACTERS_SPEC.md` | `docs/history/fix-40/characters-spec.md` | spec | Looks, bot art, themes | historical | 2026-10-19 |
| `docs/FIX40_ORBS_SPEC.md` | `docs/history/fix-40/orbs-spec.md` | spec | Looks, bot art, themes | historical | 2026-10-19 |
| `docs/FIX40_REPORT.md` | `docs/history/fix-40/report.md` | report | Looks, bot art, themes | historical | 2026-10-19 |
| `docs/FIX40_ROUND2_SPEC.md` | `docs/history/fix-40/round2-spec.md` | spec | Looks, bot art, themes | historical | 2026-10-19 |
| `docs/FIX40_T3_RESEARCH.md` | `docs/history/fix-40/t3-research.md` | research | Looks, bot art, themes | historical | 2026-10-18 |
| `docs/FIX40_T3_RESEARCH_BRIEF.md` | `docs/history/fix-40/t3-research-brief.md` | research | Looks, bot art, themes | historical | 2026-10-18 |
| `docs/FIX40_THEMES_SPEC.md` | `docs/history/fix-40/themes-spec.md` | spec | Looks, bot art, themes | historical | 2026-10-19 |
| `docs/FIX41_COMPANION_LOOKS_BRIEF.md` | `docs/history/fix-41/companion-looks-brief.md` | brief | Companion and dictation looks | historical | 2026-10-19 |
| `docs/FIX41_COMPANION_LOOKS_REPORT.md` | `docs/history/fix-41/companion-looks-report.md` | report | Companion and dictation looks | historical | 2026-10-19 |
| `docs/FIX41_LEFTOVERS_BRIEF.md` | `docs/history/fix-41/leftovers-brief.md` | brief | Companion and dictation looks | historical | 2026-10-19 |
| `docs/FIX4_CLIPPY_CLEANUP_SPEC.md` | `docs/history/fix-04/clippy-cleanup-spec.md` | spec | Clippy hygiene | historical | 2026-10-14 |
| `docs/FIX5_OPENCODE2_PER_MODEL_EFFORT_SPEC.md` | `docs/history/fix-05/opencode2-per-model-effort-spec.md` | spec | OpenCode 2 effort | historical | 2026-10-14 |
| `docs/FIX6_OPENCODE_INSTRUCTIONS_RESPAWN_SPEC.md` | `docs/history/fix-06/opencode-instructions-respawn-spec.md` | spec | OpenCode instructions | historical | 2026-10-14 |
| `docs/FIX7_OPENCODE_USAGE_AND_SIGNIN_SPEC.md` | `docs/history/fix-07/opencode-usage-and-signin-spec.md` | spec | OpenCode usage and sign-in | historical | 2026-10-15 |
| `docs/FIX8_DELEGATION_TIMELINE_ORDER_SPEC.md` | `docs/history/fix-08/delegation-timeline-order-spec.md` | spec | Delegation timeline | historical | 2026-10-14 |
| `docs/FIX9_RENAME_REPORT.md` | `docs/history/fix-09/rename-report.md` | report | Rename to Bitbots | historical | 2026-10-15 |
| `docs/FIX9_RENAME_SPEC.md` | `docs/history/fix-09/rename-spec.md` | spec | Rename to Bitbots | historical | 2026-10-15 |
| `docs/APPROVAL_MODES.md` | `docs/reference/approval-modes.md` | reference | Permissions and approval | current | 2026-10-15 |
| `docs/runtime-capabilities.md` | `docs/reference/runtime-capabilities.md` | reference | Runtime capabilities | current evidence record | 2026-10-15 |
| `docs/PHASE_5_CONTRACT.md` | `docs/reference/phase-5-analytics-contract.md` | reference | Usage and cost analytics | superseded in part | 2026-10-14 |
| `docs/BITBOTS_THEME_SPEC.md` | `docs/design/bitbots-theme-spec.md` | design rule | Themes (pixel re-skin) | historical | 2026-10-13 |
| `docs/UI_POLISH_WAVE.md` | `docs/design/ui-polish-wave.md` | design rule | UI polish wave | historical | 2026-10-15 |
| `docs/windows-development.md` | `docs/guides/windows-development.md` | guide | Desktop development on Windows | current | 2026-10-15 |
| `scripts/live-checks/README.md` | `docs/guides/live-checks.md` | guide | Live CLI checks | current | 2026-10-15 |
| `scripts/native-smoke/README.md` | `docs/guides/native-smoke.md` | guide | Native smoke tooling | current | 2026-10-02 |
| `docs/E2E_PLAN_V2.md` | `docs/plans/e2e-plan-v2.md` | plan | Whole-product plan | current plan | 2026-10-15 |
| `docs/IMPROVEMENT_PLAN.md` | `docs/plans/improvement-plan.md` | plan | Companion-style roadmap | current | 2026-10-15 |
| `docs/IMPROVEMENT_PLAN_v1_qa-draft.md` | `docs/history/improvement/plan-v1-qa-draft.md` | plan | Early improvement plan (QA draft) | superseded by | 2026-10-15 |
| `docs/IMPROVEMENT_PHASE_1A_SPEC.md` | `docs/history/improvement/phase-1a-spec.md` | spec | Improvement plan phase 1A | historical | 2026-10-12 |
| `docs/IMPROVEMENT_PHASE_1B_SPEC.md` | `docs/history/improvement/phase-1b-spec.md` | spec | Improvement plan phase 1B | historical | 2026-10-12 |
| `docs/IMPROVEMENT_PHASE_2A_SPEC.md` | `docs/history/improvement/phase-2a-spec.md` | spec | Improvement plan phase 2A | historical | 2026-10-12 |
| `docs/IMPROVEMENT_PHASE_2B_SPEC.md` | `docs/history/improvement/phase-2b-spec.md` | spec | Improvement plan phase 2B | historical | 2026-10-12 |
| `docs/IMPROVEMENT_PHASE_3A_SPEC.md` | `docs/history/improvement/phase-3a-spec.md` | spec | Improvement plan phase 3A | historical | 2026-10-15 |
| `docs/IMPROVEMENT_PHASE_3B_SPEC.md` | `docs/history/improvement/phase-3b-spec.md` | spec | Improvement plan phase 3B | historical | 2026-10-13 |
| `docs/IMPROVEMENT_PHASE_4A_SPEC.md` | `docs/history/improvement/phase-4a-spec.md` | spec | Improvement plan phase 4A | historical | 2026-10-12 |
| `docs/IMPROVEMENT_PHASE_4B_SPEC.md` | `docs/history/improvement/phase-4b-spec.md` | spec | Improvement plan phase 4B | historical | 2026-10-15 |
| `docs/IMPROVEMENT_PHASE_5A_SPEC.md` | `docs/history/improvement/phase-5a-spec.md` | spec | Improvement plan phase 5A | historical | 2026-10-12 |
| `docs/IMPROVEMENT_PHASE_6A_SPEC.md` | `docs/history/improvement/phase-6a-spec.md` | spec | Improvement plan phase 6A | historical | 2026-10-15 |
| `docs/IMPROVEMENT_PHASE_7_SPEC.md` | `docs/history/improvement/phase-7-spec.md` | spec | Improvement plan phase 7 | historical | 2026-10-14 |
| `docs/PHASE_2A_SPEC.md` | `docs/history/phases/phase-2a-spec.md` | spec | Agent identity, storage and RPCs | historical | 2026-10-04 |
| `docs/PHASE_2B_SPEC.md` | `docs/history/phases/phase-2b-spec.md` | spec | Phase 2B spec | historical | 2026-10-15 |
| `docs/PHASE_3_SPEC.md` | `docs/history/phases/phase-3-spec.md` | spec | Blob roster and editor | historical | 2026-10-15 |
| `docs/PHASE_4_SPEC.md` | `docs/history/phases/phase-4-spec.md` | spec | Project and session tree | historical | 2026-10-15 |
| `docs/DIRECTOR_LOG.md` | `docs/history/director-log.md` | log | Director log | historical | 2026-10-15 |
| `docs/DOCS_AUDIT.md` | `docs/audits/docs-audit-2026-10-14.md` | audit | Earlier documentation audit | historical | 2026-10-14 |
| `docs/v1-coverage.md` | `docs/audits/v1-coverage.md` | audit | V1 coverage audit | historical snapshot of 1 October 2026 | 2026-10-15 |
| `docs/OPERATING_MODEL.md` | `docs/operations/operating-model.md` | operations | Operating model | current | 2026-10-15 |
| `docs/RELEASE_CHECKLIST.md` | `docs/operations/release-checklist.md` | operations | Release checklist | current | 2026-10-19 |
| `docs/UPDATER.md` | `docs/operations/updater.md` | operations | Auto-update contract | current | 2026-10-15 |
| `docs/implementation-status.md` | `docs/operations/implementation-status.md` | operations | Implementation status | current through the FIX40 wave, released as v0.1.0-beta.35 (19 October 2026) | 2026-10-19 |
| `docs/NATIVE_SMOKE_RESULTS.md` | `docs/operations/native-smoke-results.md` | report | Native smoke results | historical | 2026-10-15 |
| `docs/README.md` | (stays, rewritten as the index) | reference (index) | project-wide | current | 2026-10-19 |

## Duplicates, superseded records and contradictions (found in phase 1)

- **Stale release state.** [README.md](../../../README.md) says the status is `v0.1.0-beta.34`, and [docs/README.md](../../README.md) says the last tagged release is `beta.33` with `beta.34` in preparation. `SESSION_HANDOFF.md` and `git log` show `v0.1.0-beta.35` (`71475d4`). These are facts about the current state and are not changed by this pass; they are listed for the owner to decide (see the final report).
- **Same name, two plans.** [docs/PHASE_2B_SPEC.md](../../history/phases/phase-2b-spec.md) (the Phase 2B of the E2E plan) and [docs/IMPROVEMENT_PHASE_2B_SPEC.md](../../history/improvement/phase-2b-spec.md) (steer a live Codex turn) are unrelated. The new names keep them apart (`history/phases/` and `history/improvement/`).
- **Two plan documents.** [docs/E2E_PLAN_V2.md](../../plans/e2e-plan-v2.md) is named by `AGENTS.md` as the plan. [docs/IMPROVEMENT_PLAN.md](../../plans/improvement-plan.md) is named by `AGENTS.md` (12 October amendment) as the roadmap. The early [IMPROVEMENT_PLAN_v1_qa-draft.md](../../history/improvement/plan-v1-qa-draft.md) is superseded by the v2 roadmap.
- **Continuation notes.** `FIX1_DICTATION_CONTINUE`, `FIX1_TEAM_CONTINUE`, `FIX35_C2_FINISH`, `FIX35_C3_FOLLOWUP` and similar notes are short follow-ups for a finished spec; they stay with their wave.
- **Two runtime-capabilities evidence files.** [docs/evidence/task2-grok-runtime-capabilities.md](../../evidence/task2-grok-runtime-capabilities.md) and [docs/evidence/task2-luna-runtime-capabilities-original.md](../../evidence/task2-luna-runtime-capabilities-original.md) differ in author and date. The second is marked "original". Both are protected (evidence); phase 3 adds status lines only.
- **Missing titles.** [docs/PHASE_2B_SPEC.md](../../history/phases/phase-2b-spec.md), [docs/runtime-capabilities.md](../../reference/runtime-capabilities.md), [docs/DIRECTOR_LOG.md](../../history/director-log.md) and the evidence file `task2-luna-runtime-capabilities-original.md` have no level-one heading. Phase 3 adds one.
- **Superseded design.** [docs/BITBOTS_THEME_SPEC.md](../../design/bitbots-theme-spec.md) (the pixel re-skin, 13 October) is superseded by the FIX40 looks and themes. The current rules are in [DESIGN.md](../../../DESIGN.md).
- **Obsolete budget clauses.** Several historical specs describe budgets. `AGENTS.md` (12 October amendment) retires them, and `budget.*` returns `unsupported`. Historical records keep their text and gain a one-line note.
- **Old names.** Earlier records say Bloblex, blobs and "Fix 1A" style headings. Historical records keep their wording; current documents use the current names (see [STYLE.md](../../STYLE.md) once written).

## Pre-existing dangling mentions (not changed)

These paths were already missing before this pass. They are listed so that a reader does not follow them. Phase 3 did not change the facts they state.

- [docs/history/fix-02/dictation-tls-spec.md](../../history/fix-02/dictation-tls-spec.md) and [docs/history/improvement/phase-7-spec.md](../../history/improvement/phase-7-spec.md) name `docs/evidence/cloud-dictation-2026-10-12.md`, which is not in the tree. The 13 and 14 October cloud dictation evidence files are the current records.
- The audit of 14 October names `docs/FIX2_DICTATION_ALPN_SPEC.md`, and the cloud dictation evidence of 14 October names it too. The closest current record is `docs/history/fix-02/dictation-tls-spec.md`; this is an assumption, not confirmed.
- `docs/ipc-contract.md` (protected) and `docs/remote/PHASES.md` name `docs/FIX29_REMOTE_TAILSCALE_SPEC.md`, which is not in the tree. The FIX29 gateway spec is `docs/history/fix-29/wp6b-gateway-spec.md`.
- The T3 research (`docs/history/fix-40/t3-research.md`) and the FIX39 research (`docs/history/fix-39/research-audit.md`, `research-r2.md`, `research-r3.md`) cite paths in another repository (`docs/user/...`, `docs/internals/...`, `docs/orchestration-v2/...`). They are citations of the T3 Code repository, not of this one.
- `docs/evidence/task2-luna-runtime-capabilities-original.md` (protected) and the older `docs/example.md`, `docs/new.md` and `docs/effort-picker.md` mentions in test fixtures (`apps/desktop/src/preview/fixtureBridge.ts`, `SessionRail.test.ts`) are fixture data, not documents.
