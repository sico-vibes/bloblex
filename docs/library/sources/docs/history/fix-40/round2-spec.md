# FIX40 round 2: the Pop and Dot looks across the whole app

> **What this is:** Spec for FIX40 round 2: the Pop and Dot looks across the whole app.
> **Status:** historical
> **Last updated:** 2026-10-19

Two lanes, one brief. Each lane does only its own part and must not edit the other lane's files.

| Part | Lane | Worktree (branch, from `fix40`) | Owns |
|---|---|---|---|
| A. Pop | OpenCode `opencode-go/deepseek-v4.1-flash`, high | `D:\fx40p` (`fix40-pop`) | `apps/desktop/src/ui/themes/pop.css` only |
| B. Dot + small fixes | Codex `gpt-6-luna`, high | `D:\fx40d` (`fix40-dot`) | `apps/desktop/src/ui/themes/dot.css`, `ui/fonts.ts` (+ its test), `ui/LaunchIntro.tsx` (+ its test) |

Reviewer: the Director (Claude), who reads the diff, runs the gates and checks every screen in the browser preview. Expect follow-up rounds.

You have no chat history. Everything you need is here, in the repository and in `design-reference/` at your worktree root (an owner-approved design study: `redesignPreview.tsx`, `redesign.css`). The reference files are read-only; do not import or copy them into `src/`.

## Rules for both lanes

- Never run `git commit`, `git push`, `git reset` or check out other branches. Leave changes in the working tree.
- Work only inside your worktree. `node_modules` is a junction: do not run `npm install`, do not add packages (every font you need is already installed).
- Edit only the files your part owns (table above). If you believe another file must change, stop and say so in your report instead of editing it.
- Plain English UI copy, sentence case. Sparse comments in the style of the surrounding code.

## How the looks work now (facts)

- `<html data-style="...">` is one of `bitbots` (Frost, the primary look), `blobots`, `legacy` (the old pixel look; it also sets `data-bitbots="on"` and loads `ui/bitbots.css`), `pop`, `dot`. `blob/bitbots.ts` lazy-loads `ui/themes/pop.css` for `pop` and `ui/themes/dot.css` for `dot`; both files are placeholders today.
- `ui/themes/frost.css` is the model to follow: it overrides the `theme.css` tokens (`--surface-*`, `--text-*`, `--line*`, `--status-*`, `--radius-*`, `--shadow-pop`, `--accent`, `--bubble-user`, fonts) under `:root[data-style="bitbots"]:not(.companion-surface):not(.dictation-surface)`, then adds component rules only where tokens are not enough, and turns the app shell into floating panels (`.app-shell { gap: 10px; padding: 10px }`, panels with their own radius and border). Read it fully first, and read `ui/theme.css` for the full token list (dark `:root` block and the `[data-theme="light"]` block).
- Every rule must be scoped to your look and must not reach the companion or dictation windows: start selectors with `:root[data-style="pop"]:not(.companion-surface):not(.dictation-surface)` (or `dot`). Support both `data-theme="dark"` and `data-theme="light"`.
- A user accent (`--user-accent`, `--user-accent-ink`, `--user-accent-soft`, see `ui/accent.css`) must still win over your look's default accent.
- Keep keyboard focus rings visible (`--focus-ring` is a box-shadow; do not blanket-remove box shadows) and keep every selected state visible (selected rows, segmented controls with `aria-checked` / `aria-pressed`, toggles that are on).
- Shape rule shared by all new looks: rounded rectangles like the logo, never pill or circle UI (buttons, chips, composer, toggles and their knobs, segmented controls, swatches, avatar frames). Bot artwork is not UI and is not affected.
- Bots: each look already has its own default bot art (Pop → pop robot, Dot → dot robot). You do not touch bot rendering.
- Surfaces to cover (check the class names in the existing CSS; do not guess): app shell, sidebar (bot rows, groups, search, usage card, profile), conversations panel and session rail, conversation header, messages (user and bot bubbles, code blocks, activity lines, plan card, approval and question cards, working indicator, mentions), composer (box, pills, send/stop), buttons, inputs, selects and menus, segmented controls and toggles, chips and badges, tooltips, dialogs, the settings sheet and its pages (including the new Appearance page), usage / analytics, onboarding and launch, banners, empty states.

## Part A. Pop (`ui/themes/pop.css`)

The "Pop" direction in the reference (`data-rd="pop"` tokens and the "A · Pop details" section of `redesign.css`): retro but modern, colourful, outlined, playful, **not pixelated**.

- **Light (default feel):** cream paper background `#f1e7d6` with a faint dot grid (`radial-gradient(rgba(29,27,24,.09) 1px, transparent 1.4px)`, 18px); panels `#fbf6ec`; cards `#fffdf8`; inset `#f3eadb`; ink `#1d1b18`, ink-2 `#5a5348`, ink-3 `#8c8476`.
- **Dark:** background `#1c1a17` with the dot grid at `rgba(247,239,226,.06)`; panels `#282520`; cards `#312d27`; inset `#3a352e`; ink `#f7efe2`, ink-2 `#c8bdac`, ink-3 `#91877a`; outlines `#f2e8d8`; hard shadows `#050404`.
- **Pastels** (both modes, always with ink text on them): butter `#f6cf5c`, mint `#8fdcb6`, lilac `#c9b8f2`, coral `#f59a8c`, sky `#9fc5f6`, peach `#f9b993`. Accent coral `#f2694a` with ink text.
- **Outlines and shadows:** panels, cards, inputs, buttons, chips and the composer get a 2px ink outline. Hard offset shadows, no blur: panels `4px 4px 0`, cards `3px 3px 0`, buttons `2px 2px 0`, popovers and dialogs `5px 5px 0`. Buttons press in (`translate(2px, 2px)` and no shadow on `:active`).
- **Selection and fills:** selected bot row, conversation and nav item are butter with an ink outline and a 2px hard shadow. The usage card in the sidebar is sky; the "messaged" hand-off line is lilac; queue banner butter; plan step numbers butter squares; approval card coral-soft (`#fdd5c8`, dark `#5a3428`) with an outline and a hard shadow. User bubble: ink background with cream text (dark mode: cream background with ink text). Bot bubble: card with a 2px outline.
- **Toggles:** outlined track; off knob ink; on = mint track with an ink knob. Segmented controls: outlined, selected option ink with cream text. Meters: outlined track, coral fill (mint for success, butter for warning) with an ink divider at the fill edge. Activity / tool lines: dashed 2px outline. Row separators inside setting cards: 2px dashed.
- **Type:** body DM Sans, headings and the brand name Bricolage Grotesque (700 / 800). Both are installed: import `@fontsource-variable/dm-sans/index.css` and `@fontsource-variable/bricolage-grotesque/index.css` (or their latin files) at the top of `pop.css` so they load only with Pop. Set `--font-ui` to DM Sans in your token block. Small uppercase labels (section and group labels) in Bricolage, 700, `letter-spacing: .07em`.
- **Radii:** `--radius-sm 9px`, `--radius-md 12px`, `--radius-lg 16px`, `--radius-pill 12px`, panels 22px.
- **Sticker labels:** where the app shows a small status or badge chip (for example the experimental badge, "new" tags, the plan card's title tag), it may become a slightly rotated (-4deg) sticker with an outline and a 2px hard shadow. Use sparingly.

## Part B. Dot (`ui/themes/dot.css`) and small fixes

The "Dot" direction in the reference (`data-rd="dot"` tokens and the "B · Dot details" section): monochrome widgets, dot-matrix numbers, a single red, inspired by modern dot-matrix phone UIs, **not pixel art**.

- **Dark (default feel):** background `#000`; panels `#0e0e0e` with a `#1e1e1e` border; cards `#161616`; inset `#1e1e1e`; hover `#1a1a1a`; ink `#f2f2f2`, ink-2 `#9c9c9c`, ink-3 `#636363`; lines `#262626` / `#1f1f1f`. Accent red `#ff4b2b` (white text). Slate `#3d4a64` for one secondary tile colour.
- **Light:** background `#d6d6d3`; panels `#ececea`; cards `#fff`; inset `#f2f2f0`; ink `#111`, ink-2 `#666`, ink-3 `#9a9a9a`; lines `#dededa`.
- **Selection is inverted:** selected bot row, conversation, nav item and segmented option = ink background with the panel colour as text (white on black in dark, black on light grey in light).
- **Type:** body Geist (`@fontsource-variable/geist`), labels Geist Mono (`@fontsource-variable/geist-mono`) uppercase with `letter-spacing: .12em` at 10-11px, and Doto (`@fontsource/doto` 700/900, already installed) for big numbers: usage and analytics figures, the sidebar usage percentage, and timestamps in the usage views. Page titles may use Doto 900 uppercase; body copy never uses Doto. Import the fonts at the top of `dot.css`.
- **Dot-matrix details:** meters, quota bars and analytics bars are drawn as rows / columns of dots (`radial-gradient` dots on a repeating background, unlit dots in `#333` / `#cfcfcb`, lit dots ink, the important one red). Row separators inside cards: 2px dotted. Activity lines: 2px dotted outline. The working indicator: dots that light up in steps (`steps()` timing), red when attention is needed.
- **Controls:** buttons flat; the primary button red with white text; secondary buttons ink with panel-colour text. Toggles: off = inset track with a grey knob; on = ink track with a red knob. Chips: mono uppercase on the inset colour; danger and attention chips red. No outlines on cards, just the panel/card contrast.
- **Radii:** `--radius-sm 9px`, `--radius-md 12px`, `--radius-lg 16px`, `--radius-pill 12px`, panels 22px. No shadows except a soft one on popovers and dialogs.

Small fixes in Part B:

1. `ui/fonts.ts` `FONT_DEFAULTS`: `pop` → UI `dm-sans`, mono `''`; `dot` → UI `geist`, mono `geist-mono`. Update the font test.
2. `ui/LaunchIntro.tsx`: in every look except Legacy, the launch greeting must show the bot in the art it actually wears. When the resolved art (`resolveArt(look, style)` from `blob/art/art.ts`) is not `blob`, render `<BlobCanvas greeting ... />` with that look (the new arts support `greeting` and call `onGreetingComplete`) instead of the classic blob `LaunchGreeting` scene; keep `LaunchGreeting` for the glossy blob and the pixel welcome for Legacy. Update the launch tests.

## Preview and gates

The Director reviews at `http://127.0.0.1:5177/?style=pop` and `?style=dot` (and `&theme=light`), plus `?preview-settings&style=...` for the settings sheet; you cannot see the browser, so be careful and self-review your selectors against the real class names.

Run from your worktree and paste the tails in your report:

- `npm run typecheck`
- `npm test`
- `cd apps/desktop && npx vite build`

All must pass. Do not weaken or delete tests.

## Report (your final message)

1. What you styled, surface by surface, and the selectors you could not find.
2. Files changed.
3. Gate tails.
4. Decisions this brief did not specify.
