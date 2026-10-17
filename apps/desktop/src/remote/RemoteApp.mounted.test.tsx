// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteDeviceApi } from './deviceApi'
import type { RemoteMe, RemotePairState } from './remoteTransport'

const agents = [
  { id: 'a1', name: 'Atlas', role: 'CTO', color: 'violet', runtimeId: 'rt' },
  { id: 'a2', name: 'Pixel', role: 'Designer', color: 'mint', runtimeId: 'rt' },
]
const sessions = [
  { id: 's1', agentId: 'a1', runtimeId: 'rt', state: 'waiting_permission', updatedAt: '2026-10-15T10:00:00Z', messages: [{ id: 'm1', role: 'user', content: 'Fix the parser' }, { id: 'm2', role: 'assistant', content: 'On it. **Found** the bug.' }] },
  { id: 's2', agentId: 'a2', runtimeId: 'rt', state: 'idle', updatedAt: '2026-10-15T09:00:00Z', messages: [] },
  // An older conversation with Pixel that arrives without its messages.
  { id: 's3', agentId: 'a2', runtimeId: 'rt', state: 'idle', title: 'Logo ideas', updatedAt: '2026-10-14T09:00:00Z' },
]
const permissions = [{ id: 'p1', sessionId: 's1', runtimeId: 'rt', status: 'pending', kind: 'command', title: 'Run npm test', choices: ['allow', 'deny'] }]
const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({
  rpc: h.rpc,
  fetchSnapshot: () => Promise.resolve({ agents, sessions, runtimes: [{ id: 'rt', provider: 'codex', status: 'ready' }], permissions }),
  listenForDaemonEvents: () => Promise.resolve(() => undefined),
  previewMode: false,
  inDesktop: false,
}))
vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: () => <span /> }))
import { RemoteApp } from './RemoteApp'

const refused = (code: string) => Object.assign(new Error(code), { code })
const meFor = (tier: RemoteMe['device']['tier'], extra: Partial<RemoteMe> = {}): RemoteMe => ({ protocolVersion: 1, device: { id: 'd1', name: 'Pixel 8', tier }, host: { name: 'Work PC' }, approvalsFromRemote: false, quietHoursActive: false, ...extra })

function fakeDevice(start: RemoteMe | 'unpaired' | 'revoked', pairStates: RemotePairState[] = ['pending', 'approved']) {
  let current = start
  const states = [...pairStates]
  const pairCalls: unknown[] = []
  const api = {
    pairCalls,
    me: vi.fn(async () => {
      if (current === 'unpaired') throw refused('unauthorized')
      if (current === 'revoked') throw refused('device_revoked')
      return current
    }),
    pair: vi.fn(async (input: unknown) => { pairCalls.push(input); return { state: 'pending' as const } }),
    pairStatus: vi.fn(async () => {
      // Nothing is waiting for the owner until this device submits a code.
      if (pairCalls.length === 0) return 'expired' as const
      const state = states.length > 1 ? states.shift()! : states[0] ?? 'expired'
      if (state === 'approved') current = meFor('chat')
      return state
    }),
    logout: vi.fn(async () => { current = 'unpaired' }),
    onConnection: (handler: (status: 'online') => void) => { handler('online'); return () => undefined },
  }
  return api
}

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async (ms = 60) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }

beforeEach(() => { h.rpc.mockReset(); h.rpc.mockResolvedValue({}) })
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null })

async function mount(device: ReturnType<typeof fakeDevice>) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<RemoteApp device={device as unknown as RemoteDeviceApi} pollMs={20} />) })
  await flush()
  return host
}
function type(view: HTMLElement, selector: string, value: string, index = 0) {
  const input = view.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(selector)[index]!
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('RemoteApp', () => {
  it('pairs: formats the code, waits for the owner, then lists the bots', async () => {
    const device = fakeDevice('unpaired', ['pending', 'pending', 'approved'])
    const view = await mount(device)
    expect(view.querySelector('.rm-ribbon')).toBeNull()
    const connect = view.querySelector<HTMLButtonElement>('.rm-primary')!
    expect(connect.disabled).toBe(true)
    type(view, '.rm-connect input', 'k7qm4xpd', 0)
    expect((view.querySelector('.rm-code') as HTMLInputElement).value).toBe('K7QM-4XPD')
    type(view, '.rm-connect input', 'Pixel 8', 1)
    await act(async () => { connect.click() })
    await flush()
    expect(device.pairCalls[0]).toMatchObject({ code: 'K7QM4XPD', name: 'Pixel 8' })
    expect(view.querySelector('.rm-waiting')?.textContent).toContain('Approve on your computer')
    await flush(200)
    expect(view.querySelector('.rm-host')?.textContent).toContain('Work PC')
    expect(view.querySelector('.rm-need')?.textContent).toContain('1 needs you')
    const rows = [...view.querySelectorAll('.rm-bot')]
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual(['Atlas', 'Pixel'])
    expect(rows[1]?.querySelector('small')?.textContent).toBe('Ready')
  })

  it('goes back to the code screen when the owner declines', async () => {
    const view = await mount(fakeDevice('unpaired', ['rejected']))
    type(view, '.rm-connect input', 'K7QM4XPD', 0)
    await act(async () => { view.querySelector<HTMLButtonElement>('.rm-primary')!.click() })
    await flush(120)
    expect(view.querySelector('.rm-notice')?.textContent).toContain('declined')
  })

  it('a removed device lands on the code screen with an explanation', async () => {
    const view = await mount(fakeDevice('revoked'))
    expect(view.querySelector('.rm-notice')?.textContent).toContain('removed on the computer')
  })

  it('view only: strips Markdown, disables sending and cannot approve', async () => {
    const view = await mount(fakeDevice(meFor('viewer')))
    await act(async () => { view.querySelectorAll<HTMLButtonElement>('.rm-bot')[0]!.click() })
    expect(view.querySelector('.rm-log')?.textContent).toContain('On it. Found the bug.')
    expect(view.querySelector('.rm-log')?.textContent).not.toContain('**')
    expect(view.querySelector<HTMLTextAreaElement>('.rm-composer textarea')?.disabled).toBe(true)
    expect(view.querySelector('.rm-approval.locked')?.textContent).toContain('can’t approve')
  })

  it('a refused send keeps the draft and says why', async () => {
    h.rpc.mockRejectedValue(refused('quiet_hours'))
    const view = await mount(fakeDevice(meFor('chat')))
    await act(async () => { view.querySelectorAll<HTMLButtonElement>('.rm-bot')[1]!.click() })
    type(view, '.rm-composer textarea', 'Ship it')
    await act(async () => { view.querySelector<HTMLButtonElement>('.rm-send')!.click() })
    await flush()
    expect(h.rpc).toHaveBeenCalledWith('session.prompt', { sessionId: 's2', text: 'Ship it' })
    expect(view.querySelector('.rm-send-problem')?.textContent).toContain('Quiet hours')
    expect(view.querySelector<HTMLTextAreaElement>('.rm-composer textarea')?.value).toBe('Ship it')
  })

  it('lists a bot\'s conversations and loads an older one when chosen', async () => {
    h.rpc.mockImplementation(async (method: string, params: { sessionId?: string }) => method === 'session.get' && params.sessionId === 's3'
      ? { id: 's3', agentId: 'a2', runtimeId: 'rt', title: 'Logo ideas', messages: [{ id: 'm9', role: 'assistant', content: 'Three logo sketches.' }] }
      : {})
    const view = await mount(fakeDevice(meFor('chat')))
    await act(async () => { view.querySelectorAll<HTMLButtonElement>('.rm-bot')[1]!.click() })
    await act(async () => { view.querySelector<HTMLButtonElement>('.rm-list-button')!.click() })
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.rm-convos button')]
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual(['New conversation', 'Logo ideas'])
    await act(async () => { rows[1]!.click() })
    await flush()
    expect(h.rpc).toHaveBeenCalledWith('session.get', { sessionId: 's3' })
    expect(view.querySelector('.rm-title small')?.textContent).toBe('Logo ideas')
    expect(view.querySelector('.rm-log')?.textContent).toContain('Three logo sketches.')
  })

  it('signs out from the device screen', async () => {
    const device = fakeDevice(meFor('operator', { approvalsFromRemote: true }))
    const view = await mount(device)
    await act(async () => { [...view.querySelectorAll<HTMLButtonElement>('.rm-tabs button')][1]!.click() })
    expect(view.querySelector('.rm-facts')?.textContent).toContain('Allowed')
    await act(async () => { view.querySelector<HTMLButtonElement>('.rm-danger')!.click() })
    await flush()
    expect(device.logout).toHaveBeenCalled()
    expect(view.querySelector('.rm-connect h1')?.textContent).toBe('Connect to your computer')
  })
})
