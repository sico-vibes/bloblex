// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rpc = vi.fn()
vi.mock('../tauri', () => ({
  rpc: (method: string, params: unknown) => rpc(method, params),
  listenForDaemonEvents: async () => () => undefined,
}))

const { PhoneAssignments } = await import('./RemoteApp')

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { if (root) act(() => root!.unmount()); root = null; host?.remove(); host = null; rpc.mockReset() })

const agents = [{ id: 'a1', name: 'Scout' }, { id: 'a2', name: 'Builder' }] as Agent[]
const row = (id: string, targetAgentId: string, status: string, extra: Record<string, unknown> = {}) => ({ id, originSessionId: 'm1', sideSessionId: `s-${id}`, targetAgentId, topic: `Topic ${id}`, status, createdAt: `2026-10-28T10:0${id.slice(1)}:00Z`, workspace: { path: 'repos/site', worktree: null }, ...extra })

async function mount(canStop: boolean) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<PhoneAssignments sessionId="m1" online agents={agents} canStop={canStop} />) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return host
}

// Wave 13: a phone catches up on what the Manager's teammates are doing and can stop open work.
describe('PhoneAssignments', () => {
  it('lists the assignments and stops an open one', async () => {
    rpc.mockImplementation(async (method: string) => method === 'delegation.list' ? { delegations: [row('d1', 'a1', 'completed', { silent: true }), row('d2', 'a2', 'running')] } : { delegation: null })
    const view = await mount(true)
    const items = [...view.querySelectorAll('.rm-assignments li')]
    expect(items.map((item) => item.textContent)).toEqual(['Scout · Topic d1Done, nothing to report', 'Builder · Topic d2WorkingStop'])
    await act(async () => { items[1]!.querySelector('button')!.click() })
    expect(rpc).toHaveBeenCalledWith('delegation.cancel', { delegationId: 'd2' })
  })

  it('offers no Stop to a view-only device, and shows nothing without assignments', async () => {
    rpc.mockResolvedValue({ delegations: [row('d2', 'a2', 'queued', { queueReason: 'busy' })] })
    const view = await mount(false)
    expect(view.querySelector('.rm-assignments li')?.textContent).toBe('Builder · Topic d2Queued · bot is busy')
    expect(view.querySelector('.rm-assignments button')).toBeNull()
    act(() => root!.unmount()); root = null; host?.remove(); host = null
    rpc.mockResolvedValue({ delegations: [] })
    expect((await mount(true)).querySelector('.rm-assignments')).toBeNull()
  })
})
