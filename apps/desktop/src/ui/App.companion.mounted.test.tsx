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

vi.mock('../tauri', () => ({
  inDesktop: true,
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
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: h.directListen, emit: h.emit }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: h.getCurrentWindow }))
vi.mock('../blob/soundCues', () => ({
  playCompanionCue: vi.fn(), unlockCompanionAudioFromGesture: vi.fn(),
  setCompanionSoundsEnabled: vi.fn(), disposeCompanionAudio: vi.fn(),
}))
vi.mock('../blob/BlobCanvas', async () => {
  const ReactModule = await import('react')
  return {
    BlobCanvas: (props: Record<string, unknown>) => ReactModule.createElement(
      'canvas',
      {
        className: 'blob-canvas',
        role: 'img',
        'aria-label': `${String(props.label ?? 'Agent')} ${String(props.mood ?? 'idle')}`,
        width: typeof props.size === 'number' ? props.size : 52,
        height: typeof props.size === 'number' ? props.size : 52,
      },
      props.greeting ? ReactModule.createElement('button', { type: 'button', 'aria-label': 'Complete greeting fixture', onClick: props.onGreetingComplete }, 'finish') : null,
    ),
  }
})

import { App } from './App'
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
  it('marks every non-interactive companion target in welcome, compact, home, chat, activity, settings, and approval', async () => {
    const view = startApp('?companion=1')
    await view.settle()
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('coucou')
    const welcomeFace = view.host.querySelector('.companion-welcome canvas.blob-canvas')
    expect(resolvesToDrag(welcomeFace), 'welcome face').toBe(true)
    assertIsland(view.host, 'coucou')

    await press(view.host, 'Complete greeting fixture')
    await act(async () => { await vi.advanceTimersByTimeAsync(700); await settleMicrotasks() })
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
    const pills = [...view.host.querySelectorAll('.pill')]
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
    expect(resolvesToDrag(view.host.querySelector('.companion-activity-row')), 'activity row').toBe(true)
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
    expect(resolvesToDrag(approval.host.querySelector('.island-card .title')), 'permission title').toBe(true)
    expect(resolvesToDrag(approval.host.querySelector('.card-bot canvas.blob-canvas')), 'permission face').toBe(true)
    assertIsland(approval.host, 'approval')
  })

  it('labels daemon-wide tokens and cost as totals beside a blob and keeps unknown cost unknown', async () => {
    const companion = startApp('?companion=1')
    await companion.settle()
    await press(companion.host, 'Complete greeting fixture')
    await act(async () => { await vi.advanceTimersByTimeAsync(700); await settleMicrotasks() })
    await press(companion.host, 'Open companion home')
    await companion.settle()
    const glance = companion.host.querySelector('.glance')
    expect(glance?.textContent?.replace(/\s+/g, ' ')).toContain('All blobs: Tokens')
    expect(glance?.textContent).toContain('Cost')
    expect(glance?.getAttribute('title')).toContain('Totals across all blobs')
    const figures = [...(glance?.querySelectorAll('b') ?? [])].map((node) => node.textContent)
    const tokens = new Intl.NumberFormat(undefined, { notation: 'standard', maximumFractionDigits: 1 }).format(150)
    expect(figures).toEqual([tokens, 'Unknown'])
    expect(figures).not.toContain('0')
    expect(glance?.textContent).not.toMatch(/\$0|£0|€0/)

    const main = startApp()
    await main.settle()
    expect(main.host.querySelector('.context-pane h2')?.textContent).toBe('Claude')
    expect(main.host.querySelector('.usage-section .usage-scope')?.textContent).toBe('Total across all blobs · all time')
    const grid = main.host.querySelector('.details-usage-grid')
    expect(grid?.textContent).toContain('Total input tokens')
    expect(grid?.textContent).toContain('Total output tokens')
    expect(grid?.textContent).toContain('Total provider actual')
    expect(grid?.textContent).toContain('Total API estimate')
    expect(grid?.textContent).toContain('100')
    expect(grid?.textContent).toContain('50')
    const costs = [...(grid?.querySelectorAll('strong') ?? [])].map((node) => node.textContent)
    expect(costs).toEqual(['100', '50', 'Unknown', 'Unknown'])
    expect(grid?.textContent).not.toMatch(/\$0|£0|€0/)
  })
})
