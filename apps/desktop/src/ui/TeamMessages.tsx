// Team surfaces inside a conversation: delegation chips, relayed replies,
// side-conversation header, proposed plans, inline questions and @mentions.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeftRight, Check, ClipboardList, Send, X } from 'lucide-react'
import type { Agent, PermissionRequest, UserQuestion } from '../types'
import { agentLook } from '../blob/look'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentColorHex } from './agentColor'

function MiniBlob({ agent, name, size = 18 }: { agent: Agent | null | undefined; name: string; size?: number }) {
  return agent
    ? <BlobCanvas decorative color={agentColorHex(agent.color)} size={size} mood="idle" look={agentLook(agent)} label={name} />
    : <span className="team-chip-dot" aria-hidden="true">{name.slice(0, 1)}</span>
}

const accentOf = (agent: Agent | null | undefined) => agent ? { ['--chip-accent' as string]: agentColorHex(agent.color) } : undefined

/** "Messaged Codex" in the sender's conversation; opens the side conversation. */
export function DelegationChip({ peer, name, failed, detail, onOpen }: { peer: Agent | null | undefined; name: string; failed?: boolean; detail?: string; onOpen?: () => void }) {
  return <div className="team-chip-row">
    <button type="button" className={`team-chip ${failed ? 'failed' : ''}`} style={accentOf(peer)} disabled={!onOpen} onClick={onOpen} aria-label={failed ? `${name} could not start${detail ? `: ${detail}` : ''}` : `Messaged ${name}. Open side conversation`} title={detail ?? (onOpen ? 'Open the side conversation' : undefined)}>
      <span>{failed ? 'Could not reach' : 'Messaged'}</span><MiniBlob agent={peer} name={name} /><b>{name}</b>
    </button>
  </div>
}

/** A relayed reply ("Message from Codex"); opens the side conversation where it was written. */
export function ReplyChip({ from, name, onOpen }: { from: Agent | null | undefined; name: string; onOpen?: () => void }) {
  return <div className="team-chip-row">
    <button type="button" className="team-chip incoming" style={accentOf(from)} onClick={onOpen} disabled={!onOpen} aria-label={`Message from ${name}. Open side conversation`} title={onOpen ? 'Open the side conversation' : undefined}>
      <span>Message from</span><MiniBlob agent={from} name={name} /><b>{name}</b>
    </button>
  </div>
}

/** Header for a side conversation between two blobs. */
export function SideConversationHeader({ peer, peerName, target, targetName }: { peer: Agent | null | undefined; peerName: string; target: Agent | null | undefined; targetName: string }) {
  return <div className="side-header" aria-label={`Side conversation between ${peerName} and ${targetName}`}>
    <span className="side-header-pill"><MiniBlob agent={peer} name={peerName} size={20} /><b>{peerName}</b><ArrowLeftRight size={13} aria-hidden="true" /><MiniBlob agent={target} name={targetName} size={20} /><b>{targetName}</b></span>
  </div>
}

export function PlanCard({ text, renderText, canApprove, onApprove, onRevise }: { text: string; renderText: (text: string) => ReactNode; canApprove: boolean; onApprove: () => void; onRevise: () => void }) {
  return <article className="plan-card" aria-label="Proposed plan">
    <header><ClipboardList size={15} aria-hidden="true" /><strong>Proposed plan</strong></header>
    <div className="plan-card-body">{renderText(text)}</div>
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
  if (!matches.length) return null
  return <div className="mention-picker" role="listbox" aria-label="Mention a blob">
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
