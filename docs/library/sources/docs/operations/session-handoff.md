# Bitbots session handoff

> **What this is:** The session handoff: dated sections, newest first, with the current release and the open items.
> **Status:** historical handoff with dated sections; the current release is v0.1.0-beta.35
> **Last updated:** 2026-10-19

Original status line, kept as written: historical handoff with dated sections, newest first. The current release is `v0.1.0-beta.35` ([docs/releases/0.1.0-beta.35.md](../releases/0.1.0-beta.35.md)), published and tagged at `71475d4` (installer SHA-256 `eb9378c7d797136dbf918b794240aaba414b0f82bc3f52fcf6ea96664bb0cd56`). The previous release is `v0.1.0-beta.34` ([docs/releases/0.1.0-beta.34.md](../releases/0.1.0-beta.34.md)). The "Lanes" section near the end is superseded by the delegation rules in [AGENTS.md](../../AGENTS.md) (16 October amendment: two lanes only). Budget clauses are retired (AGENTS.md, 12 October amendment). Index: [docs/README.md](../README.md).

Current as of 19 October 2026 (FIX40, its follow-ups and FIX41 released as `v0.1.0-beta.35`). The plan is [docs/plans/e2e-plan-v2.md](../plans/e2e-plan-v2.md). Phase status, later work and evidence commits are in [docs/operations/implementation-status.md](implementation-status.md).

## FIX40 looks and bot art (19 October 2026)

**State.** Released as `v0.1.0-beta.35` (tag at `71475d4`), which includes the follow-ups and FIX41 made after `e4cf5b3`. The previous release is `v0.1.0-beta.34`. Full record: [docs/history/fix-40/report.md](../history/fix-40/report.md). Design rules: [docs/design/design-system.md](../design/design-system.md#fix40-looks-and-bot-art-19-october-2026). Pipeline: [AGENTS.md](../../AGENTS.md) (19 October amendment).

**What changed.** Five looks: Bitbots (the Frost look: translucent panels over a wallpaper, with Solid, Balanced and Clear glass), Blobots (unchanged), and Legacy, Pop and Dot under "More looks". The old pixel look is Legacy. Users already on `bitbots` now see Frost. There are 24 bundled fonts, loaded lazily. Each bot picks one of six art styles, and hand-painted blobs have twelve shapes. Settings > Appearance is rebuilt, with one orb per look, and the launch greeting shows each bot in its art.

**Gates on `e4cf5b3`.** Typecheck clean. Vitest 1,341 tests in 178 files passed. `vite build` passed. `cargo test`: bloblex-daemon 456, bloblex-storage 119, bloblex-desktop library 63 passed. The desktop crate must be built from a short path, not the apostrophe path.

**Not verified.** Native windows (browser preview and unit tests only), real provider sessions with the new bot arts, the Frost contrast figures the Themes brief asked for, and any release or update.

**Glass values.** Solid is .93 tint with a 24 px blur, not the .84 and 18 px of the Themes brief. The Director changed it in review round 1: at .84 the bright band of the Lake wallpaper showed through all three panels as a light stripe, and the owner asked for a solid default.

**Follow-ups.** Pop's "no extra options" line needs left padding. Markdown links open through a plain `target="_blank"` anchor, so middle-click and Ctrl+click skip the safe-opener path, and the webview fallback should go. The companion and dictation windows keep dark styling in every look, and the remote web app still defaults to the robot art. The four FIX40 specs are untracked in the working tree and need committing. The lane worktrees (`D:\fx40t`, `D:\fx40c`, `D:\fx40p`, `D:\fx40d`, `D:\fx40o`) are removed after the next release.

## Beta.33 review FIX39 (18 October 2026)

**State.** Released as `v0.1.0-beta.34` ([release note](../releases/0.1.0-beta.34.md)): tag at `5b6ee88`, installer SHA-256 `dc2834b3153474070cca0abdb72cd12466a6f8be09e30cd11bc2fad272a0cf4d`, published by `scripts/release-windows.ps1` and offered on `channel-beta`. Thirteen packages (P1 to P13) on `main`, from `14777cb` (Wave A) to `4ba7367` (P10), with the decision, research and audit records in `docs/`. Gates were run at `4ba7367`. The owner's 24 feedback items are in [docs/history/fix-39/feedback.md](../history/fix-39/feedback.md); the decisions that override the research are in [docs/history/fix-39/decisions.md](../history/fix-39/decisions.md).

**Four-model pipeline** (AGENTS.md, 18 October amendment). DeepSeek V4.1 Flash researched each item (`FIX39_RESEARCH_R1` to `R3`, and the T3 study `FIX40_T3_RESEARCH`). Claude Sonnet 5.5 audited the research and then every package. GPT Sol 6.1 and OpenCode DeepSeek lanes implemented the packages in separate worktrees; where a run hit a usage limit, a second lane took it over, and the report says so. Claude Haiku 5.5 wrote these documents. The Director only ran the lanes, checked them, relayed the owner's decisions, merged, gated and committed.

| Package | Items | Commit | Audit | Report |
|---|---|---|---|---|
| P1 | 1, 2, 3, 5 to 9, 14, 15: usage dialog, effort picker, one search, update banner, checklist, Manager card, star badge, dividers, empty usage, sidebar previews | `14777cb` | PASS WITH FIXES, fixed | [P1 report](../history/fix-39/p1-report.md), [audit](../history/fix-39/p1-audit.md) |
| P2 | 17 readable activity; item 4 shape validation | `14777cb` | PASS WITH FIXES, fixed (F1 Remote tool titles) | [P2](../history/fix-39/p2-report.md), [audit](../history/fix-39/p2-audit.md) |
| P3 | 23 Tailscale errors and port conflicts, 24 wide browser layout, 10 companion drag; parent watchdog and single instance | `14777cb` | PASS WITH FIXES, fixed except F3 (recorded, no change) and F4 (owed) | [P3](../history/fix-39/p3-report.md), [audit](../history/fix-39/p3-audit.md) |
| P4 | 4 eight symmetrical shapes, shape-preserving Shuffle and Surprise me, migration | `14777cb` | PASS WITH FIXES, fixed | [P4](../history/fix-39/p4-report.md), [audit](../history/fix-39/p4-audit.md) |
| P5 | 11 Experimental page, 12 model under the name, 13 lock a bot, 16 composer writes the bot, 19 permission in a conversation; update badge over the title (Director check) | `53773fd` | PASS WITH FIXES, fixed | [P5](../history/fix-39/p5-report.md), [audit](../history/fix-39/p5-audit.md) |
| P6 | 18 many conversations per bot, 20 context recap, 21 tags, 19.4 task in its project, 19.5 denial text | `122ab81` | PASS WITH FIXES, fixed; restart gap open | [P6](../history/fix-39/p6-report.md), [audit](../history/fix-39/p6-audit.md) |
| P7 | 22 Bitbots tool set for the Manager, task briefs, routing by role, tags and project | `fd738b2` | FAIL (B1), fixed in a follow-up; re-check PASS | [P7](../history/fix-39/p7-report.md), [audit](../history/fix-39/p7-audit.md) |
| P8 | Watchdog (T3 recommendations 3 and 4): "Limited until", bounded retry, continuation after a crash | `53d193d` | PASS WITH FIXES, fixed | [P8](../history/fix-39/p8-report.md), [audit](../history/fix-39/p8-audit.md) |
| P9 | Working bots panel, Full access default, Steer or Queue setting (T3 recommendation 11) | `dc3a131` | PASS WITH FIXES, fixed | [P9](../history/fix-39/p9-report.md), [audit](../history/fix-39/p9-audit.md) |
| P10 | Separate worktree for a code task when another task works in the same repo, merged back on approval (T3 recommendation 13) | `4ba7367` | PASS WITH FIXES, fixed | [P10](../history/fix-39/p10-report.md), [audit](../history/fix-39/p10-audit.md) |
| P11 | Real-CLI reliability suite with offline replay (T3 recommendation 10) | `e8d3dab` | FAIL (10 findings), addressed in a follow-up; re-check PASS | [P11](../history/fix-39/p11-report.md), [audit](../history/fix-39/p11-audit.md) |
| P12 | Local diagnostics: rolling redacted logs, Export diagnostics | `543f422` | PASS WITH FIXES, fixed | [P12](../history/fix-39/p12-report.md), [audit](../history/fix-39/p12-audit.md) |
| P13 | Claude permission change mid-conversation; steer gate per provider capability | `8409827` (docs `d237172`) | PASS (two optional nits) | [P13](../history/fix-39/p13-report.md), [audit](../history/fix-39/p13-audit.md) |

Other records: [FIX39 owner decisions](../history/fix-39/decisions.md), [Director's browser checks](../history/fix-39/director-checks.md), [research audit](../history/fix-39/research-audit.md), [T3 research](../history/fix-40/t3-research.md). Contract changes are in [docs/ipc-contract.md](../ipc-contract.md) ("FIX39 additions"), the threat model in [docs/remote/THREAT_MODEL.md](../remote/THREAT_MODEL.md) §14.

**Gates on `4ba7367`:**
- Rust workspace excluding the desktop crate: 877 passed, 0 failed. Clippy with `-D warnings`: clean.
- Desktop crate library: 61 passed.
- Vitest: 1290 tests in 174 files passed.
- Main, remote and preview web builds succeed. No sparkle icons.
- Real CLIs, live, outside the normal gates: Claude Haiku 5.5 and OpenCode pass, including the Claude permission change. Codex steer accepted; its two-turn run is a reported usage-limit skip (quota).

**Evidence class.** Most behaviour is tested with fake adapters, a fake Tailscale command, mounted UI tests and temporary databases. Live: the three real CLIs for P11 and P13 (Claude and OpenCode fully; Codex only the steer). Not verified: anything in the list below.

**Not verified.**
- Pairing from a real phone over Tailscale, and Native Remote on a real router and mobile data.
- The native windows: companion drag on Windows, a second launch focusing the first window (P3 F4), the Working bots panel, the wide Remote layout, and the Director's visual checks in both looks and both themes.
- The update round trip from beta.33 to beta.34, and the single-instance and update-then-restart behaviour (needs a throwaway build).
- The friend's exact reproductions: the lost context after a restart, and the permission in a sub-conversation.
- The Codex daemon steer and the Codex daemon fixture: the account was out of quota. The Codex fixture is a rewrite of a real capture for the pinned model (P11 follow-up).
- Real Manager routing and question tone with a live model.

**Owner to-dos.**
1. Decide item 4 (the shapes): the owner makes the final call on the Grok-style set.
2. Decide the defaults the packages chose: Full access for new bots (decision 5); the overload retry stays under Experimental › Automatic retry and is off by default (P8 N1); usage-limit resume is on by default. P8 N2 (no quota probe when there is no stored snapshot) also needs the owner's confirmation; with no reset time the conversation stays Limited and asks.
3. Decide whether a phone may approve a merge with Discard. The `proposal.decide` tier allows it when approvals from remote are on (P10 finding 6).
4. Confirm the Native and Tailscale threat-model review before any non-beta release (THREAT_MODEL §13, and the Remote checklist).
5. Re-record the Codex daemon fixture when quota returns.
6. Remove the lane worktrees and Cargo target folders named in the package reports after the release, as AGENTS.md (14 October amendment) requires once their diffs are merged.

**Known issues carried.**
- A queued side conversation that was waiting when the daemon stopped has no turn after a restart; it starts again only when a new message is delivered (P6, not implemented).
- `debug` log level takes effect at the next daemon start (P12).
- A continued side conversation whose merged or discarded copy is gone is repointed at the repository root, so a follow-up never runs in a deleted folder (P10 finding 1). Whether the provider's own history still applies there was not exercised live.
- Desktop-crate clippy lints that predate FIX39 remain outside the gate.

## Beta.32 review FIX38 (18 October 2026, after beta.32)

**State.** Released as [v0.1.0-beta.33](../releases/0.1.0-beta.33.md) (tag at `0d4c975`; installer SHA-256 `3906cc3fbcabc81aaa86f96a93d2f2aa71ea2131198fff80d2e2ef29321d83a9`), signed for the updater and published to `channel-beta`, so beta.32 installs should offer **Restart to update** by themselves. All fixes by DeepSeek lanes (briefs `docs/FIX38_H1` to `H3_*_SPEC.md`); the owner allowed the Director one direct change, the icons.

| Lane | What it did | Report |
|---|---|---|
| H1 | Remote pairing: safe GETs may omit `Origin` (browsers never send it on same-origin GETs, so the approval poll and `/api/me` were refused); the phone no longer latches signed-out on its first `/api/me`, never demotes a waiting screen on a failed poll, never re-submits a used `#pair=` code; Tailscale turn-off removes the handler despite the CLI's help no longer listing `off`; browser-like end-to-end tests for both methods. Evidence from the owner's install: both Direct approvals recorded, live gateway refused the Origin-less poll. | `docs/history/fix-38/h1-report.md` |
| H2 | A bot without a conversation opens a local draft; no `agent.conversation` call, no null active session published (the companion answered it with another bot's conversation, the jump to the first bot); the first send creates the conversation, titled from the message | `docs/history/fix-38/h2-report.md` |
| H3 | Continuous branch lines in the classic look (four geometry faults the Bitbots dotted line hid) | `docs/history/fix-38/h3-report.md` |
| Director | No star or sparkle icons anywhere: Manager briefcase, What's new newspaper, pinned notes pin | `c4b0717` |

**Gates on `cb48af6`:** Rust 728, clippy clean, desktop crate 64, Vitest 1157, main, remote and preview builds; preview check of the classic tree lines (guide, continuation, elbow and arrow all at x = 9 px).

**Not verified:** pairing from a real phone (iPhone Safari's handling of the `__Host-` cookie), removing the live Tailscale handler, the automatic update from beta.32, the native windows.

## Beta.31 review FIX37 (18 October 2026, after beta.31)

**State.** Released as [v0.1.0-beta.32](../releases/0.1.0-beta.32.md) (tag at `fc7987f`; installer SHA-256 `594334e6b094d61fbf5258efd75fe3554e505623b879100eb756b188707fd58a`), signed for the updater with a **new key** in `%USERPROFILE%\.bloblex-release` and published to `channel-beta`, so beta.32 and later update themselves; older installs install beta.32 by hand. The owner asked that **all code, UI included, goes to DeepSeek lanes** this wave ([AGENTS.md](../../AGENTS.md), 18 October amendment): the Director wrote the briefs `docs/FIX37_G1` to `G6_*_SPEC.md`, reviewed each report and diff, merged, gated and checked the preview; it wrote no production code.

| Lane | What it did | Report |
|---|---|---|
| G1 | Phone page served as `text/html` (it downloaded as a file); a provider resume that fails to initialize falls back to a fresh session (the "coding agent is not available" after signing in again; cause found in the app's event log: `Claude resume did not initialize`) | `docs/history/fix-37/g1-report.md` |
| G2 | Sidebar logos centred with a 5 px gap; every tooltip in a viewport-clamped portal; side-chat badge shadow above the frame fade | `docs/history/fix-37/g2-report.md` |
| G3 | One deterministic selection after a delete or archive; stale active-session ids ignored; no re-publish loop with the companion; no auto-create/empty-removal chain; no unread dots from moving selection | `docs/history/fix-37/g3-report.md` |
| G4 | `/` slash menu: actions, the bot's skills, Manager commands; `session.prompt` `command` with a hidden per-turn directive; `skills.forAgent` | `docs/history/fix-37/g4-report.md` |
| G5 | Background update check every 4 h and download; "Downloading update" / "Restart to update" in the header; Settings › Updates mirrors it; release script refuses a build without updater artifacts | `docs/history/fix-37/g5-report.md` |
| G6 | Preview fixture stand-ins for the update phase and an export parity test (the preview had gone blank) | `docs/history/fix-37/g6-report.md` |

**Gates on `6330ccc`:** Rust 723 passed, clippy clean, desktop crate 64, Vitest 1136, main, remote and preview builds. Preview checks: logos (0 px offset, 5 px gap), tooltip clamped at the right edge, slash menu for a bot and for the Manager, update badge.

**Not verified:** an update round trip on a real install (first possible with beta.33), the phone page on a real phone, the resume fallback against a really expired sign-in, the native windows. A resume slower than 8 s now starts fresh. The update badge only shows when the header actions are visible (a bot selected).

**Owner to do:** back up `%USERPROFILE%\.bloblex-release`; delete `C:\fxt`, `C:\fxtarget` and `C:\fxtarget2` when no lane runs.

## Beta.30 review wave FIX34-FIX36 (17 October 2026, after beta.30)

**State.** Released as manual-only [v0.1.0-beta.31](../releases/0.1.0-beta.31.md) (tag at `c07cc24`, pushed with `main`; installer SHA-256 `7d44c0e8df46933f595605e6d1690cc94f57cf29db7b3ee0bb059ea09e761422`, unsigned; the signed updater feed stays at beta.6). The packages are `c60d058` to `1c57d94`, on top of the beta.30 record (`1937bc8`). The owner's beta.30 review (screenshots plus two briefs) became the FIX34-FIX36 specs below. Owner decisions in planning: Native Remote with a built-in certificate (fingerprint shown) and a password **plus** desktop approval of each new device; a **new** built-in Manager (the old team leader becomes an ordinary bot); the Manager needs approval for **every** consequential action (project, bot, task). The Native amendment is in [AGENTS.md](../../AGENTS.md) (17 October, later). Lanes as in the 16 October amendment: the Director wrote all UI and docs; OpenCode `deepseek-v4.1-flash` (high) wrote the backend in worktrees `C:\fx5x`, each diff reviewed and gated on `main` before commit.

### What landed

| Package | Commits | What it does | Spec / report |
|---|---|---|---|
| FIX34 fixes and polish | `c60d058`, `cc77c1c`, `c1fe315`, `4d22228` | The phone web app loads (`/` serves `remote.html`). No "fresh session" notice for a context that never had a turn; repeated notices collapse. Empty "New chat" rows are not kept; a bot with a project opens straight into a composer. An expired coding-agent sign-in is flagged on the runtime with **Sign in again** / **Install** buttons that open a terminal running a fixed command. UI polish: Project / Conversation header, Remote banner, selected-row highlight, only the selected bot tracks the cursor, grouped profile menu with **What's new**, tour clamp, command palette categories and icons, row actions over the time, tree lines for branches, companion conversation picker and project name. | `docs/history/fix-34/a1-remote-web-spec.md`, `docs/history/fix-34/a2-fresh-session-spec.md`, `docs/history/fix-34/a5-sign-in-spec.md` + reports |
| FIX35 Native Remote ("Direct") | `ce0d04f`, `4199961`, `40609e3` | A second Remote method without Tailscale: HTTPS on the host's interfaces (`remote.nativePort`, default 48621) with a self-made certificate, Argon2id password sign-in plus owner approval, per-source rate limits, lockouts and a global pause, `Origin`/`Host` checks. Connectivity: UPnP mapping with consent (removed on disable and shutdown), the `Bitbots-Remote` firewall rule through one elevated prompt, carrier-NAT and private-address detection, a typed public address, and `/api/ping` "reached from". UI: method switch, sign-in, addresses with QR and fingerprint, a "Reaching this computer from away" checklist; the phone gets a username/password screen. Tests bind loopback only (they had raised Windows Firewall prompts). | `docs/history/fix-35/c1-native-remote-spec.md`, `docs/history/fix-35/c2-connectivity-spec.md`, `FIX35_C3`-`C6` follow-ups + `docs/history/fix-35/c1-report.md`, `docs/history/fix-35/c2-report.md`; [docs/remote/PROTOCOL.md §13](../remote/PROTOCOL.md), [THREAT_MODEL.md §12-13](../remote/THREAT_MODEL.md) |
| FIX36 the Manager | `558440b`, `5353a9d`, `ccbdb1d`, `8e6db02`, `ca653dd`, `e1b80ec`, `1c57d94` | One permanent global Manager (`systemRole: "manager"`, no project, cannot be deleted or demoted; name, look, model and personality editable), pinned above every project. Proposal cards for projects, bots, tasks, playbook and locked-profile changes, editable before **Approve**; `ask_user` questions for every provider. What it knows about the user (facts with lock) and a versioned playbook ride in a per-turn suffix and a one-off handover after a model change ("New model, same Manager"). UI: onboarding "Meet your Manager", a one-time setup card for existing users, Settings › Manager (facts, playbook with history, diff and restore), "New project with the Manager" and "Import project folder…". A pending approval now pulls focus once instead of locking the selection. | `docs/history/fix-36/d1-manager-spec.md`, `docs/history/fix-36/d2-proposals-spec.md`, `docs/history/fix-36/d3-knowledge-spec.md` + reports |

### Gates on `1c57d94`

- Rust workspace excluding the desktop crate: **719 passed, 0 failed** (on `e1b80ec`; `1c57d94` changed only UI). Clippy with `-D warnings`: clean.
- Desktop crate library: 59 passed (on `40609e3`; no native change since).
- Desktop UI: `npx tsc -b` clean; Vitest **1091 passed** in 154 files; `npm run build` and `npm run build:remote` succeed.
- Browser preview (fixture bridge): Settings › Remote Direct steps, Settings › Manager with the playbook diff, the Manager-led new project. The phone sign-in screen is covered by mounted tests only.

### Not verified

- **Native Remote, live.** No real router, no phone on mobile data, no outside attacker. UPnP, the firewall prompt and the certificate's key-file permissions are tested against fakes only. The independent review in [THREAT_MODEL.md §13](../remote/THREAT_MODEL.md) is owed before a non-beta release.
- **Remote over Tailscale, live** (still owed from beta.30).
- **Expired sign-in**: the terminal button and re-check, against a really expired Claude sign-in.
- **The Manager with a real coding agent**: the first-run interview, proposals created by the model, the handover after a model change.
- That the Windows Firewall prompts during test runs have stopped (expected from the loopback bind).

### Known issues and next steps

1. Live checks with the owner, in this order: Tailscale Remote, Direct from a phone on mobile data, an expired Claude sign-in, the Manager's first-run interview and a project set up through proposals.
2. Cleanup after beta.31 is done except `C:\fxt` (about 67 GB of the lanes' Cargo targets), which the tool's safety check would not delete; the owner can remove it with `C:\fxtarget` and `C:\fxtarget2`.
3. `manager.profile.set` relabels a fact as "corrected" when only its lock changes; harmless, a lane tidy-up.
4. Carried over: the desktop-crate clippy lints.

## Owner review wave FIX26-FIX33 (15-17 October 2026, after beta.29)

**State.** Released as manual-only [v0.1.0-beta.30](../releases/0.1.0-beta.30.md) (tag at `ec705a1`, pushed with `main`; installer SHA-256 `f435782cc9848d86c2d8b522161e765782e5f5a4fc97bf5fe88b092fe925567d`, unsigned; the signed updater feed stays at beta.6). The packages below run from `25e694c` to `54b674e`, and `55a2447` finished the plan (rail Remote row, Archive, instant Plan and permission switches, ordered background loading, the phone conversation list). The owner accepted the Remote amendment in `AGENTS.md` on 17 October and waived its release gate once for this beta. No lane or build worktree is left. Lanes followed the 16 October amendment in [AGENTS.md](../../AGENTS.md): the Director wrote all UI, and OpenCode `deepseek-v4.1-flash` (high) wrote the backend from a spec per package, with each diff reviewed and gated on `main` before commit. The plan is in the FIX specs listed below; owner decisions were Tailscale for Remote, a Bitbots skills pool shared over MCP, a backup holding bots, memory, skills, automations and settings (no projects, no conversations), and the word "bot" in both looks.

### What landed

| Package | Commits | What it does | Spec / report |
|---|---|---|---|
| FIX26 UI review | `25e694c` | About 33 screenshot items: "?" tooltips instead of small print, model search, chips that open bot-to-bot chats, onboarding first-bot editor, companion drag from empty space, companion composer and message actions, "bot" everywhere, effort icons, permission icons, single-column bot editor. | — |
| FIX28 speed + FIX33 small backend | `0dc6531`, `0f54c7b`, `00fbcd0`, `fcf0e61` | Model catalog cache (fresh 15 min, stale up to 7 days, single-flight, persisted, `CachedOnly` on every send path, boot prewarm, `runtime.models.changed`). The UI catalog cache makes model and effort switching instant after boot. A send is accepted at once and the coding agent starts behind it; the composer never waits and shows "Sending…". `session.warm` when a conversation is opened. Cloud dictation client kept warm (no request to the endpoint ahead of time). `session.environment`. | `docs/history/fix-28/catalog-spec.md`, `docs/history/fix-28/send-spec.md`, `docs/history/fix-33/small-backend-spec.md` + reports |
| FIX27 conversations | `e34f10e`, `869d878`, `2e12c51`, `7708f2a` | Many conversations per bot (`agent.conversation.create`, `agent.conversations`), auto-titles, a stable bot-to-bot tree (`spawnedFromSessionId`), readable workspace names. UI: a collapsible per-bot Conversations column with branches, a session rail (Environment, Context, Outputs, Changes) and a latest-changes banner with Undo. | `docs/history/fix-27/conversations-spec.md` + report |
| FIX32 skills | `c5337b6`, `05fc503`, `245a816` | One skills pool under the data folder, imported from Claude Code, Codex, OpenCode or a folder; MCP tools `list_skills`, `load_skill`, `read_skill_file`; a `<bloblex_skills>` routing block in the per-turn suffix, re-sent only when it changes; per-bot opt-outs; no double loading of native copies. UI: Settings › Skills, a Skills group on the bot page, "Used skill: name" in a turn's steps. | `docs/history/fix-32/skills-spec.md` + report |
| FIX31 backup | `c480815`, `05fc503` | One checksummed `.bitbots-backup.json`; preview with conflicts and warnings, then import with rename/replace/skip in one transaction; settings through an allowlist; secrets, sign-ins, `remote.*` and dictation consent never included; automations come back paused. UI: Settings › Backup, also in the profile menu. | `docs/history/fix-31/backup-spec.md` + report |
| FIX29 Remote over Tailscale | `6b2ef85` (WP6a policy), `5275cbd` (WP6d contract), `650e275` (Settings › Remote), `fa7c5a7` (WP6c PWA), `f4f9417` (phone client), `d793812` (WP6c-1 build fix), `54b674e` (WP6b gateway) | One policy file `apps/desktop/src/remote/tiers.json` used by Rust and TypeScript (76 shared golden cases). A gateway inside `bitbotsd` on `127.0.0.1:<remote.port>` published with `tailscale serve` (443, else 8443; never Funnel, never `serve reset`), owner-confirmed pairing, device cookies stored as SHA-256, Origin and Tailscale-login checks, tiers, quiet hours, redaction, event replay. A separate PWA build (`npm run build:remote` → `dist-remote`, shipped as the `remote-web` resource) with a real service worker. The phone client pairs, waits for approval, and follows its tier. | `docs/FIX29_WP6{A,B,C,C1,D}_*_SPEC.md` + reports; design in `docs/remote/` |

### Gates on `54b674e`

- Rust workspace excluding the desktop crate (`RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`): **662 passed, 0 failed**. Clippy with `-D warnings`: clean.
- Desktop crate library (`cargo test -p bloblex-desktop --lib`, from this checkout): 53 passed.
- Desktop UI: `npx tsc -b` clean; Vitest **1046 passed** in 146 files; `npm run build` and `npm run build:remote` succeed.
- Browser preview checks (fixture bridge): every FIX26 item, the conversations column, rail and banner, Settings › Skills, › Backup and › Remote, and the phone client at 375 px.

### Not verified

- **Remote, live.** No real Tailscale: the gateway's 75 remote tests use a fake CLI and temp databases. The installed CLI's `serve --help` text, real `status --json` shapes, the 443→8443 fallback, cookie behaviour on iOS Safari and an installed PWA are all unchecked. **The remote AGENTS.md amendment ([docs/remote/AGENTS_AMENDMENT_DRAFT.md](../remote/AGENTS_AMENDMENT_DRAFT.md)) still needs the owner's sign-off before Remote ships.**
- Live CLI timing for the catalog cache and the non-blocking send; boot prewarm against real CLIs; a real bot calling `load_skill`; a backup exported and imported into a fresh data folder; the native windows (companion drag, rail, banner) in the real app.

### Known issues and next steps

1. **Live Remote test** with the owner's Tailscale and phone: enable, pair, install the PWA, chat as `chat`, approve as `operator`, revoke. The threat-model checklists and an independent review remain owed before a non-beta release.
2. `cargo clippy -p bloblex-desktop` has lints that predate this wave (an error in `power.rs:222` "this loop never actually loops", warnings in `lib.rs`, `speech.rs`, `updates.rs`). The clippy gate excludes the desktop crate, so nothing fails; a lane cleanup is worthwhile.
3. `cargo clippy --all-targets` reports a `needless_borrow` in the FIX32 skills tests in `main.rs`; same lane cleanup.
4. A fresh checkout builds the desktop crate only after `dist/` and the sidecars exist; `dist-remote` now gets a placeholder from `build.rs` (WP6c-1).
5. Lanes on this machine: `C:\fxtarget` (about 20 GB) and `C:\fxtarget2` (about 6 GB) are private Cargo target folders the lanes used; the tool's safety check would not let the Director delete them, so the owner can delete them when no lane runs.

## Owner review follow-up and Bitbots (13 October 2026, after beta.19)

Released as manual-only [v0.1.0-beta.20](../releases/0.1.0-beta.20.md) (tag at `34631aa`; installer SHA-256 `cdbabd0857d86680a515aa6368effbb45de514466887f1614aa1c1235401ca4c`, unsigned; the signed updater feed stays at beta.6). A later owner pass (one focus mark on the composer, a pixel switch, equal automation idea cards, robot editor spacing, archive card and conversation rows) is included.

**Review fixes.**
- ChatGPT dictation: a live probe (`scripts/live-checks/live-cloud-dictation.mjs`, evidence `docs/evidence/cloud-dictation-diagnosis-2026-10-13.md`) showed `chatgpt.com/backend-api/transcribe` answers an honest non-browser client with a Cloudflare managed challenge (403, `cf-mitigated: challenge`). The Codex login is valid; this is not an auth failure and cannot be fixed without impersonating another client, which we will not do. The Codex app-server has no plain transcription request (only `thread/realtime/*`). The copy now says so; `automatic` mode cools the cloud down for ten minutes after a persistent failure; an unrecovered failure carries `both_engines_unavailable`; the UI no longer skips the on-device download for `automatic`.
- OpenCode effort: `opencode-go/deepseek-v4.1-flash` does expose `low|high|max`. The gate defaulted off and databases were seeded closed; the gate now defaults open, a one-time marker migration (`migration.opencodeEffortGateOpened`) opens it, `runtime.capabilities` answers per model with a reason, and the ACP adapter selects the `thought_level` option by category.
- Leader tools: only the team leader gets `list_projects`, `create_blob`, `update_blob` on the bridge (never bypass, 5 per turn, 12 in total, note in the transcript); non-leaders are told to tag `@<Leader>`.
- `claude.enableWorkflows` is on unless explicitly false (so Ultracode is offered); one reaction per message; no hairline under the header, aligned header row, centred message actions with copy feedback, Usage page rebuilt (plan limits first, logo orbs), Automations replace Schedules and the send-later clock is gone, `Create your first blob` when no blob exists.

**Bitbots (experimental, off by default).** Settings, Experimental, Bitbots (flashing badge). While on: `BlobCanvas` renders robot-heads (MIT, 2D canvas) instead of the blob engine on every surface (`blob/BitbotCanvas.tsx`, `blob/bitbots.ts` store and mood-to-face map); the theme is `ui/bitbots.css` (DeepSeek draft, audited and patched by the Director) and loads with the Doto and DM Mono fonts only while on. Per blob: four outlines (rectangle, square, circle, hexagon) and shell/trim/screen colours, stored as an optional `bot` object inside the blob's `look` (validated by the daemon). Antenna is always off and speed always 1 (not user-settable). The welcome is a robot that hops with one full spin; pixel clouds sit behind the intro.

**Gates.** Rust workspace excluding desktop: 472 passed, 0 failed (`RUST_MIN_STACK=33554432`; one pre-existing test overflows the default stack). Desktop crate library: 34 passed. Desktop UI: typecheck clean, 516 tests passed, production build splits the theme and fonts into lazy assets.

**Unverified.** Bitbots in the real native windows and companion; Doto in the dev preview from the apostrophe path (the unquoted font URL breaks there, production bundles it fine); the leader tools and `turn/steer` against live CLIs; the effect of OpenCode effort on provider behaviour; Cloudflare behaviour of the dictation endpoint from other networks.

## Improvement plan v2: overnight status (12-13 October 2026)

Roadmap and decisions: [docs/plans/improvement-plan.md](../plans/improvement-plan.md). Work ran through the delegation pipeline in `AGENTS.md`: OpenCode DeepSeek (high) wrote backend code from specs in `docs/IMPROVEMENT_PHASE_*_SPEC.md`; the Director wrote all UI/UX, reviewed every diff, re-ran the gates itself and committed. **Everything below is fake-peer or unit verified. No real CLI, microphone, installer or native window was exercised, and nothing was pushed or released. The work is on local `main`.**

### Where the code is

| Branch | What it holds |
|---|---|
| `main` (this checkout) | Phases 1-7 (backend and UI), fast-forwarded from `integration/improvement-v2` on 13 October 2026 on top of `17591b9`. **Local only: not pushed.** |
| `phase3b-replay` (worktree `../Blolblex-wt-phase1`) | Backend chain tip, fully merged into the integration branch. |
| `phase7-cloud-dictation` (worktree `../Blolblex-wt-p7`) | Cloud dictation and keep-awake (merged into integration). |
| `plan/improvement-v2`, `phase1-ui`, `phase2-ui`, `phase1-lifecycle`, `phase2-queue`, `phase3-retry`, `phase4-automations` | Stepping stones, all contained in the integration branch. |

### What exists

| Phase | Backend | UI |
|---|---|---|
| 1 Reliability | One turn-end path; timeouts now drain queued team messages; watchdog waits during approvals; typed recovery hints; delivery fact; context-change notices | Context-reset dividers (chat and island) |
| 2 Queue / steer | Durable per-session queue, send later, pause rules, due loop; gated Codex `turn/steer` (off by default, evidence `none`) | Composer stays usable during a turn, queue banner, send-later popover, Steer button when enabled |
| 3 Retry (+3B) | Replay tests for all three adapters (synthesised fixtures). `experimental.autoRetry`: one "Please continue." after overload or a known rate-limit reset; never resends the prompt | Retry notices with Cancel, queue retry rows, settings |
| 4 Schedules | Cron/once automations, coalescing, single-flight, caps, bypass impossible, unclassified permissions auto-denied, agents can only propose | Schedules page, editor with presets and preview, run history, approvals, global pause; Pause all also pauses schedules |
| 4B Power | `set_keep_awake` thread holding `ES_SYSTEM_REQUIRED` | Opt-in Power setting, wanted only while working or a run is due |
| 5 Memory | `experimental.memory` (off by default): MCP memory tools, bounded per-prompt catalog, FTS5 store with versions, rails, `profile.about`; agent notes for a project or everyone need approval and `memory.sharedAgentWrites` | Memory settings page, about-you, review and approval, shared-notes switch |
| 6 Questions / hand-off | Non-blocking `ask_user` for OpenCode with expiry, read-only `session.handoff.draft`, per-blob `notificationLevel`, scheduled runs excluded from the main conversation | Hand-off dialog (drafts into the target blob's own composer), per-blob notification level |
| 7 Cloud dictation | `bloblex-speech::cloud`, native worker path, status command and engine event | Engine choice, consent dialog, indicator, Codex sign-in status |

### Gates last run

- Desktop: `npx tsc -b` clean; Vitest 497/497 on the integration branch.
- Rust workspace excluding the desktop crate (`RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop`): 459 passed, 0 failed, run with `--no-fail-fast`. (One earlier run failed `catalog_timeout_kills_the_child_and_failure_is_provider_unavailable` in `bloblex-adapter-acp` while the machine was busy; it is a wall-clock timeout test, passed 3 of 3 in isolation and in every later full run, and is worth watching.)
- Desktop crate: lib tests (including `power::` and `speech::`) pass from a plain path (`D:\c7`, a detached checkout). **Building the desktop crate from this folder fails** because the apostrophe in `Basem's` breaks the Windows resource compiler and `assets/icon` is not tracked; use a plain-path checkout, as the earlier `D:\u18` checks did.
- One daemon test (`agent_rpc_crud_reorder_archive_errors_and_persisted_event_sequence`) overflows the default test stack on the untouched base commit; run Rust tests with `RUST_MIN_STACK=33554432`.

### Known gaps and risks

- Scheduled runs are excluded from a blob's main conversation in both the UI and the daemon (the daemon already excluded any linked session; Phase 6A made it explicit and tested it).
- Not built: the first-run onboarding state machine, an island badge for running schedules, a UI switch for `questions.expirySecs`, and real-CLI wire captures (the replay fixtures in `docs/evidence/wire-fixtures.md` are synthesised from the fakes). The ask-user tool is OpenCode-only; whether Codex's native question tool is plan-mode only is still unprobed.
- `turn/steer`, the ChatGPT transcription endpoint (WAV acceptance, Cloudflare behaviour), real auto-retry timing, scheduler end-to-end timing, `powercfg /requests` with keep-awake, and the memory catalog reaching a real prompt are all unverified live. See the evidence files in `docs/evidence/`.
- Cloud dictation reads the Codex sign-in file under an owner-approved, dictation-only exception recorded in `AGENTS.md`. It is opt-in, off by default, and falls back to the on-device model.
- Open product call: agent-written memories for a project or everyone stay unused until approved (the recommended default, implemented in the spec).

### Suggested next steps

1. Review and merge Phase 3B when its lane finishes (`phase3b-replay`).
2. Build the installer in a private plain-path directory and run the live checks listed in each evidence file with a throwaway database.
3. Merge `integration/improvement-v2` into `main` when satisfied. Nothing has been merged into `main`.

## Published (13 October 2026, beta.19)

The improvement plan v2 (Phases 1-7, see the section above) shipped as manual-only [v0.1.0-beta.19](../releases/0.1.0-beta.19.md), tagged at `4a4d0f6`, with `main` and the annotated tag pushed to GitHub.

- Installer built in `D:19`: 13,562,185 bytes, SHA-256 `8e2946b1d35028abdbd439433fb61649fbf1c904b9cc26665b2cf0bfb61afed4`, `NotSigned`. The installer and `SHA256SUMS.txt` are published as a prerelease (`--latest=false`); GitHub's digest matches. The rolling signed updater stays at beta.6.
- Boot smoke of the built daemon on a temporary database passed (snapshot, runtime discovery of all three CLIs, schedule and memory RPCs). No coding prompt was sent and no user database was touched.
- Everything new was verified only with fake providers, unit tests and browser fixtures. The "Unverified" list in the release notes is the live-test backlog: live provider turns, `turn/steer`, ChatGPT transcription, real retry timing, an end-to-end scheduled run, keep-awake effect and clean-machine install.
- Stepping-stone branches and the worktrees `../Blolblex-wt-phase1`, `../Blolblex-wt-p7` and `D:19` are cleanup candidates; nothing was removed.

## Published (12 October 2026, beta.18)

The user's model, context and Usage follow-up shipped as manual-only [v0.1.0-beta.18](../releases/0.1.0-beta.18.md), source commit `65f5211`. The reviewed changes, version bump and annotated tag are pushed to `main` and GitHub. The user authorized publication after the implementation report.

- Claude's `thinking is not supported` error originates in Bitbots' model/effort validation before execution, separately from quota exhaustion. Main and companion offer model-preserving effort recovery. The exact saved pair in the installed app was not inspected.
- Provider-default and recommendation model rows are removed. First-use choices are latest available Sonnet, latest Luna and `opencode/big-pickle`, using validated catalogs; explicit saved models remain pinned. Claude is chronological across families, OpenCode uses reported dates within gateway groups, and Codex generations remain newest first.
- The attached bb notes were checked against source snapshot `4b12265e5fb82c01ea67e67cfe8d935533406937` and vendor SDK declarations. Native, prompt-free Claude 2.1.296 probes confirmed `enableWorkflows:true` enables reported Ultracode availability and `get_context_usage` works before a prompt. Settings → General → Experimental → Claude dynamic workflows is off by default and applies session-local settings to new conversations, retained through model/effort/speed changes. Ultracode uses `xhigh` plus `ultracode:true`; Max remains distinct. Luna's catalog does not support Ultra; eligible Sol models do.
- Claude context is queried at connection startup, completion and compaction with bounded, stale-response-safe control requests and estimated provenance. OpenCode consumes structured usage updates and reported capacity, excluding child-session updates. Unknown, zero capacity, explicit null attribution and model changes cannot produce a stale percentage. Both windows share normalized state.
- Runtime-logo tooltips open below the icon in a viewport-constrained body portal. Effort uses one rotating chevron. Usage Back/Refresh are accessible borderless icons; Blobs have actual portraits and a separate provider section with three weekly liquid orbs. Missing readings are unknown; stale readings remain labelled; reduced-motion/offscreen behavior is covered.
- Independent final gates: typecheck, 441 desktop tests across 73 files, production web build, 326 Rust workspace tests excluding desktop, native desktop library compile check in private `D:\u18`, and Windows x64 NSIS bundle in `D:\b18`. The existing bundle-size warning remains. OpenCode's final source audit passed all six corrections and estimate-provenance handling. All 46 changed source/version/documentation files match the built snapshot under Git normalization; staged daemon/hook hashes match the freshly compiled binaries.
- Browser fixtures covered dark partial/zero/full/unknown orbs at desktop and native 1000×680 minimum, workflow/model controls, and the below-header keyboard tooltip in light theme. Chronology and the final chevron correction have deterministic/source evidence. Details: ignored `target/usage-model-followup/ROOT-VERIFICATION.md`; full screenshot with sample data: `usage-partial.jpg`. The earlier `weekly-usage-preview.jpg` was cropped incorrectly and should not be used as the orb preview.
- The built beta.18 daemon passed isolated-database health/discovery with Claude 2.1.296, Codex 0.162.1 and OpenCode 1.18.35 all online/protocol-healthy. No coding prompt was sent, and its scratch database was removed. Installer: 13,237,527 bytes, SHA-256 `72ac911d8556aa9f99575cb42694802a7126266dc07d91d2342f2bb3cc5c10a1`, `NotSigned`. Installer and `SHA256SUMS.txt` are published; both GitHub asset digests match local files. Signed updater feed remains beta.6; install beta.18 manually.
- Limits: no current-batch installed-app coding turn, native-window interaction, real OpenCode context turn or clean-machine install. The installed inspection app, user databases, CLI configuration and pre-existing `output/`/`.playwright-cli/` artifacts were preserved. Task preview processes and tabs ended during the interrupted session; none remain to clean up.

## Published (11 October 2026, beta.17)

The combined runtime/chat follow-up shipped as manual-only [v0.1.0-beta.17](../releases/0.1.0-beta.17.md), source commit `6bf66d5`, with the commit and annotated tag pushed to GitHub.

- OpenCode 1.18.35's successful stderr-only ACP help now passes discovery. Failed-runtime bots alone show error mood, a red problem indicator and recovery guidance; main and companion messaging follow normalized runtime health.
- Message actions are Reaction, Reply and Copy beside each user/assistant bubble. Local reactions persist via additive schema v12. Quoted replies are validated by the daemon, staged inside the composer and retained in history. Read-only side conversations stay read-only; team delivery uses a separate internal path.
- New off-by-default Usage tips are independent of the Usage bar, dismissible by period/threshold and sourced only from fresh reported quota. Expired reset windows are omitted and model qualifiers retained. OpenCode's three Detailed metrics fit one stats line at desktop width.
- Codex tool activity gains bounded command chunks and MCP/dynamic-tool details/progress/status. Effort labels are Light through Ultra when offered; Luna stops at Max. GPT families sort numerically newest first, including singleton catalogs; non-GPT order is preserved. Empty-chat effects gain raster overscan without changing body/hit geometry.
- Independent gates: typecheck, 426 desktop tests, web build, 306 Rust workspace tests excluding desktop, native desktop library check and NSIS bundle. OpenCode QA plus root review found and routed five corrections, with regression coverage. Browser fixtures checked copy, reactions, quoted replies/history, notice dismissal, usage metrics, error isolation, dark/light and the 1000px minimum width.
- The built release daemon passed an isolated-database health/discovery check with the real Claude, Codex and OpenCode CLIs; no coding prompt was sent, and the private database was removed. OpenCode was `online` at 1.18.35. No installed inspection app or user Bitbots database was touched.
- Installer built in `D:\b17`: 13,173,484 bytes, SHA-256 `ca9caab8d47b4449e69c3d2358b1db6ffd42807a26e303e8ae84016cc46919fd`, `NotSigned`. The installer and `SHA256SUMS.txt` are published; GitHub's digest matches. The rolling signed updater stays at beta.6.
- Unverified: live coding turns through the installed app, real taskbar/tray behavior and clean-machine installation. The task-owned preview tab/server were closed; pre-existing `output/` and `.playwright-cli/` artifacts were preserved.

## Published (11 October 2026, beta.16)

Claude's combined follow-up shipped as manual-only [v0.1.0-beta.16](../releases/0.1.0-beta.16.md), including the additional Close chat fix, parallel agent discovery with background retries and Settings feedback, the Codex cloud logo, and seven individually opt-in experimental features (change review, message actions, search, automatic titles, Undo, shortcut sheet and approval badge). The companion no longer announces side conversations back to the main window after closing them.

- Release source commit `41ad15e` and tag `v0.1.0-beta.16` are pushed to GitHub.
- Independently verified: desktop typecheck, 408/408 desktop tests, web build, 290 Rust workspace tests excluding desktop, 24 native desktop library tests, native compile check and Windows NSIS bundle. The release checkout's 38 changed source/version files match the committed source; staged daemon/hook hashes match the freshly compiled release binaries.
- The unsigned NSIS installer was built in `D:\b16`: 13,145,402 bytes, SHA-256 `cbdef090e7011743ba020bf899d6768c9a9624c007170f2d7a41a3f24aec4828`, `NotSigned`. GitHub's uploaded digest matches. The installer and `SHA256SUMS.txt` are published.
- The signed updater feed was checked and remains at beta.6. Install beta.16 manually over the existing app.
- Still unverified: native taskbar/tray behavior, startup retries with real CLIs, Revert on a real user project and clean-machine installation.
- Local `output/` and `.playwright-cli/` artifacts were excluded from the source commit and preserved.

## Published (11 October 2026, beta.15)

The section below shipped as manual-only [v0.1.0-beta.15](../releases/0.1.0-beta.15.md). Release commit `0f1a7df` is pushed to `main` and tagged `v0.1.0-beta.15`. The unsigned NSIS installer was built in `D:15`: 12,943,042 bytes, SHA-256 `ea042d9495a7c702f9507a0657ddc52e114558ac6f65adc78cdb8f70aa2e584f`, `NotSigned`. The signed updater feed remains at beta.6.

## 1.0 polish (11 October 2026, after beta.14)

- **Effort.**
  - Levels come from each CLI's catalog. Codex lists Low…Max plus **Ultra** on Sol, Astra and Terra models; Luna does not offer Ultra.
  - Claude gains a synthetic **Ultracode** stop after Max when `get_settings` reports `applied.ultracodeAvailable`. Claude allows Ultracode when dynamic workflows are on and the model supports Extra high. It runs as `--effort max --settings {"ultracode":true}`.
  - The slider is a pointer-captured `role="slider"` div (no native range input) and commits only on release.
  - "Provider default" moved to the top right. The recommended level is a short line, captioned "Recommended" for Claude.
  - Claude style lights only the cells nearest the knob.
  - OpenCode's gated effort is a greyed pill with a tooltip instead of an error.
- **Side conversations.**
  - OpenCode `thinking` messages are hidden. This was the "second Fluffy reply".
  - Opening a side conversation no longer switches the selection to its owner (Tauri active-session listener), and Close chat returns to where it was opened.
  - Each conversation has a topic: `message_blob` takes `topic`/`conversation`, and there is a new `list_conversations` tool. The header pill is centred and shows the topic.
  - The blob header has a side-conversation menu.
  - `#` in the composer references a conversation; the daemon appends its id and latest reply to the prompt only, and stores `references` on the message.
- **Dictation.**
  - Fixed the first-click stall: a freshly spawned worker never received Start.
  - The worker opens the mic before the model loads and queues audio. `dictation_warm` preloads at launch, and idle teardown is now 10 minutes.
  - New settings `speech.enabled` and `speech.model`.
  - Ctrl+E is registered only while dictation is on (`set_dictation_shortcut`) and goes to the companion while it is shown, else to the main window.
  - New Kaze-adapted island for the bubble (it grows to show live words via `set_dictation_bubble_size`) and for the companion.
- **Other.**
  - Removed the header Resume button (prompts already resume). New conversation is disabled on an empty conversation.
  - Every menu item has an icon.
  - Experimental runtime logos (`experimental.runtimeLogos`).
  - New gallery sections: Onboarding and Dictation (`/dictation-preview.html`).
- **Evidence.**
  - Rust workspace tests pass.
  - Desktop: typecheck, 373/373 Vitest and the build pass.
  - The desktop crate compiled in `D:\b14` with the new `lib.rs`/`speech.rs`.
  - Checked in the browser preview: effort (Claude, Codex, locked OpenCode), side conversation menu, pill, close, `#` references, runtime logos, Speech settings and the dictation island.
- **Not verified:** native dictation (warm-up, queued audio, bubble resize, Ctrl+E routing) and Ultracode on a real Claude turn.

## Published (10 October 2026, beta.14)

The section below shipped as manual-only [v0.1.0-beta.14](../releases/0.1.0-beta.14.md). Release commit `5fc1e1b` is pushed to `main` and tagged `v0.1.0-beta.14`. The unsigned NSIS installer was built in `D:\b14`: 12,918,554 bytes, SHA-256 `d70826a1a6d7e2657a05923ca2a5c8ae05db6a4753657ec15d0ee2d8674f76c1`, `NotSigned`. The signed updater feed remains at beta.6.

## Uncommitted follow-up (10 October 2026, after beta.13): timeline, activity, companion focus

- **Timeline order.** Live assistant messages and tools arrived without timestamps, and the timestamp sort pushed them below later items: "Message from Gogo" appeared above Fluffy's own "I asked Gogo". The stored data was correct, which a read-only check of the user's database confirmed.
  - Messages now follow the daemon's per-session sequence.
  - Tools and files carry their `turnId` and sit after that turn's last message.
  - Message events now include `createdAt`.
- **Activity.** "Codex activity" rows were Codex reasoning items with empty content.
  - The Codex adapter drops reasoning items and titles the rest (command, `server · tool`, search query).
  - Storage records each tool's turn, `startedAt`/`completedAt` and a bounded, provider-neutral `detail`: command, output, tool, input, result, query, path, error and exit code, clipped to 4,000 characters. Start and completion are merged. Raw payloads never leave the daemon.
  - The conversation hides all activity unless Settings → Experimental → "Agent activity" (`experimental.activityDetails`) is on. When on, each turn becomes one collapsed "Ran N commands · used N tools" line under its reply, opening into steps with their real details.
  - The companion's Activity tab shows the same steps.
  - `experimental.*` and `companion.*` settings now emit `settings.changed`, so both windows follow them live.
- **Companion**, after the Novra Grok Bot study:
  - The focused blob has a glow (pulsing while working) and a three-line step ticker.
  - Up to four teammates sit in a 2×2 grid, each showing name plus the line it is working on. Pinned teammates come first, then those waiting, then working, then recent.
  - "All blobs" opens a picker that pins up to four (`companion.pinnedBlobs`).
  - Chat height is a setting: Compact 264, Comfortable 360 (default) or Tall 480 (`companion.chatSize`). It is passed to `set_companion_mode` as `chatHeight`.
  - Settings also uses the tall island, and header spacing is fixed.
- **Outline.** It appears only when the conversation scrolls. It is docked at the conversation's left edge beside the sidebar, and faint until hovered.
- **Effort slider.** While held, the knob follows the pointer with no transitions. Nothing is saved until release, and a release without coordinates keeps the last position.
- **Evidence.**
  - Desktop: typecheck, 368/368 Vitest and the build pass.
  - Rust: the offline workspace tests pass, including new tool-detail, settings-event and Codex-title tests. The desktop crate check passed from `D:\b13` with the new `lib.rs`.
  - Preview: checked the main timeline, the activity lines and details, the outline, the companion overview, the picker, the Tall chat, settings and activity.
- **Not verified.** Native windows. The effort slider drag in the desktop app; the cause was inferred, not reproduced.

## Published (10 October 2026, beta.13)

Everything in the four 10 October sections below shipped as manual-only [v0.1.0-beta.13](../releases/0.1.0-beta.13.md): team delegation and projects, plan mode, composer, blob looks, the companion catch-up, sounds, launch, import and the gallery.

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
  - The geometry is adapted from MIT-licensed blobatar (`apps/desktop/src/blob/look/`, credited in `docs/legal/third-party-notices.md` and under the shape picker). It covers seed hashing, the trait reader, the silhouettes and the eye fitting.
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

Done directly at the user's request (no delegation lanes), on top of the composer follow-up below. Not committed. The user said there are no users yet, so old conversation layouts need not be preserved. Usage/quota was deliberately left untouched. Pi/OAuth was dropped: Bitbots keeps running the unmodified CLIs (the t3code-style approach).

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
- Evidence: desktop typecheck, 377/377 Vitest, production build, offline Rust workspace tests and the desktop crate check (short-path worktree) passed. `scripts/live-checks/live-composer.mjs` ran against the installed CLIs with an isolated DB: Codex 0.161.0 identified a red test image and OpenCode 1.18.35 rejected the attachment; Claude Code 2.1.296 could not run because its own CLI sign-in has expired (fails identically outside Bitbots), so Claude image delivery and Claude fast mode remain live-unverified. Native window behaviour is unverified.

## Published follow-up (8 October 2026, beta.12)

Dictation gains a floating always-on-top bubble rendered in its own `dictation` window, adapted from the Waveora bubble without its logo. It shows a live waveform driven by a throttled microphone-level event, a processing spinner, and an error state, and supports hold-to-drag and tap-to-focus. Synthesized Web Audio cues (record start, processing start, processing finish, error) are ported from Waveora; no audio assets are bundled. Rust picks the surface: the bubble when the companion is hidden, or a full-cover companion listening wave when it is visible, so one surface shows visuals and plays sounds. Release commit `6662b14` is pushed to `main` and tagged `v0.1.0-beta.12`. All 361 desktop tests, typecheck/build, the offline Rust workspace suite (including the `bloblex-speech` unit tests), and the unsigned NSIS bundle passed; the installer is 12,719,309 bytes with SHA-256 `1b3aff43ad1a150eb3b3977231bd6024e74151bb36db50f49664e274a01830cb`. [Beta.12](../releases/0.1.0-beta.12.md) is published with the installer and checksum; the signed updater feed remains at beta.6. Live microphone capture, real model inference, and native/live interaction remain unverified; see [the evidence and limits](../evidence/dictation-bubble-2026-10-08.md). Local preview artifacts remain untracked.

## Published follow-up (8 October 2026, beta.11)

On-device dictation is added on a new `bloblex-speech` crate: a sherpa-onnx engine with cpal microphone capture, a pinned Hugging Face model catalog with per-file SHA-256 verification and resume, 16 kHz mono resampling, bounded offline chunking, an owner-locked session lifecycle, and a warm decode worker that releases the model after two idle minutes. The desktop exposes Tauri dictation commands and events, the main and companion composers show a live provisional transcript, Ctrl+E toggles dictation globally, and Settings gains a Speech model manager. Release commit `2d3f16d` is pushed to `main` and tagged `v0.1.0-beta.11`. All 361 desktop tests, typecheck/build, the offline Rust workspace suite (including 19 speech unit tests), the `native` desktop check, and the unsigned NSIS bundle passed; the installer is 12,709,185 bytes with SHA-256 `dabeb15e800bc2efc97f9175eede1ac772de254f389e8102ea26892eede024b9`. [Beta.11](../releases/0.1.0-beta.11.md) is published with the installer and checksum; the signed updater feed remains at beta.6. Live microphone capture, real model inference, and native/live interaction remain unverified; see [the evidence and limits](../evidence/dictation-2026-10-08.md). Local preview artifacts remain untracked.

## Published follow-up (7 October 2026, beta.10)

Composer controls now use source-derived reference motion and real advertised effort levels, a compact reported-context ring, paired-message outline previews and an async hold-to-delete success morph. The daemon fixes initial agent-option lookup, updates after completed turns, context reset ordering/fresh-context resets, and stale resume/turn lock races. Feature commit `146db44` and release source `4aa48f4` are pushed to `main`; the source is tagged `v0.1.0-beta.10`. All 361 desktop tests, typecheck/build, full offline Rust workspace tests from `D:\b10` with live smoke disabled, and the unsigned NSIS bundle passed. [Beta.10](../releases/0.1.0-beta.10.md) is published with the installer and checksum; the signed updater feed remains at beta.6. Source ports retain intentional metadata/theme/RPC differences; see [the evidence and limits](../evidence/composer-controls-2026-10-07.md). Native and real-provider behavior remains unverified. Local preview artifacts remain untracked.

## Current uncommitted follow-up (6 October 2026)

The active scope adds lazy session resume before a prompt is persisted, provider-reported title updates from Codex/OpenCode with explicit rename precedence, persisted provider-reported context and a session-scoped model/effort lock with confirmation on model changes. Claude title updates are not available from the structured stream used by Bitbots; the read-only public-source audit does not establish that `-p --session-id` sessions reliably appear in Claude's session index, so Bitbots keeps its current title rather than reading transcripts or deriving one from prompt text. Claude context uses the latest assistant call's usage paired with that result's matching `modelUsage.contextWindow`; Codex uses current-turn `last.totalTokens` plus optional `modelContextWindow`; OpenCode uses ACP `usage_update` used/size. Individually reported fields can appear on their own, but a percent is displayed only when both used tokens and window size are present; unknown values remain unknown.

The composer now has separate model and effort controls. A changed model requires a warning confirmation; the stored session lock is used on later turns and resume. The message outline uses actual conversation messages and keyboard navigation; conversation deletion uses a hold-to-confirm dialog while retaining cancel/Escape behavior. Focused fake/in-memory and mounted checks have been added. The desktop native window and real provider sessions for these new paths remain unverified; do not point development or tests at the user's database.

Current worktree follow-up: usage is reported-token analytics plus account quota. Active budget admission/warnings and monetary valuation, pricing and subscription UI are retired; migration 10 adds only a quota cache and preserves all existing usage, valuation, pricing, subscription and budget records. Codex quota uses the structured `account/rateLimits/read` app-server method matched against the checked-in Codex 0.159.3 schema. Claude Code quota reads only the access token from the existing Windows `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) and calls Anthropic's OAuth usage endpoint; it never refreshes or writes credentials. OpenCode Go quota reads `OPENCODE_API_KEY`, then an existing `opencode-go` entry from OpenCode `auth.json` or its credential SQLite DB opened read-only/query-only, and calls the OpenCode Go usage endpoint. Generic OpenCode provider usage is not presented as account quota. All three sources emit normalized quota fields only; credentials and raw provider payloads are not persisted, logged, or sent to the UI. Fake credential/API response tests cover source parsing, field normalization, status classification, and secret exclusion. An isolated daemon quota check succeeded with Claude Code 2.1.291, Codex codex-cli 0.160.1, and OpenCode 1.18.34. It used a temporary `BLOBLEX_DB_PATH`, sent no prompts, and did not open the user's database. The sanitized output and docs retain provider/status/window presence only, with no percentages or reset times. Normal cache behavior wrote normalized quota snapshots to the ignored isolated scratch DB at `target/provider-quota-live-smoke/quota.db`; it contains no credentials or raw provider payloads and remains because cleanup was blocked. Native UI behavior remains unverified. The earlier isolated live Claude turn remains the only live provider-turn proof.

`v0.1.0-beta.9` is published as a manual-only unsigned GitHub release; `main` includes its source and release documentation. It contains the 6 October conversation follow-up plus beta.8's usage and quota work. The signed updater feed remains on beta.6. Desktop tests (326), typecheck, production build, full offline Rust workspace tests, daemon cargo check, and the unsigned NSIS bundle pass. Rust tests and the bundle use a short-path checkout because Windows `rc.exe` misparses this repository's apostrophe-containing path. Native chat interaction, clean-machine install, and live provider verification of this follow-up remain unverified.

The recovered Claude UI, daemon, and wardrobe scope is released as `v0.1.0-beta.6` from branch `beta/claude-resume-2026-10-04`. See [the release notes](../releases/0.1.0-beta.6.md) and [implementation status](implementation-status.md). The release feed is published, but a native-window or installed upgrade check remains open.

## What exists

Bitbots is a Windows desktop app: a React/Tauri shell (`apps/desktop`) and a separate daemon (`bloblexd`) that owns sessions, permissions, token usage and normalized quota state. The shell and the companion read the daemon's normalized state. Provider CLIs (Claude Code, Codex, OpenCode) keep their own login.

On main:

- Plan phases 1–6 and 2b: logo, capability record, persisted blobs and the editor, the project/session tree, execution options and adapters, usage analytics, settings with ask / auto / bypass approval modes.
- Auto-update from GitHub releases (stable and beta channels, signed NSIS updates) and the release script; see [docs/operations/updater.md](updater.md) and [docs/operations/release-checklist.md](release-checklist.md).
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

Native development, only when a person is ready to launch the app, is `npm run desktop:dev` with an explicit isolated `BLOBLEX_DB_PATH`. See [docs/guides/windows-development.md](../guides/windows-development.md). Never point a test or a dev run at `%LOCALAPPDATA%\Bloblex`.

Releases: [docs/operations/release-checklist.md](release-checklist.md). The update signing key lives outside the repo and must never be committed.

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
