import type { Agent, Runtime, Session } from '../types'
import { formatUnknownSafe, labelize } from '../types'

export function scalarLength(value: string) {
  return Array.from(value).length
}

function byRoster(left: Agent, right: Agent) {
  return left.runtimeId.localeCompare(right.runtimeId)
    || left.sortOrder - right.sortOrder
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
}

function bySessionRecency(left: Session, right: Session) {
  const time = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
  return time || left.id.localeCompare(right.id)
}

export function activeAgents(agents: readonly Agent[] | null | undefined): Agent[] {
  return [...(agents ?? [])].filter((agent) => agent.archived === false).sort(byRoster)
}

export function agentsForRuntime(agents: readonly Agent[] | null | undefined, runtimeId: string): Agent[] {
  return activeAgents(agents).filter((agent) => agent.runtimeId === runtimeId)
}

export function agentSessions(sessions: readonly Session[] | null | undefined, agentId: string): Session[] {
  return [...(sessions ?? [])].filter((session) => session.agentId === agentId).sort(bySessionRecency)
}

export function legacySessions(sessions: readonly Session[] | null | undefined, runtimeId: string): Session[] {
  return [...(sessions ?? [])]
    .filter((session) => (session.agentId === null || session.agentId === undefined) && session.runtimeId === runtimeId)
    .sort(bySessionRecency)
}

export interface RosterRow {
  agent: Agent
  latest: Session | null
  matchedTitle: string | null
}

function containsQuery(value: string, query: string) {
  return value.toLocaleLowerCase('en').includes(query)
}

export function rosterRows(agents: readonly Agent[] | null | undefined, sessions: readonly Session[] | null | undefined, query: string): RosterRow[] {
  const needle = query.trim().toLocaleLowerCase('en')
  const rows: RosterRow[] = []
  for (const agent of activeAgents(agents)) {
    const owned = agentSessions(sessions, agent.id)
    const nameHit = !needle || containsQuery(agent.name, needle)
    const titleHits = needle
      ? owned.filter((session) => typeof session.title === 'string' && session.title.trim() && containsQuery(session.title, needle))
      : []
    if (needle && !nameHit && titleHits.length === 0) continue
    const matched = !nameHit && titleHits.length
      ? [...titleHits].sort(bySessionRecency)[0]
      : undefined
    rows.push({ agent, latest: owned[0] ?? null, matchedTitle: matched?.title?.trim() ? matched.title : null })
  }
  return rows
}

export interface RosterGroup {
  runtimeId: string
  rows: RosterRow[]
}

export function rosterGroups(rows: readonly RosterRow[]): RosterGroup[] {
  const groups: RosterGroup[] = []
  for (const row of rows) {
    const last = groups.at(-1)
    if (!last || last.runtimeId !== row.agent.runtimeId) groups.push({ runtimeId: row.agent.runtimeId, rows: [row] })
    else last.rows.push(row)
  }
  return groups
}

function isUserMessage(message: Record<string, unknown> | undefined) {
  return String(message?.role ?? message?.kind ?? 'assistant').toLowerCase() === 'user'
}

export function sessionPreview(session: Session | null): string | null {
  if (!session) return null
  const last = (session.messages ?? []).at(-1)
  const text = last && (typeof last.content === 'string' ? last.content : typeof last.text === 'string' ? last.text : '')
  if (text) return `${isUserMessage(last) ? 'You: ' : ''}${text.replace(/\s+/g, ' ').slice(0, 90)}`
  return formatUnknownSafe(session.title, session.projectPath?.split(/[\\/]/).pop() ?? 'New session')
}

export function shortTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return ''
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function rosterPreview(row: RosterRow, connected: boolean, statusLabel: string) {
  if (row.matchedTitle) return `Session: ${row.matchedTitle}`
  const preview = sessionPreview(row.latest)
  if (preview) return preview
  return connected ? statusLabel : 'Daemon disconnected'
}

export function projectFolderName(path?: string | null) {
  if (!path?.trim()) return 'Project path unavailable'
  return path.split(/[\\/]/).filter(Boolean).pop() || 'Project path unavailable'
}

export function runtimeUsable(runtime: Runtime | null | undefined) {
  if (!runtime) return false
  return ['online', 'ready', 'available', 'connected'].includes((runtime.status ?? '').toLowerCase())
}

/** Mirrors `statusClass` in App.tsx so roster dots use the same buckets. */
export function runtimeDotClass(status?: string) {
  const value = (status ?? '').toLowerCase()
  if (value === 'online' || value === 'ready' || value === 'available' || value === 'connected') return 'good'
  if (value === 'busy' || value === 'working') return 'busy'
  if (value === 'error' || value === 'offline' || value === 'disconnected') return 'bad'
  return 'muted'
}

export function runtimeOptionLabel(runtime: Runtime, runtimes: readonly Runtime[]) {
  const version = typeof runtime.version === 'string' ? runtime.version.trim() : ''
  const text = version ? `${labelize(runtime.provider)} · ${version}` : labelize(runtime.provider)
  const shares = runtimes.filter((item) => {
    const otherVersion = typeof item.version === 'string' ? item.version.trim() : ''
    const other = otherVersion ? `${labelize(item.provider)} · ${otherVersion}` : labelize(item.provider)
    return other === text
  })
  return shares.length > 1 ? `${text} · ${runtime.id}` : text
}

export function rosterGroupLabel(runtime: Runtime | undefined, runtimeId: string) {
  if (!runtime) return runtimeId
  const version = typeof runtime.version === 'string' ? runtime.version.trim() : ''
  return version ? `${labelize(runtime.provider)} · ${version}` : labelize(runtime.provider)
}

function takeScalars(value: string, count: number) {
  return Array.from(value).slice(0, Math.max(0, count)).join('')
}

export function duplicateAgentName(sourceName: string, activeNames: readonly string[]) {
  const taken = new Set(activeNames.map((name) => name.trim().toLocaleLowerCase('en')))
  const source = sourceName.trim()
  const prefix = 'Copy of '
  for (let index = 1; index < 1000; index += 1) {
    const suffix = index === 1 ? '' : ` (${index})`
    const room = 60 - scalarLength(prefix) - scalarLength(suffix)
    const candidate = `${prefix}${takeScalars(source, room)}${suffix}`
    if (!candidate.trim()) continue
    if (!taken.has(candidate.toLocaleLowerCase('en'))) return candidate
  }
  return `${prefix}${takeScalars(source, 60 - scalarLength(prefix))}`
}

/** `order` is the pre-change active roster, still containing `archivedId`. */
export function nextAgentAfterArchive(order: readonly Agent[], archivedId: string): Agent | null {
  const index = order.findIndex((agent) => agent.id === archivedId)
  const rest = order.filter((agent) => agent.id !== archivedId && agent.archived !== true)
  if (!rest.length) return null
  if (index >= 0) {
    for (let cursor = index + 1; cursor < order.length; cursor += 1) {
      const candidate = order[cursor]
      if (candidate && candidate.id !== archivedId && candidate.archived !== true) return candidate
    }
  }
  return rest[0] ?? null
}

export function sessionBelongsToAgent(session: Session, agent: Agent) {
  if (session.agentId === agent.id) return true
  return (session.agentId === null || session.agentId === undefined) && session.runtimeId === agent.runtimeId
}

export function sessionForSelection(sessions: readonly Session[], agent: Agent, selectedSessionId: string | null, activeSessionId: string | null): Session | null {
  const selected = sessions.find((session) => session.id === selectedSessionId)
  if (selected && sessionBelongsToAgent(selected, agent)) return selected
  if (!selectedSessionId) {
    const active = sessions.find((session) => session.id === activeSessionId)
    if (active && sessionBelongsToAgent(active, agent)) return active
    return agentSessions(sessions, agent.id)[0] ?? null
  }
  return agentSessions(sessions, agent.id)[0] ?? null
}

/** Bloblex-initiated creates. Exactly `agentId` and `projectPath` — never `runtimeId`. */
export function sessionNewParams(agentId: string, projectPath: string) {
  return { agentId, projectPath }
}

export function companionPills(agents: readonly Agent[], selectedId: string | null): Agent[] {
  const active = activeAgents(agents)
  const window = active.slice(0, 4)
  if (!selectedId || window.some((agent) => agent.id === selectedId)) return window
  const selected = active.find((agent) => agent.id === selectedId)
  if (!selected) return window
  if (window.length < 4) return [...window, selected]
  return [...window.slice(0, 3), selected]
}
