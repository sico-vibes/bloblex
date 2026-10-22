# Accepted product expansion plan

> **What this is:** the owner's accepted scope and constraints for the 20–21 October expansion, kept as a historical record.
> **Status:** historical record, superseded in part (see update).
> **Last updated:** 2026-10-22

**Update 22 October 2026.** The owner resumed the expansion on 21 October 2026. Phase 1 (the tasks board, tree and timeline, and the task backend) was rebuilt and merged to `main` at `26ec193`. The current plan is [expansion-plan-v2](expansion-plan-v2.md), and its phase 1 status is in [status.md](../history/expansion-v2/status.md). This document keeps the accepted scope of 20 and 21 October as it was recorded. The Codex worktrees it names remain unmerged reference only.

This plan records the accepted expansion as a whole. It does not certify that any lane is complete. The current source status, test evidence, worktree locations and resume instructions are in [the 21 October expansion handoff](../operations/expansion-handoff-2026-10-21.md). The source baseline is `64344a6866db0fa8e6618995a0e14edd4d6da7e7` (`v0.1.0-beta.36`).

## Product scope

1. Add an integrated terminal dock for bot/project work, with bounded terminal sessions owned by the native shell and visible in the desktop.
2. Add six optional chat-background image effects (none, dither, ASCII, halftone, scanlines and haze), with separate empty-chat and conversation opacity controls. Keep image bytes and paths out of daemon settings and remote settings.
3. Add Cursor and Grok as native ACP providers, with provider capability claims restricted to verified runtime behavior. Do not invent Grok usage or resume support.
4. Add a GitHub inbox using the owner's GitHub CLI identity, with safe issue/PR detail and a way to create a task draft retaining the source URL.
5. Add an MCP connector catalogue and connector management for official registry entries and custom servers over stdio or Streamable HTTP. Keep secret material in Windows Credential Manager; SQLite stores references only. Discover tools/resources, expose exact per-agent/project grants and require an owner allow-once approval card for every external tool action. Support OAuth with state/PKCE and bounded local callback handling; assess DCR/CIMD and refresh safely. Package installation is a separate gated capability, never implicit code execution.
6. Add optional local Windows computer control through a real native helper/driver. Owner grants are per bot and selected window, default off; enforce one input controller, an immediate stop/revoke path, screenshot disclosure consent and fail-closed behavior for locked desktop, helper/window errors and elevation. No phone viewer. Remote actions require operator tier and a local per-bot/per-device grant; origin/device are authenticated context, never tool arguments.
7. Add a verified OpenCode free onboarding flow: catalog/readiness and a true isolated native tool round-trip, with no claim of free access from a model name, fixture, HTTP status or text-only answer.
8. Add managed CLI setup jobs with bounded status/cancel behavior and safe logs; preserve existing provider logins and chats. No copied provider credentials.
9. Add a durable optional task board/tree/timeline. Existing Manager delegation proposals and approval cards remain the default. Manager MCP task creation creates an unassigned draft only. Desktop users may create/edit drafts and a single drop/Assign action calls atomic `task.dispatch`; it starts if the bot is idle or queues if busy. A task is distinct from a conversation and a run/attempt is distinct from the task. Preserve immutable origin/parent linkage and immutable per-run assignee identity. Render intervals only from observed transition timestamps.
10. Support global/per-task supervision policies: `report_only` returns work for user review; `bounded` lets the Manager evaluate evidence and request at most two correction rounds in the same task runtime cap, then awaits the user; `manager_completes` may mark done only with evidence. Provider `turn.completed` alone is not success. Reviewers run with effective read-only/plan-only permissions even if their normal bot profile has Full access. Protected actions continue through ordinary approvals.
11. Support once and cron schedules by reusing the existing timezone-aware scheduler. Manager schedule proposals are disabled until the desktop owner enables schedules and sees future runs, assignee, permissions and policy. Default cap is 30 minutes shared by work and corrections; unattended execution never bypasses approval; maximum task concurrency is 3 within the existing global cap of 4; global pause and overlap-skip are durable, and missed/restart/DST outcomes are honest. No monetary budgets (retired).
12. Add optional end-to-end encrypted relay, LOCAL DEVELOPMENT FIRST. No hosted deployment or public release is authorized by this plan. Keep desktop/local owner approval, per-device scope, expiry/revocation and remote-origin policy. Treat any live service behavior as unverified until separately authorized and tested.

## Shared constraints

- Preserve chats, provider logins, credentials and existing user data. Never print, store in SQLite, return or send provider secrets, credential bytes, image data or environment values.
- Existing managed worktrees are unmerged snapshots. Do not infer a supported release feature from a source module, RPC mock, fixture, storage test or UI preview.
- Follow public-release compatibility. Reuse suitable MIT/Apache material with notices and provenance; implement OpenBot-derived concepts independently where its license/restrictions do not permit copying.
- Remote policy stays deny-by-default and content-safe. Never put user prompts, messages, goals, connector results or secrets into activity events. Do not grant new remote methods until the shared tier policy and parity checks are reviewed.
- All unattended work has a runtime cap, bounded concurrency, global pause and a permission path that never bypasses owner approvals.
- Run Windows native builds from an apostrophe-free short path and give each worktree its own Cargo target. Use isolated `BLOBLEX_DB_PATH` and disposable projects for integration tests. Do not restart the installed app or touch live user data without owner direction.

## State vocabulary

`not-started` means no implementation evidence was found. `in-progress` means source work exists but acceptance is incomplete. `implemented-unverified` means a source path exists without an adequate test gate. `targeted-tests-pass` applies only to named targeted tests on the snapshot they tested. `integrated-E2E-pass` requires merged code and an end-to-end check of the real flow. A status applies only to the exact source snapshot and tests cited in the handoff.
