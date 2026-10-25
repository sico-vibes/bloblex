// FIX38 H3: the branch lines in the Conversations column join up at every depth
// and in both looks. happy-dom has no layout, so these read the stylesheets and
// check the rules that keep the guide and the elbow in step.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = (name: string) => readFileSync(resolve(process.cwd(), 'src/ui', name), 'utf8')
const panel = css('conversationsPanel.css')

/** Split a stylesheet into `{ selector, body }` without comments. */
const rules = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((chunk) => {
  const [selector = '', ...body] = chunk.split('{')
  return { selector: selector.trim().replace(/\s+/g, ' '), body: body.join('{').trim() }
})
const rule = (source: string, selector: string) => {
  const found = rules(source).find((entry) => entry.selector === selector)
  if (!found) throw new Error(`no rule for ${selector}`)
  return found.body
}

const GUIDE = '.convo-children > .convo-item::before'
const ELBOW = '.convo-children > .convo-item > .convo-row::before'
const LEAF_ELBOW = '.convo-children > .convo-item > .convo-row:not(.branch)::before'

describe('conversation branch lines', () => {
  it('runs one guide down the parent column, over a row hover or selection', () => {
    const guide = rule(panel, GUIDE)
    expect(guide).toMatch(/top: 0; bottom: 0/)
    expect(guide).toMatch(/left: var\(--convo-guide-x\)/)
    expect(guide).toMatch(/z-index: 1/) // above .convo-row's hover/selected background
  })

  it('hangs the elbow off the child row so a two-line row still meets the guide', () => {
    const elbow = rule(panel, ELBOW)
    expect(elbow).toMatch(/top: 0; bottom: 50%/) // half the row, whatever its height
    expect(elbow).not.toMatch(/height:/)
    expect(elbow).toMatch(/left: calc\(var\(--convo-guide-x\) - var\(--convo-row-edge\)\)/)
    expect(elbow).toMatch(/border-bottom-left-radius: var\(--convo-radius\)/)
  })

  it('runs the elbow one indent across to the child, and on to its avatars when it has no arrow', () => {
    expect(rule(panel, ELBOW)).toMatch(/width: var\(--convo-indent\)/)
    expect(rule(panel, LEAF_ELBOW)).toMatch(/width: calc\(var\(--convo-indent\) \+ 11px\)/)
  })

  // FIX43 item 10: the owner wants the tree to start below the parent card and run down to each child, as in Claude Code's
  // branch tree, not to hang from the parent's own arrow through the lower half of its card.
  it('starts the trunk below the parent card: nothing is drawn inside a branch row, and the children start a little under it', () => {
    expect(rules(panel).some((entry) => entry.selector.includes('.convo-row.branch::after'))).toBe(false)
    expect(rule(panel, '.convo-children')).toMatch(/margin-top: 3px/)
    expect(rule(panel, '.convo-children')).toMatch(/--convo-guide-x: calc\(var\(--parent-depth, 0\) \* var\(--convo-indent\) \+ 9px\)/)
  })

  it('marks a row with children as a branch', () => {
    const tsx = css('ConversationsPanel.tsx')
    expect(tsx).toMatch(/convo-row.*\$\{node\.kind\}\$\{node\.children\.length > 0 \? ' branch' : ''\}/)
  })

  it('is one set of numbers for both looks: only the stroke differs', () => {
    // Classic states the geometry and the stroke once, on the panel.
    const base = rule(panel, '.conversations-panel')
    expect(base).toMatch(/--convo-indent: 14px/)
    expect(base).toMatch(/--convo-line: var\(--line-strong\)/)
    expect(base).toMatch(/--convo-line-style: solid/)
    expect(base).toMatch(/--convo-radius: 6px/)
    // Every line takes its stroke from those variables.
    for (const body of [rule(panel, GUIDE), rule(panel, ELBOW)]) {
      expect(body).toMatch(/1px var\(--convo-line-style\) var\(--convo-line\)/)
    }
    // The Bitbots look swaps the stroke and the row edge, never the geometry.
    const bbPanel = rule(panel, ':root[data-bitbots="on"] .conversations-panel')
    expect(bbPanel).toMatch(/--convo-line: var\(--bb-line-strong\)/)
    expect(bbPanel).toMatch(/--convo-line-style: dotted/)
    expect(bbPanel).toMatch(/--convo-radius: 0px/)
    expect(bbPanel).not.toMatch(/--convo-indent|--convo-guide-x/)
    expect(rule(panel, ':root[data-bitbots="on"] .convo-row')).toMatch(/--convo-row-edge: 2px/)
  })

  it('no longer hides the arrow under the old 17px elbow', () => {
    expect(panel).not.toMatch(/height: 17px/)
    expect(rules(panel).some((entry) => entry.selector.includes('.convo-item::after'))).toBe(false)
  })
})
