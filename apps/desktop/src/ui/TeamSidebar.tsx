// Project-first sidebar: projects group blobs; each blob is one ongoing
// conversation. Casual blobs (no project) live under "Unassigned".
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Folder, FolderInput, FolderOpen, FolderPlus, MailOpen, Mail, MoreHorizontal, Pencil, Pin, PinOff, Plus, Settings2, Star, Trash2, Copy as Duplicate, Download } from 'lucide-react'
import type { Agent, Project, Runtime, Session } from '../types'
import { agentLook } from '../blob/look'
import { RuntimeMark } from './providerBrand'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentColorHex } from './agentColor'
import { deriveCompanionStatus } from './companionStatus'
import { RuntimeProblemMarker, runtimeProblem } from './RuntimeProblemMarker'
import { shortTime } from './rosterSelectors'
import { conversationPreview, groupAgentsByProject, mainSessionFor, sessionIsBusy } from './teamSelectors'
import { useEntityNoun } from './vocabulary'

export type MenuItem = { label: string; icon?: ReactNode; onSelect?: () => void; disabled?: boolean; danger?: boolean; checked?: boolean; submenu?: MenuItem[] } | 'separator'

/** Where a pointer drag would land: on a row edge, or on a project area. */
export type DropHint = { kind: 'row'; agentId: string; edge: 'before' | 'after' } | { kind: 'project'; projectId: string | null }

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
      {item.checked && <Check size={14} className="team-menu-check" aria-hidden="true" />}
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
        <span className="team-menu-icon" aria-hidden="true">{sub.icon}</span><span>{sub.label}</span>{sub.checked && <Check size={14} className="team-menu-check" aria-hidden="true" />}
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
  /** Keyboard move one step inside the blob's own project. */
  onReorder: (agent: Agent, direction: -1 | 1) => void
  /** Pointer drop: place the blob before or after another blob (same or another project). */
  onPlace: (agent: Agent, target: Agent, edge: 'before' | 'after') => void
  onToggleLeader: (agent: Agent) => void
  onSetHidden: (agent: Agent, hidden: boolean) => void
  onToggleUnread: (agent: Agent, session: Session | null, unread: boolean) => void
  onCopyConversationId: (agent: Agent, session: Session | null) => void
  onDeleteConversation: (agent: Agent, session: Session) => void
  onRenameProject: (project: Project) => void
  onChangeProjectFolder: (project: Project) => void
  onDeleteProject: (project: Project) => void
  onToggleProjectCollapsed: (project: Project) => void
  onOpenRuntimeSettings: () => void
}

export function TeamSidebar({ agents, projects, sessions, runtimes, runtimeLogos = false, connected, now, pinnedIds, unreadSessionIds, approvalSessionIds, selectedAgentId, query, onQueryChange, actions }: {
  agents: Agent[]
  projects: Project[]
  sessions: Session[]
  runtimes: Runtime[]
  /** Experimental: show each blob's runtime logo before its name. */
  runtimeLogos?: boolean
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
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const Nouns = useEntityNoun({ plural: true, capital: true })
  const [showHidden, setShowHidden] = useState(false)
  const [menu, setMenu] = useState<{ kind: 'blob'; agent: Agent; x: number; y: number } | { kind: 'project'; project: Project; x: number; y: number } | { kind: 'move'; agent: Agent; x: number; y: number } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const drag = useRef<{ id: string; pointerId: number; fromX: number; fromY: number; moved: boolean } | null>(null)
  const dropHintRef = useRef<DropHint | null>(null)
  dropHintRef.current = dropHint
  const suppressClick = useRef(false)
  const [runtimeTooltipAgentId, setRuntimeTooltipAgentId] = useState<string | null>(null)
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
      { label: `Rename ${noun}`, icon: <Pencil size={15} />, onSelect: () => actions.onRename(agent) },
      { label: agent.leader ? 'Remove as leader' : 'Make team leader', icon: <Star size={15} />, onSelect: () => actions.onToggleLeader(agent) },
      { label: `Edit ${noun}`, icon: <Settings2 size={15} />, onSelect: () => actions.onEdit(agent) },
      { label: 'Duplicate', icon: <Duplicate size={15} />, onSelect: () => actions.onDuplicate(agent) },
      { label: `Export ${noun}…`, icon: <Download size={15} />, onSelect: () => actions.onExportBlob(agent) },
      { label: 'Copy conversation ID', icon: <Copy size={15} />, disabled: !session, onSelect: () => actions.onCopyConversationId(agent, session) },
      'separator',
      { label: 'Delete conversation…', icon: <Trash2 size={15} />, danger: true, disabled: !session || sessionIsBusy(session), onSelect: () => { if (session) actions.onDeleteConversation(agent, session) } },
      { label: agent.hidden ? 'Show in sidebar' : 'Hide from sidebar', icon: agent.hidden ? <Eye size={15} /> : <EyeOff size={15} />, onSelect: () => actions.onSetHidden(agent, !agent.hidden) },
      { label: 'Archive', icon: <Archive size={15} />, danger: true, onSelect: () => actions.onArchive(agent) },
    ]
  }
  const projectMenu = (project: Project): MenuItem[] => [
    { label: `New ${noun} here`, icon: <Plus size={15} />, onSelect: () => actions.onCreate(project.id) },
    { label: 'Rename project', icon: <Pencil size={15} />, onSelect: () => actions.onRenameProject(project) },
    { label: 'Change folder…', icon: <FolderOpen size={15} />, onSelect: () => actions.onChangeProjectFolder(project) },
    'separator',
    { label: 'Delete project', icon: <Trash2 size={15} />, danger: true, onSelect: () => actions.onDeleteProject(project) },
  ]
  /** The projects a blob can be moved to, for the keyboard "Move to project" menu. */
  const moveMenu = (agent: Agent): MenuItem[] => [
    ...projects.map((project) => ({ label: project.name, icon: <Folder size={15} />, checked: agent.projectId === project.id, onSelect: () => { actions.onMove(agent, project.id); setAnnouncement(`Moved ${agent.name} to ${project.name}.`) } })),
    { label: 'Unassigned', icon: <FolderOpen size={15} />, checked: !agent.projectId, onSelect: () => { actions.onMove(agent, null); setAnnouncement(`Moved ${agent.name} to Unassigned.`) } },
  ]
  /** What sits under the pointer during a drag: a row edge, a project area, or nothing. */
  const hintFromPoint = (x: number, y: number, selfId: string): DropHint | null => {
    const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) as HTMLElement | null : null
    const row = hit?.closest?.('.team-row[data-agent-id]') as HTMLElement | null
    const targetId = row?.dataset.agentId
    if (row && targetId && targetId !== selfId) {
      const rect = row.getBoundingClientRect()
      return { kind: 'row', agentId: targetId, edge: y < rect.top + rect.height / 2 ? 'before' : 'after' }
    }
    const group = hit?.closest?.('.team-group[data-project-id]') as HTMLElement | null
    if (group) return { kind: 'project', projectId: group.dataset.projectId === 'unassigned' ? null : group.dataset.projectId ?? null }
    return null
  }
  const finishDrag = (agent: Agent) => {
    const hint = dropHintRef.current
    setDragId(null)
    setDropHint(null)
    if (hint?.kind === 'row') {
      const target = agents.find((item) => item.id === hint.agentId)
      if (target) { actions.onPlace(agent, target, hint.edge); setAnnouncement(`${agent.name} moved next to ${target.name}.`) }
    } else if (hint?.kind === 'project') {
      actions.onMove(agent, hint.projectId)
      setAnnouncement(`Moved ${agent.name} to ${projects.find((item) => item.id === hint.projectId)?.name ?? 'Unassigned'}.`)
    }
  }

  const renderRow = (agent: Agent) => {
    const session = mainSessionFor(sessions, agent.id)
    const runtime = runtimes.find((item) => item.id === agent.runtimeId)
    const status = deriveCompanionStatus({ connected, runtime, session, now })
    const selected = agent.id === selectedAgentId
    const unread = !!session && unreadSessionIds.has(session.id)
    const approval = !!session && approvalSessionIds.has(session.id)
    const waiting = String(session?.state ?? '') === 'waiting_permission'
    const working = sessionIsBusy(session) && !waiting
    const preview = !connected ? 'Offline' : (status.mood === 'offline' || status.mood === 'error') ? status.label : waiting ? 'Waiting for you' : working ? status.label : conversationPreview(session) ?? (agent.description?.trim() || 'Say hi to get started')
    const runtimeIssue = runtimeProblem(runtime)
    return <button key={agent.id} type="button" role="treeitem" data-agent-id={agent.id} aria-current={selected ? 'true' : undefined} aria-selected={selected} aria-describedby={runtimeIssue ? `runtime-problem-${runtime!.id}-${agent.id}` : undefined}
      aria-label={`${agent.name}${agent.role ? `, ${agent.role}` : ''}${agent.leader ? ', team leader' : ''}${approval ? ', needs approval' : unread ? ', unread' : ''}`}
      tabIndex={selected || (!selectedAgentId && rowOrder[0]?.id === agent.id) ? 0 : -1}
      className={`bot-row team-row ${selected ? 'selected' : ''} ${agent.hidden ? 'hidden-blob' : ''} ${dragId === agent.id ? 'dragging' : ''} ${dropHint?.kind === 'row' && dropHint.agentId === agent.id ? `drop-${dropHint.edge}` : ''}`}
      onMouseEnter={() => { if (runtimeIssue) setRuntimeTooltipAgentId(agent.id) }}
      onMouseLeave={() => setRuntimeTooltipAgentId((current) => current === agent.id ? null : current)}
      onFocus={() => { if (runtimeIssue) setRuntimeTooltipAgentId(agent.id) }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRuntimeTooltipAgentId((current) => current === agent.id ? null : current) }}
      onClick={() => { if (suppressClick.current) { suppressClick.current = false; return } actions.onSelect(agent) }}
      onContextMenu={(event) => { event.preventDefault(); openBlobMenu(agent, event.clientX, event.clientY, event.currentTarget) }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        drag.current = { id: agent.id, pointerId: event.pointerId, fromX: event.clientX, fromY: event.clientY, moved: false }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* capture may be unavailable */ }
      }}
      onPointerMove={(event) => {
        const state = drag.current
        if (!state || state.id !== agent.id || state.pointerId !== event.pointerId) return
        if (!state.moved) {
          if (Math.abs(event.clientX - state.fromX) < 5 && Math.abs(event.clientY - state.fromY) < 5) return
          state.moved = true
          setDragId(agent.id)
        }
        setDropHint(hintFromPoint(event.clientX, event.clientY, agent.id))
      }}
      onPointerUp={(event) => {
        const state = drag.current
        drag.current = null
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
        if (!state || state.id !== agent.id) return
        if (!state.moved) { setDropHint(null); return }
        suppressClick.current = true
        finishDrag(agent)
      }}
      onPointerCancel={() => { drag.current = null; setDragId(null); setDropHint(null) }}
      onKeyDown={(event) => {
        if (event.altKey && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault()
          const direction: -1 | 1 = event.key === 'ArrowUp' ? -1 : 1
          actions.onReorder(agent, direction)
          setAnnouncement(`Moved ${agent.name} ${direction === -1 ? 'up' : 'down'}.`)
          return
        }
        if (event.altKey && event.shiftKey && event.key === 'ArrowRight') {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          menuTrigger.current = event.currentTarget
          setMenu({ kind: 'move', agent, x: rect.left + 24, y: rect.bottom + 4 })
          return
        }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.onSelect(agent); return }
        if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openBlobMenu(agent, rect.left + 24, rect.bottom, event.currentTarget); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const index = rowOrder.findIndex((item) => item.id === agent.id)
          const next = rowOrder[index + (event.key === 'ArrowDown' ? 1 : -1)]
          if (next) document.querySelector<HTMLButtonElement>(`.team-row[data-agent-id="${CSS.escape(next.id)}"]`)?.focus()
        }
      }}>
      <span className="team-row-avatar">
        <BlobCanvas color={agentColorHex(agent.color)} size={50} mood={status.mood} look={agentLook(agent)} label={agent.name} track={selected} />
        {agent.leader && <span className="leader-badge" title="Team leader" aria-hidden="true"><Star size={8} strokeWidth={0} fill="currentColor" /></span>}
      </span>
      <span className="bot-row-copy">
        <span className="bot-row-line">
          <span className="team-row-name">{runtimeLogos && <RuntimeMark provider={runtime?.provider} />}<strong>{agent.name}</strong><RuntimeProblemMarker runtime={runtime} inline idSuffix={agent.id} showTooltip={runtimeTooltipAgentId === agent.id} />{agent.role?.trim() && <span className="role-chip">{agent.role.trim()}</span>}</span>
          {(unread || approval) && <i className={`unread-dot ${approval ? 'approval' : ''}`} aria-hidden="true" />}
          {session?.updatedAt && <time>{shortTime(session.updatedAt)}</time>}
        </span>
        <span className="bot-row-line"><span className={`bot-row-preview ${waiting ? 'waiting' : working ? 'active' : ''}`}>{preview}</span></span>
      </span>
    </button>
  }

  return <div className="team-sidebar">
    <label className="sidebar-search"><span className="sr-only">Search {nouns}</span>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input value={query} placeholder="Search" aria-label={`Search ${nouns}`} onChange={(event) => onQueryChange(event.target.value)} />
    </label>
    <nav className="sidebar-scroll" aria-label={Nouns} data-tour="roster"><div role="tree" aria-label={`${Nouns} by project`}>
      {pinned.length > 0 && <section className="team-group" aria-label="Pinned">
        <div className="team-group-head static"><Pin size={13} aria-hidden="true" /><span>Pinned</span></div>
        <div className="team-group-rows">{pinned.map(renderRow)}</div>
      </section>}
      {groups.map(({ project, agents: members }) => {
        const key = project?.id ?? 'unassigned'
        const rows = members.filter((agent) => !pinnedIds.includes(agent.id))
        if (!project && rows.length === 0 && members.length === 0 && projects.length > 0 && !query) return null
        return <section key={key} data-project-id={project?.id ?? 'unassigned'} className={`team-group ${dropHint?.kind === 'project' && dropHint.projectId === (project?.id ?? null) ? 'drop-target' : ''}`} aria-label={project?.name ?? 'Unassigned'}>
          <div className="team-group-head">
            {project ? <button type="button" className="team-group-toggle" aria-expanded={!project.collapsed} onClick={() => actions.onToggleProjectCollapsed(project)}
              onContextMenu={(event) => { event.preventDefault(); menuTrigger.current = event.currentTarget; setMenu({ kind: 'project', project, x: event.clientX, y: event.clientY }) }}>
              {project.collapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
              <Folder size={13} aria-hidden="true" />
              <span title={project.path ?? undefined}>{project.name}</span>
            </button> : <span className="team-group-title"><FolderOpen size={13} aria-hidden="true" /><span>Unassigned</span></span>}
            <span className="team-group-actions">
              <button type="button" className="icon-button tiny" aria-label={`New ${noun} in ${project?.name ?? 'Unassigned'}`} title={`New ${noun}`} onClick={() => actions.onCreate(project?.id ?? null)}><Plus size={14} /></button>
              {project && <button type="button" className="icon-button tiny" aria-label={`${project.name} options`} title="Project options" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); menuTrigger.current = event.currentTarget; setMenu({ kind: 'project', project, x: rect.left, y: rect.bottom + 4 }) }}><MoreHorizontal size={14} /></button>}
            </span>
          </div>
          {!project?.collapsed && <div className="team-group-rows" role="group">
            {rows.map(renderRow)}
            {rows.length === 0 && <p className="team-group-empty">{project ? `Drag a ${noun} here, or create one.` : `${Nouns} without a project take general requests.`}</p>}
          </div>}
        </section>
      })}
      {agents.filter((agent) => !agent.archived).length === 0 && <p className="team-group-empty">No {nouns} yet. Create one to start chatting.</p>}
      </div>
      {hiddenCount > 0 && <button type="button" className="team-hidden-toggle" onClick={() => setShowHidden((value) => !value)}>{showHidden ? <EyeOff size={13} /> : <Eye size={13} />}{showHidden ? `Hide hidden ${nouns}` : `Show ${hiddenCount} hidden ${noun}${hiddenCount === 1 ? '' : 's'}`}</button>}
    </nav>
    {menu?.kind === 'blob' && <TeamMenu label={`${menu.agent.name} actions`} position={menu} items={blobMenu(menu.agent)} onClose={closeMenu} />}
    {menu?.kind === 'project' && <TeamMenu label={`${menu.project.name} actions`} position={menu} items={projectMenu(menu.project)} onClose={closeMenu} />}
    {menu?.kind === 'move' && <TeamMenu label={`Move ${menu.agent.name} to a project`} position={menu} items={moveMenu(menu.agent)} onClose={closeMenu} />}
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
  </div>
}
