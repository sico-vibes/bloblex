// FIX20: companion keyboard access (C5), the offline/error banner (C6), and the
// short mood labels plus one shared sound setting (C11).
// @vitest-environment happy-dom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rpc: vi.fn(), fetchSnapshot: vi.fn(), ensureDaemon: vi.fn(), startDaemonEventStream: vi.fn(),
  getActiveSession: vi.fn(), getActiveRuntime: vi.fn(), setActiveSession: vi.fn(), setActiveRuntime: vi.fn(),
  setCompanionMode: vi.fn(), setCompanionVisibility: vi.fn(), showMainWindow: vi.fn(), showMainSettings: vi.fn(),
  companionMonitorOptions: vi.fn(), currentCompanionMonitor: vi.fn(), setCompanionMonitor: vi.fn(), refreshTrayMenu: vi.fn(),
  listenForDaemonEvents: vi.fn(), listenForDaemonConnection: vi.fn(), listenForActiveSession: vi.fn(),
  listenForActiveRuntime: vi.fn(), listenForOpenSettings: vi.fn(), directListen: vi.fn(), emit: vi.fn(),
  getCurrentWindow: vi.fn(), invoke: vi.fn(), selectLocalFile: vi.fn(), inspectLocalFile: vi.fn(),
}))

vi.mock('../desktopIntegrations', () => ({ autostartEnabled: async () => false, setAutostartEnabled: async () => undefined, sendDesktopNotification: async () => undefined, flashMainWindow: async () => undefined }))
vi.mock('../tauri', () => ({
  inDesktop: true,
  setApprovalBadge: async () => undefined,
  previewMode: false,
  rpc: h.rpc,
  permissionsPolicyGet: async () => ({ defaultMode: 'ask', perAgent: [] }),
  fetchSnapshot: h.fetchSnapshot,
  ensureDaemon: h.ensureDaemon,
  startDaemonEventStream: h.startDaemonEventStream,
  getActiveSession: h.getActiveSession,
  getActiveRuntime: h.getActiveRuntime,
  setActiveSession: h.setActiveSession,
  setActiveRuntime: h.setActiveRuntime,
  companionMonitorOptions: h.companionMonitorOptions,
  currentCompanionMonitor: h.currentCompanionMonitor,
  setCompanionMonitor: h.setCompanionMonitor,
  refreshTrayMenu: h.refreshTrayMenu,
  setCompanionMode: h.setCompanionMode,
  setCompanionVisibility: h.setCompanionVisibility,
  showMainWindow: h.showMainWindow,
  showMainSettings: h.showMainSettings,
  listenForDaemonEvents: h.listenForDaemonEvents,
  listenForDaemonConnection: h.listenForDaemonConnection,
  listenForActiveSession: h.listenForActiveSession,
  listenForActiveRuntime: h.listenForActiveRuntime,
  listenForOpenSettings: h.listenForOpenSettings,
  openProjectFolder: vi.fn(), selectLocalFile: h.selectLocalFile, inspectLocalFile: h.inspectLocalFile,
  openInEditor: vi.fn(), revealInExplorer: vi.fn(), resolveProjectFile: vi.fn(),
  quitBloblex: vi.fn(), setCloseToTray: vi.fn(),
  updatesGetState: async () => ({ currentVersion: '0.1.0', channel: 'beta' as const, autoCheck: true, lastCheckedAt: null, available: null, devBuild: false }),
  updatesSetPreferences: async () => ({ currentVersion: '0.1.0', channel: 'beta' as const, autoCheck: true, lastCheckedAt: null, available: null, devBuild: false }),
  updatesCheck: async () => ({ status: 'up_to_date' as const, checkedAt: '2026-10-02T00:00:00.000Z' }),
  updatesInstall: async () => undefined,
  listenForUpdateAvailable: async () => () => undefined,
  listenForUpdateProgress: async () => () => undefined,
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: h.directListen, emit: h.emit }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: h.getCurrentWindow }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke, isTauri: () => false }))
vi.mock('../blob/soundCues', () => ({
  playCompanionCue: vi.fn(), unlockCompanionAudioFromGesture: vi.fn(async () => true),
  setCompanionSoundsEnabled: vi.fn(), setCompanionSoundVolume: vi.fn(), disposeCompanionAudio: vi.fn(),
}))
vi.mock('../blob/BlobCanvas', async () => {
  const ReactModule = await import('react')
  return {
    BlobCanvas: (props: Record<string, unknown>) => ReactModule.createElement('canvas', {
      className: 'blob-canvas', role: 'img',
      'aria-label': `${String(props.label ?? 'Agent')}, ${String(props.mood ?? 'idle')}`,
      width: 40, height: 40,
    }),
  }
})

import { App } from './App'
import { setThemeStyle } from '../blob/bitbots'
import { SettingsSheet } from './SettingsSheet'
import { resetSoundPrefs } from './soundPrefs'
import type { Agent, Runtime, Session, Snapshot } from '../types'

const stamp = '2026-10-01T00:00:00.000Z'

function runtime(partial: Pick<Runtime, 'id' | 'provider'> & Partial<Runtime>): Runtime {
  return { status: 'online', protocolFamily: 'local', version: '1.0.0', ...partial }
}
function agent(partial: Pick<Agent, 'id' | 'name' | 'color' | 'runtimeId' | 'sortOrder'> & Partial<Agent>): Agent {
  return {
    description: '', instructions: '', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {},
    maxConcurrency: 1, defaultProject: null, archived: false, createdAt: stamp, updatedAt: stamp, ...partial,
  }
}
function session(partial: Pick<Session, 'id' | 'runtimeId'> & Partial<Session>): Session {
  return { title: '', projectPath: 'C:/work/site', state: 'idle', updatedAt: stamp, messages: [], ...partial }
}

const claudeRuntime = runtime({ id: 'runtime-claude', provider: 'claude' })
const codexRuntime = runtime({ id: 'runtime-codex', provider: 'codex' })
const claude = agent({ id: 'agent-claude', name: 'Claude', color: '#f38c6f', runtimeId: 'runtime-claude', sortOrder: 0 })
const codex = agent({ id: 'agent-codex', name: 'Codex', color: '#82aaff', runtimeId: 'runtime-codex', sortOrder: 0 })
const ops = agent({ id: 'agent-ops', name: 'Ops', color: '#7fd1a0', runtimeId: 'runtime-claude', sortOrder: 1 })
const claudeSession = session({
  id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Landing page copy', state: 'idle',
  messages: [{ id: 'm1', role: 'user', content: 'Hello from the test' }],
})

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    sequence: 20, runtimes: [claudeRuntime, codexRuntime], agents: [claude, codex], sessions: [claudeSession],
    permissions: [], usage: [], usageSummary: { inputTokens: 100, outputTokens: 50 }, budgets: [], ...overrides,
  }
}

async function settleMicrotasks() {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

function mountApp(search = '') {
  window.history.replaceState({}, '', `/${search}`)
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => root.render(<StrictMode><App /></StrictMode>))
  return {
    host,
    async settle() { await act(async () => { await settleMicrotasks(); await vi.advanceTimersByTimeAsync(40); await settleMicrotasks() }) },
    unmount() { act(() => root.unmount()); host.remove() },
  }
}

const mounted: Array<ReturnType<typeof mountApp>> = []
function startApp(search = '') {
  const view = mountApp(search)
  mounted.push(view)
  return view
}

function configure(snapshotValue = snapshot()) {
  h.fetchSnapshot.mockResolvedValue(snapshotValue)
  h.ensureDaemon.mockResolvedValue(undefined)
  h.startDaemonEventStream.mockResolvedValue(undefined)
  h.getActiveSession.mockResolvedValue('session-claude')
  h.getActiveRuntime.mockResolvedValue('runtime-claude')
  h.setActiveSession.mockResolvedValue(undefined)
  h.setActiveRuntime.mockResolvedValue(undefined)
  h.setCompanionMode.mockResolvedValue(undefined)
  h.setCompanionVisibility.mockResolvedValue(undefined)
  h.companionMonitorOptions.mockResolvedValue([])
  h.currentCompanionMonitor.mockResolvedValue(null)
  h.setCompanionMonitor.mockResolvedValue(undefined)
  h.refreshTrayMenu.mockResolvedValue(undefined)
  h.invoke.mockResolvedValue(true)
  h.emit.mockResolvedValue(undefined)
  h.selectLocalFile.mockResolvedValue(null)
  h.inspectLocalFile.mockResolvedValue({ path: 'C:/x/y.png', fileName: 'y.png', sizeBytes: 1 })
  h.rpc.mockImplementation(async (method: string) => {
    if (method === 'events.replay') return { replayAvailable: true, events: [] }
    if (method === 'settings.get') return { settings: {} }
    if (method === 'agent.get') return { agent: claude }
    return {}
  })
  const stop = vi.fn()
  h.listenForDaemonEvents.mockResolvedValue(stop)
  h.listenForDaemonConnection.mockResolvedValue(stop)
  h.listenForActiveSession.mockResolvedValue(stop)
  h.listenForActiveRuntime.mockResolvedValue(stop)
  h.listenForOpenSettings.mockResolvedValue(stop)
  h.directListen.mockResolvedValue(stop)
  h.getCurrentWindow.mockReturnValue({ onDragDropEvent: vi.fn().mockResolvedValue(stop) })
}

beforeEach(() => {
  // These cover the classic island (Bitbots and Blobots). Haze draws its own shell (App.hazeCompanion.mounted.test.tsx).
  setThemeStyle('bitbots')
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() })
  for (const mock of Object.values(h)) if (typeof mock === 'function' && 'mockReset' in mock) (mock as ReturnType<typeof vi.fn>).mockReset()
  resetSoundPrefs()
  configure()
})

afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

async function press(host: ParentNode, label: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label)
  if (!button) throw new Error(`missing button ${label}`)
  await act(async () => { button.click(); await settleMicrotasks() })
}

async function openHome(view: ReturnType<typeof startApp>) {
  await view.settle()
  await press(view.host, 'Open companion home')
  await view.settle()
}

// ── C5: focus and keyboard ────────────────────────────────────────────────
describe('C5 companion keyboard access', () => {
  it('makes the compact name area a real button that opens home', async () => {
    const view = startApp('?companion=1')
    await view.settle()
    const copy = view.host.querySelector<HTMLButtonElement>('.compact-copy')!
    expect(copy.tagName).toBe('BUTTON')
    expect(copy.getAttribute('type')).toBe('button')
    expect(copy.getAttribute('aria-label')).toBe('Open companion home')
    await press(view.host, 'Open companion home')
    await view.settle()
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('home')
  })

  it('gives every companion control the app focus ring, never a bare outline: none', () => {
    const css = readFileSync('src/ui/companion.css', 'utf8')
    for (const selector of ['.island-header .tab', '.peer', '.compact-bot', '.island-actions > button', '.companion-collapse', '.btn', '.team-picker-pin']) {
      const index = css.indexOf(`${selector}:focus-visible`)
      expect(index, `${selector} has a focus-visible rule`).toBeGreaterThanOrEqual(0)
      const open = css.indexOf('{', index)
      const close = css.indexOf('}', open)
      expect(css.slice(open + 1, close), `${selector} uses the app ring`).toContain('var(--focus-ring)')
    }
  })

  it('focuses the first four teammates with Ctrl+1..4 and the next waiting one with N', async () => {
    const opsSession = session({ id: 'session-ops', runtimeId: 'runtime-claude', agentId: 'agent-ops', title: 'Deploy', state: 'waiting_permission' })
    configure(snapshot({ agents: [claude, codex, ops], sessions: [claudeSession, opsSession] }))
    const view = startApp('?companion=1')
    await openHome(view)
    const peers = [...view.host.querySelectorAll<HTMLButtonElement>('.peer')]
    expect(peers).toHaveLength(2)
    expect(peers[0]?.getAttribute('aria-keyshortcuts')).toBe('Control+1 N')
    expect(peers[1]?.getAttribute('aria-keyshortcuts')).toBe('Control+2')

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(peers[1])
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(peers[0])

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(peers[0])

    // While the person is typing, the shortcut keys do nothing.
    const box = document.createElement('textarea')
    document.body.append(box)
    box.focus()
    act(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(box)
    box.remove()
  })
})

// ── C6: offline and error banner ──────────────────────────────────────────
describe('C6 offline banner and dismissible error', () => {
  it('shows the daemon banner and offers the main window Retry once a try has failed', async () => {
    h.ensureDaemon.mockRejectedValue(new Error('daemon down'))
    const view = startApp('?companion=1')
    await openHome(view)
    expect(view.host.querySelector('.connection-banner[data-state="reconnecting"]')).not.toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); await settleMicrotasks() })
    const failed = view.host.querySelector('.connection-banner[data-state="failed"]')
    expect(failed?.textContent).toContain('Bitbots could not be reached')
    const before = h.ensureDaemon.mock.calls.length
    const retry = [...(failed?.querySelectorAll('button') ?? [])].find((item) => item.textContent === 'Retry now')!
    await act(async () => { retry.click(); await settleMicrotasks() })
    expect(h.ensureDaemon.mock.calls.length).toBeGreaterThan(before)
  })

  it('confirms Back online when the daemon returns', async () => {
    let connectionHandler: ((connected: boolean) => void) | undefined
    h.listenForDaemonConnection.mockImplementation(async (handler: (connected: boolean) => void) => { connectionHandler = handler; return vi.fn() })
    const view = startApp('?companion=1')
    await openHome(view)
    expect(view.host.querySelector('.connection-banner')).toBeNull()

    await act(async () => { connectionHandler?.(false); await settleMicrotasks() })
    expect(view.host.querySelector('.connection-banner[data-state="reconnecting"]')).not.toBeNull()
    await act(async () => { connectionHandler?.(true); await settleMicrotasks() })
    expect(view.host.querySelector('.connection-banner[data-state="back-online"]')?.textContent).toContain('Back online')
  })

  it('dismisses the shared error line with the X or Escape and clears it after 8 seconds', async () => {
    h.selectLocalFile.mockRejectedValue(new Error('No local file to attach.'))
    const view = startApp('?companion=1')
    await openHome(view)
    await press(view.host, 'Chat')
    const attach = () => view.host.querySelector<HTMLButtonElement>('[aria-label="Choose a local file"]')!
    await act(async () => { attach().click(); await settleMicrotasks() })
    const line = view.host.querySelector('.companion-drop-error')
    expect(line?.textContent).toContain('No local file to attach.')
    expect(line?.querySelector('[aria-label="Dismiss error"]')).not.toBeNull()

    // The X clears it.
    await act(async () => { line?.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')?.click(); await settleMicrotasks() })
    expect(view.host.querySelector('.companion-drop-error')).toBeNull()

    // Escape on the focused line clears it too.
    await act(async () => { attach().click(); await settleMicrotasks() })
    const again = view.host.querySelector<HTMLElement>('.companion-drop-error')!
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => { again.focus(); again.dispatchEvent(escape) })
    expect(escape.defaultPrevented).toBe(true)
    expect(view.host.querySelector('.companion-drop-error')).toBeNull()

    // A non-blocking error clears itself after 8 seconds.
    await act(async () => { attach().click(); await settleMicrotasks() })
    expect(view.host.querySelector('.companion-drop-error')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); await settleMicrotasks() })
    expect(view.host.querySelector('.companion-drop-error')).toBeNull()
  })
})

// ── C11: mood labels and one sound source ─────────────────────────────────
describe('C11 mood labels and one sound source', () => {
  const compactStatus = (view: ReturnType<typeof startApp>) => view.host.querySelector('.compact-status')?.textContent

  it('shows the short mood label under the name for the four attention moods', async () => {
    configure(snapshot({ sessions: [{ ...claudeSession, state: 'sleeping' }] }))
    const sleeping = startApp('?companion=1'); await sleeping.settle()
    expect(compactStatus(sleeping)).toBe('Sleeping')

    configure(snapshot({ sessions: [{ ...claudeSession, state: 'rate_limited' }] }))
    const limited = startApp('?companion=1'); await limited.settle()
    expect(compactStatus(limited)).toBe('Rate limited')

    configure(snapshot({ sessions: [{ ...claudeSession, state: 'error' }] }))
    const failed = startApp('?companion=1'); await failed.settle()
    expect(compactStatus(failed)).toBe('Something failed')

    configure(snapshot())
    const offline = startApp('?companion=1&disconnected=1'); await offline.settle()
    expect(compactStatus(offline)).toBe('Offline')
  })

  it('keeps the companion switch and the main Settings sheet on one value', async () => {
    const sheetHost = document.createElement('div')
    document.body.append(sheetHost)
    const sheetRoot: Root = createRoot(sheetHost)
    await act(async () => { sheetRoot.render(<SettingsSheet snapshot={null} initialPage="General" onClose={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} onOpenAgent={vi.fn()} />) })
    await act(async () => { await settleMicrotasks() })

    const view = startApp('?companion=1')
    await openHome(view)
    await press(view.host, 'Settings')

    const sheetSwitch = () => sheetHost.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Companion sounds"]')!
    const companionSwitch = () => view.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Companion sounds"]')!
    expect(sheetSwitch().getAttribute('aria-checked')).toBe('false')
    expect(companionSwitch().getAttribute('aria-checked')).toBe('false')

    // Change it in the main Settings sheet: the companion follows at once.
    await act(async () => { sheetSwitch().click(); await settleMicrotasks() })
    expect(sheetSwitch().getAttribute('aria-checked')).toBe('true')
    expect(companionSwitch().getAttribute('aria-checked')).toBe('true')

    // Change it on the island: the Settings sheet follows too.
    await act(async () => { companionSwitch().click(); await settleMicrotasks() })
    expect(companionSwitch().getAttribute('aria-checked')).toBe('false')
    expect(sheetSwitch().getAttribute('aria-checked')).toBe('false')

    act(() => sheetRoot.unmount()); sheetHost.remove()
  })
})
