// @vitest-environment happy-dom
// FIX38 H2: a bot with no conversation must be selected at once and stay there,
// with a ready composer and nothing stored until the first message is sent.
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
  listenForDaemonSupervisor: async () => () => undefined,
  daemonSupervisorState: async () => ({ state: 'running', attempt: 0, nextRetryMs: null, lastExitCode: null }),
  restartDaemonNow: async () => ({ state: 'running', attempt: 0, nextRetryMs: null, lastExitCode: null }),
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
import { setThemeStyle } from '../blob/bitbots'
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

/** Records every distinct selected-bot name seen across settles. */
async function watchSelection(view: ReturnType<typeof mountApp>, settles = 4): Promise<string[]> {
  const seen: string[] = []
  const record = () => { const name = selectedBot(view.host); if (name && seen.at(-1) !== name) seen.push(name) }
  record()
  for (let index = 0; index < settles; index += 1) { await view.settle(); record() }
  return seen
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

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() })
  h.daemonEventHandlers = []
  createdSessions = []
  for (const mock of Object.values(h)) if (typeof mock === 'function' && 'mockReset' in mock) (mock as ReturnType<typeof vi.fn>).mockReset()
  setThemeStyle('blobots')
  configure()
})

afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

const selectedBot = (host: ParentNode) => host.querySelector('.bot-row[aria-current="true"] strong')?.textContent ?? null
const conversationRowTitles = (host: ParentNode) => [...host.querySelectorAll('.conversations-panel .convo-title')].map((node) => node.textContent?.trim() ?? '')
const rpcMethods = () => h.rpc.mock.calls.map(([method]) => method as string)

async function click(element: Element | null | undefined) {
  await act(async () => { (element as HTMLElement).click() })
}

async function typeInto(element: HTMLTextAreaElement | null, value: string) {
  if (!element) throw new Error('missing composer')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function send(view: ReturnType<typeof mountApp>) {
  await act(async () => { view.host.querySelector<HTMLButtonElement>('.send-button')!.click() })
  await view.settle()
}

describe('FIX38 H2 clicking a bot with no conversation', () => {
  it('selects the bot at once and stays on it across settles', async () => {
    const view = startApp()
    await view.settle()
    expect(selectedBot(view.host)).toBe('Coco')

    await click(view.host.querySelector('.team-row[data-agent-id="agent-manager"]'))
    const seen = await watchSelection(view, 4)
    expect(seen, `selection history: ${seen.join(' -> ')}`).toEqual(['Manager'])
    expect(selectedBot(view.host)).toBe('Manager')
  })

  it('does not bounce to the first bot when the companion round-trips the active session', async () => {
    // Models the native active-session bridge: every window receives what any
    // window publishes. A companion that loses the session falls back to another
    // conversation and announces it back. Opening a bot with no conversation must
    // not publish a null active session, so this round-trip never starts.
    const handlers: Array<(sessionId: string | null) => void> = []
    let active: string | null = 'session-coco'
    h.listenForActiveSession.mockImplementation(async (handler: (sessionId: string | null) => void) => { handlers.push(handler); return vi.fn() })
    h.setActiveSession.mockImplementation(async (sessionId: string | null) => {
      if (sessionId === active) return
      active = sessionId
      await Promise.resolve()
      for (const handler of handlers) handler(sessionId)
      if (sessionId === null) {
        await Promise.resolve()
        for (const handler of handlers) handler('session-lopsing')
      }
    })
    const view = startApp()
    await view.settle()
    expect(selectedBot(view.host)).toBe('Coco')
    await click(view.host.querySelector('.team-row[data-agent-id="agent-manager"]'))
    const seen = await watchSelection(view, 6)
    expect(seen, `selection history: ${seen.join(' -> ')}`).toEqual(['Manager'])
  })

  it('shows a ready composer without creating a conversation first', async () => {
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('.team-row[data-agent-id="agent-manager"]'))
    await view.settle()
    await view.settle()
    expect(view.host.querySelector('[aria-label="Message Manager"]')).not.toBeNull()
    expect(rpcMethods()).not.toContain('agent.conversation')
    expect(rpcMethods()).not.toContain('agent.conversation.create')
    expect(rpcMethods()).not.toContain('session.new')
  })

  it('does not leave a conversation row titled with the bot name before a message', async () => {
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('.team-row[data-agent-id="agent-manager"]'))
    await view.settle()
    await view.settle()
    expect(conversationRowTitles(view.host)).not.toContain('Manager')
  })

  it('leaving the bot without sending leaves nothing behind', async () => {
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('.team-row[data-agent-id="agent-manager"]'))
    await view.settle()
    // Pick another bot before saying anything.
    await click(view.host.querySelector('.team-row[data-agent-id="agent-coco"]'))
    await view.settle()
    await view.settle()
    expect(selectedBot(view.host)).toBe('Coco')
    expect(rpcMethods()).not.toContain('agent.conversation')
    expect(rpcMethods()).not.toContain('agent.conversation.create')
    expect(rpcMethods()).not.toContain('session.delete.schedule')
    expect(conversationRowTitles(view.host)).not.toContain('Manager')
  })

  it('sends the first message by creating exactly one conversation and prompting it', async () => {
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('.team-row[data-agent-id="agent-manager"]'))
    await view.settle()
    await typeInto(view.host.querySelector<HTMLTextAreaElement>('[aria-label="Message Manager"]'), 'Plan the launch')
    await send(view)
    const creates = h.rpc.mock.calls.filter(([method]) => method === 'agent.conversation.create')
    expect(creates).toHaveLength(1)
    expect(creates[0][1]).toEqual({ agentId: 'agent-manager' })
    expect(h.rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({ sessionId: 'session-new-agent-manager', text: 'Plan the launch' }))
    expect(selectedBot(view.host)).toBe('Manager')
    // The conversation is titled from the message, never with the bot's name.
    expect(conversationRowTitles(view.host)).toContain('Plan the launch')
    expect(conversationRowTitles(view.host)).not.toContain('Manager')
  })

  it('treats the Manager like any other bot with no conversation', async () => {
    // Start with the Manager selected by picking it, then confirm its draft and
    // its first-message behaviour match the other bots.
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('.team-row[data-agent-id="agent-manager"]'))
    const seen = await watchSelection(view, 3)
    expect(seen).toEqual(['Manager'])
    expect(view.host.querySelector('[aria-label="Message Manager"]')).not.toBeNull()
    expect(conversationRowTitles(view.host)).not.toContain('Manager')
  })
  it('keeps a new bot selected when an old runtime selection is echoed', async () => {
    const handlers: Array<(id: string | null) => void> = []
    h.listenForActiveRuntime.mockImplementation(async (handler: (id: string | null) => void) => { handlers.push(handler); return vi.fn() })
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('.team-row[data-agent-id="agent-manager"]'))
    await act(async () => { for (const handler of handlers) handler('runtime-codex'); await settleMicrotasks() })
    const seen = await watchSelection(view, 4)
    expect(seen).toEqual(['Manager'])
    expect(view.host.querySelector('[aria-label="Message Manager"]')).not.toBeNull()
  })

})
