// @vitest-environment happy-dom
// Phase 5, section 9: the render budget. `scripts/perf-gate.mjs` measures cold
// start and snapshot size; only a mounted window can measure render time, so it
// lives here and reads its budget from `perf-budgets.json`.
//
// The fixture is a real transcript: one conversation with 1,000 messages, the
// same shape the daemon's `session.get` returns. The measurement is the time
// from mounting the real `App` to the first message row being in the DOM, taken
// three times, and the median is compared with the budget. Mounting the whole
// app rather than a fragment is deliberate: it includes markdown, the bot art
// and the shell, which is what a person waiting for a long conversation sees.
//
// The mocks are the ones `App.emptyConversation.mounted.test.tsx` uses, so a new
// native export cannot fail this file for a reason unrelated to performance.
import { readFileSync } from 'node:fs'
import { URL as NodeUrl } from 'node:url'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const budgets = JSON.parse(readFileSync(new NodeUrl('../../../../perf-budgets.json', import.meta.url), 'utf8')) as { renderMs: number }

const h = vi.hoisted(() => ({
  approvalBadge: vi.fn(), rpc: vi.fn(), fetchSnapshot: vi.fn(), ensureDaemon: vi.fn(), startDaemonEventStream: vi.fn(),
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
    }),
  }
})

import { App } from './App'
import { setThemeStyle } from '../blob/bitbots'
import type { Agent, Runtime, Session, Snapshot } from '../types'

const MESSAGE_COUNT = 1000
const stamp = '2026-10-01T00:00:00.000Z'
const sessionId = 'session-perf'

// A body long enough to be a real reply, with the inline code and a list a
// coding agent writes, so the markdown path is part of the measurement.
const reply = [
  'I changed three places. The migration adds `accounts`, the two joins now read the provider from the row, and the index plan is unchanged.',
  '',
  '- the schema test covers the new table',
  '- the turn passes the account through',
  '- the backup leaves it out',
].join('\n')

function messages() {
  return Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
    id: `perf-message-${index}`,
    role: index % 2 === 0 ? 'user' : 'agent',
    content: index % 2 === 0 ? `Step ${index}: run the gate and report the tail.` : reply,
    createdAt: stamp,
  }))
}

const codexRuntime: Runtime = { id: 'runtime-codex', provider: 'codex', status: 'online', protocolFamily: 'local', version: '1.0.0' }
const perfBot: Agent = {
  id: 'agent-perf', name: 'Rae', color: '#82aaff', runtimeId: 'runtime-codex', sortOrder: 0,
  description: '', instructions: '', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {},
  maxConcurrency: 1, defaultProject: null, archived: false, createdAt: stamp, updatedAt: stamp,
}
const perfSession: Session = {
  id: sessionId, runtimeId: 'runtime-codex', agentId: 'agent-perf', title: 'Perf conversation',
  projectPath: 'C:/work/site', state: 'idle', updatedAt: stamp, messages: messages(),
}
const snapshot: Snapshot = { sequence: 20, runtimes: [codexRuntime], agents: [perfBot], sessions: [perfSession], permissions: [], usage: [] }

let mounted: Array<{ root: Root; host: HTMLDivElement }> = []

/** The time from mounting the app to the first message row, in milliseconds. */
async function mountAndMeasure(): Promise<number> {
  window.history.replaceState({}, '', '/')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  const started = performance.now()
  await act(async () => { root.render(<App />) })
  const deadline = Date.now() + 15_000
  while (host.querySelectorAll('.message-row').length === 0) {
    if (Date.now() > deadline) throw new Error('the transcript did not render within 15 s')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  }
  return performance.now() - started
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() })
  for (const mock of Object.values(h)) if (typeof mock === 'function' && 'mockReset' in mock) (mock as ReturnType<typeof vi.fn>).mockReset()
  setThemeStyle('blobots')
  h.fetchSnapshot.mockResolvedValue(snapshot)
  h.ensureDaemon.mockResolvedValue(undefined)
  h.startDaemonEventStream.mockResolvedValue(undefined)
  h.getActiveSession.mockResolvedValue(sessionId)
  h.getActiveRuntime.mockResolvedValue('runtime-codex')
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
    if (method === 'session.get') return perfSession
    return {}
  })
  const stop = vi.fn()
  h.listenForDaemonEvents.mockImplementation(async () => stop)
  h.listenForDaemonConnection.mockResolvedValue(stop)
  h.listenForActiveSession.mockResolvedValue(stop)
  h.listenForActiveRuntime.mockResolvedValue(stop)
  h.listenForOpenSettings.mockResolvedValue(stop)
  h.directListen.mockResolvedValue(stop)
  h.getCurrentWindow.mockReturnValue({ onDragDropEvent: vi.fn().mockResolvedValue(stop) })
})

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

// About a minute of work, so it runs in its own CI step and `npm run perf:render`, not in `npm test`.
describe.skipIf(!process.env.BITBOTS_PERF_RENDER)('a long conversation mounts inside the render budget', () => {
  it(`renders a ${MESSAGE_COUNT.toLocaleString('en-US')}-message conversation in ${budgets.renderMs} ms or less`, async () => {
    expect(perfSession.messages).toHaveLength(MESSAGE_COUNT)
    const times: number[] = []
    for (let run = 0; run < 3; run += 1) times.push(await mountAndMeasure())
    const measured = median(times)
    // The row count is the other half of the guarantee: if windowing stopped
    // working, the transcript would build every node and the time would fail
    // first, so the two together say the gate is measuring a real transcript.
    const rows = mounted.at(-1)!.host.querySelectorAll('.message-row').length
    expect(rows, `rendered ${rows} rows for ${MESSAGE_COUNT} messages`).toBeGreaterThan(0)
    expect(rows <= MESSAGE_COUNT, `rendered ${rows} rows, more than the conversation holds`).toBe(true)
    expect(measured, `mount times: ${times.map((time) => time.toFixed(1)).join(', ')} ms (median ${measured.toFixed(1)} ms, budget ${budgets.renderMs} ms)`).toBeLessThanOrEqual(budgets.renderMs)
  })
})
