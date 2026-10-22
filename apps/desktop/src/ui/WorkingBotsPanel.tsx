import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Agent, Session } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { isSideSession, isWaitingDelegation, sessionIsBusy } from './teamSelectors'
import './workingBotsPanel.css'

/** Queued delivery notices are authoritative until a new message/turn arrives. */
export function taskStatus(session: Session): string {
  if (session.state === 'limited' || session.state === 'rate_limited') return 'Limited'
  if (session.state === 'waiting_permission') return 'Waiting for you'
  if (session.state === 'starting') return 'Starting'
  if (sessionIsBusy(session)) return 'Working'
  if (isWaitingDelegation(session.messages) || session.state === 'queued' || session.state === 'waiting') return 'Waiting'
  const last = session.turns?.at(-1)
  // A list row carries no turns or messages, so its outcome is not recorded yet.
  // Only the live states above are trustworthy from the row itself: everything
  // else waits for hydration instead of being shown as an active task.
  if (session.turns === undefined && session.messages === undefined) return 'Loading'
  if (session.state === 'cancelled' || last?.state === 'cancelled') return 'Cancelled'
  // Any finished turn that did not complete is a failure, whatever the provider called it.
  if (session.state === 'error' || (last && last.state !== 'completed' && last.state !== 'working')) return 'Failed'
  if (last?.state === 'completed' || session.state === 'completed' || session.messages?.some(m => m.role === 'assistant' && m.status !== 'streaming')) return 'Done'
  // A hydrated session with no recorded outcome is still in flight.
  return 'Waiting'
}

export function taskElapsed(session: Session, status: string, now: number): string {
  const start = Date.parse(String(session.createdAt ?? session.turns?.[0]?.createdAt ?? ''))
  const finished = ['Done', 'Failed', 'Cancelled'].includes(status)
  // Freeze on the turn's own completion time. A later rename or reaction must
  // not change how long a finished task took, so show a dash without it.
  const end = finished ? Date.parse(String(session.turns?.at(-1)?.completedAt ?? '')) : now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—'
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}

/** Global assigned tasks stay visible while the owner moves between bots. */
export function WorkingBotsPanel({ sessions, agents, selectedId, onOpen }: { sessions: readonly Session[]; agents: readonly Agent[]; selectedId: string | null; onOpen: (id: string) => void }) {
  const [expanded, setExpanded] = useState(true)
  const [now, setNow] = useState(Date.now)
  const tasks = sessions.filter(s => isSideSession(s) && !s.archived).map(session => ({ session, status: taskStatus(session) })).filter(t => t.status !== 'Loading')
  const active = tasks.filter(t => !['Done', 'Failed', 'Cancelled'].includes(t.status))
  const finished = tasks.filter(t => ['Done', 'Failed', 'Cancelled'].includes(t.status))
  useEffect(() => {
    if (!expanded || active.length === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expanded, active.length])
  if (!tasks.length) return null
  const row = ({ session, status }: typeof tasks[number]) => {
    const agent = agents.find(a => a.id === session.agentId)
    const name = agent?.name ?? 'Teammate'
    const title = session.link?.topic?.trim() || session.title?.trim() || 'Assigned task'
    return <li key={session.id}><button type="button" data-task-id={session.id} className={`working-bot-row${selectedId === session.id ? ' active' : ''}`} aria-current={selectedId === session.id ? 'page' : undefined} onClick={() => onOpen(session.id)} title={`${name}: ${title}`}>
      {agent && <BlobCanvas decorative color={agentColorHex(agent.color)} size={22} mini mood="idle" look={agentLook(agent)} label={name} />}
      <span className="working-bot-copy"><span className="working-bot-line"><strong>{name}</strong><span className="working-bot-status">{status}<span aria-hidden="true"> · </span><time aria-label="Elapsed time">{taskElapsed(session, status, now)}</time></span></span><span className="working-bot-title">{title}</span></span>
    </button></li>
  }
  return <section className="working-bots" aria-label="Working bots">
    <button type="button" className="working-bots-heading" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}><ChevronRight size={12} className={expanded ? 'open' : ''} aria-hidden="true" /><strong>Working bots</strong><span>{active.length}</span></button>
    {expanded && <><ul>{active.map(row)}</ul>{finished.length > 0 && <details><summary><ChevronRight size={12} aria-hidden="true" /><span>{finished.length} finished</span></summary><ul>{finished.map(row)}</ul></details>}</>}
  </section>
}
