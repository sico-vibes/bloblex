# Bloblex session handoff

Current as of 7 October 2026. The plan is [docs/E2E_PLAN_V2.md](docs/E2E_PLAN_V2.md). Phase status, later work and evidence commits are in [docs/implementation-status.md](docs/implementation-status.md).

## Published (10 October 2026, beta.13)

Everything in the four 10 October sections below shipped as manual-only [v0.1.0-beta.13](docs/releases/0.1.0-beta.13.md): team delegation and projects, plan mode, composer, blob looks, the companion catch-up, sounds, launch, import and the gallery.

- Release commit `1b23d4c` is pushed to `main` and tagged `v0.1.0-beta.13`.
- The unsigned NSIS installer was built in `D:\b13`: 12,900,017 bytes, SHA-256 `de8345bd6e273cda2256aa4ce744ae6b110e78ecbb48402b23fa179495a1f3e6`, `NotSigned`.
- The signed updater feed remains at beta.6.
- The sections below keep their original "Uncommitted" headings as history.

## Uncommitted follow-up (10 October 2026): companion catch-up, sounds, launch, import, gallery

Done directly at the user's request. Not committed.

- **Companion as a mini overview.** The home island shows the focused blob (role chip, leader star, and a team line such as "Waiting on Pololo" that opens the side conversation) beside a team card that groups every blob by project, with live states: waiting for you, working, offline.
  - Chat renders delegation and reply chips, @mentions as face plus coloured name, and proposed plans.
  - Inline questions use the question card in the taller island.
  - Activity lists side conversations.
  - "New session" is now "New conversation".
- **Sounds.** `soundCues.ts` is rewritten as an original synthesized palette for coucou's set of moments, at an audible master volume (0.32).
  - The moments are peek, open, close, hover, blip, tick, send, pop, poke, annoyed, dizzy, love, welcome, work, finish, error, approval, question, approve, gulp and sleep.
  - The reduced-motion mute is removed.
  - Audio unlocks on the first click or key press after enabling.
  - Cues are wired to the island and the character.
  - Coucou's own `.wav` files are all-rights-reserved and are not used.
  - Real audio output was not verified (no audio in the preview tools).
- **Experimental usage bar.** The bottom plan-usage bar is off by default. Settings → General → Experimental has a "Usage bar" switch (`experimental.usageBar`) with a white Experimental tag and a "?" tooltip.
- **Launch.** Checks scroll in a fixed 176px window with faded edges. The mascot shows its working state while scanning, then plays the welcome wave (card-less greeting scene, hands included) before the app opens; a click skips it.
- **Import.** The import dialog previews the blob (its look and colour, description, model, effort, approvals, instructions size) and offers coding agents as radio cards.
  - Fixed: the import and bypass-confirm dialogs never received `is-entered`, so they rendered at opacity 0.
- **Web preview.** `/gallery.html` frames launch (including a live scan-then-wave run), the companion (compact, overview, chat, activity, settings), import, settings and the character sheet. Preview-only URL switches: `?companion&mode=home&view=chat`, `?preview-import`, `?preview-settings` and `launch-preview.html?fixture=live`. These are gated by `previewMode`, which is false in the real `tauri.ts`.
- **Evidence.** Desktop typecheck, 366/366 Vitest and the production build pass. The surfaces were checked in the browser preview. The native windows and real sound output are not verified.

## Uncommitted follow-up (10 October 2026): blob looks replace outfits

Done directly at the user's request, on top of the team follow-up below. Not committed.

- **Outfits are removed.** Hats, glasses, the wardrobe grid and the wardrobe drawing are gone. The legacy `agents.outfit` column and its migrations stay in storage untouched, but no UI reads them.
- **Looks.** Blobs now take a look: one of ten silhouettes (round, organic, boxy, capsule, nub, cloud, droplet, hexagon, sun, triangle), a seed, and optional pinned trait positions.
  - The geometry is adapted from MIT-licensed blobatar (`apps/desktop/src/blob/look/`, credited in `THIRD_PARTY_NOTICES.md` and under the shape picker). It covers seed hashing, the trait reader, the silhouettes and the eye fitting.
  - Outlines are sampled into canvas point lists so the existing engine still drives all the motion on every shape: states, blink, gaze, squash, emotes, badges, particles and the mailbox morph.
  - Eyes are blobatar superellipses turned across each shape's face ellipse. Round and organic bodies roll by turning their face; the other shapes rotate as a whole. Dark bodies get light eyes.
- **Mascot.** `MASCOT_LOOK`, a round body with tall eyes, is used wherever no blob is involved: onboarding, the launch intro and the welcome wave, which keeps its hands. A blob with no stored look is a round blob seeded by its id.
- **Storage.** `ensure_team_schema` adds a nullable `agents.look` JSON column. It is validated as a known shape, an optional seed of up to 80 characters, and up to 48 trait keys with values in [0, 1]. It is returned on every agent row and accepted by `agent.create` / `agent.update`. Export/import carries `look`; older files import as round.
- **Editor.** The blob page's Look card has two halves.
  - A stage on the left with mood previews (Idle, Working, Thinking, Asking, Done, Asleep), plus Shuffle and Surprise me.
  - Tabs on the right. "Shape & colour" shows ten live shape tiles and the swatches. "Fine-tune" shows the shape-specific body and eye sliders, with per-slider reset and Reset tweaks.
- **Sidebar.** The role chip now sits right after the name. The leader badge is an orange disc with a white star at the avatar's bottom-right.
- **Evidence.**
  - Desktop: typecheck, 360/360 Vitest and the production build pass. New tests: `look.test.ts` (eye containment over 600 shape/seed pairs, determinism, mascot proportions, normalisation) and `LookEditor.mounted.test.tsx`.
  - Rust: the offline workspace tests pass, including a storage look test.
  - Preview: checked every shape across idle, asleep, asking and the file-drop states, plus the editor, the companion island and the welcome wave.
- **Not verified.** The native window.
- **Follow-up tweaks** (same day, after user review):
  - **Fixed footprint.** Body size, proportion, squareness, capsule height and droplet tip are fixed presets; their sliders are gone. Every silhouette is scaled so its furthest point sits on the same radius. Eye traits and shape details (petals, puffs, nubs, tilt, corners) still vary by seed and stay adjustable.
  - **Rolling.** "Done" and the triple-poke dizzy spin roll backwards (the face turns over the top) on every shape except boxy, hexagon, sun and triangle, which spin as a whole.
  - **Sidebar.** Avatars are 50px canvases.
  - **Custom colour.** It is a drop swatch that opens a hex popover.
  - **Credit.** It sits centred under the shape grid.
  - **Archive card.** It no longer inherits the settings-card row divider.
- **Second round of tweaks** (same day):
  - **Cat replaces nub.** Cat is the tenth shape, after triangle. It has a wide dome with rounded ears (part of the silhouette), big round glossy eyes with catchlights that stay dark on any body, and pink inner ears. A muzzle, nose, ω mouth and whiskers turn with the face, and it has forehead stripes. Storage validation lists `cat` instead of `nub`.
  - **Delegation chips.** "Messaged X" and "Message from X" are borderless, centred, show the name in the blob's colour, and open the side conversation. The "Show reply" toggle is gone.
  - **Mentions.** `@Name` in your own messages renders as the blob's avatar and name in its colour.
  - **Look stage.** The preview blob is vertically centred.
  - **Full access pill.** It is borderless orange text with an alert icon and no chevron, like Codex.
  - **Custom colour.** The popover is a single compact field: a preview dot that opens the system picker, a `#` prefix and the hex.

## Uncommitted follow-up (10 October 2026): team delegation, projects, plan mode

Done directly at the user's request (no delegation lanes), on top of the composer follow-up below. Not committed. The user said there are no users yet, so old conversation layouts need not be preserved. Usage/quota was deliberately left untouched. Pi/OAuth was dropped: Bloblex keeps running the unmodified CLIs (the t3code-style approach).

- **Team model.** Storage adds a `projects` table and `agents.project_id/role/leader/hidden` through an idempotent `ensure_team_schema` on every open; it is not a numbered migration because the strict migration fixtures downgrade fresh DBs. There is only one leader at a time. Deleting a project makes its blobs casual. A session's `data.link` marks a side conversation (`{kind:'side', peerAgentId, peerName, originSessionId}`), and a message's `data.meta` carries `delegation` / `blob_message` / `blob_reply` / `plan`.
- **Team engine** (`crates/bloblex-daemon/src/team.rs`):
  - Every blob session gets a `<bloblex_team>` system block covering name, role, description, user's profile name or "admin", project or casual, leader, and tool etiquette.
  - It also gets an app-owned MCP server, `bloblexd mcp-bridge` (`mcp_bridge.rs`, stdio MCP that calls `/v1/rpc` `mcp.tools.*` with a per-session capability token in `BLOBLEX_MCP_TOKEN`).
  - `list_blobs` and `message_blob` open or reuse a side session and add a "Messaged X" notice. The teammate's prompt is queued while it is busy. When its turn ends, the reply is relayed as a `[Reply from X]` prompt that wakes the sender. Chains stop after 6 hops.
  - RPCs: `project.*`, `agent.team.update` (a project change archives the main conversation) and `agent.conversation` (one main conversation per blob, created on first open).
  - Workspace: the project folder, else `<data dir>/workspaces/<agent id>`.
- **Plan mode and questions.**
  - Claude: `--permission-mode plan`; `can_use_tool` intercepts `AskUserQuestion` and `ExitPlanMode`; MCP is configured via a private `--mcp-config` file.
  - Codex: `collaborationMode: plan` with `experimentalApi`; `item/tool/requestUserInput`; the `plan` item; `mcpServer/elicitation/request` is auto-accepted for the bloblex server only.
  - OpenCode: ACP mode `plan` plus `mcpServers`.
  - Questions are `permission_requests` with `kind: "question"`, answered through `permission.reply` with an `answers` map and never auto-resolved by policy.
- **Desktop.**
  - The old roster/session tree and project chooser are replaced by `TeamSidebar`. It has search, Pinned, project groups and Unassigned, with drag between groups. Rows show a leader badge, role chip and a live preview.
  - The right-click menu offers Pin, Move to, Mark unread, Rename, leader toggle, Edit, Duplicate, Export, Copy conversation ID, Delete conversation, Hide/Show and Archive. Project menus offer New blob here, Rename, Change folder and Delete.
  - Chat shows delegation/reply chips. The side-conversation view has an "A ⇄ B" header and Close chat. `PlanCard` offers Approve & build or Keep planning; `QuestionCard` handles inline answers. The composer gains a Plan pill and an @mention picker.
  - Blob settings gain Role, Project and Team leader. The profile name syncs to the daemon `profile.name` setting.
- **Evidence.**
  - Desktop: typecheck, 370/370 Vitest (obsolete roster/tree tests removed; team mounted tests and `teamSelectors.test.ts` added) and the production build pass.
  - Rust: offline workspace tests pass, including a storage team round-trip test and a daemon fake-adapter test of the full leader → teammate → relayed-reply flow (side-session reuse, error results and depth guard).
  - Live (`scripts/live-checks/live-team.mjs`, `live-plan.mjs`, isolated DBs): Codex leader → OpenCode teammate 8/8; OpenCode leader → Codex teammate 8/8; Codex plan mode with a structured question and captured plan 6/6.
- **Not verified.**
  - Claude Code could not be checked live because its CLI sign-in has expired.
  - Native window behaviour.
  - The desktop crate check for this follow-up.
- **Not implemented.** "Replace with different blob", @mention highlighting inside bubbles, and drag-to-reorder within a group.

## Uncommitted follow-up (10 October 2026): composer, outline, plan usage, polish

Done directly in one session at the user's request (no delegation lanes). Not committed.

- Composer footer follows the desktop coding-agent layout: `+` image attach and a per-conversation permission pill (Ask first / Auto / Full access, with a confirm for full access) on the left; model pill (menu with a Fast mode toggle), effort pill (compact slider popover; knob rests on the provider default) and a small context ring on the right. The ring's popover adds this provider's plan limits.
- Daemon: `session.model.update` accepts optional `serviceTier` and `approvalMode` pins stored in the session lock (absent keys keep the current value, null returns to the blob setting; omitted `model`/`thinking` now mean unchanged). Claude fast mode comes from the catalog's `supportsFastMode` and is applied as `--settings {"fastMode":true}`; Codex uses its catalog Fast tier. Sign-in failures in turn errors now name the CLI to sign in to.
- Images: the desktop stages pasted/picked/dropped images (scaled to a 2048px long edge) via the `stage_prompt_attachment` Tauri command into `%LOCALAPPDATA%\Bloblex\attachments` (30-day prune). `session.prompt` takes `attachments: [{path,name}]`, re-checks signature/size (PNG/JPEG/GIF/WebP, ≤10 MB, ≤8), persists names in `messages.data`, and sends Claude base64 image blocks over stream-json and Codex `localImage` items. OpenCode rejects attachments before delivery.
- Conversation outline is a fixed-pitch tick rail with a preview card; plan usage is a bottom status bar plus a Usage popover with per-provider flyouts; the Usage sheet lists plan limits above token usage. Blob editor appearance has Colour/Outfit sections with card tiles; archive and hold-to-delete dialogs were redesigned.
- Evidence: desktop typecheck, 377/377 Vitest, production build, offline Rust workspace tests and the desktop crate check (short-path worktree) passed. `scripts/live-checks/live-composer.mjs` ran against the installed CLIs with an isolated DB: Codex 0.161.0 identified a red test image and OpenCode 1.18.35 rejected the attachment; Claude Code 2.1.296 could not run because its own CLI sign-in has expired (fails identically outside Bloblex), so Claude image delivery and Claude fast mode remain live-unverified. Native window behaviour is unverified.

## Published follow-up (8 October 2026, beta.12)

Dictation gains a floating always-on-top bubble rendered in its own `dictation` window, adapted from the Waveora bubble without its logo. It shows a live waveform driven by a throttled microphone-level event, a processing spinner, and an error state, and supports hold-to-drag and tap-to-focus. Synthesized Web Audio cues (record start, processing start, processing finish, error) are ported from Waveora; no audio assets are bundled. Rust picks the surface: the bubble when the companion is hidden, or a full-cover companion listening wave when it is visible, so one surface shows visuals and plays sounds. Release commit `6662b14` is pushed to `main` and tagged `v0.1.0-beta.12`. All 361 desktop tests, typecheck/build, the offline Rust workspace suite (including the `bloblex-speech` unit tests), and the unsigned NSIS bundle passed; the installer is 12,719,309 bytes with SHA-256 `1b3aff43ad1a150eb3b3977231bd6024e74151bb36db50f49664e274a01830cb`. [Beta.12](docs/releases/0.1.0-beta.12.md) is published with the installer and checksum; the signed updater feed remains at beta.6. Live microphone capture, real model inference, and native/live interaction remain unverified; see [the evidence and limits](docs/evidence/dictation-bubble-2026-10-08.md). Local preview artifacts remain untracked.

## Published follow-up (8 October 2026, beta.11)

On-device dictation is added on a new `bloblex-speech` crate: a sherpa-onnx engine with cpal microphone capture, a pinned Hugging Face model catalog with per-file SHA-256 verification and resume, 16 kHz mono resampling, bounded offline chunking, an owner-locked session lifecycle, and a warm decode worker that releases the model after two idle minutes. The desktop exposes Tauri dictation commands and events, the main and companion composers show a live provisional transcript, Ctrl+E toggles dictation globally, and Settings gains a Speech model manager. Release commit `2d3f16d` is pushed to `main` and tagged `v0.1.0-beta.11`. All 361 desktop tests, typecheck/build, the offline Rust workspace suite (including 19 speech unit tests), the `native` desktop check, and the unsigned NSIS bundle passed; the installer is 12,709,185 bytes with SHA-256 `dabeb15e800bc2efc97f9175eede1ac772de254f389e8102ea26892eede024b9`. [Beta.11](docs/releases/0.1.0-beta.11.md) is published with the installer and checksum; the signed updater feed remains at beta.6. Live microphone capture, real model inference, and native/live interaction remain unverified; see [the evidence and limits](docs/evidence/dictation-2026-10-08.md). Local preview artifacts remain untracked.

## Published follow-up (7 October 2026, beta.10)

Composer controls now use source-derived reference motion and real advertised effort levels, a compact reported-context ring, paired-message outline previews and an async hold-to-delete success morph. The daemon fixes initial agent-option lookup, updates after completed turns, context reset ordering/fresh-context resets, and stale resume/turn lock races. Feature commit `146db44` and release source `4aa48f4` are pushed to `main`; the source is tagged `v0.1.0-beta.10`. All 361 desktop tests, typecheck/build, full offline Rust workspace tests from `D:\b10` with live smoke disabled, and the unsigned NSIS bundle passed. [Beta.10](docs/releases/0.1.0-beta.10.md) is published with the installer and checksum; the signed updater feed remains at beta.6. Source ports retain intentional metadata/theme/RPC differences; see [the evidence and limits](docs/evidence/composer-controls-2026-10-07.md). Native and real-provider behavior remains unverified. Local preview artifacts remain untracked.

## Current uncommitted follow-up (6 October 2026)

The active scope adds lazy session resume before a prompt is persisted, provider-reported title updates from Codex/OpenCode with explicit rename precedence, persisted provider-reported context and a session-scoped model/effort lock with confirmation on model changes. Claude title updates are not available from the structured stream used by Bloblex; the read-only public-source audit does not establish that `-p --session-id` sessions reliably appear in Claude's session index, so Bloblex keeps its current title rather than reading transcripts or deriving one from prompt text. Claude context uses the latest assistant call's usage paired with that result's matching `modelUsage.contextWindow`; Codex uses current-turn `last.totalTokens` plus optional `modelContextWindow`; OpenCode uses ACP `usage_update` used/size. Individually reported fields can appear on their own, but a percent is displayed only when both used tokens and window size are present; unknown values remain unknown.

The composer now has separate model and effort controls. A changed model requires a warning confirmation; the stored session lock is used on later turns and resume. The message outline uses actual conversation messages and keyboard navigation; conversation deletion uses a hold-to-confirm dialog while retaining cancel/Escape behavior. Focused fake/in-memory and mounted checks have been added. The desktop native window and real provider sessions for these new paths remain unverified; do not point development or tests at the user's database.

Current worktree follow-up: usage is reported-token analytics plus account quota. Active budget admission/warnings and monetary valuation, pricing and subscription UI are retired; migration 10 adds only a quota cache and preserves all existing usage, valuation, pricing, subscription and budget records. Codex quota uses the structured `account/rateLimits/read` app-server method matched against the checked-in Codex 0.159.3 schema. Claude Code quota reads only the access token from the existing Windows `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) and calls Anthropic's OAuth usage endpoint; it never refreshes or writes credentials. OpenCode Go quota reads `OPENCODE_API_KEY`, then an existing `opencode-go` entry from OpenCode `auth.json` or its credential SQLite DB opened read-only/query-only, and calls the OpenCode Go usage endpoint. Generic OpenCode provider usage is not presented as account quota. All three sources emit normalized quota fields only; credentials and raw provider payloads are not persisted, logged, or sent to the UI. Fake credential/API response tests cover source parsing, field normalization, status classification, and secret exclusion. An isolated daemon quota check succeeded with Claude Code 2.1.291, Codex codex-cli 0.160.1, and OpenCode 1.18.34. It used a temporary `BLOBLEX_DB_PATH`, sent no prompts, and did not open the user's database. The sanitized output and docs retain provider/status/window presence only, with no percentages or reset times. Normal cache behavior wrote normalized quota snapshots to the ignored isolated scratch DB at `target/provider-quota-live-smoke/quota.db`; it contains no credentials or raw provider payloads and remains because cleanup was blocked. Native UI behavior remains unverified. The earlier isolated live Claude turn remains the only live provider-turn proof.

`v0.1.0-beta.9` is published as a manual-only unsigned GitHub release; `main` includes its source and release documentation. It contains the 6 October conversation follow-up plus beta.8's usage and quota work. The signed updater feed remains on beta.6. Desktop tests (326), typecheck, production build, full offline Rust workspace tests, daemon cargo check, and the unsigned NSIS bundle pass. Rust tests and the bundle use a short-path checkout because Windows `rc.exe` misparses this repository's apostrophe-containing path. Native chat interaction, clean-machine install, and live provider verification of this follow-up remain unverified.

The recovered Claude UI, daemon, and wardrobe scope is released as `v0.1.0-beta.6` from branch `beta/claude-resume-2026-10-04`. See [the release notes](docs/releases/0.1.0-beta.6.md) and [implementation status](docs/implementation-status.md). The release feed is published, but a native-window or installed upgrade check remains open.

## What exists

Bloblex is a Windows desktop app: a React/Tauri shell (`apps/desktop`) and a separate daemon (`bloblexd`) that owns sessions, permissions, token usage and normalized quota state. The shell and the companion read the daemon's normalized state. Provider CLIs (Claude Code, Codex, OpenCode) keep their own login.

On main:

- Plan phases 1–6 and 2b: logo, capability record, persisted blobs and the editor, the project/session tree, execution options and adapters, usage analytics, settings with ask / auto / bypass approval modes.
- Auto-update from GitHub releases (stable and beta channels, signed NSIS updates) and the release script; see [docs/UPDATER.md](docs/UPDATER.md) and [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).
- The interface redesign: chat-style main window, one-page blob editor, custom dropdowns, blob moods that settle over time, favourites and pinned conversations/projects, companion launch with the full welcome.
- Conversation management: unread markers, Windows notifications, rename/archive/delete (migration 6), grouped tool activity, Start with Windows.
- Honest model lists: catalog source and update time, suggestions vs validated lists, display names, default marker and family groups.
- Token analytics with no monetary valuation, plus a compact quota row and an extended Usage sheet. Codex, Claude Code OAuth plans, and OpenCode Go have separate normalized quota sources; generic OpenCode providers are omitted. Isolated daemon fetches have been verified for Claude Code 2.1.291, Codex codex-cli 0.160.1, and OpenCode 1.18.34; native UI behavior remains unverified.
- Markdown export of a conversation, export/import of a blob setup.
- Batch B: Ctrl+K quick switcher, composer model and thinking switch, safe Markdown, unified diff view and approval shortcuts. The companion uses the same approval card.
- Batch B1: one shared Codex app-server or OpenCode ACP process per runtime key, per-session queues that coalesce streaming deltas only, idle shutdown, crash restart and resume, and bounded per-session cancel. Claude Code remains one process per session.
- Batch C: first-run setup on an empty install, companion start position and Ctrl+Alt+B hotkey, system/dark/light themes and text size, and reorderable favourites and pins. A contrast test checks the light theme against AA.
- Blob wardrobe: per-blob outfits with seasonal automatic selection, drawn to match the blob and stored by migration 7.
- Launch intro with startup checks, companion off by default with a sidebar toggle and an open-at-startup setting, and three-step first-run onboarding with verified install and sign-in guides.
- Historical OpenCode Go model price catalog and pricing records remain in the database/source tree for history, but are not read by the active usage UI or token recording path.

The beta.7 candidate gates passed before this uncommitted follow-up: `cargo test --workspace`, desktop typecheck, Vitest (341/341), and production build. Those counts do not cover the quota/usage-retirement changes below. One live Claude session returned the expected sentinel after changing the model before the first prompt. That session used an isolated database; the native app's message flow and a clean-machine installer remain unverified.

## Lanes

The Director (orchestrating Claude session) reviews diffs, runs the gates and commits. Implementers do not commit.

| Lane | Role |
| --- | --- |
| `impl` | Codex, production code including Rust |
| `impl-b` | Cursor Grok, used as the independent read-only reviewer of each branch |
| `qa` | OpenCode, research and QA; reports to the Director |

The implementer sandbox cannot spawn esbuild, so the Director runs Vitest and the Vite build. Cursor runs go through `scripts/run-cursor-delegate.ps1`; in read-only mode Cursor has no shell, so give it the diff as a file. Do not edit the user's hooks or settings.

## Build and test

From the repository root, with this checkout's own `node_modules` (`npm ci`; never link another checkout's modules):

```powershell
npm run typecheck
npm test
npm run build
cargo test --workspace
cargo check -p bloblex-desktop --lib
```

The Director's gate output is outside OneDrive at `C:\dev\bloblex-target` (`CARGO_TARGET_DIR`). Review lanes must also use a short `CARGO_TARGET_DIR`; long paths break the Windows linker. `cargo check -p bloblex-desktop` needs the gitignored sidecar binaries in `apps/desktop/src-tauri/binaries` (copy them into a new worktree). Before committing, run the naming check: no third-party product names anywhere in the repo.

Native development, only when a person is ready to launch the app, is `npm run desktop:dev` with an explicit isolated `BLOBLEX_DB_PATH`. See [docs/windows-development.md](docs/windows-development.md). Never point a test or a dev run at `%LOCALAPPDATA%\Bloblex`.

Releases: [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md). The update signing key lives outside the repo and must never be committed.

## What needs the user's native testing (Phase 7)

- Companion transparency, free drag, monitor clamping, DPI, resize timing, and the launch welcome.
- Launch startup checks, companion toggle/open-at-startup behavior, and first-run onboarding on a native install.
- Real file drop, approvals in both windows, tray Pause all, keyboard focus, and reduced motion.
- Notifications, Start with Windows, and the export/import file dialogs.
- Quit and process-tree cleanup; a clean-machine install; code signing.

## Known gaps

- One isolated live Claude daemon turn returned the expected sentinel after changing the model before the first prompt. Separate isolated quota fetches succeeded for Claude Code 2.1.291, Codex codex-cli 0.160.1, and OpenCode 1.18.34. These do not prove native UI behavior; Codex/OpenCode live turns and native behavior remain unverified. Generic OpenCode providers do not have account quota support.
- Codex blob instructions stay thread-level: the installed app-server schema has no per-turn context field.
- Budget admission, budget warnings, pricing/subscription valuation and monetary analytics are retired in the active product path. Existing database history is preserved and no longer presented as current usage.
- The daemon does not emit a `context` failure class; session turn JSON omits `failureClass`.
- WSL.
- Tracked `apps/desktop/tsconfig.tsbuildinfo` is rewritten by `tsc -b`; restore it before committing if it changes.
