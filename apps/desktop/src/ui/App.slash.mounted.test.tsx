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
  stagePromptAttachment: vi.fn(),
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
    BlobCanvas: (props: Record<string, unknown>) => ReactModule.createElement('canvas', {
      className: 'blob-canvas', role: 'img',
      'aria-label': `${String(props.label ?? 'Agent')}, ${String(props.mood ?? 'idle')}`,
      width: typeof props.size === 'number' ? props.size : 52,
      height: typeof props.size === 'number' ? props.size : 52,
    }),
  }
})

import { App } from './App'
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
const claude = agent({ id: 'agent-claude', name: 'Claude', color: '#f38c6f', runtimeId: 'runtime-claude', sortOrder: 0 })
const claudeSession = session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Landing page copy' })
const manager = agent({ id: 'agent-manager', name: 'Manager', color: '#9be3c8', runtimeId: 'runtime-claude', sortOrder: 0, systemRole: 'manager' })
const managerSession = session({ id: 'session-manager', runtimeId: 'runtime-claude', agentId: 'agent-manager', title: 'Manager' })

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { sequence: 20, runtimes: [claudeRuntime], agents: [claude], sessions: [claudeSession], permissions: [], usage: [], usageSummary: { inputTokens: 100, outputTokens: 50 }, budgets: [], ...overrides }
}

async function settleMicrotasks() { for (let index = 0; index < 20; index++) await Promise.resolve() }

function mountApp() {
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
function startApp() { const view = mountApp(); mounted.push(view); return view }

function configure(snapshotValue = snapshot(), activeSession = 'session-claude') {
  h.fetchSnapshot.mockResolvedValue(snapshotValue)
  h.ensureDaemon.mockResolvedValue(undefined)
  h.startDaemonEventStream.mockResolvedValue(undefined)
  h.getActiveSession.mockResolvedValue(activeSession)
  h.getActiveRuntime.mockResolvedValue('runtime-claude')
  for (const key of ['setActiveSession', 'setActiveRuntime', 'setCompanionMode', 'setCompanionVisibility', 'setCompanionMonitor', 'refreshTrayMenu'] as const) h[key].mockResolvedValue(undefined)
  h.companionMonitorOptions.mockResolvedValue([])
  h.currentCompanionMonitor.mockResolvedValue(null)
  h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'events.replay') return { replayAvailable: true, events: [] }
    if (method === 'settings.get') return { settings: {} }
    if (method === 'skills.forAgent') return { skills: [{ name: 'code-review', description: 'Review a change for bugs.' }] }
    if (method === 'agent.get') return { agent: params.agentId === 'agent-manager' ? manager : claude }
    if (method === 'session.model.update') return { session: (params.sessionId === 'session-manager' ? managerSession : claudeSession) }
    return {}
  })
  const stop = vi.fn()
  for (const key of ['listenForDaemonEvents', 'listenForDaemonConnection', 'listenForActiveSession', 'listenForActiveRuntime', 'listenForOpenSettings', 'directListen'] as const) h[key].mockResolvedValue(stop)
  h.getCurrentWindow.mockReturnValue({ onDragDropEvent: vi.fn().mockResolvedValue(stop) })
}

beforeEach(() => {
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

function composer(view: ReturnType<typeof mountApp>) {
  const textarea = view.host.querySelector<HTMLTextAreaElement>('.composer-box textarea')
  if (!textarea) throw new Error('no composer textarea')
  return textarea
}
async function typeIn(view: ReturnType<typeof mountApp>, value: string) {
  const textarea = composer(view)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value)
    textarea.setSelectionRange(value.length, value.length)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await settleMicrotasks()
  })
}
async function pressKey(view: ReturnType<typeof mountApp>, key: string) {
  await act(async () => {
    composer(view).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await settleMicrotasks()
  })
}
const optionNames = (view: ReturnType<typeof mountApp>) => [...view.host.querySelectorAll('.slash-option')].map((node) => node.querySelector('strong')?.textContent)

describe('slash commands in the composer', () => {
  it('opens on /, filters as you type, and picking an action runs it without sending', async () => {
    const view = startApp()
    await view.settle()
    expect(view.host.querySelector('.slash-menu')).toBeNull()

    await typeIn(view, '/')
    expect(view.host.querySelector('.slash-menu')).not.toBeNull()
    expect(optionNames(view)).toContain('/plan')

    await typeIn(view, '/pl')
    expect(optionNames(view)).toEqual(['/plan'])

    await pressKey(view, 'Tab')
    expect(view.host.querySelector('.slash-menu')).toBeNull()
    const planCall = h.rpc.mock.calls.find(([method, params]) => method === 'session.model.update' && params.planMode === true)
    expect(planCall).toBeTruthy()
    expect(h.rpc).not.toHaveBeenCalledWith('session.prompt', expect.anything())
  })

  it('attaches a picked skill as a chip and sends the command with the message', async () => {
    const view = startApp()
    await view.settle()

    await typeIn(view, '/code-review')
    expect(optionNames(view)).toContain('/code-review')
    await pressKey(view, 'Tab')
    expect(view.host.querySelector('.slash-chip')?.textContent).toContain('/code-review')
    expect(composer(view).value).toBe('')

    await typeIn(view, 'check the parser')
    await pressKey(view, 'Enter')
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({
      sessionId: 'session-claude', text: '/code-review check the parser', command: { kind: 'skill', name: 'code-review' },
    }))
  })

  it('shows the Manager commands only for the Manager', async () => {
    const view = startApp()
    await view.settle()
    await typeIn(view, '/')
    expect(optionNames(view)).not.toContain('/interview')
    view.unmount()

    configure(snapshot({ agents: [manager], sessions: [managerSession] }), 'session-manager')
    const managerView = startApp()
    await managerView.settle()
    await typeIn(managerView, '/')
    expect(optionNames(managerView)).toContain('/interview')

    await typeIn(managerView, '/interview')
    await pressKey(managerView, 'Tab')
    expect(managerView.host.querySelector('.slash-chip')?.textContent).toContain('/interview')
  })
})
