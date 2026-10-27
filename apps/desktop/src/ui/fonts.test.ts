// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { applyFonts, FONT_CATALOGUE, FONT_DEFAULTS } from './fonts'
import { THEME_STYLES } from './appearance'

describe('bundled font catalogue', () => {
  it('has unique daemon-safe ids and a default for each look', () => {
    const ids = FONT_CATALOGUE.map((font) => font.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => /^[a-z0-9-]{1,40}$/.test(id))).toBe(true)
    for (const style of THEME_STYLES) expect(FONT_DEFAULTS[style]).toBeDefined()
    expect(FONT_DEFAULTS).toMatchObject({ haze: { ui: 'inter', mono: '' }, blobots: { ui: '', mono: '' } })
  })
  it('removes inline font overrides when a look supplies its own stylesheet fonts', async () => {
    document.documentElement.style.setProperty('--font-ui', 'Temporary UI')
    document.documentElement.style.setProperty('--font-mono', 'Temporary mono')
    await applyFonts('', '', 'blobots')
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe('')
    document.documentElement.style.setProperty('--font-ui', 'Temporary UI')
    document.documentElement.style.setProperty('--font-mono', 'Temporary mono')
    await applyFonts('', '', 'blobots')
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe('')
  })
  it('loads Inter for Haze by default while leaving Stone defaults alone', async () => {
    await applyFonts('', '', 'haze')
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toContain('Inter')
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe('')
    await applyFonts('', '', 'blobots')
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe('')
  })
})
