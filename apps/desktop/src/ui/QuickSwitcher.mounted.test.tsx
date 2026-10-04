// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuickSwitcher } from './QuickSwitcher'
import type { QuickSwitcherItem } from './quickSwitcherModel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
afterEach(() => { if (root) act(() => root.unmount()); host?.remove() })

describe('QuickSwitcher mounted keyboard flow', () => {
  it('filters, moves with arrows, opens with Enter, and restores focus on Escape', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const opened = vi.fn()
    const closed = vi.fn()
    const items: QuickSwitcherItem[] = [
      { id: 'blob', kind: 'blob', title: 'Build Blob', subtitle: '', searchText: 'Build Blob' },
      { id: 'one', kind: 'conversation', title: 'Build', subtitle: 'Build Blob', searchText: 'Build Build Blob', recentAt: '2026-10-03' },
      { id: 'settings', kind: 'action', title: 'Settings', subtitle: '', searchText: 'Settings' },
    ]
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus()
    await act(async () => root.render(<QuickSwitcher items={items} onChoose={opened} onClose={closed} />))
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    const input = host.querySelector('input')!
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    act(() => { valueSetter?.call(input, 'build'); input.dispatchEvent(new InputEvent('input', { bubbles: true })) })
    const expectedRow = host.querySelector<HTMLElement>('[data-result-id="one"]')!
    expectedRow.scrollIntoView = vi.fn()
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    const active = host.querySelector('[role="option"][aria-selected="true"]')
    expect(active?.getAttribute('data-result-id')).toBe('one')
    expect(input.getAttribute('aria-activedescendant')).toBe(active?.id)
    expect(expectedRow.scrollIntoView).toHaveBeenCalled()
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(opened).toHaveBeenCalledOnce()
    expect((opened.mock.calls[0]?.[0] as QuickSwitcherItem).id).toBe('one')
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(closed).toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
