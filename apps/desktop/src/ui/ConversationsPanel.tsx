// The per-bot conversations column: every conversation the user had with the
// selected bot, grouped by the project each one works in (Phase 1A: bots work
// in every project), newest first, with bot-to-bot conversations branching
// under the conversation that started them.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Archive, ArrowLeftRight, ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, MoreHorizontal, Pencil, Plus, Search, SlidersHorizontal, Tag, Trash2 } from 'lucide-react'
import type { Agent, Project, Session } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { presentedSessionState } from './sessionOutcome'
import { ancestorIds, conversationsByProject, conversationTree, defaultProjectFor, isEmptyConversation, sessionIsBusy, sideTitle, type ConversationNode } from './teamSelectors'
import { TagEditor, TeamMenu, type MenuItem, type TagTarget } from './TeamSidebar'
import './conversationsPanel.css'

function Face({ agent, name }: { agent: Agent | null | undefined; name: string }) {
  return agent
    ? <BlobCanvas decorative color={agentColorHex(agent.color)} size={16} mini mood="idle" look={agentLook(agent)} label={name} />
    : <span className="convo-face-dot" aria-hidden="true">{name.slice(0, 1)}</span>
}

function relativeTime(value: unknown, now: number) {
  const time = Date.parse(String(value ?? ''))
  if (!Number.isFinite(time)) return ''
  const minutes = Math.max(0, Math.round((now - time) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  return days < 7 ? `${days}d` : new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** More conversations than this get a filter field. */
const FILTER_THRESHOLD = 7

function countNodes(nodes: readonly ConversationNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0)
}

/** Keeps a node when its own title matches every word, or when a conversation under it does. */
function filterTree(nodes: readonly ConversationNode[], words: readonly string[], titleOf: (node: ConversationNode) => string): ConversationNode[] {
  if (!words.length) return [...nodes]
  const kept: ConversationNode[] = []
  for (const node of nodes) {
    const children = filterTree(node.children, words, titleOf)
    const title = titleOf(node).toLocaleLowerCase()
    if (words.every((word) => title.includes(word)) || children.length) kept.push({ ...node, children })
  }
  return kept
}

export type ProjectActions = {
  onCreateProject: () => Promise<Project | undefined | null> | void
  /** Phase 1: the project's model, approvals and setup script. */
  onOpenProjectSettings?: (project: Project) => void
  /** Adds a folder that already exists as a project. */
  onImportProject?: () => Promise<Project | undefined | null> | void
  onRenameProject: (project: Project) => void
  onChangeProjectFolder: (project: Project) => void
  onDeleteProject: (project: Project) => void
}

export function ConversationsPanel({ agent, agents, projects = [], sessions, selectedSessionId, sideSessionId, canCreate, onSelect, onOpenSide, onNew, projectActions, onRename, onArchive, onDelete }: {
  agent: Agent
  agents: readonly Agent[]
  projects?: readonly Project[]
  sessions: readonly Session[]
  selectedSessionId: string | null
  sideSessionId: string | null
  canCreate: boolean
  onSelect: (session: Session) => void
  onOpenSide: (sessionId: string) => void
  /** Starts a conversation in a project: an id, null for no project, or undefined for the bot's default. */
  onNew: (projectId?: string | null) => void
  projectActions?: ProjectActions
  onRename: (session: Session, title: string) => Promise<unknown> | void
  /** Hides the conversation from this list; it can be restored on the bot's page. */
  onArchive?: (session: Session) => void
  onDelete: (session: Session) => void
  /** Kept for callers; hiding the panel now lives in the main header (28 October 2026). */
  onClose?: () => void
}) {
  // Conversations nothing was said in are not listed, except the open one.
  const tree = useMemo(() => conversationTree(sessions.filter((session) => session.id === selectedSessionId || !isEmptyConversation(session)), agent.id), [sessions, agent.id, selectedSessionId])
  const activeId = sideSessionId ?? selectedSessionId
  const [query, setQuery] = useState('')
  const titleOf = (node: ConversationNode) => node.kind === 'side' ? sideTitle(node.session, agents as Agent[]) : (node.session.title?.trim() || 'New chat')
  const total = useMemo(() => countNodes(tree), [tree])
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const shown = words.length ? filterTree(tree, words, titleOf) : tree
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer) }, [])
  // Opening a conversation deep in the tree opens the branches above it.
  useEffect(() => {
    const above = ancestorIds(tree, activeId)
    if (above.length) setExpanded((current) => { const next = new Set(current); for (const id of above) next.add(id); return next })
  }, [tree, activeId])
  const toggle = (id: string) => setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const groups = useMemo(() => conversationsByProject(shown, projects), [shown, projects])
  const fallback = defaultProjectFor(agent, projects)
  const [menu, setMenu] = useState<{ items: MenuItem[]; label: string; x: number; y: number; trigger: HTMLElement } | null>(null)
  const lastTrigger = useRef<HTMLElement | null>(null)
  const [tagTarget, setTagTarget] = useState<TagTarget | null>(null)
  const closeMenu = () => { const trigger = menu?.trigger; setMenu(null); requestAnimationFrame(() => trigger?.focus()) }
  const openMenu = (trigger: HTMLElement, label: string, items: MenuItem[]) => { lastTrigger.current = trigger; const rect = trigger.getBoundingClientRect(); setMenu({ items, label, x: rect.left, y: rect.bottom + 4, trigger }) }
  const pickerItems = (): MenuItem[] => [
    ...projects.map((project): MenuItem => ({ label: project.name, icon: <Folder size={15} />, checked: project.id === fallback?.id, disabled: !project.path, onSelect: () => onNew(project.id) })),
    { label: 'No project', icon: <FolderOpen size={15} />, checked: !fallback, onSelect: () => onNew(null) },
    ...(projectActions ? ['separator', { label: 'New project…', icon: <FolderPlus size={15} />, onSelect: () => void Promise.resolve(projectActions.onCreateProject()).then((project) => { if (project?.id) onNew(project.id) }) }, ...(projectActions.onImportProject ? [{ label: 'Use an existing folder…', icon: <FolderOpen size={15} />, onSelect: () => void Promise.resolve(projectActions.onImportProject?.()).then((project) => { if (project?.id) onNew(project.id) }) }] : [])] as MenuItem[] : []),
  ]
  const projectItems = (project: Project): MenuItem[] => projectActions ? [
    { label: 'New conversation here', icon: <Plus size={15} />, disabled: !canCreate || !project.path, onSelect: () => onNew(project.id) },
    'separator',
    { label: 'Rename project', icon: <Pencil size={15} />, onSelect: () => projectActions.onRenameProject(project) },
    { label: 'Change folder…', icon: <FolderOpen size={15} />, onSelect: () => projectActions.onChangeProjectFolder(project) },
    ...(projectActions.onOpenProjectSettings ? [{ label: 'Project settings…', icon: <SlidersHorizontal size={15} />, onSelect: () => projectActions.onOpenProjectSettings?.(project) }] : []),
    // FIX39 item 21: the Manager matches jobs to a project's tags; they moved here with the project headings.
    { label: 'Tags…', icon: <Tag size={15} />, onSelect: () => setTagTarget({ kind: 'project', id: project.id, name: project.name, tags: [...(project.tags ?? [])] }) },
    'separator',
    { label: 'Delete project', icon: <Trash2 size={15} />, danger: true, onSelect: () => projectActions.onDeleteProject(project) },
  ] : []

  const renderNode = (node: ConversationNode, depth: number) => {
    const { session } = node
    const open = expanded.has(session.id) || words.length > 0
    const busy = sessionIsBusy(session)
    const state = String(presentedSessionState(session) ?? '').toLowerCase()
    const needsYou = state === 'waiting_permission'
    const failed = state === 'error' || state === 'failed'
    const active = session.id === activeId
    const peer = node.kind === 'side' ? agents.find((item) => item.id === (node.role === 'sender' ? session.agentId : session.link?.peerAgentId)) : undefined
    const peerName = peer?.name ?? (node.role === 'receiver' ? session.link?.peerName : undefined) ?? 'Teammate'
    const title = node.kind === 'side' ? sideTitle(session, agents as Agent[]) : (session.title?.trim() || 'New chat')
    const open_ = () => node.kind === 'side' ? onOpenSide(session.id) : onSelect(session)
    return <li key={session.id} className="convo-item" role="treeitem" aria-level={depth + 1} aria-selected={active} aria-expanded={node.children.length ? open : undefined}>
      <div className={`convo-row ${active ? 'active' : ''} ${node.kind}${node.children.length > 0 ? ' branch' : ''}`} style={{ ['--depth' as string]: depth }}>
        {node.children.length > 0
          ? <button type="button" className={`convo-twisty ${open ? 'open' : ''}`} aria-label={open ? `Hide conversations under ${title}` : `Show ${node.children.length} conversation${node.children.length === 1 ? '' : 's'} under ${title}`} onClick={() => toggle(session.id)}><ChevronRight size={12} aria-hidden="true" /></button>
          : <span className="convo-twisty-space" aria-hidden="true" />}
        {renaming === session.id
          ? <RenameField initial={session.title?.trim() || ''} onDone={async (value) => { setRenaming(null); if (value && value !== session.title?.trim()) await onRename(session, value) }} />
          : <button type="button" className="convo-open" onClick={open_} onDoubleClick={() => { if (node.kind === 'main') setRenaming(session.id) }} title={title}>
            {node.kind === 'side' && <span className="convo-pair" aria-hidden="true"><Face agent={node.role === 'sender' ? agent : peer} name={node.role === 'sender' ? agent.name : peerName} /><ArrowLeftRight size={10} /><Face agent={node.role === 'sender' ? peer : agent} name={node.role === 'sender' ? peerName : agent.name} /></span>}
            <span className="convo-copy">
              <span className="convo-title">{title}</span>
              {node.kind === 'side' && <span className="convo-sub">{node.role === 'sender' ? `Asked ${peerName}` : `From ${peerName}`}</span>}
            </span>
            {needsYou ? <span className="convo-flag needs">Needs you</span> : failed ? <span className="convo-flag failed">Failed</span> : busy ? <i className="convo-dot" aria-label="Working" /> : <time className="convo-time">{relativeTime(session.updatedAt ?? session.createdAt, now)}</time>}
          </button>}
        {node.kind === 'main' && renaming !== session.id && <span className="convo-actions">
          <button type="button" className="convo-action" aria-label={`Rename ${title}`} title="Rename" onClick={() => setRenaming(session.id)}><Pencil size={12} aria-hidden="true" /></button>
          {onArchive && <button type="button" className="convo-action" aria-label={`Archive ${title}`} title="Archive (restore it from the bot's page)" disabled={busy} onClick={() => onArchive(session)}><Archive size={12} aria-hidden="true" /></button>}
          <button type="button" className="convo-action danger" aria-label={`Delete ${title}`} title="Delete" disabled={busy} onClick={() => onDelete(session)}><Trash2 size={12} aria-hidden="true" /></button>
        </span>}
      </div>
      {open && node.children.length > 0 && <ul role="group" className="convo-children" style={{ ['--parent-depth' as string]: depth }}>{node.children.map((child) => renderNode(child, depth + 1))}</ul>}
    </li>
  }

  return <aside className="conversations-panel" aria-label={`${agent.name}'s conversations`}>
    {/* Owner, 28 October 2026: the title alone up top; hiding the panel lives beside the bot's name in the main
        header, and a new conversation starts from one clear button under the title. */}
    <div className="convo-head">
      <strong>Conversations</strong>
    </div>
    <div className="convo-new-row">
      <div className="convo-new-split">
        <button type="button" className="convo-new" aria-label="New conversation" title={fallback ? `Start a conversation in ${fallback.name}` : 'Start a conversation with no project'} disabled={!canCreate} onClick={() => onNew()}><Plus size={14} aria-hidden="true" />New conversation</button>
        <button type="button" className="convo-new-pick" aria-label="Choose the project for a new conversation" aria-haspopup="menu" title="Choose a project" disabled={!canCreate} onClick={(event) => openMenu(event.currentTarget, 'Start a conversation in', pickerItems())}><ChevronDown size={13} aria-hidden="true" /></button>
      </div>
      <span className="convo-new-where">{fallback ? <><Folder size={11} aria-hidden="true" />{fallback.name}</> : 'No project'}</span>
    </div>
    {total > FILTER_THRESHOLD && <label className="convo-filter"><Search size={13} aria-hidden="true" /><input type="search" value={query} placeholder="Find a conversation" aria-label="Find a conversation" spellCheck={false} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery('') } }} /></label>}
    <div className="convo-scroll">
      {tree.length > 0 && shown.length === 0 && <p className="convo-empty">No conversation matches “{query.trim()}”.</p>}
      {tree.length === 0 && <p className="convo-empty">No conversations with {agent.name} yet.</p>}
      {groups.map(({ key, project, nodes }) => {
        const name = project?.name ?? 'No project'
        return <section key={key} className="convo-project" aria-label={name} data-project-id={project?.id ?? 'none'}>
          <h3 className="convo-group convo-project-head">
            {project ? <Folder size={12} aria-hidden="true" /> : <FolderOpen size={12} aria-hidden="true" />}
            <span className="convo-project-name" title={project?.path ?? undefined}>{name}</span>
            {project?.tags && project.tags.length > 0 && <span className="project-tags" title={project.tags.join(', ')}>{project.tags.map((tag) => <span key={tag} className="project-tag">{tag}</span>)}</span>}
            <span className="convo-project-tools">
              <button type="button" className="convo-action" aria-label={`New conversation in ${name}`} title="New conversation here" disabled={!canCreate || (!!project && !project.path)} onClick={() => onNew(project?.id ?? null)}><Plus size={12} aria-hidden="true" /></button>
              {project && projectActions && <button type="button" className="convo-action" aria-label={`${name} options`} aria-haspopup="menu" title="Project options" onClick={(event) => openMenu(event.currentTarget, `${name} actions`, projectItems(project))}><MoreHorizontal size={12} aria-hidden="true" /></button>}
            </span>
          </h3>
          <ul role="tree" className="convo-list">{nodes.map((node) => renderNode(node, 0))}</ul>
        </section>
      })}
    </div>
    {menu && <TeamMenu label={menu.label} position={menu} items={menu.items} onClose={closeMenu} />}
    {tagTarget && <TagEditor target={tagTarget} onClose={() => { setTagTarget(null); requestAnimationFrame(() => lastTrigger.current?.focus()) }} />}
  </aside>
}

function RenameField({ initial, onDone }: { initial: string; onDone: (value: string) => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const finish = (save: boolean) => { if (done.current) return; done.current = true; onDone(save ? value.trim().slice(0, 120) : '') }
  return <input ref={ref} className="convo-rename" aria-label="Conversation name" value={value} maxLength={120}
    onChange={(event) => setValue(event.target.value)}
    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') { event.preventDefault(); finish(true) } if (event.key === 'Escape') { event.preventDefault(); finish(false) } }}
    onBlur={() => finish(true)} />
}
