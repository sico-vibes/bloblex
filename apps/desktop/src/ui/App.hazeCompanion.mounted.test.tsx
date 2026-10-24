// @vitest-environment happy-dom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rpc: vi.fn(), fetchSnapshot: vi.fn(), ensureDaemon: vi.fn(), startDaemonEventStream: vi.fn(),
  getActiveSession: vi.fn(), getActiveRuntime: vi.fn(), setActiveSession: vi.fn(), setActiveRuntime: vi.fn(),
  setCompanionMode: vi.fn(), setCompanionVisibility: vi.fn(), showMainWindow: vi.fn(), showMainSettings: vi.fn(),
  companionMonitorOptions: vi.fn(), currentCompanionMonitor: vi.fn(), setCompanionMonitor: vi.fn(), refreshTrayMenu: vi.fn(),
  listenForDaemonEvents: vi.fn(), listenForDaemonConnection: vi.fn(), listenForActiveSession: vi.fn(),
  listenForActiveRuntime: vi.fn(), listenForOpenSettings: vi.fn(), directListen: vi.fn(), emit: vi.fn(),
  getCurrentWindow: vi.fn(),
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
  openProjectFolder: vi.fn(), selectLocalFile: vi.fn(), inspectLocalFile: vi.fn(),
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
vi.mock('../blob/soundCues', () => ({
  playCompanionCue: vi.fn(), unlockCompanionAudioFromGesture: vi.fn(),
  setCompanionSoundsEnabled: vi.fn(), setCompanionSoundVolume: vi.fn(), disposeCompanionAudio: vi.fn(),
}))
vi.mock('../blob/BlobCanvas', async () => {
  const ReactModule = await import('react')
  return {
    BlobCanvas: (props: Record<string, unknown>) => ReactModule.createElement(
      'canvas',
      {
        className: 'blob-canvas',
        role: 'img',
        'aria-label': `${String(props.label ?? 'Agent')}, ${String(props.mood ?? 'idle')}`,
        'data-shape': String((props.look as { shape?: string } | null | undefined)?.shape ?? 'mascot'),
        'data-seed': String((props.look as { seed?: string } | null | undefined)?.seed ?? ''),
        width: typeof props.size === 'number' ? props.size : 52,
        height: typeof props.size === 'number' ? props.size : 52,
      },
      props.greeting ? ReactModule.createElement('button', { type: 'button', 'aria-label': 'Complete greeting fixture', onClick: props.onGreetingComplete }, 'finish') : null,
    ),
  }
})

import { App } from './App'
import { setThemeStyle } from '../blob/bitbots'
import type { Agent, Runtime, Session, Snapshot } from '../types'

const stamp = '2026-10-01T00:00:00.000Z'
const DRAG = 'data-tauri-drag-region'
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [role="switch"], [role="link"]'

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
const claudeSession = session({
  id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Landing page copy', state: 'idle',
  messages: [{ id: 'm1', role: 'user', content: 'Hello from the test' }],
  tools: [{ id: 't1', title: 'npm test', state: 'done', command: 'npm test', sequence: 1 }],
})

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    sequence: 20,
    runtimes: [claudeRuntime, codexRuntime],
    agents: [claude, codex],
    sessions: [claudeSession],
    permissions: [],
    usage: [],
    usageSummary: { inputTokens: 100, outputTokens: 50 },
    budgets: [],
    ...overrides,
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
  let unmounted = false
  act(() => root.render(<StrictMode><App /></StrictMode>))
  return {
    host,
    async settle() { await act(async () => { await settleMicrotasks(); await vi.advanceTimersByTimeAsync(40); await settleMicrotasks() }) },
    unmount() { if (unmounted) return; unmounted = true; act(() => root.unmount()); host.remove() },
  }
}

let mounted: ReturnType<typeof mountApp>[] = []
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
  setThemeStyle('haze')
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() })
  for (const mock of Object.values(h)) if (typeof mock === 'function' && 'mockReset' in mock) (mock as ReturnType<typeof vi.fn>).mockReset()
  configure()
})

afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

function describeEl(el: Element) {
  const tag = el.tagName.toLowerCase()
  const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')
  const aria = el.getAttribute('aria-label')
  return `<${tag}${cls ? `.${cls}` : ''}${aria ? ` aria-label="${aria}"` : ''}>`
}

function pointerEventsNone(el: Element) {
  const style = (el as HTMLElement).style
  return !!style && style.pointerEvents === 'none'
}

/** Tauri drags only when the hit target itself is marked. pointer-events: none walks to the ancestor that receives the press. */
function resolvesToDrag(el: Element | null) {
  let current: Element | null = el
  while (current) {
    if (!pointerEventsNone(current)) return current.hasAttribute(DRAG)
    current = current.parentElement
  }
  return false
}

function expectsDrag(el: Element) {
  if (el.closest('[data-companion-no-drag]')) return false
  const control = el.closest(INTERACTIVE)
  if (!control) return true
  return el.classList.contains('blob-canvas') && control.classList.contains('compact-bot')
}

function assertIsland(host: ParentNode, label: string) {
  const capsule = host.querySelector('.companion-capsule')
  expect(capsule, label).not.toBeNull()
  const elements = [capsule!, ...capsule!.querySelectorAll('*')]
  for (const el of elements) {
    const name = `${label} ${describeEl(el)}`
    if (expectsDrag(el)) {
      if (pointerEventsNone(el)) expect(resolvesToDrag(el), name).toBe(true)
      else expect(el.hasAttribute(DRAG), name).toBe(true)
    } else {
      expect(el.hasAttribute(DRAG), name).toBe(false)
    }
  }
}

async function press(host: ParentNode, label: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label)
  if (!button) throw new Error(`missing button ${label}`)
  await act(async () => { button.click(); await settleMicrotasks() })
}

describe('Haze companion', () => {
  it('keeps the compact bar draggable and shows the focused bot by name', async () => {
    const view = startApp('?companion=1')
    await view.settle()
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('petit')
    expect(view.host.querySelector('.compact-copy strong')?.textContent).toBe('Claude')
    assertIsland(view.host, 'haze petit')
  })

  it('opens as a small copy of the main window: every bot on the left, the conversation on the right', async () => {
    const view = startApp('?companion=1')
    await view.settle()
    await press(view.host, 'Open companion home')
    await view.settle()
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('home')
    // The shell always uses the taller chat island, never the 160 px overview.
    expect(h.setCompanionMode).toHaveBeenLastCalledWith('home-chat', undefined, expect.any(Number))
    expect(view.host.querySelector('.island-header')).toBeNull()
    const rows = [...view.host.querySelectorAll<HTMLButtonElement>('.hc-bot')]
    expect(rows.map((row) => row.querySelector('.hc-bot-name')?.textContent)).toEqual(['Claude', 'Codex'])
    expect(rows[0]?.getAttribute('aria-current')).toBe('true')
    expect(view.host.querySelector('.hc-head .hc-title b')?.textContent).toBe('Claude')
    expect(view.host.querySelector('.hc-chat .chat-log')?.textContent).toContain('Hello from the test')
    expect(view.host.querySelector('.hc-chat textarea[aria-label="Message agent"]')).not.toBeNull()
    for (const row of rows) expect(row.hasAttribute(DRAG), 'bot row').toBe(false)
    assertIsland(view.host, 'haze home')
  })

  it('swaps the right pane for activity and settings, and collapses back to the bar', async () => {
    const view = startApp('?companion=1')
    await view.settle()
    await press(view.host, 'Open companion home')
    await view.settle()
    await press(view.host, 'Activity')
    await view.settle()
    expect(view.host.querySelector('.hc-activity')).not.toBeNull()
    expect(view.host.querySelector('.hc-chat')).toBeNull()
    await press(view.host, 'Settings')
    await view.settle()
    expect(view.host.querySelector('.hc-settings')?.textContent).toContain('Companion sounds')
    assertIsland(view.host, 'haze settings')
    await press(view.host, 'Collapse companion')
    await view.settle()
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('petit')
  })
})

