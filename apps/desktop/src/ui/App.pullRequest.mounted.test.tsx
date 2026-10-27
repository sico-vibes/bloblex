// @vitest-environment happy-dom
// FIX45: the rail's Create PR asks for review, then sends one ordinary message to the open
// conversation's coding agent; nothing is sent by reading the repository or opening the dialog.
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
import { resetDraftStoreForTests } from './draftStore'
import { clearRepositoryCache } from './sessionRepository'
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
// Lopsing is the first bot in the list (the owner's reported jump target).
const lopsing = agent({ id: 'agent-lopsing', name: 'Lopsing', color: '#82aaff', runtimeId: 'runtime-codex', sortOrder: 0 })
const coco = agent({ id: 'agent-coco', name: 'Coco', color: '#f38c6f', runtimeId: 'runtime-claude', sortOrder: 1 })
const manager = agent({ id: 'agent-manager', name: 'Manager', color: '#b7a7f4', runtimeId: 'runtime-claude', sortOrder: 2, systemRole: 'manager' })

const baseSessions = () => [
  session({ id: 'session-lopsing', runtimeId: 'runtime-codex', agentId: 'agent-lopsing', title: 'Lopsing chat', updatedAt: '2026-10-02T01:00:00.000Z', messages: [{ id: 'l1', role: 'user', content: 'hi' }] }),
  session({ id: 'session-coco', runtimeId: 'runtime-claude', agentId: 'agent-coco', title: 'Coco chat', updatedAt: '2026-10-02T02:00:00.000Z', messages: [{ id: 'c1', role: 'user', content: 'hi' }] }),
]

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    sequence: 20,
    runtimes: [claudeRuntime, codexRuntime],
    agents: [lopsing, coco, manager],
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

let createdSessions: Session[] = []

function configure(snapshotValue = snapshot()) {
  h.fetchSnapshot.mockImplementation(async () => createdSessions.length ? { ...snapshotValue, sessions: [...(snapshotValue.sessions ?? []), ...createdSessions] } : snapshotValue)
  h.ensureDaemon.mockResolvedValue(undefined)
  h.startDaemonEventStream.mockResolvedValue(undefined)
  h.getActiveSession.mockResolvedValue('session-coco')
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
      return baseSessions().find((item) => item.id === id) ?? session({ id, runtimeId: 'runtime-claude', agentId: 'agent-coco', title: 'Restored chat', messages: [{ id: 'r1', role: 'user', content: 'hi' }] })
    }
    // A lazily created conversation: the daemon stores it untitled ("New chat")
    // and titles it from the first message.
    if (method === 'agent.conversation' || method === 'agent.conversation.create' || method === 'session.new') {
      const agentId = String(params.agentId ?? 'agent-coco')
      const owner = [lopsing, coco, manager].find((item) => item.id === agentId)!
      const created = session({ id: `session-new-${agentId}`, runtimeId: owner.runtimeId, agentId, title: 'New chat', updatedAt: '2026-10-02T05:00:00.000Z', messages: [] })
      createdSessions.push(created)
      return { session: created }
    }
    if (method === 'session.prompt') {
      // The daemon titles a default-titled conversation from the first message.
      const target = createdSessions.find((item) => item.id === String(params.sessionId))
      if (target && target.title === 'New chat') target.title = String(params.text ?? '').split(/\s+/).slice(0, 6).join(' ')
      return {}
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

const memory = new Map<string, string>()
const fakeStorage = () => ({ getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value) }, removeItem: (key: string) => { memory.delete(key) }, clear: () => memory.clear() })

beforeEach(() => {
  memory.clear()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', fakeStorage())
  resetDraftStoreForTests()
  clearRepositoryCache()
  h.daemonEventHandlers = []
  createdSessions = []
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

const rpcMethods = () => h.rpc.mock.calls.map(([method]) => method as string)

async function click(element: Element | null | undefined) {
  await act(async () => { (element as HTMLElement).click() })
}

const repository = (extra: Record<string, unknown> = {}) => ({ projectPath: 'C:/work/site', repoRoot: 'C:/work/site', gitRepo: true, branch: 'main', detached: false, files: [{ path: 'C:/work/site/src/a.ts', repositoryPath: 'src/a.ts', change: 'modified', addedLines: 5, removedLines: 2, diff: '@@ -1 +1 @@\n-a\n+b', binary: false, truncated: false }], addedLines: 5, removedLines: 2, truncated: false, error: null, ...extra })

function configureRepository(reply: () => unknown) {
  const original = h.rpc.getMockImplementation()!
  h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'session.repository') return reply()
    if (method === 'session.environment') return { projectPath: 'C:/work/site', gitRepo: true, branch: 'main', detached: false, host: 'This computer' }
    return original(method, params)
  })
}

describe('FIX45 Create PR from the rail', () => {
  beforeEach(() => memory.set('bloblex.inspector.open', '1'))

  it('shows the repository\'s changes, asks for review, and sends one ordinary message only after the owner confirms', async () => {
    configureRepository(() => repository())
    const view = startApp()
    await view.settle()
    const button = view.host.querySelector<HTMLButtonElement>('.rail-pr')
    expect(button?.textContent).toBe('Create PR')
    expect(button?.disabled).toBe(false)
    expect(view.host.querySelector('.context-pane')?.textContent).toContain('a.ts')
    await click(button)
    const dialog = view.host.querySelector('.pr-dialog')!
    expect(dialog.textContent).toContain('Coco')
    expect(dialog.textContent).toContain('main')
    // Nothing is sent by reading, or by opening the review.
    expect(rpcMethods()).not.toContain('session.prompt')
    expect(rpcMethods()).not.toContain('session.queue.add')
    await click(dialog.querySelector('.blob-dialog-actions .primary-button'))
    await view.settle()
    const prompts = h.rpc.mock.calls.filter(([method]) => method === 'session.prompt')
    expect(prompts).toHaveLength(1)
    expect(prompts[0][1]).toMatchObject({ sessionId: 'session-coco' })
    expect(String(prompts[0][1].text)).toMatch(/pull request/i)
    expect(String(prompts[0][1].text)).toContain('Leave unrelated work alone')
    expect(view.host.querySelector('.pr-dialog')).toBeNull()
  })

  it('queues behind a running turn, and stays open without claiming success when the daemon refuses', async () => {
    const busy = baseSessions().map((item) => item.id === 'session-coco' ? { ...item, state: 'working' } : item)
    configure(snapshot({ sessions: busy }))
    configureRepository(() => repository())
    const original = h.rpc.getMockImplementation()!
    let refuse = true
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'session.queue.add' && refuse) throw new Error('The queue is full.')
      return original(method, params)
    })
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('.rail-pr'))
    expect(view.host.querySelector('.pr-dialog')?.textContent).toContain('waits until the current turn ends')
    await click(view.host.querySelector('.pr-dialog .primary-button'))
    await view.settle()
    expect(view.host.querySelector('.pr-dialog')).not.toBeNull()
    expect(view.host.querySelector('.pr-dialog [role="alert"]')).not.toBeNull()
    expect(rpcMethods()).not.toContain('session.prompt')
    refuse = false
    await click(view.host.querySelector('.pr-dialog .primary-button'))
    await view.settle()
    expect(view.host.querySelector('.pr-dialog')).toBeNull()
    expect(h.rpc).toHaveBeenCalledWith('session.queue.add', expect.objectContaining({ sessionId: 'session-coco' }))
  })

  it('has no Create PR for a clean folder, and none is sent while the repository cannot be read', async () => {
    configureRepository(() => repository({ files: [], addedLines: 0, removedLines: 0 }))
    const clean = startApp()
    await clean.settle()
    expect(clean.host.querySelector<HTMLButtonElement>('.rail-pr')?.disabled).toBe(true)
    clean.unmount()
    clearRepositoryCache()
    configureRepository(() => { throw new Error('daemon too old') })
    const broken = startApp()
    await broken.settle()
    expect(broken.host.querySelector('.rail-pr')).toBeNull()
    expect(broken.host.querySelector('.context-pane [role="alert"]')?.textContent).toContain('could not be read')
    expect(rpcMethods()).not.toContain('session.prompt')
  })
})
