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

/** Grouping key for a stored project path. Display only — never sent to `session.new`. */
export function projectKey(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null
  const trimmed = path.trim()
  if (!trimmed) return null
  const slashed = trimmed.replaceAll('/', '\\')
  const collapsed = slashed.startsWith('\\\\')
    ? `\\\\${slashed.slice(2).replace(/\\+/g, '\\')}`
    : slashed.replace(/\\+/g, '\\')
  const rooted = /^[A-Za-z]:\\$/.test(collapsed) ? collapsed : collapsed.replace(/\\+$/, '')
  if (!rooted) return null
  return rooted.toLocaleLowerCase('en')
}

export function sessionDotClass(state?: string): 'good' | 'busy' | 'bad' | 'muted' {
  const value = (state ?? '').toLowerCase()
  if (value === 'completed') return 'good'
  if (value === 'starting' || value === 'working' || value === 'cancelling' || value === 'waiting_permission' || value === 'waiting_user') return 'busy'
  if (value === 'error' || value === 'offline' || value === 'failed') return 'bad'
  return 'muted'
}

export interface ProjectGroup {
  key: string | null
  path: string
  label: string
  sessions: Session[]
}

function pathSegments(path: string) {
  return path.split(/[/\\]/).filter((segment) => segment.length > 0)
}

function disambiguateLabels(entries: Array<{ path: string }>): string[] {
  const nodes = entries.map((entry) => {
    const segments = pathSegments(entry.path)
    return { segments, used: 1, label: segments.at(-1) || projectFolderName(entry.path), path: entry.path }
  })
  const fold = (label: string) => label.toLocaleLowerCase('en')
  const countsOf = () => {
    const counts = new Map<string, number>()
    for (const node of nodes) counts.set(fold(node.label), (counts.get(fold(node.label)) ?? 0) + 1)
    return counts
  }
  for (let guard = 0; guard < 64; guard += 1) {
    const counts = countsOf()
    const stuck = nodes.filter((node) => (counts.get(fold(node.label)) ?? 0) > 1)
    if (!stuck.length) break
    let progressed = false
    for (const node of stuck) {
      const ancestorIndex = node.segments.length - 1 - node.used
      if (ancestorIndex < 0) continue
      const ancestor = node.segments[ancestorIndex]
      if (ancestor === undefined) continue
      node.label = `${node.label} · ${ancestor}`
      node.used += 1
      progressed = true
    }
    if (!progressed) break
  }
  const counts = countsOf()
  for (const node of nodes) {
    if ((counts.get(fold(node.label)) ?? 0) > 1) node.label = `${node.label} (${node.path})`
  }
  return nodes.map((node) => node.label)
}

export function projectGroups(sessions: readonly Session[] | null | undefined, agentId: string): ProjectGroup[] {
  const buckets = new Map<string, { key: string | null; path: string; sessions: Session[]; newest: string }>()
  for (const session of agentSessions(sessions, agentId)) {
    const key = projectKey(session.projectPath)
    const mapKey = key ?? '\0'
    const existing = buckets.get(mapKey)
    if (!existing) buckets.set(mapKey, { key, path: session.projectPath ?? '', sessions: [session], newest: session.updatedAt ?? '' })
    else existing.sessions.push(session)
  }
  const named = [...buckets.values()].filter((bucket) => bucket.key !== null)
  const labels = disambiguateLabels(named.map((bucket) => ({ path: bucket.path })))
  const labelByKey = new Map<string, string>()
  named.forEach((bucket, index) => labelByKey.set(bucket.key as string, labels[index] ?? projectFolderName(bucket.path)))
  return [...buckets.values()]
    .map((bucket) => ({
      key: bucket.key,
      path: bucket.path,
      label: bucket.key === null ? 'Project path unavailable' : labelByKey.get(bucket.key) ?? projectFolderName(bucket.path),
      sessions: bucket.sessions,
      newest: bucket.newest,
    }))
    .sort((left, right) => right.newest.localeCompare(left.newest)
      || (left.key ?? '').localeCompare(right.key ?? '')
      || left.path.localeCompare(right.path))
    .map((bucket) => ({ key: bucket.key, path: bucket.path, label: bucket.label, sessions: bucket.sessions }))
}

export interface RecentProject {
  key: string
  path: string
  label: string
}

export function recentProjects(sessions: readonly Session[] | null | undefined, agent: Pick<Agent, 'id' | 'defaultProject'>, limit: number): RecentProject[] {
  const rows: RecentProject[] = projectGroups(sessions, agent.id)
    .filter((group): group is ProjectGroup & { key: string } => group.key !== null)
    .map((group) => ({ key: group.key, path: group.path, label: group.label }))
  const pinned = typeof agent.defaultProject === 'string' ? agent.defaultProject.trim() : ''
  const pinnedKey = pinned ? projectKey(pinned) : null
  if (pinned && pinnedKey) {
    const index = rows.findIndex((row) => row.key === pinnedKey)
    if (index >= 0) {
      const [existing] = rows.splice(index, 1)
      if (existing) rows.unshift({ ...existing, label: `${existing.label} · Default` })
    } else rows.unshift({ key: pinnedKey, path: pinned, label: `${projectFolderName(pinned)} · Default` })
  }
  return rows.slice(0, Math.max(0, limit))
}

export function sessionSelectionTarget(agents: readonly Agent[] | null | undefined, currentAgent: Agent | null, session: Session): { agentId: string; sessionId: string } | null {
  const ownerId = session.agentId
  if (typeof ownerId === 'string' && ownerId.length > 0) {
    const owner = activeAgents(agents).find((agent) => agent.id === ownerId)
    if (!owner) return null
    return { agentId: owner.id, sessionId: session.id }
  }
  if (ownerId === '') return null
  if (currentAgent && currentAgent.archived !== true && currentAgent.runtimeId === session.runtimeId) {
    return { agentId: currentAgent.id, sessionId: session.id }
  }
  const host = agentsForRuntime(agents, session.runtimeId)[0]
  if (!host) return null
  return { agentId: host.id, sessionId: session.id }
}

export interface ForceOpen {
  blob: boolean
  projects: Record<string, boolean>
  other: boolean
}

export interface TreeRow {
  agent: Agent
  latest: Session | null
  matchedTitle: string | null
  projects: ProjectGroup[]
  other: Session[] | null
  forceOpen: ForceOpen
}

function titleHits(list: readonly Session[], needle: string) {
  return list.filter((session) => typeof session.title === 'string' && session.title.trim() && containsQuery(session.title, needle))
}

export function treeModel(agents: readonly Agent[] | null | undefined, sessions: readonly Session[] | null | undefined, query: string): { groups: Array<{ runtimeId: string; rows: TreeRow[] }> } {
  const needle = query.trim().toLocaleLowerCase('en')
  const rows: TreeRow[] = []
  for (const agent of activeAgents(agents)) {
    const owned = agentSessions(sessions, agent.id)
    const nameHit = !needle || containsQuery(agent.name, needle)
    const ownedHits = needle ? titleHits(owned, needle) : []
    const host = agentsForRuntime(agents, agent.runtimeId)[0]
    const isHost = host?.id === agent.id
    const legacy = isHost ? legacySessions(sessions, agent.runtimeId) : []
    const legacyHits = needle && isHost ? titleHits(legacy, needle) : []
    const ownedTitleHit = ownedHits.length > 0
    const legacyTitleHit = !nameHit && !ownedTitleHit && legacyHits.length > 0
    if (needle && !nameHit && !ownedTitleHit && !legacyTitleHit) continue
    const allProjects = projectGroups(sessions, agent.id)
    const forceOpen: ForceOpen = { blob: false, projects: {}, other: false }
    let projects = allProjects
    let other: Session[] | null = isHost && legacy.length > 0 ? legacy : null
    let matched: Session | undefined
    if (needle && !nameHit && ownedTitleHit) {
      forceOpen.blob = true
      const ids = new Set(ownedHits.map((session) => session.id))
      projects = allProjects
        .map((group) => ({ ...group, sessions: group.sessions.filter((session) => ids.has(session.id)) }))
        .filter((group) => group.sessions.length > 0)
      for (const group of projects) forceOpen.projects[group.key ?? ''] = true
      other = null
      matched = [...ownedHits].sort(bySessionRecency)[0]
    } else if (legacyTitleHit) {
      forceOpen.blob = true
      forceOpen.other = true
      projects = []
      other = [...legacyHits].sort(bySessionRecency)
      matched = other[0]
    }
    rows.push({
      agent,
      latest: owned[0] ?? null,
      matchedTitle: matched?.title?.trim() ? matched.title : null,
      projects,
      other,
      forceOpen,
    })
  }
  const groups: Array<{ runtimeId: string; rows: TreeRow[] }> = []
  for (const row of rows) {
    const last = groups.at(-1)
    if (!last || last.runtimeId !== row.agent.runtimeId) groups.push({ runtimeId: row.agent.runtimeId, rows: [row] })
    else last.rows.push(row)
  }
  return { groups }
}

export interface ExpandedBlob {
  open: boolean
  projects: Record<string, boolean>
  other: boolean
}

export interface ExpandedState {
  v: 1
  blobs: Record<string, ExpandedBlob>
}

export function emptyExpandedState(): ExpandedState {
  return { v: 1, blobs: {} }
}

export function parseExpandedState(raw: string | null): ExpandedState {
  if (!raw) return emptyExpandedState()
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return emptyExpandedState() }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyExpandedState()
  const document = parsed as Record<string, unknown>
  if (document.v !== 1) return emptyExpandedState()
  const incoming = document.blobs
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return emptyExpandedState()
  const blobs: Record<string, ExpandedBlob> = {}
  for (const [id, value] of Object.entries(incoming as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    if (typeof entry.open !== 'boolean') continue
    const projects: Record<string, boolean> = {}
    if (entry.projects && typeof entry.projects === 'object' && !Array.isArray(entry.projects)) {
      for (const [key, bit] of Object.entries(entry.projects as Record<string, unknown>)) {
        if (typeof bit === 'boolean') projects[key] = bit
      }
    }
    blobs[id] = { open: entry.open, projects, other: typeof entry.other === 'boolean' ? entry.other : false }
  }
  return { v: 1, blobs }
}

function expandedEqual(left: ExpandedState, right: ExpandedState) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function garbageCollectExpanded(state: ExpandedState, agents: readonly Agent[] | null | undefined, sessions: readonly Session[] | null | undefined): ExpandedState {
  const list = agents ?? []
  const blobs: Record<string, ExpandedBlob> = {}
  for (const [id, entry] of Object.entries(state.blobs)) {
    const agent = list.find((item) => item.id === id)
    if (!agent || agent.archived === true) continue
    const live = new Set(projectGroups(sessions, id).map((group) => group.key ?? ''))
    const projects: Record<string, boolean> = {}
    for (const [key, bit] of Object.entries(entry.projects)) {
      if (typeof bit === 'boolean' && live.has(key)) projects[key] = bit
    }
    const host = agentsForRuntime(list, agent.runtimeId)[0]
    const other = host?.id === id && legacySessions(sessions, agent.runtimeId).length > 0 ? entry.other === true : false
    blobs[id] = { open: entry.open === true, projects, other }
  }
  const next: ExpandedState = { v: 1, blobs }
  return expandedEqual(state, next) ? state : next
}

export const OTHER_CAP_KEY = '\0other'
export const PROJECT_CAP = 12
export const SESSION_CAP = 30

export interface LayoutSession {
  id: string
  session: Session
  pos: number
}

export interface LayoutMore {
  id: string
  label: string
  pos: number
  capKey: string
}

export interface LayoutProject {
  id: string
  group: ProjectGroup
  open: boolean
  pos: number
  sessions: LayoutSession[]
  more: LayoutMore | null
  sessionSetSize: number
}

export interface BlobLayout {
  empty: boolean
  level2Size: number
  projects: LayoutProject[]
  moreProjects: LayoutMore | null
  other: {
    id: string
    open: boolean
    pos: number
    sessions: LayoutSession[]
    more: LayoutMore | null
    sessionSetSize: number
  } | null
}

export interface LayoutFocus {
  id: string
  kind: 'project' | 'other' | 'session' | 'more'
  label: string
  parentId: string
  session?: Session
  projectKey: string | null
  projectPath?: string
  capKey?: string
}

function capSlice<T>(items: readonly T[], limit: number) {
  if (!Number.isFinite(limit) || items.length <= limit) return { shown: [...items], hidden: 0 }
  const count = Math.max(0, Math.floor(limit))
  return { shown: items.slice(0, count), hidden: items.length - count }
}

function moreLabel(count: number, singular: string, plural: string) {
  return `Show ${count} more ${count === 1 ? singular : plural}`
}

export function treeItemId(kind: 'blob' | 'project' | 'other' | 'session' | 'more', agentId: string, key = '') {
  if (kind === 'blob') return `blob:${agentId}`
  if (kind === 'other') return `other:${agentId}`
  if (kind === 'session') return `session:${key}`
  if (kind === 'project') return `project:${agentId}:${key}`
  return `more:${agentId}:${key}`
}

export function sessionDisplayTitle(session: Session) {
  return formatUnknownSafe(session.title, 'New session')
}

export function layoutBlobTree(args: {
  agentId: string
  projects: readonly ProjectGroup[]
  other: readonly Session[] | null
  openProjects: Readonly<Record<string, boolean>>
  otherOpen: boolean
  projectLimit: number
  sessionLimit: number
  uncappedSessionKeys: readonly string[]
}): { layout: BlobLayout; focus: LayoutFocus[] } {
  const uncapped = new Set(args.uncappedSessionKeys)
  const blobId = treeItemId('blob', args.agentId)
  const cappedProjects = capSlice(args.projects, args.projectLimit)
  let level2 = 0
  const nextLevel2 = () => { level2 += 1; return level2 }
  const focus: LayoutFocus[] = []
  const projects: LayoutProject[] = cappedProjects.shown.map((group) => {
    const key = group.key ?? ''
    const open = args.openProjects[key] === true
    const pos = nextLevel2()
    const id = treeItemId('project', args.agentId, key)
    const limit = uncapped.has(key) ? Number.POSITIVE_INFINITY : args.sessionLimit
    const cappedSessions = capSlice(group.sessions, limit)
    const sessionSetSize = cappedSessions.shown.length + (cappedSessions.hidden > 0 ? 1 : 0)
    const sessions = cappedSessions.shown.map((session, index) => ({ id: treeItemId('session', args.agentId, session.id), session, pos: index + 1 }))
    const more = cappedSessions.hidden > 0 ? {
      id: treeItemId('more', args.agentId, key),
      label: moreLabel(cappedSessions.hidden, 'conversation', 'conversations'),
      pos: sessions.length + 1,
      capKey: key,
    } : null
    focus.push({ id, kind: 'project', label: group.label, parentId: blobId, projectKey: group.key, projectPath: group.path })
    if (open) {
      for (const item of sessions) focus.push({ id: item.id, kind: 'session', label: sessionDisplayTitle(item.session), parentId: id, session: item.session, projectKey: group.key, projectPath: group.path })
      if (more) focus.push({ id: more.id, kind: 'more', label: more.label, parentId: id, projectKey: group.key, projectPath: group.path, capKey: key })
    }
    return { id, group, open, pos, sessions, more, sessionSetSize }
  })
  const moreProjects = cappedProjects.hidden > 0 ? {
    id: treeItemId('more', args.agentId, 'projects'),
    label: moreLabel(cappedProjects.hidden, 'project', 'projects'),
    pos: nextLevel2(),
    capKey: 'projects',
  } : null
  if (moreProjects) focus.push({ id: moreProjects.id, kind: 'more', label: moreProjects.label, parentId: blobId, projectKey: null, capKey: 'projects' })
  let other: BlobLayout['other'] = null
  if (args.other && args.other.length > 0) {
    const id = treeItemId('other', args.agentId)
    const pos = nextLevel2()
    const limit = uncapped.has(OTHER_CAP_KEY) ? Number.POSITIVE_INFINITY : args.sessionLimit
    const cappedSessions = capSlice(args.other, limit)
    const sessions = cappedSessions.shown.map((session, index) => ({ id: treeItemId('session', args.agentId, session.id), session, pos: index + 1 }))
    const more = cappedSessions.hidden > 0 ? {
      id: treeItemId('more', args.agentId, 'other'),
      label: moreLabel(cappedSessions.hidden, 'conversation', 'conversations'),
      pos: sessions.length + 1,
      capKey: OTHER_CAP_KEY,
    } : null
    other = { id, open: args.otherOpen, pos, sessions, more, sessionSetSize: sessions.length + (more ? 1 : 0) }
    focus.push({ id, kind: 'other', label: 'Other sessions', parentId: blobId, projectKey: null })
    if (args.otherOpen) {
      for (const item of sessions) focus.push({ id: item.id, kind: 'session', label: sessionDisplayTitle(item.session), parentId: id, session: item.session, projectKey: null })
      if (more) focus.push({ id: more.id, kind: 'more', label: more.label, parentId: id, projectKey: null, capKey: OTHER_CAP_KEY })
    }
  }
  return {
    layout: { empty: projects.length === 0 && !moreProjects && !other, level2Size: level2, projects, moreProjects, other },
    focus,
  }
}
