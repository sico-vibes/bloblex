// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseOption, selectValue } from './testSelect'
import { dictationEnginePrefs, setDictationEnginePrefs } from './dictation'
import { SettingsSheet } from './SettingsSheet'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn() }))
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
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(async () => undefined), listen: vi.fn(async () => () => undefined) }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.invoke.mockReset()
  setDictationEnginePrefs({ engine: 'local', consent: false })
})
afterEach(() => { if (root) act(() => root.unmount()); host?.remove() })

async function openSpeech(settings: Record<string, unknown> = {}, auth: Record<string, unknown> = { authState: 'ready', authMode: 'chatgpt' }) {
  mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings } : method === 'speech.models' ? { models: [] } : {})
  mocks.invoke.mockImplementation(async (command: string) => command === 'speech_cloud_status' ? auth : command === 'speech_models' ? [] : true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="Speech" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
  await tick()
}

describe('Speech settings: transcription engine', () => {
  it('defaults to on-device, never offers ChatGPT without asking, and says audio stays here', async () => {
    await openSpeech()
    expect(host.textContent).toContain('your audio stays here unless you choose ChatGPT below')
    expect(selectValue(host, 'Transcription engine')).toBe('local')
    expect(host.textContent).not.toContain('Read from Codex')
    expect(dictationEnginePrefs()).toEqual({ engine: 'local', consent: false })
  })

  it('asks for permission before enabling ChatGPT and saves consent then engine', async () => {
    await openSpeech()
    await chooseOption(host, 'Transcription engine', 'automatic')
    await tick()
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Send dictation to ChatGPT?')
    expect(dialog.textContent).toContain('not stored or logged')
    expect(mocks.rpc).not.toHaveBeenCalledWith('settings.set', expect.objectContaining({ key: 'speech.engine' }))
    await act(async () => { ([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Allow ChatGPT transcription') as HTMLElement).click() })
    await tick()
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'speech.cloud.consent', value: true })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'speech.engine', value: 'automatic' })
    expect(dictationEnginePrefs()).toEqual({ engine: 'automatic', consent: true })
    expect(host.textContent).toContain('Signed in')
  })

  it('keeps the on-device engine when the dialog is declined', async () => {
    await openSpeech()
    await chooseOption(host, 'Transcription engine', 'cloud')
    await tick()
    await act(async () => { ([...host.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === 'Keep on this device') as HTMLElement).click() })
    await tick()
    expect(mocks.rpc).not.toHaveBeenCalledWith('settings.set', expect.objectContaining({ key: 'speech.cloud.consent' }))
    expect(dictationEnginePrefs()).toEqual({ engine: 'local', consent: false })
  })

  it('shows the Codex sign-in problem plainly and lets the user withdraw permission', async () => {
    await openSpeech({ 'speech.engine': 'cloud', 'speech.cloud.consent': true }, { authState: 'missing' })
    expect(host.textContent).toContain('Not found. Run codex login in a terminal.')
    expect(dictationEnginePrefs()).toEqual({ engine: 'cloud', consent: true })
    const withdraw = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Withdraw')!
    await act(async () => { withdraw.click() })
    await tick()
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'speech.cloud.consent', value: false })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'speech.engine', value: 'local' })
    expect(dictationEnginePrefs()).toEqual({ engine: 'local', consent: false })
  })
})
