# FIX39 research — lane R1 (UI and UX, items 1–15)

Research lane: OpenCode `opencode-go/deepseek-v4.1-flash` (high). No code changed; this file is the only artefact. No `git commit` run.

Sources read: `apps/desktop/src/ui/*`, `apps/desktop/src/blob/look/*`, `apps/desktop/src-tauri/src/snap.rs`, `apps/desktop/src-tauri/src/lib.rs`, `DESIGN.md`. Line numbers are from the working tree at the time of writing.

Cross-cutting note: `DESIGN.md:9` states the sidebar row "shows the blob and one line (what it is doing now, else its latest conversation)". Items 4, 8, 12 and 13 each add a second thing to a blob row or change a silhouette, so they require a matching `DESIGN.md` edit. Item 12 in particular contradicts "Say each thing once" — it puts the model in the sidebar while the header/details also show it. That is the owner's explicit choice, but `DESIGN.md` must be amended or the next review will flag it.

---

## Item 1 — Usage dialog: too much text; move "Reported by each CLI account" beside the heading with an info tooltip

**What the owner sees.** The popover from the sidebar usage meter ("Usage summary · All runtimes on this device · Plan usage limits") carries too much explanatory prose. "Reported by each CLI account" should sit on the heading line, after a vertical divider, then an "i" info icon carrying the explanation as a tooltip.

**Evidence.**
- `apps/desktop/src/ui/App.tsx:2942-2956` is `UsageSheet`: header shows `USAGE` / `Usage summary` / `<small className="usage-scope">All runtimes on this device</small>` (line 2945); body is `QuotaDetails` + the Token usage block; footer is one sentence: "Token counts describe recorded activity. Plan limits are a separate account quota." (line 2954), plus a "Usage history" button.
- `App.tsx:2920-2940` is `QuotaDetails`: heading line `Plan usage limits` + a right-aligned `<span>Reported by each CLI account</span>` + a refresh icon-button (line 2923); empty state "No supported provider account quota source is available." (line 2938); per-card `{row.status ?? 'Unavailable'}` and `"{row.status}: last successful reading retained."` (lines 2935-2936).
- CSS: `.usage-block-heading` is a `space-between` flex row (`.usage-block-heading > span` right-aligned, small tertiary text) at `apps/desktop/src/ui/styles.css:73-75`. Bitbots theme restyles `.usage-sheet` and its footer divider at `apps/desktop/src/ui/bitbots.css:594-595`.
- A reusable tooltip already exists: `apps/desktop/src/ui/Tip.tsx:16` (`<Tip text=... >`) built on `useTooltip` (`apps/desktop/src/ui/useTooltip.ts:10`), used in `SessionExecutionControls.tsx:325`. The info icon can be any circular outline glyph; `lucide-react` `Info` is available (used nowhere yet, so no style clash).

**Cause.** The heading line mixes two ideas (the heading and a provenance note) and pushes the note to the far right; the footer restates the "plan vs tokens" distinction; the scope line and the two empty-state sentences add more prose. Nothing is styled as an inline divider, so the note reads as a separate label rather than an aside.

**Proposed design.**
- In `QuotaDetails` (`App.tsx:2923`), drop the right-aligned `<span>Reported by each CLI account</span>` and the footer sentence at `App.tsx:2954`. Build the heading as `<h3>Plan usage limits</h3>` + a vertical rule + a small `<span>Reported by each CLI account</span>` + `<Tip text="..."><button class="icon-button usage-info-button" aria-label="What this shows"><Info size={13}/></button></Tip>`, then the refresh button pushed right with `margin-left:auto`.
- Move the explanation into the tooltip: "Each coding agent reports its own plan limits from the sign-in it already has. Bitbots does not estimate or share them." Keep the empty-state text short: "No account quota source available." and per-card `Unavailable`.
- CSS: add `.usage-block-heading .usage-divider { width:1px; height:14px; background: var(--line); }` and reset `.usage-block-heading > span` alignment (or wrap the note in a new `.usage-note` element) in `styles.css`; check Bitbots override in `bitbots.css:544-548` still reads.
- Trim the sheet scope: keep "All runtimes on this device" or fold it into the info tooltip.

**Tests.** Update `ContextWindowIndicator.mounted.test.tsx` only if it asserts the string (it asserts `Plan usage limits · Codex`, which is a different component, `ContextWindowIndicator.tsx:103`, not touched). Add a mounted assertion in the existing usage test (grep `usage-block-heading` in tests) that the heading line contains the divider, the note and an info button with `aria-label`, and that the old footer sentence is gone. Do not assert exact tooltip prose beyond a keyword.

**Size.** M. Depends on nothing.

**Questions for the owner.** None.

---

## Item 2 — Codex effort picker shows "Model default · Medium" beside "Effort Max"

**What the owner sees.** With effort set to Max, the Codex effort popover still prints "Model default · Medium" to the right of "Effort Max". Remove it.

**Evidence.** `apps/desktop/src/ui/SessionExecutionControls.tsx:330`:
`{defaultThinking && efforts.length > 0 && !visibleLabel.startsWith('Model default') && <span className="session-effort-default-label">Model default · {labelizeEffort(defaultThinking, provider)}</span>}`
The popover heading is `App.tsx`-external (kept in this file) at lines 326-331. The trigger label logic is at lines 316-321; the model-is-first lock case (`MODEL_FIRST_REASON`) sets `triggerLabel = 'Effort'`.

**Cause.** The popover heading always appends the model-default hint when the model declares a default effort and the user has not shown the default itself. It is shown regardless of the currently highlighted position, so at Max it still reads "Model default · Medium" — duplicated information, contradicting `DESIGN.md:9`.

**Proposed design.** Delete the `<span className="session-effort-default-label">…</span>` element at `SessionExecutionControls.tsx:330` (and the now-unused `.session-effort-default-label` CSS if present). The default is already surfaced in the trigger (`Model default` label at line 317) and in the recovery/unavailable blocks (lines 340-341), so nothing is lost. Keep `defaultThinking` for those paths.

**Tests.** `apps/desktop/src/ui/SessionExecutionControls.mounted.test.tsx:224` asserts the trigger text is `Model default`; that path is untouched. Grep the same file for `session-effort-default-label` / `Model default ·` and update or remove the popover assertion. `SessionEffortMeter.mounted.test.tsx` may assert the label; check.

**Size.** S. Depends on nothing.

**Questions for the owner.** None.

---

## Item 3 — Sidebar has two search affordances; keep one, make the box open the quick switcher

**What the owner sees.** A search icon in the sidebar top row (next to "+") and a "Search" box below it. Keep only the box, make clicking it open the Ctrl+K quick switcher.

**Evidence.**
- Icon: `apps/desktop/src/ui/App.tsx:2384` — `icon-button` with `Search` icon, `title="Quick switcher"`, `onClick={() => setQuickSwitcherOpen(true)}`, inside `.sidebar-create-actions` next to the create "+" (line 2385).
- Box: `apps/desktop/src/ui/TeamSidebar.tsx:300-303` — `<label className="sidebar-search">` with a magnifier svg and `<input … onChange={(e) => onQueryChange(e.target.value)} />`. `onQueryChange` is wired to `setSearch` at `App.tsx:2399`; `query` filters roster rows `TeamSidebar.tsx:306-332`.
- Quick switcher: `App.tsx:2590` renders `<QuickSwitcher items={quickSwitcherItems} …>`; opened by `setQuickSwitcherOpen(true)` (line 2384) and by `useQuickSwitcherShortcut(!companion && !blobPage && !analyticsOpen, openQuickSwitcher)` (`App.tsx:457`, hook in `ui/useQuickSwitcherShortcut.ts`).

**Cause.** Two independent controls were added for the same job: an icon that opens the quick switcher and a box that filters the roster in place. The owner reads them as duplicates.

**Proposed design.** Keep the box only. Two options:
1. (Recommended) Turn the box into a button that opens the quick switcher: replace the `<input>` with a `<button className="sidebar-search" onClick={openQuickSwitcher}>` showing the magnifier + "Search" placeholder text, wired through a new `onOpenSearch` prop. Inline roster filtering is dropped; the quick switcher already searches blobs (`quickSwitcherItems`, `App.tsx:2283+`). Remove the `Search` icon at `App.tsx:2384`.
2. Keep the input filtering the roster and *also* open the quick switcher on focus/click — more confusing, not recommended.
Whichever is chosen, the shortcut stays Ctrl+K.

**Tests.** `apps/desktop/src/ui/QuickSwitcher.mounted.test.tsx`, `useQuickSwitcherShortcut.mounted.test.tsx`, `TeamSidebar.keyboard.mounted.test.tsx`, `App.selection.mounted.test.tsx` (roster search). Add a mounted test that clicking the box opens the quick switcher and that the top-row icon is gone.

**Size.** S–M. Depends on nothing.

**Questions for the owner.**
- Does the sidebar box keep filtering the roster while typing, or does it only launch the quick switcher? **Recommended:** only launch it (one search everywhere), matching the brief.

---

## Item 4 — Bot shapes: less organic, symmetrical by default, like grokbots; shuffle must not change shape

**What the owner sees.** The current silhouettes (Round, Organic, Boxy, Capsule, Cloud, Droplet, Hexagon, Sun, Triangle, Cat, "adapted from blobatar") are too organic and lopsided. Wanted: a symmetric set like `grokbots.ai/studio` — Circle, Pebble, Squircle, Capsule, Triangle, Hexagon, Cloud, Droplet — with soft 3D shading and two vertical pill eyes. Shuffle / "Surprise me" must never change the shape, only the eyes (tuning) and colouring.

**Evidence.**
- Shape list: `apps/desktop/src/blob/look/forms.ts:13` `BLOB_SHAPES = ['round','organic','boxy','capsule','cloud','droplet','hexagon','sun','triangle','cat']`. `SHAPES` definitions at `forms.ts:208-274`.
- Labels: `apps/desktop/src/blob/look/index.ts:26-29` `SHAPE_LABELS` (Round, Organic, Boxy, … Cat).
- Symmetry/asymmetry is seed-driven: `organic` uses `spline`/`splineFace` (`forms.ts:210`), `boxy`/`hexagon`/`triangle` take `body.rot` from the seed (`forms.ts:213, 240, 257`), `BODY_PRESETS`/`SHAPE_PRESETS` only fix size/proportion (`index.ts:96-98`). So a blob's silhouette tilts and lumps by seed — the "organic and lopsided" look.
- Shuffle: `index.ts:127-130` `shuffleLook(look, anyShape=false, random)` — when `anyShape` is true it calls `shapeForPosition(random())` and changes the silhouette. The UI calls it with `true` for "Surprise me": `apps/desktop/src/ui/LookEditor.tsx:79` `<Dices/>Surprise me → onLookChange(shuffleLook(look, true))`; `LookEditor.tsx:78` Shuffle uses `shuffleLook(look)` (same shape). Bitbots mode has its own: `LookEditor.tsx:76` Surprise me → `randomBot()`, and `apps/desktop/src/blob/look/bot.ts:118-124` `randomBot()` picks `shape: pick(BOT_SHAPES)` (`BOT_SHAPES` at `bot.ts:10`).
- Shape chooser UI: `LookEditor.tsx:113-144` `ShapeGrid` (grid, 5 columns), credit line `LookEditor.tsx:103` "Shapes adapted from blobatar … MIT". Tune sliders (eyes) at `LookEditor.tsx:146-161`, `LOOK_CONTROLS` at `index.ts:146-176`.
- Soft 3D shading already exists: `apps/desktop/src/blob/blobEngine.ts:582-611` (body radial gradient + linear fill, shadow `sh`, highlight `hl`). The gap is silhouette symmetry and the eye shape, not the shading.
- Mascot look (round + tall capsule eyes) is `MASCOT_LOOK` at `index.ts:35-43`; `agentLook` defaults every blob to `'round'` (`index.ts:72-75`) and `normalizeLook` rejects unknown shapes (`index.ts:48-56`), so renamed/removed shapes must be migrated or stored looks fall back to round.

**Causes.**
1. The shape vocabulary is the blobatar set, which is intentionally organic (spline lumps, seeded tilt) and wider than grokbots'.
2. `shuffleLook(..., true)` and `randomBot()` deliberately randomise the silhouette; the owner wants the silhouette held.
3. The eye model is a general ellipse with squareness (`FormEye.n`, `forms.ts:269-274`), not a fixed vertical pill, so eyes vary per shape/seed.

**Proposed design.** This is the largest item; split it:
- **Vocabulary (breaking change, needs migration).** Target set: `circle`, `pebble`, `squircle`, `capsule`, `triangle`, `hexagon`, `cloud`, `droplet` (8). Map old→new at load so saved looks keep working: `round→circle`, `organic→pebble`, `boxy→squircle`, keep `capsule/cloud/droplet/hexagon/triangle`, and decide `sun`/`cat` (recommended: drop from the chooser, migrate `sun→circle`, `cat→pebble`). Implement the migration in `normalizeLook`/`isBlobShape` (`index.ts:48-69`) so stored agent looks do not silently become round.
- **Symmetry.** For every shape, remove seed-driven tilt (`body.rot`) and the organic spline; use supershape/superellipse bodies with a fixed 0 rotation. `pebble` = a symmetrical rounded blob (two mirrored radii), `squircle` = a rounded square (fixed `body.n`), keeping the existing `capsule/cloud/droplet/hexagon/triangle` geometry minus rotation. Keep `forms.ts` parameters but pin `rot` and, for `pebble`, mirror the radii.
- **Eyes.** Add a "vertical pill" eye preset (tall `eye.rx`, `eye.ratio`, small `n`) applied as the default face fit for every silhouette, replacing per-shape seeds where they diverge (`MASCOT_LOOK` already is that shape, `index.ts:35-43`).
- **Shuffle.** Change `shuffleLook` to never touch `shape` (drop the `anyShape` parameter, or keep it but always pass `false` from the UI); update `LookEditor.tsx:78-79` so both buttons keep the shape; randomise only seed (face/proportions) and, for "Surprise me", also the colour. In Bitbots mode, make `randomBot()` take the current shape and only pick colours: `bot.ts:117-124` and `BOT_SHAPES` should be passed the existing shape. Update the button titles accordingly.
- **Copy/credit.** The blobatar credit line (`LookEditor.tsx:103`) and `THIRD_PARTY_NOTICES.md` must be updated if the geometry is re-derived; if the shapes stay blobatar-derived with new parameters, keep the credit.
- `DESIGN.md` needs a shapes line under Character.

**Tests.** `apps/desktop/src/blob/look/look.test.ts` and `forms` tests: add symmetry assertions (outline points mirror across the vertical axis within tolerance; every shape has `rot === 0`), a shuffle invariant test (`shuffleLook` output has the same `shape`), a migration test (`normalizeLook({shape:'cat'})` → expected new shape), and a `randomBot(currentShape)` test. Mounted: `LookEditor.mounted.test.tsx` — click Surprise me, assert the selected shape tile does not change. Preview: `apps/desktop/src/preview/main.tsx:30-31` renders a shape gallery from `BLOB_SHAPES`; update it for the new list.

**Size.** L. Depends on nothing, but blocks any later shape work.

**Questions for the owner.**
- Keep or drop Sun and Cat? **Recommended:** drop both from the chooser (they are the least symmetric); migrate stored `sun`→Circle and `cat`→Pebble.
- Should the blobatar credit stay, or is a from-scratch symmetric set wanted (which changes `THIRD_PARTY_NOTICES.md`)? **Recommended:** keep blobatar geometry but pin it symmetric, keeping the existing credit.

---

## Item 5 — Update banner buttons don't match the app styling

**What the owner sees.** The "Update 0.1.0-beta.33 is available" banner's "View" and "Later" buttons look wrong ("buttons don't match the app's styling").

**Evidence.** `apps/desktop/src/ui/UpdateBanner.tsx:20-26`:
```
<button type="button" className="pill-button" onClick={onView}>View</button>
<button type="button" className="pill-button" onClick={onLater}>Later</button>
```
`.pill-button` has **no rule anywhere**: `grep -rn "\.pill-button" apps/desktop/src` → 0 matches; the only uses are these two. So both buttons render with the browser's default button appearance. The banner itself is styled at `apps/desktop/src/ui/shell.css:168-169` (`border`, `background: var(--surface-raised)`, `p { flex:1 }`); Bitbots theme refines it at `bitbots.css:706`. Rendered from `App.tsx:2446`.

**Cause.** A typo/leftover class name with no stylesheet rule. The app's real button classes are `.primary-button`, `.secondary-button`, `.ghost-button`, `.icon-button` (`DESIGN.md:36`).

**Proposed design.** In `UpdateBanner.tsx`, replace `pill-button` with the system classes: View → `className="primary-button small"`, Later → `className="ghost-button small"` (or `secondary-button small`). No new CSS needed. Optionally add `.update-banner { flex-shrink:0 }` to buttons so the sentence `p` keeps its flex but the buttons don't wrap. Remove the dead `.pill-button` name.

**Tests.** `apps/desktop/src/ui/FIX37.updateBadge.mounted.test.tsx` — grep for `pill-button`; update to the new classes and assert both buttons carry a system class.

**Size.** S. Depends on nothing.

**Questions for the owner.** None.

---

## Item 6 — Startup checklist rows are not left-aligned within a centred block

**What the owner sees.** The launch checklist ("Loading OpenCode models", "Loading Codex models · Loaded 7 models", provider logos and check marks) — the rows' left edges don't line up.

**Evidence.** `apps/desktop/src/ui/shell.css:425`:
`.launch-checklist li { … display: grid; grid-template-columns: 20px minmax(0, max-content); justify-content: center; align-items: center; gap: 10px; }`
Each `<li>` (markup `LaunchIntro.tsx:119-124`) is its own grid whose content is *centred inside the row*; the second column is `max-content`, so a long row and a short row start at different x. The list container `.launch-checklist { width:100%; … }` (`shell.css:422`) sits inside the centred `.launch-checklist-window` (`shell.css:419`, `width: min(420px,100%)`).

**Cause.** `justify-content: center` on the row grid centres each row's content independently instead of aligning the rows to a shared left edge.

**Proposed design.** Left-align the rows inside one centred block:
- `.launch-checklist { width: max-content; max-width: 100%; margin-inline: auto; }` (block centred by its own width), and
- `.launch-checklist li { justify-content: start; grid-template-columns: 20px minmax(0, max-content); }` — i.e. change `justify-content: center` → `start` at `shell.css:425`.
With the list sized to `max-content` and centred, all rows share the same left edge (the icon column) while the whole block stays centred. Verify the mask/scroll window (`shell.css:419-421`) still clips correctly and the row-in animation is unaffected. Bitbots overrides at `bitbots.css:684-694` don't touch alignment.

**Tests.** CSS-only; add/adjust a mounted assertion in the launch test (grep `launch-checklist` in tests) if one checks layout, otherwise a visual check via the preview launch page. A DOM test can at least assert the class names are unchanged.

**Size.** S. Depends on nothing.

**Questions for the owner.** None.

---

## Item 7 — Manager banner must always show when there is no Manager

**What the owner sees.** A friend updated, had no Manager, and the one-time "Meet your Manager" card did not appear; he had to go through onboarding to create one. The card must always show in the left sidebar when there is no Manager, with no session-only dismissal hiding it for good.

**Evidence.**
- Render gate: `App.tsx:2399` — `banner={!managerOf(agents) && hasActiveBlobs ? <ManagerSetupCard runtimes={runtimes.filter(runtimeUsable)} disabled={connection!=='connected'} onCreate={createOnboardedBlob}/> : null}`. `hasActiveBlobs` = `activeAgents(agents).length > 0` (`App.tsx:540`).
- Inside the card: `apps/desktop/src/ui/ManagerSetupCard.tsx:11-28` — `LATER_KEY='bitbots.managerSetup.later'`; `managerSetupDismissed()` reads `sessionStorage.getItem(LATER_KEY)==='1'`; `hidden` state initialises from it (line 22); the header "Later" X writes `sessionStorage` (line 28, button `ManagerSetupCard.tsx:41`). It also returns `null` when `runtimes.length === 0` (line 27).
- `managerOf` = first non-archived agent with `systemRole==='manager'` (`teamSelectors.ts:81-86`); `isManager` is `systemRole==='manager'` only (the old `leader` flag no longer counts).
- Onboarding can pre-empt the sidebar: `App.tsx:376-377` return `FirstRunOnboarding` when `onboardingVisible`; the effect at `App.tsx:894-906` sets `onboardingVisible` when, at a moment with `connection==='connected'`, `(snapshot?.agents ?? []).length===0 && (snapshot?.sessions ?? []).length===0 && !priorAppUse && localStorage['bloblex.firstRun.complete']!=='1'`. `priorAppUse` (`App.tsx:221-224`) keys off a fixed list of localStorage keys; a long-time user whose profile was created before those keys existed has `priorAppUse=false`.

**Causes (all of them).**
1. Session dismissal: once "Later" is pressed, `sessionStorage` keeps the card hidden for the rest of the webview session (reloads included) — the "hiding it for good" the owner names.
2. `runtimes.length === 0` returns `null` (ManagerSetupCard.tsx:27) — right after an update, before discovery, the card can be silently absent.
3. Render gate `hasActiveBlobs`: a user whose blobs are not yet in the snapshot (or all archived) sees no card, only onboarding.
4. Onboarding race (App.tsx:894-906): if the effect evaluates before agents/sessions land (or `priorAppUse` is false and `firstRun.complete` was never set on this machine's keys), onboarding replaces the shell and the sidebar card never gets a chance; the friend's described path "had to go through onboarding to create one" is exactly this.

**Proposed design.**
- Remove the dismissal entirely: delete `LATER_KEY`, `managerSetupDismissed`, the `hidden` state and the "Later" X from `ManagerSetupCard.tsx` (keep the card non-dismissable), as the owner asks.
- Do not hide on `runtimes.length === 0`: render the card with the coding-agent `Select` disabled and a short "No coding agent is ready yet" note until a runtime is usable.
- Keep the `hasActiveBlobs` gate so a brand-new install still goes through onboarding rather than showing a card with no blobs — but make the onboarding decision wait for the snapshot: add `snapshot === null` (or `snapshot?.agents === undefined`) to the "not yet known" condition so onboarding only triggers once the daemon has actually answered. That fixes cause 4.
- Consider showing the card in the companion-independent sidebar only (it already is).

**Tests.** Grep `ManagerSetupCard` / `managerSetup` in tests; add a mounted test in `App.agent.mounted.test.tsx` (or a new `ManagerSetupCard.mounted.test.tsx`) asserting: no Manager + active blobs → the card shows; the card has no dismiss control; `runtimes=[]` still shows it disabled; and the onboarding effect does not fire while `snapshot===null`.

**Size.** M. Related to item 8 (same avatar/row area but different files).

**Questions for the owner.**
- Should the card be removable at all (e.g., also create-able later from the "+" menu)? **Recommended:** non-dismissable while no Manager exists, and the "+" menu already offers "New project with the Manager".

---

## Item 8 — Manager avatar badge should be a star (grokbots-like)

**What the owner sees.** The Manager's avatar badge should be an orange circular badge with a white star (this is the only place a star is allowed).

**Evidence.** `apps/desktop/src/ui/TeamSidebar.tsx:284-287`:
```
<span className="team-row-avatar"> … <BlobCanvas …/>
  {isManager(agent) && <span className="leader-badge" title="Manager" aria-hidden="true"><BriefcaseBusiness size={8} strokeWidth={2.6}/></span>}
</span>
```
CSS `.leader-badge` at `apps/desktop/src/ui/team.css:22` is already an orange circular badge: `width/height 15px; border-radius 50%; background: linear-gradient(160deg,#ffad42,#f27a1a); color:#fff; border: 2px solid var(--surface-sidebar)`. Selected-row border overrides at `team.css:29,34`. This is the only `.leader-badge`. Confirmed no `Star`/`Sparkles` icon is used anywhere in `apps/desktop/src/ui` today (`grep` empty), so the "no sparkle elsewhere" rule already holds.

**Cause.** The badge uses `BriefcaseBusiness`; the owner wants a star. No CSS change is needed — only the icon.

**Proposed design.** Swap `BriefcaseBusiness` for `Star` from `lucide-react` (filled: `<Star size={9} fill="currentColor" strokeWidth={0}/>` to read as a solid white star on orange). Keep `aria-hidden` and the `title="Manager"`. Remove the now-unused `BriefcaseBusiness` import from `TeamSidebar.tsx:4` if nothing else uses it (check `SettingsSheet.tsx:51` still imports its own). Add a `DESIGN.md` line: a star badge is allowed only for the Manager.

**Tests.** `apps/desktop/src/ui/App.agent.mounted.test.tsx:781-785` asserts `.leader-badge` presence/absence for leader vs Manager — unaffected (class unchanged). Add an assertion that the badge contains an `svg` (the star) if a test wants the icon shape; otherwise an aria-label check.

**Size.** S. Related to item 7 (same row, no file conflict on `team.css`).

**Questions for the owner.** None.

---

## Item 9 — Settings has no visible divider between option groups

**What the owner sees.** Groups of options in Settings run together; there is no visible divider between them (in both looks).

**Evidence.** `apps/desktop/src/ui/settings.css:26-28`:
```
.settings-group { margin-top: 22px; }
.settings-group-head { min-height:28px; margin:0 0 8px; padding:0 4px; display:flex; … }
.settings-group-head h3 { margin:0; color:var(--text-3); font-size:var(--fs-xs); font-weight:500; }
```
Only a 22px gap separates groups; there is no `border`/rule. Group headings are rendered by `SettingsGroup` (used e.g. `SettingsSheet.tsx:513, 527, 553, 560, 586, 591, 600, 608, 625, 632, 667, 704, 710, 718, 748`). "Both looks" = dark and light appearances (`DESIGN.md:46`), or possibly the two appearance styles (default and Bitbots) — both should get the rule.

**Cause.** No separator was ever styled between `.settings-group` blocks; the grey heading is the only cue.

**Proposed design.** Add a top rule to every group except the first in `settings.css`:
```
.settings-group { margin-top: 22px; padding-top: 20px; border-top: 1px solid var(--line); }
.settings-group:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
```
Use the semantic `--line` token so the light theme and Bitbots theme inherit it (`DESIGN.md:16` requires tokens only). Check Bitbots overrides (`bitbots.css:198-220` target `.settings-group-head h3`) do not fight the new border; add a `:root[data-bitbots="on"] .settings-group { border-top-color: var(--bb-line); }` if needed. Also apply to `botWizard.css:25` (`.bot-wizard-body .settings-group:first-child`) which relies on the same component.

**Tests.** CSS-only; add a mounted assertion that adjacent `.settings-group` elements carry a top border if any test inspects computed style (unlikely). Prefer a preview/screenshot check for both themes and both appearance styles.

**Size.** S. Depends on nothing.

**Questions for the owner.** None.

---

## Item 10 — Companion corner-snapping feels laggy; allow free drag

**What the owner sees.** While dragging the companion, it snaps to screen corners; it feels laggy. Remove snapping and allow free drag.

**Evidence.**
- The snap runs on every window move: `apps/desktop/src-tauri/src/lib.rs:2078-2084` — `window.on_window_event(move |event| { if let WindowEvent::Moved(_) = event { if !resize_flag { persist_companion_position(...); schedule_companion_snap(&window_for_event, &snap_generation, &snap_resize_flag); } } })`.
- `schedule_companion_snap` (`lib.rs:1933-1964`) sleeps 380 ms after the last move, then calls `snap::snap_position` (line 1955) and, if the result differs, `window.set_position` (line 1961).
- `apps/desktop/src-tauri/src/snap.rs:17-41` is the pure geometry (edge 16 logical px, corner 40, margin 8). A JS mirror exists at `apps/desktop/src/blob/companionSnap.ts` with tests at `companionSnap.test.ts`; it is not called from production (only the Rust path runs).
- Launch/restore positioning is separate: `companion_launch_position` (`lib.rs:~1918-1928`) and `companion_saved_compact_spot` / `companion_last_launch_spot` (`lib.rs:2055-2071`) clamp the initial spot. Those are not "snapping while dragging" and can stay.

**Cause.** The 380 ms quiet timer plus a corrective `set_position` produces a second, small window move after the user releases — the perceived lag/lurch. Corner snapping (40 px on both axes) also pulls far more often than edge snapping.

**Proposed design.**
- Remove the snap call: delete `schedule_companion_snap` and its invocation at `lib.rs:2082` (keep `persist_companion_position`). Then `snap_generation`/`snap_resize_flag` locals (lines 2076-2077) and the `snap` module import become unused; remove `snap.rs` (and its tests) plus the now-unused JS mirror `blob/companionSnap.ts` and `companionSnap.test.ts`, or leave the JS mirror only if another consumer appears (it has none).
- Keep the launch clamp so the companion still appears on-screen. Confirm `companion_saved_compact_spot` only clamps the start position, not mid-drag.
- `DESIGN.md`/`docs` mention for companions: state free drag retained position (the existing position persistence already covers this).

**Tests.** Rust: the `snap.rs` tests disappear with the module; keep a test that a `Moved` event only persists position and does not move the window (harder to unit-test; at minimum compile-check). JS: remove `companionSnap.test.ts`. Manual/preview: drag the companion and confirm it stays where released and does not lurch.

**Size.** S. Depends on nothing. Note: the brief lists this under UI, but the change is in `src-tauri` (Rust) — route to the backend-capable lane.

**Questions for the owner.**
- Keep "reset companion position" (Settings → General) which re-centres it? **Recommended:** yes, keep the explicit reset; only the automatic drag-time snap goes.

---

## Item 11 — New Settings tab "Experimental"

**What the owner sees.** Every experimental feature should live in a new "Experimental" Settings tab, instead of a group inside General.

**Evidence.**
- Pages: `apps/desktop/src/ui/SettingsSheet.tsx:44` `SettingsPageId = 'General' | 'Appearance' | 'Remote' | 'Agents' | 'Manager' | 'Memory' | 'Skills' | 'Speech' | 'Backup' | 'Updates'`; nav list `PAGES` at `SettingsSheet.tsx:46-57`; page bodies are `page === '<name>' && <>…</>` blocks (`General` at line 512).
- The group to move: `SettingsSheet.tsx:560-584` `<SettingsGroup title="Experimental">` containing "Claude dynamic workflows and Ultracode" (561-563), "Usage tips" (564-566), "Usage bar" (567-569), "Runtime logos" (570-572), "Agent activity" (573-575), the `EXPERIMENTS.map(...)` rows (576-580, list in `ui/experiments.ts:5-15`: changeReview, messageActions, search, autoTitles, undo, shortcuts, autoRetry, memory, approvalBadge) and "Steer a running Codex turn" (582-584).
- Search index: `apps/desktop/src/ui/settingsIndex.ts:5,8` page-name unions and `SETTINGS_INDEX` entries pointing at `General`/`Experimental` (lines 49-50, and each `EXPERIMENTS` label is not indexed today).
- Settings props come from `App.tsx` (usageBarEnabled, claudeWorkflowsEnabled, usageTipsEnabled, activityDetails, runtimeLogos, experiments, and their change callbacks) — moving the group to another page does not change the props.

**Cause.** All experimental toggles were collected into one `SettingsGroup` on the General page; there is no dedicated page.

**Proposed design.**
- Add `'Experimental'` to `SettingsPageId` and `PAGES` (`SettingsSheet.tsx:44-57`) with a suitable icon (e.g. `FlaskConical`, already a lucide icon; or `Beaker`).
- Move the whole `<SettingsGroup title="Experimental">…</SettingsGroup>` block out of the `page === 'General'` fragment into a new `{!loading && page === 'Experimental' && <>…</>}` block. Keep the group (or split into "Features" and "Interface" inside the page) — a single centred card list is fine.
- Update `settingsIndex.ts`: add `'Experimental'` to `SettingsPageName` and `SETTINGS_PAGE_NAMES` (`settingsIndex.ts:5,8`) and repoint every `page:'General', group:'Experimental'` entry (lines 49-50) to `page:'Experimental'`. Also add index entries for the `EXPERIMENTS` rows so search finds them.
- Check `SettingsSheet.tsx:485-486` (search scrolls to `.settings-group-head h3` inside `.settings-content`) still works for the moved page.
- Any deep link that opened General's Experimental group (e.g. `onOpenSettings('General')` callers) must still land somewhere sensible.

**Tests.** `apps/desktop/src/ui/settingsIndex.test.ts` (page/group parity) and any test that asserts the Experimental group is on General. Add a mounted test that the Experimental page lists the toggles and that General no longer does. `SettingsSheet` mounted tests: `SettingsSheet.appearance.mounted.test.tsx`, `SettingsSheet.speech.mounted.test.tsx` — grep for `Experimental`.

**Size.** M. Depends on items 12 and 13 if those new features are also exposed as toggles here (recommended).

**Questions for the owner.**
- Should the new per-bot model line (item 12) and bot lock (item 13) appear as Experimental toggles on this page? **Recommended:** yes for the model line (a toggle); the lock is a per-bot action, not a global switch.

---

## Item 12 — Experimental: model and effort under the bot's name in the sidebar

**What the owner sees.** The line under a bot's name should show its model and effort (e.g. "Sonnet 5.5 · High") instead of the conversation preview.

**Evidence.**
- The preview line: `apps/desktop/src/ui/TeamSidebar.tsx:294` `<span className={'bot-row-preview …'}>{preview}</span>`; `preview` is computed at `TeamSidebar.tsx:223` from `deriveCompanionStatus`, `conversationPreview(session)` (`teamSelectors.ts:40-53`) and `agent.description`.
- The data: `Agent.model` and `Agent.thinking` (`types.ts:161-162`); provider from `runtime?.provider` already available in `renderRow` (`TeamSidebar.tsx:216`).
- Display helpers exist: `presentedModelName(provider, model)` (`ui/modelPresentation.ts:14`), `labelizeEffort(value, provider)` (`ui/effortLabels.ts:1`). Catalog values (for `displayName`) come from the shared cache: `useCachedRpc('runtime.models', { runtimeId }, …)` (`ui/catalogCache.ts:126`), used in `SessionExecutionControls.tsx:48-49` and `ComposerExecutionSwitch.tsx:57-61`. `TeamSidebar` currently receives `runtimes` but no catalog.
- Toggle surface: an `Experiments` flag would live in `ui/experiments.ts` (`EXPERIMENTS`, line 5) and be threaded from `App.tsx` like `runtimeLogos` (`TeamSidebar` already receives `runtimeLogos`, used at `TeamSidebar.tsx:290`).

**Causes.** The subtitle has always been the conversation preview (`TeamSidebar.tsx:223, 294`); there is no model/effort rendering for the sidebar, and the sidebar has no catalog access to turn `agent.model` (an id) into a display name.

**Proposed design.**
- Add an experiment `sidebarModel` (label "Model and effort under the name", hint) to `ui/experiments.ts:5-15`; default false.
- Thread it to `TeamSidebar` as a prop (mirror `runtimeLogos` in `App.tsx:2399`).
- In `renderRow`, when on, replace the second line's text with `${presentedModelName(provider, model)} · ${labelizeEffort(agent.thinking, provider)}` (fallback "Default model" / omit effort when `agent.thinking` is null). Keep the waiting/working/offline status text taking precedence (lines 221-223) so a busy bot still reads as busy — or decide the owner's preference (see question).
- Resolve the display name cheaply: add one `useCachedRpc('runtime.models', { runtimeId })` per row is wasteful; instead read `readCached('runtime.models', { runtimeId })` (`catalogCache.ts:69`) synchronously in a small helper and fall back to the raw id. The boot warm-up already caches per-runtime lists (`catalogCache.ts:1-6`), so no extra request is needed in the common case.
- `DESIGN.md:9` must be amended for this experimental mode.

**Tests.** Add a pure helper `sidebarSubtitle(agent, provider, catalog)` in `teamSelectors.ts` and unit-test it (with/without catalog, no model, no effort). Mounted: a `TeamSidebar`/`App` test that the toggle swaps the line and that a busy bot still shows status.

**Size.** M. Related to items 11 (toggle placement) and 15 (same line, mutually exclusive when both could show a notice/model).

**Questions for the owner.**
- When the bot is working or waiting, should the line still show model/effort, or the status ("Working…", "Waiting for you")? **Recommended:** status wins while busy; model/effort shows when idle.

---

## Item 13 — Experimental: lock a bot

**What the owner sees.** A locked bot's settings cannot be changed at all; locked bots show a badge on the avatar like the Manager's (a circle with a lock); lock and unlock from the bot's right-click menu.

**Evidence.**
- Right-click menu: `apps/desktop/src/ui/TeamSidebar.tsx:143-174` `blobMenu(agent)` builds `MenuItem[]` (type at `TeamSidebar.tsx:16`); opened via `openBlobMenu` on context menu (`TeamSidebar.tsx:234`) and by keyboard (`TeamSidebar.tsx:276`). Actions are the `TeamSidebarActions` object (`TeamSidebar.tsx:76+`), implemented in `App.tsx:2399+` (e.g. `onSetHidden`, `onArchive`).
- Avatar badge: `TeamSidebar.tsx:284-287` (same slot as the Manager badge, item 8).
- Persistence patterns: device-local JSON in `localStorage` — `ui/sidebarPins.ts:9,119-125` (`bloblex.sidebar.pins`) and the module-mirror hook in `ui/botPrefs.ts:1-37`. The `Agent` type is `interface Agent extends JsonRecord` (`types.ts:152`) with an `agent.update` RPC (`App.tsx:1512`) and a daemon-side schema; adding a new agent field would be a daemon change.
- Edit entry points that must respect a lock: editor/rename/archive/hidden (menu items, `TeamSidebar.tsx:151-173`), the blob settings/editor (`ui/BlobSettings.tsx`, `ui/BlobPage.tsx`, `ui/BotEditor.tsx`, `ui/BotWizard.tsx`), and the composer's per-bot model/effort/permission (item 16, `ui/ComposerExecutionSwitch.tsx`, `ui/SessionExecutionControls.tsx`, permission controls).

**Cause.** No lock concept exists anywhere (`grep -rn "locked" ui` finds only model-lock/thinking-lock unrelated code). The badge and menu need a new persisted per-bot flag and enforcement across every settings-changing surface.

**Proposed design.**
- Storage: add `ui/botLock.ts` with the `sidebarPins.ts` pattern — `bloblex.botLocks.v1` = `{ v:1, locked: string[] }`, with `readLocks()`, `isLocked(agentId)`, `toggleLock(agentId)`, `subscribe`/`useBotLock(agentId)` via `useSyncExternalStore` (mirror `botPrefs.ts:27-37`). Keep it device-local so no daemon/schema change is needed; the alternative (an `agent.locked` field) is a daemon change and a bigger blast radius (recommend against for FIX39).
- Menu: add `{ label: locked ? 'Unlock bot' : 'Lock bot', icon: <Lock size={15}/> or <LockOpen/>, onSelect: () => actions.onToggleLock(agent) }` to `blobMenu` (after Duplicate / near Hide); the Manager's own menu (line 148-154) can include it too or be excluded (see question). Add `onToggleLock` to `TeamSidebarActions`.
- Badge: in the avatar span, `{locked && <span className="lock-badge" title="Locked" aria-hidden="true"><Lock size={9}/></span>}`. Style `.lock-badge` in `team.css` next to `.leader-badge` (`team.css:22`) — same 15px circle, but a neutral/monochrome fill (not the orange reserved for the Manager) to satisfy `DESIGN.md:11`. If both badges could appear (Manager locked), offset one so they don't overlap.
- Enforcement: when `locked`, disable/hide in the menu: Rename, Edit, Archive, Delete conversation, Hide/Show, Move to; and make the blob editor open read-only (a banner "This bot is locked. Unlock it from the sidebar to change its settings" and disabled inputs) in `BlobSettings.tsx`/`BlobPage.tsx`. Also block per-bot composer changes (item 16) while locked. Guard the RPC call sites (`App.tsx:1512, 2092, 2122`) with an `isLocked(agent.id)` check and a clear error so a stale UI cannot write.
- `DESIGN.md`: document the lock badge.

**Tests.** Unit-test `botLock.ts` (toggle, persistence, parse fallback). Mounted: `TeamSidebar.keyboard.mounted.test.tsx` / `App.agent.mounted.test.tsx` — lock from the menu shows the badge, disables Rename/Edit, and unlock reverses. Editor: `BlobSettings.*.mounted.test.tsx` — read-only when locked.

**Size.** L (new storage + UI + enforcement across several files). Related to items 8 (badge slot) and 11/16 (composer changes).

**Questions for the owner.**
- Does the lock also stop per-bot composer changes (model, effort, permission), or only the bot editor? **Recommended:** everything per-bot, including the composer.
- Can the Manager be locked? **Recommended:** no — keep the Manager always editable so recovery is possible.

---

## Item 14 — Usage with nothing recorded shows "Unknown"; show "N/A" or "No usage yet"

**What the owner sees.** Usage for a day with nothing recorded reads "Unknown".

**Evidence.** `apps/desktop/src/ui/usagePresentation.ts:3-6`:
```
export function tokenValue(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unknown'
  …
}
```
`usageTokenBuckets` (line 8-16) uses it for the five token rows rendered in `UsageSheet` (`App.tsx:2951`). A null/absent field (nothing recorded) therefore prints "Unknown". The test locks this in: `apps/desktop/src/ui/usagePresentation.test.ts:8,11` expect `'Unknown'`. A second, unrelated "Unknown" fallback is the companion token glance at `App.tsx:3561` (`'Unknown'` when neither token count is known).

**Cause.** `tokenValue` maps "no number" (including "nothing recorded") to the word "Unknown", which reads as an error rather than an empty period.

**Proposed design.** Change the fallback string in `tokenValue` (`usagePresentation.ts:4`) to `'N/A'` — the owner's first option, short and neutral next to the other buckets. Optionally distinguish "absent field" from "recorded as zero": `null`/`undefined` → `'N/A'`, `0` stays `'0'`. Leave the companion glance (`App.tsx:3561`) as is unless the owner wants it changed too.

**Tests.** Update `usagePresentation.test.ts:8,11` from `'Unknown'` to `'N/A'`; add a case asserting `0` still renders `'0'`.

**Size.** S. Depends on nothing. Related to item 1 (same sheet).

**Questions for the owner.**
- `'N/A'` or `'No usage yet'`? **Recommended:** `'N/A'` in the token grid (compact, next to numbers), and if a whole period is empty, the sheet's empty state ("Usage summary unavailable") already covers the broad case.

---

## Item 15 — Sidebar preview shows a system notice instead of the last real message

**What the owner sees.** A bot's sidebar preview shows "Started a fresh session. The agent…" (a context-reset notice) instead of the last real message.

**Evidence.** `apps/desktop/src/ui/teamSelectors.ts:40-53` `conversationPreview`: it walks messages backwards, skips `role==='thinking'`, special-cases notices with `meta.kind` `delegation`/`blob_reply`/`blob_created`, then at lines 49-50 returns the first non-empty text — *including* a `role:'notice'` message with `meta.kind==='context_reset'` and empty-but-nonempty content. The notice text is produced elsewhere as "Started a fresh session. The agent no longer has earlier context." (`App.agent.mounted.test.tsx:884`). The conversation view already has the right filter: `isContextNotice` and `withoutStaleContextNotices` in `ui/conversation.ts:52-77`, which drops stale/leading context notices; `conversationPreview` does not call it.

**Cause.** `conversationPreview` (`teamSelectors.ts:40-53`) does not skip `context_reset` notices, so the newest such notice wins as the preview even though the conversation view hides it.

**Proposed design.** In `conversationPreview`, skip any `role==='notice'` whose `meta.kind` is not one of the handled kinds — or explicitly `if (role==='notice' && message.meta?.kind==='context_reset') continue`. Better: reuse the shared predicate: `if (role === 'notice' && message.meta?.kind === 'context_reset') continue` keeps the delegation/blob_reply/blob_created cases above it working. This also fixes `CompanionTeam.tsx:47` (`conversationPreview(main)`), which shares the helper.

**Tests.** `apps/desktop/src/ui/teamSelectors.test.ts:52-55` covers the helper; add a case: messages `[{role:'assistant', content:'Done'}, {role:'notice', content:'Started a fresh session', meta:{kind:'context_reset'}}]` → expect `'Done'`. Also assert a conversation that is *only* a context notice returns `null` (falls back to the description/`Ready`).

**Size.** S. Depends on nothing. Related to item 12 (same line; decide precedence if both are on).

**Questions for the owner.** None.

---

## Implementation packages

Grouped so different packages touch mostly different files. If packages are run in parallel, note the shared files called out; `TeamSidebar.tsx` is claimed by three packages, and `App.tsx` by several (different regions) — sequence those or keep them in one lane.

- **P1 — Sidebar search (item 3).** Files: `apps/desktop/src/ui/App.tsx` (remove the `Search` icon at 2384, pass `onOpenSearch`), `apps/desktop/src/ui/TeamSidebar.tsx` (300-303), `ui/team.css`/`shell.css` (`.sidebar-search`), tests `QuickSwitcher.mounted.test.tsx`, `useQuickSwitcherShortcut.mounted.test.tsx`, `TeamSidebar.keyboard.mounted.test.tsx`.
- **P2 — Sidebar preview and model line (items 15, 12).** Files: `ui/teamSelectors.ts` (40-53 + new `sidebarSubtitle`), `ui/experiments.ts` (new flag), `ui/TeamSidebar.tsx` (223, 294), `ui/catalogCache.ts` read helper, `App.tsx` (prop), `DESIGN.md:9`, tests `teamSelectors.test.ts`, a `TeamSidebar` mounted test.
- **P3 — Manager card and badge (items 7, 8).** Files: `ui/ManagerSetupCard.tsx` (remove dismissal; don't hide on empty runtimes), `App.tsx` (894-906 onboarding wait-for-snapshot; 2399 gate), `ui/TeamSidebar.tsx` (286 badge icon only), `ui/team.css` (`.lock-badge` shared with P5), `ui/managerSetup.css`, tests `App.agent.mounted.test.tsx`, new `ManagerSetupCard.mounted.test.tsx`.
- **P4 — Bot shapes (item 4).** Files: `blob/look/forms.ts` (13, 208-274), `blob/look/index.ts` (26-29, 48-69, 96-98, 127-130), `blob/look/bot.ts` (10, 117-124), `ui/LookEditor.tsx` (76-80, 103, 113-144), `blob/look/look.test.ts`, `blob/companionSnap.ts` left alone, `preview/main.tsx` (30-31), `THIRD_PARTY_NOTICES.md`, `DESIGN.md`. No overlap with P1-P3.
- **P5 — Settings Experimental tab and dividers (items 9, 11, and the item-12 toggle, item-13 lock storage wiring).** Files: `ui/SettingsSheet.tsx` (44-57, 512-600), `ui/settings.css` (26-28), `ui/settingsIndex.ts` (5, 8, 49-50 + new `EXPERIMENTS` entries), `ui/settingsIndex.test.ts`, `ui/botWizard.css` (25), `ui/experiments.ts`. `SettingsSheet.tsx` only.
- **P6 — Bot lock (item 13).** Files: new `ui/botLock.ts`, `ui/TeamSidebar.tsx` (menu 143-174, avatar 284-287), `ui/team.css` (`.lock-badge`), `App.tsx` (actions + guards at 1512/2092/2122), `ui/BlobSettings.tsx` / `ui/BlobPage.tsx` (read-only), tests `TeamSidebar.keyboard.mounted.test.tsx`, `BotSettings` mounted tests. Shares `TeamSidebar.tsx` with P2/P3 and `team.css` with P3.
- **P7 — Usage dialog and unknown (items 1, 14).** Files: `ui/App.tsx` (2920-2956), `ui/usagePresentation.ts` (4), `ui/usagePresentation.test.ts` (8,11), `ui/styles.css` (60-75), `ui/bitbots.css` (544-548, 594-595). `App.tsx` different region from P1-P3.
- **P8 — Update banner (item 5).** Files: `ui/UpdateBanner.tsx` (21-25), `ui/FIX37.updateBadge.mounted.test.tsx`. Standalone.
- **P9 — Launch checklist alignment (item 6).** Files: `ui/shell.css` (419-425). Standalone.
- **P10 — Companion free drag (item 10).** Files: `apps/desktop/src-tauri/src/lib.rs` (1933-1964, 2076-2084), `apps/desktop/src-tauri/src/snap.rs` (+tests), `apps/desktop/src/blob/companionSnap.ts` + `companionSnap.test.ts`. Rust/backend lane; standalone.
