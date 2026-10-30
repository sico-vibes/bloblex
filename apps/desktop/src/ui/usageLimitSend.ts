// Phase 1B: a message written while a conversation waits for its usage limit
// goes out when the limit resets. The daemon owns the timer (`whenLimitResets`).
import type { Session } from '../types'

/** When the conversation's usage limit resets, or null when it isn't waiting for one. */
export function limitWaitingUntil(session: Pick<Session, 'limitedUntil'> | null | undefined, nowMs = Date.now()): string | null {
  const at = typeof session?.limitedUntil === 'string' ? session.limitedUntil : null
  if (!at) return null
  const time = Date.parse(at)
  return Number.isFinite(time) && time > nowMs ? at : null
}

/** "2:00 AM" today, or "Oct 31, 2:00 AM" on another day. */
export function limitResetTime(at: string, nowMs = Date.now()): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return date.toDateString() === new Date(nowMs).toDateString() ? time : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}
