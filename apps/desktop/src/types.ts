export type JsonRecord = Record<string, unknown>

export interface Snapshot extends JsonRecord {
  snapshotVersion?: number
  sequence?: number
  daemon?: JsonRecord
  hosts?: JsonRecord[]
  runtimes?: Runtime[]
  agents?: Agent[]
  sessions?: Session[]
  permissions?: PermissionRequest[]
  usage?: JsonRecord[]
  usageSummary?: JsonRecord
  budgets?: JsonRecord[] | JsonRecord
  latestBudgetAlert?: JsonRecord
}

export interface Runtime extends JsonRecord {
  id: string
  provider: string
  hostId?: string
  host?: JsonRecord
  protocolFamily?: string
  executablePath?: string
  version?: string
  status?: string
  authState?: string
  capabilities?: JsonRecord | string[]
}

export interface Agent extends JsonRecord {
  id: string
  name: string
  description: string
  instructions: string
  color: string
  runtimeId: string
  model: string | null
  thinking: string | null
  serviceTier: string | null
  customArgs: string[]
  customEnv: Record<string, string>
  maxConcurrency: number
  defaultProject: string | null
  sortOrder: number
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface ChatMessage extends JsonRecord {
  id?: string
  role?: string
  text?: string
  content?: string
  createdAt?: string
  status?: string
  turnId?: string
  toolName?: string
  eventType?: string
}

export interface Session extends JsonRecord {
  id: string
  runtimeId: string
  agentId?: string | null
  provider?: string
  projectPath?: string
  title?: string
  state?: string
  resumable?: boolean
  messages?: ChatMessage[]
  events?: ChatMessage[]
  turns?: JsonRecord[]
  tools?: JsonRecord[]
  createdAt?: string
  updatedAt?: string
  turnId?: string
  model?: string
  files?: JsonRecord[]
  usage?: JsonRecord[]
}

export interface PermissionRequest extends JsonRecord {
  id: string
  sessionId?: string
  runtimeId?: string
  title?: string
  description?: string
  tool?: string
  command?: string
  choices?: string[]
}

export interface DaemonEvent extends JsonRecord {
  v?: number
  sequence?: number
  type: string
  payload?: JsonRecord
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

export const labelize = (value: unknown, fallback = 'Unknown') => {
  if (typeof value !== 'string' || !value.trim()) return fallback
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export const providerColor = (provider = '') => {
  const normalized = provider.toLowerCase()
  if (normalized.includes('claude')) return '#f38c6f'
  if (normalized.includes('codex')) return '#82aaff'
  if (normalized.includes('opencode')) return '#bf9cff'
  return '#89d6b3'
}

export function eventSessionId(event: DaemonEvent) {
  const payload = event.payload ?? {}
  return typeof payload.sessionId === 'string' ? payload.sessionId : undefined
}

export function applyEvent(snapshot: Snapshot, event: DaemonEvent): Snapshot {
  const payload = event.payload ?? {}
  const sessionId = eventSessionId(event)
  const sequence = typeof event.sequence === 'number' ? event.sequence : snapshot.sequence
  if (typeof sequence === 'number' && typeof snapshot.sequence === 'number' && sequence <= snapshot.sequence) return snapshot

  if (event.type === 'runtime.changed') {
    const runtime = (payload.runtime ?? payload) as Runtime
    if (!runtime.id) return { ...snapshot, sequence }
    const runtimes = snapshot.runtimes ?? []
    return { ...snapshot, sequence, runtimes: [...runtimes.filter((item) => item.id !== runtime.id), runtime] }
  }

  if (event.type === 'session.changed') {
    const session = (payload.session ?? payload) as Session
    if (!session.id) return { ...snapshot, sequence }
    const sessions = snapshot.sessions ?? []
    const existing = sessions.find((item) => item.id === session.id)
    const merged = existing ? { ...existing, ...session, messages: session.messages ?? existing.messages, turns: session.turns ?? existing.turns, tools: session.tools ?? existing.tools, files: session.files ?? existing.files } : session
    return { ...snapshot, sequence, sessions: [...sessions.filter((item) => item.id !== session.id), merged] }
  }

  if (event.type === 'agent.changed') {
    const id = typeof payload.agentId === 'string' ? payload.agentId : undefined
    if (!id) return { ...snapshot, sequence }
    const agents = snapshot.agents ?? []
    const existing = agents.find((agent) => agent.id === id)
    const projected = {
      ...(existing ?? { id, name: '', description: '', instructions: '', color: 'mint', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, createdAt: '' }),
      runtimeId: typeof payload.runtimeId === 'string' ? payload.runtimeId : existing?.runtimeId ?? '',
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : existing?.updatedAt ?? '',
      archived: typeof payload.archived === 'boolean' ? payload.archived : existing?.archived ?? false,
      sortOrder: typeof payload.sortOrder === 'number' ? payload.sortOrder : existing?.sortOrder ?? 0,
    } satisfies Agent
    const nextAgents = [...agents.filter((agent) => agent.id !== id), projected]
      .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId) || a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    return { ...snapshot, sequence, agents: nextAgents }
  }

  if (event.type === 'permission.resolved') {
    const permissionId = payload.permissionId ?? (payload.permission as JsonRecord | undefined)?.id ?? payload.id
    return { ...snapshot, sequence, permissions: (snapshot.permissions ?? []).filter((permission) => permission.id !== permissionId) }
  }
  if (event.type === 'daemon.health') return { ...snapshot, sequence, daemon: { ...(snapshot.daemon ?? {}), ...payload } }

  if (!['message.delta', 'message.completed', 'tool.changed', 'command.changed', 'file.changed', 'permission.requested', 'usage.updated', 'budget.warning', 'budget.blocked', 'turn.completed', 'turn.error'].includes(event.type)) {
    return { ...snapshot, sequence }
  }

  if (sessionId) {
    const sessions = (snapshot.sessions ?? []).map((session) => {
      if (session.id !== sessionId) return session
      if (event.type === 'message.delta' || event.type === 'message.completed') {
        const message = (payload.message ?? payload) as ChatMessage
        const messages = [...(session.messages ?? session.events ?? [])]
        const turnId = typeof payload.turnId === 'string' ? payload.turnId : message.turnId
        const role = typeof payload.role === 'string' ? payload.role : message.role
        const messageId = typeof payload.messageId === 'string' ? payload.messageId : message.id
          ?? (turnId && role ? `stream:${sessionId}:${turnId}:${role}` : undefined)
        const index = messageId ? messages.findIndex((item) => item.id === messageId) : -1
        const matchingIndex = index >= 0 ? index : turnId && role
          ? messages.findIndex((item) => item.turnId === turnId && item.role === role)
          : -1
        if (matchingIndex >= 0) {
          const current = messages[matchingIndex]
          const delta = typeof payload.delta === 'string' ? payload.delta : ''
          messages[matchingIndex] = event.type === 'message.delta'
            ? { ...current, ...message, id: messageId ?? current.id, content: `${typeof current.content === 'string' ? current.content : typeof current.text === 'string' ? current.text : ''}${delta}` }
            : { ...current, ...message, id: messageId ?? current.id, content: typeof message.content === 'string' ? message.content : current.content }
        } else {
          messages.push(event.type === 'message.delta' && typeof payload.delta === 'string' ? { ...message, id: messageId, content: payload.delta } : { ...message, id: messageId })
        }
        return { ...session, messages }
      }
      if (event.type === 'tool.changed' || event.type === 'command.changed') {
        const tool = (payload.tool ?? payload.command ?? payload) as JsonRecord
        const tools = [...(session.tools ?? [])]
        const toolId = tool.id
        const index = toolId ? tools.findIndex((item) => item.id === toolId) : -1
        if (index >= 0) tools[index] = { ...tools[index], ...tool }
        else tools.push(tool)
        return { ...session, tools }
      }
      if (event.type === 'file.changed') {
        const file = (payload.file ?? payload) as JsonRecord
        const files = [...(session.files ?? [])]
        const index = file.id ? files.findIndex((item) => item.id === file.id) : files.findIndex((item) => item.path === file.path)
        if (index >= 0) files[index] = { ...files[index], ...file }
        else files.push(file)
        return { ...session, files }
      }
      return { ...session, state: stateForEvent(event.type) ?? session.state }
    })
    const permissions = event.type === 'permission.requested' ? [...(snapshot.permissions ?? []), (payload.permission ?? payload) as PermissionRequest] : snapshot.permissions
    const usage = event.type === 'usage.updated' ? [...(snapshot.usage ?? []), (payload.usage ?? payload) as JsonRecord] : snapshot.usage
    const budgets = event.type === 'budget.warning' || event.type === 'budget.blocked'
      ? [...budgetRows(snapshot.budgets).filter((budget) => budget.id !== payload.id), (payload.budget ?? payload) as JsonRecord]
      : snapshot.budgets
    const latestBudgetAlert = event.type === 'budget.warning' || event.type === 'budget.blocked'
      ? { ...payload, eventType: event.type, timestamp: event.timestamp }
      : snapshot.latestBudgetAlert
    return { ...snapshot, sequence, sessions, permissions, usage, budgets, latestBudgetAlert }
  }

  if (event.type === 'usage.updated') {
    const usage = (payload.usage ?? payload) as JsonRecord
    return { ...snapshot, sequence, usage: [...(snapshot.usage ?? []), usage], usageSummary: { ...(snapshot.usageSummary ?? {}), ...usage } }
  }
  if (event.type === 'budget.warning' || event.type === 'budget.blocked') return { ...snapshot, sequence, budgets: [...budgetRows(snapshot.budgets).filter((budget) => budget.id !== payload.id), (payload.budget ?? payload) as JsonRecord], latestBudgetAlert: { ...payload, eventType: event.type, timestamp: event.timestamp } }
  if (event.type === 'permission.requested') return { ...snapshot, sequence, permissions: [...(snapshot.permissions ?? []), (payload.permission ?? payload) as PermissionRequest] }
  return { ...snapshot, sequence }
}

function budgetRows(value: Snapshot['budgets']): JsonRecord[] {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.policies)) return value.policies as JsonRecord[]
  return []
}

export function stateForEvent(eventType: string): string | undefined {
  if (eventType === 'permission.requested') return 'waiting_permission'
  if (eventType === 'turn.completed') return 'completed'
  if (eventType === 'turn.error') return 'error'
  if (eventType === 'tool.changed' || eventType === 'message.delta') return 'working'
  return undefined
}

export function formatUnknownSafe(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value : fallback
}

export function isPermissionReplyAllowed(permission: PermissionRequest, choice: string) {
  return Array.isArray(permission.choices) && permission.choices.includes(choice)
}
