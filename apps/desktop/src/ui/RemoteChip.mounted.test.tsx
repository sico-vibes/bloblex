// @vitest-environment happy-dom
// FIX23: the sidebar Remote chip. One button, four states, and nothing at all
// when this build has no remote support.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteStatus } from '../remote/remoteContract'

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  listeners: new Set<(event: { type: string; payload?: unknown }) => void>(),
  fail: { value: false },
}))

vi.mock('../tauri', () => ({
  rpc: h.rpc,
  listenForDaemonEvents: (handler: (event: { type: string; payload?: unknown }) => void) => { h.listeners.add(handler); return Promise.resolve(() => h.listeners.delete(handler)) },
}))

import { RemoteChip } from './RemoteChip'

function status(patch: Partial<RemoteStatus>): RemoteStatus {
  return {
    enabled: false, link: 'off', hostName: 'Work PC', relay: 'relay.bitbots.app', latencyMs: null, since: null,
    direct: false, directAddress: null, deviceCount: 0, connectedCount: 0, keepAwake: false, error: null, ...patch,
  }
}

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }

async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const onOpen = vi.fn()
  await act(async () => { root!.render(<RemoteChip onOpen={onOpen} />) })
  await flush()
  return { host, onOpen }
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  h.rpc.mockReset()
  h.rpc.mockImplementation(async () => status({}))
})
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null; h.listeners.clear() })

const chipText = () => host?.querySelector('.remote-chip-text')?.textContent ?? null

describe('RemoteChip', () => {
  it('renders nothing when this build has no remote support', async () => {
    h.rpc.mockImplementation(async () => { throw new Error('unsupported') })
    const view = await mount()
    expect(view.host.querySelector('.remote-chip')).toBeNull()
  })

  it('shows a hollow "Remote off" when Remote is not enabled', async () => {
    const view = await mount()
    const chip = view.host.querySelector('.remote-chip')!
    expect(chip).not.toBeNull()
    expect(chipText()).toBe('Remote off')
    expect(chip.getAttribute('data-tour')).toBe('remote')
    expect(chip.querySelector('.bot-status-waiting')).not.toBeNull()
  })

  it('shows "Remote on, 2 devices" with the working dot when online', async () => {
    h.rpc.mockImplementation(async () => status({ enabled: true, link: 'online', deviceCount: 2, connectedCount: 2 }))
    const view = await mount()
    expect(chipText()).toBe('Remote on, 2 devices')
    expect(view.host.querySelector('.bot-status-working')).not.toBeNull()
  })

  it('says "Remote on, no devices" when none are paired', async () => {
    h.rpc.mockImplementation(async () => status({ enabled: true, link: 'online', deviceCount: 0 }))
    await mount()
    expect(chipText()).toBe('Remote on, no devices')
  })

  it('says "Remote connecting" while the link is connecting or reconnecting', async () => {
    h.rpc.mockImplementation(async () => status({ enabled: true, link: 'connecting' }))
    await mount()
    expect(chipText()).toBe('Remote connecting')
    act(() => root?.unmount()); host?.remove()
    root = null; host = null
    h.rpc.mockImplementation(async () => status({ enabled: true, link: 'reconnecting' }))
    await mount()
    expect(chipText()).toBe('Remote connecting')
  })

  it('re-reads the status when a remote event arrives', async () => {
    const view = await mount()
    expect(chipText()).toBe('Remote off')
    h.rpc.mockImplementation(async () => status({ enabled: true, link: 'online', deviceCount: 3 }))
    act(() => { for (const listener of h.listeners) listener({ type: 'remote.changed' }) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)) })
    expect(chipText()).toBe('Remote on, 3 devices')
    act(() => view.host.querySelector<HTMLButtonElement>('.remote-chip')!.click())
    expect(view.onOpen).toHaveBeenCalledOnce()
  })
})
