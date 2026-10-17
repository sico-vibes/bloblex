// The per-bot conversations column: every conversation the user had with the
// selected bot in its project, newest first, with bot-to-bot conversations
// branching under the conversation that started them.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Archive, ArrowLeftRight, ChevronRight, PanelLeftClose, Pencil, SquarePen, Trash2 } from 'lucide-react'
import type { Agent, Session } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { ancestorIds, conversationTree, isEmptyConversation, sessionIsBusy, sideTitle, type ConversationNode } from './teamSelectors'
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

function isToday(value: unknown, now: number) {
  const time = Date.parse(String(value ?? ''))
  if (!Number.isFinite(time)) return false
  const a = new Date(time), b = new Date(now)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function ConversationsPanel({ agent, agents, sessions, selectedSessionId, sideSessionId, canCreate, onSelect, onOpenSide, onNew, onRename, onArchive, onDelete, onClose }: {
  agent: Agent
  agents: readonly Agent[]
  sessions: readonly Session[]
  selectedSessionId: string | null
  sideSessionId: string | null
  canCreate: boolean
  onSelect: (session: Session) => void
  onOpenSide: (sessionId: string) => void
  onNew: () => void
  onRename: (session: Session, title: string) => Promise<unknown> | void
  /** Hides the conversation from this list; it can be restored on the bot's page. */
  onArchive?: (session: Session) => void
  onDelete: (session: Session) => void
  onClose: () => void
}) {
  // Conversations nothing was said in are not listed, except the open one.
  const tree = useMemo(() => conversationTree(sessions.filter((session) => session.id === selectedSessionId || !isEmptyConversation(session)), agent.id, agent.projectId ?? null), [sessions, agent.id, agent.projectId, selectedSessionId])
  const activeId = sideSessionId ?? selectedSessionId
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
  const today = tree.filter((node) => isToday(node.session.updatedAt ?? node.session.createdAt, now))
  const earlier = tree.filter((node) => !isToday(node.session.updatedAt ?? node.session.createdAt, now))

  const renderNode = (node: ConversationNode, depth: number) => {
    const { session } = node
    const open = expanded.has(session.id)
    const busy = sessionIsBusy(session)
    const active = session.id === activeId
    const peer = node.kind === 'side' ? agents.find((item) => item.id === (node.role === 'sender' ? session.agentId : session.link?.peerAgentId)) : undefined
    const peerName = peer?.name ?? (node.role === 'receiver' ? session.link?.peerName : undefined) ?? 'Teammate'
    const title = node.kind === 'side' ? sideTitle(session, agents as Agent[]) : (session.title?.trim() || 'New chat')
    const open_ = () => node.kind === 'side' ? onOpenSide(session.id) : onSelect(session)
    return <li key={session.id} className="convo-item" role="treeitem" aria-level={depth + 1} aria-selected={active} aria-expanded={node.children.length ? open : undefined}>
      <div className={`convo-row ${active ? 'active' : ''} ${node.kind}`} style={{ ['--depth' as string]: depth }}>
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
            {busy ? <i className="convo-dot" aria-label="Working" /> : <time className="convo-time">{relativeTime(session.updatedAt ?? session.createdAt, now)}</time>}
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
    <div className="convo-head">
      <strong>Conversations</strong>
      <span className="convo-head-actions">
        <button type="button" className="icon-button small" aria-label="New conversation" title="New conversation" disabled={!canCreate} onClick={onNew}><SquarePen size={14} /></button>
        <button type="button" className="icon-button small" aria-label="Hide conversations" title="Hide conversations" onClick={onClose}><PanelLeftClose size={14} /></button>
      </span>
    </div>
    <div className="convo-scroll">
      {tree.length === 0 && <p className="convo-empty">No conversations with {agent.name} yet.</p>}
      {today.length > 0 && <section aria-label="Today"><h3 className="convo-group">Today</h3><ul role="tree" className="convo-list">{today.map((node) => renderNode(node, 0))}</ul></section>}
      {earlier.length > 0 && <section aria-label="Earlier"><h3 className="convo-group">Earlier</h3><ul role="tree" className="convo-list">{earlier.map((node) => renderNode(node, 0))}</ul></section>}
    </div>
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
