# Facelift Audit

> **What this is:** The owner's 31 October 2026 UI audit, screen by screen, with what changed and a score.
> **Status:** waiting for the owner's review. The gate is 9 out of 10 on every screen.
> **Last updated:** 2026-11-01

The scores are the Director's own, out of 10, for how well a screen meets the brief: simple, self-explanatory, nothing without a job. Each comes from looking at screenshots in the browser preview, in Haze dark. A row covers a family of screens, and not every state in a family was looked at: the rest only passed the inspector's automated check, which proves a state opens, not that it looks right. Stone was spot-checked on the main window, approvals, the board and the details panel, and light on the main window. Nothing here has been checked in the installed app, so the native frosted glass under these colours is unseen.

## The app

| Screen | Before | Now | What changed |
|---|---|---|---|
| Haze background | 5 | 9.5 | Follows the accent colour. With no accent it's neutral grey, not orange |
| Sidebar | 4 | 9 | No moving gradient or cards. State is a word. Needs you is part of the list |
| Conversations column | 6 | 9 | The stray project name is gone. New conversation stays in one place |
| Main header | 6 | 9 | The role chip, the mode pill and the duplicate New conversation button are gone |
| Messages | 7 | 9 | The line under the composer is gone. Warnings colour the word, not the box |
| Approvals and questions | 6 | 9 | No amber box, and the Enter hint on Allow once is readable. Opening one draws no ring |
| Manager proposals | 6 | 9 | A sheet of label and value. Empty fields are hidden until you edit |
| Plans | 6 | 9 | No blue outline |
| Assignments and sub-bots | 7 | 9 | Status colour on the row's word only |
| Composer | 7 | 9 | One highlight on focus. The controls wrap instead of overlapping on a narrow column |
| Details panel | 5 | 9 | Flat sections. Empty sections are hidden, and the name isn't repeated |
| Search boxes | 3 | 9.5 | One highlight, on the border |

## Usage

| Screen | Before | Now | What changed |
|---|---|---|---|
| Usage panel | 4 | 9.5 | Every limit at once. No modes, flyouts or chevrons. Pace mark on each meter |
| Bottom bar | 5 | 9 | `5h 1%  wk 27%`. No triangles or repeated words |
| Usage page | 5 | 9 | Meters replace rings. Tiles pick the chart. An empty range shows no empty chart |

## Settings

| Page | Before | Now | What changed |
|---|---|---|---|
| Navigation | 4 | 9 | 17 tabs became 10, in four groups. No Experimental tab |
| General | 5 | 9 | Startup, notifications, work, usage, editor |
| Appearance | 5 | 9.5 | Look names always show. Font lists open from their row |
| Chat | 5 | 9 | Messages, Dictation and Keyboard as tabs |
| Companion | 5 | 9 | Window, position, attention. Volume only shows with sounds on |
| Coding agents | 6 | 9 | Intro gone. Default approval moved to Approvals |
| Manager | 6 | 9 | Intro gone, schedules quiet when empty |
| Approvals | 6 | 9 | Defaults and rules on one page |
| Memory and skills | 6 | 9 | One-line intros |
| Remote access | 5 | 9 | No big card or bright outline. The method only shows while it can change |
| Machines | 6 | 9 | One-line intro |
| Integrations | 6 | 9 | One-line intros |
| System | 6 | 9 | No Code signing row. Backup and Health check are shorter |

## Other screens

| Screen | Before | Now | What changed |
|---|---|---|---|
| Tasks board | 7 | 9 | Instructions gone, view switch in the header, availability is a word |
| Task tree and timeline | 6 | 9 | No amber outlines |
| Schedules | 6 | 9 | One name, Schedules, everywhere. No "19 h 60 min" |
| Review changes | 8 | 9 | No change beyond focus |
| Bot pages | 6 | 9 | One-row head, smaller preview, name said once |
| New bot | 7 | 9 | No duplicate Blank card |
| Dialogs | 7 | 9 | Shorter text. Project settings keeps its buttons in reach |
| What's new | 7 | 9 | Headings use the normal font |
| Companion | 7 | 9 | Flat badge. No gradient |
| First run | 7 | 9 | Shorter text, look orbs centred |
| Phone | 7 | 9 | Quiet attention line, shorter notes |

## Second round (owner's review, 1 November 2026)

| Item | What it does now |
|---|---|
| Chat background | Haze only and off until you choose an image, in Settings › Appearance. Six effects, where it shows, and a strength for empty chats and for conversations. The image stays in this window's own storage, not in a backup |
| Message actions | Under the message |
| Needs you | A bell beside the sidebar's buttons, with a count and a list |
| Sidebar buttons | One 30 px box each, the arrow included |
| Task drag | The real card moves, leaves a gap, and flies home if dropped nowhere |
| Composer | Plan moved into the mode menu. Steer and Queue moved out; the choice is in Settings › Chat. One row at one height |
| Right panel | Section headings change colour on hover instead of drawing a box. Changes has a line of scope, two equal buttons and tidy columns |
| Settings spacing | Room under every tab bar |
| Manager facts | Each label is quieter, with an icon |
| Emails | Blurred until clicked |
| Shortcuts | One look, `Keys`, everywhere. Backspace clears one while recording, instead of an X |
| Haze controls | Buttons, toggles, segmented controls, selects and sliders after MonoCode. Stone unchanged |
| Project icons | Emoji or preset icons with colours, from the project menu. With no pick, the favicon in the project's folder, else a folder |

## Where the Experimental switches went

| Setting | Now in |
|---|---|
| Usage bar, Usage tips, Read sign-ins for usage | General |
| Taskbar badge, Resume after usage limits, Automatic retry, Longest retry delay | General |
| Agent activity, Message actions, Change review, Automatic titles, Search all conversations, Undo, Steer a running Codex turn | Chat › Messages |
| Shortcut list | Chat › Keyboard |
| Memory | Memory and skills › Memory |
| Lock a bot | Approvals |
| Claude workflows and Ultracode | Coding agents › Agents |
| Coding agent logos, Model and effort under the name | Appearance, in Stone only (they change nothing in Haze) |

Stored keys stay `experimental.<name>`, so nobody's choices change.
