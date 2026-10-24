// The companion's team view, after the Grok Bot companion study: one blob in
// focus with its live steps, and up to four teammates in sight, each reduced
// to a face and the line it is working on. Same projects, roles, leader and
// side conversations as the main window.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, Check, ClipboardList, Copy, LayoutGrid, Pin, PinOff, Terminal, X, ArrowLeftRight, BriefcaseBusiness } from 'lucide-react'
import type { Agent, ChatMessage, Project, Runtime, Session } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { useThemeStyle } from '../blob/bitbots'
import { HazeAura } from '../blob/haze/HazeAura'
import { agentLook } from '../blob/look'
import { MAX_COMPANION_PEERS } from '../blob/companionLayout'
import { agentColorHex } from './agentColor'
import { activityTitle } from './ActivityDetails'
import { buildConversationItems } from './conversation'
import { MessageActions, MessageReactionBadges, ReplyContextStrip } from './MessageActions'
import { conversationPreview, groupAgentsByProject, mainSessionFor, sessionIsBusy, sideSessionsFor, sideTitle, splitMentions } from './teamSelectors'
import { useEntityNoun } from './vocabulary'
import { SafeMarkdown, SafeMarkdownInline } from './SafeMarkdown'
import { openSafeLink } from './openSafeLink'

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
  const nouns = useEntityNoun({ plural: true })
  const peers = pickPeers(agents, sessions, runtimes, connected, focusedId, pinned)
  const haze = useThemeStyle() === 'haze'
  const total = agents.filter((agent) => !agent.archived && agent.id !== focusedId).length
  if (picking) return <CompanionTeamPicker agents={agents} projects={projects} sessions={sessions} runtimes={runtimes} connected={connected} focusedId={focusedId} pinned={pinned} onSelect={(agent) => { setPicking(false); onSelect(agent) }} onPinnedChange={onPinnedChange} onClose={() => setPicking(false)} />
  return <div className="island-card peers-card" data-companion-no-drag="">
    {peers.length === 0
      ? <p className="companion-empty">No other {nouns} yet.</p>
      : <div className={`peer-grid count-${peers.length}`}>
        {peers.map((agent, index) => {
          const state = blobState(agent, sessions, runtimes, connected)
          const line = peerLine(agent, sessions, state)
          return <button key={agent.id} type="button" className={`peer state-${state}`} style={{ ['--peer' as string]: agentColorHex(agent.color), animationDelay: `${index * 45}ms` }} aria-keyshortcuts={`Control+${index + 1}${state === 'waiting' ? ' N' : ''}`} aria-label={`${agent.name}${agent.leader ? ', team leader' : ''}: ${line}`} title={`${agent.name}: ${line}`} onClick={() => onSelect(agent)}>
            <span className="peer-face"><Face agent={agent} size={22} mood={state === 'offline' ? 'offline' : 'idle'} />{agent.leader && <i className="peer-leader" aria-hidden="true"><BriefcaseBusiness size={8} strokeWidth={2.6} /></i>}</span>
            {/* One line per chip so the name has room; what it is doing is in the tooltip and the label. */}
            <HazeAura status={state === 'waiting' ? 'needs' : state === 'working' ? 'working' : 'idle'} color={agentColorHex(agent.color)} manager={agent.systemRole === 'manager'} quiet />
            <span className="peer-copy"><b className={state === 'working' && !haze ? 'shimmer' : undefined}>{agent.name}</b></span>
            {haze && <span className="peer-line">{line}</span>}
            {state !== 'idle' && state !== 'offline' && <i className={`peer-state-dot ${state}`} aria-hidden="true" />}
          </button>
        })}
      </div>}
    <button type="button" className="peers-all" aria-label={`All ${nouns} (${total})`} title={`All ${nouns}`} onClick={() => setPicking(true)}><LayoutGrid size={12} /><span>{total}</span></button>
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
  const nouns = useEntityNoun({ plural: true })
  const full = pinned.length >= MAX_COMPANION_PEERS
  const togglePin = (id: string) => onPinnedChange(pinned.includes(id) ? pinned.filter((item) => item !== id) : full ? [...pinned] : [...pinned, id])
  return <div className="island-card team-picker" data-companion-no-drag="" role="dialog" aria-label={`All ${nouns}`}>
    <div className="team-picker-head">
      <strong>All {nouns}</strong>
      <span>{pinned.length}/{MAX_COMPANION_PEERS} kept on the island</span>
      <button type="button" className="team-picker-close" aria-label={`Close all ${nouns}`} onClick={onClose}><X size={13} /></button>
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
            {agent.id !== focusedId && <button type="button" className={`team-picker-pin${isPinned ? ' on' : ''}`} aria-pressed={isPinned} disabled={!isPinned && full} aria-label={isPinned ? `Unpin ${agent.name} from the island` : `Keep ${agent.name} on the island`} title={isPinned ? 'Unpin from the island' : full ? `Up to ${MAX_COMPANION_PEERS} ${nouns}` : 'Keep on the island'} onClick={() => togglePin(agent.id)}>{isPinned ? <PinOff size={12} /> : <Pin size={12} />}</button>}
          </div>
        })}
      </div>)}
    </div>
  </div>
}

/**
 * The companion settings' "Teammates on the island" control. Shows who is on
 * the island now as small chips, switches between "Picked for you" (the list is
 * empty and the island ranks teammates itself) and "Choose myself" (the saved
 * `companion.pinnedBlobs` list), and while choosing lists the teammates with a
 * checkbox each, up to the island's maximum. It reads and writes the same
 * `pinned` list the all-blobs picker does.
 */
export function CompanionTeammatesSetting({ agents, sessions, runtimes, connected, focusedId, pinned, onPinnedChange }: {
  agents: readonly Agent[]
  sessions: readonly Session[]
  runtimes: readonly Runtime[]
  connected: boolean
  focusedId: string | null
  pinned: readonly string[]
  onPinnedChange: (ids: string[]) => void
}) {
  const [choosing, setChoosing] = useState(false)
  const nouns = useEntityNoun({ plural: true })
  const candidates = agents.filter((agent) => !agent.archived && agent.hidden !== true && agent.id !== focusedId)
  const manual = choosing || pinned.length > 0
  const onIsland = manual
    ? pinned.map((id) => candidates.find((agent) => agent.id === id)).filter((agent): agent is Agent => !!agent)
    : pickPeers(agents, sessions, runtimes, connected, focusedId, pinned)
  const full = pinned.length >= MAX_COMPANION_PEERS
  const choose = (next: boolean) => {
    if (next === manual) return
    setChoosing(next)
    // Choosing starts from what the island shows now, so nothing jumps.
    onPinnedChange(next ? onIsland.map((agent) => agent.id) : [])
  }
  const toggle = (id: string) => onPinnedChange(pinned.includes(id) ? pinned.filter((item) => item !== id) : full ? [...pinned] : [...pinned, id])
  return <div className="cset-teammates">
    <div className="segmented" role="radiogroup" aria-label="Teammates on the island">
      <button type="button" role="radio" aria-checked={!manual} className={!manual ? 'on' : undefined} onClick={() => choose(false)}>Picked for you</button>
      <button type="button" role="radio" aria-checked={manual} className={manual ? 'on' : undefined} onClick={() => choose(true)}>Choose myself</button>
    </div>
    <p className="cset-note">{manual ? `Keep up to ${MAX_COMPANION_PEERS} on the island (${Math.min(pinned.length, MAX_COMPANION_PEERS)} of ${MAX_COMPANION_PEERS}).` : 'Ones that need you or are busy come first.'}</p>
    {onIsland.length > 0
      ? <ul className="cset-chips" aria-label="On the island now">
        {onIsland.map((agent) => <li key={agent.id} className="cset-chip" style={{ ['--chip' as string]: agentColorHex(agent.color) }}><Face agent={agent} size={16} /><span>{agent.name}</span></li>)}
      </ul>
      : <p className="cset-note">{candidates.length === 0 ? `No other ${nouns} yet.` : 'None chosen yet. Until you pick some, the island picks for you.'}</p>}
    {manual && candidates.length > 0 && <ul className="cset-checklist" aria-label="Choose teammates" data-companion-no-drag="">
      {candidates.map((agent) => {
        const state = blobState(agent, sessions, runtimes, connected)
        const checked = pinned.includes(agent.id)
        const blocked = !checked && full
        return <li key={agent.id}>
          <button type="button" role="checkbox" aria-checked={checked} className={`cset-check${checked ? ' on' : ''}`} disabled={blocked} title={blocked ? `Up to ${MAX_COMPANION_PEERS} on the island` : undefined} onClick={() => toggle(agent.id)}>
            <Face agent={agent} size={18} mood={state === 'offline' ? 'offline' : 'idle'} />
            <span className="cset-check-name">{agent.name}{agent.role?.trim() && <small>{agent.role.trim()}</small>}</span>
            <span className="cset-box" aria-hidden="true">{checked && <Check size={11} strokeWidth={3} />}</span>
          </button>
        </li>
      })}
    </ul>}
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
    : <span key={index}><SafeMarkdownInline text={segment.text} onOpenLink={(url) => void openSafeLink(url)} /></span>)}</>
}

function plain(text: string) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
}

/** Copy one companion message, with the same 1.2 s "Copied" state the main chat uses. */
export function CompanionCopyButton({ text, label = 'Copy message text' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1200)
    }).catch(() => undefined)
  }
  return <button type="button" className={`companion-copy${copied ? ' copied' : ''}`} aria-label={copied ? 'Copied' : label} title={copied ? 'Copied' : 'Copy'} disabled={!text} onClick={(event) => { event.stopPropagation(); copy() }}>{copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}</button>
}

function clockOf(value: unknown) {
  const time = Date.parse(String(value ?? ''))
  return Number.isFinite(time) ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined
}

/**
 * A conversation item in the companion chat, with the same team semantics and
 * the same per-message actions as the main window (at the companion's size).
 */
export function CompanionChatItem({ message, agents, onOpenSide, onOpenAgent, onToggleReaction, currentSessionId, availableMessageIds = new Set() }: { message: ChatMessage; agents: readonly Agent[]; onOpenSide: (sessionId: string | undefined) => void; onOpenAgent?: (agent: Agent) => void; onToggleReaction?: (messageId: string, emoji: string) => Promise<unknown> | void; currentSessionId?: string; availableMessageIds?: ReadonlySet<string> }): ReactNode {
  const role = String(message.role ?? '')
  const text = String(message.content ?? message.text ?? '')
  const meta = message.meta
  const rawReply = meta?.replyTo && typeof meta.replyTo === 'object' ? meta.replyTo as Record<string, unknown> : null
  const reply = rawReply && typeof rawReply.messageId === 'string' && typeof rawReply.sourceSessionId === 'string' && typeof rawReply.author === 'string' && typeof rawReply.excerpt === 'string'
    ? { messageId: rawReply.messageId, sourceSessionId: rawReply.sourceSessionId, author: rawReply.author, excerpt: rawReply.excerpt }
    : null
  const messageId = String(message.id ?? '')
  const jump = (sourceSessionId: string, sourceMessageId: string) => {
    if (sourceSessionId !== currentSessionId) return
    const original = document.getElementById(`companion-message-${encodeURIComponent(sourceMessageId)}`)
    original?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })
  }
  if (role === 'thinking') return null
  if (meta?.kind === 'delegation' || meta?.kind === 'blob_reply') {
    const id = meta.kind === 'delegation' ? meta.peerAgentId : meta.fromAgentId
    const peer = agents.find((agent) => agent.id === id)
    const name = (meta.kind === 'delegation' ? meta.peerName : meta.fromName) ?? peer?.name ?? 'Teammate'
    const failed = meta.kind === 'delegation' && meta.direction === 'failed'
    return <div className="companion-team-chip-row">
      <button type="button" className={`companion-team-chip${failed ? ' failed' : ''}`} style={peer ? { ['--chip-accent' as string]: agentColorHex(peer.color) } : undefined} disabled={!meta.sideSessionId} title={text.trim() ? text.trim().slice(0, 280) : undefined} onClick={() => onOpenSide(meta.sideSessionId)} aria-label={`${meta.kind === 'delegation' ? (failed ? 'Could not reach' : 'Messaged') : 'Message from'} ${name}. Open the conversation`}>
        <span>{meta.kind === 'delegation' ? (failed ? 'Could not reach' : 'Messaged') : 'Message from'}</span>{peer && <Face agent={peer} size={14} />}<b>{name}</b>{meta.sideSessionId && <ArrowUpRight size={11} aria-hidden="true" className="companion-team-chip-open" />}
      </button>
    </div>
  }
  if (role === 'notice' && meta?.kind === 'blob_created') {
    const created = agents.find((agent) => agent.id === meta.agentId)
    const name = created?.name ?? (typeof meta.name === 'string' ? meta.name : 'Teammate')
    return <div className="companion-team-chip-row">
      <button type="button" className="companion-team-chip created" style={created ? { ['--chip-accent' as string]: agentColorHex(created.color) } : undefined} disabled={!created || !onOpenAgent} onClick={() => { if (created) onOpenAgent?.(created) }} aria-label={`Created ${name}${created?.role ? `, ${created.role}` : ''}`}>
        <span>Created</span>{created && <Face agent={created} size={14} />}<b>{name}</b>{created?.role?.trim() && <em className="companion-team-chip-topic">{created.role.trim()}</em>}
      </button>
    </div>
  }
  if (role === 'user' && meta?.kind === 'blob_message') {
    // In a conversation between two bots, the asking bot's message reads as theirs, not as yours.
    const from = agents.find((agent) => agent.id === meta.fromAgentId)
    return <div className="chat-row peer-message"><div className="companion-peer-author">{from && <Face agent={from} size={14} />}<b style={from ? { color: agentColorHex(from.color) } : undefined}>{meta.fromName ?? from?.name ?? 'Teammate'}</b></div><div className="reply message-bubble"><SafeMarkdown text={text} onOpenLink={(url) => void openSafeLink(url)} /></div></div>
  }
  if ((role === 'notice' || role === 'user') && meta?.kind === 'auto_retry') {
    return <div className="companion-context-divider" role="status"><span>{role === 'user' ? 'Continuing automatically' : plain(text)}</span></div>
  }
  if (role === 'notice' && meta?.kind === 'context_reset') {
    return <div className={`companion-context-divider${meta.contextLost === true ? ' lost' : ''}`} role="separator" aria-label={text}><span>{plain(text)}</span></div>
  }
  if (role === 'plan' || meta?.kind === 'plan') {
    return <div className="companion-plan"><ClipboardList size={12} aria-hidden="true" /><span><b>Proposed plan</b> {plain(text)}</span></div>
  }
  const quotedContext = reply && <ReplyContextStrip target={reply} compact available={reply.sourceSessionId === currentSessionId && availableMessageIds.has(reply.messageId)} onJump={jump} />
  const reactions = Array.isArray(message.reactions) ? message.reactions as string[] : []
  const actions = (copyText: string) => <MessageActions compact text={copyText} time={clockOf(message.createdAt)} reactions={reactions} onToggleReaction={onToggleReaction && messageId ? (emoji) => onToggleReaction(messageId, emoji) : undefined} onError={() => undefined} />
  if (role === 'user') return <div id={messageId ? `companion-message-${encodeURIComponent(messageId)}` : undefined} data-companion-message-id={messageId || undefined} className="chat-row user">{quotedContext}{actions(text)}<div className="bubble"><CompanionMentionText text={text} agents={agents} /><MessageReactionBadges reactions={message.reactions} /></div></div>
  const replyText = text.trim()
  return replyText ? <div id={messageId ? `companion-message-${encodeURIComponent(messageId)}` : undefined} data-companion-message-id={messageId || undefined} className="chat-row">{quotedContext}<div className="reply message-bubble"><SafeMarkdown text={replyText} onOpenLink={(url) => void openSafeLink(url)} /><MessageReactionBadges reactions={message.reactions} /></div>{actions(replyText)}</div> : null
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
      <span><strong>{sideTitle(side, agents)}</strong><small className={busy ? 'shimmer' : undefined}>{busy ? 'Working on it' : side.state === 'waiting_permission' ? 'Waiting for you' : `${from?.name ?? 'Teammate'} asked ${to?.name ?? 'a teammate'}`}</small></span>
    </button>
  })}</>
}
