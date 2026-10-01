# Bloblex QA acceptance contract

Authority: `Bloblex_E2E_Windows_Desktop_Plan.md`, with the user's 1 October 2026 companion override. The concept image is visual direction, not proof of product functionality.

The CTO/QA agent coordinates two `gpt-6-luna` implementers at High effort and reviews their delivered code. It does not own primary implementation.

## Companion override

Use a rounded bill-shaped floating overlay at bottom center by default, freely draggable. Preserve Coucou-style procedural animation and interaction, using original Bloblex characters. Persist the position, recover off-screen positions, and respect physical versus logical coordinates on multiple displays. The plan's top-edge notch positioning is superseded.

User correction during implementation: the first generic capsule/animation draft is not accepted as Coucou-like. Review the actual Coucou Windows interaction source and adapt its state machine, spring timing, gaze, greeting, hover, poke/annoyed/dizzy and completion reactions to the original Bloblex circle character. Keep the floating capsule reachable while collapsed, reveal activity progressively, and pin an actionable approval until resolved. Record source provenance and mapping. Computer Use/UI testing is deferred until the solid source/build milestone is ready; automated protocol/unit/build checks continue.

## Delivery gates

| Gate | Packages | Required evidence |
| --- | --- | --- |
| Native shell | WP01-03 | React production build and native Tauri build; main plus transparent companion; original Canvas characters; tray, close-to-tray, show/hide, explicit Quit; default placement and dragging |
| Daemon foundation | WP04-06 | Separate `bloblexd.exe`; authenticated user-scoped local IPC; schema migrations; real CLI path/version/capability discovery; snapshots and replay; restart without prompt resend |
| Provider conversations | WP07-11 | Real OpenCode ACP, Codex app-server, Claude streaming sessions; prompt through stdin/protocol; deltas, cancel, supported resume, tools/files, approvals and rejection; truthful incompatibility/errors |
| Usage and pricing | WP12-13 | Persistent raw usage; mutually exclusive cache buckets; model attribution; alias/effective-date tests; unknown price stays unavailable; actual, API estimate, and subscription fee distinct |
| Budget authority | WP14 | Most restrictive applicable policy; persistent reservations and reconciliation; concurrent admission tests; pre-turn block explanation; warnings and reliable live cancellation |
| WSL | WP15 | Distro detection and native/WSL distinction; centralized path mapping including spaces/non-ASCII; safe argument transport; actual integration when usable target distro exists |
| Distribution and hardening | WP16-17 | Bundled daemon/hook; installer build; signing/updater configuration; redacted diagnostics; provider/daemon crash recovery; accessibility and responsive checks |

## Independent review scenarios

1. Fresh launch has no invented conversations, authenticated accounts, connected runtimes, usage, or price.
2. Runtime refresh detects installed binaries but only claims authentication when a provider probe establishes it. Invalid profiles and critical flag overrides fail safely.
3. Create a session with a valid project folder; reject missing paths. Choose an agent by its blob. Prompt produces provider output, not renderer-generated text.
4. Main and companion reflect the same active session and permission. A permission resolves exactly once, and stale/unsupported choices cannot authorize work.
5. Cancel preserves partial history. Provider crash preserves the native session ID. Daemon/UI reconnect restores state and does not replay the prompt.
6. A non-client IPC request cannot mutate state; binding is loopback only. Renderer has no arbitrary shell API, and prompt content is absent from argv.
7. SQLite restart preserves messages, usage, policies, and settings. Repeated events or cumulative usage do not inflate totals.
8. Two concurrent admissions cannot spend the same remaining budget. Reservations release on failure/cancel; scope and period boundaries are tested.
9. Long history and streamed deltas remain responsive. Hidden Canvas renderers pause; reduced-motion users have a usable static rendering.
10. Closing the main window preserves companion and work. Explicit Quit terminates owned processes and does not terminate unrelated CLI processes.
11. Hook unavailable/timeout/oversize failures do not block ordinary CLI use; hook installation previews, backs up, merges only Bloblex entries, and can restore them.
12. Local installer includes all binaries. A successful installer build is not evidence of signing, clean-VM operation, or SmartScreen trust.

## Environment baseline verified by QA

1 October 2026, this Windows workspace: Node 25.8.0; npm 11.11.0; Cargo/Rust 1.94.0; Visual Studio 2022 Community C++ tools; WebView2 154.0.4258.48. Claude Code 2.1.286, Codex CLI 0.159.3, OpenCode 1.18.34 are installed through npm wrappers. Authentication is not established by these version probes. WSL inventory contains `docker-desktop`; no ordinary development distro is yet verified.

## Evidence rules

Record independent commands/results in `qa-report.md` as milestones arrive. A passing build is separate from an end-to-end provider test. Mock fixtures validate parsing and state transitions but do not establish live-provider compatibility. External signing credentials, a fresh Windows VM, alternate DPI/monitor hardware, and unavailable provider accounts must be reported as unverified when unavailable, never marked passed.
