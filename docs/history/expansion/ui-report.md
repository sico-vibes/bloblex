# UI lane pause report

> **What this is:** the UI worktree's paused implementation and verification state for the accepted Bitbots expansion.
> **Status:** historical record, superseded in part (see update); implementation paused by owner on 21 October 2026
> **Last updated:** 2026-10-22

**Update 22 October 2026.** The owner resumed the expansion on 21 October 2026. The board, tree and timeline UI is merged to `main` at `26ec193`, with its status in [status.md](../expansion-v2/status.md). The UI worktree below is the pause-time record. Its tests and screens are not a check of `main`.

## Context

The UI lane is frozen in `C:\Users\SicoZ\.codex\worktrees\bitbots-ui\Blolblex`, detached at `64344a6` (`beta.36`). Its changes are uncommitted and have not been consolidated into the main checkout. Do not describe the UI implementation as complete or native-verified. The owner authorized only documentation, picture capture and generated-docs work after the pause.

The desktop fixture preview remained open at `http://127.0.0.1:5174/?preview=1` in exec session `39519` during documentation capture. Do not stop or restart it. Screenshots in `docs/library/assets/expansion-2026-10-21/` are from this fixture preview and synthetic fixture data; they are not native app or live-provider evidence.

## Current UI state by accepted feature

| Feature | Frozen UI state | Evidence boundary and next step |
|---|---|---|
| Task board | Delegate board has an unassigned stack on the left, bot lanes on the right, drag and keyboard dispatch, queue controls and inspector. | 12 mounted tests passed before the last inspector-selection source patch. Board screenshots at 1440 and 1000 are synthetic fixture captures. Re-run after unpause and reconcile against the merged daemon contract. |
| Objective tree | Task cards follow parent-child tasks with connectors, collapse state and conversation links. | Screenshot is synthetic. Mounted tree test passed before the last source edits. No daemon integration or native review. |
| Timeline | State bars derive from paired observed run transitions, per-run assignee snapshots, retry attempts, handoffs and a selected time range. | Screenshot is synthetic. Mounted timeline test passed before the last source edits. Missing-history and timing behaviour need review against merged events. |
| Schedules and supervision | UI includes policy selection, task overrides, caps, global pause/concurrency, schedule template, preview and pause/resume controls. | Not independently validated against the final scheduler implementation. No native review. |
| Terminal | xterm tabs and native PTY bridge wrappers cover output, resize, search, copy/paste, interrupt, hidden dock persistence and close-live confirmation. | Two mounted tests passed before final edits. Platform reported ConPTY and native validator tests, but UI has not been reviewed in a production WebView. The saved main-shell screenshot has no terminal dock; a terminal-specific capture was not obtained. |
| Chat background | Appearance preferences include image scope, five effects, separate opacity controls, preview and transform worker. Native selection/import/read/clear are behind the Tauri bridge; bytes stay local. | Two mounted tests passed before final edits. No current saved screenshot of settings with a real imported image; native image review is outstanding. |
| Providers and onboarding | Cursor and Grok Build display/login/install paths, runtime preference controls and Start free versus existing-plan choice. OpenCode free selection requires `verifiedToolRoundTrip === true`. | The free flow was changed to `platform.setup.free.catalog`, `.check.start` and shared `.status`; final code was not rerun through typecheck. Current integration still needs comparison to the merged setup implementation. No live setup or authenticated tool run is claimed. |
| GitHub inbox | Read-only `gh` inbox with repo/type filters, safe detail links and source-linked unassigned task draft creation. | Two mounted tests passed before final edits. A fixture inbox screenshot was saved. No live `gh` inbox check; connector/API integration remains unverified. |
| Connections | Registry browse, scopes, custom stdio/Streamable HTTP forms, transient secret input, OAuth flow status, named-tool grants, tests and connection management UI. | No mounted test or backend integration is claimed. OAuth UI follows the platform's latest flowId/status/cancel contract but was not recompiled afterward. Platform reports connector and OAuth implementation partial. |
| Computer access | Window selection, action list, per-bot grant/revoke and Stop UI are present. Consent text explains provider-bound screenshots. | No mounted test or backend integration is claimed. **Known contract mismatch:** UI currently calls `platform.computer.grant`; task lane says its method will be `platform.computer.grants.grant`. Fix only after implementation resumes and exact DTO is published. |
| Relay and remote tasks | Remote settings include a Relay panel and QR/pairing controls. PWA includes stacked read-only tasks and run details. Remote tiers explicitly allow viewer reads and forbid writes/native methods. | One PWA mounted test and remote bridge parity tests passed before final edits. Platform says relay remains a crypto core, not a complete pairing/gateway/browser path. No phone, pairing, E2EE or native UI validation. |

## Changed paths in the UI worktree

Modified tracked paths:

- `apps/desktop/package.json`, `package-lock.json`, `apps/desktop/src/main.tsx`
- `apps/desktop/src/preview/fixtureBridge.ts`
- `apps/desktop/src/remote/RemoteApp.tsx`, `apps/desktop/src/remote/remoteContract.ts`, `apps/desktop/src/remote/remoteTauri.ts`, `apps/desktop/src/remote/tiers.json`
- `apps/desktop/src/tauri.ts`
- `apps/desktop/src/ui/App.tsx`, `AppearancePage.tsx`, `BlobSettings.tsx`, `FirstRunOnboarding.tsx`, `NativeRemote.tsx`, `RemoteSettings.tsx`, `SettingsSheet.tsx`, `SignInHelp.tsx`, `agentForm.ts`, `providerBrand.tsx`, `settings.css`, `settingsIndex.ts`, `shell.css`, `signInHelp.css`
- `docs/legal/third-party-notices.md`

New paths:

- `apps/desktop/src/remote/RemoteTasks.mounted.test.tsx`, `RemoteTasks.tsx`, `remoteTasks.css`
- `apps/desktop/src/ui/ChatBackground.mounted.test.tsx`, `ChatBackground.tsx`, `ComputerAccessPage.tsx`, `ConnectionsPage.tsx`, `GitHubInboxPage.mounted.test.tsx`, `GitHubInboxPage.tsx`, `RelaySettings.tsx`, `RuntimePreferencesPanel.tsx`, `TeamWorkPage.mounted.test.tsx`, `TeamWorkPage.tsx`, `TerminalDock.mounted.test.tsx`, `TerminalDock.tsx`
- `apps/desktop/src/ui/chatBackground.css`, `chatBackgroundPrefs.ts`, `chatBackgroundTransform.ts`, `chatBackgroundWorker.ts`, `computerAccess.css`, `connections.css`, `gitHubInbox.css`, `relaySettings.css`, `teamWork.css`, `teamWorkTypes.ts`, `terminalDock.css`
- `docs/history/expansion/ui-report.md`, `docs/history/expansion/ui-targeted-tests.log`

## Verification record

The following are the last completed checks before the owner paused implementation. They ran on the frozen UI worktree before the final source edits listed below:

- `npm run typecheck` passed. A later typecheck found only unused `oauthUrl` state; it was removed, but typecheck was not run again after the subsequent OAuth and inspector changes.
- `npx vitest run apps/desktop/src/ui/TeamWorkPage.mounted.test.tsx apps/desktop/src/ui/TerminalDock.mounted.test.tsx apps/desktop/src/ui/ChatBackground.mounted.test.tsx apps/desktop/src/ui/GitHubInboxPage.mounted.test.tsx apps/desktop/src/remote/RemoteTasks.mounted.test.tsx apps/desktop/src/preview/fixtureBridge.parity.test.ts apps/desktop/src/remote/remoteTauri.parity.test.ts` passed 26 tests across 7 files. Output is in `ui-targeted-tests.log`. This run preceded the OAuth-flow, inspector-selection, and task/computer contract amendments; it does not validate them.
- `npm run build` passed before those final edits. Vite reported a mixed static/dynamic import warning for `tauri.ts` and a main bundle above its 500 kB advisory threshold.
- `npm run build:remote --workspace @bloblex/desktop` passed before those final edits.
- Browser capture of the synthetic desktop preview completed for the task board in all five looks and both dark/light themes at 1440 px, plus Frost at 1000 px; the tree, timeline and schedules views were also captured at 1440 px. These are documentation pictures only, not a full visual acceptance matrix or production UI run.
- Additional fixture screenshots were saved for chat-background settings, provider settings, onboarding provider choice, GitHub inbox, Connections, Computer, Remote settings and the PWA's initial pairing screen. The PWA task list and an enabled Relay panel were not captured. A failed terminal toggle lookup produced a main-shell screenshot with no dock, explicitly named to avoid implying terminal evidence.
- The browser showed the shell, synthetic task data, board layout and objective/timeline screens. All screenshot files are enumerated in `docs/library/assets/expansion-2026-10-21/` in the main checkout; their detailed side-by-side captions are in `docs/library/content/guides/expansion-handoff.md` there.
- The generated docs page was opened from the local docs server at `http://127.0.0.1:5205/#guides/expansion-handoff`; the UI, dedicated sidebar entry, plan/report links and embedded original/current images rendered. Saved rendered-page screenshot: `docs/library/assets/expansion-2026-10-21/current-handoff-page-rendered-offline-1600.png` in the main checkout.
- Main docs gates passed after adding the expansion plan/handoff sources to the catalog: `node scripts/docs-library.mjs build` built 304 documents into `docs/DOCUMENTATION.html` (26.79 MiB), with 0 unresolved links; `node scripts/docs-library.mjs check` passed, including self-contained image/link checks.
- No live daemon integration run, remote phone test, real provider onboarding, real GitHub request, production native WebView review, or Windows packaged-app test is claimed.

## Peer and platform notes

- The task lane confirmed task dispatch is one `task.dispatch` action with idempotency and version checks; the UI mounted tests cover this before the last edits. Its consolidated contract is in the main checkout at `docs/history/expansion/tasks-contract.md`.
- The platform lane reports PTY targeted tests 6/6, background validator tests 4/4 and runtime-terminal fallback tests 6/6. Its native compile used a substitute frontend directory and was compile-only. Relay is not end-to-end; setup beyond terminal fallback and connector/OAuth APIs remain incomplete. See the platform report and snapshot manifest in `docs/history/expansion/`.
- Before resuming UI integration, reconcile method names and DTOs against consolidated daemon/platform contracts and rerun typecheck, targeted mounted tests, remote policy parity and both builds. Do not take the fixture results as backend success evidence.
