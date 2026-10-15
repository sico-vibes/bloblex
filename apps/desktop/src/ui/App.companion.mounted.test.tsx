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
import { hydrateHints } from './uiPrefs'
import type { Agent, Runtime, Session, Snapshot } from '../types'
import { playCompanionCue, setCompanionSoundVolume, unlockCompanionAudioFromGesture } from '../blob/soundCues'

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

describe('companion drag and usage labels', () => {
  it('passes the selected blob look to the chat state and companion', async () => {
    const dressedClaude = { ...claude, look: { shape: 'hexagon' as const, seed: 'claude-look' } }
    const emptySession = { ...claudeSession, messages: [], turns: [], tools: [], files: [] }
    const fixture = snapshot({ agents: [dressedClaude, codex], sessions: [emptySession] })
    configure(fixture)
    const main = startApp()
    await main.settle()
    const chatFace = main.host.querySelector<HTMLCanvasElement>('.session-first-state canvas.blob-canvas')
    expect(chatFace?.getAttribute('data-shape')).toBe('hexagon')
    expect(chatFace?.getAttribute('data-seed')).toBe('claude-look')
    const detailsFace = main.host.querySelector<HTMLCanvasElement>('.context-head canvas.blob-canvas')
    expect(detailsFace?.getAttribute('data-shape')).toBe('hexagon')
    expect(detailsFace?.getAttribute('data-seed')).toBe('claude-look')
    main.unmount()

    configure(fixture)
    const companion = startApp('?companion=1')
    await companion.settle()
    const companionFace = companion.host.querySelector<HTMLCanvasElement>('.compact-bot canvas.blob-canvas')
    expect(companionFace?.getAttribute('data-shape')).toBe('hexagon')
    expect(companionFace?.getAttribute('data-seed')).toBe('claude-look')
  })

  it('mounts the main-window companion switch from the hidden native default', async () => {
    let visibilityHandler: ((event: { payload: boolean }) => void) | undefined
    h.directListen.mockImplementation(async (eventName: string, handler: (event: { payload: boolean }) => void) => {
      if (eventName === 'bloblex-companion-visible-changed') visibilityHandler = handler
      return vi.fn()
    })
    const view = startApp()
    await view.settle()
    const toggle = view.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Companion, keep your bot on screen while you work"]')
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    await act(async () => { toggle?.click(); await settleMicrotasks() })
    expect(h.setCompanionVisibility).toHaveBeenCalledWith(true)
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    await act(async () => { visibilityHandler?.({ payload: true }); await settleMicrotasks() })
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
  })

  it('starts compact and marks every non-interactive companion target in compact, home, chat, activity, settings, and approval', async () => {
    const view = startApp('?companion=1')
    await view.settle()
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('petit')
    const face = view.host.querySelector('.compact-bot canvas.blob-canvas')
    const name = view.host.querySelector('.compact-copy strong')
    const status = view.host.querySelector('.compact-copy [role="status"]')
    expect(resolvesToDrag(face), 'compact face').toBe(true)
    expect(resolvesToDrag(name), 'compact name').toBe(true)
    expect(resolvesToDrag(status), 'compact status').toBe(true)
    expect(view.host.querySelector('.compact-copy')?.hasAttribute(DRAG), 'compact-copy').toBe(true)
    expect(view.host.querySelector('.compact-bot')?.hasAttribute(DRAG), 'open button').toBe(false)
    const minis = [...view.host.querySelectorAll('.mini-grid canvas.blob-canvas')]
    expect(minis.length).toBeGreaterThan(0)
    for (const mini of minis) expect(mini.hasAttribute(DRAG), 'mini face').toBe(true)
    assertIsland(view.host, 'petit')

    await press(view.host, 'Open companion home')
    await view.settle()
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('home')
    expect(resolvesToDrag(view.host.querySelector('.island-card.focus .card-bot canvas.blob-canvas')), 'home face').toBe(true)
    const pills = [...view.host.querySelectorAll('.peer')]
    expect(pills.length).toBeGreaterThan(0)
    for (const pill of pills) {
      expect(pill.hasAttribute(DRAG), 'pill').toBe(false)
      for (const canvas of pill.querySelectorAll('canvas')) expect(canvas.hasAttribute(DRAG), 'pill face').toBe(false)
    }
    assertIsland(view.host, 'home')

    await press(view.host, 'Chat')
    await view.settle()
    expect(h.setCompanionMode.mock.calls.some(([mode]) => mode === 'home-chat')).toBe(true)
    const log = view.host.querySelector('.chat-log')
    expect(log?.hasAttribute(DRAG), 'message list').toBe(false)
    expect(log?.querySelector('.bubble')?.hasAttribute(DRAG), 'message text').toBe(false)
    expect(view.host.querySelector('.companion-chat-composer')?.hasAttribute(DRAG), 'composer').toBe(false)
    expect(view.host.querySelector('.companion-chat-composer textarea')?.hasAttribute(DRAG), 'composer field').toBe(false)
    expect(resolvesToDrag(view.host.querySelector('.chat-card .card-bot canvas.blob-canvas')), 'chat face').toBe(true)
    assertIsland(view.host, 'home-chat')

    await press(view.host, 'Activity')
    await view.settle()
    // With Agent activity off, the tab explains where to turn it on; the hint is not interactive.
    expect(view.host.querySelector('.companion-activity-view')?.textContent).toContain('Settings → Experimental')
    expect(resolvesToDrag(view.host.querySelector('.companion-activity-view .companion-empty')), 'activity hint').toBe(true)
    expect(view.host.querySelector('.link-btn')?.hasAttribute(DRAG), 'activity link').toBe(false)
    assertIsland(view.host, 'activity')

    await press(view.host, 'Settings')
    await view.settle()
    expect(view.host.textContent).toContain('Drag the island to place it anywhere.')
    expect(view.host.querySelector('[role="switch"]')?.hasAttribute(DRAG), 'sounds switch').toBe(false)
    expect(view.host.querySelector('.btn.primary')?.hasAttribute(DRAG), 'settings button').toBe(false)
    assertIsland(view.host, 'settings')

    configure(snapshot({
      sessions: [{ ...claudeSession, state: 'waiting_permission' }],
      permissions: [{ id: 'perm-1', sessionId: 'session-claude', runtimeId: 'runtime-claude', status: 'pending', title: 'Run shell command', command: 'npm test', choices: ['allow_once', 'deny'] }],
    }))
    const approval = startApp('?companion=1')
    await approval.settle()
    expect(approval.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('home')
    expect(approval.host.textContent).toContain('Run shell command')
    const choices = [...approval.host.querySelectorAll('.companion-permission-choice')]
    expect(choices.length).toBeGreaterThan(0)
    for (const choice of choices) expect(choice.hasAttribute(DRAG), 'permission choice').toBe(false)
    expect(choices.find((choice) => choice.textContent?.includes('Allow once'))?.classList.contains('permission-choice-primary')).toBe(true)
    expect(choices.find((choice) => choice.textContent?.includes('Deny'))?.classList.contains('permission-choice-secondary')).toBe(true)
    expect(choices.map((choice) => choice.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Enter'), expect.stringContaining('Esc')]))
    expect(resolvesToDrag(approval.host.querySelector('.companion-approval-card strong')), 'permission title').toBe(true)
    expect(resolvesToDrag(approval.host.querySelector('.card-bot canvas.blob-canvas')), 'permission face').toBe(true)
    const approvalCard = approval.host.querySelector<HTMLElement>('.companion-approval-card')!
    act(() => approvalCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    await approval.settle()
    expect(h.rpc.mock.calls.some(([method, params]) => method === 'permission.reply' && params.permissionId === 'perm-1' && params.choice === 'allow_once')).toBe(true)
    assertIsland(approval.host, 'approval')
  })

  it('queues typed text while the blob works and stops the turn when the box is empty', async () => {
    const working = session({ ...claudeSession, state: 'working' })
    configure(snapshot({ sessions: [working] }))
    const base = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'session.queue.list') return { items: [{ id: 'q1', sessionId: 'session-claude', text: 'Then run lint', kind: 'user', dueAt: null, status: 'queued', error: null, position: 0 }], paused: false }
      if (method === 'session.queue.add') return { item: { id: 'q1' } }
      return base(method, params)
    })
    const view = startApp('?companion=1')
    await view.settle()
    await press(view.host, 'Open companion home')
    await view.settle()
    await press(view.host, 'Chat')
    await view.settle()
    // An empty box means the button stops the turn.
    expect([...view.host.querySelectorAll('.companion-chat-composer button')].some((item) => item.getAttribute('aria-label') === 'Cancel turn')).toBe(true)
    const textarea = view.host.querySelector<HTMLTextAreaElement>('.companion-chat-composer textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Then run lint')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await settleMicrotasks()
    })
    // Text turns the same button into "Queue message".
    await press(view.host, 'Queue message')
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('session.queue.add', { sessionId: 'session-claude', text: 'Then run lint' })
    expect(h.rpc).not.toHaveBeenCalledWith('session.prompt', expect.anything())
    expect(view.host.querySelector('.companion-queue-note')?.textContent).toBe('1 queued · sends when this turn ends')
  })

  it('denies an approval on Escape without collapsing the companion', async () => {
    configure(snapshot({
      sessions: [{ ...claudeSession, state: 'waiting_permission' }],
      permissions: [{ id: 'perm-escape', sessionId: 'session-claude', runtimeId: 'runtime-claude', status: 'pending', title: 'Confirm action', choices: ['allow_once', 'deny'] }],
    }))
    const view = startApp('?companion=1')
    await view.settle()
    const normalRpc = h.rpc.getMockImplementation()!
    let rejectFirstReply = true
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'permission.reply' && rejectFirstReply) { rejectFirstReply = false; throw new Error('Temporary reply failure') }
      return normalRpc(method, params)
    })
    const firstCard = view.host.querySelector<HTMLElement>('.companion-approval-card')!
    const firstEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => firstCard.dispatchEvent(firstEvent))
    await view.settle()

    expect(firstEvent.defaultPrevented).toBe(true)
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('home')
    expect(view.host.querySelector('.companion-approval-card')).not.toBeNull()
    act(() => view.host.querySelector<HTMLElement>('.companion-approval-card')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    await view.settle()
    const replies = h.rpc.mock.calls.filter(([method]) => method === 'permission.reply')
    expect(replies).toHaveLength(2)
    expect(replies[1]?.[1]).toMatchObject({ permissionId: 'perm-escape', choice: 'deny' })
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('home')
  })

  it('labels daemon-wide reported tokens without monetary valuation beside a blob', async () => {
    const companion = startApp('?companion=1')
    await companion.settle()
    await press(companion.host, 'Open companion home')
    await companion.settle()
    const glance = companion.host.querySelector('.glance')
    expect(glance?.textContent?.replace(/\s+/g, ' ')).toContain('All bots: Tokens')
    expect(glance?.textContent).not.toContain('Cost')
    expect(glance?.getAttribute('title')).toContain('Reported tokens across all bots')
    const figures = [...(glance?.querySelectorAll('b') ?? [])].map((node) => node.textContent)
    const tokens = new Intl.NumberFormat(undefined, { notation: 'standard', maximumFractionDigits: 1 }).format(150)
    expect(figures).toEqual([tokens])
    expect(figures).not.toContain('0')
    expect(glance?.textContent).not.toMatch(/\$0|£0|€0/)

    const main = startApp()
    await main.settle()
    expect(main.host.querySelector('.context-pane h2')?.textContent).toBe('Claude')
    expect(main.host.querySelector('.usage-section .usage-scope')?.textContent).toBe('All bots, all time')
    const grid = main.host.querySelector('.usage-section .detail-list')
    expect(grid?.textContent).toContain('Input tokens')
    expect(grid?.textContent).toContain('Output tokens')
    expect(grid?.textContent).not.toMatch(/cost|estimate/i)
    expect(grid?.textContent).toContain('100')
    expect(grid?.textContent).toContain('50')
    const tokenCounts = [...(grid?.querySelectorAll('strong') ?? [])].map((node) => node.textContent)
    expect(tokenCounts).toEqual(['100', '50'])
    expect(grid?.textContent).not.toMatch(/\$0|£0|€0/)
  })
})

describe('side conversations across windows', () => {
  it('closes a side conversation for good while the companion is open', async () => {
    const main = session({
      id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude',
      messages: [
        { id: 'u1', sequence: 1, role: 'user', content: 'Ask Codex which model it runs.' },
        { id: 'n1', sequence: 2, role: 'notice', content: 'Which model are you on?', meta: { kind: 'delegation', direction: 'sent', peerAgentId: 'agent-codex', peerName: 'Codex', sideSessionId: 'session-side' } },
      ],
    })
    const side = session({ id: 'session-side', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Model check', link: { kind: 'side', peerAgentId: 'agent-claude', peerName: 'Claude', originSessionId: 'session-claude', topic: 'Model check' }, messages: [{ id: 's1', sequence: 1, role: 'assistant', content: 'GPT-5.5.' }] })
    configure(snapshot({ sessions: [main, side] }))
    // The native active session notifies every window; capture this window's listener.
    const handlers: Array<(sessionId: string | null) => void> = []
    const announced: Array<string | null> = []
    h.listenForActiveSession.mockImplementation(async (handler: (sessionId: string | null) => void) => { handlers.push(handler); return vi.fn() })
    h.setActiveSession.mockImplementation(async (sessionId: string | null) => { announced.push(sessionId) })
    const deliver = async (view: ReturnType<typeof startApp>, sessionId: string | null) => { await act(async () => { for (const handler of handlers) handler(sessionId) }); await view.settle() }

    // The companion follows the main window opening and closing a side conversation,
    // and must never announce the side conversation back (that reopened it at once).
    const companionWindow = startApp('?companion=1')
    await companionWindow.settle()
    announced.length = 0
    await deliver(companionWindow, 'session-side')
    await deliver(companionWindow, 'session-claude')
    await companionWindow.settle()
    expect(announced).not.toContain('session-side')
    companionWindow.unmount()

    // In the main window, another conversation becoming active closes the side view.
    handlers.length = 0
    configure(snapshot({ sessions: [main, side] }))
    h.listenForActiveSession.mockImplementation(async (handler: (sessionId: string | null) => void) => { handlers.push(handler); return vi.fn() })
    const mainWindow = startApp()
    await mainWindow.settle()
    await act(async () => { mainWindow.host.querySelector<HTMLButtonElement>('[aria-label="Side conversations"]')!.click() })
    await mainWindow.settle()
    await act(async () => { mainWindow.host.querySelector<HTMLButtonElement>('.side-menu-item')!.click() })
    await mainWindow.settle()
    expect(mainWindow.host.querySelector('.side-header')).not.toBeNull()
    await deliver(mainWindow, 'session-claude')
    expect(mainWindow.host.querySelector('.side-header')).toBeNull()
    expect(mainWindow.host.querySelector('.composer-box textarea')?.getAttribute('aria-label')).toBe('Message Claude')
  })
})

describe('companion settings panel', () => {
  const setRange = (input: HTMLInputElement, percent: number) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(input, String(percent)); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const blips = () => vi.mocked(playCompanionCue).mock.calls.filter(([cue]) => cue === 'blip').length
  const volumeSaves = () => h.rpc.mock.calls.filter(([method, params]) => method === 'settings.set' && params.key === 'companion.soundVolume')
  const pinSaves = () => h.rpc.mock.calls.filter(([method, params]) => method === 'settings.set' && params.key === 'companion.pinnedBlobs').map(([, params]) => params.value)
  const radio = (host: ParentNode, name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) => item.textContent === name)!

  async function openSettings(settings: Record<string, unknown> = {}, snapshotValue = snapshot()) {
    configure(snapshotValue)
    const handlers: Record<string, (event: { payload: unknown }) => void> = {}
    h.directListen.mockImplementation(async (eventName: string, handler: (event: { payload: unknown }) => void) => { handlers[eventName] = handler; return vi.fn() })
    h.emit.mockResolvedValue(undefined)
    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'events.replay') return { replayAvailable: true, events: [] }
      if (method === 'settings.get') return { settings }
      return {}
    })
    vi.mocked(unlockCompanionAudioFromGesture).mockResolvedValue(true)
    vi.mocked(playCompanionCue).mockClear()
    vi.mocked(setCompanionSoundVolume).mockClear()
    const view = startApp('?companion=1')
    await view.settle()
    await press(view.host, 'Open companion home')
    await view.settle()
    await press(view.host, 'Settings')
    await view.settle()
    return { view, handlers }
  }

  it('groups the rows under labelled sections with the actions in a footer', async () => {
    const { view } = await openSettings()
    const panel = view.host.querySelector('.companion-settings-view')!
    expect([...panel.querySelectorAll('.cset-section > h3')].map((heading) => heading.textContent)).toEqual(['Sound', 'Chat', 'Teammates on the island'])
    expect(panel.querySelector('[role="switch"][aria-label="Companion sounds"]')).not.toBeNull()
    expect(panel.querySelector('[role="radiogroup"][aria-label="Chat height"]')).not.toBeNull()
    expect(panel.querySelector('.cset-footer')?.textContent).toContain('Drag the island to place it anywhere.')
    expect([...panel.querySelectorAll('.cset-footer button')].map((button) => button.textContent)).toEqual(['Open Bitbots settings', 'Hide companion'])
    // The old loose "Choose" hop to the overview is gone: choosing happens in the panel.
    expect([...panel.querySelectorAll('button')].some((button) => button.textContent === 'Choose')).toBe(false)
  })

  it('applies the volume live, then saves it once and plays one preview cue on release', async () => {
    const { view } = await openSettings({ 'companion.soundsEnabled': true })
    const slider = view.host.querySelector<HTMLInputElement>('input[aria-label="Companion sound volume"]')!
    const navigationBlips = blips()
    expect(slider.value).toBe('80')
    expect(vi.mocked(setCompanionSoundVolume)).toHaveBeenLastCalledWith(0.8)
    expect(view.host.querySelector('.volume-value')?.textContent).toBe('80%')

    act(() => { slider.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    for (const percent of [70, 55, 40]) setRange(slider, percent)
    expect(vi.mocked(setCompanionSoundVolume).mock.calls.map(([volume]) => volume).slice(-3)).toEqual([0.7, 0.55, 0.4])
    expect(view.host.querySelector('.volume-value')?.textContent).toBe('40%')
    expect(volumeSaves()).toHaveLength(0)
    expect(blips()).toBe(navigationBlips)

    await act(async () => { slider.dispatchEvent(new Event('pointerup', { bubbles: true })); await settleMicrotasks() })
    expect(volumeSaves()).toEqual([['settings.set', { key: 'companion.soundVolume', value: 0.4 }]])
    expect(blips()).toBe(navigationBlips + 1)
    expect(h.emit).toHaveBeenCalledWith('bloblex-sound-volume-changed', { volume: 0.4 })
  })

  it('reads the saved volume, follows another window, and keeps the sounds switch alone', async () => {
    const { view, handlers } = await openSettings({ 'companion.soundsEnabled': true, 'companion.soundVolume': 0.35 })
    const slider = view.host.querySelector<HTMLInputElement>('input[aria-label="Companion sound volume"]')!
    const navigationBlips = blips()
    expect(slider.value).toBe('35')
    expect(vi.mocked(setCompanionSoundVolume)).toHaveBeenCalledWith(0.35)
    const sounds = view.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Companion sounds"]')!
    expect(sounds.getAttribute('aria-checked')).toBe('true')

    await act(async () => { handlers['bloblex-sound-volume-changed']({ payload: { volume: 0.6, preview: true } }); await settleMicrotasks() })
    expect(slider.value).toBe('60')
    expect(vi.mocked(setCompanionSoundVolume)).toHaveBeenLastCalledWith(0.6)
    expect(blips()).toBe(navigationBlips + 1)
    expect(sounds.getAttribute('aria-checked')).toBe('true')
    expect(volumeSaves()).toHaveLength(0)
  })

  it('treats a missing or invalid saved volume as the 80% default', async () => {
    const { view } = await openSettings({ 'companion.soundVolume': 'loud' })
    expect(view.host.querySelector<HTMLInputElement>('input[aria-label="Companion sound volume"]')!.value).toBe('80')
  })

  it('chooses teammates in the panel and persists them through the same pinned list', async () => {
    const ops = agent({ id: 'agent-ops', name: 'Ops', color: '#7fd1a0', runtimeId: 'runtime-claude', sortOrder: 1 })
    const docs = agent({ id: 'agent-docs', name: 'Docs', color: '#d1a07f', runtimeId: 'runtime-codex', sortOrder: 2 })
    const { view } = await openSettings({}, snapshot({ agents: [claude, codex, ops, docs] }))
    const panel = view.host.querySelector('.companion-settings-view')!
    expect(radio(panel, 'Picked for you').getAttribute('aria-checked')).toBe('true')
    const chipNames = () => [...panel.querySelectorAll('.cset-chip')].map((chip) => chip.textContent)
    expect(chipNames().sort()).toEqual(['Codex', 'Docs', 'Ops'])

    await act(async () => { radio(panel, 'Choose myself').click(); await settleMicrotasks() })
    expect(pinSaves()).toHaveLength(1)
    expect((pinSaves()[0] as string[]).sort()).toEqual(['agent-codex', 'agent-docs', 'agent-ops'])
    const boxes = () => [...panel.querySelectorAll<HTMLButtonElement>('.cset-check')]
    expect(boxes()).toHaveLength(3)
    expect(boxes().every((box) => box.getAttribute('aria-checked') === 'true')).toBe(true)

    // Unchecking two keeps one on the island, and the overview then shows exactly that teammate.
    const named = (name: string) => boxes().find((box) => box.textContent?.startsWith(name))!
    await act(async () => { named('Codex').click(); await settleMicrotasks() })
    await act(async () => { named('Docs').click(); await settleMicrotasks() })
    expect(pinSaves().at(-1)).toEqual(['agent-ops'])
    expect(chipNames()).toEqual(['Ops'])
    await press(view.host, 'Home')
    await view.settle()
    expect([...view.host.querySelectorAll('.peer')].map((peer) => peer.getAttribute('aria-label')?.split(':')[0])).toEqual(['Ops', 'Codex', 'Docs'])

    await press(view.host, 'Settings')
    await view.settle()
    await act(async () => { radio(view.host, 'Picked for you').click(); await settleMicrotasks() })
    expect(pinSaves().at(-1)).toEqual([])
  })
})

describe('companion first-run drag hint', () => {
  it('shows the drag hint once and forgets it after Got it', async () => {
    hydrateHints([])
    const view = startApp('?companion=1')
    await view.settle()
    await press(view.host, 'Open companion home')
    await view.settle()
    const hint = view.host.querySelector('.companion-hint')!
    expect(hint.textContent).toContain('Drag me anywhere. Ctrl+Alt+B shows or hides me.')
    await act(async () => { [...hint.querySelectorAll('button')].find((button) => button.textContent === 'Got it')!.click(); await settleMicrotasks() })
    expect(view.host.querySelector('.companion-hint')).toBeNull()
    // A second mount in the same window does not bring it back.
    await press(view.host, 'Home')
    await view.settle()
    expect(view.host.querySelector('.companion-hint')).toBeNull()
  })
})
