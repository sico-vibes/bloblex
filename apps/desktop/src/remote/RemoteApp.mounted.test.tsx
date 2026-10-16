// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemoteSimulator, type RemoteSimulator } from '../preview/remoteFixture'

let simulator: RemoteSimulator
const agents = [
  { id: 'a1', name: 'Atlas', role: 'CTO', color: 'violet', runtimeId: 'rt' },
  { id: 'a2', name: 'Pixel', role: 'Designer', color: 'mint', runtimeId: 'rt' },
]
const sessions = [
  { id: 's1', agentId: 'a1', runtimeId: 'rt', state: 'waiting_permission', updatedAt: '2026-10-15T10:00:00Z', messages: [{ id: 'm1', role: 'user', content: 'Fix the parser' }, { id: 'm2', role: 'assistant', content: 'On it. **Found** the bug.' }] },
  { id: 's2', agentId: 'a2', runtimeId: 'rt', state: 'idle', updatedAt: '2026-10-15T09:00:00Z', messages: [] },
]
vi.mock('../tauri', () => ({
  rpc: (method: string, params: Record<string, unknown> = {}) => simulator.call(method as never, params),
  fetchSnapshot: () => Promise.resolve({ agents, sessions, runtimes: [{ id: 'rt', provider: 'codex', status: 'ready' }], permissions: [] }),
  listenForDaemonEvents: () => Promise.resolve(() => undefined),
  previewMode: true,
  inDesktop: true,
}))
vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: () => <span /> }))
import { RemoteApp } from './RemoteApp'

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async (ms = 60) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }

beforeEach(() => {
  try { localStorage.clear() } catch { /* ignore */ }
  simulator = createRemoteSimulator()
  simulator.reset({ enabled: true, devices: 1 })
})
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null; simulator.dispose() })

async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<RemoteApp />) })
  await flush()
  return host
}
function type(view: HTMLElement, selector: string, value: string, index = 0) {
  const input = view.querySelectorAll<HTMLInputElement>(selector)[index]!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('RemoteApp', () => {
  it('formats the code, connects after a pause and lands on the bot list with the computer switcher', async () => {
    const view = await mount()
    expect(view.querySelector('.rm-ribbon')?.textContent).toContain('Preview')
    const connect = view.querySelector<HTMLButtonElement>('.rm-primary')!
    expect(connect.disabled).toBe(true)
    type(view, '.rm-connect input', 'k7qm4xpd', 0)
    expect((view.querySelector('.rm-code') as HTMLInputElement).value).toBe('K7QM-4XPD')
    type(view, '.rm-connect input', 'Pixel 8', 1)
    expect(connect.disabled).toBe(false)
    await act(async () => { connect.click(); await new Promise((resolve) => setTimeout(resolve, 1000)) })
    await flush(200)
    expect(view.querySelector('.rm-host')?.textContent).toContain('Work PC')
    expect(view.querySelector('.rm-need')?.textContent).toContain('1 needs you')
    const rows = [...view.querySelectorAll('.rm-bot')]
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual(['Atlas', 'Pixel'])
    // The role chip sits next to the name; the status line never repeats it.
    expect(rows[1]?.querySelector('.rm-role')?.textContent).toBe('Designer')
    expect(rows[1]?.querySelector('small')?.textContent).toBe('Ready')
  })

  it('shows an honest asleep screen for a sleeping computer and returns when switching back', async () => {
    localStorage.setItem('bitbots.remote.client', JSON.stringify({ paired: true, deviceName: 'Pixel 8', notifications: false }))
    const view = await mount()
    await act(async () => { view.querySelector<HTMLButtonElement>('.rm-host')!.click() })
    const sheet = document.querySelector('.rm-sheet')!
    expect(sheet.textContent).toContain('Home laptop')
    await act(async () => { [...sheet.querySelectorAll<HTMLButtonElement>('li button')].find((item) => item.textContent?.includes('Home laptop'))!.click() })
    await flush(120)
    expect(view.querySelector('.rm-away')?.textContent).toContain('Home laptop is asleep')
    expect(view.querySelector('.rm-bots')).toBeNull()
  })

  it('opens a chat, strips Markdown markers and disables sending when the device is view only', async () => {
    localStorage.setItem('bitbots.remote.client', JSON.stringify({ paired: true, deviceName: 'Pixel 8', notifications: false }))
    const view = await mount()
    await act(async () => { view.querySelectorAll<HTMLButtonElement>('.rm-bot')[0]!.click() })
    expect(view.querySelector('.rm-log')?.textContent).toContain('On it. Found the bug.')
    expect(view.querySelector('.rm-log')?.textContent).not.toContain('**')
    // The simulated host grants the Chat tier, so the composer is live.
    expect(view.querySelector<HTMLTextAreaElement>('.rm-composer textarea')?.disabled).toBe(false)
    expect(view.querySelector('.rm-tier')?.textContent).toContain('Chat')
  })
})
