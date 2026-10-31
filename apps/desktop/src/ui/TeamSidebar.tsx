// Bot-first sidebar (Phase 1A, owner decision 29 October 2026): one list of
// bots, the Manager pinned on top. Bots work in every project; a bot's
// conversations are grouped by project in its conversations panel.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, ArrowDownUp, Check, ChevronRight, Copy, Eye, EyeOff, Folder, FolderInput, FolderOpen, FolderPlus, Lock, LockOpen, MailOpen, Mail, Pencil, Pin, PinOff, Plus, Settings2, Tag, Trash2, X, Copy as Duplicate, Download, Star } from 'lucide-react'
import type { Agent, Project, Runtime, Session } from '../types'
import { rpc } from '../tauri'
import { agentLook } from '../blob/look'
import { RuntimeMark } from './providerBrand'
import { BlobCanvas } from '../blob/BlobCanvas'
import { useThemeStyle } from '../blob/bitbots'
import { HazeAura, auraStatusFor } from '../blob/haze/HazeAura'
import { agentColorHex } from './agentColor'
import { deriveCompanionStatus } from './companionStatus'
import { RuntimeProblemMarker, runtimeProblem } from './RuntimeProblemMarker'
import { shortTime } from './rosterSelectors'
import { conversationPreview, isManager, mainSessionFor, managerOf, rosterAgents, sessionIsBusy, sessionIsLimited, sidebarSubtitle } from './teamSelectors'
import { friendlyErrorText } from './errorCopy'
import { readCachedCatalogModels, useCatalogVersion } from './catalogCache'
import { useEntityNoun } from './vocabulary'
import { SIDEBAR_SORTS, groupBotsByProject, sortBots, storeSidebarGrouping, storeSidebarSort, storedSidebarGrouping, storedSidebarSort } from './sidebarOrder'

export type MenuItem = { label: string; icon?: ReactNode; onSelect?: () => void; disabled?: boolean; danger?: boolean; checked?: boolean; submenu?: MenuItem[] } | 'separator'

/** Where a pointer drag would land: on a row edge. */
export type DropHint = { kind: 'row'; agentId: string; edge: 'before' | 'after' }

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

/** FIX39 item 21: what a tag editor is opened for. */
export type TagTarget = { kind: 'project' | 'bot'; id: string; name: string; tags: string[] }

/**
 * The small tag editor behind a project's or a bot's right-click menu. Tags are
 * the routing vocabulary the Manager matches a job to; the owner edits them here
 * (`project.update` / `agent.team.update`), and the Manager sets them through its
 * own tools. Self-contained: it saves with `rpc` and lets the usual
 * `project.changed`/`agent.changed` events update the sidebar.
 */
export function TagEditor({ target, onClose }: { target: TagTarget; onClose: () => void }) {
  const [tags, setTags] = useState<string[]>(target.tags)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const add = () => {
    const tag = draft.trim().toLocaleLowerCase()
    if (!tag) return
    if (tag.length > 24) { setError('A tag can be at most 24 characters.'); return }
    if (!tags.includes(tag) && tags.length >= 8) { setError('At most 8 tags.'); return }
    if (!tags.includes(tag)) setTags([...tags, tag])
    setDraft('')
    setError(null)
  }
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      if (target.kind === 'project') await rpc('project.update', { projectId: target.id, tags })
      else await rpc('agent.team.update', { agentId: target.id, tags })
      onClose()
    } catch (reason) {
      setError(friendlyErrorText(typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : null))
    } finally {
      setBusy(false)
    }
  }
  return <div className="tag-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="tag-editor" role="dialog" aria-modal="true" aria-label={`Tags for ${target.name}`}>
      <header className="tag-editor-head"><strong>Tags for {target.name}</strong><button type="button" className="icon-button tiny" aria-label="Close" onClick={onClose}><X size={15} /></button></header>
      <p className="tag-editor-hint">Tags help the Manager pick the right bot and project for a job. Up to 8, one or two words each.</p>
      <div className="tag-chips">
        {tags.map((tag) => <span key={tag} className="tag-chip">{tag}<button type="button" aria-label={`Remove ${tag}`} onClick={() => setTags((current) => current.filter((item) => item !== tag))}><X size={11} /></button></span>)}
        {tags.length === 0 && <span className="tag-empty">No tags yet.</span>}
      </div>
      <div className="tag-editor-add">
        <input ref={inputRef} value={draft} maxLength={24} aria-label="New tag" placeholder="Add a tag" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }} />
        <button type="button" className="secondary-button small" onClick={add}>Add</button>
      </div>
      {error && <p className="tag-editor-error" role="alert">{error}</p>}
      <footer className="tag-editor-actions">
        <button type="button" className="ghost-button small" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button small" disabled={busy} onClick={() => void save()}>Save tags</button>
      </footer>
    </section>
  </div>
}

export type TeamSidebarActions = {
  onSelect: (agent: Agent) => void
  onCreate: (projectId: string | null) => void
  onCreateProject: () => void
  onEdit: (agent: Agent) => void
  onArchive: (agent: Agent) => void
  onDeleteBot?: (agent: Agent) => void
  onDuplicate: (agent: Agent) => void
  onExportBlob: (agent: Agent) => void
  onRename: (agent: Agent) => void
  onTogglePin: (agentId: string) => void
  onMove: (agent: Agent, projectId: string | null) => void
  /** Keyboard move one step inside the blob's own project. */
  onReorder: (agent: Agent, direction: -1 | 1) => void
  /** Pointer drop: place the blob before or after another blob (same or another project). */
  onPlace: (agent: Agent, target: Agent, edge: 'before' | 'after') => void
  onSetHidden: (agent: Agent, hidden: boolean) => void
  /** FIX39 item 13: lock or unlock the bot's settings. */
  onToggleLock: (agent: Agent) => void
  onToggleUnread: (agent: Agent, session: Session | null, unread: boolean) => void
  onCopyConversationId: (agent: Agent, session: Session | null) => void
  onDeleteConversation: (agent: Agent, session: Session) => void
  onRenameProject: (project: Project) => void
  onChangeProjectFolder: (project: Project) => void
  onDeleteProject: (project: Project) => void
  onToggleProjectCollapsed: (project: Project) => void
  onOpenRuntimeSettings: () => void
}

export function TeamSidebar({ agents, projects, sessions, runtimes, runtimeLogos = false, sidebarModel = false, botLock = false, connected, now, pinnedIds, unreadSessionIds, approvalSessionIds, selectedAgentId, onOpenSearch, actions, banner, needsYou, machines }: {
  /** Phase 4: other machines' bots, under their names. */
  machines?: ReactNode
  /** Waiting approvals and questions across every bot (see NeedsYou). */
  needsYou?: ReactNode
  /** A card shown between the search box and the bots (Manager setup). */
  banner?: ReactNode
  agents: Agent[]
  projects: Project[]
  sessions: Session[]
  runtimes: Runtime[]
  /** Experimental: show each blob's runtime logo before its name. */
  runtimeLogos?: boolean
  /** Experimental: show the bot's model and effort instead of the preview when idle. */
  sidebarModel?: boolean
  /** Experimental: offer Lock bot in the context menu (Unlock is always offered). */
  botLock?: boolean
  connected: boolean
  now: number
  pinnedIds: string[]
  unreadSessionIds: ReadonlySet<string>
  approvalSessionIds: ReadonlySet<string>
  selectedAgentId: string | null
  onOpenSearch: () => void
  actions: TeamSidebarActions
}) {
  const haze = useThemeStyle() === 'haze'
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const Nouns = useEntityNoun({ plural: true, capital: true })
  // FIX39 item 12 / P5 audit S7: subscribe to the shared catalog cache so a row
  // painted before the catalog arrived shows the model's display name once it
  // lands (the value below is still read synchronously).
  useCatalogVersion()
  const [showHidden, setShowHidden] = useState(false)
  const [menu, setMenu] = useState<{ kind: 'blob'; agent: Agent; x: number; y: number } | { kind: 'move'; agent: Agent; x: number; y: number } | null>(null)
  // FIX39 item 21: the tag editor is opened from a project's or a bot's menu.
  const [tagTarget, setTagTarget] = useState<TagTarget | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const drag = useRef<{ id: string; pointerId: number; fromX: number; fromY: number; moved: boolean } | null>(null)
  const dropHintRef = useRef<DropHint | null>(null)
  dropHintRef.current = dropHint
  const suppressClick = useRef(false)
  const [runtimeTooltipAgentId, setRuntimeTooltipAgentId] = useState<string | null>(null)
  const menuTrigger = useRef<HTMLElement | null>(null)
  const roster = useMemo(() => rosterAgents(agents, showHidden), [agents, showHidden])
  const manager = managerOf(agents)
  const pinned = pinnedIds.map((id) => agents.find((agent) => agent.id === id && !agent.archived && (showHidden || !agent.hidden))).filter((agent): agent is Agent => !!agent)
  const hiddenCount = agents.filter((agent) => !agent.archived && agent.hidden).length
  const [sort, setSort] = useState(storedSidebarSort)
  const [grouped, setGrouped] = useState(storedSidebarGrouping)
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null)
  const rows = sortBots(roster.filter((agent) => !pinnedIds.includes(agent.id)), sessions, sort)
  const groups = grouped ? groupBotsByProject(rows, projects) : null
  const rowOrder = [...pinned, ...(groups ? groups.flatMap((group) => group.agents) : rows)]
  const closeMenu = () => { setMenu(null); requestAnimationFrame(() => menuTrigger.current?.focus()) }

  const openBlobMenu = (agent: Agent, x: number, y: number, trigger: HTMLElement | null) => { menuTrigger.current = trigger; setMenu({ kind: 'blob', agent, x, y }) }
  const blobMenu = (agent: Agent): MenuItem[] => {
    const session = mainSessionFor(sessions, agent.id)
    const unread = !!session && unreadSessionIds.has(session.id)
    const isPinned = pinnedIds.includes(agent.id)
    // The Manager can never be locked, so its menu never shows a lock entry.
    const locked = agent.locked === true && !isManager(agent)
    // The Manager stays pinned at the top, works across every project and can't be removed.
    if (isManager(agent)) return [
      { label: unread ? 'Mark as read' : 'Mark as unread', icon: unread ? <MailOpen size={15} /> : <Mail size={15} />, disabled: !session, onSelect: () => actions.onToggleUnread(agent, session, !unread) },
      'separator',
      { label: 'Rename Manager', icon: <Pencil size={15} />, onSelect: () => actions.onRename(agent) },
      { label: 'Edit Manager', icon: <Settings2 size={15} />, onSelect: () => actions.onEdit(agent) },
      { label: 'Copy conversation ID', icon: <Copy size={15} />, disabled: !session, onSelect: () => actions.onCopyConversationId(agent, session) },
    ]
    return [
      { label: isPinned ? 'Unpin' : 'Pin', icon: isPinned ? <PinOff size={15} /> : <Pin size={15} />, onSelect: () => actions.onTogglePin(agent.id) },
      { label: 'Default project', icon: <FolderInput size={15} />, disabled: locked, submenu: [
        ...projects.map((project) => ({ label: project.name, icon: <Folder size={15} />, checked: agent.projectId === project.id, onSelect: () => actions.onMove(agent, project.id) })),
        { label: 'No project', icon: <FolderOpen size={15} />, checked: !agent.projectId, onSelect: () => actions.onMove(agent, null) },
        'separator',
        { label: 'New project…', icon: <FolderPlus size={15} />, onSelect: actions.onCreateProject },
      ] },
      { label: unread ? 'Mark as read' : 'Mark as unread', icon: unread ? <MailOpen size={15} /> : <Mail size={15} />, disabled: !session, onSelect: () => actions.onToggleUnread(agent, session, !unread) },
      'separator',
      { label: `Rename ${noun}`, icon: <Pencil size={15} />, disabled: locked, onSelect: () => actions.onRename(agent) },
      { label: `Edit ${noun}`, icon: <Settings2 size={15} />, disabled: locked, onSelect: () => actions.onEdit(agent) },
      { label: 'Duplicate', icon: <Duplicate size={15} />, onSelect: () => actions.onDuplicate(agent) },
      // FIX39 item 21: tags are a settings change, so a locked bot refuses them.
      { label: 'Tags…', icon: <Tag size={15} />, disabled: locked, onSelect: () => setTagTarget({ kind: 'bot', id: agent.id, name: agent.name, tags: [...(agent.tags ?? [])] }) },
      { label: `Export ${noun}…`, icon: <Download size={15} />, onSelect: () => actions.onExportBlob(agent) },
      { label: 'Copy conversation ID', icon: <Copy size={15} />, disabled: !session, onSelect: () => actions.onCopyConversationId(agent, session) },
      'separator',
      { label: 'Delete conversation…', icon: <Trash2 size={15} />, danger: true, disabled: !session || sessionIsBusy(session), onSelect: () => { if (session) actions.onDeleteConversation(agent, session) } },
      { label: agent.hidden ? 'Show in sidebar' : 'Hide from sidebar', icon: agent.hidden ? <Eye size={15} /> : <EyeOff size={15} />, onSelect: () => actions.onSetHidden(agent, !agent.hidden) },
      ...(locked || botLock ? [
        { label: locked ? `Unlock ${noun}` : `Lock ${noun}`, icon: locked ? <LockOpen size={15} /> : <Lock size={15} />, onSelect: () => actions.onToggleLock(agent) },
      ] as MenuItem[] : []),
      ...(actions.onDeleteBot ? [{ label: 'Delete bot…', icon: <Trash2 size={15} />, danger: true, disabled: locked || isManager(agent), onSelect: () => actions.onDeleteBot?.(agent) }] : []),
      { label: 'Archive', icon: <Archive size={15} />, danger: true, disabled: locked, onSelect: () => actions.onArchive(agent) },
    ]
  }
  /** The keyboard "Default project" menu: where this bot's new conversations start. */
  const moveMenu = (agent: Agent): MenuItem[] => [
    ...projects.map((project) => ({ label: project.name, icon: <Folder size={15} />, checked: agent.projectId === project.id, onSelect: () => { actions.onMove(agent, project.id); setAnnouncement(`${agent.name}'s new conversations start in ${project.name}.`) } })),
    { label: 'No project', icon: <FolderOpen size={15} />, checked: !agent.projectId, onSelect: () => { actions.onMove(agent, null); setAnnouncement(`${agent.name}'s new conversations start with no project.`) } },
  ]
  /** What sits under the pointer during a drag: a row edge, or nothing. */
  const hintFromPoint = (x: number, y: number, selfId: string): DropHint | null => {
    const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) as HTMLElement | null : null
    const row = hit?.closest?.('.team-row[data-agent-id]') as HTMLElement | null
    const targetId = row?.dataset.agentId
    if (row && targetId && targetId !== selfId) {
      const rect = row.getBoundingClientRect()
      return { kind: 'row', agentId: targetId, edge: y < rect.top + rect.height / 2 ? 'before' : 'after' }
    }
    return null
  }
  const finishDrag = (agent: Agent) => {
    const hint = dropHintRef.current
    setDragId(null)
    setDropHint(null)
    if (hint?.kind === 'row') {
      const target = agents.find((item) => item.id === hint.agentId)
      if (target) { actions.onPlace(agent, target, hint.edge); setAnnouncement(`${agent.name} moved next to ${target.name}.`) }
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
    const preview = !connected ? 'Offline' : (status.mood === 'offline' || status.mood === 'error' || sessionIsLimited(session) || session?.state === 'retrying') ? status.label : waiting ? 'Waiting for you' : working ? status.label : sidebarModel ? sidebarSubtitle(agent, runtime?.provider, readCachedCatalogModels(agent.runtimeId)) : conversationPreview(session) ?? (agent.description?.trim() || 'Say hi to get started')
    const runtimeIssue = runtimeProblem(runtime)
    const failed = connected && status.mood === 'error'
    return <button key={agent.id} type="button" role="treeitem" data-agent-id={agent.id} aria-current={selected ? 'true' : undefined} aria-selected={selected} aria-describedby={runtimeIssue ? `runtime-problem-${runtime!.id}-${agent.id}` : undefined}
      aria-label={`${agent.name}${agent.role ? `, ${agent.role}` : ''}${isManager(agent) ? ', Manager' : ''}${approval ? ', needs approval' : unread ? ', unread' : ''}`}
      tabIndex={selected || (!selectedAgentId && rowOrder[0]?.id === agent.id) ? 0 : -1}
      className={`bot-row team-row ${selected ? 'selected' : ''} ${agent.hidden ? 'hidden-blob' : ''} ${dragId === agent.id ? 'dragging' : ''} ${dropHint?.kind === 'row' && dropHint.agentId === agent.id ? `drop-${dropHint.edge}` : ''}`}
      onMouseEnter={() => { if (runtimeIssue) setRuntimeTooltipAgentId(agent.id) }}
      onMouseLeave={() => setRuntimeTooltipAgentId((current) => current === agent.id ? null : current)}
      onFocus={() => { if (runtimeIssue) setRuntimeTooltipAgentId(agent.id) }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRuntimeTooltipAgentId((current) => current === agent.id ? null : current) }}
      onClick={() => { if (suppressClick.current) { suppressClick.current = false; return } actions.onSelect(agent) }}
      onContextMenu={(event) => { event.preventDefault(); openBlobMenu(agent, event.clientX, event.clientY, event.currentTarget) }}
      onPointerDown={(event) => {
        // FIX39 item 13 / P5 audit F2: a locked bot is not draggable.
        if (event.button !== 0 || agent.locked === true) return
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
      <HazeAura status={waiting ? 'needs' : auraStatusFor(status.mood)} color={agentColorHex(agent.color)} selected={selected} manager={isManager(agent)} />
      <span className="team-row-avatar">
        <BlobCanvas color={agentColorHex(agent.color)} size={haze ? 20 : 50} mood={status.mood} look={agentLook(agent)} label={agent.name} track={selected} />
        {isManager(agent) && <span className="leader-badge" title="Manager" aria-hidden="true"><Star size={10} fill="currentColor" strokeWidth={0} /></span>}
        {agent.locked === true && <span className="lock-badge" title="Locked" aria-hidden="true"><Lock size={9} /></span>}
      </span>
      <span className="bot-row-copy">
        <span className="bot-row-line">
          <span className="team-row-name">{runtimeLogos && !haze && <RuntimeMark provider={runtime?.provider} />}<strong>{agent.name}</strong><RuntimeProblemMarker runtime={runtime} inline idSuffix={agent.id} showTooltip={runtimeTooltipAgentId === agent.id} />{agent.role?.trim() && <span className="role-chip">{agent.role.trim()}</span>}</span>
          {(unread || approval) && <i className={`unread-dot ${approval ? 'approval' : ''}`} aria-hidden="true" />}
          {haze && (waiting || failed) ? <span className={`haze-row-state ${waiting ? 'needs' : 'failed'}`}>{waiting ? 'Needs you' : 'Failed'}</span> : session?.updatedAt && <time>{shortTime(session.updatedAt)}</time>}
        </span>
        <span className="bot-row-line"><span className={`bot-row-preview ${waiting ? 'waiting' : working ? 'active' : ''}`}>{preview}</span></span>
      </span>
    </button>
  }

  return <div className="team-sidebar">
    <button type="button" className="sidebar-search" aria-label={`Search ${nouns}, conversations, projects, and actions`} aria-haspopup="dialog" aria-keyshortcuts="Control+k" onClick={onOpenSearch}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <span>Search</span><kbd aria-hidden="true">Ctrl K</kbd>
    </button>
    {banner}
    {needsYou}
    <nav className="sidebar-scroll" aria-label={Nouns} data-tour="roster"><div role="tree" aria-label={Nouns}>
      {manager && <section className="team-group manager-group" aria-label="Manager">
        <div className="team-group-rows">{renderRow(manager)}</div>
      </section>}
      {pinned.length > 0 && <section className="team-group" aria-label="Pinned">
        <div className="team-group-head static"><Pin size={13} aria-hidden="true" /><span>Pinned</span></div>
        <div className="team-group-rows">{pinned.map(renderRow)}</div>
      </section>}
      <section className="team-group" aria-label={Nouns}>
        <div className="team-group-head static">
          <span className="team-group-title"><span>{Nouns}</span></span>
          <span className="team-group-actions"><button type="button" className="icon-button tiny" aria-label={`Sort ${nouns}`} title={`Sort ${nouns}`} aria-haspopup="menu" onClick={(event) => { menuTrigger.current = event.currentTarget; const rect = event.currentTarget.getBoundingClientRect(); setSortMenu({ x: rect.left, y: rect.bottom + 4 }) }}><ArrowDownUp size={13} /></button><button type="button" className="icon-button tiny" aria-label={`New ${noun}`} title={`New ${noun}`} onClick={() => actions.onCreate(null)}><Plus size={14} /></button></span>
        </div>
        {groups
          ? groups.map((group) => <div key={group.id} role="group" aria-label={group.name}><div className="team-subgroup-head">{group.name}</div><div className="team-group-rows">{group.agents.map(renderRow)}</div></div>)
          : <div className="team-group-rows" role="group">{rows.map(renderRow)}</div>}
      </section>
      {agents.filter((agent) => !agent.archived).length === 0 && <p className="team-group-empty">No {nouns} yet. Create one to start chatting.</p>}
      </div>
      {machines}
      {hiddenCount > 0 && <button type="button" className="team-hidden-toggle" onClick={() => setShowHidden((value) => !value)}>{showHidden ? <EyeOff size={13} /> : <Eye size={13} />}{showHidden ? `Hide hidden ${nouns}` : `Show ${hiddenCount} hidden ${noun}${hiddenCount === 1 ? '' : 's'}`}</button>}
    </nav>
    {sortMenu && <TeamMenu label={`Sort ${nouns}`} position={sortMenu} onClose={() => { setSortMenu(null); requestAnimationFrame(() => menuTrigger.current?.focus()) }} items={[
      ...SIDEBAR_SORTS.map((item): MenuItem => ({ label: item.label, checked: sort === item.id, onSelect: () => { setSort(item.id); storeSidebarSort(item.id) } })),
      'separator',
      { label: 'Group by project', checked: grouped, onSelect: () => { setGrouped(!grouped); storeSidebarGrouping(!grouped) } },
    ]} />}
    {menu?.kind === 'blob' && <TeamMenu label={`${menu.agent.name} actions`} position={menu} items={blobMenu(menu.agent)} onClose={closeMenu} />}
    {menu?.kind === 'move' && <TeamMenu label={`${menu.agent.name}'s default project`} position={menu} items={moveMenu(menu.agent)} onClose={closeMenu} />}
    {tagTarget && <TagEditor target={tagTarget} onClose={() => { setTagTarget(null); requestAnimationFrame(() => menuTrigger.current?.focus()) }} />}
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
  </div>
}
