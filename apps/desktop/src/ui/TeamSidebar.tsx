// Project-first sidebar: projects group blobs; each blob is one ongoing
// conversation. Casual blobs (no project) live under "Unassigned".
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Folder, FolderInput, FolderOpen, FolderPlus, MailOpen, Mail, MoreHorizontal, Pencil, Pin, PinOff, Plus, Settings2, Star, Trash2, Copy as Duplicate, Download } from 'lucide-react'
import type { Agent, Project, Runtime, Session } from '../types'
import { agentLook } from '../blob/look'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentColorHex } from './agentColor'
import { deriveCompanionStatus } from './companionStatus'
import { shortTime } from './rosterSelectors'
import { conversationPreview, groupAgentsByProject, mainSessionFor, sessionIsBusy } from './teamSelectors'

export type MenuItem = { label: string; icon?: ReactNode; onSelect?: () => void; disabled?: boolean; danger?: boolean; checked?: boolean; submenu?: MenuItem[] } | 'separator'

export function TeamMenu({ items, position, label, onClose }: { items: MenuItem[]; position: { x: number; y: number }; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>(':scope > button:not(:disabled)')?.focus() }, [])
  useEffect(() => {
    const onPointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey, true) }
  }, [onClose])
  const move = (event: React.KeyboardEvent<HTMLDivElement>, root: HTMLElement | null) => {
    const buttons = Array.from(root?.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)') ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
    if (next >= 0 && buttons.length) { event.preventDefault(); event.stopPropagation(); buttons[next].focus() }
  }
  const left = Math.max(8, Math.min(position.x, window.innerWidth - 236))
  const top = Math.max(8, Math.min(position.y, window.innerHeight - 40 - items.length * 34))
  return <div ref={ref} className="team-menu" role="menu" aria-label={label} style={{ left, top }} onKeyDown={(event) => move(event, ref.current)}>
    {items.map((item, index) => item === 'separator'
      ? <span key={`sep-${index}`} className="team-menu-separator" role="separator" />
      : <MenuButton key={item.label} item={item} open={open === index} onOpen={() => setOpen(item.submenu ? index : null)} onClose={onClose} />)}
  </div>
}

function MenuButton({ item, open, onOpen, onClose }: { item: Exclude<MenuItem, 'separator'>; open: boolean; onOpen: () => void; onClose: () => void }) {
  const subRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (open) requestAnimationFrame(() => subRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()) }, [open])
  return <>
    <button ref={buttonRef} type="button" role="menuitem" aria-haspopup={item.submenu ? 'menu' : undefined} aria-expanded={item.submenu ? open : undefined} className={`team-menu-item ${item.danger ? 'danger' : ''}`} disabled={item.disabled}
      onMouseEnter={onOpen}
      onKeyDown={(event) => { if (item.submenu && (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen() } }}
      onClick={() => { if (item.submenu) { onOpen(); return } onClose(); item.onSelect?.() }}>
      <span className="team-menu-icon" aria-hidden="true">{item.icon}</span>
      <span>{item.label}</span>
      {item.checked && <span className="team-menu-check" aria-hidden="true">✓</span>}
      {item.submenu && <ChevronRight size={14} className="team-menu-caret" aria-hidden="true" />}
    </button>
    {open && item.submenu && <div ref={subRef} className="team-menu team-submenu" role="menu" aria-label={item.label} style={{ top: Math.max(0, (buttonRef.current?.offsetTop ?? 0) - 6) }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); buttonRef.current?.focus(); return }
        const buttons = Array.from(subRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : -1
        if (next >= 0) { event.preventDefault(); event.stopPropagation(); buttons[next]?.focus() }
      }}>
      {item.submenu.map((sub, index) => sub === 'separator' ? <span key={`sub-sep-${index}`} className="team-menu-separator" role="separator" /> : <button key={sub.label} type="button" role="menuitemradio" aria-checked={sub.checked === true} className="team-menu-item" disabled={sub.disabled} onClick={() => { onClose(); sub.onSelect?.() }}>
        <span className="team-menu-icon" aria-hidden="true">{sub.icon}</span><span>{sub.label}</span>{sub.checked && <span className="team-menu-check" aria-hidden="true">✓</span>}
      </button>)}
    </div>}
  </>
}

export type TeamSidebarActions = {
  onSelect: (agent: Agent) => void
  onCreate: (projectId: string | null) => void
  onCreateProject: () => void
  onEdit: (agent: Agent) => void
  onArchive: (agent: Agent) => void
  onDuplicate: (agent: Agent) => void
  onExportBlob: (agent: Agent) => void
  onRename: (agent: Agent) => void
  onTogglePin: (agentId: string) => void
  onMove: (agent: Agent, projectId: string | null) => void
  onToggleLeader: (agent: Agent) => void
  onSetHidden: (agent: Agent, hidden: boolean) => void
  onToggleUnread: (agent: Agent, session: Session | null, unread: boolean) => void
  onCopyConversationId: (agent: Agent, session: Session | null) => void
  onDeleteConversation: (agent: Agent, session: Session) => void
  onRenameProject: (project: Project) => void
  onChangeProjectFolder: (project: Project) => void
  onDeleteProject: (project: Project) => void
  onToggleProjectCollapsed: (project: Project) => void
}

export function TeamSidebar({ agents, projects, sessions, runtimes, connected, now, pinnedIds, unreadSessionIds, approvalSessionIds, selectedAgentId, query, onQueryChange, actions }: {
  agents: Agent[]
  projects: Project[]
  sessions: Session[]
  runtimes: Runtime[]
  connected: boolean
  now: number
  pinnedIds: string[]
  unreadSessionIds: ReadonlySet<string>
  approvalSessionIds: ReadonlySet<string>
  selectedAgentId: string | null
  query: string
  onQueryChange: (query: string) => void
  actions: TeamSidebarActions
}) {
  const [showHidden, setShowHidden] = useState(false)
  const [menu, setMenu] = useState<{ kind: 'blob'; agent: Agent; x: number; y: number } | { kind: 'project'; project: Project; x: number; y: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const menuTrigger = useRef<HTMLElement | null>(null)
  const groups = useMemo(() => groupAgentsByProject(agents, projects, query, showHidden), [agents, projects, query, showHidden])
  const pinned = pinnedIds.map((id) => agents.find((agent) => agent.id === id && !agent.archived && (showHidden || !agent.hidden))).filter((agent): agent is Agent => !!agent)
  const hiddenCount = agents.filter((agent) => !agent.archived && agent.hidden).length
  const rowOrder = [...pinned, ...groups.flatMap((group) => group.project?.collapsed ? [] : group.agents.filter((agent) => !pinnedIds.includes(agent.id)))]
  const closeMenu = () => { setMenu(null); requestAnimationFrame(() => menuTrigger.current?.focus()) }

  const openBlobMenu = (agent: Agent, x: number, y: number, trigger: HTMLElement | null) => { menuTrigger.current = trigger; setMenu({ kind: 'blob', agent, x, y }) }
  const blobMenu = (agent: Agent): MenuItem[] => {
    const session = mainSessionFor(sessions, agent.id)
    const unread = !!session && unreadSessionIds.has(session.id)
    const isPinned = pinnedIds.includes(agent.id)
    return [
      { label: isPinned ? 'Unpin' : 'Pin', icon: isPinned ? <PinOff size={15} /> : <Pin size={15} />, onSelect: () => actions.onTogglePin(agent.id) },
      { label: 'Move to', icon: <FolderInput size={15} />, submenu: [
        ...projects.map((project) => ({ label: project.name, icon: <Folder size={15} />, checked: agent.projectId === project.id, onSelect: () => actions.onMove(agent, project.id) })),
        { label: 'Unassigned', icon: <FolderOpen size={15} />, checked: !agent.projectId, onSelect: () => actions.onMove(agent, null) },
        'separator',
        { label: 'New project…', icon: <FolderPlus size={15} />, onSelect: actions.onCreateProject },
      ] },
      { label: unread ? 'Mark as read' : 'Mark as unread', icon: unread ? <MailOpen size={15} /> : <Mail size={15} />, disabled: !session, onSelect: () => actions.onToggleUnread(agent, session, !unread) },
      'separator',
      { label: 'Rename blob', icon: <Pencil size={15} />, onSelect: () => actions.onRename(agent) },
      { label: agent.leader ? 'Remove as leader' : 'Make team leader', icon: <Star size={15} />, onSelect: () => actions.onToggleLeader(agent) },
      { label: 'Edit blob', icon: <Settings2 size={15} />, onSelect: () => actions.onEdit(agent) },
      { label: 'Duplicate', icon: <Duplicate size={15} />, onSelect: () => actions.onDuplicate(agent) },
      { label: 'Export blob…', icon: <Download size={15} />, onSelect: () => actions.onExportBlob(agent) },
      { label: 'Copy conversation ID', icon: <Copy size={15} />, disabled: !session, onSelect: () => actions.onCopyConversationId(agent, session) },
      'separator',
      { label: 'Delete conversation…', icon: <Trash2 size={15} />, danger: true, disabled: !session || sessionIsBusy(session), onSelect: () => { if (session) actions.onDeleteConversation(agent, session) } },
      { label: agent.hidden ? 'Show in sidebar' : 'Hide from sidebar', icon: agent.hidden ? <Eye size={15} /> : <EyeOff size={15} />, onSelect: () => actions.onSetHidden(agent, !agent.hidden) },
      { label: 'Archive', icon: <Archive size={15} />, danger: true, onSelect: () => actions.onArchive(agent) },
    ]
  }
  const projectMenu = (project: Project): MenuItem[] => [
    { label: 'New blob here', icon: <Plus size={15} />, onSelect: () => actions.onCreate(project.id) },
    { label: 'Rename project', icon: <Pencil size={15} />, onSelect: () => actions.onRenameProject(project) },
    { label: 'Change folder…', icon: <FolderOpen size={15} />, onSelect: () => actions.onChangeProjectFolder(project) },
    'separator',
    { label: 'Delete project', icon: <Trash2 size={15} />, danger: true, onSelect: () => actions.onDeleteProject(project) },
  ]

  const renderRow = (agent: Agent) => {
    const session = mainSessionFor(sessions, agent.id)
    const runtime = runtimes.find((item) => item.id === agent.runtimeId)
    const status = deriveCompanionStatus({ connected, runtime, session, now })
    const selected = agent.id === selectedAgentId
    const unread = !!session && unreadSessionIds.has(session.id)
    const approval = !!session && approvalSessionIds.has(session.id)
    const waiting = String(session?.state ?? '') === 'waiting_permission'
    const working = sessionIsBusy(session) && !waiting
    const preview = !connected ? 'Offline' : status.mood === 'offline' ? status.label : waiting ? 'Waiting for you' : working ? status.label : conversationPreview(session) ?? (agent.description?.trim() || 'Say hi to get started')
    return <button key={agent.id} type="button" role="treeitem" draggable data-agent-id={agent.id} aria-current={selected ? 'true' : undefined} aria-selected={selected}
      aria-label={`${agent.name}${agent.role ? `, ${agent.role}` : ''}${agent.leader ? ', team leader' : ''}${approval ? ', needs approval' : unread ? ', unread' : ''}`}
      tabIndex={selected || (!selectedAgentId && rowOrder[0]?.id === agent.id) ? 0 : -1}
      className={`bot-row team-row ${selected ? 'selected' : ''} ${agent.hidden ? 'hidden-blob' : ''}`}
      onClick={() => actions.onSelect(agent)}
      onContextMenu={(event) => { event.preventDefault(); openBlobMenu(agent, event.clientX, event.clientY, event.currentTarget) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.onSelect(agent); return }
        if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openBlobMenu(agent, rect.left + 24, rect.bottom, event.currentTarget); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const index = rowOrder.findIndex((item) => item.id === agent.id)
          const next = rowOrder[index + (event.key === 'ArrowDown' ? 1 : -1)]
          if (next) document.querySelector<HTMLButtonElement>(`.team-row[data-agent-id="${CSS.escape(next.id)}"]`)?.focus()
        }
      }}
      onDragStart={(event) => { event.dataTransfer.setData('application/x-bloblex-agent', agent.id); event.dataTransfer.effectAllowed = 'move' }}>
      <span className="team-row-avatar">
        <BlobCanvas color={agentColorHex(agent.color)} size={50} mood={status.mood} look={agentLook(agent)} label={agent.name} />
        {agent.leader && <span className="leader-badge" title="Team leader" aria-hidden="true"><Star size={8} strokeWidth={0} fill="currentColor" /></span>}
      </span>
      <span className="bot-row-copy">
        <span className="bot-row-line">
          <span className="team-row-name"><strong>{agent.name}</strong>{agent.role?.trim() && <span className="role-chip">{agent.role.trim()}</span>}</span>
          {(unread || approval) && <i className={`unread-dot ${approval ? 'approval' : ''}`} aria-hidden="true" />}
          {session?.updatedAt && <time>{shortTime(session.updatedAt)}</time>}
        </span>
        <span className="bot-row-line"><span className={`bot-row-preview ${waiting ? 'waiting' : working ? 'active' : ''}`}>{preview}</span></span>
      </span>
    </button>
  }

  const dropProps = (projectId: string | null) => ({
    onDragOver: (event: React.DragEvent) => { if (!event.dataTransfer.types.includes('application/x-bloblex-agent')) return; event.preventDefault(); setDropTarget(projectId ?? 'unassigned') },
    onDragLeave: (event: React.DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) },
    onDrop: (event: React.DragEvent) => {
      const id = event.dataTransfer.getData('application/x-bloblex-agent')
      setDropTarget(null)
      const agent = agents.find((item) => item.id === id)
      if (agent && (agent.projectId ?? null) !== projectId) { event.preventDefault(); actions.onMove(agent, projectId) }
    },
  })

  return <div className="team-sidebar">
    <label className="sidebar-search"><span className="sr-only">Search blobs</span>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input value={query} placeholder="Search" aria-label="Search blobs" onChange={(event) => onQueryChange(event.target.value)} />
    </label>
    <nav className="sidebar-scroll" aria-label="Blobs"><div role="tree" aria-label="Blobs by project">
      {pinned.length > 0 && <section className="team-group" aria-label="Pinned">
        <div className="team-group-head static"><Pin size={13} aria-hidden="true" /><span>Pinned</span></div>
        <div className="team-group-rows">{pinned.map(renderRow)}</div>
      </section>}
      {groups.map(({ project, agents: members }) => {
        const key = project?.id ?? 'unassigned'
        const rows = members.filter((agent) => !pinnedIds.includes(agent.id))
        if (!project && rows.length === 0 && members.length === 0 && projects.length > 0 && !query) return null
        return <section key={key} className={`team-group ${dropTarget === key ? 'drop-target' : ''}`} aria-label={project?.name ?? 'Unassigned'} {...dropProps(project?.id ?? null)}>
          <div className="team-group-head">
            {project ? <button type="button" className="team-group-toggle" aria-expanded={!project.collapsed} onClick={() => actions.onToggleProjectCollapsed(project)}
              onContextMenu={(event) => { event.preventDefault(); menuTrigger.current = event.currentTarget; setMenu({ kind: 'project', project, x: event.clientX, y: event.clientY }) }}>
              {project.collapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
              <Folder size={13} aria-hidden="true" />
              <span title={project.path ?? undefined}>{project.name}</span>
            </button> : <span className="team-group-title"><FolderOpen size={13} aria-hidden="true" /><span>Unassigned</span></span>}
            <span className="team-group-actions">
              <button type="button" className="icon-button tiny" aria-label={`New blob in ${project?.name ?? 'Unassigned'}`} title="New blob" onClick={() => actions.onCreate(project?.id ?? null)}><Plus size={14} /></button>
              {project && <button type="button" className="icon-button tiny" aria-label={`${project.name} options`} title="Project options" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); menuTrigger.current = event.currentTarget; setMenu({ kind: 'project', project, x: rect.left, y: rect.bottom + 4 }) }}><MoreHorizontal size={14} /></button>}
            </span>
          </div>
          {!project?.collapsed && <div className="team-group-rows" role="group">
            {rows.map(renderRow)}
            {rows.length === 0 && <p className="team-group-empty">{project ? 'Drag a blob here, or create one.' : 'Blobs without a project take general requests.'}</p>}
          </div>}
        </section>
      })}
      {agents.filter((agent) => !agent.archived).length === 0 && <p className="team-group-empty">No blobs yet. Create one to start chatting.</p>}
      </div>
      {hiddenCount > 0 && <button type="button" className="team-hidden-toggle" onClick={() => setShowHidden((value) => !value)}>{showHidden ? <EyeOff size={13} /> : <Eye size={13} />}{showHidden ? 'Hide hidden blobs' : `Show ${hiddenCount} hidden blob${hiddenCount === 1 ? '' : 's'}`}</button>}
    </nav>
    {menu?.kind === 'blob' && <TeamMenu label={`${menu.agent.name} actions`} position={menu} items={blobMenu(menu.agent)} onClose={closeMenu} />}
    {menu?.kind === 'project' && <TeamMenu label={`${menu.project.name} actions`} position={menu} items={projectMenu(menu.project)} onClose={closeMenu} />}
  </div>
}
