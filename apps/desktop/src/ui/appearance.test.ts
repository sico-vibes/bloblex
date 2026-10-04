// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { appearanceAttributes } from './appearance'

const themeCss = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')

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
