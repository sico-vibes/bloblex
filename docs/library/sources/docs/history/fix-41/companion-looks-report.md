# FIX41 report: looks on the companion and dictation windows

> **What this is:** Report for FIX41: looks on the companion and dictation windows.
> **Status:** historical; a record as of 19 October 2026
> **Last updated:** 2026-10-19

Original status line, kept as written: implemented on branch `claude/priceless-shamir-29e003`. Not released. Committed on that branch; not merged to `main`. Evidence is unit and mounted tests, the gates listed below and the Director's browser-preview audit. The real transparent native window is unverified.

Brief: [docs/history/fix-41/companion-looks-brief.md](companion-looks-brief.md). Earlier wave: [docs/history/fix-40/report.md](../fix-40/report.md). Design rules: [docs/design/design-system.md](../../design/design-system.md#companion-and-dictation-windows-fix41).

## What the owner asked for

- On 19 October 2026 the owner decided that Frost (`bitbots`), Pop and Dot should style the companion and dictation windows, as Legacy already does.
- The companion and dictation windows had a fixed dark palette in every look. The looks never reached them.
- Styling only. No change to companion behaviour, layout, drag, placement or sizes. No new animation. `prefers-reduced-motion` is respected.
- Legacy and Blobots do not change.
- The per-bot art keeps working in every look.
- Each look must read correctly in light, with text at 4.5:1 or more. A look that could not reach that would stay dark, and the report would say so. No look had to stay dark.

## What landed per look

Each look has its own layer. The layer is scoped to the look and to the window class (`companion-surface` or `dictation-surface`). The main-window rules and their `:not(...)` guards are unchanged.

Each layer sets the companion's surface, text, line, accent and font tokens, plus the companion's own text, status, shimmer and alpha tokens. Then it styles the parts the tokens cannot reach: the capsule, the listening pill, island cards, tabs, primary and secondary buttons, and the dictation island.

- **Frost (`bitbots`).** A solid tint at the Solid glass level, with blur 0. A faint inner top highlight and soft hairlines. See the window-effect finding below.
- **Pop (`pop`).** A 2 px ink line, drawn with an inset `box-shadow`. The offset shadows (4 px and 3 px) are outer `box-shadow`s. Neither changes any box's size, so no box grows. Fonts: DM Sans Variable and Bricolage Grotesque Variable.
- **Dot (`dot`).** Dotted outlines and borders. Fonts: Geist, Geist Mono and Doto.
- **Bot-coloured text on light.** Overview chips, chat mentions, team-chip names and settings chips mix the bot colour toward ink, using a shared 15% bot-colour share. This keeps them at 4.5:1 or more.

Other changes:

- `apps/desktop/src/preview/dictationPreview.tsx` (preview only) accepts `?style=`, `?theme=light|dark` and `?surface=companion|dictation`.
- New test file `apps/desktop/src/ui/companionLooks.mounted.test.ts`. It injects the CSS into happy-dom and checks the dark and light tokens for each look on both windows. It also checks the light Settings and Activity text tokens, that Legacy and Blobots tokens do not change with `data-surface-theme=light`, that main-window Frost values do not reach the companion, and that the compact capsule and dictation island heights do not change.
- `apps/desktop/src/ui/appearance.mounted.test.ts` covers `data-surface-theme` and `data-theme-choice`.

## How the theme reaches the overlay windows

- The companion and dictation windows keep `data-theme="dark"`. `index.html` forces it, so the Legacy and Blobots light rules can never reach them.
- A new attribute, `data-surface-theme` (`light` or `dark`, the user's resolved theme), is set on the overlay windows only:
  - the boot script in `apps/desktop/index.html`;
  - `applySurfaceAppearance(..., companion=true)` in `apps/desktop/src/ui/appearance.ts`, which also keeps `data-theme-choice` current;
  - the `prefers-color-scheme` listener in `apps/desktop/src/ui/App.tsx`, which updates the companion when the choice is System.
- The dictation window has no live appearance listener. It takes the theme when it is created. A theme change reaches it the next time the window is created.

## Frost window-effect finding

Tauri windows here have no window effect, so the companion cannot blur what is behind it.

- The companion window builder is at `apps/desktop/src-tauri/src/lib.rs:2262-2265`.
- The dictation window builder is at `apps/desktop/src-tauri/src/lib.rs:2377-2380`.
- Both are `.transparent(true)`. Neither sets blur, acrylic or mica.
- `tauri.conf.json` sets no window effect either.

Result: Frost uses a solid tint in the overlay windows. It is the Solid glass level with blur 0.

## Contrast

Method: the WCAG 2.x ratio of the computed text colour over its composited background. Ancestor backgrounds are alpha-blended down to the first opaque one. Animations were finished first. Each figure is the worst text element in that view. Viewports: 760x400 for the companion views and 1040x900 for the dictation views.

| Look / theme | Compact | Approval | Overview | Chat | Activity | Settings | Dictation |
|---|---:|---:|---:|---:|---:|---:|---:|
| Frost dark | 9.82 | 6.53 | 6.53 | 4.68 | 5.81 | 6.27 | 9.10 |
| Frost light | 7.77 | 7.07 | 7.07 | 6.98 | 6.52 | 4.71 | 7.37 |
| Pop dark | 9.37 | 6.18 | 6.18 | 4.75 | 5.52 | 5.64 | 8.24 |
| Pop light | 7.05 | 7.05 | 7.05 | 6.24 | 7.05 | 5.64 | 7.05 |
| Dot dark | 10.84 | 9.12 | 8.48 | 6.03 | 8.33 | 5.79 | 10.84 |
| Dot light | 6.30 | 6.29 | 6.29 | 6.17 | 5.79 | 5.79 | 6.30 |
| Blobots dark (reference) | 7.93 | - | 5.99 | 5.98 | 5.42 | 5.99 | - |

All text in every view is at least 4.5:1. No look had to stay dark. Text sits on the opaque capsule and cards, never directly on the desktop.

## Legacy and Blobots unchanged

- A computed-style fingerprint was taken of every visible element in the compact, chat, activity and settings views. It covers 17 properties per element, including size, colour, border, shadow and font. The views were checked dark and with `?theme=light`. The fingerprint is identical before (base `9758572`) and after.
- The compact bar measures 344x62 in Blobots, Frost, Pop and Dot.
- The dictation island's CSS height is 46 px in Pop and Dot, as in Blobots.
- Per-bot art renders in the companion in every look, including the robot and Dot's dot-matrix face. Checked visually.

## Review rounds

The lane was Codex `gpt-6-luna` (high), in worktree `D:\fx42` on branch `fix42-companion-looks`. It ran four rounds. The Director reviewed every round, merged the result into `claude/priceless-shamir-29e003`, and ran the gates and the browser audit.

- **Round 1 to 2.** The test could not load under happy-dom because of a file URL. Dot's selected-surface token hid the approval card's icon. Light overview chips measured 2.1 to 3.1:1. The Pop display font name was wrong, so it fell back. Pop's default palette was light. The companion's theme choice went stale.
- **Round 2 to 3.** Light Activity titles measured 1.2:1 and Settings titles 1.7:1, because the companion text tokens were dark-only. Light mentions and bot names measured 2.3 to 3.5:1. Dark mentions measured 4.28 in Frost and 4.38 in Pop.
- **Round 3 to 4.** Light team-chip names in chat measured 2.3:1.
- **Out of scope.** In round 3 the lane also edited `docs/history/fix-40/report.md`. The Director reverted that change.

## Gates

- `npx tsc -b --pretty false`: clean.
- `npx vitest run`: 180 files, 1,352 tests passed.
- `git diff --check`: clean.

The desktop build was not run in this session. No Rust gate is recorded for this wave.

## Not verified

- **The real transparent native windows over other apps.** Not built in this session. This is the main open check.
- **Fonts in the preview.** Vite refused the Geist font files (HTTP 403), because `node_modules` is a junction outside the worktree. The font family is applied, but the face was not loaded in the preview. Check in the desktop build.
- **Dictation theme changes.** The dictation window follows a theme change only when it is next created.
- **Main-window looks.** Untouched. They were not re-audited beyond the full test suite.
