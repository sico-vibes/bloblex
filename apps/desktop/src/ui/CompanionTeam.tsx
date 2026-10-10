// The companion's mini team overview: the same projects, roles, leader and
// side conversations as the main window, sized for the floating island.
import type { ReactNode } from 'react'
import { ArrowLeftRight, ClipboardList } from 'lucide-react'
import type { Agent, ChatMessage, Project, Runtime, Session } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { groupAgentsByProject, mainSessionFor, sessionIsBusy, sideSessionsFor, splitMentions } from './teamSelectors'

type BlobState = 'waiting' | 'working' | 'offline' | 'idle'

function blobState(agent: Agent, sessions: readonly Session[], runtimes: readonly Runtime[], connected: boolean): BlobState {
  const runtime = runtimes.find((item) => item.id === agent.runtimeId)
  if (!connected || !runtime || ['offline', 'error', 'disconnected'].includes(String(runtime.status ?? '').toLowerCase())) return 'offline'
  const own = [mainSessionFor(sessions, agent.id), ...sideSessionsFor(sessions, agent.id).filter((side) => side.agentId === agent.id)]
  if (own.some((session) => session?.state === 'waiting_permission')) return 'waiting'
  if (own.some((session) => sessionIsBusy(session))) return 'working'
  return 'idle'
}

const STATE_LABEL: Record<BlobState, string> = { waiting: 'waiting for you', working: 'working', offline: 'offline', idle: '' }

function MiniFace({ agent, size, mood = 'idle' }: { agent: Agent; size: number; mood?: 'idle' | 'offline' }) {
  return <BlobCanvas decorative color={agentColorHex(agent.color)} size={size} mini mood={mood} look={agentLook(agent)} label={agent.name} />
}

/** Every blob, grouped by project like the main sidebar: a face, a name and a live state. */
export function CompanionTeamCard({ agents, projects, sessions, runtimes, connected, selectedId, onSelect }: {
  agents: readonly Agent[]
  projects: readonly Project[]
  sessions: readonly Session[]
  runtimes: readonly Runtime[]
  connected: boolean
  selectedId: string | null
  onSelect: (agent: Agent) => void
}) {
  const groups = groupAgentsByProject(agents, projects).filter((group) => group.agents.length > 0)
  if (!groups.length) return <div className="island-card team-card"><p className="companion-empty">No blobs yet.</p></div>
  const single = groups.length === 1
  return <div className="island-card team-card" data-companion-no-drag="">
    <div className="team-card-scroll">
      {groups.map((group) => <div key={group.project?.id ?? 'casual'} className="team-card-group">
        {!single && <span className="team-card-label">{group.project?.name ?? 'Casual'}</span>}
        <div className="team-card-pills">
          {group.agents.map((agent) => {
            const state = blobState(agent, sessions, runtimes, connected)
            const label = [agent.name, agent.role?.trim(), agent.leader ? 'team leader' : '', STATE_LABEL[state]].filter(Boolean).join(', ')
            return <button key={agent.id} type="button" className={`team-pill state-${state}${agent.id === selectedId ? ' on' : ''}`} style={{ ['--pill' as string]: agentColorHex(agent.color) }} aria-label={label} aria-pressed={agent.id === selectedId} title={label} onClick={() => onSelect(agent)}>
              <span className="team-pill-face"><MiniFace agent={agent} size={20} mood={state === 'offline' ? 'offline' : 'idle'} />{agent.leader && <i className="team-pill-leader" aria-hidden="true">★</i>}</span>
              <span className="team-pill-name">{agent.name}</span>
              {state !== 'idle' && state !== 'offline' && <i className="team-pill-dot" aria-hidden="true" />}
            </button>
          })}
        </div>
      </div>)}
    </div>
  </div>
}

/** One line about the focused blob's teammates: who it is waiting on, or who replied. */
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
    ? <span key={index} className="companion-mention" style={{ ['--mention' as string]: agentColorHex(segment.agent.color) }}><MiniFace agent={segment.agent} size={14} />{segment.agent.name}</span>
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
        <span>{meta.kind === 'delegation' ? (failed ? 'Could not reach' : 'Messaged') : 'Message from'}</span>{peer && <MiniFace agent={peer} size={14} />}<b>{name}</b>
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
      <span className="companion-side-faces">{from && <MiniFace agent={from} size={16} />}<ArrowLeftRight size={10} aria-hidden="true" />{to && <MiniFace agent={to} size={16} />}</span>
      <span><strong>{from?.name ?? 'Teammate'} ⇄ {to?.name ?? 'Teammate'}</strong><small className={busy ? 'shimmer' : undefined}>{busy ? 'Working on it' : side.state === 'waiting_permission' ? 'Waiting for you' : 'Side conversation'}</small></span>
    </button>
  })}</>
}
