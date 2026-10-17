// Pure helpers for the project-first team layout: one main conversation per
// blob, side conversations between blobs, and project grouping.
import type { Agent, ChatMessage, Project, Session } from '../types'

const BUSY = ['starting', 'working', 'cancelling', 'waiting_permission']

export function isSideSession(session: Session | null | undefined) {
  return session?.link?.kind === 'side'
}

/** Conversations a schedule started. They belong to the blob but are never its main conversation. */
export function isAutomationSession(session: Session | null | undefined) {
  return session?.link?.kind === 'automation'
}

/** A blob's main conversation: its newest open session that is neither a side conversation nor a scheduled run. */
export function mainSessionFor(sessions: readonly Session[], agentId: string): Session | null {
  return sessions
    .filter((session) => session.agentId === agentId && !session.archived && !isSideSession(session) && !isAutomationSession(session))
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0] ?? null
}

/** Side conversations a blob takes part in, as either side, newest first. */
export function sideSessionsFor(sessions: readonly Session[], agentId: string): Session[] {
  return sessions
    .filter((session) => isSideSession(session) && !session.archived && (session.agentId === agentId || session.link?.peerAgentId === agentId))
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

export function sessionIsBusy(session: Session | null | undefined) {
  return BUSY.includes(String(session?.state ?? '').toLowerCase())
}

function messageText(message: ChatMessage) {
  const raw = typeof message.content === 'string' ? message.content : typeof message.text === 'string' ? message.text : ''
  return raw.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
}

/** One-line preview of the latest meaningful message, or null when there is none. */
export function conversationPreview(session: Session | null | undefined): string | null {
  const messages = session?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const role = String(message.role ?? '')
    if (role === 'thinking') continue
    if (role === 'notice' && message.meta?.kind === 'delegation') return `Messaged ${message.meta.peerName ?? 'a teammate'}`
    if (message.meta?.kind === 'blob_reply') return `Message from ${message.meta.fromName ?? 'a teammate'}`
    if (role === 'notice' && message.meta?.kind === 'blob_created') return `Created ${typeof message.meta.name === 'string' ? message.meta.name : 'a teammate'}`
    const text = messageText(message)
    if (text) return role === 'user' && !message.meta ? `You: ${text}` : text
  }
  return null
}

/** True for Bitbots' own per-bot folder (`<data>/workspaces/<id>`), which is not a name people know. */
export function isBotWorkspacePath(path: string) {
  return /[\\/]workspaces[\\/][^\\/]+[\\/]?$/i.test(path)
}

/**
 * Where a conversation works, as a name people recognise: the daemon's label,
 * else the bot's project, else the folder name of a real project folder.
 * Null for a casual bot working in its own Bitbots workspace.
 */
export function conversationPlaceName(session: Session | null | undefined, agents: readonly Agent[], projects: readonly Project[]): string | null {
  if (!session) return null
  const label = typeof session.workspaceLabel === 'string' ? session.workspaceLabel.trim() : ''
  if (label) return label
  const projectId = typeof session.projectId === 'string' ? session.projectId : agents.find((agent) => agent.id === session.agentId)?.projectId
  const project = projectId ? projects.find((item) => item.id === projectId) : undefined
  if (project?.name) return project.name
  const path = typeof session.projectPath === 'string' ? session.projectPath : ''
  if (!path || isBotWorkspacePath(path)) return null
  return path.split(/[\\/]/).filter(Boolean).pop() ?? null
}

export type ProjectGroup = { project: Project | null; agents: Agent[] }

/** Projects in their saved order, then casual blobs; hidden blobs only when asked for. */
export function groupAgentsByProject(agents: readonly Agent[], projects: readonly Project[], query = '', showHidden = false): ProjectGroup[] {
  const needle = query.trim().toLowerCase()
  const visible = agents.filter((agent) => !agent.archived && (showHidden || agent.hidden !== true)
    && (!needle || [agent.name, agent.role, agent.description].some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))))
  const known = new Set(projects.map((project) => project.id))
  const groups: ProjectGroup[] = [...projects]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((project) => ({ project, agents: visible.filter((agent) => agent.projectId === project.id) }))
  // Within a group, blobs keep the daemon's order (runtime, then saved position).
  groups.push({ project: null, agents: visible.filter((agent) => !agent.projectId || !known.has(agent.projectId)) })
  return needle ? groups.filter((group) => group.agents.length > 0) : groups
}

export function leaderOf(agents: readonly Agent[]) {
  return agents.find((agent) => agent.leader === true && !agent.archived) ?? null
}

/** Names mentioned with @ in a prompt, matched against the team (longest names first). */
export function mentionedAgents(text: string, agents: readonly Agent[]): Agent[] {
  const lower = text.toLowerCase()
  return [...agents]
    .filter((agent) => !agent.archived)
    .sort((a, b) => b.name.length - a.name.length)
    .filter((agent) => {
      const index = lower.indexOf(`@${agent.name.toLowerCase()}`)
      if (index < 0) return false
      const after = lower[index + agent.name.length + 1]
      return after === undefined || !/[\p{L}\p{N}_]/u.test(after)
    })
}

/** The `@query` being typed at the caret, if any. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /(^|\s)@([\p{L}\p{N}_ .-]{0,40})$/u.exec(before)
  if (!match) return null
  const query = match[2]
  if (/\s{2,}|\s$/.test(query) && query.trim().split(/\s+/).length > 2) return null
  return { start: before.length - query.length - 1, query }
}

export type MentionSegment = { text: string; agent?: undefined } | { text: string; agent: Agent }

/** Splits a prompt into plain text and `@Name` mentions of team blobs (longest names win). */
export function splitMentions(text: string, agents: readonly Agent[]): MentionSegment[] {
  const team = agents.filter((agent) => !agent.archived && agent.name.trim()).sort((a, b) => b.name.length - a.name.length)
  const lower = text.toLowerCase()
  const segments: MentionSegment[] = []
  let plainStart = 0
  let index = 0
  while (index < text.length) {
    const at = text.indexOf('@', index)
    if (at < 0) break
    const before = at === 0 ? '' : text[at - 1]
    const agent = /[\p{L}\p{N}_]/u.test(before) ? undefined : team.find((candidate) => {
      const name = candidate.name.toLowerCase()
      if (!lower.startsWith(name, at + 1)) return false
      const after = text[at + 1 + name.length]
      return after === undefined || !/[\p{L}\p{N}_]/u.test(after)
    })
    if (!agent) { index = at + 1; continue }
    if (at > plainStart) segments.push({ text: text.slice(plainStart, at) })
    const end = at + 1 + agent.name.length
    segments.push({ text: text.slice(at, end), agent })
    plainStart = index = end
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart) })
  return segments
}

/** The `#query` being typed at the caret, if any: a side conversation reference. */
export function hashQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /(^|\s)#([^\n#@]{0,60})$/u.exec(before)
  if (!match) return null
  const query = match[2]
  if (query.trim().split(/\s+/).length > 6) return null
  return { start: before.length - query.length - 1, query }
}

export type ReferenceSegment = { text: string; reference?: { id: string; title: string } }

/** Splits a sent prompt into plain text and the `#Title` references it carried (longest titles first). */
export function splitReferences(text: string, references: ReadonlyArray<{ id: string; title: string }> | null | undefined): ReferenceSegment[] {
  const refs = [...(references ?? [])].filter((ref) => ref.title.trim()).sort((a, b) => b.title.length - a.title.length)
  if (!refs.length) return [{ text }]
  const segments: ReferenceSegment[] = []
  let plainStart = 0
  let index = 0
  while (index < text.length) {
    const hash = text.indexOf('#', index)
    if (hash < 0) break
    const reference = refs.find((ref) => text.startsWith(ref.title, hash + 1))
    if (!reference) { index = hash + 1; continue }
    if (hash > plainStart) segments.push({ text: text.slice(plainStart, hash) })
    segments.push({ text: `#${reference.title}`, reference })
    index = hash + 1 + reference.title.length
    plainStart = index
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart) })
  return segments
}

/** The topic a side conversation was given, if any (older ones are titled by the pair). */
export function sideTopic(session: Session): string | null {
  const topic = typeof session.link?.topic === 'string' ? session.link.topic.trim() : ''
  if (topic) return topic
  const title = typeof session.title === 'string' ? session.title.trim() : ''
  return title && !title.includes('⇄') ? title : null
}

/** A side conversation's title: its topic, or the pair for older conversations. */
export function sideTitle(session: Session, agents: readonly Agent[]) {
  const topic = sideTopic(session)
  if (topic) return topic
  const peer = agents.find((agent) => agent.id === session.link?.peerAgentId)?.name ?? session.link?.peerName ?? 'Teammate'
  const target = agents.find((agent) => agent.id === session.agentId)?.name ?? 'Teammate'
  return `${peer} and ${target}`
}

export type ConversationRole = 'sender' | 'receiver' | null
export interface ConversationNode {
  session: Session
  kind: 'main' | 'side'
  /** For bot-to-bot conversations: whether this bot asked (sender) or was asked (receiver). */
  role: ConversationRole
  children: ConversationNode[]
}

const updatedAtOf = (session: Session) => String(session.updatedAt ?? session.createdAt ?? '')

/**
 * Every conversation a bot had in its project, as a tree: its own
 * conversations at the top, and each bot-to-bot conversation under the
 * conversation that started it (both when this bot asked and when it was
 * asked). Mirrors the daemon's `agent.conversations`, but from the live session
 * list so it updates with events and needs no round trip. Newest first.
 */
export function conversationTree(sessions: readonly Session[], agentId: string, projectId?: string | null): ConversationNode[] {
  const rows = sessions.filter((session) => {
    if (session.archived) return false
    const kind = String(session.link?.kind ?? '')
    const mine = session.agentId === agentId && kind !== 'automation' && kind !== 'handoff'
    const asked = kind === 'side' && session.link?.peerAgentId === agentId
    if (!mine && !asked) return false
    // A conversation stamped for another project belongs to that project's view.
    return !projectId || !session.projectId || session.projectId === projectId
  })
  const ids = new Set(rows.map((session) => session.id))
  const nodes = new Map<string, ConversationNode>(rows.map((session) => {
    const side = session.link?.kind === 'side'
    const role: ConversationRole = !side ? null : session.link?.peerAgentId === agentId ? 'sender' : 'receiver'
    return [session.id, { session, kind: side ? 'side' : 'main', role, children: [] }]
  }))
  const roots: ConversationNode[] = []
  for (const node of nodes.values()) {
    const link = node.session.link
    const parentId = node.kind === 'side' ? (link?.spawnedFromSessionId ?? link?.originSessionId) : undefined
    const parent = parentId && parentId !== node.session.id && ids.has(parentId) ? nodes.get(parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (list: ConversationNode[]) => {
    list.sort((a, b) => updatedAtOf(b.session).localeCompare(updatedAtOf(a.session)))
    for (const node of list) sort(node.children)
  }
  sort(roots)
  return roots
}

/** Ids of every conversation above `sessionId` in the tree, so its branch can be opened. */
export function ancestorIds(tree: readonly ConversationNode[], sessionId: string | null | undefined): string[] {
  if (!sessionId) return []
  const walk = (nodes: readonly ConversationNode[], trail: string[]): string[] | null => {
    for (const node of nodes) {
      if (node.session.id === sessionId) return trail
      const found = walk(node.children, [...trail, node.session.id])
      if (found) return found
    }
    return null
  }
  return walk(tree, []) ?? []
}

/** How many conversations load in the background at the same time. */
export const HYDRATE_AT_ONCE = 4

/**
 * Conversations still to load in full, in the order they should load: the
 * selected bot's first, newest first within each group. Archived ones and
 * ones already loaded are left out.
 */
export function hydrationOrder(sessions: readonly Session[], selectedAgentId: string | null): Session[] {
  const time = (session: Session) => Date.parse(session.updatedAt ?? session.createdAt ?? '') || 0
  return sessions
    .filter((session) => !session.archived && !Array.isArray(session.messages) && !Array.isArray(session.turns))
    .sort((a, b) => Number(b.agentId === selectedAgentId && !!selectedAgentId) - Number(a.agentId === selectedAgentId && !!selectedAgentId) || time(b) - time(a))
}
