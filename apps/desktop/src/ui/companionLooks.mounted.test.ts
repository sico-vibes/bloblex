// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const files = {
  theme: readFileSync(join(process.cwd(), 'src/ui/theme.css'), 'utf8'),
  haze: readFileSync(join(process.cwd(), 'src/ui/themes/haze.css'), 'utf8'),
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
function setLook(look: 'haze' | 'blobots', theme = 'dark', surface: 'companion' | 'dictation' = 'companion') {
  const root = document.documentElement
  root.className = `${surface}-surface`
  root.dataset.style = look
  root.dataset.surfaceTheme = theme
  delete root.dataset.bitbots
}

describe('mounted look tokens on companion and dictation surfaces', () => {
  // Frost (bitbots) and its companion tokens were retired on 27 October 2026.
  it('preserves the Stone palette on the companion surface', () => {
    inject(files.theme)
    setLook('blobots', 'light')
    expect(tokens()).toMatchObject({ '--surface-app': '#0e0e0e', '--text-1': '#f4f4f4', '--text-2': '#a6a6a6' })
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
    inject(files.haze)
    for (const look of ['haze', 'blobots'] as const) {
      setLook(look)
      expect([getComputedStyle(capsule).height, getComputedStyle(island).height]).toEqual(before)
    }
  })
})
