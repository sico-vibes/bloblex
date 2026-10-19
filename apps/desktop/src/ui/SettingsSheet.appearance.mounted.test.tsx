// @vitest-environment happy-dom
import { act, useState } from 'react'
import type { Runtime } from '../types'
import { EMPTY_DISCOVERY_STATUS, useRuntimeDiscovery } from './runtimeDiscovery'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseOption, helpTipText, selectOptions, selectTrigger, selectValue } from './testSelect'
import { DEFAULT_EXPERIMENTS, EXPERIMENTS } from './experiments'
import { SettingsSheet } from './SettingsSheet'
import { setThemeStyle } from '../blob/bitbots'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(), setCompanionMonitor: vi.fn(), setCompanionVisibility: vi.fn(), setCloseToTray: vi.fn() }))
vi.mock('../tauri', () => ({
  inDesktop: true,
  previewMode: false,
  rpc: mocks.rpc,
  permissionsPolicyGet: vi.fn(async () => ({ defaultMode: 'ask', perAgent: [] })),
  companionMonitorOptions: vi.fn(async () => []),
  currentCompanionMonitor: vi.fn(async () => null),
  setCompanionMonitor: mocks.setCompanionMonitor,
  setCompanionVisibility: mocks.setCompanionVisibility,
  setCloseToTray: mocks.setCloseToTray,
  readWallpaper: vi.fn(async () => new Uint8Array()),
  selectWallpaperImage: vi.fn(async () => null),
  importWallpaper: vi.fn(async () => undefined),
  clearWallpaper: vi.fn(async () => undefined),
}))
vi.mock('../desktopIntegrations', () => ({ autostartEnabled: vi.fn(async () => false), setAutostartEnabled: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(async () => undefined), listen: vi.fn(async () => () => undefined) }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
let localCache = new Map<string, string>()
beforeEach(() => {
  localCache = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => localCache.get(key) ?? null,
    setItem: (key: string, value: string) => { localCache.set(key, String(value)) },
    removeItem: (key: string) => { localCache.delete(key) },
    clear: () => localCache.clear(),
  })
  mocks.rpc.mockReset()
  mocks.invoke.mockReset()
  mocks.setCompanionMonitor.mockReset()
  mocks.setCompanionVisibility.mockReset()
  mocks.setCloseToTray.mockReset()
})
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.unstubAllGlobals() })

describe('General settings mounted controls', () => {

  it('offers five looks, Bitbots-only options and font settings', async () => {
    mocks.invoke.mockResolvedValue(true)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: {} } : {})
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="Appearance" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect([...host.querySelectorAll('.appearance-primary-grid button strong,.appearance-more-grid button strong')].map((button) => button.textContent)).toEqual(['Bitbots','Blobots','Legacy','Pop','Dot'])
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.appearance-primary-grid button,.appearance-more-grid button')].find((button) => button.textContent?.includes('Pop'))?.click(); await Promise.resolve() })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'appearance.style', value: 'pop' })
    expect(host.textContent).toContain('This look has no extra options yet.')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.appearance-primary-grid button,.appearance-more-grid button')].find((button) => button.textContent?.includes('Bitbots'))?.click(); await Promise.resolve() })
    expect(host.textContent).toContain('Wallpaper')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.appearance-page .density-control button')].find((button) => button.textContent === 'Balanced')?.click(); await Promise.resolve() })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'appearance.glass', value: 'balanced' })
    const font = [...host.querySelectorAll<HTMLButtonElement>('.font-options button')].find((button) => button.textContent === 'Geist')
    await act(async () => { font?.click(); await Promise.resolve() })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'appearance.font', value: 'geist' })
    expect(localCache.get('bitbots.font')).toBe('geist')
    const codeSearch = host.querySelector<HTMLInputElement>('[aria-label="Search code fonts"]')!
    const codeChoices = codeSearch.parentElement!.querySelector('.font-options')!.textContent ?? ''
    expect(codeChoices).toContain('JetBrains Mono')
    expect(codeChoices).not.toContain('IBM Plex Sans')
  })

  it('loads and saves the busy-send preference in General', async () => {
    mocks.invoke.mockResolvedValue(false)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: { 'composer.busySendMode': 'queue' } } : {})
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="General" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    expect(selectValue(host, 'When you send while a bot is working')).toBe('queue')
    await chooseOption(host, 'When you send while a bot is working', 'steer')
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'composer.busySendMode', value: 'steer' })
  })

  it.each(EXPERIMENTS)('starts $label at its default and saves its exact setting key', async ({ name, label }) => {
    mocks.invoke.mockResolvedValue(true)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: {} } : {})
    const onExperimentChange = vi.fn()
    const initial = DEFAULT_EXPERIMENTS[name]
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="Experimental" onExperimentChange={onExperimentChange} onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const toggle = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
    expect(toggle.getAttribute('aria-checked')).toBe(String(initial))
    const row = toggle.closest('.settings-row')
    expect(row?.querySelector('.experimental-tag')?.textContent).toBe('Experimental')
    expect(helpTipText(row)?.length).toBeGreaterThan(20)
    await act(async () => { toggle.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: `experimental.${name}`, value: !initial })
    expect(onExperimentChange).toHaveBeenCalledWith(name, !initial)
  })

  it('offers the usage bar as an explained, experimental switch that saves and reports the change', async () => {
    mocks.invoke.mockResolvedValue(true)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: {} } : {})
    const onUsageBarChange = vi.fn()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="Experimental" usageBarEnabled={false} onUsageBarChange={onUsageBarChange} onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const group = [...host.querySelectorAll('.settings-group')].find((section) => section.querySelector('h3')?.textContent === 'Experimental')
    expect(group?.querySelector('.experimental-tag')?.textContent).toBe('Experimental')
    const usageBarRow = [...(group?.querySelectorAll('.settings-row') ?? [])].find((row) => row.querySelector('[aria-label="Usage bar"]'))
    expect(helpTipText(usageBarRow)).toContain('plan limits')
    const toggle = usageBarRow?.querySelector<HTMLButtonElement>('[aria-label="Usage bar"]')
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    await act(async () => { toggle!.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'experimental.usageBar', value: true })
    expect(onUsageBarChange).toHaveBeenCalledWith(true)
  })

  it('keeps Claude dynamic workflows off by default and stores the opt-in setting', async () => {
    mocks.invoke.mockResolvedValue(true)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: {} } : {})
    const changed = vi.fn()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="Experimental" claudeWorkflowsEnabled={false} onClaudeWorkflowsChange={changed} onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Claude dynamic workflows"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(helpTipText(toggle.closest('.settings-row'))).toContain('session-local')
    await act(async () => { toggle.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key:'claude.enableWorkflows', value:true })
    expect(changed).toHaveBeenCalledWith(true)
  })

  it('offers Usage tips as an independent experimental switch', async () => {
    mocks.invoke.mockResolvedValue(true)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: {} } : {})
    const onUsageTipsChange = vi.fn()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="Experimental" usageBarEnabled={false} usageTipsEnabled={false} onUsageTipsChange={onUsageTipsChange} onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Usage tips"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    const row = toggle.closest('.settings-row')!
    expect(helpTipText(row)).toContain('75%')
    await act(async () => { toggle.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'experimental.usageTips', value: true })
    expect(onUsageTipsChange).toHaveBeenCalledWith(true)
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Usage bar"]')?.getAttribute('aria-checked')).toBe('false')
  })

  it('moves the experimental toggles onto their own page and off General', async () => {
    mocks.invoke.mockResolvedValue(true)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: {} } : {})
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="Experimental" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    // The page has its own nav entry and lists the moved toggles.
    expect([...host.querySelectorAll('.settings-nav button')].map((button) => button.textContent)).toContain('Experimental')
    const group = [...host.querySelectorAll('.settings-group')].find((section) => section.querySelector('h3')?.textContent === 'Experimental')
    expect(group).toBeTruthy()
    expect(group?.querySelector('[aria-label="Usage bar"]')).toBeTruthy()
    expect(group?.querySelector<HTMLButtonElement>('[aria-label="Model and effort under the name"]')?.getAttribute('aria-checked')).toBe('false')
    // General no longer carries the group.
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="General" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect([...host.querySelectorAll('.settings-group')].some((section) => section.querySelector('h3')?.textContent === 'Experimental')).toBe(false)
    expect(host.querySelector('[aria-label="Usage bar"]')).toBeNull()
  })

  it('offers theme, text size, companion placement and hotkey controls, and persists appearance changes', async () => {
    mocks.invoke.mockResolvedValue(true)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: { 'appearance.theme': 'system', 'appearance.textSize': 'default' } } : {})
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="Appearance" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect([...host.querySelectorAll('.appearance-page .density-control button')].map((button) => button.textContent)).toContain('Light')
    expect(host.textContent).toContain('Interface font')
    expect(host.textContent).toContain('Code font')
    expect([...host.querySelectorAll('[role="radiogroup"][aria-label="Text size"] [role="radio"]')].map((button) => button.textContent)).toEqual(['Small','Default','Large','Larger'])
    expect([...host.querySelectorAll('[role="radiogroup"][aria-label="Density"] [role="radio"]')].map((button) => button.textContent)).toEqual(['Compact','Default','Roomy'])
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.appearance-page .density-control button')].find((button) => button.textContent === 'Light')?.click(); await Promise.resolve() })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'appearance.theme', value: 'light' })
    expect(document.documentElement.dataset.theme).toBe('light')
    // Companion placement and the hotkey stay on General.
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="General" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(selectTrigger(host, 'Companion start position')).not.toBeNull()
    expect(host.querySelector('[aria-label="Show/hide with Ctrl+Alt+B"]')).not.toBeNull()
  })

  it('offers the global "Bots working at once" limit and saves it', async () => {
    mocks.invoke.mockResolvedValue(true)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: { 'concurrency.botsAtOnce': 4 } } : {})
    setThemeStyle('bitbots')
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="General" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    // FIX39 item 18: this is the only concurrency limit, shown as a General setting.
    expect(selectValue(host, 'bots working at once')).toBe('4')
    const options = await selectOptions(host, 'bots working at once')
    expect(options.map((option) => option.value)).toEqual(Array.from({ length: 16 }, (_, index) => String(index + 1)))
    await chooseOption(host, 'bots working at once', '2')
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'concurrency.botsAtOnce', value: 2 })
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

  it('follows the look in its copy without a restart', async () => {
    mocks.invoke.mockResolvedValue(true)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: {} } : {})
    setThemeStyle('bitbots')
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="General" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(host.querySelector('[aria-label="Notify when a bot finishes or needs approval"]')).not.toBeNull()
    // The characters are bots in both looks.
    act(() => setThemeStyle('blobots'))
    expect(host.querySelector('[aria-label="Notify when a bot finishes or needs approval"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Notify when a blob finishes or needs approval"]')).toBeNull()
    act(() => setThemeStyle('bitbots'))
  })

  it('persists the companion launch preference and starts from the window visibility', async () => {
    mocks.invoke.mockResolvedValue(false)
    mocks.setCompanionVisibility.mockResolvedValue(undefined)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: { 'companion.openAtStartup': false } } : {})
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={null} initialPage="General" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const launchSwitch = host.querySelector<HTMLButtonElement>('[aria-label="Open the companion when Bitbots starts"]')
    expect(launchSwitch?.getAttribute('aria-checked')).toBe('false')
    await act(async () => launchSwitch?.click())
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'companion.openAtStartup', value: true })
    expect(launchSwitch?.getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('[aria-label="Show companion"]')?.getAttribute('aria-checked')).toBe('false')
  })
})


describe('Agents scan feedback', () => {
  it('disables Scan again, spins during discovery and updates rows and result on completion', async () => {
    let finish!: (value: { runtimes: Runtime[] }) => void
    const pending = new Promise<{ runtimes: Runtime[] }>((resolve) => { finish = resolve })
    mocks.invoke.mockResolvedValue(false)
    mocks.rpc.mockImplementation(async (method: string) => method === 'runtime.refresh' ? pending : method === 'settings.get' ? { settings: {} } : {})
    function Harness() {
      const [runtimes, setRuntimes] = useState<Runtime[]>([])
      const { status, scan } = useRuntimeDiscovery(setRuntimes)
      return <SettingsSheet snapshot={{ runtimes }} scanStatus={status} initialPage="Agents" onClose={vi.fn()} onRefresh={async () => { await scan() }} onError={vi.fn()} onOpenAgent={vi.fn()} />
    }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<Harness />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'Scan again')!
    await act(async () => button.click())
    expect(button.textContent).toBe('Scanning…')
    expect(button.disabled).toBe(true)
    expect(button.querySelector('.spinning')).not.toBeNull()
    act(() => button.click())
    expect(mocks.rpc.mock.calls.filter(([method]) => method === 'runtime.refresh')).toHaveLength(1)
    await act(async () => { finish({ runtimes: [{ id: 'codex', provider: 'codex', version: '1.2.3' }, { id: 'claude', provider: 'claude' }, { id: 'opencode', provider: 'opencode' }] }); await Promise.resolve() })
    expect(button.textContent).toBe('Scan again')
    expect(button.disabled).toBe(false)
    expect(host.querySelector('.settings-scan-status')?.textContent).toContain('Found 3 coding agents · just now')
    expect(host.querySelectorAll('.runtime-entry-head')).toHaveLength(3)
  })

  it('shows the last failed step, safe message and timestamp above the runtime rows', async () => {
    mocks.invoke.mockResolvedValue(false)
    mocks.rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: {} } : {})
    const at = Date.now() - 120_000
    const status = { ...EMPTY_DISCOVERY_STATUS, completedAt: at, failure: { step: 'Finding coding agents', message: 'Finding coding agents timed out.', at } }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root.render(<SettingsSheet snapshot={{ runtimes: [{ id: 'codex', provider: 'codex', probeStep: 'Protocol check', probeError: 'Probe timed out.' }] }} scanStatus={status} initialPage="Agents" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const line = host.querySelector('.settings-scan-status')!
    expect(line.textContent).toContain('Finding coding agents: Finding coding agents timed out.')
    expect(line.querySelector('time')?.getAttribute('datetime')).toBe(new Date(at).toISOString())
    expect(line.querySelector('time')?.textContent).toBe(new Date(at).toLocaleString())
    expect(host.querySelector('.runtime-entry-head .runtime-probe-error')?.textContent).toBe('Codex · Protocol check: Probe timed out.')
    await act(async () => { (host.querySelector('.runtime-entry-head') as HTMLButtonElement).click() })
    expect(host.querySelector('.runtime-recovery-guidance')?.textContent).toContain('Update or repair this CLI, then choose Scan again above.')
  })
})
