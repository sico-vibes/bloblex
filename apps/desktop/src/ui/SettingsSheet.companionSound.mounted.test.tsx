// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsSheet } from './SettingsSheet'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(), emit: vi.fn(), onError: vi.fn() }))
vi.mock('../tauri', () => ({
  inDesktop: true,
  previewMode: false,
  rpc: mocks.rpc,
  permissionsPolicyGet: vi.fn(async () => ({ defaultMode: 'ask', perAgent: [] })),
  companionMonitorOptions: vi.fn(async () => []),
  currentCompanionMonitor: vi.fn(async () => null),
  setCompanionMonitor: vi.fn(),
  setCompanionVisibility: vi.fn(),
  setCloseToTray: vi.fn(),
}))
vi.mock('../desktopIntegrations', () => ({ autostartEnabled: vi.fn(async () => false), setAutostartEnabled: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ emit: mocks.emit, listen: vi.fn(async () => () => undefined) }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.invoke.mockReset()
  mocks.emit.mockReset()
  mocks.onError.mockReset()
  mocks.emit.mockResolvedValue(undefined)
})
afterEach(() => { if (root) act(() => root.unmount()); host?.remove() })

async function openGeneral(settings: Record<string, unknown> = {}, failSave = false) {
  mocks.rpc.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'settings.get') return { settings }
    if (method === 'settings.set' && failSave && params?.key === 'companion.soundVolume') throw new Error('The daemon refused the volume.')
    return {}
  })
  mocks.invoke.mockImplementation(async () => true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="General" onClose={vi.fn()} onRefresh={vi.fn()} onError={mocks.onError} onOpenAgent={vi.fn()} />))
  await tick()
}

const slider = () => host.querySelector<HTMLInputElement>('input[aria-label="Companion sound volume"]')!
function drag(percent: number) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(slider(), String(percent)); slider().dispatchEvent(new Event('input', { bubbles: true })) })
}
const saves = () => mocks.rpc.mock.calls.filter(([method, params]) => method === 'settings.set' && params.key === 'companion.soundVolume')

describe('General settings: companion sound volume', () => {
  it('sits beside the Sounds switch and shows the saved volume, 80% when none is saved', async () => {
    await openGeneral()
    expect(host.querySelector('[role="switch"][aria-label="Companion sounds"]')).not.toBeNull()
    expect(slider().value).toBe('80')
    expect(host.textContent).toContain('80%')
    act(() => root.unmount()); host.remove()
    await openGeneral({ 'companion.soundVolume': 0.45 })
    expect(slider().value).toBe('45')
  })

  it('saves once on release under companion.soundVolume and tells the companion to play a preview', async () => {
    await openGeneral()
    act(() => { slider().dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    for (const percent of [70, 50, 25]) drag(percent)
    expect(saves()).toHaveLength(0)
    expect(mocks.emit).not.toHaveBeenCalledWith('bloblex-sound-volume-changed', expect.anything())
    await act(async () => { slider().dispatchEvent(new Event('pointerup', { bubbles: true })) })
    await tick()
    expect(saves()).toEqual([['settings.set', { key: 'companion.soundVolume', value: 0.25 }]])
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('bloblex-sound-volume-changed', { volume: 0.25, preview: true })
    expect(slider().value).toBe('25')
  })

  it('plays a sample at the current volume without saving again', async () => {
    await openGeneral({ 'companion.soundVolume': 0.45 })
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'Play sample')!
    expect(button).not.toBeNull()
    await act(async () => { button.click() })
    await tick()
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('bloblex-sound-volume-changed', { volume: 0.45, preview: true })
    expect(saves()).toHaveLength(0)
  })

  it('does not touch the sounds-enabled setting when the volume goes to 0', async () => {
    await openGeneral({ 'companion.soundsEnabled': true })
    drag(0)
    await act(async () => { slider().dispatchEvent(new KeyboardEvent('keyup', { key: 'Home', bubbles: true })) })
    await tick()
    expect(saves()).toEqual([['settings.set', { key: 'companion.soundVolume', value: 0 }]])
    expect(mocks.rpc.mock.calls.some(([method, params]) => method === 'settings.set' && params.key === 'companion.soundsEnabled')).toBe(false)
    expect(host.querySelector('[role="switch"][aria-label="Companion sounds"]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('puts the slider back and reports the failure when the daemon refuses the save', async () => {
    await openGeneral({ 'companion.soundVolume': 0.6 }, true)
    drag(15)
    await act(async () => { slider().dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true })) })
    await tick()
    expect(mocks.onError).toHaveBeenCalledWith('The daemon refused the volume.')
    expect(slider().value).toBe('60')
    expect(mocks.emit).not.toHaveBeenCalledWith('bloblex-sound-volume-changed', expect.anything())
  })
})
