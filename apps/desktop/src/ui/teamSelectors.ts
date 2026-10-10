// Pure helpers for the project-first team layout: one main conversation per
// blob, side conversations between blobs, and project grouping.
import type { Agent, ChatMessage, Project, Session } from '../types'

const BUSY = ['starting', 'working', 'cancelling', 'waiting_permission']

export function isSideSession(session: Session | null | undefined) {
  return session?.link?.kind === 'side'
}

/** A blob's main conversation: its newest open session that is not a side conversation. */
export function mainSessionFor(sessions: readonly Session[], agentId: string): Session | null {
  return sessions
    .filter((session) => session.agentId === agentId && !session.archived && !isSideSession(session))
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
    const text = messageText(message)
    if (text) return role === 'user' && !message.meta ? `You: ${text}` : text
  }
  return null
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
