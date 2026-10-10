// @vitest-environment happy-dom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonEvent, Runtime, Session, Snapshot } from '../types'
import { analyticsFixtures } from './analyticsFixtures'
import { buildAnalyticsRequest, resolvedTimeZone } from './analyticsFormat'

const h = vi.hoisted(() => ({
  rpc: vi.fn(), fetchSnapshot: vi.fn(), ensureDaemon: vi.fn(), startDaemonEventStream: vi.fn(),
  getActiveSession: vi.fn(), getActiveRuntime: vi.fn(), setActiveSession: vi.fn(), setActiveRuntime: vi.fn(),
  setCompanionMode: vi.fn(), setCompanionVisibility: vi.fn(), showMainWindow: vi.fn(), showMainSettings: vi.fn(),
  companionMonitorOptions: vi.fn(), currentCompanionMonitor: vi.fn(), setCompanionMonitor: vi.fn(), refreshTrayMenu: vi.fn(),
  listenForDaemonEvents: vi.fn(), listenForDaemonConnection: vi.fn(), listenForActiveSession: vi.fn(),
  listenForActiveRuntime: vi.fn(), listenForOpenSettings: vi.fn(), directListen: vi.fn(), emit: vi.fn(),
  getCurrentWindow: vi.fn(), openProjectFolder: vi.fn(), fetchUsageAnalytics: vi.fn(),
  selectMarkdownExportPath: vi.fn(), writeMarkdownExport: vi.fn(), selectBlobExportPath: vi.fn(), writeBlobExport: vi.fn(),
  selectBlobImportPath: vi.fn(), readBlobImport: vi.fn(),
}))

vi.mock('../desktopIntegrations', () => ({ autostartEnabled: async () => false, setAutostartEnabled: async () => undefined, sendDesktopNotification: async () => undefined, flashMainWindow: async () => undefined }))
vi.mock('../tauri', () => ({
  inDesktop: true,
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
  selectLocalFile: vi.fn(), inspectLocalFile: vi.fn(),
  selectMarkdownExportPath: h.selectMarkdownExportPath, writeMarkdownExport: h.writeMarkdownExport,
  selectBlobExportPath: h.selectBlobExportPath, writeBlobExport: h.writeBlobExport,
  selectBlobImportPath: h.selectBlobImportPath, readBlobImport: h.readBlobImport,
  openInEditor: vi.fn(), revealInExplorer: vi.fn(), resolveProjectFile: vi.fn(),
  quitBloblex: vi.fn(), setCloseToTray: vi.fn(),
  fetchUsageAnalytics: h.fetchUsageAnalytics,
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
  setCompanionSoundsEnabled: vi.fn(), disposeCompanionAudio: vi.fn(),
}))
vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: (props: Record<string, unknown>) => <span data-shape={(props.look as { shape?: string } | null | undefined)?.shape ?? 'mascot'} /> }))

import { App } from './App'

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
const claude = agent({ id: 'agent-claude', name: 'Claude', color: 'coral', runtimeId: 'runtime-claude', sortOrder: 0 })
const sessions: Session[] = [
  { id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Landing page copy', projectPath: 'C:/work/site', state: 'idle', updatedAt: stamp, contextUsed: 413000, contextSize: 828000, messages: [{ id: 'm1', role: 'user', text: 'Make the heading concise.', createdAt: stamp }, { id: 'm2', role: 'assistant', text: 'I shortened the heading.', createdAt: stamp }] },
]

function snapshot(): Snapshot {
  return { sequence: 4, runtimes: [runtime({ id: 'runtime-claude', provider: 'claude' })], agents: [claude], sessions, permissions: [], usage: [] }
}

const mounted: Array<{ unmount: () => void }> = []

function startApp() {
  window.history.replaceState({}, '', '/')
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => { root.render(<StrictMode><App /></StrictMode>) })
  const view = {
    host,
    async settle() {
      await act(async () => {
        for (let index = 0; index < 20; index += 1) await Promise.resolve()
        await vi.advanceTimersByTimeAsync(40)
        for (let index = 0; index < 20; index += 1) await Promise.resolve()
      })
    },
    unmount() { act(() => root.unmount()); host.remove() },
  }
  mounted.push(view)
  return view
}

function buttonNamed(root: ParentNode, name: string) {
  return [...root.querySelectorAll('button')].find((button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim() === name || button.getAttribute('aria-label') === name)
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error('missing element')
  await act(async () => { (element as HTMLElement).click() })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() })
  for (const mock of Object.values(h)) if (typeof mock === 'function' && 'mockReset' in mock) mock.mockReset()
  const stop = vi.fn()
  h.fetchSnapshot.mockResolvedValue(snapshot())
  h.ensureDaemon.mockResolvedValue(undefined)
  h.startDaemonEventStream.mockResolvedValue(undefined)
  h.getActiveSession.mockResolvedValue('session-claude')
  h.getActiveRuntime.mockResolvedValue('runtime-claude')
  h.setActiveSession.mockResolvedValue(undefined)
  h.setActiveRuntime.mockResolvedValue(undefined)
  h.companionMonitorOptions.mockResolvedValue([])
  h.currentCompanionMonitor.mockResolvedValue(null)
  h.refreshTrayMenu.mockResolvedValue(undefined)
  h.openProjectFolder.mockResolvedValue(null)
  h.rpc.mockImplementation(async (method: string) => {
    if (method === 'events.replay') return { replayAvailable: true, events: [] }
    if (method === 'settings.get') return { settings: {} }
    if (method === 'agent.get') return { agent: claude }
    return {}
  })
  h.listenForDaemonEvents.mockResolvedValue(stop)
  h.listenForDaemonConnection.mockResolvedValue(stop)
  h.listenForActiveSession.mockResolvedValue(stop)
  h.listenForActiveRuntime.mockResolvedValue(stop)
  h.listenForOpenSettings.mockResolvedValue(stop)
  h.directListen.mockResolvedValue(stop)
  h.getCurrentWindow.mockReturnValue({ onDragDropEvent: vi.fn().mockResolvedValue(stop) })
  h.fetchUsageAnalytics.mockResolvedValue(analyticsFixtures.full)
  h.selectMarkdownExportPath.mockResolvedValue('selected-markdown-token')
  h.writeMarkdownExport.mockResolvedValue(undefined)
  h.selectBlobExportPath.mockResolvedValue('selected-blob-export-token')
  h.writeBlobExport.mockResolvedValue(undefined)
  h.selectBlobImportPath.mockResolvedValue('selected-blob-import-token')
  h.readBlobImport.mockResolvedValue(JSON.stringify({ format: 'bloblex.blob.v1', name: 'Imported helper', description: 'Shared', colour: '#aabbcc', instructions: 'Use concise answers.', model: null, thinking: null, speed: null, look: { shape: 'droplet', seed: 'imported' }, defaultApprovalMode: 'ask' }))
})

afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

describe('sidebar usage analytics', () => {
  it('shows all supported structured provider quotas in the shell and Usage sheet', async () => {
    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'events.replay') return { replayAvailable: true, events: [] }
      // The bottom usage bar is an experimental feature, off unless enabled.
      if (method === 'settings.get') return { settings: { 'experimental.usageBar': true } }
      if (method === 'quota.list') return { quotas: [
        { provider: 'codex', runtimeId: 'runtime-codex', fetchedAt: '2026-10-02T11:55:00Z', snapshot: { limits: [{ label: 'Codex', primary: { usedPercent: 62, remainingPercent: 38, windowDurationMins: 300, resetsAt: '2026-10-02T17:00:00Z' }, secondary: { usedPercent: 27, remainingPercent: 73, windowDurationMins: 10080, resetsAt: '2026-10-09T17:00:00Z' } }] } },
        { provider: 'claude', runtimeId: 'runtime-claude', fetchedAt: '2026-10-02T11:55:00Z', snapshot: { limits: [{ label: 'Claude Code', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: '2026-10-02T17:00:00Z' }, secondary: null }] } },
        { provider: 'opencode', runtimeId: 'runtime-opencode', fetchedAt: '2026-10-02T11:55:00Z', lastError: 'unavailable', snapshot: { limits: [{ label: '5-hour', primary: { usedPercent: 120, windowDurationMins: 300, resetsAt: '2026-10-02T17:00:00Z' }, secondary: null }] } },
        { provider: 'generic-opencode', snapshot: { limits: [{ label: 'Generic provider', primary: { usedPercent: 99 } }] } },
      ] }
      if (method === 'usage.summary') return { from: '2026-10-02T00:00:00Z', to: '2026-10-02T12:00:00Z', inputTokens: 120, outputTokens: 80 }
      if (method === 'agent.get') return { agent: claude }
      return {}
    })
    const view = startApp()
    await view.settle()
    expect(view.host.querySelector('.context-window-indicator')?.getAttribute('aria-label')).toContain('413,000 of 828,000 tokens used, 50%')
    expect(view.host.querySelector('[role="progressbar"][aria-label="Context window used"]')?.getAttribute('aria-valuenow')).toBe('50')
    expect(view.host.querySelector('.context-window-ring-value')?.getAttribute('stroke-dasharray')).toBeTruthy()
    expect(view.host.querySelector('.context-window-center')).toBeNull()
    const row = view.host.querySelector<HTMLButtonElement>('.quota-bar-trigger')
    // Status bar: one chip per supported provider, ordered Claude, Codex, OpenCode Go.
    expect([...row!.querySelectorAll('.quota-chip')].map((chip) => chip.getAttribute('data-provider'))).toEqual(['claude', 'codex', 'opencode'])
    expect(row?.textContent).toContain('62% used')
    expect(row?.textContent).toContain('27% used')
    expect(row?.textContent).not.toContain('Generic provider')
    expect(row?.getAttribute('aria-label')).toContain('Codex: Session 62% used')
    expect(row?.getAttribute('aria-label')).toContain('OpenCode Go: Session 100% used')
    expect(row?.querySelector('.quota-chip[data-provider="codex"] .quota-meter > b')?.getAttribute('style')).toContain('width: 62%')
    expect(row?.querySelector('.quota-chip[data-provider="opencode"] .quota-meter > b')?.getAttribute('style')).toContain('width: 100%')
    expect(row?.querySelector('.quota-chip[data-provider="opencode"] .quota-meter')?.classList.contains('tone-critical')).toBe(true)
    expect(row?.querySelector('.quota-chip[data-provider="opencode"] .quota-chip-warning')).not.toBeNull()
    for (const provider of ['claude', 'codex', 'opencode']) {
      expect(view.host.querySelector(`.quota-chip[data-provider="${provider}"] .provider-logo`)?.getAttribute('aria-hidden')).toBe('true')
    }
    // Usage popover with a hover flyout per provider.
    await click(row)
    await view.settle()
    const popover = view.host.querySelector('.usage-popover')
    expect(popover?.getAttribute('role')).toBe('dialog')
    const codexRow = [...popover!.querySelectorAll<HTMLButtonElement>('.usage-row')].find((item) => item.textContent?.includes('Codex'))!
    expect(codexRow.textContent).toContain('5h')
    expect(codexRow.textContent).toContain('wk')
    await act(async () => { codexRow.focus() })
    expect(view.host.querySelector('.usage-flyout')?.textContent).toContain('Weekly')
    expect(view.host.querySelector('.usage-flyout')?.textContent).toContain('27% used')
    await click(buttonNamed(view.host, 'Compact'))
    expect(view.host.querySelector('.usage-rows')?.classList.contains('compact')).toBe(true)
    await click(view.host.querySelector<HTMLButtonElement>('.usage-popover-link'))
    await view.settle()
    expect(view.host.querySelector('.usage-popover')).toBeNull()
    expect(view.host.querySelector('.usage-sheet')).not.toBeNull()
    // Plan limits come before token usage in the sheet.
    const blocks = [...view.host.querySelectorAll('.usage-sheet-body > .usage-block')]
    expect(blocks[0]?.classList.contains('quota-details')).toBe(true)
    expect(blocks[1]?.textContent).toContain('Token usage')
    expect(view.host.querySelector('.quota-details')?.textContent).toContain('62%')
    expect(view.host.querySelector('.quota-details')?.textContent).toContain('27%')
    expect(view.host.querySelector('.quota-details')?.textContent).toContain('Resets in')
    expect(view.host.querySelector('.quota-details')?.textContent).toContain('Claude')
    expect(view.host.querySelector('.quota-details')?.textContent).toContain('OpenCode Go')
    expect(view.host.querySelector('.quota-details')?.textContent).toContain('last successful reading retained')
    expect(view.host.querySelector('.quota-card[data-provider="opencode"]')?.textContent).toContain('Unavailable')
    expect(view.host.querySelector('.quota-details')?.textContent).not.toContain('Generic provider')
    expect(view.host.textContent).toContain('Token usage')
    await click(buttonNamed(view.host, 'Refresh quota'))
    expect(h.rpc).toHaveBeenCalledWith('quota.refresh')
    expect(buttonNamed(view.host, 'Checking…')?.hasAttribute('disabled')).toBe(true)
  })

  it('opens analytics from Usage, requests the local timezone, and returns focus on Back', async () => {
    const view = startApp()
    await view.settle()
    const profile = view.host.querySelector<HTMLButtonElement>('.profile-button')
    await click(profile)
    const usage = [...view.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.includes('Usage'))
    expect(usage?.disabled).toBe(false)
    await click(usage)
    await view.settle()
    expect(view.host.querySelector('.analytics-page')).not.toBeNull()
    expect(view.host.querySelector('.chat-header')).toBeNull()
    expect(document.activeElement?.textContent).toBe('Back')
    const tz = resolvedTimeZone()
    const expected = buildAnalyticsRequest({ days: 7, bucket: 'day', now: new Date('2026-10-02T12:00:00.000Z'), timeZone: tz })
    const sent = h.fetchUsageAnalytics.mock.calls.map((call) => call[0] as { from: string; to: string; bucket: string; tz: string; agentId?: string })
    expect(sent.some((request) => request.from === expected.from && request.to === expected.to && request.bucket === 'day' && request.tz === tz && request.agentId === undefined)).toBe(true)
    await click(buttonNamed(view.host, 'Back'))
    await view.settle()
    expect(view.host.querySelector('.analytics-page')).toBeNull()
    expect(document.activeElement).toBe(profile)
  })

  it('keeps context percent unknown when the provider has not reported both window values', async () => {
    h.fetchSnapshot.mockResolvedValue({ ...snapshot(), sessions: [{ ...sessions[0], contextUsed: undefined, contextSize: undefined }] })
    const view = startApp()
    await view.settle()
    expect(view.host.querySelector('.context-window-indicator')?.getAttribute('aria-label')).toContain('Context window: Context usage unavailable')
    expect(view.host.querySelector('.context-window-indicator')?.classList.contains('tone-unknown')).toBe(true)
    expect(view.host.querySelector('[role="progressbar"][aria-label="Context window used"]')).toBeNull()
  })

  it('syncs the message outline to scroll and supports keyboard navigation, scrubbing, previews and reduced motion', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable:true, value:scrollIntoView })
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches:query.includes('prefers-reduced-motion'), media:query, onchange:null, addListener:vi.fn(), removeListener:vi.fn(), addEventListener:vi.fn(), removeEventListener:vi.fn(), dispatchEvent:vi.fn(() => true) }))
    h.fetchSnapshot.mockResolvedValue({ ...snapshot(), sessions:[{ ...sessions[0], messages:[
      { id:'outline-1', role:'user', text:'First question about a menu.' },
      { id:'outline-2', role:'assistant', text:'I will inspect the menu behavior.' },
      { id:'outline-3', role:'user', text:'Please change the menu label.' },
    ] }] })
    const view = startApp()
    await view.settle()
    const outline = view.host.querySelector<HTMLElement>('[role="slider"][aria-label="Conversation message position"]')!
    expect(outline.getAttribute('aria-valuemax')).toBe('3')
    act(() => outline.focus())
    await act(async () => outline.dispatchEvent(new KeyboardEvent('keydown', { key:'End', bubbles:true })))
    expect(outline.getAttribute('aria-valuenow')).toBe('3')
    expect(outline.getAttribute('aria-valuetext')).toContain('Message 3 of 3')
    expect(outline.getAttribute('aria-valuetext')).toContain('You: Please change the menu label.')
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block:'center', behavior:'auto' }))
    expect(view.host.querySelector('.conversation-outline-preview')?.textContent).toContain('Please change the menu label.')
    await act(async () => outline.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })))
    expect(view.host.querySelector('.conversation-outline-preview')).toBeNull()

    const pointer = (type: string, y: number) => {
      const event = new Event(type, { bubbles:true })
      Object.defineProperties(event, { pointerId:{ value:1 }, clientY:{ value:y }, isPrimary:{ value:true } })
      return event
    }
    Object.defineProperty(outline, 'getBoundingClientRect', { configurable:true, value:() => ({ top:0, bottom:100, height:100, left:0, right:18, width:18, x:0, y:0, toJSON:() => ({}) }) })
    const scrollCallsBeforeHover = scrollIntoView.mock.calls.length
    await act(async () => { outline.dispatchEvent(pointer('pointermove', 50)) })
    expect(outline.getAttribute('aria-valuenow')).toBe('3')
    expect(scrollIntoView).toHaveBeenCalledTimes(scrollCallsBeforeHover)
    expect(view.host.querySelector('.conversation-outline-preview')).not.toBeNull()
    await act(async () => { outline.dispatchEvent(pointer('pointerdown', 0)) })
    await act(async () => { outline.dispatchEvent(pointer('pointermove', 100)); outline.dispatchEvent(pointer('pointerup', 100)) })
    expect(outline.getAttribute('aria-valuenow')).toBe('3')

    const list = view.host.querySelector<HTMLElement>('.message-list')!
    Object.defineProperty(list, 'getBoundingClientRect', { configurable:true, value:() => ({ top:0, bottom:300, height:300, left:0, right:600, width:600, x:0, y:0, toJSON:() => ({}) }) })
    const positions = [['outline-1', 0], ['outline-2', 110], ['outline-3', 270]] as const
    for (const [id, top] of positions) {
      const node = document.getElementById(`conversation-message-message%3A${id}`)!
      Object.defineProperty(node, 'getBoundingClientRect', { configurable:true, value:() => ({ top, bottom:top+30, height:30, left:20, right:500, width:480, x:20, y:top, toJSON:() => ({}) }) })
    }
    await act(async () => { list.dispatchEvent(new Event('scroll')); await vi.advanceTimersByTimeAsync(40) })
    expect(outline.getAttribute('aria-valuenow')).toBe('2')
    expect(document.getElementById('conversation-message-message%3Aoutline-3')).not.toBeNull()
  })

  it('samples long conversations without losing the full outline range', async () => {
    h.fetchSnapshot.mockResolvedValue({ ...snapshot(), sessions:[{ ...sessions[0], messages:Array.from({ length:160 }, (_, index) => ({ id:`long-${index}`, role:index % 2 ? 'assistant' : 'user', text:`Message ${index + 1}` })) }] })
    const view = startApp()
    await view.settle()
    const rail = view.host.querySelector<HTMLElement>('[role="slider"][aria-label="Conversation message position"]')!
    expect(rail.getAttribute('aria-valuemax')).toBe('160')
    expect(rail.querySelectorAll('.conversation-outline-tick')).toHaveLength(64)
    await act(async () => rail.dispatchEvent(new KeyboardEvent('keydown', { key:'End', bubbles:true })))
    expect(rail.getAttribute('aria-valuenow')).toBe('160')
    expect(rail.getAttribute('aria-valuetext')).toContain('Message 160')
  })

  it('mounts the message outline when an initially empty selected session receives its first messages', async () => {
    h.fetchSnapshot.mockResolvedValue({ ...snapshot(), sessions:[{ ...sessions[0], messages:[] }] })
    let receive: ((event: DaemonEvent) => void) | undefined
    h.listenForDaemonEvents.mockImplementation(async (handler: (event: DaemonEvent) => void) => { receive = handler; return vi.fn() })
    const view = startApp()
    await view.settle()
    expect(view.host.querySelector('[aria-label="Conversation message outline"]')).toBeNull()
    await act(async () => {
      receive?.({ v:1, type:'session.changed', sequence:5, payload:{ session:{ ...sessions[0], messages:[
        { id:'first-1', role:'user', text:'First message' },
        { id:'first-2', role:'assistant', text:'Second message' },
        { id:'first-3', role:'user', text:'Third message' },
      ] } } })
      for (let index=0; index<8; index+=1) await Promise.resolve()
    })
    expect(view.host.querySelector('[role="slider"][aria-label="Conversation message position"]')).not.toBeNull()
  })

  it('copies and exports the selected conversation through the mocked file bridge', async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboardWrite } })
    const view = startApp()
    await view.settle()
    await click(buttonNamed(view.host, 'More options'))
    await click(buttonNamed(view.host, 'Copy as Markdown'))
    expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining('# Landing page copy'))
    expect(clipboardWrite.mock.calls[0]?.[0]).toContain('Make the heading concise.')
    await click(buttonNamed(view.host, 'More options'))
    await click(buttonNamed(view.host, 'Export as Markdown…'))
    await view.settle()
    expect(h.selectMarkdownExportPath).toHaveBeenCalledOnce()
    expect(h.writeMarkdownExport).toHaveBeenCalledWith('selected-markdown-token', expect.stringContaining('I shortened the heading.'))
  })

  it('exports a blob setup and imports it as a draft without creating it', async () => {
    const view = startApp()
    await view.settle()
    const blobRow = view.host.querySelector<HTMLElement>('.team-row[data-agent-id="agent-claude"]')
    if (!blobRow) throw new Error('Missing blob row')
    await act(async () => { blobRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 })) })
    await click(buttonNamed(view.host, 'Export blob…'))
    await view.settle()
    expect(h.selectBlobExportPath).toHaveBeenCalledWith('Claude')
    expect(h.writeBlobExport).toHaveBeenCalledWith('selected-blob-export-token', expect.stringContaining('"format": "bloblex.blob.v1"'))

    await click(buttonNamed(view.host, 'Blob actions'))
    await click(buttonNamed(view.host, 'Import blob…'))
    await view.settle()
    expect(h.selectBlobImportPath).toHaveBeenCalledOnce()
    expect(h.readBlobImport).toHaveBeenCalledWith('selected-blob-import-token')
    expect(view.host.querySelector('[aria-label^="Attach imported blob to coding agent"]')).not.toBeNull()
    await click(buttonNamed(view.host, 'Continue'))
    await view.settle()
    expect(view.host.querySelector('.blob-page')).not.toBeNull()
    expect(view.host.querySelector<HTMLInputElement>('input[aria-label="Blob name"]')?.value).toBe('Imported helper')
    expect(view.host.querySelector('.blob-hero [data-shape="droplet"]')).not.toBeNull()
    expect(h.rpc.mock.calls.some((call) => call[0] === 'agent.create')).toBe(false)
  })

  it('keeps the parent delete target through the pending request and closes only after the success action', async () => {
    let resolveDelete!: () => void
    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'events.replay') return { replayAvailable:true, events:[] }
      if (method === 'settings.get') return { settings:{} }
      if (method === 'session.delete') return new Promise<void>((resolve) => { resolveDelete = resolve })
      return {}
    })
    const view = startApp()
    await view.settle()
    const blobRow = view.host.querySelector<HTMLElement>('.team-row[data-agent-id="agent-claude"]')
    if (!blobRow) throw new Error('Missing blob row')
    // Conversations are deleted from the blob's menu (one conversation per blob).
    await act(async () => { blobRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:12, clientY:12 })) })
    await click(buttonNamed(view.host, 'Delete conversation…'))
    const dialog = view.host.querySelector<HTMLElement>('[role="dialog"]')!
    const deleteButton = dialog.querySelector<HTMLButtonElement>('.hold-confirm-button')!
    const pointer = (type: string) => { const event = new Event(type, { bubbles:true }); Object.defineProperty(event, 'pointerId', { value:3 }); return event }
    await act(async () => { deleteButton.dispatchEvent(pointer('pointerdown')); await vi.advanceTimersByTimeAsync(1050); deleteButton.dispatchEvent(pointer('pointerup')); await Promise.resolve() })
    expect(h.rpc).toHaveBeenCalledWith('session.delete', { sessionId:'session-claude' })
    expect(view.host.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('true')
    expect(view.host.querySelector('.hold-confirm-success')).toBeNull()
    expect(view.host.querySelector('.composer-box textarea')?.getAttribute('aria-label')).toBe('Message Claude')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true })) })
    expect(view.host.querySelector('[role="dialog"]')).not.toBeNull()
    expect(view.host.querySelector('.hold-confirm-success')).toBeNull()

    await act(async () => { resolveDelete(); await Promise.resolve(); await Promise.resolve() })
    expect(view.host.querySelector('.hold-confirm-success')).not.toBeNull()
    expect(view.host.querySelector('.hold-confirm-success h2')?.textContent).toBe('Conversation deleted')
    expect(view.host.querySelector('.composer-box textarea')?.getAttribute('aria-label')).toBe('Message Claude')
    await click(buttonNamed(view.host, 'Done'))
    expect(view.host.querySelector('[role="dialog"]')).toBeNull()
    expect(h.rpc.mock.calls.filter((call) => call[0] === 'session.delete')).toHaveLength(1)
  })
})
