// Development-only stand-in for src/tauri.ts, wired by vite.preview.config.ts
// so the real App can be inspected in a browser without the daemon. Every
// value below is a visual fixture, not product data.
import type { Agent, DaemonEvent, Runtime, Session, Snapshot } from '../types'
import { answerUsageAnalytics } from '../ui/analyticsFixtures'
import { normalizeAnalytics } from '../ui/analyticsFormat'
import { parseCapabilities, parseExecSnapshot, parseModelCatalog } from '../executionContract'
import type { UsageAnalyticsRequest } from '../analyticsTypes'
import { parseUpdateChannel, type UpdateChannel, type UpdateInfo, type UpdateProgress, type UpdatesState } from '../updatesContract'

type Unlisten = () => void
const noop: Unlisten = () => undefined
const fixtureSettings: Record<string, unknown> = { 'notifications.enabled': true }
const daemonListeners = new Set<(event: DaemonEvent) => void>()
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const flags = () => new URLSearchParams(location.search)

const baseRuntimes: Runtime[] = [
  { id: 'runtime-codex', provider: 'codex', status: 'online', protocolFamily: 'codex_app_server', version: 'codex-cli 0.159.3', authState: 'signed_in' },
  { id: 'runtime-claude', provider: 'claude', status: 'online', protocolFamily: 'claude_stream', version: '2.1.286' },
  { id: 'runtime-opencode', provider: 'opencode', status: 'online', protocolFamily: 'acp', version: '1.18.34', authState: 'authenticated', gatewayAuthStates: { opencode: 'authenticated', 'opencode-go': 'authenticated' } },
]

let agents: Agent[] = [
  { id: 'agent-claude', name: 'Claude', description: 'Default agent for Claude.', instructions: '', color: '#f38c6f', runtimeId: 'runtime-claude', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: minutesAgo(4000), updatedAt: minutesAgo(4000) },
  { id: 'agent-codex', name: 'Codex', description: 'Default agent for Codex.', instructions: '', color: '#82aaff', runtimeId: 'runtime-codex', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: minutesAgo(3000), updatedAt: minutesAgo(3000), approvalMode: 'auto', effectiveApprovalMode: 'auto' },
  { id: 'agent-invoice', name: 'Invoice helper', description: '', instructions: '', color: 'lemon', runtimeId: 'runtime-codex', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 1, archived: false, createdAt: minutesAgo(2000), updatedAt: minutesAgo(2000) },
  { id: 'agent-opencode', name: 'OpenCode', description: 'Default agent for OpenCode.', instructions: '', color: 'violet', runtimeId: 'runtime-opencode', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: minutesAgo(1000), updatedAt: minutesAgo(1000) },
  { id: 'agent-old', name: 'Retired', description: '', instructions: '', color: 'pink', runtimeId: 'runtime-codex', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 2, archived: true, createdAt: minutesAgo(5000), updatedAt: minutesAgo(10) },
]

let sessions: Session[] = [
  {
    id: 'session-codex', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Invoice parser tests', projectPath: 'C:/work/korus', state: 'working', model: 'gpt-5.5', updatedAt: minutesAgo(2),
    messages: [
      { id: 'm1', role: 'user', content: 'Can you make the invoice parser tests pass?', createdAt: minutesAgo(9) },
      { id: 'm2', role: 'assistant', content: 'Sure. I found two failing cases in **tests/invoice.test.ts**: the currency field is parsed before the locale is known, and totals use floats.\n\nI will switch totals to integer minor units and parse the locale first.', createdAt: minutesAgo(8) },
      { id: 'm3', role: 'assistant', content: 'Patched `parseInvoice` and the fixture loader. Running the suite now.', createdAt: minutesAgo(3) },
    ],
    tools: [{ id: 't1', title: 'npm test', kind: 'command', state: 'running', command: 'npm test -- invoice', sequence: 4 }],
  },
  { id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Landing page copy', projectPath: 'C:/work/site', state: 'completed', model: 'claude-opus', updatedAt: minutesAgo(41), messages: [{ id: 'c1', role: 'assistant', content: 'Updated the hero copy and the pricing table.', createdAt: minutesAgo(41) }] },
  { id: 'session-opencode', runtimeId: 'runtime-opencode', agentId: 'agent-opencode', title: 'Refactor auth', projectPath: 'C:/work/api', state: 'idle', updatedAt: minutesAgo(60 * 26), messages: [] },
  { id: 'session-legacy', runtimeId: 'runtime-codex', agentId: null, title: 'Untied notes', projectPath: 'C:/work/notes', state: 'idle', updatedAt: minutesAgo(90), messages: [] },
  { id: 'session-claude-2', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Hero follow-up', projectPath: 'c:\\work\\site\\', state: 'idle', updatedAt: minutesAgo(20), messages: [] },
  { id: 'session-claude-web', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Pricing page', projectPath: 'C:\\work\\web', state: 'completed', updatedAt: minutesAgo(80), messages: [] },
  { id: 'session-claude-dotdot', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Dotdot path', projectPath: 'C:\\work\\site\\..\\site', state: 'idle', updatedAt: minutesAgo(120), messages: [] },
  { id: 'session-claude-dot', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Dot path', projectPath: 'C:\\work\\site\\.', state: 'idle', updatedAt: minutesAgo(130), messages: [] },
  { id: 'session-invoice-a', runtimeId: 'runtime-codex', agentId: 'agent-invoice', title: 'North site', projectPath: 'C:\\client\\site', state: 'idle', updatedAt: minutesAgo(50), messages: [] },
  { id: 'session-invoice-b', runtimeId: 'runtime-codex', agentId: 'agent-invoice', title: 'South site', projectPath: 'D:\\other\\site', state: 'working', updatedAt: minutesAgo(40), messages: [] },
  { id: 'session-retired', runtimeId: 'runtime-codex', agentId: 'agent-old', title: 'Archived chat', projectPath: 'C:\\old\\repo', state: 'idle', updatedAt: minutesAgo(15), messages: [] },
  ...Array.from({ length: 31 }, (_, index) => {
    const n = index + 1
    return { id: `session-codex-many-${n}`, runtimeId: 'runtime-codex', agentId: 'agent-codex', title: `Bulk ${n}`, projectPath: 'C:\\work\\korus', state: 'idle' as const, updatedAt: minutesAgo(32 - n), messages: [] }
  }),
]

let sequence = 1
let agentSerial = 6
let fixtureAutostart = false
export const fixtureNotifications: Array<{ title: string; body: string }> = []
export const launchFixtureModes = ['in-progress', 'done', 'done-warning', 'service-down', 'onboarding-step-1', 'onboarding-step-2', 'onboarding-step-3'] as const
export function launchFixtureData(mode: typeof launchFixtureModes[number]) {
  const warning = mode === 'done-warning'
  const progress = mode === 'in-progress'
  const checks = [
    { id: 'service', label: 'Connecting to the Bloblex service', state: mode === 'service-down' ? 'failed' : progress ? 'ok' : 'ok', detail: mode === 'service-down' ? 'Service did not respond' : 'Connected and loaded the latest state' },
    { id: 'discovery', label: 'Finding coding agents', state: progress ? 'running' : 'ok', detail: progress ? 'In progress' : '3 coding agents found' },
    { id: 'auth:runtime-claude', label: 'Checking Claude Code sign-in', state: progress ? 'running' : 'ok', detail: progress ? 'In progress' : 'Signed in' },
    { id: 'models:runtime-codex', label: 'Loading Codex models', state: progress ? 'running' : 'ok', detail: progress ? 'In progress' : 'Loaded 12 models' },
    ...(warning ? [{ id: 'auth:runtime-opencode', label: 'Checking OpenCode sign-in', state: 'warning', detail: 'Warning: OpenCode: sign-in could not be confirmed' }, { id: 'models:runtime-opencode', label: 'Loading OpenCode models', state: 'warning', detail: 'Warning: OpenCode: models could not be loaded' }] : []),
    { id: 'usage', label: 'Loading usage and limits', state: progress ? 'running' : 'ok', detail: progress ? 'In progress' : 'Usage and limits are ready' },
  ]
  const onboarding = mode.startsWith('onboarding-step-')
  const runtimes = (onboarding && mode === 'onboarding-step-1' ? [] : baseRuntimes).map((runtime) => ({ ...runtime, authState: runtime.provider === 'codex' ? 'authenticated' : runtime.authState }))
  return { checks, slow: false, serviceDown: mode === 'service-down', runtimes }
}
export async function autostartEnabled() { return fixtureAutostart }
export async function setAutostartEnabled(enabled: boolean) { fixtureAutostart = enabled }
export async function sendDesktopNotification(title: string, body: string) { fixtureNotifications.push({ title, body }) }
export async function flashMainWindow() {}
function rpcError(code: string, message: string) {
  return new Error(`${code}: ${message}`)
}

function sortAgents(list: Agent[]) {
  return [...list].sort((a, b) => a.runtimeId.localeCompare(b.runtimeId) || a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

function currentSnapshot(): Snapshot {
  const search = flags()
  const runtimes = baseRuntimes.map((runtime) => search.has('offline') && runtime.id === 'runtime-codex' ? { ...runtime, status: 'offline' } : { ...runtime })
  return {
    sequence,
    runtimes,
    agents: search.has('empty') ? [] : agents.map((agent) => ({ ...agent, customArgs: [...agent.customArgs], customEnv: { ...agent.customEnv } })),
    sessions: sessions.filter((session) => !session.archived).map((session) => ({ ...session })),
    permissions: search.has('approval')
      ? [{ id: 'perm-1', sessionId: 'session-codex', runtimeId: 'runtime-codex', status: 'pending', title: 'Run shell command', command: 'npm test -- invoice', choices: ['allow_once', 'allow_session', 'deny'] }]
      : [],
    usageSummary: { inputTokens: 182_400, outputTokens: 24_900 },
  }
}

function nameTaken(name: string, exceptId?: string) {
  const key = name.trim().toLocaleLowerCase('en')
  return agents.some((agent) => !agent.archived && agent.id !== exceptId && agent.name.trim().toLocaleLowerCase('en') === key)
}

export const inDesktop = true
export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (method === 'events.replay') return { replayAvailable: true, events: [] } as T
  if (method === 'settings.get') return { settings: { ...fixtureSettings } } as T
  if (method === 'settings.set') { fixtureSettings[String(params.key)] = params.value; return { saved: true } as T }
  if (method === 'session.list') return { sessions: sessions.filter((session) => params.includeArchived === true || !session.archived).map((session) => ({ ...session })) } as T
  if (method === 'session.rename') {
    const session = sessions.find((item) => item.id === params.sessionId)
    const title = typeof params.title === 'string' ? params.title.trim() : ''
    if (!session) throw rpcError('not_found', 'Conversation not found.')
    if (!title || title.length > 120) throw rpcError('invalid_argument', 'Title must be between 1 and 120 characters.')
    session.title = title
    session.updatedAt = new Date().toISOString()
    notifyFixtureDaemon('session.changed', { session: { ...session } })
    return { session } as T
  }
  if (method === 'session.archive') {
    const session = sessions.find((item) => item.id === params.sessionId)
    if (!session) throw rpcError('not_found', 'Conversation not found.')
    session.archived = params.archived === true
    session.updatedAt = new Date().toISOString()
    notifyFixtureDaemon('session.changed', { session: { ...session } })
    return { session } as T
  }
  if (method === 'session.delete') {
    const index = sessions.findIndex((item) => item.id === params.sessionId)
    if (index < 0) throw rpcError('not_found', 'Conversation not found.')
    if (['starting', 'working', 'cancelling', 'waiting_permission'].includes(String(sessions[index].state))) throw rpcError('conflict', 'Cannot delete an active conversation.')
    const [session] = sessions.splice(index, 1)
    notifyFixtureDaemon('session.deleted', { sessionId: session.id })
    return { deleted: true } as T
  }
  if (method === 'runtime.capabilities') {
    const supported = { supported: true, enabled: true, scope: 'agent', evidence: 'preview' }
    return { runtimeId: params.runtimeId, settings: { model: supported, thinking: supported, serviceTier: supported, instructions: supported, customEnv: supported } } as T
  }
  if (method === 'runtime.models') {
    const runtimeId = String(params.runtimeId ?? '')
    const runtime = baseRuntimes.find((item) => item.id === runtimeId)
    const models = runtimeId === 'runtime-opencode' ? [
      { id: 'opencode-go/preview', displayName: 'Preview model', supportedThinking: [], serviceTiers: [] },
      { id: 'opencode-go/alternate-preview', displayName: 'Alternate preview', supportedThinking: [], serviceTiers: [] },
    ] : runtime?.provider === 'claude' ? [{ id: 'claude-sonnet', displayName: 'Claude Sonnet', supportedThinking: [], serviceTiers: [] }] : [{ id: 'gpt-5.5', displayName: 'GPT-5.5', supportedThinking: [], serviceTiers: [] }]
    return { runtimeId, provider: runtime?.provider ?? '', models, validated: true, source: 'fixture', fetchedAt: '2026-10-04T00:00:00Z' } as T
  }
  if (method === 'agent.list') {
    const includeArchived = params.includeArchived === true
    const runtimeId = typeof params.runtimeId === 'string' ? params.runtimeId : undefined
    const list = sortAgents(agents.filter((agent) => (includeArchived || !agent.archived) && (!runtimeId || agent.runtimeId === runtimeId)))
    return { agents: list } as T
  }
  if (method === 'agent.get') {
    const agent = agents.find((item) => item.id === params.agentId)
    if (!agent) throw rpcError('not_found', 'That blob is no longer available.')
    return { agent: { ...agent } } as T
  }
  if (method === 'agent.create') {
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    const runtimeId = typeof params.runtimeId === 'string' ? params.runtimeId : ''
    if (!name || !runtimeId) throw rpcError('invalid_argument', 'Check the name, description, colour, and runtime, then try again.')
    if (!baseRuntimes.some((runtime) => runtime.id === runtimeId)) throw rpcError('not_found', 'That runtime is no longer available.')
    if (nameTaken(name)) throw rpcError('conflict', 'Another blob already uses this name.')
    const sortOrder = agents.filter((agent) => agent.runtimeId === runtimeId && !agent.archived).reduce((max, agent) => Math.max(max, agent.sortOrder), -1) + 1
    const now = new Date().toISOString()
    const agent: Agent = {
      id: `agent-new-${agentSerial++}`,
      name,
      description: typeof params.description === 'string' ? params.description : '',
      instructions: typeof params.instructions === 'string' ? params.instructions : '',
      color: typeof params.color === 'string' ? params.color : 'mint',
      runtimeId,
      model: typeof params.model === 'string' || params.model === null ? params.model as string | null : null,
      thinking: typeof params.thinking === 'string' || params.thinking === null ? params.thinking as string | null : null,
      serviceTier: typeof params.serviceTier === 'string' || params.serviceTier === null ? params.serviceTier as string | null : null,
      customArgs: Array.isArray(params.customArgs) ? params.customArgs.filter((item): item is string => typeof item === 'string') : [],
      customEnv: params.customEnv && typeof params.customEnv === 'object' && !Array.isArray(params.customEnv) ? params.customEnv as Record<string, string> : {},
      maxConcurrency: typeof params.maxConcurrency === 'number' ? params.maxConcurrency : 1,
      defaultProject: typeof params.defaultProject === 'string' ? params.defaultProject : null,
      sortOrder,
      archived: false,
      createdAt: now,
      updatedAt: now,
    }
    agents = sortAgents([...agents, agent])
    sequence += 1
    return { agent } as T
  }
  if (method === 'agent.update') {
    const agentId = typeof params.agentId === 'string' ? params.agentId : ''
    const existing = agents.find((agent) => agent.id === agentId)
    if (!existing) throw rpcError('not_found', 'That blob is no longer available.')
    if (existing.archived) throw rpcError('conflict', 'This blob is archived and cannot be edited.')
    if (typeof params.name === 'string' && nameTaken(params.name, existing.id)) throw rpcError('conflict', 'Another blob already uses this name.')
    const nextRuntime = typeof params.runtimeId === 'string' ? params.runtimeId : existing.runtimeId
    if (!baseRuntimes.some((runtime) => runtime.id === nextRuntime)) throw rpcError('not_found', 'That runtime is no longer available.')
    const updated: Agent = {
      ...existing,
      name: typeof params.name === 'string' ? params.name.trim() : existing.name,
      description: typeof params.description === 'string' ? params.description : existing.description,
      instructions: typeof params.instructions === 'string' ? params.instructions : existing.instructions,
      color: typeof params.color === 'string' ? params.color : existing.color,
      runtimeId: nextRuntime,
      defaultProject: Object.prototype.hasOwnProperty.call(params, 'defaultProject') ? (typeof params.defaultProject === 'string' ? params.defaultProject : null) : existing.defaultProject,
      updatedAt: new Date().toISOString(),
    }
    agents = sortAgents(agents.map((agent) => agent.id === updated.id ? updated : agent))
    sequence += 1
    return { agent: updated } as T
  }
  if (method === 'agent.delete') {
    const agentId = typeof params.agentId === 'string' ? params.agentId : ''
    const existing = agents.find((agent) => agent.id === agentId)
    if (!existing) throw rpcError('not_found', 'That blob is no longer available.')
    const archived = { ...existing, archived: true, updatedAt: new Date().toISOString() }
    agents = sortAgents(agents.map((agent) => agent.id === archived.id ? archived : agent))
    sequence += 1
    return { agent: archived } as T
  }
  if (method === 'session.new') {
    const agentId = typeof params.agentId === 'string' ? params.agentId : undefined
    const runtimeId = typeof params.runtimeId === 'string' ? params.runtimeId : undefined
    if (!!agentId === !!runtimeId) throw rpcError('invalid_argument', 'Choose a project folder that exists on this device.')
    let resolvedRuntime = runtimeId
    let owner: string | null = null
    if (agentId) {
      const agent = agents.find((item) => item.id === agentId)
      if (!agent) throw rpcError('not_found', 'That blob is no longer available.')
      if (agent.archived) throw rpcError('conflict', 'This blob is archived, so a new session cannot be started.')
      resolvedRuntime = agent.runtimeId
      owner = agent.id
    }
    if (!resolvedRuntime || !baseRuntimes.some((runtime) => runtime.id === resolvedRuntime)) throw rpcError('not_found', 'That blob is no longer available.')
    if (typeof params.projectPath !== 'string' || !params.projectPath.trim()) throw rpcError('invalid_argument', 'Choose a project folder that exists on this device.')
    const title = typeof params.title === 'string' && params.title.trim() ? params.title : 'New chat'
    const session: Session = { id: `session-new-${sessions.length + 1}`, runtimeId: resolvedRuntime, agentId: owner, title, projectPath: params.projectPath, state: 'idle', updatedAt: new Date().toISOString(), messages: [] }
    sessions = [...sessions, session]
    sequence += 1
    return { session } as T
  }
  if (method === 'usage.analytics') return answerUsageAnalytics(params, flags().get('analytics')) as T
  return {} as T
}
export async function fetchSnapshot() { return currentSnapshot() }
export async function ensureDaemon() {}
export async function startDaemonEventStream() {}
export async function openProjectFolder() { return null }
export async function selectLocalFile() { return null }
export async function selectMarkdownExportPath() { return 'preview-markdown-token' }
export async function writeMarkdownExport(_selectionToken: string, _text: string) {}
export async function selectBlobExportPath(_name: string) { return 'preview-blob-export-token' }
export async function selectBlobImportPath() { return 'preview-blob-import-token' }
export async function readBlobImport(_selectionToken: string) { return '' }
export async function writeBlobExport(_selectionToken: string, _text: string) {}
export async function inspectLocalFile(path: string) { return { path, fileName: path.split(/[\\/]/).pop() ?? path, sizeBytes: 2048 } }
export async function openInEditor() {}
export async function revealInExplorer() {}
export async function resolveProjectFile(path: string) { return path }
export async function showMainWindow() {}
export async function showMainSettings() {}
export async function setActiveSession() {}
export async function getActiveSession() { return 'session-codex' }
export async function setActiveRuntime() {}
export async function getActiveRuntime() { return 'runtime-codex' }
export async function setCompanionVisibility() {}
export async function setCloseToTray() {}
export async function companionMonitorOptions() { return [] as string[] }
export async function currentCompanionMonitor() { return null }
export async function setCompanionMonitor() {}
export async function refreshTrayMenu() {}
const companionSizes: Record<string, [number, number]> = { petit: [344, 62], hidden: [344, 62], welcome: [640, 160], home: [640, 160], 'home-chat': [640, 264] }
export async function setCompanionMode(mode: string) {
  const [width, height] = companionSizes[mode] ?? [640, 160]
  let style = document.getElementById('fixture-companion-size')
  if (!style) { style = document.createElement('style'); style.id = 'fixture-companion-size'; document.head.append(style) }
  style.textContent = `:root.companion-surface body { background: radial-gradient(900px 500px at 70% 10%, #3b2f63, #12131a) !important; }
    .companion-root { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); width: ${width}px !important; height: ${height}px !important; transition: width .34s, height .34s; }`
}
export async function quitBloblex() {}
export async function permissionsPolicyGet() {
  return { defaultMode: 'ask' as const, perAgent: [] }
}
export async function listenForActiveSession(): Promise<Unlisten> { return noop }
export async function listenForActiveRuntime(): Promise<Unlisten> { return noop }
export async function listenForOpenSettings(): Promise<Unlisten> { return noop }
export async function listenForDaemonEvents(handler: (event: DaemonEvent) => void): Promise<Unlisten> { daemonListeners.add(handler); return () => daemonListeners.delete(handler) }
function notifyFixtureDaemon(type: string, payload: Record<string, unknown>) {
  const event = { sequence: ++sequence, type, payload } as DaemonEvent
  for (const handler of daemonListeners) handler(event)
}
export async function listenForDaemonConnection(handler: (connected: boolean) => void): Promise<Unlisten> {
  if (flags().has('disconnected')) handler(false)
  return noop
}

const updateAvailableHandlers = new Set<(info: UpdateInfo) => void>()
const updateProgressHandlers = new Set<(progress: UpdateProgress) => void>()

function fixtureUpdateChannel(): UpdateChannel {
  return flags().get('channel') === 'stable' ? 'stable' : 'beta'
}

function fixtureUpdateInfo(channel: UpdateChannel): UpdateInfo {
  return { version: '0.2.0', notes: 'Preview notes for this release.', pubDate: '2026-10-01T12:00:00.000Z', channel }
}

function fixtureUpdatesState(): UpdatesState {
  const mode = flags().get('updates') ?? 'up_to_date'
  const channel = fixtureUpdateChannel()
  return {
    currentVersion: '0.1.0',
    channel,
    autoCheck: flags().get('autoCheck') !== '0',
    lastCheckedAt: mode === 'idle' ? null : '2026-10-02T08:00:00.000Z',
    available: mode === 'available' || mode === 'progress' ? fixtureUpdateInfo(channel) : null,
    devBuild: mode === 'dev',
  }
}

let previewUpdates = fixtureUpdatesState()

export async function updatesGetState(): Promise<UpdatesState> {
  previewUpdates = { ...previewUpdates, ...fixtureUpdatesState(), channel: previewUpdates.channel, autoCheck: previewUpdates.autoCheck }
  return { ...previewUpdates, available: previewUpdates.available ? { ...previewUpdates.available } : null }
}

export async function updatesSetPreferences(preferences: { channel?: string; autoCheck?: boolean }): Promise<UpdatesState> {
  const channel = parseUpdateChannel(preferences.channel)
  if (preferences.channel != null && !channel) throw new Error('invalid_argument')
  previewUpdates = {
    ...previewUpdates,
    ...(channel ? { channel } : {}),
    ...(typeof preferences.autoCheck === 'boolean' ? { autoCheck: preferences.autoCheck } : {}),
  }
  return updatesGetState()
}

export async function updatesCheck() {
  const mode = flags().get('updates') ?? 'up_to_date'
  if (mode === 'checking') await new Promise((resolve) => setTimeout(resolve, 1200))
  const checkedAt = new Date().toISOString()
  if (previewUpdates.devBuild || mode === 'dev') return { status: 'error' as const, checkedAt, error: 'unavailable' as const }
  if (mode === 'error') {
    const error = flags().get('updateError')
    const code = error === 'signature' || error === 'manifest' || error === 'unavailable' || error === 'network' ? error : 'network'
    return { status: 'error' as const, checkedAt, error: code }
  }
  if (mode === 'no_stable_release') {
    previewUpdates = { ...previewUpdates, available: null, lastCheckedAt: checkedAt }
    return { status: 'no_stable_release' as const, checkedAt }
  }
  if (mode === 'available' || mode === 'progress') {
    const update = fixtureUpdateInfo(previewUpdates.channel)
    previewUpdates = { ...previewUpdates, available: update, lastCheckedAt: checkedAt }
    for (const handler of updateAvailableHandlers) handler({ ...update })
    return { status: 'available' as const, checkedAt, update }
  }
  previewUpdates = { ...previewUpdates, available: null, lastCheckedAt: checkedAt }
  return { status: 'up_to_date' as const, checkedAt }
}

export async function updatesInstall() {
  if (!previewUpdates.available) throw new Error('no_update')
  const known = flags().get('updateProgress') !== 'unknown'
  const steps: UpdateProgress[] = known
    ? [
      { phase: 'downloading', downloadedBytes: 256, totalBytes: 1024 },
      { phase: 'downloading', downloadedBytes: 1024, totalBytes: 1024 },
      { phase: 'installing', downloadedBytes: 1024, totalBytes: 1024 },
    ]
    : [
      { phase: 'downloading', downloadedBytes: 256, totalBytes: null },
      { phase: 'installing', downloadedBytes: 256, totalBytes: null },
    ]
  for (const step of steps) {
    for (const handler of updateProgressHandlers) handler({ ...step })
    await new Promise((resolve) => setTimeout(resolve, 280))
  }
}

export async function listenForUpdateAvailable(handler: (info: UpdateInfo) => void): Promise<Unlisten> {
  updateAvailableHandlers.add(handler)
  return () => { updateAvailableHandlers.delete(handler) }
}

export async function listenForUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<Unlisten> {
  updateProgressHandlers.add(handler)
  return () => { updateProgressHandlers.delete(handler) }
}

export async function runtimeCapabilities(runtimeId: string, agentId?: string) {
  return parseCapabilities(await rpc('runtime.capabilities', agentId ? { runtimeId, agentId } : { runtimeId }))
}

export async function runtimeModels(runtimeId: string, refresh = false) {
  return parseModelCatalog(await rpc('runtime.models', refresh ? { runtimeId, refresh: true } : { runtimeId }))
}

export async function execSnapshotLatest(sessionId: string) {
  return parseExecSnapshot(await rpc('exec.snapshot.latest', { sessionId }))
}

export async function fetchUsageAnalytics(request: UsageAnalyticsRequest) {
  const params: Record<string, unknown> = { from: request.from, to: request.to, bucket: request.bucket, tz: request.tz }
  if (request.projectPath) params.projectPath = request.projectPath
  if (request.agentId) params.agentId = request.agentId
  const parsed = normalizeAnalytics(await rpc('usage.analytics', params))
  if (!parsed) throw new Error('internal: Usage analytics could not be loaded.')
  return parsed
}
