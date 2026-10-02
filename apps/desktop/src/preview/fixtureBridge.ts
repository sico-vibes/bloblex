// Development-only stand-in for src/tauri.ts, wired by vite.preview.config.ts
// so the real App can be inspected in a browser without the daemon. Every
// value below is a visual fixture, not product data.
import type { Agent, DaemonEvent, Runtime, Session, Snapshot } from '../types'

type Unlisten = () => void
const noop: Unlisten = () => undefined
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const flags = () => new URLSearchParams(location.search)

const baseRuntimes: Runtime[] = [
  { id: 'runtime-codex', provider: 'codex', status: 'online', protocolFamily: 'codex_app_server', version: 'codex-cli 0.159.3', authState: 'signed_in' },
  { id: 'runtime-claude', provider: 'claude', status: 'online', protocolFamily: 'claude_stream', version: '2.1.286' },
  { id: 'runtime-opencode', provider: 'opencode', status: 'online', protocolFamily: 'acp', version: '1.18.34' },
]

let agents: Agent[] = [
  { id: 'agent-claude', name: 'Claude', description: 'Default agent for Claude.', instructions: '', color: '#f38c6f', runtimeId: 'runtime-claude', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: minutesAgo(4000), updatedAt: minutesAgo(4000) },
  { id: 'agent-codex', name: 'Codex', description: 'Default agent for Codex.', instructions: '', color: '#82aaff', runtimeId: 'runtime-codex', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: minutesAgo(3000), updatedAt: minutesAgo(3000) },
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
    sessions: sessions.map((session) => ({ ...session })),
    permissions: search.has('approval')
      ? [{ id: 'perm-1', sessionId: 'session-codex', runtimeId: 'runtime-codex', status: 'pending', title: 'Run shell command', command: 'npm test -- invoice', choices: ['allow_once', 'allow_session', 'deny'] }]
      : [],
    usageSummary: { inputTokens: 182_400, outputTokens: 24_900 },
    budgets: [],
  }
}

function nameTaken(name: string, exceptId?: string) {
  const key = name.trim().toLocaleLowerCase('en')
  return agents.some((agent) => !agent.archived && agent.id !== exceptId && agent.name.trim().toLocaleLowerCase('en') === key)
}

export const inDesktop = true
export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (method === 'events.replay') return { replayAvailable: true, events: [] } as T
  if (method === 'settings.get') return { settings: {} } as T
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
  return {} as T
}
export async function fetchSnapshot() { return currentSnapshot() }
export async function ensureDaemon() {}
export async function startDaemonEventStream() {}
export async function openProjectFolder() { return null }
export async function selectLocalFile() { return null }
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
const companionSizes: Record<string, [number, number]> = { petit: [344, 62], hidden: [344, 62], coucou: [640, 160], home: [640, 160], 'home-chat': [640, 264] }
export async function setCompanionMode(mode: string) {
  const [width, height] = companionSizes[mode] ?? [640, 160]
  let style = document.getElementById('fixture-companion-size')
  if (!style) { style = document.createElement('style'); style.id = 'fixture-companion-size'; document.head.append(style) }
  style.textContent = `:root.companion-surface body { background: radial-gradient(900px 500px at 70% 10%, #3b2f63, #12131a) !important; }
    .companion-root { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); width: ${width}px !important; height: ${height}px !important; transition: width .34s, height .34s; }`
}
export async function quitBloblex() {}
export async function listenForActiveSession(): Promise<Unlisten> { return noop }
export async function listenForActiveRuntime(): Promise<Unlisten> { return noop }
export async function listenForOpenSettings(): Promise<Unlisten> { return noop }
export async function listenForDaemonEvents(_handler: (event: DaemonEvent) => void): Promise<Unlisten> { return noop }
export async function listenForDaemonConnection(handler: (connected: boolean) => void): Promise<Unlisten> {
  if (flags().has('disconnected')) handler(false)
  return noop
}
