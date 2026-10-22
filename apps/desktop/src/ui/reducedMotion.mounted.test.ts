// @vitest-environment happy-dom
// Source-level checks for the reduced-motion audit (item 10) and the eased
// panel/menu transitions in Bitbots (item 11). These read the stylesheets as
// text, because the behaviour they describe is a media-query and a cascade that
// happy-dom does not evaluate.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string) => readFileSync(resolve(process.cwd(), 'src/ui', file), 'utf8')

/** Every `@media (prefers-reduced-motion: reduce)` body, brace-matched. */
function reducedMotionBlocks(css: string): string[] {
  const marker = '@media (prefers-reduced-motion: reduce)'
  const blocks: string[] = []
  let index = css.indexOf(marker)
  while (index !== -1) {
    let depth = 0
    let start = -1
    for (let at = index + marker.length; at < css.length; at++) {
      if (css[at] === '{') { if (depth === 0) start = at + 1; depth++ }
      else if (css[at] === '}') { depth--; if (depth === 0) { blocks.push(css.slice(start, at)); break } }
    }
    index = css.indexOf(marker, index + marker.length)
  }
  return blocks
}

const guarded = (css: string, selector: string) => reducedMotionBlocks(css).some((block) => block.includes(selector))

describe('reduced motion audit', () => {
  it('guards the typing dots and the warming dictation pulse in shell.css', () => {
    const css = read('shell.css')
    expect(guarded(css, '.typing i')).toBe(true)
    expect(guarded(css, '.dictation-button.warming')).toBe(true)
  })

  it('guards the companion status shimmer in companion.css', () => {
    expect(guarded(read('companion.css'), '.shimmer')).toBe(true)
  })

  it('keeps the global loop stopper that covers .spinning in theme.css', () => {
    const blocks = reducedMotionBlocks(read('theme.css'))
    expect(blocks.some((block) => block.includes('animation-iteration-count: 1'))).toBe(true)
  })
})

describe('Bitbots panel transitions', () => {
  it('keeps the eased preview timing in the look picker stylesheet', () => {
    const css = read('lookPicker.css')
    expect(css).toMatch(/\.look-preview\s*\{[\s\S]*?transition-timing-function:\s*cubic-bezier/)
    expect(css).toMatch(/\.sp-window\s*\{[\s\S]*?transition-timing-function:\s*cubic-bezier/)
  })
})
