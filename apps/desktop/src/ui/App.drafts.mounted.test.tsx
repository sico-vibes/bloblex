// @vitest-environment happy-dom
// FIX45: unsent text is a draft per conversation and per bot's new chat. It survives moving
// between bots and conversations and an app restart, expires after two hours, clears only when
// the daemon accepts the message, and comes back when the daemon refuses it.
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
import { setThemeStyle } from '../blob/bitbots'
import { DRAFT_STORAGE_KEY, DRAFT_TTL_MS, getDraft, resetDraftStoreForTests, flushDraftsForTests } from './draftStore'
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
const composerOf = (host: ParentNode, name: string) => host.querySelector<HTMLTextAreaElement>(`[aria-label="Message ${name}"]`)
const stored = () => JSON.parse(memory.get(DRAFT_STORAGE_KEY) ?? '{"v":1,"drafts":{}}') as { v: number; drafts: Record<string, { t: string; h?: string; at: number }> }
const open = async (view: ReturnType<typeof mountApp>, agentId: string) => { await click(view.host.querySelector(`.team-row[data-agent-id="${agentId}"]`)); await view.settle() }

describe('FIX45 drafts', () => {
  it('keeps what you typed in each conversation and in each bot\'s new chat while you move around', async () => {
    const view = startApp()
    await view.settle()
    expect(selectedBot(view.host)).toBe('Coco')
    await typeInto(composerOf(view.host, 'Coco'), 'half a thought for Coco')
    await open(view, 'agent-manager')
    expect(composerOf(view.host, 'Manager')?.value).toBe('')
    await typeInto(composerOf(view.host, 'Manager'), 'a plan for the Manager')
    await open(view, 'agent-lopsing')
    expect(composerOf(view.host, 'Lopsing')?.value).toBe('')
    await open(view, 'agent-coco')
    expect(composerOf(view.host, 'Coco')?.value).toBe('half a thought for Coco')
    await open(view, 'agent-manager')
    expect(composerOf(view.host, 'Manager')?.value).toBe('a plan for the Manager')
    // Nothing was created or sent just by writing.
    expect(rpcMethods()).not.toContain('agent.conversation.create')
    expect(rpcMethods()).not.toContain('session.prompt')
  })

  it('brings the drafts back after the app is closed and opened again', async () => {
    const first = startApp()
    await first.settle()
    await typeInto(composerOf(first.host, 'Coco'), 'before the restart')
    await open(first, 'agent-manager')
    await typeInto(composerOf(first.host, 'Manager'), 'a new chat, before the restart')
    flushDraftsForTests()
    first.unmount()
    resetDraftStoreForTests() // a new process: nothing in memory, the same storage
    const second = startApp()
    await second.settle()
    await open(second, 'agent-coco') // the app reopens on the last bot; go to each by hand
    expect(composerOf(second.host, 'Coco')?.value).toBe('before the restart')
    await open(second, 'agent-manager')
    expect(composerOf(second.host, 'Manager')?.value).toBe('a new chat, before the restart')
    expect(JSON.stringify(stored())).not.toMatch(/path|attachments/i)
  })

  it('drops a draft left alone for two hours, by the device clock', async () => {
    const first = startApp()
    await first.settle()
    await typeInto(composerOf(first.host, 'Coco'), 'left on the desk')
    flushDraftsForTests()
    first.unmount()
    vi.setSystemTime(Date.now() + DRAFT_TTL_MS - 60_000)
    resetDraftStoreForTests()
    const soon = startApp()
    await soon.settle()
    expect(composerOf(soon.host, 'Coco')?.value).toBe('left on the desk')
    soon.unmount()
    vi.setSystemTime(Date.now() + 120_000)
    resetDraftStoreForTests()
    const late = startApp()
    await late.settle()
    expect(composerOf(late.host, 'Coco')?.value).toBe('')
  })

  it('clears the draft of the first message of a new chat once the daemon accepts it, and nothing else', async () => {
    const view = startApp()
    await view.settle()
    await typeInto(composerOf(view.host, 'Coco'), 'keep me')
    await open(view, 'agent-manager')
    await typeInto(composerOf(view.host, 'Manager'), 'Plan the launch')
    await send(view)
    expect(h.rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({ text: 'Plan the launch' }))
    flushDraftsForTests()
    expect(getDraft('draft:agent-manager')).toBe('')
    expect(JSON.stringify(stored())).not.toContain('Plan the launch')
    // Another conversation's draft is untouched, and the Manager's new box is empty again.
    expect(getDraft('session-coco')).toBe('keep me')
    await open(view, 'agent-coco')
    expect(composerOf(view.host, 'Coco')?.value).toBe('keep me')
  })

  it('keeps a message that was refused: the failed row holds it, Edit puts it back, and a restart finds it meanwhile', async () => {
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'session.prompt') throw new Error('The coding agent did not answer.')
      if (method === 'events.replay') return { replayAvailable: true, events: [] }
      if (method === 'settings.get') return { settings: {} }
      if (method === 'session.get') return baseSessions().find((item) => item.id === String(params.sessionId))
      return {}
    })
    const view = startApp()
    await view.settle()
    await typeInto(composerOf(view.host, 'Coco'), 'please retry me')
    await send(view)
    expect(view.host.querySelector('.message-pending-note.failed')).not.toBeNull()
    expect(composerOf(view.host, 'Coco')?.value).toBe('')
    // Not accepted, so it is still saved as held: a restart would bring it back.
    flushDraftsForTests()
    expect(stored().drafts['session-coco']).toMatchObject({ t: '', h: [expect.objectContaining({ text: 'please retry me' })] })
    await click([...view.host.querySelectorAll('.message-pending-note.failed .queue-link')].find((node) => node.textContent === 'Edit'))
    expect(composerOf(view.host, 'Coco')?.value).toBe('please retry me')
    flushDraftsForTests()
    expect(stored().drafts['session-coco'].h).toBeUndefined()
  })

  it('puts a refused queued message back in its own box', async () => {
    const busy = baseSessions().map((item) => item.id === 'session-coco' ? { ...item, state: 'working' } : item)
    configure(snapshot({ sessions: busy }))
    const original = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'session.queue.add' || method === 'session.steer') throw new Error('The queue is full.')
      return original(method, params)
    })
    const view = startApp()
    await view.settle()
    await typeInto(composerOf(view.host, 'Coco'), 'queue this please')
    await send(view)
    expect(composerOf(view.host, 'Coco')?.value).toBe('queue this please')
    expect(getDraft('session-coco')).toBe('queue this please')
  })

  it('does not let a draft cross into another conversation while a new chat is being created', async () => {
    let finish!: () => void
    const original = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'agent.conversation.create') await new Promise<void>((resolve) => { finish = resolve })
      return original(method, params)
    })
    const view = startApp()
    await view.settle()
    await typeInto(composerOf(view.host, 'Coco'), 'Coco only')
    await open(view, 'agent-manager')
    await typeInto(composerOf(view.host, 'Manager'), 'Manager first message')
    await act(async () => { view.host.querySelector<HTMLButtonElement>('.send-button')!.click() })
    await open(view, 'agent-coco')
    await act(async () => { finish(); await settleMicrotasks() })
    await view.settle()
    // The first message went to the Manager's new conversation and left the Manager's new-chat box empty; Coco's text was not touched.
    expect(h.rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({ sessionId: 'session-new-agent-manager', text: 'Manager first message' }))
    expect(getDraft('draft:agent-manager')).toBe('')
    expect(getDraft('session-coco')).toBe('Coco only')
    await open(view, 'agent-coco')
    expect(composerOf(view.host, 'Coco')?.value).toBe('Coco only')
    expect(composerOf(view.host, 'Coco')?.value).not.toContain('Manager')
  })

  it('follows the other window\'s newer draft, but never replaces the box being typed in', async () => {
    const view = startApp()
    await view.settle()
    const write = (text: string, offset: number) => {
      memory.set(DRAFT_STORAGE_KEY, JSON.stringify({ v: 1, drafts: { 'session-coco': { t: text, at: Date.now() + offset } } }))
      window.dispatchEvent(new StorageEvent('storage', { key: DRAFT_STORAGE_KEY }))
    }
    await act(async () => { write('typed in the companion', 10) })
    expect(composerOf(view.host, 'Coco')?.value).toBe('typed in the companion')
    // Now this window is being typed in: a newer copy from the other window waits.
    await act(async () => { composerOf(view.host, 'Coco')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); composerOf(view.host, 'Coco')!.focus() })
    await typeInto(composerOf(view.host, 'Coco'), 'typing here now')
    await act(async () => { write('a late write from the companion', 100_000) })
    expect(composerOf(view.host, 'Coco')?.value).toBe('typing here now')
  })

  it('survives unreadable and blocked storage', async () => {
    memory.set(DRAFT_STORAGE_KEY, '{definitely not json')
    const view = startApp()
    await view.settle()
    expect(composerOf(view.host, 'Coco')?.value).toBe('')
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') } })
    resetDraftStoreForTests()
    await typeInto(composerOf(view.host, 'Coco'), 'still works')
    expect(composerOf(view.host, 'Coco')?.value).toBe('still works')
    await open(view, 'agent-manager')
    await open(view, 'agent-coco')
    expect(composerOf(view.host, 'Coco')?.value).toBe('still works')
  })
})
