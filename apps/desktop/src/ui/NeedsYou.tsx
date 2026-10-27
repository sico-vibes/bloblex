// "Needs you": every approval, question and proposal that is waiting for the owner, across all bots, in one place.
// A row only navigates to the conversation that asked. The decision itself stays on the original request there,
// with the authority and choices that request carried; nothing here can approve, answer or decline for anyone.
import { useMemo } from 'react'
import { ArrowUpRight } from 'lucide-react'
import type { Agent, PermissionRequest, Session } from '../types'
import { isPendingPermissionLive } from './permissionSelection'
import './needsYou.css'

export type NeedsYouItem = { permission: PermissionRequest; sessionId: string; agent: Agent | undefined; kind: 'question' | 'proposal' | 'approval'; summary: string; since: number | null }

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** What is waiting, oldest first. A request whose conversation is gone, archived or already answered is not listed. */
export function needsYouItems(permissions: readonly PermissionRequest[], sessions: readonly Session[], agents: readonly Agent[], now: number): NeedsYouItem[] {
  const items: NeedsYouItem[] = []
  for (const permission of permissions) {
    if (typeof permission.sessionId !== 'string' || !isPendingPermissionLive(permission, now)) continue
    const session = sessions.find((item) => item.id === permission.sessionId)
    if (!session || session.archived) continue
    const kind = permission.kind === 'question' ? 'question' : permission.kind === 'proposal' ? 'proposal' : 'approval'
    const firstQuestion = permission.questions?.[0]
    const raw = kind === 'question' ? (firstQuestion?.question ?? firstQuestion?.header ?? permission.title ?? '') : (permission.title ?? permission.command ?? permission.tool ?? '')
    const stamp = typeof permission.createdAt === 'string' ? Date.parse(permission.createdAt) : NaN
    items.push({ permission, sessionId: session.id, agent: agents.find((agent) => agent.id === session.agentId), kind, summary: clip(String(raw).replace(/\s+/g, ' ').trim(), 90), since: Number.isFinite(stamp) ? stamp : null })
  }
  return items.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity))
}

function waited(since: number | null, now: number) {
  if (since === null) return null
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
}

export function NeedsYou({ permissions, sessions, agents, now, onOpen }: { permissions: readonly PermissionRequest[]; sessions: readonly Session[]; agents: readonly Agent[]; now: number; onOpen: (sessionId: string) => void }) {
  const items = useMemo(() => needsYouItems(permissions, sessions, agents, now), [permissions, sessions, agents, now])
  if (!items.length) return null
  const label = items.length === 1 ? '1 request is waiting for you' : `${items.length} requests are waiting for you`
  return <section className="sidebar-attention" aria-label={label}>
    <h3 className="sidebar-attention-head"><span>Needs you</span><b aria-hidden="true">{items.length}</b></h3>
    <ul>{items.map((item) => {
      const name = item.agent?.name ?? 'A bot'
      const age = waited(item.since, now)
      return <li key={item.permission.id}>
        <button type="button" className="sidebar-attention-row" onClick={() => onOpen(item.sessionId)} aria-label={`${name}: ${item.kind === 'question' ? 'question' : item.kind === 'proposal' ? 'proposal' : 'approval'}, ${item.summary || 'open to read it'}. Open the request.`}>
          <span className="sidebar-attention-copy"><strong title={item.summary}>{item.summary || 'Open request'}</strong><span>{name} · {item.kind === 'question' ? 'Question' : item.kind === 'proposal' ? 'Proposal' : 'Approval'}</span></span>
          {age && <time>{age}</time>}
          <ArrowUpRight size={12} aria-hidden="true" />
        </button>
      </li>
    })}</ul>
  </section>
}
