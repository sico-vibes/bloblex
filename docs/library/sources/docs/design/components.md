# Bitbots Components

> **What this is:** The parts every screen is built from, and when to use each one. Look at them live in the inspector, under Design system.
> **Status:** current
> **Last updated:** 2026-11-01

The rules behind these are in [design-system.md](design-system.md). Haze and Stone share every part: a part reads tokens, so a change in one look reaches the other.

## The test for anything new

- **It has a job on this screen.** If removing it loses nothing, remove it.
- **It explains itself.** A label does the work. A "?" holds the rest. A line of subtext is the last resort.
- **It says a thing once.** No name, state or number appears twice on a screen.
- **Colour means something is happening.** Amber waits, red failed. Nothing else is coloured, and a coloured word never gets a coloured box as well.

## Surfaces

| Part | Use it for | Don't |
|---|---|---|
| Flat row | Lists: bots, conversations, the sidebar foot | Add a border or a card around one row |
| Card (`SettingsGroup`, `.analytics-activity`) | A set of related rows or a panel with its own controls | Nest a card in a card |
| Popover (`.usage-popover`, menus) | A quick look that closes when you click away | Hide content behind hover inside it |
| Dialog (`blob-dialog`) | A decision that must be answered | Show information a page or popover can hold |
| Page (`blob-page-header`) | Anything you stay on and work in | Open a dialog on top of it to show more detail |

## Haze's controls

Small squared corners (6 or 7 px), hairline borders and a flat selected state, after MonoCode. Toggles are pills with a white knob. Stone keeps its own rounder controls, so all of this is scoped to Haze in `themes/haze.css`.

## Focus

- **A text field answers focus with one border.** The field, or the box wrapped around it, turns `--line-focus`. Never a ring, and never on both.
- **Everything else gets the ring** (`--focus-ring`), and only from the keyboard.
- **Focus moved by code doesn't draw a ring.** Use `focus({ focusVisible: false })`.

## Selection and status

- **Selected is a flat tint** (`--surface-selected`). No side ribbon, no gradient, no coloured outline.
- **A bot's state is one word at the end of its row:** Working, Needs you, Failed. Amber and red are for the last two.
- **Amber and red colour a word or an icon, never a box.** An approval or a plan is a neutral card.
- **The accent colours the primary action, switches, focus and the Haze background.** Nothing else.
- **A task's state is a dot and a word.** The chip's border never changes colour.

## Controls

| Part | Use it for |
|---|---|
| `Keys` | Any keyboard shortcut, shown as one cap per key. There's no other way to draw one |
| `PrivateEmail` | Any email on screen: blurred until it's clicked |
| `ProjectIcon` | A project's icon wherever a project is named: the owner's pick, else its favicon, else a folder |
| `primary-button` | The one main action on a screen or dialog |
| `secondary-button` | Other actions in a row or a form |
| `ghost-button` | Quiet actions that repeat down a list |
| `icon-button` | A universal icon, always with a label for screen readers and a tooltip |
| `toggle` | On or off, applied at once |
| `Select` | One of more than three choices |
| `SegmentedControl`, `.analytics-switch` | One of two or three choices, all worth seeing |
| `.blob-tabs` | Views of the same subject, and pages inside a Settings tab |
| `HelpTip` | The explanation behind a label. One short sentence |

## Messages and the composer

- **A message's actions sit under it**, so a long reply never needs a scroll back up to copy.
- **The composer has one row of controls, all 28 px high.** Plan is a choice in the mode menu. How a message reaches a running turn is a setting, not a control here.

## Copy

- **Empty means hidden.** A section or field with nothing to say doesn't show, unless the empty state is the thing you came to see.
- **A page intro is one short line, or nothing.**
- **One name for one thing:** Schedules, never Automations, in anything a person reads.

## Settings

- **Tabs:** ten, in four groups. Each setting has one home. A tab with several pages shows them as `.blob-tabs` under its title.
- **Rows:** a label, a control, and a `HelpTip` only if the label isn't enough. Hide a row when it can't change anything (a volume with sounds off).
- **Adding a setting:** add the row, then its entry in `settingsIndex.ts`. Its `group` must match the `SettingsGroup` title.

## Usage

One set of parts, in `QuotaBar.tsx`, on all three surfaces:

| Part | What it is |
|---|---|
| `LimitMeter` | A thin bar of how much is used. Amber from 70%, red from 90%. Its small mark shows how much of the window's time has passed, so a bar past its mark is running ahead |
| `LimitRow` | One limit on one line: name, meter, percent, time until reset |
| `ProviderLimits` | A coding agent's name and its rows, or the reason it has none, with **Turn on** when reading is the only thing missing |
| `UsagePanel` | The quick look, from the bottom bar or the sidebar |

The bottom bar, the sidebar line and the Usage page never restate each other: with the bar on, the sidebar line is hidden.

## Charts

One neutral series, bars at most 28 px wide, hairline rules, the peak value at the top, dates along the bottom, and a tooltip on hover or keyboard focus. A tile above a chart both shows a total and picks what the chart plots, so there's no second control for it.
