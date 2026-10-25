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
  it('defaults to on device, offers only On device and Cloud, and carries no engine explanations', async () => {
    await openSpeech()
    expect(selectValue(host, 'Transcription engine')).toBe('local')
    expect(host.textContent).not.toContain('Read from Codex')
    expect(host.textContent).not.toContain('Codex sign-in')
    expect(host.textContent).not.toContain('Withdraw')
    expect(host.textContent).not.toContain('ChatGPT when available')
    expect(dictationEnginePrefs()).toEqual({ engine: 'local', consent: false })
  })

  it('asks for permission before enabling the cloud engine and saves consent then engine', async () => {
    await openSpeech()
    await chooseOption(host, 'Transcription engine', 'automatic')
    await tick()
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Use cloud dictation?')
    expect(dialog.textContent).toContain('not stored or logged')
    expect(mocks.rpc).not.toHaveBeenCalledWith('settings.set', expect.objectContaining({ key: 'speech.engine' }))
    await act(async () => { ([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Allow cloud') as HTMLElement).click() })
    await tick()
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'speech.cloud.consent', value: true })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'speech.engine', value: 'automatic' })
    expect(dictationEnginePrefs()).toEqual({ engine: 'automatic', consent: true })
    // No sign-in status row and no separate permission row once it is on.
    expect(host.textContent).not.toContain('Signed in')
    expect(host.textContent).not.toContain('Withdraw')
  })

  it('keeps the on-device engine when the dialog is declined', async () => {
    await openSpeech()
    await chooseOption(host, 'Transcription engine', 'automatic')
    await tick()
    await act(async () => { ([...host.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === 'Keep on device') as HTMLElement).click() })
    await tick()
    expect(mocks.rpc).not.toHaveBeenCalledWith('settings.set', expect.objectContaining({ key: 'speech.cloud.consent' }))
    expect(dictationEnginePrefs()).toEqual({ engine: 'local', consent: false })
  })

  it('reads an older stored cloud choice as Cloud and switches back to On device without a permission row', async () => {
    await openSpeech({ 'speech.engine': 'cloud', 'speech.cloud.consent': true })
    expect(selectValue(host, 'Transcription engine')).toBe('automatic')
    expect(dictationEnginePrefs()).toEqual({ engine: 'automatic', consent: true })
    expect(host.textContent).not.toContain('Withdraw')
    await chooseOption(host, 'Transcription engine', 'local')
    await tick()
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'speech.engine', value: 'local' })
    expect(dictationEnginePrefs().engine).toBe('local')
  })
})

describe('Speech settings: the Whistle model', () => {
  const catalogue = [
    { id: 'parakeet-tdt-0.6b-v3-int8', label: 'Parakeet TDT v3', description: 'Highest accuracy.', language: 'multilingual', streaming: false, recommended: true, sizeBytes: 671_000_000 },
    { id: 'cactus-whistle-v1', label: 'Whistle', description: 'A very small model for seven languages: 17 MB plus a 1.5 MB engine.', language: 'multilingual', streaming: false, recommended: false, sizeBytes: 18_490_223 },
  ]

  async function openCatalogue(ready: Record<string, boolean>) {
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: {} } : {})
    mocks.invoke.mockImplementation(async (command: string, args?: { modelId?: string }) => {
      if (command === 'speech_cloud_status') return { authState: 'ready', authMode: 'chatgpt' }
      if (command === 'speech_models') return catalogue
      if (command === 'speech_model_status') return { ready: ready[args?.modelId ?? ''] === true }
      return { modelId: args?.modelId }
    })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="Speech" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await tick()
  }
  const row = (label: string) => [...host.querySelectorAll<HTMLElement>('.speech-model-row')].find((item) => item.textContent?.includes(label))!

  it('lists Whistle with its small size next to Parakeet, which stays the recommended default', async () => {
    await openCatalogue({ 'parakeet-tdt-0.6b-v3-int8': true })
    expect([...host.querySelectorAll('.speech-model-row .settings-row-title strong')].map((node) => node.textContent?.replace('Recommended', ''))).toEqual(['Parakeet TDT v3', 'Whistle'])
    expect(row('Parakeet').textContent).toContain('Recommended')
    expect(row('Whistle').textContent).toContain('18 MB')
    expect(row('Whistle').textContent).not.toContain('Recommended')
  })

  it('downloads Whistle through the same command as the other models, then offers it for use', async () => {
    await openCatalogue({ 'parakeet-tdt-0.6b-v3-int8': true })
    const download = [...row('Whistle').querySelectorAll('button')].find((button) => button.textContent?.includes('Download'))!
    await act(async () => { download.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    await tick()
    expect(mocks.invoke).toHaveBeenCalledWith('speech_model_download', { modelId: 'cactus-whistle-v1' })
    const use = [...row('Whistle').querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Use')!
    expect(use).toBeTruthy()
    await act(async () => { use.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'speech.model', value: 'cactus-whistle-v1' })
  })
})
