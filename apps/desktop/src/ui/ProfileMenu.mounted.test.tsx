// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../tauri', () => ({ rpc: vi.fn(async () => ({})) }))

import { ProfileMenu } from './ProfileMenu'

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []

function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<ProfileMenu connection="connected" usageActive={false} onUsage={vi.fn()} onSettings={vi.fn()} onQuit={vi.fn()} />))
  mounted.push({ root, host })
  return host
}

beforeEach(() => {
  localStorage.clear()
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() }
})

describe('ProfileMenu row', () => {
  it('shows initials, the name and "On this device", and opens the menu', () => {
    localStorage.setItem('bloblex.profile.name', 'Ada Lovelace')
    const host = mount()
    expect(host.querySelector('.profile-avatar')?.textContent).toContain('AL')
    expect(host.querySelector('.profile-copy strong')?.textContent).toBe('Ada Lovelace')
    expect(host.querySelector('.profile-copy small')?.textContent).toBe('On this device')
    act(() => host.querySelector<HTMLButtonElement>('.profile-button')!.click())
    expect(host.querySelector('[role="menu"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Your name"]')).toBeNull()
  })

  it('shows "Set your name" and opens the name editor until a name is set', () => {
    const host = mount()
    expect(host.querySelector('.profile-copy small')?.textContent).toBe('Set your name')
    const button = host.querySelector<HTMLButtonElement>('.profile-button')!
    expect(button.getAttribute('aria-label')).toBe('Set your name')
    act(() => button.click())
    expect(host.querySelector('form[aria-label="Your name"]')).not.toBeNull()
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })
})
