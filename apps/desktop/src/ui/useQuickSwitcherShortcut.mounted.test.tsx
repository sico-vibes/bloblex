// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useQuickSwitcherShortcut } from './useQuickSwitcherShortcut'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
function Harness({ enabled }: { enabled: boolean }) {
  const [opened, setOpened] = useState(0)
  useQuickSwitcherShortcut(enabled, () => setOpened((count) => count + 1))
  return <output>{opened}</output>
}
afterEach(() => { if (root) act(() => root.unmount()); host?.remove() })

describe('quick switcher keyboard shortcut', () => {
  it('opens with Ctrl+K and Meta+K, and stays disabled on other screens', () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => root.render(<Harness enabled />))
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })))
    expect(host.querySelector('output')?.textContent).toBe('1')
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', metaKey: true, bubbles: true, cancelable: true })))
    expect(host.querySelector('output')?.textContent).toBe('2')
    act(() => root.render(<Harness enabled={false} />))
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })))
    expect(host.querySelector('output')?.textContent).toBe('2')
  })
})
