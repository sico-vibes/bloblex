import type { AutoResolvedAction, BypassNotice } from './approvalContract'
import type { BlobLook } from './blob/look'
import type { RemoteStatus } from './remote/remoteContract'
import { parseAutoResolved, parseBypassActive } from './approvalContract'

export type { AutoResolvedAction, BypassNotice } from './approvalContract'
export type ApprovalMode = 'ask' | 'auto' | 'bypass'

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
  quotas?: JsonRecord[]
  projects?: Project[]
  autoApprovals?: AutoResolvedAction[]
  bypassNotices?: BypassNotice[]
  /** Client-side tombstones prevent delayed events from reviving deleted sessions. */
  deletedSessionIds?: string[]
  /** Queued prompts per session, kept current by `queue.changed` and `session.queue.list`. */
  queues?: Record<string, PromptQueueState>
  /** Scheduled automations, kept current by `automation.*` events. */
  automations?: Automation[]
  /** Remote-mode host status. Populated by the web preview fixture today; the daemon will own it later. */
  remote?: RemoteStatus
}

/** A note blobs can recall. Agent-written notes for a project or everyone stay unused until approved. */
export interface MemoryRecord extends JsonRecord {
  id: string
  scope: 'blob' | 'project' | 'shared'
  scopeId?: string | null
  kind: 'fact' | 'preference' | 'decision' | 'procedure' | 'reference'
  title: string
  body: string
  tags?: string[]
  importance?: number
  pinned?: boolean
  origin: 'user' | 'agent'
  reviewed: boolean
  version: number
  updatedAt?: string
  deletedAt?: string | null
}

export function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<MemoryRecord>
  return typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string'
    && (item.scope === 'blob' || item.scope === 'project' || item.scope === 'shared') && typeof item.reviewed === 'boolean' && typeof item.version === 'number'
}

/** A prompt waiting in the daemon's durable queue (plain queued or scheduled "send later"). */
export interface QueuedPrompt extends JsonRecord {
  id: string
  sessionId: string
  text: string
  attachments?: Array<{ name: string; path: string }>
  kind: 'user' | 'send_later' | 'retry'
  dueAt: string | null
  status: 'queued' | 'sending' | 'failed'
  error: string | null
  position: number
  lateBySecs?: number
  /** The daemon stopped while this was being sent, so it may already have reached the agent. */
  ambiguous?: boolean
}

/** What a model change would do, from `session.model.plan`: the daemon decides, the UI only shows it. */
export interface ModelChangePlan {
  modelChanged: boolean
  busy: boolean
  locked: boolean
  contextAtRisk: boolean
  /** `kept`: the provider chat carries on with the new model. `recap`: a fresh provider session with a short summary. `none`: nothing to lose. */
  continuity: 'kept' | 'recap' | 'none'
  reason: string
}

export interface PromptQueueState {
  items: QueuedPrompt[]
  /** The daemon stopped auto-sending after a failed or cancelled turn, or a restart. */
  paused: boolean
}

/** One recorded run of an automation. */
export interface AutomationRun extends JsonRecord {
  id: string
  automationId: string
  sessionId?: string | null
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'timeout' | 'interrupted' | string
  reason?: string | null
  scheduledFor?: string | null
  startedAt: string
  finishedAt?: string | null
}

/** A schedule that prompts a blob by itself. Runs only while the daemon is up. */
export interface Automation extends JsonRecord {
  id: string
  agentId: string
  name: string
  prompt: string
  schedule: { kind: 'cron'; cron: string; timezone: string } | { kind: 'once'; at: string }
  sessionMode?: 'new' | 'reuse'
  approvalMode?: 'plan' | 'auto'
  maxRuntimeSecs?: number
  enabled: boolean
  createdBy?: 'user' | 'agent'
  nextRunAt?: string | null
  lastRunAt?: string | null
  consecutiveFailures?: number
  pauseReason?: 'user' | 'auto_failures' | 'needs_approval' | null
  running?: boolean
  lastRun?: AutomationRun | null
}

export function isAutomation(value: unknown): value is Automation {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Automation>
  const schedule = item.schedule as { kind?: unknown } | undefined
  return typeof item.id === 'string' && typeof item.agentId === 'string' && typeof item.name === 'string'
    && typeof item.enabled === 'boolean' && !!schedule && (schedule.kind === 'cron' || schedule.kind === 'once')
}

export function isQueuedPrompt(value: unknown): value is QueuedPrompt {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<QueuedPrompt>
  return typeof item.id === 'string' && typeof item.sessionId === 'string' && typeof item.text === 'string'
    && (item.status === 'queued' || item.status === 'sending' || item.status === 'failed')
}

export function normalizeQueueState(value: unknown): PromptQueueState {
  const source = (value && typeof value === 'object' ? value : {}) as { items?: unknown; paused?: unknown }
  return { items: Array.isArray(source.items) ? source.items.filter(isQueuedPrompt) : [], paused: source.paused === true }
}

export interface Runtime extends JsonRecord {
  id: string
  provider: string
  displayName?: string
  hostId?: string
  host?: JsonRecord
  protocolFamily?: string
  executablePath?: string
  version?: string
  status?: string
  authState?: string
  /** RFC 3339 time of the turn whose CLI sign-in failed; absent otherwise. */
  authFailedAt?: string
  gatewayAuthStates?: Record<string, string>
  probeError?: string | null
  probeStep?: string | null
  capabilities?: JsonRecord | string[]
}

export interface Agent extends JsonRecord {
  id: string
  name: string
  description: string
  instructions: string
  color: string
  /** Silhouette and face; absent means a round blob seeded by the id. */
  look?: BlobLook | null
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
  approvalMode?: ApprovalMode | null
  effectiveApprovalMode?: ApprovalMode | null
  /** What this blob may notify about: everything, only what needs the user, or nothing. */
  notificationLevel?: 'all' | 'input' | 'muted' | null
  /** Phase 1A: the default project for new conversations (null = none); bots work in every project. */
  projectId?: string | null
  /** Phase 1A: the project of the bot's most recent conversation, the first default for a new one. */
  lastProjectId?: string | null
  role?: string
  leader?: boolean
  /** FIX36: only the one built-in Manager carries "manager". */
  systemRole?: 'manager' | null
  hidden?: boolean
  /** FIX39 item 13: the owner locked this bot's settings. */
  locked?: boolean
  /** FIX39 item 21: the routing vocabulary the Manager matches to a project's tags. */
  tags?: string[]
}

export interface Project extends JsonRecord {
  id: string
  name: string
  path: string | null
  sortOrder: number
  collapsed?: boolean
  description?: string
  /** FIX39 item 21: what kind of work this project is for, for Manager routing. */
  tags?: string[]
}

/** Side conversation between two blobs, or a scheduled run; absent on a blob's main conversation. */
export interface SessionLink extends JsonRecord {
  kind: 'side' | 'automation'
  /** Present on side conversations. */
  peerAgentId?: string
  automationId?: string
  runId?: string
  peerName?: string
  originSessionId?: string
  /** The conversation that started this side conversation; never changes (FIX27). */
  spawnedFromSessionId?: string
  /** Short title the sender gave the conversation, also its session title. */
  topic?: string
}

/** Team metadata on a stored message. */
export interface MessageMeta extends JsonRecord {
  kind?: 'delegation' | 'blob_message' | 'blob_reply' | 'blob_created' | 'plan' | 'context_reset' | string
  /** `context_reset` notices: why the provider's context changed, and whether earlier turns are gone for the agent. */
  reason?: 'compaction' | 'fresh_session' | 'restart' | string
  contextLost?: boolean
  replyTo?: { sourceSessionId: string; messageId: string; role?: 'user' | 'assistant'; author?: string; excerpt?: string; truncated?: boolean; createdAt?: string | null }
  direction?: 'sent' | 'failed' | 'waiting'
  /** A queued delegation notice (FIX39 item 18): the delivery waits for a slot. */
  state?: 'queued'
  peerAgentId?: string
  peerName?: string
  fromAgentId?: string
  fromName?: string
  sideSessionId?: string
  topic?: string
  /** `blob_created` notices: the new bot and the name it was given. */
  agentId?: string
  name?: string
}

export interface UserQuestion extends JsonRecord {
  id: string
  header: string
  question: string
  options: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  allowOther?: boolean
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
  attachments?: MessageAttachment[] | null
  meta?: MessageMeta | null
  /** Side conversations the user tagged with # in this message. */
  references?: Array<{ id: string; title: string }> | null
  /** Local user's curated reactions; no peer reaction counts are represented. */
  reactions?: string[]
}

export interface MessageAttachment extends JsonRecord {
  name: string
  mediaType?: string
  path?: string
}

/** Per-conversation execution pins. Absent speed/mode keys follow the blob. */
export interface SessionModelLock {
  model?: string | null
  thinking?: string | null
  serviceTier?: string | null
  enableWorkflows?: boolean
  approvalMode?: ApprovalMode | null
  /** FIX39 item 19: who chose the pinned mode. `manager` marks an approved Manager proposal. */
  approvalModeSource?: 'manager' | null
  planMode?: boolean
}

export interface Session extends JsonRecord {
  id: string
  runtimeId: string
  agentId?: string | null
  provider?: string
  projectPath?: string
  title?: string
  archived?: boolean
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
  modelLock?: SessionModelLock | null
  link?: SessionLink | null
  /** The project the conversation was started for (daemon-stamped; absent on older rows). */
  projectId?: string | null
  /** Phase 1A: the project's name, sent with the session (null for no project). */
  projectName?: string | null
  /** Where it works, as a name people know: the project name, or "Casual". */
  workspaceLabel?: string | null
  contextUsed?: number | null
  contextSize?: number | null
  /** Model identity associated with the last provider-reported context measurement. */
  contextModel?: string | null
  contextEstimated?: boolean
  files?: JsonRecord[]
  usage?: JsonRecord[]
  /** Wave 13: a lazy snapshot sent only the last messages; `session.get` loads the rest. */
  partial?: boolean
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
  kind?: 'question' | 'proposal' | string | null
  questions?: UserQuestion[] | null
  /** FIX36 D2: an action the Manager has proposed for the owner to approve. */
  proposal?: ProposalCard | null
  /** Wave 12: whether this request may be remembered as an "Always allow" rule, and its sentence ("Run `git status`"). */
  rememberable?: boolean
  rememberLabel?: string | null
}

/** The Manager's proposal carried by a `kind: "proposal"` permission card. */
export interface ProposalCard extends JsonRecord {
  id: string
  kind: 'project' | 'bot' | 'task' | 'playbook' | 'profile' | string
  payload?: JsonRecord
}

/** FIX36 D3: one structured fact the Manager knows about the user. */
export interface ManagerFact extends JsonRecord {
  id: string
  category: 'identity' | 'workflow' | 'style' | 'conventions' | 'design' | 'other'
  key: string
  value: string
  source: 'said' | 'learned' | 'corrected'
  /** A locked preference is the user's: the Manager must propose a change. */
  locked: boolean
  createdAt?: string
  updatedAt?: string
}

/** FIX36 D3: one version of the Manager's playbook, newest is current. */
export interface PlaybookVersion extends JsonRecord {
  version: number
  text: string
  author: 'default' | 'user' | 'manager'
  createdAt?: string
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

  if (event.type === 'automation.changed' || event.type === 'automation.deleted' || event.type === 'automation.run.changed') {
    const current = snapshot.automations ?? []
    if (event.type === 'automation.deleted') {
      const removed = typeof payload.id === 'string' ? payload.id : null
      return { ...snapshot, sequence, automations: removed ? current.filter((item) => item.id !== removed) : current }
    }
    if (event.type === 'automation.changed') {
      const next = payload.automation
      if (!isAutomation(next)) return { ...snapshot, sequence }
      return { ...snapshot, sequence, automations: [...current.filter((item) => item.id !== next.id), next] }
    }
    const run = payload.run as AutomationRun | undefined
    if (!run || typeof run.automationId !== 'string') return { ...snapshot, sequence }
    return { ...snapshot, sequence, automations: current.map((item) => item.id === run.automationId ? { ...item, lastRun: run, running: run.status === 'running' } : item) }
  }

  if (event.type === 'queue.changed') {
    const queueSession = typeof payload.sessionId === 'string' ? payload.sessionId : null
    if (!queueSession || snapshot.deletedSessionIds?.includes(queueSession)) return { ...snapshot, sequence }
    return { ...snapshot, sequence, queues: { ...snapshot.queues, [queueSession]: normalizeQueueState(payload) } }
  }

  if (event.type === 'runtime.changed') {
    if (Array.isArray(payload.runtimes)) {
      const runtimes = payload.runtimes.filter((runtime): runtime is Runtime => Boolean(runtime && typeof runtime === 'object' && typeof (runtime as Runtime).id === 'string'))
      return { ...snapshot, sequence, runtimes }
    }
    const runtime = (payload.runtime ?? payload) as Runtime
    if (!runtime.id) return { ...snapshot, sequence }
    const runtimes = snapshot.runtimes ?? []
    return { ...snapshot, sequence, runtimes: [...runtimes.filter((item) => item.id !== runtime.id), runtime] }
  }

  if (event.type === 'quota.updated') {
    const provider = typeof payload.provider === 'string' ? payload.provider : undefined
    const quota = payload.quota && typeof payload.quota === 'object' ? payload.quota as JsonRecord : undefined
    if (!provider || !quota) return { ...snapshot, sequence }
    const row = quota.snapshot && typeof quota.snapshot === 'object'
      ? { ...quota, provider }
      : { provider, runtimeId: quota.runtimeId, snapshot: quota, fetchedAt: quota.fetchedAt, lastAttemptAt: quota.fetchedAt, failureCount: 0, retryAfter: null, lastError: null }
    const quotas = [...(snapshot.quotas ?? []).filter((item) => item.provider !== provider), row]
    return { ...snapshot, sequence, quotas }
  }

  if (event.type === 'session.changed') {
    const session = (payload.session ?? payload) as Session
    if (!session.id) return { ...snapshot, sequence }
    if (snapshot.deletedSessionIds?.includes(session.id)) return { ...snapshot, sequence }
    const sessions = snapshot.sessions ?? []
    if (session.archived === true) return { ...snapshot, sequence, sessions: sessions.filter((item) => item.id !== session.id) }
    const existing = sessions.find((item) => item.id === session.id)
    const merged = existing ? { ...existing, ...session, messages: session.messages ?? existing.messages, turns: session.turns ?? existing.turns, tools: session.tools ?? existing.tools, files: session.files ?? existing.files } : session
    return { ...snapshot, sequence, sessions: [...sessions.filter((item) => item.id !== session.id), merged] }
  }

  if (event.type === 'session.context.updated') {
    if (!sessionId) return { ...snapshot, sequence }
    const sessions = snapshot.sessions ?? []
    const existing = sessions.find((session) => session.id === sessionId)
    if (!existing) return { ...snapshot, sequence }
    const contextUsed = typeof payload.contextUsed === 'number' ? payload.contextUsed : payload.contextUsed === null ? null : existing.contextUsed
    const contextSize = typeof payload.contextSize === 'number' ? payload.contextSize : payload.contextSize === null ? null : existing.contextSize
    const contextModel = typeof payload.contextModel === 'string' ? payload.contextModel : payload.contextModel === null ? null : existing.contextModel
    const contextEstimated = typeof payload.contextEstimated === 'boolean' ? payload.contextEstimated : payload.contextUsed === null && payload.contextSize === null ? false : existing.contextEstimated
    return {
      ...snapshot,
      sequence,
      sessions: sessions.map((session) => session.id === sessionId ? { ...session, contextUsed, contextSize, contextModel, contextEstimated } : session),
    }
  }

  if (event.type === 'session.context.reset') {
    if (!sessionId) return { ...snapshot, sequence }
    return { ...snapshot, sequence, sessions: (snapshot.sessions ?? []).map((session) => session.id === sessionId ? { ...session, contextUsed:null, contextSize:null, contextModel:null, contextEstimated:false } : session) }
  }

  if (event.type === 'session.deleted') {
    const id = typeof payload.sessionId === 'string' ? payload.sessionId : typeof payload.id === 'string' ? payload.id : undefined
    if (!id) return { ...snapshot, sequence }
    const deletedSessionIds = [...new Set([...(snapshot.deletedSessionIds ?? []), id])]
    return { ...snapshot, sequence, deletedSessionIds, sessions: (snapshot.sessions ?? []).filter((session) => session.id !== id) }
  }

  if (event.type === 'agent.changed') {
    const id = typeof payload.agentId === 'string' ? payload.agentId : undefined
    if (!id) return { ...snapshot, sequence }
    const agents = snapshot.agents ?? []
    if (payload.action === 'deleted') return { ...snapshot, sequence, agents: agents.filter((agent) => agent.id !== id) }
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

  if (event.type === 'permission.auto_resolved') {
    const parsed = parseAutoResolved(payload, typeof sequence === 'number' ? sequence : 0)
    if (!parsed) return { ...snapshot, sequence }
    const rest = (snapshot.autoApprovals ?? []).filter((item) => item.sequence !== parsed.sequence || item.permissionId !== parsed.permissionId)
    return { ...snapshot, sequence, autoApprovals: [parsed, ...rest].sort((a, b) => b.sequence - a.sequence).slice(0, 100) }
  }
  if (event.type === 'permission.bypass_active') {
    const parsed = parseBypassActive(payload, typeof sequence === 'number' ? sequence : 0)
    if (!parsed) return { ...snapshot, sequence }
    return { ...snapshot, sequence, bypassNotices: [parsed, ...(snapshot.bypassNotices ?? [])].sort((a, b) => b.sequence - a.sequence).slice(0, 50) }
  }

  if (event.type === 'project.changed') {
    const projects = snapshot.projects ?? []
    if (payload.action === 'deleted') {
      const projectId = payload.projectId
      return { ...snapshot, sequence, projects: projects.filter((project) => project.id !== projectId), agents: (snapshot.agents ?? []).map((agent) => agent.projectId === projectId ? { ...agent, projectId: null } : agent) }
    }
    const project = payload.project as Project | undefined
    if (!project?.id) return { ...snapshot, sequence }
    return { ...snapshot, sequence, projects: [...projects.filter((item) => item.id !== project.id), project] }
  }
  if (event.type === 'permission.resolved') {
    const permissionId = payload.permissionId ?? (payload.permission as JsonRecord | undefined)?.id ?? payload.id
    return { ...snapshot, sequence, permissions: (snapshot.permissions ?? []).filter((permission) => permission.id !== permissionId) }
  }
  if (event.type === 'daemon.health') return { ...snapshot, sequence, daemon: { ...(snapshot.daemon ?? {}), ...payload } }

  if (!['message.delta', 'message.completed', 'message.reactions.changed', 'tool.changed', 'command.changed', 'file.changed', 'permission.requested', 'usage.updated', 'turn.completed', 'turn.error'].includes(event.type)) {
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
          const added = event.type === 'message.delta' && typeof payload.delta === 'string' ? { ...message, id: messageId, content: payload.delta } : { ...message, id: messageId }
          // A notice for something the turn did ("Messaged X") names the message it reads
          // above, so a live window shows what a reload shows.
          const beforeId = typeof payload.beforeMessageId === 'string' ? payload.beforeMessageId : ''
          const beforeIndex = beforeId ? messages.findIndex((item) => item.id === beforeId) : -1
          if (beforeIndex >= 0) messages.splice(beforeIndex, 0, added)
          else messages.push(added)
        }
        return { ...session, messages }
      }
      if (event.type === 'message.reactions.changed') {
        const messageId = typeof payload.messageId === 'string' ? payload.messageId : ''
        if (!messageId) return session
        const allowed = new Set(['👍', '👎', '❤️', '😂', '🎉', '😮'])
        const reactions = Array.isArray(payload.reactions) ? payload.reactions.filter((reaction): reaction is string => typeof reaction === 'string' && allowed.has(reaction)) : []
        const messages = [...(session.messages ?? session.events ?? [])]
        const index = messages.findIndex((item) => item.id === messageId)
        if (index < 0) return session
        messages[index] = { ...messages[index], reactions }
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
      if (event.type === 'turn.completed') {
        // The turn's own record follows the event, so a turn that errored mid-way and then finished is a completed turn.
        const turnId = typeof payload.turnId === 'string' ? payload.turnId : null
        const turns = turnId ? (session.turns ?? []).map((turn) => turn.id === turnId ? { ...turn, state: 'completed', failureClass: undefined, detail: undefined, recoveryHandled: undefined } : turn) : session.turns
        return { ...session, state: 'completed', ...(turns ? { turns } : {}) }
      }
      if (event.type === 'turn.error') {
        const turnId = typeof payload.turnId === 'string' ? payload.turnId : null
        const turns = (session.turns ?? []).map((turn) => turn.id === turnId
          ? { ...turn, state: 'error', failureClass: payload.failureClass, detail: payload.detail, recoveryHandled: payload.recoveryHandled }
          : turn)
        return { ...session, state: typeof payload.state === 'string' ? payload.state : stateForEvent(event.type) ?? session.state, turns }
      }
      return { ...session, state: stateForEvent(event.type) ?? session.state }
    })
    const permissions = event.type === 'permission.requested' ? [...(snapshot.permissions ?? []), (payload.permission ?? payload) as PermissionRequest] : snapshot.permissions
    const usage = event.type === 'usage.updated' ? [...(snapshot.usage ?? []), (payload.usage ?? payload) as JsonRecord] : snapshot.usage
    return { ...snapshot, sequence, sessions, permissions, usage }
  }

  if (event.type === 'usage.updated') {
    const usage = (payload.usage ?? payload) as JsonRecord
    return { ...snapshot, sequence, usage: [...(snapshot.usage ?? []), usage], usageSummary: { ...(snapshot.usageSummary ?? {}), ...usage } }
  }
  if (event.type === 'permission.requested') return { ...snapshot, sequence, permissions: [...(snapshot.permissions ?? []), (payload.permission ?? payload) as PermissionRequest] }
  return { ...snapshot, sequence }
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

/** Durable board tasks (docs/history/expansion-v2/tasks-contract.md). A task is not a conversation; each attempt is a run. */
export type TaskState = 'unassigned' | 'queued' | 'running' | 'needs_you' | 'awaiting_review' | 'done' | 'failed' | 'cancelled'
export type TaskSupervisionPolicy = 'report_only' | 'bounded' | 'manager_completes'
export interface BoardTaskImage { id: string; name: string; mediaType: string; bytes?: number }
export type BoardTaskSchedule = { kind: 'once'; at: string; timezone?: string } | { kind: 'cron'; cron: string; timezone: string }
/** What a scheduled occurrence did: started, queued behind a busy bot, skipped (late, paused, a copy still going) or failed to start. */
export type TaskScheduleOutcome = 'started' | 'queued' | 'skipped_late' | 'skipped_paused' | 'skipped_overlap' | 'failed_to_start' | 'invalid_schedule'
export interface BoardTask extends JsonRecord {
  id: string
  title: string
  brief: string
  doneGoal: string
  reportBack: string
  projectId: string | null
  sourceUrl?: string | null
  originSessionId?: string | null
  parentTaskId?: string | null
  rootTaskId?: string | null
  assigneeAgentId: string | null
  supervisionPolicy: TaskSupervisionPolicy
  estimateMinutes?: number | null
  maxRuntimeSecs?: number | null
  state: TaskState
  queuePosition?: number | null
  version: number
  createdAt: string
  updatedAt: string
  assignedAt?: string | null
  startedAt?: string | null
  completedAt?: string | null
  images?: BoardTaskImage[]
  /** Null (or absent) means "now": the task runs when it is assigned. */
  schedule?: BoardTaskSchedule | null
  scheduleAgentId?: string | null
  scheduleState?: 'active' | 'completed' | 'missed' | null
  scheduleNextAt?: string | null
  scheduleLastAt?: string | null
  scheduleLastOutcome?: TaskScheduleOutcome | null
  /** The run started without the owner present (a schedule), so it kept the unattended rails. */
  unattended?: boolean
}
export interface BoardTaskRun extends JsonRecord {
  id: string
  taskId: string
  attempt: number
  sessionId?: string | null
  assigneeAgentId?: string | null
  assigneeAgentName?: string | null
  state: TaskState | string
  startedAt?: string | null
  endedAt?: string | null
}
export interface TaskDispatchResult { task: BoardTask; run?: BoardTaskRun | null; disposition: 'started' | 'queued'; queuePosition?: number | null; reason?: 'bot_busy' | 'global_limit' | 'global_pause' | null; replayed?: boolean }

/** The native frosted-glass backdrop of the main window (Haze), as reported by the shell. */
export type WindowBackdrop = { effect: 'acrylic' | 'blur' | 'none'; active: boolean; transparencyOff: boolean; reason?: string }

/** The daemon supervisor in the native shell (wave 12, part E): whether the daemon runs, is restarting or was given up on. */
export type DaemonSupervisor = { state: 'running' | 'restarting' | 'gave_up'; attempt: number; nextRetryMs: number | null; lastExitCode: number | null }

