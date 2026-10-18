// @vitest-environment happy-dom
// FIX29 WP6d: the host hook against the Tailscale contract. The RPC transport is
// a stub here on purpose: what this proves is that the hook reads the wrapped
// `{devices}` / `{entries}` results, tracks the owner-confirmed pairing request
// and its outcome, and keeps an action's error message through the reload.
// State is read through `hook` after every update, because each render hands the
// probe a fresh hook object.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer, PairingRequest, RemoteDevice, RemoteStatus } from './remoteContract'
import { DEFAULT_REMOTE_SECURITY } from './remoteContract'

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  listeners: new Set<(event: { type: string; payload?: unknown }) => void>(),
}))

vi.mock('../tauri', () => ({
  rpc: h.rpc,
  listenForDaemonEvents: (handler: (event: { type: string; payload?: unknown }) => void) => {
    h.listeners.add(handler)
    return Promise.resolve(() => h.listeners.delete(handler))
  },
  previewMode: true,
  inDesktop: true,
}))

import { useRemote } from './useRemote'

type Hook = ReturnType<typeof useRemote>
let hook: Hook | null = null
let root: Root | null = null
let host: HTMLDivElement | null = null

function Probe() { hook = useRemote(); return null }

const flush = async (ms = 60) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }
const current = () => hook!.state
const fire = async (type: string, payload?: unknown) => {
  act(() => { for (const listener of h.listeners) listener({ type, payload }) })
  await flush()
}

function status(patch: Partial<RemoteStatus> = {}): RemoteStatus {
  return { enabled: true, link: 'online', url: 'https://work-pc.tail1234.ts.net', port: 48620, servePort: 443, tailscale: 'ready', hostName: 'Work PC', deviceCount: 0, connectedCount: 0, keepAwake: true, error: null, method: 'tailscale', native: { port: 48621, urls: [], fingerprint: null, accountSet: false, username: null, listening: false, loginPaused: false, pausedUntil: null, lastReachedAt: null, lastReachedFrom: null }, ...patch }
}

const device: RemoteDevice = { id: 'device-9', name: 'Pixel 8', kind: 'phone', tier: 'chat', platform: 'Android 15, Chrome', pairedAt: '2026-10-15T09:00:00.000Z', lastSeenAt: null, online: true }

async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<Probe />) })
  await flush(20)
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  hook = null
  h.rpc.mockReset()
  h.listeners.clear()
  h.rpc.mockImplementation(async (method: string) => {
    if (method === 'remote.status') return status()
    if (method === 'remote.devices.list') return { devices: [] }
    if (method === 'remote.security.get') return DEFAULT_REMOTE_SECURITY
    if (method === 'remote.activity.list') return { entries: [] }
    return {}
  })
})
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null })

describe('useRemote', () => {
  it('reads the wrapped devices and entries results, and a bare array too', async () => {
    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'remote.status') return status({ deviceCount: 1, connectedCount: 1 })
      if (method === 'remote.devices.list') return { devices: [device] }
      if (method === 'remote.security.get') return DEFAULT_REMOTE_SECURITY
      if (method === 'remote.activity.list') return { entries: [{ id: 'a1', at: '2026-10-15T09:00:00.000Z', deviceId: device.id, deviceName: device.name, kind: 'paired', summary: 'Pixel 8 paired' }] }
      return {}
    })
    await mount()
    expect(current().available).toBe(true)
    expect(current().status?.tailscale).toBe('ready')
    expect(current().devices.map((item) => item.id)).toEqual(['device-9'])
    expect(current().activity.map((entry) => entry.id)).toEqual(['a1'])

    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'remote.status') return status()
      if (method === 'remote.devices.list') return [device]
      if (method === 'remote.activity.list') return []
      return {}
    })
    await act(async () => { await hook!.reload() })
    expect(current().devices.map((item) => item.id)).toEqual(['device-9'])
    expect(current().activity).toEqual([])
  })

  it('tracks the owner-confirmed request and the outcome after the reload', async () => {
    await mount()
    const request: PairingRequest = { pairingId: 'pairing-1', name: 'Pixel 8', kind: 'phone', platform: 'Android 15, Chrome', login: 'owner@example.com', method: 'tailscale', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    await fire('remote.pairing.requested', request)
    expect(current().request).toEqual(request)

    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'remote.status') return status({ deviceCount: 1, connectedCount: 1 })
      if (method === 'remote.devices.list') return { devices: [device] }
      if (method === 'remote.activity.list') return { entries: [] }
      return {}
    })
    await fire('remote.pairing.completed', { pairingId: 'pairing-1', outcome: 'approved', deviceId: 'device-9' })
    expect(current().request).toBeNull()
    expect(current().lastOutcome?.outcome).toBe('approved')
    expect(current().lastOutcome?.device?.id).toBe('device-9')
    // `justPaired` is derived from the outcome for the current Settings page.
    expect(current().justPaired?.name).toBe('Pixel 8')
    act(() => hook!.dismissPaired())
    expect(current().justPaired).toBeNull()
  })

  it('drops a request whose code ran out on the next reload', async () => {
    await mount()
    // The event itself sets the request; the reload then drops it, because its
    // code has already run out.
    act(() => { for (const listener of h.listeners) listener({ type: 'remote.pairing.requested', payload: { pairingId: 'pairing-2', name: 'iPad Air', kind: 'tablet', platform: 'iPadOS 18, Safari', login: null, expiresAt: new Date(Date.now() - 1_000).toISOString() } }) })
    expect(current().request?.pairingId).toBe('pairing-2')
    await flush(80)
    expect(current().request).toBeNull()
  })

  it('approves and rejects through remote.pair.confirm', async () => {
    await mount()
    await act(async () => { await hook!.confirmPairing('pairing-1', 'operator') })
    expect(h.rpc).toHaveBeenCalledWith('remote.pair.confirm', { pairingId: 'pairing-1', approve: true, tier: 'operator' })
    await act(async () => { await hook!.rejectPairing('pairing-1') })
    expect(h.rpc).toHaveBeenCalledWith('remote.pair.confirm', { pairingId: 'pairing-1', approve: false })
  })

  it('keeps the message of a failed enable, which names the Tailscale fix', async () => {
    await mount()
    expect(current().error).toBeNull()
    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'remote.enable') throw new Error('unsupported: Tailscale is not installed. Install Tailscale on this computer and sign in, then turn Remote on again.')
      if (method === 'remote.status') return status({ enabled: false, link: 'off', url: null, servePort: null, tailscale: 'not_installed', keepAwake: false })
      if (method === 'remote.devices.list') return { devices: [] }
      if (method === 'remote.activity.list') return { entries: [] }
      return {}
    })
    await act(async () => { await hook!.enable() })
    expect(current().busy).toBe(false)
    expect(current().error).toMatch(/Tailscale is not installed/)
    // The reload that follows does not wipe it.
    await flush(60)
    expect(current().error).toMatch(/Tailscale is not installed/)
  })

  it('keeps the exact daemon message from a string rejection after reload', async () => {
    await mount()
    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'remote.enable') throw 'conflict: Another copy of Bitbots is already serving Remote on this computer.'
      if (method === 'remote.status') return status({ enabled: false, tailscale: 'port_in_use' })
      return {}
    })
    await act(async () => { await hook!.enable() })
    await flush()
    expect(current().error).toBe('Another copy of Bitbots is already serving Remote on this computer.')
    expect(current().status?.tailscale).toBe('port_in_use')
  })

  it('keeps the pairing offer until the phone locks it', async () => {
    await mount()
    const offer: PairingOffer = { code: 'K7QM-4XPD', url: 'https://work-pc.tail1234.ts.net', qrPayload: 'https://work-pc.tail1234.ts.net', expiresAt: new Date(Date.now() + 300_000).toISOString(), attemptsLeft: 5 }
    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'remote.pair.begin') return offer
      if (method === 'remote.status') return status()
      if (method === 'remote.devices.list') return { devices: [] }
      if (method === 'remote.activity.list') return { entries: [] }
      return {}
    })
    await act(async () => { await hook!.beginPairing() })
    expect(current().offer?.code).toBe('K7QM-4XPD')
    // The phone submitting the code locks the offer, so the live code is gone.
    await fire('remote.pairing.requested', { pairingId: 'pairing-3', name: 'Pixel 8', kind: 'phone', platform: 'Android 15, Chrome', login: null, expiresAt: offer.expiresAt })
    expect(current().offer).toBeNull()
    expect(current().request?.pairingId).toBe('pairing-3')
  })
})
