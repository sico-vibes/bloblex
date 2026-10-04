// @vitest-environment happy-dom
import { selectValue } from './testSelect'
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
  getCurrentWindow: vi.fn(), playCompanionCue: vi.fn(), unlockCompanionAudioFromGesture: vi.fn(),
  setCompanionSoundsEnabled: vi.fn(), disposeCompanionAudio: vi.fn(), daemonEventHandlers: [] as Array<(event: any) => void>,
}))

vi.mock('../desktopIntegrations', () => ({ autostartEnabled: async () => false, setAutostartEnabled: async () => undefined, sendDesktopNotification: async () => undefined, flashMainWindow: async () => undefined }))
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
  playCompanionCue: h.playCompanionCue,
  unlockCompanionAudioFromGesture: h.unlockCompanionAudioFromGesture,
  setCompanionSoundsEnabled: h.setCompanionSoundsEnabled,
  disposeCompanionAudio: h.disposeCompanionAudio,
}))
vi.mock('../blob/BlobCanvas', async () => {
  const ReactModule = await import('react')
  return {
    BlobCanvas: (props: Record<string, any>) => ReactModule.createElement(
      'span',
      { 'data-testid': 'blob-canvas', 'data-sound-cues': String(props.soundCues === true), 'data-greeting': String(props.greeting === true) },
      props.greeting ? ReactModule.createElement('button', { type: 'button', 'aria-label': 'Complete greeting fixture', onClick: props.onGreetingComplete }, 'finish') : null,
    ),
  }
})
// This boundary mock lets the App-level stale-time guard receive a late click;
// PermissionChoiceButton's own live/deadline guard has a separate mounted test.
vi.mock('./PermissionChoiceButton', async () => {
  const ReactModule = await import('react')
  return {
    PermissionChoiceButton: (props: Record<string, any>) => ReactModule.createElement(
      'button', { type: 'button', className: props.className, onClick: () => props.onReply(props.choice) }, props.children,
    ),
  }
})

import { App } from './App'
import type { Snapshot } from '../types'

const runtimeA = { id: 'runtime-a', provider: 'codex', status: 'online', protocolFamily: 'app-server' }
const runtimeB = { id: 'runtime-b', provider: 'claude', status: 'online', protocolFamily: 'stream-json' }
const sessionA = { id: 'session-a', runtimeId: 'runtime-a', title: 'Alpha task', projectPath: 'C:/work/alpha', state: 'idle', messages: [] }
const sessionB = { id: 'session-b', runtimeId: 'runtime-b', title: 'Beta task', projectPath: 'C:/work/beta', state: 'idle', messages: [] }

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { sequence: 20, runtimes: [runtimeA, runtimeB], sessions: [sessionA, sessionB], permissions: [], usage: [], budgets: [], ...overrides }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function settleMicrotasks() {
  for (let index = 0; index < 16; index++) await Promise.resolve()
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

function configure(snapshotValue = snapshot(), options: { activeSession?: string | null; activeRuntime?: string | null; soundsEnabled?: boolean } = {}) {
  h.fetchSnapshot.mockResolvedValue(snapshotValue)
  h.ensureDaemon.mockResolvedValue(undefined)
  h.startDaemonEventStream.mockResolvedValue(undefined)
  h.getActiveSession.mockResolvedValue(options.activeSession ?? 'session-a')
  h.getActiveRuntime.mockResolvedValue(options.activeRuntime ?? 'runtime-a')
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
    if (method === 'settings.get') return { settings: { 'companion.soundsEnabled': options.soundsEnabled === true } }
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
  vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() })
  vi.spyOn(window, 'matchMedia').mockImplementation(() => ({
    matches: true, media: '(prefers-reduced-motion: reduce)', onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true),
  }) as unknown as MediaQueryList)
  h.daemonEventHandlers = []
  for (const mock of Object.values(h)) if (typeof mock === 'function' && 'mockReset' in mock) (mock as ReturnType<typeof vi.fn>).mockReset()
  h.playCompanionCue.mockReturnValue(true)
  h.unlockCompanionAudioFromGesture.mockResolvedValue(true)
  configure()
})

afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

describe('App mounted lifecycle', () => {
  it('keeps the short app fade class and duration under reduced motion', async () => {
    const view = startApp()
    await view.settle()
    const shell = view.host.querySelector<HTMLElement>('.app-shell')
    expect(shell?.classList.contains('reduced-launch-fade')).toBe(true)
    expect(shell?.style.getPropertyValue('--launch-fade-duration')).toBe('180ms')
  })

  it('links the sidebar brand to the imported PNG logo asset', async () => {
    const view = startApp()
    await view.settle()
    const logo = view.host.querySelector<HTMLImageElement>('.brand-lockup img')
    expect(logo).not.toBeNull()
    expect(logo?.getAttribute('alt')).toBe('Bloblex logo')
    const logoUrl = logo?.getAttribute('src') ?? ''
    expect(logoUrl.length).toBeGreaterThan(0)
    expect(logoUrl.endsWith('.png')).toBe(true)
    expect(logo?.getAttribute('class')).toBe('brand-logo')
  })

  it('unlistens when a StrictMode registration resolves after cleanup', async () => {
    const registrations: Array<ReturnType<typeof deferred<() => void>>> = []
    h.listenForActiveRuntime.mockImplementation(() => {
      const registration = deferred<() => void>()
      registrations.push(registration)
      return registration.promise
    })
    const view = startApp()
    await view.settle()
    expect(registrations).toHaveLength(2)

    view.unmount()
    const stops = [vi.fn(), vi.fn()]
    await act(async () => {
      registrations.forEach((registration, index) => registration.resolve(stops[index]!))
      await settleMicrotasks()
    })
    expect(stops.map((stop) => stop.mock.calls.length)).toEqual([1, 1])
  })

  it('hydrates the stored runtime/session and does not let an unrelated session update steal selection', async () => {
    configure(snapshot(), { activeSession: 'session-b', activeRuntime: 'runtime-b' })
    const view = startApp()
    await view.settle()
    expect(selectValue(view.host, 'Current conversation')).toBe('session-b')
    expect(view.host.querySelector('.context-pane')?.textContent).toContain('Beta task')

    const handler = h.daemonEventHandlers.at(-1)!
    act(() => handler({ sequence: 21, type: 'session.changed', payload: { session: { ...sessionA, title: 'Alpha updated', state: 'working' } } }))
    expect(selectValue(view.host, 'Current conversation')).toBe('session-b')
    expect(view.host.querySelector('.context-pane')?.textContent).toContain('Beta task')
    expect(h.setActiveSession.mock.calls.some(([id]) => id === 'session-a')).toBe(false)
  })

  it('expires and unpins an approval even while its session remains waiting_permission', async () => {
    const expiresAt = new Date(Date.now() + 5000).toISOString()
    const pending = { id: 'permission-1', sessionId: 'session-a', runtimeId: 'runtime-a', status: 'pending', expiresAt, title: 'Run shell command', command: 'npm test', choices: ['allow_once', 'deny'] }
    configure(snapshot({ sessions: [{ ...sessionA, state: 'waiting_permission' }, sessionB], permissions: [pending] }))
    const view = startApp('?companion')
    await view.settle()
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('home')
    expect(view.host.querySelector('.companion-collapse')?.hasAttribute('disabled')).toBe(true)
    expect(view.host.textContent).toContain('Run shell command')
    expect(h.playCompanionCue).toHaveBeenCalledExactlyOnceWith('approval')

    await act(async () => { await vi.advanceTimersByTimeAsync(5001); await settleMicrotasks() })
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('petit')
    expect(view.host.textContent).not.toContain('Run shell command')
    expect(view.host.querySelector('.companion-collapse')?.hasAttribute('disabled')).toBe(false)
    expect(view.host.querySelector('.companion-root')?.textContent).toContain('Approval needed')
  })

  it('rejects a stale approval click in the mounted App without sending permission.reply', async () => {
    const expiresAt = new Date(Date.now() + 5000).toISOString()
    const pending = { id: 'permission-stale', sessionId: 'session-a', runtimeId: 'runtime-a', status: 'pending', expiresAt, title: 'Confirm operation', choices: ['allow_once'] }
    configure(snapshot({ sessions: [{ ...sessionA, state: 'waiting_permission' }, sessionB], permissions: [pending] }))
    const view = startApp()
    await view.settle()
    const choice = view.host.querySelector<HTMLButtonElement>('.permission-choice')!
    expect(choice.disabled).toBe(false)
    const snapshotCallsBeforeClick = h.fetchSnapshot.mock.calls.length

    vi.setSystemTime(new Date(expiresAt).getTime() + 1)
    act(() => choice.click())
    await view.settle()
    expect(h.rpc.mock.calls.filter(([method]) => method === 'permission.reply')).toHaveLength(0)
    expect(h.fetchSnapshot.mock.calls.length).toBeGreaterThan(snapshotCallsBeforeClick)
    expect(view.host.querySelector('.inline-error')?.textContent).toContain('No reply was sent')
  })

  it('focuses the approval when the active composer becomes disabled', async () => {
    configure(snapshot())
    const view = startApp()
    await view.settle()
    const composer = view.host.querySelector<HTMLTextAreaElement>('.composer-box textarea')!
    composer.focus()
    expect(document.activeElement).toBe(composer)

    const permission = { id: 'permission-focus', sessionId: 'session-a', runtimeId: 'runtime-a', status: 'pending', title: 'Confirm operation', choices: ['allow_once', 'deny'] }
    act(() => h.daemonEventHandlers.at(-1)!({ sequence: 21, type: 'permission.requested', payload: { sessionId: 'session-a', permission } }))
    await view.settle()

    const approval = view.host.querySelector<HTMLElement>('[data-permission-card]')
    expect(composer.disabled).toBe(true)
    expect(approval).not.toBeNull()
    expect(document.activeElement).toBe(approval)
  })

  it('refreshes the applied model on exec.options.changed while the session remains working', async () => {
    const workingSession = { ...sessionA, state: 'working' }
    configure(snapshot({ sessions: [workingSession, sessionB] }))
    let latestModel = 'model-before'
    let useDeferredSnapshot = false
    const nextSnapshot = deferred<unknown>()
    const execSnapshot = (model: string) => ({
      id: 'snapshot-a', sessionId: 'session-a', status: 'partial',
      requested: { model }, applied: { model: { applied: true, value: model } },
    })
    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'events.replay') return { replayAvailable: true, events: [] }
      if (method === 'settings.get') return { settings: {} }
      if (method === 'exec.snapshot.latest') return useDeferredSnapshot ? nextSnapshot.promise : execSnapshot(latestModel)
      return {}
    })
    const view = startApp()
    await view.settle()
    const modelRow = () => [...view.host.querySelectorAll<HTMLElement>('.detail-row')].find((row) => row.firstElementChild?.textContent === 'Model')
    expect(modelRow()?.textContent).toContain('model-before')

    latestModel = 'model-after'
    useDeferredSnapshot = true
    act(() => h.daemonEventHandlers.at(-1)!({ sequence: 21, type: 'exec.options.changed', payload: { sessionId: 'session-a', turnId: 'turn-a' } }))
    await view.settle()
    expect(modelRow()?.textContent).toContain('model-before')
    expect(view.host.querySelectorAll('.detail-row')[2]?.textContent).toContain('Working')

    await act(async () => { nextSnapshot.resolve(execSnapshot(latestModel)); await settleMicrotasks() })
    await view.settle()
    expect(modelRow()?.textContent).toContain('model-after')
    expect(view.host.querySelectorAll('.detail-row')[2]?.textContent).toContain('Working')
  })

  it('keeps one opt-in companion sound owner in compact and home, and unlocks only on gesture', async () => {
    configure(snapshot(), { activeSession: 'session-a', activeRuntime: 'runtime-a', soundsEnabled: true })
    const view = startApp('?companion')
    await view.settle()
    expect(view.host.querySelectorAll('[data-testid="blob-canvas"][data-sound-cues="true"]')).toHaveLength(1)
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('petit')
    expect(h.unlockCompanionAudioFromGesture).not.toHaveBeenCalled()
    expect(h.playCompanionCue).not.toHaveBeenCalled()

    act(() => view.host.querySelector<HTMLButtonElement>('[aria-label="Open companion home"]')!.click())
    await view.settle()
    expect(view.host.querySelector('.companion-root')?.getAttribute('data-mode')).toBe('home')
    expect(view.host.querySelectorAll('[data-testid="blob-canvas"][data-sound-cues="true"]')).toHaveLength(1)
    expect(h.unlockCompanionAudioFromGesture).not.toHaveBeenCalled()

    act(() => view.host.querySelector<HTMLButtonElement>('[aria-label="Mute companion sounds"]')!.click())
    await view.settle()
    act(() => view.host.querySelector<HTMLButtonElement>('[aria-label="Enable companion sounds"]')!.click())
    await view.settle()
    expect(h.unlockCompanionAudioFromGesture).toHaveBeenCalledExactlyOnceWith()
    expect(view.host.querySelectorAll('[data-testid="blob-canvas"][data-sound-cues="true"]')).toHaveLength(1)

    const active = view.host.querySelector('[data-testid="blob-canvas"][data-greeting="false"]')
    expect(active).not.toBeNull()
    const completionEvent = { sequence: 21, type: 'session.changed', payload: { session: { ...sessionA, state: 'completed' } } }
    act(() => h.daemonEventHandlers.at(-1)!(completionEvent))
    expect(h.playCompanionCue).toHaveBeenCalledExactlyOnceWith('completion')
  })

  it('does not unlock audio while hydrating the main Settings surface', async () => {
    configure(snapshot(), { soundsEnabled: false })
    const view = startApp()
    await view.settle()
    act(() => view.host.querySelector<HTMLButtonElement>('.profile-button')!.click())
    act(() => [...view.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === 'Settings')!.click())
    await view.settle()
    const sounds = [...view.host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((button) => button.getAttribute('aria-label') === 'Companion sounds')!
    act(() => sounds.click())
    await view.settle()
    expect(h.unlockCompanionAudioFromGesture).not.toHaveBeenCalled()
    expect(h.playCompanionCue).not.toHaveBeenCalled()
    expect(h.setCompanionSoundsEnabled).not.toHaveBeenCalled()
  })
})
