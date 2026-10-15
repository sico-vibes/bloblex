// @vitest-environment happy-dom
// FIX16 §4: a browser build hides the native-only surfaces. The test sets the
// browser capabilities, checks the Settings General page and the profile menu,
// then switches back to the preview capabilities to prove desktop and preview
// are unchanged.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_PLATFORM, PREVIEW_PLATFORM, setPlatform } from '../transport/platform'
import { SettingsSheet } from './SettingsSheet'
import { ProfileMenu } from './ProfileMenu'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({
  inDesktop: false,
  previewMode: false,
  rpc: mocks.rpc,
  permissionsPolicyGet: vi.fn(async () => ({ defaultMode: 'ask', perAgent: [] })),
  companionMonitorOptions: vi.fn(async () => []),
  currentCompanionMonitor: vi.fn(async () => null),
  setCompanionMonitor: vi.fn(async () => undefined),
  setCompanionVisibility: vi.fn(async () => undefined),
  setCloseToTray: vi.fn(async () => undefined),
}))
vi.mock('../desktopIntegrations', () => ({ autostartEnabled: vi.fn(async () => false), setAutostartEnabled: vi.fn(async () => undefined) }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const groupTitles = () => [...(host?.querySelectorAll('.settings-group h3') ?? [])].map((node) => node.textContent)

beforeEach(() => {
  const store = new Map<string, string>([['bloblex.profile.name', 'Ada']])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
  })
  mocks.rpc.mockReset()
  mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: {} } : {})
  setPlatform(BROWSER_PLATFORM)
})

afterEach(() => {
  if (root) act(() => root.unmount())
  host?.remove()
  setPlatform(PREVIEW_PLATFORM)
  vi.unstubAllGlobals()
})

describe('browser platform', () => {
  it('hides native-only settings rows and the Quit item, and restores them for preview', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<>
      <SettingsSheet snapshot={null} initialPage="General" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />
      <ProfileMenu connection="connected" usageActive={false} onUsage={vi.fn()} onSettings={vi.fn()} onQuit={vi.fn()} />
    </>))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    // The page itself still renders.
    expect(host.textContent).toContain('Run setup again')
    expect(host.textContent).toContain('Experimental')
    // Autostart, tray and companion rows are gone.
    expect(host.querySelector('[aria-label="Start with Windows"]')).toBeNull()
    expect(host.querySelector('[aria-label="Close to tray"]')).toBeNull()
    expect(host.querySelector('[aria-label="Companion monitor"]')).toBeNull()
    expect(host.querySelector('[aria-label="Show companion"]')).toBeNull()
    expect(host.querySelector('[aria-label="Open the companion when Bitbots starts"]')).toBeNull()
    expect(host.querySelector('[aria-label="Show/hide with Ctrl+Alt+B"]')).toBeNull()
    expect(host.querySelector('[aria-label="Companion start position"]')).toBeNull()
    // The editor group is gone.
    expect(host.querySelector('[aria-label="Editor executable"]')).toBeNull()
    expect(groupTitles()).not.toContain('Companion')
    expect(groupTitles()).not.toContain('Editor')

    // The profile menu holds no Quit.
    act(() => host.querySelector<HTMLButtonElement>('.profile-button')!.click())
    const menu = host.querySelector('[role="menu"]')!
    expect(menu.textContent).toContain('Settings')
    expect(menu.textContent).not.toContain('Quit')

    // Switching back to the preview capabilities restores every native surface.
    await act(async () => { setPlatform(PREVIEW_PLATFORM) })
    expect(host.querySelector('[aria-label="Start with Windows"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Editor executable"]')).not.toBeNull()
    expect(groupTitles()).toContain('Companion')
    expect(groupTitles()).toContain('Editor')
    expect(host.querySelector('[role="menu"]')!.textContent).toContain('Quit')
  })
})
