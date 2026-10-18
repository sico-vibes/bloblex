# FIX38 H3 — broken branch lines in the Conversations column (classic look)

Lane: OpenCode `deepseek-v4.1-flash` (high), worktree `C:\fx73`. No commit was run.

## What was wrong

The explorer-style branch lines were built from two pseudo-elements on each
child `<li class="convo-item">` (`conversationsPanel.css`, old lines 38–43):

- a guide, `::before`, `top: 0; bottom: 0`, at
  `left: calc(var(--parent-depth) * 14px + 9px)`;
- an elbow, `::after`, `top: 0; width: 10px; height: 17px`, with a 6px rounded
  bottom-left corner.

Four separate faults made the classic (solid, faint `--line-strong`) stroke
look broken, while the Bitbots dotted stroke hid most of them:

1. **Fixed 17px elbow against a variable row height.** The elbow's horizontal
   sits 17px below the child `<li>`s top, which is the row's middle only for a
   single-line 34px row. A bot-to-bot (side) row is two lines, so it is taller
   than 34px and the elbow's horizontal ended above the row's real middle,
   detached from the row's avatars.
2. **The elbow stopped short of the child.** `left + 10px` ends at
   `parent-depth * 14 + 19`, i.e. 5px into the child's 18px chevron/space
   column, 15px left of the child's first visual element (the face pair at
   `depth * 14 + 20`).
3. **The guide was painted under the row.** The guide is a pseudo-element of
   the `<li>`, and `::before` paints below the positioned `.convo-row` and its
   background, so a hover/selected row covered the line and "cut" it.
4. **No line from a branch's own arrow down to its children.** The children's
   guide started at the parent row's bottom edge, unconnected to the expand
   arrow, and a branch nested below another row lost the join altogether.

The Bitbots look "looked right" only because its dotted stroke absorbed these
1–17px gaps; the geometry was never different.

## The fix

`apps/desktop/src/ui/conversationsPanel.css`

- **Line 4** — one place for the tree numbers, shared by both looks:
  `--convo-indent: 14px`, `--convo-row-edge: 0px`, `--convo-line`,
  `--convo-line-style: solid`, `--convo-radius: 6px`.
- **Line 40** — `--convo-guide-x` (the parent's arrow column) derived from
  `--parent-depth` and `--convo-indent`.
- **Line 45** — the guide spans the whole item at `--convo-guide-x` and now has
  `z-index: 1`, so it paints over a row's hover/selected background and is
  never broken by it (fault 3). The last child still hands over to its elbow.
- **Line 51** — the elbow now hangs off the **child row** (`.convo-row::before`)
  with `top: 0; bottom: 50%`, so it meets the row's middle at any row height, a
  two-line child included (fault 1). `--convo-row-edge` offsets the row's 2px
  Bitbots border so the elbow lines up with the `<li>`-based guide in that look.
- **Line 54** — a row with no arrow of its own (`:not(.branch)`) has no guide
  column to meet, so the elbow runs on to the row's first content, the face
  pair (`--convo-indent + 11px`) — the reported "apart from the avatars"
  (fault 2). A branch row stops at its own chevron column.
- **Line 57** — `.convo-row.branch::after` carries the guide on below the
  branch's own arrow, from its middle to the row's bottom, so the line is
  continuous from the parent row into its children and joins again at every
  further depth (fault 4).
- **Line 18** — `.convo-twisty` gets `position: relative; z-index: 1` so the
  expand arrow paints over that continuation.
- **Lines 65–66** — the Bitbots look now only swaps the stroke
  (`--convo-line: var(--bb-line-strong)`, `--convo-line-style: dotted`,
  `--convo-radius: 0px`) and the row edge (`--convo-row-edge: 2px`); it no
  longer redeclares any geometry, so both looks draw the same tree.

`apps/desktop/src/ui/ConversationsPanel.tsx` **line 80** — a row with children
gets a `branch` class, which the elbow and the continuation above key off.

Geometry check, classic, child at depth `d` (parent depth `d-1`): guide and
elbow x = `(d-1)*14 + 9`; a branch elbow ends at `d*14 + 9` (the child's arrow
column) and the leaf elbow at `d*14 + 20` (the face pair); the elbow's
horizontal is at the row's middle in every case. The Bitbots look shifts both
by the same 2px row border, so the joints stay flush there too.

## Tests

`apps/desktop/src/ui/fix38TreeLines.test.ts` (new, 7 cases). happy-dom has no
layout, so it reads the stylesheets and asserts the rules instead: the elbow is
row-anchored (`top: 0; bottom: 50%`, no fixed height) and takes its stroke from
`--convo-line` / `--convo-line-style`; the guide spans the item at
`--convo-guide-x` with `z-index: 1`; the leaf elbow reaches
`--convo-indent + 11px`; the branch continuation runs `50%` to `0`; the TSX
marks branch rows; and the Bitbots look overrides only the stroke variables, so
both looks share one set of numbers. It also fails if the old `height: 17px`
elbow returns.

## Gates (all pass, worktree `C:\fx73`)

- `cd apps/desktop && npx tsc -b` — clean.
- `npx vitest run --maxWorkers=3` — **163 files, 1143 tests, all passing**
  (was 162 / 1136; +1 file, +7 tests).
- `npm run build` — built OK.

## For the Director

Please confirm in the browser preview, in both looks and both themes:

1. Expand a main conversation with a bot-to-bot child: the guide runs from the
   parent's arrow down to the child's elbow, which meets the child's face pair.
2. Hover and select both rows: the line stays visible and unbroken over the
   highlight.
3. A two-line side child still connects at the row's middle.
4. Open a branch nested deeper (if one is available) and check the join.

No commit was run; the diff waits for your review and merge.
