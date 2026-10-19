# FIX40 Characters lane: bot art styles (light robots, hand-painted blobs) and the bot editor

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high. Worktree `D:\fx40c` (branch `fix40-chars`, from `main` a032f43). `node_modules` is a junction to the main checkout: do not run `npm install`, do not add packages. Cargo target: `D:\fx40c\target`.
Reviewer: the Director (Claude), who reads every line of your diff, runs the gates and checks the result in the browser preview. Expect follow-up rounds.

You have no chat history. Everything you need is here, in the repository, and in `D:\fx40c\design-reference\` (a design study the owner approved: `redesignPreview.tsx` with the robot heads `PopHead`, `DotHead`, `FrostHead`; `paintedBots.tsx` with the hand-painted blobs; `redesign.css` with their CSS under "robots" and "hand-painted bots"). The reference files are for reading only; do not import them and do not copy them into `src/` as-is.

## Rules

- Never run `git commit`, `git push`, `git reset` or check out other branches. Leave changes in the working tree.
- Work only inside `D:\fx40c`. Do not touch `D:\Basem's\Coding\Blolblex` or `D:\fx40t`.
- Another lane (Themes) works in parallel on the app looks. Do NOT edit: `ui/appearance.ts`, `blob/bitbots.ts`, `blob/bitbots.test.ts`, `ui/App.tsx`, `ui/SettingsSheet.tsx`, `ui/FirstRunOnboarding.tsx`, `ui/LaunchIntro.tsx`, `ui/LookPicker.tsx`, `ui/LookPreview.tsx`, `ui/PixelClouds.tsx`, `index.html`, `ui/theme.css`, `ui/bitbots.css`, any other app-wide stylesheet, `apps/desktop/src-tauri/**`, `preview/fixtureBridge.ts`, `package.json`, the lockfile, `crates/bloblex-daemon/src/main.rs`, `crates/bloblex-daemon/src/backup.rs`, `apps/desktop/src/remote/tiers.json`. In `crates/bloblex-storage/src/lib.rs` edit only `valid_look` and its test.
- Do not call `useBitbots()` / `bitbotsEnabled()` in new or changed code (the Themes lane is changing their meaning to "legacy pixel look"). To know the app look, call `useThemeStyle()` from `blob/bitbots.ts` and treat the value as a plain string: the Themes lane is widening it to `'bitbots' | 'blobots' | 'legacy' | 'pop' | 'dot'`.
- Keep comments sparse and in the style of the surrounding code. Plain English UI copy, sentence case.

## Background (facts from a code map)

- `blob/BlobCanvas.tsx:340-344` dispatches between `BitbotCanvas` (robot heads from `vendor/robot-heads`, canvas, heavy) and `ClassicBlobCanvas` (glossy blobs, `blobEngine.ts`) on the app look. Props `BlobCanvasProps` at L15-40 (`color`, `size`, `mood`, `className`, `label`, `decorative`, `mini`, `greeting`, `track`, `look`, `style`, `dragRegion`, ...). Mood list: `blob/characterState.ts:1` (18 moods).
- The classic blob's status corner: `blobEngine.ts` `drawBadge` (L877-935), position `blobGeometry.ts:1-2` (`BADGE_OFFSET {x:-0.82, y:-0.66}` of the body radius, `BADGE_RADIUS 0.34`), colours table `C` (L70-84) and per-state badge in `ENGINE_STATES` (L91-110): working / thinking / searching / listening = animated three dots; approval = "!"; error = red dot; finished = green dot; online = green dot; ratelimit = orange dot; sleeping = no badge, floating "z"; offline = dimmed; fileReady = clip; fileSending = arrow; fileError = "!". Mood → state mapping: `BlobCanvas.tsx:42-61`. Mini avatars draw a plain dot.
- Look model `blob/look/index.ts`: `BlobLook { shape, seed?, traits?, bot? }` (L17-24); `normalizeLook` (L55-72), `agentLook` (L75-78), `sameLook` / `lookKey` (L85-92) rebuild from known keys only, so a new key is dropped unless added there. `ui/blobShare.ts:57` likewise. The daemon rejects unknown look keys: `crates/bloblex-storage/src/lib.rs:5358-5383` (`valid_look`, top-level allowlist at L5361) and its test near L7934. `proposals.rs:839` caps a look at 8192 bytes (no change needed). `team.rs:961` describes the look fields to the Manager tool.
- Editors: `ui/LookEditor.tsx` (stage at size 148 with mood buttons, tabs, the 8-shape grid, eye sliders; uses `useBitbots()` at L55 to switch to `BotEditor`), `ui/BotEditor.tsx` (robot outline / shell / trim / screen).
- Avatars are rendered through `BlobCanvas` in about 25 places (team sidebar at 50px, mini avatars 16-22px, message authors 20px, onboarding 112px, editor 148px). Changing `BlobCanvas` changes them all.

## What the owner wants

Every bot gets an **art style**, chosen per bot in its editor. Robots: four options. Blobs: two options.

| `art` value | Name in UI | Renderer |
|---|---|---|
| `robot` | 3D robot | existing `BitbotCanvas` (heavy, unchanged) |
| `robot-flat` | Flat robot | NEW SVG, from `FrostHead` in the reference |
| `robot-pop` | Pop robot | NEW SVG, from `PopHead` |
| `robot-dot` | Dot robot | NEW SVG, from `DotHead` (with changes below) |
| `blob` | Glossy blob | existing `ClassicBlobCanvas` (unchanged) |
| `painted` | Hand-painted | NEW SVG, from `paintedBots.tsx` (with changes below) |

When a bot has no `art`, it follows the app look: `bitbots` → `robot-flat`, `blobots` → `blob`, `legacy` → `robot`, `pop` → `robot-pop`, `dot` → `robot-dot`, anything else → `blob`.

## C1. Data model

1. `BlobLook` gains `art?: BotArt` and `paint?: PaintedShape`. `PaintedShape` ids (renamed from the reference to avoid the legacy blob alias `cat` and to read clearly): `classic`, `cube`, `star`, `flower`, `pear`, `peanut`, `ghost`, `bunny`, `kitty`, `ufo`, `boxbot`, `tile`. Labels: Classic, Cube, Star, Flower, Pear, Peanut, Ghost, Bunny, Kitty, UFO, Box bot, Tile.
2. Thread both keys through `normalizeLook` (drop invalid values), `agentLook`, `draftLook`, `sameLook` / `lookKey`, `shuffleLook` (keep `art`; reshuffle `paint` only when `art` is `painted`), and `blobShare.ts` (export and import keep them).
3. When `paint` is missing, derive it from the blob shape so existing bots look coherent: circle → classic, squircle → cube, droplet → pear, cloud → flower, pebble → ghost, capsule → peanut, triangle → star, hexagon → tile.
4. Daemon `valid_look`: accept `art` (one of the six values) and `paint` (one of the twelve ids); reject other values. Extend the existing test. Update the look description in `team.rs` (Manager tool schema) to mention `art` and `paint` with their values.
5. New `blob/art/art.ts`: `BOT_ARTS`, labels, `ROBOT_ARTS` / `BLOB_ARTS` groups, `defaultArtForStyle(style: string)`, `resolveArt(look, style)`, `resolvePaint(look)`, and a mood map from the 18 `BlobMood` values to the art moods below.

## C2. Rendering and dispatch

1. `BlobCanvas` resolves the art from `look.art`, else from the `style` prop if given, else from `useThemeStyle()`, and renders: `robot` → `BitbotCanvas`; `blob` → `ClassicBlobCanvas`; the other four → new components in `blob/art/` (`FlatRobot.tsx`, `PopRobot.tsx`, `DotRobot.tsx`, `PaintedBlob.tsx`, shared `art.css`). Add an optional `art?: BotArt` prop that overrides everything (for pickers and previews). Keep the props contract: `size`, `color`, `mood`, `label` / `decorative` (same ARIA as today: role img with `"<label>, <mood>"`, or hidden when decorative), `className`, `mini`, `dragRegion`. `greeting` on the new arts: show the `success` mood for the greeting's duration and call `onGreetingComplete` (no pixel scene). Same outer box size as the existing renderers so layouts do not move.
2. Performance is the point of the new arts (the 3D robots are heavy): pure inline SVG + CSS keyframes; no `requestAnimationFrame`, no per-instance window listeners, no canvas. Under `prefers-reduced-motion: reduce` every animation stops and a still pose shows. Make SVG ids unique per instance (`useId`).
3. Art moods (mapped from `BlobMood`): `idle` (idle, online), `thinking` (thinking, tool_activity, listening), `typing` (working, file_activity, file_preparing, file_sending), `waiting` (permission, rate_limited), `happy` (success, file_ready, file_drop), `error` (error, file_error), `sleeping` (sleeping), `offline` (offline: render at 45% opacity, flat eyes). Expose the art mood as a class (`art-mood-<name>`) for tests.

## C3. The robots (flat, pop, dot)

All three share one eye vocabulary, done by **changing the eyes**, not by moving the whole head:

- idle: pill eyes, a blink every few seconds.
- thinking: smaller eyes glancing up and to one side; three small dots appear one after another in the visor.
- typing: the eyes switch between a focused half-height shape and open (stepped, not rolling), and a small row of pixels "types" across the bottom of the visor, left to right, then clears and repeats.
- waiting: eyes raised and wide, in amber (`#ffd257`-ish; Dot uses its red `#ff4b2b`).
- happy: upturned arcs (^ ^).
- error: X eyes in red.
- sleeping: flat lines.
- offline: flat lines, dimmed.

Specifics:

- **Flat robot** (`FrostHead` in the reference): flat shell in the bot colour, a thin light rim, ears in a darker mix of the bot colour, solid dark visor, light eyes. No gradients, no glow, no drop shadow.
- **Pop robot** (`PopHead`): ink outline, hard offset shadow, pastel shell, the cap on top, ink visor. Keep it crisp at 20px.
- **Dot robot** (`DotHead`): the visor is a 7 × 5 dot grid with unlit dots and lit eyes. Changes the owner asked for: **move the small top marker up into a little antenna** (a short stem with a small dot on top, above the head), keep the ears. Typing must look like real typing on a dot screen: the eye patterns switch in steps and a **pixel wave** runs across the bottom row of the grid. Do not "roll" the eyes side to side for typing.

## C4. Hand-painted blobs

Port `paintedBots.tsx` (flat paint, darker crescent on the lower right through the mask technique, soft highlight, upright pill eyes) to `PaintedBlob.tsx` with these changes:

1. **UFO** (was "saucer"): stretch the dome upward so it reads as a UFO, a taller arch (about 40% taller) with the eyes on the dome; keep the brim.
2. **No body motion.** Remove the bob, hop, wiggle and breathe animations. Only the eyes animate (blink on idle, glance on thinking).
3. **Status corner instead of motion**: borrow the classic blob's corner badge. A small circle at the top-left of the body (match `BADGE_OFFSET` / `BADGE_RADIUS` proportions relative to each shape's body), dark ring, colour from the engine table `C`: thinking / typing = three animated dots (thinking purple, typing blue), waiting = "!" amber (rate-limited: orange dot), happy = green dot, error = red dot, sleeping = a small "z", offline = no badge and dimmed, idle = no badge. On `mini` avatars draw a plain dot (no glyphs), as the classic engine does. Badges scale in and out (CSS transition), and stay inside the outer box.
4. Eyes per mood: idle pill eyes with blink; thinking glance up; typing focused half-height; waiting raised; happy arcs; error flat; sleeping lines.
5. All twelve shapes must read at 16-22px; if a detail turns to mush at that size (star points, bunny ears), simplify it at small sizes rather than dropping the shape.

## C5. Editor

1. `LookEditor.tsx`: add a **Style** control at the top: "Automatic (follows the app look)" plus two groups, Robots (3D robot, Flat robot, Pop robot, Dot robot) and Blobs (Glossy blob, Hand-painted). Each option shows a small live preview in the bot's colour. It writes `look.art` (Automatic removes it).
2. Below it, show controls for the resolved art: `robot` → the existing `BotEditor` controls; `blob` → the existing shape grid and Fine-tune tab; `painted` → a 12-shape grid (`look.paint`) with labels; flat / pop / dot robots → colour only (the bot colour control that exists today). Shuffle / Surprise me work per art (painted: random shape + colour; flat robots: colour).
3. Replace the `useBitbots()` branch in `LookEditor.tsx` with the resolved art. Keep locked bots read-only exactly as today.
4. Keep the mood buttons on the stage working for every art.

## C6. Character sheet

`preview/main.tsx` (`/preview.html`): add `?art=` (any of the six, default shows all) and render every art × every art mood in a grid at 22px, 44px and 96px, plus all twelve painted shapes. This is how the Director will review your work: `http://127.0.0.1:5174/preview.html?art=painted` etc. (the Director runs the preview server).

## Tests and gates

Add or update tests for: `art.ts` (default per look, resolve order, mood map covers all 18 moods), look normalisation and sharing with `art` / `paint` (round trip, invalid values dropped, `paint` derived from shape), each new renderer (renders an SVG with unique ids, applies the art-mood class, painted badge per mood and plain dot when `mini`, no animation class under reduced motion), the `BlobCanvas` dispatch (each art picks the right renderer; `art` prop overrides), `LookEditor` (Style control writes `art`, painted shape grid writes `paint`, locked stays inert), and Rust `valid_look`.

Run, from `D:\fx40c`, and paste the tail of each result in your report:

- `npm run typecheck`
- `npm test`
- `$env:CARGO_TARGET_DIR='D:\fx40c\target'; cargo test -p bloblex-storage`
- `$env:CARGO_TARGET_DIR='D:\fx40c\target'; cargo test -p bloblex-daemon team`

All must pass. Do not weaken or delete tests to make them pass; if a test pins old behaviour the owner changed, update it and say so.

## Report (your final message)

1. What you did for C1 to C6, item by item, with file paths.
2. Files changed and created.
3. Gate results (tails).
4. Anything you could not do, anything you were unsure about, and every decision this brief did not specify.
