// FIX39 P5 follow-up. happy-dom has no layout, so the rules that keep the
// update badge off the conversation title, and the CSS consequences of the
// read-only settings fieldset, are read from the stylesheets and checked here.
// The mounted tests prove the markup and the behaviour; this proves the layout
// rules that never reach a test-rendered box.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = (name: string) => readFileSync(resolve(process.cwd(), 'src/ui', name), 'utf8')

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
const has = (source: string, selector: string) => rules(source).some((entry) => entry.selector === selector)

describe('FIX39 P5 follow-up: the header title yields to the update badge', () => {
  const team = css('team.css')

  it('sets every part of the title to shrink, whatever the bull-headed blanket rule says', () => {
    // `.chat-title > *` is `flex: 0 0 auto`; those three must opt out, or the
    // title overflows under the action side (the 1024 px overlap).
    expect(rule(team, '.chat-title > *')).toMatch(/flex: 0 0 auto/)
    expect(rule(team, '.chat-title > .conversation-crumb')).toMatch(/flex: 0 1 auto/)
    expect(rule(team, '.chat-title > .chat-title-button')).toMatch(/flex: 0 1 auto/)
    expect(rule(team, '.chat-title > .role-chip')).toMatch(/flex: 0 1 auto/)
  })

  it('truncates the title rather than letting it spill', () => {
    const title = rule(css('shell.css'), '.chat-title')
    expect(title).toMatch(/min-width: 0/)
    expect(rule(css('shell.css'), '.conversation-crumb-title')).toMatch(/text-overflow: ellipsis/)
    expect(rule(css('shell.css'), '.chat-title-button, .chat-title-text')).toMatch(/text-overflow: ellipsis/)
  })

  it('gives the action side its own space and never a shrink', () => {
    expect(rule(css('shell.css'), '.header-actions')).toMatch(/flex: 0 0 auto/)
  })
})

describe('FIX39 P5 follow-up: the locked settings fieldset', () => {
  const blob = css('blobPage.css')

  it('is a plain grid item so the settings groups keep their rhythm', () => {
    const body = rule(blob, 'fieldset.blob-settings-body')
    expect(body).toMatch(/display: grid/)
    expect(body).toMatch(/border: 0/)
    expect(body).toMatch(/margin: 0/)
    expect(body).toMatch(/padding: 0/)
  })

  it('keeps the divider on the first group after the fieldset', () => {
    // `.settings-group ~ .settings-group` no longer reaches it.
    expect(rule(blob, 'fieldset.blob-settings-body + .settings-group')).toMatch(/border-top: 1px solid var\(--line\)/)
    expect(rule(css('settings.css'), '.settings-group ~ .settings-group')).toMatch(/border-top: 1px solid var\(--line\)/)
  })
})

describe('FIX39 P5 follow-up: the Manager mark on the permission pill', () => {
  it('has a rule for the source tag and the tabular pill', () => {
    expect(has(css('team.css'), '.permission-pill > .permission-pill-source')).toBe(true)
  })
})
