# FIX39 research audit (Claude Sonnet 5.5)

> **What this is:** Audit of the FIX39 research by Claude Sonnet 5.5, before implementation.
> **Status:** historical
> **Last updated:** 2026-10-18

Audit of `docs/history/fix-39/research-r1.md` (items 1–15), `R2.md` (16–20) and `R3.md` (21–24) against the 24 owner items in `docs/history/fix-39/feedback.md`. I changed no code and no existing file. Every verdict below comes from opening the cited range in the tree; where I could not check something I say so.

**Not re-run by this audit:** R3's live-machine evidence for item 23 (`netstat`, `Get-CimInstance`, `tailscale ... --json`, `app_events` rows). The shell asked for approval and I did not take the risk of touching processes. The code paths R3 cites do prove the failure mechanism (see item 23), but the Director should re-run those read-only commands before telling the owner "an orphan daemon is running right now". Nothing was viewed in a browser or the preview; every visual item (1, 4, 5, 6, 8, 9, 24) still needs the Director's own look at both themes and both looks.

**T3 Code claims** (items 20, 22) I checked against T3's own docs on `raw.githubusercontent.com/pingdotgg/t3code`: `docs/user/outside-agents.md` (MCP at `<env>/mcp`, OAuth plus pairing code, Read only / Supervised / Full, 30-day sign-in, revocable under Settings → Connections) and `docs/orchestration-v2/provider-switching-and-context.md` (resume the provider thread by default; fresh provider thread with a full app-thread summary when resume fails, plus other triggers). Both match R2/R3. R2 cites `docs/internals/context-handoffs.md` for the resume-first rule; that page only covers the handoff summaries (240 characters per item). The rule itself is in the other page. Minor.

## Verdict table

| # | Item | Verdict | One line |
|---|------|---------|----------|
| 1 | Usage dialog | Confirmed | Design fine; add tooltip z-order and keyboard checks. |
| 2 | Effort "Model default · Medium" | Confirmed | One span; there is no CSS or test to clean up. |
| 3 | Two search affordances | Confirmed | Missed an existing test that types into the roster box. |
| 4 | Bot shapes | **Partly right** | Missed that the daemon validates shape names; shuffle/colour details thin. |
| 5 | Update banner | Confirmed | Dead class `pill-button`; test file named wrongly. |
| 6 | Launch checklist | Confirmed | Proposed `max-content` width makes the block jump; use a fixed width. |
| 7 | Manager card | **Partly right** | Causes 1–3 real; cause 4 (onboarding race) unproven. Fix is still simple. |
| 8 | Manager star badge | Confirmed | Icon swap; 8 px is too small for a star. |
| 9 | Settings dividers | **Partly right** | `:first-child` would misfire; use a sibling combinator. |
| 10 | Companion free drag | **Partly right** | Snap is real, but position persistence on every move is a second lag source. |
| 11 | Experimental tab | Confirmed | Two existing tests assert the old location. |
| 12 | Model under the name | Confirmed | Fine as an experiment. |
| 13 | Lock a bot | **Partly right (design wrong)** | A device-local lock does not stop the Manager or the daemon. Must live in the daemon. |
| 14 | "Unknown" usage | Confirmed | `SUM()` over no rows is `NULL`. Add a whole-period empty state. |
| 15 | Notice as preview | Confirmed | Skip every system notice, not only `context_reset`. |
| 16 | Composer per bot | Confirmed | Root cause exact; open-conversation semantics needed a decision (made below). |
| 17 | Activity unreadable | Confirmed | Old stored turns need a UI-side fallback, not only a better adapter title. |
| 18 | Manager multitasking | Confirmed | Drain must be global, not per session; queue is in memory only. |
| 19 | Sub-conversation permissions | **Partly right** | Missed the most likely cause: the composer change only pinned the bot's own conversation. |
| 20 | Context lost after restart | Confirmed (mechanism) | Trigger still unproven. Plain answer below. |
| 21 | Manager orchestrator / tags | Confirmed | Agree with not inlining the project index; extra reason below. |
| 22 | MCP to control Bitbots | **Partly right** | Feasible, but the proposed endpoint would reject every MCP client as written. Plain answer below. |
| 23 | Tailscale won't turn on | Confirmed | Code proves it; live evidence not re-run. |
| 24 | Browser vs phone layout | Confirmed | Good design. |

---

## Item-by-item

### 1. Usage dialog — Confirmed
`App.tsx:2920-2956`: heading line is `Plan usage limits` + a trailing `<span>Reported by each CLI account</span>` + refresh; the footer sentence and scope line are as quoted. `Tip` exists (`Tip.tsx`) and portals its bubble to `document.body` (`Tip.tsx:20`).
- **Design:** sound. Do both: drop the footer sentence and put the explanation in the tooltip.
- **Check:** `.sheet-backdrop` is `z-index: 40` (`theme.css:401`); confirm `.tip-bubble.tip-portal` (`tooltipPortal.css`) sits above it, or the tooltip hides behind the dialog. The info button needs an `aria-label` and the tooltip must open on keyboard focus.
- **Tests:** R1 names no existing usage-sheet test, and I found none (`SidebarUsage.test.tsx` is the sidebar meter). Add a new mounted test: heading line holds the divider, the note and the info button; footer sentence gone; focusing the button shows the tooltip.

### 2. Effort picker — Confirmed
`SessionExecutionControls.tsx:330` is the only place. I found no CSS rule for `session-effort-default-label` and no test that mentions "Model default ·", so R1's "update the popover assertion" is moot. Delete the span; add a test that at Max the popover contains no "Model default" text.

### 3. Search — Confirmed, with a miss
Icon `App.tsx:2384`, box `TeamSidebar.tsx:300-303`. **Missed:** `App.agent.mounted.test.tsx:837-839` types into `input[aria-label="Search bots"]` to filter the roster; it must be rewritten (the box stops being an input). Also remove the `search`/`query` plumbing (`App.tsx:358`, `manager && !query` branches) rather than leaving dead state, keep `.sidebar-search` styling (also in `bitbots.css:295`), make the new button keyboard-operable, and show the `Ctrl K` hint. The owner already decided "box opens the quick switcher", so there is no open question.

### 4. Bot shapes — Partly right
Confirmed: shape list `forms.ts:13`, labels `index.ts:26-29`, seeded `body.rot` for boxy/hexagon/triangle (`forms.ts:213,240,257`), spline lumps for organic/cloud, `shuffleLook(..., true)` re-rolls shape (`index.ts:127-130`), `randomBot()` re-rolls the robot outline (`bot.ts:118-124`).
**Missed or wrong:**
1. **The daemon validates shape names.** `crates/bloblex-storage/src/lib.rs:5185` (`valid_look`) hard-codes the ten old names; any `agent.create/update` with `circle`, `pebble` or `squircle` fails with `InvalidAgent`. R1's migration "in `normalizeLook`" alone would break saving. The Rust list must accept both old and new names (old ones stay readable forever).
2. **Other shape consumers R1 did not list:** `ui/botTemplates.ts:91` (`shape: 'organic'`), `blob/look/bot.ts:93` (`SHAPE_FOR_BLOB` map for Bitbots mode), `index.ts:141` (`SEEDED_FACES`), `index.ts:72-75` (`agentLook` default).
3. **Symmetry is wider than `body.rot`.** Eyes are also seed-driven and asymmetric (`eye.lean`, `gaze.x`, per-eye variation in `faceFit`). "Symmetrical by default" must include mirrored eyes at rest. The seed may still vary eye size/spacing/shape (the owner wants shuffle to change the eyes), but not lean or body outline.
4. **"Surprise me" and colour.** `LookEditor` already receives `color` and `onColorChange` (`LookEditor.tsx:44-49`; callers `BlobSettings.tsx:235`, `FirstRunOnboarding.tsx:137`), so Surprise me can pick a random palette colour. R1 stated the intent but not the mechanism. Both buttons must keep `look.shape`; in Bitbots mode `randomBot` must keep the current robot outline and only pick colours.
5. **No visual reference reaches the implementer.** `grokbots.ai/studio` is a website; Sol may not be able to fetch it. The Director must hand over target pictures (or SVG paths) for the eight shapes and the pill eyes. Without that, the result will be subjective.
- **Decided (no owner question):** the owner named the eight target shapes. Chooser = Circle, Pebble, Squircle, Capsule, Triangle, Hexagon, Cloud, Droplet. Migrate `round→circle`, `organic→pebble`, `boxy→squircle`, `sun→circle`, `cat→pebble`; keep the rest. Keep the blobatar credit if the geometry stays derived.
- **Tests that fail today:** every chooser shape has `rot === 0` and a mirror-symmetric outline within tolerance for several seeds; `shuffleLook` never changes `shape`; `normalizeLook({shape:'cat'})` returns the migrated shape; Rust `valid_look` accepts new and old names; `LookEditor` mounted test: click Surprise me, selected tile unchanged, colour changed.

### 5. Update banner — Confirmed
`UpdateBanner.tsx:23-24` uses `pill-button`, which no stylesheet defines. Use the same `primary-button small` / `ghost-button small` classes the settings forms use. R1's test file name is wrong: no test mentions `pill-button`; the banner is tested in `updates.mounted.test.tsx` (`[data-update-banner]`). Add class assertions there.

### 6. Launch checklist — Confirmed, fix adjusted
`shell.css:425` (`justify-content: center` per row) is the cause. R1's fix (`.launch-checklist { width: max-content }`) makes the block's width follow the longest row, so the whole block shifts sideways each time a longer row appears. **Use a fixed block width** (for example `width: min(320px, 100%)`, margin auto), `justify-content: start`, second column `minmax(0, 1fr)`, and ellipsis on long detail text. Test: mounted check of the class names; Director confirms visually in the preview launch page.

### 7. Manager card — Partly right
Confirmed real: sessionStorage dismissal (`ManagerSetupCard.tsx:11-28`), `runtimes.length === 0 → null` (line 27), and the `hasActiveBlobs` gate (`App.tsx:2399`).
**Unproven:** R1's cause 4. The first-run effect (`App.tsx:894-906`) only opens onboarding when there are no agents, no sessions and no prior-use key, so it cannot replace the shell for someone who already has bots. Nobody has shown how the friend reached onboarding. Do not build the "wait for snapshot" guard as the fix; it is harmless as a defensive extra but it is not the cause.
- **Design (simple and sufficient):** show the card whenever `!managerOf(agents)` and the daemon is connected, regardless of `hasActiveBlobs` and regardless of runtimes (disabled with a short note when none is usable). Delete the dismissal and its X entirely. Onboarding stays as is for brand-new installs.
- **Tests that fail today:** no Manager and zero bots → card shown; no Manager with bots → card shown after a simulated earlier "Later"; `runtimes=[]` → card shown and the Create button disabled; no close control in the DOM.

### 8. Star badge — Confirmed
`TeamSidebar.tsx:286` (`BriefcaseBusiness size={8}`), `.leader-badge` `team.css:22`. Use a filled `Star` at about 9–10 px (the 15 px circle is fine); at 8 px it will read as a dot. This is the only star allowed (`no-star-icons` memory); keep `BriefcaseBusiness` everywhere else (card, settings nav, Manager page). Check whether any other place draws a Manager avatar with a badge (`CompanionTeam.tsx:96` uses `agent.leader`, not the Manager, so leave it). Test: badge contains an `svg`; no `Sparkles`/`Wand` anywhere (existing grep rule).

### 9. Settings dividers — Partly right
`settings.css:26` confirmed (22 px gap only). R1's `:first-child` reset assumes each page's first `.settings-group` is the container's first child; pages have a header/search above it, so the first group would get a border directly under the page title. Use `.settings-group ~ .settings-group { border-top: ...; padding-top: ... }`, keep the margin, and use `--line` (and a Bitbots-look override if `bitbots.css:198-220` fights it). The bot wizard (`botWizard.css:25`) reuses the component; verify there too. Verify in all four combinations (light/dark × default/Bitbots look); this is CSS only, so the proof is a Director screenshot, not a unit test.

### 10. Companion free drag — Partly right
Confirmed: `lib.rs:1933-1964` (380 ms timer then `set_position`), invoked at `lib.rs:2082`; `companionSnap.ts` has no production importer (only `companionSnap.test.ts`).
**Missed:** the same `Moved` handler calls `persist_companion_position` on **every** move event (`lib.rs:2081`), and that function queries monitors and writes a temp file plus rename (`lib.rs:1966-2000+`) synchronously on the window-event thread. That is a likely cause of the lag the owner describes. Removing the snap alone may not fix it.
- **Design:** remove the snap (function, generation/flag locals, `mod snap`, `snap.rs`, `companionSnap.ts` and its test) **and** debounce the persistence (write after about 300 ms without a move, same generation-counter pattern, plus a final write on close). Keep the launch-time clamp and the explicit "reset companion position".
- **Tests:** a Rust unit test for the debounce helper (N rapid moves → one write after quiet); compile with `-D warnings` (unused imports after removal). Manual proof by the Director: drag the companion, release, it stays; Windows only.

### 11. Experimental tab — Confirmed
Page union and list `SettingsSheet.tsx:44-57`; group `560-584`; index entries `settingsIndex.ts:49-50`. Existing tests that encode the old location and must change: `SettingsSheet.appearance.mounted.test.tsx:73-74` (finds a group titled "Experimental") and `platform.browser.mounted.test.tsx:65` (expects the word on a page). Index entries should also be added for every `EXPERIMENTS` row so settings search finds them. Move the whole group including "Longest wait for a rate limit" and the Steer toggle.

### 12. Model under the bot's name — Confirmed
`TeamSidebar.tsx:223,294`, helpers `presentedModelName`/`labelizeEffort`, catalog `readCached`. Fine as an experiment toggle. Rules to implement: status ("Working…", "Waiting for you", offline) wins while busy; idle shows `Model · Effort`; no explicit model shows "Default model"; use the bot-level setting (consistent with item 16). Pure helper `sidebarSubtitle` with unit tests. The `docs/design/design-system.md:9` amendment goes to the documentation lane, not the implementer.

### 13. Lock a bot — Partly right, design is wrong
Menu (`TeamSidebar.tsx:143-174`) and badge slot (`284-287`) are right. The storage choice is not. R1 proposes a device-local `localStorage` list and guards only UI call sites. The owner says "a locked bot's settings cannot be changed at all". These paths do not go through the UI and would ignore a UI-only lock:
- the Manager's `update_blob` tool (`team.rs:218`) and an approved `propose_bot`/update card (`proposals.rs`);
- any other `agent.update` / `agent.team.update` / `agent.delete` / `session.model.update` caller (`main.rs:855`, `2450+`);
- the companion window and Remote (agent writes are never remote, but a Manager-originated change is not UI);
- a cleared webview profile or a restored backup, which would silently unlock every bot.
R2 spotted the gap ("the lock must be enforced in the daemon") but R1's package still uses localStorage.
- **Design:** an `agents.locked` column (precedent: `notification_level`/`hidden` columns in `crates/bloblex-storage/src/lib.rs`), exposed as `locked` in the agent JSON, changed only by a dedicated `agent.lock.set {agentId, locked}` RPC (a new method needs a `never`-remote row in `tiers.json`; see risks). The daemon rejects with a clear `conflict` ("This bot is locked. Unlock it to change its settings.") every write to a locked bot except the unlock itself and presentation-only ones the owner would expect to still work (sort order, sidebar pin, hidden flag decided below). Covered: `agent.update`, `agent.delete`, `agent.restore`, `agent.team.update`, `session.model.update` and the new permission RPC for its sessions, the Manager `update_blob`, proposal apply for that bot, and prompt-time nothing (the lock does not stop chatting).
- **UI:** badge (neutral lock circle, not the Manager's orange, offset if both), menu item "Lock bot / Unlock bot" (Lock only offered when the experiment is on; Unlock always offered so a bot can never get stuck locked when the experiment is later turned off), disabled composer controls with a tooltip, read-only editor with a banner, disabled menu entries.
- **Decided (no owner question):** the Manager cannot be locked (recovery path stays open); the lock covers composer model/effort/speed/permission, rename, instructions, runtime, project, archive/delete, and the Manager's changes. Hide/sidebar pin/reorder stay allowed (they are layout, not settings).
- **Tests that fail today:** daemon: locked bot → `agent.update`, `session.model.update`, Manager `update_blob` all return the lock error, unlock works, lock survives restart; Rust test for the Manager tool; UI mounted: lock from menu shows badge and disables controls, Unlock available with experiment off.

### 14. "Unknown" usage — Confirmed
`usagePresentation.ts:4`; the daemon's `SUM()` over zero rows returns `NULL` (`storage lib.rs:4264`), so an empty day yields five `Unknown`s. A change to the single word `N/A` fixes the word but leaves five identical `N/A` lines. **Design:** per bucket `null/absent → "N/A"`, `0 → "0"`; when all five are null show one line "No usage yet" (period name) instead of the grid. Update `usagePresentation.test.ts:8,11`; add the all-empty case. Leave the companion glance (`App.tsx:3561`) alone unless the Director sees the same complaint.

### 15. Sidebar preview shows notices — Confirmed
`teamSelectors.ts:40-53` falls through to text for `context_reset` notices; `conversation.ts:49` already has the right predicate. **Make it stronger than R1:** skip every `role === 'notice'` except the explicitly handled kinds (`delegation`, `blob_created`) so no future system notice (model change, bypass banner) leaks into the preview. Tests: last real message wins over a trailing `context_reset`; conversation with only notices returns `null`; delegation/created previews still work. This also fixes the companion list (`CompanionTeam.tsx:47`).

### 16. Composer settings per bot — Confirmed
Chain verified end to end: draft session `draft:<agentId>` (`App.tsx:543-545`) is passed to `PermissionModeControl` and `SessionExecutionControls`; `ComposerControls.tsx:79-87` calls `session.model.update` with the draft id; the daemon answers `not_found` (`main.rs:2457`). `agent.update` accepts `approvalMode/model/thinking/serviceTier` (`main.rs:855`).
**Decision the report left open (Q1):** the owner's sentence is explicit ("apply to the bot at once and to every later conversation, with or without a conversation open"), so this is not a question. Rule: **the composer always writes the bot** (`agent.update`). For an open real conversation, additionally bring that conversation in line: permission → clear the conversation's pin so it follows the bot; model/effort/speed → keep today's `session.model.update` (with the existing confirmation, because a model change starts a fresh provider session and loses context, see item 20). Mid-turn the conversation-level part must not error: permission uses the new "set for next turn" RPC (item 19); a model change mid-turn stays blocked with the existing message and the bot-level write still succeeds.
- Replace "Applies to this conversation only." and the "this conversation" labels with the bot wording.
- Stop passing a draft id to `runtime.models`/`runtime.capabilities`.
- **Tests that fail today:** draft selected → choose Auto → `agent.update` called, `session.model.update` not called, no error text; real session → agent updated and pin cleared; locked bot → controls disabled; daemon test: `agent.update{approvalMode}` then options for a **new** session carry the new mode.

### 17. Activity unreadable — Confirmed
Verified: the Claude adapter sets `title` and `kind` to the bare tool name (`adapter-claude/src/lib.rs:565-574`); `activityTitle` returns `detail.command` whole (`ActivityDetails.tsx:43`); Glob/Read/Grep count as "tool"; steps render as a flat `<ol>`; `tool_detail` already stores `tool`, `input` (pretty JSON), `path`, `command`.
**Adjustments:**
- Existing conversations are already stored with bare titles. The UI must derive the readable label from stored `detail` (`tool` + `input`/`path`/`query`) so old turns also improve; a better adapter title only helps new turns. `input` is clipped at 1500 chars, so the label builder must tolerate unparseable JSON and use `path` when present.
- Add the new fields (`pattern`, `url`, `label`) in `tool_detail` and the adapter title, but treat the UI derivation as the primary path.
- Owner decision is already stated ("command text available on demand"), so Q2 needs no answer: collapsed label = first words of the command plus target ("Ran cargo test"), full text only after expand.
- Grouping: subheadings inside the expanded list (Commands, Files, Searches, Edits, Other), collapsed summary line unchanged.
- **Remote:** `activity`/`tools[].detail` pass through the Remote redaction (`remote/policy.rs:450`, `ToolDetail` drops detail unless tool output is allowed, with a TypeScript twin). New fields carry file paths and command heads. The implementer must run the Remote policy parity tests and add a case proving new fields follow the same rule.
- **Tests that fail today:** Rust: `tool_activity` for Claude Bash/Glob/Grep/Read/Edit, Codex command/search, ACP titles; storage `tool_detail` returns `pattern`/`url`; UI: title-less Glob with input `{"pattern":"**/*.ts"}` → "Searched **/*.ts"; a 3-step fixture groups into the expected subheadings and shows the full command only after expand.

### 18. Manager multitasking — Confirmed
Chain verified: `delegate` creates the side session and spawns `deliver` (`team.rs:413-462`); `deliver` calls `session_prompt_for_team`; admission refuses (`main.rs:2889-2891`, per-agent cap `storage lib.rs:3420-3438`, default 1; global 4); the message is queued against the empty side session; only `after_turn(side)` drains it, which never fires. `message_blob` still tells the Manager "They are working on it" (`team.rs:410`).
**Corrections to the design:**
- The drain trigger must be **any** turn ending, not only turns of that agent, because the global cap of 4 can be what refuses. On every `after_turn`, try every idle session that has queued deliveries.
- `st.team.queued` is in memory (`team.rs:571,577`); a restart loses it. On startup, for sessions that carry a "waiting" notice but have no turn, tell the origin through the existing `relay_failure` path rather than leaving a ghost.
- Visibility without new plumbing: when a delivery is queued, append a notice to the **side session** ("Waiting for <Bot> to finish another conversation"). A non-empty session no longer renders "Ready when you are." (`App.tsx:2483`). The Manager's tool result must say "started" or "queued".
- The concurrency default is a real owner decision (see Owner questions); the code fix works with the cap left at 1 and must not depend on raising it.
- **Tests that fail today:** one bot with cap 1, two side sessions: the second reports queued, shows the waiting notice, starts when the first ends, both end with their messages; four busy sessions of other bots → fifth is queued, then starts when any ends; `message_blob` text differs for started vs queued.

### 19. Permissions in a sub-conversation — Partly right
Verified: the composer is hidden for side sessions (`App.tsx:2525`), `session.model.update` conflicts during a turn (`main.rs:2458`), side sessions reject user prompts (`main.rs:2801`), the Manager cannot change permissions (`team.rs:218`), `apply_task` validates the project then drops it (`proposals.rs:402-414`), and the `auto` classifier is path-scoped.
**Missed, and probably the friend's actual cause:** the permission control writes a **conversation pin** (`modelLock.approvalMode`, "Applies to this conversation only", `ComposerControls.tsx:108`, `main.rs:2525-2559`). A side session never gets a pin and follows the *bot's* mode (`exec_options_for_session`, `main.rs:1407-1427`). So "I changed the Haiku bot's permissions" changed only Haiku's own main conversation; the sub-conversation kept the bot's setting. Item 16 (composer writes the bot) removes this trap by itself, with the change taking effect from the sub-conversation's next turn.
Still needed, smaller than R2 proposes:
1. **Header control** on a side conversation: show the effective mode and let the owner change the **bot's** mode (same control as the composer), labelled "applies from the next turn".
2. **One narrow RPC** `session.permissions.set {sessionId, approvalMode|null}` that only edits the pin, allowed mid-turn (effective next turn, no relaunch), refused for automation sessions (existing rule `main.rs:2546`), refused for locked bots.
3. **Manager:** a proposal kind `permission` for a side conversation it started, owner approves the card; allowed values Ask first / Auto only; Full access is never settable by the Manager. (Decided from R2's Q5, which matches the Manager rules: consequential actions are proposed.)
4. **Project path** (P6): pass the task's project into the delegated session (`apply_task`). Because this widens where `auto` can write, the task approval card must show the folder it will run in. This is the real fix for "paths still denied after the retry", and it is independent of any mode change.
5. **Denial text:** include classifier category and path in the permission notice (`permission_summary`, `agent-core lib.rs:17`).
- **Tests that fail today:** after item 16, bot set to Auto → next side-session turn classifies as auto (daemon test through `exec_options_for_session`); `session.permissions.set` mid-turn records for the next turn; Manager `permission` proposal applies only after approval and rejects `bypass`; `apply_task` with a project starts the session in that folder.

### 20. Context lost after a restart — Confirmed (mechanism), trigger not proven
Verified in `main.rs`: resume vs fresh (`2138-2143`, `2210-2224`), fallback that starts a brand-new provider session (`2041-2110`), notice appended (`2283-2287`), and the new session receives no history (`NewSessionRequest` carries only id, path, options). Plain answer for the owner is below.
Gaps in R2:
- **Two paths** produce the same notice: `resume_or_start_fresh` (resume rejected) and the branch where `can_resume_saved_provider` is false but `previous_had_turns` is true (`main.rs:2210-2224`). The recap must be armed on both.
- **Most plausible trigger for this friend:** the first message timed out ("took too long"), the daemon killed the CLI before the CLI saved the session, so the later resume is rejected. A recap from Bitbots' own history, **including the last unanswered user message**, fixes the felt problem even though the exact failure is unproven. One reproduction (timeout, quit, reopen, read `session.resume_rejected`'s `outcomeNote`) is still owed.
- R3 found two daemons sharing one database on the owner's machine (item 23). Unproven as a cause here; the item 23 package removes it either way, and the Director should note it when reproducing.
- **Design is right** (T3's fallback, not T3's graph model). Requirements: a persisted boolean `recapPending` in session data (not the text, so it survives a restart between fallback and the next prompt), the recap built from the DB when the next prompt is delivered, bounded (last N messages clipped, files changed, commands run), treated as inert quoted data (escape like `reply_prompt_context`, `main.rs:2602`), appended to that one prompt only, never stored and never logged. Arm it also after a model change for every non-Manager bot (`main.rs:2568`); the Manager keeps `<bloblex_handover>`. Notice text: "…the agent was given a summary of the conversation" when a recap exists, current text only when there was nothing to summarise. Keep `meta.kind: "context_reset"` so item 15's filter still works.
- **Do not change the instruction text per project/tag update** (item 21): Codex tracks an instruction hash per thread (`main.rs`, `codex_thread_instruction_sha256`); changing instructions can force a new thread, which is exactly this bug.
- **Tests that fail today:** fake adapter rejecting resume → next prompt text contains the recap block with the last messages, block absent from stored messages, notice says a summary was given; the `can_resume_saved_provider == false` branch also arms it; warm-up of a never-prompted session stays silent; model change on a non-Manager bot arms it; recap size bound enforced; hostile text containing `</bloblex_recap>` does not break out.

### 21. Manager as orchestrator / tags — Confirmed
Verified: no tag columns on `projects` or `agents`; `project_update` accepts only name/path/description/collapsed/sortOrder (`storage lib.rs:1712-1745`); `list_blobs` shows provider, project, busy, description (`team.rs:312-333`); the Manager is told to call `list_projects` (`team.rs:147`). R3's design (tags on both, tags shown by `list_projects`/`list_blobs`/`project_status`, Manager `update_project` for description/tags, one added instruction line, no inlined index) is right. Extra reason not to inline the index: instruction text changes interact with Codex thread instruction hashing (item 20). Tag validation reuse of `memory_validate_tags` is good. Needs: a locked bot's tags are locked too (item 13); migration tests (existing DB gets `tags = '[]'`); tag edits reach the UI through the existing `project.changed`/`agent.changed` events.
**Ambiguity in the owner's words:** "know the projects in the user's workspace" could mean projects registered in Bitbots (what the Manager sees today) or folders on disk (a scan). Nothing scans. See Owner questions.
- **Tests that fail today:** storage round-trip, validation, `[]` clears, migration; Manager tools print tags; a non-Manager `update_project` is refused; mounted tag editor saves via `project.update`/`agent.update`.

### 22. MCP to control Bitbots — Partly right (answer below)
Verified: `bitbotsd mcp-bridge` over stdio, per-session team token, `mcp.*` methods authorised by that token (`main.rs:359-368`), the Manager/bot tool lists (`team.rs:196-231`); the gateway router has no MCP route (`remote/web.rs:81-100`).
**R3's phase-1 design would not work as written:**
1. `require_origin` refuses every non-GET request without a matching `Origin` header (`web.rs:121-124`). MCP clients are not browsers and send none, so `/api/mcp` mounted under the guarded router rejects every call. It needs its own route group with bearer-token authorisation, keeping Host checks and the abuse limiter but not the cookie/Origin rule.
2. **TLS trust:** Native uses a self-generated certificate; Claude Code and Codex reject it by default. Only the Tailscale method gives a trusted certificate. A same-machine agent would want a loopback endpoint, which is a new listener and needs an `AGENTS.md` amendment (today only the daemon API and the gateway listen).
3. Coupling to "Remote on" is awkward: using it from the same computer would require turning on a phone feature.
4. The wide security list (hashing tokens, tiers, parity test, redaction, never-list) is right and reusable.
Not a FIX39 build item; see the plain answer and Owner questions.

### 23. Tailscale won't turn on — Confirmed (code); live evidence not re-run
Verified in code: loopback bind of fixed port 48620 returns "Port 48620 is already in use on this computer." (`remote/mod.rs:771-778`) before any `tailscale serve` call; the UI discards the daemon's text for any rejection that is a plain string (`useRemote.ts:141-145`, `rpc` rejects with a string from `invoke`, `executionContract.ts:103` `rpcFailure` already handles strings); no single-instance plugin (`Cargo.toml:21-28`); Native uses 48621 so it works. That fully explains the owner's symptom whichever process holds the port.
Design notes:
- **Fix the message first.** Same helper for the three other copies R3 found (`ManagerPage.tsx:99`, `MemoryPage.tsx:77`, `SchedulesView.tsx:129`).
- **Bind first, probe after failure** (R3 says probe before bind; that races). On bind failure, `GET /api/ping`: if a Bitbots gateway answers, refuse with the "another copy of Bitbots is serving Remote, quit it" message and set `port_in_use`; if something else holds the port, fall back to the next free port and persist it. Extend `/api/ping` with a fixed marker, no user data.
- **Daemon lifetime:** a parent-process watchdog in the daemon (exit when the parent is gone) is smaller and unit-testable; a Job Object is optional hardening. `tauri-plugin-single-instance` is a reasonable addition but is a new dependency in the shell and changes second-launch behaviour (focus the first window); the Director should accept that knowingly.
- **Tailscale states:** add `starting` and `not_running` (stderr), keep `logged_out` for `NeedsLogin`. Fine.
- **Do not kill the orphan automatically** (R3's Q2 recommendation is right, and the owner's own machine is not ours to clean without asking, see risks).
- **Tests that fail today:** `useRemote` shows the daemon text for a string rejection; port held by a Bitbots gateway → conflict message and `port_in_use`; port held by a stranger → fallback port and the serve argv carries it (the `FakeCli` in `tailscale.rs` records argv); `BackendState: "Starting"` → `starting`; watchdog test (child exits when parent pid disappears).

### 24. Browser vs phone layout — Confirmed
`remote.css:8-16` confirms the phone frame on wide screens. R3's design (resolve by width ≥ 900 px **and** `(pointer: fine)`, manual Auto/Phone/Wide override stored in `localStorage` with try/catch, one component tree with a `data-layout` attribute, no user-agent sniffing) is good and file-disjoint from everything else. Keep the override small. Tests: `resolveLayout` table, mounted test with mocked `matchMedia`, `remoteBuild.test.ts` still passes. Director proof: a real wide window and a phone-sized window; real phone on the tailnet remains unverified (as at beta.30).

---

## Plain answers for the owner

### Item 20: how can a conversation lose its context after a restart?

Two different things are called "the conversation".
- **The transcript** (every message you see) is stored by Bitbots in its own database. That is never lost by a restart.
- **The agent's memory** of the chat lives inside the coding tool (Claude Code, Codex or OpenCode keep their own saved session). When you reopen a chat, Bitbots asks the tool to resume that saved session. If the tool says it cannot, for example because the earlier turn timed out and was cut off before the tool saved it, Bitbots starts a brand-new tool session and shows "Started a fresh session. The agent no longer has earlier context."

The real flaw is what happens next: Bitbots starts the new session **empty**. You still see the old messages, but the agent has never seen them. Bitbots has the full history and does not give it to the agent. That is a gap in Bitbots, not a problem with how it connects to the tools.

**Does T3 Code do it better?** Yes, in exactly one way, which I checked in its documentation. It connects to the same tools in the same way (Claude Code, Codex, OpenCode). It also tries to resume first. When resuming fails it starts a fresh session **and gives the agent a written summary of the conversation**. So the agent keeps the thread.

**Should we switch to ACP?** No. Claude Code and Codex are used through their own native connections, as T3 does. ACP would not make them resumable, and we already use it for OpenCode. Changing the connection would not fix this.

**What we will do:** when a resume fails (and after a model change), send the agent a bounded summary of the conversation, built from Bitbots' own record, with the last unanswered message. It is a summary, not a word-for-word replay; there is no way to restore the tool's private memory exactly. Separately, we still owe one clean reproduction of the exact failure the friend hit (timeout, quit, reopen).

### Item 22: can bots or the Manager control Bitbots through an MCP, like T3 Code?

**Short answer: partly yes today, and the rest is possible but a new, security-sensitive feature.**
- **Today:** every bot and the Manager already get a private MCP inside Bitbots. Through it they can list and message teammates, open side conversations, schedule tasks (held for your approval), and the Manager can propose projects, bots and tasks (you approve each card). This is deliberately limited: they cannot change settings, other bots' permissions, files or Remote.
- **What T3 Code has that we do not:** an MCP address that **outside** agents (Claude Code, Codex, ChatGPT…) can connect to. You approve each agent with a pairing code, choose Read only / Supervised / Full access, see it listed in Settings and can revoke it; the sign-in lasts 30 days.
- **Is that possible for Bitbots?** Yes. We already have most of the parts (device pairing with your approval, hashed tokens, permission tiers, a rule that no command is allowed remotely without a table entry, an activity log). The work is a new endpoint, a new kind of revocable credential, and a tool list with per-level rules.
- **The real risk:** an outside agent that can send messages to your bots can make them run commands on your computer (prompt injection). So the first version should be read-only, off by default, and never raise a bot's permission mode.
- **Recommendation:** do not build it in FIX39. It needs your decision on where it listens (phone/tailnet only, or also this computer) and the Remote threat-model review that is already owed. The design in R3 needs the corrections listed under item 22 above.

---

## Implementation packages

Rules for all packages: the implementer never runs `git commit`; the Director runs the gates after each merge (`cargo fmt --check`, clippy `-D warnings`, `cargo test`, `npm run typecheck`, tests, build). **No implementer edits `docs/design/design-system.md`, `docs/design/product.md`, `docs/legal/third-party-notices.md` or any `docs/` file**; the documentation lane (Haiku) records the `docs/design/design-system.md` changes for items 4, 8, 12, 13 afterwards. Every new daemon method or event must get a row in `apps/desktop/src/remote/tiers.json` (parity test); new write methods are `never` remote.

Hot files are `crates/bloblex-daemon/src/main.rs`, `team.rs`, `proposals.rs`, `crates/bloblex-storage/src/lib.rs`, and `apps/desktop/src/ui/App.tsx`, `TeamSidebar.tsx`, `SessionExecutionControls.tsx`, `teamSelectors.ts`. They are assigned to exactly one package per wave.

**Sequence:** Wave A = P1, P2, P3, P4 in parallel (disjoint files). Wave B = P5, only after P1 and P2 are merged. Wave C = P6, only after P5 is merged. Merge P2 before P4 ships (P4's new shape names need P2's Rust change).

### P1 — Shell polish (items 1, 2, 3, 5, 6, 7, 8, 9, 14, 15)
- **Files:** `ui/App.tsx` (UsageSheet/QuotaDetails ~2918-2957, header icon ~2384, banner prop ~2399, onboarding effect only if needed), `ui/TeamSidebar.tsx` (search box, badge icon only), `ui/ManagerSetupCard.tsx`, `ui/UpdateBanner.tsx`, `ui/SessionExecutionControls.tsx` (line 330 only), `ui/usagePresentation.ts`, `ui/teamSelectors.ts` (`conversationPreview`), CSS: `shell.css`, `styles.css`, `bitbots.css`, `settings.css`, `botWizard.css`, `team.css`, `managerSetup.css`; tests: `App.agent.mounted.test.tsx` (rewrite 837-839), `updates.mounted.test.tsx`, `usagePresentation.test.ts`, `teamSelectors.test.ts`, `QuickSwitcher*`, a new `ManagerSetupCard.mounted.test.tsx`, a new usage-sheet test.
- **Done:** each item's behaviour as written in the audit above, with failing-first tests: usage heading line + tooltip + footer gone (1); no "Model default" text at Max (2); icon gone, box opens the switcher, keyboard works (3); banner buttons use system classes (5); checklist rows share one left edge in a fixed-width centred block (6); Manager card shown with no dismiss in the three conditions (7); star badge (8); sibling-combinator dividers (9); N/A and "No usage yet" (14); preview skips system notices (15). Director screenshots for 1, 5, 6, 8, 9 in both themes and both looks.
- **Depends on:** nothing. **Blocks:** P5.

### P2 — Readable activity, plus daemon shape acceptance (items 17, and the Rust half of 4)
- **Files:** `crates/bloblex-agent-core/src/lib.rs` (`tool_activity`), `crates/bloblex-adapter-claude/src/lib.rs`, `crates/bloblex-adapter-codex/src/lib.rs`, `crates/bloblex-adapter-acp/src/lib.rs`, `crates/bloblex-storage/src/lib.rs` (`tool_detail` and `valid_look` only), `ui/ActivityDetails.tsx`, `ui/conversation.ts`, remote redaction twin (Rust `remote/policy.rs` and its TypeScript twin) only if the parity test requires it, tests.
- **Done:** readable titles from stored detail for old and new turns; grouped steps; full command only on expand; Remote redaction parity test green with the new fields; `valid_look` accepts `circle`, `pebble`, `squircle` and still accepts all old names (Rust test).
- **Depends on:** nothing. **Blocks:** P5 (storage file), P4 shipping.

### P3 — Remote and native shell (items 23, 24, 10)
- **Files:** Rust: `crates/bloblex-daemon/src/remote/{mod,tailscale,web,tests}.rs`, `crates/bloblex-daemon/src/main.rs` (parent watchdog in `run` only), `apps/desktop/src-tauri/src/{lib,snap}.rs`, `Cargo.toml` (single-instance); TS: `apps/desktop/src/remote/{useRemote.ts,remoteContract.ts,RemoteApp.tsx,remote.css}`, new `remote/layout.ts`, `ui/RemoteSettings.tsx`, `ui/ManagerPage.tsx`, `ui/MemoryPage.tsx`, `ui/SchedulesView.tsx` (error-message sweep only), `preview/remoteFixture.ts`, `blob/companionSnap.ts` and its test (delete), tests.
- **Order inside the package:** (1) message passthrough and sweep; (2) port conflict message, ping marker, fallback port, new Tailscale states; (3) parent watchdog and single instance; (4) companion: remove snap and debounce persistence; (5) wide layout. Step 5 is file-disjoint and can be split off if time is short.
- **Done:** the owner's Tailscale toggle shows the real reason or turns on; Rust and `useRemote` tests listed under item 23; `resolveLayout` and mounted layout tests; companion tests listed under item 10; `remoteBuild.test.ts` and the tiers parity test pass.
- **Depends on:** nothing. Does not touch `RemoteSettings`' MCP area (none built).

### P4 — Bot shapes (item 4, TypeScript side)
- **Files:** `blob/look/{forms,index,bot}.ts`, `ui/LookEditor.tsx` (+ its CSS file), `ui/botTemplates.ts`, `preview/main.tsx`, tests (`look.test.ts`, `LookEditor.mounted.test.tsx`). Do not touch `bitbots.css` (P1) or Rust (P2).
- **Done:** eight symmetric shapes with mirrored pill-style eyes at rest; migration of old stored names; Shuffle and Surprise me never change the shape (and in Bitbots mode keep the outline); Surprise me changes eyes tuning and colour; chooser and preview gallery show the new set; the tests under item 4. Director compares screenshots to the reference.
- **Depends on:** P2's `valid_look` change before the app can save new names. Reference images from the Director.

### P5 — Per-bot settings, permissions, lock, Experimental tab (items 16, 19 (UI, RPC, Manager proposal), 13, 11, 12)
- **Files (UI):** `ui/ComposerControls.tsx`, `ui/SessionExecutionControls.tsx`, `ui/App.tsx` (composer area, side-conversation header), `ui/TeamSidebar.tsx`, `ui/teamSelectors.ts`, `ui/team.css`, `ui/SettingsSheet.tsx`, `ui/settingsIndex.ts`, `ui/experiments.ts`, `ui/catalogCache.ts` (read helper), `ui/BlobSettings.tsx`, `ui/BlobPage.tsx`, `ui/BotEditor.tsx`, `ui/BotWizard.tsx`, `types.ts`, tests including the two that assert the old Experimental location. **Files (Rust):** `crates/bloblex-storage/src/lib.rs` (`agents.locked` column, read/write), `crates/bloblex-daemon/src/main.rs` (lock enforcement in `agent.update/delete/restore`, `session.model.update`; new `agent.lock.set`, `session.permissions.set`), `team.rs` (`update_blob` lock check, `agent.team.update` guard, Manager permission tool), `proposals.rs` (`permission` kind, lock check on bot updates), `apps/desktop/src/remote/tiers.json` rows (`never`).
- **Done:** items 16, 19, 13, 11, 12 as specified above, with: the red `not_found` error gone for a draft; bot-level composer writes; open-conversation behaviour as decided; locked bots refuse every listed path including the Manager; Experimental page with the grouped toggles and the model-line toggle; `sidebarSubtitle` unit tests.
- **Depends on:** P1 and P2 merged. **Blocks:** P6.

### P6 — Orchestration: parallel conversations, context recovery, tags (items 18, 20, 21, and 19's project path)
- **Files:** `crates/bloblex-daemon/src/{team,main,proposals,knowledge}.rs`, `crates/bloblex-storage/src/lib.rs` (tags columns and migration), `apps/desktop/src/remote/tiers.json` (new events), `ui/App.tsx` (empty-state/waiting only), `ui/TeamSidebar.tsx` (tag editor, menu), `ui/teamSelectors.ts`, `types.ts`, `ui/team.css`, notice copy in `ui/errorCopy.ts`/conversation notices, tests.
- **Done:** queued delegations drain globally and are visible; the Manager is told started vs queued; delegated task runs in the named project with the folder shown on the approval card; recap on both fallback branches and after model change with the tests under item 20; tags on projects and bots, shown to the Manager, editable by the owner and the Manager; all tests listed under items 18, 20, 21.
- **Depends on:** P5 merged (shared daemon files, lock checks). Owner answers for concurrency and "workspace".

**No package for item 22.** The deliverable is the plain answer above; the documentation lane can store it and the corrected design notes.

---

## Owner questions (only the real decisions)

1. **How many conversations may one bot run at once? (item 18)** Today every bot is capped at 1, so a second conversation with the same bot cannot start while the first runs. The code fix works at 1 (it queues and shows "waiting"); parallel work needs a higher cap. Two bots editing the same folder at the same time can clash.
   - **A (recommended):** new bots default to 3; existing bots keep their setting; a clear "Parallel conversations" field in the bot editor (already exists as `maxConcurrency`). The global limit of 4 stays.
   - B: raise every existing bot at 1 to 3 once. Fastest result, but overrides anyone who chose 1.
   - C: keep 1 everywhere; the Manager must serialise per bot and say so.
2. **What does "the projects in the user's workspace" mean? (item 21)** (a) projects you added to Bitbots (what the Manager sees now; this wave adds tags), or (b) also folders on disk that Bitbots would scan and suggest. **Recommended: (a) now;** scanning is a separate feature with its own privacy question. Also: may the Manager set tags itself? **Recommended: yes** (the same as it can edit a bot's description today), and never on a locked bot.
3. **MCP endpoint (item 22): schedule it?** **Recommended:** not in FIX39; consider a read-only first version on a later wave, after the owed Remote threat-model review, and decide then whether it may also listen on this computer only (needs an `AGENTS.md` amendment). No answer needed now unless you want it scheduled.

Decided in this audit, not asked: composer always writes the bot (16); Manager is never lockable and lock is enforced by the daemon (13); Manager cannot set Full access (19); summarised recovery is the only feasible fix (20), so it proceeds; the eight target shapes and their migration (4); N/A plus "No usage yet" (14).

---

## Risks for the Director while the packages run

1. **Lock enforcement coverage (P5).** The easy mistake is guarding the UI and the obvious RPCs and missing a path. Ask Sol for a table: every writer of an agent field or session lock → guarded or deliberately exempt, and one daemon test per row. Check `update_blob`, proposal apply, `agent.restore` and `agent.team.update` by hand.
2. **Remote policy parity.** New methods (`agent.lock.set`, `session.permissions.set`) and events fail the build without `tiers.json` rows; new activity fields must not leak command text or paths over Remote. Run the parity tests on every merge; do not accept an `allow` where `never` was meant.
3. **Schema migrations (P5, P6).** `agents.locked` and tags add columns to a live user database. Require migration tests on a DB created by the previous version and confirm an old DB opens (the friend's and the owner's databases are real).
4. **Two daemons on the owner's machine.** If R3's evidence holds, an orphan from an earlier run is still serving the tailnet and writing the same SQLite file. Re-run the read-only checks, then **ask the owner before ending any process**; AGENTS.md says not to terminate processes as a side effect. This also contaminates any manual test for items 20 and 23.
5. **Instruction-hash churn (P6).** Anything that changes a bot's or the Manager's instruction text per update can force a new Codex thread and reproduce item 20. Tags must be reachable through tools, not injected into instructions.
6. **Recap content (P6).** It contains conversation text: never log it, never persist the text, escape it as inert data, bound its size. Review the diff for any `tracing`/event payload that includes it.
7. **Wider write access from delegated tasks (P6).** Running a delegated bot in the named project lets its `auto` mode write there. The approval card must show the folder; verify that in the diff and in the preview.
8. **Merge conflicts on hot files.** Wave rules above exist for a reason. If Sol finishes P1 late, do not start P5 early. If P3's wide layout slips, split it off; it touches only `RemoteApp.tsx`, `remote.css` and `layout.ts`.
9. **Visual items are subjective (4, 6, 8, 9, 24).** Tests will pass on ugly output. The Director must look at the result in the preview in both themes and both looks and send it back.
10. **Single-instance plugin and updater (P3).** A new shell dependency changes second-launch behaviour and could interfere with the updater's restart; test update-then-restart on a throwaway build before release.
11. **The Windows-only companion fix (P3).** The debounce and snap removal cannot be proven by unit tests alone; one manual drag test on Windows is required before the item is called done.
12. **Unverified at release time (unchanged):** Remote against a live tailnet and a real phone, and now the new wide layout and the Tailscale fix on a real tailnet.
