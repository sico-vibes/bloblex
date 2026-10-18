// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Runtime } from '../types'
import { ManagerSetupCard } from './ManagerSetupCard'

const runtime: Runtime = { id: 'rt', provider: 'codex', status: 'online', protocolFamily: 'local' }
let root: Root
let host: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); sessionStorage.clear(); vi.unstubAllGlobals() })

function mount(runtimes: Runtime[] = [runtime]) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const onCreate = vi.fn(async () => ({ id: 'manager' }) as Agent)
  const render = (available: Runtime[]) => act(() => root.render(<ManagerSetupCard runtimes={available} disabled={false} onCreate={onCreate} />))
  render(runtimes)
  return { onCreate, render }
}

describe('persistent Manager setup', () => {
  it('ignores a previous Later preference and has no dismiss control', () => {
    sessionStorage.setItem('bitbots.managerSetup.later', '1')
    mount()
    expect(host.textContent).toContain('Meet your Manager')
    expect(host.querySelector('[aria-label="Later"], [aria-label="Close"]')).toBeNull()
  })

  it('stays visible without a runtime, disables creation, and recovers when discovery finishes', async () => {
    const { onCreate, render } = mount([])
    expect(host.textContent).toContain('Meet your Manager')
    expect(host.textContent).toContain('No coding agent is ready yet')
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
    render([runtime])
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
    render([])
    const create = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Create Manager')
    expect(create?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[aria-label^="Coding agent"]')?.disabled).toBe(true)
    expect(onCreate).not.toHaveBeenCalled()
    render([runtime])
    expect(host.textContent).not.toContain('No coding agent is ready yet')
    const ready = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Create Manager')!
    expect(ready.disabled).toBe(false)
    await act(async () => ready.click())
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Manager', runtimeId: 'rt', approvalMode: 'bypass' }))
  })
})
