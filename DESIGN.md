# Bitbots Design System

## Scene and Register

Product UI for a developer moving between coding-agent sessions on a desktop. It should feel like a simple chat app: calm, monochrome chrome, very little repeated information. The blob characters supply the warmth; everything else stays quiet.

## Rules

- **Say each thing once.** A blob's name, state and model appear in one place per screen. The sidebar row shows the blob and one line (what it is doing now, else its latest conversation). The header shows the blob name and the conversation. The details panel shows the full facts.
- **One animated blob per place.** Sidebar rows, the details panel head, empty states and the companion each show a blob. Messages, the header and the working indicator do not.
- **Monochrome chrome.** Black, greys and white. Primary actions are white with black text; toggles are white when on. Color is reserved for blob colors and for status that needs attention (amber for working or approval, red for failure, green only for added lines).
- **Status dots only when something is happening.** Idle and finished conversations have no dot.

## Tokens

All colors, type sizes and radii live in `apps/desktop/src/ui/theme.css`. Component stylesheets use only these tokens.

- Surfaces: app `#0e0e0e`, sidebar and panels `#151515`, raised cards `#1d1d1d`, menus `#202020`, selection `#262626` / `#303030`.
- Text: primary `#f4f4f4`, secondary `#a6a6a6`, tertiary `#737373`.
- Type scale: 11, 12, 13, 14, 15, 18, 22 px. Body and row labels 13–14 px at weight 400–500; headings 600. No other weights.
- Radii: 6 (controls), 10 (menus, inputs), 14 (cards), pill (buttons, composer).

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

Moods come from `ui/companionStatus.ts` and settle over time: a finished turn shows the happy face for about 6 seconds, then idle; a blob reads as online for 2 minutes after activity, then idle, and falls asleep after 10 minutes. Working, approval, failure and offline states never time out. The character sheet at `/preview.html` (preview server) shows every mood.

## Companion

Rounded rectangular bill with 14 px compact and 22 px expanded corners, an opaque surface and a clear drag affordance, inside a transparent native window. The outer shell must not use a pill radius.

Appearance may use system, dark or light surfaces. Light surfaces use the same semantic tokens with dark text. Type scale tokens may scale proportionally from a 13 px through 16 px body size.

The companion keeps its dark token palette over transparency when the main window uses the light theme.

## FIX39 visual rules (18 October 2026)

These rules came from the owner's review and the audits (item numbers refer to [docs/FIX39_FEEDBACK.md](docs/FIX39_FEEDBACK.md)). Both looks and both themes follow them.

- **Bot shapes (item 4).** Eight shapes, symmetrical by default, in this order: Circle, Pebble, Squircle, Capsule, Triangle, Hexagon, Cloud, Droplet. Each has soft shading and two equal, upright pill eyes mirrored around the centre. Eye tuning (size, height, spacing, Squareness) changes only the eyes. Shuffle and Surprise me never change the shape; they change the eyes and the colour. Older names migrate: round and sun become Circle, organic and cat become Pebble, boxy becomes Squircle.
- **The Manager's badge (item 8).** A filled white star on an orange circle, on the Manager's avatar. It is the only star or sparkle icon in the app. Do not use `Sparkles`, `Sparkle`, `Wand2`, `WandSparkles`, ✦, ✧ or ✨ anywhere. It is the one exception to monochrome chrome.
- **Model line under a bot's name (item 12).** With the "Model and effort under the name" experiment on, the sidebar's second line shows the model and effort, for example "Sonnet 5.5 · High", or "Default model" when none is set. While a bot is working or waiting, the status takes that line. System notices are never the preview (item 15).
- **Lock badge (item 13).** A locked bot shows a circle with a lock on its avatar, placed like the Manager's badge. Its editor opens read-only behind a banner, its controls are disabled, and its composer model, effort and permission controls show "This bot is locked. Unlock it to change its settings."
- **Working bots panel.** A collapsible section in the session rail. Each row shows the bot's face, name, the task's short title, its status (working, starting, waiting, waiting for approval, limited, done, failed, cancelled) and the elapsed time. Finished tasks collapse into "N finished". It uses the same tokens in both looks and both themes.
- **Update badge (item 5 and the Director's browser check).** The badge never covers the conversation title. Below a window width of 1180 px it shows an icon with a short label ("Restart"), or the ring with the percentage while downloading; at 1180 px and wider it shows the full label. The title truncates first. The banner's View and Later buttons use `.primary-button.small` and `.ghost-button.small`.
- **Settings groups (item 9).** Each group after the first is separated from the one before by a divider, in both looks.
