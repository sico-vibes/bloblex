// Team surfaces inside a conversation: delegation chips, relayed replies,
// side-conversation header, proposed plans, inline questions and @mentions.
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { ArrowLeftRight, ArrowUpRight, Check, ChevronDown, ClipboardList, Hash, RotateCw, Send, X } from 'lucide-react'
import type { Agent, PermissionRequest, Session, UserQuestion } from '../types'
import { agentLook } from '../blob/look'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentColorHex } from './agentColor'
import { sideTitle } from './teamSelectors'
import { useEntityNoun } from './vocabulary'

function MiniBlob({ agent, name, size = 18 }: { agent: Agent | null | undefined; name: string; size?: number }) {
  return agent
    ? <BlobCanvas decorative color={agentColorHex(agent.color)} size={size} mood="idle" look={agentLook(agent)} label={name} />
    : <span className="team-chip-dot" aria-hidden="true">{name.slice(0, 1)}</span>
}

const accentOf = (agent: Agent | null | undefined) => agent ? { ['--chip-accent' as string]: agentColorHex(agent.color) } : undefined

/** "Messaged Codex" in the sender's conversation; opens the conversation between the two. */
export function DelegationChip({ peer, name, topic, failed, detail, text, onOpenConversation }: { peer: Agent | null | undefined; name: string; topic?: string; failed?: boolean; detail?: string; text?: string; onOpenConversation?: () => void }) {
  return <TeamChatChip kind="outgoing" peer={peer} name={name} topic={topic} failed={failed} text={text ?? detail} onOpenConversation={onOpenConversation} />
}

/** A relayed reply ("Message from Codex"); opens the conversation between the two. */
export function ReplyChip({ from, name, text, onOpenConversation }: { from: Agent | null | undefined; name: string; text?: string; onOpenConversation?: () => void }) {
  return <TeamChatChip kind="incoming" peer={from} name={name} text={text} onOpenConversation={onOpenConversation} />
}

/** "Created Dex (Engineer) in crewspan": the new bot's face and colour, like a delegation chip. */
export function CreatedBotChip({ agent, name, detail, onOpen }: { agent: Agent | null | undefined; name: string; detail?: string; onOpen?: () => void }) {
  const noun = useEntityNoun()
  return <div className="team-chip-row">
    <button type="button" className="team-chip created" style={accentOf(agent)} disabled={!onOpen} aria-label={`Created ${noun} ${name}${detail ? `, ${detail}` : ''}${onOpen ? `. Open ${name}` : ''}`} onClick={onOpen}>
      <span>Created</span><MiniBlob agent={agent} name={name} /><b>{name}</b>{detail && <em className="team-chip-topic">{detail}</em>}
      {onOpen && <ArrowUpRight size={12} className="team-chip-caret" aria-hidden="true" />}
    </button>
  </div>
}

/** A delegation or relayed-reply chip: a link to the conversation between the two bots. The message shows on hover. */
function TeamChatChip({ kind, peer, name, topic, failed, text, onOpenConversation }: {
  kind: 'outgoing' | 'incoming'
  peer: Agent | null | undefined
  name: string
  topic?: string
  failed?: boolean
  text?: string
  onOpenConversation?: () => void
}) {
  const body = typeof text === 'string' ? text.trim() : ''
  const label = kind === 'outgoing'
    ? failed
      ? `${name} could not start${body ? `: ${body}` : ''}`
      : `Messaged ${name}${topic ? ` about ${topic}` : ''}. Open the conversation`
    : `Message from ${name}. Open the conversation`
  return <div className="team-chip-row">
    <button type="button" className={`team-chip ${kind === 'incoming' ? 'incoming' : ''} ${failed ? 'failed' : ''}`} style={accentOf(peer)} disabled={!onOpenConversation}
      aria-label={label} title={body ? (body.length > 280 ? `${body.slice(0, 279)}…` : body) : undefined}
      onClick={onOpenConversation}>
      <span>{kind === 'incoming' ? 'Message from' : failed ? 'Could not reach' : 'Messaged'}</span><MiniBlob agent={peer} name={name} /><b>{name}</b>{topic && !failed && <em className="team-chip-topic">{topic}</em>}
      {onOpenConversation && <ArrowUpRight size={12} className="team-chip-caret" aria-hidden="true" />}
    </button>
  </div>
}

/** Choose which blob continues this conversation. The daemon only drafts the message; nothing is sent. */
export function HandoffDialog({ agents, sourceAgentId, busy, error, onPick, onClose }: {
  agents: readonly Agent[]
  sourceAgentId: string | null
  busy: boolean
  error: string | null
  onPick: (agent: Agent) => void
  onClose: () => void
}) {
  const entered = useDialogEntered()
  const noun = useEntityNoun()
  const { ref, close } = useDialogAccessibility(onClose, () => !busy)
  const choices = agents.filter((agent) => !agent.archived && !agent.hidden && agent.id !== sourceAgentId)
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title" tabIndex={-1}>
      <h2 id="handoff-title">Continue in another {noun}</h2>
      <p>Pick who should pick this up. Bitbots puts a short summary and the latest messages in their composer. Nothing is sent until you send it.</p>
      {choices.length === 0 && <p className="blob-muted">There is no other {noun} to hand this to.</p>}
      <ul className="handoff-list">
        {choices.map((agent, index) => <li key={agent.id}>
          <button type="button" className="handoff-choice" data-dialog-initial-focus={index === 0 ? '' : undefined} disabled={busy} onClick={() => onPick(agent)}>
            <MiniBlob agent={agent} name={agent.name} size={26} />
            <span><strong>{agent.name}</strong>{agent.role?.trim() ? <small>{agent.role}</small> : null}</span>
          </button>
        </li>)}
      </ul>
      {error && <p className="schedules-problem" role="alert">{error}</p>}
      <div className="blob-dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancel</button></div>
    </section>
  </div>
}

/** A hairline divider where the provider's context changed (compaction, fresh session or restart). `lost` means the agent can no longer see earlier turns. */
export function ContextResetDivider({ id, text, lost }: { id?: string; text: string; lost?: boolean }) {
  return <div id={id} className={`context-divider${lost ? ' lost' : ''}`} role="separator" aria-label={text}><span>{text}</span></div>
}

/** The daemon's automatic-retry decision: scheduled (cancellable), declined or cancelled. */
export function AutoRetryNotice({ id, text, status, onCancel }: { id?: string; text: string; status: string; onCancel?: () => void }) {
  return <div id={id} className={`team-chip-row auto-retry ${status}`} role="status">
    <span className="team-notice"><RotateCw size={11} aria-hidden="true" />{text}{status === 'scheduled' && onCancel && <button type="button" className="queue-link auto-retry-cancel" onClick={onCancel}>Cancel</button>}</span>
  </div>
}

/** Header for a side conversation between two blobs: a centred pill with both blobs and its topic. */
export function SideConversationHeader({ peer, peerName, target, targetName, topic }: { peer: Agent | null | undefined; peerName: string; target: Agent | null | undefined; targetName: string; topic?: string | null }) {
  return <div className="side-header" aria-label={`Side conversation between ${peerName} and ${targetName}${topic ? `: ${topic}` : ''}`}>
    <span className="side-header-pill">
      <span className="side-header-pair"><MiniBlob agent={peer} name={peerName} size={20} /><b style={accentOf(peer)}>{peerName}</b><ArrowLeftRight size={13} aria-hidden="true" /><MiniBlob agent={target} name={targetName} size={20} /><b style={accentOf(target)}>{targetName}</b></span>
      {topic && <span className="side-header-topic" title={topic}>{topic}</span>}
    </span>
  </div>
}

function relativeTime(value: unknown) {
  const time = Date.parse(String(value ?? ''))
  if (!Number.isFinite(time)) return ''
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  return days < 7 ? `${days}d` : new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** One side conversation as a row: both blobs, its topic, and who asked whom. */
function SideConversationRow({ session, agents, ownerId }: { session: Session; agents: readonly Agent[]; ownerId?: string }) {
  const asker = agents.find((agent) => agent.id === session.link?.peerAgentId)
  const asked = agents.find((agent) => agent.id === session.agentId)
  const askerName = asker?.name ?? session.link?.peerName ?? 'Teammate'
  const askedName = asked?.name ?? 'Teammate'
  const other = ownerId && asker?.id === ownerId ? askedName : askerName
  const relation = ownerId === asker?.id ? `asked ${askedName}` : ownerId === asked?.id ? `${askerName} asked` : `${askerName} asked ${askedName}`
  return <>
    <span className="side-row-pair" aria-hidden="true"><MiniBlob agent={asker} name={askerName} size={20} /><MiniBlob agent={asked} name={askedName} size={20} /></span>
    <span className="side-row-copy"><strong>{sideTitle(session, agents)}</strong><small>{ownerId ? relation : `${askerName} and ${askedName}`}{relativeTime(session.updatedAt) && ` · ${relativeTime(session.updatedAt)}`}</small></span>
    <span className="sr-only">{`with ${other}`}</span>
  </>
}

function useDismiss(open: boolean, rootRef: RefObject<HTMLElement | null>, close: (restoreFocus: boolean) => void) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) closeRef.current(false) }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(true) } }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true); document.removeEventListener('keydown', onKeyDown, true) }
  }, [open, rootRef])
}

/** The blob header's list of its side conversations, newest first. */
export function SideConversationMenu({ sessions, agents, ownerId, onOpen }: { sessions: readonly Session[]; agents: readonly Agent[]; ownerId: string; onOpen: (sessionId: string) => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  useDismiss(open, rootRef, (restore) => { setOpen(false); if (restore) triggerRef.current?.focus() })
  if (!sessions.length) return null
  return <div ref={rootRef} className="side-menu-wrap">
    <button ref={triggerRef} type="button" className="side-menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-label="Side conversations" onClick={() => setOpen((value) => !value)}>
      <span className="side-menu-faces" aria-hidden="true">{[...new Map(sessions.flatMap((session) => [session.link?.peerAgentId, session.agentId]).filter((id): id is string => !!id && id !== ownerId).map((id) => [id, agents.find((agent) => agent.id === id)])).values()].filter(Boolean).slice(0, 3).map((agent) => <MiniBlob key={agent!.id} agent={agent} name={agent!.name} size={16} />)}</span>
      <span>{sessions.length} side conversation{sessions.length === 1 ? '' : 's'}</span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {open && <div className="menu-surface side-menu" role="menu" aria-label="Side conversations" onKeyDown={(event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      const index = items.indexOf(document.activeElement as HTMLElement)
      items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    }}>
      {sessions.map((session) => <button key={session.id} type="button" role="menuitem" className="side-menu-item" onClick={() => { setOpen(false); onOpen(session.id) }}><SideConversationRow session={session} agents={agents} ownerId={ownerId} /></button>)}
    </div>}
  </div>
}

/** Autocomplete for #conversation references in the composer. */
export function ConversationPicker({ sessions, agents, ownerId, query, activeIndex, onPick, onHover }: { sessions: readonly Session[]; agents: readonly Agent[]; ownerId?: string; query: string; activeIndex: number; onPick: (session: Session) => void; onHover: (index: number) => void }) {
  const matches = conversationMatches(sessions, agents, query)
  if (!matches.length) return null
  return <div className="mention-picker conversation-picker" role="listbox" aria-label="Reference a side conversation">
    <div className="mention-picker-heading"><Hash size={12} aria-hidden="true" />Side conversations</div>
    {matches.map((session, index) => <button key={session.id} type="button" role="option" aria-selected={index === activeIndex} className={`mention-option side-option ${index === activeIndex ? 'active' : ''}`} onMouseDown={(event) => { event.preventDefault(); onPick(session) }} onMouseEnter={() => onHover(index)}>
      <SideConversationRow session={session} agents={agents} ownerId={ownerId} />
    </button>)}
  </div>
}

export { sideTitle }

export function conversationMatches(sessions: readonly Session[], agents: readonly Agent[], query: string) {
  const needle = query.trim().toLowerCase()
  return sessions.filter((session) => !needle || sideTitle(session, agents).toLowerCase().includes(needle)).slice(0, 6)
}

export function PlanCard({ text, renderText, canApprove, onApprove, onRevise, steps = [], progress = [] }: { text: string; renderText: (text: string) => ReactNode; canApprove: boolean; onApprove: () => void; onRevise: () => void; steps?: readonly string[]; progress?: readonly number[] }) {
  const done = progress.filter(Boolean).length
  // Once the bot has carried out some steps the plan reads as a checklist.
  const checklist = steps.length > 0 && done > 0
  return <article className="plan-card" aria-label="Proposed plan">
    <header><ClipboardList size={15} aria-hidden="true" /><strong>Proposed plan</strong>{checklist && <span className="plan-card-count" aria-label={done + ' of ' + steps.length + ' steps done'}>{done} / {steps.length}</span>}</header>
    {checklist && <i className="plan-card-meter" aria-hidden="true"><b style={{ width: Math.round((done / steps.length) * 100) + '%' }} /></i>}
    {checklist
      ? <ol className="plan-card-steps">{steps.map((step, index) => <li key={index} className={progress[index] ? 'done' : ''}><span className="plan-card-tick" aria-hidden="true">{progress[index] ? <Check size={11} /> : null}</span><span>{step}</span><span className="sr-only">{progress[index] ? ', done' : ', not done yet'}</span></li>)}</ol>
      : <div className="plan-card-body">{renderText(text)}</div>}
    {canApprove && <footer>
      <button type="button" className="secondary-button small" onClick={onRevise}>Keep planning</button>
      <button type="button" className="primary-button small" onClick={onApprove}><Check size={14} aria-hidden="true" />Approve &amp; build</button>
    </footer>}
  </article>
}

/** Inline structured questions: lettered options plus a free-text answer. */
export function QuestionCard({ request, onAnswer, onDismiss }: { request: PermissionRequest; onAnswer: (answers: Record<string, string[]>) => Promise<unknown> | void; onDismiss: () => void }) {
  const questions = (request.questions ?? []).filter((question): question is UserQuestion => !!question && typeof question.question === 'string')
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  useEffect(() => { rootRef.current?.querySelector<HTMLButtonElement>('.question-option')?.focus({ preventScroll: true }) }, [request.id])
  const single = questions.length === 1 && !questions[0].multiSelect
  const submit = async (next: Record<string, string[]>) => {
    if (sending) return
    setSending(true)
    try { await onAnswer(next) } finally { setSending(false) }
  }
  const choose = (question: UserQuestion, label: string) => {
    const current = answers[question.id] ?? []
    const value = question.multiSelect ? (current.includes(label) ? current.filter((item) => item !== label) : [...current, label]) : [label]
    const next = { ...answers, [question.id]: value }
    setAnswers(next)
    if (single) void submit(next)
  }
  const complete = questions.every((question) => (answers[question.id]?.length ?? 0) > 0 || (other[question.id] ?? '').trim())
  const finalAnswers = () => Object.fromEntries(questions.map((question) => [question.id, (other[question.id] ?? '').trim() ? [...(answers[question.id] ?? []), other[question.id].trim()] : answers[question.id] ?? []]))
  return <article ref={rootRef} className="question-card" aria-label={request.title ?? 'Question'} aria-busy={sending || undefined}>
    <button type="button" className="icon-button tiny question-dismiss" aria-label="Dismiss question" disabled={sending} onClick={onDismiss}><X size={14} /></button>
    {questions.map((question) => <fieldset key={question.id} className="question-block" disabled={sending}>
      <legend>{question.question}</legend>
      {question.header && question.header !== question.question && <span className="question-header">{question.header}</span>}
      <div className="question-options" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
        {question.options.map((option, index) => {
          const selected = (answers[question.id] ?? []).includes(option.label)
          return <button key={option.label} type="button" role={question.multiSelect ? 'checkbox' : 'radio'} aria-checked={selected} className={`question-option ${selected ? 'selected' : ''}`} onClick={() => choose(question, option.label)}>
            <kbd>{String.fromCharCode(65 + index)}</kbd>
            <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          </button>
        })}
      </div>
      {question.allowOther !== false && <form className="question-other" onSubmit={(event) => { event.preventDefault(); const text = (other[question.id] ?? '').trim(); if (!text) return; if (single) void submit({ [question.id]: [text] }) }}>
        <input value={other[question.id] ?? ''} placeholder="Type your own answer" aria-label={`Your own answer to: ${question.question}`} onChange={(event) => setOther((current) => ({ ...current, [question.id]: event.target.value }))} />
        {single && <button type="submit" className="icon-button tiny" aria-label="Send answer" disabled={!(other[question.id] ?? '').trim()}><Send size={14} /></button>}
      </form>}
    </fieldset>)}
    {!single && <footer><button type="button" className="primary-button small" disabled={!complete || sending} onClick={() => void submit(finalAnswers())}>Send answers</button></footer>}
  </article>
}

/** Autocomplete for @mentions in the composer. */
export function MentionPicker({ agents, query, activeIndex, onPick, onHover }: { agents: Agent[]; query: string; activeIndex: number; onPick: (agent: Agent) => void; onHover: (index: number) => void }) {
  const matches = useMemo(() => mentionMatches(agents, query), [agents, query])
  const noun = useEntityNoun()
  if (!matches.length) return null
  return <div className="mention-picker" role="listbox" aria-label={`Mention a ${noun}`}>
    {matches.map((agent, index) => <button key={agent.id} type="button" role="option" aria-selected={index === activeIndex} className={`mention-option ${index === activeIndex ? 'active' : ''}`} onMouseDown={(event) => { event.preventDefault(); onPick(agent) }} onMouseEnter={() => onHover(index)}>
      <MiniBlob agent={agent} name={agent.name} size={22} />
      <strong>{agent.name}</strong>
      {agent.role && <span className="role-chip">{agent.role}</span>}
    </button>)}
  </div>
}

export function mentionMatches(agents: Agent[], query: string) {
  const needle = query.trim().toLowerCase()
  return agents.filter((agent) => !agent.archived && (!needle || agent.name.toLowerCase().includes(needle) || (agent.role ?? '').toLowerCase().includes(needle))).slice(0, 6)
}
