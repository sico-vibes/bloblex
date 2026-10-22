# Live development review, 20 October 2026

> **What this is:** the implementation and verification report for the owner's seven screenshots and later two-theme decision.
> **Status:** development changes on `codex/bitbots-live-fixes`; no release published
> **Last updated:** 2026-10-21

## Result

The native development app runs the real daemon and installed CLIs with Vite updates. It uses a separate database and keeps the installed app running separately. The main development window is labelled **Bitbots Development**. The owner chose this Codex session for implementation; no implementation agents, commits, pushes or releases were used.

Only **Bitbots** and **Blobots** remain as app themes. Pop, Dot and Legacy registrations, stylesheets, material orbs and automatic theme fonts were removed. Cached and database selections migrate to Bitbots; old backup selections normalize during import. Bots and conversations are retained. Historical release records still describe the old themes.

## Screenshot checklist

| Request | Change and evidence |
| --- | --- |
| Settings loading | Row-shaped placeholders built with the shared Skeleton, accessible loading status and reduced-motion support. |
| Update notice | Download, ready and error states live above the profile in the left sidebar, including when no conversation is selected. Ready shows target and installed versions. Mounted tests exercise narrow widths and restart action. |
| First click on a bot with no conversation | Runtime echoes no longer change bot selection. Native verification selected Fresh bot once and kept it selected after an old runtime echo. Existing companion round-trip regressions still pass. |
| Links open externally | The native opener now has an explicit HTTP/HTTPS URL scope. A native call successfully opened the repository in the system browser; unsafe schemes and credential-bearing URLs remain refused. |
| Repository link formatting | Bare GitHub repository URLs render as named repository links in user and assistant messages, without fetching third-party metadata. User-bubble links inherit the bubble foreground. |
| Pasted images | Ctrl+V also handles WebView2 cases without a DOM paste event; duplicate DOM/native reads are invalidated. A generated PNG passed through the native clipboard reader and appeared as a ready thumbnail. A separate real Codex turn identified the generated image as red: 5/5 live checks passed. |
| Side-chat header | Removed the permission control from beneath the header; the header is centred. A real Codex-to-OpenCode bot exchange completed and supplied a real side-conversation for verification. |
| Dark bot mentions | Mention and side-header text mixes toward the surface foreground. A native black-bot mention rendered with a readable light foreground. |
| Profile menu dividers | Separator spans are block elements with a visible line and retained height. Native rendering verified. |
| Look picker | Two circular orbs only, Bitbots then Blobots, with names on hover/focus. The later owner instruction supersedes the original five-orb request. |
| Art picker | Automatic plus 3D robot, 2D robot, Glossy and Hand-painted. Flat/Dot robots are absent from the picker; saved ids resolve to 2D robot. The 2D renderer reads the same four outline and colour controls as 3D. |
| Hand-painted animation | Large avatars follow the pointer and blink; bodies stay still. Mini avatars do not subscribe to pointer events. Tests cover tracking, unmount cleanup and reduced motion. |
| Finished task rows | Status and elapsed time share the name line, with the task title beneath. Finished and Working bots use the same chevron and typography. |
| Permanent bot deletion | Separate Delete bot action, explicit cascade warning and hold-to-confirm. `agent.purge` requires confirmation, refuses locked bots, the Manager and active related conversations, and deletes owned/peer side-conversations atomically. It also removes related automations and private memory, including memory history/search records. Project files, unrelated bots and provider-owned history are retained. Backend tests cover refusal without partial deletion and preservation of unrelated conversations. Native verification refused an unconfirmed request and deleted only the disposable test bot. |
| Archive recovery | Archived bots is available in the profile menu. Restoring the disposable archived example through the native UI succeeded. |
| Contrast | Native captures and computed-colour checks cover Bitbots and Blobots in dark/light. Selected text, inline code and fenced code passed 4.5:1 checks. The retired themes no longer require maintenance. |

## Development workflow repairs

- `scripts/dev-windows.ps1` now defaults the daemon database to `<CARGO_TARGET_DIR>/dev-data/bloblex.db`, retains explicit overrides, and gives the main window its development title.
- Development skips migration of the installed shared store and its autostart entry.
- The live composer probe launches a private executable copy so it cannot lock Cargo's build output.
- Settings page navigation now passes the requested page through the native command; it no longer depends on an ungranted renderer event permission.
- Startup reads recover once after a stopped/restarted loopback connection. The retry allowlist excludes prompts, settings writes, deletion and shutdown. The rebuilt native window started without its previous warning; its composer was ready. Startup diagnostics preserve native string errors and show the failed step while hiding transport URLs.
- The service-worker test compares its precache with the emitted files, replacing an arbitrary asset-count assertion invalidated by removing unused theme/font chunks.

## Verification

- Typecheck passed.
- Frontend suite: **1,364 tests passed in 181 files** after the two-theme change.
- Rust workspace tests: **882 passed**; daemon **457** and storage **120** are included. The native desktop library separately passed **64** tests.
- Workspace Clippy with warnings denied passed.
- Main and remote production bundles built successfully.
- Design scan: no errors; six warnings in existing motion rules, retained without an unrelated motion redesign. React component review checked effect cleanup, state handling and accessible controls.
- A fresh read-only CLI catalogue check on 21 October returned 12 Claude models, 7 Codex models and 39 OpenCode models; all three runtimes reported authenticated.
- Native development verification used the real WebView, daemon, local clipboard, external opener and provider CLIs. Captures from the fixture preview were not used as proof of CLI work.

## Limits

Development builds do not install application updates. The notice and restart wiring were tested with controlled update states; an actual download/install round trip was not performed or claimed. OpenCode image blocks are gated by its advertised ACP image capability; a model must also support vision. The real image-understanding check used Codex.

The installed app may retain the global companion shortcut while both instances run. This does not prevent opening the development companion with its sidebar control. The development database and test project are separate from the installed store and the main checkout. The Zen skill was installed for Codex and the Bitbots skill was updated with the new rules and root causes.
