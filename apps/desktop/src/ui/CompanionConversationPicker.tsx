// The companion's "which conversation" control: a bot's own conversations,
// newest first, and the project the open one works in (Phase 1A: a bot works in
// every project). Choosing one makes it the companion's (and the main window's)
// open conversation.
import { FolderOpen, MessageSquare } from 'lucide-react'
import type { Agent, Project, Session } from '../types'
import { Select } from './Select'
import { defaultProjectFor, isAutomationSession, isEmptyConversation, isSideSession, projectOfSession } from './teamSelectors'

/** A bot's conversations the companion can switch between, newest first. */
export function companionConversations(sessions: readonly Session[], agentId: string, currentId: string | null): Session[] {
  return sessions
    .filter((session) => session.agentId === agentId && !session.archived && !isSideSession(session) && !isAutomationSession(session) && (session.id === currentId || !isEmptyConversation(session)))
    .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')))
    .slice(0, 30)
}

/** The project shown beside the picker: the open conversation's, else where the bot's next conversation starts. */
export function botProjectName(agent: Agent | null, projects: readonly Project[], current: Session | null = null): string | null {
  if (!agent) return null
  if (current) return projectOfSession(current, projects)?.name ?? null
  return defaultProjectFor(agent, projects)?.name ?? null
}

export function CompanionConversationPicker({ agent, sessions, projects, current, onPick }: {
  agent: Agent | null
  sessions: readonly Session[]
  projects: readonly Project[]
  current: Session | null
  onPick: (session: Session) => void
}) {
  if (!agent) return null
  const conversations = companionConversations(sessions, agent.id, current?.id ?? null)
  const project = botProjectName(agent, projects, current)
  // With conversations in more than one project, they are grouped under each
  // project's name, the most recently used project first.
  const titleOf = (session: Session) => session.title?.trim() || 'New chat'
  const byProject = new Map<string, Session[]>()
  for (const session of conversations) {
    const place = projectOfSession(session, projects)?.name ?? 'No project'
    byProject.set(place, [...(byProject.get(place) ?? []), session])
  }
  const options = byProject.size > 1
    ? [...byProject].flatMap(([place, rows]) => rows.map((session, index) => ({ value: session.id, label: titleOf(session), ...(index === 0 ? { group: place } : {}) })))
    : conversations.map((session) => ({ value: session.id, label: titleOf(session) }))
  return <div className="companion-convo-picker" data-companion-no-drag="">
    <span className="companion-convo-project" title={project ? `This conversation works in ${project}` : 'This conversation has no project'}><FolderOpen size={12} aria-hidden="true" />{project ?? 'No project'}</span>
    {conversations.length > 0
      ? <Select ariaLabel={`${agent.name}'s conversations`} variant="muted" value={current?.id ?? ''} onChange={(id) => { const chosen = conversations.find((item) => item.id === id); if (chosen) onPick(chosen) }}
        options={options} />
      : <span className="companion-convo-none"><MessageSquare size={12} aria-hidden="true" />No conversations yet</span>}
  </div>
}
