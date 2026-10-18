// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlashCommandChip, SlashMenu } from './SlashMenu'
import { slashItems } from './slashCommands'

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
function mount(node: React.ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(node))
  mounted.push({ root, host })
  return host
}

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } vi.unstubAllGlobals() })

const skills = [{ name: 'code-review', description: 'Review a change for bugs.' }]

describe('SlashMenu', () => {
  it('renders one row per group and marks the active one', () => {
    const items = slashItems('', { skills, isManager: true })
    const host = mount(<SlashMenu items={items} activeIndex={0} onPick={() => undefined} onHover={() => undefined} />)
    const groups = [...host.querySelectorAll('.slash-menu-group')].map((node) => node.textContent)
    expect(groups).toEqual(['Actions', 'Skills', 'Manager'])
    const options = [...host.querySelectorAll<HTMLButtonElement>('.slash-option')]
    expect(options.length).toBe(items.length)
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    expect(options[0].textContent).toContain('/plan')
    expect(options.find((option) => option.textContent?.includes('/code-review'))?.textContent).toContain('Review a change for bugs.')
  })

  it('picks and hovers the requested row and renders nothing when empty', () => {
    const onPick = vi.fn(); const onHover = vi.fn()
    const items = slashItems('', { skills })
    const host = mount(<SlashMenu items={items} activeIndex={0} onPick={onPick} onHover={onHover} />)
    const codeReview = [...host.querySelectorAll<HTMLButtonElement>('.slash-option')].find((option) => option.textContent?.includes('/code-review'))!
    act(() => codeReview.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: 'code-review', kind: 'skill' }))
    act(() => codeReview.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(onHover).toHaveBeenCalled()
    expect(mount(<SlashMenu items={[]} activeIndex={0} onPick={onPick} onHover={onHover} />).childElementCount).toBe(0)
  })

  it('shows the picked command as a chip with a remove button', () => {
    const onRemove = vi.fn()
    const host = mount(<SlashCommandChip command={{ kind: 'manager', name: 'interview' }} onRemove={onRemove} />)
    expect(host.querySelector('.slash-chip')?.textContent).toContain('/interview')
    expect(host.querySelector('.slash-chip-tag')?.textContent).toBe('Manager')
    act(() => host.querySelector<HTMLButtonElement>('.slash-chip-remove')!.click())
    expect(onRemove).toHaveBeenCalled()
  })
})
