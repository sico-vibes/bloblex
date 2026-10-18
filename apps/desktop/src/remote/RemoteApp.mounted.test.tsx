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
import { connectProblem, loginProblem, RemoteApp, signedOutMethod } from './RemoteApp'

const refused = (code: string, method?: string) => Object.assign(new Error(code), { code }, method ? { method } : {})
const meFor = (tier: RemoteMe['device']['tier'], extra: Partial<RemoteMe> = {}): RemoteMe => ({ protocolVersion: 1, device: { id: 'd1', name: 'Pixel 8', tier }, host: { name: 'Work PC' }, approvalsFromRemote: false, quietHoursActive: false, method: 'tailscale', ...extra })

function fakeDevice(start: RemoteMe | 'unpaired' | 'revoked', pairStates: RemotePairState[] = ['pending', 'approved'], method?: 'native') {
  let current = start
  const states = [...pairStates]
  const pairCalls: unknown[] = []
  const loginCalls: { password: string }[] = []
  const api = {
    pairCalls,
    loginCalls,
    me: vi.fn(async () => {
      if (current === 'unpaired') throw refused('unauthorized', method)
      if (current === 'revoked') throw refused('device_revoked', method)
      return current
    }),
    pair: vi.fn(async (input: unknown) => { pairCalls.push(input); return { state: 'pending' as const } }),
    login: vi.fn(async (input: { password: string }) => {
      if (input.password !== 'right-password') throw refused('login_invalid')
      loginCalls.push(input); pairCalls.push(input)
      return { state: 'pending' as const }
    }),
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

beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); vi.restoreAllMocks(); media(390, false); h.rpc.mockReset(); h.rpc.mockResolvedValue({}) })
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null })

async function mount(device: RemoteDeviceApi) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<RemoteApp device={device} pollMs={20} />) })
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
    const device = fakeDevice('unpaired', ['pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'approved'])
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
    const pairedBy = Date.now() + 3000
    while (!view.querySelector('.rm-host') && Date.now() < pairedBy) await flush(50)
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

  it('keeps waiting and never re-submits when the approval poll fails', async () => {
    const device = {
      me: vi.fn(async () => { throw refused('unauthorized') }),
      pair: vi.fn(async () => ({ state: 'pending' as const })),
      // The poll always fails (offline, forbidden origin, a blip): the phone
      // must sit on "Approve on your computer", not fall back or re-submit.
      pairStatus: vi.fn(async () => { throw refused('network') }),
      login: vi.fn(),
      logout: vi.fn(async () => undefined),
      onConnection: (handler: (status: 'online') => void) => { handler('online'); return () => undefined },
    }
    const view = await mount(device as unknown as RemoteDeviceApi)
    type(view, '.rm-connect input', 'K7QM4XPD', 0)
    await act(async () => { view.querySelector<HTMLButtonElement>('.rm-primary')!.click() })
    await flush()
    expect(device.pair).toHaveBeenCalledTimes(1)
    expect(view.querySelector('.rm-waiting')?.textContent).toContain('Approve on your computer')
    await flush(200)
    expect(device.pair).toHaveBeenCalledTimes(1)
    expect(view.querySelector('.rm-waiting')).not.toBeNull()
    expect(view.querySelector('.rm-connect h1')?.textContent).toBe('Approve on your computer')
  })

  it('reloads straight into the waiting screen without re-submitting the code', async () => {
    const device = {
      // A paired-but-pending device whose cookie the host has not handed over
      // yet: the reload finds the request still pending.
      me: vi.fn(async () => { throw refused('unauthorized') }),
      pair: vi.fn(async () => ({ state: 'pending' as const })),
      pairStatus: vi.fn(async () => 'pending' as const),
      login: vi.fn(),
      logout: vi.fn(async () => undefined),
      onConnection: (handler: (status: 'online') => void) => { handler('online'); return () => undefined },
    }
    const view = await mount(device as unknown as RemoteDeviceApi)
    expect(view.querySelector('.rm-waiting')?.textContent).toContain('Approve on your computer')
    expect(device.pair).not.toHaveBeenCalled()
    await flush(100)
    expect(device.pair).not.toHaveBeenCalled()
  })

  it('explains an origin refusal instead of asking for a new code', async () => {
    const device = {
      me: vi.fn(async () => { throw refused('forbidden_origin') }),
      pair: vi.fn(),
      pairStatus: vi.fn(async () => 'expired' as const),
      login: vi.fn(),
      logout: vi.fn(async () => undefined),
      onConnection: (handler: (status: 'online') => void) => { handler('online'); return () => undefined },
    }
    const view = await mount(device as unknown as RemoteDeviceApi)
    expect(view.querySelector('.rm-notice')?.textContent).toContain('opened from the address shown on the computer')
    expect(view.querySelector('.rm-connect h1')?.textContent).toBe('Connect to your computer')
  })

  it('words a refused sign-in, code or poll by the gateway code', () => {
    expect(connectProblem(refused('pairing_invalid'))).toBe('That code did not work. Check it, or show a new one on the computer.')
    expect(connectProblem(refused('forbidden_origin'))).toContain('opened from the address shown on the computer')
    expect(connectProblem(refused('rate_limited'))).toContain('Too many tries')
    expect(connectProblem(refused('network'))).toContain('Could not reach the computer')
    expect(connectProblem(new Error('The host said no.'))).toBe('The host said no.')
    expect(loginProblem(refused('forbidden_origin'))).toContain('opened from the address shown on the computer')
  })

  it('a removed device lands on the code screen with an explanation', async () => {
    const view = await mount(fakeDevice('revoked'))
    expect(view.querySelector('.rm-notice')?.textContent).toContain('removed on the computer')
  })

  it('Direct: signs in with a username and password, waits for approval, then lists the bots', async () => {
    const device = fakeDevice('unpaired', ['pending', 'pending', 'pending', 'pending', 'approved'], 'native')
    const view = await mount(device)
    expect(view.textContent).toContain('Sign in to your computer')
    expect(view.querySelector('.rm-code')).toBeNull()
    const submit = view.querySelector<HTMLButtonElement>('.rm-primary')!
    expect(submit.disabled).toBe(true)
    type(view, 'input[name="username"]', 'owner')
    type(view, 'input[name="password"]', 'wrong')
    await act(async () => { submit.click() })
    await flush()
    expect(view.querySelector('.rm-notice')?.textContent).toBe('That username or password is not right.')
    expect((view.querySelector('input[name="password"]') as HTMLInputElement).value).toBe('')
    type(view, 'input[name="password"]', 'right-password')
    type(view, '.rm-form input', 'Pixel 8', 2)
    await act(async () => { view.querySelector<HTMLButtonElement>('.rm-primary')!.click() })
    await flush()
    expect(device.loginCalls[0]).toMatchObject({ username: 'owner', name: 'Pixel 8' })
    expect(view.querySelector('.rm-waiting')?.textContent).toContain('Back to sign in')
    await flush(400)
    expect(view.querySelector('.rm-host')?.textContent).toContain('Work PC')
  })

  it('Direct: the password can be shown, and a removed device is asked to sign in again', async () => {
    const view = await mount(fakeDevice('revoked', ['expired'], 'native'))
    expect(view.querySelector('.rm-notice')?.textContent).toContain('Sign in again')
    const toggle = view.querySelector<HTMLButtonElement>('.rm-password button')!
    expect((view.querySelector('input[name="password"]') as HTMLInputElement).type).toBe('password')
    act(() => toggle.click())
    expect((view.querySelector('input[name="password"]') as HTMLInputElement).type).toBe('text')
    expect(toggle.getAttribute('aria-label')).toBe('Hide password')
  })

  it('chooses sign-in or pairing from the refusal, or else from the address', () => {
    expect(signedOutMethod(refused('unauthorized', 'native'), 'host.example.ts.net')).toBe('native')
    expect(signedOutMethod(refused('unauthorized', 'tailscale'), '203.0.113.7')).toBe('tailscale')
    expect(signedOutMethod(refused('unauthorized'), 'work-pc.tail1234.ts.net')).toBe('tailscale')
    expect(signedOutMethod(refused('unauthorized'), 'localhost')).toBe('tailscale')
    expect(signedOutMethod(refused('unauthorized'), '203.0.113.7')).toBe('native')
    expect(signedOutMethod(refused('unauthorized'), 'home.example.org')).toBe('native')
    expect(loginProblem(refused('rate_limited'))).toContain('paused')
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

function media(width: number, fine: boolean) {
  const queries = new Map<string, { matches: boolean; listeners: Set<() => void> }>()
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const entry = { matches: query.includes('min-width') ? width >= 900 : fine, listeners: new Set<() => void>() }
    queries.set(query, entry)
    return { get matches() { return entry.matches }, media: query, onchange: null,
      addEventListener: (_: string, listener: () => void) => entry.listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => entry.listeners.delete(listener),
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true } as unknown as MediaQueryList
  })
  return (query: string, matches: boolean) => act(() => {
    const entry = queries.get(query)!
    entry.matches = matches
    for (const listener of entry.listeners) listener()
  })
}

describe('Remote responsive layout', () => {
  it('shows the roster alongside chat on a wide fine-pointer screen and reacts to resizing', async () => {
    const change = media(1440, true)
    const view = await mount(fakeDevice(meFor('chat')))
    expect(view.querySelector('[data-layout="wide"]')).not.toBeNull()
    await act(async () => { view.querySelector<HTMLButtonElement>('.rm-bot')!.click() })
    expect(view.querySelector('.rm-bots')).not.toBeNull()
    expect(view.querySelector('.rm-chat')).not.toBeNull()
    expect(view.querySelector('.rm-tabs')).toBeNull()
    change('(min-width: 900px)', false)
    expect(view.querySelector('[data-layout="phone"]')).not.toBeNull()
    expect(view.querySelector('.rm-tabs')).not.toBeNull()
  })

  it('keeps a phone layout for coarse pointers and honours a stored override', async () => {
    media(1440, false)
    const view = await mount(fakeDevice(meFor('chat')))
    expect(view.querySelector('[data-layout="phone"]')).not.toBeNull()
  })

  it('lets This device switch layouts and saves the override', async () => {
    media(1440, true)
    localStorage.setItem('bitbots.remote.layout', 'phone')
    const view = await mount(fakeDevice(meFor('chat')))
    expect(view.querySelector('[data-layout="phone"]')).not.toBeNull()
    await act(async () => { [...view.querySelectorAll<HTMLButtonElement>('.rm-tabs button')].find((b) => b.textContent?.includes('This device'))!.click() })
    await act(async () => { view.querySelector<HTMLButtonElement>('.rm-layout-choice .select-trigger')!.click() })
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === 'Wide')!.click() })
    expect(view.querySelector('[data-layout="wide"]')).not.toBeNull()
    expect(localStorage.getItem('bitbots.remote.layout')).toBe('wide')
  })
})
