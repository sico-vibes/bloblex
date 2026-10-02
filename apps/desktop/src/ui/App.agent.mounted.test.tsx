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
  getCurrentWindow: vi.fn(), openProjectFolder: vi.fn(),
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

vi.mock('../tauri', () => ({
  inDesktop: true,
  rpc: h.rpc,
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
  selectLocalFile: vi.fn(), inspectLocalFile: vi.fn(),
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
    BlobCanvas: (props: Record<string, any>) => ReactModule.createElement('span', {
      'data-testid': 'blob-canvas',
      'data-color': props.color,
      'data-label': props.label,
    }, props.greeting ? ReactModule.createElement('button', { type: 'button', 'aria-label': 'Complete greeting fixture', onClick: props.onGreetingComplete }, 'finish') : null),
  }
})

import { App } from './App'
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
    if (method === 'agent.delete') return { agent: { ...claude, archived: true } }
    if (method === 'session.new') {
      if (h.sessionError) throw new Error(h.sessionError)
      return { session: { id: 'session-made', runtimeId: 'runtime-claude', agentId: params.agentId, title: 'New chat', projectPath: params.projectPath, state: 'idle', messages: [] } }
    }
    return {}
  })
  const stop = vi.fn()
  h.listenForDaemonEvents.mockImplementation(async (handler: (event: any) => void) => { h.daemonEventHandlers.push(handler); return stop })
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
  configure()
})

afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
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

function tabNamed(root: ParentNode, name: string) {
  return [...root.querySelectorAll('[role="tab"]')].find((button) => (button.textContent ?? '').trim() === name)
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
  const handler = h.daemonEventHandlers.at(-1)
  if (!handler) throw new Error('no daemon listener')
  handler(event)
}

describe('blob roster and editor', () => {
  it('renders active blobs in roster order and hides archived ones', async () => {
    const view = startApp()
    await view.settle()
    const names = rows(view.host).map((row) => row.querySelector('strong')?.textContent)
    expect(names).toEqual(['Claude', 'Codex', 'Invoice helper', 'OpenCode'])
    expect(view.host.textContent).not.toContain('Retired')
    expect(view.host.querySelector('nav[aria-label="Blobs"]')).not.toBeNull()
    expect(rows(view.host)[0]?.getAttribute('aria-current')).toBe('true')
    expect(rows(view.host)[0]?.querySelector('[data-color]')?.getAttribute('data-color')).toBe('#F38C6F')
    expect(rows(view.host)[1]?.querySelector('[data-color]')?.getAttribute('data-color')).toBe('#82AAFF')
    const header = view.host.querySelector('[aria-label="Edit Claude"] [data-color]')
    expect(header?.getAttribute('data-color')).toBe('#F38C6F')
    expect(header?.getAttribute('data-color')).not.toBe('#82aaff')
  })

  it('paints the companion pill for the selected blob with that blob colour', async () => {
    const view = startApp('?companion=1')
    await view.settle()
    expect(view.host.querySelector('.companion-welcome [data-color]')?.getAttribute('data-color')).toBe('#F38C6F')
    await click(buttonNamed(view.host, 'Complete greeting fixture'))
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    await click(buttonNamed(view.host, 'Open companion home'))
    await view.settle()
    const pill = [...view.host.querySelectorAll('.pill.on')].find((node) => node.textContent?.includes('Claude'))
    expect(pill?.querySelector('[data-color]')?.getAttribute('data-color')).toBe('#F38C6F')
    expect(pill?.querySelector('[data-color]')?.getAttribute('data-color')).not.toBe('#82aaff')
    expect(view.host.querySelector('.pill .lbl')?.textContent).toBe('Claude')
  })

  it('searches session titles and keeps the matching blob', async () => {
    const view = startApp()
    await view.settle()
    const search = view.host.querySelector<HTMLInputElement>('[aria-label="Search agents and conversations"]')
    await typeInto(search, 'parser')
    expect(rows(view.host).map((row) => row.querySelector('strong')?.textContent)).toEqual(['Codex'])
    expect(rows(view.host)[0]?.textContent).toContain('Session: Invoice parser tests')
    await typeInto(search, 'C:/work/korus')
    expect(rows(view.host)).toHaveLength(0)
    expect(view.host.textContent).toContain('Nothing matches “C:/work/korus”.')
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
    await click(buttonNamed(view.host, 'Create blob'))
    expect(view.host.textContent).toContain('Enter a name.')
    const save = [...view.host.querySelectorAll('button')].find((button) => button.classList.contains('primary-button') && button.textContent?.includes('Create blob'))
    expect(save?.hasAttribute('disabled')).toBe(true)
    await click(tabNamed(view.host, 'Settings'))
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'A'.repeat(61))
    expect(view.host.textContent).toContain('Use 60 characters or fewer for the name.')
    await typeInto(field(view.host, 'Description') as HTMLTextAreaElement, 'B'.repeat(256))
    expect(view.host.textContent).toContain('Use 255 characters or fewer for the description.')
    expect(view.host.textContent).toContain('256 / 255')
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Claude')
    await typeInto(field(view.host, 'Description') as HTMLTextAreaElement, 'ok')
    expect(view.host.textContent).toContain('Another blob already uses this name.')
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Fresh blob')
    await typeInto(field(view.host, 'Instructions') as HTMLTextAreaElement, 'keep\0out')
    expect(view.host.textContent).toContain('Instructions cannot include a null character.')
    await typeInto(field(view.host, 'Instructions') as HTMLTextAreaElement, 'Be brief')
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
    await click(buttonNamed(view.host, 'Create blob'))
    await click(tabNamed(view.host, 'Settings'))
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Fresh blob')
    const save = [...view.host.querySelectorAll('button')].find((button) => button.classList.contains('primary-button') && button.textContent?.includes('Create blob'))
    const cases: Array<[string, string]> = [
      ['conflict: taken', 'Another blob already uses this name.'],
      ['invalid_argument: bad', 'Check the name, description, colour, and runtime, then try again.'],
      ['internal: boom', 'Bloblex could not save that change. Nothing was applied.'],
      ['unauthorized: no', 'Bloblex could not reach the local daemon. Reconnect and try again.'],
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
    await click(buttonNamed(view.host, 'Edit blob'))
    await click(tabNamed(view.host, 'Settings'))
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Claude Prime')
    expect(buttonNamed(view.host, 'Cancel')).toBeTruthy()
    await click(buttonNamed(view.host, 'Cancel'))
    expect(field(view.host, 'Name')).toHaveProperty('value', 'Claude')
    expect(buttonNamed(view.host, 'Cancel')).toBeUndefined()
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Claude Prime')
    await click(buttonNamed(view.host, 'Back'))
    expect(view.host.querySelector('#blob-dialog-title')?.textContent).toBe('Discard unsaved changes?')
    await view.settle()
    expect(document.activeElement?.textContent).toBe('Keep editing')
    await click(buttonNamed(view.host, 'Keep editing'))
    expect(view.host.querySelector('.blob-page')).not.toBeNull()
    expect(field(view.host, 'Name')).toHaveProperty('value', 'Claude Prime')
    await click(buttonNamed(view.host, 'Back'))
    await click(buttonNamed(view.host, 'Discard'))
    expect(view.host.querySelector('.blob-page')).toBeNull()
    expect(view.host.querySelector('[aria-label="Edit Claude"]')).not.toBeNull()
  })

  it('keeps a rejected rename dirty and shows the daemon name conflict', async () => {
    const view = startApp()
    await view.settle()
    await click(view.host.querySelector('[aria-label="Edit Claude"]'))
    await click(tabNamed(view.host, 'Settings'))
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Claude Prime')
    h.updateError = 'conflict: name'
    await click(buttonNamed(view.host, 'Save'))
    await view.settle()
    expect(view.host.textContent).toContain('Another blob already uses this name.')
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
    expect(create?.[1]).toEqual({
      name: 'Copy of Claude', runtimeId: 'runtime-claude', description: 'Default agent for Claude.', instructions: '', color: '#f38c6f',
      model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null,
    })
    expect(create?.[1]).not.toHaveProperty('archived')
    expect(rows(view.host).some((row) => row.textContent?.includes('Copy of Claude'))).toBe(true)
  })

  it('archives after confirmation and removes the row', async () => {
    const view = startApp()
    await view.settle()
    await openMenu(rows(view.host)[0]!)
    await click(buttonNamed(view.host, 'Archive'))
    const dialog = view.host.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Archive Claude?')
    expect(dialog?.textContent).toContain('It leaves the roster. Its conversations stay saved. Restoring a blob is not available yet.')
    await view.settle()
    expect(document.activeElement?.textContent).toBe('Cancel')
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
    await click(tabNamed(view.host, 'Settings'))
    expect(buttonNamed(view.host, 'Coral, selected')?.getAttribute('aria-pressed')).toBe('true')
    await click(buttonNamed(view.host, 'Pink'))
    expect(buttonNamed(view.host, 'Pink, selected')?.getAttribute('aria-pressed')).toBe('true')
    expect(buttonNamed(view.host, 'Coral')?.getAttribute('aria-pressed')).toBe('false')
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

  it('shows Runtime offline on Codex and disables New session', async () => {
    h.fetchSnapshot.mockResolvedValue(snapshot({
      runtimes: [claudeRuntime, { ...codexRuntime, status: 'offline' }, opencodeRuntime],
    }))
    const view = startApp()
    await view.settle()
    const codexRow = rows(view.host)[1]
    expect(codexRow?.textContent).toContain('Codex · Runtime offline')
    await openMenu(codexRow!)
    const item = buttonNamed(view.host, 'New session')
    expect(item?.hasAttribute('disabled')).toBe(true)
    await click(codexRow!)
    expect(buttonNamed(view.host, 'Session')?.hasAttribute('disabled')).toBe(true)
  })

  it('starts a session with agentId and projectPath only', async () => {
    const view = startApp()
    await view.settle()
    await click(buttonNamed(view.host, 'Session'))
    await click(menuItem(view.host, 'site'))
    await view.settle()
    const call = h.rpc.mock.calls.find((entry) => entry[0] === 'session.new')
    expect(call?.[1]).toEqual({ agentId: 'agent-claude', projectPath: 'C:/work/site' })
    expect(Object.keys(call?.[1] as object)).toEqual(['agentId', 'projectPath'])
  })

  it('maps session.new conflict and invalid_argument onto the stable sentences', async () => {
    const view = startApp()
    await view.settle()
    h.sessionError = 'invalid_argument: missing folder'
    await click(buttonNamed(view.host, 'Session'))
    await click(menuItem(view.host, 'site'))
    await view.settle()
    expect(view.host.textContent).toContain('Choose a project folder that exists on this device.')
    const invalidCall = h.rpc.mock.calls.filter((entry) => entry[0] === 'session.new').at(-1)
    expect(invalidCall?.[1]).not.toHaveProperty('runtimeId')
    h.sessionError = 'conflict: archived'
    await click(buttonNamed(view.host, 'Session'))
    await click(menuItem(view.host, 'site'))
    await view.settle()
    expect(view.host.textContent).toContain('This blob is archived, so a new session cannot be started.')
  })

  it('keeps a dirty edit when Escape is pressed on the discard dialog', async () => {
    const view = startApp()
    await view.settle()
    await openMenu(rows(view.host)[0]!)
    await click(buttonNamed(view.host, 'Edit blob'))
    await click(tabNamed(view.host, 'Settings'))
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
    await click(buttonNamed(view.host, 'Create blob'))
    await click(tabNamed(view.host, 'Settings'))
    await typeInto(field(view.host, 'Name') as HTMLInputElement, 'Fresh blob')
    const save = [...view.host.querySelectorAll('button')].find((button) => button.classList.contains('primary-button') && button.textContent?.includes('Create blob'))
    await click(save)
    await view.settle()
    expect(view.host.querySelector('.blob-page-heading')?.textContent).toBe('Fresh blob')
    await click(buttonNamed(view.host, 'Back'))
    await view.settle()
    expect(view.host.querySelector('.blob-page')).toBeNull()
    expect(document.activeElement).toBe(view.host.querySelector('[data-agent-id="agent-copy"]'))
    expect(document.activeElement?.textContent).toContain('Fresh blob')
  })

  it('starts collapsed so a session row is not mounted on first paint', async () => {
    const view = startApp()
    await view.settle()
    expect(rows(view.host).every((row) => row.getAttribute('aria-expanded') === 'false')).toBe(true)
    expect(view.host.querySelector('[data-session-id]')).toBeNull()
  })

  it('expands in place with Right and keeps Arrow Down on blob rows while collapsed', async () => {
    const view = startApp()
    await view.settle()
    const [first, second] = rows(view.host)
    first?.focus()
    await press(first!, 'ArrowDown')
    expect(document.activeElement).toBe(second)
    expect(first?.getAttribute('aria-current')).toBe('true')
    await press(second!, 'ArrowUp')
    const claude = rows(view.host)[0]!
    await press(claude, 'ArrowRight')
    expect(claude.getAttribute('aria-expanded')).toBe('true')
    expect(claude.getAttribute('aria-current')).toBe('true')
    await press(claude, 'ArrowDown')
    const project = document.activeElement as HTMLElement
    expect(project.getAttribute('data-tree-kind')).toBe('project')
    expect(project.tabIndex).toBe(0)
    expect(claude.tabIndex).toBe(-1)
    expect(claude.getAttribute('aria-current')).toBe('true')
    await press(project, 'Enter')
    expect(project.getAttribute('aria-expanded')).toBe('true')
    await press(project, 'ArrowDown')
    const sessionRow = document.activeElement as HTMLElement
    await press(sessionRow, 'Enter')
    expect(sessionRow.getAttribute('aria-selected')).toBe('true')
    expect(claude.getAttribute('aria-current')).toBe('true')
    await press(sessionRow, 'ArrowLeft')
    const focusedProject = document.activeElement as HTMLElement
    expect(focusedProject.getAttribute('data-tree-kind')).toBe('project')
    expect(focusedProject.getAttribute('aria-expanded')).toBe('true')
    await press(focusedProject, 'ArrowLeft')
    expect(focusedProject.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(focusedProject)
    expect(focusedProject.tabIndex).toBe(0)
  })

  it('moves type-ahead to OpenCode without changing the current blob', async () => {
    const view = startApp()
    await view.settle()
    const claude = rows(view.host)[0]!
    claude.focus()
    await press(claude, 'o')
    const open = rows(view.host).find((row) => row.getAttribute('data-agent-id') === 'agent-opencode')
    expect(document.activeElement).toBe(open)
    expect(open?.tabIndex).toBe(0)
    expect(claude.getAttribute('aria-current')).toBe('true')
  })

  it('focuses the project after its session unmounts on collapse', async () => {
    const view = startApp()
    await view.settle()
    const claude = rows(view.host)[0]!
    claude.focus()
    await press(claude, 'ArrowRight')
    await press(claude, 'ArrowDown')
    const project = document.activeElement as HTMLElement
    await press(project, 'Enter')
    await press(project, 'ArrowDown')
    const sessionRow = document.activeElement as HTMLElement
    expect(sessionRow.tabIndex).toBe(0)
    const chevron = project.querySelector('.tree-chevron')
    await act(async () => {
      chevron?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      ;(chevron as HTMLElement).click()
    })
    await view.settle()
    expect(view.host.querySelector('[data-session-id]')).toBeNull()
    expect(document.activeElement?.getAttribute('data-tree-kind')).toBe('project')
    expect((document.activeElement as HTMLElement | null)?.tabIndex).toBe(0)
  })

  it('numbers blob positions across headings and session positions inside one project', async () => {
    const view = startApp()
    await view.settle()
    expect(rows(view.host).map((row) => row.getAttribute('aria-setsize'))).toEqual(['4', '4', '4', '4'])
    expect(rows(view.host).map((row) => row.getAttribute('aria-posinset'))).toEqual(['1', '2', '3', '4'])
    const codex = rows(view.host)[1]!
    codex.focus()
    await press(codex, 'ArrowRight')
    const level2 = [...view.host.querySelectorAll<HTMLElement>('[aria-level="2"]')]
    expect(level2.map((row) => row.getAttribute('aria-setsize'))).toEqual(level2.map(() => String(level2.length)))
    expect(level2.some((row) => row.getAttribute('aria-label') === 'Other sessions')).toBe(true)
    view.unmount()
    h.fetchSnapshot.mockResolvedValue(snapshot({
      sessions: [...sessions, session({ id: 'session-codex-b', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Second site', projectPath: 'C:/work/site', updatedAt: '2026-10-02T02:00:00.000Z' })],
    }))
    const again = startApp()
    await again.settle()
    const codexAgain = rows(again.host)[1]!
    codexAgain.focus()
    await press(codexAgain, 'ArrowRight')
    const project = again.host.querySelector<HTMLElement>('[data-tree-kind="project"]')!
    project.focus()
    await press(project, 'Enter')
    const level3 = [...again.host.querySelectorAll<HTMLElement>('[data-tree-kind="session"]')]
    expect(level3.map((row) => row.getAttribute('aria-setsize'))).toEqual(['2', '2'])
    expect(level3.map((row) => row.getAttribute('aria-posinset'))).toEqual(['1', '2'])
  })

  it('shows 12 projects and reveals the oldest after Show 1 more project', async () => {
    const many = Array.from({ length: 13 }, (_, index) => session({
      id: `proj-${index}`, runtimeId: 'runtime-claude', agentId: 'agent-claude', title: `Project ${index}`,
      projectPath: `C:\\work\\folder-${String(index).padStart(2, '0')}`, updatedAt: `2026-10-02T${String(index).padStart(2, '0')}:00:00.000Z`,
    }))
    h.fetchSnapshot.mockResolvedValue(snapshot({ sessions: many }))
    const view = startApp()
    await view.settle()
    const claude = rows(view.host)[0]!
    claude.focus()
    await press(claude, 'ArrowRight')
    const projects = [...view.host.querySelectorAll('[data-tree-kind="project"]')]
    expect(projects).toHaveLength(12)
    const more = view.host.querySelector('[data-tree-kind="more"]')
    expect(more?.textContent).toBe('Show 1 more project')
    const labels = projects.map((row) => row.querySelector('.tree-label')?.textContent)
    expect(labels).toContain('folder-12')
    expect(labels).not.toContain('folder-00')
    await press(more!, 'Enter')
    expect(view.host.querySelectorAll('[data-tree-kind="project"]')).toHaveLength(13)
    expect([...view.host.querySelectorAll('.tree-label')].some((node) => node.textContent === 'folder-00')).toBe(true)
  })

  it('selects the activated session instead of substituting the latest one', async () => {
    h.fetchSnapshot.mockResolvedValue(snapshot({
      sessions: [...sessions,
        session({ id: 'session-invoice-a', runtimeId: 'runtime-codex', agentId: 'agent-invoice', title: 'North site', projectPath: 'C:\\client\\site', updatedAt: '2026-10-02T03:00:00.000Z' }),
        session({ id: 'session-invoice-b', runtimeId: 'runtime-codex', agentId: 'agent-invoice', title: 'South site', projectPath: 'D:\\other\\site', state: 'working', updatedAt: '2026-10-01T00:00:00.000Z' }),
      ],
    }))
    const view = startApp()
    await view.settle()
    const invoiceRow = rows(view.host).find((row) => row.getAttribute('data-agent-id') === 'agent-invoice')!
    invoiceRow.focus()
    await press(invoiceRow, 'ArrowRight')
    for (const project of [...view.host.querySelectorAll<HTMLElement>('[data-tree-kind="project"]')]) {
      project.focus()
      await press(project, 'Enter')
    }
    const target = view.host.querySelector<HTMLElement>('[data-session-id="session-invoice-b"]')!
    const other = view.host.querySelector<HTMLElement>('[data-session-id="session-invoice-a"]')!
    target.focus()
    await press(target, 'Enter')
    await view.settle()
    expect(invoiceRow.getAttribute('aria-current')).toBe('true')
    expect(target.getAttribute('aria-selected')).toBe('true')
    expect(other.getAttribute('aria-selected')).toBe('false')
    expect(h.setActiveSession).toHaveBeenCalledWith('session-invoice-b')
  })

  it('places Untied notes only on the host and leaves a ghost runtime unselected', async () => {
    const view = startApp()
    await view.settle()
    const codexRow = rows(view.host)[1]!
    await click(codexRow)
    await view.settle()
    codexRow.focus()
    await press(codexRow, 'ArrowRight')
    const other = view.host.querySelector<HTMLElement>('[aria-label="Other sessions"]')!
    other.focus()
    await press(other, 'Enter')
    const notes = view.host.querySelector<HTMLElement>('[data-session-id="session-legacy"]')!
    notes.focus()
    await press(notes, 'Enter')
    await view.settle()
    expect(codexRow.getAttribute('aria-current')).toBe('true')
    expect(notes.getAttribute('aria-selected')).toBe('true')
    const invoiceRow = rows(view.host).find((row) => row.getAttribute('data-agent-id') === 'agent-invoice')!
    invoiceRow.focus()
    await press(invoiceRow, 'ArrowRight')
    const invoiceGroup = view.host.querySelector('#blob-group-agent-invoice')
    expect(invoiceGroup?.querySelector('[aria-label="Other sessions"]')).toBeNull()
    expect(invoiceGroup?.textContent ?? '').not.toContain('Untied notes')
    view.unmount()
    h.fetchSnapshot.mockResolvedValue(snapshot({ agents: [claude, { ...codex, archived: true }, invoice, opencode, retired] }))
    const moved = startApp()
    await moved.settle()
    const host = rows(moved.host).find((row) => row.getAttribute('data-agent-id') === 'agent-invoice')!
    host.focus()
    await press(host, 'ArrowRight')
    expect(moved.host.querySelector('#blob-group-agent-invoice [aria-label="Other sessions"]')).not.toBeNull()
    moved.unmount()
    h.fetchSnapshot.mockResolvedValue(snapshot({
      sessions: [...sessions, session({ id: 'session-ghost', runtimeId: 'runtime-ghost', agentId: null, title: 'Ghost notes' })],
    }))
    const ghost = startApp()
    await ghost.settle()
    expect(ghost.host.textContent).not.toContain('Ghost notes')
    expect(rows(ghost.host)[0]?.getAttribute('aria-current')).toBe('true')
  })

  it('sends the stored project path from + and from Choose folder...', async () => {
    const view = startApp()
    await view.settle()
    const claude = rows(view.host)[0]!
    claude.focus()
    await press(claude, 'ArrowRight')
    await click(view.host.querySelector('[aria-label="New session in site"]'))
    await view.settle()
    const plus = h.rpc.mock.calls.filter((entry) => entry[0] === 'session.new').at(-1)
    expect(plus?.[1]).toEqual({ agentId: 'agent-claude', projectPath: 'C:/work/site' })
    expect(Object.keys(plus?.[1] as object)).toEqual(['agentId', 'projectPath'])
    await click(buttonNamed(view.host, 'Session'))
    await click(menuItem(view.host, 'Choose folder...'))
    await view.settle()
    const picked = h.rpc.mock.calls.filter((entry) => entry[0] === 'session.new').at(-1)
    expect(picked?.[1]).toEqual({ agentId: 'agent-claude', projectPath: 'C:/work/site' })
    expect(Object.keys(picked?.[1] as object)).toEqual(['agentId', 'projectPath'])
  })

  it('pins a default project and opens the folder picker once when that path is rejected', async () => {
    h.fetchSnapshot.mockResolvedValue(snapshot({ agents: [{ ...claude, defaultProject: 'C:/work/site' }, codex, invoice, opencode, retired] }))
    const view = startApp()
    await view.settle()
    await click(buttonNamed(view.host, 'Session'))
    const first = view.host.querySelector('[role="menu"] [role="menuitem"]')
    expect(first?.textContent?.trim().endsWith('Default')).toBe(true)
    h.sessionError = 'invalid_argument: missing folder'
    await click(first)
    await view.settle()
    expect(view.host.textContent).toContain('Choose a project folder that exists on this device.')
    expect(h.openProjectFolder).toHaveBeenCalledTimes(1)
    expect(h.rpc.mock.calls.filter((entry) => entry[0] === 'agent.update')).toHaveLength(0)
  })

  it('expands a title match without writing bloblex.roster.expanded', async () => {
    h.fetchSnapshot.mockResolvedValue(snapshot({
      sessions: [...sessions, session({ id: 'session-claude-2', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Hero follow-up', projectPath: 'c:\\work\\site\\', updatedAt: '2026-10-02T04:00:00.000Z' })],
    }))
    const view = startApp()
    await view.settle()
    const search = view.host.querySelector<HTMLInputElement>('[aria-label="Search agents and conversations"]')
    await typeInto(search, 'follow-up')
    expect(rows(view.host)[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(view.host.querySelector('[data-tree-kind="project"]')?.getAttribute('aria-expanded')).toBe('true')
    expect((localStorage.setItem as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[0] === 'bloblex.roster.expanded')).toBe(false)
    await typeInto(search, '')
    expect(view.host.querySelector('[data-session-id]')).toBeNull()
    await typeInto(search, 'Invoice')
    expect(rows(view.host).find((row) => row.getAttribute('data-agent-id') === 'agent-invoice')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('restores expanded blobs and keeps the chevron when storage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => key === 'bloblex.roster.expanded' ? JSON.stringify({ v: 1, blobs: { 'agent-claude': { open: true, projects: {}, other: false } } }) : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    })
    const view = startApp()
    await view.settle()
    const claude = rows(view.host)[0]!
    expect(claude.getAttribute('aria-expanded')).toBe('true')
    await click(claude.querySelector('.tree-chevron'))
    expect(claude.getAttribute('aria-expanded')).toBe('false')
    const saved = (localStorage.setItem as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === 'bloblex.roster.expanded')
    expect(JSON.parse(String(saved?.[1])).blobs['agent-claude'].open).toBe(false)
    ;(localStorage.setItem as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('blocked') })
    await click(claude.querySelector('.tree-chevron'))
    expect(claude.getAttribute('aria-expanded')).toBe('true')
    expect(rows(view.host)).toHaveLength(4)
    view.unmount()
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
      clear: () => { throw new Error('blocked') },
    })
    const again = startApp()
    await again.settle()
    expect(rows(again.host)).toHaveLength(4)
    expect(rows(again.host).every((row) => row.getAttribute('aria-expanded') === 'false')).toBe(true)
  })

  it('caps one project at 30 conversations and reveals Bulk 1 from show more', async () => {
    const bulk = Array.from({ length: 31 }, (_, index) => {
      const n = index + 1
      return session({ id: `session-codex-many-${n}`, runtimeId: 'runtime-codex', agentId: 'agent-codex', title: `Bulk ${n}`, projectPath: 'C:\\work\\korus', updatedAt: `2026-10-02T00:${String(n).padStart(2, '0')}:00.000Z` })
    })
    h.fetchSnapshot.mockResolvedValue(snapshot({ sessions: [...sessions.filter((item) => item.agentId !== 'agent-codex'), ...bulk] }))
    const view = startApp()
    await view.settle()
    const codex = rows(view.host)[1]!
    codex.focus()
    await press(codex, 'ArrowRight')
    const project = [...view.host.querySelectorAll<HTMLElement>('[data-tree-kind="project"]')].find((row) => row.getAttribute('title') === 'C:\\work\\korus')!
    project.focus()
    await press(project, 'Enter')
    const titles = [...view.host.querySelectorAll('[data-tree-kind="session"]')].map((row) => row.querySelector('.tree-label')?.textContent)
    expect(titles).toHaveLength(30)
    expect(titles).toContain('Bulk 31')
    expect(titles).not.toContain('Bulk 1')
    const more = [...view.host.querySelectorAll('[data-tree-kind="more"]')].find((row) => row.textContent === 'Show 1 more conversation')
    await press(more!, 'Enter')
    expect([...view.host.querySelectorAll('.tree-label')].some((node) => node.textContent === 'Bulk 1')).toBe(true)
  })

  it('shows offline Codex conversations and disables New session', async () => {
    h.fetchSnapshot.mockResolvedValue(snapshot({ runtimes: [claudeRuntime, { ...codexRuntime, status: 'offline' }, opencodeRuntime] }))
    const view = startApp()
    await view.settle()
    const codex = rows(view.host)[1]!
    codex.focus()
    await press(codex, 'ArrowRight')
    expect(view.host.querySelector('[data-tree-kind="project"]')).not.toBeNull()
    await openMenu(codex)
    expect(buttonNamed(view.host, 'New session')?.hasAttribute('disabled')).toBe(true)
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

  it('syncs the companion title to the selected session and a pill to the latest owned session', async () => {
    const follow = session({ id: 'session-claude-2', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Hero follow-up', projectPath: 'c:\\work\\site\\', updatedAt: '2026-10-02T04:00:00.000Z' })
    h.fetchSnapshot.mockResolvedValue(snapshot({ sessions: [...sessions, follow] }))
    const view = startApp()
    await view.settle()
    const claude = rows(view.host)[0]!
    claude.focus()
    await press(claude, 'ArrowRight')
    const project = view.host.querySelector<HTMLElement>('[data-tree-kind="project"]')!
    project.focus()
    await press(project, 'Enter')
    const row = view.host.querySelector<HTMLElement>('[data-session-id="session-claude-2"]')!
    row.focus()
    await press(row, 'Enter')
    await view.settle()
    expect(h.setActiveSession).toHaveBeenCalledWith('session-claude-2')
    view.unmount()
    h.getActiveSession.mockResolvedValue('session-claude-2')
    const companion = startApp('?companion=1')
    await companion.settle()
    await click(buttonNamed(companion.host, 'Complete greeting fixture'))
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    await click(buttonNamed(companion.host, 'Open companion home'))
    await companion.settle()
    expect(companion.host.querySelector('.tool')?.textContent).toBe('Hero follow-up')
    h.setActiveSession.mockClear()
    await click([...companion.host.querySelectorAll('.pill')].find((node) => node.textContent?.includes('Codex')))
    await companion.settle()
    expect(h.setActiveSession).toHaveBeenCalledWith('session-codex')
    expect(h.setActiveSession.mock.calls.some((call) => call[0] === 'session-claude-2')).toBe(false)
  })
})
