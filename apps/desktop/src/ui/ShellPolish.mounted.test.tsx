// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let host: HTMLDivElement
let style: HTMLStyleElement
const root = document.documentElement
let previousTheme: string | null
let previousLook: string | null
beforeEach(() => {
  previousTheme = root.getAttribute('data-theme')
  previousLook = root.getAttribute('data-bitbots')
  style = document.createElement('style')
  style.textContent = ['theme.css', 'shell.css', 'settings.css', 'botWizard.css', 'tooltipPortal.css']
    .map((file) => readFileSync(resolve(process.cwd(), 'src/ui', file), 'utf8')).join('\n')
  document.head.append(style)
  host = document.createElement('div'); document.body.append(host)
})
afterEach(() => {
  host.remove(); style.remove()
  for (const [name, value] of [['data-theme', previousTheme], ['data-bitbots', previousLook]]) {
    if (value === null) root.removeAttribute(name!)
    else root.setAttribute(name!, value!)
  }
})

describe.each([
  { theme: 'dark', look: 'off' }, { theme: 'light', look: 'off' },
  { theme: 'dark', look: 'on' }, { theme: 'light', look: 'on' },
])('shell CSS in $theme, Bitbots $look', ({ theme, look }) => {
  beforeEach(() => { root.setAttribute('data-theme', theme); root.setAttribute('data-bitbots', look) })

  it('separates later settings groups without putting a line below a page header or above the wizard first group', () => {
    host.innerHTML = '<div class="settings-content"><h2>Page title</h2><section class="settings-group"></section><section class="settings-group"></section></div><div class="bot-wizard-body"><section class="settings-group"></section><section class="settings-group"></section></div>'
    for (const page of host.children) {
      const groups = page.querySelectorAll('.settings-group')
      expect(getComputedStyle(groups[0]).borderTopWidth).not.toBe('1px')
      expect(getComputedStyle(groups[1]).borderTopWidth).toBe('1px')
      expect(getComputedStyle(groups[1]).paddingTop).toBe('20px')
    }
  })

  it('uses one centred fixed-width checklist with left-aligned rows and clipped detail', () => {
    host.innerHTML = '<div class="launch-checklist-window"><ol class="launch-checklist"><li><span class="launch-check-icon"></span><span class="launch-check-copy"><strong>Loading models</strong><small>Some longer detail</small></span></li></ol></div>'
    const list = getComputedStyle(host.querySelector('.launch-checklist')!)
    // happy-dom cannot compute min(); check the authored bound and the other computed rules.
    expect(style.textContent).toMatch(/\.launch-checklist\s*\{[^}]*width:\s*min\(320px,\s*100%\)/)
    expect(list.marginLeft).toBe('auto')
    expect(list.marginRight).toBe('auto')
    const row = getComputedStyle(host.querySelector('li')!)
    expect(row.justifyContent).toBe('start')
    expect(row.gridTemplateColumns).toBe('20px minmax(0, 1fr)')
    expect(getComputedStyle(host.querySelector('small')!).textOverflow).toBe('ellipsis')
    // F3: a long label clips too now.
    expect(getComputedStyle(host.querySelector('strong')!).textOverflow).toBe('ellipsis')
  })

  it('rings the sidebar search only for keyboard focus', () => {
    // happy-dom does not match :focus-visible, so check the authored selector (F2).
    expect(style.textContent).toMatch(/\.sidebar-search:focus-visible\s*\{[^}]*box-shadow/)
    expect(style.textContent).not.toMatch(/\.sidebar-search:focus-within/)
  })

  it('keeps the Manager badge circular and the portal tooltip above the usage backdrop', () => {
    host.innerHTML = '<span class="leader-badge"></span><div class="sheet-backdrop"></div><span class="tip-bubble tip-portal"></span>'
    // team.css supplies the normal circle; Bitbots must preserve it over its global square reset.
    const badgeStyle = document.createElement('style')
    badgeStyle.textContent = readFileSync(resolve(process.cwd(), 'src/ui/team.css'), 'utf8')
    document.head.prepend(badgeStyle)
    try {
      expect(getComputedStyle(host.querySelector('.leader-badge')!).borderRadius).toBe('50%')
      expect(Number(getComputedStyle(host.querySelector('.tip-portal')!).zIndex)).toBeGreaterThan(Number(getComputedStyle(host.querySelector('.sheet-backdrop')!).zIndex))
    } finally { badgeStyle.remove() }
  })
})
