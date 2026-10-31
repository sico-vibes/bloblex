// Phase 8: sub-bots, kept in plain sight. Under their parent in the sidebar, as a fleet in the
// conversation that started them, as a count in the companion, and with a box to message each one.
import { useState } from 'react'
import { ArrowUp, ArrowUpRight, Square } from 'lucide-react'
import type { Agent } from '../types'
import { rpc, showMainWindow } from '../tauri'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { providerBrand } from './providerBrand'
import { SUBBOT_WORD, fleetCount, isActiveSubbot, orderFleet, subbotLine, useSubbots, type Subbot } from './subbots'
import './subbots.css'

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : fallback

function Art({ parent, name, status }: { parent?: Agent; name: string; status: Subbot['status'] }) {
  const mood = status === 'running' ? 'tool_activity' : status === 'failed' ? 'error' : 'idle'
  return parent
    ? <BlobCanvas decorative color={agentColorHex(parent.color)} size={16} mini mood={mood} look={agentLook(parent)} label={name} />
    : <span className="subbot-art-fallback" aria-hidden="true">{name.slice(0, 1)}</span>
}

/** Nested under a bot's row in the sidebar. Finished ones stay, so nothing a bot started disappears. */
export function SubbotRows({ parent, onOpen, selectedSessionId }: { parent: Agent; onOpen: (sessionId: string) => void; selectedSessionId?: string | null }) {
  const { subbots } = useSubbots({ agentId: parent.id })
  if (!subbots.length) return null
  return <div className="subbot-rows" role="group" aria-label={`${parent.name}'s sub-bots`}>
    {orderFleet(subbots).map((subbot) => <button type="button" key={subbot.agentId} className={`subbot-row ${subbot.status}`} aria-current={subbot.sessionId && subbot.sessionId === selectedSessionId ? 'true' : undefined} disabled={!subbot.sessionId} title={subbot.model ?? undefined} aria-label={`${subbot.name}, sub-bot of ${parent.name}, ${SUBBOT_WORD[subbot.status]}`} onClick={() => { if (subbot.sessionId) onOpen(subbot.sessionId) }}>
      <Art parent={parent} name={subbot.name} status={subbot.status} />
      <span className="subbot-row-copy"><strong>{subbot.name}</strong><small>{subbotLine(subbot)}</small></span>
    </button>)}
  </div>
}

function FleetRow({ subbot, parent, onOpen, onProblem }: { subbot: Subbot; parent?: Agent; onOpen: (sessionId: string) => void; onProblem: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const stop = async () => {
    if (!subbot.delegationId) return
    setBusy(true)
    try { await rpc('delegation.cancel', { delegationId: subbot.delegationId }) } catch (reason) { onProblem(messageOf(reason, `${subbot.name} could not be stopped.`)) } finally { setBusy(false) }
  }
  const brand = subbot.provider ? providerBrand(subbot.provider).name : null
  return <li className={`fleet-row ${subbot.status}`}>
    <Art parent={parent} name={subbot.name} status={subbot.status} />
    <span className="fleet-row-copy">
      <span className="fleet-row-name"><strong>{subbot.name}</strong>{subbot.model && <small title={brand ?? undefined}>{subbot.model}</small>}</span>
      <small className="fleet-row-line">{subbotLine(subbot)}</small>
    </span>
    {isActiveSubbot(subbot) && subbot.delegationId && <button type="button" className="icon-button" aria-label={`Stop ${subbot.name}`} title="Stop" disabled={busy} onClick={() => void stop()}><Square size={12} aria-hidden="true" /></button>}
    {subbot.sessionId && <button type="button" className="icon-button" aria-label={`Open ${subbot.name}`} title="Open" onClick={() => onOpen(subbot.sessionId!)}><ArrowUpRight size={14} aria-hidden="true" /></button>}
  </li>
}

/** In the conversation that started them: every sub-bot, with its model and state. */
export function SubbotFleet({ sessionId, parent, onOpen }: { sessionId: string; parent?: Agent; onOpen: (sessionId: string) => void }) {
  const { subbots } = useSubbots({ sessionId })
  const [open, setOpen] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  if (!subbots.length) return null
  const active = subbots.filter(isActiveSubbot)
  const count = fleetCount(subbots)
  const stopAll = async () => {
    setStopping(true); setProblem(null)
    try { await rpc('delegation.cancelGroup', { originSessionId: sessionId, delegationIds: active.flatMap((item) => item.delegationId ?? []) }) } catch (reason) { setProblem(messageOf(reason, 'The sub-bots could not be stopped.')) } finally { setStopping(false) }
  }
  return <section className="subbot-fleet" aria-label="Sub-bots in this conversation">
    <header>
      <button type="button" className="fleet-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><strong>Sub-bots</strong><small>{count ?? `${subbots.length} finished`}</small></button>
      {active.length > 1 && <button type="button" className="ghost-button small" disabled={stopping} onClick={() => void stopAll()}>Stop all</button>}
    </header>
    {open && <ul>{orderFleet(subbots).map((subbot) => <FleetRow key={subbot.agentId} subbot={subbot} parent={parent} onOpen={onOpen} onProblem={setProblem} />)}</ul>}
    {problem && <p className="new-project-error" role="alert">{problem}</p>}
  </section>
}

/** A sub-bot's own conversation takes messages, like any other. */
export function SubbotComposer({ sessionId, name, onClose }: { sessionId: string; name: string; onClose: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const send = async () => {
    const message = text.trim()
    if (!message) return
    setBusy(true); setProblem(null)
    try { await rpc('session.prompt', { sessionId, text: message }); setText('') } catch (reason) { setProblem(messageOf(reason, 'That message could not be sent.')) } finally { setBusy(false) }
  }
  return <form className="subbot-composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
    <textarea className="text-input" rows={2} value={text} aria-label={`Message ${name}`} placeholder={`Message ${name}`} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} />
    <div className="subbot-composer-actions">
      {problem && <span className="new-project-error" role="alert">{problem}</span>}
      <button type="button" className="secondary-button small" onClick={onClose}>Back</button>
      <button type="submit" className="primary-button small" disabled={busy || !text.trim()}><ArrowUp size={13} aria-hidden="true" />Send</button>
    </div>
  </form>
}

/** The companion's rail: a bot's working count. */
export function SubbotCount({ agentId }: { agentId: string }) {
  const { subbots } = useSubbots({ agentId })
  const count = fleetCount(subbots)
  return count ? <small className="subbot-count" title={`Sub-bots: ${count}`}>{count.split(' ')[0]}</small> : null
}

/** The companion: the fleet at a glance, opening it in the full app. */
export function CompanionFleetChip({ agent, sessionId }: { agent: Pick<Agent, 'id' | 'name'>; sessionId?: string | null }) {
  const { subbots } = useSubbots({ agentId: agent.id })
  const count = fleetCount(subbots)
  if (!count) return null
  return <div className="chip settled companion-fleet" role="status"><button type="button" onClick={() => void showMainWindow(sessionId ?? subbots[0]?.originSessionId ?? null).catch(() => undefined)}>{agent.name} · {count}</button></div>
}
