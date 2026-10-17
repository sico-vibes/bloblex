// The companion's "which conversation" control: a bot's own conversations,
// newest first, and the project it works in. Choosing one makes it the
// companion's (and the main window's) open conversation.
import { FolderOpen, MessageSquare } from 'lucide-react'
import type { Agent, Project, Session } from '../types'
import { Select } from './Select'
import { isAutomationSession, isEmptyConversation, isSideSession } from './teamSelectors'

/** A bot's conversations the companion can switch between, newest first. */
export function companionConversations(sessions: readonly Session[], agentId: string, currentId: string | null): Session[] {
  return sessions
    .filter((session) => session.agentId === agentId && !session.archived && !isSideSession(session) && !isAutomationSession(session) && (session.id === currentId || !isEmptyConversation(session)))
    .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')))
    .slice(0, 30)
}

export function botProjectName(agent: Agent | null, projects: readonly Project[]): string | null {
  if (!agent?.projectId) return null
  return projects.find((project) => project.id === agent.projectId)?.name ?? null
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
  const project = botProjectName(agent, projects)
  return <div className="companion-convo-picker" data-companion-no-drag="">
    <span className="companion-convo-project" title={project ? `${agent.name} works in ${project}` : `${agent.name} has no project`}><FolderOpen size={12} aria-hidden="true" />{project ?? 'No project'}</span>
    {conversations.length > 0
      ? <Select ariaLabel={`${agent.name}'s conversations`} variant="muted" value={current?.id ?? ''} onChange={(id) => { const chosen = conversations.find((item) => item.id === id); if (chosen) onPick(chosen) }}
        options={conversations.map((session) => ({ value: session.id, label: session.title?.trim() || 'New chat' }))} />
      : <span className="companion-convo-none"><MessageSquare size={12} aria-hidden="true" />No conversations yet</span>}
  </div>
}
