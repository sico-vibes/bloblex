// @vitest-environment happy-dom
// FIX37 G3: after a delete or archive the selection must settle once, never bounce.
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  approvalBadge: vi.fn(), rpc: vi.fn(), fetchSnapshot: vi.fn(), ensureDaemon: vi.fn(), startDaemonEventStream: vi.fn(),
  getActiveSession: vi.fn(), getActiveRuntime: vi.fn(), setActiveSession: vi.fn(), setActiveRuntime: vi.fn(),
  setCompanionMode: vi.fn(), setCompanionVisibility: vi.fn(), showMainWindow: vi.fn(), showMainSettings: vi.fn(),
  companionMonitorOptions: vi.fn(), currentCompanionMonitor: vi.fn(), setCompanionMonitor: vi.fn(), refreshTrayMenu: vi.fn(),
  listenForDaemonEvents: vi.fn(), listenForDaemonConnection: vi.fn(), listenForActiveSession: vi.fn(),
  listenForActiveRuntime: vi.fn(), listenForOpenSettings: vi.fn(), directListen: vi.fn(), emit: vi.fn(),
  getCurrentWindow: vi.fn(),
  daemonEventHandlers: [] as Array<(event: any) => void>,
}))

vi.mock('../desktopIntegrations', () => ({ autostartEnabled: async () => false, setAutostartEnabled: async () => undefined, sendDesktopNotification: async () => undefined, flashMainWindow: async () => undefined }))
vi.mock('../tauri', () => ({
  inDesktop: true,
  listenForTerminalOutput: async () => () => undefined,
  listenForTerminalExit: async () => () => undefined,
  setApprovalBadge: async (count: number) => { h.approvalBadge(count) },
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
  openProjectFolder: vi.fn(), stagePromptAttachment: vi.fn(),
  selectLocalFile: vi.fn(), inspectLocalFile: vi.fn(),
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
    BlobCanvas: (props: Record<string, any>) => ReactModule.createElement('span', {
      'data-testid': 'blob-canvas', 'data-color': props.color, 'data-label': props.label,
      'aria-label': props.decorative ? undefined : `${String(props.label ?? 'Agent')}, ${String(props.mood ?? 'idle')}`,
    }, props.greeting ? ReactModule.createElement('button', { type: 'button', 'aria-label': 'Complete greeting fixture', onClick: props.onGreetingComplete }, 'finish') : null),
  }
})

import { App } from './App'
import { setBitbotsEnabled } from '../blob/bitbots'
import type { Agent, DaemonEvent, Runtime, Session, Snapshot } from '../types'

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
const invoice = agent({ id: 'agent-invoice', name: 'Invoice helper', color: 'lemon', runtimeId: 'runtime-codex', sortOrder: 1 })

const baseSessions = () => [
  session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude chat', updatedAt: '2026-10-02T01:00:00.000Z', messages: [{ id: 'c1', role: 'user', content: 'hi' }] }),
  session({ id: 'session-codex', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Codex chat', updatedAt: '2026-10-02T02:00:00.000Z', messages: [{ id: 'x1', role: 'user', content: 'hi' }] }),
  session({ id: 'session-invoice', runtimeId: 'runtime-codex', agentId: 'agent-invoice', title: 'Invoice chat', updatedAt: '2026-10-02T03:00:00.000Z', messages: [{ id: 'i1', role: 'user', content: 'hi' }] }),
]

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    sequence: 20,
    runtimes: [claudeRuntime, codexRuntime],
    agents: [claude, codex, invoice],
    sessions: baseSessions(),
    permissions: [],
    usage: [],
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
  h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'events.replay') return { replayAvailable: true, events: [] }
    if (method === 'settings.get') return { settings: {} }
    if (method === 'session.get') {
      const id = String(params.sessionId)
      return baseSessions().find((item) => item.id === id) ?? session({ id, runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Restored chat', messages: [{ id: 'r1', role: 'user', content: 'hi' }] })
    }
    if (method === 'agent.conversation' || method === 'agent.conversation.create' || method === 'session.new') {
      return { session: session({ id: 'session-auto', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'New chat', updatedAt: '2026-10-02T05:00:00.000Z', messages: [] }) }
    }
    return {}
  })
  const stop = vi.fn()
  h.listenForDaemonEvents.mockImplementation(async (handler: (event: any) => void) => { h.daemonEventHandlers.push(handler); return () => { h.daemonEventHandlers = h.daemonEventHandlers.filter((item) => item !== handler); stop() } })
  h.listenForDaemonConnection.mockResolvedValue(stop)
  h.listenForActiveSession.mockResolvedValue(stop)
  h.listenForActiveRuntime.mockResolvedValue(stop)
  h.listenForOpenSettings.mockResolvedValue(stop)
  h.directListen.mockResolvedValue(stop)
  h.getCurrentWindow.mockReturnValue({ onDragDropEvent: vi.fn().mockResolvedValue(stop) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() })
  h.daemonEventHandlers = []
  for (const mock of Object.values(h)) if (typeof mock === 'function' && 'mockReset' in mock) (mock as ReturnType<typeof vi.fn>).mockReset()
  setBitbotsEnabled(false)
  configure()
})

afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

function emit(event: DaemonEvent) {
  // Every live listener hears the event, as with the real event bus: App is not the only one.
  const handlers = [...h.daemonEventHandlers]
  if (!handlers.length) throw new Error('no daemon listener')
  for (const handler of handlers) handler(event)
}

const selectedBot = (host: ParentNode) => host.querySelector('.bot-row[aria-current="true"] strong')?.textContent ?? null
const unreadDots = (host: ParentNode) => host.querySelectorAll('.unread-dot').length

async function activeSessionHandlers() {
  const handlers: Array<(sessionId: string | null) => void> = []
  h.listenForActiveSession.mockImplementation(async (handler: (sessionId: string | null) => void) => { handlers.push(handler); return vi.fn() })
  return handlers
}

describe('FIX37 G3 selection after delete or archive', () => {
  it('deleting the selected conversation picks the next bot once and stays there', async () => {
    const view = startApp()
    await view.settle()
    expect(selectedBot(view.host)).toBe('Claude')

    await act(async () => { emit({ type: 'session.deleted', sequence: 21, payload: { sessionId: 'session-claude' } }); await settleMicrotasks() })
    await view.settle()
    const first = selectedBot(view.host)
    for (let index = 0; index < 3; index += 1) {
      await view.settle()
      expect(selectedBot(view.host), `settle ${index}`).toBe(first)
    }
    expect(first).toBe('Codex')
    expect(h.rpc.mock.calls.some(([method]) => method === 'agent.conversation')).toBe(false)
    expect(h.setActiveSession.mock.calls.map(([id]) => id)).not.toContain('session-claude')
  })

  it('archiving the selected bot picks one other bot once and stays there', async () => {
    const view = startApp()
    await view.settle()
    await act(async () => { emit({ type: 'agent.changed', sequence: 21, payload: { agentId: 'agent-claude', runtimeId: 'runtime-claude', updatedAt: stamp, archived: true, sortOrder: 0 } }); await settleMicrotasks() })
    await view.settle()
    const first = selectedBot(view.host)
    for (let index = 0; index < 3; index += 1) {
      await view.settle()
      expect(selectedBot(view.host), `settle ${index}`).toBe(first)
    }
    expect(first).toBe('Codex')
  })

  it('ignores an active-session event naming a deleted session', async () => {
    const handlers = await activeSessionHandlers()
    const view = startApp()
    await view.settle()
    await act(async () => { emit({ type: 'session.deleted', sequence: 21, payload: { sessionId: 'session-claude' } }); await settleMicrotasks() })
    await view.settle()
    expect(selectedBot(view.host)).toBe('Codex')
    h.setActiveSession.mockClear()

    await act(async () => { for (const handler of handlers) handler('session-claude'); await settleMicrotasks() })
    await view.settle()
    expect(selectedBot(view.host)).toBe('Codex')
    expect(h.setActiveSession.mock.calls.map(([id]) => id)).not.toContain('session-claude')
  })

  it('ignores an active-session event naming a conversation of an archived bot', async () => {
    const handlers = await activeSessionHandlers()
    const view = startApp()
    await view.settle()
    await act(async () => { emit({ type: 'agent.changed', sequence: 21, payload: { agentId: 'agent-claude', runtimeId: 'runtime-claude', updatedAt: stamp, archived: true, sortOrder: 0 } }); await settleMicrotasks() })
    await view.settle()
    expect(selectedBot(view.host)).toBe('Codex')
    h.setActiveSession.mockClear()

    await act(async () => { for (const handler of handlers) handler('session-claude'); await settleMicrotasks() })
    await view.settle()
    expect(selectedBot(view.host)).toBe('Codex')
    expect(h.setActiveSession.mock.calls.map(([id]) => id)).not.toContain('session-claude')
  })

  it('does not gain an unread dot from deleting a conversation', async () => {
    const view = startApp()
    await view.settle()
    expect(unreadDots(view.host)).toBe(0)
    await act(async () => { emit({ type: 'session.deleted', sequence: 21, payload: { sessionId: 'session-claude' } }); await settleMicrotasks() })
    await view.settle()
    await view.settle()
    expect(unreadDots(view.host)).toBe(0)
  })

  it('does not gain an unread dot from archiving a bot', async () => {
    const view = startApp()
    await view.settle()
    expect(unreadDots(view.host)).toBe(0)
    await act(async () => { emit({ type: 'agent.changed', sequence: 21, payload: { agentId: 'agent-claude', runtimeId: 'runtime-claude', updatedAt: stamp, archived: true, sortOrder: 0 } }); await settleMicrotasks() })
    await view.settle()
    await view.settle()
    expect(unreadDots(view.host)).toBe(0)
  })

  it('restoring a conversation settles instead of looping', async () => {
    const view = startApp()
    await view.settle()
    await act(async () => { emit({ type: 'session.changed', sequence: 21, payload: { session: { id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude chat', archived: true, updatedAt: '2026-10-02T04:00:00.000Z' } } }); await settleMicrotasks() })
    await view.settle()
    await act(async () => { emit({ type: 'session.changed', sequence: 22, payload: { session: { id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude chat', archived: false, updatedAt: '2026-10-02T04:00:01.000Z' } } }); await settleMicrotasks() })
    await view.settle()
    expect(unreadDots(view.host)).toBe(0)
  }, 20000)

  it('a window does not re-publish an active session it just received', async () => {
    const handlers = await activeSessionHandlers()
    const view = startApp()
    await view.settle()
    h.setActiveSession.mockClear()
    await act(async () => { for (const handler of handlers) handler('session-codex'); await settleMicrotasks() })
    await view.settle()
    expect(h.setActiveSession.mock.calls.map(([id]) => id)).not.toContain('session-codex')
    expect(selectedBot(view.host)).toBe('Codex')
  })
})
