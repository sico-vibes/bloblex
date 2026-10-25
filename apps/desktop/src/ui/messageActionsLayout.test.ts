import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The message buttons are centred on the bubble only while the row inside the action shell has no margin of its own: `.message-row.user`
// and `:has(.message-reaction-badge)` both add a top margin that would otherwise shift the row under the buttons (FIX43 item 4).
describe('message action layout', () => {
  const css = readFileSync(new URL('./experiments.css', import.meta.url), 'utf8')
  it('clears the row margin for user rows, group starts and rows with a reaction badge', () => {
    const rule = css.split('\n').find((line) => line.startsWith('.message-action-shell > .message-row:is('))
    expect(rule).toBeTruthy()
    for (const selector of ['.user', '.group-start', ':has(.message-reaction-badge)']) expect(rule).toContain(selector)
    expect(rule).toContain('margin: 0')
  })
})
