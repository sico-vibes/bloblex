// @vitest-environment happy-dom
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
  getCurrentWindow: vi.fn(), openProjectFolder: vi.fn(), stagePromptAttachment: vi.fn(),
  daemonEventHandlers: [] as Array<(event: any) => void>,
  nextGetName: 'Claude',
  claudeArchived: false,
  holdGets: false,
  heldGets: new Map<string, () => void>(),
  getOverrides: {} as Record<string, { name?: string; color?: string }>,
  createError: null as string | null,
  updateError: null as string | null,
  sessionError: null as string | null,
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
  openProjectFolder: h.openProjectFolder,
  stagePromptAttachment: h.stagePromptAttachment,
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
      'data-testid': 'blob-canvas',
      'data-color': props.color,
      'data-label': props.label,
      'aria-label': props.decorative ? undefined : `${String(props.label ?? 'Agent')}, ${String(props.mood ?? 'idle')}`,
    }, props.greeting ? ReactModule.createElement('button', { type: 'button', 'aria-label': 'Complete greeting fixture', onClick: props.onGreetingComplete }, 'finish') : null),
  }
})

import { App } from './App'
import { setThemeStyle } from '../blob/bitbots'
import { friendlyErrorText } from './errorCopy'
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

const claudeRuntime = runtime({ id: 'runtime-claude', provider: 'claude', version: '2.1.286' })
const codexRuntime = runtime({ id: 'runtime-codex', provider: 'codex', version: 'codex-cli 0.159.3' })
const opencodeRuntime = runtime({ id: 'runtime-opencode', provider: 'opencode', version: '1.18.34' })
const claude = agent({ id: 'agent-claude', name: 'Claude', color: '#f38c6f', runtimeId: 'runtime-claude', sortOrder: 0, description: 'Default agent for Claude.' })
const codex = agent({ id: 'agent-codex', name: 'Codex', color: '#82aaff', runtimeId: 'runtime-codex', sortOrder: 0, createdAt: '2026-10-01T00:00:01.000Z' })
const invoice = agent({ id: 'agent-invoice', name: 'Invoice helper', color: 'lemon', runtimeId: 'runtime-codex', sortOrder: 1, createdAt: '2026-10-01T00:00:02.000Z' })
const opencode = agent({ id: 'agent-opencode', name: 'OpenCode', color: 'violet', runtimeId: 'runtime-opencode', sortOrder: 0, createdAt: '2026-10-01T00:00:03.000Z' })
const retired = agent({ id: 'agent-old', name: 'Retired', color: 'pink', runtimeId: 'runtime-codex', sortOrder: 2, archived: true })
const sessions = [
  session({ id: 'session-codex', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Invoice parser tests', updatedAt: '2026-10-02T01:00:00.000Z' }),
  session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Landing page copy', updatedAt: '2026-10-01T12:00:00.000Z' }),
  session({ id: 'session-opencode', runtimeId: 'runtime-opencode', agentId: 'agent-opencode', title: 'Refactor auth' }),
  session({ id: 'session-legacy', runtimeId: 'runtime-codex', agentId: null, title: 'Untied notes' }),
]

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    sequence: 20,
    runtimes: [claudeRuntime, codexRuntime, opencodeRuntime],
    agents: [claude, codex, invoice, opencode, retired],
    sessions,
    permissions: [],
    usage: [],
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
  h.openProjectFolder.mockResolvedValue('C:/work/site')
  h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'events.replay') return { replayAvailable: true, events: [] }
    if (method === 'settings.get') return { settings: {} }
    if (method === 'agent.get') {
      const source = [claude, codex, invoice, opencode, retired].find((item) => item.id === params.agentId) ?? claude
      const override = h.getOverrides[String(params.agentId)]
      const next = { ...source, name: override?.name ?? (params.agentId === 'agent-claude' ? h.nextGetName : source.name), color: override?.color ?? source.color, archived: params.agentId === 'agent-claude' ? h.claudeArchived : source.archived }
      if (h.holdGets) return await new Promise((resolve) => { h.heldGets.set(String(params.agentId), () => resolve({ agent: next })) })
      return { agent: next }
    }
    if (method === 'agent.create') {
      if (h.createError) throw new Error(h.createError)
      const created = agent({
        id: 'agent-copy',
        name: String(params.name),
        color: String(params.color),
        runtimeId: String(params.runtimeId),
        sortOrder: 9,
        description: String(params.description ?? ''),
        instructions: String(params.instructions ?? ''),
        model: (params.model as string | null | undefined) ?? null,
        thinking: (params.thinking as string | null | undefined) ?? null,
        serviceTier: (params.serviceTier as string | null | undefined) ?? null,
        customArgs: Array.isArray(params.customArgs) ? params.customArgs as string[] : [],
        customEnv: (params.customEnv as Record<string, string> | undefined) ?? {},
        maxConcurrency: typeof params.maxConcurrency === 'number' ? params.maxConcurrency : 1,
        defaultProject: typeof params.defaultProject === 'string' ? params.defaultProject : null,
      })
      return { agent: created }
    }
    if (method === 'agent.update') {
      if (h.updateError) throw new Error(h.updateError)
      return { agent: { ...claude, name: String(params.name ?? claude.name) } }
    }
    if (method === 'runtime.models') {
      const runtimeId = String(params.runtimeId ?? '')
      const provider = runtimeId === 'runtime-codex' ? 'codex' : runtimeId === 'runtime-opencode' ? 'opencode' : 'claude'
      const id = provider === 'claude' ? 'claude-sonnet-5-5' : provider === 'codex' ? 'gpt-6-luna' : 'opencode/big-pickle'
      return { runtimeId, provider, validated:true, fallback:false, models:[{ id, displayName:id, supportedThinking:['low','medium','high'], defaultThinking:'medium', serviceTiers:[], defaultServiceTier:null }] }
    }
    if (method === 'agent.delete') return { agent: { ...claude, archived: true } }
    if (method === 'session.new') {
      if (h.sessionError) throw new Error(h.sessionError)
      return { session: { id: 'session-made', runtimeId: 'runtime-claude', agentId: params.agentId, title: 'New chat', projectPath: params.projectPath, state: 'idle', messages: [] } }
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
  h.nextGetName = 'Claude'
  h.claudeArchived = false
  h.holdGets = false
  h.heldGets.clear()
  h.getOverrides = {}
  h.createError = null
  h.updateError = null
  h.sessionError = null
  for (const mock of Object.values(h)) if (typeof mock === 'function' && 'mockReset' in mock) (mock as ReturnType<typeof vi.fn>).mockReset()
  // The blob look editor is the classic (Blobots) one here; Bitbots is tested elsewhere.
  setThemeStyle('blobots')
  configure()
})

afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
  sessionStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

function rows(host: ParentNode) {
  return [...host.querySelectorAll<HTMLButtonElement>('.bot-row')]
}

function buttonNamed(root: ParentNode, name: string) {
  return [...root.querySelectorAll('button')].find((button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim() === name || button.getAttribute('aria-label') === name)
}

function menuItem(root: ParentNode, name: string) {
  return [...root.querySelectorAll('[role="menuitem"]')].find((item) => (item.textContent ?? '').replace(/\s+/g, ' ').trim() === name)
}


function field(root: ParentNode, label: string) {
  const match = [...root.querySelectorAll('label')].find((node) => (node.textContent ?? '').includes(label))
  return match?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select') ?? null
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error('missing element')
  await act(async () => { (element as HTMLElement).click() })
}

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!element) throw new Error('missing field')
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(element: Element, key: string, extra: KeyboardEventInit = {}) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra })) })
}

async function openMenu(row: HTMLButtonElement) {
  await press(row, 'F10', { shiftKey: true })
}

function emit(event: DaemonEvent) {
  // Every live listener hears the event, as with the real event bus: App is not the only one.
  const handlers = [...h.daemonEventHandlers]
  if (!handlers.length) throw new Error('no daemon listener')
  for (const handler of handlers) handler(event)
}

/** Opens the side conversation from the first assignment card, expanding it when it is folded. */
async function openAssignment(host: HTMLElement) {
  const head = host.querySelector<HTMLButtonElement>('.delegation-group .delegation-head')
  if (!head) throw new Error('no assignment card')
  if (head.getAttribute('aria-expanded') !== 'true') await click(head)
  await click(host.querySelector('.delegation-group .delegation-open'))
}

describe('blob roster and editor', () => {
  it('sets up the Manager from onboarding with the detected runtime id and Ask approval', async () => {
    configure(snapshot({ runtimes: [codexRuntime], agents: [], sessions: [] }))
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('.look-orb-choice[data-look="blobots"]'))
    await click(buttonNamed(view.host, 'Continue'))
    await click(buttonNamed(view.host, 'Skip'))
    expect(view.host.querySelector('[data-provider="codex"]')).not.toBeNull()
    await click(buttonNamed(view.host, 'Continue'))
    await view.settle()
    const nameField = view.host.querySelector<HTMLInputElement>('.onboarding-field input')
    await typeInto(nameField, 'Codex')
    await click(buttonNamed(view.host, 'Create Manager'))
    await view.settle()
    const create = h.rpc.mock.calls.find(([method]) => method === 'manager.ensure')
    expect(create?.[1]).toMatchObject({ name: 'Codex', runtimeId: 'runtime-codex', color: 'violet', approvalMode: 'bypass' })
  })

  it('keeps an existing session-only workspace in the shell instead of auto-opening onboarding', async () => {
    const oldSession = session({ id: 'legacy-session', runtimeId: codexRuntime.id, title: 'Earlier conversation' })
    configure(snapshot({ runtimes: [codexRuntime], agents: [], sessions: [oldSession] }))
    const view = startApp()
    await view.settle()
    expect(view.host.querySelector('.onboarding-screen')).toBeNull()
    expect(view.host.querySelector('.app-shell')).not.toBeNull()
  })

  it('renders active blobs in roster order and hides archived ones', async () => {
    const view = startApp()
    await view.settle()
    const names = rows(view.host).map((row) => row.querySelector('strong')?.textContent)
    expect(names).toEqual(['Claude', 'Codex', 'Invoice helper', 'OpenCode'])
    expect(view.host.textContent).not.toContain('Retired')
    expect(view.host.querySelector('nav[aria-label="Bots"]')).not.toBeNull()
    expect(rows(view.host)[0]?.getAttribute('aria-current')).toBe('true')
    expect(rows(view.host)[0]?.querySelector('[data-color]')?.getAttribute('data-color')).toBe('#F38C6F')
    expect(rows(view.host)[1]?.querySelector('[data-color]')?.getAttribute('data-color')).toBe('#82AAFF')
    const header = view.host.querySelector('.context-head [data-color]')
    expect(header?.getAttribute('data-color')).toBe('#F38C6F')
    expect(header?.getAttribute('data-color')).not.toBe('#82aaff')
  })

  it('paints the companion pill for the selected blob with that blob colour', async () => {
    const view = startApp('?companion=1')
    await view.settle()
    expect(view.host.querySelector('.compact-bot [data-color]')?.getAttribute('data-color')).toBe('#F38C6F')
    await click(buttonNamed(view.host, 'Open companion home'))
    await view.settle()
    // The focused blob owns the conversation header in its colour; every bot is listed on the left, the focused one marked.
    expect(view.host.querySelector('.cs-head [data-color]')?.getAttribute('data-color')).toBe('#F38C6F')
    const rows = [...view.host.querySelectorAll('.cs-bot')]
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.find((row) => row.getAttribute('aria-current') === 'true')?.textContent).toContain('Claude')
  })

  it('moves focus with Arrow Down and selects only on Enter', async () => {
    const view = startApp()
    await view.settle()
    const [first, second] = rows(view.host)
    first?.focus()
    await press(first!, 'ArrowDown')
    expect(document.activeElement).toBe(second)
    expect(first?.getAttribute('aria-current')).toBe('true')
    expect(second?.getAttribute('aria-current')).toBeNull()
    await press(second!, 'Enter')
    expect(second?.getAttribute('aria-current')).toBe('true')
    expect(first?.getAttribute('aria-current')).toBeNull()
    expect(view.host.querySelector('[aria-label="Edit Codex"]')).not.toBeNull()
  })

  it('shows every create validation message and the runtime not_found sentence', async () => {
    const view = startApp()
    await view.settle()
    await click(buttonNamed(view.host, 'Create bot'))
    await click(buttonNamed(view.host, 'Show all settings'))
    expect(view.host.textContent).toContain('Enter a name.')
    const save = [...view.host.querySelectorAll('button')].find((button) => button.classList.contains('primary-button') && button.textContent?.includes('Create bot'))
    // Create stays pressable: pressing it with a problem moves focus to the first invalid field.
    expect(save?.hasAttribute('disabled')).toBe(false)
    await click(save)
    expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-invalid')).toBe('true')
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'A'.repeat(61))
    expect(view.host.textContent).toContain('Use 60 characters or fewer for the name.')
    await typeInto(field(view.host, 'Description') as HTMLTextAreaElement, 'B'.repeat(256))
    expect(view.host.textContent).toContain('Use 255 characters or fewer for the description.')
    expect(view.host.textContent).toContain('256 / 255')
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Claude')
    await typeInto(field(view.host, 'Description') as HTMLTextAreaElement, 'ok')
    expect(view.host.textContent).toContain('Another bot already uses this name.')
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Fresh blob')
    await typeInto(view.host.querySelector('[aria-label="Instructions"]') as HTMLTextAreaElement, 'keep\0out')
    expect(view.host.textContent).toContain('Instructions cannot include a null character.')
    await typeInto(view.host.querySelector('[aria-label="Instructions"]') as HTMLTextAreaElement, 'Be brief')
    await click(buttonNamed(view.host, 'Choose a custom colour'))
    await typeInto(field(view.host, 'Custom colour') as HTMLInputElement, 'abc')
    expect(view.host.textContent).toContain('Enter a colour as #RRGGBB, or choose a swatch.')
    await click(buttonNamed(view.host, 'Mint'))
    expect(save?.hasAttribute('disabled')).toBe(false)
    h.createError = 'not_found: runtime missing'
    await click(save)
    await view.settle()
    expect(view.host.textContent).toContain('That runtime is no longer available. Refresh and choose another.')
    expect(field(view.host, 'Name')).toHaveProperty('value', 'Fresh blob')
    expect(rows(view.host).map((row) => row.querySelector('strong')?.textContent)).not.toContain('Fresh blob')
  })

  it('surfaces the remaining create daemon codes without clearing the draft', async () => {
    const view = startApp()
    await view.settle()
    await click(buttonNamed(view.host, 'Create bot'))
    await click(buttonNamed(view.host, 'Show all settings'))
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Fresh blob')
    const save = [...view.host.querySelectorAll('button')].find((button) => button.classList.contains('primary-button') && button.textContent?.includes('Create bot'))
    const cases: Array<[string, string]> = [
      ['conflict: taken', 'Another bot already uses this name.'],
      ['invalid_argument: bad', 'Check the name, description, colour, and runtime, then try again.'],
      ['internal: boom', 'Bitbots could not save that change. Nothing was applied.'],
      ['unauthorized: no', 'Bitbots could not reach the local daemon. Reconnect and try again.'],
      ['mystery: no', 'The local daemon request failed.'],
    ]
    for (const [error, message] of cases) {
      h.createError = error
      await click(save)
      await view.settle()
      expect(view.host.textContent).toContain(message)
      expect(field(view.host, 'Name')).toHaveProperty('value', 'Fresh blob')
    }
  })

  it('restores a cancelled edit and discards only after confirmation', async () => {
    const view = startApp()
    await view.settle()
    await openMenu(rows(view.host)[0]!)
    await click(buttonNamed(view.host, 'Edit bot'))
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Claude Prime')
    expect(buttonNamed(view.host, 'Discard')).toBeTruthy()
    expect(view.host.querySelector('.bot-savebar')?.textContent).toContain('1 change')
    await click(buttonNamed(view.host, 'Discard'))
    expect(view.host.querySelector('#blob-dialog-title')?.textContent).toBe('Discard these changes?')
    await click(view.host.querySelector('.blob-dialog .primary-button'))
    expect(field(view.host, 'Name')).toHaveProperty('value', 'Claude')
    expect(view.host.querySelector('.bot-savebar')).toBeNull()
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Claude Prime')
    await click(buttonNamed(view.host, 'Back'))
    expect(view.host.querySelector('#blob-dialog-title')?.textContent).toBe('Discard unsaved changes?')
    await view.settle()
    expect(document.activeElement?.textContent).toBe('Keep editing')
    await click(buttonNamed(view.host, 'Keep editing'))
    expect(view.host.querySelector('.blob-page')).not.toBeNull()
    expect(field(view.host, 'Name')).toHaveProperty('value', 'Claude Prime')
    await click(buttonNamed(view.host, 'Back'))
    await click(view.host.querySelector('.blob-dialog .primary-button'))
    expect(view.host.querySelector('.blob-page')).toBeNull()
    expect(view.host.querySelector('[aria-label="Edit Claude"]')).not.toBeNull()
  })

  it('keeps a rejected rename dirty and shows the daemon name conflict', async () => {
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('[aria-label="Edit Claude"]'))
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Claude Prime')
    h.updateError = 'conflict: name'
    await click(buttonNamed(view.host, 'Save changes'))
    await view.settle()
    expect(view.host.textContent).toContain('Another bot already uses this name.')
    expect(field(view.host, 'Name')).toHaveProperty('value', 'Claude Prime')
    const update = h.rpc.mock.calls.find((call) => call[0] === 'agent.update')
    expect(update?.[1]).toEqual({ agentId: 'agent-claude', name: 'Claude Prime' })
  })

  it('duplicates through agent.create with the copied execution fields', async () => {
    const view = startApp()
    await view.settle()
    await openMenu(rows(view.host)[0]!)
    await click(buttonNamed(view.host, 'Duplicate'))
    await view.settle()
    const create = h.rpc.mock.calls.find((call) => call[0] === 'agent.create')
    expect(create?.[1]).toStrictEqual({
      name: 'Copy of Claude', runtimeId: 'runtime-claude', description: 'Default agent for Claude.', instructions: '', color: '#f38c6f',
      look: { shape: 'circle', seed: 'agent-claude' }, model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, approvalMode: null,
    })
    expect(create?.[1]).not.toHaveProperty('archived')
    expect(rows(view.host).some((row) => row.textContent?.includes('Copy of Claude'))).toBe(true)
  })

  it('copies a chosen look on duplicate', async () => {
    const source = agent({ ...claude, look: { shape: 'cloud', seed: 'claude', traits: { 'sun.n': 0.2 } } })
    h.fetchSnapshot.mockResolvedValue(snapshot({ agents: [source, codex, invoice, opencode, retired] }))
    const view = startApp()
    await view.settle()
    await openMenu(rows(view.host)[0]!)
    await click(buttonNamed(view.host, 'Duplicate'))
    await view.settle()
    const create = h.rpc.mock.calls.find((call) => call[0] === 'agent.create')
    expect(create?.[1]).toStrictEqual({
      name: 'Copy of Claude', runtimeId: 'runtime-claude', description: 'Default agent for Claude.', instructions: '', color: '#f38c6f',
      look: { shape: 'cloud', seed: 'claude', traits: { 'sun.n': 0.2 } }, model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, approvalMode: null,
    })
  })

  it('stages a pasted image, sends its path with the prompt and clears the tray', async () => {
    h.stagePromptAttachment.mockResolvedValue('C:/data/attachments/one.png')
    const view = startApp()
    await view.settle()
    const textarea = view.host.querySelector<HTMLTextAreaElement>('.composer-box textarea')!
    const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type:'image/png' })
    const paste = new Event('paste', { bubbles:true, cancelable:true })
    Object.defineProperty(paste, 'clipboardData', { value:{ files:[image] } })
    await act(async () => { textarea.dispatchEvent(paste) })
    await view.settle()
    expect(paste.defaultPrevented).toBe(true)
    expect(h.stagePromptAttachment).toHaveBeenCalledOnce()
    expect(view.host.querySelector('.composer-attachment.ready img')?.getAttribute('alt')).toMatch(/^Pasted image/)
    const send = view.host.querySelector<HTMLButtonElement>('.send-button')!
    expect(send.disabled).toBe(false)
    await act(async () => { send.click() })
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('session.prompt', { clientMessageId: expect.stringMatching(/^m-/), sessionId:'session-claude', text:'', attachments:[{ path:'C:/data/attachments/one.png', name:expect.stringMatching(/^Pasted image/) }] })
    expect(view.host.querySelector('.composer-attachment')).toBeNull()
  })

  it('archives after confirmation and removes the row', async () => {
    const view = startApp()
    await view.settle()
    await openMenu(rows(view.host)[0]!)
    await click(buttonNamed(view.host, 'Archive'))
    const dialog = view.host.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Archive Claude?')
    // Phase 1: undo is on by default.
    expect(dialog?.textContent).toContain('It leaves the sidebar and companion. Its conversations stay saved. You can undo this for eight seconds.')
    expect(dialog?.querySelector('.blob-dialog-icon.warning')).not.toBeNull()
    await view.settle()
    expect(document.activeElement?.textContent).toBe('Keep it')
    await click(dialog?.querySelector('.primary-button') ?? null)
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('agent.delete', { agentId: 'agent-claude' })
    expect(rows(view.host).map((row) => row.querySelector('strong')?.textContent)).toEqual(['Codex', 'Invoice helper', 'OpenCode'])
    expect(rows(view.host)[0]?.getAttribute('aria-current')).toBe('true')
    expect(view.host.querySelector('[aria-live="polite"]')?.textContent).toContain('Archived Claude. Now showing Codex.')
  })

  it('selects a swatch, rejects a bad hex, and maps F0A0C4 to pink', async () => {
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('[aria-label="Edit Claude"]'))
    expect(buttonNamed(view.host, 'Coral, selected')?.getAttribute('aria-pressed')).toBe('true')
    await click(buttonNamed(view.host, 'Pink'))
    expect(buttonNamed(view.host, 'Pink, selected')?.getAttribute('aria-pressed')).toBe('true')
    expect(buttonNamed(view.host, 'Coral')?.getAttribute('aria-pressed')).toBe('false')
    await click(buttonNamed(view.host, 'Choose a custom colour'))
    await typeInto(field(view.host, 'Custom colour') as HTMLInputElement, 'abc')
    expect(view.host.querySelector('#custom-colour-error')?.textContent).toBe('Enter a colour as #RRGGBB, or choose a swatch.')
    await typeInto(field(view.host, 'Custom colour') as HTMLInputElement, 'F0A0C4')
    expect(buttonNamed(view.host, 'Pink, selected')?.getAttribute('aria-pressed')).toBe('true')
    expect(view.host.querySelector('#custom-colour-error')).toBeNull()
  })

  it('applies a newer agent.changed name and ignores a stale event', async () => {
    const view = startApp()
    await view.settle()
    h.nextGetName = 'Stale name'
    await act(async () => { emit({ type: 'agent.changed', sequence: 20, payload: { agentId: 'agent-claude', runtimeId: 'runtime-claude', updatedAt: stamp, archived: false, sortOrder: 0 } }); await settleMicrotasks() })
    await view.settle()
    expect(rows(view.host)[0]?.querySelector('strong')?.textContent).toBe('Claude')
    h.nextGetName = 'Claude renamed'
    await act(async () => { emit({ type: 'agent.changed', sequence: 21, payload: { agentId: 'agent-claude', runtimeId: 'runtime-claude', updatedAt: '2026-10-02T00:00:00.000Z', archived: false, sortOrder: 0 } }); await settleMicrotasks() })
    await view.settle()
    expect(rows(view.host)[0]?.querySelector('strong')?.textContent).toBe('Claude renamed')
    expect(view.host.querySelector('[aria-label="Edit Claude renamed"]')).not.toBeNull()
  })

  it('moves selection when the selected blob is archived by an event', async () => {
    const view = startApp()
    await view.settle()
    h.nextGetName = 'Claude'
    h.claudeArchived = true
    await act(async () => {
      emit({ type: 'agent.changed', sequence: 21, payload: { agentId: 'agent-claude', runtimeId: 'runtime-claude', updatedAt: stamp, archived: true, sortOrder: 0 } })
      await settleMicrotasks()
    })
    await view.settle()
    expect(rows(view.host).map((row) => row.querySelector('strong')?.textContent)).toEqual(['Codex', 'Invoice helper', 'OpenCode'])
    expect(rows(view.host)[0]?.getAttribute('aria-current')).toBe('true')
    expect(view.host.querySelector('[aria-live="polite"]')?.textContent).toContain('Archived Claude. Now showing Codex.')
  })

  it('shows Runtime offline on Codex and disables New conversation', async () => {
    h.fetchSnapshot.mockResolvedValue(snapshot({
      runtimes: [claudeRuntime, { ...codexRuntime, status: 'offline' }, opencodeRuntime],
    }))
    const view = startApp()
    await view.settle()
    const codexRow = rows(view.host)[1]
    expect(codexRow?.textContent).toContain('Runtime offline')
    await click(codexRow!)
    expect(buttonNamed(view.host, 'New conversation')?.hasAttribute('disabled')).toBe(true)
  })
  it('shows recovery guidance instead of Ready in an empty chat when its runtime failed the protocol check', async () => {
    const failedRuntime = { ...opencodeRuntime, status:'error', probeStep:'Protocol check', probeError:'The CLI does not advertise the required protocol.' }
    const empty = session({ id:'session-opencode-empty', runtimeId:failedRuntime.id, agentId:opencode.id, title:'OpenCode', messages:[] })
    configure(snapshot({ runtimes:[claudeRuntime, codexRuntime, failedRuntime], sessions:[empty] }))
    h.getActiveSession.mockResolvedValue(empty.id)
    h.getActiveRuntime.mockResolvedValue(failedRuntime.id)
    vi.mocked(localStorage.getItem).mockImplementation((key) => key === 'bloblex.selectedAgentId' ? opencode.id : null)
    const view = startApp(); await view.settle()
    expect(view.host.querySelector('.session-first-state h2')?.textContent).toContain('needs attention')
    expect(view.host.querySelector('.session-first-state')?.textContent).toContain('Update or repair this CLI')
    expect(view.host.querySelector('.session-first-state')?.textContent).not.toContain('Ready when you are')
    expect(view.host.querySelector<HTMLTextAreaElement>('.composer-box textarea')?.disabled).toBe(true)
    expect(view.host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true)
  })

  it('shows no starter suggestions in an empty conversation', async () => {
    configure()
    const view = startApp()
    await view.settle()
    expect(view.host.querySelector('.session-first-state')?.textContent).toContain('Ready when you are')
    expect(view.host.querySelector('.session-starters')).toBeNull()
  })

  it('announces each roster avatar with its name and state', async () => {
    h.fetchSnapshot.mockResolvedValue(snapshot({ runtimes: [{ ...claudeRuntime, status: 'offline' }, codexRuntime, opencodeRuntime] }))
    const view = startApp()
    await view.settle()
    const row = rows(view.host).find((item) => item.querySelector('strong')?.textContent === 'Claude')!
    expect(row.querySelector('.team-row-avatar [data-testid="blob-canvas"]')?.getAttribute('aria-label')).toBe('Claude, offline')
  })

  it('keeps a dirty edit when Escape is pressed on the discard dialog', async () => {
    const view = startApp()
    await view.settle()
    await openMenu(rows(view.host)[0]!)
    await click(buttonNamed(view.host, 'Edit bot'))
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Claude Prime')
    await click(buttonNamed(view.host, 'Back'))
    expect(view.host.querySelector('#blob-dialog-title')?.textContent).toBe('Discard unsaved changes?')
    await view.settle()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await view.settle()
    expect(view.host.querySelector('#blob-dialog-title')).toBeNull()
    expect(view.host.querySelector('.blob-page')).not.toBeNull()
    expect(field(view.host, 'Name')).toHaveProperty('value', 'Claude Prime')
    expect(document.activeElement).toBe(buttonNamed(view.host, 'Back'))
  })

  it('leaves the blob active when Escape is pressed on the archive dialog', async () => {
    const view = startApp()
    await view.settle()
    await openMenu(rows(view.host)[0]!)
    await click(buttonNamed(view.host, 'Archive'))
    expect(view.host.querySelector('#blob-dialog-title')?.textContent).toBe('Archive Claude?')
    await view.settle()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await view.settle()
    expect(h.rpc.mock.calls.filter((call) => call[0] === 'agent.delete')).toHaveLength(0)
    expect(rows(view.host).map((row) => row.querySelector('strong')?.textContent)).toContain('Claude')
    expect(rows(view.host)[0]?.getAttribute('aria-current')).toBe('true')
    expect(rows(view.host)[0]?.getAttribute('data-agent-id')).toBe('agent-claude')
  })

  it('restores the agent stored in bloblex.selectedAgentId', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => key === 'bloblex.selectedAgentId' ? 'agent-codex' : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    })
    const view = startApp()
    await view.settle()
    const current = rows(view.host).find((row) => row.getAttribute('aria-current') === 'true')
    expect(current?.getAttribute('data-agent-id')).toBe('agent-codex')
    expect(current?.querySelector('strong')?.textContent).toBe('Codex')
    expect(view.host.querySelector('[aria-label="Edit Codex"]')).not.toBeNull()
  })

  it('still selects the first active agent when localStorage.getItem throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage blocked') },
      setItem: () => { throw new Error('storage blocked') },
      removeItem: () => { throw new Error('storage blocked') },
      clear: () => { throw new Error('storage blocked') },
    })
    const view = startApp()
    await view.settle()
    expect(rows(view.host).map((row) => row.querySelector('strong')?.textContent)).toEqual(['Claude', 'Codex', 'Invoice helper', 'OpenCode'])
    expect(rows(view.host)[0]?.getAttribute('aria-current')).toBe('true')
    expect(rows(view.host)[0]?.getAttribute('data-agent-id')).toBe('agent-claude')
  })

  it('applies both agent.get results when two agent.changed events resolve out of order', async () => {
    const view = startApp()
    await view.settle()
    h.holdGets = true
    h.getOverrides = {
      'agent-claude': { name: 'Claude full', color: 'sky' },
      'agent-codex': { name: 'Codex full', color: 'pink' },
    }
    await act(async () => {
      emit({ type: 'agent.changed', sequence: 21, payload: { agentId: 'agent-claude', runtimeId: 'runtime-claude', updatedAt: stamp, archived: false, sortOrder: 0 } })
      emit({ type: 'agent.changed', sequence: 22, payload: { agentId: 'agent-codex', runtimeId: 'runtime-codex', updatedAt: stamp, archived: false, sortOrder: 0 } })
      await settleMicrotasks()
    })
    const releaseCodex = h.heldGets.get('agent-codex')
    const releaseClaude = h.heldGets.get('agent-claude')
    expect(releaseCodex).toBeTypeOf('function')
    expect(releaseClaude).toBeTypeOf('function')
    await act(async () => { releaseCodex?.(); await settleMicrotasks() })
    await act(async () => { releaseClaude?.(); await settleMicrotasks() })
    await view.settle()
    const claudeRow = rows(view.host).find((row) => row.getAttribute('data-agent-id') === 'agent-claude')
    const codexRow = rows(view.host).find((row) => row.getAttribute('data-agent-id') === 'agent-codex')
    expect(claudeRow?.querySelector('strong')?.textContent).toBe('Claude full')
    expect(claudeRow?.querySelector('[data-color]')?.getAttribute('data-color')).toBe('#7EB6F0')
    expect(codexRow?.querySelector('strong')?.textContent).toBe('Codex full')
    expect(codexRow?.querySelector('[data-color]')?.getAttribute('data-color')).toBe('#F0A0C4')
  })

  it('focuses the new roster row after a created blob page is closed', async () => {
    const view = startApp()
    await view.settle()
    await click(buttonNamed(view.host, 'Create bot'))
    await click(buttonNamed(view.host, 'Show all settings'))
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Fresh blob')
    const save = [...view.host.querySelectorAll('button')].find((button) => button.classList.contains('primary-button') && button.textContent?.includes('Create bot'))
    await click(save)
    await view.settle()
    expect(view.host.querySelector('.blob-page-heading')?.textContent).toBe('Fresh blob')
    await click(buttonNamed(view.host, 'Back'))
    await view.settle()
    expect(view.host.querySelector('.blob-page')).toBeNull()
    expect(document.activeElement).toBe(view.host.querySelector('[data-agent-id="agent-copy"]'))
    expect(document.activeElement?.textContent).toContain('Fresh blob')
  })

  it('omits archived agents and their conversations from the tree', async () => {
    h.fetchSnapshot.mockResolvedValue(snapshot({
      sessions: [...sessions, session({ id: 'session-retired', runtimeId: 'runtime-codex', agentId: 'agent-old', title: 'Archived chat', projectPath: 'C:\\old\\repo' })],
    }))
    const view = startApp()
    await view.settle()
    expect(view.host.textContent).not.toContain('Archived chat')
    expect(view.host.textContent).not.toContain('Retired')
    const codex = rows(view.host)[1]!
    codex.focus()
    await press(codex, 'ArrowRight')
    const other = view.host.querySelector<HTMLElement>('[aria-label="Other sessions"]')
    if (other) { other.focus(); await press(other, 'Enter') }
    expect(view.host.textContent).not.toContain('Archived chat')
  })

  it('leaves composer Arrow Down and letters on the textarea', async () => {
    const view = startApp()
    await view.settle()
    const composer = view.host.querySelector<HTMLTextAreaElement>('textarea')
    composer?.focus()
    await press(composer!, 'ArrowDown')
    await press(composer!, 'c')
    expect(document.activeElement).toBe(composer)
    expect(rows(view.host)[0]?.getAttribute('aria-current')).toBe('true')
  })

  // ── Team: projects, leader, side conversations, plans and questions ──
  const board = { id: 'project-board', name: 'Board', path: 'C:/work/site', sortOrder: 0, collapsed: false }
  const withRpc = (handler: (method: string, params: Record<string, unknown>) => unknown) => {
    const base = h.rpc.getMockImplementation()
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      const handled = await handler(method, params)
      return handled === undefined ? base?.(method, params) : handled
    })
  }

  it('lists bots in one roster (Phase 1A) and pins the Manager above them', async () => {
    const manager = { ...opencode, id: 'agent-manager', name: 'Manager', role: 'Manager', systemRole: 'manager' as const, projectId: null }
    configure(snapshot({ projects: [board], agents: [{ ...claude, projectId: board.id, role: 'CTO', leader: true }, codex, invoice, opencode, manager, retired] }))
    const view = startApp()
    await view.settle()
    const groups = [...view.host.querySelectorAll('.team-group')].map((group) => group.getAttribute('aria-label'))
    expect(groups).toEqual(['Manager', 'Bots'])
    // An old team leader is an ordinary bot now.
    const formerLeader = view.host.querySelector('.team-row[data-agent-id="agent-claude"]')!
    expect(formerLeader.getAttribute('aria-label')).toBe('Claude, CTO')
    expect(formerLeader.querySelector('.leader-badge')).toBeNull()
    expect(formerLeader.querySelector('.role-chip')?.textContent).toBe('CTO')
    const managerRow = view.host.querySelector('.manager-group .team-row[data-agent-id="agent-manager"]')!
    expect(managerRow.getAttribute('aria-label')).toBe('Manager, Manager, Manager')
    expect(managerRow.querySelector('.leader-badge')).not.toBeNull()
    expect(managerRow.querySelector('.leader-badge svg[fill="currentColor"]')).not.toBeNull()
    expect([...view.host.querySelectorAll('.team-group[aria-label="Bots"] .team-row strong')].map((node) => node.textContent)).toEqual(['Claude', 'Codex', 'Invoice helper', 'OpenCode'])
  })

  it('starts a new project in the Manager conversation with a starter message to edit', async () => {
    const manager = { ...opencode, id: 'agent-manager', name: 'Max', role: 'Manager', systemRole: 'manager' as const, projectId: null }
    configure(snapshot({ projects: [board], agents: [claude, codex, manager], sessions: [...sessions, session({ id: 'session-manager', runtimeId: opencode.runtimeId, agentId: 'agent-manager', title: 'Planning' })] }))
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"][aria-label$=" actions"][title^="Import"]')!)
    expect(menuItem(view.host, 'Import project folder…')).toBeTruthy()
    await click(menuItem(view.host, 'New project with Max'))
    await view.settle()
    const composer = view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Max"]')!
    expect(composer.value).toContain('I want to start a new project.')
    expect(h.rpc.mock.calls.some(([method]) => method === 'project.create')).toBe(false)
  })

  it('pins and unpins a blob from its context menu', async () => {
    const view = startApp()
    await view.settle()
    await openMenu(rows(view.host)[1]!)
    expect(view.host.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Codex actions')
    await click(menuItem(view.host, 'Pin'))
    expect([...view.host.querySelectorAll('.team-group[aria-label="Pinned"] .team-row strong')].map((node) => node.textContent)).toEqual(['Codex'])
    await openMenu(view.host.querySelector<HTMLButtonElement>('.team-group[aria-label="Pinned"] .team-row')!)
    await click(menuItem(view.host, 'Unpin'))
    expect(view.host.querySelector('.team-group[aria-label="Pinned"]')).toBeNull()
  })

  it('sets a bot’s default project from the Default project submenu', async () => {
    configure(snapshot({ projects: [board] }))
    withRpc((method, params) => {
      if (method !== 'agent.team.update') return undefined
      h.fetchSnapshot.mockResolvedValue(snapshot({ projects: [board], agents: [claude, { ...codex, projectId: params.projectId as string }, invoice, opencode, retired] }))
      return { agent: { ...codex, projectId: params.projectId } }
    })
    const view = startApp()
    await view.settle()
    await openMenu(view.host.querySelector<HTMLButtonElement>('.team-row[data-agent-id="agent-codex"]')!)
    await click(menuItem(view.host, 'Default project'))
    const target = [...view.host.querySelectorAll<HTMLButtonElement>('.team-submenu [role="menuitemradio"]')].find((item) => item.textContent?.includes('Board'))
    await click(target)
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('agent.team.update', { agentId: 'agent-codex', projectId: 'project-board' })
    // The bot stays in the one roster; the submenu now marks Board as where its conversations start.
    await openMenu(view.host.querySelector<HTMLButtonElement>('.team-row[data-agent-id="agent-codex"]')!)
    await click(menuItem(view.host, 'Default project'))
    const checked = [...view.host.querySelectorAll<HTMLButtonElement>('.team-submenu [role="menuitemradio"][aria-checked="true"]')].map((item) => item.textContent)
    expect(checked).toEqual(['Board'])
  })

  it('opens the quick switcher from the only sidebar search control and searches bots there', async () => {
    configure(snapshot({ agents: [{ ...claude, role: 'Copywriter' }, codex, invoice, opencode, retired] }))
    const view = startApp()
    await view.settle()
    expect(view.host.querySelector('.sidebar-create-actions [aria-label="Open quick switcher"]')).toBeNull()
    const search = view.host.querySelector<HTMLButtonElement>('button.sidebar-search')!
    expect(search?.textContent).toContain('Ctrl K')
    await click(search)
    await view.settle()
    const input = view.host.querySelector<HTMLInputElement>('.quick-switcher input')!
    expect(document.activeElement).toBe(input)
    await typeInto(input, 'invoice')
    expect(view.host.querySelector('.quick-switcher [data-result-id="agent-invoice"]')?.textContent).toContain('Invoice helper')
    expect(rows(view.host)).toHaveLength(4)
    await press(input, 'Escape')
    await view.settle()
    expect(view.host.querySelector('.quick-switcher')).toBeNull()
    await press(search, 'k', { ctrlKey: true })
    await view.settle()
    expect(view.host.querySelector('.quick-switcher')).not.toBeNull()
  })

  it.each([{ agents: [] }, { agents: [claude] }])('shows Manager setup with zero or existing bots despite an earlier Later ($agents.length bots)', async ({ agents }) => {
    sessionStorage.setItem('bitbots.managerSetup.later', '1')
    localStorage.getItem = vi.fn((key: string) => key === 'bloblex.firstRun.complete' ? '1' : null)
    configure(snapshot({ agents, sessions: [] }))
    const view = startApp()
    await view.settle()
    expect(view.host.querySelector('.manager-setup')?.textContent).toContain('Meet your Manager')
    expect(view.host.querySelector('.manager-setup [aria-label="Later"]')).toBeNull()
  })

  it('opens a blob without a conversation into a local draft, then stores it on the first message', async () => {
    const created = session({ id: 'session-invoice', runtimeId: 'runtime-codex', agentId: 'agent-invoice', title: 'New chat', updatedAt: '2026-10-02T02:00:00.000Z', messages: [] })
    withRpc((method) => method === 'agent.conversation.create' ? { session: created } : undefined)
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('.team-row[data-agent-id="agent-invoice"]'))
    await view.settle()
    // A draft: the composer is ready, nothing has been stored yet.
    expect(view.host.querySelector('.composer-box textarea')?.getAttribute('aria-label')).toBe('Message Invoice helper')
    expect(h.rpc).not.toHaveBeenCalledWith('agent.conversation', expect.anything())
    expect(h.rpc).not.toHaveBeenCalledWith('agent.conversation.create', expect.anything())
    expect(h.rpc).not.toHaveBeenCalledWith('session.new', expect.anything())
    // The first message is what creates the conversation.
    await typeInto(view.host.querySelector('.composer-box textarea'), 'Parse the March invoices')
    await act(async () => { view.host.querySelector<HTMLButtonElement>('.send-button')!.click() })
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('agent.conversation.create', { agentId: 'agent-invoice' })
    expect(h.rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({ sessionId: 'session-invoice', text: 'Parse the March invoices' }))
  })

  it('starts a new conversation next to the old one, without archiving it', async () => {
    const busy = session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Landing page copy', updatedAt: '2026-10-02T03:00:00.000Z', messages: [{ id: 'm1', role: 'user', content: 'Hello' }] })
    const fresh = session({ id: 'session-claude-fresh', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'New chat', updatedAt: '2026-10-02T04:00:00.000Z', messages: [] })
    configure(snapshot({ sessions: [busy, ...sessions.filter((item) => item.id !== 'session-claude')] }))
    withRpc((method) => method === 'agent.conversation.create' ? { session: fresh } : undefined)
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('.chat-header [aria-label="New conversation"]'))
    await view.settle()
    expect(view.host.querySelector('[role="dialog"]')).toBeNull()
    expect(h.rpc).toHaveBeenCalledWith('agent.conversation.create', { agentId: 'agent-claude' })
    expect(h.rpc).not.toHaveBeenCalledWith('session.archive', expect.anything())
    // Both conversations are listed in the bot's conversations column.
    const titles = [...view.host.querySelectorAll('.conversations-panel .convo-title')].map((node) => node.textContent)
    expect(titles).toEqual(expect.arrayContaining(['New chat', 'Landing page copy']))
  })

  it('shows a context reset as a divider and flags lost context', async () => {
    const main = session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude', updatedAt: '2026-10-02T03:00:00.000Z', messages: [
      { id: 'u1', role: 'user', content: 'Remember the build flag.' },
      { id: 'a1', role: 'assistant', content: 'Noted.' },
      { id: 'c1', role: 'notice', content: 'Started a fresh session. The agent no longer has earlier context.', meta: { kind: 'context_reset', reason: 'fresh_session', contextLost: true } },
      { id: 'c2', role: 'notice', content: 'Conversation compacted.', meta: { kind: 'context_reset', reason: 'compaction', contextLost: false } },
    ] })
    configure(snapshot({ sessions: [main, ...sessions.filter((item) => item.id !== 'session-claude')] }))
    const view = startApp()
    await view.settle()
    const dividers = [...view.host.querySelectorAll('.message-list .context-divider')]
    expect(dividers.map((node) => node.getAttribute('aria-label'))).toEqual([
      'Started a fresh session. The agent no longer has earlier context.',
      'Conversation compacted.',
    ])
    expect(dividers.map((node) => node.classList.contains('lost'))).toEqual([true, false])
    expect(view.host.querySelector('.team-notice')).toBeNull()
  })

  it('holds a message for when the usage limit resets, and sends normally once it has (Phase 1B)', async () => {
    const limited = session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude', state: 'limited', limitedUntil: new Date(Date.now() + 3_600_000).toISOString(), updatedAt: '2026-10-02T03:00:00.000Z', messages: [{ id: 'u1', role: 'user', content: 'Hello' }] })
    configure(snapshot({ sessions: [limited, ...sessions.filter((item) => item.id !== 'session-claude')] }))
    const base = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'session.queue.list') return { items: [], paused: false }
      if (method === 'session.queue.add') return { item: { id: 'q1', sessionId: params.sessionId, text: params.text, kind: 'send_later', dueAt: limited.limitedUntil, status: 'queued', error: null, position: 1, whenLimitResets: true } }
      return base(method, params)
    })
    const view = startApp()
    await view.settle()
    const send = () => view.host.querySelector<HTMLButtonElement>('button.send-button:not(.cancel)')
    await typeInto(view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Claude"]'), 'Carry on after the reset')
    expect(send()?.getAttribute('aria-label')).toBe('Send when the limit resets')
    await click(send())
    await view.settle()
    const queued = h.rpc.mock.calls.find(([method]) => method === 'session.queue.add')?.[1] as Record<string, unknown>
    expect(queued).toMatchObject({ sessionId: 'session-claude', text: 'Carry on after the reset', whenLimitResets: true })
    expect(queued.dueAt, 'the daemon owns the time').toBeUndefined()
    expect(h.rpc.mock.calls.some(([method]) => method === 'session.prompt'), 'not sent into the limit').toBe(false)
  })

  it('queues a message while the agent works, keeps Stop separate and lists the queue', async () => {
    const working = session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude', state: 'working', updatedAt: '2026-10-02T03:00:00.000Z', messages: [{ id: 'u1', role: 'user', content: 'Build the page.' }] })
    configure(snapshot({ sessions: [working, ...sessions.filter((item) => item.id !== 'session-claude')] }))
    const queued: Array<{ id: string; sessionId: string; text: string; kind: 'user' | 'send_later'; dueAt: string | null; status: 'queued'; error: null; position: number }> = []
    const base = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'session.queue.list') return { items: queued, paused: false }
      if (method === 'session.queue.add') {
        queued.push({ id: `q${queued.length + 1}`, sessionId: String(params.sessionId), text: String(params.text), kind: params.dueAt ? 'send_later' : 'user', dueAt: (params.dueAt as string | undefined) ?? null, status: 'queued', error: null, position: queued.length })
        return { item: queued.at(-1) }
      }
      return base(method, params)
    })
    const view = startApp()
    await view.settle()
    // Stop is its own button while the turn is live; the arrow becomes "Queue message".
    expect(view.host.querySelector('[aria-label="Cancel turn"]')).not.toBeNull()
    expect(view.host.querySelector('[aria-label="Send message"]')).toBeNull()
    const textarea = view.host.querySelector<HTMLTextAreaElement>('.composer-wrap textarea')!
    expect(textarea.disabled).toBe(false)
    await typeInto(textarea, 'Then add a footer')
    await click(view.host.querySelector('[aria-label="Queue message"]'))
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('session.queue.add', { clientMessageId: expect.stringMatching(/^m-/), sessionId: 'session-claude', text: 'Then add a footer' })
    expect(h.rpc).not.toHaveBeenCalledWith('session.prompt', expect.anything())
    expect(textarea.value).toBe('')
    // The queue is one compact row with a count; its rows unfold on demand.
    const chip = view.host.querySelector<HTMLButtonElement>('.composer-status-chip')!
    expect(chip.textContent).toContain('1 queued message')
    expect(view.host.querySelector('.queue-banner')).toBeNull()
    await act(async () => { chip.click() })
    expect(view.host.querySelector('.queue-banner')?.getAttribute('aria-label')).toBe('Queued messages: 1')
    expect(view.host.querySelector('.queue-text')?.textContent).toBe('Then add a footer')
  })

  it('applies queue.changed events and lets the user delete a queued message', async () => {
    const working = session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude', state: 'working', updatedAt: '2026-10-02T03:00:00.000Z', messages: [{ id: 'u1', role: 'user', content: 'Build the page.' }] })
    configure(snapshot({ sessions: [working, ...sessions.filter((item) => item.id !== 'session-claude')] }))
    const base = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'session.queue.list') return { items: [], paused: false }
      if (method === 'session.queue.delete') return { ok: true }
      return base(method, params)
    })
    const view = startApp()
    await view.settle()
    expect(view.host.querySelector('.queue-banner')).toBeNull()
    await act(async () => {
      emit({ type: 'queue.changed', sequence: 90, payload: { sessionId: 'session-claude', paused: true, items: [{ id: 'q9', sessionId: 'session-claude', text: 'Run the tests', kind: 'user', dueAt: null, status: 'queued', error: null, position: 0 }] } } as DaemonEvent)
    })
    await view.settle()
    expect(view.host.querySelector('.composer-status-chip')?.textContent).toContain('1 queued message')
    expect(view.host.querySelector('.composer-status-paused')?.textContent).toContain('Paused until you resume')
    await act(async () => { view.host.querySelector<HTMLButtonElement>('.composer-status-chip')!.click() })
    expect(view.host.querySelector('.queue-text')?.textContent).toBe('Run the tests')
    await click(view.host.querySelector('[aria-label="Remove from queue"]'))
    expect(h.rpc).toHaveBeenCalledWith('session.queue.delete', { sessionId: 'session-claude', id: 'q9' })
  })

  it('renders automatic retry notices, offers Cancel only while pending, and cancels through the daemon', async () => {
    const main = session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude', updatedAt: '2026-10-02T03:00:00.000Z', messages: [
      { id: 'u1', role: 'user', content: 'Refactor the parser.' },
      { id: 'n0', role: 'notice', content: 'Not retrying automatically: the reset time is unknown.', meta: { kind: 'auto_retry', status: 'declined', reason: 'unknown_reset' } },
      { id: 'n1', role: 'notice', content: 'Provider is overloaded. Retrying automatically in about 2 min (attempt 1 of 5).', meta: { kind: 'auto_retry', status: 'scheduled', retryKind: 'overloaded', attempt: 1, maxAttempts: 5, itemId: 'retry-1' } },
      { id: 'r1', role: 'user', content: 'Please continue.', meta: { kind: 'auto_retry', retryOf: 't1', attempt: 1 } },
    ] })
    configure(snapshot({ sessions: [main, ...sessions.filter((item) => item.id !== 'session-claude')] }))
    const base = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'session.queue.list') return { items: [{ id: 'retry-1', sessionId: 'session-claude', text: 'Please continue.', kind: 'retry', dueAt: new Date(Date.now() + 120_000).toISOString(), status: 'queued', error: null, position: 0 }], paused: false }
      if (method === 'turn.retry.cancel') return { cancelled: true }
      return base(method, params)
    })
    const view = startApp()
    await view.settle()
    const notices = [...view.host.querySelectorAll('.auto-retry')]
    expect(notices.map((node) => node.textContent?.replace('Cancel', '').trim())).toEqual([
      'Not retrying automatically: the reset time is unknown.',
      'Provider is overloaded. Retrying automatically in about 2 min (attempt 1 of 5).',
    ])
    expect(view.host.querySelectorAll('.auto-retry-cancel')).toHaveLength(1)
    expect(view.host.querySelector('.message-list')?.textContent ?? '').toContain('Continuing automatically')
    expect(view.host.querySelector('.message-list')?.textContent ?? '').not.toContain('Please continue.')
    await click(view.host.querySelector('.auto-retry-cancel'))
    expect(h.rpc).toHaveBeenCalledWith('turn.retry.cancel', { sessionId: 'session-claude' })
  })

  it('offers Steer only for a working Codex blob whose daemon capability is enabled', async () => {
    const working = session({ id: 'session-codex', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Invoice parser tests', state: 'working', updatedAt: '2026-10-02T03:00:00.000Z', messages: [{ id: 'u1', role: 'user', content: 'Run the tests.' }] })
    const rest = sessions.filter((item) => item.id !== 'session-codex')
    configure(snapshot({ sessions: [working, ...rest] }))
    h.getActiveSession.mockResolvedValue('session-codex')
    h.getActiveRuntime.mockResolvedValue('runtime-codex')
    let enabled = false
    const base = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'runtime.capabilities' && params.runtimeId === 'runtime-codex' && !params.agentId) return { runtimeId: 'runtime-codex', settings: { steer: { supported: true, enabled } } }
      if (method === 'session.queue.list') return { items: [], paused: false }
      if (method === 'session.steer') return { steered: true, turnId: 't1' }
      return base(method, params)
    })
    // Gate off: no Steer even though Codex is working and text is typed.
    let view = startApp()
    await view.settle()
    await typeInto(view.host.querySelector<HTMLTextAreaElement>('.composer-wrap textarea'), 'Also check the date format')
    expect(view.host.querySelector('[aria-label="Steer now"]')).toBeNull()
    expect(view.host.querySelector('[aria-label="Queue message"]')).not.toBeNull()
    // F4: the constant pre-send reason line is gone; the explanation waits for a send that queued.
    expect(view.host.querySelector('.composer-status-note')).toBeNull()
    await click(view.host.querySelector('[aria-label="Queue message"]'))
    await view.settle()
    expect(view.host.querySelector('.composer-status-note')?.textContent).toContain('Steering is unavailable')
    view.unmount()
    // Gate on: Steer appears and calls session.steer, not session.prompt.
    enabled = true
    view = startApp()
    await view.settle()
    await typeInto(view.host.querySelector<HTMLTextAreaElement>('.composer-wrap textarea'), 'Also check the date format')
    await click(view.host.querySelector('[aria-label="Steer now"]'))
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('session.steer', { sessionId: 'session-codex', text: 'Also check the date format' })
    expect(h.rpc).not.toHaveBeenCalledWith('session.prompt', expect.anything())
  })

  it('hands a conversation to another blob by drafting, never sending, in that blob\'s composer', async () => {
    const base = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'session.handoff.draft') return { draft: 'Continue from Claude\'s conversation "Landing page copy".\n\nYou: hello', carried: { messages: 1, truncated: false }, fromAgentId: 'agent-claude', title: 'Landing page copy' }
      return base(method, params)
    })
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('[aria-label="More options"]'))
    await click(menuItem(view.host, 'Continue in another bot…'))
    const dialog = view.host.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Nothing is sent until you send it.')
    const names = [...dialog.querySelectorAll('.handoff-choice strong')].map((node) => node.textContent)
    expect(names).not.toContain('Claude')
    expect(names).toContain('Codex')
    await click([...dialog.querySelectorAll<HTMLButtonElement>('.handoff-choice')].find((button) => button.textContent?.includes('Codex')))
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('session.handoff.draft', { fromSessionId: 'session-claude' })
    expect(h.rpc).not.toHaveBeenCalledWith('session.prompt', expect.anything())
    expect(view.host.querySelector('[role="dialog"]')).toBeNull()
    expect(view.host.querySelector<HTMLTextAreaElement>('.composer-wrap textarea')?.value).toContain('Continue from Claude')
  })

  it('shows delegation chips and opens the side conversation read-only', async () => {
    const main = session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude', updatedAt: '2026-10-02T03:00:00.000Z', messages: [
      { id: 'u1', role: 'user', content: 'Ask @Codex to check the tests.' },
      { id: 'n1', role: 'notice', content: 'Check the tests', meta: { kind: 'delegation', direction: 'sent', peerAgentId: 'agent-codex', peerName: 'Codex', sideSessionId: 'session-side' } },
      { id: 'r1', role: 'user', content: '[Reply from Codex]\nAll 12 tests pass.', meta: { kind: 'blob_reply', fromAgentId: 'agent-codex', fromName: 'Codex', sideSessionId: 'session-side' } },
      { id: 'a1', role: 'assistant', content: 'Codex confirms all tests pass.' },
    ] })
    const side = session({ id: 'session-side', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Claude ⇄ Codex', updatedAt: '2026-10-02T02:30:00.000Z', link: { kind: 'side', peerAgentId: 'agent-claude', peerName: 'Claude', originSessionId: 'session-claude' }, messages: [
      { id: 's1', role: 'user', content: 'Please run the tests.', meta: { kind: 'blob_message', fromAgentId: 'agent-claude', fromName: 'Claude' } },
      { id: 's1t', role: 'thinking', content: 'Private reasoning about the request.' },
      { id: 's2', role: 'assistant', content: 'All 12 tests pass.' },
    ] })
    configure(snapshot({ sessions: [main, side, ...sessions.filter((item) => item.id !== 'session-claude')] }))
    const view = startApp()
    await view.settle()
    // A sent delegation is an assignment card; the reply is a chip.
    expect(view.host.querySelector('.delegation-group')?.getAttribute('aria-label')).toBe('Assigned to Codex')
    // Since 28 October 2026 the assignment is itself a "Messaged" chip; the reply chip is the other one.
    expect(view.host.querySelector('.delegation-head')?.textContent).toContain('Messaged')
    expect([...view.host.querySelectorAll('.team-chip:not(.delegation-head)')].map((chip) => chip.getAttribute('aria-label'))).toEqual(['Message from Codex. Open the conversation'])
    // The relayed text stays in the side conversation; the chip links to it.
    expect(view.host.querySelector('.team-reply-toggle')).toBeNull()
    expect(view.host.querySelector('.message-list')?.textContent ?? '').not.toContain('All 12 tests pass.')
    // Side conversations stay out of the main transcript and the sidebar rows.
    expect(rows(view.host).filter((row) => row.getAttribute('data-agent-id') === 'agent-codex')).toHaveLength(1)
    // The card opens the read-only conversation between the two bots.
    expect(view.host.querySelector('.side-header')).toBeNull()
    await openAssignment(view.host)
    expect(view.host.querySelector('.side-header')?.getAttribute('aria-label')).toBe('Side conversation between Claude and Codex')
    expect(view.host.querySelector('.composer-box')).toBeNull()
    expect(view.host.querySelector('.side-peer .message-author')?.textContent).toContain('Claude')
    // The teammate's private reasoning is not shown as a message from either blob.
    expect(view.host.querySelector('.message-list')?.textContent ?? '').not.toContain('Private reasoning')
    await click(buttonNamed(view.host, 'Close chat'))
    expect(view.host.querySelector('.side-header')).toBeNull()
    expect(view.host.querySelector('.composer-box textarea')?.getAttribute('aria-label')).toBe('Message Claude')
  })

  // FIX39 item 18 (P6 audit finding 5): a queued delegation shows a waiting
  // indicator instead of the bot's empty "Ready when you are" screen.
  it('shows a waiting indicator for a queued side conversation', async () => {
    const main = session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude', updatedAt: '2026-10-02T03:00:00.000Z', messages: [
      { id: 'u1', role: 'user', content: 'Ask @Codex to check the tests.' },
      { id: 'n1', role: 'notice', content: 'Check the tests', meta: { kind: 'delegation', direction: 'sent', peerAgentId: 'agent-codex', peerName: 'Codex', sideSessionId: 'session-side' } },
    ] })
    const side = session({ id: 'session-side', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Check the tests', state: 'idle', updatedAt: '2026-10-02T02:30:00.000Z', link: { kind: 'side', peerAgentId: 'agent-claude', peerName: 'Claude', originSessionId: 'session-claude', topic: 'Check the tests' }, messages: [
      { id: 's1', role: 'notice', content: 'Waiting for Codex to finish another conversation.', meta: { kind: 'delegation', direction: 'waiting', state: 'queued' } },
    ] })
    configure(snapshot({ sessions: [main, side, ...sessions.filter((item) => item.id !== 'session-claude')] }))
    const view = startApp()
    await view.settle()
    await openAssignment(view.host)
    expect(view.host.querySelector('.side-header')).not.toBeNull()
    // The queued conversation says it is waiting, with no empty first-run screen.
    expect(view.host.querySelector('.session-first-state')).toBeNull()
    const indicator = view.host.querySelector('.working-indicator.waiting')
    expect(indicator?.textContent).toContain('Waiting for a free working slot for Codex')
  })

  it.each(['steer', 'queue'] as const)('uses the %s preference and Ctrl+Enter sends the other way', async (mode) => {
    const working = session({ id: 'session-codex', runtimeId: 'runtime-codex', agentId: 'agent-codex', state: 'working', messages: [{ role: 'user', content: 'Work' }] })
    configure(snapshot({ sessions: [working, ...sessions.filter(s => s.id !== working.id)] }))
    h.getActiveSession.mockResolvedValue(working.id)
    h.getActiveRuntime.mockResolvedValue(working.runtimeId)
    const base = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'settings.get') return { settings: { 'composer.busySendMode': mode } }
      if (method === 'runtime.capabilities') return { settings: { steer: { supported: true, enabled: true } } }
      if (method === 'session.steer' || method === 'session.queue.add') return {}
      return base(method, params)
    })
    const view = startApp(); await view.settle()
    const textarea = view.host.querySelector<HTMLTextAreaElement>('.composer-wrap textarea')!
    await typeInto(textarea, 'First follow-up')
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith(mode === 'steer' ? 'session.steer' : 'session.queue.add', mode === 'steer' ? { sessionId: working.id, text: 'First follow-up' } : { clientMessageId: expect.stringMatching(/^m-/), sessionId: working.id, text: 'First follow-up' })
    await typeInto(textarea, 'Other way')
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })) })
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith(mode === 'steer' ? 'session.queue.add' : 'session.steer', mode === 'steer' ? { clientMessageId: expect.stringMatching(/^m-/), sessionId: working.id, text: 'Other way' } : { sessionId: working.id, text: 'Other way' })
    // The composer's Steer / Queue choice (beside the send button since 28 October 2026) shows the preference.
    expect(view.host.querySelector('.composer-status-modes [role="radio"][aria-checked="true"]')?.textContent).toBe(mode === 'steer' ? 'Steer' : 'Queue')
  }, 15_000)

  it('shows live side-conversation activity and messages with Agent activity off', async () => {
    const side = session({ id: 'live-side', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Research', state: 'working', link: { kind: 'side', peerAgentId: 'agent-claude' }, messages: [{ id: 'request', role: 'user', content: 'Investigate the bug', meta: { kind: 'blob_message', fromAgentId: 'agent-claude', fromName: 'Claude' } }], tools: [{ id: 'tool', kind: 'read', state: 'running', title: 'Read report', detail: { path: 'report.md' } }] })
    configure(snapshot({ sessions: [...sessions, side] }))
    const view = startApp(); await view.settle()
    await click(view.host.querySelector('[aria-label="Toggle context pane"]'))
    await click(view.host.querySelector('[data-task-id="live-side"]'))
    expect(view.host.querySelector('.side-header')).not.toBeNull()
    expect(view.host.querySelector('.conversation-log')?.textContent ?? view.host.textContent).toContain('Investigate the bug')
    expect(view.host.querySelector('.activity-summary')).not.toBeNull()
    await act(async () => emit({ type: 'tool.changed', sequence: 199, payload: { sessionId: side.id, tool: { id: 'new-tool', kind: 'read', state: 'running', title: 'Read notes', detail: { path: 'notes.md' } } } } as DaemonEvent))
    await click(view.host.querySelector('.activity-summary-toggle'))
    expect(view.host.querySelector('.activity-summary')?.textContent).toContain('Read notes.md')
    await act(async () => emit({ type: 'message.delta', sequence: 200, payload: { sessionId: side.id, messageId: 'reply', role: 'assistant', delta: 'Found the cause' } } as DaemonEvent))
    expect(view.host.querySelector('.side-target')?.textContent).toContain('Found the cause')
    expect(view.host.querySelector('.working-indicator')?.textContent).toContain('Codex is working')
  })

  it('answers an inline question with the chosen option', async () => {
    const waiting = session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude', state: 'waiting_permission', updatedAt: '2026-10-02T03:00:00.000Z', messages: [{ id: 'u1', role: 'user', content: 'Write a script.' }] })
    const question = { id: 'perm-q', sessionId: 'session-claude', runtimeId: 'runtime-claude', status: 'pending', kind: 'question', title: 'Claude has a question', choices: ['answer', 'dismiss'], questions: [{ id: 'Which language?', header: 'Language', question: 'Which language?', options: [{ label: 'Python', description: '' }, { label: 'JavaScript', description: '' }], multiSelect: false, allowOther: true }] }
    configure(snapshot({ sessions: [waiting, ...sessions.filter((item) => item.id !== 'session-claude')], permissions: [question] }))
    withRpc((method) => method === 'permission.reply' ? { resolved: true } : undefined)
    const view = startApp()
    await view.settle()
    const options = [...view.host.querySelectorAll<HTMLButtonElement>('.question-option')]
    expect(options.map((option) => option.textContent)).toEqual(['APython', 'BJavaScript'])
    expect(view.host.querySelector('.approval-card, .permission-card')).toBeNull()
    await click(options[0])
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('permission.reply', { permissionId: 'perm-q', choice: 'answer', answers: { 'Which language?': ['Python'] } })
  })

  it('does not pull focus to another blob that is waiting on a question', async () => {
    const waiting = session({ id: 'session-codex', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Codex', state: 'waiting_permission', updatedAt: '2026-10-01T00:00:00.000Z' })
    const question = { id: 'perm-q', sessionId: 'session-codex', runtimeId: 'runtime-codex', status: 'pending', kind: 'question', title: 'Codex has a question', choices: ['answer', 'dismiss'], questions: [{ id: 'q', header: 'Q', question: 'Which?', options: [{ label: 'A' }], multiSelect: false, allowOther: true }] }
    configure(snapshot({ sessions: [waiting, ...sessions.filter((item) => item.id !== 'session-codex')], permissions: [question] }))
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('.team-row[data-agent-id="agent-claude"]'))
    await view.settle()
    expect(view.host.querySelector('.team-row[aria-current="true"]')?.getAttribute('data-agent-id')).toBe('agent-claude')
    expect(view.host.querySelector('.question-card')).toBeNull()
    expect(view.host.querySelector('.team-row[data-agent-id="agent-codex"] .bot-row-preview')?.textContent).toBe('Waiting for you')
  })

  it('pulls focus to a new approval once, then lets the user look at another bot while it waits', async () => {
    const waiting = session({ id: 'session-codex', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Codex', state: 'waiting_permission', updatedAt: '2026-10-01T00:00:00.000Z' })
    const approval = { id: 'perm-a', sessionId: 'session-codex', runtimeId: 'runtime-codex', status: 'pending', kind: 'command', title: 'Run npm test', choices: ['allow', 'deny'] }
    configure(snapshot({ sessions: [waiting, ...sessions.filter((item) => item.id !== 'session-codex')], permissions: [approval] }))
    const view = startApp()
    await view.settle()
    expect(view.host.querySelector('.team-row[aria-current="true"]')?.getAttribute('data-agent-id')).toBe('agent-codex')
    await click(view.host.querySelector('.team-row[data-agent-id="agent-claude"]'))
    await view.settle()
    expect(view.host.querySelector('.team-row[aria-current="true"]')?.getAttribute('data-agent-id')).toBe('agent-claude')
  })

  it('approves a proposed plan by leaving plan mode and asking the blob to build', async () => {
    const planned = session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Claude', updatedAt: '2026-10-02T03:00:00.000Z', modelLock: { model: null, thinking: null, planMode: true }, messages: [
      { id: 'u1', role: 'user', content: 'Plan the change.' },
      { id: 'p1', role: 'plan', content: '1. Do it.', meta: { kind: 'plan' } },
    ] })
    configure(snapshot({ sessions: [planned, ...sessions.filter((item) => item.id !== 'session-claude')] }))
    withRpc((method, params) => method === 'session.model.update' ? { session: { ...planned, modelLock: { model: null, thinking: null } } } : method === 'session.prompt' ? { accepted: true, params } : undefined)
    const view = startApp()
    await view.settle()
    expect(view.host.querySelector('.plan-pill')?.getAttribute('aria-pressed')).toBe('true')
    expect(view.host.querySelector('.plan-card')?.textContent).toContain('Do it.')
    await click(buttonNamed(view.host, 'Approve & build'))
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('session.model.update', { sessionId: 'session-claude', planMode: false })
    expect(h.rpc).toHaveBeenCalledWith('session.prompt', { sessionId: 'session-claude', text: 'Approved. Go ahead and implement the plan.' })
  })

  it('completes an @mention from the picker with the keyboard', async () => {
    const view = startApp()
    await view.settle()
    const textarea = view.host.querySelector<HTMLTextAreaElement>('.composer-box textarea')!
    await act(async () => { textarea.focus() })
    await typeInto(textarea, 'Ask @co')
    textarea.setSelectionRange(7, 7)
    await typeInto(textarea, 'Ask @co')
    expect([...view.host.querySelectorAll('.mention-option strong')].map((node) => node.textContent)).toEqual(['Codex', 'OpenCode'])
    await press(textarea, 'Enter')
    expect(textarea.value).toBe('Ask @Codex ')
    expect(view.host.querySelector('.mention-picker')).toBeNull()
    expect(h.rpc).not.toHaveBeenCalledWith('session.prompt', expect.anything())
  })

})

describe('opt-in conversation experiments', () => {
  const experimentalSession = session({
    id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Review the saved changes',
    messages: [
      { id: 'u1', role: 'user', content: 'Original prompt', sequence: 1, turnId: 't1' },
      { id: 'a1', role: 'assistant', content: 'First reply', sequence: 2, turnId: 't1' },
      { id: 'u2', role: 'user', content: 'Latest prompt', sequence: 3, turnId: 't2' },
      { id: 'a2', role: 'assistant', content: 'Latest reply', sequence: 4, turnId: 't2' },
    ],
    turns: [{ id: 't1', state: 'completed' }, { id: 't2', state: 'completed' }],
    files: [{ id: 'f1', turnId: 't1', path: 'a.ts', detail: { diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' } }],
  })
  function prepare(enabled: boolean, extraSessions: Session[] = []) {
    configure(snapshot({ sessions: [experimentalSession, ...extraSessions] }))
    const original = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'settings.get') return { settings: Object.fromEntries(['changeReview', 'messageActions', 'search', 'autoTitles', 'undo', 'shortcuts', 'approvalBadge'].map((name) => [`experimental.${name}`, enabled])) }
      if (method === 'session.get') return [experimentalSession, ...extraSessions].find((s) => s.id === params.sessionId)
      return original(method, params)
    })
  }
  it('has unchanged message UI, header and shortcut behavior while switches are off', async () => {
    prepare(false)
    const view = startApp(); await view.settle()
    expect(view.host.querySelector('.message-actions')).toBeNull()
    expect(view.host.querySelector('.change-review')).toBeNull()
    expect(view.host.querySelector('.conversation-auto-title')).toBeNull()
    await press(document.body, '/', { ctrlKey: true })
    expect(view.host.querySelector('[aria-label="Keyboard shortcuts"]')).toBeNull()
    await click(view.host.querySelector('button.sidebar-search'))
    expect(view.host.textContent).not.toContain('Search messages')
  })
  it('edits drafts, retries only the latest user text, and keeps history intact', async () => {
    prepare(true)
    const view = startApp(); await view.settle()
    const latestUser = [...view.host.querySelectorAll<HTMLElement>('.message-row.user')].at(-1)!
    await act(async () => latestUser.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:240, clientY:160 })))
    expect(view.host.querySelector('[role="menu"]')?.textContent).toContain('Edit as a new draft')
    await press(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toContain('Edit as a new draft')
    await press(document.activeElement!, 'ArrowUp')
    expect(document.activeElement?.textContent).toContain('Retry as a new prompt')
    await click(buttonNamed(view.host, 'Edit as a new draft')); await view.settle()
    expect(view.host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Latest prompt')
    await press(latestUser.closest('.message-action-shell')?.querySelector('[aria-label="Copy message text"]')!, 'F10', { shiftKey:true })
    await click(buttonNamed(view.host, 'Retry as a new prompt')); await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('session.prompt', { sessionId: 'session-claude', text: 'Latest prompt' })
    expect(experimentalSession.messages?.map((m) => m.content)).toEqual(['Original prompt', 'First reply', 'Latest prompt', 'Latest reply'])
    expect(view.host.querySelector('.conversation-crumb-title')?.textContent).toBe('Review the saved changes')
  })
  it('keeps Retry out of the hover toolbar; it stays in the message menu', async () => {
    prepare(true)
    const view = startApp(); await view.settle()
    expect(view.host.querySelector('[aria-label="Retry this turn"]')).toBeNull()
  })
  it('stages a quoted user message and sends its scoped reference with the new prompt', async () => {
    const previousMessages = experimentalSession.messages
    experimentalSession.messages = [...(previousMessages ?? [])]
    prepare(true)
    const originalRpc = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'session.prompt' && params.replyTo) {
        const replyTo = params.replyTo as { sourceSessionId: string; messageId: string }
        experimentalSession.messages!.push({ id:'u3', role:'user', content:String(params.text), sequence:5, turnId:'t3', meta:{ replyTo:{ sourceSessionId:replyTo.sourceSessionId, messageId:replyTo.messageId, role:'user', author:'You', excerpt:'Original prompt', truncated:false, createdAt:stamp } } })
        return { accepted:true }
      }
      return originalRpc(method, params)
    })
    try {
      const view = startApp(); await view.settle()
      const firstUser = view.host.querySelector<HTMLElement>('.message-action-shell.user')!
      await click(firstUser.querySelector('[aria-label="Quote message"]'))
      expect(view.host.querySelector('.composer-box .reply-context-strip')?.textContent).toContain('Original prompt')
      await typeInto(view.host.querySelector<HTMLTextAreaElement>('.composer-wrap textarea'), 'Explain that earlier request')
      await click(view.host.querySelector('[aria-label="Send message"]'))
      await view.settle()
      expect(h.rpc).toHaveBeenCalledWith('session.prompt', {
        clientMessageId: expect.stringMatching(/^m-/),
        sessionId: 'session-claude',
        text: 'Explain that earlier request',
        replyTo: { sourceSessionId: 'session-claude', messageId: 'u1' },
      })
      expect([...view.host.querySelectorAll('.message-row.user .reply-context-strip.compact')].some((strip) => strip.textContent?.includes('Original prompt'))).toBe(true)
    } finally { experimentalSession.messages = previousMessages }
  })
  it('clears the composer at once, shows the message as Sending…, and keeps a failed send with its reason and retry', async () => {
    prepare(true)
    const originalRpc = h.rpc.getMockImplementation()!
    let fail!: (reason: unknown) => void
    let attempts = 0
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method !== 'session.prompt') return originalRpc(method, params)
      attempts += 1
      // The first attempt fails; Try again succeeds.
      if (attempts === 1) return new Promise((_resolve, reject) => { fail = reject })
      return { accepted: true }
    })
    const view = startApp(); await view.settle()
    const textarea = view.host.querySelector<HTMLTextAreaElement>('.composer-wrap textarea')!
    await typeInto(textarea, 'Run the tests')
    await click(view.host.querySelector('[aria-label="Send message"]'))
    // The composer never waits for the daemon.
    expect(textarea.value).toBe('')
    expect(textarea.disabled).toBe(false)
    expect(view.host.querySelector('.message-row.user.pending')?.textContent).toContain('Run the tests')
    expect(view.host.querySelector('.message-pending-note')?.textContent).toBe('Sending…')
    await act(async () => { fail(new Error('conflict: busy')) })
    await view.settle()
    // The row stays with the reason, and the draft does not duplicate it.
    const failed = view.host.querySelector('.message-row.user.pending.failed')!
    expect(failed).not.toBeNull()
    expect(failed.querySelector('[role="alert"] span')?.textContent).toBe(friendlyErrorText('conflict: busy'))
    expect(textarea.value).toBe('')
    // Try again resends the same message and clears the row.
    await click([...failed.querySelectorAll('button')].find((button) => button.textContent === 'Try again'))
    await view.settle()
    expect(attempts).toBe(2)
    expect(view.host.querySelector('.message-row.user.pending')).toBeNull()
  })
  it('returns a failed message to the composer for editing instead of leaving two copies', async () => {
    prepare(true)
    const originalRpc = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => method === 'session.prompt'
      ? Promise.reject(new Error('provider_error: The provider refused the request.'))
      : originalRpc(method, params))
    const view = startApp(); await view.settle()
    const textarea = view.host.querySelector<HTMLTextAreaElement>('.composer-wrap textarea')!
    await typeInto(textarea, 'Run the tests')
    await click(view.host.querySelector('[aria-label="Send message"]'))
    await view.settle()
    const edit = [...view.host.querySelectorAll('.message-row.user.pending.failed button')].find((button) => button.textContent === 'Edit')!
    await click(edit)
    expect(textarea.value).toBe('Run the tests')
    expect(view.host.querySelector('.message-row.user.pending')).toBeNull()
  })
  it('warms the open conversation so the first message does not wait for the coding agent', async () => {
    prepare(true)
    const view = startApp(); await view.settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    expect(h.rpc).toHaveBeenCalledWith('session.warm', { sessionId: 'session-claude' })
  })
  it('applies the daemon reaction event to the correct message badge', async () => {
    prepare(true)
    const originalRpc = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'message.reaction.toggle') {
        emit({ type:'message.reactions.changed', sequence:21, payload:{ sessionId:'session-claude', messageId:String(params.messageId), emoji:'👍', selected:true, reactions:['👍'] } })
        return { reactions:['👍'], selected:true }
      }
      return originalRpc(method, params)
    })
    const view = startApp(); await view.settle()
    const firstUser = view.host.querySelector<HTMLElement>('.message-action-shell.user')!
    await click(firstUser.querySelector('[aria-label="React to message"]'))
    await click(document.querySelector('[aria-label="Add your thumbs up reaction"]'))
    await view.settle()
    expect(h.rpc).toHaveBeenCalledWith('message.reaction.toggle', { sessionId:'session-claude', messageId:'u1', emoji:'👍' })
    expect(firstUser.querySelector('.message-reaction-badge')?.textContent).toContain('👍')
  })

  it('shows the daemon’s safe refusal after a failed Revert and leaves the file in review', async () => {
    prepare(true)
    const original = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'file.revert') throw new Error('The saved diff was clipped or incomplete; this change cannot be reverted safely.')
      return original(method, params)
    })
    const view = startApp(); await view.settle()
    await click(buttonNamed(view.host, 'Revert')); await view.settle()
    await click(buttonNamed(view.host, 'Revert change')); await view.settle()
    expect(view.host.textContent).toContain('The saved diff was clipped or incomplete')
    expect(view.host.querySelector('.change-review')).not.toBeNull()
    expect(view.host.querySelector('[role="dialog"]')).toBeNull()
  })
  it('requires confirmation for Revert and remembers Keep within a session', async () => {
    prepare(true)
    const view = startApp(); await view.settle()
    await click(buttonNamed(view.host, 'Revert')); await view.settle()
    expect(h.rpc.mock.calls.some(([method]) => method === 'file.revert')).toBe(false)
    expect(view.host.querySelector('[role="dialog"]')?.textContent).toContain('Revert a.ts?')
    await click(buttonNamed(view.host, 'Keep it')); await view.settle()
    await click(buttonNamed(view.host, 'Keep')); await view.settle()
    expect(view.host.querySelector('.change-review')).toBeNull()
    await click(view.host.querySelector('button.sidebar-search'))
    await press(document.body, 'Escape')
    expect(view.host.querySelector('.change-review')).toBeNull()
  })

  it('clears the native badge by default and follows live approvalBadge setting changes', async () => {
    prepare(false)
    h.fetchSnapshot.mockResolvedValue(snapshot({
      sessions: [experimentalSession],
      permissions: [{ id: 'question', sessionId: 'session-claude', status: 'pending', kind: 'question', title: 'Which option?', questions: [] }],
    }))
    const view = startApp(); await view.settle()
    expect(h.approvalBadge).toHaveBeenLastCalledWith(0)
    act(() => emit({ type: 'settings.changed', sequence: 21, payload: { key: 'experimental.approvalBadge', value: true } }))
    await view.settle()
    expect(h.approvalBadge).toHaveBeenLastCalledWith(1)
    act(() => emit({ type: 'settings.changed', sequence: 22, payload: { key: 'experimental.approvalBadge', value: false } }))
    await view.settle()
    expect(h.approvalBadge).toHaveBeenLastCalledWith(0)
  })
  it('opens the shortcut sheet through Ctrl+/ and closes it through Esc', async () => {
    prepare(true)
    const view = startApp(); await view.settle()
    await press(document.body, '/', { ctrlKey: true }); await view.settle()
    expect(view.host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Keyboard shortcuts')
    await press(document.body, 'Escape')
    expect(view.host.querySelector('[role="dialog"]')).toBeNull()
  })
  it('opens a search result as a read-only side conversation and focuses its message', async () => {
    const side = session({ id: 'side', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Side topic', link: { kind: 'side', peerAgentId: 'agent-codex', peerName: 'Codex', topic: 'Side topic' }, messages: [{ id: 'side-u', role: 'user', content: 'Side needle', sequence: 1 }] })
    prepare(true, [side])
    const original = h.rpc.getMockImplementation()!
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => method === 'search.messages' ? { results: [{ sessionId: 'side', blobId: 'agent-claude', title: 'Side topic', role: 'user', messageId: 'side-u', createdAt: '2026-10-10T12:00:00Z', snippet: 'Side needle' }] } : original(method, params))
    const view = startApp(); await view.settle()
    await click(view.host.querySelector('button.sidebar-search')); await click(view.host.querySelector('[data-result-id="search-messages"]')); await view.settle()
    await typeInto(view.host.querySelector<HTMLInputElement>('[aria-label="Search message text"]'), 'needle')
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    await click(view.host.querySelector('[role="option"]')); await view.settle()
    expect(view.host.querySelector('.side-close')).not.toBeNull()
    expect(view.host.querySelector('.message-actions')).toBeNull()
    expect(document.activeElement?.id).toBe('conversation-message-message%3Aside-u')
  })
})

// FIX39 P5 follow-up: the composer issue the Director reported as a gap.
describe('FIX39 P5 follow-up', () => {
  // FIX39 item 16 / P5 audit S1: the permission control is safe mid-turn (it
  // writes the bot and stores the conversation change for the next turn).
  it('keeps the permission pill usable while a turn runs, unlike the model and effort controls', async () => {
    const working = session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Landing page copy', state: 'working', updatedAt: '2026-10-02T03:00:00.000Z', messages: [{ id: 'm1', role: 'user', content: 'Hello' }] })
    configure(snapshot({ sessions: [working, ...sessions.filter((item) => item.id !== 'session-claude')] }))
    h.getActiveSession.mockResolvedValue('session-claude')
    const view = startApp()
    await view.settle()
    const permission = view.host.querySelector<HTMLButtonElement>('.composer-controls-start .permission-pill')!
    expect(permission).not.toBeNull()
    expect(permission.disabled).toBe(false)
    // The model and effort pills are disabled, or aria-disabled when they explain why.
    const model = view.host.querySelector<HTMLButtonElement>('.composer-controls-end .model-pill')!
    expect(model.disabled || model.getAttribute('aria-disabled') === 'true').toBe(true)
    const effort = view.host.querySelector<HTMLButtonElement>('.session-effort-trigger')!
    expect(effort.disabled || effort.getAttribute('aria-disabled') === 'true').toBe(true)
    await click(permission)
    expect(view.host.querySelector('.permission-menu')).not.toBeNull()
    expect(view.host.querySelector('.composer-menu-note')?.textContent).toContain('Applies to this bot from now on')
  })
})
