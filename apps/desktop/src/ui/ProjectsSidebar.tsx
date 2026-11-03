// The sidebar's Projects view (3 November 2026): projects on top, the bots that
// worked in each one under it, and under a bot its three newest conversations in
// that project. The Bots view stays the default; this is an alternative way in.
import { useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import type { Agent, Project, Session } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { ProjectIcon } from './ProjectIcon'
import { shortTime } from './rosterSelectors'
import { isManager, isSideSession, projectOfSession, sessionIsBusy } from './teamSelectors'
import { TeamMenu, type MenuItem } from './TeamSidebar'
import './projectsSidebar.css'

const FOLDED_KEY = 'bitbots.sidebar.foldedProjects'
const RECENT_PER_BOT = 3

const stampOf = (session: Session) => String(session.updatedAt ?? session.createdAt ?? '')

type BotInProject = { agent: Agent; sessions: Session[] }
type ProjectBlock = { key: string; project: Project | null; bots: BotInProject[]; latest: string }

/** Projects newest first; in each, the bots that have a conversation there (or have it as their default), newest first. */
export function projectBlocks(agents: readonly Agent[], projects: readonly Project[], sessions: readonly Session[]): ProjectBlock[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const cells = new Map<string, Map<string, Session[]>>()
  const put = (key: string, agentId: string, session?: Session) => {
    const row = cells.get(key) ?? new Map<string, Session[]>()
    const list = row.get(agentId) ?? []
    if (session) list.push(session)
    row.set(agentId, list)
    cells.set(key, row)
  }
  for (const session of sessions) {
    if (session.archived || isSideSession(session) || !session.agentId || !byId.has(session.agentId)) continue
    put(projectOfSession(session, projects)?.id ?? 'none', session.agentId, session)
  }
  for (const agent of agents) if (agent.projectId && projects.some((project) => project.id === agent.projectId)) put(agent.projectId, agent.id)
  const blocks: ProjectBlock[] = [...projects.map((project) => ({ project, key: project.id })), { project: null, key: 'none' }].map(({ project, key }) => {
    const bots = [...(cells.get(key) ?? new Map<string, Session[]>())].map(([agentId, list]): BotInProject => ({ agent: byId.get(agentId)!, sessions: list.sort((a, b) => stampOf(b).localeCompare(stampOf(a))) }))
    bots.sort((a, b) => stampOf(b.sessions[0] ?? ({} as Session)).localeCompare(stampOf(a.sessions[0] ?? ({} as Session))) || a.agent.name.localeCompare(b.agent.name))
    return { key, project, bots, latest: bots.reduce((best, bot) => { const at = bot.sessions[0] ? stampOf(bot.sessions[0]) : ''; return at > best ? at : best }, '') }
  })
  // The "No project" block only shows when something is in it.
  return blocks.filter((block) => block.project || block.bots.length).sort((a, b) => (a.project ? 0 : 1) - (b.project ? 0 : 1) || b.latest.localeCompare(a.latest) || (a.project?.name ?? '').localeCompare(b.project?.name ?? ''))
}

function storedFolds(): Set<string> { try { return new Set<string>(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]')) } catch { return new Set<string>() } }

export function ProjectsSidebar({ agents, projects, sessions, selectedSessionId, canCreate, onOpenConversation, onStartInProject, onCreateProject }: {
  agents: readonly Agent[]
  projects: readonly Project[]
  sessions: readonly Session[]
  selectedSessionId: string | null
  canCreate: boolean
  /** Opens a conversation of a bot, selecting the bot first. */
  onOpenConversation: (agent: Agent, session: Session) => void
  /** A new conversation with this bot in this project (null for no project). */
  onStartInProject: (agent: Agent, projectId: string | null) => void
  onCreateProject: () => void
}) {
  const bots = useMemo(() => agents.filter((agent) => !agent.archived && !agent.hidden && !agent.parentAgentId && !isManager(agent)), [agents])
  const blocks = useMemo(() => projectBlocks(bots, projects, sessions), [bots, projects, sessions])
  const [folded, setFolded] = useState(storedFolds)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [menu, setMenu] = useState<{ items: MenuItem[]; label: string; x: number; y: number } | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const toggleFold = (key: string) => setFolded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...next])) } catch { /* a remembered fold is a convenience only */ } return next })
  const toggleOpen = (id: string) => setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const pickBot = (button: HTMLElement, block: ProjectBlock) => {
    trigger.current = button
    const rect = button.getBoundingClientRect()
    const name = block.project?.name ?? 'no project'
    setMenu({ label: `Start a conversation in ${name}`, x: rect.left, y: rect.bottom + 4, items: bots.length ? bots.map((agent): MenuItem => ({ label: agent.name, disabled: !canCreate, onSelect: () => { setFolded((current) => { const next = new Set(current); next.delete(block.key); return next }); onStartInProject(agent, block.project?.id ?? null) } })) : [{ label: 'No bots yet', disabled: true }] })
  }
  const closeMenu = () => { setMenu(null); requestAnimationFrame(() => trigger.current?.focus()) }

  return <div className="projects-sidebar" role="tree" aria-label="Projects">
    {blocks.map((block) => {
      const name = block.project?.name ?? 'No project'
      const isFolded = folded.has(block.key)
      return <section key={block.key} className="ps-project" aria-label={name}>
        <div className="ps-project-head">
          <button type="button" className="ps-fold" aria-expanded={!isFolded} aria-label={`${isFolded ? 'Expand' : 'Collapse'} ${name}`} onClick={() => toggleFold(block.key)}>
            {isFolded ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
            <ProjectIcon project={block.project} size={14} />
            <span className="ps-project-name" title={block.project?.path ?? undefined}>{name}</span>
            {isFolded && block.bots.length > 0 && <span className="ps-count">{block.bots.length}</span>}
          </button>
          <button type="button" className="icon-button tiny ps-add" aria-label={`Start a conversation in ${name}`} title="Start a conversation here with a bot" aria-haspopup="menu" onClick={(event) => pickBot(event.currentTarget, block)}><Plus size={13} aria-hidden="true" /></button>
        </div>
        {!isFolded && <ul className="ps-bots" role="group">
          {block.bots.length === 0 && <li className="ps-empty">No bots here yet.</li>}
          {block.bots.map(({ agent, sessions: list }) => {
            const latest = list[0]
            const recent = list.slice(0, RECENT_PER_BOT)
            const rowKey = `${block.key}:${agent.id}`
            const expanded = open.has(rowKey) || recent.some((session) => session.id === selectedSessionId)
            const working = list.some((session) => sessionIsBusy(session))
            return <li key={agent.id} role="none">
              <div className={`ps-bot ${recent.some((session) => session.id === selectedSessionId) ? 'selected' : ''}`}>
                <button type="button" role="treeitem" aria-expanded={recent.length > 1 ? expanded : undefined} className="ps-bot-main" onClick={() => { if (latest) onOpenConversation(agent, latest); else onStartInProject(agent, block.project?.id ?? null) }} title={latest ? 'Open the latest conversation' : `Start a conversation with ${agent.name}`}>
                  <BlobCanvas decorative color={agentColorHex(agent.color)} size={20} mini mood="idle" look={agentLook(agent)} label={agent.name} />
                  <span className="ps-bot-copy"><strong>{agent.name}</strong><span>{latest ? (latest.title?.trim() || 'New chat') : 'No conversations yet'}</span></span>
                  {working ? <i className="convo-dot" aria-label="Working" /> : latest ? <time>{shortTime(stampOf(latest))}</time> : null}
                </button>
                {recent.length > 1 && <button type="button" className="icon-button tiny ps-more" aria-label={`${expanded ? 'Hide' : 'Show'} ${agent.name}'s recent conversations in ${name}`} aria-expanded={expanded} onClick={() => toggleOpen(rowKey)}>{expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}</button>}
              </div>
              {expanded && recent.length > 1 && <ul className="ps-convos" role="group">{recent.map((session) => <li key={session.id} role="none"><button type="button" role="treeitem" aria-current={session.id === selectedSessionId ? 'true' : undefined} className={`ps-convo ${session.id === selectedSessionId ? 'selected' : ''}`} onClick={() => onOpenConversation(agent, session)}><span>{session.title?.trim() || 'New chat'}</span><time>{shortTime(stampOf(session))}</time></button></li>)}</ul>}
            </li>
          })}
        </ul>}
      </section>
    })}
    {blocks.length === 0 && <p className="team-group-empty">No projects yet.</p>}
    <button type="button" className="team-hidden-toggle" onClick={onCreateProject}><Plus size={13} aria-hidden="true" />New project</button>
    {menu && <TeamMenu label={menu.label} position={menu} items={menu.items} onClose={closeMenu} />}
  </div>
}
