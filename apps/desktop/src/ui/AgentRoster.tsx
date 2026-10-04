import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, MessageSquare, PinOff, Search } from 'lucide-react'
import type { Agent, Runtime, Session } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { effectiveApprovalMode } from '../approvalContract'
import { ApprovalBadge } from './approvalUi'
import { agentColorHex } from './agentColor'
import { deriveCompanionStatus } from './companionStatus'
import { AgentContextMenu } from './AgentContextMenu'
import { RowActionMenu, SessionTree } from './SessionTree'
import { isProjectPinned, type PinnedProject, type SidebarPins } from './sidebarPins'
import {
  OTHER_CAP_KEY, PROJECT_CAP, SESSION_CAP, activeAgents, layoutBlobTree, projectFolderName, runtimeUsable, sessionDisplayTitle,
  shortTime, treeItemId, treeModel, type ExpandedState, type TreeRow,
} from './rosterSelectors'

type Visible = {
  id: string
  kind: 'blob' | 'project' | 'other' | 'session' | 'more'
  label: string
  agentId: string
  parentId: string | null
  expanded: boolean
  agent?: Agent
  session?: Session
  projectKey: string | null
  projectPath?: string
  capKey?: string
}

type RosterMenu =
  | { kind: 'blob'; agentId: string; x: number; y: number }
  | { kind: 'project'; agentId: string; projectKey: string; path: string; label: string; x: number; y: number }
  | { kind: 'session'; agentId: string; session: Session; x: number; y: number }
  | { kind: 'pinned'; label: string; onUnpin: () => void; x: number; y: number }

export function AgentRoster({ agents, sessions, runtimes, connected, busy, now, pins, unreadSessionIds = new Set(), approvalSessionIds = new Set(), onToggleFavorite, onTogglePinProject, onTogglePinSession, onRevealProject, selectedAgentId, selectedSessionId, query, expanded, onQueryChange, onSelect, onCreate, onScan, onNewSession, onEdit, onDuplicate, onArchive, onExportBlob, onToggleBlob, onToggleProject, onToggleOther, onSelectSession, onRenameSession, onArchiveSession, onDeleteSession, onNewSessionInProject, onResumeSession, onCancelSession }: {
  agents: Agent[]
  sessions: Session[]
  runtimes: Runtime[]
  connected: boolean
  busy: boolean
  /** Current time, so row moods settle (happy, idle, asleep) without new events. */
  now?: number
  /** Favourite blobs and pinned projects or conversations (this device). */
  pins?: SidebarPins
  unreadSessionIds?: Set<string>
  approvalSessionIds?: Set<string>
  onToggleFavorite?: (agentId: string) => void
  onTogglePinProject?: (project: PinnedProject) => void
  onTogglePinSession?: (sessionId: string) => void
  onRevealProject?: (agentId: string, key: string) => void
  selectedAgentId: string | null
  selectedSessionId: string | null
  query: string
  expanded: ExpandedState
  onQueryChange: (query: string) => void
  onSelect: (agent: Agent) => void
  onCreate: () => void
  onScan: () => void
  onNewSession: (agent: Agent) => void
  onEdit: (agent: Agent) => void
  onDuplicate: (agent: Agent) => void
  onArchive: (agent: Agent) => void
  onExportBlob?: (agent: Agent) => void
  onToggleBlob: (agentId: string) => void
  onToggleProject: (agentId: string, key: string) => void
  onToggleOther: (agentId: string) => void
  onSelectSession: (session: Session) => void
  onRenameSession?: (session: Session, title: string) => void
  onArchiveSession?: (session: Session) => void
  onDeleteSession?: (session: Session) => void
  onNewSessionInProject: (agent: Agent, path: string) => void
  onResumeSession: (session: Session) => void
  onCancelSession: (session: Session) => void
}) {
  const model = useMemo(() => treeModel(agents, sessions, query), [agents, sessions, query])
  const favoriteIds = new Set(pins?.favorites ?? [])
  const grouped = model.groups.flatMap((group) => group.rows)
  // Favourite blobs come first; keyboard order follows what is drawn.
  const rows = [...grouped.filter((row) => favoriteIds.has(row.agent.id)), ...grouped.filter((row) => !favoriteIds.has(row.agent.id))]
  const hasFavorites = rows.some((row) => favoriteIds.has(row.agent.id))
  const active = activeAgents(agents)
  const treeItemRefs = useRef(new Map<string, HTMLElement>())
  const menuTriggerRef = useRef<HTMLElement | null>(null)
  const parentOf = useRef(new Map<string, string | null>())
  const typeaheadRef = useRef({ prefix: '', timer: 0 })
  const [focusId, setFocusId] = useState<string | null>(null)
  const [menu, setMenu] = useState<RosterMenu | null>(null)
  const [caps, setCaps] = useState<{ projects: Record<string, boolean>; sessions: Record<string, boolean> }>({ projects: {}, sessions: {} })
  const menuAgent = menu?.kind === 'blob' ? agents.find((agent) => agent.id === menu.agentId) ?? null : null
  const runtimeFor = (runtimeId: string) => runtimes.find((runtime) => runtime.id === runtimeId)
  const canCreateFor = (agent: Agent) => connected && !busy && runtimeUsable(runtimeFor(agent.runtimeId))

  useEffect(() => () => window.clearTimeout(typeaheadRef.current.timer), [])
  useEffect(() => {
    if (!selectedSessionId) return
    setCaps((current) => {
      let projects = current.projects
      let sessionCaps = current.sessions
      let changed = false
      for (const row of rows) {
        if (!projects[row.agent.id] && row.projects.slice(PROJECT_CAP).some((group) => group.sessions.some((session) => session.id === selectedSessionId))) {
          projects = { ...projects, [row.agent.id]: true }
          changed = true
        }
        for (const group of row.projects) {
          const id = `${row.agent.id}:${group.key ?? ''}`
          if (!sessionCaps[id] && group.sessions.slice(SESSION_CAP).some((session) => session.id === selectedSessionId)) {
            sessionCaps = { ...sessionCaps, [id]: true }
            changed = true
          }
        }
        const otherId = `${row.agent.id}:${OTHER_CAP_KEY}`
        if (row.other && !sessionCaps[otherId] && row.other.slice(SESSION_CAP).some((session) => session.id === selectedSessionId)) {
          sessionCaps = { ...sessionCaps, [otherId]: true }
          changed = true
        }
      }
      return changed ? { projects, sessions: sessionCaps } : current
    })
  }, [selectedSessionId, model])

  const prepared = rows.map((row) => prepareRow(row, expanded, caps, selectedSessionId))
  const visible: Visible[] = []
  for (const item of prepared) {
    const blobId = treeItemId('blob', item.row.agent.id)
    visible.push({ id: blobId, kind: 'blob', label: item.row.agent.name, agentId: item.row.agent.id, parentId: null, expanded: item.blobOpen, agent: item.row.agent, projectKey: null })
    if (!item.blobOpen || !item.laid) continue
    for (const child of item.laid.focus) {
      const expandedChild = child.kind === 'project' ? item.openProjects[child.projectKey ?? ''] === true : child.kind === 'other' ? item.otherOpen : false
      visible.push({ ...child, agentId: item.row.agent.id, expanded: expandedChild })
    }
  }
  for (const item of visible) parentOf.current.set(item.id, item.parentId)
  const tabId = visible.some((item) => item.id === focusId)
    ? focusId
    : visible.some((item) => item.id === treeItemId('blob', selectedAgentId ?? ''))
      ? treeItemId('blob', selectedAgentId ?? '')
      : visible[0]?.id ?? null
  const visibleKey = visible.map((item) => item.id).join('\0')
  const movedFocus = useRef(false)
  useEffect(() => {
    const ids = visibleKey ? visibleKey.split('\0') : []
    if (!focusId || ids.includes(focusId)) { movedFocus.current = false; return }
    if (movedFocus.current) return
    movedFocus.current = true
    let cursor = parentOf.current.get(focusId) ?? null
    for (let guard = 0; cursor && !ids.includes(cursor) && guard < 8; guard += 1) cursor = parentOf.current.get(cursor) ?? null
    const next = cursor && ids.includes(cursor) ? cursor : ids[0]
    if (next) {
      setFocusId(next)
      treeItemRefs.current.get(next)?.focus()
    } else document.querySelector<HTMLButtonElement>('[aria-label="Create blob"]')?.focus()
  }, [focusId, visibleKey])

  const bindRef = (id: string, node: HTMLElement | null) => {
    if (node) treeItemRefs.current.set(id, node)
    else treeItemRefs.current.delete(id)
  }
  const focusTreeItem = (id: string) => {
    setFocusId(id)
    treeItemRefs.current.get(id)?.focus()
  }
  const toggleItem = (item: Visible) => {
    if (item.kind === 'blob') onToggleBlob(item.agentId)
    else if (item.kind === 'project') onToggleProject(item.agentId, item.projectKey ?? '')
    else if (item.kind === 'other') onToggleOther(item.agentId)
  }
  const showMoreProjects = (agentId: string) => setCaps((current) => ({ ...current, projects: { ...current.projects, [agentId]: true } }))
  const showMoreSessions = (agentId: string, capKey: string) => setCaps((current) => ({ ...current, sessions: { ...current.sessions, [`${agentId}:${capKey}`]: true } }))
  const activate = (item: Visible) => {
    if (item.kind === 'blob' && item.agent) { setFocusId(item.id); onSelect(item.agent); return }
    if (item.kind === 'project' || item.kind === 'other') { toggleItem(item); return }
    if (item.kind === 'session' && item.session) { onSelectSession(item.session); return }
    if (item.kind === 'more') {
      if (item.capKey === 'projects') showMoreProjects(item.agentId)
      else if (item.capKey) showMoreSessions(item.agentId, item.capKey)
    }
  }
  const openRowMenu = (item: Visible, x: number, y: number) => {
    menuTriggerRef.current = treeItemRefs.current.get(item.id) ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setFocusId(item.id)
    if (item.kind === 'blob') setMenu({ kind: 'blob', agentId: item.agentId, x, y })
    else if (item.kind === 'project' && item.projectKey !== null && item.projectPath) setMenu({ kind: 'project', agentId: item.agentId, projectKey: item.projectKey, path: item.projectPath, label: item.label, x, y })
    else if (item.kind === 'session' && item.session) setMenu({ kind: 'session', agentId: item.agentId, session: item.session, x, y })
  }
  const closeMenu = () => {
    const current = menu
    const trigger = menuTriggerRef.current
    setMenu(null)
    const id = current?.kind === 'blob' ? treeItemId('blob', current.agentId)
      : current?.kind === 'project' ? treeItemId('project', current.agentId, current.projectKey)
        : current?.kind === 'session' ? treeItemId('session', current.agentId, current.session.id) : null
    window.setTimeout(() => {
      const target = id ? treeItemRefs.current.get(id) : null
      if (target?.isConnected) target.focus()
      else if (trigger?.isConnected) trigger.focus()
      else document.querySelector<HTMLElement>('.bot-row[aria-current="true"]')?.focus()
    }, 0)
  }
  const onNavKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.closest('input, textarea, select')) return
    const plus = target.closest<HTMLElement>('.tree-new')
    const currentId = plus?.getAttribute('data-tree-for') ?? target.closest<HTMLElement>('[data-tree-id]')?.getAttribute('data-tree-id')
    if (!currentId) return
    const index = visible.findIndex((item) => item.id === currentId)
    const current = index >= 0 ? visible[index] : undefined
    if (!current) return
    const key = event.key
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault()
      const next = key === 'ArrowDown' ? visible[(index + 1) % visible.length]
        : key === 'ArrowUp' ? visible[(index - 1 + visible.length) % visible.length]
          : key === 'Home' ? visible[0]
            : visible[visible.length - 1]
      if (next) focusTreeItem(next.id)
      return
    }
    if (plus && (key === 'Enter' || key === ' ')) return
    if (key === 'ArrowRight') {
      if (current.kind === 'session' || current.kind === 'more') return
      event.preventDefault()
      if (!current.expanded) toggleItem(current)
      else {
        const child = visible[index + 1]
        if (child && child.parentId === current.id) focusTreeItem(child.id)
      }
      return
    }
    if (key === 'ArrowLeft') {
      event.preventDefault()
      if (current.kind === 'session' || current.kind === 'more') {
        if (current.parentId) focusTreeItem(current.parentId)
        return
      }
      if (current.expanded) toggleItem(current)
      return
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault()
      activate(current)
      return
    }
    if (key === 'ContextMenu' || (event.shiftKey && key === 'F10')) {
      event.preventDefault()
      const rect = treeItemRefs.current.get(current.id)?.getBoundingClientRect()
      openRowMenu(current, rect ? rect.left + 28 : 24, rect ? rect.bottom : 24)
      return
    }
    if (key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault()
      const prefix = `${typeaheadRef.current.prefix}${key}`.toLocaleLowerCase('en')
      typeaheadRef.current.prefix = prefix
      window.clearTimeout(typeaheadRef.current.timer)
      typeaheadRef.current.timer = window.setTimeout(() => { typeaheadRef.current.prefix = '' }, 700)
      for (let offset = 1; offset <= visible.length; offset += 1) {
        const item = visible[(index + offset) % visible.length]
        if (item && item.label.toLocaleLowerCase('en').startsWith(prefix)) { focusTreeItem(item.id); return }
      }
    }
  }
  const projectMenuAgent = menu?.kind === 'project' ? agents.find((agent) => agent.id === menu.agentId) ?? null : null
  const resumeEnabled = (session: Session) => {
    const state = (session.state ?? '').toLowerCase()
    const blocked = state === 'working' || state === 'starting' || state === 'waiting_permission'
    return session.resumable === true && connected && !busy && runtimeUsable(runtimeFor(session.runtimeId)) && !blocked
  }
  const cancelEnabled = (session: Session) => {
    const state = (session.state ?? '').toLowerCase()
    return state === 'working' || state === 'waiting_permission'
  }

  const activeById = new Map(active.map((agent) => [agent.id, agent]))
  const pinnedItems = query.trim() ? [] : [
    ...(pins?.projects ?? []).flatMap((pin) => {
      const agent = activeById.get(pin.agentId)
      if (!agent) return []
      const group = grouped.find((row) => row.agent.id === agent.id)?.projects.find((item) => item.key === pin.key)
      const latest = group?.sessions[0]
      return [{ kind: 'project' as const, id: `project:${agent.id}:${pin.key}`, agent, pin, title: group?.label ?? projectFolderName(pin.path), time: latest?.updatedAt ?? null }]
    }),
    ...(pins?.sessions ?? []).flatMap((sessionId) => {
      const session = sessions.find((item) => item.id === sessionId)
      const agent = session?.agentId ? activeById.get(session.agentId) : undefined
      if (!session || !agent) return []
      return [{ kind: 'session' as const, id: `session:${session.id}`, agent, session, title: sessionDisplayTitle(session), time: session.updatedAt ?? null }]
    }),
  ]

  return <>
    <label className="sidebar-search"><Search size={14} /><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search" aria-label="Search agents and conversations" /></label>
    <div className="sidebar-scroll">
    {pinnedItems.length > 0 && <section className="pinned-section" aria-label="Pinned">
      <div className="roster-section-label">Pinned</div>
      {pinnedItems.map((item) => {
        const selected = item.kind === 'session' && item.session.id === selectedSessionId
        const open = () => {
          if (item.kind === 'session') { onSelectSession(item.session); return }
          onSelect(item.agent)
          onRevealProject?.(item.agent.id, item.pin.key)
        }
        const unpin = () => item.kind === 'session' ? onTogglePinSession?.(item.session.id) : onTogglePinProject?.(item.pin)
        return <div className={`pinned-row ${selected ? 'selected' : ''}`} key={item.id}>
          <button type="button" className="pinned-main" aria-current={selected ? 'true' : undefined} aria-label={`${item.title}, ${item.agent.name}${item.kind === 'project' ? ', project' : ''}${item.kind === 'session' && (unreadSessionIds.has(item.session.id) || approvalSessionIds.has(item.session.id)) ? approvalSessionIds.has(item.session.id) ? ', needs approval' : ', unread' : ''}`} onClick={open} onContextMenu={(event) => { event.preventDefault(); menuTriggerRef.current = event.currentTarget; setMenu({ kind: 'pinned', label: item.title, onUnpin: unpin, x: event.clientX, y: event.clientY }) }}>
            <span className="pinned-icon" style={{ color: agentColorHex(item.agent.color) }} aria-hidden="true">{item.kind === 'project' ? <Folder size={14} /> : <MessageSquare size={14} />}</span>
            <span className="pinned-copy"><strong>{item.title}</strong><small>{item.agent.name}{item.kind === 'project' ? ' · project' : ''}</small></span>
            {item.kind === 'session' && (unreadSessionIds.has(item.session.id) || approvalSessionIds.has(item.session.id)) && <i className={`unread-dot ${approvalSessionIds.has(item.session.id) ? 'approval' : ''}`} aria-hidden="true" />}
            {item.time && <time>{shortTime(item.time)}</time>}
          </button>
          <button type="button" className="pinned-unpin" aria-label={`Unpin ${item.title}`} title="Unpin" onClick={unpin}><PinOff size={13} /></button>
        </div>
      })}
    </section>}
    <nav className="bot-list runtime-list" aria-label="Blobs" role="tree" onKeyDown={onNavKeyDown} onFocus={(event) => {
      const id = (event.target as HTMLElement).closest?.('[data-tree-id]')?.getAttribute('data-tree-id')
      if (id) setFocusId((current) => current === id ? current : id)
    }} onContextMenu={(event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-tree-id]')
      if (!item || item.classList.contains('bot-row')) return
      event.preventDefault()
      const found = visible.find((entry) => entry.id === item.getAttribute('data-tree-id'))
      if (found) openRowMenu(found, event.clientX, event.clientY)
    }}>
      {rows.map((row, index) => <Fragment key={row.agent.id}>
        {hasFavorites && index === 0 && <div className="roster-section-label" role="presentation">Favourites</div>}
        {hasFavorites && index > 0 && favoriteIds.has(rows[index - 1].agent.id) && !favoriteIds.has(row.agent.id) && <div className="roster-section-label" role="presentation">Blobs</div>}
        {renderBlob(row)}
      </Fragment>)}
      {connected && runtimes.length === 0 && <div className="rail-empty">No coding CLIs detected yet.<button type="button" onClick={onScan}>Scan again</button></div>}
      {connected && runtimes.length > 0 && active.length === 0 && <div className="rail-empty">No blobs yet.<button type="button" onClick={onCreate}>Create blob</button></div>}
      {connected && active.length > 0 && rows.length === 0 && <div className="rail-empty">Nothing matches “{query}”.</div>}
      {!connected && active.length === 0 && <div className="rail-empty">Connect to your local runtime to see installed agents.</div>}
    </nav>
    </div>
    {menu?.kind === 'pinned' && <RowActionMenu label={`${menu.label} pinned`} position={menu} onClose={closeMenu} items={[{ label: 'Unpin', onSelect: () => { const unpin = menu.onUnpin; closeMenu(); unpin() } }]} />}
    {menu?.kind === 'blob' && menuAgent && <AgentContextMenu
      agent={menuAgent}
      position={menu}
      favorite={favoriteIds.has(menuAgent.id)}
      onToggleFavorite={onToggleFavorite ? () => { closeMenu(); onToggleFavorite(menuAgent.id) } : undefined}
      enabled={{ newSession: canCreateFor(menuAgent), duplicate: connected && !busy, archive: connected && !busy }}
      onClose={closeMenu}
      onNewSession={() => { closeMenu(); onNewSession(menuAgent) }}
      onEdit={() => { closeMenu(); onEdit(menuAgent) }}
      onDuplicate={() => { closeMenu(); onDuplicate(menuAgent) }}
      onArchive={() => { closeMenu(); onArchive(menuAgent) }}
      onExport={onExportBlob ? () => {
        const agentId = menuAgent.id
        setMenu(null)
        onExportBlob(menuAgent)
        window.requestAnimationFrame(() => focusTreeItem(treeItemId('blob', agentId)))
      } : undefined}
    />}
    {menu?.kind === 'project' && projectMenuAgent && <RowActionMenu
      label={`${menu.label} project`}
      position={menu}
      onClose={closeMenu}
      items={[
        { label: 'New session', disabled: !canCreateFor(projectMenuAgent), onSelect: () => { const path = menu.path; const agent = projectMenuAgent; closeMenu(); onNewSessionInProject(agent, path) } },
        ...(onTogglePinProject ? [{ label: isProjectPinned(pins ?? { v: 1, favorites: [], projects: [], sessions: [] }, menu.agentId, menu.projectKey) ? 'Unpin project' : 'Pin project', onSelect: () => { const project = { agentId: menu.agentId, key: menu.projectKey, path: menu.path }; closeMenu(); onTogglePinProject(project) } }] : []),
      ]}
    />}
    {menu?.kind === 'session' && <RowActionMenu
      label="Session"
      position={menu}
      onClose={closeMenu}
      items={[
        { label: 'Rename', disabled: !onRenameSession || sessionBusy(menu.session), onSelect: () => { const session = menu.session; closeMenu(); window.setTimeout(() => document.dispatchEvent(new CustomEvent('bloblex-session-rename', { detail: session.id })), 0) } },
        { label: 'Archive', disabled: !onArchiveSession || sessionBusy(menu.session), onSelect: () => { const session = menu.session; closeMenu(); onArchiveSession?.(session) } },
        { label: 'Delete…', disabled: !onDeleteSession || sessionBusy(menu.session), onSelect: () => { const session = menu.session; closeMenu(); onDeleteSession?.(session) } },
        { label: 'Resume conversation', disabled: !resumeEnabled(menu.session), onSelect: () => { const session = menu.session; closeMenu(); onResumeSession(session) } },
        { label: 'Cancel turn', disabled: !cancelEnabled(menu.session), onSelect: () => { const session = menu.session; closeMenu(); onCancelSession(session) } },
        ...(onTogglePinSession ? [{ label: (pins?.sessions ?? []).includes(menu.session.id) ? 'Unpin conversation' : 'Pin conversation', onSelect: () => { const id = menu.session.id; closeMenu(); onTogglePinSession(id) } }] : []),
      ]}
    />}
  </>

  function renderBlob(row: TreeRow) {
    const item = prepared.find((entry) => entry.row.agent.id === row.agent.id)
    if (!item) return null
    const { agent } = row
    const runtime = runtimeFor(agent.runtimeId)
    const status = deriveCompanionStatus({ connected, runtime, session: row.latest, now })
    const selected = agent.id === selectedAgentId
    const blobId = treeItemId('blob', agent.id)
    const index = rows.findIndex((entry) => entry.agent.id === agent.id)
    const mode = effectiveApprovalMode(agent)
    return <Fragment key={agent.id}>
      <div className={`blob-block ${selected ? 'selected' : ''} ${item.blobOpen ? 'open' : ''}`}>
        <button
          type="button"
          role="treeitem"
          data-agent-id={agent.id}
          data-tree-id={blobId}
          className={`bot-row ${selected ? 'selected' : ''}`}
          aria-label={`${agent.name}${sessions.some((session) => session.agentId === agent.id && (unreadSessionIds.has(session.id) || approvalSessionIds.has(session.id))) ? sessions.some((session) => session.agentId === agent.id && approvalSessionIds.has(session.id)) ? ', needs approval' : ', unread' : ''}`}
          aria-current={selected ? 'true' : undefined}
          aria-level={1}
          aria-expanded={item.blobOpen}
          aria-selected="false"
          aria-setsize={rows.length}
          aria-posinset={index + 1}
          aria-owns={item.blobOpen ? `blob-group-${agent.id}` : undefined}
          tabIndex={blobId === tabId ? 0 : -1}
          ref={(node) => bindRef(blobId, node)}
          onClick={() => { setFocusId(blobId); onSelect(agent) }}
          onContextMenu={(event) => {
            event.preventDefault()
            const blob = visible.find((entry) => entry.id === blobId)
            if (blob) openRowMenu(blob, event.clientX, event.clientY)
          }}
        >
          <BlobCanvas color={agentColorHex(agent.color)} size={36} mood={status.mood} label={agent.name} />
          <span className="bot-row-copy">
            <span className="bot-row-line">
              <strong>{agent.name}</strong>
              {mode === 'bypass' && <ApprovalBadge mode={mode} />}
              {sessions.some((session) => session.agentId === agent.id && (unreadSessionIds.has(session.id) || approvalSessionIds.has(session.id))) && <i className={`unread-dot ${sessions.some((session) => session.agentId === agent.id && approvalSessionIds.has(session.id)) ? 'approval' : ''}`} aria-hidden="true" />}
              {row.latest?.updatedAt && <time>{shortTime(row.latest.updatedAt)}</time>}
            </span>
            <span className="bot-row-line">
              <span className={`bot-row-preview ${rowIsActive(row.latest?.state) ? 'active' : ''}`}>{rowSubtitle(row, connected, status.label, status.mood === 'offline')}</span>
              <span className="tree-chevron" aria-hidden="true" onClick={(event) => { event.stopPropagation(); onToggleBlob(agent.id) }}>{item.blobOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
            </span>
          </span>
        </button>
        {item.blobOpen && item.laid && <div id={`blob-group-${agent.id}`} role="group" className="tree-group blob-children">
          <SessionTree
            agentId={agent.id}
            layout={item.laid.layout}
            canCreate={canCreateFor(agent)}
            selectedSessionId={selectedSessionId}
            unreadSessionIds={unreadSessionIds}
            approvalSessionIds={approvalSessionIds}
            activeTreeId={tabId}
            bindRef={bindRef}
            onToggleProject={(key) => onToggleProject(agent.id, key)}
            onToggleOther={() => onToggleOther(agent.id)}
            onSelectSession={onSelectSession}
            onRenameSession={onRenameSession}
            onNewSessionInProject={(path) => onNewSessionInProject(agent, path)}
            onShowMoreProjects={() => showMoreProjects(agent.id)}
            onShowMoreSessions={(key) => showMoreSessions(agent.id, key)}
          />
        </div>}
      </div>
    </Fragment>
  }
}

/** One short line under the blob name: what it is doing now, else its latest conversation. */
function rowSubtitle(row: TreeRow, connected: boolean, statusLabel: string, offline: boolean) {
  if (!connected) return 'Offline'
  if (offline) return statusLabel
  if (row.matchedTitle) return `Conversation: ${row.matchedTitle}`
  const state = (row.latest?.state ?? '').toLowerCase()
  if (state === 'waiting_permission') return 'Waiting for your approval'
  if (rowIsActive(state)) return statusLabel
  if (state === 'error' || state === 'failed') return 'Needs attention'
  return row.latest ? sessionDisplayTitle(row.latest) : 'No conversations yet'
}

function rowIsActive(state?: string) {
  return ['working', 'starting', 'cancelling', 'waiting_permission'].includes((state ?? '').toLowerCase())
}

function sessionBusy(session: Session) {
  return ['starting', 'working', 'cancelling', 'waiting_permission'].includes((session.state ?? '').toLowerCase())
}

function prepareRow(row: TreeRow, expanded: ExpandedState, caps: { projects: Record<string, boolean>; sessions: Record<string, boolean> }, selectedSessionId: string | null) {
  const stored = expanded.blobs[row.agent.id]
  const openProjects = { ...(stored?.projects ?? {}) }
  for (const [key, bit] of Object.entries(row.forceOpen.projects)) if (bit) openProjects[key] = true
  const blobOpen = stored?.open === true || row.forceOpen.blob
  const otherOpen = stored?.other === true || row.forceOpen.other
  const titleMatch = row.forceOpen.blob
  const pastProject = !!selectedSessionId && row.projects.slice(PROJECT_CAP).some((group) => group.sessions.some((session) => session.id === selectedSessionId))
  const projectLimit = titleMatch || caps.projects[row.agent.id] || pastProject ? Number.POSITIVE_INFINITY : PROJECT_CAP
  const uncappedSessionKeys = Object.entries(caps.sessions)
    .filter(([id, bit]) => bit && id.startsWith(`${row.agent.id}:`))
    .map(([id]) => id.slice(row.agent.id.length + 1))
  if (selectedSessionId) {
    for (const group of row.projects) {
      const key = group.key ?? ''
      if (group.sessions.slice(SESSION_CAP).some((session) => session.id === selectedSessionId) && !uncappedSessionKeys.includes(key)) uncappedSessionKeys.push(key)
    }
    if (row.other?.slice(SESSION_CAP).some((session) => session.id === selectedSessionId) && !uncappedSessionKeys.includes(OTHER_CAP_KEY)) uncappedSessionKeys.push(OTHER_CAP_KEY)
  }
  const laid = blobOpen ? layoutBlobTree({
    agentId: row.agent.id,
    projects: row.projects,
    other: row.other,
    openProjects,
    otherOpen,
    projectLimit,
    sessionLimit: titleMatch ? Number.POSITIVE_INFINITY : SESSION_CAP,
    uncappedSessionKeys,
  }) : null
  return { row, blobOpen, openProjects, otherOpen, laid }
}
