// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const files = {
  theme: readFileSync(join(process.cwd(), 'src/ui/theme.css'), 'utf8'),
  frost: readFileSync(join(process.cwd(), 'src/ui/themes/frost.css'), 'utf8'),
  pop: readFileSync(join(process.cwd(), 'src/ui/themes/pop.css'), 'utf8'),
  dot: readFileSync(join(process.cwd(), 'src/ui/themes/dot.css'), 'utf8'),
  legacy: readFileSync(join(process.cwd(), 'src/ui/bitbots.css'), 'utf8'),
  companion: readFileSync(join(process.cwd(), 'src/ui/companion.css'), 'utf8'),
  shell: readFileSync(join(process.cwd(), 'src/ui/shell.css'), 'utf8'),
}
const injected: HTMLStyleElement[] = []
function inject(css: string) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  injected.push(style)
}
afterEach(() => {
  for (const style of injected.splice(0)) style.remove()
  document.documentElement.className = ''
  document.documentElement.removeAttribute('data-style')
  document.documentElement.removeAttribute('data-bitbots')
  document.documentElement.removeAttribute('data-surface-theme')
  document.body.innerHTML = ''
})
function tokens() {
  const style = getComputedStyle(document.documentElement)
  return Object.fromEntries(['--surface-app', '--surface-panel', '--surface-raised', '--text-1', '--text-2', '--text-3', '--line', '--accent', '--font-ui', '--companion-text-settings', '--companion-text-activity'].map((key) => [key, style.getPropertyValue(key).trim()]))
}
function setLook(look: 'bitbots' | 'pop' | 'dot' | 'legacy' | 'blobots', theme = 'dark', surface: 'companion' | 'dictation' = 'companion') {
  const root = document.documentElement
  root.className = `${surface}-surface`
  root.dataset.style = look
  root.dataset.surfaceTheme = theme
  if (look === 'legacy') root.dataset.bitbots = 'on'
  else delete root.dataset.bitbots
}

describe('mounted look tokens on companion and dictation surfaces', () => {
  it('applies dark and light look tokens, while preserving Legacy and Blobots palettes', () => {
    inject(files.theme)
    inject(files.legacy)
    const baseline = (() => { setLook('blobots', 'light'); return tokens() })()
    const expected = {
      bitbots: { dark: ['#20232b', '#c9ccda'], light: ['#f5f6fa', '#4b4d58'] },
      pop: { dark: ['#1c1a17', '#c8bdac'], light: ['#fbf6ec', '#5a5348'] },
      dot: { dark: ['#0e0e0e', '#c2c2c2'], light: ['#ececea', '#555'] },
    } as const
    for (const look of ['bitbots', 'pop', 'dot'] as const) {
      inject(files[look === 'bitbots' ? 'frost' : look])
      for (const surface of ['companion', 'dictation'] as const) {
        setLook(look, 'dark', surface)
        const dark = tokens()
        expect([dark['--surface-app'], dark['--text-2']], `${look} ${surface} dark`).toEqual(expected[look].dark)
        setLook(look, 'light', surface)
        const light = tokens()
        expect([light['--surface-app'], light['--text-2']], `${look} ${surface} light`).toEqual(expected[look].light)
        expect(light['--companion-text-settings'], `${look} light settings text`).toBe(light['--text-1'])
        expect(light['--companion-text-activity'], `${look} light activity text`).toBe(light['--text-1'])
      }
    }
    setLook('legacy', 'dark')
    const legacyDark = tokens()
    setLook('legacy', 'light')
    expect(tokens()).toEqual(legacyDark)
    setLook('blobots', 'light')
    expect(tokens()).toEqual(baseline)
    expect(baseline).toMatchObject({ '--surface-app': '#0e0e0e', '--text-1': '#f4f4f4', '--text-2': '#a6a6a6' })
    expect(legacyDark).toMatchObject({ '--surface-app': '#0e0e0e', '--text-1': '#f4f4f4', '--text-2': '#a6a6a6' })
  })

  it('keeps main-window Frost tokens out of the companion surface', () => {
    inject(files.theme)
    inject(files.frost)
    setLook('bitbots')
    expect(files.frost).toContain('--surface-app: transparent')
    expect(tokens()['--surface-app']).toBe('#20232b')
    expect(tokens()['--surface-app']).not.toBe('transparent')
    expect(files.frost).toContain(':root[data-style="bitbots"]:not(.companion-surface):not(.dictation-surface)')
  })

  it('does not change the compact capsule or dictation island dimensions', () => {
    inject(files.theme)
    inject(files.companion)
    inject(files.shell)
    const host = document.createElement('div')
    host.style.height = '62px'
    const capsule = document.createElement('div')
    capsule.className = 'companion-capsule'
    const island = document.createElement('div')
    island.className = 'dictation-island'
    host.append(capsule, island)
    document.body.append(host)
    const before = [getComputedStyle(capsule).height, getComputedStyle(island).height]
    for (const look of ['frost', 'pop', 'dot'] as const) inject(files[look])
    for (const look of ['bitbots', 'pop', 'dot'] as const) {
      setLook(look)
      expect([getComputedStyle(capsule).height, getComputedStyle(island).height]).toEqual(before)
    }
  })

  it('keeps its new light layer limited to explicit look and overlay selectors', () => {
    for (const look of ['frost', 'pop', 'dot'] as const) {
      expect(files[look]).toContain('.companion-surface[data-surface-theme="light"]')
      expect(files[look]).toContain('.dictation-surface[data-surface-theme="light"]')
    }
  })
})
