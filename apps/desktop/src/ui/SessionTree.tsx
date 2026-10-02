import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronRight, Folder, Plus } from 'lucide-react'
import type { Session } from '../types'
import { labelize } from '../types'
import { sessionDisplayTitle, sessionDotClass, shortTime, type BlobLayout } from './rosterSelectors'

export function SessionTree({ agentId, layout, canCreate, selectedSessionId, activeTreeId, bindRef, onToggleProject, onToggleOther, onSelectSession, onNewSessionInProject, onShowMoreProjects, onShowMoreSessions }: {
  agentId: string
  layout: BlobLayout
  canCreate: boolean
  selectedSessionId: string | null
  activeTreeId: string | null
  bindRef: (id: string, node: HTMLElement | null) => void
  onToggleProject: (key: string) => void
  onToggleOther: () => void
  onSelectSession: (session: Session) => void
  onNewSessionInProject: (path: string) => void
  onShowMoreProjects: () => void
  onShowMoreSessions: (key: string) => void
}) {
  if (layout.empty) return <p className="tree-empty">No conversations yet.</p>
  return <>
    {layout.projects.map((project) => {
      const key = project.group.key ?? ''
      const groupId = `project-group-${agentId}-${project.pos}`
      return <div className="tree-project" key={project.id}>
        <div
          role="treeitem"
          className="tree-project-item"
          aria-level={2}
          aria-expanded={project.open}
          aria-selected="false"
          aria-setsize={layout.level2Size}
          aria-posinset={project.pos}
          aria-label={`${project.group.label}, project`}
          aria-owns={project.open ? groupId : undefined}
          data-project-key={key}
          data-tree-kind="project"
          data-tree-id={project.id}
          title={project.group.path}
          tabIndex={activeTreeId === project.id ? 0 : -1}
          ref={(node) => bindRef(project.id, node)}
          onClick={() => onToggleProject(key)}
        >
          <Folder size={14} className="tree-icon" aria-hidden="true" />
          <span className="tree-label">{project.group.label}</span>
          <span className="tree-chevron" aria-hidden="true" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); onToggleProject(key) }}>{project.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        </div>
        {project.group.key !== null && <button type="button" className="tree-new" tabIndex={-1} data-tree-for={project.id} aria-label={`New session in ${project.group.label}`} disabled={!canCreate} onClick={(event) => { event.stopPropagation(); onNewSessionInProject(project.group.path) }}><Plus size={14} aria-hidden="true" /></button>}
        {project.open && <div id={groupId} role="group" className="tree-group">
          {project.sessions.map((item) => <SessionRow key={item.id} id={item.id} session={item.session} pos={item.pos} setSize={project.sessionSetSize} selected={item.session.id === selectedSessionId} activeTreeId={activeTreeId} bindRef={bindRef} onSelect={() => onSelectSession(item.session)} />)}
          {project.more && <MoreRow id={project.more.id} label={project.more.label} level={3} pos={project.more.pos} setSize={project.sessionSetSize} activeTreeId={activeTreeId} bindRef={bindRef} onActivate={() => onShowMoreSessions(project.more?.capKey ?? key)} />}
        </div>}
      </div>
    })}
    {layout.moreProjects && <MoreRow id={layout.moreProjects.id} label={layout.moreProjects.label} level={2} pos={layout.moreProjects.pos} setSize={layout.level2Size} activeTreeId={activeTreeId} bindRef={bindRef} onActivate={onShowMoreProjects} />}
    {layout.other && <div className="tree-project" key={layout.other.id}>
      <div
        role="treeitem"
        className="tree-project-item"
        aria-level={2}
        aria-expanded={layout.other.open}
        aria-selected="false"
        aria-setsize={layout.level2Size}
        aria-posinset={layout.other.pos}
        aria-label="Other sessions"
        aria-owns={layout.other.open ? `other-group-${agentId}` : undefined}
        data-tree-kind="other"
        data-tree-id={layout.other.id}
        tabIndex={activeTreeId === layout.other.id ? 0 : -1}
        ref={(node) => bindRef(layout.other?.id ?? '', node)}
        onClick={onToggleOther}
      >
        <Folder size={14} className="tree-icon" aria-hidden="true" />
        <span className="tree-label">Other sessions</span>
        <span className="tree-chevron" aria-hidden="true" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); onToggleOther() }}>{layout.other.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
      </div>
      {layout.other.open && <div id={`other-group-${agentId}`} role="group" className="tree-group">
        {layout.other.sessions.map((item) => <SessionRow key={item.id} id={item.id} session={item.session} pos={item.pos} setSize={layout.other?.sessionSetSize ?? 0} selected={item.session.id === selectedSessionId} activeTreeId={activeTreeId} bindRef={bindRef} onSelect={() => onSelectSession(item.session)} />)}
        {layout.other.more && <MoreRow id={layout.other.more.id} label={layout.other.more.label} level={3} pos={layout.other.more.pos} setSize={layout.other.sessionSetSize} activeTreeId={activeTreeId} bindRef={bindRef} onActivate={() => onShowMoreSessions(layout.other?.more?.capKey ?? '')} />}
      </div>}
    </div>}
  </>
}

function SessionRow({ id, session, pos, setSize, selected, activeTreeId, bindRef, onSelect }: {
  id: string
  session: Session
  pos: number
  setSize: number
  selected: boolean
  activeTreeId: string | null
  bindRef: (id: string, node: HTMLElement | null) => void
  onSelect: () => void
}) {
  const title = sessionDisplayTitle(session)
  const word = labelize(session.state, 'Idle')
  const clock = session.updatedAt ? shortTime(session.updatedAt) : ''
  // Completed and idle conversations stay quiet; only live or failed ones get a dot.
  const dot = sessionDotClass(session.state)
  const activity = dot === 'good' ? 'muted' : dot
  return <div
    role="treeitem"
    className="tree-session"
    aria-level={3}
    aria-selected={selected}
    aria-setsize={setSize}
    aria-posinset={pos}
    aria-label={`${title}, ${word}, ${clock || 'time unavailable'}`}
    data-session-id={session.id}
    data-tree-kind="session"
    data-tree-id={id}
    tabIndex={activeTreeId === id ? 0 : -1}
    ref={(node) => bindRef(id, node)}
    onClick={onSelect}
  >
    <span className="tree-label" title={title}>{title}</span>
    {activity !== 'muted' && <i className={`status-dot ${activity}`} aria-hidden="true" />}
    {clock && <time>{clock}</time>}
  </div>
}

function MoreRow({ id, label, level, pos, setSize, activeTreeId, bindRef, onActivate }: {
  id: string
  label: string
  level: 2 | 3
  pos: number
  setSize: number
  activeTreeId: string | null
  bindRef: (id: string, node: HTMLElement | null) => void
  onActivate: () => void
}) {
  return <div
    role="treeitem"
    className="tree-more"
    aria-level={level}
    aria-selected="false"
    aria-setsize={setSize}
    aria-posinset={pos}
    aria-label={label}
    data-tree-kind="more"
    data-tree-id={id}
    tabIndex={activeTreeId === id ? 0 : -1}
    ref={(node) => bindRef(id, node)}
    onClick={onActivate}
  >{label}</div>
}

export function RowActionMenu({ label, position, items, onClose }: {
  label: string
  position: { x: number; y: number }
  items: Array<{ label: string; disabled?: boolean; onSelect: () => void }>
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [])
  useEffect(() => {
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === 'Escape') onClose()
      if (event instanceof MouseEvent && ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close) }
  }, [onClose])
  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    let target = -1
    if (event.key === 'ArrowDown') target = (index + 1) % buttons.length
    else if (event.key === 'ArrowUp') target = (index - 1 + buttons.length) % buttons.length
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = buttons.length - 1
    if (target >= 0 && buttons.length) { event.preventDefault(); event.stopPropagation(); buttons[target]?.focus() }
  }
  return <div ref={ref} className="runtime-context-menu" role="menu" aria-label={label} onKeyDown={moveFocus} style={{ left: Math.max(8, Math.min(position.x, window.innerWidth - 210)), top: Math.max(8, Math.min(position.y, window.innerHeight - 190)) }}>
    {items.map((item) => <button type="button" role="menuitem" key={item.label} disabled={item.disabled} onClick={item.onSelect}>{item.label}</button>)}
  </div>
}
