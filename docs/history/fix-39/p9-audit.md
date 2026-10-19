# FIX39 P9 audit (Claude Sonnet 5.5)

> **What this is:** Audit of FIX39 package P9 by Claude Sonnet 5.5.
> **Status:** historical
> **Last updated:** 2026-10-18

**Verdict: PASS WITH FIXES.** Decisions 5 and 6 and the Working bots panel are implemented as the owner described. There are no security findings. One real defect, in the Working bots panel (F1), must be fixed before merge. The remaining fixes are small. I read the diff and the new files and did not re-run the gates. The report's counts are plausible and the hot-file edits are narrow.

## What I checked, item by item

| Item | Result |
|---|---|
| Decision 5: new bots start with Full access | Done. `agentForm.ts:103` makes `createDraft` and `starterDraft` default to `bypass`. `main.rs:1715` fills `approvalMode` only when it is absent (`entry().or_insert`), so an explicit `null` ("team default") and explicit ask/auto are kept, and existing rows are untouched. `duplicateParams` now sends `approvalMode: source.approvalMode ?? null`, so a copy does not escalate. Onboarding, Manager setup card, wizard review and the settings choice all say "Full access" plainly. |
| Decision 5 limits | Kept. `proposals.rs:431` still gives Manager-proposed bots `ask` (or `auto`), never `bypass`. `proposals.rs:56/170` still refuse Full access for `set_conversation_permission`. The automation clamp is untouched, and the Manager's Full access is the owner's explicit decision for Manager setup. |
| Decision 6: Steer/Queue setting | Done. General › "When you send while a bot is working", key `composer.busySendMode`, default Steer, searchable in `settingsIndex.ts`. Ctrl/Cmd+Enter sends the other way, Shift+Enter is a newline. The composer and companion show the effective mode. Fallback to Queue is explained when steering is unavailable or the message carries context. Stale or unsupported steer falls back to Queue. An ambiguous provider error is not resent, which is correct because it may have been delivered. |
| Rec. 11 and Working bots panel | Mostly done. The panel is in the rail with a face, name, short title, status, elapsed time, `N finished`, and a click opens the exact sub-conversation. Side-session activity now shows with the Agent activity switch off. See F1 for the defect. |
| Remote and security | No new RPC or event, and `session.steer`, `settings.set` and `agent.create` are unchanged, so no `tiers.json` row is needed. No message text goes into logs. The new copy holds no conversation text. |
| Visual rules | No star or sparkle icons. `CornerDownRight` (the old steer icon) was removed from the imports. Tokens used (`--line`, `--text-*`, `--surface-hover`, `--radius-sm`, `--fs-*`) are the shared semantic ones. Look and theme were not inspected (the report says so too). |

## Findings

### F1 (must fix): unhydrated side sessions show as "Waiting" with a running clock

`WorkingBotsPanel.tsx:11-23` and `:46-49`.

`session_list` (`bloblex-storage/src/lib.rs:2516`) returns no `turns` or `messages`. `App.tsx:526-540` loads full sessions only 4 at a time, the selected bot's first, and a failed `session.get` is never retried (`failedSessionHydrations`). The panel takes every non-archived side session, and `taskStatus` falls through to `'Waiting'` for any session without turns. Until a session is hydrated, every old, finished sub-conversation therefore appears under Working bots as an active "Waiting" task. Its elapsed time is `now - createdAt`, so it can read "52h 3m" and ticks every second. A session whose hydration failed shows this permanently. The count in the heading and the 1 s interval also include these rows.

Fix:
- In `taskStatus`, treat a session with `turns === undefined && messages === undefined` as not yet known. Either leave it out of the panel until hydrated (preferred), or return `'Loading'`, count it as neither active nor finished, and show no elapsed time. A thin snapshot whose `state` is itself busy, queued, limited, or waiting for permission (all states the list does carry) should still show its real status.
- Keep the "never claim Done on a thin snapshot" rule.
- Add a `WorkingBotsPanel.mounted.test.tsx` case: a thin idle side session produces no active row and no ticking timer; after hydration with a completed turn it appears under `1 finished`. The current `busySend.test.ts` test at line 42 only asserts that the status string is `'Waiting'`, which locks in the wrong behaviour.

### F2 (small): turn end states other than `error`/`failed`/`cancelled`

`WorkingBotsPanel.tsx:17-19`. A hydrated session whose last turn ended with another terminal state (for example `timeout` or `interrupted`, if the turn table can hold them; check the `update_turn_state` callers) falls through to `'Done'` when any assistant message exists, or to `'Waiting'` otherwise. Map any terminal non-`completed` turn state to `Failed`, and add one case to the status test.

### F3 (small): elapsed time of a finished task can keep growing

`WorkingBotsPanel.tsx:28`. When `turns.at(-1).completedAt` is missing, the end time falls back to `session.updatedAt`, which moves on rename, reaction or any later write. Prefer the last turn's `completedAt`. If it is missing, show `—` instead of a value that changes afterwards.

### F4 (small): permanent "Steering is unavailable" line for the default setting

`busySend.ts:48` and `App.tsx:2533` / `:3709`. Steer is the default and the Codex steer gate is off by default (experimental), so every Claude Code, OpenCode and gate-off Codex user sees "Steering is unavailable for this coding agent. Your message waits for the turn to end." under the composer on every busy turn. The behaviour is right (it queues), but the line is constant noise. Show the explanation only after a message was actually sent and queued because of the fallback (`deliveryNotice`). Before sending, show just "Queue · sends after this turn". The existing mounted test (`App.agent.mounted.test.tsx`, steer/queue case) only checks for "Ctrl", so it needs no change beyond a check that no reason line is present when steering is available.

### F5 (small): extra capability RPC on every state change

`busySend.ts:20-30`, `App.tsx` (`useSteerAvailable(... `${selectedSession?.state}:${steerRevision}`)`). The removed code asked only for Codex and only while a turn was live. The new hook calls `runtime.capabilities` on every session state change for every provider, and also for the companion. Pass `undefined` as `runtimeId` unless the session is busy (`working`, `starting`, `waiting_permission`), or keep the provider guard. Behaviour is otherwise correct, and a stale answer is dropped by the `runtimeId` check.

### F6 (tidy, scope)

- `.p9-cache/` is untracked and holds Vite cache output. It must not be staged or committed. The Director should remove it as a link-safe delete after the merge, and `git add` should name files explicitly.
- `docs/history/fix-39/audit-impl-brief.md` shows as modified, but `git diff --ignore-space-at-eol` is empty: line endings only. Revert it so the commit carries no unrelated change.
- `workingBotsPanel.css:21-22` holds `.composer-send-mode` and `.composer-send-reason`, which belong to the composer. They only work because `App.tsx` imports the panel. Move them to the stylesheet that already holds `.composer-wrap` and `.companion-queue-note`.

### F7 (test gaps, non-blocking)

- The companion's Steer/Queue path (`Companion` form, Ctrl+Enter via `sendCompanionPrompt(event, true)`, `deliveryNotice`) has no mounted test. The report says the companion "uses the same preference". A small test with the companion variant that submits with Ctrl+Enter and expects `session.queue.add`/`session.steer` would back that up.
- The Rust default test that fails on old code is good (`approval_policy_rpc_defaults_and_rejects_global_bypass` now does a real ask change instead of bypass→bypass, and the new test covers explicit modes, `null`, an existing row and the Manager). No finding there.

## Scope

Files outside the original rec. 11 list (`agentForm.ts`, onboarding, Manager setup, `BlobSettings.tsx`, `BotWizard.tsx`, `SettingsSheet.tsx`, `settingsIndex.ts`) are justified by decisions 5 and 6. `main.rs` changes are limited to the creation default, the `manager.ensure` line and tests. `App.tsx` changes are confined to the busy-send path, the activity visibility for side sessions, the first-run state, the setup draft and the rail slot. `SessionRail.tsx` wraps the empty rail in a `session-rail` div, which is fine. No `team.rs`, `proposals.rs`, storage, adapters, Tauri or Remote policy changes.

## After the fixes

Rerun the UI tests for `WorkingBotsPanel`, `busySend`, `App.agent.mounted` and `SettingsSheet.appearance`, plus `tsc -b`. The Director still owes the four look and theme combinations, the narrow rail, and a live Codex steer check after the merge.


## Re-check (Sonnet), verbatim

The auditor re-checked the follow-up and replied:

PASS

I re-checked the follow-up against each audit finding and the current files. I did not re-run the gates, so the report's gate counts are the implementer's own.

- **F1:** `WorkingBotsPanel.tsx:21` returns `'Loading'` for a row with no turns and no messages, and `:47` filters those rows out. They are not counted, show no elapsed time and start no timer. Live states on a thin row (limited, waiting for permission, starting, busy, queued/waiting) are checked first, so they still show their real status. A thin row is never reported as Done. Tests: `busySend.test.ts:43-44` and the mounted case at `WorkingBotsPanel.mounted.test.tsx:36` (thin row absent, then "1 finished" with `1h 0m` after hydration).
- **F2:** `:24` maps any last turn state other than `completed` or `working` to Failed, with `cancelled` handled separately. `busySend.test.ts:55` covers it.
- **F3:** `:35` no longer falls back to `session.updatedAt`. A missing `completedAt` gives `—`. `busySend.test.ts:59` covers it.
- **F4:** The pre-send "Steering is unavailable" line is gone. `App.tsx:2533` and `:3709` render the explanation only from `deliveryNotice`, after a send was actually queued by the fallback. The report says `App.agent.mounted.test.tsx` now checks for no reason line before sending and for the explanation after the queuing send. I did not open that test.
- **F5:** `steerRuntimeId` (`busySend.ts:23-26`) probes `runtime.capabilities` only while the session is `working`, `starting` or `waiting_permission`. `App.tsx:689` and `:720` use it, so the companion gets the same gate.
- **F6:**
  - `docs/history/fix-39/audit-impl-brief.md` no longer shows in `git status`.
  - The two composer classes moved to `shell.css:260-261`.
  - `.p9-cache/` is still untracked, as expected. The Director must stage files by name and delete it link-safely after the merge.
- **F7:** `App.companion.mounted.test.tsx` adds a case where Enter calls `session.steer` and Ctrl+Enter calls `session.queue.add`.

One non-blocking note: the capability probe now starts only when a turn goes live. A busy send made before the probe replies queues, with the "unavailable" notice after sending. The message is not lost.
