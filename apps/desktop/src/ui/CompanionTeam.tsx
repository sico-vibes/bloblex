// The companion's team view, after the Grok Bot companion study: one blob in
// focus with its live steps, and up to four teammates in sight, each reduced
// to a face and the line it is working on. Same projects, roles, leader and
// side conversations as the main window.
import { useState, type ReactNode } from 'react'
import { ArrowLeftRight, ClipboardList, LayoutGrid, Pin, PinOff, Terminal, X } from 'lucide-react'
import type { Agent, ChatMessage, Project, Runtime, Session } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { MAX_COMPANION_PEERS } from '../blob/companionLayout'
import { agentColorHex } from './agentColor'
import { activityTitle } from './ActivityDetails'
import { buildConversationItems } from './conversation'
import { conversationPreview, groupAgentsByProject, mainSessionFor, sessionIsBusy, sideSessionsFor, splitMentions } from './teamSelectors'

export type BlobState = 'waiting' | 'working' | 'offline' | 'idle'

export function blobState(agent: Agent, sessions: readonly Session[], runtimes: readonly Runtime[], connected: boolean): BlobState {
  const runtime = runtimes.find((item) => item.id === agent.runtimeId)
  if (!connected || !runtime || ['offline', 'error', 'disconnected'].includes(String(runtime.status ?? '').toLowerCase())) return 'offline'
  const own = [mainSessionFor(sessions, agent.id), ...sideSessionsFor(sessions, agent.id).filter((side) => side.agentId === agent.id)]
  if (own.some((session) => session?.state === 'waiting_permission')) return 'waiting'
  if (own.some((session) => sessionIsBusy(session))) return 'working'
  return 'idle'
}

/** The steps a session has taken, newest last, as readable titles. */
export function sessionSteps(session: Session | null | undefined): Array<{ id: string; title: string; running: boolean }> {
  if (!session) return []
  return buildConversationItems(session)
    .filter((item) => item.kind === 'activity' && item.activityKind !== 'turn')
    .map((item) => ({ id: item.id, title: activityTitle(item), running: ['running', 'working', 'started'].includes(String(item.activity?.state ?? '').toLowerCase()) }))
}

/** The one line a teammate shows on the island: what it needs, or what it is doing. */
export function peerLine(agent: Agent, sessions: readonly Session[], state: BlobState) {
  if (state === 'offline') return 'Offline'
  if (state === 'waiting') return 'Waiting for you'
  const main = mainSessionFor(sessions, agent.id)
  if (state === 'working') {
    const running = [main, ...sideSessionsFor(sessions, agent.id).filter((side) => side.agentId === agent.id)]
      .flatMap((session) => sessionSteps(session)).reverse().find((step) => step.running)
    return running?.title ?? 'Working…'
  }
  return conversationPreview(main) ?? (agent.role?.trim() || 'Ready')
}

/**
 * Who stays in sight beside the focused blob: the ones you pinned, then the
 * ones that need you, then the busy ones, then the most recently active.
 */
export function pickPeers(agents: readonly Agent[], sessions: readonly Session[], runtimes: readonly Runtime[], connected: boolean, focusedId: string | null, pinned: readonly string[]): Agent[] {
  const others = agents.filter((agent) => !agent.archived && agent.id !== focusedId && agent.hidden !== true)
  const rank = (agent: Agent) => {
    const state = blobState(agent, sessions, runtimes, connected)
    const pin = pinned.indexOf(agent.id)
    return [pin >= 0 ? pin : 99, state === 'waiting' ? 0 : state === 'working' ? 1 : 2, -Date.parse(String(mainSessionFor(sessions, agent.id)?.updatedAt ?? 0))]
  }
  return [...others].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)]
    return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] || 0) - (rb[2] || 0)
  }).slice(0, MAX_COMPANION_PEERS)
}

function Face({ agent, size, mood = 'idle' }: { agent: Agent; size: number; mood?: 'idle' | 'offline' }) {
  return <BlobCanvas decorative color={agentColorHex(agent.color)} size={size} mini mood={mood} look={agentLook(agent)} label={agent.name} />
}

/** Up to four teammates in a 2×2 grid: a face and the line it is working on. */
export function CompanionPeers({ agents, projects, sessions, runtimes, connected, focusedId, pinned, onSelect, onPinnedChange }: {
  agents: readonly Agent[]
  projects: readonly Project[]
  sessions: readonly Session[]
  runtimes: readonly Runtime[]
  connected: boolean
  focusedId: string | null
  pinned: readonly string[]
  onSelect: (agent: Agent) => void
  onPinnedChange: (ids: string[]) => void
}) {
  const [picking, setPicking] = useState(false)
  const peers = pickPeers(agents, sessions, runtimes, connected, focusedId, pinned)
  const total = agents.filter((agent) => !agent.archived && agent.id !== focusedId).length
  if (picking) return <CompanionTeamPicker agents={agents} projects={projects} sessions={sessions} runtimes={runtimes} connected={connected} focusedId={focusedId} pinned={pinned} onSelect={(agent) => { setPicking(false); onSelect(agent) }} onPinnedChange={onPinnedChange} onClose={() => setPicking(false)} />
  return <div className="island-card peers-card" data-companion-no-drag="">
    {peers.length === 0
      ? <p className="companion-empty">No other blobs yet.</p>
      : <div className={`peer-grid count-${peers.length}`}>
        {peers.map((agent, index) => {
          const state = blobState(agent, sessions, runtimes, connected)
          const line = peerLine(agent, sessions, state)
          return <button key={agent.id} type="button" className={`peer state-${state}`} style={{ ['--peer' as string]: agentColorHex(agent.color), animationDelay: `${index * 45}ms` }} aria-label={`${agent.name}${agent.leader ? ', team leader' : ''}: ${line}`} title={`${agent.name}: ${line}`} onClick={() => onSelect(agent)}>
            <span className="peer-face"><Face agent={agent} size={22} mood={state === 'offline' ? 'offline' : 'idle'} />{agent.leader && <i className="peer-leader" aria-hidden="true">★</i>}</span>
            <span className="peer-copy"><b>{agent.name}</b><span className={`peer-line${state === 'working' ? ' shimmer' : ''}`}>{line}</span></span>
          </button>
        })}
      </div>}
    <button type="button" className="peers-all" aria-label={`All blobs (${total})`} title="All blobs" onClick={() => setPicking(true)}><LayoutGrid size={12} /><span>{total}</span></button>
  </div>
}

/** Every blob by project: tap to focus it, pin up to four to keep them on the island. */
export function CompanionTeamPicker({ agents, projects, sessions, runtimes, connected, focusedId, pinned, onSelect, onPinnedChange, onClose }: {
  agents: readonly Agent[]
  projects: readonly Project[]
  sessions: readonly Session[]
  runtimes: readonly Runtime[]
  connected: boolean
  focusedId: string | null
  pinned: readonly string[]
  onSelect: (agent: Agent) => void
  onPinnedChange: (ids: string[]) => void
  onClose: () => void
}) {
  const groups = groupAgentsByProject(agents, projects).filter((group) => group.agents.length > 0)
  const full = pinned.length >= MAX_COMPANION_PEERS
  const togglePin = (id: string) => onPinnedChange(pinned.includes(id) ? pinned.filter((item) => item !== id) : full ? [...pinned] : [...pinned, id])
  return <div className="island-card team-picker" data-companion-no-drag="" role="dialog" aria-label="All blobs">
    <div className="team-picker-head">
      <strong>All blobs</strong>
      <span>{pinned.length}/{MAX_COMPANION_PEERS} kept on the island</span>
      <button type="button" className="team-picker-close" aria-label="Close all blobs" onClick={onClose}><X size={13} /></button>
    </div>
    <div className="team-picker-scroll">
      {groups.map((group) => <div key={group.project?.id ?? 'casual'} className="team-picker-group">
        <span className="team-picker-label">{group.project?.name ?? 'Casual'}</span>
        {group.agents.map((agent) => {
          const state = blobState(agent, sessions, runtimes, connected)
          const isPinned = pinned.includes(agent.id)
          return <div key={agent.id} className={`team-picker-row${agent.id === focusedId ? ' focused' : ''}`}>
            <button type="button" className="team-picker-select" onClick={() => onSelect(agent)} aria-current={agent.id === focusedId ? 'true' : undefined}>
              <Face agent={agent} size={20} mood={state === 'offline' ? 'offline' : 'idle'} />
              <span className="team-picker-name">{agent.name}{agent.role?.trim() && <small>{agent.role.trim()}</small>}</span>
              <span className={`team-picker-state state-${state}`}>{peerLine(agent, sessions, state)}</span>
            </button>
            {agent.id !== focusedId && <button type="button" className={`team-picker-pin${isPinned ? ' on' : ''}`} aria-pressed={isPinned} disabled={!isPinned && full} aria-label={isPinned ? `Unpin ${agent.name} from the island` : `Keep ${agent.name} on the island`} title={isPinned ? 'Unpin from the island' : full ? `Up to ${MAX_COMPANION_PEERS} blobs` : 'Keep on the island'} onClick={() => togglePin(agent.id)}>{isPinned ? <PinOff size={12} /> : <Pin size={12} />}</button>}
          </div>
        })}
      </div>)}
    </div>
  </div>
}

/**
 * The focused blob's last steps as a short ticker: done steps dim, the current
 * one bright with its icon. New steps slide in from below.
 */
export function FocusTicker({ steps, current, shimmering }: { steps: Array<{ id: string; title: string; running: boolean }>; current: string; shimmering: boolean }) {
  const recent = steps.slice(-2)
  const lines = [...recent.map((step) => ({ key: step.id, text: step.title, done: !step.running })), { key: `now:${current}`, text: current, done: false }]
    .filter((line, index, all) => all.findIndex((other) => other.text === line.text) === index)
    .slice(-3)
  return <div className="focus-ticker" aria-live="polite">
    {lines.map((line, index) => {
      const isCurrent = index === lines.length - 1
      return <div key={line.key} className={`focus-ticker-row${isCurrent ? ' current' : ''}`}>
        {isCurrent ? <Terminal size={12} aria-hidden="true" /> : <span className="focus-ticker-dot" aria-hidden="true" />}
        <span className={isCurrent && shimmering ? 'shimmer' : undefined}>{line.text}</span>
      </div>
    })}
  </div>
}

/** One line about the focused blob's teammates: who it is waiting on, or who it is helping. */
export function teamLine(agent: Agent | null, agents: readonly Agent[], sessions: readonly Session[]): { text: string; peer: Agent | null; sessionId: string } | null {
  if (!agent) return null
  const sides = sideSessionsFor(sessions, agent.id)
  for (const side of sides) {
    const outgoing = side.link?.peerAgentId === agent.id
    const other = agents.find((item) => item.id === (outgoing ? side.agentId : side.link?.peerAgentId)) ?? null
    if (!other) continue
    if (outgoing && sessionIsBusy(side)) return { text: `Waiting on ${other.name}`, peer: other, sessionId: side.id }
    if (!outgoing && sessionIsBusy(side)) return { text: `Helping ${other.name}`, peer: other, sessionId: side.id }
  }
  const latest = sides[0]
  if (!latest) return null
  const outgoing = latest.link?.peerAgentId === agent.id
  const other = agents.find((item) => item.id === (outgoing ? latest.agentId : latest.link?.peerAgentId)) ?? null
  return other ? { text: outgoing ? `Talked with ${other.name}` : `Helped ${other.name}`, peer: other, sessionId: latest.id } : null
}

/** Your own words, with @mentions shown as the blob's face and name in its colour. */
export function CompanionMentionText({ text, agents }: { text: string; agents: readonly Agent[] }) {
  return <>{splitMentions(text, agents).map((segment, index) => segment.agent
    ? <span key={index} className="companion-mention" style={{ ['--mention' as string]: agentColorHex(segment.agent.color) }}><Face agent={segment.agent} size={14} />{segment.agent.name}</span>
    : <span key={index}>{segment.text}</span>)}</>
}

function plain(text: string) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
}

/** A conversation item in the companion chat, with the same team semantics as the main window. */
export function CompanionChatItem({ message, agents, onOpenSide }: { message: ChatMessage; agents: readonly Agent[]; onOpenSide: (sessionId: string | undefined) => void }): ReactNode {
  const role = String(message.role ?? '')
  const text = String(message.content ?? message.text ?? '')
  const meta = message.meta
  if (role === 'thinking') return null
  if (meta?.kind === 'delegation' || meta?.kind === 'blob_reply') {
    const id = meta.kind === 'delegation' ? meta.peerAgentId : meta.fromAgentId
    const peer = agents.find((agent) => agent.id === id)
    const name = (meta.kind === 'delegation' ? meta.peerName : meta.fromName) ?? peer?.name ?? 'Teammate'
    const failed = meta.kind === 'delegation' && meta.direction === 'failed'
    return <div className="companion-team-chip-row">
      <button type="button" className={`companion-team-chip${failed ? ' failed' : ''}`} style={peer ? { ['--chip-accent' as string]: agentColorHex(peer.color) } : undefined} onClick={() => onOpenSide(meta.sideSessionId)} aria-label={`${meta.kind === 'delegation' ? (failed ? 'Could not reach' : 'Messaged') : 'Message from'} ${name}. Open in Bloblex`}>
        <span>{meta.kind === 'delegation' ? (failed ? 'Could not reach' : 'Messaged') : 'Message from'}</span>{peer && <Face agent={peer} size={14} />}<b>{name}</b>
      </button>
    </div>
  }
  if (role === 'plan' || meta?.kind === 'plan') {
    return <div className="companion-plan"><ClipboardList size={12} aria-hidden="true" /><span><b>Proposed plan</b> {plain(text)}</span></div>
  }
  if (role === 'user') return <div className="chat-row user"><div className="bubble"><CompanionMentionText text={text} agents={agents} /></div></div>
  const reply = plain(text)
  return reply ? <div className="chat-row"><div className="reply">{reply}</div></div> : null
}

/** Side conversations the focused blob took part in, newest first. */
export function CompanionTeamActivity({ agent, agents, sessions, onOpen }: { agent: Agent | null; agents: readonly Agent[]; sessions: readonly Session[]; onOpen: (sessionId: string) => void }) {
  if (!agent) return null
  const sides = sideSessionsFor(sessions, agent.id).slice(0, 3)
  if (!sides.length) return null
  return <>{sides.map((side) => {
    const from = agents.find((item) => item.id === side.link?.peerAgentId)
    const to = agents.find((item) => item.id === side.agentId)
    const busy = sessionIsBusy(side)
    return <button type="button" key={side.id} className="companion-activity-row team" onClick={() => onOpen(side.id)}>
      <span className="companion-side-faces">{from && <Face agent={from} size={16} />}<ArrowLeftRight size={10} aria-hidden="true" />{to && <Face agent={to} size={16} />}</span>
      <span><strong>{from?.name ?? 'Teammate'} ⇄ {to?.name ?? 'Teammate'}</strong><small className={busy ? 'shimmer' : undefined}>{busy ? 'Working on it' : side.state === 'waiting_permission' ? 'Waiting for you' : 'Side conversation'}</small></span>
    </button>
  })}</>
}
