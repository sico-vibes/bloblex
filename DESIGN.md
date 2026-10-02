# Bloblex Design System

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
