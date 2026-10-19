# FIX39 Director checks (browser preview)

> **What this is:** Director checks for FIX39 in the browser preview.
> **Status:** historical
> **Last updated:** 2026-10-18

These are the visual checks the audits left to the Director, run in the browser preview on 18 October 2026 after Wave A was merged (`14777cb`).

| Item | Result |
|---|---|
| 6: launch checklist | **Pass.** The rows share one left edge inside a centred block. |
| 3: search | **Pass.** One search box with "Ctrl K"; the header icon is gone. |
| 8: Manager badge | **Pass.** A filled star in the orange badge. |
| 9: settings dividers | **Pass.** There is a divider between groups (System / Companion). |
| 4: shapes | **Pass.** Eight symmetric shapes (Circle, Pebble, Squircle, Capsule, Triangle, Hexagon, Cloud, Droplet), soft shading and two pill eyes, close to the grokbots reference. The owner makes the final call. |
| Update badge (FIX37 G5, with P1's header) | **Fail.** At a 1024 px window, "Restart to update" in the header overlaps the conversation title ("Codex · CTO · Board / New chat"). The badge must never cover the title: shrink it to an icon-and-short-label pill, or let the title truncate first, at every window width. Hand this to the next package that edits `App.tsx` (P5 follow-up or P6). |
