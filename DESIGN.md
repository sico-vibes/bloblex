# Bloblex Design System

## Scene and Register

Product UI for a developer moving between coding-agent sessions on a desktop, usually focused on a project in a quiet work setting. The interface should feel steady and precise; the character animation supplies warmth in small moments.

## Color Strategy

Restrained tinted dark neutrals for chrome, with a single selected-agent accent used for active selection and state. Original character accents: Claude coral, Codex blue, OpenCode violet, generic mint. Never rely on accent color alone to convey status.

## Surfaces

- Main background: deep blue-gray, not pure black.
- Rail and context pane: slightly separated cool-neutral surfaces.
- Conversation region: broad, low-chrome canvas with subtle dividers.
- Permission and error states: restrained amber/red surfaces with explicit labels.
- Companion: rounded rectangular bill with source-informed 14px compact and 22px expanded corners, an opaque tinted surface and clear drag affordance; transparent native window around it. The outer shell must not use a stadium/pill radius.

## Typography

Use a native system sans stack (`Segoe UI`, `system-ui`, sans-serif). Keep labels compact and readable, reserve stronger weight and scale for the selected agent and conversation. Use a monospace stack only for code and paths.

## Layout

At desktop size, use a narrow agent rail, flexible conversation pane, and context pane with Details, Runtime, and Files tabs. Collapse context before compromising the composer or message readability. The default desktop target is 1360×860 with a practical 1000×680 minimum.

## Components

- Agent rail rows pair one original animated blob with agent name and textual runtime state.
- Conversation uses clear user/agent alignment and compact cards only for tools, changed files, commands, and permissions.
- Composer stays anchored to the conversation bottom.
- Usage is a compact summary that opens a focused sheet for detail.
- Companion follows the island home/chat/navigation structure: selected session/activity glance, real local runtime peers, an inline conversation, file-drop preparation and permission controls. Its compact form stays slim; its separate welcome view centers the waving character.

## Motion

Use the island's source-informed spring growth and 340ms collapse. The separate launch greeting follows its 4.6-second growth, dip/pop, hand wave, tuck and settling choreography. Procedural blob motion may spring and deform while communicating state; keep its original base form circular and expressions mouth-free. Distinguish idle, typing, thinking, activity, approval, completion, error, rate limit and sleeping. Honor reduced motion, pause when hidden, and reduce idle work. The bill position persists across launches and is clamped to a usable area after display changes.
