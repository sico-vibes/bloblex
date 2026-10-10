// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextWindowIndicator } from './ContextWindowIndicator'

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
function mount(used?: number | null, size?: number | null) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const render = (nextUsed?: number | null, nextSize?: number | null) => root.render(<ContextWindowIndicator used={nextUsed} size={nextSize} />)
  act(() => render(used, size))
  mounted.push({ root, host })
  return { host, render }
}

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } vi.unstubAllGlobals() })

describe('reported context indicator', () => {
  it('shows zero and a percentage only when both reported fields are valid', () => {
    const { host } = mount(0, 100_000)
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toBe('0% full')
    expect(host.querySelector('.context-window-center')).toBeNull()
    expect(host.querySelector('[aria-label*="0 of 100,000 tokens used, 0%"]')).not.toBeNull()
    const partial = mount(0, null).host
    expect(partial.querySelector('[role="progressbar"]')).toBeNull()
    expect(partial.querySelector('.context-window-indicator')?.classList.contains('tone-unknown')).toBe(true)
    expect(partial.textContent).toContain('window capacity unavailable')
    expect(partial.querySelector('.context-window-ring-value')).toBeNull()
  })

  it('handles partial, invalid and changing streaming values without estimating tokens', async () => {
    const { host, render } = mount(1200, null)
    expect(host.querySelector('[aria-label]')?.getAttribute('aria-label')).toContain('1,200 tokens used')
    expect(host.querySelector('.context-window-popover')).toBeNull()
    await act(async () => { render(5000, 20_000) })
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25')
    expect(host.querySelector('[aria-label]')?.getAttribute('aria-label')).toContain('5,000 of 20,000 tokens used, 25%')
    await act(async () => { render(-2, 0) })
    expect(host.querySelector('[role="progressbar"]')).toBeNull()
    expect(host.querySelector('[aria-label]')?.getAttribute('aria-label')).toContain('Context usage unavailable')
  })

  it('opens details by click and dismisses on Escape or outside pointer', async () => {
    const { host } = mount(2000, 10_000)
    const button = host.querySelector<HTMLButtonElement>('button')!
    await act(async () => { button.click() })
    expect(host.querySelector('.context-window-popover')?.textContent).toContain('2k / 10k tokens used')
    expect(host.querySelector('.context-popover-value')?.textContent).toBe('2k / 10k (20%)')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true })) })
    expect(host.querySelector('.context-window-popover')).toBeNull()
    await act(async () => { button.click() })
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles:true })) })
    expect(host.querySelector('.context-window-popover')).toBeNull()
  })

  it('keeps hover, focus, and click visibility independent with concise reported-value copy', async () => {
    const first = mount(5000, 20_000).host
    const second = mount(1000, 4000).host
    const button = first.querySelector<HTMLButtonElement>('button')!
    const wrap = first.querySelector<HTMLElement>('.context-window-wrap')!
    expect(first.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toBe('25% full')
    expect(first.querySelector('.context-window-popover')).toBeNull()
    await act(async () => { wrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles:true })); button.click() })
    expect(first.querySelector('.context-window-popover')).not.toBeNull()
    act(() => button.focus())
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true })) })
    expect(first.querySelector('.context-window-popover')).toBeNull()
    expect(document.activeElement).toBe(button)
    await act(async () => { button.click() })
    expect(first.querySelector('.context-window-popover')).not.toBeNull()
    const firstId = first.querySelector('.context-window-popover')?.id
    await act(async () => { second.querySelector<HTMLButtonElement>('button')!.click() })
    expect(second.querySelector('.context-window-popover')?.id).not.toBe(firstId)
  })
})

describe('context popover plan limits', () => {
  it('shows only reported windows for the conversation provider and links to usage details', async () => {
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const onOpenUsage = vi.fn()
    const quota = { provider:'codex', fetchedAt:'2026-10-10T00:00:00Z', snapshot:{ limits:[{ label:'Codex', primary:{ usedPercent:12, windowDurationMins:300, resetsAt:null }, secondary:{ usedPercent:95, windowDurationMins:10080, resetsAt:null } }] } }
    act(() => root.render(<ContextWindowIndicator used={5000} size={20_000} quota={quota} onOpenUsage={onOpenUsage} />))
    mounted.push({ root, host })
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click() })
    const section = host.querySelector('.context-popover-section')!
    expect(section.textContent).toContain('Plan usage limits · Codex')
    expect(section.textContent).toContain('Session')
    expect(section.textContent).toContain('12%')
    expect(section.textContent).not.toContain('Resets in')
    expect(section.querySelectorAll('.context-popover-bar.tone-critical')).toHaveLength(1)
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('See usage details'))!.click() })
    expect(onOpenUsage).toHaveBeenCalledOnce()
  })

  it('omits the plan section when the provider has no readable windows', async () => {
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<ContextWindowIndicator used={1} size={10} quota={{ provider:'claude', lastError:'unauthorized', snapshot:null }} />))
    mounted.push({ root, host })
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click() })
    expect(host.querySelector('.context-popover-section')).toBeNull()
    expect(host.textContent).not.toContain('See usage details')
  })
})
