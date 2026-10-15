// FIX21: companion second batch — the completion peek and Focus mode (C7),
// snap/positions plumbing (C8), the live Activity tab (C9), chat polish (C10),
// the drop-zone debounce (C12) and the Remote row (C13).
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
import { playCompanionCue } from '../blob/soundCues'
import { resetFocusMode } from './companionPrefs'
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
const claudeSession = session({
  id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Landing page copy', state: 'idle',
  messages: [{ id: 'm1', role: 'user', content: 'Hello from the test' }],
})
const codexSession = session({ id: 'session-codex', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Docs', state: 'idle' })

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    sequence: 20, runtimes: [claudeRuntime, codexRuntime], agents: [claude, codex], sessions: [claudeSession, codexSession],
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
  let unmounted = false
  act(() => root.render(<StrictMode><App /></StrictMode>))
  return {
    host,
    async settle() { await act(async () => { await settleMicrotasks(); await vi.advanceTimersByTimeAsync(40); await settleMicrotasks() }) },
    unmount() { if (unmounted) return; unmounted = true; act(() => root.unmount()); host.remove() },
  }
}

const mounted: Array<ReturnType<typeof mountApp>> = []
function startApp(search = '') {
  const view = mountApp(search)
  mounted.push(view)
  return view
}

let dragHandler: ((event: { payload: Record<string, unknown> }) => void) | undefined
let daemonHandlers: Array<(event: DaemonEvent) => void> = []

function configure(snapshotValue = snapshot(), settings: Record<string, unknown> = {}, remote: unknown | Error = { enabled: false, link: 'off', connectedCount: 0, deviceCount: 0 }) {
  h.fetchSnapshot.mockResolvedValue(snapshotValue)
  h.ensureDaemon.mockResolvedValue(undefined)
  h.startDaemonEventStream.mockResolvedValue(undefined)
  h.getActiveSession.mockResolvedValue('session-claude')
  h.getActiveRuntime.mockResolvedValue('runtime-claude')
  h.setActiveSession.mockResolvedValue(undefined)
  h.setActiveRuntime.mockResolvedValue(undefined)
  h.setCompanionMode.mockResolvedValue(undefined)
  h.setCompanionVisibility.mockResolvedValue(undefined)
  h.companionMonitorOptions.mockResolvedValue(['\\\\.\\DISPLAY1'])
  h.currentCompanionMonitor.mockResolvedValue('\\\\.\\DISPLAY1')
  h.setCompanionMonitor.mockResolvedValue(undefined)
  h.refreshTrayMenu.mockResolvedValue(undefined)
  h.invoke.mockResolvedValue(true)
  h.emit.mockResolvedValue(undefined)
  h.selectLocalFile.mockResolvedValue(null)
  h.inspectLocalFile.mockResolvedValue({ path: 'C:/work/report.PDF', fileName: 'report.PDF', sizeBytes: 2048 })
  h.rpc.mockImplementation(async (method: string) => {
    if (method === 'events.replay') return { replayAvailable: true, events: [] }
    if (method === 'settings.get') return { settings }
    if (method === 'agent.get') return { agent: claude }
    if (method === 'remote.status') { if (remote instanceof Error) throw remote; return remote }
    if (method === 'session.queue.list') return { items: [], paused: false }
    return {}
  })
  const stop = vi.fn()
  h.listenForDaemonEvents.mockImplementation(async (handler: (event: DaemonEvent) => void) => { daemonHandlers.push(handler); return stop })
  h.listenForDaemonConnection.mockResolvedValue(stop)
  h.listenForActiveSession.mockResolvedValue(stop)
  h.listenForActiveRuntime.mockResolvedValue(stop)
  h.listenForOpenSettings.mockResolvedValue(stop)
  h.directListen.mockResolvedValue(stop)
  dragHandler = undefined
  h.getCurrentWindow.mockReturnValue({ onDragDropEvent: vi.fn((handler: (event: { payload: Record<string, unknown> }) => void) => { dragHandler = handler; return Promise.resolve(stop) }) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() })
  vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText: vi.fn(async () => undefined) } })
  for (const mock of Object.values(h)) if (typeof mock === 'function' && 'mockReset' in mock) (mock as ReturnType<typeof vi.fn>).mockReset()
  daemonHandlers = []
  resetFocusMode()
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

async function deliver(view: ReturnType<typeof startApp>, event: DaemonEvent) {
  await act(async () => { for (const handler of daemonHandlers) handler(event) })
  await view.settle()
}

// ── C7: completion peek and Focus mode ───────────────────────────────────
describe('C7 completion peek', () => {
  it('peeks when another bot finishes, plays blip, and Open selects and expands', async () => {
    configure(snapshot({ sessions: [claudeSession, { ...codexSession, state: 'working' }] }))
    const view = startApp('?companion=1')
    await view.settle()
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('petit')
    vi.mocked(playCompanionCue).mockClear()

    await deliver(view, { sequence: 21, type: 'session.changed', payload: { session: { ...codexSession, state: 'idle' } } } as DaemonEvent)
    const peek = view.host.querySelector('.companion-peek')
    expect(peek?.textContent).toContain('Codex finished.')
    expect(peek?.textContent).toContain('Open')
    expect(playCompanionCue).toHaveBeenCalledWith('blip')

    await act(async () => { view.host.querySelector<HTMLButtonElement>('.companion-peek')!.click(); await settleMicrotasks() })
    await view.settle()
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('home')
    expect(view.host.querySelector('.companion-peek')).toBeNull()
  })

  it('never peeks for the focused bot or a failed turn', async () => {
    configure(snapshot({ sessions: [{ ...claudeSession, state: 'working' }, codexSession] }))
    const view = startApp('?companion=1')
    await view.settle()
    // The focused bot is Claude; its finish is its own mood, not a peek.
    await deliver(view, { sequence: 21, type: 'session.changed', payload: { session: { ...claudeSession, state: 'idle' } } } as DaemonEvent)
    expect(view.host.querySelector('.companion-peek')).toBeNull()

    configure(snapshot({ sessions: [claudeSession, { ...codexSession, state: 'working' }] }))
    const failure = startApp('?companion=1')
    await failure.settle()
    await deliver(failure, { sequence: 22, type: 'session.changed', payload: { session: { ...codexSession, state: 'error' } } } as DaemonEvent)
    expect(failure.host.querySelector('.companion-peek')).toBeNull()
  })

  it('coalesces two finishes within the window into one count', async () => {
    const ops = agent({ id: 'agent-ops', name: 'Ops', color: '#7fd1a0', runtimeId: 'runtime-claude', sortOrder: 1 })
    const opsSession = session({ id: 'session-ops', runtimeId: 'runtime-claude', agentId: 'agent-ops', state: 'working' })
    configure(snapshot({ agents: [claude, codex, ops], sessions: [claudeSession, { ...codexSession, state: 'working' }, opsSession] }))
    const view = startApp('?companion=1')
    await view.settle()
    await deliver(view, { sequence: 21, type: 'session.changed', payload: { session: { ...codexSession, state: 'idle' } } } as DaemonEvent)
    await deliver(view, { sequence: 22, type: 'session.changed', payload: { session: { ...opsSession, state: 'completed' } } } as DaemonEvent)
    expect(view.host.querySelector('.companion-peek-text')?.textContent).toBe('2 bots finished.')
  })

  it('suppresses the peek and its cue in Focus mode, but keeps approvals', async () => {
    configure(snapshot({ sessions: [claudeSession, { ...codexSession, state: 'working' }] }), { 'companion.focusMode': true })
    const view = startApp('?companion=1')
    await view.settle()
    vi.mocked(playCompanionCue).mockClear()
    await deliver(view, { sequence: 21, type: 'session.changed', payload: { session: { ...codexSession, state: 'idle' } } } as DaemonEvent)
    expect(view.host.querySelector('.companion-peek')).toBeNull()
    expect(playCompanionCue).not.toHaveBeenCalledWith('blip')

    configure(snapshot({
      sessions: [{ ...claudeSession, state: 'waiting_permission' }],
      permissions: [{ id: 'perm-1', sessionId: 'session-claude', runtimeId: 'runtime-claude', status: 'pending', title: 'Run shell command', choices: ['allow_once', 'deny'] }],
    }), { 'companion.focusMode': true })
    const approval = startApp('?companion=1')
    await approval.settle()
    expect(approval.host.textContent).toContain('Run shell command')
  })
})

// ── C7/C8: the shared Focus-mode and position controls ───────────────────
describe('C7/C8 companion settings controls', () => {
  it('shows the Focus mode switch and the Reset position button', async () => {
    const view = startApp('?companion=1')
    await openHome(view)
    await press(view.host, 'Settings')
    const focusSwitch = view.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Focus mode"]')!
    expect(focusSwitch.getAttribute('aria-checked')).toBe('false')
    await act(async () => { focusSwitch.click(); await settleMicrotasks() })
    expect(focusSwitch.getAttribute('aria-checked')).toBe('true')
    expect(h.rpc.mock.calls.some(([method, params]) => method === 'settings.set' && params.key === 'companion.focusMode' && params.value === true)).toBe(true)

    await press(view.host, 'Reset companion position')
    expect(h.setCompanionMonitor).toHaveBeenCalledWith('\\\\.\\DISPLAY1')
    expect(h.rpc.mock.calls.some(([method, params]) => method === 'settings.set' && params.key === 'companion.positions')).toBe(false)
  })
})

// ── C9: the live Activity tab ────────────────────────────────────────────
describe('C9 live activity summary', () => {
  it('lists each working bot with its step, status dot and elapsed time', async () => {
    const working = session({ ...claudeSession, state: 'working', tools: [{ id: 't1', title: 'npm test', state: 'running', command: 'npm test', sequence: 1 }] })
    configure(snapshot({ sessions: [working, codexSession] }))
    const view = startApp('?companion=1')
    await openHome(view)
    await press(view.host, 'Activity')
    const row = view.host.querySelector('.companion-activity-row.working')!
    expect(row.textContent).toContain('Claude')
    expect(row.textContent).toContain('npm test')
    expect(row.querySelector('.bot-status-working')).not.toBeNull()
    expect(row.querySelector('.companion-elapsed')?.textContent).toBe('0s')
  })

  it('shows "Nothing is running." when no bot is working', async () => {
    const view = startApp('?companion=1')
    await openHome(view)
    await press(view.host, 'Activity')
    expect(view.host.querySelector('.companion-activity-view')?.textContent).toContain('Nothing is running.')
    expect(view.host.querySelector('.companion-activity-row.working')).toBeNull()
  })
})

// ── C10: chat polish ─────────────────────────────────────────────────────
describe('C10 chat polish', () => {
  const manyMessages = session({
    ...claudeSession,
    messages: Array.from({ length: 20 }, (_, index) => ({ id: `m${index}`, role: 'user', content: `Message ${index}` })),
  })

  it('shows the last eight messages and reveals eight more per Load earlier', async () => {
    configure(snapshot({ sessions: [manyMessages, codexSession] }))
    const view = startApp('?companion=1')
    await openHome(view)
    await press(view.host, 'Chat')
    const rows = () => view.host.querySelectorAll('.chat-row')
    expect(rows()).toHaveLength(8)
    expect(view.host.querySelector('.chat-log')?.textContent).toContain('Message 19')
    expect(view.host.querySelector('.chat-log')?.textContent).not.toContain('Message 11')

    await act(async () => { view.host.querySelector<HTMLButtonElement>('.companion-load-earlier')!.click(); await settleMicrotasks() })
    expect(rows()).toHaveLength(16)
    await act(async () => { view.host.querySelector<HTMLButtonElement>('.companion-load-earlier')!.click(); await settleMicrotasks() })
    expect(rows()).toHaveLength(20)
    expect(view.host.querySelector('.companion-load-earlier')).toBeNull()
  })

  it('copies a message and shows the 1.2 s Copied state', async () => {
    const view = startApp('?companion=1')
    await openHome(view)
    await press(view.host, 'Chat')
    const copy = view.host.querySelector<HTMLButtonElement>('.chat-row.user .companion-copy')!
    await act(async () => { copy.click(); await settleMicrotasks() })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Hello from the test')
    expect(copy.getAttribute('aria-label')).toBe('Copied')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); await settleMicrotasks() })
    expect(copy.getAttribute('aria-label')).toBe('Copy message text')
  })

  it('does not follow the bottom when scrolled up; a New messages pill returns', async () => {
    configure(snapshot({ sessions: [claudeSession, codexSession] }))
    const view = startApp('?companion=1')
    await openHome(view)
    await press(view.host, 'Chat')
    const log = view.host.querySelector<HTMLElement>('.chat-log')!
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 })
    act(() => { log.scrollTop = 0; log.dispatchEvent(new Event('scroll')) })

    await deliver(view, { sequence: 21, type: 'session.changed', payload: { session: { ...claudeSession, messages: [...claudeSession.messages!, { id: 'm2', role: 'assistant', content: 'A new reply' }] } } } as DaemonEvent)
    const pill = view.host.querySelector<HTMLButtonElement>('.companion-new-messages')
    expect(pill).not.toBeNull()
    await act(async () => { pill!.click(); await settleMicrotasks() })
    expect(log.scrollTop).toBe(1000)
    expect(view.host.querySelector('.companion-new-messages')).toBeNull()
  })
})

// ── C12: drop-zone debounce ──────────────────────────────────────────────
describe('C12 drop zone', () => {
  const enter = (path: string) => ({ payload: { type: 'enter', paths: [path], position: { x: 1, y: 1 } } })

  it('opens once, keeps the drop card through a quick leave and re-enter, then collapses', async () => {
    const view = startApp('?companion=1')
    await view.settle()
    act(() => dragHandler!(enter('C:\\work\\report.PDF')))
    await view.settle()
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('home')
    const card = view.host.querySelector('.drop-card.over')
    expect(card).not.toBeNull()
    // The chips name the file, its extension and its size.
    const chips = [...card!.querySelectorAll('.drop-tags span')].map((chip) => chip.textContent)
    expect(chips).toEqual(['report.PDF', 'PDF', '2.0 KB'])

    // Leave, then re-enter within the grace period: the card must not collapse.
    act(() => dragHandler!({ payload: { type: 'leave', position: { x: 1, y: 1 } } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(100); await settleMicrotasks() })
    expect(view.host.querySelector('.drop-card.over')).not.toBeNull()
    act(() => dragHandler!(enter('C:\\work\\report.PDF')))
    await act(async () => { await vi.advanceTimersByTimeAsync(400); await settleMicrotasks() })
    expect(view.host.querySelector('.drop-card.over')).not.toBeNull()

    // A final leave with no return collapses it after the grace period.
    act(() => dragHandler!({ payload: { type: 'leave', position: { x: 1, y: 1 } } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(300); await settleMicrotasks() })
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('petit')
  })
})

// ── C13: the Remote row ──────────────────────────────────────────────────
describe('C13 remote presence', () => {
  async function openSettings(remote: unknown | Error) {
    configure(snapshot(), {}, remote)
    const view = startApp('?companion=1')
    await openHome(view)
    await press(view.host, 'Settings')
    return view
  }

  it('shows Off, or On with the connected device count and a status dot', async () => {
    const off = await openSettings({ enabled: false, link: 'off', connectedCount: 0, deviceCount: 0 })
    const offCopy = [...off.host.querySelectorAll('.cset-copy')].find((node) => node.textContent?.startsWith('Remote'))
    expect(offCopy?.textContent).toContain('Off')

    const on = await openSettings({ enabled: true, link: 'online', connectedCount: 2, deviceCount: 3 })
    const onCopy = [...on.host.querySelectorAll('.cset-copy')].find((node) => node.textContent?.startsWith('Remote'))
    expect(onCopy?.textContent).toContain('On, 2 devices connected')
    expect(onCopy?.querySelector('.bot-status')).not.toBeNull()
    await press(on.host, 'Open Remote settings')
    expect(h.showMainSettings).toHaveBeenCalledWith('session-claude', 'Remote')
  })

  it('shows nothing when remote.status is unavailable', async () => {
    const view = await openSettings(new Error('unsupported'))
    const copy = [...view.host.querySelectorAll('.cset-copy')].find((node) => node.textContent?.startsWith('Remote'))
    expect(copy).toBeUndefined()
  })
})
