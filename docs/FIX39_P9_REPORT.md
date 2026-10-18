# FIX39 P9 implementation report

Scope: owner decisions 5 and 6, recommendation 11, and the Working bots addition in `FIX39_DECISIONS.md`. The decisions override the older research. Changes are uncommitted.

## Recommendation 11 and Working bots

- `apps/desktop/src/ui/WorkingBotsPanel.tsx:11`: derives honest task status from side-session state, queued-delegation notices and recorded turns/messages. Supports working, starting, waiting, waiting for approval, limited, done, failed and cancelled. An idle thin snapshot is not reported as completed.
- `WorkingBotsPanel.tsx:25`: elapsed time updates while pending/running and stops at the recorded completion/update time for finished work. Missing timestamps show a dash.
- `WorkingBotsPanel.tsx:37`: collapsible global task list, bot face/name, short task title, status and elapsed time; row opens that exact sub-conversation. Finished tasks sit under collapsed `N finished`.
- `apps/desktop/src/ui/SessionRail.tsx:91` and `App.tsx:2587`: section lives in the right-hand session rail with Environment, Context, Outputs and Changes, including when there is no open conversation. It uses all non-archived side sessions, rather than only the selected bot's tasks.
- `apps/desktop/src/ui/App.tsx:677`: side-conversation activity is visible even when the optional Agent activity switch is off. Existing normalized transcript/reducer paths continue to render bot-to-bot messages, streaming replies and tool changes. Empty running side conversations no longer show the first-run "Ready when you are" screen. The queued indicator describes the global working-slot wait.
- `apps/desktop/src/ui/workingBotsPanel.css:1`: shared semantic theme tokens, quiet rows and no star/sparkle icons; same component in both looks/themes.

Tests: `WorkingBotsPanel.mounted.test.tsx` covers cross-bot rows, faces, elapsed time, working/waiting/limited states, finished disclosure, exact navigation and queued-to-working updates. `busySend.test.ts` covers thin snapshots, completion/failure/approval status and frozen/missing timestamps. `App.agent.mounted.test.tsx` opens the task from the actual session rail, shows sender messages and activity with the experiment off, applies a live tool event and streaming reply, and retains the working indicator. The existing queued-side-conversation test now asserts the global-slot copy.

## Decision 5: new bots start with Full access

- `apps/desktop/src/ui/agentForm.ts:97`: new drafts and provider starters explicitly use `bypass` (the existing protocol value for Full access). Templates retain the draft's permission, so every template inherits this default without overriding a later owner choice. Existing bot drafts retain their saved/inherited modes.
- `agentForm.ts:153`: creation preserves an explicit `null` (the owner's "Use the team default" choice). Duplication also sends an explicit inherited value when the source inherited, preventing the new default from silently escalating a copied bot.
- `apps/desktop/src/ui/FirstRunOnboarding.tsx:37`, `ManagerSetupCard.tsx:24`: Manager setup uses the same creation default. Both screens say "Full access" plainly and explain that team changes still require approval. `App.tsx` no longer forcibly changes the setup draft to Ask first.
- `apps/desktop/src/ui/BlobSettings.tsx:46` and `BotWizard.tsx:92`: creation permission choice and review use the Full access name; the permission description keeps the automation limitation clear.
- `crates/bloblex-daemon/src/main.rs:1715`: the shared new-bot creation helper assigns bypass only when the field is absent. Existing rows are not migrated or updated; explicit ask/auto/bypass/null choices remain intact. `manager.ensure` no longer forces Ask first when creating a new Manager and still returns an existing Manager unchanged.

Only the new-bot default and its associated tests changed in `main.rs`. No turn path, tool routing, automation policy or proposal ceiling changed. Manager proposals already supply their restricted permission explicitly.

Tests: changed failing-first default assertions in `agentForm.test.ts`, `FirstRunOnboarding.mounted.test.tsx`, `ManagerSetupCard.mounted.test.tsx` and `App.agent.mounted.test.tsx`. `busySend.test.ts` checks every template and existing draft preservation. Rust `approval_policy_rpc_defaults_and_rejects_global_bypass` failed on the original Null/Ask default; it now also performs an actual mode change, rather than waiting for an event from a bypass-to-bypass no-op. `new_bot_full_access_default_preserves_existing_and_explicit_modes` checks all explicit modes, inherited null, an existing row and Manager creation; the Manager idempotence test has the new default expectation. Existing automation bypass-clamping and Manager Full access refusal tests passed in the final full gate.

## Decision 6: Steer versus Queue

- `apps/desktop/src/ui/SettingsSheet.tsx:521`: General has "When you send while a bot is working", Steer/Queue choices, one-line behavior explanation and Ctrl+Enter / Command+Enter override. The persistent key is `composer.busySendMode`; default Steer. `settingsIndex.ts` makes it searchable.
- `apps/desktop/src/ui/busySend.ts:1`: shared capability-driven delivery selection. Respects the existing Codex steering gate; a provider/gate without available steering queues with an explanation. Starting/approval states and messages with attachments, commands or references also queue to preserve ordering/context.
- `busySend.ts:10`: a definitive unsupported/conflict refusal or the daemon's stale-steer queue result becomes an explained Queue fallback. An ambiguous provider error is not resent automatically.
- `apps/desktop/src/ui/App.tsx:1803`: main composer honors the preference and keyboard modifier, labels its primary send action, displays effective delivery/fallback copy, and follows settings events. The companion uses the same preference/capabilities and keyboard override. Shift+Enter remains a newline. The existing experimental steering switch's explanation matches the new General control.

Tests: mounted General setting load/save; mounted App sends both preferences and Ctrl+Enter opposites through the existing RPCs. The existing capability-gate test verifies unavailable steering queues and enabled steering calls `session.steer`. `busySend.test.ts` covers delivery selection, context-safe fallback, stale/unsupported steering, and no automatic resend after ambiguous failure.

## Validation

| Gate | Final result |
|---|---|
| `cargo test --workspace --exclude bloblex-desktop --no-fail-fast` | **788 passed, 0 failed, 0 ignored**, including 389 daemon tests and the parent-watchdog integration test. |
| `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` | **Passed**, exit 0. |
| `npx tsc -b --pretty false` | **Passed**, exit 0; also rerun by the production build. |
| `npx vitest run --maxWorkers=3` with the isolation/timeout flags below | **172 files, 1,268 tests passed**, no skips, exit 0. |
| `npm run build` with the isolation flags below | **Passed**, exit 0. Vite reported its large-chunk warning (main JS about 1.28 MB); no build error. |
| `git diff --check` | **Passed**. |

No `src-tauri` or Remote-app code changed, so the conditional desktop-library and remote-build gates were not required. These results do not establish visual/live acceptance.

Gate environment: `CARGO_TARGET_DIR=C:/fxt/a2`, `TEMP=TMP=C:/fxt/a2/tmp`, `RUST_MIN_STACK=33554432` for Rust tests. The final Rust run uses `RUST_TEST_THREADS=3` because other lanes run on this machine. UI uses the requested 3 workers with `--testTimeout=15000` to accommodate shared-machine load. The initial 5-second focused test timed out under load and passed in isolation. The first uncapped Rust run also hit catalog-timing and parent-helper readiness failures; both passed in the final complete run without changing those tests. No test is skipped by these adjustments.

Dependency directories in this worktree are junctions into the main checkout. A temporary Vite config used `cacheDir=C:/fx91/.p9-cache/vite`, disabled Vitest cache and used `--configLoader runner`; npm cache was also inside this worktree. Test invocation added `--config .p9-vite.config.ts --configLoader runner`; build invocation was `npm run build -- --config .p9-vite.config.ts --configLoader runner`. This kept gate cache writes inside the assigned boundaries. The temporary config and diff files were removed after validation; gate logs are retained in `C:/fxt/a2/p9-logs/`. `C:/fx91/.p9-cache/` remains untracked: automatic approval review rejected recursive deletion with "blocked by policy", even after verifying the exact directory was inside this worktree and was not a link. No alternate recursive deletion was attempted.

## Remaining verification

- No browser/native visual inspection in the four look/theme combinations; the Director must inspect layout, truncation, disclosure, focus and narrow rail behavior.
- No real-provider steering/delegation or installed-app interaction. Mounted event tests and existing fake-provider Rust tests are the evidence here.
- P8's actual usage-limit lifecycle must be checked after merge; the panel already recognizes `limited`/`rate_limited` side-session states. P6 queue notices use the existing normalized shape.
- No Remote behavior/default was widened, no new RPC/event was added, and no tiers row is needed.

## File scope

P9's decisions add creation defaults and a General setting beyond recommendation 11's original App/conversation/selectors list. The minimal additional production files are: `agentForm.ts` (shared creation/default serialization), `FirstRunOnboarding.tsx`, `ManagerSetupCard.tsx`, `BlobSettings.tsx`, `BotWizard.tsx` (creation/default copy), `SettingsSheet.tsx`, `settingsIndex.ts` (preference/search), `SessionRail.tsx` (panel slot), and new `WorkingBotsPanel.tsx`, `workingBotsPanel.css`, `busySend.ts` (isolated presentation/delivery helpers). Associated mounted/unit tests changed or were added; `approvalModes.mounted.test.tsx` only follows the revised permission description. `main.rs` edits are restricted to new-bot/Manager creation defaults and directly associated tests. No changes to `team.rs`, `proposals.rs`, storage, adapters, Tauri, Remote policy, DESIGN/PRODUCT/notices, other documentation, installed Bitbots or its data.

Work stayed in `C:/fx91` and `C:/fxt/a2`. The only process manually stopped was the hung P9 test binary from this Cargo target, after checking its exact executable path and parent PID. No commits were made.

## Follow-up (audit)

Findings F1 to F7 from `docs/FIX39_P9_AUDIT.md` are applied. I took over the uncommitted P9 work and changed nothing that the audit did not ask for. F1 was done first with tests that fail on the old code.

- **F1 (must fix) — unhydrated side sessions no longer show as active "Waiting" tasks.** `WorkingBotsPanel.tsx:21` returns the sentinel `'Loading'` for a row with `turns === undefined && messages === undefined`, and `WorkingBotsPanel.tsx:47` filters those rows out, so they are not counted as active or finished, show no elapsed time and start no 1 s timer. A thin row whose `state` is itself live (`limited`/`rate_limited`, `waiting_permission`, `starting`, busy, `queued`/`waiting`) still shows that real status. "Never claim Done on a thin snapshot" is kept. Failing-first evidence: with the old code restored, `busySend.test.ts` "treats an idle thin snapshot as not yet known" failed (`expected 'Waiting' to be 'Loading'`) and the new `WorkingBotsPanel.mounted.test.tsx` case failed (`expected <section …> to be null`).
- **F2 — any terminal non-`completed` turn state maps to `Failed`.** `WorkingBotsPanel.tsx:24` treats a last turn whose state is neither `completed` nor `working` as a failure, after `cancelled` is handled separately. Failing-first: "treats any other finished turn state as a failure" failed on the old code (`expected 'Waiting' to be 'Failed'` for `timeout`).
- **F3 — a finished task's elapsed time is frozen on the turn's `completedAt`.** `WorkingBotsPanel.tsx:35` no longer falls back to the mutable `session.updatedAt`; a missing `completedAt` shows `—`. Failing-first: the elapsed test failed on the old code (`expected '2m 0s' to be '—'`).
- **F4 — the pre-send "Steering is unavailable" line is gone.** `App.tsx:2533` (main composer) and `App.tsx:3709` (companion) now render the explanation only from `deliveryNotice`, i.e. after a send actually queued on the fallback; before sending they show just "Queue · sends after this turn" or "Queue after this turn". The `App.agent.mounted.test.tsx` steer gate test now asserts no `.composer-send-reason` while steering is unavailable and unsent, and that it appears (with "Steering is unavailable") after the queuing send.
- **F5 — the capability probe runs only for a live session.** `busySend.ts:23-26` adds `steerRuntimeId(state, runtimeId)`, and `App.tsx:689` and `App.tsx:720` pass `undefined` unless the session is `working`, `starting` or `waiting_permission`. The companion inherits the same gate, so no `runtime.capabilities` call happens per state change for idle sessions.
- **F6 — tidy.** `.p9-cache/` was left untracked and untouched (no staging; no commit was made). `docs/FIX39_AUDIT_IMPL_BRIEF.md` (line-ending-only change) was reverted with `git checkout --`, so it no longer appears in `git status`. `.composer-send-mode`/`.composer-send-reason` moved from `workingBotsPanel.css` to `shell.css:260-261`, next to `.composer-wrap`.
- **F7 — companion Steer/Queue test added.** `App.companion.mounted.test.tsx` gains "steers or queues from the companion with the preference and Ctrl+Enter": with Steer the default and the Codex-style capability enabled, Enter calls `session.steer` and Ctrl+Enter calls `session.queue.add` for the companion session. The Rust default test needed no change (audit found no finding there).

### Gates (rerun after the fixes, `TEMP=TMP=C:/fxt/a2/tmp`)

| Gate | Result |
|---|---|
| `cargo test --workspace --exclude bloblex-desktop --no-fail-fast` (`CARGO_TARGET_DIR=C:/fxt/a2`, `RUST_MIN_STACK=33554432`, `RUST_TEST_THREADS=3`) | **788 passed, 0 failed** |
| `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` | **Passed**, exit 0 |
| `npx tsc -b --pretty false` | **Passed**, exit 0 |
| `npx vitest run --maxWorkers=3 --testTimeout=30000` | **172 files, 1272 tests passed**, exit 0 |
| `npm run build` | **Passed**, exit 0 (Vite large-chunk warning only) |
| `git diff --check` | **Passed** |

UI gates used a temporary `apps/desktop/.p9-vite.config.ts` with `cacheDir=C:/fxt/a2/p9-cache/vite`, removed after the run; logs are retained in `C:/fxt/a2/p9-logs/`. `C:/fx91/.p9-cache/` was not read, written or deleted. No Rust file was changed by this follow-up, so the Rust gates confirm the existing uncommitted `main.rs` changes still pass rather than testing a new diff.

### Still not checked

- No visual inspection in the four look/theme combinations or the narrow rail; the Director still owes those, plus the live Codex steer check after merge.
- The companion Steer/Queue test is mounted (fake RPC); no real-provider steering was exercised.
- File scope of the follow-up: `WorkingBotsPanel.tsx`, `busySend.ts`, `App.tsx`, `shell.css`, `workingBotsPanel.css`, `busySend.test.ts`, `WorkingBotsPanel.mounted.test.tsx`, `App.agent.mounted.test.tsx`, `App.companion.mounted.test.tsx`, and the `docs/FIX39_AUDIT_IMPL_BRIEF.md` revert. No new file outside the P9 list. No commits were made.

