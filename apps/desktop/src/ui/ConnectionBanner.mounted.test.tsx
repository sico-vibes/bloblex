// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonSupervisor } from '../types'

const sup = vi.hoisted(() => ({ handler: null as null | ((state: DaemonSupervisor) => void), restart: vi.fn() }))
vi.mock('../tauri', () => ({
  daemonSupervisorState: async () => ({ state: 'running', attempt: 0, nextRetryMs: null, lastExitCode: null }),
  listenForDaemonSupervisor: async (handler: (state: DaemonSupervisor) => void) => { sup.handler = handler; return () => undefined },
  restartDaemonNow: () => sup.restart(),
}))
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

describe('ConnectionBanner and the daemon supervisor', () => {
  it('says the service stopped and is restarting, then that it keeps stopping, and tries again on request', async () => {
    sup.restart.mockResolvedValue({ state: 'running', attempt: 0, nextRetryMs: null, lastExitCode: null })
    const retry = vi.fn()
    const view = mount(<ConnectionBanner state="connected" onRetry={retry} />)
    await tick()
    expect(view.host.textContent).toBe('')
    act(() => sup.handler!({ state: 'restarting', attempt: 2, nextRetryMs: 2000, lastExitCode: 1 }))
    expect(view.host.querySelector('[data-state="reconnecting"]')?.textContent).toBe('The Bitbots service stopped. Restarting it… Attempt 2')
    act(() => sup.handler!({ state: 'gave_up', attempt: 5, nextRetryMs: null, lastExitCode: 1 }))
    const banner = view.host.querySelector('[data-state="failed"]')!
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('The Bitbots service keeps stopping')
    await act(async () => { banner.querySelector<HTMLButtonElement>('button')!.click(); await Promise.resolve() })
    expect(sup.restart).toHaveBeenCalledOnce()
    expect(retry).toHaveBeenCalledOnce()
  })
})
