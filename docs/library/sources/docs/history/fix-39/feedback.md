# FIX39 owner feedback (18 October 2026, after beta.33)

> **What this is:** Owner feedback of 18 October 2026, after beta.33: the 24 items FIX39 addresses.
> **Status:** historical
> **Last updated:** 2026-10-18

The owner's review of beta.33, plus feedback from a friend testing the app. The owner's conclusion: "we are not ready to launch yet as there are so many ground-breaking bugs". Screenshots are described in words. Item numbers are used by every research, implementation and audit report.

## UI and UX

1. **Usage dialog** (the popover from the sidebar usage meter, "Usage summary · All runtimes on this device · Plan usage limits"): too much explanatory text; simplify it. "Reported by each CLI account" should sit on the same line as the "Plan usage limits" heading, after a vertical divider, followed by an info icon (an "i" in a circle) that carries the explanation as a tooltip.
2. **Codex (GPT) effort picker:** remove the "Model default · Medium" text shown to the right of "Effort Max".
3. **Sidebar header:** there are two search affordances (a search icon in the top row next to "+" and a "Search" box under it). Keep only one: remove the icon, and make clicking the search box open the big search (the Ctrl+K quick switcher) by default.
4. **Bot shapes:** make them less organic and **symmetrical by default**, like `https://grokbots.ai/studio` (its shapes: Circle, Pebble, Squircle, Capsule, Triangle, Hexagon, Cloud, Droplet; soft 3D shading; two vertical pill eyes). The current set (Round, Organic, Boxy, Capsule, Cloud, Droplet, Hexagon, Sun, Triangle, Cat, "adapted from blobatar") looks too organic and lopsided. **Shuffle / "Surprise me" must never change the shape**; they may only change the eyes (tuning) and the colouring.
5. **Update banner** ("Update 0.1.0-beta.33 is available" with "View" and "Later" buttons): the buttons don't match the app's styling; restyle them.
6. **Startup loading checklist** ("Loading OpenCode models", rows such as "Loading Codex models · Loaded 7 models" with provider logos and check marks): the rows should be **left-aligned within a block that is centred** on the screen (today the rows' left edges don't line up).
7. **Manager banner for everyone without a Manager:** a friend updated, had no Manager, and the one-time "Meet your Manager" card did not appear; he had to go through onboarding to create one. If there is no Manager, the card must **always** show in the left sidebar (no session-only dismissal hiding it for good).
8. **Manager badge:** the owner now wants the Manager's avatar badge to be a **star, similar to Grok bots'** (an orange circular badge with a white star). This is the only place a star is allowed; no sparkle icons anywhere else.
9. **Settings:** there is no visible divider between groups of options. Add dividers between groups (both looks).
10. **Companion:** remove the snapping to screen corners while dragging; it feels laggy. Free drag anywhere.
11. **New Settings tab "Experimental"** that holds every experimental feature (today they are a group inside General: Claude dynamic workflows and Ultracode, Usage tips, Usage bar, Runtime logos, Agent activity, Change review, Message actions, Search all conversations, and others).
12. **New experimental feature: model under the bot's name.** In the sidebar, the line under a bot's name shows its model and effort (e.g. "Sonnet 5.5 · High") instead of the conversation preview.
13. **New experimental feature: lock a bot.** A locked bot's settings cannot be changed at all. Locked bots show a badge on the avatar like the Manager's (a circle with a lock). Lock and unlock from the bot's right-click menu.
14. **Usage with nothing recorded for the day** shows "Unknown"; show "N/A" or "No usage yet" instead.
15. **Sidebar preview shows system notices:** a bot's preview line shows "Started a fresh session. The agent…" (a context-reset notice) instead of the last real message.

## Conversations, sessions and providers

16. **Composer settings are per bot, not per conversation.** With the Manager selected and no conversation yet, changing permissions (Ask first → Auto-approve) fails with the red error "not_found: session not found". Permission mode, effort and model chosen in the composer must apply to the bot at once and to every later conversation, with or without a conversation open.
17. **Agent activity is unreadable:** a turn's "Ran 34 commands · used 21 tools" expands to raw lines (full PowerShell/bash command strings, bare "Glob", "Read", "Grep" with no target). Parse and present it nicely: what each step did, on which file or folder, grouped, with the command text available on demand.
18. **Manager multitasking:** the friend asked the Manager to run several conversations with the **same bot** at once. One of those bot-to-bot conversations showed the bot's empty "Ready when you are" screen (header "Manager ⇆ CC Haiku · Portal stack and competitor research") while the Manager said that bot was running; nothing of its work was visible. Multiple parallel conversations with one bot must work and be visible.
19. **Permissions in a running sub-conversation:** the friend changed the Haiku bot's permissions, but in the bot-to-bot conversation it kept saying it had no permission (paths "still denied after the retry"). A sub-conversation started with "Ask first" kept it. There must be a way to change permissions mid sub-conversation, and the Manager should be able to change a sub-conversation's permission itself (with approval as per the Manager rules).
20. **Context lost after a restart:** after an error ("The coding agent took too long. No answer arrived in time."), the friend restarted the app; reopening the same conversation said "Started a fresh session. The agent no longer has earlier context." The owner asks: how can the same conversation lose its context? Is the way we connect to providers the problem? Does T3 Code (`https://github.com/pingdotgg/t3code`) do it better (theirs works), should we use ACP, or something else?
21. **The Manager as orchestrator:** it must know the projects in the user's workspace; projects should be **taggable** so the Manager knows which bots to use for which job.
22. **MCP to control Bitbots:** can bots or the Manager control Bitbots itself through an MCP, the way T3 Code does? The owner wants to know whether this is possible.

## Remote

23. **Tailscale won't turn on:** "Allow remote devices" with Tailscale gives "That did not work. Try again." (Direct works).
24. **Browser vs phone layout:** opening the Remote link in a desktop browser shows the phone app layout. There should be a browser (desktop-width) layout and a mobile app layout, chosen by where it is opened.
