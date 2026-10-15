// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionBanner } from './ConnectionBanner'

let roots: Root[] = []
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { act(() => { for (const root of roots) root.unmount() }); roots = []; document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals() })
function mount(node: ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  act(() => root.render(node))
  return { host, render: (next: ReactNode) => act(() => root.render(next)) }
}
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe('ConnectionBanner', () => {
  it('shows reconnecting without a count on the first tries', () => {
    const view = mount(<ConnectionBanner state="connecting" attempts={1} onRetry={vi.fn()} />)
    const banner = view.host.querySelector('[data-state="reconnecting"]')!
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.getAttribute('aria-live')).toBe('polite')
    expect(banner.textContent).toContain('Reconnecting to Bitbots')
    expect(banner.textContent).not.toContain('Attempt')
    expect(view.host.querySelector('.spinning')).not.toBeNull()
  })

  it('adds the attempt count after the third try', () => {
    const view = mount(<ConnectionBanner state="disconnected" attempts={4} onRetry={vi.fn()} />)
    expect(view.host.querySelector('[data-state="reconnecting"]')!.textContent).toContain('Attempt 4')
  })

  it('offers Retry now once a try has failed', () => {
    const onRetry = vi.fn()
    const view = mount(<ConnectionBanner state="disconnected" attempts={3} failed onRetry={onRetry} />)
    const banner = view.host.querySelector('[data-state="failed"]')!
    expect(banner.textContent).toContain('Bitbots could not be reached')
    const button = [...banner.querySelectorAll('button')].find((item) => item.textContent === 'Retry now')!
    act(() => button.click())
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('confirms Back online for 1.5 seconds then disappears', async () => {
    const view = mount(<ConnectionBanner state="disconnected" attempts={1} onRetry={vi.fn()} />)
    view.render(<ConnectionBanner state="connected" attempts={0} onRetry={vi.fn()} />)
    expect(view.host.querySelector('[data-state="back-online"]')!.textContent).toContain('Back online')
    await tick(1499)
    expect(view.host.querySelector('[data-state="back-online"]')).not.toBeNull()
    await tick(1)
    expect(view.host.querySelector('.connection-banner')).toBeNull()
  })
})
