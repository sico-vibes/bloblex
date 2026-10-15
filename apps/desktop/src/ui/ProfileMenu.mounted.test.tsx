// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  listeners: new Set<(event: { type: string; payload?: unknown }) => void>(),
}))

vi.mock('../tauri', () => ({
  rpc: h.rpc,
  listenForDaemonEvents: (handler: (event: { type: string; payload?: unknown }) => void) => { h.listeners.add(handler); return Promise.resolve(() => h.listeners.delete(handler)) },
}))

import { ProfileMenu } from './ProfileMenu'

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []

async function mount(onRemote?: () => void) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<ProfileMenu connection="connected" usageActive={false} onUsage={vi.fn()} onSchedules={vi.fn()} onRemote={onRemote} onSettings={vi.fn()} onQuit={vi.fn()} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  mounted.push({ root, host })
  return host
}

const menuItem = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === label)

beforeEach(() => {
  localStorage.clear()
  h.rpc.mockReset()
  h.rpc.mockImplementation(async () => ({}))
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() }
  h.listeners.clear()
})

describe('ProfileMenu row', () => {
  it('shows initials, the name and "On this device", and opens the menu', async () => {
    localStorage.setItem('bloblex.profile.name', 'Ada Lovelace')
    const host = await mount()
    expect(host.querySelector('.profile-avatar')?.textContent).toContain('AL')
    expect(host.querySelector('.profile-copy strong')?.textContent).toBe('Ada Lovelace')
    expect(host.querySelector('.profile-copy small')?.textContent).toBe('On this device')
    act(() => host.querySelector<HTMLButtonElement>('.profile-button')!.click())
    expect(host.querySelector('[role="menu"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Your name"]')).toBeNull()
  })

  it('shows "Set your name" and opens the name editor until a name is set', async () => {
    const host = await mount()
    expect(host.querySelector('.profile-copy small')?.textContent).toBe('Set your name')
    const button = host.querySelector<HTMLButtonElement>('.profile-button')!
    expect(button.getAttribute('aria-label')).toBe('Set your name')
    act(() => button.click())
    expect(host.querySelector('form[aria-label="Your name"]')).not.toBeNull()
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('ProfileMenu Remote entry', () => {
  it('offers Remote after Automations and opens Settings > Remote', async () => {
    localStorage.setItem('bloblex.profile.name', 'Ada')
    const onRemote = vi.fn()
    const host = await mount(onRemote)
    act(() => host.querySelector<HTMLButtonElement>('.profile-button')!.click())
    const remote = menuItem(host, 'Remote')
    expect(remote).toBeTruthy()
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(items.indexOf('Automations')).toBeGreaterThanOrEqual(0)
    expect(items.indexOf('Remote')).toBeGreaterThan(items.indexOf('Automations'))
    act(() => remote!.click())
    expect(onRemote).toHaveBeenCalledOnce()
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })

  it('hides the Remote entry when this build has no remote support', async () => {
    localStorage.setItem('bloblex.profile.name', 'Ada')
    h.rpc.mockImplementation(async (method: string) => { if (method === 'remote.status') throw new Error('unsupported'); return {} })
    const host = await mount(vi.fn())
    act(() => host.querySelector<HTMLButtonElement>('.profile-button')!.click())
    expect(menuItem(host, 'Remote')).toBeUndefined()
    expect(host.querySelector('[role="menu"]')?.textContent).toContain('Settings')
  })
})
