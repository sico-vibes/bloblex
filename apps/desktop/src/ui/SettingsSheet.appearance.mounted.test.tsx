// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseOption, selectOptions } from './testSelect'
import { SettingsSheet } from './SettingsSheet'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(), setCompanionMonitor: vi.fn(), setCompanionVisibility: vi.fn(), setCloseToTray: vi.fn() }))
vi.mock('../tauri', () => ({
  inDesktop: true,
  rpc: mocks.rpc,
  permissionsPolicyGet: vi.fn(async () => ({ defaultMode: 'ask', perAgent: [] })),
  companionMonitorOptions: vi.fn(async () => []),
  currentCompanionMonitor: vi.fn(async () => null),
  setCompanionMonitor: mocks.setCompanionMonitor,
  setCompanionVisibility: mocks.setCompanionVisibility,
  setCloseToTray: mocks.setCloseToTray,
}))
vi.mock('../desktopIntegrations', () => ({ autostartEnabled: vi.fn(async () => false), setAutostartEnabled: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(async () => undefined), listen: vi.fn(async () => () => undefined) }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
  })
  mocks.rpc.mockReset()
  mocks.invoke.mockReset()
  mocks.setCompanionMonitor.mockReset()
  mocks.setCompanionVisibility.mockReset()
  mocks.setCloseToTray.mockReset()
})
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.unstubAllGlobals() })

describe('General settings mounted controls', () => {
  it('offers theme, text size, companion placement and hotkey controls, and persists appearance changes', async () => {
    mocks.invoke.mockResolvedValue(true)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: { 'appearance.theme': 'system', 'appearance.textSize': 'default' } } : {})
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="General" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(await selectOptions(host, 'Theme')).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'system', label: 'Follow system' }),
      expect.objectContaining({ value: 'light', label: 'Light' }),
    ]))
    expect((await selectOptions(host, 'Text size')).map((item) => item.value)).toEqual(['small', 'default', 'large', 'larger'])
    expect(host.querySelector('[aria-label="Companion start position"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Show/hide with Ctrl+Alt+B"]')).not.toBeNull()
    await chooseOption(host, 'Theme', 'light')
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'appearance.theme', value: 'light' })
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('shows a startup hotkey conflict in the error banner and turns the switch off', async () => {
    mocks.invoke.mockResolvedValue(false)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: { 'companion.hotkey': true } } : {})
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="General" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Ctrl+Alt+B is used by another app. The companion shortcut is off.')
    expect(host.querySelector('[aria-label="Show/hide with Ctrl+Alt+B"]')?.getAttribute('aria-checked')).toBe('false')
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'companion.hotkey', value: false })
  })

  it('persists the companion launch preference and starts from the window visibility', async () => {
    mocks.invoke.mockResolvedValue(false)
    mocks.setCompanionVisibility.mockResolvedValue(undefined)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: { 'companion.openAtStartup': false } } : {})
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="General" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const launchSwitch = host.querySelector<HTMLButtonElement>('[aria-label="Open the companion when Bloblex starts"]')
    expect(launchSwitch?.getAttribute('aria-checked')).toBe('false')
    await act(async () => launchSwitch?.click())
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'companion.openAtStartup', value: true })
    expect(launchSwitch?.getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('[aria-label="Show companion"]')?.getAttribute('aria-checked')).toBe('false')
  })
})
