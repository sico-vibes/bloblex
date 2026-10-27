// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { appearanceAttributes, accentTokens, contrastRatio, isThemeStyle, normalizeAccent, normalizeThemeStyle, THEME_LOOKS, THEME_STYLES } from './appearance'

const themeCss = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
const hazeCss = readFileSync(new URL('./themes/haze.css', import.meta.url), 'utf8')
const densityCss = readFileSync(new URL('./density.css', import.meta.url), 'utf8')

function declarations(selector: string) {
  const start = themeCss.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`Missing ${selector} theme block`)
  const end = themeCss.indexOf('\n}', start)
  const block = themeCss.slice(start, end)
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]))
}

function hexRgb(value: string) {
  const raw = value.replace('#', '')
  if (raw.length !== 6 && raw.length !== 8) throw new Error(`Expected hex color, got ${value}`)
  return [0, 2, 4].map((offset) => Number.parseInt(raw.slice(offset, offset + 2), 16) / 255)
}

function luminance(value: string) {
  const [red, green, blue] = hexRgb(value).map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
  return .2126 * red! + .7152 * green! + .0722 * blue!
}

function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0]! + .05) / (values[1]! + .05)
}

function colorTokens(theme: 'dark' | 'light') {
  const base = declarations(':root')
  const override = theme === 'light' ? declarations(':root[data-theme="light"]') : new Map<string, string>()
  const get = (name: string) => override.get(name) ?? base.get(name) ?? (() => { throw new Error(`Missing ${name}`) })()
  return { get }
}

function composite(color: string, under: string) {
  const rawColor = color.replace('#', '')
  if (rawColor.length === 6) return color
  const [red, green, blue] = hexRgb(color)
  const [underRed, underGreen, underBlue] = hexRgb(under)
  const alpha = Number.parseInt(rawColor.slice(6, 8), 16) / 255
  return `#${[red!, green!, blue!].map((channel, index) => Math.round((channel * alpha + [underRed!, underGreen!, underBlue!][index]! * (1 - alpha)) * 255).toString(16).padStart(2, '0')).join('')}`
}

describe('appearance token selection', () => {
  it('keeps a visible focus ring on controls in Haze', () => {
    expect(hazeCss).not.toMatch(/\.app-shell\s+\*\s*\{[^}]*box-shadow\s*:\s*none/)
    expect(themeCss).toContain(':focus-visible { outline: none; box-shadow: var(--focus-ring); }')
    expect(densityCss).toContain('.density-control button:focus-visible { outline: none; box-shadow: var(--focus-ring); }')
  })
  it('preserves visible focus rings in Haze and avoids a blanket shadow reset', () => {
    expect(hazeCss).not.toMatch(/\.app-shell\s+\*\s*\{[^}]*box-shadow\s*:\s*none/)
    expect(themeCss).toContain('--focus-ring: 0 0 0 2px')
    expect(densityCss).toContain('.density-control button:focus-visible { outline: none; box-shadow: var(--focus-ring); }')
  })
  it('resolves explicit themes and preserves text size', () => {
    expect(appearanceAttributes('light', 'larger')).toEqual({ theme: 'light', textSize: 'larger' })
    expect(appearanceAttributes('dark', 'small')).toEqual({ theme: 'dark', textSize: 'small' })
  })

  it('keeps text and status tokens at AA contrast on their actual light and dark surfaces', () => {
    for (const theme of ['dark', 'light'] as const) {
      const token = colorTokens(theme).get
      const surfaces = ['--surface-app', '--surface-sidebar', '--surface-raised', '--surface-selected']
      for (const surface of surfaces) {
        expect(contrast(token('--text-1'), token(surface)), `${theme} --text-1 on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
      for (const surface of ['--surface-app', '--surface-sidebar', '--surface-raised', '--surface-selected']) {
        expect(contrast(token('--text-2'), token(surface)), `${theme} --text-2 on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrast(token('--text-3'), token('--surface-selected')), `${theme} selected-row tertiary text`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(token('--text-3'), token('--surface-sidebar')), `${theme} sidebar tertiary text`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(token('--status-working'), token('--surface-selected')), `${theme} approval pill`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(token('--status-danger'), token('--surface-selected')), `${theme} error glyph`).toBeGreaterThanOrEqual(3)
      expect(contrast(token('--status-success'), token('--surface-raised')), `${theme} success status`).toBeGreaterThanOrEqual(4.5)
      const errorSurface = composite(token('--surface-danger'), token('--surface-raised'))
      expect(contrast(token('--status-danger-text'), errorSurface), `${theme} error banner`).toBeGreaterThanOrEqual(4.5)
      const warningSurface = composite(token('--surface-warning'), token('--surface-raised'))
      expect(contrast(token('--status-working-text'), warningSurface), `${theme} warning text`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(token('--tree-line'), token('--surface-sidebar')), `${theme} tree guide`).toBeGreaterThanOrEqual(3)
      expect(contrast(token('--surface-toggle-off'), token('--surface-sidebar')), `${theme} toggle track`).toBeGreaterThanOrEqual(3)
      expect(contrast(token('--surface-toggle-knob'), token('--surface-toggle-off')), `${theme} toggle knob`).toBeGreaterThanOrEqual(3)
    }
  })

  it('restores the companion surface, text, focus and status tokens to the dark palette', () => {
    const dark = declarations(':root')
    const companion = declarations(':root.companion-surface')
    for (const name of [
      '--surface-app', '--surface-sidebar', '--surface-panel', '--surface-raised', '--surface-overlay', '--surface-input', '--surface-hover', '--surface-selected',
      '--line', '--line-strong', '--text-1', '--text-2', '--text-3', '--text-inverse', '--status-working', '--status-danger', '--status-success',
      '--status-danger-text', '--surface-danger', '--status-working-text', '--surface-warning', '--focus-ring', '--line-focus', '--surface-primary-hover',
      '--shadow-pop', '--chart-bar', '--chart-bar-hover', '--chart-track', '--chart-provider', '--chart-permission', '--chart-timeout', '--chart-budget', '--chart-config', '--chart-context',
    ]) expect(companion.get(name), `companion ${name}`).toBe(dark.get(name))
  })
})

describe('user accent colours', () => {
  it('normalizes only #rrggbb colours, in lower case', () => {
    expect(normalizeAccent('#E17A56')).toBe('#e17a56')
    expect(normalizeAccent('#3b82f6')).toBe('#3b82f6')
    expect(normalizeAccent('')).toBe('')
    expect(normalizeAccent('  #3b82f6')).toBe('')
    expect(normalizeAccent('#3b82f')).toBe('')
    expect(normalizeAccent('#3b82f6f')).toBe('')
    expect(normalizeAccent('3b82f6')).toBe('')
    expect(normalizeAccent('rgb(59,130,246)')).toBe('')
    expect(normalizeAccent(0x3b82f6)).toBe('')
    expect(normalizeAccent(null)).toBe('')
    expect(normalizeAccent(undefined)).toBe('')
  })

  // Frost (bitbots) was retired on 27 October 2026; Haze and Stone (blobots) remain.
  it('recognizes only Haze and Stone, and moves retired looks to Haze', () => {
    expect(THEME_STYLES).toEqual(['haze', 'blobots'])
    for (const look of THEME_STYLES) expect(isThemeStyle(look)).toBe(true)
    for (const retired of ['bitbots', 'legacy', 'pop', 'dot']) {
      expect(isThemeStyle(retired)).toBe(false)
      expect(normalizeThemeStyle(retired)).toBe('haze')
    }
    expect(normalizeThemeStyle('blobots')).toBe('blobots')
    expect(isThemeStyle('Blobots')).toBe(false)
    expect(isThemeStyle('')).toBe(false)
    expect(isThemeStyle(undefined)).toBe(false)
    expect(THEME_LOOKS.map((look) => look.id)).toEqual(THEME_STYLES)
    expect(THEME_LOOKS[0]?.description).toBe('Smoky glass. Bots show a logo or a character.')
    expect(THEME_LOOKS[1]?.description).toBe('Soft, quiet and monochrome.')
  })

  it('computes WCAG contrast for known pairs', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    expect(contrastRatio('#3b82f6', '#ffffff')).toBeCloseTo(3.68, 1)
    expect(contrastRatio('#0f0f10', '#ffffff')).toBeGreaterThan(19)
  })

  it('picks the ink that reaches AA on every tested accent', () => {
    for (const accent of ['#ffffff', '#000000', '#e17a56', '#3b82f6', '#facc15']) {
      const tokens = accentTokens(accent)
      expect(tokens.accent).toBe(accent)
      expect(contrastRatio(tokens.ink, accent), accent).toBeGreaterThanOrEqual(4.5)
    }
    expect(accentTokens('#ffffff').ink).toBe('#0f0f10')
    expect(accentTokens('#000000').ink).toBe('#ffffff')
    expect(accentTokens('#e17a56').ink).toBe('#0f0f10')
    expect(accentTokens('#3b82f6').ink).toBe('#0f0f10')
  })

  it('derives the pressed, soft and ink tokens', () => {
    expect(accentTokens('#3b82f6')).toEqual({ accent: '#3b82f6', pressed: '#3472d8', soft: 'rgba(59,130,246,.14)', ink: '#0f0f10' })
    expect(accentTokens('nonsense')).toEqual({ accent: '', pressed: '', soft: '', ink: '#0f0f10' })
  })
})
