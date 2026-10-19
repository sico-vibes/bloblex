# Bitbots Design System

## Scene and Register

Product UI for a developer moving between coding-agent sessions on a desktop. It should feel like a simple chat app: calm, monochrome chrome, very little repeated information. The blob characters supply the warmth; everything else stays quiet.

## Rules

- **Say each thing once.** A blob's name, state and model appear in one place per screen. The sidebar row shows the blob and one line (what it is doing now, else its latest conversation). The header shows the blob name and the conversation. The details panel shows the full facts.
- **One animated blob per place.** Sidebar rows, the details panel head, empty states and the companion each show a blob. Messages, the header and the working indicator do not.
- **Monochrome chrome.** Black, greys and white. Primary actions are white with black text; toggles are white when on. Color is reserved for blob colors and for status that needs attention (amber for working or approval, red for failure, green only for added lines). *FIX40: this is the Blobots rule. Frost, Pop and Dot have their own colours; see [FIX40 looks and bot art](#fix40-looks-and-bot-art-19-october-2026).*
- **Status dots only when something is happening.** Idle and finished conversations have no dot.

## Tokens

All colors, type sizes and radii live in `apps/desktop/src/ui/theme.css`. Component stylesheets use only these tokens. *FIX40: each look overrides these tokens in its own file under `apps/desktop/src/ui/themes/`.*

- Surfaces: app `#0e0e0e`, sidebar and panels `#151515`, raised cards `#1d1d1d`, menus `#202020`, selection `#262626` / `#303030`.
- Text: primary `#f4f4f4`, secondary `#a6a6a6`, tertiary `#737373`.
- Type scale: 11, 12, 13, 14, 15, 18, 22 px. Body and row labels 13–14 px at weight 400–500; headings 600. No other weights. *FIX40: Pop and Dot use their own faces and weights; see the FIX40 section.*
- Radii: 6 (controls), 10 (menus, inputs), 14 (cards), pill (buttons, composer). *FIX40: Frost, Pop and Dot set the pill radius to 12 px and use rounded rectangles for controls.*

## Layout

- Sidebar (280 px): logo and new-blob button, search, blob rows, profile button at the bottom.
- Blob row: avatar, name and time on the first line, one subtitle line and the expand chevron on the second. An expanded blob keeps one continuous highlight; its projects and conversations hang off a guide line under the avatar.
- Header: blob name (opens the blob editor) and a conversation dropdown on the left; model, approval mode (only when not Ask), new conversation, details toggle and more on the right.
- Details panel (320 px): avatar, name and runtime at the top, then text tabs (Details, Runtime, Files) and plain label/value rows. It hides on the blob editor and Analytics.
- Settings: left page list (General, Agents, Updates), page title, grey group labels over rounded cards of rows. Agents merges detected command line tools, their blobs and approvals: each tool expands in place.
- Profile: initials and name; its menu holds Usage, Find coding agents, Settings, name editing and Quit. First run asks for a name without blocking the app.

## Controls

- Dropdowns use `Select` (`ui/Select.tsx`), never the native select: its popup cannot be styled on Windows.
- Menus share `.menu-surface` and `.menu-item`.
- Buttons: `.primary-button`, `.secondary-button`, `.ghost-button`, `.icon-button`; add `.small` in dense rows.

## Character moods

Moods come from `ui/companionStatus.ts` and settle over time: a finished turn shows the happy face for about 6 seconds, then idle; a blob reads as online for 2 minutes after activity, then idle, and falls asleep after 10 minutes. Working, approval, failure and offline states never time out. The character sheet at `/preview.html` (preview server) shows every mood. *FIX40: the new bot arts show these moods through their own art moods; see the FIX40 section.*

## Companion

Rounded rectangular bill with 14 px compact and 22 px expanded corners, an opaque surface and a clear drag affordance, inside a transparent native window. The outer shell must not use a pill radius.

Appearance may use system, dark or light surfaces. Light surfaces use the same semantic tokens with dark text. Type scale tokens may scale proportionally from a 13 px through 16 px body size.

For Legacy and Blobots, the companion keeps its dark token palette over transparency when the main window uses the light theme. Frost, Pop and Dot follow the user's resolved theme in the companion (FIX41).

## FIX39 visual rules (18 October 2026)

These rules came from the owner's review and the audits (item numbers refer to [docs/FIX39_FEEDBACK.md](docs/FIX39_FEEDBACK.md)). Both looks and both themes follow them. *FIX40: "both looks" now means all five looks.*

- **Bot shapes (item 4).** Eight shapes, symmetrical by default, in this order: Circle, Pebble, Squircle, Capsule, Triangle, Hexagon, Cloud, Droplet. Each has soft shading and two equal, upright pill eyes mirrored around the centre. Eye tuning (size, height, spacing, Squareness) changes only the eyes. Shuffle and Surprise me never change the shape; they change the eyes and the colour. Older names migrate: round and sun become Circle, organic and cat become Pebble, boxy becomes Squircle. *FIX40: the eight shapes apply to the glossy blob only. The robot arts and the hand-painted blobs have their own sets; see the FIX40 section.*
- **The Manager's badge (item 8).** A filled white star on an orange circle, on the Manager's avatar. It is the only star or sparkle icon in the app. Do not use `Sparkles`, `Sparkle`, `Wand2`, `WandSparkles`, ✦, ✧ or ✨ anywhere. It is the one exception to monochrome chrome.
- **Model line under a bot's name (item 12).** With the "Model and effort under the name" experiment on, the sidebar's second line shows the model and effort, for example "Sonnet 5.5 · High", or "Default model" when none is set. While a bot is working or waiting, the status takes that line. System notices are never the preview (item 15).
- **Lock badge (item 13).** A locked bot shows a circle with a lock on its avatar, placed like the Manager's badge. Its editor opens read-only behind a banner, its controls are disabled, and its composer model, effort and permission controls show "This bot is locked. Unlock it to change its settings."
- **Working bots panel.** A collapsible section in the session rail. Each row shows the bot's face, name, the task's short title, its status (working, starting, waiting, waiting for approval, limited, done, failed, cancelled) and the elapsed time. Finished tasks collapse into "N finished". It uses the same tokens in both looks and both themes. *FIX40: each look restyles it through its own tokens.*
- **Update badge (item 5 and the Director's browser check).** The badge never covers the conversation title. Below a window width of 1180 px it shows an icon with a short label ("Restart"), or the ring with the percentage while downloading; at 1180 px and wider it shows the full label. The title truncates first. The banner's View and Later buttons use `.primary-button.small` and `.ghost-button.small`.
- **Settings groups (item 9).** Each group after the first is separated from the one before by a divider, in both looks.

## FIX40 looks and bot art (19 October 2026)

Rules from the owner's FIX40 request. The record of the wave is [docs/FIX40_REPORT.md](docs/FIX40_REPORT.md). Where this section and an earlier rule differ, this section wins; the earlier rules carry a short note that points here.

### Looks and families

- Five looks. Primary: **Bitbots** (`appearance.style` value `bitbots`), which is the Frost look. Alternative: **Blobots** (`blobots`), monochrome and unchanged. More looks: **Legacy** (`legacy`, the old pixel look), **Pop** (`pop`) and **Dot** (`dot`).
- Onboarding offers Bitbots and Blobots as large cards and the three More looks as a row.
- Users already on `bitbots` get Frost. Nothing is migrated.
- `data-bitbots="on"` is set for Legacy only. The pixel welcome, PixelScan, PixelClouds and the Doto and DM Mono stylesheet load only for Legacy.
- Each look has its own file under `apps/desktop/src/ui/themes/` (`frost.css`, `pop.css`, `dot.css`), with every rule scoped to its look. The main-window rules are kept out of the companion and dictation windows, and each look has a separate companion and dictation layer (FIX41, [below](#companion-and-dictation-windows-fix41)).

### Frost (Bitbots)

- Translucent flat panels over a wallpaper. Glass covers the large surfaces only: sidebar, conversation lists, conversation column, details panel, settings sheet, dialogs, menus and popovers.
- Cards, rows, inputs and message bubbles use flat fills and never their own backdrop blur, so the translucency does not stack.
- **No glow, no halo, no decorative gradients, no text shimmer.** At most one soft shadow, on floating menus, popovers and dialogs.
- Rounded rectangles only, never pill or circle UI. Radii 9, 12 and 16 px; the pill token is 12 px. Bot artwork is not UI and is not affected.
- Wallpapers: Lake (default), Dusk, Bloom, Sand, and a custom image. A custom image is PNG, JPEG or WebP, at most 15 MB, stored as a file in the app's local data folder. Image bytes never go into settings.
- Glass levels: Solid (default), Balanced, Clear. The tint and blur values are in `ui/themes/frost.css`.
- The default interface font is Inter. A font the user picks wins.
- A user accent still overrides the look's default accent.

### Pop and Dot

- **Pop** is retro, not pixelated. It uses a cream paper ground with a faint dot grid, panels and cards with a 2 px ink outline, hard offset shadows with no blur, pastel fills and sticker-style chips. Body text is DM Sans; headings and the brand name are Bricolage Grotesque.
- **Dot** is monochrome with one red accent. Selection inverts to an ink background. Body text is Geist and labels are Geist Mono; Doto is for large numbers only. Meters and bars are rows and columns of dots.
- Both use rounded rectangles, with the small radii of the shape rule and larger panels, and never pill or circle UI.

### Fonts

- 24 bundled fonts in four categories: sans, friendly and display, mono, and pixel. Latin subsets only, from `@fontsource` packages.
- A font loads only when it is chosen, or when the font list is on screen. Fonts never enter the main bundle for an unchosen font.
- Defaults per look: Bitbots Inter; Pop DM Sans; Dot Geist and Geist Mono. Blobots and Legacy keep their stylesheet fonts. The "Default for this look" option always returns to these.
- A pixel font may be the interface font. The smallest rendered size stays at 11 px.

### Settings > Appearance

- Order of sections: Look (the cards), Look options, Colour (Theme and Accent), Text (interface font, code font, text size and density).
- Look options exist for Bitbots only (wallpaper and glass). Other looks show one quiet line.
- Each look card shows one orb (below), not a screenshot.

### Bot art

- Six art styles, chosen per bot: `robot` (3D robot, the heavy existing renderer), `robot-flat`, `robot-pop`, `robot-dot`, `blob` (glossy blob, the existing renderer) and `painted` (hand-painted).
- A bot with no art follows the app look: Bitbots gives Flat robot, Blobots gives Glossy blob, Legacy gives 3D robot, Pop gives Pop robot, and Dot gives Dot robot.
- Hand-painted blobs have twelve shapes: Classic, Cube, Star, Flower, Pear, Peanut, Ghost, Bunny, Kitty, UFO, Box bot and Tile. The shape is `look.paint`. Existing bots get a shape derived from their blob shape.
- The new arts are inline SVG and CSS keyframes only: no canvas, no `requestAnimationFrame`, no window listeners per instance. Under reduced motion every animation stops and a still pose shows.
- Robot arts change the eyes, not the whole head. Idle has pill eyes that blink. Thinking has smaller eyes glancing to one side. Typing has stepped eye shapes and a row of pixels that types across the visor; the Dot robot shows a pixel wave, never rolling eyes. Waiting has raised, wide eyes in amber (red on Dot). Happy is an arc pair, error is X eyes in red, and sleeping and offline are flat lines (offline is dimmed).
- The Dot robot has an antenna above its head.
- Hand-painted blobs do not move; only their eyes animate. Their status appears in a corner badge borrowed from the glossy blob, using its colours. Mini avatars show a plain dot.
- The eight-shape rule from FIX39 applies to the glossy blob only.
- The launch greeting shows the bot in its art. Legacy keeps the pixel welcome. The glossy blob keeps its classic greeting.

### Look orbs

- Settings and onboarding show one static orb per look instead of a mini window: lake glass (Bitbots), matte stone (Blobots), pixel dither (Legacy), striped sticker (Pop) and dot matrix (Dot).
- An orb has no window chrome, avatars, text or animation. It draws its own colours and does not read the app's tokens, so it looks the same in every look. About 72 px for the two large cards and about 52 px for the More looks cards.
- No glow or halo on any orb.

### Companion and dictation windows (FIX41)

These rules extend the looks above to the companion and dictation windows. The record is [docs/FIX41_COMPANION_LOOKS_REPORT.md](docs/FIX41_COMPANION_LOOKS_REPORT.md).

- Each look styles the overlay windows through its own layer.
- Dark is each look's default. Light follows `data-surface-theme`.
- Frost is a solid tint in the overlay windows, because those windows have no native blur.
- Pop draws its 2 px lines and offset shadows with `box-shadow`, so no box grows.
- Dot uses dotted lines.
- Bot-coloured text on light is mixed toward ink (15% bot colour) to keep 4.5:1.
- Legacy and Blobots keep the fixed dark palette in the overlay windows.
- No size, layout or animation changes in the overlay windows.
