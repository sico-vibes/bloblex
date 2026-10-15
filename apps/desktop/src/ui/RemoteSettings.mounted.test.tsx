// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemoteSimulator, type RemoteSimulator } from '../preview/remoteFixture'

let simulator: RemoteSimulator
const listeners = new Set<(event: { type: string; payload?: unknown }) => void>()
vi.mock('../tauri', () => ({
  rpc: (method: string, params: Record<string, unknown> = {}) => method === 'remote.preview.pair'
    ? Promise.resolve(simulator.simulatePairingCompleted())
    : simulator.call(method as never, params),
  listenForDaemonEvents: (handler: (event: { type: string; payload?: unknown }) => void) => { listeners.add(handler); return Promise.resolve(() => listeners.delete(handler)) },
  previewMode: true,
  inDesktop: true,
}))
import { RemoteSettings } from './RemoteSettings'

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async (ms = 80) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }

beforeEach(() => {
  simulator = createRemoteSimulator()
  simulator.reset({ enabled: false, devices: 0 })
  simulator.subscribe((event) => { for (const listener of listeners) listener(event) })
})
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null; simulator.dispose(); listeners.clear() })

async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<RemoteSettings />) })
  await flush()
  return host
}
const button = (view: HTMLElement, label: string) => [...view.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)

describe('RemoteSettings', () => {
  it('starts off, asks before turning on, then shows the host online', async () => {
    const view = await mount()
    const toggle = view.querySelector<HTMLButtonElement>('[aria-label="Allow remote devices"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(view.textContent).not.toContain('Show pairing code')
    await act(async () => { toggle.click() })
    expect(document.body.textContent).toContain('Turn on Remote?')
    await act(async () => { button(document.body, 'Turn on')!.click() })
    await flush(1000)
    expect(view.querySelector('.remote-status')?.textContent).toContain('Online as Work PC')
    expect(button(view, 'Show pairing code')).toBeTruthy()
  })

  it('pairs a device, lists it, and revoking removes it after confirmation', async () => {
    simulator.reset({ enabled: true, devices: 0 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)) })
    const view = await mount()
    await act(async () => { button(view, 'Show pairing code')!.click() })
    await flush()
    expect(view.querySelector('.remote-code')?.textContent).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    await act(async () => { button(view, 'Simulate a phone pairing')!.click() })
    await flush()
    expect(view.querySelector('.remote-paired')?.textContent).toContain('is connected')
    expect(view.querySelectorAll('.remote-device').length).toBe(1)
    const name = view.querySelector('.remote-device-copy strong')!.textContent!
    await act(async () => { button(view, `Remove ${name}`)!.click() })
    expect(document.body.textContent).toContain(`Remove ${name}?`)
    await act(async () => { document.querySelector<HTMLButtonElement>('.blob-dialog .primary-button, .blob-dialog .danger-confirm-button')!.click() })
    await flush()
    expect(view.querySelectorAll('.remote-device').length).toBe(0)
  })

  it('keeps approvals from remote off by default and downgrades operators when switched off', async () => {
    simulator.reset({ enabled: true, devices: 1 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)) })
    const view = await mount()
    const approvals = view.querySelector<HTMLButtonElement>('[aria-label="Approve requests from remote devices"]')!
    expect(approvals.getAttribute('aria-checked')).toBe('false')
    await act(async () => { approvals.click() })
    await flush()
    expect(view.querySelector<HTMLButtonElement>('[aria-label="Approve requests from remote devices"]')!.getAttribute('aria-checked')).toBe('true')
  })
})
