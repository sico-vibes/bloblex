import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Agent, Runtime, Session } from '../types'
import { blobState } from './CompanionTeam'
import { StatusDot } from './StatusDot'
import { useEntityNoun } from './vocabulary'
import './companionAttention.css'

/** Bots that are waiting for the person, in the order the sidebar lists them. */
export function waitingAgentsOf(agents: readonly Agent[], sessions: readonly Session[], runtimes: readonly Runtime[], connected: boolean): Agent[] {
  return agents.filter((agent) => !agent.archived && agent.hidden !== true && blobState(agent, sessions, runtimes, connected) === 'waiting')
}

/** The waiting bot after `focusedId`, wrapping around; the first one when the focused bot is not waiting. */
export function nextWaitingAgent(waiting: readonly Agent[], focusedId: string | null | undefined): Agent | null {
  if (!waiting.length) return null
  const at = waiting.findIndex((agent) => agent.id === focusedId)
  return waiting[(at + 1) % waiting.length] ?? waiting[0] ?? null
}

/**
 * "2 need you": one pill that says how many bots are waiting and, on click,
 * jumps to the next one. It shows nothing at zero so a quiet companion stays quiet.
 */
export function NeedsYouBadge({ count, onOpen, compact = false }: { count: number; onOpen: () => void; compact?: boolean }) {
  const noun = useEntityNoun({ plural: count !== 1 })
  if (count <= 0) return null
  const text = count === 1 ? '1 needs you' : `${count} need you`
  return <button type="button" className={`needs-you ${compact ? 'compact' : ''}`} data-companion-no-drag="" onClick={(event) => { event.stopPropagation(); onOpen() }}
    aria-label={`${count} ${noun} ${count === 1 ? 'needs' : 'need'} you. Open ${count === 1 ? 'it' : 'the next one'}`}>
    <StatusDot status="waiting" />
    <span>{text}</span>
  </button>
}

/**
 * Above an approval: where it sits in the queue, previous and next, and
 * "Later", which sets this one aside for five minutes instead of blocking
 * the companion.
 */
export function PermissionQueueBar({ index, total, onPrev, onNext, onLater }: { index: number; total: number; onPrev: () => void; onNext: () => void; onLater: () => void }) {
  return <div className="queue-bar" role="group" aria-label="Approval requests">
    {total > 1 && <>
      <button type="button" className="queue-step" aria-label="Previous request" onClick={onPrev}><ChevronLeft size={13} /></button>
      <span className="queue-count" aria-live="polite">{index + 1} of {total}</span>
      <button type="button" className="queue-step" aria-label="Next request" onClick={onNext}><ChevronRight size={13} /></button>
    </>}
    <button type="button" className="queue-later" onClick={onLater} title="Hide this request for five minutes">Later</button>
  </div>
}
